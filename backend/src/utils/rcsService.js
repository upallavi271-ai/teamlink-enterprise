// ---------------------------------------------------------------------------
// RCS SERVICE — rcssms.in JSON API (founder's spec 2026-10-30). Every provider call is made HERE, on the server. The login comes from
// backend/.env only and never reaches a screen, a log, an audit row or an answer: every provider answer is scrubbed of it.
//
//   RCS_BASE_URL       https://web.rcssms.in (the provider's public https address; a loopback address only for a test mock)
//   RCS_USERNAME / RCS_PASSWORD / RCS_ID (the rcsid, e.g. 230)
//   RCS_AUTH_MODE      password (default) | token
//   RCS_CLIENT_SECRET  token mode only: Authorization "Basic base64(username:clientSecret)" to {BASE}/api/rcs/accesstoken
//   RCS_TOKEN_METHOD   POST (default) | GET - the provider's document does not say which, so it is a setting
//   RCS_WEBHOOK_SECRET the ?token= of the webhook address (routes/rcsWebhook.js)
//   RCS_SEND_APITYPE / RCS_PERSONAL_APITYPE   the "apitype" of the two send addresses. NO DEFAULT ON PURPOSE (founder 2026-10-30): the
//                      sending document says apitype=2, the implementation brief (and Green Start's reading of the "JSON RCS API" PDF,
//                      "Method 1, preferred") says apitype=1. Until rcssms.in confirms it and the value is set, that send is refused.
//
//   sendRcs()              POST {BASE}/rcsapi/jsonapi.jsp?apitype=<RCS_SEND_APITYPE>      {username, password, rcstype, rcsid, msisdn:"n1,n2", variables:[{var1}], templateid}
//                          (+ button:[{url}] dynamic URL button, + cardMedia:[{fileUrl}] rich card image). At most 500 numbers per request.
//   sendRcsPersonalized()  POST {BASE}/rcsapimtpl/jsonapi.jsp?apitype=<RCS_PERSONAL_APITYPE>   {username, password, rcsid, messages:[{msisdn, templateid, variables, button?}]}
//   createTemplate()       POST {BASE}/rcsapi/rcscreatetemplate.jsp       BASIC / RICH -> {templateid, status: PENDING}
//   Token mode: the send calls carry "Authorization: Bearer <token>" instead of the password; the token is kept in memory for 24 h and
//   fetched again once when the provider answers error 30 (token expired).
//
// "Sent" means only that the provider's answer named a msgid for that number. An answer TeamLink cannot read is NOT sent.
// TEST SANDBOX: with a loopback RCS_BASE_URL (a test's own stub server) the calls go there; otherwise NOTHING is sent and the answer
// says so (founder 2026-10-30: no mock answers, no fake success). A stub's answer never proves the real account (see proof below).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const core = require('./messagingCore');

const TYPES = ['BASIC', 'RICH', 'RICHCASOUREL']; // the provider's own spelling of carousel
const MAX_PER_REQUEST = 500;
const TOKEN_TTL_MS = 24 * 3600 * 1000;
const PRIVATE_NAME = /^(localhost|.*\.(local|internal|lan|home|corp|intranet|localdomain))$/i;

// The provider's error codes, in plain words for the screen.
const ERRORS = {
  13: 'The request was not valid JSON. This is a TeamLink problem: tell the developer.',
  10: 'Some required details were missing (username, RCS ID, template or numbers).',
  15: 'The RCS account validity has expired. Renew it on rcssms.in.',
  21: 'The RCS username is not valid. Check RCS_USERNAME in the server settings.',
  22: 'Wrong RCS username, password or token. Check the RCS login in the server settings.',
  23: 'Not enough RCS credit. Sending is paused until credit is added on rcssms.in.',
  24: 'The number list is not correct.',
  18: 'This template id was not found on rcssms.in.',
  30: 'The RCS login token expired.',
};
const friendly = (code, fallback) => ERRORS[String(code)] || fallback || `rcssms.in refused it${code ? ` (code ${code})` : ''}.`;

