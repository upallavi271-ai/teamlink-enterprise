// ---------------------------------------------------------------------------
// GREEN START SUPERVISOR (2026-10-22): the TeamLink backend starts and looks after Green Start (the founder's own Omni-Channel product in
// green-start-app/), the same way it looks after the Job Portal (utils/jobPortalEmbed.js). Nobody has to double-click anything.
//
// WHAT IT KEEPS RUNNING (each one a hidden background program, no console windows unless GREENSTART_SHOW_WINDOWS=1):
//   1 db      portable PostgreSQL 16 (run/pg-tool/pg.mjs)     127.0.0.1:5436   Green Start's OWN database (data in run/pgdata)
//   2 redis   run/redis/redis-server.exe, if the founder put it there (get-redis.cmd) - or any Redis that already answers (Memurai ...)
//   3 prepare database migrations (idempotent) + demo workspace on the very first start (run/seed-demo.cjs)
//   4 api     the product's server (dist/main)                 127.0.0.1:4020   + worker (dist/queue/worker.bootstrap, needs Redis)
//   5 gate    the entrance (run/gate.mjs)                      127.0.0.1:5190   what the Omni-Channel page opens
// WITHOUT Redis the product's server never opens its port (it waits for a queue write forever), so api and worker are NOT started then:
// the state is "Waiting for Redis" and nothing burns memory for nothing.
//
// SAFETY: free RAM below GREENSTART_MIN_FREE_MB (1200) = "Waiting for memory", looked at again every 60 s. A crashed part restarts with
// back-off (5 s, 15 s, 45 s, 2 min); more than GREENSTART_MAX_RESTARTS (5) starts in one hour = it stops trying and reports "Crashed".
// One supervisor at a time (lock file). Parts a person started with start-green-start.cmd are recognised and adopted (never killed here,
// except by the admin Stop button, which runs the launcher's own stop script). Parts started HERE survive a nodemon restart of this backend
// (pid files in run/logs), and are stopped cleanly (database with pg_ctl) when this backend is stopped for real, or - by run/watchdog.cjs -
// when this backend has been silent for 2 minutes.
//
// SWITCHES (names only): GREENSTART_ENABLED (default on), GREENSTART_AUTOSTART (default on; off = look but do not start; the admin Start
// button still works), GREENSTART_SHOW_WINDOWS, GREENSTART_MIN_FREE_MB, GREENSTART_MAX_RESTARTS, GREENSTART_AUTOSEED (default on),
// GREENSTART_BACKUP_DIR, GREENSTART_MIN_DISK_MB, GREENSTART_API_HEAP_MB (512) / GREENSTART_WORKER_HEAP_MB (384): the memory ceiling of those two parts (a small PC sets 320 / 256), GREENSTART_REDIS_PORT, GREENSTART_PG_PORT, GREENSTART_API_PORT, GREENSTART_GATE_PORT,
// GREENSTART_SUPERVISE (false = live server: Green Start is a separate systemd service; this module starts, stops and writes nothing).
// Never in the TEST SANDBOX unless the test hands over a settings file (GREENSTART_SUPERVISOR_TEST_CONFIG, honoured only with TEST_MODE=1).
// Never writes to the Green Start product source. No secrets in logs (scrub()).
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const falsy = (v) => /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim());
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const APP_DIR = path.resolve(__dirname, '..', '..', '..', 'green-start-app');
const ORDER = ['db', 'redis', 'api', 'worker', 'gate'];
const LABEL = { db: 'Database', redis: 'Redis (message queue)', api: 'Green Start server', worker: 'Campaign sender (worker)', gate: 'Entrance' };
const LOG_PREFIX = { db: 'pg', redis: 'redis', api: 'api', worker: 'worker', gate: 'gate' };
const STEPS = ['Database', 'Redis (message queue)', 'Preparing the database', 'Green Start server and sender', 'Entrance'];

// ---- settings --------------------------------------------------------------
function isSandbox() { try { return require('./sandbox').isSandbox(); } catch { return false; } } // eslint-disable-line global-require
let T = null; // test settings (sandbox only)
function loadTestConfig() {
  const f = process.env.GREENSTART_SUPERVISOR_TEST_CONFIG;
  if (!f || !truthy(process.env.TEST_MODE)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
const enabled = () => !falsy(process.env.GREENSTART_ENABLED);
const autostart = () => !falsy(process.env.GREENSTART_AUTOSTART);
// GREENSTART_SUPERVISE=false (the live server): Green Start runs there as its own separate service (systemd). This backend then starts, stops and
// watches NOTHING: no processes, no lock / pid / log files. GREENSTART_ENABLED stays on, because the door-pass check (/api/omni-gs/verify) needs it.
const supervise = () => !falsy(process.env.GREENSTART_SUPERVISE);
const EXTERNAL_TEXT = 'Green Start runs as a separate service on this server';
const showWindows = () => truthy(process.env.GREENSTART_SHOW_WINDOWS);

function cfg() {
  const t = T || {};
  const runDir = path.resolve(t.runDir || path.join(APP_DIR, 'run'));
  const apiDir = path.resolve(t.apiDir || path.join(APP_DIR, 'gs-api'));
  const webDir = path.resolve(t.webDir || path.join(APP_DIR, 'green-start-web'));
  const home = os.homedir() || os.tmpdir();
  return {
    appDir: path.resolve(t.appDir || APP_DIR), runDir, apiDir, webDir,
    logsDir: path.resolve(t.logsDir || path.join(runDir, 'logs')),
    redisDir: path.resolve(t.redisDir || path.join(runDir, 'redis')),
    backupDir: path.resolve(t.backupDir || process.env.GREENSTART_BACKUP_DIR || path.join(home, '.teamlink-backups', 'green-start')),
    ports: {
      db: num(t.pgPort || process.env.GREENSTART_PG_PORT, 5436),
      redis: num(t.redisPort || process.env.GREENSTART_REDIS_PORT, 6379),
      api: num(t.apiPort || process.env.GREENSTART_API_PORT, 4020),
      gate: num(t.gatePort || process.env.GREENSTART_GATE_PORT, 5190),
    },
    minFreeMB: num(t.minFreeMB || process.env.GREENSTART_MIN_FREE_MB, 1200),
    hardFloorMB: num(t.hardFloorMB, 250),
    maxRestarts: num(t.maxRestarts || process.env.GREENSTART_MAX_RESTARTS, 5),
    backoffMs: t.backoffMs || [5000, 15000, 45000, 120000],
    tickMs: num(t.tickMs, 10000),
    startDelayMs: t.startDelayMs != null ? t.startDelayMs : 5000,
    memoryRetryMs: num(t.memoryRetryMs, 60000),
    startTimeoutMs: num(t.startTimeoutMs, 150000),
    // the database may need minutes to start / recover on a PC that is short of memory (GREENSTART_DB_START_TIMEOUT_S, default 300): starting it again meanwhile only makes two fight over the same files
    dbStartTimeoutMs: num(t.dbStartTimeoutMs || (Number(process.env.GREENSTART_DB_START_TIMEOUT_S) > 0 ? Number(process.env.GREENSTART_DB_START_TIMEOUT_S) * 1000 : 0), 300000),
    pollMs: num(t.pollMs, 500),
    statsEveryMs: num(t.statsEveryMs, 300000),
    heartbeatMs: num(t.heartbeatMs, 5000),
    watchdogMaxAgeMs: num(t.watchdogMaxAgeMs, 120000),
    watchdogCheckMs: num(t.watchdogCheckMs, 10000),
    minDiskMB: num(t.minDiskMB || process.env.GREENSTART_MIN_DISK_MB, 1500),
    backupEveryMs: num(t.backupEveryMs, 24 * 3600 * 1000),
    backupKeep: num(t.backupKeep, 7),
    commands: t.commands || {},
    redisExe: t.redisExe !== undefined ? t.redisExe : path.join(runDir, 'redis', 'redis-server.exe'),
    fakeFreeMbFile: t.fakeFreeMbFile || null,
    fakeDiskMbFile: t.fakeDiskMbFile || null,
    skipBuiltCheck: !!t.skipBuiltCheck,
    pgCtl: t.pgCtl !== undefined ? t.pgCtl : findPgCtl(runDir),
    teamlinkPort: num(t.teamlinkPort || process.env.PORT, 4010),
  };
}
function findPgCtl(runDir) {
  const p = path.join(runDir, 'pg-tool', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin', 'pg_ctl.exe');
  return fs.existsSync(p) ? p : null;
}
const logPath = (name, kind) => path.join(cfg().logsDir, `${LOG_PREFIX[name] || name}.${kind}.log`);
const pidPath = (name) => path.join(cfg().logsDir, `${name}.pid`);

// ---- plain helpers ---------------------------------------------------------
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const bootTime = () => now() - os.uptime() * 1000;
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, o) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch { /* next time */ } }
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    else process.kill(pid, 'SIGTERM');
  } catch { /* gone */ }
}
function tcp(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { s.destroy(); } catch { /* gone */ } resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function httpOk(port, urlPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const r = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.on('error', () => resolve(false));
    } catch { resolve(false); } // the test sandbox refuses ports it does not know (TEST_MOCK_PORTS)
  });
}
// Redis speaks RESP: AUTH (when a password is known) + PING. 'pong' | 'noauth' (answers, but wants a password we do not have) | 'down' | 'other'
function redisProbe(port, password, timeoutMs = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let buf = ''; let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { s.destroy(); } catch { /* gone */ } resolve(v); };
    const verdict = () => {
      if (/\+PONG/.test(buf)) return 'pong';
      if (/NOAUTH|WRONGPASS|invalid password|ERR.*AUTH/i.test(buf)) return 'noauth';
      return null;
    };
    s.setTimeout(timeoutMs, () => done(buf ? 'other' : 'down'));
    s.once('error', () => done('down'));
    s.once('connect', () => {
      const auth = password ? `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n` : '';
      s.write(`${auth}*1\r\n$4\r\nPING\r\n`);
    });
    s.on('data', (d) => { buf += d.toString('latin1'); const v = verdict(); if (v) done(v); });
    s.on('close', () => done(verdict() || 'down'));
  });
}

