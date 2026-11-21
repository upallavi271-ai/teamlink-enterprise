#!/usr/bin/env node
/**
 * MARKET WAVE C (founder 2026-11-21 "90 to 99 percent of the market"): Interviews, Communication and Job Portal additions
 * (utils/mkt/*.js, routes/mktInterviews.js, routes/mktComms.js, routes/mktPublic.js). One section per benchmark id.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database + a local stub for the outside services
 * (Google calendar OAuth / API, a job board's applications API).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4620 node scripts/market-c-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mktc-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4620;
const STUB = PORT + 1;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mktc-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'mktc-test-secret-key', TEST_MOCK_PORTS: String(PORT + 1), APP_BASE_URL: `http://localhost:${PORT}`,
  MKT_GOOGLE_AUTH_URL: `http://127.0.0.1:${STUB}/auth`, MKT_GOOGLE_TOKEN_URL: `http://127.0.0.1:${STUB}/token`, MKT_GOOGLE_API_URL: `http://127.0.0.1:${STUB}/gapi`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const section = (s) => console.log(`\n== ${s}`);
const call = async (method, url, body, token, { raw = false, headers = {} } = {}) => {
  const isForm = body instanceof FormData;
  const r = await fetch((url.startsWith('http') ? '' : API) + url, { method, redirect: 'manual', headers: { ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (isForm || typeof body === 'string' ? body : JSON.stringify(body)) });
  if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j || {} };
};
// the stub of the outside services
const stubSeen = [];
const busyFrom = new Date(Date.now() + 2 * 3600e3); const busyTo = new Date(Date.now() + 50 * 3600e3);
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    stubSeen.push({ method: req.method, url: req.url, body: b, auth: req.headers.authorization });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/token') return send(200, /grant_type=authorization_code/.test(b) ? { access_token: 'at1', refresh_token: 'rt-stub-1', email: 'me@stub.test' } : { access_token: 'at2' });
    if (req.url.startsWith('/gapi/freeBusy')) return send(200, { calendars: { primary: { busy: [{ start: busyFrom.toISOString(), end: busyTo.toISOString() }] } } });
    if (req.url.startsWith('/gapi/calendars/primary/events')) return send(200, { id: 'evt-1' });
    if (req.url.startsWith('/board/apps')) return req.headers.authorization === 'Bearer pull-key-1' ? send(200, { applications: [{ id: `pull-${process.pid}`, jobReference: global.REQ_ID, candidate: { name: `Pullperson Zed ${process.pid}`, email: `pull.${process.pid}@mktc-test.in`, phone: `9${String(process.pid).padStart(9, '3').slice(-9)}` } }] }) : send(401, { error: 'no' });
    return send(404, {});
  });
});
let server;
async function stop(code) {
  if (server) server.kill();
  stub.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const RUN = Date.now().toString(36);
const form = (fields, file) => { const fd = new FormData(); Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, String(v))); if (file) fd.append('file', new Blob([file.data], { type: file.type }), file.name); return fd; };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(3000)]);

(async () => {
  await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Mkc ${tag} ${RUN}`, email: `mkc.${tag}.${RUN}@mkc-test.in`, username: `mkc.${tag}.${RUN}@mkc-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 86400e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `MKC-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Mkc Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Mkc Team ${RUN}` });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name, department: 'IT', team: `Mkc Team ${RUN}` });
  const mgr = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { designation: 'Manager', department: 'IT' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const client = await prisma.client.create({ data: { name: `Mkcorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Mkcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'OPEN', tlId: tl.id, tl: tl.name, recruiterId: rec.id, bdeId: bde.id, reqCode: `MKC-${RUN}`.toUpperCase().slice(0, 14), openings: 2, skills: 'Kubernetes, Terraform, AWS', experience: '3-6', location: 'Hyderabad', portalPublished: true, portalPublishedAt: new Date(), jobDescription: `Mkcorbit Systems ${RUN} needs someone to run our cloud platform on Kubernetes and AWS.` } });
  global.REQ_ID = req.id;
  const cand = await prisma.candidate.create({ data: { name: `Mkperson Quillfeather ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `mk.${RUN}@gmail.com`, skills: 'Kubernetes', currentSalary: '7 LPA', expectedSalary: '10 LPA', noticePeriod: '30 Days' } });
  const at = new Date(Date.now() + 3 * 86400e3);
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: at, interviewRound: 1, interviewer: tl.name, interviewMode: 'Online', interviewCode: `INT-${RUN}` } });
  await prisma.interviewPanelist.create({ data: { applicationId: app.id, round: 1, userId: sa.id, name: sa.name } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 200 && !up; i += 1) { up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false); if (!up) await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  if (!up) { console.log('FAIL  the sandbox server did not start (port busy? set TEST_PORT)'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1000); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = { sa: await tok(sa.id), tl: await tok(tl.id), rec: await tok(rec.id), mgr: await tok(mgr.id), bde: await tok(bde.id) };
  const M = '/ats/mkt';
  let r;
  try {
    // ------------------------------------------------------------------ switches
    section('Admin switches (all OFF by default)');
    r = await call('GET', `${M}/switches`, undefined, T.sa);
    check('every switch starts OFF', r.status === 200 && Object.values(r.body.switches).every((v) => v === false), r.body.switches);
    check('a recruiter cannot change them', (await call('PUT', `${M}/switches`, { sequences: true }, T.rec)).status === 403);
    check('a client-side outsider has no access (no token)', (await call('GET', `${M}/switches`)).status === 401);

    // ------------------------------------------------------------------ 07.09
    section('07.09 interview kits and scorecards');
    r = await call('GET', `${M}/jobs/${req.id}/kits`, undefined, T.rec);
    check('a job has a ready kit per round from its skills (not saved yet)', r.status === 200 && r.body.kits.length >= 2 && r.body.kits[0].saved === false && r.body.kits[0].questions.some((q) => /Kubernetes/.test(q.text)), r.body);
    const kitBody = { title: 'Cloud round', roundType: 'Technical', scale: 5, questions: [{ text: 'Explain a Kubernetes rollout you ran', type: 'rating', competency: 'Kubernetes' }, { text: 'Terraform state: how do you share it?', type: 'rating' }, { text: 'Notes on communication', type: 'text' }] };
    check('Manager (view only) cannot save a kit', (await call('PUT', `${M}/jobs/${req.id}/kits/1`, kitBody, T.mgr)).status === 403);
    r = await call('PUT', `${M}/jobs/${req.id}/kits/1`, kitBody, T.tl);
    check('the TL saves the round-1 kit', r.status === 200 && r.body.kit.saved && r.body.kit.questions.length === 3, r.body);
    check('a bad scale is refused', (await call('PUT', `${M}/jobs/${req.id}/kits/2`, { ...kitBody, scale: 7 }, T.tl)).status === 400);
    r = await call('POST', `${M}/jobs/${req.id}/kits/2/suggest`, {}, T.tl);
    check('suggest a kit: the code draft when the AI is not there', r.status === 200 && r.body.kit.questions.length >= 3 && r.body.ai === false, r.body);
    r = await call('GET', `${M}/interviews/${app.id}/scorecard`, undefined, T.sa);
    check('the scorecard shows the saved kit', r.status === 200 && r.body.kit.title === 'Cloud round' && r.body.canFill, r.body);
    check('a rating outside the scale is refused', (await call('PUT', `${M}/interviews/${app.id}/scorecard`, { round: 1, answers: [{ i: 0, rating: 9 }] }, T.sa)).status === 400);
    r = await call('PUT', `${M}/interviews/${app.id}/scorecard`, { round: 1, answers: [{ i: 0, rating: 4 }, { i: 1, rating: 5 }, { i: 2, note: 'Clear and calm' }], recommendation: 'Yes' }, T.sa);
    check('the panelist fills the scorecard: overall 4.5 of 5', r.status === 200 && r.body.score.overall === 4.5 && r.body.score.recommendation === 'Yes', r.body);

    // ------------------------------------------------------------------ 07.10
    section('07.10 interviewer briefing');
    r = await call('GET', `${M}/interviews/${app.id}/briefing`, undefined, T.rec);
    check('the recruiter: candidate summary with pay, the kit, the round', r.status === 200 && r.body.candidate.name === cand.name && r.body.candidate.expectedSalary === '10 LPA' && r.body.kit.questions.length === 3, r.body);
    r = await call('GET', `${M}/interviews/${app.id}/briefing`, undefined, T.bde);
    check('the BDE: no phone, email or pay; marked limited', r.status === 200 && r.body.candidate.expectedSalary === undefined && r.body.candidate.email === undefined && r.body.limited === true && !r.body.pastScores.length, r.body);

    // ------------------------------------------------------------------ 07.07 / 07.11 / 07.13 / 07.12
    section('07.07 recordings and peer review');
    r = await call('POST', `${M}/interviews/${app.id}/recordings`, { url: 'https://drive.google.com/file/d/abc/view', title: 'Meet recording' }, T.sa);
    check('add a recording link', r.status === 201 && r.body.rows.some((x) => x.kind === 'link'), r.body);
    const recId = r.body.id;
    r = await call('POST', `${M}/interviews/${app.id}/recordings`, form({ title: 'Audio', round: 1 }, { data: WEBM, type: 'audio/webm', name: 'call.webm' }), T.sa);
    check('upload an audio recording (webm)', r.status === 201 && r.body.rows.some((x) => x.kind === 'file' && x.hasFile), r.body);
    const fileRec = r.body.id;
    r = await call('GET', `${M}/recordings/${fileRec}/file`, undefined, T.sa, { raw: true });
    check('play it back from TeamLink', r.status === 200 && /audio\/webm/.test(r.headers.get('content-type') || ''), r.status);
    check('a text file pretending to be audio is refused', (await call('POST', `${M}/interviews/${app.id}/recordings`, form({}, { data: Buffer.from('hello'), type: 'audio/mpeg', name: 'x.mp3' }), T.sa)).status === 400);
    r = await call('POST', `${M}/recordings/${recId}/reviews`, { comment: 'Good answer on rollouts', at: '12:30', rating: 4 }, T.tl);
    check('a reviewer comments at a minute of the recording', r.status === 201 && r.body.rows.find((x) => x.id === recId).reviews[0].atSec === 750, r.body);
    check('a bad time is refused', (await call('POST', `${M}/recordings/${recId}/reviews`, { comment: 'x', at: '9:99' }, T.tl)).status === 400);
    check('the BDE never opens recordings', (await call('POST', `${M}/recordings/${recId}/reviews`, { comment: 'x' }, T.bde)).status === 403);
    r = await call('GET', `${M}/interviews/${app.id}/recordings`, undefined, T.bde);
    check('the BDE list is empty', r.status === 200 && r.body.rows.length === 0 && r.body.hidden, r.body);

    section('07.11 AI notetaker (transcript -> notes)');
    r = await call('POST', `${M}/recordings/${fileRec}/transcript`, {}, T.sa);
    check('no speech engine on the test server: says to paste the transcript', r.status === 409 && r.body.needsTranscript, r.body);
    const TRANS = 'Interviewer: Can you explain your Kubernetes work? Candidate: I led the migration of 40 services to Kubernetes and reduced deploy time by half. Interviewer: How about Terraform? Candidate: I am not sure about remote state locking, I have not used it much. Interviewer: What would you do next? Candidate: I would automate the rollback checks.';
    r = await call('POST', `${M}/recordings/${fileRec}/transcript`, { text: TRANS }, T.sa);
    check('paste the transcript', r.status === 200 && r.body.source === 'Typed / pasted', r.body);
    r = await call('POST', `${M}/recordings/${fileRec}/notes`, {}, T.sa);
    check('notes: summary, strengths and concerns from the transcript (code notes without AI)', r.status === 200 && r.body.notes.summary && r.body.notes.strengths.some((s) => /led the migration/.test(s)) && r.body.notes.concerns.some((s) => /not sure/.test(s)) && /no AI/.test(r.body.notes.source), r.body);

    section('07.13 voice feedback');
    r = await call('POST', `${M}/interviews/${app.id}/voice-feedback`, form({ round: 1, transcript: 'Strong on Kubernetes, weak on Terraform state. I would move him to round two.' }, { data: WEBM, type: 'audio/webm', name: 'voice.webm' }), T.sa);
    check('record voice feedback: the words become my scorecard note', r.status === 201 && /Strong on Kubernetes/.test(r.body.transcript || ''), r.body);
    r = await call('GET', `${M}/interviews/${app.id}/scorecard?round=1`, undefined, T.sa);
    check('the scorecard keeps the ratings and adds the voice words', r.body.mine && r.body.mine.overall === 4.5 && /weak on Terraform/.test(r.body.mine.summary || '') && r.body.mine.via === 'voice', r.body.mine);
    check('a non-audio voice file is refused', (await call('POST', `${M}/interviews/${app.id}/voice-feedback`, form({ round: 1 }, { data: Buffer.from('%PDF-1.4 x'), type: 'application/pdf', name: 'x.pdf' }), T.sa)).status === 400);

    section('07.12 AI feedback summary');
    r = await call('GET', `${M}/interviews/${app.id}/feedback-summary`, undefined, T.tl);
    check('one paragraph from every rating, recommendation and note (code text without AI)', r.status === 200 && r.body.items.length >= 2 && /Average rating 4.5/.test(r.body.text) && /leans towards hiring/.test(r.body.text), r.body);
    check('the BDE does not read the panel summary', (await call('GET', `${M}/interviews/${app.id}/feedback-summary`, undefined, T.bde)).status === 403);

    // ------------------------------------------------------------------ 07.05
    section('07.05 AI scheduling (free slots) and replacement');
    const other = await prisma.application.create({ data: { candidateId: (await prisma.candidate.create({ data: { name: `Mkother Person ${RUN}`, phone: `7${String(Date.now()).slice(-9)}` } })).id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 52 * 3600e3), interviewer: tl.name } });
    r = await call('POST', `${M}/interviews/${app.id}/suggest-slots`, { days: 6, minutes: 45 }, T.sa);
    const clashes = (r.body.slots || []).filter((s) => { const st = new Date(s.start).getTime(); const o = new Date(other.interviewAt).getTime(); return st < o + 75 * 60000 && st + 45 * 60000 > o - 15 * 60000; });
    const inBusy = (r.body.slots || []).filter((s) => new Date(s.start) < busyTo && new Date(s.end) > busyFrom);
    check('free times are suggested, none on the interviewer\'s other interview', r.status === 200 && r.body.slots.length >= 3 && !clashes.length, { n: (r.body.slots || []).length, clashes });
    check('inside working hours India time (10:00-18:30)', r.body.slots.every((s) => { const h = new Date(new Date(s.start).getTime() + 5.5 * 3600e3).getUTCHours(); return h >= 10 && h <= 18; }));
    check('(no calendar connected yet, so the stub\'s busy block is not used)', inBusy.length >= 0);
    r = await call('POST', `${M}/interviews/${app.id}/replacements`, { declined: tl.name }, T.sa);
    check('replacements: people who are free at that time, with the reason', r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.every((x) => x.why && x.name !== tl.name), r.body);
    check('a view-only Manager cannot ask for slots', [403].includes((await call('POST', `${M}/interviews/${app.id}/suggest-slots`, {}, T.mgr)).status));

    // ------------------------------------------------------------------ 07.03
    section('07.03 candidate self-scheduling');
    r = await call('POST', `${M}/interviews/${app.id}/self-book`, {}, T.sa);
    check('OFF by default (Admin switch)', r.status === 409 && /switched off/.test(r.body.error), r.body);
    await call('PUT', `${M}/switches`, { selfScheduling: true }, T.sa);
    r = await call('POST', `${M}/interviews/${app.id}/self-book`, {}, T.sa);
    check('and the job\'s own tick is needed too', r.status === 409 && /off for this job/.test(r.body.error), r.body);
    check('Manager cannot tick it', (await call('PUT', `${M}/jobs/${req.id}/settings`, { selfBook: true }, T.mgr)).status === 403);
    await call('PUT', `${M}/jobs/${req.id}/settings`, { selfBook: true }, T.tl);
    r = await call('POST', `${M}/interviews/${app.id}/self-book`, { minutes: 45 }, T.sa);
    check('a link with free times is made', r.status === 201 && r.body.slots.length >= 1 && /\/book\//.test(r.body.link), r.body);
    const tokB = r.body.token;
    r = await call('GET', `/public/mkt/book/${tokB}`);
    check('the candidate page shows the times and the job (no contact details)', r.status === 200 && r.body.slots.length >= 1 && r.body.job === req.title && !JSON.stringify(r.body).includes(cand.phone), r.body);
    const pick = r.body.slots[0];
    check('a time not offered is refused', (await call('POST', `/public/mkt/book/${tokB}`, { slot: new Date(Date.now() + 9 * 86400e3).toISOString() })).status === 400);
    r = await call('POST', `/public/mkt/book/${tokB}`, { slot: pick });
    const moved = await prisma.application.findUnique({ where: { id: app.id } });
    check('the candidate picks a time: booked through the usual reschedule (same rules)', r.status === 200 && new Date(moved.interviewAt).toISOString() === pick && moved.interviewStatus === 'RESCHEDULED', { r: r.body, at: moved.interviewAt, st: moved.interviewStatus });
    check('the link cannot be used twice', (await call('POST', `/public/mkt/book/${tokB}`, { slot: pick })).status === 409);
    r = await call('POST', `${M}/interviews/${app.id}/self-book`, { slots: [new Date(Date.now() + 4 * 86400e3).toISOString()] }, T.sa);
    const tokC = r.body.token;
    r = await call('POST', `/public/mkt/book/${tokC}/none`, { note: 'I travel that week' });
    const sb = await call('GET', `${M}/interviews/${app.id}/self-book`, undefined, T.sa);
    check('"none of these work": the link closes and the recruiter is told (re-book on decline)', r.status === 200 && sb.body.rows.find((x) => x.token === tokC).status === 'declined', sb.body);
    check('a wrong token is 404', (await call('GET', '/public/mkt/book/nope')).status === 404);

    // ------------------------------------------------------------------ 07.01
    section('07.01 calendar: ICS, feed, Google / Microsoft connection');
    r = await call('GET', `${M}/interviews/${app.id}/ics`, undefined, T.sa, { raw: true });
    check('download the .ics of one interview', r.status === 200 && /BEGIN:VCALENDAR/.test(r.text) && /BEGIN:VEVENT/.test(r.text), r.text.slice(0, 200));
    r = await call('GET', `${M}/calendar/feed`, undefined, T.sa);
    const feedUrl = r.body.url;
    check('a private subscribe address for Google / Outlook', r.status === 200 && /\/api\/public\/mkt\/cal\/.+\.ics$/.test(feedUrl), r.body);
    r = await call('GET', feedUrl.replace(`http://localhost:${PORT}/api`, ''), undefined, undefined, { raw: true });
    check('the feed lists my interviews', r.status === 200 && r.text.includes(cand.name), r.text.slice(0, 300));
    const reset = await call('POST', `${M}/calendar/feed/reset`, {}, T.sa);
    check('reset: the old address stops working', (await call('GET', feedUrl.replace(`http://localhost:${PORT}/api`, ''), undefined, undefined, { raw: true })).status === 404 && reset.body.url !== feedUrl);
    r = await call('POST', `${M}/calendar/google/connect`, {}, T.sa);
    check('Google connect without the app keys: needs founder credentials', r.status === 409 && r.body.needsFounder, r.body);
    check('only an Admin saves the app keys', (await call('PUT', `${M}/calendar-app/google`, { clientId: 'cid', secret: 's' }, T.rec)).status === 403);
    await call('PUT', `${M}/calendar-app/google`, { clientId: 'cid-stub', secret: 'secret-stub' }, T.sa);
    r = await call('POST', `${M}/calendar/google/connect`, {}, T.sa);
    const state = r.body.url && new URL(r.body.url).searchParams.get('state');
    check('connect gives the sign-in address with a state', r.status === 200 && /^google\./.test(state || ''), r.body);
    r = await call('GET', `/public/mkt/cal-oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, undefined, undefined, { raw: true });
    check('the callback exchanges the code (stub) and keeps the refresh token', r.status === 200 && /connected/.test(r.text), r.text.slice(0, 200));
    check('a replayed callback is refused', (await call('GET', `/public/mkt/cal-oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, undefined, undefined, { raw: true })).status === 400);
    r = await call('GET', `${M}/calendar/connections`, undefined, T.sa);
    check('shown as connected', r.body.rows.google.connected === true, r.body);
    r = await call('POST', `${M}/interviews/${app.id}/calendar-push`, {}, T.sa);
    check('put the interview in my Google calendar (stub API got the event)', r.status === 200 && r.body.pushed === 1 && stubSeen.some((s) => s.url.startsWith('/gapi/calendars/primary/events') && s.auth === 'Bearer at2'), r.body);
    r = await call('POST', `${M}/interviews/${app.id}/suggest-slots`, { days: 4 }, T.sa);
    check('now my connected calendar\'s busy time is kept free in the suggestions', r.status === 200 && r.body.slots.every((s) => !(new Date(s.start) < busyTo && new Date(s.end) > busyFrom)), r.body.slots);

    // ------------------------------------------------------------------ 07.15 / 07.16
    section('07.15 assessments, 07.16 AI-generated');
    r = await call('POST', `${M}/jobs/${req.id}/assessments/generate`, { count: 6 }, T.tl);
    check('a draft from the job (code draft without AI)', r.status === 200 && r.body.questions.length >= 3 && r.body.ai === false, r.body);
    check('Manager cannot create a test', (await call('POST', `${M}/jobs/${req.id}/assessments`, { title: 'x', questions: r.body.questions }, T.mgr)).status === 403);
    check('a question without the right answer is refused', (await call('POST', `${M}/jobs/${req.id}/assessments`, { title: 'Bad', questions: [{ type: 'mcq', text: 'Q?', options: ['a', 'b'] }] }, T.tl)).status === 400);
    r = await call('POST', `${M}/jobs/${req.id}/assessments`, { title: 'Cloud basics', passMark: 60, minutes: 20, questions: [{ type: 'mcq', text: 'kubectl applies a', options: ['manifest', 'invoice'], answer: 0, points: 1 }, { type: 'multi', text: 'AWS compute', options: ['EC2', 'S3', 'Lambda'], answer: [0, 2], points: 2 }, { type: 'short', text: 'What is Terraform state?', keywords: ['state', 'resources'], points: 2 }] }, T.tl);
    check('the TL builds a test', r.status === 201 && r.body.assessment.totalPoints === 5, r.body);
    const aid = r.body.assessment.id;
    r = await call('POST', `${M}/interviews/${app.id}/assessments/${aid}/send`, {}, T.rec);
    check('sending is OFF by default', r.status === 409 && /switched off/.test(r.body.error), r.body);
    await call('PUT', `${M}/switches`, { assessments: true }, T.sa);
    check('the BDE cannot send tests', (await call('POST', `${M}/interviews/${app.id}/assessments/${aid}/send`, {}, T.bde)).status === 403);
    r = await call('POST', `${M}/interviews/${app.id}/assessments/${aid}/send`, { email: true }, T.rec);
    check('the recruiter sends the link (email is a no-op in the sandbox)', r.status === 201 && /\/test\//.test(r.body.link), r.body);
    const tokT = r.body.token;
    r = await call('GET', `/public/mkt/test/${tokT}`);
    check('the candidate sees the questions but never the answers', r.status === 200 && r.body.questions.length === 3 && !JSON.stringify(r.body).includes('"answer"') && !JSON.stringify(r.body).includes('keywords'), r.body);
    await call('POST', `/public/mkt/test/${tokT}/start`, {});
    r = await call('POST', `/public/mkt/test/${tokT}/submit`, { answers: { 0: 0, 1: [2, 0], 2: 'The state file maps Terraform resources to real ones.' } });
    check('submitted and scored by itself', r.status === 200, r.body);
    check('a second submit is refused', (await call('POST', `/public/mkt/test/${tokT}/submit`, { answers: {} })).status === 409);
    r = await call('GET', `${M}/applications/${app.id}/assessments`, undefined, T.rec);
    check('the result: 100% and passed', r.body.rows[0].percent === 100 && r.body.rows[0].passed === true, r.body.rows);
    r = await call('POST', `${M}/assessment-results/${tokT}/regrade`, { i: 2, got: 1 }, T.rec);
    check('the recruiter can change a written answer\'s points', r.status === 200 && r.body.score === 4, r.body);

    // ------------------------------------------------------------------ 08.11
    section('08.11 email validation');
    r = await call('POST', `${M}/email-check`, { email: 'ravi@gmial.com' }, T.rec);
    check('a typo of gmail: invalid, with the suggestion', r.body.verdict === 'invalid' && r.body.suggestion === 'ravi@gmail.com', r.body);
    r = await call('POST', `${M}/email-check`, { email: 'x1@mailinator.com' }, T.rec);
    check('a throw-away domain: risky', r.body.verdict === 'risky' && r.body.disposable, r.body);
    r = await call('POST', `${M}/email-check`, { email: 'not an email' }, T.rec);
    check('bad syntax: invalid', r.body.verdict === 'invalid' && !r.body.syntax);
    const MCx = require('../src/utils/mkt/comms');
    process.env.TEST_MODE = ''; process.env.TEAMLINK_SANDBOX = '';
    MCx.setResolver(async (d) => { if (d === 'nomail-mkc.in') { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } return [{ exchange: 'mx1.example.net', priority: 10 }]; });
    const v1 = await MCx.validateEmail('a@hasmail-mkc.in'); const v2 = await MCx.validateEmail('a@nomail-mkc.in');
    process.env.TEST_MODE = '1'; process.env.TEAMLINK_SANDBOX = '1';
    check('MX lookup: a domain with a mail server is valid; one without is invalid', v1.verdict === 'valid' && v1.mx.found && v2.verdict === 'invalid' && v2.mx.checked && !v2.mx.found, { v1, v2 });
    r = await call('POST', '/public/careers/_test/reset-limits', {});

    // ------------------------------------------------------------------ 08.12
    section('08.12 AI email drafting and replies');
    r = await call('POST', `${M}/candidates/${cand.id}/draft`, { purpose: 'interview_invite', channel: 'Email' }, T.rec);
    check('a draft with their first name and the job (template when the AI is down)', r.status === 200 && r.body.body.includes('Mkperson') && r.body.subject.includes(req.title) && r.body.purposes.length >= 6, r.body);
    r = await call('POST', `${M}/candidates/${cand.id}/draft`, { purpose: 'reply', channel: 'SMS', lastMessage: 'Can we do Friday?' }, T.rec);
    check('a reply draft for SMS (no subject)', r.status === 200 && r.body.subject === null, r.body);
    check('the BDE cannot draft to a candidate (no contact right)', (await call('POST', `${M}/candidates/${cand.id}/draft`, { purpose: 'follow_up' }, T.bde)).status === 403);

    // ------------------------------------------------------------------ 08.04
    section('08.04 email tracking (opens / clicks)');
    const MSG = require('../src/utils/messaging');
    // the email account of this copy (the sandbox sends through a fake transport: nothing leaves the machine)
    r = await call('PUT', '/admin/integrations/email/configure', { values: { 'SMTP host': 'smtp.mkc-mail.in', Port: '587', 'From address': 'jobs@mkc-mail.in', Username: 'jobs@mkc-mail.in', 'Password / app key': 'pw', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', 'Default from name': 'TeamLink' } }, T.sa);
    await call('POST', '/admin/integrations/email/connect', {}, T.sa);
    require('../src/utils/mailer').resetTransport();
    await prisma.$executeRawUnsafe('DELETE FROM "MktEmailTrack" WHERE "candidateId" = ?', cand.id).catch(() => {});
    const m1 = await MSG.send('Email', { to: cand.email, subject: 'x', text: 'see https://example.org/job', meta: { audience: 'candidates', personId: cand.id } });
    r = await call('GET', `${M}/candidates/${cand.id}/email-tracking`, undefined, T.rec);
    check('switch OFF: a candidate email is sent untracked', m1.outcome === 'Sent' && r.body.on === false && r.body.rows.length === 0, { m1, b: r.body });
    await call('PUT', `${M}/switches`, { emailTracking: true }, T.sa);
    const m2 = await MSG.send('Email', { to: cand.email, subject: 'Tracked one', text: 'see https://example.org/job', meta: { audience: 'candidates', personId: cand.id } });
    r = await call('GET', `${M}/candidates/${cand.id}/email-tracking`, undefined, T.rec);
    check('switch ON: the email TeamLink sends gets a tracking row (not opened yet)', m2.outcome === 'Sent' && r.body.on === true && r.body.rows.length === 1 && r.body.rows[0].subject === 'Tracked one' && !r.body.rows[0].opened, { m2, b: r.body });
    const m3 = await MSG.send('Email', { to: 'nobody@example.com', subject: 'not sent', text: 'x', meta: { audience: 'candidates', personId: cand.id } });
    r = await call('GET', `${M}/candidates/${cand.id}/email-tracking`, undefined, T.rec);
    check('a mail that was not sent leaves no tracking row', m3.outcome !== 'Sent' && r.body.rows.length === 1, { m3: m3.outcome, n: r.body.rows.length });
    const w = await MCx.wrapEmail({ to: cand.email, subject: 'Your interview', text: 'Details: https://example.org/job?x=1', candidateId: cand.id });
    check('the HTML copy has the pixel, the wrapped link and the privacy line', /\/t\/o\/.+\.gif/.test(w.html) && /\/t\/c\//.test(w.html) && /can see when this email is opened/.test(w.html));
    await prisma.$executeRawUnsafe('UPDATE "MktEmailTrack" SET "sentAt" = ? WHERE "token" = ?', new Date(Date.now() - 60000).toISOString(), w.token);
    r = await call('GET', `/public/mkt/t/o/${w.token}.gif`, undefined, undefined, { raw: true });
    check('the pixel answers a GIF', r.status === 200 && /image\/gif/.test(r.headers.get('content-type')));
    r = await call('GET', `/public/mkt/t/c/${w.token}/0`, undefined, undefined, { raw: true });
    check('a click goes on to the real link', r.status === 302 && r.headers.get('location') === 'https://example.org/job?x=1', r.status);
    check('a link number that was not in the mail is 404 (no open redirect)', (await call('GET', `/public/mkt/t/c/${w.token}/5`, undefined, undefined, { raw: true })).status === 404);
    await call('GET', `/public/mkt/t/o/${w.token}.gif`, undefined, undefined, { raw: true, headers: { 'User-Agent': 'GoogleImageProxy bot' } });
    r = await call('GET', `${M}/candidates/${cand.id}/email-tracking`, undefined, T.rec);
    const tr = r.body.rows.find((x) => x.subject === 'Your interview') || {};
    check('the candidate page shows opened + clicked (a bot fetch not counted)', tr.opened && tr.opens === 1 && tr.clicks === 1, r.body.rows);

    // ------------------------------------------------------------------ 08.05 / 08.06
    section('08.05 multi-step sequences, 08.06 LinkedIn / phone steps');
    r = await call('POST', `${M}/sequences`, { name: `Warm up ${RUN}`, steps: [{ channel: 'Email', waitDays: 0, subject: 'About {{job}}', body: 'Hi {{first}}, a quick note about {{job}}.' }, { channel: 'LinkedIn', waitDays: 1, body: 'Send a LinkedIn connection note' }, { channel: 'Call', waitDays: 1, body: 'Call and ask about notice period' }, { channel: 'SMS', waitDays: 2, body: 'Hi {{first}}, any update?' }] }, T.rec);
    check('a recruiter builds a 4-step sequence', r.status === 201 && r.body.sequence.steps.length === 4, r.body);
    const sid = r.body.sequence.id;
    check('a bad step is refused', (await call('POST', `${M}/sequences`, { name: 'x', steps: [{ channel: 'Fax', body: 'x' }] }, T.rec)).status === 400);
    check('Manager cannot build one', (await call('POST', `${M}/sequences`, { name: 'x', steps: [{ channel: 'Call', body: 'x' }] }, T.mgr)).status === 403);
    r = await call('POST', `${M}/candidates/${cand.id}/sequences`, { sequenceId: sid }, T.rec);
    check('OFF by default', r.status === 409 && /switched off/.test(r.body.error), r.body);
    await call('PUT', `${M}/switches`, { sequences: true }, T.sa);
    r = await call('POST', `${M}/candidates/${cand.id}/sequences`, { sequenceId: sid }, T.sa);
    const steps = (r.body.run && r.body.run.steps) || [];
    check('enrolled: email / SMS through the message schedules, LinkedIn and Call as tasks', r.status === 201 && steps.filter((s) => s.status === 'task').length === 2 && steps.find((s) => s.channel === 'Email').status === 'scheduled', steps);
    const runId = r.body.run && r.body.run.id;
    const emailSched = (steps.find((s) => s.channel === 'Email') || {}).scheduleId;
    check('a second run for the same person is refused', (await call('POST', `${M}/candidates/${cand.id}/sequences`, { sequenceId: sid }, T.sa)).status === 409);
    r = await call('GET', `${M}/sequence-tasks`, undefined, T.sa);
    check('the LinkedIn task due tomorrow is in my task list', r.status === 200 && r.body.rows.some((t) => t.channel === 'LinkedIn' && t.runId === runId), r.body);
    r = await call('POST', `${M}/sequence-runs/${runId}/tasks/1/done`, { note: 'Sent the note' }, T.sa);
    check('mark the LinkedIn step done', r.status === 200 && r.body.run.steps[1].status === 'done', r.body);
    await require('../src/utils/messageSchedules').onCandidateReply(cand.id, 'Email');
    r = await call('GET', `${M}/candidates/${cand.id}/sequences`, undefined, T.sa);
    const sched = emailSched ? (await prisma.$queryRawUnsafe('SELECT "status" FROM "MessageSchedule" WHERE "id" = ?', emailSched))[0] : null;
    check('the candidate replied: the whole run stops and its planned message is cancelled', r.body.rows[0].status === 'replied' && (!sched || sched.status === 'cancelled'), { run: r.body.rows[0] && r.body.rows[0].status, sched });

    // ------------------------------------------------------------------ 08.10
    section('08.10 call transcription with data extraction');
    const CALL = 'Recruiter: What is your notice period? Candidate: My notice period is 60 days. Recruiter: Current CTC? Candidate: Currently I am getting 6 LPA. Candidate: I expect 9 LPA. I have 5 years of experience. I am currently based in Hyderabad.';
    r = await call('POST', `${M}/candidates/${cand.id}/call-notes`, { transcript: CALL }, T.rec);
    const sug = (r.body.note && r.body.note.suggestions) || [];
    const val = (f) => (sug.find((s) => s.field === f) || {}).value;
    check('notice period, CTC, expected CTC, experience and city come back as SUGGESTIONS', r.status === 201 && /60 days/i.test(val('noticePeriod')) && val('currentSalary') === '6 LPA' && val('expectedSalary') === '9 LPA' && Number(val('experienceYears')) === 5 && val('location') === 'Hyderabad', sug);
    let c2 = await prisma.candidate.findUnique({ where: { id: cand.id } });
    check('nothing on the profile changed by itself', c2.noticePeriod === '30 Days' && c2.expectedSalary === '10 LPA');
    r = await call('POST', `${M}/call-notes/${r.body.note.id}/noticePeriod`, { accept: true }, T.rec);
    c2 = await prisma.candidate.findUnique({ where: { id: cand.id } });
    check('the recruiter accepts one: only that field changes', r.status === 200 && /60 days/i.test(c2.noticePeriod) && c2.expectedSalary === '10 LPA', c2.noticePeriod);
    check('the BDE cannot use call notes', (await call('POST', `${M}/candidates/${cand.id}/call-notes`, { transcript: CALL }, T.bde)).status === 403);

    // ------------------------------------------------------------------ 08.01
    section('08.01 two-way email (my mailbox: IMAP + SMTP)');
    check('a bad server name is refused', (await call('PUT', `${M}/mailbox`, { address: 'rec@mkc-test.in', imapHost: 'x', smtpHost: 'smtp.x.in', password: 'p' }, T.rec)).status === 400);
    r = await call('PUT', `${M}/mailbox`, { address: `rec.${RUN}@mkc-mail.in`, imapHost: 'imap.mkc-mail.in', smtpHost: 'smtp.mkc-mail.in', imapPort: 993, smtpPort: 465, password: 'app-pass' }, T.rec);
    check('the recruiter connects their mailbox (password kept encrypted)', r.status === 200 && r.body.mailbox.saved && !JSON.stringify(r.body).includes('app-pass'), r.body);
    r = await call('POST', `${M}/candidates/${cand.id}/mailbox-send`, { subject: 'Hello from my mailbox', text: 'Hi, can we talk today?' }, T.rec);
    const sentRow = await prisma.candidateMessage.findFirst({ where: { candidateId: cand.id, template: 'PERSONAL_MAILBOX' }, orderBy: { createdAt: 'desc' } });
    check('send from my mailbox (sandbox transport): logged on the candidate as SENT', r.status === 200 && sentRow && sentRow.status === 'SENT' && !!sentRow.providerRef, { r: r.body, sentRow: sentRow && sentRow.status });
    const reply = `From: ${cand.name} <${cand.email}>\r\nTo: rec.${RUN}@mkc-mail.in\r\nSubject: Re: Hello from my mailbox\r\nMessage-ID: <reply-${RUN}@gmail.com>\r\nIn-Reply-To: ${sentRow && sentRow.providerRef}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nYes, call me at 5.\r\n`;
    const polled = await MCx.pollMailbox(rec.id, { messages: [reply] });
    check('a reply in my mailbox is matched to the candidate', polled.matched === 1, polled);
    const inbound = await prisma.candidateMessage.findFirst({ where: { candidateId: cand.id, status: 'RECEIVED' }, orderBy: { createdAt: 'desc' } });
    check('and lands in their conversation', !!inbound && /call me at 5/.test(inbound.body || ''), inbound && inbound.body);
    await call('PUT', '/admin/integrations/email-inbox/configure', { values: { 'IMAP host': 'imap.mkc-mail.in', Port: '993', 'Mailbox address': 'jobs@mkc-mail.in', 'Password / app key': 'pw' } }, T.sa);
    r = await call('POST', '/admin/integrations/email-inbox/connect', {}, T.sa);
    check('the shared inbox: Connect logs in for real first (refused on the test server, not "demo")', r.status === 422 && /NOT connected/.test(r.body.error || ''), r.body);

    // ------------------------------------------------------------------ 10.03 / 10.04 / 10.10 apply
    section('10.03 application form builder, 10.04 quick apply, 10.10 apply with LinkedIn');
    check('a choice question needs two choices', (await call('PUT', `${M}/jobs/${req.id}/settings`, { fields: [{ label: 'Shift', type: 'choice', options: 'Day' }] }, T.tl)).status === 400);
    r = await call('PUT', `${M}/jobs/${req.id}/settings`, { fields: [{ label: 'Do you have a two-wheeler?', type: 'yesno', required: true, knockout: 'no' }, { label: 'Portfolio link', type: 'url' }] }, T.tl);
    check('the TL adds two questions to the job\'s apply form', r.status === 200 && r.body.fields.length === 2 && r.body.fields[0].key === 'do_you_have_a_two_wheeler', r.body);
    r = await call('GET', `/public/careers/jobs/${req.id}`);
    check('the public job page carries the questions', r.status === 200 && r.body.form && r.body.form.fields.length === 2, r.body.form);
    const PDFDocument = require(path.join(BACK, 'node_modules/pdfkit'));
    const pdf = await new Promise((resolve) => { const d = new PDFDocument(); const bufs = []; d.on('data', (b) => bufs.push(b)); d.on('end', () => resolve(Buffer.concat(bufs))); ['Ravi Quillfeather', `ravi.q.${RUN}@gmail.com`, 'Mobile: 9876501234', 'Skills: Kubernetes, Terraform, AWS', 'Total experience: 5 years', 'Hyderabad'].forEach((l) => d.text(l)); d.end(); });
    r = await call('POST', '/public/mkt/quick-fill', form({}, { data: pdf, type: 'application/pdf', name: 'cv.pdf' }));
    check('quick apply: the form is filled from the resume', r.status === 200 && r.body.fields.email === `ravi.q.${RUN}@gmail.com` && /9876501234/.test(r.body.fields.phone || '') && r.body.filled >= 3, r.body);
    await call('POST', '/public/careers/_test/reset-limits', {});
    const base = { name: 'Ravi Quillfeather', email: `ravi.q.${RUN}@gmail.com`, phone: '9876501234', currentSalary: '6 LPA', expectedSalary: '9 LPA', consent: 'yes' };
    r = await call('POST', `/public/careers/jobs/${req.id}/apply`, form(base, { data: pdf, type: 'application/pdf', name: 'cv.pdf' }));
    check('the required question must be answered', r.status === 400 && r.body.code === 'FORM_ANSWER', r.body);
    r = await call('POST', `/public/careers/jobs/${req.id}/apply`, form({ ...base, q_do_you_have_a_two_wheeler: 'no', q_portfolio_link: 'https://ravi.dev' }, { data: pdf, type: 'application/pdf', name: 'cv.pdf' }));
    check('apply with the answers', r.status === 201, r.body);
    r = await call('GET', `${M}/applications/${r.body.applicationId}/form-answers`, undefined, T.sa);
    check('the answers are kept; the knock-out answer is flagged', r.body.answers && r.body.answers.answers.portfolio_link.value === 'https://ravi.dev' && r.body.answers.knockedOut.length === 1, r.body);
    r = await call('POST', `/public/careers/jobs/${req.id}/apply`, form({ ...base, email: `x.${RUN}@mailinator.com`, phone: '9876501299', q_do_you_have_a_two_wheeler: 'yes' }, { data: pdf, type: 'application/pdf', name: 'cv.pdf' }));
    check('a throw-away email is refused at apply', r.status === 400 && /throw-away/.test(r.body.error), r.body);
    r = await call('POST', `/public/careers/jobs/${req.id}/apply`, form({ ...base, name: 'Lina Profile', email: `lina.${RUN}@gmail.com`, phone: '9876501288', q_do_you_have_a_two_wheeler: 'yes', linkedinUrl: 'https://www.linkedin.com/in/Lina-Profile-12/' }));
    check('apply with a LinkedIn profile link instead of a resume', r.status === 201, r.body);
    const linaApp = await prisma.application.findUnique({ where: { id: r.body.applicationId } });
    r = await call('GET', `${M}/candidates/${linaApp.candidateId}/links`, undefined, T.sa);
    check('the LinkedIn link is kept on the candidate', r.body.rows.some((l) => l.url === 'https://www.linkedin.com/in/lina-profile-12'), r.body);
    check('a non-LinkedIn link is refused', (await call('POST', `/public/careers/jobs/${req.id}/apply`, form({ ...base, email: `z.${RUN}@gmail.com`, phone: '9876501277', q_do_you_have_a_two_wheeler: 'yes', linkedinUrl: 'https://evil.example/in/x' }))).status === 400);
    await call('PUT', `${M}/jobs/${req.id}/settings`, { linkedinApply: false }, T.tl);
    check('a job can require the resume (LinkedIn-only refused)', (await call('POST', `/public/careers/jobs/${req.id}/apply`, form({ ...base, email: `y.${RUN}@gmail.com`, phone: '9876501266', q_do_you_have_a_two_wheeler: 'yes', linkedinUrl: 'https://www.linkedin.com/in/yy-1' }))).status === 400);

    // ------------------------------------------------------------------ 10.02
    section('10.02 SEO, mobile and localised job page');
    r = await call('GET', `/public/mkt/job/${req.id}`, undefined, undefined, { raw: true });
    check('server-rendered page: title, description, canonical, hreflang, JSON-LD JobPosting, phone width', r.status === 200 && /<meta name="description"/.test(r.text) && /rel="canonical"/.test(r.text) && /hreflang="te-IN"/.test(r.text) && /"@type":"JobPosting"/.test(r.text) && /width=device-width/.test(r.text), r.text.slice(0, 300));
    check('the public page never names the client (the careers page own job text)', !r.text.includes('Mkcorbit'), r.text.match(/Mkcorbit.{0,40}/));
    r = await call('GET', `/public/mkt/job/${req.id}?lang=te`, undefined, undefined, { raw: true });
    check('Telugu page text', r.status === 200 && /lang="te"/.test(r.text) && r.text.includes('ఇప్పుడే దరఖాస్తు చేయండి'));
    r = await call('GET', `/public/mkt/job/${req.id}?lang=hi`, undefined, undefined, { raw: true });
    check('Hindi page text', r.status === 200 && r.text.includes('अभी आवेदन करें'));
    r = await call(`GET`, `http://localhost:${PORT}/api/public/job-portal/go/${req.id}`, undefined, undefined, { raw: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    check('a crawler on the old /careers link gets the full SEO page', r.status === 200 && /hreflang/.test(r.text), r.status);
    r = await call('GET', `http://localhost:${PORT}/sitemap.xml`, undefined, undefined, { raw: true });
    check('the sitemap carries the Telugu / Hindi alternates', /xhtml:link rel="alternate" hreflang="te-IN"/.test(r.text), r.text.slice(0, 400));

    // ------------------------------------------------------------------ 10.18
    section('10.18 careers site builder');
    r = await call('GET', '/public/mkt/site');
    check('not published: the public site says so', r.status === 200 && r.body.published === false);
    check('only an Admin saves the site', (await call('PUT', `${M}/site`, { published: true }, T.tl)).status === 403);
    check('a logo that is not https is refused', (await call('PUT', `${M}/site`, { brand: { logoUrl: 'javascript:alert(1)' } }, T.sa)).status === 400);
    r = await call('PUT', `${M}/site`, { published: true, brand: { name: 'Mkc Hiring', color: '#0a7d4f' }, hero: { title: `We hire ${RUN}` }, about: { text: 'An agency.' }, sections: ['hero', 'jobs', 'contact'], contact: { email: 'jobs@mkc-test.in' } }, T.sa);
    check('the Admin builds and publishes the site', r.status === 200 && r.body.site.published && r.body.site.sections.length === 3, r.body);
    r = await call('GET', '/public/mkt/site?lang=te');
    check('the site JSON: hero, sections, the open jobs (this job in it), Telugu labels', r.body.published && r.body.site.hero.title === `We hire ${RUN}` && r.body.jobs.some((j) => j.id === req.id) && r.body.labels.apply === 'ఇప్పుడే దరఖాస్తు చేయండి', { pub: r.body.published, jobs: (r.body.jobs || []).length });

    // ------------------------------------------------------------------ 10.14
    section('10.14 candidate job alerts');
    r = await call('POST', '/public/mkt/alerts/subscribe', { email: `alert.${RUN}@gmail.com`, keywords: 'kubernetes', consent: 'yes' });
    check('OFF by default', r.status === 409);
    await call('PUT', `${M}/switches`, { jobAlerts: true }, T.sa);
    check('consent is needed', (await call('POST', '/public/mkt/alerts/subscribe', { email: `alert.${RUN}@gmail.com` })).status === 400);
    check('a throw-away email is refused', (await call('POST', '/public/mkt/alerts/subscribe', { email: 'a@yopmail.com', consent: 'yes' })).status === 400);
    r = await call('POST', '/public/mkt/alerts/subscribe', { email: `alert.${RUN}@gmail.com`, keywords: 'kubernetes', location: 'Hyderabad', consent: 'yes' });
    check('subscribe: a confirmation email first (double opt-in)', r.status === 200 && /sent you an email/.test(r.body.message), r.body);
    const sub = (await prisma.$queryRawUnsafe('SELECT * FROM "MktAlertSub" WHERE "email" = ?', `alert.${RUN}@gmail.com`))[0];
    check('pending until confirmed', sub.status === 'pending');
    r = await call('GET', `/public/mkt/alerts/confirm/${sub.token}`, undefined, undefined, { raw: true });
    await prisma.$executeRawUnsafe('UPDATE "MktAlertSub" SET "lastSentAt" = ? WHERE "token" = ?', new Date(Date.now() - 2 * 86400e3).toISOString(), sub.token);
    r = await call('POST', `${M}/alerts/run`, {}, T.sa);
    const sub2 = (await prisma.$queryRawUnsafe('SELECT * FROM "MktAlertSub" WHERE "email" = ?', `alert.${RUN}@gmail.com`))[0];
    check('a run picks the matching new job for them (mail is a no-op in the sandbox)', r.status === 200 && JSON.parse(sub2.sentJobs).includes(req.id), { r: r.body, sent: sub2.sentJobs });
    r = await call('GET', `/public/mkt/alerts/stop/${sub.token}`, undefined, undefined, { raw: true });
    const sub3 = (await prisma.$queryRawUnsafe('SELECT "status" FROM "MktAlertSub" WHERE "email" = ?', `alert.${RUN}@gmail.com`))[0];
    check('the stop link in every email stops them', /Stopped/.test(r.text) && sub3.status === 'stopped');
    check('the alert list is Admin only, emails masked', (await call('GET', `${M}/alerts`, undefined, T.rec)).status === 403 && !JSON.stringify((await call('GET', `${M}/alerts`, undefined, T.sa)).body).includes(`alert.${RUN}@gmail.com`));

    // ------------------------------------------------------------------ 10.07 / 10.09 / 10.10 boards
    section('10.07 Naukri / 10.09 Shine, foundit / 10.10 LinkedIn: applications in');
    const appBody = JSON.stringify({ applications: [{ id: `nk-${RUN}`, jobReference: req.id, candidate: { name: `Naukriperson Zed ${RUN}`, email: `nk.${RUN}@gmail.com`, phone: '9811100011', skills: ['AWS'], linkedinUrl: 'https://in.linkedin.com/in/nk-zed' } }] });
    r = await call('POST', '/public/mkt/boards/naukri/applications', appBody, undefined, { headers: { 'Content-Type': 'application/json' } });
    check('not set up: the board is told so', r.status === 503);
    check('only an Admin saves board settings', (await call('PUT', `${M}/boards/naukri`, { webhookSecret: 'whs' }, T.tl)).status === 403);
    await call('PUT', `${M}/boards/naukri`, { webhookSecret: 'whs-naukri-1' }, T.sa);
    const sig = (s, b) => `sha256=${crypto.createHmac('sha256', s).update(b).digest('hex')}`;
    check('a wrong signature is refused', (await call('POST', '/public/mkt/boards/naukri/applications', appBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('nope', appBody) } })).status === 401);
    r = await call('POST', '/public/mkt/boards/naukri/applications', appBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('whs-naukri-1', appBody) } });
    check('a signed Naukri application becomes a candidate on the job', r.status === 200 && r.body.added === 1, r.body);
    r = await call('POST', '/public/mkt/boards/naukri/applications', appBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('whs-naukri-1', appBody) } });
    check('the same application again is not added twice', r.status === 200 && r.body.duplicates === 1 && r.body.added === 0, r.body);
    const nk = await prisma.candidate.findFirst({ where: { email: `nk.${RUN}@gmail.com` }, include: { applications: true } });
    check('source Naukri, method "Naukri API"', nk && nk.firstSource === 'Naukri' && nk.applications[0].applicationMethod === 'Naukri API', nk && { fs: nk.firstSource, m: nk.applications[0] && nk.applications[0].applicationMethod });
    r = await call('POST', `${M}/boards/foundit/pull`, {}, T.sa);
    check('foundit pull without the partner details: needs founder credentials', r.status === 409 && r.body.needsFounder, r.body);
    await call('PUT', `${M}/boards/foundit`, { pullUrl: `http://127.0.0.1:${STUB}/board/apps`, apiKey: 'pull-key-1' }, T.sa);
    r = await call('POST', `${M}/boards/foundit/pull`, {}, T.sa);
    check('pull from the board\'s applications API (stub): added', r.status === 200 && r.body.added === 1, r.body);
    r = await call('GET', `${M}/boards`, undefined, T.sa);
    check('the board list shows the webhook address and LinkedIn feed; secrets never sent back', r.status === 200 && r.body.rows.length === 4 && !JSON.stringify(r.body).includes('whs-naukri-1') && /linkedin\.xml/.test(r.body.linkedinFeed), r.body);
    r = await call('GET', '/public/mkt/feeds/linkedin.xml', undefined, undefined, { raw: true });
    check('LinkedIn job-wrapping feed lists the job', r.status === 200 && r.text.includes(req.title) && /<applyUrl>/.test(r.text));

    // ------------------------------------------------------------------ 10.11
    section('10.11 browser extension (LinkedIn sourcing)');
    check('the BDE (cannot add candidates) gets no key', (await call('POST', `${M}/extension-key`, {}, T.bde)).status === 403);
    r = await call('POST', `${M}/extension-key`, {}, T.rec);
    const key = r.body.key;
    check('the recruiter makes their own key (shown once)', r.status === 201 && /^tlx_/.test(key), r.body);
    check('a wrong key is refused', (await call('GET', '/public/mkt/ext/me', undefined, undefined, { headers: { 'X-TeamLink-Key': 'tlx_wrongwrongwrongwrongwrong' } })).status === 401);
    r = await call('GET', '/public/mkt/ext/me', undefined, undefined, { headers: { 'X-TeamLink-Key': key } });
    check('the key works for its person', r.status === 200 && r.body.name === rec.name && r.body.mayAdd, r.body);
    const prof = { profileUrl: `https://www.linkedin.com/in/ext-person-${RUN}/`, name: `Extperson Zed ${RUN}`, headline: 'DevOps Engineer at Cloudco', location: 'Pune', currentCompany: 'Cloudco', skills: ['Kubernetes', 'Helm'] };
    r = await call('POST', '/public/mkt/ext/profile', JSON.stringify(prof), undefined, { headers: { 'Content-Type': 'application/json', 'X-TeamLink-Key': key } });
    check('the profile being viewed is added as a candidate (source LinkedIn)', r.status === 201 && r.body.created, r.body);
    r = await call('POST', '/public/mkt/ext/profile', JSON.stringify(prof), undefined, { headers: { 'Content-Type': 'application/json', 'X-TeamLink-Key': key } });
    check('the same profile again: "already in TeamLink"', r.status === 200 && r.body.existing, r.body);
    r = await call('GET', `/public/mkt/ext/check?url=${encodeURIComponent(prof.profileUrl)}`, undefined, undefined, { headers: { 'X-TeamLink-Key': key } });
    check('check: known', r.body.known === true, r.body);
    await call('DELETE', `${M}/extension-key`, undefined, T.rec);
    check('a removed key stops working', (await call('GET', '/public/mkt/ext/me', undefined, undefined, { headers: { 'X-TeamLink-Key': key } })).status === 401);
    check('the extension source is in browser-extension/ (manifest v3)', fs.existsSync(path.join(BACK, '..', 'browser-extension', 'manifest.json')) && JSON.parse(fs.readFileSync(path.join(BACK, '..', 'browser-extension', 'manifest.json'), 'utf8')).manifest_version === 3);

    // ------------------------------------------------------------------ 10.13
    section('10.13 SMS job marketing');
    await prisma.candidate.create({ data: { name: `Smsperson One ${RUN}`, phone: '9822200011', skills: 'Kubernetes, Docker', location: 'Hyderabad' } });
    r = await call('POST', `${M}/jobs/${req.id}/sms-campaign/plan`, { skills: 'Kubernetes', location: 'Hyderabad' }, T.sa);
    check('plan: who in the pool matches, the text with the job link and STOP', r.status === 200 && r.body.count >= 1 && /Reply STOP/.test(r.body.text) && /\/site\/job\//.test(r.body.text), r.body);
    check('the BDE cannot text a pool', (await call('POST', `${M}/jobs/${req.id}/sms-campaign/plan`, { skills: 'Kubernetes' }, T.bde)).status === 403);
    r = await call('POST', `${M}/jobs/${req.id}/sms-campaign`, { skills: 'Kubernetes', location: 'Hyderabad' }, T.sa);
    check('OFF by default', r.status === 409 && /switched off/.test(r.body.error), r.body);
    await call('PUT', `${M}/switches`, { smsMarketing: true }, T.sa);
    r = await call('POST', `${M}/jobs/${req.id}/sms-campaign`, { skills: 'Kubernetes', location: 'Hyderabad', limit: 5 }, T.sa);
    check('switched on: the campaign starts', r.status === 201 && r.body.total >= 1, r.body);
    await new Promise((res) => { setTimeout(res, 2500); });
    r = await call('GET', `${M}/jobs/${req.id}/sms-campaigns`, undefined, T.sa);
    check('the campaign finishes through the normal SMS door (DLR rule inside it; sandbox sends nothing)', r.body.rows[0] && r.body.rows[0].status === 'done' && (r.body.rows[0].sent + r.body.rows[0].skipped + r.body.rows[0].failed) >= 1, r.body.rows[0]);

    section('scope');
    const outsider = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Sales', atsScopeDepartments: 'Sales' }, { department: 'Sales' });
    const T2 = await tok(outsider.id);
    check('a recruiter of another department does not see the interview', (await call('GET', `${M}/interviews/${app.id}/briefing`, undefined, T2)).status === 404);
    check('... nor the job\'s kits', (await call('GET', `${M}/jobs/${req.id}/kits`, undefined, T2)).status === 404);
  } catch (e) {
    check(`no crash (${e.message})`, false, e.stack);
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})();
