// ---------------------------------------------------------------------------
// VENDOR PORTAL — THE MODULE SCREENS' API (2026-10-14). Mounted INSIDE routes/vendorPortal.js, so it inherits the
// feature flag, the rate limit, the vendor shield and (per route) VA.requireVendor: vendorId / vendorUserId come from
// the session, never from the request.
//
// EVERY route here is behind utils/vendorModules.js guard(moduleKey, permission): a module the login does not have
// answers 403 (and so does an unticked permission). Out-of-reach and does-not-exist give the SAME 403, so ids cannot
// be probed. The Admin PREVIEW session is read-only: requireVendor refuses every non-GET for it.
//
//   ID Card Orders  GET /id-card-orders · /:id · /:id/lines.csv · /:id/photos.zip · /:id/lines/:lineId/photo · /:id/challan
//                   POST /:id/status · /:id/proof
//   SIM             GET /sim · POST /sim/:id/status · POST /sim/requests/:id/update
//   Bills           GET/POST /module-bills (invoice | monthly_bill) · GET /module-bills/:id/document
//   Office          GET /office · POST /office/receipts
//   Expenses        GET /expenses            Payments  GET /payments
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const attachments = require('../utils/attachments');
const VA = require('../utils/vendorAuth');
const VP = require('../utils/vendorPortal');
const VC = require('../utils/vendorConfig');
const VF = require('../utils/vendorFiles');
const VM = require('../utils/vendorModules');
const DB = require('../utils/vmDb');
const { toCsv, zipBuffers } = require('../utils/tabularExport');

const router = express.Router();
const vendorOnly = VA.requireVendor();
const { str, ROUND } = VP;
const NOT_YOURS = { error: 'Forbidden. This is not yours.' };
const ORDER_FLOW = ['New', 'Received', 'Printing', 'Ready', 'Delivered'];
const STAMP = { Received: 'receivedAt', Printing: 'printingAt', Ready: 'readyAt', Delivered: 'deliveredAt' };
const SIM_STATUSES = ['Active', 'Suspended', 'Disconnected'];
const REQ_FLOW = { Open: ['In progress', 'Done', 'Rejected'], 'In progress': ['Done', 'Rejected'] };
const IDEM_RE = /^[A-Za-z0-9_-]{8,80}$/;
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const r = String(v ?? '').replace(/[,\s₹]/g, ''); if (r === '') return null; const n = Number(r); return Number.isFinite(n) ? ROUND(n) : NaN; };
const actorLine = (req) => `${req.vendor.name} (vendor ${req.vendor.vendorName})`;
const audit = (req, row) => VP.auditReq(req, { vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: actorLine(req), role: 'Vendor', ...row });

// The tables exist? (feature-detected: until the migration is applied these screens say so, nothing else breaks)
router.use(async (req, res, next) => {
  const p = String(req.path || '');
  if (!/^\/(id-card-orders|sim|module-bills|office|expenses|payments)(\/|$)/.test(p)) return next();
  if (p.startsWith('/expenses') || p.startsWith('/payments')) return next(); // read the old tables only
  if (await DB.ready()) return next();
  return res.status(503).json(DB.NOT_READY);
});

// ============================================================================
// ID CARD ORDERS
// ============================================================================
const orderView = (o, extra = {}) => ({
  id: o.id, orderCode: o.orderCode, status: o.status, note: o.note || null, vendorRemarks: o.vendorRemarks || null,
  hasChallan: !!o.challanFile, challanName: o.challanName || null,
  nextStatus: ORDER_FLOW[ORDER_FLOW.indexOf(o.status) + 1] || null,
  createdAt: DB.toDate(o.createdAt), receivedAt: DB.toDate(o.receivedAt), printingAt: DB.toDate(o.printingAt), readyAt: DB.toDate(o.readyAt), deliveredAt: DB.toDate(o.deliveredAt),
  ...extra,
});
const lineView = (l) => ({
  id: l.id, employeeCode: l.employeeCode, employeeName: l.employeeName, designation: l.designation, department: l.department,
  bloodGroup: l.bloodGroup, cardType: l.cardType, hasPhoto: !!l.photoDocId,
});
async function myOrder(req, id) {
  return DB.one('SELECT * FROM "IdCardOrder" WHERE "id" = ? AND "vendorId" = ?', [String(id || ''), req.vendor.vendorId]);
}

