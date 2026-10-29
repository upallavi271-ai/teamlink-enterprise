const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const joinDayShared = require('../utils/joinDayShared');
const JL = require('../utils/joinDayList'); // the joining day in the lists (feeds joinDayShared from the rows already loaded)
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const {
  requirementWhere, matches, atsScopeOf: scopeOf, atsScopeCached, OUT_OF_SCOPE, CLIENT_SHARED_STAGES, applicationInScope,
} = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { computeMatch } = require('../utils/matching');
const {
  applicationOwner, applicationWaitingOn, followUpNeed, applicationNextAction,
  applicationDueDate, applicationIsOverdue,
  applicationLifeStatus, stageLabel, interviewStatusLabel, REQUIREMENT_LIVE_STATUSES,
  REJECTED_BY_LABEL,
} = require('../utils/atsVocab');
const {
  CANDIDATE_VIEWS, groupIdOfStage, groupLabelOfStage, stageDetail,
  stageIndex, matchesView, groupsWithDetail,
} = require('../utils/pipelineView');
const {
  TEMPLATES, commsNote, senderIdentity, NOT_SENT, NOT_SENT_DETAIL,
} = require('../utils/candidateComms');
// followup_: the follow-up record is an APPLICATION's, never a candidate's.
// Nothing here writes one; the list and the detail page only READ the current
// one so the Follow-up column and the Applications tab can show it.
const { currentFollowUpsByApplication, CALL_RESULTS } = require('../utils/followups');
// C1 (2026-10-03): Last contact + the Not followed up / Due today / Followed up badge.
const FV = require('../utils/followupVisibility');
const SALARY = require('../utils/salaryFit'); // salary: required on create, the Salary fit %, one helper
const FB = require('../utils/fitBreakdown'); // the Fit breakdown (Resume · AI · Location · Salary) + who sees how much
const PT = require('../utils/pipelineTally'); // one definition of every Candidates & Pipeline count
const { hasPersonQuery, attributedApplications } = require('../utils/workers');
// The paged list's in-memory working set (kept current by deltas).
const { getListState, markCandidateDirty } = require('../utils/candidateListCache');
const ADDED = require('../utils/candidateAddedBy'); // who typed / uploaded each person: that login keeps seeing them before any requirement
// THE ACTUAL WORKFLOW (2026-09-29): an internal opening's stages read HR Review /
// Dept Head / TL, and its next action is the internal chain's.
const { stageLabelFor, nextActionForStage: wfNextAction } = require('../utils/atsVocab');
const isInternalApp = (a, r) => (a && a.hiringType
  ? a.hiringType === 'TeamLink Internal Hire'
  : !!(r && (r.internal || r.hiringType === 'TeamLink Internal Hire')));
const { STAGE_OWNER_ACTION } = require('../utils/atsVocab');
const { todayStr } = require('../utils/followups');
// One Candidate Master (spec #2 §12): duplicate keys, groups and the merge.
const {
  phoneKeys, emailKey, nameKey, matchEntry, computeGroups, previewMerge, mergeCandidates, MergeError,
  appRank,
} = require('../utils/candidateDedupe');
const { roleForProduct } = require('../utils/permissions');
// user notes #6 — city-level location matching (utils/locationMatch.js)
const { candidateCities, valuesInCities } = require('../utils/locationMatch');
const { can } = require('../middleware/auth');
// ONE next action per application (due date, owner, queues) — shared with the
// dashboard / bell / Recruiter & BDE (utils/nextAction.js).
const {
  ensureNextActionContext, nextActionFor, needsActionBy, isNewUnreviewed, isClientFeedbackPending, feedbackWait, todayIst,
} = require('../utils/nextAction');
const { isPreAtsApplication } = require('../utils/atsVocab');
// WHERE DID THEY COME FROM: one clean source list + the function that maps any stored word onto it
// (utils/candidateSource.js). Computed ONCE per decorated row, never per request.
const CS = require('../utils/candidateSource');
// WHEN DID THEY COME: one date + one trust word per person (utils/cameOn.js), used by the list, the Sources tab, the exports and the profile.
const CAME = require('../utils/cameOn');
const clientSearch = require('../utils/clientSearch'); // old client names are searchable (ClientAlias)

const router = express.Router();
router.use(requireAuth);
router.use(require('../utils/applicationOwner').warmMiddleware); // eslint-disable-line global-require
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'candidates', 'Candidate List', 'view'));

// ---------------------------------------------------------------------------
// VIEW ≠ EDIT, and INTERNAL ≠ SHARED.
//
// Two different things are enforced here and they are kept apart deliberately:
//
//   * SCOPE — WHICH candidate records a login reaches at all. That is
//     utils/scope.js: a recruiter their own, a TL their department's, a BDE
//     their clients', a client only people shared with that client, a
//     candidate only themselves. Enforced below on both the list and the
//     record, server-side. A hidden button is not access control.
//
//   * FIELD VISIBILITY — WHAT of a record a login is served. A client reaching
//     a candidate legitimately (they were shared) must still never receive
//     internal recruiter notes, the internal AI evaluation detail, or any
//     fee / salary internals. That is redactFor() below, and it runs on the
//     way out of every endpoint in this file — the field is absent from the
//     JSON, not merely hidden by the browser.
// ---------------------------------------------------------------------------
function viewerKind(user) {
  const s = scopeOf(user);
  if (s.role === 'CANDIDATE') return 'candidate';
  if (s.role === 'CLIENT') return 'client';
  return 'internal';
}
const isInternalViewer = (user) => viewerKind(user) === 'internal';

// Salary / fee internals. A client is paying a percentage of the candidate's
// CTC; what the candidate currently earns and what they asked for is our
// commercial position, not theirs.
const SALARY_FIELDS = ['currentSalary', 'expectedSalary'];
// Internal scoring. A client sees the person, not our machine's opinion of them.
const SCORE_FIELDS = ['resumeScore'];
const APPLICATION_SCORE_FIELDS = ['matchScore', 'resumeScore', 'aiInterviewScore', 'aiInterviewFeedback', 'offeredCtc'];

function redactCandidateFields(candidate, kind) {
  if (kind !== 'client') return candidate;
  const out = { ...candidate };
  [...SALARY_FIELDS, ...SCORE_FIELDS].forEach((f) => { delete out[f]; });
  return out;
}

function redactApplication(application, kind) {
  if (kind !== 'client') return application;
  const out = { ...application };
  APPLICATION_SCORE_FIELDS.forEach((f) => { delete out[f]; });
  return out;
}

// A candidate is reachable only through an application on a requirement the
// signed-in user's scope already covers — so a Medical recruiter never sees an
// IT candidate, and one client never sees another client's shortlist. Computed
// once here from utils/scope.js and applied to both the list and the record.
//
// `sharedIds` is the second gate, and it applies only to a CLIENT login:
// reaching the client's requirement is not enough, the profile must actually
// have been SHARED with them (utils/scope.js CLIENT_SHARED_STAGES). Without
// it a client would see everyone a recruiter was still screening for their
// role. `null` means the gate does not apply to this viewer.
function visibleApplications(user, applications, sharedIds = null) {
  const s = atsScopeCached(user); // once per login, not once per candidate (Batch 1 perf)
  if (s.global) return applications;
  // A candidate sees only their OWN applications — never another candidate's,
  // even on a record they somehow reached.
  if (s.role === 'CANDIDATE') {
    return (applications || []).filter((a) => a.candidateId === s.candidateId);
  }
  // applicationInScope(), not a requirement match: under the seat structure
  // one requirement can carry two teams' candidates (utils/scope.js).
  const inScope = (applications || []).filter((a) => a.requirement && applicationInScope(user, a));
  if (!sharedIds) return inScope;
  return inScope.filter((a) => sharedIds.has(a.id));
}

// Which of these applications a CLIENT login has actually been shown. An
// application counts as shared if it is at a shared stage now, OR if it ever
// reached one (Pipeline History) — so a candidate the client themselves
// rejected stays visible to them, while one rejected internally before ever
// being shared never becomes visible.
async function clientSharedApplicationIds(user, candidates) {
  if (viewerKind(user) !== 'client') return null;
  const apps = candidates.flatMap((c) => c.applications || []);
  const shared = new Set(apps.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage)).map((a) => a.id));
  const ids = apps.map((a) => a.id);
  if (ids.length) {
    const events = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids }, toStage: { in: CLIENT_SHARED_STAGES } },
      select: { applicationId: true },
    });
    events.forEach((e) => shared.add(e.applicationId));
  }
  return shared;
}

