const express = require('express');
const prisma = require('../db');
const { scopeOf, hrmsGlobal } = require('../utils/scope');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { toCsv, toXlsx, toPdf } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['Available', 'Assigned', 'In Repair', 'Retired'];

// The company asset inventory behind Employee Services → Assets. Unlike the
// per-employee asset *requests* on EmployeeRecord(type:'ASSET'), an asset here
// can sit unassigned in the pool, which is what the prototype's inventory,
// transfer, return, maintenance, disposal and audit screens all read.

function parseHistory(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The HOLDER as the asset screens need them — identity, department, role and
// status, nothing else. This used to be the whole Employee row (bank account,
// PAN, address …) handed to anyone who could open the asset register.
const HOLDER_SELECT = {
  id: true, employeeCode: true, name: true, department: true, designation: true,
  location: true, branch: true, employmentStatus: true,
};

function present(a) {
  const { assignedTo, ...rest } = a;
  const holder = assignedTo
    ? Object.fromEntries(Object.keys(HOLDER_SELECT).map((k) => [k, assignedTo[k] ?? null]))
    : null;
  return {
    ...rest,
    assignedTo: holder,
    history: parseHistory(a.history),
    assignedToName: holder ? holder.name : null,
    allocation: a.assignedToId ? 'Allocated' : 'Unallocated',
  };
}

// ---- Asset report filters (hrms-24 §6) --------------------------------------
// Every filter runs ON THE SERVER, over the scoped register, and they combine
// (AND): Department = R&D + Status = Assigned + a date range is one query.
//
//   q            free search: asset code / name / category / type / location,
//                holder's employee ID or name
//   employeeCode, employeeName, department   the HOLDER (an unassigned asset
//                has none, so it drops out once any of these is set)
//   category, assetType, assetCode, assetName, location, assignedBy
//   allocation   Allocated | Unallocated
//   status       Available | Assigned | In Repair | Retired
//   assignedDate, returnDate   one calendar day (YYYY-MM-DD)
//   from, to + dateField       a range over assigned | returned | purchased
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d) => new Date(`${d}T00:00:00`);
const dayEnd = (d) => new Date(new Date(`${d}T00:00:00`).getTime() + 86400000);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// WHO SEES WHICH ASSETS (user, 2026-09-29): "every employee sees only the
// assets assigned to them; a TL sees their department's assets." Before this,
// every scoped login also saw EVERY unassigned asset. Now:
//   Super Admin / Admin / HR (the asset desk)  → all assets, unassigned too
//   Manager / Assistant Manager                → all assets (view-only by role)
//   TL / STL                                   → assets held by people in their department(s)
//   everyone else                              → only the assets assigned to them
function assetScope(user) {
  const s = scopeOf(user);
  if (s.global || hrmsGlobal(user)) return null;
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(s.hrmsRole)) return null;
  if (['TL', 'STL'].includes(s.hrmsRole) && s.departments && s.departments.length) {
    return { assignedTo: { is: { department: { in: s.departments } } } };
  }
  return { assignedToId: s.employeeId || '__none__' };
}

