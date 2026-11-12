import { auth, db, A, F, appMod, firebaseConfig, configured, friendlyAuthError } from "./fb.js";
import { SETTINGS as S } from "./firebase-config.js";
import { $, $$, esc, norm, validId, toDate, fmtDT, fmtFull, fmtDur, ymd, rangeFromInputs, toCSV, downloadFile, parseCSV, toast, slugify, derivePrefix, nextIdFor, beep } from "./util.js";
import { normalizeLog, summarize, ACTIVITY_HEADERS, activityRows, idMethodLabel } from "./report-logic.js";
import { parseImport, parseAdminImport, findDuplicates } from "./import-logic.js";
import { readSpreadsheet, downloadTemplate } from "./sheet.js";
import { loadAdmin, commitAudited } from "./audit.js";
import { RETIRE_REASONS, reasonLabel } from "./scan-logic.js";
import { normSettings } from "./pin-logic.js";
import { classifyScan, summarizeCount } from "./inventory-logic.js";
import { openCameraScanner, cameraSupported } from "./camera-scan.js?v=13";
import { staleStaff, worthChecking, snoozeUntil, STALE_DAYS, SNOOZE_DAYS } from "./stale-logic.js";

const REPORT_MAX = 5000;
const RESOLUTIONS = [
  "Employee forgot to scan the return",
  "Handed off to a coworker",
  "Device was missing, now found",
  "Not an issue, no action needed",
  "Other (see note)",
];
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const str = (fd, k) => String(fd.get(k) ?? "").trim();
const hoursSince = (ts) => { const d = toDate(ts); return d ? (Date.now() - d.getTime()) / 36e5 : 0; };
const now = () => F.serverTimestamp();

let me = null; // {uid, email, name}
const cache = { assets: [], staff: [], admins: [], stations: [], types: [], alerts: [], issues: [], stale: [], settings: [], counts: [] };
let inv = null; // running inventory count: {scope, scanned:Set, unknown:[], startedAt}
let settingsDirty = false;
let unsubs = [];
let currentTab = "dashboard";
const selectedAssets = new Set();
const selectedStaff = new Set();
let lastReport = null;
let lastAudit = [];
let recentTimer = null;

const commit = (ops, batchId = null) => commitAudited(me, ops, batchId);

// An admin can also be a staff member (their admin entry carries the employee ID they check out under).
// Admins can't change their own staff record or the devices they hold. Another admin has to.
const myEmpId = () => cache.admins.find((a) => a.id === me?.uid)?.employeeId || me?.employeeId || null;
const isMyStaff = (id) => !!id && id === myEmpId();
const SELF_MSG = "That's your own record, so another admin has to change it. (Your check-out history can't be edited by anyone.)";

// ═════════════════════════ views & dialogs ═════════════════════════
function showView(which) {
  for (const id of ["setup", "login", "app"]) $("#" + id).classList.toggle("hidden", id !== which);
}

function formDialog({ title, body, submit = "Save", onSubmit, onOpen }) {
  const d = $("#dlg");
  d.onclose = null;
  d.innerHTML = `<h2>${esc(title)}</h2><form id="dlgForm">${body}<div class="err-text" id="dlgErr" style="margin-top:10px"></div>
    <div class="foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit" id="dlgSubmit">${esc(submit)}</button></div></form>`;
  $("[data-close]", d).onclick = () => d.close();
  $("#dlgForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#dlgSubmit");
    btn.disabled = true;
    $("#dlgErr").textContent = "";
    try {
      const keepOpen = await onSubmit(new FormData(e.target));
      if (keepOpen !== false) d.close();
    } catch (err) {
      $("#dlgErr").textContent = explain(err);
    } finally {
      btn.disabled = false;
    }
  };
  d.showModal();
  onOpen?.(d);
  const first = $("input:not([disabled]):not(.hidden input), select", d);
  first?.focus();
}

function confirmDlg({ title, message, confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const d = $("#dlg");
    d.innerHTML = `<h2>${esc(title)}</h2><p style="margin:0">${message}</p>
      <div class="foot"><button class="btn ghost" id="cNo">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="cYes">${esc(confirm)}</button></div>`;
    let done = false;
    const fin = (v) => { if (done) return; done = true; d.onclose = null; d.close(); resolve(v); };
    $("#cNo").onclick = () => fin(false);
    $("#cYes").onclick = () => fin(true);
    d.onclose = () => fin(false);
    d.showModal();
  });
}

function explain(err) {
  if (err?.code === "permission-denied") return "Not allowed. The change was blocked by the database rules (is your admin account still active?).";
  if (err?.code === "failed-precondition") return "This report needs a database index. Firebase console → Firestore Database → Indexes → add it (the README lists all three), wait a minute, then try again.";
  return err?.message || String(err);
}

// ═════════════════════════ auth & data ═════════════════════════
function stopListeners() { unsubs.forEach((u) => u()); unsubs = []; }

function startListeners() {
  stopListeners();
  const mk = (name, key, sort) =>
    F.onSnapshot(
      F.collection(db, name),
      (snap) => {
        cache[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(sort);
        if (key === "staff") scheduleStale();
        renderCurrent();
      },
      (err) => { console.error(name, err); toast(`Couldn't load ${name}: ${err.code || err.message}`, "err", 7000); }
    );
  const alerts = F.onSnapshot(
    F.query(F.collection(db, "incidents"), F.where("status", "==", "open")),
    (snap) => {
      cache.alerts = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (toDate(b.ts)?.getTime() || 0) - (toDate(a.ts)?.getTime() || 0));
      updateBell();
      renderCurrent();
    },
    (err) => console.error("incidents", err)
  );
  const issues = F.onSnapshot(
    F.query(F.collection(db, "issues"), F.where("status", "==", "open")),
    (snap) => {
      cache.issues = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (toDate(b.ts)?.getTime() || 0) - (toDate(a.ts)?.getTime() || 0));
      updateBell();
      renderCurrent();
    },
    (err) => console.error("issues", err)
  );
  unsubs = [
    mk("assets", "assets", (a, b) => natural(a.id, b.id)),
    mk("staff", "staff", (a, b) => natural(a.name || a.id, b.name || b.id)),
    mk("admins", "admins", (a, b) => natural(a.name || a.email, b.name || b.email)),
    mk("stations", "stations", (a, b) => natural(a.name || a.email, b.name || b.email)),
    mk("assetTypes", "types", (a, b) => natural(a.name, b.name)),
    mk("settings", "settings", (a, b) => natural(a.id, b.id)),
    alerts,
    issues,
  ];
}

function boot() {
  $("#orgName").textContent = S.ORG_NAME;
  if (!configured) return showView("setup");

  A.onAuthStateChanged(auth, async (user) => {
    stopListeners();
    if (!user) { me = null; showView("login"); return; }

    me = await loadAdmin(user);
    if (!me) {
      await A.signOut(auth);
      $("#lErr").textContent = "That login isn't an active administrator account.";
      showView("login");
      return;
    }

    $("#whoami").textContent = me.name;
    showView("app");
    startListeners();
    initDates();
    showTab((location.hash || "#dashboard").slice(1));
    offerStaffLink();

    const key = "audit-login-" + me.uid;
    if (!sessionStorage.getItem(key)) {
      try {
        await commit([{ audit: { action: "session.login", targetType: "session", targetId: me.uid, summary: "Signed in to the admin portal" } }]);
        sessionStorage.setItem(key, "1");
      } catch (e) { console.warn("login audit failed", e); }
    }
  });
}

/** If this admin isn't on the staff list yet, offer to add them (once per sign-in, once the data has loaded). */
function offerStaffLink() {
  const key = "offered-staff-link-" + me.uid;
  try { if (sessionStorage.getItem(key)) return; } catch { /* ignore */ }
  const tryOffer = setInterval(() => {
    const self = cache.admins.find((a) => a.id === me.uid);
    if (!self) return;
    clearInterval(tryOffer);
    try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
    if (!self.employeeId && !$("#dlg").open) linkStaffDialog(self);
  }, 400);
  setTimeout(() => clearInterval(tryOffer), 10000);
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#lErr").textContent = "";
  try { await A.signInWithEmailAndPassword(auth, $("#lEmail").value.trim(), $("#lPass").value); }
  catch (err) { $("#lErr").textContent = friendlyAuthError(err); }
});
$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#lEmail").value.trim();
  const out = $("#lErr");
  out.style.color = "";
  if (!email) { out.textContent = "Type your email above first, then tap “Forgot password?”."; return; }
  try {
    await A.sendPasswordResetEmail(auth, email);
    out.style.color = "var(--ok)";
    out.textContent = `If ${email} has an admin login, a password reset link is on its way. Check your inbox (and spam).`;
  } catch (err) {
    const c = err?.code || "";
    if (c.includes("user-not-found")) { out.style.color = "var(--ok)"; out.textContent = `If ${email} has an admin login, a password reset link is on its way. Check your inbox (and spam).`; }
    else out.textContent = friendlyAuthError(err);
  }
});
$("#signOut").addEventListener("click", () => { sessionStorage.removeItem("audit-login-" + me?.uid); A.signOut(auth); });

// ═════════════════════════ tabs, bell ═════════════════════════
const TABS = ["dashboard", "alerts", "assets", "staff", "inventory", "reports", "admins", "changelog", "settings"];
function showTab(name) {
  if (!TABS.includes(name)) name = "dashboard";
  currentTab = name;
  history.replaceState(null, "", "#" + name);
  $$(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  // Grouped tabs: highlight the group you are in and show the page in its label ("Devices · Assets")
  $$(".tabgroup").forEach((g) => {
    const cur = $(`.tab[data-tab="${name}"]`, g);
    g.classList.toggle("has-active", !!cur);
    const tg = $(".group-toggle", g);
    $(".gl", tg).textContent = cur ? `${tg.dataset.label} · ${cur.textContent.trim()}` : tg.dataset.label;
  });
  closeMenus();
  TABS.forEach((t) => $("#tab-" + t).classList.toggle("hidden", t !== name));
  if (name === "settings") settingsDirty = false;
  if (name === "inventory") loadCounts();
  updateBell();
  renderCurrent();
}
function closeMenus(except = null) {
  $$(".tabgroup.open").forEach((g) => { if (g !== except) { g.classList.remove("open"); $(".group-toggle", g).setAttribute("aria-expanded", "false"); } });
}
$("#tabs").addEventListener("click", (e) => {
  const toggle = e.target.closest(".group-toggle");
  if (toggle) {
    const g = toggle.closest(".tabgroup");
    closeMenus(g);
    const open = g.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    return;
  }
  const t = e.target.closest(".tab[data-tab]");
  if (t) showTab(t.dataset.tab);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".tabgroup")) closeMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
$("#bell").addEventListener("click", () => showTab("alerts"));
$("#alertBarGo").addEventListener("click", () => showTab("alerts"));

const attention = () => cache.alerts.length + cache.issues.length + cache.stale.length;

// ── Inactive staff reminder ──
// Last log entry per person is looked up once per page load (only for people added more than 60 days ago who aren't snoozed).
const lastLogMemo = new Map();
let staleTimer = null, staleRun = 0;
const scheduleStale = () => { clearTimeout(staleTimer); staleTimer = setTimeout(refreshStale, 400); };
async function refreshStale() {
  const run = ++staleRun, nowD = new Date();
  const need = cache.staff.filter((s) => worthChecking(s, nowD, STALE_DAYS) && !lastLogMemo.has(s.id) && !(toDate(s.staleSnoozeUntil)?.getTime() > nowD.getTime()));
  for (let i = 0; i < need.length; i += 5) {
    await Promise.all(need.slice(i, i + 5).map(async (s) => {
      try {
        const snap = await F.getDocs(F.query(F.collection(db, "logs"), F.where("employeeId", "==", s.id), F.orderBy("ts", "desc"), F.limit(1)));
        lastLogMemo.set(s.id, snap.empty ? null : toDate(snap.docs[0].data().ts));
      } catch (e) { console.error("stale lookup", s.id, e); }
    }));
    if (run !== staleRun) return;
  }
  cache.stale = staleStaff(cache.staff.filter((s) => lastLogMemo.has(s.id)), lastLogMemo, new Date(), STALE_DAYS);
  updateBell();
  if (currentTab === "alerts" || currentTab === "dashboard") renderCurrent();
}

function updateBell() {
  const n = attention(), m = cache.alerts.length, k = cache.issues.length;
  $("#bellCount").textContent = n;
  $("#bellCount").classList.toggle("hidden", n === 0);
  $("#bell").classList.toggle("has", n > 0);
  $("#alertTabCount").textContent = n;
  $("#alertTabCount").classList.toggle("hidden", n === 0);
  const parts = [];
  const st = cache.stale.length;
  if (st) parts.push(`${st} staff member${st === 1 ? " hasn't" : "s haven't"} checked anything out in ${Math.round(STALE_DAYS / 30)} months`);
  if (m) parts.push(`${m} device${m === 1 ? " was" : "s were"} checked out and never checked back in`);
  if (k) parts.push(`${k} problem${k === 1 ? " was" : "s were"} reported`);
  $("#alertBarText").textContent = parts.length ? parts.join(", and ") + ". It's on you to follow up." : "";
  $("#alertBar").classList.toggle("hidden", n === 0 || currentTab === "alerts");
  document.title = `${n ? `(${n}) ` : ""}Asset Tracker · Admin`;
}

function renderCurrent() {
  if (!me) return;
  ({ dashboard: renderDashboard, alerts: renderAlerts, assets: renderAssets, staff: renderStaff, inventory: renderInventory, reports: fillReportControls, admins: renderAdmins, changelog: fillAdminSelect, settings: renderSettings }[currentTab] || (() => {}))();
}

const chipFor = {
  out: '<span class="chip out">OUT</span>',
  in: '<span class="chip in">IN</span>',
  missed: '<span class="chip warn">NOT RETURNED</span>',
};
const row = (cells) => `<tr>${cells.map((c) => `<td${c?.cls ? ` class="${c.cls}"` : ""}>${c?.h ?? c ?? ""}</td>`).join("")}</tr>`;
const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${esc(msg)}</td></tr>`;
const typeChip = (c) => (c ? `<span class="chip blue">${esc(c)}</span>` : '<span class="muted">—</span>');
const actionCell = (l) =>
  `${chipFor[l.type] || ""}${l.type === "missed" && l.handledByName ? ` <span class="sub">taken by ${esc(l.handledByName)}</span>` : ""}${l.takeoverFromName ? ` <span class="sub">was with ${esc(l.takeoverFromName)}</span>` : ""}`;

// ═════════════════════════ dashboard ═════════════════════════
function renderDashboard() {
  const active = cache.assets.filter((a) => a.active);
  const out = active.filter((a) => a.status === "out");
  const overdue = out.filter((a) => hoursSince(a.checkedOutAt) > S.OVERDUE_HOURS);
  const stat = (n, l, c) => `<div class="stat ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $("#dashStats").innerHTML =
    stat(active.length, "Active assets", "") +
    stat(out.length, "Checked out", "o") +
    stat(active.length - out.length, "Available", "g") +
    stat(attention(), "Open alerts", attention() ? "w" : "") +
    stat(overdue.length, `Out > ${S.OVERDUE_HOURS}h`, overdue.length ? "w" : "") +
    stat(cache.staff.filter((s) => s.active).length, "Active staff", "b");

  const sorted = [...out].sort((a, b) => (toDate(a.checkedOutAt)?.getTime() || 0) - (toDate(b.checkedOutAt)?.getTime() || 0));
  $("#dashOut").innerHTML = sorted.length
    ? sorted.map((a) => {
        const h = hoursSince(a.checkedOutAt);
        return row([
          { h: `<span class="mono"><b>${esc(a.id)}</b></span>` }, { h: typeChip(a.category) }, esc(a.model || "—"),
          `<b>${esc(a.currentHolderName)}</b> <span class="sub mono">${esc(a.currentHolderId)}</span>`,
          fmtDT(a.checkedOutAt), { h: `${fmtDur(h * 60)}${h > S.OVERDUE_HOURS ? ' <span class="chip warn">overdue</span>' : ""}` },
        ]);
      }).join("")
    : emptyRow(6, "Nothing is checked out.");

  clearTimeout(recentTimer);
  recentTimer = setTimeout(loadRecent, 250);
}

