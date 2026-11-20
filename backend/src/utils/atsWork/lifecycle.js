// ---------------------------------------------------------------------------
// LIFECYCLE AUTOMATIONS (Audit 169 / 610 / 614 / 615 / 616 / 618). Each one sits behind an Admin switch (utils/atsWork/core.js, OFF by default
// except the audit / dedupe ones) and none posts money, mails or messages anyone outside the app by itself.
//   onStatusChange   a requirement On hold: its tasks are paused (carry-over lists skip it) while the Admin switch is on; resumed when it reopens.
//                    The notices to its recruiters, the Hold of its candidates and the closing of their follow-ups are utils/requirementLifecycle.js's
//                    (so nobody is told twice here).
//   closeList / closeAndNotify   a Closed requirement: the open pipeline, and one click to close them all with the reason - each goes through
//                                the ordinary Rejected move, so the candidate message is whatever the existing messaging rules queue (a no-op in the sandbox).
//   onJoined         a confirmed joining drafts a recruiter-incentive and a referral PAYOUT PROPOSAL (amount decided later) for Accounts to approve.
//   payouts / decidePayout   the "Pending payout approvals" list; approving records the decision only, no money moves.
//   failures / retryStep / sweep   failed AI / API steps with a Retry button and an hourly automatic retry (3 tries, growing waits) when the switch is on.
//   shortlist*       the 65% rule hands portal candidates to the recruiter for approval first (Admin switch), approved or rejected in bulk.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const core = require('./core');
const { logAudit } = require('../audit');
const { notifyUsers } = require('../notify');

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const OPEN_STAGES_EXCLUDED = ['REJECTED', 'JOINED', 'HIRED'];

// ------------------------------------------------------------------ hold / close
async function onStatusChange(requirement, from, to, actor) {
  const s = await core.load({ maxAgeMs: 0 });
  if (to === 'ON_HOLD' && s.onHoldPause.enabled) {
    await core.x('INSERT OR REPLACE INTO "AtsRequirementPause" ("requirementId","pausedAt","pausedById","resumedAt") VALUES (?,?,?,NULL)', requirement.id, core.nowIso(), actor && actor.id);
    await logAudit({ userId: actor && actor.id, actorName: actor && actor.name, action: 'Requirement tasks paused (on hold)', entity: 'Requirement', entityId: requirement.id, toValue: 'Paused' });
    return { paused: true };
  }
  if (from === 'ON_HOLD' && to !== 'ON_HOLD') {
    const n = await core.x('UPDATE "AtsRequirementPause" SET "resumedAt" = ? WHERE "requirementId" = ? AND "resumedAt" IS NULL', core.nowIso(), requirement.id);
    if (Number(n) > 0) {
      await logAudit({ userId: actor && actor.id, actorName: actor && actor.name, action: 'Requirement tasks resumed', entity: 'Requirement', entityId: requirement.id, toValue: 'Resumed' });
      return { resumed: true };
    }
  }
  return {};
}
const pausedIds = async () => new Set((await core.q('SELECT "requirementId" FROM "AtsRequirementPause" WHERE "resumedAt" IS NULL')).map((r) => r.requirementId));

async function closeList(requirementId) {
  const r = await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true, status: true, title: true, reqCode: true } });
  if (!r) return { status: 404, error: 'Requirement not found' };
  const apps = await prisma.application.findMany({
    where: { requirementId, stage: { notIn: OPEN_STAGES_EXCLUDED } },
    select: { id: true, stage: true, candidate: { select: { name: true } }, ownerRecruiterId: true }, orderBy: { updatedAt: 'desc' }, take: 500,
  });
  const V = require('../atsVocab');
  return { status: 200, closed: r.status === 'CLOSED', requirement: { id: r.id, title: r.title, code: r.reqCode }, count: apps.length, rows: apps.map((a) => ({ applicationId: a.id, candidate: a.candidate && a.candidate.name, step: V.stageLabel(a.stage) })) };
}
async function closeAndNotify(user, requirementId) {
  const s = await core.load({ maxAgeMs: 0 });
  if (!s.closeNotify.enabled) return { status: 409, error: 'This is switched off. An Admin turns on "Close the pipeline when a requirement is closed" under Administration → Step timing.' };
  const list = await closeList(requirementId);
  if (list.error) return list;
  if (!list.closed) return { status: 409, error: 'Close the requirement first.' };
  const { applyStageMove } = require('../../routes/applications');
  const results = [];
  for (const row of list.rows) {
    // eslint-disable-next-line no-await-in-loop
    const out = await applyStageMove(user, row.applicationId, { stage: 'REJECTED', rejectedBy: 'Internal', rejectKind: 'not_suitable', reasonCategory: 'Requirement closed', reasonDetail: `The requirement ${list.requirement.code || list.requirement.title} was closed.` });
    results.push({ ...row, ok: out.status === 200, error: out.status === 200 ? null : (out.body && out.body.error) || 'Refused' });
  }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Pipeline closed with the requirement', entity: 'Requirement', entityId: requirementId, toValue: `${results.filter((x) => x.ok).length} of ${results.length} closed` });
  return { status: 200, moved: results.filter((x) => x.ok).length, skipped: results.filter((x) => !x.ok), total: results.length };
}

