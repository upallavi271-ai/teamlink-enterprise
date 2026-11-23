// ---------------------------------------------------------------------------
// CALL LINES - which line a call goes out on (founder 2026-11-16: "ats lo call ki drop down raavali: api (calls & msgs), dinstar (calls & msgs), sip (call)").
//
//   api       the connected telephony API (Exotel click-to-call today; the caller's own phone rings first, then the person)   calls + messages
//   dinstar   a Dinstar GSM gateway: calls over SIP, SMS through its own interface                                            calls + messages
//   sip       a SIP trunk / extension                                                                                          calls only
//
// PHONE LINES (2026-11-23): every line an Admin adds in Browser calling > Phone lines (Synway / Dinstar / ViciDial / other SIP by IP) is listed as "line:<id>"
// for the people whose role may use it; a Dinstar line replaces the "Dinstar - not connected" placeholder.
// Only "api" is connected so far. The other two are in the list so people see them, but they are NOT ready and a call on them is refused with
// the plain reason - nothing pretends to dial. When their setup details are known (Administration > Integrations), a line becomes ready by
// filling in its `ready()` and `start()` here; the screens and the route do not change.
// ---------------------------------------------------------------------------
const gw = require('./callGateway');

// THE SIP LINE = our own Synway SIM gateway through Asterisk (the same line the AI phone calls use: AI_VOICE_AMI_*, AI_VOICE_SIP_TRUNK - no telecom subscription).
// Click-to-call: Asterisk (AMI Originate) rings the CALLER's own phone first on the gateway; when it is answered, Asterisk dials the person on the same trunk and joins the two
// (Application Dial - no dialplan change). A RECRUITER's manual call (founder 2026-11-17) does NOT follow the AI phone mode (AI_VOICE_PHONE_MODE Test / Live is only for the AI dialling candidates by itself).
function sipSettings() {
  const sip = require('../calling/voice/sipCall'); // eslint-disable-line global-require
  const c = sip.config();
  const problems = [];
  if (c.via === 'direct') problems.push('The SIP line needs the Asterisk server (AI_VOICE_DIAL_VIA=direct is for an office PC).');
  else {
    if (!c.ami.user || !c.ami.secret) problems.push('The Asterisk manager login is not set on this server (AI_VOICE_AMI_USER / AI_VOICE_AMI_SECRET).');
    if (!c.trunk) problems.push('The SIM gateway line is not set on this server (AI_VOICE_SIP_TRUNK).');
  }
  return { c, problems, dialNumber: sip.dialNumber };
}
async function sipReady() {
  const { c, problems } = sipSettings();
  if (problems.length) return { ok: false, reason: `SIP is not connected yet: ${problems[0]}` };
  void c;
  return { ok: true, from: c.callerId || null, note: 'Your own phone rings first; when you pick up, the person is dialled.' };
}
async function sipStart({ agent, to }) {
  const { c, problems } = sipSettings();
  if (problems.length) return { ok: false, notConfigured: true, error: `SIP is not connected yet: ${problems[0]}` };
  return originateOn({ endpoint: c.trunk, format: c.format, prefix: '', callerId: c.callerId, lineName: 'SIP' }, { agent, to });
}
// click-to-call on one Asterisk endpoint: the caller's own phone rings first on it, then Asterisk dials the person on the same endpoint and joins the two.
// Used by the SIP line (teamlink-gw / AI_VOICE_SIP_TRUNK) and by every Phone line an Admin added (browsercall/lines.js: tl-line-<id>, its own number format + prefix).
async function originateOn(target, { agent, to }) {
  const { c, dialNumber } = sipSettings();
  const pre = String(target.prefix || '').replace(/[^0-9*#]/g, '');
  const core = require('./messagingCore'); // eslint-disable-line global-require
  const a = core.normalizeMobile(agent); const p = core.normalizeMobile(to);
  if (!a.ok) return { ok: false, invalid: true, error: 'Your own phone number does not look right on your profile, so the SIP line cannot ring you first.' };
  if (!p.ok) return { ok: false, invalid: true, error: 'The number to call does not look right.' };
  const sandbox = require('./sandbox'); // eslint-disable-line global-require
  if (sandbox.isSandbox() && !['127.0.0.1', 'localhost', '::1'].includes(String(c.ami.host))) return { ok: false, error: 'TEST MODE: this computer is a test copy and refuses to contact a real Asterisk server.' };
  const { Ami } = require('../calling/voice/ami'); // eslint-disable-line global-require
  const ami = new Ami(c.ami);
  try {
    await ami.connect();
    const r = await ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${pre}${dialNumber(a.e164, target.format)}@${target.endpoint}`, // the caller's own phone rings first
      Application: 'Dial',
      Data: `PJSIP/${pre}${dialNumber(p.e164, target.format)}@${target.endpoint},40`, // answered -> Asterisk dials the person and joins the two
      Timeout: '35000',
      ...(target.callerId ? { CallerID: target.callerId } : {}),
      Async: 'true',
    });
    ami.close();
    if (r.Response !== 'Success') return { ok: false, error: `Asterisk refused the call: ${String(r.Message || 'no reason given').replace(/[\r\n]+/g, ' ').slice(0, 160)}` };
    return { ok: true, callSid: `sip-${Date.now().toString(36)}`, status: 'queued', sandbox: sandbox.isSandbox(), lineName: target.lineName || null };
  } catch (e) {
    try { ami.close(); } catch { /* closing anyway */ }
    return { ok: false, transient: true, error: `Asterisk: ${String(e.message || e).replace(/[\r\n]+/g, ' ').replace(c.ami.secret || '\u0000', '•••').slice(0, 160)}` };
  }
}

const NOT_SET = (name) => `${name} is not connected yet. An Admin sets it up in Administration > Integrations; until then calls go on the API line.`;

const LINES = [
  {
    id: 'api', label: 'API', supports: ['Calls', 'Messages'],
    async ready() { const c = await gw.callConfig().catch(() => ({ configured: false, reason: 'not connected' })); return { ok: !!c.configured, reason: c.configured ? '' : (c.reason || 'The calling API is not connected.'), recording: !!c.record, from: c.callerId || null }; },
    start: (args) => gw.startCall(args),
  },
  {
    id: 'dinstar', label: 'Dinstar', supports: ['Calls', 'Messages'],
    async ready() { return { ok: false, reason: NOT_SET('Dinstar') }; },
    async start() { return { ok: false, notConfigured: true, error: NOT_SET('Dinstar') }; },
  },
  {
    id: 'sip', label: 'SIP', supports: ['Calls'], ready: sipReady, start: sipStart,
  },
];

const byId = (id) => LINES.find((l) => l.id === String(id || '').toLowerCase()) || null;
const wordsOf = (l) => `${l.label} (${l.supports.includes('Messages') ? 'calls & msgs' : 'call'})`;

// PHONE LINES an Admin added (Omni-Channel > AI Voice > Browser calling > Phone lines; browsercall/lines.js): each active one the person's role may use is a
// click-to-call line here too, id "line:<id>". Once a Dinstar line exists, the "Dinstar" placeholder is replaced by it (a saved "dinstar" choice then uses the first one).
const PHONE = 'line:';
async function phoneLines(user) {
  if (!user) return [];
  try {
    const PL = require('../browsercall/lines'); // eslint-disable-line global-require
    return (await PL.usableBy(user)).filter((l) => !l.builtIn);
  } catch { return []; }
}
async function anyDinstar() {
  try { return (await require('../browsercall/lines').rows()).some((r) => r.active && r.type === 'dinstar'); } catch { return false; } // eslint-disable-line global-require
}
function phoneLineReady(pl) {
  const { problems } = sipSettings();
  if (problems.length) return { ok: false, reason: `${pl.name} is set up, but this server cannot place click-to-call calls yet: ${problems[0]}` };
  return { ok: true, from: pl.callerId || null, note: `Your own phone rings first on ${pl.name}; when you pick up, the person is dialled on the same line.` };
}
const phoneEntry = (pl) => {
  const r = phoneLineReady(pl);
  return { id: `${PHONE}${pl.id}`, label: pl.name, text: `${pl.type === 'dinstar' ? 'Dinstar: ' : ''}${pl.name} (call)`, supports: ['Calls'], ready: !!r.ok, reason: r.ok ? null : r.reason, note: r.note || null, recording: false, from: r.from || null, phoneLine: true, type: pl.type };
};

/** The list the dropdown shows: [{ id, label, text, supports, ready, reason }], and which one is the default (the first that is ready, else api).
 *  With `user`, the Phone lines this person may use are listed too. */
async function list(user) {
  const out = [];
  const pls = await phoneLines(user);
  const dinstarSet = pls.some((l) => l.type === 'dinstar') || await anyDinstar();
  for (const l of LINES) {
    if (l.id === 'dinstar' && dinstarSet) continue; // the real Dinstar line(s) take its place
    // eslint-disable-next-line no-await-in-loop
    const r = await l.ready();
    out.push({ id: l.id, label: l.label, text: wordsOf(l), supports: l.supports, ready: !!r.ok, reason: r.ok ? null : r.reason, note: r.note || null, recording: !!r.recording, from: r.from || null });
  }
  for (const pl of pls) out.push(phoneEntry(pl));
  const first = out.find((x) => x.ready);
  return { lines: out, default: first ? first.id : 'api' };
}

async function startOnPhoneLine(lineId, args) {
  if (!args.user) return { ok: false, notConfigured: true, error: 'This call cannot use a Phone line from here. Pick API or SIP.', line: lineId };
  const PL = require('../browsercall/lines'); // eslint-disable-line global-require
  let id = String(lineId).slice(PHONE.length);
  if (String(lineId).toLowerCase() === 'dinstar') { const d = (await phoneLines(args.user)).find((l) => l.type === 'dinstar'); if (!d) return { ok: false, notConfigured: true, error: 'No Dinstar line you may use is set up.', line: 'dinstar' }; id = d.id; }
  const ln = await PL.resolveForCall(args.user, id);
  if (!ln.ok || ln.line.builtIn) return { ok: false, notConfigured: true, error: ln.reason || 'Pick a line.', line: lineId };
  const r = phoneLineReady(ln.line);
  if (!r.ok) return { ok: false, notConfigured: true, error: r.reason, line: lineId };
  const out = await originateOn({ endpoint: ln.line.endpoint, format: ln.line.dialFormat, prefix: ln.line.prefix, callerId: ln.line.callerId, lineName: ln.line.name }, args);
  return { ...out, line: `${PHONE}${ln.line.id}`, lineName: ln.line.name };
}

/** Start a call on a line. A line that is unknown is the API line; one that is not ready answers { ok:false, notConfigured:true, error }.
 *  "line:<id>" = a Phone line (needs args.user: the role must be allowed on it). */
async function startCall(lineId, args) {
  if (String(lineId || '').startsWith(PHONE) || (String(lineId || '').toLowerCase() === 'dinstar' && await anyDinstar())) return startOnPhoneLine(lineId, args || {});
  const l = byId(lineId) || byId('api');
  const r = await l.ready();
  if (!r.ok) return { ok: false, notConfigured: true, error: r.reason, line: l.id };
  const out = await l.start(args);
  return { lineName: l.label, ...out, line: l.id };
}

module.exports = { LINES, list, startCall, byId };
