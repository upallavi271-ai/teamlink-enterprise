// ---------------------------------------------------------------------------
// "CONNECT WITH FACEBOOK" (founder 2026-10-30): an Admin presses one button on Administration > Integrations > Social Media, signs in on
// Facebook's OWN page (the password is typed there, never in TeamLink), picks the Page, and TeamLink gets the Page access token by itself.
//
//   1  start()     builds Facebook's login address (the official OAuth dialog) with a signed, 15-minute "state" naming the Admin.
//   2  callback    Facebook sends the browser back to  <site>/api/public/facebook-connect/callback?code=..&state=..  (public route, the state proves it).
//                  The code is exchanged for a token, the token for a long-lived one, and /me/accounts lists the Pages with their own tokens
//                  (a Page token made from a long-lived person token does not expire).
//   3  one Page -> saved at once; several -> the Admin picks one on the Integrations screen (pending(), select()).
//   4  "saved" = the same path as typing the details by hand (routes/admin.js applySocial): copied to the job-posting connection, checked with
//                Facebook (read-only), handed to Omni-Channel. Connected only if Facebook accepts it.
//
// The Meta app: App ID + App secret on the Social Media card ("Meta App ID", "Meta App secret"), or FACEBOOK_APP_ID / FACEBOOK_APP_SECRET in the
// environment; a blank App secret falls back to the WhatsApp card's App secret (the same Meta app). The exact redirect address to register in
// the Meta app (Facebook Login > Settings > Valid OAuth Redirect URIs) is shown on the card (redirectUri()).
// Permissions asked: pages_show_list, pages_read_engagement, pages_manage_posts. Until the Meta app is reviewed ("Live"), Facebook lets only the
// app's own admins / testers use it: said in words when Facebook refuses.
// Test hooks: TL_FACEBOOK_GRAPH_BASE, TL_FACEBOOK_DIALOG_BASE (a local fake Facebook).
// No token is ever put in an address, a log, an audit row or an answer to the browser.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { encryptSecret, decryptSecret } = require('./secrets');
const { readConfig, writeValues } = require('./integrationStore');

// + Instagram (founder 2026-10-30: "diniki unna Instagram and threads ni kuda connect chey"): the Instagram professional account linked to the Page
// is posted to with the same Page token; Omni-Channel reads which Instagram account belongs to the Page by itself.
const SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management';
const APP_ID_LABEL = 'Meta App ID';
const APP_SECRET_LABEL = 'Meta App secret';
// A Meta app on "Facebook Login for Business" refuses the plain permission list ("Invalid Scopes: pages_show_list, ...", founder 2026-10-30):
// it takes a login CONFIGURATION made in the app (Facebook Login for Business > Configurations). With its ID set, the login asks by config_id.
const CONFIG_LABEL = 'Meta login configuration ID';
const PENDING_PREFIX = 'fb.pending.';
const PENDING_MS = 15 * 60 * 1000;

const graphBase = () => String(process.env.TL_FACEBOOK_GRAPH_BASE || 'https://graph.facebook.com/v19.0').replace(/\/+$/, '');
const dialogBase = () => String(process.env.TL_FACEBOOK_DIALOG_BASE || 'https://www.facebook.com/v19.0/dialog/oauth');
const jwtSecret = () => process.env.JWT_SECRET;

