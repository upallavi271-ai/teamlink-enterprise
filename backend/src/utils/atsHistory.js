// ---------------------------------------------------------------------------
// ATS HISTORY (founder 2026-11-18): "when I search a requirement or a client the COMPLETE history must come up: how many profiles
// were shared, selected, joined, dropped, when each one joined, with dates - clear at a glance."
//
// READ ONLY. Nothing here writes a business row (only CREATE INDEX IF NOT EXISTS, once).
//
//   requirementHistory(user, id, q)  header + funnel + candidate-by-candidate rows + timeline for ONE requirement
//   clientHistory(user, id, q)       the same funnel across all the client's requirements, joinings, drop reasons, agreements,
//                                    one row per requirement, billing (only for a login that already sees invoice amounts)
//   search(user, text)               clients (by name or an OLD name) and requirements (title / code / client) with headline numbers
//   tableOf(...)                     the Excel / CSV rows
//
// WHERE THE DATES COME FROM (never invented):
//   Application.createdAt                        Sourced (exact)
//   ApplicationStageEvent                        the FIRST time the application entered each step (exact). When a step has no event of
//                                                its own but a LATER step has (old or imported data, or a step that was skipped), the
//                                                earliest later event is used and the date is marked "estimated"; with no event at all the
//                                                application's last update is used, also marked. A date that cannot be found is empty.
//   InterviewEvent / Application.interviewAt     interview booked, interview dates
//   OfferVersion / Application.offerDate / offerAcceptedAt   offer released / accepted
//   creditedJoinings (utils/recruiterJoinings.js) JOINED. THE ONE function the dashboard card, My results and the reports read: the
//                                                joining day and who gets the credit are its answer, so History joined == dashboard joined
//   JoiningRecord (joindrop)                     left after joining: day, reason, who reported it
//
// DROPPED (one definition, dropOf() below, shown on the page): out of this requirement without joining - rejected at any step (by the
// recruiter, the team lead, the BDE, TeamLink or the client), the candidate withdrew / declined / did not attend / did not join, or the
// person LEFT AFTER JOINING. Each candidate is counted once, by where they stand now. A person who joined and left but whose step still
// says Joined keeps counting as Joined (a drop never changes a past count - utils/recruiterJoinings.js) and is listed as "left after
// joining" beside the Joined number, never silently dropped from one number into another.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const SC = require('./scope');
const V = require('./atsVocab');
const RJ = require('./recruiterJoinings');
const MPH = require('./multiParam'); // several recruiters / several statuses in one filter (founder 2026-11-20)

const IST = 330 * 60000;
const JOINED = ['JOINED', 'HIRED'];
const TEST_RE = /zztest|example\.test/i; // utils/atsHome.js isTest (the dashboard's own rule)
const LEFT_STATUS = [V.JOINING_REPLACEMENT_DUE, V.JOINING_REPLACED, V.JOINING_LEFT_AFTER_GUARANTEE];
const ORDER = V.STAGE_CODES;
const IDX = new Map(ORDER.map((s, i) => [s, i]));
const idxOf = (s) => (IDX.has(s) ? IDX.get(s) : -1);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : null);
const isoDay = (v) => (DAY_RE.test(String(v || '').slice(0, 10)) && String(v).slice(0, 4) > '2014' && String(v).slice(0, 4) < '2101' ? String(v).slice(0, 10) : null);
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const daysBetween = (a, b) => (a && b ? Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) : null);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- the words ---------------------------------------------------------------------------------------------------------------------
const DEFINITIONS = {
  dropped: 'Dropped = out of this requirement without staying: rejected at any step (by the recruiter, the team lead, the BDE, TeamLink or the client), '
    + 'the candidate withdrew, declined the offer, did not attend or did not join, or joined and then left (left after joining). Each candidate is counted once, by where they stand now; '
    + 'the full trail of what happened stays in the timeline.',
  joined: 'Joined (still working) = candidates at the Joined step with a joining day, credited by the one joinings rule the dashboard and My results use, who have not left. Someone who joined and then left is counted under Dropped (and shown as "left after joining"), not here.',
  funnel: 'Each number counts a candidate who reached that step or went beyond it. The percentage is the share of the step before it.',
};
const DROP_TYPES = {
  tl: 'Rejected by the team lead', bde: 'Rejected by the BDE', recruiter: 'Rejected by the recruiter', teamlink: 'Rejected by TeamLink', client: 'Rejected by the client',
  withdrew: 'Candidate withdrew', declined_offer: 'Candidate declined the offer', no_show: 'Did not attend / did not join', left_after_joining: 'Left after joining',
};

// ---- indexes (once) ----------------------------------------------------------------------------------------------------------------
let indexP = null;
function ensureIndexes() {
  if (!indexP) {
    indexP = (async () => {
      const stmts = [
        'CREATE INDEX IF NOT EXISTS "ApplicationStageEvent_app_to_at" ON "ApplicationStageEvent"("applicationId","toStage","createdAt")',
        'CREATE INDEX IF NOT EXISTS "InterviewEvent_app_at" ON "InterviewEvent"("applicationId","createdAt")',
        'CREATE INDEX IF NOT EXISTS "Application_req_created" ON "Application"("requirementId","createdAt")',
        'CREATE INDEX IF NOT EXISTS "OfferVersion_app" ON "OfferVersion"("applicationId")',
        'CREATE INDEX IF NOT EXISTS "Invoice_client_req" ON "Invoice"("clientId","requirementId")',
      ];
      for (const s of stmts) {
        try { await prisma.$executeRawUnsafe(s); } catch (e) { console.error('[atsHistory] index:', e.message); } // eslint-disable-line no-await-in-loop, no-console
      }
      return true;
    })();
  }
  return indexP;
}

// ---- who may see what --------------------------------------------------------------------------------------------------------------
const testViewer = (user) => TEST_RE.test(`${user.name || ''} ${user.email || ''}`);
const external = (user) => ['CLIENT', 'CANDIDATE'].includes(SC.atsScopeOf(user).atsRole) || ['CLIENT', 'CANDIDATE'].includes(user.role);
// Invoice amounts: only the roles that already see them (Super Admin, Admin, Accounts).
async function mayBilling(user) {
  try {
    const { can } = require('../middleware/auth'); // eslint-disable-line global-require
    const s = SC.scopeOf(user);
    const roleOk = !!s.adminGlobal || s.accountsRole === 'ACCOUNTANT';
    if (!roleOk) return false;
    return !!(await can(user, 'accounts', 'accounts', 'Invoices', 'view'));
  } catch { return false; }
}

