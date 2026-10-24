#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// A LOGIN FOR THE DEVELOPER TEAM (founder, 2026-10-24): "create one new Admin for the developer team only. It must not count in the
// headcount and its data must not show anywhere. Only the login is enough."
//
// FOUNDER 2026-10-24 (later the same day): "everything the Super Admin has must show on the developer's dashboard, pin to pin - consider the Super
// Admin and the developer as ONE person". So the login is a SUPER ADMIN (role, HRMS, ATS and Accounts roles), not an Admin; it sees and can do
// exactly what the Super Admin can. A login made earlier as ADMIN is raised with --make-super-admin (dry run first, same guards).
//   node scripts/create-developer-login.js --make-super-admin            DRY RUN: shows the change
//   TL_ALLOW_REAL_APPLY=1 node scripts/create-developer-login.js --make-super-admin --apply --really-real
//
// WHAT IT DOES: makes ONE new login (User row) with the SUPER_ADMIN role in HRMS, ATS and Accounts. It has NO employee record - that is what keeps
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
const RAISE = has('--make-super-admin');
const ROLE = 'SUPER_ADMIN';
const ROLE_FIELDS = ['role', 'hrmsRole', 'atsRole', 'accountsRole'];
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
    const existing = await prisma.user.findFirst({ where: { OR: [{ email: EMAIL }, { username: EMAIL }] }, select: { id: true, name: true, role: true, hrmsRole: true, atsRole: true, accountsRole: true, internalAccount: true } });
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    if (RAISE) {
      // Raise the existing developer login to Super Admin (the founder: "Super Admin and developer are one person").
      if (!existing) { console.log(`No login ${EMAIL} on this database: create it first (without --make-super-admin).`); return; }
      if (!existing.internalAccount) { console.error(`REFUSED: ${EMAIL} is not the developer-team login (internalAccount is off) - nothing changed.`); process.exit(2); }
      // The same first screen as the real Super Admin (the one with an employee record), so both land in the same place.
      const real = await prisma.user.findFirst({ where: { role: ROLE, status: 'Active', internalAccount: false, employee: { isNot: null } }, orderBy: { createdAt: 'asc' }, select: { landingWorkspace: true } });
      const landing = (real && real.landingWorkspace) || null;
      const cur = await prisma.user.findUnique({ where: { id: existing.id }, select: { landingWorkspace: true } });
      const before = { ...Object.fromEntries(ROLE_FIELDS.map((f) => [f, existing[f]])), landingWorkspace: cur.landingWorkspace };
      const sameLanding = !landing || cur.landingWorkspace === landing;
      if (ROLE_FIELDS.every((f) => existing[f] === ROLE) && sameLanding) { console.log(`Already a Super Admin: ${existing.name} <${EMAIL}>. Nothing to change.`); return; }
      console.log(`Would change ${existing.name} <${EMAIL}>: ${ROLE_FIELDS.map((f) => `${f} ${before[f]} -> ${ROLE}`).join(', ')}${sameLanding ? '' : `, first screen ${cur.landingWorkspace} -> ${landing} (as the Super Admin)`}. Password, employee record (none) and everything else stay as they are.`);
      if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bak = path.join(BACKUP_DIR, 'before.db');
      await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: existing.id }, data: { ...Object.fromEntries(ROLE_FIELDS.map((f) => [f, ROLE])), ...(sameLanding ? {} : { landingWorkspace: landing }) } });
        await tx.auditLog.create({ data: { action: 'Developer team login raised to Super Admin (founder: Super Admin and developer are one person)', entity: 'DeveloperLogin', entityId: existing.id, fromValue: JSON.stringify(before), toValue: ROLE, actorName: 'Founder request 2026-10-24' } });
      });
      fs.mkdirSync(OUT, { recursive: true });
      const manifest = path.join(OUT, 'undo-raise-manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), db: dbArg, id: existing.id, email: EMAIL, before }, null, 1));
      console.log(`\nDONE: ${EMAIL} is now a Super Admin. Sign out and in again to see everything.\nBackup: ${bak}\nTo put the old roles back: restore them from ${manifest}`);
      return;
    }
    if (existing) { console.log(`Already there: ${existing.name} <${EMAIL}> (${existing.role}). Nothing to create.${existing.role !== ROLE ? ' To make it a Super Admin use --make-super-admin.' : ''}`); return; }
    console.log(`Would create: ${NAME} <${EMAIL}>  role SUPER_ADMIN (HRMS, ATS, Accounts), NO employee record (not in the headcount), password new.`);
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
          role: ROLE,
          hrmsRole: ROLE,
          atsRole: ROLE,
          accountsRole: ROLE,
          hrmsAccess: true,
          atsAccess: true,
          accountsAccess: true,
          landingWorkspace: 'hrms',
          internalAccount: true,
        },
      });
      await tx.auditLog.create({ data: { action: 'Developer team login created (Super Admin, no employee record, not in headcount)', entity: 'DeveloperLogin', entityId: made.id, toValue: EMAIL, actorName: 'Founder request 2026-10-24' } });
    });
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = path.join(OUT, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), db: dbArg, id: made.id, email: made.email }, null, 1));
    console.log(`\nCREATED ${EMAIL}. Sign in with the password you set.\nBackup: ${bak}\nUndo:   node scripts/create-developer-login.js --undo "${manifest}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 500)); process.exit(1); });
