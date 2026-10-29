#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LOAD ANOTHER PC'S JOB PORTAL DATA INTO THIS EMBEDDED PORTAL (founder 2026-10-29: "Sravanthi PC lo unna real data localhost ki,
// server ki push cheyyi"; decided: back up first, then REPLACE).
//
// The zip comes from EXPORT-DATA-FOR-SERVER.bat on that PC (the portal's own tool):
//   teamlink-data.ndjson.gz   the rows (candidates, applications, jobs, settings ...)
//   uploads.tar.gz            resumes, documents, recordings
//   env-from-pc.txt           that PC's passwords - NOT used here, never copied
//
//   node job-portal-app/embed/load-portal-data.mjs --zip <zip or unzipped folder>            DRY RUN (checks everything, keeps nothing)
//   node job-portal-app/embed/load-portal-data.mjs --zip <zip or unzipped folder> --apply    REPLACE this portal's data
//
// What it does:
//   1. asks the running portal to stop and keeps it stopped (job-portal-app/run/maintenance: the TeamLink backend does not restart it);
//   2. BACKS UP this portal's database folder (var/dev-db) and uploads (var/uploads) to job-portal-app/backups/<stamp>/;
//   3. opens the database the way the portal does (PGlite + its socket) and runs the portal's OWN loader
//      tools/copy-live-to-postgres.mjs --from-file ... (one transaction: all or nothing; --dry-run rolls back);
//   4. with --apply: replaces var/uploads with the zip's uploads;
//   5. closes the database cleanly and removes the maintenance flag - the backend starts the portal again within ~10 s.
// Counts of the main tables are printed before and after. Nothing here is uploaded anywhere; no password is read or printed.
// A portal on a REAL PostgreSQL (DATABASE_URL in the portal's environment) is not handled here - use the portal's deploy/import-data.sh.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, writeFileSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const PORTAL = resolve(process.env.JOB_PORTAL_DIR || join(APP, 'job_portal-main'));
const RUN = resolve(process.env.JOB_PORTAL_RUN_DIR || join(APP, 'run'));
const DEV_DB = join(PORTAL, 'var', 'dev-db');
const UPLOADS = join(PORTAL, 'var', 'uploads');
const MAINT = join(RUN, 'maintenance');
const PORT = parseInt(process.env.JOB_PORTAL_PORT, 10) || 4323;
const SOCKET_PORT = 5498;

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const ZIP = arg('--zip');
const die = (m) => { console.error(`\nSTOPPED: ${m}`); process.exit(1); };
const say = (m) => console.log(`\n== ${m}`);
if (!ZIP) die('usage: node load-portal-data.mjs --zip <teamlink-data-for-server-....zip or its unzipped folder> [--apply]');
if (!existsSync(join(PORTAL, 'tools', 'copy-live-to-postgres.mjs'))) die(`no Job Portal in ${PORTAL}`);
if (!existsSync(join(DEV_DB, 'PG_VERSION'))) die(`no embedded portal database in ${DEV_DB} (start the portal once first)`);

