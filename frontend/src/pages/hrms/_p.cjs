const fs = require('fs');
function patch(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { if (s.split(a).length !== 2) throw new Error(file + ' anchor ' + a.slice(0, 80)); s = s.replace(a, b); }
  fs.writeFileSync(file, s);
}
// A task that is not finished and whose date has passed is OVERDUE - shown as Overdue, counted once (not also as "In progress").
patch('Timesheet.jsx', [
  ["    { key: 'status', get: (t) => (t.overdue ? [t.status, 'Overdue'] : [t.status]) },", "    { key: 'status', get: (t) => [t.overdue ? 'Overdue' : t.status] }, // not finished + date passed = Overdue, counted once (never also as In Progress)"],
  ["    && (!pf.status || t.status === pf.status || (pf.status === 'Overdue' && t.overdue))", "    && (!pf.status || (pf.status === 'Overdue' ? t.overdue : (t.status === pf.status && !t.overdue)))"],
  ["                            <span className={`status ${statusClass(t.status)}`}>{t.status}</span>{' '}\n                            {t.overdue && <span className=\"status rejected\" title={`Due ${ddmmyyyy(t.endDate)}`}>Late</span>}{' '}",
   "                            <span className={`status ${t.overdue ? 'rejected' : statusClass(t.status)}`} title={t.overdue ? `Due ${ddmmyyyy(t.endDate)}, not finished` : undefined}>{t.overdue ? 'Overdue' : t.status}</span>{' '}"],
  ["{t.overdue && <div className=\"ts-late\">{t.daysLate} day{t.daysLate === 1 ? '' : 's'} late</div>}", "{t.overdue && <div className=\"ts-late\">{t.daysLate} day{t.daysLate === 1 ? '' : 's'} overdue</div>}"],
  ["<div className=\"l\">Late</div></div>", "<div className=\"l\">Overdue</div></div>"],
  ["<th>Still open</th><th>Late</th></tr>", "<th>Still open</th><th>Overdue</th></tr>"],
  ["<th>Waiting to be checked</th><th>Checked</th><th>Late</th>", "<th>Waiting to be checked</th><th>Checked</th><th>Overdue</th>"],
  ["status: pf.status === 'Overdue' ? '' : pf.status }}", "status: pf.status }}"],
]);
patch('TimesheetTasks.jsx', [
  ["  if (t.overdue) return { word: 'Late', tone: 'red' };", "  if (t.overdue) return { word: 'Overdue', tone: 'red' };"],
  ["  if (d < 0) return { text: `${plural(-d, 'day')} late`, tone: 'red' };", "  if (d < 0) return { text: `${plural(-d, 'day')} overdue`, tone: 'red' };"],
  ["['late', 'Late', 'red'], ['done', 'Done', 'green']", "['late', 'Overdue', 'red'], ['done', 'Done', 'green']"],
  ["const DUE_CHIPS = [['late', 'Late', 'red'],", "const DUE_CHIPS = [['late', 'Overdue', 'red'],"],
  ["    { key: 'status', get: (t) => (t.overdue ? [t.status, 'Late'] : [t.status === 'Completed'", "    { key: 'status', get: (t) => (t.overdue ? ['Overdue'] : [t.status === 'Completed'"],
  ["    && (!status || (status === 'Late' ? t.overdue : status === 'Waiting to be checked' ? (t.status === 'Completed' && t.reviewState === 'Pending Review') : t.status === status))\n    && (!due ||", "    && (!status || (status === 'Overdue' ? t.overdue : status === 'Waiting to be checked' ? (t.status === 'Completed' && t.reviewState === 'Pending Review') : (t.status === status && !t.overdue)))\n    && (!due ||"],
  ["  const summaryBase = rows.filter((t) => (!status || (status === 'Late' ? t.overdue : status === 'Waiting to be checked' ? (t.status === 'Completed' && t.reviewState === 'Pending Review') : t.status === status))", "  const summaryBase = rows.filter((t) => (!status || (status === 'Overdue' ? t.overdue : status === 'Waiting to be checked' ? (t.status === 'Completed' && t.reviewState === 'Pending Review') : (t.status === status && !t.overdue)))"],
  ["params.status = status === 'Late' ? 'Overdue' : status;", "params.status = status;"],
  ["const STATUS_ORDER = ['Late', 'Not Started',", "const STATUS_ORDER = ['Overdue', 'Not Started',"],
  ["const tone = (s) => ({ Late: 'red',", "const tone = (s) => ({ Overdue: 'red',"],
  ["data-l=\"Late\">{r.late}</td>", "data-l=\"Overdue\">{r.late}</td>"],
]);
console.log('patched');
