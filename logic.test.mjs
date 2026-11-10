import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, heldMinutes } from "../docs/js/scan-logic.js";
import { summarize, normalizeLog, actionLabel, activityRows } from "../docs/js/report-logic.js";
import { parseImport } from "../docs/js/import-logic.js";
import { parseCSV, toCSV, norm, validId, rangeFromInputs, fmtDur, derivePrefix, nextIdFor, slugify } from "../docs/js/util.js";
import { normSettings, pinNeed, validPin, hashPin, checkPin, newSalt } from "../docs/js/pin-logic.js";
import { parseShiftTimes, lastShiftChange, recentShiftChanges, carriedOver } from "../docs/js/shift-logic.js";
import { expectedIn, classifyScan, summarizeCount } from "../docs/js/inventory-logic.js";
import { removedMessage, reasonLabel, RETIRE_REASONS } from "../docs/js/scan-logic.js";
import { sanitizeConfig, defaultConfig, sizeOf, lineValue, readQueue, PRESETS, MAX_LINES, configsEqual } from "../docs/js/label-logic.js";

const jane = { id: "1001", name: "Jane Doe" };
const bob = { id: "1002", name: "Bob Ray" };
const phoneIn = { id: "PH-001", active: true, status: "in", currentHolderId: null, currentHolderName: null };
const phoneOutJane = { id: "PH-002", active: true, status: "out", currentHolderId: "1001", currentHolderName: "Jane Doe" };

// ───────── scan decisions ─────────
test("employee + available device → checkout (no takeover)", () => {
  const d = decide({ employee: jane, asset: phoneIn });
  assert.equal(d.action, "checkout");
  assert.equal(d.takeover, undefined);
});
test("employee + own device → checkin", () => {
  const d = decide({ employee: jane, asset: phoneOutJane });
  assert.equal(d.action, "checkin");
  assert.equal(d.holderName, "Jane Doe");
});
test("device scanned alone while out → checkin for the holder", () => {
  const d = decide({ employee: null, asset: phoneOutJane });
  assert.equal(d.action, "checkin");
  assert.equal(d.holderId, "1001");
});
test("device scanned alone while available → asks for ID", () => {
  const d = decide({ employee: null, asset: phoneIn });
  assert.equal(d.action, "error");
  assert.equal(d.code, "NEED_EMPLOYEE");
});
test("device still out to someone else → next person CAN take it, flagged as takeover", () => {
  const since = new Date("2026-11-09T08:00:00Z");
  const d = decide({ employee: bob, asset: { ...phoneOutJane, checkedOutAt: since } });
  assert.equal(d.action, "checkout");
  assert.deepEqual(d.takeover, { fromId: "1001", fromName: "Jane Doe", since });
});
test("one device per person still applies before a takeover", () => {
  const d = decide({ employee: bob, asset: phoneOutJane, held: [{ id: "PH-009" }] });
  assert.equal(d.code, "ALREADY_HAS");
  assert.equal(decide({ employee: bob, asset: phoneOutJane, held: [{ id: "PH-009" }], allowMultiple: true }).action, "checkout");
});
test("second device blocked by default, allowed when configured", () => {
  const held = [{ id: "PH-009" }];
  assert.equal(decide({ employee: jane, asset: phoneIn, held }).code, "ALREADY_HAS");
  assert.equal(decide({ employee: jane, asset: phoneIn, held, allowMultiple: true }).action, "checkout");
});
test("removed device is rejected in every case", () => {
  const gone = { ...phoneIn, active: false };
  assert.equal(decide({ employee: jane, asset: gone }).code, "ASSET_REMOVED");
  assert.equal(decide({ employee: null, asset: { ...phoneOutJane, active: false } }).code, "ASSET_REMOVED");
});
test("heldMinutes", () => {
  const t = new Date("2026-11-10T10:00:00Z");
  assert.equal(heldMinutes(t, new Date("2026-11-10T13:12:00Z")), 192);
  assert.equal(heldMinutes(null), null);
});