const env = (k) => String(process.env[k] == null ? '' : process.env[k]).trim();
const isSandbox = () => require('./sandbox').isSandbox(); // eslint-disable-line global-require

function hostProblem(base) {
  let u;
  try { u = new URL(base); } catch { return 'RCS_BASE_URL is not a web address.'; }
  if (core.loopback(base)) return process.env.NODE_ENV === 'production' ? 'RCS_BASE_URL points at this machine.' : null; // a test mock
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password) return 'RCS_BASE_URL must be an https address (https://web.rcssms.in).';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('[') || PRIVATE_NAME.test(h) || !h.includes('.')) return 'RCS_BASE_URL must be the provider\'s public address, not an IP or an internal name.';
  return null;
}

// The settings from .env, checked. Never returns a secret: only whether each one is there.
function config() {
  const base = (env('RCS_BASE_URL') || 'https://web.rcssms.in').replace(/\/+$/, '');
  const mode = env('RCS_AUTH_MODE').toLowerCase() === 'token' ? 'token' : 'password';
  const out = {
    base,
    user: env('RCS_USERNAME'),
    pass: env('RCS_PASSWORD'),
    rcsId: env('RCS_ID'),
    mode,
    clientSecret: env('RCS_CLIENT_SECRET'),
    tokenMethod: env('RCS_TOKEN_METHOD').toUpperCase() === 'GET' ? 'GET' : 'POST',
    tokenPath: env('RCS_TOKEN_PATH') || '/api/rcs/accesstoken',
    webhookSecret: env('RCS_WEBHOOK_SECRET'),
    sendApiType: /^\d{1,2}$/.test(env('RCS_SEND_APITYPE')) ? env('RCS_SEND_APITYPE') : '',
    personalApiType: /^\d{1,2}$/.test(env('RCS_PERSONAL_APITYPE')) ? env('RCS_PERSONAL_APITYPE') : '',
    local: core.loopback(base),
  };
  const problems = [];
  const hp = hostProblem(base); if (hp) problems.push(hp);
  if (!out.user) problems.push('RCS_USERNAME is not set in the server settings (backend/.env).');
  if (mode === 'password' && !out.pass) problems.push('RCS_PASSWORD is not set in the server settings (backend/.env).');
  if (mode === 'token' && !out.clientSecret) problems.push('RCS_AUTH_MODE is token, but RCS_CLIENT_SECRET is not set.');
  if (!out.rcsId) problems.push('RCS_ID (your rcsid, for example 230) is not set in the server settings.');
  else if (!/^\d{1,12}$/.test(out.rcsId)) problems.push('RCS_ID must be a number (for example 230).');
  const warnings = [];
  if (!out.sendApiType) warnings.push('RCS_SEND_APITYPE is not set: the send document says apitype=2, the brief says apitype=1. Ask rcssms.in which one, then set it. Until then nothing is sent to many with the same words.');
  if (!out.personalApiType) warnings.push('RCS_PERSONAL_APITYPE is not set (the per-person send address, rcsapimtpl). Until rcssms.in confirms it, per-person messages are not sent.');
  return { ...out, configured: problems.length === 0, problems, warnings, reason: problems.join(' ') };
}

// What a screen may know about the settings.
function publicConfig() {
  const c = config();
  let host = '';
  try { host = new URL(c.base).host; } catch { host = ''; }
  return {
    configured: c.configured, problems: c.problems, warnings: c.warnings, host, mode: c.mode, tokenMethod: c.tokenMethod,
    sendApiType: c.sendApiType || null, personalApiType: c.personalApiType || null,
    usernameSet: !!c.user, passwordSet: !!c.pass, rcsIdSet: !!c.rcsId, clientSecretSet: !!c.clientSecret, webhookSecretSet: !!c.webhookSecret,
    sandbox: isSandbox(),
  };
}

