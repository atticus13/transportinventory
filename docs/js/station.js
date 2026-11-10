import { auth, db, A, F, configured, friendlyAuthError } from "./fb.js";
import { SETTINGS } from "./firebase-config.js";
import { decide, heldMinutes } from "./scan-logic.js";
import { normSettings, pinNeed, validPin, hashPin, newSalt, checkPin } from "./pin-logic.js";
import { $, esc, norm, validId, fmtTime, fmtDur, beep } from "./util.js";

const S = SETTINGS;
const PIN_SECONDS = S.PIN_SECONDS ?? 30;
const PIN_MAX_TRIES = S.PIN_MAX_TRIES ?? 3;
const ICONS = {
  idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.5-1.6 1.8-2.4 3.2-2.4s2.7.8 3.2 2.4M15 10h3.5M15 13h3.5"/></svg>',
  pending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/><path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4M20 8V6.5A2.5 2.5 0 0 0 17.5 4" opacity=".55"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.01"/><path d="M10.3 3.9L2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
};

let pending = null;          // {id, name, source, rec, pin: null | {need, tries, first, verified, created}}
let settings = normSettings(null);
let unsubSettings = null;
let hintTimer = null;
let wakeLock = null;
let clockClicks = [];
let pendingTimer = null;
let resetTimer = null;
let chain = Promise.resolve();
let unsubRecent = null;
let clockTimer = null;

// ───────── views ─────────
function show(which) {
  for (const id of ["setup", "login", "app"]) $("#" + id).classList.toggle("hidden", id !== which);
}

function setStage(kind, { title = "", name = "", sub = "" } = {}) {
  const el = $("#stage");
  el.className = "stage " + kind;
  $("#stIcon").innerHTML = ICONS[kind] || "";
  $("#stTitle").textContent = title;
  $("#stName").textContent = name;
  $("#stSub").textContent = sub;
}

function clearTimers() {
  clearTimeout(pendingTimer);
  clearTimeout(resetTimer);
}

const scanEl = () => $("#scan");
const pinActive = () => !!(pending?.pin && !pending.pin.verified);

/** Show/hide the on-screen keypad and mask the scan field while a PIN is being typed. */
function setPinUi(on) {
  $("#keypad").classList.toggle("hidden", !on);
  $("#stPins").classList.toggle("hidden", !on);
  $("#stPins").textContent = "";
  const el = scanEl();
  el.type = on ? "password" : "text";
  el.placeholder = on ? "Type your PIN, then press Enter" : "Scanner ready — scan a barcode";
  el.value = "";
}
const updateDots = () => { if (pinActive()) $("#stPins").textContent = "●".repeat(scanEl().value.length); };

function pinCopy(p) {
  if (p.need === "create") return p.first == null ? "Create a PIN: 4 to 6 digits. You'll use it every time you scan your ID." : "Enter the same PIN again to confirm.";
  return "Enter your PIN, then press Enter.";
}

function idle() {
  clearTimers();
  pending = null;
  setPinUi(false);
  setStage("idle", {
    title: "Scan your ID badge",
    sub: "To take a device, scan your ID and then the device. To return one, just scan the device.",
  });
  focusScan();
}

function showPending() {
  clearTimers();
  const needPin = pinActive();
  setPinUi(needPin);
  setStage("pending", {
    title: `Hi, ${pending.name}`, name: "",
    sub: needPin ? pinCopy(pending.pin) : `${pending.pin?.created ? "PIN saved. " : ""}Now scan the device you're taking.`,
  });
  const secs = needPin ? PIN_SECONDS : S.EMPLOYEE_PENDING_SECONDS;
  const bar = $("#stBar");
  bar.style.transition = "none";
  bar.style.width = "100%";
  void bar.offsetWidth;
  bar.style.transition = `width ${secs}s linear`;
  bar.style.width = "0%";
  pendingTimer = setTimeout(idle, secs * 1000);
  focusScan();
}

function showResult(kind, o, seconds = S.RESULT_SECONDS) {
  clearTimers();
  if (!(kind === "error" && o.keepPending && pending)) setPinUi(false);
  setStage(kind, o);
  beep(kind === "error" ? "error" : kind);
  resetTimer = setTimeout(() => (pending && kind === "error" && o.keepPending ? showPending() : idle()), seconds * 1000);
  focusScan();
}

const showError = (message, { title = "Can't do that", keepPending = false } = {}) => {
  if (!keepPending) pending = null;
  showResult("error", { title, sub: message, keepPending });
};

function focusScan() {
  if ($("#manual").open || $("#issueBox").open) return;
  const s = $("#scan");
  if (document.activeElement !== s) s.focus({ preventScroll: true });
}

