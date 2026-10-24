// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE TWO PLACES THE ATS TELLS US SOMETHING HAPPENED (each is ONE line in an existing file):
//
//   onStageMoved(...)            routes/applications.js, after a recruiter moved a candidate's step.
//                                To a SHORTLISTED step -> an "offer" (a question: "place an AI call to tell them?").
//   onInterviewAnnounced(...)    utils/interviewNotices.js announceInterview(): every booking / change / cancel goes through it.
//                                scheduled / rescheduled -> older waiting calls for this interview are dropped (superseded),
//                                an "offer" for the new version; cancelled / no-show -> waiting calls are cancelled.
//
// NOTHING IS CALLED BY THESE. An offer is only a question until a person presses Confirm. A call is placed without a person
// only when an Admin ticked "automatic" for THAT requirement (AiCallJobSetting.autoShortlist / autoInterview / autoReminders).
// Both functions never throw: a problem here must never undo the move or the booking that already happened.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const DB = require('./schema');
const settingsStore = require('./settings');
const svc = require('./callService');
const P = require('./policy');
const S = require('./scripts');

const KIND_PURPOSE = { shortlist: 'Shortlist Notification', interview: 'Interview Notification' };

async function recipientFor(user, ctx, s) {
  if (user && user.id) {
    const acc = await svc.accessVerdict(user, ctx, s);
    if (acc.ok) return { id: user.id, name: user.name };
  }
  const r = ctx.requirement || {};
  const id = r.recruiterId || r.tlId || null;
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, status: true } }).catch(() => null);
  return u && u.status === 'Active' ? { id: u.id, name: u.name } : null;
}

async function supersedeOffers(applicationId, kind, exceptVersion) {
  await DB.run('UPDATE "AiCallOffer" SET "status" = \'superseded\', "decidedAt" = ? WHERE "applicationId" = ? AND "kind" = ? AND "status" = \'pending\' AND COALESCE("scheduleVersion", \'\') <> ?',
    new Date().toISOString(), applicationId, kind, exceptVersion || '');
}

async function makeOffer(ctx, kind, version, to, s, jset, actor) {
  const t = new Date().toISOString();
  const id = svc.newId('aio');
  const added = await DB.run('INSERT OR IGNORE INTO "AiCallOffer" ("id","applicationId","candidateId","requirementId","kind","scheduleVersion","status","offeredToId","offeredToName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, ctx.app.id, ctx.candidate.id, ctx.requirement.id, kind, version, 'pending', to ? to.id : null, to ? to.name : null, t);
  if (!added) return null;
  const purpose = KIND_PURPOSE[kind];
  // A person may confirm automatically only if an Admin ticked it for this requirement.
  const auto = jset && ((kind === 'shortlist' && jset.autoShortlist === 1) || (kind === 'interview' && jset.autoInterview === 1)) && s.configured;
  if (auto) {
    const r = await svc.createCalls(null, { items: [ctx.app.id], purpose, confirm: true, auto: true, via: kind === 'shortlist' ? 'auto-shortlist' : 'auto-interview' });
    const res = r.results && r.results[0];
    await DB.run('UPDATE "AiCallOffer" SET "status" = ?, "callId" = ?, "decidedAt" = ?, "decidedByName" = ? WHERE "id" = ?', res && res.ok ? 'auto' : 'auto-refused', res && res.callId ? res.callId : null, t, 'Automatic (Admin setting)', id);
    return { id, status: res && res.ok ? 'auto' : 'auto-refused', reason: res && res.error };
  }
  if (to) {
    await notifyUsers([to.id], {
      title: `AI call offer: ${ctx.candidate.name}`,
      message: `${kind === 'shortlist' ? 'Shortlisted' : 'Interview booked or changed'} for ${ctx.requirement.title}. Open the candidate and press "Call with AI assistant" to tell them. No call is placed until you confirm.`,
      exceptUserId: actor && actor.id === to.id ? actor.id : undefined,
    });
  }
  return { id, status: 'pending' };
}

async function onStageMoved({ application, existing, stage, user }) {
  try {
    const s = await settingsStore.load();
    if (s.mode === 'Off') return null;
    if (!s.shortlistStages.includes(stage) || (existing && existing.stage === stage)) return null;
    const ctx = await svc.loadContext(application.id);
    if (!ctx) return null;
    const jset = await svc.jobSetting(ctx.requirement.id);
    if (jset && jset.enabled === 0) return null;
    const already = await DB.one('SELECT "id" FROM "AiCall" WHERE "applicationId" = ? AND "purpose" = \'Shortlist Notification\' AND "status" IN (\'queued\',\'calling\',\'completed\')', ctx.app.id);
    if (already) return null;
    const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose: 'Shortlist Notification', s, now: svc.now(), jobSetting: jset });
    if (!verdict.ok) return null; // no phone / no consent / not allowed: nothing to offer
    const to = await recipientFor(user, ctx, s);
    if (!to) return null;
    const version = new Date().toISOString();
    await supersedeOffers(ctx.app.id, 'shortlist', version);
    return await makeOffer(ctx, 'shortlist', version, to, s, jset, user);
  } catch (err) {
    console.error('[ai-calling] stage hook:', err.message); // eslint-disable-line no-console
    return null;
  }
}