// Candidates already on file with the same email or phone. Mirrors the
// prototype's checkCandidateDuplicate() — used both by the Add Candidate form
// (to warn while typing) and by POST / below (to block a silent double-entry).
//
// spec #2 §12 — NORMALISED, not literal: the phone's last ten digits, the
// email lower-cased (utils/candidateDedupe.js), and the name only as a
// supporting / "possible" hint. Checked against EVERY candidate, not only the
// ones this login can see — otherwise a Medical recruiter would happily
// create a second record for someone Education already has. What is shown
// about a match outside this login's scope is only its name, the masked
// contact that matched and how many applications it has elsewhere.
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? `${'x'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : null; };
const maskEmail = (e) => { const k = emailKey(e); if (!k) return null; const [u, dom] = k.split('@'); return `${u.slice(0, 2)}***@${dom}`; };

async function duplicateMatches(user, { email, phone, name, excludeId }) {
  const pk = phoneKeys(phone);
  const ek = emailKey(email);
  if (!pk.length && !ek && !String(name || '').trim()) return [];
  const st = await getListState();
  // Fresh rows straight from the table as well, so a phone edited a second
  // ago elsewhere is still caught before the working set notices.
  const or = [...pk.map((k) => ({ phone: { contains: k } })), ...(ek ? [{ email: { contains: ek } }] : [])];
  const extra = or.length
    ? await prisma.candidate.findMany({ where: { OR: or }, select: { id: true, name: true, email: true, phone: true }, take: 50 })
    : [];
  const hits = matchEntry({ email, phone, name, excludeId }, st.candidates, st.version, extra);
  if (!hits.length) return [];
  const rows = await prisma.candidate.findMany({
    where: { id: { in: hits.slice(0, 20).map((h) => h.id) } },
    include: {
      applications: {
        include: {
          requirement: {
            include: {
              client: { select: { id: true, name: true } },
              recruiter: { select: { id: true, name: true } },
              bde: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const s = scopeOf(user);
  return hits.filter((h) => byId.has(h.id)).map((h) => {
    const c = byId.get(h.id);
    const visible = s.global ? c.applications : visibleApplications(user, c.applications);
    const inScope = s.global || visible.length > 0;
    return {
      id: c.id,
      name: c.name,
      reasons: h.reasons,
      strength: h.strength,
      inScope,
      phone: inScope ? c.phone : maskPhone(c.phone),
      email: inScope ? c.email : maskEmail(c.email),
      location: inScope ? c.location || null : null,
      source: inScope ? c.source || null : null,
      createdAt: c.createdAt,
      applicationCount: c.applications.length,
      otherTeamApplications: c.applications.length - visible.length,
      // cand7_ (§7 Add candidate): WHO already has this person — the recruiter
      // (or TL) and department of their most recent application.
      heldBy: (() => {
        const last = [...c.applications].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        const r = last && last.requirement;
        if (!r) return null;
        const who = (r.recruiter && r.recruiter.name) || r.tl || null;
        return who || r.department ? { name: who, department: r.department || null } : null;
      })(),
      archived: c.profileStatus === 'Archived',
      applications: visible
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((a) => ({
          id: a.id,
          requirementId: a.requirementId,
          requirementTitle: a.requirement ? a.requirement.title : null,
          clientName: a.requirement ? (a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || null) : null,
          stage: a.stage,
          stageLabel: stageLabel(a.stage),
          createdAt: a.createdAt,
        })),
    };
  });
}

// The candidate list shows, per candidate, the state of their most recent
// application. The visible columns are Candidate | Requirement | Client |
// Stage | Owner | Next Action | Due | Status — Owner is a first-class column,
// not something buried on the detail page. Owner / Next Action / Due are
// derived from the stage so they can never drift.
function decorate(candidate, { user, sharedIds = null, followUps = null, withAppSource = false } = {}) {
  const kind = user ? viewerKind(user) : 'internal';
  const applications = user
    ? visibleApplications(user, candidate.applications, sharedIds)
    : (candidate.applications || []);
  const base = redactCandidateFields(candidate, kind);

  // candidateStageOf(): the most recent application decides the current stage.
  const latest = [...applications].sort((a, b) => String(b.id).localeCompare(String(a.id)))[0] || null;
  // The source, through the clean list (TeamLink logins only: where a person was found is our own
  // sourcing detail, not shown to a client or to the candidate). `source` stays the stored word.
  const sp = kind === 'internal' ? CS.sourceOfPerson(candidate, latest) : null;
  const srcFields = sp ? { sourceKey: sp.key, sourceRaw: sp.raw } : { sourceKey: null, sourceRaw: null };
  const shaped = applications.map((a) => {
    const out = redactApplication(a, kind);
    if (!withAppSource || kind !== 'internal') return out;
    const ap = CS.sourceOfApplication(a, candidate);
    return { ...out, sourceKey: ap.key, sourceRaw: ap.raw };
  });
  if (!latest) {
    return {
      ...base,
      ...srcFields,
      applications: shaped,
      currentStage: null,
      currentStageLabel: 'No application',
      stageGroup: null,
      stageGroupLabel: '—',
      stageDetailLabel: null,
      requirementTitle: null,
      requirementId: null,
      clientName: null,
      clientId: null,
      followUp: null,
    };
  }
  const requirement = latest.requirement || null;
  const client = requirement ? requirement.client : null;
  return {
    ...base,
    ...srcFields,
    applications: shaped,
    currentStage: latest.stage,
    currentStageLabel: stageLabelFor(latest.stage, { internal: isInternalApp(latest, requirement) }),
    // The VISIBLE stage — one of the ten groups. The precise status inside it
    // travels alongside as stageDetailLabel; nothing is lost, it is folded.
    stageGroup: groupIdOfStage(latest.stage),
    stageGroupLabel: groupLabelOfStage(latest.stage),
    stageDetailLabel: stageDetail(latest),
    requirementId: latest.requirementId,
    requirementTitle: requirement ? requirement.title : null,
    requirementDepartment: requirement ? requirement.department : null,
    clientId: requirement ? requirement.clientId : null,
    clientName: requirement ? (requirement.internal ? 'TeamLink Internal' : (client && client.name) || null) : null,
    // WHO WORKED THIS APPLICATION: the recruiter, seat and TL recorded on its
    // own follow-up first (a requirement can pass between recruiters, and a
    // recruiter who has left has no login to put on the requirement), then
    // whatever the requirement names today.
    recruiterName: (kind === 'internal' && followUps && followUps.get(latest.id)?.ownerName)
      || latest.ownerRecruiterName
      || (requirement && requirement.recruiter ? requirement.recruiter.name : null),
    positionCode: (kind === 'internal' && followUps && followUps.get(latest.id)?.ownerPositionCode)
      || (requirement ? requirement.positionCode || null : null),
    bdeName: requirement && requirement.bde ? requirement.bde.name : null,
    tlName: (kind === 'internal' && followUps && followUps.get(latest.id)?.tlName)
      || (requirement ? requirement.tl || null : null),
    appliedDate: latest.createdAt,
    owner: applicationOwner(latest, requirement),
    waitingOn: applicationWaitingOn(latest, requirement),
    followUpNeed: followUpNeed(latest),
    nextAction: nextActionFor(latest).action,
    dueDate: applicationDueDate(latest),
    overdue: applicationIsOverdue(latest),
    ...(kind === 'client' ? {} : { matchScore: latest.matchScore ?? latest.resumeScore ?? null }),
    lifeStatus: applicationLifeStatus(latest),
    latestApplicationId: latest.id,
    aiInterviewStatus: latest.aiInterviewStatus || 'Required',
    latestApplicationId: latest.id,
    // --- followup_: the Follow-up column ------------------------------------
    // The REAL follow-up on the candidate's most recent application, or null
    // where none has been recorded yet. It is not derived from the stage SLA —
    // that is the separate `dueDate` / `overdue` pair above, which is the
    // pipeline's own clock. This one is what a person committed to.
    //
    // A CLIENT or CANDIDATE login is served none of it: who inside TeamLink
    // owes which call is our own operations, not theirs.
    followUp: kind === 'internal' ? ((followUps && followUps.get(latest.id)) || null) : null,
  };
}

// Every candidate this login may reach, already scoped. Shared by the list and
// by source analytics so the two can never disagree.
// `onlyIds` narrows the load to those candidates (a person filter already
// knows whose applications it wants); the visibility rules are unchanged.
async function scopedCandidates(user, onlyIds = null) {
  // THE NESTED OBJECTS ARE NARROWED, not pulled whole.
  //
  // `client: true` fetched all forty-odd columns of a Client — GST, PAN,
  // payment terms, agreement text, risk notes — once per APPLICATION, 22,873
  // times, and the same for the recruiter and BDE user rows. Nothing that
  // reads this needs more than a name and an id from any of the three.
  //
  // The requirement itself stays whole: decorate(), the pipeline vocabulary
  // and the client-sharing rules read a dozen of its fields between them, and
  // narrowing it would be a much easier thing to get quietly wrong.
  const all = await prisma.candidate.findMany({
    ...(onlyIds ? { where: { id: { in: onlyIds } } } : {}),
    include: {
      applications: {
        include: {
          requirement: {
            include: {
              client: { select: { id: true, name: true } },
              recruiter: { select: { id: true, name: true } },
              bde: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  const sharedIds = await clientSharedApplicationIds(user, all);
  const s = scopeOf(user);
  if (s.global) return { candidates: all, sharedIds };
  if (s.role === 'CANDIDATE') {
    return { candidates: all.filter((c) => c.id === s.candidateId), sharedIds };
  }
  return {
    candidates: all.filter((c) => visibleApplications(user, c.applications, sharedIds).length > 0),
    sharedIds,
  };
}

// WHY WAS THIS CANDIDATE REJECTED, AND BY WHOM.
//
// The list said "Rejected" and nothing else, which is the one word that
// answers none of the questions a recruiter opening it has. This reads the
// latest rejection record for each rejected row — one query for all of them
// — and attaches side, reason and who recorded it.
//
// IMPORTED REJECTIONS carry the placeholder reason "Rejected" where the
// source sheet's status said only that. The sheet's own notes (Status-1 /
// Status-2 …) are usually the real explanation, so they are shown as the
// detail instead of repeating the word the column already says.
//
// Internal logins only. A rejection's reasoning is TeamLink's working record
// and is never shown to a client.
async function attachRejections(rows) {
  const ids = rows.filter((r) => r.currentStage === 'REJECTED' && r.latestApplicationId).map((r) => r.latestApplicationId);
  if (!ids.length) return;
  const [events, apps] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids }, toStage: 'REJECTED' },
      orderBy: { createdAt: 'desc' },
      select: {
        applicationId: true, actorSide: true, actorName: true, actorRole: true,
        reasonCategory: true, reasonDetail: true, comment: true, fromStage: true, createdAt: true,
      },
    }),
    prisma.application.findMany({
      where: { id: { in: ids } },
      select: { id: true, interviewFeedback: true },
    }),
  ]);
  const latest = new Map();
  events.forEach((e) => { if (!latest.has(e.applicationId)) latest.set(e.applicationId, e); });
  const notes = new Map(apps.map((a) => [a.id, a.interviewFeedback]));
  rows.forEach((r) => {
    if (r.currentStage !== 'REJECTED') return;
    const e = latest.get(r.latestApplicationId);
    if (!e) { r.rejection = { side: null, sideLabel: 'Not recorded', reason: null, detail: null }; return; }
    const placeholder = !e.reasonCategory && (!e.reasonDetail || e.reasonDetail === 'Rejected');
    const sheetNotes = notes.get(r.latestApplicationId);
    r.rejection = {
      side: e.actorSide || null,
      sideLabel: e.actorSide ? (REJECTED_BY_LABEL[e.actorSide] || e.actorSide) : 'Not recorded',
      reason: e.reasonCategory || (placeholder ? null : e.reasonDetail) || null,
      detail: (e.reasonCategory ? e.reasonDetail : null)
        || (placeholder && sheetNotes ? String(sheetNotes).slice(0, 400) : null)
        || e.comment || null,
      by: e.actorName || null,
      fromStage: e.fromStage ? stageLabel(e.fromStage) : null,
      at: e.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// THE PAGED LIST — GET /candidates?paged=1  (spec §13, §22-§28)
//
// The Candidates & Pipeline screen asks for ONE page at a time. Filtering,
// the views, the quick views, the counts and the sort all run HERE, over the
// same scoped, decorated rows the plain list returns — so a page of 25 costs
// a page of 25, not 30 MB. Without ?paged=1 GET / is unchanged (other screens
// and the export read the plain array).
//
//   view      pipeline (default) — candidates whose current application is
//             Active; master — everyone this login may see, INCLUDING people
//             with no application; hold | rejected | joined — those statuses.
//             (Legacy: all -> master, active -> pipeline, selected.)
//   quick     my_pending | overdue | due_today | new | client_feedback |
//             my_candidates | today_interviews  (spec §26)
//   filters   search, department, clientId, requirementId, recruiter, tl, bde,
//             positionCode, location, source, stage (group:x | stage:A,B),
//             status (Active|Hold|Rejected|Joined|None), followUp, appliedFrom,
//             appliedTo
//   sort      applied | followUp | stage | due | interview | name, dir asc|desc
//   page, pageSize (25 | 50 | 100)
//   idsOnly=1 every matching { id, latestApplicationId } (select-all), capped
//   all=1     every matching row as a plain array (the export)
// ---------------------------------------------------------------------------
const PAGE_SIZES = [25, 50, 100];
const ID_CAP = 5000;
const LIVE_STATUSES = ['Active', 'Hold'];
const IST_OFFSET_MS = 330 * 60000;
const { istDay } = require('../utils/nextAction'); // same IST day, with the day names kept (Batch 1 perf)

// STATUS, kept apart from STAGE (spec §11): where the candidate stands as an
// outcome, not where they sit in the workflow.
function pipelineStatusOf(stage) {
  if (!stage) return null;
  if (stage === 'REJECTED') return 'Rejected';
  if (stage === 'HOLD') return 'Hold';
  if (['JOINED', 'HIRED'].includes(stage)) return 'Joined';
  return 'Active';
}

// WHOSE MOVE IT IS — as a user id, so "My Pending" can be answered. The open
// follow-up's owner first (that is who was actually handed it), otherwise the
// person the stage's owner role names on the requirement (atsVocab
// STAGE_OWNER_ACTION — the same table the Owner column reads).
function ownerUserIdOf(app, followUp) {
  if (followUp && !followUp.completedAt && followUp.ownerUserId) return followUp.ownerUserId;
  const r = app && app.requirement;
  if (!r) return null;
  const role = (STAGE_OWNER_ACTION[app.stage] || {}).ownerRole;
  if (role === 'Recruiter') return r.recruiterId || null;
  if (role === 'BDE' || role === 'Client') return r.bdeId || r.recruiterId || null;
  if (role === 'TL') return r.tlId || null;
  return null;
}

// ---------------------------------------------------------------------------
// CANDIDATES & PIPELINE — THREE VIEWS (user spec 2026-09-29).
//
//   view=pipeline  ATS Pipeline: one row per APPLICATION (candidate +
//                  requirement) that is IN the ATS — a Job Portal application
//                  appears here only after Send to ATS.
//                  sub = all | active (default) | hold | selected | joined
//   view=master    Candidate Master: one row per PERSON.
//                  sub = all (default) | duplicates | inactive
//   (the Job Portal view is routes/jobPortal.js GET /applications)
//
// Legacy ?view= ids keep working: any/all -> pipeline/all, active -> active,
// hold / selected / joined -> that sub-tab, rejected -> all + Rejected.
// ---------------------------------------------------------------------------
const candidateCode = (id) => `CAN-${String(id || '').slice(-8).toUpperCase()}`;
const PIPELINE_SUBS = ['all', 'active', 'hold', 'selected', 'joined', 'rejected'];
const MASTER_SUBS = ['all', 'duplicates', 'inactive', 'archived'];
function normaliseViewSub(view, sub) {
  const v = String(view || '').toLowerCase();
  const s = String(sub || '').toLowerCase();
  if (v === 'master') return { view: 'master', sub: MASTER_SUBS.includes(s) ? s : 'all' };
  const legacy = {
    any: 'all', all: 'all', active: 'active', hold: 'hold', selected: 'selected', joined: 'joined', rejected: 'rejected',
  };
  if (legacy[v]) return { view: 'pipeline', sub: legacy[v] };
  return { view: 'pipeline', sub: PIPELINE_SUBS.includes(s) ? s : 'active' };
}
function inPipelineSub(sub, r) {
  switch (sub) {
    case 'all': return true;
    case 'hold': return r.pipelineStatus === 'Hold';
    case 'rejected': return r.pipelineStatus === 'Rejected';
    case 'joined': return r.pipelineStatus === 'Joined';
    case 'selected': return ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(r.currentStage);
    default: return r.pipelineStatus === 'Active';
  }
}

// THE QUEUES (spec §5-§7) — every definition is utils/nextAction.js's, so the
// dashboard / bell / Recruiter & BDE read the same numbers. Counted over every
// sub-tab (a queue is about live work wherever it sits); picking one shows all
// its rows. Ids kept for old links (?quick=my_pending …).
const QUEUES = {
  my_pending: (r) => r.needsAction, // "Needs Action"
  overdue: (r) => r.dueStatus === 'overdue',
  due_today: (r) => r.dueStatus === 'due_today',
  new: (r) => r.isNew, // "New / Unreviewed"
  client_feedback: (r) => r.clientFeedbackPending,
  my_candidates: (r) => r.mine,
  today_interviews: (r) => r.interviewToday,
};

// The Stage dropdown (spec §2), exactly these, in this order. `internal` is
// the internal chain's word for the same step (shown when Internal is picked).
const PIPE_STAGES = [
  { key: 'recruiter_review', label: 'Recruiter Review', internal: 'HR Review' },
  { key: 'tl_review', label: 'TL Review', internal: 'Dept Head / TL Review' },
  { key: 'bde_review', label: 'BDE Review' },
  { key: 'client_submitted', label: 'Client Submitted' },
  { key: 'client_shortlisted', label: 'Client Shortlisted' },
  { key: 'interview_scheduled', label: 'Interview Scheduled', internal: 'Interview Scheduled' },
  { key: 'interview_completed', label: 'Interview Completed', internal: 'Interview Completed' },
  { key: 'feedback_pending', label: 'Feedback Pending', internal: 'Feedback Pending' },
  { key: 'selected', label: 'Selected', internal: 'Selected' },
  { key: 'offer', label: 'Offer', internal: 'Offer' },
  { key: 'joined', label: 'Joined', internal: 'Joining' },
  { key: 'hrms', label: null, internal: 'HRMS Employee Created' },
  { key: 'hold', label: 'Hold', internal: 'Hold' },
  { key: 'rejected', label: 'Rejected', internal: 'Rejected' },
];
const REVIEW_CODES = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];
function feedbackRecorded(a, snap) {
  return (snap && snap.clientFeedback.has(a.id)) || !!a.interviewResult || a.interviewStatus === 'FEEDBACK_SUBMITTED';
}
function stageKeyOf(a, internal, snap) {
  const s = a.stage;
  if (REVIEW_CODES.includes(s)) return 'recruiter_review';
  if (s === 'TL_REVIEW') return 'tl_review';
  if (s === 'WITH_BDE' || s === 'BDE_APPROVED') return 'bde_review';
  if (s === 'SHARED_WITH_CLIENT' || s === 'CLIENT_REVIEW') return 'client_submitted';
  if (s === 'CLIENT_SHORTLISTED') return 'client_shortlisted';
  if (s === 'INTERVIEW_SCHEDULED') {
    if (['COMPLETED', 'PENDING_FEEDBACK'].includes(a.interviewStatus)) return 'feedback_pending';
    if (a.interviewStatus === 'FEEDBACK_SUBMITTED') return 'interview_completed';
    return 'interview_scheduled';
  }
  if (s === 'INTERVIEW_COMPLETED') return feedbackRecorded(a, snap) ? 'interview_completed' : 'feedback_pending';
  if (s === 'SELECTED') return 'selected';
  if (s === 'OFFER' || s === 'OFFER_ACCEPTED') return 'offer';
  if (s === 'JOINED') return 'joined';
  if (s === 'HIRED') return internal ? 'hrms' : 'joined';
  if (s === 'HOLD') return 'hold';
  if (s === 'REJECTED') return 'rejected';
  return null;
}
// Role-relevant stages first; the rest are offered under "Other stages" only
// while they hold rows (the review #3 §6 rule, kept).
const STAGE_ROLE_KEYS = {
  recruiter: ['recruiter_review', 'tl_review', 'selected', 'offer', 'joined', 'hold', 'rejected'],
  tl: ['recruiter_review', 'tl_review', 'bde_review', 'client_submitted', 'hold', 'rejected'],
  bde: ['bde_review', 'client_submitted', 'client_shortlisted', 'interview_scheduled', 'interview_completed', 'feedback_pending', 'selected', 'offer', 'joined', 'hold', 'rejected'],
  hr: ['recruiter_review', 'tl_review', 'interview_scheduled', 'interview_completed', 'feedback_pending', 'selected', 'offer', 'joined', 'hrms', 'hold', 'rejected'],
};
function stageRoleOf(user) {
  const s = scopeOf(user);
  if (s.global) return 'all';
  return { RECRUITER: 'recruiter', TL: 'tl', BDE: 'bde', HR: 'hr' }[s.atsRole] || 'all';
}

function stageSortKey(r) {
  if (!r.currentStage) return 999;
  if (r.currentStage === 'HOLD') return 900;
  if (r.currentStage === 'REJECTED') return 950;
  const i = stageIndex(r.currentStage);
  return i < 0 ? 800 : i;
}
// A date typed wrongly in an old sheet (say December when it is October) must not sit above everyone who really arrived today:
// anything more than a day in the future counts as unknown (null = last), so the newest REAL arrival comes first.
const notFuture = (t) => (Number.isFinite(t) && t <= Date.now() + 86400000 ? t : null);
// "New" = added in the last NEW_DAYS days (the founder's New button on every list).
const NEW_DAYS = 7;
const isNewRow = (r) => { const t = new Date(r.createdAt).getTime(); return Number.isFinite(t) && t >= Date.now() - NEW_DAYS * 86400000 && t <= Date.now() + 86400000; };
const SORTS = {
  applied: (r) => notFuture(r.appliedDate ? new Date(r.appliedDate).getTime() : new Date(r.createdAt).getTime()),
  followUp: (r) => (r.followUp && r.followUp.dueDate ? r.followUp.dueDate : null),
  stage: stageSortKey,
  due: (r) => r.dueDate || null,
  interview: (r) => (r.interviewAt ? new Date(r.interviewAt).getTime() : null),
  joining: (r) => (r.joiningDay || r.joiningPlanned || null),
  name: (r) => String(r.name || '').toLowerCase(),
  activity: (r) => (r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : null),
  created: (r) => notFuture(new Date(r.createdAt).getTime()),
  // Came on: the date the person came to us (utils/cameOn.js); a row with none sorts last.
  cameOn: (r) => (r.cameOn ? new Date(r.cameOn).getTime() : null),
  masterActivity: (r) => (r.lastApplicationActivityAt ? new Date(r.lastApplicationActivityAt).getTime() : null),
  // cand7_: Last contact ("Never" = 0, so oldest-first puts them on top) and Fit %.
  lastContact: (r) => (r.lastContactAt ? new Date(r.lastContactAt).getTime() : 0),
  fit: (r) => (r.matchScore != null ? r.matchScore : null),
  // ATS layout v3: the list's Experience and CTC columns.
  experience: (r) => (r.experienceYears != null ? Number(r.experienceYears) : null),
  ctc: (r) => salaryLakhs(r.currentSalary),
  // Salary fit % (no figure = last) and the hike %.
  salaryFit: (r) => (r.salaryFit && r.salaryFit.pct != null ? r.salaryFit.pct : null),
  hike: (r) => (r.salaryFit && r.salaryFit.salaryHikePct != null ? r.salaryFit.salaryHikePct : null),
};

// SECTION (spec #2 §24): the team of the seat the work sits on ("Team A"),
// only where that department really has more than one team.
let SECTION_CACHE = { at: 0, map: new Map() };
async function sectionMap() {
  if (Date.now() - SECTION_CACHE.at < 5 * 60 * 1000) return SECTION_CACHE.map;
  const ps = await prisma.position.findMany({ select: { code: true, department: true, team: true } });
  const teams = new Map();
  ps.forEach((p) => {
    if (!p.team || !p.department) return;
    if (!teams.has(p.department)) teams.set(p.department, new Set());
    teams.get(p.department).add(p.team);
  });
  const map = new Map();
  ps.forEach((p) => {
    if (p.code && p.team && teams.get(p.department) && teams.get(p.department).size > 1) map.set(String(p.code).toUpperCase(), p.team);
  });
  SECTION_CACHE = { at: Date.now(), map };
  return map;
}
const sectionOfCode = (map, code) => (code ? map.get(String(code).toUpperCase()) || null : null);

// The rows this login may see, decorated, plus the few facts the paged list
// filters on. Mirrors scopedCandidates() + decorate() exactly.
// Per-login memo of the decorated rows: reused while the working set, the
// login's scope and the day are unchanged (a page flip or a filter change
// costs a filter pass, not 17,000 decorate() calls).
// PERF (Batch 1, 2026-10-09): the memo used to expire after 60 s, so the first
// call per login after a quiet minute rebuilt ~12-17k rows (15-36 s). It is now
// kept for ROW_MEMO_TTL_MS (15 min) and is still dropped the moment anything
// it was built from changes: the key carries the working set's version (every
// candidate / application / job / follow-up write bumps it, see
// utils/candidateListCache.js), the IST day, and a hash of the WHOLE scope of
// the login (departments, teams, clients, seats, work lists) so a scope change
// shows at once. Recent use keeps an entry alive (LRU, not first-in-first-out).
// A Super Admin / Admin (global scope: every row, nothing login-specific) shares
// ONE decorated copy with every other global login.
const ROW_MEMO = new Map();
const ROW_INFLIGHT = new Map();
const ROW_MEMO_MAX = 12; // a built list is 10-40 MB (measured): 12 logins stay within ~0.5 GB
const ROW_MEMO_TTL_MS = 15 * 60 * 1000;
function scopeSig(s) {
  const p = s.positions;
  return crypto.createHash('md5').update(JSON.stringify([
    s.global, s.atsRole, s.role, s.departments, s.teams, s.clientId, s.clientIds, s.bdeOwnClientIds, s.bdeDeskDepartments,
    s.bdeDeskRequirementDepartments, s.deptClientDepartments, s.teamUserIds, s.candidateId,
    p ? [p.role, p.positionCodes, p.holderUserIds, p.departments, p.workApplicationIds, p.foreignApplicationIds] : null,
  ])).digest('hex');
}
// LRU memo helpers (a Map keeps insertion order: a hit moves the entry to the end).
function memoGet(map, id, key) {
  const hit = map.get(id);
  if (!hit || hit.key !== key || Date.now() - hit.at >= ROW_MEMO_TTL_MS) return null;
  map.delete(id); map.set(id, hit);
  return hit;
}
function memoPut(map, id, entry) {
  map.delete(id);
  map.set(id, entry);
  while (map.size > ROW_MEMO_MAX) map.delete(map.keys().next().value);
}
async function pagedRowsFor(user) {
  const st = await getListState();
  const s = scopeOf(user);
  const shared = s.global && s.role !== 'CANDIDATE' && viewerKind(user) === 'internal';
  const memoId = shared ? 'G' : user.id;
  // (a shared copy is the same for every global login: their own department / team fields do not matter)
  const key = (shared ? ['G', st.version, istDay(new Date())] : [user.id, st.version, istDay(new Date()), scopeSig(s), ADDED.version()]).join('|');
  const hit = memoGet(ROW_MEMO, memoId, key);
  if (hit) return hit.rows;
  // Requests that arrive together for the same login share one build.
  if (ROW_INFLIGHT.has(key)) return ROW_INFLIGHT.get(key);
  const job = (async () => {
    const rows = await buildPagedRows(user, st, s, shared);
    memoPut(ROW_MEMO, memoId, { key, at: Date.now(), rows });
    return rows;
  })().finally(() => { ROW_INFLIGHT.delete(key); });
  ROW_INFLIGHT.set(key, job);
  return job;
}

// The import days (150+ profiles created that day), worked out once per data version.
let BULK_MEMO = { v: null, set: null };
function bulkDaysFor(st) {
  if (!BULK_MEMO.set || BULK_MEMO.v !== st.version) BULK_MEMO = { v: st.version, set: CAME.bulkDaysOf(st.candidates) };
  return BULK_MEMO.set;
}

async function buildPagedRows(user, st, s, shared = false) {
  let candidates = st.candidates;
  let sharedIds = null;
  if (s.role === 'CANDIDATE') candidates = candidates.filter((c) => c.id === s.candidateId);
  else if (!s.global) {
    // People this login typed in / uploaded and has not yet put on a requirement stay visible to them (utils/candidateAddedBy.js).
    const mine = await ADDED.idsOf(user.id);
    const inScope = (c) => c.applications.some((a) => a.requirement && applicationInScope(user, a));
    const addedOnly = candidates.filter((c) => mine.has(c.id) && !inScope(c));
    candidates = candidates.filter(inScope);
    sharedIds = await clientSharedApplicationIds(user, candidates);
    if (sharedIds) candidates = candidates.filter((c) => visibleApplications(user, c.applications, sharedIds).length > 0);
    if (addedOnly.length) candidates = candidates.concat(addedOnly);
  }
  const me = user.id;
  const todayIst = istDay(new Date());
  const sections = await sectionMap();
  const bulkDays = bulkDaysFor(st);
  // The client's OLD names (ClientAlias) are searchable too: typing "vcare" finds people on jobs of "Prabs VCare Health Clinic".
  // They only feed the search text (hay); no row shows them. A client login never gets them.
  const aliasOf = viewerKind(user) === 'client' ? new Map() : await clientSearch.aliasMap();
  // The joining day of the people who joined (one read for the few joined applications that carry no day of their own).
  const joinMoves = await JL.movesFor(candidates.flatMap((c) => c.applications || []));
  return candidates.map((c) => {
    const row = decorate(c, { user, sharedIds, followUps: st.followUps });
    // Came on: the date + how far to trust it (utils/cameOn.js). TeamLink logins only (a client / the candidate is served none).
    if (viewerKind(user) === 'internal') { const co = CAME.cameOnOf(c, c.applications, bulkDays); row.cameOn = co.at.toISOString(); row.cameOnDay = co.day; row.cameOnKind = co.kind; }
    const apps = row.applications || [];
    const latest = apps.find((a) => a.id === row.latestApplicationId) || null;
    row.pipelineStatus = pipelineStatusOf(row.currentStage);
    // The joining date (user, 2026-10-22): the day the person joined, from the joined application this login sees (the shown one first).
    const ji = JL.joinInfoOfPerson(apps, row.latestApplicationId, joinMoves);
    if (ji) { row.joiningDay = ji.day; row.joinedOther = ji.other; row.joinedDays = ji.days; }
    // "Salary missing" (current or expected pay cannot be read) - TeamLink logins only; nobody is blocked by it.
    if (!shared && viewerKind(user) === 'internal') row.salaryMissing = SALARY.missingOf(c);
    // Ownership (spec #2 §24): Department · Section · TL · Recruiter · BDE.
    row.section = sectionOfCode(sections, row.positionCode);
    // Last activity: the latest change on any application this login sees.
    row.lastActivityAt = apps.reduce((m, a) => {
      const t = a.updatedAt || a.createdAt;
      return t && (!m || new Date(t) > new Date(m)) ? t : m;
    }, null) || c.createdAt;
    row.interviewAt = latest ? latest.interviewAt || null : null;
    row.interviewStatus = latest ? latest.interviewStatus || null : null;
    row.ownerUserId = latest ? ownerUserIdOf(latest, row.followUp) : null;
    row.appIds = apps.map((a) => a.id);
    // (login-specific, and only the pipeline rows' "My candidates" queue reads it: a shared copy has none)
    row.mine = shared ? undefined : apps.some((a) => {
      const r = a.requirement || {};
      const fu = st.followUps.get(a.id);
      return (fu && fu.ownerUserId === me) || r.recruiterId === me || r.tlId === me || r.bdeId === me
        || String(r.recruiterIds || '').split(',').includes(me);
    });
    row.interviewToday = apps.some((a) => a.interviewAt && istDay(a.interviewAt) === todayIst
      && !['CANCELLED', 'NO_SHOW'].includes(a.interviewStatus));
    // Search: name, email, phone, skills, requirement title / id, client —
    // across every application this login sees, not only the latest.
    row.hay = [
      row.name, row.email, row.phone, row.skills, row.requirementId,
      ...apps.map((a) => (a.requirement ? `${a.requirement.title} ${a.requirement.client ? a.requirement.client.name : ''} ${(aliasOf.get(a.requirement.clientId) || []).join(' ')}` : '')),
    ].filter(Boolean).join(' ').toLowerCase();
    row.phoneDigits = String(row.phone || '').replace(/\D/g, '');
    return row;
  });
}

function stageMatches(r, q) {
  if (!q.stage) return true;
  const st = String(q.stage);
  if (st.startsWith('group:')) return r.stageGroup === st.slice(6);
  if (st.startsWith('stage:')) return st.slice(6).split(',').includes(r.currentStage);
  return true;
}

// ?source=Naukri,Shine (or any old word): the clean names, parsed once per distinct value.
const SOURCE_SETS = new Map();
function sourceSetOf(param) {
  const k = String(param);
  if (!SOURCE_SETS.has(k)) {
    if (SOURCE_SETS.size > 200) SOURCE_SETS.clear();
    SOURCE_SETS.set(k, CS.parseSourceFilter(k) || new Set());
  }
  return SOURCE_SETS.get(k);
}

// ?cameFrom=YYYY-MM-DD&cameTo=YYYY-MM-DD (IST days, both ends included) and ?cameKind=sheet,imported,applied,entered.
// A row with no 'came on' date is left out as soon as a date range is asked for.
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
function cameMatches(r, q) {
  if (q.cameFrom && DAY_RE.test(String(q.cameFrom)) && !(r.cameOnDay && r.cameOnDay >= q.cameFrom)) return false;
  if (q.cameTo && DAY_RE.test(String(q.cameTo)) && !(r.cameOnDay && r.cameOnDay <= q.cameTo)) return false;
  if (q.cameKind && !String(q.cameKind).split(',').map((x) => x.trim()).includes(r.cameOnKind)) return false;
  return true;
}

// ?joinedFrom=YYYY-MM-DD&joinedTo=YYYY-MM-DD ("Joined between", both days included): the person joined on a day inside the range
// (on any of the joined applications this login sees). Someone with no joining day on file is left out as soon as a range is asked for.
function joinedMatches(days, q) {
  const from = q.joinedFrom && DAY_RE.test(String(q.joinedFrom)) ? String(q.joinedFrom) : '';
  const to = q.joinedTo && DAY_RE.test(String(q.joinedTo)) ? String(q.joinedTo) : '';
  if (!from && !to) return true;
  return (days || []).some((d) => d && (!from || d >= from) && (!to || d <= to));
}

function rowMatches(r, q, ctx, { skipStage = false } = {}) {
  if (ctx.search) {
    const digits = ctx.search.replace(/\D/g, '');
    const phoneHit = digits.length >= 4 && r.phoneDigits.includes(digits);
    if (!r.hay.includes(ctx.search) && !phoneHit) return false;
  }
  if (q.location && r.location !== q.location) return false;
  if (q.new === '1' && !isNewRow(r)) return false;
  if (q.source && !sourceSetOf(q.source).has(r.sourceKey)) return false;
  if (!cameMatches(r, q)) return false;
  if (!joinedMatches(r.joinedDays, q)) return false;
  // cand7_: the person's master Qualification / Specialisation ('none' = not mapped).
  if (q.qualificationId && (r.qualificationId || 'none') !== q.qualificationId) return false;
  if (q.specialisationId && (r.specialisationId || 'none') !== q.specialisationId) return false;
  if (q.status) {
    const wanted = String(q.status).split(',');
    const legacy = { 'On Hold': 'Hold', Closed: 'Joined' };
    const mine = r.pipelineStatus || 'None';
    if (!wanted.some((w) => (legacy[w] || w) === mine)) return false;
  }
  if (q.followUp) {
    const wanted = String(q.followUp).split(',').map((x) => x.trim()).filter(Boolean);
    if (!wanted.includes(r.followUp ? r.followUp.status : 'Not set')) return false;
  }
  if (!skipStage && !stageMatches(r, q)) return false;
  const apps = r.applications || [];
  const any = (pred) => apps.length > 0 && apps.some(pred);
  if (q.department && !any((a) => a.requirement && a.requirement.department === q.department)) return false;
  // ?hiring=internal | client — the Client | Internal split of the actual
  // workflow (internal hiring is a filter here, not a separate module).
  if (q.hiring === 'internal' && !any((a) => a.requirement && a.requirement.internal)) return false;
  if (q.hiring === 'client' && !any((a) => a.requirement && !a.requirement.internal)) return false;
  if (q.clientId && !any((a) => a.requirement && a.requirement.clientId === q.clientId)) return false;
  if (q.requirementId && !any((a) => a.requirementId === q.requirementId)) return false;
  if (q.appliedFrom && !any((a) => String(new Date(a.createdAt).toISOString()).slice(0, 10) >= q.appliedFrom)) return false;
  if (q.appliedTo && !any((a) => String(new Date(a.createdAt).toISOString()).slice(0, 10) <= q.appliedTo)) return false;
  if (ctx.personIds && !r.appIds.some((id) => ctx.personIds.has(id))) return false;
  // ATS layout v3: People → "Available for matching" (the Candidates card).
  if (q.available === '1' && !availableForMatching(r)) return false;
  // People → "Salary missing" (current or expected pay not saved / not readable).
  if (q.salaryMissing === '1' && !r.salaryMissing) return false;
  return true;
}

const PAGED_EXTRA_FIELDS = [
  'pipelineStatus', 'interviewAt', 'interviewStatus', 'ownerUserId', 'appliedDate',
  'latestApplicationId', 'waitingOn', 'requirementDepartment',
  // spec #2 §24 / §29 — ownership and the optional columns.
  'bdeName', 'section', 'lastActivityAt',
  'salaryMissing', // "Add salary" prompt + the Salary missing filter
  'cameOn', 'cameOnDay', 'cameOnKind', // Source · Came on
  'joiningDay', 'joiningPlanned', 'joinedOther', // Joining date column (joinedOther: the person joined on ANOTHER application than the shown one)
];
function pagedOut(row) {
  const out = slimForList(row);
  PAGED_EXTRA_FIELDS.forEach((f) => { if (row[f] !== undefined) out[f] = row[f]; });
  return out;
}

// --- ATS Pipeline: one row per application -----------------------------------
// Who the work is ATTRIBUTED to (the application's latest follow-up names the
// recruiter / TL / BDE who worked it — utils/workers.js attribute()'s first
// source), for nextActionFor()'s owner fallback.
const attributedOf = (fu) => (fu ? {
  recruiter: { userId: fu.ownerUserId || null, name: fu.ownerName || null },
  tl: { userId: fu.tlUserId || null, name: fu.tlName || null },
  bde: { userId: fu.bdeUserId || null, name: fu.bdeName || null },
} : null);
const APP_ROW_MEMO = new Map();
const APP_ROW_INFLIGHT = new Map();
async function pipelineRowsFor(user) {
  // The two snapshots are independent reads: wait for both at once.
  const [st, snap] = await Promise.all([getListState(), ensureNextActionContext()]);
  const s = scopeOf(user);
  // The due-date and follow-up rules are settings an admin can change: their versions are part of the key.
  const rulesAt = viewerKind(user) === 'internal' ? ((await FV.loadRules().catch(() => null)) || {}).updatedAt || '' : '';
  const key = [user.id, st.version, snap.stamp, istDay(new Date()), scopeSig(s), require('../utils/atsAlertSettings').alertSettingsVersion(), rulesAt].join('|'); // eslint-disable-line global-require
  const hit = memoGet(APP_ROW_MEMO, user.id, key);
  if (hit) return hit;
  // SPEED (2026-10-03): the page asks for the list, the filter counts and the
  // board at the same moment — all three for the same login. They now share
  // ONE build instead of building the same rows three times over.
  if (APP_ROW_INFLIGHT.has(key)) return APP_ROW_INFLIGHT.get(key);
  const job = (async () => {
    const built = await buildPipelineRows(user, st, s, snap);
    const entry = { key, at: Date.now(), version: st.version, ...built };
    memoPut(APP_ROW_MEMO, user.id, entry);
    return entry;
  })().finally(() => { APP_ROW_INFLIGHT.delete(key); });
  APP_ROW_INFLIGHT.set(key, job);
  return job;
}

async function buildPipelineRows(user, st, s, snap) {
  let candidates = st.candidates;
  let sharedIds = null;
  if (s.role === 'CANDIDATE') candidates = candidates.filter((c) => c.id === s.candidateId);
  else if (!s.global) {
    candidates = candidates.filter((c) => c.applications.some((a) => a.requirement && applicationInScope(user, a)));
    sharedIds = await clientSharedApplicationIds(user, candidates);
  }
  const kind = viewerKind(user);
  const internalViewer = kind === 'internal';
  const me = user.id;
  const viewer = { id: me, atsRole: s.atsRole };
  // Salary fit: TeamLink logins only; the BDE team (and any login without the Candidate Contact & Salary switch) gets the % label only, no figures.
  const fitViewer = internalViewer ? SALARY.viewerFor(require('../utils/clientRedact').privacyFlagsFor(user)) : null; // eslint-disable-line global-require
  const today = todayIst();
  const sections = await sectionMap();
  const bulkDays = bulkDaysFor(st);
  const aliasOf = kind === 'client' ? new Map() : await clientSearch.aliasMap(); // old client names: search text only
  // C1: latest contact per application + the per-stage due rules (only used
  // once the user has confirmed them) — utils/followupVisibility.js.
  const [contactIdx, contactRules] = internalViewer
    ? await Promise.all([FV.contactIndex(snap.stamp), FV.loadRules()]) : [null, null];
  // cand7_: "Rejected before" (utils/rejections.js index — a count only, so a
  // recruiter learns THAT, never where) and the Qualification / Specialisation
  // master names for the Filters panel. Never fatal.
  let rjIx = null;
  // eslint-disable-next-line global-require
  if (internalViewer) { try { rjIx = await require('../utils/rejections').index(); } catch { rjIx = null; } }
  let specL = null;
  // eslint-disable-next-line global-require
  try { specL = await require('../utils/specialisations').labelsFor(); } catch { specL = null; }
  // B7: "Partner: <name> · yours till <date>" on partner-owned people (TeamLink logins only).
  let partnerOwners = new Map();
  // eslint-disable-next-line global-require
  if (internalViewer) { try { partnerOwners = await require('../utils/partners').ownerMap(candidates); } catch { partnerOwners = new Map(); } }
  const rows = [];
  // Joining date column: a joined application with no joining date and no joined-at time is dated by its move into Joined (the ATS reports' rule).
  const joinedMoveAt = await JL.movesFor(candidates.flatMap((c) => c.applications || []));
  let preAts = 0;
  let people = 0;
  candidates.forEach((c) => {
    const apps = s.global ? (c.applications || []) : visibleApplications(user, c.applications, sharedIds);
    if (s.global || apps.length) people += 1;
    const inAts = apps.filter((a) => !isPreAtsApplication(a));
    const co = internalViewer ? CAME.cameOnOf(c, c.applications, bulkDays) : null;
    preAts += apps.length - inAts.length;
    inAts.forEach((a) => {
      const r = a.requirement || null;
      const internal = isInternalApp(a, r);
      const latestFu = st.followUps.get(a.id) || null;
      const na = nextActionFor(a, { today, attributed: attributedOf(latestFu) });
      const fu = internalViewer ? latestFu : null;
      const positionCode = (internalViewer && fu && fu.ownerPositionCode) || (r ? r.positionCode || null : null);
      const cfp = isClientFeedbackPending(a, snap);
      const srcRow = internalViewer ? CS.sourceOfApplication(a, c) : { key: null, raw: null };
      const row = {
        id: a.id,
        applicationId: a.id,
        latestApplicationId: a.id,
        candidateId: c.id,
        code: candidateCode(c.id),
        name: c.name,
        email: c.email,
        phone: c.phone,
        location: c.location,
        source: c.source,
        // The clean source of THIS application (its own word, else the person's), once, here.
        sourceKey: srcRow.key,
        sourceRaw: srcRow.raw,
        partner: partnerOwners.get(c.id) || null,
        skills: c.skills,
        experienceYears: c.experienceYears ?? null,
        noticePeriod: c.noticePeriod || null,
        expectedSalary: c.expectedSalary || null,
        // ATS layout v3: the CTC column (TeamLink logins only).
        ...(kind === 'client' ? {} : { currentSalary: c.currentSalary || null }),
        createdAt: a.createdAt,
        appliedDate: a.createdAt,
        applicationsCount: apps.length,
        requirementId: a.requirementId,
        requirementTitle: r ? r.title : null,
        reqCode: r ? r.reqCode || null : null,
        requirementDepartment: r ? r.department || null : null,
        internal,
        hiringLabel: internal ? 'Internal' : 'Client',
        clientId: r && !internal ? r.clientId : null,
        clientName: r ? (internal ? 'TeamLink (internal)' : (r.client && r.client.name) || null) : null,
        currentStage: a.stage,
        currentStageLabel: stageLabelFor(a.stage, { internal }),
        stageGroup: groupIdOfStage(a.stage),
        stageGroupLabel: groupLabelOfStage(a.stage),
        stageDetailLabel: stageDetail(a),
        stageKey: stageKeyOf(a, internal, snap),
        pipelineStatus: pipelineStatusOf(a.stage),
        lifeStatus: applicationLifeStatus(a),
        // One named owner with a login, or none ('No owner named').
        owner: na.live ? (na.ownerName || null) : '—',
        ownerRole: na.ownerRole,
        ownerUserId: na.ownerUserId,
        ownerSource: na.ownerSource,
        waitingOn: na.waitingOn,
        nextAction: na.action,
        dueDate: na.dueAt,
        dueSource: na.dueSource,
        dueStatus: na.dueStatus,
        overdue: na.dueStatus === 'overdue',
        stageEnteredAt: na.enteredAt,
        // The joining date column (user, 2026-10-17): the day a JOINED person joined (one rule: utils/joinDayShared.js), else the planned day of someone not joined yet.
        joiningDay: ['JOINED', 'HIRED'].includes(a.stage) ? joinDayShared.joinDay({ joiningDate: a.joiningDate || (snap.appDates.get(a.id) || {}).joiningDate, joinedAt: a.joinedAt }, joinedMoveAt.get(a.id) || na.enteredAt) : null,
        joiningPlanned: ['JOINED', 'HIRED'].includes(a.stage) ? null : joinDayShared.typedDay(a.joiningDate || (snap.appDates.get(a.id) || {}).joiningDate),
        followUp: fu,
        followUpNeed: followUpNeed(a),
        recruiterName: (internalViewer && fu && fu.ownerName) || (a.ownerRecruiterId && snap.activeUsers.get(a.ownerRecruiterId)) || (r && r.recruiter ? r.recruiter.name : null),
        positionCode,
        section: sectionOfCode(sections, positionCode),
        tlName: (internalViewer && fu && fu.tlName) || (r ? r.tl || null : null),
        bdeName: r && r.bde ? r.bde.name : null,
        interviewAt: a.interviewAt || null,
        interviewStatus: a.interviewStatus || null,
        lastActivityAt: a.updatedAt || a.createdAt,
        aiInterviewStatus: a.aiInterviewStatus || 'Required',
        ...(kind === 'client' ? {} : { matchScore: a.matchScore ?? a.resumeScore ?? null }),
        ...(fitViewer ? { salaryFit: SALARY.fitFor(c, r, fitViewer) } : {}),
        // cand7_: person-level facts the Filters panel and the board read.
        qualificationId: c.qualificationId || null,
        qualificationName: specL && c.qualificationId ? specL.qual(c.qualificationId) : null,
        specialisationId: c.specialisationId || null,
        specialisationName: specL && c.specialisationId ? specL.spec(c.specialisationId) : null,
        archived: c.profileStatus === 'Archived',
        doNotUse: c.profileStatus === 'Do Not Use',
        rejectedCount: rjIx ? (rjIx.byCandidate.get(c.id) || []).length : 0,
        // Rejections (spec 2026-10-03 §A1): the Rejected tab's Filters — whose decision and the reason.
        ...(rjIx && a.stage === 'REJECTED' ? (() => {
          const x = rjIx.byApplication && rjIx.byApplication.get(a.id);
          return { rejSide: (x && x.side) || 'none', rejReason: (x && x.reason) || 'Not recorded' };
        })() : {}),
        candidateAddedAt: c.createdAt,
        ...(co ? { cameOn: co.at.toISOString(), cameOnDay: co.day, cameOnKind: co.kind } : {}),
        needsAction: needsActionBy(a, na, viewer),
        isNew: isNewUnreviewed(a, na, viewer, snap),
        clientFeedbackPending: cfp,
        feedback: cfp ? feedbackWait(a, na, today) : null,
        // C1: lastContactAt / lastContactMode / lastContactBy / lastContactDays /
        // contactDue / contactBadge — internal logins only.
        ...(contactIdx ? FV.contactStatus({
          stage: a.stage,
          contact: FV.lastContactOf(contactIdx, a.id, c.id),
          followUpDue: latestFu && !latestFu.completedAt ? latestFu.dueDate : null,
          rules: contactRules,
          enteredAt: na.enteredAt,
          interviewAt: a.interviewAt,
          joiningDate: a.joiningDate || (snap.appDates.get(a.id) || {}).joiningDate || null,
          today,
        }) : {}),
      };
      row.mine = (fu && fu.ownerUserId === me) || (!!r && (r.recruiterId === me || r.tlId === me || r.bdeId === me
        || String(r.recruiterIds || '').split(',').includes(me)));
      row.interviewToday = !!a.interviewAt && istDay(a.interviewAt) === today
        && !['CANCELLED', 'NO_SHOW'].includes(a.interviewStatus);
      row.hay = [c.name, c.email, c.phone, r ? r.title : '', r ? r.reqCode : '', row.clientName, ...(r && r.clientId ? aliasOf.get(r.clientId) || [] : []), a.requirementId]
        .filter(Boolean).join(' ').toLowerCase();
      row.phoneDigits = String(c.phone || '').replace(/\D/g, '');
      rows.push(row);
    });
  });
  // people = the Candidate Master's row count for this login (a global login
  // also sees people with no application), so the view tabs can show it
  // without building the master rows.
  return { rows, preAts, people };
}

function pipelineStageMatches(r, q) {
  if (!q.stage) return true;
  const st = String(q.stage);
  if (st.startsWith('st:')) return st.slice(3).split(',').includes(r.stageKey);
  if (st.startsWith('group:')) return r.stageGroup === st.slice(6);
  if (st.startsWith('stage:')) return st.slice(6).split(',').includes(r.currentStage);
  return true;
}
function pipelineRowMatches(r, q, ctx, { skipStage = false } = {}) {
  if (ctx.search) {
    const digits = ctx.search.replace(/\D/g, '');
    const phoneHit = digits.length >= 4 && r.phoneDigits.includes(digits);
    if (!r.hay.includes(ctx.search) && !phoneHit) return false;
  }
  if (q.location && r.location !== q.location) return false;
  if (q.new === '1' && !isNewRow(r)) return false;
  if (q.source && !sourceSetOf(q.source).has(r.sourceKey)) return false;
  if (!cameMatches(r, q)) return false;
  if (!joinedMatches(r.pipelineStatus === 'Joined' && r.joiningDay ? [r.joiningDay] : [], q)) return false;
  if (q.status) {
    const wanted = String(q.status).split(',');
    const legacy = { 'On Hold': 'Hold', Closed: 'Joined' };
    if (!wanted.some((w) => (legacy[w] || w) === r.pipelineStatus)) return false;
  }
  if (q.followUp) {
    const wanted = String(q.followUp).split(',').map((x) => x.trim()).filter(Boolean);
    if (!wanted.includes(r.followUp ? r.followUp.status : 'Not set')) return false;
  }
  if (!skipStage && !pipelineStageMatches(r, q)) return false;
  if (q.department && r.requirementDepartment !== q.department) return false;
  if (q.hiring === 'internal' && !r.internal) return false;
  if (q.hiring === 'client' && r.internal) return false;
  if (q.clientId && r.clientId !== q.clientId) return false;
  if (q.requirementId && r.requirementId !== q.requirementId) return false;
  const day = r.appliedDate ? new Date(r.appliedDate).toISOString().slice(0, 10) : '';
  if (q.appliedFrom && !(day && day >= q.appliedFrom)) return false;
  if (q.appliedTo && !(day && day <= q.appliedTo)) return false;
  // Spec 2026-10-03 §B: Skills · Experience · Notice period · Salary · Match ≥ %.
  if (q.skills) {
    const have = String(r.skills || '').toLowerCase();
    if (!String(q.skills).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).every((s) => have.includes(s))) return false;
  }
  if (q.minExp !== undefined && q.minExp !== '' && !(r.experienceYears != null && r.experienceYears >= Number(q.minExp))) return false;
  if (q.maxExp !== undefined && q.maxExp !== '' && !(r.experienceYears != null && r.experienceYears <= Number(q.maxExp))) return false;
  if (q.notice && String(r.noticePeriod || '') !== q.notice) return false;
  if (q.maxSalary !== undefined && q.maxSalary !== '') {
    const lakhs = salaryLakhs(r.expectedSalary);
    if (lakhs === null || lakhs > Number(q.maxSalary)) return false;
  }
  if (q.minMatch !== undefined && q.minMatch !== '' && !(r.matchScore != null && r.matchScore >= Number(q.minMatch))) return false;
  // Salary fit: ?salaryFit=within,slightly,above,missing,nobudget (any of them)
  if (q.salaryFit && !(r.salaryFit && String(q.salaryFit).split(',').some((k) => r.salaryFit.keys.includes(k.trim())))) return false;
  // C1: ?contact=never | stale3 | overdue | not_followed | due_today | followed
  if (q.contact && !FV.matchesContactFilter(q.contact, r)) return false;
  // cand7_: an ARCHIVED person is hidden from every list (People → Archived
  // brings them back); Qualification / Specialisation ('none' = not mapped);
  // Owner (whose move it is now, 'none' = nobody named); Rejected before.
  if (r.archived && q.archived !== '1') return false;
  if (q.qualificationId && (r.qualificationId || 'none') !== q.qualificationId) return false;
  if (q.specialisationId && (r.specialisationId || 'none') !== q.specialisationId) return false;
  if (q.owner && ownerKeyOf(r) !== q.owner) return false;
  if (q.rejectedBefore === 'yes' && !(r.rejectedCount > 0)) return false;
  if (q.rejectedBefore === 'no' && r.rejectedCount > 0) return false;
  if (q.rejSide && r.rejSide !== q.rejSide) return false;
  if (q.rejReason && r.rejReason !== q.rejReason) return false;
  // ATS layout v3: "Not followed up 7+ / 30+ days" (the Candidates cards).
  if (q.contactAge && !(contactAgeDays(r) != null && contactAgeDays(r) >= Number(q.contactAge))) return false;
  if (ctx.personIds && !ctx.personIds.has(r.id)) return false;
  return true;
}
// Days since anyone last contacted this person about a LIVE (Active) job —
// counted from the day it was added when nobody ever did. null = not live.
function contactAgeDays(r) {
  if (r.pipelineStatus !== 'Active') return null;
  if (r.lastContactAt) return r.lastContactDays != null ? r.lastContactDays : Math.floor((Date.now() - new Date(r.lastContactAt).getTime()) / 86400000);
  const from = r.appliedDate || r.createdAt;
  return from ? Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 86400000)) : null;
}
// ATS layout v3: "Available for matching" — not archived, not "Do not use",
// and no live or joined job: every job this login sees ended in a reject, or
// the person is on no job yet.
function availableForMatching(r) {
  if (['Archived', 'Do Not Use'].includes(r.profileStatus)) return false;
  return (r.applications || []).every((a) => a.stage === 'REJECTED');
}
// Whose move it is, as a filter value: a user id, 'none' (live, nobody named),
// or null for a closed application (Joined / Rejected have no owner).
function ownerKeyOf(r) {
  if (!LIVE_STATUSES.includes(r.pipelineStatus)) return null;
  return r.ownerUserId || 'none';
}
// "₹6.5L", "6 LPA", "650000", "6,50,000" -> lakhs per year (6.5); null = not a number.
function salaryLakhs(v) {
  const s = String(v || '').toLowerCase().replace(/[,₹\s]/g, '');
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (/l|lakh|lpa/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 4))) return n;
  if (/k/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 2))) return (n * 1000 * 12) / 100000;
  return n >= 1000 ? n / 100000 : n;
}
const PIPELINE_HIDDEN = ['hay', 'phoneDigits', 'mine', 'interviewToday'];
function pipelineOut(r) {
  const out = { ...r };
  PIPELINE_HIDDEN.forEach((k) => { delete out[k]; });
  return out;
}

function sortRows(rows, q) {
  const sortKey = SORTS[q.sort] ? q.sort : 'applied';
  const dir = q.dir === 'asc' ? 1 : -1;
  const keyOf = SORTS[sortKey];
  const sorted = rows.map((r) => ({ r, k: keyOf(r) }))
    .sort((x, y) => {
      if (x.k == null && y.k == null) return 0;
      if (x.k == null) return 1;
      if (y.k == null) return -1;
      if (x.k < y.k) return -dir;
      if (x.k > y.k) return dir;
      return 0;
    })
    .map((x) => x.r);
  return { rows: sorted, sortKey, dir };
}

function pageOf(rows, q) {
  const pageSize = PAGE_SIZES.includes(Number(q.pageSize)) ? Number(q.pageSize) : 25;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, parseInt(q.page, 10) || 1), pages);
  return { pageRows: rows.slice((page - 1) * pageSize, page * pageSize), page, pages, pageSize };
}

// PEOPLE WHO ARE NOT ON ANY REQUIREMENT YET (founder, 2026-10-23). The pipeline has one row per APPLICATION, so a person typed in by hand or
// uploaded as a resume (no requirement chosen) has no row there. This returns them for a strip above the table: the newest ones (added in the
// last 7 days), plus - when something is typed in Search - everybody without an application who matches it by name, phone, e-mail or skills.
// Same reach as the lists: Admin sees all; everybody else only the people they added themselves.
async function waitingPeople(user, search) {
  if (viewerKind(user) !== 'internal') return { total: 0, rows: [] };
  const st = await getListState();
  const s = scopeOf(user);
  const mine = s.global ? null : await ADDED.idsOf(user.id);
  const term = String(search || '').trim().toLowerCase();
  const digits = term.replace(/\D/g, '');
  const hide = require('../utils/clientLifecycle').isBdeTeam(user); // eslint-disable-line global-require
  const hits = st.candidates.filter((c) => {
    if ((c.applications || []).length) return false;
    if (mine && !mine.has(c.id)) return false;
    if (c.profileStatus === 'Archived') return false;
    if (term) {
      const hay = [c.name, c.email, c.phone, c.skills].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term) || (digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits));
    }
    return isNewRow(c);
  }).sort((x, y) => (notFuture(new Date(y.createdAt).getTime()) || 0) - (notFuture(new Date(x.createdAt).getTime()) || 0));
  const rows = hits.slice(0, 8).map((c) => {
    const src = CS.sourceOfApplication(null, c);
    return {
      id: c.id, code: candidateCode(c.id), name: c.name, location: c.location || null, skills: c.skills || null,
      phone: hide ? null : c.phone || null, email: hide ? null : c.email || null,
      sourceKey: src.key || null, sourceRaw: src.raw || null, addedAt: c.createdAt,
    };
  });
  return { total: hits.length, rows };
}

async function pipelineList(req, res, sub) {
  const q = req.query;
  const quick = QUEUES[q.quick] ? q.quick : null;
  const att = hasPersonQuery(q) ? await attributedApplications(req.user, q) : null;
  const ctx = { search: String(q.search || '').trim().toLowerCase(), personIds: att ? att.ids : null };
  const built = await pipelineRowsFor(req.user);
  // cand7_: archived people are not part of any pipeline count.
  const all = q.archived === '1' ? built.rows : built.rows.filter((r) => !r.archived);
  const noStage = all.filter((r) => pipelineRowMatches(r, q, ctx, { skipStage: true }));
  const filtered = q.stage ? noStage.filter((r) => pipelineStageMatches(r, q)) : noStage;

  // Sub-tab counts over the filters already on; queue counts over every
  // sub-tab; stage counts with every other filter on (the stage one off).
  const subs = {};
  PIPELINE_SUBS.forEach((k) => { subs[k] = 0; });
  filtered.forEach((r) => { PIPELINE_SUBS.forEach((k) => { if (inPipelineSub(k, r)) subs[k] += 1; }); });
  // THE TALLY (utils/pipelineTally.js): every step + Hold + Rejected, over the same rows as the list
  // with every filter on EXCEPT the step, so Active + Joined + On hold + Rejected = All applications.
  const tallyOut = PT.tally(noStage, await PT.clientSeenIds(built.version).catch(() => null));
  const queueCounts = {};
  Object.keys(QUEUES).forEach((k) => { queueCounts[k] = 0; });
  let noDue = 0;
  filtered.forEach((r) => {
    Object.keys(QUEUES).forEach((k) => { if (QUEUES[k](r)) queueCounts[k] += 1; });
    if (r.dueStatus === 'no_due') noDue += 1;
  });
  const effSub = quick ? 'all' : sub;
  const stageCounts = {};
  noStage.forEach((r) => {
    if (!inPipelineSub(effSub, r) || (quick && !QUEUES[quick](r))) return;
    if (r.stageKey) stageCounts[r.stageKey] = (stageCounts[r.stageKey] || 0) + 1;
  });
  const role = stageRoleOf(req.user);
  const rel = role === 'all' ? null : STAGE_ROLE_KEYS[role];
  const internalOnly = q.hiring === 'internal';
  const clientOnly = q.hiring === 'client';
  const stageOptions = PIPE_STAGES
    .filter((o) => (internalOnly ? !!o.internal : (clientOnly ? !!o.label : (!!o.label || (stageCounts[o.key] || 0) > 0))))
    .map((o) => ({
      key: o.key,
      label: internalOnly ? o.internal : (o.label || o.internal),
      count: stageCounts[o.key] || 0,
      relevant: !rel || rel.includes(o.key),
    }))
    .filter((o) => o.relevant || o.count > 0 || (q.stage && String(q.stage).split(',').includes(`st:${o.key}`)));

  let rows = filtered.filter((r) => inPipelineSub(effSub, r));
  if (quick) rows = rows.filter((r) => QUEUES[quick](r));
  const sorted = sortRows(rows, q);
  rows = sorted.rows;

  if (q.idsOnly === '1') {
    return res.json({
      total: rows.length,
      capped: rows.length > ID_CAP,
      items: rows.slice(0, ID_CAP).map((r) => ({
        id: r.candidateId,
        rowId: r.id,
        latestApplicationId: r.id,
        name: r.name,
        phone: r.phone || null,
        requirementTitle: r.requirementTitle || null,
        clientName: r.clientName || null,
        stageLabel: r.stageDetailLabel || r.currentStageLabel || null,
      })),
    });
  }
  if (q.all === '1') {
    if (isInternalViewer(req.user)) await attachRejections(rows);
    return res.json(rows.map(pipelineOut));
  }
  const pg = pageOf(rows, q);
  if (isInternalViewer(req.user)) await attachRejections(pg.pageRows);
  // "Rejected N×" + who rejected (spec 2026-10-03 §A1, utils/rejections.js), on the copies.
  const pageOut = pg.pageRows.map(pipelineOut);
  if (isInternalViewer(req.user)) await require('../utils/candidateDupes').attachFlags(pageOut); // eslint-disable-line global-require  // dup_: the red "Duplicate" chip
  if (isInternalViewer(req.user)) await require('../utils/rejections').attachRejectionBadges(req.user, pageOut); // eslint-disable-line global-require
  // "Interview requested by <recruiter>" (a Recruiter / TL asked the client manager to book): utils/interviewRequest.js
  if (isInternalViewer(req.user)) await require('../utils/interviewRequest').attachTo(pageOut); // eslint-disable-line global-require
  return res.json({
    view: 'pipeline',
    sub: effSub,
    rows: pageOut,
    total: rows.length,
    page: pg.page,
    pages: pg.pages,
    pageSize: pg.pageSize,
    quick,
    sort: sorted.sortKey,
    dir: sorted.dir === 1 ? 'asc' : 'desc',
    scopeTotal: all.length,
    counts: {
      views: { pipeline: all.length, master: built.people, jobPortal: built.preAts },
      subs,
      tally: tallyOut,
      quick: queueCounts,
      noDue,
      stageOptions,
      stageRole: role,
    },
    definitions: QUEUE_DEFINITIONS,
    waiting: await waitingPeople(req.user, q.search).catch(() => ({ total: 0, rows: [] })),
  });
}

// Plain-language rules, served so the tooltips can never drift from the maths.
const QUEUE_DEFINITIONS = {
  my_pending: 'Needs Action — live applications whose next action is yours: you are the named owner (open follow-up owner, or the Recruiter / TL / BDE the requirement names for that stage), or nobody is named and the step belongs to your role.',
  overdue: 'Overdue — the next action’s due date is before today. Due date = an open follow-up’s due date, otherwise the day the application entered its current stage in TeamLink + that stage’s SLA days. Rows imported with their stage already set have no due date until someone moves them or sets a follow-up.',
  due_today: 'Due Today — the next action’s due date (follow-up due date, or stage entry + SLA) is today.',
  new: 'New / Unreviewed — entered your workflow (sent to ATS, added, or moved to a step you own) and nobody has acted since: no stage move, note, call, message or follow-up after it arrived.',
  client_feedback: 'Interview done, no feedback — the interview for a client requirement has happened and nobody has recorded the feedback yet (no client feedback form, no interview result). This counts every such application, old imported ones included; the dashboard counts only the ones still recent.',
  my_candidates: 'My Candidates — applications on requirements you are named on, or follow-ups you own.',
  today_interviews: 'Today’s Interviews — an interview scheduled for today (not cancelled / no-show).',
};

// --- Candidate Master: one row per person --------------------------------------
const INACTIVE_DEFAULT_DAYS = 180;
function inactiveDaysOf(q) {
  const n = parseInt(q.inactiveDays, 10);
  return Number.isFinite(n) && n >= 30 && n <= 3650 ? n : INACTIVE_DEFAULT_DAYS;
}
// Latest APPLICATION activity of a person: an application's applied date, a
// stage move / screening step, note, call, message or follow-up recorded in
// TeamLink. (Not updatedAt — the sheet imports touched every row at once.)
function lastApplicationActivity(row, snap) {
  const apps = row.applications || [];
  let last = 0;
  apps.forEach((a) => {
    const t = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    if (t > last) last = t;
    const act = snap.lastAction.get(a.id) || 0;
    if (act > last) last = act;
  });
  const cand = snap.candAction.get(row.id) || 0;
  if (cand > last) last = cand;
  if (!apps.length) {
    const t = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    if (t > last) last = t;
  }
  return last || null;
}

async function masterList(req, res, sub) {
  const q = req.query;
  const att = hasPersonQuery(q) ? await attributedApplications(req.user, q) : null;
  const ctx = { search: String(q.search || '').trim().toLowerCase(), personIds: att ? att.ids : null };
  const snap = await ensureNextActionContext();
  const days = inactiveDaysOf(q);
  const cutoff = Date.now() - days * 86400000;
  const all = await pagedRowsFor(req.user);
  const kind = viewerKind(req.user);
  const qq = { ...q, stage: '', followUp: '' };
  // cand7_: People → Archived shows only archived people; every other view hides them.
  let archivedCount = 0;
  let liveCount = 0;
  const filtered = all.filter((r) => {
    if (!rowMatches(r, qq, ctx)) return false;
    if (q.hiring === 'internal' && !(r.applications || []).some((a) => a.requirement && a.requirement.internal)) return false;
    if (q.hiring === 'client' && !(r.applications || []).some((a) => a.requirement && !a.requirement.internal)) return false;
    const archived = r.profileStatus === 'Archived';
    if (archived) archivedCount += 1; else liveCount += 1;
    return archived === (sub === 'archived');
  });
  const withActivity = filtered.map((r) => ({ r, last: lastApplicationActivity(r, snap) }));
  const inactiveRows = withActivity.filter((x) => !x.last || x.last < cutoff);
  let dupCount = null;
  // dup_: the fast count of what waits at the first step (utils/candidateDupResolve.js); the older whole-database group count only
  // when the duplicate tables are not there.
  try {
    const w = await require('../utils/candidateDupResolve').waitingCount(req.user); // eslint-disable-line global-require
    if (w.supported && w.show) dupCount = w.waiting;
    else if (!w.supported && isDupAdmin(req.user)) dupCount = (await visibleDuplicateGroups()).groups.contact.length;
  } catch { dupCount = null; }
  const subs = {
    all: liveCount, inactive: inactiveRows.length, duplicates: dupCount, archived: archivedCount,
  };
  const pick = sub === 'inactive' ? inactiveRows : withActivity;
  const shaped = pick.map(({ r, last }) => {
    const apps = r.applications || [];
    const latest = apps.find((a) => a.id === r.latestApplicationId) || null;
    return {
      ...r,
      code: candidateCode(r.id),
      applicationsCount: apps.length,
      lastApplicationActivityAt: last ? new Date(last).toISOString() : null,
      inactive: !last || last < cutoff,
      currentInJobPortal: !!latest && isPreAtsApplication(latest),
      phone: kind === 'client' ? maskPhone(r.phone) : r.phone,
      email: kind === 'client' ? maskEmail(r.email) : r.email,
    };
  });
  const sorted = sortRows(shaped, q.sort === 'activity'
    ? { ...q, sort: 'masterActivity' } : q);
  if (q.idsOnly === '1') {
    return res.json({
      total: sorted.rows.length,
      capped: sorted.rows.length > ID_CAP,
      items: sorted.rows.slice(0, ID_CAP).map((r) => ({
        id: r.id, rowId: r.id, latestApplicationId: r.latestApplicationId || null, name: r.name, phone: r.phone || null,
        requirementTitle: r.requirementTitle || null, clientName: r.clientName || null, stageLabel: r.stageDetailLabel || r.currentStageLabel || null,
      })),
    });
  }
  const outRow = (r) => ({
    ...pagedOut(r),
    code: r.code,
    applicationsCount: r.applicationsCount,
    lastApplicationActivityAt: r.lastApplicationActivityAt,
    inactive: r.inactive,
    currentInJobPortal: r.currentInJobPortal,
    phone: r.phone,
    email: r.email,
  });
  if (q.all === '1') return res.json(sorted.rows.map(outRow));
  const pg = pageOf(sorted.rows, q);
  const masterOut = pg.pageRows.map(outRow);
  if (kind === 'internal') await require('../utils/candidateDupes').attachFlags(masterOut); // eslint-disable-line global-require  // dup_: the red "Duplicate" chip
  if (kind === 'internal') await require('../utils/rejections').attachRejectionBadges(req.user, masterOut, (r) => r.id); // eslint-disable-line global-require
  const pipe = await pipelineRowsFor(req.user);
  return res.json({
    view: 'master',
    sub,
    rows: masterOut,
    total: sorted.rows.length,
    page: pg.page,
    pages: pg.pages,
    pageSize: pg.pageSize,
    sort: sorted.sortKey,
    dir: sorted.dir === 1 ? 'asc' : 'desc',
    scopeTotal: all.length,
    inactiveDays: days,
    counts: {
      views: { pipeline: pipe.rows.length, master: all.length, jobPortal: pipe.preAts },
      subs,
      // people (with every other filter on) whose current or expected pay is missing - the Salary missing filter's count
      salaryMissing: kind === 'internal' ? all.filter((r) => rowMatches(r, { ...qq, salaryMissing: '' }, ctx) && r.salaryMissing && (r.profileStatus === 'Archived') === (sub === 'archived')).length : null,
    },
    definitions: {
      inactive: `Inactive — no application activity (applied, stage move, screening step, note, call, message or follow-up) in the last ${days} days; a person with no application counts from the day their profile was added.`,
    },
  });
}

// The People list's facet counts for Source: counted over the SAME person rows the list shows (every other
// filter on, the Source filter off), so each option's number equals what picking it would list.
async function masterSourceFacet(user, q) {
  const sub = MASTER_SUBS.includes(String(q.sub || '').toLowerCase()) ? String(q.sub).toLowerCase() : 'all';
  const att = hasPersonQuery(q) ? await attributedApplications(user, q) : null;
  const ctx = { search: String(q.search || '').trim().toLowerCase(), personIds: att ? att.ids : null };
  const all = await pagedRowsFor(user);
  const qq = { ...q, stage: '', followUp: '', source: '' };
  const days = inactiveDaysOf(q);
  const cutoff = Date.now() - days * 86400000;
  const snap = sub === 'inactive' ? await ensureNextActionContext() : null;
  const counts = new Map();
  let total = 0;
  const own = { ...q, stage: '', followUp: '' };
  all.forEach((r) => {
    if (!rowMatches(r, qq, ctx)) return;
    if ((r.profileStatus === 'Archived') !== (sub === 'archived')) return;
    if (sub === 'inactive') {
      const last = lastApplicationActivity(r, snap);
      if (last && last >= cutoff) return;
    }
    counts.set(r.sourceKey, (counts.get(r.sourceKey) || 0) + 1);
    if (!own.source || sourceSetOf(own.source).has(r.sourceKey)) total += 1;
  });
  return { counts, total };
}

// THE SOURCES TAB (routes/candidateSources.js) counts exactly the rows the People list (All people) shows for the same filters:
// the same decorated rows, the same scope, the same matcher. `skip` blanks some filters (for the cascading option counts); the
// person filters (recruiter / TL / BDE) are looked up once per distinct combination.
async function peopleFor(user, q, skip = [], personCache = new Map()) {
  const qq = { ...q, stage: '', followUp: '' };
  skip.forEach((k) => { qq[k] = ''; });
  let ids = null;
  if (hasPersonQuery(qq)) {
    const key = JSON.stringify([qq.recruiter, qq.tl, qq.bde, qq.positionCode]);
    if (!personCache.has(key)) personCache.set(key, attributedApplications(user, qq).then((a) => (a ? a.ids : null)));
    ids = await personCache.get(key);
  }
  const ctx = { search: String(qq.search || '').trim().toLowerCase(), personIds: ids };
  const all = await pagedRowsFor(user);
  return { all, rows: all.filter((r) => r.profileStatus !== 'Archived' && rowMatches(r, qq, ctx)) };
}

async function pagedList(req, res) {
  const { view, sub } = normaliseViewSub(req.query.view, req.query.sub);
  if (view === 'master') return masterList(req, res, sub);
  return pipelineList(req, res, sub);
}

router.get('/', async (req, res, next) => {
  if (req.query.paged !== '1') return next();
  try {
    return await pagedList(req, res);
  } catch (err) {
    return next(err);
  }
});

router.get('/', async (req, res) => {
  // Nobody browses the whole candidate master except a global role. A client
  // sees only people SHARED with them on their own requirements; a recruiter
  // only people on requirements assigned to them; a TL only their department's.
  // BY THE PERSON WHO DID THE WORK (or the seat it was done from), login or
  // not: ?recruiter= / ?tl= / ?bde= take "id:<userId>" or "name:<name>", and
  // ?positionCode= a seat. Attribution is utils/workers.js's — the same rule
  // ATS Reports counts with — so a former recruiter's candidates are found by
  // the name their work is recorded under.
  const att = hasPersonQuery(req.query) ? await attributedApplications(req.user, req.query) : null;
  const scoped = await scopedCandidates(req.user, att ? [...new Set(att.apps.map((a) => a.candidateId))] : null);
  const { sharedIds } = scoped;
  let { candidates } = scoped;
  if (att) {
    candidates = candidates.filter((c) => visibleApplications(req.user, c.applications, sharedIds)
      .some((a) => att.ids.has(a.id)));
  }
  // followup_: one query for every visible application's current follow-up,
  // so the Follow-up column is real data rather than an em dash.
  const followUps = await currentFollowUpsByApplication(
    candidates.flatMap((c) => visibleApplications(req.user, c.applications, sharedIds).map((a) => a.id)),
  );
  let rows = candidates.map((c) => decorate(c, { user: req.user, sharedIds, followUps }));
  // Hold and Rejected are VIEWS over this same list, not separate modules —
  // so the server offers them as a query parameter on the one endpoint.
  if (req.query.view && req.query.view !== 'all') {
    rows = rows.filter((r) => matchesView(req.query.view, r.currentStage));
  }
  if (req.query.stageGroup) {
    rows = rows.filter((r) => r.stageGroup === req.query.stageGroup);
  }
  // followup_: the dashboard's "Follow-ups Due" and "Overdue Follow-ups" rows
  // link here. "Not set" is a real value — an application nobody has committed
  // a follow-up on yet is exactly the thing a lead wants to find.
  if (req.query.followUp) {
    const wanted = String(req.query.followUp).split(',').map((x) => x.trim()).filter(Boolean);
    rows = rows.filter((r) => wanted.includes(r.followUp ? r.followUp.status : 'Not set'));
  }
  if (isInternalViewer(req.user)) await attachRejections(rows);
  return res.json(rows.map(slimForList));
});

// THE LIST DOES NOT NEED THE WHOLE OBJECT GRAPH.
//
// Every candidate carried its full applications array, and every application
// its whole requirement AND that requirement's whole client — so the real data
// turned this endpoint into a 68 MB response that took eleven seconds to build
// and left the browser to parse all of it before drawing twenty-five rows.
//
// The list screen reads exactly six things off an application: the requirement
// id, its department, its client id, its TL, its recruiter's name and its
// BDE's name — that is what the filter row filters on. Everything else it
// needs already sits on the decorated candidate (requirementTitle, clientName,
// currentStage, followUp). So the list sends those six and nothing more.
//
// The DETAIL endpoint is untouched and still returns the full shape: that
// screen genuinely shows an application's detail, and it fetches one candidate.
// The candidate fields the LIST screen actually reads — its columns, its
// filter row and its view tabs, and nothing else. A candidate row has sixty
// columns (bank details, education, three kinds of skills, resume scores,
// source campaigns) and the list shows a dozen; sending all sixty for 16,493
// people is 32 MB of payload to draw twenty-five rows.
const LIST_FIELDS = [
  'id', 'name', 'email', 'phone', 'location', 'source', 'sourceKey', 'sourceRaw', 'skills',
  'lifeStatus', 'currentStage', 'currentStageLabel', 'stageGroup',
  'stageGroupLabel', 'stageDetailLabel', 'requirementTitle', 'requirementId',
  'clientName', 'clientId', 'owner', 'nextAction', 'dueDate', 'overdue',
  'followUp', 'followUpNeed', 'createdAt',
  // Who worked it: recruiter, seat (MED-1 …) and TL.
  'recruiterName', 'positionCode', 'tlName',
  // Why a rejected candidate was rejected, and whose decision it was.
  'rejection',
  // B7: { name, until } when a partner owns this person.
  'partner',
];

function slimForList(row) {
  const applications = (row.applications || []).map((a) => ({
    id: a.id,
    requirementId: a.requirementId,
    stage: a.stage,
    createdAt: a.createdAt,
    requirement: a.requirement
      ? {
        id: a.requirement.id,
        title: a.requirement.title,
        clientName: a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || null,
        department: a.requirement.department,
        clientId: a.requirement.clientId,
        tl: a.requirement.tl,
        recruiter: (() => { const o = require('../utils/applicationOwner').ownerRecruiter(a); return o ? { name: o.name } : null; })(), // eslint-disable-line global-require
        bde: a.requirement.bde ? { name: a.requirement.bde.name } : null,
      }
      : null,
  }));
  const out = { applications };
  LIST_FIELDS.forEach((f) => { if (row[f] !== undefined) out[f] = row[f]; });
  return out;
}

// The visible pipeline and the views, served from the same definition the
// server filters with, so the screen cannot drift from the rules.
// The ONE clean source list every picker and filter offers (utils/candidateSource.js).
// THE NEW BUTTON'S NUMBERS: people added in the last 7 days that this login may see, and how many of them are not on any requirement yet.
// Light: reads the in-memory working set, and looks only at the few people added this week. Must stay above /:id.
router.get('/new-summary', async (req, res, next) => {
  try {
    const st = await getListState();
    const s = scopeOf(req.user);
    const mine = s.global ? null : await ADDED.idsOf(req.user.id);
    const recent = st.candidates.filter(isNewRow);
    let people = 0; let unplaced = 0; let today = 0;
    const todayIst = istDay(new Date());
    recent.forEach((c) => {
      const apps = c.applications || [];
      const reach = s.global || (mine && mine.has(c.id)) || apps.some((a) => a.requirement && applicationInScope(req.user, a));
      if (!reach) return;
      people += 1;
      if (!apps.length) unplaced += 1;
      if (istDay(c.createdAt) === todayIst) today += 1;
    });
    return res.set('Cache-Control', 'no-store').json({ days: NEW_DAYS, people, unplaced, today });
  } catch (err) { return next(err); }
});

router.get('/source-options', (req, res) => {
  res.json({ pick: CS.PICKER_SOURCES, all: CS.SOURCES, imported: CS.IMPORTED, other: CS.OTHER });
});

// The Sources tab: where people came from and when (counts only; routes/candidateSources.js). Must stay above /:id.
router.use('/sources', require('./candidateSources'));

router.get('/pipeline-view', (req, res) => {
  res.json({ groups: groupsWithDetail(), views: CANDIDATE_VIEWS });
});

// CANDIDATE PICKER (type + dropdown, for every "Add application" box): a light search, never the whole master.
// ?q= name / CAN-code / phone digits / email (a BDE-team login: name and code only - no phone, no email),
// ?requirementId= marks the people already on that job ("onJob") instead of hiding them. Scoped like the list. At most 20.
// Must stay above /:id.
router.get('/picker', async (req, res, next) => {
  try {
    const { candidateWhere } = require('../utils/scope'); // eslint-disable-line global-require
    const q = String(req.query.q || '').trim();
    const bde = require('../utils/clientLifecycle').isBdeTeam(req.user); // eslint-disable-line global-require
    const digits = q.replace(/\D/g, '');
    const bare = q.replace(/^(id|can|cand|cl)[-\s#:]*/i, '');
    const idLike = /^[a-z0-9]{4,}$/i.test(bare) ? bare.toLowerCase() : '';
    const arms = [{ name: { contains: q } }];
    if (idLike) arms.push({ id: { endsWith: idLike } });
    if (!bde) {
      arms.push({ email: { contains: q } });
      // a phone is found by its LAST digits (what people remember), or by the whole number
      if (digits.length >= 4) arms.push({ phone: { endsWith: digits.slice(-10) } });
      if (digits.length >= 7) arms.push({ phone: { contains: digits.slice(-10) } });
    }
    const mineIds = [...(await ADDED.idsOf(req.user.id))].slice(-500); // people this login added and has not put on a requirement yet
    const reach = mineIds.length ? { OR: [candidateWhere(req.user), { id: { in: mineIds } }] } : candidateWhere(req.user);
    const where = { AND: [reach, ...(q ? [{ OR: arms }] : [])] };
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
    const rows = await prisma.candidate.findMany({
      where: ids.length ? { AND: [reach, { id: { in: ids } }] } : where,
      select: { id: true, name: true, location: true, experienceYears: true, phone: true, currentDesignation: true },
      orderBy: q ? { name: 'asc' } : { createdAt: 'desc' },
      take: 20,
    });
    let onJob = new Map();
    const requirementId = String(req.query.requirementId || '');
    if (requirementId && rows.length) {
      const apps = await prisma.application.findMany({ where: { requirementId, candidateId: { in: rows.map((r) => r.id) } }, select: { id: true, candidateId: true, stage: true, requirement: { select: { internal: true } } } });
      onJob = new Map(apps.map((a) => [a.candidateId, { applicationId: a.id, step: stageLabelFor(a.stage, { internal: !!(a.requirement && a.requirement.internal) }), link: `/candidates/${a.candidateId}?application=${a.id}` }]));
    }
    return res.json({
      rows: rows.map((c) => ({
        id: c.id,
        code: candidateCode(c.id),
        name: c.name,
        location: c.location || null,
        experienceYears: c.experienceYears,
        designation: c.currentDesignation || null,
        ...(bde ? {} : { phoneTail: c.phone ? String(c.phone).replace(/\D/g, '').slice(-4) : null }),
        onJob: onJob.get(c.id) || null,
      })),
    });
  } catch (err) { return next(err); }
});

// Must stay above /:id so "check-duplicate" isn't read as a candidate id.
// spec #2 §12: `matches` are phone / email hits (a real duplicate — the save
// is refused without an explicit "Create New Profile"); `possible` are
// name-only hints, shown but never blocking.
router.get('/check-duplicate', async (req, res, next) => {
  try {
    if (!isInternalViewer(req.user)) return res.status(403).json({ error: 'Not available to this login' });
    const found = await duplicateMatches(req.user, {
      email: String(req.query.email || '').trim(),
      phone: String(req.query.phone || '').trim(),
      name: String(req.query.name || '').trim(),
      excludeId: req.query.excludeId || null,
    });
    const matches = found.filter((m) => m.strength === 'strong');
    return res.json({ duplicate: matches.length > 0, matches, possible: found.filter((m) => m.strength !== 'strong') });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// EXISTING DUPLICATES — Candidates > Duplicates (Super Admin / Admin only).
//
// Groups of candidates sharing a phone or an email ("contact" groups), and a
// separate list of name-only hints whose contact details do not contradict
// ("name" groups — never merged without an extra confirmation). Nothing is
// merged here without a person choosing the master and confirming the group;
// the merge itself is utils/candidateDedupe.js mergeCandidates().
// ---------------------------------------------------------------------------
const DUP_ADMIN = ['SUPER_ADMIN', 'ADMIN'];
const isDupAdmin = (u) => !!u && (DUP_ADMIN.includes(u.role) || DUP_ADMIN.includes(roleForProduct(u, 'ats')));
function requireDupAdmin(req, res, next) {
  if (!isDupAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can review duplicate candidates' });
  return next();
}
let GROUP_MEMO = { version: null, groups: null };
async function duplicateGroups() {
  const st = await getListState();
  if (GROUP_MEMO.version === st.version && GROUP_MEMO.pool === st.candidates) return { st, groups: GROUP_MEMO.groups };
  const groups = computeGroups(st.candidates);
  GROUP_MEMO = { version: st.version, pool: st.candidates, groups };
  return { st, groups };
}

// KEEP SEPARATE (user spec 2026-09-29 §10): an authorised person decides a
// suggested group is NOT one person. The decision is an AuditLog row (no
// schema change) — entity 'CandidateDuplicate', entityId = the group id,
// toValue = the sorted member ids — and a group whose members are all inside
// a kept-separate decision is no longer suggested. A later "undo" row (same
// member set) brings it back. Nothing is merged or deleted either way; a
// group that gains a NEW member is suggested again (new information).
const dupIds = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
const KEEP_SEPARATE = 'Duplicate kept separate';
const KEEP_UNDONE = 'Duplicate separation undone';
let KEEP_MEMO = { at: 0, sets: [] };
async function keptSeparateSets() {
  if (Date.now() - KEEP_MEMO.at < 10000) return KEEP_MEMO.sets;
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'CandidateDuplicate', action: { in: [KEEP_SEPARATE, KEEP_UNDONE] } },
    orderBy: { createdAt: 'asc' },
    select: { action: true, toValue: true, entityId: true, createdAt: true, actorName: true, reason: true, userId: true },
  });
  const latest = new Map();
  rows.forEach((r) => { if (r.toValue) latest.set(r.toValue, r); });
  const sets = [];
  latest.forEach((r) => {
    if (r.action !== KEEP_SEPARATE) return;
    let ids = [];
    try { ids = JSON.parse(r.toValue); } catch { ids = []; }
    if (Array.isArray(ids) && ids.length > 1) sets.push({ key: r.toValue, ids: new Set(ids), memberIds: ids, at: r.createdAt, by: r.actorName, reason: r.reason });
  });
  KEEP_MEMO = { at: Date.now(), sets };
  return sets;
}
async function visibleDuplicateGroups() {
  const { st, groups } = await duplicateGroups();
  const sets = await keptSeparateSets();
  if (!sets.length) return { st, groups, keptSeparate: 0 };
  const hidden = (g) => sets.some((k) => g.memberIds.every((id) => k.ids.has(id)));
  return {
    st,
    groups: { contact: groups.contact.filter((g) => !hidden(g)), name: groups.name.filter((g) => !hidden(g)) },
    keptSeparate: sets.length,
  };
}

router.post('/duplicates/keep-separate', requireDupAdmin, async (req, res, next) => {
  try {
    const ids = dupIds((req.body || {}).memberIds).sort();
    if (ids.length < 2) return res.status(400).json({ error: 'Pick the records to keep separate (at least two).' });
    const { groups } = await duplicateGroups();
    const inOne = [...groups.contact, ...groups.name].some((g) => ids.every((id) => g.memberIds.includes(id)));
    if (!inOne) return res.status(400).json({ error: 'These records are not a suggested duplicate group — nothing was recorded.' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 500) || 'Reviewed — different people';
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name,
      action: KEEP_SEPARATE,
      entity: 'CandidateDuplicate',
      entityId: String((req.body || {}).groupId || ids.join('|')).slice(0, 190),
      toValue: JSON.stringify(ids),
      reason,
    });
    KEEP_MEMO = { at: 0, sets: [] };
    return res.json({ ok: true, memberIds: ids, reason });
  } catch (err) { return next(err); }
});

router.post('/duplicates/keep-separate/undo', requireDupAdmin, async (req, res, next) => {
  try {
    const ids = dupIds((req.body || {}).memberIds).sort();
    const sets = await keptSeparateSets();
    const key = JSON.stringify(ids);
    if (!sets.some((k) => k.key === key)) return res.status(404).json({ error: 'No keep-separate decision for exactly these records.' });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: KEEP_UNDONE, entity: 'CandidateDuplicate',
      entityId: ids.join('|').slice(0, 190), toValue: key, reason: 'Suggested again',
    });
    KEEP_MEMO = { at: 0, sets: [] };
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.get('/duplicates/kept-separate', requireDupAdmin, async (req, res, next) => {
  try {
    const sets = await keptSeparateSets();
    const ids = [...new Set(sets.flatMap((k) => k.memberIds))];
    const names = new Map((ids.length ? await prisma.candidate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
    return res.json({
      decisions: sets.slice().reverse().slice(0, 200).map((k) => ({
        memberIds: k.memberIds, names: k.memberIds.map((id) => names.get(id) || '(merged / removed)'), at: k.at, by: k.by, reason: k.reason,
      })),
    });
  } catch (err) { return next(err); }
});

router.get('/duplicates/summary', requireDupAdmin, async (req, res, next) => {
  try {
    const { groups, keptSeparate } = await visibleDuplicateGroups();
    const members = (gs) => gs.reduce((n, g) => n + g.memberIds.length, 0);
    return res.json({
      contact: {
        groups: groups.contact.length,
        records: members(groups.contact),
        removable: members(groups.contact) - groups.contact.length,
        byPhone: groups.contact.filter((g) => g.sharedPhones.length).length,
        byEmail: groups.contact.filter((g) => g.sharedEmails.length).length,
        sameName: groups.contact.filter((g) => g.nameAgreement === 'same').length,
        nameVariant: groups.contact.filter((g) => g.nameAgreement === 'variant').length,
        nameDifferent: groups.contact.filter((g) => g.nameAgreement === 'different').length,
      },
      name: { groups: groups.name.length, records: members(groups.name) },
      keptSeparate,
    });
  } catch (err) { return next(err); }
});

// One page of groups, each member with its applications and what hangs off it.
router.get('/duplicates/groups', requireDupAdmin, async (req, res, next) => {
  try {
    const { st, groups } = await visibleDuplicateGroups();
    const kind = req.query.kind === 'name' ? 'name' : 'contact';
    let list = groups[kind];
    const agreement = String(req.query.agreement || '');
    if (kind === 'contact' && ['same', 'variant', 'different'].includes(agreement)) list = list.filter((g) => g.nameAgreement === agreement);
    // ?matchedBy=phone|email (2026-09-29, list standard) — contact groups that
    // share a phone / an email. Only narrows.
    const matchedBy = String(req.query.matchedBy || '');
    if (kind === 'contact' && matchedBy === 'phone') list = list.filter((g) => (g.sharedPhones || []).length > 0);
    if (kind === 'contact' && matchedBy === 'email') list = list.filter((g) => (g.sharedEmails || []).length > 0);
    const q = String(req.query.search || '').trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, '');
      list = list.filter((g) => g.memberIds.some((id) => {
        const c = st.byId.get(id);
        return c && (String(c.name || '').toLowerCase().includes(q) || String(c.email || '').toLowerCase().includes(q)
          || (digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits)));
      }));
    }
    // ?sort=size — the biggest groups (most records) first; default: as detected.
    if (req.query.sort === 'size') list = [...list].sort((a, b) => b.memberIds.length - a.memberIds.length);
    // Up to 100 per page (the shared pager offers 25 / 50 / 100); default 20.
    const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages);
    const slice = list.slice((page - 1) * pageSize, page * pageSize);
    const ids = [...new Set(slice.flatMap((g) => g.memberIds))];
    const [rows, notes, docs, msgs] = ids.length ? await Promise.all([
      prisma.candidate.findMany({
        where: { id: { in: ids } },
        include: {
          applications: {
            select: {
              id: true, requirementId: true, stage: true, createdAt: true, updatedAt: true,
              requirement: { select: { title: true, internal: true, department: true, client: { select: { name: true } } } },
            },
          },
        },
      }),
      prisma.candidateNote.groupBy({ by: ['candidateId'], where: { candidateId: { in: ids } }, _count: { _all: true } }),
      prisma.candidateDocument.groupBy({ by: ['candidateId'], where: { candidateId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
      prisma.candidateMessage.groupBy({ by: ['candidateId'], where: { candidateId: { in: ids } }, _count: { _all: true } }),
    ]) : [[], [], [], []];
    const cnt = (arr) => new Map(arr.map((r) => [r.candidateId, r._count._all]));
    const [nN, dN, mN] = [cnt(notes), cnt(docs), cnt(msgs)];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const filledCount = (c) => ['email', 'phone', 'skills', 'location', 'experienceYears', 'currentCompany', 'education', 'resumeName']
      .filter((f) => c[f] !== null && c[f] !== undefined && String(c[f]).trim() !== '').length;
    const out = slice.map((g) => {
      const members = g.memberIds.map((id) => byId.get(id)).filter(Boolean).map((c) => {
        const best = c.applications.reduce((m, a) => (!m || appRank(a) > appRank(m) ? a : m), null);
        return {
          id: c.id, name: c.name, email: c.email, phone: c.phone, location: c.location, source: c.source,
          externalRef: c.externalRef, createdAt: c.createdAt, experienceYears: c.experienceYears, filled: filledCount(c),
          nameKey: nameKey(c.name),
          notes: nN.get(c.id) || 0, documents: dN.get(c.id) || 0, messages: mN.get(c.id) || 0,
          bestRank: best ? appRank(best) : -99,
          applications: c.applications
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map((a) => ({
              id: a.id, requirementId: a.requirementId, stage: a.stage, stageLabel: stageLabel(a.stage), createdAt: a.createdAt,
              requirementTitle: a.requirement ? a.requirement.title : null,
              clientName: a.requirement ? (a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || null) : null,
              department: a.requirement ? a.requirement.department : null,
            })),
        };
      });
      // Suggested master: the furthest application, then the most complete
      // profile, then the oldest record. Only a suggestion — the admin picks.
      const suggested = members.slice().sort((a, b) => (b.bestRank - a.bestRank)
        || (b.applications.length - a.applications.length) || (b.filled - a.filled)
        || (new Date(a.createdAt) - new Date(b.createdAt)))[0];
      const reqCount = new Map();
      members.forEach((m) => m.applications.forEach((a) => reqCount.set(a.requirementId, (reqCount.get(a.requirementId) || 0) + 1)));
      return {
        ...g,
        members,
        suggestedMasterId: suggested ? suggested.id : null,
        sameRequirement: [...reqCount.values()].filter((n) => n > 1).length,
      };
    });
    return res.json({ kind, total: list.length, page, pages, pageSize, groups: out });
  } catch (err) { return next(err); }
});

router.post('/duplicates/preview', requireDupAdmin, async (req, res, next) => {
  try {
    return res.json(await previewMerge({ masterId: String((req.body || {}).masterId || ''), donorIds: dupIds((req.body || {}).donorIds) }));
  } catch (err) {
    if (err instanceof MergeError) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// One merge at a time across the app.
let mergeBusy = false;
router.post('/duplicates/merge', requireDupAdmin, async (req, res, next) => {
  const b = req.body || {};
  if (b.confirm !== true) return res.status(400).json({ error: 'Confirm the merge (confirm: true) — nothing was changed.' });
  const masterId = String(b.masterId || '');
  const donorIds = dupIds(b.donorIds);
  if (mergeBusy) return res.status(409).json({ error: 'Another merge is running — try again in a moment.' });
  mergeBusy = true;
  try {
    // Every record must still share a phone or an email with the group —
    // unless the admin explicitly confirmed a name-only group.
    const { groups } = await duplicateGroups();
    const all = [masterId, ...donorIds];
    const inOne = (gs) => gs.some((g) => all.every((id) => g.memberIds.includes(id)));
    if (!inOne(groups.contact) && !(b.nameOnlyConfirmed === true && inOne(groups.name))) {
      return res.status(400).json({
        error: 'These records do not share a phone or email. A name-only group needs the extra confirmation — nothing was changed.',
      });
    }
    const result = await mergeCandidates({ masterId, donorIds, user: req.user });
    markCandidateDirty(masterId);
    return res.json(result);
  } catch (err) {
    if (err instanceof MergeError) return res.status(err.status).json({ error: err.message });
    return next(err);
  } finally {
    mergeBusy = false;
  }
});

// ---------------------------------------------------------------------------
// Source analytics.
//
// Per source: Total, Screened, Shortlisted, Client Shared, Interviewed,
// Selected, Rejected, Joined. Counted per CANDIDATE (not per application) on
// the furthest point they ever reached, which is why it needs the pipeline
// history and not just the current stage: someone sitting at Rejected today
// was still screened and still shared with a client.
// ---------------------------------------------------------------------------
const REACH_COLUMNS = [
  { key: 'screened', label: 'Screened', stage: 'RECRUITER_REVIEW' },
  { key: 'shortlisted', label: 'Shortlisted', stage: 'RECRUITER_APPROVED' },
  { key: 'clientShared', label: 'Client Shared', stage: 'SHARED_WITH_CLIENT' },
  { key: 'interviewed', label: 'Interviewed', stage: 'INTERVIEW_SCHEDULED' },
  { key: 'selected', label: 'Selected', stage: 'SELECTED' },
  { key: 'joined', label: 'Joined', stage: 'JOINED' },
];

// ---------------------------------------------------------------------------
// TL "RETURN →" (review #3 §16) — POST /candidates/applications/:id/return
//
// A candidate sitting in TL Review goes BACK to Recruiter Review, with the
// reason the TL gives. Not a new pipeline path: it runs through the one stage
// move (routes/applications.js applyStageMove — access, ownership, scope,
// stage event, notifications and its own audit row), after two checks of its
// own:
//   * only a lead may return — TL / STL (Manager / Asst Manager pass here and
//     are then refused by the engine's view-only rule), or Super Admin / Admin;
//     a recruiter or BDE is refused
//   * the application must be AT TL Review, and a reason is required
// A second audit row, "Candidate returned to recruiter", carries the reason so
// the return is findable on its own.
// ---------------------------------------------------------------------------
const RETURN_ROLES = ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'];
function mayReturnToRecruiter(user) {
  // eslint-disable-next-line global-require
  const { stageGlobal } = require('../utils/permissions');
  if (stageGlobal(user)) return true;
  const alias = user && user.scopeRoles && user.scopeRoles.ats;
  const role = alias && alias !== 'NONE' ? alias : roleForProduct(user, 'ats');
  return RETURN_ROLES.includes(role);
}
router.post('/applications/:applicationId/return', async (req, res, next) => {
  try {
    if (!mayReturnToRecruiter(req.user)) {
      return res.status(403).json({ error: 'Only the TL (or a lead above them) can return a candidate to the recruiter.' });
    }
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Say why the candidate is being returned.' });
    const app = await prisma.application.findUnique({
      where: { id: req.params.applicationId },
      include: { requirement: true },
    });
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (!applicationInScope(req.user, app)) return res.status(403).json(OUT_OF_SCOPE);
    if (app.stage !== 'TL_REVIEW') {
      return res.status(409).json({ error: `Only a candidate in TL Review can be returned — this one is at ${stageLabel(app.stage)}.` });
    }
    // eslint-disable-next-line global-require
    const { applyStageMove } = require('./applications');
    const out = await applyStageMove(req.user, app.id, {
      stage: 'RECRUITER_REVIEW',
      comment: `Returned by TL — ${reason.slice(0, 500)}`,
      reasonCategory: 'Returned by TL',
      reasonDetail: reason.slice(0, 1000),
    });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    await logAudit({
      userId: req.user.id,
      action: 'Candidate returned to recruiter',
      entity: 'Application',
      entityId: app.id,
      fromValue: 'TL_REVIEW',
      toValue: 'RECRUITER_REVIEW',
      reason: reason.slice(0, 1000),
    });
    return res.json({ ok: true, application: out.body });
  } catch (err) {
    return next(err);
  }
});

// PERF (Batch 1): this used to load every candidate with every application and job from the
// database (30 MB) and every stage event row of them, for EVERY open (48-91 s). Now it reads the
// working set the list already keeps in memory, the furthest step per application with ONE
// GROUP BY (kept per data version), and keeps each login's answer for as long as nothing changed.
let REACH = { key: null, at: 0, map: null };
let reachBuild = null;
async function reachedMap(version) {
  if (REACH.map && REACH.key === version && Date.now() - REACH.at < ROW_MEMO_TTL_MS) return REACH.map;
  if (reachBuild && reachBuild.key === version) return reachBuild.promise;
  const promise = (async () => {
    const pairs = await prisma.applicationStageEvent.groupBy({ by: ['applicationId', 'toStage'] });
    const map = new Map();
    pairs.forEach((e) => {
      const best = Math.max(map.get(e.applicationId) ?? -1, stageIndex(e.toStage));
      map.set(e.applicationId, best);
    });
    REACH = { key: version, at: Date.now(), map };
    return map;
  })().finally(() => { if (reachBuild && reachBuild.key === version) reachBuild = null; });
  reachBuild = { key: version, promise };
  return promise;
}
const SRC_MEMO = new Map();
router.get('/source-analytics', async (req, res) => {
  const st = await getListState();
  const sc = scopeOf(req.user);
  const memoKey = [req.user.id, st.version, istDay(new Date()), scopeSig(sc)].join('|');
  const memoHit = memoGet(SRC_MEMO, req.user.id, memoKey);
  if (memoHit) return res.json(memoHit.out);
  // The same people the list shows this login (utils/candidateListCache.js holds them all).
  let candidates = st.candidates;
  let sharedIds = null;
  if (sc.role === 'CANDIDATE') candidates = candidates.filter((c) => c.id === sc.candidateId);
  else if (!sc.global) {
    candidates = candidates.filter((c) => c.applications.some((a) => a.requirement && applicationInScope(req.user, a)));
    sharedIds = await clientSharedApplicationIds(req.user, candidates);
    if (sharedIds) candidates = candidates.filter((c) => visibleApplications(req.user, c.applications, sharedIds).length > 0);
  }
  const reachedByApp = await reachedMap(st.version);

  const by = new Map();
  const bucket = (name) => {
    if (!by.has(name)) {
      by.set(name, {
        source: name, total: 0, screened: 0, shortlisted: 0, clientShared: 0,
        interviewed: 0, selected: 0, rejected: 0, joined: 0,
      });
    }
    return by.get(name);
  };

  candidates.forEach((c) => {
    const apps = visibleApplications(req.user, c.applications, sharedIds);
    const row = bucket(CS.sourceOfPerson(c, null).key);
    row.total += 1;
    // The furthest point this candidate ever reached, across every application
    // of theirs this login can see: current stage, or anything in the history.
    let furthest = -1;
    let everRejected = false;
    apps.forEach((a) => {
      furthest = Math.max(furthest, stageIndex(a.stage), reachedByApp.get(a.id) ?? -1);
      if (a.stage === 'REJECTED') everRejected = true;
    });
    REACH_COLUMNS.forEach((col) => {
      if (furthest >= stageIndex(col.stage)) row[col.key] += 1;
    });
    if (everRejected) row.rejected += 1;
  });

  const out = {
    columns: REACH_COLUMNS.map((c) => ({ key: c.key, label: c.label, stage: c.stage })),
    rows: [...by.values()].sort((a, b) => b.total - a.total),
    note: 'Counts are per candidate and cumulative — someone who reached a later stage is '
      + 'counted at every earlier one, including if they were later rejected. "Interviewed" '
      + 'means the candidate reached Interview Scheduled or beyond.',
  };
  memoPut(SRC_MEMO, req.user.id, { key: memoKey, at: Date.now(), out });
  res.json(out);
});

// Load a candidate and apply scope. Returns [candidate, decorated] or sends the
// refusal itself and returns null — one place, so every sub-route below refuses
// identically.
async function loadInScope(req, res) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: req.params.id },
    // client.status: the Candidate 360 "Client paused" warning (spec 2026-10-03 §A).
    include: { applications: { include: { requirement: { include: { client: { select: { id: true, name: true, status: true } }, recruiter: { select: { id: true, name: true } }, bde: { select: { id: true, name: true } } } } } } },
  });
  if (!candidate) {
    // dup_: a profile that was merged away still opens the one it was merged into (old links keep working).
    const keptId = req.aliasFrom ? null : await require('../utils/candidateDupes').resolveAlias(req.params.id); // eslint-disable-line global-require
    if (keptId) { req.aliasFrom = req.params.id; req.params.id = keptId; return loadInScope(req, res); }
    res.status(404).json({ error: 'Candidate not found' });
    return null;
  }
  // each application's own recruiter (who added / works it) by name: the profile says "Recruiter: <owner>", never the
  // requirement's main recruiter (founder 2026-10-29)
  {
    const ownIds = [...new Set((candidate.applications || []).map((a) => a.ownerRecruiterId).filter(Boolean))];
    const names = ownIds.length ? new Map((await prisma.user.findMany({ where: { id: { in: ownIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])) : new Map();
    (candidate.applications || []).forEach((a) => { a.ownerRecruiterName = names.get(a.ownerRecruiterId) || null; });
  }
  const s = scopeOf(req.user);
  const sharedIds = await clientSharedApplicationIds(req.user, [candidate]);
  const followUps = await currentFollowUpsByApplication(
    visibleApplications(req.user, candidate.applications, sharedIds).map((a) => a.id),
  );
  const decorated = decorate(candidate, { user: req.user, sharedIds, followUps, withAppSource: true });
  // Server-side scope. A candidate login reaches exactly one record — its own.
  // Everyone else reaches a candidate only through an application on a
  // requirement their scope covers; no such application means refused, not
  // rendered empty.
  if (s.role === 'CANDIDATE') {
    if (candidate.id !== s.candidateId) {
      res.status(403).json(OUT_OF_SCOPE);
      return null;
    }
  } else if (!s.global && decorated.applications.length === 0 && !(await ADDED.addedBy(req.user.id, candidate.id))) {
    res.status(403).json(OUT_OF_SCOPE);
    return null;
  }
  return { candidate, decorated, sharedIds, followUps };
}

// --- AI Match --------------------------------------------------------------
// Fed entirely by the existing engine in utils/matching.js — there is no second
// scorer in this file. The framing matters as much as the number: AI output is
// SUPPORTING INFORMATION for a human recruiter, never an automatic decision, so
// the payload carries that statement and a "recommendation" that is explicitly
// advisory. A CLIENT login never receives this object at all.
function recommendationFor(overall) {
  if (overall >= 85) return 'Strong match on the scored signals — worth a recruiter screen.';
  if (overall >= 70) return 'Good match — a recruiter should confirm the gaps listed below.';
  if (overall >= 50) return 'Partial match — screen carefully against the gaps.';
  return 'Weak match on the scored signals — a recruiter may still decide otherwise.';
}

// A THIN PROFILE has no skills, no experience and no resume: there is nothing to score, so the
// panel says so instead of showing a verdict ("Good match") built from empty fields. Only what
// is SHOWN changes; the stored scores are not touched (Batch 1, 2026-10-10).
const hasText = (v) => String(v == null ? '' : v).trim().length > 0;
function isThinProfile(c) {
  return !hasText(c.skills) && !hasText(c.technicalSkills) && !hasText(c.goodToHaveSkills)
    && !(Number(c.experienceYears) > 0) && !(Number(c.relevantExperienceYears) > 0)
    && !hasText(c.resumeName);
}
const THIN_TEXT = 'Not enough details to score. Add skills, experience or a resume to see the fit.';

function aiMatchFor(candidate, application, restricted = false) {
  const requirement = application && application.requirement;
  if (!requirement) return null;
  const m = computeMatch(candidate, requirement);
  // 2026-10-13: the Fit breakdown (Resume · AI · Location · Salary). A login without the Candidate contact & salary
  // switch gets a rounded total, a label and the Salary word only (utils/fitBreakdown.js).
  const breakdown = FB.breakdownOf(m, restricted);
  if (isThinProfile(candidate)) {
    return {
      requirementId: requirement.id,
      requirementTitle: requirement.title,
      overall: null,
      thin: true,
      matchedSkills: [], missingSkills: [], goodMatched: [], goodMissing: [],
      experienceMatch: null, educationMatch: null, locationMatch: null, salaryMatch: null, noticeMatch: null,
      breakdown: null,
      reasons: [], gaps: [],
      recommendation: THIN_TEXT,
      advisory: 'AI match is supporting information for a human recruiter. It does not screen, '
        + 'shortlist or reject anyone — every stage change in this pipeline is made by a named person '
        + 'and recorded in Pipeline History.',
    };
  }
  if (restricted) {
    return {
      requirementId: requirement.id,
      requirementTitle: requirement.title,
      overall: breakdown.total,
      approx: true,
      label: breakdown.label,
      matchedSkills: m.matchedSkills,
      missingSkills: m.missingSkills,
      salaryMatch: { percent: null, word: FB.salaryWord(m), reason: FB.salaryWord(m) },
      breakdown,
      recommendation: recommendationFor(breakdown.total),
      advisory: 'AI match is supporting information for a human recruiter. It does not screen, '
        + 'shortlist or reject anyone — every stage change in this pipeline is made by a named person '
        + 'and recorded in Pipeline History.',
    };
  }
  return {
    requirementId: requirement.id,
    requirementTitle: requirement.title,
    overall: m.overall,
    breakdown,
    matchedSkills: m.matchedSkills,
    missingSkills: m.missingSkills,
    goodMatched: m.goodMatched,
    goodMissing: m.goodMissing,
    experienceMatch: { percent: m.expPct, reason: m.expReason, relevantPercent: m.relevPct, relevantReason: m.relevReason },
    educationMatch: { percent: m.eduPct, reason: m.eduReason },
    locationMatch: { percent: m.locPct, reason: m.locReason },
    salaryMatch: { percent: m.salPct, word: m.salWord, known: m.salKnown, reason: m.salReason },
    noticeMatch: { percent: m.notPct, reason: m.notReason },
    reasons: m.reasons,
    gaps: m.gaps,
    recommendation: recommendationFor(m.overall),
    advisory: 'AI match is supporting information for a human recruiter. It does not screen, '
      + 'shortlist or reject anyone — every stage change in this pipeline is made by a named person '
      + 'and recorded in Pipeline History.',
  };
}

// --- Pipeline history ------------------------------------------------------
// The stage chain with Who / When / Action / Comment. Rows come from
// ApplicationStageEvent, written by routes/applications.js on every transition.
// Applications that predate this table still show their creation and where they
// stand, labelled as derived rather than silently presented as a real event.
async function pipelineHistoryFor(applications, kind) {
  const ids = applications.map((a) => a.id);
  const events = ids.length
    ? await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    })
    : [];
  const byApp = new Map();
  events.forEach((e) => {
    if (!byApp.has(e.applicationId)) byApp.set(e.applicationId, []);
    byApp.get(e.applicationId).push(e);
  });

  const out = [];
  applications.forEach((a) => {
    const ctx = a.requirement ? a.requirement.title : '—';
    const own = byApp.get(a.id) || [];
    // The chain must start at the beginning. If no recorded event opens the
    // application (because it existed before this table did), the creation
    // link is reconstructed from the application row and labelled as derived
    // rather than passed off as something someone actually did.
    if (own.length > 0 && !own.some((e) => e.fromStage == null)) {
      out.push({
        applicationId: a.id,
        requirementTitle: ctx,
        when: a.createdAt,
        who: '—',
        role: null,
        action: 'Application created',
        fromStage: null,
        toStage: 'NEW',
        toStageLabel: stageLabel('NEW'),
        stageGroupLabel: groupLabelOfStage('NEW'),
        comment: null,
        derived: true,
      });
    }
    if (own.length === 0) {
      out.push({
        applicationId: a.id,
        requirementTitle: ctx,
        when: a.createdAt,
        who: '—',
        role: null,
        action: 'Application created',
        fromStage: null,
        toStage: 'NEW',
        toStageLabel: stageLabel('NEW'),
        stageGroupLabel: groupLabelOfStage('NEW'),
        comment: null,
        derived: true,
      });
      if (a.stage !== 'NEW') {
        out.push({
          applicationId: a.id,
          requirementTitle: ctx,
          when: a.updatedAt,
          who: '—',
          role: null,
          action: `Currently at ${stageLabel(a.stage)}`,
          fromStage: null,
          toStage: a.stage,
          toStageLabel: stageLabel(a.stage),
          stageGroupLabel: groupLabelOfStage(a.stage),
          comment: null,
          derived: true,
        });
      }
      return;
    }
    own.forEach((e) => {
      out.push({
        applicationId: a.id,
        requirementTitle: ctx,
        when: e.createdAt,
        who: e.actorName || '—',
        role: e.actorRole || null,
        action: e.action,
        fromStage: e.fromStage,
        fromStageLabel: e.fromStage ? stageLabel(e.fromStage) : null,
        toStage: e.toStage,
        toStageLabel: stageLabel(e.toStage),
        stageGroupLabel: groupLabelOfStage(e.toStage),
        // A transition comment is an INTERNAL recruiter note by another name,
        // so it is withheld from every external login exactly like the Notes
        // tab is — from the candidate being discussed as well as the client.
        comment: kind === 'internal' ? e.comment : null,
        // followup_: the full Rejected / Hold record. Requirement and client
        // come from the SNAPSHOT on the event, falling back to the live
        // relation for events written before those columns existed — so a
        // renamed client cannot rewrite why someone was rejected.
        // CLIENT NAME AS SHOWN (2026-10-17, official legal name): the label beside the event is the client's CURRENT
        // name while the event is about that same client (same clientId, or none stored); the stored snapshot
        // (ApplicationStageEvent.clientName) is untouched and still the fallback / the record of what was said then.
        requirementTitleAtTime: e.requirementTitle || ctx,
        clientName: (a.requirement && !a.requirement.internal && a.requirement.client && a.requirement.client.name
          && (!e.clientId || e.clientId === a.requirement.clientId) ? a.requirement.client.name : null)
          || e.clientName
          || (a.requirement && (a.requirement.internal ? 'TeamLink Internal' : a.requirement.client && a.requirement.client.name))
          || null,
        // WHICH SIDE the decision came from. Never inferred from the role at
        // render time; it is recorded when the move is made.
        actorSide: e.actorSide || null,
        // Reason category and detailed reason are internal reasoning, held to
        // the same rule as the comment above.
        reasonCategory: kind === 'internal' ? e.reasonCategory : null,
        reasonDetail: kind === 'internal' ? e.reasonDetail : null,
        derived: false,
      });
    });
  });
  return out.sort((a, b) => new Date(b.when) - new Date(a.when));
}

// cand7_ (Candidates §7): the Progress board, Archive / bring back and the
// Super-Admin-only delete (routes/candidatesBoard.js). Mounted before /:id.
require('./candidatesBoard')(router, {
  pipelineRowsFor, pipelineRowMatches, QUEUES, hasPersonQuery, attributedApplications, loadInScope, viewerKind,
  // ATS layout v3: the Candidates cards.
  pagedRowsFor, rowMatches, availableForMatching, contactAgeDays,
});

// "Matching Requirements": open requirements this candidate is not already in
// the pipeline for, down to 50%, best fit first (full rows with their score).
// Scoped the same way, so a client never sees another client's openings — and
// withheld from a client entirely, because it is an internal sourcing
// suggestion built on the internal scorer.
async function matchingFor(user, candidate, decorated) {
  if (viewerKind(user) !== 'internal') return [];
  const linked = new Set(decorated.applications.map((a) => a.requirementId));
  const open = await prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES }, ...requirementWhere(user) },
    include: { client: { select: { id: true, name: true } } },
  });
  return open
    .filter((r) => !linked.has(r.id))
    .map((r) => ({ ...r, match: computeMatch(candidate, r) }))
    .filter((r) => r.match.overall >= 50)
    .sort((a, b) => b.match.overall - a.match.overall);
}
// What the screens read of a matching job: id, title, client, place, openings, fit %.
// (The full job row, with its pipeline and notes, was 2.5-7 MB for one person.)
const MATCH_TOP = 20;
const slimMatch = (r, restricted = false) => ({
  breakdown: FB.breakdownOf(r.match, restricted),
  id: r.id,
  reqCode: r.reqCode || null,
  title: r.title,
  client: r.internal ? { id: null, name: 'TeamLink Internal' } : (r.client ? { id: r.client.id, name: r.client.name } : null),
  department: r.department || null,
  location: r.location || null,
  openings: r.openings ?? null,
  fit: restricted ? FB.round10(r.match.overall) : r.match.overall,
});

// A LIMITED CANDIDATE VIEW for the BDE team (founder, 2026-10-16): a person who is only in the "Good fit for this job" list is not in any
// pipeline yet, so the full page (which needs an application in the login's scope) refuses. The BDE team can still open them here:
// name, place, experience, skills, education and the steps they are at - NEVER phone, email, salary, documents, resume text or notes.
router.get('/:id/limited', async (req, res, next) => {
  try {
    if (!require('../utils/clientLifecycle').isBdeTeam(req.user)) return res.status(403).json(OUT_OF_SCOPE); // eslint-disable-line global-require
    const c = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, name: true, location: true, experienceYears: true, relevantExperienceYears: true, skills: true, goodToHaveSkills: true, technicalSkills: true,
        education: true, specialization: true, currentDesignation: true, noticePeriod: true, profileStatus: true,
        applications: { select: { id: true, stage: true, requirement: { select: { id: true, title: true, reqCode: true, clientId: true, internal: true, client: { select: { name: true } } } } } },
      },
    });
    if (!c) return res.status(404).json({ error: 'Candidate not found' });
    const seeIds = new Set((await prisma.requirement.findMany({ where: requirementWhere(req.user), select: { id: true } })).map((r) => r.id));
    const steps = c.applications.filter((a) => a.requirement && seeIds.has(a.requirement.id))
      .map((a) => ({ job: a.requirement.title, code: a.requirement.reqCode || null, client: a.requirement.internal ? null : (a.requirement.client && a.requirement.client.name) || null, step: stageLabelFor(a.stage, { internal: !!a.requirement.internal }) }));
    const { applications, ...person } = c; // eslint-disable-line no-unused-vars
    return res.json({ limited: true, ...person, steps, hidden: 'Phone, email, salary and documents are not shown to the client manager (BDE) team.' });
  } catch (err) { return next(err); }
});

router.get('/:id', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  await ensureNextActionContext();
  const { candidate, decorated, sharedIds, followUps } = loaded;
  const kind = viewerKind(req.user);

  // The page gets the best MATCH_TOP as slim rows + the real total; GET /:id/matching-requirements
  // returns the rest on demand ("Show all N"). The eligible-clients list below uses the full list.
  const matchingRequirements = await matchingFor(req.user, candidate, decorated);

  // WHO REJECTED THIS CANDIDATE, AND WHERE THEY ARE STILL ELIGIBLE.
  // A rejection is for one requirement at one client. The candidate stays
  // eligible for every OTHER client's open, matching requirement; a client
  // that has already rejected them is listed apart, with when and why.
  let rejectedBy = [];
  let eligibleClients = [];
  let eligibleTotal = 0;
  if (kind === 'internal') {
    const rejectedApps = decorated.applications.filter((a) => a.stage === 'REJECTED');
    const events = rejectedApps.length ? await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: rejectedApps.map((a) => a.id) }, toStage: 'REJECTED' },
      orderBy: { createdAt: 'desc' },
      select: { applicationId: true, actorSide: true, actorName: true, reasonCategory: true, reasonDetail: true, comment: true, createdAt: true },
    }) : [];
    const lastEvent = new Map();
    events.forEach((e) => { if (!lastEvent.has(e.applicationId)) lastEvent.set(e.applicationId, e); });
    rejectedBy = rejectedApps.map((a) => {
      const e = lastEvent.get(a.id);
      const r = a.requirement || {};
      return {
        applicationId: a.id, requirementId: a.requirementId, requirementTitle: r.title || null,
        clientId: r.internal ? null : r.clientId || null,
        clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
        at: e ? e.createdAt : null,
        side: e && e.actorSide ? (REJECTED_BY_LABEL[e.actorSide] || e.actorSide) : null,
        reason: e ? (e.reasonCategory || (e.reasonDetail && e.reasonDetail !== 'Rejected' ? e.reasonDetail : null) || e.comment || null) : null,
        by: e ? e.actorName : null,
      };
    });
    const rejectingClients = new Set(rejectedBy.map((x) => x.clientId).filter(Boolean));
    // Only the departments this candidate has actually been put forward in
    // (a Manufacturing candidate is not "eligible" for every Education
    // opening), and a real match — 60% or more.
    const depts = new Set(decorated.applications.map((a) => a.requirement && a.requirement.department).filter(Boolean));
    const byClient = new Map();
    matchingRequirements
      .filter((r) => r.match.overall >= 60 && (!depts.size || depts.has(r.department)))
      .forEach((r) => {
      const key = r.internal ? 'internal' : r.clientId;
      if (!byClient.has(key)) {
        byClient.set(key, {
          clientId: r.internal ? null : r.clientId,
          clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || '—',
          rejectedEarlier: !r.internal && rejectingClients.has(r.clientId),
          requirements: [],
        });
      }
      byClient.get(key).requirements.push({ id: r.id, title: r.title, match: r.match.overall });
    });
    const sortedClients = [...byClient.values()].sort((a, b) => (a.rejectedEarlier - b.rejectedEarlier)
      || (b.requirements[0].match - a.requirements[0].match));
    // A thin profile (no skills, no experience, no resume) has nothing to score: no "could fit" verdicts.
    eligibleTotal = isThinProfile(candidate) ? 0 : sortedClients.filter((x) => !x.rejectedEarlier).length;
    eligibleClients = isThinProfile(candidate) ? [] : sortedClients.slice(0, 150);
  }

  // Per-application Owner / Next Action / Due Date for the Application tab.
  const rawApplications = visibleApplications(req.user, candidate.applications, sharedIds);
  // When each application reached its current stage (its latest stage event).
  const stageEvents = decorated.applications.length ? await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: decorated.applications.map((a) => a.id) } },
    orderBy: { createdAt: 'desc' },
    select: { applicationId: true, createdAt: true, toStage: true },
  }) : [];
  const stageSince = new Map();
  const stageMoves = new Map();
  const joinedMoveAt = new Map(); // the latest move into Joined (the last-resort source of the joining day)
  stageEvents.forEach((e) => {
    if (JL.isJoined(e.toStage) && !joinedMoveAt.has(e.applicationId)) joinedMoveAt.set(e.applicationId, e.createdAt);
    if (!stageSince.has(e.applicationId)) stageSince.set(e.applicationId, e.createdAt);
    stageMoves.set(e.applicationId, (stageMoves.get(e.applicationId) || 0) + 1);
  });
  const detailFitViewer = SALARY.viewerFor(require('../utils/clientRedact').privacyFlagsFor(req.user)); // eslint-disable-line global-require
  const applications = decorated.applications.map((a) => ({
    ...a,
    // Candidate 360 header (spec §9): the one next action, its owner and due
    // date — utils/nextAction.js, the same rule as the queues.
    ...(() => {
      const lf = followUps && followUps.get(a.id);
      const na = nextActionFor(a, { attributed: attributedOf(lf) });
      return {
        nextActionOwnerRole: na.ownerRole,
        nextActionOwnerName: kind === 'internal' ? na.ownerName : null,
        dueStatus: na.dueStatus,
        dueSource: na.dueSource,
        stageEnteredAt: na.enteredAt,
        waitingOnParty: na.waitingOn,
        preAts: isPreAtsApplication(a),
        clientFeedbackPending: isClientFeedbackPending(a),
      };
    })(),
    stageSince: stageSince.get(a.id) || a.updatedAt || a.createdAt,
    stageMoves: stageMoves.get(a.id) || 0,
    // "Joined on <date>" beside the Joined step (one rule: utils/joinDayShared.js). Only a joined application carries it.
    ...(JL.isJoined(a.stage) ? { joiningDay: JL.dayOfApp(a, null, joinedMoveAt.get(a.id)) } : {}),
    stageLabel: stageLabelFor(a.stage, { internal: isInternalApp(a, a.requirement) }),
    stageGroup: groupIdOfStage(a.stage),
    stageGroupLabel: groupLabelOfStage(a.stage),
    stageDetailLabel: stageDetail(a),
    owner: applicationOwner(a, a.requirement),
    // Who we are waiting on OUTSIDE TeamLink, reported beside the owner
    // rather than instead of them (§5).
    waitingOn: applicationWaitingOn(a, a.requirement),
    // §4 — whether this stage owes anybody a contact at all.
    followUpNeed: followUpNeed(a),
    nextAction: nextActionFor(a).action,
    dueDate: applicationDueDate(a),
    overdue: applicationIsOverdue(a),
    lifeStatus: applicationLifeStatus(a),
    interviewStatusLabel: a.interviewStatus ? interviewStatusLabel(a.interviewStatus) : null,
    // followup_: EVERY application carries its OWN follow-up. This is the
    // candidate-master-vs-application separation made visible: CAND0001 with
    // three applications has three independent follow-up threads here, and
    // none of them is a property of the candidate.
    followUp: kind === 'internal' ? ((followUps && followUps.get(a.id)) || null) : null,
    // Salary fit vs the client's budget for THIS job (TeamLink logins only; the BDE team gets the % label, no figures).
    ...(kind === 'internal' ? { salaryFit: SALARY.fitFor(candidate, a.requirement, detailFitViewer) } : {}),
  }));

  // "Interview requested by <recruiter>" on the application (internal logins; no contact data is involved).
  if (kind === 'internal') await require('../utils/interviewRequest').attachTo(applications); // eslint-disable-line global-require

  const latest = [...rawApplications].sort((a, b) => String(b.id).localeCompare(String(a.id)))[0] || null;

  // --- The tabs, each from its own source ---------------------------------
  const pipelineHistory = await pipelineHistoryFor(rawApplications, kind);

  // Communications are between TeamLink and the candidate. The candidate is a
  // party to them and sees their own; a CLIENT is not, and is served none.
  const communications = kind === 'client' ? [] : await require('../utils/waNumbers').filterRows(req.user, await prisma.candidateMessage.findMany({ // eslint-disable-line global-require
    where: { candidateId: candidate.id },
    orderBy: { createdAt: 'desc' },
  })); // WhatsApp chats on numbers this login may not use are left out

  const documents = await prisma.candidateDocument.findMany({
    // b5_: a document deleted with a reason stays in the history, not on the tab.
    where: { candidateId: candidate.id, deletedAt: null, ...(kind === 'internal' ? {} : { internalOnly: false }) },
    orderBy: { createdAt: 'desc' },
  });

  // Internal notes and the audit trail are INTERNAL. A client or candidate
  // login is served neither the tab nor the field.
  let notes = [];
  let audit = [];
  if (kind === 'internal') {
    notes = await prisma.candidateNote.findMany({
      where: { candidateId: candidate.id },
      orderBy: { createdAt: 'desc' },
    });
    const appIds = rawApplications.map((a) => a.id);
    const rows = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entity: 'Candidate', entityId: candidate.id },
          ...(appIds.length ? [{ entity: 'Application', entityId: { in: appIds } }] : []),
        ],
      },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    audit = rows.map((r) => ({
      id: r.id,
      when: r.createdAt,
      who: r.user ? r.user.name : '—',
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      // A merge row carries a whole JSON snapshot; the screen needs a line.
      fromValue: r.fromValue && r.fromValue.length > 400 ? `${r.fromValue.slice(0, 1)}…` : r.fromValue,
      toValue: r.toValue && r.toValue.length > 400 ? `${r.toValue.slice(0, 1)}…` : r.toValue,
    }));
  }

  // --- Candidate 360° (spec #2 §11, §23, §24) --------------------------------
  // OWNERSHIP of the current application: Department · Section · TL ·
  // Recruiter · BDE (+ the seat). Client users are not served our staffing.
  const sections = await sectionMap();
  const ownership = latest && kind === 'internal' ? {
    department: decorated.requirementDepartment || null,
    section: sectionOfCode(sections, decorated.positionCode),
    positionCode: decorated.positionCode || null,
    tl: decorated.tlName || null,
    recruiter: decorated.recruiterName || null,
    bde: decorated.bdeName || null,
  } : null;

  // FEEDBACK — interview feedback records, kept apart from the AI score
  // (which stays on the application as aiInterviewScore). A client reads only
  // its own client feedback; a candidate reads none.
  let interviewFeedbacks = [];
  if (kind !== 'candidate' && rawApplications.length) {
    const fb = await prisma.interviewFeedback.findMany({
      where: { applicationId: { in: rawApplications.map((a) => a.id) } },
      orderBy: { createdAt: 'desc' },
    });
    interviewFeedbacks = kind === 'internal'
      ? fb
      : fb.filter((f) => f.kind === 'Client' && (!f.clientId || f.clientId === req.user.clientId));
  }

  // ACTIVITY HISTORY — who did what, when: every pipeline move plus the audit
  // trail (notes, contacts, documents, assignments, merges), newest first.
  // A stage change writes both a pipeline event and an audit row; the audit
  // copy is dropped so each move reads once.
  let activity = [];
  if (kind === 'internal') {
    const reqOfApp = new Map(rawApplications.map((a) => [a.id, a.requirement ? a.requirement.title : null]));
    activity = [
      ...pipelineHistory.filter((h) => !h.derived || h.action === 'Application created').map((h) => ({
        when: h.when,
        who: h.who && h.who !== '—' ? h.who : null,
        role: h.role || null,
        what: h.fromStageLabel ? `${h.action} (${h.fromStageLabel} → ${h.toStageLabel})` : h.action,
        why: [h.reasonCategory, h.reasonDetail, h.comment].filter(Boolean).join(' — ') || null,
        requirement: h.requirementTitleAtTime || h.requirementTitle || null,
        kind: 'stage',
        derived: !!h.derived,
      })),
      ...audit.filter((a) => a.action !== 'Application stage changed').map((a) => ({
        when: a.when,
        who: a.who && a.who !== '—' ? a.who : null,
        role: null,
        what: a.action,
        why: a.entity === 'Candidate' && a.toValue && !String(a.toValue).startsWith('{') ? String(a.toValue).slice(0, 200) : null,
        requirement: a.entity === 'Application' ? reqOfApp.get(a.entityId) || null : null,
        kind: 'audit',
        derived: false,
      })),
    ].sort((x, y) => new Date(y.when) - new Date(x.when)).slice(0, 150);
  }

  // Other profiles sharing this phone / email — a nudge towards the review
  // page, internal only.
  let duplicateHint = null;
  if (kind === 'internal') {
    const others = (await duplicateMatches(req.user, { email: candidate.email, phone: candidate.phone, excludeId: candidate.id }))
      .filter((m) => m.strength === 'strong');
    if (others.length) duplicateHint = { count: others.length, names: others.slice(0, 3).map((m) => m.name), canMerge: isDupAdmin(req.user) };
  }

  // CAME FROM <source> ON <date>, ADDED BY <name> (the profile header): the same date the list and the Sources tab use (utils/cameOn.js).
  let came = null;
  if (kind === 'internal') {
    const stNow = await getListState();
    const co = CAME.cameOnOf(candidate, candidate.applications, bulkDaysFor(stNow));
    const made = await prisma.auditLog.findFirst({
      where: { entity: 'Candidate', entityId: candidate.id, OR: [{ action: { startsWith: 'Candidate created' } }, { action: { startsWith: 'Candidate self-registered' } }] },
      orderBy: { createdAt: 'asc' },
      select: { actorName: true, userId: true, action: true },
    }).catch(() => null);
    let addedBy = made && made.actorName ? made.actorName : null;
    if (made && !addedBy && made.userId) addedBy = ((await prisma.user.findUnique({ where: { id: made.userId }, select: { name: true } }).catch(() => null)) || {}).name || null;
    came = { cameOn: co.at.toISOString(), cameOnDay: co.day, cameOnKind: co.kind, cameOnLabel: CAME.KIND_LABEL[co.kind], addedByName: addedBy };
  }

  const dupRow = { id: candidate.id };
  if (kind === 'internal') await require('../utils/candidateDupes').attachFlags([dupRow]); // eslint-disable-line global-require
  // The BDE team (user, 2026-10-09) sees the person's name, step, client
  // feedback and outcome: no recruiter notes, messages, audit trail, activity
  // history, duplicate hint, AI match or partner badge.
  // eslint-disable-next-line global-require
  const bdeView = !!((f) => f && f.bde)(require('../utils/clientRedact').privacyFlagsFor(req.user));
  res.json({
    ...decorated,
    ...(came || {}),
    code: candidateCode(candidate.id),
    applications,
    // 'both' | 'current' | 'expected' | null: the gentle "Add salary" prompt on old records (nothing is blocked).
    salaryMissing: kind === 'internal' ? SALARY.missingOf(candidate) : null,
    ownership,
    // B7: the partner who owns this person (badge on the profile), internal logins only.
    partnerOwner: kind === 'internal' && !bdeView ? await require('../utils/partners').ownerInfo(candidate).catch(() => null) : null, // eslint-disable-line global-require
    interviewFeedbacks,
    activity: bdeView ? [] : activity,
    duplicateHint: bdeView ? null : duplicateHint,
    // dup_: the red chip + "Check duplicates" on the profile, and the old id this page was reached by after a merge.
    dup: bdeView || kind !== 'internal' ? null : dupRow.dup || null,
    mergedFrom: req.aliasFrom || null,
    matchingRequirements: matchingRequirements.slice(0, MATCH_TOP).map((r) => slimMatch(r, FB.isRestricted(req.user))),
    matchingTotal: matchingRequirements.length,
    // Thin profile (no skills, no experience, no resume): the Fit tab says "Not enough details to score".
    profileThin: kind === 'internal' ? isThinProfile(candidate) : false,
    rejectedBy,
    eligibleClients,
    eligibleTotal,
    // user notes #5 — EVERY application is listed above that this login may
    // see; the rest (another team's, another department's) are only COUNTED,
    // never described, so the recruiter knows the person is being worked
    // elsewhere without being shown where. Internal logins only — a client or
    // candidate is never told about other clients' pipelines.
    otherTeamApplications: kind === 'internal' ? Math.max(0, (candidate.applications || []).length - rawApplications.length) : 0,
    viewer: {
      kind,
      internal: kind === 'internal',
      // Spelled out so the screen never has to guess why a tab is missing.
      withheld: kind === 'internal' ? [] : [
        'Internal recruiter notes',
        'Internal AI evaluation detail',
        'Internal stage comments',
        'Audit history',
        ...(kind === 'client'
          ? ['Salary and fee internals', 'Candidate communications']
          : []),
      ],
    },
    // AI Match is internal evaluation detail: never served to a client, and
    // never served to the candidate being evaluated.
    aiMatch: kind === 'internal' && latest && !bdeView ? aiMatchFor(candidate, latest, FB.isRestricted(req.user)) : null,
    pipelineHistory,
    communications: bdeView ? [] : communications,
    communicationsNote: await commsNote(),
    documents,
    notes: bdeView ? [] : notes,
    audit: bdeView ? [] : audit,
  });
  return undefined;
});

// ---------------------------------------------------------------------------
// OPEN REQUIREMENTS IN THIS CANDIDATE'S LOCATION (user notes #6).
//
// Live requirements whose location falls in one of the candidate's cities —
// current or preferred location, city names normalised (utils/
// locationMatch.js) — within this login's requirement scope, each with the
// existing match score (utils/matching.js). Client shown by NAME only (the
// binding client-desk rule). Internal logins only: it is a sourcing
// suggestion built on the internal scorer.
// ---------------------------------------------------------------------------
// GET /:id/matching-requirements?offset=0&limit=50 — the "Show all N" of the 360's matching jobs:
// the same list as the page's top rows (same scope, same score, best first), slim, in pages.
router.get('/:id/matching-requirements', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (viewerKind(req.user) !== 'internal') return res.json({ rows: [], total: 0, offset: 0, limit: 0 });
  await ensureNextActionContext();
  const all = await matchingFor(req.user, loaded.candidate, loaded.decorated);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const restricted = FB.isRestricted(req.user);
  return res.json({ rows: all.slice(offset, offset + limit).map((r) => slimMatch(r, restricted)), total: all.length, offset, limit });
});

router.get('/:id/location-requirements', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  const { candidate } = loaded;
  if (viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'This list is internal to TeamLink.' });
  const cities = candidateCities(candidate);
  const canAdd = await can(req.user, 'ats', 'candidates', 'Applications', 'create');
  const base = {
    location: candidate.location || null,
    preferredLocation: candidate.preferredLocation || null,
    cities: cities.map((c) => c.label),
    canAdd,
  };
  if (!cities.length) return res.json({ ...base, total: 0, strong: 0, rows: [] });
  const keys = cities.map((c) => c.key);
  const scope = { status: { in: REQUIREMENT_LIVE_STATUSES }, ...requirementWhere(req.user) };
  const groups = await prisma.requirement.groupBy({ by: ['location'], where: scope, _count: { _all: true } });
  const values = valuesInCities(groups.map((g) => g.location), keys);
  if (!values.length) return res.json({ ...base, total: 0, strong: 0, rows: [] });
  const open = await prisma.requirement.findMany({
    where: { AND: [scope, { location: { in: values } }] },
    select: {
      id: true, reqCode: true, title: true, internal: true, department: true, location: true, openings: true, status: true,
      skills: true, goodToHaveSkills: true, experience: true, education: true, workMode: true, employmentType: true,
      salary: true, salaryType: true, joiningTimeline: true, jobPreference: true, createdAt: true,
      client: { select: { name: true } },
    },
  });
  const linked = new Set((candidate.applications || []).map((a) => a.requirementId));
  const rows = open.map((r) => ({
    id: r.id,
    reqCode: r.reqCode,
    title: r.title,
    client: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
    department: r.department,
    location: r.location,
    openings: r.openings,
    status: r.status,
    match: computeMatch(candidate, r).overall,
    applied: linked.has(r.id),
  })).sort((a, b) => (a.applied - b.applied) || (b.match - a.match));
  return res.json({
    ...base,
    total: rows.length,
    strong: rows.filter((r) => r.match >= 60).length,
    notApplied: rows.filter((r) => !r.applied).length,
    rows: rows.slice(0, 25),
  });
});

// --- Communications tab (also its own endpoint, for refresh after a move) ---
router.get('/:id/communications', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (viewerKind(req.user) === 'client') {
    return res.status(403).json({ error: 'Candidate communications are not available to this login' });
  }
  const rows = await require('../utils/waNumbers').filterRows(req.user, await prisma.candidateMessage.findMany({ // eslint-disable-line global-require
    where: { candidateId: req.params.id },
    orderBy: { createdAt: 'desc' },
  }));
  // A role that may not see the number (the BDE team) reads the history with the address hidden.
  const cRule = await require('../utils/contactAccess').ruleFor(req.user, 'candidates').catch(() => null); // eslint-disable-line global-require
  if (!cRule || cRule.mode === 'masked' || !cRule.allowed) {
    const CA = require('../utils/contactAccess'); // eslint-disable-line global-require
    rows.forEach((r) => {
      r.recipient = CA.maskedHint(r.recipient); r.body = CA.scrubFor(r.body); r.senderEmail = null;
      // security fix 2026-10-13: delivery errors and subjects quote the address too
      const KEEP = new Set(['id', 'candidateId', 'applicationId', 'channel', 'template', 'trigger', 'status', 'providerRef', 'recipient', 'senderUserId', 'senderEmployeeId']);
      Object.keys(r).forEach((k) => { if (typeof r[k] === 'string' && r[k] && !KEEP.has(k)) r[k] = CA.scrubFor(r[k]); });
    });
  }
  res.json({
    rows,
    note: await commsNote(),
    templates: Object.values(TEMPLATES).map((t) => ({ key: t.key, label: t.label, channels: t.channels })),
  });
  return undefined;
});


// --- Contact the candidate (§3-§7, §16) ------------------------------------
// One endpoint behind the Contact panel's four methods. A Call is RECORDED —
// the dialling happens on a phone, and what matters here is the result. Email,
// SMS and WhatsApp write the same CandidateMessage row the automatic stage
// messages do, so the Communications tab shows one history whether a message
// was triggered by a move or typed by a person.
//
// HONEST ABOUT DELIVERY, as the rest of this file already is: no SMS or
// WhatsApp provider is wired in, so those rows are written
// NOT_SENT_NO_PROVIDER and the panel says "Demo / Simulated" rather than
// claiming a send. Email is the one channel that really goes out, and only
// when SMTP is configured.
// A CONTACT IS A FOLLOW-UP TOUCH. Every call, WhatsApp, SMS or email made from
// the contact panel lands on the candidate's communications history AND moves
// the open follow-up forward — its "last contacted", "by what" and "outcome"
// — so the follow-up screen says what actually happened instead of showing a
// commitment nobody seems to have acted on.
//
// It records the contact; it does not CLOSE the follow-up. Whether the thing
// that was owed is now done is a decision the person makes on the next step
// ("Record what happened"), not something a call attempt proves — a call that
// went unanswered is a touch, not a resolution.
//
// The follow-up's own `notes` are left alone: they are what was committed to.
// What was said on each touch lives on the touch itself, and the follow-up log
// (GET /:id/followup-log) shows every one of them in order.
async function touchOpenFollowUps(candidateId, applicationId, { mode, outcome }) {
  const where = { candidateId, completedAt: null, ...(applicationId ? { applicationId } : {}) };
  const res = await prisma.applicationFollowUp.updateMany({
    where,
    data: { lastContactedAt: new Date(), contactMode: mode, ...(outcome ? { outcome } : {}) },
  });
  return res.count;
}

router.post('/:id/contact', require('../utils/contactAccess').requireContact('candidates'), async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (viewerKind(req.user) === 'client') {
    return res.status(403).json({ error: 'Contacting a candidate is not available to this login' });
  }
  const { candidate } = loaded;
  // b5_: consent withdrawn = do not contact. Record their new yes first (Consent card).
  if (require('../utils/candidateRecord').isDoNotContact(candidate)) { // eslint-disable-line global-require
    return res.status(409).json({ error: 'This person asked not to be contacted (consent withdrawn). If they say yes again, record it on the Consent card first.', doNotContact: true });
  }

  const method = String((req.body && req.body.method) || '').trim();
  const METHODS = ['Call', 'WhatsApp', 'SMS', 'Email'];
  if (!METHODS.includes(method)) {
    return res.status(400).json({ error: `Choose how you contacted them: ${METHODS.join(', ')}.` });
  }
  const purpose = String((req.body && req.body.purpose) || '').trim();
  if (!purpose) return res.status(400).json({ error: 'Say why you are contacting them.' });

  // A CALL leaves a record of the RESULT, not a message.
  if (method === 'Call') {
    const callResult = String((req.body && req.body.callResult) || '').trim();
    if (!CALL_RESULTS.includes(callResult)) {
      return res.status(400).json({ error: `Record how the call went: ${CALL_RESULTS.join(', ')}.` });
    }
    const row = await prisma.candidateMessage.create({
      data: {
        candidateId: candidate.id,
        applicationId: (req.body && req.body.applicationId) || null,
        channel: 'Call',
        template: 'MANUAL', // a person typed this, not a stage template
        templateLabel: purpose,
        trigger: 'Manual',
        recipient: candidate.phone || null,
        body: `${callResult}${req.body.notes ? ` — ${String(req.body.notes).slice(0, 1000)}` : ''}`,
        // A call is not "sent"; it happened. Recording it IS the outcome.
        status: 'LOGGED',
        statusDetail: `Call — ${callResult}`,
        ...(await senderIdentity(req.user)),
      },
    });
    await logAudit({
      userId: req.user.id, actorName: req.user.name,
      action: `Called candidate — ${callResult}`,
      entity: 'Candidate', entityId: candidate.id, toValue: purpose,
    });
    const followUpsTouched = await touchOpenFollowUps(
      candidate.id, (req.body && req.body.applicationId) || null, { mode: 'Call', outcome: callResult },
    );
    return res.status(201).json({ row, delivery: 'logged', followUpsTouched });
  }

  // EMAIL / SMS / WHATSAPP — a message, written to the same history.
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Write the message before sending.' });
  const recipient = method === 'Email' ? candidate.email : candidate.phone;
  if (!recipient) {
    return res.status(400).json({
      error: `No ${method === 'Email' ? 'email address' : 'phone number'} on this candidate's record.`,
    });
  }
  // Email is the ONE channel that really goes out, and only when SMTP is
  // configured. Everything else is recorded, not transmitted.
  // eslint-disable-next-line global-require
  const emailCfg = await require('../utils/mailer').emailConfig().catch(() => ({ configured: false }));
  // THE ONE "CANDIDATE EMAILS" SWITCH also holds a hand-typed email: while it is OFF the
  // message is recorded ("Not sent — candidate emails are switched off") and nothing is queued.
  const IN = require('../utils/interviewNotices'); // eslint-disable-line global-require
  const switchedOn = await IN.candidateEmailsOn();
  const live = method === 'Email' && emailCfg.configured === true && switchedOn;
  // SENT FROM THE RECRUITER'S OWN PHONE. With no WhatsApp or SMS provider
  // connected, the panel opens the recruiter's own WhatsApp (wa.me) or
  // messaging app (sms:) with the message already typed. That is a real way
  // to reach the candidate — but the app hands the message over and never
  // sees whether it was actually sent, so it is recorded as exactly that:
  // opened on the device, not SENT. SENT stays reserved for a provider that
  // accepted the message and returned a reference.
  const byHand = !live && (method === 'WhatsApp' || method === 'SMS')
    && String((req.body && req.body.sentVia) || '') === 'device';
  let status = NOT_SENT;
  let statusDetail = NOT_SENT_DETAIL;
  if (method === 'Email' && !switchedOn) { status = IN.SWITCHED_OFF; statusDetail = `${IN.SWITCHED_OFF_DETAIL}.`; }
  else if (live) { status = 'QUEUED'; statusDetail = 'Queued for sending.'; }
  else if (byHand) {
    status = 'OPENED_ON_DEVICE';
    statusDetail = `Opened in the sender's own ${method === 'WhatsApp' ? 'WhatsApp' : 'messaging app'} with this text — the app cannot confirm it was sent.`;
  }
  const row = await prisma.candidateMessage.create({
    data: {
      candidateId: candidate.id,
      applicationId: (req.body && req.body.applicationId) || null,
      channel: method,
      template: 'MANUAL', // a person typed this, not a stage template
      templateLabel: purpose,
      trigger: 'Manual',
      recipient,
      subject: method === 'Email' ? (String(req.body.subject || purpose).slice(0, 200)) : null,
      body: body.slice(0, 4000),
      status,
      statusDetail,
      ...(await senderIdentity(req.user)),
    },
  });
  if (live) require('../utils/mailWorker').kick();
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `${method} to candidate${byHand ? ' (opened on the sender\'s device)' : ''}`,
    entity: 'Candidate', entityId: candidate.id, toValue: purpose,
  });
  const followUpsTouched = await touchOpenFollowUps(
    candidate.id, (req.body && req.body.applicationId) || null, { mode: method },
  );
  let delivery = 'simulated';
  if (live) delivery = 'queued';
  else if (byHand) delivery = 'by-hand';
  return res.status(201).json({ row, delivery, followUpsTouched });
});

