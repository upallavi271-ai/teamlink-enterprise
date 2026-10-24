// ---------------------------------------------------------------------------
// OMNI-CHANNEL EXTERNAL-SERVICE SHELLS (2026-10-17): Shopify, Facebook / Instagram (Meta), Facebook Catalogs, Meta Ads, Google Ads, Google Analytics.
// We have no account for these yet, so this module only does the honest part:
//   * keeps the connection keys ENCRYPTED (utils/secrets.js, the same AES-256-GCM store the Administration > Integrations screen uses; one row per
//     service in the Integration table, id 'omni-<service>'; the catalogue of Administration is not touched). A secret is NEVER returned (only a masked
//     hint), never logged, never written to an audit row.
//   * runs ONE read-only check per service with the saved keys (Shopify shop.json, Meta Graph page / ad account / catalog, Google token + customer list,
//     GA4 property) and marks "Connected" only when that check really succeeded. It never calls a posting or spending endpoint.
//   * keeps plain records of its own: OmniSocialPost (a composed post that is SAVED, never published) and OmniExtItem (a campaign plan the founder wrote
//     down; nothing is created at Meta or Google).
// In the test sandbox (TEST_MODE=1) no outside call is made unless a test injects its own fetcher with setFetcher().
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./store');
const {
  encryptSecret, decryptSecret, maskStored, isEncrypted, NO_KEY_MESSAGE,
} = require('../utils/secrets');

const SHOPIFY_VERSION = '2025-10';
const GRAPH = 'https://graph.facebook.com/v24.0';
const GADS_VERSION = 'v21';
const SETTING = (id) => `omni.external.${id}`;
const rowId = (id) => `omni-${id}`;

// ---- tables (self-provisioned, same pattern as v3schema.js) ------------------------------------------------------
const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniSocialPost" ("id" TEXT NOT NULL PRIMARY KEY, "postNumber" INTEGER NOT NULL DEFAULT 0, "platforms" TEXT NOT NULL DEFAULT \'[]\', "text" TEXT NOT NULL DEFAULT \'\', "mediaUrl" TEXT, "organization" TEXT, "settings" TEXT, "status" TEXT NOT NULL DEFAULT \'notsent\', "scheduledAt" DATETIME, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)',
  'CREATE INDEX IF NOT EXISTS "OmniSocialPost_status" ON "OmniSocialPost"("status", "createdAt")',
  'CREATE TABLE IF NOT EXISTS "OmniExtItem" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "name" TEXT NOT NULL, "budget" REAL, "data" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)',
  'CREATE INDEX IF NOT EXISTS "OmniExtItem_kind" ON "OmniExtItem"("kind", "createdAt")',
];
let okAt = 0; let ensuring = null;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } // eslint-disable-line no-await-in-loop
      catch (e) { console.error('[omni-external] schema:', e.message); return false; } // eslint-disable-line no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}
const resetSchema = () => { okAt = 0; };

// ---- the outside world (injectable for tests) --------------------------------------------------------------------
let fetcher = null;
const setFetcher = (f) => { fetcher = f || null; };
const sandbox = () => /^(1|true|yes|on)$/i.test(String(process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX || ''));
async function httpJson(url, opts = {}) {
  if (fetcher) return fetcher(url, opts);
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000), redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json };
}

