// Pure decision logic for a scan — no Firebase, so it can be unit tested.
//
//   employee : {id, name} | null     (who scanned their ID just before, if anyone)
//   asset    : {id, active, status, currentHolderId, currentHolderName, checkedOutAt}
//   held     : [{id}]                devices this employee already has out
//
// Returns {action:'checkout'|'checkin'|'error', ...}
//
// A device that is still "out" to someone else CAN be checked out by the next person.
// That is flagged as a `takeover`, and the station records a missed return for the
// admin to follow up. Nobody is ever blocked from taking a device that's in front of them.

const err = (code, message) => ({ action: "error", code, message });

// Why a device is out of service. `active: false` + one of these keys on the asset.
export const RETIRE_REASONS = [
  { key: "lost", label: "Lost", hint: "Can't be found" },
  { key: "stolen", label: "Stolen", hint: "Reported stolen" },
  { key: "repair", label: "Out for repair", hint: "Broken, sent for repair" },
  { key: "retired", label: "Retired", hint: "End of life" },
  { key: "removed", label: "Removed", hint: "Added by mistake or no longer ours" },
];
export const reasonLabel = (key) => RETIRE_REASONS.find((r) => r.key === key)?.label || "Removed";

export function removedMessage(asset) {
  switch (asset.retireReason) {
    case "lost": return `${asset.id} is marked LOST. If you have it, tell your supervisor right away.`;
    case "stolen": return `${asset.id} is reported stolen. Tell your supervisor you have it.`;
    case "repair": return `${asset.id} is out for repair and can't be checked out.`;
    case "retired": return `${asset.id} has been retired from service.`;
    default: return `${asset.id} has been removed from service. See your supervisor.`;
  }
}

export function decide({ employee = null, asset, held = [], allowMultiple = false }) {
  if (!asset.active) return err("ASSET_REMOVED", removedMessage(asset));

  const isOut = asset.status === "out";

  // Device scanned on its own
  if (!employee) {
    if (isOut) return { action: "checkin", holderId: asset.currentHolderId, holderName: asset.currentHolderName };
    return err("NEED_EMPLOYEE", "Scan your ID badge first, then scan the device.");
  }

  // Their own device → return it
  if (isOut && asset.currentHolderId === employee.id)
    return { action: "checkin", holderId: asset.currentHolderId, holderName: asset.currentHolderName };

  if (!allowMultiple && held.length > 0)
    return err("ALREADY_HAS", `You already have ${held.map((h) => h.id).join(", ")} checked out. Scan it by itself to return it first.`);

  if (isOut)
    return {
      action: "checkout",
      takeover: { fromId: asset.currentHolderId, fromName: asset.currentHolderName, since: asset.checkedOutAt ?? null },
    };

  return { action: "checkout" };
}

export const heldMinutes = (checkedOutAt, now = new Date()) =>
  checkedOutAt ? Math.max(0, Math.round((now - checkedOutAt) / 60000)) : null;
