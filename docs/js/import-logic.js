// Pure spreadsheet-import parsing (no Firebase) — unit tested in tests/.
// Works on rows read from a CSV, a pasted table or an Excel sheet (array of arrays; first row = header).
import { norm, validId, lowestFreeIdFor } from "./util.js";

/** Compare IMEIs, serials and phone numbers loosely: ignore case, spaces, dashes and brackets. */
export const normDetail = (field, v) => {
  const t = String(v ?? "").trim();
  if (!t) return "";
  return field === "serial" ? t.toUpperCase().replace(/[\s\-_.]/g, "") : t.replace(/[^0-9a-z]/gi, "").toUpperCase();
};
export const DUP_FIELDS = [["imei", "IMEI"], ["serial", "serial number"], ["phoneNumber", "phone number"]];

/** Which of imei/serial/phoneNumber are already on another asset? → [{field, label, value, assetId}] */
export function findDuplicates(assets, values, ignoreId = null) {
  const out = [];
  for (const [field, label] of DUP_FIELDS) {
    const v = normDetail(field, values?.[field]);
    if (!v) continue;
    const hit = assets.find((a) => a.id !== ignoreId && normDetail(field, a[field]) === v);
    if (hit) out.push({ field, label, value: String(values[field]).trim(), assetId: hit.id });
  }
  return out;
}

const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const COLS = {
  staff: {
    id: ["employeeid", "empid", "eid", "employeenumber", "employeeno", "id"],
    badge: ["badgeid", "badgenumber", "badgeno", "badge", "badgebarcode", "badgecode", "idbadge", "cardnumber"],
    name: ["name", "fullname", "employeename"],
    first: ["firstname", "first"],
    last: ["lastname", "last", "surname"],
  },
  asset: {
    id: ["assetid", "deviceid", "phoneid", "barcode", "id"],
    assetType: ["assettype", "category", "type"],
    model: ["model", "phonetype", "devicetype", "device"],
    imei: ["imei"],
    serial: ["serialnumber", "serial", "sn", "serialno"],
    phoneNumber: ["phonenumber", "number", "phone", "mobile", "line"],
  },
  admin: {
    email: ["email", "emailaddress", "mail"],
    name: ["name", "fullname"],
    role: ["role", "type", "access"],
    employeeId: ["employeeid", "empid", "eid", "employeenumber", "staffid", "id"],
    badge: ["badgeid", "badgenumber", "badgeno", "badge", "badgenum"],
  },
};

const findCol = (header, names) => {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
};

const cellOf = (r, i) => (i === -1 ? "" : String(r[i] ?? "").trim());
const BAD_ID = (v) => `“${v}” has characters we can't use (letters, numbers, . - _ only).`;

/**
 * rows         : array of arrays (first row = header)
 * existingIds  : Set<string> of every ID already used by an asset, a staff member OR a badge number
 * existingStaff: Map<employeeId, {name, badgeId}>   (staff import: lets a file fill in badge numbers)
 * knownTypes   : [{name, prefix, pad}] existing asset types
 * defaultType  : asset type name for rows that don't specify one
 * returns      : {records, updates, errors:[{line,message}], newTypes:[name], fatal?:string}
 *   staff: records = new people, updates = existing people getting a badge number
 */
