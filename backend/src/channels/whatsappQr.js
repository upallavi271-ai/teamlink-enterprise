// ---------------------------------------------------------------------------
// whatsapp.qr — the UNOFFICIAL "QR-link prototype" WhatsApp channel (server side).
//
//   PROTOTYPE: unofficial, can get the number banned, use a spare number.
//
// The 4010 server NEVER talks to WhatsApp and NEVER starts the worker by itself. This file only holds what both
// sides share through the database (AppSetting rows, no migration):
//
//   comm.qr.state     { state, qr, phone, pid, heartbeatAt, reason, since, paused }   written by the worker
//   comm.qr.control   { cmd: stop | logout | resume | reset, at }                      written by Admin buttons
//   comm.q.qr.<id>    the SEND QUEUE: one row per message (status queued | sending | sent | failed)
//   comm.qrwa.<waId>  WhatsApp's own message id -> our queue reference (delivery ticks)
//
// The worker (workers/whatsappQrWorker.js -> channels/qrEngine.js) is the ONLY process that sends, one message at a time,
// with random 8-20 s gaps and hourly / daily caps. The adapter below only decides "may this go into the queue" and queues it.
// States: Disconnected / Waiting for QR scan / Connected as +91xxxxxxxx (masked) / Logged out / Banned-or-blocked suspected / Stopped.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const prisma = require('../db');
const core = require('../utils/messagingCore');
const settings = require('./settings');
const store = require('./store');
const { readConfig } = require('../utils/integrationStore');

const ID = 'whatsapp.qr';
const STATE_KEY = 'comm.qr.state';
const CONTROL_KEY = 'comm.qr.control';
const QUEUE = 'comm.q.qr.';
const WA = 'comm.qrwa.';
// a heartbeat older than this = the worker is not running (tests on the slow shared sandbox may widen it)
const freshMs = () => (require('../utils/sandbox').isSandbox() && Number(process.env.TL_QR_FRESH_MS) > 0 ? Number(process.env.TL_QR_FRESH_MS) : 120000); // eslint-disable-line global-require
const MAX_WAITING = 400;

const STATES = {
  disconnected: 'Disconnected',
  'waiting-qr': 'Waiting for QR scan',
  connected: 'Connected',
  'logged-out': 'Logged out',
  'banned-suspected': 'Banned or blocked suspected',
  paused: 'Paused (repeated failures)',
  stopped: 'Stopped',
  'not-installed': 'Library not installed',
};

const parse = (row) => { try { return row ? JSON.parse(row.value) : null; } catch { return null; } };
async function setting(key) { return parse(await prisma.appSetting.findUnique({ where: { key } }).catch(() => null)); }
async function putSetting(key, value) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

// ---- state ------------------------------------------------------------------
async function getState() {
  const s = (await setting(STATE_KEY)) || { state: 'disconnected' };
  const age = s.heartbeatAt ? Date.now() - new Date(s.heartbeatAt).getTime() : Infinity;
  const alive = age < freshMs();
  // A heartbeat that stopped means the worker is gone, whatever it last said.
  const state = !alive && ['connected', 'waiting-qr'].includes(s.state) ? 'disconnected' : s.state;
  return { ...s, state, alive, label: STATES[state] || state, stale: !alive };
}
async function setState(patch) {
  const cur = (await setting(STATE_KEY)) || {};
  const next = { ...cur, ...patch, heartbeatAt: new Date().toISOString() };
  if (patch.state && patch.state !== cur.state) next.since = new Date().toISOString();
  await putSetting(STATE_KEY, next);
  return next;
}
async function sendControl(cmd) { await putSetting(CONTROL_KEY, { cmd, at: new Date().toISOString(), id: crypto.randomBytes(4).toString('hex') }); }
async function readControl() { return setting(CONTROL_KEY); }
async function clearControl() { await prisma.appSetting.deleteMany({ where: { key: CONTROL_KEY } }).catch(() => {}); }

function maskedPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d ? `+${core.maskMobile(d)}`.replace('++', '+') : null;
}

