// ---------------------------------------------------------------------------
// QR ENGINE — the WhatsApp Web link behind the "QR-link prototype" (runs ONLY inside workers/whatsappQrWorker.js, or in a
// test with an injected fake library). Never imported by src/index.js.
//
//   PROTOTYPE: unofficial, can get the number banned, use a spare number.
//
// Library: @whiskeysockets/baileys (WebSocket, no browser, light on RAM) - an OPTIONAL dependency, loaded with a dynamic
// import. If it is not installed the engine says so in plain words and nothing else breaks.
//
// What the engine does
//   * connects with an ENCRYPTED session (every file AES-GCM encrypted with utils/secrets.js, in a private folder outside git)
//   * publishes the state (+ the QR string) to AppSetting comm.qr.state for the Integrations screen
//   * sends the queue (channels/whatsappQr.js) ONE message at a time with HUMAN-LIKE pacing: a random gap (default 8-20 s),
//     hourly + daily caps, an optional "typing..." pause; never a burst
//   * circuit breaker: 3 failures in a row pause the sender; "logged out" and ban signals (403) stop it; each raises a bell to Admin
//   * delivery ticks (sent / delivered / read) update the message (utils/messageDelivery.applyStatus); replies go to the Inbox
//     (utils/messageDelivery.applyInbound), a STOP reply opts the person out
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const os = require('os');
const wq = require('./whatsappQr');
const settings = require('./settings');
const store = require('./store');
const prisma = require('../db');
const core = require('../utils/messagingCore');
const secrets = require('../utils/secrets');

const sleepReal = (ms) => new Promise((r) => { setTimeout(r, ms); });
const MAX_ATTEMPTS = 3;
const BREAKER = 3;

function sessionDir() {
  if (process.env.TL_QR_SESSION_DIR) return process.env.TL_QR_SESSION_DIR;
  const sandbox = require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
  return path.join(os.homedir(), sandbox ? '.teamlink-sandbox' : '.teamlink', 'whatsapp-qr-session');
}

// ---- the library ----------------------------------------------------------------
async function loadLibrary() {
  if (process.env.TL_QR_BAILEYS_MODULE && require('../utils/sandbox').isSandbox()) { // eslint-disable-line global-require
    const m = require(process.env.TL_QR_BAILEYS_MODULE); // eslint-disable-line global-require, import/no-dynamic-require
    return m.default && typeof m.default === 'function' ? { ...m, makeWASocket: m.default } : { ...m, makeWASocket: m.makeWASocket || m.default };
  }
  let m;
  try { m = await import('@whiskeysockets/baileys'); } catch (e) { // eslint-disable-line import/no-unresolved
    if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND' || /Cannot find/.test(String(e.message)))) {
      const err = new Error('Not installed: run  npm install @whiskeysockets/baileys  in the backend folder, then press Start again.');
      err.code = 'NOT_INSTALLED';
      throw err;
    }
    throw e;
  }
  const make = (typeof m.default === 'function' ? m.default : (m.default && m.default.default)) || m.makeWASocket;
  return { ...m, makeWASocket: make };
}

// ---- encrypted auth state (what useMultiFileAuthState does, but every file is encrypted) ------------------------
function encryptedAuthState(dir, lib) {
  if (!secrets.secretsConfigured()) {
    const e = new Error(secrets.NO_KEY_MESSAGE); e.code = 'NO_SECRET_KEY'; throw e;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { BufferJSON, initAuthCreds, proto } = lib;
  const fileOf = (name) => path.join(dir, `${String(name).replace(/[^a-zA-Z0-9_.-]/g, '_')}.enc`);
  const read = (name) => {
    try {
      const raw = fs.readFileSync(fileOf(name), 'utf8');
      const plain = secrets.decryptSecret(raw);
      return plain == null ? null : JSON.parse(plain, BufferJSON.reviver);
    } catch { return null; }
  };
  const write = (name, data) => fs.writeFileSync(fileOf(name), secrets.encryptSecret(JSON.stringify(data, BufferJSON.replacer)), { mode: 0o600 });
  const remove = (name) => { try { fs.unlinkSync(fileOf(name)); } catch { /* not there */ } };
  const creds = read('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          ids.forEach((id) => {
            let v = read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v && proto && proto.Message && proto.Message.AppStateSyncKeyData) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          });
          return out;
        },
        set: async (data) => {
          Object.keys(data).forEach((cat) => Object.keys(data[cat]).forEach((id) => {
            const v = data[cat][id];
            if (v) write(`${cat}-${id}`, v); else remove(`${cat}-${id}`);
          }));
        },
      },
    },
    saveCreds: async () => write('creds', creds),
    hasSession: () => !!read('creds') && !!(read('creds') || {}).me,
    wipe: () => { try { fs.readdirSync(dir).filter((f) => f.endsWith('.enc')).forEach((f) => fs.unlinkSync(path.join(dir, f))); } catch { /* empty */ } },
    dir,
  };
}

