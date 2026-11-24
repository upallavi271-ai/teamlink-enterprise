#!/usr/bin/env node
/**
 * ATS WAVE 2, builder Y (founder 2026-11-25 "push ATS to 95+"): AI / data / sourcing (routes/atsWave2Y.js, utils/atsY/*.js and the
 * pieces they change in utils/mkt, utils/mktb, utils/jobBoards). One section per benchmark id.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database + ONE local stub for every outside account (meeting bot, Naukri
 * Amplify, Naukri Resdex, foundit, LinkedIn RSC, the people & company data provider, a board's applications API) + a stand-in tesseract.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4520 node scripts/ats-Y-test.js
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
const COPY = path.join(os.tmpdir(), `zz-atsY-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4520;
const STUB = PORT + 1;
const API = `http://localhost:${PORT}/api`;
const SB = `http://127.0.0.1:${STUB}`;
const FAKE_STT = 'Strong on Kubernetes rollouts, I led the migration to EKS last year. Not sure about Terraform state locking. Communication was clear and calm.';
// the stand-in tesseract: prints what the test wrote into OCR_OUT
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-atsY-ocr-'));
const OCR_OUT = path.join(FAKE_DIR, 'out.txt');
fs.writeFileSync(path.join(FAKE_DIR, 'tesseract.js'), `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='--version'){process.stdout.write('tesseract 5.3.4\\n');process.exit(0);}
if(a[0]==='--list-langs'){process.stdout.write('List of available languages:\\neng\\nhin\\ntel\\n');process.exit(0);}
process.stdout.write(fs.existsSync(${JSON.stringify(OCR_OUT)})?fs.readFileSync(${JSON.stringify(OCR_OUT)},'utf8'):'');`);
fs.writeFileSync(path.join(FAKE_DIR, 'pdftoppm.js'), `const fs=require('fs');const a=process.argv.slice(2);if(a[0]==='-v'){process.stderr.write('pdftoppm version 22\\n');process.exit(0);}
fs.writeFileSync(a[a.length-1]+'-1.png',Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));`);
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'atsY-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'atsY-test-secret-key-0123456789', TEST_MOCK_PORTS: String(STUB), ALLOW_PRIVATE_FETCH: '1', APP_BASE_URL: `http://localhost:${PORT}`,
  BROWSER_CALL_FAKE_STT: FAKE_STT, OCR_TESSERACT_BIN: path.join(FAKE_DIR, 'tesseract.js'), OCR_PDFTOPPM_BIN: path.join(FAKE_DIR, 'pdftoppm.js'), JOB_BOARD_TIMEOUT_MS: '8000',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const section = (s) => console.log(`\n== ${s}`);
const ip = () => `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const call = async (method, url, body, token, { raw = false, headers = {} } = {}) => {
  const isForm = body instanceof FormData;
  const r = await fetch((url.startsWith('http') ? '' : API) + url, { method, redirect: 'manual', headers: { 'X-Forwarded-For': ip(), ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (isForm || typeof body === 'string' ? body : JSON.stringify(body)) });
  if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j || {} };
};
const form = (fields, file) => { const fd = new FormData(); Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, String(v))); if (file) fd.append('file', new Blob([file.data], { type: file.type }), file.name); return fd; };
function pdf(lines) {
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' }); const parts = [];
    doc.on('data', (d) => parts.push(d)); doc.on('end', () => resolve(Buffer.concat(parts)));
    lines.forEach((l) => doc.fontSize(12).text(l)); doc.end();
  });
}
const P = process.pid;
const RUN = Date.now().toString(36);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(4000)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

// ---- the stub of every outside account -------------------------------------------------------------------------------------
const seen = [];
const botGets = {};
let RESUME_B64 = '';
let EXISTING_EMAIL = '';
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    const u = req.url;
    let body = null; try { body = b ? JSON.parse(b) : null; } catch { body = b; }
    seen.push({ method: req.method, url: u, body, auth: req.headers.authorization, sig: req.headers['x-teamlink-signature'], raw: b });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    // meeting bot (Recall.ai style)
    if (u === '/bot/api/v1/bot/' && req.method === 'POST') return req.headers.authorization === 'Token bot-key-1' ? send(201, { id: `bot-${seen.length}` }) : send(401, { detail: 'bad key' });
    let m = /^\/bot\/api\/v1\/bot\/([\w-]+)\/$/.exec(u);
    if (m) { botGets[m[1]] = (botGets[m[1]] || 0) + 1; return send(200, { id: m[1], status_changes: botGets[m[1]] === 1 ? [{ code: 'joining_call' }, { code: 'in_call_recording' }] : [{ code: 'in_call_recording' }, { code: 'call_ended' }, { code: 'done' }], video_url: 'https://media.example/rec.mp4' }); }
    m = /^\/bot\/api\/v1\/bot\/([\w-]+)\/transcript\/$/.exec(u);
    if (m) return send(200, [{ speaker: 'Interviewer', words: [{ text: 'Explain' }, { text: 'a' }, { text: 'Kubernetes' }, { text: 'rollout' }, { text: 'you' }, { text: 'ran?' }] }, { speaker: 'Candidate', words: FAKE_STT.split(' ').map((t) => ({ text: t })) }]);
    if (/^\/bot\/api\/v1\/bot\/[\w-]+\/leave_call\/$/.test(u)) return send(200, {});
    // Naukri Amplify / foundit partner job endpoints
    if (u === '/naukri/jobs') return send(200, body && body.action === 'close' ? { status: 'closed' } : { status: 'live', jobId: 'NK-77', url: 'https://www.naukri.com/job-listings-77' });
    if (u === '/foundit/jobs') return req.headers.authorization === 'Bearer fd-key-1' ? send(200, body && body.action === 'close' ? { status: 'closed', id: 'FD-9' } : { status: 'active', id: 'FD-9', url: 'https://www.foundit.in/job/FD-9' }) : send(401, { error: 'no' });
    // LinkedIn RSC
    if (u === '/li/token') return /client_secret=li-secret-1/.test(b) ? send(200, { access_token: 'li-token-1', expires_in: 3600 }) : send(401, { error: 'invalid_client' });
    if (u === '/li/rest/atsJobPostings' || u === '/li/rest/atsCandidates') return req.headers.authorization === 'Bearer li-token-1' ? send(201, { elements: [{ status: 201 }] }) : send(401, {});
    // Naukri Resdex
    if (u === '/resdex/v1/search') return req.headers.authorization === 'Bearer rx-key-1' ? send(200, { total: 2, profiles: [{ id: 'RX-1', name: `Resdexperson One ${RUN}`, title: 'DevOps Engineer', company: 'Cloudnine', experienceYears: 5, location: 'Hyderabad', skills: ['Kubernetes', 'AWS'], email: 'leak@should-not-show.in', phone: '9000000001' }, { id: 'RX-2', name: `Resdexperson Two ${RUN}`, title: 'SRE', company: 'Bluesky', experienceYears: 4 }] }) : send(401, {});
    if (u === '/resdex/v1/profiles/RX-1/download') return send(200, { profile: { id: 'RX-1', name: `Resdexperson One ${RUN}`, title: 'DevOps Engineer', company: 'Cloudnine', experienceYears: 5, location: 'Hyderabad', skills: ['Kubernetes', 'AWS'], email: `rx1.${RUN}@gmail.com`, phone: `9${String(P).padStart(9, '4').slice(-9)}`, ctc: '9 LPA', expectedCtc: '12 LPA' }, resume: { fileName: 'rx1.pdf', mime: 'application/pdf', base64: RESUME_B64 } });
    if (u === '/resdex/v1/profiles/RX-2/download') return send(200, { profile: { id: 'RX-2', name: `Resdexperson Two ${RUN}`, email: EXISTING_EMAIL } });
    // people & company data provider
    if (u === '/pd/v1/people/search') return send(200, { people: [{ id: 'p1', name: `Outsider Person ${RUN}`, title: 'SRE', company: 'Acme', location: 'Pune', skills: ['Go', 'Kubernetes'], profileUrl: `https://www.linkedin.com/in/outsider-${RUN}` }] });
    if (u === '/pd/v1/people/contact') return send(200, { emails: [{ value: `work.${RUN}@acme-test.in`, verified: true }], phones: [{ value: '9876501234', verified: false }] });
    if (u === '/pd/v1/people/enrich') return send(200, { person: { company: `Newco Labs ${RUN}`, title: 'Principal Engineer', location: 'Pune', skills: ['Go', 'Rust'], education: 'B.Tech' } });
    if (u === '/pd/v1/companies/search') return send(200, { companies: [{ name: `Freshco ${RUN}`, city: 'Pune', industry: 'SaaS', openJobs: 4, contacts: [{ name: 'Asha Hr', title: 'HR Manager', email: 'asha@freshco-test.in', verified: true }] }] });
    // a board's applications API (Naukri pull)
    if (u.startsWith('/board/apps')) return req.headers.authorization === 'Bearer nk-pull-1' ? send(200, { applications: [{ id: `nkpull-${RUN}`, jobReference: global.REQ_ID, candidate: { name: `Nkpull Person ${RUN}`, email: `nkpull.${RUN}@gmail.com`, phone: `7${String(P).padStart(9, '2').slice(-9)}` } }] }) : send(401, {});
    return send(404, { error: 'stub: no such path' });
  });
});
let server;
async function stop(code) {
  if (server) server.kill();
  stub.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(FAKE_DIR, { recursive: true, force: true }); } catch { /* temp */ } process.exit(code); }, 800);
}