// ---- keeping secrets out of anything we show or write ----------------------
function scrub(text, extra = []) {
  let s = String(text == null ? '' : text);
  for (const sec of extra) if (sec && String(sec).length >= 6) s = s.split(String(sec)).join('***');
  s = s.replace(/\b(postgres(?:ql)?|rediss?|mongodb|amqps?|mysql|https?):\/\/[^\s'"<>)]*@[^\s'"<>)]*/gi, '$1://***');
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***');
  s = s.replace(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g, '***@***');
  s = s.replace(/(["']?[\w.-]*(?:secret|token|passw(?:or)?d|pwd|apikey|api_key|api-key|auth|cookie|credential|private|key)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1***');
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, '***');
  s = s.replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '***');
  s = s.replace(/\b\d{10,}\b/g, '***');
  return s;
}
function redisSecret() {
  const f = path.join(cfg().redisDir, 'redis.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
}
const secretsNow = () => [redisSecret()].filter(Boolean);
const clean = (t) => scrub(t, secretsNow());

// ---- Redis settings file (never listens on anything but this computer) ------
function buildRedisConf({ port, password, dataDir, logFile }) {
  const fwd = (p) => String(p).replace(/\\/g, '/');
  return [
    '# Written by the TeamLink supervisor (utils/greenStartSupervisor.js). Do not edit: it is rewritten at every start.',
    'bind 127.0.0.1',            // this computer only - never 0.0.0.0
    'protected-mode yes',
    `port ${port}`,
    `requirepass ${password}`,
    'maxmemory 256mb',
    'maxmemory-policy noeviction', // a queue must never silently drop a job
    'appendonly no',
    'save 300 1',                  // a small snapshot every 5 minutes, so scheduled campaigns survive a restart
    'dbfilename gs.rdb',
    `dir ${fwd(dataDir)}`,
    `logfile ${fwd(logFile)}`,
    'tcp-keepalive 60',
    '',
  ].join('\n');
}
function envRedis() {
  // REDIS_URL from gs-api\.env (config the product reads); used to recognise a Redis that already runs (Memurai, ...)
  try {
    const m = /^REDIS_URL="?([^"\r\n]+)"?/m.exec(fs.readFileSync(path.join(cfg().apiDir, '.env'), 'utf8'));
    if (m) { const u = new URL(m[1]); return { port: Number(u.port) || 6379, password: decodeURIComponent(u.password || '') }; }
  } catch { /* none */ }
  return { port: cfg().ports.redis, password: '' };
}

// ---- state -----------------------------------------------------------------
const mkPart = () => ({
  up: false, managed: false, adopted: false, pid: null, startedAt: null, child: null, exit: null, restarts: [], crashes: 0,
  givenUp: false, nextTryAt: 0, lastError: null, lastErrorLines: [], note: null,
});
const S = {
  started: false, passive: false, holder: null, startedAt: null,
  override: null, // 'start' | 'stop' | null (null = follow GREENSTART_AUTOSTART)
  parts: Object.fromEntries(ORDER.map((n) => [n, mkPart()])),
  redis: { kind: 'missing', port: null, usable: false, note: null }, // own | external | unusable | missing
  migrate: { done: false, error: null, expected: null, count: null, seeded: false, seedTried: false, tries: 0, nextTryAt: 0, gaveUp: false },
  stats: { users: null, contacts: null, migrations: null, at: 0 },
  state: 'idle', step: 0, memBlocked: false, memNextTry: 0, memGrantUntil: 0, freeMB: null,
  busy: false, stopping: false, lastReconcileAt: 0, lastObserveAt: 0,
  backup: { running: false, lastAt: null, lastOk: null, lastError: null, lastFile: null },
  watchdog: null, timers: [],
};

function stateFile() { return path.join(cfg().logsDir, 'supervisor-state.json'); }
function lockFile() { return path.join(cfg().logsDir, 'supervisor.lock'); }
const heartbeatFile = () => path.join(cfg().logsDir, 'heartbeat');
function supLog(msg) {
  const line = `${new Date().toISOString()} ${clean(msg)}\n`;
  try { fs.mkdirSync(cfg().logsDir, { recursive: true }); rotateIfBig(path.join(cfg().logsDir, 'supervisor.log'), 2 * 1024 * 1024, false); fs.appendFileSync(path.join(cfg().logsDir, 'supervisor.log'), line); } catch { /* no log */ }
  if (!isSandbox()) console.log(`[green-start] ${clean(msg)}`); // eslint-disable-line no-console
}
function rotateIfBig(file, max, copyTruncate) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= max) return;
    const old = `${file}.1`;
    try { fs.rmSync(old, { force: true }); } catch { /* ignore */ }
    if (copyTruncate) { fs.copyFileSync(file, old); fs.truncateSync(file, 0); } else fs.renameSync(file, old);
  } catch { /* in use: next time */ }
}

