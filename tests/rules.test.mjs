// Firestore security-rules tests. Needs the Firebase emulator, so it is NOT part of `npm test`.
//
//   npm i --no-save firebase-tools @firebase/rules-unit-testing firebase
//   npx firebase emulators:exec --only firestore --project demo-phone "node --test tests/rules.test.mjs"
import { test, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, collection, serverTimestamp, query, orderBy, limit, where } from "firebase/firestore";

const rules = fs.readFileSync(process.env.RULES_PATH || new URL("../firestore.rules", import.meta.url), "utf8");
let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({ projectId: "demo-phone", firestore: { rules, host, port: +port } });
});
after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "admins", "A1"), { email: "a1@x.org", name: "Admin One", active: true });
    await setDoc(doc(db, "admins", "A2"), { email: "a2@x.org", name: "Admin Two", active: true });
    await setDoc(doc(db, "admins", "A3"), { email: "a3@x.org", name: "Gone", active: false });
    await setDoc(doc(db, "stations", "S1"), { email: "s1@x.org", name: "Desk", active: true });
    await setDoc(doc(db, "staff", "1001"), { name: "Jane Doe", active: true });
    await setDoc(doc(db, "assets", "PH-001"), {
      category: "Phone", model: "iPhone", imei: "", serial: "", phoneNumber: "", status: "in",
      currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: null, active: true,
    });
  });
});

const dbOf = (uid) => env.authenticatedContext(uid).firestore();
const audit = (uid, targetType, targetId) => ({
  adminUid: uid, adminEmail: "x", adminName: "x", action: "t", targetType, targetId,
  summary: "", before: null, after: null, batchId: null, ts: serverTimestamp(),
});
const logDoc = (extra = {}) => ({ type: "out", assetId: "PH-001", employeeId: "1001", employeeName: "Jane Doe", heldMinutes: null, source: "scan", ts: serverTimestamp(), ...extra });
const checkoutBatch = (db) => {
  const b = writeBatch(db);
  const l = doc(collection(db, "logs"));
  b.update(doc(db, "assets", "PH-001"), { status: "out", currentHolderId: "1001", currentHolderName: "Jane Doe", checkedOutAt: serverTimestamp(), lastLogId: l.id });
  b.set(l, logDoc());
  return b;
};
const newAsset = { category: "Phone", model: "Pixel", imei: "", serial: "", phoneNumber: "", status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: null, active: true };

// ───────── who gets in at all ─────────
test("signed-out and un-listed logins can read nothing", async () => {
  for (const db of [env.unauthenticatedContext().firestore(), dbOf("STRANGER")]) {
    await assertFails(getDoc(doc(db, "assets", "PH-001")));
    await assertFails(getDoc(doc(db, "staff", "1001")));
    await assertFails(getDocs(collection(db, "logs")));
    await assertFails(getDocs(collection(db, "auditLog")));
  }
});
test("a stranger can't make themselves an admin or station", async () => {
  const db = dbOf("STRANGER");
  await assertFails(setDoc(doc(db, "admins", "STRANGER"), { email: "x", name: "x", active: true }));
  await assertFails(setDoc(doc(db, "stations", "STRANGER"), { email: "x", name: "x", active: true }));
});
test("a deactivated admin has no access", async () => {
  await assertFails(getDoc(doc(dbOf("A3"), "assets", "PH-001")));
});

