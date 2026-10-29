// ---------------------------------------------------------------------------
// JOB PORTAL WITHOUT A SECOND LOGIN (founder 2026-10-29: "job portal kuda elane hrms logins to direct login avali recruiters ni separate
// logins adagakudadhu").
//
// The Job Portal (job-portal-app/job_portal-main, kept as supplied) already has "Single sign-on from TeamLink HRMS"
// (its docs/HRMS-SSO.md, api/src/sso/hrms.js, web/hrms-sso.html). This is TeamLink's half of that contract:
//   launch     POST /api/sso/job-portal/launch (signed in): a 60 s, single-use HS256 token
//              { iss 'teamlink-hrms', aud 'teamlink-job-portal', sub, email, name, role, sid, iat, exp, jti }
//              -> the browser goes to /jobs/hrms-sso.html#token=...&next=... and the portal opens ITS OWN session for the portal
//              account with the SAME email (it never creates one: an Admin adds the recruiter in the portal once).
//   session    POST /api/sso/job-portal/session (server to server, token aud 'teamlink-hrms-backchannel'): the portal asks once a minute
//              whether the TeamLink sign-in behind its session is still good. sid = "<user id>.<sign-in ms>", so the answer re-uses
//              the checks every TeamLink request makes: the login is active, has not left, its password was not changed and an Admin
//              did not sign it out since, and the sign-in is younger than 8 hours (the TeamLink token's life).
//   logout     POST /api/sso/job-portal/logout (portal -> TeamLink): TeamLink sign-ins live in the browser, nothing to end here.
//   signout    POST /api/sso/job-portal/signout (signed in, TeamLink Sign Out): tells the portal to end the sessions of this sign-in.
// Roles: Super Admin / Admin -> portal admin; an ATS Recruiter / TL / STL -> portal recruiter. Anyone else opens the public portal.
// The secret: HRMS_SSO_SECRET when set, else one DERIVED from JWT_SECRET (never JWT_SECRET itself), so it works without any setup;
// utils/jobPortalEmbed.js hands the same value to the embedded portal. Never logged.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const ISS = 'teamlink-hrms';
const AUD = 'teamlink-job-portal';
const AUD_TO_PORTAL = 'teamlink-job-portal-backchannel'; // TeamLink -> portal
const AUD_FROM_PORTAL = 'teamlink-hrms-backchannel';     // portal -> TeamLink
const SIGN_IN_LIFE_MS = 8 * 3600 * 1000;
const ATS_RECRUITER_ROLES = new Set(['RECRUITER', 'TL', 'STL']);

function secret() {
  const own = String(process.env.HRMS_SSO_SECRET || '');
  if (own.length >= 32) return own;
  const base = String(process.env.JWT_SECRET || '');
  if (!base) return '';
  return crypto.createHmac('sha256', base).update('teamlink job portal sso v1').digest('hex');
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const s = secret();
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  return `${h}.${p}.${crypto.createHmac('sha256', s).update(`${h}.${p}`).digest('base64url')}`;
}
function verify(token, aud) {
  const s = secret();
  const parts = String(token || '').split('.');
  if (!s || parts.length !== 3) return null;
  let head; let claims;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
  if (!head || head.alg !== 'HS256' || !claims) return null;
  const want = crypto.createHmac('sha256', s).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== aud || claims.iss !== 'teamlink-job-portal') return null;
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp - claims.iat > 60 || claims.exp + 30 <= now || claims.iat > now + 30) return null;
  return claims;
}

// The portal role code for this login, or '' (no Job Portal staff access).
function portalRoleOf(user) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return role;
  const ats = String((user && user.atsRole) || '').toUpperCase();
  if (ATS_RECRUITER_ROLES.has(ats) || role === 'RECRUITER') return 'RECRUITER';
  return '';
}

// sid = "<user id>.<sign-in ms>": the TeamLink sign-in this portal session belongs to.
function sidOf(user, claims) {
  const issued = Number(claims && claims.tms) || (Number(claims && claims.iat) || 0) * 1000;
  return `${user.id}.${issued}`;
}
function parseSid(sid) {
  const m = /^(.+)\.(\d{10,})$/.exec(String(sid || ''));
  return m ? { id: m[1], issued: Number(m[2]) } : null;
}

function launchToken(user, claims) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: ISS, aud: AUD, sub: String(user.id), email: String(user.email || '').toLowerCase(), name: user.name || '',
    role: portalRoleOf(user), sid: sidOf(user, claims), iat, exp: iat + 60, jti: crypto.randomUUID(),
  });
}

// Is the TeamLink sign-in behind this sid still good? The same checks requireAuth makes on every request.
async function signInIsLive(sid) {
  const s = parseSid(sid);
  if (!s || Date.now() - s.issued > SIGN_IN_LIFE_MS) return false;
  /* eslint-disable global-require */
  const { resolveIdentity } = require('./identity');
  const identity = await resolveIdentity(s.id).catch(() => null);
  if (!identity || (identity.status && identity.status !== 'Active')) return false;
  if (require('./leftLogin').hasLeft(identity)) return false;
  const claims = { id: s.id, iat: Math.floor(s.issued / 1000), tms: s.issued };
  if (await require('./passwordReset').tokenIsStale(claims)) return false;
  if (await require('./loginAccounts').tokenIsRevoked(claims)) return false;
  /* eslint-enable global-require */
  return true;
}

// TeamLink Sign Out: end the portal sessions of this sign-in. Never throws.
async function tellPortalSignedOut(sid) {
  try {
    const base = require('./jobPortalEmbed').internalUrl(); // eslint-disable-line global-require
    if (!base || !secret()) return false;
    const iat = Math.floor(Date.now() / 1000);
    const token = sign({ iss: ISS, aud: AUD_TO_PORTAL, sid, iat, exp: iat + 60, jti: crypto.randomUUID() });
    const r = await fetch(`${String(base).replace(/\/+$/, '')}/api/auth/hrms-sso/logout`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch { return false; }
}

module.exports = { secret, sign, verify, portalRoleOf, sidOf, parseSid, launchToken, signInIsLive, tellPortalSignedOut, AUD_FROM_PORTAL };
