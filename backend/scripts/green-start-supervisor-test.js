#!/usr/bin/env node
// ---------------------------------------------------------------------------
// GREEN START SUPERVISOR TEST (2026-10-22). Uses tiny STUB programs (test-fixtures/green-start-stubs/stub.js) instead of the real Green Start,
// on free test ports, in a temp folder. Never touches the real green-start-app run folder, the real ports 4020/5190/5436/6379 or dev.db.
//   cd backend
//   node scripts/green-start-supervisor-test.js                      parts A (supervisor scenarios) and C (source untouched, Redis config)
//   COPY_DB=C:/tmp/some-copy.db TEST_PORT=4071 node scripts/green-start-supervisor-test.js     also part B (status API, permissions, audit) on a COPY database
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const APP = path.resolve(BACK, '..', 'green-start-app');
const STUB = path.join(BACK, 'test-fixtures', 'green-start-stubs', 'stub.js');
const SUP_PATH = path.join(BACK, 'src', 'utils', 'greenStartSupervisor.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-sup-test-'));
const node = process.execPath;
process.setMaxListeners(100);

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; }
const tcpOpen = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }); s.setTimeout(500, () => { s.destroy(); res(false); }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function freePort() { return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ---- scenario kit ------------------------------------------------------------
let current = null; // { mod, dir, ports }
const spawned = new Set();
function killPid(pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
function cleanupDir(dir) {
  for (const n of ['db', 'redis', 'api', 'worker', 'gate', 'watchdog']) { const j = rd(path.join(dir, 'logs', `${n}.pid`)); if (j && j.pid) killPid(j.pid); }
}
function stubCmd(args, env) { return { cmd: node, args: [STUB, ...args], ...(env ? { env } : {}) }; }
async function kit(name, over = {}, env = {}) {
  if (current) { current.mod.stopTimers(); }
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const ports = over.ports || { db: await freePort(), redis: await freePort(), api: await freePort(), gate: await freePort() };
  const stateFile = path.join(dir, 'dbstate.json');
  if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, JSON.stringify({ migrations: 12, users: 3, contacts: 12 }));
  const memFile = path.join(dir, 'freemb.txt'); if (!fs.existsSync(memFile)) fs.writeFileSync(memFile, '5000');
  const diskFile = path.join(dir, 'freedisk.txt'); if (!fs.existsSync(diskFile)) fs.writeFileSync(diskFile, '50000');
  const cfg = {
    runDir: path.join(dir, 'run'), apiDir: path.join(dir, 'api'), webDir: path.join(dir, 'web'), logsDir: path.join(dir, 'logs'), redisDir: path.join(dir, 'redisdir'),
    backupDir: path.join(dir, 'backups'), pgPort: ports.db, redisPort: ports.redis, apiPort: ports.api, gatePort: ports.gate,
    skipBuiltCheck: true, expectedMigrations: 12, redisExe: path.join(dir, 'no-such-redis.exe'), pgCtl: null, teamlinkPort: 4999,
    tickMs: 600000, startDelayMs: 600000, memoryRetryMs: 700, startTimeoutMs: 8000, pollMs: 100, backoffMs: [100, 200, 300], maxRestarts: 3, statsEveryMs: 600000,
    heartbeatMs: 300, watchdogMaxAgeMs: 120000, watchdogCheckMs: 300, backupKeep: 3, minDiskMB: 1500,
    fakeFreeMbFile: memFile, fakeDiskMbFile: diskFile,
    commands: {
      db: stubCmd(['tcp', ports.db]), api: stubCmd(['http', ports.api], { STUB_ENV_OUT: path.join(dir, 'api-env.json') }), worker: stubCmd(['idle']), gate: stubCmd(['tcp', ports.gate]),
      dbState: stubCmd(['state', stateFile]), migrate: stubCmd(['migrate', stateFile, '12']), seed: stubCmd(['seed', stateFile]), backup: stubCmd(['backup']),
      ...(over.withRedis === false ? {} : { redis: stubCmd(['redis', ports.redis]) }),
      ...(over.commands || {}),
    },
    ...(over.cfg || {}),
  };
  fs.mkdirSync(cfg.runDir, { recursive: true });
  fs.copyFileSync(path.join(APP, 'run', 'watchdog.cjs'), path.join(cfg.runDir, 'watchdog.cjs'));
  fs.copyFileSync(path.join(APP, 'run', 'bind-local.cjs'), path.join(cfg.runDir, 'bind-local.cjs')); // the server is started with it, like the real one
  const cfgFile = path.join(dir, 'supervisor-test.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  process.env.TEST_MODE = '1';
  process.env.GREENSTART_SUPERVISOR_TEST_CONFIG = cfgFile;
  process.env.GREENSTART_ENABLED = env.GREENSTART_ENABLED === undefined ? 'true' : env.GREENSTART_ENABLED;
  if (env.GREENSTART_AUTOSTART === undefined) delete process.env.GREENSTART_AUTOSTART; else process.env.GREENSTART_AUTOSTART = env.GREENSTART_AUTOSTART;
  delete require.cache[SUP_PATH];
  const mod = require(SUP_PATH); // eslint-disable-line global-require, import/no-dynamic-require
  mod.start();
  current = { mod, dir, ports, cfg, stateFile, memFile, diskFile };
  return current;
}
const pidOf = (k, n) => { const j = rd(path.join(k.dir, 'logs', `${n}.pid`)); return j && j.pid; };
async function stopAllIn(k) { try { await k.mod.control('stop'); await until(async () => !(await tcpOpen(k.ports.db)) && !(await tcpOpen(k.ports.gate)), 15000); } catch { /* ignore */ } cleanupDir(k.dir); }

// ===========================================================================================
async function partA() {
  console.log('\n--- A. supervisor with stub programs ---');
  // ---- A1 start order, states, 'Starting (step n of 5)' -------------------------------
  {
    const p = { db: await freePort(), redis: await freePort(), api: await freePort(), gate: await freePort() };
    const k = await kit('a1', { ports: p, commands: { db: stubCmd(['tcp', p.db, 1200]), api: stubCmd(['http', p.api, 1200], { STUB_ENV_OUT: path.join(TMP, 'a1', 'api-env.json') }) } });
    const seen = new Set(); let stop = false;
    const poll = (async () => { while (!stop) { const s = await k.mod.snapshot({ fresh: false }); seen.add(`${s.state}:${s.step ? s.step.n : 0}`); await sleep(80); } })();
    await k.mod._reconcile();
    stop = true; await poll;
    const s = await k.mod.snapshot();
    check('A1 everything starts by itself and the state ends as "running"', s.state === 'running' && s.stateText === 'Running', { state: s.state, seen: [...seen] });
    check('A1 while starting the state said "starting" with steps (1 = database, 4 = server)', seen.has('starting:1') && seen.has('starting:4'), [...seen]);
    const t = ['db', 'redis', 'api', 'worker', 'gate'].map((n) => (rd(path.join(k.dir, 'logs', `${n}.pid`)) || {}).startedAt);
    check('A1 the order is database, Redis, server, worker, entrance', t.every((x) => x) && t.every((x, i) => i === 0 || x >= t[i - 1]), t);
    check('A1 status shape: five parts, ram, disk, backups, contacts, supervisor, paths', ['db', 'redis', 'api', 'worker', 'gate'].every((n) => s.parts[n] && s.parts[n].ok === true) && s.ram && s.disk && s.backups && s.contacts === 12 && s.supervisor.active && s.paths.redisInstall.endsWith('get-redis.cmd'), Object.keys(s));
    const env = rd(path.join(k.dir, 'api-env.json')) || {};
    check('A1 the server gets a CLEAN environment (no TeamLink JWT secret or SQLite database address)', env.hasJwt === false && env.hasDbUrl === false && String(env.port) === String(p.api), env);
    check('A1 own Redis: server gets REDIS_URL with the generated password and the right port, on 127.0.0.1', /^redis:\/\/:[0-9a-f]{40,}@127\.0\.0\.1:\d+$/.test(env.REDIS_URL || ''), env.REDIS_URL && env.REDIS_URL.replace(/:[0-9a-f]{40,}@/, ':***@'));
    const conf = fs.readFileSync(path.join(k.dir, 'redisdir', 'redis-gs.conf'), 'utf8');
    check('A1 the Redis settings file binds 127.0.0.1 only, has a password, 256 MB limit, no append file', /^bind 127\.0\.0\.1$/m.test(conf) && !/0\.0\.0\.0/.test(conf) && /^requirepass \S{40,}$/m.test(conf) && /^maxmemory 256mb$/m.test(conf) && /^appendonly no$/m.test(conf), conf.replace(/requirepass .*/, 'requirepass ***'));
    check('A1 heartbeat file is written', fs.existsSync(path.join(k.dir, 'logs', 'heartbeat')));
    check('A1 the watchdog is running', await until(() => { const w = rd(path.join(k.dir, 'logs', 'watchdog.pid')); return !!(w && w.pid && alive(w.pid)); }, 5000));
    // ---- A7 nodemon restart: a NEW module instance adopts what the old one started ---------
    const before = ['db', 'redis', 'api', 'worker', 'gate'].map((n) => pidOf(k, n));
    k.mod.stopTimers();
    const k2 = await kit('a1', { ports: p, commands: { db: stubCmd(['tcp', p.db]), api: stubCmd(['http', p.api]) } });
    await k2.mod._reconcile();
    const after = ['db', 'redis', 'api', 'worker', 'gate'].map((n) => pidOf(k2, n));
    const s2 = await k2.mod.snapshot();
    check('A7 after a backend restart the same processes are still managed (same pids), nothing started twice', JSON.stringify(before) === JSON.stringify(after) && s2.state === 'running' && Object.values(s2.parts).every((x) => x.managed !== false), { before, after, st: s2.state });
    // ---- A6 clean stop + stays stopped + start again ------------------------------------------
    const r = await k2.mod.control('stop');
    check('A6 Stop answers ok', r.ok === true, r);
    const down = await until(async () => !(await tcpOpen(p.db)) && !(await tcpOpen(p.api)) && !(await tcpOpen(p.gate)) && !(await tcpOpen(p.redis)), 20000);
    const settled = await until(async () => (await k2.mod.snapshot()).state === 'stopped', 20000);
    const s3 = await k2.mod.snapshot();
    check('A6 Stop ends every part we started and removes the pid files', down && settled && ['db', 'redis', 'api', 'worker', 'gate'].every((n) => !fs.existsSync(path.join(k2.dir, 'logs', `${n}.pid`))) && before.every((pid) => !alive(pid)), { down, st: s3.state });
    await k2.mod._reconcile();
    check('A6 after Stop it stays "stopped" (a reconcile does not restart it)', (await k2.mod.snapshot()).state === 'stopped' && !(await tcpOpen(p.db)));
    const r2 = await k2.mod.control('start');
    const up = await until(async () => (await k2.mod.snapshot()).state === 'running', 25000);
    check('A6 Start brings everything back', r2.ok && up, (await k2.mod.snapshot()).state);
    const r3 = await k2.mod.control('restart');
    const up2 = await until(async () => { const s4 = await k2.mod.snapshot(); return s4.state === 'running' && ['db', 'api'].every((n) => pidOf(k2, n) && !before.includes(pidOf(k2, n))); }, 30000);
    check('A6 Restart stops and starts again with new processes', r3.ok && up2);
    await stopAllIn(k2);
  }

  // ---- A2 waiting for memory -------------------------------------------------------------
  {
    const k = await kit('a2');
    fs.writeFileSync(k.memFile, '300');
    await k.mod._reconcile();
    let s = await k.mod.snapshot();
    check('A2 low memory: state "Waiting for memory", nothing started, no pid files', s.state === 'waiting_memory' && s.stateText === 'Waiting for memory' && s.ram.blocked && !(await tcpOpen(k.ports.db)) && !fs.existsSync(path.join(k.dir, 'logs', 'db.pid')), { st: s.state, ram: s.ram });
    fs.writeFileSync(k.memFile, '5000');
    await sleep(900); // the retry delay (memoryRetryMs) has passed
    await k.mod._reconcile();
    s = await k.mod.snapshot();
    check('A2 memory comes back: it starts by itself and runs', s.state === 'running', s.state);
    await stopAllIn(k);
  }

  // ---- A3 waiting for Redis: db + entrance only; api and worker NOT started ---------------
  {
    const k = await kit('a3', { withRedis: false });
    await k.mod._reconcile();
    let s = await k.mod.snapshot();
    check('A3 no Redis: state "Waiting for Redis"', s.state === 'waiting_redis' && s.stateText === 'Waiting for Redis' && s.parts.redis.state === 'missing', { st: s.state, redis: s.parts.redis });
    check('A3 database and entrance run, the server and the worker are NOT started (no zombie)', s.parts.db.ok && s.parts.gate.ok && !s.parts.api.ok && !fs.existsSync(path.join(k.dir, 'logs', 'api.pid')) && !fs.existsSync(path.join(k.dir, 'logs', 'worker.pid')) && !(await tcpOpen(k.ports.api)), s.parts);
    // somebody (Memurai ...) starts a Redis on the port: found by itself
    const ext = spawn(node, [STUB, 'redis', String(k.ports.redis)], { stdio: 'ignore' }); spawned.add(ext.pid);
    await until(() => tcpOpen(k.ports.redis), 5000);
    await k.mod._reconcile();
    s = await k.mod.snapshot();
    check('A3 a Redis that already answers is used as it is (kind "external"), then the server and worker start', s.state === 'running' && s.parts.redis.kind === 'external' && s.parts.api.ok && s.parts.worker.ok, { st: s.state, redis: s.parts.redis });
    const env = rd(path.join(k.dir, 'api-env.json')) || {};
    check('A3 with an outside Redis the product\'s own REDIS_URL setting is left alone (nothing handed over)', env.REDIS_URL === null, env);
    await stopAllIn(k); killPid(ext.pid);
  }

  // ---- A4 crash, back-off, give up, report with scrubbed lines --------------------------------
  {
    const secret = 'Sup3rS3cretPassw0rd';
    const k = await kit('a4', { commands: { api: stubCmd(['crash', 150, `FATAL cannot connect password=${secret} user admin@greenstart.demo token: abcdefghijklmnop1234 redis://:${secret}@127.0.0.1:6379`]) } });
    await k.mod._reconcile();
    let tries = 0;
    for (; tries < 12; tries += 1) { // each pass: the part died, back-off passes, a new start (max 3 starts in one hour)
      await sleep(450);
      await k.mod._reconcile();
      if ((await k.mod.snapshot()).state === 'crashed') break;
    }
    const s = await k.mod.snapshot();
    check('A4 repeated crashes end as "Crashed" naming the part', s.state === 'crashed' && s.crash && s.crash.part === 'api', { st: s.state, crash: s.crash });
    check('A4 it started the part exactly the allowed number of times (3) and then gave up', s.parts.api.restarts === 3, s.parts.api);
    const blob = JSON.stringify(s.crash);
    check('A4 the crash report has the last lines, with passwords / tokens / e-mails / Redis addresses hidden', s.crash.lines.length >= 1 && !blob.includes(secret) && !/admin@greenstart/.test(blob) && !/abcdefghijklmnop1234/.test(blob) && /FATAL/.test(blob), blob);
    await sleep(500); await k.mod._reconcile();
    check('A4 after giving up it does NOT keep restarting', (await k.mod.snapshot()).parts.api.restarts === 3);
    const lg = k.mod.readLog('api', 80);
    check('A4 "Show log" returns scrubbed lines', lg.lines.length > 0 && !JSON.stringify(lg).includes(secret) && !/admin@greenstart/.test(JSON.stringify(lg)), lg);
    await stopAllIn(k);
  }

  // ---- A5 adopt processes that a person started (start-green-start.cmd) -----------------------------
  {
    const p = { db: await freePort(), redis: await freePort(), api: await freePort(), gate: await freePort() };
    const pre = [['tcp', p.db], ['http', p.api], ['tcp', p.gate], ['redis', p.redis]].map((a) => { const c = spawn(node, [STUB, ...a.map(String)], { stdio: 'ignore' }); spawned.add(c.pid); return c; });
    await until(async () => (await tcpOpen(p.db)) && (await tcpOpen(p.gate)) && (await tcpOpen(p.redis)), 8000);
    await sleep(500);
    const k = await kit('a5', { ports: p, withRedis: false });
    fs.writeFileSync(path.join(k.cfg.runDir, 'pids.json'), JSON.stringify({ WORKER: process.pid })); // the launcher's note about the worker window
    await k.mod._reconcile();
    const s = await k.mod.snapshot();
    check('A5 programs started by hand are recognised and adopted: nothing is started a second time', s.state === 'running' && ['db', 'api', 'gate'].every((n) => s.parts[n].adopted) && ['db', 'redis', 'api', 'worker', 'gate'].every((n) => !fs.existsSync(path.join(k.dir, 'logs', `${n}.pid`))), { st: s.state, parts: Object.fromEntries(Object.entries(s.parts).map(([a, b]) => [a, b.adopted])) });
    pre.forEach((c) => killPid(c.pid));
    k.mod.stopTimers();
  }

  // ---- A8 single instance lock ---------------------------------------------------------------------
  {
    const holder = spawn(node, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' }); spawned.add(holder.pid);
    const dir = path.join(TMP, 'a8'); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'supervisor.lock'), JSON.stringify({ pid: holder.pid, startedAt: Date.now() }));
    const k = await kit('a8');
    await k.mod._reconcile();
    let s = await k.mod.snapshot();
    check('A8 a second supervisor does not start anything while another backend holds the lock', s.supervisor.active === false && s.state === 'managed_elsewhere' && !(await tcpOpen(k.ports.db)), { st: s.state, sup: s.supervisor });
    const c = await k.mod.control('start');
    check('A8 the buttons are refused with a clear sentence', c.ok === false && /Another TeamLink backend/.test(c.error), c);
    killPid(holder.pid); await sleep(400);
    await k.mod._reconcile();
    s = await k.mod.snapshot();
    check('A8 when the other one is gone it takes over and starts', s.supervisor.active === true && s.state === 'running', { st: s.state });
    await stopAllIn(k);
  }

  // ---- A9 switches: autostart off, enabled off ------------------------------------------------------------
  {
    const k = await kit('a9', {}, { GREENSTART_AUTOSTART: 'false' });
    await k.mod._reconcile();
    let s = await k.mod.snapshot();
    check('A9 GREENSTART_AUTOSTART=false: nothing starts by itself, state says so', s.state === 'autostart_off' && !(await tcpOpen(k.ports.db)) && s.supervisor.autostart === false, s.state);
    const r = await k.mod.control('start');
    const up = await until(async () => (await k.mod.snapshot()).state === 'running', 25000);
    check('A9 the Admin Start button still works', r.ok && up);
    await stopAllIn(k);
    const k2 = await kit('a9b', {}, { GREENSTART_ENABLED: 'false' });
    s = await k2.mod.snapshot();
    check('A9 GREENSTART_ENABLED=false: not looked after at all', s.state === 'off' && s.supervised === false && !(await tcpOpen(k2.ports.db)));
  }

  // ---- A10 watchdog: backend silent => everything it started is stopped -------------------------------------------
  {
    const k = await kit('a10', { cfg: { watchdogMaxAgeMs: 2000 } });
    await k.mod._reconcile();
    check('A10 running before the "backend dies" step', (await k.mod.snapshot()).state === 'running');
    k.mod.stopTimers(); // no more heartbeat, like a killed backend
    const gone = await until(async () => !(await tcpOpen(k.ports.db)) && !(await tcpOpen(k.ports.api)) && !(await tcpOpen(k.ports.gate)), 25000, 300);
    check('A10 the watchdog stops all parts when the backend has been silent (no leftover programs)', gone && ['db', 'redis', 'api', 'worker', 'gate'].every((n) => !fs.existsSync(path.join(k.dir, 'logs', `${n}.pid`))));
    cleanupDir(k.dir);
  }

  // ---- A11 database updates and the demo workspace on the first start ----------------------------------------
  if (!process.env.SCEN || process.env.SCEN === 'A11') {
    const k = await kit('a11');
    fs.writeFileSync(k.stateFile, JSON.stringify({ migrations: 9, users: 0, contacts: 0 }));
    await k.mod._reconcile();
    const s = await k.mod.snapshot();
    const ml = fs.readFileSync(path.join(k.dir, 'logs', 'migrate.log'), 'utf8');
    check('A11 missing migrations are applied (9 -> 12) and an empty database gets the demo workspace once', s.prepare.done && s.prepare.migrations === 12 && s.prepare.seeded && s.contacts === 12 && /migrate \(exit 0\)/.test(ml) && /seed \(exit 0\)/.test(ml), { prep: s.prepare, ml: ml.slice(-200) });
    await stopAllIn(k);
    fs.rmSync(path.join(k.dir, 'logs', 'supervisor-state.json'), { force: true }); // a Stop is remembered across restarts (correct); this scenario is a fresh start
    const k2 = await kit('a11'); // the data is there now: neither migrate nor seed runs again
    await k2.mod._reconcile();
    const ml2 = fs.readFileSync(path.join(k.dir, 'logs', 'migrate.log'), 'utf8');
    const added = ml2.slice(ml.length);
    check('A11 the second start only reads the database state: no migrate, no seed again (data kept)', /state \(exit 0\)/.test(added) && !/migrate \(exit/.test(added) && !/seed \(exit/.test(added), added);
    await stopAllIn(k2);
  }

  // ---- A12 backups: file, retention, disk guard -----------------------------------------------------------------
  {
    const k = await kit('a12');
    await k.mod._reconcile();
    const r1 = await k.mod.backupNow();
    check('A12 "Backup now" makes a file in the backup folder', r1.ok && fs.existsSync(path.join(k.cfg.backupDir, r1.file)), r1);
    for (let i = 0; i < 4; i += 1) await k.mod.backupNow();
    const files = fs.readdirSync(k.cfg.backupDir).filter((n) => /^greenstart-\d{8}-\d{6}\.ndjson\.gz$/.test(n));
    check('A12 only the newest 3 are kept (retention; the real default is 7)', files.length === 3, files);
    fs.writeFileSync(k.diskFile, '100');
    const r2 = await k.mod.backupNow();
    check('A12 disk guard: with too little free disk the backup is refused with a plain sentence', r2.ok === false && /disk/i.test(r2.error), r2);
    const s = await k.mod.snapshot();
    check('A12 status shows the backups (count, folder, keep)', s.backups.count === 3 && s.backups.keep === 3 && /green-start|backups/.test(s.backups.dir), s.backups);
    await stopAllIn(k);
  }

  // ---- A13 scrubbing of anything shown ----------------------------------------------------------------------------
  {
    const k = await kit('a13');
    const bad = [
      ['password=hunter2hunter2', 'hunter2'], ['"token": "abcDEF123456xyz"', 'abcDEF123456xyz'], ['Authorization: Bearer abcdefghijkl1234567890', 'abcdefghijkl1234567890'],
      ['mail to meera@greenstart.demo failed', 'meera@'], ['postgresql://gsuser:topsecret@127.0.0.1:5436/gs', 'topsecret'], ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJhbGci'],
      ['api_key=sk_live_51HxxxxxxxxxxxxxxxxxxxxXX', 'sk_live'], ['phone 919876543210 sent', '919876543210'], ['cookie: session=abc123def456ghi789', 'abc123def456'], ['key 0123456789abcdef0123456789abcdef0123', '0123456789abcdef0123456789abcdef'],
    ];
    const bleeds = bad.filter(([text, secret]) => k.mod.scrub(text).includes(secret));
    check('A13 scrub() hides passwords, tokens, bearer, e-mails, database / Redis addresses, JWTs, API keys, phone numbers, cookies, long keys', bleeds.length === 0, bleeds);
    check('A13 scrub() keeps normal sentences readable', k.mod.scrub('Nest application successfully started on port 4020') === 'Nest application successfully started on port 4020');
    k.mod.stopTimers();
  }
  Array.from(spawned).forEach(killPid);
}

// ===========================================================================================
function partC() {
  console.log('\n--- C. product source untouched, Redis settings, files ---');
  const mod = require(SUP_PATH); // eslint-disable-line global-require
  const conf = mod.buildRedisConf({ port: 6379, password: 'x'.repeat(48), dataDir: 'C:\\a\\b', logFile: 'C:\\a\\log.txt' });
  check('C1 buildRedisConf: bind 127.0.0.1 only, protected mode, never 0.0.0.0, password, 256 MB, no append file', /^bind 127\.0\.0\.1$/m.test(conf) && /^protected-mode yes$/m.test(conf) && !/0\.0\.0\.0|^bind .*::/m.test(conf) && /^requirepass x{48}$/m.test(conf) && /^maxmemory 256mb$/m.test(conf) && /^appendonly no$/m.test(conf));
  const manifest = fs.readFileSync(path.join(APP, 'run', 'SHA256-manifest-zip.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  let bad = 0; let missing = 0; let n = 0;
  for (const line of manifest) {
    const m = /^([0-9A-Fa-f]{64})\s+(.+)$/.exec(line);
    if (!m) continue;
    n += 1;
    const f = path.join(APP, m[2].trim());
    if (!fs.existsSync(f)) { missing += 1; continue; }
    if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase() !== m[1].toUpperCase()) bad += 1;
  }
  check(`C2 the Green Start product source is byte-identical to the zip: ${n} files checked against the manifest`, n >= 1800 && bad === 0 && missing === 0, { n, bad, missing });
  const ps1 = fs.readFileSync(path.join(APP, 'run', 'get-redis.ps1'), 'utf8');
  check('C3 get-redis.ps1: official GitHub URL as variables, key-press confirm, zip + redis-server.exe check, SHA-256, -Sha256, no service / registry / PATH', /\$Version = '5\.0\.14\.1'/.test(ps1) && /github\.com\/tporadowski\/redis\/releases\/download/.test(ps1) && /ReadKey/.test(ps1) && /redis-server\.exe/.test(ps1) && /Get-FileHash/.test(ps1) && /\[string\]\$Sha256/.test(ps1) && !/New-Service|sc\.exe|HKLM|HKCU|SetEnvironmentVariable|\$env:Path\s*=/i.test(ps1));
  const sup = fs.readFileSync(SUP_PATH, 'utf8');
  check('C4 the supervisor never writes into gs-api / green-start-web source (only reads); its only writes are under run/ and the backup folder', !/writeFileSync\([^)]*apiDir|writeFileSync\([^)]*webDir|mkdirSync\([^)]*webDir/.test(sup));
}

// ===========================================================================================
async function partB() {
  console.log('\n--- B. status API, permissions, rate limit, audit (temp backend on a COPY database) ---');
  const copy = process.env.COPY_DB;
  if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy)) || !fs.existsSync(copy)) { console.log('SKIP  part B needs COPY_DB=<a copy of the database> (never dev.db)'); return; }
  const PORT = Number(process.env.TEST_PORT || 4071);
  if (PORT === 4010 || PORT === 4045) { console.error('bad TEST_PORT'); process.exit(2); }
  const WORK = path.resolve(copy).replace(/\.db$/i, '-gssup-work.db');
  fs.copyFileSync(path.resolve(copy), WORK);
  const dbUrl = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
  process.env.DATABASE_URL = dbUrl; process.env.TEST_MODE = '1';
  require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
  process.env.DATABASE_URL = dbUrl;
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
  const prisma = require(path.join(BACK, 'src/db'));
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
  const A0 = require(path.join(BACK, 'src/outreach/access'));
  const p = { db: await freePort(), redis: await freePort(), api: await freePort(), gate: await freePort() };
  const dir = path.join(TMP, 'b'); fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
  fs.copyFileSync(path.join(APP, 'run', 'watchdog.cjs'), path.join(dir, 'run', 'watchdog.cjs'));
  fs.copyFileSync(path.join(APP, 'run', 'bind-local.cjs'), path.join(dir, 'run', 'bind-local.cjs'));
  fs.writeFileSync(path.join(dir, 'dbstate.json'), JSON.stringify({ migrations: 12, users: 3, contacts: 7 }));
  fs.writeFileSync(path.join(dir, 'freemb.txt'), '5000');
  const cfg = {
    runDir: path.join(dir, 'run'), apiDir: path.join(dir, 'api'), webDir: path.join(dir, 'web'), logsDir: path.join(dir, 'logs'), redisDir: path.join(dir, 'redisdir'), backupDir: path.join(dir, 'backups'),
    pgPort: p.db, redisPort: p.redis, apiPort: p.api, gatePort: p.gate, skipBuiltCheck: true, expectedMigrations: 12, pgCtl: null, redisExe: path.join(dir, 'none.exe'), teamlinkPort: PORT,
    tickMs: 1500, startDelayMs: 500, pollMs: 100, startTimeoutMs: 8000, fakeFreeMbFile: path.join(dir, 'freemb.txt'), watchdogMaxAgeMs: 60000, backupKeep: 3,
    commands: { db: stubCmd(['tcp', p.db]), redis: stubCmd(['redis', p.redis]), api: stubCmd(['http', p.api]), worker: stubCmd(['idle']), gate: stubCmd(['tcp', p.gate]), dbState: stubCmd(['state', path.join(dir, 'dbstate.json')]), migrate: stubCmd(['ok']), seed: stubCmd(['ok']), backup: stubCmd(['backup']) },
  };
  const cfgFile = path.join(dir, 'supervisor-test.json'); fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const API = `http://127.0.0.1:${PORT}`;
  const http = async (method, pth, token) => {
    const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetch(`${API}${pth}`, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body, text };
  };
  let server;
  try {
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } } // eslint-disable-line no-await-in-loop
    const bde = await first({ atsRole: 'BDE', ...live });
    const hr = await first({ atsRole: 'HR', ...live });
    const rec = await first({ atsRole: 'RECRUITER', ...live });
    check('B0 the copy has a Super Admin, a TL, a BDE, an HR login and a recruiter', !!(sa && tl && bde && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, hr, rec].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } }); // the COPY only: so these logins are not asked to change a starting password
    server = spawn(node, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT), GREENSTART_SUPERVISOR_TEST_CONFIG: cfgFile, GREENSTART_ENABLED: 'true', TEST_MOCK_PORTS: String(p.api), GREENSTART_CONTROL_RATE: '6', TL_RATE_LIMIT_IN_TEST: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); fail += 1; return; }
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tok(sa), tl: await tok(tl), bde: await tok(bde), hr: await tok(hr), rec: await tok(rec) };
    const ok = await until(async () => { const r = await http('GET', '/api/omni-gs/status', T.sa); return r.body && r.body.state === 'running'; }, 40000, 500);
    const st = await http('GET', '/api/omni-gs/status', T.sa);
    check('B1 the temp backend starts the stub Green Start by itself (autostart): state "running"', ok, st.text.slice(0, 300));
    const b = st.body || {};
    check('B2 status for an Admin: every part, state words, ram, disk, contacts (own), backups, canControl true', ['db', 'redis', 'api', 'worker', 'gate'].every((n) => b.parts && b.parts[n] && b.parts[n].ok) && b.stateText === 'Running' && b.ram && b.disk && b.contacts === 7 && b.canControl === true && b.db === true && b.gate === true && b.api === true && b.redis === true && typeof b.port === 'number', Object.keys(b));
    const stTl = await http('GET', '/api/omni-gs/status', T.tl);
    check('B3 a TL and HR may read the status; canControl is false for them', stTl.status === 200 && stTl.body.canControl === false && (await http('GET', '/api/omni-gs/status', T.hr)).body.canControl === false);
    check('B4 BDE and Recruiter get 403; no login gets 401', (await http('GET', '/api/omni-gs/status', T.bde)).status === 403 && (await http('GET', '/api/omni-gs/status', T.rec)).status === 403 && (await http('GET', '/api/omni-gs/status')).status === 401);
    const noAdmin = await Promise.all(['start', 'stop', 'restart', 'backup'].map((a) => http('POST', `/api/omni-gs/${a}`, T.tl)));
    const noAdminHr = await Promise.all(['start', 'stop', 'restart', 'backup'].map((a) => http('POST', `/api/omni-gs/${a}`, T.hr)));
    const noLog = await http('GET', '/api/omni-gs/log?part=api', T.tl);
    check('B5 Start / Stop / Restart / Backup and Show log are 403 for a TL and for HR (Admin / Super Admin only)', [...noAdmin, ...noAdminHr, noLog].every((r) => r.status === 403), [...noAdmin, ...noAdminHr, noLog].map((r) => r.status));
    check('B5 and 403 for BDE and Recruiter, 401 without a login', (await http('POST', '/api/omni-gs/stop', T.bde)).status === 403 && (await http('POST', '/api/omni-gs/stop', T.rec)).status === 403 && (await http('POST', '/api/omni-gs/stop')).status === 401);
    check('B5 the stub is still running after all those refused presses', (await tcpOpen(p.db)) && (await tcpOpen(p.gate)));
    const auditBefore = await prisma.auditLog.count({ where: { action: { startsWith: 'Green Start:' } } });
    const bk = await http('POST', '/api/omni-gs/backup', T.sa);
    check('B6 Super Admin: Backup now works and the file exists', bk.status === 200 && bk.body.ok && fs.readdirSync(cfg.backupDir).length === 1, bk.text.slice(0, 200));
    const lg = await http('GET', '/api/omni-gs/log?part=supervisor', T.sa);
    check('B6 Super Admin: Show log returns lines (supervisor)', lg.status === 200 && Array.isArray(lg.body.lines) && lg.body.lines.length > 0, lg.text.slice(0, 200));
    check('B6 an unknown log part is refused (400)', (await http('GET', '/api/omni-gs/log?part=../../etc', T.sa)).status === 400);
    const stop = await http('POST', '/api/omni-gs/stop', T.sa);
    const down = await until(async () => !(await tcpOpen(p.db)) && !(await tcpOpen(p.gate)), 25000, 300);
    check('B7 Super Admin Stop really stops the parts', stop.status === 200 && down, stop.text.slice(0, 120));
    await sleep(2500);
    check('B7 the next tick does not start it again (stays stopped)', !(await tcpOpen(p.db)) && (await http('GET', '/api/omni-gs/status', T.sa)).body.state === 'stopped');
    const start = await http('POST', '/api/omni-gs/start', T.sa);
    const up = await until(async () => (await http('GET', '/api/omni-gs/status', T.sa)).body.state === 'running', 40000, 500);
    check('B7 Start runs it again', start.status === 200 && up);
    const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: 'Green Start:' } }, orderBy: { createdAt: 'desc' }, take: 20 });
    check('B8 every Admin press is an audit row (Backup now, Stop, Start) with the person\'s id', audits.length - auditBefore >= 3 && ['Green Start: Backup now', 'Green Start: Stop', 'Green Start: Start'].every((a) => audits.some((r) => r.action === a && r.userId === sa.id)), audits.map((r) => r.action));
    check('B8 refused presses (TL, HR) wrote no audit row', !audits.some((r) => r.userId === tl.id || r.userId === hr.id));
    let last = null;
    for (let i = 0; i < 8; i += 1) { last = await http('GET', '/api/omni-gs/log?part=supervisor', T.sa); if (last.status === 429) break; } // eslint-disable-line no-await-in-loop
    check('B9 rate limit: too many presses in a minute -> 429 with Retry-After words', last.status === 429 && /wait/i.test(last.body.error) && last.body.retryAfter >= 1, last && last.text.slice(0, 200));
    check('B9 the rate limit counts per login: another Admin-kind login is not blocked, a TL still gets 403 (not 429)', (await http('GET', '/api/omni-gs/log?part=api', T.tl)).status === 403);
    const session = await http('POST', '/api/omni-gs/session', T.sa);
    check('B10 the cookie session endpoint still works for an Admin (unchanged)', session.status === 200 && session.body.ok === true);
    check('B10 /api/omni-gs/verify without a cookie is 401 (unchanged)', (await http('GET', '/api/omni-gs/verify')).status === 401);
  } finally {
    if (server) { try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ } }
    cleanupDir(dir);
    for (const n of ['db', 'redis', 'api', 'worker', 'gate']) { const j = rd(path.join(dir, 'logs', `${n}.pid`)); if (j && j.pid) killPid(j.pid); }
    try { await prisma.$disconnect(); } catch { /* ignore */ }
  }
}

(async () => {
  try {
    if (!process.env.ONLY || process.env.ONLY.includes('A')) await partA();
    if (!process.env.ONLY || process.env.ONLY.includes('C')) partC();
    if (!process.env.ONLY || process.env.ONLY.includes('B')) await partB();
  } catch (e) { fail += 1; console.log(`FAIL  test crashed: ${e && e.stack}`); }
  Array.from(spawned).forEach(killPid);
  if (current) { current.mod.stopTimers(); cleanupDir(current.dir); }
  try { for (const d of fs.readdirSync(TMP)) cleanupDir(path.join(TMP, d)); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 500);
})();
