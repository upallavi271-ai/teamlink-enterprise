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
  TEST_MOCK_PORTS: String(STUB),
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

  // @@SECTIONS@@

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