// Takes the login (and a token) out of any text before it is shown or kept.
function scrubber(cfg, extra = []) {
  const secrets = [cfg.pass, cfg.clientSecret, cfg.user, ...extra].filter((s) => s && String(s).length >= 3);
  return (t) => secrets.reduce((s, x) => s.split(String(x)).join('***'), String(t == null ? '' : t));
}

// ---- phone numbers (spec point 2): digits only, 10 digits -> 91 in front, invalid and repeated numbers left out ----------------------
function normalizeNumber(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return { ok: true, msisdn: d };
  return { ok: false, reason: d ? `"${String(raw).trim()}" is not a valid Indian mobile number` : 'No mobile number' };
}
function cleanNumbers(list) {
  const valid = []; const invalid = []; const duplicate = [];
  const seen = new Set();
  (Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/)).forEach((raw) => {
    if (raw == null || String(raw).trim() === '') return;
    const n = normalizeNumber(raw);
    if (!n.ok) invalid.push({ raw: String(raw), reason: n.reason });
    else if (seen.has(n.msisdn)) duplicate.push(n.msisdn);
    else { seen.add(n.msisdn); valid.push(n.msisdn); }
  });
  return { valid, invalid, duplicate };
}
const chunk = (arr, size = MAX_PER_REQUEST) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

// variables: one object {var1, var2} (BASIC / RICH), or a list with one object per carousel card, in order. Values go as text.
function cleanVariables(v) {
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
  return list.map((o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => /^var\d{1,2}$/.test(k)).map(([k, x]) => [k, String(x == null ? '' : x)])));
}

// ---- the provider's answer -------------------------------------------------------------------------------------------------------
// -> { items: [{msgid, msisdn}], errorCode, errorDesc }. Read flexibly: {data:[{msgid, msisdn}]} is the documented success.
function parseReply(json, text) {
  const pickCode = (o) => {
    if (!o || typeof o !== 'object') return null;
    const c = o.errorcode ?? o.errorCode ?? o.ErrorCode ?? o.error_code ?? o.code ?? o.errcode;
    return c == null || c === '' ? null : String(c).trim();
  };
  const pickDesc = (o) => (o && typeof o === 'object' ? String(o.errordesc ?? o.errorDesc ?? o.ErrorDesc ?? o.error_desc ?? o.message ?? o.msg ?? o.description ?? '') : '');
  if (json && typeof json === 'object') {
    const err = json.Error || json.error || json.errors;
    if (err && typeof err === 'object' && !Array.isArray(err)) return { items: [], errorCode: pickCode(err), errorDesc: pickDesc(err) || null };
    if (typeof err === 'string' && err) return { items: [], errorCode: pickCode(json), errorDesc: err };
    const list = Array.isArray(json.data) ? json.data : (json.data && typeof json.data === 'object' ? [json.data] : (Array.isArray(json) ? json : []));
    const items = list.filter((x) => x && typeof x === 'object' && (x.msgid || x.msgId || x.messageid))
      .map((x) => ({ msgid: String(x.msgid || x.msgId || x.messageid).trim(), msisdn: String(x.msisdn || x.mobile || x.number || '').replace(/\D/g, '') }));
    const code = pickCode(json);
    const status = String(json.status || '').toLowerCase();
    if (!items.length && (code || ['error', 'failed', 'fail', 'false'].includes(status))) return { items: [], errorCode: code, errorDesc: pickDesc(json) || null };
    return { items, errorCode: null, errorDesc: null };
  }
  const t = String(text || '');
  const c = /error\s*_?code\s*["']?\s*[:=]\s*["']?(\d{1,4})/i.exec(t);
  if (c) { const d = /error\s*_?desc\s*["']?\s*[:=]\s*["']?([^,"'<>}]+)/i.exec(t); return { items: [], errorCode: c[1], errorDesc: d ? d[1].trim() : null }; }
  return { items: [], errorCode: null, errorDesc: null };
}

