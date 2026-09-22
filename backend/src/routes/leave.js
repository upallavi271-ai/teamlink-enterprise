const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeWhere, employeeRecordWhere, employeeInScope, scopeDepartments, OUT_OF_SCOPE } = require('../utils/scope');
const workflow = require('../utils/approvalWorkflow');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// THE APPROVAL CHAIN (§15). Leave is the FIRST workflow wired to the shared
// engine in utils/approvalWorkflow.js, not a leave-shaped feature:
//
//   Employee → TL → STL → Manager → Asst Manager → Admin → Super Admin
//
// The chain is resolved from the real reporting data (Employee.tl / .stl /
// .reportingManagerId, the department and team, and the configured scope
// departments of the Manager / Assistant Manager logins). Each level is
// configured as a REQUIRED approver or VISIBILITY-ONLY — see
// /leave/approval-levels below.
//
// NOTHING BELOW REPLACES THE EXISTING BEHAVIOUR. A leave still ends up
// Approved / Rejected / Cancelled on the LeaveRequest row, the balance is
// still drawn down once, and a request with no chain (anything raised before
// this shipped, until it is materialised) still decides in one step.
// ---------------------------------------------------------------------------
const WF = 'leave';

// Lay the chain down for a request that predates it, so a pending leave
// raised before this shipped still shows a workflow rather than a blank. Same
// lazy pattern as ensureBalances() — no backfill migration, and it can never
// take a request that is already decided back to Pending.
async function ensureWorkflow(request) {
  if (!request || request.status !== 'Pending') return null;
  const existing = await prisma.approvalStep.findFirst({ where: { workflow: WF, recordId: request.id }, select: { id: true } });
  if (existing) return null;
  const employee = request.employee || await prisma.employee.findUnique({ where: { id: request.employeeId } });
  if (!employee) return null;
  return workflow.start({
    workflow: WF,
    recordId: request.id,
    employee,
    applicantUserId: employee.userId || null,
    applicantName: employee.name,
  });
}

// Never let a chain problem take an existing screen down — unhandled
// rejections have exited this process before.
async function safeEnsureWorkflow(request) {
  try { await ensureWorkflow(request); } catch (err) { console.error('[leave] workflow materialise failed', err.message); }
}


// Inclusive calendar-day span of a leave request, used when the client doesn't
// send an explicit `days` (e.g. a half-day request that overrides it).
function daySpan(fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate || fromDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 1;
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

async function getConfig() {
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  return cfg;
}

// A leave type's entitlement expressed as days for the current year, so a monthly
// cap (e.g. 1 Sick Leave/month) turns into a comparable annual balance.
function annualEntitlement(type) {
  if (!type || type.unit === 'unpaid') return 0;
  return type.unit === 'month' ? Number(type.cap || 0) * 12 : Number(type.cap || 0);
}

// Balances are created lazily from the active leave types the first time an
// employee's balance is read or decremented, so adding a leave type later just
// works and no backfill migration is needed.
async function ensureBalances(employeeIds) {
  const types = (await prisma.leaveType.findMany()).filter((t) => t.active);
  if (!types.length || !employeeIds.length) return;
  const existing = await prisma.leaveBalance.findMany({ where: { employeeId: { in: employeeIds } } });
  const have = new Set(existing.map((b) => `${b.employeeId}|${b.type}`));
  const missing = [];
  employeeIds.forEach((employeeId) => {
    types.forEach((t) => {
      if (!have.has(`${employeeId}|${t.name}`)) missing.push({ employeeId, type: t.name, total: annualEntitlement(t), taken: 0 });
    });
  });
  if (missing.length) await prisma.leaveBalance.createMany({ data: missing });
}

// DEPARTMENT-SCOPED. employeeRecordWhere() already resolves the three tiers —
// global / this user's departments / themselves only — so the self-only branch
// that used to live here is gone rather than duplicated.
//
// VISIBILITY HAS TWO HALVES NOW. Department scope, unchanged — and CHAIN
// MEMBERSHIP: "everyone above in the chain can see the request". A TL named
// on a request's chain sees it even when the applicant sits in a department
// they are not scoped to; a TL from another team is on neither half and the
// request simply is not in their list. Being able to SEE it is still not
// being able to ACT on it — that is the current owner only (see /decision).
router.get('/', async (req, res, next) => {
  try {
    const scoped = employeeRecordWhere(req.user);
    const onMyChain = await workflow.recordIdsForParticipant(WF, req.user.id);
    const where = {};
    if (Object.keys(scoped).length) {
      where.OR = onMyChain.length ? [scoped, { id: { in: onMyChain } }] : [scoped];
    }
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.status) where.status = req.query.status;
    const leave = await prisma.leaveRequest.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
    // Materialise the chain for any pending request raised before this
    // shipped, then summarise. Both are best-effort: the list must render.
    await Promise.all(leave.filter((l) => l.status === 'Pending').map(safeEnsureWorkflow));
    let summaries = {};
    try {
      summaries = await workflow.summariesFor(WF, leave.map((l) => l.id));
    } catch (err) {
      console.error('[leave] workflow summaries failed', err.message);
    }
    res.json(leave.map((l) => ({ ...l, workflow: summaries[l.id] || null })));
  } catch (err) {
    next(err);
  }
});

