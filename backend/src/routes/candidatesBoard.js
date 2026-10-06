// ---------------------------------------------------------------------------
// CANDIDATES §7 (2026-10-03) — mounted on the /candidates router by
// routes/candidates.js (before GET /:id), so it shares that router's auth,
// ATS-product and "Candidate List / view" guards.
//
//   GET  /candidates/board           the Progress board: one column per step,
//                                    a count each, the first N cards per
//                                    column; ?column=<key>&offset=N = "show
//                                    more" for one column. Same filters,
//                                    search and queues as the list, over the
//                                    same scoped rows (pipelineRowsFor).
//   POST /candidates/board/move      drag a card to a column. The server picks
//                                    the column's step for THIS application
//                                    and runs the ordinary stage move
//                                    (routes/applications.js applyStageMove:
//                                    role ownership, scope, the chain rule) —
//                                    a wrong move is refused in plain words.
//   POST /candidates/:id/archive     Archive (hidden from every list, data
//   POST /candidates/:id/unarchive   kept) / bring back. profileStatus =
//                                    'Archived'; never overwrites 'Do Not Use'.
//   DELETE /candidates/:id           real delete — Super Admin only, and only
//                                    for a duplicate or a wrong entry with no
//                                    work on it (nothing past New, no
//                                    interview, offer, invoice or login).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { canMoveToStage } = require('../utils/permissions');
const { roleForProduct } = require('../utils/permissions');
const { stageLabel } = require('../utils/atsVocab');
const { markCandidateDirty } = require('../utils/candidateListCache');

