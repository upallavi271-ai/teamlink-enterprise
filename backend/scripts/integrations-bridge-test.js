#!/usr/bin/env node
/**
 * CRM AND THE JOB PORTAL USE ADMINISTRATION > INTEGRATIONS (founder 2026-11-23: "Do the integrations in CRM and in the Job Portal. All the
 * information you need is in Administration > Integrations").
 *   Part A (this process): fake values in the sandbox COPY's integration store; the in-process bridge (utils/portalIntegrations.js
 *     valuesForPortal) returns exactly those; CRM senders read the store (the demo email's From name is the store's "Default from name", the
 *     AI assistant's SMS goes as the Bulk / General kind, the AI order is Claude -> fast AI -> local model). Sandbox: nothing is sent.
 *   Part B (a private server on the copy): GET /api/public/job-portal/integrations answers only this machine with the bridge secret and no
 *     proxy header; the portal side's loader (job-portal-app/embed/teamlink-integration.mjs) reads it over 127.0.0.1 only; no secret in any
 *     admin answer or in the server's log. (A channel the portal connected itself winning is proven by the portal's own test:
 *     job-portal-app/job_portal-main/api/test/host-integrations.test.mjs.)
 * SANDBOX ONLY:  TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> [TEST_PORTAL_E2E=1] node scripts/integrations-bridge-test.js
 *   Part C (TEST_PORTAL_E2E=1): the real embed host on a scratch database, asking this sandbox server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const ROOT = path.resolve(BACK, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-integ-bridge-${process.pid}.db`);
const CAPTURE = path.join(os.tmpdir(), `zz-integ-bridge-mail-${process.pid}.jsonl`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4400 + Math.floor(Math.random() * 400);
const API = `http://127.0.0.1:${PORT}/api`;
const PUSH_SECRET = `zz-bridge-secret-${process.pid}-abcdefgh`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', TEST_ALLOW_AI: '1', AI_PROVIDER: 'ollama', PORT: String(PORT), JWT_SECRET: 'integ-bridge-test',
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'zz-integration-bridge-test-key-0123456789',
  JOB_PORTAL_PUSH_SECRET: PUSH_SECRET, JOB_PORTAL_SYNC_TOKEN: 'zz-sync-token-bridge', TEST_MAIL_CAPTURE: CAPTURE,
};
Object.assign(process.env, env);

const FAKE = {
  smtpPass: 'ZZ-SMTP-PASS-778899', waToken: 'EAAZZ-WA-TOKEN-556677', smsKey: 'ZZ-SMS-KEY-334455', claudeKey: 'sk-ant-zz-claude-112233', groqKey: 'gsk_zz_groq_998877',
};
const SECRETS = Object.values(FAKE);

const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const store = require('../src/utils/integrationStore');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const hasSecret = (text) => SECRETS.filter((s) => String(text).includes(s));
let server; let serverLog = '';
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const f of [COPY, `${COPY}-wal`, `${COPY}-shm`, CAPTURE]) { try { fs.unlinkSync(f); } catch { /* none */ } } process.exit(code); }, 800);
}
// the copy's row is REPLACED by these fields only (its other fields hold secrets sealed with another machine's key)
async function save(id, values) {
  await store.integrationRow(id);
  await prisma.integration.update({ where: { id }, data: { values: '{}' } });
  const { values: next } = await store.writeValues(id, values);
  for (const k of Object.keys(next)) if (!(k in values)) delete next[k];
  await prisma.integration.update({ where: { id }, data: { values: JSON.stringify(next), connected: true, enabled: true } });
}
const stub = (rel, exports) => { const p = require.resolve(rel); const was = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return () => { if (was) require.cache[p] = was; else delete require.cache[p]; }; };