// Waiting calls of this interview that are not for the current version.
async function dropOlder(applicationId, currentVersion, reason) {
  const rows = await DB.all(`SELECT * FROM "AiCall" WHERE "applicationId" = ? AND "purpose" IN ('Interview Notification','Interview Reminder')
    AND ("status" = 'queued' OR ("status" IN ('busy','no-answer','failed') AND "nextAttemptAt" IS NOT NULL)) AND COALESCE("scheduleVersion", '') <> ?`, applicationId, currentVersion || '');
  for (const r of rows) await svc.cancelWith(r, reason); // eslint-disable-line no-await-in-loop
  return rows.length;
}

async function onInterviewAnnounced(applicationId, event, opts = {}) {
  try {
    const s0 = await settingsStore.load();
    if (!s0.hasRow) return null; // AI calling was never set up: nothing to do, nothing is created
    const ctx = await svc.loadContext(applicationId);
    if (!ctx) return null;
    if (event === 'cancelled' || event === 'no_show') {
      const n = await dropOlder(applicationId, null, 'The interview was cancelled, so the waiting AI call was dropped.');
      await supersedeOffers(applicationId, 'interview', '__none__');
      return { cancelled: n };
    }
    if (event !== 'scheduled' && event !== 'rescheduled') return null;
    const version = P.scheduleVersionOf(ctx.app);
    if (!version) return null;
    const dropped = await dropOlder(applicationId, version, 'The interview details changed, so this older call was dropped. The updated details are used for the new call.');
    await supersedeOffers(applicationId, 'interview', version);
    const s = await settingsStore.load();
    if (s.mode === 'Off') return { dropped };
    const jset = await svc.jobSetting(ctx.requirement.id);
    if (jset && jset.enabled === 0) return { dropped };
    const existing = await DB.one('SELECT "id" FROM "AiCall" WHERE "applicationId" = ? AND "purpose" = \'Interview Notification\' AND "scheduleVersion" = ? AND "status" <> \'cancelled\'', applicationId, version);
    if (existing) return { dropped, duplicate: true }; // this version was already told
    const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose: 'Interview Notification', s, now: svc.now(), jobSetting: jset });
    if (!verdict.ok) return { dropped };
    const to = await recipientFor(opts.actor, ctx, s);
    const offer = await makeOffer(ctx, 'interview', version, to, s, jset, opts.actor);
    return { dropped, offer };
  } catch (err) {
    console.error('[ai-calling] interview hook:', err.message); // eslint-disable-line no-console
    return null;
  }
}