// ATS LAYOUT v3 (user, 2026-10-03): Sourced → Verified → TL check → BDE
// Review → Shared with Client → Interview → Selected → Joined, plus Rejected
// (separate, red). The TL check stays (user decision 1). Hold is not a
// column: a held card stays in the column of the step it was paused at, with
// an "On hold" badge.
const BOARD_COLUMNS = [
  { key: 'sourced', label: 'Sourced', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'], entry: ['NEW'] },
  { key: 'verified', label: 'Verified', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'], entry: ['RECRUITER_REVIEW'] },
  { key: 'tl', label: 'TL check', stages: ['TL_REVIEW'], entry: ['TL_REVIEW'] },
  { key: 'bde', label: 'BDE Review', stages: ['WITH_BDE', 'BDE_APPROVED'], entry: ['WITH_BDE'] },
  { key: 'shared', label: 'Shared with Client', stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'], entry: ['SHARED_WITH_CLIENT'] },
  { key: 'interview', label: 'Interview', stages: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'], entry: ['INTERVIEW_SCHEDULED'] },
  { key: 'selected', label: 'Selected', stages: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'], entry: ['SELECTED'] },
  { key: 'joined', label: 'Joined', stages: ['JOINED', 'HIRED'], entry: ['JOINED', 'HIRED'] },
  { key: 'rejected', label: 'Rejected', stages: ['REJECTED'], entry: ['REJECTED'], side: true },
];
// Old column keys (links / saved state from the first board).
const COLUMN_ALIAS = { new: 'sourced', recruiter: 'verified', client: 'shared', offer: 'selected' };
const COLUMN_OF = new Map();
BOARD_COLUMNS.forEach((c) => c.stages.forEach((s) => COLUMN_OF.set(s, c.key)));
const columnByKey = (k) => BOARD_COLUMNS.find((c) => c.key === (COLUMN_ALIAS[k] || k)) || null;
// Days in the step → colour on the card (green / yellow / red).
const daysTone = (days, late) => (late || days > 7 ? 'red' : days > 3 ? 'yellow' : 'green');
const DAY = 86400000;
const PER_COLUMN_DEFAULT = 20;
const PER_COLUMN_MAX = 100;

const atsRole = (u) => roleForProduct(u, 'ats') || u.atsRole || u.role;
const isSuperAdmin = (u) => !!u && (u.role === 'SUPER_ADMIN' || atsRole(u) === 'SUPER_ADMIN');
// Archive: the people who manage a team's candidates. Manager / Assistant
// Manager stay view + export only (binding decision); a recruiter asks the TL.
const ARCHIVE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL'];
const mayArchive = (u) => !!u && (ARCHIVE_ROLES.includes(u.role) || ARCHIVE_ROLES.includes(atsRole(u)));

// The step a card lands on when dropped on a column.
function targetStageFor(col, app, internal) {
  if (col.key === 'joined') return internal ? 'HIRED' : 'JOINED';
  return col.entry[0];
}

function cardOf(r, moved, now, heldAt = null) {
  const since = r.stageEnteredAt || (moved && moved.at) || r.appliedDate || r.createdAt;
  const days = since ? Math.max(0, Math.floor((now - new Date(since).getTime()) / DAY)) : null;
  const live = ['Active', 'Hold'].includes(r.pipelineStatus);
  return {
    recruiter: r.recruiterName || null,
    // The Verify checklist shows these next to its ticks.
    facts: {
      skills: r.skills || null,
      experienceYears: r.experienceYears ?? null,
      noticePeriod: r.noticePeriod || null,
      currentSalary: r.currentSalary || null,
      expectedSalary: r.expectedSalary || null,
    },
    tone: live ? daysTone(days || 0, r.dueStatus === 'overdue') : (r.pipelineStatus === 'Rejected' ? 'red' : 'green'),
    onHold: r.pipelineStatus === 'Hold',
    heldAt,
    id: r.id,
    candidateId: r.candidateId,
    name: r.name,
    phone: r.phone || null,
    requirementTitle: r.requirementTitle || null,
    clientName: r.clientName || null,
    internal: !!r.internal,
    stage: r.currentStage,
    stageLabel: r.currentStageLabel,
    owner: r.owner && r.owner !== '—' ? r.owner : null,
    ownerRole: r.ownerRole && r.ownerRole !== '—' ? r.ownerRole : null,
    daysInStep: days,
    dueStatus: r.dueStatus || null,
    movedBy: moved ? moved.by : null,
    movedAt: moved ? moved.at : null,
    matchScore: r.matchScore ?? null,
    pipelineStatus: r.pipelineStatus,
  };
}

async function lastMoves(appIds) {
  if (!appIds.length) return new Map();
  const events = await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: appIds } },
    orderBy: { createdAt: 'desc' },
    select: { applicationId: true, actorName: true, createdAt: true },
  });
  const out = new Map();
  events.forEach((e) => { if (!out.has(e.applicationId)) out.set(e.applicationId, { by: e.actorName || 'System', at: e.createdAt }); });
  return out;
}

// Oldest in the step first (who is stuck), except Joined: newest first.
function sortForColumn(key, rows) {
  const t = (r) => {
    const v = r.stageEnteredAt || r.appliedDate || r.createdAt;
    return v ? new Date(v).getTime() : 0;
  };
  return rows.sort((a, b) => (['joined', 'rejected'].includes(key) ? t(b) - t(a) : t(a) - t(b)));
}

// Where each held application was paused: the latest move INTO Hold.
async function heldFromStages(appIds) {
  const out = new Map();
  for (let i = 0; i < appIds.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const events = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: appIds.slice(i, i + 500) }, toStage: 'HOLD' },
      orderBy: { createdAt: 'desc' },
      select: { applicationId: true, fromStage: true },
    });
    events.forEach((e) => { if (!out.has(e.applicationId) && e.fromStage) out.set(e.applicationId, e.fromStage); });
  }
  return out;
}

