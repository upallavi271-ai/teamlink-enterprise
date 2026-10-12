// ---------------------------------------------------------------------------
// CLICK-TO-CALL through a cloud-telephony account — EXOTEL first.
//
// Why Exotel: the only Indian provider whose click-to-call request, answer and
// call-result callback are all public (checked 2026-10-09):
//   https://developer.exotel.com/docs/voice-v3/api-reference/connect-two-numbers
//   https://developer.exotel.com/docs/voice-v1/api-reference/status-callback
//   https://developer.exotel.com/docs/references/authentication
//
//   POST https://<host>/v1/Accounts/<AccountSID>/Calls/connect
//        HTTP Basic: API key : API token       form-encoded
//        From      the AGENT's own phone (rung first)
//        To        the person being called (rung when the agent answers)
//        CallerId  your ExoPhone (virtual number, after Exotel KYC)
//        CallType=trans, Record=true|false, CustomField, StatusCallback,
//        StatusCallbackEvents[]=terminal, StatusCallbackContentType=application/json
//   -> { Call: { Sid, Status: queued|in-progress|... } }
//   host: Singapore account api.exotel.com, Mumbai account api.in.exotel.com
//   Rate: about 20 calls a minute (docs differ: another page says 200).
//
// The result arrives at /api/webhooks/call/exotel (routes/webhooks.js): Status
// completed|failed|busy|no-answer, ConversationDuration, RecordingUrl, CustomField.
//
// What this does NOT do: bulk auto-dialling. A call is one agent <-> one person,
// started by a click (this is also the compliant pattern: promotional
// auto-dialling needs a 140-series number registered with the telcos).
// The agent's phone is taken from their own employee record.
// ---------------------------------------------------------------------------
const { readConfig } = require('./integrationStore');
const core = require('./messagingCore');

const F = {
  provider: 'Provider (Exotel)',
  sid: 'Account SID',
  key: 'API key',
  token: 'API token',
  region: 'Region (Mumbai or Singapore)',
  callerId: 'Caller ID (your ExoPhone number)',
  record: 'Record calls (Yes or No)',
  secret: 'Call-result webhook secret (any text you choose)',
};
const HOSTS = { mumbai: 'https://api.in.exotel.com', singapore: 'https://api.exotel.com' };

async function callConfig() {
  const cfg = await readConfig('telephony');
  const v = cfg.values || {};
  const region = /sing/i.test(String(v[F.region] || '')) ? 'singapore' : 'mumbai';
  const out = {
    sid: String(v[F.sid] || '').trim(),
    key: String(v[F.key] || '').trim(),
    token: String(v[F.token] || '').trim(),
    callerId: String(v[F.callerId] || '').trim(),
    secret: String(v[F.secret] || '').trim(),
    record: /^y/i.test(String(v[F.record] || '').trim()),
    region,
    base: core.providerBase(HOSTS[region], v),
    testMode: !!core.devOverride(v),
  };
  const problems = [];
  if (!cfg.row) problems.push('Cloud Telephony has not been configured — Administration → Integrations → Cloud Telephony / IVR.');
  else {
    const prov = String(v[F.provider] || '').trim();
    if (prov && !/exotel/i.test(prov)) problems.push(`"${prov}" is not supported yet. Exotel is the only calling provider connected today.`);
    if (!out.sid) problems.push('No Account SID (Exotel dashboard → Settings → API Settings).');
    if (cfg.missingKey) problems.push('A saved key could not be read (INTEGRATION_SECRET_KEY missing or changed). Enter it again.');
    else if (!out.key || !out.token) problems.push('No API key / API token (Exotel dashboard → Settings → API Settings).');
    if (!out.callerId) problems.push('No Caller ID: the ExoPhone number Exotel gave you after KYC.');
    if (!cfg.row.enabled) problems.push('The channel is switched off.');
    else if (!cfg.connected) problems.push('The channel is disconnected — reconnect it in Administration → Integrations.');
  }
  return { ...out, configured: problems.length === 0, problems, reason: problems.join(' ') };
}

const auth = (cfg) => `Basic ${Buffer.from(`${cfg.key}:${cfg.token}`).toString('base64')}`;

// ~20 calls a minute (Exotel's documented limit): keep under it.
const recent = [];
function throttled() {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (recent.length >= 18) return true;
  recent.push(now);
  return false;
}

