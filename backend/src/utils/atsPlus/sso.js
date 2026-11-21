// ---------------------------------------------------------------------------
// SINGLE SIGN-ON FOR STAFF (market benchmark 15.01, and the sign-in half of 14.05 Google Workspace / Microsoft 365). OIDC (Google, Microsoft
// Entra, Okta, Keycloak ...) and SAML 2.0. Administration -> ATS settings -> Integrations -> Single sign-on; the login page shows a
// "Sign in with ..." button for each provider that is switched on.
//
// RULES: SSO never makes a login. The e-mail the IdP vouches for must belong to an ACTIVE TeamLink login (and, when set, to one of the
// provider's allowed domains); the sign-in then finishes exactly like a password sign-in (routes/auth.js finishSignIn: the employment
// checks, the IP allow-list, the audit row, the session) - the IdP's own two-step counts as the second step.
//   OIDC: authorization-code flow; the id_token is checked against the provider's keys (JWKS, RS256), issuer, audience, expiry, nonce.
//   SAML: HTTP-Redirect AuthnRequest; the POSTed response must be signed (Response or Assertion) with the IdP certificate typed here
//         (utils/atsPlus/samlXml.js: exclusive c14n + XML-DSig), be inside its time window, for this SP (Audience), with InResponseTo
//         our request; one Assertion only.
//   /api/sso/providers   GET /api/sso/:id/start   POST /api/sso/oidc/finish {code, state}   POST /api/sso/saml/acs   POST /api/sso/finish {ticket}
// Client secrets are stored encrypted (utils/secrets.js). Real IdPs = the founder's accounts; tested with a local stub IdP.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const S = require('./store');
const X = require('./samlXml');

const KEY = 'sso';
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function enc(v) { try { const SEC = require('../secrets'); return SEC.secretsConfigured() ? SEC.encryptSecret(v) : null; } catch { return null; } } // eslint-disable-line global-require
function dec(v) { try { return require('../secrets').decryptSecret(v); } catch { return null; } } // eslint-disable-line global-require
async function providers() { return (await S.settings.get(KEY, { providers: [] })).providers || []; }
const pub = (p) => ({ id: p.id, name: p.name, type: p.type });
const origin = (req) => String(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const stateSecret = () => `${process.env.JWT_SECRET || 'teamlink'}:sso-state`;

async function discovery(issuer) {
  const r = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`The provider did not answer its discovery address (${r.status}).`);
  return r.json();
}
async function userByEmail(email, p) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) return { error: 'The provider did not send an e-mail address.' };
  const domains = (p.allowedDomains || []).map((d) => d.toLowerCase());
  if (domains.length && !domains.includes(e.split('@')[1])) return { error: `${e.split('@')[1]} is not an allowed domain for ${p.name}.` };
  const users = await prisma.user.findMany({ where: { OR: [{ email: { equals: e } }, { username: { equals: e } }], role: { notIn: ['CLIENT', 'CANDIDATE'] } } });
  const u = users.find((x) => x.status === 'Active') || users[0];
  if (!u) return { error: 'No TeamLink login has this e-mail. Ask HR to add you first.' };
  return { user: u };
}

// a ticket = one finished IdP check waiting for the browser to collect its session (2 minutes, once)
const tickets = new Map();
function ticketFor(userId, providerId) {
  const t = crypto.randomBytes(24).toString('base64url');
  tickets.set(sha(t), { userId, providerId, exp: Date.now() + 120000 });
  for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
  return t;
}
async function finish(req, res, user, p) {
  await logAudit({ userId: user.id, action: `Signed in with single sign-on (${p.name})`, entity: 'User', entityId: user.id });
  return require('../../routes/auth').finishSignIn(req, res, user, { mfaPassed: true }); // eslint-disable-line global-require
}

