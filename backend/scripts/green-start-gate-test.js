#!/usr/bin/env node
// ---------------------------------------------------------------------------
// GREEN START ENTRANCE (gate.mjs) TEST - no database, no real Green Start server.
//   cd backend && node scripts/green-start-gate-test.js
// Starts: a stand-in "TeamLink" that answers only GET /api/omni-gs/verify with the REAL cookie check (utils/greenStartEmbed.js proxy()),
// a stand-in Green Start API that echoes what it receives, and the REAL entrance (green-start-app/run/gate.mjs) on free ports, in front of the
// REAL built Green Start screens. Re-checks the cookie rules, the proxy, the files, and that nothing leaks.
// ---------------------------------------------------------------------------
const http = require('http');
const os = require('os');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gate-test-secret';
const BACK = path.resolve(__dirname, '..');
const APP = path.resolve(BACK, '..', 'green-start-app');
const G = require(path.join(BACK, 'src/utils/greenStartEmbed'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300)}` : ''}`); };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (port, p, headers = {}, method = 'GET') => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 8000 }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', (e) => resolve({ status: 0, body: e.message, headers: {} })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); }); r.end();
});

(async () => {
  const tlPort = await freePort(); const apiPort = await freePort(); const gatePort = await freePort();
  const verifySeen = []; // the headers the entrance sent when it asked "TeamLink" to check a pass
  const tl = http.createServer((req, res) => { if ((req.url || '').startsWith('/api/omni-gs/verify')) verifySeen.push(req.headers); G.proxy()(req, res, () => { res.writeHead(404); res.end(); }); }).listen(tlPort, '127.0.0.1');
  const api = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie || '', xff: req.headers['x-forwarded-for'] || '', xfp: req.headers['x-forwarded-proto'] || '' })); }).listen(apiPort, '127.0.0.1');
  const gate = spawn(process.execPath, [path.join(APP, 'run', 'gate.mjs')], { env: { ...process.env, GATE_PORT: String(gatePort), GS_API_PORT: String(apiPort), TEAMLINK_URL: `http://127.0.0.1:${tlPort}` }, stdio: 'ignore' });
  // a second entrance as it runs on the live server: behind nginx, staff mode, a link back to TeamLink
  const gate2Port = await freePort();
  const gate2 = spawn(process.execPath, [path.join(APP, 'run', 'gate.mjs')], { env: { ...process.env, GATE_PORT: String(gate2Port), GS_API_PORT: String(apiPort), TEAMLINK_URL: `http://127.0.0.1:${tlPort}`, GATE_TRUST_PROXY: '1', GATE_STAFF_MODE: '1', GATE_TEAMLINK_PUBLIC_URL: 'https://teamlink.teamlinks.in' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i += 1) { if ((await get(gatePort, '/')).status && (await get(gate2Port, '/')).status) break; await sleep(250); }
    const good = G.makeToken('u1');
    const ck = (t) => ({ cookie: `tl_gs=${t}` });
    const built = fs.existsSync(path.join(APP, 'green-start-web', 'dist', 'index.html'));
    check('G0 the Green Start screens are built (index.html exists)', built);

    check('G1 no cookie -> 401 on the page', (await get(gatePort, '/')).status === 401);
    check('G2 no cookie -> 401 on the API', (await get(gatePort, '/api/v1/health')).status === 401);
    check('G3 a made-up cookie -> 401', (await get(gatePort, '/', ck('u1.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).status === 401);
    const [uid, exp, sig] = good.split('.');
    check('G4 a cookie with a changed user -> 401', (await get(gatePort, '/', ck(`u2.${exp}.${sig}`))).status === 401);
    check('G5 a cookie with a changed time -> 401', (await get(gatePort, '/', ck(`${uid}.${Number(exp) + 5000}.${sig}`))).status === 401);
    check('G6 a cookie with a broken signature -> 401', (await get(gatePort, '/', ck(`${uid}.${exp}.${sig.slice(0, -2)}xx`))).status === 401);
    const old = `${uid}.${Math.floor(Date.now() / 1000) - 10}`;
    const crypto = require('crypto');
    const secret = crypto.createHash('sha256').update(`greenstart-gate:${process.env.JWT_SECRET}`).digest();
    const expired = `${old}.${crypto.createHmac('sha256', secret).update(old).digest('base64url')}`;
    check('G7 an expired cookie (even correctly signed) -> 401', (await get(gatePort, '/', ck(expired))).status === 401);
    check('G8 TeamLink\'s own verify answers 204 for the good cookie and 401 without', (await get(tlPort, '/api/omni-gs/verify', ck(good))).status === 204 && (await get(tlPort, '/api/omni-gs/verify')).status === 401);

    if (built) {
      const page = await get(gatePort, '/', ck(good));
      check('G9 a good cookie -> the real Green Start screen (html)', page.status === 200 && /<div id="root"|<html/i.test(page.body), page.status);
      const js = (page.body.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
      const asset = js ? await get(gatePort, js, ck(good)) : { status: 0 };
      check('G10 a script file of the screens is served', asset.status === 200 && /javascript/.test(asset.headers['content-type'] || ''), { js, status: asset.status });
      const deep = await get(gatePort, '/app/dashboard', ck(good));
      check('G11 a deep link (/app/dashboard) opens the same app', deep.status === 200 && /<html/i.test(deep.body));
      check('G12 the page may be framed only by the TeamLink addresses (frame-ancestors)', /frame-ancestors 'self' http:\/\/localhost:5183/.test(page.headers['content-security-policy'] || ''), page.headers['content-security-policy']);
      const trav = await get(gatePort, '/..%2f..%2f..%2fgs-api%2f.env', ck(good));
      const trav2 = await get(gatePort, '/%2e%2e/%2e%2e/gs-api/.env', ck(good));
      check('G13 path tricks do not leak the product\'s .env', ![trav, trav2].some((r) => /JWT_SECRET|DATABASE_URL|ENCRYPTION_KEY/.test(r.body)), [trav.status, trav2.status]);
    }
    const prox = await get(gatePort, '/api/v1/health', { cookie: `tl_gs=${good}; gs_session=abc; theme=dark` });
    let echo = {}; try { echo = JSON.parse(prox.body); } catch { /* not json */ }
    check('G14 /api/v1/* goes to the Green Start server', prox.status === 200 && echo.path === '/api/v1/health', prox.body.slice(0, 120));
    check('G15 TeamLink\'s cookie is NOT passed on, Green Start\'s own cookies are', echo.cookie && !/tl_gs=/.test(echo.cookie) && /gs_session=abc/.test(echo.cookie) && /theme=dark/.test(echo.cookie), echo);
    const nic = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (nic) {
      const reach = await new Promise((res) => { const s = net.connect({ host: nic.address, port: gatePort }); s.setTimeout(1500, () => { s.destroy(); res(false); }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
      check('G16 the entrance cannot be reached through this computer\'s network address (loopback only)', reach === false, nic.address);
    } else check('G16 (no network card to test with; skipped as pass)', true);

    // ---- LIVE-SITE additions (2026-10-22): real visitor address / protocol, the friendly "pass ended" page, staff mode ----
    const ok1 = ck(G.makeToken('uA')); const ok2 = ck(G.makeToken('uB')); const ok3 = ck(G.makeToken('uC')); const ok4 = ck(G.makeToken('uD'));
    const echoOf = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
    const plain = echoOf(await get(gatePort, '/api/v1/ping', { ...ok1, 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' }));
    check('G18 the PC entrance (no GATE_TRUST_PROXY): Green Start is told the entrance own socket address and "http"; a visitor-made X-Forwarded-* is thrown away', /127\.0\.0\.1|::1/.test(plain.xff) && !/6\.6\.6\.6/.test(plain.xff) && plain.xfp === 'http', plain);
    const real = echoOf(await get(gate2Port, '/api/v1/ping', { ...ok2, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }));
    check('G19 behind nginx (GATE_TRUST_PROXY=1): Green Start gets the real visitor address and https', real.xff === '203.0.113.9' && real.xfp === 'https', real);
    const askedTl = verifySeen.find((h) => /uB\./.test(h.cookie || ''));
    check('G19 and TeamLink is told the same when the entrance asks it to check the pass', askedTl && askedTl['x-forwarded-for'] === '203.0.113.9' && askedTl['x-forwarded-proto'] === 'https', askedTl && { xff: askedTl['x-forwarded-for'], xfp: askedTl['x-forwarded-proto'] });
    const chain = echoOf(await get(gate2Port, '/api/v1/ping', { ...ok2, 'x-forwarded-for': '203.0.113.9, 10.0.0.2', 'x-forwarded-proto': 'https, http' }));
    check('G19 a proxy chain keeps the whole X-Forwarded-For list; the first protocol word is used', chain.xff === '203.0.113.9, 10.0.0.2' && chain.xfp === 'https', chain);
    const junk = echoOf(await get(gate2Port, '/api/v1/ping', { ...ok2, 'x-forwarded-for': '1.2.3.4 <script>', 'x-forwarded-proto': 'gopher' }));
    check('G19 a junk X-Forwarded-For / protocol falls back to the socket address and "http"', /127\.0\.0\.1|::1/.test(junk.xff) && junk.xfp === 'http', junk);

    const dead = await get(gate2Port, '/');
    check('G20 no pass, a page: 401 with the friendly page: "Open Green Start again from the Omni-Channel menu" and a Back-to-TeamLink link (https://teamlink.teamlinks.in/)', dead.status === 401 && /Open Green Start again from the Omni-Channel menu/.test(dead.body) && /href="https:\/\/teamlink\.teamlinks\.in\/"/.test(dead.body) && /8 hours/.test(dead.body) && /text\/html/.test(dead.headers['content-type']), dead.body.slice(0, 300));
    const deadEnd = await get(gate2Port, '/app/dashboard', ck(`u1.${Math.floor(Date.now() / 1000) - 5}.${'A'.repeat(43)}`));
    check('G20 a pass that has ended, on a deep link: the same friendly 401 page', deadEnd.status === 401 && /Open Green Start again/.test(deadEnd.body));
    const deadApi = await get(gate2Port, '/api/v1/auth/me');
    let deadJson = {}; try { deadJson = JSON.parse(deadApi.body); } catch { /* text */ }
    check('G20 no pass, the API: 401 JSON that says how to get back in (the app can show it)', deadApi.status === 401 && /Open Green Start again from the Omni-Channel menu/.test((deadJson.error && deadJson.error.message) || ''), deadApi.body.slice(0, 200));
    const plainDead = await get(gatePort, '/');
    check('G20 the PC entrance shows the same friendly page but no TeamLink link (none known)', plainDead.status === 401 && /Open Green Start again/.test(plainDead.body) && !/Back to TeamLink/.test(plainDead.body));

    const blockedPages = ['/signup', '/pricing', '/SIGNUP', '/Pricing/', '//pricing', '/%73ignup', '/signup/extra', '/pricing?plan=pro'];
    const bp = []; for (const p of blockedPages) bp.push((await get(gate2Port, p, ok3)).status); // eslint-disable-line no-await-in-loop
    check('G21 staff mode: the sign-up and pricing pages (also in capitals, with a slash, encoded, with a query) -> 403 "Not available for staff"', bp.every((x) => x === 403), bp);
    const bpBody = await get(gate2Port, '/signup', ok3);
    check('G21 and the 403 page is friendly (plain words)', /Not available for staff/.test(bpBody.body) && /text\/html/.test(bpBody.headers['content-type']), bpBody.body.slice(0, 200));
    check('G21 staff mode: without a pass these still get the 401 page (the door decides first)', (await get(gate2Port, '/signup')).status === 401);
    const blockedApi = [['POST', '/api/v1/auth/register'], ['POST', '/api/v1/auth/google/signup'], ['POST', '/api/v1/billing/topups'], ['POST', '/api/v1/billing/topups/abc/verify'], ['POST', '/api/v1/billing/subscription'], ['POST', '/api/v1/billing/subscription/verify'], ['POST', '/api/V1/Billing/Topups'], ['POST', '/api/v1//billing/topups']];
    const ba = []; for (const [m, p] of blockedApi) ba.push((await get(gate2Port, p, ok4, m)).status); // eslint-disable-line no-await-in-loop
    check('G21 staff mode: new-account sign-up and payment calls (top-up, plan; also odd spellings) -> 403', ba.every((x) => x === 403), ba);
    const allowedApi = [['GET', '/api/v1/billing/wallet'], ['GET', '/api/v1/billing/subscription'], ['GET', '/api/v1/billing/topups/quote'], ['POST', '/api/v1/campaigns'], ['POST', '/api/v1/auth/login'], ['POST', '/api/v1/contacts'], ['GET', '/api/v1/billing/invoices']];
    const aa = []; for (const [m, p] of allowedApi) aa.push((await get(gate2Port, p, ok4, m)).status); // eslint-disable-line no-await-in-loop
    check('G21 staff mode leaves everything else alone: wallet / subscription / quote reading, campaigns, login, contacts, invoices -> forwarded (200)', aa.every((x) => x === 200), aa);
    if (built) {
      const dash = await get(gate2Port, '/app/dashboard', ok3); const credits = await get(gate2Port, '/app/credits', ok3); const login = await get(gate2Port, '/login', ok3);
      check('G21 staff mode: the product app pages (/app/dashboard, /app/credits, /login) still open', dash.status === 200 && credits.status === 200 && login.status === 200, [dash.status, credits.status, login.status]);
      check('G22 PC defaults unchanged: /signup and /pricing still open on the normal entrance', (await get(gatePort, '/signup', ok1)).status === 200 && (await get(gatePort, '/pricing', ok1)).status === 200);
    }
    check('G22 PC defaults unchanged: nothing is blocked on the normal entrance (register / top-up calls are forwarded)', (await get(gatePort, '/api/v1/auth/register', ok1, 'POST')).status === 200 && (await get(gatePort, '/api/v1/billing/topups', ok1, 'POST')).status === 200);

    tl.close(); await sleep(300);
    const fresh = G.makeToken('u9'); // a cookie the entrance has not seen (good answers are remembered 20 s)
    check('G17 TeamLink down -> the entrance refuses (503), never opens', [503, 502].includes((await get(gatePort, '/', ck(fresh))).status));
  } finally {
    try { gate.kill(); gate2.kill(); } catch { /* gone */ }
    try { api.close(); tl.close(); } catch { /* gone */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
