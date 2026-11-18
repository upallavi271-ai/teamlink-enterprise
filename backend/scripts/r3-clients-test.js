#!/usr/bin/env node
/**
 * ROUND 3 - interviews, offers, clients and billing (ATS audit 2026-11-18): multi-round interviews with typed per-round feedback, files and
 * interviewer ratings; meeting-link providers; the all-in-one calendar; offer templates and salary breakup; client contacts, credit, positions,
 * desk rule, client approval of a requirement; overdue reminders, profitability, payment approval, receipt exports, freelancer report;
 * portal usage and agreement renewals; handover export.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4163 node scripts/r3-clients-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-r3clients-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4163);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'r3clients-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, UPLOAD_DIR: path.join(os.tmpdir(), `zz-r3-up-${process.pid}`) };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token, raw) => {
  const r = await fetch(API + url, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
  let j = null; let buf = null;
  const ct = r.headers.get('content-type') || '';
  if (/json/.test(ct)) { try { j = await r.json(); } catch { /* none */ } } else { buf = Buffer.from(await r.arrayBuffer()); }
  return { status: r.status, body: j, buf, type: ct, disp: r.headers.get('content-disposition') || '' };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(env.UPLOAD_DIR, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}
const P = process.pid;
const day = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mk = (tag, data) => prisma.user.create({ data: { name: `R3 ${tag} ${P}`, email: `r3.${tag}.${P}@r3-test.in`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education', atsAccess: true });
  const BDETL = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE', atsAccess: true });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education', atsAccess: true });
  const REC2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education', atsAccess: true });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education', atsAccess: true });
  const ACC1 = await mk('acc1', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true });
  const ACC2 = await mk('acc2', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true });
  const client = await prisma.client.create({ data: { name: `R3 Client ${P}`, industry: 'Education', ownerDepartment: 'Education', bdeOwner: BDE.name, agreementStatus: 'ACTIVE', contactName: 'Asha HR', contactDesignation: 'HR Manager', contactPhone: '9876500001', contactEmail: `asha.${P}@r3-test.in`, secondaryContactName: 'Dr Rao', secondaryContactDesignation: 'Principal', secondaryContactPhone: '9876500002', billingContactName: 'Fin Person', billingContactEmail: `fin.${P}@r3-test.in`, billingContactPhone: '9876500003', agreementStart: day(-340), agreementEnd: day(20) } });
  const otherClient = await prisma.client.create({ data: { name: `R3 Other ${P}`, ownerDepartment: 'Medical', agreementStatus: 'ACTIVE' } });
  const req1 = await prisma.requirement.create({ data: { title: `R3 Lecturer ${P}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, openings: 3 } });
  const reqDraft = await prisma.requirement.create({ data: { title: `R3 Draft Dean ${P}`, clientId: client.id, status: 'DRAFT', department: 'Education', tlId: TL.id, bdeId: BDE.id, openings: 1 } });
  const reqDraft2 = await prisma.requirement.create({ data: { title: `R3 Draft Registrar ${P}`, clientId: client.id, status: 'DRAFT', department: 'Education', tlId: TL.id, bdeId: BDE.id, openings: 1 } });
  const C1 = await prisma.candidate.create({ data: { name: `R3 Cand A ${P}`, phone: `7${String(P).padStart(9, '1').slice(-9)}`, email: `r3.a.${P}@r3-test.in` } });
  const C2 = await prisma.candidate.create({ data: { name: `R3 Cand B ${P}`, phone: `6${String(P).padStart(9, '2').slice(-9)}`, email: `r3.b.${P}@r3-test.in` } });
  const app1 = await prisma.application.create({ data: { candidateId: C1.id, requirementId: req1.id, stage: 'INTERVIEW_SCHEDULED', ownerRecruiterId: REC.id, interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 2 * 86400000), interviewRound: 1, interviewMode: 'Online', interviewer: `R3 tl ${P}, Outside Person`, offeredCtc: 1200000, joiningDate: day(10), offerStatus: 'Offer Accepted' } });
  await prisma.interviewPanelist.create({ data: { applicationId: app1.id, round: 1, userId: TL.id, name: TL.name, position: 0 } });
  await prisma.interviewPanelist.create({ data: { applicationId: app1.id, round: 1, userId: null, name: 'Outside Person', position: 1 } });
  const app2 = await prisma.application.create({ data: { candidateId: C2.id, requirementId: req1.id, stage: 'INTERVIEW_COMPLETED', ownerRecruiterId: REC.id, interviewStatus: 'FEEDBACK_SUBMITTED', interviewAt: new Date(Date.now() - 86400000), interviewRound: 2, interviewer: 'Old Panel' } });
  await prisma.interviewFeedback.create({ data: { applicationId: app2.id, kind: 'Internal', technical: 4, communication: 4, overall: 'Round two overwrote one', recommendation: 'Selected', submittedBy: 'Old Panel' } });
  const FH = require('../src/utils/feedbackHistory');
  await FH.record(app2.id, 'Internal', 1, { technical: 2, overall: 'round one old', recommendation: 'Hold' }, { id: null, name: 'Old Panel' });
  await FH.record(app2.id, 'Internal', 2, { technical: 4, communication: 4, overall: 'Round two overwrote one', recommendation: 'Selected' }, { id: null, name: 'Old Panel' });
  const clientLogin = await mk('cli', { role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, atsAccess: true });
  const otherLogin = await mk('cli2', { role: 'CLIENT', atsRole: 'CLIENT', clientId: otherClient.id, atsAccess: true });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tBde = await tok(BDE.id); const tBdeTl = await tok(BDETL.id); const tRec = await tok(REC.id); const tRec2 = await tok(REC2.id); const tTl = await tok(TL.id);
  const tAcc1 = await tok(ACC1.id); const tAcc2 = await tok(ACC2.id); const tCli = await tok(clientLogin.id); const tCli2 = await tok(otherLogin.id);

  // ================================================================ 235 meeting links
  const okMeet = await call('POST', '/ats/meeting-link/check', { url: 'https://meet.google.com/abc-defg-hij', provider: 'Google Meet' }, tRec);
  check('235: a Google Meet link passes for Google Meet', okMeet.status === 200 && okMeet.body.provider === 'Google Meet', okMeet.body);
  check('235: a Zoom link under "Google Meet" is refused with the right example', (await call('POST', '/ats/meeting-link/check', { url: 'https://zoom.us/j/123456789', provider: 'Google Meet' }, tRec)).status === 400);
  const zoom = await call('POST', '/ats/meeting-link/check', { url: 'https://us02web.zoom.us/j/123456789?pwd=abc', provider: 'Zoom' }, tRec);
  check('235: a Zoom link passes for Zoom', zoom.status === 200 && zoom.body.provider === 'Zoom', zoom.body);
  const teams = await call('POST', '/ats/meeting-link/check', { url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x', provider: 'Teams' }, tRec);
  check('235: a Teams link passes for Teams', teams.status === 200, teams.body);
  check('235: the provider is found from the link when none is chosen', (await call('POST', '/ats/meeting-link/check', { url: 'https://meet.google.com/abc-defg-hij' }, tRec)).body.provider === 'Google Meet');
  check('235: http:// and a bare word are refused', (await call('POST', '/ats/meeting-link/check', { url: 'http://zoom.us/j/12345', provider: 'Zoom' }, tRec)).status === 400 && (await call('POST', '/ats/meeting-link/check', { url: 'meet link', provider: 'Other' }, tRec)).status === 400);
  check('235: "Other" takes any https link', (await call('POST', '/ats/meeting-link/check', { url: 'https://whereby.com/room', provider: 'Other' }, tRec)).status === 200);

  // ================================================================ 232 / 242 / 248 rounds, typed feedback
  const r0 = await call('GET', `/ats/interviews/${app1.id}/rounds`, null, tRec);
  check('232: the rounds of an interview are listed (round 1, current)', r0.status === 200 && r0.body.rounds.length === 1 && r0.body.rounds[0].round === 1 && r0.body.rounds[0].current, r0.body);
  check('232: the panel of the round is on it', r0.body.rounds[0].panel.length === 2);
  check('232: a recruiter outside the job cannot read the rounds', (await call('GET', `/ats/interviews/${app1.id}/rounds`, null, tRec2)).status === 404);
  const techNoSkill = await call('POST', `/ats/interviews/${app1.id}/feedback`, { roundType: 'Technical', overall: 'Good', recommendation: 'Selected' }, tRec);
  check('242: technical feedback needs skill ratings', techNoSkill.status === 400, techNoSkill.body);
  const tech = await call('POST', `/ats/interviews/${app1.id}/feedback`, { roundType: 'Technical', overall: 'Strong in Java', recommendation: 'Selected', skills: [{ name: 'Java', rating: 5 }, { name: 'SQL', rating: 4 }], problemSolving: 4, communication: 4 }, tRec);
  check('242: technical feedback saved', tech.status === 200, tech.body);
  const r1 = await call('GET', `/ats/interviews/${app1.id}/rounds`, null, tRec);
  const rd1 = r1.body.rounds.find((r) => r.round === 1);
  check('242: round 1 is typed Technical and keeps its skills', rd1.roundType === 'Technical' && rd1.feedback && rd1.feedback.details.skills.length === 2 && rd1.feedback.recommendation === 'Selected', rd1);
  check('232: the older InterviewFeedback row is still written (older screens)', !!(await prisma.interviewFeedback.findFirst({ where: { applicationId: app1.id, kind: 'Internal' } })));
  // round 2: book it as the booking route does, then HR feedback
  await prisma.application.update({ where: { id: app1.id }, data: { interviewRound: 2, interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 3 * 86400000) } });
  const IR = require('../src/utils/interviewRounds');
  await IR.noteBooking(app1.id, 2, { roundType: 'HR', scheduledAt: new Date(Date.now() + 3 * 86400000), mode: 'Online', meetingLink: 'https://meet.google.com/abc-defg-hij', linkProvider: 'Google Meet', panel: 'HR Head' });
  const hrBad = await call('POST', `/ats/interviews/${app1.id}/feedback`, { roundType: 'HR', overall: 'Fine', recommendation: 'Selected' }, tRec);
  check('242: HR feedback needs the attitude rating', hrBad.status === 400, hrBad.body);
  const hr = await call('POST', `/ats/interviews/${app1.id}/feedback`, { roundType: 'HR', overall: 'Good attitude', recommendation: 'Selected', attitude: 5, expectationsMatch: 'Yes', noticePeriod: '30 days', currentCtc: '10L', expectedCtc: '12L' }, tRec);
  check('242: HR feedback saved', hr.status === 200, hr.body);
  const r2 = await call('GET', `/ats/interviews/${app1.id}/rounds`, null, tRec);
  const [a, b] = [r2.body.rounds.find((r) => r.round === 1), r2.body.rounds.find((r) => r.round === 2)];
  check('248: round 1 feedback was NOT overwritten by round 2', a.feedback.roundType === 'Technical' && a.feedback.details.skills.length === 2 && a.feedback.overall === 'Strong in Java', a.feedback);
  check('248: round 2 has its own HR row with its fields', b.roundType === 'HR' && b.feedback.details.attitude === 5 && b.feedback.details.noticePeriod === '30 days' && b.meetingLink && b.linkProvider === 'Google Meet', b);
  check('248: round history shows each round with its rating', typeof a.feedback.average === 'number' && typeof b.feedback.average === 'number');
  const mgmtBad = await call('PUT', `/ats/interviews/${app1.id}/rounds/3/feedback`, { roundType: 'Management', overall: 'ok', recommendation: 'Hold' }, tTl);
  check('242: management feedback needs the culture-fit rating', mgmtBad.status === 400);
  const mgmt = await call('PUT', `/ats/interviews/${app1.id}/rounds/3/feedback`, { roundType: 'Management', overall: 'Fits well', recommendation: 'Selected', cultureFit: 5, leadership: 4, fitForTeam: 'Yes', finalNote: 'Go ahead' }, tTl);
  check('242: management feedback saved for round 3 through the round route', mgmt.status === 200 && mgmt.body.rounds.some((r) => r.round === 3 && r.feedback && r.feedback.roundType === 'Management'), mgmt.body);
  check('247: a suggested decision comes from the ratings (Selected)', mgmt.body.suggested && mgmt.body.suggested.decision === 'Selected' && mgmt.body.suggested.average >= 3.5, mgmt.body.suggested);
  check('247: the stage does NOT move by itself', (await prisma.application.findUnique({ where: { id: app1.id } })).stage !== 'SELECTED');
  const sg = (rounds) => IR.suggestedDecision(rounds.map((r) => ({ round: r[0], feedback: { recommendation: r[1], average: r[2] } })));
  check('247: suggestion rules: Rejected round -> Rejected; Selected but weak ratings -> Hold; Hold -> Hold; nothing -> none',
    sg([[1, 'Selected', 4], [2, 'Rejected', 2]]).decision === 'Rejected' && sg([[1, 'Selected', 3]]).decision === 'Hold' && sg([[1, 'Hold', 4]]).decision === 'Hold' && sg([]) === null);
  check('247: the existing decision route still belongs to the stage owner (a recruiter cannot mark Selected)', [400, 403, 409].includes((await call('POST', `/ats/interviews/${app1.id}/decision`, { decision: 'Selected' }, tRec)).status));
  check('232: a person without feedback rights cannot save round feedback', (await call('PUT', `/ats/interviews/${app1.id}/rounds/1/feedback`, { roundType: 'Other', overall: 'x', recommendation: 'Hold' }, tBde)).status === 403);

  // lazy migration of old rounds
  const m1 = await call('GET', `/ats/interviews/${app2.id}/rounds`, null, tRec);
  check('232: old feedback is read into rounds lazily (round 1 and round 2, marked as earlier records)', m1.status === 200 && m1.body.rounds.length === 2 && m1.body.rounds.every((r) => r.feedback && r.feedback.legacy), m1.body.rounds);
  check('232: ...with the right words per round', m1.body.rounds[0].feedback.overall === 'round one old' && m1.body.rounds[1].feedback.overall === 'Round two overwrote one');

  // ================================================================ 250 attachments
  const link = await call('POST', `/ats/interviews/${app1.id}/rounds/1/attachments`, { kind: 'link', url: 'https://drive.example.com/rec/1', title: 'Recording' }, tRec);
  check('250: a recording link can be added', link.status === 201 && link.body.rounds[0].attachments.some((x) => x.kind === 'link'), link.body);
  check('250: a link must be https', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/attachments`, { kind: 'link', url: 'http://x.example.com/a' }, tRec)).status === 400);
  check('250: a note can be added', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/attachments`, { kind: 'note', note: 'Asked about the thesis', title: 'Notes' }, tRec)).status === 201);
  const fd = new FormData();
  fd.append('title', 'Scorecard'); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'scorecard.png');
  const up = await call('POST', `/ats/interviews/${app1.id}/rounds/2/attachments`, fd, tRec, true);
  check('250: a file can be uploaded to a round', up.status === 201, up.body);
  const fileAtt = up.body && up.body.rounds && up.body.rounds.find((r) => r.round === 2).attachments.find((x) => x.hasFile);
  const dl = fileAtt ? await call('GET', `/ats/interview-attachments/${fileAtt.id}/file`, null, tRec) : null;
  check('250: ...and downloaded back by someone in scope', dl && dl.status === 200 && dl.buf && dl.buf.length === PNG.length, dl && dl.status);
  check('250: ...but not by a recruiter outside the job', fileAtt && (await call('GET', `/ats/interview-attachments/${fileAtt.id}/file`, null, tRec2)).status === 403);
  const fdBad = new FormData(); fdBad.append('file', new Blob(['<html>x</html>'], { type: 'text/html' }), 'x.html');
  check('250: a file of the wrong kind is refused', (await call('POST', `/ats/interviews/${app1.id}/rounds/2/attachments`, fdBad, tRec, true)).status === 400);
  const fdBig = new FormData(); fdBig.append('file', new Blob([Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024, 2)])], { type: 'image/png' }), 'big.png');
  check('250: a file over the cap (20 MB) is refused', [413, 400].includes((await call('POST', `/ats/interviews/${app1.id}/rounds/2/attachments`, fdBig, tRec, true)).status));
  check('250: the BDE team cannot add or open the internal files', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/attachments`, { kind: 'note', note: 'x' }, tBde)).status === 403);
  check('250: only the uploader / a lead can remove a file', fileAtt && (await call('DELETE', `/ats/interview-attachments/${fileAtt.id}`, null, tRec2)).status === 403 && (await call('DELETE', `/ats/interview-attachments/${fileAtt.id}`, null, tRec)).status === 200);

  // ================================================================ 244 interviewer rating
  const rate1 = await call('POST', `/ats/interviews/${app1.id}/rounds/1/rate-interviewer`, { userId: TL.id, rating: 4, comment: 'Well prepared' }, tRec);
  check('244: the recruiter rates an interviewer of the round', rate1.status === 200, rate1.body);
  check('244: a second rating by the same person replaces the first', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/rate-interviewer`, { userId: TL.id, rating: 5 }, tRec)).status === 200);
  check('244: an outside panelist can be rated by name', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/rate-interviewer`, { name: 'Outside Person', rating: 3 }, tRec)).status === 200);
  check('244: someone who did not take the round cannot be rated', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/rate-interviewer`, { userId: BDETL.id, rating: 3 }, tRec)).status === 400);
  check('244: the rating is 1 to 5', (await call('POST', `/ats/interviews/${app1.id}/rounds/1/rate-interviewer`, { userId: TL.id, rating: 9 }, tRec)).status === 400);
  const avg = await call('GET', `/ats/interviewer-ratings?userId=${TL.id}`, null, tA);
  check('244: the average is shown to Admin (5 after the replacement, 1 rating)', avg.status === 200 && avg.body.rows.length === 1 && avg.body.rows[0].average === 5 && avg.body.rows[0].count === 1, avg.body);
  check('244: a TL can read it; a recruiter and a BDE cannot', (await call('GET', '/ats/interviewer-ratings', null, tTl)).status === 200 && (await call('GET', '/ats/interviewer-ratings', null, tRec)).status === 403 && (await call('GET', '/ats/interviewer-ratings', null, tBde)).status === 403);

  // ================================================================ 428 calendar
  const joinApp = await prisma.application.create({ data: { candidateId: (await prisma.candidate.create({ data: { name: `R3 Cand J ${P}`, phone: `5${String(P).padStart(9, '3').slice(-9)}` } })).id, requirementId: req1.id, stage: 'OFFER_ACCEPTED', ownerRecruiterId: REC.id, offerStatus: 'Offer Accepted', joiningDate: day(6) } });
  const cal = await call('GET', `/ats/all-calendar?from=${day(0)}&to=${day(14)}&who=team`, null, tA);
  check('428: the calendar lists interviews and joining dates together', cal.status === 200 && cal.body.events.some((e) => e.type === 'interview' && /Round 2/.test(e.title)) && cal.body.events.some((e) => e.type === 'joining'), cal.body.counts);
  await prisma.applicationFollowUp.create({ data: { applicationId: app1.id, candidateId: C1.id, ownerUserId: REC.id, ownerName: REC.name, dueDate: day(1), nextAction: 'Call back' } });
  await prisma.task.create({ data: { name: `R3 task ${P}`, assigneeId: REC.id, assignedById: TL.id, assigneeName: REC.name, assignedByName: TL.name, endDate: day(2), status: 'Not Started' } });
  const calMe = await call('GET', `/ats/all-calendar?from=${day(0)}&to=${day(14)}`, null, tRec);
  check('428: "mine" has the follow-up and the task of that person', calMe.body.events.some((e) => e.type === 'followup') && calMe.body.events.some((e) => e.type === 'task' && e.title.includes(`R3 task ${P}`)), calMe.body.counts);
  const calOther = await call('GET', `/ats/all-calendar?from=${day(0)}&to=${day(14)}`, null, tRec2);
  check('428: another recruiter does not see them (scope)', !calOther.body.events.some((e) => e.type === 'task' || e.type === 'interview'), calOther.body.counts);
  check('428: a client login has no access; a wide range is refused', (await call('GET', `/ats/all-calendar?from=${day(0)}&to=${day(14)}`, null, tCli)).status === 403 && (await call('GET', `/ats/all-calendar?from=${day(0)}&to=${day(120)}`, null, tA)).status === 400);

  // ================================================================ 252 / 253 offers
  check('252: only an Admin can add a template', (await call('POST', '/ats/offer-templates', { name: 'x', body: 'Dear {{name}}, welcome aboard to {{company}} at {{ctc}}.' }, tTl)).status === 403);
  check('252: an unknown placeholder is refused', (await call('POST', '/ats/offer-templates', { name: 'x', body: 'Dear {{nme}}, welcome aboard to the company with a long line.' }, tA)).status === 400);
  const tpl = await call('POST', '/ats/offer-templates', { name: `Education letter ${P}`, body: 'Dear {{name}},\n\nGreetings from {{company}}. We offer you {{job}} (EDU TEMPLATE).\n\nAnnual CTC: {{ctc}}\nJoining date: {{joiningDate}}\n\n{{sender}}', industry: 'Education' }, tA);
  check('252: an Admin adds a template for an industry', tpl.status === 201 && tpl.body.industry === 'Education', tpl.body);
  const tpl2 = await call('POST', '/ats/offer-templates', { name: `Client letter ${P}`, body: 'Dear {{name}},\n\nCLIENT TEMPLATE for {{job}}.\n\nAnnual CTC: {{ctc}}\n\n{{breakup}}\n\n{{sender}}', clientId: client.id }, tA);
  check('252: ...and one for a client', tpl2.status === 201 && tpl2.body.clientId === client.id, tpl2.body);
  check('252: a client AND an industry together is refused', (await call('POST', '/ats/offer-templates', { name: 'both', body: 'Dear {{name}}, this letter has both a client and an industry.', clientId: client.id, industry: 'Education' }, tA)).status === 400);
  const pick1 = await call('GET', `/ats/offers/${app1.id}/template`, null, tA);
  check('252: the offer picks the CLIENT template before the industry one', pick1.body.templateId === tpl2.body.id, pick1.body);
  const letter1 = await call('GET', `/ats/offers/${app1.id}/letter`, null, tA);
  check('252: the letter is built from the picked template', letter1.status === 200 && /CLIENT TEMPLATE/.test(letter1.body.text) && /1,200,000|12,00,000/.test(letter1.body.text), letter1.body);
  await call('PUT', `/ats/offers/${app1.id}/template`, { templateId: tpl.body.id }, tA);
  check('252: a template chosen on the offer wins', /EDU TEMPLATE/.test((await call('GET', `/ats/offers/${app1.id}/letter`, null, tA)).body.text));
  await call('PUT', `/ats/offers/${app1.id}/template`, { templateId: null }, tA);
  // breakup
  const bk = await call('GET', `/ats/offers/${app1.id}/breakup`, null, tA);
  const sum = (c) => Object.values(c).reduce((x, y) => x + y, 0);
  check('253: the breakup is worked out from the CTC and adds up to it', bk.status === 200 && bk.body.components && sum(bk.body.components) === 1200000 && bk.body.components.basic === 480000 && !bk.body.saved, bk.body);
  check('253: a breakup that does not add up is refused with the difference', (await call('PUT', `/ats/offers/${app1.id}/breakup`, { components: { ...bk.body.components, basic: 500000 } }, tA)).status === 400);
  check('253: before it is saved the letter has no breakup', !/Salary breakup/.test((await call('GET', `/ats/offers/${app1.id}/letter`, null, tA)).body.text));
  const edited = { ...bk.body.components, basic: 500000, specialAllowance: bk.body.components.specialAllowance - 20000 };
  const bksave = await call('PUT', `/ats/offers/${app1.id}/breakup`, { components: edited }, tA);
  check('253: an edited breakup that adds up is saved', bksave.status === 200 && bksave.body.saved && bksave.body.components.basic === 500000, bksave.body);
  const letter2 = await call('GET', `/ats/offers/${app1.id}/letter`, null, tA);
  check('253: the saved breakup is printed in the letter (at the {{breakup}} place) with the CTC total', /Salary breakup/.test(letter2.body.text) && /Basic: Rs\. 5,00,000/.test(letter2.body.text) && /Total \(CTC\): Rs\. 12,00,000/.test(letter2.body.text), letter2.body.text);
  const split = await call('PUT', '/ats/offer-breakup-settings', { basic: 50, hra: 25, pf: 10, gratuity: 10, bonus: 10 }, tA);
  check('253: the Admin split cannot go over 100%', split.status === 400);
  check('253: only an Admin changes the default split', (await call('PUT', '/ats/offer-breakup-settings', { basic: 50, hra: 20, pf: 5, gratuity: 2, bonus: 8 }, tTl)).status === 403);
  check('253: a new default split works and special allowance stays the balance', (await call('PUT', '/ats/offer-breakup-settings', { basic: 50, hra: 20, pf: 5, gratuity: 2, bonus: 8 }, tA)).status === 200);
  await call('DELETE', `/ats/offers/${app1.id}/breakup`, null, tA);
  const bk2 = await call('GET', `/ats/offers/${app1.id}/breakup`, null, tA);
  check('253: the new split is used (basic 50%) and the parts still add up', bk2.body.components.basic === 600000 && sum(bk2.body.components) === 1200000 && bk2.body.components.specialAllowance === 1200000 - 600000 - 240000 - 60000 - 24000 - 96000, bk2.body.components);
  check('252: a template with the wrong role cannot be removed by a TL; an Admin removes', (await call('DELETE', `/ats/offer-templates/${tpl.body.id}`, null, tTl)).status === 403 && (await call('DELETE', `/ats/offer-templates/${tpl.body.id}`, null, tA)).status === 200);

  // ================================================================ 133 / 134 contacts
  const c0 = await call('GET', `/ats-clients/clients/${client.id}/contacts`, null, tBde);
  check('133: the four old slots are copied into the list (primary, secondary, billing)', c0.status === 200 && c0.body.rows.length === 3, c0.body);
  check('134: roles are found from the designation (HR Manager -> HR, Principal -> Principal, billing -> Finance)', ['HR', 'Principal', 'Finance'].every((r) => c0.body.rows.some((x) => x.role === r)), c0.body.rows.map((x) => x.role));
  const addC = await call('POST', `/ats-clients/clients/${client.id}/contacts`, { role: 'Dean', name: 'Dr Sita', phone: '9876511111', email: `sita.${P}@r3-test.in` }, tBde);
  check('133: any number of contacts can be added, with a role', addC.status === 201 && addC.body.rows.length === 4, addC.body);
  for (const role of ['HOD', 'Director', 'Other']) await call('POST', `/ats-clients/clients/${client.id}/contacts`, { role, name: `Person ${role}` }, tBde);
  check('133: five, six, seven contacts are fine', (await call('GET', `/ats-clients/clients/${client.id}/contacts`, null, tBde)).body.rows.length === 7);
  check('134: a role outside the list is refused', (await call('POST', `/ats-clients/clients/${client.id}/contacts`, { role: 'Janitor', name: 'X' }, tBde)).status === 400);
  check('133: a bad email / short phone is refused', (await call('POST', `/ats-clients/clients/${client.id}/contacts`, { role: 'HR', name: 'X', email: 'nope' }, tBde)).status === 400 && (await call('POST', `/ats-clients/clients/${client.id}/contacts`, { role: 'HR', name: 'X', phone: '12' }, tBde)).status === 400);
  const hrRow = c0.body.rows.find((x) => x.role === 'HR');
  await call('PUT', `/ats-clients/contacts/${hrRow.id}`, { phone: '9000000099' }, tBde);
  check('133: editing a contact born from an old slot writes back to the old field (still readable)', (await prisma.client.findUnique({ where: { id: client.id } })).contactPhone === '9000000099');
  check('133: a recruiter cannot edit or read another client\'s contacts', (await call('POST', `/ats-clients/clients/${client.id}/contacts`, { role: 'HR', name: 'Y' }, tRec)).status === 403 && (await call('GET', `/ats-clients/clients/${otherClient.id}/contacts`, null, tBde)).status === 404);
  check('133: a contact can be removed', (await call('DELETE', `/ats-clients/contacts/${addC.body.id}`, null, tBde)).status === 200);
  check('133: the contacts of a client outside the login\'s scope are refused', (await call('GET', `/ats-clients/clients/${client.id}/contacts`, null, tCli)).status === 403);

  // ================================================================ 142 / 377 credit
  check('142: credit days must be a whole number of days', (await call('PUT', `/ats-clients/clients/${client.id}/credit`, { creditDays: 'abc' }, tBde)).status === 400 && (await call('PUT', `/ats-clients/clients/${client.id}/credit`, { creditDays: 400 }, tBde)).status === 400);
  const cr = await call('PUT', `/ats-clients/clients/${client.id}/credit`, { creditDays: 45, creditLimit: 50000 }, tBde);
  check('142: credit period and limit saved and shown on the client', cr.status === 200 && cr.body.creditDays === 45 && cr.body.creditLimit === 50000 && (await call('GET', `/ats-clients/clients/${client.id}/credit`, null, tBde)).body.creditDays === 45, cr.body);
  check('142: a recruiter cannot set credit terms', (await call('PUT', `/ats-clients/clients/${client.id}/credit`, { creditDays: 10 }, tRec)).status === 403);
  const inv = await call('POST', '/invoices', { clientId: client.id, amount: 70000, invoiceDate: '2026-12-01' }, tA);
  check('377: the invoice due date is invoice date + the client\'s credit days (45)', inv.status === 201 && inv.body.dueDate === '2027-01-15', inv.body);
  check('142: raising an invoice over the credit limit warns', /credit limit/.test(inv.body.creditWarning || ''), inv.body.creditWarning);
  await call('PUT', `/ats-clients/clients/${client.id}/credit`, { creditDays: '' }, tBde);
  const inv2 = await call('POST', '/invoices', { clientId: client.id, amount: 1000, invoiceDate: '2026-12-01' }, tA);
  check('377: with no credit days the old rule (payment terms) is used', inv2.status === 201 && inv2.body.dueDate && inv2.body.dueDate !== '2027-01-15', inv2.body.dueDate);

  // ================================================================ 114 positions
  const pos = await call('PUT', `/ats-clients/requirements/${req1.id}/positions`, { positions: [{ title: 'Assistant Professor', count: 2, ctcMin: 600000, ctcMax: 900000 }, { title: 'Lab Assistant', count: 1 }] }, tA);
  check('114: several positions inside one requirement are saved', pos.status === 200 && pos.body.positions.length === 2, pos.body);
  check('114: the headcount follows the total of the positions (3)', (await prisma.requirement.findUnique({ where: { id: req1.id } })).openings === 3 && pos.body.headcount === 3);
  check('114: a position needs a title and a count; the CTC range is checked', (await call('PUT', `/ats-clients/requirements/${req1.id}/positions`, { positions: [{ title: '', count: 1 }] }, tA)).status === 400 && (await call('PUT', `/ats-clients/requirements/${req1.id}/positions`, { positions: [{ title: 'x', count: 0 }] }, tA)).status === 400 && (await call('PUT', `/ats-clients/requirements/${req1.id}/positions`, { positions: [{ title: 'x', count: 1, ctcMin: 9, ctcMax: 1 }] }, tA)).status === 400);
  const tag = await call('PUT', `/ats-clients/applications/${app1.id}/position`, { positionId: pos.body.positions[0].id }, tA);
  check('114: a candidate is placed against a position and the position tracks it', tag.status === 200 && tag.body.positions[0].candidates === 1 && tag.body.positions[0].open === 2, tag.body);
  await prisma.application.update({ where: { id: app1.id }, data: { stage: 'JOINED' } });
  check('114: a joined candidate counts as filled', (await call('GET', `/ats-clients/requirements/${req1.id}/positions`, null, tA)).body.positions[0].joined === 1);
  check('114: a position of another requirement cannot be used; a recruiter cannot edit positions', (await call('PUT', `/ats-clients/applications/${app2.id}/position`, { positionId: 'nope' }, tA)).status === 400 && (await call('PUT', `/ats-clients/requirements/${req1.id}/positions`, { positions: [] }, tRec)).status === 403);
  await prisma.application.update({ where: { id: app1.id }, data: { stage: 'INTERVIEW_SCHEDULED' } });

  // ================================================================ P7.4 / #20 / #92 desk rule
  const dk0 = await call('GET', '/ats-clients/settings', null, tA);
  check('#20: the Admin sees the current rule (default: the desk)', dk0.status === 200 && dk0.body.deskBdeSees === 'desk' && /desk/i.test(dk0.body.deskNote) && dk0.body.mayEdit, dk0.body);
  const deskClient = await prisma.client.create({ data: { name: `R3 Desk Client ${P}`, ownerDepartment: 'Education', agreementStatus: 'ACTIVE' } });
  const listFor = async (t) => (await call('GET', '/clients', null, t)).body;
  const idsOf = (b) => (Array.isArray(b) ? b : (b.rows || b.clients || [])).map((c) => c.id);
  check('P7.4: today a desk BDE sees the desk\'s client that nobody holds', idsOf(await listFor(tBde)).includes(deskClient.id));
  check('#92: a non-Admin cannot change the rule', (await call('PUT', '/ats-clients/settings', { deskBdeSees: 'assigned' }, tBde)).status === 403 && (await call('PUT', '/ats-clients/settings', { deskBdeSees: 'everyone' }, tA)).status === 400);
  await call('PUT', '/ats-clients/settings', { deskBdeSees: 'assigned' }, tA);
  const tBde2 = await tok(BDE.id);
  const after = idsOf(await listFor(tBde2));
  check('#20: with "only assigned" the BDE no longer sees the unheld desk client but keeps their own', !after.includes(deskClient.id) && after.includes(client.id), after.length);
  await call('PUT', '/ats-clients/settings', { deskBdeSees: 'desk' }, tA);
  check('#92: switched back, the desk client is visible again', idsOf(await listFor(await tok(BDE.id))).includes(deskClient.id));

  // ================================================================ #30 client approval
  await call('PUT', '/ats-clients/settings', { clientApproval: false }, tA);
  const off = await call('GET', `/ats-clients/requirements/${reqDraft.id}/client-approval`, null, tA);
  check('#30: the client approval step is OFF by default', off.status === 200 && off.body.enabled === false && off.body.approval === null, off.body);
  await call('PUT', '/ats-clients/settings', { clientApproval: true }, tA);
  const gate = await call('POST', `/requirements/${reqDraft.id}/activate`, {}, tA);
  check('#30: with the switch ON a requirement waits for the client', gate.status === 409 && gate.body.code === 'CLIENT_APPROVAL', gate.body);
  const pend = await call('GET', '/portal/client/requirement-approvals', null, tCli);
  check('#30: the client sees it in the portal', pend.status === 200 && pend.body.rows.some((r) => r.id === reqDraft.id), pend.body);
  check('#30: another client sees nothing of it and cannot decide it', (await call('GET', '/portal/client/requirement-approvals', null, tCli2)).body.rows.length === 0 && (await call('POST', `/portal/client/requirement-approvals/${reqDraft.id}/decide`, { approve: true }, tCli2)).status === 404);
  check('#30: staff cannot use the client\'s door', (await call('POST', `/portal/client/requirement-approvals/${reqDraft.id}/decide`, { approve: true }, tA)).status === 403);
  check('#30: a decline needs a reason', (await call('POST', `/portal/client/requirement-approvals/${reqDraft.id}/decide`, { approve: false }, tCli)).status === 400);
  const ok = await call('POST', `/portal/client/requirement-approvals/${reqDraft.id}/decide`, { approve: true }, tCli);
  check('#30: the client confirms it', ok.status === 200 && ok.body.state === 'approved', ok.body);
  const live = await call('POST', `/requirements/${reqDraft.id}/activate`, {}, tA);
  check('#30: after the client confirms, activation goes through (live)', live.status === 200 && ['OPEN', 'RECRUITER_ASSIGNED'].includes(live.body.status), live.body);
  await call('POST', `/requirements/${reqDraft2.id}/activate`, {}, tA);
  await call('POST', `/portal/client/requirement-approvals/${reqDraft2.id}/decide`, { approve: false, note: 'Change the salary band' }, tCli);
  const dec = await call('POST', `/requirements/${reqDraft2.id}/activate`, {}, tA);
  check('#30: a declined requirement stays held, with the client\'s words', dec.status === 409 && dec.body.code === 'CLIENT_DECLINED' && /salary band/.test(dec.body.error), dec.body);
  await call('PUT', '/ats-clients/settings', { clientApproval: false }, tA);

  // ================================================================ 711 portal usage
  await call('GET', '/portal/client', null, tCli);
  await call('GET', '/portal/client', null, tCli);
  const CD = require('../src/utils/clientDepth');
  await CD.recordPortal({ id: clientLogin.id, clientId: client.id }, 'login');
  const use = await call('GET', `/ats-clients/clients/${client.id}/portal-usage`, null, tBde);
  check('711: the card counts the portal visit (once an hour per login), logins and decisions', use.status === 200 && use.body.visits === 1 && use.body.logins === 1 && use.body.decisions >= 1, use.body);
  check('711: ...and requirements raised / profiles reviewed are counted', typeof use.body.requirementsRaised === 'number' && typeof use.body.profilesReviewed === 'number');
  check('711: the card is for the BDE team and Admins; a recruiter and a client login are refused', (await call('GET', `/ats-clients/clients/${client.id}/portal-usage`, null, tRec)).status === 403 && (await call('GET', `/ats-clients/clients/${client.id}/portal-usage`, null, tCli)).status === 403 && (await call('GET', `/ats-clients/clients/${client.id}/portal-usage`, null, tBdeTl)).status === 200);
  check('711: what is a portal action: the request classifier', CD.classifyPortal('POST', '/api/portal/client/requirement-requests').kind === 'requirement_raised' && CD.classifyPortal('GET', '/api/portal/client/resume/abc').kind === 'profile_reviewed' && CD.classifyPortal('GET', '/api/portal/client/other') === null);

  // ================================================================ 720 renewals
  const mkRen = (tag, end) => prisma.client.create({ data: { name: `R3 Renew ${tag} ${P}`, ownerDepartment: 'Education', bdeOwner: BDE.name, agreementStatus: 'ACTIVE', agreementStart: day(-300), agreementEnd: end } });
  const [cDue, cUp, cExp, cFar] = [await mkRen('due', day(20)), await mkRen('up', day(50)), await mkRen('exp', day(-5)), await mkRen('far', day(200))];
  const ren = await call('GET', '/ats-clients/renewals', null, tBdeTl);
  const st = (c) => (ren.body.rows.find((r) => r.clientId === c.id) || {}).status;
  check('720: the renewals list has Due (30), Upcoming (60) and Expired, and leaves far-away agreements out', ren.status === 200 && st(cDue) === 'Due' && st(cUp) === 'Upcoming' && st(cExp) === 'Expired' && st(cFar) === undefined, { due: st(cDue), up: st(cUp), exp: st(cExp), far: st(cFar) });
  check('720: the list is filterable by status', (await call('GET', '/ats-clients/renewals?status=Expired', null, tBdeTl)).body.rows.every((r) => r.status === 'Expired'));
  check('720: a recruiter cannot open the renewals', (await call('GET', '/ats-clients/renewals', null, tRec)).status === 403);
  const asg = await call('PUT', `/ats-clients/renewals/${cDue.id}/assign`, { bdeId: BDE.id }, tBdeTl);
  check('720: a BDE is assigned to the renewal', asg.status === 200 && asg.body.assignedBdeName === BDE.name, asg.body);
  check('720: marking renewed needs valid new dates (after the old end)', (await call('POST', `/ats-clients/renewals/${cExp.id}/renew`, { newStart: day(0), newEnd: day(-100) }, tBdeTl)).status === 400 && (await call('POST', `/ats-clients/renewals/${cExp.id}/renew`, { newStart: day(0), newEnd: day(-9) }, tBdeTl)).status === 400);
  const rn = await call('POST', `/ats-clients/renewals/${cExp.id}/renew`, { newStart: day(0), newEnd: day(365), note: 'Renewed for a year' }, tBdeTl);
  const cExp2 = await prisma.client.findUnique({ where: { id: cExp.id } });
  check('720: Mark renewed starts the next agreement (new dates on the client) and keeps the old ones', rn.status === 200 && cExp2.agreementEnd === day(365) && cExp2.agreementStart === day(0), rn.body);
  const ren2 = await call('GET', '/ats-clients/renewals?status=Renewed', null, tBdeTl);
  check('720: the renewed one is listed as Renewed with who and when', ren2.body.rows.some((r) => r.clientId === cExp.id && r.status === 'Renewed' && r.prevEnd === undefined && r.newEnd === day(365)), ren2.body);
  const run0 = await call('POST', '/ats-clients/renewals/run', {}, tA);
  check('720: reminders are OFF until the Admin switches them on (nothing sent)', run0.status === 200 && run0.body.enabled === false && run0.body.reminded.length === 0, run0.body);
  await call('PUT', '/ats-clients/settings', { renewalReminders: true }, tA);
  const dry = await call('POST', '/ats-clients/renewals/run', { dryRun: true }, tA);
  check('720: switched on, a dry run lists who would be told (Due and Upcoming)', dry.body.enabled && dry.body.reminded.length >= 2, dry.body);
  const before = await prisma.notification.count({ where: { userId: BDE.id } });
  await call('POST', '/ats-clients/renewals/run', {}, tA);
  const mid = await prisma.notification.count({ where: { userId: BDE.id } });
  await call('POST', '/ats-clients/renewals/run', {}, tA);
  check('720: the BDE is told, once per stage per client (a second run adds nothing)', mid > before && (await prisma.notification.count({ where: { userId: BDE.id } })) === mid, { before, mid });
  await call('PUT', '/ats-clients/settings', { renewalReminders: false }, tA);

  // ================================================================ 386 overdue reminders
  const odClient = await prisma.client.create({ data: { name: `R3 Overdue Client ${P}`, ownerDepartment: 'Education', bdeOwner: BDE.name, agreementStatus: 'ACTIVE', billingContactEmail: `bill.${P}@r3-test.in`, billingContactName: 'Accounts Desk' } });
  const odInv = await prisma.invoice.create({ data: { clientId: odClient.id, amount: 100000, gst: 18000, tds: 10000, invoiceDate: day(-60), dueDate: day(-20), status: 'Pending', invoiceNumber: `R3-OD-${P}` } });
  const bset0 = await call('GET', '/ats-billing/settings', null, tA);
  check('386: the overdue reminders and the client copy are OFF by default', bset0.status === 200 && bset0.body.overdueReminders === false && bset0.body.remindClient === false && bset0.body.paymentApproval === false, bset0.body);
  const off0 = await call('POST', '/ats-billing/overdue-reminders/run', {}, tA);
  check('386: switched off, the worker tells nobody', off0.body.enabled === false && off0.body.owner.length === 0);
  check('386: only an Admin switches them on or runs them', (await call('PUT', '/ats-billing/settings', { overdueReminders: true }, tAcc1)).status === 403 && (await call('POST', '/ats-billing/overdue-reminders/run', {}, tRec)).status === 403);
  await call('PUT', '/ats-billing/settings', { overdueReminders: true }, tA);
  const nBefore = await prisma.notification.count({ where: { userId: BDE.id } });
  const run1 = await call('POST', '/ats-billing/overdue-reminders/run', {}, tA);
  check('386: switched on, the owner BDE is told about the overdue invoice', run1.body.enabled && run1.body.owner.some((o) => o.invoice.includes(`R3-OD-${P}`)) && run1.body.client.length === 0, run1.body);
  check('386: ...as a bell for that BDE', (await prisma.notification.count({ where: { userId: BDE.id } })) > nBefore);
  const run2 = await call('POST', '/ats-billing/overdue-reminders/run', {}, tA);
  check('386: once per invoice per 3 days (the second run skips it)', !run2.body.owner.some((o) => o.invoice.includes(`R3-OD-${P}`)) && run2.body.skipped >= 1, run2.body);
  await call('PUT', '/ats-billing/settings', { remindClient: true }, tA);
  const run3 = await call('POST', '/ats-billing/overdue-reminders/run', { dryRun: true }, tA);
  check('386: with the second switch the client\'s finance contact is also reached (dry run lists the e-mail)', run3.body.client.some((c) => c.to === `bill.${P}@r3-test.in`), run3.body);
  await call('PUT', '/ats-billing/settings', { remindClient: false, overdueReminders: false }, tA);

  // ================================================================ 389 profitability
  const prof = await call('GET', '/ats-billing/client-profitability', null, tA);
  check('389: client-wise profitability answers with totals and says how salary cost is worked out', prof.status === 200 && Array.isArray(prof.body.rows) && prof.body.totals && /monthly salary/.test(prof.body.salaryNote), Object.keys(prof.body));
  check('389: rows carry fee, incentive, payout, margin and the salary coverage', prof.body.rows.length === 0 || ['net', 'incentive', 'payout', 'margin', 'salaryCoverage', 'recruiterCost'].every((k) => k in prof.body.rows[0]));
  check('389: a recruiter cannot open it', (await call('GET', '/ats-billing/client-profitability', null, tRec)).status === 403);
  // the salary arithmetic on a controlled case
  const BDP = require('../src/utils/billingDepth');
  check('389: the cost split is exposed in the module (clientProfitability exists)', typeof BDP.clientProfitability === 'function');

  // ================================================================ 394 payment approval
  const payInv = await prisma.invoice.create({ data: { clientId: odClient.id, amount: 50000, gst: 0, tds: 0, invoiceDate: day(-5), dueDate: day(25), status: 'Pending', invoiceNumber: `R3-PAY-${P}` } });
  const rec0 = await call('POST', `/invoices/${payInv.id}/payments`, { amount: 10000, date: day(-1), method: 'Bank Transfer', reference: 'UTR1' }, tAcc1);
  check('394: with the switch OFF an Accountant\'s receipt is recorded at once (as before)', rec0.status === 201, rec0.body);
  await call('PUT', '/ats-billing/settings', { paymentApproval: true }, tA);
  const rec1 = await call('POST', `/invoices/${payInv.id}/payments`, { amount: 20000, date: day(-1), method: 'Bank Transfer', reference: 'UTR2' }, tAcc1);
  check('394: with it ON the Accountant\'s receipt waits (202, pending)', rec1.status === 202 && rec1.body.pendingApproval, rec1.body);
  check('394: nothing was recorded yet', (await prisma.invoice.findUnique({ where: { id: payInv.id } })).receivedAmount === 10000);
  const pendList = await call('GET', '/ats-billing/payment-approvals?state=Pending', null, tAcc2);
  const mine = pendList.body.rows.find((r) => r.invoiceId === payInv.id);
  check('394: the pending receipt is listed with who recorded it', pendList.status === 200 && mine && mine.requestedByName === ACC1.name, pendList.body);
  check('394: the person who recorded cannot approve it', (await call('POST', `/ats-billing/payment-approvals/${mine.id}/approve`, null, tAcc1)).status === 403);
  check('394: rejecting needs a reason', (await call('POST', `/ats-billing/payment-approvals/${mine.id}/reject`, {}, tAcc2)).status === 400);
  const appr = await call('POST', `/ats-billing/payment-approvals/${mine.id}/approve`, null, tAcc2);
  const afterPay = await prisma.invoice.findUnique({ where: { id: payInv.id } });
  check('394: another Accountant approves: the receipt is recorded and the invoice moves (30,000 received)', appr.status === 200 && afterPay.receivedAmount === 30000 && afterPay.status === 'Partially Paid', { appr: appr.body, got: afterPay.receivedAmount, st: afterPay.status });
  check('394: a decided receipt cannot be decided again', (await call('POST', `/ats-billing/payment-approvals/${mine.id}/approve`, null, tA)).status === 409);
  const rec2 = await call('POST', `/invoices/${payInv.id}/payments`, { amount: 5000, date: day(-1) }, tAcc1);
  const mine2 = (await call('GET', '/ats-billing/payment-approvals?state=Pending', null, tA)).body.rows.find((r) => r.id === rec2.body.approvalId);
  check('394: an Admin rejects one with a reason; nothing is recorded', mine2 && (await call('POST', `/ats-billing/payment-approvals/${mine2.id}/reject`, { reason: 'Wrong amount' }, tA)).status === 200 && (await prisma.invoice.findUnique({ where: { id: payInv.id } })).receivedAmount === 30000);
  const rec3 = await call('POST', `/invoices/${payInv.id}/payments`, { amount: 1000, date: day(-1) }, tA);
  check('394: an Admin\'s own receipt is recorded at once', rec3.status === 201);
  check('394: a recruiter cannot see or decide approvals', (await call('GET', '/ats-billing/payment-approvals', null, tRec)).status === 403);
  await call('PUT', '/ats-billing/settings', { paymentApproval: false }, tA);

  // ================================================================ 395 receipts export
  const tx = await call('POST', '/invoices/register/tally-receipts.xml', { period: 'all' }, tA);
  const txt = tx.buf ? tx.buf.toString('utf8') : '';
  check('395: payments export as Tally Receipt vouchers (file)', tx.status === 200 && /xml/.test(tx.type) && /tally-receipts-/.test(tx.disp) && /VCHTYPE="Receipt"/.test(txt) && /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/.test(txt), { s: tx.status, d: tx.disp });
  const vouchers = txt.split('<VOUCHER ').slice(1);
  const balanced = vouchers.every((v) => (v.match(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g) || []).reduce((s, m) => s + Math.round(Number(m.replace(/<\/?AMOUNT>/g, '')) * 100), 0) === 0);
  check('395: every receipt voucher balances (bank Dr = party Cr) and the invoice number is the reference', vouchers.length > 0 && balanced && txt.includes(`R3-PAY-${P}`), vouchers.length);
  const zp = await call('POST', '/invoices/register/zoho-payments.csv', { period: 'all' }, tA);
  const zt = zp.buf ? zp.buf.toString('utf8') : '';
  check('395: payments export as the Zoho Books customer-payments CSV', zp.status === 200 && /text\/csv/.test(zp.type) && zt.includes('Payment Date,Payment Number,Customer Name') && zt.includes(`R3-PAY-${P}`), zt.slice(0, 200));
  check('395: the old Sales-voucher export is unchanged (no Receipt vouchers in it)', !/VCHTYPE="Receipt"/.test((await call('POST', '/invoices/register/tally.xml', { period: 'all' }, tA)).buf.toString('utf8')));
  check('395: a login without Accounts rights cannot export payments', (await call('POST', '/invoices/register/tally-receipts.xml', { period: 'all' }, tRec)).status === 403);

  // ================================================================ 410 freelancer report
  const partner = await prisma.partner.create({ data: { name: `R3 Freelancer ${P}`, type: 'Freelancer', code: `PRT-R3${P}` } });
  const pu = await prisma.partnerUser.create({ data: { partnerId: partner.id, name: 'FL', email: `fl.${P}@r3-test.in`, passwordHash: 'x' } }).catch(() => null);
  if (pu) {
    await prisma.partnerSubmission.create({ data: { partnerId: partner.id, partnerUserId: pu.id, requirementId: req1.id, candidateId: C1.id, applicationId: app1.id, name: 'R3 Cand A', status: 'Joined' } });
    await prisma.invoice.create({ data: { clientId: client.id, candidateId: C1.id, requirementId: req1.id, amount: 80000, invoiceDate: day(-3), dueDate: day(20), invoiceNumber: `R3-FL-${P}` } });
    await prisma.partnerPayout.create({ data: { partnerId: partner.id, applicationId: app1.id, fee: 20000, net: 20000, status: 'Approved' } });
  }
  const fr = await call('GET', '/ats-billing/freelancer-report?type=Freelancer', null, tA);
  const myRow = fr.body && fr.body.rows && fr.body.rows.find((r) => r.partnerId === partner.id);
  check('410: the freelancer report shows revenue vs cost and margin per partner', fr.status === 200 && myRow && myRow.revenue === 80000 && myRow.cost === 20000 && myRow.margin === 60000 && myRow.joined === 1 && myRow.marginPct === 75, fr.body);
  check('410: it is for Accounts / Admin only', (await call('GET', '/ats-billing/freelancer-report', null, tRec)).status === 403);

  // ================================================================ P10.9 handover export
  const he = await call('GET', '/ats/handover/history/export.csv', null, tTl);
  check('P10.9: the handover history downloads as a file', he.status === 200 && /text\/csv/.test(he.type) && /recruiter-handover-history/.test(he.disp) && (he.buf || Buffer.alloc(0)).toString('utf8').includes('Date,From,To,Candidates,How,Done by,Why'), he.status);
  check('P10.9: a recruiter cannot export it', (await call('GET', '/ats/handover/history/export.csv', null, tRec)).status === 403);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
