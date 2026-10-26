#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// GET BACK THE ROWS AN OLD DEPLOY THREW AWAY (2026-10-24 data-loss bug).
//
// The live database runs in WAL mode: the newest committed rows sit in dev.db-wal until SQLite checkpoints them into dev.db.
// Until commit 30d4dd8 the deploy moved the running backend to backend-old-<stamp>, copied ONLY dev.db into the new backend and
// deleted the -wal file, so whatever was in dev.db-wal at that moment was lost from the live site. It is still on disk in
//   /opt/teamlink-enterprise/backend-old-<stamp>/prisma/dev.db-wal
// This script reads three databases, side by side, with SQLite itself (ATTACH, so every value is copied byte for byte):
//   FULL   the old dev.db WITH its WAL      = the live data at the moment of that deploy
//   KEPT   the old dev.db WITHOUT the WAL   = what the deploy actually carried over
//   LIVE   the database the site uses now
// and, table by table (by primary key, over the columns all three share):
//   lost insert  a row in FULL that is not in KEPT  -> put back in LIVE when LIVE does not have that key
//   lost update  a row that differs FULL vs KEPT    -> LIVE gets the FULL version only when LIVE still equals KEPT (nobody changed it since)
//   lost delete  a row in KEPT that is not in FULL  -> removed from LIVE only when LIVE still equals KEPT
// Anything that changed again after the deploy is NOT touched and is listed as a conflict for a person to look at.
//
//   node scripts/recover-lost-wal.js --old /opt/teamlink-enterprise/backend-old-2026-10-24-173923/prisma            DRY RUN (default): counts per table
//   node scripts/recover-lost-wal.js --old <dir> --list Users,EmployeeIdea                                           also prints the keys of those tables
//   TL_ALLOW_REAL_APPLY=1 node scripts/recover-lost-wal.js --old <dir> --apply --really-real                       writes (backup first)
//   --db <live dev.db>   (default: prisma/dev.db next to this script)      --work <dir> for the temporary copies
// Several old folders: run it once per folder, OLDEST first.
// SAFETY: dry run by default; the live database is backed up with VACUUM INTO before anything is written; one transaction; a JSON
// report of every key written (the undo list) is saved next to the backup. The old folder is only read (copies are made in --work).
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(BACK, 'prisma', 'dev.db');
const LIVE = path.resolve(val('--db', DEFAULT_DB));
const OLD = val('--old');
const APPLY = has('--apply');
const LIST = new Set(String(val('--list', '') || '').split(',').map((s) => s.trim()).filter(Boolean));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const WORK = path.resolve(val('--work', path.join(os.tmpdir(), `recover-wal-${STAMP}`)));
const isReal = LIVE.toLowerCase() === DEFAULT_DB.toLowerCase();
const SKIP_TABLES = new Set(['_prisma_migrations', 'sqlite_sequence']);

if (!OLD) { console.error('Give the old backend\'s prisma folder: --old /opt/teamlink-enterprise/backend-old-<stamp>/prisma'); process.exit(2); }
const oldDb = path.join(path.resolve(OLD), 'dev.db');
const oldWal = `${oldDb}-wal`;
if (!fs.existsSync(oldDb)) { console.error(`No dev.db in ${OLD}`); process.exit(2); }
if (!fs.existsSync(oldWal) || fs.statSync(oldWal).size === 0) { console.log(`No dev.db-wal (or it is empty) in ${OLD}: that deploy lost nothing. Nothing to do.`); process.exit(0); }
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run without --apply first.');
  process.exit(2);
}

