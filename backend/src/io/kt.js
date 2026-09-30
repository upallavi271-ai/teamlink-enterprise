// ---------------------------------------------------------------------------
// KNOWLEDGE TRANSFER SESSIONS (EmployeeRecord type KT) — export (everyone in
// scope / one employee) and import of KT sessions already held
// (utils/moduleIo.js contract).
//
// The row's employee is the person who RECEIVED the handover (the Log KT
// Session fan-out writes one row per recipient the same way: To = that
// employee, From = the presenter). Match: employee + topic + date -> the
// session is UPDATED (presenter / status / notes; blanks never overwrite);
// otherwise created. Nobody is notified.
// The AI Weekly Ideas on the same screen are NOT importable: each idea is
// screened and scored by the AI when it is submitted — an imported idea would
// carry scores nobody computed.
// Rights: Employee Services create (a bulk write for other people).
// ---------------------------------------------------------------------------
const io = require('../utils/moduleIo');
const kit = require('./_records-kit');

const STATUSES = ['Open', 'Completed'];

module.exports = kit.recordSpec({
  key: 'kt',
  label: 'KT sessions',
  module: 'Knowledge Transfer',
  what: 'KT sessions',
  sheet: 'KT Sessions',
  type: 'KT',
  auditNoun: 'KT session',
  keyText: 'topic and date',
  columns: [
    { ...kit.EMPLOYEE_COLUMNS[0], note: 'Employee ID (or email) of the employee who RECEIVED the knowledge transfer — in your scope.' },
    kit.EMPLOYEE_COLUMNS[1],
    kit.EMPLOYEE_COLUMNS[2],
    { key: 'topic', label: 'Topic', required: true, example: 'Client onboarding handover' },
    { key: 'date', label: 'Date', type: 'date', required: true, example: '2026-08-20' },
    { key: 'presentedBy', label: 'Presented By', example: 'Ravi Kumar' },
    { key: 'status', label: 'Status', list: 'Status', example: 'Completed', note: 'Open or Completed. Blank on a new row = Open.' },
    { key: 'notes', label: 'Notes', example: 'Walked through the client SOP and contacts' },
  ],
  instructions: [
    'An import records KT sessions only — nobody is notified. AI Weekly Ideas are not imported (they are scored by the AI on submission).',
    'A row with the same Employee ID, Topic and Date as an existing session updates it; blank cells never overwrite.',
  ],
  lists: async () => ({ Status: STATUSES }),
  fieldLabels: { title: 'Topic', date: 'Date', fromName: 'Presented By', status: 'Status', detail: 'Notes' },
  toRow: (r) => ({
    topic: r.title || '', date: r.date || kit.ymd(r.createdAt), presentedBy: r.fromName || '', status: r.status || '', notes: r.detail || '',
  }),
  dateOf: (r) => r.date || kit.ymd(r.createdAt),
  keyOf: (x) => `${x.date || kit.ymd(x.createdAt)}|${kit.lower(x.title)}`,
  parse(r, e) {
    const errors = [];
    const date = kit.dateCell(r, 'date', 'Date', errors);
    const status = kit.listCell(r, 'status', 'Status', STATUSES, errors);
    const topic = io.str(r.topic).slice(0, 200);
    return {
      errors,
      key: date && topic ? `${date}|${topic.toLowerCase()}` : null,
      label: topic,
      want: {
        title: topic || null, date, fromName: io.str(r.presentedBy) || null, status, detail: io.str(r.notes) || null,
      },
      createOnly: e ? { toName: e.name } : {},
    };
  },
});
