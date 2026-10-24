#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// EXIT DATE CONSISTENCY (HRMS spec item 7, 2026-10-13)
//
//   node scripts/exit-date-consistency.js                  DRY RUN (default): writes NOTHING, prints counts + examples
//   node scripts/exit-date-consistency.js --md out.md      dry run + a readable file (initials + employee code only)
//   node scripts/exit-date-consistency.js --json out.json  dry run + every row, machine readable
//   node scripts/exit-date-consistency.js --apply          backup first, then write ONLY the CLEAR cases, with an undo file
//   node scripts/exit-date-consistency.js --undo <file>    put every changed value back
//   --db <sqlite file>   another database (a scratch copy / the sandbox). Default: .env DATABASE_URL.
//
// THE CANONICAL EXIT DATE is the last working day on the person's current exit record
// (EmployeeRecord type RESIGNATION .date - utils/exitDate.js). This script lists every employee whose
// status says left / on notice and whose copies of that date are missing or disagree:
//   exit record  vs  resignation form (approved / requested)  vs  pending full & final  vs  the seat end date
//   vs  the last day they were marked present  vs  the day their status was changed.
//
// CLEAR cases (--apply writes these, nothing else):
//   * the record has no date but the resignation form has one          -> record := form
//   * the record and the form differ                                   -> form := record (the record wins)
//   * a PENDING full & final request has another date                  -> request := record
//   * the seat was ended by the exit "from the last working day" and its end date differs -> seat end := record
// REVIEW cases are only listed, with the evidence and a proposed date, for HR to decide:
//   * no date anywhere / no exit record at all (proposed: last day present, else the day the status changed)
//   * attendance marked after the date, seat ended on another evidence, status says left but the date is ahead.
//
// SAFETY: --apply / --undo on the REAL database needs BOTH --really-real AND TL_ALLOW_REAL_APPLY=1.
// It makes a full backup first (utils/backup.js), writes in ONE transaction, one audit row per change, and saves
// an undo file next to the backup. Test rows (ZZTEST / example.test) are never touched. Nothing is deleted.
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
const exitDate = require('../src/utils/exitDate');

const TEST_ROW = /zztest|example\.test/i;
const LEAVING = ['Notice Period', 'Exit Process', 'Relieved', 'Exited', 'Terminated'];
const FINAL = ['Relieved', 'Exited', 'Terminated'];
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const day = (v) => exitDate.isoDay(v);
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('.');
const todayIso = () => new Date().toISOString().slice(0, 10);

