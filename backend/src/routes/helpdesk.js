const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);


const TICKET_CATEGORIES = ['IT Support', 'HR Query', 'Facilities', 'Payroll Query', 'Other'];
const TICKET_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const CLOSED_STATUSES = ['Resolved', 'Closed'];

// Which team a category is auto-routed to on creation. Notification delivery
// (email/WhatsApp/SMS) is simulated — routing only labels the ticket's owning team.
const ROUTING = {
  'IT Support': 'IT Team',
  'HR Query': 'HR Team',
  Facilities: 'Admin Team',
  'Payroll Query': 'Accounts Team',
  Other: 'HR Team',
};

// Target first-response window by priority, in hours.
const SLA_HOURS = { Urgent: 4, High: 8, Medium: 24, Low: 48 };

// A small starter knowledge base — the articles the helpdesk points people at
// before they raise a ticket.
const KNOWLEDGE_BASE = [
  { title: 'Resetting your TeamLink password', category: 'IT Support' },
  { title: 'Applying for leave', category: 'HR Query' },
  { title: 'Claiming travel expenses', category: 'Payroll Query' },
  { title: 'Requesting a new laptop', category: 'IT Support' },
];

const DAY_MS = 86400000;

// SLA is derived, never stored, so changing the targets re-grades open tickets.
// A ticket breaches when it is still open past its window.
function slaFor(ticket) {
  const hours = SLA_HOURS[ticket.priority] || SLA_HOURS.Medium;
  const round = (h) => Math.round(Math.max(0, h) * 10) / 10;
  if (CLOSED_STATUSES.includes(ticket.status)) {
    // resolvedAt is a date, so a same-day close reads as 0h rather than going negative.
    const resolvedAt = ticket.resolvedAt ? new Date(`${ticket.resolvedAt}T23:59:59`) : null;
    const elapsedH = resolvedAt ? (resolvedAt - new Date(ticket.createdAt)) / 3600000 : null;
    return { hours, label: 'Closed', breached: elapsedH != null ? elapsedH > hours : false, elapsedHours: elapsedH != null ? round(elapsedH) : null };
  }
  const elapsedH = (Date.now() - new Date(ticket.createdAt)) / 3600000;
  return { hours, label: `SLA ${hours}h`, breached: elapsedH > hours, elapsedHours: round(elapsedH) };
}

function parseNotes(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Internal notes are never shown to the employee who raised the ticket.
function present(ticket, req) {
  const notes = parseNotes(ticket.notes);
  const isOwnTicket = req.user.caps.hrmsSelfOnly;
  return {
    ...ticket,
    notes: isOwnTicket ? notes.filter((n) => !n.internal) : notes,
    noteCount: notes.length,
    routedTo: ROUTING[ticket.category] || 'HR Team',
    sla: slaFor(ticket),
  };
}

async function loadScoped(req, where = {}) {
  const filter = { type: 'HELPDESK', ...where };
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return [];
    filter.employeeId = own.id;
  }
  return prisma.employeeRecord.findMany({ where: filter, include: { employee: true }, orderBy: { createdAt: 'desc' } });
}

router.get('/meta', (req, res) => {
  res.json({
    categories: TICKET_CATEGORIES,
    priorities: TICKET_PRIORITIES,
    statuses: TICKET_STATUSES,
    routing: Object.keys(ROUTING).map((category) => ({ category, team: ROUTING[category] })),
    slaHours: SLA_HOURS,
    knowledgeBase: KNOWLEDGE_BASE,
  });
});

router.get('/', async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.category) where.category = req.query.category;
  if (req.query.priority) where.priority = req.query.priority;
  if (!req.user.caps.hrmsSelfOnly && req.query.employeeId) where.employeeId = req.query.employeeId;
  const tickets = await loadScoped(req, where);
  const assignees = await prisma.employee.findMany({ where: { id: { in: tickets.map((t) => t.assignedTo).filter(Boolean) } } });
  const nameOf = Object.fromEntries(assignees.map((a) => [a.id, a.name]));
  res.json(tickets.map((t) => ({ ...present(t, req), assignedToName: t.assignedTo ? nameOf[t.assignedTo] || null : null })));
});

router.post('/', async (req, res) => {
  const { title, detail, category, priority, assignedTo } = req.body;
  let employeeId = req.body.employeeId;
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
    employeeId = own.id;
  }
  if (!employeeId || !title) return res.status(400).json({ error: 'employeeId and a subject are required' });
  if (category && !TICKET_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${TICKET_CATEGORIES.join(', ')}` });
  if (priority && !TICKET_PRIORITIES.includes(priority)) return res.status(400).json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(', ')}` });

  const ticket = await prisma.employeeRecord.create({
    data: {
      type: 'HELPDESK', employeeId, title, detail,
      category: category || 'Other', priority: priority || 'Medium',
      status: 'Open', assignedTo: assignedTo || null, notes: '[]',
    },
  });
  await logAudit({ userId: req.user.id, action: 'Ticket raised', entity: 'EmployeeRecord', entityId: ticket.id, toValue: ticket.category });
  res.status(201).json({ ...present(ticket, req), routedTo: ROUTING[ticket.category] || 'HR Team' });
});