export function parseImport(kind, rows, { existingIds = new Set(), existingStaff = new Map(), existingAssets = [], pad = 3, knownTypes = [], defaultType = "" } = {}) {
  const errors = [];
  const none = { records: [], updates: [], errors, newTypes: [] };
  if (!rows.length) return { ...none, fatal: "Nothing to import." };

  const header = rows[0].map(key);
  const spec = COLS[kind];
  const idx = Object.fromEntries(Object.entries(spec).map(([f, names]) => [f, findCol(header, names)]));

  if (kind === "staff") {
    if (idx.id === -1) return { ...none, fatal: "Couldn't find an employee ID column. Name it “employeeId”." };
    if (idx.name === -1 && (idx.first === -1 || idx.last === -1) && idx.badge === -1)
      return { ...none, fatal: "Couldn't find a name column. Use “name”, or “firstName” and “lastName”. (A file with just employeeId and badgeId can only add badge numbers to people who already exist.)" };
  } else if (Object.values(idx).every((i) => i === -1)) {
    return { ...none, fatal: "Couldn't recognise any columns. Use: assetId, assetType, model, imei, serial, phoneNumber." };
  }

  const cell = (r, i) => cellOf(r, i);
  const seen = new Set();          // ids claimed by earlier rows in this file
  const records = [];
  const updates = [];
  const pending = [];              // asset rows needing an auto ID
  const taken = Object.fromEntries(DUP_FIELDS.map(([f]) => [f, new Map()])); // normalised value → asset id (existing, then this file)
  for (const a of existingAssets) for (const [f] of DUP_FIELDS) { const v = normDetail(f, a[f]); if (v) taken[f].set(v, a.id); }
  const dupMessage = (rec, id) => {
    for (const [f, label] of DUP_FIELDS) {
      const v = normDetail(f, rec[f]);
      if (v && taken[f].has(v)) return `${id || "Row"}: ${label} ${rec[f]} is already on ${taken[f].get(v)} — skipped.`;
    }
    return null;
  };
  const claim = (rec, id) => { for (const [f] of DUP_FIELDS) { const v = normDetail(f, rec[f]); if (v) taken[f].set(v, id); } };

  const known = new Map(knownTypes.map((t) => [t.name.toLowerCase(), t]));
  // Types are only created in Assets → Asset types, so a row has to name one that exists.
  const typeOf = (raw) => {
    const name = (raw || defaultType || "").trim();
    return name ? { name, info: known.get(name.toLowerCase()) } : null;
  };
  const typeInfo = (name) => known.get(name.toLowerCase());
  const prefixFor = (name) => typeInfo(name)?.prefix ?? "";
  const padFor = (name) => typeInfo(name)?.pad ?? pad;

  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const rawId = norm(cell(r, idx.id));

    if (kind === "staff") {
      const name = idx.name !== -1 ? cell(r, idx.name) : `${cell(r, idx.first)} ${cell(r, idx.last)}`.trim();
      const badge = norm(cell(r, idx.badge));
      if (!rawId) return errors.push({ line, message: "Missing employee ID." });
      if (!validId(rawId)) return errors.push({ line, message: BAD_ID(rawId) });
      if (badge && !validId(badge)) return errors.push({ line, message: `${rawId}: badge number ${BAD_ID(badge)}` });
      if (badge && badge === rawId) return errors.push({ line, message: `${rawId}: the badge number is the same as the employee ID. Leave it blank if the badge shows the employee ID.` });

      const badgeClash = () => {
        if (!badge) return null;
        if (seen.has(badge)) return `${rawId}: badge number ${badge} is used twice in the file.`;
        if (existingIds.has(badge) && existingStaff.get(rawId)?.badgeId !== badge) return `${rawId}: badge number ${badge} is already used by someone or something else.`;
        return null;
      };

      // Existing person → this row can fill in their badge number
      if (existingStaff.has(rawId)) {
        const cur = existingStaff.get(rawId);
        if (!badge) return errors.push({ line, message: `${rawId} already exists — skipped.` });
        if (cur.badgeId === badge) return errors.push({ line, message: `${rawId} already has badge ${badge} — skipped.` });
        const clash = badgeClash();
        if (clash) return errors.push({ line, message: clash });
        seen.add(rawId); seen.add(badge);
        updates.push({ id: rawId, name: cur.name, badgeId: badge, previous: cur.badgeId || "" });
        return;
      }

      if (existingIds.has(rawId)) return errors.push({ line, message: `${rawId} is already used by a device — skipped.` });
      if (seen.has(rawId)) return errors.push({ line, message: `${rawId} appears twice in the file — skipped.` });
      if (!name) return errors.push({ line, message: `${rawId}: missing name.` });
      const clash = badgeClash();
      if (clash) return errors.push({ line, message: clash });
      seen.add(rawId);
      if (badge) seen.add(badge);
      records.push({ id: rawId, name, badgeId: badge });
      return;
    }

    const t = typeOf(cell(r, idx.assetType));
    if (!t) return errors.push({ line, message: `${rawId || "Row"}: missing asset type (add an assetType column or choose a default).` });
    if (!t.info) return errors.push({ line, message: `${rawId || "Row"}: there is no asset type “${t.name}”. Add it under Assets → Asset types first, or fix the spelling — skipped.` });
    const assetType = t.info.name;
    const rec = { assetType, model: cell(r, idx.model), imei: cell(r, idx.imei), serial: cell(r, idx.serial), phoneNumber: cell(r, idx.phoneNumber) };

    if (!rawId) {
      const dup = dupMessage(rec, "");
      if (dup) return errors.push({ line, message: dup });
      if (!prefixFor(assetType)) return errors.push({ line, message: `${assetType} has no ID letters, so this row needs an assetId.` });
      claim(rec, "(an earlier row in this file)");
      pending.push({ line, rec });
      return;
    }
    if (!validId(rawId)) return errors.push({ line, message: BAD_ID(rawId) });
    if (existingIds.has(rawId)) return errors.push({ line, message: `${rawId} already exists — skipped.` });
    if (seen.has(rawId)) return errors.push({ line, message: `${rawId} appears twice in the file — skipped.` });
    const dup = dupMessage(rec, rawId);
    if (dup) return errors.push({ line, message: dup });
    seen.add(rawId);
    claim(rec, rawId);
    records.push({ id: rawId, ...rec });
  });

  // Pass 2: number the rows with no ID, in file order, using the lowest free number for the type's letters
  for (const { rec } of pending) {
    const id = lowestFreeIdFor(prefixFor(rec.assetType), padFor(rec.assetType), [...existingIds, ...seen]);
    seen.add(id);
    records.push({ id, ...rec });
  }

  return { records, updates, errors, newTypes: [] };
}