// --- Bulk messaging ---------------------------------------------------------
// ONE MESSAGE TO MANY CANDIDATES — Email, WhatsApp, SMS, or all three
// ("Omnichannel"). Selected on the Candidates & Pipeline list, written here as
// one CandidateMessage per candidate per channel, each personalised.
//
// WHAT ACTUALLY GOES OUT. Email is queued and sent by the mail worker from the
// configured HR address, exactly like a single email. WhatsApp and SMS have no
// provider connected, so those rows are recorded as NOT SENT — no provider,
// and the response says how many, rather than implying a broadcast that never
// left the building. Connect a gateway and the same rows are what it sends.
//
// SAFETY. Internal logins only; every candidate is checked against the
// sender's own scope (a Medical recruiter cannot mail Education's
// candidates by sending their ids); at most BULK_LIMIT per send, so a mis-click
// on "select all" cannot mail sixteen thousand people.
//
// These are broadcasts, not follow-ups, so they are recorded with trigger
// "Bulk": they show on each candidate's Communications tab but do not flood
// the follow-up log, which is for people chasing one candidate.
const BULK_LIMIT = 500;
const BULK_CHANNELS = ['Email', 'WhatsApp', 'SMS'];

router.post('/bulk-contact', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Bulk messaging is not available to this login' });
  }
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.candidateIds) ? b.candidateIds : []).map(String))];
  const channels = [...new Set((Array.isArray(b.channels) ? b.channels : []).map(String))]
    .filter((c) => BULK_CHANNELS.includes(c));
  const purpose = String(b.purpose || '').trim();
  const body = String(b.body || '').trim();
  const subject = String(b.subject || purpose).trim().slice(0, 200);

  if (!ids.length) return res.status(400).json({ error: 'Select at least one candidate.' });
  if (ids.length > BULK_LIMIT) {
    return res.status(400).json({ error: `At most ${BULK_LIMIT} candidates per send — narrow the filters and send in batches.` });
  }
  if (!channels.length) return res.status(400).json({ error: 'Choose Email, WhatsApp, SMS or Omnichannel.' });
  if (!purpose) return res.status(400).json({ error: 'Say what this message is for.' });
  if (!body) return res.status(400).json({ error: 'Write the message.' });

  // SCOPE, for exactly these ids — the same visibility rule as the list.
  const found = await prisma.candidate.findMany({
    where: { id: { in: ids } },
    include: { applications: { include: { requirement: true } } },
  });
  const reachable = found.filter((c) => scopeOf(req.user).global
    || visibleApplications(req.user, c.applications).length > 0);
  const outOfScope = ids.length - reachable.length;
  // b5_: consent withdrawn = do not contact — counted, never messaged.
  const { isDoNotContact } = require('../utils/candidateRecord'); // eslint-disable-line global-require
  const allowed = reachable.filter((c) => !isDoNotContact(c));
  const doNotContact = reachable.length - allowed.length;

  // eslint-disable-next-line global-require
  const emailCfg = await require('../utils/mailer').emailConfig().catch(() => ({ configured: false }));
  const sender = await senderIdentity(req.user);
  // {name} and {firstName} are the two tokens anybody has asked for.
  const fill = (text, c) => String(text)
    .split('{name}').join(c.name || 'there')
    .split('{firstName}').join(String(c.name || 'there').split(/\s+/)[0]);

  const result = {
    candidates: allowed.length, outOfScope, doNotContact, queued: 0, notSent: 0,
    skipped: { Email: 0, WhatsApp: 0, SMS: 0 },
  };
  const rows = [];
  allowed.forEach((c) => {
    channels.forEach((channel) => {
      const recipient = channel === 'Email' ? c.email : c.phone;
      if (!recipient) { result.skipped[channel] += 1; return; }
      const live = channel === 'Email' && emailCfg.configured === true;
      if (live) result.queued += 1; else result.notSent += 1;
      rows.push({
        candidateId: c.id,
        applicationId: null,
        channel,
        template: 'BULK',
        templateLabel: purpose,
        trigger: 'Bulk',
        recipient,
        subject: channel === 'Email' ? fill(subject, c) : null,
        body: fill(body, c).slice(0, 4000),
        status: live ? 'QUEUED' : NOT_SENT,
        statusDetail: live ? 'Queued for sending (bulk).' : NOT_SENT_DETAIL,
        ...sender,
      });
    });
  });
  // Chunked: SQLite caps bound parameters per statement.
  for (let i = 0; i < rows.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.candidateMessage.createMany({ data: rows.slice(i, i + 200) });
  }
  if (result.queued) require('../utils/mailWorker').kick();
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: `Bulk ${channels.join(' + ')} to ${allowed.length} candidate(s)`,
    entity: 'Candidate',
    toValue: `${purpose} · ${result.queued} email queued · ${result.notSent} not sent (no provider)`,
  });
  return res.status(201).json(result);
});

