#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// REPORTING MANAGER MUST BE A LEAD OF THE EMPLOYEE'S OWN DEPARTMENT (user, 2026-10-10)
//
//   node scripts/fix-reporting-lines.js                 DRY RUN: writes NOTHING, prints the table
//   node scripts/fix-reporting-lines.js --md plan.md    dry run + a readable file
//   node scripts/fix-reporting-lines.js --apply         backup first, then fix ONLY the clear cases
//   node scripts/fix-reporting-lines.js --undo <file>   put every changed field back
//
//   --db <sqlite file>   another database (a scratch copy / the sandbox). Default: .env DATABASE_URL.
//
// RULE (utils/reportingLine.js): staff report to the ACTIVE team leads (or the manager) of their own
// department; a team lead reports to the manager level; a leaver is never a manager.
// A row is CLEAR when exactly one working person fits (e.g. Medical has one team lead): --apply sets the
// field to that person. Everything else (no lead in the department, several to choose from) is only listed:
// a person has to decide - HR picks on the employee's Edit form.
//
// SAFETY: --apply on the REAL database needs BOTH --really-real AND the environment variable
// TL_ALLOW_REAL_APPLY=1. It makes a full backup first (utils/backup.js), writes in ONE transaction, one
// audit row per change, and saves an undo file next to the backup. Test rows are never touched.
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
  if (!has('--really-real')) throw new Error(`This is the REAL database. ${what} needs --really-real (run the dry run first and get the table approved).`);
  if (process.env.TL_ALLOW_REAL_APPLY !== '1') throw new Error(`This is the REAL database. ${what} also needs the environment variable TL_ALLOW_REAL_APPLY=1.`);
}

// eslint-disable-next-line import/order
const prisma = require('../src/db');
const rl = require('../src/utils/reportingLine');

async function plan() {
  const rows = await rl.mismatches();
  const out = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const set = await rl.candidatesFor({ department: r.department === '(none)' ? '' : r.department, level: r.level, excludeId: r.employeeId });
    const one = set.options.length === 1 ? set.options[0] : null;
    out.push({ ...r, fixTo: one, choices: set.options.map((o) => o.name) });
  }
  return out;
}

function table(rows, total) {
  const L = [];
  L.push('| Employee | Department | Level | Field | Now points at | Their department | Why | Fix |');
  L.push('|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => {
    L.push(`| ${r.employee} (${r.code}) | ${r.department} | ${r.level} | ${r.field} | ${r.manager} | ${r.managerDepartment} | ${r.why} | ${r.fixTo ? `SET to ${r.fixTo.name}` : (r.choices.length ? `HR picks: ${r.choices.slice(0, 4).join(' / ')}` : 'nobody to pick yet - add a team lead') } |`);
  });
  const by = {};
  rows.forEach((r) => { by[r.department] = (by[r.department] || 0) + 1; });
  L.push('');
  L.push(`Active employees checked: ${total}. Lines outside the rule: ${rows.length} (${Object.entries(by).map(([d, n]) => `${d}: ${n}`).join(', ') || 'none'}). `
    + `WOULD SET (one clear answer): ${rows.filter((r) => r.fixTo).length}. LEFT FOR HR: ${rows.filter((r) => !r.fixTo).length}.`);
  return L.join('\n');
}

async function apply(rows) {
  guardReal('--apply');
  const todo = rows.filter((r) => r.fixTo);
  if (!todo.length) { console.log('Nothing is clear enough to set.'); return; }
  // eslint-disable-next-line global-require
  const backup = require('../src/utils/backup');
  const b = await backup.makeBackup({ reason: 'before fixing reporting lines', by: 'fix-reporting-lines.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  await prisma.$transaction(async (tx) => {
    for (const r of todo) {
      // eslint-disable-next-line no-await-in-loop
      const e = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { tl: true, stl: true, reportingManagerId: true } });
      const col = r.field === 'TL' ? 'tl' : r.field === 'STL' ? 'stl' : 'reportingManagerId';
      const to = col === 'reportingManagerId' ? r.fixTo.id : r.fixTo.name;
      const from = e[col];
      // eslint-disable-next-line no-await-in-loop
      await tx.employee.update({ where: { id: r.employeeId }, data: { [col]: to } });
      undo.rows.push({ id: r.employeeId, col, from, to });
      // eslint-disable-next-line no-await-in-loop
      await tx.auditLog.create({
        data: {
          action: 'Reporting line fixed (department rule)', entity: 'Employee', entityId: r.employeeId, field: col, fieldLabel: r.field,
          fromValue: r.manager, toValue: r.fixTo.name, reason: `${r.why}; the one ${r.department} lead`, actorName: 'System (fix-reporting-lines.js)',
        },
      });
    }
  }, { timeout: 120000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `reporting-lines-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Fixed ${undo.rows.length} line(s).`);
  console.log(`To put them back:  node scripts/fix-reporting-lines.js --undo "${file}"${isRealDb() ? ' --really-real  (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function undoRun(file) {
  guardReal('--undo');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of u.rows) {
      // eslint-disable-next-line no-await-in-loop
      const c = await tx.employee.updateMany({ where: { id: r.id, [r.col]: r.to }, data: { [r.col]: r.from } });
      n += c.count;
    }
  }, { timeout: 120000, maxWait: 30000 });
  console.log(`Undone: ${n} field(s) are back as they were (only those still holding the value this run set).`);
}

(async () => {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const rows = await plan();
  const total = await prisma.employee.count({ where: { employmentStatus: { in: ['Active', 'On Probation', 'Notice Period'] } } });
  console.log(table(rows, total));
  if (opt('--md')) { fs.writeFileSync(opt('--md'), table(rows, total)); console.log(`Wrote ${opt('--md')}`); }
  if (has('--apply')) await apply(rows);
  else console.log('\nDRY RUN - nothing was written. Add --apply to set the clear cases (backup + undo file are made first).');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
