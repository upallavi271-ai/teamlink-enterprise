// ---------------------------------------------------------------------------
// ONE NEXT ACTION PER ACTIVE APPLICATION — the single derivation every queue
// reads (Candidates & Pipeline queue pills, the dashboard / bell SLA counts,
// the Candidate 360 header, Recruiter & BDE Pending Actions).
//
//   nextActionFor(application[, ctx]) -> {
//     stage, stageLabel, live, internal,
//     action,        what is owed next ("Review Candidate", "Record Feedback" …)
//     ownerRole,     Recruiter | TL | BDE | HR | Dept Head / TL | Accounts | —
//     ownerUserId,   the ONE named owner (see namedOwner() below: open
//                    follow-up owner → the person the requirement names for
//                    the role, a BDE step falling back to the client's Owner
//                    BDE → the person the work is attributed to, active
//                    logins only), or null = "No owner named"
//     ownerName,
//     ownerSource,   'follow-up' | 'assigned' | 'client owner' | 'attributed' | null
//     waitingOn,     'Client' while the move sits with the client (the BDE
//                    chases), otherwise null
//     dueAt,         'YYYY-MM-DD' (IST day) or null
//     dueSource,     'follow-up' | 'stage-sla' | null
//     enteredAt,     when the application REALLY entered its current stage
//     dueStatus,     'overdue' | 'due_today' | 'upcoming' | 'no_due' | 'closed'
//   }
//
// THE DUE DATE (user spec 2026-09-29 §5 — "based on an actual next-action due
// date, not candidate age"):
//   1. an OPEN follow-up's due date (a person committed to it), else
//   2. the stage SLA: the day the application entered its current stage + the
//      stage's SLA days (atsVocab STAGE_OWNER_ACTION.days). "Entered" is the
//      latest ApplicationStageEvent INTO the current stage written by a person
//      in TeamLink (actorUserId set, fromStage != toStage — a stage move, an
//      "Added to pipeline", a Send to ATS).
//   3. DEFAULT DUE DATE FOR EVERY STAGE (dashboard review 2026-10-03 §A3):
//      when the real stage-entry time is unknown (rows imported from the
//      recruitment sheets with their stage already set), the BEST AVAILABLE
//      date stands in for it, in this order: the latest stage event into
//      the current stage (any actor, the import's back-dated history) → the
//      latest follow-up on the application (its contact / created date) →
//      the application's updatedAt → its createdAt. A date that falls on a
//      BULK-IMPORT DAY (BULK_DAY_MIN+ applications created / updated or
//      stage events written on one IST day) is the import's own stamp, not
//      a hiring date, and is used only when nothing else exists. So every
//      live application has a due date ('no_due' only when no date exists).
//      Interview Scheduled is due ON the interview date; Offer Accepted on
//      the joining date + 1 (STAGE_SLA below — the one place to change).
//   Overdue  = dueAt <  today (IST) and the application is still pending.
//   Due Today = dueAt == today (IST).
//   STALE (§A4) = would be Overdue, but nothing has happened on it for more
//      than STALE_AFTER_DAYS (stage entry / any recorded action / follow-up /
//      interview date): the old imported backlog. Reported as dueStatus
//      'stale' — NOT counted Overdue anywhere (atsVocab.applicationIsOverdue
//      reads this module) — and shown in its own Stale bucket. A row whose
//      only date is the bulk import's stamp (imported backlog of unknown
//      age, nobody has acted on it since) is Stale as soon as it is past due.
//
// NEW / UNREVIEWED: the application entered the viewer's workflow (a real
// stage entry / Send to ATS / added by a person) and nobody has acted on it
// since — no stage move, screening step, note, call / message or follow-up
// after that moment. Imported rows have no entry moment, so they are not "new".
//
// CLIENT FEEDBACK PENDING: a CLIENT application whose client interview is done
// (Interview Completed, or Interview Scheduled with the interview marked
// Completed / Pending Feedback) and no client feedback is recorded — no Client
// InterviewFeedback row, no interview result, interview status not Feedback
// Submitted. (Imported sheet notes in interviewFeedback are not a feedback
// decision.)
//
// Data: one small in-memory snapshot (real stage events, open follow-ups,
// last-action times, client-feedback ids), re-read only when a cheap stamp
// changes and at most every STAMP_TTL_MS. ensureNextActionContext() refreshes
// it; the sync functions read the latest snapshot. Registered into
// atsVocab.applicationDueDate / applicationIsOverdue so every existing SLA
// counter (dashboard, bell, requirements, clients, workload) reads the same
// rule without being rewritten.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./atsVocab');

