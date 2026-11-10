export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Normalise anything typed or scanned: trim + uppercase. */
export const norm = (s) => String(s ?? "").trim().toUpperCase();

/** IDs become Firestore document IDs, so keep them simple and safe. */
export const validId = (s) => /^[A-Z0-9][A-Z0-9._\-]{0,39}$/.test(s);

export const toDate = (v) => (v?.toDate ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null);

export function fmtDT(v) {
  const d = toDate(v);
  return d ? d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "…";
}
export function fmtTime(v) {
  const d = toDate(v);
  return d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "…";
}
export function fmtFull(v) {
  const d = toDate(v);
  return d ? d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "";
}

export function fmtDur(min) {
  if (min == null || isNaN(min)) return "—";
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const ymd = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** "2026-11-01","2026-11-10" → {from: local midnight, to: local midnight of next day (exclusive)} */
export function rangeFromInputs(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  return { from: new Date(fy, fm - 1, fd, 0, 0, 0, 0), to: new Date(ty, tm - 1, td + 1, 0, 0, 0, 0) };
}

export function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCSV = (headers, rows) =>
  [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

export function downloadFile(name, text, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Small CSV/TSV parser (quotes, CRLF, comma or tab delimited). */
export function parseCSV(text) {
  text = String(text ?? "").replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delim = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

export function toast(msg, kind = "info", ms = 3500) {
  let box = document.getElementById("toasts");
  if (!box) { box = Object.assign(document.createElement("div"), { id: "toasts" }); document.body.appendChild(box); }
  const t = Object.assign(document.createElement("div"), { className: `toast ${kind}`, textContent: msg });
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Beeps via WebAudio (no files needed). */
let _ac;
export function beep(kind) {
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
    const seqs = {
      out: [[660, 0.09], [880, 0.12]],
      in: [[880, 0.09], [660, 0.12]],
      ok: [[740, 0.1]],
      error: [[220, 0.22], [180, 0.28]],
    };
    let t = _ac.currentTime;
    for (const [f, d] of seqs[kind] || []) {
      const o = _ac.createOscillator(), g = _ac.createGain();
      o.type = kind === "error" ? "sawtooth" : "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(_ac.destination);
      o.start(t); o.stop(t + d + 0.02);
      t += d + 0.03;
    }
  } catch { /* audio is optional */ }
}

// ───────── asset-type helpers ─────────
export const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "iPad" → "iPad" doc id "ipad"; used as the document id for asset types. */
export const slugify = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Default barcode ID prefix for a type name: "Phone" → "PH-", "iPad" → "IP-". */
export function derivePrefix(name) {
  const letters = String(name ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return (letters.slice(0, 2) || "AS") + "-";
}

/** Next sequential ID for a prefix, e.g. ("PH-", 3, ["PH-001","PH-004"]) → "PH-005". */
export function nextIdFor(prefix, pad, ids) {
  const re = new RegExp("^" + escRe(prefix) + "(\\d+)$");
  let max = 0;
  for (const id of ids) { const m = re.exec(id); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return prefix + String(max + 1).padStart(pad, "0");
}