router.get('/id-card-orders', vendorOnly, VM.guard('id_card_orders'), async (req, res) => {
  const rows = await DB.q('SELECT o.*, (SELECT COUNT(*) FROM "IdCardOrderLine" l WHERE l."orderId" = o."id") AS "lineCount" FROM "IdCardOrder" o WHERE o."vendorId" = ? ORDER BY o."createdAt" DESC', [req.vendor.vendorId]);
  const perms = req.vendor.modules.get('id_card_orders').permissions;
  res.json({
    rows: rows.map((o) => orderView(o, { lineCount: o.lineCount })),
    canUpdate: CFGperm('id_card_orders', perms, 'updateStatus'), canDownload: CFGperm('id_card_orders', perms, 'download'), canProof: CFGperm('id_card_orders', perms, 'uploadProof'),
  });
});
const CFGperm = (k, perms, p) => VM.CFG.permAllowed(k, perms, p);

router.get('/id-card-orders/:id', vendorOnly, VM.guard('id_card_orders'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o) return res.status(403).json(NOT_YOURS);
  const [lines, events, bills] = await Promise.all([
    DB.q('SELECT * FROM "IdCardOrderLine" WHERE "orderId" = ? ORDER BY "employeeName"', [o.id]),
    DB.q('SELECT * FROM "IdCardOrderEvent" WHERE "orderId" = ? ORDER BY "createdAt" ASC', [o.id]),
    DB.q('SELECT * FROM "VendorModuleBill" WHERE "orderId" = ? AND "vendorId" = ? ORDER BY "createdAt" DESC', [o.id, req.vendor.vendorId]),
  ]);
  const perms = req.vendor.modules.get('id_card_orders').permissions;
  res.json({
    order: orderView(o, { lineCount: lines.length }),
    lines: lines.map(lineView),
    history: events.map((e) => ({ id: e.id, from: e.fromStatus, to: e.toStatus, by: e.actorKind === 'Vendor' ? 'You' : 'Company', note: e.note, at: DB.toDate(e.createdAt) })),
    bills: bills.map(VM.billView),
    canUpdate: CFGperm('id_card_orders', perms, 'updateStatus'), canDownload: CFGperm('id_card_orders', perms, 'download'), canProof: CFGperm('id_card_orders', perms, 'uploadProof'),
  });
});

// Status moves ONE step forward: New -> Received -> Printing -> Ready -> Delivered. No skipping, no going back.
router.post('/id-card-orders/:id/status', vendorOnly, VM.guard('id_card_orders', 'updateStatus'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o) return res.status(403).json(NOT_YOURS);
  const want = str((req.body || {}).status);
  const next = ORDER_FLOW[ORDER_FLOW.indexOf(o.status) + 1];
  if (!ORDER_FLOW.includes(want)) return res.status(400).json({ error: 'Pick a proper status.', field: 'status' });
  if (!next) return res.status(409).json({ error: 'This order is already Delivered.' });
  if (want !== next) return res.status(409).json({ error: `This order is ${o.status}. The next step is ${next}: steps cannot be skipped or taken back.`, expected: next });
  const remarks = VP.cleanText((req.body || {}).remarks, 500);
  const t = DB.now();
  const n = await DB.run(`UPDATE "IdCardOrder" SET "status" = ?, "${STAMP[want]}" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = ?`, [want, t, t, o.id, o.status]);
  if (!n) return res.status(409).json({ error: 'This order was just changed. Refresh and try again.' });
  await DB.run('INSERT INTO "IdCardOrderEvent" ("id","orderId","fromStatus","toStatus","actorKind","actorName","note","createdAt") VALUES (?,?,?,?,?,?,?,?)', [DB.newId(), o.id, o.status, want, 'Vendor', actorLine(req), remarks || null, t]);
  await audit(req, { action: 'ID card order status changed', field: 'status', oldValue: o.status, newValue: want, status: o.orderCode });
  await VM.notifyCompany({
    creatorId: o.createdById, title: `ID card order ${o.orderCode} is now ${want}`, message: `${req.vendor.vendorName} marked ID card order ${o.orderCode} as ${want}.${remarks ? ` Remark: ${remarks}` : ''}`,
    task: { key: `ID cards ${o.orderCode}`, label: want, done: want === 'Delivered' },
  });
  const fresh = await myOrder(req, o.id);
  return res.json({ order: orderView(fresh), message: `Order ${o.orderCode} is now ${want}. The company has been told.` });
});

