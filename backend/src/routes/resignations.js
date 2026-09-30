const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const chain = require('../utils/chainRoute');
const workflow = require('../utils/approvalWorkflow');
const { systemRequesterError } = require('../utils/systemAccounts');
const { CONSULTANT } = require('../utils/agreement');

const router = express.Router();
router.use(requireAuth);


// ---------------------------------------------------------------------------
// RESIGNATION (spec item 7) — a full form that climbs the approval chain.
//
//   Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin
//
// 1. SUBMITTED: the form is stored (ResignationDetail) with the employee-info
//    block snapshotted, the submission date and time recorded, and the
//    resignation record sits at "Pending Approval". The employee is NOT on
//    notice yet — that is what is being approved.
// 2. EACH LEVEL approves or rejects in turn (utils/approvalWorkflow.js). A
//    Super Admin may approve or reject DIRECTLY from any step.
// 3. FINAL APPROVAL puts the employee on Notice Period with the APPROVED last
//    working date and opens the existing offboarding tracker (the same
//    checklist Employee Management → Offboarding uses).
//    A REJECTION ends it; the employee stays as they were.
// 4. Relieved (the administrative close-out after notice) and Withdrawn (the
//    employee taking it back) stay single-step, as they always were.
// ---------------------------------------------------------------------------
const WF_RES = 'resignation';

const PENDING = 'Pending Approval';
// 'Accepted' is the pre-chain word for an accepted resignation; kept so old
// records still read correctly.
const STATUSES = [PENDING, 'Notice Period', 'Accepted', 'Rejected', 'Relieved', 'Withdrawn'];
const SERVING = ['Notice Period', 'Accepted'];
const TERMINAL = ['Relieved', 'Withdrawn', 'Rejected'];
const OPEN = [PENDING, ...SERVING];
// What /:id/status accepts. Accepted / Approved = approve at the current step.
const DECISIONS = ['Accepted', 'Approved', 'Rejected', 'Relieved', 'Withdrawn'];

// The same checklist drives the offboarding tracker on each employee's record.
const EXIT_CHECKLIST = [
  'Exit interview scheduled',
  'Assets returned',
  'Access revoked',
  'Full & final settlement processed',
  'Experience letter issued',
];

// The Reason select. HR may replace the list (PUT /form-config); "Other" is
// always offered and always asks for the reason in words.
const DEFAULT_REASONS = [
  'Better career opportunity',
  'Higher studies',
  'Personal / family reasons',
  'Health reasons',
  'Relocation',
  'Compensation',
  'Work environment',
  'Career change',
];
const OTHER = 'Other';

// The optional, CONFIGURED fields. Each can be switched off on the form.
const OPTIONAL_FIELDS = [
  { key: 'noticePeriod', label: 'Notice Period' },
  { key: 'handover', label: 'Handover Details' },
  { key: 'knowledgeTransfer', label: 'Knowledge Transfer Details' },
  { key: 'exitComments', label: 'Exit Comments' },
];

const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max = 4000) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};

async function hrConfig() {
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  return cfg;
}

function parseList(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : null;
  } catch {
    return null;
  }
}

async function formConfig() {
  const cfg = await hrConfig();
  const reasons = (parseList(cfg.resignationReasons) || DEFAULT_REASONS).filter((r) => r !== OTHER);
  const enabled = parseList(cfg.resignationOptionalFields) || OPTIONAL_FIELDS.map((f) => f.key);
  return {
    noticePeriodDays: cfg.noticePeriodDays,
    reasons: [...reasons, OTHER],
    optionalFields: OPTIONAL_FIELDS.map((f) => ({ ...f, enabled: enabled.includes(f.key) })),
  };
}

// Last working day = a date plus N calendar days (weekends and holidays are
// not excluded).
function noticeEnd(fromDate, days) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Calendar days still to serve; negative once the last working day has passed.
function daysLeft(lastWorkingDate) {
  const lwd = new Date(lastWorkingDate);
  if (Number.isNaN(lwd.getTime())) return null;
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.ceil((lwd - today) / DAY_MS);
}

