// ---------------------------------------------------------------------------
// LEAVE HISTORY IMPORT — from the CSV, because the XLSX was unusable.
//
// The Excel export of this same report wrote Excel serial 2026 into every date
// cell, so all 342 rows read 18-Jul-1905 in all four date columns. CSV writes
// dates as text and cannot suffer that, which is why this reads the CSV: the
// dates in it are real (19-AUG-2026).
//
// COMMENTS CONTAIN NEWLINES. "Dear Sir,\nThis is Mamatha Dara…" is one field
// spanning three lines of the file, which is why this parses CSV properly
// rather than splitting on \n — 391 physical lines are 342 records.
//
// NO DUPLICATES ON A RE-RUN. LeaveRequest has no unique constraint (one person
// can legitimately take the same type of leave twice), so this matches on
// employee + type + from + to before writing. Re-running updates rather than
// doubling the history.
//
// A LEAVE REQUEST WITHOUT DATES IS NOT IMPORTED. fromDate and toDate are
// required on the model and rightly so — "Casual Leave, 1 day, sometime" is
// not a record of anything. Rows missing either are reported, never invented.
//
// Dry run by default; --commit writes.
// ---------------------------------------------------------------------------

const fs = require('fs');
const prisma = require('../src/db');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:/Users/user/Downloads/Leave History.csv';
const COMMIT = process.argv.includes('--commit');
const pad = (s, n) => String(s ?? '').padEnd(n);

// Quote-aware, so a comment containing commas and newlines stays one field.
function parseCsv(txt) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < txt.length; i += 1) {
    const ch = txt[i];
    if (q) {
      if (ch === '"') { if (txt[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};
// PulseHRM writes 19-AUG-2026. Anything else is left null rather than guessed.
function toIso(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) return null;
  const mm = MONTHS[m[2].toUpperCase()];
  return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}` : null;
}

// PulseHRM's four statuses map one-to-one onto the model's own vocabulary.
const STATUS = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
};

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  console.log('file: ' + FILE + '\n');

  const rows = parseCsv(fs.readFileSync(FILE, 'utf8'));
  const head = rows[0].map((h) => h.replace(/\s+/g, ' ').trim());
  const idx = (name) => head.indexOf(name);
  const col = {
    code: idx('Employee ID'), type: idx('Leave Type'),
    applied: idx('Date Of Application'), from: idx('Leave From'), to: idx('Leave To'),
    half: idx('Half Day'), days: idx('Duration'), reason: idx('Reason'),
    comments: idx('Comments'), approver: idx('Approver'),
    approverComment: idx('Approver Comments'), approved: idx('Approved Date'),
    status: idx('Status'),
  };

  const employees = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true } });
  const byCode = new Map(employees.map((e) => [String(e.employeeCode).trim().toUpperCase(), e]));

  const out = [];
  const unmatched = new Map();
  const noDates = [];
  const badStatus = new Map();

  for (const r of rows.slice(1)) {
    const code = String(r[col.code] || '').trim().toUpperCase();
    if (!code) continue;
    const emp = byCode.get(code);
    if (!emp) {
      unmatched.set(code, String(r[col.name] || r[1] || '').trim());
      continue;
    }
    const from = toIso(r[col.from]);
    const to = toIso(r[col.to]);
    if (!from || !to) { noDates.push(`${code} ${String(r[col.type] || '').trim()} "${String(r[col.from] || '')}"`); continue; }

    const rawStatus = String(r[col.status] || '').trim().toLowerCase();
    const status = STATUS[rawStatus];
    if (!status) badStatus.set(r[col.status] || '(blank)', (badStatus.get(r[col.status] || '(blank)') || 0) + 1);

    const days = Number(String(r[col.days] || '').trim());
    const approver = String(r[col.approver] || '').trim();
    const approverComment = String(r[col.approverComment] || '').trim();
    // The employee's own note is the reason; the approver's note is separate.
    const reason = [String(r[col.reason] || '').trim(), String(r[col.comments] || '').trim()]
      .filter(Boolean).join(' — ') || null;

    out.push({
      employeeId: emp.id,
      employeeCode: code,
      name: emp.name,
      type: String(r[col.type] || '').trim() || 'Casual Leave',
      fromDate: from,
      toDate: to,
      days: Number.isFinite(days) && days > 0 ? days : 1,
      reason,
      status: status || 'Pending',
      decidedBy: approver || null,
      // A rejection's note belongs on rejectReason, an approval's on
      // approvalReason — the model keeps them apart and so should this.
      approvalReason: status === 'Approved' ? (approverComment || null) : null,
      rejectReason: status === 'Rejected' ? (approverComment || null) : null,
      decidedAt: toIso(r[col.approved]) ? new Date(`${toIso(r[col.approved])}T00:00:00.000Z`) : null,
      createdAt: toIso(r[col.applied]) ? new Date(`${toIso(r[col.applied])}T00:00:00.000Z`) : undefined,
    });
  }

  const byStatus = out.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const byType = out.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {});
  const dates = out.map((r) => r.fromDate).sort();

  console.log('ROWS TO WRITE: ' + out.length);
  console.log('\n  BY STATUS');
  Object.entries(byStatus).forEach(([k, n]) => console.log('    ' + pad(k, 14) + n));
  console.log('  BY TYPE');
  Object.entries(byType).forEach(([k, n]) => console.log('    ' + pad(k, 16) + n));
  console.log('\n  employees covered : ' + new Set(out.map((r) => r.employeeId)).size);
  console.log('  date range        : ' + (dates[0] || '—') + '  to  ' + (dates[dates.length - 1] || '—'));
  console.log('  total leave days  : ' + out.reduce((s, r) => s + r.days, 0));

  if (noDates.length) {
    console.log(`\nNO USABLE DATES (${noDates.length}) — skipped, not invented:`);
    noDates.slice(0, 10).forEach((s) => console.log('  ' + s));
  }
  if (badStatus.size) {
    console.log('\nUNRECOGNISED STATUS (defaulted to Pending):');
    [...badStatus.entries()].forEach(([k, n]) => console.log('  ' + pad(k, 16) + n));
  }
  if (unmatched.size) {
    console.log(`\nEMPLOYEE CODES NOT IN THE SYSTEM (${unmatched.size}) — skipped:`);
    [...unmatched.entries()].slice(0, 15).forEach(([c, n]) => console.log('  ' + pad(c, 10) + n));
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to write.');
    process.exit(0);
  }

  console.log('\nwriting…');
  let created = 0; let updated = 0;
  for (const r of out) {
    const { employeeCode, name, ...data } = r;
    // eslint-disable-next-line no-await-in-loop
    const existing = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: data.employeeId, type: data.type, fromDate: data.fromDate, toDate: data.toDate,
      },
      select: { id: true },
    });
    if (existing) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.leaveRequest.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.leaveRequest.create({ data });
      created += 1;
    }
    if ((created + updated) % 50 === 0) process.stdout.write(`\r  ${created + updated} / ${out.length}`);
  }
  console.log(`\r  ${created + updated} / ${out.length}`);
  console.log(`\n  created ${created}, updated ${updated}`);
  console.log('\nAFTER');
  console.log('  leave requests in the system : ' + await prisma.leaveRequest.count());
  const g = await prisma.leaveRequest.groupBy({ by: ['status'], _count: true });
  g.forEach((x) => console.log('  ' + pad('  ' + x.status, 16) + x._count));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
