// ---------------------------------------------------------------------------
// THE DASHBOARD DATE RANGE.
//
// One resolver behind the Date / Calendar filter on the HRMS, ATS and common
// dashboards, so "This Week" means the same seven days on all three.
//
//   resolve({ range, from, to }) -> { key, from, to, label, name, days }
//
// `from` / `to` are inclusive YYYY-MM-DD. "Today" is the same one the rest of
// the app uses — new Date().toISOString().slice(0, 10) — and every step below
// is done on that string in UTC, so the dashboards never disagree with the
// attendance marks or sameDay() about which day it is.
//
// Unlike utils/accounts.js dashRange() (financial-year months) this works in
// whole days. An unknown key falls back to Today; a bad custom range is a 400.
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const MAX_CUSTOM_DAYS = 3 * 366; // a custom range is capped at ~3 years
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PRESETS = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  last_week: 'Last Week',
  last_7: 'Last 7 Days',
  last_30: 'Last 30 Days',
  this_month: 'This Month',
  last_month: 'Last Month',
  this_quarter: 'This Quarter',
  this_year: 'Current Year',
  custom: 'Custom Range',
};
// The words the filter bars send (components/ui/PageFilterBar.jsx) and older links: one table, so every endpoint
// reads them the same way (2026-11-20: week / month / 30d used to fall back to Today in some endpoints).
const ALIASES = { week: 'this_week', month: 'this_month', '30d': 'last_30', quarter: 'this_quarter', year: 'this_year', '7d': 'last_7', lastweek: 'last_week', lastmonth: 'last_month' };
const canonKey = (k) => { const s = String(k || '').trim(); return ALIASES[s] || s; };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// A day is 00:00-23:59 IST (2026-11-20: it used to be the UTC day, so from 00:00 to 05:30 IST "Today" was yesterday).
const IST_MS = 5.5 * 3600 * 1000;
const todayStr = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const toDate = (s) => new Date(`${s}T00:00:00.000Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * DAY_MS));
const validIso = (s) => ISO.test(String(s || '')) && fmt(toDate(s)) === s;

// "24 Sep 2026", or "01 Sep – 24 Sep 2026" (the year once when both share it).
function labelOf(from, to) {
  const part = (s, withYear) => {
    const d = toDate(s);
    const txt = `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
    return withYear ? `${txt} ${d.getUTCFullYear()}` : txt;
  };
  if (from === to) return part(from, true);
  return `${part(from, from.slice(0, 4) !== to.slice(0, 4))} – ${part(to, true)}`;
}

class RangeError400 extends Error {
  constructor(message) { super(message); this.status = 400; this.name = 'DateRangeError'; } // index.js answers it 400, never 500
}

