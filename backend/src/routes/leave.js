const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeWhere, employeeRecordWhere, employeeInScope, scopeDepartments, OUT_OF_SCOPE } = require('../utils/scope');
const workflow = require('../utils/approvalWorkflow');
const { withoutSystemAccounts, systemRequesterError } = require('../utils/systemAccounts');
const { can } = require('../middleware/auth');
const leaveText = require('../utils/leaveText');
const policy = require('../utils/leavePolicy');
const { pushNotification } = require('../utils/notify');
const { toXlsxBook } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// THE APPROVAL CHAIN (§15). Leave is the FIRST workflow wired to the shared
// engine in utils/approvalWorkflow.js, not a leave-shaped feature:
//
//   Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin
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
// Marker written by the PulseHRM leave import on Pending requests whose days
// the imported balance already counts as availed (see /:id/decision).
const LEAVE_PRECOUNTED = 'Leave imported — days already counted in PulseHRM availed';

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
    // The reason, the employee's comments and the half-day session come apart
    // for the list and its tooltip (utils/leaveText.js), and every row says
    // who approved / decided it — or whom it is waiting on.
    res.json(leave.map((l) => {
      const t = leaveText.parse(l.reason);
      return {
        ...l,
        reasonText: t.reasonText,
        employeeComments: t.employeeComments || null,
        halfDay: t.halfDay,
        details: t.details,
        decision: policy.decisionInfo(l, summaries[l.id] || null),
        workflow: summaries[l.id] || null,
      };
    }));
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
    const { mayAct } = await workflow.permissionFor(WF, req.user);
    // The button is drawn only for the login that owns this step. A Super
    // Admin who is not the owner gets the separate "decide directly" buttons
    // (view.canDirect). The refusal itself comes from the API — see /decision.
    const canAct = !!(current && mayAct && current.approverUserId === req.user.id);
    const view = await workflow.view(WF, request.id, req.user, { canAct });
    const text = leaveText.parse(request.reason);
    // THE TL RULE, for the login looking at it: may they approve this one?
    let tl = null;
    if (current && (canAct || !view)) {
      if (policy.actingAsTl(req.user, current)) tl = await policy.evaluateTlRule(await policy.getTlRule(), request);
    }
    // REASSIGN — the current owner (or a Super Admin) may hand it on.
    const mayReassign = !!(current && mayAct && (current.approverUserId === req.user.id || workflow.isSuperAdmin(req.user)));
    const reassignTargets = mayReassign ? await policy.reassignTargets(steps, request.employee ? request.employee.userId : null, { allowTemp: !!(request.employee && policy.isTempAccount(request.employee.name, request.employee.employeeCode)) }) : [];
    const handoffs = (await prisma.auditLog.findMany({
      where: { entity: 'LeaveRequest', entityId: request.id, action: policy.REASSIGNED },
      orderBy: { createdAt: 'asc' },
    })).map((a) => ({ from: a.fromValue, to: a.toValue, by: a.actorName, reason: a.reason, at: a.createdAt }));
    return res.json({
      leave: {
        id: request.id,
        employee: request.employee ? {
          id: request.employee.id, name: request.employee.name, code: request.employee.employeeCode,
          department: request.employee.department, team: request.employee.team, designation: request.employee.designation,
        } : null,
        type: request.type,
        fromDate: request.fromDate,
        toDate: request.toDate,
        days: request.days,
        reason: request.reason,
        reasonText: text.reasonText,
        employeeComments: text.employeeComments || null,
        halfDay: text.halfDay,
        details: text.details,
        status: request.status,
        rejectReason: request.rejectReason,
        approvalReason: request.approvalReason,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt,
        appliedAt: request.createdAt,
        decision: policy.decisionInfo(request, view ? { currentOwnerName: view.currentOwner && view.currentOwner.name, currentLabel: view.currentLabel } : null),
      },
      workflow: view,
      tl,
      reassign: { allowed: mayReassign && reassignTargets.length > 0, targets: reassignTargets },
      handoffs,
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
  const { type, fromDate, reason } = req.body;
  let { toDate } = req.body;
  // FULL DAY / HALF DAY. A half day is one date, 0.5 day, First or Second half.
  const halfDay = leaveText.HALF_DAYS.find((h) => h.toLowerCase() === String(req.body.halfDay || '').trim().toLowerCase()) || null;
  if (req.body.halfDay && !halfDay) return res.status(400).json({ error: 'Half day must be First Half or Second Half.' });
  if (halfDay) toDate = fromDate;
  let employeeId = req.body.employeeId;
  let employee;
  if (!employeeId && !req.user.caps.hrmsSelfOnly) {
    // Applying for yourself from an HR login.
    employee = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (employee) employeeId = employee.id;
  }
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
    // Applying on somebody else's behalf stays inside the caller's scope.
    if (employee.userId !== req.user.id && !employeeInScope(req.user, employee)) return res.status(403).json(OUT_OF_SCOPE);
    // Super Admin is a system account: never a requester on the chain.
    const sys = await systemRequesterError(employee, 'leave');
    if (sys) return res.status(403).json({ error: sys });
    const capError = await wouldExceedConcurrentCap(employee, fromDate, toDate);
    if (capError) return res.status(409).json({ error: capError });
  }
  if (String(toDate) < String(fromDate)) return res.status(400).json({ error: 'To date cannot be before From date.' });
  const days = halfDay ? 0.5 : (req.body.days != null ? Number(req.body.days) : daySpan(fromDate, toDate));
  if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ error: 'Days must be more than 0.' });
  if (!halfDay && days > daySpan(fromDate, toDate)) return res.status(400).json({ error: `${days} days do not fit between ${fromDate} and ${toDate}.` });

  // VALIDATION AGAINST THE BALANCE. A type with an entitlement (cap > 0) may
  // not be applied for beyond what is available (balance minus pending). HR
  // (Leave configure) may override for a deliberate exception.
  const avail = (await availabilityFor(employeeId)).find((t) => t.type === type);
  if (avail && avail.limited && days > avail.available) {
    const mayOverride = req.body.overrideBalance && await can(req.user, 'hrms', 'hrms', 'Leave & Holidays', 'configure');
    if (!mayOverride) {
      return res.status(409).json({
        error: `Not enough ${type} balance: ${avail.available} day(s) available (${avail.remaining} left, ${avail.pending} pending), ${days} requested.`,
        availability: avail,
      });
    }
  }
  const storedReason = leaveText.compose({ reason, comments: req.body.comments, details: [['Half day', halfDay]] });
  const leave = await prisma.leaveRequest.create({ data: { employeeId, type, fromDate, toDate, days, reason: storedReason } });
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
  // The approver's own remarks on an approval (required from a TL).
  const comment = String(req.body.comment || req.body.remarks || '').trim();
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

  // ---- THE TL APPROVAL RULE (HR leave settings, utils/leavePolicy.js) ------
  // A TL approving: within the configured limit (default: requests of at most
  // 2 days), and never without a reason. Past the limit the TL reassigns the
  // request to HR / their manager instead. Enforced HERE, whatever the screen.
  if (status === 'Approved' && existing.status === 'Pending' && policy.actingAsTl(req.user, pendingStep)) {
    const verdict = await policy.evaluateTlRule(await policy.getTlRule(), existing);
    if (!verdict.allowed) {
      return res.status(403).json({ error: `TL approval limit: ${verdict.note}`, reassign: true, tlRule: verdict.rule });
    }
    if (!comment && !String(approvalReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a TL approves a leave request.', tlReasonRequired: true });
    }
  }

  let chainOutcome = null;
  if (pendingStep) {
    if (status === 'Rejected' && !String(rejectReason || '').trim()) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }
    // The approval-reason rule bites where it means something: on the step
    // that actually GRANTS the leave. Asking a TL and then an STL each to pick
    // the same reason off the same list would be noise, not a control.
    // A Super Admin deciding directly (out of turn) IS the final step.
    const isDirect = workflow.isSuperAdmin(req.user) && pendingStep.approverUserId !== req.user.id;
    const isFinalStep = isDirect || !steps.some((s) => s.seq > pendingStep.seq && s.status === 'Waiting' && s.mode === workflow.MODE_REQUIRED);
    if (status === 'Approved' && isFinalStep) {
      const reasons = (await prisma.leaveReason.findMany()).filter((r) => r.active);
      if (days >= cfg.leaveReasonThresholdDays && reasons.length) {
        if (!approvalReason) return res.status(400).json({ error: `Approvals of ${cfg.leaveReasonThresholdDays} days or more need an approval reason.`, reasons: reasons.map((r) => r.label) });
        if (!reasons.some((r) => r.label === approvalReason)) return res.status(400).json({ error: 'approvalReason must be one of the configured leave approval reasons', reasons: reasons.map((r) => r.label) });
      }
    }
    const result = await workflow.act(WF, existing.id, req.user, {
      decision: status,
      note: status === 'Rejected' ? String(rejectReason).trim() : ([comment, approvalReason].filter(Boolean).join(' — ') || null),
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
      approvalReason: status === 'Approved' ? ([approvalReason, comment].filter(Boolean).join(' — ') || null) : undefined,
      rejectReason: status === 'Rejected' ? String(rejectReason).trim() : undefined,
    },
  });

  // PulseHRM's "Leaves Availed" already counted some Pending requests (Casual
  // Leave) when the export was imported, so the imported balance holds those
  // days as taken. Such a request carries a marker audit row: approving it
  // must not draw the days down again, and rejecting/cancelling it while still
  // Pending hands them back.
  const preCounted = existing.status === 'Pending' && !!await prisma.auditLog.findFirst({
    where: { entity: 'LeaveRequest', entityId: existing.id, action: LEAVE_PRECOUNTED },
    select: { id: true },
  });

  // Draw down on approval; hand the days back if an approved leave is later cancelled.
  if (status === 'Approved' && existing.status !== 'Approved') {
    await ensureBalances([existing.employeeId]);
    const balance = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: existing.employeeId, type: existing.type } } });
    if (balance && !preCounted) await prisma.leaveBalance.update({ where: { id: balance.id }, data: { taken: balance.taken + days } });
  } else if ((status === 'Rejected' || status === 'Cancelled') && preCounted) {
    const balance = await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: existing.employeeId, type: existing.type } } });
    if (balance) await prisma.leaveBalance.update({ where: { id: balance.id }, data: { taken: Math.max(0, balance.taken - days) } });
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

