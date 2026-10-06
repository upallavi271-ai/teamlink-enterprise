// ---------------------------------------------------------------------------
// REJECTIONS (spec 2026-10-03 §A) — one place that reads them back.
//
// THE RECORD ALREADY EXISTS. A reject is per APPLICATION (Application.stage =
// REJECTED) and its why / who / which side / at which step is the latest
// ApplicationStageEvent INTO 'REJECTED' (reasonCategory, reasonDetail,
// actorSide, actorName, fromStage, the requirement + client snapshot). Nothing
// here creates a second store of rejections; this module only reads that
// record and shapes it for the Candidates list, the candidate profile, the
// requirement's Matching tabs and the Rejection reasons report.
//
// "DO NOT USE" (fake resume, abuse, absconded) is the one new state, and it
// needs no new column either:
//   * the request is an ApprovalStep row (workflow 'ats_do_not_use', recordId
//     = the rejection's stage-event id, level TL, approver = the TL of that
//     requirement's team; Super Admin / Admin may also decide);
//   * once approved, the candidate's profileStatus becomes 'Do Not Use' — the
//     one flag every match list and POST /applications check.
// A plain reject ("Not suitable for this job") stays exactly what it was: the
// person keeps appearing in matching for other jobs.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { REJECTED_BY_LABEL, stageLabel } = require('./atsVocab');

const DNU_WORKFLOW = 'ats_do_not_use';
const DNU_STATUS = 'Do Not Use';
const DNU_REASONS = ['Fake Resume / Documents', 'Abusive Behaviour', 'Absconded', 'Other'];
// Test identities never become an approver of a real request (agent rules,
// 2026-09-29 lesson).
const TEST_RE = /zztest|example\.test/i;

const isPlaceholder = (e) => !e.reasonCategory && (!e.reasonDetail || e.reasonDetail === 'Rejected');
function reasonOf(e) {
  if (!e) return null;
  return e.reasonCategory || (isPlaceholder(e) ? null : e.reasonDetail) || e.comment || null;
}
function detailOf(e) {
  if (!e || !e.reasonCategory) return null;
  return e.reasonDetail || e.comment || null;
}
function sideLabel(side) {
  return side ? (REJECTED_BY_LABEL[side] || side) : 'Not recorded';
}
// "Client" / "Our team · TL Deela" / "Candidate" (plain words, spec §10).
function byLabel(rec) {
  if (rec.side === 'Internal') {
    const who = rec.by ? `${rec.byRole ? `${roleWord(rec.byRole)} ` : ''}${rec.by}` : null;
    return who ? `Our team · ${who}` : 'Our team';
  }
  if (rec.side === 'Client') return 'Client';
  if (rec.side === 'Candidate') return 'Candidate said no';
  return 'Not recorded';
}
const ROLE_WORD = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Asst Manager',
  STL: 'STL', TL: 'TL', RECRUITER: 'Recruiter', BDE: 'BDE', HR: 'HR',
};
const roleWord = (r) => ROLE_WORD[r] || '';

// ---------------------------------------------------------------------------
// THE INDEX — every application currently at REJECTED, with its latest
// rejection event. Read for the whole company once and kept for two minutes
// (14,000+ imported rejections take a second to read cold); a reject made
// through the pipeline drops it at once (invalidate()).
// ---------------------------------------------------------------------------
const TTL_MS = 2 * 60 * 1000;
let cache = null;
let loading = null;
// SPEED (2026-10-03): when the two minutes are up, the request is answered
// from the copy it has and a fresh one is read in the background (it used to
// make that request wait ~4 s). invalidate() is unchanged in effect: the next
// read waits for a copy read AFTER it — `gen` makes sure a background read
// that started before the invalidate is never taken as that copy.
let gen = 0;
function invalidate() { cache = null; gen += 1; }

