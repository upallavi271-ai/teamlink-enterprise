// ---------------------------------------------------------------------------
// sms.android — an ANDROID PHONE AS SMS GATEWAY (your own SIM sends the text).
//
// Built for the open-source "SMS Gateway for Android" (capcom6/android-sms-gateway, docs.sms-gate.app):
//   LOCAL   phone and server on the same Wi-Fi         base  http://<phone-ip>:8080        POST /message
//   CLOUD   the app's relay                            base  https://api.sms-gate.app      POST /3rdparty/v1/messages
//   auth    HTTP Basic (username + password shown in the app), or a Bearer token for the cloud
//   send    { "textMessage": { "text": "..." }, "phoneNumbers": ["+91..."], "simNumber": 1, "withDeliveryReport": true }
//   reply   { "id": "...", "state": "Pending", "recipients": [...] }       status  GET <send path>/<id>
//   health  GET /health  (cloud: /3rdparty/v1/health)
//   hooks   the phone POSTs to us: sms:sent / sms:delivered / sms:failed / sms:received (+ batch forms, system:ping),
//           signed X-Signature = hex HMAC-SHA256(signing key, rawBody + X-Timestamp)   (routes/webhooks.js)
//
// GENERIC mode: any other app / own relay that takes a JSON POST: the body is a template with {{to}} and {{text}},
// the id of the message is read from the reply by name.
//
// Contract (channels/index.js): send(message) -> { ok, providerRef, status, error, retryable, ... } and it never throws.
// "Phone offline" (network error / timeout) is reported as { offline: true, retryable: true } so the layer falls back to the next
// provider or to "Opened in your app". Gaps of 3-6 s between messages and an hourly / daily cap protect the SIM.
// ---------------------------------------------------------------------------
const { readConfig } = require('../utils/integrationStore');
const { ANDROID_FIELDS: F } = require('../utils/adminCatalog');
const core = require('../utils/messagingCore');
const settings = require('./settings');
const store = require('./store');
const prisma = require('../db');

const ID = 'sms.android';
const CLOUD = 'https://api.sms-gate.app';
const HEALTH_KEY = 'comm.android.health';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const gapScale = () => {
  if (!require('../utils/sandbox').isSandbox()) return 1; // eslint-disable-line global-require
  const n = Number(process.env.TL_COMM_GAP_SCALE);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};

let nextAt = 0;
async function pace(gapMin, gapMax) {
  const gap = (gapMin + Math.random() * Math.max(0, gapMax - gapMin)) * 1000 * gapScale();
  const wait = Math.max(0, nextAt - Date.now());
  nextAt = Math.max(Date.now(), nextAt) + gap;
  if (wait > 0) await sleep(wait);
}