async function loadRecent() {
  try {
    const snap = await F.getDocs(F.query(F.collection(db, "logs"), F.orderBy("ts", "desc"), F.limit(15)));
    const logs = snap.docs.map((d) => normalizeLog(d.id, d.data()));
    $("#dashRecent").innerHTML = logs.length
      ? logs.map((l) => row([fmtDT(l.ts), { h: actionCell(l) }, { h: `<span class="mono">${esc(l.assetId)}</span>` }, esc(l.employeeName), l.type === "in" ? fmtDur(l.heldMinutes) : "—"])).join("")
      : emptyRow(5, "No activity yet.");
  } catch (e) { $("#dashRecent").innerHTML = emptyRow(5, "Couldn't load activity."); }
}

// ═════════════════════════ alerts ═════════════════════════
function renderAlerts() {
  $("#issuesOpen").innerHTML = cache.issues.length
    ? cache.issues.map((i) => `<tr data-id="${esc(i.id)}">
        <td>${fmtDT(i.ts)}</td>
        <td><b class="mono">${esc(i.assetId)}</b> ${typeChip(i.assetCategory)}<div class="sub">${esc(i.assetModel || "")}</div></td>
        <td><b>${esc(i.problem)}</b>${i.note ? `<div class="sub">${esc(i.note)}</div>` : ""}</td>
        <td>${esc(i.reportedByName)} <span class="sub mono">${esc(i.reportedById)}</span></td>
        <td class="actions"><button class="btn sm primary" data-act="issue">Resolve…</button></td></tr>`).join("")
    : emptyRow(5, "No reported problems.");
  const open = cache.alerts;
  const perPerson = (id) => open.filter((a) => a.missedById === id).length;
  $("#alertsOpen").innerHTML = open.length
    ? open.map((i) => {
        const n = perPerson(i.missedById);
        return `<tr data-id="${esc(i.id)}">
          <td>${fmtDT(i.ts)}</td>
          <td><b class="mono">${esc(i.assetId)}</b> ${typeChip(i.assetCategory)}<div class="sub">${esc(i.assetModel || "")}</div></td>
          <td><b>${esc(i.missedByName)}</b> <span class="sub mono">${esc(i.missedById)}</span>${n > 1 ? ` <span class="chip warn">${n} open</span>` : ""}</td>
          <td>${fmtDur(i.heldMinutes)}<div class="sub">since ${fmtDT(i.checkedOutAt)}</div></td>
          <td>${esc(i.takenOverByName)}</td>
          <td class="actions"><button class="btn sm primary" data-act="resolve">Resolve…</button></td></tr>`;
      }).join("")
    : emptyRow(6, "No open alerts. Every device is accounted for.");

  $("#staleBody").innerHTML = cache.stale.length
    ? cache.stale.map(({ staff: p, last }) => `<tr data-id="${esc(p.id)}">
        <td><b>${esc(p.name)}</b> <span class="sub mono">${esc(p.id)}</span></td>
        <td>${last ? `${fmtDT(last)}<div class="sub">${Math.floor(hoursSince(last) / 24)} days ago</div>` : '<span class="muted">No activity recorded</span>'}</td>
        <td class="actions">${isMyStaff(p.id) ? '<span class="sub">Your own record. Ask another admin.</span>' : '<button class="btn sm" data-act="snooze">Snooze 2 months</button> <button class="btn sm danger" data-act="stale-remove">Remove…</button>'}</td></tr>`).join("")
    : emptyRow(3, "Nobody is inactive.");

  const late = cache.assets.filter((a) => a.active && a.status === "out" && hoursSince(a.checkedOutAt) > S.OVERDUE_HOURS)
    .sort((a, b) => hoursSince(b.checkedOutAt) - hoursSince(a.checkedOutAt));
  $("#overdueNote").textContent = `Devices out more than ${S.OVERDUE_HOURS} hours`;
  $("#alertsOverdue").innerHTML = late.length
    ? late.map((a) => `<tr data-id="${esc(a.id)}"><td><b class="mono">${esc(a.id)}</b> ${typeChip(a.category)}</td><td>${esc(a.currentHolderName)} <span class="sub mono">${esc(a.currentHolderId)}</span></td>
        <td>${fmtDT(a.checkedOutAt)}</td><td>${fmtDur(hoursSince(a.checkedOutAt) * 60)}</td><td class="actions"><button class="btn sm" data-act="return">Force return</button></td></tr>`).join("")
    : emptyRow(5, "Nothing is overdue.");
}

$("#tab-alerts").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  try {
    if (btn.dataset.act === "resolve") resolveDialog(cache.alerts.find((x) => x.id === id));
    if (btn.dataset.act === "issue") issueDialog(cache.issues.find((x) => x.id === id));
    if (btn.dataset.act === "return") await forceReturn(cache.assets.find((x) => x.id === id));
    if (btn.dataset.act === "snooze") await snoozeStaff(cache.staff.find((x) => x.id === id));
    if (btn.dataset.act === "stale-remove") await removeStaff(cache.staff.find((x) => x.id === id));
  } catch (err) { toast(explain(err), "err", 6000); }
});

function resolveDialog(i) {
  if (!i) return;
  const n = cache.alerts.filter((a) => a.missedById === i.missedById).length;
  formDialog({
    title: `Resolve: ${i.assetId} not returned`,
    submit: "Mark resolved",
    body: `<p class="muted" style="margin-top:0"><b>${esc(i.missedByName)}</b> had ${esc(i.assetId)} out for ${fmtDur(i.heldMinutes)} and it was never checked in. <b>${esc(i.takenOverByName)}</b> took it next.${n > 1 ? ` ${esc(i.missedByName)} has ${n} open alerts.` : ""}</p>
      <div class="form-grid" style="grid-template-columns:1fr">
        <label class="f">What happened?<select name="resolution">${RESOLUTIONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
        <label class="f">Note (optional)<textarea name="note" style="min-height:80px;font-family:var(--sans)" placeholder="Anything worth remembering, e.g. coached on scanning at end of shift"></textarea></label>
      </div>`,
    onSubmit: async (fd) => {
      const resolution = str(fd, "resolution"), note = str(fd, "note");
      if (resolution.startsWith("Other") && !note) throw new Error("Add a short note for “Other”.");
      await commit([{
        ref: F.doc(db, "incidents", i.id), mode: "update",
        data: { status: "resolved", resolution, note, resolvedAt: now(), resolvedByName: me.name, resolvedByEmail: me.email, updatedAt: now() },
        audit: {
          action: "incident.resolve", targetType: "incident", targetId: i.id,
          summary: `Resolved: ${i.assetId} not returned by ${i.missedByName} (${resolution})`,
          before: { status: "open" }, after: { status: "resolved", resolution, note },
        },
      }]);
      toast("Alert resolved", "ok");
    },
  });
}

$("#loadResolved").addEventListener("click", async () => {
  $("#alertsResolved").textContent = "Loading…";
  const byTime = (a, b) => (toDate(b.resolvedAt)?.getTime() || 0) - (toDate(a.resolvedAt)?.getTime() || 0);
  try {
    const [a, b] = await Promise.all([
      F.getDocs(F.query(F.collection(db, "incidents"), F.where("status", "==", "resolved"), F.limit(200))),
      F.getDocs(F.query(F.collection(db, "issues"), F.where("status", "==", "resolved"), F.limit(200))),
    ]);
    const rows = a.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byTime);
    const probs = b.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byTime);
    const t1 = rows.length
      ? `<h3 class="sec" style="margin-top:0">Missed returns</h3><div class="table-wrap"><table><thead><tr><th>Resolved</th><th>Asset</th><th>Not returned by</th><th>Taken by</th><th>What happened</th><th>Resolved by</th></tr></thead><tbody>
        ${rows.map((i) => row([fmtDT(i.resolvedAt), { h: `<b class="mono">${esc(i.assetId)}</b>` }, esc(i.missedByName), esc(i.takenOverByName), { h: `${esc(i.resolution || "")}${i.note ? `<div class="sub">${esc(i.note)}</div>` : ""}` }, esc(i.resolvedByName || "")])).join("")}</tbody></table></div>`
      : "";
    const t2 = probs.length
      ? `<h3 class="sec">Reported problems</h3><div class="table-wrap"><table><thead><tr><th>Resolved</th><th>Asset</th><th>Problem</th><th>Reported by</th><th>Outcome</th><th>Resolved by</th></tr></thead><tbody>
        ${probs.map((i) => row([fmtDT(i.resolvedAt), { h: `<b class="mono">${esc(i.assetId)}</b>` }, esc(i.problem), esc(i.reportedByName), { h: `${esc(i.resolution || "")}${i.note ? `<div class="sub">${esc(i.note)}</div>` : ""}` }, esc(i.resolvedByName || "")])).join("")}</tbody></table></div>`
      : "";
    $("#alertsResolved").innerHTML = t1 + t2 || "Nothing resolved yet.";
  } catch (e) { $("#alertsResolved").textContent = explain(e); }
});

// ═════════════════════════ asset types ═════════════════════════
const activeTypes = () => cache.types.filter((t) => t.active);
const typeByName = (n) => cache.types.find((t) => t.name.toLowerCase() === String(n ?? "").toLowerCase());
// The ID prefix is optional. It only decides how the "next ID" suggestion starts (R → R1, R2…).
// A type with an empty prefix gets no suggestion: you type each ID yourself.
const prefixOf = (t) => (typeof t?.prefix === "string" ? t.prefix : derivePrefix(t?.name));
// IDs are numbered with 3 digits (S001, S002...), fixed on purpose: there will never be more than 999 of one kind.
const ID_DIGITS = 3;
const padOf = () => ID_DIGITS;
const DETAIL_FIELDS = [["model", "Model"], ["phoneNumber", "Phone number"], ["imei", "IMEI"], ["serial", "Serial number"]];
const fieldsOf = (t) => (Array.isArray(t?.fields) ? t.fields : DETAIL_FIELDS.map(([k]) => k));
const PREFIX_RE = /^[A-Z0-9._-]{0,10}$/;
const takenIds = (extra = []) => [...cache.assets.map((a) => a.id), ...cache.staff.map((x) => x.id), ...cache.staff.map((x) => x.badgeId).filter(Boolean), ...extra];
/** The next free number after the highest one already used with this prefix (S001 when there is none yet). */
const nextAssetId = (prefix, extra = []) => nextIdFor(prefix, ID_DIGITS, takenIds(extra));
const checkedFields = (root) => DETAIL_FIELDS.map(([k]) => k).filter((k) => root.querySelector(`[data-tf="${k}"]`)?.checked);
const fieldBoxes = (fields) => DETAIL_FIELDS.map(([k, l]) => `<label class="chk"><input type="checkbox" data-tf="${k}" ${fields.includes(k) ? "checked" : ""} /> ${l}</label>`).join(" ");

const typeCreateOp = ({ name, prefix, pad = ID_DIGITS, fields = DETAIL_FIELDS.map(([k]) => k) }) => ({
  ref: F.doc(db, "assetTypes", slugify(name)), mode: "set",
  data: { name, prefix, pad, fields, active: true, createdAt: now(), updatedAt: now() },
  audit: { action: "assetType.create", targetType: "assetType", targetId: slugify(name), summary: `Created asset type “${name}”${prefix ? ` (IDs start ${prefix})` : " (no ID prefix)"}${fields.length ? "" : " with no extra detail fields"}`, before: null, after: { name, prefix, pad, fields } },
});

function typeSelects() {
  const act = activeTypes();
  const keepA = $("#assetType").value, keepR = $("#rCategory").value;
  $("#assetType").innerHTML = '<option value="">All asset types</option>' + act.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  $("#rCategory").innerHTML = '<option value="">All asset types</option>' + cache.types.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  $("#assetType").value = keepA; $("#rCategory").value = keepR;
}

$("#manageTypes").addEventListener("click", typesDialog);