// ---- the services --------------------------------------------------------------------------------------------------
// field: { id, label, secret, required, placeholder, hint, multiline }
const SERVICES = {
  shopify: {
    id: 'shopify', name: 'Shopify store',
    why: 'Once connected, orders and customers can sync into your CRM and abandoned checkouts can start a WhatsApp or Email recovery message. Today TeamLink only checks the connection and reads the shop name.',
    fields: [
      { id: 'domain', label: 'Store domain', required: true, placeholder: 'your-store.myshopify.com', hint: 'The .myshopify.com address of the store, not your own website address.' },
      { id: 'token', label: 'Admin API access token', secret: true, required: true, placeholder: 'shpat_...', hint: 'It starts with shpat_. It is shown only once in Shopify.' },
    ],
    steps: [
      'In Shopify, open Settings, then Apps and sales channels, then Develop apps.',
      'Create an app (any name). Open Configuration, then Admin API integration.',
      'Tick only the READ permissions: read_orders, read_customers, read_products. Do not tick any write permission.',
      'Click Install app, then Reveal token once. Copy the Admin API access token.',
      'Paste the store address and the token here and press Save and check.',
    ],
  },
  'meta-social': {
    id: 'meta-social', name: 'Facebook Page and Instagram account',
    why: 'Once connected, TeamLink shows your Page and Instagram numbers here, and posts and Messenger / Instagram messages can be handled from one place. Today TeamLink only checks the connection and reads the Page name and followers.',
    fields: [
      { id: 'appId', label: 'App ID', placeholder: '1234567890123456', hint: 'Meta for Developers, your app, Settings, Basic. Needed to check how long the token lasts.' },
      { id: 'appSecret', label: 'App secret', secret: true, placeholder: '', hint: 'Same page as the App ID.' },
      { id: 'pageId', label: 'Page ID', required: true, placeholder: '1098765432109876', hint: 'Digits only. Facebook Page, About, Page transparency.' },
      { id: 'pageToken', label: 'Page access token (long-lived)', secret: true, required: true, placeholder: 'EAAB...', hint: 'A long-lived Page token from the Graph API Explorer.' },
      { id: 'igId', label: 'Instagram business account ID', placeholder: '17841400000000000', hint: 'Digits only. Leave empty if you have no Instagram business account.' },
    ],
    steps: [
      'Open developers.facebook.com, My Apps, and open (or create) your app. Copy the App ID and the App secret (Settings, Basic).',
      'In Meta Business Settings, make sure your Facebook Page and your Instagram business account belong to your business.',
      'Open the Graph API Explorer, pick your app and your Page, ask for pages_show_list, pages_read_engagement and instagram_basic (the posting permissions are for later), and generate a Page access token.',
      'Make it long-lived in the Access Token Debugger (Extend access token), and copy it.',
      'Copy your Page ID and your Instagram business account ID.',
      'Paste them here and press Save and check. TeamLink only reads your Page name and followers. Nothing is posted.',
    ],
  },
  'meta-ads': {
    id: 'meta-ads', name: 'Meta ad account',
    why: 'Once connected, your Facebook and Instagram ad campaigns can be listed here. Today TeamLink only checks the connection and reads the ad account name. It never spends money.',
    fields: [
      { id: 'adAccountId', label: 'Ad account ID', required: true, placeholder: 'act_1234567890', hint: 'Meta Ads Manager, the number next to your account name.' },
      { id: 'accessToken', label: 'Access token', secret: true, required: true, placeholder: 'EAAB...', hint: 'A token with the ads_read permission only.' },
    ],
    steps: [
      'Open business.facebook.com, Business Settings, Accounts, Ad accounts, and copy your Ad account ID.',
      'In Business Settings, Users, System users, add a system user and give it your ad account with View performance only.',
      'Generate a token for that system user with only the ads_read permission. Copy it.',
      'Paste the ID and the token here and press Save and check.',
    ],
  },
  'fb-catalog': {
    id: 'fb-catalog', name: 'Facebook catalog',
    why: 'Once connected, the products of your catalog can feed Facebook and Instagram Shops. Today TeamLink only checks the connection and reads the catalog name and product count.',
    fields: [
      { id: 'catalogId', label: 'Catalog ID', required: true, placeholder: '1234567890123', hint: 'Meta Commerce Manager, Catalog, Settings.' },
      { id: 'accessToken', label: 'Access token', secret: true, required: true, placeholder: 'EAAB...', hint: 'A token with the catalog_management permission.' },
    ],
    steps: [
      'Open business.facebook.com, Commerce Manager, pick your catalog, then Settings. Copy the Catalog ID.',
      'In Business Settings, Users, System users, give a system user access to this catalog.',
      'Generate a token for that system user with the catalog_management permission. Copy it.',
      'Paste the ID and the token here and press Save and check.',
    ],
  },
  'google-ads': {
    id: 'google-ads', name: 'Google Ads account',
    why: 'Once connected, your Search, Display and Performance Max campaigns can be listed here. Today TeamLink only checks the sign-in and the account list. It never creates or changes a campaign.',
    fields: [
      { id: 'customerId', label: 'Customer ID', required: true, placeholder: '123-456-7890', hint: 'The 10-digit number at the top right of Google Ads.' },
      { id: 'developerToken', label: 'Developer token', secret: true, required: true, placeholder: '', hint: 'Google Ads, Tools, API Center (a manager account is needed).' },
      { id: 'clientId', label: 'OAuth client ID', required: true, placeholder: '1234-abc.apps.googleusercontent.com', hint: 'Google Cloud Console, APIs and Services, Credentials.' },
      { id: 'clientSecret', label: 'OAuth client secret', secret: true, required: true, placeholder: '', hint: 'Same page as the client ID.' },
      { id: 'refreshToken', label: 'OAuth refresh token', secret: true, required: true, placeholder: '1//0g...', hint: 'Made once with the OAuth Playground for the Google Ads scope.' },
      { id: 'loginCustomerId', label: 'Manager account ID', placeholder: '123-456-7890', hint: 'Only if you open this account through a manager account.' },
    ],
    steps: [
      'Open Google Ads, Tools, API Center (on your manager account) and copy the Developer token.',
      'Open console.cloud.google.com, make a project, turn on the Google Ads API, and under Credentials make an OAuth client ID. Copy the client ID and secret.',
      'Open the Google OAuth Playground, use your own client ID and secret, choose the scope https://www.googleapis.com/auth/adwords, sign in, and copy the Refresh token.',
      'Copy your 10-digit Customer ID from Google Ads.',
      'Paste everything here and press Save and check.',
    ],
  },
  'google-analytics': {
    id: 'google-analytics', name: 'Google Analytics 4 property',
    why: 'Once connected, campaign links can carry UTM tags and session and conversion numbers can appear here beside your campaign numbers. Today TeamLink only checks the connection and reads the property name.',
    fields: [
      { id: 'propertyId', label: 'GA4 property ID', required: true, placeholder: '123456789', hint: 'Digits only. Analytics, Admin, Property settings, Property ID.' },
      { id: 'measurementId', label: 'Measurement ID', placeholder: 'G-ABC1234567', hint: 'Optional. Starts with G-. Analytics, Admin, Data streams.' },
      { id: 'serviceJson', label: 'Service account JSON key', secret: true, required: true, multiline: true, placeholder: '{ "type": "service_account", ... }', hint: 'Paste the whole file. It is stored encrypted and never shown again.', hintOnly: true },
    ],
    steps: [
      'Open console.cloud.google.com, make a project, and turn on the Google Analytics Admin API.',
      'Under IAM and Admin, Service accounts, create a service account and make a JSON key. Open the file and copy everything in it.',
      'In Google Analytics, Admin, Property access management, add the service account email as a Viewer.',
      'Copy the GA4 Property ID (digits) from Admin, Property settings.',
      'Paste the property ID and the JSON here and press Save and check.',
    ],
  },
};
const IDS = Object.keys(SERVICES);
const defOf = (id) => SERVICES[id] || null;

