// ---------------------------------------------------------------------------
// REQUIREMENT -> SUGGEST / AUTO-ASSIGN RECRUITERS -> MATCH (Audit 192 / 193 / 194 / 433 / 603, Checklist-120 #36).
//   suggest(requirement)      the department's recruiters, best first, each with the reason ("5 open jobs, 3 joinings in Java").
//                             Skills / industry fit comes from their own joinings (history); the load from their open jobs and candidates.
//                             Someone on approved leave today, or rostered OFF today (HRMS Shift Roster), is listed but never picked.
//   autoAssign(requirement)   ONLY when the Admin switch is on: the best N get the job, are told, and the matching runs once.
//   runMatch(requirementId)   the "Good fit" list worked out once and kept (AtsMatchRun).
//   postingBlock(requirement) the plain sentence when posting must wait for a recruiter (Admin switch "Require a recruiter before posting").
// Nothing here posts, mails or messages anyone outside the app.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const core = require('./core');
const { logAudit } = require('../audit');
const { notifyUsers } = require('../notify');
const RD = require('../reqDepartments');

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const CLOSED_STAGES = ['REJECTED', 'JOINED', 'HIRED', 'HOLD'];
const TEST_RE = /zztest|example\.test/i;
const LEFT = ['Relieved', 'Exited', 'Exit Process', 'Terminated'];
const OFF_SHIFT = /\boff\b|week.?off|leave|holiday|rest/i;
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const words = (s) => csv(String(s || '').replace(/[;/|]/g, ',')).map((w) => w.toLowerCase());

// who is on approved leave today / rostered off today -> Map userId -> sentence
async function awayToday(day = todayIst()) {
  const away = new Map();
  try {
    const onLeave = await require('../leaveCover').onLeaveOn(day);
    onLeave.forEach((v, uid) => away.set(uid, 'on leave today'));
  } catch { /* leave data missing: nobody is skipped for it */ }
  try {
    const rows = await prisma.employeeRecord.findMany({ where: { type: 'SHIFT', date: day }, select: { title: true, employee: { select: { userId: true } } } });
    rows.forEach((r) => { const uid = r.employee && r.employee.userId; if (uid && OFF_SHIFT.test(String(r.title || ''))) away.set(uid, 'off shift today'); });
  } catch { /* no roster */ }
  return away;
}

