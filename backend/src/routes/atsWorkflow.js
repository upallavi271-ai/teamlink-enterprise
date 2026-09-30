// ---------------------------------------------------------------------------
// /api/ats/workflow — THE ACTUAL WORKFLOW with live counts, in the caller's
// scope (the ATS Dashboard's "See workflow" and the Workflow tab of ATS
// Reports).
//
//   GET /            the flow diagram: requirement boxes, the Job Portal
//                    (pre-ATS) boxes, the client and the internal hiring
//                    chains, each box with its count (utils/workflowFlow.js).
//   GET /list?group= the applications (or, for Invoice / Payment, the
//                    invoices) behind one box — the box's filtered list.
//
// Counts come from utils/atsVocab.js WORKFLOW_STAGE_GROUPS and nowhere else,
// so this view, the dashboards and the reports can never disagree. Scope is
// utils/scope.js applicationWhere(), unchanged: a Medical TL counts Medical,
// HR counts the internal openings only.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { requireInternal } = require('../utils/permissions');
const { workflowSnapshot, listWorkflowGroup } = require('../utils/workflowFlow');
const { WORKFLOW_STAGE_GROUPS } = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(requireInternal);

// Anyone who reaches the pipeline (candidates / Applications / view — the
// working roles, HR's internal-only view, the view-only Manager).
async function mayView(user) {
  return can(user, 'ats', 'candidates', 'Applications', 'view');
}

router.get('/', async (req, res, next) => {
  try {
    if (!(await mayView(req.user))) return res.status(403).json({ error: "The workflow view isn't included in your role's permissions" });
    const snap = await workflowSnapshot(req.user, { fresh: req.query.fresh === '1' });
    const invoices = await can(req.user, 'accounts', 'accounts', 'Invoices', 'view');
    return res.json({ ...snap, permissions: { invoices } });
  } catch (err) { return next(err); }
});

router.get('/list', async (req, res, next) => {
  try {
    if (!(await mayView(req.user))) return res.status(403).json({ error: "The workflow view isn't included in your role's permissions" });
    const group = String(req.query.group || '');
    const g = WORKFLOW_STAGE_GROUPS[group];
    if (!g) return res.status(400).json({ error: 'Unknown workflow group' });
    // Invoice rows carry amounts: the Accounts desk's (and Super Admin's).
    if (g.entity === 'invoice' && !(await can(req.user, 'accounts', 'accounts', 'Invoices', 'view'))) {
      return res.status(403).json({ error: 'Invoice details are for the Accounts desk — the count is shown on the diagram.' });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const out = await listWorkflowGroup(req.user, group, { limit, fresh: req.query.fresh === '1' });
    return res.json(out);
  } catch (err) { return next(err); }
});

module.exports = router;