module.exports = function mountCandidatesBoard(router, deps) {
  const {
    pipelineRowsFor, pipelineRowMatches, QUEUES, hasPersonQuery, attributedApplications, loadInScope, viewerKind,
  } = deps;

  router.get('/board', async (req, res, next) => {
    try {
      const q = req.query;
      if (viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'The Progress board is for TeamLink staff.' });
      const per = Math.min(PER_COLUMN_MAX, Math.max(5, parseInt(q.perColumn, 10) || PER_COLUMN_DEFAULT));
      const att = hasPersonQuery(q) ? await attributedApplications(req.user, q) : null;
      const ctx = { search: String(q.search || '').trim().toLowerCase(), personIds: att ? att.ids : null };
      const quick = QUEUES[q.quick] ? q.quick : null;
      const built = await pipelineRowsFor(req.user);
      // The board shows steps, so the Status filter is not used here — Hold
      // and Rejected sit in their own tabs.
      const qq = { ...q, status: '' };
      const filtered = built.rows.filter((r) => pipelineRowMatches(r, qq, ctx) && (!quick || QUEUES[quick](r)));
      const byCol = new Map(BOARD_COLUMNS.map((c) => [c.key, []]));
      let hold = 0;
      let rejected = 0;
      // v3: a held card stays in the column of the step it was paused at.
      const heldRows = filtered.filter((r) => r.pipelineStatus === 'Hold');
      const heldFrom = heldRows.length ? await heldFromStages(heldRows.map((r) => r.id)) : new Map();
      let holdNowhere = 0;
      filtered.forEach((r) => {
        if (r.pipelineStatus === 'Hold') {
          hold += 1;
          const k0 = COLUMN_OF.get(heldFrom.get(r.id));
          if (k0 && k0 !== 'rejected') byCol.get(k0).push(r); else { byCol.get('sourced').push(r); holdNowhere += 1; }
          return;
        }
        if (r.pipelineStatus === 'Rejected') rejected += 1;
        const k = COLUMN_OF.get(r.currentStage);
        if (k) byCol.get(k).push(r);
      });
      const onlyCol = q.column ? columnByKey(String(q.column)) : null;
      const only = onlyCol ? onlyCol.key : null;
      const offset = only ? Math.max(0, parseInt(q.offset, 10) || 0) : 0;
      const picked = [];
      const slices = new Map();
      for (const col of BOARD_COLUMNS) {
        if (only && col.key !== only) continue;
        const list = sortForColumn(col.key, byCol.get(col.key));
        const slice = list.slice(offset, offset + per);
        slices.set(col.key, slice);
        picked.push(...slice.map((r) => r.id));
      }
      const moves = await lastMoves(picked);
      const now = Date.now();
      const columns = [];
      for (const col of BOARD_COLUMNS) {
        if (only && col.key !== only) continue;
        // eslint-disable-next-line no-await-in-loop
        const drops = await Promise.all(col.entry.map((s) => canMoveToStage(req.user, s)));
        const slice = slices.get(col.key);
        columns.push({
          key: col.key,
          label: col.label,
          side: !!col.side,
          count: byCol.get(col.key).length,
          held: byCol.get(col.key).filter((r) => r.pipelineStatus === 'Hold').length,
          canDrop: drops.some((x) => !x),
          cards: slice.map((r) => cardOf(r, moves.get(r.id), now, r.pipelineStatus === 'Hold' ? stageLabel(heldFrom.get(r.id) || '') || null : null)),
          offset,
          more: byCol.get(col.key).length > offset + slice.length,
        });
      }
      // v3: the requirement summary on top of a one-job board. Only for a job
      // this login actually has rows on (or a global login); client NAME only.
      let requirement = null;
      if (q.requirementId && !only) {
        const reqRows = built.rows.filter((r) => r.requirementId === q.requirementId);
        // eslint-disable-next-line global-require
        const st = reqRows.length > 0 || !!require('../utils/scope').atsScopeOf(req.user).global;
        if (st) {
          const rq = await prisma.requirement.findUnique({
            where: { id: String(q.requirementId) },
            select: {
              id: true, title: true, reqCode: true, department: true, openings: true, status: true, priority: true, location: true,
              salary: true, targetDate: true, closingDate: true, internal: true, client: { select: { name: true } },
            },
          });
          if (rq) {
            requirement = {
              id: rq.id,
              title: rq.title,
              reqCode: rq.reqCode || null,
              clientName: rq.internal ? 'TeamLink (internal)' : (rq.client && rq.client.name) || null,
              department: rq.department || null,
              openings: rq.openings || 0,
              filled: reqRows.filter((r) => ['JOINED', 'HIRED'].includes(r.currentStage)).length,
              inProcess: reqRows.filter((r) => ['Active', 'Hold'].includes(r.pipelineStatus)).length,
              status: rq.status,
              urgency: rq.priority || null,
              location: rq.location || null,
              budget: rq.salary || null,
              dueDate: rq.targetDate || rq.closingDate || null,
            };
          }
        }
      }
      return res.json({
        columns,
        perColumn: per,
        total: filtered.length - rejected,
        elsewhere: { hold, rejected, holdNowhere },
        requirement,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/board/move', async (req, res, next) => {
    try {
      const b = req.body || {};
      const col = columnByKey(String(b.column || ''));
      if (!col) return res.status(400).json({ error: 'Pick a step to move to.' });
      const app = await prisma.application.findUnique({
        where: { id: String(b.applicationId || '') },
        select: { id: true, stage: true, hiringType: true, interviewAt: true, requirement: { select: { internal: true, hiringType: true } }, candidate: { select: { name: true } } },
      });
      if (!app) return res.status(404).json({ error: 'That application was not found — refresh the board.' });
      const who = app.candidate ? app.candidate.name : 'This person';
      const internal = app.hiringType ? app.hiringType === 'TeamLink Internal Hire'
        : !!(app.requirement && (app.requirement.internal || app.requirement.hiringType === 'TeamLink Internal Hire'));
      let shownIn = COLUMN_OF.get(app.stage);
      if (app.stage === 'HOLD') shownIn = COLUMN_OF.get((await heldFromStages([app.id])).get(app.id)) || 'sourced';
      if (shownIn === col.key) {
        return res.status(409).json({
          error: app.stage === 'HOLD'
            ? `${who} is on hold at this step. Open the profile to take them off hold.`
            : `${who} is already in ${col.label}.`,
        });
      }
      // Selected holds the offer steps too: Joined comes after the offer.
      if (col.key === 'joined' && app.stage === 'SELECTED') {
        return res.status(409).json({ error: `Make the offer first: open ${who}'s profile and press "Prepare offer". Joined is then marked on the Joining checklist.` });
      }
      const stage = targetStageFor(col, app, internal);
      if (col.key === 'interview' && !b.interviewAt) {
        return res.status(409).json({ error: 'Pick the interview date and time first.', needsInterview: true });
      }
      // v3 popups: Reject (whose decision · reason · note), Joined (date ·
      // final CTC · commission %), the Verify checklist (in the comment).
      // The Reject popup is the same everywhere: whose decision + reason + a
      // note, all three needed (the default board comment must not count).
      if (col.key === 'rejected' && !String(b.reasonDetail || '').trim()) {
        return res.status(400).json({ error: 'Add a short note saying what happened.' });
      }
      const pass = {};
      ['rejectedBy', 'rejectKind', 'reasonCategory', 'reasonDetail', 'joiningDate', 'offeredCtc', 'feePercent', 'confirmSameClient', 'reviewOn']
        .forEach((k) => { if (b[k] !== undefined && b[k] !== null && b[k] !== '') pass[k] = b[k]; });
      // eslint-disable-next-line global-require
      const { applyStageMove } = require('./applications');
      const out = await applyStageMove(req.user, app.id, {
        stage,
        comment: String(b.comment || '').trim().slice(0, 2000) || 'Moved on the Progress board',
        ...(b.interviewAt ? { interviewAt: b.interviewAt } : {}),
        ...pass,
      });
      if (out.status !== 200) {
        const raw = (out.body && out.body.error) || 'That move was refused.';
        const plain = out.status === 403 && /permissions/.test(raw)
          ? `Your role can't move people to ${col.label}. Ask the person who owns that step.`
          : raw;
        return res.status(out.status).json({ ...(out.body || {}), error: plain });
      }
      return res.json({ ok: true, applicationId: app.id, stage, stageLabel: stageLabel(stage), column: col.key });
    } catch (err) {
      return next(err);
    }
  });

  // --- ATS layout v3: the Candidates cards ----------------------------------
  // GET /candidates/cards — Total · Unverified · Not followed up (7+ / 30+
  // days) · Available for matching, over the list's own filters and the
  // login's scope. The things the cards themselves set (step, status, quick
  // queue, contact age, available) are ignored, so a card never zeroes
  // itself after it is clicked.
  const SOURCED = BOARD_COLUMNS[0].stages;
  router.get('/cards', async (req, res, next) => {
    try {
      if (viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'These counts are for TeamLink staff.' });
      const q = req.query;
      const att = hasPersonQuery(q) ? await attributedApplications(req.user, q) : null;
      const ctx = { search: String(q.search || '').trim().toLowerCase(), personIds: att ? att.ids : null };
      const qq = {
        ...q, stage: '', status: '', contactAge: '', available: '', followUp: '',
      };
      const built = await pipelineRowsFor(req.user);
      const rows = built.rows.filter((r) => pipelineRowMatches(r, qq, ctx));
      const people = new Set(rows.map((r) => r.candidateId)).size;
      const unverified = rows.filter((r) => r.pipelineStatus === 'Active' && SOURCED.includes(r.currentStage)).length;
      let nf7 = 0;
      let nf30 = 0;
      rows.forEach((r) => {
        const d = deps.contactAgeDays(r);
        if (d != null && d >= 7) nf7 += 1;
        if (d != null && d >= 30) nf30 += 1;
      });
      let available = null;
      try {
        const all = await deps.pagedRowsFor(req.user);
        // eslint-disable-next-line no-unused-vars
        const { requirementId: _r, ...mq } = qq;
        const mqq = { ...mq, ...(q.requirementId ? { requirementId: q.requirementId } : {}) };
        available = all.filter((r) => r.profileStatus !== 'Archived' && deps.rowMatches(r, mqq, ctx) && deps.availableForMatching(r)).length;
      } catch (err) {
        available = null;
      }
      return res.json({
        people,
        applications: rows.length,
        unverified,
        notFollowed7: nf7,
        notFollowed30: nf30,
        available,
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- ATS layout v3: the Joined popup's starting values ---------------------
  // GET /candidates/board/joining-terms/:applicationId — joining date, final
  // CTC, and the client's agreed commission % for the logins that may see a
  // client's commercial terms (utils/joining.js mayHandleFee); others get
  // null and the agreement's fee is used.
  router.get('/board/joining-terms/:applicationId', async (req, res, next) => {
    try {
      // eslint-disable-next-line global-require
      const { applicationInScope, OUT_OF_SCOPE } = require('../utils/scope');
      // eslint-disable-next-line global-require
      const { mayHandleFee, isInternalHire } = require('../utils/joining');
      const app = await prisma.application.findUnique({
        where: { id: req.params.applicationId },
        include: { candidate: { select: { name: true, currentSalary: true, expectedSalary: true } }, requirement: { include: { client: { select: { name: true, agreementFeePercent: true } } } } },
      });
      if (!app) return res.status(404).json({ error: 'That application was not found.' });
      if (!applicationInScope(req.user, app)) return res.status(403).json(OUT_OF_SCOPE);
      const internal = isInternalHire(app, app.requirement);
      const fee = !internal && mayHandleFee(req.user);
      return res.json({
        applicationId: app.id,
        name: app.candidate ? app.candidate.name : '',
        stage: app.stage,
        joiningStatus: app.joiningStatus || null,
        internal,
        joiningDate: app.joiningDate || null,
        offeredCtc: app.offeredCtc || null,
        expectedSalary: app.candidate ? app.candidate.expectedSalary || null : null,
        clientName: internal ? 'TeamLink (internal)' : (app.requirement && app.requirement.client && app.requirement.client.name) || null,
        canSetFee: fee,
        feePercent: fee && app.requirement && app.requirement.client ? (app.requirement.client.agreementFeePercent ?? 8.33) : null,
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- ATS layout v3: BDE Review → "Send back" (reason) ----------------------
  // POST /candidates/applications/:applicationId/bde-return { reason }
  // The BDE sends a profile back to the TL check. Only from BDE Review; the
  // ordinary stage move does the rest (scope, permission, event, audit,
  // notices). A second audit row carries the reason.
  const BDE_RETURN_ROLES = ['BDE', 'TL', 'STL'];
  router.post('/applications/:applicationId/bde-return', async (req, res, next) => {
    try {
      // eslint-disable-next-line global-require
      const { stageGlobal } = require('../utils/permissions');
      const role = atsRole(req.user);
      if (!stageGlobal(req.user) && !BDE_RETURN_ROLES.includes(role)) {
        return res.status(403).json({ error: 'Only the client manager (BDE), the TL or an admin can send a profile back from BDE Review.' });
      }
      const reason = String((req.body && req.body.reason) || '').trim();
      if (reason.length < 3) return res.status(400).json({ error: 'Say why the profile is going back.' });
      // eslint-disable-next-line global-require
      const { applyStageMove } = require('./applications');
      const out = await applyStageMove(req.user, req.params.applicationId, {
        stage: 'TL_REVIEW',
        comment: `Sent back by BDE — ${reason.slice(0, 500)}`,
        reasonCategory: 'Sent back by BDE',
        reasonDetail: reason.slice(0, 1000),
      }, { sendBackFrom: ['WITH_BDE', 'BDE_APPROVED'] });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      await logAudit({
        userId: req.user.id,
        action: 'Profile sent back to TL by BDE',
        entity: 'Application',
        entityId: req.params.applicationId,
        fromValue: 'WITH_BDE',
        toValue: 'TL_REVIEW',
        reason: reason.slice(0, 1000),
      });
      return res.json({ ok: true, stage: 'TL_REVIEW', stageLabel: stageLabel('TL_REVIEW') });
    } catch (err) {
      return next(err);
    }
  });

  // --- Archive / bring back -------------------------------------------------
  async function setArchived(req, res, archive) {
    if (!mayArchive(req.user)) return res.status(403).json({ error: 'Only a Team lead, Admin or Super Admin can archive people.' });
    const loaded = await loadInScope(req, res);
    if (!loaded) return undefined;
    const c = loaded.candidate;
    if (c.profileStatus === 'Do Not Use') return res.status(409).json({ error: `${c.name} is marked "Do not use". That flag stays; it is handled under Rejected.` });
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    if (archive && !reason) return res.status(400).json({ error: 'Say why you are archiving this person.' });
    const was = c.profileStatus || 'Active';
    const to = archive ? 'Archived' : 'Active';
    if (was === to) return res.json({ ok: true, profileStatus: to, unchanged: true });
    await prisma.candidate.update({ where: { id: c.id }, data: { profileStatus: to } });
    markCandidateDirty(c.id);
    await logAudit({
      userId: req.user.id,
      action: archive ? 'Candidate archived' : 'Candidate brought back from archive',
      entity: 'Candidate',
      entityId: c.id,
      fromValue: was,
      toValue: to,
      reason: reason || undefined,
    });
    return res.json({ ok: true, profileStatus: to });
  }
  router.post('/:id/archive', (req, res, next) => setArchived(req, res, true).catch(next));
  router.post('/:id/unarchive', (req, res, next) => setArchived(req, res, false).catch(next));

  // --- Real delete: Super Admin, duplicate / wrong entry only -----------------
  router.delete('/:id', async (req, res, next) => {
    try {
      if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin can delete a person. Use Archive instead.' });
      const b = req.body || {};
      const reason = String(b.reason || '');
      if (!['Duplicate', 'Wrong entry'].includes(reason)) {
        return res.status(400).json({ error: 'Delete is only for a duplicate or a wrong entry. For anyone else, use Archive.' });
      }
      const c = await prisma.candidate.findUnique({
        where: { id: req.params.id },
        include: { applications: { select: { id: true, stage: true, interviewAt: true, offerStatus: true, joinedAt: true } } },
      });
      if (!c) return res.status(404).json({ error: 'Candidate not found' });
      if (String(b.confirmName || '').trim().toLowerCase() !== String(c.name || '').trim().toLowerCase()) {
        return res.status(400).json({ error: `Type the name exactly ("${c.name}") to confirm.` });
      }
      const worked = c.applications.filter((a) => a.stage !== 'NEW' || a.interviewAt || a.offerStatus || a.joinedAt);
      const [invoices, logins, requests] = await Promise.all([
        prisma.invoice.count({ where: { candidateId: c.id } }),
        prisma.user.count({ where: { candidateId: c.id } }),
        prisma.portalRequest.count({ where: { candidateId: c.id } }).catch(() => 0),
      ]);
      const blockers = [
        worked.length && `${worked.length} application(s) already moved past New`,
        invoices && `${invoices} invoice(s)`,
        logins && 'a portal login',
        requests && `${requests} portal request(s)`,
      ].filter(Boolean);
      if (blockers.length) {
        return res.status(409).json({
          error: `${c.name} has real work on file (${blockers.join(', ')}), so it can't be deleted. ${reason === 'Duplicate' ? 'Merge the duplicate under People → Duplicates, or archive it.' : 'Archive it instead.'}`,
        });
      }
      const appIds = c.applications.map((a) => a.id);
      try {
        await prisma.$transaction([
          prisma.application.deleteMany({ where: { id: { in: appIds } } }),
          prisma.candidate.delete({ where: { id: c.id } }),
        ]);
      } catch (err) {
        return res.status(409).json({ error: `${c.name} still has linked records, so it can't be deleted. Archive it instead.` });
      }
      await logAudit({
        userId: req.user.id,
        action: 'Candidate deleted',
        entity: 'Candidate',
        entityId: c.id,
        fromValue: JSON.stringify({ name: c.name, phone: c.phone, email: c.email, applications: appIds.length }),
        toValue: 'Deleted',
        reason: [reason, String(b.note || '').slice(0, 300)].filter(Boolean).join(' — '),
      });
      return res.json({ ok: true, deleted: c.id, name: c.name });
    } catch (err) {
      return next(err);
    }
  });
};
module.exports.BOARD_COLUMNS = BOARD_COLUMNS;