async function plan() {
  const emps = (await prisma.employee.findMany({
    where: { employmentStatus: { in: LEAVING } },
    select: { id: true, name: true, employeeCode: true, employmentStatus: true, department: true, updatedAt: true },
  })).filter((e) => !TEST_ROW.test(`${e.name} ${e.employeeCode}`));
  const ids = emps.map((e) => e.id);
  const live = await exitDate.liveRecords(ids);
  const fnfs = await prisma.fnfRequest.findMany({ where: { employeeId: { in: ids }, status: 'Pending' } });
  const seats = await prisma.positionAssignment.findMany({ where: { employeeId: { in: ids } }, include: { position: { select: { code: true } } } });
  const att = await prisma.attendance.groupBy({ by: ['employeeId'], where: { employeeId: { in: ids }, status: { in: ['Present', 'Half Day', 'Late', 'On Time'] } }, _max: { date: true } });
  const lastPresent = new Map(att.map((a) => [a.employeeId, day(a._max.date)]));
  const audits = await prisma.auditLog.findMany({
    where: { entity: 'Employee', entityId: { in: ids }, field: 'employmentStatus', toValue: { in: ['Relieved', 'Exited', 'Exit Process', 'Terminated', 'Notice Period'] } },
    orderBy: { createdAt: 'desc' }, select: { entityId: true, createdAt: true },
  });
  const statusDay = new Map();
  audits.forEach((a) => { if (!statusDay.has(a.entityId)) statusDay.set(a.entityId, iso(a.createdAt)); });
  const today = todayIso();
  const rows = [];
  for (const e of emps) {
    const lv = live.get(e.id);
    const base = { employeeId: e.id, who: `${initials(e.name)} ${e.employeeCode || ''}`.trim(), name: e.name, status: e.employmentStatus, department: e.department || '' };
    const lp = lastPresent.get(e.id) || null;
    const sd = statusDay.get(e.id) || null;
    const proposal = lp ? { date: lp, evidence: 'the last day marked present' } : (sd ? { date: sd, evidence: 'the day the status was changed' } : null);
    if (!lv) { rows.push({ ...base, kind: 'no-record', level: 'REVIEW', proposed: proposal, note: 'Leaving by status, but no exit record on file.' }); continue; }
    const { record, detail } = lv;
    const recDate = day(record.date);
    const formDate = detail ? day(record.status === 'Pending Approval' ? detail.requestedLastWorkingDate : detail.approvedLastWorkingDate) : null;
    const formAny = detail ? day(detail.approvedLastWorkingDate) || day(detail.requestedLastWorkingDate) : null;
    const canonical = recDate || formAny || null;
    const common = { ...base, recordId: record.id, recordStatus: record.status, recDate, formDate: formAny };
    if (!canonical) { rows.push({ ...common, kind: 'no-date', level: 'REVIEW', proposed: proposal, note: 'The exit record has no last working day.' }); }
    else {
      if (!recDate && formAny) rows.push({ ...common, kind: 'record-empty', level: 'CLEAR', set: { table: 'record', id: record.id, field: 'date', to: formAny }, note: 'The record has no date; the resignation form has one.' });
      if (recDate && detail && formDate && formDate !== recDate) rows.push({ ...common, kind: 'form-differs', level: 'CLEAR', set: { table: 'detail', id: detail.id, field: record.status === 'Pending Approval' ? 'requestedLastWorkingDate' : 'approvedLastWorkingDate', to: recDate }, note: `Form says ${formDate}, record says ${recDate}.` });
      if (recDate && detail && !formDate && formAny && formAny !== recDate) rows.push({ ...common, kind: 'form-differs', level: 'CLEAR', set: { table: 'detail', id: detail.id, field: 'approvedLastWorkingDate', to: recDate }, note: `Form says ${formAny}, record says ${recDate}.` });
      fnfs.filter((f) => f.employeeId === e.id && day(f.lastWorkingDate) !== canonical).forEach((f) => {
        rows.push({ ...common, kind: 'fnf-differs', level: 'CLEAR', set: { table: 'fnf', id: f.id, field: 'lastWorkingDate', to: canonical }, note: `Pending full & final says ${day(f.lastWorkingDate)}.` });
      });
      const endedAll = seats.filter((s) => s.employeeId === e.id && s.toDate).sort((a, b) => String(b.toDate).localeCompare(String(a.toDate)));
      const ended = endedAll[0];
      if (ended && ended.toDate !== canonical) {
        const byExit = /^(Exited|Notice ended|Relieved|Terminated)/i.test(ended.note || '');
        const fromLwd = byExit && /last working day/i.test(ended.note || '');
        const to = canonical < ended.fromDate ? ended.fromDate : canonical;
        rows.push({
          ...common, kind: 'seat-differs', level: fromLwd && to !== ended.toDate ? 'CLEAR' : 'REVIEW', seatCode: ended.position.code, seatEnd: ended.toDate,
          set: fromLwd && to !== ended.toDate ? { table: 'seat', id: ended.id, field: 'toDate', to, oldNote: ended.note } : null,
          note: `Seat ${ended.position.code} ended ${ended.toDate}${fromLwd ? ' (from the last working day)' : ' (from other evidence)'}; the exit date is ${canonical}.`,
        });
      }
      const lpAfter = lp && lp > canonical;
      if (lpAfter) rows.push({ ...common, kind: 'present-after', level: 'REVIEW', note: `Marked present on ${lp}, after the last working day ${canonical}.` });
      if (FINAL.includes(e.employmentStatus) && canonical > today) rows.push({ ...common, kind: 'final-but-ahead', level: 'REVIEW', note: `Status ${e.employmentStatus}, but the last working day ${canonical} is still ahead.` });
    }
  }
  const covered = new Set(rows.map((r) => r.employeeId));
  return { rows, employees: emps.length, consistent: emps.filter((e) => !covered.has(e.id)).length, byStatus: emps.reduce((o, e) => ({ ...o, [e.employmentStatus]: (o[e.employmentStatus] || 0) + 1 }), {}) };
}

function report(p) {
  const L = [];
  const kinds = {};
  p.rows.forEach((r) => { (kinds[`${r.kind} [${r.level}]`] = kinds[`${r.kind} [${r.level}]`] || []).push(r); });
  L.push(`People with a leaving status: ${p.employees} (${Object.entries(p.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}).`);
  L.push(`Fully consistent (nothing to report): ${p.consistent}. With at least one finding: ${p.employees - p.consistent}.`);
  L.push(`CLEAR (--apply would write): ${p.rows.filter((r) => r.level === 'CLEAR').length} change(s). REVIEW (HR decides): ${p.rows.filter((r) => r.level === 'REVIEW').length} finding(s).`);
  L.push('');
  Object.entries(kinds).sort().forEach(([k, list]) => {
    L.push(`${k}: ${list.length}`);
    list.slice(0, 6).forEach((r) => {
      const prop = r.proposed ? ` proposed ${r.proposed.date} (${r.proposed.evidence})` : '';
      L.push(`   - ${r.who} ${r.status}${r.recDate ? ` record ${r.recDate}` : ''}${r.formDate && r.formDate !== r.recDate ? ` form ${r.formDate}` : ''}${prop} ${r.note ? `- ${r.note}` : ''}`);
    });
    if (list.length > 6) L.push(`   ... and ${list.length - 6} more`);
  });
  return L.join('\n');
}