// ───────── reports ─────────
const T = (s) => new Date(s);
const logs = [
  { type: "in", assetId: "PH-001", assetModel: "iPhone 13", assetCategory: "Phone", employeeId: "1001", employeeName: "Jane Doe", heldMinutes: 120, ts: T("2026-11-10T14:00:00Z") },
  { type: "out", assetId: "PH-001", assetModel: "iPhone 13", assetCategory: "Phone", employeeId: "1001", employeeName: "Jane Doe", ts: T("2026-11-10T12:00:00Z") },
  { type: "out", assetId: "IP-001", assetModel: "iPad 10th", assetCategory: "iPad", employeeId: "1002", employeeName: "Bob Ray", ts: T("2026-11-10T13:00:00Z") },
  // Bob never returned IP-001; Cy took it
  { type: "missed", assetId: "IP-001", assetModel: "iPad 10th", assetCategory: "iPad", employeeId: "1002", employeeName: "Bob Ray", heldMinutes: 900, handledByName: "Cy Lee", ts: T("2026-11-11T04:00:00Z") },
  { type: "out", assetId: "IP-001", assetModel: "iPad 10th", assetCategory: "iPad", employeeId: "1003", employeeName: "Cy Lee", takeoverFromName: "Bob Ray", ts: T("2026-11-11T04:00:00Z") },
].map((l, i) => normalizeLog("id" + i, l));

test("summarize totals: missed returns are counted apart and never as time held", () => {
  const s = summarize(logs);
  assert.equal(s.checkouts, 3);
  assert.equal(s.returns, 1);
  assert.equal(s.missed, 1);
  assert.equal(s.heldMinutes, 120);
  assert.equal(s.uniqueStaff, 3);
  assert.equal(s.uniqueAssets, 2);
});
test("summarize per-person and per-asset rollups", () => {
  const s = summarize(logs);
  const bobRow = s.perStaff.find((x) => x.employeeId === "1002");
  assert.equal(bobRow.missed, 1);
  assert.equal(bobRow.heldMinutes, 0);
  const ipad = s.perAsset.find((a) => a.assetId === "IP-001");
  assert.equal(ipad.assetCategory, "iPad");
  assert.equal(ipad.missed, 1);
  assert.equal(ipad.lastHolder, "Cy Lee"); // the missed entry doesn't change who last held it
});
test("summarize empty", () => {
  const s = summarize([]);
  assert.equal(s.checkouts, 0);
  assert.equal(s.missed, 0);
  assert.deepEqual(s.perStaff, []);
});
test("normalizeLog falls back to the old assetType field for model", () => {
  assert.equal(normalizeLog("x", { type: "out", assetId: "A", assetType: "Galaxy" }).assetModel, "Galaxy");
});
test("action labels & activity export rows", () => {
  assert.equal(actionLabel(logs[3]), "Not returned (taken by Cy Lee)");
  assert.equal(actionLabel(logs[4]), "Checked out (was still with Bob Ray)");
  assert.equal(actionLabel(logs[0]), "Checked in");
  const rows = activityRows(logs);
  assert.equal(rows[0].length, 10);
  assert.equal(rows[2][3], "iPad");
});

// ───────── CSV / util ─────────
test("parseCSV handles quotes, CRLF, tabs, BOM", () => {
  assert.deepEqual(parseCSV('﻿a,b\r\n"x, y","he said ""hi"""\r\n'), [["a", "b"], ["x, y", 'he said "hi"']]);
  assert.deepEqual(parseCSV("id\tname\n1\tJane"), [["id", "name"], ["1", "Jane"]]);
});
test("toCSV round-trips awkward values", () => {
  const out = toCSV(["a", "b"], [['x,"y"', "line1\nline2"]]);
  assert.deepEqual(parseCSV(out), [["a", "b"], ['x,"y"', "line1\nline2"]]);
});
test("norm / validId", () => {
  assert.equal(norm("  ph-001 \n"), "PH-001");
  assert.ok(validId("PH-001") && validId("12345") && validId("A.B_C-1"));
  assert.ok(!validId("a/b") && !validId("") && !validId("-x") && !validId("X".repeat(41)));
});
test("rangeFromInputs is inclusive of the end day", () => {
  const { from, to } = rangeFromInputs("2026-11-01", "2026-11-10");
  assert.equal(from.getDate(), 1);
  assert.equal(to.getDate(), 11);
  assert.equal(to.getHours(), 0);
});
test("fmtDur", () => {
  assert.equal(fmtDur(5), "5m");
  assert.equal(fmtDur(192), "3h 12m");
  assert.equal(fmtDur(60 * 50), "2d 2h");
  assert.equal(fmtDur(null), "—");
});
test("derivePrefix / slugify / nextIdFor", () => {
  assert.equal(derivePrefix("Phone"), "PH-");
  assert.equal(derivePrefix("iPad"), "IP-");
  assert.equal(derivePrefix("  "), "AS-");
  assert.equal(slugify("Smart  Watch!"), "smart-watch");
  assert.equal(nextIdFor("PH-", 3, ["PH-004", "PH-010", "IP-020", "1001"]), "PH-011");
  assert.equal(nextIdFor("IP-", 3, []), "IP-001");
});