// ---- REASSIGN --------------------------------------------------------------
// Approve / Reject / REASSIGN. The current owner of the pending step (or a
// Super Admin) hands the request to another valid approver — one further up
// this request's own chain (the TL's STL), HR or the Super Admin — with a
// reason. The step history shows the hand-off, the audit trail records it and
// the new approver gets an in-app notification (never an email).
router.post('/:id/reassign', requirePerm(null, 'hrms', 'Leave & Holidays', 'approve'), async (req, res, next) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim();
    const toUserId = String((req.body && req.body.toUserId) || '').trim();
    if (!toUserId) return res.status(400).json({ error: 'Choose who to reassign this request to.' });
    if (!reason) return res.status(400).json({ error: 'A reason is required to reassign a leave request.' });
    const request = await prisma.leaveRequest.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!request) return res.status(404).json({ error: 'Leave request not found' });
    if (request.status !== 'Pending') return res.status(409).json({ error: `This request is ${request.status} — only a pending request can be reassigned.` });
    await safeEnsureWorkflow(request);
    const steps = await workflow.loadSteps(WF, request.id);
    const current = steps.find((s) => s.status === 'Pending');
    if (!current) return res.status(409).json({ error: 'This request is not waiting on anybody.' });
    const isOwner = current.approverUserId === req.user.id;
    if (!isOwner && !workflow.isSuperAdmin(req.user)) {
      return res.status(403).json({ error: `Only the current approver${current.approverName ? ` (${current.approverName})` : ''} can reassign this request.` });
    }
    const targets = await policy.reassignTargets(steps, request.employee ? request.employee.userId : null, { allowTemp: !!(request.employee && policy.isTempAccount(request.employee.name, request.employee.employeeCode)) });
    const target = targets.find((t) => t.userId === toUserId);
    if (!target) return res.status(400).json({ error: "That person is not a valid approver for this request (the TL's manager on its chain, HR or the Super Admin)." });
    const moved = await policy.performReassign(request.id, steps, target, req.user, reason);
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: policy.REASSIGNED, entity: 'LeaveRequest', entityId: request.id,
      fromValue: `${moved.from} (${moved.fromLevel})`, toValue: `${moved.to} (${moved.toLevel})`, reason,
    });
    await pushNotification({
      userId: target.userId,
      title: 'Leave request reassigned to you',
      message: `${request.employee ? request.employee.name : 'An employee'} · ${request.type} ${request.fromDate}${request.toDate && request.toDate !== request.fromDate ? ` – ${request.toDate}` : ''} (${request.days ?? 1} day(s)). Reassigned by ${req.user.name || req.user.email}: ${reason}`,
    });
    const view = await workflow.view(WF, request.id, req.user, { canAct: false });
    return res.json({ ok: true, reassignedTo: target.name, workflow: view });
  } catch (err) {
    return next(err);
  }
});

