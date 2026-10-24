// ---------------------------------------------------------------------------
// ID CARD ORDERS — the company side (Employee Management -> "ID card orders" tab), 2026-10-14.
// /api/id-card-orders — HR / Admin (the Employee Management "create" grant: Super Admin, Admin, HR).
//
// HR picks employees (type-to-search) and a card type (New / Replacement / Lost); every line snapshots the
// employee's name, ID, designation, department, blood group and the id of their stored Photo document. The
// ID-card vendor sees the order in its portal (routes/vendorModulePortal.js), moves it
// New -> Received -> Printing -> Ready -> Delivered, and the company is told at every step.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const VP = require('../utils/vendorPortal');
const MODCFG = require('../config/vendorModules');
const DB = require('../utils/vmDb');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm(null, 'hrms', 'Employee Management', 'create'));
router.use(async (req, res, next) => ((await DB.ready()) ? next() : res.status(503).json(DB.NOT_READY)));

const { str } = VP;
const CARD_TYPES = ['New', 'Replacement', 'Lost'];
const actorOf = (req) => req.user.name || req.user.email || 'HR';
const GONE = /resign|terminat|left|exit|absconded|inactive|relieved/i;

const orderRow = (o, extra = {}) => ({
  id: o.id, orderCode: o.orderCode, vendorId: o.vendorId, status: o.status, note: o.note || null, vendorRemarks: o.vendorRemarks || null,
  hasChallan: !!o.challanFile, challanName: o.challanName || null, createdByName: o.createdByName || null,
  createdAt: DB.toDate(o.createdAt), receivedAt: DB.toDate(o.receivedAt), printingAt: DB.toDate(o.printingAt), readyAt: DB.toDate(o.readyAt), deliveredAt: DB.toDate(o.deliveredAt),
  ...extra,
});

// Vendors that can receive ID card orders: those with a login that has the ID Card Orders module, else vendors whose category is ID Cards.
router.get('/vendors', async (req, res) => {
  const [vendors, mods] = await Promise.all([
    prisma.officeVendor.findMany({ where: { isActive: true }, select: { id: true, name: true, category: true }, orderBy: { name: 'asc' } }),
    DB.q('SELECT DISTINCT u."vendorId" AS vendorId FROM "VendorLoginModule" m JOIN "VendorUser" u ON u."id" = m."vendorUserId" WHERE m."moduleKey" = \'id_card_orders\' AND u."deletedAt" IS NULL AND u."status" = \'Active\''),
  ]);
  const withModule = new Set(mods.map((m) => m.vendorId));
  const rows = vendors.filter((v) => withModule.has(v.id) || MODCFG.resolveCategory(v.category) === 'id_cards').map((v) => ({ id: v.id, name: v.name, category: v.category || null, hasPortal: withModule.has(v.id) }));
  res.json({ vendors: rows });
});

// Employee picker: name / ID / designation / department / blood group / has a photo.
router.get('/employees', async (req, res) => {
  const s = str(req.query.q);
  const where = s ? { OR: [{ name: { contains: s } }, { employeeCode: { contains: s } }, { designation: { contains: s } }, { department: { contains: s } }] } : {};
  const emps = await prisma.employee.findMany({ where, orderBy: { name: 'asc' }, take: 60, select: { id: true, employeeCode: true, name: true, designation: true, department: true, bloodGroup: true, employmentStatus: true } });
  const live = emps.filter((e) => !GONE.test(e.employmentStatus || ''));
  const photos = live.length ? await prisma.employeeDocument.findMany({ where: { employeeId: { in: live.map((e) => e.id) }, docType: 'Photo' }, select: { employeeId: true } }) : [];
  const has = new Set(photos.map((p) => p.employeeId));
  res.json({ employees: live.map((e) => ({ id: e.id, employeeCode: e.employeeCode, name: e.name, designation: e.designation, department: e.department, bloodGroup: e.bloodGroup, hasPhoto: has.has(e.id) })) });
});