const IST_OFFSET_MS = 330 * 60000;
const DAY_MS = 86400000;
const STAMP_TTL_MS = 5000;
const istDay = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
};
const todayIst = () => istDay(Date.now());
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const CLOSED_STAGES = ['REJECTED', 'JOINED', 'HIRED'];
const INTERNAL_HIRE = 'TeamLink Internal Hire';

// ---------------------------------------------------------------------------
// THE STAGE SLA — the ONE place the default due date of every stage is set
// (dashboard review 2026-10-03 §A3). A number = days after the application
// entered the stage. { anchor } = the due date is that date of the
// application (+ days); without that date, `fallback` days after entry.
// ---------------------------------------------------------------------------
const STAGE_SLA = {
  NEW: 1,
  AI_INTERVIEW_REQUIRED: 1,
  AI_INTERVIEW_SCHEDULED: 2,
  AI_INTERVIEW_COMPLETED: 1,
  RECRUITER_REVIEW: 2,
  RECRUITER_APPROVED: 1,
  TL_REVIEW: 1,
  WITH_BDE: 1, // BDE Review
  BDE_APPROVED: 1,
  SHARED_WITH_CLIENT: 3, // Client Review
  CLIENT_REVIEW: 3,
  CLIENT_SHORTLISTED: 2,
  INTERVIEW_SCHEDULED: { anchor: 'interviewAt', days: 0, fallback: 2 }, // the interview date
  INTERVIEW_COMPLETED: 2, // feedback
  SELECTED: 3, // → offer
  OFFER: 3,
  OFFER_ACCEPTED: { anchor: 'joiningDate', days: 1, fallback: 2 }, // joining date + 1
  HOLD: 5,
};
// Older than this with nothing happening = Stale, not Overdue (§A4).
const STALE_AFTER_DAYS = Math.max(1, Number(process.env.ATS_STALE_AFTER_DAYS) || 30);
// THE ADMIN SETTINGS (spec 2026-10-03 §14, utils/atsAlertSettings.js) win
// over STAGE_SLA above: the default days per step, the clock start (nothing
// that entered a step before it is timed from earlier than that day — so
// switching the defaults on never turns the old backlog Late at once) and the
// Stale threshold. STAGE_SLA stays as the fallback for a stage they do not cover.
const AS = require('./atsAlertSettings');
// B9.2 PER-CLIENT SLA: a client's own "Feedback within N days" wins over the
// Sent-to-client step default (utils/clientSla.js); blank = the default.
const CS = require('./clientSla');
const staleAfterDays = () => (AS.alertSettingsNow().staleAfterDays || STALE_AFTER_DAYS);
// An IST day with at least this many application creates / updates or stage
// events is a bulk import, and its timestamps are not hiring dates.
const BULK_DAY_MIN = 150;

// What is owed next, by stage — the user's workflow list (2026-09-29):
// New → Review Candidate · TL Review → Approve / Reject / Hold · Ready for
// Client → Submit to Client · Client Submitted → Follow up for Client Decision
// · Client Shortlisted → Schedule Client Interview · Interview Scheduled →
// Confirm Interview · Interview Completed → Record Feedback · Selected →
// Prepare / Send Offer. Owner roles follow atsVocab STAGE_OWNER_ACTION, with a
// stage waiting on the client owned by the BDE who chases it.
const CLIENT_CHAIN = {
  NEW: ['Review Candidate', 'Recruiter'],
  AI_INTERVIEW_REQUIRED: ['Send AI Interview', 'Recruiter'],
  AI_INTERVIEW_SCHEDULED: ['Await AI Interview', 'Recruiter'],
  AI_INTERVIEW_COMPLETED: ['Review Candidate', 'Recruiter'],
  RECRUITER_REVIEW: ['Send to TL', 'Recruiter'],
  RECRUITER_APPROVED: ['Send to TL', 'Recruiter'],
  TL_REVIEW: ['Approve / Reject / Hold', 'TL'],
  WITH_BDE: ['Submit to Client', 'BDE'],
  BDE_APPROVED: ['Submit to Client', 'BDE'],
  SHARED_WITH_CLIENT: ['Follow up for Client Decision', 'BDE', 'Client'],
  CLIENT_REVIEW: ['Follow up for Client Decision', 'BDE', 'Client'],
  CLIENT_SHORTLISTED: ['Schedule Client Interview', 'BDE'],
  INTERVIEW_SCHEDULED: ['Confirm Interview', 'BDE', 'Client'],
  INTERVIEW_COMPLETED: ['Record Feedback', 'BDE', 'Client'],
  SELECTED: ['Prepare / Send Offer', 'Recruiter'],
  OFFER: ['Follow Up Offer', 'Recruiter'],
  OFFER_ACCEPTED: ['Confirm Joining', 'Recruiter'],
  JOINED: ['Raise Invoice / Track Guarantee', 'Accounts'],
  HIRED: ['No Action', '—'],
  HOLD: ['Review Hold', 'Recruiter'],
  REJECTED: ['No Action', '—'],
};
// Internal chain: HR Review → Dept Head / TL → Interview → Feedback →
// Selected → Offer → Joining → HRMS.
const INTERNAL_CHAIN = {
  NEW: ['HR Review', 'HR'],
  AI_INTERVIEW_REQUIRED: ['HR Review', 'HR'],
  AI_INTERVIEW_SCHEDULED: ['HR Review', 'HR'],
  AI_INTERVIEW_COMPLETED: ['HR Review', 'HR'],
  RECRUITER_REVIEW: ['Send to Dept Head / TL', 'HR'],
  RECRUITER_APPROVED: ['Send to Dept Head / TL', 'HR'],
  TL_REVIEW: ['Approve → Interview / Reject', 'Dept Head / TL'],
  INTERVIEW_SCHEDULED: ['Confirm Interview', 'HR'],
  INTERVIEW_COMPLETED: ['Record Feedback', 'Dept Head / TL'],
  SELECTED: ['Prepare / Send Offer', 'HR'],
  OFFER: ['Follow Up Offer', 'HR'],
  OFFER_ACCEPTED: ['Confirm Joining', 'HR'],
  JOINED: ['Create HRMS Employee', 'HR'],
  HIRED: ['No Action', '—'],
  HOLD: ['Review Hold', 'HR'],
  REJECTED: ['No Action', '—'],
};