(async () => {
  // ---- the founder's Integrations, with fake values (copy only) -------------------------------------------------------------
  await save('email', { 'SMTP host': 'smtp.zz-store.test', Port: '587', 'From address': 'jobs@zz-store.test', Username: 'jobs@zz-store.test', 'Password / app key': FAKE.smtpPass, 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', 'Default from name': 'ZZ Store Sender' });
  await save('whatsapp', { 'Business phone number': '+91 90000 11111', 'Phone number ID': '109900112233', 'WhatsApp Business ID': '2009988', 'Permanent access token': FAKE.waToken, 'Template language code': 'en_US', 'Template name — bulk / general': 'zz_general_update', 'Template name — agreement link': '', 'Template namespace': '' });
  await save('sms', { 'Provider (MSG91 / Fast2SMS / Twilio)': 'MSG91', 'Sender ID (6 chars) / Twilio From number': 'ZZTEST', 'API key / Auth token': FAKE.smsKey, 'DLT template ID — bulk / general': '1107000000000000001' });
  await save('ai-claude', { 'Anthropic API key': FAKE.claudeKey, Model: 'claude-opus-5' });
  await save('ai-fast', { 'Groq API key': FAKE.groqKey });
  // the copy's default WhatsApp number (if it has a numbers list) sends with the Integrations > WhatsApp Business connection
  await prisma.$executeRawUnsafe(`UPDATE "WaNumber" SET "credSource" = 'legacy', "active" = 1 WHERE "isDefault" = 1 AND "removedAt" IS NULL`).catch(() => null);
  const WN = require('../src/utils/waNumbers');
  const usesList = await WN.hasNumbers().catch(() => false);

  // ---- part A: the in-process bridge ------------------------------------------------------------------------------------------
  const PI = require('../src/utils/portalIntegrations');
  const v = await PI.valuesForPortal();
  check('A1 email: the SMTP fields of Integrations > Email', v.email && v.email.host === 'smtp.zz-store.test' && v.email.port === 587 && v.email.encryption === 'STARTTLS' && v.email.user === 'jobs@zz-store.test' && v.email.pass === FAKE.smtpPass && v.email.fromAddress === 'jobs@zz-store.test' && v.email.fromName === 'ZZ Store Sender', v.email && { ...v.email, pass: '(hidden)' });
  if (!usesList) {
    check('A2 WhatsApp: phone number ID + token + bulk template + language; the agreement-link template is not handed over', v.whatsapp && v.whatsapp.phoneNumberId === '109900112233' && v.whatsapp.accessToken === FAKE.waToken && v.whatsapp.templateBulk === 'zz_general_update' && v.whatsapp.language === 'en_US' && !('templateAgreement' in v.whatsapp), v.whatsapp && { ...v.whatsapp, accessToken: '(hidden)' });
  } else {
    const d = await WN.defaultConfig().catch(() => null);
    check('A2 WhatsApp: the default number of the WhatsApp numbers list (this copy has a list): its ID, token, bulk template and language', d && d.configured
      ? (v.whatsapp && v.whatsapp.phoneNumberId === d.phoneId && v.whatsapp.accessToken === d.token && v.whatsapp.templateBulk === ((d.templates && d.templates.bulk) || '') && v.whatsapp.language === (d.language || 'en'))
      : !v.whatsapp, { ready: d && d.configured, why: d && d.reason, wa: v.whatsapp && { ...v.whatsapp, accessToken: '(hidden)' } });
  }
  const smsCfg = await require('../src/utils/smsGateway').smsConfig();
  console.log(`      (this copy: WhatsApp ${v.whatsapp ? 'handed over' : 'not ready'}, SMS ${smsCfg.configured ? 'ready' : `not ready: ${smsCfg.reason}`})`);
  check('A3 SMS: handed over as "TeamLink sends it" (no SMS key leaves TeamLink), exactly when the SMS channel is ready', (!!v.sms === !!smsCfg.configured) && (!v.sms || v.sms.relay === true) && !JSON.stringify(v.sms || {}).includes(FAKE.smsKey), { sms: v.sms, ready: smsCfg.configured, why: smsCfg.reason });
  check('A4 AI: the AI Assistant (Claude) key - the portal\'s AI speaks Anthropic - and never the Groq key', v.ai && v.ai.apiKey === FAKE.claudeKey && !JSON.stringify(v).includes(FAKE.groqKey));
  await prisma.integration.update({ where: { id: 'email' }, data: { enabled: false } });
  const off = await PI.valuesForPortal();
  check('A5 a channel switched off in Integrations is not handed over', !off.email && !!off.ai);
  await prisma.integration.update({ where: { id: 'email' }, data: { enabled: true } });
  check('A6 a nudge in the sandbox never contacts the portal', (await PI.pushAll()).email.skipped === 'sandbox');

  // ---- part A: CRM senders read the store --------------------------------------------------------------------------------------
  const DB = require('../src/crm/schema');
  const S = require('../src/crm/service');
  const PS = require('../src/crm/productSales');
  const SA = require('../src/crm/salesAgent');
  const AI = require('../src/utils/ai');
  await DB.ensure(); await PS.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  const now = new Date().toISOString();
  const mkLead = async (company, extra = {}) => { const id = S.newId('lead'); await S.insert('CrmLead', { id, company, contactName: 'Ravi', status: 'New', stage: 'New', source: 'Other', products: 'ATS', phone: `98${String(Date.now()).slice(-8)}`, createdAt: now, updatedAt: now, ...extra }); return DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', id); };
  const L = await mkLead(`ZZTEST BRIDGE ${process.pid}`, { email: `zz-bridge-${process.pid}@example.test` });
  try { fs.unlinkSync(CAPTURE); } catch { /* none */ }
  const dm = await PS.demoLink(admin, L.id, { channel: 'email' });
  const mails = fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : [];
  const demoMail = mails.find((m) => /demo/i.test(m.subject));
  check('A7 CRM demo email: sent (sandbox, SMTP not contacted) From the store\'s "Default from name" and From address, not a hard-coded name', !!demoMail && /^ZZ Store Sender <jobs@zz-store\.test>$/.test(demoMail.from), { dm: dm && (dm.error || dm.sent), from: demoMail && demoMail.from, n: mails.length });

  // the AI order and the AI assistant's SMS
  let claudeCalls = 0; let localCalls = 0; const fastCalls = [];
  AI.setTestProviders({
    claude: async () => { claudeCalls += 1; const e = new Error('overloaded'); e.status = 529; throw e; },
    ollama: async () => { localCalls += 1; return JSON.stringify({ reply: 'local answer', action: 'none' }); },
  });
  const unstubFast = stub('../src/utils/fastAi', { chat: async (system, history, opts) => { fastCalls.push(opts); return { text: JSON.stringify({ reply: 'Yes, each client gets its own login to review profiles.', action: 'none', unanswered: false, wantsHuman: false }), provider: 'Groq', model: 'llama', ms: 5 }; } });
  const sms = [];
  const unstubMsg = stub('../src/utils/messaging', { send: async (channel, args) => { sms.push({ channel, ...args }); return { ok: true, providerRef: 'zz-sms-1' }; } });
  await SA.save(admin, { on: true, maxPerDay: 20, useClaude: true });
  const L2 = await mkLead(`ZZTEST BRIDGE SMS ${process.pid}`);
  const out = await SA.respond({ channel: 'SMS', lead: L2, message: 'Does the client get its own login?' }, { deps: {} });
  check('A8 the AI assistant: Claude failed, the fast AI (Integrations > Fast AI) answered, the local model was not needed', claudeCalls >= 1 && fastCalls.length >= 1 && localCalls === 0, { claudeCalls, fast: fastCalls.length, localCalls, out });
  check('A9 its SMS goes as the Bulk / General kind (the DLT template of Integrations > SMS), not an unknown kind', sms.length === 1 && sms[0].channel === 'SMS' && sms[0].kind === 'bulk' && /own login/.test(sms[0].text), sms);
  const pageMeta = {};
  const page = await PS.askAi('You write a product page. Reply as JSON.', [{ role: 'user', content: 'NARRATION' }], 'page', pageMeta);
  check('A10 the product page draft from a demo video uses the same order (fast AI answered)', page && /own login/.test(page.reply) && /^fast:/.test(pageMeta.provider || ''), pageMeta);
  unstubFast(); unstubMsg();
  AI.setTestProviders(null);

  // ---- part B: the server -----------------------------------------------------------------------------------------------------
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const door = async (headers = {}) => {
    const r = await fetch(`${API}/public/job-portal/integrations`, { headers });
    const text = await r.text();
    return { status: r.status, text, cache: r.headers.get('cache-control') };
  };
  let r = await door();
  check('B1 no secret: 404, nothing in the answer', r.status === 404 && !hasSecret(r.text).length, r.status);
  r = await door({ 'x-job-portal-secret': 'wrong-secret-of-the-same-length-xyz' });
  check('B2 a wrong secret: 404', r.status === 404 && !hasSecret(r.text).length, r.status);
  r = await door({ 'x-job-portal-secret': PUSH_SECRET, 'x-forwarded-for': '203.0.113.9' });
  check('B3 the right secret but through a proxy (X-Forwarded-For, as nginx adds for a browser): 404', r.status === 404 && !hasSecret(r.text).length, r.status);
  r = await door({ 'x-job-portal-secret': PUSH_SECRET, 'x-real-ip': '203.0.113.9' });
  check('B4 ...X-Real-IP too: 404', r.status === 404, r.status);
  r = await door({ 'x-job-portal-secret': PUSH_SECRET });
  let body = null; try { body = JSON.parse(r.text); } catch { /* */ }
  check('B5 this machine + the secret (the portal process): the values, not cached', r.status === 200 && body && body.email && body.email.pass === FAKE.smtpPass && body.ai && body.ai.apiKey === FAKE.claudeKey && /no-store/.test(r.cache || ''), { status: r.status, cache: r.cache });

  // the portal's side of the bridge
  const embed = await import(pathToFileURL(path.join(ROOT, 'job-portal-app', 'embed', 'teamlink-integration.mjs')).href);
  const got = await embed.pullTeamlinkIntegrations({ api: `http://127.0.0.1:${PORT}`, secret: PUSH_SECRET });
  check('B6 the portal\'s loader reads them over 127.0.0.1 with the bridge secret', got && got.email && got.email.host === 'smtp.zz-store.test');
  let asked = 0;
  const refuse = await embed.pullTeamlinkIntegrations({ api: 'http://10.20.30.40:4010', secret: PUSH_SECRET, fetchFn: async () => { asked += 1; return { ok: true, json: async () => ({}) }; } }).then(() => null, (e) => e.message);
  check('B7 ...and refuses any address that is not this machine, without asking it', /not this machine/.test(refuse || '') && asked === 0, refuse);
  const bad = await embed.pullTeamlinkIntegrations({ api: `http://127.0.0.1:${PORT}`, secret: 'wrong' }).then(() => null, (e) => e.message);
  check('B8 a wrong secret on the portal side: TeamLink answered 404, no value', /404/.test(bad || ''), bad);
  const H = await import(pathToFileURL(path.join(ROOT, 'job-portal-app', 'job_portal-main', 'api', 'src', 'notify', 'host-integrations.js')).href);
  const clean = H.cleanHostValues({ ...got, extra: { x: 1 } });
  check('B9 the portal keeps only the fields its senders know', Object.keys(clean).every((k) => ['email', 'whatsapp', 'sms', 'ai'].includes(k)) && clean.email.encryption === 'STARTTLS');

  // nothing secret where a browser looks
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const browse = async (u) => { const x = await fetch(API + u, { headers: { Authorization: `Bearer ${tA}` } }); return { status: x.status, text: await x.text() }; };
  for (const u of ['/admin/integrations', '/portal-admin/connected', '/public/job-portal/config']) {
    // eslint-disable-next-line no-await-in-loop
    const x = await browse(u);
    check(`B10 ${u}: no secret in the answer (${x.status})`, x.status < 500 && !hasSecret(x.text).length, { status: x.status, leaked: hasSecret(x.text) });
  }
  // ---- part C (TEST_PORTAL_E2E=1, ~1-2 minutes): the REAL embed host (job-portal-app/embed/host.mjs) on its own ports and a fresh scratch
  // database, pointed at this sandbox server - the same wiring as the live server (TeamLink starts it with TEAMLINK_API_URL=127.0.0.1).
  let portalLog = '';
  if (process.env.TEST_PORTAL_E2E === '1') {
    const JP_PORT = PORT + 1; const PG_PORT = PORT + 1100;
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-jp-bridge-db-'));
    const jpEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
      JP_ROOT: path.join(ROOT, 'job-portal-app', 'job_portal-main'), JP_PORT: String(JP_PORT), PG_PORT: String(PG_PORT), DEV_DB_DIR: dbDir, DEV_PASSWORD: `zz-e2e-${process.pid}-dev-password`,
      JOB_PORTAL_SYNC_TOKEN: env.JOB_PORTAL_SYNC_TOKEN, JOB_PORTAL_PUSH_SECRET: PUSH_SECRET, TEAMLINK_API_URL: `http://127.0.0.1:${PORT}`,
      INTEGRATION_SECRET_KEY: 'zz-portal-own-key-abcdefghijklmnop', DISABLE_BACKGROUND_WORK: 'true', WHATSAPP_API_URL: 'http://127.0.0.1:9/wa', OUTBOUND_ALLOWLIST: '9999999999', NODE_ENV: 'development',
    };
    const jp = spawn(process.execPath, [path.join(ROOT, 'job-portal-app', 'embed', 'host.mjs')], { cwd: path.join(ROOT, 'job-portal-app', 'embed'), env: jpEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    jp.stdout.on('data', (d) => { portalLog += d; }); jp.stderr.on('data', (d) => { portalLog += d; });
    let up = false;
    for (let i = 0; i < 360 && !up; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      up = await fetch(`http://127.0.0.1:${JP_PORT}/api/health`).then((x) => x.ok).catch(() => false);
      // eslint-disable-next-line no-await-in-loop
      if (!up) await new Promise((res) => { setTimeout(res, 1000); });
    }
    await new Promise((res) => { setTimeout(res, 3000); });
    const T = { 'x-teamlink-token': env.JOB_PORTAL_SYNC_TOKEN, 'content-type': 'application/json' };
    const pget = async (p, o = {}) => { const x = await fetch(`http://127.0.0.1:${JP_PORT}/api/integrations/teamlink${p}`, { headers: T, ...o }); return { status: x.status, text: await x.text() }; };
    const st = await pget('/integrations/refresh', { method: 'POST', body: '{}' });
    let sj = null; try { sj = JSON.parse(st.text); } catch { /* */ }
    check('C1 the real portal host started and asked this TeamLink: Email, WhatsApp, SMS and AI are in use from Integrations', up && sj && sj.registered && sj.inUse.email && sj.inUse.whatsapp && sj.inUse.sms && sj.inUse.ai && !sj.error, { up, st });
    const em = await pget('/email/config');
    check('C2 its senders now use TeamLink\'s SMTP (host and From only in the answer)', /smtp\.zz-store\.test/.test(em.text) && !hasSecret(em.text).length, em);
    check('C3 no answer of the portal holds a secret', !hasSecret(st.text + em.text).length);
    jp.kill();
    await new Promise((res) => { setTimeout(res, 2000); });
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* the scratch database */ }
    check('C4 no secret in the portal\'s log', !hasSecret(portalLog).length, hasSecret(portalLog));
  }

  await new Promise((res) => { setTimeout(res, 500); });
  check('B11 no secret in the server\'s log', !hasSecret(serverLog).length, hasSecret(serverLog));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
