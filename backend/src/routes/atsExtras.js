const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { applicationWhere, requirementWhere, scopeOf } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const {
  INTERVIEW_STATUS_CODES, INTERVIEW_NEXT, INTERVIEW_TERMINAL,
  INTERVIEW_MODES, INTERVIEW_TYPES, INTERVIEW_RESULTS,
  interviewStatusLabel, REQUIREMENT_LIVE_STATUSES,
} = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'interviews', 'Calendar View', 'view'));

// Recruiter & BDE workload view — the prototype's teamView() (line 9154):
// Name / Role / Open Requirements / Active Pipeline, recruiters first, then
// BDEs, then the TLs who oversee them.
//
// "Active pipeline" is every application on that person's requirements that
// has not yet reached Joined or Rejected. (The prototype hardcodes a BDE's
// number to the count of applications sitting at "With BDE", and a second
// BDE's to a literal 0 — computing it the same way for everyone is the fix.)
const TEAM_ROLE_ORDER = { RECRUITER: 0, BDE: 1, TL: 2, STL: 3 };
const TEAM_ROLE_LABELS = { RECRUITER: 'Recruiter', BDE: 'BDE', TL: 'TL', STL: 'STL' };
const CLOSED_PIPELINE_STAGES = ['JOINED', 'HIRED', 'REJECTED'];

router.get('/team', async (req, res) => {
  // A TL sees their own team; a recruiter sees themselves; admins see all.
  const s = scopeOf(req.user);
  const people = await prisma.user.findMany({
    where: {
      role: { in: ['RECRUITER', 'BDE', 'TL', 'STL'] },
      ...(s.global ? {} : s.departments.length
        ? { OR: [{ atsDepartment: { in: s.departments } }, { id: s.userId }] }
        : { id: s.userId }),
    },
  });
  const rows = await Promise.all(
    people.map(async (u) => {
      const ownRequirements = { OR: [{ recruiterId: u.id }, { bdeId: u.id }] };
      const [openRequirements, activePipeline] = await Promise.all([
        prisma.requirement.count({ where: { ...ownRequirements, status: { in: REQUIREMENT_LIVE_STATUSES } } }),
        prisma.application.count({
          where: { requirement: ownRequirements, stage: { notIn: CLOSED_PIPELINE_STAGES } },
        }),
      ]);
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        roleLabel: TEAM_ROLE_LABELS[u.role] || u.role,
        oversight: ['TL', 'STL'].includes(u.role),
        openRequirements,
        activePipeline,
      };
    })
  );
  rows.sort((a, b) => (TEAM_ROLE_ORDER[a.role] - TEAM_ROLE_ORDER[b.role]) || a.name.localeCompare(b.name));
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Interview Calendar
//
// Two tabs, kept deliberately apart (the prototype's calendarView, line 9184):
// the recruitment / client interview and the AI interview are separate things
// and an AI score is never mixed into client interview feedback.
// ---------------------------------------------------------------------------

const CALENDAR_INCLUDE = {
  candidate: true,
  requirement: { include: { client: true, recruiter: true, bde: true } },
  interviewEvents: { orderBy: { createdAt: 'asc' } },
};

// Clients only ever see their own company's interviews. Everyone else sees all.
function calendarScope(user) {
  // The same scope as every other ATS list: a client sees their own company's
  // interviews, a recruiter their own assignments, a TL their department's.
  return applicationWhere(user);
}

function interviewCode(app) {
  return app.interviewCode || `INT-${app.id.slice(-6).toUpperCase()}`;
}

// The "Result" column: the interview's own recommendation if one was recorded,
// otherwise derived from where the application sits in the pipeline.
function derivedResult(app) {
  if (app.interviewResult) return app.interviewResult;
  if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(app.stage)) return 'Selected';
  if (app.stage === 'REJECTED') return 'Rejected';
  if (app.stage === 'HOLD') return 'Hold';
  return '—';
}