// ---- the one definition of "dropped" --------------------------------------------------------------------------------------------------
// evs: the application's stage events (oldest first); rec: its JoiningRecord (or null). -> null when not dropped.
function dropOf(app, evs, rec) {
  const joinedBefore = evs.some((e) => JOINED.includes(e.toStage));
  const leftRec = rec && rec.status === 'Dropped';
  const leftStatus = LEFT_STATUS.includes(app.joiningStatus) || V.leftAfterJoining(app); // V.leftAfterJoining: the shared helper (Joined step + a drop on the Joining or Roll status)
  const rejected = app.stage === 'REJECTED';
  // The offer was declined / the person did not join, recorded on the offer or joining screen: the step stays where it was (no move to Rejected)
  const declinedOffer = !rejected && !JOINED.includes(app.stage) && app.offerStatus === 'Offer Declined';
  const noJoin = !rejected && !JOINED.includes(app.stage) && !joinedBefore && app.joiningStatus === 'Dropped';
  if (!rejected && !leftRec && !leftStatus && (declinedOffer || noJoin)) {
    const ne = [...evs].reverse().find((e) => /^Did not join/i.test(e.action || ''));
    const type = noJoin ? 'no_show' : 'declined_offer';
    const day = noJoin && ne ? istDay(ne.createdAt) : istDay(app.updatedAt);
    return {
      type, typeLabel: DROP_TYPES[type], by: type === 'no_show' && ne ? ne.actorRole || null : 'Candidate', byName: type === 'no_show' && ne ? ne.actorName || null : null,
      stage: app.stage, stageLabel: V.stageLabel(app.stage), reason: (noJoin && ne && ne.comment) || app.offerNotes || null, day, estimated: !(noJoin && ne), stillJoined: false, within: null,
    };
  }
  if (!rejected && !leftRec && !leftStatus) return null;
  const rejEv = [...evs].reverse().find((e) => e.toStage === 'REJECTED');
  const stageNow = JOINED.includes(app.stage);
  // LEFT AFTER JOINING
  if ((leftRec || leftStatus) && (stageNow || joinedBefore || !rejected)) {
    const leftEv = [...evs].reverse().find((e) => /^Left (within|after) the guarantee/i.test(e.action || ''));
    const m = leftEv && /Left on (\d{4}-\d{2}-\d{2}):\s*(.*)$/s.exec(leftEv.comment || '');
    const day = (rec && rec.droppedOn) || (m && m[1]) || (leftEv ? istDay(leftEv.createdAt) : null);
    return {
      type: 'left_after_joining', typeLabel: DROP_TYPES.left_after_joining, by: (rec && (rec.dropReportedFrom || rec.dropReportedByRole)) || (leftEv && leftEv.actorRole) || null,
      byName: (rec && rec.dropReportedByName) || (leftEv && leftEv.actorName) || null, stage: 'JOINED', stageLabel: V.stageLabel('JOINED'),
      reason: [(rec && rec.dropReason) || (m && m[2]) || '', (rec && rec.dropReasonDetail) || ''].filter(Boolean).join(' - ') || null,
      day, estimated: !day, stillJoined: stageNow, within: rec ? rec.dropWithinGuarantee === 1 : (app.joiningStatus === V.JOINING_REPLACEMENT_DUE),
    };
  }
  // REJECTED (any step)
  const side = rejEv && rejEv.actorSide;
  const cat = String((rejEv && rejEv.reasonCategory) || '');
  const role = String((rejEv && rejEv.actorRole) || '').toUpperCase();
  let type;
  if (joinedBefore) type = 'left_after_joining';
  else if (side === 'Candidate') {
    if (/offer declined/i.test(cat) || app.offerStatus === 'Offer Declined') type = 'declined_offer';
    else if (/did not (join|attend)|no.?show/i.test(cat)) type = 'no_show';
    else type = 'withdrew';
  } else if (side === 'Client') type = 'client';
  else if (/^offer declined/i.test(cat) || app.offerStatus === 'Offer Declined') type = 'declined_offer';
  else if (role === 'TL' || role === 'STL') type = 'tl';
  else if (role === 'BDE') type = 'bde';
  else if (role === 'RECRUITER') type = 'recruiter';
  else type = 'teamlink';
  const day = rejEv ? istDay(rejEv.createdAt) : istDay(app.updatedAt);
  const from = rejEv && rejEv.fromStage && rejEv.fromStage !== 'REJECTED' ? rejEv.fromStage : null;
  return {
    type, typeLabel: DROP_TYPES[type], by: rejEv ? (rejEv.actorRole || null) : null, byName: rejEv ? rejEv.actorName || null : null,
    stage: from, stageLabel: from ? V.stageLabel(from) : null,
    reason: [cat, (rejEv && (rejEv.reasonDetail || rejEv.comment)) || ''].filter(Boolean).join(' - ') || null,
    day, estimated: !rejEv, stillJoined: false, within: null,
  };
}

// ---- dates of each step ---------------------------------------------------------------------------------------------------------------
// The first time the application entered one of `codes`; else the earliest LATER step (estimated); else, when it stands at or beyond the step
// now, its last update (estimated); else null.
function firstReach(app, evs, codes, floorCode) {
  const target = idxOf(floorCode || codes[0]);
  const real = evs.filter((e) => e.fromStage !== e.toStage);
  const exact = real.find((e) => codes.includes(e.toStage));
  if (exact) return { day: istDay(exact.createdAt), est: false };
  const later = real.find((e) => idxOf(e.toStage) > target && !['REJECTED', 'HOLD'].includes(e.toStage));
  if (later) return { day: istDay(later.createdAt), est: true };
  if (idxOf(app.stage) >= target && target >= 0) return { day: istDay(app.updatedAt), est: true };
  return null;
}
const reached = (app, evs, floorCode) => {
  const t = idxOf(floorCode);
  return idxOf(app.stage) >= t || evs.some((e) => e.fromStage !== e.toStage && idxOf(e.toStage) >= t);
};

const STEPS = [
  { key: 'sourced', label: 'Profiles sourced', stage: null },
  { key: 'approved', label: 'Approved by recruiter', stage: 'RECRUITER_APPROVED' },
  { key: 'shared', label: 'Sent to client', stage: 'SHARED_WITH_CLIENT' },
  { key: 'shortlisted', label: 'Client shortlisted', stage: 'CLIENT_SHORTLISTED' },
  { key: 'interviewScheduled', label: 'Interviews scheduled', stage: 'INTERVIEW_SCHEDULED' },
  { key: 'interviewDone', label: 'Interviews done', stage: 'INTERVIEW_COMPLETED' },
  { key: 'selected', label: 'Selected', stage: 'SELECTED' },
  { key: 'offerReleased', label: 'Offers released', stage: 'OFFER' },
  { key: 'offerAccepted', label: 'Offers accepted', stage: 'OFFER_ACCEPTED' },
  { key: 'joined', label: 'Joined (still working)', stage: 'JOINED' },
];
const STEP_KEYS = STEPS.map((s) => s.key);

