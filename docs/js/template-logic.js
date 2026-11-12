// Builds the downloadable Excel templates (pure: the ExcelJS library is passed in, so this is testable in Node).
// The asset template gets a drop-down of the device types that exist right now, and an Instructions sheet.
import { TEMPLATES } from "./import-logic.js";

const FIELD_LABEL = { model: "Model", phoneNumber: "Phone number", imei: "IMEI", serial: "Serial number" };
const ORANGE = "FFFF4C00";

/** Instruction rows for a template: [[text]] or [[label, text]]. `types` = [{name, prefix, fields}] (asset template only). */
export function templateNotes(kind, types = []) {
  if (kind !== "asset") return TEMPLATES[kind].notes;
  const rows = [
    ["Asset import: how to fill this in"],
    [""],
    ["Before you start", "The assetType column is a drop-down of the device types that exist right now. If you have a NEW device type, add it first (admin portal → Assets → Asset types), then download this template again so the drop-down includes it. A row with a type that doesn't exist is skipped."],
    ["Barcode numbers / asset IDs", "These are generated automatically. Don't enter them. When you import, each device is given its barcode number (its asset ID) from its type's ID letters and the lowest free number: R001, R002, R003…"],
    ["assetType", "Required. Pick it from the drop-down."],
    ["model, imei, serial, phoneNumber", "Required only if the device type is set up with that field (see the table below). Types that don't use a field can leave it blank, like a fob."],
    ["Duplicates", "A row is skipped if its IMEI, serial number or phone number is already on another device."],
    ["Special case", "A device type with no ID letters can't be numbered automatically. For those only, add a column named assetId and type the barcode for each row."],
    [""],
    ["Your device types right now"],
  ];
  if (!types.length) {
    rows.push(["", "There are no device types yet. Add one under Assets → Asset types, then download this template again."]);
  } else {
    rows.push(["Type · ID letters", "Required fields · first barcode"]);
    for (const t of types) {
      const req = (t.fields || []).map((f) => FIELD_LABEL[f] || f).join(", ") || "none";
      rows.push([`${t.name} · ${t.prefix || "(none)"}`, `${req} · ${t.prefix ? `${t.prefix}001` : "type each one in an assetId column"}`]);
    }
  }
  rows.push([""], ["Only the first sheet (Import) is read. Format is already set to Text so leading zeros are kept."]);
  return rows;
}

/** → Promise<ArrayBuffer|Buffer> of an .xlsx: sheets "Import", "Instructions" and (asset only) "Device types". */
export async function buildTemplateXlsx(ExcelJS, kind, { types = [] } = {}) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error("Unknown template.");
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet("Import", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = t.headers.map((h) => ({ header: h, key: h, width: Math.max(16, h.length + 6), style: { numFmt: "@" } }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
  const col = (name) => t.headers.indexOf(name) + 1;
  const range = (c) => `${String.fromCharCode(64 + c)}2:${String.fromCharCode(64 + c)}2000`;
  const addList = (name, formulae, prompt, error) => {
    const c = col(name);
    if (!c) return;
    for (let r = 2; r <= 2000; r++) {
      ws.getCell(r, c).dataValidation = { type: "list", allowBlank: true, formulae, showErrorMessage: true, errorStyle: "stop", errorTitle: "Not on the list", error, showInputMessage: !!prompt, promptTitle: name, prompt };
    }
  };

  if (kind === "asset" && types.length) {
    const list = wb.addWorksheet("Device types");
    list.columns = [{ header: "Device types that exist now", key: "n", width: 34 }];
    list.getRow(1).font = { bold: true };
    types.forEach((x) => list.addRow({ n: x.name }));
    addList("assetType", [`'Device types'!$A$2:$A$${types.length + 1}`], "Pick a device type from the list.", "Pick a device type from the list. If it's a new type, add it under Assets → Asset types first, then download this template again.");
  }
  if (kind === "admin") addList("role", ['"admin,station"'], "admin = full access, station = scan screen only", "Use admin or station.");

  const notes = wb.addWorksheet("Instructions");
  notes.columns = [{ width: 34 }, { width: 100 }];
  const rows = templateNotes(kind, types);
  rows.forEach((r) => notes.addRow(r));
  notes.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell(1).font = { bold: true };
  });
  notes.getRow(1).font = { bold: true, size: 14 };
  if (kind === "asset") {
    // wb sheet order: Import, Device types?, Instructions. Put Instructions second.
    wb.views = [{ activeTab: 0 }];
  }
  return wb.xlsx.writeBuffer();
}