// ───────── station (scan-only) ─────────
test("station can read, and can check a phone out with its log entry", async () => {
  const db = dbOf("S1");
  await assertSucceeds(getDoc(doc(db, "assets", "PH-001")));
  await assertSucceeds(getDoc(doc(db, "staff", "1001")));
  await assertSucceeds(getDocs(query(collection(db, "logs"), orderBy("ts", "desc"), limit(8))));
  await assertSucceeds(checkoutBatch(db).commit());
});
test("station check-out works inside a transaction, as the app does it", async () => {
  const db = dbOf("S1");
  await assertSucceeds(runTransaction(db, async (tx) => {
    const ref = doc(db, "assets", "PH-001");
    await tx.get(ref);
    const l = doc(collection(db, "logs"));
    tx.update(ref, { status: "out", currentHolderId: "1001", currentHolderName: "Jane Doe", checkedOutAt: serverTimestamp(), lastLogId: l.id });
    tx.set(l, logDoc());
  }));
});
test("station can't flip a phone without writing a log", async () => {
  const db = dbOf("S1");
  await assertFails(updateDoc(doc(db, "assets", "PH-001"), { status: "out", currentHolderId: "1001", currentHolderName: "Jane Doe", checkedOutAt: serverTimestamp(), lastLogId: "nope" }));
});
test("station can't point the phone's log at a different phone", async () => {
  const db = dbOf("S1");
  const b = writeBatch(db);
  const l = doc(collection(db, "logs"));
  b.update(doc(db, "assets", "PH-001"), { status: "out", currentHolderId: "1001", currentHolderName: "Jane Doe", checkedOutAt: serverTimestamp(), lastLogId: l.id });
  b.set(l, logDoc({ assetId: "PH-999" }));
  await assertFails(b.commit());
});
test("station can't edit device details (type, model…), create/modify staff or assets, or delete", async () => {
  const db = dbOf("S1");
  await assertFails(updateDoc(doc(db, "assets", "PH-001"), { model: "Hacked" }));
  await assertFails(updateDoc(doc(db, "assets", "PH-001"), { category: "iPad" }));
  await assertFails(updateDoc(doc(db, "assets", "PH-001"), { active: false }));
  await assertFails(setDoc(doc(db, "staff", "9999"), { name: "Fake", active: true }));
  await assertFails(setDoc(doc(db, "assets", "PH-777"), newAsset));
  await assertFails(deleteDoc(doc(db, "assets", "PH-001")));
});
test("logs are immutable and need a real server timestamp", async () => {
  const db = dbOf("S1");
  const ref = doc(collection(db, "logs"));
  await assertFails(setDoc(ref, logDoc({ ts: new Date("2020-01-01") })));
  await assertSucceeds(setDoc(ref, logDoc()));
  await assertFails(updateDoc(ref, { employeeName: "Someone Else" }));
  await assertFails(deleteDoc(ref));
});
test("station can't read the changelog", async () => {
  await assertFails(getDocs(collection(dbOf("S1"), "auditLog")));
});