function stepsOf(app, evs) {
  const out = {};
  out.sourced = { day: istDay(app.createdAt), est: false };
  out.approved = reached(app, evs, 'RECRUITER_APPROVED') ? firstReach(app, evs, ['RECRUITER_APPROVED', 'TL_REVIEW'], 'RECRUITER_APPROVED') : null;
  out.shared = reached(app, evs, 'SHARED_WITH_CLIENT') ? firstReach(app, evs, ['SHARED_WITH_CLIENT']) : null;
  out.shortlisted = reached(app, evs, 'CLIENT_SHORTLISTED') ? firstReach(app, evs, ['CLIENT_SHORTLISTED']) : null;
  // interview booked
  const ie = (app.interviewEvents || []).find((e) => e.status === 'SCHEDULED');
  let isch = reached(app, evs, 'INTERVIEW_SCHEDULED') ? firstReach(app, evs, ['INTERVIEW_SCHEDULED']) : null;
  if ((!isch || isch.est) && ie) isch = { day: istDay(ie.createdAt), est: false };
  if (!isch && app.interviewAt) isch = { day: istDay(app.interviewAt), est: true };
  out.interviewScheduled = isch;
  let idone = reached(app, evs, 'INTERVIEW_COMPLETED') ? firstReach(app, evs, ['INTERVIEW_COMPLETED']) : null;
  if ((!idone || idone.est) && app.interviewCompletedAt) idone = { day: istDay(app.interviewCompletedAt), est: false };
  out.interviewDone = idone;
  out.selected = reached(app, evs, 'SELECTED') ? firstReach(app, evs, ['SELECTED']) : null;
  // offer
  const ov = [...(app.offerVersions || [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  const offerOn = ['Offer Released', 'Offer Accepted', 'Offer Declined'].includes(app.offerStatus) || !!ov;
  let off = (reached(app, evs, 'OFFER') || offerOn) ? firstReach(app, evs, ['OFFER'], 'OFFER') : null;
  if (offerOn && (!off || off.est)) {
    if (ov) off = { day: istDay(ov.createdAt), est: false };
    else if (isoDay(app.offerDate)) off = { day: isoDay(app.offerDate), est: false };
    else if (!off) off = { day: istDay(app.updatedAt), est: true };
  }
  out.offerReleased = off;
  const accOn = app.offerStatus === 'Offer Accepted' || !!app.offerAcceptedAt;
  let acc = (reached(app, evs, 'OFFER_ACCEPTED') || accOn) ? firstReach(app, evs, ['OFFER_ACCEPTED']) : null;
  if (app.offerAcceptedAt) acc = { day: istDay(app.offerAcceptedAt), est: false };
  else if (accOn && !acc) acc = { day: istDay(app.updatedAt), est: true };
  out.offerAccepted = acc;
  out.joined = null; // filled from the credited joinings
  return out;
}

// ---- the joinings: the ONE rule ---------------------------------------------------------------------------------------------------------
async function creditedMap(user, reqIds, { fresh = true, candidateId = null } = {}) {
  const joined = await prisma.application.findMany({
    where: { requirementId: { in: reqIds }, stage: { in: JOINED }, ...(candidateId ? { candidateId } : {}) },
    select: { id: true, joiningDate: true, joinedAt: true, updatedAt: true },
  });
  if (!joined.length) return { map: new Map(), undated: 0, level: RJ.viewerLevel(user), clamped: false };
  const days = joined.map((a) => isoDay(a.joiningDate) || istDay(a.joinedAt) || istDay(a.updatedAt));
  const from = days.reduce((m, d) => (d < m ? d : m), days[0]);
  const to = days.reduce((m, d) => (d > m ? d : m), days[0]);
  const lv = RJ.viewerLevel(user);
  const recruiter = SC.atsScopeOf(user).atsRole === 'RECRUITER';
  const eff = lv === 'self' && !recruiter ? 'all' : lv;
  const cj = await RJ.creditedJoinings(user, { from: addDays(from, -1), to: addDays(to, 1), level: eff, fresh });
  const set = new Set(reqIds);
  const map = new Map();
  cj.list.filter((a) => set.has(a.requirementId)).forEach((a) => map.set(a.id, a));
  return { map, level: eff, clamped: cj.clamped, intersect: eff === 'all' || eff === 'sa' };
}

// ---- loading the candidates of some requirements ----------------------------------------------------------------------------------------
const APP_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, ownerRecruiterId: true, createdAt: true, updatedAt: true,
  interviewAt: true, interviewResult: true, interviewCompletedAt: true, interviewRound: true,
  offerStatus: true, offerNotes: true, rollStatus: true, offerDate: true, offerAcceptedAt: true, joiningDate: true, joinedAt: true, joiningStatus: true, hiringType: true,
  candidate: { select: { id: true, name: true } },
  stageEvents: {
    select: {
      fromStage: true, toStage: true, action: true, comment: true, actorName: true, actorRole: true, actorSide: true, reasonCategory: true, reasonDetail: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
  interviewEvents: { select: { status: true, toSlot: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
  interviewFeedbacks: { select: { kind: true, recommendation: true } },
  offerVersions: { select: { status: true, createdAt: true } },
};

async function joiningRecords(appIds) {
  const out = new Map();
  try {
    const S = require('../joindrop/schema'); // eslint-disable-line global-require
    if (!appIds.length || !(await S.ensure())) return out;
    for (let i = 0; i < appIds.length; i += 400) {
      const chunk = appIds.slice(i, i + 400);
      // eslint-disable-next-line no-await-in-loop
      const rows = await S.rows(`SELECT "applicationId","status","joinedOn","droppedOn","dropReason","dropReasonDetail","dropReportedFrom","dropReportedByName","dropReportedByRole","dropWithinGuarantee","guaranteeEndsOn" FROM "JoiningRecord" WHERE "applicationId" IN (${chunk.map(() => '?').join(',')})`, ...chunk);
      rows.forEach((r) => out.set(r.applicationId, r));
    }
  } catch { /* the left-after-joining detail is a bonus: the counts never depend on it */ }
  return out;
}

// -> { recs[], credit, reqs: Map }  (one record per candidate per requirement)
async function loadRecords(user, reqRows, { fresh = true, candidateId = null } = {}) {
  await require('./joinedRule').refresh().catch(() => null); // who left after joining: read synchronously below (V.leftAfterJoining) // eslint-disable-line global-require
  await ensureIndexes();
  const reqIds = reqRows.map((r) => r.id);
  const reqById = new Map(reqRows.map((r) => [r.id, r]));
  const credit = await creditedMap(user, reqIds, { fresh, candidateId });
  const scoped = await prisma.application.findMany({ where: { AND: [{ requirementId: { in: reqIds } }, ...(candidateId ? [{ candidateId }] : []), SC.applicationWhere(user)] }, select: APP_SELECT });
  const have = new Set(scoped.map((a) => a.id));
  const extraIds = [...credit.map.keys()].filter((id) => !have.has(id) && !credit.intersect);
  const extra = extraIds.length ? await prisma.application.findMany({ where: { id: { in: extraIds } }, select: APP_SELECT }) : [];
  const apps = [...scoped, ...extra];
  const withTest = testViewer(user);
  const live = apps.filter((a) => withTest || !TEST_RE.test(String((a.candidate && a.candidate.name) || '')));
  const joinRecs = await joiningRecords(live.filter((a) => JOINED.includes(a.stage) || a.stage === 'REJECTED' || LEFT_STATUS.includes(a.joiningStatus)).map((a) => a.id));
  // names
  const ids = new Set();
  live.forEach((a) => { if (a.ownerRecruiterId) ids.add(a.ownerRecruiterId); });
  reqRows.forEach((r) => { if (r.recruiterId) ids.add(r.recruiterId); });
  [...credit.map.values()].forEach((c) => { if (c.creditedTo && c.creditedTo.userId) ids.add(c.creditedTo.userId); });
  const users = ids.size ? await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const recs = [];
  live.forEach((a) => {
    const evs = a.stageEvents || [];
    const req = reqById.get(a.requirementId) || {};
    const steps = stepsOf(a, evs);
    const cj = credit.map.get(a.id) || null;
    const rec = joinRecs.get(a.id) || null;
    const drop = dropOf(a, evs, rec);
    // A person who joined and then left is DROPPED (founder 2026-11-18), not Joined: the Joined count is the people still working
    const left = !!(drop && drop.type === 'left_after_joining' && JOINED.includes(a.stage));
    const counted = JOINED.includes(a.stage) && !left && !!cj && (!credit.intersect || have.has(a.id));
    if (counted) steps.joined = { day: cj.joiningDate, est: false };
    const joinDayAny = cj ? cj.joiningDate : (isoDay(a.joiningDate) || istDay(a.joinedAt));
    let outcome;
    if (left) outcome = 'dropped';
    else if (JOINED.includes(a.stage)) outcome = 'joined';
    else if (a.stage === 'REJECTED' || (drop && ['declined_offer', 'no_show'].includes(drop.type))) outcome = 'dropped';
    else if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage)) outcome = 'selected';
    else outcome = 'inprocess';
    const recruiterId = (cj && cj.creditedTo && cj.creditedTo.userId) || a.ownerRecruiterId || req.recruiterId || null;
    const recruiterName = (cj && cj.creditedTo && cj.creditedTo.name) || (recruiterId && nameOf.get(recruiterId)) || null;
    // interview dates + result
    const slots = [...new Set((a.interviewEvents || []).filter((e) => ['SCHEDULED', 'RESCHEDULED'].includes(e.status) && e.toSlot).map((e) => istDay(e.toSlot)))];
    if (a.interviewAt && !slots.includes(istDay(a.interviewAt))) slots.push(istDay(a.interviewAt));
    const fbs = a.interviewFeedbacks || [];
    const fb = fbs.find((f) => f.kind === 'Client') || fbs[0] || null;
    const interviewResult = a.interviewResult || (fb ? fb.recommendation : null);
    recs.push({
      applicationId: a.id, candidateId: a.candidateId, candidate: (a.candidate && a.candidate.name) || '—', requirementId: a.requirementId,
      stage: a.stage, stageLabel: left ? 'Dropped' : V.stageLabel(a.stage), outcome, recruiterId, recruiterName, steps,
      interviewDates: slots.sort(), interviewResult,
      joinDay: counted || left ? joinDayAny || null : null, guaranteeEnd: counted || left ? (cj && cj.guaranteeEnd) || (rec && rec.guaranteeEndsOn) || null : null,
      joinedCounted: counted, joinedUncounted: JOINED.includes(a.stage) && !counted && !left,
      drop: outcome === 'dropped' ? drop : null,
      offerStatus: a.offerStatus || null,
    });
  });
  return { recs, credit, reqById };
}

// ---- filters -----------------------------------------------------------------------------------------------------------------------------
function periodOf(q = {}) {
  const ok = (v) => DAY_RE.test(String(v || ''));
  let from = ok(q.from) ? q.from : null;
  let to = ok(q.to) ? q.to : null;
  const t = todayIst();
  const p = String(q.period || '');
  if (p === 'month') { from = `${t.slice(0, 7)}-01`; to = t; }
  else if (p === 'quarter') { const m = Number(t.slice(5, 7)); const qm = Math.floor((m - 1) / 3) * 3 + 1; from = `${t.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`; to = t; }
  else if (p === 'year') { from = `${t.slice(0, 4)}-01-01`; to = t; }
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}
const inRange = (day, p) => !!day && (!p.from || day >= p.from) && (!p.to || day <= p.to);

function applyFilters(recs, q = {}) {
  const p = periodOf(q);
  let out = recs;
  if (q.recruiter) out = out.filter((r) => MPH.multiHas(q.recruiter, r.recruiterId));
  if (p.from || p.to) {
    out = out.filter((r) => STEP_KEYS.some((k) => r.steps[k] && inRange(r.steps[k].day, p)) || (r.drop && inRange(r.drop.day, p)));
  }
  return { recs: out, period: p };
}

// ---- the funnel -------------------------------------------------------------------------------------------------------------------------
function funnelOf(recs, period) {
  const within = (r, k) => !!r.steps[k] && (!(period.from || period.to) || inRange(r.steps[k].day, period));
  const counts = {};
  STEP_KEYS.forEach((k) => { counts[k] = recs.filter((r) => within(r, k)).length; });
  counts.sourced = recs.filter((r) => !(period.from || period.to) || inRange(r.steps.sourced.day, period)).length;
  const dropped = recs.filter((r) => r.outcome === 'dropped' && (!(period.from || period.to) || (r.drop && inRange(r.drop.day, period))));
  const inprocess = recs.filter((r) => r.outcome === 'inprocess' || r.outcome === 'selected');
  const tiles = [];
  let prev = null;
  STEPS.forEach((s, i) => {
    const n = counts[s.key];
    const dates = recs.map((r) => r.steps[s.key] && r.steps[s.key].day).filter((d) => d && (!(period.from || period.to) || inRange(d, period))).sort();
    tiles.push({
      no: i + 1, key: s.key, stage: s.stage, label: s.key === 'joined' ? `${V.stageLabel('JOINED')} (still working)` : s.stage ? V.stageLabel(s.stage) : s.label, plainLabel: s.label, count: n,
      pct: prev === null || prev === 0 ? null : Math.round((n / prev) * 100), prevKey: prev === null ? null : STEPS[i - 1].key,
      first: dates[0] || null, last: dates[dates.length - 1] || null,
      estimated: recs.filter((r) => r.steps[s.key] && r.steps[s.key].est && within(r, s.key)).length,
    });
    prev = n;
  });
  const sourcedN = counts.sourced;
  const dropDates = dropped.map((r) => r.drop.day).filter(Boolean).sort();
  tiles.push({
    no: tiles.length + 1, key: 'dropped', stage: null, label: 'Dropped', plainLabel: 'Dropped', count: dropped.length,
    pct: sourcedN ? Math.round((dropped.length / sourcedN) * 100) : null, prevKey: 'sourced', first: dropDates[0] || null, last: dropDates[dropDates.length - 1] || null,
    estimated: dropped.filter((r) => r.drop.estimated).length,
  });
  const leftNow = dropped.filter((r) => r.drop.type === 'left_after_joining');
  const joinedEver = counts.joined + leftNow.length;
  const leftDates = leftNow.map((r) => r.drop.day).filter(Boolean).sort();
  tiles.push({
    no: tiles.length + 1, key: 'left', sub: true, stage: null, label: 'Left after joining', plainLabel: 'Left after joining', count: leftNow.length,
    pct: joinedEver ? Math.round((leftNow.length / joinedEver) * 100) : null, prevKey: 'joinedEver', first: leftDates[0] || null, last: leftDates[leftDates.length - 1] || null,
    estimated: leftNow.filter((r) => r.drop.estimated).length,
  });
  tiles.push({
    no: tiles.length + 1, key: 'inprocess', stage: null, label: 'Still in process', plainLabel: 'Still in process', count: inprocess.length,
    pct: sourcedN ? Math.round((inprocess.length / sourcedN) * 100) : null, prevKey: 'sourced', first: null, last: null, estimated: 0,
  });
  const reasons = new Map();
  const byType = new Map();
  const byStage = new Map();
  dropped.forEach((r) => {
    const t = r.drop.type;
    byType.set(t, { type: t, label: r.drop.typeLabel, count: (byType.get(t) ? byType.get(t).count : 0) + 1 });
    const sk = r.drop.stage || '?';
    byStage.set(sk, { stage: r.drop.stage, label: r.drop.stageLabel || 'Step not recorded', count: (byStage.get(sk) ? byStage.get(sk).count : 0) + 1 });
    const why = String((r.drop.reason || 'Not recorded')).split(' - ')[0].trim() || 'Not recorded';
    reasons.set(why, (reasons.get(why) || 0) + 1);
  });
  return {
    tiles,
    dropSummary: {
      total: dropped.length,
      leftAfterJoining: leftNow.length,
      byType: [...byType.values()].sort((a, b) => b.count - a.count),
      byStage: [...byStage.values()].sort((a, b) => b.count - a.count),
      byReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    },
    joinedDetail: { counted: counts.joined, leftAfterJoining: leftNow.length, uncounted: recs.filter((r) => r.joinedUncounted).length },
    inprocessDetail: { selectedWaiting: recs.filter((r) => r.outcome === 'selected').length, hold: recs.filter((r) => r.stage === 'HOLD').length },
    counts,
  };
}

// ---- table rows -----------------------------------------------------------------------------------------------------------------------
const STATUS_OF = {
  joined: (r) => r.outcome === 'joined',
  dropped: (r) => r.outcome === 'dropped',
  inprocess: (r) => r.outcome === 'inprocess' || r.outcome === 'selected',
  selected: (r) => r.outcome === 'selected',
  left: (r) => !!(r.drop && r.drop.type === 'left_after_joining'),
};
const SORTS = {
  candidate: (r) => String(r.candidate || '').toLowerCase(),
  recruiter: (r) => String(r.recruiterName || '').toLowerCase(),
  shared: (r) => (r.steps.shared && r.steps.shared.day) || '',
  stage: (r) => idxOf(r.stage),
  interview: (r) => (r.interviewDates[r.interviewDates.length - 1]) || '',
  selected: (r) => (r.steps.selected && r.steps.selected.day) || '',
  offer: (r) => (r.steps.offerReleased && r.steps.offerReleased.day) || '',
  joined: (r) => r.joinDay || '',
  dropped: (r) => (r.drop && r.drop.day) || '',
};
function tableRows(recs, q = {}) {
  let out = recs;
  // one or several statuses (?status=joined,dropped): a candidate stays when ANY ticked status fits
  const sts = MPH.parseMulti(q.status).filter((x) => STATUS_OF[x]);
  if (sts.length) out = out.filter((r) => sts.some((x) => STATUS_OF[x](r)));
  const step = String(q.step || '');
  if (STEP_KEYS.includes(step)) out = out.filter((r) => r.steps[step]);
  else if (step === 'dropped') out = out.filter(STATUS_OF.dropped);
  else if (step === 'left') out = out.filter(STATUS_OF.left);
  else if (step === 'inprocess') out = out.filter(STATUS_OF.inprocess);
  const key = SORTS[q.sort] ? q.sort : 'shared';
  const dir = q.dir === 'desc' ? -1 : 1;
  const f = SORTS[key];
  return [...out].sort((a, b) => {
    const x = f(a); const y = f(b);
    // empty dates go last either way
    if (x === '' && y !== '') return 1;
    if (y === '' && x !== '') return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir || String(a.candidate).localeCompare(String(b.candidate));
  });
}
const rowOut = (r) => ({
  applicationId: r.applicationId, candidateId: r.candidateId, requirementId: r.requirementId, candidate: r.candidate, recruiterId: r.recruiterId, recruiterName: r.recruiterName,
  stage: r.stage, stageLabel: r.stageLabel, outcome: r.outcome,
  shared: r.steps.shared, shortlisted: r.steps.shortlisted, interviewDates: r.interviewDates, interviewResult: r.interviewResult,
  selected: r.steps.selected, offer: r.steps.offerReleased, offerAccepted: r.steps.offerAccepted,
  joinDay: r.joinDay, guaranteeEnd: r.guaranteeEnd, joinedUncounted: r.joinedUncounted,
  daysShareToJoin: r.joinDay && r.steps.shared ? daysBetween(r.steps.shared.day, r.joinDay) : null,
  drop: r.drop ? { type: r.drop.type, typeLabel: r.drop.typeLabel, by: r.drop.by, byName: r.drop.byName, stage: r.drop.stage, stageLabel: r.drop.stageLabel, reason: r.drop.reason, day: r.drop.day, estimated: r.drop.estimated, stillJoined: r.drop.stillJoined, within: r.drop.within } : null,
});

// ---- requirement ---------------------------------------------------------------------------------------------------------------------
const REQ_SELECT = {
  id: true, reqCode: true, title: true, status: true, openings: true, internal: true, createdAt: true, updatedAt: true, clientId: true, recruiterId: true, tlId: true, bdeId: true, recruiterIds: true,
  department: true, portalPublished: true, portalPublishedAt: true, portalUnpublishedAt: true, postingSources: true, closingDate: true, targetDate: true,
  client: { select: { id: true, name: true } },
};
const clientNameOf = (r) => (r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || '—');

async function requirementFor(user, id) {
  return prisma.requirement.findFirst({ where: { AND: [{ id }, SC.requirementWhere(user)] }, select: REQ_SELECT });
}

async function closedInfo(reqs) {
  const closed = reqs.filter((r) => r.status === 'CLOSED');
  const out = new Map();
  if (!closed.length) return out;
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Requirement', entityId: { in: closed.map((r) => r.id) }, action: { startsWith: 'Requirement status' }, toValue: 'CLOSED' },
    select: { entityId: true, createdAt: true }, orderBy: { createdAt: 'asc' },
  });
  rows.forEach((a) => { out.set(a.entityId, { day: istDay(a.createdAt), est: false }); });
  closed.forEach((r) => { if (!out.has(r.id)) out.set(r.id, { day: istDay(r.updatedAt), est: true }); });
  return out;
}

async function requirementHeader(r) {
  const [postings, audits, closed] = await Promise.all([
    prisma.requirementPosting.findMany({ where: { requirementId: r.id }, select: { source: true, status: true, postedAt: true, removedAt: true } }),
    prisma.auditLog.findMany({
      where: { entity: 'Requirement', entityId: r.id, action: { in: ['Requirement assignment changed', 'Requirement created', 'Requirement status changed', 'Requirement activated', 'Requirement status toggled', 'Requirement request accepted'] } },
      select: { action: true, fromValue: true, toValue: true, actorName: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    }),
    closedInfo([r]),
  ]);
  const extra = String(r.recruiterIds || '').split(',').map((x) => x.trim()).filter(Boolean);
  const people = [...new Set([r.tlId, r.recruiterId, r.bdeId, ...extra, ...audits.flatMap((a) => (a.action === 'Requirement assignment changed' ? String(a.toValue || '').split(' / ') : []))].filter(Boolean))];
  const users = people.length ? await prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true } }) : [];
  const nm = new Map(users.map((u) => [u.id, u.name]));
  const assignRows = audits.filter((a) => a.action === 'Requirement assignment changed');
  const dayOfAssign = (uid) => {
    const hit = [...assignRows].reverse().find((a) => String(a.toValue || '').split(' / ').includes(uid));
    return hit ? { day: istDay(hit.createdAt), est: false, by: hit.actorName || null } : { day: istDay(r.createdAt), est: true, by: null };
  };
  const assigned = [];
  const add = (role, uid) => { if (uid && nm.get(uid)) assigned.push({ role, name: nm.get(uid), ...dayOfAssign(uid) }); };
  add('Client manager (BDE)', r.bdeId);
  add('Team lead', r.tlId);
  add('Recruiter', r.recruiterId);
  extra.forEach((u) => add('Recruiter', u));
  const closedAt = r.status === 'CLOSED' ? closed.get(r.id) : null;
  const end = closedAt ? closedAt.day : todayIst();
  const posted = postings.filter((p) => p.postedAt).map((p) => ({ where: p.source, status: p.status, day: istDay(p.postedAt), removed: p.removedAt ? istDay(p.removedAt) : null }));
  if (r.portalPublishedAt) posted.push({ where: 'Job portal', status: 'Published', day: istDay(r.portalPublishedAt), removed: r.portalUnpublishedAt ? istDay(r.portalUnpublishedAt) : null });
  const created = audits.find((a) => a.action === 'Requirement created');
  return {
    id: r.id, reqCode: r.reqCode, title: r.title, status: r.status, statusLabel: V.requirementStatusLabel ? V.requirementStatusLabel(r.status) : r.status, openings: r.openings,
    client: { id: r.client ? r.client.id : null, name: clientNameOf(r) }, department: r.department || null,
    createdDay: istDay(r.createdAt), createdBy: (created && created.actorName) || null, posted,
    assigned, closedDay: closedAt ? closedAt.day : null, closedEstimated: closedAt ? closedAt.est : false,
    daysOpen: daysBetween(istDay(r.createdAt), end),
    _audits: audits, _nm: nm,
  };
}