// The address the Admin really has open comes first (the browser's Origin, or the Referer of a plain GET): a stale APP_BASE_URL (for
// example a copied http://localhost:5183) must not decide where Facebook sends the browser back (2026-10-30). Then APP_BASE_URL, then Host.
function browserSite(req) {
  const h = (req && req.headers) || {};
  if (h.origin && /^https?:\/\//.test(h.origin)) return String(h.origin).replace(/\/+$/, '');
  try { if (h.referer) return new URL(h.referer).origin; } catch { /* not an address */ }
  return null;
}
function siteBase(req) {
  const seen = browserSite(req);
  if (seen) return seen;
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  const host = req && req.get && req.get('host');
  if (host) return `${req.headers['x-forwarded-proto'] || req.protocol}://${host}`.replace(':4010', ':5183');
  return 'http://localhost:5183';
}
const redirectUri = (req) => `${siteBase(req)}/api/public/facebook-connect/callback`;
// 2026-10-30 (founder: "prathi sari ahh page loki redirect avvaledhu"): when Facebook sends the browser back, the request has no Origin and,
// behind nginx, its Host can be the inner 127.0.0.1:4010 - so the address worked out THEN was not the one Facebook was given at the start
// (the token exchange failed and the browser was sent to an address it cannot open). The site address of the start is now carried in the
// signed state and used for both.
const baseOk = (b) => /^https?:\/\/[A-Za-z0-9.:-]+$/.test(String(b || ''));

// 2026-10-31 (live kept answering "Error validating client secret" after a new secret was typed): what is typed on the screen now comes
// FIRST; FACEBOOK_APP_ID / FACEBOOK_APP_SECRET in .env are only the fallback, and `from` says which secret is used (never the value).
async function appCreds() {
  const c = await readConfig('social');
  if (c.missingKey) return { missingKey: true };
  const v = c.values || {};
  let id = String(v[APP_ID_LABEL] || '').trim();
  let secret = String(v[APP_SECRET_LABEL] || '').trim();
  let from = secret ? 'typed on the Social Media screen' : '';
  const configId = String(v[CONFIG_LABEL] || '').replace(/\D/g, '') || String(process.env.FACEBOOK_LOGIN_CONFIG_ID || '').trim();
  if (!id) id = String(process.env.FACEBOOK_APP_ID || '').trim();
  if (!secret && process.env.FACEBOOK_APP_SECRET) { secret = String(process.env.FACEBOOK_APP_SECRET).trim(); from = 'FACEBOOK_APP_SECRET in the server settings (.env)'; }
  if (id && !secret) { // the WhatsApp card's App secret belongs to the same Meta app
    try {
      const w = await readConfig('whatsapp');
      const key = Object.keys(w.values || {}).find((k) => /^app secret/i.test(k));
      if (key) { secret = String(w.values[key] || '').trim(); if (secret) from = 'the WhatsApp card'; }
    } catch { /* none */ }
  }
  return { id, secret, configId, from };
}

// "Check App ID + Secret": asks Facebook for an app token with them (nothing is posted, no login needed) - the quickest proof the pair matches
async function checkApp() {
  const a = await appCreds();
  if (a.missingKey) return { ok: false, words: 'The secret key of this server is missing.' };
  if (!a.id || !a.secret) return { ok: false, words: 'Type the App ID and App secret first.' };
  try {
    const j = await readJson(`${graphBase()}/oauth/access_token?${new URLSearchParams({ client_id: a.id, client_secret: a.secret, grant_type: 'client_credentials' })}`);
    return j.access_token ? { ok: true, from: a.from, words: `App ID ${a.id} and the App secret match (secret from ${a.from}).` } : { ok: false, from: a.from, words: 'Facebook gave no app token.' };
  } catch (err) { return { ok: false, from: a.from, words: `Facebook says: ${err.message} (App ID ${a.id}; secret from ${a.from}). Copy the App secret again from App settings > Basic > Show.` }; }
}

// 2026-10-30 (live: "Facebook could not be reached from this server" right after a good sign-in): a call that never got an answer is tried
// again (3 times, a short pause between) and the words say why (the network's own code). Servers often have a broken IPv6 route to
// graph.facebook.com, so IPv4 is asked first (dns ipv4first, for this process).
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* older Node */ }
const NET_WAIT_MS = [0, 1500, 4000];
async function readJson(url, init) {
  let res;
  let why = '';
  for (const wait of NET_WAIT_MS) {
    // eslint-disable-next-line no-await-in-loop
    if (wait) await new Promise((r) => { setTimeout(r, wait); });
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(30000) });
      break;
    } catch (err) {
      const c = err && (err.cause || err);
      const inner = c && Array.isArray(c.errors) && c.errors[0];
      why = String((c && c.code) || (inner && inner.code) || (err && err.name === 'TimeoutError' ? 'no answer in 30 s' : '') || (c && c.message) || 'no answer').slice(0, 80);
    }
  }
  if (!res) throw new Error(`Facebook could not be reached from this server (${why}, tried 3 times). Press Connect with Facebook again in a minute.`);
  const text = await res.text();
  let j = null; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!res.ok || (j && j.error)) {
    const e = (j && j.error) || {};
    const say = String(e.message || `Facebook answered ${res.status}`).replace(/access_token=[^&\s"]+/gi, 'access_token=…').slice(0, 220);
    throw new Error(say);
  }
  return j;
}

// ---- 1. the login address -----------------------------------------------------------------------------------------------
async function start(user, req) {
  const a = await appCreds();
  if (a.missingKey) return { error: 'The secret key of this server is missing, so nothing can be stored encrypted.', status: 400 };
  if (!a.id) return { error: 'Type the Meta App ID on this card first (Meta for Developers, your app, Settings, Basic), then press Connect with Facebook.', status: 400 };
  if (!a.secret) return { error: 'Type the Meta App secret on this card first (the same page as the App ID), then press Connect with Facebook.', status: 400 };
  const state = jwt.sign({ k: 'fbconnect', u: user.id, b: siteBase(req), n: crypto.randomBytes(8).toString('hex') }, jwtSecret(), { expiresIn: '15m' });
  const q = new URLSearchParams(a.configId
    ? { client_id: a.id, redirect_uri: redirectUri(req), state, config_id: a.configId, response_type: 'code', override_default_response_type: 'true' }
    : { client_id: a.id, redirect_uri: redirectUri(req), state, scope: SCOPES, response_type: 'code' });
  return { ok: true, url: `${dialogBase()}?${q.toString()}`, redirectUri: redirectUri(req) };
}

// ---- 3. waiting list of Pages ---------------------------------------------------------------------------------------------
async function putPending(userId, pages) {
  const n = crypto.randomBytes(12).toString('hex');
  const value = JSON.stringify({ userId, at: Date.now(), pages: pages.map((p) => ({ id: String(p.id), name: String(p.name || p.id), tokenEnc: encryptSecret(p.access_token) })) });
  await prisma.appSetting.upsert({ where: { key: PENDING_PREFIX + n }, update: { value }, create: { key: PENDING_PREFIX + n, value } });
  return n;
}
async function getPending(k, userId) {
  if (!/^[a-f0-9]{24}$/.test(String(k || ''))) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: PENDING_PREFIX + k } });
  if (!row) return null;
  let p = null; try { p = JSON.parse(row.value); } catch { p = null; }
  if (!p || p.userId !== userId || Date.now() - p.at > PENDING_MS) { await prisma.appSetting.delete({ where: { key: PENDING_PREFIX + k } }).catch(() => {}); return null; }
  return p;
}
async function dropPending(k) { await prisma.appSetting.delete({ where: { key: PENDING_PREFIX + k } }).catch(() => {}); }
async function sweepPending() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PENDING_PREFIX } } }).catch(() => []);
  for (const r of rows) { let p = null; try { p = JSON.parse(r.value); } catch { p = null; } if (!p || Date.now() - p.at > PENDING_MS) await prisma.appSetting.delete({ where: { key: r.key } }).catch(() => {}); } // eslint-disable-line no-await-in-loop
}

