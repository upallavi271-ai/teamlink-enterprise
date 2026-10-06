// ---------------------------------------------------------------------------
// Shared outbound call for the job-board connectors (utils/jobBoards/*.js).
// One timeout, one JSON / form encoder, and ONE rule: no credential ever ends
// up in an error message, a log line or a stored row — every secret the
// caller passes in `secrets` is masked out of whatever comes back.
// In the test sandbox (utils/sandbox.js) fetch to any outside host is
// refused; that refusal arrives here as a normal network failure.
// ---------------------------------------------------------------------------
// JOB_BOARD_TIMEOUT_MS only lets a test process shorten the wait.
const TIMEOUT_MS = Number(process.env.JOB_BOARD_TIMEOUT_MS) > 0 ? Number(process.env.JOB_BOARD_TIMEOUT_MS) : 15000;

const plain = (s, max = 300) => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function scrub(text, secrets = []) {
  let t = String(text == null ? '' : text);
  secrets.filter((k) => k && String(k).length >= 4).forEach((k) => { t = t.split(String(k)).join('***'); });
  return t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

function networkWords(label, err, secrets) {
  const cause = err && err.cause ? `${err.cause.code || ''} ${err.cause.message || ''}` : '';
  const raw = scrub(`${err && err.message ? err.message : err} ${cause}`, secrets);
  if (/SANDBOX|ESANDBOX/i.test(raw)) return `${label} could not be reached (this test copy blocks every outside call).`;
  if (/abort/i.test(raw)) return `${label} did not answer in ${TIMEOUT_MS / 1000} seconds.`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `${label}'s address was not found. Check the URL in Administration → Integrations.`;
  if (/ECONNREFUSED|ECONNRESET|fetch failed|socket|network/i.test(raw)) return `${label} could not be reached. Check the internet connection.`;
  return `${label}: ${plain(raw, 200)}`;
}

// HUMAN WORDS FOR A BOARD'S ANSWER (spec §22). The person sees this; the
// technical answer (scrubbed of every secret) goes to the server log and the
// board's "Last error details" in Administration → Integrations only.
const FIELD_WORDS = [
  [/salary|compensation|pay|ctc/i, 'Salary range is missing or not valid'],
  [/location|city|country|address/i, 'the job location is missing or not valid'],
  [/description/i, 'the job description is missing or too short'],
  [/title/i, 'the job title is missing or not valid'],
  [/e-?mail|contact/i, 'the contact email is missing or not valid'],
  [/experience/i, 'the experience range is missing or not valid'],
  [/apply ?url|url|link/i, 'the apply link is not a public web address'],
  [/company|organi[sz]ation|employer/i, 'the company / employer id is not valid'],
];
function boardSaid(parsed, text) {
  const b = parsed && typeof parsed === 'object' ? parsed : null;
  const msgs = [];
  const take = (v) => { if (v == null) return; if (typeof v === 'string') msgs.push(v); else if (Array.isArray(v)) v.forEach(take); else if (typeof v === 'object') take(v.message || v.error || v.detail || v.field); };
  if (b) { take(b.error_description); take(b.message); take(b.error); take(b.errors); take(b.detail); take(b.details); }
  if (!msgs.length && text) msgs.push(String(text).slice(0, 200));
  return msgs.join('; ');
}
function humanize(label, status, parsed, text, secrets) {
  const said = plain(scrub(boardSaid(parsed, text), secrets), 160);
  if (status === 401 || status === 403) return `${label} connection expired or was refused. Please reconnect the ${label} integration.`;
  if (status === 400 || status === 422) {
    const hit = FIELD_WORDS.find(([re]) => re.test(said));
    if (hit) return `${label} rejected the job because ${hit[1]}.`;
    return `${label} rejected the job${said ? `: ${said}` : '.'}`;
  }
  if (status === 404) return `${label} could not find this job or address (it may have been removed there already).`;
  if (status === 409) return `${label} says this job is already there.`;
  if (status === 429) return `${label} is busy right now (too many requests). Press Retry in a few minutes.`;
  if (status >= 500) return `${label} had a problem on its side (error ${status}). Press Retry later.`;
  return `${label} did not accept the job (error ${status}).`;
}

// The last technical detail per board (for the Integrations card).
const lastDetails = new Map();
function noteDetail(label, detail) {
  lastDetails.set(label, { detail, at: new Date() });
  console.warn(`[job-boards] ${detail}`);
}
const lastDetail = (label) => lastDetails.get(label) || null;

// -> { ok, code, body, text, error, detail }  (never throws)
async function call(label, url, { method = 'GET', headers = {}, json, form, secrets = [] } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const h = { accept: 'application/json', ...headers };
    let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(url, { method, headers: h, body, signal: ctl.signal });
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!res.ok) {
      const detail = `HTTP ${res.status} ${method} ${new URL(url).host}: ${plain(scrub(text, secrets), 400)}`;
      noteDetail(label, detail);
      return { ok: false, code: res.status, body: parsed, error: humanize(label, res.status, parsed, text, secrets), detail };
    }
    return { ok: true, code: res.status, body: parsed, text };
  } catch (err) {
    const cause = err && err.cause ? ` (${err.cause.code || ''} ${err.cause.message || ''})` : '';
    const detail = `${method} ${(() => { try { return new URL(url).host; } catch { return '?'; } })()}: ${scrub(`${err && err.message}${cause}`, secrets)}`;
    noteDetail(label, detail);
    return { ok: false, error: networkWords(label, err, secrets), detail };
  } finally { clearTimeout(t); }
}

// A public absolute URL for a path on this site, or null when the site has no
// public address yet (boards and Google must be able to open the link).
function publicUrl(path) {
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}${path}`;
}
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(String(u || ''));

// Small in-memory token cache (per process), keyed per integration.
const tokens = new Map();
function cachedToken(key) {
  const t = tokens.get(key);
  return t && t.exp > Date.now() + 60000 ? t.token : null;
}
function rememberToken(key, token, expiresInSec) {
  tokens.set(key, { token, exp: Date.now() + Math.max(60, Number(expiresInSec) || 3600) * 1000 });
}
function forgetToken(key) { tokens.delete(key); }

module.exports = {
  call, scrub, plain, humanize, lastDetail, publicUrl, isLocalUrl, cachedToken, rememberToken, forgetToken, TIMEOUT_MS,
};