// ------------------------------------------------------------------ SAML pieces
function samlRequest(p, acs, id) {
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${p.entryPoint}" AssertionConsumerServiceURL="${acs}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${p.spEntityId}</saml:Issuer><samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/></samlp:AuthnRequest>`;
  return zlib.deflateRawSync(Buffer.from(xml)).toString('base64');
}
function readSaml(b64, p, expectId) {
  let root;
  try { root = X.parse(Buffer.from(String(b64 || ''), 'base64').toString('utf8')); } catch (e) { return { error: `The SAML response could not be read: ${e.message}` }; }
  if (root.local !== 'Response') return { error: 'Not a SAML Response.' };
  const status = X.all(root, 'StatusCode')[0];
  const sv = status && (status.attrs.find((a) => a.name === 'Value') || {}).value;
  if (!sv || !/:Success$/.test(sv)) return { error: 'The identity provider did not sign you in.' };
  const v = X.verifySignature(root, p.idpCert || '');
  if (!v.ok) return { error: `The SAML response is not trusted: ${v.error}` };
  const a = X.all(root, 'Assertion')[0];
  const inResp = (root.attrs.find((x) => x.name === 'InResponseTo') || {}).value || ((X.all(a, 'SubjectConfirmationData')[0] || { attrs: [] }).attrs.find((x) => x.name === 'InResponseTo') || {}).value;
  if (expectId && inResp !== expectId) return { error: 'This SAML response is not an answer to our sign-in request.' };
  const cond = X.all(a, 'Conditions')[0];
  const now = Date.now(); const skew = 120000;
  if (cond) {
    const nb = (cond.attrs.find((x) => x.name === 'NotBefore') || {}).value; const na = (cond.attrs.find((x) => x.name === 'NotOnOrAfter') || {}).value;
    if (nb && new Date(nb).getTime() - skew > now) return { error: 'The SAML response is not valid yet.' };
    if (na && new Date(na).getTime() + skew <= now) return { error: 'The SAML response has expired.' };
    const aud = X.all(cond, 'Audience').map(X.text);
    if (aud.length && !aud.includes(p.spEntityId)) return { error: 'The SAML response is for another service.' };
  }
  const attrs = {};
  X.all(a, 'Attribute').forEach((at) => { const n = (at.attrs.find((x) => x.name === 'Name') || {}).value; if (n) attrs[n] = X.all(at, 'AttributeValue').map(X.text)[0]; });
  const nameId = X.text(X.all(a, 'NameID')[0] || { children: [] }).trim();
  const email = attrs[p.emailAttribute || 'email'] || attrs['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] || (nameId.includes('@') ? nameId : null);
  return { email, signed: v.signed, assertionId: X.idOf(a) };
}
const seenAssertions = new Map(); // replay: an assertion id is accepted once

// ------------------------------------------------------------------ admin routes (/api/ats-plus)
const router = express.Router();
router.get('/sso/settings', S.adminOnly, S.wrap(async (req, res) => {
  res.json({ providers: (await providers()).map((p) => ({ ...p, clientSecretEnc: undefined, hasSecret: !!p.clientSecretEnc })), redirectUri: `${origin(req)}/sso/callback`, acs: `${origin(req)}/api/sso/saml/acs`, spEntityId: `${origin(req)}/api/sso/saml/metadata` });
}));
router.put('/sso/settings', S.adminOnly, S.wrap(async (req, res) => {
  const cur = await providers();
  const list = []; const raw = Array.isArray((req.body || {}).providers) ? req.body.providers : [];
  for (const b of raw.slice(0, 6)) {
    const type = b.type === 'saml' ? 'saml' : 'oidc';
    const old = cur.find((x) => x.id === b.id) || {};
    const p = { id: old.id || S.newId('sso'), type, name: String(b.name || (type === 'saml' ? 'SAML' : 'OIDC')).slice(0, 40), enabled: !!b.enabled, allowedDomains: (Array.isArray(b.allowedDomains) ? b.allowedDomains : String(b.allowedDomains || '').split(',')).map((d) => String(d).trim().toLowerCase()).filter(Boolean).slice(0, 10) };
    if (type === 'oidc') {
      p.issuer = String(b.issuer || '').trim().replace(/\/$/, ''); p.clientId = String(b.clientId || '').trim();
      if (!/^https?:\/\//.test(p.issuer) || !p.clientId) return res.status(400).json({ error: `${p.name}: the issuer address and the client id are needed.` });
      p.clientSecretEnc = b.clientSecret ? enc(String(b.clientSecret)) : old.clientSecretEnc || null;
      if (b.clientSecret && !p.clientSecretEnc) return res.status(400).json({ error: 'Set the encryption key on the server first (secrets are never stored in plain text).' });
    } else {
      p.entryPoint = String(b.entryPoint || '').trim(); p.idpCert = String(b.idpCert || old.idpCert || '').trim(); p.spEntityId = String(b.spEntityId || `${origin(req)}/api/sso/saml/metadata`).trim(); p.emailAttribute = String(b.emailAttribute || 'email').trim();
      if (!/^https?:\/\//.test(p.entryPoint) || p.idpCert.length < 100) return res.status(400).json({ error: `${p.name}: the IdP sign-in address and its certificate are needed.` });
      try { crypto.createPublicKey(p.idpCert.includes('BEGIN') ? p.idpCert : `-----BEGIN CERTIFICATE-----\n${p.idpCert.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`); } catch (e) { return res.status(400).json({ error: `${p.name}: that is not a certificate.` }); }
    }
    list.push(p);
  }
  await S.settings.set(KEY, { providers: list }, req.user);
  await logAudit({ userId: req.user.id, action: 'Single sign-on saved', entity: 'AtsPlusSetting', entityId: KEY, toValue: list.map((p) => `${p.name} (${p.type}, ${p.enabled ? 'on' : 'off'})`).join(', ') });
  res.json({ providers: list.map((p) => ({ ...p, clientSecretEnc: undefined, hasSecret: !!p.clientSecretEnc })) });
}));

// ------------------------------------------------------------------ public routes (/api/sso)
const publicRouter = express.Router();
const { rateLimit } = require('../publicRateLimit');
publicRouter.use(rateLimit({ bucket: 'sso', max: 60, windowMs: 10 * 60000 }));
publicRouter.get('/providers', S.wrap(async (req, res) => res.json({ providers: (await providers()).filter((p) => p.enabled).map(pub) })));
publicRouter.get('/saml/metadata', S.wrap(async (req, res) => {
  const acs = `${origin(req)}/api/sso/saml/acs`;
  res.type('application/xml').send(`<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${origin(req)}/api/sso/saml/metadata"><md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`);
}));
publicRouter.get('/:id/start', S.wrap(async (req, res) => {
  const p = (await providers()).find((x) => x.id === req.params.id && x.enabled);
  if (!p) return res.status(404).json({ error: 'That sign-in is not switched on.' });
  const nonce = crypto.randomBytes(12).toString('hex');
  const reqId = `_${crypto.randomBytes(16).toString('hex')}`;
  const state = jwt.sign({ pid: p.id, nonce, reqId }, stateSecret(), { expiresIn: '10m' });
  let url;
  if (p.type === 'oidc') {
    const d = await discovery(p.issuer);
    url = `${d.authorization_endpoint}?${new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: `${origin(req)}/sso/callback`, scope: 'openid email profile', state, nonce })}`;
  } else {
    url = `${p.entryPoint}${p.entryPoint.includes('?') ? '&' : '?'}${new URLSearchParams({ SAMLRequest: samlRequest(p, `${origin(req)}/api/sso/saml/acs`, reqId), RelayState: state })}`;
  }
  if (req.query.json) return res.json({ url, state });
  return res.redirect(302, url);
}));
publicRouter.post('/oidc/finish', S.wrap(async (req, res) => {
  const b = req.body || {};
  let st; try { st = jwt.verify(String(b.state || ''), stateSecret()); } catch { return res.status(400).json({ error: 'The sign-in took too long or was not started here. Try again.' }); }
  const p = (await providers()).find((x) => x.id === st.pid && x.enabled && x.type === 'oidc');
  if (!p) return res.status(404).json({ error: 'That sign-in is not switched on.' });
  const d = await discovery(p.issuer);
  const tr = await fetch(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(b.code || ''), redirect_uri: `${origin(req)}/sso/callback`, client_id: p.clientId, ...(p.clientSecretEnc ? { client_secret: dec(p.clientSecretEnc) || '' } : {}) }), signal: AbortSignal.timeout(10000) });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.id_token) return res.status(401).json({ error: 'The provider did not confirm the sign-in.' });
  const head = jwt.decode(tj.id_token, { complete: true });
  if (!head || !['RS256', 'RS384', 'RS512', 'ES256'].includes(head.header.alg)) return res.status(401).json({ error: 'The sign-in token is not signed the expected way.' });
  const jw = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  const k = (jw.keys || []).find((x) => !head.header.kid || x.kid === head.header.kid);
  if (!k) return res.status(401).json({ error: 'The provider\'s signing key was not found.' });
  let claims;
  try { claims = jwt.verify(tj.id_token, crypto.createPublicKey({ key: k, format: 'jwk' }), { algorithms: [head.header.alg], issuer: d.issuer || p.issuer, audience: p.clientId }); } catch (e) { return res.status(401).json({ error: `The sign-in token is not valid: ${e.message}` }); }
  if (claims.nonce !== st.nonce) return res.status(401).json({ error: 'The sign-in token is not for this sign-in.' });
  if (claims.email_verified === false) return res.status(401).json({ error: 'The provider has not verified this e-mail.' });
  const u = await userByEmail(claims.email || claims.preferred_username || claims.upn, p);
  if (u.error) { await logAudit({ action: `Single sign-on refused (${p.name})`, entity: 'User', reason: u.error }); return res.status(403).json({ error: u.error }); }
  return finish(req, res, u.user, p);
}));
publicRouter.post('/saml/acs', express.urlencoded({ extended: false, limit: '1mb' }), S.wrap(async (req, res) => {
  const b = req.body || {};
  const back = (msg) => res.redirect(302, `/login?sso_error=${encodeURIComponent(msg.slice(0, 200))}`);
  let st; try { st = jwt.verify(String(b.RelayState || ''), stateSecret()); } catch { return back('The sign-in took too long or was not started here. Try again.'); }
  const p = (await providers()).find((x) => x.id === st.pid && x.enabled && x.type === 'saml');
  if (!p) return back('That sign-in is not switched on.');
  const r = readSaml(b.SAMLResponse, p, st.reqId);
  if (r.error) { await logAudit({ action: `Single sign-on refused (${p.name})`, entity: 'User', reason: r.error }); return back(r.error); }
  if (r.assertionId) { if (seenAssertions.has(r.assertionId)) return back('This sign-in answer was already used.'); seenAssertions.set(r.assertionId, Date.now()); for (const [k, v] of seenAssertions) if (Date.now() - v > 3600e3) seenAssertions.delete(k); }
  const u = await userByEmail(r.email, p);
  if (u.error) { await logAudit({ action: `Single sign-on refused (${p.name})`, entity: 'User', reason: u.error }); return back(u.error); }
  return res.redirect(302, `/sso/callback?ticket=${ticketFor(u.user.id, p.id)}`);
}));
publicRouter.post('/finish', S.wrap(async (req, res) => {
  const t = String((req.body || {}).ticket || '');
  const hit = tickets.get(sha(t));
  tickets.delete(sha(t));
  if (!hit || hit.exp < Date.now()) return res.status(400).json({ error: 'The sign-in took too long. Try again.' });
  const p = (await providers()).find((x) => x.id === hit.providerId) || { name: 'SSO' };
  const user = await prisma.user.findUnique({ where: { id: hit.userId } });
  if (!user) return res.status(400).json({ error: 'Login not found.' });
  return finish(req, res, user, p);
}));

module.exports = { router, publicRouter, readSaml, samlRequest };