// The employee-info block of the form, read from the employee record.
async function employeeInfo(employee) {
  let reportingManager = null;
  if (employee.reportingManagerId) {
    const m = await prisma.employee.findUnique({ where: { id: employee.reportingManagerId }, select: { name: true } });
    reportingManager = m ? m.name : null;
  }
  return {
    id: employee.id,
    employeeCode: employee.employeeCode || null,
    name: employee.name,
    department: employee.department || null,
    designation: employee.designation || null,
    reportingManager: reportingManager || employee.tl || employee.stl || null,
    employmentStatus: employee.employmentStatus || null,
    // The Letter of Resignation's "Client Location": the office the
    // employee works from.
    location: employee.branch || employee.location || null,
  };
}

// ---- THE LETTER OF RESIGNATION (LOR) ----------------------------------------
// The letter layout (pages/hrms/Resignation.jsx) prints the company's legal
// name as "Client Name": Company setup's Legal Name, else the consultant name
// the agreements print, else the display name.
async function companyLegalName() {
  const co = await prisma.company.findFirst({ select: { name: true, legalName: true } });
  return (co && String(co.legalName || '').trim()) || CONSULTANT || (co && co.name) || null;
}

// "Resignation Submitting To": the people the resignation's chain would reach,
// in ladder order, from the level above the employee's own (the same rule
// approvalWorkflow.start() applies). The reporting manager comes first when
// they are on it. The choice is RECORDED on the letter; it does not re-route
// the chain, which still climbs every configured level.
async function submitTargets(employee) {
  const people = await workflow.resolveChain(employee);
  const applicantUser = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId } }) : null;
  const role = applicantUser ? ((applicantUser.hrmsRole && applicantUser.hrmsRole !== 'NONE') ? applicantUser.hrmsRole : applicantUser.role) : null;
  const own = role ? workflow.LEVEL_BY_ID[role] : null;
  const startAbove = own && !own.applicant ? own.seq : 1;
  const seen = new Set();
  const out = [];
  workflow.APPROVAL_LEVELS.forEach((l) => {
    const p = people[l.level];
    if (l.seq <= startAbove || !p || !p.user || seen.has(p.user.id)) return;
    seen.add(p.user.id);
    out.push({ userId: p.user.id, name: p.name, level: l.level, label: l.label });
  });
  let reportingManagerId = null;
  if (employee.reportingManagerId) {
    const m = await prisma.employee.findUnique({ where: { id: employee.reportingManagerId }, select: { userId: true, name: true } });
    if (m && m.userId) {
      reportingManagerId = m.userId;
      if (!seen.has(m.userId) && m.userId !== employee.userId) out.unshift({ userId: m.userId, name: m.name, level: 'REPORTING_MANAGER', label: 'Reporting Manager' });
    }
  }
  const first = out.find((o) => o.userId === reportingManagerId)
    || out.find((o) => o.name && [employee.tl, employee.stl].filter(Boolean).map((n) => n.toLowerCase()).includes(o.name.toLowerCase()))
    || out[0] || null;
  return { approvers: out, defaultApproverUserId: first ? first.userId : null };
}

// What the employee picked as "Resignation Submitting To", read back from the
// submission's own audit row (no schema change needed).
const SUBMIT_TO_PREFIX = 'Resignation Submitting To: ';
async function submittingToOf(recordId) {
  const row = await prisma.auditLog.findFirst({
    where: { entity: 'EmployeeRecord', entityId: recordId, action: 'Resignation submitted', reason: { startsWith: SUBMIT_TO_PREFIX } },
    select: { reason: true },
    orderBy: { createdAt: 'asc' },
  });
  return row ? row.reason.slice(SUBMIT_TO_PREFIX.length) : null;
}

// HISTORY RECORDS (scripts/import-resignation-history.js, the Resignation
// import): filed by no one in TeamLink, marked by who "submitted" them.
const IMPORTED_RE = /^Imported from/i;

