// ---------------------------------------------------------------------------
// A RECRUITER WHO LEFT: THEIR CANDIDATES GO TO WHOEVER IS FOLLOWING THEM UP NOW (founder 2026-11-04: "oka profile ni oka
// recruiter konni days handle chesi, tharvatha ahh recruiter resign chesi vellipothey, ahh profile ni verey recruiter followup
// avuthunnaru ... ahh resign chesina recruiter name ey vasthundhi ... malli ahh profile ni add cheyyalanukuntey, already in
// application ani vasthundhi").
//
// An application whose owner (Application.ownerRecruiterId) has left - employment Exited / Relieved / Terminated, or the
// login is no longer Active - is handed to:
//   1. the active recruiter ON THAT REQUIREMENT who followed the person up most recently (a follow-up written on the
//      candidate, a call / mail / WhatsApp / SMS logged or sent to them, or a follow-up task done), else
//   2. the requirement's main recruiter (else its first active recruiter),
// so the profile shows the person working it now, and that recruiter sees it in their own list (a recruiter sees only their
// own candidates, utils/scope.js). Joined / Hired applications keep the leaver's name: that placement was their work.
// The open follow-up tasks of those applications move with them. Each move is written to the audit log, and each new owner
// gets one bell note with the count. Nothing happens when there is nobody active on the requirement (the TL sees those on
// "After exit", utils/afterExit.js, and assigns them).
//
//   run({ applicationIds })   one pass (all leavers' applications, or just these); returns { moved, byOwner }
//   startSweep()              on start (after a minute) and every hour; the sandbox runs no timers
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { LEFT } = require('./leftLogin');
const { logAudit } = require('./audit');

const KEEP = ['JOINED', 'HIRED'];
const DAY = 86400000;
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const chunks = (list, n = 400) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

async function leaverIds() {
  const rows = await prisma.user.findMany({
    where: { role: { not: 'SUPER_ADMIN' }, OR: [{ status: { not: 'Active' } }, { employee: { employmentStatus: { in: LEFT } } }] },
    select: { id: true, name: true },
  });
  return new Map(rows.map((u) => [u.id, u.name]));
}
async function activeRecruiters(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: list }, status: 'Active', atsRole: 'RECRUITER', NOT: { employee: { employmentStatus: { in: LEFT } } } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((u) => [u.id, u.name]));
}

// candidateId -> [{ userId, at }] newest first: who followed each person up, from what is already on record.
async function followersOf(candidateIds) {
  const out = new Map();
  const push = (cid, userId, at) => {
    if (!cid || !userId || !at) return;
    if (!out.has(cid)) out.set(cid, []);
    out.get(cid).push({ userId, at: new Date(at).getTime() });
  };
  const since = new Date(Date.now() - 180 * DAY);
  for (const part of chunks(candidateIds)) {
    // eslint-disable-next-line no-await-in-loop
    const [msgs, done, logs] = await Promise.all([
      prisma.candidateMessage.findMany({ where: { candidateId: { in: part }, senderUserId: { not: null }, createdAt: { gte: since } }, select: { candidateId: true, senderUserId: true, createdAt: true } }),
      prisma.applicationFollowUp.findMany({ where: { candidateId: { in: part }, completedById: { not: null }, completedAt: { gte: since } }, select: { candidateId: true, completedById: true, completedAt: true } }),
      prisma.appSetting.findMany({ where: { OR: part.map((id) => ({ key: { startsWith: `candlog.${id}.` } })) }, select: { value: true } }),
    ]);
    msgs.forEach((m) => push(m.candidateId, m.senderUserId, m.createdAt));
    done.forEach((f) => push(f.candidateId, f.completedById, f.completedAt));
    logs.forEach((r) => { try { const e = JSON.parse(r.value); if (e.source !== 'sheet') push(e.candidateId, e.byId, e.createdAt); } catch { /* a broken row */ } });
  }
  out.forEach((list) => list.sort((a, b) => b.at - a.at));
  return out;
}

