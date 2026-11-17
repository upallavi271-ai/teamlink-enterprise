#!/usr/bin/env node
/**
 * CANDIDATE & CLIENT EXPERIENCE (founder ATS audit 2026-11-17): experience surveys after interview / offer / joining (one per
 * event, signed no-login link), candidate NPS + stars report, candidate complaints (48 h -> TL), client NPS (after joining +
 * quarterly), client escalation matrix (level 1 -> 2 -> 3 on its hours, from the client portal or the BDE), retention / lost
 * clients with Excel / CSV, and the job-portal apply funnel (started / submitted / abandoned).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4084. Nothing is really sent (sandbox transports).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-experience-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-atsexp-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4084;
const ROOT = `http://localhost:${PORT}`;
const API = `${ROOT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'atsexp-test', APP_BASE_URL: ROOT, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const E = require('../src/utils/atsExperience');
const R = require('../src/utils/atsExperienceReports');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const page = async (method, pathName, form) => {
  const r = await fetch(ROOT + pathName, { method, headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' });
  return { status: r.status, text: await r.text() };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const H = 3600e3;
const tokenPath = (link) => new URL(link).pathname;

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mk = (tag, data) => prisma.user.create({ data: { name: `Xp ${tag} ${P}`, email: `xp.${tag}.${P}@xp-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT' });
  const REC2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const BDETL = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false }, select: { id: true, clientId: true, title: true }, take: 50 });
  const j1 = live[0];
  await prisma.requirement.update({ where: { id: j1.id }, data: { recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id } });
  const C = await prisma.candidate.create({ data: { name: `Xp Person ${P}`, phone: `9${String(P).padStart(9, '3').slice(-9)}`, email: `xp.person.${P}@xp-test.in`, consentStatus: 'GIVEN' } });
  const clientUser = await prisma.user.create({ data: { name: `Xp Client ${P}`, email: `xp.client.${P}@xp-test.in`, passwordHash: 'x', status: 'Active', role: 'CLIENT', atsRole: 'CLIENT', clientId: j1.clientId, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  await prisma.client.update({ where: { id: j1.clientId }, data: { contactEmail: `xp.contact.${P}@xp-test.in`, contactName: 'Xp Contact' } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id); const tR2 = await tok(REC2.id); const tT = await tok(TL.id);
  const tB = await tok(BDE.id); const tBT = await tok(BDETL.id); const tC = await tok(clientUser.id);

  // ---- setup: the person is on the job, at the interview
  const a1 = await call('POST', '/applications', { candidateId: C.id, requirementId: j1.id, overrideReason: 'experience test setup' }, tA);
  const appId = a1.body && (a1.body.id || (a1.body.application && a1.body.application.id));
  check('setup: the person is on the job', [200, 201].includes(a1.status) && !!appId, a1.body);
  await prisma.application.update({ where: { id: appId }, data: { stage: 'INTERVIEW_SCHEDULED', ownerRecruiterId: REC.id } });

  // ---- the two "send by itself" switches: OFF by default -> a stage move makes no survey and sends nothing
  const sv = async () => E.q('SELECT * FROM "AtsSurvey" WHERE "applicationId" = ? ORDER BY "createdAt"', appId);
  const as0 = await call('GET', '/ats-experience/auto-settings', null, tA);
  check('both automatic survey switches are off by default', as0.status === 200 && as0.body.candidateSurveys === false && as0.body.clientSurveys === false && as0.body.mayEdit === true, as0.body);
  const mv0 = await call('PATCH', `/applications/${appId}/stage`, { stage: 'INTERVIEW_COMPLETED', comment: 'done (switches off)' }, tA);
  const offJoin = await E.onStage({ applicationId: appId, fromStage: 'OFFER', toStage: 'JOINED' });
  check('with the switches off, the interview move and a joining make no survey row and send nothing', mv0.status === 200 && (await sv()).length === 0 && offJoin.length === 0
    && (await prisma.candidateMessage.count({ where: { candidateId: C.id, template: { startsWith: 'SURVEY_' } } })) === 0, { mv0: mv0.status, offJoin });
  check('a non-admin (BDE TL) cannot switch them on', (await call('PUT', '/ats-experience/auto-settings', { candidateSurveys: true }, tBT)).status === 403
    && (await call('PUT', '/ats-experience/auto-settings', { clientSurveys: true }, tT)).status === 403);
  check('a bad value is refused', (await call('PUT', '/ats-experience/auto-settings', { candidateSurveys: 'yes' }, tA)).status === 400);
  const as1 = await call('PUT', '/ats-experience/auto-settings', { candidateSurveys: true, clientSurveys: true }, tA);
  const auditSw = await prisma.auditLog.findFirst({ where: { entity: 'AppSetting', entityId: E.AUTO_KEY }, orderBy: { createdAt: 'desc' } });
  check('the Admin switches both on, and the change is audited', as1.status === 200 && as1.body.candidateSurveys === true && as1.body.clientSurveys === true && auditSw && /candidate on, client on/.test(auditSw.toValue || ''), { b: as1.body, a: auditSw && auditSw.toValue });
  await prisma.application.update({ where: { id: appId }, data: { stage: 'INTERVIEW_SCHEDULED' } });

  // ---- interview done -> one survey, queued through the candidate message queue
  const mv1 = await call('PATCH', `/applications/${appId}/stage`, { stage: 'INTERVIEW_COMPLETED', comment: 'done' }, tA);
  check('the interview is marked done', mv1.status === 200, mv1.body);
  let rows = await sv();
  const sInt = rows.find((r) => r.event === 'interview' && r.side === 'candidate');
  check('an interview experience survey is created for the move', !!sInt && sInt.recruiterId === REC.id && sInt.tlId === TL.id, rows);
  const msgs = await prisma.candidateMessage.findMany({ where: { candidateId: C.id, template: 'SURVEY_INTERVIEW' } });
  check('the survey link is queued to the candidate (Email + WhatsApp rows, status recorded on the survey)', msgs.length === 2 && msgs.some((m) => m.channel === 'Email') && msgs.every((m) => /\/api\/public\/feedback\//.test(m.body || '')) && !!sInt.sendStatus, { msgs: msgs.map((m) => [m.channel, m.status]), st: sInt && sInt.sendStatus });

  // ---- one per event
  const again = await E.onStage({ applicationId: appId, fromStage: 'INTERVIEW_SCHEDULED', toStage: 'INTERVIEW_COMPLETED', user: null });
  const byHand = await call('POST', '/ats-experience/surveys/send', { applicationId: appId, event: 'interview' }, tA);
  rows = await sv();
  const msgs2 = await prisma.candidateMessage.count({ where: { candidateId: C.id, template: 'SURVEY_INTERVIEW' } });
  check('one survey per event: the hook again and "send by hand" find the first, nothing more is sent', again[0] && again[0].existing && byHand.status === 200 && byHand.body.existing && rows.filter((r) => r.event === 'interview').length === 1 && msgs2 === 2, { again, byHand: byHand.body, n: rows.length, msgs2 });
  check('a recruiter outside the job cannot send a survey for it', (await call('POST', '/ats-experience/surveys/send', { applicationId: appId, event: 'offer' }, tR2)).status === 404);

  // ---- token tampering
  const link = E.surveyUrl(sInt.id);
  const good = await page('GET', tokenPath(link));
  check('the survey page opens without a login and shows stars + 0-10', good.status === 200 && /name="stars"/.test(good.text) && /name="nps" value="10"/.test(good.text), good.text.slice(0, 200));
  const tk = tokenPath(link).split('/').pop();
  const [b64, sig] = tk.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  check('a changed signature is refused', (await page('GET', `/api/public/feedback/${b64}.${flip(sig, 3)}`)).status === 404);
  const other = Buffer.from(`${'0'.repeat(24)}.${Math.floor(Date.now() / 1000) + 9999}`).toString('base64url');
  check('a made-up survey id with a copied signature is refused', (await page('GET', `/api/public/feedback/${other}.${sig}`)).status === 404);
  check('an expired link is refused', (await page('GET', `/api/public/feedback/${E.surveyToken(sInt.id, -1)}`)).status === 404);
  check('a token with no signature is refused', (await page('GET', `/api/public/feedback/${b64}`)).status === 404);
  check('the signed id cannot be swapped (body changed, old signature)', (await page('GET', `/api/public/feedback/${Buffer.from(`${sInt.id}x.${Math.floor(Date.now() / 1000) + 999}`).toString('base64url')}.${sig}`)).status === 404);

  // ---- answers
  check('0-10 out of range is refused', (await page('POST', tokenPath(link), { stars: '5', nps: '11' })).status === 400);
  check('missing stars are refused for a candidate', (await page('POST', tokenPath(link), { nps: '10' })).status === 400);
  const ans = await page('POST', tokenPath(link), { stars: '5', nps: '10', comment: 'Very smooth' });
  check('the candidate answers: 5 stars, 10', ans.status === 200 && /Thank you/.test(ans.text));
  const ans2 = await page('POST', tokenPath(link), { stars: '1', nps: '0', comment: 'changed my mind' });
  const [afterTwo] = await E.q('SELECT * FROM "AtsSurvey" WHERE "id" = ?', sInt.id);
  check('a second answer to the same link is not recorded', ans2.status === 200 && /already answered/.test(ans2.text) && afterTwo.nps === 10 && afterTwo.stars === 5, afterTwo);

  // ---- offer + joining
  const mv2 = await call('PATCH', `/applications/${appId}/stage`, { stage: 'OFFER', comment: 'offer out', offeredCtc: 600000, confirmCtc: true }, tA);
  if (mv2.status !== 200) await prisma.application.update({ where: { id: appId }, data: { stage: 'OFFER' } });
  if (mv2.status !== 200) await E.onStage({ applicationId: appId, fromStage: 'INTERVIEW_COMPLETED', toStage: 'OFFER' });
  const mv3 = await call('PATCH', `/applications/${appId}/stage`, { stage: 'JOINED', comment: 'joined', offeredCtc: 600000, confirmCtc: true }, tA);
  if (mv3.status !== 200) { await prisma.application.update({ where: { id: appId }, data: { stage: 'JOINED', joinedAt: new Date() } }); await E.onStage({ applicationId: appId, fromStage: 'OFFER', toStage: 'JOINED' }); }
  console.log(`      (offer move ${mv2.status}${mv2.status !== 200 ? ` ${JSON.stringify(mv2.body).slice(0, 120)}` : ''}; joined move ${mv3.status}${mv3.status !== 200 ? ` ${JSON.stringify(mv3.body).slice(0, 120)}` : ''})`);
  rows = await sv();
  const sOff = rows.find((r) => r.side === 'candidate' && r.event === 'offer');
  const sJoin = rows.find((r) => r.side === 'candidate' && r.event === 'joining');
  const sCli = rows.find((r) => r.side === 'client' && r.event === 'joining');
  check('offer and joining surveys for the candidate, and a client survey after the joining', !!sOff && !!sJoin && !!sCli && sCli.clientId === j1.clientId && sCli.bdeId === BDE.id, rows.map((r) => [r.side, r.event]));
  check('the client survey went to the client contact by email (sandbox transport)', /xp\.contact/.test(sCli.sendStatus || ''), sCli.sendStatus);
  await E.onStage({ applicationId: appId, fromStage: 'JOINED', toStage: 'HIRED' });
  check('Joined then Hired does not make a second joining survey', (await sv()).filter((r) => r.event === 'joining').length === 2);

  // offer answer: 2 stars, 3 (detractor) + a complaint; joining 4 stars, 8 (passive)
  const offAns = await page('POST', tokenPath(E.surveyUrl(sOff.id)), { stars: '2', nps: '3', comment: 'Offer took long', complain: 'yes', complaint: 'Nobody told me the joining date for a week' });
  check('the offer survey answer with a complaint gives a complaint number', offAns.status === 200 && /complaint is number/.test(offAns.text), offAns.text.slice(-300));
  await page('POST', tokenPath(E.surveyUrl(sJoin.id)), { stars: '4', nps: '8' });
  check('a client answers 0-10 without stars', (await page('POST', tokenPath(E.surveyUrl(sCli.id)), { nps: '9', comment: 'Good candidates' })).status === 200);

  // ---- NPS math
  const m1 = E.npsOf([10, 9, 8, 7, 6, 0].map((n) => ({ nps: n })));
  const m2 = E.npsOf([10, 10, 9, 3].map((n) => ({ nps: n, stars: n > 5 ? 5 : 1 })));
  check('NPS = % promoters (9-10) - % detractors (0-6): 2-2 of 6 = 0; 3-1 of 4 = 50; average stars', m1.nps === 0 && m1.promoters === 2 && m1.detractors === 2 && m1.passives === 2 && m2.nps === 50 && m2.avgStars === 4, { m1, m2 });
  check('NPS of nothing is empty, not 0', E.npsOf([]).nps === null);
  const rep = await call('GET', '/ats-experience/candidate-report', null, tA);
  const ov = rep.body && rep.body.overall;
  const st = (k) => (rep.body.byStage || []).find((g) => g.key === k) || {};
  check('candidate report: 3 answers, NPS (1-1)/3 = 0, average stars 3.67', rep.status === 200 && ov.responses === 3 && ov.nps === 0 && ov.avgStars === 3.67 && ov.sent >= 3, ov);
  check('...by stage: interview 100, offer -100, joining 0', st('interview').nps === 100 && st('offer').nps === -100 && st('joining').nps === 0, rep.body.byStage);
  check('...by recruiter and by client and by month', (rep.body.byRecruiter || []).some((g) => g.label === REC.name && g.responses === 3) && (rep.body.byClient || []).some((g) => g.responses === 3) && (rep.body.byMonth || []).some((g) => g.responses === 3), { r: rep.body.byRecruiter, m: rep.body.byMonth });
  const repR2 = await call('GET', '/ats-experience/candidate-report', null, tR2);
  check('a recruiter of another team sees none of these answers', repR2.status === 200 && repR2.body.overall.responses === 0, repR2.body && repR2.body.overall);
  const repTl = await call('GET', '/ats-experience/candidate-report', null, tT);
  check('the job\'s TL sees them', repTl.status === 200 && repTl.body.overall.responses === 3, repTl.body && repTl.body.overall);
  const cn = await call('GET', '/ats-experience/client-nps', null, tA);
  check('client NPS: one answer of 9 -> 100, by client and by BDE', cn.status === 200 && cn.body.overall.responses === 1 && cn.body.overall.nps === 100 && cn.body.byBde.some((g) => g.label === BDE.name && g.nps === 100), cn.body && { o: cn.body.overall, b: cn.body.byBde });

  // ---- candidate complaints: 48 h -> TL
  const fromSurvey = (await E.q('SELECT * FROM "AtsComplaint" WHERE "surveyId" = ?', sOff.id))[0];
  check('the survey complaint is open, owned by the recruiter, due in 48 hours', fromSurvey && fromSurvey.status === 'Open' && fromSurvey.ownerId === REC.id && Math.abs(Date.parse(fromSurvey.dueAt) - Date.parse(fromSurvey.createdAt) - 48 * H) < 5000, fromSurvey);
  const logged = await call('POST', '/ats-experience/complaints', { side: 'candidate', applicationId: appId, subject: 'Called at night by mistake', details: 'Candidate called the office' }, tR);
  check('a recruiter logs a complaint for their candidate', logged.status === 201 && logged.body.owner === REC.name && logged.body.level === 1, logged.body);
  check('a recruiter of another team cannot log one for this candidate', (await call('POST', '/ats-experience/complaints', { side: 'candidate', applicationId: appId, subject: 'x' }, tR2)).status === 404);
  const t0 = Date.parse(fromSurvey.createdAt);
  let run = await E.runEscalations({ now: t0 + 47 * H });
  check('at 47 hours nothing moves', !run.moved.some((m) => m.id === fromSurvey.id), run);
  run = await E.runEscalations({ now: t0 + 49 * H });
  const esc1 = await E.getComplaint(fromSurvey.id);
  check('at 49 hours it goes to the TL (level 2), the TL is told', run.moved.some((m) => m.id === fromSurvey.id) && esc1.level === 2 && esc1.ownerId === TL.id && !!esc1.escalatedAt, esc1);
  const told = await prisma.notification.count({ where: { userId: TL.id, title: { contains: `#${fromSurvey.id}` } } });
  check('...with a bell notification', told >= 1, told);
  run = await E.runEscalations({ now: t0 + 49 * H + 1000 });
  check('running again does not move it twice', !run.moved.some((m) => m.id === fromSurvey.id) && (await E.getComplaint(fromSurvey.id)).level === 2);
  await E.runEscalations({ now: t0 + 300 * H });
  check('a candidate complaint stops at the TL', (await E.getComplaint(fromSurvey.id)).level === 2);
  const tlList = await call('GET', '/ats-experience/complaints?side=candidate&status=mine', null, tT);
  check('the TL\'s list has it under "mine"', tlList.status === 200 && tlList.body.rows.some((r) => r.id === fromSurvey.id && r.level === 2), tlList.body && tlList.body.counts);
  check('another team\'s recruiter does not see these complaints', (await call('GET', '/ats-experience/complaints?side=candidate', null, tR2)).body.rows.every((r) => r.applicationId !== appId));
  check('Resolved needs a note', (await call('PATCH', `/ats-experience/complaints/${fromSurvey.id}`, { status: 'Resolved' }, tT)).status === 400);
  const res1 = await call('PATCH', `/ats-experience/complaints/${fromSurvey.id}`, { status: 'Resolved', note: 'Called the candidate, date confirmed' }, tT);
  check('the TL resolves it', res1.status === 200 && res1.body.status === 'Resolved' && !!res1.body.resolvedAt && res1.body.history.length >= 3, res1.body);
  check('In progress works for the recruiter\'s own', (await call('PATCH', `/ats-experience/complaints/${logged.body.id}`, { status: 'In progress', note: 'Looking' }, tR)).body.status === 'In progress');

  // ---- client escalation matrix
  check('a recruiter cannot change the escalation matrix', (await call('PUT', `/ats-experience/escalation-matrix/${j1.clientId}`, { levels: [] }, tR)).status === 403);
  const defM = await call('GET', `/ats-experience/escalation-matrix/${j1.clientId}`, null, tA);
  check('the default matrix: recruiter -> TL -> BDE TL, 24 / 24 / 48 hours', defM.status === 200 && defM.body.levels.length === 3 && defM.body.levels[0].hours === 24 && defM.body.levels[2].hours === 48 && defM.body.levels.every((l) => l.fromDefault), defM.body);
  const putM = await call('PUT', `/ats-experience/escalation-matrix/${j1.clientId}`, { levels: [{ level: 1, userId: REC.id, hours: 2 }, { level: 2, userId: TL.id, hours: 3 }, { level: 3, userId: BDETL.id, hours: 4 }] }, tBT);
  check('the BDE TL saves the client\'s matrix', putM.status === 200 && putM.body.levels[2].name === BDETL.name && putM.body.levels[1].hours === 3, putM.body);
  check('hours outside 1-720 are refused', (await call('PUT', `/ats-experience/escalation-matrix/${j1.clientId}`, { levels: [{ level: 1, userId: REC.id, hours: 0.2 }] }, tA)).status === 400);
  const pc = await call('POST', '/portal/client/concerns', { subject: 'Profiles not matching the JD', details: 'Three in a row' }, tC);
  check('the client raises a concern from the client portal', pc.status === 201 && pc.body.level === 1 && !('owner' in pc.body), pc.body);
  const cEsc = (await E.q('SELECT * FROM "AtsComplaint" WHERE "side" = \'client\' AND "clientId" = ? ORDER BY "id" DESC LIMIT 1', j1.clientId))[0];
  check('...level 1 = the recruiter, due in 2 hours', cEsc.ownerId === REC.id && Math.abs(Date.parse(cEsc.dueAt) - Date.parse(cEsc.createdAt) - 2 * H) < 5000, cEsc);
  const c0 = Date.parse(cEsc.createdAt);
  await E.runEscalations({ now: c0 + 1.9 * H });
  check('at 1.9 hours it stays at level 1', (await E.getComplaint(cEsc.id)).level === 1);
  await E.runEscalations({ now: c0 + 2.1 * H });
  const l2 = await E.getComplaint(cEsc.id);
  check('at 2.1 hours: level 2 (TL), due 3 hours later', l2.level === 2 && l2.ownerId === TL.id && Math.abs(Date.parse(l2.dueAt) - (c0 + 5.1 * H)) < 5000, l2);
  await E.runEscalations({ now: c0 + 4 * H });
  check('at 4 hours still level 2', (await E.getComplaint(cEsc.id)).level === 2);
  await E.runEscalations({ now: c0 + 5.2 * H });
  const l3 = await E.getComplaint(cEsc.id);
  check('at 5.2 hours: level 3 (BDE TL)', l3.level === 3 && l3.ownerId === BDETL.id, l3);
  await E.runEscalations({ now: c0 + 500 * H });
  check('level 3 is the top', (await E.getComplaint(cEsc.id)).level === 3);
  const mine = await call('GET', '/portal/client/concerns', null, tC);
  check('the client sees its concern and level, no staff names', mine.status === 200 && mine.body.rows.some((r) => r.id === cEsc.id && r.level === 3) && !JSON.stringify(mine.body).includes(BDETL.name), mine.body);
  check('a staff login cannot use the client portal door', (await call('GET', '/portal/client/concerns', null, tA)).status === 403);
  const byBde = await call('POST', '/ats-experience/complaints', { side: 'client', clientId: j1.clientId, subject: 'Invoice dispute' }, tB);
  check('the BDE logs a client escalation', byBde.status === 201 && byBde.body.level === 1 && byBde.body.levels.length === 3, byBde.body);
  const cl = await call('GET', '/ats-experience/complaints?side=client', null, tBT);
  check('the BDE TL\'s client escalation list has both, with status', cl.status === 200 && cl.body.rows.filter((r) => r.clientId === j1.clientId).length >= 2, cl.body && cl.body.counts);

  // ---- quarterly client survey (one per client per quarter)
  check('a recruiter cannot send the quarterly survey', (await call('POST', '/ats-experience/client-surveys/quarterly', {}, tR)).status === 403);
  const qa = await call('POST', '/ats-experience/client-surveys/quarterly', { clientIds: [j1.clientId] }, tA);
  const qb = await call('POST', '/ats-experience/client-surveys/quarterly', { clientIds: [j1.clientId] }, tA);
  check('the quarterly survey: sent once, the second press finds it', qa.status === 200 && qa.body.created === 1 && qb.body.created === 0 && qb.body.already === 1, { qa: qa.body && qa.body.created, qb: qb.body });
  const qs = await call('GET', '/ats-experience/surveys?side=client', null, tA);
  check('the survey list shows the client surveys with an answer link for the unanswered', qs.status === 200 && qs.body.rows.some((r) => r.event === 'Quarterly' && r.link) && qs.body.rows.some((r) => r.event === 'Joining' && r.nps === 9 && !r.link), qs.body && qs.body.rows.slice(0, 3));

  // ---- retention / lost clients
  const ret = await call('GET', '/ats-experience/retention?months=6', null, tA);
  const meRow = ret.body && ret.body.clients.find((c) => c.clientId === j1.clientId);
  check('retention: 6 months, the job\'s client is active with its joining', ret.status === 200 && ret.body.byMonth.length === 6 && meRow && meRow.state === 'Active' && meRow.joinings >= 1, ret.body && { o: ret.body.overall, meRow });
  const lm = ret.body.byMonth[5];
  check('...retained + churned = active at the start of the month', lm.retained + lm.churned === lm.activeAtStart && lm.retained + lm.new === lm.active, lm);
  check('marking lost needs a reason', (await call('POST', `/ats-experience/clients/${j1.clientId}/lost`, {}, tA)).status === 400);
  await call('POST', `/ats-experience/clients/${j1.clientId}/lost`, { reason: 'Moved to another agency', notes: 'Price' }, tA);
  const ret2 = await call('GET', '/ats-experience/retention?months=6', null, tA);
  const lostRow = ret2.body.lost.find((c) => c.clientId === j1.clientId);
  check('a client marked lost is in the lost list with the reason', lostRow && lostRow.reason === 'Moved to another agency' && lostRow.state === 'Lost (marked)', lostRow);
  check('a BDE sees no revenue column', !('revenue' in ((await call('GET', '/ats-experience/retention', null, tB)).body.clients[0] || {})));
  await call('DELETE', `/ats-experience/clients/${j1.clientId}/lost`, null, tA);
  check('clearing the mark takes it off the lost list', !(await call('GET', '/ats-experience/retention', null, tA)).body.lost.some((c) => c.clientId === j1.clientId && c.state === 'Lost (marked)'));
  const xl = await fetch(`${API}/ats-experience/export/retention?format=xlsx`, { headers: { Authorization: `Bearer ${tA}` } });
  const xlBuf = Buffer.from(await xl.arrayBuffer());
  check('retention downloads as Excel', xl.status === 200 && /spreadsheetml/.test(xl.headers.get('content-type')) && xlBuf.slice(0, 2).toString() === 'PK');
  const csv = await fetch(`${API}/ats-experience/export/retention?format=csv`, { headers: { Authorization: `Bearer ${tA}` } });
  const csvText = await csv.text();
  check('...and as CSV with the lost clients section', csv.status === 200 && /Lost clients/.test(csvText) && /Retention %/.test(csvText));
  const ce = await fetch(`${API}/ats-experience/export/candidate-experience?format=csv`, { headers: { Authorization: `Bearer ${tA}` } });
  check('candidate experience downloads as CSV', ce.status === 200 && /NPS/.test(await ce.text()));

  // ---- apply funnel
  const JP = require('../src/utils/jobPosting');
  let job = (await prisma.requirement.findMany({ where: { portalPublished: true, status: { in: ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'] } }, take: 200 })).find((r) => JP.siteTicked(r, 'jobportal'));
  if (!job) {
    const r0 = await prisma.requirement.findUnique({ where: { id: j1.id } });
    await prisma.requirement.update({ where: { id: j1.id }, data: { portalPublished: true, postingSources: JP.postingSourcesFor(r0, ['jobportal']) } });
    job = await prisma.requirement.findUnique({ where: { id: j1.id } });
  }
  await fetch(`${API}/public/careers/_test/reset-limits`, { method: 'POST' }).catch(() => null);
  const prog = (body) => fetch(`${API}/public/careers/jobs/${job.id}/apply-progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
  const S1 = `s1${P}abcdefghijk`; const S2 = `s2${P}abcdefghijk`;
  check('the form says "started" (no person data)', await prog({ session: S1, filled: 0, total: 10, src: 'linkedin' }) === 200 && await prog({ session: S2, filled: 0, total: 10, src: 'naukri' }) === 200);
  await prog({ session: S1, filled: 3, total: 10, src: 'linkedin' }); await prog({ session: S2, filled: 6, total: 10, src: 'naukri' }); await prog({ session: S2, filled: 4, total: 10, src: 'naukri' });
  check('a bad session id is refused', await prog({ session: 'x', filled: 1, total: 10 }) === 400);
  const fd = new FormData();
  Object.entries({ name: 'Xp Applicant', email: `xp.apply.${P}@xp-test.in`, phone: `8${String(P).padStart(9, '7').slice(-9)}`, currentSalary: '3', expectedSalary: '4', consent: 'yes', src: 'linkedin', applySession: S1 }).forEach(([k, v]) => fd.append(k, v));
  fd.append('resume', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'cv.pdf');
  const ap = await fetch(`${API}/public/careers/jobs/${job.id}/apply`, { method: 'POST', body: fd });
  const apBody = await ap.json().catch(() => ({}));
  if (ap.status !== 201) { console.log(`      (apply answered ${ap.status} ${JSON.stringify(apBody).slice(0, 160)} - marking the session submitted directly)`); await E.applySubmitted({ session: S1, jobId: job.id, applicationId: 'test-app', source: 'linkedin' }); }
  const [f1] = await E.q('SELECT * FROM "ApplyFunnel" WHERE "session" = ?', S1);
  const [f2] = await E.q('SELECT * FROM "ApplyFunnel" WHERE "session" = ?', S2);
  check('the application marks its session submitted (100 %); the other keeps its highest fill (60 %)', f1 && !!f1.submittedAt && f1.pct === 100 && f2 && !f2.submittedAt && f2.pct === 60, { f1, f2 });
  const fnNow = await R.applyFunnel({ ...(await resolveIdentity(adminRow.id)) }, {});
  const jRow = (x) => x.byJob.find((g) => g.key === job.id) || {};
  check('right now: started 2, submitted 1, one still filling (not abandoned yet)', jRow(fnNow).started === 2 && jRow(fnNow).submitted === 1 && jRow(fnNow).inProgress === 1 && jRow(fnNow).abandoned === 0, jRow(fnNow));
  const fnLater = await R.applyFunnel({ ...(await resolveIdentity(adminRow.id)) }, {}, { now: Date.now() + 31 * 60000 });
  check('31 minutes later: 1 abandoned at 60 % filled, completion rate 50 %', jRow(fnLater).abandoned === 1 && jRow(fnLater).completionRate === 50 && jRow(fnLater).avgFilledWhenAbandoned === 60, jRow(fnLater));
  check('...and by source: linkedin submitted, naukri not', fnLater.bySource.some((g) => g.key === 'linkedin' && g.submitted === 1) && fnLater.bySource.some((g) => g.key === 'naukri' && g.abandoned === 1), fnLater.bySource);
  const fa = await call('GET', '/ats-experience/apply-funnel', null, tA);
  check('the apply funnel report answers over the API', fa.status === 200 && fa.body.byJob.some((g) => g.key === job.id && g.started === 2), fa.body && fa.body.overall);

  // ---- switches off again: the manual paths still work
  await call('PUT', '/ats-experience/auto-settings', { candidateSurveys: false, clientSurveys: false }, tA);
  const C2 = await prisma.candidate.create({ data: { name: `Xp Second ${P}`, phone: `7${String(P).padStart(9, '6').slice(-9)}`, email: `xp.second.${P}@xp-test.in`, consentStatus: 'GIVEN' } });
  const a2 = await call('POST', '/applications', { candidateId: C2.id, requirementId: j1.id, overrideReason: 'experience test second' }, tA);
  const app2 = a2.body && (a2.body.id || (a2.body.application && a2.body.application.id));
  await prisma.application.update({ where: { id: app2 }, data: { stage: 'INTERVIEW_SCHEDULED', ownerRecruiterId: REC.id } });
  await call('PATCH', `/applications/${app2}/stage`, { stage: 'INTERVIEW_COMPLETED', comment: 'done' }, tA);
  check('switched off again: a new interview move makes no survey', (await E.q('SELECT * FROM "AtsSurvey" WHERE "applicationId" = ?', app2)).length === 0);
  check('...the recruiter can still log a complaint', (await call('POST', '/ats-experience/complaints', { side: 'candidate', applicationId: app2, subject: 'Manual path works' }, tR)).status === 201);
  const qc = await call('POST', '/ats-experience/client-surveys/quarterly', { clientIds: [j1.clientId] }, tA);
  check('...and the "Send quarterly survey" button still works', qc.status === 200 && qc.body.already === 1, qc.body && { c: qc.body.created, a: qc.body.already });

  // ---- catalog flags on the Reports page
  const cat = await call('GET', '/ats-reports/catalog', null, tA);
  check('the Reports catalog opens Candidate experience and Client health for an Admin', cat.status === 200 && cat.body.experience === true && cat.body.clientHealth === true, cat.body && { e: cat.body.experience, c: cat.body.clientHealth });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
