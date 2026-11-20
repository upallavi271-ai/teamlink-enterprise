// ---------------------------------------------------------------------------
// CHANGE THE TEAM LEAD OF A CANDIDATE (founder 2026-11-20, beside "Change recruiter" on "Who is on this":
// "there must be a Change team lead button ... the reason must be asked ... that update must go to the respective TLs").
//
// The candidate's team lead is NOT stored on the candidate: it follows the recruiter's CURRENT seat in the org chart
// (utils/positionScope.js leadsOfPosition: recruiter seat -> reports-to TL seat -> its holder). So "putting a candidate under another
// team lead" means moving it to a recruiter whose seat sits under that team lead. This file:
//   optionsFor(user, app)   the team leads (and their recruiters) of the job's department(s) the candidate may move to
//   teamLeadOfApplication(app)  the ONE answer to who leads the candidate today (the recruiter's seat), used by the page, dialog, options, notices
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
  // the seat the profile shows next to the recruiter (candidates.js shownSeat): the one they held on the application day, else now
  const AO = require('./applicationOwner'); // eslint-disable-line global-require
  await AO.warmSeats().catch(() => null);
  const shown = userId ? AO.seatOf(userId, app.createdAt) : null;
  return {
    userId,
    name: user ? user.name : null,
    seatCode: shown || (seat && seat.code) || (last && last.ownerPositionCode) || (app.requirement && app.requirement.positionCode) || null,
    seatId: (seat && seat.id) || null,
  };
}

// THE ONE ANSWER TO "WHO IS THIS CANDIDATE'S TEAM LEAD" (founder 2026-11-20: a recruiter of Sirisha's team added a candidate and the page
// said Usha, the requirement's stored TL). The TL follows the recruiter's SEAT (recruiter seat -> TL seat -> its holder, and the STL above);
// only a recruiter with no seat falls back to the follow-up's / requirement's TL. The candidate page, the "Now" line of the dialog, the
// options, the notices, the stamp on a new follow-up and the repair all read this one result.
//   { tlUserId, tlName, stlUserId, stlName, seatCode, source: 'seat' | 'seat-former' | 'requirement' | 'none', owner }
// 'seat-former': the TL seat is empty now; tlName is the last holder, marked "(left)", tlUserId is null (nobody to tell).
async function teamLeadOfApplication(app, { positionCode = null } = {}) {
  const owner = await currentOwnerOf(app);
  const seatCode = positionCode || owner.seatCode || null;
  const leads = seatCode ? await leadsOfPosition({ positionCode: seatCode }).catch(() => null) : null;
  const base = { seatCode, owner, stlUserId: null, stlName: null };
  if (leads && leads.tlUserId) return { ...base, tlUserId: leads.tlUserId, tlName: leads.tlName, stlUserId: leads.stlUserId, stlName: leads.stlName, source: 'seat' };
  if (leads && leads.tlFormerName) return { ...base, tlUserId: null, tlName: `${leads.tlFormerName} (left)`, stlUserId: leads.stlUserId, stlName: leads.stlName, source: 'seat-former' };
  // no seat: what the follow-up / the requirement names
  const fu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id }, orderBy: { createdAt: 'desc' }, select: { tlUserId: true, tlName: true, stlUserId: true, stlName: true } });
  const r = app.requirement || {};
  const tlUserId = (fu && fu.tlUserId) || r.tlId || null;
  const tlName = (fu && fu.tlName) || r.tl || null;
  if (!tlUserId && !tlName) return { ...base, tlUserId: null, tlName: null, source: 'none' };
  return { ...base, tlUserId, tlName, stlUserId: (fu && fu.stlUserId) || r.stlId || null, stlName: (fu && fu.stlName) || r.stl || null, source: 'requirement' };
}
// kept for the callers that read `.leads` / `.owner`
async function currentLeads(app, opts) {
  const t = await teamLeadOfApplication(app, opts);
  return { owner: t.owner, leads: { tlUserId: t.tlUserId, tlName: t.tlName, stlUserId: t.stlUserId, stlName: t.stlName }, source: t.source, seatCode: t.seatCode };
}

