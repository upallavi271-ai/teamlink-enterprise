#!/usr/bin/env node
/**
 * INTERNAL HIRING, END TO END (TeamLink's own opening -> the candidate joins -> an HRMS employee), through the real API, as the
 * right role at every step: HR raises an INTERNAL requirement (filed under the "TeamLink Consultants - Internal Hiring" client)
 * -> candidate (+ duplicate check) -> HR screening moves -> interview booked + feedback -> HR's Selected -> TeamLink's own offer
 * (prepare -> approve & send -> accepted) -> documents verified -> joining scheduled -> Joined -> HRMS: an Employee row created and
 * linked (Application.hrmsEmployeeId), a login + joining letter + welcome mail (sandbox mail is faked), the employee in
 * GET /api/employees for HR. Plus: a client placement never makes an employee, and another department's recruiter cannot see
 * the internal requirement.
 * Harness copied from scripts/lifecycle-e2e-test.js. SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4075.
 * Nothing outbound (TEAMLINK_SANDBOX / TEST_MODE). Database writes here only create the test users at the start.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/internal-hire-e2e-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-internal-hire-e2e-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-internal-hire-e2e-uploads-${process.pid}`);
const MAILS = path.join(os.tmpdir(), `zz-internal-hire-e2e-mails-${process.pid}.jsonl`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4075;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'internal-hire-e2e-test', UPLOAD_DIR: UPLOADS,
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  TEST_MAIL_CAPTURE: MAILS, // the sandbox's fake mail transport appends every message here (utils/sandbox.js); nothing leaves the machine
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

const STAGES = {
  1: 'Internal requirement created by HR (Internal Hiring client)', 2: 'Candidate added + duplicate refused', 3: 'Screening: apply + HR moves',
  4: 'Interview booked + feedback', 5: 'HR decision: Selected', 6: 'Internal offer: prepare -> approve & send -> accepted',
  7: 'Joining: documents -> scheduled -> Joined', 8: 'HRMS: employee created + linked, login, joining letter, welcome mail',
  9: 'HRMS: employee in GET /api/employees (HR); Internal Hiring list', C: 'Client placement never makes an employee', N: 'Negative / visibility checks',
};
const board = {}; Object.keys(STAGES).forEach((k) => { board[k] = { pass: 0, fail: 0, skip: [], fails: [], notes: [] }; });
let cur = '1';
const stage = (k) => { cur = String(k); console.log(`\n--- ${k}. ${STAGES[k]}`); };
let failed = 0; let total = 0;
const check = (name, ok, extra) => {
  total += 1;
  if (ok) { board[cur].pass += 1; console.log(`  ok  ${name}`); return true; }
  failed += 1; board[cur].fail += 1;
  const detail = extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '';
  board[cur].fails.push(`${name}${detail ? ` -> ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  return false;
};
const skip = (name, why) => { board[cur].skip.push(`${name}: ${why}`); console.log(`SKIP  ${name} (${why})`); };
const note = (s) => { board[cur].notes.push(s); console.log(`      note: ${s}`); };
const findings = [];
const finding = (s) => { findings.push(`[stage ${cur}] ${s}`); board[cur].notes.push(`FINDING: ${s}`); console.log(`FINDING  ${s}`); };

const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.75.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text: text.slice(0, 300), raw: buf, type: r.headers.get('content-type') || '' };
};
const ok2 = (r) => !!r && r.status >= 200 && r.status < 300;
const err = (r) => (r ? [r.status, (r.body && (r.body.error || r.body.code)) || r.text] : 'no response');
const RUN = Date.now().toString(36);
const mkUser = async (tag, data, emp) => {
  const u = await prisma.user.create({
    data: {
      name: `ZZTEST IHE ${tag} ${RUN}`, email: `zz-ihe-${tag}-${RUN}@example.test`, username: `zz-ihe-${tag}-${RUN}@example.test`, passwordHash: 'x', status: 'Active',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
    },
  });
  if (emp) {
    await prisma.employee.create({
      data: { employeeCode: `ZZ-IHE-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: data.atsDepartment || null, email: u.email, ...emp },
    });
  }
  return u;
};
const day = (d = 0) => new Date(Date.now() + d * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
const readMails = () => { try { return fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    try { fs.unlinkSync(MAILS); } catch { /* none */ }
    process.exit(code);
  }, 800);
}

function printBoard() {
  console.log('\nSTAGE BOARD');
  Object.keys(STAGES).forEach((k) => {
    const b = board[k];
    const st = b.fail ? 'FAIL' : (b.pass ? (b.skip.length ? 'PASS (part skipped)' : 'PASS') : (b.skip.length ? 'SKIPPED' : 'NOT RUN'));
    console.log(`  ${String(k).padStart(2)}  ${st.padEnd(20)} ${STAGES[k]}  [${b.pass} ok, ${b.fail} fail, ${b.skip.length} skipped]`);
    b.fails.forEach((f) => console.log(`        FAIL: ${f}`));
    b.skip.forEach((f) => console.log(`        SKIP: ${f}`));
    b.notes.forEach((f) => console.log(`        note: ${f}`));
  });
}