function isInternal(app) {
  if (!app) return false;
  if (app.hiringType) return app.hiringType === INTERNAL_HIRE;
  const r = app.requirement || {};
  return !!r.internal || r.hiringType === INTERNAL_HIRE;
}

// --- The snapshot ------------------------------------------------------------
let SNAP = {
  builtAt: 0, loaded: false, stamp: null, checkedAt: 0,
  entries: new Map(), // appId -> { stage, at } latest real entry into each stage (keyed appId|stage)
  lastAction: new Map(), // appId -> latest real action time (ms)
  candAction: new Map(), // candidateId -> latest candidate-level action time (ms)
  openFu: new Map(), // appId -> open follow-up
  clientFeedback: new Set(), // appIds with a Client InterviewFeedback row
  activeUsers: new Map(), // userId -> name, active logins only (no test accounts)
  nameToId: new Map(), // unique active name (lower-case) -> userId
  anyEntries: new Map(), // appId|stage -> latest stage event into it, ANY actor (ms)
  fuActivity: new Map(), // appId -> latest follow-up contact / created date (ms)
  appDates: new Map(), // live appId -> { createdAt, updatedAt, interviewAt, joiningDate }
  bulkDays: new Set(), // IST days of bulk imports
};
let inflight = null;

async function stampNow() {
  const [ev, fu, notes, msgs, fb, aud, users, apps] = await Promise.all([
    prisma.applicationStageEvent.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.applicationFollowUp.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.candidateNote.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.candidateMessage.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.interviewFeedback.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.auditLog.aggregate({ where: { entity: { in: ['Candidate', 'Application'] } }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
    // The applications' own dates (interview / joining date, created) feed
    // the default due date.
    prisma.application.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  const t = (d) => (d ? new Date(d).getTime() : 0);
  const people = users.map((u) => `${u.status}:${u._count._all}`).sort().join(',');
  return [ev._count._all, t(ev._max.createdAt), fu._count._all, t(fu._max.updatedAt), notes._count._all, t(notes._max.createdAt),
    msgs._count._all, t(msgs._max.createdAt), fb._count._all, t(fb._max.updatedAt), aud._count._all, t(aud._max.createdAt), people,
    apps._count._all, t(apps._max.updatedAt)].join('|');
}

const CONTACT_AUDIT = /^(Called|Call |WhatsApp|Email|SMS|Follow-up|Note|Bulk )/i;
const bump = (map, key, ms) => { if (key && ms && (!map.has(key) || map.get(key) < ms)) map.set(key, ms); };

async function build(stamp, t0 = Date.now()) {
  await CS.refresh().catch(() => {}); // B9.2: per-client SLA numbers, read synchronously below
  const [allEvents, openFus, userFus, notes, msgs, fbs, audits, users, allFus, allApps] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      select: { applicationId: true, fromStage: true, toStage: true, createdAt: true, actorUserId: true },
    }),
    prisma.applicationFollowUp.findMany({
      where: { completedAt: null },
      select: {
        id: true, applicationId: true, dueDate: true, dueTime: true, ownerUserId: true, ownerName: true, ownerRole: true,
        nextAction: true, autoCreated: true, createdAt: true, updatedAt: true, createdById: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    // A follow-up a PERSON recorded or completed is an action on the application.
    prisma.applicationFollowUp.findMany({
      where: { OR: [{ createdById: { not: null } }, { completedById: { not: null } }] },
      select: { applicationId: true, createdAt: true, completedAt: true, autoCreated: true, createdById: true, completedById: true },
    }),
    prisma.candidateNote.findMany({ select: { candidateId: true, applicationId: true, createdAt: true } }),
    prisma.candidateMessage.findMany({
      where: { senderUserId: { not: null } },
      select: { candidateId: true, applicationId: true, trigger: true, createdAt: true },
    }),
    prisma.interviewFeedback.findMany({ where: { kind: 'Client' }, select: { applicationId: true } }),
    prisma.auditLog.findMany({
      where: { entity: { in: ['Candidate', 'Application'] }, userId: { not: null } },
      select: { entity: true, entityId: true, action: true, createdAt: true },
    }),
    prisma.user.findMany({ select: { id: true, name: true, email: true, status: true } }),
    // Every follow-up's own dates (imported ones keep their real contact date).
    prisma.applicationFollowUp.findMany({ select: { applicationId: true, createdAt: true, lastContactedAt: true } }),
    prisma.application.findMany({
      select: { id: true, stage: true, createdAt: true, updatedAt: true, interviewAt: true, joiningDate: true },
    }),
  ]);
  const events = allEvents.filter((e) => e.actorUserId);
  // BULK-IMPORT DAYS: an IST day with BULK_DAY_MIN+ application creates,
  // application updates or stage events is an import, not hiring activity.
  const perDay = new Map();
  const tallyDay = (kind, v) => { const k = `${kind}|${istDay(v)}`; perDay.set(k, (perDay.get(k) || 0) + 1); };
  allApps.forEach((a) => { tallyDay('c', a.createdAt); tallyDay('u', a.updatedAt); });
  allEvents.forEach((e) => tallyDay('e', e.createdAt));
  const bulkDays = new Set();
  perDay.forEach((n, k) => { if (n >= BULK_DAY_MIN) bulkDays.add(k.split('|')[1]); });
  const anyEntries = new Map();
  allEvents.forEach((e) => {
    if (e.fromStage && e.fromStage === e.toStage) return;
    const k = `${e.applicationId}|${e.toStage}`;
    const ms = new Date(e.createdAt).getTime();
    // Prefer a real (non-bulk) date; among those the latest.
    const cur = anyEntries.get(k);
    const real = !bulkDays.has(istDay(ms));
    if (!cur || (real && (!cur.real || cur.ms < ms)) || (!real && !cur.real && cur.ms < ms)) anyEntries.set(k, { ms, real });
  });
  const fuActivity = new Map();
  allFus.forEach((f) => {
    const ms = Math.max(f.createdAt ? new Date(f.createdAt).getTime() : 0, f.lastContactedAt ? new Date(f.lastContactedAt).getTime() : 0);
    if (!ms || ms > Date.now() + DAY_MS) return;
    const cur = fuActivity.get(f.applicationId);
    const real = !bulkDays.has(istDay(ms));
    if (!cur || (real && (!cur.real || cur.ms < ms)) || (!real && !cur.real && cur.ms < ms)) fuActivity.set(f.applicationId, { ms, real });
  });
  const appDates = new Map();
  allApps.forEach((a) => {
    if (CLOSED_STAGES.includes(a.stage)) return;
    appDates.set(a.id, { createdAt: a.createdAt, updatedAt: a.updatedAt, interviewAt: a.interviewAt, joiningDate: a.joiningDate });
  });
  // THE OWNER DIRECTORY: only people with an ACTIVE login can own a next
  // action. Test / demo accounts (ZZTEST, @example.test) are never resolved
  // as owners (agent rules, 2026-09-29 lesson). nameToId holds only names
  // that are unique among active logins.
  const activeUsers = new Map();
  const nameCount = new Map();
  users.forEach((u) => {
    const tag = `${u.name || ''} ${u.email || ''}`;
    if (u.status !== 'Active' || /zztest|example\.test/i.test(tag)) return;
    activeUsers.set(u.id, u.name);
    const k = String(u.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (k) nameCount.set(k, (nameCount.get(k) || []).concat(u.id));
  });
  const nameToId = new Map();
  nameCount.forEach((ids, k) => { if (ids.length === 1) nameToId.set(k, ids[0]); });
  const entries = new Map();
  const lastAction = new Map();
  const candAction = new Map();
  events.forEach((e) => {
    const ms = new Date(e.createdAt).getTime();
    bump(lastAction, e.applicationId, ms);
    if (e.fromStage && e.fromStage === e.toStage) return; // a screening step, not a stage entry
    const k = `${e.applicationId}|${e.toStage}`;
    if (!entries.has(k) || entries.get(k) < ms) entries.set(k, ms);
  });
  const openFu = new Map();
  openFus.forEach((f) => { if (!openFu.has(f.applicationId)) openFu.set(f.applicationId, f); });
  userFus.forEach((f) => {
    if (f.createdById && !f.autoCreated) bump(lastAction, f.applicationId, new Date(f.createdAt).getTime());
    if (f.completedById && f.completedAt) bump(lastAction, f.applicationId, new Date(f.completedAt).getTime());
  });
  notes.forEach((n) => {
    const ms = new Date(n.createdAt).getTime();
    if (n.applicationId) bump(lastAction, n.applicationId, ms); else bump(candAction, n.candidateId, ms);
  });
  msgs.forEach((m) => {
    if (/^Stage change/i.test(m.trigger || '')) return; // sent by the move itself
    const ms = new Date(m.createdAt).getTime();
    if (m.applicationId) bump(lastAction, m.applicationId, ms); else bump(candAction, m.candidateId, ms);
  });
  audits.forEach((a) => {
    if (!CONTACT_AUDIT.test(a.action || '')) return;
    const ms = new Date(a.createdAt).getTime();
    if (a.entity === 'Application') bump(lastAction, a.entityId, ms); else bump(candAction, a.entityId, ms);
  });
  SNAP = {
    builtAt: t0, loaded: true, stamp, checkedAt: Date.now(),
    entries, lastAction, candAction, openFu, clientFeedback: new Set(fbs.map((f) => f.applicationId)),
    activeUsers, nameToId, anyEntries, fuActivity, appDates, bulkDays,
  };
  return SNAP;
}

// SPEED (2026-10-03): when the data changed, the snapshot used to be re-read
// INSIDE the request that noticed it (~3 s, every change). Now that request
// is answered from the snapshot in hand — at most a few seconds old, which
// every reader here already allows for (STAMP_TTL_MS, and stageEnteredAt()'s
// "moved after the snapshot was built" rule) — and the new one is built in
// the background. build() swaps it in with one assignment, so a reader never
// sees half of each. The very first snapshot is still awaited, and
// ensureNextActionContext({ fresh: true }) still waits for a current one
// (the escalation sweep, which tells people about late work, uses that).
let building = null;
async function refresh() {
  if (SNAP.loaded && Date.now() - SNAP.checkedAt < STAMP_TTL_MS) return SNAP;
  if (building) return SNAP.loaded ? SNAP : building;
  await AS.loadAlertSettings().catch(() => null);
  // builtAt = the moment the data is known to be current: nothing that could
  // change an entry happened before it without changing the stamp.
  const t0 = Date.now();
  const stamp = await stampNow();
  if (SNAP.loaded && stamp === SNAP.stamp) { SNAP.checkedAt = Date.now(); SNAP.builtAt = t0; return SNAP; }
  if (!building) {
    building = build(stamp, t0).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[nextAction] snapshot build failed:', err.message);
      return SNAP;
    }).finally(() => { building = null; });
  }
  return SNAP.loaded ? SNAP : building;
}

function sharedRefresh() {
  if (inflight) return inflight;
  inflight = refresh().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[nextAction] snapshot refresh failed:', err.message);
    return SNAP;
  }).finally(() => { inflight = null; });
  return inflight;
}

