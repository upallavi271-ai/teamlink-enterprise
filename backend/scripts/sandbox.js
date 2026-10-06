#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TEST SANDBOX — a throw-away copy of the API for tests.
//
//   npm run sandbox                     fresh copy of dev.db, API on :4011 (foreground, nodemon on src/)
//   npm run sandbox -- --detach         same, in the background (log: prisma/sandbox.db.log)
//   npm run sandbox -- --restart --detach   stop the running sandbox, fresh copy, start again
//   npm run sandbox -- --keep           reuse the existing prisma/sandbox.db instead of a fresh copy
//   npm run sandbox -- --copy-only      refresh prisma/sandbox.db and exit
//   npm run sandbox -- --stop           stop a sandbox started with --detach
//   npm run sandbox -- --status         is it running?
//   npm run sandbox -- --no-watch       plain node instead of nodemon
//   npm run sandbox -- --frontend       with --detach: also start the sandbox frontend on :5184
//
// The copy is made with SQLite `VACUUM INTO` (a consistent snapshot; dev.db is
// only read). The server runs with TEST_MODE=1 (src/utils/sandbox.js): no
// background workers, mail / SMS / WhatsApp / job portal never contacted, AI
// refused unless TEST_ALLOW_AI=1. Files the sandbox writes (uploads, ATS I/O,
// bulk message jobs) go to ~/.teamlink-sandbox, never the real folders.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const PRISMA = path.join(BACKEND, 'prisma');
const DEV_DB = path.join(PRISMA, 'dev.db');
const SANDBOX_DB = path.join(PRISMA, 'sandbox.db');
const STATE = `${SANDBOX_DB}.json`;
const LOG = `${SANDBOX_DB}.log`;
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const FILES_ROOT = process.env.TEAMLINK_SANDBOX_FILES || path.join(os.homedir() || os.tmpdir(), '.teamlink-sandbox');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || Number(process.env.SANDBOX_PORT) || 4011;
const FE_PORT = Number(process.env.SANDBOX_FRONTEND_PORT) || 5184;
if (PORT === 4010) { console.error('[sandbox] refusing: 4010 is the real dev server.'); process.exit(1); }

// Vite listens on ::1 only, Express on both — so ask both.
async function portInUse(port) {
  return (await portOpen(port, '127.0.0.1')) || portOpen(port, '::1');
}
function portOpen(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

async function health(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch { /* already gone */ }
}

async function stop() {
  const st = readState();
  if (!st) { console.log('[sandbox] no state file — nothing started with --detach.'); return; }
  killTree(st.pid);
  if (st.frontendPid) killTree(st.frontendPid);
  for (let i = 0; i < 20 && await portInUse(st.port || PORT); i += 1) await new Promise((r) => setTimeout(r, 500));
  try { fs.unlinkSync(STATE); } catch { /* ignore */ }
  console.log(`[sandbox] stopped (pid ${st.pid}${st.frontendPid ? `, frontend pid ${st.frontendPid}` : ''}).`);
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { console.warn(`[sandbox] could not clear ${p}: ${e.message}`); } }

function freshCopy() {
  if (!fs.existsSync(DEV_DB)) throw new Error(`${DEV_DB} not found`);
  for (const sfx of ['', '-wal', '-shm', '-journal']) {
    const f = `${SANDBOX_DB}${sfx}`;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (e) { throw new Error(`cannot replace ${f} (${e.code}) — is a sandbox still running? Use --restart or --stop first.`); }
    }
  }
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  let src;
  try { src = new DatabaseSync(DEV_DB, { readOnly: true }); } catch { src = new DatabaseSync(DEV_DB); }
  const t0 = Date.now();
  try {
    src.exec(`VACUUM INTO '${SANDBOX_DB.replace(/'/g, "''")}'`);
  } finally { src.close(); }
  const copy = new DatabaseSync(SANDBOX_DB);
  const users = copy.prepare('SELECT COUNT(*) AS n FROM "User"').get().n;
  copy.exec('PRAGMA journal_mode=WAL');
  copy.close();
  // The files that belong to the old copy go with it.
  ['uploads', 'ats-io', 'message-jobs'].forEach((d) => rmrf(path.join(FILES_ROOT, d)));
  console.log(`[sandbox] fresh copy: ${SANDBOX_DB} (${(fs.statSync(SANDBOX_DB).size / 1048576).toFixed(1)} MB, ${users} users) in ${Date.now() - t0} ms`);
}

