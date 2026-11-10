import { auth, db, A, F, configured } from "./fb.js";
import { $, esc, slugify } from "./util.js";
import { loadAdmin, commitAudited } from "./audit.js";
import { fieldsFor, SIZES, PRESETS, MAX_LINES, defaultConfig, sanitizeConfig, sizeOf, lineValue, configsEqual, readQueue } from "./label-logic.js";

const q = readQueue(new URLSearchParams(location.search), (() => { try { return localStorage.getItem("print-queue"); } catch { return null; } })());
const kind = q.kind;

let me = null;
let items = [];
let missingCount = 0;
let cfg = defaultConfig(kind);
let saved = []; // saved (active) templates for this kind: {id, name, config}
let allSavedIds = new Set(); // includes archived, to avoid id clashes
let current = null; // {type:'preset'|'saved', id, name, config}
let archiveArmed = null;

const lastKey = "label-last-" + kind;
const store = {
  get: () => { try { return localStorage.getItem(lastKey); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(lastKey, v); } catch { /* ignore */ } },
};

// ───────────────────────── loading ─────────────────────────
async function loadItems() {
  const snap = await F.getDocs(F.collection(db, kind === "staff" ? "staff" : "assets"));
  const byId = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const nat = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  if (q.all) return { found: [...byId.values()].filter((x) => x.active !== false).sort(nat), missing: 0 };
  const found = [], seen = new Set();
  let missing = 0;
  for (const id of q.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    byId.has(id) ? found.push(byId.get(id)) : missing++;
  }
  return { found, missing };
}

