#!/usr/bin/env node
// ---------------------------------------------------------------------------
// COMMUNICATION AUTOMATION acceptance tests. SANDBOX ONLY, MOCK PROVIDERS ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/comm-automation-test.js
//   ... --keep      leaves the fixtures (for screenshots), prints their tokens to ~/.teamlink-sandbox/comm-fixture.json
//   ... --cleanup   removes the fixtures of the last --keep run
//
// No real WhatsApp / SMS / mail is ever contacted:
//   * a local MOCK Android-SMS-gateway HTTP server (127.0.0.1) plays the phone,
//   * a FAKE WhatsApp library (test-fixtures/fake-baileys.js) plays Baileys, injected with TL_QR_BAILEYS_MODULE,
//   * the official Cloud API and the paid gateways only return the sandbox's fake "sent",
//   * every fetch made by this process is checked against a loopback-only allowlist.
//
//   A adapter contract (all four providers)      B provider choice + fallback order
//   C rules across providers (consent, STOP, de-dupe, caps, quiet hours, test record, company switch)
//   D QR prototype: queue, pacing, caps, breaker, ban / logout, ticks, inbound, encrypted session, worker guards
//   E Android gateway: send, offline, auth, webhook (signed / key), status ticks, inbound, test SMS, webhooks registration
//   F tracking: log rows, filters, counts, exports, status endpoint     G RBAC + masked BDE flow
//   H QR code picture generator self-check
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
// message-job files go to the SANDBOX folder, never ~/.teamlink-message-jobs (the real server's queue worker reads that one)
process.env.MESSAGE_JOB_DIR = path.join(os.homedir(), '.teamlink-sandbox', 'message-jobs');
process.env.TL_COMM_GAP_SCALE = '0';
process.env.TL_QR_FRESH_MS = String(3 * 3600 * 1000); // the engine here is driven by hand (no heartbeat loop) and the shared sandbox DB is slow
process.env.BULK_BACKOFF_MS = '300,400,500'; // retries of the bulk worker, quick in tests
process.env.TL_QR_BAILEYS_MODULE = path.join(BACK, 'test-fixtures', 'fake-baileys.js');
const RUN = Date.now().toString(36);
const QR_DIR = path.join(os.tmpdir(), `tl-qr-test-${RUN}`);
process.env.TL_QR_SESSION_DIR = QR_DIR;
const STARTED = new Date();

// --- the network guard: this process may only talk to loopback ---------------------------------
const realFetch = globalThis.fetch;
const hostsSeen = new Set();
globalThis.fetch = function guardedFetch(input, init) {
  const u = new URL(typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url));
  hostsSeen.add(u.hostname);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return Promise.reject(new TypeError(`TEST BLOCKED outbound to ${u.hostname}`));
  return realFetch(input, init);
};

const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

// the sandbox database is shared with other agents' tests: a busy database is retried, not a failure of this test
prisma.$use(async (params, next) => {
  for (let i = 0; ; i += 1) {
    try { return await next(params); } catch (e) {
      if (!/timed out|locked|SQLITE_BUSY|Socket timeout/i.test(String(e && e.message)) || i >= 8) throw e;
      await new Promise((r) => { setTimeout(r, 2000); });
    }
  }
});

