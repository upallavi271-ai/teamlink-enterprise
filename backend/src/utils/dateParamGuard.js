// ---------------------------------------------------------------------------
// ONE CHECK FOR EVERY DATE FILTER OF A LIST (founder 2026-11-20: "date filters must work properly for every login").
// A list's From / To (addedFrom/addedTo, ivFrom/ivTo, dFrom/dTo, fuFrom/fuTo ...) must be a real YYYY-MM-DD day and From must
// not be after To. Anything else is answered 400 with words HERE, before the route runs, instead of being silently ignored
// (the list then showed everything) or reaching a query as an Invalid Date (a 500). The route itself then applies the days
// as IST days through utils/dateRange.js (dayWindow / dayInWindow).
//   plain `from` / `to` are only checked on the paths that mean a day by them (PLAIN_PATHS): elsewhere they are ids or months.
// ---------------------------------------------------------------------------
const { validIso } = require('./dateRange');

const PAIRS = [
  ['appliedFrom', 'appliedTo', 'Applied'], ['addedFrom', 'addedTo', 'Added'], ['updatedFrom', 'updatedTo', 'Last updated'],
  ['contactedFrom', 'contactedTo', 'Last contacted'], ['sharedFrom', 'sharedTo', 'Shared with client'], ['cameFrom', 'cameTo', 'Came on'],
  ['joinedFrom', 'joinedTo', 'Joined on'], ['ivFrom', 'ivTo', 'Interview'], ['dFrom', 'dTo', 'Date'], ['fuFrom', 'fuTo', 'Follow-up due'],
  ['jpFrom', 'jpTo', 'Applied on'], ['cFrom', 'cTo', 'Added on'], ['d_from', 'd_to', 'List date'],
];
// paths where plain from / to are days (not ids / months)
const PLAIN_PATHS = [/^\/requirements(\/|$)/, /^\/ats-reports(\/|$)/, /^\/ats-report-pack(\/|$)/, /^\/call-lists(\/|$)/, /^\/ats\/history(\/|$)/,
  /^\/followups(\/|$)/, /^\/ats\/all-calendar(\/|$)/, /^\/reports\/(ats|interviews|followups|job-portal)(\/|$)/, /^\/candidates\/sources(\/|$)/];

function problem(from, to, what) {
  const f = from === undefined || from === null ? '' : String(from).trim();
  const t = to === undefined || to === null ? '' : String(to).trim();
  if (f && !validIso(f)) return `The ${what} "From" date is not a date (use YYYY-MM-DD)`;
  if (t && !validIso(t)) return `The ${what} "To" date is not a date (use YYYY-MM-DD)`;
  if (f && t && f > t) return `The ${what} "From" date must be on or before the "To" date`;
  return '';
}

function middleware(req, res, next) {
  if (req.method !== 'GET') return next();
  const q = req.query || {};
  for (const [a, b, what] of PAIRS) {
    if (q[a] === undefined && q[b] === undefined) continue;
    const msg = problem(q[a], q[b], what);
    if (msg) return res.status(400).json({ error: msg });
  }
  if ((q.from !== undefined || q.to !== undefined) && PLAIN_PATHS.some((re) => re.test(req.path)) && String(q.range || 'custom') === 'custom') {
    const msg = problem(q.from, q.to, 'date range');
    if (msg) return res.status(400).json({ error: msg });
  }
  return next();
}
module.exports = middleware;
module.exports.problem = problem;
