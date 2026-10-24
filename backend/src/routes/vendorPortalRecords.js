// ---------------------------------------------------------------------------
// VENDOR PORTAL - THE FOUR MODULES' API (2026-10-19): Dashboard, Invoices, Payments, Purchase Orders. READ ONLY.
// Mounted INSIDE routes/vendorPortal.js, so it inherits the feature flag, the rate limit, the vendor shield and the global vendor wall.
//
//   GET /records/overview               Dashboard numbers
//   GET /records/invoices               list (q, status=paid|unpaid|rejected, from, to, sort, dir, page, pageSize)
//   GET /records/invoices/:key          one invoice
//   GET /records/payments               list (q, method, from, to, sort, dir, page, pageSize)
//   GET /records/payments/:key          one payment
//   GET /records/services               Services & Agreements: agreements, services, orders, additional charges
//   GET /records/purchase-orders        list (q, status, from, to, sort, dir, page, pageSize)
//   GET /records/purchase-orders/:id    one purchase order with its items and documents
//   (files: the existing POST /download-link -> signed GET /files/:token, which re-checks ownership)
//
// ISOLATION: the vendor comes from the SESSION (VA.requireVendor -> req.vendor.vendorId). A vendorId / vendorUserId in the query, body
// or path is never read. A key or id is only ever looked up among THIS vendor's own rows, so someone else's record answers 403 exactly
// like one that does not exist (ids cannot be probed). Every route is GET: nothing here can change a value.
// ---------------------------------------------------------------------------
const express = require('express');
const VA = require('../utils/vendorAuth');
const R = require('../utils/vendorRecords');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const NOT_YOURS = { error: 'Forbidden. This is not yours.' };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.get('/records/overview', vendorOnly, wrap(async (req, res) => res.json(await R.overview(req.vendor.vendorId))));

router.get('/records/invoices', vendorOnly, wrap(async (req, res) => res.json(await R.listInvoices(req.vendor.vendorId, req.query || {}))));
router.get('/records/invoices/:key', vendorOnly, wrap(async (req, res) => {
  const r = await R.invoiceDetail(req.vendor.vendorId, req.params.key);
  return r ? res.json({ invoice: r }) : res.status(403).json(NOT_YOURS);
}));

router.get('/records/payments', vendorOnly, wrap(async (req, res) => res.json(await R.listPayments(req.vendor.vendorId, req.query || {}))));
router.get('/records/payments/:key', vendorOnly, wrap(async (req, res) => {
  const r = await R.paymentDetail(req.vendor.vendorId, req.params.key);
  return r ? res.json({ payment: r }) : res.status(403).json(NOT_YOURS);
}));

// Services & Agreements (the fourth module): agreements, services / subscriptions, orders, additional charges - only this vendor's own.
router.get('/records/services', vendorOnly, wrap(async (req, res) => res.json(await R.services(req.vendor.vendorId))));

router.get('/records/purchase-orders', vendorOnly, wrap(async (req, res) => res.json(await R.listPurchaseOrders(req.vendor.vendorId, req.query || {}))));
router.get('/records/purchase-orders/:id', vendorOnly, wrap(async (req, res) => {
  const r = await R.purchaseOrderDetail(req.vendor.vendorId, req.params.id);
  return r ? res.json({ purchaseOrder: r }) : res.status(403).json(NOT_YOURS);
}));

// Any other /records/... path (a write, an unknown name) is refused.
router.all('/records/*', (req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