async function loadIndex() {
  const [apps, events, dnuCands, dnuSteps] = await Promise.all([
    prisma.application.findMany({
      where: { stage: 'REJECTED' },
      select: {
        id: true, candidateId: true, requirementId: true, updatedAt: true, interviewFeedback: true,
        requirement: { select: { title: true, reqCode: true, clientId: true, internal: true, salary: true, client: { select: { name: true } } } },
      },
    }),
    prisma.applicationStageEvent.findMany({
      where: { toStage: 'REJECTED' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, applicationId: true, actorSide: true, actorName: true, actorRole: true, actorUserId: true,
        reasonCategory: true, reasonDetail: true, comment: true, fromStage: true, createdAt: true,
      },
    }),
    prisma.candidate.findMany({ where: { profileStatus: DNU_STATUS }, select: { id: true } }),
    prisma.approvalStep.findMany({ where: { workflow: DNU_WORKFLOW }, orderBy: { createdAt: 'desc' } }),
  ]);
  const latest = new Map();
  events.forEach((e) => { if (!latest.has(e.applicationId)) latest.set(e.applicationId, e); });
  const stepByEvent = new Map();
  dnuSteps.forEach((s) => { if (!stepByEvent.has(s.recordId)) stepByEvent.set(s.recordId, s); });

  const byCandidate = new Map();
  const byRequirement = new Map();
  const byApplication = new Map();
  apps.forEach((a) => {
    const e = latest.get(a.id) || null;
    const r = a.requirement || {};
    const step = e ? stepByEvent.get(e.id) : null;
    const rec = {
      applicationId: a.id,
      candidateId: a.candidateId,
      requirementId: a.requirementId,
      requirementTitle: r.title || null,
      reqCode: r.reqCode || null,
      requirementSalary: r.salary || null,
      clientId: r.internal ? null : (r.clientId || null),
      clientName: r.internal ? 'TeamLink Internal' : ((r.client && r.client.name) || null),
      internal: !!r.internal,
      eventId: e ? e.id : null,
      side: e ? e.actorSide || null : null,
      by: e ? e.actorName || null : null,
      byRole: e ? e.actorRole || null : null,
      byUserId: e ? e.actorUserId || null : null,
      reason: reasonOf(e),
      detail: detailOf(e) || (e && isPlaceholder(e) && a.interviewFeedback ? String(a.interviewFeedback).slice(0, 300) : null),
      fromStage: e && e.fromStage ? stageLabel(e.fromStage) : null,
      // What the client said, in their words (the reject dialog asks for it
      // when the side is Client; kept on the event's comment).
      clientSaid: e && e.actorSide === 'Client' && e.comment && e.comment !== (e.reasonDetail || '') ? e.comment : null,
      at: e ? e.createdAt : a.updatedAt,
      kind: step ? 'do_not_use' : 'not_suitable',
      dnu: step ? {
        stepId: step.id, status: step.status, approverName: step.approverName || null,
        decidedBy: step.actedByName || null, decidedAt: step.actedAt || null, note: step.note || null,
      } : null,
    };
    rec.sideLabel = sideLabel(rec.side);
    rec.byLabel = byLabel(rec);
    byApplication.set(a.id, rec);
    if (!byCandidate.has(a.candidateId)) byCandidate.set(a.candidateId, []);
    byCandidate.get(a.candidateId).push(rec);
    if (!byRequirement.has(a.requirementId)) byRequirement.set(a.requirementId, []);
    byRequirement.get(a.requirementId).push(rec);
  });
  byCandidate.forEach((list) => list.sort((x, y) => new Date(y.at) - new Date(x.at)));

  // Do-not-use state per candidate: approved (the flag) wins over pending.
  const doNotUse = new Map();
  dnuCands.forEach((c) => doNotUse.set(c.id, 'approved'));
  byCandidate.forEach((list, cid) => {
    if (doNotUse.has(cid)) return;
    if (list.some((x) => x.dnu && x.dnu.status === 'Pending')) doNotUse.set(cid, 'pending');
  });
  return {
    at: Date.now(), byCandidate, byRequirement, byApplication, doNotUse,
  };
}

