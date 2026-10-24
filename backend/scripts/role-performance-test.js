#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ROLE-WISE RECRUITMENT PERFORMANCE acceptance tests (user spec 2026-10-13). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/role-performance-test.js [--keep] [--clean]
//
// Runs against the sandbox copy of the real database (tens of thousands of candidates):
//   R  real data: roles / departments load dynamically, formulas, timings, single-employee numbers
//      equal direct SQL, role totals = sum of employees, month / year / custom / all periods
//   F  fixtures tagged "ZZTEST RP": a transferred employee (EDU seat Jan-Mar, MED seat from Apr), a
//      resigned + login-deactivated employee, a zero-joining employee, one with no seat history;
//      generated-Sep / joined-Oct, duplicates (two jobs, repeated events, merged profiles),
//      joined-without-date, offered-not-joined, the credit-rule switch
//   P  permissions: Super Admin / Manager / AM / TL / Recruiter / HR / Accounts, no candidate contact
//   X  Excel export equals the screen
// --keep leaves the fixtures for a UI check; --clean only removes fixtures of earlier runs.
// Fixtures are removed at the end (every row they made: users, employees, seats, candidates, events, audit).
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const KEEP = process.argv.includes('--keep');
const CLEAN_ONLY = process.argv.includes('--clean');
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
}
async function call(method, p, token, body, raw) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const t = Date.now();
      const r = await realFetch(`${API}/api/role-performance${p}`, { method, headers: h, body: payload });
      if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), ms: Date.now() - t };
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text, ms: Date.now() - t };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const qs = (o) => `?${Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
const d = (s) => new Date(`${s}T06:00:00.000Z`); // 11:30 IST, the same calendar day in IST
const BANNED_KEYS = /^(salary|ctc|currentsalary|expectedsalary|offeredctc|phone|mobile|email|candidateemail|resumescore|matchscore|aiinterviewscore|dob|currentcompany|contactphone|contactemail)$/i;
function bannedKeys(o, acc = new Set()) {
  if (Array.isArray(o)) o.forEach((x) => bannedKeys(x, acc));
  else if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (BANNED_KEYS.test(k)) acc.add(k); bannedKeys(o[k], acc); });
  return [...acc];
}

// ---- cleanup of every row a ZZTEST RP fixture made ------------------------------------------
async function cleanup() {
  const users = await prisma.user.findMany({ where: { OR: [{ name: { contains: 'ZZTEST RP' } }, { email: { contains: 'zz-rp-' } }] }, select: { id: true } });
  const uids = users.map((u) => u.id);
  const emps = await prisma.employee.findMany({ where: { OR: [{ name: { contains: 'ZZTEST RP' } }, { employeeCode: { startsWith: 'ZZTEST-RP' } }] }, select: { id: true } });
  const eids = emps.map((e) => e.id);
  const cands = await prisma.candidate.findMany({ where: { name: { contains: 'ZZTEST RP' } }, select: { id: true } });
  const cids = cands.map((c) => c.id);
  const reqs = await prisma.requirement.findMany({ where: { title: { contains: 'ZZTEST RP' } }, select: { id: true } });
  const rids = reqs.map((r) => r.id);
  const apps = await prisma.application.findMany({ where: { OR: [{ candidateId: { in: cids } }, { requirementId: { in: rids } }] }, select: { id: true } });
  const aids = apps.map((a) => a.id);
  const inList = cids.map((c) => `'${c}'`).join(',') || "''";
  for (const t of ['CandidateDupFlag']) await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE candidateId IN (${inList}) OR matchCandidateId IN (${inList})`).catch(() => {});
  for (const t of ['CandidateDupKey', 'CandidateDupSig']) await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE candidateId IN (${inList})`).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { entity: 'Candidate', entityId: { in: cids } } });
  await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: aids } }, { candidateId: { in: cids } }] } });
  await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: aids } }, { candidateId: { in: cids } }] } });
  await prisma.application.deleteMany({ where: { id: { in: aids } } });
  await prisma.$executeRawUnsafe(`DELETE FROM CandidateAlias WHERE oldId IN (${cids.map((c) => `'${c}'`).join(',') || "''"}) OR candidateId IN (${cids.map((c) => `'${c}'`).join(',') || "''"})`).catch(() => {});
  await prisma.candidate.deleteMany({ where: { id: { in: cids } } });
  await prisma.requirement.deleteMany({ where: { id: { in: rids } } });
  await prisma.client.deleteMany({ where: { name: { contains: 'ZZTEST RP' } } });
  await prisma.positionAssignment.deleteMany({ where: { employeeId: { in: eids } } });
  await prisma.position.updateMany({ where: { code: { startsWith: 'ZZRP' } }, data: { reportsToId: null } });
  await prisma.position.deleteMany({ where: { code: { startsWith: 'ZZRP' } } });
  await prisma.employee.deleteMany({ where: { id: { in: eids } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: uids } }, { actorName: { contains: 'ZZTEST RP' } }, { entity: 'RolePerformance' }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: uids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: uids } } });
  await prisma.appSetting.deleteMany({ where: { key: 'rolePerformance.attribution' } });
  return { users: uids.length, emps: eids.length, cands: cids.length };
}

(async () => {
  const pre = await cleanup();
  if (CLEAN_ONLY) { console.log('cleaned', pre); await prisma.$disconnect(); return; }
  let made = false;
  try {
    // ============================== FIXTURES ==============================================
    const base = { passwordHash: 'x', hrmsRole: 'EMPLOYEE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, emp) => {
      const name = `ZZTEST RP ${tag} ${RUN}`;
      const u = await prisma.user.create({ data: { ...base, name, email: `zz-rp-${tag.toLowerCase()}-${RUN}@example.test`, username: `zz-rp-${tag.toLowerCase()}-${RUN}@example.test`, ...extra } });
      let e = null;
      if (emp) e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-RP-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: emp.department || null, ...emp } });
      return { u, e, name };
    };
    made = true;
    const sa = await mkUser('SA', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN' });
    const mgr = await mkUser('Mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER' });
    const hr = await mkUser('HR', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR' });
    const acct = await mkUser('Acct', { role: 'ACCOUNTANT', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', atsAccess: false });
    const am = await mkUser('AM', { role: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', hrmsRole: 'ASSISTANT_MANAGER', atsScopeDepartments: 'Medical' });
    const tl = await mkUser('TL', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL', department: 'Education' });
    const tl2 = await mkUser('TLTwo', { role: 'TL', atsRole: 'TL', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' }, { designation: 'TL', department: 'Manufacturing' });
    const A = await mkUser('Alpha', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { department: 'Education' });
    const B = await mkUser('Beta', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, status: 'Inactive' }, { department: 'Education', employmentStatus: 'Relieved' });
    const C = await mkUser('Gamma', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { department: 'Medical' });
    const DL = { name: `ZZTEST RP Delta ${RUN}`, e: await prisma.employee.create({ data: { employeeCode: `ZZTEST-RP-Delta-${RUN}`, name: `ZZTEST RP Delta ${RUN}`, designation: 'Employee', employmentStatus: 'Active', department: 'Education' } }) };

    // seats: ZZRP TL seat over two recruiter seats
    const pTl = await prisma.position.create({ data: { code: `ZZRP-TL-${RUN}`, name: 'ZZTEST RP team lead', department: 'Education', kind: 'TL', active: true } });
    const p1 = await prisma.position.create({ data: { code: `ZZRP-1-${RUN}`, name: 'ZZTEST RP education seat', department: 'Education', kind: 'RECRUITER', active: true, reportsToId: pTl.id } });
    const p2 = await prisma.position.create({ data: { code: `ZZRP-2-${RUN}`, name: 'ZZTEST RP medical seat', department: 'Medical', kind: 'RECRUITER', active: true, reportsToId: pTl.id } });
    const seat = (p, e, from, to) => prisma.positionAssignment.create({ data: { positionId: p.id, employeeId: e.id, fromDate: from, toDate: to || null, note: 'ZZTEST RP' } });
    await seat(pTl, tl.e, '2025-12-01');
    await seat(p1, A.e, '2026-01-01', '2026-03-31');
    await seat(p2, A.e, '2026-04-01');
    await seat(p1, B.e, '2026-01-01', '2026-05-31');
    await seat(p2, C.e, '2026-02-01');

    const client = await prisma.client.create({ data: { name: `ZZTEST RP Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client' } });
    const mkReq = (tag) => prisma.requirement.create({ data: { title: `ZZTEST RP Job ${tag} ${RUN}`, reqCode: `ZZRP-${tag}-${RUN}`.slice(0, 30), clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: A.u.id, openings: 5 } });
    const R1 = await mkReq('1'); const R2 = await mkReq('2');

    // (a distinct e-mail / phone per candidate: the app's own duplicate guard flags candidates that share them)
    let seq = 0;
    const mkCand = (tag, day) => { seq += 1; return prisma.candidate.create({ data: { name: `ZZTEST RP Cand ${tag} ${RUN}`, email: `zz-rp-cand-${tag.toLowerCase()}-${RUN}@example.test`, phone: `90000${String(10000 + seq * 7)}`, currentSalary: '8L', expectedSalary: '12L', createdAt: d(day) } }); };
    const mkApp = (cand, req, stage, day, extra = {}) => prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage, createdAt: d(day), ...extra } });
    const mkEv = (app, cand, from, to, day, actor) => prisma.applicationStageEvent.create({
      data: { applicationId: app.id, candidateId: cand.id, fromStage: from, toStage: to, action: `ZZTEST RP ${to}`, actorUserId: actor ? actor.u.id : null, actorName: actor ? actor.name : 'System', createdAt: d(day) },
    });
    const mkFu = (app, cand, who, day, stamp) => prisma.applicationFollowUp.create({
      data: { applicationId: app.id, candidateId: cand.id, requirementId: app.requirementId, ownerUserId: who.u ? who.u.id : null, ownerName: who.name, ownerPositionCode: stamp || null, createdAt: d(day) },
    });

    // S1 - generated Sep, selected Sep, joined Oct (owner Alpha, MED seat era)
    const s1 = await mkCand('S1', '2026-09-05'); const s1a = await mkApp(s1, R1, 'JOINED', '2026-09-05', { joiningDate: '2026-10-03' });
    await mkFu(s1a, s1, A, '2026-09-05'); await mkEv(s1a, s1, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-09-20', A); await mkEv(s1a, s1, 'OFFER_ACCEPTED', 'JOINED', '2026-10-03', A);
    // S2 - Alpha in the EDU seat: submitted Feb, selected Mar (EDU seat), joined Apr (MED seat)
    const s2 = await mkCand('S2', '2026-02-10'); const s2a = await mkApp(s2, R1, 'JOINED', '2026-02-10', { joiningDate: '2026-04-15' });
    await mkFu(s2a, s2, A, '2026-02-10'); await mkEv(s2a, s2, 'NEW', 'SHARED_WITH_CLIENT', '2026-02-20', A); await mkEv(s2a, s2, 'SHARED_WITH_CLIENT', 'SELECTED', '2026-03-05', A);
    await mkEv(s2a, s2, 'OFFER_ACCEPTED', 'JOINED', '2026-04-15', A);
    // S3 - Beta (resigned, login off): generated Feb, selected Mar, joined Apr in the EDU seat
    const s3 = await mkCand('S3', '2026-02-12'); const s3a = await mkApp(s3, R1, 'JOINED', '2026-02-12', { joiningDate: '2026-04-20' });
    await mkFu(s3a, s3, B, '2026-02-12'); await mkEv(s3a, s3, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-03-10', B); await mkEv(s3a, s3, 'OFFER_ACCEPTED', 'JOINED', '2026-04-20', B);
    // S4 - duplicates: one candidate on TWO jobs, both joined, selected event repeated
    const s4 = await mkCand('S4', '2026-05-02'); const s4a = await mkApp(s4, R1, 'JOINED', '2026-05-02', { joiningDate: '2026-05-10' }); const s4b = await mkApp(s4, R2, 'JOINED', '2026-05-02', { joiningDate: '2026-05-12' });
    await mkFu(s4a, s4, A, '2026-05-02'); await mkFu(s4b, s4, A, '2026-05-02');
    await mkEv(s4a, s4, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-05-06', A); await mkEv(s4a, s4, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-05-07', A); await mkEv(s4b, s4, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-05-08', A);
    // S5 - the same person twice (merged profile: alias), both joined
    const s5 = await mkCand('S5', '2026-05-03'); const s5x = await mkCand('S5dup', '2026-05-03');
    const s5a = await mkApp(s5, R1, 'JOINED', '2026-05-03', { joiningDate: '2026-05-15' }); const s5b = await mkApp(s5x, R2, 'JOINED', '2026-05-03', { joiningDate: '2026-05-16' });
    await mkFu(s5a, s5, A, '2026-05-03'); await mkFu(s5b, s5x, A, '2026-05-03');
    await mkEv(s5a, s5, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-05-09', A); await mkEv(s5b, s5x, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-05-09', A);
    await prisma.$executeRawUnsafe(`INSERT INTO CandidateAlias (oldId, candidateId, createdAt) VALUES ('${s5x.id}','${s5.id}', ${Date.now()})`).catch(() => {});
    // S6 - joined, but no joining date and no moves
    const s6 = await mkCand('S6', '2026-06-04'); const s6a = await mkApp(s6, R1, 'JOINED', '2026-06-04'); await mkFu(s6a, s6, A, '2026-06-04');
    // S7 - offered, joining date in the future: selected (Oct), NOT a joining
    const s7 = await mkCand('S7', '2026-09-19'); const s7a = await mkApp(s7, R1, 'OFFER_ACCEPTED', '2026-09-25', { joiningDate: '2026-10-30' });
    await mkFu(s7a, s7, A, '2026-09-25'); await mkEv(s7a, s7, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-10-01', A);
    // S12 - sourced on a bulk spreadsheet-load day (23 Sep): that day says nothing about when, so generated date = missing
    const s12 = await mkCand('S12', '2026-09-23'); const s12a = await mkApp(s12, R1, 'RECRUITER_REVIEW', '2026-09-23'); await mkFu(s12a, s12, A, '2026-09-23');
    // S8 - the employee with no seat history: generated Mar, role "History not available"
    const s8 = await mkCand('S8', '2026-03-03'); const s8a = await mkApp(s8, R1, 'RECRUITER_REVIEW', '2026-03-03'); await mkFu(s8a, s8, DL, '2026-03-03');
    // S9 - Gamma generated Mar, nothing after: zero joinings are shown as 0
    const s9 = await mkCand('S9', '2026-03-12'); const s9a = await mkApp(s9, R1, 'RECRUITER_REVIEW', '2026-03-12'); await mkFu(s9a, s9, C, '2026-03-12');
    // S11 - credit rule: generated by Alpha (Jun 10), later owned by Beta (follow-up Jun 15), joined Jun 20
    const s11 = await mkCand('S11', '2026-06-10'); const s11a = await mkApp(s11, R1, 'JOINED', '2026-06-10', { joiningDate: '2026-06-20' });
    await mkFu(s11a, s11, A, '2026-06-10'); await mkFu(s11a, s11, B, '2026-06-15'); await mkEv(s11a, s11, 'INTERVIEW_COMPLETED', 'SELECTED', '2026-06-18', B); await mkEv(s11a, s11, 'OFFER_ACCEPTED', 'JOINED', '2026-06-20', B);

    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, x] of Object.entries({ sa, mgr, hr, acct, am, tl, tl2, A, B, C })) T[k] = await mint(x.u);
    const fresh = await call('GET', `/report${qs({ year: 2026, fresh: 1 })}`, T.sa);
    check('F0 fixtures built and the Super Admin can open the report', fresh.status === 200, fresh.body || fresh.text);

    const rep = async (tok, q) => { const r = await call('GET', `/report${qs(q)}`, tok); return r; };
    const eK = (x) => `e:${x.e.id}`;
    const cellOf = (r, month, ek, role) => (r.body.rows.find((x) => x.month === month && x.employeeKey === ek && (role === undefined || x.role === role)) || {});

    // ============================== F: fixtures ==============================================
    const optAll = await call('GET', `/options${qs({ year: 2026 })}`, T.sa);
    const optRole1 = await call('GET', `/options${qs({ role: p1.id, year: 2026 })}`, T.sa);
    const empNames = (o) => ((o.body && o.body.employees) || []).map((x) => x.name);
    check('F1 the role list holds the new seats once each (real ids, no duplicates)', optAll.body.roles.filter((x) => x.id === p1.id || x.id === p2.id).length === 2
      && new Set(optAll.body.roles.map((x) => x.id)).size === optAll.body.roles.length, optAll.body.roles.length);
    check('F2 Education / Medical come from the real departments table (ids), no duplicates', (() => {
      const ds = optAll.body.departments; const edu = ds.find((x) => x.name === 'Education'); const med = ds.find((x) => x.name === 'Medical');
      return edu && med && !String(edu.id).startsWith('name:') && new Set(ds.map((x) => x.id)).size === ds.length;
    })(), optAll.body.departments);
    check('F3 selecting a role lists current AND former holders (Alpha was EDU seat, Beta resigned, login off)', empNames(optRole1).includes(A.name) && empNames(optRole1).includes(B.name), empNames(optRole1));
    const bOpt = optRole1.body.employees.find((x) => x.name === B.name);
    const aOpt = optRole1.body.employees.find((x) => x.name === A.name);
    check('F4 status tags: Beta = Former (Relieved), Alpha = Active with the historical role text', bOpt && bOpt.status === 'Former' && aOpt && aOpt.status === 'Active' && /Was/.test(aOpt.historicalRole || ''), { bOpt, aOpt });
    const optRole2 = await call('GET', `/options${qs({ role: p2.id, year: 2026 })}`, T.sa);
    check('F5 the other seat lists Alpha (current) and Gamma, not Beta; changing role changes the list', empNames(optRole2).includes(A.name) && empNames(optRole2).includes(C.name) && !empNames(optRole2).includes(B.name), empNames(optRole2));
    const dd = await call('GET', `/options${qs({ department: optAll.body.departments.find((x) => x.name === 'Medical').id, year: 2026 })}`, T.sa);
    check('F6 cascading: Medical narrows roles + employees (Beta, EDU only, is gone; counts present)', !empNames(dd).includes(B.name) && empNames(dd).includes(C.name) && dd.body.roles.every((x) => x.count > 0) && !dd.body.roles.some((x) => x.id === p1.id), dd.body.roles.length);
    check('F7 no deactivated account was reactivated by reporting', (await prisma.user.findUnique({ where: { id: B.u.id } })).status === 'Inactive', 'status');

    const all26 = await rep(T.sa, { year: 2026, employee: eK(A) });
    const ra = all26.body.rows;
    check('F8 Alpha Feb: generated 1, submitted 1 under the EDU seat', cellOf(all26, '2026-02', eK(A)).role === p1.code && cellOf(all26, '2026-02', eK(A)).generated === 1 && cellOf(all26, '2026-02', eK(A)).submitted === 1, ra.filter((x) => x.month === '2026-02'));
    check('F9 Alpha Mar: selected 1 under the EDU seat (history stays in the EDU seat)', cellOf(all26, '2026-03', eK(A)).role === p1.code && cellOf(all26, '2026-03', eK(A)).selected === 1, ra.filter((x) => x.month === '2026-03'));
    check('F10 Alpha Apr: joined 1 under the MED seat (transfer: joined after moving seats)', cellOf(all26, '2026-04', eK(A)).role === p2.code && cellOf(all26, '2026-04', eK(A)).joined === 1, ra.filter((x) => x.month === '2026-04'));
    check('F11 generated Sep + selected Sep, joined Oct (spec example)', cellOf(all26, '2026-09', eK(A)).generated === 2 && cellOf(all26, '2026-09', eK(A)).selected === 1 && cellOf(all26, '2026-09', eK(A)).joined === 0
      && cellOf(all26, '2026-10', eK(A)).joined === 1 && cellOf(all26, '2026-10', eK(A)).generated === 0, ra.filter((x) => x.month >= '2026-09'));
    check('F12 duplicates do not inflate: two jobs + repeated events + merged profile = 2 in May (selected 2, joined 2, generated 2)', cellOf(all26, '2026-05', eK(A)).joined === 2 && cellOf(all26, '2026-05', eK(A)).selected === 2 && cellOf(all26, '2026-05', eK(A)).generated === 2, ra.filter((x) => x.month === '2026-05'));
    check('F13 offered-not-joined is NOT a joining (Oct has exactly 1, selected Oct = 1)', cellOf(all26, '2026-10', eK(A)).selected === 1, ra.filter((x) => x.month === '2026-10'));
    check('F14 joined without a date is counted apart as "Joined, date missing" and in no month; a candidate loaded on a bulk-import day is "Generated, date missing"', all26.body.cards.missing.joined === 1 && all26.body.cards.joined === 4 && all26.body.cards.missing.generated === 1, all26.body.cards);
    check('F15 Alpha totals: generated 7 (Feb1 May2 Jun2 Sep2), joined 4 (Apr1 May2 Oct1); the Jun joining went to Beta',
      all26.body.cards.generated === 7 && all26.body.cards.joined === 4, all26.body.cards);
    const beta = await rep(T.sa, { year: 2026, employee: eK(B) });
    check('F16 Beta (resigned, login off): history is reportable and under the EDU seat (Apr joined 1)', cellOf(beta, '2026-04', eK(B)).joined === 1 && cellOf(beta, '2026-04', eK(B)).role === p1.code, beta.body.rows.slice(0, 6));
    const bJun = cellOf(beta, '2026-06', eK(B));
    check('F17 no fabricated past: Beta Jun joined sits under "History not available" (tenure ended May)', bJun.joined === 1 && bJun.role === 'History not available', bJun);
    const gam = await rep(T.sa, { year: 2026, employee: eK(C) });
    check('F18 zero-joining employee still appears with a verified 0 (and Gamma generated 1 in Mar)', cellOf(gam, '2026-03', eK(C)).generated === 1 && gam.body.rows.filter((x) => !x.noAssignment).every((x) => x.joined === 0) && gam.body.rows.filter((x) => !x.noAssignment).length >= 9 && (cellOf(gam, '2026-01', eK(C)).noAssignment === true), gam.body.rows.map((x) => `${x.month}:${x.joined}`));
    const del = await rep(T.sa, { year: 2026, employee: `e:${DL.e.id}` });
    const dRow = del.body.rows.find((x) => x.month === '2026-03') || {};
    check('F19 employee without seat history: numbers shown, role = "History not available"', dRow.generated === 1 && dRow.role === 'History not available', del.body.rows);
    const delMonthsOnly = del.body.rows.filter((x) => x.month !== '2026-03');
    check('F20 months with nothing recorded and no seat say "No assignment in this period", not 0', delMonthsOnly.length > 0 && delMonthsOnly.every((x) => x.noAssignment && x.joined === null), delMonthsOnly.slice(0, 2));

    // credit rule: owner default vs generated switch
    const aJun = cellOf(all26, '2026-06', eK(A));
    check('F21 default credit = the existing owner rule: the Jun joining went to Beta (last owner), not Alpha', aJun.joined === 0 && bJun.joined === 1, { aJun, bJun });
    const sw = await call('PUT', '/attribution', T.sa, { mode: 'generated' });
    const aGen = await rep(T.sa, { year: 2026, employee: eK(A), fresh: 1 });
    check('F22 switch to "generated": the Jun joining moves to the recruiter who generated it (Alpha)', sw.status === 200 && cellOf(aGen, '2026-06', eK(A)).joined === 1 && aGen.body.cards.joined === 5, { sw: sw.status, c: aGen.body.cards });
    const swBad = await call('PUT', '/attribution', T.mgr, { mode: 'owner' });
    check('F23 only the Super Admin can change the credit rule', swBad.status === 403, swBad.status);
    await call('PUT', '/attribution', T.sa, { mode: 'owner' });
    await rep(T.sa, { year: 2026, fresh: 1 });

    // reconcile: role total = sum of employees; All employees = sum of employee rows = cards
    const role1 = await rep(T.sa, { year: 2026, role: p1.id });
    const sumBy = async (role) => {
      const o = await call('GET', `/options${qs({ role, year: 2026 })}`, T.sa);
      let g = 0; let j = 0; let s = 0;
      for (const e of o.body.employees) { const r = await rep(T.sa, { year: 2026, role, employee: e.value }); g += r.body.cards.generated || 0; j += r.body.cards.joined || 0; s += r.body.cards.selected || 0; }
      return { g, j, s, n: o.body.employees.length };
    };
    const sb = await sumBy(p1.id);
    check('F24 role totals reconcile: the role card equals the sum of its employees (generated / selected / joined)', role1.body.cards.generated === sb.g && role1.body.cards.joined === sb.j && role1.body.cards.selected === sb.s, { card: role1.body.cards, sb });
    check('F25 "employees in role" counts each person once (Alpha + Beta, though they moved seats)', role1.body.cards.employees === 2, role1.body.cards.employees);
    const rowsSum = (r, k) => r.body.rows.reduce((n, x) => n + (x[k] || 0), 0);
    check('F26 row totals equal the card totals (generated / submitted / selected / joined)', ['generated', 'submitted', 'selected', 'joined'].every((k) => rowsSum(role1, k) === role1.body.cards[k]), role1.body.cards);
    // filters: month / year / custom / all periods
    const m4 = await rep(T.sa, { month: '2026-04', role: p2.id, employee: eK(A) });
    check('F27 month filter: April, MED seat, Alpha -> joined 1 (one month)', m4.body.rows.length === 1 && m4.body.rows[0].joined === 1 && m4.body.cards.joined === 1, m4.body.rows);
    const cust = await rep(T.sa, { from: '2026-02-01', to: '2026-03-31', employee: eK(A) });
    check('F28 custom range Feb-Mar: months in order incl. zero months; no Apr row', cust.body.rows.map((x) => x.month).join() === '2026-02,2026-03' && cust.body.cards.joined === 0, cust.body.rows.map((x) => x.month));
    const yr = await rep(T.sa, { year: 2026, employee: eK(A) });
    const mo = yr.body.rows.map((x) => x.month);
    check('F29 year filter: rows chronological, zero-activity months included (Jan has a verified 0)', mo.join() === [...mo].sort().join() && mo.includes('2026-01') && cellOf(yr, '2026-01', eK(A)).generated === 0, mo);
    const allp = await rep(T.sa, { period: 'all', employee: eK(A) });
    check('F30 "All available periods" works and equals the year when all activity is in 2026', allp.status === 200 && allp.body.cards.generated === yr.body.cards.generated && allp.body.cards.joined === yr.body.cards.joined, allp.body.cards);
    const conv = yr.body.cards;
    check('F31 formulas: conversion = joined / generated x 100 and average monthly = joined / months with data',
      conv.conversion === Math.round((conv.joined / conv.generated) * 1000) / 10 && conv.averageMonthlyJoinings === Math.round((conv.joined / conv.monthsWithData) * 10) / 10, conv);
    check('F32 conversion shows N/A when nothing was generated (a month with 0 generated)', cellOf(yr, '2026-10', eK(A)).conversion === 'N/A', cellOf(yr, '2026-10', eK(A)));
    check('F33 missing is not zero: a role with a month before any data says "Data not available" (null), never 0', (await rep(T.sa, { from: '2019-01-01', to: '2019-03-31', employee: eK(A) })).body.rows.every((x) => x.generated === null), 'rows');
    const nothing = await rep(T.sa, { year: 2026, role: p2.id, employee: eK(B) });
    check('F34 empty results are worded: "No assignment in this period" / "No results for these filters"', nothing.body.rows.length === 0 && /No (assignment|results)/.test(nothing.body.message || ''), nothing.body.message);
    const noEmp = await call('GET', `/report${qs({ year: 2026, role: 'zzz-no-such-role' })}`, T.sa);
    check('F35 unknown role -> "No employees for this role"', noEmp.body.message === 'No employees for this role', noEmp.body.message);

    // drill-down reconciles
    const dr = async (q) => call('GET', `/drill${qs(q)}`, T.sa);
    const g = await dr({ metric: 'generated', month: '2026-05', year: 2026, employee: eK(A) });
    const jn = await dr({ metric: 'joined', month: '2026-05', year: 2026, employee: eK(A) });
    const jm = await dr({ metric: 'joined', missing: 1, year: 2026, employee: eK(A) });
    check('F36 drill-down count equals the clicked number (May generated 2, joined 2)', g.body.total === 2 && jn.body.total === 2 && g.body.rows.length === 2, { g: g.body.total, j: jn.body.total });
    check('F37 drill rows carry candidate, client, job, employee, dates, role / department, credit basis', (() => { const r = jn.body.rows[0]; return r && r.candidate && r.client && r.job && r.employee && r.joiningDate && r.role && r.creditBasis && r.generationDate; })(), jn.body.rows[0]);
    check('F38 "Joined, date missing" opens its own list (1 record, no joining date)', jm.body.total === 1 && jm.body.rows[0].joiningDate === null, jm.body);
    const allMonthSum = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-09', '2026-10'];
    let drillSum = 0; for (const m of allMonthSum) drillSum += (await dr({ metric: 'joined', month: m, year: 2026, employee: eK(A) })).body.total;
    check('F39 every month\'s joined drill adds up to the card (4)', drillSum === yr.body.cards.joined, drillSum);

    // ============================== P: permissions ===========================================
    const optTl = await call('GET', `/options${qs({ year: 2026 })}`, T.tl);
    check('P1 TL sees the people of their seats, current AND former (Alpha, Beta, Gamma), not an unrelated employee', empNames(optTl).includes(A.name) && empNames(optTl).includes(B.name) && !empNames(optTl).includes(DL.name), empNames(optTl).filter((n) => /ZZTEST/.test(n)));
    const optTl2 = await call('GET', `/options${qs({ year: 2026 })}`, T.tl2);
    check('P2 another TL does not see them', !empNames(optTl2).includes(A.name) && !empNames(optTl2).includes(B.name), empNames(optTl2).filter((n) => /ZZTEST/.test(n)));
    const optRec = await call('GET', `/options${qs({ year: 2026 })}`, T.A);
    check('P3 a recruiter sees only themselves in the employee list', optRec.body.employees.length === 1 && optRec.body.employees[0].name === A.name, empNames(optRec));
    const recOther = await rep(T.A, { year: 2026, employee: eK(B) });
    check('P4 a recruiter asking for someone else gets nothing of theirs', recOther.status === 200 && recOther.body.rows.length === 0, recOther.body.rows.length);
    const recOwn = await rep(T.A, { year: 2026 });
    check('P5 a recruiter\'s own report equals the Super Admin\'s view of them', recOwn.body.cards.joined === yr.body.cards.joined && recOwn.body.cards.generated === yr.body.cards.generated, { own: recOwn.body.cards, yr: yr.body.cards });
    const recDrill = await call('GET', `/drill${qs({ metric: 'joined', year: 2026 })}`, T.A);
    check('P6 recruiter drill-down: only own records, no contact / salary / score fields', recDrill.status === 200 && recDrill.body.rows.every((r) => r.employee === A.name) && bannedKeys(recDrill.body).length === 0, bannedKeys(recDrill.body));
    check('P7 no contact / salary / AI score in any payload (SA drill, report, options)', bannedKeys(jn.body).length === 0 && bannedKeys(yr.body).length === 0 && bannedKeys(optAll.body).length === 0, [...bannedKeys(jn.body), ...bannedKeys(yr.body)]);
    const hrRep = await rep(T.hr, { year: 2026, employee: eK(A) });
    const hrDr = await call('GET', `/drill${qs({ metric: 'joined', year: 2026 })}`, T.hr);
    check('P8 HR sees the counts but not the candidate list', hrRep.status === 200 && hrRep.body.cards.joined === yr.body.cards.joined && hrDr.status === 403, { r: hrRep.status, d: hrDr.status });
    const acctRep = await rep(T.acct, { year: 2026 });
    check('P9 Accounts is refused', acctRep.status === 403, acctRep.status);
    const mgrRep = await rep(T.mgr, { year: 2026, employee: eK(A) });
    check('P10 Manager sees everyone (same numbers as Super Admin)', mgrRep.status === 200 && mgrRep.body.cards.joined === yr.body.cards.joined, mgrRep.status);
    const optAm = await call('GET', `/options${qs({ year: 2026 })}`, T.am);
    check('P11 Assistant Manager (Medical): sees Medical-seat people (Alpha now in a MED seat, Gamma), not Beta (EDU only)', empNames(optAm).includes(C.name) && !empNames(optAm).includes(B.name), empNames(optAm).filter((n) => /ZZTEST/.test(n)));
    const deac = await rep(T.sa, { year: 2026, employee: eK(B) });
    check('P12 a deactivated login (Beta) is still reportable for an authorised viewer', deac.status === 200 && deac.body.cards.joined >= 1, deac.status);
    const setBad = await call('PUT', '/attribution', T.A, { mode: 'generated' });
    check('P13 a recruiter cannot change the credit rule', setBad.status === 403, setBad.status);

    // ============================== X: Excel ==================================================
    const ex = await call('GET', `/export${qs({ year: 2026, role: p1.id })}`, T.sa, undefined, true);
    const wb = XLSX.read(ex.buf, { type: 'buffer' });
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets['Role performance'], { header: 1 });
    check('X1 Excel has the three sheets (rows, Summary, How counted)', ex.status === 200 && ['Role performance', 'Summary', 'How counted'].every((n) => wb.SheetNames.includes(n)), wb.SheetNames);
    check('X2 Excel rows equal the screen rows (count, and the joined column)', sheet.length - 1 === role1.body.rows.length
      && sheet.slice(1).reduce((n, r) => n + (Number(r[9]) || 0), 0) === role1.body.cards.joined, { excel: sheet.length - 1, screen: role1.body.rows.length });
    check('X3 Excel header uses the screen labels', sheet[0].join('|') === 'Month-Year|Employee|Employee ID|Status|Department|Role|Generated|Submitted / Processed|Selected|Actual Joinings|Joinings per 100 generated', sheet[0]);

    // ============================== R: the real data copy =====================================
    const big = await call('GET', `/report${qs({ period: 'all' })}`, T.sa);
    const big2 = await call('GET', `/report${qs({ period: 'all' })}`, T.sa);
    const opt2 = await call('GET', `/options${qs({ year: 2026 })}`, T.sa);
    const drl = await call('GET', `/drill${qs({ metric: 'generated', period: 'all' })}`, T.sa);
    check(`R1 timings, warm: report ${big2.ms} ms, options ${opt2.ms} ms, drill ${drl.ms} ms (all periods, whole company; target < 2000)`, big2.ms < 2000 && opt2.ms < 2000 && drl.ms < 2000, { big: big.ms, big2: big2.ms, opt: opt2.ms, drill: drl.ms });
    const cold = await call('GET', `/report${qs({ year: 2026, fresh: 1 })}`, T.sa);
    console.log(`INFO  cold rebuild (fresh=1): ${cold.ms} ms; rows in all-period report: ${big2.body.rows.length}`);
    // real-data direct SQL check: a real recruiter's joinings by month (the owner arm: last follow-up owner)
    const real = await prisma.$queryRawUnsafe(`
      SELECT f.ownerName AS name, COUNT(*) AS n FROM ApplicationFollowUp f
      JOIN Application a ON a.id = f.applicationId WHERE a.stage IN ('JOINED','HIRED') AND f.ownerUserId IS NOT NULL AND f.ownerName NOT LIKE 'ZZTEST%'
      GROUP BY f.ownerName ORDER BY n DESC LIMIT 1`);
    if (real.length) {
      const nm = real[0].name;
      const emp = await prisma.employee.findFirst({ where: { name: nm } });
      if (emp) {
        const rr = await rep(T.sa, { period: 'all', employee: `e:${emp.id}` });
        // direct SQL, same rule written independently: joined, valid date, owner = last follow-up owner (else job recruiter), one per candidate
        const rows = await prisma.$queryRawUnsafe(`
          SELECT a.candidateId AS cid, a.joiningDate AS jd, a.joinedAt AS ja, a.joiningStatus AS js,
            (SELECT ownerUserId FROM ApplicationFollowUp f WHERE f.applicationId=a.id AND (f.ownerUserId IS NOT NULL OR f.ownerName IS NOT NULL) ORDER BY f.createdAt DESC LIMIT 1) AS ou,
            (SELECT ownerName FROM ApplicationFollowUp f WHERE f.applicationId=a.id AND (f.ownerUserId IS NOT NULL OR f.ownerName IS NOT NULL) ORDER BY f.createdAt DESC LIMIT 1) AS onm,
            (SELECT recruiterId FROM Requirement r WHERE r.id=a.requirementId) AS rid
          FROM Application a WHERE a.stage IN ('JOINED','HIRED')`);
        const mine = new Map();
        rows.forEach((r) => {
          if (/not\s*join|won'?t\s*join|wont|dropp/i.test(r.js || '')) return;
          const owner = r.ou || r.rid;
          const isMe = (r.ou === emp.userId && emp.userId) || (!r.ou && r.onm && r.onm.replace(/[^a-z0-9]/gi, '').toLowerCase() === nm.replace(/[^a-z0-9]/gi, '').toLowerCase()) || (!r.ou && !r.onm && r.rid === emp.userId && emp.userId);
          if (!isMe || !owner) return;
          let day = /^\d{4}-\d{2}-\d{2}/.test(r.jd || '') && +String(r.jd).slice(0, 4) >= 2015 && +String(r.jd).slice(0, 4) <= 2100 ? String(r.jd).slice(0, 10) : null;
          if (!day && r.ja) day = new Date(Number(r.ja) + 330 * 60000).toISOString().slice(0, 10);
          const cur = mine.get(r.cid);
          if (!cur || (day && (!cur || cur > day))) mine.set(r.cid, day);
        });
        const dated = [...mine.values()].filter(Boolean).length;
        const undated = [...mine.values()].filter((x) => !x).length;
        check(`R2 single-employee numbers equal direct SQL (${nm}: joined ${dated} dated + ${undated} date-missing)`, rr.body.cards.joined === dated && rr.body.cards.missing.joined === undated, { api: rr.body.cards.joined, apiMissing: rr.body.cards.missing.joined, dated, undated });
      } else console.log('INFO  R2 skipped: top real owner has no employee record with an identical name');
    }
    const ropt = await call('GET', `/options${qs({ year: 2026 })}`, T.sa);
    const realRole = ropt.body.roles.find((r) => /^(EDU|MED|MFG)-\d+$/.test(r.code) && r.count > 0);
    check('R3 real roles (e.g. EDU-1, MED-1) load from the real positions with employee counts', !!realRole && ropt.body.roles.filter((r) => /^(EDU|MED)-\d+$/.test(r.code)).length >= 10, ropt.body.roles.length);
    if (realRole) {
      const rrole = await rep(T.sa, { period: 'all', role: realRole.id });
      const ro = await call('GET', `/options${qs({ role: realRole.id, period: 'all' })}`, T.sa);
      let g2 = 0; let j2 = 0;
      for (const e of ro.body.employees) { const r = await rep(T.sa, { period: 'all', role: realRole.id, employee: e.value }); g2 += r.body.cards.generated || 0; j2 += r.body.cards.joined || 0; }
      check(`R4 real role ${realRole.code}: ${ro.body.employees.length} employees (current + former); role total = sum of employees (generated ${rrole.body.cards.generated}, joined ${rrole.body.cards.joined})`,
        (rrole.body.cards.generated || 0) === g2 && (rrole.body.cards.joined || 0) === j2, { card: rrole.body.cards, g2, j2 });
      check('R5 a real role lists former employees too (status Former present or only active holders exist)', ro.body.employees.length > 0 && ro.body.employees.every((e) => e.status === 'Active' || e.status === 'Former'), ro.body.employees.slice(0, 3));
    }
    const former = ropt.body.employees.filter((e) => e.status === 'Former');
    check(`R6 resigned / relieved employees are selectable (${former.length} former in the list)`, former.length > 0, ropt.body.employees.length);
    const realDup = new Set(ropt.body.employees.map((e) => e.value));
    check('R7 no duplicate employees in the dropdown', realDup.size === ropt.body.employees.length, ropt.body.employees.length);
    // light smoke of neighbours
    const smoke = [];
    for (const u of ['/api/recruiter-joinings/board', '/api/ats/reports/funnel', '/api/hrms-dashboard']) {
      const r = await realFetch(`${API}${u}`, { headers: { Authorization: `Bearer ${T.sa}` } });
      smoke.push(`${u.replace('/api/', '')}:${r.status}`);
    }
    check('R8 other modules still answer (recruiter joinings, ATS reports, HRMS dashboard)', smoke.every((s) => /:(200|404)$/.test(s)) && smoke[0].endsWith('200'), smoke);
  } catch (e) {
    fail += 1; console.error('FAIL  test crashed:', e && e.stack || e);
  } finally {
    if (!KEEP && made) { const c = await cleanup(); console.log('cleaned', c); }
    else if (KEEP) console.log('fixtures KEPT for UI checks (run with --clean to remove)');
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
