// ---------------------------------------------------------------------------
// FOLLOW-UPS — one per APPLICATION, recordable by its owner.
//
// There is no second permission path here. Reads are gated by the same
// candidates / Applications / view the pipeline already uses, writes by
// candidates / Applications / edit, and both are then narrowed by
// utils/scope.js applicationWhere() — so a Medical recruiter's follow-up list
// is exactly the applications they can already reach, and a follow-up on an
// application outside their assignment is refused by the API, not hidden.
//
// The extra rung on top of the permission is OWNERSHIP: recording a follow-up
// is the owner's act. A user may record one when they are named anywhere on
// the requirement's assignment chain (utils/scope.js isAssignedTo) or when
// their scope is global. A TL who can merely SEE a department's application
// cannot log a call they did not make.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const {
  applicationWhere, isAssignedTo, scopeOf, scopeLabel, OUT_OF_SCOPE,
} = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { stageLabel } = require('../utils/atsVocab');
const {
  FOLLOWUP_STATUSES, CONTACT_MODES, decorate, chainSnapshot, resolveNames,
  defaultNextAction, defaultDueDate, escalateOverdue, todayStr, followUpStatus,
  CALL_RESULTS, FOLLOWUP_OUTCOMES, FOLLOWUP_NEXT_STEPS, NEXT_STEPS_NEEDING_DATE,
  FOLLOWUP_TEMPLATES, ESCALATION_LADDER,
} = require('../utils/followups');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'candidates', 'Applications', 'view'));

const APPLICATION_INCLUDE = {
  candidate: { select: { id: true, name: true, email: true, phone: true } },
  requirement: { include: { client: true, recruiter: true, bde: true } },
};

// Load the application this follow-up is about, scope-checked. Returns null
// when the caller may not reach it, so the handler answers 403 rather than
// leaking that the row exists.
async function loadApplication(user, applicationId) {
  const where = { AND: [{ id: applicationId }, applicationWhere(user)] };
  return prisma.application.findFirst({ where, include: APPLICATION_INCLUDE });
}

// May this user RECORD against this application? Permission (checked by the
// route guard) plus ownership (checked here).
function mayRecord(user, application) {
  const s = scopeOf(user);
  if (s.global) return true;
  if (['CLIENT', 'CANDIDATE'].includes(s.role) || ['CLIENT', 'CANDIDATE'].includes(s.atsRole)) return false;
  return isAssignedTo(user, application.requirement);
}