// ---- small helpers --------------------------------------------------------------------------------------------------
const bad = (message, status = 400) => { const e = new Error(message); e.status = status; e.plain = true; return e; };
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const scrub = (text, secrets) => {
  let t = String(text == null ? '' : text);
  (secrets || []).forEach((s) => { if (s && String(s).length >= 6) t = t.split(String(s)).join('••••'); });
  return t.replace(/\s+/g, ' ').trim().slice(0, 300);
};
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// ---- reading and writing the stored keys ----------------------------------------------------------------------------
async function loadRow(id) { return prisma.integration.findUnique({ where: { id: rowId(id) } }); }
const storedOf = (row) => parse(row && row.values, {});
// server only: the decrypted values. Never goes into a response.
async function secretValues(id) {
  const def = defOf(id); const row = await loadRow(id); const stored = storedOf(row);
  const values = {}; let missingKey = false;
  (def.fields || []).forEach((f) => {
    const v = stored[f.id];
    if (f.secret && isEncrypted(v)) { const p = decryptSecret(v); if (p === null) { missingKey = true; values[f.id] = ''; } else values[f.id] = p; } else values[f.id] = v == null ? '' : String(v);
  });
  return { values, missingKey, row };
}
async function metaOf(id) { return S.getKey(SETTING(id), {}); }

// the plain state of one service for the screen. `admin` also gets the saved non-secret values (to fill the form).
async function publicState(id, admin) {
  const def = defOf(id); const row = await loadRow(id); const stored = storedOf(row); const meta = await metaOf(id);
  const saved = !!row && def.fields.filter((f) => f.required).every((f) => String(stored[f.id] == null ? '' : stored[f.id]).trim() !== '');
  const values = {}; const secretHints = {};
  def.fields.forEach((f) => {
    if (f.secret) { secretHints[f.id] = stored[f.id] ? (f.hintOnly ? '•••••• saved' : maskStored(stored[f.id])) : ''; values[f.id] = ''; } else values[f.id] = stored[f.id] == null ? '' : String(stored[f.id]);
  });
  const chk = meta.check || null;
  let status = 'not_connected';
  if (saved) status = !chk || chk.ok === null || chk.ok === undefined ? 'saved' : (chk.ok ? 'connected' : 'failed');
  const words = { not_connected: 'Not connected', saved: 'Saved, not verified', connected: 'Connected', failed: 'Check failed' }[status];
  return {
    id, name: def.name, why: def.why, steps: def.steps,
    fields: def.fields.map((f) => ({ id: f.id, label: f.label, secret: !!f.secret, required: !!f.required, placeholder: f.placeholder || '', hint: f.hint || '', multiline: !!f.multiline })),
    status, statusWords: words,
    reason: status === 'failed' ? (chk && chk.reason) || 'The check did not pass.' : (status === 'saved' && chk && chk.reason ? chk.reason : ''),
    info: status === 'connected' ? (chk.info || {}) : {},
    checkedAt: chk && chk.at ? S.iso(chk.at) : null,
    savedAt: meta.savedAt ? S.iso(meta.savedAt) : null, savedBy: meta.savedBy || '',
    secretHints, values: admin ? values : undefined,
    note: 'Nothing is posted, created or spent by this connection. TeamLink only reads.',
  };
}