function startLoad() {
  const g = gen;
  const p = loadIndex()
    .then((x) => { if (g === gen) cache = x; return x; })
    .finally(() => { if (loading && loading.p === p) loading = null; });
  loading = { p, g };
  return p;
}

async function index() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (cache) {
    // Two minutes old: serve it, read the next one behind it.
    if (!loading) {
      startLoad().catch((err) => console.error('[rejections] background index read failed:', err.message)); // eslint-disable-line no-console
    }
    return cache;
  }
  if (loading && loading.g === gen) return loading.p;
  return startLoad();
}

// Map(candidateId -> { count, items, doNotUse }) for the given ids.
async function rejectionIndex(candidateIds) {
  const ix = await index();
  const out = new Map();
  (candidateIds || []).forEach((id) => {
    const items = ix.byCandidate.get(id) || [];
    const dnu = ix.doNotUse.get(id) || null;
    if (items.length || dnu) out.set(id, { count: items.length, items, doNotUse: dnu });
  });
  return out;
}

// The application ids this login may see, out of a set — so a recruiter is
// told THAT a person was rejected on another team's job, never where or why.
async function visibleAppIds(user, appIds) {
  if (!appIds.length) return new Set();
  // eslint-disable-next-line global-require
  const { applicationWhere } = require('./scope');
  const seen = new Set();
  for (let i = 0; i < appIds.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.application.findMany({
      where: { AND: [applicationWhere(user), { id: { in: appIds.slice(i, i + 400) } }] },
      select: { id: true },
    });
    rows.forEach((r) => seen.add(r.id));
  }
  return seen;
}

// What leaves the server for one rejection a login may see.
function publicRecord(rec) {
  return {
    applicationId: rec.applicationId,
    requirementId: rec.requirementId,
    requirementTitle: rec.requirementTitle,
    reqCode: rec.reqCode,
    clientName: rec.clientName, // client NAME only — never contact or commercial data
    clientId: rec.clientId,
    internal: rec.internal,
    side: rec.side,
    sideLabel: rec.sideLabel,
    by: rec.by,
    byLabel: rec.byLabel,
    reason: rec.reason,
    detail: rec.detail,
    clientSaid: rec.clientSaid || null,
    fromStage: rec.fromStage,
    at: rec.at,
    kind: rec.kind,
    dnu: rec.dnu ? { status: rec.dnu.status, approverName: rec.dnu.approverName, decidedBy: rec.dnu.decidedBy, decidedAt: rec.dnu.decidedAt } : null,
  };
}

// Scoped history for a set of candidates: { visible: [...], hiddenCount }.
async function scopedHistory(user, candidateIds) {
  const ix = await rejectionIndex(candidateIds);
  const allApps = [];
  ix.forEach((v) => v.items.forEach((x) => allApps.push(x.applicationId)));
  const seen = await visibleAppIds(user, allApps);
  const out = new Map();
  ix.forEach((v, cid) => {
    const visible = v.items.filter((x) => seen.has(x.applicationId)).map(publicRecord);
    out.set(cid, { count: v.count, visible, hiddenCount: v.count - visible.length, doNotUse: v.doNotUse });
  });
  return out;
}

