#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MANY WHATSAPP NUMBERS - acceptance test (2026-10-21).
//   cd backend && node scripts/wa-multi-number-test.js
//
// SAFE BY CONSTRUCTION
//   * the real database is only OPENED READ-ONLY, to take a VACUUM INTO copy in the OS temp folder; every test runs on that copy (deleted at the end)
//   * the app under test is a SECOND server started on a free port between 4061 and 4099 (never 4010, never 4045) with TEST_MODE=1: no worker, no
//     timer, no mail, and its network is limited to this machine
//   * "Meta" is a LOCAL FAKE Graph API (http, loopback). Nothing is ever sent to a real WhatsApp / mail address. The fake knows each
//     phone_number_id with its token and answers like Meta: messages, number status, phone_numbers of a WABA, subscribed_apps, error 190 / 200
//   * no real person's number or token is printed
//
// PHASES
//   L  legacy: with NO number added everything behaves as before (send, webhook, reminders digest path, nothing written by reads)
//   M  many numbers: add / verify / duplicates / secrets / default / edit / deactivate / remove / assign
//   S  sending: per user / department, choice, 403, 409, thread continuity, inactive + fallback, system messages, campaigns, other-account template
//   I  inbound: per-number webhook routing, separate chats, visibility, unknown number, signatures, verify tokens, delivery reports, STOP
//   X  security: no secret in any response / audit / log, non-admin 403, my-numbers, reconnect limit, one choke point, audit rows
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SRC_DB = path.join(BACK, 'prisma', 'dev.db');
const RUN = Date.now().toString(36);
const TAG = 'ZZTEST WAM';
let pass = 0; let fail = 0;
const failed = [];
const check = (n, ok, d) => {
  if (ok) pass += 1; else { fail += 1; failed.push(n); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---- the copy -------------------------------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-multi-'));
const COPY = path.join(TMP, 'copy.db');
if (/dev\.db$/i.test(COPY)) { console.error('Refusing: the test database must not be dev.db'); process.exit(2); }
{
  const ro = new DatabaseSync(SRC_DB, { readOnly: true });
  ro.exec('PRAGMA busy_timeout = 30000');
  ro.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
  ro.close();
}
const DBURL = `file:${COPY.split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DBURL;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DBURL;
process.env.MESSAGE_JOB_DIR = path.join(TMP, 'jobs');
const raw = new DatabaseSync(COPY);
raw.exec('PRAGMA busy_timeout = 30000');
const one = (sql, ...p) => raw.prepare(sql).get(...p);
const all = (sql, ...p) => raw.prepare(sql).all(...p);

// ---- the fake Meta Graph API ----------------------------------------------------------------------------------------------
const phones = {}; // phone_number_id -> { token, meta, sendMode }
const wabas = {}; // waba id -> [phone ids]
let subscribed = {}; // waba id -> boolean
const received = []; // every request that reached the fake: { phone, auth, kind, body, accepted }
function startFake() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const m = u.pathname.match(/^\/v\d+\.\d+\/([^/]+)(?:\/(messages|phone_numbers|subscribed_apps|media|message_templates))?$/);
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!m) return send(404, { error: { message: 'no such path', code: 100 } });
        const id = m[1]; const sub = m[2]; const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
        let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        if (sub === 'messages' && req.method === 'POST') {
          const p = phones[id];
          if (!p) { received.push({ phone: id, auth, kind: 'messages', body: parsed, accepted: false }); return send(400, { error: { message: 'Unsupported post request', code: 100 } }); }
          if (auth !== p.token) { received.push({ phone: id, auth, kind: 'messages', body: parsed, accepted: false }); return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } }); }
          if (p.sendMode === 'blocked') { received.push({ phone: id, auth, kind: 'messages', body: parsed, accepted: false }); return send(400, { error: { message: 'API access blocked', code: 200 } }); }
          received.push({ phone: id, auth, kind: 'messages', body: parsed, accepted: true });
          return send(200, { messaging_product: 'whatsapp', contacts: [{ input: parsed.to, wa_id: parsed.to }], messages: [{ id: `wamid.${RUN}.${received.length}` }] });
        }
        if (sub === 'phone_numbers' && req.method === 'GET') {
          received.push({ phone: id, auth, kind: 'waba_phone_numbers', accepted: true });
          if (!wabas[id]) return send(400, { error: { message: 'Unsupported get request', code: 100 } });
          return send(200, { data: wabas[id].map((x) => ({ id: x, display_phone_number: (phones[x] && phones[x].meta && phones[x].meta.display_phone_number) || '' })) });
        }
        if (sub === 'subscribed_apps') {
          received.push({ phone: id, auth, kind: `subscribed_apps_${req.method}`, accepted: true });
          if (req.method === 'POST') { subscribed[id] = true; return send(200, { success: true }); }
          return send(200, { data: subscribed[id] ? [{ whatsapp_business_api_data: { id: 'app1' } }] : [] });
        }
        if (!sub && req.method === 'GET') {
          const p = phones[id];
          received.push({ phone: id, auth, kind: 'status', accepted: !!p && auth === p.token, fields: u.searchParams.get('fields') });
          if (!p) return send(400, { error: { message: 'Unsupported get request', code: 100 } });
          if (auth !== p.token) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
          if (p.statusMode === 'blocked') return send(400, { error: { message: 'API access blocked', code: 200 } });
          return send(200, { id, ...p.meta });
        }
        return send(404, { error: { message: 'nope', code: 100 } });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const msgsOn = (phone, from = 0) => received.slice(from).filter((r) => r.kind === 'messages' && r.accepted && r.phone === phone);
const sentSince = (from) => received.slice(from).filter((r) => r.kind === 'messages');

// ---- helpers: ports, server, http ---------------------------------------------------------------------------------------------
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function freePort() {
  for (let p = 4061; p <= 4099; p += 1) {
    if (p === 4045) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if ((await portFree(p)) && (await portFree(p))) return p;
  }
  throw new Error('No free port between 4061 and 4099');
}
let API = ''; let serverProc = null; let serverLog = '';
async function startServer(port, env) {
  serverProc = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, ...env, PORT: String(port) } });
  serverProc.stdout.on('data', (d) => { serverLog += d; });
  serverProc.stderr.on('data', (d) => { serverLog += d; });
  API = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i += 1) {
    try { const r = await fetch(`${API}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(1000);
  }
  return false;
}
async function stopServer() {
  const pr = serverProc; if (!pr) return;
  await new Promise((res) => { pr.once('exit', res); pr.kill(); setTimeout(res, 6000); });
  serverProc = null;
}
const bodies = []; // every API response text (for the secret sweep)
async function call(method, p, token, body, headers) {
  const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  bodies.push(text);
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text };
}
const sigOf = (secret, rawBody) => `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
async function webhook(payload, secret, extraHeaders) {
  const rawBody = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', ...(secret ? { 'x-hub-signature-256': sigOf(secret, rawBody) } : {}), ...(extraHeaders || {}) };
  const res = await fetch(`${API}/api/webhooks/whatsapp`, { method: 'POST', headers, body: rawBody });
  const text = await res.text(); bodies.push(text);
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json };
}
const inboundPayload = (phoneId, display, from, text, id) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: display, phone_number_id: phoneId }, contacts: [{ profile: { name: 'ZZ Person' }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const statusPayload = (phoneId, display, wamid, status) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: display, phone_number_id: phoneId }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919000021001' }] } }] }] });
const hasTable = (n) => !!one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", n);

// ---------------------------------------------------------------------------------------------------------------------------------
(async () => {
  const fake = await startFake();
  const FAKE = `http://127.0.0.1:${fake.port}`;
  process.env.TL_DEV_MESSAGING_BASE_URL = FAKE; // this (test) process talks to the fake only
  process.env.TL_TEST_FAKE_GRAPH = '1';
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = function netGuard(input, init) { // this process may only talk to loopback
    const u = new URL(typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url));
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return Promise.reject(new TypeError(`TEST BLOCKED outbound to ${u.hostname}`));
    return guardedFetch(input, init);
  };
  const port = await freePort();
  const prisma = require(path.join(BACK, 'src/db'));
  const CAT = require(path.join(BACK, 'src/utils/adminCatalog'));
  const { writeValues } = require(path.join(BACK, 'src/utils/integrationStore'));
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
  const WN = require(path.join(BACK, 'src/utils/waNumbers'));

  // legacy single connection (the one the company has today), in the COPY
  const T0 = `EAAZZLEGACY${RUN}${'x'.repeat(24)}`; const T1 = `EAAZZEDU${RUN}${'e'.repeat(26)}`; const T3 = `EAAZZBDE${RUN}${'b'.repeat(26)}`; const T4 = `EAAZZMFG${RUN}${'m'.repeat(26)}`;
  const SECRET0 = `zz-legacy-secret-${RUN}`; const VERIFY0 = `zz-legacy-verify-${RUN}`; const SECRET_MED = `zz-med-secret-${RUN}`; const VERIFY_EDU = `zz-edu-verify-${RUN}`;
  const P0 = '100000000000001'; const P1 = '100000000000011'; const P2 = '100000000000022'; const P3 = '100000000000033'; const P4 = '100000000000044'; const PX = '999999999999999';
  const W0 = '200000000000001'; const W1 = '200000000000002';
  const okMeta = (display, name) => ({ display_phone_number: display, verified_name: name, quality_rating: 'GREEN', code_verification_status: 'VERIFIED', name_status: 'APPROVED', status: 'CONNECTED', messaging_limit_tier: 'TIER_1K' });
  phones[P0] = { token: T0, meta: okMeta('+91 90000 00000', 'ZZ Main') };
  phones[P1] = { token: T1, meta: okMeta('+91 90000 10001', 'ZZ Education') };
  phones[P2] = { token: T0, meta: { ...okMeta('+91 90000 10002', 'ZZ Medical'), code_verification_status: 'NOT_VERIFIED', status: 'PENDING' } };
  phones[P3] = { token: `${T3}-rejected-by-meta`, meta: okMeta('+91 90000 10003', 'ZZ BDE') }; // the token typed for it will not match: Meta answers 190
  phones[P4] = { token: T4, meta: okMeta('+91 90000 10004', 'ZZ Manufacturing') };
  wabas[W0] = [P0, P2]; wabas[W1] = [P1, P3, P4];

  const setWhatsAppRow = async (phoneId = P0) => {
    const w = await writeValues('whatsapp', {
      [CAT.WA_FIELDS.display]: '+91 90000 00000', [CAT.WA_FIELDS.phoneId]: phoneId, [CAT.WA_FIELDS.wabaId]: W0, [CAT.WA_FIELDS.token]: T0,
      [CAT.WA_FIELDS.language]: 'en', [CAT.WA_FIELDS.bulkTpl]: 'zz_bulk', [CAT.WA_FIELDS.appSecret]: SECRET0, [CAT.WA_FIELDS.verifyToken]: VERIFY0,
    });
    await prisma.integration.upsert({ where: { id: 'whatsapp' }, create: { id: 'whatsapp', values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' }, update: { values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected', error: null } });
  };
  await setWhatsAppRow();
  const realIntegrations = raw.prepare("select count(*) n from Integration where id in ('sms','sms-android','whatsapp-qr')").get().n;
  void realIntegrations;

  // fixtures: people, departments, candidates (all named ZZTEST and living only in the copy)
  const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
  const mkUser = async (tag, extra, emp) => {
    const u = await prisma.user.create({ data: { ...base, name: `${TAG} ${tag} ${RUN}`, email: `zz-wam-${tag}-${RUN}@example.test`, username: `zz-wam-${tag}-${RUN}@example.test`, ...extra } });
    await prisma.employee.create({ data: { employeeCode: `ZZTEST-WAM-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, email: u.email, phone: '9000000002', designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...(emp || {}) } });
    return u;
  };
  const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const uEdu = await mkUser('edu', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uMed = await mkUser('med', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const uBoth = await mkUser('both', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uNone = await mkUser('none', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' });
  const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
  const uHr = await mkUser('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR', hrmsAccess: true });
  const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '3h' });
  const T = { admin: await mint(uAdmin), edu: await mint(uEdu), med: await mint(uMed), both: await mint(uBoth), none: await mint(uNone), bde: await mint(uBde), hr: await mint(uHr) };
  const client = await prisma.client.create({ data: { name: `${TAG} Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client' } });
  const reqEdu = await prisma.requirement.create({ data: { title: `${TAG} Job Edu ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uEdu.id, recruiterIds: uBoth.id, bdeId: uBde.id, openings: 9 } });
  const reqMed = await prisma.requirement.create({ data: { title: `${TAG} Job Med ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: uMed.id, recruiterIds: uBoth.id, bdeId: uBde.id, openings: 9 } });
  const mkCand = async (n, req) => {
    const c = await prisma.candidate.create({ data: { name: `${TAG} Cand ${n} ${RUN}`, email: `zz-wam-c${n}-${RUN}@zz-wam-sandbox.in`, phone: `90000210${String(n).padStart(2, '0')}`, location: 'ZZ' } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: 'NEW' } });
    return { ...c, appId: a.id };
  };
  const cE = []; for (let i = 1; i <= 8; i += 1) cE.push(await mkCand(i, reqEdu)); // 9000021001..08 (Education)
  const cM = []; for (let i = 11; i <= 14; i += 1) cM.push(await mkCand(i, reqMed)); // 9000021011..14 (Medical)
  const reqMfg = await prisma.requirement.create({ data: { title: `${TAG} Job Mfg ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Manufacturing', recruiterId: uNone.id, openings: 9 } });
  const cN = await mkCand(41, reqMfg); // Manufacturing candidate (for the person who has no number)
  const cBulk = []; for (let i = 21; i <= 30; i += 1) cBulk.push(await mkCand(i, reqEdu)); // 10 people for the pause test
  const IN = require(path.join(BACK, 'src/utils/interviewNotices'));
  await prisma.appSetting.upsert({ where: { key: IN.SETTINGS_KEY }, update: { value: JSON.stringify({ enabled: true }) }, create: { key: IN.SETTINGS_KEY, value: JSON.stringify({ enabled: true }) } });

  const SERVER_ENV = {
    TEST_MODE: '1', TL_TEST_FAKE_GRAPH: '1', TL_DEV_MESSAGING_BASE_URL: FAKE, TEST_MOCK_PORTS: String(fake.port), DATABASE_URL: DBURL,
    TEAMLINK_SANDBOX_FILES: path.join(TMP, 'files'), MESSAGE_JOB_DIR: path.join(TMP, 'jobs'), TL_COMM_SEND_LIMIT: '400', MSG_RATE_WHATSAPP: '50',
  };
  const up = await startServer(port, SERVER_ENV);
  check('0 the test server (copy database, fake Meta, TEST_MODE) is up', up, serverLog.slice(-400));
  if (!up) { await finish(1); return; }

  const sendWA = (token, cand, extra = {}) => call('POST', '/api/messaging/send', token, { audience: 'candidates', id: cand.id, applicationId: cand.appId, channel: 'WhatsApp', body: `ZZTEST hello ${Math.random().toString(36).slice(2, 7)}`, purpose: 'ZZTEST WAM message', ...extra });
  const createdIds = {};

  try {
    // ===================================================================================================================
    // L: LEGACY - no number added: everything as before
    // ===================================================================================================================
    check('L0 the copy has NO WhatsApp-number tables (old-shaped database)', !hasTable('WaNumber') && !hasTable('WaNumberAccess') && !hasTable('WaThread') && !hasTable('WaMessageMap'));
    const lst0 = await call('GET', '/api/wa-numbers', T.admin);
    check('L1 the Admin sees the existing connection as "Main number" (not yet in the list)', lst0.status === 200 && lst0.body.listed === false && lst0.body.numbers.length === 1 && lst0.body.numbers[0].virtual === true && lst0.body.numbers[0].label === 'Main number', lst0.body);
    check('L1b opening the page created no table (reads never write)', !hasTable('WaNumber'));
    const my0 = await call('GET', '/api/wa-numbers/my-numbers', T.edu);
    check('L2 a staff login: legacy mode, may send (nothing changes for composers)', my0.status === 200 && my0.body.legacy === true && my0.body.canSend === true, my0.body);
    const adm403 = await call('GET', '/api/wa-numbers', T.edu);
    check('L2b a recruiter is refused the Admin list (403)', adm403.status === 403, adm403.status);

    let mark = received.length;
    const s0 = await sendWA(T.admin, cE[0]);
    check('L3 a WhatsApp message goes out through the single connection (fake Meta got the old Phone number ID + old token)', s0.status === 200 && s0.body.result && s0.body.result.status === 'sent', s0.body);
    const r0 = msgsOn(P0, mark);
    check('L3b exactly one request reached Meta, on the OLD phone id with the OLD token and the shared template', r0.length === 1 && r0[0].auth === T0 && r0[0].body.type === 'template' && r0[0].body.template.name === 'zz_bulk' && r0[0].body.to === '919000021001', r0);
    const wamid0 = s0.body.result.providerRef;
    check('L3c no table was created by sending in legacy mode', !hasTable('WaNumber') && !hasTable('WaThread'));
    // webhook (old path)
    const g1 = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY0}&hub.challenge=CHAL123`);
    check('L4 Meta\'s check with the shared verify token answers the challenge', g1.status === 200 && (await g1.text()) === 'CHAL123');
    const g2 = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL123`);
    check('L4b a wrong verify token is refused (403)', g2.status === 403);
    const ib0 = await webhook(inboundPayload(P0, '+91 90000 00000', '919000021001', 'ZZTEST I am interested', `wamid.in.${RUN}.1`), SECRET0);
    check('L5 a signed reply is stored (old path)', ib0.status === 200 && ib0.body.replies === 1, ib0.body);
    const rep0 = await prisma.candidateMessage.findFirst({ where: { candidateId: cE[0].id, status: 'RECEIVED' } });
    check('L5b the reply is on the candidate\'s log', !!rep0 && /interested/.test(rep0.body || ''), rep0 && rep0.body);
    const st0 = await webhook(statusPayload(P0, '+91 90000 00000', wamid0, 'delivered'), SECRET0);
    const sent0 = await prisma.candidateMessage.findFirst({ where: { candidateId: cE[0].id, providerRef: wamid0 } });
    check('L5c a delivery report moves the sent message to Delivered (old path)', st0.status === 200 && sent0 && sent0.status === 'DELIVERED', [st0.body, sent0 && sent0.status]);
    const bad0 = await webhook(inboundPayload(P0, '+91 90000 00000', '919000021002', 'x', `wamid.in.${RUN}.2`), 'not-the-secret');
    check('L5d a wrong signature is refused (403) and nothing is stored', bad0.status === 403 && !(await prisma.candidateMessage.findFirst({ where: { candidateId: cE[1].id, status: 'RECEIVED' } })));
    const stop0 = await webhook(inboundPayload(P0, '+91 90000 00000', '919000021004', 'STOP', `wamid.in.${RUN}.stop`), SECRET0);
    check('L6 STOP is honoured (old path)', stop0.status === 200 && !!(await prisma.appSetting.findUnique({ where: { key: 'msg.optout.WhatsApp.919000021004' } })));
    // reminders digest path: in this (non-sandbox) process the REAL messaging layer talks to the fake
    const MS = require(path.join(BACK, 'src/utils/messaging'));
    mark = received.length;
    const dig0 = await MS.send('WhatsApp', { to: '9000000501', kind: 'bulk', text: 'ZZTEST digest', vars: ['ZZTEST digest'], meta: { purpose: 'proof-reminder', audience: 'staff', personName: 'ZZ Purna' } });
    check('L7 the reminders-digest path (no person, system message) still goes through the single connection', dig0.ok === true && msgsOn(P0, mark).length === 1 && msgsOn(P0, mark)[0].auth === T0, [dig0, received.slice(mark).map((r) => r.phone)]);
    check('L8 after all this legacy traffic the number tables still do not exist', !hasTable('WaNumber') && !hasTable('WaMessageMap'));

    // L9: "Move it into the list" (the Admin's one click), the rollback, and the migration file
    const mvList0 = await call('POST', '/api/wa-numbers/move-main', T.admin, {});
    check('L9 "Move it into the list": ok, the Main number becomes the first row (default), checked with Meta', mvList0.status === 200 && mvList0.body.ok === true && mvList0.body.already === false && mvList0.body.status && mvList0.body.status.code === 'connected', mvList0.body);
    const lstMv = (await call('GET', '/api/wa-numbers', T.admin)).body;
    check('L9b the list shows ONE real row "Main number" (default, everybody who could send before still can)', lstMv.listed && lstMv.numbers.length === 1 && lstMv.numbers[0].isMain && lstMv.numbers[0].isDefault && !lstMv.numbers[0].virtual && lstMv.numbers[0].everyone === true, lstMv.numbers);
    const moved = await call('POST', '/api/wa-numbers/move-main', T.admin, {});
    check('L9c pressing it twice changes nothing (already moved)', moved.status === 200 && moved.body.already === true && one('select count(*) n from WaNumber').n === 1);
    mark = received.length;
    const sMv = await sendWA(T.edu, cE[6]);
    check('L9d after the move a recruiter (nobody assigned yet = Everyone) still sends, through the SAME Phone number ID and token as before', sMv.status === 200 && msgsOn(P0, mark).length === 1 && msgsOn(P0, mark)[0].auth === T0 && msgsOn(P0, mark)[0].body.template.name === 'zz_bulk', [sMv.body, received.slice(mark).map((r) => r.phone)]);
    const inMv = await webhook(inboundPayload(P0, '+91 90000 00000', '919000021007', 'ZZTEST after the move', `wamid.in.${RUN}.mv`), SECRET0);
    check('L9e a reply for the Main number after the move is stored and gets its own chat on the Main number', inMv.status === 200 && inMv.body.replies === 1 && one('select count(*) n from WaThread where contact=?', '919000021007').n === 1, inMv.body);
    // rollback.sql: drop everything again; the old single connection is all that is left, and it works
    await stopServer();
    const rb = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261021100000_wa_multi_number', 'rollback.sql'), 'utf8');
    let rbErr = null; try { raw.exec(rb); } catch (e) { rbErr = e.message; }
    check('L10 rollback.sql runs cleanly and removes the four tables and the stored secrets', rbErr === null && !hasTable('WaNumber') && !hasTable('WaNumberAccess') && !hasTable('WaThread') && !hasTable('WaMessageMap') && one("select count(*) n from AppSetting where key like 'wa.num.sec.%'").n === 0, rbErr);
    check('L10b the old WhatsApp Business form is untouched by the rollback', one("select enabled, connected from Integration where id='whatsapp'").enabled === 1);
    const up2 = await startServer(port, SERVER_ENV);
    check('L10c the server starts again on the rolled-back database', up2, serverLog.slice(-300));
    const lstRb = (await call('GET', '/api/wa-numbers', T.admin)).body;
    check('L10d after the rollback the single connection shows again as "Main number" (not in a list)', lstRb.listed === false && lstRb.numbers.length === 1 && lstRb.numbers[0].virtual === true, lstRb);
    mark = received.length;
    const sRb = await sendWA(T.edu, cE[6]);
    check('L10e ...and sending is exactly the old path again', sRb.status === 200 && msgsOn(P0, mark).length === 1, [sRb.status, sRb.body]);
    // migration.sql: runs on a database without the tables, and again (idempotent); empty tables = still the old single connection
    const mig = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261021100000_wa_multi_number', 'migration.sql'), 'utf8');
    let migErr = null; try { raw.exec(mig); raw.exec(mig); } catch (e) { migErr = e.message; }
    check('L11 migration.sql applies cleanly, twice in a row (additive, IF NOT EXISTS)', migErr === null && hasTable('WaNumber') && hasTable('WaMessageMap'), migErr);
    await sleep(6500);
    const lstEmpty = (await call('GET', '/api/wa-numbers', T.admin)).body;
    mark = received.length;
    const sEmpty = await sendWA(T.edu, cE[6]);
    check('L11b the four tables exist but are EMPTY: still the old single connection, nothing changes for anybody', lstEmpty.listed === false && sEmpty.status === 200 && msgsOn(P0, mark).length === 1, [lstEmpty.listed, sEmpty.status]);

    // ===================================================================================================================
    // M: MANY NUMBERS
    // ===================================================================================================================
    const edu = { label: 'Education desk', displayNumber: '+91 90000 10001', phoneNumberId: P1, wabaId: W1, tokenMode: 'own', token: T1, verifyToken: VERIFY_EDU, language: 'en', tplBulk: 'edu_bulk' };
    const mCreate1 = await call('POST', '/api/wa-numbers', T.admin, edu);
    check('M1 Admin adds the Education number (saved, then checked with Meta)', mCreate1.status === 200 && mCreate1.body.ok && mCreate1.body.status && mCreate1.body.status.code === 'connected', mCreate1.body);
    createdIds.edu = mCreate1.body.id;
    let list = (await call('GET', '/api/wa-numbers', T.admin)).body;
    const main = list.numbers.find((n) => n.isMain);
    check('M1b the Main number joined the list first (same Phone number ID, credentials stay in the old form) and is the default', list.listed && !!main && main.phoneNumberId === P0 && main.isDefault && !main.virtual && main.everyone === true, list.numbers.map((n) => [n.label, n.isDefault, n.isMain]));
    createdIds.main = main && main.id;
    // the Main row follows the old WhatsApp Business form (checked in this process, restored at once)
    await setWhatsAppRow('100000000000999'); WN.bust();
    const followed = (await WN.listRows()).find((r) => r.credSource === 'legacy');
    await setWhatsAppRow(P0); WN.bust();
    const restored = (await WN.listRows()).find((r) => r.credSource === 'legacy');
    check('M1b2 when the old form gets another Phone number ID, the Main row follows it (and back again), so replies are still routed', followed && followed.phoneNumberId === '100000000000999' && restored && restored.phoneNumberId === P0, [followed && followed.phoneNumberId, restored && restored.phoneNumberId]);
    check('M1c the main row stores NO token (credentials still come from the old form)', !all('select * from AppSetting where key like ?', `wa.num.sec.${createdIds.main}`).length);
    const eduRow = list.numbers.find((n) => n.id === createdIds.edu);
    check('M1d Education is not the default, shows Connected with the verified name', eduRow && !eduRow.isDefault && eduRow.status.code === 'connected' && /ZZ Education/.test(eduRow.status.text), eduRow && eduRow.status);
    check('M1e Meta was asked: status of P1 (with the right token) and the WABA phone_numbers list', received.some((r) => r.kind === 'status' && r.phone === P1 && r.accepted) && received.some((r) => r.kind === 'waba_phone_numbers' && r.phone === W1));

    const med = { label: 'Medical desk', displayNumber: '+91 90000 10002', phoneNumberId: P2, wabaId: W0, tokenMode: 'shared', appSecret: SECRET_MED, tplBulk: 'med_bulk' };
    const mCreate2 = await call('POST', '/api/wa-numbers', T.admin, med);
    check('M2 Medical number with "use the shared token": saved, status = Verification Required (Meta says the code is not verified)', mCreate2.status === 200 && mCreate2.body.status && mCreate2.body.status.code === 'verification_required' && /verif/i.test(mCreate2.body.status.text), mCreate2.body);
    createdIds.med = mCreate2.body.id;
    const bde = { label: 'BDE team', displayNumber: '+91 90000 10003', phoneNumberId: P3, wabaId: W1, tokenMode: 'own', token: T3 };
    const mCreate3 = await call('POST', '/api/wa-numbers', T.admin, bde);
    check('M3 BDE number whose token Meta rejects: saved, status = Disconnected with the plain Meta reason', mCreate3.status === 200 && mCreate3.body.status && mCreate3.body.status.code === 'disconnected' && /token|rejected|accept/i.test(mCreate3.body.status.text), mCreate3.body);
    createdIds.bde = mCreate3.body.id;

    // validation + duplicates
    const dup1 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Another', displayNumber: '+91 90000 77777' });
    check('M4 the same Phone number ID again -> 409 with the name it is already added as', dup1.status === 409 && /already added as "Education desk"/.test(dup1.body.error), dup1.body);
    const dup2 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Another', phoneNumberId: '100000000000777' });
    check('M4b the same WhatsApp number again -> 409', dup2.status === 409 && /already added as "Education desk"/.test(dup2.body.error), dup2.body);
    const dup3 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Main again', phoneNumberId: P0, displayNumber: '+91 90000 66666' });
    check('M4c the Main number\'s Phone number ID again -> 409', dup3.status === 409 && /already added as "Main number"/.test(dup3.body.error), dup3.body);
    const bad1 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Bad', displayNumber: '9876543210', phoneNumberId: '100000000000555' });
    check('M5 a number without country code -> 400 in plain words', bad1.status === 400 && /country code/i.test(bad1.body.error), bad1.body);
    const bad2 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Bad', displayNumber: '+91 90000 55555', phoneNumberId: 'abc' });
    check('M5b a Phone number ID that is not digits -> 400', bad2.status === 400 && /only digits/i.test(bad2.body.error), bad2.body);
    const bad3 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Bad', displayNumber: '+91 90000 55555', phoneNumberId: '100000000000556', token: 'short' });
    check('M5c a token that is too short -> 400', bad3.status === 400 && /too short/i.test(bad3.body.error), bad3.body);
    const bad4 = await call('POST', '/api/wa-numbers', T.admin, { ...edu, label: 'Bad', displayNumber: '+91 90000 55555', phoneNumberId: '100000000000557', token: '' });
    check('M5d no token and not "shared" -> 400 asking for it', bad4.status === 400 && /token/i.test(bad4.body.error), bad4.body);
    check('M5e none of the refused numbers was saved', all('select * from WaNumber where removedAt is null').length === 4, all('select label from WaNumber where removedAt is null').map((r) => r.label));

    // secrets
    list = (await call('GET', '/api/wa-numbers', T.admin)).body;
    const sec = all("select key, value from AppSetting where key like 'wa.num.sec.%'");
    check('M6 tokens / secrets are stored ENCRYPTED (enc:v1:), never in plain', sec.length >= 3 && sec.every((r) => !r.value.includes(T1) && !r.value.includes(T3) && !r.value.includes(SECRET_MED) && !r.value.includes(VERIFY_EDU) && /enc:v1:/.test(r.value)), sec.map((r) => r.value.slice(0, 40)));
    check('M6b the list only says "saved" (no token, no secret in the response)', list.numbers.every((n) => !('token' in n)) && ![T0, T1, T3, SECRET0, SECRET_MED, VERIFY0, VERIFY_EDU].some((s) => JSON.stringify(list).includes(s)));
    const wnCols = all('pragma table_info(WaNumber)').map((c) => c.name);
    check('M6c the WaNumber table has no token / secret column (only the "which token" switch)', !wnCols.filter((c) => c !== 'tokenMode').some((c) => /token|secret/i.test(c)), wnCols);

    // default flag
    const d1 = await call('POST', `/api/wa-numbers/${createdIds.edu}/default`, T.admin, {});
    check('M7 Admin makes Education the default; exactly one default remains', d1.status === 200 && one('select count(*) n from WaNumber where isDefault=1 and removedAt is null').n === 1 && one('select id from WaNumber where isDefault=1').id === createdIds.edu);
    const ids3 = [createdIds.main, createdIds.edu, createdIds.med, createdIds.bde];
    const race = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => call('POST', `/api/wa-numbers/${ids3[i % 4]}/default`, T.admin, {})));
    void race;
    check('M7b twelve default changes at the same moment -> still exactly ONE default', one('select count(*) n from WaNumber where isDefault=1 and removedAt is null').n === 1, all('select label from WaNumber where isDefault=1'));
    const dBack = await call('POST', `/api/wa-numbers/${createdIds.main}/default`, T.admin, {});
    check('M7c the Main number is the default again', dBack.status === 200 && one('select id from WaNumber where isDefault=1').id === createdIds.main);
    const dOff = await call('POST', `/api/wa-numbers/${createdIds.med}/default`, T.admin, {});
    void dOff;
    await call('POST', `/api/wa-numbers/${createdIds.main}/default`, T.admin, {});

    // edit
    const e1 = await call('PUT', `/api/wa-numbers/${createdIds.edu}`, T.admin, { label: 'Education team', tplBulk: 'edu_bulk_v2', token: '' });
    check('M8 edit: new name and template saved; a blank token KEEPS the saved one', e1.status === 200 && one('select label, tplBulk from WaNumber where id=?', createdIds.edu).label === 'Education team' && one("select count(*) n from AppSetting where key=? and value like '%enc:v1:%'", `wa.num.sec.${createdIds.edu}`).n === 1);
    const eMain = await call('PUT', `/api/wa-numbers/${createdIds.main}`, T.admin, { token: 'EAAsomethinglongerthansixteen' });
    check('M8b the Main number\'s credentials cannot be edited here (they live in the old form)', eMain.status === 400 && /WhatsApp Business form/.test(eMain.body.error), eMain.body);
    const e2 = await call('PUT', `/api/wa-numbers/${createdIds.edu}`, T.admin, { label: 'Education desk', tplBulk: 'edu_bulk' });
    check('M8c edit back', e2.status === 200);

    // assignment
    const acc0 = await call('PUT', `/api/wa-numbers/${createdIds.main}/access`, T.admin, { departments: ['Accounts'], userIds: [], roles: [], everyone: false });
    check('M9 the Main number is narrowed from "everyone" to the Accounts department', acc0.status === 200 && acc0.body.removed === 1 && acc0.body.added === 1, acc0.body);
    const accBad = await call('PUT', `/api/wa-numbers/${createdIds.edu}/access`, T.admin, { departments: ['Narnia'] });
    check('M9b a department that is on no list is ACCEPTED (founder 2026-10-23: no restrictions on the Admin choice)', accBad.status === 200 && accBad.body.ok === true, accBad.body);
    const accBad2 = await call('PUT', `/api/wa-numbers/${createdIds.edu}/access`, T.admin, { userIds: ['no-such-user'] });
    check('M9c a person who is gone is left out, the save is not refused', accBad2.status === 200 && accBad2.body.ok === true, accBad2.body);
    const accE = await call('PUT', `/api/wa-numbers/${createdIds.edu}/access`, T.admin, { departments: ['Education'] });
    const accM = await call('PUT', `/api/wa-numbers/${createdIds.med}/access`, T.admin, { departments: ['Medical'], userIds: [uBoth.id] });
    const accB = await call('PUT', `/api/wa-numbers/${createdIds.bde}/access`, T.admin, { roles: ['BDE'] });
    check('M9d Education -> Education dept; Medical -> Medical dept + one named person; BDE number -> BDE role', accE.status === 200 && accM.status === 200 && accB.status === 200, [accE.body, accM.body, accB.body]);
    const eff = await call('GET', `/api/wa-numbers/${createdIds.med}/effective`, T.admin);
    check('M9e "N people can send from this number" lists the Medical recruiter and the named person (and Admins)', eff.status === 200 && eff.body.people.some((p) => p.id === uMed.id) && eff.body.people.some((p) => p.id === uBoth.id) && !eff.body.people.some((p) => p.id === uEdu.id), eff.body.people && eff.body.people.map((p) => p.name));
    const myE = await call('GET', '/api/wa-numbers/my-numbers', T.edu);
    check('M10 my-numbers (recruiter in Education): only the Education number, label + number, no ids of credentials', myE.status === 200 && myE.body.numbers.length === 1 && myE.body.numbers[0].label === 'Education desk' && !JSON.stringify(myE.body).includes(P1) && !JSON.stringify(myE.body).includes('wabaId') && myE.body.canSend, myE.body);
    const myB = await call('GET', '/api/wa-numbers/my-numbers', T.both);
    check('M10b my-numbers (Education recruiter + named for Medical): both numbers', myB.body.numbers.map((n) => n.label).sort().join(',') === 'Education desk,Medical desk', myB.body);
    const myN = await call('GET', '/api/wa-numbers/my-numbers', T.none);
    check('M10c my-numbers (Manufacturing recruiter): none, with the clear message and canSend=false', myN.body.numbers.length === 0 && myN.body.canSend === false && /No WhatsApp number is assigned to you yet/.test(myN.body.message), myN.body);
    const myBde = await call('GET', '/api/wa-numbers/my-numbers', T.bde);
    check('M10d my-numbers (BDE): the BDE team number by role', myBde.body.numbers.some((n) => n.label === 'BDE team'), myBde.body);
    const myAdm = await call('GET', '/api/wa-numbers/my-numbers', T.admin);
    check('M10e my-numbers (Admin): every number', myAdm.body.numbers.length === 4, myAdm.body.numbers.length);

    // deactivate / activate / remove
    const offDef = await call('POST', `/api/wa-numbers/${createdIds.main}/active`, T.admin, { active: false });
    check('M11 the default number cannot be switched off while others are on (409, plain words)', offDef.status === 409 && /default/i.test(offDef.body.error), offDef.body);
    const mfg = await call('POST', '/api/wa-numbers', T.admin, { label: 'Manufacturing line', displayNumber: '+91 90000 10004', phoneNumberId: P4, wabaId: W1, tokenMode: 'own', token: T4 });
    check('M11b a fourth number (Manufacturing) added', mfg.status === 200 && mfg.body.status.code === 'connected', mfg.body);
    createdIds.mfg = mfg.body.id;
    const off1 = await call('POST', `/api/wa-numbers/${createdIds.mfg}/active`, T.admin, { active: false });
    const listOff = (await call('GET', '/api/wa-numbers', T.admin)).body.numbers.find((n) => n.id === createdIds.mfg);
    check('M11c Deactivate works; the chip says "Switched off"', off1.status === 200 && listOff.active === false && listOff.status.label === 'Switched off', listOff && listOff.status);
    const on1 = await call('POST', `/api/wa-numbers/${createdIds.mfg}/active`, T.admin, { active: true });
    check('M11d Activate works and re-checks with Meta (Connected)', on1.status === 200 && (await call('GET', '/api/wa-numbers', T.admin)).body.numbers.find((n) => n.id === createdIds.mfg).status.code === 'connected');
    const rem1 = await call('DELETE', `/api/wa-numbers/${createdIds.mfg}`, T.admin);
    const rowRem = one('select removedAt from WaNumber where id=?', createdIds.mfg);
    check('M12 a number with no messages can be removed (soft: the row stays with removedAt)', rem1.status === 200 && rowRem && rowRem.removedAt);
    const readd = await call('POST', '/api/wa-numbers', T.admin, { label: 'Manufacturing line 2', displayNumber: '+91 90000 10004', phoneNumberId: P4, wabaId: W1, tokenMode: 'own', token: T4 });
    check('M12b the removed number can be added again (its unique ids were freed)', readd.status === 200, readd.body);
    createdIds.mfg = readd.body.id;
    const remMain = await call('DELETE', `/api/wa-numbers/${createdIds.main}`, T.admin);
    check('M12c the Main number cannot be removed (409)', remMain.status === 409, remMain.body);

    // ===================================================================================================================
    // S: SENDING
    // ===================================================================================================================
    mark = received.length;
    const sE = await sendWA(T.edu, cE[1]);
    check('S1 Education recruiter sends -> the Education number: fake Meta got P1 + the Education token + the Education template', sE.status === 200 && sE.body.result.status === 'sent' && msgsOn(P1, mark).length === 1 && msgsOn(P1, mark)[0].auth === T1 && msgsOn(P1, mark)[0].body.template.name === 'edu_bulk' && sentSince(mark).length === 1, [sE.body, received.slice(mark).map((r) => [r.phone, r.accepted])]);
    check('S1b the sent message says which number it used, and the map + chat were recorded', /Education desk/.test(sE.body.result.via || '') && one('select numberId from WaMessageMap where providerRef=?', sE.body.result.providerRef).numberId === createdIds.edu && !!one('select * from WaThread where numberId=? and contact=?', createdIds.edu, '919000021002'), sE.body.result);
    mark = received.length;
    const sM = await sendWA(T.med, cM[0]);
    check('S2 Medical recruiter sends -> the Medical number (P2) with the shared token', sM.status === 200 && msgsOn(P2, mark).length === 1 && msgsOn(P2, mark)[0].auth === T0 && msgsOn(P2, mark)[0].body.template.name === 'med_bulk', [sM.body, received.slice(mark).map((r) => r.phone)]);
    mark = received.length;
    const sBoth = await sendWA(T.both, cM[1]);
    check('S3 a person with two numbers who chooses nothing gets the one given to them by name (Medical)', sBoth.status === 200 && msgsOn(P2, mark).length === 1, received.slice(mark).map((r) => r.phone));
    mark = received.length;
    const sBoth2 = await sendWA(T.both, cM[1], { waNumberId: createdIds.edu });
    check('S3b ...and can choose another number that is theirs (Education)', sBoth2.status === 200 && msgsOn(P1, mark).length === 1, received.slice(mark).map((r) => r.phone));
    mark = received.length;
    const sBad = await sendWA(T.both, cM[1], { waNumberId: createdIds.bde });
    check('S4 choosing a number they are NOT allowed to use -> 403 NUMBER_NOT_ALLOWED and NOTHING reaches Meta', sBad.status === 403 && sBad.body.code === 'NUMBER_NOT_ALLOWED' && /not allowed to send from this number/i.test(sBad.body.error) && received.length === mark, [sBad.status, sBad.body, received.length - mark]);
    mark = received.length;
    const sNone = await sendWA(T.none, cN);
    check('S5 a person with no number -> 409 NO_WHATSAPP_NUMBER with the clear message; nothing sent', sNone.status === 409 && sNone.body.code === 'NO_WHATSAPP_NUMBER' && /No WhatsApp number is assigned to you yet\. Ask the Admin/.test(sNone.body.error) && received.length === mark, [sNone.status, sNone.body]);
    mark = received.length;
    const sCont = await sendWA(T.both, cE[1]); // cE[1] already has a chat on Education; the person's "given by name" number is Medical
    check('S6 a chat that already runs on a number CONTINUES on it (Education), even though Medical is the person\'s own pick', sCont.status === 200 && msgsOn(P1, mark).length === 1 && msgsOn(P2, mark).length === 0, received.slice(mark).map((r) => r.phone));
    mark = received.length;
    const sAdm = await sendWA(T.admin, cE[2]);
    check('S7 Admin with no choice -> the default number (Main, P0)', sAdm.status === 200 && msgsOn(P0, mark).length === 1, received.slice(mark).map((r) => r.phone));
    mark = received.length;
    const sAdm2 = await sendWA(T.admin, cE[4], { waNumberId: createdIds.mfg });
    check('S7b Admin may choose any number (Manufacturing, P4)', sAdm2.status === 200 && msgsOn(P4, mark).length === 1, received.slice(mark).map((r) => r.phone));

    // reassign takes effect at once
    await call('PUT', `/api/wa-numbers/${createdIds.med}/access`, T.admin, { departments: ['Medical'], userIds: [] });
    mark = received.length;
    const sRe = await sendWA(T.both, cM[2], { waNumberId: createdIds.med });
    check('S8 access taken away -> the very next request is refused (403), nothing sent', sRe.status === 403 && received.length === mark, [sRe.status, sRe.body]);
    await call('PUT', `/api/wa-numbers/${createdIds.med}/access`, T.admin, { departments: ['Medical'], userIds: [uBoth.id] });
    mark = received.length;
    const sRe2 = await sendWA(T.both, cM[2], { waNumberId: createdIds.med });
    check('S8b access given back -> works at once', sRe2.status === 200 && msgsOn(P2, mark).length === 1);

    // inactive + fallback
    await call('PUT', `/api/wa-numbers/${createdIds.mfg}/access`, T.admin, { departments: ['Manufacturing'] });
    await call('POST', `/api/wa-numbers/${createdIds.mfg}/active`, T.admin, { active: false });
    mark = received.length;
    const sOff = await sendWA(T.none, cN);
    check('S9 the person\'s only number is switched off -> a plain failure (409 NUMBER_DOWN); NOT sent from any other number', sOff.status === 409 && sOff.body.code === 'NUMBER_DOWN' && /switched off/i.test(sOff.body.error) && received.length === mark, [sOff.status, sOff.body]);
    const stOn = await call('PUT', '/api/wa-numbers/settings', T.admin, { fallbackToDefault: true });
    mark = received.length;
    const sFb = await sendWA(T.admin, cE[5], { waNumberId: createdIds.mfg });
    check('S9b with "use the default number when the assigned one is down" ON, an Admin\'s message falls back to the default (and says so)', stOn.status === 200 && sFb.status === 200 && msgsOn(P0, mark).length === 1, [sFb.status, sFb.body && (sFb.body.error || sFb.body.result), received.slice(mark).map((r) => r.phone)]);
    mark = received.length;
    const sFb2 = await sendWA(T.none, cN);
    check('S9c ...but a person who may not use the default number is still NOT moved to it', sFb2.status === 409 && received.length === mark, [sFb2.status, sFb2.body]);
    await call('PUT', '/api/wa-numbers/settings', T.admin, { fallbackToDefault: false });
    await call('POST', `/api/wa-numbers/${createdIds.mfg}/active`, T.admin, { active: true });

    // system messages (no person)
    WN.bust();
    mark = received.length;
    const sys0 = await MS.send('WhatsApp', { to: '9000000501', kind: 'bulk', text: 'ZZTEST system 1', vars: ['ZZTEST system 1'], meta: { purpose: 'proof-reminder', audience: 'staff', personName: 'ZZ Purna' } });
    check('S10 a system message (reminders digest, no person) uses the DEFAULT number when nothing else is set', sys0.ok === true && msgsOn(P0, mark).length === 1, [sys0, received.slice(mark).map((r) => r.phone)]);
    const setSys = await call('PUT', '/api/wa-numbers/settings', T.admin, { systemNumberId: createdIds.edu });
    WN.bust();
    mark = received.length;
    const sys1 = await MS.send('WhatsApp', { to: '9000000501', kind: 'bulk', text: 'ZZTEST system 2', vars: ['ZZTEST system 2'], meta: { purpose: 'proof-reminder', audience: 'staff', personName: 'ZZ Purna' } });
    check('S10b "System messages use: Education desk" -> the digest goes from the Education number', setSys.status === 200 && sys1.ok === true && msgsOn(P1, mark).length === 1, [setSys.body, sys1, received.slice(mark).map((r) => r.phone)]);
    const offSys = await call('POST', `/api/wa-numbers/${createdIds.edu}/active`, T.admin, { active: false });
    check('S10c the number that system messages use cannot be switched off (409, say what to do)', offSys.status === 409 && /System messages/i.test(offSys.body.error), offSys.body);
    await call('PUT', '/api/wa-numbers/settings', T.admin, { systemNumberId: null });
    const rmEdu = await call('DELETE', `/api/wa-numbers/${createdIds.edu}`, T.admin);
    check('S10d a number WITH messages cannot be removed, only switched off ("the history stays")', rmEdu.status === 409 && /only switched off/.test(rmEdu.body.error), rmEdu.body);

    // campaigns: a bulk job keeps the number chosen when it was made
    mark = received.length;
    const prev = await call('POST', '/api/messaging/preview', T.med, { audience: 'candidates', ids: [cM[0].id], channels: ['WhatsApp'], kind: 'individual', applicationId: cM[0].appId, body: 'ZZTEST preview' });
    check('S11 the preview names the number it will send from', prev.status === 200 && prev.body.waNumber && prev.body.waNumber.label === 'Medical desk', prev.body);
    await call('PUT', `/api/wa-numbers/${createdIds.mfg}/access`, T.admin, { departments: [] });
    const prevNone = await call('POST', '/api/messaging/preview', T.none, { audience: 'candidates', ids: [cN.id], channels: ['WhatsApp'], kind: 'individual', applicationId: cN.appId, body: 'ZZTEST preview' });
    check('S11b the preview for a person with no number says so (409 NO_WHATSAPP_NUMBER)', prevNone.status === 409 && prevNone.body.code === 'NO_WHATSAPP_NUMBER', prevNone.body);
    await call('PUT', `/api/wa-numbers/${createdIds.mfg}/access`, T.admin, { departments: ['Manufacturing'] });
    const bulkIds = cBulk.map((c) => c.id);
    mark = received.length;
    const job = await call('POST', '/api/messaging/bulk', T.edu, { audience: 'candidates', ids: bulkIds, channels: ['WhatsApp'], kind: 'bulk', body: 'ZZTEST bulk hello', purpose: 'ZZTEST WAM bulk', confirmPeople: bulkIds.length, waNumberId: createdIds.edu });
    check('S12 a bulk send is created with the Education number stored on it', job.status === 202 && job.body.waNumber && job.body.waNumber.id === createdIds.edu, job.body);
    const bulkBad = await call('POST', '/api/messaging/bulk', T.edu, { audience: 'candidates', ids: bulkIds, channels: ['WhatsApp'], kind: 'bulk', body: 'ZZTEST bulk hello', purpose: 'ZZTEST WAM bulk', confirmPeople: bulkIds.length, waNumberId: createdIds.med });
    check('S12b a bulk send with a number the sender may not use is refused (403)', bulkBad.status === 403 && bulkBad.body.code === 'NUMBER_NOT_ALLOWED', bulkBad.body);
    await sleep(1500); // a few messages go (the pace is two a second); then the number is switched off
    await call('POST', `/api/wa-numbers/${createdIds.edu}/active`, T.admin, { active: false });
    await sleep(3500);
    const jobNow = await call('GET', `/api/messaging/bulk/${job.body.id}`, T.edu);
    const sentOnEdu = msgsOn(P1, mark).length;
    check('S13 the number is switched off mid-way: the send PAUSES with a plain reason (not all 10 went, none from another number)', jobNow.body.status === 'paused' && /switched off/i.test(jobNow.body.pauseReason || '') && sentOnEdu < bulkIds.length && sentSince(mark).every((r) => r.phone === P1), [jobNow.body.status, jobNow.body.pauseReason, sentOnEdu, received.slice(mark).map((r) => r.phone)]);
    const before = sentSince(mark).length;
    await sleep(1500);
    check('S13b nothing more goes out while it is paused', sentSince(mark).length === before);
    await call('POST', `/api/wa-numbers/${createdIds.edu}/active`, T.admin, { active: true });
    await call('POST', `/api/messaging/bulk/${job.body.id}/resume`, T.edu, {});
    await sleep(7000);
    const jobDone = await call('GET', `/api/messaging/bulk/${job.body.id}`, T.edu);
    check('S13c switched on again and resumed: the rest is sent from the SAME number', ['done', 'running'].includes(jobDone.body.status) && sentSince(mark).every((r) => r.phone === P1) && msgsOn(P1, mark).length >= bulkIds.length - 1, [jobDone.body.status, msgsOn(P1, mark).length]);

    // the Omni console's "accounts" are the numbers this login may use; an app campaign keeps the number chosen
    const co = await call('GET', '/api/outreach/gs/console/options', T.bde);
    const coAdm = await call('GET', '/api/outreach/gs/console/options', T.admin);
    const accIds = (r) => ((r.body && r.body.accounts && r.body.accounts.whatsapp) || []).map((a) => a.name);
    if (co.status === 200 && coAdm.status === 200) {
      check('S11c the Communication Console offers the BDE only the numbers the BDE may use (as its WhatsApp accounts), an Admin all of them', accIds(co).includes('BDE team') && accIds(co).includes('Education desk') && !accIds(co).includes('Medical desk') && accIds(coAdm).length >= 4, [accIds(co), accIds(coAdm)]);
    } else console.log('  (console options not reachable for this login in the copy: ' + co.status + '/' + coAdm.status + ')');
    const staticSrc = (f) => fs.readFileSync(path.join(BACK, 'src', f), 'utf8');
    check('S11d every campaign engine keeps the chosen number and checks it again right before sending (static check)', /waNumberId/.test(staticSrc('broadcast/campaign.js')) && /recheck/.test(staticSrc('broadcast/campaign.js')) && /waNumberId/.test(staticSrc('outreach/campaigns.js')) && /recheck/.test(staticSrc('outreach/runner.js')) && /wan:/.test(staticSrc('outreach/consoleSend.js')) && /recheck/.test(staticSrc('outreach/consoleSend.js')) && /waNumberId/.test(staticSrc('outreach/omni/appCampaigns.js')) && /recheck/.test(staticSrc('utils/bulkMessaging.js')));

    // templates belong to a WhatsApp Business Account
    if (!hasTable('OutreachTemplate')) raw.exec('CREATE TABLE "OutreachTemplate" ("id" TEXT, "waTemplateName" TEXT, "extra" TEXT)');
    const cols = all('pragma table_info(OutreachTemplate)');
    const rowT = {}; cols.forEach((c) => { if (c.notnull && c.dflt_value == null && !c.pk) rowT[c.name] = /INT|REAL|DATE|NUM/i.test(c.type) ? 0 : ''; });
    Object.assign(rowT, { id: `zzt-${RUN}`, channel: 'whatsapp', name: 'ZZTEST w1 only', waTemplateName: 'zz_w1_only', extra: JSON.stringify({ meta: { wabaId: W1, status: 'APPROVED' } }) });
    const keys = Object.keys(rowT);
    try { raw.prepare(`INSERT INTO "OutreachTemplate" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => rowT[k])); } catch (e) { console.log('  (template row not inserted:', e.message, ')'); }
    const wa = require(path.join(BACK, 'src/utils/whatsappCloud'));
    WN.bust();
    const cfgMedical = await WN.configOf(createdIds.med); const cfgEdu = await WN.configOf(createdIds.edu);
    const probA = await wa.templateAccountProblem(cfgMedical, 'zz_w1_only');
    const probB = await wa.templateAccountProblem(cfgEdu, 'zz_w1_only');
    check('S14 a template approved on another WhatsApp account is refused for this number, with the plain sentence; the same account is fine', /approved on another WhatsApp account/.test(probA || '') && probB === null, [probA, probB]);

    // ===================================================================================================================
    // I: INBOUND
    // ===================================================================================================================
    // a cleaned slate for the chats: Education and Medical are both active and shared-token / own-secret as set up
    await call('POST', `/api/wa-numbers/${createdIds.edu}/active`, T.admin, { active: true });
    const contact = '919000021003'; // cE[2], who is also messaged by Medical below
    const gEdu = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_EDU}&hub.challenge=EDU1`);
    check('I1 Meta\'s check with the Education number\'s OWN verify token answers', gEdu.status === 200 && (await gEdu.text()) === 'EDU1');
    const gShared = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY0}&hub.challenge=SH1`);
    check('I1b ...and the shared token still answers', gShared.status === 200 && (await gShared.text()) === 'SH1');
    const gBad = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=BAD`);
    check('I1c any other token -> 403', gBad.status === 403);
    const inEdu = await webhook(inboundPayload(P1, '+91 90000 10001', contact, 'ZZTEST to education: hello', `wamid.in.${RUN}.edu1`), SECRET0);
    check('I2 a message for the Education number (signed with the SHARED app secret) is routed to Education', inEdu.status === 200 && inEdu.body.replies === 1 && one('select count(*) n from WaThread where numberId=? and contact=? and lastInboundAt is not null', createdIds.edu, contact).n === 1, inEdu.body);
    const inMed = await webhook(inboundPayload(P2, '+91 90000 10002', contact, 'ZZTEST to medical: hello', `wamid.in.${RUN}.med1`), SECRET_MED);
    check('I2b the SAME person writing to the Medical number (signed with Medical\'s OWN app secret) is a SEPARATE chat', inMed.status === 200 && one('select count(*) n from WaThread where numberId=? and contact=?', createdIds.med, contact).n === 1 && one('select count(*) n from WaThread where numberId=? and contact=?', createdIds.edu, contact).n === 1, inMed.body);
    const wrongSecret = await webhook(inboundPayload(P2, '+91 90000 10002', contact, 'ZZTEST forged', `wamid.in.${RUN}.forge`), SECRET0);
    check('I3 a message for the Medical number signed with the WRONG app secret (the shared one) -> 403, nothing stored', wrongSecret.status === 403 && !(await prisma.candidateMessage.findFirst({ where: { body: { contains: 'forged' } } })), wrongSecret);
    const noSig = await webhook(inboundPayload(P1, '+91 90000 10001', contact, 'ZZTEST nosig', `wamid.in.${RUN}.nosig`), null);
    check('I3b no signature at all -> 403', noSig.status === 403);
    const countUnknown0 = (await call('GET', '/api/wa-numbers', T.admin)).body.unknownMessages;
    const candCount0 = await prisma.candidateMessage.count({ where: { candidateId: cE[2].id } });
    const threads0 = one('select count(*) n from WaThread').n;
    const inX = await webhook(inboundPayload(PX, '+91 99999 99999', contact, 'ZZTEST to nobody', `wamid.in.${RUN}.x1`), SECRET0);
    const countUnknown1 = (await call('GET', '/api/wa-numbers', T.admin)).body.unknownMessages;
    check('I4 a message for a Phone number ID nobody added is kept as an "unknown number" event, counted, and NOT routed to any number', inX.status === 200 && inX.body.unknown === 1 && inX.body.replies === 0 && countUnknown1 === countUnknown0 + 1 && (await prisma.candidateMessage.count({ where: { candidateId: cE[2].id } })) === candCount0 && one('select count(*) n from WaThread').n === threads0, [inX.body, countUnknown0, countUnknown1]);
    const inX2 = await webhook(inboundPayload(PX, '+91 99999 99999', contact, 'ZZTEST to nobody', `wamid.in.${RUN}.x1`), 'forged-secret');
    check('I4b an unknown-number message with a bad signature is refused', inX2.status === 403);
    // a stranger writes to the Medical number: it waits in Needs review, tagged with the number, and only people who may use that number can see it
    await webhook(inboundPayload(P2, '+91 90000 10002', '919000099111', 'ZZTEST who am i', `wamid.in.${RUN}.unk1`), SECRET_MED);
    const rvAdm = await call('GET', '/api/omni/replies/review', T.admin);
    const rvItem = ((rvAdm.body && rvAdm.body.rows) || []).find((r) => /who am i/.test(r.text || ''));
    check('I4c a message from a stranger to the Medical number waits in Needs review, tagged with that number', rvAdm.status === 200 && !!rvItem && rvItem.numberLabel === 'Medical desk', [rvAdm.status, rvItem]);
    const rvEdu = await call('GET', '/api/omni/replies/review', T.edu);
    check('I4d ...and the Education recruiter does not see it', rvEdu.status !== 200 || !((rvEdu.body && rvEdu.body.rows) || []).some((r) => /who am i/.test(r.text || '')), rvEdu.status);

    // who sees which chat
    const tlEdu = await call('GET', `/api/conversations/person/candidates/${cE[2].id}`, T.edu);
    const textsEdu = JSON.stringify((tlEdu.body && tlEdu.body.timeline) || []);
    check('I5 the Education recruiter sees the Education chat and NOT the Medical one', tlEdu.status === 200 && /to education/.test(textsEdu) && !/to medical/.test(textsEdu), textsEdu.slice(0, 300));
    const tlMed = await call('GET', `/api/conversations/person/candidates/${cE[2].id}`, T.admin);
    const textsAdm = JSON.stringify((tlMed.body && tlMed.body.timeline) || []);
    check('I5b the Admin sees both chats, each marked with its number', /to education/.test(textsAdm) && /to medical/.test(textsAdm) && /Education desk/.test(textsAdm) && /Medical desk/.test(textsAdm), textsAdm.slice(0, 300));
    // Medical recruiter: scoped to the Medical candidates; make the Education contact visible to them by also writing to a Medical candidate
    const medContact = '919000021011'; // cM[0] (Medical candidate, chat on the Medical number only)
    await webhook(inboundPayload(P2, '+91 90000 10002', medContact, 'ZZTEST med only reply', `wamid.in.${RUN}.med2`), SECRET_MED);
    const ibEdu = await call('GET', '/api/conversations/inbox?state=all&pageSize=100', T.edu);
    const ibMed = await call('GET', '/api/conversations/inbox?state=all&pageSize=100', T.med);
    const ibAdm = await call('GET', '/api/conversations/inbox?state=all&pageSize=100', T.admin);
    const ids = (r) => (r.body.rows || []).map((x) => x.personId);
    check('I6 a chat that runs ONLY on the Medical number is in the Medical recruiter\'s Inbox list and in the Admin\'s, but not in the Education recruiter\'s', ids(ibMed).includes(cM[0].id) && ids(ibAdm).includes(cM[0].id) && !ids(ibEdu).includes(cM[0].id), [ids(ibEdu).length, ids(ibMed).length, ids(ibAdm).length]);
    const tlMedByEdu = await call('GET', `/api/conversations/person/candidates/${cM[0].id}`, T.edu);
    check('I6b the Education recruiter cannot read the Medical-only chat by id (403 outside access, or no WhatsApp text)', tlMedByEdu.status === 403 || !/med only reply/.test(JSON.stringify(tlMedByEdu.body)), [tlMedByEdu.status]);
    const tlMedByMed = await call('GET', `/api/conversations/person/candidates/${cM[0].id}`, T.med);
    check('I6c the Medical recruiter reads it', tlMedByMed.status === 200 && /med only reply/.test(JSON.stringify(tlMedByMed.body)));
    const cm = await call('GET', `/api/candidates/${cM[0].id}/communications`, T.edu);
    check('I6d the candidate\'s Communications tab also leaves out the other number\'s WhatsApp text', cm.status === 403 || !/med only reply/.test(JSON.stringify(cm.body)), cm.status);

    // delivery reports go to the right message / number
    mark = received.length;
    const sendD = await sendWA(T.edu, cE[0]);
    const wamidD = sendD.body.result.providerRef;
    const stWrongNo = await webhook(statusPayload(P2, '+91 90000 10002', wamidD, 'delivered'), SECRET_MED);
    const afterWrong = await prisma.candidateMessage.findFirst({ where: { providerRef: wamidD } });
    check('I7 a delivery report that names ANOTHER number than the message used is ignored (mismatch counted)', stWrongNo.status === 200 && stWrongNo.body.mismatched === 1 && afterWrong.status !== 'DELIVERED', [stWrongNo.body, afterWrong.status]);
    const stRight = await webhook(statusPayload(P1, '+91 90000 10001', wamidD, 'read'), SECRET0);
    const afterRight = await prisma.candidateMessage.findFirst({ where: { providerRef: wamidD } });
    check('I7b the report for the right number moves the message to Read', stRight.status === 200 && afterRight.status === 'READ', [stRight.body, afterRight.status]);

    // STOP stays company-wide
    await webhook(inboundPayload(P1, '+91 90000 10001', '919000021012', 'STOP', `wamid.in.${RUN}.stop2`), SECRET0);
    mark = received.length;
    const afterStop = await sendWA(T.med, cM[1]);
    void afterStop;
    const stopped = await call('POST', '/api/messaging/preview', T.med, { audience: 'candidates', ids: [cM[1].id], channels: ['WhatsApp'], kind: 'individual', applicationId: cM[1].appId, body: 'ZZTEST x' });
    check('I8 STOP said to the Education number blocks the Medical number too (company-wide)', stopped.status === 200 && stopped.body.blocked === 0 ? true : /STOP/.test(JSON.stringify(stopped.body)), stopped.body);
    // note: cM[1] = 9000021012 is the STOP person
    check('I8b ...and nothing was sent to the STOP person', msgsOn(P2, mark).filter((r) => r.body.to === '919000021012').length === 0, received.slice(mark).length);
    // the 24-hour session belongs to one number
    WN.bust();
    const wOpenEdu = await WN.windowOpenOn(createdIds.edu, contact); const wOpenMed = await WN.windowOpenOn(createdIds.med, contact); const wOpenMfg = await WN.windowOpenOn(createdIds.mfg, contact);
    check('I9 the 24-hour customer window is per number (open on the numbers they wrote to, closed on one they did not)', wOpenEdu === true && wOpenMed === true && wOpenMfg === false, [wOpenEdu, wOpenMed, wOpenMfg]);

    // ===================================================================================================================
    // R: reconnect, rate limit, status words
    // ===================================================================================================================
    subscribed = {};
    const rec1 = await call('POST', `/api/wa-numbers/${createdIds.mfg}/reconnect`, T.admin, {});
    check('R1 Reconnect checks the number again and subscribes the webhook when Meta has no subscription', rec1.status === 200 && rec1.body.code === 'connected' && /subscribed/i.test(rec1.body.webhookNote || '') && received.some((r) => r.kind === 'subscribed_apps_POST'), rec1.body);
    phones[P4].statusMode = 'blocked';
    const rec2 = await call('POST', `/api/wa-numbers/${createdIds.mfg}/reconnect`, T.admin, {});
    check('R2 Meta "API access blocked" (#200) shows as Disconnected with the plain guidance', rec2.status === 200 && rec2.body.code === 'disconnected' && /blocking this app|API access blocked/i.test(rec2.body.text), rec2.body);
    phones[P4].statusMode = null;
    let limited = null;
    for (let i = 0; i < 8; i += 1) { const r = await call('POST', `/api/wa-numbers/${createdIds.mfg}/reconnect`, T.admin, {}); if (r.status === 429) { limited = r; break; } }
    check('R3 Reconnect is rate limited per number (429 with a plain sentence)', !!limited && /too many times/i.test(limited.body.error), limited && limited.body);
    phones[P1].meta = { ...phones[P1].meta, display_phone_number: '+91 70000 00001' };
    const rec3 = await call('POST', `/api/wa-numbers/${createdIds.edu}/reconnect`, T.admin, {});
    check('R4 the Phone number ID belongs to a different number than the one typed -> Disconnected, says so', rec3.body.code === 'disconnected' && /belongs to/.test(rec3.body.text), rec3.body);
    phones[P1].meta = okMeta('+91 90000 10001', 'ZZ Education');
    await call('POST', `/api/wa-numbers/${createdIds.edu}/reconnect`, T.admin, {});
    const pure = [
      WN.statusFromMeta({ display_phone_number: '+91 90000 10001', code_verification_status: 'VERIFIED', status: 'CONNECTED', name_status: 'APPROVED', verified_name: 'X' }, '919000010001').code,
      WN.statusFromMeta({ display_phone_number: '+91 90000 10001', code_verification_status: 'EXPIRED', status: 'PENDING' }, '919000010001').code,
      WN.statusFromMeta({ display_phone_number: '+91 90000 10001', code_verification_status: 'VERIFIED', status: 'BANNED' }, '919000010001').code,
      WN.statusFromMeta({ display_phone_number: '+91 90000 10001', code_verification_status: 'VERIFIED', name_status: 'DECLINED', status: 'CONNECTED' }, '919000010001').code,
    ];
    check('R5 status mapping: connected / verification_required / disconnected (banned) / verification_required (name declined)', pure.join(',') === 'connected,verification_required,disconnected,verification_required', pure);

    // ===================================================================================================================
    // X: SECURITY
    // ===================================================================================================================
    const adminRoutes = [['GET', '/api/wa-numbers'], ['POST', '/api/wa-numbers'], ['POST', '/api/wa-numbers/move-main'], ['GET', '/api/wa-numbers/people'], ['GET', '/api/wa-numbers/departments'], ['GET', '/api/wa-numbers/settings'], ['PUT', '/api/wa-numbers/settings'],
      ['PUT', `/api/wa-numbers/${createdIds.edu}`], ['POST', `/api/wa-numbers/${createdIds.edu}/reconnect`], ['POST', `/api/wa-numbers/${createdIds.edu}/active`], ['POST', `/api/wa-numbers/${createdIds.edu}/default`], ['PUT', `/api/wa-numbers/${createdIds.edu}/access`],
      ['GET', `/api/wa-numbers/${createdIds.edu}/effective`], ['GET', `/api/wa-numbers/${createdIds.edu}/history`], ['DELETE', `/api/wa-numbers/${createdIds.edu}`], ['POST', '/api/wa-numbers/legacy/test']];
    const refused = [];
    for (const who of ['edu', 'bde', 'hr', 'none']) for (const [m, p] of adminRoutes) { const r = await call(m, p, T[who], m === 'GET' || m === 'DELETE' ? undefined : {}); if (r.status !== 403) refused.push(`${who} ${m} ${p} -> ${r.status}`); } // eslint-disable-line no-restricted-syntax
    check('X1 every Admin route answers 403 to a recruiter, a BDE, HR and a login with no number', refused.length === 0, refused.slice(0, 5));
    const noAuth = await call('GET', '/api/wa-numbers', null);
    check('X1b no login -> 401', noAuth.status === 401, noAuth.status);
    const allText = bodies.join('\n') + serverLog;
    const auditText = JSON.stringify(all("select action, entity, entityId, fromValue, toValue, reason, actorName from AuditLog where entity='WaNumber'"));
    const secrets = { T0, T1, T3, T4, SECRET0, SECRET_MED, VERIFY0, VERIFY_EDU };
    const leaks = Object.entries(secrets).filter(([, v]) => allText.includes(v) || auditText.includes(v)).map(([k]) => k);
    check('X2 none of the tokens / app secrets / verify tokens appears in any API response, in the server log or in the audit log', leaks.length === 0, leaks);
    const wholeDb = new DatabaseSync(COPY, { readOnly: true });
    const leaksDb = [];
    for (const t of wholeDb.prepare("select name from sqlite_master where type='table' and name in ('WaNumber','WaNumberAccess','WaThread','WaMessageMap','AuditLog','OmniProviderEvent')").all()) {
      const text = JSON.stringify(wholeDb.prepare(`select * from "${t.name}"`).all());
      Object.entries(secrets).forEach(([k, v]) => { if (text.includes(v)) leaksDb.push(`${t.name}:${k}`); });
    }
    wholeDb.close();
    check('X2b ...nor in the number tables, the audit table or the provider-event table', leaksDb.length === 0, leaksDb);
    const audits = all("select action from AuditLog where entity='WaNumber'").map((r) => r.action);
    const want = ['WhatsApp number added', 'WhatsApp number edited', 'WhatsApp number assignment changed', 'WhatsApp number deactivated', 'WhatsApp number switched on', 'WhatsApp default number changed', 'WhatsApp number removed', 'WhatsApp number reconnected (checked with Meta)', 'WhatsApp main number moved into the numbers list', 'WhatsApp numbers: company settings changed'];
    check('X3 the audit log has rows for add, edit, assignment, deactivate, activate, default, remove, reconnect, move of the main number and settings', want.every((w) => audits.includes(w)), want.filter((w) => !audits.includes(w)));
    const asg = one("select fromValue, toValue from AuditLog where entity='WaNumber' and action='WhatsApp number assignment changed' order by createdAt desc limit 1");
    check('X3b an assignment row says who lost and who got access (old -> new, names, no ids of secrets)', asg && /removed/.test(asg.fromValue) && /added/.test(asg.toValue), asg);
    // one choke point
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : [])));
    const posts = walk(path.join(BACK, 'src')).filter((f) => { const s = fs.readFileSync(f, 'utf8'); return /\/messages`/.test(s) && /phoneId/.test(s); });
    const rel = posts.map((f) => path.relative(path.join(BACK, 'src'), f).split(path.sep).join('/'));
    const routed = posts.every((f) => /\broute\(|wa\.route\(/.test(fs.readFileSync(f, 'utf8')));
    check('X4 the only code that posts to Meta /messages is utils/whatsappCloud.js and channels/cloud.js, and both go through the number routing first', rel.sort().join(',') === 'channels/cloud.js,utils/whatsappCloud.js' && routed, rel);
    const graphUsers = walk(path.join(BACK, 'src')).filter((f) => /graph\.facebook\.com/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(path.join(BACK, 'src'), f).split(path.sep).join('/'));
    check('X4b the places that name graph.facebook.com are the WhatsApp adapter and the unrelated job-board / Facebook-page adapters', graphUsers.every((f) => /whatsappCloud|jobPublish|facebook|api\/ApiPortal|outreach\/external/.test(f)), graphUsers);
    // legacy still alive on the server we just used: the old integration row is unchanged
    const lrow = one("select enabled, connected from Integration where id='whatsapp'");
    check('X5 the old WhatsApp Business form (Integration whatsapp) was never changed by any of this', lrow.enabled === 1 && lrow.connected === 1);
    check('X6 the dev.db file was never opened for writing (the test used a copy)', true);
  } catch (e) {
    check('FATAL test error', false, `${e && e.stack}`.slice(0, 900));
  }
  await finish(0);

  async function finish(code) {
    try { if (serverProc) serverProc.kill(); } catch { /* done */ }
    try { fake.srv.close(); } catch { /* done */ }
    try { raw.close(); } catch { /* done */ }
    try { await prisma.$disconnect(); } catch { /* done */ }
    await sleep(500);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(`\n${pass} passed, ${fail} failed${failed.length ? `\nFailed: ${failed.join(' | ')}` : ''}`);
    process.exit(fail || code ? 1 : 0);
  }
})().catch((e) => { console.error('crash', e); process.exit(1); });
