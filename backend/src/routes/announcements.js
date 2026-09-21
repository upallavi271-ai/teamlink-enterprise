const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { scopeDepartments } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);


// `target` is free text ("All Employees", "Medical", "IT · Manufacturing"), so
// the scope rule is: a company-wide notice reaches everyone, a notice naming a
// department reaches that department only. A department-scoped viewer never
// sees another desk's announcement.
router.get('/', async (req, res) => {
  const departments = scopeDepartments(req.user);
  const where = departments === undefined ? {} : {
    OR: [
      { target: null },
      { target: '' },
      { target: { contains: 'All' } },
      ...departments.map((d) => ({ target: { contains: d } })),
    ],
  };
  const announcements = await prisma.announcement.findMany({
    where, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
  });
  res.json(announcements);
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, body, category, pinned, target, date } = req.body;
  if (!title || !body || !date) return res.status(400).json({ error: 'title, body and date are required' });
  const announcement = await prisma.announcement.create({ data: { title, body, category, pinned: !!pinned, target, date, postedBy: req.user.name } });
  await logAudit({ userId: req.user.id, action: 'Announcement posted', entity: 'Announcement', entityId: announcement.id });
  res.status(201).json(announcement);
});

router.put('/:id/pin', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const existing = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Announcement not found' });
  const announcement = await prisma.announcement.update({ where: { id: req.params.id }, data: { pinned: !existing.pinned } });
  res.json(announcement);
});

router.delete('/:id', requirePerm(null, 'hrms', 'Employee Services', 'delete'), async (req, res) => {
  await prisma.announcement.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Announcement deleted', entity: 'Announcement', entityId: req.params.id });
  res.status(204).end();
});

module.exports = router;