function safeBase(raw) {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  if (!t) return null;
  try {
    const u = new URL(t);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`.replace(/\/+$/, '');
  } catch { return null; }
}

async function androidConfig() {
  const cfg = await readConfig('sms-android');
  const v = cfg.values || {};
  const mode = /cloud/i.test(v[F.mode] || '') ? 'cloud' : (/custom|generic/i.test(v[F.mode] || '') ? 'custom' : 'local');
  const style = /generic/i.test(v[F.style] || '') || mode === 'custom' ? 'generic' : 'smsgate';
  const base = core.devOverride(v) || safeBase(v[F.base]) || (mode === 'cloud' ? CLOUD : null);
  const out = {
    mode, style, base,
    login: /bearer/i.test(v[F.login] || '') ? 'Bearer' : 'Basic',
    user: String(v[F.user] || '').trim(),
    pass: String(v[F.pass] || '').trim(),
    sendPath: String(v[F.sendPath] || '').trim() || (mode === 'cloud' ? '/3rdparty/v1/messages' : '/message'),
    healthPath: String(v[F.healthPath] || '').trim() || (mode === 'cloud' ? '/3rdparty/v1/health' : '/health'),
    sim: Number(v[F.sim]) >= 1 && Number(v[F.sim]) <= 3 ? Number(v[F.sim]) : null,
    bodyTpl: String(v[F.bodyTpl] || '').trim(),
    refPath: String(v[F.refPath] || '').trim() || 'id',
    hook: String(v[F.hook] || '').trim(),
    testMode: !!core.devOverride(v),
  };
  const problems = [];
  if (!cfg.row) problems.push('The Android phone has not been set up yet.');
  else {
    if (!out.base) problems.push('No phone address: type the address shown in the app, for example http://192.168.1.20:8080.');
    if (cfg.missingKey) problems.push('A password is stored but this server cannot decrypt it (INTEGRATION_SECRET_KEY missing or changed).');
    else if (out.login === 'Basic' && (!out.user || !out.pass)) problems.push('Type the username and password shown in the phone app.');
    else if (out.login === 'Bearer' && !out.pass) problems.push('Type the access token.');
    if (out.style === 'generic' && !out.bodyTpl) problems.push('Generic mode needs the JSON body template.');
    if (!cfg.row.enabled) problems.push('The channel is switched off.');
    else if (!cfg.connected) problems.push('The channel is disconnected. Press Connect.');
  }
  return { ...out, configured: problems.length === 0, problems, reason: problems.join(' ') };
}

function authHeaders(cfg) {
  const h = { 'content-type': 'application/json', accept: 'application/json' };
  if (cfg.login === 'Bearer') h.authorization = `Bearer ${cfg.pass}`;
  else h.authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`;
  return h;
}

function getPath(obj, path) {
  return String(path || '').split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
const jsonStr = (s) => JSON.stringify(String(s)).slice(1, -1);

function bodyFor(cfg, mobile, text) {
  if (cfg.style === 'generic') {
    return cfg.bodyTpl.replace(/\{\{\s*to\s*\}\}/g, jsonStr(`+${mobile.e164}`)).replace(/\{\{\s*text\s*\}\}/g, jsonStr(text));
  }
  const body = { textMessage: { text }, phoneNumbers: [`+${mobile.e164}`], withDeliveryReport: true };
  if (cfg.sim) body.simNumber = cfg.sim;
  return JSON.stringify(body);
}

async function markHealth(ok, error) {
  const v = JSON.stringify({ ok, at: new Date().toISOString(), error: error || null });
  await prisma.appSetting.upsert({ where: { key: HEALTH_KEY }, create: { key: HEALTH_KEY, value: v }, update: { value: v } }).catch(() => {});
}
async function lastHealth() {
  const row = await prisma.appSetting.findUnique({ where: { key: HEALTH_KEY } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

function mocksAllowed(cfg) {
  // The sandbox never reaches a real phone: only a loopback mock listed in TEST_MOCK_PORTS gets a real HTTP call.
  if (!require('../utils/sandbox').isSandbox()) return true; // eslint-disable-line global-require
  try { return core.loopback(cfg.base) && String(process.env.TEST_MOCK_PORTS || '').split(',').includes(String(new URL(cfg.base).port)); } catch { return false; }
}

function failure(res, cfg) {
  const j = res.json || {};
  if (res.networkError) {
    return { ok: false, provider: ID, offline: true, retryable: true, transient: true, unavailable: true, error: `The phone did not answer (${core.tidy(res.networkError)}). Is it switched on, on the same Wi-Fi, and is the app server running?` };
  }
  const said = j.message || j.error || res.text || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) return { ok: false, provider: ID, status: res.status, retryable: false, transient: false, unavailable: true, error: 'The phone app refused the username or password.' };
  if (res.status === 503) return { ok: false, provider: ID, status: res.status, retryable: true, transient: true, unavailable: true, error: core.tidy(`The phone queue is full or busy: ${typeof said === 'string' ? said : JSON.stringify(said)}`) };
  return { ok: false, provider: ID, status: res.status, retryable: core.isTransientHttp(res.status), transient: core.isTransientHttp(res.status), error: core.tidy(`Android SMS gateway HTTP ${res.status}: ${typeof said === 'string' ? said : JSON.stringify(said)}`) };
}

async function capsOk(s) {
  const u = await store.usage(ID);
  if (u.today >= s.android.perDay) return { ok: false, reason: `The phone's daily limit (${s.android.perDay} SMS a day) is reached.` };
  if (u.hour >= s.android.perHour) return { ok: false, reason: `The phone's hourly limit (${s.android.perHour} SMS an hour) is reached.` };
  return { ok: true };
}

// message: { to, text, kind, meta }
async function send(message) {
  const cfg = await androidConfig();
  if (!cfg.configured) return { ok: false, provider: ID, notConfigured: true, retryable: false, transient: false, unavailable: true, error: cfg.reason };
  const mobile = core.normalizeMobile(message.to);
  if (!mobile.ok) return { ok: false, provider: ID, invalid: true, retryable: false, transient: false, error: mobile.reason };
  if (message.kind === 'bulk' && await require('../utils/messageDelivery').optedOut('SMS', message.to)) { // eslint-disable-line global-require
    return { ok: false, provider: ID, invalid: true, retryable: false, transient: false, error: 'They replied STOP to our SMS, so nothing more is sent to them there.' };
  }
  const text = String(message.text || (message.vars || []).join(' ')).slice(0, 1000);
  if (!text.trim()) return { ok: false, provider: ID, invalid: true, retryable: false, transient: false, error: 'There is no message text.' };
  const s = await settings.load();
  const caps = await capsOk(s);
  if (!caps.ok) return { ok: false, provider: ID, capped: true, retryable: false, transient: false, unavailable: true, error: caps.reason };
  if (!mocksAllowed(cfg)) {
    // SANDBOX: reported as accepted, never transmitted (like every other channel in the sandbox).
    return { ok: true, provider: ID, providerRef: `and:sandbox-${Date.now().toString(36)}`, status: 'queued', queued: true, sandbox: true };
  }
  await pace(s.android.gapMin, s.android.gapMax);
  const res = await core.httpJson(`${cfg.base}${cfg.sendPath.startsWith('/') ? '' : '/'}${cfg.sendPath}`, {
    method: 'POST', headers: authHeaders(cfg), body: bodyFor(cfg, mobile, text), timeoutMs: 8000,
  });
  if (res.ok) {
    const id = cfg.style === 'generic' ? getPath(res.json, cfg.refPath) : (res.json && res.json.id);
    await markHealth(true);
    return { ok: true, provider: ID, providerRef: id ? `and:${id}` : `and:${Date.now().toString(36)}`, status: 'queued', queued: true };
  }
  const f = failure(res, cfg);
  if (f.offline || res.status === 401 || res.status === 403) await markHealth(false, f.error);
  return f;
}

async function health() {
  const cfg = await androidConfig();
  if (!cfg.configured) return { ok: false, state: 'not-configured', message: cfg.reason };
  if (!mocksAllowed(cfg)) return { ok: true, state: 'online', message: 'Sandbox: the phone is not contacted.', sandbox: true };
  const res = await core.httpJson(`${cfg.base}${cfg.healthPath.startsWith('/') ? '' : '/'}${cfg.healthPath}`, { headers: authHeaders(cfg), timeoutMs: 6000 });
  if (res.ok) { await markHealth(true); return { ok: true, state: 'online', message: `The phone answered${cfg.testMode ? ' (test server)' : ''}.` }; }
  const f = failure(res, cfg);
  await markHealth(false, f.error);
  return { ok: false, state: f.offline ? 'offline' : 'error', message: f.error };
}

async function test() {
  const h = await health();
  return { ok: h.ok, result: h.ok ? `Connected: ${h.message}` : `Failed: ${h.message}` };
}

// Poll one message at the phone (when the phone cannot reach our webhook). Returns 'sent' | 'delivered' | 'failed' | null.
async function pollStatus(providerRef) {
  const cfg = await androidConfig();
  if (!cfg.configured || cfg.style !== 'smsgate' || !mocksAllowed(cfg) || !String(providerRef || '').startsWith('and:')) return null;
  const id = String(providerRef).slice(4);
  if (id.startsWith('sandbox-')) return null;
  const res = await core.httpJson(`${cfg.base}${cfg.sendPath}/${encodeURIComponent(id)}`, { headers: authHeaders(cfg), timeoutMs: 6000 });
  if (!res.ok || !res.json) return null;
  const st = String(res.json.state || '').toLowerCase();
  const map = { sent: 'sent', delivered: 'delivered', failed: 'failed', processed: 'sent' };
  const status = map[st] || null;
  const failedWhy = (Array.isArray(res.json.recipients) && res.json.recipients.find((r) => r.error)) || null;
  return status ? { status, error: failedWhy ? failedWhy.error : null } : null;
}

module.exports = { ID, send, health, test, androidConfig, pollStatus, lastHealth, authHeaders, safeBase, _pace: pace };
