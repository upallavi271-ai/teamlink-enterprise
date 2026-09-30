#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RESIGNATION HISTORY — "resigned employees must be recorded in our
// Resignation module, date-wise" (the user's rule, 2026-09-29).
//
//   node scripts/import-resignation-history.js <file.xlsx> --out <dir>            (dry run: PLAN only)
//   node scripts/import-resignation-history.js <file.xlsx> --out <dir> --apply    (backup + apply + re-plan)
//
// FOR EVERY EMPLOYEE whose status is Relieved / Exited and who has NO
// Resignation record yet, one HISTORICAL Resignation record is created:
//   EmployeeRecord  type RESIGNATION, status Relieved, date = relieving date,
//                   category = the resignation type (Termination / Resignation / Dropout)
//   ResignationDetail  approved/requested last working date = relieving date,
//                   reason = "Reason for left" (blank when the file has none),
//                   submittedByName = "Imported from employee master"
//   AuditLog        one row per record
// NO approval chain, NO notification, NO email, NO F&F request, and the
// employee's own record (status, dates, anything) is NOT touched.
//
// WHAT IT READS: the sheet "Total Employees" and nothing else — the password
// sheet is never opened — and of it only Employee ID, First Name, status,
// Date of Relieving and Reason for left. Salary is never read.
//
// MATCHING: Employee ID + name, exactly like scripts/sync-employee-master.js
// (nameMatch). An ID whose name clearly differs is not used (listed). A
// duplicate ID is used only when its copies agree on type and date.
// No date in the file -> the record is still created, date left BLANK, listed.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

process.chdir(path.join(__dirname, '..'));
// eslint-disable-next-line import/no-extraneous-dependencies
require('dotenv').config();
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const { nameMatch, parseDate } = require('./sync-employee-master');

const SHEET = 'Total Employees';
const SOURCE_LABEL = 'Active Employee with all details _new (1).xlsx';
const IMPORT_SOURCE = 'Imported from employee master';
const ACTOR = 'Resignation history import (employee master)';
const LEFT = ['Relieved', 'Exited'];
const FILE_EXIT = { termination: 'Termination', resignation: 'Resignation', dropout: 'Dropout' };
const COLS = {
  id: 'Employee ID', name: 'First Name', status: 'status', dor: 'Date of Relieving', reason: 'Reason for left',
};

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

function readFile(file) {
  const wb = XLSX.readFile(file, { sheets: [SHEET] });
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`Sheet "${SHEET}" not found`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const head = grid[0].map((h) => clean(h).toLowerCase());
  const idx = {};
  Object.entries(COLS).forEach(([k, label]) => {
    const i = head.indexOf(label.toLowerCase());
    if (i < 0) throw new Error(`Column "${label}" not found`);
    idx[k] = i;
  });
  const rows = [];
  grid.slice(1).forEach((r, i) => {
    const o = { line: i + 2 };
    Object.entries(idx).forEach(([k, j]) => { o[k] = r[j]; });
    if (clean(o.id) || clean(o.name)) rows.push(o);
  });
  return rows;
}

