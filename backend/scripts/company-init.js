#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CREATE A SEPARATE COMPANY (a brand-new, EMPTY copy of the application's data) - docs/second-company.md
//
//   DATABASE_URL="file:./nish.db" node scripts/company-init.js \
//       --key nish --name "NISHTECHNOLOGIES INDIA PVT LTD" \
//       --admin-name "Full Name" --admin-email "name@company.com" [--link-hours 48] [--link-file <path>] [--app-url https://...]
//
//   DATABASE_URL="file:./nish.db" node scripts/company-init.js --key nish --admin-email "name@company.com" --new-link
//       (a fresh one-time "choose your password" link for the Super Admin of an EXISTING company; changes nothing else)
//
// WHAT IT DOES (in this order)
//   1. Applies every database migration to the (new) database file, so it has exactly the same tables as TeamLink's.
//   2. Removes the few rows a migration puts there that are TeamLink's own business (the Medical monthly joining targets).
//      What is left is generic: the chart of accounts, expense categories, portal field mappings, app categories, the HR role.
//   3. Creates the company row (name), ONE Super Admin login + employee record, and the row AppSetting 'company.key' that
//      utils/companyGuard.js checks, so this database can only be opened by this company's server.
//   4. Gives the Super Admin NO password anyone knows: a random one nobody sees, plus a ONE-TIME "choose your password" link.
//      The link is written to a private file (mode 600, outside the project) - this script prints the file's path, never the link.
//
// WHAT IT REFUSES TO DO
//   * run on a database that already has a login (it only creates a NEW company; it can never add to or change TeamLink's);
//   * run on a file called dev.db (the name of TeamLink's real database) or anything under /opt/teamlink-enterprise.
//   --skip-migrate: the migrations were already applied (tests). --strict: exit 3 when a table holds rows this script did not expect.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };

// Tables that legitimately hold rows in a brand-new company: what the migrations install for everybody, plus what this script writes.
// A table NOT on this list holding rows after step 2 means a newer migration added business data of TeamLink's: --strict stops.
const GENERIC_DEFAULTS = ['DesignationRole', 'ExpenseCategory', 'LedgerAccount', 'StationeryItem', 'PortalMapping', 'app_categories'];
const WRITTEN_HERE = ['Company', 'User', 'Employee', 'AppSetting'];
// Rows put there by migrations that belong to TeamLink's own business, not to every company.
const TEAMLINK_OWN_SEEDS = ['JoiningCategoryTarget'];

function fail(msg, code = 2) { console.error(`[company-init] ${msg}`); process.exit(code); }

function dbFile() {
  const url = String(process.env.DATABASE_URL || '');
  if (!/^file:/i.test(url)) fail('DATABASE_URL must be set to a SQLite file, for example  DATABASE_URL="file:./nish.db"');
  const raw = decodeURIComponent(url.replace(/^file:/i, '').split('?')[0]);
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? path.normalize(raw) : path.resolve(BACKEND, 'prisma', raw); // Prisma: relative to prisma/schema.prisma
}

function refuseTeamLinkFiles(file) {
  const norm = file.replace(/\\/g, '/').toLowerCase();
  if (path.basename(norm) === 'dev.db' || /\/opt\/teamlink-enterprise(\/|$)/.test(norm)) {
    fail(`refusing ${file}: "dev.db" / the TeamLink folder is TeamLink's own live database. Use a different file, for example prisma/nish.db in the NEW company's own folder.`);
  }
}

function migrate() {
  const cli = path.join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(cli)) fail('Prisma is not installed here (run npm ci in backend first).');
  console.log('[company-init] applying the database migrations (about half a minute) ...');
  const r = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: BACKEND, env: process.env, encoding: 'utf8' });
  if (r.status !== 0) fail(`prisma migrate deploy failed:\n${(r.stdout || '').slice(-1500)}\n${(r.stderr || '').slice(-1500)}`);
  console.log('[company-init] migrations applied.');
}

async function nonEmptyTables(prisma) {
  const tables = await prisma.$queryRawUnsafe("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '_prisma_migrations'");
  const out = [];
  for (const t of tables) {
    // eslint-disable-next-line no-await-in-loop
    const c = await prisma.$queryRawUnsafe(`select count(*) as c from "${String(t.name).replace(/"/g, '')}"`);
    if (Number(c[0].c) > 0) out.push({ table: t.name, rows: Number(c[0].c) });
  }
  return out;
}

function writeLinkFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

async function issueLink({ prisma, user, key, hours, file, name }) {
  const PR = require('../src/utils/passwordReset'); // eslint-disable-line global-require
  const t = await PR.issueToken(user, { via: 'admin', byName: `${name} setup`, ttlMin: Math.round(hours * 60) });
  const link = PR.linkFor(t.token);
  const text = [
    `One-time link for the Super Admin of ${name} (company key: ${key}).`,
    'Open it in a browser and choose your own password. It works once and then stops working.',
    `It expires: ${t.expiresAt.toISOString()}`,
    '',
    link,
    '',
    'Delete this file after the password is chosen.',
    '',
  ].join('\n');
  writeLinkFile(file, text);
  return { expiresAt: t.expiresAt };
}

