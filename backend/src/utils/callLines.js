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
    id: 'sip', label: 'SIP', supports: ['Calls'],
    async ready() { return { ok: false, reason: NOT_SET('SIP') }; },
    async start() { return { ok: false, notConfigured: true, error: NOT_SET('SIP') }; },
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
    out.push({ id: l.id, label: l.label, text: wordsOf(l), supports: l.supports, ready: !!r.ok, reason: r.ok ? null : r.reason, recording: !!r.recording });
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
