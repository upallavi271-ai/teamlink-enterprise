// ---------------------------------------------------------------------------
// THE ASSETS VENDOR PORTAL API - /api/vendor-portal/asset-portal/* (2026-10-19).
// Mounted INSIDE routes/vendorPortal.js, so it inherits the feature flag, the rate limit, the vendor shield and the vendor wall.
//
//   GET   /asset-portal/overview                    Dashboard numbers
//   GET   /asset-portal/assets                      list (q, category, status, condition, sort, dir, page, pageSize)
//   GET   /asset-portal/assets/:id                  one asset: details, its repairs, its repair history
//   PATCH /asset-portal/assets/:id                  brand, model, condition, serial number, service remarks (login with "Allow editing")
//   GET   /asset-portal/orders                      list (q, status, from, to, sort, dir, page)
//   GET   /asset-portal/orders/:id                  one order with items, documents and its status history
//   POST  /asset-portal/orders/:id/status           { status, remarks } one step forward; the same status again changes nothing
//   GET   /asset-portal/repairs                     list (q, stage, category, from, to, sort, dir, page)
//   GET   /asset-portal/repairs/:id                 one repair + its history + the asset's other repairs
//   PATCH /asset-portal/repairs/:id                 { stage, estimateCost, estimateGst, expectedDate, finalCost, finalGst, invoiceNo, remarks }
//   GET   /asset-portal/history                     every change on every repair (vendor's own saves + the company's), newest first
//   GET   /asset-portal/invoices                    the repair invoices (number, file, final cost) of the vendor's repairs
//   POST  /asset-portal/repairs/:id/invoice         multipart: file (PDF / JPG / PNG) [+ invoiceNo]
//   POST  /asset-portal/repairs/:id/send-invoice   sends the repair's invoice to Accounts' review queue (same row as always); nothing is paid or posted
//   (the invoice file: the existing POST /download-link { kind: 'repair-invoice', id } -> signed GET /files/:token)
//
// ISOLATION: the vendor comes from the SESSION (VA.requireVendor), and only an ASSET vendor (utils/assetVendorPortal.js kindOfRow) gets
// in at all; any other vendor answers 403 "not available". A vendorId / vendorUserId in the query, body or path is never read (an
// unknown body field is refused). An id is only ever looked up INSIDE this vendor's own set, so someone else's asset / repair / order
// answers 403 exactly like one that does not exist.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const VA = require('../utils/vendorAuth');
const VF = require('../utils/vendorFiles');
const AVP = require('../utils/assetVendorPortal');
const SCH = require('../utils/assetVendorSchema');
const HS = require('../utils/assetHrmsScope');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const NOT_AVAILABLE = { error: 'This page is not available in the Vendor Portal.', notAvailable: true };

// Only an asset vendor. Everybody else (the finance vendors) is walled out, exactly as before this portal existed.
async function assetVendorOnly(req, res, next) {
  try {
    if ((await require('../utils/vendorKind').kindOfRow({ ...req.vendor.row, vendorId: req.vendor.vendorId })) !== 'assets') return res.status(403).json(NOT_AVAILABLE);
    req.assetVendor = {
      userId: req.vendor.userId, vendorId: req.vendor.vendorId, vendorName: req.vendor.vendorName, name: req.vendor.name, canEdit: req.vendor.canEdit, canViewCost: req.vendor.canViewCost, showAmounts: await require('../utils/assetVendorPortal').showAmountsOf(req.vendor.row), // eslint-disable-line global-require
    };
    // Lazy catch-up (2026-10-19): an approved HRMS repair complaint that has no repair job yet gets it now (idempotent, at most every 15 s).
    if (req.method === 'GET') await require('../utils/assetComplaints').reconcile(); // eslint-disable-line global-require
    return next();
  } catch (err) { return next(err); }
}
const guard = [HS.perRequest, vendorOnly, assetVendorOnly];
const send = (res, r) => res.status(r.status).json(r.body);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

router.get('/asset-portal/overview', ...guard, wrap(async (req, res) => { await SCH.ensure(); res.json(await AVP.overview(req.assetVendor)); }));

router.get('/asset-portal/assets', ...guard, wrap(async (req, res) => res.json(await AVP.listAssets(req.assetVendor, req.query || {}))));
router.get('/asset-portal/assets/:id', ...guard, wrap(async (req, res) => {
  const r = await AVP.assetDetail(req.assetVendor, req.params.id);
  return r ? res.json(r) : res.status(403).json({ error: 'Forbidden. This asset is not yours.' });
}));
router.patch('/asset-portal/assets/:id', ...guard, wrap(async (req, res) => send(res, await AVP.updateAsset(req.assetVendor, req, req.params.id, bodyOf(req)))));

router.get('/asset-portal/orders', ...guard, wrap(async (req, res) => res.json(await AVP.listOrders(req.assetVendor, req.query || {}))));
router.get('/asset-portal/orders/:id', ...guard, wrap(async (req, res) => {
  const r = await AVP.orderDetail(req.assetVendor, req.params.id);
  return r ? res.json(r) : res.status(403).json({ error: 'Forbidden. This order is not yours.' });
}));
router.post('/asset-portal/orders/:id/status', ...guard, wrap(async (req, res) => send(res, await AVP.updateOrderStatus(req.assetVendor, req, req.params.id, bodyOf(req)))));