// ───────── admins: no footprint, no change ─────────
test("admin can add an asset only with a matching changelog entry in the same batch", async () => {
  const db = dbOf("A1");
  // with footprint
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit("A1", "asset", "PH-002"));
  b.set(doc(db, "assets", "PH-002"), { ...newAsset, auditId: a.id });
  await assertSucceeds(b.commit());
  // no footprint
  await assertFails(setDoc(doc(db, "assets", "PH-003"), newAsset));
  // footprint for a different record
  const b2 = writeBatch(db);
  const a2 = doc(collection(db, "auditLog"));
  b2.set(a2, audit("A1", "asset", "PH-OTHER"));
  b2.set(doc(db, "assets", "PH-004"), { ...newAsset, auditId: a2.id });
  await assertFails(b2.commit());
  // footprint signed by a different admin
  const b3 = writeBatch(db);
  const a3 = doc(collection(db, "auditLog"));
  b3.set(a3, audit("A2", "asset", "PH-005"));
  b3.set(doc(db, "assets", "PH-005"), { ...newAsset, auditId: a3.id });
  await assertFails(b3.commit());
  // footprint of the wrong record type
  const b4 = writeBatch(db);
  const a4 = doc(collection(db, "auditLog"));
  b4.set(a4, audit("A1", "staff", "PH-006"));
  b4.set(doc(db, "assets", "PH-006"), { ...newAsset, auditId: a4.id });
  await assertFails(b4.commit());
});
test("a batch of several audited records succeeds (bulk import chunk)", async () => {
  const db = dbOf("A1");
  const b = writeBatch(db);
  for (let i = 10; i < 16; i++) {
    const a = doc(collection(db, "auditLog"));
    b.set(a, audit("A1", "asset", `PH-0${i}`));
    b.set(doc(db, "assets", `PH-0${i}`), { ...newAsset, auditId: a.id });
  }
  await assertSucceeds(b.commit());
});
test("admin edits and staff changes need footprints too", async () => {
  const db = dbOf("A1");
  await assertFails(updateDoc(doc(db, "assets", "PH-001"), { model: "New" }));
  await assertFails(updateDoc(doc(db, "staff", "1001"), { name: "Renamed" }));
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit("A1", "staff", "1001"));
  b.update(doc(db, "staff", "1001"), { name: "Jane Q. Doe", auditId: a.id });
  await assertSucceeds(b.commit());
});
test("nothing can be hard-deleted, and the changelog can't be edited", async () => {
  const db = dbOf("A1");
  await assertFails(deleteDoc(doc(db, "assets", "PH-001")));
  await assertFails(deleteDoc(doc(db, "staff", "1001")));
  await assertFails(deleteDoc(doc(db, "admins", "A2")));
  const ref = doc(collection(db, "auditLog"));
  await assertSucceeds(setDoc(ref, audit("A1", "session", "A1")));
  await assertFails(updateDoc(ref, { summary: "edited" }));
  await assertFails(deleteDoc(ref));
  await assertFails(setDoc(doc(collection(db, "auditLog")), { ...audit("A2", "session", "A1") })); // can't forge another admin's entry
  await assertSucceeds(getDocs(collection(db, "auditLog")));
});
test("force return: asset update + log + changelog in one batch", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), "assets", "PH-001"), { status: "out", currentHolderId: "1001", currentHolderName: "Jane Doe", lastLogId: "x" });
  });
  const db = dbOf("A1");
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  const l = doc(collection(db, "logs"));
  b.set(a, audit("A1", "asset", "PH-001"));
  b.update(doc(db, "assets", "PH-001"), { status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: l.id, auditId: a.id });
  b.set(l, logDoc({ type: "in", source: "admin", heldMinutes: 30 }));
  await assertSucceeds(b.commit());
});
test("an admin can also use the scan station path", async () => {
  await assertSucceeds(checkoutBatch(dbOf("A1")).commit());
});

// ───────── managing admins ─────────
test("admin can add another admin (audited) but can't deactivate themselves", async () => {
  const db = dbOf("A1");
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit("A1", "admin", "NEW1"));
  b.set(doc(db, "admins", "NEW1"), { email: "n@x.org", name: "New", active: true, auditId: a.id });
  await assertSucceeds(b.commit());

  const self = writeBatch(db);
  const sa = doc(collection(db, "auditLog"));
  self.set(sa, audit("A1", "admin", "A1"));
  self.update(doc(db, "admins", "A1"), { active: false, auditId: sa.id });
  await assertFails(self.commit());

  const other = writeBatch(db);
  const oa = doc(collection(db, "auditLog"));
  other.set(oa, audit("A1", "admin", "A2"));
  other.update(doc(db, "admins", "A2"), { active: false, auditId: oa.id });
  await assertSucceeds(other.commit());
  await assertFails(getDoc(doc(dbOf("A2"), "assets", "PH-001"))); // A2 is now locked out
});
test("a station login can't touch admins, stations or the changelog", async () => {
  const db = dbOf("S1");
  await assertFails(getDocs(collection(db, "admins")));
  await assertFails(updateDoc(doc(db, "admins", "A1"), { active: false }));
  await assertFails(setDoc(doc(db, "stations", "S2"), { email: "x", name: "x", active: true }));
  await assertSucceeds(getDoc(doc(db, "stations", "S1"))); // may read its own record
});