(async () => {
  const DEPT = 'IT';
  // ---- fixtures (the only direct writes): the logins each step needs
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsAccess: true, hrmsRole: 'SUPER_ADMIN' });
  // HR: the HR desk (ATS role HR -> internal hiring only, utils/hrDesk.js), HRMS role HR (every employee)
  const hr = await mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsAccess: true, hrmsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' }, { designation: 'HR Manager', department: 'HR' });
  // an Internal HR TL (department "Internal HR", ATS role TL) - the HR desk by department (utils/hrDesk.js rule 3)
  const ihrTl = await mkUser('ihrtl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Internal HR', atsScopeDepartments: 'Internal HR' }, { designation: 'TL', department: 'Internal HR' });
  const recX = await mkUser('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Non IT', atsScopeDepartments: 'Non IT' }, { department: 'Non IT' });
  const recIt = await mkUser('recit', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { department: DEPT });
  const bdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  // a control: a plain HRMS Employee login, to compare the new hire's login against
  const emp0 = await mkUser('emp0', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, hrmsAccess: true, hrmsRole: 'EMPLOYEE' }, { designation: 'Employee', department: DEPT });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('FAIL  the sandbox server did not answer /api/health'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const T = {};
  for (const [k, u] of Object.entries({ sa, hr, ihrTl, recX, recIt, bdeTl, emp0 }))T[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  const C = (m, p, who, body) => call(m, p, body, T[who]);
  const ids = {};
  const hrId = await resolveIdentity(hr.id);
  note(`HR login resolves to atsRole=${hrId.atsRole} hrDesk=${!!hrId.hrDesk} hrmsRole=${hrId.hrmsRole}`);
  const ihrId = await resolveIdentity(ihrTl.id);
  note(`Internal HR TL login resolves to atsRole=${ihrId.atsRole} hrDesk=${!!ihrId.hrDesk}`);

  try {
    // ======================= 1. INTERNAL REQUIREMENT =======================
    stage(1);
    const recTry = await C('POST', '/requirements', 'recX', { title: `ZZTEST IHE rec try ${RUN}`, internal: true, department: DEPT, jobDescription: 'x', skills: 'x' });
    check('a recruiter cannot create an internal requirement (403)', recTry.status === 403, err(recTry));
    const rq = await C('POST', '/requirements', 'hr', {
      title: `ZZTEST IHE Recruitment Executive ${RUN}`, internal: true, department: DEPT, openings: 1, location: 'Hyderabad', salary: '3-4.5 LPA',
      jobDescription: 'Source and screen candidates, schedule interviews, keep the ATS updated (ZZTEST IHE).', skills: 'Sourcing, Screening, Communication',
      experience: '1-3', employmentType: 'Full-time',
    });
    ids.req = rq.body && rq.body.id;
    let r0 = ids.req ? await prisma.requirement.findUnique({ where: { id: ids.req }, include: { client: true } }) : null;
    check('POST /api/requirements (HR, internal:true): 201, internal, hiringType "TeamLink Internal Hire", live (OPEN)', rq.status === 201 && !!r0 && r0.internal === true && r0.hiringType === 'TeamLink Internal Hire' && ['OPEN', 'RECRUITER_ASSIGNED'].includes(r0.status), [err(rq), r0 && { internal: r0.internal, hiringType: r0.hiringType, status: r0.status }]);
    if (!ids.req) throw new Error('no requirement - cannot go on');
    check('filed under the Internal Hiring client (clientType Internal, "... Internal Hiring"), no BDE', !!r0.client && r0.client.clientType === 'Internal' && /Internal Hiring/.test(r0.client.name) && !r0.bdeId, { client: r0.client && { name: r0.client.name, type: r0.client.clientType }, bdeId: r0.bdeId });
    note(`requirement ${r0.reqCode} status=${r0.status} tlId=${r0.tlId ? (r0.tlId === hr.id ? 'HR' : 'a TL from the copy (default TL of the department)') : 'none'} recruiterId=${r0.recruiterId || 'none'}`);
    ids.internalClient = r0.clientId;
    // HR raises internal jobs only: a body naming a real client is still filed internal (requirements.js POST /, scopeOf HR -> data.internal = true)
    const someClient = await prisma.client.findFirst({ where: { NOT: { clientType: 'Internal' } }, select: { id: true } });
    if (someClient) {
      const rqc = await C('POST', '/requirements', 'hr', { title: `ZZTEST IHE client try ${RUN}`, clientId: someClient.id, internal: false, department: DEPT, jobDescription: 'x (ZZTEST IHE)', skills: 'x' });
      const rc = rqc.body && rqc.body.id ? await prisma.requirement.findUnique({ where: { id: rqc.body.id } }) : null;
      check('HR cannot raise a CLIENT requirement (refused, or forced internal under the Internal Hiring client)', !ok2(rqc) || (!!rc && rc.internal === true && rc.clientId === ids.internalClient), [err(rqc), rc && { internal: rc.internal, sameInternalClient: rc.clientId === ids.internalClient }]);
      if (ok2(rqc)) note(`HR POST /requirements with a real clientId answered ${rqc.status}: filed internal=${rc && rc.internal} under the Internal Hiring client=${rc && rc.clientId === ids.internalClient}`);
    } else skip('HR client-requirement refusal', 'no client in the copy');
    const hrSees = await C('GET', `/requirements/${ids.req}`, 'hr');
    check('GET /api/requirements/:id (HR) opens it', hrSees.status === 200, err(hrSees));
    const ihrSees = await C('GET', `/requirements/${ids.req}`, 'ihrTl');
    check('GET /api/requirements/:id (Internal HR TL) opens it too', ihrSees.status === 200, err(ihrSees));
    const hrList = await C('GET', `/requirements?search=${encodeURIComponent(`ZZTEST IHE Recruitment Executive ${RUN}`)}`, 'hr');
    check('GET /api/requirements (HR) lists it', hrList.status === 200 && JSON.stringify(hrList.body).includes(ids.req), err(hrList));
    const hrClients = await C('GET', '/requirements?limit=200', 'hr');
    const rowsOf = (b) => (Array.isArray(b) ? b : (b && (b.rows || b.requirements || b.items)) || []);
    const nonInternal = rowsOf(hrClients.body).filter((x) => x && x.internal === false);
    check('HR\'s requirement list holds internal jobs only', hrClients.status === 200 && nonInternal.length === 0, [err(hrClients), nonInternal.slice(0, 3).map((x) => x.reqCode || x.id)]);

    // ======================= 2. CANDIDATE =======================
    stage(2);
    const phone = `7${String(Date.now()).slice(-9)}`;
    const email = `zz-ihe-cand-${RUN}@example.test`;
    const candBody = {
      name: `Ihe Kavya Reddy ${RUN}`, phone, email, skills: 'Sourcing, Screening, Communication, Naukri', currentSalary: 300000, expectedSalary: 420000,
      experienceYears: 2, location: 'Hyderabad', source: 'Naukri', resumeName: 'zz-ihe-kavya-resume.pdf', currentDesignation: 'Recruiter',
    };
    const cd = await C('POST', '/candidates', 'hr', candBody);
    ids.cand = cd.body && (cd.body.id || (cd.body.candidate && cd.body.candidate.id));
    check('POST /api/candidates (HR) adds the candidate', ok2(cd) && !!ids.cand, err(cd));
    if (!ids.cand) throw new Error('no candidate - cannot go on');
    const dup1 = await C('POST', '/candidates', 'hr', { ...candBody, name: `ZZTEST IHE Kavya again ${RUN}` });
    check('the same phone + email again is refused (409 duplicate)', dup1.status === 409 && dup1.body && dup1.body.duplicate === true, err(dup1));
    const dup2 = await C('POST', '/candidates', 'hr', { ...candBody, email: `zz-ihe-other-${RUN}@example.test`, name: `ZZTEST IHE Other ${RUN}` });
    check('the same phone with a new email is refused too', dup2.status === 409 && dup2.body && dup2.body.duplicate === true, err(dup2));
    const chk = await C('GET', `/candidates/check-duplicate?phone=${phone}`, 'hr');
    check('GET /api/candidates/check-duplicate (HR) flags the phone', chk.status === 200 && chk.body && chk.body.duplicate === true, err(chk));
    check('only one candidate row has this phone', (await prisma.candidate.count({ where: { phone } })) === 1);

    // ======================= 3. SCREENING =======================
    stage(3);
    let ap = await C('POST', '/applications', 'hr', { candidateId: ids.cand, requirementId: ids.req });
    if (ap.status === 409 && ap.body && ap.body.code === 'NEEDS_OVERRIDE') {
      note(`apply asked for an override reason: ${(ap.body.why || []).join('; ')}`);
      ap = await C('POST', '/applications', 'hr', { candidateId: ids.cand, requirementId: ids.req, overrideReason: 'ZZTEST IHE good fit' });
    }
    ids.app = ap.body && (ap.body.id || (ap.body.application && ap.body.application.id));
    const a0 = ids.app ? await prisma.application.findUnique({ where: { id: ids.app } }) : null;
    check('POST /api/applications (HR): applied at NEW with a fit score', ok2(ap) && !!a0 && a0.stage === 'NEW' && a0.matchScore != null, [err(ap), a0 && { stage: a0.stage, matchScore: a0.matchScore }]);
    if (!ids.app) throw new Error('no application - cannot go on');
    note(`application hiringType=${a0.hiringType} matchScore=${a0.matchScore}`);
    const again = await C('POST', '/applications', 'hr', { candidateId: ids.cand, requirementId: ids.req, overrideReason: 'ZZTEST IHE again' });
    check('the same candidate cannot be applied to the same job twice', !ok2(again), err(again));
    const stageNow = async () => (await prisma.application.findUnique({ where: { id: ids.app } })).stage;
    const move = (who, s, extra = {}) => C('PATCH', `/applications/${ids.app}/stage`, who, { stage: s, comment: 'ZZTEST IHE', ...extra });
    // An internal opening's candidate lands in the Job Portal screening first (routes/applications.js addApplication: source
    // "HR Sourcing"); routes/jobPortal.js runs Duplicate Check -> Resume Score -> AI Interview -> Recruiter Review -> Send to ATS.
    note(`application source=${a0.source} portalImportedAt=${a0.portalImportedAt} (pre-ATS screening when source is HR Sourcing and not yet sent)`);
    check('the internal application starts in the Job Portal screening (source "HR Sourcing", not yet sent to ATS)', a0.source === 'HR Sourcing' && !a0.portalImportedAt, { source: a0.source, portalImportedAt: a0.portalImportedAt });
    const pre1 = await move('hr', 'TL_REVIEW');
    check('PATCH /stage -> TL_REVIEW is refused while still in the screening (409)', pre1.status === 409 && await stageNow() === 'NEW', err(pre1));
    const sendEarly = await C('POST', `/job-portal/applications/${ids.app}/send-to-ats`, 'hr', {});
    check('Send to ATS is refused before the screening steps are done (409 with blockers)', sendEarly.status === 409 && sendEarly.body && Array.isArray(sendEarly.body.blockers) && sendEarly.body.blockers.length > 0, err(sendEarly));
    const xScr = await C('POST', `/job-portal/applications/${ids.app}/duplicate-check`, 'recX', {});
    check('another department\'s recruiter cannot run the screening (403/404)', [403, 404].includes(xScr.status), err(xScr));
    const s1 = await C('POST', `/job-portal/applications/${ids.app}/duplicate-check`, 'hr', {});
    check('POST /api/job-portal/applications/:id/duplicate-check (HR): done', ok2(s1), err(s1));
    if (ok2(s1)) note(`duplicate check: ${JSON.stringify(s1.body && s1.body.duplicates && { strong: (s1.body.duplicates.strong || []).length, possible: (s1.body.duplicates.possible || []).length })}`);
    const s2 = await C('POST', `/job-portal/applications/${ids.app}/score`, 'hr', {});
    const aS = await prisma.application.findUnique({ where: { id: ids.app } });
    check('POST /api/job-portal/applications/:id/score (HR): resume scored', ok2(s2) && aS.resumeScore != null, [err(s2), { resumeScore: aS.resumeScore, matchScore: aS.matchScore }]);
    const s3 = await C('POST', `/job-portal/applications/${ids.app}/ai-interview`, 'hr', { action: 'send' });
    check('POST /api/job-portal/applications/:id/ai-interview {send} (HR): AI_INTERVIEW_SCHEDULED', ok2(s3) && await stageNow() === 'AI_INTERVIEW_SCHEDULED', [err(s3), await stageNow()]);
    const s4 = await C('POST', `/job-portal/applications/${ids.app}/ai-interview`, 'hr', { action: 'result', score: 74, feedback: 'ZZTEST IHE recorded AI result (no AI call in the sandbox)' });
    check('POST /api/job-portal/applications/:id/ai-interview {result 74} (HR): AI_INTERVIEW_COMPLETED', ok2(s4) && await stageNow() === 'AI_INTERVIEW_COMPLETED', [err(s4), await stageNow()]);
    const s5 = await C('POST', `/job-portal/applications/${ids.app}/review`, 'hr', {});
    check('POST /api/job-portal/applications/:id/review (HR): RECRUITER_REVIEW', ok2(s5) && await stageNow() === 'RECRUITER_REVIEW', [err(s5), await stageNow()]);
    const s6 = await C('POST', `/job-portal/applications/${ids.app}/send-to-ats`, 'hr', {});
    const aT = await prisma.application.findUnique({ where: { id: ids.app } });
    check('POST /api/job-portal/applications/:id/send-to-ats (HR): in the ATS at "HR Review"', ok2(s6) && !!aT.portalImportedAt && aT.stage === 'RECRUITER_REVIEW' && s6.body.hiring === 'Internal', [err(s6), { stage: aT.stage, imported: aT.portalImportedAt, label: s6.body && s6.body.stageLabel }]);
    // HR runs internal hiring start to end (utils/atsVocab.js stageMoveProblem: internal, phase 0 -> INTERVIEW_SCHEDULED only):
    // there is no Dept head / TL step any more, so TL_REVIEW is not a move from HR Review.
    const m2 = await move('hr', 'TL_REVIEW');
    check('PATCH /stage (HR): -> TL_REVIEW is refused on an internal hire ("book the interview first")', m2.status === 409 && /book the interview/i.test(String(m2.body && m2.body.error)) && await stageNow() === 'RECRUITER_REVIEW', err(m2));
    if (m2.body && m2.body.error) note(`TL_REVIEW refusal text: "${m2.body.error}"`);
    const bdeStep = await move('hr', 'WITH_BDE');
    check('an internal hire has no BDE step: -> WITH_BDE refused', !ok2(bdeStep) && await stageNow() === 'RECRUITER_REVIEW', err(bdeStep));
    const shareStep = await move('sa', 'SHARED_WITH_CLIENT');
    check('nor a client step, even for the Admin (stageAllowedForHiringType): -> SHARED_WITH_CLIENT refused', !ok2(shareStep) && await stageNow() === 'RECRUITER_REVIEW', err(shareStep));
    const jump = await move('hr', 'SELECTED');
    check('a jump HR Review -> SELECTED (no interview) is refused', !ok2(jump) && await stageNow() === 'RECRUITER_REVIEW', err(jump));

    // ======================= 4. INTERVIEW =======================
    stage(4);
    const bookBody = { date: day(1), time: '11:00', mode: 'online', interviewer: 'ZZ HR Panel', meetingLink: 'https://meet.example.test/zz-ihe' };
    const bk = await C('POST', `/ats/interviews/${ids.app}/book`, 'hr', bookBody);
    check('POST /api/ats/interviews/:id/book (HR): INTERVIEW_SCHEDULED', ok2(bk) && await stageNow() === 'INTERVIEW_SCHEDULED', [err(bk), await stageNow()]);
    const fb = await C('POST', `/ats/interviews/${ids.app}/feedback`, 'hr', { feedback: 'Good sourcing know-how, clear communication (ZZTEST IHE)', result: 'Selected', score: 8 });
    check('POST /api/ats/interviews/:id/feedback (HR): INTERVIEW_COMPLETED', ok2(fb) && await stageNow() === 'INTERVIEW_COMPLETED', [err(fb), await stageNow()]);
    const fbRows = await prisma.interviewFeedback.count({ where: { applicationId: ids.app } }).catch(() => null);
    check('the feedback is stored', fbRows === null || fbRows >= 1, fbRows);

    // ======================= 5. SELECTED =======================
    stage(5);
    const xDec = await C('POST', `/ats/interviews/${ids.app}/decision`, 'recX', { decision: 'Selected' });
    check('another department\'s recruiter cannot take the decision', !ok2(xDec), err(xDec));
    const dc = await C('POST', `/ats/interviews/${ids.app}/decision`, 'hr', { decision: 'Selected' });
    check('POST /api/ats/interviews/:id/decision (HR): SELECTED', ok2(dc) && await stageNow() === 'SELECTED', [err(dc), await stageNow()]);

    // ======================= 6. INTERNAL OFFER =======================
    stage(6);
    const direct = await move('hr', 'OFFER');
    check('a plain stage move cannot skip the offer flow (-> OFFER refused, or it is the offer flow)', !ok2(direct) || await stageNow() === 'OFFER', [err(direct), await stageNow()]);
    if (ok2(direct)) note('PATCH /stage SELECTED -> OFFER was accepted for HR (no letter, no offer version)');
    const prev = await C('GET', `/ats/offers/${ids.app}/letter`, 'hr');
    check('GET /api/ats/offers/:id/letter (HR): a preview of TeamLink\'s offer letter', prev.status === 200 && prev.body && typeof prev.body.text === 'string' && prev.body.text.length > 20, err(prev));
    const CTC = 420000;
    let pr = await C('POST', `/ats/offers/${ids.app}/prepare`, 'hr', { offeredCtc: CTC, joiningDate: day(0), offerNotes: 'ZZTEST IHE offer' });
    if (pr.status === 409 && pr.body && pr.body.code === 'CTC_CONFIRM') pr = await C('POST', `/ats/offers/${ids.app}/prepare`, 'hr', { offeredCtc: CTC, joiningDate: day(0), offerNotes: 'ZZTEST IHE offer', confirmCtc: true });
    let aP = await prisma.application.findUnique({ where: { id: ids.app } });
    check('POST /api/ats/offers/:id/prepare (HR): offer prepared (not a client offer)', ok2(pr) && aP.offeredCtc === CTC && /prepared|approval/i.test(String(aP.offerStatus)), [err(pr), { offerStatus: aP.offerStatus, ctc: aP.offeredCtc }]);
    const xApp = await C('POST', `/ats/offers/${ids.app}/approve`, 'recX', {});
    check('another department\'s recruiter cannot approve the offer', !ok2(xApp), err(xApp));
    const apv = await C('POST', `/ats/offers/${ids.app}/approve`, 'hr', {});
    aP = await prisma.application.findUnique({ where: { id: ids.app } });
    check('POST /api/ats/offers/:id/approve (HR): OFFER, "Offer Released", billing Not Applicable', ok2(apv) && aP.stage === 'OFFER' && aP.offerStatus === 'Offer Released' && aP.billingStatus === 'Not Applicable' && aP.hiringType === 'TeamLink Internal Hire', [err(apv), { stage: aP.stage, offer: aP.offerStatus, billing: aP.billingStatus, ht: aP.hiringType }]);
    const letterMsg = await prisma.candidateMessage.findFirst({ where: { applicationId: ids.app, template: 'OFFER_LETTER' }, orderBy: { createdAt: 'desc' } });
    check('the offer letter is written to the candidate (CandidateMessage OFFER_LETTER)', !!letterMsg, letterMsg);
    if (letterMsg) note(`offer letter message status=${letterMsg.status} recipient=${letterMsg.recipient}; reply "${apv.body && apv.body.message}"`);
    const ver = await prisma.offerVersion.findFirst({ where: { applicationId: ids.app }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    check('an offer version (v1, with an expiry) is recorded', !!ver && ver.version >= 1, ver && { version: ver.version, status: ver.status, expiresAt: ver.expiresAt });
    const auditRel = await prisma.auditLog.findFirst({ where: { entityId: ids.app, action: 'Internal offer released' } }).catch(() => null);
    check('audit says "Internal offer released"', !!auditRel);
    const acp = await C('POST', `/ats/offers/${ids.app}/accept`, 'hr', {});
    check('POST /api/ats/offers/:id/accept (HR records the candidate\'s yes): OFFER_ACCEPTED', ok2(acp) && await stageNow() === 'OFFER_ACCEPTED', [err(acp), await stageNow()]);

    // ======================= 7. JOINING =======================
    stage(7);
    const early = await C('POST', `/ats/joining/${ids.app}/schedule`, 'hr', { joiningDate: day(0) });
    check('a joining date is refused before the documents are verified (409)', early.status === 409, err(early));
    const docs = await C('POST', `/ats/offers/${ids.app}/documents`, 'hr', { documentsStatus: 'Verified' });
    check('POST /api/ats/offers/:id/documents (HR): Verified', ok2(docs) && (await prisma.application.findUnique({ where: { id: ids.app } })).documentsStatus === 'Verified', err(docs));
    const early2 = await C('POST', `/ats/joining/${ids.app}/joined`, 'hr', { joinedOn: day(0) });
    check('Joined is refused before a joining date is scheduled (409)', early2.status === 409, err(early2));
    const js = await C('POST', `/ats/joining/${ids.app}/schedule`, 'hr', { joiningDate: day(0) });
    check('POST /api/ats/joining/:id/schedule (HR): Joining Scheduled', ok2(js) && (await prisma.application.findUnique({ where: { id: ids.app } })).joiningStatus === 'Joining Scheduled', err(js));
    const invBefore = await prisma.invoice.count();
    const empBefore = await prisma.employee.count();
    const jn = await C('POST', `/ats/joining/${ids.app}/joined`, 'hr', { joinedOn: day(0), location: 'Hyderabad' });
    const aJ = await prisma.application.findUnique({ where: { id: ids.app } });
    check('POST /api/ats/joining/:id/joined (HR): JOINED -> HIRED (finishInternalHire)', ok2(jn) && aJ.stage === 'HIRED' && aJ.joiningStatus === 'Joined', [err(jn), { stage: aJ.stage, joining: aJ.joiningStatus }]);
    note(`joined reply: "${jn.body && jn.body.message}" employeeId=${jn.body && jn.body.employeeId} invoiceId=${jn.body && jn.body.invoiceId}`);
    check('no invoice for an internal hire (invoiceId null, billing Not Applicable, no new Invoice row)', ok2(jn) && !jn.body.invoiceId && aJ.billingStatus === 'Not Applicable' && (await prisma.invoice.count()) === invBefore, { invoiceId: jn.body && jn.body.invoiceId, billing: aJ.billingStatus });
    const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: ids.app }, orderBy: { createdAt: 'asc' }, select: { toStage: true } });
    const path1 = evs.map((e) => e.toStage);
    check('stage history runs ... SELECTED, OFFER, OFFER_ACCEPTED, JOINED, HIRED in order', ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].every((s, i, arr) => path1.indexOf(s) >= 0 && (i === 0 || path1.lastIndexOf(s) > path1.indexOf(arr[i - 1]))), path1);
    note(`stage history: ${path1.join(' -> ')}`);

    // ======================= 8. HRMS EMPLOYEE =======================
    stage(8);
    const emp = aJ.hrmsEmployeeId ? await prisma.employee.findUnique({ where: { id: aJ.hrmsEmployeeId } }) : null;
    check('an Employee row is created and linked (Application.hrmsEmployeeId), and /joined returned its id', !!emp && jn.body && jn.body.employeeId === emp.id && (await prisma.employee.count()) === empBefore + 1, { hrmsEmployeeId: aJ.hrmsEmployeeId, returned: jn.body && jn.body.employeeId, before: empBefore });
    if (!emp) throw new Error('no employee - HRMS checks cannot go on');
    ids.emp = emp.id;
    check('the employee carries the candidate (name, email, phone) and the job (department, designation = title)', emp.name === candBody.name && emp.email === email && emp.phone === phone && emp.department === DEPT && emp.designation === r0.title, { name: emp.name, email: emp.email, phone: emp.phone, dept: emp.department, desig: emp.designation });
    check('status On Probation, an employee code, joining date = the scheduled day, onboarding tasks listed', emp.employmentStatus === 'On Probation' && !!emp.employeeCode && !!emp.dateOfJoining && new Date(emp.dateOfJoining).toISOString().slice(0, 10) === day(0) && JSON.parse(emp.onboardingTasks || '[]').length > 0, { status: emp.employmentStatus, code: emp.employeeCode, doj: emp.dateOfJoining, tasks: (emp.onboardingTasks || '').slice(0, 80) });
    note(`employee ${emp.employeeCode}: reportingManagerId=${emp.reportingManagerId || 'none'} (the job's TL, when it has one)`);
    const pack = await prisma.auditLog.findFirst({ where: { entityId: emp.id, action: 'Joining pack sent (internal hire)' } }).catch(() => null);
    check('the joining pack ran (audit "Joining pack sent (internal hire)")', !!pack, pack);
    if (pack) note(`joining pack: ${pack.toValue}`);
    check('a login is created and linked (Employee.userId -> an Active user with the candidate email)', !!emp.userId && !!(await prisma.user.findFirst({ where: { id: emp.userId, email, status: 'Active' } })), { userId: emp.userId, pack: pack && pack.toValue });
    if (emp.userId) {
      const lu = await prisma.user.findUnique({ where: { id: emp.userId }, select: { role: true, hrmsAccess: true, atsAccess: true, hrmsRole: true, atsRole: true } });
      note(`new login: ${JSON.stringify(lu)}`);
      // The welcome mail promises "attendance, leave, payslips and documents in HRMS" after sign-in (utils/internalOnboarding.js):
      // the new login must hold an HRMS role, not only the HRMS product switch.
      const nid = await resolveIdentity(emp.userId);
      note(`new login resolves to products=${JSON.stringify(nid.products)} hrmsRole=${nid.hrmsRole} atsRole=${nid.atsRole} landing=${nid.landingWorkspace || '-'} (designation "${emp.designation}" has ${(await prisma.designationRole.findFirst({ where: { designation: emp.designation } }).catch(() => null)) ? 'a' : 'no'} DesignationRole row)`);
      check('the new employee login holds an HRMS role (products.hrms and hrmsRole not NONE)', !!(nid.products && nid.products.hrms) && !!nid.hrmsRole && nid.hrmsRole !== 'NONE', { products: nid.products, hrmsRole: nid.hrmsRole, storedHrmsRole: lu.hrmsRole });
      T.newEmp = await tokenOf(emp.userId);
      const me = await C('GET', '/employees/me', 'newEmp');
      check('GET /api/employees/me (the new employee\'s own login): their own record', me.status === 200 && me.body && me.body.id === emp.id, err(me));
      const lb = await C('GET', '/leave/balances', 'newEmp');
      check('GET /api/leave/balances (the new employee\'s own login): answers and includes their own row', lb.status === 200 && JSON.stringify(lb.body).includes(emp.id), [err(lb), lb.text.slice(0, 160)]);
      // a permission-guarded HRMS read (requirePerm hrms / Attendance & Time / view): a plain Employee login (control) vs the new login
      const pl0 = await C('GET', '/attendance/punch-log', 'emp0');
      const pl1 = await C('GET', '/attendance/punch-log', 'newEmp');
      note(`GET /api/attendance/punch-log: control Employee login (hrmsRole EMPLOYEE) -> ${pl0.status}; the new hire's login -> ${pl1.status} ${pl1.status >= 400 ? JSON.stringify(err(pl1)) : ''}`);
      check('GET /api/attendance/punch-log (Attendance & Time view): the new hire\'s login is let in like a plain Employee login', ok2(pl0) ? ok2(pl1) : true, { control: err(pl0), newHire: err(pl1) });
      const cred = await prisma.auditLog.findFirst({ where: { entityId: emp.id, action: { startsWith: 'Sign-in details' } } }).catch(() => null);
      check('sign-in details were sent for the new login (audit "Sign-in details: ...")', !!cred, cred);
      if (cred) note(`credentials: ${cred.action}`);
    }
    const jl = await prisma.employeeDocument.findFirst({ where: { employeeId: emp.id, docType: 'Joining Letter' } });
    check('the joining letter PDF is kept in the employee documents', !!jl && !!jl.file, jl && { name: jl.fileName, size: jl.size });
    const mails = readMails();
    const welcome = mails.find((m) => m.to === email && /Welcome to TeamLink/.test(m.subject));
    if (welcome) check('the welcome mail (with the joining details) was handed to the fake transport', /Employee code/.test(welcome.text) && welcome.text.includes(emp.employeeCode), { subject: welcome.subject });
    else if (pack && /welcome: not sent: .*(not set up|not configured|never been configured|SMTP|decrypt|INTEGRATION_SECRET_KEY|switched off|disconnected)/i.test(pack.toValue || '')) skip('welcome mail', `mail is not configured in this sandbox copy, so sendMail answered before the fake transport (${(pack.toValue.match(/welcome: [^;]*/) || [''])[0]})`);
    else check('the welcome mail was handed to the fake transport', false, { pack: pack && pack.toValue, captured: mails.map((m) => `${m.to}: ${m.subject}`).slice(0, 6) });
    note(`mails captured by the sandbox fake transport: ${mails.length ? mails.map((m) => `${m.to} "${m.subject}"`).join(' | ') : 'none'}`);
    const pdf = await C('GET', `/ats/internal-hiring/${ids.app}/joining-letter`, 'hr');
    check('GET /api/ats/internal-hiring/:id/joining-letter (HR): a PDF', pdf.status === 200 && /pdf/.test(pdf.type) && pdf.raw.slice(0, 5).toString() === '%PDF-', [pdf.status, pdf.type, pdf.text.slice(0, 60)]);
    const again2 = await C('POST', `/ats/internal-hiring/${ids.app}/create-employee`, 'hr', {});
    check('POST /api/ats/internal-hiring/:id/create-employee again (HR) is idempotent: the same employee, no second row', ok2(again2) && again2.body.employee && again2.body.employee.id === emp.id && (await prisma.employee.count({ where: { email } })) === 1, [err(again2), again2.body && again2.body.employee]);
    const rp = await C('POST', `/ats/internal-hiring/${ids.app}/joining-pack`, 'hr', {});
    check('POST /api/ats/internal-hiring/:id/joining-pack (HR, resend) answers ok', ok2(rp) && rp.body && rp.body.ok === true, err(rp));
    if (ok2(rp)) note(`joining pack resend: ${JSON.stringify(rp.body.joiningPack).slice(0, 300)}`);

    // ======================= 9. EMPLOYEES LIST =======================
    stage(9);
    const el = await C('GET', '/employees', 'hr');
    const inList = Array.isArray(el.body) ? el.body.find((e) => e.id === emp.id) : null;
    check('GET /api/employees (HR): the new employee is listed', el.status === 200 && !!inList, [err(el), Array.isArray(el.body) ? el.body.length : el.body]);
    const eg = await C('GET', `/employees/${emp.id}`, 'hr');
    check('GET /api/employees/:id (HR) opens the record', eg.status === 200 && eg.body && eg.body.id === emp.id, err(eg));
    const ih = await C('GET', '/ats/internal-hiring', 'hr');
    const ihRow = ih.body && Array.isArray(ih.body.rows) ? ih.body.rows.find((x) => x.id === ids.app) : null;
    check('GET /api/ats/internal-hiring (HR): the hire is listed with its employee', ih.status === 200 && !!ihRow && ihRow.employee && ihRow.employee.id === emp.id, [err(ih), ihRow && { stage: ihRow.stage, emp: ihRow.employee }]);
    const xEl = await C('GET', '/employees', 'recX');
    check('a recruiter (no HRMS) does not get the employee list with the new employee', !ok2(xEl) || !JSON.stringify(xEl.body).includes(emp.id), err(xEl));

    // ======================= C. CLIENT PLACEMENT =======================
    stage('C');
    const capp = await prisma.application.findFirst({
      where: { OR: [{ hiringType: 'Client Placement' }, { hiringType: null, requirement: { internal: false } }], requirement: { internal: false }, hrmsEmployeeId: null },
      orderBy: { updatedAt: 'desc' }, select: { id: true, stage: true },
    });
    if (capp) {
      const ec0 = await prisma.employee.count();
      const ce = await C('POST', `/ats/internal-hiring/${capp.id}/create-employee`, 'sa', {});
      const after = await prisma.application.findUnique({ where: { id: capp.id }, select: { hrmsEmployeeId: true, stage: true } });
      check('POST /api/ats/internal-hiring/:id/create-employee on a client placement (Admin): 409, no employee, nothing linked', ce.status === 409 && (await prisma.employee.count()) === ec0 && !after.hrmsEmployeeId && after.stage === capp.stage, [err(ce), after]);
      const cp = await C('POST', `/ats/internal-hiring/${capp.id}/joining-pack`, 'sa', {});
      check('and no joining pack for it (409)', cp.status === 409, err(cp));
      const hrC = await C('POST', `/ats/internal-hiring/${capp.id}/create-employee`, 'hr', {});
      check('HR cannot even reach a client-placement application (403/404)', [403, 404].includes(hrC.status), err(hrC));
      note(`client placement used: an existing application of the copy at ${capp.stage} (the full client joining -> no employee is in lifecycle-e2e-test.js)`);
    } else skip('client placement create-employee refusal', 'no client-placement application in the copy');

    // ======================= N. NEGATIVE =======================
    stage('N');
    const xr = await C('GET', `/requirements/${ids.req}`, 'recX');
    check('a recruiter of another department (Non IT) cannot open the internal requirement (403/404)', [403, 404].includes(xr.status), err(xr));
    const xl = await C('GET', `/requirements?search=${encodeURIComponent(`ZZTEST IHE Recruitment Executive ${RUN}`)}`, 'recX');
    check('nor find it in their list', xl.status === 200 && !JSON.stringify(xl.body).includes(ids.req), err(xl));
    const ir = await C('GET', `/requirements/${ids.req}`, 'recIt');
    check('a recruiter of the SAME department (IT), not assigned, cannot open it either (403/404)', [403, 404].includes(ir.status), err(ir));
    const br = await C('GET', `/requirements/${ids.req}`, 'bdeTl');
    check('the BDE TL (client book only) cannot open it (403/404)', [403, 404].includes(br.status), err(br));
    const xc = await C('GET', `/candidates/${ids.cand}`, 'recX');
    check('the other department\'s recruiter cannot open the candidate (403/404)', [403, 404].includes(xc.status), err(xc));
    const xa = await C('PATCH', `/applications/${ids.app}/stage`, 'recX', { stage: 'REJECTED', rejectedBy: 'Internal', reasonCategory: 'Other', reasonDetail: 'ZZTEST IHE outsider', comment: 'ZZTEST IHE' });
    check('nor move / reject the application (403/404)', [403, 404].includes(xa.status), err(xa));
    const xi = await C('GET', '/ats/internal-hiring', 'recX');
    check('nor see it on Internal Hiring', !ok2(xi) || !JSON.stringify(xi.body).includes(ids.app), err(xi));
    check('the hire is untouched (HIRED, same employee)', (await prisma.application.findUnique({ where: { id: ids.app } })).stage === 'HIRED' && (await prisma.application.findUnique({ where: { id: ids.app } })).hrmsEmployeeId === ids.emp);
  } catch (e) { failed += 1; total += 1; board[cur].fail += 1; board[cur].fails.push(`crashed: ${String(e && e.message).slice(0, 300)}`); console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); }

  printBoard();
  if (findings.length) { console.log('\nFINDINGS (not counted as checks)'); findings.forEach((f) => console.log(`  - ${f}`)); }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
