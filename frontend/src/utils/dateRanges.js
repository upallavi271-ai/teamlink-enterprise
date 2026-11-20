// ---------------------------------------------------------------------------
// THE ONE SET OF DATE PRESETS FOR EVERY FILTER BAR (founder 2026-11-20: "date filters must be everywhere and work properly").
// Days are IST days (the company's day), not the browser's: a laptop set to another time zone gets the same days. The server reads
// the same words (backend/src/utils/dateRange.js: ALIASES / PRESETS), so a preset picked here means the same days there.
//
//   PRESETS         [value, label] in the order every bar lists them (value '' = any time, 'custom' = two dates)
//   presetDates(v, from, to)  -> { from, to } as YYYY-MM-DD ({} for any time / an unfinished custom range)
//   matchPreset(from, to)     -> the preset value whose days are exactly from-to, else 'custom' ('' when both are empty)
//   dateProblem(from, to)     -> '' or the words for why a custom range cannot be used (not a date, From after To)
// ---------------------------------------------------------------------------
const IST_MS = 5.5 * 3600 * 1000;
export const PRESETS = [
  ['', 'Any time'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['last_week', 'Last week'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['this_quarter', 'This quarter'],
  ['this_year', 'This year'],
  ['last_7', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['custom', 'Custom'],
];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fmt = (d) => d.toISOString().slice(0, 10);
const utcDay = (s) => new Date(`${s}T00:00:00.000Z`);
const add = (s, n) => fmt(new Date(utcDay(s).getTime() + n * 86400000));
export const validDay = (s) => ISO.test(s || '') && fmt(utcDay(s)) === s;

/** today in India, YYYY-MM-DD */
export const istToday = (now = new Date()) => fmt(new Date(now.getTime() + IST_MS));

export function presetDates(range, from, to, now = new Date()) {
  const today = istToday(now);
  const t = utcDay(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const mon = (t.getUTCDay() + 6) % 7; // days since Monday
  switch (range) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: add(today, -1), to: add(today, -1) };
    case 'week': return { from: add(today, -mon), to: today };
    case 'last_week': return { from: add(today, -mon - 7), to: add(today, -mon - 1) };
    case 'month': return { from: fmt(new Date(Date.UTC(y, m, 1))), to: today };
    case 'last_month': return { from: fmt(new Date(Date.UTC(y, m - 1, 1))), to: fmt(new Date(Date.UTC(y, m, 0))) };
    case 'this_quarter': return { from: fmt(new Date(Date.UTC(y, m - (m % 3), 1))), to: today };
    case 'this_year': return { from: `${y}-01-01`, to: today };
    case 'last_7': return { from: add(today, -6), to: today };
    case '30d': return { from: add(today, -29), to: today };
    case 'custom': return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    default: return {};
  }
}

export function matchPreset(from, to, now = new Date()) {
  if (!from && !to) return '';
  const hit = PRESETS.find(([k]) => {
    if (!k || k === 'custom') return false;
    const d = presetDates(k, '', '', now);
    return d.from === from && d.to === to;
  });
  return hit ? hit[0] : 'custom';
}

export function dateProblem(from, to) {
  if (from && !validDay(from)) return 'The From date is not a date';
  if (to && !validDay(to)) return 'The To date is not a date';
  if (from && to && from > to) return 'From must be on or before To';
  return '';
}

/** The IST day of a date / timestamp / text. A plain YYYY-MM-DD is already a day and stays; a moment is cut at IST midnight. */
export function istDayOf(v) {
  if (!v) return '';
  if (typeof v === 'string' && ISO.test(v.trim())) return v.trim();
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? fmt(new Date(t + IST_MS)) : '';
}