function typesDialog() {
  const d = $("#dlg");
  d.onclose = null;
  const draw = () => {
    d.innerHTML = `<h2>Asset types</h2>
      <p class="muted" style="margin-top:0">Categories such as Rover phone, iPad or Fob. This is the only place to add a new type. The <b>ID letters</b> are optional: they start the suggested ID when you add an item (letters <span class="mono">S</span> suggest S001, S002, S003…, always the next number after the highest one used). Leave them empty to type every ID yourself. Tick the detail fields this type has: each ticked field is <b>required</b> whenever you add one (leave a field unticked if it doesn't apply, like a fob with no serial number). Types are archived, never deleted.</p>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>ID letters</th><th>Detail fields</th><th>Active</th><th></th></tr></thead><tbody id="typeRows">
      ${cache.types.map((t) => {
        const n = cache.assets.filter((a) => a.active && a.category === t.name).length;
        return `<tr class="${t.active ? "" : "dim"}" data-id="${esc(t.id)}"><td><b>${esc(t.name)}</b>${t.active ? "" : ' <span class="chip off">Archived</span>'}</td>
          <td><input data-prefix class="mono" value="${esc(prefixOf(t))}" placeholder="(none)" style="width:84px;padding:5px 8px" /></td>
          <td style="white-space:normal">${fieldBoxes(fieldsOf(t))}</td><td>${n}</td>
          <td class="actions"><button class="btn sm" data-act="save">Save</button>
          ${t.active ? '<button class="btn sm danger" data-act="archive">Archive</button>' : '<button class="btn sm" data-act="restore">Restore</button>'}</td></tr>`;
      }).join("") || emptyRow(5, "No asset types yet. Add your first below (e.g. Rover phone).")}</tbody></table></div>
      <form id="typeForm" style="margin-top:14px">
        <div class="form-grid" style="grid-template-columns:2fr 1fr;align-items:end">
          <label class="f">New type<input name="name" placeholder="e.g. Supervisor phone" required /></label>
          <label class="f">ID letters (optional)<input name="prefix" placeholder="e.g. S" /></label>
        </div>
        <div class="muted" id="typePreview" style="margin:8px 0 0;font-size:13px"></div>
        <div style="margin:10px 0 8px"><span class="muted">Detail fields (ticked = required):</span> ${fieldBoxes(DETAIL_FIELDS.map(([k]) => k))}</div>
        <button class="btn primary" type="submit">Add type</button>
      </form>
      <div class="err-text" id="typeErr" style="margin-top:8px"></div>
      <div class="foot"><button class="btn ghost" id="typeClose">Close</button></div>`;
    $("#typeClose").onclick = () => d.close();
    // Suggest ID letters from the name until they are typed by hand, and show what the first ID will be.
    let prefixTouched = false;
    const tf = $("#typeForm");
    const preview = () => {
      const p = norm(tf.elements.prefix.value);
      const nm = tf.elements.name.value.trim();
      $("#typePreview").textContent = p ? `The first ${nm || "item"} will be ${nextAssetId(p)}.` : nm ? "No ID letters: you type each ID yourself when you add one." : "";
    };
    // First letter of the name (R for Rover phone); two letters if another type already uses that one.
    const suggestLetters = (name) => {
      const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase();
      if (!letters) return "";
      const used = new Set(cache.types.map((t) => prefixOf(t)));
      return used.has(letters[0]) ? letters.slice(0, 2) : letters[0];
    };
    tf.elements.name.addEventListener("input", () => { if (!prefixTouched) tf.elements.prefix.value = suggestLetters(tf.elements.name.value); preview(); });
    tf.elements.prefix.addEventListener("input", () => { prefixTouched = true; preview(); });
    $("#typeForm").onsubmit = async (e) => {
      e.preventDefault();
      $("#typeErr").textContent = "";
      try {
        const fd = new FormData(e.target);
        const name = str(fd, "name");
        if (!slugify(name)) throw new Error("Enter a type name.");
        if (cache.types.some((t) => t.id === slugify(name))) throw new Error(`“${name}” already exists.`);
        const prefix = norm(str(fd, "prefix"));
        if (!PREFIX_RE.test(prefix)) throw new Error("Prefix can use letters, numbers, dot, dash, underscore (10 max).");
        await commit([typeCreateOp({ name, prefix, fields: checkedFields(e.target) })]);
        toast(`Added type ${name}`, "ok");
        draw();
      } catch (err) { $("#typeErr").textContent = explain(err); }
    };
    $("#typeRows").onclick = async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const tr = b.closest("tr");
      const t = cache.types.find((x) => x.id === tr.dataset.id);
      $("#typeErr").textContent = "";
      try {
        if (b.dataset.act === "save") {
          const prefix = norm($("[data-prefix]", tr).value);
          if (!PREFIX_RE.test(prefix)) throw new Error("Prefix can use letters, numbers, dot, dash, underscore (10 max).");
          const fields = checkedFields(tr);
          const before = { prefix: prefixOf(t), fields: fieldsOf(t) };
          const after = { prefix, fields };
          if (JSON.stringify(before) === JSON.stringify(after)) throw new Error("Nothing changed.");
          await commit([{ ref: F.doc(db, "assetTypes", t.id), mode: "update", data: { ...after, updatedAt: now() },
            audit: { action: "assetType.update", targetType: "assetType", targetId: t.id, summary: `Changed ${t.name} type settings (ID letters “${before.prefix}” → “${prefix}”, fields: ${fields.join(", ") || "none"})`, before, after } }]);
          toast("Saved. ID letters apply to newly added items.", "ok");
        } else {
          const active = b.dataset.act === "restore";
          if (!active && cache.assets.some((a) => a.active && a.category === t.name)) throw new Error(`${t.name} still has active assets. Move or remove them first.`);
          await commit([{ ref: F.doc(db, "assetTypes", t.id), mode: "update", data: { active, updatedAt: now() },
            audit: { action: active ? "assetType.restore" : "assetType.archive", targetType: "assetType", targetId: t.id, summary: `${active ? "Restored" : "Archived"} asset type ${t.name}`, before: { active: !active }, after: { active } } }]);
        }
        draw();
      } catch (err) { $("#typeErr").textContent = explain(err); }
    };
  };
  draw();
  d.showModal();
}

// ═════════════════════════ assets ═════════════════════════
const ASSET_FIELDS = ["category", "model", "imei", "serial", "phoneNumber"];
const pickFields = (o, fields) => Object.fromEntries(fields.map((f) => [f, o?.[f] ?? ""]));

function idOwner(id) {
  if (cache.assets.some((a) => a.id === id)) return `asset ${id}`;
  const s = cache.staff.find((x) => x.id === id);
  if (s) return `staff member ${s.name}`;
  const b = cache.staff.find((x) => x.badgeId === id);
  return b ? `${b.name}'s badge number` : null;
}

const assetCreateOp = (r) => ({
  ref: F.doc(db, "assets", r.id), mode: "set",
  data: { ...pickFields(r, ASSET_FIELDS), status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: null, active: true, createdAt: now(), updatedAt: now() },
  audit: { action: "asset.create", targetType: "asset", targetId: r.id, summary: `Added ${r.category || "asset"} ${r.id}${r.model ? ` (${r.model})` : ""}`, before: null, after: pickFields(r, ASSET_FIELDS) },
});
const staffCreateOp = (r) => ({
  ref: F.doc(db, "staff", r.id), mode: "set",
  data: { name: r.name, badgeId: r.badgeId || "", active: true, createdAt: now(), updatedAt: now() },
  audit: { action: "staff.create", targetType: "staff", targetId: r.id, summary: `Added staff member ${r.name} (${r.id})${r.badgeId ? `, badge ${r.badgeId}` : ""}`, before: null, after: { name: r.name, badgeId: r.badgeId || "" } },
});
const adminLinkOp = (a, employeeId) => ({
  ref: F.doc(db, "admins", a.id), mode: "update", data: { employeeId, updatedAt: now() },
  audit: { action: "admin.link_staff", targetType: "admin", targetId: a.id, summary: `Linked admin ${a.name || a.email} to staff ID ${employeeId}`, before: { employeeId: a.employeeId || null }, after: { employeeId } },
});
const staffBadgeOp = (s, badgeId) => ({
  ref: F.doc(db, "staff", s.id), mode: "update", data: { badgeId, updatedAt: now() },
  audit: { action: "staff.update", targetType: "staff", targetId: s.id, summary: `${badgeId ? (s.badgeId ? "Changed" : "Added") : "Cleared"} badge number for ${s.name} (${s.id})${badgeId ? `: ${badgeId}` : ""}`, before: { badgeId: s.badgeId || "" }, after: { badgeId } },
});

function shownAssets() {
  const q = $("#assetSearch").value.trim().toLowerCase();
  const type = $("#assetType").value;
  const status = $("#assetStatus").value;
  const showRemoved = $("#assetRemoved").checked;
  let rows = cache.assets.filter((a) => showRemoved || a.active);
  if (type) rows = rows.filter((a) => a.category === type);
  if (status === "out") rows = rows.filter((a) => a.status === "out");
  if (status === "in") rows = rows.filter((a) => a.status !== "out");
  if (q) rows = rows.filter((a) => [a.id, a.category, a.model, a.imei, a.serial, a.phoneNumber, a.currentHolderName].join(" ").toLowerCase().includes(q));
  return rows;
}

function renderAssets() {
  typeSelects();
  const rows = shownAssets();
  const activeCount = cache.assets.filter((a) => a.active).length;
  $("#assetCount").textContent = `${activeCount} active${cache.assets.length !== activeCount ? ` · ${cache.assets.length - activeCount} out of service` : ""}`;
  const alertIds = new Set(cache.alerts.map((a) => a.assetId));
  const issueIds = new Set(cache.issues.map((a) => a.assetId));

  $("#assetsBody").innerHTML = rows.length
    ? rows.map((a) => {
        const stat = !a.active ? `<span class="chip off" title="${esc(a.retireNote || "")}">Out of service · ${esc(reasonLabel(a.retireReason))}</span>${a.retireNote ? `<div class="sub">${esc(a.retireNote)}</div>` : ""}`
          : a.status === "out"
            ? `<span class="chip out">OUT</span> ${esc(a.currentHolderName)} <span class="sub">· ${fmtDur(hoursSince(a.checkedOutAt) * 60)}</span>`
            : '<span class="chip in">Available</span>';
        return `<tr class="${a.active ? "" : "dim"}" data-id="${esc(a.id)}">
          <td><input type="checkbox" data-sel ${selectedAssets.has(a.id) ? "checked" : ""} ${a.active ? "" : "disabled"} /></td>
          <td class="mono"><b>${esc(a.id)}</b>${alertIds.has(a.id) ? ' <span class="chip warn" title="Open alert">alert</span>' : ""}${issueIds.has(a.id) ? ' <span class="chip warn" title="Reported problem">problem</span>' : ""}</td>
          <td>${typeChip(a.category)}</td><td>${esc(a.model)}</td><td class="mono">${esc(a.imei)}</td><td class="mono">${esc(a.serial)}</td><td>${esc(a.phoneNumber)}</td>
          <td>${stat}</td>
          <td class="actions">
            ${a.active ? `<a class="btn sm" target="_blank" href="print.html?kind=asset&ids=${encodeURIComponent(a.id)}">Print label</a>` : ""}
            <button class="btn sm" data-act="edit">Edit</button>
            ${a.active && a.status === "out" ? '<button class="btn sm" data-act="return">Force return</button>' : ""}
            ${a.active ? '<button class="btn sm danger" data-act="remove">Out of service…</button>' : '<button class="btn sm" data-act="restore">Return to service</button>'}
          </td></tr>`;
      }).join("")
    : emptyRow(9, cache.assets.length ? "No assets match." : "No assets yet. Add one or import a CSV.");

  const n = selectedAssets.size;
  $("#printSelected").disabled = n === 0;
  $("#printSelected").textContent = n ? `Print ${n} label${n === 1 ? "" : "s"}…` : "Print labels…";
  $("#clearSel").disabled = n === 0;
  const selectable = rows.filter((a) => a.active);
  $("#assetAll").checked = selectable.length > 0 && selectable.every((a) => selectedAssets.has(a.id));
}

["#assetSearch", "#assetType", "#assetStatus", "#assetRemoved"].forEach((s) => $(s).addEventListener("input", renderAssets));

function selectShown(on) {
  shownAssets().filter((a) => a.active).forEach((a) => (on ? selectedAssets.add(a.id) : selectedAssets.delete(a.id)));
  renderAssets();
}
$("#assetAll").addEventListener("change", (e) => selectShown(e.target.checked));
$("#selectShown").addEventListener("click", () => selectShown(true));
$("#clearSel").addEventListener("click", () => { selectedAssets.clear(); renderAssets(); });

$("#assetsBody").addEventListener("change", (e) => {
  if (!e.target.matches("[data-sel]")) return;
  const id = e.target.closest("tr").dataset.id;
  e.target.checked ? selectedAssets.add(id) : selectedAssets.delete(id);
  renderAssets();
});

$("#assetsBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const a = cache.assets.find((x) => x.id === btn.closest("tr").dataset.id);
  if (!a) return;
  if (isMyStaff(a.currentHolderId) && ["edit", "remove"].includes(btn.dataset.act)) return toast(`${a.id} is checked out to you. Scan it at the station to return it, or ask another admin.`, "err", 6000);
  try {
    if (btn.dataset.act === "edit") assetForm(a);
    if (btn.dataset.act === "return") await forceReturn(a);
    if (btn.dataset.act === "remove") await removeAsset(a);
    if (btn.dataset.act === "restore") await setActive("asset", a, true);
  } catch (err) { toast(explain(err), "err", 6000); }
});

$("#addAsset").addEventListener("click", () => assetForm(null));
$("#printSelected").addEventListener("click", () => openPrint("asset", [...selectedAssets]));
$("#exportAssets").addEventListener("click", () =>
  downloadFile("assets.csv", toCSV(["Asset ID", "Asset Type", "Model", "IMEI", "Serial", "Phone Number", "Status", "Held By", "Active"],
    cache.assets.map((a) => [a.id, a.category, a.model, a.imei, a.serial, a.phoneNumber, a.status === "out" ? "Out" : "In", a.currentHolderName || "", a.active ? "yes" : "no"]))));

/** Hand a (possibly long) list of IDs to the label designer. */
function openPrint(kind, ids) {
  try {
    localStorage.setItem("print-queue", JSON.stringify({ kind, ids, at: Date.now() }));
    window.open("print.html?queue=1", "_blank");
  } catch {
    window.open(`print.html?kind=${kind}&ids=${encodeURIComponent(ids.join(","))}`, "_blank");
  }
}

