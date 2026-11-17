#!/usr/bin/env node
/**
 * ONE REQUIREMENT -> ONE SUCCESSFUL JOINING (the founder's acceptance test), end to end through the real API, as the right role
 * at every step: client (with its BDE) -> agreement -> requirement request -> BDE TL accepts & opens it -> TL takes it and gives
 * it to a recruiter -> job posting -> candidate (+ duplicate check) -> fit score -> pipeline -> interview -> client Selected ->
 * offer -> joined -> HRMS / Accounts -> reports. Plus negative checks (another department's recruiter, a stage jump).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4071. Nothing outbound (TEAMLINK_SANDBOX / TEST_MODE).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/lifecycle-e2e-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-lifecycle-e2e-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-lifecycle-e2e-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4071;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'lifecycle-e2e-test', UPLOAD_DIR: UPLOADS,
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

// ---- the stage board (10 stages of the acceptance test + the negative checks)
const STAGES = {
  1: 'Client created with a BDE (+ agreement Active)', 2: 'Requirement request -> accepted -> opened -> TL -> recruiter', 3: 'Job posting',
  4: 'Candidate added + duplicate refused', 5: 'Screening: fit score + pipeline moves', 6: 'Interview booked + feedback',
  7: 'Client decision: Selected', 8: 'Offer -> accepted -> Joined', 9: 'HRMS & Accounts', 10: 'Reports count the joining', N: 'Negative checks',
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
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.71.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text: text.slice(0, 300) };
};
const ok2 = (r) => !!r && r.status >= 200 && r.status < 300;
const err = (r) => (r ? [r.status, (r.body && (r.body.error || r.body.code)) || r.text] : 'no response');
const RUN = Date.now().toString(36);
const P = process.pid;
const mkUser = async (tag, data, emp) => {
  const u = await prisma.user.create({
    data: {
      name: `ZZTEST LCE ${tag} ${RUN}`, email: `zz-lce-${tag}-${RUN}@example.test`, username: `zz-lce-${tag}-${RUN}@example.test`, passwordHash: 'x', status: 'Active',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
    },
  });
  if (emp) {
    await prisma.employee.create({
      data: { employeeCode: `ZZ-LCE-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: data.atsDepartment || null, email: u.email, ...emp },
    });
  }
  return u;
};
const day = (d = 0) => new Date(Date.now() + d * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
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
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const bdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  const bde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { tl: bdeTl.name, department: 'BDE' });
  const hr = await mkUser('hr', { role: 'TL', atsRole: 'TL', atsDepartment: 'Internal HR', atsScopeDepartments: 'Internal HR' }, { designation: 'TL', department: 'Internal HR' });
  const tl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL', department: DEPT });
  const rec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
  const recX = await mkUser('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Non IT', atsScopeDepartments: 'Non IT' }, { department: 'Non IT' });
  const acc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' });
  const hrEmp = await prisma.employee.findFirst({ where: { userId: hr.id } });

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
  for (const [k, u] of Object.entries({ sa, bdeTl, bde, hr, tl, rec, recX, acc })) T[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  const C = (m, p, who, body) => call(m, p, body, T[who]);
  const ids = {};

  // reports BEFORE (stage 10 compares)
  const tileOf = (rep, key) => (rep && Array.isArray(rep.tiles) ? rep.tiles.find((t) => t.key === key) : null);
  const cardOf = (rep, key) => (rep && Array.isArray(rep.cards) ? (rep.cards.find((c) => c.key === key) || {}).value : undefined);
  const myBefore = await C('GET', '/ats-reports/my-results', 'rec');
  const funnelBefore = await C('GET', '/ats-reports/funnel', 'sa');

  try {
    // ======================= 1. CLIENT =======================
    stage(1);
    const tlClient = await C('POST', '/clients', 'rec', { mode: 'create', name: `ZZTEST LCE rec try ${RUN}` });
    check('a recruiter cannot add a client (403)', tlClient.status === 403, err(tlClient));
    const cl = await C('POST', '/clients', 'bde', {
      mode: 'create', name: `ZZTEST LCE Nimbus Systems ${RUN}`, industry: 'Information Technology', contactName: 'ZZ Kiran', contactEmail: `zz-lce-client-${RUN}@example.test`,
      contactPhone: '9000000171', ownerDepartment: DEPT, bdeOwner: bde.name, agreementFeePercent: 8.33, paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice',
      guaranteePeriod: '90 Days', state: 'Telangana', city: 'Hyderabad', confirmSeparate: true,
    });
    ids.client = cl.body && (cl.body.id || (cl.body.client && cl.body.client.id));
    let cr = ids.client ? await prisma.client.findUnique({ where: { id: ids.client } }) : null;
    check('POST /api/clients (BDE): client created, BDE assigned, agreement Draft', cl.status === 201 && !!cr && cr.bdeOwner === bde.name && cr.agreementStatus === 'DRAFT', [err(cl), cr && { bdeOwner: cr.bdeOwner, agr: cr.agreementStatus }]);
    if (!ids.client) throw new Error('no client - cannot go on');
    const seeA = await C('GET', `/clients/${ids.client}`, 'sa');
    check('the Admin opens the client', seeA.status === 200, err(seeA));
    // agreement: BDE -> HR -> BDE TL -> sent -> signed -> active (needed before a requirement can open)
    await C('PUT', '/agreement-flow/settings', 'sa', { approvers: [hrEmp.employeeCode] });
    const a1 = await C('POST', `/agreement-flow/${ids.client}/action`, 'bde', { action: 'send_to_hr' });
    check('agreement: BDE sends it to HR', ok2(a1) && a1.body.stage === 'WITH_HR', err(a1));
    const a2 = await C('PUT', `/agreement-flow/${ids.client}/sections`, 'hr', { legalName: `ZZTEST LCE Nimbus Systems Pvt Ltd ${RUN}`, gst: '36AABCN1234C1Z5', pan: 'AABCN1234C', invoiceEmail: 'zz-lce-inv@example.test', paymentMethod: 'Bank transfer' });
    check('agreement: HR fills tax / billing', ok2(a2), err(a2));
    const a3 = await C('POST', `/agreement-flow/${ids.client}/action`, 'hr', { action: 'send_to_tl' });
    check('agreement: HR sends it to the BDE TL', ok2(a3) && a3.body.stage === 'WITH_TL', err(a3));
    const ours = require('./lib/teamlinkSigned')(prisma); // the stand-in for TeamLink's DigiLocker eSigned copy (no real Aadhaar eSign in a test)
    await ours.add(ids.client);
    const a4 = await C('POST', `/clients/${ids.client}/agreement/send`, 'bdeTl', { verified: ['commercial', 'tax', 'payment', 'documents'] });
    cr = await prisma.client.findUnique({ where: { id: ids.client } });
    check('agreement: BDE TL sends it to the client (SENT; mail/SMS faked by the sandbox)', ok2(a4) && cr.agreementStatus === 'SENT', [err(a4), cr.agreementStatus]);
    const a5 = await C('POST', `/clients/${ids.client}/agreement/confirm`, 'sa', { signedCopyName: 'zz-lce-signed.pdf', signedByName: 'ZZ Kiran' });
    cr = await prisma.client.findUnique({ where: { id: ids.client } });
    check('agreement: Admin records the client signature', ok2(a5) && ['SIGNED', 'ACTIVE'].includes(cr.agreementStatus), [err(a5), cr.agreementStatus]);
    if (cr.agreementStatus === 'SIGNED') {
      const a6 = await C('POST', `/clients/${ids.client}/agreement/activate`, 'bde', {});
      cr = await prisma.client.findUnique({ where: { id: ids.client } });
      check('agreement: BDE activates it (ACTIVE)', ok2(a6) && cr.agreementStatus === 'ACTIVE', [err(a6), cr.agreementStatus]);
    }

    // ======================= 2. REQUIREMENT =======================
    stage(2);
    const tlTry = await C('POST', '/requirements', 'tl', { title: `ZZTEST LCE TL try ${RUN}`, clientId: ids.client, department: DEPT, jobDescription: 'x', skills: 'x' });
    check('a TL cannot create / request a requirement (403)', tlTry.status === 403, err(tlTry));
    const rq = await C('POST', '/requirements/requests', 'bde', {
      title: `ZZTEST LCE Java Developer ${RUN}`, clientId: ids.client, department: DEPT, openings: 1, location: 'Hyderabad', salary: '6-9 LPA',
      jobDescription: 'Java, Spring Boot, REST APIs, SQL (ZZTEST LCE).', skills: 'Java, Spring Boot, REST', experience: '2-5',
    });
    ids.req = rq.body && (rq.body.id || (rq.body.requirement && rq.body.requirement.id));
    let r0 = ids.req ? await prisma.requirement.findUnique({ where: { id: ids.req } }) : null;
    check('POST /api/requirements/requests (BDE): saved as a DRAFT request owned by the BDE', ok2(rq) && !!r0 && r0.status === 'DRAFT' && r0.bdeId === bde.id, [err(rq), r0 && { status: r0.status, bde: r0.bdeId === bde.id }]);
    if (!ids.req) throw new Error('no requirement - cannot go on');
    const early = await C('POST', `/requirements/${ids.req}/activate`, 'bdeTl', {});
    check('it cannot be opened before it is accepted (409 ACCEPT_FIRST)', early.status === 409 && early.body && early.body.code === 'ACCEPT_FIRST', err(early));
    const acRec = await C('POST', `/requirements/${ids.req}/accept-request`, 'rec', {});
    check('a recruiter cannot accept the request', !ok2(acRec), err(acRec));
    const ac = await C('POST', `/requirements/${ids.req}/accept-request`, 'bdeTl', {});
    check('POST /:id/accept-request (BDE TL) accepts it', ok2(ac) && ac.body.requestState === 'accepted', err(ac));
    const act = await C('POST', `/requirements/${ids.req}/activate`, 'bdeTl', {});
    r0 = await prisma.requirement.findUnique({ where: { id: ids.req } });
    check('POST /:id/activate (BDE TL) opens it (agreement Active -> OPEN)', ok2(act) && ['OPEN', 'RECRUITER_ASSIGNED'].includes(r0.status), [err(act), r0.status]);
    const bdePick = await C('POST', `/requirements/${ids.req}/assign`, 'bde', { recruiterId: rec.id });
    check('the BDE cannot pick the recruiter (the TL does)', bdePick.status === 403, err(bdePick));
    const t1 = await C('POST', `/requirements/${ids.req}/assign`, 'tl', { tlId: tl.id });
    check('POST /:id/assign (TL) takes the requirement', ok2(t1), err(t1));
    const t2 = await C('POST', `/requirements/${ids.req}/assign`, 'tl', { recruiterId: rec.id });
    r0 = await prisma.requirement.findUnique({ where: { id: ids.req } });
    check('POST /:id/assign (TL) gives it to the recruiter (RECRUITER_ASSIGNED)', ok2(t2) && r0.status === 'RECRUITER_ASSIGNED' && r0.recruiterId === rec.id && r0.tlId === tl.id, [err(t2), r0.status]);
    const recSees = await C('GET', `/requirements/${ids.req}`, 'rec');
    check('the recruiter opens the requirement', recSees.status === 200, err(recSees));

    // ======================= 3. JOB POSTING =======================
    stage(3);
    r0 = await prisma.requirement.findUnique({ where: { id: ids.req } });
    check('opening it auto-posts it (portalPublished = true, utils/jobPosting.js autoPost)', r0.portalPublished === true, { portalPublished: r0.portalPublished, sync: r0.portalSyncStatus, sources: r0.postingSources });
    const po = await C('GET', `/requirements/${ids.req}/postings`, 'tl');
    const jp = po.body && Array.isArray(po.body.channels) ? po.body.channels.find((c) => c.id === 'jobportal') : null;
    check('GET /:id/postings (TL): live + published, Job Portal channel listed', po.status === 200 && po.body.live === true && po.body.published === true && !!jp, [err(po), po.body && { live: po.body.live, published: po.body.published, ch: (po.body.channels || []).map((c) => `${c.id}:${c.status}`) }]);
    if (jp) note(`Job Portal channel status in sandbox: "${jp.status}" (${jp.detail || '-'})`);
    const pub = await C('POST', `/job-publish/jobs/${ids.req}/publish`, 'tl', { portals: ['career'], dryRun: true });
    if (pub.status === 503) skip('POST /api/job-publish/jobs/:id/publish', `job-publish tables not in this DB (${err(pub)})`);
    else check('POST /api/job-publish/jobs/:id/publish (career page, dryRun) is accepted', ok2(pub), err(pub));
    skip('delivery to the external Job Portal / boards', 'sandbox never contacts the portal (utils/sandbox.js); the posting worker is not run');

    // ======================= 4. CANDIDATE =======================
    stage(4);
    const phone = `9${String(Date.now()).slice(-9)}`;
    const email = `zz-lce-cand-${RUN}@example.test`;
    const candBody = {
      // NOT named "ZZTEST": the reports leave out test candidates by name (utils/reportAggregates.js buildCand, atsHome.isTest),
      // and stage 10 checks the joining is counted. The copy of the database is deleted at the end anyway.
      name: `Lce Arjun Varma ${RUN}`, phone, email, skills: 'Java, Spring Boot, REST, SQL', currentSalary: 600000, expectedSalary: 800000,
      experienceYears: 3, location: 'Hyderabad', source: 'Naukri', resumeName: 'zz-lce-arjun-resume.pdf', currentDesignation: 'Java Developer',
    };
    const cd = await C('POST', '/candidates', 'rec', candBody);
    ids.cand = cd.body && (cd.body.id || (cd.body.candidate && cd.body.candidate.id));
    check('POST /api/candidates (recruiter) adds the candidate', ok2(cd) && !!ids.cand, err(cd));
    if (!ids.cand) throw new Error('no candidate - cannot go on');
    const doc = await prisma.candidateDocument.findFirst({ where: { candidateId: ids.cand, docType: 'Resume' } });
    check('the resume named on the form is on the Documents tab', !!doc, doc);
    note('POST /api/candidates takes no resume TEXT field (only resumeName); resume parsing needs a file upload, not exercised');
    const dup1 = await C('POST', '/candidates', 'rec', { ...candBody, name: `ZZTEST LCE Arjun again ${RUN}` });
    check('the same phone + email again is refused (409 duplicate)', dup1.status === 409 && dup1.body && dup1.body.duplicate === true && (dup1.body.matches || []).some((m) => m.id === ids.cand), err(dup1));
    const dup2 = await C('POST', '/candidates', 'rec', { ...candBody, email: `zz-lce-other-${RUN}@example.test`, name: `ZZTEST LCE Other ${RUN}` });
    check('the same phone with a new email is refused too', dup2.status === 409 && dup2.body && dup2.body.duplicate === true, err(dup2));
    const dup3 = await C('POST', '/candidates', 'rec', { ...candBody, overrideDuplicate: true, name: `ZZTEST LCE Arjun forced ${RUN}` });
    check('a recruiter cannot force a second profile (overrideDuplicate is Admin only)', dup3.status === 409, err(dup3));
    const chk = await C('GET', `/candidates/check-duplicate?phone=${phone}`, 'rec');
    check('GET /api/candidates/check-duplicate flags the phone', chk.status === 200 && chk.body.duplicate === true, err(chk));
    check('only one candidate row has this phone', (await prisma.candidate.count({ where: { phone } })) === 1);

    // ======================= 5. SCREENING + PIPELINE =======================
    stage(5);
    // A recruiter's Matching list draws only on candidates already in their pipeline (utils/scope.js candidateWhere -> applicationWhere),
    // so the Admin's list (all candidates) is the one a brand-new, unlinked candidate can show in.
    const mc = await C('GET', `/requirements/${ids.req}/matching-candidates?limit=100`, 'sa');
    const mine = mc.body && Array.isArray(mc.body.rows) ? mc.body.rows.find((c) => c.id === ids.cand) : null;
    check('GET /:id/matching-candidates (Admin) answers with scored suggestions', mc.status === 200 && Array.isArray(mc.body.rows) && mc.body.rows.every((c) => c.match && Number.isFinite(Number(c.match.overall))), [err(mc), mc.body && mc.body.total]);
    note(mine ? `the new candidate is in the Admin's top-100 suggestions at ${mine.match.overall}%` : `the new candidate is not in the Admin's top-100 suggestions (total ${mc.body && mc.body.total}, strong ${mc.body && mc.body.strong})`);
    const mcRec = await C('GET', `/requirements/${ids.req}/matching-candidates?limit=100&threshold=0`, 'rec');
    note(`recruiter's own Matching list for the job before applying: ${mcRec.body && mcRec.body.total} rows (scoped to candidates already in their pipeline)`);
    let ap = await C('POST', '/applications', 'rec', { candidateId: ids.cand, requirementId: ids.req });
    if (ap.status === 409 && ap.body && ap.body.code === 'NEEDS_OVERRIDE') {
      note(`apply asked for an override reason: ${(ap.body.why || []).join('; ')}`);
      ap = await C('POST', '/applications', 'rec', { candidateId: ids.cand, requirementId: ids.req, overrideReason: 'ZZTEST LCE good fit' });
    }
    ids.app = ap.body && (ap.body.id || (ap.body.application && ap.body.application.id));
    const a0 = ids.app ? await prisma.application.findUnique({ where: { id: ids.app } }) : null;
    check('POST /api/applications (recruiter): applied at stage NEW with a fit score', ok2(ap) && !!a0 && a0.stage === 'NEW' && a0.matchScore != null, [err(ap), a0 && { stage: a0.stage, matchScore: a0.matchScore }]);
    if (!ids.app) throw new Error('no application - cannot go on');
    const fbk = await C('POST', '/candidate-resumes/fit-breakdowns', 'rec', { applicationIds: [ids.app] });
    const fitItem = fbk.body && fbk.body.items ? fbk.body.items[ids.app] : null;
    check('POST /api/candidate-resumes/fit-breakdowns (recruiter): the fit breakdown for this application', fbk.status === 200 && !!fitItem, [err(fbk), fitItem]);
    note(`fit at apply: application.matchScore=${a0 && a0.matchScore}; breakdown=${JSON.stringify(fitItem).slice(0, 160)}`);
    const again = await C('POST', '/applications', 'rec', { candidateId: ids.cand, requirementId: ids.req, overrideReason: 'ZZTEST LCE again' });
    check('the same candidate cannot be applied to the same job twice', !ok2(again), err(again));
    const stageNow = async () => (await prisma.application.findUnique({ where: { id: ids.app } })).stage;
    const move = (who, s, extra = {}) => C('PATCH', `/applications/${ids.app}/stage`, who, { stage: s, comment: 'ZZTEST LCE', ...extra });
    const m1 = await move('rec', 'RECRUITER_REVIEW');
    check('PATCH /stage (recruiter): NEW -> RECRUITER_REVIEW', ok2(m1) && await stageNow() === 'RECRUITER_REVIEW', err(m1));
    const m2 = await move('rec', 'TL_REVIEW');
    check('PATCH /stage (recruiter): -> TL_REVIEW', ok2(m2) && await stageNow() === 'TL_REVIEW', err(m2));
    const recBde = await move('rec', 'WITH_BDE');
    check('the recruiter cannot send to the BDE (TL step)', !ok2(recBde), err(recBde));
    const m3 = await move('tl', 'WITH_BDE');
    check('PATCH /stage (TL): -> WITH_BDE', ok2(m3) && await stageNow() === 'WITH_BDE', err(m3));
    // permissions.js STAGE_OWNERS (founder 2026-11-06 / 11-11): a BDE goes only "up to the BDE TL" (BDE_APPROVED); the BDE TL shares with the client.
    const tlShare = await move('tl', 'SHARED_WITH_CLIENT');
    check('the TL cannot share with the client', !ok2(tlShare), err(tlShare));
    const bdeShare = await move('bde', 'SHARED_WITH_CLIENT');
    check('the BDE cannot share with the client either (BDE TL step)', bdeShare.status === 403, err(bdeShare));
    const m4 = await move('bde', 'BDE_APPROVED');
    check('PATCH /stage (BDE): -> BDE_APPROVED (to the BDE TL)', ok2(m4) && await stageNow() === 'BDE_APPROVED', err(m4));
    const m5 = await move('bdeTl', 'SHARED_WITH_CLIENT');
    check('PATCH /stage (BDE TL): -> SHARED_WITH_CLIENT', ok2(m5) && await stageNow() === 'SHARED_WITH_CLIENT', err(m5));
    const clientUser = await mkUser('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: ids.client, portalType: 'REVIEWER', portalPerms: 'VIEW,AGREEMENT,REQUEST,DECIDE,INTERVIEW,FEEDBACK,OFFERS' });
    T.client = await tokenOf(clientUser.id);
    const sl = await C('POST', `/job-portal/client/applications/${ids.app}/decision`, 'client', { decision: 'SHORTLIST' });
    check('client portal: the client shortlists (CLIENT_SHORTLISTED)', ok2(sl) && await stageNow() === 'CLIENT_SHORTLISTED', [err(sl), await stageNow()]);

    // ======================= 6. INTERVIEW =======================
    stage(6);
    const bookBody = { date: day(1), time: '11:00', mode: 'online', interviewer: 'ZZ Panel (client CTO)', meetingLink: 'https://meet.example.test/zz-lce' };
    const recBook = await C('POST', `/ats/interviews/${ids.app}/book`, 'rec', bookBody);
    check('the recruiter cannot book the client interview', !ok2(recBook), err(recBook));
    const bk = await C('POST', `/ats/interviews/${ids.app}/book`, 'bde', bookBody);
    check('POST /api/ats/interviews/:id/book (BDE): INTERVIEW_SCHEDULED', ok2(bk) && await stageNow() === 'INTERVIEW_SCHEDULED', [err(bk), await stageNow()]);
    const fb = await C('POST', `/ats/interviews/${ids.app}/feedback`, 'rec', { feedback: 'Strong Java and SQL (ZZTEST LCE)', result: 'Selected', score: 8 });
    check('POST /api/ats/interviews/:id/feedback (recruiter): INTERVIEW_COMPLETED', ok2(fb) && await stageNow() === 'INTERVIEW_COMPLETED', [err(fb), await stageNow()]);
    const fbRows = await prisma.interviewFeedback.count({ where: { applicationId: ids.app } }).catch(() => null);
    check('the feedback is stored', fbRows === null || fbRows >= 1, fbRows);

    // ======================= 7. CLIENT DECISION =======================
    stage(7);
    const cf = await C('POST', `/ats/interviews/${ids.app}/client-feedback`, 'client', { overall: 'Good fit, go ahead (ZZTEST LCE)', recommendation: 'Selected', ratings: { technical: 4, communication: 4 } });
    check('POST /api/ats/interviews/:id/client-feedback (client): recommends Selected', ok2(cf), err(cf));
    const recDec = await C('POST', `/ats/interviews/${ids.app}/decision`, 'rec', { decision: 'Selected' });
    check('the recruiter cannot record the final decision', !ok2(recDec), err(recDec));
    const tlDec = await C('POST', `/ats/interviews/${ids.app}/decision`, 'tl', { decision: 'Selected' });
    check('the TL cannot mark Selected (after the client it is the BDE TL\'s / client\'s)', !ok2(tlDec), err(tlDec));
    // The BDE TL owns SELECTED after the client (permissions.js ownsStage / stepFree), but in the Interviews module the BDE TL has a
    // BDE's rights only (permissions.js BDE_TL_AS_BDE_MODULES), and a BDE has no 'Interview Feedback' approve, which the decision door needs.
    const dcTry = await C('POST', `/ats/interviews/${ids.app}/decision`, 'bdeTl', { decision: 'Selected' });
    if (ok2(dcTry)) check('POST /api/ats/interviews/:id/decision (BDE TL, for the client): SELECTED', await stageNow() === 'SELECTED', await stageNow());
    else {
      finding(`POST /api/ats/interviews/:id/decision as the BDE TL answers ${dcTry.status} "${dcTry.body && dcTry.body.error}" although the BDE TL owns the Selected step; Selected is recorded with PATCH /stage instead`);
      const dc = await move('bdeTl', 'SELECTED');
      check('PATCH /api/applications/:id/stage (BDE TL, the client\'s Selected): SELECTED', ok2(dc) && await stageNow() === 'SELECTED', [err(dc), await stageNow()]);
    }

    // ======================= 8. OFFER + JOINING =======================
    stage(8);
    const direct = await move('rec', 'OFFER');
    check('a plain stage move cannot skip the offer flow', !ok2(direct), err(direct));
    const fd = new FormData();
    fd.append('note', 'Client emailed the offer letter (ZZTEST LCE)');
    fd.append('designation', 'Java Developer');
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'zz-lce-offer.pdf');
    const rl = await fetch(`${API}/ats/offers/${ids.app}/client-release`, { method: 'POST', headers: { Authorization: `Bearer ${T.bde}` }, body: fd });
    const rlText = await rl.text();
    check('POST /api/ats/offers/:id/client-release (BDE): the client\'s offer letter recorded', rl.status >= 200 && rl.status < 300, [rl.status, rlText.slice(0, 200)]);
    const sh = await C('POST', `/ats/offers/${ids.app}/share`, 'rec', { via: 'Link' });
    check('POST /api/ats/offers/:id/share (recruiter): OFFER', ok2(sh) && await stageNow() === 'OFFER', [err(sh), await stageNow()]);
    let acp = await C('POST', `/ats/offers/${ids.app}/accept`, 'rec', {});
    if (acp.status === 409 && acp.body && acp.body.code === 'CTC_CONFIRM') acp = await C('POST', `/ats/offers/${ids.app}/accept`, 'rec', { confirmCtc: true });
    check('POST /api/ats/offers/:id/accept (recruiter): OFFER_ACCEPTED', ok2(acp) && await stageNow() === 'OFFER_ACCEPTED', [err(acp), await stageNow()]);
    // the joining is a step after the client: the BDE TL's (interviewsJoining.js joiningRefusal -> canMoveToStage JOINED)
    const recJs = await C('POST', `/ats/joining/${ids.app}/schedule`, 'rec', { joiningDate: day(0), offeredCtc: 800000 });
    check('the recruiter cannot schedule the client joining (BDE TL step)', recJs.status === 403, err(recJs));
    const early2 = await C('POST', `/ats/joining/${ids.app}/joined`, 'bdeTl', { joinedOn: day(0), offeredCtc: 800000 });
    check('Joined is refused before a joining date is scheduled', early2.status === 409, err(early2));
    let js = await C('POST', `/ats/joining/${ids.app}/schedule`, 'bdeTl', { joiningDate: day(0), offeredCtc: 800000 });
    if (js.status === 409 && js.body && js.body.code === 'CTC_CONFIRM') js = await C('POST', `/ats/joining/${ids.app}/schedule`, 'bdeTl', { joiningDate: day(0), offeredCtc: 800000, confirmCtc: true });
    check('POST /api/ats/joining/:id/schedule (BDE TL): Joining Scheduled', ok2(js), err(js));
    let jn = await C('POST', `/ats/joining/${ids.app}/joined`, 'bdeTl', { joinedOn: day(0), offeredCtc: 800000 });
    if (jn.status === 409 && jn.body && jn.body.code === 'CTC_CONFIRM') jn = await C('POST', `/ats/joining/${ids.app}/joined`, 'bdeTl', { joinedOn: day(0), offeredCtc: 800000, confirmCtc: true });
    check('POST /api/ats/joining/:id/joined (BDE TL): JOINED', ok2(jn) && await stageNow() === 'JOINED', [err(jn), await stageNow()]);
    const evs = await prisma.applicationStageEvent.count({ where: { applicationId: ids.app } });
    check('every move is in the candidate\'s stage history (>= 10 events)', evs >= 10, evs);
    ids.joinInvoiceId = jn.body && jn.body.invoiceId;

    // ======================= 9. HRMS & ACCOUNTS =======================
    stage(9);
    const aJ = await prisma.application.findUnique({ where: { id: ids.app } });
    const emps = await prisma.employee.count({ where: { OR: [{ email }, { phone }, { name: candBody.name }] } }).catch(() => prisma.employee.count({ where: { OR: [{ email }, { name: candBody.name }] } }));
    check('HRMS: a client placement makes NO HRMS employee (only internal hires do: interviewsJoining.js finishInternalHire)', emps === 0 && !aJ.hrmsEmployeeId, { emps, hrmsEmployeeId: aJ.hrmsEmployeeId, hiringType: aJ.hiringType });
    note(`HRMS: nothing is created or linked for the joined client-placement candidate (hiringType=${aJ.hiringType}); response employeeId=${jn.body && jn.body.employeeId}`);
    const inv = await prisma.invoice.findFirst({ where: { clientId: ids.client } });
    const expectFee = Math.round(800000 * 0.0833);
    check('Accounts: the joining raised an invoice by itself (8.33% of 8 LPA)', !!inv && Math.abs((inv.amount || inv.subtotal || 0) - expectFee) <= 2, inv ? { amount: inv.amount, subtotal: inv.subtotal, total: inv.total, status: inv.status, cand: inv.candidateId === ids.cand } : 'no invoice');
    if (inv) {
      check('the invoice names the candidate and requirement, and is the one /joined returned', inv.candidateId === ids.cand && inv.requirementId === ids.req && (!ids.joinInvoiceId || ids.joinInvoiceId === inv.id), { cand: inv.candidateId === ids.cand, req: inv.requirementId === ids.req, returned: ids.joinInvoiceId });
      const li = await C('GET', `/invoices?clientId=${ids.client}`, 'acc');
      check('GET /api/invoices (accountant) lists it', ok2(li) && JSON.stringify(li.body).includes(inv.id), err(li));
      const recInv = await C('GET', `/invoices?clientId=${ids.client}`, 'rec');
      check('a recruiter cannot open Accounts invoices', !ok2(recInv) || !JSON.stringify(recInv.body).includes(inv.id), err(recInv));
    }
    const ctc = await C('GET', `/ats/joining-ctc/${ids.app}`, 'bde');
    check('GET /api/ats/joining-ctc/:applicationId (BDE): shows the joining CTC 8,00,000', ctc.status === 200 && Number(ctc.body.ctc) === 800000, err(ctc) && ctc.body);
    if (inv) {
      check('the joining is invoiced, so the CTC is no longer editable there', ctc.body && ctc.body.invoiced === true && ctc.body.canEdit === false, ctc.body);
      const ctcPost = await C('POST', `/ats/joining-ctc/${ids.app}`, 'bde', { offeredCtc: 820000 });
      check('POST /api/ats/joining-ctc after invoicing is refused (409, Accounts owns it)', ctcPost.status === 409, err(ctcPost));
    } else {
      const ctcPost = await C('POST', `/ats/joining-ctc/${ids.app}`, 'bde', { offeredCtc: 820000 });
      check('POST /api/ats/joining-ctc (BDE) saves the CTC', ctcPost.status === 200, err(ctcPost));
    }

    // ======================= 10. REPORTS =======================
    stage(10);
    const myAfter = await C('GET', '/ats-reports/my-results', 'rec');
    const jb = cardOf(myBefore.body, 'joined'); const ja = cardOf(myAfter.body, 'joined');
    check('GET /api/ats-reports/my-results (recruiter): Joined goes up by 1', myBefore.status === 200 && myAfter.status === 200 && Number(ja) === Number(jb) + 1, { before: jb, after: ja, st: [myBefore.status, myAfter.status], err: err(myAfter) });
    const sb = cardOf(myBefore.body, 'selected'); const sa2 = cardOf(myAfter.body, 'selected'); const ib = cardOf(myBefore.body, 'interviews'); const ia = cardOf(myAfter.body, 'interviews');
    note(`recruiter My results: joined ${jb}->${ja}, selected ${sb}->${sa2}, interviews ${ib}->${ia}`);
    // the recruiter's own Funnel report (built with fresh: true)
    const recFunnel = await C('GET', '/ats-reports/funnel', 'rec');
    const rfJ = tileOf(recFunnel.body, 'joined');
    check('GET /api/ats-reports/funnel (recruiter, own numbers): Joined = 1', recFunnel.status === 200 && rfJ && Number(rfJ.value) === 1, [err(recFunnel), rfJ]);
    // WHY (diagnostic, read-only): who the report engine credits as this application's recruiter, computed in this process on the copy
    try {
      const AR = require('../src/routes/atsReports'); // eslint-disable-line global-require
      const ctxAll = await AR.packContext(await resolveIdentity(sa.id), {}, 'createdAt');
      const x = (ctxAll.apps || []).find((a) => a.id === ids.app);
      const fus = await prisma.applicationFollowUp.findMany({ where: { applicationId: ids.app }, orderBy: { createdAt: 'asc' } });
      const credited = x && x.recruiter ? x.recruiter.userId : null;
      note(`report engine credits the application's recruiter to: ${x && x.recruiter ? x.recruiter.label : '(none)'} (${credited === rec.id ? 'the recruiter' : credited === bde.id ? 'the BDE' : 'someone else'})`);
      note(`follow-ups on it: ${fus.map((f) => `${f.autoCreated ? 'auto' : 'manual'} "${f.nextAction}" owner=${f.ownerRole}/${f.ownerName || '-'}`).join('; ')}`);
      if (credited && credited !== rec.id) {
        finding('the joining is credited to the BDE, not the recruiter: the auto follow-ups raised at the client steps are owned by the BDE (utils/followups.js chainSnapshot, rule.ownerRole BDE; raiseAutoFollowUp), and utils/workers.js attribute() takes the latest follow-up owner as the RECRUITER without looking at ownerRole (workers.js:300 `lastOf(fus, (x) => x.ownerName || x.ownerUserId)`; joinCredit -> creditAt workers.js:354 the same). So the recruiter\'s My results and own Funnel show 0 joinings');
      }
    } catch (e) { note(`attribution diagnostic not run: ${String(e.message).slice(0, 160)}`); }
    const funnelAfter = await C('GET', '/ats-reports/funnel', 'sa');
    const fB = tileOf(funnelBefore.body, 'joined'); const fA = tileOf(funnelAfter.body, 'joined');
    if (funnelAfter.status === 200 && fA) {
      check('GET /api/ats-reports/funnel (Admin): the Joined tile goes up by 1', fB && Number(fA.value) === Number(fB.value) + 1, { before: fB && fB.value, after: fA.value, key: fA.key });
    } else {
      check('GET /api/ats-reports/funnel (Admin) answers with a Joined tile', false, [err(funnelAfter), funnelAfter.body && (funnelAfter.body.tiles || []).map((t) => t.key)]);
    }

    // ======================= NEGATIVE =======================
    stage('N');
    const xr = await C('GET', `/requirements/${ids.req}`, 'recX');
    check('a recruiter of another department cannot open the requirement (403/404)', [403, 404].includes(xr.status), err(xr));
    const xc = await C('GET', `/candidates/${ids.cand}`, 'recX');
    check('a recruiter of another department cannot open the candidate (403/404)', [403, 404].includes(xc.status), err(xc));
    const xa = await C('PATCH', `/applications/${ids.app}/stage`, 'recX', { stage: 'RECRUITER_REVIEW', comment: 'ZZTEST LCE' });
    check('nor move the application (PATCH /stage -> 403/404)', [403, 404].includes(xa.status), err(xa));
    const xa2 = await C('PATCH', `/applications/${ids.app}/stage`, 'recX', { stage: 'REJECTED', rejectedBy: 'Internal', reasonCategory: 'Other', reasonDetail: 'ZZTEST LCE outsider', comment: 'ZZTEST LCE' });
    check('nor reject it with a complete reject body (403/404)', [403, 404].includes(xa2.status), err(xa2));
    const xi = await C('POST', `/ats/interviews/${ids.app}/feedback`, 'recX', { feedback: 'x', result: 'Rejected', score: 1 });
    check('nor write interview feedback on it (403/404)', [403, 404].includes(xi.status), err(xi));
    check('the joined application is untouched', (await prisma.application.findUnique({ where: { id: ids.app } })).stage === 'JOINED');
    const xl = await C('GET', `/requirements?search=${encodeURIComponent(`ZZTEST LCE Java Developer ${RUN}`)}`, 'recX');
    check('nor find the requirement in their list', xl.status === 200 && !JSON.stringify(xl.body).includes(ids.req), err(xl));
    // a second application for the stage-jump check
    const cd2 = await C('POST', '/candidates', 'rec', { ...candBody, name: `Lce Bhavana Rao ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `zz-lce-cand2-${RUN}@example.test` });
    const cand2 = cd2.body && (cd2.body.id || (cd2.body.candidate && cd2.body.candidate.id));
    let ap2 = cand2 ? await C('POST', '/applications', 'rec', { candidateId: cand2, requirementId: ids.req }) : null;
    if (ap2 && ap2.status === 409 && ap2.body && ap2.body.code === 'NEEDS_OVERRIDE') ap2 = await C('POST', '/applications', 'rec', { candidateId: cand2, requirementId: ids.req, overrideReason: 'ZZTEST LCE second' });
    const app2 = ap2 && ap2.body && (ap2.body.id || (ap2.body.application && ap2.body.application.id));
    if (app2) {
      const j1 = await C('PATCH', `/applications/${app2}/stage`, 'rec', { stage: 'SHARED_WITH_CLIENT', comment: 'ZZTEST LCE' });
      check('stage jump NEW -> SHARED_WITH_CLIENT is refused', !ok2(j1), err(j1));
      const j2 = await C('PATCH', `/applications/${app2}/stage`, 'rec', { stage: 'JOINED', comment: 'ZZTEST LCE' });
      check('stage jump NEW -> JOINED is refused for the recruiter', !ok2(j2), err(j2));
      const j2b = await C('PATCH', `/applications/${app2}/stage`, 'rec', { stage: 'INTERVIEW_SCHEDULED', comment: 'ZZTEST LCE' });
      check('stage jump NEW -> INTERVIEW_SCHEDULED is refused for the recruiter', !ok2(j2b), err(j2b));
      const j2c = await C('PATCH', `/applications/${app2}/stage`, 'tl', { stage: 'SELECTED', comment: 'ZZTEST LCE' });
      check('stage jump NEW -> SELECTED is refused for the TL', !ok2(j2c), err(j2c));
      const j3 = await C('PATCH', `/applications/${app2}/stage`, 'rec', { stage: 'NOT_A_STAGE', comment: 'ZZTEST LCE' });
      check('an unknown stage is refused (4xx)', j3.status >= 400 && j3.status < 500, err(j3));
      check('the second application is still at NEW', (await prisma.application.findUnique({ where: { id: app2 } })).stage === 'NEW');
      // by design (applications.js applyStageMove: "Super Admin / Admin are exempt, for data correction"; BDE TL since 2026-11-11, stepFree)
      const invBefore = await prisma.invoice.count({ where: { clientId: ids.client } });
      const j4 = await C('PATCH', `/applications/${app2}/stage`, 'sa', { stage: 'JOINED', comment: 'ZZTEST LCE' });
      const invAfter = await prisma.invoice.count({ where: { clientId: ids.client } });
      note(`observed: Admin PATCH /stage NEW -> JOINED answered ${j4.status} (stage now ${(await prisma.application.findUnique({ where: { id: app2 } })).stage}); invoices for the client ${invBefore} -> ${invAfter}. Exempt by design (stepFree).`);
    } else check('second application for the stage-jump check', false, [err(cd2), err(ap2)]);
  } catch (e) { failed += 1; total += 1; board[cur].fail += 1; board[cur].fails.push(`crashed: ${String(e && e.message).slice(0, 300)}`); console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); }

  printBoard();
  if (findings.length) { console.log('\nFINDINGS (not counted as checks)'); findings.forEach((f) => console.log(`  - ${f}`)); }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