// ───────── takeover, alerts (incidents) ─────────
const putOut = (holderId = "1001", holderName = "Jane Doe") =>
  env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), "assets", "PH-001"), { status: "out", currentHolderId: holderId, currentHolderName: holderName, lastLogId: "x" });
    await setDoc(doc(ctx.firestore(), "staff", "1002"), { name: "Bob Ray", active: true });
  });

const takeoverTx = (db, { incident = {} } = {}) =>
  runTransaction(db, async (tx) => {
    const ref = doc(db, "assets", "PH-001");
    await tx.get(ref);
    const missed = doc(collection(db, "logs"));
    const out = doc(collection(db, "logs"));
    const inc = doc(collection(db, "incidents"));
    tx.set(missed, logDoc({ type: "missed", employeeId: "1001", employeeName: "Jane Doe", heldMinutes: 900, incidentId: inc.id }));
    tx.set(inc, { status: "open", assetId: "PH-001", missedById: "1001", missedByName: "Jane Doe", takenOverById: "1002", takenOverByName: "Bob Ray", heldMinutes: 900, ts: serverTimestamp(), ...incident });
    tx.update(ref, { status: "out", currentHolderId: "1002", currentHolderName: "Bob Ray", checkedOutAt: serverTimestamp(), lastLogId: out.id });
    tx.set(out, logDoc({ employeeId: "1002", employeeName: "Bob Ray", takeoverFromId: "1001", takeoverFromName: "Jane Doe", incidentId: inc.id }));
  });

test("station can take over a device that was never returned (missed log + out log + incident)", async () => {
  await putOut();
  await assertSucceeds(takeoverTx(dbOf("S1")));
});
test("station can't raise an incident that is already 'resolved' or has no asset", async () => {
  await putOut();
  await assertFails(takeoverTx(dbOf("S1"), { incident: { status: "resolved" } }));
  await assertFails(takeoverTx(dbOf("S1"), { incident: { assetId: 5 } }));
});
test("station can't change only lastLogId, or write an unknown log type", async () => {
  const db = dbOf("S1");
  const b = writeBatch(db);
  const l = doc(collection(db, "logs"));
  b.update(doc(db, "assets", "PH-001"), { lastLogId: l.id });
  b.set(l, logDoc());
  await assertFails(b.commit());
  await assertFails(setDoc(doc(collection(db, "logs")), logDoc({ type: "bogus" })));
});
test("only admins read incidents; station can't read or resolve them", async () => {
  await putOut();
  await assertSucceeds(takeoverTx(dbOf("S1")));
  await assertFails(getDocs(collection(dbOf("S1"), "incidents")));
  const snap = await assertSucceeds(getDocs(collection(dbOf("A1"), "incidents")));
  const id = snap.docs[0].id;
  await assertFails(updateDoc(doc(dbOf("S1"), "incidents", id), { status: "resolved" }));
  await assertFails(updateDoc(doc(dbOf("A1"), "incidents", id), { status: "resolved" })); // admin without a footprint

  const db = dbOf("A1");
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit("A1", "incident", id));
  b.update(doc(db, "incidents", id), { status: "resolved", resolution: "Employee forgot to scan the return", auditId: a.id });
  await assertSucceeds(b.commit());
  await assertFails(deleteDoc(doc(db, "incidents", id)));
});

