// ---------------------------------------------------------------------------
// ACCOUNTS -> OFFICE & ACCOUNTS -> "VENDOR INVOICES AND MONTHLY BILLS" (2026-10-14).
// /api/vendor-module-bills — Accounts review of the invoices, monthly bills and receipts that vendors without an asset
// (ID cards, telecom, office rent, other) send through the Vendor Portal (table VendorModuleBill).
// Same door as the asset bills review (routes/vendorBills.js): Accounts product, Office & Expenses view,
// Super Admin / Admin / Accountant. Submitted -> Approved -> Paid, or Rejected (with a reason the vendor sees).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { roleForProduct, SET } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const VP = require('../utils/vendorPortal');
const VF = require('../utils/vendorFiles');
const VM = require('../utils/vendorModules');
const DB = require('../utils/vmDb');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Office & Expenses', 'view'));
router.use((req, res, next) => {
  const role = roleForProduct(req.user, 'accounts');
  if (role && SET.ACCOUNTS.includes(role)) return next();
  return res.status(403).json({ error: 'Vendor invoices are open to Super Admin, Admin and Accounts only' });
});
router.use(async (req, res, next) => ((await DB.ready()) ? next() : res.status(503).json(DB.NOT_READY)));

const { str, ROUND } = VP;
const MODES = ['Bank Transfer', 'UPI', 'Cash', 'Cheque', 'Other'];
const actorOf = (req) => req.user.name || req.user.email || 'Accounts';
const roleOf = (req) => (['SUPER_ADMIN', 'ADMIN'].includes(roleForProduct(req.user, 'accounts')) ? 'Admin' : 'Accounts');
const audit = (req, row) => VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: roleOf(req), ...row });
const row = (b, vn, oc) => ({ ...VM.billView(b), vendorId: b.vendorId, vendorName: vn.get(b.vendorId) || '', orderCode: oc.get(b.orderId) || null, reviewedByName: b.reviewedByName || null, reviewRemarks: b.reviewRemarks || null, reviewedAt: DB.toDate(b.reviewedAt) });

router.get('/', async (req, res) => {
  const where = []; const params = [];
  for (const k of ['status', 'kind', 'vendorId']) if (str(req.query[k])) { where.push(`"${k}" = ?`); params.push(str(req.query[k])); }
  const rows = await DB.q(`SELECT * FROM "VendorModuleBill" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE "status" WHEN 'Submitted' THEN 0 WHEN 'Approved' THEN 1 ELSE 2 END, "createdAt" DESC LIMIT 500`, params);
  const [vendors, orders] = await Promise.all([
    prisma.officeVendor.findMany({ select: { id: true, name: true } }),
    DB.q('SELECT "id","orderCode" FROM "IdCardOrder"'),
  ]);
  const vn = new Map(vendors.map((v) => [v.id, v.name]));
  const oc = new Map(orders.map((o) => [o.id, o.orderCode]));
  const counts = await DB.q('SELECT "status", COUNT(*) AS n FROM "VendorModuleBill" GROUP BY "status"');
  res.json({ rows: rows.map((b) => row(b, vn, oc)), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), modes: MODES });
});

async function load(req, res) {
  const b = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "id" = ?', [String(req.params.id)]);
  if (!b) { res.status(404).json({ error: 'Bill not found.' }); return null; }
  return b;
}
async function move(req, res, from, to, extraSql, extraParams, what, body) {
  const b = await load(req, res);
  if (!b) return undefined;
  if (!from.includes(b.status)) return res.status(409).json({ error: `This bill is ${VM.billStatusText(b.kind, b.status)} and cannot be ${what}.` });
  const t = DB.now();
  const n = await DB.run(`UPDATE "VendorModuleBill" SET "status" = ?, "reviewedById" = ?, "reviewedByName" = ?, "reviewedAt" = ?, "updatedAt" = ?${extraSql} WHERE "id" = ? AND "status" = ?`, [to, req.user.id, actorOf(req), t, t, ...extraParams, b.id, b.status]);
  if (!n) return res.status(409).json({ error: 'This bill was just changed. Refresh and try again.' });
  await audit(req, { vendorId: b.vendorId, action: `Vendor ${b.kind === 'monthly_bill' ? 'monthly bill' : (b.kind === 'receipt' ? 'receipt' : 'invoice')} ${what}`, field: 'status', oldValue: b.status, newValue: to, status: b.billCode });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: `Vendor bill ${what}`, entity: 'VendorModuleBill', entityId: b.id, fromValue: b.status, toValue: `${to} · ${b.billCode}` });
  const fresh = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "id" = ?', [b.id]);
  return res.json({ bill: VM.billView(fresh), message: body });
}

router.post('/:id/approve', (req, res) => move(req, res, ['Submitted'], 'Approved', ', "reviewRemarks" = ?', [VP.cleanText((req.body || {}).remarks, 500) || null], 'approved', 'Approved. The vendor sees it.'));
router.post('/:id/reject', (req, res) => {
  const reason = VP.cleanText((req.body || {}).reason, 500);
  if (reason.length < 3) return res.status(400).json({ error: 'Write why it is being rejected: the vendor sees this.', field: 'reason' });
  return move(req, res, ['Submitted', 'Approved'], 'Rejected', ', "rejectionReason" = ?', [reason], 'rejected', 'Rejected. The vendor sees the reason.');
});
router.post('/:id/paid', async (req, res) => {
  const bd = req.body || {};
  const b = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "id" = ?', [String(req.params.id)]);
  if (!b) return res.status(404).json({ error: 'Bill not found.' });
  const paidOn = str(bd.paidOn) || new Date().toISOString().slice(0, 10);
  if (!VP.isRealDay(paidOn)) return res.status(400).json({ error: 'Pick the payment date.', field: 'paidOn' });
  const reference = VP.cleanText(bd.reference, 80);
  if (!reference) return res.status(400).json({ error: 'Enter the payment reference no.', field: 'reference' });
  const amount = bd.amount === undefined || bd.amount === '' ? b.total : ROUND(Number(bd.amount));
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter the amount paid.', field: 'amount' });
  const mode = MODES.includes(str(bd.mode)) ? str(bd.mode) : 'Bank Transfer';
  return move(req, res, ['Approved'], 'Paid', ', "paidOn" = ?, "paidAmount" = ?, "paymentRef" = ?, "paymentMode" = ?', [paidOn, amount, reference, mode], 'marked paid', 'Marked paid. The vendor sees the payment.');
});
router.get('/:id/document', async (req, res) => {
  const b = await load(req, res);
  if (!b) return undefined;
  if (!b.documentFile) return res.status(404).json({ error: 'No file on this bill.' });
  return VF.sendStored(res, b.documentFile, b.documentMime, b.documentName);
});

module.exports = router;
