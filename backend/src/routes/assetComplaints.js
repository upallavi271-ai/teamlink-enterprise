// ---------------------------------------------------------------------------
// ASSET COMPLAINTS ("Report a problem") - /api/asset-complaints/* (2026-10-19). The work is in utils/assetComplaints.js (read its header).
//
//   GET  /meta               the kinds an employee can pick (Repair | Replacement | Other) with a plain-words help line each
//   GET  /                   the complaints the signed-in login may see (an employee: own; HR / a lead: their departments')
//   POST /                   { assetId, kind, issue }  an employee reports a problem with an asset assigned to them
//   POST /:id/decision       { decision: 'Approved' | 'Rejected' | 'Open' }  same rule as the Asset Approval buttons
//                            (Employee Services "approve" right + the employee must be in your scope; nobody decides their own)
// The Asset Approval screen's own Approve / Reject (PATCH /api/assets/:id/status) does exactly the same: routes/employeeRecords.js calls
// the same gate and the same follow-up.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const AC = require('../utils/assetComplaints');

const router = express.Router();
router.use(requireAuth);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.get('/meta', (req, res) => res.json({ kinds: AC.KINDS.map((k) => ({ value: k, help: AC.KIND_HELP[k] })) }));

router.get('/my-assets', wrap(async (req, res) => res.json({ rows: await AC.myAssets(req.user) })));

router.get('/', wrap(async (req, res) => {
  const rows = await AC.list(employeeRecordWhere(req.user));
  res.json({ rows });
}));

router.post('/', wrap(async (req, res) => {
  const r = await AC.raise(req.user, req.body);
  res.status(r.status).json(r.body);
}));

router.post('/:id/decision', requirePerm(null, 'hrms', 'Employee Services', 'approve'), wrap(async (req, res) => {
  const status = String((req.body || {}).decision || '').trim();
  const record = await prisma.employeeRecord.findUnique({ where: { id: String(req.params.id) }, include: { employee: true } });
  if (!record || record.type !== 'ASSET' || !(await AC.complaintOf(record.id))) return res.status(404).json({ error: 'Complaint not found' });
  if (!employeeInScope(req.user, record.employee)) return res.status(403).json(OUT_OF_SCOPE);
  const stop = await AC.gate(record, req.user, status);
  if (stop) return res.status(stop.status).json({ error: stop.error });
  const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: { status } });
  await logAudit({ userId: req.user.id, action: 'ASSET status changed', entity: 'EmployeeRecord', entityId: record.id, toValue: status });
  const follow = await AC.onStatusChange(updated, req.user);
  return res.json({ id: updated.id, status: updated.status, follow });
}));

module.exports = router;
