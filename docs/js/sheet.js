// Reads an uploaded spreadsheet (.xlsx / .xls / .csv / .tsv / .txt) into rows of text.
// Excel files are read in the browser with SheetJS, loaded only when one is chosen.
import { parseCSV, toCSV, downloadFile } from "./util.js";
import { TEMPLATES } from "./import-logic.js";
import { buildTemplateXlsx } from "./template-logic.js";

const SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
// Only used to WRITE the template (it can add drop-downs); reading uploads uses SheetJS above.
const EXCELJS = ["https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js", "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"];
let loading = null;
let loadingXl = null;

function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  loadingXl ??= (async () => {
    for (const src of EXCELJS) {
      try {
        await new Promise((resolve, reject) => {
          const s = Object.assign(document.createElement("script"), { src, async: true });
          s.onload = resolve; s.onerror = () => { s.remove(); reject(new Error("load failed")); };
          document.head.appendChild(s);
        });
        if (window.ExcelJS) return window.ExcelJS;
      } catch { /* try the next source */ }
    }
    loadingXl = null;
    throw new Error("Couldn't load the Excel writer (check the internet connection).");
  })();
  return loadingXl;
}

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  loading ??= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src: SHEETJS, async: true });
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("The Excel reader didn't load.")));
    s.onerror = () => { loading = null; reject(new Error("Couldn't load the Excel reader (check the internet connection). You can also save the sheet as CSV.")); };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * One worksheet → rows of text. Uses the text Excel shows (so 00456 keeps its zeros), except that a long
 * number Excel would show as 1.23457E+11 is written out in full (badge numbers can be 10+ digits).
 */
export function sheetToRows(XLSX, ws) {
  if (!ws || !ws["!ref"]) return [];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      let text = "";
      if (cell) {
        text = String(cell.w ?? cell.v ?? "");
        if (cell.t === "n" && /e/i.test(text) && Number.isFinite(cell.v)) text = Number.isInteger(cell.v) ? BigInt(cell.v).toString() : String(cell.v);
      }
      row.push(text.trim());
    }
    if (row.some((x) => x !== "")) rows.push(row);
  }
  return rows;
}

/** → { rows: string[][], sheet: string|null }  (first row is the header) */
export async function readSpreadsheet(file) {
  const name = (file.name || "").toLowerCase();
  if (/\.(xlsx|xlsm|xls)$/.test(name)) {
    const XLSX = await loadSheetJS();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    const sheet = wb.SheetNames[0];
    if (!sheet) throw new Error("That workbook has no sheets.");
    return { rows: sheetToRows(XLSX, wb.Sheets[sheet]), sheet };
  }
  return { rows: parseCSV(await file.text()), sheet: null };
}

/** Download a blank template for "staff", "asset" or "admin" as .xlsx (drop-downs + an Instructions sheet) or .csv.
 *  `types` ([{name, prefix, fields}], asset only) fills the device-type drop-down and the instructions. */
export async function downloadTemplate(kind, format = "xlsx", { types = [] } = {}) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error("Unknown template.");
  if (format === "csv") return downloadFile(`${t.file}.csv`, toCSV(t.headers, []));
  const ExcelJS = await loadExcelJS();
  const bytes = await buildTemplateXlsx(ExcelJS, kind, { types });
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${t.file}.xlsx` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
