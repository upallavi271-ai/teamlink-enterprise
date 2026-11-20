// Small helpers for the reminder screens (India time, wording).
export const IST = 330 * 60000;
export const istDate = (iso) => (iso ? new Date(new Date(iso).getTime() + IST).toISOString().slice(0, 10) : '');
export const istTime = (iso) => (iso ? new Date(new Date(iso).getTime() + IST).toISOString().slice(11, 16) : '');
export const fromIst = (date, time) => (date && time ? new Date(`${date}T${time}:00+05:30`).toISOString() : null);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function when(iso) {
  if (!iso) return '';
  const t = new Date(new Date(iso).getTime() + IST);
  const h = t.getUTCHours();
  return `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MO[t.getUTCMonth()]}, ${h % 12 === 0 ? 12 : h % 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
// the quick choices: 2 days before 10:00, 1 day before 17:00, 2 hours before
export function quickTime(kind, eventIso) {
  if (!eventIso) return null;
  const day = istDate(eventIso);
  if (kind === 'D2') return fromIst(addDays(day, -2), '10:00');
  if (kind === 'D1') return fromIst(addDays(day, -1), '17:00');
  return new Date(new Date(eventIso).getTime() - 2 * 3600000).toISOString();
}
export const STATUS_WORD = { planned: 'Waiting', sent: 'Sent', delivered: 'Delivered', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };
export const STATUS_TONE = { planned: 'blue', sent: 'green', delivered: 'green', failed: 'red', skipped: 'amber', cancelled: 'amber' };
export const LANG_NAME = { en: 'English', te: 'Telugu' };
