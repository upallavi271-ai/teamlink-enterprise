#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// INTERNAL HR v2  (founder, 2026-10-14)
//   "PurnaChandra Sekhar (TL309) and T Divya Sri Sivatmika will work as INTERNAL HR:
//    Purna = TL for Internal HR, Divya = HR. Both have ALL access like a Super Admin,
//    but every DELETE / EXPORT / IMPORT is reported to the Super Admins."
//
//   node scripts/set-internal-hr-v2.js                    DRY RUN: writes NOTHING, prints exactly what would change
//   node scripts/set-internal-hr-v2.js --apply            backup first, then write in one transaction + undo manifest
//   node scripts/set-internal-hr-v2.js --undo <file>      put every changed row back
//   --db <sqlite file>   another database (a COPY of the real one / the sandbox). Default: .env DATABASE_URL.
//
// WHAT IT DOES (nothing is hard-coded in the app: the app reads the AppSetting list, see utils/hrSuper.js)
//   1. finds the two people: employee id TL309, and the employee whose name has "Divya" AND "Sivatmika".
//      If either is not EXACTLY one match it STOPS and lists the candidates.
//   2. creates the department "Internal HR" if it is missing (the "floor HR" department: the app has no separate
//      floor flag; the name + the IHR seat code are what mark it)
//   3. seats: TL309 -> IHR-TL (kind TL), Divya -> IHR-1; their old open seat is ended today (the seat code's
//      first word decides the department: IHR = Internal HR)
//   4. Employee.department = Internal HR and User.atsDepartment = Internal HR for both (roles are KEPT: TL309 stays
//      TL, Divya becomes HR in HRMS); a person with no login yet is reported "needs login first": no password is ever made here
//   5. creates the Role Catalog role "Internal HR" if missing, and writes the AppSetting 'hr-super-access' list
//   6. writes the AppSetting 'hr-watch' (utils/hrWatch.js): every action by Divya notifies her team lead Purna (idempotent; the
//      old value is kept in the undo manifest and put back by --undo)
//
// COMMANDS FOR THE FOUNDER (his own PowerShell, from the backend folder; the dry run changes nothing):
//   cd C:\Users\user\Desktop\All_Projects\teamlink-enterprise\backend
//   node scripts/set-internal-hr-v2.js
//   $env:TL_ALLOW_REAL_APPLY = "1"
//   node scripts/set-internal-hr-v2.js --apply --really-real
//   (to put everything back:  node scripts/set-internal-hr-v2.js --undo "<manifest file it printed>" --really-real   with TL_ALLOW_REAL_APPLY=1 set)
// SAFETY: --apply on the REAL database needs BOTH --really-real AND TL_ALLOW_REAL_APPLY=1. Backup first, one
// transaction, undo manifest next to the backup. Test rows are never touched.
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
const hrSuper = require('../src/utils/hrSuper');
const hrWatch = require('../src/utils/hrWatch');

const HR_WATCH_KEY = hrWatch.SETTINGS_KEY; // 'hr-watch'
const shortName = (n) => hrWatch.firstNameOf(n);

const DEPT = 'Internal HR';
const TEST_ROW = /zztest|example\.test/i;
const todayIso = () => new Date().toISOString().slice(0, 10);
const mask = (s) => (s ? String(s).replace(/^(.).*@/, '$1***@') : null);

const PEOPLE = [
  { key: 'purna', label: 'PurnaChandra Sekhar (TL309)', find: async () => prisma.employee.findMany({ where: { employeeCode: 'TL309' } }), seat: { code: 'IHR-TL', name: 'Internal HR TL', kind: 'TL' }, hrmsRole: null },
  {
    key: 'divya',
    label: 'T Divya Sri Sivatmika',
    find: async () => (await prisma.employee.findMany({ where: { name: { contains: 'Divya' } } })).filter((e) => /sivatmika/i.test(e.name) && !TEST_ROW.test(`${e.name} ${e.email}`)),
    seat: { code: 'IHR-1', name: 'Internal HR 1', kind: 'OTHER' },
    hrmsRole: 'HR',
  },
];