async function pending(user, k) {
  const p = await getPending(k, user.id);
  if (!p) return { error: 'This list of Pages has expired. Press Connect with Facebook again.', status: 410 };
  return { ok: true, pages: p.pages.map((x) => ({ id: x.id, name: x.name })) };
}

// the finisher is routes/admin.js applySocial (it lives there next to the card); set once at start-up
let finisher = null;
function setFinisher(fn) { finisher = fn; }
async function save(user, page) { // page { id, access_token } -> { ok, words, status }
  const w = await writeValues('social', { 'Facebook Page ID': String(page.id), 'Facebook Page access token': String(page.access_token) });
  await prisma.integration.update({ where: { id: 'social' }, data: { values: JSON.stringify(w.values) } });
  return finisher(user, { how: 'Connected with Facebook' });
}

async function select(user, k, pageId) {
  const p = await getPending(k, user.id);
  if (!p) return { error: 'This list of Pages has expired. Press Connect with Facebook again.', status: 410 };
  const page = p.pages.find((x) => x.id === String(pageId));
  if (!page) return { error: 'That Page is not in the list.', status: 400 };
  const token = decryptSecret(page.tokenEnc);
  if (!token) return { error: 'The secret key of this server changed; press Connect with Facebook again.', status: 400 };
  await dropPending(k);
  return { ok: true, result: await save(user, { id: page.id, access_token: token }) };
}

// many Pages at once (Social Media accounts, utils/socialAccounts.js): the picked Pages with their tokens; the waiting list is used up
async function takePages(user, k, ids) {
  const p = await getPending(k, user.id);
  if (!p) return { error: 'This list of Pages has expired. Press Connect with Facebook again.', status: 410 };
  const want = new Set((ids || []).map(String));
  const picked = p.pages.filter((x) => want.has(String(x.id)));
  if (!picked.length) return { error: 'Tick at least one Page.', status: 400 };
  const pages = picked.map((x) => ({ id: x.id, name: x.name, token: decryptSecret(x.tokenEnc) }));
  if (pages.some((x) => !x.token)) return { error: 'The secret key of this server changed; press Connect with Facebook again.', status: 400 };
  await dropPending(k);
  return { ok: true, pages };
}

