// ---------------------------------------------------------------------------
// The AI agent's read surface BEYOND the ATS — HRMS self-service, Accounts,
// interviews and joinings, and the employee directory.
//
// SAME RULE AS aiAgentTools.js, AND IT IS THE WHOLE POINT OF THIS FILE:
//
//   1. can(user, product, module, feature, action) — the permission engine in
//      utils/permissions.js. Nothing is read before it answers true.
//   2. The utils/scope.js where-fragment for that entity — invoiceWhere,
//      employeeWhere, applicationWhere — spread into the Prisma query, so the
//      scope is part of the WHERE clause and not a filter afterwards.
//   3. For anything that is "mine" (attendance, leave, payslips, profile) the
//      query is additionally pinned to this login's OWN employee row. These
//      tools answer a question about the signed-in person and can never be
//      steered onto somebody else's record, because they take no employee id.
//
// A NOTE ON HRMS SELF-SERVICE AND PAYROLL
// routes/payroll.js, routes/leave.js and routes/attendance.js all read their
// own-record lists behind caps.hrmsSelfOnly rather than a per-feature grant:
// every staff login sees its OWN payslip, leave and attendance, and the
// feature grants (Payroll & Compensation, and the rest) are what widen that to
// other people. The self tools below reproduce exactly that: the door is
// can(...) on the owning feature OR on HRMS self-service (Employee Services),
// and the data is pinned to self either way. That is the same rule the API
// applies, resolved through the same engine — not a second one.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { can } = require('./permissions');
const {
  scopeOf, applicationWhere, invoiceWhere, employeeWhere, CLIENT_SHARED_STAGES,
} = require('./scope');
const { stageLabel } = require('./atsVocab');
const { invoiceOutstanding, invoiceTotal, daysOverdue } = require('./accounts');
const { visibleWhere: taskVisibleWhere, assignable } = require('../routes/tasks');

const LIMIT = 25;

const DENIED = (what) => ({
  denied: true,
  message: `Refused: your role does not have permission to ${what}. Nothing was read.`,
});

const NO_EMPLOYEE = {
  notApplicable: true,
  message: 'This login has no employee record, so it has no personal HR data of its own. Say so plainly — it is not a refusal and not an error.',
};

function today() { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }

// The HRMS self-service door. Either the owning feature, or the self-service
// grant every staff login carries — both resolved by can().
async function selfServiceGate(user, feature) {
  if (!user.employeeId) return { employee: null, allowed: false, noEmployee: true };
  const [owning, selfService] = await Promise.all([
    can(user, 'hrms', 'hrms', feature, 'view'),
    can(user, 'hrms', 'hrms', 'Employee Services', 'view'),
  ]);
  return { allowed: owning || selfService, employeeId: user.employeeId };
}

// A client login only ever sees applications that were actually shared with
// them — the same two-part test routes/candidates.js runs and the one
// aiAgentTools.js applies to the ATS tools.
async function clientSharedGate(user, applications) {
  const s = scopeOf(user);
  if (s.role !== 'CLIENT' && s.atsRole !== 'CLIENT') return null;
  const shared = new Set(applications.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage)).map((a) => a.id));
  const ids = applications.map((a) => a.id);
  if (ids.length) {
    const events = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids }, toStage: { in: CLIENT_SHARED_STAGES } },
      select: { applicationId: true },
    });
    events.forEach((e) => shared.add(e.applicationId));
  }
  return shared;
}