async function plan() {
  const out = { people: [], stop: null, actions: [] };
  for (const p of PEOPLE) {
    // eslint-disable-next-line no-await-in-loop
    const found = await p.find();
    if (found.length !== 1) {
      out.stop = `${p.label}: expected exactly 1 employee, found ${found.length}. Candidates: ${found.map((e) => `${e.employeeCode} ${e.name} (${e.department || '-'}, ${e.employmentStatus})`).join('; ') || 'none'}`;
      return out;
    }
    const e = found[0];
    // eslint-disable-next-line no-await-in-loop
    const user = e.userId ? await prisma.user.findUnique({ where: { id: e.userId } }) : null;
    // eslint-disable-next-line no-await-in-loop
    const open = await prisma.positionAssignment.findMany({ where: { employeeId: e.id, toDate: null }, include: { position: true } });
    // eslint-disable-next-line no-await-in-loop
    const seat = await prisma.position.findUnique({ where: { code: p.seat.code } });
    out.people.push({ p, e, user, open, seat });
  }
  const dept = await prisma.department.findUnique({ where: { name: DEPT } });
  if (!dept) out.actions.push({ type: 'dept', text: `CREATE department "${DEPT}" (floor HR)` });
  const roleRow = await require('../src/utils/roleRegistry').roleByCode(hrSuper.ROLE_CODE);
  if (!roleRow) out.actions.push({ type: 'role', text: `CREATE Role Catalog role "${hrSuper.ROLE_NAME}" (${hrSuper.ROLE_CODE}, company-wide)` });
  const cfg = await hrSuper.settings();
  for (const { p, e, user, open, seat } of out.people) {
    const who = `${e.name} (${e.employeeCode})`;
    if (!seat) out.actions.push({ type: 'seat-new', text: `CREATE seat ${p.seat.code} (${p.seat.name}, department ${DEPT}, kind ${p.seat.kind})`, p });
    const holding = open.find((a) => a.position.code === p.seat.code);
    for (const a of open.filter((x) => x !== holding)) out.actions.push({ type: 'seat-end', text: `END ${who}'s open seat ${a.position.code} today`, a });
    if (!holding) out.actions.push({ type: 'seat-give', text: `GIVE ${who} the seat ${p.seat.code} from today`, p, e });
    if (e.department !== DEPT) out.actions.push({ type: 'emp-dept', text: `SET ${who} department "${e.department || '-'}" -> "${DEPT}"`, e });
    if (!user) {
      out.actions.push({ type: 'needs-login', text: `${who}: NEEDS A LOGIN FIRST (Employee Management > Create login); not added to the Internal HR list yet` });
    } else {
      if (user.atsDepartment !== DEPT) out.actions.push({ type: 'user-dept', text: `SET ${who} login atsDepartment "${user.atsDepartment || '-'}" -> "${DEPT}"`, user });
      if (p.hrmsRole && user.hrmsRole !== p.hrmsRole) out.actions.push({ type: 'user-role', text: `SET ${who} HRMS role "${user.hrmsRole || '-'}" -> "${p.hrmsRole}" (other roles kept: role ${user.role}, ATS ${user.atsRole || '-'})`, user, p });
      if (!cfg.users.some((x) => x.id === user.id)) out.actions.push({ type: 'list', text: `ADD ${who} to the AppSetting list "${hrSuper.SETTINGS_KEY}" (Internal HR access)`, user, e });
    }
  }
  // HR WATCH (founder, 2026-10-16): every action by Divya notifies her team lead Purna (AppSetting 'hr-watch', utils/hrWatch.js)
  const divya = out.people.find((x) => x.p.key === 'divya');
  const purna = out.people.find((x) => x.p.key === 'purna');
  if (divya && purna) {
    const wrow = await prisma.appSetting.findUnique({ where: { key: HR_WATCH_KEY } });
    let cur = [];
    try { cur = wrow ? hrWatch.clean(JSON.parse(wrow.value)) : []; } catch { cur = []; }
    const mine = cur.find((x) => x.actorEmployeeCode.toUpperCase() === String(divya.e.employeeCode).toUpperCase());
    const ok = mine && mine.notifyEmployeeCodes.map((c) => c.toUpperCase()).includes(String(purna.e.employeeCode).toUpperCase());
    if (!ok) {
      out.actions.push({
        type: 'watch',
        text: `WOULD ADD: every action by ${shortName(divya.e.name)} (${divya.e.employeeCode}) will notify ${shortName(purna.e.name)} (${purna.e.employeeCode}) - AppSetting "${HR_WATCH_KEY}" (bell notification, repeated identical actions within 2 minutes become one line with a count)`,
        actor: divya.e.employeeCode, notify: purna.e.employeeCode, cur,
      });
    }
  }
  return out;
}