// ───────── imports ─────────
test("staff import: valid rows, dupes, missing pieces", () => {
  const rows = parseCSV("employeeId,name\n1001,Jane Doe\n1002,Bob Ray\n1002,Bob Again\n,No Id\n1003,\n1004,Existing\nbad/id,X");
  const { records, errors } = parseImport("staff", rows, { existingIds: new Set(["1004"]) });
  assert.deepEqual(records.map((r) => r.id), ["1001", "1002"]);
  assert.equal(errors.length, 5);
});
test("staff import: first/last name columns", () => {
  const { records } = parseImport("staff", parseCSV("Badge,First Name,Last Name\n77,Ann,Lee"));
  assert.deepEqual(records, [{ id: "77", name: "Ann Lee" }]);
});
test("staff import: missing id column is fatal", () => {
  assert.ok(parseImport("staff", parseCSV("name\nJane")).fatal);
});
test("asset import: types, models, auto-numbering per type prefix", () => {
  const csv = "assetId,assetType,model,IMEI,Serial Number,Phone Number\nPH-010,Phone,iPhone 13,356,SN1,352-555-0101\n,Phone,Galaxy,357,SN2,352-555-0102\n,iPad,iPad 10th,,SN3,\n,iPad,iPad 10th,,SN4,";
  const { records, errors, newTypes } = parseImport("asset", parseCSV(csv), {
    existingIds: new Set(["PH-004"]), pad: 3, knownTypes: [{ name: "Phone", prefix: "PH-" }],
  });
  assert.equal(errors.length, 0);
  assert.deepEqual(records.map((r) => r.id), ["PH-010", "PH-011", "IP-001", "IP-002"]);
  assert.deepEqual(newTypes, ["iPad"]);
  assert.equal(records[0].serial, "SN1");
  assert.equal(records[0].assetType, "Phone");
  assert.equal(records[1].phoneNumber, "352-555-0102");
});
test("asset import: type names match known types case-insensitively", () => {
  const { records, newTypes } = parseImport("asset", parseCSV("assetId,type\nX1,phone"), { knownTypes: [{ name: "Phone", prefix: "PH-" }] });
  assert.equal(records[0].assetType, "Phone");
  assert.deepEqual(newTypes, []);
});
test("asset import: default type fills blanks; no type at all is an error", () => {
  const withDefault = parseImport("asset", parseCSV("assetId,model\nX1,Pixel"), { defaultType: "Phone", knownTypes: [{ name: "Phone", prefix: "PH-" }] });
  assert.equal(withDefault.records[0].assetType, "Phone");
  const none = parseImport("asset", parseCSV("assetId,model\nX1,Pixel"));
  assert.equal(none.records.length, 0);
  assert.equal(none.errors.length, 1);
});
test("asset import: id clashing with a staff id is skipped", () => {
  const { records, errors } = parseImport("asset", parseCSV("assetId,assetType\n1001,Phone"), { existingIds: new Set(["1001"]) });
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
});