const READ_TOOLS = [
  // --- HRMS, the signed-in person's own record -----------------------------
  {
    name: 'my_profile_status',
    description: "The signed-in user's own employee record: department, team, designation, reporting manager, employment status, and where their profile has got to (Profile Incomplete / Pending Review / Approved / Locked / Change Requested / Edit Access Granted). Use for \"is my profile approved\", \"what is my designation\", \"who is my manager\".",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(user) {
      const gate = await selfServiceGate(user, 'Employee Services');
      if (gate.noEmployee) return NO_EMPLOYEE;
      if (!gate.allowed) return DENIED('read your own employee record');
      const e = await prisma.employee.findUnique({
        where: { id: gate.employeeId },
        include: { reportingManager: { select: { name: true, designation: true } } },
      });
      if (!e) return NO_EMPLOYEE;
      return {
        employeeCode: e.employeeCode,
        name: e.name,
        department: e.department || null,
        team: e.team || null,
        designation: e.designation || null,
        location: e.location || null,
        dateOfJoining: e.dateOfJoining ? e.dateOfJoining.toISOString().slice(0, 10) : null,
        employmentStatus: e.employmentStatus,
        employeeType: e.employeeType || null,
        reportingManager: e.reportingManager ? e.reportingManager.name : null,
        // The stored value, which routes/employees.js writes back on every
        // transition — not a status re-derived here, which could drift.
        profileStatus: e.profileStage,
        profileIsLocked: !!e.isLocked,
        changesAwaitingHr: !!e.pendingChanges,
        lastHrDecision: e.reviewDecision || null,
        lastHrNote: e.reviewNote || null,
        note: 'This is the signed-in user\'s own record only.',
      };
    },
  },

  {
    name: 'my_attendance',
    description: "The signed-in user's own attendance for a month: how many days present, absent, late, half day and on leave, plus the most recent marked days. Use for \"how many days was I late\", \"my attendance this month\".",
    input_schema: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM. Defaults to the current month.' } },
      additionalProperties: false,
    },
    async run(user, input) {
      const gate = await selfServiceGate(user, 'Attendance & Time');
      if (gate.noEmployee) return NO_EMPLOYEE;
      if (!gate.allowed) return DENIED('read attendance');
      const month = /^\d{4}-\d{2}$/.test(String(input.month || '')) ? String(input.month) : thisMonth();
      const rows = await prisma.attendance.findMany({
        // Pinned to self. This tool takes no employee id and cannot be
        // pointed at anybody else.
        where: { employeeId: gate.employeeId, date: { startsWith: month } },
        orderBy: { date: 'desc' },
      });
      const counts = {};
      rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
      return {
        month,
        markedDays: rows.length,
        byStatus: counts,
        recent: rows.slice(0, 10).map((r) => ({
          date: r.date, status: r.status, checkIn: r.checkIn || null, checkOut: r.checkOut || null,
        })),
        note: 'The signed-in user\'s own attendance only.',
      };
    },
  },

  {
    name: 'my_leave',
    description: "The signed-in user's own leave: the balance remaining per leave type, and their recent leave requests with status. Use for \"how much casual leave do I have left\", \"was my leave approved\".",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(user) {
      const gate = await selfServiceGate(user, 'Leave & Holidays');
      if (gate.noEmployee) return NO_EMPLOYEE;
      if (!gate.allowed) return DENIED('read leave records');
      const [balances, requests] = await Promise.all([
        prisma.leaveBalance.findMany({ where: { employeeId: gate.employeeId } }),
        prisma.leaveRequest.findMany({
          where: { employeeId: gate.employeeId }, orderBy: { createdAt: 'desc' }, take: 10,
        }),
      ]);
      return {
        balances: balances.map((b) => ({
          type: b.type, entitlement: b.total, taken: b.taken, remaining: Math.max(0, b.total - b.taken),
        })),
        pendingCount: requests.filter((r) => r.status === 'Pending').length,
        recentRequests: requests.map((r) => ({
          type: r.type,
          from: r.fromDate,
          to: r.toDate,
          days: r.days,
          status: r.status,
          reason: r.reason || null,
          decision: r.status === 'Rejected' ? (r.rejectReason || null) : (r.approvalReason || null),
        })),
        note: 'The signed-in user\'s own leave only. Balances come from the LeaveBalance ledger, not from a calculation here.',
      };
    },
  },

  {
    name: 'my_payslips',
    description: "The signed-in user's own payslips: net pay by month, with the gross and the deductions. Use for \"what was my last net pay\", \"my salary for March\". Never quote anybody else's pay.",
    input_schema: {
      type: 'object',
      properties: { months: { type: 'integer', description: 'How many recent months, 1-12. Default 6.' } },
      additionalProperties: false,
    },
    async run(user, input) {
      const gate = await selfServiceGate(user, 'Payroll & Compensation');
      if (gate.noEmployee) return NO_EMPLOYEE;
      if (!gate.allowed) return DENIED('read payslips');
      const take = Math.min(Math.max(Number(input.months) || 6, 1), 12);
      const rows = await prisma.payslip.findMany({
        where: { employeeId: gate.employeeId }, orderBy: { month: 'desc' }, take,
      });
      return {
        count: rows.length,
        payslips: rows.map((p) => ({
          month: p.month,
          gross: p.gross,
          basic: p.basic,
          hra: p.hra,
          allowances: p.allowances,
          deductions: p.deductions,
          lopDays: p.lopDays,
          lateDays: p.lateDays,
          netPay: p.netPay,
        })),
        note: 'The signed-in user\'s own payslips only.',
      };
    },
  },

  {
    name: 'my_tasks',
    description: 'Tasks assigned to the signed-in user, and the ones they handed out, with status and dates. Use for "what tasks do I have", "what is overdue on my plate", "what did I assign to my team".',
    input_schema: {
      type: 'object',
      properties: {
        mine: { type: 'boolean', description: 'true = only tasks assigned TO the signed-in user. Default true.' },
        openOnly: { type: 'boolean', description: 'Only tasks that are not Completed or Cancelled. Default true.' },
      },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'hrms', 'hrms', 'Employee Services', 'view')) return DENIED('view tasks');
      // routes/tasks.js visibleWhere — the SAME scope the tasks list obeys,
      // built from the same assignable() set, not rebuilt here.
      const where = await taskVisibleWhere(user);
      const and = [];
      if (input.mine !== false) and.push({ assigneeId: user.id });
      if (input.openOnly !== false) and.push({ status: { notIn: ['Completed', 'Cancelled'] } });
      const rows = await prisma.task.findMany({
        where: and.length ? { AND: [where, ...and] } : where,
        orderBy: [{ endDate: 'asc' }, { createdAt: 'desc' }],
        take: LIMIT,
      });
      const now = today();
      return {
        count: rows.length,
        overdue: rows.filter((t) => t.endDate && t.endDate < now && !['Completed', 'Cancelled'].includes(t.status)).length,
        tasks: rows.map((t) => ({
          id: t.id,
          name: t.name,
          department: t.department,
          status: t.status,
          reviewState: t.reviewState,
          startDate: t.startDate,
          endDate: t.endDate,
          overdue: !!(t.endDate && t.endDate < now && !['Completed', 'Cancelled'].includes(t.status)),
          assignee: t.assigneeName,
          assignedBy: t.assignedByName,
        })),
        note: 'Scoped by routes/tasks.js visibleWhere() — the same set the Tasks screen lists.',
      };
    },
  },

  {
    name: 'my_team_directory',
    description: 'The employees the signed-in user is allowed to see — their own record, or their department/team for a lead, or everyone for an admin. Returns name, department, team, designation and the userId needed to assign a task. Use for "who is in my team", "who can I assign this to".',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name, department or designation text.' } },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'hrms', 'hrms', 'Employee Services', 'view')) return DENIED('view the employee directory');
      // utils/scope.js employeeWhere — the same fragment the employee lists
      // spread in. A user with no HR reach sees exactly one row: themselves.
      const where = { ...employeeWhere(user) };
      const and = [];
      if (input.query) {
        and.push({
          OR: [
            { name: { contains: input.query } },
            { department: { contains: input.query } },
            { designation: { contains: input.query } },
            { team: { contains: input.query } },
          ],
        });
      }
      if (and.length) where.AND = and;
      const rows = await prisma.employee.findMany({
        where,
        select: {
          id: true, userId: true, name: true, employeeCode: true, department: true,
          team: true, designation: true, employmentStatus: true, location: true,
        },
        orderBy: { name: 'asc' },
        take: LIMIT,
      });
      // Who this user may actually hand work to, so create_task never
      // proposes somebody outside that set.
      let assignableIds = null;
      try {
        const a = await assignable(user);
        assignableIds = new Set((a.people || []).map((p) => p.userId));
      } catch { assignableIds = null; }
      return {
        count: rows.length,
        employees: rows.map((e) => ({
          userId: e.userId || null,
          employeeCode: e.employeeCode,
          name: e.name,
          department: e.department || null,
          team: e.team || null,
          designation: e.designation || null,
          location: e.location || null,
          employmentStatus: e.employmentStatus,
          canAssignWorkTo: assignableIds ? assignableIds.has(e.userId) : null,
        })),
        note: 'Scoped by utils/scope.js employeeWhere() — never the whole company unless this user\'s scope is the whole company.',
      };
    },
  },

  // --- Accounts ------------------------------------------------------------
  {
    name: 'accounts_summary',
    description: 'Invoice and receivable totals the signed-in user is allowed to see: invoiced, received, outstanding, and how much of the outstanding is overdue, with an ageing split. A client login gets their own company\'s figures only. Use for "how much is outstanding", "what is overdue".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(user) {
      if (!await can(user, 'accounts', 'accounts', 'Invoices', 'view')) return DENIED('view invoices and receivables');
      // utils/scope.js invoiceWhere — an accountant sees the ledger, a client
      // sees their own company, everybody else sees nothing.
      const rows = await prisma.invoice.findMany({
        where: invoiceWhere(user), include: { client: { select: { name: true } } }, take: 2000,
      });
      let invoiced = 0;
      let received = 0;
      let outstanding = 0;
      let overdue = 0;
      const ageing = { current: 0, '1-30': 0, '31-60': 0, '60+': 0 };
      rows.forEach((inv) => {
        invoiced += invoiceTotal(inv);
        received += inv.receivedAmount || 0;
        const left = invoiceOutstanding(inv);
        if (left <= 0) return;
        outstanding += left;
        const late = daysOverdue(inv.dueDate) || 0;
        if (late > 0) {
          overdue += left;
          if (late <= 30) ageing['1-30'] += left;
          else if (late <= 60) ageing['31-60'] += left;
          else ageing['60+'] += left;
        } else {
          ageing.current += left;
        }
      });
      const round = (n) => Math.round(n * 100) / 100;
      return {
        invoiceCount: rows.length,
        invoiced: round(invoiced),
        received: round(received),
        outstanding: round(outstanding),
        overdue: round(overdue),
        ageingOfOutstanding: {
          notYetDue: round(ageing.current),
          '1-30 days': round(ageing['1-30']),
          '31-60 days': round(ageing['31-60']),
          'over 60 days': round(ageing['60+']),
        },
        note: 'Figures come from utils/accounts.js over the invoices this user can see (utils/scope.js invoiceWhere). Currency is the app\'s own; do not add a symbol you were not given.',
      };
    },
  },

  {
    name: 'search_invoices',
    description: 'Individual invoices the signed-in user is allowed to see, newest first, with amount, received, outstanding, status and how overdue they are. Filter by client name or status. A client login gets their own company\'s invoices only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Invoice number or client name text.' },
        status: { type: 'string', description: 'Pending | Partially Paid | Paid | Overdue | Cancelled.' },
        overdueOnly: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'accounts', 'accounts', 'Invoices', 'view')) return DENIED('view invoices');
      const where = { ...invoiceWhere(user) };
      const and = [];
      if (input.status) and.push({ status: String(input.status) });
      if (input.query) {
        and.push({
          OR: [
            { invoiceNumber: { contains: input.query } },
            { client: { name: { contains: input.query } } },
          ],
        });
      }
      if (and.length) where.AND = and;
      const rows = await prisma.invoice.findMany({
        where,
        include: { client: { select: { name: true } }, candidate: { select: { name: true } } },
        orderBy: { invoiceDate: 'desc' },
        take: input.overdueOnly ? 200 : LIMIT,
      });
      const shaped = rows.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber || null,
        client: inv.client ? inv.client.name : null,
        candidate: inv.candidate ? inv.candidate.name : null,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate || null,
        total: Math.round(invoiceTotal(inv) * 100) / 100,
        received: inv.receivedAmount || 0,
        outstanding: Math.round(invoiceOutstanding(inv) * 100) / 100,
        status: inv.status,
        daysOverdue: Math.max(0, daysOverdue(inv.dueDate) || 0),
      }));
      const out = input.overdueOnly ? shaped.filter((r) => r.daysOverdue > 0 && r.outstanding > 0) : shaped;
      return { count: out.length, invoices: out.slice(0, LIMIT) };
    },
  },

  // --- Interviews and joinings ---------------------------------------------
  {
    name: 'upcoming_interviews',
    description: 'Interviews already scheduled, from now forward, for the applications the signed-in user can see: who, for which requirement, when, the mode and the interviewer. Use for "what interviews are coming up", "who am I interviewing this week".',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How far ahead to look, 1-90 days. Default 14.' } },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'interviews', 'Calendar View', 'view')) return DENIED('view the interview calendar');
      const days = Math.min(Math.max(Number(input.days) || 14, 1), 90);
      const until = new Date(Date.now() + days * 86400000);
      const rows = await prisma.application.findMany({
        // utils/scope.js applicationWhere — the interview is visible exactly
        // when the application behind it is.
        where: {
          ...applicationWhere(user),
          interviewAt: { gte: new Date(), lte: until },
        },
        include: { candidate: true, requirement: { include: { client: true } } },
        orderBy: { interviewAt: 'asc' },
        take: 200,
      });
      const shared = await clientSharedGate(user, rows);
      const visible = shared ? rows.filter((a) => shared.has(a.id)) : rows;
      return {
        windowDays: days,
        count: visible.length,
        interviews: visible.slice(0, LIMIT).map((a) => ({
          applicationId: a.id,
          candidate: a.candidate ? a.candidate.name : null,
          requirement: a.requirement ? a.requirement.title : null,
          client: a.requirement && a.requirement.internal
            ? 'TeamLink (internal)'
            : (a.requirement && a.requirement.client ? a.requirement.client.name : null),
          at: a.interviewAt ? a.interviewAt.toISOString() : null,
          round: a.interviewRound,
          type: a.interviewType || null,
          mode: a.interviewMode || null,
          interviewer: a.interviewer || null,
          status: a.interviewStatus || null,
          stage: stageLabel(a.stage),
        })),
      };
    },
  },

  {
    name: 'recent_joinings',
    description: 'Candidates who have joined, or whose offer is out, on the requirements the signed-in user can see — with the offer status, the joining status and the joining date. Use for "who joined this month", "which offers are still open".',
    input_schema: {
      type: 'object',
      properties: { openOffersOnly: { type: 'boolean', description: 'Only applications with an offer out that has not been accepted or declined.' } },
      additionalProperties: false,
    },
    async run(user, input) {
      if (!await can(user, 'ats', 'interviews', 'Joining', 'view')) return DENIED('view offers and joinings');
      const rows = await prisma.application.findMany({
        where: {
          ...applicationWhere(user),
          OR: [
            { stage: { in: ['OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'] } },
            { offerStatus: { not: null } },
          ],
        },
        include: { candidate: true, requirement: { include: { client: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
      const shared = await clientSharedGate(user, rows);
      let visible = shared ? rows.filter((a) => shared.has(a.id)) : rows;
      if (input.openOffersOnly) visible = visible.filter((a) => a.offerStatus === 'Offer Released');
      return {
        count: visible.length,
        rows: visible.slice(0, LIMIT).map((a) => ({
          applicationId: a.id,
          candidate: a.candidate ? a.candidate.name : null,
          requirement: a.requirement ? a.requirement.title : null,
          client: a.requirement && a.requirement.internal
            ? 'TeamLink (internal)'
            : (a.requirement && a.requirement.client ? a.requirement.client.name : null),
          hiringType: a.hiringType || null,
          stage: stageLabel(a.stage),
          offerStatus: a.offerStatus || null,
          offerDate: a.offerDate || null,
          joiningStatus: a.joiningStatus || null,
          joiningDate: a.joiningDate || null,
          joinedAt: a.joinedAt ? a.joinedAt.toISOString().slice(0, 10) : null,
          billingStatus: a.billingStatus || null,
        })),
      };
    },
  },
];

module.exports = { READ_TOOLS };