// ───────── lookups ─────────
async function lookup(code) {
  if (!validId(code)) return { kind: "unknown" };
  const a = await F.getDoc(F.doc(db, "assets", code));
  if (a.exists()) return { kind: "asset", rec: { id: a.id, ...a.data() } };
  const s = await F.getDoc(F.doc(db, "staff", code));
  if (s.exists()) return { kind: "employee", rec: { id: s.id, ...s.data() } };
  return { kind: "unknown" };
}

async function devicesHeldBy(employeeId) {
  const snap = await F.getDocs(F.query(F.collection(db, "assets"), F.where("currentHolderId", "==", employeeId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.status === "out" && a.active);
}

// ───────── scan handling ─────────
// Scans run one at a time, in order, so a fast double-scan can never interleave.
function enqueue(fn) {
  chain = chain.then(fn).catch((e) => {
    if (e?.handled) return; // a specific error is already on screen
    console.error(e);
    const denied = e?.code === "permission-denied";
    showError(
      denied
        ? "This login isn't allowed to do that. Ask an admin to check the station account."
        : "Couldn't reach the server. Check the internet and try again.",
      { title: "Not saved" }
    );
  });
}

async function processCode(code, source) {
  hideHint();
  const found = await lookup(code);
  if (found.kind === "unknown")
    return showError(`“${code}” isn't a known ID badge or device. Try again, or enter it manually below.`, { title: "Not recognised", keepPending: !!pending });
  if (found.kind === "employee") return processEmployee(found.rec, source);
  return processAsset(found.rec, source);
}

/** Returns true when the employee is accepted and we're waiting for the device. */
function processEmployee(rec, source) {
  if (!rec.active) {
    showError(`${rec.name}'s ID is inactive. See your supervisor.`, { title: "ID not active" });
    return false;
  }
  const need = pinNeed(settings, rec);
  pending = { id: rec.id, name: rec.name, source, rec, pin: need === "none" ? null : { need, tries: 0, first: null, verified: false, created: false } };
  beep("ok");
  showPending();
  return true;
}

async function processAsset(asset, source) {
  if (pinActive()) return showError("Enter your PIN first, then scan the device.", { title: "PIN needed", keepPending: true });
  const employee = pending ? { id: pending.id, name: pending.name } : null;
  const held = employee && !S.ALLOW_MULTIPLE_PER_EMPLOYEE ? await devicesHeldBy(employee.id) : [];
  const d = decide({ employee, asset, held, allowMultiple: S.ALLOW_MULTIPLE_PER_EMPLOYEE });

  if (d.action === "error") return showError(d.message, { title: titleFor(d.code, asset) });

  const logSource = source === "manual" || pending?.source === "manual" ? "manual" : "scan";
  const result = await commit(d, asset, employee, logSource);
  pending = null;

  const label = `${asset.id}${asset.model || asset.category ? " · " + (asset.model || asset.category) : ""}`;
  if (result.kind === "out") {
    const note = result.takeoverFrom ? `\nHeads-up: it was still checked out to ${result.takeoverFrom}. An admin will follow up.` : "";
    showResult("out", { title: "CHECKED OUT", name: employee.name, sub: `${label} · ${fmtTime(new Date())}${note}` }, note ? S.RESULT_SECONDS + 3 : S.RESULT_SECONDS);
    offerIssue(asset.id, employee.id);
  } else {
    showResult("in", {
      title: "CHECKED IN",
      name: result.holderName,
      sub: `${label} · returned ${fmtTime(new Date())}${result.minutes != null ? " · held " + fmtDur(result.minutes) : ""}`,
    });
    offerIssue(asset.id, result.holderId);
  }
}

const titleFor = (code, asset) => {
  if (code === "ASSET_REMOVED" && asset?.retireReason === "lost") return "Marked as LOST";
  if (code === "ASSET_REMOVED" && asset?.retireReason === "stolen") return "Reported stolen";
  return { NEED_EMPLOYEE: "Scan your ID first", ALREADY_HAS: "You already have a device", ASSET_REMOVED: "Device not in service" }[code] || "Can't do that";
};

// ───────── PIN entry ─────────
async function handlePin(code) {
  const p = pending;
  if (!p?.pin || p.pin.verified) return;
  if (!/^\d+$/.test(code)) return showError("Enter your PIN first, then scan the device.", { title: "PIN needed", keepPending: true });
  const pin = p.pin;

  if (pin.need === "enter") {
    if (await checkPin(code, p.rec)) { pin.verified = true; beep("ok"); return showPending(); }
    pin.tries++;
    if (pin.tries >= PIN_MAX_TRIES)
      return showError("Too many wrong PINs. Scan your ID to start over. If you forgot it, ask a supervisor to reset it.", { title: "PIN locked" });
    const left = PIN_MAX_TRIES - pin.tries;
    return showError(`That isn't your PIN. ${left} ${left === 1 ? "try" : "tries"} left.`, { title: "Wrong PIN", keepPending: true });
  }

  // First use: create a PIN (typed twice). Saved once; only an admin can change it afterwards.
  if (!validPin(code)) return showError("A PIN is 4 to 6 digits.", { title: "Try again", keepPending: true });
  if (pin.first == null) { pin.first = code; return showPending(); }
  if (code !== pin.first) { pin.first = null; return showError("Those didn't match. Let's start again.", { title: "PINs don't match", keepPending: true }); }

  const salt = newSalt();
  const hash = await hashPin(code, salt);
  const b = F.writeBatch(db);
  b.update(F.doc(db, "staff", p.id), { pinHash: hash, pinSalt: salt, pinSetAt: F.serverTimestamp() });
  await b.commit();
  p.rec.pinHash = hash; p.rec.pinSalt = salt;
  pin.verified = true; pin.created = true;
  beep("ok");
  showPending();
}

// ───────── report a problem ─────────
function hideHint() { clearTimeout(hintTimer); $("#issueHint").classList.add("hidden"); }
function offerIssue(assetId, empId) {
  const btn = $("#issueHint");
  btn.textContent = `Something wrong with ${assetId}? Report it`;
  btn.dataset.asset = assetId; btn.dataset.emp = empId || "";
  btn.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 20000);
}
$("#issueHint").addEventListener("click", () => {
  $("#iDev").value = $("#issueHint").dataset.asset || "";
  $("#iEmp").value = $("#issueHint").dataset.emp || "";
  $("#issueBox").open = true;
  hideHint();
  $("#iType").focus();
});
$("#issueBox").addEventListener("toggle", () => { if ($("#issueBox").open) { if (!$("#iDev").value) $("#iDev").focus(); } else focusScan(); });

$("#issueForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("#iErr").textContent = "";
  enqueue(async () => {
    const dev = norm($("#iDev").value), emp = norm($("#iEmp").value), problem = $("#iType").value, note = $("#iNote").value.trim();
    if (!dev || !emp || !problem) { $("#iErr").textContent = "Fill in the device, your ID and what's wrong."; throw Object.assign(new Error("handled"), { handled: true }); }
    const [a, s] = await Promise.all([F.getDoc(F.doc(db, "assets", dev)), F.getDoc(F.doc(db, "staff", emp))]);
    if (!a.exists()) { $("#iErr").textContent = `“${dev}” isn't a known device ID.`; throw Object.assign(new Error("handled"), { handled: true }); }
    if (!s.exists() || s.data().active !== true) { $("#iErr").textContent = `“${emp}” isn't an active employee ID.`; throw Object.assign(new Error("handled"), { handled: true }); }
    const ref = F.doc(F.collection(db, "issues"));
    const b = F.writeBatch(db);
    b.set(ref, {
      status: "open", assetId: dev, assetModel: a.data().model || "", assetCategory: a.data().category || "",
      problem, note, reportedById: emp, reportedByName: s.data().name, ts: F.serverTimestamp(),
    });
    await b.commit();
    $("#issueForm").reset();
    $("#issueBox").open = false;
    showResult("in", { title: "REPORT SENT", name: s.data().name, sub: `${dev} · ${problem}\nAn admin will take a look.` }, S.RESULT_SECONDS + 2);
  });
});
$("#iDev").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#iType").focus(); } }); // a scanner ends with Enter

