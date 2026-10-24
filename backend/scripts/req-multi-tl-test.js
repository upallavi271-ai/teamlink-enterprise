#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SEVERAL TEAM LEADS ON ONE JOB acceptance test (2026-10-14). SANDBOX ONLY, light, run once.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/req-multi-tl-test.js
//
//   save / read several TLs (first = main), extra TLs see the job + its people, an unassigned TL does not,
//   filter by ANY TL, workload counts, notifications to every TL, Change-team endpoint, bulk assign of several TLs,
//   validation (not a TL / left / over the maximum), recruiter privacy unchanged, audit trail, CSV export.
// Builds ZZTEST RT fixtures in sandbox.db and removes them again.
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
const DA = `ZZRT Alpha ${RUN}`; const DB = `ZZRT Beta ${RUN}`; const DC = `ZZRT Gamma ${RUN}`;
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
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
const rows = (r) => (Array.isArray(r.body) ? r.body : (r.body && (r.body.rows || r.body.items || r.body.requirements || r.body.applications)) || []);

(async () => {
  const made = { users: [], clients: [], reqs: [], emps: [], cands: [], apps: [] };
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST RT ${tag} ${RUN}`, email: `zz-rt-${tag}-${RUN}@example.test`, username: `zz-rt-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      return u;
    };
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uA = await mk('tla', { role: 'TL', atsRole: 'TL', atsDepartment: DA, atsScopeDepartments: DA });
    const uB = await mk('tlb', { role: 'TL', atsRole: 'TL', atsDepartment: DB, atsScopeDepartments: DB });
    const uC = await mk('tlc', { role: 'TL', atsRole: 'TL', atsDepartment: DC, atsScopeDepartments: DC });
    const uD = await mk('tld', { role: 'TL', atsRole: 'TL', atsDepartment: DC, atsScopeDepartments: DC });
    const uE = await mk('tle', { role: 'TL', atsRole: 'TL', atsDepartment: DA, atsScopeDepartments: DA });
    const uR = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DA, atsScopeDepartments: DA });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    // the picker never offers a "zztest" / example.test login (user rule), so the TLs get plain names for this run only
    for (const u of [uA, uB, uC, uD, uE]) await prisma.user.update({ where: { id: u.id }, data: { name: `RT Probe ${u.id.slice(-5)}`, email: `rt-${u.id.slice(-8)}@probe.local` } });
    // E has left
    await prisma.user.update({ where: { id: uE.id }, data: { status: 'Inactive' } });
    const T = { admin: await mint(uAdmin), a: await mint(uA), b: await mint(uB), c: await mint(uC), d: await mint(uD), r: await mint(uR) };
    const client = await prisma.client.create({ data: { name: `ZZTEST RT Client ${RUN}`, location: 'ZZ Town', ownerDepartment: DA, clientType: 'Client', agreementStatus: 'ACTIVE' } });
    made.clients.push(client.id);
    const listIds = async (tok, q = '') => rows(await call('GET', `/api/requirements?pageSize=100${q}`, tok)).map((r) => r.id);

    // ---- save / read ---------------------------------------------------------------------------
    const body1 = {
      title: `ZZTEST RT Job one ${RUN}`, clientId: client.id, status: 'OPEN', department: DA, openings: 1, priority: 'Medium',
      jobDescription: 'ZZTEST RT description', skills: 'zz', employmentType: 'Full Time', workMode: 'Work From Office', location: 'Hyderabad',
      preferredLocation: 'Hyderabad', joiningTimeline: 'Within 15 Days', experience: '1-3 yrs', postingSources: 'None',
      tlIds: [uA.id, uB.id, uC.id], recruiterId: uR.id,
    };
    const c1 = await call('POST', '/api/requirements', T.admin, body1);
    check('create a job with three team leads', c1.status === 201 && c1.body && c1.body.id, c1.body || c1.text);
    const j1 = c1.body || {};
    if (j1.id) made.reqs.push(j1.id);
    check('the first TL is the main one (tlId)', j1.tlId === uA.id && (j1.tlIds || []).join() === [uA.id, uB.id, uC.id].join(), j1.tlIds);
    const g1 = await call('GET', `/api/requirements/${j1.id}`, T.admin);
    const sm1 = await call('GET', `/api/requirements/${j1.id}/summary`, T.admin);
    check('detail lists main + also-assigned TLs', g1.status === 200 && (g1.body.extraTlIds || []).join() === [uB.id, uC.id].join() && sm1.body && sm1.body.team && (sm1.body.team.alsoTls || []).length === 2, g1.body && g1.body.extraTlIds);

    // ---- who sees it -----------------------------------------------------------------------------
    const lA = await listIds(T.a); const lB = await listIds(T.b); const lC = await listIds(T.c); const lD = await listIds(T.d);
    check('main TL sees the job', lA.includes(j1.id));
    check('each extra TL sees the job', lB.includes(j1.id) && lC.includes(j1.id));
    check('a TL who is not assigned does not', !lD.includes(j1.id));
    const dB = await call('GET', `/api/requirements/${j1.id}`, T.b);
    const dD = await call('GET', `/api/requirements/${j1.id}`, T.d);
    check('an extra TL can open it, an unassigned TL cannot', dB.status === 200 && dD.status >= 400, [dB.status, dD.status]);
    // the people on the job
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST RT Candidate ${RUN}`, email: `zz-rt-cand-${RUN}@example.test`, phone: '9000000000' } });
    made.cands.push(cand.id);
    const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: j1.id, stage: 'RECRUITER_REVIEW' } });
    made.apps.push(app.id);
    const appsFor = async (tok) => rows(await call('GET', `/api/applications?requirementId=${j1.id}`, tok)).map((a) => a.id);
    check('an extra TL sees the job candidates like the main TL', (await appsFor(T.a)).includes(app.id) && (await appsFor(T.b)).includes(app.id));
    check('an unassigned TL does not see them', !(await appsFor(T.d)).includes(app.id));

    // ---- filter by ANY TL ------------------------------------------------------------------------
    const fB = await listIds(T.admin, `&tlId=${uB.id}`); const fD = await listIds(T.admin, `&tlId=${uD.id}`); const fDB = await listIds(T.admin, `&tlId=${uD.id},${uB.id}`);
    check('TL filter matches when ANY assigned TL is the one', fB.includes(j1.id) && !fD.includes(j1.id) && fDB.includes(j1.id));
    const mine = await listIds(T.c, '&mine=1');
    check('"my jobs" includes a job where I am an extra TL', mine.includes(j1.id));
    const row = rows(await call('GET', `/api/requirements?pageSize=100&tlId=${uB.id}`, T.admin)).find((r) => r.id === j1.id);
    check('list row carries extra TL names for "Name +2"', row && (row.extraTlNames || []).length === 2 && row.tlName, row && { n: row.extraTlNames, t: row.tlName });

    const fac = await call('GET', `/api/ats-io/facets/requirements?tlId=`, T.admin);
    const facTl = ((fac.body && fac.body.facets && fac.body.facets.tlId) || []);
    check('TL filter options list an extra-only TL with a count', facTl.some((o) => o.value === uC.id && o.count >= 1), facTl.slice(0, 5));

    // ---- workload --------------------------------------------------------------------------------
    const bench = await call('GET', '/api/requirements/assignable-people?tls=all', T.admin);
    const tlB = ((bench.body && bench.body.tls) || []).find((t) => t.id === uB.id);
    check('workload counts a job the TL is only an extra TL on', tlB && tlB.openJobs >= 1, tlB);
    const noExit = ((bench.body && bench.body.tls) || []).some((t) => t.id === uE.id);
    check('a TL who has left is not offered', !noExit);

    // ---- notifications ---------------------------------------------------------------------------
    const notes = await prisma.notification.findMany({ where: { userId: { in: [uA.id, uB.id, uC.id, uD.id] } }, select: { userId: true, title: true } });
    const got = (id) => notes.some((n) => n.userId === id && /assigned|updated|opened|REQ-|ZZTEST/i.test(n.title));
    check('every assigned TL got a notification, the others did not', got(uA.id) && got(uB.id) && got(uC.id) && !got(uD.id), notes);

    // ---- recruiter privacy unchanged ---------------------------------------------------------------
    const dR = await call('GET', `/api/requirements/${j1.id}`, T.r);
    check('recruiter still gets no fee / agreement block', dR.status === 200 && !dR.body.commercial && !dR.body.agreement);

    // ---- edit: swap the team ------------------------------------------------------------------------
    const put1 = await call('PUT', `/api/requirements/${j1.id}`, T.admin, { tlIds: [uB.id, uD.id] });
    check('edit: new main TL and a new extra TL', put1.status === 200 && put1.body.tlId === uB.id && (put1.body.tlIds || []).join() === [uB.id, uD.id].join(), put1.body);
    check('the removed TLs no longer see it, the new one does', !(await listIds(T.a)).includes(j1.id) && !(await listIds(T.c)).includes(j1.id) && (await listIds(T.d)).includes(j1.id));
    const audit = await prisma.auditLog.findMany({ where: { entityId: j1.id } });
    check('audit says the team changed', audit.some((a) => /Team leads/.test(`${a.field || ''} ${a.toValue || ''}${a.fromValue || ''}`) || /Requirement field changed/.test(a.action)) && audit.some((a) => a.action === 'Requirement updated'), audit.map((a) => a.action));

    // ---- Change team endpoint ------------------------------------------------------------------------
    const as1 = await call('POST', `/api/requirements/${j1.id}/assign`, T.admin, { tlIds: [uC.id, uA.id, uB.id] });
    check('Change team saves several TLs', as1.status === 200 && as1.body.tlId === uC.id && (as1.body.tlIds || []).length === 3, as1.body);
    const as2 = await call('POST', `/api/requirements/${j1.id}/assign`, T.admin, { tlIds: [uA.id] });
    check('back to one TL clears the also-assigned list', as2.status === 200 && (as2.body.tlIds || []).join() === uA.id && !(await listIds(T.b)).includes(j1.id), as2.body);

    // ---- bulk ---------------------------------------------------------------------------------------
    const c2 = await call('POST', '/api/requirements', T.admin, { ...body1, title: `ZZTEST RT Job two ${RUN}`, tlIds: [], recruiterId: '' });
    const j2 = c2.body || {};
    if (j2.id) made.reqs.push(j2.id);
    const bulk = await call('POST', '/api/requirements/bulk', T.admin, { action: 'assign-tl', ids: [j2.id, j1.id], userId: uB.id, userIds: [uB.id, uC.id, uD.id] });
    check('bulk assign of three TLs', bulk.status === 200 && bulk.body.done === 2, bulk.body || bulk.text);
    const r2 = await prisma.requirement.findUnique({ where: { id: j2.id } });
    check('bulk saved the main TL', r2.tlId === uB.id, r2.tlId);
    check('bulk saved the also-assigned TLs (both jobs)', (await listIds(T.c)).includes(j2.id) && (await listIds(T.d)).includes(j2.id) && (await listIds(T.c)).includes(j1.id));
    const bulk1 = await call('POST', '/api/requirements/bulk', T.admin, { action: 'assign-tl', ids: [j2.id], userId: uB.id });
    check('bulk with ONE TL replaces the team', bulk1.status === 200 && !(await listIds(T.c)).includes(j2.id));

    // ---- validation ------------------------------------------------------------------------------------
    const vNon = await call('PUT', `/api/requirements/${j2.id}`, T.admin, { tlIds: [uB.id, uR.id] });
    check('a recruiter cannot be a team lead', vNon.status === 400, vNon.body);
    const vLeft = await call('PUT', `/api/requirements/${j2.id}`, T.admin, { tlIds: [uB.id, uE.id] });
    check('a TL who has left is refused', vLeft.status === 400, vLeft.body);
    const many = [];
    for (let i = 0; i < 11; i += 1) many.push(uA.id + (i ? `x${i}` : ''));
    const vMax = await call('PUT', `/api/requirements/${j2.id}`, T.admin, { tlIds: many });
    check('more than the maximum is refused in plain words', vMax.status === 400 && /at most/i.test((vMax.body && vMax.body.error) || ''), vMax.body);
    const vBulk = await call('POST', '/api/requirements/bulk', T.admin, { action: 'assign-tl', ids: [j2.id], userId: uB.id, userIds: [uB.id, uR.id] });
    check('bulk refuses a non-TL', vBulk.status === 400, vBulk.body);
    const vRec = await call('PUT', `/api/requirements/${j2.id}`, T.r, { tlIds: [uB.id, uC.id] });
    check('a recruiter cannot change the team leads', vRec.status >= 400 || !(await listIds(T.c)).includes(j2.id), vRec.status);

    // ---- row-level assign of 3 recruiters (the Jobs list 'Assign a recruiter' dialog), main recruiter, undo ----
    const uR2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DA, atsScopeDepartments: DA, team: 'ZZRT Team 2' });
    const uR3 = await mk('rec3', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DA, atsScopeDepartments: DA, team: 'ZZRT Team 1' });
    for (const u of [uR, uR2, uR3]) await prisma.user.update({ where: { id: u.id }, data: { name: `RT Probe ${u.id.slice(-5)}`, email: `rt-${u.id.slice(-8)}@probe.local` } });
    const T2 = { r2: await mint(uR2), r3: await mint(uR3) };
    const c3 = await call('POST', '/api/requirements', T.admin, { ...body1, title: `ZZTEST RT Job three ${RUN}`, tlIds: [uA.id], recruiterId: '' });
    const j3 = c3.body || {};
    if (j3.id) made.reqs.push(j3.id);
    const rb = await call('POST', '/api/requirements/bulk', T.admin, { action: 'assign-recruiter', ids: [j3.id], userId: uR3.id, userIds: [uR3.id, uR.id, uR2.id] });
    const j3row = await prisma.requirement.findUnique({ where: { id: j3.id } });
    check('row-level: 3 recruiters from 2+ teams saved, main = first ticked', rb.status === 200 && rb.body.done === 1 && j3row.recruiterId === uR3.id && (j3row.recruiterIds || '').split(',').sort().join() === [uR.id, uR2.id].sort().join(), rb.body || j3row);
    check('every assigned recruiter sees the job', (await listIds(T2.r3)).includes(j3.id) && (await listIds(T.r)).includes(j3.id) && (await listIds(T2.r2)).includes(j3.id));
    const undo = await call('POST', '/api/requirements/bulk/undo', T.admin, { undoId: rb.body.undoId });
    const j3u = await prisma.requirement.findUnique({ where: { id: j3.id } });
    check('undo puts the recruiters back', undo.status === 200 && !j3u.recruiterId && !(j3u.recruiterIds || '') && !(await listIds(T2.r3)).includes(j3.id), undo.body);
    const old = await call('POST', '/api/requirements/bulk', T.admin, { action: 'assign-recruiter', ids: [j3.id], userId: uR.id });
    check('the old single-id call still works', old.status === 200 && old.body.done === 1, old.body);

    // ---- CSV -------------------------------------------------------------------------------------------
    await call('POST', `/api/requirements/${j1.id}/assign`, T.admin, { tlIds: [uA.id, uB.id, uC.id] });
    const csv = await call('GET', '/api/ats-io/export/requirements?format=csv', T.admin);
    const line = (csv.text || '').split(/\r?\n/).find((l) => l.includes(`ZZTEST RT Job one ${RUN}`)) || '';
    check('CSV export joins every TL name', csv.status === 200 && [uA, uB, uC].every((u) => line.includes(`RT Probe ${u.id.slice(-5)}`)), line.slice(0, 300) || csv.status);
  } catch (e) {
    fail += 1; console.log('FAIL  test crashed', e && e.stack);
  } finally {
    // ---- clean every ZZTEST RT row ----
    try {
      const ids = made.users;
      await prisma.appSetting.deleteMany({ where: { OR: made.reqs.flatMap((id) => [{ key: `reqTls.${id}` }, { key: `reqDepts.${id}` }]) } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...made.reqs, ...made.apps] } }] } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { message: { contains: 'ZZTEST RT' } }] } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: made.apps } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch(() => {});
      await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: made.reqs } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    } catch (e) { console.log('cleanup problem', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