// ---- config / readiness -----------------------------------------------------------
async function qrConfig() {
  const [cfg, s, st] = await Promise.all([readConfig('whatsapp-qr'), settings.load(), getState()]);
  const problems = [];
  if (!cfg.row || !cfg.row.enabled) problems.push('The QR-link prototype is switched off.');
  else if (!s.qr.ack) problems.push('An Admin has not yet ticked "I understand" for the QR-link prototype.');
  if (s.qr.killSwitch) problems.push('The company kill switch for the QR-link prototype is ON.');
  if (!problems.length) {
    if (st.state !== 'connected') problems.push(`The linked number is not connected (${st.label}).`);
    else if (!st.alive) problems.push('The QR worker is not running. Press Start on the Integrations screen.');
  }
  return { configured: problems.length === 0, problems, reason: problems.join(' '), state: st, enabled: !!(cfg.row && cfg.row.enabled), ack: s.qr.ack, killSwitch: s.qr.killSwitch, caps: settings.effectiveQr(s), label: String((cfg.values || {})[require('../utils/adminCatalog').QR_FIELDS.label] || '') };
}

// ---- queue ----------------------------------------------------------------------
const qid = () => `${Date.now().toString(36).padStart(9, '0')}${crypto.randomBytes(3).toString('hex')}`;

async function enqueue(item) {
  const id = qid();
  const row = { id, ref: `qrq_${id}`, status: 'queued', attempts: 0, createdAt: new Date().toISOString(), notBefore: null, ...item };
  await putSetting(`${QUEUE}${id}`, row);
  return row;
}
async function queueRows(status) {
  const where = { key: { startsWith: QUEUE } };
  if (status) where.value = { contains: `"status":"${status}"` };
  const rows = await prisma.appSetting.findMany({ where, orderBy: { key: 'asc' }, select: { key: true, value: true } }).catch(() => []);
  return rows.map((r) => ({ ...parse(r), _key: r.key })).filter((r) => r && r.id);
}
async function saveItem(item) { const k = item._key || `${QUEUE}${item.id}`; const c = { ...item }; delete c._key; await putSetting(k, c); }
async function cancelWaiting() {
  const rows = await queueRows('queued');
  for (const r of rows) {
    r.status = 'failed'; r.error = 'Cancelled by an Admin';
    // eslint-disable-next-line no-await-in-loop
    await saveItem(r);
    // eslint-disable-next-line no-await-in-loop
    await store.applyStatus(r.ref, 'failed', { error: 'Cancelled by an Admin' });
  }
  return rows.length;
}
async function sentCounts(now = Date.now()) {
  const rows = await queueRows('sent');
  const hour = rows.filter((r) => r.sentAt && now - new Date(r.sentAt).getTime() < 3600000).length;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const day = rows.filter((r) => r.sentAt && new Date(r.sentAt).getTime() >= start.getTime()).length;
  return { hour, day };
}
async function pruneQueue(days = 2) {
  const cutoff = Date.now() - days * 86400000;
  const rows = [...await queueRows('sent'), ...await queueRows('failed')];
  const old = rows.filter((r) => new Date(r.sentAt || r.createdAt).getTime() < cutoff);
  if (old.length) await prisma.appSetting.deleteMany({ where: { key: { in: old.map((r) => r._key) } } }).catch(() => {});
  return old.length;
}
async function mapWa(waId, ref) { await putSetting(`${WA}${waId}`, { ref, at: new Date().toISOString() }); }
async function refOfWa(waId) { const v = await setting(`${WA}${waId}`); return v ? v.ref : null; }

