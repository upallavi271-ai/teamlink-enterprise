// ---------------------------------------------------------------------------
// "CONNECT LINKEDIN" (founder 2026-10-31: job posts must also go to Instagram, Facebook, LinkedIn ...): an Admin presses one button on
// Administration > Integrations > Social Media > LinkedIn, signs in on LinkedIn's OWN page (the password is typed there, never in
// TeamLink) and allows posting. TeamLink gets a LinkedIn access token by itself (official OAuth 2.0, no browser bot).
//
//   1  start()     builds LinkedIn's login address with a signed, 15-minute "state" naming the Admin.
//   2  callback    LinkedIn sends the browser back to  <site>/api/public/linkedin-connect/callback?code=..&state=..  (public route; the state proves it).
//                  The code is exchanged for a token (it lasts about 60 days), /v2/userinfo says whose it is, and the account is kept in the
//                  Social Media list (utils/socialAccounts.js addLinkedin). The browser goes back to Integrations > Social Media > LinkedIn.
//   3  the default LinkedIn account is the one job posts use (utils/socialPosting.js).
//
// The LinkedIn app: Client ID + Client secret typed once on the LinkedIn tab (kept encrypted in AppSetting 'social.linkedin.app'), or
// LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in the environment. The exact redirect address to register in the LinkedIn app
// (Auth > Authorized redirect URLs) is shown on the tab (redirectUri()).
// Permissions: openid profile w_member_social (post on the person's own profile; the products "Sign In with LinkedIn using OpenID Connect" and
// "Share on LinkedIn" are free and instant). A Company Page also needs w_organization_social (LinkedIn's "Community Management API", which LinkedIn
// approves per app): asked ONLY when the Admin typed a Company Page number.
// Test hooks: TL_LINKEDIN_AUTH_BASE, TL_LINKEDIN_API_BASE (a local fake LinkedIn).
// No token is ever put in an address, a log, an audit row or an answer to the browser.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { encryptSecret, decryptSecret } = require('./secrets');
const FBC = require('./facebookConnect');

const KEY = 'social.linkedin.app';
const authBase = () => String(process.env.TL_LINKEDIN_AUTH_BASE || 'https://www.linkedin.com').replace(/\/+$/, '');
const apiBase = () => String(process.env.TL_LINKEDIN_API_BASE || 'https://api.linkedin.com').replace(/\/+$/, '');
const jwtSecret = () => process.env.JWT_SECRET;
const redirectUri = (req) => `${FBC.siteBase(req)}/api/public/linkedin-connect/callback`;

async function readApp() {
  let id = String(process.env.LINKEDIN_CLIENT_ID || '').trim();
  let secret = String(process.env.LINKEDIN_CLIENT_SECRET || '').trim();
  if (!id || !secret) {
    try {
      const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
      const v = row ? JSON.parse(row.value) : {};
      id = id || String(v.clientId || '').trim();
      if (!secret && v.secretEnc) { const s = decryptSecret(v.secretEnc); if (s === null) return { missingKey: true }; secret = String(s || '').trim(); }
    } catch { /* nothing saved */ }
  }
  return { id, secret };
}

// what the screen may know: no secret
async function appView(req) {
  const a = await readApp();
  return { hasApp: !!(a.id && a.secret), clientId: a.id || '', hasSecret: !!a.secret, redirectUri: redirectUri(req) };
}

async function saveApp(user, { clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (id && !/^[A-Za-z0-9]{8,40}$/.test(id)) return { error: 'The Client ID is a short code of letters and numbers (LinkedIn developer page, your app, Auth tab).', status: 400 };
  if (secret && (secret.length < 8 || /\s/.test(secret) || secret.length > 120)) return { error: 'That does not look like a Client secret. Copy it again from the Auth tab of your LinkedIn app.', status: 400 };
  let cur = {};
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); cur = row ? JSON.parse(row.value) : {}; } catch { cur = {}; }
  const next = { clientId: id || cur.clientId || '', secretEnc: cur.secretEnc || null };
  if (secret) { try { next.secretEnc = encryptSecret(secret); } catch { return { error: 'The secret key of this server is missing, so nothing can be stored encrypted.', status: 400 }; } }
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
  void user;
  return { ok: true };
}

