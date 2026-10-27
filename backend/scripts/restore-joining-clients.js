#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// BRING BACK, AS INACTIVE, THE CLIENTS THE JOININGS SHEETS NEED (founder 2026-10-27):
//   "the joinings list must show what the joinings sheets show" + asked: the colleges that are not zip clients come back as INACTIVE
//   clients (joinings history only - no new requirements).
// keep-only-zip-clients.js (2026-10-26) deleted every client without a signed agreement. 26 of them still have joinings in the Medical /
// Education joinings sheets (CMRCET, CMRIT, Aurora, JBIET ...). This copies exactly those client rows back - same id, same details -
// from the backup that script took before it deleted them, with status Inactive. Nothing else is restored (no requirements, no
// applications: the joinings import, scripts/import-joinings-2026-10-17.js, brings the joinings back from the sheets afterwards).
//
//   node scripts/restore-joining-clients.js                       DRY RUN: which names are found in the backup
//   TL_ALLOW_REAL_APPLY=1 node scripts/restore-joining-clients.js --apply --really-real
//   --from <backup.db>   default: the newest ~/.teamlink-backups/keep-only-zip-clients-*/before.db       --db <copy.db> to try on a copy
// Safe to run twice (a client already there is left alone).
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
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
function newestBackup() {
  const root = path.join(os.homedir(), '.teamlink-backups');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('keep-only-zip-clients-')).sort() : [];
  for (const d of dirs.reverse()) { const f = path.join(root, d, 'before.db'); if (fs.existsSync(f)) return f; }
  return null;
}
const FROM = val('--from') ? path.resolve(val('--from')) : newestBackup();
if (!FROM || !fs.existsSync(FROM)) { console.error('No keep-only-zip-clients backup found. Give it: --from <before.db>'); process.exit(2); }

// the client names the joinings import looks for (scripts/lib/joinings-2026-10-17/client-rules.js) that the zip clean-up removed
const NAMES = [
  'CMR College of Engineering & Technology (CMRCET)', 'DRK', 'mrits', 'AVN', 'J.B. Institute of Engineering and Technology (JBIET)',
  'Avanthi Institute of Engineering & Technology', 'kmit', 'Aurora Colleges', 'MLRIT', 'CMR Institute of Technology', "Sreya's College",
  'ACE Engineering College', 'CMR Technical Campus', "Vignan's Institute of Management and Technology for Women", 'Bhaskar Engineering College',
  'Godavari Institute of Engineering & Technology (GIET)', 'Aditya University', 'Vbit', 'Mahaveer', 'Mr Cet',
  'Shri Vishnu Engineering College for Women (SVECW)', 'Vageswari College of Engineering', 'ReLiv Healthy India Pvt Ltd', 'Ellenki',
  'Trr Medical College', 'CMR Institute of Medical Sciences',
];

process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const cur = new PrismaClient({ datasources: { db: { url: `file:${dbArg.split(path.sep).join('/')}` } } });
const bk = new PrismaClient({ datasources: { db: { url: `file:${FROM.split(path.sep).join('/')}` } } });

(async () => {
  try {
    const old = await bk.client.findMany();
    const here = await cur.client.findMany({ select: { id: true, name: true } });
    const hereIds = new Set(here.map((c) => c.id));
    const hereNames = new Set(here.map((c) => c.name.trim().toLowerCase()));
    const plan = []; const missing = []; const already = [];
    for (const n of NAMES) {
      const row = old.find((c) => c.name.trim().toLowerCase() === n.toLowerCase());
      if (!row) { missing.push(n); continue; } // eslint-disable-line no-continue
      if (hereIds.has(row.id) || hereNames.has(n.toLowerCase())) { already.push(n); continue; } // eslint-disable-line no-continue
      plan.push(row);
    }
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}\nBackup read: ${FROM}`);
    console.log(`To bring back as Inactive: ${plan.length}${plan.length ? `  -> ${plan.map((r) => r.name).join(' | ')}` : ''}`);
    if (already.length) console.log(`Already here (left alone): ${already.length}`);
    if (missing.length) console.log(`Not in the backup: ${missing.join(' | ')}`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
    if (!plan.length) { console.log('\nNothing to do.'); return; }
    const bakDir = path.join(isReal ? path.join(os.homedir(), '.teamlink-backups') : path.dirname(dbArg), `restore-joining-clients-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await cur.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    await cur.$transaction(async (tx) => {
      for (const row of plan) await tx.client.create({ data: { ...row, status: 'Inactive' } });
      await tx.auditLog.create({ data: { action: `Clients brought back as Inactive for the joinings sheets: ${plan.length}`, entity: 'Client', toValue: plan.map((r) => r.name).join(', ').slice(0, 900), actorName: 'Joinings sheets 2026-10-27' } });
    });
    console.log(`\nDONE: ${plan.length} client(s) back, status Inactive.\nBackup (before this): ${bak}`);
  } finally { await cur.$disconnect(); await bk.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
