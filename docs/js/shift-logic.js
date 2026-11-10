// Shift-change helpers for the end-of-shift sweep (no Firebase). Unit tested.

/** "07:00, 15:00 23:00" → {times:["07:00","15:00","23:00"]} or {error} */
export function parseShiftTimes(text) {
  const parts = String(text ?? "").split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return { error: "Enter at least one shift-change time, like 07:00." };
  const times = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (!m || +m[1] > 23 || +m[2] > 59) return { error: `“${p}” isn't a time. Use 24-hour HH:MM, like 15:00.` };
    times.push(`${m[1].padStart(2, "0")}:${m[2]}`);
  }
  return { times: [...new Set(times)].sort() };
}

const at = (day, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0); };

/** The most recent shift change at or before `now` (looks back to yesterday). */
export function lastShiftChange(times, now = new Date()) {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const all = [...times.map((t) => at(yesterday, t)), ...times.map((t) => at(now, t))].filter((d) => d <= now).sort((a, b) => a - b);
  return all.at(-1) ?? now;
}

/** Shift-change moments from the last 24h (newest first), for the sweep picker. */
export function recentShiftChanges(times, now = new Date()) {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return [...times.map((t) => at(yesterday, t)), ...times.map((t) => at(now, t))]
    .filter((d) => d <= now && now - d <= 24 * 3600e3).sort((a, b) => b - a);
}

/** Was this device checked out before the given shift change? */
export const carriedOver = (checkedOutAt, boundary) => !!checkedOutAt && !!boundary && checkedOutAt < boundary;