// normalise + validate what the form posted (plain sentences)
function normalise(id, v) {
  const out = { ...v };
  const T = (k) => String(out[k] == null ? '' : out[k]).trim();
  if (id === 'shopify') {
    let d = T('domain').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (d) { if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) throw bad('Enter the full store address, for example your-store.myshopify.com.'); out.domain = d; }
  }
  if (id === 'meta-social') {
    ['pageId', 'igId', 'appId'].forEach((k) => { if (T(k)) { if (!/^\d{5,25}$/.test(T(k))) throw bad(`${k === 'pageId' ? 'Page ID' : k === 'igId' ? 'Instagram business account ID' : 'App ID'} must be digits only.`); out[k] = T(k); } });
  }
  if (id === 'meta-ads' && T('adAccountId')) { const d = digits(T('adAccountId').replace(/^act_/i, '')); if (d.length < 5) throw bad('The ad account ID is the number next to your account name, for example act_1234567890.'); out.adAccountId = `act_${d}`; }
  if (id === 'fb-catalog' && T('catalogId')) { const d = digits(T('catalogId')); if (d.length < 5 || d !== T('catalogId')) throw bad('The Catalog ID must be digits only.'); out.catalogId = d; }
  if (id === 'google-ads') {
    ['customerId', 'loginCustomerId'].forEach((k) => { if (T(k)) { const d = digits(T(k)); if (d.length !== 10) throw bad(`${k === 'customerId' ? 'Customer ID' : 'Manager account ID'} has 10 digits, for example 123-456-7890.`); out[k] = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; } });
    if (T('clientId') && !/\.apps\.googleusercontent\.com$/.test(T('clientId'))) throw bad('The OAuth client ID ends with .apps.googleusercontent.com.');
  }
  if (id === 'google-analytics') {
    if (T('propertyId')) { const d = digits(T('propertyId').replace(/^properties\//i, '')); if (!d || d !== T('propertyId').replace(/^properties\//i, '')) throw bad('The GA4 property ID is digits only, for example 123456789. (G-... is the Measurement ID: put it in the next box.)'); out.propertyId = d; }
    if (T('measurementId')) { const m = T('measurementId').toUpperCase(); if (!/^G-[A-Z0-9]{6,12}$/.test(m)) throw bad('A Measurement ID looks like G-ABC1234567.'); out.measurementId = m; }
    if (T('serviceJson') && T('serviceJson') !== '-') {
      let j; try { j = JSON.parse(T('serviceJson')); } catch { throw bad('That is not a valid JSON file. Open the key file and copy everything in it.'); }
      if (!j || j.type !== 'service_account' || !j.client_email || !j.private_key) throw bad('That JSON is not a service account key (it needs type, client_email and private_key).');
      if (T('serviceJson').length > 12000) throw bad('That JSON is too long to be a service account key.');
    }
  }
  return out;
}

// save the keys (encrypted) and, unless told not to, run the one read-only check
async function save(user, id, incoming, opts = {}) {
  const def = defOf(id); if (!def) throw bad('Unknown service.', 404);
  await ensure();
  const row = await loadRow(id); const stored = storedOf(row);
  const inc = normalise(id, incoming || {});
  const next = {}; const changed = [];
  for (const f of def.fields) {
    const raw = inc[f.id] == null ? '' : String(inc[f.id]);
    if (!f.secret) { const v = raw.trim(); if (v !== String(stored[f.id] || '')) changed.push(f.id); next[f.id] = v; continue; }
    if (raw.trim() === '-') { next[f.id] = ''; changed.push(f.id); continue; }
    if (!raw.trim()) { if (stored[f.id]) next[f.id] = stored[f.id]; continue; }
    try { next[f.id] = encryptSecret(raw.trim()); } catch (e) { if (e && e.code === 'NO_SECRET_KEY') throw bad(NO_KEY_MESSAGE); throw e; }
    changed.push(f.id);
  }
  const missing = def.fields.filter((f) => f.required && !String(next[f.id] || '').trim()).map((f) => f.label);
  if (missing.length) throw bad(`Please fill in: ${missing.join(', ')}.`);
  const data = { values: JSON.stringify(next), enabled: true, connected: false, state: 'Not Connected', error: null };
  await prisma.integration.upsert({ where: { id: rowId(id) }, create: { id: rowId(id), ...data }, update: data });
  const meta = await metaOf(id);
  await S.putKey(SETTING(id), { ...meta, savedAt: Date.now(), savedBy: user ? user.name : '', check: null }, user);
  let state = await publicState(id, true);
  if (opts.check !== false) state = await runCheck(id, user);
  return { state, changed };
}

async function disconnect(user, id) {
  const def = defOf(id); if (!def) throw bad('Unknown service.', 404);
  await ensure();
  const row = await loadRow(id);
  if (row) await prisma.integration.update({ where: { id: rowId(id) }, data: { values: null, enabled: false, connected: false, state: 'Not Connected', error: null } });
  await S.putKey(SETTING(id), {}, user);
  return publicState(id, true);
}

// ---- the read-only checks -------------------------------------------------------------------------------------------
const graphGet = async (path, fields, token) => httpJson(`${GRAPH}/${path}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`, { method: 'GET' });
function graphReason(r, what) {
  const e = r && r.json && r.json.error;
  if (!e) return r && r.status ? `Meta answered with an error (${r.status}) while reading ${what}.` : `Could not reach Meta to read ${what}.`;
  if (e.code === 190) return 'Meta says the access token is not valid or has expired. Make a new long-lived token.';
  if (e.code === 100) return `Meta could not find ${what} with that ID, or the token cannot see it.`;
  if (e.code === 10 || e.code === 200 || e.code === 299) return `The token is missing the permission needed to read ${what}.`;
  return `Meta said: ${e.message || 'unknown error'}`;
}
const CHECKS = {
  async shopify(v) {
    const r = await httpJson(`https://${v.domain}/admin/api/${SHOPIFY_VERSION}/shop.json`, { method: 'GET', headers: { 'X-Shopify-Access-Token': v.token, Accept: 'application/json' } });
    if (r.status === 200 && r.json && r.json.shop) { const s = r.json.shop; return { ok: true, info: { shopName: String(s.name || ''), domain: String(s.myshopify_domain || v.domain), currency: String(s.currency || ''), plan: String(s.plan_display_name || '') } }; }
    if (r.status === 401) return { ok: false, reason: 'Shopify did not accept the access token. Check you copied the whole token and that the app is installed.' };
    if (r.status === 403) return { ok: false, reason: 'The token works but it has no permission to read the shop. Tick read_orders and read_customers in the app and install it again.' };
    if (r.status === 404 || r.status === 301 || r.status === 302 || r.status === 307) return { ok: false, reason: 'Shopify has no store at that address. Check the store domain.' };
    if (r.status === 423) return { ok: false, reason: 'That Shopify store is locked or paused.' };
    return { ok: false, reason: r.status ? `Shopify answered with an error (${r.status}).` : 'Could not reach Shopify. Check the store domain and try again.' };
  },
  async 'meta-social'(v) {
    const page = await graphGet(v.pageId, 'name,fan_count,followers_count', v.pageToken);
    if (page.status !== 200 || !page.json || page.json.error) return { ok: false, reason: graphReason(page, 'the Page') };
    const info = { pageName: String(page.json.name || ''), followers: Number.isFinite(Number(page.json.followers_count)) ? Number(page.json.followers_count) : (Number.isFinite(Number(page.json.fan_count)) ? Number(page.json.fan_count) : null) };
    if (v.igId) {
      const ig = await graphGet(v.igId, 'username,followers_count,media_count', v.pageToken);
      if (ig.status !== 200 || !ig.json || ig.json.error) return { ok: false, reason: `The Facebook Page works, but the Instagram account did not: ${graphReason(ig, 'the Instagram account')}` };
      info.igUsername = String(ig.json.username || ''); info.igFollowers = Number.isFinite(Number(ig.json.followers_count)) ? Number(ig.json.followers_count) : null; info.igMedia = Number.isFinite(Number(ig.json.media_count)) ? Number(ig.json.media_count) : null;
    }
    if (v.appId && v.appSecret) {
      const d = await httpJson(`${GRAPH}/debug_token?input_token=${encodeURIComponent(v.pageToken)}&access_token=${encodeURIComponent(`${v.appId}|${v.appSecret}`)}`, { method: 'GET' });
      if (d.status !== 200 || !d.json || d.json.error || !d.json.data) return { ok: false, reason: `The Page works, but Meta did not accept the App ID and App secret: ${graphReason(d, 'the app')}` };
      const exp = Number(d.json.data.expires_at);
      info.tokenWords = d.json.data.is_valid === false ? 'The token is no longer valid.' : (!exp ? 'The token does not expire.' : `The token expires on ${new Date(exp * 1000).toISOString().slice(0, 10)}.`);
      if (d.json.data.is_valid === false) return { ok: false, reason: 'Meta says this token is no longer valid. Make a new long-lived token.' };
    }
    return { ok: true, info };
  },
  async 'meta-ads'(v) {
    const r = await graphGet(v.adAccountId, 'name,currency,account_status,timezone_name', v.accessToken);
    if (r.status !== 200 || !r.json || r.json.error) return { ok: false, reason: graphReason(r, 'the ad account') };
    return { ok: true, info: { accountName: String(r.json.name || ''), currency: String(r.json.currency || ''), timezone: String(r.json.timezone_name || '') } };
  },
  async 'fb-catalog'(v) {
    const r = await graphGet(v.catalogId, 'name,product_count', v.accessToken);
    if (r.status !== 200 || !r.json || r.json.error) return { ok: false, reason: graphReason(r, 'the catalog') };
    return { ok: true, info: { catalogName: String(r.json.name || ''), productCount: Number.isFinite(Number(r.json.product_count)) ? Number(r.json.product_count) : null } };
  },
  async 'google-ads'(v) {
    const body = new URLSearchParams({ client_id: v.clientId, client_secret: v.clientSecret, refresh_token: v.refreshToken, grant_type: 'refresh_token' }).toString();
    const t = await httpJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (t.status !== 200 || !t.json || !t.json.access_token) {
      const code = t.json && t.json.error;
      return { ok: false, reason: code === 'invalid_grant' ? 'Google did not accept the refresh token. It may be wrong, revoked or expired. Make a new one in the OAuth Playground.' : code === 'invalid_client' ? 'Google did not accept the OAuth client ID and secret.' : t.status ? 'Google could not sign in with these OAuth details.' : 'Could not reach Google. Try again.' };
    }
    const headers = { Authorization: `Bearer ${t.json.access_token}`, 'developer-token': v.developerToken };
    if (v.loginCustomerId) headers['login-customer-id'] = digits(v.loginCustomerId);
    const l = await httpJson(`https://googleads.googleapis.com/${GADS_VERSION}/customers:listAccessibleCustomers`, { method: 'GET', headers });
    if (l.status !== 200 || !l.json) {
      const msg = l.json && l.json.error && l.json.error.message;
      return { ok: false, reason: l.status === 401 || l.status === 403 ? `Google signed you in, but Google Ads refused the request${msg ? `: ${msg}` : '. Check the developer token (it may still be waiting for approval).'}` : l.status === 404 ? 'Google signed you in, but this version of the Google Ads API was not found. Ask the developer to update it.' : l.status ? `Google Ads answered with an error (${l.status}).` : 'Could not reach Google Ads. Try again.' };
    }
    const names = Array.isArray(l.json.resourceNames) ? l.json.resourceNames.map((x) => digits(x)) : [];
    const mine = digits(v.customerId);
    return { ok: true, info: { accountsFound: names.length, customerListed: names.includes(mine), customerId: v.customerId } };
  },
  async 'google-analytics'(v) {
    let sa; try { sa = JSON.parse(v.serviceJson); } catch { return { ok: false, reason: 'The saved key is not valid JSON. Save it again.' }; }
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    let assertion;
    try {
      const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000 })}`;
      assertion = `${head}.${crypto.createSign('RSA-SHA256').update(head).sign(sa.private_key).toString('base64url')}`;
    } catch { return { ok: false, reason: 'The private key inside the JSON could not be read. Make a new key file.' }; }
    const t = await httpJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
    if (t.status !== 200 || !t.json || !t.json.access_token) return { ok: false, reason: t.status ? 'Google did not accept the service account key. It may be deleted or disabled.' : 'Could not reach Google. Try again.' };
    const r = await httpJson(`https://analyticsadmin.googleapis.com/v1beta/properties/${v.propertyId}`, { method: 'GET', headers: { Authorization: `Bearer ${t.json.access_token}` } });
    if (r.status === 200 && r.json) return { ok: true, info: { propertyName: String(r.json.displayName || ''), currency: String(r.json.currencyCode || ''), timeZone: String(r.json.timeZone || '') } };
    if (r.status === 403 || r.status === 404) return { ok: false, reason: 'The key works, but that property cannot be read. Add the service account email as a Viewer in Analytics, Admin, Property access management, and check the property ID.' };
    return { ok: false, reason: r.status ? `Google Analytics answered with an error (${r.status}).` : 'Could not reach Google Analytics. Try again.' };
  },
};

