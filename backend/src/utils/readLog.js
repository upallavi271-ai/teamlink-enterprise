// ---------------------------------------------------------------------------
// WHO LOOKED AT WHAT (founder 2026-11-17, "Security first": the audit's read-access-log gap; DPDP asks who accessed personal data).
//
// The audit trail records every CHANGE; this records the READS of personal data: a candidate's profile and documents, an
// employee's record and document files, a client opening a resume in the client portal. One row per person + record per
// 10 minutes (opening the same profile five times in a row is one view). Rows live in their own raw table "ReadLog", so the
// audit trail is not flooded; kept 365 days. Administration -> Audit Logs -> "Who viewed" lists, filters and downloads them.
//
//   middleware()    mounted once in index.js before the routes; writes after a 200 answer, never slows the request
//   list(q)         { rows, total } for the admin screen (q: userId, entity, entityId, from, to, page, size)
// ---------------------------------------------------------------------------
const prisma = require('../db');

const RULES = [
  [/^\/api\/candidates\/([A-Za-z0-9_-]{8,})$/, 'Candidate', 'Candidate profile'],
  [/^\/api\/candidates\/([A-Za-z0-9_-]{8,})\/documents$/, 'Candidate', 'Candidate documents'],
  [/^\/api\/employees\/([A-Za-z0-9_-]{8,})$/, 'Employee', 'Employee record'],
  [/^\/api\/employees\/([A-Za-z0-9_-]{8,})\/documents\/[^/]+\/file$/, 'Employee', 'Employee document file'],
  [/^\/api\/portal\/client\/resume\/([A-Za-z0-9_-]{8,})$/, 'Application', 'Resume opened in the client portal'],
  // Employee Monitoring screenshots (founder 2026-11-17): every open of a screenshot image is logged (Admin / HR only can open one)
  [/^\/api\/monitoring\/screenshots\/(shot[A-Za-z0-9_-]{8,})$/, 'Monitoring', 'Screenshot opened'],
];
const recent = new Map(); // `${userId}|${entity}|${id}|${what}` -> ms
const WINDOW = 10 * 60000;
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ReadLog" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "at" TEXT NOT NULL,
        "userId" TEXT, "userName" TEXT, "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL, "what" TEXT NOT NULL, "ip" TEXT, "viewAsBy" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ReadLog_entity" ON "ReadLog" ("entity","entityId","at")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ReadLog_user" ON "ReadLog" ("userId","at")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

async function write(req, entity, entityId, what) {
  const u = req.user;
  if (!u) return;
  const k = `${u.id}|${entity}|${entityId}|${what}`;
  const now = Date.now();
  if (recent.get(k) && now - recent.get(k) < WINDOW) return;
  recent.set(k, now);
  if (recent.size > 20000) recent.clear();
  await ensure();
  const ip = (() => { try { return require('./clientIp').ipOf(req); } catch { return null; } })(); // eslint-disable-line global-require
  await prisma.$executeRawUnsafe('INSERT INTO "ReadLog" ("at","userId","userName","entity","entityId","what","ip","viewAsBy") VALUES (?,?,?,?,?,?,?,?)',
    new Date().toISOString(), u.id, u.name || null, entity, entityId, what, ip, req.viewAs ? req.viewAs.byName : null);
}

function middleware() {
  return (req, res, next) => {
    if (req.method !== 'GET' || !String(req.originalUrl || '').startsWith('/api/')) return next();
    const p = String(req.originalUrl || '').split('?')[0];
    const rule = RULES.find(([re]) => re.test(p));
    if (!rule) return next();
    const id = rule[0].exec(p)[1];
    res.on('finish', () => {
      if (res.statusCode === 200 && req.user) write(req, rule[1], id, rule[2]).catch(() => {});
    });
    return next();
  };
}

async function list(q = {}) {
  await ensure();
  const where = []; const args = [];
  if (q.userId) { where.push('"userId" = ?'); args.push(String(q.userId)); }
  if (q.entity) { where.push('"entity" = ?'); args.push(String(q.entity)); }
  if (q.entityId) { where.push('"entityId" = ?'); args.push(String(q.entityId)); }
  if (q.from) { where.push('"at" >= ?'); args.push(new Date(`${q.from}T00:00:00+05:30`).toISOString()); }
  if (q.to) { where.push('"at" <= ?'); args.push(new Date(`${q.to}T23:59:59+05:30`).toISOString()); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.max(1, Math.min(50000, Number(q.size) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  const [cnt] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "ReadLog" ${w}`, ...args);
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "ReadLog" ${w} ORDER BY "id" DESC LIMIT ? OFFSET ?`, ...args, size, (page - 1) * size);
  // the record's name, so the list says "Dr. X" and not an id
  const ids = (ent) => [...new Set(rows.filter((r) => r.entity === ent).map((r) => r.entityId))];
  const [cands, emps] = await Promise.all([
    ids('Candidate').length ? prisma.candidate.findMany({ where: { id: { in: ids('Candidate') } }, select: { id: true, name: true } }).catch(() => []) : [],
    ids('Employee').length ? prisma.employee.findMany({ where: { id: { in: ids('Employee') } }, select: { id: true, name: true, employeeCode: true } }).catch(() => []) : [],
  ]);
  const nameOf = new Map([...cands.map((c) => [`Candidate|${c.id}`, c.name]), ...emps.map((e) => [`Employee|${e.id}`, `${e.name}${e.employeeCode ? ` (${e.employeeCode})` : ''}`])]);
  return { total: Number(cnt.n), rows: rows.map((r) => ({ ...r, id: Number(r.id), recordName: nameOf.get(`${r.entity}|${r.entityId}`) || null })) };
}

async function prune() {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "ReadLog" WHERE "at" < ?', new Date(Date.now() - 365 * 86400000).toISOString());
}

module.exports = { middleware, list, prune, ensure, RULES };