// ───────── label designer ─────────
test("sanitizeConfig repairs junk and enforces limits", () => {
  const c = sanitizeConfig("asset", {
    size: "bogus", customW: 99, customH: "x", barcodeSize: "huge", header: "H".repeat(100),
    lines: [{ field: "phoneNumber", text: "Phone: ", size: "lg", bold: 1 }, { field: "nope" }, ...Array(10).fill({ field: "model" })],
  });
  assert.equal(c.size, "2.25x1.25");
  assert.equal(c.customW, 8);
  assert.equal(c.customH, 1.25);
  assert.equal(c.barcodeSize, "md");
  assert.equal(c.header.length, 60);
  assert.equal(c.lines.length, MAX_LINES);
  assert.deepEqual(c.lines[0], { field: "phoneNumber", text: "Phone: ", size: "lg", bold: true });
});
test("sanitizeConfig: staff can't use asset fields; defaults when missing", () => {
  const c = sanitizeConfig("staff", { lines: [{ field: "imei" }, { field: "name" }] });
  assert.deepEqual(c.lines.map((l) => l.field), ["name"]);
  assert.equal(sanitizeConfig("staff", null).lines[0].field, "name");
  assert.deepEqual(sanitizeConfig("asset", {}).lines, []);
});
test("every built-in preset is already valid and stable under sanitize", () => {
  for (const kind of ["asset", "staff"])
    for (const p of PRESETS[kind]) assert.ok(configsEqual(p.config, sanitizeConfig(kind, p.config)), p.name);
});
test("sizeOf: presets and custom", () => {
  assert.deepEqual(sizeOf(defaultConfig("asset")), { w: 2.25, h: 1.25 });
  assert.deepEqual(sizeOf({ ...defaultConfig("asset"), size: "custom", customW: 3.5, customH: 1.5 }), { w: 3.5, h: 1.5 });
});
test("lineValue: prefix + value, blank fields are skipped, custom text always shows", () => {
  const a = { id: "PH-001", phoneNumber: "352-555-0101", model: "", category: "Phone" };
  assert.equal(lineValue(a, { field: "phoneNumber", text: "Phone: " }), "Phone: 352-555-0101");
  assert.equal(lineValue(a, { field: "model", text: "Model: " }), "");
  assert.equal(lineValue(a, { field: "category", text: "" }), "Phone");
  assert.equal(lineValue(a, { field: "custom", text: "Return to dispatch" }), "Return to dispatch");
});
test("readQueue: stored queue, URL ids, and all", () => {
  const stored = JSON.stringify({ kind: "staff", ids: ["1001", "1002"] });
  assert.deepEqual(readQueue(new URLSearchParams("queue=1"), stored), { kind: "staff", ids: ["1001", "1002"], all: false });
  assert.deepEqual(readQueue(new URLSearchParams("kind=asset&ids=ph-001, ph-002"), null), { kind: "asset", ids: ["PH-001", "PH-002"], all: false });
  assert.equal(readQueue(new URLSearchParams("ids=*"), null).all, true);
  assert.deepEqual(readQueue(new URLSearchParams("queue=1"), "not json").ids, []);
});

// ───────── lost / retired devices ─────────
test("removed-device messages say why", () => {
  assert.match(removedMessage({ id: "PH-9", retireReason: "lost" }), /LOST.*tell your supervisor/i);
  assert.match(removedMessage({ id: "PH-9", retireReason: "stolen" }), /stolen/);
  assert.match(removedMessage({ id: "PH-9", retireReason: "repair" }), /repair/);
  assert.match(removedMessage({ id: "PH-9", retireReason: "retired" }), /retired/);
  assert.match(removedMessage({ id: "PH-9" }), /removed from service/);
  assert.equal(reasonLabel("repair"), "Out for repair");
  assert.equal(reasonLabel(undefined), "Removed");
  assert.deepEqual(RETIRE_REASONS.map((r) => r.key), ["lost", "stolen", "repair", "retired", "removed"]);
});
test("decide() reports the specific reason for an out-of-service device", () => {
  const d = decide({ employee: jane, asset: { id: "PH-9", active: false, retireReason: "lost", status: "in" } });
  assert.equal(d.code, "ASSET_REMOVED");
  assert.match(d.message, /LOST/);
});

// ───────── PIN ─────────
test("pinNeed: off / selected / all, first-use create vs enter", () => {
  const withPin = { pinHash: "x", pinSalt: "y" };
  assert.equal(pinNeed({ pinMode: "off" }, { pinRequired: true, ...withPin }), "none");
  assert.equal(pinNeed(undefined, { pinRequired: true }), "none"); // no settings doc = off
  assert.equal(pinNeed({ pinMode: "selected" }, { pinRequired: false, ...withPin }), "none");
  assert.equal(pinNeed({ pinMode: "selected" }, { pinRequired: true }), "create");
  assert.equal(pinNeed({ pinMode: "selected" }, { pinRequired: true, ...withPin }), "enter");
  assert.equal(pinNeed({ pinMode: "all" }, {}), "create");
  assert.equal(pinNeed({ pinMode: "all" }, withPin), "enter");
  assert.equal(normSettings({ pinMode: "bogus" }).pinMode, "off");
});
test("validPin is 4 to 6 digits", () => {
  for (const ok of ["1234", "12345", "123456", "0000"]) assert.ok(validPin(ok), ok);
  for (const bad of ["123", "1234567", "12a4", "", " 1234", null, "12 34"]) assert.ok(!validPin(bad), String(bad));
});
test("hashPin: salted, deterministic, never contains the PIN; checkPin accepts only the right one", async () => {
  const salt = newSalt();
  assert.equal(salt.length, 32);
  const h = await hashPin("4821", salt);
  assert.equal(h.length, 64);
  assert.equal(h, await hashPin("4821", salt));
  assert.notEqual(h, await hashPin("4821", newSalt()));
  assert.ok(!h.includes("4821"));
  const staff = { pinHash: h, pinSalt: salt };
  assert.ok(await checkPin("4821", staff));
  assert.ok(!(await checkPin("4822", staff)));
  assert.ok(!(await checkPin("4821", {})));
  assert.ok(!(await checkPin("12", staff)));
});

