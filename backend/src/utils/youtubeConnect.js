// ---------------------------------------------------------------------------
// "CONNECT YOUTUBE" (founder 2026-10-31: "youtube ki kuda inko tab pettu"): Administration > Integrations > Social Media > YouTube. An Admin
// signs in on GOOGLE'S own page (the password is typed there, never in TeamLink), picks the Google account / Brand Account that owns the
// channel and allows it. TeamLink keeps the channel(s) with a refresh token (official OAuth 2.0, no browser bot), like LinkedIn
// (utils/linkedinConnect.js).
//
//   1  start()     Google's login address with a signed, 15-minute "state" naming the Admin (prompt: choose the account + consent, so another
//                  Google account / channel can be added every time).
//   2  callback    Google sends the browser back to  <site>/api/public/youtube-connect/callback?code=..&state=..  (public; the state proves it).
//                  The code is exchanged for tokens; YouTube Data API v3 channels?mine=true says which channel(s) they belong to; each channel is
//                  kept in the Social Media list (utils/socialAccounts.js addYoutube) with the REFRESH token (encrypted). The browser goes back to
//                  Integrations > Social Media > YouTube.
//
// The Google app: OAuth Client ID + Client secret (Google Cloud > APIs & Services > Credentials > OAuth client ID, type "Web application")
// typed once on the YouTube tab (AppSetting 'social.youtube.app', the secret encrypted), or YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in the
// environment. The exact redirect address to register is shown on the tab. Scopes: youtube.readonly (which channels) and youtube.upload
// (upload videos later). Test hooks: TL_GOOGLE_AUTH_BASE, TL_GOOGLE_TOKEN_URL, TL_YOUTUBE_API_BASE. No token ever goes into an address, a
// log, an audit row or an answer to the browser.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { encryptSecret, decryptSecret } = require('./secrets');
const FBC = require('./facebookConnect');

const KEY = 'social.youtube.app';
const SCOPES = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload';
const authBase = () => String(process.env.TL_GOOGLE_AUTH_BASE || 'https://accounts.google.com').replace(/\/+$/, '');
const tokenUrl = () => String(process.env.TL_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token');
const apiBase = () => String(process.env.TL_YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');
const jwtSecret = () => process.env.JWT_SECRET;
const redirectUri = (req) => `${FBC.siteBase(req)}/api/public/youtube-connect/callback`;

async function readApp() {
  let id = String(process.env.YOUTUBE_CLIENT_ID || '').trim();
  let secret = String(process.env.YOUTUBE_CLIENT_SECRET || '').trim();
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const v = row ? JSON.parse(row.value) : {};
    // what is typed on the screen comes first (the lesson of the Facebook secret, 2026-10-31)
    if (v.clientId) id = String(v.clientId).trim();
    if (v.secretEnc) { const s = decryptSecret(v.secretEnc); if (s === null) return { missingKey: true }; if (s) secret = String(s).trim(); }
  } catch { /* nothing saved */ }
  return { id, secret };
}

async function appView(req) {
  const a = await readApp();
  return { hasApp: !!(a.id && a.secret), clientId: a.id || '', hasSecret: !!a.secret, redirectUri: redirectUri(req) };
}

async function saveApp(user, { clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (id && !/^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/.test(id)) return { error: 'The Client ID ends with .apps.googleusercontent.com (Google Cloud > APIs & Services > Credentials).', status: 400 };
  if (secret && (secret.length < 10 || /\s/.test(secret) || secret.length > 120)) return { error: 'That does not look like a Client secret. Copy it again from the OAuth client in Google Cloud.', status: 400 };
  let cur = {};
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); cur = row ? JSON.parse(row.value) : {}; } catch { cur = {}; }
  const next = { clientId: id || cur.clientId || '', secretEnc: cur.secretEnc || null };
  if (secret) { try { next.secretEnc = encryptSecret(secret); } catch { return { error: 'The secret key of this server is missing, so nothing can be stored encrypted.', status: 400 }; } }
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
  void user;
  return { ok: true };
}

async function start(user, req) {
  const a = await readApp();
  if (a.missingKey) return { error: 'The secret key of this server is missing, so nothing can be stored encrypted.', status: 400 };
  if (!a.id || !a.secret) return { error: 'Type the Google Client ID and Client secret first (the one-time setup below), then press Connect YouTube.', status: 400 };
  const state = jwt.sign({ k: 'ytconnect', u: user.id, b: FBC.siteBase(req), n: crypto.randomBytes(8).toString('hex') }, jwtSecret(), { expiresIn: '15m' });
  const q = new URLSearchParams({
    client_id: a.id, redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPES, state,
    access_type: 'offline', include_granted_scopes: 'true', prompt: 'select_account consent',
  });
  return { ok: true, url: `${authBase()}/o/oauth2/v2/auth?${q.toString()}`, redirectUri: redirectUri(req) };
}

async function readJson(url, init) {
  let res;
  try { res = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(30000) }); } catch { throw new Error('Google could not be reached from this server. Press Connect YouTube again in a minute.'); }
  const text = await res.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!res.ok) throw new Error(String(j.error_description || (j.error && (j.error.message || j.error)) || `Google answered ${res.status}`).slice(0, 220));
  return j;
}

async function finish(req, code, base, st) {
  const a = await readApp();
  if (!a.id || !a.secret) throw new Error('The Google Client ID / Client secret are missing on this server.');
  const tok = await readJson(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${base}/api/public/youtube-connect/callback`, client_id: a.id, client_secret: a.secret }).toString(),
  });
  if (!tok.access_token) throw new Error('Google gave no token for this sign-in.');
  const ch = await readJson(`${apiBase()}/channels?${new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' })}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const channels = (ch.items || []).filter((c) => c && c.id);
  if (!channels.length) throw new Error('This Google account has no YouTube channel. Pick the account (or Brand Account) that owns the channel.');
  const user = await prisma.user.findUnique({ where: { id: st.u } });
  if (!user) throw new Error('The Admin who started this is no longer in TeamLink.');
  const SA = require('./socialAccounts'); // eslint-disable-line global-require
  return SA.addYoutube(user, channels.map((c) => ({
    id: String(c.id), title: (c.snippet && c.snippet.title) || String(c.id), handle: (c.snippet && c.snippet.customUrl) || null,
  })), { refreshToken: tok.refresh_token || null, accessToken: tok.access_token, expiresIn: tok.expires_in || null });
}

const router = express.Router();
router.get('/callback', async (req, res) => {
  let st;
  try { st = jwt.verify(String(req.query.state || ''), jwtSecret()); } catch { return res.status(400).type('text/plain').send('This YouTube sign-in link has expired or is not valid. Close this page and press Connect YouTube again in TeamLink.'); }
  if (!st || st.k !== 'ytconnect') return res.status(400).type('text/plain').send('Not a valid YouTube sign-in link.');
  const base = FBC.baseOk(st.b) ? String(st.b).replace(/\/+$/, '') : FBC.siteBase(req);
  const back = (qs) => res.redirect(302, `${base}/admin/integrations?tab=facebook&sub=youtube&${qs}`);
  if (req.query.error) return back(`youtube=denied&why=${encodeURIComponent(String(req.query.error).slice(0, 200))}`);
  try {
    const r = await finish(req, String(req.query.code || ''), base, st);
    return back(`youtube=connected&n=${r.added.length}`);
  } catch (err) {
    return back(`youtube=failed&why=${encodeURIComponent(String(err.message || 'Google did not accept the sign-in.').slice(0, 220))}`);
  }
});

module.exports = { router, start, appView, saveApp, readApp, redirectUri, SCOPES };