let RUNNING = false;
async function run({ applicationIds = null } = {}) {
  if (RUNNING && !applicationIds) return { moved: 0, skipped: 'already running' };
  if (!applicationIds) RUNNING = true;
  try {
    const gone = await leaverIds();
    if (!gone.size) return { moved: 0 };
    const apps = await prisma.application.findMany({
      where: { ownerRecruiterId: { in: [...gone.keys()] }, stage: { notIn: KEEP }, ...(applicationIds ? { id: { in: applicationIds } } : {}) },
      select: { id: true, candidateId: true, requirementId: true, ownerRecruiterId: true, requirement: { select: { id: true, title: true, reqCode: true, recruiterId: true, recruiterIds: true } } },
    });
    if (!apps.length) return { moved: 0 };
    const team = (r) => [...new Set([r && r.recruiterId, ...csv(r && r.recruiterIds)].filter(Boolean))];
    const active = await activeRecruiters(apps.flatMap((a) => team(a.requirement)));
    const followers = await followersOf([...new Set(apps.map((a) => a.candidateId))]);
    const byOwner = new Map(); // new owner id -> count
    let moved = 0;
    for (const a of apps) {
      const onJob = team(a.requirement).filter((id) => active.has(id));
      if (!onJob.length) continue; // eslint-disable-line no-continue
      const recent = (followers.get(a.candidateId) || []).find((f) => onJob.includes(f.userId));
      const to = recent ? recent.userId : onJob[0];
      const toName = active.get(to);
      const fromName = gone.get(a.ownerRecruiterId) || 'a recruiter who left';
      // only if it is still the leaver's (two passes never fight)
      // eslint-disable-next-line no-await-in-loop
      const n = await prisma.application.updateMany({ where: { id: a.id, ownerRecruiterId: a.ownerRecruiterId }, data: { ownerRecruiterId: to } });
      if (!n.count) continue; // eslint-disable-line no-continue
      moved += 1;
      try { require('./candidateListCache').markCandidateDirty(a.candidateId); } catch { /* the list catches up by itself */ } // eslint-disable-line global-require
      byOwner.set(to, (byOwner.get(to) || 0) + 1);
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationFollowUp.updateMany({ where: { applicationId: a.id, completedAt: null, ownerUserId: a.ownerRecruiterId }, data: { ownerUserId: to, ownerName: toName, ownerRole: 'Recruiter' } }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: null, actorName: 'TeamLink', action: 'Candidate handed over (the recruiter left)', entity: 'Application', entityId: a.id,
        fromValue: fromName, toValue: toName, reason: recent ? `${toName} has been following this candidate up` : `${toName} is the recruiter on ${a.requirement.reqCode || a.requirement.title || 'the requirement'}`,
      }).catch(() => {});
    }
    if (byOwner.size) {
      const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
      for (const [uid, count] of byOwner) {
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers([uid], {
          title: `👤 ${count} candidate${count === 1 ? '' : 's'} handed to you`,
          message: `${count === 1 ? 'A candidate' : `${count} candidates`} of a recruiter who has left ${count === 1 ? 'is' : 'are'} yours now (you are on the requirement${count === 1 ? '' : 's'} and follow them up). They are in your Candidates list.`,
        }).catch(() => {});
      }
    }
    return { moved, byOwner: Object.fromEntries(byOwner) };
  } finally {
    if (!applicationIds) RUNNING = false;
  }
}

// THE FOLLOW-UPS THAT NAMED THE JOB'S MAIN RECRUITER (founder 2026-11-04: "oka profile ni oka recruiter add chesthey, add chesina
// valla name kaakunda, verey evaro recruiters names vasthunnai"). Until today a new follow-up always named the requirement's main
// recruiter, so a profile another recruiter added showed the main recruiter. Every OPEN recruiter follow-up - and, where an
// application has none open, its newest one (what the profile and the lists show) - is put on the application's own recruiter
// when that is an active recruiter. Once (AppSetting "fix.followup-owner.2026-11-04"); fixOwners({ force: true }) runs it again.
const FIX_KEY = 'fix.followup-owner.2026-11-04';
async function fixOwners({ force = false } = {}) {
  if (!force && await prisma.appSetting.findUnique({ where: { key: FIX_KEY } }).catch(() => null)) return { fixed: 0, skipped: 'done before' };
  const rows = await prisma.applicationFollowUp.findMany({
    where: { ownerRole: 'Recruiter', application: { ownerRecruiterId: { not: null } } },
    select: { id: true, applicationId: true, ownerUserId: true, completedAt: true, createdAt: true, application: { select: { ownerRecruiterId: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const openApps = new Set(rows.filter((r) => !r.completedAt).map((r) => r.applicationId));
  const newestSeen = new Set();
  const want = [];
  rows.forEach((r) => {
    const isNewest = !newestSeen.has(r.applicationId);
    newestSeen.add(r.applicationId);
    const shown = !r.completedAt || (isNewest && !openApps.has(r.applicationId));
    if (shown && r.ownerUserId !== r.application.ownerRecruiterId) want.push(r);
  });
  const owners = await activeRecruiters(want.map((r) => r.application.ownerRecruiterId));
  let fixed = 0;
  for (const r of want) {
    const to = r.application.ownerRecruiterId;
    if (!owners.has(to)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.applicationFollowUp.update({ where: { id: r.id }, data: { ownerUserId: to, ownerName: owners.get(to) } });
    fixed += 1;
  }
  await prisma.appSetting.upsert({ where: { key: FIX_KEY }, create: { key: FIX_KEY, value: JSON.stringify({ fixed, at: new Date().toISOString() }) }, update: { value: JSON.stringify({ fixed, at: new Date().toISOString() }) } }).catch(() => {});
  return { fixed, checked: rows.length };
}

let TIMER = null;
function startSweep() {
  if (require('./sandbox').isSandbox() || TIMER) return; // eslint-disable-line global-require
  const tick = () => fixOwners().then((f) => { if (f.fixed) console.log(`[followup-owner] ${f.fixed} follow-up(s) now name the candidate's own recruiter`); }).catch((e) => console.error('[followup-owner]', e.message)) // eslint-disable-line no-console
    .then(() => run()).then((r) => { if (r.moved) console.log(`[leaver-handover] ${r.moved} candidate(s) handed over`); }).catch((e) => console.error('[leaver-handover]', e.message)) // eslint-disable-line no-console
    // a BDE seat holder is an ATS BDE, and a BDE who left hands their clients to whoever sits in their seat now (utils/bdeSeatHandover.js)
    .then(() => require('./bdeSeatHandover').run()).catch((e) => console.error('[bde-seats]', e.message)); // eslint-disable-line no-console, global-require
  setTimeout(tick, 60000).unref?.();
  TIMER = setInterval(tick, 60 * 60000);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  run, fixOwners, startSweep, leaverIds, followersOf,
};