function assetForm(existing) {
  const editing = !!existing;
  const types = activeTypes();
  if (!editing && !types.length) {
    return formDialog({
      title: "Add asset", submit: "Set up asset types",
      body: `<p style="margin-top:0">You pick the type of item first, and there are no types yet. Add one in <b>Asset types</b> (for example Rover phone or Fob), then come back here.</p>`,
      onSubmit: async () => { setTimeout(() => { typesDialog(); $("#dlg").onclose = () => { $("#dlg").onclose = null; assetForm(null); }; }, 0); },
    });
  }
  const a = existing || { id: "", category: "", model: "", imei: "", serial: "", phoneNumber: "" };
  const archivedCurrent = editing && existing.category && !typeByName(existing.category)?.active;
  const options =
    (editing && !existing.category ? '<option value="" selected>Choose a type…</option>' : "") +
    (!editing ? '<option value="" selected disabled>Choose a type…</option>' : "") +
    (archivedCurrent ? `<option value="${esc(existing.category)}" selected>${esc(existing.category)} (archived)</option>` : "") +
    types.map((t) => `<option value="${esc(t.name)}" ${editing && existing.category === t.name ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const detail = (k, label, extra = "") => `<label class="f" data-field="${k}" data-label="${label}">${label} <span class="muted" data-reqmark style="text-transform:none;font-weight:400"></span><input name="${k}" value="${esc(a[k])}" ${extra} /><span class="dup-warn err-text" data-dup="${k}" style="text-transform:none;font-weight:600"></span></label>`;

  const justAdded = new Set();   // IDs saved in this dialog (the live data lags a moment behind)
  let addAnother = false;
  let touched = false;
  let resync = () => {};

  formDialog({
    title: editing ? `Edit ${existing.id}` : "Add asset",
    submit: editing ? "Save changes" : "Add asset",
    body: `<label class="f">${editing ? "Type of item" : "What kind of item is this?"}<select name="category">${options}</select></label>
      ${editing ? "" : '<p class="muted" style="font-size:13px;margin:6px 0 0">Need a new kind of item? <a href="#" id="openTypes">Add it in Asset types</a> first.</p>'}
      <div id="assetRest" class="${editing ? "" : "hidden"}">
        <div class="form-grid" style="margin-top:14px">
          <label class="f" style="grid-column:1/-1">Barcode ID (what the label will say)<input name="id" value="${esc(a.id)}" ${editing ? "disabled" : ""} required placeholder="e.g. S001, FOB-12" />
            <span class="muted" data-hint style="text-transform:none;font-weight:400;font-size:13px"></span>
            <span class="dup-warn err-text" data-idwarn style="text-transform:none;font-weight:600"></span></label>
          ${detail("model", "Model", 'placeholder="e.g. iPhone 13, iPad 10th gen"')}
          ${detail("phoneNumber", "Phone number")}
          ${detail("imei", "IMEI", 'inputmode="numeric"')}
          ${detail("serial", "Serial number")}
        </div>${editing ? "" : '<p class="muted" style="font-size:13px;margin-bottom:0">The barcode ID can’t be changed later. The detail fields shown are the ones this type is set up with, and each is required.</p>'}
      </div>`,
    onOpen: (d) => {
      const f = $("#dlgForm"), sel = f.elements.category, idEl = f.elements.id;
      const warn = $("[data-idwarn]", f), hint = $("[data-hint]", f);

      const checkId = () => {
        const id = norm(idEl.value);
        const owner = !editing && id ? (justAdded.has(id) ? `asset ${id}` : idOwner(id)) : null;
        warn.textContent = owner ? `Already used by ${owner}` : "";
        idEl.classList.toggle("dup", !!owner);
      };
      const sync = () => {
        const t = typeByName(sel.value);
        $("#assetRest").classList.toggle("hidden", !sel.value);
        // Only show the detail fields this type uses (always show one that already has a value)
        const fields = fieldsOf(t);
        $$("[data-field]", f).forEach((el) => {
          const k = el.dataset.field;
          el.classList.toggle("hidden", !(fields.includes(k) || (editing && existing[k])));
          // Every detail field the type is set up with is required; one kept only because it already has a value is not
          $("[data-reqmark]", el).textContent = fields.includes(k) ? "(required)" : "(optional)";
        });
        if (!editing) {
          const p = prefixOf(t);
          if (!touched) idEl.value = p ? nextAssetId(p, [...justAdded]) : "";
          const used = p && takenIds([...justAdded]).some((id) => id.startsWith(p) && /^\d+$/.test(id.slice(p.length)));
          hint.textContent = !t ? "" : !p ? "This type has no ID letters, so type the ID the barcode should say." : used ? "Filled in for you: the next number after the highest one already in use. You can change it." : `Filled in for you. This is the first ${t.name}, so it starts at 001. You can change it.`;
        }
        checkId();
      };
      resync = sync;
      // Warn as soon as a phone number, IMEI or serial matches another asset
      const checkDups = () => {
        const vals = Object.fromEntries(["imei", "serial", "phoneNumber"].map((k) => [k, f.elements[k]?.value ?? ""]));
        const dups = findDuplicates(cache.assets, vals, editing ? existing.id : null);
        $$("[data-dup]", f).forEach((el) => {
          const d = dups.find((x) => x.field === el.dataset.dup);
          el.textContent = d ? `Already on ${d.assetId}` : "";
          f.elements[el.dataset.dup]?.classList.toggle("dup", !!d);
        });
      };
      ["imei", "serial", "phoneNumber"].forEach((k) => f.elements[k].addEventListener("input", checkDups));
      checkDups();
      sel.addEventListener("change", () => { touched = false; sync(); });
      idEl.addEventListener("input", () => { touched = true; checkId(); });
      sync();

      if (!editing) {
        $("#openTypes", f).onclick = (e) => {
          e.preventDefault();
          d.close();
          typesDialog();
          d.onclose = () => { d.onclose = null; assetForm(null); };   // come straight back here when they close it
        };
        const again = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "dlgAgain", textContent: "Add & add another" });
        again.onclick = () => { addAnother = true; f.requestSubmit(); };
        $(".foot", d).insertBefore(again, $("#dlgSubmit"));
      }
    },
    onSubmit: async (fd) => {
      const again = addAnother;
      addAnother = false;
      const category = str(fd, "category");
      const hidden = new Set($$("[data-field].hidden", $("#dlgForm")).map((el) => el.dataset.field));
      const vals = Object.fromEntries(DETAIL_FIELDS.map(([k]) => [k, hidden.has(k) ? (existing?.[k] ?? "") : str(fd, k)]));
      if (!category) throw new Error("Choose what kind of item this is.");
      const missing = fieldsOf(typeByName(category)).filter((k) => !hidden.has(k) && !vals[k]);
      if (missing.length) throw new Error(`${category} needs ${missing.map((k) => DETAIL_FIELDS.find(([x]) => x === k)[1]).join(", ")}. These fields are required for this type.`);
      const dups = findDuplicates(cache.assets, vals, editing ? existing.id : null);
      if (dups.length) throw new Error(dups.map((d) => `The ${d.label} ${d.value} is already on ${d.assetId}.`).join(" ") + " Check for a typo, or edit that asset instead.");

      if (editing) {
        const before = pickFields(existing, ASSET_FIELDS);
        const after = { category, ...vals };
        const changed = ASSET_FIELDS.filter((f) => before[f] !== after[f]);
        if (!changed.length) throw new Error("No changes to save.");
        await commit([{
          ref: F.doc(db, "assets", existing.id), mode: "update", data: { ...after, updatedAt: now() },
          audit: { action: "asset.update", targetType: "asset", targetId: existing.id, summary: `Edited ${existing.id}: ${changed.join(", ")}`, before, after },
        }]);
        return toast(`Saved ${existing.id}`, "ok");
      }

      const id = norm(fd.get("id"));
      if (!id) throw new Error("Enter a barcode ID. It's what the label will say.");
      if (!validId(id)) throw new Error("The barcode ID can only use letters, numbers, dot, dash and underscore (40 characters max).");
      const owner = justAdded.has(id) ? `asset ${id}` : idOwner(id);
      if (owner) throw new Error(`“${id}” is already used by ${owner}.`);
      await commit([assetCreateOp({ id, category, ...vals })]);
      if (!again) return toast(`Added ${id}`, "ok");

      // "Add & add another": keep the dialog and the type, clear the details, suggest the next ID
      justAdded.add(id);
      toast(`Added ${id}. Ready for the next one.`, "ok");
      const f = $("#dlgForm");
      DETAIL_FIELDS.forEach(([k]) => { f.elements[k].value = ""; });
      touched = false;
      resync();
      ($$("[data-field]:not(.hidden) input", f)[0] || f.elements.id).focus();
      return false;
    },
  });
}

function removeAsset(a) { outOfServiceDialog(a); }

async function setActive(kind, rec, active) {
  const label = kind === "asset" ? `asset ${rec.id}` : `${rec.name} (${rec.id})`;
  await commit([{
    ref: F.doc(db, kind === "asset" ? "assets" : "staff", rec.id), mode: "update",
    data: kind === "asset" && active ? { active, retireReason: null, retireNote: "", retiredAt: null, updatedAt: now() } : { active, updatedAt: now() },
    audit: { action: `${kind}.${active ? "restore" : "remove"}`, targetType: kind, targetId: rec.id, summary: `${active ? (kind === "asset" ? "Returned to service" : "Restored") : "Removed"} ${label}`, before: { active: !active }, after: { active } },
  }]);
  toast(`${active ? "Restored" : "Removed"} ${rec.id}`, "ok");
}

async function forceReturn(a) {
  if (!a) return;
  if (isMyStaff(a.currentHolderId)) return toast(`${a.id} is checked out to you. Scan it at the station to return it, or ask another admin.`, "err", 6000);
  const ok = await confirmDlg({
    title: `Force return ${a.id}?`, confirm: "Mark as returned",
    message: `${esc(a.id)} is checked out to <b>${esc(a.currentHolderName)}</b>. Use this when a device came back without being scanned. It's recorded in the log and the changelog.`,
  });
  if (!ok) return;
  const logRef = F.doc(F.collection(db, "logs"));
  const mins = a.checkedOutAt ? Math.max(0, Math.round((Date.now() - toDate(a.checkedOutAt).getTime()) / 60000)) : null;
  await commit([
    {
      ref: F.doc(db, "assets", a.id), mode: "update",
      data: { status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: logRef.id, updatedAt: now() },
      audit: { action: "asset.force_return", targetType: "asset", targetId: a.id, summary: `Force-returned ${a.id} (was with ${a.currentHolderName})`, before: { status: "out", heldBy: a.currentHolderName }, after: { status: "in" } },
    },
    {
      ref: logRef, mode: "set",
      data: {
        type: "in", assetId: a.id, assetModel: a.model || "", assetCategory: a.category || "", employeeId: a.currentHolderId, employeeName: a.currentHolderName,
        handledById: me.uid, handledByName: `${me.name} (admin)`, heldMinutes: mins, source: "admin", ts: now(),
      },
    },
  ]);
  toast(`${a.id} marked as returned`, "ok");
}

// ═════════════════════════ staff ═════════════════════════
function shownStaff() {
  const q = $("#staffSearch").value.trim().toLowerCase();
  const showRemoved = $("#staffRemoved").checked;
  let rows = cache.staff.filter((s) => showRemoved || s.active);
  if (q) rows = rows.filter((s) => `${s.id} ${s.name} ${s.badgeId || ""}`.toLowerCase().includes(q));
  return rows;
}

function renderStaff() {
  const rows = shownStaff();
  const activeCount = cache.staff.filter((s) => s.active).length;
  $("#staffCount").textContent = `${activeCount} active${cache.staff.length !== activeCount ? ` · ${cache.staff.length - activeCount} removed` : ""}`;

  $("#staffBody").innerHTML = rows.length
    ? rows.map((s) => {
        const held = cache.assets.filter((a) => a.active && a.status === "out" && a.currentHolderId === s.id).map((a) => a.id);
        const open = cache.alerts.filter((a) => a.missedById === s.id).length;
        const mine = isMyStaff(s.id);
        return `<tr class="${s.active ? "" : "dim"}" data-id="${esc(s.id)}">
          <td><input type="checkbox" data-sel ${selectedStaff.has(s.id) ? "checked" : ""} ${s.active ? "" : "disabled"} /></td>
          <td class="mono"><b>${esc(s.id)}</b></td><td class="mono">${s.badgeId ? esc(s.badgeId) : '<span class="muted">—</span>'}</td><td>${esc(s.name)}${mine ? ' <span class="chip blue" title="Your own record. Another admin edits it.">you</span>' : ""}${open ? ` <span class="chip warn" title="Open alerts">${open} alert${open > 1 ? "s" : ""}</span>` : ""}</td>
          <td>${s.active ? '<span class="chip in">Active</span>' : '<span class="chip off">Removed</span>'}</td>
          <td>${pinCell(s)}</td>
          <td>${held.length ? held.map((h) => `<span class="chip out">${esc(h)}</span>`).join(" ") : '<span class="muted">—</span>'}</td>
          <td class="actions">
            ${s.active ? `<a class="btn sm" target="_blank" href="print.html?kind=staff&ids=${encodeURIComponent(s.id)}">Print barcode</a>` : ""}
            ${mine ? '<span class="muted" title="Another admin has to change your own record">locked</span>' : `<button class="btn sm" data-act="edit">Edit</button>
            <button class="btn sm" data-act="pin">PIN…</button>
            ${s.active ? '<button class="btn sm danger" data-act="remove">Remove</button>' : '<button class="btn sm" data-act="restore">Restore</button>'}`}
          </td></tr>`;
      }).join("")
    : emptyRow(8, cache.staff.length ? "No staff match." : "No staff yet. Add someone or import a spreadsheet.");

  const n = selectedStaff.size;
  $("#printStaffSelected").disabled = n === 0;
  $("#pinRequireSel").disabled = n === 0;
  $("#pinClearSel").disabled = n === 0;
  $("#printStaffSelected").textContent = n ? `Print ${n} barcode${n === 1 ? "" : "s"}…` : "Print barcodes…";
  const sel = rows.filter((s) => s.active);
  $("#staffAll").checked = sel.length > 0 && sel.every((s) => selectedStaff.has(s.id));
}

["#staffSearch", "#staffRemoved"].forEach((s) => $(s).addEventListener("input", renderStaff));
$("#staffAll").addEventListener("change", (e) => {
  shownStaff().filter((s) => s.active).forEach((s) => (e.target.checked ? selectedStaff.add(s.id) : selectedStaff.delete(s.id)));
  renderStaff();
});
$("#staffBody").addEventListener("change", (e) => {
  if (!e.target.matches("[data-sel]")) return;
  const id = e.target.closest("tr").dataset.id;
  e.target.checked ? selectedStaff.add(id) : selectedStaff.delete(id);
  renderStaff();
});
$("#printStaffSelected").addEventListener("click", () => openPrint("staff", [...selectedStaff]));
$("#addStaff").addEventListener("click", () => staffForm(null));
$("#exportStaff").addEventListener("click", () =>
  downloadFile("staff.csv", toCSV(["Employee ID", "Badge ID", "Name", "Active"], cache.staff.map((s) => [s.id, s.badgeId || "", s.name, s.active ? "yes" : "no"]))));

$("#staffBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const s = cache.staff.find((x) => x.id === btn.closest("tr").dataset.id);
  if (!s) return;
  if (isMyStaff(s.id)) return toast(SELF_MSG, "err", 6000);
  try {
    if (btn.dataset.act === "edit") staffForm(s);
    if (btn.dataset.act === "pin") pinDialog(s);
    if (btn.dataset.act === "restore") await setActive("staff", s, true);
    if (btn.dataset.act === "remove") await removeStaff(s);
  } catch (err) { toast(explain(err), "err", 6000); }
});

async function removeStaff(s) {
  if (!s) return;
  if (isMyStaff(s.id)) return toast(SELF_MSG, "err", 6000);
  const held = cache.assets.filter((a) => a.active && a.status === "out" && a.currentHolderId === s.id);
  if (held.length) return toast(`${s.name} still has ${held.map((h) => h.id).join(", ")}. Return it first.`, "err", 5000);
  const ok = await confirmDlg({
    title: `Remove ${s.name}?`, danger: true, confirm: "Remove staff member",
    message: `${esc(s.name)} (${esc(s.id)}) will no longer be able to check out devices. Past activity stays in reports, and you can restore them later.`,
  });
  if (ok) { await setActive("staff", s, false); selectedStaff.delete(s.id); dropStale(s.id); }
}

function dropStale(id) { cache.stale = cache.stale.filter((x) => x.staff.id !== id); updateBell(); renderCurrent(); }

async function snoozeStaff(s) {
  if (!s) return;
  if (isMyStaff(s.id)) return toast(SELF_MSG, "err", 6000);
  const until = snoozeUntil(new Date(), SNOOZE_DAYS);
  await commit([{
    ref: F.doc(db, "staff", s.id), mode: "update",
    data: { staleSnoozeUntil: until, updatedAt: now() },
    audit: { action: "staff.snooze", targetType: "staff", targetId: s.id, summary: `Snoozed the inactivity reminder for ${s.name} (${s.id}) until ${fmtDT(until)}`, before: { staleSnoozeUntil: s.staleSnoozeUntil ? toDate(s.staleSnoozeUntil).toISOString() : null }, after: { staleSnoozeUntil: until.toISOString() } },
  }]);
  dropStale(s.id);
  toast(`Snoozed ${s.name} for 2 months`, "ok");
}

