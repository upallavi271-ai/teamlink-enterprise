// Facebook 'Connect' return trip (2026-10-30): the browser comes back to the address it started from, on the Facebook tab, and the token
// exchange uses the same redirect address - with a stand-in Facebook, on a COPY of the database:
//   node scripts/facebook-connect-return-test.js <copy.db>      (make the copy with VACUUM INTO; dev.db itself is never used)
const B = require('path').resolve(__dirname, '..').split(require('path').sep).join('/');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
if (!process.argv[2] || /dev.db$/.test(process.argv[2])) { console.error('Give a COPY of the database'); process.exit(2); }
process.env.DATABASE_URL = 'file:' + process.argv[2];
process.env.FACEBOOK_APP_ID = '111'; process.env.FACEBOOK_APP_SECRET = 'sec';
const http = require('http'); const express = require(B + '/node_modules/express'); const jwt = require(B + '/node_modules/jsonwebtoken');
const seen = [];
const fb = http.createServer((req, res) => { seen.push(req.url); res.setHeader('content-type', 'application/json');
  if (req.url.includes('/oauth/access_token')) return res.end(JSON.stringify({ access_token: 'tok' }));
  if (req.url.includes('/me/accounts')) return res.end(JSON.stringify({ data: [{ id: '987', name: 'TeamLink Page', access_token: 'ptok' }] }));
  res.end('{}'); });
(async () => {
  await new Promise((r) => fb.listen(48901, '127.0.0.1', r));
  process.env.TL_FACEBOOK_GRAPH_BASE = 'http://127.0.0.1:48901';
  const prisma = require(B + '/src/db'); const FBC = require(B + '/src/utils/facebookConnect');
  const u = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  const app = express(); app.use('/api/public/facebook-connect', FBC.router);
  const srv = await new Promise((r) => { const s = app.listen(48902, '127.0.0.1', () => r(s)); });
  let pass = 0, fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); c ? pass++ : fail++; };
  // start as the live site would: the browser's Origin
  const st = await FBC.start(u, { headers: { origin: 'https://teamlink.teamlinks.in' }, get: () => 'teamlink.teamlinks.in', protocol: 'https' });
  ok('start sends Facebook the live address', decodeURIComponent(st.url).includes('redirect_uri=https://teamlink.teamlinks.in/api/public/facebook-connect/callback'));
  const state = new URL(st.url).searchParams.get('state');
  // Facebook comes back through nginx: no Origin, inner Host
  const r = await fetch(`http://127.0.0.1:48902/api/public/facebook-connect/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { host: '127.0.0.1:4010' } });
  const loc = r.headers.get('location') || '';
  ok('comes back to the live site, Facebook tab, Page pick', r.status === 302 && loc.startsWith('https://teamlink.teamlinks.in/admin/integrations?tab=facebook&facebook=pick&k='));
  const ex = seen.find((x) => x.includes('/oauth/access_token') && x.includes('code=abc'));
  ok('token exchange uses the SAME address Facebook was given', ex && decodeURIComponent(ex).includes('redirect_uri=https://teamlink.teamlinks.in/api/public/facebook-connect/callback'));
  const r2 = await fetch(`http://127.0.0.1:48902/api/public/facebook-connect/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  ok('cancelled sign-in also comes back to the Facebook tab', (r2.headers.get('location') || '').startsWith('https://teamlink.teamlinks.in/admin/integrations?tab=facebook&facebook=denied'));
  const bad = jwt.sign({ k: 'fbconnect', u: u.id, b: 'javascript:alert(1)' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const r3 = await fetch(`http://127.0.0.1:48902/api/public/facebook-connect/callback?error=x&state=${encodeURIComponent(bad)}`, { redirect: 'manual', headers: { host: 'teamlink.teamlinks.in' } });
  ok('a strange address in the state is not followed', !(r3.headers.get('location') || '').startsWith('javascript'));
  console.log(`SUMMARY pass=${pass} fail=${fail}`); srv.close(); fb.close(); await prisma.$disconnect(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
