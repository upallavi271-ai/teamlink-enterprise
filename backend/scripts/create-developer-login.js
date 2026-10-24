#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// A LOGIN FOR THE DEVELOPER TEAM (founder, 2026-10-24): "create one new Admin for the developer team only. It must not count in the
// headcount and its data must not show anywhere. Only the login is enough."
//
// WHAT IT DOES: makes ONE new login (User row) with the ADMIN role in HRMS, ATS and Accounts. It has NO employee record - that is what keeps
// it out of the headcount, attendance, leave, payroll, the employee lists, the approval chain and every "Everyone" message audience (all of
// those read Employee rows, and this login has none). It shows only in Administration -> Users and the Audit logs (to the Super Admin), so the Super Admin
// can always see it, switch it off or reset it; its sign-ins and actions are kept out of the dashboards' "recent activity" and login counts. Nothing else about the company is changed.
// The password is NEVER written in this file or printed: pass it in TL_NEW_PASSWORD.
//   node scripts/create-developer-login.js                                       DRY RUN (default): shows what would be created
//   TL_NEW_PASSWORD=... node scripts/create-developer-login.js --apply [--db <copy.db>]   creates it (on prisma/dev.db also needs --really-real and TL_ALLOW_REAL_APPLY=1)
//   node scripts/create-developer-login.js --undo <manifest.json> [--db <db>] [--really-real]   deletes the login it made
//   --email <login email>   --name <display name>
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest; one transaction; running it twice does nothing the second time.
// The LIVE site has its own database: run the same script there.
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
const EMAIL = String(val('--email', 'developer@tmlink.in')).toLowerCase();
const NAME = val('--name', 'Developer Team');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `developer-login-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `developer-login-${STAMP}`) : path.join(OUT, 'backup')));

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
      const u = await prisma.user.findUnique({ where: { id: m.id }, select: { id: true, email: true } });
      if (!u || u.email !== m.email) { console.log('Nothing to undo (the login is not there).'); return; }
      await prisma.$transaction(async (tx) => { await tx.user.delete({ where: { id: m.id } }); });
      console.log(`Undone: ${m.email} is deleted.`);
      return;
    }
    const existing = await prisma.user.findFirst({ where: { OR: [{ email: EMAIL }, { username: EMAIL }] }, select: { id: true, name: true, role: true } });
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    if (existing) { console.log(`Already there: ${existing.name} <${EMAIL}> (${existing.role}). Nothing to create.`); return; }
    console.log(`Would create: ${NAME} <${EMAIL}>  role ADMIN (HRMS, ATS, Accounts), NO employee record (not in the headcount), password new.`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
    const pw = process.env.TL_NEW_PASSWORD || '';
    if (pw.length < 8) { console.error('Set TL_NEW_PASSWORD (at least 8 characters) in the environment.'); process.exit(1); }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    let made = null;
    await prisma.$transaction(async (tx) => {
      made = await tx.user.create({
        data: {
          name: NAME,
          email: EMAIL,
          username: EMAIL,
          passwordHash: bcrypt.hashSync(pw, 10),
          passwordChangedAt: new Date(),
          passwordResetRequired: false,
          status: 'Active',
          role: 'ADMIN',
          hrmsRole: 'ADMIN',
          atsRole: 'ADMIN',
          accountsRole: 'ADMIN',
          hrmsAccess: true,
          atsAccess: true,
          accountsAccess: true,
          landingWorkspace: 'hrms',
          internalAccount: true,
        },
      });
      await tx.auditLog.create({ data: { action: 'Developer team login created (Admin, no employee record, not in headcount)', entity: 'DeveloperLogin', entityId: made.id, toValue: EMAIL, actorName: 'Founder request 2026-10-24' } });
    });
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = path.join(OUT, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), db: dbArg, id: made.id, email: made.email }, null, 1));
    console.log(`\nCREATED ${EMAIL}. Sign in with the password you set.\nBackup: ${bak}\nUndo:   node scripts/create-developer-login.js --undo "${manifest}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 500)); process.exit(1); });
