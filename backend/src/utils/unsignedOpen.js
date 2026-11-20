// ---------------------------------------------------------------------------
// OPENING A REQUIREMENT ON AN UNSIGNED AGREEMENT (founder 2026-11-05: "req reopen chesthey, idhi unsigned agret ayina sare req open
// cheyyali anukuntunnara, ani adigithey, yes ani chepthey, bde tl ki approval velli, appudu bde tl approve chesthey, req open avuthundhi,
// kotha req add cheyyali anna kuda same process").
//
//   Every door that goes live (reopen, resume, activate, status, toggle) stops at an agreement that is not Active and ASKS instead
//   of only refusing; Add requirement saves it at Agreement Check and asks the same. (Code UNSIGNED_AGREEMENT: api.js raises the
//   question on screen, components/UnsignedAgreementPopup.jsx.)
//   Yes             a request goes to the BDE TL, by the bell and a pop-up.
//   BDE TL          Approve: the requirement opens and the person who asked is told. Reject: it stays as it was, and they are told.
//   BDE TL / Admin  asking themselves: they are the approver, so Yes opens it at once.
// The approval is kept on the job (unsignedApprovedAt) and is the job's own: while it runs or is on hold it counts as open, it does not
// wait for the agreement, and profiles can go to the client. Closing ends it: reopening asks again. A move to another client clears it.
// TL / STL / Recruiter / HR never meet any of this: they keep "on hold" (utils/agreementPrivacy.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./scope');
const { requirementIsLive, agreementIsActive, agreementStatusLabel, normalizeAgreementStatus } = require('./atsVocab');
const { notifyUsers } = require('./notify');
const { logAudit } = require('./audit');

const CODE = 'UNSIGNED_AGREEMENT';
const PENDING = 'PENDING';
const nameOf = (u) => u.name || u.email || 'Someone';
const jobWords = (r) => `${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`;
const statusWord = (client) => agreementStatusLabel(normalizeAgreementStatus(client && client.agreementStatus));

const mayApprove = (user) => S.isBdeTl(user) || S.atsViewRole(user) === 'admin';

// This job already has the BDE TL's approval and is still running on it.
const covered = (r) => !!r.unsignedApprovedAt && (requirementIsLive(r.status) || r.status === 'ON_HOLD');

// The BDE TLs; the Admins only when there is no BDE TL to ask.
async function approvers() {
  const real = (u) => process.env.TEST_MODE || !/zztest|example\.test/i.test(`${u.name} ${u.email}`);
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const tls = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL' }, select: { id: true, name: true, email: true } });
  const ids = [];
  for (const u of tls.filter(real)) {
    // eslint-disable-next-line no-await-in-loop
    const who = await resolveIdentity(u.id).catch(() => null);
    if (who && S.isBdeTl(who)) ids.push(u.id);
  }
  if (ids.length) return ids;
  const admins = await prisma.user.findMany({ where: { status: 'Active', role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true, name: true, email: true } });
  return admins.filter(real).map((u) => u.id);
}

// What the screen asks. `waiting`: the question was answered already, this is only the line to show.
async function askFor(user, r, client) {
  const open = await prisma.requirementOpenRequest.findFirst({ where: { requirementId: r.id, status: PENDING }, select: { askedByName: true } });
  if (open) return { error: `Waiting for the BDE TL's approval: ${open.askedByName || 'someone'} has asked to open this requirement.`, code: CODE, waiting: true, requirementId: r.id };
  const approver = mayApprove(user);
  return {
    error: 'The client agreement is not signed. Answer the question on the screen.',
    code: CODE,
    requirementId: r.id,
    question: `The agreement with ${client ? client.name : 'this client'} is not signed yet (${statusWord(client)}). Do you still want to open ${jobWords(r)}?`,
    note: approver ? 'You approve these, so Yes opens it now.' : 'Yes sends it to the BDE TL. It opens when the BDE TL approves.',
    approver,
  };
}