// --- offers ----------------------------------------------------------------------------------------------------------------------------
async function listOffers(user, { applicationId, status = 'pending' } = {}) {
  const s = await settingsStore.load();
  const where = ['1=1']; const args = [];
  if (applicationId) { where.push('"applicationId" = ?'); args.push(applicationId); }
  if (status && status !== 'all') { where.push('"status" = ?'); args.push(status); }
  const rows = await DB.all(`SELECT * FROM "AiCallOffer" WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC LIMIT 100`, ...args);
  const out = [];
  for (const o of rows) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const ctx = await svc.loadContext(o.applicationId);
    if (!ctx) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const acc = await svc.accessVerdict(user, ctx, s);
    if (!acc.ok) continue; // eslint-disable-line no-continue
    out.push({
      id: o.id, kind: o.kind, purpose: KIND_PURPOSE[o.kind], status: o.status, applicationId: o.applicationId, candidateName: ctx.candidate.name, jobTitle: ctx.requirement.title,
      scheduleVersion: o.scheduleVersion, createdAt: o.createdAt, callId: o.callId, offeredToName: o.offeredToName,
      interviewAt: o.kind === 'interview' && ctx.app.interviewAt ? new Date(ctx.app.interviewAt).toISOString() : null,
    });
  }
  return { ok: true, rows: out };
}

async function decide(user, id, accept, input = {}) {
  const o = await DB.one('SELECT * FROM "AiCallOffer" WHERE "id" = ?', id);
  if (!o) return svc.fail(404, 'offer', 'Offer not found.');
  const ctx = await svc.loadContext(o.applicationId);
  if (!ctx) return svc.fail(404, 'offer', 'Offer not found.');
  const s = await settingsStore.load({ fresh: true });
  const acc = await svc.accessVerdict(user, ctx, s);
  if (!acc.ok) return acc;
  if (o.status !== 'pending') return svc.fail(409, 'state', 'This offer was already answered or replaced by a newer one.');
  if (!accept) {
    await DB.run('UPDATE "AiCallOffer" SET "status" = \'dismissed\', "decidedAt" = ?, "decidedByName" = ? WHERE "id" = ?', new Date().toISOString(), user.name, id);
    return { ok: true, status: 'dismissed' };
  }
  if (input.confirm !== true) return svc.fail(400, 'confirm', 'Please confirm the call first. No call is placed without your confirmation.');
  if (o.kind === 'interview' && P.scheduleVersionOf(ctx.app) !== o.scheduleVersion) {
    await DB.run('UPDATE "AiCallOffer" SET "status" = \'superseded\', "decidedAt" = ? WHERE "id" = ?', new Date().toISOString(), id);
    return svc.fail(409, 'superseded', 'The interview changed after this offer was made. A new offer was made for the updated details.');
  }
  const r = await svc.createCalls(user, { items: [o.applicationId], purpose: KIND_PURPOSE[o.kind], language: input.language, fields: input.fields, confirm: true, via: 'offer' });
  const res = r.results && r.results[0];
  if (!r.ok || !res || !res.ok) return svc.fail(res && res.code === 'duplicate' ? 409 : 403, (res && res.code) || 'refused', (res && res.error) || r.error || 'The call could not be placed.');
  await DB.run('UPDATE "AiCallOffer" SET "status" = \'accepted\', "callId" = ?, "decidedAt" = ?, "decidedByName" = ? WHERE "id" = ?', res.callId, new Date().toISOString(), user.name, id);
  await logAudit({ userId: user.id, action: 'AI call offer accepted', entity: 'Application', entityId: o.applicationId, toValue: KIND_PURPOSE[o.kind] });
  return { ok: true, status: 'accepted', callId: res.callId, callStatus: res.status };
}

module.exports = { onStageMoved, onInterviewAnnounced, listOffers, decide, dropOlder, KIND_PURPOSE, S };
