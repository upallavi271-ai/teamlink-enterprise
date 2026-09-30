// ---------------------------------------------------------------------------
// ONE READ ENDPOINT FOR EVERY REQUEST ON THE APPROVAL CHAIN (spec item 2).
//
//   GET /api/approvals/:workflow/:recordId
//
// Returns the engine's view() of that request — every step, the tracking
// facts (Submitted By / At, Current Approver, Approval Level, Previous
// Approvers, Status, Approved/Rejected By / At, Remarks, the Direct Super
// Admin flag, the one-line chain) — plus `canAct` / `canDirect` for the
// login asking. The shared React component (components/ApprovalChain.jsx)
// renders exactly this, on Leave, Regularization, Resignation, Rewards and
// Courses alike.
//
// DECIDING stays on each request's own router (leave, attendance,
// resignations, performance, lms), because each one applies its own side
// effects on the final step. This file only READS.
//
// VISIBILITY follows scope: the requester, anyone named on the chain, and
// roles whose scope covers the employee (workflow.canSee). Anybody else gets
// 403 — an unrelated TL cannot open another team's request by id.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { OUT_OF_SCOPE } = require('../utils/scope');
const workflow = require('../utils/approvalWorkflow');

const router = express.Router();
router.use(requireAuth);

// Which record each workflow hangs off, and the employee its chain is
// resolved from. `employee` null means the request has no subject employee
// (a course); visibility then falls back to the feature permission.
const SUBJECTS = {
  leave: async (id) => {
    const r = await prisma.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
    return r && { record: r, employee: r.employee, status: r.status, title: `${r.type} · ${r.fromDate}${r.toDate && r.toDate !== r.fromDate ? ` – ${r.toDate}` : ''}` };
  },
  regularization: async (id) => {
    const r = await prisma.attendanceRegularization.findUnique({ where: { id }, include: { employee: true } });
    return r && { record: r, employee: r.employee, status: r.status, title: `Regularization · ${r.date}` };
  },
  resignation: async (id) => {
    const r = await prisma.employeeRecord.findUnique({ where: { id }, include: { employee: true } });
    if (!r || r.type !== 'RESIGNATION') return null;
    return { record: r, employee: r.employee, status: r.status, title: `Resignation · ${r.title}` };
  },
  reward: async (id) => {
    const r = await prisma.performanceReview.findUnique({ where: { id }, include: { employee: true } });
    return r && { record: r, employee: r.employee, status: r.approvalStatus, title: `Recommendation · ${r.period}` };
  },
  course: async (id) => {
    const r = await prisma.course.findUnique({ where: { id } });
    return r && { record: r, employee: null, status: r.approvalStatus, title: `Course · ${r.title}` };
  },
};

router.get('/:workflow/:recordId', async (req, res, next) => {
  try {
    const wfId = req.params.workflow;
    const wf = workflow.WORKFLOWS[wfId];
    const load = SUBJECTS[wfId];
    if (!wf || !load) return res.status(404).json({ error: 'Unknown approval workflow' });
    const subject = await load(req.params.recordId);
    if (!subject) return res.status(404).json({ error: 'Request not found' });

    let visible;
    if (subject.employee) {
      visible = await workflow.canSee(wfId, req.params.recordId, req.user, subject.employee);
    } else {
      visible = await workflow.isParticipant(wfId, req.params.recordId, req.user.id)
        || await can(req.user, wf.product, wf.module, wf.feature, 'view');
    }
    if (!visible) return res.status(403).json(OUT_OF_SCOPE);

    const steps = await workflow.loadSteps(wfId, req.params.recordId);
    const current = steps.find((s) => s.status === workflow.STEP_STATUS.PENDING);
    const { mayAct } = await workflow.permissionFor(wfId, req.user);
    const canAct = !!(current && mayAct && current.approverUserId === req.user.id);
    const view = steps.length ? await workflow.view(wfId, req.params.recordId, req.user, { canAct }) : null;
    if (view && view.canDirect && !mayAct) view.canDirect = false;
    const e = subject.employee;
    return res.json({
      workflow: view,
      request: {
        id: req.params.recordId,
        type: wfId,
        label: wf.label,
        title: subject.title,
        status: subject.status,
        employee: e ? { id: e.id, name: e.name, code: e.employeeCode, department: e.department, designation: e.designation } : null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