function present(record, days, detail) {
  const d = detail || null;
  const lwd = record.date || (d && (d.approvedLastWorkingDate || d.requestedLastWorkingDate)) || null;
  const imported = !!(d && IMPORTED_RE.test(d.submittedByName || ''));
  return {
    ...record,
    // DATE-WISE: the dates the Resignation list sorts, filters and totals by.
    source: imported ? 'Imported' : 'TeamLink',
    type: record.category || null,
    resignationDate: (d && d.resignationDate) || null,
    relievingDate: record.status === 'Relieved' ? lwd : null,
    reason: d ? (d.reason === OTHER && d.reasonOther ? `${OTHER}: ${d.reasonOther}` : d.reason) : record.title,
    notes: record.detail,
    lastWorkingDate: lwd,
    daysLeft: lwd && SERVING.includes(record.status) ? daysLeft(lwd) : null,
    noticePeriodDays: d && d.noticePeriodDays != null ? d.noticePeriodDays : days,
    submittedAt: d ? d.submittedAt : record.createdAt,
    submittedBy: d ? d.submittedByName : null,
    form: d,
  };
}

async function detailsFor(ids) {
  if (!ids.length) return {};
  const rows = await prisma.resignationDetail.findMany({ where: { recordId: { in: ids } } });
  return Object.fromEntries(rows.map((r) => [r.recordId, r]));
}

// FINAL APPROVAL — the same effect whether the last level approved in turn,
// a Super Admin approved directly, or nobody sat above the requester.
async function applyApproval(record, user, { lastWorkingDate } = {}) {
  const detail = await prisma.resignationDetail.findUnique({ where: { recordId: record.id } });
  const days = (detail && detail.noticePeriodDays != null) ? detail.noticePeriodDays : (await hrConfig()).noticePeriodDays;
  const lwd = (lastWorkingDate && ISO_DATE.test(lastWorkingDate) && lastWorkingDate)
    || (detail && detail.requestedLastWorkingDate)
    || record.date
    || noticeEnd((detail && detail.resignationDate) || new Date().toISOString().slice(0, 10), days);
  const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: { status: 'Notice Period', date: lwd } });
  if (detail) await prisma.resignationDetail.update({ where: { id: detail.id }, data: { approvedLastWorkingDate: lwd } });
  // INTO THE EXISTING OFFBOARDING: the employee's tracker opens with the
  // standard checklist unless one is already running.
  const employee = await prisma.employee.findUnique({ where: { id: record.employeeId } });
  await prisma.employee.update({
    where: { id: record.employeeId },
    data: {
      employmentStatus: 'Notice Period',
      offboardingStatus: 'Serving Notice',
      offboardingTasks: employee && employee.offboardingTasks
        ? undefined
        : JSON.stringify(EXIT_CHECKLIST.map((task) => ({ task, completed: false }))),
    },
  });
  await logAudit({
    userId: user.id,
    action: 'Resignation approved — employee on notice',
    entity: 'EmployeeRecord',
    entityId: record.id,
    fromValue: employee ? employee.employmentStatus : null,
    toValue: `Notice Period (last working day ${lwd})`,
  });
  return updated;
}

async function applyRejection(record, user, reason) {
  const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: { status: 'Rejected' } });
  // A resignation recorded before the chain shipped put the employee on
  // notice at submission; a rejection of one of those puts them back.
  if (SERVING.includes(record.status)) {
    await prisma.employee.update({ where: { id: record.employeeId }, data: { employmentStatus: 'Active', offboardingStatus: null } });
  }
  await logAudit({ userId: user.id, action: 'Resignation rejected', entity: 'EmployeeRecord', entityId: record.id, fromValue: record.status, toValue: 'Rejected', reason: reason || undefined });
  return updated;
}

// Close any chain step still open, so it drops out of every approver's queue.
async function closeChain(recordId, note) {
  await prisma.approvalStep.updateMany({
    where: { workflow: WF_RES, recordId, status: { in: [workflow.STEP_STATUS.PENDING, workflow.STEP_STATUS.WAITING] } },
    data: { status: workflow.STEP_STATUS.SKIPPED, note },
  });
}