async function apply(p) {
  guardReal('--apply');
  const changes = p.rows.filter((r) => r.level === 'CLEAR' && r.set);
  if (!changes.length) { console.log('Nothing to do.'); return; }
  // eslint-disable-next-line global-require
  const backup = require('../src/utils/backup');
  const b = await backup.makeBackup({ reason: 'before the exit date consistency fix', by: 'exit-date-consistency.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  await prisma.$transaction(async (tx) => {
    for (const r of changes) {
      const s = r.set;
      let before = null;
      if (s.table === 'record') { before = (await tx.employeeRecord.findUnique({ where: { id: s.id }, select: { date: true } })).date; await tx.employeeRecord.update({ where: { id: s.id }, data: { date: s.to } }); }
      else if (s.table === 'detail') { before = (await tx.resignationDetail.findUnique({ where: { id: s.id }, select: { [s.field]: true } }))[s.field]; await tx.resignationDetail.update({ where: { id: s.id }, data: { [s.field]: s.to } }); }
      else if (s.table === 'fnf') { before = (await tx.fnfRequest.findUnique({ where: { id: s.id }, select: { lastWorkingDate: true } })).lastWorkingDate; await tx.fnfRequest.update({ where: { id: s.id }, data: { lastWorkingDate: s.to } }); }
      else if (s.table === 'seat') {
        const cur = await tx.positionAssignment.findUnique({ where: { id: s.id }, select: { toDate: true, note: true } });
        before = { toDate: cur.toDate, note: cur.note };
        const note = (cur.note || '').replace(/ Seat freed \d{4}-\d{2}-\d{2},/, ` Seat freed ${s.to},`).slice(0, 500);
        await tx.positionAssignment.update({ where: { id: s.id }, data: { toDate: s.to, note } });
      }
      undo.rows.push({ table: s.table, id: s.id, field: s.field, before, after: s.to });
      await tx.auditLog.create({
        data: {
          action: 'Exit date changed', entity: 'EmployeeRecord', entityId: r.recordId, field: 'exitDate', fieldLabel: 'Last working day · script',
          fromValue: String((before && before.toDate) || before || '(none)'), toValue: s.to, reason: `Consistency fix: ${r.note}`.slice(0, 480), actorName: 'System (exit-date-consistency.js)',
        },
      });
    }
  }, { timeout: 120000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `exit-date-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Changed ${undo.rows.length} value(s).`);
  console.log(`To put them back:  node scripts/exit-date-consistency.js --undo "${file}"${isRealDb() ? ' --really-real  (with TL_ALLOW_REAL_APPLY=1)' : ''}`);
}

async function undoRun(file) {
  guardReal('--undo');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of u.rows) {
      if (r.table === 'record') await tx.employeeRecord.update({ where: { id: r.id }, data: { date: r.before } });
      else if (r.table === 'detail') await tx.resignationDetail.update({ where: { id: r.id }, data: { [r.field]: r.before } });
      else if (r.table === 'fnf') await tx.fnfRequest.update({ where: { id: r.id }, data: { lastWorkingDate: r.before } });
      else if (r.table === 'seat') await tx.positionAssignment.update({ where: { id: r.id }, data: { toDate: r.before.toDate, note: r.before.note } });
      n += 1;
    }
  }, { timeout: 120000, maxWait: 30000 });
  console.log(`Put back ${n} value(s).`);
}

(async () => {
  try {
    if (opt('--undo')) { await undoRun(opt('--undo')); return; }
    const p = await plan();
    console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
    console.log(report(p));
    if (opt('--md')) fs.writeFileSync(opt('--md'), `# Exit date consistency\n\n\`\`\`\n${report(p)}\n\`\`\`\n`);
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(p.rows.map((r) => ({ ...r, name: undefined })), null, 1));
    if (has('--apply')) await apply(p);
    else console.log('\nDRY RUN: nothing was written. (--apply writes only the CLEAR cases; on the real database it needs --really-real and TL_ALLOW_REAL_APPLY=1.)');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
