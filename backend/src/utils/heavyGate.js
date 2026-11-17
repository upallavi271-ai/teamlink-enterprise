// ---------------------------------------------------------------------------
// OVERLOAD PROTECTION (load test 2026-11-17: 500 people opening the big lists at once ran the server out of memory and it
// crashed; 100 at once made every request wait ~30 s). The heavy list / report requests (candidates, requirements, clients,
// calendar, offers, joining, dashboards, reports) now take a turn: at most HEAVY_MAX (default 12) run at the same time, the
// rest wait in line (up to HEAVY_QUEUE, default 400, for at most 45 s) instead of all piling into memory together. A request
// that cannot get a turn in time is told "busy, try again in a few seconds" (503 BUSY) - the server itself stays up.
// Light requests (sign-in, a single record, saves) never wait here.
//   middleware()   mounted once in index.js before the routes
//   stats()        { running, waiting, max, served, refused }
// ---------------------------------------------------------------------------
const MAX = Math.max(1, Number(process.env.HEAVY_MAX) || 12);
const QUEUE = Math.max(0, Number(process.env.HEAVY_QUEUE) || 400);
const WAIT_MS = Number(process.env.HEAVY_WAIT_MS) || 45000;
const HEAVY = [
  /^\/api\/candidates\/?$/, /^\/api\/candidates\/(facets|board|search)\b/, /^\/api\/requirements\/?$/, /^\/api\/requirements\/facets\b/,
  /^\/api\/clients\/?$/, /^\/api\/ats\/(calendar|offers|joining|interview-feedback|interviews)\/?$/, /^\/api\/dashboard\b/,
  /^\/api\/ats-reports\b/, /^\/api\/reports\b/, /^\/api\/ats\/home\b/, /^\/api\/ats\/data-quality\b/, /^\/api\/invoices\/?$/,
];
let running = 0; let served = 0; let refused = 0;
const line = [];

function next() {
  while (running < MAX && line.length) {
    const w = line.shift();
    if (w.done) continue; // eslint-disable-line no-continue
    w.done = true; clearTimeout(w.timer); running += 1; w.go();
  }
}
function middleware() {
  return (req, res, nxt) => {
    if (req.method !== 'GET') return nxt();
    const p = String(req.originalUrl || '').split('?')[0];
    if (!HEAVY.some((re) => re.test(p))) return nxt();
    let released = false;
    const release = () => { if (released) return; released = true; running -= 1; served += 1; next(); };
    const go = () => { res.on('finish', release); res.on('close', release); nxt(); };
    if (running < MAX) { running += 1; return go(); }
    if (line.length >= QUEUE) { refused += 1; return res.status(503).json({ error: 'TeamLink is very busy right now. Try again in a few seconds.', code: 'BUSY' }); }
    const w = { done: false, go };
    w.timer = setTimeout(() => {
      if (w.done) return; w.done = true; refused += 1;
      if (!res.headersSent) res.status(503).json({ error: 'TeamLink is very busy right now. Try again in a few seconds.', code: 'BUSY' });
    }, WAIT_MS);
    // a person who closes the page leaves the line
    req.on('close', () => { if (!w.done) { w.done = true; clearTimeout(w.timer); } });
    line.push(w);
    return undefined;
  };
}
const stats = () => ({ running, waiting: line.filter((w) => !w.done).length, max: MAX, served, refused });

module.exports = { middleware, stats, HEAVY };
