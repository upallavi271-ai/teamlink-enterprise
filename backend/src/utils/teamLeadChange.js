// ---------------------------------------------------------------------------
// CHANGE THE TEAM LEAD OF A CANDIDATE (founder 2026-11-20, beside "Change recruiter" on "Who is on this":
// "there must be a Change team lead button ... the reason must be asked ... that update must go to the respective TLs").
//
// The candidate's team lead is NOT stored on the candidate: it follows the recruiter's CURRENT seat in the org chart
// (utils/positionScope.js leadsOfPosition: recruiter seat -> reports-to TL seat -> its holder). So "putting a candidate under another
// team lead" means moving it to a recruiter whose seat sits under that team lead. This file:
//   optionsFor(user, app)   the team leads (and their recruiters) of the job's department(s) the candidate may move to
//   currentLeads(app)       who leads the candidate today (the recruiter's seat), for the "before" side and the notices
//   recordAndNotify(...)    the audit line and the bells to the old team lead, the new one and the STL above each
// The move itself is the ordinary Change recruiter (routes/applications.js POST /bulk, action assign, correct true).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const { leadsOfPosition } = require('./positionScope');
const { currentPositionOf } = require('./positions');
const RD = require('./reqDepartments');

const ACTION = 'Candidate team lead changed';
const LEFT_EMPLOYMENT = ['Relieved', 'Exited', 'Exit Process'];
const NOT_TEST = [{ name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }];
const lc = (s) => String(s || '').trim().toLowerCase();
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const deptsOfUser = (u) => [...new Set([u && u.atsDepartment, ...csv(u && u.atsScopeDepartments)].filter(Boolean))].map(lc);

// who the candidate sits with now: the open follow-up's owner, else the application's owner, else the job's recruiter
async function currentOwnerOf(app) {
  const open = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
  const last = open || await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id }, orderBy: { createdAt: 'desc' } });
  const userId = (last && last.ownerName ? last.ownerUserId : null) || app.ownerRecruiterId || (app.requirement && app.requirement.recruiterId) || null;
  const user = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } }).catch(() => null) : null;
  const seat = userId ? await currentPositionOf(userId) : null;
  return { userId, name: user ? user.name : null, seatCode: (seat && seat.code) || (last && last.ownerPositionCode) || null, seatId: (seat && seat.id) || null };
}

async function currentLeads(app) {
  const owner = await currentOwnerOf(app);
  const leads = owner.seatId || owner.seatCode
    ? await leadsOfPosition({ positionId: owner.seatId || undefined, positionCode: owner.seatId ? undefined : owner.seatCode }).catch(() => null)
    : null;
  return { owner, leads: leads || { tlUserId: null, tlName: null, stlUserId: null, stlName: null } };
}