// ---- 1. the login address ------------------------------------------------------------------------------------------------
async function start(user, req, { pageId = null } = {}) {
  const a = await readApp();
  if (a.missingKey) return { error: 'The secret key of this server is missing, so nothing can be stored encrypted.', status: 400 };
  if (!a.id || !a.secret) return { error: 'Type the LinkedIn Client ID and Client secret first (the one-time setup below), then press Connect LinkedIn.', status: 400 };
  const org = String(pageId || '').trim();
  if (org && !/^\d{3,15}$/.test(org)) return { error: 'The Company Page number is only digits (the number in the Page\'s admin web address, linkedin.com/company/12345678/admin).', status: 400 };
  const state = jwt.sign({ k: 'liconnect', u: user.id, b: FBC.siteBase(req), n: crypto.randomBytes(8).toString('hex'), o: org || null }, jwtSecret(), { expiresIn: '15m' });
  const scope = `openid profile w_member_social${org ? ' w_organization_social' : ''}`;
  const q = new URLSearchParams({ response_type: 'code', client_id: a.id, redirect_uri: redirectUri(req), state, scope });
  return { ok: true, url: `${authBase()}/oauth/v2/authorization?${q.toString()}`, redirectUri: redirectUri(req) };
}

async function readJson(url, init) {
  let res;
  try { res = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(30000) }); } catch { throw new Error('LinkedIn could not be reached from this server. Press Connect LinkedIn again in a minute.'); }
  const text = await res.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!res.ok) throw new Error(String(j.error_description || j.message || `LinkedIn answered ${res.status}`).slice(0, 220));
  return j;
}

// ---- 2. LinkedIn sends the browser back here ----------------------------------------------------------------------------------
async function finish(req, code, base, st) {
  const a = await readApp();
  if (!a.id || !a.secret) throw new Error('The LinkedIn Client ID / Client secret are missing on this server.');
  const tok = await readJson(`${authBase()}/oauth/v2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${base}/api/public/linkedin-connect/callback`, client_id: a.id, client_secret: a.secret }).toString(),
  });
  if (!tok.access_token) throw new Error('LinkedIn gave no token for this sign-in.');
  const me = await readJson(`${apiBase()}/v2/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!me.sub) throw new Error('LinkedIn did not say who signed in.');
  const SA = require('./socialAccounts'); // eslint-disable-line global-require
  const user = await prisma.user.findUnique({ where: { id: st.u } });
  if (!user) throw new Error('The Admin who started this is no longer in TeamLink.');
  const expiresAt = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null;
  const out = await SA.addLinkedin(user, { sub: String(me.sub), name: me.name || [me.given_name, me.family_name].filter(Boolean).join(' ') || null, token: tok.access_token, expiresAt, orgId: st.o || null });
  try { await require('./socialPosting').mirror(user); } catch { /* the Social Media screen shows the state */ } // eslint-disable-line global-require
  return out;
}

const router = express.Router();
router.get('/callback', async (req, res) => {
  let st;
  try { st = jwt.verify(String(req.query.state || ''), jwtSecret()); } catch { return res.status(400).type('text/plain').send('This LinkedIn sign-in link has expired or is not valid. Close this page and press Connect LinkedIn again in TeamLink.'); }
  if (!st || st.k !== 'liconnect') return res.status(400).type('text/plain').send('Not a valid LinkedIn sign-in link.');
  const base = FBC.baseOk(st.b) ? String(st.b).replace(/\/+$/, '') : FBC.siteBase(req);
  const back = (qs) => res.redirect(302, `${base}/admin/integrations?tab=facebook&sub=linkedin&${qs}`);
  if (req.query.error) return back(`linkedin=denied&why=${encodeURIComponent(String(req.query.error_description || req.query.error).slice(0, 200))}`);
  try {
    await finish(req, String(req.query.code || ''), base, st);
    return back('linkedin=connected');
  } catch (err) {
    return back(`linkedin=failed&why=${encodeURIComponent(String(err.message || 'LinkedIn did not accept the sign-in.').slice(0, 220))}`);
  }
});

module.exports = { router, start, appView, saveApp, readApp, redirectUri };
