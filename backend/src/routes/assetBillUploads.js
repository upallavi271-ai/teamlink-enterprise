// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL - UPLOAD A REPAIR BILL (handwritten, printed, photo, scan, PDF) - /api/vendor-portal/asset-portal/bill-uploads/* (2026-10-21).
// Mounted INSIDE routes/vendorPortal.js (before routes/assetVendorPortal.js, whose last line refuses every other /asset-portal path), so it
// inherits the feature flag, the rate limit, the vendor shield and the vendor wall.
//
//   GET   /bill-uploads/options            what the upload window offers: the vendor's own repairs and assets, the limits, is AI reading on
//   GET   /bill-uploads/summary            { total, unseen }  (the "New" badge)
//   GET   /bill-uploads                    "My bills": q, status, from, to, sort, dir, page (own uploads only)
//   POST  /bill-uploads                    multipart: file (1 to 5) + [repairId] [assetId] [remarks] [submit=false] [correctsId]   header Idempotency-Key
//   GET   /bill-uploads/:id                one bill: files, the fields read, notices, history
//   PATCH /bill-uploads/:id                correct what the AI got wrong (before approval)   { invoiceNo, invoiceDate, ..., lines, repairId, assetId, remarks, updatedAt }
//   POST  /bill-uploads/:id/submit         send a bill that is "Not sent yet" (also after Accounts sent it back)
//   POST  /bill-uploads/:id/replace        multipart: a new file for this bill (new version; the old one stays in the history)
//   POST  /bill-uploads/:id/correct        multipart: a corrected bill after a rejection (a new bill linked to the rejected one)
//   (the files: POST /download-link { kind: 'bill-upload', id: '<uploadId>:<fileId>' } -> signed GET /files/:token)
//
// ISOLATION: the vendor comes from the SESSION; only an ASSET vendor gets in; a vendorId / vendorUserId anywhere in the request is never read
// (an unknown field is refused). An upload, a repair or an asset id only selects a row INSIDE this vendor's own set; somebody else's answers 403
// exactly like one that does not exist. The AI's raw answer, the model, confidences and Accounts' notes are never in an answer.
// ---------------------------------------------------------------------------
const express = require('express');
const VA = require('../utils/vendorAuth');
const HS = require('../utils/assetHrmsScope');
const BU = require('../utils/billUploads');
const F = require('../utils/billUploadFiles');
const VC = require('../utils/vendorConfig');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const NOT_AVAILABLE = { error: 'This page is not available in the Vendor Portal.', notAvailable: true };

async function assetVendorOnly(req, res, next) {
  try {
    if ((await require('../utils/vendorKind').kindOfRow({ ...req.vendor.row, vendorId: req.vendor.vendorId })) !== 'assets') return res.status(403).json(NOT_AVAILABLE); // eslint-disable-line global-require
    req.assetVendor = {
      userId: req.vendor.userId, vendorId: req.vendor.vendorId, vendorName: req.vendor.vendorName, name: req.vendor.name, canEdit: req.vendor.canEdit, canViewCost: req.vendor.canViewCost,
      showAmounts: await require('../utils/assetVendorPortal').showAmountsOf(req.vendor.row), // eslint-disable-line global-require
    };
    return next();
  } catch (err) { return next(err); }
}
const guard = [HS.perRequest, vendorOnly, assetVendorOnly];
const send = (res, r) => res.status(r.status).json(r.body);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const FORBIDDEN = { error: 'Forbidden. This bill is not yours.' };
const idemOf = (req) => {
  const k = String(req.get('idempotency-key') || '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(k) ? k : null;
};

async function readForm(req, res) {
  try {
    return await F.parseMultipartMany(req, { maxBytesEach: VC.CFG.uploadMaxBytes, maxFiles: F.MAX_FILES });
  } catch (err) {
    res.status(err && err.code === 'TOO_LARGE' ? 413 : 400).json({ error: F.messageOf(err), code: err && err.code });
    return null;
  }
}
// The fields of an upload form. A vendorId / vendorUserId would be refused by createUpload ("unknown field").
const fieldsOf = (form) => ({ ...(form.fields || {}) });

const B = '/asset-portal/bill-uploads';
router.get(`${B}/options`, ...guard, wrap(async (req, res) => res.json(await BU.optionsFor(req.assetVendor))));
router.get(`${B}/summary`, ...guard, wrap(async (req, res) => res.json(await BU.summaryFor(req.assetVendor))));
router.get(B, ...guard, wrap(async (req, res) => res.json(await BU.listForVendor(req.assetVendor, req.query || {}))));

router.post(B, ...guard, wrap(async (req, res) => {
  const v = req.assetVendor;
  if (!v.canEdit) return res.status(403).json({ error: 'Your login is view-only. Ask the company to allow editing.' });
  const form = await readForm(req, res);
  if (!form) return undefined;
  return send(res, await BU.createUpload(v, req, { files: form.files, fields: fieldsOf(form), idemKey: idemOf(req) }));
}));

router.get(`${B}/:id`, ...guard, wrap(async (req, res) => {
  const r = await BU.detailForVendor(req.assetVendor, req.params.id);
  return r ? res.json(r) : res.status(403).json(FORBIDDEN);
}));
router.patch(`${B}/:id`, ...guard, wrap(async (req, res) => send(res, await BU.vendorEdit(req.assetVendor, req, req.params.id, bodyOf(req)))));
router.post(`${B}/:id/submit`, ...guard, wrap(async (req, res) => send(res, await BU.vendorSubmit(req.assetVendor, req, req.params.id))));

// A new file for a bill. Ownership is checked BEFORE the upload is read, so a file for somebody else's bill is never stored.
async function again(req, res, key) {
  const v = req.assetVendor;
  if (!v.canEdit) return res.status(403).json({ error: 'Your login is view-only. Ask the company to allow editing.' });
  if (!(await BU.mine(v, req.params.id))) return res.status(403).json(FORBIDDEN);
  const form = await readForm(req, res);
  if (!form) return undefined;
  const fields = fieldsOf(form);
  if (fields.correctsId !== undefined || fields.replacesId !== undefined) return res.status(400).json({ error: 'Only the files, the repair, the asset and a remark can be sent.', refusedFields: ['correctsId', 'replacesId'].filter((k) => fields[k] !== undefined) });
  fields[key] = req.params.id;
  return send(res, await BU.createUpload(v, req, { files: form.files, fields, idemKey: idemOf(req) }));
}
router.post(`${B}/:id/replace`, ...guard, wrap((req, res) => again(req, res, 'replacesId')));
router.post(`${B}/:id/correct`, ...guard, wrap((req, res) => again(req, res, 'correctsId')));

// Anything else under bill-uploads is not part of the portal.
router.all(`${B}/*`, (req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
