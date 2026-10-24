#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
// ---------------------------------------------------------------------------
// REJOIN ONE EMPLOYEE FROM THE COMMAND LINE (founder, 2026-10-15: TL424, M Niveditha, rejoined 5 Oct 2026 but shown
// Relieved). Does exactly what Employee Management > "Rejoin" does (utils/rejoin.js, ONE shared implementation), without the UI.
// Same ID, whole history kept, nothing deleted. Read the header of src/utils/rejoin.js for every row it writes.
//
//   node scripts/rejoin-employee.js --code TL424 --date 2026-10-05 --department Manufacturing
//        [--seat MFG-1] [--designation "Recruiter"] [--tl TL451] [--stl <employeeCode>] [--team <name>]
//        [--role <ROLE_CODE>] [--type "Full Time"] [--location Hyderabad] [--remarks "text"]
//        [--previous-last-day <YYYY-MM-DD>]   (only when the exit record has no / a wrong last working day: it moves the 'not absent' gap)
//
// MODES (default = DRY RUN)
//   (none)            DRY RUN: VACUUM INTO a temp COPY of the database, runs the whole rejoin on the copy and prints what
//                     changed (rows per table, before/after of the employee, the login, the seat, the exit record). The target
//                     database is never written. If --seat is not given the seat is left empty: "seat to be assigned".
//   --apply           backup first (VACUUM INTO ~/.teamlink-backups/rejoin-<code>-<stamp>/), then ONE transaction on the target,
//                     and an undo manifest (manifest.json) next to the backup.
//   --undo <manifest> exact reverse of one --apply (refused when attendance / leave / payslips were recorded since the rejoining
//                     date, unless --force; undo an attendance load FIRST).
//   --db <file>       the database (default backend/prisma/dev.db). --backup-dir <dir>. --help
//   The real dev.db is refused for --apply / --undo unless  --really-real  AND the environment variable TL_ALLOW_REAL_APPLY=1.
//
// The person is acted on as "Script (rejoin-employee)" with Super Admin rights; audit rows and the Super Admin bell + task say so.
// AFTER the rejoin is applied, load her punches with (a separate, already tested script):
//   TL_ALLOW_REAL_APPLY=1 node scripts/load-attendance-13-15oct.js --apply --force-rerun --really-real
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const REAL_DB = path.join(BACKEND, 'prisma', 'dev.db');

function snapshot(src, dest) {
  const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
  for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(dest + s); } catch { /* none */ } }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let db;
  try { db = new DatabaseSync(src, { readOnly: true }); } catch { db = new DatabaseSync(src); }
  try { db.exec('PRAGMA busy_timeout=20000'); db.exec(`VACUUM INTO '${dest.split(path.sep).join('/').replace(/'/g, "''")}'`); } finally { db.close(); }
  const c = new DatabaseSync(dest, { readOnly: true });
  const q = String(Object.values(c.prepare('PRAGMA quick_check').get())[0]);
  c.close();
  if (q !== 'ok') throw new Error(`snapshot failed its integrity check: ${q}`);
}

const readDb = (file) => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file, { readOnly: true }); }; // eslint-disable-line global-require
function tableCounts(file) {
  const db = readDb(file);
  try {
    const names = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '\\_%' escape '\\'").all().map((r) => r.name);
    const out = {};
    for (const n of names) out[n] = Number(db.prepare(`select count(*) c from "${n}"`).get().c);
    return out;
  } finally { db.close(); }
}
const rowOf = (file, table, id) => { const db = readDb(file); try { return db.prepare(`select * from "${table}" where id=?`).get(id) || null; } finally { db.close(); } };
const diffRow = (a, b) => {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    const x = a ? a[k] : undefined; const y = b ? b[k] : undefined;
    if (String(x == null ? '' : x) !== String(y == null ? '' : y)) out.push({ field: k, from: x == null ? '' : (typeof x === 'string' && x.length > 90 ? `${x.slice(0, 90)}...` : x), to: y == null ? '' : (typeof y === 'string' && y.length > 90 ? `${y.slice(0, 90)}...` : y) });
  }
  return out;
};
const showDate = (k, v) => (['dateOfJoining', 'createdAt', 'updatedAt', 'lockedUntil'].includes(k) && typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : v);

