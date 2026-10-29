// ---------------------------------------------------------------------------
// SELF-HOSTED (SYNWAY) CALLING - THE ASTERISK MANAGER INTERFACE (AMI) CLIENT (2026-10-28).
//
// The same two jobs as calling/exotelClient.js, so calling/callService.js can use either provider:
//   testConnection(s)  READ ONLY - it places NO call: reach the AMI port, log in, Ping, the Asterisk version, the AudioSocket
//                      modules, the Synway trunk (PJSIP endpoint + its contact = the gateway), the AI dialplan context.
//   startCall(s, o)    Action: Originate  Channel PJSIP/<number>@<trunk>, Context <teamlink-ai>, Exten s, Priority 1,
//                      Variable AICALL_UUID=<the call's id>, Async. Returns as soon as Asterisk accepted the request; the
//                      result arrives later in the OriginateResponse event and is handed to o.onResult:
//                        answered -> 'in-progress' (Asterisk runs [teamlink-ai]: AudioSocket connects the call to the bridge,
//                                    calling/local/audioSocket.js, which talks and saves "completed" at the end)
//                        Reason 5 busy -> 'busy' · Reason 1 / 3 (hung up / rang out) -> 'no-answer' · 0 / 8 / other -> 'failed'
// The AMI secret never leaves this file: not in an error text, a log line or a response (clean()).
// A test copy (sandbox) refuses any Asterisk that is not on this computer, as the Exotel client refuses the real Exotel.
// Protocol: plain text over TCP, "Key: Value" lines, a blank line ends a message (docs.asterisk.org, AMI v2).
// ---------------------------------------------------------------------------
const net = require('net');
const crypto = require('crypto');
const sandbox = require('../../utils/sandbox');
const core = require('../../utils/messagingCore');

const CONNECT_MS = 6000;
const ACTION_MS = 8000;
const REASON = { 0: 'failed', 1: 'no-answer', 3: 'no-answer', 4: 'answered', 5: 'busy', 8: 'failed' };
const REASON_WORDS = {
  0: 'Asterisk could not start the call (the trunk or the number was refused).',
  1: 'The call was hung up before it was answered.',
  3: 'The phone rang but nobody answered.',
  5: 'The candidate\'s phone was busy.',
  8: 'The phone network was busy (congestion).',
};

// The credentials must never leak through an error text.
function clean(text, s) {
  let t = core.tidy(text);
  [s && s.amiSecret].filter((x) => x && x.length >= 3).forEach((secret) => { t = t.split(secret).join('•••'); });
  return t;
}
const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim(); // no header injection through a value
const isLoop = (h) => ['127.0.0.1', 'localhost', '::1'].includes(String(h || '').toLowerCase());

function guardSandbox(s) {
  if (sandbox.isSandbox() && !isLoop(s.amiHost)) return 'TEST MODE: this computer is a test copy and refuses to contact a real Asterisk server.';
  return null;
}

// The number as the gateway dials it. e164: digits with the country code (919848012345).
function dialString(e164, format) {
  const d = String(e164 || '').replace(/\D/g, '');
  const ten = d.slice(-10);
  if (format === 'e164') return `+${d}`;
  if (format === 'zero') return `0${ten}`;
  return ten;
}

// ---- one AMI connection ---------------------------------------------------------------------------------------------------
class AmiSession {
  constructor(s) { this.s = s; this.buf = ''; this.banner = null; this.waiting = new Map(); this.listeners = []; this.closed = false; this.n = 0; }