// --- The follow-up log ------------------------------------------------------
// EVERY TOUCH, IN ORDER, WITH WHAT WAS SAID. The Follow-ups table shows one row
// per open commitment — who owes what by when — which answers "what is due",
// not "what has already been done". This is the other half: each contact made
// (by call, WhatsApp, SMS or email — the channel is the first thing on the
// row), why, how it went, what was said, and who did it from which seat; and
// each follow-up that was set and closed, so the story reads end to end.
//
// Internal only, like notes: a follow-up log is TeamLink's own working record.
router.get('/:id/followup-log', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'The follow-up log is not available to this login' });
  }
  const candidateId = req.params.id;
  const [touches, followUps, apps] = await Promise.all([
    prisma.candidateMessage.findMany({
      where: { candidateId, trigger: 'Manual' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.applicationFollowUp.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.application.findMany({
      where: { candidateId },
      select: { id: true, requirement: { select: { title: true, client: { select: { name: true } } } } },
    }),
  ]);
  const reqOf = new Map(apps.map((a) => [a.id, a.requirement
    ? `${a.requirement.title}${a.requirement.client ? ` · ${a.requirement.client.name}` : ''}` : null]));

  const entries = [];
  touches.forEach((m) => {
    // A call's body is "<result> — <notes>"; split it back so the log can
    // show the outcome and what was said as two things.
    let outcome = null;
    let said = m.body || null;
    // A quick log (Call / Mail / WhatsApp buttons) carries only its outcome.
    if ((m.channel === 'Call' || m.template === 'QUICK_LOG') && m.body) {
      const [first, ...rest] = String(m.body).split(' — ');
      outcome = first || null;
      said = rest.join(' — ') || null;
    }
    entries.push({
      kind: 'contact',
      at: m.createdAt,
      channel: m.channel,
      purpose: m.templateLabel || null,
      outcome,
      said,
      status: m.status,
      statusDetail: m.statusDetail || null,
      by: m.senderName || null,
      requirement: m.applicationId ? reqOf.get(m.applicationId) || null : null,
      // C1: a quick log's outcome can be changed by its sender for 24 h.
      id: m.id,
      quick: m.template === 'QUICK_LOG',
      byMe: !!m.senderUserId && m.senderUserId === req.user.id,
    });
  });
  followUps.forEach((f) => {
    entries.push({
      kind: 'followup-set',
      at: f.createdAt,
      channel: f.contactMode || null,
      purpose: f.purpose || f.nextAction || null,
      outcome: null,
      said: f.notes || null,
      due: f.dueDate || null,
      by: f.createdByName || f.ownerName || null,
      requirement: reqOf.get(f.applicationId) || null,
    });
    if (f.completedAt) {
      entries.push({
        kind: 'followup-done',
        at: f.completedAt,
        channel: f.contactMode || null,
        purpose: f.nextAction || f.purpose || null,
        outcome: f.outcome || null,
        said: f.completedNote || null,
        by: f.ownerName || null,
        requirement: reqOf.get(f.applicationId) || null,
      });
    }
  });
  entries.sort((a, b) => new Date(b.at) - new Date(a.at));
  // THE BDE TEAM (BDE + BDE TL) never reads what a recruiter SAID on a call or who
  // made it - the same as every other internal note (security review 2026-10-09).
  // They keep the when / how / outcome / which job.
  // eslint-disable-next-line global-require
  const bdeFlags = require('../utils/clientRedact').privacyFlagsFor(req.user);
  if (bdeFlags && bdeFlags.bde) {
    return res.json({ entries: entries.map((e) => ({ ...e, said: null, by: null, statusDetail: null })) });
  }
  return res.json({ entries });
});

// --- Notes tab -------------------------------------------------------------
// Internal only, at BOTH ends: the GET refuses a client or candidate login
// outright (not an empty list — a refusal), and the POST needs candidate-master
// edit permission from the same engine every other write here uses.
router.get('/:id/notes', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Internal notes are not available to this login' });
  }
  const rows = await prisma.candidateNote.findMany({
    where: { candidateId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(rows);
});

router.post('/:id/notes', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Internal notes are not available to this login' });
  }
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'A note cannot be empty.' });
  const note = await prisma.candidateNote.create({
    data: {
      candidateId: req.params.id,
      applicationId: req.body.applicationId || null,
      body,
      authorUserId: req.user.id,
      authorName: req.user.name,
      authorRole: req.user.atsRole || req.user.role,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Internal note added', entity: 'Candidate', entityId: req.params.id,
  });
  return res.status(201).json(note);
});

