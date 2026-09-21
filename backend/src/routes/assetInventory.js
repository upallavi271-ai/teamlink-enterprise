const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

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

function present(a) {
  return { ...a, history: parseHistory(a.history), assignedToName: a.assignedTo ? a.assignedTo.name : null };
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
  const assets = await prisma.asset.findMany({ include: { assignedTo: true }, orderBy: { createdAt: 'desc' } });
  res.json(assets.map(present));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { name, category, purchaseDate, warrantyUntil } = req.body;
  if (!name) return res.status(400).json({ error: 'An asset name is required' });
  const asset = await prisma.asset.create({
    data: {
      assetCode: await nextCode(),
      name,
      category: category || 'Laptop',
      status: 'Available',
      purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
      warrantyUntil: warrantyUntil || null,
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
    data: { assignedToId: employee.id, status: 'Assigned', history: await pushHistory(asset, req, `Assigned to ${employee.name}`) },
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
    data: { status: 'Retired', assignedToId: null, history: await pushHistory(asset, req, 'Retired') },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset retired', entity: 'Asset', entityId: asset.id, toValue: 'Retired' });
  res.json(present(updated));
});

router.patch('/:id', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const { name, category, purchaseDate, warrantyUntil, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const updated = await prisma.asset.update({
    where: { id: req.params.id },
    data: { name, category, purchaseDate, warrantyUntil, status },
    include: { assignedTo: true },
  });
  res.json(present(updated));
});

module.exports = router;