// Await before a burst of nextActionFor() calls; concurrent callers share one read.
async function ensureNextActionContext({ fresh = false } = {}) {
  const snap = await sharedRefresh();
  if (!fresh || !building) return snap;
  await building;
  return sharedRefresh();
}

// --- The derivation -----------------------------------------------------------
// When did this application really enter its current stage? (ms or null)
function stageEnteredAt(app, snap = SNAP) {
  if (!app || !app.id || !app.stage) return null;
  const hit = snap.entries.get(`${app.id}|${app.stage}`);
  // Send to ATS is the moment a Job Portal application enters the ATS
  // workflow (its screening events do not change the stage).
  const imported = app.portalImportedAt ? new Date(app.portalImportedAt).getTime() : 0;
  if (hit) return Math.max(hit, imported);
  if (imported && !V.isPreAtsApplication(app)) return imported;
  // The snapshot is a few seconds old and this row moved after it was built:
  // the move just happened in TeamLink, so its updatedAt is the entry time.
  const upd = app.updatedAt ? new Date(app.updatedAt).getTime() : 0;
  if (snap.loaded && upd > snap.builtAt) return upd;
  return null;
}

// The application's own dates: the row the caller passed wins, the snapshot
// fills what its select left out.
const msOf = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return Number.isNaN(t) ? 0 : t; };
function appDatesOf(app, snap) {
  const s = snap.appDates.get(app.id) || {};
  const pick = (k) => (Object.prototype.hasOwnProperty.call(app, k) ? app[k] : s[k]);
  return { createdAt: msOf(pick('createdAt')), updatedAt: msOf(pick('updatedAt')), interviewAt: msOf(pick('interviewAt')), joiningDate: pick('joiningDate') || null };
}