async function runCheck(id, user) {
  const def = defOf(id); if (!def) throw bad('Unknown service.', 404);
  await ensure();
  const { values, missingKey, row } = await secretValues(id);
  if (!row) throw bad('Nothing is saved for this service yet.');
  const meta = await metaOf(id);
  let result;
  if (missingKey) result = { ok: false, reason: 'The saved keys cannot be read by this server (the encryption key changed). Please save them again.' };
  else if (sandbox() && !fetcher) result = { ok: null, reason: 'Saved. This is the test sandbox, so no outside check was made.' };
  else {
    try { result = await CHECKS[id](values); } catch (e) { result = { ok: false, reason: 'The check could not finish. Try again in a minute.' }; }
    const secrets = def.fields.filter((f) => f.secret).map((f) => values[f.id]);
    if (result.reason) result.reason = scrub(result.reason, secrets);
    if (result.info) { const clean = {}; Object.entries(result.info).forEach(([k, val]) => { clean[k] = typeof val === 'string' ? scrub(val, secrets) : val; }); result.info = clean; }
  }
  await S.putKey(SETTING(id), { ...meta, check: { ok: result.ok, reason: result.reason || '', info: result.info || null, at: Date.now() } }, user);
  await prisma.integration.update({ where: { id: rowId(id) }, data: { connected: result.ok === true, state: result.ok === true ? 'Connected' : 'Not Connected', lastTest: new Date(), lastTestResult: result.ok === true ? 'OK' : (result.ok === false ? 'Failed' : 'Not run'), error: result.ok === false ? String(result.reason || '').slice(0, 200) : null } });
  return publicState(id, true);
}

