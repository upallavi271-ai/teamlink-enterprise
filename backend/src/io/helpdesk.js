// ---------------------------------------------------------------------------
// HELPDESK TICKETS (EmployeeRecord type HELPDESK) — export (everyone in scope
// / one employee) and import of ticket history (utils/moduleIo.js contract).
//
// Match: employee (who raised it) + subject + raised-on date -> the ticket is
// UPDATED (description / category / priority / status / assignee /
// resolution / resolved on / CSAT; blanks never overwrite); otherwise a new
// ticket is created with its Raised On as the creation time, so the SLA reads
// the real history. The routes/helpdesk.js rules hold: the category, priority
// and status vocabularies, a resolution note for Resolved / Closed, CSAT only
// on a resolved ticket, the assignee inside your scope. Nobody is notified.
// Internal notes are neither exported nor imported.
// Rights: Employee Services create + edit (raising for others, and moving
// status / assigning are edit-level actions on the screen).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');
const kit = require('./_records-kit');

const CATEGORIES = ['IT Support', 'HR Query', 'Facilities', 'Payroll Query', 'Other'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const CLOSED = ['Resolved', 'Closed'];
const ROUTING = {
  'IT Support': 'IT Team', 'HR Query': 'HR Team', Facilities: 'Admin Team', 'Payroll Query': 'Accounts Team', Other: 'HR Team',
};
const today = () => new Date().toISOString().slice(0, 10);

module.exports = kit.recordSpec({
  key: 'helpdesk',
  label: 'Helpdesk tickets',
  module: 'Help Desk',
  what: 'helpdesk tickets',
  sheet: 'Tickets',
  type: 'HELPDESK',
  importActions: ['create', 'edit'],
  auditNoun: 'Helpdesk ticket',
  keyText: 'subject and raised-on date',
  columns: [
    { ...kit.EMPLOYEE_COLUMNS[0], note: 'Employee ID (or email) of the employee who raised the ticket — in your scope.' },
    kit.EMPLOYEE_COLUMNS[1],
    kit.EMPLOYEE_COLUMNS[2],
    { key: 'subject', label: 'Subject', required: true, example: 'Laptop not charging' },
    { key: 'raisedOn', label: 'Raised On', type: 'date', example: '2026-08-03', note: 'Blank = today.' },
    { key: 'description', label: 'Description', example: 'Charger light stays off' },
    { key: 'category', label: 'Category', list: 'Category', example: 'IT Support', note: 'Blank on a new row = Other.' },
    { key: 'priority', label: 'Priority', list: 'Priority', example: 'High', note: 'Blank on a new row = Medium.' },
    { key: 'status', label: 'Status', list: 'Status', example: 'Resolved', note: 'Blank on a new row = Open. Resolved / Closed needs a Resolution.' },
    { key: 'assignedTo', label: 'Assigned To', example: 'TL205', note: 'Employee ID (or email) of the agent, in your scope.' },
    { key: 'resolution', label: 'Resolution', example: 'Replaced the charger' },
    { key: 'resolvedOn', label: 'Resolved On', type: 'date', example: '2026-08-04', note: 'Only for Resolved / Closed. Blank = the Raised On date.' },
    { key: 'csat', label: 'CSAT', type: 'number', example: 5, note: '1–5, only on a Resolved / Closed ticket.' },
    { key: 'routedTo', label: 'Routed To', readOnly: true, example: '' },
    { key: 'escalated', label: 'Escalated', readOnly: true, example: '' },
  ],
  instructions: [
    'An import records ticket history only — nobody is notified. Internal notes are not part of the file.',
    'A row with the same Employee ID, Subject and Raised On date as an existing ticket updates it; blank cells never overwrite.',
  ],
  lists: async () => ({ Category: CATEGORIES, Priority: PRIORITIES, Status: STATUSES }),
  fieldLabels: {
    title: 'Subject', detail: 'Description', category: 'Category', priority: 'Priority', status: 'Status',
    assignedTo: 'Assigned To', resolution: 'Resolution', resolvedAt: 'Resolved On', csat: 'CSAT',
  },
  async aux(recs) {
    const ids = [...new Set(recs.map((r) => r.assignedTo).filter(Boolean))];
    const agents = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, employeeCode: true } }) : [];
    return { codeOf: new Map(agents.map((a) => [a.id, a.employeeCode])) };
  },
  toRow: (r, aux) => ({
    subject: r.title || '', raisedOn: kit.ymd(r.createdAt), description: r.detail || '', category: r.category || '', priority: r.priority || '',
    status: r.status || '', assignedTo: r.assignedTo ? (aux.codeOf.get(r.assignedTo) || '') : '', resolution: r.resolution || '',
    resolvedOn: r.resolvedAt || '', csat: r.csat ?? '', routedTo: ROUTING[r.category] || 'HR Team', escalated: r.escalated ? 'Yes' : 'No',
  }),
  dateOf: (r) => kit.ymd(r.createdAt),
  keyOf: (x) => `${kit.ymd(x.createdAt)}|${kit.lower(x.title)}`,
  parse(r, e, ctx) {
    const errors = [];
    const raisedOn = kit.dateCell(r, 'raisedOn', 'Raised On', errors) || today();
    if (raisedOn > today()) errors.push({ field: 'Raised On', message: 'Raised On cannot be in the future.' });
    const category = kit.listCell(r, 'category', 'Category', CATEGORIES, errors);
    const priority = kit.listCell(r, 'priority', 'Priority', PRIORITIES, errors);
    const status = kit.listCell(r, 'status', 'Status', STATUSES, errors);
    let resolvedAt = kit.dateCell(r, 'resolvedOn', 'Resolved On', errors);
    const csat = kit.numberCell(r, 'csat', 'CSAT', errors, { min: 1, max: 5, int: true });
    const resolution = io.str(r.resolution) || null;
    let assignedTo = null;
    if (io.str(r.assignedTo)) {
      const a = ctx.employees.resolve(r.assignedTo);
      if (a.error) errors.push({ field: 'Assigned To', message: a.error });
      else assignedTo = a.employee.id;
    }
    // The route's rules, for the status the row states (an update that leaves
    // Status blank keeps the ticket's own — checked again against it below).
    if (status && CLOSED.includes(status) && !resolution) {
      errors.push({ field: 'Resolution', message: 'A resolution note is required for a Resolved or Closed ticket.' });
    }
    if (!status && (resolvedAt || csat !== null || resolution)) {
      errors.push({ field: 'Status', message: 'Say the Status (Resolved or Closed) when giving a resolution, Resolved On or CSAT.' });
    }
    if (resolvedAt && resolvedAt < raisedOn) errors.push({ field: 'Resolved On', message: 'Resolved On is before Raised On.' });
    const closing = status && CLOSED.includes(status);
    const subject = io.str(r.subject).slice(0, 200);
    return {
      errors,
      key: subject ? `${raisedOn}|${subject.toLowerCase()}` : null,
      label: subject,
      want: {
        title: subject || null, detail: io.str(r.description) || null, category, priority, status, assignedTo, resolution, resolvedAt, csat,
      },
      // CSAT / Resolved On are only SET on a Resolved / Closed ticket. A
      // reopened ticket may still carry its old rating (the route keeps it),
      // so a row repeating what is on file is not an error — a change is.
      checkAgainst(match) {
        if (!status || CLOSED.includes(status)) return [];
        const bad = [];
        if (csat !== null && !(match && match.csat === csat)) bad.push({ field: 'CSAT', message: 'CSAT is only given on a Resolved or Closed ticket.' });
        if (resolvedAt && !(match && match.resolvedAt === resolvedAt)) bad.push({ field: 'Resolved On', message: 'Resolved On is only for a Resolved or Closed ticket.' });
        return bad;
      },
      // A new closed ticket with no Resolved On is dated its Raised On.
      createOnly: { createdAt: new Date(`${raisedOn}T09:00:00`), notes: '[]', ...(closing && !resolvedAt ? { resolvedAt: raisedOn } : {}) },
      // An update moving the status: closing dates it (the Raised On, when no
      // Resolved On is given); reopening clears the old resolution, exactly
      // as PATCH /api/helpdesk/:id/status does.
      extraChanges(match, set, changes) {
        if (!set.status) return;
        if (CLOSED.includes(set.status) && !match.resolvedAt && !set.resolvedAt) {
          set.resolvedAt = raisedOn; changes.push({ field: 'Resolved On', from: '', to: raisedOn });
        }
        if (!CLOSED.includes(set.status)) {
          if (match.resolution) { set.resolution = null; changes.push({ field: 'Resolution', from: match.resolution, to: '' }); }
          if (match.resolvedAt) { set.resolvedAt = null; changes.push({ field: 'Resolved On', from: match.resolvedAt, to: '' }); }
        }
      },
    };
  },
  createDefaults: (d) => ({
    category: d.category || 'Other', priority: d.priority || 'Medium', status: d.status || 'Open',
  }),
});