// ------------------------------------------------------------------ payout proposals (616)
async function onJoined(applicationId, actor) {
  const s = await core.load();
  if (!s.payoutProposal.enabled) return { skipped: 'switch off' };
  const a = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, candidateId: true, requirementId: true, ownerRecruiterId: true, source: true, hiringType: true, candidate: { select: { name: true, referredByName: true, referredByEmployeeId: true, source: true } }, requirement: { select: { title: true, recruiterId: true, internal: true, client: { select: { name: true } } } } },
  });
  if (!a) return { skipped: 'no application' };
  const inv = await prisma.invoice.findFirst({ where: { candidateId: a.candidateId, requirementId: a.requirementId }, select: { id: true } });
  const recruiterId = a.ownerRecruiterId || (a.requirement && a.requirement.recruiterId) || null;
  const recruiter = recruiterId ? await prisma.user.findUnique({ where: { id: recruiterId }, select: { id: true, name: true } }) : null;
  const base = { applicationId, candidateName: a.candidate && a.candidate.name, jobTitle: a.requirement && a.requirement.title, clientName: a.requirement && a.requirement.internal ? 'TeamLink Internal' : (a.requirement && a.requirement.client && a.requirement.client.name), invoiceId: inv ? inv.id : null };
  const made = [];
  const add = async (kind, personId, personName, note) => {
    const n = await core.x('INSERT OR IGNORE INTO "AtsPayoutProposal" ("applicationId","kind","personId","personName","candidateName","jobTitle","clientName","invoiceId","amount","note","status","createdAt") VALUES (?,?,?,?,?,?,?,?,NULL,?,\'Pending\',?)',
      base.applicationId, kind, personId, personName, base.candidateName, base.jobTitle, base.clientName, base.invoiceId, note, core.nowIso());
    if (Number(n) > 0) made.push(kind);
  };
  if (recruiter && !(a.requirement && a.requirement.internal)) await add('Recruiter incentive', recruiter.id, recruiter.name, 'Amount comes from the incentive rules; decide it when approving.');
  const referred = a.candidate && (a.candidate.referredByName || a.candidate.referredByEmployeeId);
  if (referred || /referr/i.test(String(a.source || (a.candidate && a.candidate.source) || ''))) await add('Referral bonus', a.candidate.referredByEmployeeId || null, a.candidate.referredByName || 'Referrer', 'Check the referral policy before paying.');
  if (made.length) await logAudit({ userId: actor && actor.id, actorName: actor && actor.name, action: 'Payout proposal drafted', entity: 'Application', entityId: applicationId, toValue: made.join(', '), reason: 'Waiting for Accounts. No money is posted automatically.' });
  return { made };
}
async function payouts(status = 'Pending') {
  const rows = await core.q('SELECT * FROM "AtsPayoutProposal" WHERE "status" = ? ORDER BY "id" DESC LIMIT 300', status);
  return rows.map((r) => ({ ...r, id: Number(r.id), amount: r.amount === null ? null : Number(r.amount) }));
}
async function decidePayout(id, user, decision, amount, note) {
  if (!['Approved', 'Rejected'].includes(decision)) return { status: 400, error: 'Say Approved or Rejected.' };
  const [row] = await core.q('SELECT * FROM "AtsPayoutProposal" WHERE "id" = ?', Number(id));
  if (!row) return { status: 404, error: 'Proposal not found.' };
  if (row.status !== 'Pending') return { status: 409, error: `Already ${row.status.toLowerCase()}.` };
  const amt = amount === undefined || amount === null || amount === '' ? null : Number(amount);
  if (amt !== null && (!Number.isFinite(amt) || amt < 0)) return { status: 400, error: 'Write the amount as a number.' };
  await core.x('UPDATE "AtsPayoutProposal" SET "status" = ?, "amount" = COALESCE(?, "amount"), "note" = COALESCE(?, "note"), "decidedById" = ?, "decidedByName" = ?, "decidedAt" = ? WHERE "id" = ?', decision, amt, note ? String(note).slice(0, 300) : null, user.id, user.name, core.nowIso(), Number(id));
  await logAudit({ userId: user.id, actorName: user.name, action: `Payout proposal ${decision.toLowerCase()}`, entity: 'Application', entityId: row.applicationId, fromValue: row.kind, toValue: amt === null ? decision : `${decision}: ${amt}`, reason: 'Decision only; the payment is made in Accounts / payroll.' });
  return { status: 200, ok: true };
}