/**
 * Admin / station-login sheet: email, name, optional role ("admin" or "station"; default admin),
 * plus employeeId (required for admins, they are added to staff too) and optional badgeId.
 * existingEmails : Set<string> lower-case emails that already have an admin or station record
 * existingIds    : Set<string> every asset id, staff id and badge number already in use
 * existingStaff  : Set<string> employee IDs that already exist as staff (an admin may be linked to one)
 * linkedStaff    : Set<string> employee IDs already linked to another admin
 * returns records: {email, name, role, employeeId, badgeId, newStaff}
 */
export function parseAdminImport(rows, { existingEmails = new Set(), existingIds = new Set(), existingStaff = new Set(), linkedStaff = new Set() } = {}) {
  const errors = [];
  if (!rows.length) return { records: [], errors, fatal: "Nothing to import." };
  const header = rows[0].map(key);
  const idx = Object.fromEntries(Object.entries(COLS.admin).map(([f, names]) => [f, findCol(header, names)]));
  if (idx.email === -1) return { records: [], errors, fatal: "Couldn't find an email column. Name it “email”." };

  const seen = new Set();
  const claimed = new Set();   // employee IDs and badge numbers used by earlier rows in this file
  const records = [];
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const email = cellOf(r, idx.email).toLowerCase();
    const name = cellOf(r, idx.name);
    const roleRaw = cellOf(r, idx.role).toLowerCase();
    if (!email) return errors.push({ line, message: "Missing email." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errors.push({ line, message: `“${email}” doesn't look like an email address.` });
    if (existingEmails.has(email)) return errors.push({ line, message: `${email} already has a login — skipped.` });
    if (seen.has(email)) return errors.push({ line, message: `${email} appears twice in the file — skipped.` });
    let role = "admin";
    if (roleRaw) {
      if (/^(station|scan|scanner|kiosk)/.test(roleRaw)) role = "station";
      else if (/^(admin|administrator)/.test(roleRaw)) role = "admin";
      else return errors.push({ line, message: `${email}: role “${roleRaw}” isn't recognised. Use admin or station.` });
    }
    if (!name) return errors.push({ line, message: `${email}: missing name.` });

    let employeeId = "", badgeId = "", newStaff = false;
    if (role === "admin") {
      employeeId = norm(cellOf(r, idx.employeeId));
      badgeId = norm(cellOf(r, idx.badge));
      if (!employeeId) return errors.push({ line, message: `${email}: admins need an employeeId so they're added to staff too — skipped.` });
      if (!validId(employeeId)) return errors.push({ line, message: `${email}: employee ID ${BAD_ID(employeeId)}` });
      if (linkedStaff.has(employeeId)) return errors.push({ line, message: `${email}: employee ID ${employeeId} already belongs to another admin — skipped.` });
      if (claimed.has(employeeId)) return errors.push({ line, message: `${email}: employee ID ${employeeId} appears twice in the file — skipped.` });
      newStaff = !existingStaff.has(employeeId);
      if (newStaff && existingIds.has(employeeId)) return errors.push({ line, message: `${email}: “${employeeId}” is already used by something else — skipped.` });
      if (badgeId) {
        if (!validId(badgeId)) return errors.push({ line, message: `${email}: badge number ${BAD_ID(badgeId)}` });
        if (badgeId === employeeId) return errors.push({ line, message: `${email}: the badge number is the same as the employee ID. Leave it blank if the badge shows the employee ID.` });
        if (existingIds.has(badgeId) || claimed.has(badgeId)) return errors.push({ line, message: `${email}: badge number ${badgeId} is already in use — skipped.` });
        if (!newStaff) badgeId = ""; // an existing person keeps the badge they already have
      }
      claimed.add(employeeId);
      if (badgeId) claimed.add(badgeId);
    }
    seen.add(email);
    records.push({ email, name, role, employeeId, badgeId, newStaff });
  });
  return { records, errors };
}

