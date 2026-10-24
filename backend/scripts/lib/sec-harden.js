// Item 9: hardening extras - rate limits, token lifetime / invalidation, headers + CORS, exports, uploads, audit rows.
module.exports = async function secHarden(ctx) {
  const {
    check, call, mkUser, mint, made, prisma, RUN, API, BACK,
  } = ctx;
  console.log('\n--- 9: hardening ---');
  const jwt = require('jsonwebtoken');

  // ---------------- rate limiter (unit: fake clock) ----------------
  const RL = require(`${BACK}/src/utils/apiRateLimit`);
  {
    let t = 1000000;
    const L = RL.makeLimiter({ now: () => t, userMax: 600, ipMax: 120, windowMs: 60000 });
    let over = null;
    for (let i = 0; i < 600; i += 1) over = L.check({ method: 'GET', path: '/api/candidates', userId: 'u1', ip: '1.1.1.1' }) || over;
    check('600 requests / minute for one login are allowed', over === null);
    const r601 = L.check({ method: 'GET', path: '/api/candidates', userId: 'u1', ip: '1.1.1.1' });
    check('the 601st request of one login in a minute is refused', !!r601 && r601.retryAfter >= 1 && r601.retryAfter <= 60, r601);
    check('another login on the same address is not throttled by it', L.check({ method: 'GET', path: '/api/x', userId: 'u2', ip: '1.1.1.1' }) === null);
    t += 61000;
    check('the window resets after a minute', L.check({ method: 'GET', path: '/api/candidates', userId: 'u1', ip: '1.1.1.1' }) === null);
    let a = null;
    for (let i = 0; i < 120; i += 1) a = L.check({ method: 'GET', path: '/api/public/jobs', userId: null, ip: '9.9.9.9' }) || a;
    check('120 anonymous requests / minute per IP are allowed', a === null);
    check('the 121st anonymous request from one IP is refused', !!L.check({ method: 'GET', path: '/api/public/jobs', userId: null, ip: '9.9.9.9' }));
    check('another IP is not affected', L.check({ method: 'GET', path: '/api/public/jobs', userId: null, ip: '9.9.9.10' }) === null);
    let lg = null;
    for (let i = 0; i < 20; i += 1) lg = L.check({ method: 'POST', path: '/api/auth/login', userId: null, ip: '8.8.8.8' }) || lg;
    check('20 sign-in tries / minute per IP are allowed', lg === null);
    const l21 = L.check({ method: 'POST', path: '/api/auth/login', userId: null, ip: '8.8.8.8' });
    check('the 21st sign-in try in a minute is refused (stricter than the general limit)', !!l21 && l21.bucket === 'login', l21);
    let ex = null;
    for (let i = 0; i < 30; i += 1) ex = L.check({ method: 'GET', path: '/api/employees/export.xlsx', userId: 'u3', ip: '2.2.2.2' }) || ex;
    check('30 exports / minute are allowed', ex === null);
    const e31 = L.check({ method: 'GET', path: '/api/employees/export.csv', userId: 'u3', ip: '2.2.2.2' });
    check('the 31st export in a minute is refused', !!e31 && e31.bucket === 'export', e31);
    let bk = null;
    for (let i = 0; i < 20; i += 1) bk = L.check({ method: 'POST', path: '/api/messaging/bulk-send', userId: 'u4', ip: '3.3.3.3' }) || bk;
    check('20 bulk sends / minute are allowed', bk === null);
    check('the 21st bulk send in a minute is refused', L.check({ method: 'POST', path: '/api/messaging/bulk-send', userId: 'u4', ip: '3.3.3.3' }) !== null);
    let rs = null;
    for (let i = 0; i < 10; i += 1) rs = L.check({ method: 'POST', path: '/api/auth/forgot-password', userId: null, ip: '4.4.4.4' }) || rs;
    check('the 11th password-reset request in a minute from one IP is refused', rs === null && !!L.check({ method: 'POST', path: '/api/auth/forgot-password', userId: null, ip: '4.4.4.4' }));
  }
  // the middleware: 429 body is plain words + Retry-After, health / non-api / OPTIONS are skipped
  {
    process.env.TL_RATE_LIMIT_IN_TEST = '1'; // this test process runs on the sandbox database, where the limiter is off unless told otherwise
    RL.limiter.reset();
    const mk = (path, method = 'GET', ip = '5.5.5.5') => ({ method, originalUrl: path, url: path, headers: {}, socket: { remoteAddress: ip } });
    const res = () => { const o = { code: null, body: null, headers: {} }; o.set = (k, v) => { o.headers[k] = v; return o; }; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; return o; }; return o; };
    let nexted = 0;
    for (let i = 0; i < 125; i += 1) RL.apiRateLimit(mk('/api/public/jobs'), res(), () => { nexted += 1; });
    const r = res();
    RL.apiRateLimit(mk('/api/public/jobs'), r, () => { nexted += 1; });
    check('middleware: after 120 anonymous calls the answer is 429 with a plain sentence and Retry-After', r.code === 429 && /Please wait \d+ second/.test(r.body.error) && !!r.headers['Retry-After'] && nexted === 120, `${r.code} ${nexted}`);
    let skipped = 0;
    for (let i = 0; i < 300; i += 1) {
      RL.apiRateLimit(mk('/api/health'), res(), () => { skipped += 1; });
      RL.apiRateLimit(mk('/uploads/x.png'), res(), () => { skipped += 1; });
      RL.apiRateLimit(mk('/api/employees', 'OPTIONS'), res(), () => { skipped += 1; });
    }
    check('middleware: /api/health, non-API paths and OPTIONS are never limited', skipped === 900, skipped);
    RL.limiter.reset();
  }

  // ---------------- tokens: expiry, disable, role change ----------------
  const u = await mkUser('HdUser', { role: 'TL', hrmsRole: 'TL', atsRole: 'TL', atsAccess: true, atsDepartment: 'Educational', atsScopeDepartments: 'Educational' }, { designation: 'TL' });
  const tok = await mint(u.u);
  const claims = jwt.decode(tok);
  check('staff session tokens are signed with the staff secret and carry an expiry', !!claims.exp && claims.exp - claims.iat <= 8 * 3600 + 5, claims.exp - claims.iat);
  const src = require('fs').readFileSync(`${BACK}/src/routes/auth.js`, 'utf8');
  check('sign-in issues 8-hour tokens', /expiresIn: '8h'/.test(src));
  let r = await call('GET', '/api/auth/me', tok);
  check('a valid token works', r.status === 200, r.status);
  await prisma.user.update({ where: { id: u.u.id }, data: { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false } });
  r = await call('GET', '/api/auth/me', tok);
  check('after a role change the SAME token sees the new role at once (identity is re-read per request)', r.status === 200 && r.body.role === 'EMPLOYEE', `${r.status} ${r.body && r.body.role}`);
  await prisma.user.update({ where: { id: u.u.id }, data: { status: 'Inactive' } });
  r = await call('GET', '/api/auth/me', tok);
  check('after the login is switched off the same token is refused', r.status === 403 || r.status === 401, r.status);
  const u2 = await mkUser('HdUser2', {}, { designation: 'Employee' });
  const tok2 = await mint(u2.u);
  await prisma.user.update({ where: { id: u2.u.id }, data: { passwordChangedAt: new Date(Date.now() + 5000) } });
  r = await call('GET', '/api/auth/me', tok2);
  check('after a password change an older token is refused', r.status === 401, r.status);

  // ---------------- headers and CORS ----------------
  r = await call('GET', '/api/health');
  const h = (k) => r.headers.get(k);
  check('security headers are on API answers (nosniff, frame, referrer)', h('x-content-type-options') === 'nosniff' && !!h('x-frame-options') && !!h('referrer-policy') && !h('x-powered-by'), [...r.headers.keys()].join(','));
  const evil = await call('GET', '/api/auth/me', await mint(u.u), undefined, { headers: { Origin: 'https://evil.example' } });
  check('an unknown web origin gets no CORS permission on an API route', !evil.headers.get('access-control-allow-origin'), evil.headers.get('access-control-allow-origin'));
};