function resolve(q = {}, today = todayStr()) {
  // A bare ?from=…&to=… (no range key) is the From → To → Apply filter
  // itself, so it is read as a custom range rather than falling back to Today.
  const asked = canonKey(q.range);
  const bare = (!asked || asked === 'custom') && (q.from || q.to);
  if (asked && asked !== 'custom' && asked !== 'all' && !PRESETS[asked]) throw new RangeError400(`Unknown date range "${String(q.range).slice(0, 40)}"`);
  const key = bare || asked === 'custom' ? 'custom' : (PRESETS[asked] ? asked : 'today');
  const t = toDate(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  let from = today;
  let to = today;
  switch (key) {
    case 'yesterday': from = addDays(today, -1); to = from; break;
    // Monday to today — getUTCDay() is 0 on a Sunday.
    case 'this_week': from = addDays(today, -((t.getUTCDay() + 6) % 7)); break;
    case 'last_7': from = addDays(today, -6); break;
    case 'last_30': from = addDays(today, -29); break;
    // Monday to Sunday of the week before
    case 'last_week': from = addDays(today, -((t.getUTCDay() + 6) % 7) - 7); to = addDays(from, 6); break;
    case 'this_month': from = fmt(new Date(Date.UTC(y, m, 1))); break;
    case 'last_month':
      from = fmt(new Date(Date.UTC(y, m - 1, 1)));
      to = fmt(new Date(Date.UTC(y, m, 0)));
      break;
    case 'this_quarter': from = fmt(new Date(Date.UTC(y, m - (m % 3), 1))); break;
    case 'this_year': from = `${y}-01-01`; break;
    case 'custom':
      if (!validIso(q.from) || !validIso(q.to)) throw new RangeError400('A custom range needs a valid From and To date (YYYY-MM-DD)');
      if (q.from > q.to) throw new RangeError400('The From date must be on or before the To date');
      from = q.from; to = q.to;
      if ((toDate(to) - toDate(from)) / DAY_MS + 1 > MAX_CUSTOM_DAYS) throw new RangeError400('A custom range can cover at most 3 years');
      break;
    default: break;
  }
  const days = Math.round((toDate(to) - toDate(from)) / DAY_MS) + 1;
  const label = labelOf(from, to);
  // `name` is what a tile label carries ("Present — This Month"); a custom
  // range has no preset word, so it carries its dates.
  return { key, from, to, label, name: key === 'custom' ? label : PRESETS[key], days };
}

// For a route: the resolved range, or null after answering 400 itself (the
// app's error handler turns every thrown error into a 500).
function fromQuery(req, res) {
  try {
    return resolve(req.query);
  } catch (err) {
    if (err.status !== 400) throw err;
    res.status(400).json({ error: err.message });
    return null;
  }
}

// Prisma fragments for the two ways a date is stored in this schema. Both are
// half-open at the day after `to`, so a String column holding a full ISO
// timestamp is still caught on the last day.
// (timestamps are cut at IST midnight: a day is the IST day)
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const dateTimeIn = (r) => ({ gte: istStart(r.from), lt: istStart(addDays(r.to, 1)) });
const istDayOf = (v) => { const t = v instanceof Date ? v.getTime() : new Date(v).getTime(); return Number.isFinite(t) ? new Date(t + IST_MS).toISOString().slice(0, 10) : null; };
const dayStringIn = (r) => ({ gte: r.from, lt: addDays(r.to, 1) });

// For a LIST endpoint, where no range means "everything" rather than Today:
// null when the request names no range at all, the resolved range when it
// does, and `false` after answering a bad one with a 400 itself.
function optionalFromQuery(req, res) {
  const q = req.query || {};
  if (!q.range && !q.from && !q.to) return null;
  if (q.range === 'all') return null;
  return fromQuery(req, res) || false;
}

// THE LIST WINDOW: a list screen's own From / To (either may be empty). Validates (a bad date or From after To is a 400 with
// words), cuts at IST midnight and includes the whole `to` day.
//   dayWindow(from, to, 'Added') -> { from, to, gte: Date|null, lt: Date|null, any }
function dayWindow(from, to, what = 'date') {
  const f = String(from === undefined || from === null ? '' : from).trim();
  const t = String(to === undefined || to === null ? '' : to).trim();
  if (f && !validIso(f)) throw new RangeError400(`The ${what} "From" date is not a date (use YYYY-MM-DD)`);
  if (t && !validIso(t)) throw new RangeError400(`The ${what} "To" date is not a date (use YYYY-MM-DD)`);
  if (f && t && f > t) throw new RangeError400(`The ${what} "From" date must be on or before the "To" date`);
  return { from: f || null, to: t || null, gte: f ? istStart(f) : null, lt: t ? istStart(addDays(t, 1)) : null, any: !!(f || t) };
}
// the same window as a Prisma fragment for a DateTime column ({} when empty)
const windowIn = (w) => (w && w.any ? { ...(w.gte ? { gte: w.gte } : {}), ...(w.lt ? { lt: w.lt } : {}) } : null);
// does an IST day string (YYYY-MM-DD) fall inside the window
const dayInWindow = (day, w) => !w || !w.any || (!!day && (!w.from || day >= w.from) && (!w.to || day <= w.to));

module.exports = { dayWindow, windowIn, dayInWindow, RangeError400, PRESETS, ALIASES, canonKey, todayIst: todayStr, istStart, istDayOf, validIso, resolve, fromQuery, optionalFromQuery, labelOf, dateTimeIn, dayStringIn, addDays };
