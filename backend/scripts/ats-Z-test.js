#!/usr/bin/env node
/**
 * ATS WAVE 2 - BUILDER Z (founder 2026-11-25 "push ATS to 95+"): 05.11 branch switch, 13.06 ATS in Telugu / Hindi, 14.03 app catalogue,
 * 15.13 installable app, 07.01 / 14.05 calendar push + Google / Microsoft 365, 14.09 / IN-15 BGV vendor, 14.10 assessment vendor,
 * 14.15 / IN-03 job-board multiposting + responses, 15.01 SSO test, 15.11 / IN-14 / 15.16 region and SLA evidence.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database + one local stub for every outside party (Google OAuth / Calendar /
 * People, an OIDC IdP, a BGV vendor, a test vendor, foundit, Naukri responses). Nothing leaves the machine.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4612 node scripts/ats-Z-test.js        (ONLY=05.11,14.03 runs some sections)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-ats-z-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4612;
const STUB = PORT + 1;
const API = `http://localhost:${PORT}/api`;
const SB = `http://localhost:${STUB}`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'ats-z-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  TEST_MOCK_PORTS: String(STUB), INTEGRATION_SECRET_KEY: 'ats-z-test-secret-key-0123456789', APP_BASE_URL: `http://localhost:${PORT}`,
  MKT_GOOGLE_AUTH_URL: `${SB}/g/auth`, MKT_GOOGLE_TOKEN_URL: `${SB}/g/token`, MKT_GOOGLE_API_URL: `${SB}/g/cal`, MKT_GOOGLE_PEOPLE_URL: `${SB}/g/people`,
  // the off-site backup is "set up" with a US region: the evidence page must flag it against the stated India region
  BACKUP_ENC_KEY: 'ats-z-test-backup-passphrase', BACKUP_S3_BUCKET: 'zz-test', BACKUP_S3_REGION: 'us-east-1', BACKUP_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
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
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = { text }; } return { status: r.status, body: j, headers: r.headers, text };
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return !!(await fn()); }; // eslint-disable-line no-await-in-loop
let server; let stub;
async function stop(code) {
  if (server) server.kill();
  if (stub) stub.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const RUN = `${process.pid}${Date.now().toString(36).slice(-4)}`;
const section = (id, title) => { if (want(id)) console.log(`\n== ${id} ${title}`); return want(id); };

(async () => {
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Zt ${tag} ${RUN}`, email: `zt.${tag}.${RUN}@zt-test.in`, username: `zt.${tag}.${RUN}@zt-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `ZT-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const SA = await mk('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const ADM = await mk('adm', { role: 'ADMIN', atsRole: 'ADMIN' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Zt Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Zt Team ${RUN}` });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: TL.name, department: 'IT', team: `Zt Team ${RUN}` });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' }, { department: 'BDE' });
  const MGR = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const client = await prisma.client.create({ data: { name: `Ztorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE', bdeOwner: BDE.name } });
  const client2 = await prisma.client.create({ data: { name: `Ztother Labs ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const R = await prisma.requirement.create({ data: { title: `Zt Cloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: TL.id, tl: TL.name, recruiterId: REC.id, bdeId: BDE.id, reqCode: `ZT-${RUN}`.toUpperCase().slice(0, 14), openings: 3, skills: 'Kubernetes', location: 'Hyderabad' } });
  const R2 = await prisma.requirement.create({ data: { title: `Zt Other Role ${RUN}`, clientId: client2.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: TL.id, tl: TL.name, recruiterId: REC.id, reqCode: `ZU-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  const cand = await prisma.candidate.create({ data: { name: `Ztperson Quill ${RUN}`, phone: `9${String(Date.now()).slice(-9)}`, email: `zt.p.${RUN}@zt-test.in`, skills: 'Kubernetes' } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: R.id, ownerRecruiterId: REC.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 2 * 86400e3), interviewRound: 1, interviewMode: 'Online' } });

  // ---------------------------------------------------------------- one stub for every outside party
  const calls = [];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kz', use: 'sig', alg: 'RS256' };
  const idp = { nonce: null, email: SA.email };
  const NK = { phone: `8${String(Date.now() + 7).slice(-9)}`, phone2: `8${String(Date.now() + 9).slice(-9)}` };
  stub = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      const u = new URL(rq.url, SB);
      calls.push({ method: rq.method, path: u.pathname, query: u.search, headers: rq.headers, body });
      const json = (o, s = 200) => { rs.writeHead(s, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)); };
      const p = u.pathname;
      if (p === '/g/token') return json(/grant_type=refresh_token/.test(body) ? { access_token: 'at-2', expires_in: 3600 } : { access_token: 'at-1', refresh_token: `rt-${Date.now()}`, expires_in: 3600 });
      if (p === '/g/cal/freeBusy') return json({ calendars: { primary: { busy: [] } } });
      if (p === '/g/cal/calendars/primary/events' && rq.method === 'POST') return json({ id: 'gev-1' });
      if (p.startsWith('/g/cal/calendars/primary/events/')) { if (rq.method === 'DELETE') { rs.writeHead(204); return rs.end(); } return json({ id: p.split('/').pop() }); }
      if (p === '/g/people/people/me/connections') return json({ connections: [{ names: [{ displayName: `Zara Contact ${RUN}` }], emailAddresses: [{ value: `zara.${RUN}@client-test.in` }], phoneNumbers: [{ value: '+91 90000 11111' }], organizations: [{ name: 'Ztorbit', title: 'HR Head' }] }, { names: [{ displayName: 'Someone Else' }], emailAddresses: [{ value: 'else@x-test.in' }] }] });
      if (p === '/oidc/.well-known/openid-configuration') return json({ issuer: `${SB}/oidc`, authorization_endpoint: `${SB}/oidc/authorize`, token_endpoint: `${SB}/oidc/token`, jwks_uri: `${SB}/oidc/jwks` });
      if (p === '/oidc/jwks') return json({ keys: [jwk] });
      if (p === '/oidc/token') return json({ id_token: jwt.sign({ email: idp.email, email_verified: true, nonce: idp.nonce, sub: 'z-1' }, privateKey, { algorithm: 'RS256', keyid: 'kz', issuer: `${SB}/oidc`, audience: 'tl-z', expiresIn: '5m' }), access_token: 'x', token_type: 'Bearer' });
      if (p === '/bgv/orders' && rq.method === 'POST') return json({ id: 'BGV-77', status: 'initiated' });
      if (p === '/bgv/orders/BGV-77') return json({ status: 'completed', checks: [{ type: 'education', status: 'verified' }, { type: 'employment', status: 'clear' }, { type: 'criminal court record', status: 'record_found' }], reportUrl: 'https://vendor.example/r/77' });
      if (p === '/test/orders' && rq.method === 'POST') return json({ id: 'T-5', status: 'invited', testUrl: 'https://vendor.example/t/5' });
      if (p === '/test/orders/T-5') return json({ status: 'completed', score: 78, maxScore: 100, passed: true });
      if (p === '/foundit/jobs') return json({ id: 'FD-1', status: 'live', url: 'https://foundit.example/j/1' });
      if (p === '/naukri/responses') return json({ data: [{ id: `nk1-${RUN}`, name: `Zeta Applicant ${RUN}`, phone: NK.phone, email: `zeta.${RUN}@zt-test.in`, jobReference: R.id, skills: 'Kubernetes, Docker', appliedAt: new Date().toISOString() }, { id: `nk2-${RUN}`, name: `Lost Applicant ${RUN}`, phone: NK.phone2, jobReference: 'NO-SUCH-JOB' }] });
      return json({ error: 'not found' }, 404);
    });
  }).listen(STUB);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  await sleep(1100);
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tSA = await tok(SA); const tADM = await tok(ADM); const tREC = await tok(REC); const tBDE = await tok(BDE); const tMGR = await tok(MGR);
  const configure = (id, values) => call('PUT', `/admin/integrations/${id}/configure`, { values }, tSA);
  const run = async (id, title, fn) => { if (!section(id, title)) return; try { await fn(); } catch (e) { check(`${id}: ran without an error`, false, e.stack); } };

  // ================================================================ 05.11 branch switch
  await run('05.11', 'Branch / office switch on the working lists', async () => {
    const HYD = `Zb Hyd ${RUN}`; const PUNE = `Zb Pune ${RUN}`;
    const prev = await call('GET', '/ats-plus/branches', null, tSA);
    const s = await call('PUT', '/ats-plus/branches', { branches: [...(prev.body.branches || []), { name: HYD, city: 'Hyderabad' }, { name: PUNE, city: 'Pune' }] }, tSA);
    check('Admin saves two branches', s.status === 200 && s.body.branches.some((b) => b.name === HYD), s.body);
    check('a recruiter cannot change the branches (Admin only)', (await call('PUT', '/ats-plus/branches', { branches: [] }, tREC)).status === 403);
    const as = await call('POST', '/ats-plus/branches/assign', { entity: 'Client', ids: [client.id], branch: HYD }, tSA);
    check('a client is given the Hyderabad branch', as.status === 200 && as.body.count === 1, as.body);
    const sc = await call('GET', `/ats-plus/branches/scope?branch=${encodeURIComponent(HYD)}`, null, tSA);
    check('the branch scope has the client and its job (a job follows its client\'s branch)', sc.body.clientIds.includes(client.id) && sc.body.requirementIds.includes(R.id) && !sc.body.requirementIds.includes(R2.id), sc.body);
    const rq = await call('GET', `/requirements?page=1&pageSize=200&view=all&branch=${encodeURIComponent(HYD)}`, null, tSA);
    const ids = (rq.body.rows || []).map((r) => r.id);
    check('Requirements with the branch switch on: only that branch\'s jobs (R in, the other client\'s job out)', rq.status === 200 && ids.includes(R.id) && !ids.includes(R2.id) && ids.every((x) => sc.body.requirementIds.includes(x)), { status: rq.status, n: ids.length, err: rq.body.error });
    const cl = await call('GET', `/clients?archived=1&branch=${encodeURIComponent(HYD)}`, null, tSA);
    check('Clients with the branch switch on: only that branch\'s clients', cl.status === 200 && Array.isArray(cl.body) && cl.body.length === 1 && cl.body[0].id === client.id, { status: cl.status, n: Array.isArray(cl.body) ? cl.body.length : cl.body });
    const cp = await call('GET', `/clients?archived=1&branch=${encodeURIComponent(PUNE)}`, null, tSA);
    const rp = await call('GET', `/requirements?page=1&pageSize=50&view=all&branch=${encodeURIComponent(PUNE)}`, null, tSA);
    check('a branch with nothing in it shows empty lists', Array.isArray(cp.body) && cp.body.length === 0 && rp.body.total === 0, { c: cp.body.length, r: rp.body.total });
    const all = await call('GET', '/requirements?page=1&pageSize=50', null, tREC);
    const mine = await call('GET', `/requirements?page=1&pageSize=50&branch=${encodeURIComponent(HYD)}`, null, tREC);
    check('a recruiter\'s list with the switch is never wider than without it (it only narrows their own scope)', mine.status === 200 && mine.body.total <= all.body.total && (mine.body.rows || []).every((r) => sc.body.requirementIds.includes(r.id)), { all: all.body.total, mine: mine.body.total });
    const fe = fs.readFileSync(path.join(FRONT, 'src', 'components', 'atsPlus', 'BranchSwitchZ.jsx'), 'utf8');
    const used = ['Requirements.jsx', 'Clients.jsx'].every((f) => fs.readFileSync(path.join(FRONT, 'src', 'pages', f), 'utf8').includes('<BranchSwitchZ'));
    check('the switch screen is on Clients and Requirements and reads /ats-plus/branches/scope', used && fe.includes('/ats-plus/branches/scope'));
  });

  // ================================================================ 13.06 ATS in Telugu / Hindi
  await run('13.06', 'ATS screens in Telugu and Hindi', async () => {
    let s = fs.readFileSync(path.join(FRONT, 'src', 'atsI18nZ.js'), 'utf8');
    s = s.replace(/^import .*$/m, 'const translations = { te: {}, hi: {} };').replace(/export const/g, 'const').replace(/export /g, '');
    const m = {}; new Function('module', `${s}\nmodule.exports = { ATS_TE, ATS_HI, translations };`)(m); // eslint-disable-line no-new-func
    const { ATS_TE, ATS_HI } = m.exports;
    check('the ATS adds 250+ words in Telugu and the same words in Hindi', Object.keys(ATS_TE).length >= 250 && Object.keys(ATS_TE).every((k) => ATS_HI[k]), Object.keys(ATS_TE).length);
    const v = fs.readFileSync(path.join(FRONT, 'src', 'atsVocab.js'), 'utf8');
    const block = (name) => { const i = v.indexOf(`export const ${name} = {`); return v.slice(i, v.indexOf('};', i)); };
    const words = [...new Set(['STAGE_LABELS', 'INTERVIEW_STATUS_LABELS', 'AGREEMENT_STATUS_LABELS'].flatMap((b) => [...block(b).matchAll(/:\s*'([^']+)'/g)].map((x) => x[1])))];
    const base = fs.readFileSync(path.join(FRONT, 'src', 'i18n.jsx'), 'utf8');
    const has = (w) => ATS_TE[w] || base.includes(`'${w}':`) || base.includes(` ${w}:`);
    const missing = words.filter((w) => !has(w));
    check('every step, interview status and agreement status word has a Telugu and Hindi translation', words.length > 25 && missing.length === 0, missing);
    check('the status words are drawn through t() (stageLabel, interview / requirement / agreement status)', /export function stageLabel\(code\) \{\n\s+return code && STAGE_LABELS\[code\] \? tr\(/.test(v) && /requirementStatusLabel\(code\) \{\n\s+return tr\(/.test(v) && /interviewStatusLabel\(code\) \{\n\s+return INTERVIEW_STATUS_LABELS\[code\] \? tr\(/.test(v));
    const rd = (f) => fs.readFileSync(path.join(FRONT, 'src', f), 'utf8');
    check('the shared ATS pieces translate: list header (Filters, Sort, Clear all, Showing), filter bar, chips, ATS kit panels / tiles, settings sections, import / export',
      rd('components/ui/ListPageHeader.jsx').includes("tr('Filters')") && rd('components/ui/ListPageHeader.jsx').includes("tr('Showing {from} to {to} of {total}'") && rd('components/ats/FilterBar.jsx').includes("tr('More filters')")
      && rd('components/FilterChips.jsx').includes("tr('Clear all')") && rd('components/atskit/AtsKit.jsx').includes('<h3>{T(title)}</h3>') && rd('components/atsPlus/kit.jsx').includes('tr(title)') && rd('components/AtsDataTools.jsx').includes("tr('Export')"));
    check('the page headings of the ATS screens are translated', ['pages/Candidates.jsx', 'pages/ats/InterviewCalendar.jsx', 'pages/ats/FollowUps.jsx', 'components/clientsreq-v4/ListBits.jsx', 'pages/admin/AtsPlusSettings.jsx'].every((f) => /<h1>\{(tr|trZ)\(/.test(rd(f)) || /<h1>\{typeof title === 'string' \? tr\(title\)/.test(rd(f))));
    check('App.jsx loads the ATS words once', rd('App.jsx').includes("import './atsI18nZ.js'"));
    const put = await call('PUT', '/ats-plus/i18n/me', { lang: 'te' }, tREC);
    const get = await call('GET', '/ats-plus/i18n/me', null, tREC);
    check('a recruiter picks Telugu and it stays on their login', put.status === 200 && get.body.lang === 'te' && get.body.saved === true, get.body);
    check('an unknown language is refused', (await call('PUT', '/ats-plus/i18n/me', { lang: 'fr' }, tREC)).status === 400);
    await call('PUT', '/ats-plus/i18n/me', { lang: 'en' }, tREC);
  });

  // ================================================================ 14.03 app catalogue
  await run('14.03', 'ATS app catalogue', async () => {
    const a = await call('GET', '/ats-plus/apps', null, tSA);
    const ids = (a.body.apps || []).map((x) => x.id);
    check('the catalogue lists 20+ built-in apps across categories', a.status === 200 && a.body.total >= 20 && a.body.categories.length >= 6, { total: a.body.total, cats: a.body.categories });
    check('it has the job boards, calendar, checks, API, SSO and the phone app', ['naukri', 'shine', 'foundit', 'indeed', 'linkedin', 'ats-board-pull', 'ats-workspace', 'ats-bgv', 'ats-assessment', 'open-api', 'webhooks', 'sso', 'phone-app', 'whatsapp'].every((x) => ids.includes(x)), ids);
    const OK = ['Connected', 'Ready', 'Switched off', 'Not set up', 'Built in'];
    check('every app has a live status word and an Admin gets a Set up link', a.body.apps.every((x) => OK.includes(x.status) && x.setUpLink && x.what), a.body.apps.filter((x) => !OK.includes(x.status) || !x.setUpLink).map((x) => x.id));
    check('the BGV vendor starts "Not set up" and says it needs a founder account', a.body.apps.find((x) => x.id === 'ats-bgv').status === 'Not set up' && a.body.apps.find((x) => x.id === 'ats-bgv').needsFounder === true);
    const r = await call('GET', '/ats-plus/apps', null, tREC);
    check('a recruiter reads the catalogue, without Set up links', r.status === 200 && r.body.apps.every((x) => x.setUpLink === null) && r.body.canSetUp === false);
    const cl = await prisma.user.findFirst({ where: { role: 'CLIENT', status: 'Active' } });
    if (cl) check('a client login cannot read it', (await call('GET', '/ats-plus/apps', null, await tok(cl))).status === 403);
    check('the Set up links open the right places (Integrations card / ATS settings sub-tab)', a.body.apps.find((x) => x.id === 'ats-bgv').setUpLink === '/admin/integrations?tab=connections&channel=ats-bgv' && a.body.apps.find((x) => x.id === 'sso').setUpLink === '/admin/ats-settings?tab=integrations&sub=sso');
    const fe = fs.readFileSync(path.join(FRONT, 'src', 'pages', 'admin', 'Integrations.jsx'), 'utf8');
    check('the Integrations page opens a card from ?channel= and the ATS Integrations tab from ?sub=', fe.includes("searchParams.get('channel')") && fs.readFileSync(path.join(FRONT, 'src', 'components', 'atsPlus', 'admin', 'IntegrationsTab.jsx'), 'utf8').includes("params.get('sub')"));
  });

  // ================================================================ 15.13 installable app
  await run('15.13', 'Installable ATS app (PWA shortcuts; store details)', async () => {
    const man = JSON.parse(fs.readFileSync(path.join(FRONT, 'public', 'tl-app.webmanifest'), 'utf8'));
    const routes = fs.readFileSync(path.join(FRONT, 'src', 'App.jsx'), 'utf8');
    const ats = man.shortcuts.filter((s) => /^\/(ats\/followups|candidates|ats\/calendar|requirements)\b/.test(s.url));
    check('the installed app has 4 ATS shortcuts beside the CRM ones', ats.length === 4 && man.shortcuts.some((s) => s.url.startsWith('/crm')), man.shortcuts.map((s) => s.url));
    check('each ATS shortcut opens a real screen', ats.every((s) => routes.includes(`path="${s.url.split('?')[0].slice(1)}"`)), ats.map((s) => s.url));
    const st = await call('GET', '/ats-plus/mobilez', null, tREC);
    check('the phone app status: installable now, 4 ATS shortcuts, stores need founder accounts', st.status === 200 && st.body.installable && st.body.atsShortcuts === 4 && !st.body.android.ready && !st.body.ios.ready, st.body);
    check('the store files are not served before the details are typed', (await fetch(`http://localhost:${PORT}/.well-known/assetlinks.json`)).status === 404);
    check('a wrong package name is refused', (await call('PUT', '/ats-plus/mobilez', { androidPackage: 'Not A Package' }, tSA)).status === 400);
    check('a recruiter cannot type the store details', (await call('PUT', '/ats-plus/mobilez', { androidPackage: 'in.teamlink.app' }, tREC)).status === 403);
    const fp = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
    const sv = await call('PUT', '/ats-plus/mobilez', { androidPackage: 'in.teamlink.app', androidSha256: fp, iosTeamId: 'ABCDE12345', iosBundleId: 'in.teamlink.app' }, tSA);
    const al = await fetch(`http://localhost:${PORT}/.well-known/assetlinks.json`).then((r) => r.json()).catch(() => null);
    const aa = await fetch(`http://localhost:${PORT}/.well-known/apple-app-site-association`).then((r) => r.json()).catch(() => null);
    check('saved: assetlinks.json proves the site for the Android app', sv.status === 200 && al && al[0].target.package_name === 'in.teamlink.app' && al[0].target.sha256_cert_fingerprints[0] === fp, al);
    check('saved: apple-app-site-association names the iOS app', aa && aa.applinks.details[0].appIDs[0] === 'ABCDE12345.in.teamlink.app', aa);
  });

  // ================================================================ 07.01 calendar push / 14.05 Google / Microsoft 365
  const connect = async (t) => {
    const c = await call('POST', '/ats/mkt/calendar/google/connect', {}, t);
    const st = c.body.url ? new URL(c.body.url).searchParams.get('state') : '';
    const cb = await fetch(`${API}/public/mkt/cal-oauth/google/callback?code=c-${RUN}&state=${encodeURIComponent(st)}`);
    return { c, cb };
  };
  await run('07.01', 'Interview scheduling with calendar sync (Google push, stub)', async () => {
    await call('PUT', '/ats/mkt/switches', { calendarPush: false }, tSA); // the copy may carry an earlier test's switch
    const before = await call('POST', '/ats/mkt/calendar/google/connect', {}, tREC);
    check('before the app keys: Connect says it needs the founder\'s Google app', before.status === 409 && before.body.needsFounder === true, before.body);
    check('a recruiter cannot type the app keys', (await call('PUT', '/ats-plus/integrations/workspace', { googleClientId: 'x', googleSecret: 'y' }, tREC)).status === 403);
    const w = await call('PUT', '/ats-plus/integrations/workspace', { googleClientId: `zt-${RUN}.apps.googleusercontent.com`, googleSecret: 'zt-google-secret' }, tSA);
    const row = await prisma.integration.findUnique({ where: { id: 'ats-workspace' } });
    check('the Google app keys go to the one credential store (Administration > Integrations), the secret encrypted', w.status === 200 && row && row.connected && !String(row.values).includes('zt-google-secret'), { status: w.status, values: row && row.values && row.values.slice(0, 80) });
    const ov = await call('GET', '/ats-plus/calendarz/overview', null, tREC);
    check('the calendar connection sees the app as ready (it reads the same store)', ov.status === 200 && ov.body.apps.google.ready === true && ov.body.pushSwitch === false, ov.body.apps);
    const { c, cb } = await connect(tREC);
    check('Connect sends the recruiter to Google with our client id (stub)', c.status === 200 && c.body.url.includes(`client_id=zt-${RUN}`) && c.body.url.includes('contacts.readonly'), c.body);
    const ov2 = await call('GET', '/ats-plus/calendarz/overview', null, tREC);
    check('the callback keeps the permission: the recruiter\'s Google calendar is connected', cb.status === 200 && ov2.body.connections.google.connected === true, ov2.body.connections);
    const n0 = calls.filter((x) => x.path.startsWith('/g/cal/calendars')).length;
    const t1 = new Date(Date.now() + 3 * 86400e3).toISOString();
    const r0 = await call('POST', `/ats/interviews/${app.id}/reschedule`, { interviewAt: t1, reason: 'Client asked for Thursday' }, tSA);
    await sleep(1500);
    check('switch OFF (the default): a moved interview is NOT put in anyone\'s calendar', r0.status === 200 && calls.filter((x) => x.path.startsWith('/g/cal/calendars')).length === n0, { r0: r0.status, body: r0.body.error });
    const sw = await call('PUT', '/ats/mkt/switches', { calendarPush: true }, tSA);
    check('the Admin switches "follow the bookings" ON', sw.status === 200 && sw.body.switches.calendarPush === true, sw.body);
    const t2 = new Date(Date.now() + 4 * 86400e3).toISOString();
    await call('POST', `/ats/interviews/${app.id}/reschedule`, { interviewAt: t2, reason: 'Panel not free' }, tSA);
    const posted = await until(() => calls.some((x) => x.method === 'POST' && x.path === '/g/cal/calendars/primary/events'));
    const ev = calls.find((x) => x.method === 'POST' && x.path === '/g/cal/calendars/primary/events');
    check('switch ON: the interview goes into the recruiter\'s Google calendar with the right time and title', posted && ev && JSON.parse(ev.body).start.dateTime === t2 && JSON.parse(ev.body).summary.includes(cand.name) && ev.headers.authorization === 'Bearer at-2', ev && ev.body);
    const t3 = new Date(Date.now() + 5 * 86400e3).toISOString();
    await call('POST', `/ats/interviews/${app.id}/reschedule`, { interviewAt: t3, reason: 'Candidate asked' }, tSA);
    const moved = await until(() => calls.some((x) => x.method === 'PUT' && x.path === '/g/cal/calendars/primary/events/gev-1'));
    check('a new time MOVES the same calendar event (no second event)', moved && calls.filter((x) => x.method === 'POST' && x.path === '/g/cal/calendars/primary/events').length === 1);
    const cx = await call('POST', `/ats/interviews/${app.id}/cancel`, { reason: 'Client paused the role' }, tSA);
    const gone = await until(() => calls.some((x) => x.method === 'DELETE' && x.path === '/g/cal/calendars/primary/events/gev-1'));
    const left = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "MktCalPush" WHERE "applicationId" = ?', app.id);
    check('a cancelled interview is taken out of the calendar', cx.status === 200 && gone && Number(left[0].n) === 0, { cx: cx.status, gone, left: Number(left[0].n) });
    const audit = await prisma.auditLog.findFirst({ where: { entityId: app.id, action: 'Interview put in the connected calendars' } });
    check('the push is in the audit trail', !!audit);
  });
  await run('14.05', 'Google Workspace and Microsoft 365 (calendar links, contacts)', async () => {
    await prisma.application.update({ where: { id: app.id }, data: { interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 6 * 86400e3) } });
    const l = await call('GET', `/ats-plus/integrations/calendar-links/${app.id}`, null, tREC);
    check('the interview screen\'s Add to Google / Outlook links', l.status === 200 && l.body.google.startsWith('https://calendar.google.com/') && l.body.outlook.startsWith('https://outlook.office.com/'), l.body);
    check('the button is on the interview tools', fs.readFileSync(path.join(FRONT, 'src', 'components', 'interviews', 'InterviewTools.jsx'), 'utf8').includes('/ats-plus/integrations/calendar-links/'));
    const none = await call('GET', '/ats-plus/calendarz/contacts?provider=google', null, tADM);
    check('contacts before connecting: says to connect first', none.status === 409, none.body);
    await connect(tADM);
    const ct = await call('GET', `/ats-plus/calendarz/contacts?provider=google&q=${encodeURIComponent('zara')}`, null, tADM);
    check('the person\'s own Google contacts are read (People API, stub) and searched', ct.status === 200 && ct.body.contacts.length === 1 && ct.body.contacts[0].email === `zara.${RUN}@client-test.in`, ct.body);
    const use = await call('POST', '/ats-plus/calendarz/contacts/use', { provider: 'google', clientId: client.id, slot: 'primary', contact: ct.body.contacts[0] }, tADM);
    const c2 = await prisma.client.findUnique({ where: { id: client.id } });
    check('Use: the contact becomes the client\'s main contact (through the client\'s own edit route)', use.status === 200 && c2.contactName === `Zara Contact ${RUN}` && c2.contactEmail === `zara.${RUN}@client-test.in`, { use: use.body, name: c2.contactName });
    check('a Manager (view only) cannot read contacts into the ATS', (await call('GET', '/ats-plus/calendarz/contacts?provider=google', null, tMGR)).status === 403);
    const ov = await call('GET', '/ats-plus/integrations/overview', null, tSA);
    check('ATS settings > Google / Microsoft 365 shows the saved app (from the one store)', ov.body.google.clientId === `zt-${RUN}.apps.googleusercontent.com` && ov.body.google.hasSecret === true, ov.body.google);
  });

  // ================================================================ 14.09 / IN-15 background checks
  await run('14.09', 'Background-check vendor connector (stub) - also IN-15', async () => {
    const st0 = await call('GET', '/ats-plus/vendorsz/status', null, tREC);
    check('before the vendor keys: not ready, a Set up link', st0.status === 200 && st0.body.vendors.bgv.ready === false && st0.body.vendors.bgv.setUpLink.includes('channel=ats-bgv'));
    const o0 = await call('POST', '/ats-plus/vendorsz/bgv/order', { applicationId: app.id, consent: true }, tREC);
    check('ordering without a vendor says it needs the founder\'s vendor account', o0.status === 409 && o0.body.needsFounder === true, o0.body);
    const cf = await configure('ats-bgv', { 'Vendor (SpringVerify / AuthBridge / IDfy / OnGrid / Other)': 'SpringVerify', 'API base URL': `${SB}/bgv`, 'API key': 'zt-bgv-key', 'Webhook secret (checks the vendor result calls)': 'whsec-zt', 'Checks to order (comma list)': 'education,employment,criminal' });
    check('the vendor keys are saved in Administration > Integrations', cf.status === 200, cf.body);
    check('no consent ticked: refused (DPDP)', (await call('POST', '/ats-plus/vendorsz/bgv/order', { applicationId: app.id }, tREC)).status === 400);
    check('the BDE team cannot order a check', (await call('POST', '/ats-plus/vendorsz/bgv/order', { applicationId: app.id, consent: true }, tBDE)).status === 403);
    check('a Manager (view only) cannot order', (await call('POST', '/ats-plus/vendorsz/bgv/order', { applicationId: app.id, consent: true }, tMGR)).status === 403);
    const o = await call('POST', '/ats-plus/vendorsz/bgv/order', { applicationId: app.id, consent: true }, tREC);
    const sent = calls.find((x) => x.method === 'POST' && x.path === '/bgv/orders');
    const sb = sent ? JSON.parse(sent.body) : {};
    check('the order reaches the vendor with the candidate, the checks and a callback address, signed with the key', o.status === 201 && o.body.order.status === 'IN_PROGRESS' && o.body.order.externalId === 'BGV-77' && sent.headers.authorization === 'Bearer zt-bgv-key' && sb.candidate.name === cand.name && sb.checks.join(',') === 'education,employment,criminal' && /\/api\/public\/vendorsz\/callback\//.test(sb.callbackUrl), { o: o.body, sb });
    const OB = require('../src/utils/atsOfferBgv');
    const b1 = await OB.bgvOf(app.id);
    check('the candidate\'s BGV card shows the ordered checks In progress, vendor SpringVerify', b1 && b1.vendor === 'SpringVerify' && b1.checks.find((x) => x.key === 'education').status === 'In progress', b1);
    check('a second check while one runs is refused', (await call('POST', '/ats-plus/vendorsz/bgv/order', { applicationId: app.id, consent: true }, tREC)).status === 409);
    const cbPath = new URL(sb.callbackUrl).pathname.replace(/^\/api/, '');
    const result = JSON.stringify({ status: 'completed', checks: [{ type: 'education', status: 'verified' }, { type: 'employment', status: 'clear' }, { type: 'criminal court record', status: 'record_found' }], reportUrl: 'https://vendor.example/r/77' });
    const bad = await call('POST', cbPath, result, null, { 'X-Signature': 'sha256=deadbeef' });
    check('a result call with a wrong signature is refused', bad.status === 401, bad.body);
    const sig = crypto.createHmac('sha256', 'whsec-zt').update(result).digest('hex');
    const good = await call('POST', cbPath, result, null, { 'X-Signature': `sha256=${sig}` });
    const b2 = await OB.bgvOf(app.id);
    check('the signed result comes back ON THE RECORD: education / employment Clear, criminal Discrepancy, overall Discrepancy, the report link', good.status === 200 && b2.checks.find((x) => x.key === 'education').status === 'Clear' && b2.checks.find((x) => x.key === 'criminal').status === 'Discrepancy' && b2.overall === 'Discrepancy' && b2.reportLink === 'https://vendor.example/r/77', b2);
    const list = await call('GET', `/ats-plus/vendorsz/orders?applicationId=${app.id}`, null, tREC);
    check('the order shows Done with the verdict and the consent kept', list.body.rows[0].status === 'DONE' && list.body.rows[0].result.verdict === 'Discrepancy' && list.body.rows[0].consent.by === REC.name, list.body.rows[0]);
    check('a wrong order token is refused', (await call('POST', cbPath.replace(/\/[^/]+$/, '/wrong-token'), result, null, { 'X-Signature': `sha256=${sig}` })).status === 404);
  });
  await run('14.10', 'Assessment vendor connector (stub)', async () => {
    await configure('ats-assessment', { 'Vendor (HackerEarth / Mercer Mettl / iMocha / HackerRank / Other)': 'HackerEarth', 'API base URL': `${SB}/test`, 'API key': 'zt-test-key', 'Webhook secret (checks the vendor result calls)': '' });
    check('no test chosen and no default: refused', (await call('POST', '/ats-plus/vendorsz/assessment/order', { applicationId: app.id }, tREC)).status === 400);
    const o = await call('POST', '/ats-plus/vendorsz/assessment/order', { applicationId: app.id, testId: 'k8s-basics' }, tREC);
    const sent = calls.find((x) => x.method === 'POST' && x.path === '/test/orders');
    check('the test is sent to the vendor (test id, candidate) and its link kept', o.status === 201 && JSON.parse(sent.body).testId === 'k8s-basics' && o.body.order.testUrl === 'https://vendor.example/t/5', o.body);
    const chk = await call('POST', `/ats-plus/vendorsz/orders/${o.body.order.id}/check`, {}, tREC);
    check('Check now reads the score back: Passed 78 / 100', chk.status === 200 && chk.body.order.status === 'DONE' && chk.body.order.result.verdict === 'Passed' && chk.body.order.result.score === 78 && chk.body.order.result.maxScore === 100, chk.body);
    check('a BDE cannot send a test', (await call('POST', '/ats-plus/vendorsz/assessment/order', { applicationId: app.id, testId: 'x' }, tBDE)).status === 403);
    const a = await call('GET', '/ats-plus/apps', null, tSA);
    check('the app catalogue now shows both vendors as Connected', ['ats-bgv', 'ats-assessment'].every((id) => a.body.apps.find((x) => x.id === id).status === 'Connected'), a.body.apps.filter((x) => /ats-(bgv|assessment)/.test(x.id)));
  });

  // ================================================================ 14.15 / IN-03 multiposting + responses
  await run('14.15', 'Job-board multiposting incl. foundit, and responses back (stub) - also IN-03', async () => {
    const JC = require('../src/utils/jobConnectors');
    const ch = await call('GET', '/requirements/posting-sources', null, tSA);
    const fd0 = (ch.body.sources || []).find((x) => x.id === 'foundit');
    check('foundit is a Save & Post source next to Naukri / Shine / Indeed / LinkedIn (needs its partner account)', ch.status === 200 && fd0 && fd0.ready === false && ['naukri', 'shine', 'indeed', 'linkedin'].every((id) => ch.body.sources.some((x) => x.id === id)), ch.body.sources && ch.body.sources.map((x) => `${x.id}:${x.ready}`));
    const cf = await configure('foundit', { 'Recruiter account email': 'hr@zt-test.in', 'API key': 'zt-foundit-key', 'Job endpoint URL': `${SB}/foundit/jobs` });
    check('the foundit partner keys are saved', cf.status === 200, cf.body);
    await prisma.requirement.update({ where: { id: R.id }, data: { postingSources: 'foundit' } });
    process.env.ALLOW_PRIVATE_FETCH = '1'; // the stub board is on this machine (only in this test process)
    await JC.syncAll(R.id, { trigger: 'post', actorName: 'ats-Z-test', only: ['foundit'] });
    delete process.env.ALLOW_PRIVATE_FETCH;
    const row = await prisma.requirementPosting.findFirst({ where: { requirementId: R.id, source: 'foundit' } });
    const sent = calls.find((x) => x.path === '/foundit/jobs');
    check('Save & Post sends the ONE job to foundit (our job id as the reference) and it is Posted with the board\'s id', row && row.status === 'Posted' && row.externalJobId === 'FD-1' && sent && JSON.parse(sent.body).reference === R.id && sent.headers.authorization === 'Bearer zt-foundit-key', { row, sent: sent && sent.body.slice(0, 200) });
    const before = await call('GET', '/ats-plus/board-responses', null, tSA);
    check('responses before the partner keys: every board says not set up, nothing read', before.status === 200 && before.body.boards.every((b) => !b.setUp) && before.body.autoRead === false, before.body.boards);
    await configure('ats-board-pull', { 'Naukri responses URL': `${SB}/naukri/responses`, 'Naukri responses API key': 'zt-naukri-key' });
    check('a recruiter cannot start the read (Admin)', (await call('POST', '/ats-plus/board-responses/read', {}, tREC)).status === 403);
    const rd = await call('POST', '/ats-plus/board-responses/read', {}, tSA);
    const nk = calls.find((x) => x.path === '/naukri/responses');
    check('Read now reads Naukri\'s applicants with the key (2 new)', rd.status === 200 && rd.body.added === 2 && nk.headers.authorization === 'Bearer zt-naukri-key', rd.body);
    const again = await call('POST', '/ats-plus/board-responses/read', {}, tSA);
    check('reading again adds nobody twice', again.body.added === 0, again.body);
    const lr = await call('GET', '/ats-plus/board-responses', null, tREC);
    const mine = lr.body.rows.find((x) => x.name === `Zeta Applicant ${RUN}`);
    const lost = lr.body.rows.find((x) => x.name === `Lost Applicant ${RUN}`);
    check('the recruiter sees the applicant on the job they applied for, with the phone', mine && mine.requirementId === R.id && mine.phone === NK.phone && lost && !lost.requirementId, lr.body.rows.slice(0, 3));
    const lb = await call('GET', '/ats-plus/board-responses', null, tBDE);
    check('the BDE sees the list without phone / e-mail', lb.status === 200 && lb.body.contactHidden === true && lb.body.rows.every((x) => x.phone === null && x.email === null));
    check('a Manager (view only) cannot add one', (await call('POST', `/ats-plus/board-responses/${mine.id}/add`, { skills: 'Kubernetes' }, tMGR)).status === 403);
    check('an applicant for a job not in TeamLink cannot be added to it', (await call('POST', `/ats-plus/board-responses/${lost.id}/add`, { skills: 'x' }, tREC)).status === 400);
    const add = await call('POST', `/ats-plus/board-responses/${mine.id}/add`, { skills: 'Kubernetes, Docker', currentSalary: '6 LPA', expectedSalary: '8 LPA', overrideReason: 'Applied on Naukri for this job' }, tREC);
    const c = add.body.candidateId ? await prisma.candidate.findUnique({ where: { id: add.body.candidateId } }) : null;
    const ap = c ? await prisma.application.findFirst({ where: { candidateId: c.id, requirementId: R.id } }) : null;
    check('Add to ATS: a candidate with source Naukri, on the job (the normal add route)', add.status === 201 && c && c.source === 'Naukri' && !!ap, { add: add.body, source: c && c.source, app: !!ap });
    check('the same response cannot be added twice', (await call('POST', `/ats-plus/board-responses/${mine.id}/add`, { skills: 'x' }, tREC)).status === 404);
    const dm = await call('POST', `/ats-plus/board-responses/${lost.id}/dismiss`, { reason: 'Not our job' }, tREC);
    check('a response is dismissed', dm.status === 200);
    const a = await call('GET', '/ats-plus/apps', null, tSA);
    check('the catalogue shows foundit Connected and the responses Ready (hourly read OFF)', a.body.apps.find((x) => x.id === 'foundit').status === 'Connected' && a.body.apps.find((x) => x.id === 'ats-board-pull').status === 'Ready', a.body.apps.filter((x) => ['foundit', 'ats-board-pull'].includes(x.id)));
  });

  // ================================================================ 15.01 SSO
  await run('15.01', 'Single sign-on: configured in Administration, Test, stub IdP sign-in', async () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const s = await call('PUT', '/ats-plus/sso/settings', { providers: [{ type: 'oidc', name: 'Stub OIDC Z', enabled: true, issuer: `${SB}/oidc`, clientId: 'tl-z', clientSecret: 'stub-secret' }, { type: 'oidc', name: 'Broken Z', enabled: false, issuer: `${SB}/nope`, clientId: 'x' }, { type: 'saml', name: 'Stub SAML Z', enabled: false, entryPoint: `${SB}/saml`, idpCert: pem, spEntityId: 'urn:tl:z' }] }, tSA);
    check('Admin saves an OIDC and a SAML provider', s.status === 200 && s.body.providers.length === 3, s.body);
    const [oidc, broken, saml] = s.body.providers;
    const t1 = await call('POST', `/ats-plus/sso/${oidc.id}/test`, {}, tSA);
    check('Test (OIDC): discovery, the three addresses, the issuer and the signing keys pass', t1.status === 200 && t1.body.ok === true && t1.body.checks.some((c) => c.name === 'Signing keys' && c.ok), t1.body);
    const t2 = await call('POST', `/ats-plus/sso/${broken.id}/test`, {}, tSA);
    check('Test (a wrong issuer): fails and says the discovery document did not answer', t2.status === 200 && t2.body.ok === false && t2.body.checks.some((c) => c.name === 'Discovery document' && !c.ok), t2.body);
    const t3 = await call('POST', `/ats-plus/sso/${saml.id}/test`, {}, tSA);
    check('Test (SAML): the IdP key is readable and the ACS to give the IdP is shown', t3.status === 200 && t3.body.checks.some((c) => c.name === 'IdP certificate' && c.ok) && t3.body.checks.some((c) => /ACS/.test(c.name)), t3.body);
    check('a recruiter cannot test or change SSO', (await call('POST', `/ats-plus/sso/${oidc.id}/test`, {}, tREC)).status === 403);
    const st = await call('GET', `/sso/${oidc.id}/start?json=1`, null, null);
    const au = new URL(st.body.url);
    idp.nonce = au.searchParams.get('nonce'); idp.email = SA.email;
    const fin = await call('POST', '/sso/oidc/finish', { code: 'abc', state: au.searchParams.get('state') }, null);
    check('a stub IdP sign-in finishes with a normal TeamLink session', fin.status === 200 && fin.body.token && fin.body.user, fin.body);
    idp.email = `nobody.${RUN}@nowhere-test.in`;
    check('an IdP e-mail with no TeamLink login is refused', (await call('POST', '/sso/oidc/finish', { code: 'abc', state: au.searchParams.get('state') }, null)).status === 403);
    await call('PUT', '/ats-plus/sso/settings', { providers: [] }, tSA);
  });

  // ================================================================ 15.11 / IN-14 / 15.16 region and SLA evidence
  await run('15.11', 'Data region / hosting and SLA: settings and evidence pages - also IN-14 / 15.16', async () => {
    const e = await call('GET', '/ats-plus/evidencez', null, tSA);
    check('the page shows the stated region beside what the server sees (time zone, backups, off-site copy)', e.status === 200 && e.body.stated.region && e.body.seen.timeZone && e.body.seen.offsite.set === true && e.body.seen.offsite.region === 'us-east-1', e.body.seen);
    check('a US off-site region against a stated India region is flagged', e.body.flags.some((f) => /us-east-1/.test(f)), e.body.flags);
    check('six months of uptime against the target', e.body.sla.months.length === 6 && e.body.sla.months.every((m) => 'uptimePct' in m && 'met' in m), e.body.sla.months);
    check('the documents still missing are listed', e.body.missing.includes('Hosting region') && e.body.missing.includes('SLA contract'), e.body.missing);
    check('a recruiter cannot add evidence', (await call('POST', '/ats-plus/evidencez/items', { kind: 'Hosting region', title: 'x x x' }, tREC)).status === 403);
    check('a link that is not https is refused', (await call('POST', '/ats-plus/evidencez/items', { kind: 'Hosting region', title: 'Provider invoice', link: 'javascript:alert(1)' }, tSA)).status === 400);
    const it = await call('POST', '/ats-plus/evidencez/items', { kind: 'Hosting region', title: `VPS invoice, data centre Mumbai ${RUN}`, link: 'https://provider.example/invoice/1', docDate: '2026-11-01' }, tSA);
    await call('POST', '/ats-plus/evidencez/items', { kind: 'SLA contract', title: `Signed SLA ${RUN}`, link: 'https://docs.example/sla.pdf' }, tSA);
    check('evidence documents are added', it.status === 201);
    const c1 = await call('POST', '/ats-plus/evidencez/confirm', { what: 'residency' }, tADM);
    check('an Admin who is not the Super Admin cannot confirm the region', c1.status === 403, c1.body);
    const c2 = await call('POST', '/ats-plus/evidencez/confirm', { what: 'sla' }, tSA);
    const c3 = await call('POST', '/ats-plus/evidencez/confirm', { what: 'residency' }, tSA);
    check('the Super Admin (founder) confirms the SLA and the region; who / when is kept with how many documents back it', c2.status === 200 && c2.body.sla.by === SA.name && c3.body.residency.evidence >= 1, c3.body);
    const pub = await fetch(`${API}/public/sla-history`).then((r) => r.json());
    check('the public SLA page shows the months and that the founder committed to it', pub.months.length === 6 && pub.committed && pub.committed.by === 'the company founder', pub);
    const pack = await fetch(`${API}/ats-plus/evidencez/pack`, { headers: { Authorization: `Bearer ${tSA}` } });
    const html = await pack.text();
    check('the evidence pack downloads as one page with the region, the server facts, the months, the documents and the founder confirmation', pack.status === 200 && /attachment/.test(pack.headers.get('content-disposition') || '') && html.includes('Data region and SLA evidence') && html.includes(`VPS invoice, data centre Mumbai ${RUN}`) && html.includes('us-east-1') && !html.includes('ats-z-test-backup-passphrase'), html.slice(0, 200));
    check('a recruiter cannot download the pack', (await fetch(`${API}/ats-plus/evidencez/pack`, { headers: { Authorization: `Bearer ${tREC}` } })).status === 403);
  });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); console.log(`\n${total - failed}/${total + 1} passed`); await stop(1); });