// ---- the adapter ------------------------------------------------------------------
// message: { to, text, kind, media: [{ path, name, mime }], meta }
async function send(message) {
  const cfg = await qrConfig();
  if (!cfg.configured) return { ok: false, provider: ID, notConfigured: true, unavailable: true, retryable: false, transient: false, error: cfg.reason };
  if (message.kind && !['bulk', 'manual', 'text'].includes(message.kind)) {
    return { ok: false, provider: ID, unavailable: true, retryable: false, transient: false, error: 'The QR-linked number is not used for codes and signing links.' };
  }
  const mobile = core.normalizeMobile(message.to);
  if (!mobile.ok) return { ok: false, provider: ID, invalid: true, retryable: false, transient: false, error: mobile.reason };
  if (await require('../utils/messageDelivery').optedOut('WhatsApp', message.to)) { // eslint-disable-line global-require
    return { ok: false, provider: ID, invalid: true, retryable: false, transient: false, error: 'They replied STOP on WhatsApp, so nothing more is sent to them there.' };
  }
  const text = String(message.text || '').slice(0, 4096);
  if (!text.trim() && !(message.media && message.media.length)) return { ok: false, provider: ID, invalid: true, retryable: false, transient: false, error: 'There is no message text.' };
  const sc = await sentCounts();
  const waiting = (await queueRows('queued')).length;
  if (sc.day + waiting >= cfg.caps.perDay) {
    return { ok: false, provider: ID, capped: true, unavailable: true, retryable: false, transient: false, error: `The QR-linked number's daily limit (${cfg.caps.perDay} a day, protecting the number) is reached.` };
  }
  if (waiting >= MAX_WAITING) return { ok: false, provider: ID, capped: true, unavailable: true, retryable: false, transient: false, error: 'Too many messages are already waiting on the QR-linked number.' };
  const item = await enqueue({ to: mobile.e164, text, media: (message.media || []).map((m) => ({ path: m.path, name: m.name, mime: m.mime })), kind: message.kind || 'bulk' });
  return { ok: true, provider: ID, providerRef: item.ref, status: 'queued', queued: true, waiting: waiting + 1 };
}

async function health() {
  const c = await qrConfig();
  const st = c.state;
  const sc = await sentCounts();
  return { ok: c.configured, state: st.state, label: st.label, alive: st.alive, phone: maskedPhone(st.phone), message: c.configured ? `Connected as ${maskedPhone(st.phone) || 'the linked number'}` : c.reason, sent: sc };
}

// ---- the worker process (started by Admin or `npm run whatsapp-qr-worker`; never by the server) ------------------------------
function workerPath() { return path.join(__dirname, '..', 'workers', 'whatsappQrWorker.js'); }
function realDb() {
  const url = String(process.env.DATABASE_URL || '');
  const file = path.basename(url.replace(/^file:/, '').replace(/[?#].*$/, '').replace(/["']/g, ''));
  return !url || /^dev\.db$/i.test(file);
}
function truthy(v) { return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }

// May the Admin button start the worker from THIS server? (the worker repeats the same checks itself)
async function mayStart() {
  const c = await qrConfig();
  const s = await settings.load();
  if (!c.enabled) return { ok: false, error: 'Switch the QR-link prototype on first.' };
  if (!s.qr.ack) return { ok: false, error: 'Tick "I understand" first.' };
  if (s.qr.killSwitch) return { ok: false, error: 'The company kill switch is ON.' };
  const sandbox = require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
  if (sandbox && !process.env.TL_QR_BAILEYS_MODULE) return { ok: false, error: 'This is the test sandbox: the real WhatsApp network is never contacted from here.' };
  if (!sandbox && realDb() && !truthy(process.env.TL_ALLOW_REAL_WHATSAPP_QR)) {
    return { ok: false, error: 'This server is not allowed to link a real WhatsApp number. Set TL_ALLOW_REAL_WHATSAPP_QR=1 in the backend environment and restart, or run "npm run whatsapp-qr-worker" yourself.' };
  }
  const st = await getState();
  if (st.alive && !['stopped', 'logged-out'].includes(st.state)) return { ok: false, error: 'The worker is already running.', running: true };
  return { ok: true };
}
async function start() {
  const may = await mayStart();
  if (!may.ok) return may;
  await clearControl();
  const { spawn } = require('child_process'); // eslint-disable-line global-require
  const child = spawn(process.execPath, [workerPath()], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env } });
  child.unref();
  await setState({ state: 'disconnected', pid: child.pid, reason: 'Starting ...', qr: null });
  return { ok: true, pid: child.pid };
}
async function stop() { await sendControl('stop'); return { ok: true }; }

async function qrSvg() {
  const st = await getState();
  if (st.state !== 'waiting-qr' || !st.qr) return null;
  return require('../utils/qrCode').toSvg(st.qr, { ecc: 'L', border: 3, scale: 6 }); // eslint-disable-line global-require
}

module.exports = {
  ID, STATES, STATE_KEY, QUEUE, getState, setState, sendControl, readControl, clearControl, qrConfig, send, health, enqueue, queueRows, saveItem,
  sentCounts, pruneQueue, mapWa, refOfWa, start, stop, mayStart, qrSvg, maskedPhone, realDb, truthy, cancelWaiting, workerPath,
};