// ---- The approval chain for ONE request -----------------------------------
// Current Owner · Current Status · Next Approver · Previous Approvers ·
// Pending Since · Due Date — plus every step with its state, which is what the
// Approval Workflow panel draws.
router.get('/:id/workflow', async (req, res, next) => {
  try {
    const request = await prisma.leaveRequest.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!request) return res.status(404).json({ error: 'Leave request not found' });
    if (!await workflow.canSee(WF, request.id, req.user, request.employee)) {
      return res.status(403).json(OUT_OF_SCOPE);
    }
    await safeEnsureWorkflow(request);
    const steps = await workflow.loadSteps(WF, request.id);
    const current = steps.find((s) => s.status === 'Pending');
    const { mayAct, override } = await workflow.permissionFor(WF, req.user);
    // The button is drawn only for the login that owns this step (or holds the
    // override). The refusal itself comes from the API — see /decision.
    const canAct = !!(current && mayAct && (current.approverUserId === req.user.id || override));
    const view = await workflow.view(WF, request.id, req.user, { canAct });
    return res.json({
      leave: {
        id: request.id,
        employee: request.employee ? { id: request.employee.id, name: request.employee.name, code: request.employee.employeeCode, department: request.employee.department, team: request.employee.team } : null,
        type: request.type,
        fromDate: request.fromDate,
        toDate: request.toDate,
        days: request.days,
        reason: request.reason,
        status: request.status,
        rejectReason: request.rejectReason,
        approvalReason: request.approvalReason,
      },
      workflow: view,
    });
  } catch (err) {
    return next(err);
  }
});

// ---- REQUIRED vs VISIBILITY-ONLY, per level -------------------------------
// "each level approval required aa / visibility-only aa separate ga define
// cheyyali". Anyone who can read the leave screen reads the policy; only a
// login the matrix grants `configure` on Leave & Holidays changes it.
router.get('/approval-levels', async (req, res, next) => {
  try {
    res.json({ workflow: WF, levels: await workflow.levelConfigList(WF) });
  } catch (err) {
    next(err);
  }
});