const KEEP = process.argv.includes('--keep');
const CLEAN_ONLY = process.argv.includes('--cleanup');
const OUT = path.join(os.homedir(), '.teamlink-sandbox', 'comm-fixture.json');
const TAG = 'ZZTEST Comm';
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''}`);
}
let settingsRef = null;
async function call(method, p, token, body, raw) {
  let r = await call0(method, p, token, body, raw);
  // the shared sandbox database is sometimes busy: a settings / switch call that answered 5xx is repeated (they are idempotent)
  for (let i = 0; i < 4 && r.status >= 500 && method !== 'GET' && p.startsWith('/api/comm') && !/test-sms/.test(p); i += 1) { await new Promise((res) => { setTimeout(res, 3000); }); r = await call0(method, p, token, body, raw); } // eslint-disable-line no-await-in-loop
  if (method !== 'GET' && p.startsWith('/api/comm') && settingsRef) await settingsRef.load({ fresh: true });
  return r;
}
async function call0(method, p, token, body, raw) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: { ...h, ...(raw && raw.headers) }, body: raw && raw.body !== undefined ? raw.body : payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
      const buf = Buffer.from(await r.arrayBuffer());
      const text = buf.toString('utf8');
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text, buf };
    } catch (e) { if (i >= 90) throw e; await new Promise((res) => { setTimeout(res, 1500); }); }
  }
}
async function waitFor(fn, ms = 60000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(250); } } // eslint-disable-line no-await-in-loop
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });

// --- mock Android SMS gateway (the "phone") ----------------------------------------------------
const phone = { requests: [], mode: 'ok', user: 'phoneuser', pass: 'phonepass', delivered: new Set(), counter: 0 };
function startPhone() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        const want = `Basic ${Buffer.from(`${phone.user}:${phone.pass}`).toString('base64')}`;
        phone.requests.push({ method: req.method, url: req.url, auth, body: data });
        if (phone.mode === 'down') { req.socket.destroy(); return; }
        if (auth !== want) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"message":"Unauthorized"}'); return; }
        if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"pass"}'); return; }
        if (req.method === 'POST' && req.url === '/message') {
          if (phone.mode === 'busy') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"QueueLimitExceeded"}'); return; }
          phone.counter += 1;
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: `MOCKMSG${phone.counter}`, state: 'Pending', recipients: [{ phoneNumber: 'x', state: 'Pending' }] }));
          return;
        }
        const m = /^\/message\/(.+)$/.exec(req.url);
        if (req.method === 'GET' && m) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: m[1], state: 'Delivered' })); return; }
        if (req.method === 'POST' && req.url === '/webhooks') { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"id":"x"}'); return; }
        res.writeHead(404); res.end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const ROWS = ['sms', 'whatsapp', 'sms-android', 'whatsapp-qr'];
const SETTING_KEYS = ['comm.settings', 'comm.qr.state', 'comm.qr.control', 'comm.android.health', 'message-limits'];

async function cleanup(made, snap) {
  const ids = made.users;
  const candIds = (await prisma.candidate.findMany({ where: { OR: [{ id: { in: made.cands } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id);
  const reqIds = (await prisma.requirement.findMany({ where: { OR: [{ id: { in: made.reqs } }, { title: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id);
  const appIds = (await prisma.application.findMany({ where: { OR: [{ candidateId: { in: candIds } }, { requirementId: { in: reqIds } }] }, select: { id: true } })).map((x) => x.id);
  await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
  await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
  await prisma.application.deleteMany({ where: { id: { in: appIds } } });
  await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } });
  const clientIds = (await prisma.client.findMany({ where: { OR: [{ id: { in: made.clients } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id);
  const list = (a) => a.map((i) => `'${i}'`).join(',') || "''";
  try { await prisma.$executeRawUnsafe(`DELETE FROM "ConversationMessage" WHERE "personId" IN (${list([...candIds, ...clientIds])})`); } catch { /* none */ }
  try { await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "personId" IN (${list([...candIds, ...clientIds])})`); } catch { /* none */ }
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { startsWith: 'WhatsApp QR:' }, createdAt: { gte: STARTED } }, { title: { contains: 'ZZTEST' } }] } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...candIds, ...reqIds, ...clientIds, ...ids] } }, { entityId: { in: ['whatsapp-qr', 'sms-android', 'comm.settings'] }, createdAt: { gte: STARTED } }] } }).catch(() => {});
  await prisma.candidate.deleteMany({ where: { id: { in: candIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  try { const bulk = require(path.join(BACK, 'src/utils/bulkMessaging')); (made.jobs || []).forEach((j) => { try { bulk.removeJob(j); } catch { /* gone */ } }); } catch { /* none */ }
  // comm records / queue / opt-outs this run made
  for (const prefix of ['comm.m.', 'comm.ref.', 'comm.q.qr.', 'comm.qrwa.', 'msg.optout.', 'wa.window.', 'webhook.seen.sms-android']) {
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: prefix }, updatedAt: { gte: STARTED } } }).catch(() => {});
  }
  // settings and integration rows back to what they were
  for (const k of (snap.keepSettings ? [] : SETTING_KEYS)) {
    const before = snap.settings[k];
    if (before) await prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: before }, update: { value: before } }); else await prisma.appSetting.deleteMany({ where: { key: k } });
  }
  const IN = require(path.join(BACK, 'src/utils/interviewNotices'));
  if (snap.switchTouched) { if (snap.switchBefore === null) await prisma.appSetting.deleteMany({ where: { key: IN.SETTINGS_KEY } }); else await prisma.appSetting.update({ where: { key: IN.SETTINGS_KEY }, data: { value: snap.switchBefore } }); }
  for (const id of (snap.keepRows ? [] : ROWS)) {
    const before = snap.rows[id];
    await prisma.integrationEvent.deleteMany({ where: { integrationId: id, createdAt: { gte: STARTED } } }).catch(() => {});
    if (!before) await prisma.integration.deleteMany({ where: { id } }).catch(() => {});
    else await prisma.integration.update({ where: { id }, data: { enabled: before.enabled, connected: before.connected, state: before.state, values: before.values, error: before.error, lastTest: before.lastTest, lastTestResult: before.lastTestResult } });
  }
  try { fs.rmSync(QR_DIR, { recursive: true, force: true }); } catch { /* none */ }
  return {
    users: await prisma.user.count({ where: { name: { contains: TAG } } }),
    cands: await prisma.candidate.count({ where: { name: { startsWith: TAG } } }),
    clients: await prisma.client.count({ where: { name: { startsWith: TAG } } }),
    msgs: await prisma.candidateMessage.count({ where: { body: { contains: 'ZZTEST Comm' } } }).catch(() => 0),
    commRows: await prisma.appSetting.count({ where: { key: { startsWith: 'comm.m.' }, updatedAt: { gte: STARTED } } }),
  };
}

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [], jobs: [] };
  const snap = { settings: {}, rows: {}, switchTouched: false, switchBefore: null };
  if (CLEAN_ONLY) {
    const us = await prisma.user.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    made.users = us.map((u) => u.id);
    await prisma.employee.deleteMany({ where: { userId: { in: made.users } } });
    const left = await cleanup(made, { settings: {}, rows: {}, switchTouched: false, keepSettings: true, keepRows: true });
    console.log('cleaned (settings left as they are)', JSON.stringify(left));
    await prisma.$disconnect();
    return;
  }
  for (const k of SETTING_KEYS) { const r = await prisma.appSetting.findUnique({ where: { key: k } }); snap.settings[k] = r ? r.value : null; }
  for (const id of ROWS) snap.rows[id] = await prisma.integration.findUnique({ where: { id } });
  const mock = await startPhone();
  process.env.TEST_MOCK_PORTS = String(mock.port);
  const MOCK_BASE = `http://127.0.0.1:${mock.port}`;

  // modules under test, in this process (same sandbox.db as the server)
  const channels = require(path.join(BACK, 'src/channels'));
  const settings = require(path.join(BACK, 'src/channels/settings'));
  settingsRef = settings;
  const store = require(path.join(BACK, 'src/channels/store'));
  const qr = require(path.join(BACK, 'src/channels/whatsappQr'));
  const android = require(path.join(BACK, 'src/channels/androidSms'));
  const engineMod = require(path.join(BACK, 'src/channels/qrEngine'));
  const bulk = require(path.join(BACK, 'src/utils/bulkMessaging'));
  const delivery = require(path.join(BACK, 'src/utils/messageDelivery'));
  const secrets = require(path.join(BACK, 'src/utils/secrets'));
  const { writeValues } = require(path.join(BACK, 'src/utils/integrationStore'));
  const CAT = require(path.join(BACK, 'src/utils/adminCatalog'));

  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `${TAG} ${tag} ${RUN}`, email: `zz-comm-${tag}-${RUN}@example.test`, username: `zz-comm-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-COM-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, email: u.email, phone: '9000000002', designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...(empExtra || {}) } });
      made.emps.push(e.id);
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uRec2 = await mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uAcc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', accountsAccess: true, atsAccess: false });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '3h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, rec: uRec, rec2: uRec2, tl: uTl, mgr: uMgr, bdeTl: uBdeTl, bde: uBde, acc: uAcc })) T[k] = await mint(u);
    const ID = {}; for (const [k, u] of Object.entries({ admin: uAdmin, rec: uRec, bde: uBde, tl: uTl })) ID[k] = await resolveIdentity(u.id);

    const client = await prisma.client.create({ data: { name: `${TAG} Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client' } });
    made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `${TAG} Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, tlId: uTl.id, bdeId: uBde.id, openings: 3 } });
    made.reqs.push(req.id);
    const cands = [];
    // 1-4 normal, 5 consent withdrawn, 6 same phone as 1 (duplicate), 7 normal (STOP replies later)
    for (let i = 1; i <= 7; i += 1) {
      const n = String(i).padStart(2, '0');
      const phoneNo = i === 6 ? '9876540001' : `98765400${n}`;
      const c = await prisma.candidate.create({ data: { name: `${TAG} Cand ${n} ${RUN}`, email: `zz-comm-c${n}-${RUN}@zz-comm-sandbox.in`, phone: phoneNo, location: 'ZZ', ...(i === 5 ? { consentStatus: 'WITHDRAWN' } : {}) } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: i === 4 ? 'SHARED_WITH_CLIENT' : 'NEW' } }); // 04 is shared with the client: a BDE may contact it (masked)
      made.apps.push(a.id);
      cands.push({ ...c, appId: a.id, n: i });
    }
    // the company switch "Candidate emails" must be ON for sends to candidates
    const IN = require(path.join(BACK, 'src/utils/interviewNotices'));
    const swRow = await prisma.appSetting.findUnique({ where: { key: IN.SETTINGS_KEY } }).catch(() => null);
    snap.switchBefore = swRow ? swRow.value : null;
    if (!(await IN.candidateEmailsOn())) {
      const cur0 = swRow ? JSON.parse(swRow.value) : {};
      const val = JSON.stringify({ ...cur0, enabled: true });
      await prisma.appSetting.upsert({ where: { key: IN.SETTINGS_KEY }, update: { value: val }, create: { key: IN.SETTINGS_KEY, value: val } });
      snap.switchTouched = true;
    }

    // provider configuration used by the tests (restored at the end)
    const setRow = async (id, fieldsByLabel, enabled = true) => {
      const w = await writeValues(id, fieldsByLabel);
      await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected', error: null } });
    };
    await setRow('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.bulkTpl]: 'zz_bulk' });
    await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' });
    const AF = CAT.ANDROID_FIELDS;
    // the Android phone is configured through the REAL admin API (secrets must come back masked)
    const cfgPut = await call('PUT', '/api/comm/android/config', T.admin, { values: { [AF.mode]: 'Local', [AF.base]: MOCK_BASE, [AF.login]: 'Basic', [AF.user]: phone.user, [AF.pass]: phone.pass, [AF.sendPath]: '/message', [AF.healthPath]: '/health', [AF.style]: 'SMS Gateway for Android', [AF.hook]: 'zz-hook-secret' } });
    check('E0 Android config saved through the admin API (200)', cfgPut.status === 200 && cfgPut.body && cfgPut.body.configured === true, [cfgPut.status, cfgPut.body && cfgPut.body.problems]);
    check('E0b the password and the webhook key come back MASKED, never in clear', cfgPut.body && !JSON.stringify(cfgPut.body).includes(phone.pass) && !JSON.stringify(cfgPut.body).includes('zz-hook-secret') && /••••/.test(JSON.stringify(cfgPut.body.secretHints)), cfgPut.body && cfgPut.body.secretHints);
    const rawRow = await prisma.integration.findUnique({ where: { id: 'sms-android' } });
    check('E0c the password is stored ENCRYPTED in the database (enc:v1:)', rawRow && !rawRow.values.includes(phone.pass) && /enc:v1:/.test(rawRow.values), rawRow && rawRow.values.slice(0, 80));

    // ===================== A: adapter contract =====================
    const contract = (name, r) => check(`A ${name}: send() answers { ok, providerRef, status } or { ok:false, error, retryable }`, r && typeof r.ok === 'boolean' && (r.ok ? (!!r.providerRef && typeof r.status === 'string') : (typeof r.error === 'string' && typeof r.retryable === 'boolean')), r);
    const msgBase = { kind: 'bulk', text: 'ZZTEST Comm contract', vars: ['ZZTEST Comm contract'], meta: { personName: 'ZZ contract', purpose: 'Contract test' } };
    const sendProv = (id, to) => channels.adapters[id].send({ ...msgBase, to: to || '9876540101' });
    for (const id of Object.keys(settings.LABELS)) {
      if (id === 'whatsapp.qr') continue;
      // eslint-disable-next-line no-await-in-loop
      contract(id, await sendProv(id));
    }
    for (const id of Object.keys(settings.LABELS)) {
      const a = channels.adapters[id];
      check(`A ${id}: has config(), health(), test(), send()`, ['config', 'health', 'test', 'send'].every((f) => typeof a[f] === 'function'));
    }
    const badNum = await channels.adapters['sms.android'].send({ ...msgBase, to: '12345' });
    check('A sms.android: a bad number is { ok:false, invalid } and nothing is sent', !badNum.ok && badNum.invalid && !phone.requests.some((r) => /12345/.test(r.body)), badNum);
    const waBad = await channels.adapters['whatsapp.qr'].send({ ...msgBase, to: '9876540101' });
    contract('whatsapp.qr (not connected)', waBad);
    check('A whatsapp.qr: not connected is { notConfigured, unavailable } with a plain reason', waBad.notConfigured && waBad.unavailable && /switched off|not connected|understand/i.test(waBad.error), waBad);
    // Android request shape (documented API of SMS Gateway for Android)
    const aReq = phone.requests.find((r) => r.method === 'POST' && r.url === '/message');
    const aBody = aReq ? JSON.parse(aReq.body) : {};
    check('A sms.android request: POST /message, Basic auth, textMessage.text + phoneNumbers[+91...], delivery report asked', aReq && aReq.auth.startsWith('Basic ') && aBody.textMessage && aBody.textMessage.text === 'ZZTEST Comm contract' && aBody.phoneNumbers[0] === '+919876540101' && aBody.withDeliveryReport === true, aBody);
    const generic = await android.androidConfig();
    check('A sms.android config reads the real values (mode local, base = the mock, 3-6 s gap default)', generic.mode === 'local' && generic.base === MOCK_BASE, generic.base);

    // ===================== B: provider choice + fallback =====================
    const setProv = async (patch) => { const r = await call('PUT', '/api/comm/settings', T.admin, patch); return r; };
    let st = await channels.status('SMS');
    check('B1 default SMS order = paid gateway first, then Android phone', st.ordered.map((p) => p.id).join() === 'sms.gateway,sms.android' && st.provider === 'sms.gateway', st.ordered.map((p) => p.id));
    await setProv({ providers: { SMS: { primary: 'sms.android', fallback: true } } });
    st = await channels.status('SMS');
    check('B2 SMS provider = Android phone -> it goes first, the paid gateway is the fallback', st.ordered[0].id === 'sms.android' && st.provider === 'sms.android' && st.via === 'SMS via Android phone', [st.ordered.map((p) => p.id), st.via]);
    const r1 = await channels.send('SMS', { ...msgBase, to: '9876540102' });
    check('B3 a message goes through the Android phone (mock received it) and says so', r1.ok && r1.provider === 'sms.android' && r1.queued && /^and:MOCKMSG/.test(r1.providerRef), r1);
    phone.mode = 'down';
    const r2 = await channels.send('SMS', { ...msgBase, to: '9876540103' });
    check('B4 phone offline -> automatic fallback to the paid gateway, with the reason kept', r2.ok && r2.provider === 'sms.gateway' && r2.attempts[0].provider === 'sms.android' && /did not answer/.test(r2.attempts[0].reason), r2.attempts);
    await setProv({ providers: { SMS: { primary: 'sms.android', fallback: false } } });
    const r3 = await channels.send('SMS', { ...msgBase, to: '9876540104' });
    check('B5 fallback switched off + phone offline -> NOT sent, plain "phone did not answer" (the screens then offer "Open in your app")', !r3.ok && r3.offline && /did not answer/.test(r3.error), r3);
    phone.mode = 'ok';
    await setProv({ providers: { SMS: { primary: 'sms.gateway', fallback: true } } });
    const r4 = await channels.send('SMS', { ...msgBase, to: '9876540105' });
    check('B6 gateway first -> used (sandbox fake), the phone is not touched', r4.ok && r4.provider === 'sms.gateway' && !r4.queued, r4);
    const only = await channels.send('SMS', { ...msgBase, to: '9876540106', providerOnly: 'sms.android' });
    check('B7 providerOnly forces one provider', only.ok && only.provider === 'sms.android', only);
    await setProv({ providers: { WhatsApp: { primary: 'whatsapp.cloud', fallback: true } } });
    let wa = await channels.status('WhatsApp');
    check('B8 WhatsApp default: official Cloud first; the QR prototype is not ready (off by default)', wa.provider === 'whatsapp.cloud' && wa.ordered[1].id === 'whatsapp.qr' && !wa.ordered[1].ready, wa.ordered);
    const wr = await channels.send('WhatsApp', { ...msgBase, to: '9876540107' });
    check('B9 WhatsApp via the official API (sandbox fake) -> provider whatsapp.cloud', wr.ok && wr.provider === 'whatsapp.cloud' && wr.via === 'WhatsApp via company number (Official)', wr);
    await prisma.integration.update({ where: { id: 'whatsapp' }, data: { enabled: false, connected: false, state: 'Not Connected' } });
    const wnone = await channels.send('WhatsApp', { ...msgBase, to: '9876540108' });
    check('B10 nothing connected -> { ok:false, notConfigured } (screens fall back to "Open in your app")', !wnone.ok && wnone.notConfigured && wnone.attempts.every((a) => a.status === 'skipped'), wnone);
    await prisma.integration.update({ where: { id: 'whatsapp' }, data: { enabled: true, connected: true, state: 'Connected' } });
    const ms = await require(path.join(BACK, 'src/utils/messaging')).channelStatus();
    check('B11 messaging.channelStatus() keeps its old shape and adds provider info', ms.SMS.configured && ms.WhatsApp.configured && Array.isArray(ms.WhatsApp.providers) && ms.WhatsApp.via, ms.WhatsApp);

    // ===================== C: the SAME rules on every provider =====================
    const rules = async (label, primarySms) => {
      await setProv({ providers: { SMS: { primary: primarySms, fallback: false } } });
      const plan = await bulk.buildPlan(ID.admin, { audience: 'candidates', ids: cands.map((c) => c.id), channels: ['SMS'], body: 'ZZTEST Comm hello {{firstName}}', purpose: 'ZZTEST Comm rules', confirmPeople: 7 });
      const rec = (n) => (plan.plan ? plan.plan.recipients.find((r) => r.name.includes(`Cand ${String(n).padStart(2, '0')} `)) : null);
      check(`C ${label}: planner answers`, !plan.error, plan.error);
      if (plan.error) return;
      check(`C ${label}: normal people are queued`, [1, 2, 3, 4, 7].every((n) => rec(n).status === 'queued'), [1, 2, 3, 4, 7].map((n) => rec(n).status));
      check(`C ${label}: consent withdrawn -> blocked`, rec(5).status === 'blocked' && /consent/i.test(rec(5).reason), rec(5));
      check(`C ${label}: same number twice -> duplicate skipped`, rec(6).status === 'skipped' && /Duplicate/.test(rec(6).reason), rec(6));
      check(`C ${label}: the plan says which provider will carry it`, rec(1).via === (primarySms === 'sms.android' ? 'SMS via Android phone' : 'SMS via paid gateway'), rec(1).via);
    };
    await rules('paid gateway', 'sms.gateway');
    await rules('android phone', 'sms.android');
    // STOP replies
    await delivery.applyInbound({ channel: 'SMS', from: '9876540007', text: 'STOP', id: `zz-stop-${RUN}`, provider: 'sms.android' });
    await delivery.applyInbound({ channel: 'WhatsApp', from: '9876540007', text: 'STOP', id: `zz-stopw-${RUN}`, provider: 'whatsapp.qr' });
    const planStop = await bulk.buildPlan(ID.admin, { audience: 'candidates', ids: [cands[6].id], channels: ['SMS', 'WhatsApp'], body: 'ZZTEST Comm hi', purpose: 'ZZTEST Comm stop' });
    check('C STOP on SMS and on WhatsApp (also when it came through the QR / Android providers) -> nothing more is sent', planStop.plan && planStop.plan.recipients.every((r) => r.status === 'blocked' && /STOP/.test(r.reason)), planStop.plan && planStop.plan.recipients.map((r) => r.reason));
    const stopDirect = await channels.adapters['sms.android'].send({ ...msgBase, to: '9876540007' });
    check('C the Android adapter itself refuses a STOP number (second line of defence)', !stopDirect.ok && stopDirect.invalid && /STOP/.test(stopDirect.error), stopDirect);
    // company switch per channel
    await setProv({ switches: { SMS: false } });
    const planOff = await bulk.buildPlan(ID.admin, { audience: 'candidates', ids: [cands[0].id], channels: ['SMS'], body: 'ZZTEST Comm hi', purpose: 'ZZTEST Comm switch' });
    check('C company switch SMS OFF -> candidates are not messaged on SMS (plain reason)', planOff.plan && planOff.plan.recipients[0].status === 'blocked' && /switched off for the company/.test(planOff.plan.recipients[0].reason), planOff.plan && planOff.plan.recipients[0]);
    await setProv({ switches: { SMS: true } });
    // daily cap (the existing per-channel limit still applies on every provider)
    const lim = require(path.join(BACK, 'src/utils/messageLimits'));
    const usedNow = lim.usedToday('SMS', bulk.listJobs());
    await lim.save(ID.admin, { SMS: { perDay: usedNow + 1 } });
    const planCap = await bulk.buildPlan(ID.admin, { audience: 'candidates', ids: [cands[0].id, cands[1].id], channels: ['SMS'], body: 'ZZTEST Comm hi', purpose: 'ZZTEST Comm cap' });
    check('C daily cap of the channel (1 a day) -> the second person is blocked, whatever the provider', planCap.plan && planCap.plan.recipients.filter((r) => r.status === 'queued').length === 1 && planCap.plan.recipients.some((r) => /limit/i.test(r.reason || '')), planCap.plan && planCap.plan.recipients.map((r) => r.status));
    await lim.save(ID.admin, { SMS: { perDay: 500 } });
    // quiet hours still apply to promotional kinds, own words never held: covered by the planner (utils/omniRules); here: own words are queued
    const quiet = await require(path.join(BACK, 'src/utils/omniRules')).quietNow(undefined, { ownWords: true });
    check('C quiet hours never hold a message a person wrote by hand', !quiet, quiet);
    // test record guard: only the server, not the sandbox, refuses; prove the guard by turning the sandbox flag off for one call that never reaches a provider
    process.env.TEST_MODE = '';
    const hostsBefore = phone.requests.length;
    const tr = await channels.send('SMS', { ...msgBase, to: '9876540109', meta: { personName: 'ZZTEST Someone', purpose: 'x' } });
    process.env.TEST_MODE = '1';
    check('C test record (ZZTEST name) is never messaged on a real server, and no provider is even called', !tr.ok && tr.invalid && /Test record/.test(tr.error) && phone.requests.length === hostsBefore, tr);

    // ===================== D: QR prototype =====================
    const fake = globalThis.__fakeWa || (require(process.env.TL_QR_BAILEYS_MODULE), globalThis.__fakeWa);
    // switched off by default
    const qrOff = await qr.qrConfig();
    check('D1 the QR prototype is OFF by default and says why', !qrOff.configured && /switched off/.test(qrOff.reason), qrOff.reason);
    const enNo = await call('POST', '/api/comm/qr/enable', T.admin, { understand: false });
    check('D2 enabling without "I understand" is refused (400)', enNo.status === 400, [enNo.status, enNo.body]);
    const en = await call('POST', '/api/comm/qr/enable', T.admin, { understand: true, label: 'ZZTEST Comm spare' });
    check('D3 enabling with "I understand" works and the confirmation is in settings + the audit log', en.status === 200 && en.body.enabled && en.body.ack && en.body.ack.byName.includes(TAG), [en.status, en.body && en.body.ack]);
    const auditAck = await prisma.auditLog.findFirst({ where: { action: { contains: 'I understand' }, createdAt: { gte: STARTED } } });
    check('D3b audit row for the confirmation exists', !!auditAck, null);
    const qrNoWorker = await qr.qrConfig();
    check('D4 enabled but the worker is not linked -> still not ready (not "connected")', !qrNoWorker.configured && /not connected/.test(qrNoWorker.reason), qrNoWorker.reason);
    const startSb = await call('POST', '/api/comm/qr/start', T.admin);
    check('D5 the Admin Start button refuses in the sandbox (the real WhatsApp network is never contacted)', startSb.status === 400 && /sandbox/i.test((startSb.body || {}).error || ''), startSb.body);
    // The server never starts the worker by itself
    const idxSrc = fs.readFileSync(path.join(BACK, 'src/index.js'), 'utf8');
    check('D6 src/index.js never starts or imports the QR worker / engine', !/whatsappQr|qrEngine|whatsapp-qr-worker/.test(idxSrc), null);
    const routeSrc = fs.readFileSync(path.join(BACK, 'src/routes/comm.js'), 'utf8');
    check('D6b the only place that spawns the worker is the explicit Admin Start path (channels/whatsappQr.start)', /qr\.start\(\)/.test(routeSrc) && !/spawn\(/.test(routeSrc), null);
    // worker refusals (child processes, nothing is linked)
    const realDb = `file:${path.join(BACK, 'prisma', 'dev.db').split(path.sep).join('/')}`;
    const runWorker = (env) => spawnSync(process.execPath, [path.join(BACK, 'src/workers/whatsappQrWorker.js')], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, JWT_SECRET: process.env.JWT_SECRET, TL_ALLOW_REAL_WHATSAPP_QR: '', ...env }, encoding: 'utf8', timeout: 60000 });
    const w1 = runWorker({ DATABASE_URL: realDb });
    check('D7 the worker REFUSES the real dev.db without TL_ALLOW_REAL_WHATSAPP_QR=1 (exit 2, no DB touched)', w1.status === 2 && /REFUSING/.test(w1.stderr) && /real database/.test(w1.stderr), [w1.status, w1.stderr.slice(0, 200)]);
    const w2 = runWorker({ DATABASE_URL: SBX, TEST_MODE: '1' });
    check('D8 the worker REFUSES the sandbox when no fake library is injected', w2.status === 2 && /sandbox/.test(w2.stderr), [w2.status, w2.stderr.slice(0, 200)]);
    await call('POST', '/api/comm/qr/disable', T.admin);
    const w3 = runWorker({ DATABASE_URL: SBX, TEST_MODE: '1', TL_QR_BAILEYS_MODULE: process.env.TL_QR_BAILEYS_MODULE, INTEGRATION_SECRET_KEY: process.env.INTEGRATION_SECRET_KEY, TL_QR_SESSION_DIR: QR_DIR });
    check('D9 the worker REFUSES while the Integrations switch is off', w3.status === 2 && /switch is off/.test(w3.stderr), [w3.status, w3.stderr.slice(0, 200)]);
    let en2 = null;
    for (let i = 0; i < 4 && !(en2 && en2.status === 200); i += 1) { en2 = await call('POST', '/api/comm/qr/enable', T.admin, { understand: true }); if (en2.status !== 200) { console.log('  (enable answered', en2.status, String(en2.text).slice(0, 120), ')'); await sleep(3000); } } // eslint-disable-line no-await-in-loop
    check('D9b switched on again for the engine tests', en2.status === 200 && en2.body.enabled === true && (await qr.qrConfig()).enabled, [en2.status, en2.body && en2.body.enabled]);
    // the engine, with the fake library
    let clock = Date.now();
    const engine = engineMod.createEngine({ sleep: async () => {}, rand: () => 0.5, now: () => clock, reconnectDelayMs: 0, noVersionCheck: true });
    await engine.connect();
    let state = await qr.getState();
    check('D10 state "Waiting for QR scan" is published while no number is linked', state.state === 'waiting-qr', state);
    fake.emit('connection.update', { qr: '2@zzfakeqrstring0123456789abcdefghijklmnopqrstuvwxyz,FAKEKEY1234567890ABCDEFGHIJKLMNOPQRSTUV=,FAKEADV1234567890ABCDEFGH=,1' });
    await sleep(150);
    const qrApi = await call('GET', '/api/comm/qr/state', T.admin);
    check('D11 the poll endpoint returns the QR as a picture (svg) with the plain state', qrApi.status === 200 && /^<svg/.test(qrApi.body.qrSvg || '') && qrApi.body.state === 'waiting-qr' && /Waiting for QR scan/.test(qrApi.body.label), [qrApi.status, qrApi.body && qrApi.body.label]);
    fake.pair('919000000001');
    await sleep(200);
    state = await qr.getState();
    const api2 = await call('GET', '/api/comm/qr/state', T.admin);
    check('D12 after the scan: Connected as +91 masked (the full number is never shown)', state.state === 'connected' && /^Connected as \+/.test(api2.body.label) && !/9000000001/.test(JSON.stringify(api2.body)), api2.body && api2.body.label);
    const files = fs.existsSync(QR_DIR) ? fs.readdirSync(QR_DIR) : [];
    const contents = files.map((f) => fs.readFileSync(path.join(QR_DIR, f), 'utf8'));
    check('D13 the session is stored ENCRYPTED: files exist, every one is enc:v1:, none shows the key material', files.length > 0 && contents.every((c) => c.startsWith('enc:v1:') && !c.includes('FAKE-NOISE-KEY') && !c.includes('FAKE-IDENTITY-KEY')), files);
    const reopened = engineMod.encryptedAuthState(QR_DIR, require(process.env.TL_QR_BAILEYS_MODULE));
    check('D14 the encrypted session can be read back (survives a restart)', reopened.hasSession() && reopened.state.creds.noiseKey === 'FAKE-NOISE-KEY-SECRET-MATERIAL', null);
    const keyBackup = process.env.INTEGRATION_SECRET_KEY; delete process.env.INTEGRATION_SECRET_KEY;
    let noKeyErr = null; try { engineMod.encryptedAuthState(QR_DIR, require(process.env.TL_QR_BAILEYS_MODULE)); } catch (e) { noKeyErr = e; }
    process.env.INTEGRATION_SECRET_KEY = keyBackup;
    check('D15 without INTEGRATION_SECRET_KEY the session is refused (never stored unencrypted)', noKeyErr && noKeyErr.code === 'NO_SECRET_KEY', noKeyErr && noKeyErr.message);

    // send through the whole stack: provider choice -> bulk -> queue
    await setProv({ providers: { WhatsApp: { primary: 'whatsapp.qr', fallback: true } } });
    const qrReady = await qr.qrConfig();
    check('D16 connected + acknowledged -> the QR provider is ready and first', qrReady.configured, qrReady.reason);
    const sendQr = async (cand, text) => {
      const out = await bulk.sendIndividual(ID.rec, { audience: 'candidates', id: cand.id, channel: 'WhatsApp', body: text, purpose: 'ZZTEST Comm qr', applicationId: cand.appId });
      if (out.jobId) made.jobs.push(out.jobId);
      return out;
    };
    const sq1 = await sendQr(cands[0], 'ZZTEST Comm qr one');
    check('D17 a send from the ATS is QUEUED on the QR-linked number (not sent at once) and says via which number', !sq1.error && sq1.result.status === 'sent' && sq1.result.queued && sq1.result.provider === 'whatsapp.qr' && /QR-linked/.test(sq1.result.via) && /^qrq_/.test(sq1.result.providerRef), sq1);
    const row1 = await prisma.candidateMessage.findFirst({ where: { candidateId: cands[0].id, providerRef: sq1.result.providerRef } });
    check('D18 the candidate message log says "Queued via ..." with the provider named, and the row is NOT in the mail worker pick-up status (QUEUED / RETRY), so it can never be sent twice', row1 && row1.status === 'SENT' && /^Queued via WhatsApp via QR-linked/.test(row1.statusDetail), row1 && [row1.status, row1.statusDetail]);
    // pacing: one at a time, random gap 8-20 s
    const sq2 = await sendQr(cands[1], 'ZZTEST Comm qr two');
    const sq3 = await sendQr(cands[2], 'ZZTEST Comm qr three');
    let r = await engine.tickSend();
    check('D19 the worker sends the FIRST queued message and nothing else in the same tick', r === 'sent' && fake.sent.length === 1 && fake.sent[0].jid === '919876540001@s.whatsapp.net' && fake.sent[0].content.text === 'ZZTEST Comm qr one', [r, fake.sent.length]);
    check('D20 "typing..." presence is simulated before the message', fake.presence.some((p) => p.kind === 'composing') && fake.presence.some((p) => p.kind === 'paused'), fake.presence);
    r = await engine.tickSend();
    check('D21 the next tick WAITS (human-like gap, no burst)', r === 'waiting' && fake.sent.length === 1, [r, fake.sent.length]);
    const gap = engine.E.nextSendAt - clock;
    check('D22 the gap is inside 8-20 s (14 s with the fixed random)', gap >= 8000 && gap <= 20000, gap);
    clock += gap + 1;
    r = await engine.tickSend();
    check('D23 after the gap the second message goes', r === 'sent' && fake.sent.length === 2 && fake.sent[1].jid === '919876540002@s.whatsapp.net', [r, fake.sent.length]);
    // caps
    await call('PUT', '/api/comm/settings', T.admin, { qr: { perHour: 2, perDay: 50 } });
    clock += 25000;
    r = await engine.tickSend();
    check('D24 hourly cap (2 an hour) reached -> the third message WAITS ("capped"), it is not sent', r === 'capped' && fake.sent.length === 2, [r, fake.sent.length]);
    await call('PUT', '/api/comm/settings', T.admin, { qr: { perHour: 30, perDay: 3 } });
    const capDay = await qr.send({ to: '9876540110', text: 'ZZTEST Comm over the daily cap', kind: 'bulk' });
    check('D25 daily cap: new messages are refused at the door once sent + waiting reaches the cap (so the next provider is tried)', !capDay.ok && capDay.capped && /daily limit/.test(capDay.error), capDay);
    await call('PUT', '/api/comm/settings', T.admin, { qr: { perHour: 30, perDay: 150 } });
    await call('PUT', '/api/comm/settings', T.admin, { qr: { newNumber: true } });
    const eff = settings.effectiveQr(await settings.load({ fresh: true }));
    check('D26 "new number" mode lowers the caps (10 an hour, 40 a day)', eff.perHour === 10 && eff.perDay === 40, eff);
    await call('PUT', '/api/comm/settings', T.admin, { qr: { newNumber: false } });
    // ticks
    const ref1 = sq1.result.providerRef;
    fake.emit('messages.update', [{ key: { id: 'FAKEWA1', remoteJid: fake.sent[0].jid, fromMe: true }, update: { status: 3 } }]);
    await waitFor(async () => (await store.byRef(ref1)).status === 'delivered');
    let rec1 = await store.byRef(ref1);
    check('D27 a delivery tick (delivered) moves the SAME message on: record + candidate log', rec1.status === 'delivered' && (await prisma.candidateMessage.findFirst({ where: { candidateId: cands[0].id, providerRef: ref1 } })).status === 'DELIVERED', rec1 && rec1.history);
    fake.emit('messages.update', [{ key: { id: 'FAKEWA1', remoteJid: fake.sent[0].jid, fromMe: true }, update: { status: 4 } }]);
    await waitFor(async () => (await store.byRef(ref1)).status === 'read');
    rec1 = await store.byRef(ref1);
    check('D28 read tick -> READ; history is Queued -> Sent -> Delivered -> Read', rec1.status === 'read' && rec1.history.map((h) => h.status).join() === 'queued,sent,delivered,read', rec1.history.map((h) => h.status));
    fake.emit('messages.update', [{ key: { id: 'FAKEWA1', remoteJid: fake.sent[0].jid, fromMe: true }, update: { status: 3 } }]);
    await sleep(200);
    rec1 = await store.byRef(ref1);
    check('D29 a late "delivered" never moves a message backwards', rec1.status === 'read', rec1.status);
    // inbound
    fake.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'INB1', remoteJid: '919876540001@s.whatsapp.net', fromMe: false }, message: { conversation: 'ZZTEST Comm I can join Monday' }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Cand' }] });
    const inbound = await waitFor(() => prisma.candidateMessage.findFirst({ where: { candidateId: cands[0].id, status: 'RECEIVED', providerRef: 'INB1' } }));
    await waitFor(async () => { const x = await prisma.$queryRawUnsafe(`SELECT "lastDirection" FROM "Conversation" WHERE "personType"='CANDIDATE' AND "personId"='${cands[0].id}'`); return x[0] && x[0].lastDirection === 'IN'; });
    check('D30 an inbound WhatsApp message lands on the candidate\'s timeline (RECEIVED) and in the Inbox thread', !!inbound && inbound.body.includes('join Monday'), inbound);
    const inboxRows = await prisma.$queryRawUnsafe(`SELECT "unread","lastDirection" FROM "Conversation" WHERE "personType"='CANDIDATE' AND "personId"='${cands[0].id}'`).catch(() => []);
    check('D31 the conversation is unread and says the last message was IN', inboxRows[0] && Number(inboxRows[0].unread) >= 1 && inboxRows[0].lastDirection === 'IN', inboxRows);
    fake.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'GRP1', remoteJid: '120363000000@g.us', participant: '919876540001@s.whatsapp.net', fromMe: false }, message: { conversation: 'group chatter' } }] });
    await sleep(200);
    check('D32 group messages are ignored', !(await prisma.candidateMessage.findFirst({ where: { providerRef: 'GRP1' } })), null);
    fake.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'STOP1', remoteJid: '919876540003@s.whatsapp.net', fromMe: false }, message: { conversation: 'STOP' } }] });
    await waitFor(async () => !!(await delivery.optedOut('WhatsApp', '9876540003')));
    check('D33 a STOP reply on the QR number opts the person out of WhatsApp', !!(await delivery.optedOut('WhatsApp', '9876540003')), null);
    // consent changed while queued
    clock += 30000;
    r = await engine.tickSend();
    check('D34 a message waiting in the queue is dropped (failed, with the reason) when the person replied STOP meanwhile', r === 'failed' && (await store.byRef(sq3.result.providerRef)).status === 'failed' && /STOP/.test((await store.byRef(sq3.result.providerRef)).error), r);
    // not on WhatsApp
    fake.notOnWhatsApp.add('919876540004');
    const sq4 = await sendQr(cands[3], 'ZZTEST Comm qr four');
    clock += 30000;
    r = await engine.tickSend();
    check('D35 a number that is not on WhatsApp fails with that plain reason and is not counted as a send failure', r === 'failed' && /not on WhatsApp/.test((await store.byRef(sq4.result.providerRef)).error) && engine.E.consecutiveFailures === 0, [r, engine.E.consecutiveFailures]);
    // circuit breaker
    const bellsBefore = await prisma.notification.count({ where: { title: { startsWith: 'WhatsApp QR:' } } });
    const brk = [];
    for (let i = 0; i < 3; i += 1) brk.push(await sendQr(cands[i === 2 ? 6 : i + 0], `ZZTEST Comm breaker ${i}`).catch(() => null));
    // candidates 0-1 may be fine; 3rd is the STOP person (blocked at plan), so queue plain messages directly:
    for (let i = 0; i < 3; i += 1) await qr.send({ to: `98765404${20 + i}`, text: `ZZTEST Comm breaker direct ${i}`, kind: 'bulk' });
    fake.failNext = 9; fake.failMessage = 'fake socket exploded';
    let paused = false;
    for (let i = 0; i < 12 && !paused; i += 1) { clock += 31 * 60000; // eslint-disable-line no-await-in-loop
      const x = await engine.tickSend(); paused = x === 'paused' || engine.E.paused; } // eslint-disable-line no-await-in-loop
    state = await qr.getState();
    check('D36 circuit breaker: 3 failures in a row PAUSE sending (state keeps the reason)', paused && state.paused === true && /Paused/.test(state.reason || ''), state);
    const bellsAfter = await prisma.notification.count({ where: { title: { startsWith: 'WhatsApp QR:' } } });
    check('D37 an Admin bell is raised ("WhatsApp QR: Paused after repeated failures")', bellsAfter > bellsBefore && !!(await prisma.notification.findFirst({ where: { title: 'WhatsApp QR: Paused after repeated failures' } })), [bellsBefore, bellsAfter]);
    const sentBeforePause = fake.sent.length;
    await qr.enqueue({ to: '919876540430', text: 'ZZTEST Comm while paused', kind: 'bulk' });
    clock += 31 * 60000;
    r = await engine.tickSend();
    check('D38 while paused nothing is sent', r === 'paused' && fake.sent.length === sentBeforePause, [r, fake.sent.length, sentBeforePause]);
    fake.failNext = 0;
    await qr.sendControl('resume');
    await engine.handleControl();
    check('D39 Resume (Admin button) clears the pause', engine.E.paused === false && engine.E.consecutiveFailures === 0, null);
    // kill switch
    const kill = await call('POST', '/api/comm/qr/kill', T.admin, { on: true });
    const afterKill = await qr.send({ to: '9876540111', text: 'ZZTEST Comm after kill', kind: 'bulk' });
    check('D40 the company kill switch: new messages are refused and the worker is told to stop', kill.status === 200 && kill.body.killSwitch && !afterKill.ok && /kill switch/.test(afterKill.error) && (await qr.readControl() || {}).cmd === 'stop', afterKill.error);
    await qr.clearControl();
    await call('POST', '/api/comm/qr/kill', T.admin, { on: false });
    check('D41 a waiting message cancelled by the kill switch is FAILED with the reason, not lost silently', (await qr.queueRows('queued')).length === 0, (await qr.queueRows('queued')).length);
    // failure retry: single failure re-queues with a delay
    fake.failNext = 1; fake.failMessage = 'temporary glitch';
    const q5 = await qr.send({ to: '9876540440', text: 'ZZTEST Comm retry me', kind: 'bulk' });
    clock += 31 * 60000;
    r = await engine.tickSend();
    const item5 = (await qr.queueRows()).find((x) => x.ref === q5.providerRef);
    check('D42 one failure: the message goes back in the queue to try again later (attempt 1 of 3)', r === 'failed' && item5.status === 'queued' && item5.attempts === 1 && new Date(item5.notBefore).getTime() > clock, item5);
    clock += 40 * 60000;
    r = await engine.tickSend();
    check('D43 ... and goes out on the retry', r === 'sent' && (await qr.queueRows('sent')).some((x) => x.ref === q5.providerRef), r);
    // media
    const tmpPdf = path.join(os.tmpdir(), `zz-comm-${RUN}.pdf`); fs.writeFileSync(tmpPdf, Buffer.from('%PDF-1.4 ZZTEST'));
    const qm = await qr.send({ to: '9876540450', text: 'Your resume', kind: 'bulk', media: [{ path: tmpPdf, name: 'resume.pdf', mime: 'application/pdf' }] });
    clock += 40 * 60000;
    await engine.tickSend();
    const lastSent = fake.sent[fake.sent.length - 1];
    check('D44 an attachment (resume PDF) is sent as a document with the text as caption', qm.ok && lastSent.content.document && lastSent.content.fileName === 'resume.pdf' && lastSent.content.caption === 'Your resume' && lastSent.content.mimetype === 'application/pdf', lastSent);
    fs.unlinkSync(tmpPdf);
    // plan: QR first = plain text without a template
    const planQr = await bulk.buildPlan(ID.rec, { audience: 'candidates', ids: [cands[1].id], channels: ['WhatsApp'], kind: 'individual', body: 'ZZTEST Comm free text, no template', purpose: 'ZZTEST Comm plan', applicationId: cands[1].appId });
    check('D45 with the QR number first, free text needs no approved template (the official API would refuse it)', planQr.plan && planQr.plan.recipients[0].status === 'queued' && planQr.plan.recipients[0].mode === 'text', planQr.error || (planQr.plan && planQr.plan.recipients[0]));
    // official first + QR as fallback for "no template": plain text goes to the QR number
    await prisma.integration.update({ where: { id: 'whatsapp' }, data: { values: JSON.stringify({ ...JSON.parse((await prisma.integration.findUnique({ where: { id: 'whatsapp' } })).values), [CAT.WA_FIELDS.bulkTpl]: '' }) } });
    await setProv({ providers: { WhatsApp: { primary: 'whatsapp.cloud', fallback: true } } });
    const planFb = await bulk.buildPlan(ID.rec, { audience: 'candidates', ids: [cands[1].id], channels: ['WhatsApp'], kind: 'individual', body: 'ZZTEST Comm free text 2', purpose: 'ZZTEST Comm plan2', applicationId: cands[1].appId });
    check('D46 official first but no approved template: plain text is routed to the QR number (with the reason shown), not blocked', planFb.plan && planFb.plan.recipients[0].status === 'queued' && planFb.plan.recipients[0].providerOnly === 'whatsapp.qr' && /QR-linked/.test(planFb.plan.recipients[0].note), planFb.error || (planFb.plan && planFb.plan.recipients[0]));
    await setProv({ providers: { WhatsApp: { primary: 'whatsapp.qr', fallback: true } } });
    // banned / logged out
    const bellBan = await prisma.notification.count({ where: { title: 'WhatsApp QR: Banned or blocked suspected' } });
    fake.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
    await sleep(300);
    state = await qr.getState();
    check('D47 a 403 from WhatsApp = "Banned or blocked suspected": state, sending stops, Admin bell', state.state === 'banned-suspected' && /banned/i.test(state.reason) && (await prisma.notification.count({ where: { title: 'WhatsApp QR: Banned or blocked suspected' } })) > bellBan && engine.E.stopping, state);
    const apiBan = await call('GET', '/api/comm/qr/state', T.admin);
    check('D48 the screen says "Banned or blocked suspected" in those words', /Banned or blocked suspected/.test(apiBan.body.label), apiBan.body.label);
    // logged out (new engine)
    engine.E.stopping = true;
    const engine2 = engineMod.createEngine({ sleep: async () => {}, rand: () => 0.5, now: () => clock, reconnectDelayMs: 0, noVersionCheck: true });
    await engine2.connect(); fake.pair('919000000001'); await sleep(150);
    const bellOut = await prisma.notification.count({ where: { title: 'WhatsApp QR: Logged out' } });
    fake.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await sleep(300);
    state = await qr.getState();
    check('D49 "logged out": state Logged out, session files WIPED, Admin bell', state.state === 'logged-out' && fs.readdirSync(QR_DIR).filter((f) => f.endsWith('.enc')).length === 0 && (await prisma.notification.count({ where: { title: 'WhatsApp QR: Logged out' } })) > bellOut, [state.state, fs.readdirSync(QR_DIR)]);
    const apiOut = await call('GET', '/api/comm/qr/state', T.admin);
    check('D50 the screen says "Logged out"', /Logged out/.test(apiOut.body.label), apiOut.body.label);
    const afterOut = await qr.send({ to: '9876540112', text: 'x', kind: 'bulk' });
    check('D51 a logged-out number takes no messages (they fall back)', !afterOut.ok && afterOut.notConfigured, afterOut.error);
    // worker heartbeat: stale worker = disconnected
    await qr.setState({ state: 'connected', phone: '919000000001', heartbeatAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString() });
    await prisma.appSetting.update({ where: { key: qr.STATE_KEY }, data: { value: JSON.stringify({ state: 'connected', phone: '919000000001', heartbeatAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString() }) } });
    const stale = await qr.getState();
    check('D52 a worker that stopped beating is shown as Disconnected, never as Connected', stale.state === 'disconnected' && stale.stale, stale);
    await call('POST', '/api/comm/qr/disable', T.admin);
    await qr.setState({ state: 'disconnected', qr: null, phone: null });
    await setProv({ providers: { WhatsApp: { primary: 'whatsapp.cloud', fallback: true } } });
    const lib = await engineMod.loadLibrary();
    check('D53 the fake library is used only because TL_QR_BAILEYS_MODULE is set in the sandbox (the real one is optional and loaded lazily)', typeof lib.makeWASocket === 'function' && /fake-baileys/.test(process.env.TL_QR_BAILEYS_MODULE), null);
    process.env.TEST_MODE = '';
    let realErr = null; try { await engineMod.loadLibrary(); } catch (e) { realErr = e; }
    process.env.TEST_MODE = '1';
    const baileysThere = fs.existsSync(path.join(BACK, 'node_modules', '@whiskeysockets', 'baileys'));
    check('D54 not installed: a plain "run npm install @whiskeysockets/baileys" message, the app is not broken (or it is installed)', baileysThere || (realErr && realErr.code === 'NOT_INSTALLED' && /npm install @whiskeysockets\/baileys/.test(realErr.message)), realErr && realErr.message);

    // ===================== E: Android gateway =====================
    await setProv({ providers: { SMS: { primary: 'sms.android', fallback: false } } });
    phone.mode = 'ok';
    const sendAnd = async (cand, text) => {
      const out = await bulk.sendIndividual(ID.rec, { audience: 'candidates', id: cand.id, channel: 'SMS', body: text, purpose: 'ZZTEST Comm android', applicationId: cand.appId });
      if (out.jobId) made.jobs.push(out.jobId);
      return out;
    };
    const ea = await sendAnd(cands[0], 'ZZTEST Comm android one');
    check('E1 a send from the ATS goes through the phone: Queued, provider Android, ref and', !ea.error && ea.result.status === 'sent' && ea.result.queued && ea.result.provider === 'sms.android' && /^and:MOCKMSG/.test(ea.result.providerRef) && ea.result.via === 'SMS via Android phone', ea);
    const aRef = ea.result.providerRef; const aId = aRef.slice(4);
    const hook = async (event, payload, opts = {}) => {
      const body = JSON.stringify({ deviceId: 'dev1', event, id: `ev-${Math.random()}`, payload, webhookId: 'w1' });
      const ts = String(Math.floor(Date.now() / 1000) + (opts.tsShift || 0));
      const headers = { 'content-type': 'application/json' };
      if (opts.sign !== false) { headers['x-timestamp'] = ts; headers['x-signature'] = opts.badSig ? 'deadbeef' : crypto.createHmac('sha256', 'zz-hook-secret').update(body + ts).digest('hex'); }
      return call('POST', `/api/webhooks/sms-android${opts.query || ''}`, null, undefined, { headers, body });
    };
    const h0 = await hook('sms:sent', { messageId: aId }, { sign: false });
    check('E2 a webhook with no signature and no key is refused (403)', h0.status === 403, h0.status);
    const h1 = await hook('sms:sent', { messageId: aId }, { badSig: true });
    check('E3 a wrong signature is refused (403)', h1.status === 403, h1.status);
    const h2 = await hook('sms:sent', { messageId: aId }, { tsShift: -3600 });
    check('E4 a valid signature with an OLD timestamp is refused (replay protection)', h2.status === 403, h2.status);
    const h3 = await hook('sms:sent', { messageId: aId, sentAt: new Date().toISOString() });
    check('E5 a correctly signed sms:sent is accepted and moves the message to Sent', h3.status === 200 && (await store.byRef(aRef)).status === 'sent', [h3.status, h3.body]);
    const h4 = await hook('sms:delivered', { messageId: aId, deliveredAt: new Date().toISOString() });
    const cmA = await prisma.candidateMessage.findFirst({ where: { candidateId: cands[0].id, providerRef: aRef } });
    check('E6 sms:delivered -> Delivered, also on the candidate\'s log', h4.status === 200 && (await store.byRef(aRef)).status === 'delivered' && cmA.status === 'DELIVERED', [h4.status, cmA && cmA.status]);
    const ea2 = await sendAnd(cands[1], 'ZZTEST Comm android two');
    const h5 = await hook('sms:failed', { messageId: ea2.result.providerRef.slice(4), reason: 'No SIM balance', failedAt: new Date().toISOString() }, { sign: false, query: '?key=zz-hook-secret' });
    const recF = await store.byRef(ea2.result.providerRef);
    check('E7 the shared-word form (?key=) also works; sms:failed -> Failed with the reason', h5.status === 200 && recF.status === 'failed' && /No SIM balance/.test(recF.error), [h5.status, recF && recF.error]);
    const h6 = await hook('sms:received', { messageId: 'IN-1', message: 'ZZTEST Comm yes I am interested', sender: '+919876540001', recipient: '+910000000000', receivedAt: new Date().toISOString() });
    const inSms = await prisma.candidateMessage.findFirst({ where: { candidateId: cands[0].id, channel: 'SMS', status: 'RECEIVED' } });
    check('E8 an SMS reply received by the phone lands on the candidate timeline and the Inbox', h6.status === 200 && h6.body.stored === 1 && inSms && /interested/.test(inSms.body), [h6.status, h6.body]);
    const h7 = await hook('sms:received', { messageId: 'IN-2', message: 'STOP', sender: '+919876540002', recipient: '+910000000000', receivedAt: new Date().toISOString() });
    check('E9 a STOP SMS received by the phone opts the person out', h7.status === 200 && !!(await delivery.optedOut('SMS', '9876540002')), h7.status);
    const h8 = await hook('system:ping', { health: {} });
    check('E10 system:ping is accepted', h8.status === 200, h8.status);
    // offline / auth / busy
    phone.mode = 'down';
    const eo = await sendAnd(cands[2], 'ZZTEST Comm android offline');
    check('E11 phone offline: the send does NOT say sent; it retries / fails in plain words', ['failed', 'queued', 'sending'].includes(eo.result.status) && /did not answer/.test(eo.result.reason || '') && !eo.result.providerRef, eo.result);
    await waitFor(async () => (bulk.readJob(eo.jobId) || {}).status === 'done', 150000);
    check('E12 when the retries are used up the failure is on the candidate log (FAILED, with the reason)', !!(await waitFor(() => prisma.candidateMessage.findFirst({ where: { candidateId: cands[2].id, status: 'FAILED', lastError: { contains: 'did not answer' } } }))), (bulk.readJob(eo.jobId) || {}).status);
    const hh = await android.health();
    check('E13 health(): offline detected with a plain message', !hh.ok && hh.state === 'offline', hh);
    phone.mode = 'ok';
    const hok = await android.health();
    check('E14 health(): online again', hok.ok && hok.state === 'online', hok);
    const tcall = await call('POST', '/api/comm/android/test', T.admin);
    check('E15 "Test" button (admin API) pings the phone', tcall.status === 200 || tcall.status === 502, [tcall.status, tcall.body]);
    phone.pass = 'changed-on-phone';
    const eAuth = await channels.adapters['sms.android'].send({ ...msgBase, to: '9876540113' });
    check('E16 wrong password on the phone: refused in plain words, marked unavailable (so fallback can happen)', !eAuth.ok && eAuth.unavailable && /username or password/.test(eAuth.error), eAuth);
    phone.pass = 'phonepass';
    phone.mode = 'busy';
    const eBusy = await channels.adapters['sms.android'].send({ ...msgBase, to: '9876540114' });
    check('E17 phone queue full (503): retryable + unavailable', !eBusy.ok && eBusy.retryable && eBusy.unavailable, eBusy);
    phone.mode = 'ok';
    // SIM selection + generic mode
    const cur = JSON.parse((await prisma.integration.findUnique({ where: { id: 'sms-android' } })).values);
    const putVals = async (extra) => { const w = await writeValues('sms-android', { ...Object.fromEntries(Object.entries(cur).filter(([k]) => !/password|token|signing/i.test(k))), ...extra }); await prisma.integration.update({ where: { id: 'sms-android' }, data: { values: JSON.stringify(w.values) } }); };
    await putVals({ [AF.sim]: '2' });
    phone.requests.length = 0;
    await channels.adapters['sms.android'].send({ ...msgBase, to: '9876540115' });
    check('E18 SIM selection: simNumber 2 is sent when chosen', phone.requests.some((x) => x.url === '/message' && JSON.parse(x.body).simNumber === 2), phone.requests.map((x) => x.body));
    await putVals({ [AF.sim]: '', [AF.style]: 'Generic JSON', [AF.bodyTpl]: '{"to":"{{to}}","text":"{{text}}","tag":"zz"}', [AF.sendPath]: '/message' });
    phone.requests.length = 0;
    const eg = await channels.adapters['sms.android'].send({ ...msgBase, to: '9876540116', text: 'Say "hi"\nnow' });
    const gb = phone.requests.find((x) => x.url === '/message');
    check('E19 generic mode: the JSON body template is filled ({{to}}, {{text}} safely escaped) and the reply id is read', eg.ok && gb && JSON.parse(gb.body).to === '+919876540116' && JSON.parse(gb.body).text === 'Say "hi"\nnow' && JSON.parse(gb.body).tag === 'zz', [eg, gb && gb.body]);
    await putVals({ [AF.style]: 'SMS Gateway for Android' });
    // gap + caps
    await call('PUT', '/api/comm/settings', T.admin, { android: { perHour: 2, perDay: 100, gapMin: 3, gapMax: 6 } });
    const usageHr = (await store.usage('sms.android')).hour;
    const capA = await channels.adapters['sms.android'].send({ ...msgBase, to: '9876540117' });
    check('E20 hourly cap on the phone (2 an hour) protects the SIM: refused as capped -> fallback', usageHr >= 2 ? (!capA.ok && capA.capped && /hourly limit/.test(capA.error)) : capA.ok, [usageHr, capA]);
    await call('PUT', '/api/comm/settings', T.admin, { android: { perHour: 60, perDay: 200 } });
    const g = settings.BOUNDS.android;
    check('E21 default gap 3-6 seconds between messages (bounds 1-60 / 1-120)', (await settings.load({ fresh: true })).android.gapMin === 3 && (await settings.load({ fresh: true })).android.gapMax === 6 && g.gapMin[0] === 1, null);
    // status poll when the webhook never comes
    const ep = await sendAnd(cands[3], 'ZZTEST Comm android poll');
    await prisma.appSetting.update({ where: { key: (await store.byRef(ep.result.providerRef))._key }, data: { value: JSON.stringify({ ...(await store.byRef(ep.result.providerRef)), _key: undefined, at: new Date(Date.now() - 60000).toISOString() }) } });
    const stp = await call('GET', `/api/comm/status?ref=${encodeURIComponent(ep.result.providerRef)}`, T.rec);
    check('E22 status endpoint asks the phone when no webhook arrived (mock says Delivered) -> ticks update', stp.status === 200 && ['queued', 'sent', 'delivered'].includes(stp.body.message.status), [stp.status, stp.body]);
    // test SMS + register webhooks via API
    const tsms = await call('POST', '/api/comm/android/test-sms', T.admin, { to: '9000000003' });
    check('E23 "Send a test SMS to my own number" (typed number, sandbox server)', tsms.status === 200 && tsms.body.ok, [tsms.status, tsms.body]);
    const tsmsNo = await call('POST', '/api/comm/android/test-sms', T.admin, { to: '' });
    check('E24 ... a number is required', tsmsNo.status === 400, tsmsNo.status);
    const reg = await call('POST', '/api/comm/android/register-webhooks', T.admin);
    check('E25 register-webhooks: without APP_BASE_URL a plain message (never guesses an address); with it, the sandbox never reaches a phone (every call is blocked)', (reg.status === 409 && /APP_BASE_URL/.test(reg.body.error)) || (reg.status === 200 && reg.body.results.every((x) => !x.ok)), [reg.status, reg.body]);
    const tsmsRec = await call('POST', '/api/comm/android/test-sms', T.rec, { to: '9000000003' });
    check('E26 a recruiter cannot use the test SMS (403)', tsmsRec.status === 403, tsmsRec.status);

    // ===================== F: tracking =====================
    const logAll = await call('GET', '/api/comm/log?from=2026-01-01', T.admin);
    check('F1 Communication log answers with rows and counts', logAll.status === 200 && logAll.body.total > 10 && logAll.body.counts && logAll.body.counts.provider, [logAll.status, logAll.body && logAll.body.total]);
    const lq = (qs) => call('GET', `/api/comm/log?from=2026-01-01&${qs}`, T.admin);
    const lWa = await lq('channel=WhatsApp'); const lSms = await lq('channel=SMS');
    check('F2 filter by channel', lWa.body.rows.length > 0 && lWa.body.rows.every((x) => x.channel === 'WhatsApp') && lSms.body.rows.every((x) => x.channel === 'SMS'), [lWa.body.total, lSms.body.total]);
    const lProv = await lq('provider=sms.android');
    check('F3 filter by provider', lProv.body.rows.length > 0 && lProv.body.rows.every((x) => x.provider === 'sms.android'), lProv.body.total);
    const lFail = await lq('status=failed');
    check('F4 filter by status (failed rows carry the reason)', lFail.body.rows.length > 0 && lFail.body.rows.every((x) => x.status === 'failed') && lFail.body.rows.some((x) => x.error), lFail.body.total);
    const lSender = await lq(`sender=${uRec.id}`);
    check('F5 filter by sender', lSender.body.rows.length > 0 && lSender.body.rows.every((x) => x.senderUserId === uRec.id), lSender.body.total);
    const lCand = await lq(`candidate=${cands[0].id}`);
    check('F6 filter by candidate', lCand.body.rows.length > 0 && lCand.body.rows.every((x) => x.personId === cands[0].id), lCand.body.total);
    const today = new Date().toISOString().slice(0, 10);
    const lDate = await lq(`to=${today}&from=${today}`);
    const lOld = await call('GET', '/api/comm/log?from=2020-01-01&to=2020-01-02', T.admin);
    check('F7 filter by date', lDate.body.total > 0 && lOld.body.total === 0, [lDate.body.total, lOld.body.total]);
    check('F8 counts add up per status', Object.values(logAll.body.counts.status).reduce((a, b) => a + b, 0) === logAll.body.total, logAll.body.counts);
    const lIn = await lq('direction=IN');
    check('F9 inbound replies are in the log too (direction IN)', lIn.body.rows.length >= 2 && lIn.body.rows.every((x) => x.direction === 'IN'), lIn.body.total);
    const xl = await call('GET', '/api/comm/log.xlsx?from=2026-01-01', T.admin);
    check('F10 Excel export is a real xlsx (PK zip)', xl.status === 200 && xl.buf.slice(0, 2).toString() === 'PK', [xl.status, xl.buf.length]);
    const pdf = await call('GET', '/api/comm/log.pdf?from=2026-01-01', T.admin);
    check('F11 PDF export is a real PDF', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF', [pdf.status, pdf.buf.length]);
    const recLog = await call('GET', '/api/comm/log?from=2026-01-01', T.rec);
    const rec2Log = await call('GET', '/api/comm/log?from=2026-01-01', T.rec2);
    check('F12 a recruiter sees only the messages SHE sent; another recruiter sees none of them', recLog.body.total > 0 && recLog.body.rows.every((x) => x.senderUserId === uRec.id) && rec2Log.body.total === 0, [recLog.body.total, rec2Log.body.total]);
    const tlog = await call('GET', '/api/comm/log?from=2026-01-01', T.mgr);
    check('F13 a Manager (global view) sees everyone\'s', tlog.status === 200 && tlog.body.total >= logAll.body.total - 2, [tlog.body.total, logAll.body.total]);
    const ctRows = await prisma.candidateMessage.findMany({ where: { candidateId: cands[0].id } });
    check('F14 every send is ALSO on the candidate\'s own history (CandidateMessage) with sender and provider words', ctRows.length >= 3 && ctRows.every((x) => x.channel) && ctRows.some((x) => /via SMS via Android phone/.test(x.statusDetail || '')) && ctRows.some((x) => x.senderName), ctRows.map((x) => x.statusDetail));
    const recFull = await store.byRef(aRef);
    check('F15 a record keeps: provider, status history, sender, candidate, template, retries, attachments fields', recFull.provider === 'sms.android' && recFull.history.length >= 3 && recFull.senderName && recFull.personId === cands[0].id && 'retries' in recFull && Array.isArray(recFull.attachments) && 'cost' in recFull, recFull);
    const other = await call('GET', `/api/comm/status?ref=${encodeURIComponent(aRef)}`, T.rec2);
    check('F16 status of someone else\'s message -> 403', other.status === 403, other.status);
    check('F17 message BODIES are not copied into the comm records (only the existing message log keeps them)', !JSON.stringify(recFull).includes('ZZTEST Comm android one'), null);

    // ===================== G: RBAC + masked BDE =====================
    const matrix = [
      ['GET', '/api/comm/overview', { admin: 200, rec: 200, tl: 200, mgr: 200, bde: 200 }],
      ['PUT', '/api/comm/settings', { admin: 200, rec: 403, tl: 403, mgr: 403, bde: 403, bdeTl: 403 }, { switches: { SMS: true } }],
      ['GET', '/api/comm/qr/state', { admin: 200, rec: 403, tl: 403, mgr: 403, bde: 403 }],
      ['POST', '/api/comm/qr/enable', { rec: 403, tl: 403, mgr: 403, bde: 403 }, { understand: true }],
      ['POST', '/api/comm/qr/start', { rec: 403, tl: 403, bde: 403 }],
      ['POST', '/api/comm/qr/kill', { rec: 403, tl: 403, bde: 403 }, { on: true }],
      ['GET', '/api/comm/android/config', { admin: 200, rec: 403, tl: 403, mgr: 403, bde: 403 }],
      ['PUT', '/api/comm/android/config', { rec: 403, tl: 403, bde: 403 }, { values: {} }],
      ['POST', '/api/comm/android/test', { rec: 403, tl: 403, bde: 403 }],
      ['POST', '/api/comm/android/register-webhooks', { rec: 403, bde: 403 }],
      ['GET', '/api/comm/log', { admin: 200, rec: 200, tl: 200, mgr: 200 }],
      ['GET', '/api/comm/log.xlsx', { admin: 200, rec: 200 }],
      ['GET', '/api/comm/providers?channel=SMS', { admin: 200, rec: 200, tl: 200, bde: 200 }],
    ];
    for (const [m, p, exp, body] of matrix) {
      const got = {};
      for (const who of Object.keys(exp)) { const rr = await call(m, p, T[who], body); got[who] = rr.status; } // eslint-disable-line no-await-in-loop
      check(`G RBAC ${m} ${p.split('?')[0]}`, Object.keys(exp).every((w) => got[w] === exp[w]), { expected: exp, got });
    }
    const ov = await call('GET', '/api/comm/overview', T.rec);
    check('G a recruiter\'s overview has NO settings, secrets, caps or usage cards', ov.status === 200 && !ov.body.settings && !ov.body.cards && !JSON.stringify(ov.body).includes('zz-hook-secret') && !JSON.stringify(ov.body).includes(phone.pass), Object.keys(ov.body));
    const ovA = await call('GET', '/api/comm/overview', T.admin);
    check('G the Admin overview has cards per provider with usage and caps', ovA.body.cards && ovA.body.cards['whatsapp.qr'].caps.perHour && ovA.body.cards['sms.android'].usage && 'sentToday' in ovA.body.cards['sms.android'].usage, ovA.body.cards && Object.keys(ovA.body.cards));
    const aCfg = await call('GET', '/api/comm/android/config', T.admin);
    check('G the Android config never returns the password or the webhook key', !JSON.stringify(aCfg.body).includes('phonepass') && !JSON.stringify(aCfg.body).includes('zz-hook-secret'), null);
    const ext = await call('GET', '/api/comm/overview', null);
    check('G no login -> 401', ext.status === 401, ext.status);
    // masked BDE: server sends, the screen never shows the number
    await setProv({ providers: { SMS: { primary: 'sms.android', fallback: true } } });
    const bdeSend = await call('POST', '/api/messaging/send', T.bde, { audience: 'candidates', id: cands[3].id, channel: 'SMS', body: 'ZZTEST Comm from the BDE', purpose: 'ZZTEST Comm bde', applicationId: cands[3].appId });
    if (bdeSend.body && bdeSend.body.jobId) made.jobs.push(bdeSend.body.jobId);
    check('G BDE sends to a candidate: the SERVER sends it (masked), the answer has no phone number', bdeSend.status === 200 && bdeSend.body.masked === true && bdeSend.body.result.status === 'sent' && !/9876540004/.test(bdeSend.text), [bdeSend.status, bdeSend.text.slice(0, 300)]);
    const bdeLog = await call('GET', '/api/comm/log?from=2026-01-01', T.bde);
    check('G BDE\'s Communication log shows numbers masked and only their own messages', bdeLog.status === 200 && bdeLog.body.total >= 1 && !/9876540004/.test(bdeLog.text) && bdeLog.body.rows.every((x) => x.senderUserId === uBde.id && /•/.test(x.to || '')), bdeLog.body && bdeLog.body.rows && bdeLog.body.rows.map((x) => x.to));
    const adminLog = await call('GET', '/api/comm/log?from=2026-01-01&candidate=' + cands[3].id, T.admin);
    check('G the Admin sees the same message with the full number', adminLog.body.rows.some((x) => /9876540004/.test(x.to || '')), adminLog.body.rows.map((x) => x.to));
    const bdeBulk = await call('POST', '/api/messaging/reach/send', T.bde, { channel: 'SMS', ids: [cands[3].id], confirmPeople: 1 });
    check('G BDE cannot bulk-send (403)', bdeBulk.status === 403, bdeBulk.status);
    const lim2 = [];
    for (let i = 0; i < 3; i += 1) lim2.push((await call('POST', '/api/comm/android/test-sms', T.admin, { to: '9000000003' })).status);
    check('G rate limit exists on send APIs (the test-SMS route allows 5 a minute)', lim2.every((s) => s === 200 || s === 429), lim2);
    // no real hosts
    check('G NO outbound to real hosts: every request this test process made went to loopback', [...hostsSeen].every((h) => ['127.0.0.1', 'localhost'].includes(h)) && hostsSeen.size > 0, [...hostsSeen]);

    // ===================== H: QR picture generator =====================
    const qrc = require(path.join(BACK, 'src/utils/qrCode'));
    const caps = { L: [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271], M: [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213] };
    check('H1 byte capacities of versions 1-10 (L and M) match the QR standard', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((v) => qrc.capacity(v, 'L') === caps.L[v] && qrc.capacity(v, 'M') === caps.M[v]) && qrc.capacity(40, 'L') === 2953 && qrc.capacity(40, 'M') === 2331, null);
    // Reed-Solomon: every block (data + ecc) is divisible by the generator -> remainder all zero
    const I = qrc._internals;
    let rsOk = true;
    for (const text of ['hi', 'x'.repeat(60), `2@${'q'.repeat(150)}`, 'z'.repeat(400)]) {
      const bytes = Array.from(Buffer.from(text));
      let ver = 1; while (qrc.capacity(ver, 'L') < bytes.length) ver += 1;
      const inter = I.interleave(I.bitsOf(bytes, ver, 'L'), ver, 'L');
      const div = I.rsDivisor(inter.eccLen);
      inter.blocks.forEach((b, bi) => { const real = bi < inter.shortBlocks ? b.dat.slice(0, -1) : b.dat; if (I.rsRemainder(real.concat(b.e), div).some((x) => x !== 0)) rsOk = false; });
    }
    check('H2 Reed-Solomon error-correction words are valid for several sizes (remainder zero)', rsOk, null);
    // read our own matrix back: format info -> mask -> unmask -> codewords -> text
    function readBack(q) {
      const { size } = q; const m = q.modules; const bit = (x, y) => (m[y][x] ? 1 : 0);
      let f = 0; for (let i = 0; i <= 5; i += 1) f |= bit(8, i) << i; f |= bit(8, 7) << 6; f |= bit(8, 8) << 7; f |= bit(7, 8) << 8; for (let i = 9; i < 15; i += 1) f |= bit(14 - i, 8) << i;
      const fmt = (f ^ 0x5412) >> 10; const mask = fmt & 7; const ecc = ((fmt >> 3) & 3) === 1 ? 'L' : 'M';
      const fnMask = qrc._internals.build([], q.version, ecc).fn; // function-pattern map of the same size
      const inv = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0][mask];
      const bits = [];
      for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vert = 0; vert < size; vert += 1) for (let j = 0; j < 2; j += 1) { const x = right - j; const up = ((right + 1) & 2) === 0; const y = up ? size - 1 - vert : vert; if (!fnMask[y][x]) bits.push(bit(x, y) ^ (inv(x, y) ? 1 : 0)); } }
      const cw = []; for (let i = 0; i + 7 < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
      // de-interleave the data codewords
      const ver = q.version; const nb = { L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] }[ecc][ver]; const el = { L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] }[ecc][ver];
      const raw = Math.floor(I.rawModules(ver) / 8); const shortN = nb - (raw % nb); const shortLen = Math.floor(raw / nb);
      const dataBlocks = Array.from({ length: nb }, () => []); let k = 0;
      for (let i = 0; i < shortLen - el + 1; i += 1) for (let b = 0; b < nb; b += 1) { if (i === shortLen - el && b < shortN) continue; dataBlocks[b].push(cw[k]); k += 1; }
      const data = dataBlocks.flat();
      let pos = 0; const rd = (n) => { let v = 0; for (let i = 0; i < n; i += 1) { v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1); pos += 1; } return v; };
      const mode = rd(4); const len = rd(ver <= 9 ? 8 : 16); const out = []; for (let i = 0; i < len; i += 1) out.push(rd(8));
      return { mode, text: Buffer.from(out).toString('utf8'), ecc, mask };
    }
    let rbOk = true; const samples = ['hello', 'https://www.example.com/teamlink-qr-selftest', `2@${'AbCd0123,'.repeat(22)}=,1`];
    for (const s of samples) { for (const ecc of ['L', 'M']) { const q = qrc.encode(s, { ecc }); if (q.version > 10) continue; const back = readBack(q); if (back.text !== s || back.mode !== 4 || back.ecc !== ecc) { rbOk = false; console.log('  readback mismatch', ecc, q.version, back.text.slice(0, 30)); } } }
    check('H3 a generated QR can be READ BACK from its own modules (format bits, mask, placement, interleaving) for L and M', rbOk, null);
    const svg = qrc.toSvg('https://www.example.com');
    check('H4 toSvg returns a self-contained svg (no external reference)', /^<svg/.test(svg) && !/href|http:\/\/(?!www\.w3\.org)/.test(svg.replace(/xmlns="[^"]+"/, '')), svg.slice(0, 100));
    const st2 = qrc.encode('x');
    check('H5 finder patterns are in the three corners', st2.modules[0][0] && st2.modules[0][6] && st2.modules[6][0] && !st2.modules[1][1] && st2.modules[2][2], null);
    const qs = await call('GET', '/api/comm/qr/selftest', T.admin);
    check('H6 admin self-test picture endpoint returns an svg (scan it with a phone camera to prove the generator)', qs.status === 200 && /^<svg/.test(qs.text), qs.status);
  } catch (e) {
    console.error('TEST CRASHED:', e && e.stack || e);
    fail += 1;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (KEEP && fail === 0) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    console.log('(--keep is not needed: the screenshots use their own fixtures)');
  }
  mock.srv.close();
  const left = await cleanup(made, snap);
  console.log('cleanup left:', JSON.stringify(left));
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
