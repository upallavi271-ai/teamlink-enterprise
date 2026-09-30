// ---------------------------------------------------------------------------
// SMS GATEWAY — MSG91, Fast2SMS or Twilio, chosen in Administration →
// Integrations → SMS Gateway. Credentials come from utils/integrationStore.js
// (the API key / auth token is AES-GCM encrypted at rest), are used here and
// are never returned or logged.
//
// Each adapter implements the provider's documented HTTP API:
//
//   MSG91     POST /api/v5/flow            header authkey, JSON
//             { template_id, short_url, recipients: [{ mobiles, var1, var2 … }] }
//             -> { type: 'success', message: '<request id>' }
//   Fast2SMS  POST /dev/bulkV2             header authorization, JSON
//             DLT:   { route: 'dlt', sender_id, message: <DLT id>,
//                      variables_values: 'a|b|c', numbers: '98…', flash: '0' }
//             OTP:   { route: 'otp', variables_values: '123456', numbers }
//             Quick: { route: 'q', message: <text>, numbers }
//             -> { return: true, request_id }
//   Twilio    POST /2010-04-01/Accounts/{SID}/Messages.json   Basic SID:token,
//             form To / From (or MessagingServiceSid) / Body -> 201 { sid }
//
// INDIA / DLT. Indian operators only deliver text that matches a DLT-approved
// template. Every message kind therefore has its own template id, and the
// variables are sent in a fixed order (documented in the Integrations form):
//   link  var1 = recipient name, var2 = agreement number, var3 = the link
//   otp   var1 = the code,       var2 = minutes it is valid
//   bulk  var1 = the whole message (register a one-variable template)
//
// Every send returns { ok, notConfigured, error, transient, providerRef,
// provider } and never throws.
// ---------------------------------------------------------------------------

const { readConfig } = require('./integrationStore');
const { SMS_FIELDS: F } = require('./adminCatalog');
const core = require('./messagingCore');

const BASES = {
  MSG91: 'https://control.msg91.com',
  FAST2SMS: 'https://www.fast2sms.com',
  TWILIO: 'https://api.twilio.com',
};

function providerOf(raw) {
  const p = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (p.startsWith('MSG91')) return 'MSG91';
  if (p.startsWith('FAST2SMS') || p === 'FAST2') return 'FAST2SMS';
  if (p.startsWith('TWILIO')) return 'TWILIO';
  return null;
}
const LABEL = { MSG91: 'MSG91', FAST2SMS: 'Fast2SMS', TWILIO: 'Twilio' };

// Is SMS switched on, and if not, why not — in words for a screen.
async function smsConfig() {
  const cfg = await readConfig('sms');
  const v = cfg.values || {};
  const provider = providerOf(v[F.provider]);
  const out = {
    provider,
    providerLabel: provider ? LABEL[provider] : null,
    sender: String(v[F.sender] || '').trim(),
    key: String(v[F.key] || '').trim(),
    sid: String(v[F.sid] || '').trim(),
    templates: {
      link: String(v[F.linkTpl] || '').trim(),
      otp: String(v[F.otpTpl] || '').trim(),
      bulk: String(v[F.bulkTpl] || '').trim(),
    },
    base: provider ? core.providerBase(BASES[provider], v) : null,
    testMode: !!core.devOverride(v),
  };
  const problems = [];
  if (!cfg.row) problems.push('The SMS Gateway has not been configured — Administration → Integrations → SMS Gateway.');
  else {
    if (!provider) problems.push('Choose the provider: MSG91, Fast2SMS or Twilio.');
    if (cfg.missingKey) problems.push('An API key is stored but this server cannot decrypt it (INTEGRATION_SECRET_KEY missing or changed).');
    else if (!out.key) problems.push('No API key / auth token.');
    if (provider === 'TWILIO' && !out.sid) problems.push('Twilio needs the Account SID.');
    if (provider === 'TWILIO' && !out.sender) problems.push('Twilio needs a From number or Messaging Service SID.');
    if (!cfg.row.enabled) problems.push('The channel is switched off.');
    else if (!cfg.connected) problems.push('The channel is disconnected — reconnect it in Administration → Integrations.');
  }
  return { ...out, configured: problems.length === 0, problems, reason: problems.join(' ') };
}

function failure(res, provider) {
  const j = res.json || {};
  const said = res.networkError
    || j.message || j.msg || (j.error && (j.error.message || j.error)) || res.text || `HTTP ${res.status}`;
  return {
    ok: false,
    provider,
    status: res.status,
    transient: core.isTransientHttp(res.status),
    error: core.tidy(`${LABEL[provider]}${res.status ? ` HTTP ${res.status}` : ''}: ${typeof said === 'string' ? said : JSON.stringify(said)}`),
  };
}

// --- The adapters -----------------------------------------------------------
async function viaMsg91(cfg, { mobile, kind, vars }) {
  const templateId = cfg.templates[kind];
  if (!templateId) {
    return { ok: false, notConfigured: true, transient: false, provider: 'MSG91', error: `MSG91 sends only approved Flow templates — add the "${kind}" template id in Administration → Integrations → SMS Gateway.` };
  }
  const recipient = { mobiles: mobile.e164 };
  (vars || []).forEach((val, i) => { recipient[`var${i + 1}`] = String(val == null ? '' : val); });
  const res = await core.httpJson(`${cfg.base}/api/v5/flow`, {
    method: 'POST',
    headers: { authkey: cfg.key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [recipient] }),
  });
  if (res.ok && res.json && String(res.json.type).toLowerCase() === 'success') {
    return { ok: true, provider: 'MSG91', providerRef: String(res.json.message || res.json.request_id || '') || null };
  }
  const f = failure(res, 'MSG91');
  // MSG91 answers some refusals with HTTP 200 + type:error — those are not transient.
  if (res.ok) f.transient = false;
  return f;
}