router.put('/approval-levels/:level', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res, next) => {
  try {
    const { mode, slaHours, active } = req.body;
    const row = await workflow.setLevelConfig(WF, req.params.level, { mode, slaHours, active });
    await logAudit({ userId: req.user.id, action: 'Leave approval level updated', entity: 'ApprovalLevelConfig', entityId: row.id, toValue: `${row.level}: ${row.mode}${row.slaHours ? ` / ${row.slaHours}h` : ''}` });
    // A policy change applies to the NEXT request. Live requests keep the
    // slaHours they were raised with, so nothing silently re-dates itself.
    res.json({ workflow: WF, levels: await workflow.levelConfigList(WF) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// Blocks a new application if too much of the employee's department would be on
// leave for the same dates at once — whichever cap (% or flat headcount) is
// stricter wins, matching the reference app's Concurrent Leave Cap policy.
async function wouldExceedConcurrentCap(employee, fromDate, toDate) {
  if (!employee.department) return null;
  const cfg = await prisma.hrConfig.findFirst();
  if (!cfg) return null;
  const deptSize = await prisma.employee.count({ where: { department: employee.department, employmentStatus: { not: 'Relieved' } } });
  if (!deptSize) return null;
  const overlapping = await prisma.leaveRequest.findMany({
    where: { status: { in: ['Approved', 'Pending'] }, fromDate: { lte: toDate }, toDate: { gte: fromDate }, employee: { department: employee.department } },
  });
  const projected = overlapping.length + 1;
  const pctCap = Math.floor((deptSize * cfg.concurrentLeaveCapPct) / 100);
  const cap = Math.min(pctCap || deptSize, cfg.concurrentLeaveCapFlat || deptSize);
  if (projected > cap) return `This would put ${projected} of ${deptSize} ${employee.department} employees on leave at once (cap: ${cap}).`;
  return null;
}

router.post('/', async (req, res, next) => {
  try {
  const { type, fromDate, toDate, reason } = req.body;
  let employeeId = req.body.employeeId;
  let employee;
  if (req.user.caps.hrmsSelfOnly) {
    employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!employee) return res.status(404).json({ error: 'No employee record linked to this account' });
    employeeId = employee.id;
  } else if (employeeId) {
    employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  }
  if (!employeeId || !type || !fromDate || !toDate) {
    return res.status(400).json({ error: 'employeeId, type, fromDate and toDate are required' });
  }
  if (employee) {
    const capError = await wouldExceedConcurrentCap(employee, fromDate, toDate);
    if (capError) return res.status(409).json({ error: capError });
  }
  const days = req.body.days != null ? Number(req.body.days) : daySpan(fromDate, toDate);
  const leave = await prisma.leaveRequest.create({ data: { employeeId, type, fromDate, toDate, days, reason } });
  await logAudit({ userId: req.user.id, action: 'Leave requested', entity: 'LeaveRequest', entityId: leave.id });

  // THE CHAIN IS LAID DOWN THE MOMENT THE REQUEST IS RAISED, so "where does
  // this sit and who has acted" has an answer from second zero. A failure
  // here must not lose the employee's application — the request exists, and
  // the chain is materialised again on the next read (ensureWorkflow above).
  let chain = null;
  try {
    if (!employee) employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (employee) {
      await workflow.start({
        workflow: WF,
        recordId: leave.id,
        employee,
        applicantUserId: employee.userId || null,
        applicantName: employee.name,
      });
      chain = workflow.summarize(await workflow.loadSteps(WF, leave.id));
    }
  } catch (err) {
    console.error('[leave] could not start the approval chain', err.message);
  }
  return res.status(201).json({ ...leave, workflow: chain });
  } catch (err) {
    return next(err);
  }
});

// Approving a request of leaveReasonThresholdDays or more requires picking one of
// the configured approval reasons; rejecting always requires free text. Approvals
// draw the days down from the employee's balance for that leave type.
router.patch('/:id/decision', requirePerm(null, 'hrms', 'Leave & Holidays', 'approve'), async (req, res, next) => {
  try {
  const { status, approvalReason, rejectReason } = req.body; // Approved | Rejected | Cancelled
  if (!['Approved', 'Rejected', 'Cancelled'].includes(status)) return res.status(400).json({ error: 'status must be Approved, Rejected or Cancelled' });
  const existing = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }, include: { employee: true },
  });
  if (!existing) return res.status(404).json({ error: 'Leave request not found' });
  // A Medical TL does not decide an IT employee's leave. Scope, or being
  // named on this request's own approval chain — an approver two levels up
  // whose department scope does not cover the applicant is still an approver.
  if (!employeeInScope(req.user, existing.employee)
    && !await workflow.isParticipant(WF, existing.id, req.user.id)) {
    return res.status(403).json(OUT_OF_SCOPE);
  }

  const cfg = await getConfig();
  const days = existing.days != null ? existing.days : daySpan(existing.fromDate, existing.toDate);

  // ---- THE CHAIN -----------------------------------------------------------
  // A request that is climbing the chain is decided ONE STEP AT A TIME.
  // APPROVING OUT OF TURN IS REFUSED HERE, BY THE API. The STL cannot approve
  // while the request sits with the TL, however the browser is persuaded to
  // send the request: workflow.act() reads the pending step and answers 403.
  //
  // Cancellation is NOT a chain step — it is HR closing a request out — so it
  // keeps the single-step path it always had.
  await safeEnsureWorkflow(existing);
  const steps = status === 'Cancelled' ? [] : await workflow.loadSteps(WF, existing.id);
  const pendingStep = steps.find((s) => s.status === 'Pending');
  let chainOutcome = null;
  if (pendingStep) {
    if (status === 'Rejected' && !String(rejectReason || '').trim()) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }
    // The approval-reason rule bites where it means something: on the step
    // that actually GRANTS the leave. Asking a TL and then an STL each to pick
    // the same reason off the same list would be noise, not a control.
    const isFinalStep = !steps.some((s) => s.seq > pendingStep.seq && s.status === 'Waiting' && s.mode === workflow.MODE_REQUIRED);
    if (status === 'Approved' && isFinalStep) {
      const reasons = (await prisma.leaveReason.findMany()).filter((r) => r.active);
      if (days >= cfg.leaveReasonThresholdDays && reasons.length) {
        if (!approvalReason) return res.status(400).json({ error: `Approvals of ${cfg.leaveReasonThresholdDays} days or more need an approval reason.`, reasons: reasons.map((r) => r.label) });
        if (!reasons.some((r) => r.label === approvalReason)) return res.status(400).json({ error: 'approvalReason must be one of the configured leave approval reasons', reasons: reasons.map((r) => r.label) });
      }
    }
    const result = await workflow.act(WF, existing.id, req.user, {
      decision: status,
      note: status === 'Rejected' ? String(rejectReason).trim() : (approvalReason || null),
    });
    if (result.error) return res.status(result.error.status).json(result.error.body);
    chainOutcome = result;

    await logAudit({
      userId: req.user.id,
      action: `Leave ${status.toLowerCase()} at ${result.level}`,
      entity: 'LeaveRequest',
      entityId: existing.id,
      fromValue: result.level,
      toValue: result.nextLevel || result.outcome,
    });

    // STILL CLIMBING — the LeaveRequest stays Pending and no balance moves.
    if (!result.complete) {
      const view = await workflow.view(WF, existing.id, req.user, { canAct: false });
      return res.json({ ...existing, status: 'Pending', workflow: view });
    }
  }

  // Either the chain just completed, or this request has no chain (a
  // cancellation, or a record raised before the workflow shipped) and decides
  // in one step exactly as it always did.
  if (status === 'Approved' && !chainOutcome) {
    const reasons = (await prisma.leaveReason.findMany()).filter((r) => r.active);
    if (days >= cfg.leaveReasonThresholdDays && reasons.length) {
      if (!approvalReason) return res.status(400).json({ error: `Approvals of ${cfg.leaveReasonThresholdDays} days or more need an approval reason.`, reasons: reasons.map((r) => r.label) });
      if (!reasons.some((r) => r.label === approvalReason)) return res.status(400).json({ error: 'approvalReason must be one of the configured leave approval reasons', reasons: reasons.map((r) => r.label) });
    }
  }
  if (status === 'Rejected' && !String(rejectReason || '').trim()) {
    return res.status(400).json({ error: 'A rejection reason is required.' });
  }

  const leave = await prisma.leaveRequest.update({
    where: { id: req.params.id },
    data: {
      status,
      decidedAt: new Date(),
      decidedBy: req.user.name || req.user.email,
      approvalReason: status === 'Approved' ? approvalReason || null : undefined,
      rejectReason: status === 'Rejected' ? String(rejectReason).trim() : undefined,
    },
  });

  // Draw down on approval; hand the days back if an approved leave is later cancelled.
  if (status === 'Approved' && existing.status !== 'Approved') {
    await ensureBalances([existing.employeeId]);
    const balance = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: existing.employeeId, type: existing.type } } });
    if (balance) await prisma.leaveBalance.update({ where: { id: balance.id }, data: { taken: balance.taken + days } });
  } else if (status === 'Cancelled' && existing.status === 'Approved') {
    const balance = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: existing.employeeId, type: existing.type } } });
    if (balance) await prisma.leaveBalance.update({ where: { id: balance.id }, data: { taken: Math.max(0, balance.taken - days) } });
  }

  await logAudit({ userId: req.user.id, action: 'Leave ' + status.toLowerCase(), entity: 'LeaveRequest', entityId: leave.id, fromValue: existing.status, toValue: status });
  let view = null;
  try { view = await workflow.view(WF, leave.id, req.user, { canAct: false }); } catch { view = null; }
  return res.json({ ...leave, workflow: view });
  } catch (err) {
    return next(err);
  }
});