// ---- token mode (spec 1d) ----------------------------------------------------------------------------------------------------------
let TOKEN = null; // { value, at, key } - memory only, never written anywhere
const tokenKey = (cfg) => crypto.createHash('sha256').update(`${cfg.base}|${cfg.user}|${cfg.clientSecret}`).digest('hex');
function readToken(json, text) {
  const pick = (o) => (o && typeof o === 'object' ? (o.access_token || o.accessToken || o.accesstoken || o.token || o.AccessToken || null) : null);
  const t = pick(json) || pick(json && json.data) || (Array.isArray(json && json.data) ? pick(json.data[0]) : null);
  if (t) return String(t).trim();
  const raw = String(text || '').trim();
  return !json && /^[A-Za-z0-9._~+/=-]{16,4096}$/.test(raw) ? raw : null;
}
async function accessToken(cfg, { force = false } = {}) {
  const key = tokenKey(cfg);
  if (!force && TOKEN && TOKEN.key === key && Date.now() - TOKEN.at < TOKEN_TTL_MS) return { ok: true, token: TOKEN.value };
  const res = await core.httpJson(`${cfg.base}${cfg.tokenPath}`, {
    method: cfg.tokenMethod,
    headers: { authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.clientSecret}`).toString('base64')}`, accept: 'application/json' },
  });
  const scrub = scrubber(cfg);
  if (res.networkError) return { ok: false, transient: true, error: `rcssms.in did not answer the token request: ${scrub(res.networkError)}` };
  const token = res.ok ? readToken(res.json, res.text) : null;
  if (!token) {
    const r = parseReply(res.json, res.text);
    return { ok: false, transient: core.isTransientHttp(res.status), errorCode: r.errorCode, error: r.errorCode ? friendly(r.errorCode) : `rcssms.in gave no token (HTTP ${res.status}${res.text ? `: ${scrub(res.text).replace(/\s+/g, ' ').slice(0, 160)}` : ''}). Check RCS_CLIENT_SECRET and RCS_TOKEN_METHOD (GET / POST).` };
  }
  TOKEN = { value: token, at: Date.now(), key };
  return { ok: true, token };
}
const forgetToken = () => { TOKEN = null; };

// One JSON POST to the provider with the login of the chosen mode. Error 30 in token mode = fetch the token again once and repeat.
async function post(cfg, path, fields) {
  const call = async (force) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    const body = { username: cfg.user, ...fields };
    let tok = null;
    if (cfg.mode === 'token') {
      const t = await accessToken(cfg, { force });
      if (!t.ok) return { tokenFailed: t };
      tok = t.token;
      headers.authorization = `Bearer ${tok}`;
    } else body.password = cfg.pass;
    // the provider documents username / password first; keep that order
    const ordered = cfg.mode === 'token' ? body : { username: body.username, password: body.password, ...fields };
    const res = await core.httpJson(`${cfg.base}${path}`, { method: 'POST', headers, body: JSON.stringify(ordered), timeoutMs: 30000 });
    return { res, tok };
  };
  let out = await call(false);
  if (out.tokenFailed) return out;
  if (cfg.mode === 'token' && String(parseReply(out.res.json, out.res.text).errorCode || '') === '30') {
    out = await call(true);
    if (out.tokenFailed) return out;
  }
  return out;
}