// ---- THE TL APPROVAL RULE (HR leave settings) ------------------------------
router.get('/tl-rule', async (req, res, next) => {
  try { res.json({ ...(await policy.getTlRule()), canConfigure: await mayConfigureTlRule(req.user) }); } catch (err) { next(err); }
});
// HR leave settings: the HR desk (HRMS role HR, with approve on Leave) or a
// login holding Leave & Holidays configure (Super Admin / Admin).
async function mayConfigureTlRule(user) {
  if (await can(user, 'hrms', 'hrms', 'Leave & Holidays', 'configure')) return true;
  const hrms = user.hrmsRole && user.hrmsRole !== 'NONE' ? user.hrmsRole : user.role;
  return hrms === 'HR' && can(user, 'hrms', 'hrms', 'Leave & Holidays', 'approve');
}
router.put('/tl-rule', async (req, res, next) => {
  try {
    if (!await mayConfigureTlRule(req.user)) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
    const before = await policy.getTlRule();
    const rule = await policy.setTlRule(req.body || {});
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Leave TL approval rule updated', entity: 'ApprovalLevelConfig', entityId: 'leave-tl-rule',
      fromValue: JSON.stringify(before), toValue: JSON.stringify(rule),
    });
    res.json(rule);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// ---- WHO THE CALLER MAY READ BALANCES FOR ---------------------------------
// Own record always; somebody else's only inside the caller's employee scope.
async function balanceSubject(req, res) {
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  const wanted = req.query.employeeId ? String(req.query.employeeId) : (own ? own.id : null);
  if (!wanted) { res.status(404).json({ error: 'No employee record linked to this account — choose an employee.' }); return null; }
  if (own && wanted === own.id) return own;
  if (req.user.caps && req.user.caps.hrmsSelfOnly) { res.status(403).json({ error: "This isn't included in your role's permissions" }); return null; }
  const target = await prisma.employee.findUnique({ where: { id: wanted } });
  if (!target) { res.status(404).json({ error: 'Employee not found' }); return null; }
  if (!employeeInScope(req.user, target)) { res.status(403).json(OUT_OF_SCOPE); return null; }
  return target;
}

// What is available to apply for right now, per active type: balance on
// record minus the days still pending (a pending day PulseHRM already counted
// as availed is not subtracted twice).
async function availabilityFor(employeeId) {
  const types = (await prisma.leaveType.findMany({ orderBy: { name: 'asc' } })).filter((t) => t.active);
  await ensureBalances([employeeId]);
  const [balances, pending] = await Promise.all([
    prisma.leaveBalance.findMany({ where: { employeeId } }),
    prisma.leaveRequest.findMany({ where: { employeeId, status: 'Pending' }, select: { id: true, type: true, days: true } }),
  ]);
  const counted = new Set((await prisma.auditLog.findMany({
    where: { action: LEAVE_PRECOUNTED, entityId: { in: pending.map((p) => p.id) } }, select: { entityId: true },
  })).map((a) => a.entityId));
  return types.map((t) => {
    const b = balances.find((x) => x.type === t.name);
    const pend = pending.filter((p) => p.type === t.name && !counted.has(p.id)).reduce((s, p) => s + Number(p.days ?? 1), 0);
    const remaining = b ? Math.max(0, b.total - b.taken) : 0;
    // Only a type with an entitlement (cap > 0, not unpaid) is held to it.
    const limited = t.unit !== 'unpaid' && Number(t.cap || 0) > 0;
    return {
      type: t.name, code: t.code, unit: t.unit, limited,
      total: b ? b.total : 0, taken: b ? b.taken : 0, remaining, pending: pend,
      available: limited ? Math.max(0, Math.round((remaining - pend) * 100) / 100) : null,
    };
  });
}

router.get('/availability', async (req, res, next) => {
  try {
    const emp = await balanceSubject(req, res);
    if (!emp) return undefined;
    return res.json({ employeeId: emp.id, name: emp.name, types: await availabilityFor(emp.id) });
  } catch (err) { return next(err); }
});

// ---- MONTH-WISE BALANCE ----------------------------------------------------
// Opening · Credited · Taken (approved, half days as 0.5) · Pending · Closing,
// month by month for one leave year (calendar year), per leave type.
async function monthlyData(employees, year) {
  const types = (await prisma.leaveType.findMany({ orderBy: { name: 'asc' } })).filter((t) => t.active);
  const ids = employees.map((e) => e.id);
  const [balances, requests] = await Promise.all([
    prisma.leaveBalance.findMany({ where: { employeeId: { in: ids } } }),
    prisma.leaveRequest.findMany({
      where: { employeeId: { in: ids }, status: { in: ['Approved', 'Pending'] }, fromDate: { lte: `${year}-12-31` }, toDate: { gte: `${year}-01-01` } },
      select: { employeeId: true, type: true, fromDate: true, toDate: true, days: true, status: true },
    }),
  ]);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  return employees.map((e) => ({
    employee: { id: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, team: e.team, designation: e.designation },
    types: policy.monthlyFor({
      year,
      types,
      balances: balances.filter((b) => b.employeeId === e.id),
      requests: requests.filter((r) => r.employeeId === e.id),
      currentYear,
      currentMonth,
    }),
  }));
}
const yearOf = (q) => {
  const y = Number(q.year);
  return Number.isInteger(y) && y > 2000 && y < 2100 ? y : new Date().getFullYear();
};

router.get('/monthly', async (req, res, next) => {
  try {
    const emp = await balanceSubject(req, res);
    if (!emp) return undefined;
    const year = yearOf(req.query);
    const [data] = await monthlyData([emp], year);
    return res.json({ year, leaveYear: `Jan – Dec ${year}`, ...data });
  } catch (err) { return next(err); }
});

// THE HR REPORT — everyone in the caller's scope, one row per employee and
// leave type, taken per month; ?format=xlsx downloads it.
router.get('/monthly-report', async (req, res, next) => {
  try {
    const year = yearOf(req.query);
    if (req.query.format === 'xlsx' && !await can(req.user, 'hrms', 'hrms', 'Leave & Holidays', 'export')) {
      return res.status(403).json({ error: "Export isn't included in your role's permissions" });
    }
    const includeRelieved = req.query.includeRelieved === '1' || req.query.includeRelieved === 'true';
    const where = withoutSystemAccounts({ ...employeeWhere(req.user), ...(includeRelieved ? {} : { employmentStatus: { not: 'Relieved' } }) });
    if (req.query.department) where.department = String(req.query.department);
    const employees = await prisma.employee.findMany({ where, orderBy: { name: 'asc' } });
    const data = await monthlyData(employees, year);
    const typeFilter = req.query.type ? String(req.query.type) : null;
    const rows = [];
    data.forEach((d) => d.types.filter((t) => !typeFilter || t.type === typeFilter).forEach((t) => rows.push({
      ...d.employee, type: t.type, creditKnown: t.creditKnown, months: t.months.map((m) => ({ month: m.month, taken: m.taken, pending: m.pending, closing: m.closing })),
      totals: t.totals, onRecord: t.onRecord,
    })));
    if (req.query.format === 'xlsx') {
      const monthKeys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
      const headers = ['Employee ID', 'Name', 'Department', 'Team', 'Designation', 'Leave type', 'Credited',
        ...monthKeys.map((k) => `Taken ${policy.monthLabel(k)}`), 'Taken (year)', 'Pending', 'Closing', 'Balance on record'];
      const body = rows.map((r) => [r.employeeCode, r.name, r.department || '', r.team || '', r.designation || '', r.type,
        r.creditKnown ? r.totals.credited : 'not on record', ...r.months.map((m) => m.taken), r.totals.taken, r.totals.pending,
        r.creditKnown ? r.totals.closing : '', r.onRecord ? r.onRecord.remaining : '']);
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Leave month-wise report exported (XLSX)', entity: 'LeaveBalance', toValue: `${year} · ${rows.length} rows` });
      await notifyDataIo(req, { kind: 'export', module: 'Leave', count: rows.length, what: 'rows of the leave month-wise report', format: 'xlsx', detail: `year ${year}` });
      res.setHeader('Content-Disposition', `attachment; filename="leave-monthly-${year}.xlsx"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(toXlsxBook([{ name: `Leave ${year}`, headers, rows: body }]));
    }
    return res.json({ year, rows });
  } catch (err) { return next(err); }
});

// ---- Balances ----
// remaining = total - taken, per active leave type. Employees see their own row.

router.get('/balances', async (req, res) => {
  try {
  const types = (await prisma.leaveType.findMany({ orderBy: { name: 'asc' } })).filter((t) => t.active);
  // ?includeRelieved=1 adds people who have left. Their balances are READ as
  // they are — nothing is created for them (ensureBalances runs only for the
  // people still here).
  const includeRelieved = req.query.includeRelieved === '1' || req.query.includeRelieved === 'true';
  const employees = await prisma.employee.findMany({
    where: withoutSystemAccounts({ ...employeeWhere(req.user), ...(includeRelieved ? {} : { employmentStatus: { not: 'Relieved' } }) }), // no leave balances for Super Admin
    orderBy: { name: 'asc' },
  });
  await ensureBalances(employees.filter((e) => e.employmentStatus !== 'Relieved').map((e) => e.id));
  const balances = await prisma.leaveBalance.findMany({ where: { employeeId: { in: employees.map((e) => e.id) } } });
  // Days still pending per employee + type (a pending day the PulseHRM import
  // already counted as availed is not shown twice).
  const pendingRows = await prisma.leaveRequest.findMany({
    where: { employeeId: { in: employees.map((e) => e.id) }, status: 'Pending' },
    select: { id: true, employeeId: true, type: true, days: true },
  });
  const counted = new Set((await prisma.auditLog.findMany({
    where: { action: LEAVE_PRECOUNTED, entityId: { in: pendingRows.map((r) => r.id) } }, select: { entityId: true },
  })).map((a) => a.entityId));
  const pendingOf = (empId, type) => pendingRows.filter((r) => r.employeeId === empId && r.type === type && !counted.has(r.id))
    .reduce((sum, r) => sum + Number(r.days ?? 1), 0);

  if (req.query.format === 'xlsx') {
    if (!await can(req.user, 'hrms', 'hrms', 'Leave & Holidays', 'export')) return res.status(403).json({ error: "Export isn't included in your role's permissions" });
    let list = employees;
    if (req.query.department) list = list.filter((e) => e.department === req.query.department);
    if (req.query.team) list = list.filter((e) => (e.team || '') === req.query.team);
    if (req.query.status) list = list.filter((e) => (e.employmentStatus || 'Active') === req.query.status);
    const headers = ['Employee ID', 'Name', 'Department', 'Team', 'Designation', 'Status',
      ...types.flatMap((t) => [`${t.code} entitled`, `${t.code} taken`, `${t.code} pending`, `${t.code} balance`])];
    const body = list.map((e) => [e.employeeCode, e.name, e.department || '', e.team || '', e.designation || '', e.employmentStatus || '',
      ...types.flatMap((t) => {
        const b = balances.find((x) => x.employeeId === e.id && x.type === t.name);
        return b ? [b.total, b.taken, pendingOf(e.id, t.name), Math.max(0, b.total - b.taken)] : ['', '', '', ''];
      })]);
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Leave balances exported (XLSX)', entity: 'LeaveBalance', toValue: `${body.length} employees` });
    res.setHeader('Content-Disposition', 'attachment; filename="leave-balances.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(toXlsxBook([{ name: 'Leave balances', headers, rows: body }]));
  }

  res.json({
    types: types.map((t) => ({ code: t.code, name: t.name, cap: t.cap, unit: t.unit, carries: t.carries })),
    rows: employees.map((e) => ({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      name: e.name,
      department: e.department,
      team: e.team,
      designation: e.designation,
      // For the Employee status filter on the balance grid.
      employmentStatus: e.employmentStatus,
      balances: types.map((t) => {
        const b = balances.find((x) => x.employeeId === e.id && x.type === t.name);
        return b
          ? { type: t.name, code: t.code, total: b.total, taken: b.taken, remaining: Math.max(0, b.total - b.taken), pending: pendingOf(e.id, t.name) }
          : { type: t.name, code: t.code, total: null, taken: null, remaining: null, pending: 0 };
      }),
    })),
  });
  } catch (err) {
    res.status(500).json({ error: 'Could not read leave balances' });
    console.error('[leave] balances', err.message);
  }
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

// ---- HOLIDAYS ----------------------------------------------------------------
// The Holiday table holds name, date (YYYY-MM-DD) and type — nothing else. The
// Add Holiday form therefore stores exactly those: a multi-day holiday becomes
// one row per day, "repeat every year" creates next year's row on save (no
// background job), and an optional holiday is type "Optional". Branch /
// applicable-to / description have no column and are NOT stored (every
// employee is Hyderabad branch; a holiday applies to everyone).
const HOLIDAY_TYPES = ['National Holiday', 'Festival', 'Optional', 'Company', 'Restricted'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s) => ISO.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nextYear = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y + 1, m - 1, d));
  // 29 Feb → 28 Feb in a non-leap year
  return t.getUTCMonth() === m - 1 ? t.toISOString().slice(0, 10) : new Date(Date.UTC(y + 1, m - 1, 28)).toISOString().slice(0, 10);
};
const dayName = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });

router.get('/holidays', async (req, res) => {
  const where = {};
  if (req.query.year && /^\d{4}$/.test(String(req.query.year))) where.date = { startsWith: String(req.query.year) };
  const holidays = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
  if (req.query.format === 'xlsx') {
    if (!await can(req.user, 'hrms', 'hrms', 'Leave & Holidays', 'export')) return res.status(403).json({ error: "Export isn't included in your role's permissions" });
    const body = holidays.map((h) => [h.date, dayName(h.date), h.name, h.type || '']);
    res.setHeader('Content-Disposition', `attachment; filename="holidays-${req.query.year || 'all'}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(toXlsxBook([{ name: `Holidays ${req.query.year || ''}`.trim(), headers: ['Date', 'Day', 'Holiday', 'Type'], rows: body }]));
  }
  return res.json(holidays.map((h) => ({ ...h, day: validIso(h.date) ? dayName(h.date) : null })));
});

router.get('/holiday-types', (req, res) => res.json(HOLIDAY_TYPES));

// Add: { name, date, toDate?, type?, optional?, repeatYearly? }
router.post('/holidays', requirePerm(null, 'hrms', 'Leave & Holidays', 'create'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const date = String(b.date || '').trim();
    const toDate = b.toDate ? String(b.toDate).trim() : date;
    if (!name) return res.status(400).json({ error: 'Holiday name is required.' });
    if (name.length > 120) return res.status(400).json({ error: 'Holiday name is too long (120 characters at most).' });
    if (!validIso(date)) return res.status(400).json({ error: 'Date is required (YYYY-MM-DD).' });
    if (!validIso(toDate) || toDate < date) return res.status(400).json({ error: 'The To date must be on or after the From date.' });
    const span = Math.round((Date.parse(toDate) - Date.parse(date)) / 86400000) + 1;
    if (span > 31) return res.status(400).json({ error: 'A multi-day holiday can cover at most 31 days.' });
    const type = b.optional ? 'Optional' : (HOLIDAY_TYPES.includes(b.type) ? b.type : 'Festival');
    const dates = Array.from({ length: span }, (_, i) => addDays(date, i));
    const wanted = dates.map((d) => ({ name, date: d, type }));
    if (b.repeatYearly) dates.forEach((d) => wanted.push({ name, date: nextYear(d), type, repeat: true }));
    // No duplicate date + name (case-insensitive).
    const existing = await prisma.holiday.findMany({ where: { date: { in: wanted.map((w) => w.date) } } });
    const clash = (w) => existing.some((h) => h.date === w.date && h.name.trim().toLowerCase() === name.toLowerCase());
    const firstClash = wanted.filter((w) => !w.repeat).find(clash);
    if (firstClash) return res.status(409).json({ error: `"${name}" is already on the calendar for ${firstClash.date}.` });
    const toCreate = wanted.filter((w) => !clash(w)); // next year's copy is skipped if it exists already
    const created = await prisma.$transaction(toCreate.map((w) => prisma.holiday.create({ data: { name: w.name, date: w.date, type: w.type } })));
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Holiday added', entity: 'Holiday', entityId: created[0].id,
      toValue: `${name} (${date}${toDate !== date ? ` to ${toDate}` : ''}, ${type}${b.repeatYearly ? ', repeats next year' : ''}) — ${created.length} row(s)`,
    });
    return res.status(201).json({ created, skipped: wanted.length - toCreate.length, ...created[0] });
  } catch (err) { return next(err); }
});