// When did it (probably) enter its current stage? The real entry, else the
// best available date (see the header): { ms, estimated, source }.
function entryEstimate(app, snap = SNAP) {
  const real = stageEnteredAt(app, snap);
  if (real) return { ms: real, estimated: false, source: 'stage-entry' };
  if (!app || !app.id) return { ms: null, estimated: true, source: null };
  const d = appDatesOf(app, snap);
  const ev = snap.anyEntries.get(`${app.id}|${app.stage}`);
  const fu = snap.fuActivity.get(app.id);
  const bulk = (ms) => snap.bulkDays.has(istDay(ms));
  const cands = [
    ['stage-event', ev ? ev.ms : 0],
    ['follow-up', fu ? fu.ms : 0],
    ['updated', d.updatedAt],
    ['created', d.createdAt],
  ].filter(([, ms]) => ms);
  const good = cands.find(([, ms]) => !bulk(ms));
  if (good) return { ms: good[1], estimated: true, source: good[0] };
  if (cands.length) return { ms: Math.max(...cands.map((c) => c[1])), estimated: true, source: 'import' };
  return { ms: null, estimated: true, source: null };
}

// The most recent sign of life on the application (for Stale): its stage
// entry, any recorded action, a follow-up, a past interview date.
function lastSignOfLife(app, enteredMs, snap = SNAP) {
  const d = appDatesOf(app, snap);
  const fu = snap.fuActivity.get(app.id);
  const now = Date.now();
  return Math.max(
    enteredMs || 0,
    snap.lastAction.get(app.id) || 0,
    fu && fu.real ? fu.ms : 0,
    d.interviewAt && d.interviewAt <= now ? d.interviewAt : 0,
  );
}

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

