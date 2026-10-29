#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE JOB PORTAL WILL NOT START: "These migrations were edited after being applied: 0003_seed.sql" (live site, 2026-10-29).
//
// Cause: load-portal-data.mjs ran the portal's loader, which records the seed migration that came with the data using the
// LF line-ending checksum (tools/copy-live-to-postgres.mjs serverSha). On this server that migration FILE has CRLF line endings
// (it came from a Windows PC), and the portal checks the checksum of the raw file - so the same SQL looks "edited" and the
// portal stops at start-up. The content is identical; only the line endings differ.
//
//   node job-portal-app/embed/fix-migration-line-endings.mjs            DRY RUN: lists the mismatches, changes nothing
//   node job-portal-app/embed/fix-migration-line-endings.mjs --apply    rewrites ONLY the bookkeeping checksum of each migration
//                                                                       whose file differs by LINE ENDINGS ONLY
//
// A migration whose content really differs is never touched: the script stops and says so. No table data, no migration file,
// no portal code is changed. The old checksums are saved to job-portal-app/backups/migration-checksums-<time>.json.
// The portal is kept stopped while the database is open (job-portal-app/run/maintenance), then the backend starts it again.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const PORTAL = resolve(process.env.JOB_PORTAL_DIR || join(APP, 'job_portal-main'));
const RUN = resolve(process.env.JOB_PORTAL_RUN_DIR || join(APP, 'run'));
const DEV_DB = join(PORTAL, 'var', 'dev-db');
const MIGRATIONS = join(PORTAL, 'supabase', 'migrations');
const MAINT = join(RUN, 'maintenance');
const PIDFILE = join(RUN, 'portal.pid.json');
const PORT = parseInt(process.env.JOB_PORTAL_PORT, 10) || 4323;
const APPLY = process.argv.includes('--apply');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const say = (m) => console.log(`\n== ${m}`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const health = () => new Promise((r) => {
  const q = http.get(`http://127.0.0.1:${PORT}/api/health`, { timeout: 2000 }, (res) => { res.resume(); r(res.statusCode === 200); });
  q.on('timeout', () => { q.destroy(); r(false); }); q.on('error', () => r(false));
});
const portalPid = () => { try { return JSON.parse(readFileSync(PIDFILE, 'utf8')).pid || null; } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

if (!existsSync(join(DEV_DB, 'PG_VERSION'))) { console.error(`STOPPED: no embedded portal database in ${DEV_DB}`); process.exit(1); }
console.log(APPLY ? 'MODE: APPLY - line-ending-only checksums will be corrected.' : 'MODE: DRY RUN - nothing is changed.');

let db = null;
try {
  // ---- 1. the portal must be fully stopped before its database is opened here
  say('1. stopping the Job Portal (kept stopped while checking)');
  mkdirSync(RUN, { recursive: true });
  writeFileSync(MAINT, `fixing migration checksums ${new Date().toISOString()}\n`);
  for (let i = 0; i < 60 && (await health() || alive(portalPid())); i += 1) await sleep(2000); // eslint-disable-line no-await-in-loop
  if (await health() || alive(portalPid())) throw new Error(`the portal process ${portalPid()} is still running after 2 minutes - nothing was opened or changed`);
  await sleep(3000);
  console.log('portal stopped');

  // ---- 2. compare
  say('2. comparing the recorded checksums with the migration files');
  const req = (m) => import(pathToFileURL(join(PORTAL, 'node_modules', ...m.split('/'), 'dist', 'index.js')).href).catch(() => import(m));
  const { PGlite } = await req('@electric-sql/pglite');
  db = await new PGlite(DEV_DB);
  const rows = (await db.query('select filename, checksum from schema_migrations order by filename')).rows;
  const files = new Set(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')));
  const lineEndingOnly = [];
  const realDiff = [];
  for (const r of rows) {
    if (!files.has(r.filename)) continue;
    const raw = readFileSync(join(MIGRATIONS, r.filename), 'utf8');
    if (r.checksum === sha(raw)) continue;
    const lf = raw.replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    if (r.checksum === sha(lf) || r.checksum === sha(crlf)) lineEndingOnly.push({ filename: r.filename, old: r.checksum, new: sha(raw) });
    else realDiff.push(r.filename);
  }
  console.log(`${rows.length} recorded migrations; line endings only: ${lineEndingOnly.map((x) => x.filename).join(', ') || 'none'}; really different: ${realDiff.join(', ') || 'none'}`);
  if (realDiff.length) throw new Error(`these migrations really differ from what was applied: ${realDiff.join(', ')} - nothing was changed. Send this screen.`);
  if (!lineEndingOnly.length) {
    say('nothing to fix: every recorded checksum matches its file');
  } else if (!APPLY) {
    say(`DRY RUN DONE: ${lineEndingOnly.length} checksum(s) would be corrected. Run again with --apply.`);
  } else {
    // ---- 3. save the old values, then correct them in one transaction
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakDir = join(APP, 'backups');
    mkdirSync(bakDir, { recursive: true });
    const bak = join(bakDir, `migration-checksums-${stamp}.json`);
    writeFileSync(bak, JSON.stringify({ at: new Date().toISOString(), dir: MIGRATIONS, rows: lineEndingOnly }, null, 2));
    console.log(`old checksums saved: ${bak}`);
    say('3. correcting the checksums (one transaction)');
    await db.transaction(async (tx) => {
      for (const x of lineEndingOnly) {
        const res = await tx.query('update schema_migrations set checksum = $1 where filename = $2 and checksum = $3', [x.new, x.filename, x.old]); // eslint-disable-line no-await-in-loop
        if (res.affectedRows !== 1) throw new Error(`${x.filename}: expected 1 row, changed ${res.affectedRows}`);
        console.log(`  ${x.filename}: corrected`);
      }
    });
    say('DONE: the backend starts the Job Portal again within about a minute.');
  }
  await db.query('checkpoint').catch(() => {});
  await db.close(); db = null;
} catch (e) {
  console.error(`\nSTOPPED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (db) await db.close().catch(() => {});
  try { rmSync(MAINT, { force: true }); } catch { /* ignore */ }
}
