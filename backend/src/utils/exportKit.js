// ---------------------------------------------------------------------------
// ONE WAY TO HAND A TABLE OVER AS A FILE (hrms-24 §3).
//
// Every employee-data export in routes/insights.js ends here, so each one
// writes the same three formats (Excel, CSV, PDF) from the same rows and —
// the part that matters — leaves the same audit row behind: what was
// exported, how many rows, in what scope and range, by whom.
//
// This file decides nothing about WHO may export WHAT. The caller has already
// run the screen's own scoped query and the `export` permission check; this
// only writes the bytes and the audit line. (tabularExport.js does the
// formats; this adds the headers, the filename and the log.)
// ---------------------------------------------------------------------------

const { toCsv, toXlsx, toPdf } = require('./tabularExport');
const { logAudit } = require('./audit');
// Every export also tells the Super Admin (utils/dataIoNotify.js).
const { notifyDataIo } = require('./dataIoNotify');

const FORMATS = ['xlsx', 'csv', 'pdf'];

// The screen each exported entity belongs to, for the Super Admin notice.
const SCREEN_OF = {
  Attendance: 'Attendance', AttendanceRegularization: 'Attendance', LeaveRequest: 'Leave', Payslip: 'Payroll',
  CourseAssignment: 'LMS', Task: 'Timesheet', PerformanceReview: 'Performance', RecognitionNomination: 'Rewards & Recognition',
  EmployeeDocument: 'Documents', Employee: 'Employee Management', EmployeeRecord: 'Employee Services',
};

// ?format=xlsx|csv|pdf (Excel is the default). null for anything else.
function formatOf(q = {}) {
  const f = String(q.format || 'xlsx').toLowerCase();
  if (f === 'excel') return 'xlsx';
  return FORMATS.includes(f) ? f : null;
}

const safeName = (s) => String(s || 'export').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

// Cells are written as plain values; a Date becomes YYYY-MM-DD, null/undefined
// an empty cell, so the three formats print the same thing.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return v;
}

async function sendTable(req, res, {
  format, name, title, headers, rows, sheet, entity, what, scope, period, screen,
}) {
  const clean = rows.map((r) => r.map(cell));
  const stamp = new Date().toISOString().slice(0, 10);
  const range = period ? `${period.from} to ${period.to}` : 'all dates';
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: `${what} exported (${format.toUpperCase()})`,
    entity,
    toValue: `${clean.length} row(s) · scope: ${scope} · ${range}`,
  });
  // THE SUPER ADMIN IS TOLD (in-app + one throttled email). ATS exports
  // (routes/atsIo.js) are candidate data, not employee data, and are left out.
  if (!String(req.baseUrl || '').startsWith('/api/ats')) {
    await notifyDataIo(req, {
      kind: 'export', module: screen || SCREEN_OF[entity] || what, count: clean.length, what: `rows of ${what}`, format, detail: `scope: ${scope} · ${range}`,
    });
  }
  const filename = `${safeName(name)}-${stamp}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Export-Rows', String(clean.length));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // The byte-order mark makes Excel read the file as UTF-8 (₹, names with
    // accents) instead of the machine's code page.
    return res.send(`﻿${toCsv(headers, clean)}`);
  }
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(toXlsx(headers, clean, (sheet || title || 'Export').slice(0, 31)));
  }
  res.setHeader('Content-Type', 'application/pdf');
  return res.send(toPdf(headers, clean, {
    title: title || what,
    subtitle: `${clean.length} row(s) · scope: ${scope} · ${range} · exported ${new Date().toLocaleString('en-GB')} by ${req.user.name || 'user'}`,
  }));
}

module.exports = { FORMATS, formatOf, sendTable };