// WHO OWNS THE STEP, in order (each a person with a login):
//   1. the open follow-up's owner (who was actually handed it)
//   2. the person the requirement names for the stage's role — Recruiter /
//      HR: recruiterId (or the first of recruiterIds); TL / Dept Head: tlId;
//      BDE: bdeId, else the CLIENT's Owner BDE (Client.bdeOwner, resolved by
//      name to an active login), else the requirement's recruiter
//   3. the person the work is ATTRIBUTED to for that role (ctx.attributed =
//      { recruiter, tl, bde } each { userId, name } — utils/workers.js
//      attribute(), or the application's latest follow-up), ACTIVE logins only
//   4. nobody: ownerUserId / ownerName null ("No owner named")
const ROLE_KEY = { Recruiter: 'recruiter', HR: 'recruiter', TL: 'tl', 'Dept Head / TL': 'tl', BDE: 'bde' };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function clientOwnerId(r, snap) {
  const owner = r && r.client && r.client.bdeOwner;
  return owner ? snap.nameToId.get(normName(owner)) || null : null;
}
function namedOwner(role, r, snap) {
  if (!r) return { id: null, name: null, source: null };
  const rec = { id: r.recruiterId || String(r.recruiterIds || '').split(',').filter(Boolean)[0] || null, name: (r.recruiter && r.recruiter.name) || null };
  if (role === 'Recruiter' || role === 'HR') return rec.id ? { ...rec, source: 'assigned' } : { id: null, name: null, source: null };
  if (role === 'TL' || role === 'Dept Head / TL') {
    return r.tlId ? { id: r.tlId, name: (r.tl && typeof r.tl === 'object' ? r.tl.name : r.tl) || snap.activeUsers.get(r.tlId) || null, source: 'assigned' } : { id: null, name: null, source: null };
  }
  if (role === 'BDE') {
    if (r.bdeId) return { id: r.bdeId, name: (r.bde && r.bde.name) || snap.activeUsers.get(r.bdeId) || null, source: 'assigned' };
    const co = clientOwnerId(r, snap);
    if (co) return { id: co, name: r.client.bdeOwner, source: 'client owner' };
    if (rec.id) return { ...rec, source: 'assigned' };
  }
  return { id: null, name: null, source: null };
}