// Who may file a resignation FOR this employee: themselves, or an in-scope
// login that decides / creates Employee Services records.
async function mayFileFor(user, employee) {
  if (employee.id === user.employeeId) return { ok: true };
  if (user.caps && user.caps.hrmsSelfOnly) return { ok: false, status: 403, body: { error: 'You can only submit your own resignation.' } };
  if (!employeeInScope(user, employee)) return { ok: false, status: 403, body: OUT_OF_SCOPE };
  const may = await can(user, 'hrms', 'hrms', 'Employee Services', 'approve')
    || await can(user, 'hrms', 'hrms', 'Employee Services', 'create');
  if (!may) return { ok: false, status: 403, body: { error: "This isn't included in your role's permissions" } };
  return { ok: true };
}

// ---- LIST ------------------------------------------------------------------
// Scope, OR being named on the resignation's own chain (the same two halves
// leave uses): an approver whose department scope does not cover the
// employee still sees the request they have to decide.
router.get('/', async (req, res, next) => {
  try {
    const scoped = employeeRecordWhere(req.user);
    const onMyChain = await workflow.recordIdsForParticipant(WF_RES, req.user.id);
    const where = { type: 'RESIGNATION' };
    if (Object.keys(scoped).length) {
      where.OR = onMyChain.length ? [scoped, { id: { in: onMyChain } }] : [scoped];
    }
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.status) where.status = req.query.status;
    const [records, cfg] = await Promise.all([
      prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
      hrConfig(),
    ]);
    const details = await detailsFor(records.map((r) => r.id));
    // Each row carries its chain summary, so the list says WHO IT IS WAITING ON.
    res.json(await chain.decorate(WF_RES, records.map((r) => present(r, cfg.noticePeriodDays, details[r.id]))));
  } catch (err) {
    next(err);
  }
});

// Summary for the Resignation screen.
router.get('/summary', requirePerm(null, 'hrms', 'Employee Services', 'export'), async (req, res) => {
  const [records, cfg] = await Promise.all([
    prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION', ...employeeRecordWhere(req.user) } }),
    hrConfig(),
  ]);
  res.json({
    pendingApproval: records.filter((r) => r.status === PENDING).length,
    servingNotice: records.filter((r) => SERVING.includes(r.status)).length,
    relieved: records.filter((r) => r.status === 'Relieved').length,
    rejected: records.filter((r) => r.status === 'Rejected').length,
    withdrawn: records.filter((r) => r.status === 'Withdrawn').length,
    // DATE-WISE: relieved people per relieving month (YYYY-MM; "No date" when
    // the history did not carry one).
    relievedByMonth: records.filter((r) => r.status === 'Relieved').reduce((o, r) => {
      const m = r.date ? String(r.date).slice(0, 7) : 'No date';
      return { ...o, [m]: (o[m] || 0) + 1 };
    }, {}),
    noticePeriodDays: cfg.noticePeriodDays,
    exitChecklist: EXIT_CHECKLIST,
  });
});

// ---- THE FORM --------------------------------------------------------------
// Everything the form needs before it is filled: the employee-info block
// (auto-filled from the record), the reasons, which optional fields are on,
// and the default notice period.
router.get('/form', async (req, res, next) => {
  try {
    const employeeId = req.query.employeeId || req.user.employeeId;
    const cfg = await formConfig();
    const companyName = await companyLegalName();
    const today = new Date().toISOString().slice(0, 10);
    if (!employeeId) return res.json({ employee: null, ...cfg, statuses: STATUSES, companyName, today, approvers: [], defaultApproverUserId: null });
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const allowed = await mayFileFor(req.user, employee);
    if (!allowed.ok) return res.status(allowed.status).json(allowed.body);
    const open = await prisma.employeeRecord.findFirst({ where: { type: 'RESIGNATION', employeeId, status: { in: OPEN } }, select: { id: true, status: true } });
    const targets = await submitTargets(employee);
    return res.json({
      employee: await employeeInfo(employee), ...cfg, statuses: STATUSES, openResignation: open || null,
      companyName, today, ...targets,
    });
  } catch (err) {
    return next(err);
  }
});

