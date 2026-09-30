// ---------------------------------------------------------------------------
// DISCIPLINARY ACTIONS (EmployeeRecord type DISCIPLINARY) — export (everyone
// in scope / one employee) and import of case history (utils/moduleIo.js
// contract).
//
// Match: employee + category + date -> the case is UPDATED (description /
// raised by / status; blanks never overwrite); otherwise created. An import
// only records the case: a "Termination" row does NOT change the employee's
// status, nobody is notified. Case history is never deleted by an import.
// Rights: Employee Services create, the same gate POST /api/disciplinary asks.
// ---------------------------------------------------------------------------
const io = require('../utils/moduleIo');
const kit = require('./_records-kit');

const CATEGORIES = ['Warning', 'Suspension', 'Termination', 'Other'];
const STATUSES = ['Open', 'Closed'];

module.exports = kit.recordSpec({
  key: 'disciplinary',
  label: 'Disciplinary cases',
  module: 'Disciplinary Actions',
  what: 'disciplinary cases',
  sheet: 'Disciplinary',
  type: 'DISCIPLINARY',
  auditNoun: 'Disciplinary case',
  keyText: 'category and date',
  columns: [
    ...kit.EMPLOYEE_COLUMNS,
    { key: 'category', label: 'Category', required: true, list: 'Category', example: 'Warning', note: 'Usually one of the Lists values; other text is kept as written.' },
    { key: 'date', label: 'Date', type: 'date', required: true, example: '2026-07-02' },
    { key: 'description', label: 'Description', required: true, example: 'Repeated late log-ins in June' },
    { key: 'raisedBy', label: 'Raised By', example: 'HR Team', note: 'Blank on a new row = you.' },
    { key: 'status', label: 'Status', list: 'Status', example: 'Closed', note: 'Open or Closed. Blank on a new row = Open.' },
  ],
  instructions: [
    'An import records case history only — the employee\'s status is not changed (not even for Termination) and nobody is notified.',
    'A row with the same Employee ID, Category and Date as an existing case updates it; blank cells never overwrite.',
  ],
  lists: async () => ({ Category: CATEGORIES, Status: STATUSES }),
  fieldLabels: {
    title: 'Category', category: 'Category', date: 'Date', detail: 'Description', raisedBy: 'Raised By', status: 'Status',
  },
  toRow: (r) => ({
    category: r.category || r.title || '', date: r.date || kit.ymd(r.createdAt), description: r.detail || '', raisedBy: r.raisedBy || '', status: r.status || '',
  }),
  dateOf: (r) => r.date || kit.ymd(r.createdAt),
  keyOf: (x) => `${x.date || kit.ymd(x.createdAt)}|${kit.lower(x.category || x.title)}`,
  parse(r) {
    const errors = [];
    const date = kit.dateCell(r, 'date', 'Date', errors);
    const status = kit.listCell(r, 'status', 'Status', STATUSES, errors);
    const category = io.pick(CATEGORIES, r.category) || io.str(r.category).slice(0, 100);
    return {
      errors,
      key: date && category ? `${date}|${category.toLowerCase()}` : null,
      label: category,
      want: {
        category: category || null, date, detail: io.str(r.description) || null, raisedBy: io.str(r.raisedBy) || null, status,
      },
      createOnly: { title: category },
    };
  },
  createDefaults: (d, ctx) => ({ raisedBy: d.raisedBy || ctx.user.name || ctx.user.email }),
});