function nextActionFor(app, ctx = {}) {
  const snap = ctx.snapshot || SNAP;
  const today = ctx.today || todayIst();
  const stage = app && app.stage;
  const internal = isInternal(app);
  const [action, ownerRole, waitingOn] = (internal ? INTERNAL_CHAIN[stage] || CLIENT_CHAIN[stage] : CLIENT_CHAIN[stage]) || ['—', '—'];
  const live = !!stage && !CLOSED_STAGES.includes(stage);
  const r = app && app.requirement;
  const fu = ctx.followUp !== undefined ? ctx.followUp : (app && app.id ? snap.openFu.get(app.id) || null : null);
  const openFu = fu && !fu.completedAt ? fu : null;
  const enteredMs = stageEnteredAt(app, snap);
  const est = live ? entryEstimate(app, snap) : { ms: enteredMs, estimated: false, source: null };
  let dueAt = null;
  let dueSource = null;
  if (live) {
    if (openFu && openFu.dueDate) { dueAt = String(openFu.dueDate).slice(0, 10); dueSource = 'follow-up'; } else {
      const set = AS.stageRule(stage);
      // B9.2: the client's own feedback promise on the Sent-to-client step.
      if (set && set.group === 'client' && r && r.clientId) {
        const own = CS.feedbackDaysNow(r.clientId);
        if (own != null) set.days = own;
      }
      const sla = STAGE_SLA[stage];
      const rule = set
        ? (set.anchor ? { anchor: set.anchor, days: set.days, fallback: (sla && sla.fallback) || 2 } : set.days)
        : sla;
      const d = appDatesOf(app, snap);
      // The step's clock starts when it was entered — but never before the
      // day the default due dates were switched on (settings.startedOn).
      const started = AS.alertSettingsNow().startedOn;
      const from = (ms) => { const day = istDay(ms); return day && started && day < started ? started : day; };
      if (rule && typeof rule === 'object') {
        const anchorDay = rule.anchor === 'interviewAt'
          ? (d.interviewAt ? istDay(d.interviewAt) : null)
          : ((ISO_DAY.exec(String(d.joiningDate || '')) || [])[1] || null);
        if (anchorDay) { dueAt = addDays(anchorDay, rule.days); dueSource = rule.anchor === 'interviewAt' ? 'interview-date' : 'joining-date'; } else if (est.ms) {
          dueAt = addDays(from(est.ms), rule.fallback); dueSource = 'stage-sla';
        }
      } else if (Number.isFinite(rule) && est.ms) { dueAt = addDays(from(est.ms), rule); dueSource = 'stage-sla'; }
    }
  }
  let dueStatus = 'closed';
  let staleDays = null;
  if (live) {
    if (!dueAt) dueStatus = 'no_due';
    else if (dueAt < today) dueStatus = 'overdue';
    else if (dueAt === today) dueStatus = 'due_today';
    else dueStatus = 'upcoming';
    // STALE: nothing has happened on it for more than staleAfterDays (the
    // old imported backlog) — whatever its due date says, unless a real date
    // still lies ahead (an interview, a joining day, a follow-up). A row
    // whose ONLY date is the bulk import's stamp is imported backlog of
    // unknown age: the stamp is not a sign of life.
    const ahead = dueAt && dueAt >= today && ['follow-up', 'interview-date', 'joining-date'].includes(dueSource);
    if (dueStatus !== 'no_due' && !ahead) {
      const since = lastSignOfLife(app, est.source === 'import' ? 0 : est.ms, snap);
      const quiet = since ? Math.floor((new Date(`${today}T00:00:00Z`) - new Date(`${istDay(since)}T00:00:00Z`)) / DAY_MS) : null;
      if (quiet == null || quiet > staleAfterDays()) { dueStatus = 'stale'; staleDays = quiet; }
    }
  }
  let ownerUserId = null;
  let ownerName = null;
  let ownerSource = null;
  if (live) {
    if (openFu && openFu.ownerUserId) {
      ownerUserId = openFu.ownerUserId; ownerName = openFu.ownerName || snap.activeUsers.get(openFu.ownerUserId) || null; ownerSource = 'follow-up';
    } else {
      const named = namedOwner(ownerRole, r, snap);
      if (named.id) { ownerUserId = named.id; ownerName = named.name || snap.activeUsers.get(named.id) || null; ownerSource = named.source; } else {
        const attributed = ctx.attributed || (ctx.workedBy ? { recruiter: ctx.workedBy } : null);
        const who = attributed && attributed[ROLE_KEY[ownerRole]];
        if (who && who.userId && snap.activeUsers.has(who.userId)) {
          ownerUserId = who.userId; ownerName = snap.activeUsers.get(who.userId) || who.name || null; ownerSource = 'attributed';
        }
      }
    }
  }
  return {
    stage: stage || null,
    stageLabel: stage ? V.stageLabelFor(stage, { internal }) : null,
    live,
    internal,
    action: live ? ((openFu && openFu.nextAction) || action) : action,
    ownerRole: live ? ((openFu && openFu.ownerRole) || ownerRole) : '—',
    ownerUserId,
    ownerName,
    ownerSource,
    waitingOn: live && waitingOn ? waitingOn : null,
    dueAt,
    dueSource,
    // true when the stage-entry date behind a stage-SLA due date is the best
    // available date, not a recorded stage move.
    dueEstimated: dueSource === 'stage-sla' && !!est.estimated,
    entrySource: est.source || null,
    // The REAL stage entry only (New / Unreviewed reads it).
    enteredAt: enteredMs ? new Date(enteredMs).toISOString() : null,
    dueStatus, // 'overdue' | 'due_today' | 'upcoming' | 'stale' | 'no_due' | 'closed'
    staleDays,
  };
}