const health = () => new Promise((r) => {
  const q = http.get(`http://127.0.0.1:${PORT}/api/health`, { timeout: 2000 }, (res) => { res.resume(); r(res.statusCode === 200); });
  q.on('timeout', () => { q.destroy(); r(false); }); q.on('error', () => r(false));
});
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---- 0. unpack the zip (or use the folder as given)
let pkg = resolve(ZIP);
if (!existsSync(pkg)) die(`no such file: ${pkg}`);
let tmp = null;
if (statSync(pkg).isFile()) {
  tmp = join(os.tmpdir(), `jp-load-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    if (process.platform === 'win32') execFileSync('tar', ['-xf', pkg, '-C', tmp]);
    else {
      try { execFileSync('unzip', ['-q', pkg, '-d', tmp]); } catch { execFileSync('python3', ['-m', 'zipfile', '-e', pkg, tmp]); }
    }
  } catch (e) { die(`could not unpack the zip: ${String(e.message).slice(0, 200)}`); }
  pkg = tmp;
}
const findFile = (dir, name) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
};
const ROWS = findFile(pkg, 'teamlink-data.ndjson.gz');
const UP = findFile(pkg, 'uploads.tar.gz');
if (!ROWS) die('the package has no teamlink-data.ndjson.gz (make it with EXPORT-DATA-FOR-SERVER.bat on the other PC)');
console.log(`package: rows ${ROWS}${UP ? `, uploads ${UP}` : ', no uploads file'}${findFile(pkg, 'env-from-pc.txt') ? ' (env-from-pc.txt is ignored)' : ''}`);
console.log(APPLY ? 'MODE: APPLY - this portal\'s data will be REPLACED (after a backup).' : 'MODE: DRY RUN - everything is checked, nothing is kept.');

const cleanup = () => { try { rmSync(MAINT, { force: true }); } catch { /* ignore */ } if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } } };
let db = null; let server = null;
try {
  // ---- 1. stop the portal and keep it stopped
  say('1. stopping the Job Portal (kept stopped while loading)');
  mkdirSync(RUN, { recursive: true });
  writeFileSync(MAINT, `loading data ${new Date().toISOString()}\n`);
  for (let i = 0; i < 60 && await health(); i += 1) await sleep(2000);
  if (await health()) throw new Error('the portal is still answering after 2 minutes - is the TeamLink backend running this updated code? Stop it and run again.');
  await sleep(4000); // its database closes after the HTTP side
  console.log('portal stopped');

  // ---- 2. backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = join(APP, 'backups', `before-data-load-${stamp}`);
  say(`2. backing up this portal's data to ${bak}`);
  mkdirSync(bak, { recursive: true });
  cpSync(DEV_DB, join(bak, 'dev-db'), { recursive: true });
  if (existsSync(UPLOADS)) cpSync(UPLOADS, join(bak, 'uploads'), { recursive: true });
  console.log('backup done');

  // ---- 3. open the database the way the portal does and run the portal's own loader
  say('3. loading the rows with the portal\'s own loader (one transaction)');
  const req = (m) => import(pathToFileURL(join(PORTAL, 'node_modules', ...m.split('/'), 'dist', 'index.js')).href).catch(() => import(m));
  const { PGlite } = await req('@electric-sql/pglite');
  const { PGLiteSocketServer } = await req('@electric-sql/pglite-socket');
  db = await new PGlite(DEV_DB);
  const counts = async () => {
    const t = (await db.query(`select c.relname as n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind='r' and c.relname ~ '^(candidates|applications|jobs|job_posts|companies|users|profiles|resumes)$' order by 1`)).rows.map((r) => r.n);
    const out = {};
    for (const x of t) out[x] = Number((await db.query(`select count(*)::int as k from "${x}"`)).rows[0].k); // eslint-disable-line no-await-in-loop
    return out;
  };
  console.log('before:', JSON.stringify(await counts()));
  server = new PGLiteSocketServer({ db, port: SOCKET_PORT, host: '127.0.0.1' });
  await server.start();
  // ASYNC on purpose: the database socket lives in THIS process; a synchronous child would block it and both would wait forever
  const r = await new Promise((done) => { const c = spawn(process.execPath, ['tools/copy-live-to-postgres.mjs', '--from-file', ROWS, '--target', `postgres://postgres:postgres@127.0.0.1:${SOCKET_PORT}/postgres`, ...(APPLY ? [] : ['--dry-run'])],
    { cwd: PORTAL, stdio: 'inherit', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE } }); c.on('exit', (code) => done({ status: code })); c.on('error', () => done({ status: 1 })); });
  if (r.status !== 0) throw new Error('the portal\'s loader stopped (see its message above); nothing was kept - the database is unchanged');
  await server.stop().catch(() => {}); server = null;
  console.log('after: ', JSON.stringify(await counts()));
  await db.query('checkpoint').catch(() => {});
  await db.close(); db = null;

  // ---- 4. uploads
  if (APPLY && UP) {
    say('4. replacing the uploads (resumes, documents)');
    rmSync(UPLOADS, { recursive: true, force: true });
    mkdirSync(join(PORTAL, 'var'), { recursive: true });
    execFileSync('tar', ['-xzf', UP, '-C', join(PORTAL, 'var')]);
    console.log('uploads replaced');
  }
  say(APPLY ? 'DONE: the data is replaced. The backend starts the portal again within ~10 seconds.' : 'DRY RUN DONE: nothing was changed. Run again with --apply to replace the data.');
  console.log(`backup of the data before this run: ${bak}`);
} catch (e) {
  console.error(`\nSTOPPED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (server) await server.stop().catch(() => {});
  if (db) await db.close().catch(() => {});
  cleanup();
}