function staffForm(existing) {
  const editing = !!existing;
  formDialog({
    title: editing ? `Edit ${existing.name}` : "Add staff member",
    submit: editing ? "Save changes" : "Add staff member",
    body: `<div class="form-grid">
      <label class="f">Employee ID<input name="id" value="${esc(existing?.id ?? "")}" ${editing ? "disabled" : ""} required inputmode="text" /></label>
      <label class="f">Badge number <span class="muted" style="text-transform:none;font-weight:400">(the longer number their badge barcode reads)</span><input name="badge" value="${esc(existing?.badgeId ?? "")}" inputmode="text" /></label>
      <label class="f" style="grid-column:1/-1">Full name<input name="name" value="${esc(existing?.name ?? "")}" required /></label></div>
      <p class="muted" style="font-size:13px;margin-bottom:0">Staff can scan their badge <i>or</i> type/scan their employee ID. Each check-out and check-in records which one they used. Tip: click into the Badge number field and scan their badge to fill it in.</p>`,
    onSubmit: async (fd) => {
      const name = str(fd, "name");
      const badge = norm(fd.get("badge"));
      if (!name) throw new Error("Enter the person's name.");
      if (badge && !validId(badge)) throw new Error("Badge number can only use letters, numbers, dot, dash and underscore (40 characters max).");
      if (editing) {
        const changedName = name !== existing.name, changedBadge = badge !== (existing.badgeId || "");
        if (!changedName && !changedBadge) throw new Error("No changes to save.");
        if (changedBadge && badge) {
          const owner = idOwner(badge);
          if (owner && !(cache.staff.find((x) => x.badgeId === badge)?.id === existing.id)) throw new Error(`“${badge}” is already used by ${owner}.`);
          if (badge === existing.id) throw new Error("The badge number is the same as the employee ID. Leave it blank if the badge shows the employee ID.");
        }
        const ops = [];
        if (changedName) ops.push({
          ref: F.doc(db, "staff", existing.id), mode: "update", data: { name, updatedAt: now() },
          audit: { action: "staff.update", targetType: "staff", targetId: existing.id, summary: `Renamed ${existing.name} → ${name} (${existing.id})`, before: { name: existing.name }, after: { name } },
        });
        if (changedBadge) ops.push(staffBadgeOp({ ...existing, name }, badge));
        // Two audited updates to the same record can't share one batch (one footprint per record), so save in turn.
        for (const op of ops) await commit([op]);
        return toast("Saved", "ok");
      }
      const id = norm(fd.get("id"));
      if (!validId(id)) throw new Error("Employee ID can only use letters, numbers, dot, dash and underscore (40 characters max).");
      const owner = idOwner(id);
      if (owner) throw new Error(`“${id}” is already used by ${owner}.`);
      if (badge) {
        if (badge === id) throw new Error("The badge number is the same as the employee ID. Leave it blank if the badge shows the employee ID.");
        const bo = idOwner(badge);
        if (bo) throw new Error(`Badge number “${badge}” is already used by ${bo}.`);
      }
      await commit([staffCreateOp({ id, name, badgeId: badge })]);
      toast(`Added ${name}`, "ok");
    },
  });
}

// ═════════════════════════ spreadsheet import ═════════════════════════
$("#importAssets").addEventListener("click", () => importDialog("asset"));
$("#importStaff").addEventListener("click", () => importDialog("staff"));
$("#importAdmins").addEventListener("click", () => importAdminsDialog());

const FILE_ACCEPT = ".xlsx,.xls,.csv,.tsv,.txt";
const fileNote = "Excel (.xlsx) and CSV files both work. The first row must be column headers, and the first sheet is used.";

/** Hook up the "Download template" buttons inside an import dialog. */
function wireTemplates(kind) {
  const go = (format) => async () => {
    try {
      const types = kind === "asset" ? activeTypes().map((t) => ({ name: t.name, prefix: prefixOf(t), fields: fieldsOf(t) })) : [];
      await downloadTemplate(kind, format, { types });
      if (kind === "asset" && format === "xlsx" && !types.length) toast("There are no asset types yet, so the drop-down is empty. Add a type under Asset types, then download again.", "info", 7000);
    }
    catch (err) { toast(`${err.message || err} You can use the CSV template instead.`, "err", 6000); }
  };
  $("#tplXlsx").onclick = go("xlsx");
  $("#tplCsv").onclick = go("csv");
}

function importDialog(kind) {
  const isAsset = kind === "asset";
  const example = isAsset
    ? "assetType,model,imei,serial,phoneNumber\nRover phone,iPhone 13,356938035643809,F2LXYZ123,352-555-0101\nFob,,,,"
    : "employeeId,badgeId,name\n10234,1002340077,Jane Doe";
  const d = $("#dlg");
  d.onclose = null;
  const defaultSel = isAsset
    ? `<label class="f" style="margin-top:10px">Asset type for rows without one<select id="impDefault"><option value="">(none: rows must have an assetType)</option>${activeTypes().map((t) => `<option>${esc(t.name)}</option>`).join("")}</select></label>`
    : "";
  const help = isAsset
    ? "Columns: assetType (must already exist under Asset types), and optionally model, imei, serial, phoneNumber. You don't need an ID column: every device is numbered for you with the lowest free number for its type (R001, R002…). Add an assetId column only to choose a specific barcode. Each type's ticked detail fields (model, IMEI, serial, phone number) are required, so rows missing one are skipped, as are rows with an unknown type or a duplicate IMEI, serial or phone number."
    : "Columns: employeeId, name (or firstName and lastName), and optionally badgeId. If someone already exists and the row has a badgeId, their badge number is filled in. Nothing else about them changes.";
  d.innerHTML = `<h2>Import ${isAsset ? "assets" : "staff"} from a spreadsheet</h2>
    <p class="muted" style="margin-top:0">${fileNote} ${help}</p>
<div class="row" style="margin:-4px 0 12px"><span class="muted">Need a blank to fill in?</span><button class="btn sm" type="button" id="tplXlsx">Download Excel template</button><button class="btn sm" type="button" id="tplCsv">Download CSV template</button></div>
        <label class="f">Spreadsheet file<input type="file" id="impFile" accept="${FILE_ACCEPT}" /></label>
    ${defaultSel}
    <label class="f" style="margin-top:10px">…or paste rows<textarea id="impText" placeholder="${esc(example)}"></textarea></label>
    <div id="impPreview" style="margin-top:12px"></div>
    <div class="foot"><button class="btn ghost" id="impClose">Close</button><button class="btn" id="impPrev">Preview</button><button class="btn primary" id="impGo" disabled>Import</button></div>`;

  let parsed = null, fileRows = null;
  const rowsNow = () => fileRows || parseCSV($("#impText").value);
  $("#impClose").onclick = () => d.close();
  wireTemplates(kind);
  $("#impFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await readSpreadsheet(f);
      fileRows = r.rows;
      $("#impText").value = "";
      preview(r.sheet ? `Read sheet “${r.sheet}”.` : "");
    } catch (err) { fileRows = null; $("#impPreview").innerHTML = `<div class="notice">${esc(err.message || String(err))}</div>`; $("#impGo").disabled = true; }
  };
  $("#impText").oninput = () => { fileRows = null; };
  $("#impPrev").onclick = () => preview();
  if ($("#impDefault")) $("#impDefault").onchange = () => (fileRows || $("#impText").value) && preview();

  function preview(prefix = "") {
    const existing = new Set([...cache.assets.map((x) => x.id), ...cache.staff.map((x) => x.id), ...cache.staff.map((x) => x.badgeId).filter(Boolean)]);
    parsed = parseImport(kind, rowsNow(), {
      existingIds: existing, pad: ID_DIGITS,
      existingAssets: cache.assets,
      existingStaff: new Map(cache.staff.map((x) => [x.id, { name: x.name, badgeId: x.badgeId || "" }])),
      knownTypes: activeTypes().map((t) => ({ name: t.name, prefix: prefixOf(t), pad: padOf(t), fields: fieldsOf(t) })),
      defaultType: $("#impDefault")?.value || "",
    });
    const box = $("#impPreview");
    if (parsed.fatal) { box.innerHTML = `<div class="notice">${esc(parsed.fatal)}</div>`; $("#impGo").disabled = true; return; }
    const errs = parsed.errors.slice(0, 15).map((x) => `<li>Row ${x.line}: ${esc(x.message)}</li>`).join("");
    const total = parsed.records.length + parsed.updates.length;
    box.innerHTML = `<p style="margin:0 0 6px">${esc(prefix)} <b>${parsed.records.length}</b> new ${isAsset ? "asset" : "staff member"}${parsed.records.length === 1 ? "" : "s"} ready to import${parsed.updates.length ? `, <b>${parsed.updates.length}</b> existing ${parsed.updates.length === 1 ? "person" : "people"} getting a badge number` : ""}${parsed.errors.length ? `, <b>${parsed.errors.length}</b> skipped` : ""}.
      ${parsed.newTypes?.length ? `<br>New asset types that will be created: <b>${parsed.newTypes.map(esc).join(", ")}</b>.` : ""}</p>
      ${errs ? `<ul class="muted" style="margin:6px 0 0;padding-left:18px;font-size:13px">${errs}${parsed.errors.length > 15 ? `<li>…and ${parsed.errors.length - 15} more</li>` : ""}</ul>` : ""}`;
    $("#impGo").disabled = !total;
    $("#impGo").textContent = `Import ${total}`;
  }

  $("#impGo").onclick = async () => {
    const total = parsed ? parsed.records.length + parsed.updates.length : 0;
    if (!total) return;
    $("#impGo").disabled = true; $("#impPrev").disabled = true;
    const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const size = S.IMPORT_CHUNK;
    let done = 0;
    const progress = () => ($("#impPreview").innerHTML = `<p style="margin:0">Imported ${done} of ${total}…</p>`);
    try {
      // New asset types first, so assets can reference them.
      const newTypes = parsed.newTypes || [];
      for (let i = 0; i < newTypes.length; i += size)
        await commit(newTypes.slice(i, i + size).map((name) => typeCreateOp({ name, prefix: derivePrefix(name) })), batchId);

      for (let i = 0; i < parsed.records.length; i += size) {
        const chunk = parsed.records.slice(i, i + size);
        await commit(chunk.map((r) => (isAsset ? assetCreateOp({ ...r, category: r.assetType }) : staffCreateOp(r))), batchId);
        done += chunk.length;
        progress();
      }
      for (let i = 0; i < parsed.updates.length; i += size) {
        const chunk = parsed.updates.slice(i, i + size);
        await commit(chunk.map((u) => staffBadgeOp({ id: u.id, name: u.name, badgeId: u.previous }, u.badgeId)), batchId);
        done += chunk.length;
        progress();
      }
      toast(`Imported ${done} ${isAsset ? "assets" : "staff records"}`, "ok");
      d.close();
    } catch (err) {
      $("#impPreview").innerHTML = `<div class="notice">Imported ${done} of ${total} before an error: ${esc(explain(err))}<br>Fix the problem and run the import again. Records already added are skipped automatically.</div>`;
      $("#impPrev").disabled = false;
    }
  };
  d.showModal();
}