async function optionsFor(user, app, scope) {
  const jobDepts = RD.departmentsOf(app.requirement || {}).map(lc);
  const cur = await currentLeads(app);
  const [seats, assigns] = await Promise.all([
    prisma.position.findMany({ where: { active: true, kind: { in: ['TL', 'RECRUITER'] } }, select: { id: true, code: true, name: true, department: true, team: true, kind: true, reportsToId: true } }),
    prisma.positionAssignment.findMany({
      where: { toDate: null },
      select: { positionId: true, employee: { select: { userId: true, employmentStatus: true } } },
    }),
  ]);
  const holder = new Map();
  assigns.forEach((a) => { if (a.employee && a.employee.userId && !LEFT_EMPLOYMENT.includes(a.employee.employmentStatus)) holder.set(a.positionId, a.employee.userId); });
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(holder.values())] }, status: 'Active', atsAccess: true, atsRole: { in: ['TL', 'RECRUITER'] }, NOT: NOT_TEST },
    select: { id: true, name: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true },
  });
  const uById = new Map(users.map((u) => [u.id, u]));
  const inJob = (u, seat) => !jobDepts.length || deptsOfUser(u).some((d) => jobDepts.includes(d)) || (seat.department && jobDepts.includes(lc(seat.department)));
  // a team name is a "section" only where the department has more than one team (same rule as the profile's Section)
  const teamsOf = new Map();
  seats.forEach((p) => { if (p.team && p.department) { if (!teamsOf.has(p.department)) teamsOf.set(p.department, new Set()); teamsOf.get(p.department).add(p.team); } });
  const sectionOf = (p) => (p.team && p.department && teamsOf.get(p.department) && teamsOf.get(p.department).size > 1 ? p.team : null);

  const other = scope && scope.eduTeam ? (scope.eduTeam.otherUserIds || []) : [];
  const recruitersOf = new Map();
  seats.filter((p) => p.kind === 'RECRUITER' && p.reportsToId).forEach((p) => {
    const u = uById.get(holder.get(p.id));
    if (!u || u.atsRole !== 'RECRUITER' || !inJob(u, p) || other.includes(u.id)) return;
    if (!recruitersOf.has(p.reportsToId)) recruitersOf.set(p.reportsToId, []);
    recruitersOf.get(p.reportsToId).push({ id: u.id, name: u.name, seatCode: p.code });
  });
  const out = [];
  seats.filter((p) => p.kind === 'TL').forEach((p) => {
    const u = uById.get(holder.get(p.id));
    if (!u || u.atsRole !== 'TL' || u.id === cur.leads.tlUserId || !inJob(u, p) || other.includes(u.id)) return;
    out.push({
      tlUserId: u.id, tlName: u.name, section: sectionOf(p), seatCode: p.code,
      recruiters: (recruitersOf.get(p.id) || []).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });
  out.sort((a, b) => a.tlName.localeCompare(b.tlName));
  return out;
}

// the audit line (it is what the candidate's history reads) and the bells; never to a test login, never to the person who did it
async function recordAndNotify({ app, by, reason, oldLeads, newTl, newRecruiter, oldRecruiterName }) {
  const oldName = oldLeads.tlName || 'no team lead';
  await logAudit({
    userId: by.id, action: ACTION, entity: 'Application', entityId: app.id,
    fromValue: oldName, toValue: newTl.name, reason: String(reason).slice(0, 300),
  });
  const cand = (app.candidate && app.candidate.name) || 'A candidate';
  const r = app.requirement || {};
  const job = [r.title, r.client && r.client.name].filter(Boolean).join(', ');
  const open = '/candidates/' + app.candidateId;
  const note = `Team lead changed from ${oldName} to ${newTl.name} (${reason}); now with ${newRecruiter.name}.`;
  const live = async (ids) => {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return [];
    const rows = await prisma.user.findMany({ where: { id: { in: list }, NOT: NOT_TEST }, select: { id: true } });
    return rows.map((x) => x.id);
  };
  const sent = new Set();
  // the old team lead (+ the STL above, when different from the new side's STL it still hears of it)
  if (oldLeads.tlUserId) {
    const ids = (await live([oldLeads.tlUserId])).filter((id) => id !== by.id);
    await notifyUsers(ids, {
      title: 'Candidate moved out of your team',
      message: `${cand} moved out of your team to ${newTl.name}'s team by ${by.name}. Reason: ${reason}`,
      open,
    });
    ids.forEach((id) => sent.add(id));
  }
  // the new team lead
  const newIds = (await live([newTl.id])).filter((id) => id !== by.id && !sent.has(id));
  await notifyUsers(newIds, {
    title: 'Candidate joined your team',
    message: `${cand}${job ? ` (${job})` : ''} joined your team with ${newRecruiter.name}, moved by ${by.name}. Reason: ${reason}`,
    open,
  });
  newIds.forEach((id) => sent.add(id));
  // the STL above each (when it is somebody else)
  const newLeads = await leadsOfPosition({ positionId: newRecruiter.seatId || undefined, positionCode: newRecruiter.seatId ? undefined : newRecruiter.seatCode }).catch(() => null);
  const stlOld = oldLeads.stlUserId;
  const stlNew = newLeads && newLeads.stlUserId;
  const stlIds = (await live([stlOld, stlNew])).filter((id) => id !== by.id && !sent.has(id));
  const stlMsg = (id) => (id === stlOld && id !== stlNew
    ? `${cand} moved out of ${oldName}'s team to ${newTl.name}'s team by ${by.name}. Reason: ${reason}`
    : `${cand}${job ? ` (${job})` : ''} moved from ${oldName}'s team to ${newTl.name}'s team (recruiter ${newRecruiter.name}) by ${by.name}. Reason: ${reason}`);
  for (const id of stlIds) {
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers([id], { title: 'Candidate team lead changed', message: stlMsg(id), open });
  }
  return note;
}

module.exports = { ACTION, optionsFor, currentLeads, currentOwnerOf, recordAndNotify };