async function buildPlan(prisma, file) {
  const rows = readFile(file);
  const byId = new Map();
  rows.forEach((r) => {
    const id = clean(r.id).replace(/\s+/g, '').toUpperCase();
    if (!id) return;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  });
  const employees = await prisma.employee.findMany({
    where: { employmentStatus: { in: LEFT } },
    include: { reportingManager: { select: { name: true } } },
    orderBy: { employeeCode: 'asc' },
  });
  const withRecord = new Set((await prisma.employeeRecord.findMany({
    where: { type: 'RESIGNATION' }, select: { employeeId: true },
  })).map((r) => r.employeeId));

  const plan = {
    fileRows: rows.length, leftEmployees: employees.length, alreadyRecorded: 0,
    create: [], noDate: [], notInFile: [], mismatch: [], dupDisagree: [], invalidDate: [], fuzzy: [], byStatus: {}, byType: {}, byMonth: {},
  };
  employees.forEach((e) => {
    if (withRecord.has(e.id)) { plan.alreadyRecorded += 1; return; }
    const code = clean(e.employeeCode).toUpperCase();
    const list = (byId.get(code) || []).filter((r) => nameMatch(r.name, e.name) !== 'mismatch');
    const clash = (byId.get(code) || []).filter((r) => nameMatch(r.name, e.name) === 'mismatch');
    let row = null;
    let note = '';
    if (!list.length) {
      if (clash.length) plan.mismatch.push({ id: code, ours: e.name, file: clash.map((r) => clean(r.name)).join(' | '), lines: clash.map((r) => r.line).join(', ') });
      else plan.notInFile.push({ id: code, name: e.name, status: e.employmentStatus });
    } else {
      // Prefer the copies that say the person LEFT and carry a date.
      const exitRows = list.filter((r) => FILE_EXIT[clean(r.status).toLowerCase()]);
      const pool = exitRows.length ? exitRows : list;
      const sig = (r) => `${FILE_EXIT[clean(r.status).toLowerCase()] || ''}|${parseDate(r.dor).value || ''}`;
      const dated = pool.filter((r) => parseDate(r.dor).value);
      const candidates = dated.length ? dated : pool;
      if (new Set(candidates.map(sig)).size > 1) {
        plan.dupDisagree.push({ id: code, name: e.name, copies: candidates.map((r) => `row ${r.line}: ${clean(r.status) || '-'} ${parseDate(r.dor).value || clean(r.dor) || '-'}`).join(' | ') });
        note = 'duplicate rows in the file disagree — date left blank';
      } else row = candidates[0];
      if (list.some((r) => nameMatch(r.name, e.name) === 'fuzzy')) plan.fuzzy.push({ id: code, ours: e.name, file: clean(list[0].name) });
    }
    let date = null;
    let type = null;
    let reason = '';
    if (row) {
      const d = parseDate(row.dor);
      if (d.value) date = d.value;
      else if (d.invalid !== undefined) plan.invalidDate.push({ id: code, name: e.name, value: d.invalid, line: row.line });
      type = FILE_EXIT[clean(row.status).toLowerCase()] || null;
      reason = clean(row.reason);
    }
    const item = {
      employee: e, id: code, name: e.name, status: e.employmentStatus, date, type, reason,
      line: row ? row.line : null, fileStatus: row ? clean(row.status) : '', note,
    };
    plan.create.push(item);
    if (!date) plan.noDate.push({ id: code, name: e.name, status: e.employmentStatus, why: note || (row ? 'no Date of Relieving in the file' : (clash.length ? 'ID/name mismatch in the file' : 'not in the file')) });
    plan.byStatus[e.employmentStatus] = (plan.byStatus[e.employmentStatus] || 0) + 1;
    const t = type || '(type not in file)';
    plan.byType[t] = (plan.byType[t] || 0) + 1;
    const m = date ? date.slice(0, 7) : '(no date)';
    plan.byMonth[m] = (plan.byMonth[m] || 0) + 1;
  });
  return plan;
}

function writeReport(plan, dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  const L = [];
  L.push(`RESIGNATION HISTORY IMPORT — ${tag} — ${new Date().toISOString()}`);
  L.push(`Source: ${SOURCE_LABEL}, sheet "${SHEET}" only; columns ${Object.values(COLS).join(', ')}. Salary / password sheet NOT read.`);
  L.push('');
  L.push(`Employees Relieved/Exited: ${plan.leftEmployees}; already have a Resignation record: ${plan.alreadyRecorded}`);
  L.push(`Records to create: ${plan.create.length} (with relieving date ${plan.create.length - plan.noDate.length}, date blank ${plan.noDate.length})`);
  L.push(`By employee status: ${JSON.stringify(plan.byStatus)}`);
  L.push(`By type: ${JSON.stringify(plan.byType)}`);
  L.push(`ID/name mismatch (not used): ${plan.mismatch.length}; not in file: ${plan.notInFile.length}; duplicate rows disagreeing: ${plan.dupDisagree.length}; invalid dates: ${plan.invalidDate.length}; fuzzy names: ${plan.fuzzy.length}`);
  L.push('');
  L.push('By relieving month:');
  Object.keys(plan.byMonth).sort().forEach((m) => L.push(`  ${m}: ${plan.byMonth[m]}`));
  L.push('');
  L.push(`DATE BLANK (${plan.noDate.length}):`);
  plan.noDate.forEach((x) => L.push(`  ${x.id} ${x.name} [${x.status}] — ${x.why}`));
  L.push('');
  L.push(`ID/name mismatch (${plan.mismatch.length}):`);
  plan.mismatch.forEach((x) => L.push(`  ${x.id}: ours "${x.ours}" vs file "${x.file}" (rows ${x.lines})`));
  L.push(`Duplicate rows disagreeing (${plan.dupDisagree.length}):`);
  plan.dupDisagree.forEach((x) => L.push(`  ${x.id} ${x.name}: ${x.copies}`));
  L.push(`Invalid dates (${plan.invalidDate.length}):`);
  plan.invalidDate.forEach((x) => L.push(`  row ${x.line} ${x.id} ${x.name}: "${x.value}"`));
  L.push(`Fuzzy name matches (${plan.fuzzy.length}):`);
  plan.fuzzy.forEach((x) => L.push(`  ${x.id}: ours "${x.ours}" ~ file "${x.file}"`));
  const txt = path.join(dir, `resignation-history-${tag}.txt`);
  fs.writeFileSync(txt, L.join('\n'));
  const wb = XLSX.utils.book_new();
  const add = (name, list) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(list.length ? list : [{ note: 'none' }]), name);
  add('To create', plan.create.map(({ employee, ...x }) => ({ ...x, department: employee.department || '' })));
  add('Date blank', plan.noDate);
  add('ID-name mismatch', plan.mismatch);
  add('Duplicates disagree', plan.dupDisagree);
  add('Invalid dates', plan.invalidDate);
  const xlsx = path.join(dir, `resignation-history-${tag}.xlsx`);
  XLSX.writeFile(wb, xlsx);
  return { txt, xlsx, lines: L };
}

