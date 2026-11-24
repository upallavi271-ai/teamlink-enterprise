// ---------------------------------------------------------------------------
// SINGLE SIGN-ON: "TEST THIS PROVIDER" (market benchmark 15.01, ATS wave 2 Z 2026-11-25). The sign-in itself (OIDC + SAML 2.0, checked
// against a stub IdP) is utils/atsPlus/sso.js. Before an Admin switches a provider on for the login page, this checks what can be
// checked without anyone signing in:
//   OIDC  the discovery document answers, has the authorization / token / JWKS addresses, its issuer is the one typed, and the JWKS has
//         signing keys; a client secret is saved (encrypted).
//   SAML  the IdP certificate is a real X.509 certificate, how many days it is still valid, the sign-in address is https, the SP
//         entity ID / ACS the IdP must know.
//   POST /api/ats-plus/sso/:id/test   (Admin)   -> { ok, checks: [{ name, ok, detail }] }
// In the sandbox only a local stub IdP is called.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const S = require('./store');

const isLoopback = (u) => /^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(String(u || ''));
async function getJson(url) {
  if (S.sandbox() && !isLoopback(url)) return { error: 'SANDBOX - not called' };
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { error: `answered ${r.status}` };
    return { body: await r.json() };
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}
async function testOidc(p) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || null });
  add('Issuer address', /^https:\/\//.test(p.issuer) || (S.sandbox() && isLoopback(p.issuer)), p.issuer);
  add('Client ID', !!p.clientId, p.clientId ? 'typed' : 'missing');
  add('Client secret', !!p.clientSecretEnc, p.clientSecretEnc ? 'saved (encrypted)' : 'not saved - most providers need it for the code exchange');
  const d = await getJson(`${String(p.issuer || '').replace(/\/$/, '')}/.well-known/openid-configuration`);
  add('Discovery document', !d.error, d.error || 'answers');
  if (!d.error) {
    const b = d.body || {};
    add('Sign-in, token and key addresses', !!(b.authorization_endpoint && b.token_endpoint && b.jwks_uri), [b.authorization_endpoint, b.token_endpoint, b.jwks_uri].filter(Boolean).length === 3 ? 'all three are there' : 'one is missing');
    add('Issuer matches', String(b.issuer || '').replace(/\/$/, '') === String(p.issuer || '').replace(/\/$/, ''), b.issuer || 'none given');
    if (b.jwks_uri) {
      const j = await getJson(b.jwks_uri);
      const keys = ((j.body && j.body.keys) || []).filter((k) => !k.use || k.use === 'sig');
      add('Signing keys', !j.error && keys.length > 0, j.error || `${keys.length} key(s)`);
    }
  }
  return checks;
}
function testSaml(p, origin) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || null });
  add('IdP sign-in address', /^https:\/\//.test(p.entryPoint || '') || (S.sandbox() && isLoopback(p.entryPoint)), p.entryPoint || 'missing');
  try {
    const pem = String(p.idpCert || '').includes('BEGIN') ? p.idpCert : `-----BEGIN CERTIFICATE-----\n${String(p.idpCert || '').replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
    const x = new crypto.X509Certificate(pem);
    const left = Math.floor((new Date(x.validTo).getTime() - Date.now()) / 86400000);
    add('IdP certificate', left > 0, `${x.subject.split('\n').find((l) => l.startsWith('CN=')) || x.subject.split('\n')[0]}; valid until ${new Date(x.validTo).toISOString().slice(0, 10)} (${left} days)`);
    add('Certificate not ending soon', left > 30, left > 30 ? 'more than 30 days left' : 'ask the IdP for the new certificate now');
  } catch (e) { add('IdP certificate', false, 'not a readable X.509 certificate'); }
  add('Our entity ID', !!p.spEntityId, p.spEntityId);
  add('Our ACS address (give it to the IdP)', true, `${origin}/api/sso/saml/acs`);
  return checks;
}

const router = express.Router();
router.post('/sso/:id/test', S.adminOnly, S.wrap(async (req, res) => {
  const list = (await S.settings.get('sso', { providers: [] })).providers || [];
  const p = list.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Save the provider first.' });
  const origin = String(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const checks = p.type === 'saml' ? testSaml(p, origin) : await testOidc(p);
  res.json({ ok: checks.every((c) => c.ok), provider: { id: p.id, name: p.name, type: p.type, enabled: !!p.enabled }, checks, note: 'A real sign-in also needs your login e-mail to be on an active TeamLink login. Switch "on the login page" only when this passes.' });
}));

module.exports = { router, testOidc, testSaml };