// b5_ (ATS-100 B5): consent, referred by, certifications and documents with a
// real file — routes/candidateRecord.js, under this router's view check + scope.
router.use(require('./candidateRecord'));

// --- Documents tab ---------------------------------------------------------
const DOC_TYPES = ['Resume', 'ID', 'Certificate', 'Offer', 'Joining'];

router.get('/:id/documents', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  const internal = isInternalViewer(req.user);
  const rows = await prisma.candidateDocument.findMany({
    where: { candidateId: req.params.id, deletedAt: null, ...(internal ? {} : { internalOnly: false }) },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ rows, types: DOC_TYPES });
});

router.post('/:id/documents', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  const docType = DOC_TYPES.includes(req.body.docType) ? req.body.docType : null;
  const name = String(req.body.name || '').trim();
  if (!docType) return res.status(400).json({ error: `Document type must be one of: ${DOC_TYPES.join(', ')}` });
  if (!name) return res.status(400).json({ error: 'A document name is required.' });
  const doc = await prisma.candidateDocument.create({
    data: {
      candidateId: req.params.id,
      docType,
      name,
      note: req.body.note || null,
      // Offer paperwork carries the commercial terms, so it defaults to
      // internal-only unless someone deliberately says otherwise.
      internalOnly: req.body.internalOnly != null ? !!req.body.internalOnly : docType === 'Offer',
      uploadedByUserId: req.user.id,
      uploadedByName: req.user.name,
    },
  });
  await logAudit({
    userId: req.user.id, action: `Document recorded (${docType})`, entity: 'Candidate', entityId: req.params.id, toValue: name,
  });
  return res.status(201).json(doc);
});

