#!/usr/bin/env node
/**
 * MARKET WAVE - builder D (founder 2026-11-21 "the whole ATS must be 90 to 99 percent complete compared with the market"):
 * recruiter insights, branches, business development in ATS Clients, offers & onboarding, Administration (forms, workflows,
 * languages, currency, retention, seats), integrations (open API, webhooks, Slack / Teams, connectors, job boards, SSO),
 * privacy (DPDP, Aadhaar, PAN), status / trust / SLA, candidate identity check. One section per market benchmark ID.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4400 node scripts/market-d-test.js      (ONLY=05.10,14.01 runs some sections)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mkt-d-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4400;
const STUB = PORT + 1; // the stub identity provider / webhook receiver
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'mkt-d-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  TEST_MOCK_PORTS: String(STUB), INTEGRATION_SECRET_KEY: 'mkt-d-test-secret-key',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const want = (id) => !ONLY || ONLY.has(id);
let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = { text }; } return { status: r.status, body: j, headers: r.headers };
};
let server; let stub;
async function stop(code) {
  if (server) server.kill();
  if (stub) stub.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const RUN = `${P}${Date.now().toString(36).slice(-4)}`;
const section = (id, title) => { if (want(id)) console.log(`\n== ${id} ${title}`); return want(id); };

(async () => {
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Mkd ${tag} ${RUN}`, email: `mkd.${tag}.${RUN}@mkd-test.in`, username: `mkd.${tag}.${RUN}@mkd-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `MKD-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const SA = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Mkd Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Mkd Team ${RUN}` });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: TL.name, department: 'IT', team: `Mkd Team ${RUN}` });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' }, { department: 'BDE' });
  const MGR = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const client = await prisma.client.create({ data: { name: `Mkdorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE', bdeOwner: BDE.name } });
  const req = await prisma.requirement.create({ data: { title: `Mkd Cloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: TL.id, tl: TL.name, recruiterId: REC.id, bdeId: BDE.id, reqCode: `MKD-${RUN}`.toUpperCase().slice(0, 14), openings: 3 } });
  const cands = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    cands.push(await prisma.candidate.create({ data: { name: `Mkdperson ${i} ${RUN}`, phone: `9${String(Date.now() + i).slice(-9)}`, email: `mkd.p${i}.${RUN}@mkd-test.in`, skills: 'Kubernetes' } }));
  }
  const apps = [];
  for (const c of cands) {
    // eslint-disable-next-line no-await-in-loop
    apps.push(await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, ownerRecruiterId: REC.id, stage: 'SELECTED' } }));
  }
  // the recruiter's month: 4 sent to client, 2 interviews, 1 offer, 1 joined (stage events are what the Daily report counts)
  const ev = async (appId, toStage, fromStage) => prisma.applicationStageEvent.create({ data: { applicationId: appId, candidateId: apps.find((a) => a.id === appId).candidateId, fromStage, toStage, action: 'Stage moved', actorUserId: REC.id, actorName: REC.name } });
  for (const a of apps) await ev(a.id, 'SHARED_WITH_CLIENT', 'TL_REVIEW'); // eslint-disable-line no-await-in-loop
  await ev(apps[0].id, 'INTERVIEW_SCHEDULED', 'SHARED_WITH_CLIENT'); await ev(apps[1].id, 'INTERVIEW_SCHEDULED', 'SHARED_WITH_CLIENT');
  await ev(apps[0].id, 'OFFER', 'SELECTED');

  // a stub identity provider (OIDC + SAML) and a webhook receiver on STUB
  const hooks = [];
  const { generateKeyPairSync } = crypto;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const stubState = { nonce: null, email: SA.email };
  stub = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      const u = new URL(rq.url, `http://localhost:${STUB}`);
      const json = (o, s = 200) => { rs.writeHead(s, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)); };
      if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: `http://localhost:${STUB}`, authorization_endpoint: `http://localhost:${STUB}/authorize`, token_endpoint: `http://localhost:${STUB}/token`, jwks_uri: `http://localhost:${STUB}/jwks` });
      if (u.pathname === '/jwks') return json({ keys: [jwk] });
      if (u.pathname === '/token') {
        const idToken = jwt.sign({ email: stubState.email, email_verified: true, nonce: stubState.nonce, sub: 'stub-1' }, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: `http://localhost:${STUB}`, audience: 'teamlink-test', expiresIn: '5m' });
        return json({ id_token: idToken, access_token: 'x', token_type: 'Bearer' });
      }
      if (u.pathname.startsWith('/hook')) { hooks.push({ path: u.pathname, headers: rq.headers, body }); return json({ ok: true }); }
      return json({ error: 'not found' }, 404);
    });
  }).listen(STUB);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(SA.id); const tT = await tok(TL.id); const tR = await tok(REC.id); const tB = await tok(BDE.id); const tM = await tok(MGR.id);
  const ctx = { SA, TL, REC, BDE, MGR, client, req, cands, apps, tA, tT, tR, tB, tM, hooks, stubState, privateKey, STUB, PORT, RUN };

  // ================================================================ 05 recruiters
  if (section('05.06', 'Leaderboards (already built: utils/atsWork/targets.js)')) {
    const lb = await call('GET', '/ats/work/leaderboard', null, tT);
    check('the TL sees the live leaderboard', lb.status === 200 && Array.isArray(lb.body.rows), lb.body);
  }
  if (section('05.10', 'Recruiting ratios per recruiter')) {
    const r = await call('GET', '/ats-plus/insights/ratios', null, tT);
    const me = (r.body.rows || []).find((x) => x.userId === REC.id);
    check('the TL sees the recruiter 3 : 2 : 1 : 0 with the conversion', r.status === 200 && me && me.line === '3 : 2 : 1 : 0' && me.subToInterview === 66.7 && me.interviewToOffer === 50, r.body);
    const own = await call('GET', '/ats-plus/insights/ratios', null, tR);
    check('the recruiter sees only their own row and the team line', own.status === 200 && own.body.rows.length === 1 && own.body.rows[0].userId === REC.id && own.body.team && own.body.team.people >= 1, own.body);
  }
  if (section('05.09', 'Coaching insights')) {
    const r = await call('GET', `/ats-plus/insights/coaching?userId=${REC.id}`, null, tT);
    check('coaching for the recruiter: ratios against the team and a summary', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].summary && r.body.team, r.body);
  }
  if (section('05.08', 'Call recordings and transcripts')) {
    await prisma.candidateMessage.create({ data: { candidateId: cands[0].id, applicationId: apps[0].id, channel: 'Call', template: 'CALL', trigger: 'Manual', recipient: cands[0].phone, body: 'Call completed\nRecording: https://recordings.example.test/abc.mp3', status: 'SENT', senderUserId: REC.id, senderName: REC.name } });
    const r = await call('GET', '/ats-plus/insights/calls', null, tR);
    const row = (r.body.rows || []).find((c) => c.source === 'call' && /abc\.mp3/.test(c.recordingUrl));
    check('the recruiter sees their recorded call with the recording link', r.status === 200 && !!row, r.body);
    const t = await call('PUT', `/ats-plus/insights/calls/call/${row && row.id}/transcript`, { text: 'Candidate confirmed the interview at 11.' }, tR);
    const again = await call('GET', '/ats-plus/insights/calls', null, tT);
    check('a pasted transcript is kept and the TL sees it', t.status === 200 && (again.body.rows || []).some((c) => c.id === (row && row.id) && /confirmed the interview/.test(c.transcript || '')), { t: t.body, again: again.body.rows && again.body.rows.length });
    check('a manager cannot write a transcript (view only)', (await call('PUT', `/ats-plus/insights/calls/call/${row && row.id}/transcript`, { text: 'manager text here' }, tM)).status === 403);
  }
  if (section('05.12', 'AI agent activity log')) {
    await prisma.auditLog.create({ data: { userId: REC.id, actorName: REC.name, action: 'AI_AGENT_ACTION', entity: 'Application', entityId: apps[0].id, toValue: 'Moved to interview', reason: 'confirmed by recruiter' } });
    const r = await call('GET', '/ats-plus/insights/ai-activity', null, tR);
    check('the recruiter sees what the AI did for them', r.status === 200 && r.body.rows.some((x) => /AI agent/.test(x.what)), r.body);
    const a = await call('GET', `/ats-plus/insights/ai-activity?userId=${REC.id}`, null, tA);
    check('the Admin picks any person', a.status === 200 && a.body.canPick && a.body.rows.some((x) => x.userId === REC.id));
    const t = await call('GET', `/ats-plus/insights/ai-activity?userId=${SA.id}`, null, tR);
    check('a recruiter asking for someone else still gets only their own rows', t.status === 200 && t.body.rows.every((x) => !x.userId || x.userId === REC.id));
  }
  if (section('05.11', 'Branches')) {
    check('a TL cannot change the branch list', (await call('PUT', '/ats-plus/branches', { branches: [{ name: 'Hyd' }] }, tT)).status === 403);
    const s = await call('PUT', '/ats-plus/branches', { branches: [{ name: `Hyderabad ${RUN}`, city: 'Hyderabad' }, { name: `Vizag ${RUN}`, city: 'Visakhapatnam' }] }, tA);
    check('the Admin saves two branches', s.status === 200 && s.body.branches.length === 2, s.body);
    check('assigning to an unknown branch is refused', (await call('POST', '/ats-plus/branches/assign', { entity: 'Client', ids: [client.id], branch: 'Nowhere' }, tA)).status === 400);
    const a1 = await call('POST', '/ats-plus/branches/assign', { entity: 'Client', ids: [client.id], branch: `Hyderabad ${RUN}` }, tA);
    const a2 = await call('POST', '/ats-plus/branches/assign', { entity: 'User', ids: [REC.id, TL.id], branch: `Hyderabad ${RUN}` }, tA);
    const rep = await call('GET', `/ats-plus/branches/report?branch=${encodeURIComponent(`Hyderabad ${RUN}`)}`, null, tA);
    const row = (rep.body.rows || []).find((x) => x.branch === `Hyderabad ${RUN}`);
    check('the branch report counts its people, clients and jobs (a job follows its client)', a1.status === 200 && a2.status === 200 && row && row.people === 2 && row.clients === 1 && row.jobs === 1 && rep.body.detail.jobs.some((j) => j.id === req.id), rep.body);
    const sc = await call('GET', `/ats-plus/branches/scope?branch=${encodeURIComponent(`Hyderabad ${RUN}`)}`, null, tA);
    check('the branch filter gives the clients, jobs and people of the branch', sc.body.clientIds.includes(client.id) && sc.body.requirementIds.includes(req.id) && sc.body.userIds.includes(REC.id), sc.body);
  }


  // ================================================================ 06 business development (ATS Clients)
  let prospect = null;
  if (section('06.05', 'Account prospecting')) {
    check('a recruiter has no BD list', (await call('GET', '/ats-plus/bd/prospects', null, tR)).status === 403);
    check('a prospect that is already a client is refused', (await call('POST', '/ats-plus/bd/prospects', { name: client.name }, tB)).status === 409);
    const c = await call('POST', '/ats-plus/bd/prospects', { name: `Zephyr Motors ${RUN}`, industry: 'Automobile', city: 'Pune', contacts: [{ name: 'Asha HR', email: `asha.${RUN}@zephyr-test.in` }], value: 250000 }, tB);
    prospect = c.body;
    check('the BDE adds a target company with a contact; they own it', c.status === 201 && prospect.ownerId === BDE.id && prospect.status === 'PROSPECT', c.body);
    check('the same company again is a duplicate', (await call('POST', '/ats-plus/bd/prospects', { name: `zephyr motors pvt ltd ${RUN}` }, tB)).status === 409);
    const n = await call('POST', `/ats-plus/bd/prospects/${prospect.id}/notes`, { text: 'Met at the expo, they are opening a new plant in Chakan.' }, tB);
    check('a note is kept', n.status === 200 && n.body.notes.length === 1);
    check('a manager sees prospects but cannot add one', (await call('GET', '/ats-plus/bd/prospects', null, tM)).status === 200 && (await call('POST', '/ats-plus/bd/prospects', { name: `Mgr Co ${RUN}` }, tM)).status === 403);
  }
  if (section('06.06', 'Hiring signals / opportunity scoring')) {
    const before = (await call('GET', `/ats-plus/bd/prospects/${prospect.id}`, null, tB)).body.score;
    await call('POST', `/ats-plus/bd/prospects/${prospect.id}/postings`, { title: 'Plant Manager', department: 'Production', openings: 4, source: 'Naukri', postedAt: new Date().toISOString().slice(0, 10) }, tB);
    const after = await call('POST', `/ats-plus/bd/prospects/${prospect.id}/postings`, { title: 'Quality Engineer', department: 'Quality', openings: 6, source: 'LinkedIn' }, tB);
    check('job postings raise the score and say why', after.status === 200 && after.body.score > before && after.body.reasons.some((r) => /job posting/.test(r)) && after.body.reasons.some((r) => /expansion/.test(r)), after.body);
    const cs = await call('GET', '/ats-plus/bd/signals/clients', null, tA);
    check('existing clients are scored on their own requirement trend', cs.status === 200 && cs.body.rows.some((r) => r.clientId === client.id), cs.body.rows && cs.body.rows.slice(0, 2));
  }
  if (section('06.02', 'Business development pipeline')) {
    const m = await call('POST', `/ats-plus/bd/prospects/${prospect.id}/stage`, { stage: 'MEETING', note: 'Call on Monday' }, tB);
    check('the BDE moves the prospect to Meeting', m.status === 200 && m.body.status === 'MEETING' && m.body.history.length === 2, m.body);
    check('Lost needs a reason', (await call('POST', `/ats-plus/bd/prospects/${prospect.id}/stage`, { stage: 'LOST' }, tB)).status === 400);
    check('Won needs the real client', (await call('POST', `/ats-plus/bd/prospects/${prospect.id}/stage`, { stage: 'WON' }, tB)).status === 400);
    const w = await call('POST', `/ats-plus/bd/prospects/${prospect.id}/stage`, { stage: 'WON', clientId: client.id }, tB);
    const list = await call('GET', '/ats-plus/bd/prospects', null, tB);
    check('Won links the client; the board counts each stage with its value', w.status === 200 && w.body.clientId === client.id && list.body.board.find((x) => x.key === 'WON').count >= 1, list.body.board);
    const other = await prisma.user.create({ data: { name: `Mkd bde2 ${RUN}`, email: `mkd.bde2.${RUN}@mkd-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
    const tO = await tok(other.id);
    check('another BDE does not see this BDE prospect', (await call('GET', `/ats-plus/bd/prospects/${prospect.id}`, null, tO)).status === 404);
  }
  if (section('06.15', 'AI client summary / pitch')) {
    const s = await call('GET', `/ats-plus/bd/clients/${client.id}/summary`, null, tB);
    check('a client summary and a pitch, written from the record (the AI is off in the sandbox)', s.status === 200 && s.body.summary.includes(client.name) && s.body.pitch && s.body.facts.requirements >= 1 && s.body.by === 'code', s.body);
    const pp = await call('GET', `/ats-plus/bd/prospects/${prospect.id}/pitch`, null, tB);
    check('a pitch for a prospect names what they are hiring for', pp.status === 200 && /Plant Manager|Quality Engineer/.test(pp.body.pitch), pp.body);
    check('no candidate phone or email goes into the facts', !JSON.stringify(s.body.facts).includes(cands[0].phone) && !JSON.stringify(s.body.facts).includes('@mkd-test.in'));
  }
  if (section('06.04', 'BD outreach campaigns (OFF by default)')) {
    const p2 = (await call('POST', '/ats-plus/bd/prospects', { name: `Nimbus Foods ${RUN}`, contacts: [{ name: 'Ravi', email: `ravi.${RUN}@nimbus-test.in` }] }, tB)).body;
    const c = await call('POST', '/ats-plus/bd/campaigns', { name: 'Intro sequence', steps: [{ day: 0, subject: 'Hiring at {{company}}?', body: 'Hi {{name}}, ...' }, { day: 3, subject: 'Following up', body: 'Hi again' }], startOnStage: 'MEETING' }, tB);
    check('a 2-mail campaign is made (Draft)', c.status === 201 && c.body.status === 'DRAFT' && c.body.steps.length === 2, c.body);
    await call('POST', `/ats-plus/bd/campaigns/${c.body.id}/enrol`, { prospectIds: [p2.id] }, tB);
    await call('POST', `/ats-plus/bd/campaigns/${c.body.id}/status`, { status: 'ACTIVE' }, tB);
    const dry = await call('POST', '/ats-plus/bd/campaigns/run', { dryRun: true }, tB);
    check('the dry run shows the first mail is due, filled in for the company', dry.status === 200 && dry.body.enabled === false && dry.body.due.some((d) => d.subject === `Hiring at Nimbus Foods ${RUN}?`), dry.body);
    const off = await call('POST', '/ats-plus/bd/campaigns/run', {}, tA);
    check('while the switch is OFF nothing is sent', off.status === 200 && off.body.sent === 0);
    check('only an Admin switches outreach on', (await call('PUT', '/ats-plus/bd/outreach-settings', { enabled: true }, tB)).status === 403);
    await call('PUT', '/ats-plus/bd/outreach-settings', { enabled: true }, tA);
    const on = await call('POST', '/ats-plus/bd/campaigns/run', {}, tA);
    const sends = (await call('GET', '/ats-plus/bd/campaigns', null, tB)).body.recent;
    check('switched on in the sandbox: the step is marked done but the mail is NOT sent', on.body.sent === 1 && sends.some((x) => /SANDBOX/.test(x.status)), { on: on.body, sends });
    const again = await call('POST', '/ats-plus/bd/campaigns/run', {}, tA);
    check('the same step is not repeated; day 3 is not due yet', again.body.sent === 0);
    await call('PUT', '/ats-plus/bd/outreach-settings', { enabled: false }, tA);
    const p3 = (await call('POST', '/ats-plus/bd/prospects', { name: `Orion Pharma ${RUN}`, contacts: [{ email: `o.${RUN}@orion-test.in` }] }, tB)).body;
    await call('POST', `/ats-plus/bd/prospects/${p3.id}/stage`, { stage: 'MEETING' }, tB);
    const list = (await call('GET', '/ats-plus/bd/campaigns', null, tB)).body.rows.find((x) => x.id === c.body.id);
    check('a prospect reaching Meeting joins the campaign that starts on Meeting', list.enrolledCount === 2, list);
  }

  // ================================================================ 11 offers & joining
  if (section('11.06', 'Conditional offer fields and clause library')) {
    check('a TL cannot add a clause', (await call('POST', '/ats-plus/offers/clauses', { title: 'x clause', text: 'some clause text here' }, tT)).status === 403);
    const c1 = await call('POST', '/ats-plus/offers/clauses', { title: 'Relocation', text: 'A one-time relocation allowance of Rs {{field:reloc}} is paid with the first salary.', conditions: { departments: ['IT'] }, fields: [{ key: 'reloc', label: 'Relocation amount', required: true }] }, tA);
    const c2 = await call('POST', '/ats-plus/offers/clauses', { title: 'Night shift', text: 'This role works night shifts.', conditions: { departments: ['Healthcare'] } }, tA);
    check('the Admin adds two clauses with conditions and a field', c1.status === 201 && c2.status === 201, [c1.body, c2.body]);
    await prisma.application.update({ where: { id: apps[2].id }, data: { offeredCtc: 600000 } });
    const m = await call('GET', `/ats-plus/offers/${apps[2].id}/clauses`, null, tA);
    check('only the IT clause applies to this IT job, and asks for its field', m.status === 200 && m.body.used.length === 1 && m.body.used[0].title === 'Relocation' && m.body.missing.includes('Relocation amount'), m.body);
    await call('PUT', `/ats-plus/offers/${apps[2].id}/clause-fields`, { values: { reloc: '50,000' } }, tA);
    const l = await call('GET', `/ats/offers/${apps[2].id}/letter`, null, tA);
    check('the offer letter carries the clause with the typed amount', l.status === 200 && /Terms\n1\. Relocation: .*Rs 50,000/.test(l.body.text || '') && !/Night shift/.test(l.body.text), l.body.text && l.body.text.slice(-300));
  }
  if (section('11.07', 'Bulk offer generation')) {
    const list = await call('GET', '/ats-plus/offers/bulk/candidates', null, tA);
    check('the people at Selected are listed for a bulk offer', list.status === 200 && apps.every((a) => list.body.rows.some((r) => r.id === a.id)), list.body.rows && list.body.rows.length);
    const b = await call('POST', '/ats-plus/offers/bulk/prepare', { rows: [{ applicationId: apps[1].id }, { applicationId: apps[2].id }, { applicationId: 'nope' }], offeredCtc: 600000, joiningDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) }, tA);
    check('two offers are prepared through the one-by-one route, the unknown row is refused with a reason', b.status === 200 && b.body.prepared === 2 && b.body.refused === 1 && b.body.rows.find((r) => r.applicationId === 'nope').message, b.body);
    const st = await prisma.application.findMany({ where: { id: { in: [apps[1].id, apps[2].id] } }, select: { offerStatus: true } });
    check('both now wait for approval', st.every((x) => /Prepared|approval/i.test(x.offerStatus || '')), st);
    const lt = await call('POST', '/ats-plus/offers/bulk/letters', { ids: [apps[1].id, apps[2].id] }, tA);
    check('the letters come back together to print', lt.status === 200 && lt.body.rows.every((r) => r.ok && r.text), lt.body);
    check('a manager cannot bulk-prepare (view only)', (await call('POST', '/ats-plus/offers/bulk/prepare', { rows: [{ applicationId: apps[0].id }] }, tM)).status === 403);
  }
  let preToken = null;
  if (section('11.10', 'Onboarding checklists by client and job type')) {
    const t1 = await call('POST', '/ats-plus/onboarding/templates', { title: `Mkd client checklist ${RUN}`, clientId: client.id, items: [{ label: 'Upload the signed NDA', who: 'Candidate', type: 'doc', docType: 'Joining' }, { label: 'Your bank details', who: 'Candidate', type: 'form', fields: [{ key: 'pan', label: 'PAN' }, { key: 'aadhaar', label: 'Aadhaar number' }] }, { label: 'Nursing licence', who: 'Candidate', type: 'doc', docType: 'Certificate', expires: true }, { label: 'Laptop ready', who: 'Client', type: 'task' }] }, tA);
    const t2 = await call('POST', '/ats-plus/onboarding/templates', { title: 'Any IT job', jobType: 'IT', items: [{ label: 'Generic step', who: 'Candidate', type: 'task' }] }, tA);
    check('the Admin saves a checklist for this client and one for IT jobs', t1.status === 201 && t2.status === 201, [t1.body, t2.body]);
    const g = await call('GET', `/ats-plus/onboarding/${apps[0].id}`, null, tR);
    check('the client checklist wins over the job-type one', g.status === 200 && g.body.suggested.title === `Mkd client checklist ${RUN}` && /client/.test(g.body.suggested.why), g.body);
  }
  if (section('11.09', 'Pre-boarding portal and document collection')) {
    await prisma.application.update({ where: { id: apps[0].id }, data: { stage: 'OFFER', offerStatus: 'Offer Released' } });
    const o = await call('POST', `/ats-plus/onboarding/${apps[0].id}/open`, { firstDay: '2026-12-01', time: '9:30 am', place: 'Mkdorbit office, Hitec City', meet: 'Asha (HR)' }, tR);
    preToken = o.body.link && o.body.link.split('/').pop();
    check('the recruiter opens pre-boarding and gets one link', o.status === 200 && /^\/preboarding\//.test(o.body.link || ''), o.body);
    const pg = await call('GET', `/public/preboarding/${preToken}`, null, null);
    check('the candidate page (no login) shows the welcome and only the candidate steps', pg.status === 200 && pg.body.welcome.place.includes('Hitec') && pg.body.items.length === 3 && !pg.body.items.some((i) => /Laptop/.test(i.label)) && !('applicationId' in pg.body), pg.body);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%mkd test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')], { type: 'application/pdf' }), 'nda.pdf');
    const nda = pg.body.items.find((i) => /NDA/.test(i.label));
    const up = await fetch(`${API}/public/preboarding/${preToken}/items/${nda.key}/upload`, { method: 'POST', body: fd });
    const docRow = await prisma.candidateDocument.findFirst({ where: { candidateId: cands[0].id, uploadedByName: { contains: 'pre-boarding' } } });
    check('the candidate uploads a document: it lands on their profile as a joining document', up.status === 201 && !!docRow, await up.text().catch(() => ''));
    const bank = pg.body.items.find((i) => i.type === 'form');
    const okA0 = require('../src/utils/atsPlus/privacy').aadhaarOk;
    let bad = null; for (let i = 0; i < 10 && !bad; i += 1) { const t = `23456789012${i}`; if (!okA0(t)) bad = t; }
    const f = await call('POST', `/public/preboarding/${preToken}/items/${bank.key}/done`, { values: { pan: 'ABCPE1234F', aadhaar: bad } }, null);
    check('a wrong Aadhaar is refused on the form', f.status === 400 && /Aadhaar/.test(f.body.error), f.body);
    const okA = require('../src/utils/atsPlus/privacy').aadhaarOk;
    let aad = '234567890120'; for (let i = 0; i < 10; i += 1) { const t = `23456789012${i}`; if (okA(t)) { aad = t; break; } }
    const f2 = await call('POST', `/public/preboarding/${preToken}/items/${bank.key}/done`, { values: { pan: 'ABCPE1234F', aadhaar: aad } }, null);
    const pack = (await call('GET', `/ats-plus/onboarding/${apps[0].id}`, null, tR)).body.pack;
    const vals = pack.items.find((i) => i.key === bank.key).values;
    check('the form keeps only the masked PAN and the last 4 of Aadhaar', f2.status === 200 && vals.pan === 'ABXXXXX34F' && vals.aadhaar === `XXXX XXXX ${aad.slice(-4)}` && !JSON.stringify(pack).includes(aad), vals);
    check('a bad link opens nothing', (await call('GET', '/public/preboarding/not-a-real-token-at-all-123', null, null)).status === 404);
  }
  if (section('11.18', 'Onboarding tasks and welcome portal')) {
    const pack = (await call('GET', `/ats-plus/onboarding/${apps[0].id}`, null, tR)).body.pack;
    const laptop = pack.items.find((i) => /Laptop/.test(i.label));
    const d = await call('POST', `/ats-plus/onboarding/${apps[0].id}/items/${laptop.key}`, { status: 'DONE' }, tR);
    check('the client task is ticked inside TeamLink and the progress moves', d.status === 200 && d.body.pack.items.find((i) => i.key === laptop.key).status === 'DONE' && d.body.pack.progress.done >= 1, d.body.pack && d.body.pack.progress);
    check('waiving a task needs a reason', (await call('POST', `/ats-plus/onboarding/${apps[0].id}/items/${laptop.key}`, { status: 'WAIVED' }, tR)).status === 400);
    const all = await call('GET', '/ats-plus/onboarding', null, tT);
    check('the TL sees the onboarding list with what waits for review', all.status === 200 && all.body.rows.some((r) => r.applicationId === apps[0].id && r.waiting >= 1), all.body);
  }
  if (section('11.11', 'Compliance documents and credential checks')) {
    const pack = (await call('GET', `/ats-plus/onboarding/${apps[0].id}`, null, tR)).body.pack;
    const lic = pack.items.find((i) => /licence/.test(i.label));
    check('a credential cannot be verified before it is uploaded', (await call('POST', `/ats-plus/onboarding/${apps[0].id}/items/${lic.key}`, { status: 'VERIFIED' }, tR)).status === 409);
    const nda = pack.items.find((i) => /NDA/.test(i.label));
    const v = await call('POST', `/ats-plus/onboarding/${apps[0].id}/items/${nda.key}`, { status: 'VERIFIED' }, tR);
    check('an uploaded document is verified', v.status === 200 && v.body.pack.items.find((i) => i.key === nda.key).status === 'VERIFIED');
    await prisma.candidateCertification.create({ data: { candidateId: cands[1].id, name: 'BLS certificate', issuer: 'AHA', expiresOn: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) } });
    const c = await call('GET', '/ats-plus/onboarding-compliance?days=30', null, tT);
    check('credentials expiring in 30 days and the missing expiry are listed', c.status === 200 && c.body.rows.some((r) => /BLS/.test(r.what)) && c.body.rows.some((r) => r.missing && /licence/.test(r.what)), c.body);
  }

  // ================================================================ 15 / India privacy
  if (section('15.09', 'DPDP: notice, consent log, requests, breaches (IN-06)')) {
    const n = await call('GET', '/ats-plus/privacy/notice', null, tR);
    check('the itemised notice is ready in English, Telugu and Hindi', n.status === 200 && n.body.rendered.en.includes('Data Protection Board') && /[ఀ-౿]/.test(n.body.rendered.te) && /[ऀ-ॿ]/.test(n.body.rendered.hi));
    const pub = await call('GET', '/public/privacy-notice?lang=hi', null, null);
    check('the notice is public for candidates (Hindi asked)', pub.status === 200 && /[ऀ-ॿ]/.test(pub.body.text), pub.body);
    const c = await call('POST', '/ats-plus/privacy/consents', { candidateId: cands[1].id, channel: 'call' }, tR);
    check('the recruiter records consent with the notice version', c.status === 201 && c.body.noticeVersion >= 1 && (await prisma.candidate.findUnique({ where: { id: cands[1].id } })).consentStatus === 'GIVEN', c.body);
    check('a withdrawal needs the words of the person', (await call('POST', '/ats-plus/privacy/consents', { candidateId: cands[1].id, status: 'WITHDRAWN' }, tR)).status === 400);
    await call('POST', '/ats-plus/privacy/consents', { candidateId: cands[1].id, status: 'WITHDRAWN', reason: 'Replied STOP on WhatsApp', channel: 'whatsapp' }, tR);
    const log = await call('GET', `/ats-plus/privacy/consents?candidateId=${cands[1].id}`, null, tR);
    check('the consent log keeps both rows; the profile says Withdrawn', log.body.rows.length === 2 && (await prisma.candidate.findUnique({ where: { id: cands[1].id } })).consentStatus === 'WITHDRAWN');
    check('a recruiter cannot open the requests queue', (await call('GET', '/ats-plus/privacy/requests', null, tR)).status === 403);
    const r = await call('POST', '/ats-plus/privacy/requests', { type: 'ERASURE', requester: 'Mkdperson 2 by e-mail', candidateId: cands[2].id }, tA);
    check('an erasure request is logged with a due date', r.status === 201 && r.body.dueAt > new Date().toISOString(), r.body);
    const done = await call('POST', `/ats-plus/privacy/requests/${r.body.id}`, { status: 'DONE', answer: 'Erased on request', erase: true }, tA);
    const er = await prisma.candidate.findUnique({ where: { id: cands[2].id } });
    check('closing it with Erase runs the existing erasure (or says why not)', (done.status === 200 && /Erased/.test(er.name)) || (done.status === 409 && done.body.error), { s: done.status, b: done.body, name: er.name });
    const b = await call('POST', '/ats-plus/privacy/breaches', { what: 'A spreadsheet of 40 candidates was mailed to the wrong client.', people: 40, dataTypes: 'name, phone' }, tA);
    const bl = await call('GET', '/ats-plus/privacy/breaches', null, tA);
    check('a breach is logged with the 72-hour Board deadline', b.status === 201 && bl.body.rows.some((x) => x.id === b.body.id && x.boardDueAt && !x.boardLate));
  }
  if (section('IN-07', 'Aadhaar handling')) {
    const okA = require('../src/utils/atsPlus/privacy').aadhaarOk;
    let aad = null; for (let i = 0; i < 10 && !aad; i += 1) { const t = `98765432101${i}`; if (okA(t)) aad = t; }
    const s = await call('POST', `/ats-plus/privacy/candidates/${cands[0].id}/ids`, { kind: 'AADHAAR', value: aad }, tR);
    check('Aadhaar keeps only the last 4 digits', s.status === 201 && s.body.masked === `XXXX XXXX ${aad.slice(-4)}`, s.body);
    const raw = await prisma.$queryRawUnsafe('SELECT "data" FROM "AtsPlusItem" WHERE "kind" = \'id-number\'');
    check('the full number is nowhere in the store', !raw.some((r) => r.data.includes(aad)));
    check('opening a full Aadhaar is refused: it was never kept', (await call('POST', `/ats-plus/privacy/ids/${s.body.id}/reveal`, { reason: 'checking it now' }, tA)).status === 409);
    await prisma.candidateNote.create({ data: { candidateId: cands[0].id, body: `His Aadhaar is ${aad.slice(0, 4)} ${aad.slice(4, 8)} ${aad.slice(8)} as told on call`, authorName: 'x' } }).catch((e) => console.log('note create', e.message));
    const dry = await call('POST', '/ats-plus/privacy/aadhaar-sweep', { dryRun: true }, tA);
    const run = await call('POST', '/ats-plus/privacy/aadhaar-sweep', {}, tA);
    const note = await prisma.candidateNote.findFirst({ where: { candidateId: cands[0].id } });
    check('the sweep finds a full Aadhaar in a note and masks it', dry.body.numbers >= 1 && run.body.numbers >= 1 && note && note.body.includes(`XXXX XXXX ${aad.slice(-4)}`), { dry: dry.body, note: note && note.body });
    check('a BDE cannot read ID numbers', (await call('GET', `/ats-plus/privacy/candidates/${cands[0].id}/ids`, null, tB)).status === 403);
  }
  if (section('IN-08', 'PAN and bank details')) {
    check('a wrong PAN is refused', (await call('POST', `/ats-plus/privacy/candidates/${cands[0].id}/ids`, { kind: 'PAN', value: 'ABC123' }, tR)).status === 400);
    const b = await call('POST', `/ats-plus/privacy/candidates/${cands[0].id}/ids`, { kind: 'BANK', value: '123456789012', ifsc: 'HDFC0001234' }, tR);
    const list = await call('GET', `/ats-plus/privacy/candidates/${cands[0].id}/ids`, null, tR);
    check('the bank account is shown masked; the recruiter cannot open it', b.status === 201 && list.body.rows.some((r) => r.masked === 'XXXXXX9012') && list.body.canReveal === false && (await call('POST', `/ats-plus/privacy/ids/${b.body.id}/reveal`, { reason: 'payroll set up' }, tR)).status === 403, list.body);
    const pan = (await call('GET', `/ats-plus/privacy/candidates/${cands[0].id}/ids`, null, tA)).body.rows.find((r) => r.kind === 'PAN');
    check('the PAN typed on the pre-boarding form is stored encrypted, masked', pan && pan.masked === 'ABXXXXX34F' && pan.encrypted, pan);
    check('opening it needs a reason', (await call('POST', `/ats-plus/privacy/ids/${pan.id}/reveal`, {}, tA)).status === 400);
    const rv = await call('POST', `/ats-plus/privacy/ids/${pan.id}/reveal`, { reason: 'Form 16 for payroll' }, tA);
    const views = await call('GET', '/ats-plus/privacy/id-views', null, tA);
    check('the Admin opens the full PAN once and it is logged', rv.status === 200 && rv.body.value === 'ABCPE1234F' && views.body.rows.some((v) => v.reason === 'Form 16 for payroll'), rv.body);
  }
  if (section('13.10', 'Data retention rules (OFF by default)')) {
    const g = await call('GET', '/ats-plus/privacy/retention', null, tA);
    check('retention starts OFF', g.status === 200 && g.body.enabled === false);
    await call('PUT', '/ats-plus/privacy/retention', { rules: { inactiveCandidates: { on: true, months: 1 }, messageBodies: { on: true, months: 1200 } } }, tA);
    await prisma.candidate.create({ data: { name: `Mkd old ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, createdAt: new Date(Date.now() - 90 * 86400000) } });
    const dry = await call('POST', '/ats-plus/privacy/retention/run', { dryRun: true }, tA);
    check('the dry run counts what would go, while OFF', dry.status === 200 && dry.body.results.find((r) => r.type === 'inactiveCandidates').count >= 1, dry.body);
    check('the purge is refused while OFF', (await call('POST', '/ats-plus/privacy/retention/run', { confirm: 'PURGE' }, tA)).status === 409);
    check('a TL cannot change retention', (await call('PUT', '/ats-plus/privacy/retention', { enabled: true }, tT)).status === 403);
    await call('PUT', '/ats-plus/privacy/retention', { enabled: true }, tA);
    check('switched on, it still needs PURGE typed', (await call('POST', '/ats-plus/privacy/retention/run', {}, tA)).status === 400);
    const run = await call('POST', '/ats-plus/privacy/retention/run', { confirm: 'PURGE' }, tA);
    check('the purge anonymises up to 200 inactive people', run.status === 200 && run.body.results.find((r) => r.type === 'inactiveCandidates').done >= 1, run.body);
    await call('PUT', '/ats-plus/privacy/retention', { enabled: false }, tA);
  }
  if (section('15.11', 'Regional data residency (IN-14)')) {
    const s = await call('PUT', '/ats-plus/privacy/residency', { region: 'India', provider: 'VPS in India', city: 'Mumbai', backupLocation: 'India (second disk)', confirm: true }, tA);
    check('the Admin states where data and backups are kept', s.status === 200 && s.body.confirmedBy === SA.name);
    const t = await call('GET', '/public/trust', null, null);
    check('the public trust page says India for data and backups', t.status === 200 && t.body.residency.region === 'India' && /India/.test(t.body.residency.backupLocation), t.body.residency);
  }
  if (section('15.12', 'Trust centre and status page')) {
    await call('POST', '/ats-plus/status/sample', null, tA);
    const s = await call('GET', '/public/status', null, null);
    check('the public status page answers without a login: components, uptime, 90 days', s.status === 200 && s.body.components.length >= 2 && s.body.uptime.month.samples >= 1 && Array.isArray(s.body.daily), s.body);
    const t = await call('GET', '/public/trust', null, null);
    check('the trust page lists the real practices and says plainly which certifications are not held', t.status === 200 && t.body.practices.length >= 5 && t.body.certifications.every((c) => /Not held/.test(c.status)));
    check('a TL cannot switch the pages off', (await call('PUT', '/ats-plus/status/settings', { public: false }, tT)).status === 403);
  }
  if (section('15.16', 'Uptime / support SLA')) {
    const u = await call('PUT', '/ats-plus/status/settings', { uptimeTarget: 99.9, supportEmail: 'support@teamlink.test', response: { P1: '1 hour' } }, tA);
    const s = await call('GET', '/public/sla', null, null);
    check('the SLA page shows the targets an Admin set against the measured uptime', u.status === 200 && s.status === 200 && s.body.uptimeTarget === 99.9 && s.body.response.P1 === '1 hour' && s.body.measured.month, s.body);
  }
  // @@SECTIONS@@

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
