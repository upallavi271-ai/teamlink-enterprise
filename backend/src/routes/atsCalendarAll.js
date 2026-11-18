// ---------------------------------------------------------------------------
// GET /api/ats/all-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&who=me|team  (audit 428)
// One calendar of what is coming for the logged-in person (who=me) or their area (who=team, the same scope as every ATS list):
//   interview   an interview slot (applicationWhere scope)             joining    a joining date of an accepted offer
//   followup    an open follow-up with a due date                       task       a task (Timesheet) ending on that day
// Each event: { id, type, date, time, title, sub, path }. Colour and click-through are the screen's job. Read only. Max 62 days.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { applicationWhere } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const ist = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString();
const LIVE = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED', 'COMPLETED', 'PENDING_FEEDBACK', 'FEEDBACK_SUBMITTED'];

router.get('/all-calendar', async (req, res, next) => {
  try {
    if ([req.user.role, req.user.atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r))) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
    const from = isDay(req.query.from) ? String(req.query.from) : new Date().toISOString().slice(0, 10);
    const to = isDay(req.query.to) ? String(req.query.to) : from;
    if (to < from || (new Date(to) - new Date(from)) / 86400000 > 62) return res.status(400).json({ error: 'Pick up to two months at a time.' });
    const mine = req.query.who !== 'team';
    const me = req.user;
    const scope = applicationWhere(me);
    const mineApp = mine ? { requirement: { OR: [{ recruiterId: me.id }, { bdeId: me.id }, { tlId: me.id }, { stlId: me.id }, { recruiterIds: { contains: me.id } }] } } : {};
    const cand = { select: { id: true, name: true } };
    const events = [];

    const ivs = await prisma.application.findMany({
      where: { AND: [scope, mineApp, { interviewAt: { gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59+05:30`) }, interviewStatus: { in: LIVE } }] },
      select: { id: true, interviewAt: true, interviewRound: true, interviewMode: true, interviewStatus: true, candidate: cand, requirement: { select: { title: true, client: { select: { name: true } } } } },
      take: 800,
    });
    ivs.forEach((a) => {
      const t = ist(a.interviewAt);
      events.push({ id: `iv-${a.id}`, type: 'interview', date: t.slice(0, 10), time: t.slice(11, 16), title: `Round ${a.interviewRound || 1}: ${a.candidate.name}`, sub: [a.requirement.title, a.requirement.client && a.requirement.client.name, a.interviewMode].filter(Boolean).join(' - '), path: `/candidates/${a.candidate.id}` });
    });

    const joins = await prisma.application.findMany({
      where: { AND: [scope, mineApp, { joiningDate: { gte: from, lte: to }, stage: { in: ['OFFER', 'OFFER_ACCEPTED', 'SELECTED'] }, offerStatus: { in: ['Offer Released', 'Offer Accepted'] } }] },
      select: { id: true, joiningDate: true, candidate: cand, requirement: { select: { title: true, client: { select: { name: true } } } } },
      take: 500,
    });
    joins.forEach((a) => events.push({ id: `jn-${a.id}`, type: 'joining', date: a.joiningDate, time: '', title: `Joining: ${a.candidate.name}`, sub: [a.requirement.title, a.requirement.client && a.requirement.client.name].filter(Boolean).join(' - '), path: '/ats/joining' }));

    const fus = await prisma.applicationFollowUp.findMany({
      where: { AND: [{ completedAt: null, dueDate: { gte: from, lte: to } }, mine ? { ownerUserId: me.id } : { application: scope }] },
      select: { id: true, dueDate: true, dueTime: true, nextAction: true, purpose: true, application: { select: { candidate: cand, requirement: { select: { title: true } } } } },
      take: 800,
    });
    fus.forEach((f) => events.push({ id: `fu-${f.id}`, type: 'followup', date: f.dueDate, time: f.dueTime || '', title: `Follow-up: ${f.application && f.application.candidate ? f.application.candidate.name : 'candidate'}`, sub: [f.nextAction || f.purpose, f.application && f.application.requirement && f.application.requirement.title].filter(Boolean).join(' - '), path: '/ats/followups' }));

    const tasks = await prisma.task.findMany({
      where: { AND: [{ assigneeId: me.id }, { status: { notIn: ['Completed', 'Cancelled'] } }, { OR: [{ endDate: { gte: from, lte: to } }, { endDate: null, startDate: { gte: from, lte: to } }] }] },
      select: { id: true, name: true, endDate: true, startDate: true, status: true },
      take: 500,
    }).catch(() => []);
    // a task is the login's own (the team view does not list other people's tasks)
    tasks.forEach((t) => events.push({ id: `tk-${t.id}`, type: 'task', date: t.endDate || t.startDate, time: '', title: `Task: ${t.name}`, sub: t.status, path: '/timesheet' }));

    events.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    res.json({ from, to, who: mine ? 'me' : 'team', events, counts: events.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {}) });
  } catch (e) { next(e); }
});

module.exports = router;