// ---- free memory / disk ----------------------------------------------------
function freeMB() {
  const c = cfg();
  if (c.fakeFreeMbFile) { const v = Number(String(readText(c.fakeFreeMbFile)).trim()); if (Number.isFinite(v)) return v; }
  return Math.round(os.freemem() / 1048576);
}
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }
function freeDiskMB() {
  const c = cfg();
  if (c.fakeDiskMbFile) { const v = Number(String(readText(c.fakeDiskMbFile)).trim()); if (Number.isFinite(v)) return v; }
  try { const st = fs.statfsSync(c.runDir); return Math.round((st.bavail * st.bsize) / 1048576); } catch { return null; }
}

// ---- what each part is and how to start it ---------------------------------
const PASS_THROUGH = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|COMPUTERNAME|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|TZ)$/i;
function cleanEnv(extra = {}) {
  // A CLEAN environment: this backend's DATABASE_URL (SQLite), PORT, JWT_SECRET ... must never reach Green Start.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (PASS_THROUGH.test(k)) env[k] = v;
  return { ...env, ...extra };
}
const fwd = (p) => String(p).replace(/\\/g, '/');
const optPath = (p) => (/\s/.test(p) ? `"${fwd(p)}"` : fwd(p));
function redisUrlForChildren() {
  if (S.redis.kind === 'own' && S.redis.port) return `redis://:${encodeURIComponent(redisSecret())}@127.0.0.1:${S.redis.port}`;
  return null; // external Redis: the product's own .env REDIS_URL stays as it is
}
// what each part is told through its environment (the same for the real program and for a test stand-in)
function partEnv(name) {
  const c = cfg();
  const redisUrl = redisUrlForChildren();
  if (name === 'api') return { NODE_OPTIONS: `--require ${optPath(path.join(c.runDir, 'bind-local.cjs'))} --max-old-space-size=${num(process.env.GREENSTART_API_HEAP_MB, 512)}`, PORT: String(c.ports.api), ...(redisUrl ? { REDIS_URL: redisUrl } : {}) };
  if (name === 'worker') return { NODE_OPTIONS: `--max-old-space-size=${num(process.env.GREENSTART_WORKER_HEAP_MB, 384)}`, PORT: String(c.ports.api), ...(redisUrl ? { REDIS_URL: redisUrl } : {}) };
  if (name === 'gate') return { GATE_PORT: String(c.ports.gate), GS_API_PORT: String(c.ports.api), TEAMLINK_URL: `http://127.0.0.1:${c.teamlinkPort}` };
  return {};
}
function commandFor(name) {
  const c = cfg();
  const o = c.commands[name];
  if (o && o.cmd) return { cmd: o.cmd, args: o.args || [], cwd: o.cwd || c.runDir, env: cleanEnv({ ...partEnv(name), ...(o.env || {}) }) };
  const node = process.execPath;
  if (name === 'db') return { cmd: node, args: ['pg.mjs'], cwd: path.join(c.runDir, 'pg-tool'), env: cleanEnv() };
  if (name === 'redis') return { cmd: c.redisExe, args: [path.join(c.redisDir, 'redis-gs.conf')], cwd: c.redisDir, env: cleanEnv() };
  if (name === 'api') {
    return { cmd: node, args: ['--env-file=.env', 'dist/main'], cwd: c.apiDir, env: cleanEnv(partEnv('api')) };
  }
  if (name === 'worker') {
    return { cmd: node, args: ['--env-file=.env', 'dist/queue/worker.bootstrap'], cwd: c.apiDir, env: cleanEnv(partEnv('worker')) };
  }
  if (name === 'gate') {
    return { cmd: node, args: ['gate.mjs'], cwd: c.runDir, env: cleanEnv(partEnv('gate')) };
  }
  return null;
}
function built() {
  const c = cfg();
  if (c.skipBuiltCheck) return { ok: true, problems: [] };
  const problems = [];
  if (!fs.existsSync(path.join(c.apiDir, '.env'))) problems.push('gs-api\\.env (local settings) is missing');
  if (!fs.existsSync(path.join(c.apiDir, 'node_modules'))) problems.push('gs-api packages are not installed (npm ci)');
  if (!fs.existsSync(path.join(c.apiDir, 'dist', 'main.js'))) problems.push('the Green Start server is not built');
  if (!fs.existsSync(path.join(c.webDir, 'dist', 'index.html'))) problems.push('the Green Start screens are not built');
  if (!fs.existsSync(path.join(c.runDir, 'pg-tool', 'node_modules'))) problems.push('the portable database tool is missing (run\\pg-tool)');
  return { ok: problems.length === 0, problems };
}

// ---- checks ----------------------------------------------------------------
function launcherPid(key) { // pids.json is written by start-green-start.ps1 (the PowerShell window of each part)
  const j = readJson(path.join(cfg().runDir, 'pids.json'));
  return j && j[key] ? Number(j[key]) : null;
}
function ownPid(name) {
  const j = readJson(pidPath(name));
  if (!j || !j.pid || !alive(j.pid)) return null;
  if (j.startedAt && j.startedAt < bootTime() - 60000) return null; // written before the last reboot: the number may belong to someone else now
  return j;
}
async function redisCheck() {
  const own = readJson(path.join(cfg().redisDir, 'redis.json'));
  if (own && own.port && ownPid('redis')) {
    const r = await redisProbe(own.port, redisSecret());
    if (r === 'pong') return { kind: 'own', port: own.port, usable: true };
  }
  const env = envRedis();
  const r = await redisProbe(env.port, env.password);
  if (r === 'pong') return { kind: 'external', port: env.port, usable: true };
  if (r === 'noauth') return { kind: 'unusable', port: env.port, usable: false, note: `A Redis answers on port ${env.port} but wants a password this app does not have.` };
  if (r === 'other') return { kind: 'unusable', port: env.port, usable: false, note: `Something on port ${env.port} is not a working Redis.` };
  return { kind: 'missing', port: null, usable: false, note: null };
}
async function checkUp(name) {
  const c = cfg();
  if (name === 'db') return tcp(c.ports.db);
  if (name === 'gate') return tcp(c.ports.gate);
  if (name === 'api') return httpOk(c.ports.api, '/api/v1/health');
  if (name === 'redis') { S.redis = await redisCheck(); return S.redis.usable; }
  if (name === 'worker') {
    const o = ownPid('worker');
    if (o) return true;
    return alive(launcherPid('WORKER'));
  }
  return false;
}
async function observe() {
  const res = await Promise.all(ORDER.map((n) => checkUp(n)));
  ORDER.forEach((n, i) => {
    const p = S.parts[n];
    const own = ownPid(n);
    p.up = res[i];
    p.managed = !!own;
    p.pid = own ? own.pid : null;
    p.adopted = p.up && !own;
    if (p.up) p.lastUpAt = now();
  });
  S.lastObserveAt = now();
}