router.put('/form-config', requirePerm(null, 'hrms', 'Employee Services', 'configure'), async (req, res, next) => {
  try {
    const cfg = await hrConfig();
    const data = {};
    if (Array.isArray(req.body.reasons)) {
      const reasons = [...new Set(req.body.reasons.map((r) => String(r).trim().slice(0, 120)).filter((r) => r && r !== OTHER))];
      if (!reasons.length) return res.status(400).json({ error: 'Keep at least one reason (Other is always offered too).' });
      data.resignationReasons = JSON.stringify(reasons);
    }
    if (Array.isArray(req.body.optionalFields)) {
      const keys = OPTIONAL_FIELDS.map((f) => f.key);
      data.resignationOptionalFields = JSON.stringify(req.body.optionalFields.filter((k) => keys.includes(k)));
    }
    await prisma.hrConfig.update({ where: { id: cfg.id }, data });
    await logAudit({ userId: req.user.id, action: 'Resignation form settings updated', entity: 'HrConfig', entityId: cfg.id });
    return res.json(await formConfig());
  } catch (err) {
    return next(err);
  }
});

// ---- SUBMIT ----------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    let employeeId = b.employeeId;
    // A self-service login always files its own; anyone who names nobody
    // files their own too.
    if ((req.user.caps && req.user.caps.hrmsSelfOnly) || !employeeId) {
      const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
      if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
      employeeId = own.id;
    }
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const allowed = await mayFileFor(req.user, employee);
    if (!allowed.ok) return res.status(allowed.status).json(allowed.body);
    // Super Admin is a system account: never a requester on the chain.
    { const sys = await systemRequesterError(employee, 'a resignation'); if (sys) return res.status(403).json({ error: sys }); }

    const open = await prisma.employeeRecord.findFirst({ where: { type: 'RESIGNATION', employeeId, status: { in: OPEN } } });
    if (open) return res.status(409).json({ error: `${employee.name} already has a resignation that is ${open.status.toLowerCase()}.` });

    const cfg = await formConfig();
    const on = Object.fromEntries(cfg.optionalFields.map((f) => [f.key, f.enabled]));
    const today = new Date().toISOString().slice(0, 10);

    const resignationDate = clean(b.resignationDate, 10) || today;
    if (!ISO_DATE.test(resignationDate)) return res.status(400).json({ error: 'Resignation Date must be a date (YYYY-MM-DD).' });

    // REASON: one of the configured reasons, or Other with the reason in
    // words. `title` is the pre-form field name, still accepted.
    let reason = clean(b.reason, 120);
    let reasonOther = clean(b.reasonOther, 500);
    if (!reason && b.title && b.title !== 'Resignation') { reason = OTHER; reasonOther = reasonOther || clean(b.title, 500); }
    if (!reason) return res.status(400).json({ error: 'Reason is required.' });
    if (!cfg.reasons.includes(reason)) { reasonOther = reasonOther || reason; reason = OTHER; }
    if (reason === OTHER && !reasonOther) return res.status(400).json({ error: 'Say what the reason is when you pick "Other".' });

    let noticePeriodDays = cfg.noticePeriodDays;
    if (on.noticePeriod && b.noticePeriodDays !== undefined && b.noticePeriodDays !== null && b.noticePeriodDays !== '') {
      const n = Number(b.noticePeriodDays);
      if (!Number.isInteger(n) || n < 0 || n > 365) return res.status(400).json({ error: 'Notice Period must be a whole number of days between 0 and 365.' });
      noticePeriodDays = n;
    }

    // Requested Last Working Date: what the form says, or (the old HR field)
    // `date`, or the resignation date plus the notice period.
    const requestedLastWorkingDate = clean(b.requestedLastWorkingDate, 10) || clean(b.date, 10) || noticeEnd(resignationDate, noticePeriodDays);
    if (!ISO_DATE.test(requestedLastWorkingDate)) return res.status(400).json({ error: 'Requested Last Working Date must be a date (YYYY-MM-DD).' });
    if (requestedLastWorkingDate < resignationDate) return res.status(400).json({ error: 'Requested Last Working Date cannot be before the Resignation Date.' });

    // "Resignation Submitting To" (the letter's addressee). Optional for older
    // callers; when given it must be one of the people the chain reaches.
    let submittingTo = null;
    if (b.submittingToUserId) {
      const { approvers } = await submitTargets(employee);
      const hit = approvers.find((a) => a.userId === b.submittingToUserId);
      if (!hit) return res.status(400).json({ error: 'Pick who the resignation is submitted to from the list.' });
      submittingTo = `${hit.name} (${hit.label})`;
    }

    const comments = clean(b.comments) || clean(b.detail);
    const info = await employeeInfo(employee);
    const submitterName = req.user.name || req.user.email;

    const record = await prisma.employeeRecord.create({
      data: {
        type: 'RESIGNATION',
        employeeId,
        title: reason === OTHER ? `${OTHER}: ${reasonOther}`.slice(0, 200) : reason,
        detail: comments,
        date: requestedLastWorkingDate,
        status: PENDING,
      },
    });
    const detail = await prisma.resignationDetail.create({
      data: {
        recordId: record.id,
        employeeId,
        employeeCode: info.employeeCode,
        employeeName: info.name,
        department: info.department,
        designation: info.designation,
        reportingManager: info.reportingManager,
        resignationDate,
        requestedLastWorkingDate,
        reason,
        reasonOther: reason === OTHER ? reasonOther : null,
        comments,
        noticePeriodDays,
        handoverDetails: on.handover ? clean(b.handoverDetails) : null,
        knowledgeTransferDetails: on.knowledgeTransfer ? clean(b.knowledgeTransferDetails) : null,
        exitComments: on.exitComments ? clean(b.exitComments) : null,
        submittedByUserId: req.user.id,
        submittedByName: submitterName,
      },
    });
    await logAudit({
      userId: req.user.id, action: 'Resignation submitted', entity: 'EmployeeRecord', entityId: record.id, fromValue: employee.employmentStatus, toValue: PENDING,
      reason: submittingTo ? `${SUBMIT_TO_PREFIX}${submittingTo}` : undefined,
    });

    // The chain goes down with the resignation. If nobody sits above the
    // person it is about (a Super Admin's own), it is approved at once.
    const started = await chain.raise(WF_RES, { recordId: record.id, employee });
    let saved = record;
    if (!started.pending) saved = await applyApproval(record, req.user);
    return res.status(201).json({ ...present(saved, cfg.noticePeriodDays, detail), workflow: started.summary, submittingTo });
  } catch (err) {
    return next(err);
  }
});