// The answer -> { ok, items, errorCode, error, transient, unknown, said }
function readAnswer(cfg, out) {
  if (out.tokenFailed) return { ok: false, items: [], errorCode: out.tokenFailed.errorCode || 'TOKEN', error: out.tokenFailed.error, transient: !!out.tokenFailed.transient };
  const { res, tok } = out;
  const scrub = scrubber(cfg, tok ? [tok] : []);
  const said = `HTTP ${res.status || '-'} ${scrub(res.networkError || (res.json ? JSON.stringify(res.json) : res.text)).replace(/\s+/g, ' ').trim().slice(0, 300)}`.trim();
  if (res.networkError) {
    // only "could not reach it at all" is safe to repeat: a timeout may have reached the provider (a repeat could send twice)
    const reach = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|blocked/i.test(res.networkError);
    return { ok: false, items: [], errorCode: reach ? 'NETWORK' : 'TIMEOUT', transient: reach, unknown: !reach, error: core.tidy(`rcssms.in did not answer (${scrub(res.networkError)}).${reach ? '' : ' It may or may not have taken the message, so it is not sent again automatically.'}`), said };
  }
  const r = parseReply(res.json, res.text);
  if (r.errorCode || r.errorDesc) {
    return { ok: false, items: [], errorCode: r.errorCode || 'ERROR', transient: core.isTransientHttp(res.status), error: core.tidy(friendly(r.errorCode, r.errorDesc ? `rcssms.in refused it: ${scrub(r.errorDesc)}` : null)), said };
  }
  if (!res.ok) return { ok: false, items: [], errorCode: `HTTP${res.status}`, transient: core.isTransientHttp(res.status), error: core.tidy(`rcssms.in answered HTTP ${res.status}.`), said };
  if (!r.items.length) return { ok: false, items: [], errorCode: 'UNKNOWN', unknown: true, transient: false, error: core.tidy(`rcssms.in answered, but without a message id, so it is NOT counted as sent. Answer: ${said}`), said };
  return { ok: true, items: r.items, said };
}

const hostOf = (cfg) => { try { return new URL(cfg.base).host; } catch { return ''; } };

// PROOF (founder 2026-10-30: "do not enable bulk sending until the single-message test succeeds"): set ONLY by the Admin's single test
// send when the provider answered with a msgid, and only for the address it was sent to. A test stub's address never proves the real one.
const PROOF_KEY = 'rcs.proven';
async function proof() {
  const prisma = require('../db'); // eslint-disable-line global-require
  const row = await prisma.appSetting.findUnique({ where: { key: PROOF_KEY } }).catch(() => null);
  let p = null; try { p = row ? JSON.parse(row.value) : null; } catch { p = null; }
  return p && p.host === hostOf(config()) ? p : null;
}
async function markProven(ref, host) {
  const prisma = require('../db'); // eslint-disable-line global-require
  const v = JSON.stringify({ at: new Date().toISOString(), ref, host });
  await prisma.appSetting.upsert({ where: { key: PROOF_KEY }, create: { key: PROOF_KEY, value: v }, update: { value: v } });
}

async function markAccepted(ref) {
  const prisma = require('../db'); // eslint-disable-line global-require
  const v = JSON.stringify({ at: new Date().toISOString(), ref });
  await prisma.appSetting.upsert({ where: { key: 'rcs.accepted' }, create: { key: 'rcs.accepted', value: v }, update: { value: v } }).catch(() => {});
}

const SANDBOX_REFUSAL = { ok: false, items: [], errorCode: 'SANDBOX', transient: false, error: 'Not sent: this is the TEST SANDBOX, which never reaches rcssms.in.' };
const NO_APITYPE = (which) => ({ ok: false, notConfigured: true, items: [], errorCode: 'APITYPE', transient: false, error: `Not sent: ${which} is not set. The send document says apitype=2 and the brief says apitype=1; rcssms.in must confirm which, then it is set in backend/.env.` });

