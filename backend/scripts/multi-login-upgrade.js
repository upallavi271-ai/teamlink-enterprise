#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONE-TIME UPGRADE: "SEPARATE LOGINS ON ONE EMAIL" (founder, 2026-10-21). utils/multiLoginUpgrade.js has the story.
//
//   cd backend
//   node scripts/multi-login-upgrade.js                       DRY RUN (the default): reads the database and says what it would do. Changes nothing.
//   node scripts/multi-login-upgrade.js --apply               do it (a database that is NOT prisma/dev.db: copies, the sandbox)
//   node scripts/multi-login-upgrade.js --undo <manifest.json>  put it back
//   node scripts/multi-login-upgrade.js --apply --allow-rebuild   when the rule is written INSIDE the User table: rebuild that table
//                                                               (stop the server first)
//
//   THE REAL DATABASE (prisma/dev.db) needs, on top of --apply:
//        --really-real   and   the environment variable TL_ALLOW_REAL_APPLY=1
//   PowerShell:   $env:TL_ALLOW_REAL_APPLY='1'; node scripts/multi-login-upgrade.js --apply --really-real
//
// What --apply does, in order: a backup copy of the whole database (to %USERPROFILE%\.teamlink-backups, or TL_BACKUP_DIR), then in ONE
// transaction the one-login-per-email rule is dropped (People sign in with their email only; no number is given to any login), then an undo
// manifest is written next to the backup. It never deletes a user and never touches a password. Run twice: the second time
// finds nothing to do. It prints counts only - no e-mail address, no hash, no secret.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env'), override: false });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function dbFileOf(url) {
  const m = /^file:(.*?)(\?.*)?$/.exec(String(url || ''));
  if (!m) return null;
  let p = m[1];
  if (p.startsWith('//')) p = p.slice(2);
  return path.isAbsolute(p) || /^[A-Za-z]:/.test(p) ? path.resolve(p) : path.resolve(BACKEND, 'prisma', p);
}
const file = dbFileOf(process.env.DATABASE_URL);
const REAL = path.join(BACKEND, 'prisma', 'dev.db');
const isReal = !!file && file.toLowerCase() === REAL.toLowerCase();
const apply = has('--apply');
const undoFile = valueOf('--undo');

function refuse(msg, code = 2) { console.error(`Refusing: ${msg}`); process.exit(code); }

if (!file || !fs.existsSync(file)) refuse(`the database file was not found (DATABASE_URL -> ${file || 'not set'}).`);
if ((apply || undoFile) && isReal) {
  if (!has('--really-real')) refuse('this is the REAL database (prisma/dev.db). Add --really-real (and TL_ALLOW_REAL_APPLY=1) if you mean it.');
  if (process.env.TL_ALLOW_REAL_APPLY !== '1') refuse('TL_ALLOW_REAL_APPLY=1 is not set. Set it for this one command if you mean to change the REAL database.');
}
if (apply && undoFile) refuse('use --apply or --undo, not both.');

(async () => {
  const U = require(path.join(BACKEND, 'src/utils/multiLoginUpgrade'));
  const prisma = require(path.join(BACKEND, 'src/db'));
  const backupDir = U.defaultBackupDir();
  try {
    if (undoFile) {
      if (!fs.existsSync(undoFile)) refuse(`the undo manifest ${undoFile} was not found.`, 1);
      const r = await U.undo(undoFile);
      if (!r.ok) { console.error(`Not undone: ${r.reason}`); process.exitCode = 1; return; }
      console.log(`UNDONE. The one-login-per-email rule is ${r.restoredRule ? 'back' : 'unchanged'}.`);
      return;
    }

    const s = await U.inspect();
    const ruleText = s.emailIndex.kind === 'standalone' ? 'ON (a separate index, can be dropped)' : s.emailIndex.kind === 'inline' ? 'ON (written inside the User table: the table must be rebuilt)' : 'OFF (several logins on one email are allowed)';
    console.log(`${apply ? 'APPLY' : 'DRY RUN (nothing is changed)'} - database: ${isReal ? 'the REAL database prisma/dev.db' : path.basename(s.database || '')}`);
    console.log(`  logins (users)                   : ${s.users}`);
    console.log(`  emails used by more than 1 login : ${s.sharedEmailGroups}`);
    console.log(`  one-login-per-email rule         : ${ruleText}`);
    console.log(`  small internal tables already added: ${s.loginIdColumn && s.employeeLoginTable && s.counterTable ? 'yes' : 'no (added by --apply)'}`);

    if (s.upToDate) { console.log('Nothing to do: several logins on one email is already switched on.'); return; }

    if (!apply) {
      console.log('\nWhat --apply would do:');
      console.log(`  1. make a backup copy of the whole database in ${backupDir}`);
      if (s.emailIndex.kind === 'inline') console.log('  2. REBUILD the User table without the email rule (server must be stopped; needs --allow-rebuild)');
      else if (s.emailIndex.kind === 'standalone') console.log('  2. drop the one-login-per-email index (a plain lookup index replaces it)');
      console.log('  3. write an undo manifest next to the backup');
      console.log('No user is deleted and no password is touched. Run again with --apply to do it.');
      return;
    }

    if (s.emailIndex.kind === 'inline') {
      if (!has('--allow-rebuild')) {
        console.error('The email rule is written inside the User table, so the table has to be REBUILT. Stop the TeamLink server first, then run the same command with --allow-rebuild added.');
        process.exitCode = 3;
        return;
      }
      const b = await U.backupTo(backupDir, 'before-multi-login-rebuild');
      console.log(`Backup written (${Math.round(b.size / 1024)} KB): ${b.file}`);
      await prisma.$disconnect();
      const r = U.rebuildUserTable(file, { backupFile: b.file });
      fs.writeFileSync(path.join(backupDir, `multi-login-rebuild-manifest-${Date.now()}.json`), JSON.stringify({ rebuilt: true, backup: b.file, oldSql: r.oldSql }, null, 2));
      console.log('The User table was rebuilt without the email rule (foreign keys checked).');
      await prisma.$connect();
    }

    const out = await U.apply({ backupDir, who: 'multi-login-upgrade script', skipBackup: s.emailIndex.kind === 'inline' });
    if (out.alreadyDone) { console.log('Nothing to do: already switched on.'); return; }
    if (out.needsRebuild) { console.error('The User table still carries the rule; run with --allow-rebuild.'); process.exitCode = 3; return; }
    if (out.backup) console.log(`Backup written (${Math.round(out.backup.size / 1024)} KB): ${out.backup.file}`);
    console.log(`Done. Several logins on one email: ${out.after.multiLoginOn ? 'ON' : 'still OFF'}.`);
    console.log(`Undo manifest: ${out.manifestFile}`);
    console.log(`To undo: node scripts/multi-login-upgrade.js --undo "${out.manifestFile}"${isReal ? ' --really-real   (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
})().catch((err) => { console.error(`Failed: ${err && err.message}`); process.exit(1); });