// "Rejected 2×" on list rows. Mutates the rows (internal viewers only — the
// caller checks), adding `rejectedTimes`, `rejectedHistory` and `doNotUse`.
async function attachRejectionBadges(user, rows, idOf = (r) => r.candidateId || r.id) {
  const ids = [...new Set(rows.map(idOf).filter(Boolean))];
  if (!ids.length) return;
  const hist = await scopedHistory(user, ids);
  const ix = await index();
  rows.forEach((r) => {
    // The Rejected view's "Rejected by": Client, or Internal + the person.
    if (r.rejection) {
      const rec = (ix.byCandidate.get(idOf(r)) || []).find((x) => x.applicationId === (r.latestApplicationId || r.id));
      r.rejection = {
        ...r.rejection,
        byLabel: rec ? rec.byLabel : (r.rejection.side === 'Internal' && r.rejection.by ? `Internal, ${r.rejection.by}` : r.rejection.sideLabel),
        kind: rec ? rec.kind : 'not_suitable',
        dnuStatus: rec && rec.dnu ? rec.dnu.status : null,
      };
    }
    const h = hist.get(idOf(r));
    r.rejectedTimes = h ? h.count : 0;
    if (!h) return;
    r.rejectedTimes = h.count;
    r.rejectedHistory = h.visible.slice(0, 6).map((x) => ({
      requirementTitle: x.requirementTitle, clientName: x.clientName, byLabel: x.byLabel, reason: x.reason, at: x.at, kind: x.kind,
    }));
    r.rejectedHiddenCount = h.hiddenCount;
    r.doNotUse = h.doNotUse;
  });
}

// --- Same-client and re-consider hints -------------------------------------
function bandTop(salary) {
  const nums = String(salary || '').match(/(\d+(?:\.\d+)?)/g);
  if (!nums || !nums.length) return null;
  return Number(nums[nums.length - 1]);
}
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000);
function shortDate(d) {
  if (!d) return '';
  const x = istDay(d);
  return `${x.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()]}`;
}
// "Orbit already rejected him (Salary Expectation, 12 Oct)".
function sameClientWarning(rec) {
  return `${rec.clientName || 'This client'} already rejected this candidate (${[rec.reason || 'reason not recorded', shortDate(rec.at)].filter(Boolean).join(', ')})`;
}
// The reject reason probably does not apply to THIS job.
function reasonMayNotApply(rec, requirement, candidate) {
  const r = String(rec.reason || '').toLowerCase();
  if (/position (closed|filled)/.test(r)) return 'The earlier position was closed / filled — not about the candidate.';
  if (/salary/.test(r)) {
    const here = bandTop(requirement && requirement.salary);
    const there = bandTop(rec.requirementSalary);
    if (here != null && there != null && here > there) return `This job pays more (up to ₹${here}L vs ₹${there}L).`;
    const expected = bandTop(candidate && candidate.expectedSalary);
    if (here != null && there == null && expected != null && here >= expected) return `This job's band (up to ₹${here}L) covers the expected ₹${expected}L.`;
  }
  return null;
}

// For one candidate against one requirement: block + warnings, computed from
// the WHOLE record (a block or a same-client reject is never hidden by scope).
async function checkCandidateFor(candidateId, requirement) {
  const ix = await index();
  const items = ix.byCandidate.get(candidateId) || [];
  const others = items.filter((x) => x.requirementId !== requirement.id);
  // Only the CLIENT's own "no" counts: our team screening someone out for
  // that client's job never put them in front of the client.
  const sameClient = requirement.internal ? [] : others.filter((x) => x.side === 'Client' && x.clientId && x.clientId === requirement.clientId);
  return {
    doNotUse: ix.doNotUse.get(candidateId) || null,
    rejectedHere: items.find((x) => x.requirementId === requirement.id) || null,
    others,
    sameClient,
    warning: sameClient.length ? sameClientWarning(sameClient[0]) : null,
  };
}

// The note a re-considered application starts with.
function reconsiderNote(rec) {
  if (!rec) return 'Re-considered';
  return `Re-considered, earlier rejected by ${rec.side === 'Client' || !rec.side ? (rec.clientName || 'the client') : (rec.byLabel || rec.sideLabel)}${rec.side === 'Internal' ? ` for ${rec.clientName || 'another job'}` : ''} (${rec.reason || 'reason not recorded'})`;
}