/** Blank-template definitions for the "Download template" buttons: header row + a notes sheet. */
export const TEMPLATES = {
  staff: {
    file: "staff-template",
    headers: ["employeeId", "badgeId", "name"],
    notes: [
      ["Staff import: how to fill this in"],
      ["employeeId", "Required. The employee ID. Letters, numbers, dot, dash or underscore only."],
      ["badgeId", "Optional. The number the ID badge barcode reads (usually the employee ID plus a few digits). Leave blank if the badge shows the employee ID."],
      ["name", "Required for new people. You can use firstName and lastName columns instead."],
      [""],
      ["If an employeeId already exists and you give a badgeId, that person's badge number is filled in. Nothing else about them changes."],
      ["Format the ID columns as Text so leading zeros are kept. Only the first sheet is imported."],
    ],
  },
  asset: {
    file: "assets-template",
    headers: ["assetType", "model", "imei", "serial", "phoneNumber", "assetId"],
    notes: [
      ["Asset import: how to fill this in"],
      ["assetType", "Required. Must match a type you've already added under Assets → Asset types (for example Rover phone, iPad or Fob). Rows with an unknown type are skipped."],
      ["model, imei, serial, phoneNumber", "All optional. Leave them blank for simple items like fobs."],
      ["assetId", "Leave this blank. Each device is numbered for you from its type's ID letters, using the lowest free number (R001, R002, R003…). Only fill it in to choose a specific barcode, or for a type that has no ID letters."],
      [""],
      ["IDs that already exist are skipped. Format the ID columns as Text so leading zeros are kept. Only the first sheet is imported."],
    ],
  },
  admin: {
    file: "admins-template",
    headers: ["email", "name", "role", "employeeId", "badgeId"],
    notes: [
      ["Admin import: how to fill this in"],
      ["email", "Required. Each person is emailed a link to set their own password."],
      ["name", "Required. A person's name, or a label for a station login such as Dispatch desk."],
      ["role", "Optional. admin (full access) or station (scan screen only). Blank means admin."],
      ["employeeId", "Required for admins. They are added to your staff list under this ID so they can check devices out too. Leave blank for station logins."],
      ["badgeId", "Optional, admins only. The number their badge barcode reads."],
      [""],
      ["Emails that already have a login are skipped. Only the first sheet is imported."],
    ],
  },
};