async function loadTemplates() {
  const snap = await F.getDocs(F.collection(db, "labelTemplates"));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.kind === kind);
  allSavedIds = new Set(snap.docs.map((d) => d.id));
  saved = rows.filter((t) => t.active !== false)
    .map((t) => ({ id: t.id, name: t.name || t.id, config: sanitizeConfig(kind, t.config) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ───────────────────────── template picker ─────────────────────────
const presets = () => PRESETS[kind].map((p) => ({ type: "preset", id: p.id, name: p.name, config: sanitizeConfig(kind, p.config) }));
const savedTpls = () => saved.map((t) => ({ type: "saved", ...t }));
const findTpl = (value) => [...presets(), ...savedTpls()].find((t) => `${t.type}:${t.id}` === value);
const dirty = () => !current || !configsEqual(cfg, current.config);

function drawTplSelect() {
  const sel = $("#tplSelect");
  const d = dirty();
  sel.innerHTML =
    (d ? `<option value="__custom__" selected>${current ? `${esc(current.name)} (modified)` : "Custom (unsaved)"}</option>` : "") +
    `<optgroup label="Built-in">${presets().map((t) => `<option value="preset:${esc(t.id)}">${esc(t.name)}</option>`).join("")}</optgroup>` +
    (saved.length ? `<optgroup label="Saved templates">${savedTpls().map((t) => `<option value="saved:${esc(t.id)}">${esc(t.name)}</option>`).join("")}</optgroup>` : "");
  if (!d) sel.value = `${current.type}:${current.id}`;
  const isSaved = current?.type === "saved";
  $("#tplUpdate").classList.toggle("hidden", !(isSaved && d));
  $("#tplUpdate").textContent = isSaved ? `Update “${current.name}”` : "Update";
  $("#tplArchive").classList.toggle("hidden", !isSaved);
  if (!isSaved || archiveArmed !== current?.id) $("#tplArchive").textContent = "Archive";
}

function chooseTemplate(value) {
  const t = findTpl(value);
  if (!t) return;
  current = t;
  cfg = sanitizeConfig(kind, t.config);
  store.set(value);
  $("#tplErr").textContent = "";
  syncControls();
  drawLines();
  refresh();
}

$("#tplSelect").addEventListener("change", (e) => { if (e.target.value !== "__custom__") chooseTemplate(e.target.value); });

const tplOp = (action, id, name, data, before, after, mode) => ({
  ref: F.doc(db, "labelTemplates", id), mode, data,
  audit: { action, targetType: "labelTemplate", targetId: id, summary: `${action.split(".")[1][0].toUpperCase()}${action.split(".")[1].slice(1)} label template “${name}”`, before, after },
});

async function guard(fn) {
  $("#tplErr").textContent = "";
  try { await fn(); } catch (e) {
    console.error(e);
    $("#tplErr").textContent = e?.code === "permission-denied" ? "Not allowed. Is your admin account still active?" : e?.message || String(e);
  }
}

$("#tplSaveNew").addEventListener("click", () => guard(async () => {
  const name = $("#tplName").value.trim();
  if (!name) throw new Error("Type a name for the template first.");
  const id = `${kind}-${slugify(name)}`;
  if (!slugify(name)) throw new Error("Use letters or numbers in the name.");
  if (allSavedIds.has(id)) throw new Error(`A template named “${name}” already exists. Pick another name, or select it and use Update.`);
  const config = sanitizeConfig(kind, cfg);
  await commitAudited(me, [tplOp("labelTemplate.create", id, name,
    { name, kind, config, active: true, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() }, null, config, "set")]);
  await loadTemplates();
  $("#tplName").value = "";
  chooseTemplate(`saved:${id}`);
}));

$("#tplUpdate").addEventListener("click", () => guard(async () => {
  if (current?.type !== "saved") return;
  const config = sanitizeConfig(kind, cfg);
  await commitAudited(me, [tplOp("labelTemplate.update", current.id, current.name,
    { config, updatedAt: F.serverTimestamp() }, current.config, config, "update")]);
  const id = current.id;
  await loadTemplates();
  chooseTemplate(`saved:${id}`);
}));

$("#tplArchive").addEventListener("click", () => guard(async () => {
  if (current?.type !== "saved") return;
  if (archiveArmed !== current.id) {
    archiveArmed = current.id;
    $("#tplArchive").textContent = "Click again to confirm";
    setTimeout(() => { if (archiveArmed === current?.id) { archiveArmed = null; drawTplSelect(); } }, 3500);
    return;
  }
  archiveArmed = null;
  await commitAudited(me, [tplOp("labelTemplate.archive", current.id, current.name, { active: false, updatedAt: F.serverTimestamp() }, { active: true }, { active: false }, "update")]);
  await loadTemplates();
  chooseTemplate(`preset:${PRESETS[kind][0].id}`);
}));

// ───────────────────────── controls ─────────────────────────
function initControls() {
  $("#size").innerHTML = SIZES.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join("");
  for (const id of ["size", "cW", "cH", "sheet", "bcSize", "showText", "header", "footer"]) {
    $("#" + id).addEventListener("input", readControls);
    $("#" + id).addEventListener("change", readControls);
  }
  $("#addLine").addEventListener("click", () => {
    if (cfg.lines.length >= MAX_LINES) return;
    cfg.lines.push({ field: fieldsFor(kind).find((f) => !cfg.lines.some((l) => l.field === f.key))?.key || "custom", text: "", size: "md", bold: false });
    drawLines();
    refresh();
  });
  $("#lines").addEventListener("input", onLineEdit);
  $("#lines").addEventListener("change", onLineEdit);
  $("#lines").addEventListener("click", onLineClick);
}

function syncControls() {
  $("#size").value = cfg.size;
  $("#customSize").classList.toggle("hidden", cfg.size !== "custom");
  $("#cW").value = cfg.customW;
  $("#cH").value = cfg.customH;
  $("#sheet").checked = cfg.sheet;
  $("#bcSize").value = cfg.barcodeSize;
  $("#showText").checked = cfg.showText;
  $("#header").value = cfg.header;
  $("#footer").value = cfg.footer;
}

function readControls() {
  cfg = sanitizeConfig(kind, {
    ...cfg, size: $("#size").value, customW: $("#cW").value, customH: $("#cH").value, sheet: $("#sheet").checked,
    barcodeSize: $("#bcSize").value, showText: $("#showText").checked, header: $("#header").value, footer: $("#footer").value,
  });
  $("#customSize").classList.toggle("hidden", cfg.size !== "custom");
  refresh();
}

function drawLines() {
  const fields = fieldsFor(kind);
  $("#lines").innerHTML = cfg.lines.length
    ? cfg.lines.map((l, i) => `<div class="line" data-i="${i}">
        <label class="f">Show<select data-k="field">${fields.map((f) => `<option value="${f.key}" ${f.key === l.field ? "selected" : ""}>${esc(f.label)}</option>`).join("")}</select></label>
        <label class="f">${l.field === "custom" ? "Text" : "Prefix (optional)"}<input type="text" data-k="text" maxlength="60" value="${esc(l.text)}" placeholder="${l.field === "custom" ? "e.g. Return to dispatch" : "e.g. Phone: "}" /></label>
        <div class="tools">
          <select data-k="size" style="width:auto"><option value="sm" ${l.size === "sm" ? "selected" : ""}>Small</option><option value="md" ${l.size === "md" ? "selected" : ""}>Medium</option><option value="lg" ${l.size === "lg" ? "selected" : ""}>Large</option></select>
          <label><input type="checkbox" data-k="bold" ${l.bold ? "checked" : ""} /> Bold</label>
          <span style="flex:1"></span>
          <button class="btn sm" data-a="up" ${i === 0 ? "disabled" : ""} title="Move up">↑</button>
          <button class="btn sm" data-a="down" ${i === cfg.lines.length - 1 ? "disabled" : ""} title="Move down">↓</button>
          <button class="btn sm danger" data-a="del" title="Remove">✕</button>
        </div></div>`).join("")
    : '<div class="muted" style="font-size:13px">No extra lines. Add one to print a field (like the phone number) under the barcode.</div>';
  $("#addLine").disabled = cfg.lines.length >= MAX_LINES;
  $("#lineHint").textContent = cfg.lines.length >= MAX_LINES ? `Up to ${MAX_LINES} lines` : "";
}

function onLineEdit(e) {
  const k = e.target.dataset.k;
  if (!k) return;
  const i = +e.target.closest(".line").dataset.i;
  const line = cfg.lines[i];
  line[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  cfg = sanitizeConfig(kind, cfg);
  if (k === "field" && e.type === "change") drawLines(); // placeholder text depends on field
  refresh();
}

function onLineClick(e) {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const i = +b.closest(".line").dataset.i;
  const a = b.dataset.a;
  if (a === "del") cfg.lines.splice(i, 1);
  if (a === "up" && i > 0) [cfg.lines[i - 1], cfg.lines[i]] = [cfg.lines[i], cfg.lines[i - 1]];
  if (a === "down" && i < cfg.lines.length - 1) [cfg.lines[i + 1], cfg.lines[i]] = [cfg.lines[i], cfg.lines[i + 1]];
  drawLines();
  refresh();
}

// ───────────────────────── preview ─────────────────────────
function labelHTML(it, i) {
  const lines = cfg.lines.map((l) => ({ l, v: lineValue(it, l) })).filter((x) => x.v);
  return `<div class="label">
    ${cfg.header ? `<div class="hf">${esc(cfg.header)}</div>` : ""}
    <svg id="bc${i}" class="bc-${cfg.barcodeSize}"></svg>
    ${lines.map(({ l, v }) => `<div class="t ${l.size}${l.bold ? " b" : ""}">${esc(v)}</div>`).join("")}
    ${cfg.footer ? `<div class="ft">${esc(cfg.footer)}</div>` : ""}
  </div>`;
}

function refresh() {
  drawTplSelect();
  const out = $("#out");
  const { w, h } = sizeOf(cfg);

  $("#pageStyle").textContent = cfg.sheet ? "@page { size: letter; margin: 0.5in; }" : `@page { size: ${w}in ${h}in; margin: 0; }`;
  out.className = "sheet " + (cfg.sheet ? "grid" : "roll");
  out.style.setProperty("--lw", w + "in");
  out.style.setProperty("--lh", h + "in");
  out.innerHTML = items.map(labelHTML).join("");

  items.forEach((it, i) => {
    const svg = document.getElementById("bc" + i);
    try {
      JsBarcode(svg, it.id, { format: "CODE128", width: 2, height: 46, margin: 0, displayValue: cfg.showText, fontSize: 15, font: "JetBrains Mono, monospace", textMargin: 2 });
      if (!svg.getAttribute("viewBox")) {
        const bw = parseFloat(svg.getAttribute("width")), bh = parseFloat(svg.getAttribute("height"));
        if (bw && bh) svg.setAttribute("viewBox", `0 0 ${bw} ${bh}`);
      }
      svg.removeAttribute("width");
      svg.removeAttribute("height");
    } catch (e) {
      svg.outerHTML = `<div class="t md">Can't encode “${esc(it.id)}”</div>`;
    }
  });

  let cut = 0;
  out.querySelectorAll(".label").forEach((el) => {
    const over = el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1;
    el.classList.toggle("cut", over);
    if (over) cut++;
  });
  $("#cutWarn").textContent = cut ? `${cut} label${cut === 1 ? " has" : "s have"} more content than fits (outlined in red). Try a smaller barcode, fewer lines, or a bigger label.` : "";

  $("#count").textContent = `${items.length} label${items.length === 1 ? "" : "s"}${missingCount ? ` · ${missingCount} ID${missingCount === 1 ? "" : "s"} not found` : ""}`;
  $("#printBtn").disabled = !items.length;
}

$("#printBtn").addEventListener("click", () => window.print());

// ───────────────────────── start ─────────────────────────
function gate(html) { $("#gate").innerHTML = html; $("#gate").classList.remove("hidden"); $("#designer").classList.add("hidden"); }

async function start() {
  $("#title").textContent = kind === "staff" ? "Label designer · employee badges" : "Label designer · asset labels";
  if (!configured) return gate("Firebase isn't configured yet (see README).");

  A.onAuthStateChanged(auth, async (user) => {
    if (!user) return gate('Please <a href="admin.html">sign in on the admin page</a> first, then reopen this page.');
    me = await loadAdmin(user);
    if (!me) return gate("This page is for administrators. Sign in with an admin account on the admin page.");
    try {
      const [it] = await Promise.all([loadItems(), loadTemplates()]);
      items = it.found;
      missingCount = it.missing;
    } catch (e) {
      console.error(e);
      return gate("Couldn't load the labels. Make sure you're signed in as an admin.");
    }
    if (!items.length) return gate('Nothing to print. <a href="admin.html#assets">Go back</a> and tick at least one item.');

    $("#gate").classList.add("hidden");
    $("#designer").classList.remove("hidden");
    initControls();
    const last = store.get();
    chooseTemplate(last && findTpl(last) ? last : `preset:${PRESETS[kind][0].id}`);
  });
}

start();
