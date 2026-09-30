// ---------------------------------------------------------------------------
// ATTENDANCE — registered so the Attendance screen gets the shared Data I/O
// bar (Export all · Export one employee). It is EXPORT-ONLY here:
//
//   * the export is the screen's own GET /api/insights/attendance/export
//     (scoped, dated; a summary row per person, or every day for one
//     ?employeeId=) — so this spec has no exportRows;
//   * attendance is IMPORTED through the existing "Import History" importer
//     (old-HRMS CSV files: check-in/out report, bio-metric logs, summary —
//     each with its own sample; routes/attendance.js /history/import). That
//     importer is deliberately not duplicated here, so the bar's Import button
//     is off with a tooltip pointing to it;
//   * regularization requests are not imported at all — a regularization is a
//     request that runs an approval chain, not a historical record. Their
//     export is the Regularization tab's own (GET /api/insights/regularization/
//     export, which takes the tab's Employee ID / name filters).
// ---------------------------------------------------------------------------

const REASON = 'Attendance is imported with Import History (old-HRMS CSV files, each with its own sample file) on the Attendance screen — not from this button.';

module.exports = {
  key: 'attendance',
  label: 'Attendance',
  module: 'Attendance & Time',
  what: 'attendance rows',
  feature: 'Attendance & Time',
  // Nobody imports through /api/io for this key (caps below turns it off).
  importActions: ['configure'],
  exportVia: '/insights/attendance/export',
  sheet: 'Attendance',
  entity: 'Attendance',
  // The export's day-level columns (GET /api/insights/attendance/export), for
  // the record — the importer is the History one.
  columns: [
    { key: 'employeeCode', label: 'Employee ID', readOnly: true },
    { key: 'name', label: 'Name', readOnly: true },
    { key: 'department', label: 'Department', readOnly: true },
    { key: 'date', label: 'Date', type: 'date', readOnly: true },
    { key: 'checkIn', label: 'Check-In', readOnly: true },
    { key: 'checkOut', label: 'Check-Out', readOnly: true },
    { key: 'hours', label: 'Hours', readOnly: true },
    { key: 'status', label: 'Status', readOnly: true },
  ],
  async caps(user, base) {
    return { ...base, canImport: false, allowRequest: false, importBlockedReason: REASON };
  },
  async validate() { return []; },
  async apply() { return { created: 0, updated: 0, skipped: 0, failed: [] }; },
};
