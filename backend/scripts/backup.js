#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TeamLink backup — command line (utils/backup.js does the work).
//
//   npm run backup              make a backup now, then run the restore test
//   npm run backup:verify       run the restore test on the newest backup
//   npm run backup -- --list    show the backups that are kept
//
// Options: --reason <text>   why (shown on Administration → System)
//          --by <name>       who asked
//          --name <set>      (verify) test this backup instead of the newest
//          --no-verify       (backup) skip the restore test
//          --notify-on-fail  tell Super Admins in-app if it fails (the daily run)
//          --json            print the result as JSON
//
// Backups go to BACKUP_DIR (default %USERPROFILE%\.teamlink-backups), never
// inside the project folder. The database copy is made with SQLite
// `VACUUM INTO`, so it is safe to run while the server is running.
// ---------------------------------------------------------------------------
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
require('dotenv').config({ path: path.join(BACKEND, '.env') });

// eslint-disable-next-line import/order
const backup = require('../src/utils/backup');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const asJson = has('--json');
const stamp = () => new Date().toISOString();
const log = (m) => { if (!asJson) console.log(`[backup ${stamp()}] ${m}`); };
const mb = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`;

async function notifyFail(title, text) {
  try {
    // eslint-disable-next-line global-require
    const prisma = require('../src/db');
    const admins = (await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true, name: true, email: true } }))
      .filter((u) => !/zztest|example\.test/i.test(`${u.name} ${u.email}`));
    for (const u of admins) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message: text, channel: 'In-App', recipient: u.name || null, status: 'Delivered' } });
    }
    await prisma.$disconnect();
  } catch (err) { log(`could not post the in-app alert: ${err.message}`); }
}

async function main() {
  const verifyOnly = has('--verify');
  if (has('--list')) {
    const s = backup.summary();
    console.log(`Backup folder: ${s.folder}`);
    s.sets.forEach((x) => console.log(`  ${x.name}  ${mb(x.sizeBytes)}  ${x.reason}  restore test: ${x.verify ? (x.verify.ok ? 'OK' : 'FAIL') : 'not run'}`));
    if (!s.sets.length) console.log('  (no backups yet)');
    return 0;
  }
  let result = {};
  if (!verifyOnly) {
    log(`backing up ${backup.dbFile()} -> ${backup.backupRoot()}`);
    try {
      result.backup = await backup.makeBackup({ reason: opt('--reason') || 'manual', by: opt('--by'), log });
      log(`backup ${result.backup.name} done (${mb(result.backup.sizeBytes)})`);
    } catch (err) {
      if (err.code === 'EBUSY_BACKUP') { log(err.message); if (asJson) console.log(JSON.stringify({ ok: false, busy: true, error: err.message })); return 3; }
      log(`BACKUP FAILED: ${err.message}`);
      if (has('--notify-on-fail')) await notifyFail('Daily backup failed', `Today's backup did not finish: ${err.message}. Open Administration → System and press "Back up now".`);
      if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }));
      return 1;
    }
    if (has('--no-verify')) { if (asJson) console.log(JSON.stringify({ ok: true, ...result })); return 0; }
  }
  result.verify = await backup.verifyBackup({ name: opt('--name'), log });
  if (!asJson) {
    const v = result.verify;
    console.log(`RESTORE TEST: ${v.ok ? 'OK' : 'FAIL'}  (${v.name || '-'})`);
    if (v.counts) Object.entries(v.counts).forEach(([t, n]) => console.log(`  ${t.padEnd(12)} ${n}`));
    (v.problems || []).forEach((p) => console.log(`  problem: ${p}`));
  } else {
    console.log(JSON.stringify({ ok: !!result.verify.ok, ...result }));
  }
  if (!result.verify.ok && has('--notify-on-fail')) {
    await notifyFail('Backup restore test failed', `The restore test of backup ${result.verify.name || ''} failed: ${(result.verify.problems || []).join('; ')}. Open Administration → System.`);
  }
  return result.verify.ok ? 0 : 2;
}

main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 1; });