async function main(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  const MODE = flag('--undo') ? 'undo' : flag('--apply') ? 'apply' : 'dry';
  const DB_ARG = path.resolve(opt('--db', REAL_DB));
  const isReal = (p) => path.resolve(p).toLowerCase() === REAL_DB.toLowerCase();
  const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const CODE = String(opt('--code', '') || '').trim();
  if ((MODE === 'apply' || MODE === 'undo') && isReal(DB_ARG) && (!flag('--really-real') || process.env.TL_ALLOW_REAL_APPLY !== '1')) {
    console.error(`REFUSED: ${MODE} on the real dev.db needs  --really-real  AND the environment variable TL_ALLOW_REAL_APPLY=1.`);
    return 2;
  }
  if (!fs.existsSync(DB_ARG)) throw new Error(`database not found: ${DB_ARG}`);
  if (MODE !== 'undo' && !CODE) throw new Error('--code <employeeCode> is required (for example --code TL424)');
  if (MODE !== 'undo' && !opt('--date')) throw new Error('--date <YYYY-MM-DD> is required (the rejoining date)');
  const BACKUP_DIR = path.resolve(opt('--backup-dir', path.join(os.homedir(), '.teamlink-backups', `rejoin-${CODE || 'undo'}-${STAMP}`)));

  let WORK_DB = DB_ARG; let TEMP_DB = null;
  if (MODE === 'dry') { TEMP_DB = path.join(os.tmpdir(), `tl-rejoin-${STAMP}-${process.pid}.db`); snapshot(DB_ARG, TEMP_DB); WORK_DB = TEMP_DB; }
  process.env.DATABASE_URL = `file:${WORK_DB.split(path.sep).join('/')}?connection_limit=1&socket_timeout=300`;
  process.env.TEST_MODE = process.env.TEST_MODE || '1'; // no workers, no mail, from this process
  const prisma = require('../src/db'); // eslint-disable-line global-require
  const R = require('../src/utils/rejoin'); // eslint-disable-line global-require
  const actor = { id: null, name: 'Script (rejoin-employee)', email: 'script@rejoin-employee', role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN' };
  let code = 0;
  try {
    if (MODE === 'undo') {
      const mp = path.resolve(opt('--undo'));
      const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (man.db && path.resolve(man.db).toLowerCase() !== WORK_DB.toLowerCase()) throw new Error(`this manifest belongs to ${man.db}, not ${WORK_DB}`);
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before-undo.db'); snapshot(WORK_DB, bk); console.log(`backup before undo: ${bk}`);
      const out = await R.undo({ recordId: man.recordId, actor, force: flag('--force') });
      console.log(`UNDO done: the status is back to ${out.restoredStatus}; the seat made by the rejoin was removed; the rejoin record is marked Undone.`);
      return 0;
    }
    const employee = await prisma.employee.findFirst({ where: { employeeCode: CODE } });
    if (!employee) throw new Error(`no employee with code ${CODE}`);
    const user = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId } }) : null;
    const seatsNow = await prisma.positionAssignment.findMany({ where: { employeeId: employee.id }, orderBy: { fromDate: 'asc' }, include: { position: { select: { code: true, department: true } } } });
    console.log(`\n=== ${MODE === 'dry' ? 'DRY RUN (on a copy; nothing is written to the target)' : 'APPLY'}: rejoin ${employee.name} (${employee.employeeCode}) ===`);
    console.log('\nCURRENT RECORD');
    console.log(`  status ${employee.employmentStatus} | department ${employee.department || '-'} | designation ${employee.designation || '-'} | team ${employee.team || '-'} | TL ${employee.tl || '-'} | STL ${employee.stl || '-'} | location ${employee.location || '-'} | type ${employee.employeeType || '-'}`);
    console.log(`  first joined ${employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : '-'} (kept as it is)`);
    console.log(`  login: ${user ? `${user.email} | status ${user.status} | role ${user.role} | department ${user.atsDepartment || '-'} | locked until ${user.lockedUntil ? new Date(user.lockedUntil).toISOString() : 'no'}` : 'NONE (no User row is linked): she needs a login made after the rejoin'}`);
    console.log(`  seat tenures: ${seatsNow.length ? seatsNow.map((s) => `${s.position.code} ${s.fromDate} -> ${s.toDate || 'open'}`).join('; ') : 'none'}`);
    const stint = await R.previousStint(employee);
    console.log(`  earlier stint ended: ${stint.lastDay || 'not known'} (${stint.source || '-'})`);
    const deptWanted = opt('--department') || employee.department;
    const seatsOfDept = await R.seatsOf(deptWanted);
    console.log(`\nSEATS OF ${deptWanted}`);
    seatsOfDept.forEach((s) => console.log(`  ${s.code}${s.name ? ` (${s.name})` : ''}: ${s.vacant ? `VACANT${s.formerHolder ? ` (former holder ${s.formerHolder}: released when this seat is taken)` : ''}` : `held by ${s.holder}${s.onNotice ? ' (on notice)' : ''}`}`));
    const leads = (await require('../src/utils/reportingLine').candidatesFor({ department: deptWanted, level: 'STAFF', excludeId: employee.id, cross: true })).options; // eslint-disable-line global-require
    console.log(`\nWHO COULD BE HER TL / STL IN ${deptWanted}: ${leads.map((l) => `${l.name} (${l.role})`).join(', ') || 'nobody'}`);

    const byCode = async (c) => { if (!c) return null; const e = await prisma.employee.findFirst({ where: { employeeCode: String(c).trim() } }); if (!e) throw new Error(`no employee with code ${c}`); return e; };
    const tl = await byCode(opt('--tl')); const stl = await byCode(opt('--stl'));
    const input = {
      date: opt('--date'), department: opt('--department'), designation: opt('--designation'), seat: opt('--seat'), team: opt('--team') || undefined,
      tlId: tl ? tl.id : null, stlId: stl ? stl.id : null, roleCode: opt('--role'), employeeType: opt('--type'), location: opt('--location'), remarks: opt('--remarks'), previousLastDay: opt('--previous-last-day'),
    };
    const prep = await R.prepare({ employee, actor, input });
    if (prep.refusal) { console.error(`\nREFUSED (${prep.refusal.code || prep.refusal.status}): ${prep.refusal.error}`); return 1; }
    const plan = prep.plan;
    console.log('\nWHAT WILL CHANGE (planned)');
    R.changesOf(plan).forEach((c) => console.log(`  ${c.table}.${c.field}: ${JSON.stringify(showDate(c.field, c.from))} -> ${JSON.stringify(c.to)}`));
    console.log(`  EmployeeRecord: NEW type REJOINING "Rejoined on ${R.nice(plan.date)}" (date ${plan.date}); the old RESIGNATION record is kept and gets a "Rejoined on" line`);
    console.log(`  PositionAssignment: ${plan.seat ? `NEW ${plan.seat.code} from ${plan.date}${plan.formerHolder ? ` (the former holder's open tenure is closed first)` : ''}` : 'no change: SEAT TO BE ASSIGNED (give --seat <code>, or pick one in the profile later)'}`);
    console.log(`  Attendance gap (not counted as absent): ${plan.gap ? `${plan.gap.from} .. ${plan.gap.to}` : 'none'}`);
    plan.warnings.forEach((w) => console.log(`  NOTE: ${w}`));

    const before = tableCounts(WORK_DB);
    const empBefore = rowOf(WORK_DB, 'Employee', employee.id);
    const userBefore = user ? rowOf(WORK_DB, 'User', user.id) : null;
    const exitBefore = plan.stint.live ? rowOf(WORK_DB, 'EmployeeRecord', plan.stint.live.record.id) : null;
    if (MODE === 'apply') {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before.db'); snapshot(WORK_DB, bk); console.log(`\nfull backup copy: ${bk}`);
      var backupFile = bk; // eslint-disable-line no-var
    }
    const done = await R.apply({ plan, actor });
    const after = tableCounts(WORK_DB);
    console.log(`\n=== ${MODE === 'dry' ? 'RESULT ON THE COPY' : 'APPLIED'} ===`);
    console.log('ROWS (count before -> after, only tables that changed)');
    Object.keys(after).forEach((t) => { if (before[t] !== after[t]) console.log(`  ${t}: ${before[t]} -> ${after[t]}  (+${after[t] - before[t]})`); });
    console.log('Employee row, field by field:');
    diffRow(empBefore, rowOf(WORK_DB, 'Employee', employee.id)).forEach((d) => console.log(`  ${d.field}: ${JSON.stringify(showDate(d.field, d.from))} -> ${JSON.stringify(showDate(d.field, d.to))}`));
    if (user) { console.log('User (login) row, field by field:'); diffRow(userBefore, rowOf(WORK_DB, 'User', user.id)).forEach((d) => console.log(`  ${d.field}: ${JSON.stringify(showDate(d.field, d.from))} -> ${JSON.stringify(showDate(d.field, d.to))}`)); } else console.log('User: none linked: no login row touched.');
    if (exitBefore) { console.log('Old exit (RESIGNATION) record: kept, status stays; changed:'); diffRow(exitBefore, rowOf(WORK_DB, 'EmployeeRecord', plan.stint.live.record.id)).forEach((d) => console.log(`  ${d.field}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`)); }
    const rec = rowOf(WORK_DB, 'EmployeeRecord', done.recordId);
    console.log(`New REJOINING record: ${rec.id} | ${rec.title} | status ${rec.status} | date ${rec.date}`);
    console.log(`Seat: ${done.seat ? `${done.seat} from ${done.seatFrom}` : 'none (to be assigned)'} | Super Admins told (bell + task): ${done.told} | needs login: ${done.needsLogin ? 'YES' : 'no'}`);
    const man = { ...done.manifest, version: 1, script: path.basename(__filename), db: WORK_DB, backup: backupFile || null, code: CODE, recordId: done.recordId };
    if (MODE === 'apply') {
      const mf = path.join(BACKUP_DIR, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(man, null, 1)); console.log(`undo manifest: ${mf}`);
      console.log(`To undo:  TL_ALLOW_REAL_APPLY=1 node scripts/rejoin-employee.js --undo "${mf}" --really-real`);
      console.log(`Next:     TL_ALLOW_REAL_APPLY=1 node scripts/load-attendance-13-15oct.js --apply --force-rerun --really-real`);
    } else console.log('\nDRY RUN: nothing was written to the target database. Add --apply (with --really-real and TL_ALLOW_REAL_APPLY=1 for the real database) to do it.');
  } finally {
    await prisma.$disconnect().catch(() => {});
    if (TEMP_DB) for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(TEMP_DB + s); } catch { /* gone */ } }
  }
  return code;
}

module.exports = { main };
if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c || 0; }).catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; });
}
