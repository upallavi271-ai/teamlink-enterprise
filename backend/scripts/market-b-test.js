#!/usr/bin/env node
/**
 * MARKET WAVE B (founder 2026-11-21): one section per feature ID of builder B - requirements, candidates, pipeline, AI & automation.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> node scripts/market-b-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mktb-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4561;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mktb-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const section = (s) => console.log(`\n-- ${s}`);
const call = async (method, url, body, token, raw = false) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const tag = `mb${P}`;
const sql = (q, ...a) => prisma.$queryRawUnsafe(q, ...a);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const job = await prisma.requirement.findFirst({ where: { status: 'OPEN', internal: false }, include: { client: true }, orderBy: { createdAt: 'desc' } });
  const dept = job.department || 'IT';
  const mk = (n, role, atsRole, extra = {}) => prisma.user.create({ data: { name: `Mb ${n} ${P}`, email: `mb.${n}.${P}@mb-test.in`, passwordHash: 'x', status: 'Active', role, atsRole, atsDepartment: dept, atsScopeDepartments: dept, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const REC = await mk('rec', 'EMPLOYEE', 'RECRUITER');
  const REC2 = await mk('rec2', 'EMPLOYEE', 'RECRUITER');
  const TL = await mk('tl', 'TL', 'TL');
  const MGR = await mk('mgr', 'MANAGER', 'MANAGER');
  const BDE = await mk('bde', 'EMPLOYEE', 'BDE', { atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  await prisma.requirement.update({ where: { id: job.id }, data: { recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, skills: 'java, spring boot, sql', experience: '3-8', location: 'Hyderabad', jobDescription: 'We need a Java developer.\nMust have: Java, Spring Boot, SQL\nGood to have:\nDocker, Kubernetes' } });
  const mkCand = (n, data = {}) => prisma.candidate.create({ data: { name: `Mb ${n} ${tag}`, phone: `9${String(P).padStart(5, '0').slice(-5)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, email: `mb.${n}.${P}@mb-cand.in`, skills: 'java, spring boot, sql', experienceYears: 5, location: 'Hyderabad', noticePeriod: '30 Days', currentDesignation: 'Java Developer', currentSalary: '8', expectedSalary: '11', ...data } });
  const C1 = await mkCand('one');
  const C2 = await mkCand('two', { experienceYears: 1 });
  const app1 = await prisma.application.create({ data: { candidateId: C1.id, requirementId: job.id, stage: 'NEW', ownerRecruiterId: REC.id, source: 'Manual', matchScore: 80 } });
  const app2 = await prisma.application.create({ data: { candidateId: C2.id, requirementId: job.id, stage: 'NEW', ownerRecruiterId: REC.id, source: 'Manual', matchScore: 40 } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id); const tR2 = await tok(REC2.id); const tT = await tok(TL.id); const tM = await tok(MGR.id); const tB = await tok(BDE.id);
  const M = '/ats/mkt';

  section('09.18 PII masking (every model call)');
  const G = require('../src/utils/mktb/gov');
  const mk1 = G.newMasker();
  const masked = mk1.mask('Ravi 9848012345 ravi.k@gmail.com PAN ABCDE1234F aadhaar 2345 6789 0123 worked 2018 2019 2020 salary 1200000');
  check('phone, e-mail, PAN, Aadhaar are masked; years and salary are not', !/9848012345|ravi\.k@|ABCDE1234F|2345 6789 0123/.test(masked) && /2018 2019 2020/.test(masked) && /1200000/.test(masked), masked);
  check('the answer gets the real values back', mk1.unmask('Call [PHONE_4] or mail [EMAIL_1]').includes('9848012345') || mk1.unmask(masked).includes('9848012345'), mk1.unmask(masked));
  const pledge = await call('GET', `${M}/gov/pledge`, null, tR);
  check('the no-training pledge and a masking example are readable by staff', pledge.status === 200 && pledge.body.pledge.length >= 4 && !/9848012345/.test(pledge.body.demo.after), pledge.body);
  check('09.04 / 09.06 outside profile data: connector stub says "Needs founder"', /Needs founder/.test(pledge.body.connectors.state));
  check('09.19 ISO 42001: marked not buildable in code', /Not buildable/.test(pledge.body.iso42001.state));

  section('02.12 skills from the JD (+ 09.16 the AI call is logged)');
  const sk = await call('POST', `${M}/jobs/${job.id}/extract-skills`, { useAi: true }, tR);
  check('must-have and good-to-have skills are read from the JD', sk.status === 200 && sk.body.mandatory.includes('java') && sk.body.goodToHave.includes('docker'), sk.body);
  const logs = await sql('SELECT * FROM "AiCallLog" WHERE "userId" = ? ORDER BY "at" DESC', REC.id);
  check('09.16 the AI call is logged: who, purpose, outcome, size (never the text)', logs.length >= 1 && logs[0].purpose === 'Skills from JD' && logs[0].userName === REC.name && ['failed', 'refused', 'ok'].includes(logs[0].outcome) && Number(logs[0].inChars) > 0 && !('text' in logs[0]), logs[0]);
  const calls = await call('GET', `${M}/gov/calls`, null, tA);
  check('Admin reads the AI call log; a recruiter cannot', calls.status === 200 && calls.body.rows.length >= 1 && (await call('GET', `${M}/gov/calls`, null, tR)).status === 403);

  section('09.21 AI credits / metering');
  check('only an Admin sets the monthly limit', (await call('PUT', `${M}/settings`, { key: 'ai.monthlyLimit', value: 1 }, tR)).status === 403);
  check('Admin sets a limit of 1 call a month', (await call('PUT', `${M}/settings`, { key: 'ai.monthlyLimit', value: 1 }, tA)).body.value === 1);
  await sql('INSERT INTO "AiCallLog" ("id","at","userId","userName","purpose","outcome") VALUES (?,?,?,?,?,?)', `x${P}`, new Date().toISOString(), REC.id, REC.name, 'Test', 'ok');
  const sk2 = await call('POST', `${M}/jobs/${job.id}/extract-skills`, { useAi: true }, tR);
  const lim = await sql('SELECT * FROM "AiCallLog" WHERE "userId" = ? AND "outcome" = \'limit\'', REC.id);
  check('over the limit: the feature still answers from its rules, the call is logged as "limit"', sk2.status === 200 && sk2.body.mandatory.includes('java') && lim.length === 1, { s: sk2.status, lim });
  const sum = await call('GET', `${M}/gov/summary`, null, tA);
  check('usage per login is shown with what is left', sum.status === 200 && sum.body.byUser.some((u) => u.userId === REC.id && u.left === 0), sum.body.byUser);
  await call('PUT', `${M}/settings`, { key: 'ai.monthlyLimit', value: 0 }, tA);

  section('09.03 flag / override AI output');
  const fl = await call('POST', `${M}/gov/flags`, { feature: 'Skills from JD', kind: 'Wrong', reason: 'Docker is a must-have here', output: 'docker: good to have' }, tR);
  check('a recruiter flags an AI output with a reason', fl.status === 201 && !!fl.body.id, fl.body);
  check('a flag needs a reason', (await call('POST', `${M}/gov/flags`, { feature: 'x', reason: '' }, tR)).status === 400);
  check('only an Admin closes a flag', (await call('POST', `${M}/gov/flags/${fl.body.id}/close`, null, tR)).status === 403 && (await call('POST', `${M}/gov/flags/${fl.body.id}/close`, null, tA)).status === 200);

  section('02.09 client-specific hiring process');
  check('a recruiter cannot change a client pipeline', (await call('PUT', `${M}/clients/${job.clientId}/pipeline`, { stages: {} }, tR)).status === 403);
  check('a step the offer / joining flows need cannot be switched off', (await call('PUT', `${M}/clients/${job.clientId}/pipeline`, { stages: { JOINED: { enabled: false } } }, tA)).status === 400);
  const cp = await call('PUT', `${M}/clients/${job.clientId}/pipeline`, { stages: { RECRUITER_REVIEW: { enabled: false }, TL_REVIEW: { approverRole: 'STL' } }, rounds: ['Technical', 'HR', 'MD round'], notes: 'Two references needed' }, tA);
  check('Admin saves the client\'s own pipeline + rounds', cp.status === 200 && cp.body.stages.RECRUITER_REVIEW.enabled === false && cp.body.rounds.length === 3, cp.body);
  const DP = require('../src/utils/deptPipelines');
  const existing = await prisma.application.findUnique({ where: { id: app1.id }, include: { candidate: true, requirement: { include: { client: true } } } });
  const g1 = await DP.gate(existing, 'RECRUITER_REVIEW', await resolveIdentity(REC.id));
  const g2 = await DP.gate(existing, 'TL_REVIEW', await resolveIdentity(TL.id));
  check('moving into a step this client does not use is refused (client rule first)', g1 && g1.status === 409 && g1.body.code === 'CLIENT_STAGE_OFF', g1);
  check('a step that needs STL approval stops a TL', g2 && g2.status === 403 && g2.body.code === 'APPROVAL_REQUIRED', g2);
  check('an Admin is not stopped', (await DP.gate(existing, 'RECRUITER_REVIEW', await resolveIdentity(adminRow.id))) === null);
  const ov = await call('GET', `${M}/jobs/${job.id}/overview`, null, tR);
  check('the requirement page shows the client\'s interview rounds', ov.status === 200 && ov.body.clientProcess.rounds.includes('MD round'), ov.body.clientProcess);
  await call('PUT', `${M}/clients/${job.clientId}/pipeline`, { stages: {}, rounds: ['Technical', 'HR', 'MD round'] }, tA);

  section('02.10 screening / knockout questions');
  const qs = [{ id: 'q1', text: 'Do you have a valid passport?', type: 'yesno', knockout: { op: 'eq', value: 'yes' } }, { id: 'q2', text: 'Years of Java?', type: 'number', knockout: { op: 'min', value: 3 } }];
  check('a Manager (view only) cannot set questions', (await call('PUT', `${M}/jobs/${job.id}/screening`, { questions: qs }, tM)).status === 403);
  const sv = await call('PUT', `${M}/jobs/${job.id}/screening`, { questions: qs, action: 'hold' }, tR);
  check('the recruiter of the job sets questions with knockout answers', sv.status === 200 && sv.body.questions.length === 2 && sv.body.action === 'hold', sv.body);
  check('another team\'s recruiter cannot reach the job', (await call('PUT', `${M}/jobs/${job.id}/screening`, { questions: qs }, tR2)).status === 404);
  await prisma.requirement.update({ where: { id: job.id }, data: { portalPublished: true } });
  const pub = await call('GET', `/public/mkt/jobs/${job.id}/screening`);
  check('the public form gets the questions but never the knockout answers', pub.status === 200 && pub.body.questions.length === 2 && !JSON.stringify(pub.body).includes('knockout'), pub.body);
  const ans = await call('POST', `${M}/applications/${app1.id}/screening`, { answers: { q1: 'no', q2: '5' } }, tR);
  check('a failing answer flags the application and (hold) puts it on hold', ans.status === 200 && ans.body.failed.length === 1 && ans.body.held === true && (await prisma.application.findUnique({ where: { id: app1.id } })).stage === 'HOLD', ans.body);
  const rq = await call('GET', `${M}/gov/reviews`, null, tR);
  const item = (rq.body.rows || []).find((r) => r.applicationId === app1.id && r.kind === 'Knockout hold');
  check('09.17 the automatic hold waits in the human review queue (scoped)', !!item && !(await call('GET', `${M}/gov/reviews`, null, tR2)).body.rows.some((r) => r.applicationId === app1.id), rq.body);
  check('overturning needs a reason', (await call('POST', `${M}/gov/reviews/${item.id}`, { decision: 'Overturned' }, tR)).status === 400);
  const over = await call('POST', `${M}/gov/reviews/${item.id}`, { decision: 'Overturned', note: 'Passport is being renewed' }, tR);
  check('overturning puts the application back where it was', over.status === 200 && (await prisma.application.findUnique({ where: { id: app1.id } })).stage === 'NEW', over.body);
  const sa = await call('GET', `${M}/jobs/${job.id}/screening/answers`, null, tR);
  check('the job lists the screening answers with the failed ones', sa.status === 200 && sa.body.rows.some((r) => r.applicationId === app1.id && r.failed.length === 1));

  section('02.13 job intake assistant');
  const note = `From: hr@client.com\nSubject: Need Java developers\nHi, we need 3 Java Developers for ${job.client.name}, 4-7 years, Hyderabad, notice 30 days. Skills: spring boot, microservices, sql. Call me on 9848012345.\nRegards, Kiran`;
  const ik = await call('POST', `${M}/intake`, { text: note }, tR);
  check('a call note / e-mail becomes a requirement draft (title, client, experience, skills)', ik.status === 200 && /java/i.test(ik.body.draft.title) && ik.body.draft.clientId === job.clientId && ik.body.draft.expMin === 4 && /spring boot/.test(ik.body.draft.skills), ik.body);
  check('contact details in the note are left out of the draft', !JSON.stringify(ik.body).includes('9848012345') && !JSON.stringify(ik.body).includes('hr@client.com'));
  check('a Manager cannot run the intake (view only)', (await call('POST', `${M}/intake`, { text: note }, tM)).status === 403);

  section('02.14 always-on search');
  const w1 = await call('GET', `${M}/jobs/${job.id}/watch`, null, tA);
  check('the job keeps its matching people (first look: nothing is "new")', w1.status === 200 && typeof w1.body.total === 'number' && w1.body.newCount === 0, { s: w1.status, n: w1.body && w1.body.newCount });
  const C3 = await mkCand('three', { skills: 'java, spring boot, sql, hibernate' });
  const w2 = await call('GET', `${M}/jobs/${job.id}/watch`, null, tA);
  check('a new matching person is flagged as new', w2.body.rows.some((r) => r.id === C3.id && r.isNew) && w2.body.newCount >= 1, { n: w2.body.newCount, rows: w2.body.rows.slice(0, 3) });
  const w3 = await call('GET', `${M}/jobs/${job.id}/watch?seen=1`, null, tA);
  const w4 = await call('GET', `${M}/jobs/${job.id}/watch`, null, tA);
const wr = await call('GET', `${M}/jobs/${job.id}/watch`, null, tR);
  check('a recruiter list holds only people in their own scope', wr.status === 200 && !wr.body.rows.some((r) => r.id === C3.id));
  check('after "mark as seen" nothing is new', w3.status === 200 && w4.body.newCount === 0);
  check('the BDE team gets no matching list', (await call('GET', `${M}/jobs/${job.id}/watch`, null, tB)).status === 403);

  section('02.16 posting rules');
  check('a recruiter cannot add a posting rule', (await call('POST', `${M}/posting-rules`, { department: dept, sources: ['TeamLink Job Portal'] }, tR)).status === 403);
  const pr = await call('POST', `${M}/posting-rules`, { name: `${dept} jobs`, department: dept, sources: ['TeamLink Job Portal', 'Naukri'] }, tA);
  const pr2 = await call('POST', `${M}/posting-rules`, { name: 'This client', clientId: job.clientId, sources: ['TeamLink Website'] }, tA);
  const rf = await call('GET', `${M}/jobs/${job.id}/posting-rule`, null, tR);
  check('the most specific rule wins (client over department)', pr.status === 201 && pr2.status === 201 && rf.body.rule && rf.body.rule.id === pr2.body.id && rf.body.rule.sources.includes('TeamLink Website'), rf.body);
  await call('DELETE', `${M}/posting-rules/${pr2.body.id}`, null, tA);
  check('...and the department rule applies once the client rule is gone', (await call('GET', `${M}/jobs/${job.id}/posting-rule`, null, tR)).body.rule.id === pr.body.id);

  section('03.02 scanned resumes waiting for OCR');
  await prisma.candidateResume.create({ data: { candidateId: C1.id, kind: 'ORIGINAL', fileName: 'scan.pdf', file: 'nofile0123456789abcdef0123456789.pdf', text: '' } });
  const oc = await call('GET', `${M}/ocr`, null, tA);
  check('Admin sees how many scanned resumes still have no text', oc.status === 200 && oc.body.waiting >= 1, oc.body);
  const orr = await call('POST', `${M}/ocr/rerun`, { limit: 2 }, tA);
  check('reading them again says plainly when OCR is not installed (else reads them)', orr.status === 200 && (orr.body.notInstalled === true || typeof orr.body.read === 'number'), orr.body);
  check('a recruiter cannot run it', (await call('POST', `${M}/ocr/rerun`, {}, tR)).status === 403);

  section('03.05 custom-field parsing agent');
  const PD = require('../src/utils/candidateProfileDepth');
  const fld = await PD.createField({ label: `Blood group ${P}`, type: 'text' }, { name: 'test' });
  await prisma.candidateResume.create({ data: { candidateId: C1.id, kind: 'ORIGINAL', fileName: 'cv.pdf', text: `Ravi Kumar\nJava developer\nBlood group ${P}: O+\nSkills: Java`, parsed: JSON.stringify({ location: 'Hyderabad', skills: ['java', 'kafka'], highestEducation: 'B.Tech' }) } });
  check('only an Admin adds a field rule', (await call('POST', `${M}/field-rules`, { fieldId: fld.id, method: 'label' }, tR)).status === 403);
  check('Admin adds a "label in the resume" rule', (await call('POST', `${M}/field-rules`, { fieldId: fld.id, method: 'label' }, tA)).status === 201);
  const pf = await call('GET', `${M}/candidates/${C1.id}/parse-fields?ai=0`, null, tR);
  const prop = (pf.body.proposals || []).find((x) => x.fieldId === fld.id);
  check('the agent reads the value from the resume', prop && prop.value === 'O+', pf.body);
  const ap = await call('POST', `${M}/candidates/${C1.id}/parse-fields/apply`, { values: { [fld.id]: 'O+' } }, tR);
  check('applying it saves the custom field', ap.status === 200 && ap.body.saved === 1 && (await PD.customValuesOf(C1.id)).get(fld.id).value === 'O+', ap.body);

  section('03.08 natural-language search');
  const nl = await call('POST', `${M}/nl-search`, { query: 'java developers in hyderabad 5+ years notice 30 days' }, tR);
  const chips = Object.fromEntries((nl.body.chips || []).map((c) => [c.key, c.value]));
  check('the words become filters and the filters are shown', nl.status === 200 && /java/.test(chips.skills) && chips.location === 'Hyderabad' && chips.exp === '5+ years' && /30 days/.test(chips.notice), nl.body.chips);
  check('results are people in this login\'s scope who fit', nl.body.rows.some((r) => r.id === C1.id) && !nl.body.rows.some((r) => r.id === C2.id), nl.body.rows.slice(0, 3));
  check('another team\'s recruiter does not find them', !(await call('POST', `${M}/nl-search`, { query: 'java developers in hyderabad 5+ years' }, tR2)).body.rows.some((r) => r.id === C1.id));
  check('a link opens the same filters in the Candidates list', /\/candidates\?view=master.*skills=/.test(nl.body.link), nl.body.link);

  section('03.09 saved searches and alerts');
  const ss = await call('POST', `${M}/saved-searches`, { name: 'Hyd java', query: 'java developers in hyderabad 3+ years', alert: true }, tA);
  check('a search is saved', ss.status === 201, ss.body);
  const C4 = await mkCand('four');
  const run = await call('GET', `${M}/saved-searches/${ss.body.id}/run`, null, tA);
  check('people new since the last look are flagged', run.status === 200 && run.body.rows.some((r) => r.id === C4.id && r.isNew), { n: run.body.newCount });
  check('another login cannot open a private saved search', (await call('GET', `${M}/saved-searches/${ss.body.id}/run`, null, tR2)).status === 404);
  const C = require('../src/utils/mktb/cands');
  const sw = await C.savedSweep();
  const bells = await prisma.notification.count({ where: { userId: adminRow.id, title: { contains: 'New matches: Hyd java' } } }).catch(() => 0);
  check('alerts stay OFF until the Admin switch is on (no bell)', sw.searches >= 1 && bells === 0, { sw, bells });

  section('03.10 talent pools');
  const pl = await call('POST', `${M}/pools`, { name: 'Java bench' }, tR);
  check('a recruiter makes a pool; a Manager cannot', pl.status === 201 && (await call('POST', `${M}/pools`, { name: 'x' }, tM)).status === 403);
  const add = await call('POST', `${M}/pools/${pl.body.id}/members`, { candidateIds: [C1.id, C2.id, C4.id] }, tR);
  check('many people are added at once (only people in the login scope)', add.status === 200 && add.body.added === 2 && add.body.skipped === 1, add.body);
  check('another recruiter cannot see a private pool', (await call('GET', `${M}/pools/${pl.body.id}`, null, tR2)).status === 404);
  await call('PUT', `${M}/pools/${pl.body.id}`, { shared: true }, tR);
  const shared = await call('GET', `${M}/pools/${pl.body.id}`, null, tR2);
  check('shared: others see it, but only the people in their own scope', shared.status === 200 && shared.body.rows.length === 0 && shared.body.hidden === 2, shared.body);
  const rm = await call('POST', `${M}/pools/${pl.body.id}/members/remove`, { candidateIds: [C2.id] }, tR);
  check('bulk remove', rm.body.removed === 1 && (await call('GET', `${M}/pools/${pl.body.id}`, null, tR)).body.rows.length === 1);

  section('03.12 profile enrichment (own resume only)');
  await prisma.candidate.update({ where: { id: C1.id }, data: { location: null, education: null } });
  const en = await call('GET', `${M}/candidates/${C1.id}/enrich`, null, tR);
  check('empty fields are proposed from the person\'s own resume', en.status === 200 && en.body.proposals.some((p) => p.field === 'location' && p.value === 'Hyderabad') && en.body.proposals.some((p) => p.field === 'skills' && /kafka/.test(p.value)), en.body);
  const ea = await call('POST', `${M}/candidates/${C1.id}/enrich`, { fields: { location: 'Hyderabad', education: 'B.Tech' } }, tR);
  check('the recruiter applies them', ea.status === 200 && (await prisma.candidate.findUnique({ where: { id: C1.id } })).education === 'B.Tech');
  check('the BDE team cannot', (await call('GET', `${M}/candidates/${C1.id}/enrich`, null, tB)).status === 403);

  section('03.17 profile-update link + 03.13 job change');
  const ln = await call('POST', `${M}/candidates/${C1.id}/update-link`, null, tR);
  const token = String(ln.body.url || '').split('/update-profile/')[1];
  check('a private link is made (nothing is sent by itself)', ln.status === 201 && token && token.length > 20, ln.body);
  const pv = await call('GET', `/public/mkt/profile/${token}`);
  check('the link shows the person\'s own details, never phone or e-mail', pv.status === 200 && pv.body.firstName === 'Mb' && !JSON.stringify(pv.body).includes(C1.phone) && !JSON.stringify(pv.body).includes('@'), pv.body);
  const ps = await call('POST', `/public/mkt/profile/${token}`, { currentCompany: 'Acme Labs', noticePeriod: '15 Days' });
  check('the person updates their record', ps.status === 200 && ps.body.changed === 2 && (await prisma.candidate.findUnique({ where: { id: C1.id } })).currentCompany === 'Acme Labs', ps.body);
  check('the link works once', (await call('POST', `/public/mkt/profile/${token}`, { noticePeriod: '0' })).status === 410);
  const jc = await call('GET', `${M}/job-changes`, null, tR);
  check('03.13 the job change is listed for the recruiter', jc.status === 200 && jc.body.rows.some((r) => r.candidateId === C1.id && r.to === 'Acme Labs'), jc.body);
  const st = await call('GET', `${M}/stale?days=1`, null, tR);
  check('03.13 the stale-profile list answers', st.status === 200 && Array.isArray(st.body.rows));
  check('03.13 the weekly stale-profile reminder stays OFF until the Admin switch', (await C.staleSweep()).off === true);

  section('03.18 documents with expiry');
  const doc = await prisma.candidateDocument.create({ data: { candidateId: C1.id, docType: 'ID', name: 'Passport' } });
  check('a bad date is refused', (await call('PUT', `${M}/documents/${doc.id}/expiry`, { expiresOn: '31/12/2020' }, tR)).status === 400);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  check('an expiry date is set', (await call('PUT', `${M}/documents/${doc.id}/expiry`, { expiresOn: yesterday }, tR)).status === 200);
  const ex = await call('GET', `${M}/expiring-docs`, null, tR);
  check('it shows as Expired on the expiring list', ex.body.rows.some((r) => r.documentId === doc.id && r.state === 'Expired'), ex.body);
  check('another team\'s recruiter cannot set it', (await call('PUT', `${M}/documents/${doc.id}/expiry`, { expiresOn: yesterday }, tR2)).status === 404);

  section('03.20 fraudulent candidate detection');
  const F1 = await mkCand('fraud-a', { phone: `8${String(P).padStart(9, '7').slice(-9)}` });
  const F2 = await mkCand('fraud-b different', { name: `Zz Other Person ${tag}`, phone: `8${String(P).padStart(9, '7').slice(-9)}`, email: null });
  await prisma.application.create({ data: { candidateId: F1.id, requirementId: job.id, stage: 'REJECTED', ownerRecruiterId: REC.id, interviewFeedback: 'Looked like a proxy - someone else was answering' } });
  await prisma.application.create({ data: { candidateId: F2.id, requirementId: job.id, stage: 'NEW', ownerRecruiterId: REC.id } });
  check('a recruiter cannot run the scan', (await call('POST', `${M}/fraud/scan`, null, tR)).status === 403);
  const sc = await call('POST', `${M}/fraud/scan`, null, tT);
  const fr = await call('GET', `${M}/fraud`, null, tT);
  const sameP = (fr.body.rows || []).find((r) => r.kind === 'Same phone, different name' && [r.candidateId, r.otherCandidateId].includes(F1.id));
  check('same phone on different names is flagged', sc.status === 200 && !!sameP, { sc: sc.body, n: (fr.body.rows || []).length });
  check('proxy-interview words in feedback are flagged', (fr.body.rows || []).some((r) => r.kind === 'Proxy-interview signal' && r.candidateId === F1.id));
  check('clearing a flag needs a note', (await call('POST', `${M}/fraud/${sameP.id}`, { status: 'Cleared' }, tT)).status === 400);
  check('the TL clears it with a note (review queue)', (await call('POST', `${M}/fraud/${sameP.id}`, { status: 'Cleared', note: 'Brothers sharing a phone' }, tT)).status === 200);

  section('03.21 bulk AI profile review');
  const br = await call('POST', `${M}/bulk-review`, { candidateIds: [C1.id, C2.id], requirementId: job.id }, tR);
  const r1 = (br.body.rows || []).find((r) => r.candidateId === C1.id); const r2 = (br.body.rows || []).find((r) => r.candidateId === C2.id);
  check('each person gets a score from the facts with the reasons', br.status === 200 && r1 && r2 && r1.score > r2.score && r1.factors.length >= 4, br.body);
  check('the review is done in this login\'s scope only', (await call('POST', `${M}/bulk-review`, { candidateIds: [C1.id], requirementId: job.id }, tR2)).status === 404);

  section('09.17 bias testing of the new scorers');
  const fa = await call('GET', `${M}/gov/fairness`, null, tA);
  check('the paired name / gender test of the review and risk scores passes', fa.status === 200 && fa.body.pairs >= 12 && fa.body.failures === 0, fa.body);

  section('04.06 AI submission / pitch agent');
  const pt = await call('POST', `${M}/applications/${app1.id}/pitch`, { useAi: true }, tR);
  check('a submission note is drafted (rules when the AI is off) and waits as a Draft', pt.status === 201 && pt.body.status === 'Draft' && pt.body.text.includes(C1.name), pt.body);
  check('a Manager cannot approve it', (await call('POST', `${M}/pitches/${pt.body.id}`, { decision: 'Approved' }, tM)).status === 403);
  const apv = await call('POST', `${M}/pitches/${pt.body.id}`, { decision: 'Approved', text: `${pt.body.text}\nAvailable for a call this week.` }, tT);
  check('the TL approves (with an edit; the edit is logged as an override)', apv.status === 200 && (await sql('SELECT * FROM "AiFlag" WHERE "refId" = ?', pt.body.id)).length === 1, apv.body);
  check('a note is decided once', (await call('POST', `${M}/pitches/${pt.body.id}`, { decision: 'Rejected' }, tT)).status === 409);

  section('04.05 client submission packet + 03.15 / 09.12 formatted resume');
  const pk = await call('GET', `${M}/applications/${app1.id}/packet.pdf`, null, tR, true);
  check('the packet is one PDF', pk.status === 200 && /pdf/.test(pk.type) && pk.buf.slice(0, 5).toString() === '%PDF-', { s: pk.status, t: pk.type });
  const cr = await call('GET', `${M}/candidates/${C1.id}/client-resume`, null, tR);
  check('the client resume has no phone / e-mail', cr.status === 200 && !JSON.stringify(cr.body).includes(C1.phone) && !JSON.stringify(cr.body).includes(C1.email) && cr.body.skills.includes('java'), cr.body);
  const cp2 = await call('GET', `${M}/candidates/${C1.id}/client-resume.pdf?ai=1`, null, tR, true);
  check('the branded PDF is made (AI summary when it answers, rules otherwise)', cp2.status === 200 && cp2.buf.slice(0, 5).toString() === '%PDF-');
  check('out of scope: no resume', (await call('GET', `${M}/candidates/${C1.id}/client-resume.pdf`, null, tR2, true)).status === 404);

  section('04.09 auto-reject by rules (OFF by default)');
  check('a recruiter cannot add a global rule', (await call('POST', `${M}/auto-rules`, { kind: 'minExp', value: 3 }, tR)).status === 403);
  const ar = await call('POST', `${M}/auto-rules`, { kind: 'minExp', value: 3, scope: job.id }, tT);
  check('the TL adds a rule for the job', ar.status === 201, ar.body);
  const dry = await call('POST', `${M}/auto-reject/run`, { dryRun: true, requirementId: job.id }, tT);
  check('dry run lists who would be rejected, nothing changes', dry.status === 200 && dry.body.rows.some((r) => r.applicationId === app2.id) && !dry.body.rows.some((r) => r.applicationId === app1.id) && (await prisma.application.findUnique({ where: { id: app2.id } })).stage === 'NEW', dry.body);
  check('a real run is refused while the switch is OFF', (await call('POST', `${M}/auto-reject/run`, { dryRun: false, requirementId: job.id }, tA)).status === 409);
  await call('PUT', `${M}/settings`, { key: 'autoReject.on', value: true }, tA);
  const real = await call('POST', `${M}/auto-reject/run`, { dryRun: false, requirementId: job.id }, tA);
  check('switched on: the application is rejected with the rule as the reason', real.status === 200 && (await prisma.application.findUnique({ where: { id: app2.id } })).stage === 'REJECTED', real.body);
  const rv2 = (await call('GET', `${M}/gov/reviews`, null, tR)).body.rows.find((r) => r.applicationId === app2.id && r.kind === 'Auto-reject');
  check('...and it waits in the human review queue; overturn puts it back', !!rv2 && (await call('POST', `${M}/gov/reviews/${rv2.id}`, { decision: 'Overturned', note: 'Has 2 years of internship' }, tR)).status === 200 && (await prisma.application.findUnique({ where: { id: app2.id } })).stage === 'NEW');
  await call('PUT', `${M}/settings`, { key: 'autoReject.on', value: false }, tA);

  section('04.12 placement approval / 04.13 temp-to-perm');
  const joinedApp = await prisma.application.findFirst({ where: { stage: 'JOINED', requirement: { internal: false } }, orderBy: { updatedAt: 'desc' } });
  await prisma.application.update({ where: { id: joinedApp.id }, data: { joinedAt: new Date() } });
  const plc = await call('GET', `${M}/placements`, null, tA);
  check('joined placements are listed as waiting', plc.status === 200 && plc.body.on === false && plc.body.rows.some((r) => r.applicationId === joinedApp.id && r.status === 'Waiting'), { n: (plc.body.rows || []).length });
  check('a recruiter cannot approve a placement', (await call('POST', `${M}/placements/${joinedApp.id}`, { decision: 'Approved' }, tR)).status === 403);
  check('rejecting needs a reason', (await call('POST', `${M}/placements/${joinedApp.id}`, { decision: 'Rejected' }, tA)).status === 400);
  check('the Admin approves it', (await call('POST', `${M}/placements/${joinedApp.id}`, { decision: 'Approved' }, tA)).status === 200 && (await call('GET', `${M}/placements`, null, tA)).body.rows.find((r) => r.applicationId === joinedApp.id).status === 'Approved');
  await prisma.requirement.update({ where: { id: joinedApp.requirementId }, data: { jobPreference: 'Contract' } });
  const ct = await call('GET', `${M}/contracts`, null, tA);
  check('contract placements are listed', ct.status === 200 && ct.body.rows.some((r) => r.applicationId === joinedApp.id), { n: (ct.body.rows || []).length });
  check('conversion needs the date', (await call('PUT', `${M}/contracts/${joinedApp.id}`, { status: 'Converted' }, tA)).status === 400);
  check('the conversion is recorded', (await call('PUT', `${M}/contracts/${joinedApp.id}`, { status: 'Converted', convertedOn: '2026-11-01', newCtc: 900000, fee: 45000 }, tA)).status === 200 && (await call('GET', `${M}/contracts`, null, tA)).body.rows.find((r) => r.applicationId === joinedApp.id).status === 'Converted');

  section('04.14 backdoor-hire detection (shared util)');
  const BK = await mkCand('backdoor');
  const bApp = await prisma.application.create({ data: { candidateId: BK.id, requirementId: job.id, stage: 'REJECTED', ownerRecruiterId: REC.id } });
  await prisma.applicationStageEvent.create({ data: { applicationId: bApp.id, candidateId: BK.id, fromStage: 'BDE_APPROVED', toStage: 'SHARED_WITH_CLIENT', action: 'Shared with client' } });
  await prisma.candidate.update({ where: { id: BK.id }, data: { currentCompany: `${job.client.name} Pvt Ltd` } });
  const BH = require('../src/utils/backdoorHire');
  const det = await BH.detect({ clientId: job.clientId });
  check('a person we shared who now works at the client is detected', det.some((d) => d.candidateId === BK.id && d.signal === 'Current company'), det.slice(0, 2));
  const bd = await call('GET', `${M}/backdoor`, null, tT);
  check('the TL sees it; a recruiter cannot open the list', bd.status === 200 && bd.body.rows.some((d) => d.candidateId === BK.id) && (await call('GET', `${M}/backdoor`, null, tR)).status === 403);

  section('04.16 feedback blinding');
  await prisma.application.update({ where: { id: app1.id }, data: { interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() - 3600e3), interviewRound: 1 } });
  await prisma.interviewPanelist.create({ data: { applicationId: app1.id, round: 1, userId: TL.id, name: TL.name, overall: 'Strong in Java', recommendation: 'Selected', technical: 5, feedbackAt: new Date(), feedbackById: TL.id, feedbackByName: TL.name } });
  await prisma.interviewPanelist.create({ data: { applicationId: app1.id, round: 1, userId: REC.id, name: REC.name, position: 1 } });
  const PANEL = require('../src/utils/interviewPanel');
  const seenByRec = await G.runAs(await resolveIdentity(REC.id), () => PANEL.panelsFor([{ id: app1.id, interviewRound: 1 }]));
  const seenByAdmin = await G.runAs(await resolveIdentity(adminRow.id), () => PANEL.panelsFor([{ id: app1.id, interviewRound: 1 }]));
  check('a panelist who has not submitted does not see the other scores', seenByRec.get(app1.id).find((m) => m.userId === TL.id).feedback === null && seenByRec.get(app1.id).find((m) => m.userId === TL.id).blinded === true);
  check('someone not on the panel sees them', !!seenByAdmin.get(app1.id).find((m) => m.userId === TL.id).feedback);

  section('09.05 talent rediscovery');
  const RD = await mkCand('silver', { skills: 'java, spring boot, sql' });
  const other = await prisma.requirement.findFirst({ where: { id: { not: job.id }, status: 'OPEN', department: dept } }) || job;
  if (other.id !== job.id) {
    const oApp = await prisma.application.create({ data: { candidateId: RD.id, requirementId: other.id, stage: 'REJECTED' } });
    await prisma.applicationStageEvent.create({ data: { applicationId: oApp.id, candidateId: RD.id, fromStage: 'CLIENT_SHORTLISTED', toStage: 'INTERVIEW_COMPLETED', action: 'Interview done' } });
  }
  const rd = await call('GET', `${M}/jobs/${job.id}/rediscover`, null, tA);
  check('past people who did well are found for the job, with the reason', rd.status === 200 && (other.id === job.id || rd.body.rows.some((r) => r.id === RD.id && /interview/i.test(r.why))), rd.body.rows && rd.body.rows.slice(0, 3));

  section('09.08 task agents with an approval step / 09.09 orchestration');
  const ag = await call('POST', `${M}/agents/run`, { kind: 'followup', requirementId: job.id }, tR);
  check('the follow-up agent only proposes', ag.status === 201 && ag.body.actions.every((a) => a.status === 'Proposed'), ag.body);
  await prisma.candidate.update({ where: { id: C2.id }, data: { name: `  MB  TWO ${tag}  `, location: 'hyderabad' } });
  const cl = await call('POST', `${M}/agents/run`, { kind: 'cleanup' }, tR);
  const fix = (cl.body.actions || []).find((a) => a.refId === C2.id);
  check('the clean-up agent proposes the fix', cl.status === 201 && fix && fix.payload.fix.location === 'Hyderabad', cl.body.actions && cl.body.actions.slice(0, 2));
  check('nothing changes before approval', (await prisma.candidate.findUnique({ where: { id: C2.id } })).location === 'hyderabad');
  const dec = await call('POST', `${M}/agents/runs/${cl.body.id}/decide`, { ids: [fix.id], decision: 'Approved' }, tR);
  check('approved: the fix is done and recorded', dec.status === 200 && dec.body.done[0].status === 'Done' && (await prisma.candidate.findUnique({ where: { id: C2.id } })).location === 'Hyderabad', dec.body);
  check('a Manager cannot approve agent actions', (await call('POST', `${M}/agents/runs/${cl.body.id}/decide`, { decision: 'Approved' }, tM)).status === 403);
  const pb = await call('POST', `${M}/agents/run`, { kind: 'playbook', requirementId: job.id }, tA);
  check('09.09 the playbook runs its steps in order and stops at the approval step', pb.status === 201 && pb.body.steps.length === 4 && pb.body.steps[3].at === null && pb.body.status === 'Waiting for approval', pb.body.steps);
  const runsList = await call('GET', `${M}/agents/runs`, null, tR);
  check('a recruiter sees their own runs', runsList.status === 200 && runsList.body.rows.some((r) => r.id === cl.body.id) && !runsList.body.rows.some((r) => r.id === pb.body.id));

  section('09.10 workflow automation builder (OFF by default, dry run)');
  check('only an Admin builds workflows', (await call('POST', `${M}/workflows`, { trigger: { type: 'stage_entered', value: 'HOLD' } }, tR)).status === 403);
  const wf = await call('POST', `${M}/workflows`, { name: 'Tag the moved', trigger: { type: 'stage_entered', value: 'SHARED_WITH_CLIENT' }, action: { type: 'add_tag', value: `Shared ${P}` }, active: true }, tA);
  check('Admin saves "when X then Y"', wf.status === 201, wf.body);
  const wdry = await call('POST', `${M}/workflows/${wf.body.id}/run`, { dryRun: true }, tA);
  check('dry run lists what would happen and changes nothing', wdry.status === 200 && wdry.body.rows.some((r) => r.candidateId === BK.id) && !(await PD.tagsOf(BK.id)).some((t) => String(t.tag || t).includes(`Shared ${P}`)), { n: wdry.body.matched });
  check('a real run is refused while automations are OFF', (await call('POST', `${M}/workflows/${wf.body.id}/run`, { dryRun: false }, tA)).status === 409);
  await call('PUT', `${M}/settings`, { key: 'workflows.on', value: true }, tA);
  const wreal = await call('POST', `${M}/workflows/${wf.body.id}/run`, { dryRun: false }, tA);
  const wagain = await call('POST', `${M}/workflows/${wf.body.id}/run`, { dryRun: false }, tA);
  check('switched on: it acts once per event (logged)', wreal.status === 200 && wreal.body.rows.some((r) => r.candidateId === BK.id) && !wagain.body.rows.some((r) => r.candidateId === BK.id), { a: wreal.body.rows.length, b: wagain.body.rows.length });
  await call('PUT', `${M}/settings`, { key: 'workflows.on', value: false }, tA);

  section('09.11 data-health automations');
  const dh = await call('POST', `${M}/data-health/run`, {}, tT);
  check('the TL runs the data-health check (counts)', dh.status === 200 && dh.body.items.length >= 8 && dh.body.fixed === 0, dh.body.items && dh.body.items.slice(0, 2));
  check('only an Admin runs the auto-fix', (await call('POST', `${M}/data-health/run`, { fix: true }, tT)).status === 403);
  check('the nightly run and auto-fix start OFF', (await call('GET', `${M}/data-health`, null, tT)).body.schedule === false);

  section('09.20 attrition risk');
  const at = await call('GET', `${M}/attrition`, null, tA);
  check('joined people inside the guarantee get an explainable risk score', at.status === 200 && Array.isArray(at.body.rows) && at.body.rows.every((r) => Array.isArray(r.factors) && ['High', 'Medium', 'Low'].includes(r.level)), at.body.rows && at.body.rows[0]);
  const A = require('../src/utils/mktb/agents');
  const rs = A.riskScore({ candidate: { location: 'Chennai', currentSalary: '10' }, app: { offeredCtc: 1050000 }, job: { location: 'Hyderabad' }, jobs: [{ fromMonth: '2022-01', toMonth: '2022-09' }, { fromMonth: '2022-10', toMonth: '2023-06' }] });
  check('the factors explain the score (small rise, commute, short stays)', rs.level === 'High' && rs.factors.length === 3, rs);

  section('09.14 MCP server (read-only, token, OFF by default)');
  check('OFF by default: refused', (await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 403);
  check('no token can be made while it is OFF', (await call('POST', `${M}/mcp/tokens`, { label: 'x' }, tR)).status === 409);
  await call('PUT', `${M}/settings`, { key: 'mcp.on', value: true }, tA);
  const mt = await call('POST', `${M}/mcp/tokens`, { label: 'Claude Desktop' }, tR);
  check('a recruiter makes a token (shown once)', mt.status === 201 && /^mcp_/.test(mt.body.token));
  const mcp = async (method, params, t = mt.body.token) => { const r = await fetch(`${API}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; };
  check('no / wrong token: 401', (await mcp('tools/list', {}, 'mcp_wrong')).status === 401);
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  check('initialize answers with the tools capability', init.status === 200 && init.body.result.capabilities.tools && init.body.result.serverInfo.name === 'teamlink-ats');
  const tl = await mcp('tools/list', {});
  check('only read tools are offered', tl.body.result.tools.length === 4 && tl.body.result.tools.every((t) => /^(search|get|list)_/.test(t.name)));
  const tc = await mcp('tools/call', { name: 'search_candidates', arguments: { query: 'java developers in hyderabad 3+ years' } });
  const txt = tc.body.result.content[0].text;
  check('a search answers from the token owner\'s scope, never contact details', tc.body.result.structuredContent.people.some((p) => p.id === C1.id) && !txt.includes(C1.phone) && !txt.includes('@mb-cand.in'), txt.slice(0, 200));
  const mt2 = await call('POST', `${M}/mcp/tokens`, { label: 'other' }, tR2);
  const tc2 = await mcp('tools/call', { name: 'get_candidate', arguments: { id: C1.id } }, mt2.body.token);
  check('another team\'s token does not reach the person', /not in your scope/.test(tc2.body.result.content[0].text));
  await call('DELETE', `${M}/mcp/tokens/${mt.body.id}`, null, tR);
  check('a revoked token stops at once', (await mcp('tools/list', {})).status === 401);
  await call('PUT', `${M}/settings`, { key: 'mcp.on', value: false }, tA);

  section('09.15 AI compliance audit / 09.16 governance centre');
  const au = await call('POST', `${M}/gov/audit`, null, tA);
  check('Admin runs a compliance audit: a dated check-list with a score', au.status === 201 && au.body.checks.length >= 8 && typeof au.body.score === 'number', au.body);
  check('it is kept', (await call('GET', `${M}/gov/audits`, null, tA)).body.rows.some((r) => r.id === au.body.id));
  check('a recruiter cannot run it', (await call('POST', `${M}/gov/audit`, null, tR)).status === 403);
  const sets = await call('GET', `${M}/settings`, null, tM);
  check('switches: a Manager may look, every notify / automate switch is OFF by default', sets.status === 200 && sets.body.mayEdit === false && sets.body.switches.filter((s) => /alerts\.|autoReject|workflows|mcp|placement|dataHealth/.test(s.key)).every((s) => s.def === false));
  const clientUser = await prisma.user.findFirst({ where: { role: 'CLIENT', status: 'Active' } });
  if (clientUser) check('a client login gets 403 on the tools', (await call('GET', `${M}/pools`, null, await tok(clientUser.id))).status === 403);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
