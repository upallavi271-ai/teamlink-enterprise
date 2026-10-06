// ---------------------------------------------------------------------------
// AGREEMENT ACTIVE → THE CLIENT'S PARKED JOBS GO LIVE (e2e gap 7, 2026-10-03).
//
// A client job added while the service agreement was not yet Active is parked
// at Agreement Check. When the agreement becomes Active (Admin presses
// Activate — routes/clients.js — or it auto-activates once both sides signed —
// utils/agreementLifecycle.js maybeAutoActivate) those jobs used to stay
// parked and nobody was told. Now each one:
//   * goes live: Recruiter assigned when a recruiter is already on it, else Open
//     (the same choice POST /requirements/:id/activate makes)
//   * gets an audit row ("Requirement opened automatically — agreement Active")
//   * is posted to the job sources like any job that goes live (jobPosting.js)
//   * its TL is told in-app — or, with no TL on the job, the Managers / Admins
//     (never a ZZTEST / example.test login).
// Draft jobs are left alone: a draft is somebody's unfinished job.
// Never throws: the agreement is already Active; this is the follow-on.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const NOT_TEST_USER = [{ name: { contains: 'zztest' } }, { name: { contains: 'ZZTEST' } }, { email: { contains: 'example.test' } }];

async function managersAndAdmins() {
  const rows = await prisma.user.findMany({
    where: {
      status: 'Active',
      NOT: NOT_TEST_USER,
      OR: [
        { role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] } },
        { atsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] } },
      ],
    },
    select: { id: true },
  });
  return rows.map((u) => u.id);
}

async function openParkedJobs(clientId, { actorUserId = null, actorName = null } = {}) {
  const out = { opened: 0, jobs: [] };
  try {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
    const parked = await prisma.requirement.findMany({
      where: { clientId, internal: false, status: 'AGREEMENT_CHECK' },
      select: {
        id: true, title: true, reqCode: true, tlId: true, recruiterId: true, recruiterIds: true,
      },
    });
    let fallback = null;
    for (const r of parked) {
      const status = (r.recruiterId || csv(r.recruiterIds).length) ? 'RECRUITER_ASSIGNED' : 'OPEN';
      // Conditional, so a job somebody changed meanwhile is not overwritten.
      // eslint-disable-next-line no-await-in-loop
      const upd = await prisma.requirement.updateMany({ where: { id: r.id, status: 'AGREEMENT_CHECK' }, data: { status } });
      if (!upd.count) continue; // eslint-disable-line no-continue
      out.opened += 1;
      out.jobs.push({ id: r.id, title: r.title, status });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: actorUserId,
        actorName: actorName || undefined,
        action: 'Requirement opened automatically — agreement Active',
        entity: 'Requirement',
        entityId: r.id,
        fromValue: 'AGREEMENT_CHECK',
        toValue: status,
        reason: `The service agreement with ${(client && client.name) || 'the client'} is now Active.`,
      });
      try {
        // eslint-disable-next-line global-require, no-await-in-loop
        await require('./jobPosting').autoPost(r.id, {
          actorId: actorUserId, actorName, trigger: 'status', prevStatus: 'AGREEMENT_CHECK', background: true,
        });
      } catch { /* posting is best-effort; the job is live either way */ }
      let to = r.tlId ? [r.tlId] : null;
      if (!to) {
        // eslint-disable-next-line no-await-in-loop
        if (!fallback) fallback = await managersAndAdmins();
        to = fallback;
      }
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers(to, {
        title: `✅ Job is live: ${r.title}`,
        message: `${(client && client.name) || 'The client'}'s agreement is Active, so ${r.reqCode || 'this job'} is now ${status === 'OPEN' ? 'Open' : 'live (recruiter already on it)'}. ${status === 'OPEN' ? 'Assign a recruiter to start.' : 'Work can start now.'}`,
        exceptUserId: actorUserId,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[openParkedJobs] could not open the parked jobs:', err.message);
  }
  return out;
}

module.exports = { openParkedJobs };
