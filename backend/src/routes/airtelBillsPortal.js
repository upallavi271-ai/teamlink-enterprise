// ---------------------------------------------------------------------------
// THE AIRTEL BILLS PORTAL API - /api/vendor-portal/airtel-portal/* (2026-10-19).
// Mounted INSIDE routes/vendorPortal.js: it inherits the feature flag, the rate limit, the vendor shield and the vendor wall.
// A separate front end over the SAME Accounts data (utils/airtelBillsPortal.js) - the Assets Vendor Portal is only the reference for the pattern.
//
//   GET  /airtel-portal/overview          numbers + the computed alerts (overdue, due soon, newly confirmed payments - one per bill)
//   GET  /airtel-portal/bills             list: q, status, period (YYYY-MM), from, to (YYYY-MM), sim (SIM reference), sort, dir, page, pageSize
//   GET  /airtel-portal/bills/:key        one bill: every field ("Not recorded" = null), the per-number charges (masked), the history
//   GET  /airtel-portal/history           monthly history: period, from, to, status, sim, q, sort, dir, page
//   GET  /airtel-portal/sims              SIM list (read only): q, department, status, sort, dir, page
//   POST /airtel-portal/bills             multipart "Send a bill" (needs the Airtel Bills "Send a bill" tick): the existing monthly-bill upload
//   (the bill copy: the existing POST /download-link { kind: 'airtel-bill', id: <bill key> } -> signed GET /files/:token)
//
// ISOLATION: the vendor comes from the SESSION; only a telecom vendor (utils/vendorKind.js) gets in; a vendorId in the query, body or path is
// never read; a bill key is only ever looked up INSIDE this vendor's own bills, so someone else's answers 403 exactly like a missing one.
// READ ONLY: no route sets a status or a payment. A field named status / paid / payment... on a write answers 400.
// ---------------------------------------------------------------------------
const express = require('express');
const VA = require('../utils/vendorAuth');
const KIND = require('../utils/vendorKind');
const VM = require('../utils/vendorModules');
const DB = require('../utils/vmDb');
const ATB = require('../utils/airtelBillsPortal');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const NOT_AVAILABLE = { error: 'This page is not available in the Vendor Portal.', notAvailable: true };
const NOT_YOURS = { error: 'Forbidden. This bill is not yours.' };
const PAYMENT_WORDS = /^(status|paid|paidstatus|paymentstatus|payment|paymentdate|paidon|paidat|paidamount|balance|outstanding|utr|reference|paymentref|verified|bank|banktxnid|approval|approvalstatus)$/i;
const SEND_FIELDS = ['billNumber', 'period', 'dueDate', 'billDate', 'amount', 'gst', 'remarks', 'lines'];

async function telecomVendorOnly(req, res, next) {
  try {
    if ((await KIND.kindOfRow({ ...req.vendor.row, vendorId: req.vendor.vendorId })) !== 'telecom') return res.status(403).json(NOT_AVAILABLE);
    req.airtel = { userId: req.vendor.userId, vendorId: req.vendor.vendorId, vendorName: req.vendor.vendorName, name: req.vendor.name };
    return next();
  } catch (err) { return next(err); }
}
const guard = [vendorOnly, telecomVendorOnly];
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const canSendOf = async (req) => {
  const eff = await VM.effectiveModules(req.vendor.row);
  const m = eff.map.get('airtel_bills');
  return !!m && VM.CFG.permAllowed('airtel_bills', m.permissions, 'sendBill');
};

router.get('/airtel-portal/overview', ...guard, wrap(async (req, res) => res.json(await ATB.overview(req.airtel, await canSendOf(req)))));
router.get('/airtel-portal/bills', ...guard, wrap(async (req, res) => res.json({ ...(await ATB.listBills(req.airtel, req.query || {})), canSend: await canSendOf(req) })));
router.get('/airtel-portal/bills/:key', ...guard, wrap(async (req, res) => {
  const r = await ATB.billDetail(req.airtel, req.params.key);
  return r ? res.json(r) : res.status(403).json(NOT_YOURS);
}));
router.get('/airtel-portal/history', ...guard, wrap(async (req, res) => res.json(await ATB.listHistory(req.airtel, req.query || {}))));
router.get('/airtel-portal/sims', ...guard, wrap(async (req, res) => res.json(await ATB.listSims(req.airtel, req.query || {}))));

// A write on a bill: there is none. A payment / status field says so plainly (400); anything else is "not allowed" (405).
router.all('/airtel-portal/bills/:key', ...guard, (req, res, next) => {
  if (req.method === 'GET') return next();
  const bad = Object.keys(bodyOf(req)).filter((k) => PAYMENT_WORDS.test(k));
  if (bad.length) return res.status(400).json({ error: 'A vendor cannot set a status or a payment. Accounts pays the bill and the bank statement confirms it.', refusedFields: bad });
  return res.status(405).json({ error: 'A bill cannot be changed here. Contact Accounts.' });
});

// SEND A BILL = the existing monthly-bill upload (routes/vendorModulePortal.js createBill): same table, same duplicate rules (invoice number, month),
// same review queue in Accounts, same notice to Accounts. On top: the "Send a bill" tick, only bill fields are accepted, and a bill Accounts
// already holds (same invoice number, or same month and amount) is refused. It creates NO expense: Accounts books the payable.
router.post('/airtel-portal/bills', ...guard, wrap(async (req, res) => {
  if (!(await DB.ready())) return res.status(503).json(DB.NOT_READY);
  const create = require('./vendorModulePortal').createBill; // eslint-disable-line global-require
  const json = res.json.bind(res);
  res.json = (body) => json(ATB.sendAnswer(body)); // numbers masked, only the bill's own fields
  return create(req, res, 'monthly_bill', {
    perm: ['airtel_bills', 'sendBill'], allowedFields: SEND_FIELDS, extraCheck: (d) => ATB.duplicateInAccounts(req.airtel, d),
  });
}));

// Anything else under /airtel-portal is not part of the portal.
router.all('/airtel-portal/*', (req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