// --- Audit History tab -----------------------------------------------------
router.get('/:id/audit', async (req, res) => {
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  if (!isInternalViewer(req.user)) {
    return res.status(403).json({ error: 'Audit history is not available to this login' });
  }
  const appIds = loaded.decorated.applications.map((a) => a.id);
  const rows = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entity: 'Candidate', entityId: req.params.id },
        ...(appIds.length ? [{ entity: 'Application', entityId: { in: appIds } }] : []),
      ],
    },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return res.json(rows.map((r) => ({
    id: r.id,
    when: r.createdAt,
    who: r.user ? r.user.name : '—',
    action: r.action,
    entity: r.entity,
    fromValue: r.fromValue,
    toValue: r.toValue,
  })));
});

// Every field the prototype's acCollectCandidate() (line 8250) gathers, in the
// section order of the Add Candidate modal: A Personal, B Professional,
// C Education, D Skills, E Resume, F Source.
const CANDIDATE_FIELDS = {
  text: [
    'name', 'email', 'phone', 'dob', 'gender', 'location', 'preferredLocation',
    'currentCompany', 'currentDesignation', 'currentSalary', 'expectedSalary',
    'noticePeriod', 'availability', 'jobPreference', 'preferredEmploymentType', 'preferredWorkMode',
    'education', 'specialization', 'institute', 'passingYear',
    'skills', 'goodToHaveSkills', 'technicalSkills', 'softSkills',
    'resumeName', 'source', 'firstSource', 'sourceCampaign', 'profileStatus',
  ],
  numeric: ['experienceYears', 'relevantExperienceYears', 'resumeScore'],
};