// ------------------------------------------------------------------ failed steps + retry (618)
const failures = async (status = null) => {
  const rows = status ? await core.q('SELECT * FROM "AtsFailedStep" WHERE "status" = ? ORDER BY "id" DESC LIMIT 200', status) : await core.q('SELECT * FROM "AtsFailedStep" ORDER BY "id" DESC LIMIT 200');
  return rows.map((r) => ({ ...r, id: Number(r.id), tries: Number(r.tries) }));
};
const HANDLERS = {
  matching: async (r) => { const out = await require('./allocation').runMatch(r.refId, { force: true }); return out.error ? { ok: false, error: out.error } : { ok: true }; },
  posting: async (r) => { const out = await require('../jobPosting').autoPost(r.refId, { trigger: 'retry', actorName: 'TeamLink (retry)' }); return out && out.ok !== false ? { ok: true } : { ok: false, error: (out && (out.error || out.skipped)) || 'Posting did not go through' }; },
};
async function retryStep(id, actor, { auto = false } = {}) {
  const [r] = await core.q('SELECT * FROM "AtsFailedStep" WHERE "id" = ?', Number(id));
  if (!r) return { status: 404, error: 'Not found.' };
  if (r.status !== 'Failed') return { status: 409, error: `Already ${r.status.toLowerCase()}.` };
  const fn = HANDLERS[r.kind];
  const tries = Number(r.tries) + 1;
  let out;
  if (!fn) out = { ok: false, error: 'This step cannot be re-run by itself. Do it again from its own screen, then press "Mark done".' };
  else { try { out = await fn(r); } catch (e) { out = { ok: false, error: e.message }; } }
  if (out.ok) {
    await core.x('UPDATE "AtsFailedStep" SET "status" = \'Done\', "tries" = ?, "lastTryAt" = ?, "resolvedAt" = ?, "error" = NULL WHERE "id" = ?', tries, core.nowIso(), core.nowIso(), Number(id));
    await logAudit({ userId: actor && actor.id, actorName: actor ? actor.name : 'TeamLink', action: `Failed step retried${auto ? ' automatically' : ''}`, entity: 'AtsFailedStep', entityId: String(id), toValue: `${r.label} worked on try ${tries}` });
    return { status: 200, ok: true };
  }
  const gaveUp = tries >= 3 && auto;
  const wait = [15, 60, 240][Math.min(tries - 1, 2)];
  await core.x('UPDATE "AtsFailedStep" SET "status" = ?, "tries" = ?, "lastTryAt" = ?, "error" = ?, "nextTryAt" = ? WHERE "id" = ?', gaveUp ? 'Gave up' : 'Failed', tries, core.nowIso(), String(out.error || '').slice(0, 500), new Date(Date.now() + wait * 60000).toISOString(), Number(id));
  return { status: 200, ok: false, error: out.error, tries, gaveUp };
}
async function markDone(id, actor) {
  await core.x('UPDATE "AtsFailedStep" SET "status" = \'Done\', "resolvedAt" = ? WHERE "id" = ? AND "status" <> \'Done\'', core.nowIso(), Number(id));
  await logAudit({ userId: actor.id, actorName: actor.name, action: 'Failed step marked done', entity: 'AtsFailedStep', entityId: String(id) });
  return { status: 200, ok: true };
}
// the hourly worker: only when the Admin switch is on; at most 3 automatic tries per step, each wait longer than the last
async function sweep() {
  const s = await core.load({ maxAgeMs: 0 });
  if (!s.autoRetry.enabled) return { skipped: 'switch off' };
  const due = await core.q('SELECT "id" FROM "AtsFailedStep" WHERE "status" = \'Failed\' AND "tries" < 3 AND ("nextTryAt" IS NULL OR "nextTryAt" <= ?) LIMIT 50', core.nowIso());
  let worked = 0;
  for (const d of due) { // eslint-disable-next-line no-await-in-loop
    const out = await retryStep(d.id, null, { auto: true }); if (out.ok) worked += 1;
  }
  return { tried: due.length, worked };
}
let TIMER = null;
function startSweep() {
  if (TIMER) return;
  TIMER = setInterval(() => { sweep().catch(() => {}); }, 3600000);
  TIMER.unref();
}