// Delivery challan / proof file and / or a remark.
router.post('/id-card-orders/:id/proof', vendorOnly, VM.guard('id_card_orders', 'uploadProof'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o) return res.status(403).json(NOT_YOURS);
  let form;
  try { form = await VF.readUpload(req); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  const remarks = VP.cleanText((form.fields || {}).remarks, 800);
  if (!form.file && !remarks) return res.status(400).json({ error: 'Attach the challan or proof file, or write a remark.' });
  let st = null;
  if (form.file) { try { st = VF.storeFile(form.file); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); } }
  const t = DB.now();
  const old = o.challanFile;
  await DB.run('UPDATE "IdCardOrder" SET "vendorRemarks" = ?, "challanFile" = ?, "challanName" = ?, "challanMime" = ?, "challanSize" = ?, "updatedAt" = ? WHERE "id" = ?', [
    remarks || o.vendorRemarks || null, st ? st.billFile : o.challanFile, st ? st.billName : o.challanName, st ? st.billMime : o.challanMime, st ? st.billSize : o.challanSize, t, o.id]);
  if (st && old) attachments.remove(old);
  await DB.run('INSERT INTO "IdCardOrderEvent" ("id","orderId","fromStatus","toStatus","actorKind","actorName","note","createdAt") VALUES (?,?,?,?,?,?,?,?)', [DB.newId(), o.id, o.status, o.status, 'Vendor', actorLine(req), `${st ? `Proof uploaded (${st.billName}). ` : ''}${remarks}`.trim(), t]);
  await audit(req, { action: st ? 'ID card order proof uploaded' : 'ID card order remark added', documentName: st ? st.billName : null, newValue: remarks || null, status: o.orderCode });
  await VM.notifyCompany({ creatorId: o.createdById, title: `ID card order ${o.orderCode}: note from the vendor`, message: `${req.vendor.vendorName} ${st ? 'uploaded a challan / proof' : 'added a remark'} on order ${o.orderCode}.${remarks ? ` ${remarks}` : ''}` });
  return res.status(201).json({ order: orderView(await myOrder(req, o.id)), message: 'Saved. The company has been told.' });
});

router.get('/id-card-orders/:id/challan', vendorOnly, VM.guard('id_card_orders'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o || !o.challanFile) return res.status(403).json(NOT_YOURS);
  return VF.sendStored(res, o.challanFile, o.challanMime, o.challanName);
});

const photoOf = async (line) => {
  if (!line.photoDocId) return null;
  const d = await prisma.employeeDocument.findFirst({ where: { id: line.photoDocId, employeeId: line.employeeId } });
  if (!d || !['image/jpeg', 'image/png', 'image/webp'].includes(d.mime)) return null;
  const full = attachments.resolveStored(d.file);
  return full ? { full, mime: d.mime, ext: attachments.ALLOWED[d.mime] || 'jpg' } : null;
};
router.get('/id-card-orders/:id/lines/:lineId/photo', vendorOnly, VM.guard('id_card_orders', 'download'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o) return res.status(403).json(NOT_YOURS);
  const l = await DB.one('SELECT * FROM "IdCardOrderLine" WHERE "id" = ? AND "orderId" = ?', [String(req.params.lineId), o.id]);
  const p = l && (await photoOf(l));
  if (!p) return res.status(404).json({ error: 'No photo for this person.' });
  res.setHeader('Content-Type', p.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
  return res.sendFile(p.full);
});