// ---- logs of the parts -----------------------------------------------------
function tail(file, n) {
  try {
    const st = fs.statSync(file);
    if (!st.size) return [];
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}
function lastErrorLines(name) {
  let lines = tail(logPath(name, 'err'), 3);
  if (!lines.length) lines = tail(logPath(name, 'out'), 3);
  return lines.map((l) => clean(l).slice(0, 220));
}
function readLog(which, lines = 80) {
  const c = cfg();
  const n = Math.max(1, Math.min(200, Number(lines) || 80));
  const out = [];
  if (which === 'supervisor' || !which) return { part: 'supervisor', lines: tail(path.join(c.logsDir, 'supervisor.log'), n).map(clean) };
  if (which === 'migrate') return { part: 'migrate', lines: tail(path.join(c.logsDir, 'migrate.log'), n).map(clean) };
  if (!ORDER.includes(which)) return { part: which, lines: [], error: 'Unknown part.' };
  const errs = tail(logPath(which, 'err'), Math.ceil(n / 2));
  const outs = tail(logPath(which, 'out'), n - errs.length);
  if (errs.length) out.push(`--- problems (${LOG_PREFIX[which]}.err.log) ---`, ...errs);
  if (outs.length) out.push(`--- output (${LOG_PREFIX[which]}.out.log) ---`, ...outs);
  return { part: which, lines: out.map(clean).slice(-(n + 2)) };
}

// ---- starting and stopping one part ---------------------------------------
function writeRedisFiles(port) {
  const c = cfg();
  fs.mkdirSync(c.redisDir, { recursive: true });
  const dataDir = path.join(c.runDir, 'redis-data');
  fs.mkdirSync(dataDir, { recursive: true });
  let secret = redisSecret();
  if (!secret) { secret = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(path.join(c.redisDir, 'redis.secret'), secret, { mode: 0o600 }); }
  fs.writeFileSync(path.join(c.redisDir, 'redis-gs.conf'), buildRedisConf({ port, password: secret, dataDir, logFile: path.join(c.logsDir, 'redis-server.log') }));
  writeJson(path.join(c.redisDir, 'redis.json'), { port });
}
async function freePortFrom(start) {
  for (let p = start; p < start + 12; p += 1) if (!(await tcp(p, 300))) return p;
  return null;
}
async function spawnPart(name) {
  const c = cfg();
  const p = S.parts[name];
  if (name === 'redis') {
    const port = await freePortFrom(c.ports.redis);
    if (!port) { p.lastError = `No free port near ${c.ports.redis} for Redis.`; return false; }
    writeRedisFiles(port);
  }
  const cmd = commandFor(name);
  if (!cmd || !cmd.cmd) return false;
  fs.mkdirSync(c.logsDir, { recursive: true });
  rotateIfBig(logPath(name, 'out'), 5 * 1024 * 1024, false);
  rotateIfBig(logPath(name, 'err'), 5 * 1024 * 1024, false);
  const out = fs.openSync(logPath(name, 'out'), 'a');
  const err = fs.openSync(logPath(name, 'err'), 'a');
  // WINDOWS, a part this supervisor starts itself: launched THROUGH a short-lived PowerShell, so it is not a descendant of this backend. A dev server
  // (nodemon) restarts the backend on every code change and kills its whole process tree; as plain children the database, Redis, the server and the sender died with
  // it each time, the database was left to crash-recover for minutes, and Green Start ended up "Crashed". Launched this way they survive a backend restart and are
  // found again by their pid files (run/watchdog.cjs still stops everything when the backend stays away). GREENSTART_DETACH=0 switches this off.
  if (detachedLaunch(name)) {
    fs.closeSync(out); fs.closeSync(err);
    const pid = launchDetachedWin(name, cmd);
    if (!pid) { p.lastError = clean('could not start (the PowerShell launcher gave no process id)'); return false; }
    p.child = null; p.exit = null; p.startedAt = now(); p.pid = pid; p.managed = true;
    writeJson(pidPath(name), { pid, startedAt: p.startedAt, by: 'supervisor' });
    p.restarts.push(now());
    p.restarts = p.restarts.filter((t) => now() - t < 3600 * 1000);
    const waitMs = c.backoffMs[Math.min(Math.max(p.restarts.length - 1, 0), c.backoffMs.length - 1)];
    p.nextTryAt = now() + waitMs;
    supLog(`started ${LABEL[name]} (pid ${pid}, detached)`);
    return true;
  }
  let child;
  try {
    child = spawn(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, windowsHide: !showWindows(), stdio: ['ignore', out, err] });
  } catch (e) {
    p.lastError = clean(`could not start: ${e.message}`);
    fs.closeSync(out); fs.closeSync(err);
    return false;
  }
  fs.closeSync(out); fs.closeSync(err);
  p.child = child; p.exit = null; p.startedAt = now(); p.pid = child.pid; p.managed = true;
  child.on('error', (e) => { p.exit = { code: -1, at: now(), error: clean(e.message) }; });
  child.on('exit', (code, sig) => { p.exit = { code, sig, at: now() }; });
  child.unref();
  writeJson(pidPath(name), { pid: child.pid, startedAt: p.startedAt, by: 'supervisor' });
  p.restarts.push(now());
  p.restarts = p.restarts.filter((t) => now() - t < 3600 * 1000);
  const wait = c.backoffMs[Math.min(Math.max(p.restarts.length - 1, 0), c.backoffMs.length - 1)];
  p.nextTryAt = now() + wait;
  supLog(`started ${LABEL[name]} (pid ${child.pid})`);
  return true;
}
// ---- detached launch on Windows (see spawnPart) ----
function detachedLaunch(name) {
  if (process.platform !== 'win32' || process.env.GREENSTART_DETACH === '0') return false;
  const o = cfg().commands && cfg().commands[name];
  return !(o && o.cmd); // a test stand-in command keeps the plain way
}
function launchDetachedWin(name, cmd) {
  const c = cfg();
  const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
  const file = path.join(c.logsDir, `${name}.start.cmd`);
  fs.writeFileSync(file, ['@echo off', `cd /d ${q(cmd.cwd)}`, `${q(cmd.cmd)} ${(cmd.args || []).map(q).join(' ')} >> ${q(logPath(name, 'out'))} 2>> ${q(logPath(name, 'err'))}`, ''].join('\r\n'));
  const style = showWindows() ? 'Normal' : 'Hidden';
  const script = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '"${file.replace(/'/g, "''")}"' -WindowStyle ${style} -PassThru; $p.Id`;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: cmd.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const pid = parseInt(String(r.stdout || '').trim().split(/\r?\n/).pop(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function dropPid(name) { try { fs.unlinkSync(pidPath(name)); } catch { /* gone */ } }