function pickCandidate(body) {
  const data = {};
  for (const key of CANDIDATE_FIELDS.text) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  for (const key of CANDIDATE_FIELDS.numeric) {
    if (body[key] !== undefined && body[key] !== '' && body[key] !== null) data[key] = Number(body[key]);
  }
  // Typed-in values (2026-10-14, utils/openVocab.js): no HTML, spaces collapsed, at most 80 characters, no duplicate skills.
  { const OV = require('../utils/openVocab'); // eslint-disable-line global-require
    ['education', 'specialization', 'institute', 'preferredEmploymentType', 'currentDesignation', 'gender'].forEach((k) => { if (typeof data[k] === 'string') data[k] = OV.clean(data[k]); });
    ['skills', 'goodToHaveSkills', 'technicalSkills', 'softSkills'].forEach((k) => { if (typeof data[k] === 'string') data[k] = OV.cleanSkills(data[k]); }); }
  // "Do not use" is set only by the TL's approval (routes/rejections.js),
  // never typed into a profile form.
  if (data.profileStatus === 'Do Not Use') delete data.profileStatus;
  // cand7_: Archived is set only through POST /:id/archive (role-checked, audited).
  if (data.profileStatus === 'Archived') delete data.profileStatus;
  // NEW ENTRIES go through the clean source list (utils/candidateSource.js): what is stored is the clean
  // word; the typed word is kept as a note by the route (sourceNoteFor) when it differs.
  if (data.source !== undefined) data.source = CS.normaliseIncoming(data.source).source;
  if (data.firstSource !== undefined) data.firstSource = CS.normaliseIncoming(data.firstSource).source;
  // A candidate arriving from a second source updates their latest source; the
  // first source is recorded once and never overwritten.
  if (data.source && !data.firstSource) data.firstSource = data.source;
  if (data.source && !data.preferredLocation && data.location) data.preferredLocation = data.location;
  return data;
}