// The answer Yes. `open(requirement, actor)` really opens the job (routes/requirements.js).
async function request(user, r, open) {
  const client = r.clientId ? await prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true, agreementStatus: true } }) : null;
  if (r.internal || !client || agreementIsActive(client.agreementStatus)) return { status: 409, body: { error: 'This requirement does not need an approval. Open it the usual way.' } };
  if (covered(r)) return { status: 409, body: { error: 'This requirement is already approved.' } };
  if (mayApprove(user)) {
    await open({ ...r, client }, user);
    await prisma.requirementOpenRequest.create({ data: { id: crypto.randomUUID(), requirementId: r.id, fromStatus: r.status, askedById: user.id, askedByName: nameOf(user), status: 'APPROVED', decidedById: user.id, decidedByName: nameOf(user), decidedAt: new Date() } });
    return { status: 200, body: { ok: true, opened: true, message: 'The requirement is open.' } };
  }
  let row;
  try {
    row = await prisma.requirementOpenRequest.create({ data: { id: crypto.randomUUID(), requirementId: r.id, fromStatus: r.status, askedById: user.id, askedByName: nameOf(user) } });
  } catch (e) {
    if (e.code === 'P2002') return { status: 200, body: { ok: true, waiting: true, message: 'This is already waiting for the BDE TL.' } }; // one waiting request per job
    throw e;
  }
  await notifyUsers(await approvers(), {
    title: `🔏 Approve opening: ${r.reqCode || r.title}`,
    message: `${nameOf(user)} wants to open ${jobWords(r)} for ${client.name}. The agreement is not signed (${statusWord(client)}).\nOpen: /requirements/${r.id}`,
    exceptUserId: user.id,
  }).catch(() => null);
  await logAudit({ userId: user.id, actorName: nameOf(user), action: 'Asked to open on an unsigned agreement', entity: 'Requirement', entityId: r.id, fromValue: r.status, toValue: 'Waiting for the BDE TL' });
  return { status: 200, body: { ok: true, id: row.id, message: 'Sent to the BDE TL. The requirement opens when the BDE TL approves.' } };
}

const STALE = (q) => agreementIsActive(q.requirement.client && q.requirement.client.agreementStatus) || requirementIsLive(q.requirement.status);

// What waits on this approver's screen.
async function pending(user) {
  if (!mayApprove(user)) return { canApprove: false, rows: [] };
  const rows = await prisma.requirementOpenRequest.findMany({
    where: { status: PENDING }, orderBy: { createdAt: 'asc' }, take: 100,
    include: { requirement: { select: { id: true, reqCode: true, title: true, status: true, client: { select: { name: true, agreementStatus: true } } } } },
  });
  return {
    canApprove: true,
    rows: rows.filter((q) => !STALE(q)).map((q) => ({
      id: q.id, requirementId: q.requirementId, code: q.requirement.reqCode, title: q.requirement.title, client: q.requirement.client ? q.requirement.client.name : null,
      statusWord: statusWord(q.requirement.client), askedBy: q.askedByName, reopening: q.fromStatus === 'CLOSED', at: q.createdAt,
    })),
  };
}

async function decide(user, id, approve, note, open) {
  if (!mayApprove(user) && !(await require('./atsWork/people').standsInForBdeTl(user).catch(() => false))) return { status: 403, body: { error: 'Only the BDE TL or an Admin approves this.' } }; // eslint-disable-line global-require
  const q = await prisma.requirementOpenRequest.findUnique({ where: { id }, include: { requirement: { include: { client: true } } } });
  if (!q) return { status: 404, body: { error: 'This request is no longer on file.' } };
  const r = q.requirement;
  const stale = STALE(q);
  const to = stale ? 'CANCELLED' : (approve ? 'APPROVED' : 'REJECTED');
  const why = note ? String(note).trim().slice(0, 300) : null;
  const done = await prisma.requirementOpenRequest.updateMany({ where: { id, status: PENDING }, data: { status: to, decidedById: user.id, decidedByName: nameOf(user), decidedAt: new Date(), note: why } });
  if (!done.count) return { status: 409, body: { error: 'This was already decided.' } };
  if (stale) return { status: 200, body: { ok: true, message: 'Nothing to approve: the agreement is Active now, or the requirement is already open.' } };
  if (approve) {
    try {
      await open(r, user);
    } catch (e) {
      await prisma.requirementOpenRequest.update({ where: { id }, data: { status: PENDING, decidedById: null, decidedByName: null, decidedAt: null, note: null } });
      throw e;
    }
  } else {
    await logAudit({ userId: user.id, actorName: nameOf(user), action: 'Opening on an unsigned agreement rejected', entity: 'Requirement', entityId: r.id, fromValue: r.status, toValue: r.status, reason: why || undefined });
  }
  await notifyUsers([q.askedById], {
    title: approve ? `✅ Approved: ${r.reqCode || r.title} is open` : `❌ Not approved: ${r.reqCode || r.title}`,
    message: `${nameOf(user)} ${approve ? 'approved opening' : 'did not approve opening'} ${jobWords(r)}.${why ? ` ${why}` : ''}\nOpen: /requirements/${r.id}`,
    exceptUserId: user.id,
  }).catch(() => null);
  return { status: 200, body: { ok: true, message: approve ? 'Approved. The requirement is open.' : 'Not approved. It stays as it was.' } };
}

module.exports = {
  CODE, mayApprove, covered, askFor, request, pending, decide,
};
