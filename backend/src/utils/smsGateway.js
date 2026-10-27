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
//   SMS Push Platform (web.smsgw.in)  one request per message to the send address (default httpapi.jsp) with the DOCUMENTED fields
//             username, password, to, from, text, pe_id, template_id (+ coding=2 for Unicode) - from the provider's HTTP(S)/XML/JSON API
//             manual (the same manual Green Start's adapter follows) and the founder's 2026-10-27 prompt. Sent as a POST form, so the
//             password is never in a URL. Reply: {data:{ackid, msgid:["<id>,<mobile>"]}} / <ackid>..</ackid>, a refusal {Error:{ErrorCode,
//             ErrorDesc}}. Accepted ONLY when the reply carries an ackid / msgid; anything unreadable is "unknown", never "sent".
//             Delivery: the provider's Pull DLR API, GET dlrresp.jsp?ackid=<ackid> (only the ackid, as documented) - pullDelivery() below.
//             The address may only point at web.smsgw.in (no other host can receive the password).
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
const { SMS_FIELDS: F, integrationById } = require('./adminCatalog');

// A stored value equal to the form's greyed hint was saved by the old form by mistake: it is "not set", never a username / template id.
const SMS_CH = integrationById('sms');
const HINT = Object.fromEntries((SMS_CH.fields || []).filter(([l]) => (SMS_CH.hints || []).includes(l)).map(([l, ph]) => [l, String(ph || '').trim()]));
// hints the form showed before 2026-10-27 (an old save may have stored them as values)
const LEGACY_HINT = { [F.pushUser]: ['SMS Push Platform only'] };
const valOf = (v, label) => {
  const t = String((v && v[label]) || '').trim();
  return t && ((HINT[label] && t === HINT[label]) || (LEGACY_HINT[label] || []).includes(t)) ? '' : t;
};
// the only host the SMS Push Platform address may point at (the password goes there)
const PUSH_HOSTS = ['web.smsgw.in'];
const pushHostOk = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && PUSH_HOSTS.includes(u.hostname.toLowerCase()); } catch { return false; } };
const PUSH_DLR_URL = 'https://web.smsgw.in/dlrresponse/dlrresp.jsp';
// the error codes the provider's manual lists
const PUSH_ERRORS = {
  '010': 'The Sender ID is not valid for this account', 10: 'The Sender ID is not valid for this account',
  '011': 'The mobile number is not valid', 11: 'The mobile number is not valid',
  15: 'Not enough SMS credit on the SMS Push Platform account', '015': 'Not enough SMS credit on the SMS Push Platform account',
  103: 'The message is empty', 104: 'Message coding error', 105: 'The schedule time format is wrong',
};
const core = require('./messagingCore');

const BASES = {
  MSG91: 'https://control.msg91.com',
  FAST2SMS: 'https://www.fast2sms.com',
  TWILIO: 'https://api.twilio.com',
  SMSGW: 'https://web.smsgw.in',
};

function providerOf(raw) {
  const p = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (p.startsWith('MSG91')) return 'MSG91';
  if (p.startsWith('FAST2SMS') || p === 'FAST2') return 'FAST2SMS';
  if (p.startsWith('TWILIO')) return 'TWILIO';
  if (p.startsWith('SMSGW') || p.startsWith('SMSPUSH') || p.startsWith('PUSH')) return 'SMSGW';
  return null;
}
const LABEL = { MSG91: 'MSG91', FAST2SMS: 'Fast2SMS', TWILIO: 'Twilio', SMSGW: 'SMS Push Platform' };