function failureWords(res) {
  const j = res.json || {};
  const said = (j.RestException && (j.RestException.Message || j.RestException.Status)) || j.message || res.networkError || res.text || `HTTP ${res.status}`;
  if (res.status === 401) return 'Exotel did not accept the API key / token (or the Region is wrong: Mumbai accounts use a different address from Singapore ones).';
  if (res.status === 409) return `The calling phone cannot take the call right now: ${core.tidy(typeof said === 'string' ? said : JSON.stringify(said))}`;
  if (res.status === 429) return 'Exotel says too many calls at once. Wait a minute and try again.';
  return `Exotel${res.status ? ` HTTP ${res.status}` : ''}: ${core.tidy(typeof said === 'string' ? said : JSON.stringify(said))}`;
}

// agent = the person's own number (rung first); to = the person to reach.
// ref = our own reference echoed back in the result (CustomField, <= 128 chars).
async function startCall({ agent, to, ref, callbackBase }) {
  const cfg = await callConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, error: cfg.reason };
  const a = core.normalizeMobile(agent);
  if (!a.ok) return { ok: false, invalid: true, error: `Your own phone number is not usable: ${a.reason}. Add it on your employee profile.` };
  const t = core.normalizeMobile(to);
  if (!t.ok) return { ok: false, invalid: true, error: t.reason };
  if (a.e164 === t.e164) return { ok: false, invalid: true, error: 'Your own number and the number to call are the same.' };
  if (require('./sandbox').isSandbox()) return { ok: true, sandbox: true, callSid: `sandbox-call-${Date.now().toString(36)}`, status: 'queued' }; // eslint-disable-line global-require
  if (throttled()) return { ok: false, transient: true, error: 'Too many calls started in the last minute (Exotel allows about 20). Wait a little and try again.' };
  const form = new URLSearchParams();
  form.set('From', `+${a.e164}`);
  form.set('To', `+${t.e164}`);
  form.set('CallerId', cfg.callerId);
  form.set('CallType', 'trans');
  form.set('Record', cfg.record ? 'true' : 'false');
  form.set('TimeLimit', '1800');
  if (ref) form.set('CustomField', String(ref).slice(0, 128));
  if (callbackBase && cfg.secret) {
    form.set('StatusCallback', `${callbackBase}/api/webhooks/call/exotel?key=${encodeURIComponent(cfg.secret)}`);
    form.append('StatusCallbackEvents[]', 'terminal');
    form.set('StatusCallbackContentType', 'application/json');
  }
  const res = await core.httpJson(`${cfg.base}/v1/Accounts/${encodeURIComponent(cfg.sid)}/Calls/connect`, {
    method: 'POST',
    headers: { authorization: auth(cfg), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
  const call = res.json && res.json.Call;
  if (res.ok && call && call.Sid) return { ok: true, callSid: call.Sid, status: call.Status || 'queued', recording: cfg.record };
  return { ok: false, transient: core.isTransientHttp(res.status), error: failureWords(res) };
}

// "Check connection": a signed read that places no call (the list of recent calls, 1 row).
async function testConnection() {
  const cfg = await callConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, result: `Not configured — ${cfg.reason}` };
  if (require('./sandbox').isSandbox()) return { ok: false, result: 'This test copy blocks every outside call, so the account could not be reached.' }; // eslint-disable-line global-require
  const res = await core.httpJson(`${cfg.base}/v1/Accounts/${encodeURIComponent(cfg.sid)}/Calls.json?PageSize=1`, {
    headers: { authorization: auth(cfg), accept: 'application/json' },
  });
  if (res.ok && res.json) return { ok: true, result: `Connected to Exotel (${cfg.region === 'mumbai' ? 'Mumbai' : 'Singapore'} account ${cfg.sid})${cfg.testMode ? ' (test server)' : ''}. No call was placed.` };
  return { ok: false, result: `Failed — ${failureWords(res)}` };
}

// A result callback -> a plain row for our call log. Accepts Exotel's JSON or form body.
function readCallback(body) {
  const b = body || {};
  const status = String(b.Status || b.CallStatus || '').toLowerCase();
  const dur = Number(b.ConversationDuration != null ? b.ConversationDuration : b.Duration);
  return {
    callSid: b.CallSid || b.Sid || null,
    status,
    seconds: Number.isFinite(dur) ? dur : null,
    recordingUrl: b.RecordingUrl || null,
    ref: b.CustomField || null,
    answeredBy: Array.isArray(b.Legs) && b.Legs[1] ? b.Legs[1].AnsweredBy || null : null,
  };
}

module.exports = { callConfig, startCall, testConnection, readCallback, F, HOSTS };