// The note that keeps what was typed in the Source box when it was tidied, or the "Other" explanation.
async function writeSourceNote(candidateId, user, body, storedBefore = undefined) {
  try {
    if (body.source === undefined && !body.sourceNote) return;
    if (storedBefore !== undefined && body.source === storedBefore && !body.sourceNote) return; // untouched
    const text = CS.sourceNote(CS.normaliseIncoming(body.source), body.sourceNote);
    if (!text) return;
    await prisma.candidateNote.create({
      data: { candidateId, body: text, authorUserId: user.id, authorName: user.name || null, authorRole: user.role || null },
    });
  } catch (err) { console.error(`[candidates] source note not stored for ${candidateId}: ${err.message}`); }
}

router.post('/', requirePerm('ats', 'candidates', 'Add Candidate', 'create'), async (req, res) => {
  const { email, phone } = req.body;
  const data = pickCandidate(req.body);
  if (data.email) data.email = String(data.email).trim();
  if (data.phone) data.phone = String(data.phone).trim();
  // Prototype saveNewCandidate() (line 8304) required fields, in its order.
  if (!data.name) return res.status(400).json({ error: 'First name is required.' });
  if (!phone) return res.status(400).json({ error: 'Mobile is required.' });
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!String(data.skills || '').trim()) return res.status(400).json({ error: 'Enter at least one mandatory skill.' });
  // SALARY (user note 2026-10-10): Current + Expected salary are required on every new candidate.
  // Stored as a clean "4.5 LPA" (a monthly entry is converted once); odd-but-possible values only warn.
  const sal = SALARY.validateSalaries(req.body);
  if (!sal.ok) {
    return res.status(400).json({
      error: sal.message, code: 'SALARY_REQUIRED', field: sal.errors.currentSalary ? 'currentSalary' : 'expectedSalary', errors: sal.errors,
    });
  }
  data.currentSalary = sal.values.currentSalary;
  data.expectedSalary = sal.values.expectedSalary;
  // "Apply to Requirement" must name a requirement IN THIS LOGIN'S SCOPE —
  // checked before anything is written (review #3 access audit), the same
  // rule as POST /applications.
  if (req.body.requirementId) {
    const reqInScope = await prisma.requirement.count({
      where: { AND: [{ id: String(req.body.requirementId) }, requirementWhere(req.user)] },
    });
    if (!reqInScope) return res.status(403).json(OUT_OF_SCOPE);
    // The SAME job checks as POST /applications (e2e gaps 5 / 6): not live
    // yet, paused, closed, or a paused client → refused before anything is
    // written, in plain words.
    // eslint-disable-next-line global-require
    const { jobRefusalFor, fitAtAdd } = require('./applications');
    const applyTo = await prisma.requirement.findUnique({ where: { id: String(req.body.requirementId) } });
    const jobNo = await jobRefusalFor(applyTo);
    if (jobNo) return res.status(jobNo.status).json(jobNo.body);
    // B9.11 — the SAME B8 override rule as POST /applications: a person who
    // does not meet the job's rules (must-have skill, minimum Fit, notice
    // period, location) goes in only WITH a reason, asked BEFORE anything is
    // written (so a cancelled prompt leaves no half-made candidate).
    if (applyTo && typeof fitAtAdd === 'function') {
      const probe = { ...data, id: 'new-candidate', name: data.name };
      const fit = await fitAtAdd(req.user, probe, applyTo).catch(() => null);
      if (fit && fit.overrideWhy.length) {
        const reason = String(req.body.overrideReason || '').trim().slice(0, 300);
        if (reason.length < 5) {
          return res.status(409).json({
            error: `${data.name} does not meet this requirement's rules: ${fit.overrideWhy.join('; ')}. To add them anyway, say why.`,
            code: 'NEEDS_OVERRIDE',
            why: fit.overrideWhy,
            fit: fit.match.overall,
            minFit: fit.match.minFit,
            candidateName: data.name,
            requirementTitle: applyTo.title,
          });
        }
        req.applyOverride = { reason, why: fit.overrideWhy };
      }
    }
  }

  // ONE CANDIDATE MASTER (spec #2 §12). A phone or email that already belongs
  // to another candidate is REFUSED (409, with the match and its applications)
  // — the screen then offers Open Candidate / Add to Requirement. A second
  // profile is created only on an explicit "Create New Profile"
  // (overrideDuplicate: true), and that override is audit-logged with the
  // records it was warned about. A name-only resemblance never blocks.
  const found = await duplicateMatches(req.user, { email, phone, name: data.name });
  const strong = found.filter((m) => m.strength === 'strong');
  // cand7_ (§7): "no second profile" — only a Super Admin / Admin may still
  // create one over a same-phone / same-email match (audited below).
  const override = req.body.overrideDuplicate === true && isDupAdmin(req.user);
  if (strong.length && !override) {
    return res.status(409).json({
      error: req.body.overrideDuplicate === true
        ? 'This person is already on file. Open the profile or add an application to it — only an Admin can create a second profile.'
        : 'This person is already on file.',
      duplicate: true,
      matches: strong,
      possible: found.filter((m) => m.strength !== 'strong'),
    });
  }

  const candidate = await prisma.candidate.create({ data });
  await ADDED.record(candidate.id, req.user, 'manual'); // this login keeps seeing the person even before any requirement
  await writeSourceNote(candidate.id, req.user, req.body);
  await logAudit({ userId: req.user.id, action: 'Candidate created (manual)', entity: 'Candidate', entityId: candidate.id, toValue: 'Active' });
  if (strong.length) {
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name,
      action: 'Duplicate warning overridden — new profile created (Create New Profile)',
      entity: 'Candidate',
      entityId: candidate.id,
      fromValue: strong.map((m) => `${m.id} (${m.name}; matched ${m.reasons.join('+')})`).join(', ').slice(0, 2000),
      toValue: `${candidate.name}`,
      reason: String(req.body.overrideReason || '').slice(0, 500) || null,
    });
  }

  // A resume named on the Add Candidate form becomes the first row of the
  // Documents tab, so the tab is never empty for a candidate who has one.
  if (candidate.resumeName) {
    await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        docType: 'Resume',
        name: candidate.resumeName,
        note: 'Attached on the Add Candidate form',
        uploadedByUserId: req.user.id,
        uploadedByName: req.user.name,
      },
    });
  }

  // "Apply to Requirement" on the Add Candidate form creates the application in
  // the same save, scored against that requirement — prototype saveNewCandidate().
  let application = null;
  if (req.body.requirementId) {
    const requirement = await prisma.requirement.findUnique({ where: { id: req.body.requirementId } });
    if (requirement) {
      // ONE add-to-job path, shared with POST /applications (e2e gap 6): the
      // hiring type is stored, and an INTERNAL job's candidate lands in the
      // Job Portal screening (HR Sourcing) instead of skipping it.
      // eslint-disable-next-line global-require
      const { addApplication } = require('./applications');
      application = await addApplication(req.user, {
        candidate, requirement, from: { applicationMethod: req.body.applicationMethod || 'Manual' },
        override: req.applyOverride || null, // B9.11: recorded like every other override (column + badge + report)
      });
    }
  }

  // b5_/b6_ (ATS-100): Referred by (an employee or a name), the campus drive
  // they came from, and a consent the recruiter heard — all optional.
  try {
    // eslint-disable-next-line global-require
    const CR = require('../utils/candidateRecord');
    if (CR.supported()) {
      const b = req.body || {};
      const drive = b.campusDriveId ? await prisma.campusDrive.findUnique({ where: { id: String(b.campusDriveId) } }) : null;
      const emp = b.referredByEmployeeId ? await prisma.employee.findUnique({ where: { id: String(b.referredByEmployeeId) }, select: { id: true, name: true } }) : null;
      const refName = emp ? emp.name : String(b.referredByName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const cd = {};
      if (drive) cd.campusDriveId = drive.id;
      if (refName) Object.assign(cd, { referredByEmployeeId: emp ? emp.id : null, referredByName: refName });
      let fresh = candidate;
      if (Object.keys(cd).length) fresh = await prisma.candidate.update({ where: { id: candidate.id }, data: cd });
      if (emp) await CR.recordStaffReferral({ candidate: fresh, application, employeeId: emp.id, actor: req.user });
      if (application) {
        await CR.attach({
          application, candidate: fresh, campusDriveId: drive ? drive.id : null,
          referredBy: !emp && refName ? { name: refName } : null, utm: b.utm || null, actor: req.user,
        });
      }
      const cs = b.consent && typeof b.consent === 'object' ? b.consent : null;
      const note = cs ? String(cs.note || '').trim() : '';
      if (cs && CR.CONSENT_STATUSES.includes(cs.status) && note.length >= 5) {
        await CR.setConsent(candidate.id, {
          status: cs.status, purposes: cs.purposes, source: 'recruiter', proof: `${note} — recorded by ${req.user.name}`, byName: req.user.name, userId: req.user.id,
        });
      }
    }
  } catch (err) {
    console.error(`[candidates] referral / campus / consent not stored for ${candidate.id}: ${err.message}`);
  }

  // dup_: the entry check already ran (db.js hook); note who entered it and tell the screen if it is being held.
  const dupInfo = { id: candidate.id };
  try {
    const DUPS = require('../utils/candidateDupes'); // eslint-disable-line global-require
    if (await DUPS.supported()) {
      await DUPS.ex("UPDATE CandidateDupFlag SET enteredById = ?, enteredByName = ? WHERE (candidateId = ? OR matchCandidateId = ?) AND enteredById IS NULL AND status IN ('OPEN','MERGE_REQUESTED')", req.user.id, req.user.name, candidate.id, candidate.id);
      await DUPS.attachFlags([dupInfo]);
    }
  } catch { /* the check is a helper */ }
  return res.status(201).json({ ...candidate, application, dup: dupInfo.dup || null, salaryWarnings: sal.warnings });
});

router.put('/:id', requirePerm('ats', 'candidates', 'Candidate Master', 'edit'), async (req, res) => {
  // EDITING A PROFILE: a Recruiter (the people in their own scope) and a Super Admin - the Developer Team login is one -
  // only (founder 2026-10-29: "the edit access is only for recruiter & super admin, developer"). Notes / documents keep
  // their own rights.
  const roles = [req.user.role, req.user.atsRole];
  if (!roles.includes('SUPER_ADMIN') && req.user.atsRole !== 'RECRUITER') {
    return res.status(403).json({ error: 'Only a recruiter or a Super Admin can edit a candidate profile.' });
  }
  // SCOPE, as on every other write here: a record outside this login's reach
  // is refused, not edited by id.
  const loaded = await loadInScope(req, res);
  if (!loaded) return undefined;
  // Changing the phone / email to one another candidate already has would
  // make a duplicate by the back door — refused the same way as a create.
  const changedContact = (req.body.phone !== undefined && phoneKeys(req.body.phone).join() !== phoneKeys(loaded.candidate.phone).join())
    || (req.body.email !== undefined && emailKey(req.body.email) !== emailKey(loaded.candidate.email));
  if (changedContact && req.body.overrideDuplicate !== true) {
    const clash = (await duplicateMatches(req.user, { email: req.body.email, phone: req.body.phone, excludeId: req.params.id }))
      .filter((m) => m.strength === 'strong');
    if (clash.length) return res.status(409).json({ error: 'Another candidate already has this phone or email', duplicate: true, matches: clash });
  }
  const picked = pickCandidate(req.body);
  // SALARY on an edit: an old record with no salary can still be edited (blank stays blank); anything written must be
  // readable and is stored as "4.5 LPA"; a salary that exists cannot be wiped out. Odd values only warn.
  const salEdit = SALARY.checkEdit(req.body, loaded.candidate);
  if (!salEdit.ok) {
    return res.status(400).json({
      error: salEdit.message, code: 'SALARY_REQUIRED', field: salEdit.errors.currentSalary ? 'currentSalary' : 'expectedSalary', errors: salEdit.errors,
    });
  }
  ['currentSalary', 'expectedSalary'].forEach((k) => {
    if (k in salEdit.values) picked[k] = salEdit.values[k];
    else if (picked[k] !== undefined && !String(picked[k] === null ? '' : picked[k]).trim()) delete picked[k]; // stayed blank: not rewritten
    else if (picked[k] !== undefined && String(picked[k]).trim() === String((loaded.candidate[k]) || '').trim()) delete picked[k]; // untouched
  });
  // The edit form sends every field back: a source that was not touched keeps its stored word.
  if (req.body.source !== undefined && String(req.body.source || '') === String(loaded.candidate.source || '')) { delete picked.source; delete picked.firstSource; }
  // An approved "Do not use" block is not lifted by editing the profile.
  if (loaded.candidate.profileStatus === 'Do Not Use') delete picked.profileStatus;
  if (loaded.candidate.profileStatus === 'Archived') delete picked.profileStatus; // cand7_: bring back via /unarchive
  const candidate = await prisma.candidate.update({ where: { id: req.params.id }, data: picked });
  markCandidateDirty(candidate.id); // the paged list re-reads this row on its next request
  await writeSourceNote(candidate.id, req.user, req.body, loaded.candidate.source);
  await logAudit({ userId: req.user.id, action: 'Candidate updated', entity: 'Candidate', entityId: candidate.id });
  return res.json({ ...candidate, salaryWarnings: salEdit.warnings });
});

module.exports = router;
// ATS data I/O (utils/atsFacets.js): filter options with counts are counted
// over the pipeline's own rows with its own matcher.
module.exports.pipelineRowsFor = pipelineRowsFor;
module.exports.pipelineRowMatches = pipelineRowMatches;
// resume_ (routes/candidateResumes.js): the same record scope + viewer kind.
module.exports.loadInScope = loadInScope;
module.exports.viewerKind = viewerKind;
// ATS data I/O facets follow the pipeline sub-tab the screen is on.
module.exports.inPipelineSub = inPipelineSub;
module.exports.normaliseViewSub = normaliseViewSub;
module.exports.pagedRowsFor = pagedRowsFor;
module.exports.masterSourceFacet = masterSourceFacet;
// routes/candidateSources.js (the Sources tab): the same rows as the People list, the stage history and the data version.
module.exports.peopleFor = peopleFor;
module.exports.reachedMap = reachedMap;
module.exports.scopeSig = scopeSig;
