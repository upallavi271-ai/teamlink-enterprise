#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ASSIGNING A CANDIDATE TO A JOB (founder, 2026-10-16) - COPY DATABASE ONLY.
//
//   cd backend
//   COPY_DB=C:/tmp/app-copy.db node scripts/application-assign-test.js      (a VACUUM INTO copy; never prisma/dev.db)
//
// Starts its OWN throw-away API process (port 4095, TEST_MODE=1) on the copy and checks, through the real routes:
//   A  Each role that may add people to a job: created exactly once, 201, first step NEW, Fit stored, hiring type stored,
//      a stage-history row and an audit row naming the person who did it, the job's people (recruiter / TL) unchanged
//   B  Adding the same person to the same job again: 409 ALREADY_APPLIED with WHERE it is (job, client, step, date, who added,
//      link) and the person's applications on OTHER jobs
//   C  Privacy: what a client-manager (BDE) login is told has no phone, no email, no salary; no desk details either
//   D  Double submit / race: 6 identical calls at once -> one application, one history row, one audit row, the rest ALREADY_APPLIED
//   E  Roles that may NOT add: a Recruiter of another department, HR on a client job, a login without ATS, a CLIENT login
//   F  The pair check (GET /applications/pair-check): free / already there / job closed / Do not use / out of scope
//   G  The pickers: GET /candidates/picker (name, CAN code, phone tail, email; BDE = name and code only; onJob marked)
//      and the job page search now LISTS people already on the job (with where) instead of hiding them
//   H  Refusals keep their words: closed job, paused job, Do not use
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
const PORT = Number(process.env.TEST_PORT || 4095);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
const RUN = Date.now().toString(36);
const made = { users: [], emps: [], clients: [], reqs: [], cands: [] };

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  if (r.status >= 500) console.log('SERVER 5xx on', method, p, '->', serverLog.slice(-1200));
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
let serverLog = '';
const refused = (r) => [401, 403, 404].includes(r.status);