function shape(row, application) {
  const d = decorate(row);
  if (!application) return d;
  const r = application.requirement || {};
  return {
    ...d,
    candidateName: application.candidate ? application.candidate.name : null,
    applicationStage: application.stage,
    applicationStageLabel: stageLabel(application.stage),
    requirementTitle: r.title || null,
    requirementCode: r.reqCode || null,
    clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/followups
//
// The follow-up list. Scoped, and every active application is represented:
// one that has never been followed up yet comes back with a null follow-up
// and status "Upcoming", so the screen shows the work that has NOT been done
// rather than only the work that has.
//
// Escalation is evaluated here — see utils/followups.js for exactly when and
// why that is a read-time evaluation in an app with no scheduler.
// ---------------------------------------------------------------------------
const CLOSED_STAGES = ['JOINED', 'HIRED', 'REJECTED'];

// THE LIST, BUILT ONCE. Both the table and the dashboard read it, so a count
// on a tile can never disagree with the rows behind it.
async function buildList(req) {
  await escalateOverdue();


  const where = { ...applicationWhere(req.user) };
  if (req.query.applicationId) where.id = req.query.applicationId;
  if (req.query.candidateId) where.candidateId = req.query.candidateId;
  const applications = await prisma.application.findMany({
    where, include: APPLICATION_INCLUDE, orderBy: { updatedAt: 'desc' },
  });
  const active = req.query.includeClosed === '1'
    ? applications
    : applications.filter((a) => !CLOSED_STAGES.includes(a.stage));
  const ids = active.map((a) => a.id);

  const rows = ids.length
    ? await prisma.applicationFollowUp.findMany({
      where: { applicationId: { in: ids } }, orderBy: { createdAt: 'desc' },
    })
    : [];
  const current = new Map();
  rows.forEach((row) => {
    const held = current.get(row.applicationId);
    if (!held) current.set(row.applicationId, row);
    else if (held.completedAt && !row.completedAt) current.set(row.applicationId, row);
  });

  const today = todayStr();
  const s = scopeOf(req.user);
  const names = await resolveNames(active.map((a) => a.requirement));
  let out = active.map((a) => {
    const row = current.get(a.id) || null;
    const snap = chainSnapshot(a, a.requirement, names);
    const r = a.requirement || {};
    return {
      applicationId: a.id,
      candidateId: a.candidateId,
      candidateName: a.candidate ? a.candidate.name : null,
      requirementId: a.requirementId,
      requirementTitle: r.title || null,
      requirementCode: r.reqCode || null,
      clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
      stage: a.stage,
      stageLabel: stageLabel(a.stage),
      // Owner / Owner Role / TL / BDE — from the row where one exists (the
      // snapshot at the time it was recorded), otherwise resolved live from
      // the assignment chain so an un-followed-up application still says who
      // owes it.
      owner: (row && row.ownerName) || snap.ownerName || '—',
      ownerRole: (row && row.ownerRole) || snap.ownerRole || '—',
      ownerUserId: (row && row.ownerUserId) || snap.ownerUserId || null,
      tl: (row && row.tlName) || snap.tlName || '—',
      bde: (row && row.bdeName) || snap.bdeName || '—',
      lastContactedAt: row ? row.lastContactedAt : null,
      contactMode: row ? row.contactMode : null,
      nextAction: (row && row.nextAction) || defaultNextAction(a),
      dueDate: row ? row.dueDate : null,
      nextFollowUpAt: row ? row.nextFollowUpAt : null,
      notes: row ? row.notes : null,
      status: row ? followUpStatus(row, today) : 'Upcoming',
      daysOverdue: row ? decorate(row, today).daysOverdue : 0,
      escalatedTlAt: row ? row.escalatedTlAt : null,
      escalatedAdminAt: row ? row.escalatedAdminAt : null,
      // The rest of the row the dashboard and the outcome dialog read.
      dueTime: row ? row.dueTime : null,
      purpose: row ? row.purpose : null,
      autoCreated: row ? row.autoCreated : false,
      escalationLevel: row ? row.escalationLevel : 0,
      outcome: row ? row.outcome : null,
      nextStep: row ? row.nextStep : null,
      followUpId: row ? row.id : null,
      recorded: !!row,
    };
  });

  if (req.query.mine === '1') out = out.filter((f) => f.ownerUserId === s.userId);
  if (req.query.status) {
    const wanted = String(req.query.status).split(',').map((x) => x.trim()).filter(Boolean);
    out = out.filter((f) => wanted.includes(f.status));
  }
  const ORDER = { Overdue: 0, 'Due Today': 1, Upcoming: 2, Completed: 3 };
  out.sort((a, b) => (ORDER[a.status] - ORDER[b.status])
    || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    return res.json(await buildList(req));
  } catch (err) {
    return next(err);
  }
});



// ---------------------------------------------------------------------------
// THE FOLLOW-UP DASHBOARD (§21-§25).
//
// One endpoint, five shapes, chosen by the CALLER'S ROLE rather than by a
// query parameter — a recruiter asking for the admin view would still only be
// answered about their own scope, so letting the client pick would be a lie.
//
//   Recruiter / BDE   My Follow-ups              (§21)
//   TL                + My Team, by owner        (§22)
//   STL / Manager     + My Department, by owner  (§23)
//   Admin             + company-wide health      (§24)
//   Super Admin       + the escalation monitor   (§25)
//
// Every figure is counted over buildList(req), which is scoped by
// utils/scope.js applicationWhere() — so a tile can never show a number the
// rows behind it do not add up to, and nobody is counted outside their scope.
// ---------------------------------------------------------------------------
router.get('/dashboard', async (req, res, next) => {
  try {
    const all = await buildList(req);
    const s = scopeOf(req.user);
    const role = s.atsRole || s.role;

    const tally = (rows) => ({
      overdue: rows.filter((f) => f.status === 'Overdue').length,
      dueToday: rows.filter((f) => f.status === 'Due Today').length,
      upcoming: rows.filter((f) => f.status === 'Upcoming').length,
      completed: rows.filter((f) => f.status === 'Completed').length,
    });

    const mine = all.filter((f) => f.ownerUserId === s.userId);
    const others = all.filter((f) => f.ownerUserId !== s.userId);

    // Per-owner breakdown — "evaru follow-up cheyyaledu?" answered directly.
    const byOwner = (rows) => {
      const map = new Map();
      rows.forEach((f) => {
        const key = f.ownerUserId || f.owner || '—';
        if (!map.has(key)) {
          map.set(key, { ownerUserId: f.ownerUserId, owner: f.owner, ownerRole: f.ownerRole, overdue: 0, dueToday: 0, upcoming: 0 });
        }
        const e = map.get(key);
        if (f.status === 'Overdue') e.overdue += 1;
        else if (f.status === 'Due Today') e.dueToday += 1;
        else if (f.status === 'Upcoming') e.upcoming += 1;
      });
      return [...map.values()].sort((x, y) => y.overdue - x.overdue || y.dueToday - x.dueToday);
    };

    const payload = {
      scope: scopeLabel(req.user),
      // §21 — every role gets this, and it is always FIRST.
      mine: { ...tally(mine), rows: mine.slice(0, 50) },
      // §26-§27 — the three things to do now, most overdue first. The whole
      // point is that a user should not have to go looking.
      doThisNow: [...mine]
        .filter((f) => f.status === 'Overdue' || f.status === 'Due Today')
        .slice(0, 5)
        .map((f) => ({
          applicationId: f.applicationId,
          candidateId: f.candidateId,
          what: f.candidateName,
          why: f.nextAction,
          status: f.status,
          due: f.dueDate,
          owner: f.owner,
          followUpId: f.followUpId,
        })),
    };

    // §22-§23 — a lead also sees the people under them.
    if (['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'ADMIN', 'SUPER_ADMIN'].includes(role) || s.global) {
      payload.team = {
        label: role === 'TL' ? 'My Team' : 'My Department',
        ...tally(others),
        owners: byOwner(others),
      };
    }

    // §24 — the health panel. `unassigned` is the one that matters most: a
    // follow-up nobody owns is the one that will certainly be missed.
    if (s.global || ['ADMIN', 'SUPER_ADMIN'].includes(s.role)) {
      payload.health = {
        ...tally(all),
        unassigned: all.filter((f) => !f.ownerUserId).length,
        escalated: all.filter((f) => f.escalationLevel > 0).length,
      };
    }

    // §25 — the escalation monitor, by rung. Only genuinely unresolved items
    // are on it: a completed follow-up leaves the ladder whatever level it
    // reached.
    if (s.role === 'SUPER_ADMIN' || s.global) {
      const live = all.filter((f) => f.status !== 'Completed');
      payload.escalation = [
        { level: 0, label: 'Owner', count: live.filter((f) => !f.escalationLevel).length },
        ...ESCALATION_LADDER.map((r) => ({
          level: r.level,
          label: r.label,
          afterDays: r.afterDays,
          count: live.filter((f) => f.escalationLevel === r.level).length,
        })),
      ];
    }

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

// The full follow-up history for one application — what the candidate detail
// page's Follow-ups panel renders under the current one.
router.get('/application/:applicationId', async (req, res, next) => {
  try {
    const application = await loadApplication(req.user, req.params.applicationId);
    if (!application) return res.status(403).json(OUT_OF_SCOPE);
    const rows = await prisma.applicationFollowUp.findMany({
      where: { applicationId: application.id }, orderBy: { createdAt: 'desc' },
    });
    const open = rows.find((r) => !r.completedAt) || null;
    const names = await resolveNames([application.requirement]);
    return res.json({
      applicationId: application.id,
      canRecord: mayRecord(req.user, application),
      chain: chainSnapshot(application, application.requirement, names),
      suggestedNextAction: defaultNextAction(application),
      suggestedDueDate: defaultDueDate(application),
      current: open ? shape(open, application) : null,
      history: rows.map((r) => shape(r, application)),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/followups — record a follow-up.
//
// Recording CLOSES whatever was open (that touch has now happened) and opens
// the next one. The table is therefore the whole history of the thread, and
// the application's current follow-up is simply its newest open row.
// ---------------------------------------------------------------------------
router.post('/', requirePerm('ats', 'candidates', 'Applications', 'edit'), async (req, res, next) => {
  try {
    const { applicationId } = req.body;
    if (!applicationId) return res.status(400).json({ error: 'applicationId is required' });
    const application = await loadApplication(req.user, applicationId);
    if (!application) return res.status(403).json(OUT_OF_SCOPE);
    if (!mayRecord(req.user, application)) {
      return res.status(403).json({
        error: 'A follow-up is recorded by its owner — you are not on this requirement’s assignment chain.',
      });
    }

    const dueDate = String(req.body.dueDate || '').trim() || defaultDueDate(application);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD.' });
    const nextFollowUpAt = String(req.body.nextFollowUpAt || '').trim() || null;
    if (nextFollowUpAt && !/^\d{4}-\d{2}-\d{2}$/.test(nextFollowUpAt)) {
      return res.status(400).json({ error: 'Next follow-up must be YYYY-MM-DD.' });
    }
    const contactMode = req.body.contactMode && CONTACT_MODES.includes(req.body.contactMode)
      ? req.body.contactMode : null;

    let lastContactedAt = null;
    if (req.body.lastContactedAt) {
      const parsed = new Date(req.body.lastContactedAt);
      if (!Number.isNaN(parsed.getTime())) lastContactedAt = parsed;
    }
    // Recording a follow-up IS a contact unless the recorder says otherwise.
    if (!lastContactedAt && req.body.contacted !== false) lastContactedAt = new Date();

    const names = await resolveNames([application.requirement]);
    const snap = chainSnapshot(application, application.requirement, names);
    // The person recording is the one who owed it — snapshot them as owner
    // where the chain does not name anyone, so the row is never ownerless.
    if (!snap.ownerUserId) {
      snap.ownerUserId = req.user.id;
      snap.ownerName = req.user.name;
      snap.ownerRole = req.user.atsRole || req.user.role;
    }

    // Close whatever was open first — that touch has now happened.
    const open = await prisma.applicationFollowUp.findFirst({
      where: { applicationId: application.id, completedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      await prisma.applicationFollowUp.update({
        where: { id: open.id },
        data: {
          completedAt: new Date(),
          completedById: req.user.id,
          completedNote: req.body.notes || null,
          lastContactedAt: lastContactedAt || open.lastContactedAt,
        },
      });
    }

    const created = await prisma.applicationFollowUp.create({
      data: {
        applicationId: application.id,
        candidateId: application.candidateId,
        requirementId: application.requirementId,
        ...snap,
        lastContactedAt,
        contactMode,
        nextAction: String(req.body.nextAction || '').trim() || defaultNextAction(application),
        dueDate,
        nextFollowUpAt,
        notes: req.body.notes || null,
        createdById: req.user.id,
        createdByName: req.user.name,
      },
    });

    await logAudit({
      userId: req.user.id,
      action: 'Follow-up recorded',
      entity: 'Application',
      entityId: application.id,
      field: 'followUp',
      fieldLabel: 'Follow-up',
      fromValue: open ? `${open.nextAction || '—'} (due ${open.dueDate || '—'})` : 'none',
      toValue: `${created.nextAction} (due ${created.dueDate})`,
      actorName: req.user.name,
    });

    // The people on the chain other than whoever recorded it.
    await notifyUsers([snap.ownerUserId, snap.tlUserId].filter(Boolean), {
      title: `Follow-up set — ${application.candidate ? application.candidate.name : 'candidate'}`,
      message: `${created.nextAction} · due ${created.dueDate}`,
      exceptUserId: req.user.id,
    });

    return res.status(201).json(shape(created, application));
  } catch (err) {
    return next(err);
  }
});

// Mark the open follow-up done without opening another — "this thread is
// finished", as distinct from "I called, here is the next one".
// COMPLETING A FOLLOW-UP IS TWO ANSWERS, NOT A NOTE (§8, §9).
//
// This used to take one free-text `note`, so "what happened" and "what next"
// were whatever the owner chose to type — or did not. Both are recorded
// choices now, and a next step that implies another touch REFUSES to save
// without a date. That refusal is the whole point: it is what stops a
// follow-up ending in "we called them, and now nobody knows what happens".
//
// A SECOND FOLLOW-UP IS RAISED AUTOMATICALLY when a date is given, so the
// chain continues without anybody remembering to start it.
router.post('/:id/complete', requirePerm('ats', 'candidates', 'Applications', 'edit'), async (req, res, next) => {
  try {
    const row = await prisma.applicationFollowUp.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Follow-up not found' });
    const application = await loadApplication(req.user, row.applicationId);
    if (!application) return res.status(403).json(OUT_OF_SCOPE);
    if (!mayRecord(req.user, application)) {
      return res.status(403).json({ error: 'A follow-up is completed by its owner.' });
    }
    if (row.completedAt) return res.status(400).json({ error: 'This follow-up is already completed.' });

    const outcome = req.body.outcome ? String(req.body.outcome).trim() : '';
    const nextStep = req.body.nextStep ? String(req.body.nextStep).trim() : '';
    const nextDate = req.body.nextFollowUpAt ? String(req.body.nextFollowUpAt).trim() : '';
    const nextTime = req.body.nextFollowUpTime ? String(req.body.nextFollowUpTime).trim() : '';

    if (!outcome) {
      return res.status(400).json({ error: 'Record what happened before closing this follow-up.' });
    }
    if (!FOLLOWUP_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `Unknown outcome. Choose one of: ${FOLLOWUP_OUTCOMES.join(', ')}.` });
    }
    if (!nextStep) {
      return res.status(400).json({ error: 'Choose what should happen next.' });
    }
    if (!FOLLOWUP_NEXT_STEPS.includes(nextStep)) {
      return res.status(400).json({ error: `Unknown next step. Choose one of: ${FOLLOWUP_NEXT_STEPS.join(', ')}.` });
    }
    if (NEXT_STEPS_NEEDING_DATE.includes(nextStep) && !nextDate) {
      return res.status(400).json({
        error: `"${nextStep}" needs a date — otherwise nobody knows when it is owed.`,
      });
    }

    const updated = await prisma.applicationFollowUp.update({
      where: { id: row.id },
      data: {
        completedAt: new Date(),
        completedById: req.user.id,
        completedNote: req.body.note || null,
        outcome,
        nextStep,
        contactMode: req.body.contactMode || row.contactMode,
        nextFollowUpAt: nextDate || null,
        nextFollowUpTime: nextTime || null,
        lastContactedAt: row.lastContactedAt || new Date(),
      },
    });

    // THE CHAIN CONTINUES BY ITSELF. Where a date was given, the next
    // follow-up exists the moment this one closes — the owner does not have to
    // remember to raise it, which is exactly how chains break.
    let nextFollowUp = null;
    if (nextDate) {
      nextFollowUp = await prisma.applicationFollowUp.create({
        data: {
          applicationId: row.applicationId,
          candidateId: row.candidateId,
          requirementId: row.requirementId,
          ownerUserId: row.ownerUserId,
          ownerName: row.ownerName,
          ownerRole: row.ownerRole,
          tlUserId: row.tlUserId,
          tlName: row.tlName,
          stlUserId: row.stlUserId,
          stlName: row.stlName,
          bdeUserId: row.bdeUserId,
          bdeName: row.bdeName,
          nextAction: nextStep,
          purpose: nextStep,
          dueDate: nextDate,
          dueTime: nextTime || null,
          autoCreated: true,
          createdById: req.user.id,
          createdByName: req.user.name || null,
        },
      });
    }

    await logAudit({
      userId: req.user.id,
      action: 'Follow-up completed',
      entity: 'Application',
      entityId: application.id,
      fromValue: `${row.nextAction || '—'} (due ${row.dueDate || '—'})`,
      toValue: `${outcome} → ${nextStep}${nextDate ? ` on ${nextDate}${nextTime ? ` ${nextTime}` : ''}` : ''}`,
      actorName: req.user.name,
    });
    return res.json({
      ...shape(updated, application),
      nextFollowUp: nextFollowUp ? shape(nextFollowUp, application) : null,
    });
  } catch (err) {
    return next(err);
  }
});

// The endpoint a cron would hit. It is the SAME function the reads call, so a
// scheduled run and a read-time run cannot diverge. Exposed so that wiring a
// scheduler later is a deployment change, not a code change.
router.post('/run-escalation', requirePerm('ats', 'candidates', 'Applications', 'edit'), async (req, res, next) => {
  try {
    const summary = await escalateOverdue();
    return res.json({ ...summary, ranAt: new Date().toISOString(), trigger: 'manual' });
  } catch (err) {
    return next(err);
  }
});

router.get('/statuses', (req, res) => res.json({
  statuses: FOLLOWUP_STATUSES,
  contactModes: CONTACT_MODES,
  callResults: CALL_RESULTS,
  outcomes: FOLLOWUP_OUTCOMES,
  nextSteps: FOLLOWUP_NEXT_STEPS,
  nextStepsNeedingDate: NEXT_STEPS_NEEDING_DATE,
  templates: FOLLOWUP_TEMPLATES,
  escalationLadder: ESCALATION_LADDER.map((r) => ({ level: r.level, label: r.label, afterDays: r.afterDays })),
}));

module.exports = router;