// ───────── shift sweep ─────────
test("parseShiftTimes validates, pads, sorts, dedupes", () => {
  assert.deepEqual(parseShiftTimes("15:00, 7:00 23:00;15:00").times, ["07:00", "15:00", "23:00"]);
  assert.match(parseShiftTimes("25:00").error, /isn't a time/);
  assert.match(parseShiftTimes("7pm").error, /isn't a time/);
  assert.match(parseShiftTimes("  ").error, /at least one/);
});
test("lastShiftChange / recentShiftChanges look back across midnight", () => {
  const times = ["07:00", "15:00", "23:00"];
  const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi);
  assert.equal(+lastShiftChange(times, at(2026, 11, 10, 16, 30)), +at(2026, 11, 10, 15));
  assert.equal(+lastShiftChange(times, at(2026, 11, 10, 6, 0)), +at(2026, 11, 9, 23));
  assert.equal(+lastShiftChange(times, at(2026, 11, 10, 7, 0)), +at(2026, 11, 10, 7));
  const recent = recentShiftChanges(times, at(2026, 11, 10, 16, 0));
  assert.deepEqual(recent.map((d) => d.getHours()), [15, 7, 23]); // newest first, within 24h
});
test("carriedOver: checked out before the boundary", () => {
  const b = new Date(2026, 10, 10, 15, 0);
  assert.ok(carriedOver(new Date(2026, 10, 10, 13, 0), b));
  assert.ok(!carriedOver(new Date(2026, 10, 10, 15, 5), b));
  assert.ok(!carriedOver(null, b));
  assert.ok(!carriedOver(new Date(), null));
});

// ───────── inventory count ─────────
const inv = [
  { id: "PH-001", active: true, status: "in", category: "Phone" },
  { id: "PH-002", active: true, status: "in", category: "Phone" },
  { id: "PH-003", active: true, status: "out", category: "Phone", currentHolderName: "Jane Doe" },
  { id: "PH-004", active: false, status: "in", category: "Phone", retireReason: "lost" },
  { id: "IP-001", active: true, status: "in", category: "iPad" },
];
test("expectedIn: only in-service, not checked out, within scope", () => {
  assert.deepEqual(expectedIn(inv), ["IP-001", "PH-001", "PH-002"]);
  assert.deepEqual(expectedIn(inv, "Phone"), ["PH-001", "PH-002"]);
});
test("classifyScan covers every case", () => {
  const m = new Map(inv.map((a) => [a.id, a]));
  assert.equal(classifyScan("PH-001", m, "Phone").kind, "found");
  assert.equal(classifyScan("PH-003", m, "Phone").kind, "outButPresent");
  assert.equal(classifyScan("PH-004", m, "Phone").kind, "outOfService");
  assert.equal(classifyScan("IP-001", m, "Phone").kind, "outOfScope");
  assert.equal(classifyScan("IP-001", m, "").kind, "found");
  assert.equal(classifyScan("NOPE", m).kind, "unknown");
});
test("summarizeCount: missing excludes devices that are out with staff; duplicates ignored", () => {
  const r = summarizeCount({ assets: inv, scanned: ["PH-001", "PH-001", "PH-003", "PH-004", "IP-001"], unknown: ["X1", "X1"], scope: "Phone" });
  assert.deepEqual(r.expected, ["PH-001", "PH-002"]);
  assert.deepEqual(r.found, ["PH-001"]);
  assert.deepEqual(r.missing, ["PH-002"]);
  assert.deepEqual(r.outButPresent, ["PH-003"]);
  assert.deepEqual(r.outOfService, ["PH-004"]);
  assert.deepEqual(r.outOfScope, ["IP-001"]);
  assert.deepEqual(r.unknown, ["X1"]);
  const all = summarizeCount({ assets: inv, scanned: ["PH-001", "PH-002", "IP-001"] });
  assert.deepEqual(all.missing, []);
});
