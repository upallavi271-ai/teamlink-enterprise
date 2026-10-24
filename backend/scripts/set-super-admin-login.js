#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// THE SUPER ADMIN LOGIN IS chitturi.vasu84@gmail.com (founder, 2026-10-23).
//
//   * the gmail account ("Vasudeva Rao Chitturi", SUPER_ADMIN, linked to employee TL063) gets the new password;
//   * the older "admin@teamlink.com" account ("Vasu Chitturi") is switched OFF (status Inactive), so only the gmail login remains.
//     Nothing is deleted: its history (audit rows, notes, tasks) stays, and --undo switches it back on.
//
// The password is NEVER written in this file or printed: pass it in the environment variable TL_NEW_PASSWORD when you run it.
//   node scripts/set-super-admin-login.js                                       DRY RUN (default): shows what would change, writes nothing
//   TL_NEW_PASSWORD=... node scripts/set-super-admin-login.js --apply [--db <copy.db>]   really writes (on prisma/dev.db it also needs --really-real and TL_ALLOW_REAL_APPLY=1)
//   node scripts/set-super-admin-login.js --undo <manifest.json> [--db <db>] [--really-real]
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest (old hash, old status); one transaction; running it twice changes nothing more.
// The LIVE site (teamlink.teamlinks.in) has its own database: run the same script there.
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
const KEEP = (val('--keep', 'chitturi.vasu84@gmail.com') || '').toLowerCase();
const OLD = (val('--off', 'admin@teamlink.com') || '').toLowerCase();
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `super-admin-login-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `super-admin-login-${STAMP}`) : path.join(OUT, 'backup')));

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

(async () => {
  try {
    if (UNDO) {
      const m = JSON.parse(fs.readFileSync(path.resolve(UNDO), 'utf8'));
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: m.keep.id }, data: { passwordHash: m.keep.oldHash, passwordChangedAt: m.keep.oldChangedAt ? new Date(m.keep.oldChangedAt) : null } });
        if (m.off) await tx.user.update({ where: { id: m.off.id }, data: { status: m.off.oldStatus } });
      });
      console.log('Undone: the old password hash and the old status are back.');
      return;
    }
    const keep = await prisma.user.findFirst({ where: { email: KEEP }, select: { id: true, name: true, email: true, role: true, status: true, passwordHash: true, passwordChangedAt: true } });
    const off = OLD && OLD !== KEEP ? await prisma.user.findFirst({ where: { email: OLD }, select: { id: true, name: true, email: true, role: true, status: true } }) : null;
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    if (!keep) { console.error(`No user with the email ${KEEP}.`); process.exit(1); }
    if (!['SUPER_ADMIN', 'ADMIN'].includes(keep.role)) { console.error(`${KEEP} is a ${keep.role}, not a Super Admin / Admin. Nothing changed.`); process.exit(1); }
    console.log(`KEEP   ${keep.name} <${keep.email}>  ${keep.role}, ${keep.status}  -> new password`);
    console.log(off ? `OFF    ${off.name} <${off.email}>  ${off.role}, ${off.status}  -> status Inactive (nothing deleted)` : `OFF    (no account with ${OLD})`);
    const pw = process.env.TL_NEW_PASSWORD || '';
    if (!APPLY) { console.log(`\nDRY RUN: nothing was changed.${pw ? '' : ' (TL_NEW_PASSWORD is not set; it is needed with --apply.)'}`); return; }
    if (pw.length < 8) { console.error('Set TL_NEW_PASSWORD (at least 8 characters) in the environment.'); process.exit(1); }
    if (keep.status !== 'Active') { console.error(`${KEEP} is ${keep.status}; it must be Active.`); process.exit(1); }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = path.join(OUT, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), db: dbArg, keep: { id: keep.id, oldHash: keep.passwordHash, oldChangedAt: keep.passwordChangedAt }, off: off ? { id: off.id, oldStatus: off.status } : null }, null, 1));
    const hash = bcrypt.hashSync(pw, 10);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: keep.id }, data: { passwordHash: hash, passwordChangedAt: new Date() } });
      if (off && off.status !== 'Inactive') await tx.user.update({ where: { id: off.id }, data: { status: 'Inactive' } });
      await tx.auditLog.create({ data: { userId: keep.id, action: 'Super Admin login set (password changed; old admin login switched off)', entity: 'User', entityId: keep.id, toValue: off ? `${OLD} switched off` : 'password only', actorName: 'Founder request 2026-10-23' } });
    });
    console.log(`\nDONE. Sign in as ${KEEP} with the new password.${off ? ` ${OLD} can no longer sign in.` : ''}\nBackup: ${bak}\nUndo:   node scripts/set-super-admin-login.js --undo "${manifest}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 400)); process.exit(1); });
