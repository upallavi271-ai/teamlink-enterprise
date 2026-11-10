// ---------------------------------------------------------------------------
// RECRUITER HANDOVER & OWNERSHIP (founder 2026-11-10: "recruiters maaripothuu vuntaru ... previous ga drop recruiter work kothaga
// join ayina recruiter handover cheskoni work cheskuntaru ... followup chesi, joining ichindhi atrm previous recruiter, credit matram
// kothaga vachina recruiter dhi vasthaundhi").
//
// Three things are kept apart and never overwrite each other:
//   Sourced by        who first brought the candidate onto the requirement (workers.sourcedBy, read from the history: never changes)
//   Currently with    Application.ownerRecruiterId: who follows the candidate up now (changes on a handover)
//   Credit            the results go to who did them: each step to who had the candidate then (workers.creditAt), the joining to who
//                     got them Selected (workers.joinCredit - founder's rule 2026-11-10)
//
// EVERY change of owner is a handover and leaves a row (AuditLog, entity Application, action "Candidate handed over …", fromValue =
// the old recruiter, toValue = the new one, createdAt = when). Those rows are what the credit reads for any time before the handover,
// because the open follow-up tasks move to the new recruiter and must not make the old work look like theirs.
// A Joined / Hired candidate is never handed over: the placement stays with the person who made it.
//
//   KEEP                                      the steps that are never handed over
//   handoversFor(appIds | null)               Map appId -> [{ at, from, to, by, reason }] oldest first
//   moveOwner({ apps, to, by, kind, reason }) moves the owner (and the old owner's open follow-up tasks), one row each; -> moved ids
//   toDefaultOwner(requirement, by)           a recruiter taken off a requirement: their candidates go to its main recruiter
//   recordOnly({ appId, from, to, by, kind, reason })   an owner change made elsewhere (the follow-up "Assign to recruiter")
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const KEEP = ['JOINED', 'HIRED'];
const ACTION = 'Candidate handed over';
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const chunks = (list, n = 400) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

async function handoversFor(appIds = null) {
  const out = new Map();
  const base = { entity: 'Application', action: { startsWith: ACTION } };
  const parts = appIds ? chunks([...new Set(appIds.filter(Boolean))]) : [null];
  for (const part of parts) {
    if (part && !part.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.auditLog.findMany({
      where: part ? { ...base, entityId: { in: part } } : base,
      select: { entityId: true, fromValue: true, toValue: true, reason: true, action: true, createdAt: true, actorName: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }).catch(() => []);
    rows.forEach((r) => {
      if (!r.entityId || !r.toValue) return;
      if (!out.has(r.entityId)) out.set(r.entityId, []);
      out.get(r.entityId).push({
        at: new Date(r.createdAt).getTime(), from: r.fromValue && r.fromValue !== '—' ? r.fromValue.replace(/ \(left\)$/, '') : null, to: r.toValue,
        by: (r.user && r.user.name) || r.actorName || 'TeamLink', reason: r.reason || null, kind: (/\((.+)\)$/.exec(r.action) || [])[1] || null,
      });
    });
  }
  return out;
}

const userNames = async (ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
};

/** apps: [{ id, candidateId, ownerRecruiterId, stage }]; to: { id, name }; by: { id, name } | null -> [moved application ids] */
async function moveOwner({ apps, to, by = null, kind = 'handed over by hand', reason = null, moveTasks = true }) {
  const list = (apps || []).filter((a) => a && !KEEP.includes(a.stage) && a.ownerRecruiterId !== to.id);
  const names = await userNames(list.map((a) => a.ownerRecruiterId));
  const moved = [];
  for (const a of list) {
    // only if the owner is still who we read (two moves never fight)
    // eslint-disable-next-line no-await-in-loop
    const n = await prisma.application.updateMany({ where: { id: a.id, ownerRecruiterId: a.ownerRecruiterId || null, stage: { notIn: KEEP } }, data: { ownerRecruiterId: to.id } });
    if (!n.count) continue; // eslint-disable-line no-continue
    moved.push(a.id);
    try { require('./candidateListCache').markCandidateDirty(a.candidateId); } catch { /* the list catches up by itself */ } // eslint-disable-line global-require
    if (moveTasks && a.ownerRecruiterId) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationFollowUp.updateMany({ where: { applicationId: a.id, completedAt: null, ownerUserId: a.ownerRecruiterId }, data: { ownerUserId: to.id, ownerName: to.name, ownerRole: 'Recruiter' } }).catch(() => {});
    }
    if (a.ownerRecruiterId) {
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: by ? by.id : null, actorName: by ? by.name : 'TeamLink', action: `${ACTION} (${kind})`, entity: 'Application', entityId: a.id,
        fromValue: names.get(a.ownerRecruiterId) || 'a recruiter', toValue: to.name, reason: reason ? String(reason).slice(0, 300) : null,
      }).catch(() => {});
    }
  }
  return moved;
}

async function recordOnly({ appId, from, to, by = null, kind = 'assigned', reason = null }) {
  if (!appId || !to || !from || from === to) return;
  await logAudit({ userId: by ? by.id : null, actorName: by ? by.name : 'TeamLink', action: `${ACTION} (${kind})`, entity: 'Application', entityId: appId, fromValue: from, toValue: to, reason }).catch(() => {});
}

// A recruiter taken off a requirement (assign / reassign): their candidates - never a Joined / Hired one - go to the requirement's
// main recruiter, and a candidate with no recruiter yet gets them too (no handover row: nobody had them).
async function toDefaultOwner(requirement, by = null) {
  const to = requirement.recruiterId || csv(requirement.recruiterIds)[0] || null;
  if (!to) return 0;
  const onIt = [requirement.recruiterId, ...csv(requirement.recruiterIds)].filter(Boolean);
  const apps = await prisma.application.findMany({
    where: { requirementId: requirement.id, stage: { notIn: KEEP }, OR: [{ ownerRecruiterId: null }, ...(onIt.length ? [{ ownerRecruiterId: { notIn: onIt } }] : [])] },
    select: { id: true, candidateId: true, ownerRecruiterId: true, stage: true },
  });
  if (!apps.length) return 0;
  const unowned = apps.filter((a) => !a.ownerRecruiterId).map((a) => a.id);
  if (unowned.length) await prisma.application.updateMany({ where: { id: { in: unowned }, ownerRecruiterId: null }, data: { ownerRecruiterId: to } });
  const toName = (await userNames([to])).get(to) || 'the main recruiter';
  const moved = await moveOwner({ apps: apps.filter((a) => a.ownerRecruiterId), to: { id: to, name: toName }, by, kind: 'taken off the requirement', reason: `${requirement.reqCode || requirement.title || 'The requirement'}: the recruiter was taken off it` });
  return unowned.length + moved.length;
}

module.exports = { KEEP, ACTION, handoversFor, moveOwner, recordOnly, toDefaultOwner };