// ───────── asset types & label templates ─────────
const auditedSet = (db, col, targetType, id, data) => {
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit("A1", targetType, id));
  b.set(doc(db, col, id), { ...data, auditId: a.id });
  return b;
};
test("asset types: audited admin writes only; station can't read or write; no deletes", async () => {
  const db = dbOf("A1");
  await assertSucceeds(auditedSet(db, "assetTypes", "assetType", "ipad", { name: "iPad", prefix: "IP-", active: true }).commit());
  await assertFails(setDoc(doc(db, "assetTypes", "watch"), { name: "Watch", prefix: "WA-", active: true })); // no footprint
  await assertSucceeds(getDocs(collection(db, "assetTypes")));
  await assertFails(getDocs(collection(dbOf("S1"), "assetTypes")));
  await assertFails(setDoc(doc(dbOf("S1"), "assetTypes", "x"), { name: "X" }));
  await assertFails(deleteDoc(doc(db, "assetTypes", "ipad")));
});
test("label templates: audited admin writes only; station can't read or write; no deletes", async () => {
  const db = dbOf("A1");
  const tpl = { name: "Phone + number", kind: "asset", active: true, config: { size: "2x1", lines: [{ field: "phoneNumber", text: "Phone: ", size: "md", bold: false }] } };
  await assertSucceeds(auditedSet(db, "labelTemplates", "labelTemplate", "asset-phone-number", tpl).commit());
  await assertFails(setDoc(doc(db, "labelTemplates", "asset-nofootprint"), tpl));
  await assertFails(auditedSet(db, "labelTemplates", "asset", "asset-wrongtype", tpl).commit()); // footprint for wrong record type
  await assertFails(getDocs(collection(dbOf("S1"), "labelTemplates")));
  await assertFails(setDoc(doc(dbOf("S1"), "labelTemplates", "x"), tpl));
  await assertFails(deleteDoc(doc(db, "labelTemplates", "asset-phone-number")));
});
test("admin can add an asset together with a brand-new asset type in one batch (inline “New type…”)", async () => {
  const db = dbOf("A1");
  const b = writeBatch(db);
  const t = doc(collection(db, "auditLog"));
  const a = doc(collection(db, "auditLog"));
  b.set(t, audit("A1", "assetType", "ipad"));
  b.set(doc(db, "assetTypes", "ipad"), { name: "iPad", prefix: "IP-", active: true, auditId: t.id });
  b.set(a, audit("A1", "asset", "IP-001"));
  b.set(doc(db, "assets", "IP-001"), { ...newAsset, category: "iPad", model: "iPad 10th gen", auditId: a.id });
  await assertSucceeds(b.commit());
});

// ───────── PINs, settings, problem reports, inventory counts ─────────
const pinFields = (extra = {}) => ({ pinHash: "a".repeat(64), pinSalt: "b".repeat(32), pinSetAt: serverTimestamp(), ...extra });

test("station can set a PIN once (first use) and nothing else on the staff record", async () => {
  const db = dbOf("S1");
  await assertSucceeds(updateDoc(doc(db, "staff", "1001"), pinFields()));
  await assertFails(updateDoc(doc(db, "staff", "1001"), pinFields({ pinHash: "c".repeat(64) }))); // can't overwrite an existing PIN
});
test("station PIN write is strictly shaped", async () => {
  const db = dbOf("S1");
  await assertFails(updateDoc(doc(db, "staff", "1001"), { ...pinFields(), name: "Hacked" }));
  await assertFails(updateDoc(doc(db, "staff", "1001"), { ...pinFields(), pinRequired: false }));
  await assertFails(updateDoc(doc(db, "staff", "1001"), pinFields({ pinHash: "short" })));
  await assertFails(updateDoc(doc(db, "staff", "1001"), pinFields({ pinSalt: "tiny" })));
  await assertFails(updateDoc(doc(db, "staff", "1001"), pinFields({ pinSetAt: new Date("2020-01-01") })));
  await assertFails(updateDoc(doc(db, "staff", "1001"), { pinHash: "a".repeat(64) })); // all three fields or none
});
test("admin PIN reset needs a footprint and clears the PIN so it can be set again", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), "staff", "1001"), { pinHash: "a".repeat(64), pinSalt: "b".repeat(32) }); });
  const db = dbOf("A1");
  await assertFails(updateDoc(doc(db, "staff", "1001"), { pinHash: null, pinSalt: null, pinSetAt: null }));
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit("A1", "staff", "1001"));
  b.update(doc(db, "staff", "1001"), { pinHash: null, pinSalt: null, pinSetAt: null, pinRequired: true, auditId: a.id });
  await assertSucceeds(b.commit());
  await assertSucceeds(updateDoc(doc(dbOf("S1"), "staff", "1001"), pinFields()));
});
test("station can't set a PIN on a removed person", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "staff", "1009"), { name: "Gone", active: false }); });
  await assertFails(updateDoc(doc(dbOf("S1"), "staff", "1009"), pinFields()));
});

