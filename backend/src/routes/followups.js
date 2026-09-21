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
const { applicationWhere, isAssignedTo, scopeOf, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { stageLabel } = require('../utils/atsVocab');
const {
  FOLLOWUP_STATUSES, CONTACT_MODES, decorate, chainSnapshot, resolveNames,
  defaultNextAction, defaultDueDate, escalateOverdue, todayStr, followUpStatus,
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

router.get('/', async (req, res, next) => {
  try {
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
    return res.json(out);
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

    const updated = await prisma.applicationFollowUp.update({
      where: { id: row.id },
      data: {
        completedAt: new Date(),
        completedById: req.user.id,
        completedNote: req.body.note || null,
        lastContactedAt: row.lastContactedAt || new Date(),
      },
    });
    await logAudit({
      userId: req.user.id,
      action: 'Follow-up completed',
      entity: 'Application',
      entityId: application.id,
      fromValue: `${row.nextAction || '—'} (due ${row.dueDate || '—'})`,
      toValue: 'Completed',
      actorName: req.user.name,
    });
    return res.json(shape(updated, application));
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

router.get('/statuses', (req, res) => res.json({ statuses: FOLLOWUP_STATUSES, contactModes: CONTACT_MODES }));

module.exports = router;
