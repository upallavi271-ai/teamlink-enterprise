const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { scopeDepartments } = require('../utils/scope');
const {
  list, parseAudience, parseChannels, resolveAudience, storedColumns, viewerContext, reaches, deliver, describeDelivery,
} = require('../utils/audience');

const router = express.Router();
router.use(requireAuth);


// `target` is free text ("All Employees", "Medical", "IT · Manufacturing"), so
// the scope rule is: a company-wide notice reaches everyone, a notice naming a
// department reaches that department only. A department-scoped viewer never
// sees another desk's announcement.
//
// AUDIENCE (utils/audience.js). A row posted through the Send-to picker also
// carries `departments` (one or many) and `employeeIds` (one or many), and
// those columns decide visibility exactly: a multi-department notice reaches
// each of those departments, an individual notice reaches those people (and
// the leads whose scope covers them). A row with neither column is an older
// one and keeps the free-text `target` rule above.
function legacyReach(departments) {
  return (a) => {
    const t = a.target || '';
    if (!t || t.includes('All')) return true;
    return departments.some((d) => t.includes(d));
  };
}

function shape(a) {
  let delivery = null;
  try { delivery = a.delivery ? JSON.parse(a.delivery) : null; } catch { delivery = null; }
  return {
    ...a,
    departments: list(a.departments),
    employeeIds: list(a.employeeIds),
    delivery,
    deliveryText: delivery ? describeDelivery(delivery) : null,
  };
}

router.get('/', async (req, res) => {
  const ctx = await viewerContext(req.user);
  const departments = scopeDepartments(req.user) || [];
  const announcements = await prisma.announcement.findMany({ orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }] });
  const legacy = legacyReach(departments);
  res.json(announcements.filter((a) => reaches(ctx, a, legacy)).map(shape));
});

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { title, body, category, pinned, date } = req.body;
  let { target } = req.body;
  if (!title || !body || !date) return res.status(400).json({ error: 'title, body and date are required' });

  // The Send-to picker. A caller that sends no audience (an older client
  // posting { target: 'Medical Department' }) is handled exactly as before.
  const aud = parseAudience(req.body);
  let reached = null;
  let columns = { departments: null, employeeIds: null };
  if (aud) {
    const out = await resolveAudience(req.user, aud);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    reached = out.employees;
    columns = storedColumns(out.audience);
    target = out.label;
  }

  const announcement = await prisma.announcement.create({
    data: {
      title, body, category, pinned: !!pinned, target, date,
      postedBy: req.user.name, postedById: req.user.id, ...columns,
    },
  });

  // Everyone it reaches gets it in-app; the ticked "Also deliver via"
  // channels are recorded per person (Email really sent when configured,
  // SMS / WhatsApp recorded, not sent — there is no provider).
  let delivery = null;
  if (reached) {
    delivery = await deliver({
      employees: reached,
      channels: parseChannels(req.body.channels),
      title: `Announcement: ${title}`,
      message: body,
      by: req.user,
      exceptUserId: req.user.id,
    });
    await prisma.announcement.update({ where: { id: announcement.id }, data: { delivery: JSON.stringify(delivery) } });
    announcement.delivery = JSON.stringify(delivery);
  }
  await logAudit({ userId: req.user.id, action: 'Announcement posted', entity: 'Announcement', entityId: announcement.id, toValue: target || null });
  res.status(201).json({ ...shape(announcement), reached: reached ? reached.length : null });
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