async function main() {
  const key = String(val('--key') || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(key)) fail('--key is required: a short lower-case name for the company, for example  --key nish');
  const file = dbFile();
  refuseTeamLinkFiles(file);
  if (val('--app-url')) process.env.APP_BASE_URL = val('--app-url');
  const hours = Math.min(24 * 14, Math.max(0.25, Number(val('--link-hours')) || 48));
  const linkFile = path.resolve(val('--link-file') || path.join(os.homedir(), '.company-first-login', `${key}.txt`));
  const adminEmail = String(val('--admin-email') || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(adminEmail)) fail('--admin-email is required (the Super Admin\'s sign-in email).');

  if (has('--new-link')) {
    if (!fs.existsSync(file)) fail(`${file} does not exist: nothing to issue a link for.`);
  } else {
    if (!String(val('--name') || '').trim()) fail('--name is required, for example  --name "NISHTECHNOLOGIES INDIA PVT LTD"');
    if (!String(val('--admin-name') || '').trim()) fail('--admin-name is required (the Super Admin\'s full name).');
    if (!has('--skip-migrate')) migrate();
  }

  const prisma = require('../src/db'); // eslint-disable-line global-require
  const companyKey = require('../src/utils/companyGuard'); // eslint-disable-line global-require

  if (has('--new-link')) {
    const row = await prisma.appSetting.findUnique({ where: { key: companyKey.KEY_ROW } });
    const found = row ? String((JSON.parse(row.value) || {}).key || '') : '';
    if (found !== key) fail(`this database belongs to company "${found || '(none)'}", not "${key}". Nothing changed.`);
    const user = await prisma.user.findFirst({ where: { email: adminEmail, role: 'SUPER_ADMIN' } });
    if (!user) fail(`no Super Admin with that email in company "${key}". Nothing changed.`);
    const co = await prisma.company.findFirst();
    const out = await issueLink({ prisma, user, key, hours, file: linkFile, name: (co && co.name) || key });
    console.log(`[company-init] a fresh one-time link was written to ${linkFile} (expires ${out.expiresAt.toISOString()}). The older link no longer works.`);
    await prisma.$disconnect();
    return;
  }

  const users = await prisma.user.count();
  if (users > 0) fail(`this database already has ${users} login(s). This script only creates a NEW, empty company; it will not touch an existing one. Nothing changed.`);

  const name = String(val('--name')).trim();
  const adminName = String(val('--admin-name')).trim();

  // 2. TeamLink's own business rows that migrations carry
  for (const model of TEAMLINK_OWN_SEEDS) {
    const m = model.charAt(0).toLowerCase() + model.slice(1);
    // eslint-disable-next-line no-await-in-loop
    const r = await prisma[m].deleteMany({});
    if (r.count) console.log(`[company-init] removed ${r.count} TeamLink-only ${model} row(s).`);
  }

  // 3. the company, its Super Admin, and the row that ties this database to this company
  const bcrypt = require('bcryptjs'); // eslint-disable-line global-require
  const unknownPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10); // nobody ever sees or needs this
  await prisma.company.create({ data: { name, legalName: name } });
  const user = await prisma.user.create({
    data: {
      name: adminName, email: adminEmail, username: adminEmail, passwordHash: unknownPassword,
      role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN',
      hrmsAccess: true, atsAccess: true, accountsAccess: true, status: 'Active',
    },
  });
  await prisma.employee.create({
    data: {
      userId: user.id, employeeCode: 'EMP-0001', name: adminName, email: adminEmail, designation: 'Super Admin',
      dateOfJoining: new Date(), employmentStatus: 'Active', employeeType: 'Full-time', profileStage: 'Locked', isLocked: true,
    },
  });
  await prisma.appSetting.create({ data: { key: companyKey.KEY_ROW, value: JSON.stringify({ key, name, createdAt: new Date().toISOString() }) } });

  // 4. the one-time link
  const out = await issueLink({ prisma, user, key, hours, file: linkFile, name });

  // what is in the database now
  const rows = await nonEmptyTables(prisma);
  const expected = new Set([...GENERIC_DEFAULTS, ...WRITTEN_HERE]);
  const unexpected = rows.filter((r) => !expected.has(r.table));
  console.log(`[company-init] company "${name}" (key ${key}) created in ${file}`);
  console.log(`[company-init] Super Admin: ${adminName} <${adminEmail}>   one-time password link written to: ${linkFile}   (expires ${out.expiresAt.toISOString()})`);
  console.log(`[company-init] tables that hold rows: ${rows.map((r) => `${r.table}:${r.rows}`).join('  ')}`);
  if (unexpected.length) {
    console.error(`[company-init] WARNING: these tables hold rows this script did not expect (a newer migration may carry TeamLink data): ${unexpected.map((r) => `${r.table}:${r.rows}`).join(', ')}`);
    if (has('--strict')) { await prisma.$disconnect(); process.exit(3); }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[company-init] failed:', e && e.message ? e.message : e); process.exit(1); });
