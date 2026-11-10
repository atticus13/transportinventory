// Pure CSV-import parsing (no Firebase) — unit tested in tests/.
import { norm, validId, derivePrefix, nextIdFor } from "./util.js";

const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const COLS = {
  staff: {
    id: ["employeeid", "empid", "id", "badge", "badgeid", "employeenumber"],
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
};

const findCol = (header, names) => {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
};

/**
 * rows         : array of arrays (first row = header)
 * existingIds  : Set<string> of every ID already used by an asset OR a staff member
 * knownTypes   : [{name, prefix}] existing asset types
 * defaultType  : asset type name for rows that don't specify one
 * returns      : {records, errors:[{line,message}], newTypes:[name], fatal?:string}
 */
export function parseImport(kind, rows, { existingIds = new Set(), pad = 3, knownTypes = [], defaultType = "" } = {}) {
  const errors = [];
  if (!rows.length) return { records: [], errors, newTypes: [], fatal: "Nothing to import." };

  const header = rows[0].map(key);
  const spec = COLS[kind];
  const idx = Object.fromEntries(Object.entries(spec).map(([f, names]) => [f, findCol(header, names)]));

  if (kind === "staff") {
    if (idx.id === -1) return { records: [], errors, newTypes: [], fatal: "Couldn't find an employee ID column. Name it “employeeId”." };
    if (idx.name === -1 && (idx.first === -1 || idx.last === -1))
      return { records: [], errors, newTypes: [], fatal: "Couldn't find a name column. Use “name”, or “firstName” and “lastName”." };
  } else if (Object.values(idx).every((i) => i === -1)) {
    return { records: [], errors, newTypes: [], fatal: "Couldn't recognise any columns. Use: assetId, assetType, model, imei, serial, phoneNumber." };
  }

  const cell = (r, i) => (i === -1 ? "" : (r[i] ?? "").trim());
  const seen = new Set();
  const records = [];
  const pending = []; // asset rows needing an auto ID

  const known = new Map(knownTypes.map((t) => [t.name.toLowerCase(), t]));
  const newTypes = new Map(); // lower → name as typed
  const canonicalType = (raw) => {
    const name = (raw || defaultType || "").trim();
    if (!name) return "";
    const k = name.toLowerCase();
    if (known.has(k)) return known.get(k).name;
    if (!newTypes.has(k)) newTypes.set(k, name);
    return newTypes.get(k);
  };
  const prefixFor = (name) => known.get(name.toLowerCase())?.prefix || derivePrefix(name);

  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const rawId = norm(cell(r, idx.id));

    if (kind === "staff") {
      const name = idx.name !== -1 ? cell(r, idx.name) : `${cell(r, idx.first)} ${cell(r, idx.last)}`.trim();
      if (!rawId) return errors.push({ line, message: "Missing employee ID." });
      if (!validId(rawId)) return errors.push({ line, message: `“${rawId}” has characters we can't use (letters, numbers, . - _ only).` });
      if (!name) return errors.push({ line, message: `${rawId}: missing name.` });
      if (existingIds.has(rawId)) return errors.push({ line, message: `${rawId} already exists — skipped.` });
      if (seen.has(rawId)) return errors.push({ line, message: `${rawId} appears twice in the file — skipped.` });
      seen.add(rawId);
      records.push({ id: rawId, name });
      return;
    }

    const assetType = canonicalType(cell(r, idx.assetType));
    if (!assetType) return errors.push({ line, message: `${rawId || "Row"}: missing asset type (add an assetType column or choose a default).` });
    const rec = { assetType, model: cell(r, idx.model), imei: cell(r, idx.imei), serial: cell(r, idx.serial), phoneNumber: cell(r, idx.phoneNumber) };

    if (!rawId) { pending.push({ line, rec }); return; }
    if (!validId(rawId)) return errors.push({ line, message: `“${rawId}” has characters we can't use (letters, numbers, . - _ only).` });
    if (existingIds.has(rawId)) return errors.push({ line, message: `${rawId} already exists — skipped.` });
    if (seen.has(rawId)) return errors.push({ line, message: `${rawId} appears twice in the file — skipped.` });
    seen.add(rawId);
    records.push({ id: rawId, ...rec });
  });

  // Pass 2: auto-number blank asset IDs, per type prefix, after the highest existing/explicit number
  for (const { rec } of pending) {
    const id = nextIdFor(prefixFor(rec.assetType), pad, [...existingIds, ...seen]);
    seen.add(id);
    records.push({ id, ...rec });
  }

  // Only report new types that are actually used by a kept record
  const used = new Set(records.map((r) => r.assetType?.toLowerCase()));
  return { records, errors, newTypes: [...newTypes.entries()].filter(([k]) => used.has(k)).map(([, v]) => v) };
}
