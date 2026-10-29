// ---------------------------------------------------------------------------
// Job Portal opened with the TeamLink login (utils/jobPortalSso.js, routes/jobPortalSso.js) - checks against a RUNNING backend + portal.
//
//   node scripts/job-portal-sso-test.js              (backend http://127.0.0.1:4010, embedded portal on JOB_PORTAL_PORT / 4323)
//   TL_BACKEND=http://127.0.0.1:4090 node scripts/job-portal-sso-test.js
//
// Never opens a portal session for a real person: the portal is only given tickets for an address no account has
// (zz-sso-check-<random>@teamlink.invalid), which it must ACCEPT as genuine and then refuse with "no Job Portal account".
// Read-only otherwise. Also lists the TeamLink Recruiters / TLs who have no portal recruiter with the same email.
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const prisma = require('../src/db');
const sso = require('../src/utils/jobPortalSso');

const BACKEND = String(process.env.TL_BACKEND || `http://127.0.0.1:${process.env.PORT || 4010}`).replace(/\/+$/, '');
// the browser's Origin is the site's (the portal allows it: utils/jobPortalEmbed.js EXTRA_ORIGINS)
const SITE = (() => { try { return new URL(process.env.APP_BASE_URL).origin; } catch { return BACKEND; } })();
const PORTAL = `http://127.0.0.1:${process.env.JOB_PORTAL_PORT || 4323}`;
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j, headers: r.headers };
};
const fromPortal = (claims) => {
  const iat = Math.floor(Date.now() / 1000);
  return sso.sign({ iss: 'teamlink-job-portal', aud: 'teamlink-hrms-backchannel', iat, exp: iat + 60, jti: crypto.randomUUID(), ...claims });
};

// the portal's own browser steps (web/hrms-sso.html): GET api/csrf for the cookie, then POST api/auth/hrms-sso with it
async function portalSignIn(token) {
  const c = await fetch(`${BACKEND}/jobs/api/csrf`, { cache: 'no-store' });
  const cookies = (c.headers.getSetCookie ? c.headers.getSetCookie() : [c.headers.get('set-cookie') || '']).map((x) => x.split(';')[0]).filter(Boolean);
  const csrf = (cookies.find((x) => x.startsWith('tl_csrf=')) || '').slice('tl_csrf='.length);
  return post(`${BACKEND}/jobs/api/auth/hrms-sso`, { token }, { cookie: cookies.join('; '), 'x-csrf-token': decodeURIComponent(csrf), origin: SITE });
}

