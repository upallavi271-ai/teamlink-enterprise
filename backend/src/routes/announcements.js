const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const PAUSE = require('../utils/announcementPause');
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
    paused: PAUSE.isPaused(a),
    pausedAt: (PAUSE.pausedInfo(a) || {}).at || null,
    pausedBy: (PAUSE.pausedInfo(a) || {}).by || null,
  };
}

// WHO MAY POST, AND TO WHOM (founder 2026-10-27: "andaru new announcement create chesukovachu; valla hierarchy lo kanipinchali; Super Admin ki
// anni theliyali - evaru, ey time, date"): HR / Super Admin (the create right) post to anyone; a lead (TL / STL / Manager) posts inside their
// own scope (the Send-to picker already allows only that); an employee posts to their own department (their team, TL and seniors see it).
// The Super Admin and HR see every announcement, each with who posted it, their role and department, and the exact date and time.
const ROLE_WORD = { SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', HR: 'HR', STL: 'STL', TL: 'TL', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager', EMPLOYEE: 'Employee' };
async function postingMode(user) {
  const mayCreate = await require('../utils/permissions').can(user, null, 'hrms', 'Employee Services', 'create').catch(() => false); // eslint-disable-line global-require
  if (mayCreate) return { mode: 'picker' };
  const own = await prisma.employee.findFirst({ where: { userId: user.id }, select: { department: true } });
  if (!own) return { mode: 'none', reason: 'Only people on the employee rolls can post an announcement.' };
  if (user.caps && user.caps.hrmsSelfOnly) {
    return own.department ? { mode: 'department', department: own.department } : { mode: 'none', reason: 'Your employee record has no department yet. Ask HR to add it, then you can post.' };
  }
  return { mode: 'picker' }; // a lead: the picker offers only their own scope
}
router.get('/can-post', async (req, res) => {
  const m = await postingMode(req.user);
  res.json({ canPost: m.mode !== 'none', ...m });
});
async function withPosters(rows) {
  const ids = [...new Set(rows.map((a) => a.postedById).filter(Boolean))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, hrmsRole: true, employee: { select: { department: true, designation: true } } } }).catch(() => []) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((a) => {
    const u = byId.get(a.postedById);
    return { ...a, postedByRole: u ? (ROLE_WORD[String(u.hrmsRole || u.role || '').toUpperCase()] || null) : null, postedByDept: u && u.employee ? u.employee.department || null : null, postedAt: a.createdAt };
  });
}

router.get('/', async (req, res) => {
  const ctx = await viewerContext(req.user);
  const departments = scopeDepartments(req.user) || [];
  const announcements = await prisma.announcement.findMany({ orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }] });
  const legacy = legacyReach(departments);
  // a PAUSED notice is shown only to those who may edit announcements (with a Paused tag + Resume); everybody else does not see it
  const mayEdit = await require('../utils/permissions').can(req.user, null, 'hrms', 'Employee Services', 'edit').catch(() => false); // eslint-disable-line global-require
  res.json(await withPosters(announcements.filter((a) => reaches(ctx, a, legacy) && (mayEdit || !PAUSE.isPaused(a))).map(shape)));
});

router.post('/', async (req, res) => {
  const how = await postingMode(req.user);
  if (how.mode === 'none') return res.status(403).json({ error: how.reason });
  const { title, body, category, date } = req.body;
  // pinning to the top stays with those who manage announcements
  const pinned = how.mode === 'picker' && (await require('../utils/permissions').can(req.user, null, 'hrms', 'Employee Services', 'create').catch(() => false)) ? req.body.pinned : false; // eslint-disable-line global-require
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
  const aud = how.mode === 'department' ? null : parseAudience(req.body);
  let reached = null;
  let columns = { departments: null, employeeIds: null };
  if (how.mode === 'department') {
    // an employee's notice: everyone working in their department (their team, TL, STL and above see it; HR / Super Admin see every notice)
    reached = await prisma.employee.findMany({ where: { department: how.department, userId: { not: null }, employmentStatus: { notIn: ['Relieved', 'Exited'] } }, select: { id: true, userId: true, name: true, email: true, phone: true, department: true } });
    columns = { departments: how.department, employeeIds: null };
    target = `${how.department} department`;
  } else if (aud) {
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
      channels: how.mode === 'department' ? [] : parseChannels(req.body.channels),
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

// PAUSE / RESUME (2026-10-27): off the dashboard and out of the bell while paused; Resume brings both back.
router.put('/:id/pause', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const existing = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Announcement not found' });
  const want = req.body && typeof req.body.paused === 'boolean' ? req.body.paused : !PAUSE.isPaused(existing);
  const row = await PAUSE.setPaused(existing, want, req.user);
  await logAudit({ userId: req.user.id, action: want ? 'Announcement paused' : 'Announcement resumed', entity: 'Announcement', entityId: existing.id, toValue: existing.title });
  res.json(shape(row));
});

router.delete('/:id', requirePerm(null, 'hrms', 'Employee Services', 'delete'), async (req, res) => {
  await prisma.announcement.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Announcement deleted', entity: 'Announcement', entityId: req.params.id });
  res.status(204).end();
});

module.exports = router;
