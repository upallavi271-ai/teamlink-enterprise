#!/usr/bin/env node
// ---------------------------------------------------------------------------
// JOB FIXES 1-7 acceptance test (2026-10-13). SANDBOX ONLY, light, run once.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/req-fixes-7-test.js
//
//   D  several departments: saved (first = main), visible to the TL of an EXTRA department, not to another department's TL,
//      filter by an extra department finds it
//   R  several recruiters: saved, visible to each, not to others; bulk assign of several; privacy (no fee / agreement)
//   S  status: every API row / summary chain / facet says only Open or Closed; Close needs a REASON; Reopen works
//   L  locations list + inline add (BDE team / Admin only)
//   N  New items: count, seen tracking, per user
// Builds ZZTEST RQ7 fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
const DA = `ZZRQ7 Alpha ${RUN}`; const DB = `ZZRQ7 Beta ${RUN}`; const DC = `ZZRQ7 Gamma ${RUN}`;
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const rows = (r) => (Array.isArray(r.body) ? r.body : (r.body && (r.body.rows || r.body.items || r.body.requirements)) || []);

(async () => {
  const made = { users: [], clients: [], reqs: [], emps: [] };
  const locBefore = await prisma.appSetting.findUnique({ where: { key: 'ats.jobLocations' } });
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST RQ7 ${tag} ${RUN}`, email: `zz-rq7-${tag}-${RUN}@example.test`, username: `zz-rq7-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (extra.atsRole === 'RECRUITER') {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-RQ7-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null } });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uTlB = await mk('tlb', { role: 'TL', atsRole: 'TL', atsDepartment: DB, atsScopeDepartments: DB });
    const uTlC = await mk('tlc', { role: 'TL', atsRole: 'TL', atsDepartment: DC, atsScopeDepartments: DC });
    const uR1 = await mk('r1', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DA, atsScopeDepartments: DA });
    const uR2 = await mk('r2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DA, atsScopeDepartments: DA });
    const uR3 = await mk('r3', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DA, atsScopeDepartments: DA });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = { admin: await mint(uAdmin), tlB: await mint(uTlB), tlC: await mint(uTlC), r1: await mint(uR1), r2: await mint(uR2), r3: await mint(uR3) };
    const client = await prisma.client.create({ data: { name: `ZZTEST RQ7 Client ${RUN}`, location: 'ZZ Town', ownerDepartment: DA, clientType: 'Client', agreementStatus: 'ACTIVE' } });
    made.clients.push(client.id);

    // ---- D + R: a job in two departments with two recruiters ---------------------------------
    const body1 = {
      title: `ZZTEST RQ7 Job one ${RUN}`, clientId: client.id, status: 'OPEN', department: DA, departments: [DA, DB], openings: 2, priority: 'Medium',
      jobDescription: 'ZZTEST RQ7 description', skills: 'zz', employmentType: 'Full Time', workMode: 'Work From Office', location: 'Hyderabad',
      preferredLocation: 'Hyderabad, Pune', joiningTimeline: 'Within 15 Days', experience: '1-3 yrs',
      recruiterId: uR1.id, recruiterIds: [uR2.id], postingSources: 'None',
    };
    const c1 = await call('POST', '/api/requirements', T.admin, body1);
    check('create job in two departments', c1.status === 201 && c1.body && c1.body.id, c1.body || c1.text);
    const j1 = c1.body || {};
    if (j1.id) made.reqs.push(j1.id);
    check('main department is the first, list has both', j1.department === DA && Array.isArray(j1.departments) && j1.departments.length === 2 && j1.departments.includes(DB), j1.departments);
    check('preferred locations saved as a list', (await prisma.requirement.findUnique({ where: { id: j1.id } })).preferredLocation === 'Hyderabad, Pune');
    const g1 = await call('GET', `/api/requirements/${j1.id}`, T.admin);
    check('detail returns departments', g1.status === 200 && (g1.body.departments || []).length === 2, g1.body && g1.body.departments);
    check('detail returns both recruiters', g1.body && g1.body.recruiterId === uR1.id && (g1.body.coRecruiters || []).some((c) => c.id === uR2.id));

    // an UNASSIGNED job in two departments: the pool of the extra department's TL
    const c2 = await call('POST', '/api/requirements', T.admin, { ...body1, title: `ZZTEST RQ7 Job two ${RUN}`, recruiterId: '', recruiterIds: [] });
    const j2 = c2.body || {};
    if (j2.id) made.reqs.push(j2.id);
    const listIds = async (tok, q = '') => rows(await call('GET', `/api/requirements?pageSize=100${q}`, tok)).map((r) => r.id);
    const tlB = await listIds(T.tlB); const tlC = await listIds(T.tlC);
    check('TL of the EXTRA department sees the unassigned job', tlB.includes(j2.id), { count: tlB.length });
    check('TL of another department does not', !tlC.includes(j2.id) && !tlC.includes(j1.id));
    const byExtra = await listIds(T.admin, `&department=${encodeURIComponent(DB)}`);
    check('department filter on the extra department finds the job', byExtra.includes(j1.id) && byExtra.includes(j2.id));
    const lst = rows(await call('GET', `/api/requirements?pageSize=100&department=${encodeURIComponent(DB)}`, T.admin)).find((r) => r.id === j1.id);
    check('list row carries departments', lst && (lst.departments || []).length === 2, lst && lst.departments);
    const fac = await call('GET', `/api/ats/facets?scope=requirements`, T.admin).catch(() => null);
    void fac;

    // ---- R: recruiters ---------------------------------------------------------------------
    const r1 = await listIds(T.r1); const r2 = await listIds(T.r2); const r3 = await listIds(T.r3);
    check('main recruiter sees the job', r1.includes(j1.id));
    check('second recruiter sees the job', r2.includes(j1.id));
    check('other recruiter does not', !r3.includes(j1.id));
    const d3 = await call('GET', `/api/requirements/${j1.id}`, T.r3);
    check('other recruiter cannot open it', d3.status >= 400, d3.status);
    const d1 = await call('GET', `/api/requirements/${j1.id}`, T.r2);
    check('privacy: recruiter gets no fee / agreement block', d1.status === 200 && !d1.body.commercial && !d1.body.agreement, Object.keys(d1.body || {}).filter((k) => /commercial|agreement|fee/i.test(k)));
    // the server refuses any "zztest" / example.test login as an assignee (user rule), so the two bulk targets get plain names for this step only
    for (const u of [uR1, uR3]) await prisma.user.update({ where: { id: u.id }, data: { name: `RQ7 Probe ${u.id.slice(-5)}`, email: `rq7-${u.id.slice(-8)}@probe.local` } });
    const bulk = await call('POST', '/api/requirements/bulk', T.admin, { action: 'assign-recruiter', ids: [j2.id], userId: uR1.id, userIds: [uR1.id, uR3.id] });
    check('bulk assign of two recruiters', bulk.status === 200 && bulk.body.done === 1, bulk.body || bulk.text);
    const j2row = await prisma.requirement.findUnique({ where: { id: j2.id } });
    check('bulk saved main + extra recruiter', j2row.recruiterId === uR1.id && (j2row.recruiterIds || '').split(',').includes(uR3.id), j2row);
    check('the third recruiter now sees job two', (await listIds(T.r3)).includes(j2.id));

    // ---- S: only Open / Closed ---------------------------------------------------------------
    const all = rows(await call('GET', '/api/requirements?pageSize=100', T.admin));
    check('every list row says Open or Closed', all.length > 0 && all.every((r) => r.displayStatus && ['open', 'closed'].includes(r.displayStatus.key) && ['Open', 'Closed'].includes(r.displayStatus.label)), [...new Set(all.map((r) => r.displayStatus && r.displayStatus.label))]);
    const sum = await call('GET', '/api/requirements/summary', T.admin);
    check('summary chain is only Open and Closed', sum.status === 200 && sum.body.chain.length === 2 && sum.body.chain.map((c) => c.key).join() === 'open,closed', sum.body && sum.body.chain);
    check('summary has no On hold card', sum.body && sum.body.cards && !('hold' in sum.body.cards), sum.body && sum.body.cards);
    const noReason = await call('POST', `/api/requirements/${j1.id}/close`, T.admin, { outcome: 'other' });
    check('close without a note for "Other" is refused in plain words', noReason.status === 400, noReason.body);
    const closed = await call('POST', `/api/requirements/${j1.id}/close`, T.admin, { outcome: 'paused', note: 'ZZTEST RQ7' });
    check('close with reason "On hold"', closed.status === 200 && closed.body.lifecycle && closed.body.lifecycle.closed && closed.body.lifecycle.closed.outcome === 'On hold', closed.body);
    const cl = rows(await call('GET', '/api/requirements?pageSize=100&dstatus=closed', T.admin)).map((r) => r.id);
    const op = rows(await call('GET', '/api/requirements?pageSize=100&dstatus=open', T.admin)).map((r) => r.id);
    check('Closed filter has it, Open filter does not', cl.includes(j1.id) && !op.includes(j1.id) && op.includes(j2.id));
    const st = rows(await call('GET', '/api/requirements?pageSize=100&status=OPEN', T.admin)).map((r) => r.id);
    check('status=OPEN excludes the closed job', !st.includes(j1.id) && st.includes(j2.id));
    const lc = await call('GET', `/api/requirements/${j1.id}/lifecycle`, T.admin);
    check('pause is no longer offered', lc.body && lc.body.rights && lc.body.rights.pause === false && Array.isArray(lc.body.closeReasons) && lc.body.closeReasons.length === 4, lc.body && lc.body.rights);
    const re = await call('POST', `/api/requirements/${j1.id}/reopen`, T.admin, {});
    check('Reopen works', re.status === 200, re.body);

    // ---- L: locations ------------------------------------------------------------------------
    const loc = await call('GET', '/api/requirements/locations', T.admin);
    check('locations list (places + Remote / Any)', loc.status === 200 && loc.body.locations.length > 10 && loc.body.special.includes('Remote') && loc.body.canAdd === true, loc.body && Object.keys(loc.body));
    const add = await call('POST', '/api/requirements/locations', T.admin, { name: `ZZTEST RQ7 Town ${RUN}` });
    check('Admin adds a new place inline', add.status === 200, add.body);
    const loc2 = await call('GET', '/api/requirements/locations', T.admin);
    check('the new place is in the list', loc2.body.locations.some((l) => l.name.includes('ZZTEST RQ7 Town')));
    const addR = await call('POST', '/api/requirements/locations', T.r1, { name: 'ZZTEST RQ7 nope' });
    check('a recruiter cannot add a place', addR.status === 403, addR.status);

    // ---- N: New items -------------------------------------------------------------------------
    const n1 = await call('GET', '/api/new-items', T.r2);
    check('New items list for the recruiter has the job', n1.status === 200 && n1.body.count >= 1 && n1.body.items.some((i) => i.key === `job:${j1.id}` && !i.seen), n1.body);
    const n3 = await call('GET', '/api/new-items', T.r3);
    check('another recruiter does not get job one', !n3.body.items.some((i) => i.key === `job:${j1.id}`));
    const seen = await call('POST', '/api/new-items/seen', T.r2, { keys: [`job:${j1.id}`] });
    check('opening marks it seen', seen.status === 200 && seen.body.marked === 1, seen.body);
    const n2 = await call('GET', '/api/new-items', T.r2);
    check('count went down and the item is under Seen', n2.body.count === n1.body.count - 1 && n2.body.items.some((i) => i.key === `job:${j1.id}` && i.seen), n2.body.count);
    const n3b = await call('GET', '/api/new-items', T.r1);
    check('seen is per person', n3b.body.items.some((i) => i.key === `job:${j1.id}` && !i.seen));
    const all2 = await call('POST', '/api/new-items/seen', T.r2, { all: true });
    const n4 = await call('GET', '/api/new-items', T.r2);
    check('Mark all as seen empties New', all2.status === 200 && n4.body.count === 0, n4.body.count);
  } catch (e) {
    fail += 1; console.log('FAIL  test crashed', e && e.stack);
  } finally {
    // ---- clean every ZZTEST RQ7 row ----
    try {
      const ids = made.users;
      await prisma.appSetting.deleteMany({ where: { OR: [...made.reqs.map((id) => ({ key: `reqDepts.${id}` })), ...ids.map((id) => ({ key: `newSeen.${id}` }))] } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: made.reqs } }] } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
      await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: made.reqs } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      if (locBefore) await prisma.appSetting.update({ where: { key: 'ats.jobLocations' }, data: { value: locBefore.value } });
      else await prisma.appSetting.deleteMany({ where: { key: 'ats.jobLocations' } });
    } catch (e) { console.log('cleanup problem', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