(async () => {
  console.log(`backend ${BACKEND}`);
  ok('secret is there (HRMS_SSO_SECRET or derived from JWT_SECRET)', sso.secret().length >= 32);

  // 1. the portal side is switched on with TeamLink's settings
  const st = await fetch(`${BACKEND}/jobs/api/auth/hrms-sso/status`).then((r) => r.json()).catch(() => null);
  ok('portal: sign-in from TeamLink is switched on', !!(st && st.enabled), st ? `hrmsUrl ${st.hrmsUrl}` : 'portal not answering');

  // 2. a genuine ticket is accepted by the portal (then refused only because nobody has that address)
  const nobody = `zz-sso-check-${crypto.randomBytes(4).toString('hex')}@teamlink.invalid`;
  const fake = { id: 'sso-check', email: nobody, name: 'SSO check', role: 'EMPLOYEE', atsRole: 'RECRUITER' };
  const good = await portalSignIn(sso.launchToken(fake, { tms: Date.now() }));
  const gm = good.body && good.body.error ? good.body.error.message || '' : JSON.stringify(good.body);
  ok('portal accepts a TeamLink ticket (signature, issuer, audience, time)', good.status === 403 && /no Job Portal account/i.test(gm), `${good.status} ${gm}`);
  // 3. a ticket signed with another secret / a used one / garbage is refused
  const forged = (() => {
    const iat = Math.floor(Date.now() / 1000);
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = b({ alg: 'HS256', typ: 'JWT' });
    const p = b({ iss: 'teamlink-hrms', aud: 'teamlink-job-portal', sub: 'x', email: nobody, name: 'x', role: 'RECRUITER', sid: 'x.1', iat, exp: iat + 60, jti: crypto.randomUUID() });
    return `${h}.${p}.${crypto.createHmac('sha256', 'not-the-secret-not-the-secret-123456').update(`${h}.${p}`).digest('base64url')}`;
  })();
  const bad = await portalSignIn(forged);
  ok('portal refuses a ticket signed with another secret', bad.status === 401, String(bad.status));
  const once = sso.launchToken(fake, { tms: Date.now() });
  await portalSignIn(once);
  const twice = await portalSignIn(once);
  ok('portal refuses the same ticket twice', twice.status === 401, String(twice.status));

  // 4. TeamLink answers the portal's "is this sign-in still good?"
  const u = await prisma.user.findFirst({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });
  const live = await post(`${BACKEND}/api/sso/job-portal/session`, { token: fromPortal({ sid: `${u.id}.${Date.now()}` }) });
  ok('session: a fresh sign-in is active', live.status === 200 && live.body && live.body.active === true, JSON.stringify(live.body));
  const old = await post(`${BACKEND}/api/sso/job-portal/session`, { token: fromPortal({ sid: `${u.id}.${Date.now() - 9 * 3600 * 1000}` }) });
  ok('session: a sign-in older than 8 h is over', old.status === 200 && old.body && old.body.active === false, JSON.stringify(old.body));
  const nouser = await post(`${BACKEND}/api/sso/job-portal/session`, { token: fromPortal({ sid: `no-such-user.${Date.now()}` }) });
  ok('session: an unknown login is over', nouser.body && nouser.body.active === false, JSON.stringify(nouser.body));
  const badbc = await post(`${BACKEND}/api/sso/job-portal/session`, { token: 'a.b.c' });
  ok('session: a request not signed by the portal is refused', badbc.status === 401, String(badbc.status));
  const wrongAud = await post(`${BACKEND}/api/sso/job-portal/session`, { token: sso.launchToken(fake, { tms: Date.now() }) });
  ok('session: a launch ticket cannot be used as a portal request', wrongAud.status === 401, String(wrongAud.status));
  const lo = await post(`${BACKEND}/api/sso/job-portal/logout`, { token: fromPortal({ sid: `${u.id}.${Date.now()}` }) });
  ok('logout from the portal: accepted', lo.status === 200, String(lo.status));

  // 5. launch needs a TeamLink login; sign-out reaches the portal
  const anon = await post(`${BACKEND}/api/sso/job-portal/launch`, {});
  ok('launch without a TeamLink login is refused', anon.status === 401, String(anon.status));
  ok('TeamLink Sign Out reaches the portal', await sso.tellPortalSignedOut(`no-such-user.${Date.now()}`));
  ok('roles: Admin / Recruiter / TL / STL open the staff portal, BDE / HR do not',
    sso.portalRoleOf({ role: 'ADMIN' }) === 'ADMIN' && sso.portalRoleOf({ role: 'EMPLOYEE', atsRole: 'TL' }) === 'RECRUITER'
    && sso.portalRoleOf({ role: 'EMPLOYEE', atsRole: 'STL' }) === 'RECRUITER' && !sso.portalRoleOf({ role: 'EMPLOYEE', atsRole: 'BDE' })
    && !sso.portalRoleOf({ role: 'EMPLOYEE', atsRole: 'HR' }));

  // 6. who still has no portal recruiter with the same email (read-only, through the portal's own TeamLink door)
  const r = await fetch(`${PORTAL}/api/integrations/teamlink/mailboxes/recruiters`, { headers: { 'x-teamlink-token': process.env.JOB_PORTAL_SYNC_TOKEN || '' } });
  const list = r.ok ? (await r.json()).recruiters || [] : null;
  if (!list) { console.log(`\nportal recruiter list: not readable (${r.status})`); } else {
    const portal = new Map(list.map((x) => [String(x.email || '').toLowerCase(), x]));
    const users = await require('../src/utils/jobPortalRecruiters').people(); // active, not left (the same list the portal logins are made for)
    const missing = users.filter((x) => x.email && !portal.has(x.email.toLowerCase()));
    const inactive = users.filter((x) => x.email && portal.has(x.email.toLowerCase()) && !portal.get(x.email.toLowerCase()).active);
    console.log(`\nTeamLink Recruiters / TLs / STLs (active): ${users.length}; with a portal recruiter of the same email: ${users.length - missing.length}`);
    if (missing.length) console.log(`no portal account (${missing.length}):\n${missing.map((x) => `  - ${x.name} (${x.atsRole}) ${x.email}`).join('\n')}`);
    if (inactive.length) console.log(`portal account not active (${inactive.length}):\n${inactive.map((x) => `  - ${x.name} ${x.email}`).join('\n')}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
