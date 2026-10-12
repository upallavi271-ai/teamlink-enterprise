#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RESIGNATIONS FROM A FILE (HRMS spec 2026-10-09, point 8) - the same rules as
// the "Import resignations" button (src/io/resignation.js), for a file in the
// OLD HRMS layout ("Resigned Employee list.csv": Employee No, Employee Name,
// Department, Designation, Date Of Resignation, Reason for Resignation, Last
// Working Date) or in the TeamLink sample layout.
//
//   node scripts/import-resignations-file.js <file.csv|xlsx>                 DRY RUN: what would happen, nothing written
//   node scripts/import-resignations-file.js <file> --apply                  backup + write (needs the user's OK on the real DB)
//   node scripts/import-resignations-file.js --undo [--backup <json>]        put everything back from the newest backup
//   --db <file>   another database (e.g. prisma/sandbox.db); default prisma/dev.db
//
// Matched by Employee ID only; an ID that is not in the database is listed and
// skipped; only EMPTY fields of an existing record are filled; nothing is
// duplicated; the employee's status is never changed. The backup is a JSON
// file in backend/backups/ holding every row as it was (and the ids created),
// so --undo restores exactly that.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const BACK = path.resolve(__dirname, '..');
const DB = path.resolve(arg('--db') || path.join(BACK, 'prisma', 'dev.db'));
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.chdir(BACK);
const XLSX = require('xlsx');
const prisma = require('../src/db');
const io = require('../src/utils/moduleIo');
const spec = require('../src/io/resignation');

const BACKUPS = path.join(BACK, 'backups');
const file = argv.find((a) => !a.startsWith('--') && a !== arg('--db') && a !== arg('--backup'));

// old HRMS header -> sample column
const OLD = { 'employee no': 'employeeCode', 'employee id': 'employeeCode', 'date of resignation': 'resignationDate', 'resignation date': 'resignationDate', 'reason for resignation': 'reason', reason: 'reason', 'last working date': 'lastWorkingDate', 'last working day': 'lastWorkingDate', time: 'resignationTime', 'resignation time': 'resignationTime', 'notice days': 'noticeDays', status: 'status' };

function readRows(f) {
  const wb = f.match(/\.(csv|txt)$/i) ? XLSX.read(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''), { type: 'string', raw: true }) : XLSX.readFile(f);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
  const head = aoa[0].map((h) => io.str(h).toLowerCase());
  const keys = head.map((h) => OLD[h] || null);
  if (!keys.includes('employeeCode')) throw new Error('No Employee No / Employee ID column in that file.');
  const rows = [];
  for (let i = 1; i < aoa.length; i += 1) {
    const row = { line: i + 1 };
    keys.forEach((k, j) => { if (k) { let v = aoa[i][j]; if (typeof v === 'number' && /date/i.test(k)) v = io.dateFromSerial(v) || String(v); row[k] = io.str(v); } });
    if (!io.str(row.employeeCode)) continue;
    rows.push(row);
  }
  return rows;
}

async function employeeIndex() {
  const rows = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, email: true, department: true, team: true, userId: true, employmentStatus: true } });
  const byCode = new Map(rows.map((e) => [io.str(e.employeeCode).toUpperCase(), e]));
  return { resolve(v) { const e = byCode.get(io.str(v).toUpperCase()); return e ? { employee: e } : { error: `Employee "${io.str(v)}" does not exist.` }; } };
}

async function main() {
  console.log(`Database: ${DB}`);
  if (has('--undo')) {
    const files = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^resignations-import-.*\.json$/.test(f)).sort() : [];
    const bf = arg('--backup') ? path.resolve(arg('--backup')) : (files.length ? path.join(BACKUPS, files[files.length - 1]) : null);
    if (!bf || !fs.existsSync(bf)) { console.log('No backup found.'); return; }
    const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    if (path.resolve(b.db) !== DB) { console.log(`That backup belongs to ${b.db}.`); return; }
    const ids = b.created || [];
    await prisma.$transaction(async (tx) => {
      await tx.resignationDetail.deleteMany({ where: { recordId: { in: ids } } });
      await tx.employeeRecord.deleteMany({ where: { id: { in: ids } } });
      for (const x of b.updated || []) {
        const { id: rid, ...rec } = x.record;
        await tx.employeeRecord.update({ where: { id: rid }, data: { date: rec.date, status: rec.status, title: rec.title, detail: rec.detail, category: rec.category } });
        if (x.detail) {
          const { id: did, createdAt, updatedAt, submittedAt, ...det } = x.detail; // eslint-disable-line no-unused-vars
          await tx.resignationDetail.update({ where: { id: did }, data: det });
        } else await tx.resignationDetail.deleteMany({ where: { recordId: rid } });
      }
      await tx.auditLog.deleteMany({ where: { reason: { contains: `batch ${b.batch}` } } });
    });
    console.log(`UNDONE from ${path.basename(bf)}: ${ids.length} created record(s) removed, ${(b.updated || []).length} restored.`);
    return;
  }
  if (!file) { console.log('Usage: node scripts/import-resignations-file.js <file> [--apply] [--db <db>]   |   --undo'); return; }
  const rows = readRows(path.resolve(file));
  const ctx = { user: { id: null, name: 'Resignation import (script)', email: null }, employees: await employeeIndex(), fileName: path.basename(file) };
  const validated = await spec.validate(rows, ctx);
  const good = validated.filter((v) => !(v.errors && v.errors.length) && ['create', 'update'].includes(v.action));
  const count = (a) => validated.filter((v) => (!v.errors || !v.errors.length) && v.action === a).length;
  console.log(`${rows.length} row(s) read from ${path.basename(file)}: ${count('create')} new, ${count('update')} to fill, ${count('nochange')} unchanged, ${validated.filter((v) => v.errors && v.errors.length).length} with errors.`);
  validated.forEach((v) => {
    const tag = v.errors && v.errors.length ? 'ERROR ' : v.action.toUpperCase().padEnd(8);
    const what = v.errors && v.errors.length ? v.errors.map((e) => `${e.field}: ${e.message}`).join(' | ') : [...(v.changes || []).map((c) => `${c.field} -> ${c.to}`), ...(v.notes || [])].join(' · ');
    console.log(`  row ${String(v.line).padStart(3)}  ${tag} ${v.label}  ${what}`);
  });
  if (!has('--apply')) { console.log('\nDRY RUN - nothing was written. Add --apply to write it (backup first; --undo restores).'); return; }
  if (!good.length) { console.log('Nothing to write.'); return; }

  fs.mkdirSync(BACKUPS, { recursive: true });
  const updated = [];
  for (const v of good.filter((x) => x.action === 'update')) {
    // eslint-disable-next-line no-await-in-loop
    updated.push({ record: await prisma.employeeRecord.findUnique({ where: { id: v.data.record.id } }), detail: await prisma.resignationDetail.findUnique({ where: { recordId: v.data.record.id } }) });
  }
  const before = new Set((await prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION' }, select: { id: true } })).map((r) => r.id));
  const result = await spec.apply(good, ctx);
  const after = await prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION' }, select: { id: true } });
  const created = after.map((r) => r.id).filter((id) => !before.has(id));
  const bf = path.join(BACKUPS, `resignations-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(bf, JSON.stringify({ db: DB, at: new Date().toISOString(), file: path.basename(file), batch: result.batch, created, updated }, null, 2));
  console.log(`\nAPPLIED: ${result.created} created, ${result.updated} filled, ${(result.failed || []).length} failed. Backup: ${bf}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
