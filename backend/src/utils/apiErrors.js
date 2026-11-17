// ---------------------------------------------------------------------------
// FAILED REQUESTS, GROUPED, WITH AN ALERT (ATS audit 161 / 794 / 799, A25 - founder 2026-11-17).
// Every answer of 500 or more is recorded (route with ids blanked, method, status, the error's first line, who, when) in the
// raw table "ApiError" (kept 60 days). Repeats of the same failure are GROUPED (same route + same message) so one broken
// button shows as one line with a count, not 300 lines. When a group fails 5 times in 10 minutes the Super Admins get a bell
// note (once an hour per group). Administration -> Audit Logs -> "Errors" lists the groups.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ApiError" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "at" TEXT NOT NULL, "groupKey" TEXT NOT NULL,
        "method" TEXT, "route" TEXT, "status" INTEGER, "message" TEXT, "userId" TEXT, "userName" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ApiError_group" ON "ApiError" ("groupKey","at")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
// /api/candidates/cmw12ab.../stage -> /api/candidates/:id/stage
const routeOf = (url) => String(url || '').split('?')[0].replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 200);
const firstLine = (m) => String(m || '').split('\n')[0].replace(/\b[A-Za-z0-9_-]{20,}\b/g, ':id').slice(0, 300);
const keyOf = (method, route, msg) => crypto.createHash('sha1').update(`${method}|${route}|${msg}`).digest('hex').slice(0, 16);

const alerted = new Map(); // groupKey -> ms
async function record(req, res) {
  await ensure();
  const method = req.method;
  const route = routeOf(req.originalUrl || req.url);
  const msg = firstLine((res.locals && res.locals.errorMessage) || `HTTP ${res.statusCode}`);
  const g = keyOf(method, route, msg);
  await prisma.$executeRawUnsafe('INSERT INTO "ApiError" ("at","groupKey","method","route","status","message","userId","userName") VALUES (?,?,?,?,?,?,?,?)',
    new Date().toISOString(), g, method, route, res.statusCode, msg, req.user ? req.user.id : null, req.user ? req.user.name : null);
  const [n] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ApiError" WHERE "groupKey" = ? AND "at" >= ?', g, new Date(Date.now() - 10 * 60000).toISOString());
  if (Number(n.n) >= 5 && (!alerted.get(g) || Date.now() - alerted.get(g) > 3600000)) {
    alerted.set(g, Date.now());
    const admins = await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, select: { id: true } }).catch(() => []);
    await require('./notify').notifyUsers(admins.map((a) => a.id), { // eslint-disable-line global-require
      title: '⚠ A screen keeps failing',
      message: `${method} ${route} failed ${n.n} times in 10 minutes: "${msg}". Administration → Audit Logs → Errors has the details.`,
    }).catch(() => {});
  }
}

function middleware() {
  return (req, res, next) => {
    if (!String(req.originalUrl || '').startsWith('/api/')) return next();
    res.on('finish', () => { if (res.statusCode >= 500) record(req, res).catch(() => {}); });
    return next();
  };
}

async function groups({ days = 7 } = {}) {
  await ensure();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await prisma.$queryRawUnsafe(`SELECT "groupKey", "method", "route", "message", MAX("status") AS status, COUNT(*) AS n, MIN("at") AS first, MAX("at") AS last,
    COUNT(DISTINCT "userId") AS people FROM "ApiError" WHERE "at" >= ? GROUP BY "groupKey" ORDER BY n DESC LIMIT 200`, since);
  return rows.map((r) => ({ ...r, n: Number(r.n), status: Number(r.status), people: Number(r.people) }));
}
async function prune() {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "ApiError" WHERE "at" < ?', new Date(Date.now() - 60 * 86400000).toISOString());
}

module.exports = { middleware, groups, prune, routeOf, record };
