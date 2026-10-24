#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// A SHARED HR LOGIN, COPIED FROM DIVYA'S (founder, 2026-10-23): "take Divya's login as the reference; create one HR login
// (hr@tmlink.in); whatever Divya can see, HR must see too."
//
// WHAT IT DOES: makes ONE new login (User row) with exactly the same ACCESS as the reference login: role, HRMS / ATS / Accounts roles and
// switches, ATS department scope, landing screen, branch. Only the identity differs (name "HR", the new email, the new password). Nothing of
// the reference login is changed. No employee record is made (it is a shared desk login, not a person on the staff list).
// The password is NEVER written in this file or printed: pass it in TL_NEW_PASSWORD.
//   node scripts/create-hr-login.js                                              DRY RUN (default): shows what would be created
//   TL_NEW_PASSWORD=... node scripts/create-hr-login.js --apply [--db <copy.db>] creates it (on prisma/dev.db also needs --really-real and TL_ALLOW_REAL_APPLY=1)
//   node scripts/create-hr-login.js --undo <manifest.json> [--db <db>] [--really-real]    deletes the login it made
//   --from <email of the reference login>   --email <new login email>   --name <display name>
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest; one transaction; running it twice does nothing the second time.
// The LIVE site has its own database: run the same script there (the reference login must exist there).
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
const FROM = String(val('--from', 'tdivyasri@tmlink.in')).toLowerCase();
const EMAIL = String(val('--email', 'hr@tmlink.in')).toLowerCase();
const NAME = val('--name', 'HR');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `hr-login-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `hr-login-${STAMP}`) : path.join(OUT, 'backup')));

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

// identity and session columns: never copied (everything else - the ACCESS - is)
const NOT_COPIED = new Set(['id', 'name', 'email', 'username', 'passwordHash', 'setPasswordTokenHash', 'setPasswordExpiresAt', 'setPasswordUsedAt', 'passwordChangedAt',
  'passwordResetRequired', 'failedLoginCount', 'lockedUntil', 'lastLoginAt', 'lastLoginIp', 'createdAt', 'updatedAt', 'employeeId', 'clientId', 'candidateId', 'deletedAt', 'avatar']);

(async () => {
  try {
    if (UNDO) {
      const m = JSON.parse(fs.readFileSync(path.resolve(UNDO), 'utf8'));
      const u = await prisma.user.findUnique({ where: { id: m.id }, select: { id: true, email: true } });
      if (!u || u.email !== m.email) { console.log('Nothing to undo (the login is not there).'); return; }
      await prisma.$transaction(async (tx) => { await tx.session?.deleteMany?.({ where: { userId: m.id } }).catch?.(() => {}); await tx.user.delete({ where: { id: m.id } }); });
      console.log(`Undone: ${m.email} is deleted.`);
      return;
    }
    const ref = await prisma.user.findFirst({ where: { email: FROM } });
    if (!ref) { console.error(`No reference login with the email ${FROM}.`); process.exit(1); }
    const existing = await prisma.user.findFirst({ where: { OR: [{ email: EMAIL }, { username: EMAIL }] }, select: { id: true, name: true, role: true } });
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log(`Reference: ${ref.name} <${ref.email}>  role ${ref.role}, HRMS ${ref.hrmsRole}, ATS ${ref.atsRole}, Accounts ${ref.accountsRole}, scope ${ref.atsScopeDepartments || '-'}`);
    if (existing) { console.log(`Already there: ${existing.name} <${EMAIL}> (${existing.role}). Nothing to create.`); return; }
    const copy = {};
    Object.keys(ref).filter((k) => !NOT_COPIED.has(k)).forEach((k) => { copy[k] = ref[k]; });
    console.log(`Would create: ${NAME} <${EMAIL}> with the same access (${Object.keys(copy).length} columns copied, identity and password new).`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
    const pw = process.env.TL_NEW_PASSWORD || '';
    if (pw.length < 8) { console.error('Set TL_NEW_PASSWORD (at least 8 characters) in the environment.'); process.exit(1); }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    let made = null;
    await prisma.$transaction(async (tx) => {
      made = await tx.user.create({
        data: { ...copy, name: NAME, email: EMAIL, username: EMAIL, passwordHash: bcrypt.hashSync(pw, 10), passwordChangedAt: new Date(), passwordResetRequired: false, status: 'Active' },
      });
      await tx.auditLog.create({ data: { action: 'Shared HR login created (same access as the reference HR login)', entity: 'User', entityId: made.id, toValue: `${EMAIL} (copied from ${FROM})`, actorName: 'Founder request 2026-10-23' } });
    });
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = path.join(OUT, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), db: dbArg, id: made.id, email: made.email }, null, 1));
    console.log(`\nCREATED ${EMAIL}. Sign in with the password you set.\nBackup: ${bak}\nUndo:   node scripts/create-hr-login.js --undo "${manifest}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 500)); process.exit(1); });