test("settings: stations read, only admins write (audited)", async () => {
  const a1 = dbOf("A1");
  await assertSucceeds(auditedSet(a1, "settings", "settings", "app", { pinMode: "selected", shiftTimes: ["07:00"] }).commit());
  await assertFails(setDoc(doc(a1, "settings", "other"), { pinMode: "all" })); // no footprint
  await assertSucceeds(getDoc(doc(dbOf("S1"), "settings", "app")));
  await assertFails(setDoc(doc(dbOf("S1"), "settings", "app"), { pinMode: "off" }));
  await assertFails(getDoc(doc(dbOf("STRANGER"), "settings", "app")));
  await assertFails(deleteDoc(doc(a1, "settings", "app")));
});

const issueDoc = (extra = {}) => ({ status: "open", assetId: "PH-001", problem: "Cracked or damaged screen", note: "", reportedById: "1001", reportedByName: "Jane Doe", ts: serverTimestamp(), ...extra });
test("problem reports: station can raise one, can't read or resolve; admin resolves with a footprint", async () => {
  const s1 = dbOf("S1");
  const ref = doc(collection(s1, "issues"));
  await assertSucceeds(setDoc(ref, issueDoc()));
  await assertFails(setDoc(doc(collection(s1, "issues")), issueDoc({ status: "resolved" })));
  await assertFails(setDoc(doc(collection(s1, "issues")), issueDoc({ ts: new Date("2020-01-01") })));
  await assertFails(setDoc(doc(collection(s1, "issues")), issueDoc({ assetId: 5 })));
  await assertFails(setDoc(doc(collection(s1, "issues")), issueDoc({ reportedById: null })));
  await assertFails(getDoc(ref));
  await assertFails(updateDoc(ref, { status: "resolved" }));
  const a1 = dbOf("A1");
  await assertSucceeds(getDoc(doc(a1, "issues", ref.id)));
  await assertFails(updateDoc(doc(a1, "issues", ref.id), { status: "resolved" })); // no footprint
  const b = writeBatch(a1);
  const au = doc(collection(a1, "auditLog"));
  b.set(au, audit("A1", "issue", ref.id));
  b.update(doc(a1, "issues", ref.id), { status: "resolved", resolution: "Fixed or cleaned", auditId: au.id });
  await assertSucceeds(b.commit());
  await assertFails(deleteDoc(doc(a1, "issues", ref.id)));
});

test("taking a device out of service while it is checked out: asset + admin log + footprint in one batch", async () => {
  await putOut();
  const db = dbOf("A1");
  const b = writeBatch(db);
  const au = doc(collection(db, "auditLog"));
  const l = doc(collection(db, "logs"));
  b.set(au, audit("A1", "asset", "PH-001"));
  b.update(doc(db, "assets", "PH-001"), {
    active: false, retireReason: "lost", retireNote: "last seen ED", retiredAt: serverTimestamp(),
    status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: l.id, auditId: au.id,
  });
  b.set(l, logDoc({ type: "in", source: "admin", note: "Marked lost" }));
  await assertSucceeds(b.commit());
  // a station can no longer touch it
  await assertFails(checkoutBatch(dbOf("S1")).commit());
});

test("inventory counts: audited admin create only; never edited or deleted; stations can't read", async () => {
  const db = dbOf("A1");
  const data = { scope: "Phone", expected: ["PH-001"], found: [], missing: ["PH-001"], unknown: [], adminName: "Admin One", ts: serverTimestamp() };
  await assertSucceeds(auditedSet(db, "counts", "count", "c1", data).commit());
  await assertFails(setDoc(doc(db, "counts", "c2"), data)); // no footprint
  await assertFails(updateDoc(doc(db, "counts", "c1"), { missing: [] }));
  await assertFails(deleteDoc(doc(db, "counts", "c1")));
  await assertSucceeds(getDocs(collection(db, "counts")));
  await assertFails(getDocs(collection(dbOf("S1"), "counts")));
  await assertFails(setDoc(doc(dbOf("S1"), "counts", "c3"), data));
});

