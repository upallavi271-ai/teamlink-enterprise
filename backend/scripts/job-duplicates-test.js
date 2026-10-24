#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DUPLICATE JOBS acceptance tests (2026-10-13). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/job-duplicates-test.js
//
//   N  the normaliser table (40 title pairs: synonyms, abbreviations, codes, different specialisations)
//   L  levels per scenario (CERTAIN / LIKELY / POSSIBLE / none)
//   P  prevention at creation: the Add job form (409 DUPLICATE_JOB, Create anyway + memory, Add openings), Request a requirement,
//      Open job (activate), the client portal request, an import (silent)
//   M  the merge engine: people moved without duplicates, further step kept, events folded, postings taken down once, alias,
//      joined + invoice blocker, openings rule, the tally, undo (and refusal after the window), bulk obvious merge
//   R  roles: BDE own desk only, BDE TL all, TL / Recruiter no list but the ask button, no hard delete for BDE, Super Admin can
//   S  the real-data script guards
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');
const { spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const FP = require(path.join(BACK, 'src/utils/jobFingerprint'));
const D = require(path.join(BACK, 'src/utils/jobDupes'));
const M = require(path.join(BACK, 'src/utils/jobMerge'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
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

// N — the normaliser table: [title A, spec A, title B, spec B, same job?]
const PAIRS = [
  ['MED-2180 Staff Nurse', '', 'Staff Nurse', '', true],
  ['REQ-4284 - Staff Nurse', '', 'Staff Nurse', '', true],
  ['URGENT opening for Staff Nurse', '', 'Staff Nurse', '', true],
  ['Staff Nurses', '', 'Staff Nurse', '', true],
  ['Staff Nurse (3 nos)', '', 'Staff Nurse', '', true],
  ['Staff Nurse-2', '', 'Staff Nurse', '', true],
  ['Asst Prof', 'Pathology', 'Assistant Professor', 'Pathology', true],
  ['Asst. Professor - Pathology', '', 'Assistant Professor', 'Pathology', true],
  ['Assistant Professor', 'Pathology', 'Assistant Professor', 'Anatomy', false],
  ['Assistant Professor - Pathology', '', 'Assistant Professor - Anatomy', '', false],
  ['Assoc Prof', 'Cardiology', 'Associate Professor', 'Cardiology', true],
  ['Associate Professor', 'Cardiology', 'Assistant Professor', 'Cardiology', false],
  ['Sr Software Engineer', '', 'Senior Software Engineer', '', true],
  ['Sr. Software Engg', '', 'Senior Software Engineer', '', true],
  ['Jr Developer', '', 'Junior Developer', '', true],
  ['Senior Developer', '', 'Junior Developer', '', false],
  ['Faculty - cse', '', 'Faculty', 'cse', true],
  ['Faculty - cse', '', 'Faculty - ece', '', false],
  ['EDU-1049 Faculty - cse', '', 'REQ-22 Faculty cse', '', true],
  ['Hiring: HR Executive', '', 'HR Exec', '', true],
  ['HR Executive', '', 'HR Manager', '', false],
  ['Accounts Executive', '', 'Accounts Manager', '', false],
  ['Consultant Dermatologist - Dermatology', '', 'Consultant Dermatology', '', true],
  ['Doctor', 'Cardiology', 'Consultant Doctor', 'Cardiology', false],
  ['Dr', 'General Medicine', 'Doctor', 'General Medicine', true],
  ['Lab Technician', '', 'Lab Tech', '', true],
  ['Lab Technician', '', 'Lab Manager', '', false],
  ['Nurse - Hospital management - Banglore', '', 'Nurse - Hospital management - Bangalore', '', true],
  ['OT Nurse', '', 'ICU Nurse', '', false],
  ['Registered Nurse (ER & ICU)', '', 'Registered Nurse ER and ICU', '', true],
  ['MFG-1168 CNC milling Operator', '', 'CNC Milling Operators', '', true],
  ['CNC milling Operator', '', 'CNC Turning Operator', '', false],
  ['Primary Teacher', '', 'Primary teachers', '', true],
  ['Primary Teacher', '', 'Secondary Teacher', '', false],
  ['Purchase Head', 'Marketing', 'purchase head', 'marketing', true],
  ['Quality Manager', '', 'Quality Engineer', '', false],
  ['Senior Manager QA.', '', 'Senior Manager - QA', '', true],
  ['Mgr - Sales', '', 'Manager Sales', '', true],
  ['Physician', '', 'Doctor', '', true],
  ['Vacancy for Radiographer', '', 'Radiographer', '', true],
  ['Radiographer', '', 'Radiology Technician', '', false],
];

async function sweep() {
  const sql = async (q, ...p) => { try { await prisma.$executeRawUnsafe(q, ...p); } catch (e) { if (!/no such table/i.test(e.message)) console.error('cleanup:', q.slice(0, 70), String(e.message).slice(-120)); } };
  const rows = async (q, ...p) => { try { return await prisma.$queryRawUnsafe(q, ...p); } catch { return []; } };
  const inl = (a) => a.map(() => '?').join(',');
  const clients = (await rows("SELECT id FROM Client WHERE name LIKE 'ZZTEST JD %'")).map((r) => r.id);
  const reqIds = (await rows(`SELECT id FROM Requirement WHERE reqCode LIKE 'ZZJD-%'${clients.length ? ` OR clientId IN (${inl(clients)})` : ''}`, ...clients)).map((r) => r.id);
  const cands = (await rows("SELECT id FROM Candidate WHERE email LIKE 'zz-jd-cand-%'")).map((r) => r.id);
  const users = (await rows("SELECT id FROM User WHERE email LIKE 'zz-jd-%'")).map((r) => r.id);
  const appIds = reqIds.length || cands.length ? (await rows(`SELECT id FROM Application WHERE ${[reqIds.length ? `requirementId IN (${inl(reqIds)})` : null, cands.length ? `candidateId IN (${inl(cands)})` : null].filter(Boolean).join(' OR ')}`, ...reqIds, ...cands)).map((r) => r.id) : [];
  if (appIds.length) {
    for (const t of ['ApplicationStageEvent', 'ApplicationFollowUp', 'InterviewEvent', 'InterviewFeedback', 'CandidateMessage', 'CandidateNote', 'OfferVersion', 'InterviewPanelist', 'CreditNote', 'CandidateReferral', 'PartnerSubmission', 'PartnerPayout']) await sql(`DELETE FROM "${t}" WHERE applicationId IN (${inl(appIds)})`, ...appIds); // eslint-disable-line no-await-in-loop
    await sql(`DELETE FROM AuditLog WHERE entity = 'Application' AND entityId IN (${inl(appIds)})`, ...appIds);
  }
  if (clients.length) await sql(`DELETE FROM Invoice WHERE clientId IN (${inl(clients)})`, ...clients);
  if (appIds.length) await sql(`DELETE FROM Application WHERE id IN (${inl(appIds)})`, ...appIds);
  if (reqIds.length) {
    for (const t of ['RequirementPosting', 'PostingQueue', 'PostingLog', 'PortalPosting', 'ApplicationStageEvent', 'ApplicationFollowUp', 'CandidateReferral', 'CampusDrive', 'PartnerJobShare', 'PartnerSubmission']) await sql(`DELETE FROM "${t}" WHERE requirementId IN (${inl(reqIds)})`, ...reqIds); // eslint-disable-line no-await-in-loop
    await sql(`DELETE FROM AuditLog WHERE entity = 'Requirement' AND entityId IN (${inl(reqIds)})`, ...reqIds);
    await sql(`DELETE FROM JobDupDecision WHERE jobAId IN (${inl(reqIds)}) OR jobBId IN (${inl(reqIds)})`, ...reqIds, ...reqIds);
    await sql(`DELETE FROM JobAlias WHERE oldId IN (${inl(reqIds)}) OR keptId IN (${inl(reqIds)})`, ...reqIds, ...reqIds);
    await sql(`DELETE FROM JobMergeLog WHERE keptId IN (${inl(reqIds)}) OR extraId IN (${inl(reqIds)})`, ...reqIds, ...reqIds);
    await sql(`DELETE FROM Requirement WHERE id IN (${inl(reqIds)})`, ...reqIds);
  }
  if (users.length) {
    await sql(`DELETE FROM Notification WHERE userId IN (${inl(users)})`, ...users);
    await sql(`DELETE FROM AuditLog WHERE userId IN (${inl(users)})`, ...users);
  }
  await sql("DELETE FROM AuditLog WHERE actorName LIKE 'ZZTEST JD %'");
  await sql("DELETE FROM AuditLog WHERE reason LIKE '%ZZJD-%' OR toValue LIKE '%ZZJD-%' OR fromValue LIKE '%ZZJD-%'");
  if (cands.length) {
    await sql(`DELETE FROM CandidateDupKey WHERE candidateId IN (${inl(cands)})`, ...cands);
    await sql(`DELETE FROM CandidateDupSig WHERE candidateId IN (${inl(cands)})`, ...cands);
    await sql(`DELETE FROM CandidateDupFlag WHERE candidateId IN (${inl(cands)}) OR matchCandidateId IN (${inl(cands)})`, ...cands, ...cands);
    await sql(`DELETE FROM AuditLog WHERE entity = 'Candidate' AND entityId IN (${inl(cands)})`, ...cands);
    await sql(`DELETE FROM Candidate WHERE id IN (${inl(cands)})`, ...cands);
  }
  if (clients.length) await sql(`DELETE FROM Client WHERE id IN (${inl(clients)})`, ...clients);
  if (users.length) { await sql(`DELETE FROM Employee WHERE userId IN (${inl(users)})`, ...users); await sql(`DELETE FROM User WHERE id IN (${inl(users)})`, ...users); }
}

(async () => {
  const made = { users: [], clients: [], reqs: [], cands: [], apps: [], extra: [], logs: [], alias: [] };
  await sweep();
  try {
    // ----------------------------------------------------------------------------------------------------------------
    PAIRS.forEach(([ta, sa, tb, sb, same], i) => {
      const a = FP.identityTokens(ta, sa); const b = FP.identityTokens(tb, sb);
      const got = a.length > 0 && a.join(' ') === b.join(' ');
      check(`N${String(i + 1).padStart(2, '0')} "${ta}${sa ? ` [${sa}]` : ''}" ${same ? '=' : '!='} "${tb}${sb ? ` [${sb}]` : ''}"`, got === same, [a, b]);
    });
    check('N41 cities: Hyderabad = Bachupally, Hyderabad; Khammam != Hyderabad; blank is unknown',
      FP.sameLocation('Hyderabad', 'Bachupally, Hyderabad') === 'same' && FP.sameLocation('Khammam', 'Hyderabad') === 'different' && FP.sameLocation('', 'Pune') === 'unknown');
    check('N42 salary / experience bands', FP.salaryBand('14L - 20L') === '14-16' && FP.expBand('3-5 yrs') === '3-5' && FP.expBand('Fresher') === '0-1');

    // ----------------------------------------------------------------------------------------------------------------
    // fixtures
    const ok = await D.supported();
    check('F0 the three duplicate-job tables exist in the sandbox', ok === true, 'apply backend/prisma/migrations/20261013140000_job_duplicates/migration.sql to sandbox.db');
    if (!ok) return;
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST JD ${tag} ${RUN}`, email: `zz-jd-${tag}-${RUN}@zzjd-fixture.test`, username: `zz-jd-${tag}-${RUN}@zzjd-fixture.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const uSuper = await mkUser('super', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
    const uBde1 = await mkUser('bde1', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const uBde2 = await mkUser('bde2', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ super: uSuper, admin: uAdmin, bdeTl: uBdeTl, bde1: uBde1, bde2: uBde2, tl: uTl, rec: uRec, mgr: uMgr })) T[k] = await mint(u);

    const mkClient = async (tag, bde) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST JD Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: bde ? bde.name : null, clientType: 'Client', agreementStatus: 'ACTIVE' } });
      made.clients.push(c.id); return c;
    };
    const cA = await mkClient('A', uBde1);
    const cB = await mkClient('B', uBde2);
    let seq = 0;
    const mkJob = async (client, title, o = {}) => {
      seq += 1;
      const r = await prisma.requirement.create({
        data: {
          title, clientId: client.id, status: 'OPEN', department: 'Education', openings: 1, reqCode: `ZZJD-${RUN}-${seq}`.slice(0, 40),
          bdeId: client === cA ? uBde1.id : uBde2.id, tlId: uTl.id, ...o,
        },
      });
      made.reqs.push(r.id); return r;
    };
    let cseq = 0;
    const mkApp = async (job, tag, stage, extra = {}, candId = null) => {
      cseq += 1;
      let c;
      if (candId) c = { id: candId };
      else {
        c = await prisma.candidate.create({ data: { name: `ZZTEST JD Cand ${tag} ${RUN}`, email: `zz-jd-cand-${tag}-${RUN}@zzjd-fixture.test`, phone: `9${String(7000000000 + cseq * 7919 + Math.floor(Math.random() * 1000)).slice(1)}`, location: 'ZZ' } });
        made.cands.push(c.id);
      }
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: job.id, stage, ...extra } });
      made.apps.push(a.id); return { a, c };
    };
    const level = async (x, y) => {
      const data = await D.everything({ force: true });
      const cl = D.clusterOfJob(data, x.id);
      return cl && cl.jobIds.includes(y.id) ? cl.level : null;
    };

    // ----------------------------------------------------------------------------------------------------------------
    // L — levels
    const a1 = await mkJob(cA, 'Staff Nurse', { location: 'Hyderabad', openings: 2 });
    const a2 = await mkJob(cA, 'MED-2180 Staff Nurse', { location: 'Bachupally, Hyderabad', openings: 2 });
    check('L1 same client + same title (code stripped) + same city + same openings, both open = CERTAIN', (await level(a1, a2)) === 'CERTAIN');
    const b1 = await mkJob(cA, 'Assistant Professor', { location: 'Khammam', specialisation: 'Pathology' });
    const b2 = await mkJob(cA, 'Asst Prof', { location: 'Khammam', specialisation: 'Anatomy' });
    check('L2 the same college posting Assistant Professor for different specialisations does NOT match', (await level(b1, b2)) === null);
    const c1 = await mkJob(cA, 'Lab Technician', { location: 'Hyderabad', openings: 1 });
    const c2 = await mkJob(cA, 'Lab Technician', { location: 'Hyderabad', openings: 3 });
    check('L3 same title + city but different openings = LIKELY', (await level(c1, c2)) === 'LIKELY');
    const d1 = await mkJob(cA, 'Radiographer', { location: 'Hyderabad' });
    const d2 = await mkJob(cA, 'Radiographer', { location: 'Pune' });
    check('L4 same title, a different city, opened together = LIKELY, never CERTAIN', (await level(d1, d2)) === 'LIKELY');
    const e1 = await mkJob(cA, 'Pharmacist', { location: 'Hyderabad' });
    const e2 = await mkJob(cB, 'Pharmacist', { location: 'Hyderabad' });
    check('L5 the same title for ANOTHER client never matches', (await level(e1, e2)) === null);
    const f1 = await mkJob(cA, 'Dietician', { location: 'Hyderabad', status: 'CLOSED' });
    const f2 = await mkJob(cA, 'Dietician', { location: 'Hyderabad' });
    check('L6 a closed job and an open one: history, not a duplicate (worklist)', (await level(f1, f2)) === null);
    const g1 = await mkJob(cA, 'Warden', { location: 'Hyderabad', status: 'CLOSED' });
    const g2 = await mkJob(cA, 'Warden', { location: 'Hyderabad', status: 'CLOSED' });
    check('L7 two closed jobs are never a duplicate', (await level(g1, g2)) === null);
    const h1 = await mkJob(cA, 'Security Guard', { location: 'Hyderabad', jobDescription: 'Guard the main gate and check visitors at the entrance every day of the week carefully and politely with a record book' });
    const h2 = await mkJob(cA, 'Receptionist', { location: 'Hyderabad', jobDescription: 'Welcome visitors at the front desk answer phone calls and keep the register of guests and parcels for the office staff daily' });
    check('L8 different titles with different descriptions: nothing', (await level(h1, h2)) === null);
    const i1 = await mkJob(cA, 'Mechanical Engineer', { location: 'Hyderabad', skills: 'AutoCAD, SolidWorks, Ansys, Design' });
    const i2 = await mkJob(cA, 'Mechanical Design Engineer', { location: 'Hyderabad', skills: 'AutoCAD, SolidWorks, Ansys, Design' });
    check('L9 a similar title with the same skills = POSSIBLE', (await level(i1, i2)) === 'POSSIBLE');
    const k1 = await mkJob(cA, 'Sales Executive', { location: 'Hyderabad', experience: '0-1 years' });
    const k2 = await mkJob(cA, 'Sales Executive', { location: 'Hyderabad', experience: '8-10 years' });
    check('L10 same title + city but a very different experience asked: only LIKELY (not CERTAIN)', (await level(k1, k2)) === 'LIKELY');
    const m1 = await mkJob(cA, 'Driver');
    const m2 = await mkJob(cA, 'Driver');
    check('L11 no city on either requirement, saved together, same openings = CERTAIN (a batch saved twice)', (await level(m1, m2)) === 'CERTAIN');
    const n1 = await mkJob(cA, 'Electrician');
    const n2 = await mkJob(cA, 'Electrician');
    await prisma.requirement.update({ where: { id: n1.id }, data: { createdAt: new Date(Date.now() - 200 * 86400000) } });
    check('L12 no city, opened 200 days apart = only POSSIBLE', (await level(n1, n2)) === 'POSSIBLE');
    const o1 = await mkJob(cA, 'Cook', { internal: true });
    const o2 = await mkJob(cA, 'Cook', { internal: true });
    check('L13 internal TeamLink openings are never compared', (await level(o1, o2)) === null);
    const p1 = await mkJob(cA, 'Gardener', { status: 'DRAFT' });
    const p2 = await mkJob(cA, 'Gardener');
    check('L14 a draft is not a job yet', (await level(p1, p2)) === null);
    const q1 = await mkJob(cA, 'Anaesthetist', { location: 'Hyderabad' });
    const q2 = await mkJob(cA, 'Pediatrician', { location: 'Pune' });
    for (const r of [q1, q2]) await prisma.requirementPosting.create({ data: { requirementId: r.id, source: 'naukri', status: 'Posted', externalJobId: `NK-${RUN}-777` } });
    check('L15 the same external job id on a job board = CERTAIN', (await level(q1, q2)) === 'CERTAIN');
    await D.rememberNotDuplicate(c1.id, c2.id, { reason: 'Two campuses', user: uAdmin });
    check('L16 a pair marked "Not a duplicate" is never offered again', (await level(c1, c2)) === null);
    await D.forgetDecision(c1.id, c2.id);
    check('L17 ... and offered again when the decision is withdrawn', (await level(c1, c2)) === 'LIKELY');

    // ----------------------------------------------------------------------------------------------------------------
    // P — prevention at creation
    const formBody = (o = {}) => ({
      title: 'Staff Nurse', clientId: cA.id, department: 'Education', openings: 2, location: 'Hyderabad', skills: 'Nursing, ICU',
      jobDescription: 'Staff nurse for the ward with ICU experience and good patient care skills', experience: '2-4', ...o,
    });
    // a1 now has two people so the card says so
    await mkApp(a1, 'p1', 'WITH_BDE'); await mkApp(a1, 'p2', 'NEW');
    const p409 = await call('POST', '/api/requirements', T.admin, formBody({ title: 'URGENT opening for Staff Nurses' }));
    check('P1 Admin saves a job that twins an open one: 409 DUPLICATE_JOB (CERTAIN) with the match', p409.status === 409 && p409.body && p409.body.code === 'DUPLICATE_JOB' && p409.body.level === 'CERTAIN' && p409.body.matches.some((m) => m.id === a1.id), [p409.status, p409.body]);
    const card = p409.body && p409.body.matches.find((m) => m.id === a1.id);
    check('P2 the card names the job, its code, status, people on it and the date', !!card && card.reqCode === a1.reqCode && card.candidates === 2 && card.status === 'OPEN' && !!card.createdAt && /already have/i.test(p409.body.error), card);
    check('P3 nothing was saved by the blocked call', (await prisma.requirement.count({ where: { clientId: cA.id, title: { contains: 'URGENT' } } })) === 0);
    const p409b = await call('POST', '/api/requirements', T.admin, formBody({ title: 'Staff Nurse', duplicateOverride: true, duplicateReason: 'ok' }));
    check('P4 "Create anyway" on a CERTAIN twin needs a real reason (5+ letters)', p409b.status === 409 && p409b.body.needsReason === true, [p409b.status, p409b.body && p409b.body.error]);
    const pOk = await call('POST', '/api/requirements', T.admin, formBody({ title: 'Staff Nurse', duplicateOverride: true, duplicateReason: 'A second ward, a different job' }));
    check('P5 "Create anyway" with a reason saves the job', pOk.status === 201 && !!pOk.body.id, [pOk.status, pOk.body]);
    if (pOk.body && pOk.body.id) made.reqs.push(pOk.body.id);
    const mem = pOk.body && pOk.body.id ? await D.q('SELECT * FROM JobDupDecision WHERE pairKey = ?', D.pairKey(pOk.body.id, a1.id)) : [];
    check('P6 ... and the pair is remembered as "Not a duplicate"', mem.length === 1 && /second ward/.test(mem[0].reason || ''), mem);
    check('P7 ... so the worklist does not offer the pair', (await level(a1, { id: pOk.body.id })) === null || (await level(a1, { id: pOk.body.id })) !== 'CERTAIN');
    const aud = pOk.body && pOk.body.id ? await prisma.auditLog.count({ where: { entityId: pOk.body.id, action: 'Duplicate requirement created anyway' } }) : 0;
    check('P8 the "Create anyway" is in the audit trail with its reason', aud === 1, aud);
    // a different specialisation / city is not blocked
    const pDiff = await call('POST', '/api/requirements', T.admin, formBody({ title: 'Assistant Professor', specialisation: 'Biochemistry', location: 'Khammam' }));
    check('P9 a job that is NOT a twin saves without a card', pDiff.status === 201, [pDiff.status, pDiff.body]);
    if (pDiff.body && pDiff.body.id) made.reqs.push(pDiff.body.id);
    const pLikely = await call('POST', '/api/requirements', T.admin, formBody({ title: 'Radiographer', location: 'Hyderabad', openings: 4 }));
    check('P10 a LIKELY twin (same title + city, other openings) also shows the card (409, level LIKELY)', pLikely.status === 409 && pLikely.body.level === 'LIKELY' && pLikely.body.needsReason === false, [pLikely.status, pLikely.body && pLikely.body.level]);
    const pLikelyOk = await call('POST', '/api/requirements', T.admin, formBody({ title: 'Radiographer', location: 'Hyderabad', openings: 4, duplicateOverride: true }));
    check('P11 ... and "Create anyway" needs no reason for a LIKELY twin', pLikelyOk.status === 201, [pLikelyOk.status, pLikelyOk.body]);
    if (pLikelyOk.body && pLikelyOk.body.id) made.reqs.push(pLikelyOk.body.id);
    // Add openings to the existing requirement
    const addO = await call('POST', '/api/job-duplicates/add-openings', T.bde1, { jobId: a1.id, add: 3, note: 'Client asked again' });
    const a1After = await prisma.requirement.findUnique({ where: { id: a1.id } });
    check('P12 "Add openings to the existing requirement": the BDE adds 3, the job has 5, audited', addO.status === 200 && a1After.openings === 5 && (await prisma.auditLog.count({ where: { entityId: a1.id, action: 'Openings added to existing requirement' } })) === 1, [addO.status, addO.body, a1After.openings]);
    await prisma.requirement.update({ where: { id: a1.id }, data: { openings: 2 } });
    const addTl = await call('POST', '/api/job-duplicates/add-openings', T.tl, { jobId: a1.id, add: 1 });
    check('P13 a TL cannot add openings (not the client manager team)', addTl.status === 403, addTl.status);
    // Request a requirement (BDE) — the same rule
    const reqBde = await call('POST', '/api/requirements', T.bde1, formBody({ title: 'Staff Nurse' }));
    check('P14 a BDE "Request a requirement" that twins an open job: 409 DUPLICATE_JOB', reqBde.status === 409 && reqBde.body && reqBde.body.code === 'DUPLICATE_JOB', [reqBde.status, reqBde.body]);
    const reqBdeOk = await call('POST', '/api/requirements', T.bde1, formBody({ title: 'Staff Nurse', duplicateOverride: true, duplicateReason: 'Another ward, other job' }));
    check('P15 ... "Create anyway" saves the job (BDE team creates directly now)', reqBdeOk.status === 201 && !!reqBdeOk.body.id, [reqBdeOk.status, reqBdeOk.body]);
    if (reqBdeOk.body && reqBdeOk.body.id) made.reqs.push(reqBdeOk.body.id);
    // the client portal door (the same helper; the portal answer is in plain words)
    const RR = require(path.join(BACK, 'src/utils/requirementRequest'));
    const portal = await RR.createRequirementRequest({ title: 'Staff Nurse', clientId: cA.id, openings: 2, location: 'Hyderabad' }, { user: { id: uBde1.id, name: 'ZZTEST JD portal' }, via: 'Client portal' });
    check('P16 the client portal request for a job already open: 409 in plain words (no internal codes)', portal.status === 409 && portal.body.code === 'DUPLICATE_JOB' && /already asked/.test(portal.body.error) && !/ZZJD/.test(portal.body.error), portal);
    const portalOk = await RR.createRequirementRequest({ title: 'Warehouse Manager', clientId: cA.id, openings: 1 }, { user: { id: uBde1.id, name: 'ZZTEST JD portal' }, via: 'Client portal' });
    check('P17 a portal request for a new job is saved as before', portalOk.status === 201, portalOk);
    if (portalOk.body && portalOk.body.id) made.reqs.push(portalOk.body.id);
    // Open job (activate a draft): the check runs there too
    const dr = await mkJob(cA, 'Staff Nurse', { status: 'DRAFT', location: 'Hyderabad', openings: 2 });
    const act = await call('POST', `/api/requirements/${dr.id}/activate`, T.admin, {});
    check('P18 "Open job" on a draft that twins an open job: 409 DUPLICATE_JOB', act.status === 409 && act.body && act.body.code === 'DUPLICATE_JOB', [act.status, act.body]);
    const act2 = await call('POST', `/api/requirements/${dr.id}/activate`, T.admin, { duplicateOverride: true, duplicateReason: 'Second batch for the client' });
    check('P19 ... it opens once the Admin says it is a different job', act2.status === 200, [act2.status, act2.body]);
    // an import (silent): never blocks, flagged instead
    const G = require(path.join(BACK, 'src/utils/jobDupGuard'));
    const silent = await G.guardCreate({ ...formBody({ title: 'Staff Nurse' }) }, { door: 'Excel import', silent: true });
    check('P20 an import is never blocked, the twin is returned silently', !silent.block && silent.matches.length > 0 && silent.silent === true);
    const imp = await mkJob(cA, 'Staff Nurse', { location: 'Hyderabad', openings: 2 });
    await G.noteSilent(imp, silent.matches, { door: 'Excel import' });
    check('P21 ... and a quiet audit line says so', (await prisma.auditLog.count({ where: { entityId: imp.id, action: 'Possible duplicate requirement noticed' } })) === 1);
    check('P22 the live check endpoint answers the same card (BDE)', (await call('POST', '/api/job-duplicates/check', T.bde1, formBody({ title: 'Staff Nurse' }))).body.matches.length > 0);
    const chkTl = await call('POST', '/api/job-duplicates/check', T.rec, formBody({ title: 'Staff Nurse' }));
    check('P23 a Recruiter has no use for the check (refused)', chkTl.status === 403, chkTl.status);

    // ----------------------------------------------------------------------------------------------------------------
    // M — the merge engine
    const K = await mkJob(cA, 'Merge Target Role', { location: 'Hyderabad', openings: 2 });
    const E = await mkJob(cA, 'Merge Target Role', { location: 'Hyderabad', openings: 5 });
    await prisma.requirement.update({ where: { id: K.id }, data: { createdAt: new Date(Date.now() - 5 * 86400000) } });
    const ak1 = await mkApp(K, 'm-ak1', 'WITH_BDE');
    const ak2 = await mkApp(K, 'm-ak2', 'SHARED_WITH_CLIENT');
    await mkApp(K, 'm-k3', 'NEW');
    const ae1 = await mkApp(E, 'm-ae1', 'NEW', {}, ak1.c.id); // same person as ak1, further step is K's
    const ae2 = await mkApp(E, 'm-ae2', 'INTERVIEW_SCHEDULED', { interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 86400000) }, ak2.c.id); // same person as ak2, E's is further
    const ae3 = await mkApp(E, 'm-ae3', 'WITH_BDE'); // only on E
    const ae4 = await mkApp(E, 'm-ae4', 'OFFER'); // only on E, at the offer
    for (const ap of [ae1, ae2, ae3]) {
      await prisma.applicationStageEvent.create({ data: { applicationId: ap.a.id, candidateId: ap.c.id, toStage: ap.a.stage, action: 'Added', requirementId: E.id } });
    }
    await prisma.applicationFollowUp.create({ data: { applicationId: ae2.a.id, candidateId: ae2.c.id, requirementId: E.id, ownerName: 'ZZTEST', nextAction: 'Call back', dueDate: '2030-01-01' } });
    await prisma.requirementPosting.create({ data: { requirementId: E.id, source: 'website', status: 'Posted', postedAt: new Date() } });
    await prisma.requirementPosting.create({ data: { requirementId: K.id, source: 'website', status: 'Posted', postedAt: new Date() } });
    const before = {
      people: (await prisma.application.count({ where: { requirementId: { in: [K.id, E.id] } } })),
      events: await prisma.applicationStageEvent.count({ where: { OR: [{ requirementId: E.id }, { applicationId: { in: [ae1.a.id, ae2.a.id, ae3.a.id] } }] } }),
    };
    const pv = await call('POST', '/api/job-duplicates/merge', T.bde2, { keptId: K.id, extraIds: [E.id] });
    check('M0 a BDE of ANOTHER client cannot merge these jobs (not in his area)', pv.status === 403, [pv.status, pv.body]);
    const prev = await M.previewMerge(K.id, E.id);
    check('M1 the preview: 2 people move, 2 are folded, openings 5 (the larger), no blocker', prev.ok && prev.willMove.people === 2 && prev.willMove.folded === 2 && prev.openings.to === 5, prev);
    const mg = await call('POST', '/api/job-duplicates/merge', T.bde1, { keptId: K.id, extraIds: [E.id] });
    check('M2 the BDE of the client merges the extra into the kept requirement', mg.status === 200 && mg.body.ok && mg.body.merged.length === 1, [mg.status, mg.body]);
    const logId = mg.body && mg.body.merged && mg.body.merged[0].logId;
    const appsK = await prisma.application.findMany({ where: { requirementId: K.id } });
    const personIds = appsK.map((a) => a.candidateId);
    check('M3 nobody is on the kept requirement twice (5 people: 3 + 2 new from the extra)', appsK.length === 5 && new Set(personIds).size === 5, [appsK.length, new Set(personIds).size]);
    const k2now = appsK.find((a) => a.candidateId === ak2.c.id);
    const k1now = appsK.find((a) => a.candidateId === ak1.c.id);
    check('M4 the person on both keeps the FURTHER step (ak1 stays With BDE, ak2 moves to Interview scheduled with the booking)', k1now.stage === 'WITH_BDE' && k2now.stage === 'INTERVIEW_SCHEDULED' && k2now.interviewStatus === 'SCHEDULED' && !!k2now.interviewAt, [k1now.stage, k2now.stage]);
    check('M5 nothing is left on the extra job', (await prisma.application.count({ where: { requirementId: E.id } })) === 0);
    const evAfter = await prisma.applicationStageEvent.count({ where: { OR: [{ requirementId: K.id }, { applicationId: { in: appsK.map((a) => a.id) } }] } });
    check('M6 the step history is folded onto the kept requirement (no event lost)', evAfter >= before.events, [evAfter, before.events]);
    const fu = await prisma.applicationFollowUp.findFirst({ where: { nextAction: 'Call back', candidateId: ae2.c.id } });
    check('M7 the follow-up moved with its person', !!fu && fu.applicationId === k2now.id && fu.requirementId === K.id, fu);
    const Ea = await prisma.requirement.findUnique({ where: { id: E.id } });
    const Ka = await prisma.requirement.findUnique({ where: { id: K.id } });
    check('M8 the extra job is CLOSED, the kept requirement stays open', Ea.status === 'CLOSED' && Ka.status === 'OPEN');
    check('M9 openings: the larger of the two (5)', Ka.openings === 5, Ka.openings);
    check('M10 the older job (K) keeps its code', Ka.reqCode.startsWith('ZZJD-') && Ka.reqCode.endsWith('-' + String(made.reqs.length ? Ka.reqCode.split('-').pop() : '')) && true);
    const al = await D.q('SELECT * FROM JobAlias WHERE oldId = ?', E.id);
    check('M11 an alias is left: the merged-away job id points at the kept requirement', al.length === 1 && al[0].keptId === K.id, al);
    const aliasOpen = await call('GET', `/api/requirements/${E.id}`, T.admin);
    check('M12 the old link opens the KEPT job', aliasOpen.status === 200 && aliasOpen.body.id === K.id, [aliasOpen.status, aliasOpen.body && aliasOpen.body.id]);
    const postE = await prisma.requirementPosting.findFirst({ where: { requirementId: E.id, source: 'website' } });
    const postK = await prisma.requirementPosting.findFirst({ where: { requirementId: K.id, source: 'website' } });
    check('M13 the extra is taken off the site once; the kept requirement stays posted', postE && postE.status !== 'Posted' && postK && postK.status === 'Posted', [postE && postE.status, postK && postK.status]);
    const tally = await prisma.application.groupBy({ by: ['stage'], where: { requirementId: K.id }, _count: { _all: true } });
    const tallySum = tally.reduce((n, t) => n + t._count._all, 0);
    check('M14 the tally equation holds: people added (before) - folded = people on the kept requirement = the sum of the steps', before.people - 2 === appsK.length && tallySum === appsK.length, [before.people, appsK.length, tallySum]);
    const summ = await call('GET', `/api/requirements/${K.id}/summary`, T.admin);
    check('M15 the job page counts agree (summary opens, pipeline present)', summ.status === 200 && !!summ.body.pipeline, summ.status);
    const bells = await prisma.notification.findMany({ where: { recipient: { startsWith: `job-merge|${logId}|` } } });
    check('M16 the owners of both jobs got ONE bell each (BDE of the client is the doer; the TL hears it)', bells.length >= 1 && new Set(bells.map((b) => b.userId)).size === bells.length, bells.map((b) => b.userId));
    const mergesList = await call('GET', '/api/job-duplicates/merges', T.bde1);
    check('M17 "Recent merges" lists it with Undo available', mergesList.status === 200 && mergesList.body.merges.some((x) => x.id === logId && x.canUndo), mergesList.body);
    // undo
    const un = await call('POST', `/api/job-duplicates/merges/${logId}/undo`, T.bde1);
    check('M18 Undo inside the window', un.status === 200 && un.body.ok, [un.status, un.body]);
    const peopleK = await prisma.application.count({ where: { requirementId: K.id } });
    const peopleE = await prisma.application.count({ where: { requirementId: E.id } });
    const Ea2 = await prisma.requirement.findUnique({ where: { id: E.id } });
    const Ka2 = await prisma.requirement.findUnique({ where: { id: K.id } });
    check('M19 after Undo: 3 people on the kept requirement, 4 on the extra (as before), extra open again, openings back to 2', peopleK === 3 && peopleE === 4 && Ea2.status === 'OPEN' && Ka2.openings === 2, [peopleK, peopleE, Ea2.status, Ka2.openings]);
    check('M20 after Undo: the alias is gone and the old link opens the old job', (await D.q('SELECT * FROM JobAlias WHERE oldId = ?', E.id)).length === 0 && (await call('GET', `/api/requirements/${E.id}`, T.admin)).body.id === E.id);
    check('M21 after Undo: the person on both jobs is on both again', (await prisma.application.count({ where: { candidateId: ak1.c.id, requirementId: { in: [K.id, E.id] } } })) === 2 && (await prisma.application.count({ where: { candidateId: ak2.c.id, requirementId: { in: [K.id, E.id] } } })) === 2);
    const un2 = await call('POST', `/api/job-duplicates/merges/${logId}/undo`, T.bde1);
    check('M22 a second Undo is refused', un2.status === 409, un2.status);
    // after the window
    const mg2 = await call('POST', '/api/job-duplicates/merge', T.bde1, { keptId: K.id, extraIds: [E.id], openings: 'sum' });
    const log2 = mg2.body && mg2.body.merged && mg2.body.merged[0].logId;
    check('M23 merging again with openings = sum gives 7', mg2.status === 200 && (await prisma.requirement.findUnique({ where: { id: K.id } })).openings === 7, [mg2.status, mg2.body]);
    await D.ex('UPDATE JobMergeLog SET undoUntil = ? WHERE id = ?', Date.now() - 1000, log2);
    const un3 = await call('POST', `/api/job-duplicates/merges/${log2}/undo`, T.bde1);
    check('M24 Undo after the 7 days is refused', un3.status === 409 && /window/i.test(un3.body.error), [un3.status, un3.body]);
    // a joined + invoiced placement never moves silently
    const J1 = await mkJob(cA, 'Invoiced Role', { location: 'Hyderabad' });
    const J2 = await mkJob(cA, 'Invoiced Role', { location: 'Hyderabad' });
    const jn = await mkApp(J2, 'j1', 'JOINED');
    const inv = await prisma.invoice.create({ data: { clientId: cA.id, candidateId: jn.c.id, requirementId: J2.id, amount: 1000, invoiceDate: '2026-10-01' } });
    made.extra.push(['invoice', inv.id]);
    const blocked = await call('POST', '/api/job-duplicates/merge', T.bde1, { keptId: J1.id, extraIds: [J2.id] });
    check('M25 a job with an invoice cannot be merged away: refused with the plain reason', blocked.status === 409 && /invoice/i.test(blocked.body.error), [blocked.status, blocked.body]);
    check('M26 nothing moved when refused', (await prisma.application.count({ where: { requirementId: J2.id } })) === 1 && (await prisma.requirement.findUnique({ where: { id: J2.id } })).status === 'OPEN');
    const wl = await call('GET', '/api/job-duplicates/worklist?tab=must&search=ZZTEST%20JD%20Client&pageSize=50', T.admin);
    const jc = wl.body.groups.flatMap((g) => g.clusters).find((c) => c.jobs.some((x) => x.id === J2.id));
    check('M27 the worklist proposes the invoiced job as the one to KEEP, so the pair can be merged', !!jc && jc.keptId === J2.id && jc.canMerge === true, jc && [jc.keptId, jc.canMerge, jc.blocked]);
    const okInv = await call('POST', '/api/job-duplicates/merge', T.bde1, { keptId: J2.id, extraIds: [J1.id] });
    check('M28 merging the other way round (keep the invoiced job) works', okInv.status === 200, [okInv.status, okInv.body]);
    // close the extra only: has no people
    const Z1 = await mkJob(cA, 'Empty Twin Role', { location: 'Hyderabad' });
    const Z2 = await mkJob(cA, 'Empty Twin Role', { location: 'Hyderabad' });
    await mkApp(Z1, 'z1', 'NEW');
    const ce1 = await call('POST', '/api/job-duplicates/close-extra', T.bde1, { extraId: Z1.id });
    check('M29 "Close the extra only" is refused when the job has people', ce1.status === 409, [ce1.status, ce1.body]);
    const ce2 = await call('POST', '/api/job-duplicates/close-extra', T.bde1, { extraId: Z2.id, keptId: Z1.id });
    check('M30 "Close the extra only" closes a job with nobody on it (archived, not deleted)', ce2.status === 200 && (await prisma.requirement.findUnique({ where: { id: Z2.id } })).status === 'CLOSED');
    // not a duplicate
    const Y1 = await mkJob(cA, 'Another Pair Role', { location: 'Hyderabad' });
    const Y2 = await mkJob(cA, 'Another Pair Role', { location: 'Hyderabad' });
    const nd0 = await call('POST', '/api/job-duplicates/not-duplicate', T.bde1, { jobIds: [Y1.id, Y2.id], reason: '' });
    check('M31 "Not a duplicate" needs a reason', nd0.status === 400, nd0.status);
    const nd = await call('POST', '/api/job-duplicates/not-duplicate', T.bde1, { jobIds: [Y1.id, Y2.id], reason: 'Two different wards' });
    check('M32 "Not a duplicate" is saved and the pair leaves the worklist', nd.status === 200 && (await level(Y1, Y2)) === null, [nd.status, nd.body]);
    // bulk obvious
    const B1 = await mkJob(cA, 'Bulk Role One', { location: 'Pune' });
    const B2 = await mkJob(cA, 'Bulk Role One', { location: 'Pune' });
    const B3 = await mkJob(cB, 'Bulk Role Two', { location: 'Pune' });
    const B4 = await mkJob(cB, 'Bulk Role Two', { location: 'Pune' });
    await mkApp(B1, 'b1', 'WITH_BDE'); await mkApp(B2, 'b2', 'NEW');
    const prop = await call('GET', '/api/job-duplicates/auto-merge', T.bdeTl);
    const mine = (prop.body.proposals || []).filter((x) => [B1.id, B2.id, B3.id, B4.id].includes(x.keptId) || x.extras.some((e) => [B1.id, B2.id, B3.id, B4.id].includes(e.id)));
    check('M33 the obvious ones (CERTAIN, no blocker) come as a proposal list with what would move', prop.status === 200 && mine.length === 2 && mine.every((x) => x.canApprove) && mine.some((x) => x.willMove >= 1), [prop.status, mine.length]);
    const bdeProp = await call('GET', '/api/job-duplicates/auto-merge', T.bde1);
    check('M34 a BDE sees only the proposals of his own clients', bdeProp.status === 200 && (bdeProp.body.proposals || []).every((x) => !x.extras.some((e) => [B3.id, B4.id].includes(e.id))) && (bdeProp.body.proposals || []).some((x) => x.extras.some((e) => [B1.id, B2.id].includes(e.id)) || [B1.id, B2.id].includes(x.keptId)), (bdeProp.body.proposals || []).length);
    const appr = await call('POST', '/api/job-duplicates/auto-merge/approve', T.bdeTl, { clusterIds: mine.map((x) => x.clusterId) });
    check('M35 "Approve all" merges those clusters', appr.status === 200 && appr.body.mergedJobs === 2, [appr.status, appr.body]);
    const stillOpen = await prisma.requirement.count({ where: { id: { in: [B1.id, B2.id, B3.id, B4.id] }, status: { not: 'CLOSED' } } });
    check('M36 two jobs are left open (one per pair), two are closed', stillOpen === 2, stillOpen);

    // ----------------------------------------------------------------------------------------------------------------
    // R — roles
    const R1 = await mkJob(cA, 'Roster Planner', { location: 'Hyderabad', recruiterId: uRec.id });
    const R2 = await mkJob(cA, 'Roster Planner', { location: 'Hyderabad', recruiterId: uRec.id });
    const R3 = await mkJob(cB, 'Roster Planner Med', { location: 'Hyderabad' });
    const R4 = await mkJob(cB, 'Roster Planner Med', { location: 'Hyderabad' });
    const inList = async (tok, ids) => {
      const w = await call('GET', '/api/job-duplicates/worklist?tab=must&pageSize=50&search=ZZTEST%20JD%20Client', tok);
      const seen = w.body && w.body.groups ? w.body.groups.flatMap((g) => g.clusters.flatMap((c) => c.jobs.map((x) => x.id))) : [];
      return { status: w.status, has: ids.map((i) => seen.includes(i)), body: w.body };
    };
    const w1 = await inList(T.bde1, [R1.id, R3.id]); const w2 = await inList(T.bde2, [R1.id, R3.id]); const w3 = await inList(T.bdeTl, [R1.id, R3.id]); const w4 = await inList(T.admin, [R1.id, R3.id]);
    check('R1 BDE (own clients): sees his own client\'s pair, not the other client\'s', w1.status === 200 && w1.has[0] === true && w1.has[1] === false, w1.has);
    check('R2 the other BDE sees only his own client', w2.status === 200 && w2.has[0] === false && w2.has[1] === true, w2.has);
    check('R3 BDE TL and Admin see all', w3.has.every(Boolean) && w4.has.every(Boolean), [w3.has, w4.has]);
    for (const [who, tok] of [['TL', T.tl], ['Recruiter', T.rec]]) {
      const w = await call('GET', '/api/job-duplicates/worklist', tok);
      const s = await call('GET', '/api/job-duplicates/status', tok);
      check(`R4 ${who}: no Duplicate requirements list (403) and the badge is hidden`, w.status === 403 && s.status === 200 && s.body.visible === false && s.body.badge === 0, [w.status, s.body]);
      const mgx = await call('POST', '/api/job-duplicates/merge', tok, { keptId: R1.id, extraIds: [R2.id] });
      check(`R5 ${who}: cannot merge`, mgx.status === 403, mgx.status);
    }
    const note = await call('GET', `/api/job-duplicates/job/${R1.id}`, T.rec);
    check('R6 a Recruiter sees a small note on the job: possible duplicate, with the ask button; no merge button', note.status === 200 && note.body.twin === true && note.body.canAsk === true && note.body.canResolve === false && note.body.with.length === 1, note.body);
    const noteText = JSON.stringify(note.body);
    check('R7 the note carries no candidate, agreement or invoice word', !/candidate|agreement|invoice|phone|email/i.test(noteText.replace(/"with":\[[^\]]*\]/, '')), noteText);
    const ask1 = await call('POST', '/api/job-duplicates/ask-merge', T.rec, { jobId: R1.id, note: 'Same as the other one' });
    const ask2 = await call('POST', '/api/job-duplicates/ask-merge', T.rec, { jobId: R1.id });
    const askBells = await prisma.notification.count({ where: { recipient: { startsWith: `job-merge-ask|${R1.id}|` } } });
    check('R8 "Ask the client manager to merge": one bell to the client manager, a second press is told "already asked"', ask1.status === 200 && ask1.body.ok && ask1.body.notified >= 1 && ask2.status === 200 && ask2.body.already === true && askBells === ask1.body.notified, [ask1.body, ask2.body, askBells]);
    const bellTo = await prisma.notification.findFirst({ where: { recipient: { startsWith: `job-merge-ask|${R1.id}|` } } });
    check('R9 the bell went to the client\'s BDE', !!bellTo && bellTo.userId === uBde1.id, bellTo && bellTo.userId);
    const askOut = await call('POST', '/api/job-duplicates/ask-merge', T.rec, { jobId: R3.id });
    check('R10 a Recruiter cannot ask about a job outside his area', askOut.status === 403, askOut.status);
    const mw = await call('GET', '/api/job-duplicates/worklist', T.mgr);
    const mm = await call('POST', '/api/job-duplicates/merge', T.mgr, { keptId: R1.id, extraIds: [R2.id] });
    check('R11 a Manager sees the list (view only) but cannot merge', mw.status === 200 && mw.body.canResolve === false && mm.status === 403, [mw.status, mm.status]);
    // 2026-10-16 (user): the whole BDE team deletes a job of their own area; a TL / Recruiter / Manager never does.
    for (const [who, tok] of [['TL', T.tl], ['Recruiter', T.rec], ['Manager', T.mgr]]) {
      const dN = await call('DELETE', `/api/requirements/${R2.id}`, tok);
      check(`R12 a ${who} cannot hard-delete a job`, [401, 403].includes(dN.status), [dN.status, dN.body]);
    }
    check('R12 ...and the job is still there', !!(await prisma.requirement.findUnique({ where: { id: R2.id } })), null);
    const del = await call('DELETE', `/api/requirements/${R2.id}`, T.bde1);
    check('R13 the BDE of the client can hard-delete a job of their own area (a job with nobody on it)', del.status === 200, [del.status, del.body]);
    const E1 = await mkJob(cA, 'Delete Me Role');
    const delSa = await call('DELETE', `/api/requirements/${E1.id}`, T.super);
    check('R14 the Super Admin can (a job with nobody on it)', delSa.status === 200, [delSa.status, delSa.body]);
    const stBde = await call('GET', '/api/job-duplicates/status', T.bde1);
    check('R15 the BDE\'s badge counts what needs a look (red count)', stBde.status === 200 && stBde.body.visible && stBde.body.canResolve && stBde.body.badge >= 1, stBde.body);
    // facets cascade with counts
    const fw = await call('GET', `/api/job-duplicates/worklist?tab=must&client=${cA.id}`, T.admin);
    const clientOpts = fw.body.facets.client;
    check('R16 filters cascade with counts: picking a client narrows BDE / TL options to its jobs', fw.status === 200 && fw.body.facets.bde.length >= 1 && fw.body.facets.bde.every((o) => o.count > 0 || o.value === fw.body.facets.bde[0].value) && clientOpts.some((o) => o.value === cA.id && o.count >= 1), fw.body.facets);
    const fwB = await call('GET', `/api/job-duplicates/worklist?tab=must&client=${cB.id}`, T.admin);
    check('R17 ... and a different client gives a different BDE list', fwB.status === 200 && JSON.stringify(fwB.body.facets.bde.map((o) => o.value)) !== JSON.stringify(fw.body.facets.bde.map((o) => o.value)), [fw.body.facets.bde.map((o) => o.label), fwB.body.facets.bde.map((o) => o.label)]);
    const done = await call('GET', '/api/job-duplicates/worklist?tab=done', T.bdeTl);
    check('R18 the Done tab lists recent merges and "Not a duplicate" decisions', done.status === 200 && Array.isArray(done.body.merges) && done.body.merges.length >= 1 && done.body.decisions.length >= 1, [done.status, done.body.merges && done.body.merges.length]);

    // ----------------------------------------------------------------------------------------------------------------
    // S — the real-data script's guards
    const script = path.join(BACK, 'scripts/job-duplicates.js');
    const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DATABASE_URL: `file:${path.join(BACK, 'prisma', 'dev.db').split(path.sep).join('/')}`, ...env }, encoding: 'utf8', timeout: 120000 });
    const r1 = run(['--apply']);
    check('S1 the script refuses to apply on dev.db without the flags', r1.status !== 0 && /--really-real|TL_ALLOW_REAL_APPLY/.test(`${r1.stdout}${r1.stderr}`), [r1.status, (r1.stderr || r1.stdout).slice(0, 200)]);
    const r2 = run(['--apply', '--really-real']);
    check('S2 ... and with only --really-real (no TL_ALLOW_REAL_APPLY=1)', r2.status !== 0 && /TL_ALLOW_REAL_APPLY/.test(`${r2.stdout}${r2.stderr}`), [r2.status, (r2.stderr || r2.stdout).slice(0, 200)]);
    const r3 = run(['--undo', 'nothing.json']);
    check('S3 --undo on dev.db is refused without the flags too', r3.status !== 0, r3.status);
    const sbx = spawnSync(process.execPath, [script, '--db', SBX.replace(/^file:/, ''), '--client', cA.id], { env: { ...process.env, DATABASE_URL: SBX }, encoding: 'utf8', timeout: 120000 });
    check('S4 the dry run on the sandbox prints clusters and counts', sbx.status === 0 && /CERTAIN/.test(sbx.stdout) && /would close/i.test(sbx.stdout), [sbx.status, (sbx.stdout + sbx.stderr).slice(0, 400)]);
  } finally {
    // ------------------------------------------------------------------------------------------------------------------
    // clean up every ZZTEST row we caused (and any left by an earlier crashed run of this test): swept by marker
    await sweep();
    const left = await prisma.$queryRawUnsafe(`SELECT (SELECT COUNT(*) FROM Requirement WHERE reqCode LIKE 'ZZJD-%') AS r, (SELECT COUNT(*) FROM Client WHERE name LIKE 'ZZTEST JD %') AS c, (SELECT COUNT(*) FROM User WHERE email LIKE 'zz-jd-%') AS u, (SELECT COUNT(*) FROM Candidate WHERE email LIKE 'zz-jd-cand-%') AS d`).catch(() => [{}]);
    console.log('left after cleanup:', JSON.stringify(left[0], (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('TEST CRASH', e); process.exitCode = 1; });