/** Bulk-create admin or station logins. Each person gets a random password they never see; they set their own from the emailed reset link. */
function importAdminsDialog() {
  const d = $("#dlg");
  d.onclose = null;
  d.innerHTML = `<h2>Import admins from a spreadsheet</h2>
    <p class="muted" style="margin-top:0">${fileNote} Columns: <b>email</b>, <b>name</b>, <b>employeeId</b> (admins are added to the staff list too), and optionally <b>badgeId</b> and <b>role</b> (admin or station; blank = admin). Each person gets an email to set their own password. They can then sign in at the admin page.</p>
<div class="row" style="margin:-4px 0 12px"><span class="muted">Need a blank to fill in?</span><button class="btn sm" type="button" id="tplXlsx">Download Excel template</button><button class="btn sm" type="button" id="tplCsv">Download CSV template</button></div>
        <label class="f">Spreadsheet file<input type="file" id="impFile" accept="${FILE_ACCEPT}" /></label>
    <label class="f" style="margin-top:10px">…or paste rows<textarea id="impText" placeholder="email,name,role,employeeId,badgeId\njordan@example.org,Jordan Lee,admin,10234,1002340077"></textarea></label>
    <div id="impPreview" style="margin-top:12px"></div>
    <div class="foot"><button class="btn ghost" id="impClose">Close</button><button class="btn" id="impPrev">Preview</button><button class="btn primary" id="impGo" disabled>Create logins</button></div>`;
  let parsed = null, fileRows = null;
  const rowsNow = () => fileRows || parseCSV($("#impText").value);
  $("#impClose").onclick = () => d.close();
  wireTemplates("admin");
  $("#impFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { fileRows = (await readSpreadsheet(f)).rows; $("#impText").value = ""; preview(); }
    catch (err) { fileRows = null; $("#impPreview").innerHTML = `<div class="notice">${esc(err.message || String(err))}</div>`; $("#impGo").disabled = true; }
  };
  $("#impText").oninput = () => { fileRows = null; };
  $("#impPrev").onclick = preview;

  function preview() {
    const existing = new Set([...cache.admins, ...cache.stations].map((x) => String(x.email || "").toLowerCase()));
    parsed = parseAdminImport(rowsNow(), {
      existingEmails: existing,
      existingIds: new Set([...cache.assets.map((x) => x.id), ...cache.staff.map((x) => x.id), ...cache.staff.map((x) => x.badgeId).filter(Boolean)]),
      existingStaff: new Set(cache.staff.map((x) => x.id)),
      linkedStaff: new Set(cache.admins.map((x) => x.employeeId).filter(Boolean)),
    });
    const box = $("#impPreview");
    if (parsed.fatal) { box.innerHTML = `<div class="notice">${esc(parsed.fatal)}</div>`; $("#impGo").disabled = true; return; }
    const errs = parsed.errors.slice(0, 15).map((x) => `<li>Row ${x.line}: ${esc(x.message)}</li>`).join("");
    const admins = parsed.records.filter((r) => r.role === "admin").length, stations = parsed.records.length - admins;
    box.innerHTML = `<p style="margin:0 0 6px"><b>${admins}</b> admin${admins === 1 ? "" : "s"}${stations ? ` and <b>${stations}</b> station login${stations === 1 ? "" : "s"}` : ""} ready to create${parsed.errors.length ? `, <b>${parsed.errors.length}</b> skipped` : ""}.</p>
      ${errs ? `<ul class="muted" style="margin:6px 0 0;padding-left:18px;font-size:13px">${errs}${parsed.errors.length > 15 ? `<li>…and ${parsed.errors.length - 15} more</li>` : ""}</ul>` : ""}`;
    $("#impGo").disabled = !parsed.records.length;
  }

  const randomPassword = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return Array.from(bytes, (b) => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[b % 57]).join("");
  };

  $("#impGo").onclick = async () => {
    if (!parsed?.records.length) return;
    $("#impGo").disabled = true; $("#impPrev").disabled = true;
    const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const failed = [];
    let done = 0;
    for (const r of parsed.records) {
      $("#impPreview").innerHTML = `<p style="margin:0">Creating ${done + failed.length + 1} of ${parsed.records.length}: ${esc(r.email)}…</p>`;
      let uid;
      const second = appMod.initializeApp(firebaseConfig, "acct-" + Date.now() + "-" + done + failed.length);
      try {
        const sa = A.getAuth(second);
        uid = (await A.createUserWithEmailAndPassword(sa, r.email, randomPassword())).user.uid;
        await A.signOut(sa);
      } catch (err) { failed.push(`${r.email}: ${friendlyAuthError(err)}`); await appMod.deleteApp(second); continue; }
      await appMod.deleteApp(second);
      try {
        await commit([{
          ref: F.doc(db, r.role === "admin" ? "admins" : "stations", uid), mode: "set",
          data: { email: r.email, name: r.name, active: true, ...(r.employeeId ? { employeeId: r.employeeId } : {}), createdAt: now(), createdBy: me.email, updatedAt: now() },
          audit: { action: `${r.role}.create`, targetType: r.role, targetId: uid, summary: `Created ${r.role} login ${r.name} <${r.email}>${r.employeeId ? `, staff ID ${r.employeeId}` : ""} (spreadsheet import)`, before: null, after: { email: r.email, name: r.name, ...(r.employeeId ? { employeeId: r.employeeId } : {}) } },
        }, ...(r.newStaff ? [staffCreateOp({ id: r.employeeId, name: r.name, badgeId: r.badgeId })] : [])], batchId);
      } catch (err) { failed.push(`${r.email}: login created but not activated (${explain(err)})`); continue; }
      try { await A.sendPasswordResetEmail(auth, r.email); } catch { failed.push(`${r.email}: created, but the password email didn't send. Use “Send password reset” on the Admins tab.`); }
      done++;
    }
    $("#impPreview").innerHTML = `<p style="margin:0 0 6px"><b>${done}</b> of ${parsed.records.length} created.${done ? " Each person was emailed a link to set a password." : ""}</p>
      ${failed.length ? `<div class="notice"><ul style="margin:0;padding-left:18px">${failed.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}`;
    $("#impPrev").disabled = false;
  };
  d.showModal();
}

// ═════════════════════════ reports ═════════════════════════
function initDates() {
  if ($("#rFrom").value) return;
  const t = new Date();
  setRange(7);
  $("#cTo").value = ymd(t);
  $("#cFrom").value = ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29));
}

function setRange(days) {
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  let from = today, to = today;
  if (days === "month") from = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (+days === 1) { from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1); to = from; }
  else if (+days > 1) from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (+days - 1));
  $("#rFrom").value = ymd(from);
  $("#rTo").value = ymd(to);
  $$("#presets .btn").forEach((b) => b.classList.toggle("on", b.dataset.days === String(days)));
}

$("#presets").addEventListener("click", (e) => { const b = e.target.closest("[data-days]"); if (b) setRange(b.dataset.days); });
["#rFrom", "#rTo"].forEach((s) => $(s).addEventListener("input", () => $$("#presets .btn").forEach((b) => b.classList.remove("on"))));
$("#rType").addEventListener("change", () => { $("#rSubject").value = ""; fillReportControls(); });

function fillReportControls() {
  typeSelects();
  const type = $("#rType").value;
  $("#rSubjectWrap").classList.toggle("hidden", type === "all");
  $("#rCategoryWrap").classList.toggle("hidden", type === "asset");
  if (type === "all") return;
  $("#rSubjectLabel").textContent = type === "staff" ? "Staff member" : "Asset";
  $("#rSubjectList").innerHTML = (type === "staff" ? cache.staff : cache.assets)
    .map((x) => `<option value="${esc(x.id)} — ${esc(type === "staff" ? x.name : [x.category, x.model].filter(Boolean).join(" · "))}"></option>`).join("");
}

function parseSubject(type) {
  const raw = $("#rSubject").value.trim();
  if (!raw) return null;
  const id = norm(raw.split(" — ")[0]);
  const rec = (type === "staff" ? cache.staff : cache.assets).find((x) => x.id === id);
  return rec ? { id, label: type === "staff" ? `${rec.name} (${id})` : `${id}${rec.model ? " · " + rec.model : ""}`, rec } : null;
}

$("#rRun").addEventListener("click", runReport);

async function runReport() {
  const type = $("#rType").value;
  if (!$("#rFrom").value || !$("#rTo").value) return toast("Pick a start and end date.", "err");
  const { from, to } = rangeFromInputs($("#rFrom").value, $("#rTo").value);
  if (to <= from) return toast("The end date can't be before the start date.", "err");
  let subject = null;
  if (type !== "all") {
    subject = parseSubject(type);
    if (!subject) return toast(`Pick a ${type === "staff" ? "staff member" : "asset"} from the list.`, "err");
  }
  const category = type === "asset" ? "" : $("#rCategory").value;

  const cons = [];
  if (type === "staff") cons.push(F.where("employeeId", "==", subject.id));
  if (type === "asset") cons.push(F.where("assetId", "==", subject.id));
  cons.push(F.where("ts", ">=", F.Timestamp.fromDate(from)), F.where("ts", "<", F.Timestamp.fromDate(to)), F.orderBy("ts", "desc"), F.limit(REPORT_MAX));

  $("#rOut").innerHTML = '<div class="card"><div class="empty">Running report…</div></div>';
  try {
    const snap = await F.getDocs(F.query(F.collection(db, "logs"), ...cons));
    let logs = snap.docs.map((d) => normalizeLog(d.id, d.data()));
    const capped = logs.length >= REPORT_MAX;
    if (category) logs = logs.filter((l) => l.assetCategory === category);
    lastReport = { type, subject, category, fromStr: $("#rFrom").value, toStr: $("#rTo").value, logs, capped };
    renderReport();
  } catch (e) {
    console.error(e);
    $("#rOut").innerHTML = `<div class="card"><div class="notice">${esc(explain(e))}</div></div>`;
  }
}

const dateLabel = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); };

function renderReport() {
  const r = lastReport;
  const sum = summarize(r.logs);
  const title = (r.type === "all" ? "All staff & assets" : r.type === "staff" ? `Staff: ${r.subject.label}` : `Asset: ${r.subject.label}`) + (r.category ? ` · ${r.category} only` : "");
  const range = r.fromStr === r.toStr ? dateLabel(r.fromStr) : `${dateLabel(r.fromStr)} – ${dateLabel(r.toStr)}`;
  const stat = (n, l, c = "") => `<div class="stat ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`;

  let stats = stat(sum.checkouts, "Check-outs", "o") + stat(sum.returns, "Returns", "g") + stat(sum.missed, "Not returned", sum.missed ? "w" : "") + stat(fmtDur(sum.heldMinutes), "Time held (returned)", "b");
  if (r.type === "all") stats += stat(sum.uniqueStaff, "Staff active") + stat(sum.uniqueAssets, "Assets used");
  if (r.type === "staff") {
    const now_ = cache.assets.filter((a) => a.active && a.status === "out" && a.currentHolderId === r.subject.id).map((a) => a.id);
    stats += stat(sum.uniqueAssets, "Assets used") + stat(now_.length ? now_.join(", ") : "None", "Has right now", now_.length ? "w" : "");
  }
  if (r.type === "asset") {
    const a = r.subject.rec;
    stats += stat(sum.uniqueStaff, "Staff who used it") + stat(a.status === "out" ? esc(a.currentHolderName) : "In", "Right now", a.status === "out" ? "w" : "g");
  }

  const missedCell = (n) => (n ? `<span class="chip warn">${n}</span>` : "0");
  const staffTable = () => `<h3 class="sec">${r.type === "asset" ? "Staff who used this asset" : "By staff"}</h3>
    <div class="table-wrap"><table><thead><tr><th>Employee</th><th>ID</th><th>Check-outs</th><th>Returns</th><th>Not returned</th><th>Badge scans</th><th>Typed/scanned ID</th><th>Time held</th><th>Last activity</th></tr></thead><tbody>
    ${sum.perStaff.map((s) => row([`<b>${esc(s.employeeName)}</b>`, { h: `<span class="mono">${esc(s.employeeId)}</span>` }, s.checkouts, s.returns, { h: missedCell(s.missed) }, s.badge, s.eid, fmtDur(s.heldMinutes), fmtDT(s.last)])).join("") || emptyRow(9, "No activity.")}</tbody></table></div>`;
  const assetTable = () => `<h3 class="sec">${r.type === "staff" ? "Assets this person used" : "By asset"}</h3>
    <div class="table-wrap"><table><thead><tr><th>Asset</th><th>Type</th><th>Model</th><th>Check-outs</th><th>Returns</th><th>Not returned</th><th>Time held</th><th>Last held by</th></tr></thead><tbody>
    ${sum.perAsset.map((a) => row([{ h: `<span class="mono"><b>${esc(a.assetId)}</b></span>` }, { h: typeChip(a.assetCategory) }, esc(a.assetModel), a.checkouts, a.returns, { h: missedCell(a.missed) }, fmtDur(a.heldMinutes), `${esc(a.lastHolder)} <span class="sub">${fmtDT(a.last)}</span>`])).join("") || emptyRow(8, "No activity.")}</tbody></table></div>`;

  const shown = r.logs.slice(0, 500);
  const activity = `<h3 class="sec">Activity</h3>
    <div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Asset</th><th>Type</th><th>Employee</th><th>ID used</th><th>Held</th><th>Source</th></tr></thead><tbody>
    ${shown.map((l) => row([fmtDT(l.ts), { h: actionCell(l) }, { h: `<span class="mono">${esc(l.assetId)}</span>` }, { h: typeChip(l.assetCategory) }, `${esc(l.employeeName)} <span class="sub mono">${esc(l.employeeId)}</span>`, esc(idMethodLabel(l) || "—"), l.type === "in" ? fmtDur(l.heldMinutes) : "—", esc(l.source)])).join("") || emptyRow(8, "No activity in this period.")}</tbody></table></div>
    ${r.logs.length > 500 ? `<p class="muted">Showing the 500 most recent of ${r.logs.length} entries. The CSV export has them all.</p>` : ""}
    ${r.capped ? `<div class="notice" style="margin-top:10px">Only the most recent ${REPORT_MAX} entries are included. Narrow the date range for a complete picture.</div>` : ""}`;

  $("#rOut").innerHTML = `<div class="card">
    <div class="card-head"><div><h2>${esc(title)}</h2><p class="rpt-title" style="margin:2px 0 0">${esc(range)} · generated ${new Date().toLocaleString()} by ${esc(me.name)}</p></div>
      <div class="spacer"></div><div class="row no-print"><button class="btn" id="rCsv">Export activity CSV</button><button class="btn" id="rSumCsv">Export summary CSV</button><button class="btn" id="rPrint">Print</button></div></div>
    <div class="stats">${stats}</div>
    ${r.type === "all" ? staffTable() + assetTable() : r.type === "staff" ? assetTable() : staffTable()}
    ${activity}</div>`;

  const slug = `${r.type}${r.subject ? "-" + r.subject.id : ""}${r.category ? "-" + slugify(r.category) : ""}_${r.fromStr}_to_${r.toStr}`;
  $("#rCsv").onclick = () => downloadFile(`activity_${slug}.csv`, toCSV(ACTIVITY_HEADERS, activityRows(r.logs)));
  $("#rPrint").onclick = () => window.print();
  $("#rSumCsv").onclick = () => {
    const parts = [];
    if (r.type !== "staff") parts.push(toCSV(["Employee ID", "Employee", "Check-outs", "Returns", "Not returned", "Minutes held", "Last activity"], sum.perStaff.map((s) => [s.employeeId, s.employeeName, s.checkouts, s.returns, s.missed, s.heldMinutes, s.last ? s.last.toLocaleString() : ""])));
    if (r.type !== "asset") parts.push(toCSV(["Asset ID", "Type", "Model", "Check-outs", "Returns", "Not returned", "Minutes held", "Last held by"], sum.perAsset.map((a) => [a.assetId, a.assetCategory, a.assetModel, a.checkouts, a.returns, a.missed, a.heldMinutes, a.lastHolder])));
    downloadFile(`summary_${slug}.csv`, parts.join("\r\n\r\n"));
  };
}

// ═════════════════════════ admins & station logins ═════════════════════════
/** Put an admin on the staff list (or link them to a staff record that already exists) so they can check devices out. */
function linkStaffDialog(adminRec) {
  const own = adminRec.id === me.uid;
  formDialog({
    title: own ? "Add yourself to the staff list" : `Add ${adminRec.name || adminRec.email} to the staff list`,
    submit: "Add to staff",
    body: `<p class="muted" style="margin-top:0">${own ? "This lets you scan your badge or type your employee ID at the check-out station like everyone else. " : "This lets them check devices out like any other staff member. "}Once linked, ${own ? "you" : "they"} can't edit ${own ? "your" : "their"} own staff record or force-return a device ${own ? "you're" : "they're"} holding; another admin has to. ${own ? "That's a one-time step." : ""}</p>
      <div class="form-grid">
        <label class="f">Employee ID<input name="id" required inputmode="text" /></label>
        <label class="f">Badge number <span class="muted" style="text-transform:none;font-weight:400">(optional)</span><input name="badge" inputmode="text" /></label>
        <label class="f" style="grid-column:1/-1">Full name<input name="name" required value="${esc(adminRec.name || "")}" /></label></div>`,
    onSubmit: async (fd) => {
      const id = norm(fd.get("id")), badge = norm(fd.get("badge")), name = str(fd, "name");
      if (!name) throw new Error("Enter the person's name.");
      if (!validId(id)) throw new Error("Employee ID can only use letters, numbers, dot, dash and underscore (40 characters max).");
      const ops = await adminStaffOps(adminRec, id, badge, name);
      await commit(ops);
      toast(`${adminRec.name || adminRec.email} is now on the staff list as ${id}`, "ok");
    },
  });
}

/** Checks, then returns the ops that link an existing admin to staff ID `id` (creating the staff record if there isn't one). */
async function adminStaffOps(adminRec, id, badge, name) {
  const taken = cache.admins.find((x) => x.employeeId === id && x.id !== adminRec.id);
  if (taken) throw new Error(`Employee ID ${id} already belongs to admin ${taken.name || taken.email}.`);
  const existing = cache.staff.find((x) => x.id === id);
  const ops = [];
  if (existing) {
    if (badge && badge !== existing.badgeId) throw new Error(`${id} is already on the staff list (${existing.name}). Leave the badge number blank, or change it from the Staff tab.`);
  } else {
    const owner = idOwner(id);
    if (owner) throw new Error(`“${id}” is already used by ${owner}.`);
    if (badge) {
      if (badge === id) throw new Error("The badge number is the same as the employee ID. Leave it blank if the badge shows the employee ID.");
      const bo = idOwner(badge);
      if (bo) throw new Error(`Badge number “${badge}” is already used by ${bo}.`);
    }
    ops.push(staffCreateOp({ id, name, badgeId: badge }));
  }
  ops.push(adminLinkOp(adminRec, id));
  return ops;
}

