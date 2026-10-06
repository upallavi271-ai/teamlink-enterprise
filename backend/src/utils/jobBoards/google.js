// ---------------------------------------------------------------------------
// GOOGLE FOR JOBS — our JobPosting structured data + the Indexing API.
//   Structured data  https://developers.google.com/search/docs/appearance/structured-data/job-posting
//                    (served by routes/public.js: /api/public/jobs/:id/jsonld,
//                    /api/public/jobs.jsonld, and embedded on /careers/:id)
//   Indexing API     https://developers.google.com/search/apis/indexing-api/v3/using-api
//                    https://developers.google.com/search/apis/indexing-api/v3/prereqs
//                    POST https://indexing.googleapis.com/v3/urlNotifications:publish
//                    { url, type: "URL_UPDATED" | "URL_DELETED" }   (200 / day / project)
//   Confirmation     https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
//                    POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect
//                    { inspectionUrl, siteUrl } -> inspectionResult.indexStatusResult.verdict
//                    PASS + richResultsResult.detectedItems[].richResultType (job posting)
//   Auth             a Google Cloud service account (JSON key), Indexing API
//                    enabled, the service account added as an OWNER of the
//                    site in Search Console. JWT bearer grant:
//                    https://developers.google.com/identity/protocols/oauth2/service-account
//                    POST https://oauth2.googleapis.com/token
//
// Google is a board that PULLS from us, so the status is honest:
//   "Submitted to feed"  the job is live in OUR JobPosting data (checked at its
//                        URL) and, with the service account set up, Google was
//                        notified — but Google has not confirmed it yet;
//   "Posted"             only when Search Console's URL Inspection says the
//                        page is indexed (PASS) with a job posting detected.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const http = require('./http');
const { boardSettings } = require('./common');

const LABEL = 'Google Jobs';
const F = { key: 'Service account private key (JSON)', site: 'Search Console property URL' };
const FIELDS = [[F.key, 'paste the whole JSON key file of the service account'], [F.site, 'https://www.tmlink.in/ (exactly as in Search Console)']];
const NEED = [F.key, F.site];
const SETUP = 'Google reads the job from our site by itself. To tell Google at once and confirm it is shown: create a Google Cloud service account, enable the Indexing API, add the service account as an Owner of the site in Search Console, then paste its JSON key and the Search Console property URL in Administration → Integrations → Google for Jobs.';
const SCOPES = 'https://www.googleapis.com/auth/indexing https://www.googleapis.com/auth/webmasters.readonly';

async function config() {
  const s = await boardSettings('google-jobs', NEED, LABEL);
  if (!s.ready) return { ...s, hint: s.hint || SETUP };
  let sa = null;
  try { sa = JSON.parse(String(s.values[F.key])); } catch { sa = null; }
  if (!sa || !sa.client_email || !sa.private_key) {
    return { ready: false, values: s.values, hint: 'The Google service account key is not a valid JSON key file (it needs client_email and private_key). Paste it again in Administration → Integrations → Google for Jobs.' };
  }
  return { ...s, sa };
}

const b64u = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function token(cfg) {
  const key = `google|${cfg.sa.client_email}`;
  const have = http.cachedToken(key);
  if (have) return { ok: true, token: have };
  const now = Math.floor(Date.now() / 1000);
  const aud = cfg.sa.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: cfg.sa.client_email, scope: SCOPES, aud, iat: now, exp: now + 3600 }));
  let sig;
  try { sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), cfg.sa.private_key); } catch {
    return { ok: false, error: 'The Google service account private key could not be used. Paste the JSON key again.' };
  }
  const assertion = `${head}.${claims}.${b64u(sig)}`;
  const res = await http.call(LABEL, aud, {
    method: 'POST', form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }, secrets: [assertion],
  });
  if (!res.ok) return { ok: false, error: res.code ? res.error : `Could not sign in to Google. ${res.error}` };
  if (!res.body || !res.body.access_token) return { ok: false, error: 'Google did not return an access token.' };
  http.rememberToken(key, res.body.access_token, res.body.expires_in);
  return { ok: true, token: res.body.access_token };
}

// The page Google indexes: our public job page.
const pageUrl = (r) => http.publicUrl(require('../jobSlug').careersPath(r)); // eslint-disable-line global-require

async function notify(r, cfg, type) {
  const url = pageUrl(r);
  if (!url || http.isLocalUrl(url)) return { ok: false, error: 'Google can only be told about jobs on the live website, not on this local copy.' };
  const t = await token(cfg);
  if (!t.ok) return t;
  const res = await http.call(LABEL, 'https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method: 'POST', headers: { authorization: `Bearer ${t.token}` }, json: { url, type }, secrets: [t.token],
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

async function inspect(r, cfg) {
  const url = pageUrl(r);
  if (!url || http.isLocalUrl(url)) return { ok: false, error: 'not a public address' };
  const t = await token(cfg);
  if (!t.ok) return t;
  const res = await http.call(LABEL, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST', headers: { authorization: `Bearer ${t.token}` }, json: { inspectionUrl: url, siteUrl: String(cfg.values[F.site]).trim() }, secrets: [t.token],
  });
  if (!res.ok) return { ok: false, error: res.error };
  const ir = (res.body && res.body.inspectionResult) || {};
  const indexed = ir.indexStatusResult && ir.indexStatusResult.verdict === 'PASS';
  const items = (ir.richResultsResult && ir.richResultsResult.detectedItems) || [];
  const job = items.some((i) => /job/i.test(String(i.richResultType || '')));
  return { ok: true, live: !!(indexed && job), url, coverage: ir.indexStatusResult ? ir.indexStatusResult.coverageState : null };
}

module.exports = {
  id: 'google', label: LABEL, integrationId: 'google-jobs', FIELDS, SETUP, config, notify, inspect, pageUrl,
};