async function suggest(requirement, { limit = 8, includeAway = true } = {}) {
  const depts = RD.departmentsOf(requirement).map((d) => String(d).toLowerCase());
  const users = await prisma.user.findMany({
    where: { atsAccess: true, status: 'Active', atsRole: 'RECRUITER' },
    select: { id: true, name: true, email: true, atsDepartment: true, atsScopeDepartments: true, employee: { select: { department: true, employmentStatus: true } } },
  });
  const isBde = (u) => /^bde$/i.test(String(u.atsDepartment || ''));
  let pool = users.filter((u) => !(u.employee && LEFT.includes(u.employee.employmentStatus)) && !isBde(u)
    && (process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX ? true : !TEST_RE.test(`${u.name} ${u.email}`)));
  if (depts.length) {
    const inDept = pool.filter((u) => [u.atsDepartment, ...csv(u.atsScopeDepartments), u.employee && u.employee.department].filter(Boolean).some((d) => depts.includes(String(d).toLowerCase())));
    if (inDept.length) pool = inDept;
  }
  if (!pool.length) return [];
  const ids = pool.map((u) => u.id);
  const jobSkills = new Set(words(requirement.skills));
  const client = requirement.clientId ? await prisma.client.findUnique({ where: { id: requirement.clientId }, select: { industry: true } }).catch(() => null) : null;
  const industry = String((client && client.industry) || '').toLowerCase();
  const [liveReqs, openApps, joined, away] = await Promise.all([
    prisma.requirement.findMany({ where: { status: { in: LIVE }, OR: [{ recruiterId: { in: ids } }, { recruiterIds: { not: null } }] }, select: { recruiterId: true, recruiterIds: true } }),
    prisma.application.groupBy({ by: ['ownerRecruiterId'], where: { ownerRecruiterId: { in: ids }, stage: { notIn: CLOSED_STAGES } }, _count: { _all: true } }),
    prisma.application.findMany({ where: { ownerRecruiterId: { in: ids }, stage: { in: ['JOINED', 'HIRED'] } }, select: { ownerRecruiterId: true, requirement: { select: { skills: true, client: { select: { industry: true } } } } } }),
    awayToday(),
  ]);
  const open = new Map(); ids.forEach((i) => open.set(i, 0));
  liveReqs.forEach((r) => { [r.recruiterId, ...csv(r.recruiterIds)].filter((i) => open.has(i)).forEach((i, k, a) => { if (a.indexOf(i) === k) open.set(i, open.get(i) + 1); }); });
  const cands = new Map(openApps.map((x) => [x.ownerRecruiterId, x._count._all]));
  const hist = new Map(); // id -> { total, skill, ind, skillName }
  joined.forEach((a) => {
    const h = hist.get(a.ownerRecruiterId) || { total: 0, skill: 0, ind: 0, skills: new Map() };
    h.total += 1;
    const shared = words(a.requirement && a.requirement.skills).filter((w) => jobSkills.has(w));
    if (shared.length) { h.skill += 1; shared.forEach((w) => h.skills.set(w, (h.skills.get(w) || 0) + 1)); }
    const ind = String((a.requirement && a.requirement.client && a.requirement.client.industry) || '').toLowerCase();
    if (industry && ind && ind === industry) h.ind += 1;
    hist.set(a.ownerRecruiterId, h);
  });
  const list = pool.map((u) => {
    const h = hist.get(u.id) || { total: 0, skill: 0, ind: 0, skills: new Map() };
    const openJobs = open.get(u.id) || 0; const openCands = cands.get(u.id) || 0;
    const topSkill = [...h.skills.entries()].sort((a, b) => b[1] - a[1])[0];
    const bits = [`${openJobs} open job${openJobs === 1 ? '' : 's'}`];
    if (topSkill) bits.push(`${h.skill} joining${h.skill === 1 ? '' : 's'} in ${topSkill[0].replace(/\b\w/g, (c) => c.toUpperCase())}`);
    else if (h.total) bits.push(`${h.total} joining${h.total === 1 ? '' : 's'} in all`);
    if (h.ind) bits.push(`${h.ind} in ${(client && client.industry) || 'the same industry'}`);
    bits.push(`${openCands} candidates in progress`);
    const skip = away.get(u.id) || null;
    if (skip) bits.push(skip);
    return {
      userId: u.id, name: u.name, openJobs, openCandidates: openCands, joinings: h.total, skillJoinings: h.skill, industryJoinings: h.ind,
      score: Math.round((h.skill * 3 + h.ind * 2 + h.total * 0.5 - openJobs * 2 - openCands * 0.2) * 10) / 10,
      away: skip, reason: bits.join(', '),
    };
  });
  list.sort((a, b) => (!!a.away - !!b.away) || (b.score - a.score) || a.name.localeCompare(b.name));
  return (includeAway ? list : list.filter((x) => !x.away)).slice(0, limit);
}

// ---- the matching, run once ("Good fit")
async function runMatch(requirementId, { force = false } = {}) {
  const [prev] = await core.q('SELECT * FROM "AtsMatchRun" WHERE "requirementId" = ?', requirementId);
  if (prev && !force) return { ranAt: prev.ranAt, goodFit: Number(prev.goodFit), total: Number(prev.total), top: JSON.parse(prev.top || '[]'), already: true };
  try {
    const { MATCH_THRESHOLD, rankCandidates } = require('../matching');
    const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!r) return { error: 'Requirement not found' };
    const cands = await prisma.candidate.findMany({ select: { id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true, skills: true, education: true, availability: true, currentSalary: true, expectedSalary: true, jobPreference: true, noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true, specialisationId: true } });
    const linked = new Set((await prisma.application.findMany({ where: { requirementId }, select: { candidateId: true } })).map((a) => a.candidateId));
    const ranked = rankCandidates(cands, r, { excludeIds: linked });
    const good = ranked.filter((c) => c.match.overall >= MATCH_THRESHOLD);
    const top = ranked.slice(0, 10).map((c) => ({ id: c.id, name: c.name, fit: c.match.overall }));
    const at = core.nowIso();
    await core.x('INSERT OR REPLACE INTO "AtsMatchRun" ("requirementId","ranAt","goodFit","total","top") VALUES (?,?,?,?,?)', requirementId, at, good.length, ranked.length, JSON.stringify(top));
    return { ranAt: at, goodFit: good.length, total: ranked.length, top };
  } catch (e) {
    await core.recordFailure({ kind: 'matching', refId: requirementId, label: 'Candidate matching', error: e.message });
    return { error: `Matching did not run: ${e.message}. It is listed under Failed steps with a Retry button.` };
  }
}
const matchOf = async (requirementId) => {
  const [r] = await core.q('SELECT * FROM "AtsMatchRun" WHERE "requirementId" = ?', requirementId);
  return r ? { ranAt: r.ranAt, goodFit: Number(r.goodFit), total: Number(r.total), top: JSON.parse(r.top || '[]') } : null;
};

