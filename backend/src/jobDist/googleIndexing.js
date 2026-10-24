// ---------------------------------------------------------------------------
// GOOGLE INDEXING API (OPTIONAL, OFF BY DEFAULT).
//
// Google for Jobs normally finds a job by itself: the job page carries JobPosting markup and the site map lists it. The
// Google Indexing API can tell Google about a changed page sooner, BUT Google limits it to certain content (job posting and
// live-stream pages) and needs a Google Cloud SERVICE ACCOUNT that is added as an owner of the site in Search Console. The
// company must set that up itself. Until an Admin switches it ON and saves the service account key, NOTHING here calls Google.
//
//   status()                      { enabled, configured, email, switchedBy }  (never the key)
//   saveKey(json, user)           encrypts the service account JSON (utils/secrets.js, AES-256-GCM)
//   setEnabled(on, user)          the Admin switch (default OFF; refused until a key is saved)
//   notify(url, type)             URL_UPDATED | URL_DELETED. Refused unless ON and configured.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const https = require('https');
const prisma = require('../db');
const { encryptSecret, decryptSecret, secretsConfigured, NO_KEY_MESSAGE } = require('../utils/secrets');
const { logAudit } = require('../utils/audit');

const KEY = 'jobdist.googleIndexing';
const KEY_ENC = 'jobdist.googleIndexing.key';
const SCOPE = 'https://www.googleapis.com/auth/indexing';

async function raw(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  return row ? row.value : null;
}
async function put(key, value, user) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
}
async function status() {
  let on = false; let by = null;
  try { const v = JSON.parse((await raw(KEY)) || '{}'); on = !!v.on; by = v.by || null; } catch { on = false; }
  const enc = await raw(KEY_ENC);
  let email = null;
  if (enc) {
    const plain = decryptSecret(enc);
    try { email = plain ? JSON.parse(plain).client_email || null : null; } catch { email = null; }
  }
  return {
    enabled: on && !!enc, switchedOn: on, configured: !!enc, email, switchedBy: by, secretsConfigured: secretsConfigured(),
    note: 'Google limits the Indexing API to certain content (job postings). You must create a Google Cloud service account, add it as an owner of the site in Google Search Console, and paste its key here. Without that, leave this OFF: Google still finds your requirements through the requirement page and the site map.',
  };
}
async function saveKey(json, user) {
  let obj;
  try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch { return { error: 'That is not a valid service account key file (it must be the JSON file from Google Cloud).', status: 400 }; }
  if (!obj || obj.type !== 'service_account' || !obj.client_email || !/BEGIN [A-Z ]*PRIVATE KEY/.test(String(obj.private_key || ''))) return { error: 'This does not look like a Google service account key (it needs "type": "service_account", a client_email and a private_key).', status: 400 };
  let enc;
  try { enc = encryptSecret(JSON.stringify({ client_email: obj.client_email, private_key: obj.private_key, token_uri: obj.token_uri || 'https://oauth2.googleapis.com/token' })); } catch (e) {
    if (e && e.code === 'NO_SECRET_KEY') return { error: NO_KEY_MESSAGE, status: 400 };
    throw e;
  }
  await put(KEY_ENC, enc, user);
  await put(KEY, JSON.stringify({ on: false, by: user ? user.name : null, at: new Date().toISOString() }), user); // a new key starts switched OFF
  await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: 'Google Indexing key saved', entity: 'JobDistribution', entityId: 'google', toValue: `service account ${obj.client_email} (key not shown)` });
  return { status: await status() };
}
async function setEnabled(on, user) {
  const s = await status();
  if (on && !s.configured) return { error: 'Save the Google service account key first.', status: 400 };
  await put(KEY, JSON.stringify({ on: !!on, by: user ? user.name : null, at: new Date().toISOString() }), user);
  await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: `Google Indexing API ${on ? 'ON' : 'OFF'}`, entity: 'JobDistribution', entityId: 'google', toValue: '' });
  return { status: await status() };
}
async function removeKey(user) {
  await prisma.appSetting.deleteMany({ where: { key: { in: [KEY, KEY_ENC] } } });
  await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: 'Google Indexing key removed', entity: 'JobDistribution', entityId: 'google', toValue: '' });
  return { status: await status() };
}

const b64 = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// Tell Google about one URL. Only when an Admin switched it ON AND saved a service account key.
async function notify(url, type = 'URL_UPDATED') {
  const s = await status();
  if (!s.enabled) return { ok: false, refused: true, error: s.configured ? 'The Google Indexing API is switched OFF.' : 'No Google service account key is saved, so Google was not contacted.' };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'The requirement has no public address yet (APP_BASE_URL is not set).' };
  const plain = decryptSecret(await raw(KEY_ENC));
  if (!plain) return { ok: false, error: NO_KEY_MESSAGE };
  const k = JSON.parse(plain);
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({ iss: k.client_email, scope: SCOPE, aud: k.token_uri, exp: now + 3000, iat: now }));
  const sig = b64(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(k.private_key));
  try {
    const tok = await post(k.token_uri, { 'Content-Type': 'application/x-www-form-urlencoded' }, `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}`);
    if (!tok.json || !tok.json.access_token) return { ok: false, error: 'Google did not accept the service account key.' };
    const res = await post('https://indexing.googleapis.com/v3/urlNotifications:publish', { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.json.access_token}` }, JSON.stringify({ url, type }));
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const msg = res.json && res.json.error && res.json.error.message ? String(res.json.error.message).slice(0, 200) : `Google answered ${res.status}`;
    return { ok: false, error: `Google refused: ${msg}. The Indexing API is limited to certain content and the service account must be an owner of the site in Search Console.` };
  } catch { return { ok: false, error: 'Google could not be reached.' }; }
}

module.exports = {
  status, saveKey, setEnabled, removeKey, notify,
};
