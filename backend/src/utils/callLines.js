// ---------------------------------------------------------------------------
// CALL LINES - which line a call goes out on (founder 2026-11-16: "ats lo call ki drop down raavali: api (calls & msgs), dinstar (calls & msgs), sip (call)").
//
//   api       the connected telephony API (Exotel click-to-call today; the caller's own phone rings first, then the person)   calls + messages
//   dinstar   a Dinstar GSM gateway: calls over SIP, SMS through its own interface                                            calls + messages
//   sip       a SIP trunk / extension                                                                                          calls only
//
// Only "api" is connected so far. The other two are in the list so people see them, but they are NOT ready and a call on them is refused with
// the plain reason - nothing pretends to dial. When their setup details are known (Administration > Integrations), a line becomes ready by
// filling in its `ready()` and `start()` here; the screens and the route do not change.
// ---------------------------------------------------------------------------
const gw = require('./callGateway');

// THE SIP LINE = our own Synway SIM gateway through Asterisk (the same line the AI phone calls use: AI_VOICE_AMI_*, AI_VOICE_SIP_TRUNK - no telecom subscription).
// Click-to-call: Asterisk (AMI Originate) rings the CALLER's own phone first on the gateway; when it is answered, Asterisk dials the person on the same trunk and joins the two
// (Application Dial - no dialplan change). It uses the AI phone line's switch: in "Test" mode only the test numbers (AI_VOICE_TEST_NUMBERS) may be dialled, "Off" is off.
function sipSettings() {
  const sip = require('../calling/voice/sipCall'); // eslint-disable-line global-require
  const c = sip.config();
  const problems = [];
  if (c.via === 'direct') problems.push('The SIP line needs the Asterisk server (AI_VOICE_DIAL_VIA=direct is for an office PC).');
  else {
    if (!c.ami.user || !c.ami.secret) problems.push('The Asterisk manager login is not set on this server (AI_VOICE_AMI_USER / AI_VOICE_AMI_SECRET).');
    if (!c.trunk) problems.push('The SIM gateway line is not set on this server (AI_VOICE_SIP_TRUNK).');
  }
  if (c.mode === 'Off') problems.push('The phone line is switched off (AI_VOICE_PHONE_MODE=Off).');
  return { c, problems, dialNumber: sip.dialNumber };
}
async function sipReady() {
  const { c, problems } = sipSettings();
  if (problems.length) return { ok: false, reason: `SIP is not connected yet: ${problems[0]}` };
  return { ok: true, note: c.mode === 'Test' ? 'The phone line is in Test mode: only the test numbers can be called until it is switched to Live.' : '' };
}
async function sipStart({ agent, to }) {
  const { c, problems, dialNumber } = sipSettings();
  if (problems.length) return { ok: false, notConfigured: true, error: `SIP is not connected yet: ${problems[0]}` };
  const core = require('./messagingCore'); // eslint-disable-line global-require
  const a = core.normalizeMobile(agent); const p = core.normalizeMobile(to);
  if (!a.ok) return { ok: false, invalid: true, error: 'Your own phone number does not look right on your profile, so the SIP line cannot ring you first.' };
  if (!p.ok) return { ok: false, invalid: true, error: 'The number to call does not look right.' };
  if (c.mode === 'Test' && !c.testNumbers.includes(p.e164)) return { ok: false, error: 'The phone line is in Test mode: only the test numbers can be called. Ask an Admin to switch it to Live (AI_VOICE_PHONE_MODE) when you are ready.' };
  const sandbox = require('./sandbox'); // eslint-disable-line global-require
  if (sandbox.isSandbox() && !['127.0.0.1', 'localhost', '::1'].includes(String(c.ami.host))) return { ok: false, error: 'TEST MODE: this computer is a test copy and refuses to contact a real Asterisk server.' };
  const { Ami } = require('../calling/voice/ami'); // eslint-disable-line global-require
  const ami = new Ami(c.ami);
  try {
    await ami.connect();
    const r = await ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${dialNumber(a.e164, c.format)}@${c.trunk}`, // the caller's own phone rings first
      Application: 'Dial',
      Data: `PJSIP/${dialNumber(p.e164, c.format)}@${c.trunk},40`, // answered -> Asterisk dials the person and joins the two
      Timeout: '35000',
      ...(c.callerId ? { CallerID: c.callerId } : {}),
      Async: 'true',
    });
    ami.close();
    if (r.Response !== 'Success') return { ok: false, error: `Asterisk refused the call: ${String(r.Message || 'no reason given').replace(/[\r\n]+/g, ' ').slice(0, 160)}` };
    return { ok: true, callSid: `sip-${Date.now().toString(36)}`, status: 'queued', sandbox: sandbox.isSandbox() };
  } catch (e) {
    try { ami.close(); } catch { /* closing anyway */ }
    return { ok: false, transient: true, error: `Asterisk: ${String(e.message || e).replace(/[\r\n]+/g, ' ').replace(c.ami.secret || '\u0000', '•••').slice(0, 160)}` };
  }
}

const NOT_SET = (name) => `${name} is not connected yet. An Admin sets it up in Administration > Integrations; until then calls go on the API line.`;

const LINES = [
  {
    id: 'api', label: 'API', supports: ['Calls', 'Messages'],
    async ready() { const c = await gw.callConfig().catch(() => ({ configured: false, reason: 'not connected' })); return { ok: !!c.configured, reason: c.configured ? '' : (c.reason || 'The calling API is not connected.'), recording: !!c.record }; },
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

/** The list the dropdown shows: [{ id, label, text, supports, ready, reason }], and which one is the default (the first that is ready, else api). */
async function list() {
  const out = [];
  for (const l of LINES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await l.ready();
    out.push({ id: l.id, label: l.label, text: wordsOf(l), supports: l.supports, ready: !!r.ok, reason: r.ok ? null : r.reason, note: r.note || null, recording: !!r.recording });
  }
  const first = out.find((x) => x.ready);
  return { lines: out, default: first ? first.id : 'api' };
}

/** Start a call on a line. A line that is unknown is the API line; one that is not ready answers { ok:false, notConfigured:true, error }. */
async function startCall(lineId, args) {
  const l = byId(lineId) || byId('api');
  const r = await l.ready();
  if (!r.ok) return { ok: false, notConfigured: true, error: r.reason, line: l.id };
  const out = await l.start(args);
  return { ...out, line: l.id };
}

module.exports = { LINES, list, startCall, byId };