router.put('/holidays/:id', requirePerm(null, 'hrms', 'Leave & Holidays', 'edit'), async (req, res, next) => {
  try {
    const h = await prisma.holiday.findUnique({ where: { id: req.params.id } });
    if (!h) return res.status(404).json({ error: 'Holiday not found' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : h.name;
    const date = b.date !== undefined ? String(b.date).trim() : h.date;
    const type = b.optional ? 'Optional' : (b.type !== undefined ? (HOLIDAY_TYPES.includes(b.type) ? b.type : h.type) : h.type);
    if (!name) return res.status(400).json({ error: 'Holiday name is required.' });
    if (!validIso(date)) return res.status(400).json({ error: 'Date is required (YYYY-MM-DD).' });
    const dup = await prisma.holiday.findFirst({ where: { date, id: { not: h.id } } });
    if (dup && dup.name.trim().toLowerCase() === name.toLowerCase()) return res.status(409).json({ error: `"${name}" is already on the calendar for ${date}.` });
    const updated = await prisma.holiday.update({ where: { id: h.id }, data: { name, date, type } });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Holiday updated', entity: 'Holiday', entityId: h.id, fromValue: `${h.name} (${h.date}, ${h.type})`, toValue: `${name} (${date}, ${type})` });
    return res.json(updated);
  } catch (err) { return next(err); }
});

router.delete('/holidays/:id', requirePerm(null, 'hrms', 'Leave & Holidays', 'edit'), async (req, res) => {
  const holiday = await prisma.holiday.findUnique({ where: { id: req.params.id } });
  if (!holiday) return res.status(404).json({ error: 'Holiday not found' });
  await prisma.holiday.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Holiday removed', entity: 'Holiday', entityId: req.params.id, fromValue: `${holiday.name} (${holiday.date})` });
  res.json({ ok: true });
});

module.exports = router;