  open() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.s.amiHost, port: this.s.amiPort });
      this.sock = sock;
      const t = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error(`no answer from ${this.s.amiHost}:${this.s.amiPort} within ${CONNECT_MS / 1000} s`), { transient: true })); }, CONNECT_MS);
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        this.buf += chunk;
        if (this.banner == null) {
          const i = this.buf.indexOf('\r\n');
          if (i < 0) return;
          this.banner = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 2);
          clearTimeout(t);
          if (!/^Asterisk Call Manager/i.test(this.banner)) { sock.destroy(); reject(new Error('that address is not an Asterisk Manager (AMI) port')); return; }
          resolve(this.banner);
        }
        this.drain();
      });
      sock.on('error', (e) => { clearTimeout(t); this.fail(e); reject(Object.assign(new Error(e.code === 'ECONNREFUSED' ? `nothing is listening on ${this.s.amiHost}:${this.s.amiPort} (is Asterisk running and AMI enabled?)` : e.message), { transient: true })); });
      sock.on('close', () => { this.closed = true; this.fail(new Error('the Asterisk connection closed')); });
    });
  }

  drain() {
    let i;
    while ((i = this.buf.indexOf('\r\n\r\n')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 4);
      const msg = {};
      raw.split('\r\n').forEach((line) => { const c = line.indexOf(':'); if (c > 0) msg[line.slice(0, c).trim()] = line.slice(c + 1).trim(); });
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    const w = msg.ActionID && this.waiting.get(msg.ActionID);
    if (w) {
      if (msg.Response) {
        w.response = msg;
        if (!w.list || msg.Response !== 'Success' || !/follow/i.test(msg.Message || '') && !msg.EventList) { this.done(msg.ActionID); return; }
        return;
      }
      if (msg.Event && w.list) {
        if (/Complete$/.test(msg.Event) || msg.EventList === 'Complete') { this.done(msg.ActionID); return; }
        w.events.push(msg);
        return;
      }
    }
    if (msg.Event) this.listeners.forEach((fn) => { try { fn(msg); } catch { /* a listener never breaks the reader */ } });
  }

  done(id) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    w.resolve({ ...w.response, events: w.events });
  }

  fail(err) {
    this.waiting.forEach((w) => { clearTimeout(w.timer); w.reject(err); });
    this.waiting.clear();
  }

  // { list: true } = the answer is a list of events ending with "...Complete".
  action(name, fields = {}, { list = false, timeoutMs = ACTION_MS } = {}) {
    if (this.closed) return Promise.reject(new Error('the Asterisk connection is closed'));
    this.n += 1;
    const id = `tl-${process.pid}-${Date.now().toString(36)}-${this.n}`;
    const lines = [`Action: ${name}`, `ActionID: ${id}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${oneLine(v)}`)];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(Object.assign(new Error(`Asterisk did not answer "${name}" within ${timeoutMs / 1000} s`), { transient: true })); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer, list, events: [], response: null, id });
      this.sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    }).then((r) => ({ ...r, actionId: id }));
  }

  onEvent(fn) { this.listeners.push(fn); }

  async login(events = 'off') {
    const r = await this.action('Login', { Username: this.s.amiUser, Secret: this.s.amiSecret, Events: events });
    if (r.Response !== 'Success') throw new Error('Asterisk did not accept the AMI user name / secret (check [teamlink] in /etc/asterisk/manager.conf).');
    return r;
  }

  close() {
    if (this.closed || !this.sock) return;
    try { this.sock.write('Action: Logoff\r\n\r\n'); } catch { /* closing anyway */ }
    this.closed = true;
    setTimeout(() => { try { this.sock.destroy(); } catch { /* gone */ } }, 200);
  }
}

// ---- the read-only connection test --------------------------------------------------------------------------------------------
async function testConnection(s) {
  const checks = [];
  if (!s.amiHost || !s.amiUser || !s.amiSecret) return { ok: false, message: 'The Asterisk server address, AMI user name and AMI secret are needed first.', checks: [{ name: 'Asterisk details', ok: false, note: 'missing' }] };
  if (!s.amiHostPrivate) return { ok: false, message: `${s.amiHost} is not a private address: call audio never goes over the internet.`, checks: [{ name: 'Asterisk address', ok: false, note: 'not private' }] };
  const blocked = guardSandbox(s);
  if (blocked) return { ok: false, message: blocked, checks: [{ name: 'Test copy', ok: false, note: blocked }] };
  const a = new AmiSession(s);
  try {
    const banner = await a.open();
    checks.push({ name: 'Asterisk Manager (AMI)', ok: true, note: `Reached ${s.amiHost}:${s.amiPort} (${banner}).` });
    await a.login('off');
    checks.push({ name: 'AMI login', ok: true, note: `Logged in as "${s.amiUser}".` });
    const ping = await a.action('Ping');
    checks.push({ name: 'Ping', ok: ping.Response === 'Success', note: ping.Response === 'Success' ? 'Asterisk answered.' : clean(ping.Message, s) });
    const cs = await a.action('CoreSettings').catch(() => ({}));
    const ver = cs.AsteriskVersion || '';
    const major = Number((/^(\d+)/.exec(ver) || [])[1]);
    checks.push({ name: 'Asterisk version', ok: !ver || major >= 18, warn: !ver, note: ver ? `Asterisk ${ver}${major && major < 18 ? ' - AudioSocket needs Asterisk 18 or newer' : ''}.` : 'The version could not be read.' });
    for (const mod of ['res_audiosocket', 'app_audiosocket']) {
      // eslint-disable-next-line no-await-in-loop
      const m = await a.action('ModuleCheck', { Module: mod }).catch((e) => ({ Response: 'Error', Message: e.message }));
      checks.push({ name: `Module ${mod}`, ok: m.Response === 'Success', note: m.Response === 'Success' ? 'loaded' : `not loaded - run: asterisk -rx "module load ${mod}.so"` });
    }
    const ep = await a.action('PJSIPShowEndpoint', { Endpoint: s.trunk }, { list: true }).catch((e) => ({ Response: 'Error', Message: e.message, events: [] }));
    if (ep.Response !== 'Success') {
      checks.push({ name: 'Synway trunk', ok: false, note: `Asterisk has no PJSIP endpoint "${s.trunk}" (copy deploy/ai-calling/asterisk/pjsip_synway.conf and run "pjsip reload").` });
    } else {
      const contacts = (ep.events || []).filter((e) => /ContactStatusDetail|AorDetail/.test(e.Event));
      const uri = contacts.map((e) => e.URI || e.Contacts || '').join(' ');
      const status = (contacts.find((e) => e.Status) || {}).Status || '';
      const pointsAtGateway = s.gatewayIp ? uri.includes(s.gatewayIp) : true;
      checks.push({ name: 'Synway trunk', ok: pointsAtGateway, note: pointsAtGateway ? `Endpoint "${s.trunk}" is set up${uri ? ` (${uri.trim()})` : ''}.` : `Endpoint "${s.trunk}" points at ${uri.trim() || 'no address'}, but the Synway gateway IP in the settings is ${s.gatewayIp}.` });
      checks.push({ name: 'Synway gateway', ok: true, warn: !/reachable|avail/i.test(status), note: status ? `Asterisk sees the gateway as: ${status}.` : 'Asterisk has not checked the gateway yet (qualify).' });
    }
    const dp = await a.action('ShowDialPlan', { Context: s.dialContext }, { list: true }).catch((e) => ({ Response: 'Error', Message: e.message, events: [] }));
    const audio = (dp.events || []).find((e) => /audiosocket/i.test(e.Application || ''));
    checks.push({ name: 'AI dialplan', ok: dp.Response === 'Success' && !!audio, note: dp.Response !== 'Success' ? `Context [${s.dialContext}] is not in the dialplan (copy extensions_teamlink.conf and run "dialplan reload").` : (audio ? `[${s.dialContext}] connects answered calls to AudioSocket (${audio.AppData || ''}).` : `[${s.dialContext}] exists but has no AudioSocket step.`) });
  } catch (e) {
    checks.push({ name: checks.length ? 'Asterisk' : 'Asterisk Manager (AMI)', ok: false, note: clean(e.message, s) });
  } finally { a.close(); }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    message: failed.length ? failed[0].note : `The Asterisk server answered and the Synway trunk is set up${checks.some((c) => c.warn) ? ' (see the notes)' : ''}. No call was placed.`,
    checks,
  };
}