(async () => {
  await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));
  RESUME_B64 = (await pdf([`Resdexperson One ${RUN}`, 'DevOps Engineer at Cloudnine', 'Skills: Kubernetes, AWS, Terraform, Docker', 'Experience: 5 years', 'Hyderabad'])).toString('base64');
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Atsy ${tag} ${RUN}`, email: `atsy.${tag}.${RUN}@atsy-test.in`, username: `atsy.${tag}.${RUN}@atsy-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 86400e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `ATY-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Atsy Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Atsy Team ${RUN}` });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name, department: 'IT', team: `Atsy Team ${RUN}` });
  const mgr = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { designation: 'Manager', department: 'IT' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const client = await prisma.client.create({ data: { name: `Atsyorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Atsycloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'OPEN', tlId: tl.id, tl: tl.name, recruiterId: rec.id, bdeId: bde.id, reqCode: `ATY-${RUN}`.toUpperCase().slice(0, 14), openings: 2, skills: 'Kubernetes, Terraform, AWS', experience: '3-6', location: 'Hyderabad', portalPublished: true, portalPublishedAt: new Date(), postingSources: 'TeamLink Job Portal, Naukri', jobDescription: `Atsyorbit ${RUN} needs someone to run our cloud platform on Kubernetes and AWS.` } });
  global.REQ_ID = req.id;
  const reqSales = await prisma.requirement.create({ data: { title: `Atsysales Exec ${RUN}`, clientId: client.id, department: 'Sales', status: 'OPEN', openings: 1, skills: 'Sales', location: 'Pune' } });
  const COMPANY = `Graphco Analytics ${RUN}`;
  const cand = await prisma.candidate.create({ data: { name: `Atsyperson Quillfeather ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `atsy.${RUN}@gmail.com`, skills: 'Kubernetes', currentSalary: '7 LPA', expectedSalary: '10 LPA', noticePeriod: '30 Days', currentCompany: COMPANY, currentDesignation: 'Cloud Engineer', dob: '1994-08-15' } });
  EXISTING_EMAIL = cand.email;
  const at = new Date(Date.now() + 3 * 86400e3);
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: at, interviewRound: 1, interviewer: tl.name, interviewMode: 'Online', interviewMeetingLink: 'https://meet.google.com/abc-defg-hij', interviewCode: `INT-${RUN}` } });
  await prisma.interviewPanelist.create({ data: { applicationId: app.id, round: 1, userId: sa.id, name: sa.name } });
  // the profile graph's people
  const mate = await prisma.candidate.create({ data: { name: `Atsymate Visible ${RUN}`, currentCompany: COMPANY, currentDesignation: 'Data Engineer' } });
  await prisma.application.create({ data: { candidateId: mate.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  const hiddenMate = await prisma.candidate.create({ data: { name: `Atsymate Hidden ${RUN}`, currentCompany: COMPANY } });
  await prisma.application.create({ data: { candidateId: hiddenMate.id, requirementId: reqSales.id, stage: 'NEW' } });
  const oldMate = await prisma.candidate.create({ data: { name: `Atsyold Colleague ${RUN}`, currentCompany: 'Elsewhere Ltd' } });
  await prisma.application.create({ data: { candidateId: oldMate.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  const referred = await prisma.candidate.create({ data: { name: `Atsyreferred Friend ${RUN}`, referredByName: cand.name } });
  await prisma.application.create({ data: { candidateId: referred.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  // a sourced profile with no contact details, whose own resume has them
  const bare = await prisma.candidate.create({ data: { name: `Atsybare Nocontact ${RUN}`, currentCompany: 'Acme', currentDesignation: 'SRE' } });
  await prisma.application.create({ data: { candidateId: bare.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  await prisma.candidateResume.create({ data: { candidateId: bare.id, kind: 'ORIGINAL', fileName: 'bare.pdf', text: `Atsybare Nocontact\nE-mail: bare.${RUN}@gmail.com\nMobile: +91 98480 ${String(P).padStart(5, '1').slice(-5)}\nSRE at Acme` } });
  // prospecting: our candidates at a company that is not a client
  const PCO = `Zentrix Analytics ${RUN}`;
  for (const [i, t] of ['Software Engineer', 'QA Engineer', 'HR Manager'].entries()) await prisma.candidate.create({ data: { name: `Atsyzen Person${i} ${RUN}`, currentCompany: PCO, currentDesignation: t, location: 'Pune' } }); // eslint-disable-line no-await-in-loop

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 200 && !up; i += 1) { up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false); if (!up) await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  if (!up) { console.log('FAIL  the sandbox server did not start (port busy? set TEST_PORT)'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1000); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = { sa: await tok(sa.id), tl: await tok(tl.id), rec: await tok(rec.id), mgr: await tok(mgr.id), bde: await tok(bde.id) };
  const Y = '/ats/y'; const M = '/ats/mkt';
  const configure = (id, values) => call('PUT', `/admin/integrations/${id}/configure`, { values }, T.sa);
  const sw = (key, value) => call('PUT', `${Y}/settings`, { key, value }, T.sa);
  let r;
  try {
    // ------------------------------------------------------------------ switches
    section('Admin switches (all OFF by default) and the connectors');
    r = await call('GET', `${Y}/settings`, undefined, T.sa);
    check('every builder-Y switch starts OFF', r.status === 200 && Object.keys(r.body.switches).length === 6 && Object.values(r.body.switches).every((v) => v === false), r.body.switches);
    check('every outside account says "needs founder credentials" until it is filled', r.body.connectors.filter((c) => ['ats-meeting-bot', 'naukri-resdex', 'foundit', 'linkedin-rsc', 'people-data'].includes(c.id)).every((c) => /Needs founder/.test(c.state)), r.body.connectors);
    check('a recruiter cannot read or change them', (await call('GET', `${Y}/settings`, undefined, T.rec)).status === 403 && (await call('PUT', `${Y}/settings`, { key: 'mcpWrite', value: true }, T.rec)).status === 403);
    check('a Manager reads but cannot change them', (await call('GET', `${Y}/settings`, undefined, T.mgr)).status === 200 && (await call('PUT', `${Y}/settings`, { key: 'mcpWrite', value: true }, T.mgr)).status === 403);
    check('an unknown switch is refused', (await sw('nope', true)).status === 400);
    check('no login: 401', (await call('GET', `${Y}/settings`)).status === 401);
    r = await call('GET', '/admin/integrations', undefined, T.sa);
    const cards = JSON.stringify(r.body || {});
    check('the five new cards are on Administration > Integrations', ['ats-meeting-bot', 'naukri-resdex', 'foundit', 'linkedin-rsc', 'people-data'].every((id) => cards.includes(`"${id}"`)), r.status);

    // ------------------------------------------------------------------ 07.13
    section('07.13 voice feedback through the Groq Whisper path of the call recordings');
    r = await call('GET', `${Y}/speech`, undefined, T.rec);
    check('speech to text is ready (the call recordings\' test transcriber stands in for Groq)', r.status === 200 && r.body.ready === true, r.body);
    const kitBody = { title: 'Cloud round', roundType: 'Technical', scale: 5, questions: [{ text: 'Explain a Kubernetes rollout you ran', type: 'rating', competency: 'Kubernetes' }, { text: 'How do you handle Terraform state locking?', type: 'rating' }, { text: 'Communication', type: 'text' }] };
    check('the TL saves the round-1 kit', (await call('PUT', `${M}/jobs/${req.id}/kits/1`, kitBody, T.tl)).status === 200);
    r = await call('POST', `${M}/interviews/${app.id}/voice-feedback`, form({ round: 1 }, { data: WEBM, type: 'audio/webm', name: 'voice.webm' }), T.sa);
    check('a spoken note (no words from the browser) is turned into text by the server', r.status === 201 && r.body.transcript === FAKE_STT && /Test transcriber/.test(r.body.source || ''), r.body);
    r = await call('GET', `${M}/interviews/${app.id}/scorecard?round=1`, undefined, T.sa);
    check('the words become my scorecard summary for the round', r.status === 200 && r.body.mine && r.body.mine.summary === FAKE_STT && r.body.mine.via === 'voice', r.body.mine);
    check('the BDE cannot record voice feedback', (await call('POST', `${M}/interviews/${app.id}/voice-feedback`, form({ round: 1 }, { data: WEBM, type: 'audio/webm', name: 'v.webm' }), T.bde)).status === 403);
    // the real Groq request, in this process with a fake fetch: webm keeps its own name and type, the model is whisper-large-v3
    {
      const keep = { fetch: global.fetch, sb: process.env.TEAMLINK_SANDBOX, tm: process.env.TEST_MODE, gk: process.env.GROQ_API_KEY };
      let sent = null;
      global.fetch = async (url, init) => { sent = { url: String(url), auth: init.headers.Authorization, file: init.body.get('file'), model: init.body.get('model') }; return { ok: true, json: async () => ({ text: 'Hello from Groq', language: 'english' }) }; };
      process.env.TEAMLINK_SANDBOX = ''; process.env.TEST_MODE = ''; process.env.GROQ_API_KEY = 'gsk_test_key';
      let out;
      try { out = await require('../src/utils/atsY/speech').transcribeMedia(WEBM, { mime: 'audio/webm', fileName: 'voice.webm' }); } finally { global.fetch = keep.fetch; process.env.TEAMLINK_SANDBOX = keep.sb; process.env.TEST_MODE = keep.tm; if (keep.gk === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = keep.gk; }
      check('the request goes to Groq transcriptions with whisper-large-v3 and the Fast AI key', sent && /api\.groq\.com\/openai\/v1\/audio\/transcriptions/.test(sent.url) && sent.model === 'whisper-large-v3' && sent.auth === 'Bearer gsk_test_key', sent && { url: sent.url, model: sent.model });
      check('the webm voice note is sent as webm (not mislabelled as wav)', sent && sent.file && sent.file.type === 'audio/webm' && /\.webm$/.test(sent.file.name), sent && sent.file && { type: sent.file.type, name: sent.file.name });
      check('the text comes back with its source', out && out.text === 'Hello from Groq' && /Groq Whisper/.test(out.source), out);
    }

    // ------------------------------------------------------------------ 07.11
    section('07.11 AI notetaker: an upload is transcribed and summarised now; the meeting bot; notes mapped to the scorecard');
    r = await call('POST', `${M}/interviews/${app.id}/recordings`, form({ title: 'Round 1 audio', round: 1 }, { data: WEBM, type: 'audio/webm', name: 'round1.webm' }), T.sa);
    const upRow = r.body.rows && r.body.rows.find((x) => x.id === r.body.id);
    check('the uploaded recording is turned into text at once', r.status === 201 && r.body.auto && r.body.auto.transcribed && upRow && upRow.transcript === FAKE_STT, r.body.auto);
    check('... and the notes are written (summary, strengths, concerns)', upRow && upRow.notes && upRow.notes.summary && upRow.notes.strengths.length && upRow.notes.concerns.length, upRow && upRow.notes);
    check('... mapped to the kit questions (the Kubernetes question gets the Kubernetes line)', upRow && upRow.notes.byQuestion && upRow.notes.byQuestion[0].covered && /Kubernetes/.test(upRow.notes.byQuestion[0].evidence) && /Terraform/.test(upRow.notes.byQuestion[1].evidence || ''), upRow && upRow.notes.byQuestion);
    r = await call('POST', `${M}/recordings/${upRow.id}/notes/apply`, {}, T.sa);
    check('copy the lines onto MY scorecard as the questions\' notes (ratings left to me)', r.status === 200 && /From the recording/.test(r.body.score.answers[0].note || '') && r.body.score.answers[0].rating == null, r.body);
    check('the BDE cannot copy notes', (await call('POST', `${M}/recordings/${upRow.id}/notes/apply`, {}, T.bde)).status === 403);
    r = await call('POST', `${M}/interviews/${app.id}/recordings`, form({ title: 'Later', round: 1, later: 1 }, { data: WEBM, type: 'audio/webm', name: 'later.webm' }), T.sa);
    check('"later": an upload can skip the transcript', r.status === 201 && r.body.auto === null, r.body.auto);
    r = await call('GET', `${Y}/interviews/${app.id}/notetaker`, undefined, T.sa);
    check('the notetaker bot: off, not set up, the interview\'s meeting link is offered', r.status === 200 && r.body.switchOn === false && r.body.ready === false && r.body.meetingLink === 'https://meet.google.com/abc-defg-hij', r.body);
    r = await call('POST', `${Y}/interviews/${app.id}/notetaker`, {}, T.sa);
    check('sending it while the switch is OFF is refused', r.status === 409 && r.body.switchedOff === 'notetakerBot', r.body);
    await sw('notetakerBot', true);
    r = await call('POST', `${Y}/interviews/${app.id}/notetaker`, {}, T.sa);
    check('switched on but no provider key: needs founder credentials', r.status === 409 && r.body.needsFounder, r.body);
    await configure('ats-meeting-bot', { 'Provider name': 'Recall.ai', 'API base URL': `${SB}/bot`, 'API key': 'bot-key-1', 'Bot name': 'TeamLink Notetaker' });
    check('a Manager (view only) cannot send it', (await call('POST', `${Y}/interviews/${app.id}/notetaker`, {}, T.mgr)).status === 403);
    check('the BDE cannot see it', (await call('GET', `${Y}/interviews/${app.id}/notetaker`, undefined, T.bde)).status === 403);
    check('a link that is not https is refused', (await call('POST', `${Y}/interviews/${app.id}/notetaker`, { meetingUrl: 'http://zoom.us/j/1' }, T.sa)).status === 400);
    r = await call('POST', `${Y}/interviews/${app.id}/notetaker`, {}, T.sa);
    const bot = r.body.bot;
    const botCall = seen.filter((s) => s.url === '/bot/api/v1/bot/').pop();
    check('sent: the provider gets the meeting link, the bot name, "Token <key>", and a join time before the interview', r.status === 201 && bot && bot.status === 'scheduled' && botCall && botCall.body.meeting_url === 'https://meet.google.com/abc-defg-hij' && botCall.body.bot_name === 'TeamLink Notetaker' && !!botCall.body.join_at, { r: r.body, botCall: botCall && botCall.body });
    check('a second bot for the same round is refused', (await call('POST', `${Y}/interviews/${app.id}/notetaker`, {}, T.sa)).status === 409);
    r = await call('POST', `${Y}/notetaker/${bot.id}/refresh`, {}, T.sa);
    check('check: in the call', r.status === 200 && r.body.bot.status === 'in call', r.body);
    r = await call('POST', `${Y}/notetaker/${bot.id}/refresh`, {}, T.sa);
    check('check: the call ended -> done, a recording of the round with the transcript', r.status === 200 && r.body.bot.status === 'done' && r.body.bot.recordingId, r.body);
    r = await call('GET', `${M}/interviews/${app.id}/recordings`, undefined, T.sa);
    const botRec = r.body.rows.find((x) => x.kind === 'bot');
    check('the bot\'s recording has the speakers\' words, the video link and the notes', botRec && /Candidate: Strong on Kubernetes/.test(botRec.transcript) && botRec.url === 'https://media.example/rec.mp4' && botRec.notes && botRec.notes.byQuestion, botRec);
    check('the recordings list says speech to text is ready', r.body.speech === true && /Test transcriber/.test(r.body.speechEngine || ''), { speech: r.body.speech, engine: r.body.speechEngine });

    // ------------------------------------------------------------------ 03.02
    section('03.02 scanned / image resume (the existing OCR path; tesseract stand-in)');
    r = await call('GET', `${Y}/settings`, undefined, T.sa);
    check('the OCR state is shown with the setup note when missing (here: installed stand-in)', /Installed/.test((r.body.connectors.find((c) => c.id === 'ocr') || {}).state || ''), r.body.connectors.find((c) => c.id === 'ocr'));
    fs.writeFileSync(OCR_OUT, `Ocrperson Kumar ${RUN}\nEmail: ocr.${RUN}@gmail.com\nPhone: +91 9${String(P).padStart(9, '6').slice(-9)}\nSKILLS\nJava, Python, SQL\nTotal Experience: 6 years\n`);
    const ocrCand = await prisma.candidate.create({ data: { name: `Ocrperson Kumar ${RUN}` } });
    await prisma.application.create({ data: { candidateId: ocrCand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
    const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'photo-resume.png');
    const up = await fetch(`${API}/candidate-resumes/${ocrCand.id}/upload`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${T.sa}`, 'X-Forwarded-For': ip() } }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    check('a photo of a resume is read by OCR and parsed (e-mail, skills)', up.status === 201 && up.body.resume && up.body.resume.parsed && up.body.resume.parsed.emails.includes(`ocr.${RUN}@gmail.com`), up.body);

    // ------------------------------------------------------------------ 10.07 / IN-01
    section('10.07 / IN-01 Naukri: post, edit, take down (Amplify stub) and applications in');
    await configure('naukri', { 'Posting method (Amplify API / XML feed)': 'Amplify API', 'Recruiter account email': 'hr@teamlink-test.in', 'API key': 'nk-key-1', 'Secret key': 'nk-secret-1', 'Job endpoint URL': `${SB}/naukri/jobs` });
    r = await call('POST', `/requirements/${req.id}/postings/retry`, {}, T.sa);
    const nkPost = seen.filter((s) => s.url === '/naukri/jobs').pop();
    const goodSig = nkPost && nkPost.sig === `sha256=${crypto.createHmac('sha256', 'nk-secret-1').update(nkPost.raw).digest('hex')}`;
    check('Save & Post sends the job to Naukri (upsert on the job id, Bearer key, signed body)', nkPost && nkPost.body.action === 'upsert' && nkPost.body.reference === req.id && nkPost.auth === 'Bearer nk-key-1' && goodSig, nkPost && { body: nkPost.body, auth: nkPost.auth });
    let row = await prisma.requirementPosting.findFirst({ where: { requirementId: req.id, source: 'naukri' } });
    check('Naukri said live: the row is Posted with Naukri\'s job id', row && row.status === 'Posted' && row.externalJobId === 'NK-77', row);
    const JC = require('../src/utils/jobConnectors');
    await prisma.requirement.update({ where: { id: req.id }, data: { title: `Atsycloud Engineer II ${RUN}` } });
    await JC.syncAll(req.id, { trigger: 'edit', only: ['naukri'] });
    const nkEdit = seen.filter((s) => s.url === '/naukri/jobs').pop();
    check('an edit is sent as an upsert of the SAME job (never a second job)', nkEdit !== nkPost && nkEdit.body.action === 'upsert' && nkEdit.body.reference === req.id && /II/.test(nkEdit.body.title), nkEdit && nkEdit.body);
    await prisma.requirement.update({ where: { id: req.id }, data: { status: 'ON_HOLD' } });
    await JC.syncAll(req.id, { trigger: 'edit', only: ['naukri'] });
    const nkClose = seen.filter((s) => s.url === '/naukri/jobs').pop();
    row = await prisma.requirementPosting.findFirst({ where: { requirementId: req.id, source: 'naukri' } });
    check('on hold: the job is taken off Naukri (close) and the row says Removed', nkClose.body.action === 'close' && row.status === 'Removed', { body: nkClose.body, row });
    await prisma.requirement.update({ where: { id: req.id }, data: { status: 'OPEN' } });
    await call('PUT', `${M}/boards/naukri`, { webhookSecret: 'nk-whs-1', pullUrl: `${SB}/board/apps`, apiKey: 'nk-pull-1' }, T.sa);
    const appBody = JSON.stringify({ applications: [{ id: `nkwh-${RUN}`, jobReference: 'NK-77', candidate: { name: `Nkwebhook Person ${RUN}`, email: `nkwh.${RUN}@gmail.com`, phone: `6${String(P).padStart(9, '3').slice(-9)}`, currentCompany: 'Infosys', designation: 'Engineer' } }] });
    const sig = (s, b) => `sha256=${crypto.createHmac('sha256', s).update(b).digest('hex')}`;
    r = await call('POST', '/public/mkt/boards/naukri/applications', appBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('nk-whs-1', appBody) } });
    const nkw = await prisma.candidate.findFirst({ where: { email: `nkwh.${RUN}@gmail.com` }, include: { applications: true } });
    check('a signed Naukri application (by Naukri\'s own job id) lands on the right job with source Naukri', r.status === 200 && r.body.added === 1 && nkw && nkw.firstSource === 'Naukri' && nkw.applications[0].requirementId === req.id, { r: r.body, fs: nkw && nkw.firstSource });
    r = await call('POST', `${M}/boards/naukri/pull`, {}, T.sa);
    check('the Naukri applications pull (stub) adds the applicant once', r.status === 200 && r.body.added === 1, r.body);
    r = await call('POST', `${M}/boards/naukri/pull`, {}, T.sa);
    check('... and never twice', r.status === 200 && r.body.added === 0, r.body);

    // ------------------------------------------------------------------ 10.09
    section('10.09 Shine / foundit: post, edit, take down, applications in');
    r = await call('GET', `${Y}/jobs/${req.id}/foundit`, undefined, T.tl);
    check('foundit is not set up: says what the founder must get', r.status === 200 && r.body.ready === false && /foundit/.test(r.body.hint) && r.body.canPost === true, r.body);
    check('posting without the account: needs founder credentials', (await call('POST', `${Y}/jobs/${req.id}/foundit`, {}, T.tl)).body.needsFounder === true);
    await configure('foundit', { 'Recruiter account email': 'hr@teamlink-test.in', 'API key': 'fd-key-1', 'Job endpoint URL': `${SB}/foundit/jobs` });
    check('a recruiter (not the requirement\'s editor) cannot post', (await call('POST', `${Y}/jobs/${req.id}/foundit`, {}, T.rec)).status === 403);
    check('the BDE cannot post', (await call('POST', `${Y}/jobs/${req.id}/foundit`, {}, T.bde)).status === 403);
    r = await call('POST', `${Y}/jobs/${req.id}/foundit`, {}, T.tl);
    const fdPost = seen.filter((s) => s.url === '/foundit/jobs').pop();
    check('the TL posts it: foundit says active -> Posted with foundit\'s id and link', r.status === 200 && r.body.post.status === 'Posted' && r.body.post.externalId === 'FD-9' && fdPost.body.action === 'upsert' && fdPost.body.company === 'TeamLink Consultants', { r: r.body, sent: fdPost && fdPost.body });
    r = await call('POST', `${Y}/jobs/${req.id}/foundit`, {}, T.tl);
    check('posting again updates the same job', r.status === 200 && seen.filter((s) => s.url === '/foundit/jobs').pop().body.reference === req.id, r.body);
    r = await call('DELETE', `${Y}/jobs/${req.id}/foundit`, undefined, T.tl);
    check('take it down: Removed', r.status === 200 && r.body.post.status === 'Removed' && seen.filter((s) => s.url === '/foundit/jobs').pop().body.action === 'close', r.body);
    await configure('shine', { 'Recruiter account email': 'hr@teamlink-test.in', 'API key': 'sh-key-1', 'Job endpoint URL': `${SB}/naukri/jobs` });
    await prisma.requirement.update({ where: { id: req.id }, data: { postingSources: 'TeamLink Job Portal, Naukri, Shine' } });
    await JC.syncAll(req.id, { trigger: 'edit', only: ['shine'] });
    row = await prisma.requirementPosting.findFirst({ where: { requirementId: req.id, source: 'shine' } });
    check('Shine posting through its partner endpoint (stub): Posted', row && row.status === 'Posted', row);
    await call('PUT', `${M}/boards/foundit`, { webhookSecret: 'fd-whs-1' }, T.sa);
    const fdBody = JSON.stringify({ id: `fdwh-${RUN}`, jobReference: req.id, candidate: { name: `Founditperson ${RUN}`, email: `fd.${RUN}@gmail.com`, phone: `6${String(P).padStart(9, '5').slice(-9)}` } });
    r = await call('POST', '/public/mkt/boards/foundit/applications', fdBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('fd-whs-1', fdBody) } });
    const fdc = await prisma.candidate.findFirst({ where: { email: `fd.${RUN}@gmail.com` } });
    check('a foundit application lands with source foundit', r.status === 200 && r.body.added === 1 && fdc && fdc.firstSource === 'foundit', { r: r.body, fs: fdc && fdc.firstSource });
    r = await call('GET', `${Y}/boards`, undefined, T.sa);
    check('the boards summary: Naukri, Shine, foundit posting + every applications door', r.status === 200 && r.body.posting.length === 3 && r.body.posting.every((p) => p.ready) && r.body.applicationsIn.some((b) => b.id === 'foundit'), r.body);

    // ------------------------------------------------------------------ 10.10
    section('10.10 LinkedIn Recruiter System Connect + Apply Connect');
    r = await call('GET', `${Y}/rsc`, undefined, T.sa);
    check('RSC: not set up, says only LinkedIn-approved partners get it', r.status === 200 && r.body.ready === false && /approved/.test(r.body.hint), r.body);
    check('syncing a job while the switch is OFF is refused', (await call('POST', `${Y}/rsc/jobs/${req.id}`, {}, T.sa)).body.switchedOff === 'rscSync');
    await sw('rscSync', true);
    check('switched on, no partner app: needs founder credentials', (await call('POST', `${Y}/rsc/jobs/${req.id}`, {}, T.sa)).body.needsFounder === true);
    await configure('linkedin-rsc', { 'Client ID': 'li-client-1', 'Client secret': 'li-secret-1', 'API base URL': `${SB}/li`, 'Login address (LinkedIn)': `${SB}/li/token`, 'ATS integration context (URN)': 'urn:li:atsIntegrationContext:123' });
    r = await call('POST', `${Y}/rsc/check`, {}, T.sa);
    check('check connection: LinkedIn accepts the sign-in (client credentials)', r.status === 200 && r.body.ok, r.body);
    check('only an Admin checks the connection', (await call('POST', `${Y}/rsc/check`, {}, T.rec)).status === 403);
    r = await call('POST', `${Y}/rsc/jobs/${req.id}`, {}, T.tl);
    const liJob = seen.filter((s) => s.url === '/li/rest/atsJobPostings').pop();
    check('the job is synced to LinkedIn RSC in the integration context', r.status === 200 && liJob && liJob.body.elements[0].externalJobPostingId === req.id && liJob.body.elements[0].integrationContext === 'urn:li:atsIntegrationContext:123' && liJob.auth === 'Bearer li-token-1', liJob && liJob.body);
    r = await call('POST', `${Y}/rsc/candidates/${cand.id}`, {}, T.rec);
    const liCand = seen.filter((s) => s.url === '/li/rest/atsCandidates').pop();
    check('a candidate and their steps are synced', r.status === 200 && liCand && liCand.body.elements[0].externalCandidateId === cand.id && liCand.body.elements[0].applications.some((a) => a.externalJobPostingId === req.id && a.stage === 'Interview booked'), liCand && liCand.body);
    check('the BDE cannot sync a candidate', (await call('POST', `${Y}/rsc/candidates/${cand.id}`, {}, T.bde)).status === 403);
    await call('PUT', `${M}/boards/linkedin`, { webhookSecret: 'li-whs-1' }, T.sa);
    const acBody = JSON.stringify({ applicationId: `liac-${RUN}`, externalJobPostingId: req.id, applicant: { firstName: 'Applyconnect', lastName: `Person ${RUN}`, emailAddress: `liac.${RUN}@gmail.com`, phoneNumber: `6${String(P).padStart(9, '8').slice(-9)}`, profileUrl: `https://www.linkedin.com/in/liac-${RUN}` } });
    r = await call('POST', '/public/mkt/boards/linkedin/applications', acBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('li-whs-1', acBody) } });
    const liac = await prisma.candidate.findFirst({ where: { email: `liac.${RUN}@gmail.com` }, include: { applications: true } });
    check('an Apply Connect application (LinkedIn\'s own shape) lands on the job, source LinkedIn', r.status === 200 && r.body.added === 1 && liac && liac.firstSource === 'LinkedIn' && liac.applications[0].requirementId === req.id, { r: r.body, c: liac && liac.firstSource });
    r = await call('GET', `${Y}/rsc`, undefined, T.sa);
    check('RSC status counts what was synced', r.body.synced.some((s) => s.kind === 'job' && s.count >= 1) && r.body.synced.some((s) => s.kind === 'candidate'), r.body.synced);

    // ------------------------------------------------------------------ 10.08 / IN-02
    section('10.08 / IN-02 Naukri Resdex: search, bring in with the CV, no duplicates, the download log');
    r = await call('POST', `${Y}/resdex/search`, { keywords: 'kubernetes' }, T.rec);
    check('not set up: needs founder credentials (Resdex API access)', r.status === 409 && r.body.needsFounder, r.body);
    check('the BDE cannot search Resdex', (await call('POST', `${Y}/resdex/search`, { keywords: 'kubernetes' }, T.bde)).status === 403);
    check('a Manager (view only) cannot search', (await call('POST', `${Y}/resdex/search`, { keywords: 'kubernetes' }, T.mgr)).status === 403);
    await configure('naukri-resdex', { 'API base URL': `${SB}/resdex`, 'API key': 'rx-key-1', 'Secret key': 'rx-sec-1', 'Daily download limit': '2' });
    check('an empty search is refused', (await call('POST', `${Y}/resdex/search`, { keywords: '' }, T.rec)).status === 400);
    r = await call('POST', `${Y}/resdex/search`, { keywords: 'kubernetes', location: 'Hyderabad', minExperience: 3 }, T.rec);
    const rxSearch = seen.filter((s) => s.url === '/resdex/v1/search').pop();
    check('search: profiles come back, never with contact details', r.status === 200 && r.body.profiles.length === 2 && !JSON.stringify(r.body).includes('leak@should-not-show.in') && !JSON.stringify(r.body).includes('9000000001'), r.body);
    check('... the search was signed with the secret key', rxSearch && rxSearch.sig === `sha256=${crypto.createHmac('sha256', 'rx-sec-1').update(rxSearch.raw).digest('hex')}` && rxSearch.body.minExperience === 3, rxSearch && rxSearch.body);
    check('bringing someone in needs the requirement (so the team sees them)', (await call('POST', `${Y}/resdex/import`, { resdexId: 'RX-1' }, T.rec)).status === 400);
    r = await call('POST', `${Y}/resdex/import`, { resdexId: 'RX-1', requirementId: req.id }, T.rec);
    const rx1 = r.body.candidateId ? await prisma.candidate.findUnique({ where: { id: r.body.candidateId }, include: { applications: true } }) : null;
    check('bring in: a new candidate with source "Naukri Resdex", the CV saved, on the requirement', r.status === 201 && !r.body.duplicate && r.body.resumeSaved && rx1 && rx1.source === 'Naukri Resdex' && rx1.applications.some((a) => a.requirementId === req.id), { r: r.body, src: rx1 && rx1.source });
    const rxResume = rx1 ? await prisma.candidateResume.findFirst({ where: { candidateId: rx1.id } }) : null;
    check('... the CV text is read', rxResume && /Terraform/.test(rxResume.text || ''), rxResume && rxResume.text);
    const dl1 = seen.filter((s) => s.url === '/resdex/v1/profiles/RX-1/download').length;
    r = await call('POST', `${Y}/resdex/import`, { resdexId: 'RX-1', requirementId: req.id }, T.rec);
    check('the same profile again: no second download (no credit), the same person', r.status === 201 && r.body.duplicate && r.body.candidateId === rx1.id && seen.filter((s) => s.url === '/resdex/v1/profiles/RX-1/download').length === dl1, r.body);
    r = await call('POST', `${Y}/resdex/search`, { keywords: 'kubernetes' }, T.rec);
    check('a later search marks the profile "in TeamLink"', r.body.profiles.find((p) => p.id === 'RX-1').inTeamLink === rx1.id, r.body.profiles);
    r = await call('POST', `${Y}/resdex/import`, { resdexId: 'RX-2', requirementId: req.id }, T.rec);
    check('a Resdex profile whose e-mail is already on file: matched to that person, no new record', r.status === 201 && r.body.duplicate && r.body.candidateId === cand.id, r.body);
    await prisma.$executeRawUnsafe('DELETE FROM "MktCandLink" WHERE "url" = ?', 'resdex:RX-1');
    r = await call('POST', `${Y}/resdex/import`, { resdexId: 'RX-1', requirementId: req.id }, T.rec);
    check('the daily download limit (2) is kept', r.status === 429, r.body);
    r = await call('GET', `${Y}/resdex/log`, undefined, T.tl);
    check('the download log: every search, every download (credit) and every reuse (no credit)', r.status === 200 && r.body.rows.filter((x) => x.action === 'download').length === 2 && r.body.rows.filter((x) => x.action === 'reuse').length === 1 && r.body.rows.some((x) => x.action === 'search'), r.body.rows);
    check('a recruiter does not read the company log', (await call('GET', `${Y}/resdex/log`, undefined, T.rec)).status === 403);

    // ------------------------------------------------------------------ 09.04
    section('09.04 candidate profile graph (own data) and the outside profile search');
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "CandidateEmployment" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "company" TEXT, "title" TEXT, "fromMonth" TEXT, "toMonth" TEXT, "isCurrent" INTEGER NOT NULL DEFAULT 0, "ctc" TEXT, "notes" TEXT, "createdAt" TEXT NOT NULL, "createdByName" TEXT, "updatedAt" TEXT)');
    const emp = (cid, company, from, to, cur = 0) => prisma.$executeRawUnsafe('INSERT INTO "CandidateEmployment" ("id","candidateId","company","title","fromMonth","toMonth","isCurrent","createdAt") VALUES (?,?,?,?,?,?,?,?)', crypto.randomBytes(8).toString('hex'), cid, company, 'Engineer', from, to, cur, new Date().toISOString());
    await emp(cand.id, `Oldcorp Systems ${RUN}`, '2018-01', '2020-06');
    await emp(oldMate.id, `Oldcorp Systems ${RUN}`, '2019-03', '2021-12');
    r = await call('GET', `${Y}/candidates/${cand.id}/graph`, undefined, T.rec);
    const g = (k) => (r.body.groups || []).find((x) => x.key === k);
    check('the same employer now: the person in my view is named', r.status === 200 && g('employer') && g('employer').people.some((p) => p.id === mate.id), r.body.groups);
    check('... the one outside my view is counted, never named', !JSON.stringify(r.body).includes(hiddenMate.name) && r.body.hiddenOutsideScope >= 1, r.body.hiddenOutsideScope);
    check('worked together before (same company, same years)', g('colleagues') && g('colleagues').people.some((p) => p.id === oldMate.id && /2019-2020/.test(p.why)), g('colleagues'));
    check('referrals: whom they referred', g('referrals') && g('referrals').people.some((p) => p.id === referred.id), g('referrals'));
    check('who in TeamLink knows them: their recruiter', g('staff') && g('staff').people.some((p) => p.name === rec.name), g('staff'));
    r = await call('GET', `${Y}/candidates/${cand.id}/graph`, undefined, T.sa);
    check('an Admin sees the hidden colleague too', (r.body.groups || []).find((x) => x.key === 'employer').people.some((p) => p.id === hiddenMate.id));
    r = await call('POST', `${Y}/outside/search`, { query: 'kubernetes sre' }, T.rec);
    check('the outside profile search is OFF until the Admin switch', r.status === 409 && r.body.switchedOff === 'outsideLookups', r.body);
    await sw('outsideLookups', true);
    r = await call('POST', `${Y}/outside/search`, { query: 'kubernetes sre' }, T.rec);
    check('switched on, no provider: needs founder credentials', r.status === 409 && r.body.needsFounder, r.body);
    await configure('people-data', { 'Provider name': 'Test People Data', 'API base URL': `${SB}/pd`, 'API key': 'pd-key-1', 'Monthly lookup limit': '50' });
    r = await call('POST', `${Y}/outside/search`, { query: 'kubernetes sre', location: 'Pune' }, T.rec);
    check('outside search (stub provider): profiles with their links', r.status === 200 && r.body.people.length === 1 && /outsider/.test(r.body.people[0].profileUrl), r.body);
    const person = { ...r.body.people[0], provider: 'Test People Data' };
    r = await call('POST', `${Y}/outside/add`, { person, requirementId: req.id }, T.rec);
    check('add the sourced profile: the requirement\'s fit rules still apply (asks for a reason)', r.status === 201 && r.body.candidateId && r.body.application.ok === false && r.body.application.needsReason, r.body);
    r = await call('POST', `${Y}/outside/add`, { person, requirementId: req.id, overrideReason: 'Strong Kubernetes profile, checking Terraform on the call' }, T.rec);
    check('... with the reason it lands on the requirement (the same person, not a second record)', r.status === 201 && r.body.existed && r.body.application.ok, r.body);
    check('the BDE cannot search outside', (await call('POST', `${Y}/outside/search`, { query: 'x' }, T.bde)).status === 403);

    // ------------------------------------------------------------------ 09.06
    section('09.06 contact finding: our own data first, then the provider (verified)');
    r = await call('GET', `${Y}/candidates/${bare.id}/contacts`, undefined, T.rec);
    check('our own data: the e-mail and phone in the person\'s own resume', r.status === 200 && r.body.found.some((f) => f.kind === 'email' && f.value === `bare.${RUN}@gmail.com` && /resume/.test(f.from)) && r.body.found.some((f) => f.kind === 'phone'), r.body);
    r = await call('GET', `${Y}/candidates/${bare.id}/contacts?outside=1`, undefined, T.rec);
    check('with the provider: a verified work e-mail is added', r.status === 200 && r.body.found.some((f) => f.value === `work.${RUN}@acme-test.in` && f.verified), r.body.found);
    check('the BDE never finds contacts', (await call('GET', `${Y}/candidates/${bare.id}/contacts`, undefined, T.bde)).status === 403);
    r = await call('POST', `${Y}/candidates/${bare.id}/contacts`, { kind: 'email', value: `bare.${RUN}@gmail.com` }, T.rec);
    const bare2 = await prisma.candidate.findUnique({ where: { id: bare.id } });
    check('save the found e-mail on the empty field', r.status === 200 && bare2.email === `bare.${RUN}@gmail.com`, r.body);
    check('a second e-mail does not overwrite it', (await call('POST', `${Y}/candidates/${bare.id}/contacts`, { kind: 'email', value: 'other@x.in' }, T.rec)).status === 409);
    check('a Manager cannot save one', (await call('POST', `${Y}/candidates/${bare.id}/contacts`, { kind: 'phone', value: '9848012345' }, T.mgr)).status === 403);

    // ------------------------------------------------------------------ 03.12
    section('03.12 enrichment from an outside source');
    r = await call('POST', `${Y}/candidates/${bare.id}/enrich-outside`, {}, T.rec);
    check('proposals only for EMPTY fields (location, education, skills); the existing employer is not overwritten', r.status === 200 && r.body.proposals.some((p) => p.field === 'location' && p.value === 'Pune') && r.body.proposals.some((p) => p.field === 'skills') && !r.body.proposals.some((p) => p.field === 'currentCompany'), r.body);
    check('... a different employer at the source is recorded as a job change to look at', r.body.jobChange && r.body.jobChange.toCompany === `Newco Labs ${RUN}`, r.body.jobChange);
    r = await call('POST', `${Y}/candidates/${bare.id}/enrich-outside/apply`, { fields: { location: 'Pune', currentCompany: 'Hacked Co' }, provider: 'Test People Data' }, T.rec);
    const bare3 = await prisma.candidate.findUnique({ where: { id: bare.id } });
    check('apply: the empty location filled, a filled field left alone', r.status === 200 && bare3.location === 'Pune' && bare3.currentCompany === 'Acme', { r: r.body, c: bare3.currentCompany });
    const lookups = await prisma.$queryRawUnsafe('SELECT "kind" FROM "AtsYLookup"');
    check('every outside look-up is logged', ['search', 'contact', 'enrich'].every((k) => lookups.some((l) => l.kind === k)), lookups);

    // ------------------------------------------------------------------ 03.13
    section('03.13 job-change alerts: own updates, re-applications, connected sources');
    r = await call('GET', `${Y}/job-changes`, undefined, T.rec);
    check('the enrichment\'s job change waits for the recruiter', r.status === 200 && r.body.rows.some((x) => x.candidateId === bare.id && x.source === 'Test People Data'), r.body.rows);
    const reBody = JSON.stringify({ id: `nkre-${RUN}`, jobReference: req.id, candidate: { name: cand.name, email: cand.email, currentCompany: `Nextgen Cloud ${RUN}`, designation: 'Senior Cloud Engineer' } });
    await call('POST', '/public/mkt/boards/naukri/applications', reBody, undefined, { headers: { 'Content-Type': 'application/json', 'X-Signature': sig('nk-whs-1', reBody) } });
    r = await call('GET', `${Y}/job-changes`, undefined, T.rec);
    const reapp = r.body.rows.find((x) => x.candidateId === cand.id);
    check('a person on file applies again with another employer: a job change "A new application (Naukri)"', reapp && reapp.toCompany === `Nextgen Cloud ${RUN}` && /new application \(Naukri\)/.test(reapp.source), r.body.rows);
    const linkTok = crypto.randomBytes(24).toString('base64url');
    await prisma.$executeRawUnsafe('INSERT INTO "MktUpdateLink" ("id","candidateId","tokenHash","createdById","createdByName","createdAt","expiresAt") VALUES (?,?,?,?,?,?,?)', crypto.randomBytes(8).toString('hex'), mate.id, crypto.createHash('sha256').update(linkTok).digest('hex'), rec.id, rec.name, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString()).catch(() => null);
    r = await call('POST', `/public/mkt/profile/${linkTok}`, { currentCompany: `Selfupdate Corp ${RUN}`, currentDesignation: 'Lead Data Engineer' });
    check('the person\'s own update through the profile link is taken', r.status === 200 && r.body.changed >= 1, r.body);
    check('only a lead runs "check now"', (await call('POST', `${Y}/job-changes/scan`, {}, T.rec)).status === 403);
    r = await call('POST', `${Y}/job-changes/scan`, {}, T.tl);
    check('check now runs over the sources', r.status === 200 && r.body.found >= 1, r.body);
    r = await call('GET', `${Y}/job-changes?status=all`, undefined, T.rec);
    check('the own update is recorded as already applied', r.body.rows.some((x) => x.candidateId === mate.id && x.toCompany === `Selfupdate Corp ${RUN}` && x.applied), r.body.rows.filter((x) => x.candidateId === mate.id));
    check('the BDE cannot apply a change', (await call('POST', `${Y}/job-changes/${reapp.id}`, { decision: 'apply' }, T.bde)).status === 403);
    r = await call('POST', `${Y}/job-changes/${reapp.id}`, { decision: 'apply' }, T.rec);
    const cand2 = await prisma.candidate.findUnique({ where: { id: cand.id } });
    check('apply: the profile takes the new employer and title, with a note', r.status === 200 && cand2.currentCompany === `Nextgen Cloud ${RUN}` && cand2.currentDesignation === 'Senior Cloud Engineer', { r: r.body, c: cand2.currentCompany });
    check('it cannot be applied twice', (await call('POST', `${Y}/job-changes/${reapp.id}`, { decision: 'apply' }, T.rec)).status === 409);
    r = await call('GET', `${Y}/candidates/${cand.id}/job-changes`, undefined, T.rec);
    check('the candidate\'s own list of job changes', r.status === 200 && r.body.rows.some((x) => x.status === 'Applied'), r.body);
    const outsider = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Sales', atsScopeDepartments: 'Sales' }, { department: 'Sales' });
    const T2 = await tok(outsider.id);
    r = await call('GET', `${Y}/job-changes?status=all`, undefined, T2);
    check('a recruiter of another department sees none of these', r.status === 200 && !r.body.rows.some((x) => [cand.id, mate.id, bare.id].includes(x.candidateId)), r.body.rows.length);
    check('bells are OFF until the Admin switch (jobChangeAlerts)', r.body.alerts === false);

    // ------------------------------------------------------------------ 06.05
    section('06.05 prospecting in ATS Clients (OFF by default)');
    r = await call('GET', `${Y}/prospecting`, undefined, T.bde);
    check('OFF by default', r.status === 409 && r.body.switchedOff === 'prospecting', r.body);
    await sw('prospecting', true);
    check('a recruiter has no prospecting', (await call('GET', `${Y}/prospecting`, undefined, T.rec)).status === 403);
    r = await call('GET', `${Y}/prospecting`, undefined, T.bde);
    const zen = (r.body.rows || []).find((x) => x.company === `Zentrix Analytics ${RUN}`);
    check('our own data: a company 3 of our candidates work at, with its HR person as the hiring contact (name and role only)', r.status === 200 && zen && zen.ourPeopleThere === 3 && zen.contacts.some((c) => c.role === 'HR Manager' && !c.email && !c.phone), zen || r.body);
    check('... clients are never suggested', !(r.body.rows || []).some((x) => x.company === client.name));
    r = await call('POST', `${Y}/prospecting/add`, zen, T.bde);
    check('add it to the BD prospect list (the list\'s own route)', r.status === 201 && r.body.prospect && r.body.prospect.title === zen.company, r.body);
    const prospectId = r.body.prospect.id;
    check('the same company twice is refused (duplicate)', (await call('POST', `${Y}/prospecting/add`, zen, T.bde)).status === 409);
    r = await call('GET', `${Y}/prospecting`, undefined, T.bde);
    check('once added it is no longer suggested', !(r.body.rows || []).some((x) => x.company === zen.company));
    r = await call('POST', `${Y}/prospecting/outside`, { industry: 'SaaS', location: 'Pune' }, T.bde);
    check('the company data provider finds new companies with a verified hiring contact', r.status === 200 && r.body.rows.some((x) => x.company === `Freshco ${RUN}` && x.contacts[0].email === 'asha@freshco-test.in'), r.body);
    check('a Manager sees prospecting but does not add', (await call('POST', `${Y}/prospecting/add`, { company: 'Mgr Co' }, T.mgr)).status === 403);
    const camp = await call('POST', '/ats-plus/bd/campaigns', { name: `Intro ${RUN}`, steps: [{ day: 0, subject: 'Hiring help', body: 'Hello from TeamLink' }] }, T.bde);
    r = await call('POST', `${Y}/prospecting/contact`, { prospectId, campaignId: camp.body.id }, T.bde);
    check('contact: the prospect is enrolled in the outreach campaign; nothing is sent while outreach is OFF', r.status === 200 && r.body.enrolled && r.body.sending === false, r.body);

    // ------------------------------------------------------------------ 09.14
    section('09.14 MCP: ATS write tools (note, follow-up, step) behind an Admin switch, scope-checked');
    await call('PUT', `${M}/settings`, { key: 'mcp.on', value: true }, T.sa);
    const mcpTok = (await call('POST', `${M}/mcp/tokens`, { label: 'test' }, T.rec)).body.token;
    const rpc = (method, params, t = mcpTok) => call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, undefined, { headers: { Authorization: `Bearer ${t}` } });
    r = await rpc('tools/list', {});
    check('switch OFF: only the read tools', r.status === 200 && !r.body.result.tools.some((t) => /^ats_/.test(t.name)), r.body.result && r.body.result.tools.map((t) => t.name));
    await sw('mcpWrite', true);
    r = await rpc('tools/list', {});
    check('switch ON: add note, add follow-up, move step are listed', ['ats_add_note', 'ats_add_follow_up', 'ats_move_stage'].every((n) => r.body.result.tools.some((t) => t.name === n)), r.body.result.tools.map((t) => t.name));
    const bdeTok = (await call('POST', `${M}/mcp/tokens`, { label: 'bde' }, T.bde)).body.token;
    r = await rpc('tools/list', {}, bdeTok);
    check('the BDE\'s token never gets the write tools', r.status === 200 && !r.body.result.tools.some((t) => /^ats_/.test(t.name)), r.body.result && r.body.result.tools.map((t) => t.name));
    r = await rpc('tools/call', { name: 'ats_add_note', arguments: { candidateId: mate.id, note: `MCP note ${RUN}` } });
    const note = await prisma.candidateNote.findFirst({ where: { candidateId: mate.id, body: { contains: `MCP note ${RUN}` } } });
    check('add a note on a candidate in my scope', r.body.result && !r.body.result.isError && note && note.authorUserId === rec.id, r.body);
    r = await rpc('tools/call', { name: 'ats_add_note', arguments: { candidateId: hiddenMate.id, note: 'should not land' } });
    check('a candidate outside my scope: refused', r.body.result && r.body.result.isError && !(await prisma.candidateNote.findFirst({ where: { candidateId: hiddenMate.id, body: { contains: 'should not land' } } })), r.body.result);
    const mateApp = await prisma.application.findFirst({ where: { candidateId: mate.id, requirementId: req.id } });
    r = await rpc('tools/call', { name: 'ats_add_follow_up', arguments: { applicationId: mateApp.id, dueDate: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), nextAction: 'Call about the interview' } });
    const fu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: mateApp.id, completedAt: null } });
    check('add a follow-up on my application', r.body.result && !r.body.result.isError && fu && fu.nextAction === 'Call about the interview', { r: r.body.result, fu });
    check('a bad date is refused', (await rpc('tools/call', { name: 'ats_add_follow_up', arguments: { applicationId: mateApp.id, dueDate: 'tomorrow' } })).body.result.isError === true);
    r = await rpc('tools/call', { name: 'ats_move_stage', arguments: { applicationId: mateApp.id, stage: 'Check by recruiter' } });
    const moved = await prisma.application.findUnique({ where: { id: mateApp.id } });
    check('move a step (by its label) through the app\'s own stage rules', r.body.result && !r.body.result.isError && moved.stage === 'RECRUITER_REVIEW', { r: r.body.result, stage: moved.stage });
    r = await rpc('tools/call', { name: 'ats_move_stage', arguments: { applicationId: mateApp.id, stage: 'REJECTED' } });
    check('a rejection without the reasons is refused by the same rules', r.body.result && r.body.result.isError, r.body.result);
    const audits = await prisma.auditLog.findMany({ where: { userId: rec.id, action: { startsWith: 'MCP tool used: ats_' } } }).catch(() => []);
    check('every write tool call is audited', audits.length >= 4, audits.length);
    await sw('mcpWrite', false);
    r = await rpc('tools/call', { name: 'ats_add_note', arguments: { candidateId: mate.id, note: 'after off' } });
    check('switched off again: the tool is unknown', r.body.error && /Unknown tool/.test(r.body.error.message), r.body);

    // ------------------------------------------------------------------ 15.14
    section('15.14 ID document match (name / date of birth / ID number), masked');
    check('save the PAN in IDs & consent first', (await call('POST', `/ats-plus/privacy/candidates/${cand.id}/ids`, { kind: 'PAN', value: 'ABCDE1234F' }, T.rec)).status === 201);
    const goodPdf = await pdf(['INCOME TAX DEPARTMENT', 'GOVT. OF INDIA', 'Permanent Account Number Card', 'ABCDE1234F', 'Name', cand.name.toUpperCase(), 'Date of Birth', '15/08/1994']);
    r = await call('POST', `${Y}/candidates/${cand.id}/id-match`, form({}, { data: goodPdf, type: 'application/pdf', name: 'pan.pdf' }), T.rec);
    check('a PAN card PDF: name, date of birth and PAN all match', r.status === 201 && r.body.docKind === 'PAN card' && r.body.name.verdict === 'match' && r.body.dob.verdict === 'match' && r.body.ids.some((i) => i.kind === 'PAN' && i.verdict === 'match') && r.body.verdict === 'Matches the profile', r.body);
    check('... every number in the answer is masked (no full PAN, no full date of birth)', !JSON.stringify(r.body).includes('ABCDE1234F') && !JSON.stringify(r.body).includes('15/08/1994') && r.body.ids[0].document === 'ABXXXXX34F', r.body.ids);
    const badPdf = await pdf(['INCOME TAX DEPARTMENT', 'ZZZZZ9999Z', 'Name', 'SOMEONE ELSE ENTIRELY', 'Date of Birth', '01/01/1980']);
    r = await call('POST', `${Y}/candidates/${cand.id}/id-match`, form({}, { data: badPdf, type: 'application/pdf', name: 'other.pdf' }), T.rec);
    check('another person\'s PAN card: does not match', r.status === 201 && r.body.verdict.startsWith('Does not match') && r.body.ids.some((i) => i.verdict === 'no match') && r.body.name.verdict === 'no match', r.body);
    fs.writeFileSync(OCR_OUT, `GOVERNMENT OF INDIA\nAadhaar\n${cand.name}\nYear of Birth : 1994\nXXXX XXXX 4321\n`);
    r = await call('POST', `${Y}/candidates/${cand.id}/id-match`, form({}, { data: PNG, type: 'image/png', name: 'aadhaar.png' }), T.rec);
    check('a photo of an Aadhaar card is read by OCR: the year of birth matches; no Aadhaar saved to compare', r.status === 201 && r.body.docKind === 'Aadhaar' && /OCR/.test(r.body.readBy) && /year matches/.test(r.body.dob.verdict) && r.body.ids.some((i) => i.kind === 'Aadhaar' && /nothing saved/.test(i.verdict) && i.document === 'XXXX XXXX 4321'), r.body);
    r = await call('POST', `${Y}/candidates/${cand.id}/id-match`, { text: `Passport Republic of India ${cand.name} 15 Aug 1994 K1234567` }, T.rec);
    check('typed off the card: passport number found (masked), date matches', r.status === 201 && r.body.dob.verdict === 'match' && r.body.ids.some((i) => i.kind === 'Passport number' && i.document === '•••••567'), r.body);
    r = await call('GET', `${Y}/candidates/${cand.id}/id-match`, undefined, T.mgr);
    check('the history keeps the result only (no document text); a Manager reads it but cannot run one', r.status === 200 && r.body.history.length === 4 && r.body.canRun === false && !JSON.stringify(r.body).includes('SOMEONE ELSE'), r.body);
    check('a Manager cannot run a check', (await call('POST', `${Y}/candidates/${cand.id}/id-match`, { text: 'x' }, T.mgr)).status === 403);
    check('the BDE cannot see ID checks', (await call('GET', `${Y}/candidates/${cand.id}/id-match`, undefined, T.bde)).status === 403);
    check('another department\'s recruiter cannot reach this candidate', (await call('POST', `${Y}/candidates/${cand.id}/id-match`, { text: 'x' }, T2)).status === 404);

    section('scope');
    check('another department\'s recruiter: no graph, no contacts, no notetaker of this interview', (await call('GET', `${Y}/candidates/${cand.id}/graph`, undefined, T2)).status === 404 && (await call('GET', `${Y}/candidates/${bare.id}/contacts`, undefined, T2)).status === 404 && (await call('GET', `${Y}/interviews/${app.id}/notetaker`, undefined, T2)).status === 404);
    check('another department\'s recruiter cannot post the job to foundit', (await call('POST', `${Y}/jobs/${req.id}/foundit`, {}, T2)).status === 404);
  } catch (e) {
    check(`no crash (${e.message})`, false, e.stack);
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})();
