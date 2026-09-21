const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// The approval escalation order behind Organization Structure. A leave,
// attendance-regularization or issue request climbs this chain top to bottom;
// the Leave Approval Chain panel prints its first three links.
const DEFAULT_ORDER = ['Recruiter', 'TL', 'Manager', 'Admin', 'Super Admin'];

async function config() {
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  return cfg;
}

function parse(cfg) {
  const roles = String(cfg.escalationOrder || '').split(',').map((r) => r.trim()).filter(Boolean);
  return roles.length ? roles : DEFAULT_ORDER;
}

router.get('/', async (req, res) => {
  res.json({ roles: parse(await config()) });
});

router.put('/', requirePerm(null, 'administration', 'Organization Structure', 'configure'), async (req, res) => {
  const { roles } = req.body;
  if (!Array.isArray(roles) || roles.length === 0) return res.status(400).json({ error: 'roles must be a non-empty array' });
  const cfg = await config();
  const updated = await prisma.hrConfig.update({
    where: { id: cfg.id },
    data: { escalationOrder: roles.map((r) => String(r).trim()).filter(Boolean).join(',') },
  });
  await logAudit({ userId: req.user.id, action: 'Escalation order updated', entity: 'HrConfig', entityId: updated.id, toValue: updated.escalationOrder });
  res.json({ roles: parse(updated) });
});

module.exports = router;