// SMS PUSH PLATFORM: the documented request field names (2026-10-27). Only if the provider ever documents others are they changed, in
// Integrations > SMS Gateway > "request field names" (JSON), without a code change. India: the manual's numbers are 10 digits.
const PUSH_DEFAULT_NAMES = { method: 'POST', user: 'username', pass: 'password', sender: 'from', to: 'to', msg: 'text', pe: 'pe_id', tpl: 'template_id', coding: 'coding', toFormat: 'national', extra: {} };
const PUSH_DEFAULT_ID = '(?:ackid|msgid|messageid|message_id|requestid|request_id|mid)\\s*[:=]\\s*"?([A-Za-z0-9._-]{4,})';
const PUSH_ERROR = /errorcode|errordesc|error|invalid|fail|denied|not\s+(?:allowed|found|approved)|insufficient|blocked/i;
const PUSH_KEY = 'smsgw.accepted';
function pushNames(raw) {
  let given = {};
  try { given = raw ? JSON.parse(raw) : {}; } catch { given = {}; }
  const out = { ...PUSH_DEFAULT_NAMES };
  Object.keys(PUSH_DEFAULT_NAMES).forEach((k) => { if (given[k] !== undefined && given[k] !== null && given[k] !== '') out[k] = given[k]; });
  out.method = String(out.method).toUpperCase() === 'GET' ? 'GET' : 'POST';
  if (typeof out.extra !== 'object' || Array.isArray(out.extra)) out.extra = {};
  return out;
}
const pushNamesProblem = (raw) => {
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j && typeof j === 'object' && !Array.isArray(j) ? null : 'The request field names must be a JSON object, for example {"to":"mobile"}.'; } catch { return 'The request field names are not valid JSON.'; }
};
async function pushLastAccepted() {
  const prisma = require('../db'); // eslint-disable-line global-require
  const row = await prisma.appSetting.findUnique({ where: { key: PUSH_KEY } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

// Is SMS switched on, and if not, why not — in words for a screen.
async function smsConfig() {
  const cfg = await readConfig('sms');
  const v = cfg.values || {};
  const provider = providerOf(v[F.provider]);
  const isPush = provider === 'SMSGW';
  const out = {
    provider,
    providerLabel: provider ? LABEL[provider] : null,
    // SMS Push Platform has its own sender id and template ids; it never borrows MSG91 / Fast2SMS / Twilio's (2026-10-27)
    sender: isPush ? valOf(v, F.pushSender) : valOf(v, F.sender),
    key: String(v[F.key] || '').trim(),
    sid: valOf(v, F.sid),
    templates: isPush
      ? { link: valOf(v, F.pushLinkTpl), otp: valOf(v, F.pushOtpTpl), bulk: valOf(v, F.pushBulkTpl) }
      : { link: valOf(v, F.linkTpl), otp: valOf(v, F.otpTpl), bulk: valOf(v, F.bulkTpl) },
    dlrSecret: String(v[F.dlrSecret] || '').trim(),
    push: {
      url: valOf(v, F.pushUrl) || `${BASES.SMSGW}/smsapi/httpapi.jsp`,
      user: valOf(v, F.pushUser),
      pass: String(v[F.pushPass] || '').trim(),
      pe: valOf(v, F.pushPe),
      names: valOf(v, F.pushNames),
      idPattern: valOf(v, F.pushOk),
    },
    base: provider ? core.providerBase(BASES[provider], v) : null,
    pushDev: !!core.devOverride(v),
    testMode: !!core.devOverride(v),
  };
  const problems = [];
  if (!cfg.row) problems.push('The SMS Gateway has not been configured — Administration → Integrations → SMS Gateway.');
  else {
    if (!provider) problems.push('Choose the provider: MSG91, Fast2SMS, Twilio or SMS Push Platform.');
    if (cfg.missingKey) problems.push('A secret is stored but this server cannot decrypt it (INTEGRATION_SECRET_KEY missing or changed).');
    else if (provider === 'SMSGW') {
      if (!out.push.user) problems.push('SMS Push Platform needs the API username.');
      if (!out.push.pass) problems.push('SMS Push Platform needs the API password (not the portal login password).');
      if (!out.sender) problems.push('SMS Push Platform needs its own Sender ID (the DLT-registered header for this account).');
      else if (!/^[A-Za-z0-9]{3,11}$/.test(out.sender)) problems.push('The SMS Push Platform Sender ID must be 3-11 letters or digits (e.g. a 6-letter DLT header).');
      if (!out.push.pe) problems.push('SMS Push Platform needs the DLT Principal Entity ID (PE ID).');
      else if (!/^\d{10,25}$/.test(out.push.pe)) problems.push('The DLT Principal Entity ID (PE ID) is a number from your DLT registration (usually 19 digits), not a template id.');
      ['bulk', 'link', 'otp'].forEach((k) => { const t = out.templates[k]; if (t && !/^\d{6,25}$/.test(t)) problems.push(`The SMS Push Platform ${k === 'bulk' ? 'Bulk / General' : k === 'link' ? 'Agreement Link' : 'OTP'} DLT Template ID must be the approved template's number (digits only), not the message text.`); });
      if (out.push.pe && out.push.pe === out.templates.bulk) problems.push('The PE ID and the Bulk / General DLT Template ID are the same number: the PE ID is your entity id, the template id belongs to one message.');
      if (!core.devOverride(v) && !pushHostOk(out.push.url)) problems.push('The SMS Push Platform send address must be an https address on web.smsgw.in (for example https://web.smsgw.in/smsapi/httpapi.jsp).');
      const np = pushNamesProblem(out.push.names); if (np) problems.push(np);
      if (out.push.idPattern) { try { new RegExp(out.push.idPattern, 'i'); } catch { problems.push('The message-id pattern is not a valid pattern.'); } }
    } else if (!out.key) problems.push('No API key / auth token.');
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
async function viaMsg91(cfg, { mobile, kind, vars, templateId: ownTemplate }) {
  // ownTemplate: the DLT id of a Message templates entry (else the one per kind from Integrations).
  const templateId = ownTemplate || cfg.templates[kind];
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

async function viaFast2sms(cfg, { mobile, kind, vars, text, templateId: ownTemplate, senderId }) {
  if (mobile.cc !== '91') {
    return { ok: false, transient: false, provider: 'FAST2SMS', error: 'Fast2SMS delivers to Indian (+91) numbers only.' };
  }
  const templateId = ownTemplate || cfg.templates[kind];
  let payload;
  if (templateId) {
    if (!(senderId || cfg.sender)) return { ok: false, notConfigured: true, transient: false, provider: 'FAST2SMS', error: 'Fast2SMS DLT route needs the Sender ID.' };
    payload = {
      route: 'dlt', sender_id: senderId || cfg.sender, message: templateId,
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
  // Twilio tells us delivered / undelivered / failed here (signed; routes/webhooks.js).
  if (process.env.APP_BASE_URL) form.set('StatusCallback', `${String(process.env.APP_BASE_URL).replace(/[/]+$/, '')}/api/webhooks/sms/twilio`);
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

async function viaSmsPush(cfg, { mobile, kind, text, templateId: ownTemplate, senderId }) {
  const p = cfg.push;
  const templateId = ownTemplate || cfg.templates[kind];
  if (!templateId) {
    return { ok: false, notConfigured: true, transient: false, provider: 'SMSGW', error: `SMS Push Platform delivers only DLT-approved templates: choose a template that has a DLT Template ID (or add the "${kind}" template id in Integrations > SMS Gateway).` };
  }
  const n = pushNames(p.names);
  const form = new URLSearchParams();
  form.set(n.user, p.user); form.set(n.pass, p.pass);
  form.set(n.sender, senderId || cfg.sender);
  // the manual's numbers are 10 digits for India; other countries go as the full number
  form.set(n.to, n.toFormat === 'national' && mobile.cc === '91' ? mobile.national : mobile.e164);
  form.set(n.msg, text);
  form.set(n.pe, p.pe); form.set(n.tpl, templateId);
  // "coding: 2 for Unicode SMS, default non-Unicode" (manual): Telugu / Hindi text goes as Unicode
  if (n.coding && /[^\x00-\x7F]/.test(text)) form.set(n.coding, '2');
  Object.entries(n.extra).forEach(([k, v]) => form.set(k, String(v)));
  if (!cfg.pushDev && !pushHostOk(p.url)) return { ok: false, notConfigured: true, transient: false, provider: 'SMSGW', error: 'The SMS Push Platform send address must be an https address on web.smsgw.in. Nothing was sent.' };
  const url = cfg.pushDev ? `${cfg.base}${new URL(p.url).pathname}` : p.url;
  // the password goes in the BODY (POST) unless the provider's document says GET; it is never put in anything we keep
  const res = n.method === 'GET'
    ? await core.httpJson(`${url}${url.includes('?') ? '&' : '?'}${form.toString()}`, { headers: { accept: '*/*' } })
    : await core.httpJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: '*/*' }, body: form.toString() });
  const scrub = (t) => String(t || '').split(p.pass).join('***').split(p.user).join('***');
  const said = scrub(res.networkError || (res.json ? JSON.stringify(res.json) : res.text)).replace(/\s+/g, ' ').trim().slice(0, 300);
  // a timeout may have reached the provider, so only "cannot reach it at all" is retried (a repeat could send the SMS twice)
  if (res.networkError) return { ok: false, provider: 'SMSGW', transient: /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(res.networkError), error: core.tidy(`SMS Push Platform did not answer: ${said}`) };
  if (!res.ok) return { ok: false, provider: 'SMSGW', status: res.status, transient: core.isTransientHttp(res.status), error: core.tidy(`SMS Push Platform HTTP ${res.status}: ${said}`) };
  const body = res.json ? JSON.stringify(res.json) : String(res.text || '');
  const reply = parsePushReply(res.json, body);
  if (reply.errorCode || reply.errorDesc) {
    const code = String(reply.errorCode || '').trim();
    const auth = /auth|login|user\s*name|password|credential/i.test(reply.errorDesc || '');
    return { ok: false, provider: 'SMSGW', transient: false, providerError: true, authFailed: auth, errorCode: code || null, error: core.tidy(`SMS Push Platform refused it${code ? ` (code ${code})` : ''}: ${PUSH_ERRORS[code] || scrub(reply.errorDesc) || said}`) };
  }
  let id = reply.msgid || reply.ackid || null;
  if (!id && p.idPattern) { try { const m = new RegExp(p.idPattern, 'i').exec(body); id = m && (m[1] || m[0]) ? String(m[1] || m[0]).slice(0, 80) : null; } catch { id = null; } }
  // an error word with no id is a refusal: a refused message must never look sent
  if (!id && PUSH_ERROR.test(body)) return { ok: false, provider: 'SMSGW', transient: false, providerError: true, authFailed: /auth|login|password|user/i.test(body), error: core.tidy(`SMS Push Platform refused it: ${said}`) };
  if (!id) { try { const m = new RegExp(PUSH_DEFAULT_ID, 'i').exec(body); id = m && m[1] ? String(m[1]).slice(0, 80) : null; } catch { id = null; } }
  if (!id) {
    // We cannot tell from this answer whether the provider took the message. Not retried (it might have), not called sent.
    return { ok: false, provider: 'SMSGW', transient: false, unknown: true, error: core.tidy(`SMS Push Platform answered, but TeamLink cannot read a message id from it, so it is NOT counted as sent. Answer: ${said || '(empty)'}. Check the request field names / message-id pattern against the provider's API document before sending again.`) };
  }
  const prisma = require('../db'); // eslint-disable-line global-require
  const mark = JSON.stringify({ at: new Date().toISOString(), ref: id });
  await prisma.appSetting.upsert({ where: { key: PUSH_KEY }, create: { key: PUSH_KEY, value: mark }, update: { value: mark } }).catch(() => {});
  // Accepted by the provider is NOT delivered: the ackid is kept so the Pull DLR API can tell delivered / failed later.
  return { ok: true, provider: 'SMSGW', providerRef: id, ackId: reply.ackid || null, msgId: reply.msgid || null };
}

// The send reply, JSON or XML: { ackid, msgid, errorCode, errorDesc }. msgid "<id>,<mobile>" is cut to the id.
function parsePushReply(json, text) {
  const cut = (m) => (m == null ? null : String(Array.isArray(m) ? m[0] : m).split(',')[0].trim() || null);
  if (json && typeof json === 'object') {
    const err = json.Error || json.error;
    if (err && typeof err === 'object') return { errorCode: String(err.ErrorCode ?? err.errorcode ?? err.code ?? ''), errorDesc: String(err.ErrorDesc ?? err.errordesc ?? err.message ?? '') };
    const d = json.data && typeof json.data === 'object' ? json.data : json;
    return { ackid: d.ackid ? String(d.ackid).trim() : null, msgid: cut(d.msgid) };
  }
  const t = String(text || '');
  const tag = (name) => { const m = new RegExp(`<${name}\\s*>\\s*([^<]*?)\\s*</${name}\\s*>`, 'i').exec(t); return m ? m[1] : null; };
  if (/<Error\b/i.test(t)) return { errorCode: tag('ErrorCode') || '', errorDesc: tag('ErrorDesc') || '' };
  return { ackid: tag('ackid'), msgid: cut(tag('msgid')) };
}

// THE PROVIDER'S PULL DLR API (manual): GET dlrresp.jsp?ackid=<ackid>, only the ackid. The reply is XML:
// <dlr><dlrinfo><msgid/><ackid/><mob/><dlrdesc/>...</dlrinfo>...</dlr>. Returns the reports it could read; SUBMITTED / unknown words are
// left out (not final). Never throws; nothing is marked delivered unless the provider's own report says DELIVRD / DELIVERED.
async function pullDelivery(ackId) {
  const id = String(ackId || '').trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(id)) return { ok: false, error: 'No acknowledgement id to ask about.' };
  const cfg = await smsConfig();
  const url = cfg.pushDev && cfg.base ? `${cfg.base}/dlrresponse/dlrresp.jsp` : PUSH_DLR_URL;
  const res = await core.httpJson(`${url}?ackid=${encodeURIComponent(id)}`, { headers: { accept: '*/*' } });
  if (res.networkError) return { ok: false, error: core.tidy(`SMS Push Platform did not answer: ${res.networkError}`) };
  if (!res.ok) return { ok: false, error: `SMS Push Platform HTTP ${res.status}` };
  const text = String(res.text || '');
  const tag = (block, name) => { const m = new RegExp(`<${name}\\s*>\\s*([^<]*?)\\s*</${name}\\s*>`, 'i').exec(block); return m ? m[1] : ''; };
  const reports = [];
  for (const m of text.matchAll(/<dlrinfo\s*>([\s\S]*?)<\/dlrinfo\s*>/gi)) {
    const block = m[1] || '';
    const msgid = String(tag(block, 'msgid')).split(',')[0].trim();
    const word = tag(block, 'dlrdesc').trim();
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    const status = ['delivered', 'delivrd'].includes(w) ? 'delivered'
      : ['undelivered', 'undeliv', 'failed', 'expired', 'rejected', 'rejectd', 'blocked'].includes(w) ? 'failed' : null;
    if (msgid && status) reports.push({ msgid, status, word, at: tag(block, 'delvtime') || null });
  }
  return { ok: true, reports, answered: /<dlr/i.test(text) };
}

// kind: 'link' | 'otp' | 'bulk'. `text` is the full message (used verbatim by
// Twilio and the Fast2SMS quick route); `vars` feed the DLT template.
async function sendSms({ to, kind = 'bulk', text, vars, templateId, senderId }) {
  const cfg = await smsConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, transient: false, error: cfg.reason };
  const mobile = core.normalizeMobile(to);
  if (!mobile.ok) return { ok: false, invalid: true, transient: false, error: mobile.reason };
  if (kind === 'bulk' && await require('./messageDelivery').optedOut('SMS', to)) { // eslint-disable-line global-require
    return { ok: false, invalid: true, transient: false, error: 'They replied STOP to our SMS, so nothing more is sent to them there.' };
  }
  const body = String(text || (vars || []).join(' ')).slice(0, 1000);
  // TEST SANDBOX: reported as sent, never transmitted (utils/sandbox.js).
  if (require('./sandbox').isSandbox()) return { ok: true, provider: 'SANDBOX', providerRef: `sandbox-sms-${Date.now().toString(36)}`, sandbox: true };
  await core.acquire('SMS');
  if (cfg.provider === 'MSG91') return viaMsg91(cfg, { mobile, kind, vars: vars || [body], templateId });
  if (cfg.provider === 'FAST2SMS') return viaFast2sms(cfg, { mobile, kind, vars: vars || [body], text: body, templateId, senderId });
  if (cfg.provider === 'SMSGW') return viaSmsPush(cfg, { mobile, kind, text: body, templateId, senderId });
  return viaTwilio(cfg, { mobile, text: body });
}

// "Test connection": an authenticated read that sends nothing.
async function testConnection() {
  const cfg = await smsConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, result: `Not configured — ${cfg.reason}` };
  let res;
  if (cfg.provider === 'SMSGW') {
    // No connection-test or balance call is documented for this provider, and a send is the only call whose shape we know (it costs one SMS).
    // So "connected" means: the provider really accepted a message from here. Nothing is called now and nothing is pretended.
    const last = await pushLastAccepted();
    return last
      ? { ok: true, verified: true, result: `Connected to SMS Push Platform: it last accepted a message on ${new Date(last.at).toLocaleString('en-IN')} (id ${last.ref}).` }
      : { ok: false, needsConfirmation: true, result: 'Saved, but not proven yet. The provider has no documented connection test, so press "Send test SMS" (one real SMS to your own number) to prove the login, sender ID and DLT details.' };
  }
  if (cfg.provider === 'MSG91') {
    res = await core.httpJson(`${cfg.base}/api/balance.json?type=4&authkey=${encodeURIComponent(cfg.key)}`, { headers: { authkey: cfg.key } });
    // The balance endpoint answers a bare number, or JSON with an error.
    const ok = res.ok && (res.json == null ? /^\s*[\d.]+\s*$/.test(res.text) : !(res.json && (res.json.type === 'error' || res.json.msgType === 'error')));
    return ok
      ? { ok: true, result: `Connected to MSG91${/^\s*[\d.]+/.test(res.text) ? ` — balance ${res.text.trim()}` : ''}${cfg.testMode ? ' (test server)' : ''}` }
      : { ok: false, result: `Failed — ${failure(res, 'MSG91').error}` };
  }
  if (cfg.provider === 'FAST2SMS') {
    res = await core.httpJson(`${cfg.base}/dev/wallet`, { method: 'POST', headers: { authorization: cfg.key, accept: 'application/json' } }); // POST per docs.fast2sms.com/reference/wallet-balance.md
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

module.exports = { smsConfig, sendSms, testConnection, providerOf, BASES, pushNames, pushLastAccepted, PUSH_DEFAULT_NAMES, PUSH_DEFAULT_ID, parsePushReply, pullDelivery, pushHostOk, PUSH_HOSTS };