const appError = (message) => Object.assign(new Error("app"), { app: message });

/**
 * One atomic transaction: update the device AND write the log entry, or neither.
 * If the device is still out to someone else, the next person still gets it; we also record
 * a "missed return" against the previous holder and open an alert for the admins.
 */
async function commit(decision, asset, employee, source) {
  const assetRef = F.doc(db, "assets", asset.id);
  const logRef = F.doc(F.collection(db, "logs"));
  let out;

  await F.runTransaction(db, async (tx) => {
    const snap = await tx.get(assetRef);
    const cur = snap.data();
    if (!snap.exists() || !cur.active) throw appError("That device is no longer in service.");

    const base = { assetId: asset.id, assetModel: cur.model || "", assetCategory: cur.category || "" };

    if (decision.action === "checkout") {
      if (cur.status === "out" && cur.currentHolderId === employee.id) throw appError(`You already have ${asset.id}. Scan it by itself to return it.`);
      const takeover = cur.status === "out";
      let incidentId = null;

      if (takeover) {
        const mins = heldMinutes(cur.checkedOutAt?.toDate?.());
        const missedRef = F.doc(F.collection(db, "logs"));
        const incRef = F.doc(F.collection(db, "incidents"));
        incidentId = incRef.id;
        tx.set(missedRef, {
          type: "missed", ...base, employeeId: cur.currentHolderId, employeeName: cur.currentHolderName,
          handledById: employee.id, handledByName: employee.name, heldMinutes: mins, source, incidentId, ts: F.serverTimestamp(),
        });
        tx.set(incRef, {
          status: "open", ...base, missedById: cur.currentHolderId, missedByName: cur.currentHolderName,
          checkedOutAt: cur.checkedOutAt ?? null, takenOverById: employee.id, takenOverByName: employee.name,
          heldMinutes: mins, source, ts: F.serverTimestamp(),
        });
      }

      tx.update(assetRef, {
        status: "out", currentHolderId: employee.id, currentHolderName: employee.name,
        checkedOutAt: F.serverTimestamp(), lastLogId: logRef.id,
      });
      tx.set(logRef, {
        type: "out", ...base, employeeId: employee.id, employeeName: employee.name,
        handledById: employee.id, handledByName: employee.name, heldMinutes: null, source,
        takeoverFromId: takeover ? cur.currentHolderId : null, takeoverFromName: takeover ? cur.currentHolderName : null,
        incidentId, ts: F.serverTimestamp(),
      });
      out = { kind: "out", takeoverFrom: takeover ? cur.currentHolderName : null };
    } else {
      if (cur.status !== "out") throw appError(`${asset.id} was already checked in.`);
      const minutes = heldMinutes(cur.checkedOutAt?.toDate?.());
      tx.update(assetRef, {
        status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: logRef.id,
      });
      tx.set(logRef, {
        type: "in", ...base, employeeId: cur.currentHolderId, employeeName: cur.currentHolderName,
        handledById: employee?.id || cur.currentHolderId, handledByName: employee?.name || cur.currentHolderName,
        heldMinutes: minutes, source, ts: F.serverTimestamp(),
      });
      out = { kind: "in", holderName: cur.currentHolderName, holderId: cur.currentHolderId, minutes };
    }
  }).catch((e) => {
    if (e.app) { showError(e.app, { title: "Try again" }); throw Object.assign(new Error("handled"), { handled: true }); }
    throw e;
  });
  return out;
}

