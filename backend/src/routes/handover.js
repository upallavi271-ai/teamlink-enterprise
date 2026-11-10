// ---------------------------------------------------------------------------
// RECRUITER HANDOVER (founder 2026-11-10): a recruiter leaves or moves; their candidates are handed to another recruiter in one go.
// Super Admin, Admin, Manager, Assistant Manager, STL and TL - each over the candidates they may see (utils/scope.js).
// The candidates' steps, interviews, notes, documents and history stay exactly as they are; the old recruiter's name stays on
// everything they did (utils/handover.js) and a Joined / Hired candidate is never handed over.
//
//   GET  /api/ats/handover/recruiters            recruiters with how many of their candidates may be handed over (left ones marked)
//   GET  /api/ats/handover/candidates?from=<id>  that recruiter's candidates that may be handed over (+ how many Joined stay)
//   POST /api/ats/handover                       { from, to, applicationIds[], reason } -> { moved }
//   GET  /api/ats/handover/history               every handover (by hand, recruiter left, taken off a requirement, assigned)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { applicationWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const H = require('../utils/handover');
const { LEFT } = require('../utils/leftLogin');

const router = express.Router();
router.use(requireAuth);

const MAY = ['superadmin', 'admin', 'manager', 'asstmanager', 'stl', 'tl'];
const TEST = /zztest|example\.test/i;
const isTest = (s) => !require('../utils/sandbox').isSandbox() && TEST.test(String(s || '')); // eslint-disable-line global-require
function allowed(req, res) {
  const layout = require('../utils/atsHome').layoutOf(req.user); // eslint-disable-line global-require
  if (MAY.includes(layout)) return true;
  res.status(403).json({ error: 'Only a Team Lead, Manager or Admin can hand candidates over.' });
  return false;
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error('[handover]', e); res.status(500).json({ error: 'That did not work. Please try again.' }); }); // eslint-disable-line no-console
const leftOf = (u) => u.status !== 'Active' || !!(u.employee && LEFT.includes(u.employee.employmentStatus));
const STEP = {
  NEW: 'New', RECRUITER_REVIEW: 'Recruiter review', RECRUITER_APPROVED: 'Recruiter review', TL_REVIEW: 'TL review', WITH_BDE: 'With BDE', BDE_APPROVED: 'With BDE',
  SHARED_WITH_CLIENT: 'Sent to client', CLIENT_REVIEW: 'Sent to client', CLIENT_SHORTLISTED: 'Client shortlisted', INTERVIEW_SCHEDULED: 'Interview fixed',
  INTERVIEW_COMPLETED: 'Interview done', SELECTED: 'Selected', OFFER: 'Offer', OFFER_ACCEPTED: 'Waiting to join', HOLD: 'On hold', REJECTED: 'Rejected',
};

router.get('/recruiters', wrap(async (req, res) => {
  if (!allowed(req, res)) return;
  const counts = await prisma.application.groupBy({ by: ['ownerRecruiterId'], where: { AND: [applicationWhere(req.user), { ownerRecruiterId: { not: null }, stage: { notIn: H.KEEP } }] }, _count: { _all: true } });
  const n = new Map(counts.map((c) => [c.ownerRecruiterId, c._count._all]));
  const users = await prisma.user.findMany({
    where: { OR: [{ atsRole: 'RECRUITER', status: 'Active' }, { id: { in: [...n.keys()] } }] },
    select: { id: true, name: true, status: true, atsRole: true, employee: { select: { employmentStatus: true, department: true } } },
  });
  const rows = users.filter((u) => !isTest(u.name)).map((u) => ({
    id: u.id, name: u.name, left: leftOf(u), department: (u.employee && u.employee.department) || null, candidates: n.get(u.id) || 0,
    canReceive: !leftOf(u) && u.atsRole === 'RECRUITER',
  })).sort((a, b) => Number(b.left) - Number(a.left) || b.candidates - a.candidates || a.name.localeCompare(b.name));
  res.json({ rows });
}));