function shapeRecruitment(app) {
  return {
    id: app.id,
    interviewCode: interviewCode(app),
    candidate: { id: app.candidate.id, name: app.candidate.name },
    requirement: {
      id: app.requirement.id,
      title: app.requirement.title,
      department: app.requirement.department,
      tl: app.requirement.tl,
      client: app.requirement.client ? { id: app.requirement.client.id, name: app.requirement.client.name } : null,
      recruiter: app.requirement.recruiter ? { id: app.requirement.recruiter.id, name: app.requirement.recruiter.name } : null,
      bde: app.requirement.bde ? { id: app.requirement.bde.id, name: app.requirement.bde.name } : null,
    },
    round: app.interviewRound,
    type: app.interviewType || (app.requirement.client ? 'Client Interview' : 'Internal Panel'),
    interviewer: app.interviewer,
    interviewAt: app.interviewAt,
    mode: app.interviewMode,
    meeting: app.interviewMeetingLink || app.interviewLocation || null,
    status: app.interviewStatus,
    statusLabel: interviewStatusLabel(app.interviewStatus),
    score: app.interviewScore,
    result: derivedResult(app),
    createdBy: app.interviewCreatedBy,
    cancelReason: app.interviewCancelReason,
    feedback: app.interviewFeedback,
    rescheduleCount: app.interviewRescheduleCount,
    stage: app.stage,
    history: app.interviewEvents,
  };
}

function shapeAi(app) {
  return {
    id: app.id,
    aiCode: `AI-${app.id.slice(-6).toUpperCase()}`,
    candidate: { id: app.candidate.id, name: app.candidate.name },
    requirement: { id: app.requirement.id, title: app.requirement.title },
    status: app.aiInterviewStatus || 'Required',
    deadline: app.aiInterviewDeadline,
    score: app.aiInterviewScore,
    feedback: app.aiInterviewFeedback,
  };
}

// An AI interview past its deadline reads as Expired — but it is never stored
// that way and it never rejects the candidate.
function withExpiry(row) {
  if (row.status === 'Completed' || row.score != null) return { ...row, status: 'Completed' };
  if (row.status === 'Manual Review Requested') return row;
  if (row.deadline && new Date(row.deadline) < new Date(new Date().toDateString())) {
    return { ...row, status: 'Expired' };
  }
  return row;
}