function killPart(name) {
  const o = readJson(pidPath(name));
  if (o && o.pid && alive(o.pid)) killTree(o.pid);
  dropPid(name);
}
function markCrash(name, reason) {
  const p = S.parts[name];
  p.crashes += 1;
  p.lastErrorLines = lastErrorLines(name);
  p.lastError = clean(reason);
  p.managed = false; p.pid = null; p.child = null; p.exit = null;
  dropPid(name);
  supLog(`${LABEL[name]} stopped unexpectedly: ${reason}`);
}
function canStart(name) {
  const c = cfg();
  const p = S.parts[name];
  if (p.givenUp) return false;
  const recent = p.restarts.filter((t) => now() - t < 3600 * 1000).length;
  if (recent >= c.maxRestarts) {
    p.givenUp = true;
    p.lastError = p.lastError || `Stopped ${recent} times in one hour; not trying again until an Admin presses Start.`;
    p.lastErrorLines = p.lastErrorLines.length ? p.lastErrorLines : lastErrorLines(name);
    supLog(`giving up on ${LABEL[name]}: ${recent} starts in one hour`);
    return false;
  }
  return now() >= p.nextTryAt;
}
async function waitUp(name, timeoutMs) {
  const c = cfg();
  const p = S.parts[name];
  const t0 = now();
  const minLife = name === 'worker' ? 2500 : 0; // the worker has no port: alive for a moment = started
  while (now() - t0 < timeoutMs) {
    if (aborted()) return false;
    if (p.exit) return false;
    if (name === 'worker') { if (now() - t0 >= minLife && alive(p.pid)) { p.up = true; return true; } } else if (await checkUp(name)) { p.up = true; return true; }
    if (p.pid && !alive(p.pid) && now() - t0 > 1500) return false;
    await sleep(c.pollMs);
  }
  return false;
}
const aborted = () => S.stopping || S.passive || !wanted();
const codeText = (e) => (e && e.code !== null && e.code !== undefined ? e.code : 'none');
// returns true when the part is up at the end
async function ensure(name) {
  const c = cfg();
  const p = S.parts[name];
  if (p.up) return true;
  if (aborted()) return false;
  const own = ownPid(name);
  if (own) { // started in this or an earlier life of this backend and not answering yet
    const limit = name === 'db' ? c.dbStartTimeoutMs : c.startTimeoutMs;
    if (now() - own.startedAt < limit) return false;
    killPart(name); markCrash(name, `did not answer within ${Math.round(limit / 1000)} seconds`);
  } else if (p.child) {
    markCrash(name, p.exit ? `exited (code ${codeText(p.exit)})` : 'is no longer running');
  } else {
    const stale = readJson(pidPath(name));
    if (stale) { if (stale.startedAt && stale.startedAt >= bootTime() - 60000) markCrash(name, 'is no longer running'); else dropPid(name); }
  }
  if (!canStart(name)) return false;
  if (!memoryOk()) return false;
  if (!(await spawnPart(name))) return false;
  const startLimit = name === 'db' ? c.dbStartTimeoutMs : c.startTimeoutMs;
  const ok = await waitUp(name, startLimit);
  if (aborted()) return false;
  if (!ok) {
    const exited = !!p.exit;
    const e = p.exit;
    killPart(name);
    markCrash(name, exited ? `exited right after starting (code ${codeText(e)})` : `did not answer within ${Math.round(startLimit / 1000)} seconds`);
    return false;
  }
  p.lastError = null; p.lastErrorLines = [];
  return true;
}

function memoryOk() {
  const c = cfg();
  const free = freeMB();
  S.freeMB = free;
  if (now() < S.memGrantUntil) { S.memBlocked = free < c.hardFloorMB; return !S.memBlocked; }
  if (S.memBlocked && now() < S.memNextTry) return false; // looked at already: again in a minute
  if (free >= c.minFreeMB) { S.memBlocked = false; S.memGrantUntil = now() + 5 * 60 * 1000; return true; }
  if (!S.memBlocked) supLog(`waiting for memory: ${free} MB free, ${c.minFreeMB} MB needed`);
  S.memBlocked = true; S.memNextTry = now() + c.memoryRetryMs;
  return false;
}

// ---- run a short helper program to the end ---------------------------------
function runOnce(name, spec, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try { child = spawn(spec.cmd, spec.args || [], { cwd: spec.cwd, env: spec.env, windowsHide: !showWindows(), stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: clean(e.message) }); return; }
    const add = (d) => { out += d.toString('utf8'); if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', (e) => finish({ code: -1, out: clean(e.message) }));
    child.on('exit', (code) => finish({ code, out }));
    const timer = setTimeout(() => { killTree(child.pid); finish({ code: -2, out: `${out}\n(timed out after ${Math.round(timeoutMs / 1000)} s)` }); }, timeoutMs);
    timer.unref();
  }).then((r) => {
    try { fs.mkdirSync(cfg().logsDir, { recursive: true }); fs.appendFileSync(path.join(cfg().logsDir, 'migrate.log'), `\n--- ${new Date().toISOString()} ${name} (exit ${r.code}) ---\n${clean(r.out).slice(-4000)}\n`); } catch { /* no log */ }
    return r;
  });
}
function helperSpec(name) {
  const c = cfg();
  const o = c.commands[name];
  if (o && o.cmd) return { cmd: o.cmd, args: o.args || [], cwd: o.cwd || c.runDir, env: cleanEnv(o.env || {}) };
  const node = process.execPath;
  if (name === 'dbState') return { cmd: node, args: [path.join(c.runDir, 'gs-db.cjs'), 'state'], cwd: c.runDir, env: cleanEnv({ GS_API_DIR: c.apiDir }) };
  if (name === 'migrate') return { cmd: node, args: [path.join(c.apiDir, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], cwd: c.apiDir, env: cleanEnv() };
  if (name === 'seed') return { cmd: node, args: [path.join(c.runDir, 'seed-demo.cjs')], cwd: c.runDir, env: cleanEnv() };
  if (name === 'backup') return { cmd: node, args: [path.join(c.runDir, 'gs-db.cjs'), 'dump'], cwd: c.runDir, env: cleanEnv({ GS_API_DIR: c.apiDir }) };
  return null;
}
async function dbState() {
  const r = await runOnce('state', helperSpec('dbState'), 45000);
  if (r.code !== 0) return null;
  try { return JSON.parse(String(r.out).trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()); } catch { return null; }
}
function expectedMigrations() {
  const dir = path.join(cfg().apiDir, 'prisma', 'migrations');
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'migration.sql'))).length; } catch { return null; }
}
// Step 3: database exists (pg.mjs made it), is migrated, and holds the demo workspace on the very first start.
async function ensureDatabaseReady() {
  const m = S.migrate;
  if (m.done) return true;
  if (m.gaveUp || now() < (m.nextTryAt || 0)) return false;
  m.tries = (m.tries || 0) + 1;
  m.nextTryAt = now() + 60000; // a failure is tried again in a minute, five times at most (an Admin pressing Start resets this)
  if (m.tries > 5) { m.gaveUp = true; return false; }
  m.error = null;
  m.expected = (T && T.expectedMigrations) || expectedMigrations();
  let st = await dbState();
  if (!st) {
    m.error = 'Could not read the Green Start database.';
    // "the database system is starting up / in recovery" on a slow or crowded PC is waiting, not failing: look again in 15 seconds and do not count it
    // towards giving up (about 40 minutes of this at most)
    m.transient = (m.transient || 0) + 1;
    if (m.transient <= 160) { m.tries -= 1; m.nextTryAt = now() + 15000; }
    return false;
  }
  m.transient = 0;
  if (m.expected && st.migrations < m.expected) {
    supLog(`database has ${st.migrations} of ${m.expected} migrations: applying the rest`);
    const r = await runOnce('migrate', helperSpec('migrate'), 300000);
    if (r.code !== 0) { m.error = `Applying the database updates failed: ${clean(r.out).split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' | ').slice(0, 300)}`; return false; }
    st = (await dbState()) || st;
  }
  if (st.users === 0 && !falsy(process.env.GREENSTART_AUTOSEED) && !m.seedTried) {
    m.seedTried = true;
    supLog('empty database: putting in the demo workspace (first start only)');
    const r = await runOnce('seed', helperSpec('seed'), 300000);
    if (r.code === 0) { m.seeded = true; st = (await dbState()) || st; } else m.error = `The demo data could not be added: ${clean(r.out).split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' | ').slice(0, 300)}`;
  }
  S.stats = { users: st.users, contacts: st.contacts, migrations: st.migrations, at: now() };
  m.count = st.migrations;
  m.done = !m.expected || st.migrations >= m.expected;
  if (!m.done && !m.error) m.error = `The database has ${st.migrations} of ${m.expected} updates.`;
  return m.done;
}
async function refreshStats() {
  if (!S.parts.db.up || now() - S.stats.at < cfg().statsEveryMs) return;
  S.stats.at = now(); // do not hammer it when it fails
  const st = await dbState();
  if (st) S.stats = { users: st.users, contacts: st.contacts, migrations: st.migrations, at: now() };
}