async function timelineOf(header, recs, limit = 400) {
  const ev = [];
  const push = (day, at, kind, text, extra = {}) => { if (day) ev.push({ day, at, kind, text, ...extra }); };
  push(header.createdDay, null, 'requirement', `Requirement created${header.createdBy ? ` by ${header.createdBy}` : ''}`);
  header.posted.forEach((p) => push(p.day, null, 'posting', `Posted on ${p.where}${p.status ? ` (${p.status})` : ''}`));
  header._audits.forEach((a) => {
    if (a.action === 'Requirement assignment changed') {
      const names = String(a.toValue || '').split(' / ').map((x) => header._nm.get(x)).filter(Boolean);
      push(istDay(a.createdAt), a.createdAt, 'assignment', `Assigned: ${names.join(', ') || 'changed'}${a.actorName ? ` (by ${a.actorName})` : ''}`);
    } else if (a.action.startsWith('Requirement status') || a.action === 'Requirement activated') {
      push(istDay(a.createdAt), a.createdAt, 'status', `Status ${a.fromValue ? `${V.requirementStatusLabel(a.fromValue)} to ` : 'set to '}${V.requirementStatusLabel(a.toValue)}${a.actorName ? ` (by ${a.actorName})` : ''}`);
    }
  });
  recs.forEach((r) => {
    const who = r.candidate;
    const s = r.steps;
    if (s.shared) push(s.shared.day, null, 'shared', `${who}: sent to the client`, { applicationId: r.applicationId, est: s.shared.est });
    if (s.shortlisted) push(s.shortlisted.day, null, 'shortlisted', `${who}: client shortlisted`, { applicationId: r.applicationId, est: s.shortlisted.est });
    if (s.interviewScheduled) push(s.interviewScheduled.day, null, 'interview', `${who}: interview booked`, { applicationId: r.applicationId, est: s.interviewScheduled.est });
    if (s.interviewDone) push(s.interviewDone.day, null, 'interview', `${who}: interview done${r.interviewResult ? ` (${r.interviewResult})` : ''}`, { applicationId: r.applicationId, est: s.interviewDone.est });
    if (s.selected) push(s.selected.day, null, 'selected', `${who}: selected`, { applicationId: r.applicationId, est: s.selected.est });
    if (s.offerReleased) push(s.offerReleased.day, null, 'offer', `${who}: offer released`, { applicationId: r.applicationId, est: s.offerReleased.est });
    if (s.offerAccepted) push(s.offerAccepted.day, null, 'offer', `${who}: offer accepted`, { applicationId: r.applicationId, est: s.offerAccepted.est });
    if (r.joinDay) push(r.joinDay, null, 'joined', `${who}: joined`, { applicationId: r.applicationId });
    if (r.drop) push(r.drop.day, null, 'dropped', `${who}: ${r.drop.type === 'left_after_joining' ? 'left after joining' : 'dropped'}${r.drop.stageLabel && r.drop.type !== 'left_after_joining' ? ` at "${r.drop.stageLabel}"` : ''} - ${r.drop.typeLabel}${r.drop.reason ? ` (${r.drop.reason})` : ''}`, { applicationId: r.applicationId, est: r.drop.estimated });
  });
  ev.sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(b.at || '').localeCompare(String(a.at || '')));
  return ev.slice(0, limit);
}