// Bulk variant: Map(appId -> nextActionFor(app)). Call after
// ensureNextActionContext(); `today` is fixed once for the whole batch.
function nextActionsForApps(apps, ctx = {}) {
  const today = ctx.today || todayIst();
  const out = new Map();
  (apps || []).forEach((a) => { if (a && a.id) out.set(a.id, nextActionFor(a, { ...ctx, today })); });
  return out;
}

// --- Viewer-relative predicates --------------------------------------------------
const ROLE_OF_ATS = {
  RECRUITER: ['Recruiter'], TL: ['TL', 'Dept Head / TL'], STL: ['TL', 'Dept Head / TL'],
  BDE: ['BDE'], HR: ['HR'], ACCOUNTANT: ['Accounts'],
};
// Is the next move on this application the viewer's? The named owner, or —
// where the requirement names nobody for that role — a viewer holding that
// role inside whose scope the application already is (callers pass rows that
// are already scope-filtered).
function needsActionBy(app, na, viewer) {
  if (!na || !na.live || !viewer) return false;
  if (na.ownerUserId) return na.ownerUserId === viewer.id;
  const roles = ROLE_OF_ATS[viewer.atsRole] || [];
  return roles.includes(na.ownerRole);
}

// Entered the viewer's workflow and nobody has acted since.
function isNewUnreviewed(app, na, viewer, snap = SNAP) {
  if (!needsActionBy(app, na, viewer) || !na.enteredAt) return false;
  const entered = new Date(na.enteredAt).getTime();
  const grace = 2000; // the move's own side effects land within a second or two
  const last = Math.max(snap.lastAction.get(app.id) || 0, snap.candAction.get(app.candidateId) || 0);
  return !(last > entered + grace);
}

const FEEDBACK_DONE_STATUSES = ['FEEDBACK_SUBMITTED'];
function isClientFeedbackPending(app, snap = SNAP) {
  if (!app || isInternal(app)) return false;
  const done = app.stage === 'INTERVIEW_COMPLETED'
    || (app.stage === 'INTERVIEW_SCHEDULED' && ['COMPLETED', 'PENDING_FEEDBACK'].includes(app.interviewStatus));
  if (!done) return false;
  if (snap.clientFeedback.has(app.id)) return false;
  if (app.interviewResult) return false;
  if (FEEDBACK_DONE_STATUSES.includes(app.interviewStatus)) return false;
  return true;
}

// Interview date + days waiting for the Client Feedback Pending list.
function feedbackWait(app, na, today = todayIst()) {
  const at = app.interviewCompletedAt || app.interviewAt || (na && na.enteredAt) || null;
  const day = istDay(at);
  const days = day ? Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${day}T00:00:00Z`)) / 86400000)) : null;
  return { interviewDate: at, daysWaiting: days };
}

// --- Plug into atsVocab so every existing SLA counter reads this rule ----------
if (typeof V.setDueDateResolver === 'function') {
  // Third argument: "is it Overdue?" — a Stale row is past its date but is
  // NOT Overdue (it sits in the Stale bucket).
  V.setDueDateResolver((app) => nextActionFor(app).dueAt, todayIst, (app) => nextActionFor(app).dueStatus === 'overdue');
}
// Warm the snapshot at start-up (non-blocking).
setTimeout(() => { ensureNextActionContext(); }, 1500).unref?.();

module.exports = {
  ensureNextActionContext,
  nextActionFor,
  nextActionsForApps,
  needsActionBy,
  isNewUnreviewed,
  isClientFeedbackPending,
  feedbackWait,
  stageEnteredAt,
  entryEstimate,
  STAGE_SLA,
  STALE_AFTER_DAYS,
  staleAfterDays,
  isInternal,
  todayIst,
  istDay,
  CLIENT_CHAIN,
  INTERNAL_CHAIN,
  snapshot: () => SNAP,
};