// ---- screen settings (display name, toggles) ------------------------------------------------------------------------
const SETTINGS_KEY = 'omni.external.settings';
const SETTINGS_DEFAULT = {
  facebook: { name: '', autoReplyHours: true, handoff: true, syncCatalog: true, messengerAuto: true },
  instagram: { name: '', autoReplyHours: true, handoff: false, syncCatalog: true, storyAuto: false },
  shopify: { syncCustomers: false },
  googleBudget: null,
};
async function settings() {
  const s = await S.getKey(SETTINGS_KEY, {});
  return { facebook: { ...SETTINGS_DEFAULT.facebook, ...(s.facebook || {}) }, instagram: { ...SETTINGS_DEFAULT.instagram, ...(s.instagram || {}) }, shopify: { ...SETTINGS_DEFAULT.shopify, ...(s.shopify || {}) }, googleBudget: s.googleBudget || null };
}
async function saveSettings(user, key, body) {
  if (!['facebook', 'instagram', 'shopify'].includes(key)) throw bad('Unknown settings group.', 404);
  const cur = await S.getKey(SETTINGS_KEY, {});
  const base = { ...SETTINGS_DEFAULT[key], ...(cur[key] || {}) };
  const b = body || {};
  const next = { ...base };
  Object.keys(SETTINGS_DEFAULT[key]).forEach((k) => {
    if (b[k] === undefined) return;
    if (k === 'name') { const n = S.clip(b.name, 80); if (!n) throw bad('The account name cannot be empty.'); next.name = n; } else next[k] = b[k] === true;
  });
  cur[key] = next;
  await S.putKey(SETTINGS_KEY, cur, user);
  return settings();
}
async function saveGoogleBudget(user, amount) {
  const n = Number(String(amount == null ? '' : amount).replace(/[^\d]/g, ''));
  if (!(n >= 1000)) throw bad('Enter a monthly budget of at least ₹1,000.');
  if (n > 100000000) throw bad('That monthly budget is too large.');
  const cur = await S.getKey(SETTINGS_KEY, {});
  cur.googleBudget = { amount: n, by: user ? user.name : '', at: Date.now() };
  await S.putKey(SETTINGS_KEY, cur, user);
  return settings();
}