const silent = () => { const l = { level: 'silent', child: () => l }; ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach((k) => { l[k] = () => {}; }); return l; };

// ---- who to tell -----------------------------------------------------------------
async function bellAdmins(title, message) {
  try {
    const admins = await prisma.user.findMany({ where: { OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true, email: true, name: true } });
    const real = admins.filter((u) => !/zztest|example\.test/i.test(`${u.email} ${u.name}`));
    const to = (real.length ? real : admins).slice(0, 8);
    for (const u of to) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message } }).catch(() => {});
    }
    return to.length;
  } catch { return 0; }
}

function createEngine(opts = {}) {
  const sleep = opts.sleep || sleepReal;
  const rand = opts.rand || Math.random;
  const nowFn = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const E = {
    lib: null, sock: null, auth: null, state: 'disconnected', phone: null, stopping: false, consecutiveFailures: 0, nextSendAt: 0, reconnects: [], qr: null, bellKeys: {}, sentThisRun: 0, paused: false, banEvidence: 0,
  };

  async function publish(patch) {
    E.state = patch.state || E.state;
    return wq.setState({ pid: process.pid, ...patch });
  }
  async function bell(key, title, message) {
    if (E.bellKeys[key]) return;
    E.bellKeys[key] = true;
    await bellAdmins(`WhatsApp QR: ${title}`, message);
  }

  // ---- connection ------------------------------------------------------------------
  async function connect() {
    E.lib = E.lib || await loadLibrary();
    const dir = opts.sessionDir || sessionDir();
    E.auth = E.auth || encryptedAuthState(dir, E.lib);
    let version;
    try { if (E.lib.fetchLatestBaileysVersion && !opts.noVersionCheck) version = (await E.lib.fetchLatestBaileysVersion()).version; } catch { version = undefined; }
    const sock = E.lib.makeWASocket({
      auth: E.auth.state, version, printQRInTerminal: false, logger: silent(), browser: ['TeamLink', 'Chrome', '1.0'],
      syncFullHistory: false, markOnlineOnConnect: false, generateHighQualityLinkPreview: false,
    });
    E.sock = sock;
    sock.ev.on('creds.update', () => { E.auth.saveCreds().catch(() => {}); });
    sock.ev.on('connection.update', (u) => { onConnection(u).catch((e) => log('connection.update', e.message)); });
    sock.ev.on('messages.update', (list) => { onUpdates(list).catch((e) => log('messages.update', e.message)); });
    sock.ev.on('messages.upsert', (m) => { onMessages(m).catch((e) => log('messages.upsert', e.message)); });
    await publish({ state: E.auth.hasSession() ? 'disconnected' : 'waiting-qr', reason: E.auth.hasSession() ? 'Reconnecting ...' : 'Starting ...' });
    return sock;
  }

  async function onConnection(u) {
    if (u.qr) {
      E.qr = u.qr;
      await publish({ state: 'waiting-qr', qr: u.qr, phone: null, reason: 'Open WhatsApp on the spare phone > Linked devices > Link a device, and scan the code.' });
    }
    if (u.connection === 'open') {
      const me = (E.sock && E.sock.user && E.sock.user.id) || (E.auth.state.creds.me && E.auth.state.creds.me.id) || '';
      E.phone = String(me).split(':')[0].split('@')[0].replace(/\D/g, '');
      E.qr = null; E.reconnects = []; E.banEvidence = 0;
      await publish({ state: 'connected', qr: null, phone: E.phone, reason: null, paused: E.paused });
      E.bellKeys = {};
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect && u.lastDisconnect.error;
      const code = err && err.output && err.output.statusCode;
      const DR = (E.lib && E.lib.DisconnectReason) || { loggedOut: 401, forbidden: 403, connectionReplaced: 440, restartRequired: 515 };
      if (code === DR.loggedOut) {
        E.auth.wipe(); E.sock = null; E.auth = null;
        await publish({ state: 'logged-out', qr: null, phone: null, reason: 'WhatsApp logged this device out (it was unlinked on the phone). Start again and scan a new QR code.' });
        await bell('loggedout', 'Logged out', 'The QR-linked WhatsApp number was logged out. Open Integrations > WhatsApp & SMS and link it again. Sending is stopped.');
        E.stopping = true; return;
      }
      if (code === DR.forbidden) {
        E.sock = null;
        await publish({ state: 'banned-suspected', qr: null, reason: 'WhatsApp refused the connection (403). The number may be banned or blocked. Sending is stopped. Do not retry with the same number for a few days.' });
        await bell('banned', 'Banned or blocked suspected', 'WhatsApp refused the QR-linked number (403). It may be banned. Sending is stopped. Use another spare number or switch to the official WhatsApp API.');
        E.stopping = true; return;
      }
      if (code === DR.connectionReplaced) {
        E.sock = null;
        await publish({ state: 'stopped', qr: null, reason: 'The number was opened on another device or browser, so this link stopped.' });
        await bell('replaced', 'Stopped: opened elsewhere', 'The QR-linked WhatsApp number was opened somewhere else, so TeamLink stopped using it.');
        E.stopping = true; return;
      }
      // anything else (network drop, restart required): reconnect, but not forever
      E.reconnects = E.reconnects.filter((t) => nowFn() - t < 600000);
      E.reconnects.push(nowFn());
      if (E.reconnects.length > 6) {
        E.sock = null;
        await publish({ state: 'disconnected', reason: 'The connection keeps dropping. Stopped after 6 tries in 10 minutes.' });
        await bell('flap', 'Connection keeps dropping', 'The QR-linked WhatsApp connection dropped 6 times in 10 minutes. Check the internet and the phone, then press Start.');
        E.stopping = true; return;
      }
      await publish({ state: 'disconnected', reason: 'Connection lost, reconnecting ...' });
      if (!E.stopping) { await sleep(opts.reconnectDelayMs == null ? 3000 : opts.reconnectDelayMs); if (!E.stopping) await connect(); }
    }
  }

  // ---- delivery ticks + replies --------------------------------------------------------
  const STATUS = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
  async function onUpdates(list) {
    const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
    for (const u of (Array.isArray(list) ? list : [])) {
      const id = u && u.key && u.key.id;
      const st = u && u.update && u.update.status;
      if (!id || st == null) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const ref = await wq.refOfWa(id);
      if (!ref) continue; // eslint-disable-line no-continue
      if (st === 0) {
        // eslint-disable-next-line no-await-in-loop
        await delivery.applyStatus({ channel: 'WhatsApp', providerRef: ref, status: 'failed', at: new Date(nowFn()), error: 'WhatsApp reported an error for this message' });
      } else if (STATUS[st]) {
        // eslint-disable-next-line no-await-in-loop
        await delivery.applyStatus({ channel: 'WhatsApp', providerRef: ref, status: STATUS[st], at: new Date(nowFn()) });
      }
    }
  }
  function textOf(m) {
    const x = m && m.message;
    if (!x) return '';
    return x.conversation || (x.extendedTextMessage && x.extendedTextMessage.text) || (x.imageMessage && x.imageMessage.caption) || (x.documentMessage && (x.documentMessage.caption || '[document]')) || (x.buttonsResponseMessage && x.buttonsResponseMessage.selectedDisplayText) || (x.imageMessage ? '[image]' : (x.audioMessage ? '[voice message]' : '[message]'));
  }
  async function onMessages(ev) {
    if (!ev || ev.type === 'append') return;
    const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
    for (const m of (ev.messages || [])) {
      const k = m.key || {};
      if (k.fromMe || !k.remoteJid) continue; // eslint-disable-line no-continue
      let jid = String(k.remoteJid);
      if (/@lid$/.test(jid) && k.senderPn) jid = String(k.senderPn);
      if (!/@s\.whatsapp\.net$/.test(jid)) continue; // eslint-disable-line no-continue
      const from = jid.split('@')[0].split(':')[0];
      // eslint-disable-next-line no-await-in-loop
      const out = await delivery.applyInbound({ channel: 'WhatsApp', from, text: textOf(m), id: k.id, at: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date(nowFn()), name: m.pushName, provider: wq.ID });
      if (out && out.stop) log('STOP from', from);
    }
  }

  // ---- the sender ------------------------------------------------------------------
  function jidOf(e164) { return `${String(e164).replace(/\D/g, '')}@s.whatsapp.net`; }

  async function failItem(item, reason, { final = true } = {}) {
    const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
    item.error = String(reason).slice(0, 300);
    if (final) {
      item.status = 'failed';
      await wq.saveItem(item);
      await delivery.applyStatus({ channel: 'WhatsApp', providerRef: item.ref, status: 'failed', at: new Date(nowFn()), error: item.error });
    } else {
      item.status = 'queued';
      item.notBefore = new Date(nowFn() + 30000 * item.attempts).toISOString();
      await wq.saveItem(item);
      await store.patch(item.ref, { retries: item.attempts });
    }
  }

  // One step. Returns 'idle' | 'waiting' | 'capped' | 'sent' | 'failed' | 'paused' | 'not-connected'.
  async function tickSend() {
    if (E.state !== 'connected' || !E.sock) return 'not-connected';
    if (E.paused) return 'paused';
    const s = await settings.load({ fresh: true });
    if (s.qr.killSwitch) return 'paused';
    if (nowFn() < E.nextSendAt) return 'waiting';
    const due = (await wq.queueRows('queued')).find((r) => !r.notBefore || new Date(r.notBefore).getTime() <= nowFn());
    if (!due) return 'idle';
    const caps = settings.effectiveQr(s);
    const sc = await wq.sentCounts(nowFn());
    if (sc.hour >= caps.perHour || sc.day >= caps.perDay) return 'capped';
    const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
    // consent can have changed while the message waited in the queue
    if (await delivery.optedOut('WhatsApp', due.to)) { await failItem(due, 'They replied STOP on WhatsApp while this was waiting.'); return 'failed'; }
    due.status = 'sending'; due.attempts = (due.attempts || 0) + 1;
    await wq.saveItem(due);
    const jid = jidOf(due.to);
    try {
      if (E.sock.onWhatsApp && !opts.skipExistsCheck) {
        let found = null;
        try { found = await E.sock.onWhatsApp(jid); } catch { found = null; }
        if (Array.isArray(found) && found[0] && found[0].exists === false) {
          await failItem(due, 'This number is not on WhatsApp.');
          return 'failed'; // a number that is not on WhatsApp does not count as a send failure
        }
      }
      if (caps.typing && E.sock.sendPresenceUpdate) {
        try {
          await E.sock.sendPresenceUpdate('composing', jid);
          await sleep(Math.min(6000, 1200 + String(due.text || '').length * 25 + Math.floor(rand() * 1500)));
          await E.sock.sendPresenceUpdate('paused', jid);
        } catch { /* presence is cosmetic */ }
      }
      let content = { text: due.text };
      if (due.media && due.media.length) {
        const m = due.media[0];
        content = { document: fs.readFileSync(m.path), mimetype: m.mime || 'application/octet-stream', fileName: m.name || path.basename(m.path), caption: due.text || undefined };
      }
      const res = await E.sock.sendMessage(jid, content);
      const waId = res && res.key && res.key.id;
      due.status = 'sent'; due.sentAt = new Date(nowFn()).toISOString(); due.waId = waId || null; due.error = null;
      await wq.saveItem(due);
      if (waId) await wq.mapWa(waId, due.ref);
      await delivery.applyStatus({ channel: 'WhatsApp', providerRef: due.ref, status: 'sent', at: new Date(nowFn()) });
      E.consecutiveFailures = 0; E.sentThisRun += 1;
      E.nextSendAt = nowFn() + Math.round((caps.gapMin + rand() * Math.max(0, caps.gapMax - caps.gapMin)) * 1000);
      return 'sent';
    } catch (e) {
      const why = String((e && e.message) || e);
      E.consecutiveFailures += 1;
      if (/forbidden|403|not-authorized|blocked/i.test(why)) E.banEvidence += 1;
      await failItem(due, why, { final: due.attempts >= MAX_ATTEMPTS });
      E.nextSendAt = nowFn() + Math.round((caps.gapMin + rand() * Math.max(0, caps.gapMax - caps.gapMin)) * 1000);
      if (E.banEvidence >= 2) {
        E.paused = true;
        await publish({ state: 'banned-suspected', reason: `WhatsApp keeps refusing messages (${why.slice(0, 120)}). The number may be blocked. Sending is stopped.` });
        await bell('banned', 'Banned or blocked suspected', `WhatsApp refused several messages in a row (${why.slice(0, 120)}). Sending from the QR-linked number is stopped.`);
      } else if (E.consecutiveFailures >= BREAKER) {
        E.paused = true;
        await publish({ state: 'connected', paused: true, reason: `Paused: ${BREAKER} messages failed in a row (${why.slice(0, 120)}). Press Resume when the cause is fixed.` });
        await bell('breaker', 'Paused after repeated failures', `${BREAKER} WhatsApp messages in a row failed on the QR-linked number (${why.slice(0, 120)}). Sending is paused until an Admin presses Resume.`);
      }
      return 'failed';
    }
  }

  async function handleControl() {
    const c = await wq.readControl();
    if (!c) return null;
    await wq.clearControl();
    if (c.cmd === 'stop') { E.stopping = true; return 'stop'; }
    if (c.cmd === 'resume') { E.paused = false; E.consecutiveFailures = 0; E.banEvidence = 0; await publish({ paused: false, reason: null }); E.bellKeys = {}; return 'resume'; }
    if (c.cmd === 'logout' || c.cmd === 'reset') {
      try { if (c.cmd === 'logout' && E.sock && E.sock.logout) await E.sock.logout(); } catch { /* already gone */ }
      if (E.auth) E.auth.wipe();
      E.auth = null; E.sock = null; E.stopping = true;
      await publish({ state: 'logged-out', qr: null, phone: null, reason: 'Unlinked from TeamLink. Press Start to link a number again.' });
      return 'logout';
    }
    return null;
  }

  async function shutdown(reason) {
    E.stopping = true;
    try { if (E.sock && E.sock.end) E.sock.end(undefined); } catch { /* closing */ }
    await wq.setState({ state: E.state === 'logged-out' || E.state === 'banned-suspected' ? E.state : 'stopped', reason: reason || 'Stopped.', qr: null, pid: null });
  }

  // The worker's main loop.
  async function run({ tickMs = 1000, maxTicks = Infinity } = {}) {
    await connect();
    let ticks = 0; let beat = 0;
    while (!E.stopping && ticks < maxTicks) {
      ticks += 1;
      // eslint-disable-next-line no-await-in-loop
      const ctl = await handleControl();
      if (E.stopping) break;
      // eslint-disable-next-line no-await-in-loop
      if (ctl !== 'stop') await tickSend();
      if (nowFn() - beat > 10000) { beat = nowFn(); await wq.setState({ pid: process.pid }); } // eslint-disable-line no-await-in-loop
      if (ticks % 600 === 0) await wq.pruneQueue(); // eslint-disable-line no-await-in-loop
      await sleep(tickMs); // eslint-disable-line no-await-in-loop
    }
    await shutdown(E.state === 'logged-out' || E.state === 'banned-suspected' ? undefined : 'Stopped.');
  }

  return { E, connect, tickSend, handleControl, run, shutdown, onConnection, onUpdates, onMessages, publish };
}

module.exports = { createEngine, encryptedAuthState, loadLibrary, sessionDir, bellAdmins, MAX_ATTEMPTS, BREAKER };