// ---- 2. Facebook sends the browser back here ----------------------------------------------------------------------------------
async function exchange(req, code, base = null) {
  const a = await appCreds();
  if (!a.id || !a.secret) throw new Error('The Meta App ID / App secret are missing on this server.');
  const short = await readJson(`${graphBase()}/oauth/access_token?${new URLSearchParams({ client_id: a.id, client_secret: a.secret, redirect_uri: base ? `${base}/api/public/facebook-connect/callback` : redirectUri(req), code })}`);
  if (!short.access_token) throw new Error('Facebook gave no token for this sign-in.');
  return pagesOf(short.access_token, a);
}
// A USER token -> made long-lived with this app -> the Pages the person manages, each with its own Page token. Used after the
// login above, and for a token pasted from Graph API Explorer (fromToken below: the backup when Facebook's login page only says
// "Sorry, something went wrong", founder 2026-10-30).
async function pagesOf(userToken, a) {
  let longTok = userToken;
  try {
    const l = await readJson(`${graphBase()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: a.id, client_secret: a.secret, fb_exchange_token: userToken })}`);
    if (l.access_token) longTok = l.access_token;
  } catch { /* the short one still lists the Pages; its Page tokens are then short too, the check below says so */ }
  const accounts = await readJson(`${graphBase()}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token', limit: '100', access_token: longTok })}`);
  return (accounts.data || []).filter((p) => p && p.id && p.access_token);
}

// The backup way: a user token copied from Graph API Explorer (made with THIS app). The same waiting list and Page pick follow.
async function fromToken(user, token) {
  const t = String(token || '').trim();
  if (t.length < 30 || /\s/.test(t)) return { error: 'That does not look like a Facebook access token. Copy the whole "Access Token" box from Graph API Explorer.', status: 400 };
  const a = await appCreds();
  if (a.missingKey) return { error: 'The secret key of this server is missing, so nothing can be stored encrypted.', status: 400 };
  if (!a.id || !a.secret) return { error: 'Type the Meta App ID and App secret first (step 3).', status: 400 };
  let pages;
  try { pages = await pagesOf(t, a); } catch (err) { return { error: `Facebook did not accept the token: ${err.message}`, status: 422 }; }
  if (!pages.length) return { error: 'Facebook listed no Page for this token. In Graph API Explorer add the permission pages_show_list (and the other two), press Generate Access Token again and tick your Page.', status: 422 };
  sweepPending().catch(() => {});
  return { ok: true, k: await putPending(user.id, pages) };
}

const router = express.Router();
router.get('/callback', async (req, res) => {
  let st;
  try { st = jwt.verify(String(req.query.state || ''), jwtSecret()); } catch { return res.status(400).type('text/plain').send('This Facebook sign-in link has expired or is not valid. Close this page and press Connect with Facebook again in TeamLink.'); }
  if (!st || st.k !== 'fbconnect') return res.status(400).type('text/plain').send('Not a valid Facebook sign-in link.');
  const base = baseOk(st.b) ? String(st.b).replace(/\/+$/, '') : siteBase(req);
  // back to Administration > Integrations > Facebook (the step-by-step tab), where the Page is picked
  const back = (qs) => res.redirect(302, `${base}/admin/integrations?tab=facebook&${qs}`);
  if (req.query.error) return back('facebook=denied');
  try {
    const user = await prisma.user.findUnique({ where: { id: st.u } });
    if (!user) return back(`facebook=failed&why=${encodeURIComponent('The Admin who started this is no longer in TeamLink.')}`);
    const pages = await exchange(req, String(req.query.code || ''), base);
    if (!pages.length) return back('facebook=nopages');
    sweepPending().catch(() => {});
    const k = await putPending(user.id, pages);
    return back(`facebook=pick&k=${k}`);
  } catch (err) {
    return back(`facebook=failed&why=${encodeURIComponent(String(err.message || 'Facebook did not accept the sign-in.').slice(0, 220))}`);
  }
});

module.exports = { checkApp, router, siteBase, baseOk, start, pending, select, takePages, save, setFinisher, redirectUri, appCreds, exchange, fromToken, APP_ID_LABEL, APP_SECRET_LABEL, CONFIG_LABEL, SCOPES };