async function requirementHistory(user, id, q = {}) {
  const r = await requirementFor(user, id);
  if (!r) return null;
  const { recs: all } = await loadRecords(user, [r]);
  const { recs, period } = applyFilters(all, q);
  const header = await requirementHeader(r);
  const f = funnelOf(recs, period);
  const recruiters = [...new Map(all.filter((x) => x.recruiterId).map((x) => [x.recruiterId, x.recruiterName || x.recruiterId])).entries()].map(([rid, name]) => ({ id: rid, name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const rows = tableRows(recs, q).map(rowOut); // the status / step filter and the sort of the screen
  // WHO REPLACED WHOM: a chip on each row and the Replacement table of this requirement
  const RPm = require('../joindrop/replacement'); // eslint-disable-line global-require
  const tg = await RPm.tags(user, rows.map((x) => x.applicationId)).catch(() => new Map());
  rows.forEach((x) => RPm.put(x, tg.get(x.applicationId)));
  const replacements = await RPm.sectionFor(user, all.map((x) => x.applicationId)).catch(() => null);
  const timeline = await timelineOf(header, recs);
  delete header._audits; delete header._nm;
  const exportRows = q._export ? rows : undefined;
  return {
    exportRows,
    requirement: header, definitions: DEFINITIONS, period, funnel: f.tiles, dropSummary: f.dropSummary, joinedDetail: f.joinedDetail, inprocessDetail: f.inprocessDetail,
    rows, total: rows.length, recruiters, timeline, replacements,
    notes: { estimatedDates: f.tiles.reduce((n, t) => n + t.estimated, 0), joinedWithoutDate: all.filter((x) => x.joinedUncounted).length },
  };
}

// ---- client ---------------------------------------------------------------------------------------------------------------------------
const avg = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };

async function clientFor(user, id) {
  return prisma.client.findFirst({ where: { AND: [{ id }, SC.clientWhere(user)] }, select: { id: true, name: true, clientCode: true, agreementStatus: true, agreementStart: true, agreementEnd: true, agreementSentAt: true, agreementSignedAt: true, agreementActivatedAt: true, createdAt: true, guaranteePeriod: true } });
}

async function clientHistory(user, id, q = {}) {
  const c = await clientFor(user, id);
  if (!c) return null;
  const reqs = await prisma.requirement.findMany({ where: { AND: [{ clientId: id }, SC.requirementWhere(user)] }, select: REQ_SELECT, orderBy: { createdAt: 'desc' } });
  const { recs: all } = reqs.length ? await loadRecords(user, reqs) : { recs: [] };
  const { recs, period } = applyFilters(all, q);
  const f = funnelOf(recs, period);
  const closed = await closedInfo(reqs);
  const today = todayIst();
  const byReq = new Map(reqs.map((r) => [r.id, []]));
  recs.forEach((r) => { if (byReq.has(r.requirementId)) byReq.get(r.requirementId).push(r); });
  const reqRows = reqs.map((r) => {
    const mine = byReq.get(r.id) || [];
    const ff = funnelOf(mine, period);
    const cl = r.status === 'CLOSED' ? closed.get(r.id) : null;
    const count = (k) => (ff.tiles.find((t) => t.key === k) || {}).count || 0;
    return {
      id: r.id, reqCode: r.reqCode, title: r.title, status: r.status, statusLabel: V.requirementStatusLabel(r.status), openings: r.openings,
      createdDay: istDay(r.createdAt), closedDay: cl ? cl.day : null, daysOpen: daysBetween(istDay(r.createdAt), cl ? cl.day : today),
      sourced: count('sourced'), shared: count('shared'), shortlisted: count('shortlisted'), interviews: count('interviewScheduled'), selected: count('selected'),
      offers: count('offerReleased'), joined: count('joined'), dropped: count('dropped'), inProcess: count('inprocess'),
    };
  }).filter((r) => !(period.from || period.to) || r.sourced || r.shared || r.joined || r.dropped || inRange(r.createdDay, period));
  // year and month tables: requirements given, and what happened in each month (sent, joined, dropped)
  const bucket = new Map();
  const slot = (k) => { if (!bucket.has(k)) bucket.set(k, { key: k, requirements: 0, openings: 0, shared: 0, joined: 0, dropped: 0 }); return bucket.get(k); };
  reqs.forEach((r) => { const d = istDay(r.createdAt); if (d && (!(period.from || period.to) || inRange(d, period))) { const b = slot(d.slice(0, 7)); b.requirements += 1; b.openings += r.openings || 0; } });
  recs.forEach((r) => {
    if (r.steps.shared && (!(period.from || period.to) || inRange(r.steps.shared.day, period))) slot(r.steps.shared.day.slice(0, 7)).shared += 1;
    if (r.steps.joined && (!(period.from || period.to) || inRange(r.steps.joined.day, period))) slot(r.steps.joined.day.slice(0, 7)).joined += 1;
    if (r.outcome === 'dropped' && r.drop && r.drop.day && (!(period.from || period.to) || inRange(r.drop.day, period))) slot(r.drop.day.slice(0, 7)).dropped += 1;
  });
  const months = [...bucket.values()].sort((x, y) => y.key.localeCompare(x.key));
  const yearMap = new Map();
  months.forEach((m) => {
    const y = m.key.slice(0, 4);
    const t = yearMap.get(y) || { key: y, requirements: 0, openings: 0, shared: 0, joined: 0, dropped: 0 };
    ['requirements', 'openings', 'shared', 'joined', 'dropped'].forEach((k) => { t[k] += m[k]; });
    yearMap.set(y, t);
  });
  const breakdown = { months, years: [...yearMap.values()].sort((x, y) => y.key.localeCompare(x.key)) };
  const opened = reqs.filter((r) => !(period.from || period.to) || inRange(istDay(r.createdAt), period)).length;
  const closedN = reqs.filter((r) => r.status === 'CLOSED' && (!(period.from || period.to) || inRange(closed.get(r.id).day, period))).length;
  // days to fill: from the requirement being opened to the day its last opening was filled
  const fill = [];
  reqs.forEach((r) => {
    const j = (byReq.get(r.id) || []).filter((x) => x.steps.joined).map((x) => x.steps.joined.day).sort();
    if (j.length >= Math.max(1, r.openings || 1)) fill.push(daysBetween(istDay(r.createdAt), j[Math.max(1, r.openings || 1) - 1]));
  });
  const shareToJoin = recs.filter((x) => x.steps.joined && x.steps.shared).map((x) => daysBetween(x.steps.shared.day, x.steps.joined.day));
  const reqTitle = new Map(reqs.map((r) => [r.id, r.reqCode ? `${r.reqCode} · ${r.title}` : r.title]));
  const RPc = require('../joindrop/replacement'); // eslint-disable-line global-require
  const tgc = await RPc.tags(user, recs.filter((x) => x.outcome === 'joined' || x.joinDay).map((x) => x.applicationId)).catch(() => new Map());
  const replacementsC = await RPc.sectionFor(user, all.map((x) => x.applicationId)).catch(() => null);
  const joinings = recs.filter((x) => x.outcome === 'joined' || x.joinDay).map((x) => {
    const row = rowOut(x);
    return RPc.put({
      applicationId: x.applicationId, candidate: x.candidate, requirementId: x.requirementId, requirement: reqTitle.get(x.requirementId) || '', recruiterName: x.recruiterName,
      joinDay: x.joinDay, guaranteeEnd: x.guaranteeEnd, guarantee: !x.joinDay ? 'No joining date' : x.drop ? `Left${x.drop.day ? ` on ${x.drop.day}` : ''}` : (x.guaranteeEnd ? (today <= x.guaranteeEnd ? 'In guarantee' : 'Past guarantee') : 'Guarantee not set'),
      left: row.drop && row.drop.type === 'left_after_joining' ? row.drop : null,
      stageLabel: x.stageLabel,
    }, tgc.get(x.applicationId));
  }).sort((a, b) => String(a.joinDay || '9999').localeCompare(String(b.joinDay || '9999')));
  // every candidate of this client (one row per application), one click from the client's History
  // a funnel tile picked on the screen (?step=sourced|shared|...|joined|dropped|left|inprocess): only the candidates behind that number (2026-11-25)
  const stepRows = tableRows(recs, { step: q.step });
  const candidateRows = stepRows.slice(0, 500).map((x) => ({ ...rowOut(x), requirement: reqTitle.get(x.requirementId) || '' }));
  const recruiters = [...new Map(all.filter((x) => x.recruiterId).map((x) => [x.recruiterId, x.recruiterName || x.recruiterId])).entries()].map(([rid, name]) => ({ id: rid, name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  // agreements (hidden for the logins that never see them)
  let agreements = null;
  let blind = false;
  try { blind = require('./agreementPrivacy').blindTo(user); } catch { blind = false; } // eslint-disable-line global-require
  if (!blind) {
    const rows = await prisma.auditLog.findMany({ where: { entity: 'Client', entityId: id, action: { startsWith: 'Agreement' } }, select: { action: true, actorName: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    const label = (a) => [[/created/i, 'Made'], [/resent/i, 'Sent again'], [/sent/i, 'Sent to the client'], [/signed/i, 'Signed'], [/auto-activated|activated/i, 'Active'], [/expired/i, 'Closed'], [/rejected/i, 'Returned by the client']].find(([re]) => re.test(a));
    const events = [];
    const seen = new Set();
    rows.forEach((a) => { const l = label(a.action); if (!l) return; const key = `${l[1]}|${istDay(a.createdAt)}`; if (seen.has(key)) return; seen.add(key); events.push({ label: l[1], day: istDay(a.createdAt), who: a.actorName || null }); });
    [['agreementSentAt', 'Sent to the client'], ['agreementSignedAt', 'Signed'], ['agreementActivatedAt', 'Active']].forEach(([fld, lab]) => { if (c[fld] && !events.some((e) => e.label === lab)) events.push({ label: lab, day: istDay(c[fld]), who: null, estimated: true }); });
    events.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    agreements = { status: c.agreementStatus, start: isoDay(c.agreementStart), renewal: isoDay(c.agreementEnd), guarantee: c.guaranteePeriod || null, events };
  }
  // billing: only for the logins that already see invoice amounts
  let billing = null;
  if (await mayBilling(user)) {
    const invs = await prisma.invoice.findMany({ where: { clientId: id }, select: { id: true, invoiceNumber: true, candidateId: true, requirementId: true, amount: true, gst: true, status: true, invoiceDate: true, receivedAmount: true, paidDate: true } });
    const live = invs.filter((i) => i.status !== 'Cancelled');
    const byCand = new Map(live.filter((i) => i.candidateId).map((i) => [`${i.candidateId}|${i.requirementId}`, i]));
    billing = {
      raised: live.length, paid: live.filter((i) => i.status === 'Paid' || (i.receivedAmount || 0) >= (i.amount || 0) + (i.gst || 0)).length,
      revenue: Math.round(live.reduce((n, i) => n + (i.amount || 0), 0)), received: Math.round(live.reduce((n, i) => n + (i.receivedAmount || 0), 0)),
      perJoining: joinings.map((j) => {
        const x = recs.find((r) => r.applicationId === j.applicationId);
        const inv = x ? byCand.get(`${x.candidateId}|${x.requirementId}`) : null;
        return {
          applicationId: j.applicationId, candidate: j.candidate, invoiceId: inv ? inv.id : null, invoiceNumber: inv ? inv.invoiceNumber : null, invoiceDay: inv ? inv.invoiceDate : null, amount: inv ? Math.round(inv.amount || 0) : null,
          status: inv ? inv.status : 'Not raised', paidDay: inv ? inv.paidDate : null,
        };
      }),
    };
  }
  return {
    client: { id: c.id, name: c.name, code: c.clientCode || null }, definitions: DEFINITIONS, period, funnel: f.tiles, dropSummary: f.dropSummary, joinedDetail: f.joinedDetail, inprocessDetail: f.inprocessDetail,
    breakdown,
    big: { requirementsGiven: reqs.length, joinings: (f.tiles.find((t) => t.key === 'joined') || {}).count || 0, leftAfterJoining: (f.tiles.find((t) => t.key === 'left') || {}).count || 0 },
    requirements: { opened, closed: closedN, total: reqs.length, open: reqs.filter((r) => !['CLOSED', 'DRAFT'].includes(r.status)).length },
    averages: { daysToFill: avg(fill), daysShareToJoin: avg(shareToJoin), filledRequirements: fill.length },
    joinings, candidates: candidateRows, candidateTotal: stepRows.length, step: q.step ? String(q.step) : null, requirementRows: reqRows, recruiters, agreements, billing, replacements: replacementsC,
    notes: { estimatedDates: f.tiles.reduce((n, t) => n + t.estimated, 0) },
  };
}

// ---- Excel / CSV -----------------------------------------------------------------------------------------------------------------------------
const dash = (d) => d || '';
const mark = (x) => (x ? `${x.day}${x.est ? ' (estimated)' : ''}` : '');
const ROW_HEADERS = ['Candidate', 'Recruiter', 'Shared with client', 'Client shortlisted', 'Current step', 'Interview date(s)', 'Interview result', 'Selected on', 'Offer released', 'Offer accepted', 'Joining date', 'Guarantee ends', 'Status', 'Dropped on', 'Dropped at step', 'Who dropped / why type', 'Drop reason', 'Reported by', 'Replaced by', 'Replacement for'];
function exportRow(r, extra = []) {
  const d = r.drop;
  const status = r.outcome === 'joined' ? (d && d.type === 'left_after_joining' ? 'Dropped (joined, then left)' : 'Joined') : r.outcome === 'dropped' ? 'Dropped' : r.outcome === 'selected' ? 'Selected, not joined yet' : 'In process';
  return [
    ...extra, r.candidate, dash(r.recruiterName), mark(r.shared), mark(r.shortlisted), r.stageLabel, (r.interviewDates || []).join(', '), dash(r.interviewResult), mark(r.selected), mark(r.offer), mark(r.offerAccepted),
    dash(r.joinDay), dash(r.guaranteeEnd), status, d ? `${d.day || ''}${d.estimated ? ' (estimated)' : ''}` : '', d && d.stageLabel ? d.stageLabel : '', d ? d.typeLabel : '', d ? dash(d.reason) : '', d ? [d.byName, d.by].filter(Boolean).join(' / ') : '',
    r.replacedBy ? (r.replacedBy.hidden ? 'another candidate' : r.replacedBy.candidateName) : '', (r.replacementFor || []).map((f) => (f.hidden ? 'another candidate' : f.candidateName)).join('; '),
  ];
}
function funnelSheet(tiles) {
  return { name: 'Funnel', headers: ['No', 'Step', 'Candidates', '% of the step before', 'First date', 'Last date', 'Dates estimated'], rows: tiles.map((t) => [t.no, t.label, t.count, t.pct === null ? '' : `${t.pct}%`, dash(t.first), dash(t.last), t.estimated]) };
}

module.exports = {
  DEFINITIONS, DROP_TYPES, STEPS, dropOf, ensureIndexes, requirementHistory, clientHistory, tableRows, rowOut, applyFilters, funnelOf, loadRecords, periodOf, mayBilling, external,
  exportRow, ROW_HEADERS, funnelSheet, requirementFor, clientFor, REQ_SELECT, STATUS_OF,
  APP_SELECT, stepsOf, istDay, isoDay, todayIst, daysBetween, addDays, avg, testViewer, clientNameOf, inRange, TEST_RE, JOINED, STEP_KEYS,
};