function renderAdmins() {
  const rowFor = (kind) => (u) => {
    const self = kind === "admin" && u.id === me.uid;
    return `<tr class="${u.active ? "" : "dim"}" data-id="${esc(u.id)}" data-kind="${kind}">
      <td><b>${esc(u.name || "—")}</b>${self ? ' <span class="chip blue">you</span>' : ""}${kind === "admin" ? (u.employeeId ? `<div class="sub">Staff ID <span class="mono">${esc(u.employeeId)}</span></div>` : '<div class="sub">Not on the staff list yet</div>') : ""}</td><td>${esc(u.email)}</td>
      <td>${u.active ? '<span class="chip in">Active</span>' : '<span class="chip off">Deactivated</span>'}</td>
      <td>${fmtDT(u.createdAt)}${u.createdBy ? `<div class="sub">by ${esc(u.createdBy)}</div>` : ""}</td>
      <td class="actions">
        ${kind === "admin" ? '<button class="btn sm" data-act="activity">View activity</button>' : ""}
        ${kind === "admin" && !u.employeeId ? '<button class="btn sm primary" data-act="link">Add to staff</button>' : ""}
        <button class="btn sm" data-act="reset">Send password reset</button>
        ${self ? "" : u.active ? '<button class="btn sm danger" data-act="deactivate">Deactivate</button>' : '<button class="btn sm" data-act="reactivate">Reactivate</button>'}
      </td></tr>`;
  };
  $("#adminsBody").innerHTML = cache.admins.map(rowFor("admin")).join("") || emptyRow(5, "No administrators.");
  $("#stationsBody").innerHTML = cache.stations.map(rowFor("station")).join("") || emptyRow(5, "No station logins yet. Add one for the check-out computer.");
}

$("#tab-admins").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  const tr = btn?.closest("tr");
  if (!btn || !tr) return;
  const kind = tr.dataset.kind;
  const u = (kind === "admin" ? cache.admins : cache.stations).find((x) => x.id === tr.dataset.id);
  if (!u) return;
  try {
    if (btn.dataset.act === "link") return linkStaffDialog(u);
    if (btn.dataset.act === "activity") { $("#cAdmin").value = u.id; showTab("changelog"); $("#cAdmin").value = u.id; return runChangelog(); }
    if (btn.dataset.act === "reset") {
      await A.sendPasswordResetEmail(auth, u.email);
      return toast(`Password reset email sent to ${u.email}`, "ok");
    }
    const activate = btn.dataset.act === "reactivate";
    const ok = await confirmDlg({
      title: `${activate ? "Reactivate" : "Deactivate"} ${u.name || u.email}?`, danger: !activate, confirm: activate ? "Reactivate" : "Deactivate",
      message: activate ? `${esc(u.email)} will be able to sign in again.` : `${esc(u.email)} will lose access immediately. Their past changes stay in the changelog.`,
    });
    if (!ok) return;
    await commit([{
      ref: F.doc(db, kind === "admin" ? "admins" : "stations", u.id), mode: "update", data: { active: activate, updatedAt: now() },
      audit: { action: `${kind}.${activate ? "reactivate" : "deactivate"}`, targetType: kind, targetId: u.id, summary: `${activate ? "Reactivated" : "Deactivated"} ${kind} login ${u.email}`, before: { active: !activate }, after: { active: activate } },
    }]);
    toast(`${activate ? "Reactivated" : "Deactivated"} ${u.email}`, "ok");
  } catch (err) { toast(String(err?.code || "").startsWith("auth/") ? friendlyAuthError(err) : explain(err), "err", 6000); }
});

$("#addAdmin").addEventListener("click", () =>
  formDialog({
    title: "Add admin or station login", submit: "Create login",
    body: `<div class="form-grid">
      <label class="f">Type<select name="role"><option value="admin">Administrator (full access)</option><option value="station">Station login (scan screen only)</option></select></label>
      <label class="f">Name or label<input name="name" required placeholder="e.g. Jordan Lee / Dispatch desk" /></label>
      <label class="f">Email<input name="email" type="email" required autocomplete="off" /></label>
      <label class="f">Temporary password<input name="pw" type="text" required minlength="8" autocomplete="off" placeholder="8+ characters" /></label>
      <label class="f" id="adminEmpWrap">Employee ID <span class="muted" style="text-transform:none;font-weight:400">(they're added to staff too)</span><input name="empId" inputmode="text" /></label>
      <label class="f" id="adminBadgeWrap">Badge number <span class="muted" style="text-transform:none;font-weight:400">(optional)</span><input name="badge" inputmode="text" /></label></div>
      <p class="muted" style="font-size:13px;margin-bottom:0">Share the temporary password privately. They can change it any time with “Send password reset”. Administrators are also added to the staff list so they can check devices out; they can't edit their own staff record or devices they hold.</p>`,
    onOpen: (d) => {
      const sync = () => { const isAdmin = $("[name=role]", d).value === "admin"; $("#adminEmpWrap", d).classList.toggle("hidden", !isAdmin); $("#adminBadgeWrap", d).classList.toggle("hidden", !isAdmin); };
      $("[name=role]", d).addEventListener("change", sync);
      sync();
    },
    onSubmit: async (fd) => {
      const role = str(fd, "role"), name = str(fd, "name"), email = str(fd, "email").toLowerCase(), pw = String(fd.get("pw") || "");
      if (pw.length < 8) throw new Error("Password must be at least 8 characters.");
      // Check the staff details BEFORE creating the login, so a typo doesn't leave a half-made account behind.
      let empId = "", badge = "", staffOps = [];
      if (role === "admin") {
        empId = norm(fd.get("empId")); badge = norm(fd.get("badge"));
        if (!empId) throw new Error("Enter their employee ID so they're added to the staff list too.");
        if (!validId(empId)) throw new Error("Employee ID can only use letters, numbers, dot, dash and underscore (40 characters max).");
        staffOps = (await adminStaffOps({ id: "(new)", name, email }, empId, badge, name)).filter((o) => o.ref.path.startsWith("staff/"));
      }

      // Create the login on a throw-away second app instance so this admin stays signed in.
      const second = appMod.initializeApp(firebaseConfig, "acct-" + Date.now());
      let uid;
      try {
        const sa = A.getAuth(second);
        uid = (await A.createUserWithEmailAndPassword(sa, email, pw)).user.uid;
        await A.signOut(sa);
      } catch (err) { throw new Error(friendlyAuthError(err)); }
      finally { await appMod.deleteApp(second); }

      const kind = role === "admin" ? "admin" : "station";
      try {
        await commit([{
          ref: F.doc(db, kind === "admin" ? "admins" : "stations", uid), mode: "set",
          data: { email, name, active: true, ...(empId ? { employeeId: empId } : {}), createdAt: now(), createdBy: me.email, updatedAt: now() },
          audit: { action: `${kind}.create`, targetType: kind, targetId: uid, summary: `Created ${kind} login ${name} <${email}>${empId ? `, staff ID ${empId}` : ""}`, before: null, after: { email, name, ...(empId ? { employeeId: empId } : {}) } },
        }, ...staffOps]);
      } catch (err) {
        throw new Error(`The login was created but couldn't be activated (${explain(err)}). Try adding the same email again after deleting it in Firebase Console → Authentication.`);
      }
      toast(`Created ${kind} login for ${email}`, "ok");
    },
  })
);

// ═════════════════════════ changelog ═════════════════════════
function fillAdminSelect() {
  const sel = $("#cAdmin");
  const keep = sel.value;
  sel.innerHTML = '<option value="">All admins</option>' + cache.admins.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.email)} — ${esc(a.email)}</option>`).join("");
  sel.value = keep;
}

$("#cRun").addEventListener("click", runChangelog);
$("#cText").addEventListener("input", renderChangelog);

async function runChangelog() {
  if (!$("#cFrom").value || !$("#cTo").value) return toast("Pick a start and end date.", "err");
  const { from, to } = rangeFromInputs($("#cFrom").value, $("#cTo").value);
  const uid = $("#cAdmin").value;
  const cons = [];
  if (uid) cons.push(F.where("adminUid", "==", uid));
  cons.push(F.where("ts", ">=", F.Timestamp.fromDate(from)), F.where("ts", "<", F.Timestamp.fromDate(to)), F.orderBy("ts", "desc"), F.limit(1000));
  $("#cOut").innerHTML = '<div class="card"><div class="empty">Loading…</div></div>';
  try {
    const snap = await F.getDocs(F.query(F.collection(db, "auditLog"), ...cons));
    lastAudit = snap.docs.map((d) => ({ id: d.id, ...d.data(), ts: toDate(d.data().ts) }));
    renderChangelog();
  } catch (e) {
    console.error(e);
    $("#cOut").innerHTML = `<div class="card"><div class="notice">${esc(explain(e))}</div></div>`;
  }
}

const diffHTML = (b, a) => {
  if (!b && !a) return "—";
  const keys = [...new Set([...Object.keys(b || {}), ...Object.keys(a || {})])];
  const lines = keys.filter((k) => JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k]))
    .map((k) => `${k}: ${b && k in b ? JSON.stringify(b[k]) : "∅"} → ${a && k in a ? JSON.stringify(a[k]) : "∅"}`);
  return esc(lines.join("\n") || "(no field changes)");
};

function filteredAudit() {
  const q = $("#cText").value.trim().toLowerCase();
  return q ? lastAudit.filter((x) => `${x.action} ${x.targetType} ${x.targetId} ${x.summary} ${x.adminName} ${x.adminEmail}`.toLowerCase().includes(q)) : lastAudit;
}

function renderChangelog() {
  if (!$("#cOut").innerHTML.trim()) return;
  const rows = filteredAudit();
  $("#cOut").innerHTML = `<div class="card"><div class="card-head"><h3>${rows.length} change${rows.length === 1 ? "" : "s"}</h3>${lastAudit.length >= 1000 ? '<span class="muted">Showing the latest 1000. Narrow the dates for more.</span>' : ""}</div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Record</th><th>What changed</th><th></th></tr></thead><tbody>
    ${rows.map((x, i) => `<tr data-i="${i}">
      <td style="white-space:nowrap">${esc(fmtFull(x.ts))}</td>
      <td>${esc(x.adminName)}<div class="sub">${esc(x.adminEmail)}</div></td>
      <td><span class="chip blue">${esc(x.action)}</span>${x.batchId ? ' <span class="chip off">bulk</span>' : ""}</td>
      <td class="mono">${esc(x.targetType)}${x.targetType === "session" ? "" : ` · ${esc(x.targetId)}`}</td>
      <td>${esc(x.summary)}</td>
      <td class="actions">${x.before || x.after ? '<button class="btn sm" data-detail>Details</button>' : ""}</td></tr>
      <tr class="detail-row hidden" data-d="${i}"><td colspan="6"><pre class="json">${diffHTML(x.before, x.after)}</pre></td></tr>`).join("") || emptyRow(6, "No changes in this period.")}
    </tbody></table></div></div>`;
}

$("#cOut").addEventListener("click", (e) => {
  const b = e.target.closest("[data-detail]");
  if (!b) return;
  $(`tr[data-d="${b.closest("tr").dataset.i}"]`, $("#cOut")).classList.toggle("hidden");
});

$("#cExport").addEventListener("click", () => {
  if (!lastAudit.length) return toast("Run the changelog first.", "err");
  downloadFile("changelog.csv", toCSV(["When", "Admin", "Admin email", "Action", "Record type", "Record ID", "Summary", "Before", "After", "Batch"],
    filteredAudit().map((x) => [fmtFull(x.ts), x.adminName, x.adminEmail, x.action, x.targetType, x.targetId, x.summary, JSON.stringify(x.before ?? ""), JSON.stringify(x.after ?? ""), x.batchId || ""])));
});


// ═════════════════════════ out of service (lost / stolen / repair / retired) ═════════════════════════
/** Ops that take a device out of service. A device that is checked out can only be marked Lost or Stolen
 *  (it's gone): that also logs it as returned-by-admin so the holder isn't blamed forever. */
function outOfServiceOps(a, reason, note) {
  const isOut = a.status === "out";
  if (isMyStaff(a.currentHolderId)) throw new Error(`${a.id} is checked out to you. Scan it at the station to return it, or ask another admin to change it.`);
  if (isOut && !["lost", "stolen"].includes(reason))
    throw new Error(`${a.id} is checked out to ${a.currentHolderName}. Force return it first, or choose Lost or Stolen.`);
  const label = reasonLabel(reason);
  const ops = [];
  const logRef = F.doc(F.collection(db, "logs"));
  const data = { active: false, retireReason: reason, retireNote: note, retiredAt: now(), updatedAt: now() };
  if (isOut) Object.assign(data, { status: "in", currentHolderId: null, currentHolderName: null, checkedOutAt: null, lastLogId: logRef.id });
  ops.push({
    ref: F.doc(db, "assets", a.id), mode: "update", data,
    audit: {
      action: "asset.remove", targetType: "asset", targetId: a.id,
      summary: `Took ${a.id} out of service: ${label}${note ? ` (${note})` : ""}${isOut ? `, was with ${a.currentHolderName}` : ""}`,
      before: { active: true, status: a.status }, after: { active: false, retireReason: reason, retireNote: note },
    },
  });
  if (isOut) {
    const mins = a.checkedOutAt ? Math.max(0, Math.round((Date.now() - toDate(a.checkedOutAt).getTime()) / 60000)) : null;
    ops.push({
      ref: logRef, mode: "set",
      data: {
        type: "in", assetId: a.id, assetModel: a.model || "", assetCategory: a.category || "", employeeId: a.currentHolderId, employeeName: a.currentHolderName,
        handledById: me.uid, handledByName: `${me.name} (admin)`, heldMinutes: mins, source: "admin", note: `Marked ${label.toLowerCase()}`, ts: now(),
      },
    });
  }
  return ops;
}

function outOfServiceDialog(a, preset = "removed") {
  const isOut = a.status === "out";
  formDialog({
    title: `Take ${a.id} out of service`, submit: "Take out of service",
    body: `<p class="muted" style="margin-top:0">${isOut ? `It's checked out to <b>${esc(a.currentHolderName)}</b>. Marking it <b>Lost</b> or <b>Stolen</b> closes that out and logs it as returned by you. ` : ""}It stops working at the scan station (anyone who scans it is told why). History is kept, and you can return it to service any time, for example if it turns up.</p>
      <div class="form-grid" style="grid-template-columns:1fr">
        <label class="f">Reason<select name="reason">${RETIRE_REASONS.map((r) => `<option value="${r.key}" ${r.key === preset ? "selected" : ""}>${esc(r.label)} (${esc(r.hint)})</option>`).join("")}</select></label>
        <label class="f">Note (optional)<input name="note" maxlength="200" placeholder="e.g. last seen at ED triage" /></label>
      </div>`,
    onSubmit: async (fd) => {
      await commit(outOfServiceOps(a, str(fd, "reason"), str(fd, "note")));
      selectedAssets.delete(a.id);
      toast(`${a.id} is now out of service (${reasonLabel(str(fd, "reason"))})`, "ok");
    },
  });
}

// ═════════════════════════ reported problems ═════════════════════════
const ISSUE_RESOLUTIONS = ["Fixed or cleaned", "Not a real problem", "Sent for repair (take out of service)", "Replaced", "Other (see note)"];

function issueDialog(i) {
  if (!i) return;
  formDialog({
    title: `Resolve: ${i.assetId}, ${i.problem}`, submit: "Mark resolved",
    body: `<p class="muted" style="margin-top:0"><b>${esc(i.reportedByName)}</b> reported: <b>${esc(i.problem)}</b>${i.note ? ` (“${esc(i.note)}”)` : ""}.</p>
      <div class="form-grid" style="grid-template-columns:1fr">
        <label class="f">Outcome<select name="resolution">${ISSUE_RESOLUTIONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
        <label class="f">Note (optional)<textarea name="note" style="min-height:70px;font-family:var(--sans)"></textarea></label>
      </div>
      <p class="muted" style="font-size:13px;margin-bottom:0">“Sent for repair” also takes the device out of service so nobody can check it out. Return it to service from the Assets tab when it's back.</p>`,
    onSubmit: async (fd) => {
      const resolution = str(fd, "resolution"), note = str(fd, "note");
      if (resolution.startsWith("Other") && !note) throw new Error("Add a short note for “Other”.");
      const ops = [];
      if (resolution.startsWith("Sent for repair")) {
        const a = cache.assets.find((x) => x.id === i.assetId);
        if (a?.active) ops.push(...outOfServiceOps(a, "repair", note || i.problem));
      }
      ops.push({
        ref: F.doc(db, "issues", i.id), mode: "update",
        data: { status: "resolved", resolution, note, resolvedAt: now(), resolvedByName: me.name, resolvedByEmail: me.email, updatedAt: now() },
        audit: {
          action: "issue.resolve", targetType: "issue", targetId: i.id,
          summary: `Resolved problem on ${i.assetId} (${i.problem}): ${resolution}`,
          before: { status: "open" }, after: { status: "resolved", resolution, note },
        },
      });
      await commit(ops);
      toast("Problem resolved", "ok");
    },
  });
}