const CSV_HEAD = ['Order', 'Employee ID', 'Name', 'Designation', 'Department', 'Blood group', 'Card type', 'Photo file'];
const photoName = (l, ext) => `${String(l.employeeCode || l.id).replace(/[^A-Za-z0-9_-]/g, '')}_${String(l.employeeName).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}.${ext}`;
router.get('/id-card-orders/:id/lines.csv', vendorOnly, VM.guard('id_card_orders', 'download'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o) return res.status(403).json(NOT_YOURS);
  const lines = await DB.q('SELECT * FROM "IdCardOrderLine" WHERE "orderId" = ? ORDER BY "employeeName"', [o.id]);
  const rows = [];
  for (const l of lines) { const p = await photoOf(l); rows.push([o.orderCode, l.employeeCode, l.employeeName, l.designation, l.department, l.bloodGroup, l.cardType, p ? `photos/${photoName(l, p.ext)}` : '']); } // eslint-disable-line no-await-in-loop
  await audit(req, { action: 'ID card order data downloaded', documentName: `${o.orderCode}.csv`, status: o.orderCode });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${o.orderCode}.csv"`);
  return res.send(`﻿${toCsv(CSV_HEAD, rows)}`);
});
router.get('/id-card-orders/:id/photos.zip', vendorOnly, VM.guard('id_card_orders', 'download'), async (req, res) => {
  const o = await myOrder(req, req.params.id);
  if (!o) return res.status(403).json(NOT_YOURS);
  const lines = await DB.q('SELECT * FROM "IdCardOrderLine" WHERE "orderId" = ? ORDER BY "employeeName"', [o.id]);
  const entries = []; const rows = [];
  const fs = require('fs'); // eslint-disable-line global-require
  for (const l of lines) {
    // eslint-disable-next-line no-await-in-loop
    const p = await photoOf(l);
    let name = '';
    if (p) { name = `photos/${photoName(l, p.ext)}`; entries.push({ name, data: fs.readFileSync(p.full) }); }
    rows.push([o.orderCode, l.employeeCode, l.employeeName, l.designation, l.department, l.bloodGroup, l.cardType, name]);
  }
  entries.unshift({ name: `${o.orderCode}.csv`, data: Buffer.from(`﻿${toCsv(CSV_HEAD, rows)}`, 'utf8') });
  await audit(req, { action: 'ID card order photos downloaded', documentName: `${o.orderCode}.zip`, status: o.orderCode, newValue: `${entries.length - 1} photo(s)` });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${o.orderCode}.zip"`);
  return res.send(zipBuffers(entries));
});

// ============================================================================
// SIM AND CONNECTIONS
// ============================================================================
const simView = (s) => ({ id: s.id, mobileNumber: s.mobileNumber, simSerial: s.simSerial || null, plan: s.plan || null, employeeName: s.employeeName || null, status: s.status, notes: s.notes || null, updatedAt: DB.toDate(s.updatedAt) });
const reqView = (r, simNo) => ({ id: r.id, requestCode: r.requestCode, kind: r.kind, details: r.details || null, status: r.status, vendorNote: r.vendorNote || null, simNumber: simNo || null, nextStatuses: REQ_FLOW[r.status] || [], createdAt: DB.toDate(r.createdAt), updatedAt: DB.toDate(r.updatedAt) });

router.get('/sim', vendorOnly, VM.guard('sim_connections'), async (req, res) => {
  const [sims, reqs] = await Promise.all([
    DB.q('SELECT * FROM "SimConnection" WHERE "vendorId" = ? ORDER BY "mobileNumber"', [req.vendor.vendorId]),
    DB.q('SELECT * FROM "SimRequest" WHERE "vendorId" = ? ORDER BY "createdAt" DESC', [req.vendor.vendorId]),
  ]);
  const no = new Map(sims.map((s) => [s.id, s.mobileNumber]));
  const perms = req.vendor.modules.get('sim_connections').permissions;
  res.json({
    rows: sims.map(simView), requests: reqs.map((r) => reqView(r, no.get(r.simId))),
    summary: { total: sims.length, active: sims.filter((s) => s.status === 'Active').length, suspended: sims.filter((s) => s.status === 'Suspended').length, disconnected: sims.filter((s) => s.status === 'Disconnected').length },
    canUpdate: CFGperm('sim_connections', perms, 'updateStatus'), canHandle: CFGperm('sim_connections', perms, 'handleRequests'),
  });
});

router.post('/sim/requests/:id/update', vendorOnly, VM.guard('sim_connections', 'handleRequests'), async (req, res) => {
  const r = await DB.one('SELECT * FROM "SimRequest" WHERE "id" = ? AND "vendorId" = ?', [String(req.params.id), req.vendor.vendorId]);
  if (!r) return res.status(403).json(NOT_YOURS);
  const want = str((req.body || {}).status);
  if (!(REQ_FLOW[r.status] || []).includes(want)) return res.status(409).json({ error: `This request is ${r.status}. It can go to: ${(REQ_FLOW[r.status] || []).join(', ') || 'nowhere (it is closed)'}.` });
  const note = VP.cleanText((req.body || {}).note, 500);
  const n = await DB.run('UPDATE "SimRequest" SET "status" = ?, "vendorNote" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = ?', [want, note || r.vendorNote || null, DB.now(), r.id, r.status]);
  if (!n) return res.status(409).json({ error: 'This request was just changed. Refresh and try again.' });
  await audit(req, { action: 'SIM request status changed', field: 'status', oldValue: r.status, newValue: want, status: r.requestCode });
  await VM.notifyCompany({ creatorId: r.createdById, title: `SIM request ${r.requestCode} is now ${want}`, message: `${req.vendor.vendorName} updated ${r.kind} request ${r.requestCode} to ${want}.${note ? ` ${note}` : ''}` });
  const fresh = await DB.one('SELECT * FROM "SimRequest" WHERE "id" = ?', [r.id]);
  return res.json({ request: reqView(fresh), message: 'Saved. The company has been told.' });
});