// ONE request of at most 500 numbers, same words for all (used by the queue, which controls the wait between chunks and the retries).
async function sendChunk({ rcstype, templateid, numbers, variables, buttonUrl, imageUrl }) {
  const cfg = config();
  if (!cfg.configured) return { ok: false, notConfigured: true, items: [], errorCode: 'CONFIG', error: cfg.reason };
  if (!TYPES.includes(rcstype)) return { ok: false, items: [], errorCode: 'TYPE', error: 'The RCS type must be BASIC, RICH or RICHCASOUREL.' };
  if (!templateid) return { ok: false, items: [], errorCode: '18', error: friendly(18) };
  if (!numbers.length || numbers.length > MAX_PER_REQUEST) return { ok: false, items: [], errorCode: '24', error: friendly(24) };
  if (isSandbox() && !cfg.local) return SANDBOX_REFUSAL;
  if (!cfg.sendApiType) return NO_APITYPE('RCS_SEND_APITYPE');
  const fields = { rcstype, rcsid: cfg.rcsId, msisdn: numbers.join(','), variables: cleanVariables(variables), templateid: String(templateid) };
  if (buttonUrl) fields.button = [{ url: String(buttonUrl) }];
  if (imageUrl) fields.cardMedia = [{ fileUrl: String(imageUrl) }];
  const ans = readAnswer(cfg, await post(cfg, `/rcsapi/jsonapi.jsp?apitype=${cfg.sendApiType}`, fields));
  if (ans.ok) await markAccepted(ans.items[0].msgid);
  return { ...ans, host: hostOf(cfg) };
}

