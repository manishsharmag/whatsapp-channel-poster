/**
 * Wall-clock scheduling for the daily run.
 *
 * Kept separate from the server so the tricky part — "when is the next slot,
 * and is this minute a slot?" — can be unit-tested without starting a panel.
 * Every calculation is in the machine's local time, which is what the user
 * types into the box ("08:00" means their clock, not UTC).
 */

const pad = (n) => String(n).padStart(2, '0');

/** "2026-10-30 08:00" — one specific minute, used to fire a slot only once. */
export function slotKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "HH:MM" of a date. */
export function clockKey(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function allowedDays(schedule) {
  return schedule?.weekdays?.length ? schedule.weekdays : [0, 1, 2, 3, 4, 5, 6];
}

/**
 * Epoch ms of the next slot strictly after `now`, or 0 when the schedule is off.
 * Looks up to 8 days ahead so a single-weekday schedule still resolves.
 */
export function nextScheduleAt(schedule, now = new Date()) {
  if (!schedule?.enabled || !schedule.times?.length) return 0;
  const days = allowedDays(schedule);
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (!days.includes(day.getDay())) continue;
    for (const time of [...schedule.times].sort()) {
      const [h, m] = String(time).split(':').map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
      if (at > now.getTime()) return at;
    }
  }
  return 0;
}

/**
 * The slot this minute belongs to, or null. Returned as the same key the state
 * file stores so a restarted app can skip a slot it already ran.
 */
export function dueSlot(schedule, now = new Date()) {
  if (!schedule?.enabled || !schedule.times?.length) return null;
  if (!allowedDays(schedule).includes(now.getDay())) return null;
  return schedule.times.includes(clockKey(now)) ? slotKey(now) : null;
}

/** "Mon, Wed at 08:00" — the sentence the panel shows. */
export function describeSchedule(schedule) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = schedule?.weekdays?.length
    ? [...schedule.weekdays].sort().map((d) => names[d]).join(', ')
    : 'every day';
  return `${days} at ${(schedule?.times ?? []).join(', ')}`;
}