router.post('/sim/:id/status', vendorOnly, VM.guard('sim_connections', 'updateStatus'), async (req, res) => {
  const s = await DB.one('SELECT * FROM "SimConnection" WHERE "id" = ? AND "vendorId" = ?', [String(req.params.id), req.vendor.vendorId]);
  if (!s) return res.status(403).json(NOT_YOURS);
  const want = str((req.body || {}).status);
  if (!SIM_STATUSES.includes(want)) return res.status(400).json({ error: 'Pick Active, Suspended or Disconnected.', field: 'status' });
  if (s.status === want) return res.json({ sim: simView(s), message: 'Nothing changed.' });
  if (s.status === 'Disconnected') return res.status(409).json({ error: 'This number is Disconnected. It cannot be switched on again here: ask the company to raise a new connection request.' });
  const n = await DB.run('UPDATE "SimConnection" SET "status" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = ?', [want, DB.now(), s.id, s.status]);
  if (!n) return res.status(409).json({ error: 'This number was just changed. Refresh and try again.' });
  await audit(req, { assetId: s.assetId || null, action: 'SIM status changed', field: 'status', oldValue: s.status, newValue: want, status: s.mobileNumber });
  await VM.notifyCompany({ creatorId: s.createdById, title: `SIM ${s.mobileNumber} is now ${want}`, message: `${req.vendor.vendorName} changed ${s.mobileNumber}${s.employeeName ? ` (${s.employeeName})` : ''} from ${s.status} to ${want}.` });
  const fresh = await DB.one('SELECT * FROM "SimConnection" WHERE "id" = ?', [s.id]);
  return res.json({ sim: simView(fresh), message: `${s.mobileNumber} is now ${want}. The company has been told.` });
});

// ============================================================================
// INVOICES / MONTHLY BILLS (module bills)
// ============================================================================
const KIND_MODULE = { invoice: ['invoices', 'raise'], monthly_bill: ['monthly_bills', 'upload'], receipt: ['office', 'uploadReceipts'] };
const VIEW_PERM = { invoices: 'viewStatus', monthly_bills: 'viewStatus', office: 'viewHistory' };

router.get('/module-bills', vendorOnly, async (req, res) => {
  const kind = ['invoice', 'monthly_bill'].includes(str(req.query.kind)) ? str(req.query.kind) : 'invoice';
  const [mk] = KIND_MODULE[kind];
  const a = await VM.allows(req, mk, VIEW_PERM[mk]);
  if (!a.ok) return res.status(403).json(a.body);
  const mine = await VM.allows(req, mk, KIND_MODULE[kind][1]);
  const rows = await DB.q('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = ? ORDER BY "createdAt" DESC', [req.vendor.vendorId, kind]);
  const s = str(req.query.q).toLowerCase();
  const out = rows.map(VM.billView).filter((b) => !s || [b.billNumber, b.billCode, b.periodLabel, b.statusText].some((x) => String(x || '').toLowerCase().includes(s)));
  res.json({ rows: out, total: rows.length, canRaise: mine.ok });
});