// ---- social posts: SAVED only, never published ----------------------------------------------------------------------
const NETWORKS = ['facebook', 'instagram'];
const PLANNED_NETWORKS = ['linkedin', 'threads', 'twitter', 'youtube'];
const POST_WORDS = { notsent: 'Not sent yet', scheduled: 'Scheduled' };
const shapePost = (r) => ({
  id: r.id, postNumber: S.num(r.postNumber), platforms: parse(r.platforms, []), text: r.text || '', mediaUrl: r.mediaUrl || '', organization: r.organization || '', settings: parse(r.settings, {}),
  status: r.status, statusWords: POST_WORDS[r.status] || 'Not sent yet', scheduledAt: S.iso(r.scheduledAt), createdAt: S.iso(r.createdAt), createdByName: r.createdByName || '', department: r.department || '',
  published: false,
});
// IST date + time -> epoch ms
function istToMs(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return null;
  const t = Date.parse(`${date}T${time}:00+05:30`); return Number.isFinite(t) ? t : null;
}
async function listPosts(dept, { tab, limit }) {
  await ensure();
  const where = ['"deletedAt" IS NULL']; const p = [];
  if (dept === null) return { posts: [], total: 0, counts: { notsent: 0, scheduled: 0 } };
  if (dept) { where.push('"department" = ?'); p.push(dept); }
  const counts = { notsent: 0, scheduled: 0 };
  (await S.q(`SELECT "status", COUNT(*) AS n FROM "OmniSocialPost" WHERE ${where.join(' AND ')} GROUP BY "status"`, ...p)).forEach((r) => { counts[r.status] = S.num(r.n); });
  const w2 = [...where]; const p2 = [...p];
  if (tab === 'notsent' || tab === 'scheduled') { w2.push('"status" = ?'); p2.push(tab); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const rows = await S.q(`SELECT * FROM "OmniSocialPost" WHERE ${w2.join(' AND ')} ORDER BY "createdAt" DESC, "postNumber" DESC LIMIT ${lim}`, ...p2);
  return { posts: rows.map(shapePost), total: tab ? counts[tab] || 0 : counts.notsent + counts.scheduled, counts };
}
async function getPost(id) { await ensure(); const r = (await S.q('SELECT * FROM "OmniSocialPost" WHERE "id" = ? AND "deletedAt" IS NULL', String(id)))[0]; return r ? shapePost(r) : null; }
async function createPost(user, dept, b) {
  await ensure();
  const platforms = Array.isArray(b.platforms) ? [...new Set(b.platforms.map(String))] : [];
  if (!platforms.length) throw bad('Select at least one platform.');
  const planned = platforms.find((x) => !NETWORKS.includes(x));
  if (planned) throw bad(`${planned === 'twitter' ? 'X' : planned.charAt(0).toUpperCase() + planned.slice(1)} is planned. It cannot be picked yet.`);
  const text = S.clip(b.text, 5000);
  if (!text) throw bad('Write the post text first.');
  let mediaUrl = S.clip(b.mediaUrl, 500);
  if (mediaUrl && !/^https?:\/\/[^\s]+$/i.test(mediaUrl)) throw bad('The picture or video link must start with http:// or https://.');
  let status = 'notsent'; let scheduledAt = null;
  if (b.schedule) {
    scheduledAt = istToMs(b.schedule.date, b.schedule.time);
    if (!scheduledAt) throw bad('Pick a date and time first.');
    if (scheduledAt < Date.now() - 60000) throw bad('That time has already passed. Pick a time in the future.');
    status = 'scheduled';
  }
  const settingsIn = b.settings && typeof b.settings === 'object' ? b.settings : {};
  const keep = {};
  ['fbAlbum', 'igHideCounts', 'igTagLocation'].forEach((k) => { if (settingsIn[k] !== undefined && settingsIn[k] !== '') keep[k] = typeof settingsIn[k] === 'boolean' ? settingsIn[k] : S.clip(settingsIn[k], 120); });
  const next = S.num((await S.q('SELECT MAX("postNumber") AS m FROM "OmniSocialPost"'))[0].m) + 1;
  const id = S.newId('sp');
  await S.run('INSERT INTO "OmniSocialPost" ("id","postNumber","platforms","text","mediaUrl","organization","settings","status","scheduledAt","department","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, next, JSON.stringify(platforms), text, mediaUrl || null, S.clip(b.organization, 80) || null, JSON.stringify(keep), status, scheduledAt, dept || null, user.id, user.name, Date.now());
  return getPost(id);
}
async function deletePost(user, isAdmin, id) {
  await ensure();
  const r = (await S.q('SELECT * FROM "OmniSocialPost" WHERE "id" = ? AND "deletedAt" IS NULL', String(id)))[0];
  if (!r) return null;
  if (!isAdmin && r.createdById !== user.id) throw bad('Only an Admin or the person who saved this post can delete it.', 403);
  await S.run('UPDATE "OmniSocialPost" SET "deletedAt" = ? WHERE "id" = ?', Date.now(), String(id));
  return shapePost(r);
}

// ---- plain campaign plans (Ads Manager, Google Campaigns): saved, nothing created at Meta / Google ----------------------
const ITEM_KINDS = { ad_campaign: 'Facebook and Instagram ad plan', google_campaign: 'Google campaign plan' };
const shapeItem = (r) => ({ id: r.id, kind: r.kind, name: r.name, budget: r.budget == null ? null : Number(r.budget), data: parse(r.data, {}), createdAt: S.iso(r.createdAt), createdByName: r.createdByName || '', department: r.department || '', status: 'plan', statusWords: 'Plan only' });
async function listItems(dept, kind) {
  await ensure();
  if (!ITEM_KINDS[kind]) throw bad('Unknown list.', 404);
  if (dept === null) return [];
  const w = ['"kind" = ?', '"deletedAt" IS NULL']; const p = [kind];
  if (dept) { w.push('"department" = ?'); p.push(dept); }
  return (await S.q(`SELECT * FROM "OmniExtItem" WHERE ${w.join(' AND ')} ORDER BY "createdAt" DESC LIMIT 200`, ...p)).map(shapeItem);
}
async function createItem(user, dept, b) {
  await ensure();
  const kind = String(b.kind || '');
  if (!ITEM_KINDS[kind]) throw bad('Unknown list.', 404);
  const name = S.clip(b.name, 80);
  if (!name) throw bad('Give the campaign a name.');
  let budget = null;
  if (b.budget !== undefined && b.budget !== null && String(b.budget).trim() !== '') { budget = Number(String(b.budget).replace(/[^\d.]/g, '')); if (!Number.isFinite(budget) || budget < 0 || budget > 100000000) throw bad('The daily budget must be a number.'); }
  const data = {};
  if (kind === 'ad_campaign') data.platform = ['Facebook', 'Instagram', 'Facebook and Instagram'].includes(b.platform) ? b.platform : 'Facebook';
  if (kind === 'google_campaign') data.type = ['Search', 'Display', 'Performance Max'].includes(b.type) ? b.type : 'Search';
  const id = S.newId('xi');
  await S.run('INSERT INTO "OmniExtItem" ("id","kind","name","budget","data","department","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?)', id, kind, name, budget, JSON.stringify(data), dept || null, user.id, user.name, Date.now());
  return shapeItem((await S.q('SELECT * FROM "OmniExtItem" WHERE "id" = ?', id))[0]);
}
async function deleteItem(user, isAdmin, id) {
  await ensure();
  const r = (await S.q('SELECT * FROM "OmniExtItem" WHERE "id" = ? AND "deletedAt" IS NULL', String(id)))[0];
  if (!r) return null;
  if (!isAdmin && r.createdById !== user.id) throw bad('Only an Admin or the person who wrote this plan can remove it.', 403);
  await S.run('UPDATE "OmniExtItem" SET "deletedAt" = ? WHERE "id" = ?', Date.now(), String(id));
  return shapeItem(r);
}

module.exports = {
  SERVICES, IDS, defOf, ensure, resetSchema, setFetcher, sandbox, publicState, save, runCheck, disconnect, normalise,
  settings, saveSettings, saveGoogleBudget,
  NETWORKS, PLANNED_NETWORKS, listPosts, getPost, createPost, deletePost, istToMs,
  ITEM_KINDS, listItems, createItem, deleteItem, bad,
};