// ───────── badge numbers / how someone identified themselves ─────────
test("logs may record idMethod badge, eid or none; nothing else", async () => {
  const db = dbOf("S1");
  for (const m of ["badge", "eid", null]) {
    const l = doc(collection(db, "logs"));
    await assertSucceeds(setDoc(l, logDoc({ type: "in", idMethod: m })));
  }
  await assertSucceeds(setDoc(doc(collection(db, "logs")), logDoc({ type: "in" }))); // older clients omit it
  await assertFails(setDoc(doc(collection(db, "logs")), logDoc({ type: "in", idMethod: "face" })));
});

test("a station can look a person up by badge number; only admins can set it", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), "staff", "1001"), { badgeId: "10010077" }); });
  const s = dbOf("S1");
  const q = await assertSucceeds(getDocs(query(collection(s, "staff"), where("badgeId", "==", "10010077"), limit(1))));
  assert.equal(q.size, 1);
  await assertFails(updateDoc(doc(s, "staff", "1001"), { badgeId: "999" }));
  const a = dbOf("A1");
  const b = writeBatch(a);
  const au = doc(collection(a, "auditLog"));
  b.set(au, audit("A1", "staff", "1001"));
  b.update(doc(a, "staff", "1001"), { badgeId: "10010078", auditId: au.id });
  await assertSucceeds(b.commit());
});

test("damage reports carry the reporter and free text", async () => {
  const s = dbOf("S1");
  await assertSucceeds(setDoc(doc(collection(s, "issues")), {
    status: "open", assetId: "PH-001", problem: "Screen cracked in the corner", note: "", reportedById: "1001", reportedByName: "Jane Doe", reportedByMethod: "badge", returned: true, ts: serverTimestamp(),
  }));
});

// ───────── admins who are also staff ─────────
const linkAdmin = (uid, employeeId) =>
  env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "admins", uid), { employeeId }));
const auditedBatch = (db, uid, targetType, targetId, fn) => {
  const b = writeBatch(db);
  const a = doc(collection(db, "auditLog"));
  b.set(a, audit(uid, targetType, targetId));
  fn(b, a.id);
  return b;
};

test("an admin can link themselves to a staff record once, and change nothing else on their own entry", async () => {
  const db = dbOf("A1");
  await assertSucceeds(auditedBatch(db, "A1", "admin", "A1", (b, id) => b.update(doc(db, "admins", "A1"), { employeeId: "1001", updatedAt: serverTimestamp(), auditId: id })).commit());
  // already linked: can't re-point it, rename, or deactivate
  await assertFails(auditedBatch(db, "A1", "admin", "A1", (b, id) => b.update(doc(db, "admins", "A1"), { employeeId: "9999", updatedAt: serverTimestamp(), auditId: id })).commit());
  await assertFails(auditedBatch(db, "A1", "admin", "A1", (b, id) => b.update(doc(db, "admins", "A1"), { name: "Boss", updatedAt: serverTimestamp(), auditId: id })).commit());
});

test("an unlinked admin can't use the link step to change other fields", async () => {
  const db = dbOf("A1");
  await assertFails(auditedBatch(db, "A1", "admin", "A1", (b, id) => b.update(doc(db, "admins", "A1"), { employeeId: "1001", name: "Boss", auditId: id })).commit());
});