// --- The same-client rule (user decision #5) -------------------------------
// When a client already rejected this person, sending them to that client
// again either WARNS and asks to confirm (default) or is BLOCKED. Kept in the
// existing Integration table as an internal row (utils/portalSettings.js
// pattern) — no schema change.
const RULES_ID = 'rejection-rules';
async function rejectionRules() {
  const row = await prisma.integration.findUnique({ where: { id: RULES_ID } }).catch(() => null);
  let v = {};
  try { v = row && row.values ? JSON.parse(row.values) : {}; } catch { v = {}; }
  return { sameClient: v.sameClient === 'block' ? 'block' : 'warn' };
}
async function saveRejectionRules(patch) {
  const cur = await rejectionRules();
  const next = { ...cur };
  if (patch.sameClient !== undefined) {
    if (!['warn', 'block'].includes(patch.sameClient)) return { error: 'Choose "Warn and ask" or "Block".' };
    next.sameClient = patch.sameClient;
  }
  const values = JSON.stringify(next);
  await prisma.integration.upsert({
    where: { id: RULES_ID },
    create: { id: RULES_ID, enabled: true, state: 'Internal', values },
    update: { values },
  });
  return { settings: next, before: cur };
}

// --- Do not use --------------------------------------------------------------
// Raised right after the reject itself was recorded (applications.js). The
// approver is the TL of the requirement's team; with no (real) TL named, the
// request waits for a Super Admin / Admin.
async function requestDoNotUse({ user, eventId, requirement, candidate }) {
  if (!eventId) return null;
  let approver = null;
  if (requirement && requirement.tlId) {
    approver = await prisma.user.findUnique({ where: { id: requirement.tlId }, select: { id: true, name: true, email: true } });
    const testWorld = TEST_RE.test(String((requirement && requirement.title) || ''));
    if (approver && !testWorld && TEST_RE.test(`${approver.name} ${approver.email}`)) approver = null;
  }
  const step = await prisma.approvalStep.create({
    data: {
      workflow: DNU_WORKFLOW,
      recordId: eventId,
      level: 'TL',
      seq: 1,
      mode: 'required',
      status: 'Pending',
      approverUserId: approver ? approver.id : null,
      approverName: approver ? approver.name : 'Super Admin / Admin',
      activatedAt: new Date(),
    },
  });
  invalidate();
  try {
    // eslint-disable-next-line global-require
    const { notifyUsers } = require('./notify');
    if (approver) {
      await notifyUsers([approver.id], {
        title: `"Do not use" needs your approval — ${candidate ? candidate.name : 'candidate'}`,
        message: `${user.name} asked to block this candidate from every match list. Open the candidate's Rejection history to approve or decline.`,
        exceptUserId: null,
      });
    }
  } catch { /* a notice never undoes the request */ }
  return step;
}

// May this login decide that request? The TL the step names, the TL now named
// on the requirement, or a Super Admin / Admin.
async function canDecide(user, step) {
  if (!user || !step) return false;
  // eslint-disable-next-line global-require
  const { stageGlobal } = require('./permissions');
  if (stageGlobal(user)) return true;
  if (step.approverUserId && step.approverUserId === user.id) return true;
  const ev = await prisma.applicationStageEvent.findUnique({ where: { id: step.recordId }, select: { requirementId: true } });
  if (!ev || !ev.requirementId) return false;
  const req = await prisma.requirement.findUnique({ where: { id: ev.requirementId }, select: { tlId: true } });
  return !!(req && req.tlId && req.tlId === user.id);
}

module.exports = {
  DNU_WORKFLOW,
  DNU_STATUS,
  DNU_REASONS,
  index,
  invalidate,
  rejectionIndex,
  scopedHistory,
  attachRejectionBadges,
  publicRecord,
  visibleAppIds,
  checkCandidateFor,
  reasonMayNotApply,
  sameClientWarning,
  reconsiderNote,
  requestDoNotUse,
  canDecide,
  shortDate,
  RULES_ID,
  rejectionRules,
  saveRejectionRules,
};