(async () => {
  let server;
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; serverLog += d; }); server.stderr.on('data', (d) => { log += d; serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST AAT ${tag} ${RUN}`, email: `zz-aat-${tag}-${RUN}@example.test`, username: `zz-aat-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-AAT-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const U = {};
    U.admin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    U.sa = await mk('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    U.bdeTl = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    U.bdeEdu = await mk('bdeedu', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: U.bdeTl.name });
    U.tlEdu = await mk('tledu', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    U.stlEdu = await mk('stledu', { role: 'EMPLOYEE', atsRole: 'STL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'STL' });
    U.recEdu = await mk('recedu', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    U.recMed = await mk('recmed', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    U.mgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'Manager' });
    U.am = await mk('am', { role: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'Assistant Manager' });
    U.hr = await mk('hr', { role: 'EMPLOYEE', atsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' }, {});
    U.noAts = await mk('noats', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: false, atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    U.client = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT' }, null);
    const T = {};
    for (const [k, u] of Object.entries(U)) T[k] = await tokenOf(u);

    const client = await prisma.client.create({ data: { name: `ZZTEST AAT Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: U.bdeEdu.name, clientType: 'Client', agreementStatus: 'ACTIVE', agreementSignedAt: new Date(), agreementActivatedAt: new Date() } });
    made.clients.push(client.id);
    const mkReq = async (tag, extra = {}) => {
      const r = await prisma.requirement.create({
        data: {
          title: `ZZTEST AAT Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', openings: 3, skills: 'Java',
          recruiterId: U.recEdu.id, tlId: U.tlEdu.id, tl: U.tlEdu.name, bdeId: U.bdeEdu.id, ...extra,
        },
      });
      made.reqs.push(r.id); return r;
    };
    const jobA = await mkReq('A');
    const jobB = await mkReq('B');
    const PHONE = '9000077001'; const SAL = 733221;
    let seq = 0;
    const mkCand = async (extra = {}) => {
      seq += 1;
      const c = await prisma.candidate.create({
        data: {
          name: `ZZTEST AAT Cand${seq} ${RUN}`, email: `zz-aat-c${seq}-${RUN}@example.test`, phone: `900007${String(7000 + seq).padStart(4, '0')}`, location: 'ZZ Town',
          skills: 'Java', experienceYears: 3, currentSalary: String(SAL), expectedSalary: String(SAL + 1), ...extra,
        },
      });
      made.cands.push(c.id); return c;
    };
    const rowsOf = (cid, rid) => prisma.application.findMany({ where: { candidateId: cid, requirementId: rid } });

    // ------------------------------------------------------------------ A: every role that may add
    const allowed = [['admin', 'Admin'], ['sa', 'Super Admin'], ['tlEdu', 'TL'], ['recEdu', 'Recruiter'], ['bdeTl', 'BDE team lead'], ['bdeEdu', 'BDE']];
    const before = await prisma.requirement.findUnique({ where: { id: jobA.id } });
    for (const [k, label] of allowed) {
      const c = await mkCand();
      const r = await http('POST', '/api/applications', T[k], { candidateId: c.id, requirementId: jobA.id });
      check(`A1 ${label}: adds a person to a job (201)`, r.status === 201 && r.body && r.body.id, r);
      const rows = await rowsOf(c.id, jobA.id);
      check(`A2 ${label}: exactly one application row`, rows.length === 1, rows.length);
      const a = rows[0];
      if (!a) continue;
      check(`A3 ${label}: first step is New, Fit stored, hiring type stored`, a.stage === 'NEW' && typeof a.matchScore === 'number' && a.hiringType === 'Client Placement' && a.source === 'ATS Match', a);
      const ev = await prisma.applicationStageEvent.findMany({ where: { applicationId: a.id } });
      check(`A4 ${label}: one stage-history row (none -> New) naming who did it`, ev.length === 1 && ev[0].fromStage === null && ev[0].toStage === 'NEW' && ev[0].actorUserId === U[k].id && ev[0].actorName === U[k].name, ev);
      const au = await prisma.auditLog.findMany({ where: { entity: 'Application', entityId: a.id } });
      check(`A5 ${label}: one audit row by that person`, au.length === 1 && au[0].userId === U[k].id && au[0].action === 'Candidate added to pipeline', au);
    }
    const after = await prisma.requirement.findUnique({ where: { id: jobA.id } });
    check('A6 the job\'s people are unchanged by adding (recruiter, TL, BDE)', before.recruiterId === after.recruiterId && before.tlId === after.tlId && before.bdeId === after.bdeId && before.tl === after.tl, after);
    const jobList = await http('GET', `/api/applications?requirementId=${jobA.id}`, T.recEdu);
    check('A7 the job\'s pipeline shows everyone added, straight away', jobList.status === 200 && Array.isArray(jobList.body) && jobList.body.filter((x) => x.candidate && /ZZTEST AAT/.test(x.candidate.name)).length >= allowed.length, jobList.body && jobList.body.length);

    // ------------------------------------------------------------------ B: the same person again
    const cDup = await mkCand();
    let r = await http('POST', '/api/applications', T.recEdu, { candidateId: cDup.id, requirementId: jobA.id });
    check('B0 first add works', r.status === 201, r);
    const firstApp = r.body;
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cDup.id, requirementId: jobA.id });
    check('B1 the second add is 409 ALREADY_APPLIED', r.status === 409 && r.body && r.body.code === 'ALREADY_APPLIED', r);
    const ap = r.body && r.body.application;
    check('B2 it says WHERE: job, client, step, added date, who added, recruiter, link', !!ap && ap.id === firstApp.id && ap.requirementId === jobA.id && ap.requirementTitle === jobA.title && ap.clientName === client.name && !!ap.step && /^\d{4}-\d{2}-\d{2}$/.test(ap.addedOnText) && ap.addedBy === U.recEdu.name && ap.recruiterName === U.recEdu.name && ap.link === `/candidates/${cDup.id}?application=${firstApp.id}`, ap);
    check('B3 the sentence names the person, the job, the client, the step and the date', !!r.body && r.body.error.includes(cDup.name) && r.body.error.includes(jobA.title) && r.body.error.includes(client.name) && r.body.error.includes(ap.step) && r.body.error.includes(ap.addedOnText), r.body && r.body.error);
    check('B4 still exactly one application row', (await rowsOf(cDup.id, jobA.id)).length === 1);
    // another requirement
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cDup.id, requirementId: jobB.id });
    check('B5 the same person on a DIFFERENT job is fine', r.status === 201, r);
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cDup.id, requirementId: jobA.id });
    check('B6 the box lists their application on the other job', r.status === 409 && r.body && Array.isArray(r.body.others) && r.body.others.length === 1 && r.body.others[0].requirementId === jobB.id && !!r.body.others[0].link, r.body);
    // a rejected application: shown with its state, no second row
    await prisma.application.update({ where: { id: firstApp.id }, data: { stage: 'REJECTED' } });
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cDup.id, requirementId: jobA.id });
    check('B7 a rejected application is shown with its state (Rejected), never duplicated', r.status === 409 && r.body && r.body.application.status === 'Rejected' && r.body.application.step === 'Rejected' && (await rowsOf(cDup.id, jobA.id)).length === 1, r.body);
    await prisma.application.update({ where: { id: firstApp.id }, data: { stage: 'NEW' } });

    // ------------------------------------------------------------------ C: privacy for the BDE team
    for (const k of ['bdeEdu', 'bdeTl']) {
      r = await http('POST', '/api/applications', T[k], { candidateId: cDup.id, requirementId: jobA.id });
      const leak = new RegExp(`${cDup.phone}|${cDup.email.replace(/[.+]/g, '\\$&')}|${SAL}|${SAL + 1}|"phone"|"email"|Salary`, 'i');
      check(`C1 ${k}: ALREADY_APPLIED has no phone, email or salary`, r.status === 409 && r.body && r.body.code === 'ALREADY_APPLIED' && !leak.test(r.text), r.text);
      check(`C2 ${k}: no recruiter / TL desk details (the application is not in their view yet)`, r.body && r.body.application && r.body.application.recruiterName === undefined && r.body.application.addedBy === undefined, r.body && r.body.application);
      check(`C3 ${k}: still gets job, client, step and the link`, r.body && r.body.application && r.body.application.requirementTitle === jobA.title && r.body.application.clientName === client.name && !!r.body.application.step && !!r.body.application.link, r.body && r.body.application);
    }
    r = await http('GET', `/api/applications/pair-check?candidateId=${cDup.id}&requirementId=${jobA.id}`, T.bdeEdu);
    check('C4 BDE pair-check: no phone, email or salary', r.status === 200 && r.body && r.body.exists === true && !new RegExp(`${cDup.phone}|${SAL}|"phone"|"email"`, 'i').test(r.text), r.text);

    // ------------------------------------------------------------------ D: double submit / race
    const cRace = await mkCand();
    const burst = await Promise.all(Array.from({ length: 6 }, () => http('POST', '/api/applications', T.recEdu, { candidateId: cRace.id, requirementId: jobA.id })));
    const created = burst.filter((x) => x.status === 201); const dups = burst.filter((x) => x.status === 409 && x.body && x.body.code === 'ALREADY_APPLIED');
    check('D1 six calls at once: exactly one 201, the rest ALREADY_APPLIED (no 500)', created.length === 1 && dups.length === 5, burst.map((x) => x.status));
    const raceRows = await rowsOf(cRace.id, jobA.id);
    check('D2 one application row', raceRows.length === 1, raceRows.length);
    if (raceRows[0]) {
      check('D3 one stage-history row and one audit row (no half-made leftovers)', (await prisma.applicationStageEvent.count({ where: { applicationId: raceRows[0].id } })) === 1 && (await prisma.auditLog.count({ where: { entity: 'Application', entityId: raceRows[0].id } })) === 1);
    }

    // ------------------------------------------------------------------ E: who may NOT add
    const cNo = await mkCand();
    for (const [k, label] of [['mgr', 'a Manager (view + approve only, by the permission rules)'], ['am', 'an Assistant Manager (view + approve only)'], ['stlEdu', 'an STL (view + approve only)'], ['recMed', 'a Recruiter of another department'], ['hr', 'HR on a client job'], ['noAts', 'a login without ATS'], ['client', 'a CLIENT login']]) {
      r = await http('POST', '/api/applications', T[k], { candidateId: cNo.id, requirementId: jobA.id });
      check(`E1 ${label} cannot add (refused, nothing created)`, refused(r) && (await rowsOf(cNo.id, jobA.id)).length === 0, r);
    }
    r = await http('POST', '/api/applications', T.recMed, { candidateId: cDup.id, requirementId: jobA.id });
    check('E2 a login that cannot see the job is not told who is on it (403, no application data)', r.status === 403 && !/application|ALREADY_APPLIED/.test(r.text.replace(/Outside your access/g, '')), r.text);
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cNo.id });
    check('E3 a missing job gives a plain sentence', r.status === 400 && /Pick the person and the requirement/.test(r.body.error), r);

    // ------------------------------------------------------------------ F: the pair check
    const cFree = await mkCand();
    r = await http('GET', `/api/applications/pair-check?candidateId=${cFree.id}&requirementId=${jobA.id}`, T.recEdu);
    check('F1 a free pair: exists false, nothing blocked', r.status === 200 && r.body && r.body.exists === false && r.body.blocked === null, r);
    r = await http('GET', `/api/applications/pair-check?candidateId=${cDup.id}&requirementId=${jobA.id}`, T.recEdu);
    check('F2 an existing pair: exists true with where it is, and the other job', r.status === 200 && r.body && r.body.exists === true && r.body.application.id === firstApp.id && r.body.others.length === 1 && /already on/.test(r.body.message), r);
    r = await http('GET', `/api/applications/pair-check?candidateId=${cFree.id}&requirementId=${jobA.id}`, T.recMed);
    check('F3 a job outside the login\'s reach is refused', r.status === 403, r);
    const jobClosed = await mkReq('closed', { status: 'CLOSED' });
    r = await http('GET', `/api/applications/pair-check?candidateId=${cFree.id}&requirementId=${jobClosed.id}`, T.recEdu);
    check('F4 a closed job: blocked JOB_CLOSED before the click', r.status === 200 && r.body && r.body.blocked && r.body.blocked.code === 'JOB_CLOSED', r);
    const cDnu = await mkCand({ profileStatus: 'Do Not Use' });
    r = await http('GET', `/api/applications/pair-check?candidateId=${cDnu.id}&requirementId=${jobA.id}`, T.recEdu);
    check('F5 a Do not use person: blocked DO_NOT_USE before the click', r.status === 200 && r.body && r.body.blocked && r.body.blocked.code === 'DO_NOT_USE', r);
    r = await http('GET', '/api/applications/pair-check', T.recEdu);
    check('F6 no person given: 400', r.status === 400, r);
    r = await http('GET', `/api/applications/pair-check?candidateId=${cFree.id}&requirementId=${jobA.id}`, T.client);
    check('F7 a CLIENT login cannot use it', refused(r), r);

    // ------------------------------------------------------------------ H: refusals keep their words
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cFree.id, requirementId: jobClosed.id });
    check('H1 a closed job refuses with its words', r.status === 409 && r.body.code === 'JOB_CLOSED' && /closed/.test(r.body.error), r);
    const jobPaused = await mkReq('paused', { status: 'ON_HOLD' });
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cFree.id, requirementId: jobPaused.id });
    check('H2 a paused job refuses with its words', r.status === 409 && r.body.code === 'JOB_PAUSED', r);
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cDnu.id, requirementId: jobA.id });
    check('H3 a Do not use person is refused', r.status === 409 && r.body.code === 'DO_NOT_USE', r);
    check('H4 none of these made a row', (await prisma.application.count({ where: { candidateId: { in: [cFree.id, cDnu.id] } } })) === 0);
    // the closed job where the person is ALREADY on it: say where, not "closed"
    const cOnClosed = await mkCand();
    await prisma.application.create({ data: { candidateId: cOnClosed.id, requirementId: jobClosed.id, stage: 'NEW' } });
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cOnClosed.id, requirementId: jobClosed.id });
    check('H5 already on a closed job: answers ALREADY_APPLIED (status Job closed), not a vague refusal', r.status === 409 && r.body.code === 'ALREADY_APPLIED' && r.body.application.status === 'Job closed', r);

    // ------------------------------------------------------------------ G: the pickers
    const cPick = await mkCand({ name: `ZZTEST AAT Pick Zorbaxio ${RUN}` });
    const code = `CAN-${cPick.id.slice(-8).toUpperCase()}`;
    const picker = (token, q, extra = '') => http('GET', `/api/candidates/picker?q=${encodeURIComponent(q)}${extra}`, token);
    r = await http('POST', '/api/applications', T.admin, { candidateId: cPick.id, requirementId: jobB.id });
    check('G0 (setup) a person is on job B', r.status === 201, r);
    r = await picker(T.admin, 'Zorbaxio');
    check('G1 admin finds a person by name', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id), r);
    r = await picker(T.admin, code);
    check('G2 ... by CAN code', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id), r);
    r = await picker(T.admin, cPick.phone.slice(-4));
    check('G3 ... by the end of the phone', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id), r);
    r = await picker(T.admin, cPick.email);
    check('G4 ... by email', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id), r);
    r = await picker(T.admin, 'Zorbaxio', `&requirementId=${jobB.id}`);
    check('G5 people already on the job are LISTED and marked (onJob with step and link)', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id && x.onJob && x.onJob.step && x.onJob.link), r.body);
    r = await picker(T.admin, 'Zorbaxio', `&requirementId=${jobA.id}`);
    check('G6 not on that job: onJob is empty', r.body.rows.some((x) => x.id === cPick.id && x.onJob === null), r.body);
    r = await picker(T.recEdu, 'Zorbaxio');
    check('G7 a Recruiter gets the phone end for the label', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id && x.phoneTail === cPick.phone.slice(-4)), r.body);
    // BDE: the person must be in their reach (a BDE-stage application on their client's job)
    await prisma.application.update({ where: { candidateId_requirementId: { candidateId: cPick.id, requirementId: jobB.id } }, data: { stage: 'WITH_BDE' } });
    r = await picker(T.bdeEdu, 'Zorbaxio');
    check('G8 a BDE finds by name (in their reach), with NO phone, email or salary fields', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id) && !new RegExp(`${cPick.phone}|${cPick.email}|${SAL}|phoneTail|"phone"|"email"`, 'i').test(r.text), r.text);
    r = await picker(T.bdeEdu, cPick.phone);
    check('G9 a BDE typing a phone number finds nobody (no phone search for the BDE team)', r.status === 200 && r.body.rows.length === 0, r.body);
    r = await picker(T.bdeEdu, cPick.email);
    check('G10 a BDE typing an email finds nobody', r.status === 200 && r.body.rows.length === 0, r.body);
    r = await picker(T.bdeEdu, code);
    check('G11 a BDE finds by CAN code', r.status === 200 && r.body.rows.some((x) => x.id === cPick.id), r.body);
    r = await picker(T.client, 'Zorbaxio');
    check('G12 a CLIENT login gets nothing from the picker', refused(r) || (r.body && r.body.rows && r.body.rows.length === 0), r);
    r = await http('GET', `/api/requirements/${jobB.id}/candidate-search?q=Zorbaxio`, T.admin);
    check('G13 the job page search now LISTS the person already on the job, with where (it used to hide them)', r.status === 200 && Array.isArray(r.body) && r.body.some((x) => x.id === cPick.id && x.onJob && x.onJob.step && x.onJob.link), r.body);
    r = await http('GET', `/api/requirements/${jobA.id}/candidate-search?q=Zorbaxio`, T.admin);
    check('G14 on a job where they are not: listed with onJob null', r.status === 200 && r.body.some((x) => x.id === cPick.id && x.onJob === null), r.body);
    r = await http('GET', `/api/requirements/${jobB.id}/candidate-search?q=${cPick.phone}`, T.bdeEdu);
    check('G15 the job page search by phone finds nobody for a BDE', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r.body);

    // ------------------------------------------------------------------ the Add Candidate form (existing person path)
    r = await http('POST', '/api/applications', T.recEdu, { candidateId: cPick.id, requirementId: jobB.id, comment: 'Added from Add Candidate - the person was already on file' });
    check('X1 the "already on file" panel adding to a job they are on gives the same box data', r.status === 409 && r.body.code === 'ALREADY_APPLIED', r);
  } catch (e) {
    fail += 1; console.error('TEST CRASHED', e);
  } finally {
    try {
      const reqIds = made.reqs;
      const apps = await prisma.application.findMany({ where: { OR: [{ requirementId: { in: reqIds } }, { candidateId: { in: made.cands } }] }, select: { id: true } });
      const appIds = apps.map((a) => a.id);
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: appIds } }, { userId: { in: made.users } }] } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