// ───────── recent activity ─────────
function listenRecent() {
  unsubRecent?.();
  unsubRecent = F.onSnapshot(
    F.query(F.collection(db, "logs"), F.orderBy("ts", "desc"), F.limit(8)),
    (snap) => {
      const box = $("#recent");
      if (snap.empty) { box.innerHTML = '<div class="empty">No activity yet.</div>'; return; }
      const tag = { out: ["out", "OUT"], in: ["in", "IN"], missed: ["warn", "MISSED"] };
      box.innerHTML = snap.docs.map((doc) => {
        const l = doc.data({ serverTimestamps: "estimate" });
        const [cls, text] = tag[l.type] || ["off", "?"];
        return `<div class="recent-row">
          <span class="chip ${cls}">${text}</span>
          <span class="who">${esc(l.employeeName)}</span>
          <span class="mono muted">${esc(l.assetId)}</span>
          <span class="t">${fmtTime(l.ts)}</span></div>`;
      }).join("");
    },
    () => { $("#recent").innerHTML = '<div class="empty">Activity unavailable.</div>'; }
  );
}

// ───────── auth ─────────
async function operatorRole(user) {
  const a = await F.getDoc(F.doc(db, "admins", user.uid));
  if (a.exists() && a.data().active === true) return "admin";
  const s = await F.getDoc(F.doc(db, "stations", user.uid));
  if (s.exists() && s.data().active === true) return "station";
  return null;
}

