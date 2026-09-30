const express = require('express');
const prisma = require('../db');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const {
  parseAudience, parseChannels, resolveAudience, deliver, describeDelivery,
} = require('../utils/audience');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


router.get('/', async (req, res) => {
  // A PROJECT IS VISIBLE WHEN SOMEBODY IN SCOPE IS ON IT. The project row
  // itself is not departmental, but its assignment list names people — so an
  // unscoped read handed a TL the staffing of every other department's work.
  // Projects with nobody assigned stay visible: there is nothing private on
  // them yet.
  const scope = employeeRecordWhere(req.user);
  const where = Object.keys(scope).length
    ? { OR: [{ assignments: { none: {} } }, { assignments: { some: scope } }] }
    : {};
  const projects = await prisma.project.findMany({
    where,
    include: { assignments: { where: Object.keys(scope).length ? scope : undefined, include: { employee: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(projects);
});

router.get('/:id', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { assignments: { include: { employee: true } } } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// AUDIENCE (utils/audience.js). A project can be staffed on creation, and
// an existing one staffed in bulk: everyone in scope, one or MANY
// departments, or one or MANY employees. One ProjectAssignment per person,
// the same row a single assign writes; people already on the project are
// skipped, not duplicated. Every target is held to the caller's scope — the
// single-employee assign used to accept any id at all, and now refuses an
// out-of-scope one with 403 like everything else.
async function staff(req, projectId, projectName) {
  const aud = parseAudience(req.body);
  let targets;
  let label;
  if (aud) {
    const out = await resolveAudience(req.user, aud);
    if (!out.ok) return { error: { status: out.status, body: { error: out.error } } };
    targets = out.employees;
    label = out.label;
  } else {
    const { employeeId } = req.body;
    if (!employeeId) return { error: { status: 400, body: { error: 'employeeId is required' } } };
    const target = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!target) return { error: { status: 404, body: { error: 'Employee not found' } } };
    if (!employeeInScope(req.user, target)) return { error: { status: 403, body: OUT_OF_SCOPE } };
    targets = [target];
    label = target.name;
  }
  const existing = new Set((await prisma.projectAssignment.findMany({
    where: { projectId, employeeId: { in: targets.map((t) => t.id) } }, select: { employeeId: true },
  })).map((a) => a.employeeId));
  const fresh = targets.filter((t) => !existing.has(t.id));
  const role = req.body.role || null;
  const created = fresh.length
    ? await prisma.$transaction(fresh.map((t) => prisma.projectAssignment.create({ data: { projectId, employeeId: t.id, role } })))
    : [];
  const delivery = fresh.length ? await deliver({
    employees: fresh,
    channels: parseChannels(req.body.channels),
    title: `Added to project: ${projectName}`,
    message: req.body.note || null,
    by: req.user,
    exceptUserId: req.user.id,
  }) : null;
  return {
    assigned: created.length, alreadyOn: existing.size, label, created,
    delivery, deliveryText: delivery ? describeDelivery(delivery) : null,
  };
}

router.post('/', requirePerm(null, 'hrms', 'Performance & Development', 'create'), async (req, res) => {
  const { name, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  // Validate the team BEFORE the project exists, so a refused audience does
  // not leave an empty project behind.
  const aud = parseAudience(req.body);
  if (aud) {
    const check = await resolveAudience(req.user, aud);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
  }
  const project = await prisma.project.create({ data: { name, status: status || 'Active' } });
  await logAudit({ userId: req.user.id, action: 'Project created', entity: 'Project', entityId: project.id });
  if (!aud) return res.status(201).json(project);
  const out = await staff(req, project.id, project.name);
  if (out.error) return res.status(out.error.status).json(out.error.body);
  const { created, ...summary } = out;
  return res.status(201).json({ ...project, ...summary });
});

router.post('/:id/assign', requirePerm(null, 'hrms', 'Performance & Development', 'edit'), async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const out = await staff(req, project.id, project.name);
  if (out.error) return res.status(out.error.status).json(out.error.body);
  // The single-employee call answers with the assignment row, as it always did.
  if (!parseAudience(req.body)) {
    if (!out.created.length) return res.status(409).json({ error: 'That employee is already on this project.' });
    return res.status(201).json(out.created[0]);
  }
  const { created, ...summary } = out;
  await logAudit({ userId: req.user.id, action: 'Project staffed', entity: 'Project', entityId: project.id, toValue: `${summary.label} (${summary.assigned})` });
  return res.status(201).json(summary);
});

module.exports = router;
