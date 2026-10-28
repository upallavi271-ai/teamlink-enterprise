// ---------------------------------------------------------------------------
// ACCOUNTS -> OFFICE & ACCOUNTS -> "BILLS FROM VENDORS" -> UPLOADED BILLS (AI read) - /api/vendor-bills/uploads/* (2026-10-21).
// The same doors as routes/vendorBills.js (Accounts product, the Office & Expenses view grant, an Accounts-desk role). Approving and rejecting
// needs the existing approver right (Super Admin, Admin, or an Accountant with "approve" on Office & Expenses); correcting, sending back and
// re-reading needs the "edit" grant. Mounted BEFORE /api/vendor-bills so "uploads" is never taken for a bill id.
//
//   GET   /ai-status       { ready, provider, model, reason }  the "AI bill reading: Ready / Not set up" light
//   GET   /count           { waiting }
//   GET   /                list (q, status, vendorId)
//   GET   /:id             one bill: files, fields, per-field confidence, flags, what still blocks approval, candidates, history   (?raw=1: Admin, the AI's raw answer)
//   GET   /:id/files/:fileId   the original file (?inline=1 to show it in the review screen)
//   PATCH /:id             correct fields / lines / the repair / the asset
//   POST  /:id/approve     { acknowledge: [flag keys], confirmNotDuplicate, category, paymentMode, dueDate, reviewNote }  -> approves and syncs
//   POST  /:id/reject      { reason }
//   POST  /:id/send-back   { note }
//   POST  /:id/reread      read it with AI again
//   POST  /:id/retry-sync  finish the sync of an approved bill
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const { roleForProduct, SET } = require('../utils/permissions');
const attachments = require('../utils/attachments');
const BU = require('../utils/billUploads');
const RV = require('../utils/billUploadReview');
const OCR = require('../utils/billOcr');
const VP = require('../utils/vendorPortal');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Office & Expenses', 'view'));
router.use((req, res, next) => {
  const role = roleForProduct(req.user, 'accounts');
  if (role && SET.ACCOUNTS.includes(role)) return next();
  return res.status(403).json({ error: 'Bills from vendors are open to Super Admin, Admin and Accounts only' });
});
const office = () => require('./office'); // eslint-disable-line global-require
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const send = (res, r) => res.status(r.status).json(r.body);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const needApprover = async (req, res) => {
  if (await office().isApprover(req.user)) return false;
  res.status(403).json({ error: office().APPROVER_ONLY || 'Only an Accounts approver can do this.' });
  return true;
};
const needEdit = async (req, res) => {
  if (await can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'edit')) return false;
  res.status(403).json({ error: 'You can view these bills but not change them.' });
  return true;
};
const isAdmin = (user) => ['SUPER_ADMIN', 'ADMIN'].includes(roleForProduct(user, 'accounts'));

router.get('/ai-status', wrap(async (req, res) => res.json(await OCR.status())));
router.get('/count', wrap(async (req, res) => res.json({ waiting: await RV.waitingCount(), total: await RV.totalCount() })));
router.get('/', wrap(async (req, res) => {
  const [list, canReview, canEdit] = await Promise.all([RV.staffList(req.query || {}), office().isApprover(req.user).catch(() => false), can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'edit').catch(() => false)]);
  res.json({ ...list, access: { canReview: !!canReview, canEdit: !!canEdit } });
}));

async function loaded(req, res) {
  const row = await BU.getRow(req.params.id);
  if (!row) { res.status(404).json({ error: 'Bill not found.' }); return null; }
  return row;
}
router.get('/:id', wrap(async (req, res) => {
  const row = await loaded(req, res);
  if (!row) return undefined;
  const [canReview, canEdit] = await Promise.all([office().isApprover(req.user).catch(() => false), can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'edit').catch(() => false)]);
  const upload = await RV.staffDetail(row, { raw: req.query.raw === '1' && isAdmin(req.user) });
  return res.json({ upload, access: { canReview: !!canReview, canEdit: !!canEdit }, ai: await OCR.status() });
}));

router.get('/:id/files/:fileId', wrap(async (req, res) => {
  const row = await loaded(req, res);
  if (!row) return undefined;
  const f = (row.files || []).find((x) => x.id === req.params.fileId);
  if (!f) return res.status(404).json({ error: 'No such file on this bill.' });
  const full = attachments.resolveStored(f.file);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server.' });
  await VP.auditReq(req, { changedById: req.user.id, actorName: req.user.name || req.user.email, role: 'Accounts', assetId: row.assetId, vendorId: row.vendorId, action: 'Bill document downloaded', billId: row.id, documentName: f.name });
  res.setHeader('Content-Type', attachments.ALLOWED[f.mime] ? f.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${attachments.safeDisplayName(f.name)}"`);
  return res.sendFile(full);
}));

router.patch('/:id', wrap(async (req, res) => {
  if (await needEdit(req, res)) return undefined;
  return send(res, await RV.staffEdit(req.user, req.params.id, bodyOf(req)));
}));
// Which HRMS asset one line of the bill is: { lineNo, kind: 'linked' | 'new' | 'clear', assetId } (asset detection, 2026-10-28).
// Only the bill line's link changes - never the asset itself.
router.post('/:id/line-asset', wrap(async (req, res) => {
  if (await needEdit(req, res)) return undefined;
  return send(res, await RV.lineAsset(req.user, req.params.id, bodyOf(req)));
}));
router.post('/:id/approve', wrap(async (req, res) => {
  if (await needApprover(req, res)) return undefined;
  return send(res, await RV.approve(req.user, req, req.params.id, bodyOf(req)));
}));
router.post('/:id/reject', wrap(async (req, res) => {
  if (await needApprover(req, res)) return undefined;
  return send(res, await RV.reject(req.user, req, req.params.id, bodyOf(req)));
}));
router.post('/:id/send-back', wrap(async (req, res) => {
  if (await needEdit(req, res)) return undefined;
  return send(res, await RV.sendBack(req.user, req, req.params.id, bodyOf(req)));
}));
router.post('/:id/reread', wrap(async (req, res) => {
  if (await needEdit(req, res)) return undefined;
  return send(res, await RV.reread(req.user, req.params.id));
}));
router.post('/:id/retry-sync', wrap(async (req, res) => {
  if (await needApprover(req, res)) return undefined;
  return send(res, await RV.retrySync(req.user, req, req.params.id));
}));

router.use((req, res) => res.status(404).json({ error: 'Not found.' }));
module.exports = router;