// ---- ONE RESIGNATION, with its form and full approval history ---------------
router.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.employeeRecord.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!record || record.type !== 'RESIGNATION') return res.status(404).json({ error: 'Resignation not found' });
    if (!await workflow.canSee(WF_RES, record.id, req.user, record.employee)) return res.status(403).json(OUT_OF_SCOPE);
    const [detail, cfg] = await Promise.all([
      prisma.resignationDetail.findUnique({ where: { recordId: record.id } }),
      hrConfig(),
    ]);
    const steps = await workflow.loadSteps(WF_RES, record.id);
    const current = steps.find((s) => s.status === workflow.STEP_STATUS.PENDING);
    const { mayAct } = await workflow.permissionFor(WF_RES, req.user);
    const canAct = !!(current && mayAct && current.approverUserId === req.user.id);
    const view = steps.length ? await workflow.view(WF_RES, record.id, req.user, { canAct }) : null;
    if (view && view.canDirect && !mayAct) view.canDirect = false;
    const location = record.employee ? (record.employee.branch || record.employee.location || null) : null;
    return res.json({
      ...present(record, cfg.noticePeriodDays, detail),
      employeeInfo: detail
        ? { id: record.employeeId, employeeCode: detail.employeeCode, name: detail.employeeName, department: detail.department, designation: detail.designation, reportingManager: detail.reportingManager, location }
        : await employeeInfo(record.employee),
      workflow: view,
      // The Letter of Resignation view.
      companyName: await companyLegalName(),
      submittingTo: await submittingToOf(record.id),
    });
  } catch (err) {
    return next(err);
  }
});