router.get('/candidates', wrap(async (req, res) => {
  if (!allowed(req, res)) return;
  const from = String(req.query.from || '');
  if (!from) return res.status(400).json({ error: 'Pick the recruiter first.' });
  const scope = applicationWhere(req.user);
  const [apps, joined] = await Promise.all([
    prisma.application.findMany({
      where: { AND: [scope, { ownerRecruiterId: from, stage: { notIn: H.KEEP } }] },
      select: {
        id: true, candidateId: true, stage: true, updatedAt: true,
        candidate: { select: { name: true } },
        requirement: { select: { reqCode: true, title: true, department: true, internal: true, client: { select: { name: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 2000,
    }),
    prisma.application.count({ where: { AND: [scope, { ownerRecruiterId: from, stage: { in: H.KEEP } }] } }),
  ]);
  const rows = apps.filter((a) => !isTest(a.candidate && a.candidate.name)).map((a) => ({
    id: a.id, candidateId: a.candidateId, candidate: (a.candidate && a.candidate.name) || '—',
    reqCode: a.requirement ? a.requirement.reqCode : null, requirement: a.requirement ? a.requirement.title : '—',
    department: a.requirement ? a.requirement.department : null,
    client: a.requirement ? (a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || '—') : '—',
    step: STEP[a.stage] || a.stage, stage: a.stage, updatedAt: a.updatedAt,
  }));
  res.json({ rows, joinedStay: joined });
}));

router.post('/', wrap(async (req, res) => {
  if (!allowed(req, res)) return;
  const { from, to } = req.body || {};
  const ids = Array.isArray(req.body && req.body.applicationIds) ? req.body.applicationIds.map(String).slice(0, 5000) : [];
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
  if (!from || !to) return res.status(400).json({ error: 'Pick who hands over and who takes over.' });
  if (from === to) return res.status(400).json({ error: 'Pick a different recruiter to take over.' });
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one candidate.' });
  if (!reason) return res.status(400).json({ error: 'Write why (for example: resigned, moved to another team).' });
  const target = await prisma.user.findUnique({ where: { id: String(to) }, select: { id: true, name: true, status: true, atsRole: true, employee: { select: { employmentStatus: true } } } });
  if (!target || leftOf(target) || target.atsRole !== 'RECRUITER') return res.status(400).json({ error: 'The person taking over must be an active recruiter.' });
  const fromUser = await prisma.user.findUnique({ where: { id: String(from) }, select: { id: true, name: true } });
  if (!fromUser) return res.status(404).json({ error: 'That recruiter was not found.' });
  const apps = await prisma.application.findMany({
    where: { AND: [applicationWhere(req.user), { id: { in: ids }, ownerRecruiterId: fromUser.id, stage: { notIn: H.KEEP } }] },
    select: { id: true, candidateId: true, ownerRecruiterId: true, stage: true },
  });
  if (!apps.length) return res.status(409).json({ error: 'None of those candidates can be handed over now (already moved, joined, or outside your team).' });
  const moved = await H.moveOwner({ apps, to: { id: target.id, name: target.name }, by: { id: req.user.id, name: req.user.name }, kind: 'handed over by hand', reason });
  await logAudit({ userId: req.user.id, action: 'Recruiter handover', entity: 'User', entityId: fromUser.id, fromValue: fromUser.name, toValue: target.name, reason: `${moved.length} candidate(s) · ${reason}` });
  if (moved.length) {
    try {
      await require('../utils/notify').notifyUsers([target.id], { // eslint-disable-line global-require
        title: `👤 ${moved.length} candidate${moved.length === 1 ? '' : 's'} handed to you`,
        message: `${req.user.name} handed over ${moved.length === 1 ? 'a candidate' : `${moved.length} candidates`} of ${fromUser.name} to you (${reason}). They are in your Candidates list; ${fromUser.name}'s earlier work keeps their name.`,
      });
    } catch { /* the bell is a courtesy */ }
  }
  res.json({ moved: moved.length, skipped: ids.length - moved.length, message: `${moved.length} candidate${moved.length === 1 ? '' : 's'} handed over from ${fromUser.name} to ${target.name}.` });
}));

router.get('/history', wrap(async (req, res) => {
  if (!allowed(req, res)) return;
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Application', action: { startsWith: H.ACTION } },
    select: { action: true, fromValue: true, toValue: true, reason: true, createdAt: true, actorName: true, user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  // one line per handover: the same day, the same two recruiters, the same way and the same person
  const groups = new Map();
  rows.forEach((r) => {
    const day = new Date(new Date(r.createdAt).getTime() + 330 * 60000).toISOString().slice(0, 10);
    const kind = (/\((.+)\)$/.exec(r.action) || [])[1] || 'handed over';
    const by = (r.user && r.user.name) || r.actorName || 'TeamLink';
    const k = [day, r.fromValue, r.toValue, kind, by].join('|');
    if (!groups.has(k)) groups.set(k, { day, at: r.createdAt, from: r.fromValue, to: r.toValue, kind, by, reason: r.reason || null, count: 0 });
    groups.get(k).count += 1;
  });
  const KIND = { 'handed over by hand': 'By hand', 'the recruiter left': 'Recruiter left', 'taken off the requirement': 'Taken off the requirement', assigned: 'Assigned on a candidate' };
  res.json({ rows: [...groups.values()].slice(0, 300).map((g) => ({ ...g, how: KIND[g.kind] || g.kind })) });
}));

module.exports = router;