test("an admin can create their own staff record, then can't edit or remove it", async () => {
  await linkAdmin("A1", "7001");
  const db = dbOf("A1");
  await assertSucceeds(auditedBatch(db, "A1", "staff", "7001", (b, id) => b.set(doc(db, "staff", "7001"), { name: "Admin One", badgeId: "", active: true, auditId: id })).commit());
  await assertFails(auditedBatch(db, "A1", "staff", "7001", (b, id) => b.update(doc(db, "staff", "7001"), { active: false, auditId: id })).commit());
  await assertFails(auditedBatch(db, "A1", "staff", "7001", (b, id) => b.update(doc(db, "staff", "7001"), { badgeId: "123", auditId: id })).commit());
  await assertFails(auditedBatch(db, "A1", "staff", "7001", (b, id) => b.update(doc(db, "staff", "7001"), { pinHash: null, pinSalt: null, pinSetAt: null, auditId: id })).commit());
});

test("another admin can still edit that admin's staff record and admin entry", async () => {
  await linkAdmin("A1", "7001");
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "staff", "7001"), { name: "Admin One", active: true }));
  const db = dbOf("A2");
  await assertSucceeds(auditedBatch(db, "A2", "staff", "7001", (b, id) => b.update(doc(db, "staff", "7001"), { badgeId: "70010077", auditId: id })).commit());
  await assertSucceeds(auditedBatch(db, "A2", "admin", "A1", (b, id) => b.update(doc(db, "admins", "A1"), { name: "Renamed", auditId: id })).commit());
});

test("an admin can still edit other staff", async () => {
  await linkAdmin("A1", "7001");
  const db = dbOf("A1");
  await assertSucceeds(auditedBatch(db, "A1", "staff", "1001", (b, id) => b.update(doc(db, "staff", "1001"), { name: "Jane Q Doe", auditId: id })).commit());
});

test("an admin can check a device out and in at the station, but can't force-return or edit a device they hold", async () => {
  await linkAdmin("A1", "7001");
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "staff", "7001"), { name: "Admin One", active: true }));
  const db = dbOf("A1");
  const out = writeBatch(db);
  const l = doc(collection(db, "logs"));
  out.update(doc(db, "assets", "PH-001"), { status: "out", currentHolderId: "7001", currentHolderName: "Admin One", checkedOutAt: serverTimestamp(), lastLogId: l.id });
  out.set(l, logDoc({ employeeId: "7001", employeeName: "Admin One" }));
  await assertSucceeds(out.commit());
  // force return of their own device is refused…
  await assertFails(auditedBatch(db, "A1", "asset", "PH-001", (b, id) => b.update(doc(db, "assets", "PH-001"), { status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: "x", auditId: id })).commit());
  await assertFails(auditedBatch(db, "A1", "asset", "PH-001", (b, id) => b.update(doc(db, "assets", "PH-001"), { active: false, auditId: id })).commit());
  // …but a different admin can do it
  const db2 = dbOf("A2");
  const l2 = doc(collection(db2, "logs"));
  const b2 = writeBatch(db2);
  const a2 = doc(collection(db2, "auditLog"));
  b2.set(a2, audit("A2", "asset", "PH-001"));
  b2.update(doc(db2, "assets", "PH-001"), { status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: l2.id, auditId: a2.id });
  b2.set(l2, logDoc({ type: "in", source: "admin", employeeId: "7001", employeeName: "Admin One" }));
  await assertSucceeds(b2.commit());
  // and as a person they can still scan devices out like anyone else
  await assertSucceeds(checkoutBatch(db).commit());
});

test("an admin can still manage devices held by other people", async () => {
  await linkAdmin("A1", "7001");
  await putOut();
  const db = dbOf("A1");
  await assertSucceeds(auditedBatch(db, "A1", "asset", "PH-001", (b, id) => b.update(doc(db, "assets", "PH-001"), { status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: "x", auditId: id })).commit());
});

test("history stays immutable for admins too", async () => {
  const db = dbOf("A1");
  const l = doc(collection(db, "logs"));
  await assertSucceeds(setDoc(l, logDoc()));
  await assertFails(updateDoc(l, { employeeId: "9999" }));
  await assertFails(deleteDoc(l));
});
