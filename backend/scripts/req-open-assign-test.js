#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AN OPEN JOB IS OPEN TO THE TL, AND GETS ITS RECRUITER (founder 2026-10-30: "req open lo vunna kuda closed ani chupisthundhi
// (TL ki), assign cheyyadaniki raavatledhu") - COPY DATABASE ONLY, never dev.db.
//
//   cd backend && npm run sandbox -- --restart --detach --no-watch
//   TL_API=http://localhost:4011 TL_TEST_DB=<absolute path of prisma/sandbox.db> node scripts/req-open-assign-test.js
//
// A job waiting for the client agreement (AGREEMENT_CHECK) - also a draft or a paused one - is Open, not Closed:
// 1. the TL's requirement list: needs a recruiter, may assign
// 2. the Team page's Assignments: open
// 3. the TL assigns a recruiter: 200
// 4. a CLOSED job asks for nobody
// A ZZTEST client and two requirements are made and removed again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (a copy-database server), never 4010.'); process.exit(2); }
const DB = process.env.TL_TEST_DB;
if (!DB || /dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to the absolute path of a COPY database (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

(async () => {
  const made = { client: null, reqs: [] };
  try {
    const tl = await prisma.user.findFirst({ where: { atsRole: 'TL', status: 'Active' }, orderBy: { createdAt: 'asc' } });
    if (!tl) throw new Error('no active TL in the copy');
    const rec = await prisma.user.findFirst({ where: { atsRole: 'RECRUITER', status: 'Active', ...(tl.atsDepartment ? { atsDepartment: tl.atsDepartment } : {}) } })
      || await prisma.user.findFirst({ where: { atsRole: 'RECRUITER', status: 'Active' } });
    if (!rec) throw new Error('no active recruiter in the copy');
    await prisma.user.updateMany({ where: { id: { in: [tl.id, rec.id] } }, data: { passwordChangedAt: new Date() } });
    const T = jwt.sign(tokenPayload(await resolveIdentity(tl.id)), process.env.JWT_SECRET, { expiresIn: '1h' });

    made.client = await prisma.client.create({ data: { name: `ZZTEST Open Client ${RUN}`, agreementStatus: 'SENT', ownerDepartment: tl.atsDepartment || null } });
    const base = { clientId: made.client.id, tlId: tl.id, tl: tl.name, department: tl.atsDepartment || null, openings: 1 };
    const waiting = await prisma.requirement.create({ data: { ...base, title: `ZZTEST Waiting Job ${RUN}`, status: 'AGREEMENT_CHECK' } });
    const closed = await prisma.requirement.create({ data: { ...base, title: `ZZTEST Closed Job ${RUN}`, status: 'CLOSED' } });
    made.reqs.push(waiting.id, closed.id);

    // ---- 1. the TL's requirement list ----
    const list = await call('GET', `/api/requirements?page=1&pageSize=50&view=all&search=${encodeURIComponent(RUN)}`, T);
    const rows = (list.body && list.body.rows) || [];
    const w = rows.find((r) => r.id === waiting.id);
    const c = rows.find((r) => r.id === closed.id);
    check('L1 the TL sees the job waiting for the client agreement in their list', list.status === 200 && !!w, [list.status, rows.length, list.text && list.text.slice(0, 200)]);
    check('L2 ...it is Open (not Closed) and asks for a recruiter, with Assign allowed', w && w.displayStatus && w.displayStatus.key === 'open' && w.needs === 'recruiter' && w.mayAssign === true, w && { ds: w.displayStatus && w.displayStatus.key, needs: w.needs, mayAssign: w.mayAssign, status: w.status });
    check('L3 a CLOSED job asks for nobody', !c || c.needs === null || c.needs === undefined, c && { needs: c.needs });

    // ---- 2. the Team page ----
    const team = await call('GET', '/api/ats/team?view=assignments&fresh=1', T);
    const trow = ((team.body && team.body.rows) || []).find((r) => r.id === waiting.id);
    check('T1 Team page Assignments: the waiting job is open', team.status === 200 && trow && trow.open === true && trow.status === 'AGREEMENT_CHECK', [team.status, trow && { open: trow.open, live: trow.live, status: trow.status }]);
    const tclosed = ((team.body && team.body.rows) || []).find((r) => r.id === closed.id);
    check('T2 ...and the closed job is not', !tclosed || tclosed.open === false, tclosed && tclosed.open);

    // ---- 3. assign ----
    const a = await call('POST', `/api/requirements/${waiting.id}/assign`, T, { recruiterId: rec.id });
    const after = await prisma.requirement.findUnique({ where: { id: waiting.id } });
    check('A1 the TL assigns a recruiter to the waiting job (200, saved)', a.status === 200 && after.recruiterId === rec.id, [a.status, a.body && a.body.error, after.recruiterId]);
    check('A2 assigning does not make it live before the agreement (status stays AGREEMENT_CHECK)', after.status === 'AGREEMENT_CHECK', after.status);
  } catch (e) {
    check('no error', false, e.stack || e.message);
  } finally {
    for (const id of made.reqs) {
      await prisma.auditLog.deleteMany({ where: { entityId: id } }).catch(() => null);
      await prisma.notification.deleteMany({ where: { message: { contains: id } } }).catch(() => null);
      await prisma.requirement.delete({ where: { id } }).catch((e) => console.log('cleanup req:', e.message));
    }
    if (made.client) {
      await prisma.auditLog.deleteMany({ where: { entityId: made.client.id } }).catch(() => null);
      await prisma.client.delete({ where: { id: made.client.id } }).catch((e) => console.log('cleanup client:', e.message));
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