// ONE personalized request of at most 500 messages: [{msisdn, templateid, variables, buttonUrl}]
async function sendPersonalizedChunk(messages) {
  const cfg = config();
  if (!cfg.configured) return { ok: false, notConfigured: true, items: [], errorCode: 'CONFIG', error: cfg.reason };
  if (!messages.length || messages.length > MAX_PER_REQUEST) return { ok: false, items: [], errorCode: '24', error: friendly(24) };
  if (isSandbox() && !cfg.local) return SANDBOX_REFUSAL;
  if (!cfg.personalApiType) return NO_APITYPE('RCS_PERSONAL_APITYPE');
  const list = messages.map((m) => ({
    msisdn: m.msisdn, templateid: String(m.templateid), variables: cleanVariables(m.variables), ...(m.buttonUrl ? { button: [{ url: String(m.buttonUrl) }] } : {}),
  }));
  const ans = readAnswer(cfg, await post(cfg, `/rcsapimtpl/jsonapi.jsp?apitype=${cfg.personalApiType}`, { rcsid: cfg.rcsId, messages: list }));
  if (ans.ok) await markAccepted(ans.items[0].msgid);
  return { ...ans, host: hostOf(cfg) };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const chunkDelay = () => Math.max(0, Number(process.env.RCS_CHUNK_DELAY_MS) || 1500);

// sendRcs({rcstype, templateid, numbers[], variables}) - the whole list at once, in requests of 500 with a short wait between them.
// -> { ok, accepted: [{msisdn, msgid}], failed: [{msisdn, errorCode, error}], invalid, duplicate, chunks }
async function sendRcs({ rcstype, templateid, numbers, variables, buttonUrl, imageUrl }) {
  const n = cleanNumbers(numbers);
  const out = { ok: false, accepted: [], failed: [], invalid: n.invalid, duplicate: n.duplicate, chunks: 0 };
  const parts = chunk(n.valid);
  for (let i = 0; i < parts.length; i += 1) {
    if (i) await wait(chunkDelay()); // eslint-disable-line no-await-in-loop
    const r = await sendChunk({ rcstype, templateid, numbers: parts[i], variables, buttonUrl, imageUrl }); // eslint-disable-line no-await-in-loop
    out.chunks += 1;
    mergeChunk(out, parts[i], r);
    if (!r.ok && String(r.errorCode) === '23') break; // no credit: stop
  }
  out.ok = out.accepted.length > 0;
  return out;
}

async function sendRcsPersonalized(messages) {
  const seen = new Set(); const good = []; const invalid = []; const duplicate = [];
  (messages || []).forEach((m) => {
    const n = normalizeNumber(m && m.msisdn);
    if (!n.ok) invalid.push({ raw: String((m && m.msisdn) || ''), reason: n.reason });
    else if (seen.has(n.msisdn)) duplicate.push(n.msisdn);
    else { seen.add(n.msisdn); good.push({ ...m, msisdn: n.msisdn }); }
  });
  const out = { ok: false, accepted: [], failed: [], invalid, duplicate, chunks: 0 };
  const parts = chunk(good);
  for (let i = 0; i < parts.length; i += 1) {
    if (i) await wait(chunkDelay()); // eslint-disable-line no-await-in-loop
    const r = await sendPersonalizedChunk(parts[i]); // eslint-disable-line no-await-in-loop
    out.chunks += 1;
    mergeChunk(out, parts[i].map((m) => m.msisdn), r);
    if (!r.ok && String(r.errorCode) === '23') break;
  }
  out.ok = out.accepted.length > 0;
  return out;
}

// Which numbers of one request got a msgid. A number the answer does not name is not sent.
function idsByNumber(numbers, items) {
  const map = new Map();
  items.forEach((it) => { if (it.msisdn) map.set(it.msisdn.length === 10 ? `91${it.msisdn}` : it.msisdn, it.msgid); });
  // one number in the request and one id without a number in the answer: that id is that number's
  if (numbers.length === 1 && !map.size && items.length === 1) map.set(numbers[0], items[0].msgid);
  return map;
}
function mergeChunk(out, numbers, r) {
  if (!r.ok) { numbers.forEach((msisdn) => out.failed.push({ msisdn, errorCode: r.errorCode, error: r.error })); return; }
  const ids = idsByNumber(numbers, r.items);
  numbers.forEach((msisdn) => {
    if (ids.has(msisdn)) out.accepted.push({ msisdn, msgid: ids.get(msisdn) });
    else out.failed.push({ msisdn, errorCode: 'NO_ID', error: 'rcssms.in did not confirm this number, so it is not counted as sent.' });
  });
}

// ---- templates (spec 1c) -------------------------------------------------------------------------------------------------------------
const HEIGHTS = ['Low', 'Medium', 'High'];
const ORIENT = ['Vertical', 'Horizontal'];
const ACTIONS = ['plain_dial', 'plain_open_url', 'plain_create_calendar', 'plain_view_location'];
const httpsUrl = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

// The request fields for a new template, checked. -> { fields } | { error }
function templateFields(type, p) {
  const t = String(type || '').toUpperCase();
  if (!['BASIC', 'RICH'].includes(t)) return { error: 'A new template is BASIC or RICH. A carousel is made on rcssms.in and added here by its template id.' };
  const cname = String(p.cname || p.name || '').trim();
  const description = String(p.description || '').trim();
  if (!cname) return { error: 'Give the template a name.' };
  if (!/^[A-Za-z0-9 _-]{2,60}$/.test(cname)) return { error: 'The template name may have letters, digits, spaces, - and _ (2 to 60).' };
  if (!description) return { error: 'Write the message text (description).' };
  if (description.length > 2500) return { error: 'The message text is too long (2500 characters at most).' };
  const fields = { cname, description };
  if (t === 'RICH') {
    const mediaUrl = String(p.media_url || p.mediaUrl || '').trim();
    if (!httpsUrl(mediaUrl)) return { error: 'A rich card needs an image / video link that starts with https://' };
    const mediaheight = HEIGHTS.find((h) => h.toLowerCase() === String(p.mediaheight || 'Medium').toLowerCase());
    const cardorientation = ORIENT.find((h) => h.toLowerCase() === String(p.cardorientation || 'Vertical').toLowerCase());
    if (!mediaheight) return { error: 'Image height is Low, Medium or High.' };
    if (!cardorientation) return { error: 'Card layout is Vertical or Horizontal.' };
    const title = String(p.title || '').trim();
    if (!title) return { error: 'A rich card needs a title.' };
    if (title.length > 200) return { error: 'The title is too long (200 characters at most).' };
    const reply = (Array.isArray(p.reply) ? p.reply : []).map((r) => ({ text: String((r && r.text) || '').trim() })).filter((r) => r.text);
    if (reply.some((r) => r.text.length > 25)) return { error: 'A quick reply is 25 characters at most.' };
    const action = [];
    for (const a of (Array.isArray(p.action) ? p.action : [])) {
      const type = String((a && a.type) || '').trim();
      if (!type) continue; // eslint-disable-line no-continue
      if (!ACTIONS.includes(type)) return { error: `Unknown button kind "${type}".` };
      const text = String(a.text || '').trim();
      if (!text) return { error: 'Every button needs its words.' };
      const one = { type, text };
      if (type === 'plain_dial') { const ph = String(a.phone || '').replace(/[^\d+]/g, ''); if (!/^\+?\d{10,13}$/.test(ph)) return { error: 'The call button needs a phone number.' }; one.phone = ph; }
      if (type === 'plain_open_url') { if (!httpsUrl(a.url)) return { error: 'The link button needs an https:// address.' }; one.url = String(a.url).trim(); }
      if (type === 'plain_create_calendar') {
        ['title', 'description', 'startTime', 'endTime'].forEach((k) => { if (a[k]) one[k] = String(a[k]).trim(); });
        if (!one.startTime || !one.endTime) return { error: 'The calendar button needs a start and an end time.' };
      }
      if (type === 'plain_view_location') {
        const lat = Number(a.latitude); const lng = Number(a.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: 'The location button needs a latitude and a longitude.' };
        one.latitude = String(lat); one.longitude = String(lng); if (a.label) one.label = String(a.label).trim();
      }
      action.push(one);
    }
    if (reply.length + action.length > 4) return { error: 'At most 4 quick replies and buttons together.' };
    Object.assign(fields, { media_url: mediaUrl, mediaheight, cardorientation, title, reply, action });
  }
  return { type: t, fields };
}

// createTemplate(type, payload) -> { ok, templateid, status } | { ok:false, error }
async function createTemplate(type, payload) {
  const f = templateFields(type, payload || {});
  if (f.error) return { ok: false, invalid: true, error: f.error };
  const cfg = config();
  if (!cfg.configured) return { ok: false, notConfigured: true, error: cfg.reason };
  if (isSandbox() && !cfg.local) return { ok: false, error: SANDBOX_REFUSAL.error };
  const out = await post(cfg, '/rcsapi/rcscreatetemplate.jsp', { rcstype: f.type, rcsid: cfg.rcsId, ...f.fields });
  if (out.tokenFailed) return { ok: false, error: out.tokenFailed.error, errorCode: out.tokenFailed.errorCode || null };
  const { res } = out;
  const scrub = scrubber(cfg);
  if (res.networkError) return { ok: false, error: `rcssms.in did not answer (${scrub(res.networkError)}). Check on rcssms.in whether the template was made before trying again.` };
  const j = res.json && typeof res.json === 'object' ? res.json : null;
  const d = j && (Array.isArray(j.data) ? j.data[0] : (j.data && typeof j.data === 'object' ? j.data : j));
  const templateid = d && (d.templateid || d.templateId || d.template_id) ? String(d.templateid || d.templateId || d.template_id).trim() : null;
  if (!templateid) {
    const r = parseReply(res.json, res.text);
    return { ok: false, errorCode: r.errorCode || null, error: r.errorCode ? friendly(r.errorCode) : `rcssms.in did not give a template id (HTTP ${res.status}: ${scrub(res.json ? JSON.stringify(res.json) : res.text).replace(/\s+/g, ' ').slice(0, 200)}).` };
  }
  const st = String((d && d.status) || (j && j.status) || 'PENDING').toUpperCase();
  return { ok: true, templateid, status: ['APPROVED', 'REJECTED'].includes(st) ? st : 'PENDING', fields: f.fields };
}

module.exports = {
  TYPES, MAX_PER_REQUEST, ERRORS, friendly, config, publicConfig, normalizeNumber, cleanNumbers, cleanVariables, parseReply,
  sendChunk, sendPersonalizedChunk, proof, markProven, hostOf, PROOF_KEY, sendRcs, sendRcsPersonalized, createTemplate, templateFields, accessToken, forgetToken, idsByNumber, chunk,
};
