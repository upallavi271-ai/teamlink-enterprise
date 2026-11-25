// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > GOOGLE SIGN-IN (2026-11-25). How TeamLink talks to Google Search Console and Google Analytics 4 for a client: with a Google Cloud SERVICE ACCOUNT, not a login of a person.
//   * the owner pastes the service account's JSON key ONCE in Administration > Integrations > "Search Console and Analytics (Google)". It is stored encrypted (utils/integrationStore.js, like every key) and
//     is never shown again, never sent to a browser, never written to a log or an error message;
//   * a client adds the service account's EMAIL as a user of its Search Console property (Restricted is enough) and of its GA4 property (Viewer), the same as adding TeamLink as a manager: no consent screen,
//     no token that expires after 7 days, no login per client;
//   * TeamLink signs a short statement with the key (a JWT, RS256, with Node's own crypto: no library), swaps it at Google's token address for an access token that lasts an hour, keeps it in memory for
//     that hour, and asks for READ-ONLY access (Search Console read-only, Analytics read-only). Nothing is ever changed in a client's Google account.
// HONEST BY DESIGN: the token address is fixed to Google's (a key file cannot point it elsewhere); in the test sandbox Google is never called unless a test supplies a stand-in; every failure is said in words.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const LABEL = 'Service account credentials (JSON key)';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];
const KEY_HELP = 'In Google Cloud Console > IAM & Admin > Service accounts, make a service account, open it > Keys > Add key > Create new key > JSON, and paste the whole file in Administration > Integrations.';
const tokens = new Map(); // email + key fingerprint + scopes -> { token, exp }
const b64u = (x) => Buffer.from(x).toString('base64url');

// the service account key as an object, from the saved card (or opts.key, a test's own). -> { key } | { error }
function parseKey(text) {
  let j; try { j = JSON.parse(String(text || '').trim()); } catch { return { error: `The saved key is not a JSON file. ${KEY_HELP}` }; }
  if (!j || j.type !== 'service_account' || !/^[^@\s]+@[^@\s]+$/.test(String(j.client_email || '')) || !/BEGIN (RSA )?PRIVATE KEY/.test(String(j.private_key || ''))) return { error: `The saved key is not a Google service account key (it needs "type": "service_account", a client_email and a private_key). ${KEY_HELP}` };
  return { key: { client_email: String(j.client_email), private_key: String(j.private_key), project_id: String(j.project_id || '') } };
}
async function keyOf(opts = {}) {
  if (opts.key) return parseKey(typeof opts.key === 'string' ? opts.key : JSON.stringify(opts.key));
  let text = ''; try { const c = await require('../utils/integrationStore').readConfig('google-seo'); text = String((c.values || {})[LABEL] || '').trim(); if (c.missingKey) return { error: 'The saved Google key cannot be read because the server has no encryption key. Ask the developer.' }; } catch { /* no card yet */ } // eslint-disable-line global-require
  if (!text) return { error: `No Google key is saved yet. ${KEY_HELP}`, notSet: true };
  return parseKey(text);
}
// is a key saved, and which email do clients add? (never the key itself)
async function status(opts = {}) {
  const k = await keyOf(opts);
  if (k.error) return { configured: false, email: null, problem: k.notSet ? '' : k.error, project: '' };
  return { configured: true, email: k.key.client_email, problem: '', project: k.key.project_id };
}
const fetchOf = (opts) => { if (opts.fetchFn) return opts.fetchFn; if (require('../utils/sandbox').isSandbox()) return null; return fetch; }; // eslint-disable-line global-require
const SANDBOX_WORDS = 'Google is not called in the test sandbox.';

// an access token for read-only Search Console and Analytics: { token, email } | { error, status, code }
async function accessToken(opts = {}) {
  const k = await keyOf(opts); if (k.error) return { error: k.error, status: 400, code: 'nokey' };
  const fp = crypto.createHash('sha256').update(k.key.private_key).digest('hex').slice(0, 12); const ck = `${k.key.client_email}|${fp}|${SCOPES.join(' ')}`; const nowMs = opts.now || Date.now();
  const hit = tokens.get(ck); if (hit && hit.exp > nowMs + 300000) return { token: hit.token, email: k.key.client_email };
  const fetchFn = fetchOf(opts); if (!fetchFn) return { error: SANDBOX_WORDS, status: 503, code: 'sandbox' };
  const iat = Math.floor(nowMs / 1000); let assertion;
  try {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })); const claims = b64u(JSON.stringify({ iss: k.key.client_email, scope: SCOPES.join(' '), aud: TOKEN_URL, iat, exp: iat + 3600 }));
    assertion = `${head}.${claims}.${crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(k.key.private_key).toString('base64url')}`;
  } catch { return { error: 'The private key in the saved file could not be used to sign in. Make a new JSON key for the service account and paste it again.', status: 400, code: 'badkey' }; }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.ms || 20000); let res;
  try { res = await fetchFn(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), signal: ctl.signal }); }
  catch (e) { return { error: e.name === 'AbortError' ? 'Google did not answer in time. Try again.' : 'Google could not be reached right now.', status: 502, code: 'net' }; } finally { clearTimeout(timer); }
  let j = null; try { j = await res.json(); } catch { /* not JSON */ }
  if (res.status >= 400 || !j || !j.access_token) {
    const why = j && (j.error || '');
    if (why === 'invalid_grant') return { error: 'Google refused the key: it may have been deleted or disabled in Google Cloud, or this computer\'s clock is wrong. Make a new JSON key and paste it again.', status: 502, code: 'invalid_grant' };
    if (res.status >= 500) return { error: 'Google had a problem signing in. Try again in a few minutes.', status: 502, code: 'google' };
    return { error: `Google refused the sign-in (${res.status}${why ? `: ${String(why).slice(0, 60)}` : ''}). Check the key in Administration > Integrations.`, status: 502, code: 'auth' };
  }
  tokens.set(ck, { token: String(j.access_token), exp: nowMs + (Number(j.expires_in) || 3600) * 1000 });
  return { token: String(j.access_token), email: k.key.client_email };
}
const forget = () => tokens.clear();

module.exports = { LABEL, TOKEN_URL, SCOPES, KEY_HELP, parseKey, keyOf, status, accessToken, forget, fetchOf, SANDBOX_WORDS };