// ---- place one call ---------------------------------------------------------------------------------------------------------
// o: { to: digits with country code, uuid: the call's id (AICALL_UUID = AiCall.callSid), onResult(ev) }
// ev: { status: 'in-progress' | 'busy' | 'no-answer' | 'failed', reason, detail, channel }
async function startCall(s, o) {
  if (!s.amiHostPrivate) return { ok: false, transient: false, error: `${s.amiHost || 'The Asterisk address'} is not private: no call is placed.` };
  const blocked = guardSandbox(s);
  if (blocked) return { ok: false, transient: false, error: blocked };
  const uuid = o.uuid || crypto.randomUUID();
  const a = new AmiSession(s);
  try {
    await a.open();
    await a.login('call'); // the "call" events carry OriginateResponse
  } catch (e) {
    a.close();
    return { ok: false, transient: !!e.transient, error: clean(`Asterisk: ${e.message}`, s) };
  }
  let settled = false;
  const finish = (ev) => {
    if (settled) return;
    settled = true;
    a.close();
    if (typeof o.onResult === 'function') Promise.resolve(o.onResult(ev)).catch(() => {});
  };
  let actionId = null;
  a.onEvent((msg) => {
    if (msg.Event !== 'OriginateResponse' || (actionId && msg.ActionID && msg.ActionID !== actionId)) return;
    const code = Number(msg.Reason);
    if (/success/i.test(msg.Response || '') || code === 4) finish({ status: 'in-progress', reason: 4, detail: 'Answered: the AI is joining the call.', channel: msg.Channel || null });
    else finish({ status: REASON[code] || 'failed', reason: Number.isFinite(code) ? code : null, detail: REASON_WORDS[code] || `Asterisk: ${oneLine(msg.Response || 'failure')} (reason ${msg.Reason || '?'})`, channel: msg.Channel || null });
  });
  let r;
  try {
    r = await a.action('Originate', {
      Channel: `PJSIP/${dialString(o.to, s.dialFormat)}@${s.trunk}`,
      Context: s.dialContext,
      Exten: 's',
      Priority: '1',
      Timeout: String(s.ringSeconds * 1000),
      Variable: `AICALL_UUID=${uuid}`,
      Async: 'true',
    });
  } catch (e) {
    a.close();
    return { ok: false, transient: !!e.transient, error: clean(`Asterisk: ${e.message}`, s) };
  }
  actionId = r.actionId;
  if (r.Response !== 'Success') {
    a.close();
    return { ok: false, transient: false, error: clean(`Asterisk refused the call: ${r.Message || 'no reason given'}`, s) };
  }
  // the result must come within the ring time (+ margin); otherwise the call is not left "calling" for ever
  setTimeout(() => finish({ status: 'failed', reason: null, detail: 'Asterisk did not report how the call ended.' }), (s.ringSeconds + 30) * 1000).unref();
  return { ok: true, callSid: uuid, status: 'queued' };
}

module.exports = { testConnection, startCall, clean, dialString, AmiSession, REASON };