// Free movement between the four statuses (including reopening a resolved ticket);
// moving to Resolved or Closed requires a resolution note.
router.patch('/:id/status', async (req, res) => {
  const { status, resolution } = req.body;
  if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${TICKET_STATUSES.join(', ')}` });
  const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.type !== 'HELPDESK') return res.status(404).json({ error: 'Ticket not found' });
  if (!req.user.caps.hrmsManage) return res.status(403).json({ error: "This isn't included in your role's permissions" });
  if (existing.status === status) return res.json(present(existing, req));

  const data = { status };
  if (CLOSED_STATUSES.includes(status)) {
    if (!String(resolution || '').trim()) return res.status(400).json({ error: 'A resolution note is required to resolve or close a ticket.' });
    data.resolution = String(resolution).trim();
    data.resolvedAt = new Date().toISOString().slice(0, 10);
  } else {
    // Reopening clears the previous resolution so the next close has to explain itself.
    data.resolution = null;
    data.resolvedAt = null;
  }

  const ticket = await prisma.employeeRecord.update({ where: { id: req.params.id }, data });
  await logAudit({ userId: req.user.id, action: `Ticket ${existing.status} → ${status}`, entity: 'EmployeeRecord', entityId: ticket.id, fromValue: existing.status, toValue: status });
  res.json(present(ticket, req));
});

router.patch('/:id/assign', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const ticket = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { assignedTo: req.body.assignedTo || null } });
  await logAudit({ userId: req.user.id, action: 'Ticket assigned', entity: 'EmployeeRecord', entityId: ticket.id, toValue: req.body.assignedTo || 'Unassigned' });
  res.json(present(ticket, req));
});

router.patch('/:id/escalate', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const ticket = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { escalated: true } });
  await logAudit({ userId: req.user.id, action: 'Ticket escalated', entity: 'EmployeeRecord', entityId: ticket.id });
  res.json(present(ticket, req));
});

router.post('/:id/notes', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const { text, internal } = req.body;
  if (!String(text || '').trim()) return res.status(400).json({ error: 'text is required' });
  const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.type !== 'HELPDESK') return res.status(404).json({ error: 'Ticket not found' });
  const notes = parseNotes(existing.notes);
  notes.push({ author: req.user.name || req.user.email, text: String(text).trim(), internal: internal !== false, at: new Date().toISOString() });
  const ticket = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { notes: JSON.stringify(notes) } });
  res.json(present(ticket, req));
});

// Satisfaction rating, 1-5, given by the employee once their ticket is resolved.
router.patch('/:id/csat', async (req, res) => {
  const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.type !== 'HELPDESK') return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.caps.hrmsSelfOnly) {
    const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!own || own.id !== existing.employeeId) return res.status(403).json({ error: "This isn't included in your role's permissions" });
  }
  if (!CLOSED_STATUSES.includes(existing.status)) return res.status(409).json({ error: 'Only a resolved or closed ticket can be rated.' });
  const csat = Math.max(1, Math.min(5, Number(req.body.csat) || 5));
  const ticket = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { csat } });
  res.json(present(ticket, req));
});

// ---- Dashboard, reports & analytics ----

router.get('/analytics', requirePerm(null, 'hrms', 'Employee Services', 'export'), async (req, res) => {
  const tickets = await prisma.employeeRecord.findMany({ where: { type: 'HELPDESK' }, include: { employee: true } });
  const agents = await prisma.employee.findMany({ where: { id: { in: tickets.map((t) => t.assignedTo).filter(Boolean) } } });
  const nameOf = Object.fromEntries(agents.map((a) => [a.id, a.name]));

  const closed = tickets.filter((t) => CLOSED_STATUSES.includes(t.status));
  const resolutionDays = closed
    .filter((t) => t.resolvedAt)
    .map((t) => Math.max(0, (new Date(t.resolvedAt) - new Date(t.createdAt)) / DAY_MS));
  const rated = tickets.filter((t) => t.csat != null);

  const byWorkload = {};
  tickets.forEach((t) => {
    const key = t.assignedTo ? nameOf[t.assignedTo] || 'Unknown' : 'Unassigned';
    if (!byWorkload[key]) byWorkload[key] = { agent: key, open: 0, total: 0 };
    byWorkload[key].total += 1;
    if (!CLOSED_STATUSES.includes(t.status)) byWorkload[key].open += 1;
  });

  res.json({
    kpis: {
      total: tickets.length,
      open: tickets.filter((t) => t.status === 'Open').length,
      inProgress: tickets.filter((t) => t.status === 'In Progress').length,
      resolved: closed.length,
      escalated: tickets.filter((t) => t.escalated).length,
      slaBreached: tickets.filter((t) => slaFor(t).breached).length,
      avgResolutionDays: resolutionDays.length ? Math.round((resolutionDays.reduce((s, d) => s + d, 0) / resolutionDays.length) * 10) / 10 : null,
      avgCsat: rated.length ? Math.round((rated.reduce((s, t) => s + t.csat, 0) / rated.length) * 10) / 10 : null,
    },
    byCategory: TICKET_CATEGORIES.map((category) => ({ category, tickets: tickets.filter((t) => t.category === category).length })),
    byPriority: TICKET_PRIORITIES.map((priority) => ({ priority, tickets: tickets.filter((t) => t.priority === priority).length })),
    byStatus: TICKET_STATUSES.map((status) => ({ status, tickets: tickets.filter((t) => t.status === status).length })),
    byAgent: Object.values(byWorkload).sort((a, b) => b.open - a.open || b.total - a.total),
  });
});

module.exports = router;