// ---- give the job to recruiters (the same fields the Assign dialog writes)
async function giveTo(requirement, picks, actor, { auto = false } = {}) {
  const ids = picks.map((p) => p.userId || p);
  const before = requirement;
  const all = [...new Set([before.recruiterId, ...csv(before.recruiterIds), ...ids].filter(Boolean))];
  const main = before.recruiterId || all[0];
  const rest = all.filter((i) => i !== main);
  const data = { recruiterId: main, recruiterIds: rest.length ? rest.join(',') : null };
  if (before.status === 'OPEN') data.status = 'RECRUITER_ASSIGNED';
  const updated = await prisma.requirement.update({ where: { id: before.id }, data });
  await require('../handover').toDefaultOwner(updated, actor && actor.id ? { id: actor.id, name: actor.name } : null).catch(() => null);
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: actor && actor.name, action: auto ? 'Recruiters assigned automatically' : 'Requirement assignment changed', entity: 'Requirement', entityId: before.id,
    fromValue: [before.recruiterId, ...csv(before.recruiterIds)].filter(Boolean).join(' / ') || 'unassigned', toValue: all.join(' / '),
    reason: auto ? 'Admin switch "Suggest and auto-assign recruiters when a requirement opens"' : null,
  });
  await notifyUsers(ids, { title: `Requirement ${updated.reqCode || updated.title} assigned to you`, message: `${updated.title} — ${updated.department || 'no department'}.\nOpen: /requirements/${updated.id}` });
  return updated;
}

// Called when a requirement opens. Does nothing unless the Admin switch is on and nobody is on the job yet.
async function onOpened(requirement, actor = null) {
  const s = await core.load({ maxAgeMs: 0 });
  if (!s.autoAssign.enabled || !requirement) return { skipped: 'switch off' };
  const fresh = await prisma.requirement.findUnique({ where: { id: requirement.id } });
  if (!fresh || fresh.recruiterId || csv(fresh.recruiterIds).length) return { skipped: 'already has a recruiter' };
  const list = (await suggest(fresh, { limit: 20, includeAway: false })).slice(0, s.autoAssign.count);
  if (!list.length) return { skipped: 'no recruiter available' };
  const updated = await giveTo(fresh, list, actor, { auto: true });
  const match = await runMatch(fresh.id);
  // the job was waiting for a recruiter before it could be posted: post it now
  try { await require('../jobPosting').autoPost(fresh.id, { actorId: actor && actor.id, actorName: actor && actor.name, trigger: 'retry', background: true }); } catch { /* shown by the posting engine */ }
  return { assigned: list.map((p) => ({ userId: p.userId, name: p.name, reason: p.reason })), match, requirement: updated };
}

// ---- posting waits for a recruiter (Checklist-120 #36)
async function postingBlock(r) {
  if (!r) return null;
  const s = await core.load();
  if (!s.requireRecruiter.enabled) return null;
  const created = r.createdAt ? new Date(new Date(r.createdAt).getTime() + 330 * 60000).toISOString().slice(0, 10) : '0000-00-00';
  if (created < s.requireRecruiter.from) return null; // older requirements are never held back
  if (r.recruiterId || csv(r.recruiterIds).length) return null;
  return 'Pick a recruiter for this requirement first — it is posted once at least one recruiter is on it.';
}

module.exports = { suggest, runMatch, matchOf, giveTo, onOpened, postingBlock, awayToday };