router.get('/calendar', async (req, res) => {
  const scope = calendarScope(req.user);
  const [recruitmentApps, aiApps] = await Promise.all([
    prisma.application.findMany({
      where: { ...scope, interviewStatus: { not: null } },
      include: CALENDAR_INCLUDE,
      orderBy: { interviewAt: 'asc' },
    }),
    prisma.application.findMany({
      where: { ...scope, OR: [{ aiInterviewStatus: { not: null } }, { aiInterviewScore: { not: null } }] },
      include: { candidate: true, requirement: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const recruitment = recruitmentApps.map(shapeRecruitment);
  const ai = aiApps.map(shapeAi).map(withExpiry);

  // Filter option lists, built from what is actually on the calendar — the
  // prototype derives its client/date dropdowns the same way.
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  res.json({
    recruitment,
    ai,
    statuses: INTERVIEW_STATUS_CODES,
    types: INTERVIEW_TYPES,
    modes: INTERVIEW_MODES,
    filterOptions: {
      clients: uniq(recruitment.map((r) => r.requirement.client?.name)),
      recruiters: uniq(recruitment.map((r) => r.requirement.recruiter?.name)),
      tls: uniq(recruitment.map((r) => r.requirement.tl)),
      bdes: uniq(recruitment.map((r) => r.requirement.bde?.name)),
      dates: uniq(recruitment.map((r) => (r.interviewAt ? new Date(r.interviewAt).toISOString().slice(0, 10) : null))),
    },
  });
});

// Interviews are moved by the people who run them. Clients watch only. Who
// that is comes from the permission engine (caps.atsAct), not a role list.

async function loadInterview(req, res) {
  if (!req.user.caps.atsAct) {
    res.status(403).json({ error: "This action isn't included in your role's permissions" });
    return null;
  }
  const app = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { candidate: true, requirement: { include: { client: true } } },
  });
  if (!app) { res.status(404).json({ error: 'Application not found' }); return null; }
  if (!app.interviewStatus) { res.status(400).json({ error: 'No interview on this application' }); return null; }
  return app;
}

async function recordEvent(applicationId, status, extra = {}) {
  await prisma.interviewEvent.create({ data: { applicationId, status, ...extra } });
}

async function respondWith(res, id) {
  const app = await prisma.application.findUnique({ where: { id }, include: CALENDAR_INCLUDE });
  res.json(shapeRecruitment(app));
}

// Scheduled -> Confirmed -> Started -> Completed -> Pending Feedback. No skipping.
router.patch('/interviews/:id/advance', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  const { to } = req.body;
  if (INTERVIEW_TERMINAL.includes(app.interviewStatus)) {
    return res.status(409).json({ error: `This interview is ${interviewStatusLabel(app.interviewStatus)} — reschedule it instead` });
  }
  const expected = INTERVIEW_NEXT[app.interviewStatus];
  if (!expected) return res.status(409).json({ error: `An interview cannot be advanced from ${interviewStatusLabel(app.interviewStatus)}` });
  if (to !== expected) {
    return res.status(400).json({ error: `Interview must go ${interviewStatusLabel(app.interviewStatus)} → ${interviewStatusLabel(expected)} — no skipping` });
  }

  const data = { interviewStatus: to };
  if (to === 'STARTED') data.interviewStartedAt = new Date();
  // Completing an interview lands it in Pending Feedback straight away: the
  // feedback is what actually closes it out.
  if (to === 'COMPLETED') { data.interviewCompletedAt = new Date(); data.interviewStatus = 'PENDING_FEEDBACK'; }

  const updated = await prisma.application.update({ where: { id: app.id }, data });
  await recordEvent(app.id, to, { by: req.user.name });
  if (to === 'COMPLETED') await recordEvent(app.id, 'PENDING_FEEDBACK', { by: 'System' });
  await logAudit({
    userId: req.user.id, action: `Interview ${interviewStatusLabel(updated.interviewStatus)}`,
    entity: 'Application', entityId: app.id,
    fromValue: interviewStatusLabel(app.interviewStatus), toValue: interviewStatusLabel(updated.interviewStatus),
  });
  await respondWith(res, app.id);
});

// A cancelled interview is NOT a rejection — the candidate stays where they were.
router.post('/interviews/:id/cancel', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A cancellation reason is required' });
  await prisma.application.update({
    where: { id: app.id },
    data: { interviewStatus: 'CANCELLED', interviewCancelReason: reason },
  });
  await recordEvent(app.id, 'CANCELLED', { reason, by: req.user.name });
  await logAudit({
    userId: req.user.id, action: `Interview cancelled — ${reason}`, entity: 'Application',
    entityId: app.id, fromValue: interviewStatusLabel(app.interviewStatus), toValue: 'Cancelled',
  });
  await respondWith(res, app.id);
});

router.post('/interviews/:id/no-show', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  await prisma.application.update({ where: { id: app.id }, data: { interviewStatus: 'NO_SHOW' } });
  await recordEvent(app.id, 'NO_SHOW', { by: req.user.name });
  await logAudit({
    userId: req.user.id, action: 'Interview no-show', entity: 'Application',
    entityId: app.id, fromValue: interviewStatusLabel(app.interviewStatus), toValue: 'No Show',
  });
  await respondWith(res, app.id);
});

// Every reschedule is appended to the history — the old slot is never lost.
router.post('/interviews/:id/reschedule', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  const { interviewAt } = req.body;
  const reason = (req.body.reason || '').trim();
  if (!interviewAt) return res.status(400).json({ error: 'A new date is required' });
  if (!reason) return res.status(400).json({ error: 'A reason is required' });
  const when = new Date(interviewAt);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'That date is not valid' });

  const fromSlot = app.interviewAt ? app.interviewAt.toISOString() : '—';
  await prisma.application.update({
    where: { id: app.id },
    data: {
      interviewStatus: 'RESCHEDULED',
      interviewAt: when,
      interviewRescheduleCount: app.interviewRescheduleCount + 1,
      interviewCancelReason: null,
    },
  });
  await recordEvent(app.id, 'RESCHEDULED', { reason, by: req.user.name, fromSlot, toSlot: when.toISOString() });
  await logAudit({
    userId: req.user.id, action: `Interview rescheduled — ${reason}`, entity: 'Application',
    entityId: app.id, fromValue: fromSlot, toValue: when.toISOString(),
  });
  await respondWith(res, app.id);
});