router.get('/asset-portal/repairs', ...guard, wrap(async (req, res) => res.json(await AVP.listRepairs(req.assetVendor, req.query || {}))));
router.get('/asset-portal/repairs/:id', ...guard, wrap(async (req, res) => {
  const r = await AVP.repairDetail(req.assetVendor, req.params.id);
  return r ? res.json(r) : res.status(403).json({ error: 'Forbidden. This repair is not yours.' });
}));
router.patch('/asset-portal/repairs/:id', ...guard, wrap(async (req, res) => send(res, await AVP.updateRepair(req.assetVendor, req, req.params.id, bodyOf(req)))));

router.get('/asset-portal/history', ...guard, wrap(async (req, res) => res.json(await AVP.listHistory(req.assetVendor, req.query || {}))));
router.get('/asset-portal/invoices', ...guard, wrap(async (req, res) => res.json(await AVP.listInvoices(req.assetVendor, req.query || {}))));

router.post('/asset-portal/repairs/:id/send-invoice', ...guard, wrap(async (req, res) => send(res, await AVP.sendInvoice(req.assetVendor, req, req.params.id, bodyOf(req)))));

router.post('/asset-portal/repairs/:id/invoice', ...guard, wrap(async (req, res) => {
  const v = req.assetVendor;
  // Checked BEFORE the upload is read, so a file for somebody else's repair is never stored.
  if (!v.canEdit) return res.status(403).json({ error: 'Your login is view-only. Ask the company to allow editing.' });
  if (!(await AVP.myRepair(v, req.params.id))) return res.status(403).json({ error: 'Forbidden. This repair is not yours.' });
  let form;
  try { form = await VF.readUpload(req); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  let st;
  try { st = VF.storeFile(form.file); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  const hash = crypto.createHash('sha256').update(form.file.data).digest('hex');
  return send(res, await AVP.attachInvoice(v, req, req.params.id, st, hash, (form.fields || {}).invoiceNo));
}));

// ---- STAGE C (2026-10-28): Repairs & HRMS Tickets - accept / reject, the work, proof files, replacement, HRMS tickets (utils/assetRepairWork.js)
const RW = require('../utils/assetRepairWork');
// The repair (this vendor's own, or 403) and its current step, then the action.
const onRepair = (fn) => wrap(async (req, res) => {
  const m = await AVP.myRepair(req.assetVendor, req.params.id);
  if (!m) return res.status(403).json({ error: 'Forbidden. This repair is not yours.' });
  const r = await fn(req.assetVendor, m, AVP.stageOf(m.repair, m.side), bodyOf(req), req);
  if (r.status < 300 && !r.body.unchanged) Object.assign(r.body, await AVP.repairDetail(req.assetVendor, m.repair.id));
  return send(res, r);
});
router.post('/asset-portal/repairs/:id/decision', ...guard, onRepair((v, m, stage, body) => RW.decide(v, m, stage, body)));
router.post('/asset-portal/repairs/:id/work', ...guard, onRepair((v, m, stage, body) => RW.saveWork(v, m, stage, body)));
router.post('/asset-portal/repairs/:id/replacement', ...guard, onRepair((v, m, stage, body) => RW.requestReplacement(v, m, stage, body)));
// A proof file (photo / document of the work). Checked BEFORE the upload is read; every file is kept.
router.post('/asset-portal/repairs/:id/proof', ...guard, wrap(async (req, res) => {
  const v = req.assetVendor;
  if (!v.canEdit) return res.status(403).json({ error: 'Your login is view-only. Ask the company to allow editing.' });
  const m = await AVP.myRepair(v, req.params.id);
  if (!m) return res.status(403).json({ error: 'Forbidden. This repair is not yours.' });
  if (m.repair.status === 'Cancelled') return res.status(409).json({ error: 'The company cancelled this repair, so it cannot be changed.' });
  let form;
  try { form = await VF.readUpload(req); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  let st;
  try { st = VF.storeFile(form.file); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  const hash = crypto.createHash('sha256').update(form.file.data).digest('hex');
  const r = await RW.addProof(v, m, st, hash, (form.fields || {}).note);
  if (r.body.removeStored || r.status >= 400) { require('../utils/attachments').remove(st.billFile); delete r.body.removeStored; } // eslint-disable-line global-require
  if (r.status < 300) Object.assign(r.body, await AVP.repairDetail(v, m.repair.id));
  return send(res, r);
}));
// Every HRMS asset ticket on an asset in this vendor's own set (read only).
router.get('/asset-portal/tickets', ...guard, wrap(async (req, res) => {
  const v = req.assetVendor;
  const rows = await RW.vendorTickets(v, await HS.listing(v), await AVP.ensureMask());
  const q = req.query || {};
  const s = String(q.q || '').trim().toLowerCase();
  const state = String(q.state || '').trim();
  const kept = rows.filter((r) => (!state || r.state === state) && (!s || [r.ticketRef, r.kind, r.issue, r.assetCode, r.assetName, r.repairNo, r.raisedBy && r.raisedBy.name].some((x) => String(x || '').toLowerCase().includes(s))));
  const states = ['Open', 'Approved', 'Rejected'].map((value) => ({ value, count: rows.filter((r) => r.state === value).length }));
  res.json({ rows: kept, total: kept.length, all: rows.length, states });
}));

// Anything else under /asset-portal is not part of the portal.
router.all('/asset-portal/*', (req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