// ------------------------------------------------------------------ AI shortlist approval (169)
// Called by utils/autoSendToAts.js when every 65% condition holds. true = hold it for the recruiter.
async function shortlistHold(app, why, aiScore, resumeScore) {
  const s = await core.load();
  if (!s.aiShortlistApproval.enabled) return false;
  const [have] = await core.q('SELECT "status" FROM "AtsShortlistApproval" WHERE "applicationId" = ?', app.id);
  if (have) return have.status !== 'Approved';
  await core.x('INSERT OR IGNORE INTO "AtsShortlistApproval" ("applicationId","requirementId","candidateName","jobTitle","aiScore","resumeScore","reasons","status","createdAt") VALUES (?,?,?,?,?,?,?,\'Pending\',?)',
    app.id, app.requirementId, app.candidate && app.candidate.name, app.requirement && app.requirement.title, aiScore, resumeScore, why, core.nowIso());
  const r = app.requirement || {};
  await notifyUsers([r.recruiterId, ...csv(r.recruiterIds), app.ownerRecruiterId].filter(Boolean), { title: `${app.candidate ? app.candidate.name : 'A candidate'} waits for your approval`, message: `${why} · ${r.title || ''}\nOpen the Recruiter approval list on your dashboard.` });
  await logAudit({ action: 'AI shortlist held for recruiter approval', entity: 'Application', entityId: app.id, toValue: why });
  return true;
}
async function shortlistList(user, { scopeIds = null } = {}) {
  const rows = await core.q('SELECT * FROM "AtsShortlistApproval" WHERE "status" = \'Pending\' ORDER BY "createdAt" DESC LIMIT 300');
  const list = rows.filter((r) => !scopeIds || scopeIds.has(r.applicationId));
  return list.map((r) => ({ applicationId: r.applicationId, requirementId: r.requirementId, candidate: r.candidateName, job: r.jobTitle, aiScore: r.aiScore === null ? null : Number(r.aiScore), resumeScore: r.resumeScore === null ? null : Number(r.resumeScore), reasons: r.reasons, since: r.createdAt }));
}
async function shortlistDecide(user, ids, decision, note) {
  if (!['approve', 'reject'].includes(decision)) return { status: 400, error: 'Say approve or reject.' };
  const out = [];
  for (const id of [...new Set(ids)].slice(0, 200)) {
    // eslint-disable-next-line no-await-in-loop
    const [r] = await core.q('SELECT * FROM "AtsShortlistApproval" WHERE "applicationId" = ?', String(id));
    if (!r || r.status !== 'Pending') { out.push({ applicationId: id, ok: false, error: 'Nothing waiting for this one.' }); continue; }
    if (decision === 'approve') {
      // eslint-disable-next-line no-await-in-loop
      const sent = await require('../autoSendToAts').check(String(id), { approved: true });
      if (!sent.sent && !/already sent/.test(String(sent.why))) { out.push({ applicationId: id, ok: false, error: sent.why }); continue; }
    }
    // eslint-disable-next-line no-await-in-loop
    await core.x('UPDATE "AtsShortlistApproval" SET "status" = ?, "decidedById" = ?, "decidedByName" = ?, "decidedAt" = ? WHERE "applicationId" = ?', decision === 'approve' ? 'Approved' : 'Rejected', user.id, user.name, core.nowIso(), String(id));
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ userId: user.id, actorName: user.name, action: `AI shortlist ${decision === 'approve' ? 'approved' : 'rejected'} by recruiter`, entity: 'Application', entityId: String(id), reason: note || undefined });
    out.push({ applicationId: id, ok: true });
  }
  return { status: 200, done: out.filter((x) => x.ok).length, results: out };
}

module.exports = {
  onStatusChange, pausedIds, closeList, closeAndNotify, onJoined, payouts, decidePayout, failures, retryStep, markDone, sweep, startSweep,
  shortlistHold, shortlistList, shortlistDecide,
};