function childEnv() {
  return {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: 'file:./sandbox.db',
    TEST_MODE: '1',
    TEAMLINK_SANDBOX: '1',
    NODE_ENV: 'development',
    APP_BASE_URL: `http://localhost:${FE_PORT}`,
    UPLOAD_DIR: path.join(FILES_ROOT, 'uploads'),
    ATS_IO_DIR: path.join(FILES_ROOT, 'ats-io'),
    MESSAGE_JOB_DIR: path.join(FILES_ROOT, 'message-jobs'),
    // Belt and braces — index.js does not start any of these in TEST_MODE.
    MAIL_WORKER_INTERVAL_MS: '0',
    BULK_WORKER_INTERVAL_MS: '0',
    PAYROLL_SYNC_SWEEP_MS: '0',
    ATTENDANCE_ALERTS_INTERVAL_MS: '0',
    JOB_PORTAL_SYNC_INTERVAL_MS: '0',
  };
}

function serverCommand() {
  if (has('--no-watch')) return [process.execPath, ['src/index.js']];
  // nodemon.json in backend/ watches src only and ignores prisma/*.db*.
  return [process.execPath, [path.join(BACKEND, 'node_modules', 'nodemon', 'bin', 'nodemon.js'), 'src/index.js']];
}

async function waitHealthy(port, ms = 90000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await health(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function startFrontendDetached() {
  const out = fs.openSync(`${SANDBOX_DB}.frontend.log`, 'a');
  const child = spawn(process.execPath, [path.join(FRONTEND, 'scripts', 'sandbox.mjs')], {
    cwd: FRONTEND,
    env: { ...process.env, VITE_API_TARGET: `http://localhost:${PORT}`, VITE_PORT: String(FE_PORT) },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}

async function main() {
  if (has('--stop')) return stop();
  if (has('--status')) {
    const st = readState();
    console.log(JSON.stringify({ running: await health(), port: PORT, frontend: await portInUse(FE_PORT), state: st }, null, 1));
    return undefined;
  }
  if (has('--restart')) await stop();

  if (await portInUse(PORT)) {
    console.error(`[sandbox] port ${PORT} is already in use — a sandbox is probably running (npm run sandbox -- --status). Use --restart for a fresh copy.`);
    process.exit(has('--detach') ? 0 : 1);
  }
  if (has('--keep') && fs.existsSync(SANDBOX_DB)) console.log(`[sandbox] --keep: reusing ${SANDBOX_DB}`);
  else freshCopy();
  if (has('--copy-only')) return undefined;

  fs.mkdirSync(FILES_ROOT, { recursive: true });
  const [cmd, args] = serverCommand();
  if (has('--detach')) {
    const out = fs.openSync(LOG, 'a');
    fs.writeSync(out, `\n----- sandbox start ${new Date().toISOString()} -----\n`);
    const child = spawn(cmd, args, { cwd: BACKEND, env: childEnv(), detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    child.unref();
    const state = { pid: child.pid, port: PORT, db: SANDBOX_DB, log: LOG, startedAt: new Date().toISOString() };
    const ok = await waitHealthy(PORT);
    if (has('--frontend') && !(await portInUse(FE_PORT))) state.frontendPid = startFrontendDetached();
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    console.log(ok
      ? `[sandbox] API up on http://localhost:${PORT} (pid ${child.pid}); log ${LOG}${state.frontendPid ? `; frontend on http://localhost:${FE_PORT}` : ''}`
      : `[sandbox] API did not answer /api/health within 90 s — see ${LOG}`);
    process.exit(ok ? 0 : 1);
  }
  const child = spawn(cmd, args, { cwd: BACKEND, env: childEnv(), stdio: 'inherit' });
  fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, port: PORT, db: SANDBOX_DB, foreground: true, startedAt: new Date().toISOString() }, null, 1));
  const end = () => { try { fs.unlinkSync(STATE); } catch { /* ignore */ } };
  child.on('exit', (code) => { end(); process.exit(code || 0); });
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { killTree(child.pid); end(); process.exit(0); }));
  return undefined;
}

main().catch((e) => { console.error('[sandbox]', e.message); process.exit(1); });