// ---- Balances ----
// remaining = total - taken, per active leave type. Employees see their own row.

router.get('/balances', async (req, res) => {
  const types = (await prisma.leaveType.findMany({ orderBy: { name: 'asc' } })).filter((t) => t.active);
  const employees = await prisma.employee.findMany({
    where: { ...employeeWhere(req.user), employmentStatus: { not: 'Relieved' } },
    orderBy: { name: 'asc' },
  });
  await ensureBalances(employees.map((e) => e.id));
  const balances = await prisma.leaveBalance.findMany({ where: { employeeId: { in: employees.map((e) => e.id) } } });

  res.json({
    types: types.map((t) => ({ code: t.code, name: t.name, cap: t.cap, unit: t.unit, carries: t.carries })),
    rows: employees.map((e) => ({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      name: e.name,
      department: e.department,
      balances: types.map((t) => {
        const b = balances.find((x) => x.employeeId === e.id && x.type === t.name);
        return b
          ? { type: t.name, code: t.code, total: b.total, taken: b.taken, remaining: Math.max(0, b.total - b.taken) }
          : { type: t.name, code: t.code, total: null, taken: null, remaining: null };
      }),
    })),
  });
});

// Adjust an employee's entitlement for one leave type (e.g. an opening balance
// carried over from last year).
router.put('/balances/:employeeId', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res) => {
  const { type, total, taken } = req.body;
  if (!type) return res.status(400).json({ error: 'type is required' });
  const target = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
  if (!target) return res.status(404).json({ error: 'Employee not found' });
  if (!employeeInScope(req.user, target)) return res.status(403).json(OUT_OF_SCOPE);
  const balance = await prisma.leaveBalance.upsert({
    where: { employeeId_type: { employeeId: req.params.employeeId, type } },
    update: { total: total != null ? Number(total) : undefined, taken: taken != null ? Number(taken) : undefined },
    create: { employeeId: req.params.employeeId, type, total: Number(total) || 0, taken: Number(taken) || 0 },
  });
  await logAudit({ userId: req.user.id, action: 'Leave balance adjusted', entity: 'LeaveBalance', entityId: balance.id, toValue: `${type}: ${balance.taken}/${balance.total}` });
  res.json(balance);
});