async function apply(prisma, plan) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(process.cwd(), 'backups', `dev.db.before-resignation-history.${stamp}`).replace(/\\/g, '/');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${backup}'`);
  console.log('Backup:', backup);
  let n = 0;
  await prisma.$transaction(async (tx) => {
    // eslint-disable-next-line no-restricted-syntax
    for (const it of plan.create) {
      const e = it.employee;
      // eslint-disable-next-line no-await-in-loop
      const rec = await tx.employeeRecord.create({
        data: {
          type: 'RESIGNATION',
          employeeId: e.id,
          title: it.type || 'Relieved (history)',
          detail: null,
          status: 'Relieved',
          date: it.date,
          category: it.type,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await tx.resignationDetail.create({
        data: {
          recordId: rec.id,
          employeeId: e.id,
          employeeCode: e.employeeCode,
          employeeName: e.name,
          department: e.department,
          designation: e.designation,
          reportingManager: (e.reportingManager && e.reportingManager.name) || e.tl || e.stl || null,
          resignationDate: '',
          requestedLastWorkingDate: it.date,
          approvedLastWorkingDate: it.date,
          reason: it.reason || '',
          comments: null,
          noticePeriodDays: null,
          exitComments: `Source: ${SOURCE_LABEL} (sheet ${SHEET})${it.line ? `, row ${it.line}` : ''}; status in file: ${it.fileStatus || '—'}; employee status: ${e.employmentStatus}.${it.note ? ` ${it.note}.` : ''}`,
          submittedByUserId: null,
          submittedByName: IMPORT_SOURCE,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await tx.auditLog.create({
        data: {
          action: 'Resignation history imported',
          entity: 'EmployeeRecord',
          entityId: rec.id,
          fromValue: e.employmentStatus,
          toValue: `Relieved ${it.date || '(relieving date not in file)'}${it.type ? ` · ${it.type}` : ''}`,
          actorName: ACTOR,
          reason: `${IMPORT_SOURCE} — ${e.employeeCode} ${e.name}`,
        },
      });
      n += 1;
    }
  }, { timeout: 180000, maxWait: 20000 });
  return { backup, created: n };
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const file = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  if (!file || !outDir) {
    console.error('usage: node scripts/import-resignation-history.js <file.xlsx> --out <dir> [--apply]');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const plan = await buildPlan(prisma, file);
    const r = writeReport(plan, outDir, args.includes('--apply') ? 'plan-before-apply' : 'plan');
    console.log(r.lines.slice(0, 12).join('\n'));
    console.log('Report:', r.txt);
    if (args.includes('--apply')) {
      const res = await apply(prisma, plan);
      console.log(`Created ${res.created} historical Resignation record(s).`);
      const after = await buildPlan(prisma, file);
      const r2 = writeReport(after, outDir, 'plan-after-apply');
      console.log(`Re-plan after apply: ${after.create.length} pending. Report: ${r2.txt}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { buildPlan, IMPORT_SOURCE };