// Recruitment/client feedback. Deliberately separate from aiInterviewScore.
router.post('/interviews/:id/feedback', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  const feedback = (req.body.feedback || '').trim();
  if (!feedback) return res.status(400).json({ error: 'Feedback is required' });
  const result = req.body.result || 'Recommended';
  if (!INTERVIEW_RESULTS.includes(result)) return res.status(400).json({ error: 'Unknown recommendation' });
  let score = null;
  if (req.body.score !== '' && req.body.score != null) {
    const n = Number(req.body.score);
    if (Number.isNaN(n)) return res.status(400).json({ error: 'Score must be a number' });
    score = Math.max(0, Math.min(100, Math.round(n)));
  }

  await prisma.application.update({
    where: { id: app.id },
    data: {
      interviewStatus: 'COMPLETED', interviewFeedback: feedback,
      interviewResult: result, interviewScore: score,
      // Completing the interview moves the pipeline forward, but the
      // select/reject decision stays on the candidate profile.
      ...(app.stage === 'INTERVIEW_SCHEDULED' ? { stage: 'INTERVIEW_COMPLETED' } : {}),
    },
  });
  await recordEvent(app.id, 'COMPLETED', { reason: `Feedback recorded — ${result}`, by: req.user.name });
  await logAudit({
    userId: req.user.id, action: `Interview feedback recorded — ${result}`, entity: 'Application',
    entityId: app.id, fromValue: interviewStatusLabel(app.interviewStatus), toValue: 'Completed',
  });
  await respondWith(res, app.id);
});

// ---- AI interview tab actions ----------------------------------------------
// An expired AI interview never rejects the candidate: it can be extended,
// resent, or handed to a recruiter for a manual screen.

async function loadAi(req, res) {
  if (!req.user.caps.atsAct) {
    res.status(403).json({ error: "This action isn't included in your role's permissions" });
    return null;
  }
  const app = await prisma.application.findUnique({ where: { id: req.params.id }, include: { candidate: true } });
  if (!app) { res.status(404).json({ error: 'Application not found' }); return null; }
  return app;
}

router.post('/ai-interviews/:id/extend', async (req, res) => {
  const app = await loadAi(req, res);
  if (!app) return;
  const days = Number(req.body.days) > 0 ? Math.min(30, Math.round(Number(req.body.days))) : 3;
  const d = new Date();
  d.setDate(d.getDate() + days);
  const deadline = d.toISOString().slice(0, 10);
  await prisma.application.update({
    where: { id: app.id },
    data: { aiInterviewDeadline: deadline, aiInterviewStatus: 'Required' },
  });
  await logAudit({
    userId: req.user.id, action: 'AI interview deadline extended', entity: 'Application',
    entityId: app.id, fromValue: app.aiInterviewDeadline || '—', toValue: deadline,
  });
  res.json({ ok: true, deadline });
});

router.post('/ai-interviews/:id/resend', async (req, res) => {
  const app = await loadAi(req, res);
  if (!app) return;
  await logAudit({
    userId: req.user.id, action: 'AI interview notification resent', entity: 'Application',
    entityId: app.id, toValue: 'Resent',
  });
  res.json({ ok: true, message: 'AI interview invite resent (Email / WhatsApp / SMS).' });
});

router.post('/ai-interviews/:id/manual-review', async (req, res) => {
  const app = await loadAi(req, res);
  if (!app) return;
  await prisma.application.update({ where: { id: app.id }, data: { aiInterviewStatus: 'Manual Review Requested' } });
  await logAudit({
    userId: req.user.id, action: 'Manual review requested for AI interview', entity: 'Application',
    entityId: app.id, fromValue: app.aiInterviewStatus || '—', toValue: 'Manual Review Requested',
  });
  res.json({ ok: true });
});

// Global search across candidates, clients and requirements.
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ candidates: [], clients: [], requirements: [] });
  const [candidates, clients, requirements] = await Promise.all([
    prisma.candidate.findMany({ where: { name: { contains: q } } }),
    prisma.client.findMany({ where: { name: { contains: q } } }),
    prisma.requirement.findMany({ where: { title: { contains: q } }, include: { client: true } }),
  ]);
  res.json({ candidates, clients, requirements });
});

module.exports = router;