function show(pl) {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (pl.stop) { console.log(`\nSTOP: ${pl.stop}`); return; }
  console.log('\nPEOPLE FOUND');
  pl.people.forEach(({ e, user, open }) => console.log(`  - ${e.name} (${e.employeeCode}) dept "${e.department || '-'}" status ${e.employmentStatus} designation "${e.designation || '-'}" | login: ${user ? `yes (${user.status}, role ${user.role}, HRMS ${user.hrmsRole || '-'}, ATS ${user.atsRole || '-'}, ${mask(user.email)})` : 'NONE'} | seats: ${open.map((a) => a.position.code).join(', ') || 'none'}`));
  console.log('\nWOULD CHANGE (exactly these rows)');
  if (!pl.actions.length) console.log('  nothing: already set.');
  pl.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a.text}`));
}

async function apply(pl) {
  guardReal('--apply');
  if (pl.stop) throw new Error(pl.stop);
  const backup = require('../src/utils/backup'); // eslint-disable-line global-require
  const b = await backup.makeBackup({ reason: 'before Internal HR v2', by: 'set-internal-hr-v2.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, deptCreated: null, positionsCreated: [], assignmentsCreated: [], assignmentsEnded: [], employee: [], user: [], setting: null, roleCreated: false };
  const t = todayIso();
  // the role first (own writes, outside the transaction)
  if (pl.actions.some((a) => a.type === 'role')) { const r = await hrSuper.ensureRole(null); undo.roleCreated = !!r.created; }
  const prev = await prisma.appSetting.findUnique({ where: { key: hrSuper.SETTINGS_KEY } });
  undo.setting = { existed: !!prev, value: prev ? prev.value : null };
  const prevWatch = await prisma.appSetting.findUnique({ where: { key: HR_WATCH_KEY } });
  undo.watch = { existed: !!prevWatch, value: prevWatch ? prevWatch.value : null };
  await prisma.$transaction(async (tx) => {
    if (pl.actions.some((a) => a.type === 'dept')) { const d = await tx.department.create({ data: { name: DEPT } }); undo.deptCreated = d.id; }
    for (const a of pl.actions) {
      if (a.type === 'seat-new') { const pos = await tx.position.create({ data: { code: a.p.seat.code, name: a.p.seat.name, department: DEPT, kind: a.p.seat.kind } }); undo.positionsCreated.push(pos.id); }
      if (a.type === 'seat-end') {
        await tx.positionAssignment.update({ where: { id: a.a.id }, data: { toDate: t, note: `Moved to Internal HR seat (${a.a.note || ''})`.slice(0, 500) } });
        undo.assignmentsEnded.push({ id: a.a.id, note: a.a.note || null });
      }
    }
    for (const a of pl.actions.filter((x) => x.type === 'seat-give')) {
      const pos = await tx.position.findUnique({ where: { code: a.p.seat.code } });
      const row = await tx.positionAssignment.create({ data: { positionId: pos.id, employeeId: a.e.id, fromDate: t, note: 'Internal HR (founder decision 2026-10-14)' } });
      undo.assignmentsCreated.push(row.id);
    }
    for (const a of pl.actions.filter((x) => x.type === 'emp-dept')) {
      await tx.employee.update({ where: { id: a.e.id }, data: { department: DEPT } });
      undo.employee.push({ id: a.e.id, department: a.e.department });
    }
    for (const a of pl.actions.filter((x) => x.type === 'user-dept' || x.type === 'user-role')) {
      const data = a.type === 'user-dept' ? { atsDepartment: DEPT } : { hrmsRole: a.p.hrmsRole };
      await tx.user.update({ where: { id: a.user.id }, data });
      undo.user.push({ id: a.user.id, field: a.type === 'user-dept' ? 'atsDepartment' : 'hrmsRole', value: a.type === 'user-dept' ? a.user.atsDepartment : a.user.hrmsRole });
    }
    const adds = pl.actions.filter((x) => x.type === 'list');
    if (adds.length) {
      const cfg = await hrSuper.settings();
      const next = { ...cfg, users: [...cfg.users, ...adds.map((a) => ({ id: a.user.id, name: a.user.name, employeeCode: a.e.employeeCode, addedAt: new Date().toISOString(), addedBy: 'set-internal-hr-v2.js' }))] };
      const value = JSON.stringify(hrSuper.clean(next));
      await tx.appSetting.upsert({ where: { key: hrSuper.SETTINGS_KEY }, create: { key: hrSuper.SETTINGS_KEY, value, updatedByName: 'set-internal-hr-v2.js' }, update: { value, updatedByName: 'set-internal-hr-v2.js' } });
    }
    const wa = pl.actions.find((x) => x.type === 'watch');
    if (wa) {
      const others = wa.cur.filter((x) => x.actorEmployeeCode.toUpperCase() !== wa.actor.toUpperCase());
      const old = wa.cur.find((x) => x.actorEmployeeCode.toUpperCase() === wa.actor.toUpperCase());
      const codes = [...new Set([...(old ? old.notifyEmployeeCodes : []), wa.notify])];
      const value = JSON.stringify([...others, { actorEmployeeCode: wa.actor, notifyEmployeeCodes: codes, includeSuperAdmins: old ? old.includeSuperAdmins : false }]);
      await tx.appSetting.upsert({ where: { key: HR_WATCH_KEY }, create: { key: HR_WATCH_KEY, value, updatedByName: 'set-internal-hr-v2.js' }, update: { value, updatedByName: 'set-internal-hr-v2.js' } });
    }
    await tx.auditLog.create({ data: { action: 'Internal HR v2 set up', entity: 'Setting', entityId: hrSuper.SETTINGS_KEY, toValue: pl.actions.map((a) => a.text).join(' | ').slice(0, 1500), actorName: 'System (set-internal-hr-v2.js)' } });
  }, { timeout: 120000, maxWait: 30000 });
  hrSuper.invalidate();
  hrWatch.invalidate();
  const file =path.join(backup.backupRoot(), `internal-hr-v2-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Done. Undo manifest: ${file}`);
  console.log(`To put everything back:  node scripts/set-internal-hr-v2.js --undo "${file}"${isRealDb() ? ' --really-real  (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function undoRun(file) {
  guardReal('--undo');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  await prisma.$transaction(async (tx) => {
    for (const id of u.assignmentsCreated) await tx.positionAssignment.deleteMany({ where: { id } });
    for (const r of u.assignmentsEnded) await tx.positionAssignment.update({ where: { id: r.id }, data: { toDate: null, note: r.note } }).catch(() => null);
    for (const id of u.positionsCreated) await tx.position.deleteMany({ where: { id } });
    for (const r of u.employee) await tx.employee.update({ where: { id: r.id }, data: { department: r.department } });
    for (const r of u.user) await tx.user.update({ where: { id: r.id }, data: { [r.field]: r.value } });
    if (u.setting) {
      if (u.setting.existed) await tx.appSetting.update({ where: { key: hrSuper.SETTINGS_KEY }, data: { value: u.setting.value } });
      else await tx.appSetting.deleteMany({ where: { key: hrSuper.SETTINGS_KEY } });
    }
    if (u.watch) {
      if (u.watch.existed) await tx.appSetting.update({ where: { key: HR_WATCH_KEY }, data: { value: u.watch.value } });
      else await tx.appSetting.deleteMany({ where: { key: HR_WATCH_KEY } });
    }
    if (u.deptCreated) await tx.department.deleteMany({ where: { id: u.deptCreated } });
    if (u.roleCreated) {
      await tx.roleAccess.deleteMany({ where: { role: hrSuper.ROLE_CODE } });
      await tx.$executeRawUnsafe('DELETE FROM "Role" WHERE "code" = ?', hrSuper.ROLE_CODE);
    }
    await tx.auditLog.create({ data: { action: 'Internal HR v2 undone', entity: 'Setting', entityId: hrSuper.SETTINGS_KEY, actorName: 'System (set-internal-hr-v2.js)' } });
  }, { timeout: 120000, maxWait: 30000 });
  hrSuper.invalidate();
  hrWatch.invalidate();
  console.log('Undone.');
}

(async () => {
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const pl = await plan();
  show(pl);
  if (has('--apply')) await apply(pl);
  else console.log('\nDRY RUN - nothing was written. Add --apply to do it (backup + undo manifest are made first).');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