// ---- Department-wise "who is on leave today" ----

router.get('/on-leave-today', requirePerm(null, 'hrms', 'Leave & Holidays', 'export'), async (req, res) => {
  const today = req.query.date || new Date().toISOString().slice(0, 10);
  const employees = await prisma.employee.findMany({
    where: { ...employeeWhere(req.user), employmentStatus: { not: 'Relieved' } },
  });
  // The "who is on leave today" board is DEPARTMENT-WISE, so it is also
  // department-SCOPED: a Medical TL counts Medical, not the whole company.
  const approved = await prisma.leaveRequest.findMany({
    where: {
      ...employeeRecordWhere(req.user),
      status: 'Approved', fromDate: { lte: today }, toDate: { gte: today },
    },
    include: { employee: true },
  });
  const departments = [...new Set(employees.map((e) => e.department).filter(Boolean))].sort();
  res.json({
    date: today,
    total: approved.length,
    departments: departments.map((d) => ({ department: d, onLeave: approved.filter((l) => l.employee?.department === d).length })),
    employees: approved.map((l) => ({ id: l.id, name: l.employee?.name, department: l.employee?.department, type: l.type, fromDate: l.fromDate, toDate: l.toDate })),
  });
});

// Employee requests cancellation of an already-approved leave; HR decides via /decision above.
router.patch('/:id/cancel-request', async (req, res) => {
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  const existing = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }, include: { employee: true },
  });
  if (!existing) return res.status(404).json({ error: 'Leave request not found' });
  if (req.user.caps.hrmsSelfOnly && (!own || existing.employeeId !== own.id)) {
    return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!req.user.caps.hrmsSelfOnly && !employeeInScope(req.user, existing.employee)) {
    return res.status(403).json(OUT_OF_SCOPE);
  }
  const leave = await prisma.leaveRequest.update({ where: { id: req.params.id }, data: { status: 'Cancellation Requested' } });
  await logAudit({ userId: req.user.id, action: 'Leave cancellation requested', entity: 'LeaveRequest', entityId: leave.id });
  res.json(leave);
});

