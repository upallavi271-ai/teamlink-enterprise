const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const {
  applicationWhere, requirementWhere, candidateWhere, clientWhere, atsScopeOf: scopeOf, CLIENT_SHARED_STAGES,
} = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const {
  INTERVIEW_STATUS_CODES, INTERVIEW_NEXT, INTERVIEW_TERMINAL,
  INTERVIEW_MODES, INTERVIEW_TYPES, INTERVIEW_RESULTS, INTERVIEW_KINDS, INTERVIEW_SLOT_TYPES,
  INTERVIEW_RECOMMENDATIONS, normalizeRecommendation,
  interviewStatusLabel, REQUIREMENT_LIVE_STATUSES,
} = require('../utils/atsVocab');
const { hiringTypeOf, HIRING_TYPES } = require('../utils/joining');
const { recordWorkflowMove } = require('../utils/stageEvents');
const {
  hasPersonQuery, attributedApplications, listWorkers, attributedCounts,
} = require('../utils/workers');
const {
  teamWorkloadRows, isAdminViewer, formerWorkloadRows, teamAccess,
  teamMemberDetail, memberMetricList, assignmentRows, pendingActionRows,
} = require('../utils/teamWorkload');
// Former people (user, 2026-10-05): leavers from HRMS and their whole work
// history, under the departments they worked in. utils/formerPeople.js.
const { formerPeopleRows, formerPersonHistory } = require('../utils/formerPeople');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'interviews', 'Calendar View', 'view'));