function assetWhere(user, q = {}) {
  const scope = assetScope(user);
  const and = [scope || {}];
  const holder = {};
  if (str(q.employeeCode)) holder.employeeCode = { contains: str(q.employeeCode) };
  if (str(q.employeeName)) holder.name = { contains: str(q.employeeName) };
  if (str(q.department)) holder.department = str(q.department);
  if (Object.keys(holder).length) and.push({ assignedTo: { is: holder } });
  if (str(q.category)) and.push({ category: str(q.category) });
  if (str(q.assetType)) and.push({ assetType: { contains: str(q.assetType) } });
  if (str(q.assetCode)) and.push({ assetCode: { contains: str(q.assetCode) } });
  if (str(q.assetName)) and.push({ name: { contains: str(q.assetName) } });
  if (str(q.location)) and.push({ location: { contains: str(q.location) } });
  if (str(q.assignedBy)) and.push({ assignedByName: { contains: str(q.assignedBy) } });
  if (str(q.status)) and.push({ status: str(q.status) });
  if (str(q.allocation) === 'Allocated') and.push({ assignedToId: { not: null } });
  if (str(q.allocation) === 'Unallocated') and.push({ assignedToId: null });
  if (YMD.test(str(q.assignedDate))) and.push({ assignedAt: { gte: dayStart(q.assignedDate), lt: dayEnd(q.assignedDate) } });
  if (YMD.test(str(q.returnDate))) and.push({ returnedAt: { gte: dayStart(q.returnDate), lt: dayEnd(q.returnDate) } });
  const from = YMD.test(str(q.from)) ? str(q.from) : null;
  const to = YMD.test(str(q.to)) ? str(q.to) : null;
  if (from || to) {
    const field = str(q.dateField) || 'assigned';
    if (field === 'purchased') {
      // purchaseDate is a YYYY-MM-DD string, so it compares as text.
      const r = {};
      if (from) r.gte = from;
      if (to) r.lte = to;
      and.push({ purchaseDate: r });
    } else {
      const r = {};
      if (from) r.gte = dayStart(from);
      if (to) r.lt = dayEnd(to);
      if (field === 'returned') and.push({ returnedAt: r });
      else if (field === 'any') and.push({ OR: [{ assignedAt: r }, { returnedAt: r }] });
      else and.push({ assignedAt: r });
    }
  }
  if (str(q.q)) {
    const s = str(q.q);
    and.push({
      OR: [
        { assetCode: { contains: s } }, { name: { contains: s } }, { category: { contains: s } },
        { assetType: { contains: s } }, { location: { contains: s } },
        { assignedTo: { is: { OR: [{ name: { contains: s } }, { employeeCode: { contains: s } }] } } },
      ],
    });
  }
  return { AND: and };
}

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const EXPORT_HEADERS = [
  'Asset ID', 'Asset Name', 'Category', 'Asset Type', 'Asset Status', 'Allocation Status',
  'Employee ID', 'Employee Name', 'Department', 'Designation', 'Location',
  'Assigned Date', 'Assigned By', 'Return Date', 'Purchase Date', 'Warranty Until',
];
function exportRow(a) {
  const h = a.assignedTo || {};
  return [
    a.assetCode, a.name, a.category || '', a.assetType || '', a.status, a.allocation,
    h.employeeCode || '', h.name || '', h.department || '', h.designation || '', a.location || '',
    ymd(a.assignedAt), a.assignedByName || '', ymd(a.returnedAt), a.purchaseDate || '', a.warrantyUntil || '',
  ];
}

async function pushHistory(asset, req, text) {
  const history = parseHistory(asset.history);
  history.unshift({ at: new Date().toISOString().slice(0, 16).replace('T', ' '), by: req.user.name, text });
  return JSON.stringify(history);
}

async function nextCode() {
  const count = await prisma.asset.count();
  return `AST-${String(count + 1).padStart(4, '0')}`;
}

router.get('/', async (req, res) => {
  // SCOPED BY WHO HOLDS THE ASSET. An unassigned asset is company stock and
  // stays visible to anyone who may open this screen; an ASSIGNED one is a
  // fact about that employee, so it follows them. Without this a TL read the
  // whole company's asset register.
  // The report filters (assetWhere above) narrow that same scoped set.
  const assets = await prisma.asset.findMany({
    where: assetWhere(req.user, req.query), include: { assignedTo: { select: HOLDER_SELECT } }, orderBy: { createdAt: 'desc' },
  });
  res.json(assets.map(present));
});