// ---- Leave policy: types, reasons, holidays (configurable by Super Admin/Admin) ----


router.get('/types', async (req, res) => {
  const types = await prisma.leaveType.findMany({ orderBy: { name: 'asc' } });
  res.json(types);
});

router.post('/types', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res) => {
  const { code, name, cap, unit, carries } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  const type = await prisma.leaveType.create({ data: { code, name, cap: Number(cap) || 0, unit: unit || 'yr', carries: !!carries } });
  res.status(201).json(type);
});

router.put('/types/:id', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res) => {
  const { cap, active } = req.body;
  const type = await prisma.leaveType.update({ where: { id: req.params.id }, data: { cap: cap != null ? Number(cap) : undefined, active } });
  await logAudit({ userId: req.user.id, action: 'Leave type updated', entity: 'LeaveType', entityId: type.id });
  res.json(type);
});

router.get('/reasons', async (req, res) => {
  const reasons = await prisma.leaveReason.findMany({ orderBy: { label: 'asc' } });
  res.json(reasons);
});

router.post('/reasons', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'label is required' });
  const reason = await prisma.leaveReason.create({ data: { label } });
  res.status(201).json(reason);
});

router.put('/reasons/:id', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res) => {
  const { active } = req.body;
  const reason = await prisma.leaveReason.update({ where: { id: req.params.id }, data: { active } });
  res.json(reason);
});

router.get('/concurrency-policy', async (req, res) => {
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  res.json({
    concurrentLeaveCapPct: cfg.concurrentLeaveCapPct,
    concurrentLeaveCapFlat: cfg.concurrentLeaveCapFlat,
    leaveReasonThresholdDays: cfg.leaveReasonThresholdDays,
    // The approval escalation order, which the Leave Approval Chain panel
    // prints as its first three links.
    escalationOrder: String(cfg.escalationOrder || '').split(',').map((r) => r.trim()).filter(Boolean),
  });
});

router.put('/concurrency-policy', requirePerm(null, 'hrms', 'Leave & Holidays', 'configure'), async (req, res) => {
  const { concurrentLeaveCapPct, concurrentLeaveCapFlat, leaveReasonThresholdDays } = req.body;
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  const updated = await prisma.hrConfig.update({
    where: { id: cfg.id },
    data: {
      concurrentLeaveCapPct: concurrentLeaveCapPct != null ? Number(concurrentLeaveCapPct) : undefined,
      concurrentLeaveCapFlat: concurrentLeaveCapFlat != null ? Number(concurrentLeaveCapFlat) : undefined,
      leaveReasonThresholdDays: leaveReasonThresholdDays != null ? Number(leaveReasonThresholdDays) : undefined,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Leave concurrency policy updated', entity: 'HrConfig', entityId: updated.id });
  res.json(updated);
});

router.get('/holidays', async (req, res) => {
  const holidays = await prisma.holiday.findMany({ orderBy: { date: 'asc' } });
  res.json(holidays);
});

router.post('/holidays', requirePerm(null, 'hrms', 'Leave & Holidays', 'create'), async (req, res) => {
  const { name, date, type } = req.body;
  if (!name || !date) return res.status(400).json({ error: 'name and date are required' });
  const holiday = await prisma.holiday.create({ data: { name, date, type: type || 'Festival' } });
  await logAudit({ userId: req.user.id, action: 'Holiday added', entity: 'Holiday', entityId: holiday.id, toValue: `${name} (${date})` });
  res.status(201).json(holiday);
});

router.delete('/holidays/:id', requirePerm(null, 'hrms', 'Leave & Holidays', 'edit'), async (req, res) => {
  const holiday = await prisma.holiday.findUnique({ where: { id: req.params.id } });
  if (!holiday) return res.status(404).json({ error: 'Holiday not found' });
  await prisma.holiday.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Holiday removed', entity: 'Holiday', entityId: req.params.id, fromValue: `${holiday.name} (${holiday.date})` });
  res.json({ ok: true });
});

module.exports = router;
