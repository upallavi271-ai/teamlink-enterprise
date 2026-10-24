#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// ONE REQUIREMENT SERIES (founder, 2026-10-22): every requirement gets a REQ-xxxx code.
//
// WHY. The imported department sheets gave each department its own numbering (EDU-, MED-, MFG-, ITR-; each starts again at 1, so MED-2762 and
// EDU-2762 both exist). Codes that already start with REQ- are kept EXACTLY as they are. The others are renumbered in creation order
// (oldest first) into the free REQ numbers, REQ-0001 upward, skipping every number already used.
//
// WHAT IT CHANGES (only these, in one transaction):
//   Requirement.reqCode            old EDU-/MED-/MFG-/ITR- code  ->  REQ-xxxx
//   JoiningRecord.jobCode          the same code, where a joining record repeats it (the joinings sheets)
//   RequirementOldCode             NEW table (requirementId, oldCode, oldKey): the old code stays SEARCHABLE (type MED-2835, find it); never shown
//   AuditLog                       ONE summary line
// It does NOT rewrite history text (follow-up notes, audit lines, notifications) or external ids on job boards (RequirementPosting.externalJobId):
// those keep the code that was true when they were written, and the old code still finds the requirement.
// The full old -> new list is written to a CSV for the founder (default C:/Users/user/Desktop/TeamLink-Requirement-Code-Mapping.csv).
//
//   node scripts/renumber-requirement-codes-2026-10-22.js                      DRY RUN (default): reads a copy, writes only the CSV
//   node scripts/renumber-requirement-codes-2026-10-22.js --db <copy.db> --apply         really writes - on a COPY
//   node scripts/renumber-requirement-codes-2026-10-22.js --apply --really-real          really writes into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/renumber-requirement-codes-2026-10-22.js --undo <manifest.json> [--db <db>] [--really-real]
//   --csv <path>  the mapping file   --out <dir>  undo manifest folder   --backup-dir <dir>  where the pre-change backup goes
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest (old codes); ONE transaction; running it twice changes nothing.
// The LIVE site has its own database: run it there too (after the deploy), the numbering is worked out from that database's own rows.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const UNDO = val('--undo');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `renumber-req-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `renumber-req-${STAMP}`) : path.join(OUT, 'backup')));
const CSV = path.resolve(val('--csv', 'C:/Users/user/Desktop/TeamLink-Requirement-Code-Mapping.csv'));

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const { keyOf } = require('../src/utils/requirementOldCode');

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, cols, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `\ufeff${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}${rows.length ? '\n' : ''}`); };
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;

