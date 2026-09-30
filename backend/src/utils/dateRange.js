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
  last_7: 'Last 7 Days',
  this_month: 'This Month',
  last_month: 'Last Month',
  this_quarter: 'This Quarter',
  this_year: 'Current Year',
  custom: 'Custom Range',
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => new Date().toISOString().slice(0, 10);
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
  constructor(message) { super(message); this.status = 400; }
}

function resolve(q = {}, today = todayStr()) {
  // A bare ?from=…&to=… (no range key) is the From → To → Apply filter
  // itself, so it is read as a custom range rather than falling back to Today.
  const bare = !q.range && (q.from || q.to);
  const key = bare ? 'custom' : (PRESETS[q.range] ? q.range : 'today');
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
const dateTimeIn = (r) => ({ gte: toDate(r.from), lt: toDate(addDays(r.to, 1)) });
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

module.exports = { PRESETS, resolve, fromQuery, optionalFromQuery, labelOf, dateTimeIn, dayStringIn, addDays };
