// ---------------------------------------------------------------------------
// MONTHLY TARGETS (EmployeeRecord type TARGET) — export (everyone in scope /
// one employee) and import of targets (utils/moduleIo.js contract).
//
// Match: employee + month + goal. Same three -> the target is UPDATED
// (target / achieved / unit / description; blanks never overwrite);
// otherwise a new target is created. An import never notifies the employee
// (the Set Target screen's Send-to delivery is not run) — it records data.
// Rights: Employee Services create, the same gate POST /api/targets asks.
// ---------------------------------------------------------------------------
const io = require('../utils/moduleIo');
const kit = require('./_records-kit');

function monthOf(v) {
  const s = io.str(v);
  if (!s) return { empty: true };
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? { value: `${m[1]}-${m[2].padStart(2, '0')}` } : { error: true };
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? { value: `${m[2]}-${m[1].padStart(2, '0')}` } : { error: true };
  const d = io.parseDate(s); // a full date (or an Excel date) -> its month
  return d.value ? { value: d.value.slice(0, 7) } : { error: true };
}

module.exports = kit.recordSpec({
  key: 'targets',
  label: 'Monthly targets',
  module: 'Monthly Targets',
  what: 'monthly targets',
  sheet: 'Targets',
  type: 'TARGET',
  auditNoun: 'Target',
  keyText: 'month and goal',
  columns: [
    ...kit.EMPLOYEE_COLUMNS,
    { key: 'month', label: 'Month', required: true, example: '2026-09', note: 'YYYY-MM (a full date is read as its month).' },
    { key: 'goal', label: 'Goal', required: true, example: 'Monthly target', note: 'Same employee + month + goal as an existing target updates it.' },
    { key: 'unit', label: 'Unit', example: 'placements' },
    { key: 'target', label: 'Target', type: 'number', required: true, example: 10 },
    { key: 'achieved', label: 'Achieved', type: 'number', example: 4 },
    { key: 'description', label: 'Description', example: 'Closed positions that joined' },
    { key: 'progress', label: 'Progress %', readOnly: true, example: '' },
  ],
  instructions: [
    'An import records targets only — nobody is notified and nothing is sent.',
    'A row with the same Employee ID, Month and Goal as an existing target updates it; blank cells never overwrite.',
  ],
  fieldLabels: { date: 'Month', title: 'Goal', unit: 'Unit', amount: 'Target', achieved: 'Achieved', detail: 'Description' },
  toRow: (r) => {
    const target = Number(r.amount) || 0;
    const achieved = Number(r.achieved) || 0;
    return {
      month: r.date || '', goal: r.title || '', unit: r.unit || '', target: r.amount ?? '', achieved: r.achieved ?? '',
      description: r.detail || '', progress: target > 0 ? Math.round((achieved / target) * 100) : 0,
    };
  },
  keyOf: (x) => `${x.date || ''}|${kit.lower(x.title)}`,
  parse(r) {
    const errors = [];
    const m = monthOf(r.month);
    if (m.error) errors.push({ field: 'Month', message: `"${r.month}" is not a month (YYYY-MM).` });
    const target = kit.numberCell(r, 'target', 'Target', errors, { min: 0, max: 1e9 });
    const achieved = kit.numberCell(r, 'achieved', 'Achieved', errors, { min: 0, max: 1e9 });
    const goal = io.str(r.goal).slice(0, 200);
    return {
      errors,
      key: m.value && goal ? `${m.value}|${goal.toLowerCase()}` : null,
      label: m.value || '',
      want: {
        date: m.value || null, title: goal || null, unit: io.str(r.unit) || null, amount: target, achieved, detail: io.str(r.description) || null,
      },
    };
  },
  createDefaults: (d) => ({ achieved: d.achieved ?? 0 }),
});
