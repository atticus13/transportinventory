// "Hasn't checked anything out in 2 months" reminder for staff, with a 2-month snooze. Pure so it can be tested.
export const STALE_DAYS = 60;
export const SNOOZE_DAYS = 60;
const DAY = 86400000;

const asDate = (v) => (!v ? null : v instanceof Date ? v : typeof v.toDate === "function" ? v.toDate() : new Date(v));

/** Baseline for "last seen": the later of their last log entry and the day they were added. null = nothing known. */
export function lastSeenOf(staff, lastLog) {
  const dates = [asDate(lastLog), asDate(staff?.createdAt)].filter((d) => d && !Number.isNaN(d.getTime()));
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

/** Could this person possibly be stale? (Added long enough ago; cheap check so we only look up the others' history.) */
export function worthChecking(staff, now = new Date(), days = STALE_DAYS) {
  if (!staff?.active) return false;
  const c = asDate(staff.createdAt);
  return !c || now.getTime() - c.getTime() > days * DAY;
}

export const isSnoozed = (staff, now = new Date()) => {
  const until = asDate(staff?.staleSnoozeUntil);
  return !!until && until.getTime() > now.getTime();
};

/**
 * staff       : staff records ({id, name, active, createdAt, staleSnoozeUntil})
 * lastLogById : Map<employeeId, Date|Timestamp|null>  (their most recent log entry)
 * returns     : [{staff, last, never}] for active, un-snoozed people with no activity for `days`, longest idle first.
 */
export function staleStaff(staff, lastLogById, now = new Date(), days = STALE_DAYS) {
  const out = [];
  for (const s of staff) {
    if (!s.active || isSnoozed(s, now)) continue;
    const log = asDate(lastLogById.get(s.id));
    const base = lastSeenOf(s, log);
    if (base && now.getTime() - base.getTime() <= days * DAY) continue;
    out.push({ staff: s, last: log, base, never: !log });
  }
  return out.sort((a, b) => (a.base?.getTime() ?? 0) - (b.base?.getTime() ?? 0));
}

export const snoozeUntil = (now = new Date(), days = SNOOZE_DAYS) => new Date(now.getTime() + days * DAY);
