// Pure reporting helpers (no Firebase) — unit tested in tests/.

export function normalizeLog(id, d) {
  return {
    id,
    ts: d.ts?.toDate ? d.ts.toDate() : d.ts instanceof Date ? d.ts : null,
    type: d.type, // 'out' | 'in' | 'missed'
    assetId: d.assetId,
    assetModel: d.assetModel ?? d.assetType ?? "",
    assetCategory: d.assetCategory || "",
    employeeId: d.employeeId || "",
    employeeName: d.employeeName || "",
    heldMinutes: d.heldMinutes ?? null,
    source: d.source || "",
    handledById: d.handledById || "",
    handledByName: d.handledByName || "",
    takeoverFromName: d.takeoverFromName || "",
    incidentId: d.incidentId || "",
  };
}

/**
 * 'missed' entries are filed against the person who didn't return a device (the next person
 * took it). They count as missed returns, never as check-outs/returns, and their elapsed
 * time is not counted as "time held" because the return was never confirmed.
 */
export function summarize(logs) {
  const staff = new Map();
  const assets = new Map();
  let checkouts = 0, returns = 0, missed = 0, heldMinutes = 0;

  for (const l of logs) {
    const s = staff.get(l.employeeId) || { employeeId: l.employeeId, employeeName: l.employeeName, checkouts: 0, returns: 0, missed: 0, heldMinutes: 0, last: null };
    const a = assets.get(l.assetId) || { assetId: l.assetId, assetModel: l.assetModel, assetCategory: l.assetCategory, checkouts: 0, returns: 0, missed: 0, heldMinutes: 0, last: null, lastHolder: "" };

    if (l.type === "out") { checkouts++; s.checkouts++; a.checkouts++; }
    else if (l.type === "in") {
      returns++; s.returns++; a.returns++;
      if (l.heldMinutes != null) { heldMinutes += l.heldMinutes; s.heldMinutes += l.heldMinutes; a.heldMinutes += l.heldMinutes; }
    } else if (l.type === "missed") { missed++; s.missed++; a.missed++; }

    if (l.ts && (!s.last || l.ts > s.last)) { s.last = l.ts; s.employeeName = l.employeeName || s.employeeName; }
    if (l.ts && (!a.last || l.ts > a.last)) {
      a.last = l.ts; a.assetModel = l.assetModel || a.assetModel; a.assetCategory = l.assetCategory || a.assetCategory;
    }
    // A takeover writes its 'missed' and 'out' entries with the same timestamp, so track the
    // last holder separately (>=) and never let a 'missed' entry count as holding the device.
    if (l.ts && l.type !== "missed" && (!a.lastHolderTs || l.ts >= a.lastHolderTs)) {
      a.lastHolderTs = l.ts; a.lastHolder = l.employeeName;
    }
    staff.set(l.employeeId, s);
    assets.set(l.assetId, a);
  }

  const rank = (x, y) => y.checkouts - x.checkouts || y.missed - x.missed || y.heldMinutes - x.heldMinutes;
  return {
    checkouts, returns, missed, heldMinutes,
    uniqueStaff: staff.size,
    uniqueAssets: assets.size,
    perStaff: [...staff.values()].sort(rank),
    perAsset: [...assets.values()].sort(rank),
  };
}

export const actionLabel = (l) =>
  l.type === "out" ? (l.takeoverFromName ? `Checked out (was still with ${l.takeoverFromName})` : "Checked out")
  : l.type === "in" ? "Checked in"
  : `Not returned${l.handledByName ? ` (taken by ${l.handledByName})` : ""}`;

export const ACTIVITY_HEADERS = ["Date/Time", "Action", "Asset ID", "Asset Type", "Model", "Employee ID", "Employee Name", "Held (min)", "Source", "Handled By"];
export const activityRows = (logs) =>
  logs.map((l) => [
    l.ts ? l.ts.toLocaleString() : "", actionLabel(l), l.assetId, l.assetCategory, l.assetModel,
    l.employeeId, l.employeeName, l.heldMinutes ?? "", l.source, l.handledByName || "",
  ]);
