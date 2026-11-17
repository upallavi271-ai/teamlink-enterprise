// ---------------------------------------------------------------------------
// ONE PERSON, ONE CLIENT, TWO RECRUITERS (ATS audit 743 / 748, founder 2026-11-17): before a person is added to a job, look for
// their other LIVE applications with the SAME CLIENT (another job of that client). If one is there, the add needs a reason
// (the existing "say why" step, routes/applications.js), so a client never gets the same person twice from two recruiters
// without anyone noticing, and the earlier submission (who, which job, which step, when) is shown.
//   reasons(candidateId, requirement) -> ['already with <Client> for <job> (<step>, by <recruiter>, since <date>)', ...]
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ENDED = ['REJECTED', 'CLOSED', 'DROPPED', 'WITHDRAWN', 'NOT_JOINED', 'CANCELLED'];
const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

async function reasons(candidateId, requirement) {
  if (!candidateId || !requirement || !requirement.clientId || requirement.internal) return [];
  const rows = await prisma.application.findMany({
    where: { candidateId, requirementId: { not: requirement.id }, requirement: { clientId: requirement.clientId }, stage: { notIn: ENDED } },
    select: {
      stage: true, createdAt: true, ownerRecruiterId: true,
      requirement: { select: { title: true, reqCode: true, client: { select: { name: true } } } },
    },
    take: 5,
  }).catch(() => []);
  if (!rows.length) return [];
  const owners = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.ownerRecruiterId).filter(Boolean) } }, select: { id: true, name: true } }).catch(() => []);
  const nameOf = new Map(owners.map((u) => [u.id, u.name]));
  return rows.map((r) => `already with ${r.requirement.client ? r.requirement.client.name : 'this client'} for ${r.requirement.reqCode || r.requirement.title} (${String(r.stage).replace(/_/g, ' ').toLowerCase()}${nameOf.get(r.ownerRecruiterId) ? `, by ${nameOf.get(r.ownerRecruiterId)}` : ''}, since ${day(r.createdAt)})`);
}

module.exports = { reasons };