// ---- DECISIONS -------------------------------------------------------------
router.patch('/:id/status', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!DECISIONS.includes(status)) return res.status(400).json({ error: `status must be one of: ${DECISIONS.join(', ')}` });
    const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.type !== 'RESIGNATION') return res.status(404).json({ error: 'Resignation not found' });
    if (TERMINAL.includes(existing.status)) return res.status(409).json({ error: `A ${existing.status.toLowerCase()} resignation can no longer be changed.` });
    const employee = await prisma.employee.findUnique({ where: { id: existing.employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const cfg = await hrConfig();
    const note = clean(req.body.reason) || clean(req.body.rejectReason) || clean(req.body.remarks);

    // ---- APPROVE / REJECT: the chain decision -------------------------------
    if (['Accepted', 'Approved', 'Rejected'].includes(status)) {
      const approve = status !== 'Rejected';
      if (!await chain.mayTouch(WF_RES, existing.id, req.user, employee)) {
        return res.status(403).json(chain.OUT_OF_SCOPE);
      }
      await chain.ensure(WF_RES, { recordId: existing.id, employee, open: existing.status === PENDING });
      const step = await chain.decide(WF_RES, existing.id, req.user, { decision: approve ? 'Approved' : 'Rejected', note });
      if (step.error) return res.status(step.error.status).json(step.error.body);

      if (!step.chained) {
        // No open step. A request still at Pending Approval with no chain
        // (the chain could not be laid down) decides in one step; one that
        // is already approved has nothing left to approve.
        if (existing.status !== PENDING) return res.status(409).json({ error: 'This resignation is no longer awaiting approval.' });
        if (!approve && !note) return res.status(400).json({ error: 'A rejection reason is required.' });
      } else {
        await logAudit({
          userId: req.user.id,
          action: `Resignation ${approve ? 'approved' : 'rejected'} at ${step.result.level}${step.result.direct ? ` (${workflow.DIRECT_LABEL})` : ''}`,
          entity: 'EmployeeRecord',
          entityId: existing.id,
          fromValue: step.result.fromLevel || step.result.level,
          toValue: step.result.nextLevel || step.result.outcome,
        });
        // STILL CLIMBING — it stays Pending Approval.
        if (!step.result.complete) {
          const detail = await prisma.resignationDetail.findUnique({ where: { recordId: existing.id } });
          return res.json({ ...present(existing, cfg.noticePeriodDays, detail), workflow: step.view });
        }
      }
      const saved = approve
        ? await applyApproval(existing, req.user, { lastWorkingDate: clean(req.body.lastWorkingDate, 10) })
        : await applyRejection(existing, req.user, note);
      const detail = await prisma.resignationDetail.findUnique({ where: { recordId: existing.id } });
      const view = await workflow.view(WF_RES, existing.id, req.user, { canAct: false }).catch(() => null);
      return res.json({ ...present(saved, cfg.noticePeriodDays, detail), workflow: view });
    }

    // ---- RELIEVED / WITHDRAWN: single step, as always -------------------------
    if (!employeeInScope(req.user, employee)) return res.status(403).json(OUT_OF_SCOPE);
    if (status === 'Relieved' && !SERVING.includes(existing.status)) {
      return res.status(409).json({ error: 'Only an approved resignation (on notice) can be relieved. This one is still awaiting approval.' });
    }
    if (status === 'Withdrawn') await closeChain(existing.id, `Not reached — the resignation was withdrawn (${req.user.name || req.user.email})`);
    const record = await prisma.employeeRecord.update({ where: { id: existing.id }, data: { status } });
    await prisma.employee.update({
      where: { id: existing.employeeId },
      data: status === 'Relieved'
        ? { employmentStatus: 'Relieved', offboardingStatus: 'Cleared' }
        : (SERVING.includes(existing.status) ? { employmentStatus: 'Active', offboardingStatus: null } : {}),
    });
    // Relieving raises the Full & Final settlement request the Payroll screen acts on.
    if (status === 'Relieved') {
      const openFnf = await prisma.fnfRequest.findFirst({ where: { employeeId: existing.employeeId, status: 'Pending' } });
      if (!openFnf) await prisma.fnfRequest.create({ data: { employeeId: existing.employeeId, lastWorkingDate: existing.date || new Date().toISOString().slice(0, 10) } });
    }
    await logAudit({ userId: req.user.id, action: `Resignation ${status}`, entity: 'EmployeeRecord', entityId: record.id, fromValue: existing.status, toValue: status });
    const detail = await prisma.resignationDetail.findUnique({ where: { recordId: existing.id } });
    return res.json(present(record, cfg.noticePeriodDays, detail));
  } catch (err) {
    return next(err);
  }
});

