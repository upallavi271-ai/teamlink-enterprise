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

// MEETING LINK (2026-10-03). An announcement may carry an optional meeting
// link (+ optional date & time). There is no column for it, and no migration
// was wanted, so it lives in the row's `delivery` JSON under `meeting`:
//   delivery = { ...the delivery summary, meeting: { link, at } }
// `delivery` is already a JSON metadata column that only shape() below reads,
// so nothing else ever sees the raw value — unlike a marker line in `body`,
// which every notice board, dashboard and export would print as-is. The API
// hands it back as plain `meetingLink` / `meetingAt` fields.
const MEETING_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
function meetingLinkError(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let u = null;
  try { u = new URL(v); } catch { u = null; }
  if (!/^https?:\/\//i.test(v) || !u || !['http:', 'https:'].includes(u.protocol) || !u.hostname || /\s/.test(v)) {
    return 'Meeting link must start with https://';
  }
  if (v.length > 500) return 'Meeting link is too long.';
  return null;
}
// "5 Oct 2026, 3:00 PM" from "2026-10-05T15:00", with no timezone shift.
function meetingWhen(at) {
  if (!at || !MEETING_AT.test(at)) return '';
  const [d, t] = at.split('T');
  const [y, m, day] = d.split('-').map(Number);
  let [h, min] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${day} ${mon} ${y}, ${h}:${String(min).padStart(2, '0')} ${ap}`;
}

function shape(a) {
  let delivery = null;
  try { delivery = a.delivery ? JSON.parse(a.delivery) : null; } catch { delivery = null; }
  const meeting = delivery && delivery.meeting ? delivery.meeting : null;
  if (delivery && delivery.meeting) {
    delivery = { ...delivery };
    delete delivery.meeting;
  }
  // A row whose JSON held only the meeting has no delivery summary.
  if (delivery && delivery.recipients === undefined) delivery = null;
  return {
    ...a,
    departments: list(a.departments),
    employeeIds: list(a.employeeIds),
    delivery,
    deliveryText: delivery ? describeDelivery(delivery) : null,
    meetingLink: meeting && meeting.link ? meeting.link : null,
    meetingAt: meeting && meeting.at ? meeting.at : null,
    meetingWhen: meeting && meeting.at ? meetingWhen(meeting.at) : null,
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
  const meetingLink = String(req.body.meetingLink || '').trim();
  const linkError = meetingLinkError(meetingLink);
  if (linkError) return res.status(400).json({ error: linkError });
  const meetingAt = meetingLink && req.body.meetingAt ? String(req.body.meetingAt).trim().slice(0, 16) : '';
  if (meetingAt && !MEETING_AT.test(meetingAt)) return res.status(400).json({ error: 'Pick a proper meeting date and time.' });
  const meeting = meetingLink ? { link: meetingLink, at: meetingAt || null } : null;

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
      ...(meeting ? { delivery: JSON.stringify({ meeting }) } : {}),
    },
  });
  // The meeting travels in the notification / email text itself — the
  // Notification row has no link column. The bell (components/
  // NotificationBell.jsx) turns the "Join meeting: <url>" line into a button;
  // every other screen shows it as plain readable text.
  const meetingLines = meeting
    ? `\n\n${meeting.at ? `Meeting time: ${meetingWhen(meeting.at)}\n` : ''}Join meeting: ${meeting.link}`
    : '';

  // Everyone it reaches gets it in-app; the ticked "Also deliver via"
  // channels are recorded per person (Email really sent when configured,
  // SMS / WhatsApp recorded, not sent — there is no provider).
  let delivery = null;
  if (reached) {
    delivery = await deliver({
      employees: reached,
      channels: parseChannels(req.body.channels),
      title: `Announcement: ${title}`,
      message: `${body}${meetingLines}`,
      by: req.user,
      exceptUserId: req.user.id,
    });
    const stored = JSON.stringify(meeting ? { ...delivery, meeting } : delivery);
    await prisma.announcement.update({ where: { id: announcement.id }, data: { delivery: stored } });
    announcement.delivery = stored;
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