function billInput(kind, f) {
  const out = {};
  out.billNumber = VP.cleanText(f.billNumber, 60);
  if (!out.billNumber) return { error: kind === 'monthly_bill' ? 'Enter the bill number.' : 'Enter the invoice number.', field: 'billNumber' };
  if (kind === 'monthly_bill') {
    out.period = str(f.period);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(out.period)) return { error: 'Pick the month this bill is for.', field: 'period' };
    out.dueDate = str(f.dueDate);
    if (!VP.isRealDay(out.dueDate)) return { error: 'Pick the due date.', field: 'dueDate' };
    out.billDate = VP.isRealDay(f.billDate) ? str(f.billDate) : today();
  } else {
    out.billDate = str(f.billDate);
    if (!VP.isRealDay(out.billDate)) return { error: 'Pick the invoice date.', field: 'billDate' };
    if (out.billDate > today()) return { error: 'The invoice date cannot be in the future.', field: 'billDate' };
    out.dueDate = VP.isRealDay(f.dueDate) ? str(f.dueDate) : null;
  }
  let lines = [];
  if (f.lines !== undefined && str(f.lines)) {
    try { lines = JSON.parse(f.lines); } catch { return { error: 'The per-number charges could not be read.', field: 'lines' }; }
    if (!Array.isArray(lines) || lines.length > 500) return { error: 'The per-number charges could not be read.', field: 'lines' };
    lines = lines.map((l) => ({ number: VP.cleanText(l && l.number, 30), description: VP.cleanText(l && l.description, 80), amount: num(l && l.amount) })).filter((l) => l.number || l.description || l.amount);
    if (lines.some((l) => !Number.isFinite(l.amount) || l.amount < 0)) return { error: 'Each charge must be a number of 0 or more.', field: 'lines' };
  }
  out.lines = lines;
  const qty = num(f.quantity); const rate = num(f.rate); let amount = num(f.amount);
  if (Number.isNaN(qty) || Number.isNaN(rate) || Number.isNaN(amount) || (qty != null && qty < 0) || (rate != null && rate < 0)) return { error: 'Quantity, rate and amount must be numbers of 0 or more.', field: 'amount' };
  if (kind === 'invoice' && qty != null && rate != null) amount = ROUND(qty * rate);
  if ((amount == null || amount === 0) && lines.length) amount = ROUND(lines.reduce((t, l) => t + l.amount, 0));
  if (!(amount > 0)) return { error: kind === 'invoice' ? 'Enter the quantity and rate (or the amount).' : 'Enter the bill amount.', field: 'amount' };
  out.quantity = qty; out.rate = rate; out.amount = amount;
  const gst = num(f.gst);
  if (Number.isNaN(gst) || (gst != null && gst < 0)) return { error: 'GST must be a number of 0 or more.', field: 'gst' };
  out.gst = gst || 0;
  out.total = ROUND(out.amount + out.gst);
  out.remarks = VP.cleanText(f.remarks, 1000) || null;
  return { data: out };
}