// SEAT -> LEADS INDEX (for stamping a new follow-up and for the lists, which print a TL per row): every recruiter seat's leads, from
// leadsOfPosition itself, refreshed at most every 60 seconds (or at once with force). peekByUser / peekByCode read it synchronously.
const IDX = { at: 0, byUser: new Map(), byCode: new Map(), loading: null };
async function ensureIndex(force = false) {
  if (!force && Date.now() - IDX.at < 60000) return;
  if (IDX.loading) { await IDX.loading; return; }
  IDX.loading = (async () => {
    const seats = await prisma.position.findMany({ where: { kind: 'RECRUITER', active: true }, select: { id: true, code: true } });
    const held = await prisma.positionAssignment.findMany({ where: { toDate: null, positionId: { in: seats.map((x) => x.id) } }, select: { positionId: true, employee: { select: { userId: true } } } });
    const holderOf = new Map(held.filter((h) => h.employee && h.employee.userId).map((h) => [h.positionId, h.employee.userId]));
    const byUser = new Map(); const byCode = new Map();
    for (let i = 0; i < seats.length; i += 25) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(seats.slice(i, i + 25).map(async (seat) => {
        const l = await leadsOfPosition({ positionId: seat.id }).catch(() => null);
        if (!l || !l.tlUserId) return;
        const entry = { code: seat.code, tlUserId: l.tlUserId, tlName: l.tlName, stlUserId: l.stlUserId, stlName: l.stlName };
        byCode.set(String(seat.code).toUpperCase(), entry);
        if (holderOf.get(seat.id)) byUser.set(holderOf.get(seat.id), entry);
      }));
    }
    IDX.byUser = byUser; IDX.byCode = byCode; IDX.at = Date.now();
  })();
  try { await IDX.loading; } finally { IDX.loading = null; }
}
const peekByUser = (userId) => (userId ? IDX.byUser.get(userId) || null : null);
const peekByCode = (code) => (code ? IDX.byCode.get(String(code).toUpperCase()) || null : null);

// ONE-OFF, IDEMPOTENT REPAIR: open follow-ups whose stamped team lead differs from their recruiter's seat team lead are re-stamped.
// dryRun counts only. since: only rows created after this date (start-up: the last 30 days).
async function repairStamps({ dryRun = true, sinceDays = 30 } = {}) {
  await ensureIndex(true);
  const since = new Date(Date.now() - sinceDays * 86400000);
  const rows = await prisma.applicationFollowUp.findMany({
    where: { completedAt: null, createdAt: { gte: since }, ownerUserId: { not: null } },
    select: { id: true, ownerUserId: true, tlUserId: true, tlName: true, stlUserId: true },
  });
  const todo = rows.filter((r) => { const e = peekByUser(r.ownerUserId); return e && (e.tlUserId !== r.tlUserId || (e.stlUserId || null) !== (r.stlUserId || null)); });
  if (dryRun || !todo.length) return { checked: rows.length, wrong: todo.length, fixed: 0 };
  let fixed = 0;
  for (const r of todo) {
    const e = peekByUser(r.ownerUserId);
    // eslint-disable-next-line no-await-in-loop
    await prisma.applicationFollowUp.update({ where: { id: r.id }, data: { tlUserId: e.tlUserId, tlName: e.tlName, stlUserId: e.stlUserId || null, stlName: e.stlName || null } });
    fixed += 1;
  }
  await logAudit({ userId: null, actorName: 'TeamLink', action: 'Follow-up team lead re-stamped from the recruiter seat', entity: 'System', entityId: 'followups', fromValue: String(todo.length), toValue: String(fixed), reason: `open follow-ups of the last ${sinceDays} days whose team lead differed from their recruiter's seat` });
  return { checked: rows.length, wrong: todo.length, fixed };
}

// WHO MAY USE "CHANGE TEAM LEAD" (founder 2026-11-20): only the Education teams, where two team leads (Team A, Team B) work the same jobs and the
// candidate's data can end up under the wrong one. Other departments have one team lead each, so the button is not there. The list can be widened
// without code: TEAM_LEAD_CHANGE_DEPARTMENTS=Education,Medical.
const TL_CHANGE_DEPARTMENTS = () => String(process.env.TEAM_LEAD_CHANGE_DEPARTMENTS || 'Education').split(',').map(lc).filter(Boolean);
const departmentAllowed = (dept) => RD.departmentsOf({ department: dept }).map(lc).some((d) => TL_CHANGE_DEPARTMENTS().includes(d));
const allowedFor = (app) => RD.departmentsOf((app && app.requirement) || {}).map(lc).some((d) => TL_CHANGE_DEPARTMENTS().includes(d));
const REFUSAL = 'Change team lead is only for the Education teams (Team A and Team B).';

async function optionsFor(user, app, scope, curIn = null) {
  const jobDepts = RD.departmentsOf(app.requirement || {}).map(lc);
  const cur = curIn || await currentLeads(app);
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
    if (!u || u.atsRole !== 'TL' || !inJob(u, p) || (other.includes(u.id) && u.id !== cur.leads.tlUserId)) return;
    out.push({
      tlUserId: u.id, tlName: u.name, section: sectionOf(p), seatCode: p.code, current: u.id === cur.leads.tlUserId,
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

module.exports = { ACTION, departmentAllowed, allowedFor, REFUSAL, optionsFor, currentLeads, teamLeadOfApplication, currentOwnerOf, recordAndNotify, ensureIndex, peekByUser, peekByCode, repairStamps };
