#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// SWITCH OFF THE LOGINS OF PEOPLE WHO HAVE LEFT  (founder, 2026-10-14; diagnosis: 7 Exited employees still Active)
//
//   node scripts/deactivate-exited-logins.js                 DRY RUN (default): lists the logins, writes NOTHING
//   node scripts/deactivate-exited-logins.js --apply         backup first, then User.status = Inactive + audit rows
//   node scripts/deactivate-exited-logins.js --undo <file>   set every login back to the status it had
//   --db <sqlite file>   another database (a COPY / the sandbox). Default: .env DATABASE_URL.
//
// Only employees whose status is Exited / Relieved / Terminated and whose login is still Active. A Super Admin or
// Admin login, and test rows (ZZTEST / example.test), are never touched. Nothing is deleted.
// SAFETY: --apply on the REAL database needs BOTH --really-real AND TL_ALLOW_REAL_APPLY=1; backup + undo manifest.
// (The server also refuses sign-in for these people now: utils/leftLogin.js; this script just tidies the Users list.)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
require('dotenv').config({ path: path.join(BACKEND, '.env') });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const dbArg = opt('--db');
if (dbArg) process.env.DATABASE_URL = `file:${path.resolve(dbArg).replace(/\\/g, '/')}`;
const REAL_DB = path.resolve(BACKEND, 'prisma', 'dev.db').toLowerCase();
function dbFileNow() {
  const url = String(process.env.DATABASE_URL || 'file:./dev.db').trim().replace(/^["']|["']$/g, '').replace(/^file:/, '').replace(/[?#].*$/, '');
  return path.isAbsolute(url) ? path.resolve(url) : path.resolve(BACKEND, 'prisma', url);
}
const isRealDb = () => dbFileNow().toLowerCase() === REAL_DB;
function guardReal(what) {
  if (!isRealDb()) return;
  if (!has('--really-real')) throw new Error(`This is the REAL database. ${what} needs --really-real (run the dry run first and get it approved).`);
  if (process.env.TL_ALLOW_REAL_APPLY !== '1') throw new Error(`This is the REAL database. ${what} also needs the environment variable TL_ALLOW_REAL_APPLY=1.`);
}

// eslint-disable-next-line import/order
const prisma = require('../src/db');

const TEST_ROW = /zztest|example\.test/i;
const LEFT = ['Exited', 'Relieved', 'Terminated'];
const mask = (s) => (s ? String(s).replace(/^(.).*@/, '$1***@') : null);

async function plan() {
  const emps = await prisma.employee.findMany({
    where: { employmentStatus: { in: LEFT }, userId: { not: null } },
    include: { user: true },
  });
  return emps.filter((e) => e.user && (e.user.status || 'Active') === 'Active'
    && !['SUPER_ADMIN', 'ADMIN'].includes(e.user.role) && !TEST_ROW.test(`${e.name} ${e.email} ${e.user.email}`));
}

async function apply(rows) {
  guardReal('--apply');
  if (!rows.length) { console.log('Nothing to do.'); return; }
  const backup = require('../src/utils/backup'); // eslint-disable-line global-require
  const b = await backup.makeBackup({ reason: 'before switching off logins of people who left', by: 'deactivate-exited-logins.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  await prisma.$transaction(async (tx) => {
    for (const e of rows) {
      await tx.user.update({ where: { id: e.user.id }, data: { status: 'Inactive' } });
      undo.rows.push({ userId: e.user.id, status: e.user.status || 'Active' });
      await tx.auditLog.create({ data: { action: `Login switched off for ${e.name} (${e.employmentStatus})`, entity: 'User', entityId: e.user.id, fromValue: 'Active', toValue: 'Inactive', reason: 'Employee has left (deactivate-exited-logins.js)', actorName: 'System (deactivate-exited-logins.js)' } });
    }
  }, { timeout: 120000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `deactivate-exited-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Switched off ${undo.rows.length} login(s). Undo: node scripts/deactivate-exited-logins.js --undo "${file}"${isRealDb() ? ' --really-real  (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function undoRun(file) {
  guardReal('--undo');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  await prisma.$transaction(async (tx) => {
    for (const r of u.rows) await tx.user.update({ where: { id: r.userId }, data: { status: r.status } });
    await tx.auditLog.create({ data: { action: `Logins switched back on (undo, ${u.rows.length})`, entity: 'User', actorName: 'System (deactivate-exited-logins.js)' } });
  });
  console.log(`Undone: ${u.rows.length} login(s) restored.`);
}

(async () => {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const rows = await plan();
  console.log(`\nLogins of people who have left but are still Active: ${rows.length}`);
  rows.forEach((e) => console.log(`  - ${e.name} (${e.employeeCode}) ${e.employmentStatus} | login ${mask(e.user.email)} role ${e.user.role}`));
  if (has('--apply')) await apply(rows);
  else console.log('\nDRY RUN - nothing was written. Add --apply to switch these logins off (backup + undo manifest first).');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
