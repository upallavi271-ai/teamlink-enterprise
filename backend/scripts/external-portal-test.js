#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLIENT + CANDIDATE PORTAL WALL - acceptance sweep. SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/external-portal-test.js
//
// 1. Lists EVERY registered route (scripts/lib/listRoutes.js, no server needed).
// 2. For a real CLIENT login token and a real CANDIDATE login token (minted
//    exactly like /api/auth/login and candidatePortalAuth.sessionFor do) calls
//    every route outside the allow-list (all methods) and asserts 403 from the
//    wall; calls every allow-listed GET and asserts the wall let it through.
// 3. Explicit portal flows still answer 200, a staff token is untouched, a
//    forged / stale token cannot slip through.
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;

const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const EP = require(path.join(BACK, 'src/utils/externalPortalAuth'));
const { listRoutes } = require(path.join(BACK, 'scripts/lib/listRoutes'));

const realFetch = globalThis.fetch; // listRoutes() loads index.js, which installs the sandbox fetch block
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
async function rfetch(url, opt) {
  for (let i = 0; ; i += 1) {
    try { return await realFetch(url, { redirect: 'manual', ...opt }); } catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await rfetch(`${API}${p}`, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const concrete = (p) => p.replace(/:[A-Za-z0-9_]+/g, 'zz1');

(async () => {
  const made = { users: [], clients: [], candidates: [] };
  try {
    // ---------------- fixtures ----------------
    const client = await prisma.client.create({ data: { name: `ZZTEST Wall Client ${RUN}` } });
    made.clients.push(client.id);
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST Wall Candidate ${RUN}`, email: `zz-wall-cand-${RUN}@example.test` } });
    made.candidates.push(cand.id);
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const uClient = await prisma.user.create({ data: { ...base, name: `ZZTEST Wall Client User ${RUN}`, email: `zz-wall-client-${RUN}@example.test`, username: `zz-wall-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER' } });
    const uCand = await prisma.user.create({ data: { ...base, name: `ZZTEST Wall Cand User ${RUN}`, email: `zz-wall-cand-${RUN}@example.test`.replace('cand-', 'candu-'), username: `zz-wall-candu-${RUN}@example.test`, role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: cand.id } });
    const uStaff = await prisma.user.create({ data: { ...base, name: `ZZTEST Wall Admin ${RUN}`, email: `zz-wall-admin-${RUN}@example.test`, username: `zz-wall-admin-${RUN}@example.test`, role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, accountsAccess: true } });
    made.users.push(uClient.id, uCand.id, uStaff.id);

    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const tClient = await mint(uClient);
    const tCand = await mint(uCand);
    const tStaff = await mint(uStaff);

    // ---------------- 1. enumerate ----------------
    const routes = listRoutes().filter((r) => r.path.startsWith('/api') && !r.path.includes('<regex') && r.method !== '_ALL');
    console.log(`registered /api routes (method+path): ${routes.length}`);
    check('route enumeration found the API (> 1000 routes)', routes.length > 1000, routes.length);

    // ---------------- 2. sweep ----------------
    for (const [kind, token] of [['CLIENT', tClient], ['CANDIDATE', tCand]]) {
      const denied = routes.filter((r) => !EP.isAllowed(kind, r.method, concrete(r.path)));
      const allowed = routes.filter((r) => EP.isAllowed(kind, r.method, concrete(r.path)));
      console.log(`${kind}: ${denied.length} routes denied by the wall, ${allowed.length} allowed`);
      const bad = [];
      let i = 0;
      const queue = [...denied];
      const worker = async () => {
        while (queue.length) {
          const r = queue.shift();
          i += 1;
          const out = await call(r.method, concrete(r.path), token, ['GET', 'HEAD'].includes(r.method) ? undefined : {});
          if (!(out.status === 403 && out.body && out.body.externalPortal)) bad.push(`${r.method} ${r.path} -> ${out.status}`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      check(`${kind} token: all ${denied.length} routes outside the allow-list answer 403 (every method)`, bad.length === 0, bad.slice(0, 8));
      // allow-listed GETs must pass the wall (any status but the wall's 403)
      const badAllowed = [];
      for (const r of allowed.filter((x) => x.method === 'GET')) {
        if (process.env.TL_TEST_TRACE) console.log('  GET', concrete(r.path));
        const out = await call('GET', concrete(r.path), token);
        if (out.status === 403 && out.body && out.body.externalPortal) badAllowed.push(`${r.method} ${r.path}`);
      }
      check(`${kind} token: all ${allowed.filter((x) => x.method === 'GET').length} allow-listed GET routes pass the wall`, badAllowed.length === 0, badAllowed);
      console.log(`${kind} allow-list (${allowed.length}): ${allowed.map((r) => `${r.method} ${r.path}`).join(' | ')}`);
    }

    // The 76 GET routes named in the review stay shut
    const named = ['/api/announcements', '/api/documents', '/api/admin/departments', '/api/io/modules', '/api/employee-fields/layout', '/api/leave/types', '/api/incentives/options', '/api/helpdesk/meta', '/api/attendance/policy', '/api/masters', '/api/employees', '/api/clients', '/api/candidates', '/api/requirements', '/api/applications', '/api/dashboard/ats'];
    for (const [kind, token] of [['CLIENT', tClient], ['CANDIDATE', tCand]]) {
      const res = await Promise.all(named.map((p) => call('GET', p, token)));
      check(`${kind}: the review's staff GET routes (${named.length}) all 403`, res.every((r) => r.status === 403), res.map((r, k) => `${named[k]}:${r.status}`).filter((s) => !s.endsWith(':403')));
    }

    // ---------------- 3. real portal flows ----------------
    const c1 = await call('GET', '/api/portal/client', tClient);
    check('client: GET /api/portal/client = 200', c1.status === 200, c1.status + c1.text.slice(0, 120));
    const c2 = await call('GET', '/api/auth/me', tClient);
    check('client: GET /api/auth/me = 200', c2.status === 200, c2.status);
    const c3 = await call('GET', '/api/admin/notifications', tClient);
    check('client: bell (GET /api/admin/notifications) = 200', c3.status === 200, c3.status);
    const c4 = await call('GET', '/api/job-portal/client', tClient);
    check('client: GET /api/job-portal/client passes the wall', c4.status !== 403 || !(c4.body && c4.body.externalPortal), c4.status);
    const c5 = await call('GET', '/api/agreement/zz1', tClient);
    check('client: GET /api/agreement/:clientId passes the wall', !(c5.status === 403 && c5.body && c5.body.externalPortal), c5.status);
    const c6 = await call('GET', `/api/agreement/${client.id}`, tClient);
    check('client: own agreement GET passes wall (status not the wall 403)', !(c6.status === 403 && c6.body && c6.body.externalPortal), c6.status);
    const k1 = await call('GET', '/api/portal/candidate', tCand);
    check('candidate: GET /api/portal/candidate = 200', k1.status === 200, k1.status + k1.text.slice(0, 120));
    const k2 = await call('GET', '/api/portal/candidate/extras', tCand);
    check('candidate: GET /api/portal/candidate/extras = 200', k2.status === 200, k2.status);
    const k3 = await call('GET', '/api/auth/me', tCand);
    check('candidate: GET /api/auth/me = 200', k3.status === 200, k3.status);
    const k4 = await call('GET', '/api/admin/notifications', tCand);
    check('candidate: bell = 200', k4.status === 200, k4.status);
    // a client cannot use the candidate portal and vice versa (route level, unchanged)
    const x1 = await call('GET', '/api/portal/candidate', tClient);
    const x2 = await call('GET', '/api/portal/client', tCand);
    check('client cannot open /portal/candidate and candidate cannot open /portal/client (403)', x1.status === 403 && x2.status === 403, [x1.status, x2.status]);
    // public pages still open to a browser that carries a portal token
    for (const [kind, token] of [['CLIENT', tClient], ['CANDIDATE', tCand]]) {
      const pj = await call('GET', '/api/public/careers/jobs', token);
      check(`${kind} token on public careers list = 200`, pj.status === 200, pj.status);
      const pa = await call('GET', '/api/public/agreement/zz1', token);
      check(`${kind} token on public agreement link passes (404/410, not wall)`, !(pa.status === 403 && pa.body && pa.body.externalPortal), pa.status);
      const ol = await call('GET', '/api/offer-link/zz1', token);
      check(`${kind} token on offer link passes the wall`, !(ol.status === 403 && ol.body && ol.body.externalPortal), ol.status);
      const lg = await call('POST', '/api/auth/login', token, { email: 'nobody@example.test', password: 'x' });
      check(`${kind} stale token on the sign-in page: login answers 401 (not the wall)`, lg.status === 401, lg.status);
    }
    // ---------------- 4. staff untouched, forged, stale ----------------
    const s1 = await call('GET', '/api/announcements', tStaff);
    const s2 = await call('GET', '/api/admin/departments', tStaff);
    const s3 = await call('GET', '/api/masters', tStaff);
    check('staff (admin) token: staff routes unchanged (announcements/departments/masters = 200)', s1.status === 200 && s2.status === 200 && s3.status === 200, [s1.status, s2.status, s3.status]);
    const f1 = jwt.sign({ id: uStaff.id, role: 'CLIENT' }, 'not-the-secret');
    const f2 = await call('GET', '/api/announcements', f1);
    const f3 = await call('GET', '/api/portal/client', f1);
    check('forged token claiming CLIENT: staff route 403, portal 401', f2.status === 403 && f3.status === 401, [f2.status, f3.status]);
    // stale token: signed by us, claims say a staff role, but the DB login IS a client now
    const stale = jwt.sign({ id: uClient.id, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const st1 = await call('GET', '/api/announcements', stale);
    const st2 = await call('GET', '/api/portal/client', stale);
    check('stale token (claims say staff, DB says client): staff route 403 by the 2nd layer, portal 200', st1.status === 403 && st2.status === 200, [st1.status, st2.status]);
    const cl = await call('GET', '/api/leave/types', tClient);
    check('client: GET /api/leave/types (was readable before) = 403 now', cl.status === 403, cl.status);
    const cf = await call('POST', '/api/ats/interviews/zz1/client-feedback', tClient, {});
    const cf2 = await call('POST', '/api/ats/interviews/zz1/client-feedback', tCand, {});
    check('client may POST /api/ats/interviews/:id/client-feedback (passes the wall; the route still checks ownership); candidate may not', !(cf.status === 403 && cf.body && cf.body.externalPortal) && cf2.status === 403 && cf2.body && cf2.body.externalPortal, [cf.status, cf2.status]);
    // View as (read-only) of a client: same wall, plus the one POST that ends it
    check('View-as token of a client may POST /api/admin/view-as/exit (allow-list)', EP.isAllowed('CLIENT', 'POST', '/api/admin/view-as/exit'));
    check('case tricks do not slip past: /API/Announcements and //api paths', !EP.isAllowed('CLIENT', 'GET', '/API/announcements') && !EP.isAllowed('CANDIDATE', 'GET', '/Api/documents/'));
    const ci = await call('GET', '/API/announcements', tClient);
    check('client GET /API/announcements (upper-case) = 403', ci.status === 403, ci.status);
  } catch (e) {
    fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...made.users, ...made.clients, ...made.candidates] } }] } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      await prisma.candidate.deleteMany({ where: { id: { in: made.candidates } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
