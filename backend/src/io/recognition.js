// ---------------------------------------------------------------------------
// REWARDS & RECOGNITION (EmployeeRecord type RECOGNITION) — import of
// recognitions / awards already given (utils/moduleIo.js contract).
//
// The screen's export is the existing /api/insights/rewards/export
// (recognitions AND nominations, everyone in scope or one employee — passed
// to the DataIoBar as exportUrl). The kit's exportRows is still here, so
// GET /api/io/recognition/export gives recognitions in the sample's own
// columns (a file that re-imports as is).
//
// Match: employee + award + date. Same three -> UPDATED (points / message /
// given by; blanks never overwrite); otherwise created. An import never
// notifies anybody (the Give Recognition Send-to delivery is not run).
// NOMINATIONS are not importable: a nomination is a live review workflow
// (Nominated -> Pending Review -> Approved/Rejected -> Awarded) with a
// reviewer and an awarder, not a record of history.
// Rights: Employee Services create, the same gate POST /api/recognition asks.
// ---------------------------------------------------------------------------
const io = require('../utils/moduleIo');
const kit = require('./_records-kit');

const AWARDS = [
  { name: 'Above & Beyond', points: 50 },
  { name: 'Team Player', points: 30 },
];
const NOMINATION_TYPES = [
  'Best Performer', 'Excellent Attendance', 'Outstanding Contribution', 'Client Appreciation',
  'Team Contribution', 'Innovation', 'Target Achievement', 'Leadership', 'Other',
];

module.exports = kit.recordSpec({
  key: 'recognition',
  label: 'Recognitions',
  module: 'Rewards & Recognition',
  what: 'recognitions',
  sheet: 'Recognitions',
  type: 'RECOGNITION',
  auditNoun: 'Recognition',
  keyText: 'award and date',
  exportVia: '/insights/rewards/export',
  columns: [
    ...kit.EMPLOYEE_COLUMNS,
    { key: 'award', label: 'Award', required: true, list: 'Award', example: 'Above & Beyond', note: 'The award / recognition type. Any text; the Lists sheet has the usual ones.' },
    { key: 'date', label: 'Date', type: 'date', required: true, example: '2026-08-14' },
    { key: 'points', label: 'Points', type: 'number', example: 50, note: 'Whole number. Blank on a new row = the award\'s usual points (Above & Beyond 50, Team Player 30), else 0.' },
    { key: 'message', label: 'Message', example: 'Closed three urgent positions in a week' },
    { key: 'givenBy', label: 'Given By', example: 'Priya (HR)', note: 'Blank on a new row = you.' },
  ],
  instructions: [
    'An import records recognitions only — nobody is notified and nothing is sent. Nominations are not imported (they are a review workflow).',
    'A row with the same Employee ID, Award and Date as an existing recognition updates it; blank cells never overwrite.',
  ],
  lists: async () => ({ Award: [...AWARDS.map((a) => a.name), ...NOMINATION_TYPES] }),
  fieldLabels: { title: 'Award', date: 'Date', points: 'Points', detail: 'Message', fromName: 'Given By' },
  toRow: (r) => ({
    award: r.title || '', date: r.date || kit.ymd(r.createdAt), points: r.points ?? '', message: r.detail || '', givenBy: r.fromName || '',
  }),
  dateOf: (r) => r.date || kit.ymd(r.createdAt),
  keyOf: (x) => `${x.date || kit.ymd(x.createdAt)}|${kit.lower(x.title)}`,
  parse(r) {
    const errors = [];
    const date = kit.dateCell(r, 'date', 'Date', errors);
    const points = kit.numberCell(r, 'points', 'Points', errors, { min: 0, max: 100000, int: true });
    const award = io.str(r.award).slice(0, 200);
    return {
      errors,
      key: date && award ? `${date}|${award.toLowerCase()}` : null,
      label: award,
      want: {
        title: award || null, date, points, detail: io.str(r.message) || null, fromName: io.str(r.givenBy) || null,
      },
    };
  },
  createDefaults: (d, ctx) => {
    const known = AWARDS.find((a) => a.name.toLowerCase() === String(d.title || '').toLowerCase());
    return {
      points: d.points ?? (known ? known.points : 0),
      fromName: d.fromName || ctx.user.name || ctx.user.email,
    };
  },
});