// The employee takes their OWN resignation back while it is awaiting
// approval or during notice. No approval needed.
router.patch('/:id/withdraw', async (req, res, next) => {
  try {
    const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.type !== 'RESIGNATION') return res.status(404).json({ error: 'Resignation not found' });
    if (!req.user.employeeId || existing.employeeId !== req.user.employeeId) {
      return res.status(403).json({ error: 'Only the employee who resigned can withdraw it here.' });
    }
    if (!OPEN.includes(existing.status)) return res.status(409).json({ error: `A ${existing.status.toLowerCase()} resignation can no longer be withdrawn.` });
    await closeChain(existing.id, 'Not reached — the employee withdrew the resignation');
    const record = await prisma.employeeRecord.update({ where: { id: existing.id }, data: { status: 'Withdrawn' } });
    if (SERVING.includes(existing.status)) {
      await prisma.employee.update({ where: { id: existing.employeeId }, data: { employmentStatus: 'Active', offboardingStatus: null } });
    }
    await logAudit({ userId: req.user.id, action: 'Resignation withdrawn by the employee', entity: 'EmployeeRecord', entityId: existing.id, fromValue: existing.status, toValue: 'Withdrawn' });
    const [detail, cfg] = await Promise.all([prisma.resignationDetail.findUnique({ where: { recordId: existing.id } }), hrConfig()]);
    return res.json(present(record, cfg.noticePeriodDays, detail));
  } catch (err) {
    return next(err);
  }
});

// Agreeing a different last working day (early release or an extension).
router.patch('/:id', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res, next) => {
  try {
    const { date, detail } = req.body;
    const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id }, include: { employee: true } });
    if (!existing || existing.type !== 'RESIGNATION') return res.status(404).json({ error: 'Resignation not found' });
    if (!employeeInScope(req.user, existing.employee)) return res.status(403).json(OUT_OF_SCOPE);
    if (date !== undefined && date !== null && date !== '' && !ISO_DATE.test(String(date))) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const record = await prisma.employeeRecord.update({
      where: { id: req.params.id },
      data: { date: date !== undefined ? date : undefined, detail: detail !== undefined ? detail : undefined },
    });
    const form = await prisma.resignationDetail.findUnique({ where: { recordId: existing.id } });
    if (form && date) {
      await prisma.resignationDetail.update({
        where: { id: form.id },
        data: SERVING.includes(existing.status) ? { approvedLastWorkingDate: date } : { requestedLastWorkingDate: date },
      });
    }
    await logAudit({ userId: req.user.id, action: 'Last working day updated', entity: 'EmployeeRecord', entityId: record.id, fromValue: existing.date, toValue: record.date });
    const cfg = await hrConfig();
    const fresh = await prisma.resignationDetail.findUnique({ where: { recordId: existing.id } });
    return res.json(present(record, cfg.noticePeriodDays, fresh));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