// The choices the report's selects offer — distinct values over the SCOPED,
// unfiltered register, so nothing outside this login's reach is ever named.
router.get('/options', async (req, res) => {
  const assets = await prisma.asset.findMany({
    where: assetWhere(req.user, {}), include: { assignedTo: { select: HOLDER_SELECT } },
  });
  const distinct = (fn) => [...new Set(assets.map(fn).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  res.json({
    statuses: STATUSES,
    allocations: ['Allocated', 'Unallocated'],
    categories: distinct((a) => a.category),
    assetTypes: distinct((a) => a.assetType),
    locations: distinct((a) => a.location),
    assignedBy: distinct((a) => a.assignedByName),
    departments: distinct((a) => a.assignedTo && a.assignedTo.department),
    total: assets.length,
  });
});

// Export — exactly the filtered, scoped rows, as Excel or CSV. The `export`
// action is the permission; the scope is assetWhere()'s, the same as the list.
async function sendAssetExport(req, res, format) {
  const assets = (await prisma.asset.findMany({
    where: assetWhere(req.user, req.query), include: { assignedTo: { select: HOLDER_SELECT } }, orderBy: { assetCode: 'asc' },
  })).map(present);
  const rows = assets.map(exportRow);
  await logAudit({
    userId: req.user.id, action: `Asset report exported (${format.toUpperCase()})`, entity: 'Asset',
    toValue: `${rows.length} asset(s)`,
  });
  // Every export tells the Super Admin (utils/dataIoNotify.js; never throws).
  await notifyDataIo(req, { kind: 'export', module: 'Assets', count: rows.length, what: 'assets', format, detail: 'Asset report (filtered register)' });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="asset-report-${stamp}.csv"`);
    return res.send(toCsv(EXPORT_HEADERS, rows));
  }
  // hrms-24 §3 — the same rows as a PDF, for the shared Export menu.
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="asset-report-${stamp}.pdf"`);
    return res.send(toPdf(EXPORT_HEADERS, rows, {
      title: 'Asset Report',
      subtitle: `${rows.length} asset(s) · exported ${new Date().toLocaleString('en-GB')} by ${req.user.name || 'user'}`,
    }));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="asset-report-${stamp}.xlsx"`);
  return res.send(toXlsx(EXPORT_HEADERS, rows, 'Assets'));
}
router.get('/export.csv', requirePerm(null, 'hrms', 'Employee Services', 'export'), (req, res, next) => sendAssetExport(req, res, 'csv').catch(next));
router.get('/export.xlsx', requirePerm(null, 'hrms', 'Employee Services', 'export'), (req, res, next) => sendAssetExport(req, res, 'xlsx').catch(next));
router.get('/export.pdf', requirePerm(null, 'hrms', 'Employee Services', 'export'), (req, res, next) => sendAssetExport(req, res, 'pdf').catch(next));

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { name, category, purchaseDate, warrantyUntil, assetType, location } = req.body;
  if (!name) return res.status(400).json({ error: 'An asset name is required' });
  const asset = await prisma.asset.create({
    data: {
      assetCode: await nextCode(),
      name,
      category: category || 'Laptop',
      status: 'Available',
      purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
      warrantyUntil: warrantyUntil || null,
      assetType: str(assetType) || null,
      location: str(location) || null,
      history: '[]',
    },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset added', entity: 'Asset', entityId: asset.id, toValue: asset.name });
  res.status(201).json(present(asset));
});

// Assign (or transfer) an asset to an employee.
router.patch('/:id/assign', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const { employeeId } = req.body;
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return res.status(400).json({ error: 'employeeId is required' });
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: {
      assignedToId: employee.id, status: 'Assigned', history: await pushHistory(asset, req, `Assigned to ${employee.name}`),
      // The CURRENT allocation's stamps — what the report's Assigned Date /
      // Assigned By filters read. A fresh allocation clears the last return.
      assignedAt: new Date(), assignedById: req.user.id, assignedByName: req.user.name || req.user.email || null, returnedAt: null,
    },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset assigned', entity: 'Asset', entityId: asset.id, toValue: employee.name });
  res.json(present(updated));
});

router.patch('/:id/return', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id }, include: { assignedTo: true } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: {
      assignedToId: null,
      status: 'Available',
      returnedAt: new Date(),
      history: await pushHistory(asset, req, `Returned by ${asset.assignedTo ? asset.assignedTo.name : 'employee'}`),
    },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset returned', entity: 'Asset', entityId: asset.id, toValue: 'Available' });
  res.json(present(updated));
});

// Toggle between In Repair and Available.
router.patch('/:id/maintenance', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const status = asset.status === 'In Repair' ? 'Available' : 'In Repair';
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status, history: await pushHistory(asset, req, status === 'In Repair' ? 'Sent for repair' : 'Repair completed') },
    include: { assignedTo: true },
  });
  res.json(present(updated));
});

// Retiring keeps the record — it is never deleted.
router.patch('/:id/retire', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status: 'Retired', assignedToId: null, returnedAt: asset.assignedToId ? new Date() : asset.returnedAt, history: await pushHistory(asset, req, 'Retired') },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset retired', entity: 'Asset', entityId: asset.id, toValue: 'Retired' });
  res.json(present(updated));
});

router.patch('/:id', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const { name, category, purchaseDate, warrantyUntil, status, assetType, location } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const updated = await prisma.asset.update({
    where: { id: req.params.id },
    data: {
      name, category, purchaseDate, warrantyUntil, status,
      assetType: assetType === undefined ? undefined : (str(assetType) || null),
      location: location === undefined ? undefined : (str(location) || null),
    },
    include: { assignedTo: true },
  });
  res.json(present(updated));
});

module.exports = router;
// The list's own scope, reused by the dashboard charts (routes/insights.js).
module.exports.assetWhere = assetWhere;