router.get('/', async (req, res) => {
  const s = str(req.query.q).toLowerCase();
  const where = []; const params = [];
  if (str(req.query.status)) { where.push('o."status" = ?'); params.push(str(req.query.status)); }
  if (str(req.query.vendorId)) { where.push('o."vendorId" = ?'); params.push(str(req.query.vendorId)); }
  const rows = await DB.q(`SELECT o.*, (SELECT COUNT(*) FROM "IdCardOrderLine" l WHERE l."orderId" = o."id") AS "lineCount" FROM "IdCardOrder" o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o."createdAt" DESC LIMIT 500`, params);
  const vendors = await prisma.officeVendor.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.vendorId))] } }, select: { id: true, name: true } });
  const vn = new Map(vendors.map((v) => [v.id, v.name]));
  const out = rows.map((o) => orderRow(o, { lineCount: o.lineCount, vendorName: vn.get(o.vendorId) || '' })).filter((o) => !s || [o.orderCode, o.vendorName, o.status].some((x) => String(x || '').toLowerCase().includes(s)));
  res.json({ rows: out, statuses: ['New', 'Received', 'Printing', 'Ready', 'Delivered'], cardTypes: CARD_TYPES });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const vendor = b.vendorId ? await prisma.officeVendor.findUnique({ where: { id: String(b.vendorId) } }) : null;
  if (!vendor || vendor.isActive === false) return res.status(400).json({ error: 'Pick the ID card vendor.', field: 'vendorId' });
  const defType = CARD_TYPES.includes(str(b.cardType)) ? str(b.cardType) : 'New';
  const wanted = Array.isArray(b.lines) && b.lines.length ? b.lines.map((l) => ({ employeeId: str(l.employeeId), cardType: CARD_TYPES.includes(str(l.cardType)) ? str(l.cardType) : defType }))
    : (Array.isArray(b.employeeIds) ? b.employeeIds.map((id) => ({ employeeId: str(id), cardType: defType })) : []);
  const seen = new Set();
  const lines = wanted.filter((l) => l.employeeId && !seen.has(l.employeeId) && seen.add(l.employeeId));
  if (!lines.length) return res.status(400).json({ error: 'Pick at least one employee.', field: 'employees' });
  if (lines.length > 500) return res.status(400).json({ error: 'An order can have up to 500 people.', field: 'employees' });
  const emps = await prisma.employee.findMany({ where: { id: { in: lines.map((l) => l.employeeId) } }, select: { id: true, employeeCode: true, name: true, designation: true, department: true, bloodGroup: true } });
  if (emps.length !== lines.length) return res.status(400).json({ error: 'One of the picked employees no longer exists. Open the list again.', field: 'employees' });
  const em = new Map(emps.map((e) => [e.id, e]));
  const photos = await prisma.employeeDocument.findMany({ where: { employeeId: { in: emps.map((e) => e.id) }, docType: 'Photo' }, orderBy: { uploadedAt: 'desc' }, select: { id: true, employeeId: true } });
  const photoOf = new Map();
  photos.forEach((p) => { if (!photoOf.has(p.employeeId)) photoOf.set(p.employeeId, p.id); });
  const note = VP.cleanText(b.note, 500) || null;
  const t = DB.now();
  const id = DB.newId();
  let code;
  await prisma.$transaction(async (tx) => {
    code = await DB.nextCode('IdCardOrder', 'orderCode', 'ICO', 4, tx);
    await DB.run('INSERT INTO "IdCardOrder" ("id","orderCode","vendorId","status","note","createdById","createdByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)', [id, code, vendor.id, 'New', note, req.user.id, actorOf(req), t, t], tx);
    for (const l of lines) {
      const e = em.get(l.employeeId);
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT INTO "IdCardOrderLine" ("id","orderId","employeeId","employeeCode","employeeName","designation","department","bloodGroup","photoDocId","cardType","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [DB.newId(), id, e.id, e.employeeCode, e.name, e.designation || null, e.department || null, e.bloodGroup || null, photoOf.get(e.id) || null, l.cardType, t], tx);
    }
    await DB.run('INSERT INTO "IdCardOrderEvent" ("id","orderId","fromStatus","toStatus","actorKind","actorName","note","createdAt") VALUES (?,?,?,?,?,?,?,?)', [DB.newId(), id, null, 'New', 'Staff', actorOf(req), `Order placed for ${lines.length} ${lines.length === 1 ? 'person' : 'people'}`, t], tx);
  }, { timeout: 30000 });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'ID card order placed', entity: 'IdCardOrder', entityId: id, toValue: `${code} · ${vendor.name} · ${lines.length} card(s)` });
  await VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: 'Admin', vendorId: vendor.id, action: 'ID card order placed', newValue: `${code} · ${lines.length} card(s)`, status: code });
  const o = await DB.one('SELECT * FROM "IdCardOrder" WHERE "id" = ?', [id]);
  return res.status(201).json({ order: orderRow(o, { lineCount: lines.length, vendorName: vendor.name }), message: `Order ${code} placed with ${vendor.name} (${lines.length} ${lines.length === 1 ? 'card' : 'cards'}). They will see it in their portal.` });
});

router.get('/:id', async (req, res) => {
  const o = await DB.one('SELECT * FROM "IdCardOrder" WHERE "id" = ?', [String(req.params.id)]);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  const [lines, events, vendor, bills] = await Promise.all([
    DB.q('SELECT * FROM "IdCardOrderLine" WHERE "orderId" = ? ORDER BY "employeeName"', [o.id]),
    DB.q('SELECT * FROM "IdCardOrderEvent" WHERE "orderId" = ? ORDER BY "createdAt" ASC', [o.id]),
    prisma.officeVendor.findUnique({ where: { id: o.vendorId }, select: { name: true } }),
    DB.q('SELECT "id","billCode","billNumber","total","status" FROM "VendorModuleBill" WHERE "orderId" = ? ORDER BY "createdAt" DESC', [o.id]),
  ]);
  res.json({
    order: orderRow(o, { lineCount: lines.length, vendorName: vendor ? vendor.name : '' }),
    lines: lines.map((l) => ({ id: l.id, employeeId: l.employeeId, employeeCode: l.employeeCode, employeeName: l.employeeName, designation: l.designation, department: l.department, bloodGroup: l.bloodGroup, cardType: l.cardType, hasPhoto: !!l.photoDocId })),
    history: events.map((e) => ({ id: e.id, from: e.fromStatus, to: e.toStatus, by: e.actorName, kind: e.actorKind, note: e.note, at: DB.toDate(e.createdAt) })),
    bills,
  });
});

// The vendor's delivery challan / proof, for HR.
router.get('/:id/challan', async (req, res) => {
  const o = await DB.one('SELECT * FROM "IdCardOrder" WHERE "id" = ?', [String(req.params.id)]);
  if (!o || !o.challanFile) return res.status(404).json({ error: 'No challan on this order.' });
  return require('../utils/vendorFiles').sendStored(res, o.challanFile, o.challanMime, o.challanName); // eslint-disable-line global-require
});

module.exports = router;
