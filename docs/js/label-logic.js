// Pure helpers for the label designer (no DOM, no Firebase) so they can be unit-tested.

export const ASSET_FIELDS = [
  { key: "category", label: "Asset type" },
  { key: "model", label: "Model" },
  { key: "phoneNumber", label: "Phone number" },
  { key: "imei", label: "IMEI" },
  { key: "serial", label: "Serial number" },
  { key: "id", label: "Asset ID (as text)" },
  { key: "custom", label: "Custom text" },
];
export const STAFF_FIELDS = [
  { key: "name", label: "Name" },
  { key: "id", label: "Employee ID (as text)" },
  { key: "custom", label: "Custom text" },
];
export const fieldsFor = (kind) => (kind === "staff" ? STAFF_FIELDS : ASSET_FIELDS);

export const SIZES = [
  { key: "2.25x1.25", label: "2.25 × 1.25 in (common Zebra / Brother roll)", w: 2.25, h: 1.25 },
  { key: "2x1", label: "2 × 1 in", w: 2, h: 1 },
  { key: "2.125x1", label: "2.125 × 1 in (Dymo 30336)", w: 2.125, h: 1 },
  { key: "3x1", label: "3 × 1 in", w: 3, h: 1 },
  { key: "4x2", label: "4 × 2 in", w: 4, h: 2 },
  { key: "custom", label: "Custom size…", w: 0, h: 0 },
];

export const TEXT_SIZES = ["sm", "md", "lg"];
export const BARCODE_SIZES = ["sm", "md", "lg"];
export const MAX_LINES = 6;

export const defaultConfig = (kind) => ({
  size: "2.25x1.25", customW: 2.25, customH: 1.25, sheet: false,
  header: "", footer: "", showText: true, barcodeSize: "md",
  lines: kind === "staff" ? [{ field: "name", text: "", size: "lg", bold: true }] : [],
});

const L = (field, text = "", size = "md", bold = false) => ({ field, text, size, bold });
const base = (kind, over) => ({ ...defaultConfig(kind), ...over });

export const PRESETS = {
  asset: [
    { id: "asset-simple", name: "Barcode only", config: base("asset", { lines: [] }) },
    { id: "asset-phone", name: "Barcode + phone number", config: base("asset", { lines: [L("phoneNumber", "Phone: ")] }) },
    { id: "asset-type-model", name: "Barcode + type & model", config: base("asset", { lines: [L("category", "", "md", true), L("model")] }) },
    { id: "asset-full", name: "Type, model & phone number", config: base("asset", { lines: [L("category", "", "md", true), L("model"), L("phoneNumber", "Phone: ")] }) },
    { id: "asset-owner", name: "Barcode + “Property of” footer", config: base("asset", { lines: [L("category", "", "md", true)], footer: "Property of Patient Transport" }) },
  ],
  staff: [
    { id: "staff-badge", name: "Barcode + name", config: base("staff", {}) },
    { id: "staff-simple", name: "Barcode only", config: base("staff", { lines: [] }) },
  ],
};

const clamp = (n, lo, hi, dflt) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const text = (v, max = 60) => String(v ?? "").slice(0, max);

/** Turn anything (saved doc, old version, junk) into a complete, safe config. */
export function sanitizeConfig(kind, raw) {
  const d = defaultConfig(kind);
  const r = raw && typeof raw === "object" ? raw : {};
  const keys = fieldsFor(kind).map((f) => f.key);
  const lines = (Array.isArray(r.lines) ? r.lines : [])
    .filter((l) => l && keys.includes(l.field))
    .slice(0, MAX_LINES)
    .map((l) => ({
      field: l.field, text: text(l.text),
      size: TEXT_SIZES.includes(l.size) ? l.size : "md", bold: !!l.bold,
    }));
  return {
    size: SIZES.some((s) => s.key === r.size) ? r.size : d.size,
    customW: clamp(r.customW, 0.75, 8, d.customW),
    customH: clamp(r.customH, 0.5, 10, d.customH),
    sheet: !!r.sheet,
    header: text(r.header), footer: text(r.footer),
    showText: r.showText !== false,
    barcodeSize: BARCODE_SIZES.includes(r.barcodeSize) ? r.barcodeSize : d.barcodeSize,
    lines: r.lines === undefined ? d.lines : lines,
  };
}

export function sizeOf(cfg) {
  if (cfg.size === "custom") return { w: cfg.customW, h: cfg.customH };
  const s = SIZES.find((x) => x.key === cfg.size) || SIZES[0];
  return { w: s.w, h: s.h };
}

/** The text for one line of one item. Empty string = skip this line. */
export function lineValue(item, line) {
  if (line.field === "custom") return line.text || "";
  const v = String(item?.[line.field] ?? "").trim();
  return v ? `${line.text || ""}${v}` : "";
}

export const configsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Read the IDs to print from a stored queue or URL params. */
export function readQueue(params, stored) {
  const kind = (k) => (k === "staff" ? "staff" : "asset");
  if (params.get("queue") && stored) {
    try {
      const q = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (q && Array.isArray(q.ids)) return { kind: kind(q.kind), ids: q.ids.map(String), all: false };
    } catch { /* fall through */ }
  }
  const raw = (params.get("ids") || "").trim();
  return { kind: kind(params.get("kind")), ids: raw === "*" ? [] : raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), all: raw === "*" };
}
