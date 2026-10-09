// ---------------------------------------------------------------------------
// SINGLE SIGN-ON TO THE TEAMLINK JOB PORTAL (2026-10-09) — the HRMS side.
//
// The Job Portal is a separate application with its own sessions (an httpOnly
// cookie on its own origin, or under /jobs when embedded). "Job Portal" in the
// sidebar therefore hands the user over with a SIGNED, SHORT-LIVED TOKEN:
//
//   HS256 with HRMS_SSO_SECRET (the same value in the portal's environment)
//   iss "teamlink-hrms", aud "teamlink-job-portal", exp = iat + 60 s
//   jti  random — the portal records it and refuses a second use
//   sub, name, email, role (the HRMS role that grants access), sid (this
//   sign-in's AuthSession, so the two apps share one session)
//
// It travels in the URL FRAGMENT of <portal>/hrms-sso.html — never in a query
// string, a server log or a Referer — and that page removes it from the
// address bar before doing anything else. No password and no long-lived token
// ever leaves this server.
//
// Who may open the portal (spec: "Recruiter and Admin"):
//   Super Admin / Admin  -> portal Admin
//   ATS role Recruiter   -> portal Recruiter
//   anybody else         -> no "Job Portal" item, and Access denied if they
//                           open /sso/job-portal anyway
//
// The back channel (server to server, both directions) uses the same secret
// with its own audiences, so a launch token can never be replayed as one:
//   portal -> HRMS  aud "teamlink-hrms-backchannel"        (routes/sso.js)
//   HRMS -> portal  aud "teamlink-job-portal-backchannel"  (notifyPortalLogout)
// Contract: job portal repo, docs/HRMS-SSO.md. Never logged: tokens, secret.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISS = 'teamlink-hrms';
const AUD = 'teamlink-job-portal';
const AUD_TO_PORTAL = 'teamlink-job-portal-backchannel';
const AUD_FROM_PORTAL = 'teamlink-hrms-backchannel';
const PORTAL_ISS = 'teamlink-job-portal';
const LIFETIME_S = 60;

const secret = () => process.env.HRMS_SSO_SECRET || '';
const configured = () => secret().length >= 32;
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const bridge = () => require('./jobPortalBridge');

// The portal's address in the BROWSER (JOB_PORTAL_PUBLIC_URL, or <site>/jobs).
const portalPublicUrl = () => trimSlash(bridge().portalUrl());
// …and from THIS SERVER (the embedded portal's internal port, or JOB_PORTAL_API_URL).
const portalApiUrl = () => trimSlash(process.env.JOB_PORTAL_API_URL || require('./jobPortalEmbed').internalUrl());

/** The HRMS role that opens the Job Portal for this login, or null. */
function jobPortalRoleFor(identity) {
  if (!identity) return null;
  const roles = [identity.role, identity.hrmsRole, identity.atsRole].filter(Boolean);
  if (roles.includes('SUPER_ADMIN')) return 'SUPER_ADMIN';
  if (roles.includes('ADMIN')) return 'ADMIN';
  if (identity.atsRole === 'RECRUITER' && identity.products && identity.products.ats) return 'RECRUITER';
  return null;
}

/** What /auth/me tells the browser (the sidebar item, the launch page). */
function accessFor(identity) {
  const role = jobPortalRoleFor(identity);
  return { allowed: !!role && configured(), role: role || null, configured: configured() };
}

/** Only a portal page of the kind this role may open (the portal checks again). */
function safeNext(next) {
  const s = String(next || '').trim();
  return /^#\/(recruiter|admin)(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.+]*)?$/.test(s) ? s : '';
}

/** The launch URL: <portal>/hrms-sso.html#token=…&next=… */
function launchUrl(identity, sid, next) {
  const role = jobPortalRoleFor(identity);
  if (!role || !configured() || !sid) return null;
  const token = jwt.sign({
    sub: String(identity.id),
    name: identity.name || '',
    email: String(identity.email || '').toLowerCase(),
    role,
    sid: String(sid),
    jti: crypto.randomUUID(),
  }, secret(), { algorithm: 'HS256', expiresIn: LIFETIME_S, issuer: ISS, audience: AUD });
  const n = safeNext(next);
  return `${portalPublicUrl()}/hrms-sso.html#token=${encodeURIComponent(token)}${n ? `&next=${encodeURIComponent(n)}` : ''}`;
}

/** A call FROM the portal (session check / logout). Throws on anything wrong. */
function verifyFromPortal(token) {
  if (!configured()) throw new Error('not configured');
  const claims = jwt.verify(String(token || ''), secret(), {
    algorithms: ['HS256'], issuer: PORTAL_ISS, audience: AUD_FROM_PORTAL, maxAge: `${LIFETIME_S + 30}s`,
  });
  if (!claims.sid || typeof claims.sid !== 'string') throw new Error('no sid');
  return claims;
}

/** Signing out here ends the portal sessions of this sign-in. Never throws. */
async function notifyPortalLogout(sid) {
  if (!configured() || !sid) return false;
  const token = jwt.sign({ sid: String(sid), jti: crypto.randomUUID() }, secret(), {
    algorithm: 'HS256', expiresIn: LIFETIME_S, issuer: ISS, audience: AUD_TO_PORTAL,
  });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${portalApiUrl()}/api/auth/hrms-sso/logout`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: ctl.signal,
    });
    return r.ok;
  } catch {
    return false;   // the portal also asks us within a minute, and hears "ended"
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  ISS, AUD, AUD_TO_PORTAL, AUD_FROM_PORTAL, LIFETIME_S,
  configured, jobPortalRoleFor, accessFor, safeNext, launchUrl, verifyFromPortal, notifyPortalLogout, portalPublicUrl,
};