// The two read copies: FULL = dev.db + its WAL (SQLite replays the WAL on open), KEPT = dev.db alone.
const fullDir = path.join(WORK, 'full'); const keptDir = path.join(WORK, 'kept');
fs.mkdirSync(fullDir, { recursive: true }); fs.mkdirSync(keptDir, { recursive: true });
fs.copyFileSync(oldDb, path.join(fullDir, 'dev.db')); fs.copyFileSync(oldWal, path.join(fullDir, 'dev.db-wal'));
if (fs.existsSync(`${oldDb}-shm`)) fs.copyFileSync(`${oldDb}-shm`, path.join(fullDir, 'dev.db-shm'));
fs.copyFileSync(oldDb, path.join(keptDir, 'dev.db'));
const sq = (p) => p.split(path.sep).join('/').replace(/'/g, "''");

process.env.DATABASE_URL = `file:${LIVE.split(path.sep).join('/')}?connection_limit=1&socket_timeout=120`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const q = (sql) => prisma.$queryRawUnsafe(sql);
const ex = (sql) => prisma.$executeRawUnsafe(sql);
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const id = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function columnsOf(schema, table) {
  return (await q(`PRAGMA ${schema}.table_info(${id(table)})`)).map((c) => ({ name: c.name, pk: num(c.pk) }));
}

(async () => {
  try {
    console.log(`LIVE database: ${LIVE}${isReal ? '  (REAL)' : ''}\nOld folder:    ${path.resolve(OLD)}  (WAL ${(fs.statSync(oldWal).size / 1024).toFixed(0)} KB)\n`);
    // Make the FULL copy fold its WAL in (a checkpoint inside the copy), so ATTACH reads every row.
    await ex(`ATTACH DATABASE '${sq(path.join(fullDir, 'dev.db'))}' AS fullx`);
    await q('PRAGMA fullx.wal_checkpoint(TRUNCATE)');
    await ex('DETACH DATABASE fullx');
    await ex(`ATTACH DATABASE '${sq(path.join(fullDir, 'dev.db'))}' AS f`);
    await ex(`ATTACH DATABASE '${sq(path.join(keptDir, 'dev.db'))}' AS k`);
    const tables = (await q("SELECT name FROM f.sqlite_master WHERE type = 'table'")).map((r) => r.name).filter((t) => !SKIP_TABLES.has(t) && !t.startsWith('sqlite_'));
    const plan = [];
    for (const t of tables) {
      // eslint-disable-next-line no-await-in-loop
      const [cf, ck, cl] = await Promise.all([columnsOf('f', t), columnsOf('k', t), columnsOf('main', t)]);
      if (!cl.length) { plan.push({ table: t, note: 'not in the live database any more: skipped' }); continue; }
      const pk = cf.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      if (!pk.length) { plan.push({ table: t, note: 'no primary key: skipped' }); continue; }
      const common = cf.map((c) => c.name).filter((n) => ck.some((x) => x.name === n) && cl.some((x) => x.name === n));
      if (!pk.every((p) => common.includes(p))) { plan.push({ table: t, note: 'primary key changed: skipped' }); continue; }
      const on = (a, b) => pk.map((p) => `${a}.${id(p)} IS ${b}.${id(p)}`).join(' AND ');
      const same = (a, b) => common.map((c) => `${a}.${id(c)} IS ${b}.${id(c)}`).join(' AND ');
      const T = id(t);
      const keyCols = pk.map((p) => `x.${id(p)}`).join(', ');
      // eslint-disable-next-line no-await-in-loop
      const ins = await q(`SELECT ${keyCols} FROM f.${T} x WHERE NOT EXISTS (SELECT 1 FROM k.${T} y WHERE ${on('y', 'x')})`);
      // eslint-disable-next-line no-await-in-loop
      const upd = await q(`SELECT ${keyCols} FROM f.${T} x JOIN k.${T} y ON ${on('y', 'x')} WHERE NOT (${same('x', 'y')})`);
      // eslint-disable-next-line no-await-in-loop
      const del = await q(`SELECT ${keyCols} FROM k.${T} x WHERE NOT EXISTS (SELECT 1 FROM f.${T} y WHERE ${on('y', 'x')})`);
      if (!ins.length && !upd.length && !del.length) continue;
      // what LIVE allows
      // eslint-disable-next-line no-await-in-loop
      const insOk = await q(`SELECT ${keyCols} FROM f.${T} x WHERE NOT EXISTS (SELECT 1 FROM k.${T} y WHERE ${on('y', 'x')}) AND NOT EXISTS (SELECT 1 FROM main.${T} z WHERE ${on('z', 'x')})`);
      // eslint-disable-next-line no-await-in-loop
      const updOk = await q(`SELECT ${keyCols} FROM f.${T} x JOIN k.${T} y ON ${on('y', 'x')} JOIN main.${T} z ON ${on('z', 'x')} WHERE NOT (${same('x', 'y')}) AND (${same('z', 'y')})`);
      // eslint-disable-next-line no-await-in-loop
      const delOk = await q(`SELECT ${keyCols} FROM k.${T} x JOIN main.${T} z ON ${on('z', 'x')} WHERE NOT EXISTS (SELECT 1 FROM f.${T} y WHERE ${on('y', 'x')}) AND (${same('z', 'x')})`);
      plan.push({
        table: t, pk, common, lost: { insert: ins.length, update: upd.length, delete: del.length },
        doable: { insert: insOk.length, update: updOk.length, delete: delOk.length },
        conflicts: (ins.length - insOk.length) + (upd.length - updOk.length) + (del.length - delOk.length),
        keys: { insert: insOk, update: updOk, delete: delOk },
        sql: {
          insert: `INSERT INTO main.${T} (${common.map(id).join(', ')}) SELECT ${common.map((c) => `x.${id(c)}`).join(', ')} FROM f.${T} x WHERE NOT EXISTS (SELECT 1 FROM k.${T} y WHERE ${on('y', 'x')}) AND NOT EXISTS (SELECT 1 FROM main.${T} z WHERE ${on('z', 'x')})`,
          update: `UPDATE main.${T} SET (${common.map(id).join(', ')}) = (SELECT ${common.map((c) => `x.${id(c)}`).join(', ')} FROM f.${T} x WHERE ${on('x', `main.${T}`)}) WHERE EXISTS (SELECT 1 FROM f.${T} x JOIN k.${T} y ON ${on('y', 'x')} WHERE ${on('x', `main.${T}`)} AND NOT (${same('x', 'y')}) AND (${common.map((c) => `main.${T}.${id(c)} IS y.${id(c)}`).join(' AND ')}))`,
          delete: `DELETE FROM main.${T} WHERE EXISTS (SELECT 1 FROM k.${T} x WHERE ${on('x', `main.${T}`)} AND NOT EXISTS (SELECT 1 FROM f.${T} y WHERE ${on('y', 'x')}) AND (${common.map((c) => `main.${T}.${id(c)} IS x.${id(c)}`).join(' AND ')}))`,
        },
      });
    }
    const real = plan.filter((p) => p.lost);
    if (!real.length) { console.log('The WAL holds no row that the kept database lacks: nothing was lost by that deploy.'); return; }
    console.log('Table                              lost: new / changed / removed     can put back: new / changed / removed   conflicts');
    real.forEach((p) => {
      console.log(`${p.table.padEnd(34)} ${String(p.lost.insert).padStart(6)} / ${String(p.lost.update).padStart(6)} / ${String(p.lost.delete).padStart(6)}        ${String(p.doable.insert).padStart(6)} / ${String(p.doable.update).padStart(6)} / ${String(p.doable.delete).padStart(6)}        ${p.conflicts}`);
      if (LIST.has(p.table)) console.log(`   keys: ${JSON.stringify(p.keys).slice(0, 2000)}`);
    });
    plan.filter((p) => p.note).forEach((p) => console.log(`(${p.table}: ${p.note})`));
    const total = real.reduce((n, p) => n + p.doable.insert + p.doable.update + p.doable.delete, 0);
    console.log(`\n${total} row(s) can be put back. Conflicts (changed again after the deploy) are left alone.`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed. Add --apply (and on the real database --really-real with TL_ALLOW_REAL_APPLY=1) to write.'); return; }

    const backupDir = path.join(isReal ? path.join(os.homedir(), '.teamlink-backups') : WORK, `recover-wal-${STAMP}`);
    fs.mkdirSync(backupDir, { recursive: true });
    const bak = path.join(backupDir, 'live-before.db');
    await ex(`VACUUM main INTO '${sq(bak)}'`);
    await ex('PRAGMA foreign_keys = OFF');
    await ex('BEGIN');
    try {
      for (const p of real) {
        if (p.doable.insert) await ex(p.sql.insert); // eslint-disable-line no-await-in-loop
        if (p.doable.update) await ex(p.sql.update); // eslint-disable-line no-await-in-loop
        if (p.doable.delete) await ex(p.sql.delete); // eslint-disable-line no-await-in-loop
      }
      await ex('COMMIT');
    } catch (e) { await ex('ROLLBACK').catch(() => {}); throw e; } finally { await ex('PRAGMA foreign_keys = ON').catch(() => {}); }
    const report = path.join(backupDir, 'written-keys.json');
    fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), live: LIVE, old: path.resolve(OLD), tables: real.map((p) => ({ table: p.table, keys: p.keys })) }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
    console.log(`\nDONE: ${total} row(s) put back.\nBackup of the live database before this: ${bak}\nWhat was written (keys): ${report}\nTo undo: stop TeamLink, copy the backup over the live dev.db (and remove dev.db-wal / dev.db-shm), start TeamLink.`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 800)); process.exit(1); });