// RECRUITER & BDE (the user's spec 2026-09-29) — People & Workload,
// Assignments, Pending Actions, the 360s and the list behind every number.
// Rows, scope and what every number means: utils/teamWorkload.js.
//   GET /team                     People & Workload rows (an array — the
//                                 export reads this shape)
//   GET /team?shape=v2            { rows, helperReady }
//   GET /team?view=assignments    one row per requirement in scope
//   GET /team?view=pending        one row per active ATS application
//   GET /team/:userId             Recruiter / BDE / TL 360
//   GET /team/:userId?metric=m    the exact rows behind one number
// Accounts / client / candidate / roleless logins are refused (spec: hide).
// HR reaches it only where the role matrix grants Recruiter & BDE (then:
// internal hiring only — utils/teamWorkload.js).
async function teamGate(req, res) {
  const access = teamAccess(req.user);
  if (!access.ok || !(await can(req.user, 'ats', 'recruiterbde', 'Team View', 'view'))) {
    res.status(403).json({ error: access.error || 'Recruiter & BDE is not part of your role.' });
    return false;
  }
  return true;
}
router.get('/team', async (req, res, next) => {
  try {
    if (!(await teamGate(req, res))) return undefined;
    const fresh = req.query.fresh === '1';
    if (req.query.view === 'assignments') return res.json({ rows: await assignmentRows(req.user, { fresh }) });
    if (req.query.view === 'pending') return res.json(await pendingActionRows(req.user, { fresh }));
    // GET /team?view=former — former Recruiters / TLs / STLs / BDEs in the
    // caller's area (Admin all; Manager / STL / TL their departments / team;
    // a Recruiter / BDE nobody).
    if (req.query.view === 'former') return res.json(await formerPeopleRows(req.user, { fresh }));
    // Active logins only, as always; ?includeLeft=1 (and the screen's v2
    // shape, for its Status filter) also returns people who have left.
    const includeLeft = req.query.includeLeft === '1' || req.query.shape === 'v2';
    const { rows, helperReady } = await teamWorkloadRows(req.user, { includeLeft, fresh });
    // ?former=1 — former seat holders with their HISTORICAL counts. Super
    // Admin / Admin only; anyone else asking gets the current rows alone.
    if ((req.query.former === '1' || req.query.former === 'true') && isAdminViewer(req.user)) {
      const currentIds = new Set(rows.map((r) => r.id));
      rows.push(...await formerWorkloadRows(req.user, currentIds));
    }
    if (req.query.shape === 'v2') return res.json({ rows, helperReady });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /team/former/:id — one former person's work history (fp:<employeeId>).
router.get('/team/former/:id', async (req, res, next) => {
  try {
    if (!(await teamGate(req, res))) return undefined;
    const out = await formerPersonHistory(req.user, req.params.id, { fresh: req.query.fresh === '1' });
    return res.status(out.status).json(out.body);
  } catch (err) {
    return next(err);
  }
});

router.get('/team/:userId', async (req, res, next) => {
  try {
    if (!(await teamGate(req, res))) return undefined;
    const clientDesk = await can(req.user, 'ats', 'clients', 'Client List', 'view');
    const fresh = req.query.fresh === '1';
    const out = req.query.metric
      ? await memberMetricList(req.user, req.params.userId, String(req.query.metric), { clientDesk, fresh })
      : await teamMemberDetail(req.user, req.params.userId, { clientDesk, fresh });
    return res.status(out.status).json(out.body);
  } catch (err) {
    return next(err);
  }
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
  interviewFeedbacks: true,
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
  const internal = (app.interviewFeedbacks || []).find((f) => f.kind === 'Internal');
  if (internal) return internal.recommendation;
  const legacy = normalizeRecommendation(app.interviewResult);
  if (legacy) return legacy;
  if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(app.stage)) return 'Selected';
  if (app.stage === 'REJECTED') return 'Rejected';
  if (app.stage === 'HOLD') return 'Hold';
  return '—';
}

// Review #2 §16 — the interview TYPE: AI Interview (its own tab) · Recruiter
// Interview · TL Interview · Client Interview, stored in the existing
// interviewType string (no schema change). Older rows carry "Client Interview",
// "Internal Panel" or nothing: nothing on a client requirement is a Client
// Interview; an internal panel is a Recruiter / TL Interview only when the
// interviewer IS the requirement's recruiter / TL — otherwise it stays
// "Internal Panel", because guessing would be worse than saying so.
function interviewTypeOf(app) {
  const t = String(app.interviewType || '').trim();
  if (INTERVIEW_SLOT_TYPES.includes(t)) return t;
  const r = app.requirement || {};
  if (t && t !== 'Internal Panel') return t;
  if (!t && !r.internal && r.client) return 'Client Interview';
  const who = String(app.interviewer || '').trim().toLowerCase();
  if (who) {
    if (r.recruiter && String(r.recruiter.name || '').trim().toLowerCase() === who) return 'Recruiter Interview';
    if (r.tl && String(r.tl).trim().toLowerCase() === who) return 'TL Interview';
  }
  return 'Internal Panel';
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
    type: interviewTypeOf(app),
    // What is actually stored (null on older rows), so the calendar can offer
    // "set the type" only where it was never recorded.
    storedType: app.interviewType || null,
    interviewer: app.interviewer,
    interviewAt: app.interviewAt,
    mode: app.interviewMode,
    meeting: app.interviewMeetingLink || app.interviewLocation || null,
    meetingLink: app.interviewMeetingLink || null,
    location: app.interviewLocation || null,
    // When the slot ended (for "feedback is late" in red on the calendar).
    completedAt: app.interviewCompletedAt || null,
    status: app.interviewStatus,
    statusLabel: interviewStatusLabel(app.interviewStatus),
    score: app.interviewScore,
    result: derivedResult(app),
    createdBy: app.interviewCreatedBy,
    cancelReason: app.interviewCancelReason,
    feedback: app.interviewFeedback,
    rescheduleCount: app.interviewRescheduleCount,
    stage: app.stage,
    // Client Placement vs TeamLink Internal Hire, visible on the calendar
    // itself: the two go to completely different places after Selected.
    hiringType: hiringTypeOf(app, app.requirement),
    // Internal and client feedback are two separate records and are shown as
    // two separate things. Neither is ever mixed with the AI score.
    internalFeedback: (app.interviewFeedbacks || []).find((f) => f.kind === 'Internal') || null,
    clientFeedback: (app.interviewFeedbacks || []).find((f) => f.kind === 'Client') || null,
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
    // Where the candidate is, so the calendar can tell 'AI done, awaiting
    // Recruiter Review' from 'AI done, already moved on'.
    stage: app.stage,
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
  let scope = calendarScope(req.user);
  // ?recruiter= / ?tl= / ?bde= ("id:<userId>" or "name:<name>") and
  // ?positionCode=: the interviews on work attributed to that person or seat
  // (utils/workers.js) — a recruiter who has left is found by name.
  if (hasPersonQuery(req.query)) {
    const att = await attributedApplications(req.user, req.query, { scope });
    scope = { AND: [scope, { id: { in: [...att.ids] } }] };
  }
  // AND, never a spread: a seat-scoped lead's scope is itself an `OR`, and
  // spreading the AI list's own OR over it dropped the scope entirely.
  const [recruitmentApps, aiApps, shortlistedApps] = await Promise.all([
    prisma.application.findMany({
      where: { AND: [scope, { interviewStatus: { not: null } }] },
      include: CALENDAR_INCLUDE,
      orderBy: { interviewAt: 'asc' },
    }),
    prisma.application.findMany({
      where: { AND: [scope, { OR: [{ aiInterviewStatus: { not: null } }, { aiInterviewScore: { not: null } }] }] },
      // Only what shapeAi() reads — every application carries an AI status
      // ("Required" by default), so this list is the whole scope (23k rows for
      // a global login) and whole candidate / requirement rows made it slow.
      select: {
        id: true, stage: true, aiInterviewStatus: true, aiInterviewDeadline: true, aiInterviewScore: true, aiInterviewFeedback: true,
        candidate: { select: { id: true, name: true } },
        requirement: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    // Review #2 §17 — the lifecycle starts at CLIENT SHORTLISTED: shortlisted
    // by the client, no interview booked yet.
    prisma.application.findMany({
      where: { AND: [scope, { stage: 'CLIENT_SHORTLISTED', interviewStatus: null }] },
      select: {
        id: true, updatedAt: true, stage: true,
        candidate: { select: { id: true, name: true } },
        requirement: { select: { id: true, title: true, department: true, internal: true, hiringType: true, client: { select: { id: true, name: true } } } },
      },
      orderBy: { updatedAt: 'asc' },
    }),
  ]);

  const recruitment = recruitmentApps.map(shapeRecruitment);
  // B4: the panel of each interview (current round), migrated on read for old rows.
  // eslint-disable-next-line global-require
  const panels = await require('../utils/interviewPanel').panelsFor(recruitmentApps);
  recruitment.forEach((r) => { r.panel = panels.get(r.id) || []; });
  const ai = aiApps.map(shapeAi).map(withExpiry);
  // Review #3 §11 — "AI Interview · Score 82% · Completed 27 Sep": WHEN the AI
  // interview was completed, from the pipeline history (the move into AI
  // Interview Completed). No new column: the stage event is the record.
  const aiDoneIds = ai.filter((r) => r.status === 'Completed').map((r) => r.id);
  if (aiDoneIds.length) {
    const doneAt = new Map();
    for (let i = 0; i < aiDoneIds.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      const evs = await prisma.applicationStageEvent.findMany({
        where: { applicationId: { in: aiDoneIds.slice(i, i + 500) }, toStage: 'AI_INTERVIEW_COMPLETED' },
        select: { applicationId: true, createdAt: true },
      });
      evs.forEach((e) => {
        const prev = doneAt.get(e.applicationId);
        if (!prev || e.createdAt > prev) doneAt.set(e.applicationId, e.createdAt);
      });
    }
    ai.forEach((r) => { r.completedAt = doneAt.get(r.id) || null; });
  }

  // Filter option lists, built from what is actually on the calendar — the
  // prototype derives its client/date dropdowns the same way.
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const shortlisted = shortlistedApps.map((a) => ({
    id: a.id,
    candidate: a.candidate,
    requirement: {
      id: a.requirement.id, title: a.requirement.title, department: a.requirement.department,
      client: a.requirement.client ? { id: a.requirement.client.id, name: a.requirement.client.name } : null,
    },
    shortlistedAt: a.updatedAt,
    hiringType: hiringTypeOf(a, a.requirement),
  }));
  res.json({
    recruitment,
    ai,
    shortlisted,
    statuses: INTERVIEW_STATUS_CODES,
    types: INTERVIEW_TYPES,
    kinds: INTERVIEW_KINDS,
    slotTypes: INTERVIEW_SLOT_TYPES,
    modes: INTERVIEW_MODES,
    recommendations: INTERVIEW_RECOMMENDATIONS,
    hiringTypes: HIRING_TYPES,
    filterOptions: {
      departments: uniq(recruitment.map((r) => r.requirement.department)),
      requirements: uniq(recruitment.map((r) => r.requirement.title)),
      candidates: uniq(recruitment.map((r) => r.candidate.name)),
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
  // SCOPE: acting needs the record to be in YOUR scope, the same fragment the
  // calendar list uses — loading by id alone let any recruiter cancel or
  // reschedule another team's interview.
  const app = await prisma.application.findFirst({
    where: { AND: [{ id: req.params.id }, calendarScope(req.user)] },
    include: { candidate: true, requirement: { include: { client: true } } },
  });
  if (!app) { await notFoundOrOutOfScope(req, res); return null; }
  if (!app.interviewStatus) { res.status(400).json({ error: 'No interview on this application' }); return null; }
  return app;
}

async function notFoundOrOutOfScope(req, res) {
  const exists = await prisma.application.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (exists) res.status(403).json({ error: 'This record is outside your access scope' });
  else res.status(404).json({ error: 'Application not found' });
}

async function recordEvent(applicationId, status, extra = {}) {
  await prisma.interviewEvent.create({ data: { applicationId, status, ...extra } });
}

async function respondWith(res, id, extra = {}) {
  const app = await prisma.application.findUnique({ where: { id }, include: CALENDAR_INCLUDE });
  const row = shapeRecruitment(app);
  // eslint-disable-next-line global-require
  row.panel = (await require('../utils/interviewPanel').panelsFor([app])).get(app.id) || [];
  res.json({ ...row, ...extra });
}

// ---------------------------------------------------------------------------
// B4 (2026-10-06): THE INTERVIEW PANEL, AND "CREATE MEETING LINK".
//   GET  /interviews/panel-options?q=        staff logins to pick from
//   PUT  /interviews/:id/panel               { panel: [{userId} | {name, email}] }
//   POST /interviews/:id/panel/:pid/feedback one panelist's own scorecard
//   GET  /interviews/meeting-link/setup      is Calendar Sync set up? (+ steps)
//   POST /interviews/:id/meeting-link        a REAL Meet / Teams link, or
//                                            "built, needs an account"
// The overall decision is still ONE (the Internal feedback + Decide).
// ---------------------------------------------------------------------------
router.get('/interviews/panel-options', async (req, res) => {
  // eslint-disable-next-line global-require
  res.json({ rows: await require('../utils/interviewPanel').staffOptions(req.query.q) });
});

router.put('/interviews/:id/panel', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return undefined;
  // eslint-disable-next-line global-require
  const PANEL = require('../utils/interviewPanel');
  if (!PANEL.ready()) return res.status(503).json({ error: 'The panel is being set up (database update pending). Please try again later.' });
  const parsed = await PANEL.parsePanel((req.body || {}).panel);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.entries || !parsed.entries.length) return res.status(400).json({ error: 'Add at least one interviewer.' });
  const round = app.interviewRound || 1;
  await PANEL.setPanel(app.id, round, parsed.entries);
  const names = PANEL.namesOf(parsed.entries);
  await prisma.application.update({ where: { id: app.id }, data: { interviewer: names } });
  await logAudit({ userId: req.user.id, action: `Interview panel set — round ${round}`, entity: 'Application', entityId: app.id, fromValue: app.interviewer || '—', toValue: names });
  return respondWith(res, app.id, { message: `Saved. Panel: ${names}.` });
});

router.post('/interviews/:id/panel/:pid/feedback', async (req, res) => {
  // eslint-disable-next-line global-require
  const PANEL = require('../utils/interviewPanel');
  if (!PANEL.ready()) return res.status(503).json({ error: 'The panel is being set up. Please try again later.' });
  const member = await prisma.interviewPanelist.findUnique({ where: { id: req.params.pid } });
  if (!member || member.applicationId !== req.params.id) return res.status(404).json({ error: 'That panel member was not found on this interview.' });
  // The panelist themself, or anyone who runs this interview (for an outside
  // interviewer whose feedback came by phone / email).
  const own = !!member.userId && member.userId === req.user.id;
  let app;
  if (own) {
    app = await prisma.application.findUnique({ where: { id: member.applicationId }, include: { candidate: true, requirement: { include: { client: true } } } });
    if (!app || !app.interviewStatus) return res.status(400).json({ error: 'No interview on this application' });
  } else {
    app = await loadInterview(req, res);
    if (!app) return undefined;
  }
  if (['CANCELLED', 'NO_SHOW'].includes(app.interviewStatus)) {
    return res.status(409).json({ error: `This interview is ${interviewStatusLabel(app.interviewStatus)} — no feedback is due.` });
  }
  const card = PANEL.readScorecard(req.body);
  if (card.error) return res.status(400).json({ error: card.error });
  await prisma.interviewPanelist.update({
    where: { id: member.id },
    data: { ...card.data, feedbackAt: new Date(), feedbackById: req.user.id, feedbackByName: own ? req.user.name : `${req.user.name} (for ${member.name})` },
  });
  await logAudit({ userId: req.user.id, action: `Panel feedback — ${member.name}: ${card.data.recommendation}`, entity: 'Application', entityId: app.id, toValue: card.data.recommendation });
  const r = app.requirement || {};
  // eslint-disable-next-line global-require
  await require('../utils/notify').notifyUsers([r.recruiterId, r.tlId], {
    title: `Panel feedback: ${app.candidate.name}`,
    message: `${member.name} — ${card.data.recommendation}. Open Interviews → Waiting for feedback to see the whole panel and decide.`,
    exceptUserId: req.user.id,
  });
  return respondWith(res, app.id, { message: `Saved. ${member.name}: ${card.data.recommendation}.` });
});

router.get('/interviews/meeting-link/setup', async (req, res) => {
  // eslint-disable-next-line global-require
  res.json(await require('../utils/meetingLinks').setupReport());
});

router.post('/interviews/:id/meeting-link', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return undefined;
  if (!app.interviewAt) return res.status(409).json({ error: 'Book the date and time first.' });
  if (String(app.interviewMode || '').toLowerCase().includes('person')) return res.status(409).json({ error: 'This interview is in person, so it needs no meeting link.' });
  // eslint-disable-next-line global-require
  const ML = require('../utils/meetingLinks');
  const r = app.requirement || {};
  const company = r.internal ? 'TeamLink' : (r.client && r.client.name) || '';
  const made = await ML.createMeeting({
    title: `Interview: ${app.candidate.name} — ${r.title || 'Job'}${company ? ` (${company})` : ''}`,
    description: `Round ${app.interviewRound || 1}. Interviewer(s): ${app.interviewer || 'to be confirmed'}. Booked in TeamLink.`,
    start: app.interviewAt,
  });
  if (made.needsAccount) {
    return res.status(409).json({
      needsAccount: true,
      error: 'Built — needs an account. Ask your Admin to connect Google Meet or Microsoft Teams in Administration → Integrations → Calendar Sync. Until then, paste the meeting link by hand.',
      setup: made.report,
    });
  }
  if (!made.ok) return res.status(502).json({ error: made.error });
  await prisma.application.update({ where: { id: app.id }, data: { interviewMeetingLink: made.url } });
  await logAudit({ userId: req.user.id, action: `Meeting link created — ${made.provider}`, entity: 'Application', entityId: app.id, fromValue: app.interviewMeetingLink || '—', toValue: made.url, reason: made.eventId ? `calendar event ${made.eventId}` : null });
  return respondWith(res, app.id, { message: `${made.provider} link created and saved on the interview.`, meetingLink: made.url });
});

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

// Review #2 §16 — record which kind of interview this is (Recruiter / TL /
// Client Interview) in the existing interviewType column. The AI interview is
// its own record and is never set here.
router.patch('/interviews/:id/type', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  const type = String(req.body.interviewType || req.body.type || '').trim();
  if (!INTERVIEW_SLOT_TYPES.includes(type)) {
    return res.status(400).json({ error: `Interview type must be one of: ${INTERVIEW_SLOT_TYPES.join(', ')}` });
  }
  if (app.interviewType !== type) {
    await prisma.application.update({ where: { id: app.id }, data: { interviewType: type } });
    await logAudit({
      userId: req.user.id, action: `Interview type set — ${type}`, entity: 'Application',
      entityId: app.id, fromValue: app.interviewType || '—', toValue: type,
    });
  }
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
  // Everyone who was told about the booking is told it is off (§11).
  await require('../utils/interviewNotices').announceInterview(app.id, 'cancelled', { actor: req.user, reason }); // eslint-disable-line global-require
  await respondWith(res, app.id);
});

// "Did not attend" (change list §11, 2026-10-03) — asked from the interview's
// feedback form only (the calendar row has no No Show button). A reason is
// required, and a new time may be offered in the same step: the slot is then
// rescheduled (history keeps both) and everyone is told.
router.post('/interviews/:id/no-show', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say why the candidate did not attend.' });
  if (['CANCELLED', 'FEEDBACK_SUBMITTED'].includes(app.interviewStatus)) {
    return res.status(409).json({ error: `This interview is ${interviewStatusLabel(app.interviewStatus)} — it cannot be marked "did not attend".` });
  }
  let when = null;
  if (req.body.rescheduleAt) {
    when = new Date(req.body.rescheduleAt);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'The new time is not valid.' });
    if (when.getTime() < Date.now() - 5 * 60000) return res.status(400).json({ error: 'The new time has already passed — pick a later time.' });
  }
  await prisma.application.update({ where: { id: app.id }, data: { interviewStatus: 'NO_SHOW', interviewCancelReason: `Did not attend — ${reason}` } });
  await recordEvent(app.id, 'NO_SHOW', { reason: `Did not attend — ${reason}`, by: req.user.name });
  await logAudit({
    userId: req.user.id, action: `Interview — did not attend (${reason})`, entity: 'Application',
    entityId: app.id, fromValue: interviewStatusLabel(app.interviewStatus), toValue: 'No Show', reason,
  });
  const IN = require('../utils/interviewNotices'); // eslint-disable-line global-require
  if (when) {
    const fromSlot = app.interviewAt ? app.interviewAt.toISOString() : '—';
    await prisma.application.update({
      where: { id: app.id },
      data: { interviewStatus: 'RESCHEDULED', interviewAt: when, interviewRescheduleCount: app.interviewRescheduleCount + 1, interviewCancelReason: null },
    });
    await recordEvent(app.id, 'RESCHEDULED', { reason: `New time after did not attend — ${reason}`, by: req.user.name, fromSlot, toSlot: when.toISOString() });
    await IN.announceInterview(app.id, 'rescheduled', { actor: req.user, fromSlot: app.interviewAt, reason: 'The candidate did not attend — a new time is booked' });
  } else {
    await IN.announceInterview(app.id, 'no_show', { actor: req.user, reason, candidateEmail: true });
  }
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
  // Everyone is told the new time; the reminders re-arm for the new slot.
  await require('../utils/interviewNotices').announceInterview(app.id, 'rescheduled', { actor: req.user, fromSlot: app.interviewAt, reason }); // eslint-disable-line global-require
  await respondWith(res, app.id);
});

// INTERNAL interview feedback — the panel’s own record.
//
//   Completed -> Feedback Pending -> Feedback Submitted -> Decision
//
// The form is Technical Skills, Communication, Experience, Role Fit, Overall
// Feedback and a Recommendation of Selected / Rejected / Hold. Submitting it
// moves the interview’s STATUS to Feedback Submitted; the RESULT it records
// is a separate column and the pipeline decision is a separate action
// (POST /ats/interviews/:id/decision). Deliberately separate from
// aiInterviewScore, and separate from the client’s own feedback record.
router.post('/interviews/:id/feedback', async (req, res) => {
  const app = await loadInterview(req, res);
  if (!app) return;
  // The short form (rating · strengths · concerns · decision — change list
  // §11) is folded into the same record; see utils/shortFeedback.js.
  const SF = require('../utils/shortFeedback'); // eslint-disable-line global-require
  const short = SF.fromShortForm(req.body);
  const shortProblem = SF.shortFormProblem(short);
  if (shortProblem) return res.status(400).json({ error: shortProblem });
  if (short) {
    req.body.feedback = short.overall;
    Object.assign(req.body, short.ratings);
    if (req.body.score === undefined) req.body.score = '';
  }
  if (['CANCELLED', 'NO_SHOW'].includes(app.interviewStatus)) {
    return res.status(409).json({ error: `This interview is ${interviewStatusLabel(app.interviewStatus)} — book a new time before giving feedback.` });
  }
  const feedback = (req.body.feedback || req.body.overall || '').trim();
  if (!feedback) return res.status(400).json({ error: 'Feedback is required' });
  // Selected / Rejected / Hold. The prototype’s older wording
  // (Recommended / Not Selected) is still accepted and read back as the new.
  const result = normalizeRecommendation(req.body.result || req.body.recommendation) || 'Selected';
  if (req.body.result && !normalizeRecommendation(req.body.result) && !INTERVIEW_RESULTS.includes(req.body.result)) {
    return res.status(400).json({ error: 'Unknown recommendation' });
  }
  let score = null;
  if (req.body.score !== '' && req.body.score != null) {
    const n = Number(req.body.score);
    if (Number.isNaN(n)) return res.status(400).json({ error: 'Score must be a number' });
    score = Math.max(0, Math.min(100, Math.round(n)));
  }
  const rating = (v) => {
    if (v === '' || v == null) return null;
    const n = Math.round(Number(v));
    return Number.isNaN(n) ? null : Math.max(1, Math.min(5, n));
  };

  await prisma.application.update({
    where: { id: app.id },
    data: {
      interviewStatus: 'FEEDBACK_SUBMITTED', interviewFeedback: feedback,
      interviewResult: result, interviewScore: score,
      // Completing the interview moves the pipeline forward, but the
      // select/reject decision stays a decision of its own.
      ...(app.stage === 'INTERVIEW_SCHEDULED' ? { stage: 'INTERVIEW_COMPLETED' } : {}),
    },
  });
  const data = {
    technical: rating(req.body.technical),
    communication: rating(req.body.communication),
    experience: rating(req.body.experience),
    roleFit: rating(req.body.roleFit),
    overall: feedback,
    recommendation: result,
    submittedById: req.user.id,
    submittedBy: req.user.name,
  };
  await prisma.interviewFeedback.upsert({
    where: { applicationId_kind: { applicationId: app.id, kind: 'Internal' } },
    create: { applicationId: app.id, kind: 'Internal', ...data },
    update: data,
  });
  // Round N in the history (layout v3); "Next round" = passed this round, the
  // next one is booked through the same Schedule popup (stored as Selected).
  await recordEvent(app.id, 'FEEDBACK_SUBMITTED', { reason: `Round ${app.interviewRound || 1} feedback — ${req.body.nextRound === true ? 'Next round' : result}`, by: req.user.name });
  // §32 — Interview Scheduled -> Interview Completed is a stage move: history,
  // follow-ups and the next person's notification (utils/stageEvents.js).
  if (app.stage === 'INTERVIEW_SCHEDULED') {
    await recordWorkflowMove({
      user: req.user, existing: app, toStage: 'INTERVIEW_COMPLETED', action: 'Interview feedback recorded',
    });
  }
  await logAudit({
    userId: req.user.id, action: `Interview feedback recorded — ${result}`, entity: 'Application',
    entityId: app.id, fromValue: interviewStatusLabel(app.interviewStatus), toValue: 'Feedback Submitted',
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
  const app = await prisma.application.findFirst({
    where: { AND: [{ id: req.params.id }, calendarScope(req.user)] },
    include: { candidate: true },
  });
  if (!app) { await notFoundOrOutOfScope(req, res); return null; }
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

// GLOBAL SEARCH — "Search TeamLink" (review #3 §13; spec §24 before it). One
// box: candidate name / phone / email / Candidate ID, client name / code /
// GSTIN, requirement ID / title, employee name / Employee ID. Results come back
// grouped and TYPED — CANDIDATE · CLIENT · REQUIREMENT · EMPLOYEE — each row
// with its ID (`code`) and the page it opens (`to`). `counts` are the full
// totals, each list its first `limit` rows (?limit=5 for the top-bar dropdown,
// SEARCH_TAKE for the results page).
//
// SCOPED like every list it links to:
//   Candidates    the caller's candidate scope (a client: only candidates
//                 SHARED with them); contact details for internal users only
//   Requirements  the caller's requirement scope — matched on title, code or
//                 the client's name, and each carries its client's NAME, which
//                 is all a non-client-desk role ever sees of a client
//   Clients       the client desk only (SA / Admin / Manager / Asst Manager /
//                 BDE — permissions "Client List"); `clientsAllowed` says so.
//                 Everyone else gets NO client records, only the name on a
//                 requirement row.
//   Employees     only a login that may view employee records (HRMS ->
//                 Employee Management / view — HR, the leads, SA / Admin) and
//                 only inside their employee scope (utils/scope.js
//                 employeeWhere: a TL their team, an STL their departments …).
//                 A recruiter, a BDE, a client: none. `employeesAllowed` says so.
//
// Candidate ID is printed as Candidate 360 prints it — "ID 4UKHHT91", the
// record id's last eight characters, upper-case — and
// a client with no stored Client ID CL-XXXXXX (utils/clientDuplicates
// displayCode) — both are accepted back as search terms.
const SEARCH_TAKE = 50;
router.get('/search', async (req, res) => {
  // eslint-disable-next-line global-require
  const { employeeWhere } = require('../utils/scope');
  // eslint-disable-next-line global-require
  const { displayCode } = require('../utils/clientDuplicates');
  // eslint-disable-next-line global-require
  const { stageLabel } = require('../utils/atsVocab');
  const q = String(req.query.q || '').trim().slice(0, 100);
  const take = Math.min(SEARCH_TAKE, Math.max(1, Number(req.query.limit) || SEARCH_TAKE));
  const s = scopeOf(req.user);
  const external = ['CLIENT', 'CANDIDATE'].includes(s.atsRole) || ['CLIENT', 'CANDIDATE'].includes(s.role);
  const [clientDesk, employeeView] = await Promise.all([
    can(req.user, 'ats', 'clients', 'Client List', 'view'),
    external ? false : can(req.user, 'hrms', 'hrms', 'Employee Management', 'view'),
  ]);
  const empty = {
    q, candidates: [], requirements: [], clients: [], employees: [],
    counts: { candidates: 0, requirements: 0, clients: 0, employees: 0 },
    clientsAllowed: !!clientDesk, employeesAllowed: !!employeeView,
  };
  if (!q) return res.json(empty);
  const isClient = s.atsRole === 'CLIENT' || s.role === 'CLIENT';
  // A client's candidates are only those SHARED with them (same gate as
  // routes/candidates.js); everyone else uses the ordinary candidate scope.
  const appScope = isClient
    ? { AND: [applicationWhere(req.user), { stage: { in: CLIENT_SHARED_STAGES } }] }
    : applicationWhere(req.user);
  const candScope = isClient ? { applications: { some: appScope } } : candidateWhere(req.user);
  // A phone number is typed with spaces, dashes or +91 — match on its digits.
  const digits = q.replace(/\D/g, '');
  // A record id, or its last 6-10 characters as the screens print it — with
  // or without the CAN- / CL- prefix.
  const bare = q.replace(/^(id|can|cand|cl)[-\s#:]*/i, '');
  const idLike = /^[a-z0-9]{6,}$/i.test(bare) ? bare.toLowerCase() : '';
  const idArms = idLike ? [{ id: idLike }, ...(idLike.length <= 10 ? [{ id: { endsWith: idLike } }] : [])] : [];
  const candMatch = {
    OR: [
      { name: { contains: q } },
      ...idArms,
      ...(isClient ? [] : [{ email: { contains: q } }, { phone: { contains: q } }]),
      ...(!isClient && digits.length >= 4 && digits !== q ? [{ phone: { contains: digits.slice(-10) } }] : []),
    ],
  };
  const reqMatch = {
    OR: [
      { title: { contains: q } },
      { reqCode: { contains: q } },
      { id: q },
      { client: { is: { name: { contains: q } } } },
    ],
  };
  const candWhere = { AND: [candScope, candMatch] };
  const reqWhere = { AND: [requirementWhere(req.user), reqMatch] };
  // A client by name, legal name, GSTIN, stored client code or display code.
  const clientWhereQ = {
    AND: [clientWhere(req.user), {
      OR: [
        { name: { contains: q } }, { legalName: { contains: q } },
        { gst: { contains: q.toUpperCase() } }, { clientCode: { contains: q } },
        ...(/^cl[-\s#:]/i.test(q) ? idArms : []),
      ],
    }],
  };
  const empWhere = employeeView
    ? { AND: [employeeWhere(req.user), { OR: [{ name: { contains: q } }, { employeeCode: { contains: q } }] }] }
    : null;
  const [candidates, candCount, requirements, reqCount, clients, clientCount, employees, empCount] = await Promise.all([
    prisma.candidate.findMany({
      where: candWhere,
      select: {
        id: true,
        name: true,
        ...(isClient ? {} : { email: true, phone: true }),
        applications: {
          where: appScope,
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { stage: true, requirementId: true, requirement: { select: { title: true, reqCode: true } } },
        },
      },
      orderBy: { name: 'asc' },
      take,
    }),
    prisma.candidate.count({ where: candWhere }),
    prisma.requirement.findMany({
      where: reqWhere,
      select: {
        id: true, title: true, reqCode: true, status: true, department: true,
        client: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.requirement.count({ where: reqWhere }),
    clientDesk
      ? prisma.client.findMany({ where: clientWhereQ, select: { id: true, name: true, clientCode: true, gst: true, location: true }, orderBy: { name: 'asc' }, take })
      : [],
    clientDesk ? prisma.client.count({ where: clientWhereQ }) : 0,
    empWhere
      ? prisma.employee.findMany({
        where: empWhere,
        select: { id: true, name: true, employeeCode: true, department: true, designation: true, employmentStatus: true },
        orderBy: { name: 'asc' },
        take,
      })
      : [],
    empWhere ? prisma.employee.count({ where: empWhere }) : 0,
  ]);
  const candidateCode = (id) => `ID ${String(id).slice(-8).toUpperCase()}`;
  res.json({
    ...empty,
    candidates: candidates.map((c) => {
      const last = c.applications[0];
      return {
        type: 'CANDIDATE',
        id: c.id,
        code: candidateCode(c.id),
        name: c.name,
        email: c.email || null,
        phone: c.phone || null,
        requirement: last && last.requirement ? last.requirement.title : null,
        requirementCode: last && last.requirement ? last.requirement.reqCode || null : null,
        stageLabel: last ? stageLabel(last.stage) : null,
        to: `/candidates/${c.id}`,
      };
    }),
    requirements: requirements.map((r) => ({
      type: 'REQUIREMENT',
      id: r.id, code: r.reqCode || null, title: r.title, reqCode: r.reqCode, status: r.status, department: r.department,
      // The client's NAME only — never the client record — for every role.
      client: r.client ? { id: r.client.id, name: r.client.name } : null,
      to: `/requirements/${r.id}`,
    })),
    clients: clients.map((c) => ({
      type: 'CLIENT', ...c, code: displayCode(c), to: `/clients/${c.id}`,
    })),
    employees: employees.map((e) => ({
      type: 'EMPLOYEE',
      id: e.id,
      code: e.employeeCode,
      name: e.name,
      roleLabel: e.designation || null,
      department: e.department || null,
      status: e.employmentStatus || null,
      to: `/employees/${e.id}`,
    })),
    counts: { candidates: candCount, requirements: reqCount, clients: clientCount, employees: empCount },
  });
});

module.exports = router;
