#!/usr/bin/env node
// ---------------------------------------------------------------------------
// GREEN START DOOR-PASS COOKIE + "SEPARATE SERVICE" SWITCH TEST (live-site patches P1, P2; 2026-10-22).
//   cd backend
//   node scripts/green-start-cookie-test.js                                   part A (cookie, verify, supervisor switch: no database needed)
//   COPY_DB=C:/tmp/gs-phase2/copy.db TEST_PORT=4072 node scripts/green-start-cookie-test.js    also part B (a temp backend on a COPY database)
// Never touches dev.db, the real ports 4010 / 4045 / 4020 / 5190, or the real green-start-app run folder.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const STUB = path.join(BACK, 'test-fixtures', 'green-start-stubs', 'stub.js');
const EMB = path.join(BACK, 'src', 'utils', 'greenStartEmbed.js');
const SUP = path.join(BACK, 'src', 'utils', 'greenStartSupervisor.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-cookie-test-'));
const node = process.execPath;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cookie-test-secret';

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tcpOpen = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }); s.setTimeout(500, () => { s.destroy(); res(false); }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
async function until(fn, ms = 15000, step = 150) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; }
const killPid = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const ENV_KEYS = ['GREENSTART_COOKIE_DOMAIN', 'GREENSTART_COOKIE_SECURE', 'GREENSTART_COOKIE_HOURS', 'GREENSTART_SUPERVISE', 'GREENSTART_ENABLED'];
function setEnv(o) { ENV_KEYS.forEach((k) => delete process.env[k]); Object.entries(o).forEach(([k, v]) => { process.env[k] = v; }); }
function fresh(file) { delete require.cache[file]; return require(file); } // eslint-disable-line global-require, import/no-dynamic-require
// a fake request / response, enough for issueCookies and proxy()
const fakeReq = (headers = {}, extra = {}) => ({ headers, method: 'GET', url: '/', socket: {}, ...extra });
function fakeRes() { const h = {}; return { h, setHeader(k, v) { h[k.toLowerCase()] = v; }, writeHead(code, hh) { this.code = code; Object.entries(hh || {}).forEach(([k, v]) => { h[k.toLowerCase()] = v; }); }, end() { this.ended = true; } }; }
const setCookies = (res) => [].concat(res.h['set-cookie'] || []);
function issue(G, headers, userId = 'u1', extra) { const res = fakeRes(); G.issueCookies(fakeReq(headers, extra), res, userId); return setCookies(res); }
const attrsOf = (line) => line.split(';').map((s) => s.trim());
const tokenOf = (line) => /^tl_gs=([^;]*)/.exec(line)[1];
function verifyStatus(G, token, name = 'tl_gs') {
  const res = fakeRes(); let nextCalled = false;
  G.proxy()({ method: 'GET', url: '/api/omni-gs/verify', headers: token == null ? {} : { cookie: `${name}=${token}` } }, res, () => { nextCalled = true; });
  return nextCalled ? 'next' : res.code;
}