function boot() {
  $("#brandOrg").textContent = S.ORG_NAME;
  document.title = `${S.APP_NAME} · ${S.ORG_NAME}`;
  if (!configured) return show("setup");

  A.onAuthStateChanged(auth, async (user) => {
    unsubRecent?.(); unsubSettings?.(); clearInterval(clockTimer);
    if (!user) { show("login"); return; }
    let role = null;
    try { role = await operatorRole(user); } catch (e) { console.error(e); }
    if (!role) {
      await A.signOut(auth);
      $("#lErr").textContent = "That login isn't authorised for this station. Ask an admin to set it up.";
      show("login");
      return;
    }
    $("#adminLink").classList.toggle("hidden", role !== "admin");
    show("app");
    idle();
    listenRecent();
    unsubSettings = F.onSnapshot(F.collection(db, "settings"), (snap) => { settings = normSettings(snap.docs.find((d) => d.id === "app")?.data()); }, () => {});
    initKiosk();
    const tick = () => ($("#clock").textContent = new Date().toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    tick(); clockTimer = setInterval(tick, 15000);
  });
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#lErr").textContent = "";
  try { await A.signInWithEmailAndPassword(auth, $("#lEmail").value.trim(), $("#lPass").value); }
  catch (err) { $("#lErr").textContent = friendlyAuthError(err); }
});
$("#signOut").addEventListener("click", () => A.signOut(auth));

// ───────── input wiring ─────────
const scan = $("#scan");
function submitScan() {
  const code = norm(scan.value);
  scan.value = "";
  updateDots();
  if (!code) return;
  if (pinActive()) enqueue(() => handlePin(code));
  else enqueue(() => processCode(code, "scan"));
}
scan.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); submitScan(); return; }
  if (e.key === "Escape") { scan.value = ""; idle(); }
});
scan.addEventListener("input", updateDots);

$("#keypad").addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  const k = b.dataset.k;
  if (k === "enter") submitScan();
  else if (k === "back") { scan.value = scan.value.slice(0, -1); updateDots(); }
  else if (scan.value.length < 6) { scan.value += k; updateDots(); }
});

$("#clearBtn").addEventListener("click", () => { scan.value = ""; idle(); });

$("#manualForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const emp = norm($("#mEmp").value), ph = norm($("#mPhone").value);
  if (!emp && !ph) return;
  enqueue(async () => {
    if (emp) {
      const r = await lookup(emp);
      if (r.kind !== "employee") return showError(`“${emp}” isn't a known employee ID.`, { title: "Not recognised" });
      if (!processEmployee(r.rec, "manual")) return;
      if (pinActive()) return; // they now need to enter their PIN; the device is scanned afterwards
    }
    if (ph) {
      const r = await lookup(ph);
      if (r.kind !== "asset") return showError(`“${ph}” isn't a known device ID.`, { title: "Not recognised" });
      await processAsset(r.rec, "manual");
    }
  });
  $("#mEmp").value = ""; $("#mPhone").value = "";
  $("#manual").open = false;
});

$("#manual").addEventListener("toggle", () => { if ($("#manual").open) $("#mEmp").focus(); else focusScan(); });

// keep the scanner field focused so a scan always lands somewhere
setInterval(() => {
  if ($("#app").classList.contains("hidden") || $("#manual").open || $("#issueBox").open) return;
  const t = document.activeElement?.tagName;
  if (t !== "INPUT" && t !== "TEXTAREA" && t !== "SUMMARY") focusScan();
}, 700);
document.addEventListener("click", (e) => { if (!e.target.closest("details, button, a, input, select")) focusScan(); });

// ───────── kiosk mode ─────────
// Full screen, big type, no links to wander off to. Remembered on this computer.
// Exit: click the clock 5 times quickly, or press Ctrl+Shift+K.
async function holdScreenAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}
function setKiosk(on, persist = true) {
  document.body.classList.toggle("kiosk", on);
  if (persist) { try { localStorage.setItem("kiosk", on ? "1" : "0"); } catch { /* ignore */ } }
  try {
    if (on) { document.documentElement.requestFullscreen?.().catch?.(() => {}); holdScreenAwake(); }
    else { if (document.fullscreenElement) document.exitFullscreen?.(); wakeLock?.release?.(); wakeLock = null; }
  } catch { /* fullscreen needs a click; the big layout still applies */ }
  focusScan();
}
function initKiosk() {
  let want = false;
  try { want = localStorage.getItem("kiosk") === "1"; } catch { /* ignore */ }
  const q = new URLSearchParams(location.search).get("kiosk");
  if (q === "1") want = true; else if (q === "0") want = false;
  if (want) setKiosk(true, q !== null);
}
$("#kioskBtn").addEventListener("click", () => setKiosk(true));
$("#clock").addEventListener("click", () => {
  const t = Date.now();
  clockClicks = [...clockClicks.filter((x) => t - x < 4000), t];
  if (clockClicks.length >= 5 && document.body.classList.contains("kiosk")) { clockClicks = []; setKiosk(false); }
});
document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); setKiosk(!document.body.classList.contains("kiosk")); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && document.body.classList.contains("kiosk")) holdScreenAwake(); });

boot();