async function viaFast2sms(cfg, { mobile, kind, vars, text }) {
  if (mobile.cc !== '91') {
    return { ok: false, transient: false, provider: 'FAST2SMS', error: 'Fast2SMS delivers to Indian (+91) numbers only.' };
  }
  const templateId = cfg.templates[kind];
  let payload;
  if (templateId) {
    if (!cfg.sender) return { ok: false, notConfigured: true, transient: false, provider: 'FAST2SMS', error: 'Fast2SMS DLT route needs the Sender ID.' };
    payload = {
      route: 'dlt', sender_id: cfg.sender, message: templateId,
      variables_values: (vars || []).map((x) => String(x == null ? '' : x).replace(/\|/g, '/')).join('|'),
      numbers: mobile.national, flash: '0',
    };
  } else if (kind === 'otp') {
    payload = { route: 'otp', variables_values: String((vars || [])[0] || ''), numbers: mobile.national };
  } else {
    payload = { route: 'q', message: text, numbers: mobile.national, flash: '0' };
  }
  const res = await core.httpJson(`${cfg.base}/dev/bulkV2`, {
    method: 'POST',
    headers: { authorization: cfg.key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok && res.json && res.json.return === true) {
    return { ok: true, provider: 'FAST2SMS', providerRef: String(res.json.request_id || '') || null };
  }
  const f = failure(res, 'FAST2SMS');
  if (res.ok) f.transient = false;
  return f;
}

async function viaTwilio(cfg, { mobile, text }) {
  const form = new URLSearchParams();
  form.set('To', `+${mobile.e164}`);
  if (/^MG[0-9a-f]{32}$/i.test(cfg.sender)) form.set('MessagingServiceSid', cfg.sender);
  else form.set('From', cfg.sender);
  form.set('Body', text);
  const res = await core.httpJson(`${cfg.base}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.key}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });
  if (res.ok && res.json && res.json.sid) return { ok: true, provider: 'TWILIO', providerRef: res.json.sid };
  return failure(res, 'TWILIO');
}

// kind: 'link' | 'otp' | 'bulk'. `text` is the full message (used verbatim by
// Twilio and the Fast2SMS quick route); `vars` feed the DLT template.
async function sendSms({ to, kind = 'bulk', text, vars }) {
  const cfg = await smsConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, transient: false, error: cfg.reason };
  const mobile = core.normalizeMobile(to);
  if (!mobile.ok) return { ok: false, invalid: true, transient: false, error: mobile.reason };
  const body = String(text || (vars || []).join(' ')).slice(0, 1000);
  await core.acquire('SMS');
  if (cfg.provider === 'MSG91') return viaMsg91(cfg, { mobile, kind, vars: vars || [body] });
  if (cfg.provider === 'FAST2SMS') return viaFast2sms(cfg, { mobile, kind, vars: vars || [body], text: body });
  return viaTwilio(cfg, { mobile, text: body });
}

// "Test connection": an authenticated read that sends nothing.
async function testConnection() {
  const cfg = await smsConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, result: `Not configured — ${cfg.reason}` };
  let res;
  if (cfg.provider === 'MSG91') {
    res = await core.httpJson(`${cfg.base}/api/balance.json?type=4&authkey=${encodeURIComponent(cfg.key)}`, { headers: { authkey: cfg.key } });
    // The balance endpoint answers a bare number, or JSON with an error.
    const ok = res.ok && (res.json == null ? /^\s*[\d.]+\s*$/.test(res.text) : !(res.json && (res.json.type === 'error' || res.json.msgType === 'error')));
    return ok
      ? { ok: true, result: `Connected to MSG91${/^\s*[\d.]+/.test(res.text) ? ` — balance ${res.text.trim()}` : ''}${cfg.testMode ? ' (test server)' : ''}` }
      : { ok: false, result: `Failed — ${failure(res, 'MSG91').error}` };
  }
  if (cfg.provider === 'FAST2SMS') {
    res = await core.httpJson(`${cfg.base}/dev/wallet`, { headers: { authorization: cfg.key, accept: 'application/json' } });
    return res.ok && res.json && res.json.return === true
      ? { ok: true, result: `Connected to Fast2SMS — wallet ${res.json.wallet}${cfg.testMode ? ' (test server)' : ''}` }
      : { ok: false, result: `Failed — ${failure(res, 'FAST2SMS').error}` };
  }
  res = await core.httpJson(`${cfg.base}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}.json`, {
    headers: { authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.key}`).toString('base64')}`, accept: 'application/json' },
  });
  return res.ok && res.json
    ? { ok: true, result: `Connected to Twilio — account ${res.json.friendly_name || cfg.sid} (${res.json.status || 'ok'})${cfg.testMode ? ' (test server)' : ''}` }
    : { ok: false, result: `Failed — ${failure(res, 'TWILIO').error}` };
}

module.exports = { smsConfig, sendSms, testConnection, providerOf, BASES };