// opt (2026-10-19, used by the Airtel Bills portal's "Send a bill"; the finance / office screens pass nothing and behave exactly as before):
//   perm [moduleKey, permKey]   the tick that allows the upload      allowedFields[]   any other form field is refused (400)
//   extraCheck(d, fields)       -> { error, field, status? } to refuse (a duplicate in Accounts), or null
async function createBill(req, res, kind, opt = {}) {
  const [mk, pk] = opt.perm || KIND_MODULE[kind];
  const a = await VM.allows(req, mk, pk);
  if (!a.ok) return res.status(403).json(a.body);
  const idem = str(req.get('idempotency-key'));
  if (idem && !IDEM_RE.test(idem)) return res.status(400).json({ error: 'This form cannot be sent safely. Close it, open it again and send.' });
  if (idem) {
    const prev = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "vendorUserId" = ? AND "idempotencyKey" = ?', [req.vendor.userId, idem]);
    if (prev) { res.set('Idempotent-Replay', 'true'); return res.status(201).json({ bill: VM.billView(prev), duplicateRequest: true, message: 'Already sent.' }); }
  }
  let form;
  try { form = await VF.readUpload(req); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  const f = form.fields || {};
  if (opt.allowedFields) {
    const bad = Object.keys(f).filter((k) => !opt.allowedFields.includes(k));
    if (bad.length) return res.status(400).json({ error: 'A vendor cannot set a status or a payment. Send only the bill details and the file.', refusedFields: bad });
  }
  const out = await saveBill(req, kind, f, form.file, { extraCheck: opt.extraCheck, idem });
  return res.status(out.status).json(out.body);
}

// THE ONE PLACE A VENDOR BILL IS CHECKED AND SAVED (2026-10-19: split out of createBill so the vendor "Import bills" runs the very same rules, one
// row at a time). The caller has already checked the permission tick. Returns { status, body } and never writes to `res`.
//   file    the uploaded file (PDF / JPG / PNG) or null; a bill WITHOUT a file is accepted only with opt.noFile (an Excel import row)
//   opt     extraCheck  as above · idem  the Idempotency-Key · dry  check every rule and save NOTHING (Import preview)
//           quiet  no bell / e-mail to the reviewers (the Import sends ONE summary) · remarksPrefix  text put in front of the remarks
async function saveBill(req, kind, f, file, opt = {}) {
  const idem = opt.idem || '';
  let d;
  if (kind === 'receipt') {
    d = { billNumber: VP.cleanText(f.billNumber, 60) || null, billDate: VP.isRealDay(f.billDate) ? str(f.billDate) : today(), period: null, dueDate: null, quantity: null, rate: null, amount: num(f.amount) || 0, gst: 0, total: num(f.amount) || 0, lines: [], remarks: VP.cleanText(f.remarks, 1000) || null };
  } else {
    const chk = billInput(kind, f);
    if (chk.error) return { status: 400, body: { error: chk.error, field: chk.field } };
    d = chk.data;
  }
  if (!file && !opt.noFile) return { status: 400, body: { error: 'Attach the file (PDF, JPG or PNG).', field: 'file' } };
  if (opt.remarksPrefix) d.remarks = `${opt.remarksPrefix}${d.remarks ? ` ${d.remarks}` : ''}`.slice(0, 1000);
  let orderId = null;
  if (kind === 'invoice' && str(f.orderId)) {
    const o = await myOrder(req, f.orderId);
    if (!o) return { status: 400, body: { error: 'Pick one of your own orders.', field: 'orderId' } };
    orderId = o.id;
  }
  const key = d.billNumber ? VP.billKey(d.billNumber) : null;
  if (key && kind !== 'receipt') {
    const dup = await DB.one('SELECT "billCode","billNumber" FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = ? AND "billNumberKey" = ? AND "status" <> \'Rejected\'', [req.vendor.vendorId, kind, key]);
    if (dup) return { status: 409, duplicate: true, body: { error: `You already sent number ${dup.billNumber} (${dup.billCode}). Use the number of this new bill.`, field: 'billNumber' } };
  }
  if (kind === 'monthly_bill') {
    const same = await DB.one('SELECT "billCode" FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = \'monthly_bill\' AND "period" = ? AND "status" <> \'Rejected\'', [req.vendor.vendorId, d.period]);
    if (same) return { status: 409, duplicate: true, body: { error: `A bill for ${VM.periodLabel(d.period)} was already sent (${same.billCode}).`, field: 'period' } };
  }
  if (opt.extraCheck) {
    const x = await opt.extraCheck(d, f);
    if (x) return { status: x.status || 409, duplicate: (x.status || 409) === 409, body: { error: x.error, field: x.field } };
  }
  if (opt.dry) return { status: 200, body: { dry: true, billNumber: d.billNumber, period: d.period, total: d.total } };
  let st = { billFile: null, billName: null, billMime: null, billSize: null };
  if (file) {
    try { st = VF.storeFile(file); } catch (err) { return { status: 400, body: { error: VF.fileError(err) } }; }
  }
  const id = DB.newId(); const t = DB.now();
  let code = null;
  for (let i = 0; i < 5 && !code; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const c = await DB.nextCode('VendorModuleBill', 'billCode', 'VM', 5);
      // eslint-disable-next-line no-await-in-loop
      await DB.run(`INSERT INTO "VendorModuleBill" ("id","billCode","vendorId","vendorUserId","kind","orderId","billNumber","billNumberKey","billDate","period","dueDate","quantity","rate","amount","gst","total","lines","remarks","documentFile","documentName","documentMime","documentSize","status","idempotencyKey","createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, c, req.vendor.vendorId, req.vendor.userId, kind, orderId, d.billNumber, key, d.billDate, d.period, d.dueDate, d.quantity, d.rate, d.amount, d.gst, d.total, JSON.stringify(d.lines || []), d.remarks, st.billFile, st.billName, st.billMime, st.billSize, 'Submitted', idem || null, t, t]);
      code = c;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message)) || i === 4) { if (st.billFile) attachments.remove(st.billFile); throw e; }
      if (idem && /idem/i.test(String(e.message))) { if (st.billFile) attachments.remove(st.billFile); const prev = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "vendorUserId" = ? AND "idempotencyKey" = ?', [req.vendor.userId, idem]); return { status: 201, body: { bill: VM.billView(prev), duplicateRequest: true, message: 'Already sent.' } }; } // eslint-disable-line no-await-in-loop
    }
  }
  const bill = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "id" = ?', [id]);
  await audit(req, { action: kind === 'receipt' ? 'Receipt uploaded' : (kind === 'monthly_bill' ? 'Monthly bill uploaded' : 'Invoice uploaded'), documentName: st.billName, newValue: `${code} · ${d.billNumber || ''} · ₹${d.total}`, status: 'Submitted' });
  if (!opt.quiet) {
    try {
      const list = await VC.billReviewers('vendorInvoice');
      const label = kind === 'monthly_bill' ? `${VM.periodLabel(d.period)} monthly bill` : (kind === 'receipt' ? 'a receipt' : 'an invoice');
      const title = `Vendor ${label} ${code} waiting for your check`;
      const message = `${req.vendor.vendorName} sent ${label}${d.billNumber ? ` ${d.billNumber}` : ''}${d.total ? ` (₹${d.total})` : ''}. Open Office & Accounts -> Vendor invoices and monthly bills.`;
      await require('../utils/notify').notifyUsers(list.map((u) => u.id), { title, message }); // eslint-disable-line global-require
      for (const u of list) { if (u.email) await VC.sendVendorEmail({ to: u.email, subject: `TeamLink: ${title}`, text: `${message}\n\nThis is an automatic message from TeamLink.`, userId: u.id }); } // eslint-disable-line no-await-in-loop
    } catch (e) { console.error('[vendor-module-bill notify]', e && e.message); } // eslint-disable-line no-console
  }
  return { status: 201, body: { bill: VM.billView(bill), message: kind === 'receipt' ? 'Receipt sent. The company will see it.' : 'Sent. Accounts will check it.' } };
}

router.post('/module-bills', vendorOnly, async (req, res) => {
  // The kind comes in the multipart body, which is only readable after the guard: peek the query first.
  const kind = ['invoice', 'monthly_bill'].includes(str(req.query.kind)) ? str(req.query.kind) : 'invoice';
  return createBill(req, res, kind);
});

router.get('/module-bills/:id/document', vendorOnly, async (req, res) => {
  const b = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "id" = ? AND "vendorId" = ?', [String(req.params.id), req.vendor.vendorId]);
  if (!b || !b.documentFile) return res.status(403).json(NOT_YOURS);
  const a = await VM.allows(req, KIND_MODULE[b.kind][0]);
  if (!a.ok) return res.status(403).json(a.body);
  await audit(req, { action: 'Bill document downloaded', documentName: b.documentName, status: b.billCode });
  return VF.sendStored(res, b.documentFile, b.documentMime, b.documentName);
});

// ============================================================================
// OFFICE / EXPENSES / PAYMENTS
// ============================================================================
const legacy = (vendorId) => require('../utils/vendorInvoices').listVendorInvoices(vendorId, { forVendor: true }); // eslint-disable-line global-require

router.get('/office', vendorOnly, VM.guard('office', 'viewHistory'), async (req, res) => {
  const [inv, receipts] = await Promise.all([legacy(req.vendor.vendorId), DB.q('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = \'receipt\' ORDER BY "createdAt" DESC', [req.vendor.vendorId])]);
  const perms = req.vendor.modules.get('office').permissions;
  res.json({ rows: inv.rows, summary: inv.summary, receipts: receipts.map(VM.billView), canUpload: CFGperm('office', perms, 'uploadReceipts') });
});
router.post('/office/receipts', vendorOnly, async (req, res) => createBill(req, res, 'receipt'));

router.get('/expenses', vendorOnly, VM.guard('expenses', 'viewEntries'), async (req, res) => {
  const inv = await legacy(req.vendor.vendorId);
  res.json({ rows: inv.rows, summary: inv.summary });
});

router.get('/payments', vendorOnly, VM.guard('payments', 'viewHistory'), async (req, res) => {
  const rows = await VM.paymentRows(req.vendor.vendorId);
  res.json({ rows, total: ROUND(rows.reduce((t, r) => t + Number(r.amount || 0), 0)) });
});

router.createBill = createBill; // the Airtel Bills portal's "Send a bill" reuses this very function (same checks, same table, same review queue)
router.saveBill = saveBill; // the vendor Import (utils/vendorImport.js) runs the same checks and the same insert, one row at a time
module.exports = router;