// ===========================================================================================
async function partA() {
  console.log('\n--- A1. the door pass cookie: attributes ---');
  // localhost, nothing set: exactly as before
  setEnv({ GREENSTART_ENABLED: 'true' });
  let G = fresh(EMB);
  const local = issue(G, { origin: 'http://localhost:5183' });
  check('A1 localhost, no env: ONE cookie line, name tl_gs, Path=/, HttpOnly, SameSite=Lax, Max-Age=7200 (2 hours)', local.length === 1 && /^tl_gs=/.test(local[0]) && attrsOf(local[0]).includes('Path=/') && attrsOf(local[0]).includes('HttpOnly') && attrsOf(local[0]).includes('SameSite=Lax') && attrsOf(local[0]).includes('Max-Age=7200'), local);
  check('A1 localhost, no env: NO Domain and NO Secure (plain http works as today)', !/Domain=/i.test(local[0]) && !/Secure/i.test(local[0]), local[0]);
  check('A1 header is a single string on the PC (same shape as before)', typeof fakeRes === 'function' && (() => { const r = fakeRes(); G.issueCookies(fakeReq({}), r, 'u1'); return typeof r.h['set-cookie'] === 'string'; })());

  // Secure decided by the request (live nginx sends no X-Forwarded-Proto)
  check('A2 no Domain: a request whose page is https (Origin) gets Secure', /; Secure/.test(issue(G, { origin: 'https://teamlink.teamlinks.in' })[0]));
  check('A2 no Domain: a Referer on https gets Secure', /; Secure/.test(issue(G, { referer: 'https://teamlink.teamlinks.in/' })[0]));
  check('A2 no Domain: X-Forwarded-Proto: https gets Secure; "http" does not', /; Secure/.test(issue(G, { 'x-forwarded-proto': 'https' })[0]) && !/; Secure/.test(issue(G, { 'x-forwarded-proto': 'http' })[0]));
  check('A2 no Domain: Express req.secure / an encrypted socket gets Secure', /; Secure/.test(issue(G, {}, 'u1', { secure: true })[0]) && /; Secure/.test(issue(G, {}, 'u1', { socket: { encrypted: true } })[0]));
  check('A2 a forged "Origin: http://evil" does not matter: still no Secure on http', !/; Secure/.test(issue(G, { origin: 'http://evil.example' })[0]));

  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_SECURE: '1' });
  G = fresh(EMB);
  const sec = issue(G, {});
  check('A3 GREENSTART_COOKIE_SECURE=1: Secure even with no proxy header, still no Domain, still 2 hours', /; Secure/.test(sec[0]) && !/Domain=/i.test(sec[0]) && attrsOf(sec[0]).includes('Max-Age=7200'), sec);

  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_DOMAIN: '.teamlinks.in' });
  G = fresh(EMB);
  const live = issue(G, {});
  const a = attrsOf(live[0]);
  check('A4 live (GREENSTART_COOKIE_DOMAIN=.teamlinks.in): Domain=.teamlinks.in, Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age=28800 (8 hours)', a.includes('Domain=.teamlinks.in') && a.includes('Secure') && a.includes('HttpOnly') && a.includes('SameSite=Lax') && a.includes('Path=/') && a.includes('Max-Age=28800'), live[0]);
  check('A4 the name is tl_gs (not the TeamLink login cookie / token names)', /^tl_gs=/.test(live[0]) && G.COOKIE === 'tl_gs');
  check('A4 Secure comes from the Domain setting, with NO proxy header at all (the live nginx sends none)', a.includes('Secure'));
  check('A4 a second line expires an older host-only copy (same attributes, no Domain, Max-Age=0)', live.length === 2 && /^tl_gs=;/.test(live[1]) && attrsOf(live[1]).includes('Max-Age=0') && !/Domain=/i.test(live[1]) && attrsOf(live[1]).includes('Secure'), live);
  check('A4 ttlS() = 28800 and cookieDomain() = .teamlinks.in', G.ttlS() === 28800 && G.cookieDomain() === '.teamlinks.in');
  const cleared = (() => { const r = fakeRes(); G.clearCookies(fakeReq({}), r); return setCookies(r); })();
  check('A4 clearCookies() expires the pass with and without Domain', cleared.length === 2 && cleared.every((l) => attrsOf(l).includes('Max-Age=0')) && cleared.some((l) => /Domain=\.teamlinks\.in/.test(l)) && cleared.some((l) => !/Domain=/.test(l)), cleared);

  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_DOMAIN: '.teamlinks.in', GREENSTART_COOKIE_HOURS: '4' });
  G = fresh(EMB);
  check('A5 GREENSTART_COOKIE_HOURS=4 overrides the 8 hours', attrsOf(issue(G, {})[0]).includes('Max-Age=14400'));
  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_HOURS: '99' });
  G = fresh(EMB);
  check('A5 a silly hours value (99) is ignored: back to 2 hours on the PC', attrsOf(issue(G, {})[0]).includes('Max-Age=7200'));
  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_DOMAIN: 'evil;domain=x' });
  G = fresh(EMB);
  check('A5 a malformed domain value is ignored (no header injection): no Domain attribute', !/Domain=/i.test(issue(G, {})[0]) && G.cookieDomain() === '');
  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_DOMAIN: 'teamlinks.in' });
  G = fresh(EMB);
  check('A5 a domain written without the leading dot is accepted as written', /Domain=teamlinks\.in/.test(issue(G, {})[0]));

  console.log('\n--- A2. it is only a door pass: own signature, not the TeamLink login ---');
  setEnv({ GREENSTART_ENABLED: 'true', GREENSTART_COOKIE_DOMAIN: '.teamlinks.in' });
  G = fresh(EMB);
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken')); // eslint-disable-line global-require
  const tok = tokenOf(issue(G, {}, 'u1')[0]);
  const parts = tok.split('.');
  check('A6 the pass looks like userId.expiry.signature, NOT like a JWT (no JSON header / payload)', parts.length === 3 && /^\d{9,12}$/.test(parts[1]) && !/^eyJ/.test(tok), tok.slice(0, 30));
  let jwtOk = true; try { jwt.verify(tok, process.env.JWT_SECRET); } catch { jwtOk = false; }
  check('A6 the pass is NOT a valid TeamLink login token (jwt.verify with JWT_SECRET fails)', jwtOk === false);
  const realJwt = jwt.sign({ id: 'u1', role: 'SUPER_ADMIN' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  check('A6 a real TeamLink login token put in the tl_gs cookie is refused by /verify', verifyStatus(G, realJwt) === 401);
  const plainHmac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  check('A6 the signature is made from a SEPARATE key (not JWT_SECRET itself): HMAC with the raw secret differs', plainHmac !== parts[2]);
  const otherSecretSig = (() => { const old = process.env.JWT_SECRET; process.env.JWT_SECRET = 'another-secret'; const H = fresh(EMB); const t = H.makeToken('u1'); process.env.JWT_SECRET = old; fresh(EMB); return t; })();
  check('A6 a pass made with another server secret is refused', verifyStatus(G, otherSecretSig) === 401);

  console.log('\n--- A3. /api/omni-gs/verify: valid, expired, forged, tampered, other user ---');
  const [uid, exp, sig] = tok.split('.');
  check('A7 valid pass -> 204', verifyStatus(G, tok) === 204);
  check('A7 no cookie -> 401', verifyStatus(G, null) === 401);
  const past = `${uid}.${Math.floor(Date.now() / 1000) - 10}`;
  const secret = crypto.createHash('sha256').update(`greenstart-gate:${process.env.JWT_SECRET}`).digest();
  const expired = `${past}.${crypto.createHmac('sha256', secret).update(past).digest('base64url')}`;
  check('A7 expired pass (correctly signed, but out of date) -> 401', verifyStatus(G, expired) === 401);
  check('A7 forged pass (made-up signature) -> 401', verifyStatus(G, `${uid}.${exp}.${'A'.repeat(43)}`) === 401);
  check('A7 tampered expiry (a later time, old signature) -> 401', verifyStatus(G, `${uid}.${Number(exp) + 100000}.${sig}`) === 401);
  check('A7 other user (u2 with u1\'s signature) -> 401', verifyStatus(G, `u2.${exp}.${sig}`) === 401);
  check('A7 a pass for another user made properly is fine for THAT user (204)', verifyStatus(G, G.makeToken('u2')) === 204);
  check('A7 junk values (empty, short, script text) -> 401', ['', 'x', '<script>', 'a.b.c', '..'].every((v) => verifyStatus(G, v) === 401));
  check('A7 the cookie under another name is not accepted', verifyStatus(G, tok, 'tl_gs2') === 401 && verifyStatus(G, tok, 'tl_token') === 401);
  setEnv({ GREENSTART_ENABLED: 'false' });
  G = fresh(EMB);
  check('A7 GREENSTART_ENABLED=false: even a good pass -> 401 (the door is shut)', verifyStatus(G, tok) === 401);
  check('A7 verify answers only GET /api/omni-gs/verify (anything else goes on)', (() => { const r = fakeRes(); let n = false; G.proxy()({ method: 'POST', url: '/api/omni-gs/verify', headers: {} }, r, () => { n = true; }); return n; })());

  console.log('\n--- A4. GREENSTART_SUPERVISE=false: TeamLink starts nothing; status says "separate service" ---');
  await supervisorSwitch();
}

async function supervisorSwitch() {
  const mk = async (name, supervise) => {
    const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
    const ports = { db: await freePort(), redis: await freePort(), api: await freePort(), gate: await freePort() };
    fs.writeFileSync(path.join(dir, 'dbstate.json'), JSON.stringify({ migrations: 12, users: 3, contacts: 12 }));
    fs.writeFileSync(path.join(dir, 'freemb.txt'), '5000');
    const stub = (args) => ({ cmd: node, args: [STUB, ...args] });
    const cfg = {
      runDir: path.join(dir, 'run'), apiDir: path.join(dir, 'api'), webDir: path.join(dir, 'web'), logsDir: path.join(dir, 'logs'), redisDir: path.join(dir, 'redisdir'), backupDir: path.join(dir, 'backups'),
      pgPort: ports.db, redisPort: ports.redis, apiPort: ports.api, gatePort: ports.gate, skipBuiltCheck: true, expectedMigrations: 12, redisExe: path.join(dir, 'none.exe'), pgCtl: null, teamlinkPort: 4999,
      tickMs: 600000, startDelayMs: 600000, pollMs: 100, startTimeoutMs: 8000, backoffMs: [100, 200], fakeFreeMbFile: path.join(dir, 'freemb.txt'), heartbeatMs: 300, watchdogMaxAgeMs: 120000,
      commands: { db: stub(['tcp', ports.db]), redis: stub(['redis', ports.redis]), api: stub(['http', ports.api]), worker: stub(['idle']), gate: stub(['tcp', ports.gate]), dbState: stub(['state', path.join(dir, 'dbstate.json')]), migrate: stub(['ok']), seed: stub(['ok']), backup: stub(['backup']) },
    };
    fs.mkdirSync(cfg.runDir, { recursive: true });
    const cf = path.join(dir, 'cfg.json'); fs.writeFileSync(cf, JSON.stringify(cfg));
    process.env.TEST_MODE = '1'; process.env.GREENSTART_SUPERVISOR_TEST_CONFIG = cf; process.env.GREENSTART_ENABLED = 'true';
    if (supervise === undefined) delete process.env.GREENSTART_SUPERVISE; else process.env.GREENSTART_SUPERVISE = supervise;
    const mod = fresh(SUP);
    mod.start();
    return { mod, dir, ports };
  };
  // control case: without the switch the same settings DO start the stand-ins (so the "nothing started" below means something)
  const c = await mk('sup-on', undefined);
  await c.mod._reconcile();
  const started = await tcpOpen(c.ports.db) && await tcpOpen(c.ports.gate);
  check('A8 control: with GREENSTART_SUPERVISE unset the supervisor DOES start the stand-in programs', started);
  await c.mod.control('stop'); await until(async () => !(await tcpOpen(c.ports.db)), 20000); c.mod.stopTimers();
  for (const n of ['db', 'redis', 'api', 'worker', 'gate', 'watchdog']) { const j = rd(path.join(c.dir, 'logs', `${n}.pid`)); if (j && j.pid) killPid(j.pid); }

  for (const val of ['false', 'FALSE', '0', 'off']) {
    const k = await mk(`sup-off-${val}`, val);
    await k.mod._reconcile();
    const any = (await tcpOpen(k.ports.db)) || (await tcpOpen(k.ports.gate)) || (await tcpOpen(k.ports.api));
    const files = fs.existsSync(path.join(k.dir, 'logs')) ? fs.readdirSync(path.join(k.dir, 'logs')) : [];
    const s = await k.mod.snapshot();
    const r = await k.mod.control('start');
    const r2 = await k.mod.control('restart');
    check(`A8 GREENSTART_SUPERVISE=${val}: nothing is spawned, no lock / pid / log file is written`, !any && files.length === 0, { any, files });
    check(`A8 GREENSTART_SUPERVISE=${val}: snapshot says supervised false, external true, state "external" and the plain sentence`, s.supervised === false && s.external === true && s.state === 'external' && s.stateText === 'Green Start runs as a separate service on this server', s);
    check(`A8 GREENSTART_SUPERVISE=${val}: Admin Start / Restart are refused with a plain reason`, r.ok === false && r2.ok === false && /separate service/i.test(r.error), r);
    k.mod.stopTimers();
  }
  // embed status() with the switch: reads the real ports (stand-ins here), says "external"
  {
    const ports = { gate: await freePort(), db: await freePort(), redis: await freePort() };
    const stubs = [spawn(node, [STUB, 'tcp', ports.gate], { stdio: 'ignore' }), spawn(node, [STUB, 'tcp', ports.db], { stdio: 'ignore' })];
    Object.assign(process.env, { GREENSTART_ENABLED: 'true', GREENSTART_SUPERVISE: 'false', GREENSTART_GATE_PORT: String(ports.gate), GREENSTART_PG_PORT: String(ports.db), GREENSTART_REDIS_PORT: String(ports.redis), GREENSTART_WEB_DIR: TMP });
    fs.writeFileSync(path.join(TMP, 'index.html'), '<html></html>');
    delete process.env.GREENSTART_SUPERVISOR_TEST_CONFIG; delete process.env.TEST_MODE;
    fresh(SUP);
    const G = fresh(EMB);
    await until(async () => (await tcpOpen(ports.gate)) && (await tcpOpen(ports.db)), 8000, 100);
    const st = await G.status();
    check('A9 status() with the switch: external true, the sentence, built (GREENSTART_WEB_DIR), gate / database read from their ports, Redis down read as down', st.external === true && st.supervised === false && st.stateText === 'Green Start runs as a separate service on this server' && st.built === true && st.gate === true && st.db === true && st.redis === false, st);
    stubs.forEach((p) => killPid(p.pid));
    delete process.env.GREENSTART_SUPERVISE; delete process.env.GREENSTART_GATE_PORT; delete process.env.GREENSTART_PG_PORT; delete process.env.GREENSTART_REDIS_PORT; delete process.env.GREENSTART_WEB_DIR;
  }
}

// ===========================================================================================
async function partB() {
  console.log('\n--- B. /api/omni-gs/session and /verify on a temp backend (COPY database), live settings ---');
  const copy = process.env.COPY_DB;
  if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy)) || !fs.existsSync(copy)) { console.log('SKIP  part B needs COPY_DB=<a copy of the database> (never dev.db)'); return; }
  const PORT = Number(process.env.TEST_PORT || 4072);
  if (PORT === 4010 || PORT === 4045) { console.error('bad TEST_PORT'); process.exit(2); }
  const WORK = path.resolve(copy).replace(/\.db$/i, '-gscookie-work.db');
  fs.copyFileSync(path.resolve(copy), WORK);
  const dbUrl = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
  process.env.DATABASE_URL = dbUrl; process.env.TEST_MODE = '1';
  require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false }); // eslint-disable-line global-require
  process.env.DATABASE_URL = dbUrl;
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken')); // eslint-disable-line global-require
  const prisma = require(path.join(BACK, 'src/db')); // eslint-disable-line global-require
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity')); // eslint-disable-line global-require
  const A0 = require(path.join(BACK, 'src/outreach/access')); // eslint-disable-line global-require
  const runDir = path.resolve(BACK, '..', 'green-start-app', 'run');
  const API = `http://127.0.0.1:${PORT}`;
  const gatePort = await freePort(); const apiPort = await freePort();
  const stubs = [spawn(node, [STUB, 'tcp', gatePort], { stdio: 'ignore' }), spawn(node, [STUB, 'http', apiPort], { stdio: 'ignore' })];
  const call = async (method, pth, token, headers = {}) => {
    const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetch(`${API}${pth}`, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body, text, cookies: typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [] };
  };
  let server;
  try {
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } } // eslint-disable-line no-await-in-loop
    const hr = await first({ atsRole: 'HR', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER', ...live }) || await first({ atsRole: 'ASSISTANT_MANAGER' }) || await first({ role: 'MANAGER' });
    const bde = await first({ atsRole: 'BDE', ...live });
    const rec = await first({ atsRole: 'RECRUITER', ...live });
    check('B0 the copy has an Admin, a TL, HR, a Manager / AM, a BDE and a Recruiter', !!(sa && tl && hr && am && bde && rec), { sa: !!sa, tl: !!tl, hr: !!hr, am: !!am, bde: !!bde, rec: !!rec });
    const ids = [sa, tl, hr, am, bde, rec].filter(Boolean).map((u) => u.id);
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { passwordHash: 'x' } }); // the COPY only
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } }); // the COPY only: the only AM login there has left the company
    const env = { ...process.env, PORT: String(PORT), GREENSTART_ENABLED: 'true', GREENSTART_SUPERVISE: 'false', GREENSTART_COOKIE_DOMAIN: '.teamlinks.in', GREENSTART_GATE_PORT: String(gatePort), GREENSTART_API_PORT: String(apiPort), TEST_MOCK_PORTS: String(apiPort), TL_RATE_LIMIT_IN_TEST: '' };
    delete env.GREENSTART_SUPERVISOR_TEST_CONFIG; delete env.GREENSTART_COOKIE_SECURE; delete env.GREENSTART_COOKIE_HOURS; delete env.GREENSTART_ALL_ROLES;
    server = spawn(node, ['src/index.js'], { cwd: BACK, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); fail += 1; return; }
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tok(sa), tl: await tok(tl), hr: await tok(hr), am: await tok(am), bde: await tok(bde), rec: await tok(rec) };

    for (const [who, label] of [['sa', 'Admin'], ['tl', 'TL'], ['hr', 'HR'], ['am', 'Manager / AM']]) {
      const r = await call('POST', '/api/omni-gs/session', T[who]); // eslint-disable-line no-await-in-loop
      const line = r.cookies.find((l) => /^tl_gs=/.test(l)) || '';
      check(`B1 ${label}: POST /session -> 200 and a tl_gs cookie with Domain=.teamlinks.in; Secure; HttpOnly; SameSite=Lax; Max-Age=28800`, r.status === 200 && r.body && r.body.ok === true && /Domain=\.teamlinks\.in/.test(line) && /; Secure/.test(line) && /; HttpOnly/.test(line) && /SameSite=Lax/.test(line) && /Max-Age=28800/.test(line), { status: r.status, cookies: r.cookies, text: r.text.slice(0, 200) });
      if (who === 'sa') {
        const pass = tokenOf(line);
        const ver = await call('GET', '/api/omni-gs/verify', null, { cookie: `tl_gs=${pass}` });
        check('B2 the cookie value given to the Admin is accepted by /api/omni-gs/verify (204) on the real server', ver.status === 204, ver.status);
        const asBearer = await call('GET', '/api/omni-gs/status', pass);
        check('B2 the door pass used as a TeamLink login token opens nothing (401)', asBearer.status === 401, asBearer.status);
        const asCookieOnly = await call('GET', '/api/omni-gs/status', null, { cookie: `tl_gs=${pass}` });
        check('B2 the door pass sent as a cookie to a TeamLink API gives no access (401)', asCookieOnly.status === 401, asCookieOnly.status);
        const clients = await call('GET', '/api/clients', null, { cookie: `tl_gs=${pass}` });
        check('B2 and none of the other TeamLink data (clients) opens with it (401)', clients.status === 401, clients.status);
      }
    }
    const rb = await call('POST', '/api/omni-gs/session', T.bde); const rr = await call('POST', '/api/omni-gs/session', T.rec); const rn = await call('POST', '/api/omni-gs/session');
    check('B3 BDE and Recruiter: POST /session -> 403 and NO cookie; without a login -> 401', rb.status === 403 && rr.status === 403 && rn.status === 401 && !rb.cookies.length && !rr.cookies.length && !rn.cookies.length, [rb.status, rr.status, rn.status]);
    const ver0 = await call('GET', '/api/omni-gs/verify');
    check('B3 /verify with no cookie -> 401', ver0.status === 401);

    await sleep(1500);
    const st = await call('GET', '/api/omni-gs/status', T.sa);
    check('B4 /status with GREENSTART_SUPERVISE=false: "external", the plain sentence, supervised false; gate and api read from the stand-ins (up)', st.status === 200 && st.body.external === true && st.body.supervised === false && st.body.stateText === 'Green Start runs as a separate service on this server' && st.body.gate === true && st.body.api === true, st.text.slice(0, 300));
    const cmds = await Promise.all(['start', 'stop', 'restart', 'backup'].map((a) => call('POST', `/api/omni-gs/${a}`, T.sa)));
    check('B4 Start / Stop / Restart / Backup answer 409 with the plain reason (nothing runs from TeamLink)', cmds.every((r) => r.status === 409 && /separate service/i.test((r.body && r.body.error) || '')), cmds.map((r) => r.status));
    stubs.forEach((p) => killPid(p.pid)); await sleep(1500);
    const st2 = await call('GET', '/api/omni-gs/status', T.sa);
    check('B4 when the stand-ins stop, status turns gate / api false (it reads the real state, not a memory)', st2.body && st2.body.gate === false && st2.body.api === false, st2.text.slice(0, 200));
    // (the PC's own running TeamLink may be looking after the real Green Start, so file times in run/logs move by themselves: look for THIS server's process id instead)
    const mine = String(server.pid);
    const holders = ['supervisor.lock', 'heartbeat'].map((n) => { try { return fs.readFileSync(path.join(runDir, 'logs', n), 'utf8'); } catch { return ''; } });
    check('B5 this temp backend left no lock file and no heartbeat of its own in the real green-start-app run/logs', holders.every((t) => !(String(t).match(/[0-9]+/g) || []).includes(mine)), holders.map((t) => t.slice(0, 80)));
  } finally {
    if (server) { try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ } }
    stubs.forEach((p) => killPid(p.pid));
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    try { fs.rmSync(WORK, { force: true }); fs.rmSync(`${WORK}-wal`, { force: true }); fs.rmSync(`${WORK}-shm`, { force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  try {
    if (!process.env.ONLY || process.env.ONLY.includes('A')) await partA();
    if (!process.env.ONLY || process.env.ONLY.includes('B')) await partB();
  } catch (e) { fail += 1; console.log(`FAIL  test crashed: ${e && e.stack}`); }
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 400);
})();