function vacuumFromReadOnly(src, dest) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(src, { readOnly: true });
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); if (fs.existsSync(dest)) fs.unlinkSync(dest); db.exec(`VACUUM INTO ${sqlq(dest)}`); } finally { db.close(); }
}
async function vacuumInto(prisma, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlq(dest)}`);
}

const CREATE_TABLE = 'CREATE TABLE IF NOT EXISTS "RequirementOldCode" ("requirementId" TEXT NOT NULL, "oldCode" TEXT NOT NULL, "oldKey" TEXT NOT NULL, "renumberedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("requirementId", "oldCode"))';
const CREATE_INDEX = 'CREATE INDEX IF NOT EXISTS "RequirementOldCode_oldKey_idx" ON "RequirementOldCode"("oldKey")';

// ------------------------------------------------------------------------------------------- PLAN
async function plan(prisma) {
  const all = await prisma.$queryRawUnsafe('SELECT r.id, r.reqCode, r.title, r.department, r.createdAt, c.name AS clientName FROM Requirement r LEFT JOIN Client c ON c.id = r.clientId ORDER BY r.createdAt ASC, r.id ASC');
  const used = new Set();
  all.forEach((r) => { if (/^REQ-\d+$/.test(String(r.reqCode || ''))) used.add(Number(r.reqCode.slice(4))); });
  const todo = all.filter((r) => r.reqCode && !/^REQ-\d+$/.test(r.reqCode));
  const noCode = all.filter((r) => !r.reqCode).length;
  let n = 0; const rows = [];
  todo.forEach((r) => {
    do { n += 1; } while (used.has(n));
    used.add(n);
    rows.push({ id: r.id, oldCode: r.reqCode, newCode: `REQ-${String(n).padStart(4, '0')}`, title: r.title, client: r.clientName, department: r.department, createdAt: r.createdAt ? new Date(Number(r.createdAt)).toISOString().slice(0, 10) : '' });
  });
  const byPrefix = {};
  rows.forEach((r) => { const p = r.oldCode.split('-')[0]; byPrefix[p] = (byPrefix[p] || 0) + 1; });
  return {
    rows, summary: { requirements: all.length, alreadyREQ: all.length - todo.length - noCode, willBeRenumbered: rows.length, withNoCode: noCode, byOldPrefix: byPrefix, firstNew: rows[0] && rows[0].newCode, lastNew: rows.length ? rows[rows.length - 1].newCode : null },
  };
}

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, rows, summary) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  if (!rows.length) { console.log('NOTHING TO DO: every requirement already carries a REQ- code (no backup, nothing written).'); return null; }
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  console.log(`backup written: ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
  const manifest = { stamp: STAMP, database: dbArg, backup, status: 'planned', map: rows.map((r) => [r.id, r.oldCode, r.newCode]), auditId: null, summary };
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(CREATE_TABLE);
      await tx.$executeRawUnsafe(CREATE_INDEX);
      for (const r of rows) {
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe('UPDATE Requirement SET reqCode = ? WHERE id = ? AND reqCode = ?', r.newCode, r.id, r.oldCode);
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe('INSERT OR IGNORE INTO RequirementOldCode (requirementId, oldCode, oldKey) VALUES (?, ?, ?)', r.id, r.oldCode, keyOf(r.oldCode));
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe('UPDATE JoiningRecord SET jobCode = ? WHERE jobCode = ?', r.newCode, r.oldCode);
      }
      const audit = await tx.auditLog.create({
        data: {
          action: 'Requirement codes moved to one REQ series', entity: 'Requirement', fromValue: `${rows.length} requirement(s) with EDU- / MED- / MFG- / ITR- codes`,
          toValue: `${rows[0].newCode} ... ${rows[rows.length - 1].newCode}`, reason: 'Founder asked for one series. The old codes stay searchable.',
        },
      });
      manifest.auditId = audit.id;
    }, { timeout: 300000, maxWait: 60000 });
    manifest.status = 'committed';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  } catch (err) {
    manifest.status = 'failed'; manifest.error = String(err.message || err).slice(0, 600);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    throw err;
  }
  console.log(`changed: ${rows.length} requirement code(s)`);
  return manifestPath;
}

// ------------------------------------------------------------------------------------------- UNDO
async function undo(prisma) {
  const m = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO of ${m.stamp}: ${m.map.length} requirement code(s)`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  await vacuumInto(prisma, path.join(BACKUP_DIR, 'before-undo.db'));
  const out = { restored: 0, skipped: [] };
  await prisma.$transaction(async (tx) => {
    for (const [id, oldCode, newCode] of m.map) {
      // eslint-disable-next-line no-await-in-loop
      const changed = await tx.$executeRawUnsafe('UPDATE Requirement SET reqCode = ? WHERE id = ? AND reqCode = ?', oldCode, id, newCode);
      if (!changed) { out.skipped.push(`${id}: the code is no longer ${newCode} - left as it is`); continue; }
      // eslint-disable-next-line no-await-in-loop
      await tx.$executeRawUnsafe('UPDATE JoiningRecord SET jobCode = ? WHERE jobCode = ?', oldCode, newCode);
      // eslint-disable-next-line no-await-in-loop
      await tx.$executeRawUnsafe('DELETE FROM RequirementOldCode WHERE requirementId = ? AND oldCode = ?', id, oldCode);
      out.restored += 1;
    }
    if (m.auditId) await tx.auditLog.deleteMany({ where: { id: m.auditId } });
  }, { timeout: 300000, maxWait: 60000 });
  console.log(JSON.stringify(out, null, 1));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    if (UNDO) { await undo(prisma); return; }
    let work = prisma; let tmp = null;
    if (!APPLY) {
      tmp = path.join(os.tmpdir(), `renumber-req-dryrun-${Date.now()}.db`);
      vacuumFromReadOnly(dbArg, tmp); // a read-only copy: a dry run cannot touch the database
      work = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
    }
    const { rows, summary } = await plan(work);
    writeCsv(CSV, ['oldCode', 'newCode', 'title', 'client', 'department', 'createdAt'], rows);
    console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, ...summary, csv: CSV }, null, 1));
    if (APPLY) {
      const done = await apply(prisma, rows, summary);
      if (done) console.log('APPLIED. undo manifest:', done);
    } else {
      await work.$disconnect();
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      console.log('DRY RUN - nothing was written to the database.');
    }
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