// ---- Redis (step 2) ---------------------------------------------------------
function redisStartable() {
  const c = cfg();
  return !!(c.commands.redis && c.commands.redis.cmd) || !!(c.redisExe && fs.existsSync(c.redisExe));
}
async function ensureRedis() {
  if (S.parts.redis.up) return true;
  if (!redisStartable()) return false; // nothing to start: "Waiting for Redis" until the founder runs get-redis.cmd (or any Redis answers)
  return ensure('redis'); // if a foreign program holds port 6379, ours takes the next free port
}

// ---- backups ---------------------------------------------------------------
const BACKUP_RE = /^greenstart-\d{8}-\d{6}\.ndjson\.gz$/;
function listBackups() {
  const dir = cfg().backupDir;
  try {
    return fs.readdirSync(dir).filter((n) => BACKUP_RE.test(n)).map((n) => { const st = fs.statSync(path.join(dir, n)); return { name: n, bytes: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at);
  } catch { return []; }
}
function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
async function backupNow(reason = 'manual') {
  const c = cfg();
  const b = S.backup;
  if (b.running) return { ok: false, error: 'A backup is already running.' };
  if (!S.parts.db.up) return { ok: false, error: 'The Green Start database is not running, so there is nothing to back up yet.' };
  const disk = freeDiskMB();
  if (disk !== null && disk < c.minDiskMB) {
    b.lastError = `Not enough free disk space (${disk} MB free, ${c.minDiskMB} MB needed).`;
    return { ok: false, error: b.lastError };
  }
  b.running = true;
  try {
    fs.mkdirSync(c.backupDir, { recursive: true });
    let when = new Date();
    let file = path.join(c.backupDir, `greenstart-${stamp(when)}.ndjson.gz`);
    while (fs.existsSync(file)) { when = new Date(when.getTime() + 1000); file = path.join(c.backupDir, `greenstart-${stamp(when)}.ndjson.gz`); } // two in one second: the next second's name
    const spec = helperSpec('backup');
    spec.args = [...spec.args, file];
    const r = await runOnce('backup', spec, 10 * 60 * 1000);
    if (r.code !== 0 || !fs.existsSync(file)) {
      b.lastOk = false; b.lastError = `Backup failed: ${clean(r.out).split(/\r?\n/).filter((l) => l.trim()).slice(-1).join('').slice(0, 200)}`; b.lastAt = now();
      try { fs.rmSync(`${file}.part`, { force: true }); } catch { /* ignore */ }
      return { ok: false, error: b.lastError };
    }
    b.lastOk = true; b.lastError = null; b.lastAt = now(); b.lastFile = path.basename(file);
    const all = listBackups();
    for (const old of all.slice(c.backupKeep)) { try { fs.rmSync(path.join(c.backupDir, old.name), { force: true }); } catch { /* in use */ } }
    supLog(`backup done (${reason}): ${b.lastFile}`);
    return { ok: true, file: b.lastFile, bytes: fs.statSync(file).size, kept: Math.min(all.length, c.backupKeep) };
  } finally { b.running = false; }
}
async function maybeAutoBackup() {
  const c = cfg();
  if (S.backup.running || S.state !== 'running') return;
  if (S.backup.lastAt && now() - S.backup.lastAt < 3600 * 1000) return; // a failed attempt: try again in an hour
  const last = listBackups()[0];
  if (last && now() - last.at < c.backupEveryMs) return;
  if (!S.parts.api.up || now() - (S.upSince || now()) < 120000) return; // not right after a start (a minute or two of calm first)
  await backupNow('daily');
}

// ---- the main loop ---------------------------------------------------------
function wanted() {
  if (S.override === 'start') return true;
  if (S.override === 'stop') return false;
  return autostart();
}
function computeState() {
  const P = S.parts;
  const b = built();
  const anyUp = ORDER.some((n) => P[n].up);
  const allUp = ORDER.every((n) => P[n].up);
  const given = ORDER.find((n) => P[n].givenUp);
  S.step = 0;
  if (S.stopping) return 'stopping';
  if (S.passive && !anyUp) return 'managed_elsewhere';
  if (!wanted()) {
    if (allUp) return 'running';
    if (anyUp) return 'partial';
    return S.override === 'stop' ? 'stopped' : 'autostart_off';
  }
  if (allUp) return 'running';
  if (!b.ok && !anyUp) return 'not_built';
  if (given) return 'crashed';
  if (S.migrate.error && P.db.up && !S.migrate.done && (S.migrate.gaveUp || S.migrate.tries >= 2)) return 'crashed';
  if (!P.redis.up && !redisStartable()) { S.step = 2; return 'waiting_redis'; }
  if (S.memBlocked) return 'waiting_memory';
  if (!P.db.up) S.step = 1;
  else if (!P.redis.up) S.step = 2;
  else if (!S.migrate.done) S.step = 3;
  else if (!P.api.up || !P.worker.up) S.step = 4;
  else S.step = 5;
  return 'starting';
}

async function reconcile() {
  if (S.busy) return;
  S.busy = true;
  try {
    if (S.passive && acquireLock()) { S.passive = false; supLog('took over from the earlier supervisor'); }
    await observe();
    if (ORDER.some((n) => !S.parts[n].up)) S.upSince = 0; // calm period starts when everything is up
    S.state = computeState();
    if (S.passive || S.stopping || !wanted() || !built().ok) return;
    if (!ORDER.some((n) => !S.parts[n].up)) { if (!S.upSince) S.upSince = now(); ensureWatchdog(); await refreshStats(); await maybeAutoBackup(); return; }

    await ensure('db');
    await ensureRedis();
    if (S.parts.db.up && !aborted()) await ensureDatabaseReady();
    S.state = computeState();
    // api and worker only when they can work: database, its updates, and Redis. Without Redis the product's server never opens its port.
    if (S.parts.db.up && S.migrate.done && S.parts.redis.up && !aborted()) {
      await ensure('api');
      S.state = computeState();
      await ensure('worker');
    }
    await ensure('gate');
    await observe();
    S.state = computeState();
    S.lastReconcileAt = now();
    ensureWatchdog();
  } catch (err) {
    supLog(`internal error: ${err.message}`);
  } finally { S.busy = false; }
}

// ---- lock, heartbeat, watchdog --------------------------------------------
function acquireLock() {
  const f = lockFile();
  const cur = readJson(f);
  if (cur && cur.pid && cur.pid !== process.pid && alive(cur.pid) && cur.startedAt > bootTime() - 60000) { S.holder = cur; return false; }
  writeJson(f, { pid: process.pid, startedAt: now(), teamlinkPort: cfg().teamlinkPort });
  const back = readJson(f);
  if (!back || back.pid !== process.pid) { S.holder = back; return false; }
  S.holder = null;
  return true;
}
function releaseLock() {
  const cur = readJson(lockFile());
  if (cur && cur.pid === process.pid) { try { fs.unlinkSync(lockFile()); } catch { /* gone */ } }
}
function beat(text) { try { fs.mkdirSync(cfg().logsDir, { recursive: true }); fs.writeFileSync(heartbeatFile(), `${text || 'alive'} ${process.pid} ${new Date().toISOString()}\n`); } catch { /* next beat */ } }
function watchdogSettings() {
  const c = cfg();
  return {
    heartbeat: heartbeatFile(), pidDir: c.logsDir, order: ORDER, pgCtl: c.pgCtl, pgData: path.join(c.runDir, 'pgdata'),
    maxAgeMs: c.watchdogMaxAgeMs, checkMs: c.watchdogCheckMs, logFile: path.join(c.logsDir, 'supervisor.log'),
    redisCli: path.join(c.redisDir, 'redis-cli.exe'), redisSecretFile: path.join(c.redisDir, 'redis.secret'), redisStateFile: path.join(c.redisDir, 'redis.json'),
  };
}
function ensureWatchdog() {
  const c = cfg();
  if (S.passive || !ORDER.some((n) => ownPid(n))) return;
  const w = readJson(path.join(c.logsDir, 'watchdog.pid'));
  if (w && w.pid && alive(w.pid)) return;
  const script = path.join(c.runDir, 'watchdog.cjs');
  if (!fs.existsSync(script)) return;
  const settings = path.join(c.logsDir, 'watchdog.json');
  writeJson(settings, watchdogSettings());
  beat();
  try {
    const child = spawn(process.execPath, [script, settings], { detached: true, windowsHide: true, stdio: 'ignore', env: cleanEnv() });
    child.unref();
  } catch (e) { supLog(`could not start the watchdog: ${e.message}`); }
}
// Stop every part this supervisor started (blocking helper run: only used when this backend exits, or in a short-lived child for the Stop button)
function stopManagedNow(sync) {
  const c = cfg();
  const script = path.join(c.runDir, 'watchdog.cjs');
  const settings = path.join(c.logsDir, 'watchdog.json');
  writeJson(settings, watchdogSettings());
  if (!fs.existsSync(script)) { ORDER.slice().reverse().forEach((n) => killPart(n)); return null; }
  if (sync) { spawnSync(process.execPath, [script, settings, '--once'], { stdio: 'ignore', windowsHide: true, timeout: 60000, env: cleanEnv() }); return null; }
  const child = spawn(process.execPath, [script, settings, '--once'], { detached: true, windowsHide: true, stdio: 'ignore', env: cleanEnv() });
  child.unref();
  return child;
}

// ---- admin controls -------------------------------------------------------
function persist() { writeJson(stateFile(), { override: S.override, at: new Date().toISOString() }); }
function resetCounters() {
  for (const n of ORDER) { const p = S.parts[n]; p.givenUp = false; p.restarts = []; p.crashes = 0; p.nextTryAt = 0; p.lastError = null; p.lastErrorLines = []; p.exit = null; p.child = null; }
  S.migrate = { done: false, error: null, expected: null, count: null, seeded: false, seedTried: false, tries: 0, nextTryAt: 0, gaveUp: false };
  S.memBlocked = false; S.memNextTry = 0; S.memGrantUntil = 0;
}
function launcherAdopted() { return ORDER.filter((n) => S.parts[n].adopted); }
async function waitStopped(ms) {
  const t0 = now();
  while (now() - t0 < ms) { await observe(); if (!ORDER.some((n) => S.parts[n].up)) return true; await sleep(500); }
  return false;
}
async function stopEverything() {
  S.stopping = true;
  try {
    for (let i = 0; i < 60 && S.busy; i += 1) await sleep(500); // let a start that is in progress notice and step aside
    stopManagedNow(false);
    const adopted = launcherAdopted();
    const script = path.join(cfg().runDir, 'stop-green-start.ps1');
    if (adopted.length && fs.existsSync(script) && !T) {
      try { spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
    }
    await waitStopped(70000);
  } finally {
    for (const n of ORDER) { const p = S.parts[n]; p.child = null; p.exit = null; p.managed = false; p.pid = null; }
    S.stopping = false;
  }
}
async function control(action) {
  if (!supervise()) return { ok: false, error: `${EXTERNAL_TEXT}. Start, stop and backups are done there, not from TeamLink.` };
  if (!S.started) return { ok: false, error: 'Green Start looking-after is switched off on this server.' };
  if (S.passive) return { ok: false, error: `Another TeamLink backend (process ${S.holder && S.holder.pid}) is looking after Green Start.` };
  if (action === 'backup') return backupNow('manual');
  if (S.stopping) return { ok: false, error: 'Green Start is stopping. Wait a moment.' };
  if (action === 'start') {
    S.override = 'start'; persist(); resetCounters();
    setImmediate(() => reconcile());
    return { ok: true, message: 'Starting Green Start.' };
  }
  if (action === 'stop') {
    S.override = 'stop'; persist();
    stopEverything().then(() => { S.state = computeState(); });
    return { ok: true, message: 'Stopping Green Start.' };
  }
  if (action === 'restart') {
    S.override = 'start'; persist();
    stopEverything().then(() => { resetCounters(); return reconcile(); });
    return { ok: true, message: 'Restarting Green Start.' };
  }
  return { ok: false, error: 'Unknown action.' };
}

// ---- status for the page ----------------------------------------------------
const STATE_TEXT = {
  running: 'Running', starting: 'Starting', waiting_memory: 'Waiting for memory', waiting_redis: 'Waiting for Redis', crashed: 'Crashed',
  external: EXTERNAL_TEXT, stopped: 'Stopped', autostart_off: 'Not started (auto-start is off)', not_built: 'Not built yet', managed_elsewhere: 'Looked after by another TeamLink backend',
  stopping: 'Stopping', partial: 'Partly running', off: 'Switched off', idle: 'Checking',
};
function partView(n) {
  const p = S.parts[n];
  let state = 'stopped';
  if (p.up) state = 'running';
  else if (p.givenUp) state = 'crashed';
  else if (p.child && !p.exit && p.startedAt && now() - p.startedAt < cfg().startTimeoutMs) state = 'starting';
  else if (p.crashes && p.lastError) state = 'restarting';
  if (n === 'redis' && !p.up && S.redis.kind === 'missing') state = 'missing';
  if (n === 'redis' && !p.up && S.redis.kind === 'unusable') state = 'unusable';
  return {
    label: LABEL[n], ok: !!p.up, state, adopted: !!p.adopted, pid: p.pid, restarts: p.restarts.length, crashes: p.crashes,
    ...(n === 'redis' ? { kind: S.redis.kind, port: S.redis.port, note: S.redis.note } : {}),
    ...(p.lastError ? { lastError: p.lastError, lastErrorLines: p.lastErrorLines } : {}),
  };
}
async function snapshot({ fresh = true } = {}) {
  const c = cfg();
  if (!enabled()) return { supervised: false, state: 'off', stateText: STATE_TEXT.off };
  if (!supervise()) return { supervised: false, external: true, state: 'external', stateText: EXTERNAL_TEXT };
  if (!S.started) return { supervised: false, state: 'idle', stateText: 'Not looked after by this server' };
  if (fresh && now() - S.lastObserveAt > 3000 && !S.busy) { try { await observe(); } catch { /* keep */ } }
  S.state = computeState();
  const b = built();
  const crashedPart = ORDER.find((n) => S.parts[n].givenUp) || (S.state === 'crashed' && S.migrate.error && !S.migrate.done ? 'prepare' : null);
  const disk = freeDiskMB();
  const bl = listBackups();
  const step = S.state === 'starting' ? S.step : 0;
  return {
    supervised: true,
    state: S.state, stateText: STATE_TEXT[S.state] || S.state,
    step: step ? { n: step, of: 5, label: STEPS[step - 1] } : null,
    parts: Object.fromEntries(ORDER.map((n) => [n, partView(n)])),
    crash: crashedPart === 'prepare' ? { part: 'prepare', label: STEPS[2], lines: [clean(S.migrate.error)], message: clean(S.migrate.error) } : (crashedPart ? { part: crashedPart, label: LABEL[crashedPart], lines: S.parts[crashedPart].lastErrorLines, message: S.parts[crashedPart].lastError } : null),
    problems: b.problems,
    prepare: { done: !!S.migrate.done, error: S.migrate.error, migrations: S.migrate.count, expected: S.migrate.expected, seeded: S.migrate.seeded },
    ram: { freeMB: S.freeMB === null ? freeMB() : S.freeMB, needMB: c.minFreeMB, blocked: !!S.memBlocked, nextCheckInS: S.memBlocked ? Math.max(0, Math.round((S.memNextTry - now()) / 1000)) : null },
    disk: { freeMB: disk, backupNeedsMB: c.minDiskMB },
    contacts: S.stats.contacts, users: S.stats.users,
    backups: { dir: c.backupDir, count: bl.length, keep: c.backupKeep, lastAt: bl[0] ? new Date(bl[0].at).toISOString() : null, lastBytes: bl[0] ? bl[0].bytes : null, running: S.backup.running, lastError: S.backup.lastError },
    supervisor: { active: !S.passive, holderPid: S.holder && S.holder.pid, autostart: autostart(), override: S.override, wanted: wanted(), showWindows: showWindows(), startedAt: S.startedAt },
    paths: { app: c.appDir, run: c.runDir, logs: c.logsDir, redisInstall: path.join(c.runDir, 'get-redis.cmd'), launcher: path.join(c.runDir, 'start-green-start.cmd'), support: path.join(c.runDir, 'README-SUPPORT.md') },
  };
}

// ---- boot / shutdown ---------------------------------------------------------
function readOverride() { const j = readJson(stateFile()); return j && (j.override === 'start' || j.override === 'stop') ? j.override : null; }
let exiting = false;
function onExit(sig) {
  if (exiting) return;
  exiting = true;
  try {
    beat('stop');
    // a real stop of this backend (Ctrl+C / closing the service): stop what we started, cleanly. A nodemon restart sends no signal here.
    if (ORDER.some((n) => ownPid(n))) stopManagedNow(true);
    releaseLock();
  } catch { /* leave */ }
  // other handlers (the Job Portal's) only exit when they are the sole listener, so this one finishes the job
  setTimeout(() => process.exit(sig === 'SIGINT' ? 130 : 143), 100);
}
function start() {
  if (S.started) return;
  if (!enabled()) { if (!isSandbox()) console.log('[green-start] GREENSTART_ENABLED is off: Green Start is not looked after by this server.'); return; } // eslint-disable-line no-console
  if (!supervise()) { if (!isSandbox()) console.log('[green-start] GREENSTART_SUPERVISE is off: Green Start is a separate service on this server; this backend starts nothing.'); return; } // eslint-disable-line no-console
  if (isSandbox()) { T = loadTestConfig(); if (!T) return; }
  S.started = true; S.startedAt = new Date().toISOString();
  S.override = readOverride();
  S.passive = !acquireLock();
  beat();
  const c = cfg();
  const hb = setInterval(() => { if (!S.passive) beat(); }, c.heartbeatMs); hb.unref();
  const tick = setInterval(() => { reconcile(); }, c.tickMs); tick.unref();
  const first = setTimeout(() => { reconcile(); }, c.startDelayMs); first.unref();
  const rot = setInterval(() => { ORDER.forEach((n) => { rotateIfBig(logPath(n, 'out'), 20 * 1024 * 1024, true); rotateIfBig(logPath(n, 'err'), 20 * 1024 * 1024, true); }); }, 10 * 60 * 1000); rot.unref();
  S.timers = [hb, tick, first, rot];
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => onExit(sig)));
  process.on('exit', () => releaseLock());
  if (!isSandbox()) console.log(`[green-start] looking after Green Start (auto-start ${autostart() ? 'on' : 'off'}; logs: ${c.logsDir})`); // eslint-disable-line no-console
}
function stopTimers() { S.timers.forEach((t) => clearInterval(t)); S.timers = []; }

module.exports = {
  start, snapshot, control, readLog, backupNow, scrub, buildRedisConf, listBackups, stopTimers, enabled, autostart,
  // for tests
  _S: S, _reconcile: reconcile, _cfg: cfg, _redisProbe: redisProbe, _ORDER: ORDER, _memoryOk: memoryOk, _wanted: wanted, _acquireLock: acquireLock, _stopManagedNow: stopManagedNow,
};