// ═════════════════════════ PINs (per person) ═════════════════════════
function pinCell(s) {
  const bits = [];
  if (s.pinHash) bits.push('<span class="chip in">PIN set</span>');
  if (s.pinRequired) bits.push('<span class="chip blue">required</span>');
  return bits.join(" ") || '<span class="muted">—</span>';
}

function pinDialog(s) {
  const hasPin = !!s.pinHash;
  formDialog({
    title: `PIN for ${s.name}`, submit: "Save",
    body: `<p class="muted" style="margin-top:0">${hasPin ? "They have set a PIN. You can't see it." : "They haven't set a PIN yet. They'll create one the first time the station asks."}</p>
      <label class="row" style="gap:8px"><input type="checkbox" name="required" ${s.pinRequired ? "checked" : ""} style="width:auto" /> Require a PIN for this person <span class="muted">(used when PIN mode is “Selected people”)</span></label>
      ${hasPin ? '<label class="row" style="gap:8px;margin-top:10px"><input type="checkbox" name="reset" style="width:auto" /> Reset their PIN (they\'ll create a new one next time)</label>' : ""}`,
    onSubmit: async (fd) => {
      const required = fd.get("required") === "on", reset = fd.get("reset") === "on";
      if (required === !!s.pinRequired && !reset) throw new Error("No changes to save.");
      const data = { pinRequired: required, updatedAt: now() };
      if (reset) Object.assign(data, { pinHash: null, pinSalt: null, pinSetAt: null });
      await commit([{
        ref: F.doc(db, "staff", s.id), mode: "update", data,
        audit: {
          action: reset ? "staff.pin_reset" : "staff.pin", targetType: "staff", targetId: s.id,
          summary: `${reset ? "Reset PIN for" : "Changed PIN requirement for"} ${s.name} (${s.id})${required !== !!s.pinRequired ? `: ${required ? "now required" : "no longer required"}` : ""}`,
          before: { pinRequired: !!s.pinRequired, hasPin }, after: { pinRequired: required, hasPin: reset ? false : hasPin },
        },
      }]);
      toast("Saved", "ok");
    },
  });
}

async function bulkPinRequired(required) {
  const people = cache.staff.filter((x) => x.active && selectedStaff.has(x.id) && !isMyStaff(x.id) && !!x.pinRequired !== required);
  if (!people.length) return toast(required ? "They already require a PIN." : "None of them require a PIN.", "info");
  const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  try {
    for (let i = 0; i < people.length; i += S.IMPORT_CHUNK)
      await commit(people.slice(i, i + S.IMPORT_CHUNK).map((p) => ({
        ref: F.doc(db, "staff", p.id), mode: "update", data: { pinRequired: required, updatedAt: now() },
        audit: { action: "staff.pin", targetType: "staff", targetId: p.id, summary: `${required ? "Required" : "No longer requiring"} a PIN for ${p.name} (${p.id})`, before: { pinRequired: !!p.pinRequired }, after: { pinRequired: required } },
      })), batchId);
    toast(`${required ? "PIN now required for" : "PIN no longer required for"} ${people.length} ${people.length === 1 ? "person" : "people"}`, "ok");
  } catch (e) { toast(explain(e), "err", 6000); }
}
$("#pinRequireSel").addEventListener("click", () => bulkPinRequired(true));
$("#pinClearSel").addEventListener("click", () => bulkPinRequired(false));

// ═════════════════════════ inventory count ═════════════════════════
const assetLabel = (a) => `${a.id}${a.model || a.category ? ` · ${a.model || a.category}` : ""}`;

function renderInventory() {
  const keep = $("#invScope").value;
  $("#invScope").innerHTML = '<option value="">All asset types</option>' + activeTypes().map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  $("#invScope").value = keep;
  $("#invSetup").classList.toggle("hidden", !!inv);
  $("#invRun").classList.toggle("hidden", !inv);
  if (inv) drawInventory();
  drawCountHistory();
}

function invSummary() {
  return summarizeCount({ assets: cache.assets, scanned: [...inv.scanned], unknown: inv.unknown, scope: inv.scope });
}

function drawInventory() {
  const r = invSummary();
  const byId = new Map(cache.assets.map((a) => [a.id, a]));
  $("#invTitle").textContent = `Counting ${inv.scope || "all devices"}: ${r.found.length} of ${r.expected.length} found`;
  $("#invBar").style.width = r.expected.length ? `${Math.round((r.found.length / r.expected.length) * 100)}%` : "100%";
  const li = (a, btns = "") => `<li data-id="${esc(a.id)}" style="margin:4px 0">${esc(assetLabel(a))} ${btns}</li>`;
  const missing = r.missing.map((id) => li(byId.get(id), '<button class="btn sm danger" data-act="inv-lost">Mark lost…</button>')).join("");
  const attention = [
    ...r.outButPresent.map((id) => li(byId.get(id), `<span class="chip warn">system says OUT to ${esc(byId.get(id).currentHolderName)}</span> <button class="btn sm" data-act="inv-checkin">Check it in</button>`)),
    ...r.outOfService.map((id) => li(byId.get(id), `<span class="chip off">out of service · ${esc(reasonLabel(byId.get(id).retireReason))}</span> <button class="btn sm" data-act="inv-restore">Return to service</button>`)),
    ...r.outOfScope.map((id) => `<li style="margin:4px 0">${esc(assetLabel(byId.get(id)))} <span class="muted">not part of this count</span></li>`),
    ...r.unknown.map((c) => `<li style="margin:4px 0"><span class="mono">${esc(c)}</span> <span class="muted">not a known device</span></li>`),
  ].join("");
  const outCount = cache.assets.filter((a) => a.active && a.status === "out" && (!inv.scope || a.category === inv.scope)).length;
  $("#invLists").innerHTML = `<div class="cols3">
      <div><h4>Still missing (${r.missing.length})</h4>${missing ? `<ul style="margin:0;padding-left:18px">${missing}</ul>` : `<p class="muted">${r.expected.length ? "Everything expected has been scanned. ✓" : "Nothing is expected in the drawer."}</p>`}</div>
      <div><h4>Found (${r.found.length})</h4><div class="idlist">${r.found.map((id) => `<span class="chip in mono">${esc(id)}</span>`).join("") || '<span class="muted">Nothing scanned yet.</span>'}</div></div>
      <div><h4>Needs attention (${r.outButPresent.length + r.outOfService.length + r.unknown.length})</h4>${attention ? `<ul style="margin:0;padding-left:18px">${attention}</ul>` : '<p class="muted">Nothing odd so far.</p>'}</div>
    </div>
    <p class="muted" style="margin-bottom:0">${outCount} device${outCount === 1 ? " is" : "s are"} checked out to staff, so not expected in the drawer.</p>`;
}

$("#invStart").addEventListener("click", () => {
  inv = { scope: $("#invScope").value, scanned: new Set(), unknown: [], startedAt: new Date() };
  $("#invMsg").textContent = "";
  renderInventory();
  $("#invScan").focus();
});
$("#invCancel").addEventListener("click", async () => {
  if (inv.scanned.size && !(await confirmDlg({ title: "Cancel this count?", message: "Nothing has been saved. The scans so far will be discarded.", confirm: "Discard count", danger: true }))) return;
  inv = null; renderInventory();
});

$("#invScan").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !inv) return;
  e.preventDefault();
  const code = norm($("#invScan").value);
  $("#invScan").value = "";
  if (!code) return;
  const msg = (t, kind) => { $("#invMsg").textContent = t; $("#invMsg").style.color = kind === "bad" ? "var(--orange-hi)" : kind === "ok" ? "var(--ok)" : ""; };
  const byId = new Map(cache.assets.map((a) => [a.id, a]));
  const k = classifyScan(code, byId, inv.scope);
  if (k.kind === "unknown") {
    if (!inv.unknown.includes(code)) inv.unknown.push(code);
    beep("error"); msg(`“${code}” isn't a known device.`, "bad");
  } else if (inv.scanned.has(code)) {
    msg(`${code} was already counted.`, "");
  } else {
    inv.scanned.add(code);
    if (k.kind === "found") { beep("ok"); msg(`✓ ${assetLabel(k.asset)}`, "ok"); }
    else if (k.kind === "outButPresent") { beep("error"); msg(`${code} is marked OUT to ${k.asset.currentHolderName}, but it's here. See “Needs attention”.`, "bad"); }
    else if (k.kind === "outOfService") { beep("error"); msg(`${code} is out of service (${reasonLabel(k.asset.retireReason)}) but it's here.`, "bad"); }
    else msg(`${code} isn't part of this count (${k.asset.category}).`, "");
  }
  drawInventory();
});

if (cameraSupported() && window.matchMedia?.("(pointer: coarse)")?.matches) {
  $("#invCam").hidden = false;
  $("#invCam").addEventListener("click", () => {
    if (!inv) return;
    openCameraScanner({
      title: "Scan devices to count",
      onManual: () => $("#invScan").focus(),
      mirror: () => ({ title: "Scan each device", sub: $("#invMsg").textContent }),
      onCode: (code) => { $("#invScan").value = code; $("#invScan").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true })); return true; },
    }).catch((e) => toast(e.message, "err", 6000));
  });
}

$("#invLists").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = cache.assets.find((x) => x.id === b.closest("li").dataset.id);
  try {
    if (b.dataset.act === "inv-lost") outOfServiceDialog(a, "lost");
    if (b.dataset.act === "inv-checkin") await forceReturn(a);
    if (b.dataset.act === "inv-restore") await setActive("asset", a, true);
  } catch (err) { toast(explain(err), "err", 6000); }
});

$("#invFinish").addEventListener("click", async () => {
  const r = invSummary();
  const ok = await confirmDlg({
    title: "Save this count?", confirm: "Save count",
    message: `${r.found.length} of ${r.expected.length} expected devices found${r.missing.length ? `. <b>${r.missing.length} missing:</b> ${esc(r.missing.join(", "))}` : ". Everything is accounted for."} It's saved permanently with your name and the time.`,
  });
  if (!ok) return;
  try {
    const ref = F.doc(F.collection(db, "counts"));
    await commit([{
      ref, mode: "set",
      data: { ...r, adminName: me.name, adminEmail: me.email, startedAt: F.Timestamp.fromDate(inv.startedAt), ts: now() },
      audit: {
        action: "inventory.count", targetType: "count", targetId: ref.id,
        summary: `Inventory count (${r.scope || "all types"}): ${r.found.length} of ${r.expected.length} found, ${r.missing.length} missing${r.missing.length ? " (" + r.missing.join(", ") + ")" : ""}`,
        before: null, after: { expected: r.expected.length, found: r.found.length, missing: r.missing },
      },
    }]);
    toast("Count saved", "ok");
    inv = null;
    await loadCounts();
    renderInventory();
  } catch (e) { toast(explain(e), "err", 6000); }
});

async function loadCounts() {
  try {
    const snap = await F.getDocs(F.query(F.collection(db, "counts"), F.orderBy("ts", "desc"), F.limit(30)));
    cache.counts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    drawCountHistory();
  } catch (e) { $("#invHistory").innerHTML = emptyRow(8, explain(e)); }
}

function drawCountHistory() {
  const other = (c) => (c.outButPresent?.length || 0) + (c.outOfService?.length || 0) + (c.unknown?.length || 0);
  $("#invHistory").innerHTML = cache.counts.length
    ? cache.counts.map((c, i) => `<tr data-i="${i}">
        <td>${fmtDT(c.ts)}</td><td>${esc(c.adminName)}</td><td>${esc(c.scope || "All types")}</td>
        <td>${c.expected?.length ?? 0}</td><td>${c.found?.length ?? 0}</td>
        <td>${c.missing?.length ? `<span class="chip warn">${c.missing.length}</span>` : "0"}</td>
        <td>${other(c) || "0"}</td>
        <td class="actions"><button class="btn sm" data-detail>Details</button></td></tr>
        <tr class="detail-row hidden" data-d="${i}"><td colspan="8"><pre class="json">${esc([
          `Missing: ${c.missing?.join(", ") || "none"}`,
          c.outButPresent?.length ? `Here, but system said checked out: ${c.outButPresent.join(", ")}` : "",
          c.outOfService?.length ? `Here, but out of service: ${c.outOfService.join(", ")}` : "",
          c.unknown?.length ? `Unknown codes: ${c.unknown.join(", ")}` : "",
        ].filter(Boolean).join("\n"))}</pre></td></tr>`).join("")
    : emptyRow(8, "No saved counts yet.");
}
$("#invHistory").addEventListener("click", (e) => {
  const b = e.target.closest("[data-detail]");
  if (b) $(`#invHistory tr[data-d="${b.closest("tr").dataset.i}"]`).classList.toggle("hidden");
});

const settingsDoc = () => normSettings(cache.settings.find((x) => x.id === "app"));

// ═════════════════════════ settings ═════════════════════════
function renderSettings() {
  const cur = settingsDoc();
  const active = cache.staff.filter((x) => x.active);
  $("#pinStats").textContent = `${active.filter((x) => x.pinHash).length} of ${active.length} active people have set a PIN; ${active.filter((x) => x.pinRequired).length} are marked as required.`;
  if (settingsDirty) return;
  for (const r of $$('input[name="pinMode"]')) r.checked = r.value === cur.pinMode;
  $("#settingsNote").textContent = cache.settings.find((x) => x.id === "app") ? "" : "Using defaults. Nothing saved yet.";
}
$("#settingsForm").addEventListener("input", () => (settingsDirty = true));
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#settingsErr").textContent = "";
  const pinMode = $('input[name="pinMode"]:checked')?.value || "off";
  const before = settingsDoc();
  try {
    await commit([{
      ref: F.doc(db, "settings", "app"), mode: "set",
      data: { pinMode, updatedAt: now() },
      audit: {
        action: "settings.update", targetType: "settings", targetId: "app",
        summary: `Settings: PIN mode ${pinMode}`,
        before, after: { pinMode },
      },
    }]);
    settingsDirty = false;
    toast("Settings saved", "ok");
  } catch (err) { $("#settingsErr").textContent = explain(err); }
});

boot();
