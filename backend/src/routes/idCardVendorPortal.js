// ---------------------------------------------------------------------------
// THE ID CARD VENDOR PORTAL API - /api/vendor-portal/idcard-portal/* (2026-10-19).
// Mounted INSIDE routes/vendorPortal.js: it inherits the feature flag, the rate limit, the vendor shield and the vendor wall.
//
//   GET  /idcard-portal/overview                   Dashboard: Total / Pending / Completed / Delivered (the same rows the lists read)
//   GET  /idcard-portal/requests                   list: bucket (all|pending|completed|delivered), q, department, status, printing, delivery,
//                                                  from, to, sort, dir, page, pageSize  -> rows, total, counts, cascading facets
//   GET  /idcard-portal/requests.csv               the same filters as a CSV (ID-card fields only; needs the download tick)
//   GET  /idcard-portal/requests/:id               one request: employee details for the card, status dates, history
//   GET  /idcard-portal/requests/:id/photo         the employee's photo (needs the download tick)
//   POST /idcard-portal/orders/:id/status          { status, remarks }  one step forward; the same status again changes nothing
//   POST /idcard-portal/bulk/status                { orderIds[], status, remarks }  every id checked on its own
//   POST /idcard-portal/orders/:id/proof           multipart: file and / or remarks (challan / proof)
//   GET  /idcard-portal/notifications              company notices + unread count      POST /idcard-portal/notifications/read { ids | all }
//   (the delivery challan: the existing POST /download-link { kind: 'po-challan', id: <order id> })
//
// ISOLATION: the vendor comes from the SESSION; only an ID-card vendor (utils/vendorKind.js) gets in; any vendorId in the body or query is
// refused / ignored; an id only selects a row inside the vendor's own orders (someone else's answers 403, same as a missing one).
// ---------------------------------------------------------------------------
const express = require('express');
const VA = require('../utils/vendorAuth');
const VF = require('../utils/vendorFiles');
const KIND = require('../utils/vendorKind');
const IDC = require('../utils/idCardVendorPortal');
const SCH = require('../utils/idCardVendorSchema');
const VP = require('../utils/vendorPortal');
const DB = require('../utils/vmDb');
const { toCsv } = require('../utils/tabularExport');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const NOT_AVAILABLE = { error: 'This page is not available in the Vendor Portal.', notAvailable: true };

async function idCardVendorOnly(req, res, next) {
  try {
    if ((await KIND.kindOfRow({ ...req.vendor.row, vendorId: req.vendor.vendorId })) !== 'idcards') return res.status(403).json(NOT_AVAILABLE);
    req.idv = { userId: req.vendor.userId, vendorId: req.vendor.vendorId, vendorName: req.vendor.vendorName, name: req.vendor.name };
    req.idPerms = await IDC.permsOf(req.vendor.row);
    return next();
  } catch (err) { return next(err); }
}
const guard = [vendorOnly, idCardVendorOnly];
const send = (res, r) => res.status(r.status).json(r.body);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const ready = async (res) => ((await DB.ready()) ? true : (res.status(503).json(DB.NOT_READY), false));

router.get('/idcard-portal/overview', ...guard, wrap(async (req, res) => res.json(await IDC.overview(req.idv, req.idPerms))));
router.get('/idcard-portal/requests', ...guard, wrap(async (req, res) => res.json(await IDC.listRequests(req.idv, req.idPerms, req.query || {}))));

router.get('/idcard-portal/requests.csv', ...guard, wrap(async (req, res) => {
  if (!req.idPerms.download) return res.status(403).json({ error: 'Your login cannot download. Ask the company.' });
  if (!(await ready(res))) return undefined;
  const rows = await IDC.exportRows(req.idv, req.query || {});
  await VP.auditReq(req, { vendorId: req.idv.vendorId, vendorUserId: req.idv.userId, actorName: `${req.idv.name} (vendor ${req.idv.vendorName})`, role: 'Vendor', action: 'ID card requests exported', documentName: 'id-card-requests.csv', newValue: `${rows.length} row(s)` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="id-card-requests.csv"');
  return res.send(`﻿${toCsv(IDC.CSV_HEAD, rows)}`);
}));

router.get('/idcard-portal/requests/:id', ...guard, wrap(async (req, res) => {
  const r = await IDC.requestDetail(req.idv, req.idPerms, req.params.id);
  return r ? res.json(r) : res.status(403).json(IDC.NOT_YOURS);
}));
router.get('/idcard-portal/requests/:id/photo', ...guard, wrap(async (req, res) => {
  const p = await IDC.photoOf(req.idv, req.idPerms, req.params.id);
  if (!p) return res.status(404).json({ error: 'No photo for this person.' });
  res.setHeader('Content-Type', p.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
  return res.sendFile(p.full);
}));

router.post('/idcard-portal/orders/:id/status', ...guard, wrap(async (req, res) => {
  const b = bodyOf(req);
  const bad = Object.keys(b).filter((k) => !['status', 'remarks'].includes(k));
  if (bad.length) return res.status(400).json({ error: 'You can send only the status and a remark.', refusedFields: bad });
  if (!(await ready(res))) return undefined;
  return send(res, await IDC.moveOrder(req.idv, req, req.idPerms, req.params.id, VP.str(b.status), b.remarks));
}));
router.post('/idcard-portal/bulk/status', ...guard, wrap(async (req, res) => {
  const b = bodyOf(req);
  const bad = Object.keys(b).filter((k) => !['orderIds', 'status', 'remarks'].includes(k));
  if (bad.length) return res.status(400).json({ error: 'You can send only the orders, the status and a remark.', refusedFields: bad });
  if (!(await ready(res))) return undefined;
  return send(res, await IDC.bulkMove(req.idv, req, req.idPerms, b.orderIds, VP.str(b.status), b.remarks));
}));
router.post('/idcard-portal/orders/:id/proof', ...guard, wrap(async (req, res) => {
  if (!(await ready(res))) return undefined;
  if (!req.idPerms.uploadProof) return res.status(403).json({ error: 'Your login cannot upload proof. Ask the company.' });
  if (!(await IDC.myOrder(req.idv, req.params.id))) return res.status(403).json(IDC.NOT_YOURS); // before the upload is read
  let form;
  try { form = await VF.readUpload(req); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  const remarks = VP.cleanText((form.fields || {}).remarks, 800);
  if (!form.file && !remarks) return res.status(400).json({ error: 'Attach the challan or proof file, or write a remark.' });
  let st = null;
  if (form.file) { try { st = VF.storeFile(form.file); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); } }
  return send(res, await IDC.saveProof(req.idv, req, req.idPerms, req.params.id, remarks, st));
}));

router.get('/idcard-portal/notifications', ...guard, wrap(async (req, res) => res.json(await IDC.notifications(req.idv, req.idv.userId))));
router.post('/idcard-portal/notifications/read', ...guard, wrap(async (req, res) => {
  const b = bodyOf(req);
  await SCH.ensure();
  const r = await IDC.markRead(req.idv, req.idv.userId, b.ids, b.all === true);
  return res.json({ ...r, ...(await IDC.notifications(req.idv, req.idv.userId)) });
}));

router.all('/idcard-portal/*', (req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
