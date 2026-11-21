// ---------------------------------------------------------------------------
// PEOPLE AND CASES: reassigning a leaver's work (P7.8), ownership disputes and validity (744 / 745), approval delegation (761), the workflow trail
// (620), the "who will move" preview of bulk actions (763) and the joining proof before billing (753 / Audit 264).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const core = require('./core');
const { logAudit } = require('../audit');
const { notifyUsers } = require('../notify');
const S = require('../scope');
const HO = require('../handover');

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const LEAD_VIEWS = ['admin', 'mgmt', 'stl', 'tl'];
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const LIVE_JOB = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE', 'ON_HOLD'];
const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const LEFT = ['Relieved', 'Exited', 'Exit Process', 'Terminated'];
const isLead = (user) => LEAD_VIEWS.includes(S.atsViewRole(user));

// ============================================================ REASSIGN THEIR WORK (P7.8)
async function canReach(viewer, userId) {
  const s = S.scopeOf(viewer);
  if (s.global) return true;
  if ((s.teamUserIds || []).includes(userId)) return true;
  if (s.positions && (s.positions.holderUserIds || []).includes(userId)) return true;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { atsDepartment: true, atsScopeDepartments: true } });
  const depts = [u && u.atsDepartment, ...csv(u && u.atsScopeDepartments)].filter(Boolean);
  return depts.some((d) => (s.departments || []).includes(d));
}
async function workOf(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, status: true, atsRole: true, employee: { select: { employmentStatus: true } } } });
  if (!u) return null;
  const [reqs, apps, fus, tasks, clients] = await Promise.all([
    prisma.requirement.findMany({ where: { status: { in: LIVE_JOB }, OR: [{ recruiterId: userId }, { recruiterIds: { contains: userId } }] }, select: { id: true, title: true, reqCode: true, recruiterId: true, recruiterIds: true }, take: 500 }),
    prisma.application.findMany({ where: { ownerRecruiterId: userId, stage: { notIn: CLOSED } }, select: { id: true, candidateId: true, stage: true, ownerRecruiterId: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } }, take: 1000 }),
    prisma.applicationFollowUp.findMany({ where: { ownerUserId: userId, completedAt: null }, select: { id: true, nextAction: true, dueDate: true }, take: 1000 }),
    prisma.task.findMany({ where: { assigneeId: userId, status: { notIn: ['Completed', 'Done', 'Cancelled', 'Closed'] } }, select: { id: true, name: true, endDate: true }, take: 500 }),
    prisma.client.findMany({ where: { OR: [{ bdeOwner: u.name }, { secondaryBde: u.name }] }, select: { id: true, name: true, bdeOwner: true, secondaryBde: true }, take: 500 }),
  ]);
  return { user: u, requirements: reqs, applications: apps, followUps: fus, tasks, clients };
}
async function reassignPeople(viewer) {
  if (!isLead(viewer)) return { status: 403, error: 'Reassigning work is for team leads, managers and admins.' };
  const users = await prisma.user.findMany({
    where: { atsAccess: true, OR: [{ status: 'Inactive' }, { employee: { employmentStatus: { in: LEFT } } }] },
    select: { id: true, name: true, status: true, atsRole: true, employee: { select: { employmentStatus: true } } }, take: 300,
  });
  const out = [];
  for (const u of users) {
    if (/zztest|example\.test/i.test(u.name) && !(process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await canReach(viewer, u.id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const w = await workOf(u.id);
    const counts = { requirements: w.requirements.length, applications: w.applications.length, followUps: w.followUps.length, tasks: w.tasks.length, clients: w.clients.length };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) out.push({ userId: u.id, name: u.name, status: u.status === 'Inactive' ? 'Deactivated' : (u.employee && u.employee.employmentStatus), counts, total });
  }
  return { status: 200, people: out.sort((a, b) => b.total - a.total) };
}
async function reassignPreview(viewer, fromUserId) {
  if (!isLead(viewer)) return { status: 403, error: 'Reassigning work is for team leads, managers and admins.' };
  if (!(await canReach(viewer, fromUserId))) return { status: 403, error: 'That person is outside your area.' };
  const w = await workOf(fromUserId);
  if (!w) return { status: 404, error: 'Person not found.' };
  const may = !!(S.scopeOf(viewer).global);
  return {
    status: 200, person: { id: w.user.id, name: w.user.name },
    sections: [
      { key: 'requirements', label: 'Requirement assignments', count: w.requirements.length, items: w.requirements.slice(0, 20).map((r) => r.reqCode || r.title) },
      { key: 'applications', label: 'Open candidates', count: w.applications.length, items: w.applications.slice(0, 20).map((a) => `${a.candidate && a.candidate.name} — ${a.requirement && a.requirement.title}`) },
      { key: 'followUps', label: 'Follow-ups', count: w.followUps.length, items: w.followUps.slice(0, 20).map((f) => f.nextAction || 'Follow-up') },
      { key: 'tasks', label: 'General tasks', count: w.tasks.length, items: w.tasks.slice(0, 20).map((t) => t.name) },
      { key: 'clients', label: 'Client ownership', count: w.clients.length, items: w.clients.slice(0, 20).map((c) => c.name), adminOnly: !may },
    ],
  };
}
async function reassignDo(viewer, fromUserId, toUserId, what) {
  if (!isLead(viewer)) return { status: 403, error: 'Reassigning work is for team leads, managers and admins.' };
  if (!(await canReach(viewer, fromUserId))) return { status: 403, error: 'That person is outside your area.' };
  if (fromUserId === toUserId) return { status: 400, error: 'Choose a different person to take the work.' };
  const to = await prisma.user.findUnique({ where: { id: String(toUserId || '') }, select: { id: true, name: true, status: true, atsAccess: true, employee: { select: { employmentStatus: true } } } });
  if (!to || to.status !== 'Active' || !to.atsAccess || (to.employee && LEFT.includes(to.employee.employmentStatus))) return { status: 400, error: 'Choose an active person with ATS access.' };
  if (!(await canReach(viewer, to.id)) && !S.scopeOf(viewer).global) return { status: 403, error: `${to.name} is outside your area.` };
  const w = await workOf(fromUserId);
  if (!w) return { status: 404, error: 'Person not found.' };
  const want = new Set(Array.isArray(what) ? what : []);
  const by = { id: viewer.id, name: viewer.name };
  const done = {};
  if (want.has('requirements')) {
    let n = 0;
    for (const r of w.requirements) {
      const rest = csv(r.recruiterIds).map((i) => (i === fromUserId ? to.id : i));
      const main = r.recruiterId === fromUserId ? to.id : r.recruiterId;
      const ids = [...new Set([main, ...rest].filter(Boolean))];
      const mainId = ids[0]; const others = ids.slice(1);
      // eslint-disable-next-line no-await-in-loop
      await prisma.requirement.update({ where: { id: r.id }, data: { recruiterId: mainId || null, recruiterIds: others.length ? others.join(',') : null } }); n += 1;
    }
    done.requirements = n;
  }
  if (want.has('applications')) done.applications = (await HO.moveOwner({ apps: w.applications, to: { id: to.id, name: to.name }, by, kind: 'work reassigned', reason: `${w.user.name} is no longer on the team` })).length;
  if (want.has('followUps')) done.followUps = (await prisma.applicationFollowUp.updateMany({ where: { ownerUserId: fromUserId, completedAt: null }, data: { ownerUserId: to.id, ownerName: to.name } })).count;
  if (want.has('tasks')) done.tasks = (await prisma.task.updateMany({ where: { id: { in: w.tasks.map((t) => t.id) } }, data: { assigneeId: to.id, assigneeName: to.name } })).count;
  if (want.has('clients')) {
    if (!S.scopeOf(viewer).global) return { status: 403, error: 'Client ownership is moved by an Admin.' };
    let n = 0;
    for (const c of w.clients) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.client.update({ where: { id: c.id }, data: { ...(c.bdeOwner === w.user.name ? { bdeOwner: to.name } : {}), ...(c.secondaryBde === w.user.name ? { secondaryBde: to.name } : {}) } }); n += 1;
    }
    done.clients = n;
  }
  for (const [k, count] of Object.entries(done)) {
    // eslint-disable-next-line no-await-in-loop
    await core.x('INSERT INTO "AtsReassignLog" ("fromUserId","fromName","toUserId","toName","what","count","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?)', fromUserId, w.user.name, to.id, to.name, k, count, viewer.id, viewer.name, core.nowIso());
  }
  await logAudit({ userId: viewer.id, actorName: viewer.name, action: 'Work reassigned', entity: 'User', entityId: fromUserId, fromValue: w.user.name, toValue: to.name, reason: Object.entries(done).map(([k, n]) => `${k}: ${n}`).join(', ') });
  await notifyUsers([to.id], { title: `Work handed to you from ${w.user.name}`, message: Object.entries(done).map(([k, n]) => `${n} ${k}`).join(', '), exceptUserId: viewer.id });
  return { status: 200, ok: true, done, to: to.name };
}

// ============================================================ OWNERSHIP (744 / 745)
async function holdersOf(candidateId) {
  const apps = await prisma.application.findMany({ where: { candidateId, stage: { notIn: CLOSED }, ownerRecruiterId: { not: null } }, select: { id: true, candidateId: true, stage: true, ownerRecruiterId: true, updatedAt: true } });
  return apps;
}
async function lastActivity(candidateId, holderId, apps) {
  const [ev, fu] = await Promise.all([
    prisma.applicationStageEvent.findFirst({ where: { candidateId, actorUserId: holderId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.applicationFollowUp.findFirst({ where: { candidateId, OR: [{ completedById: holderId }, { ownerUserId: holderId }], completedAt: { not: null } }, orderBy: { completedAt: 'desc' }, select: { completedAt: true } }),
  ]);
  const times = [ev && ev.createdAt, fu && fu.completedAt, ...apps.map((a) => a.updatedAt)].filter(Boolean).map((d) => new Date(d).getTime());
  return times.length ? Math.max(...times) : 0;
}
async function ownershipOf(candidateId) {
  const s = await core.load();
  const apps = await holdersOf(candidateId);
  const holders = [...new Set(apps.map((a) => a.ownerRecruiterId))];
  const names = holders.length ? await prisma.user.findMany({ where: { id: { in: holders } }, select: { id: true, name: true } }) : [];
  const out = [];
  for (const h of holders) {
    // eslint-disable-next-line no-await-in-loop
    const last = await lastActivity(candidateId, h, apps.filter((a) => a.ownerRecruiterId === h));
    const until = last ? new Date(last + s.ownership.validityDays * 86400000) : null;
    out.push({ userId: h, name: (names.find((n) => n.id === h) || {}).name, lastActivity: last ? new Date(last).toISOString() : null, validUntil: until ? until.toISOString().slice(0, 10) : null, expired: !!until && until.getTime() < Date.now() });
  }
  return { validityDays: s.ownership.validityDays, holders: out };
}
async function claimExpired(user, candidateId) {
  const own = await ownershipOf(candidateId);
  if (!own.holders.length) return { status: 409, error: 'Nobody holds this candidate. Add them to a requirement instead.' };
  if (own.holders.some((h) => h.userId === user.id)) return { status: 409, error: 'You already hold this candidate.' };
  const live = own.holders.filter((h) => !h.expired);
  if (live.length) return { status: 409, error: `${live[0].name} holds this candidate until ${live[0].validUntil}. Open a dispute if you believe the claim is yours.`, code: 'STILL_VALID', holders: own.holders };
  const apps = await holdersOf(candidateId);
  const moved = await HO.moveOwner({ apps, to: { id: user.id, name: user.name }, by: { id: user.id, name: user.name }, kind: 'ownership expired', reason: `Ownership not used for ${own.validityDays} days` });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Candidate ownership claimed after it expired', entity: 'Candidate', entityId: candidateId, fromValue: own.holders.map((h) => h.name).join(', '), toValue: user.name, reason: `No activity for ${own.validityDays} days` });
  return { status: 200, ok: true, moved: moved.length };
}
async function openDispute(user, candidateId, evidence) {
  const ev = String(evidence || '').trim();
  if (ev.length < 10) return { status: 400, error: 'Write the evidence: what shows the candidate is yours (date, message, source).' };
  const cand = await prisma.candidate.findUnique({ where: { id: String(candidateId || '') }, select: { id: true, name: true } });
  if (!cand) return { status: 404, error: 'Candidate not found.' };
  const [dup] = await core.q('SELECT "id" FROM "AtsOwnershipDispute" WHERE "candidateId" = ? AND "claimantId" = ? AND "status" = \'Open\'', cand.id, user.id);
  if (dup) return { status: 409, error: 'You already have an open dispute for this candidate.' };
  const apps = await holdersOf(cand.id);
  const holderId = apps[0] ? apps[0].ownerRecruiterId : null;
  if (holderId === user.id) return { status: 409, error: 'You already hold this candidate.' };
  const holder = holderId ? await prisma.user.findUnique({ where: { id: holderId }, select: { name: true } }) : null;
  await core.x('INSERT INTO "AtsOwnershipDispute" ("candidateId","candidateName","claimantId","claimantName","holderId","holderName","evidence","status","createdAt") VALUES (?,?,?,?,?,?,?,\'Open\',?)',
    cand.id, cand.name, user.id, user.name, holderId, holder && holder.name, ev.slice(0, 1000), core.nowIso());
  await logAudit({ userId: user.id, actorName: user.name, action: 'Ownership dispute opened', entity: 'Candidate', entityId: cand.id, toValue: `${user.name} claims ${cand.name}`, reason: ev.slice(0, 300) });
  if (holderId) await notifyUsers([holderId], { title: `Ownership dispute on ${cand.name}`, message: `${user.name} says this candidate is theirs. Your team lead decides.` });
  return { status: 200, ok: true };
}
async function disputes(viewer, { candidateId = null, status = null } = {}) {
  const rows = await core.q(`SELECT * FROM "AtsOwnershipDispute" WHERE 1=1 ${candidateId ? 'AND "candidateId" = ?' : ''} ${status ? 'AND "status" = ?' : ''} ORDER BY "id" DESC LIMIT 200`, ...[candidateId, status].filter(Boolean));
  const lead = isLead(viewer);
  const out = [];
  for (const r of rows) {
    const mine = r.claimantId === viewer.id || r.holderId === viewer.id;
    if (!lead && !mine) continue; // eslint-disable-line no-continue
    // a lead sees the cases of candidates in their area only
    // eslint-disable-next-line no-await-in-loop
    if (lead && !mine && !S.scopeOf(viewer).global && !(await prisma.application.count({ where: { AND: [{ candidateId: r.candidateId }, S.applicationWhere(viewer)] } }))) continue; // eslint-disable-line no-continue
    out.push({ ...r, id: Number(r.id) });
  }
  return { status: 200, rows: out, canDecide: lead };
}
async function decideDispute(viewer, id, winnerId, reason) {
  if (!isLead(viewer)) return { status: 403, error: 'A team lead, manager or admin decides an ownership dispute.' };
  const why = String(reason || '').trim();
  if (why.length < 5) return { status: 400, error: 'Write the reason for the decision.' };
  const [d] = await core.q('SELECT * FROM "AtsOwnershipDispute" WHERE "id" = ?', Number(id));
  if (!d) return { status: 404, error: 'Dispute not found.' };
  if (d.status !== 'Open') return { status: 409, error: 'Already decided.' };
  if (!S.scopeOf(viewer).global && !(await prisma.application.count({ where: { AND: [{ candidateId: d.candidateId }, S.applicationWhere(viewer)] } }))) return { status: 403, error: 'This candidate is outside your area.' };
  if (![d.claimantId, d.holderId].includes(winnerId)) return { status: 400, error: 'Choose the claimant or the current holder.' };
  if (viewer.id === d.claimantId) return { status: 403, error: 'You cannot decide your own claim.' };
  const winner = await prisma.user.findUnique({ where: { id: winnerId }, select: { id: true, name: true } });
  let moved = 0;
  if (winnerId !== d.holderId) {
    const apps = await holdersOf(d.candidateId);
    moved = (await HO.moveOwner({ apps, to: { id: winner.id, name: winner.name }, by: { id: viewer.id, name: viewer.name }, kind: 'ownership dispute decided', reason: why })).length;
  }
  await core.x('UPDATE "AtsOwnershipDispute" SET "status" = \'Decided\', "winnerId" = ?, "winnerName" = ?, "decision" = ?, "decidedById" = ?, "decidedByName" = ?, "decidedAt" = ? WHERE "id" = ?', winner.id, winner.name, why.slice(0, 500), viewer.id, viewer.name, core.nowIso(), Number(id));
  await logAudit({ userId: viewer.id, actorName: viewer.name, action: 'Ownership dispute decided', entity: 'Candidate', entityId: d.candidateId, fromValue: d.holderName, toValue: winner.name, reason: why });
  await notifyUsers([d.claimantId, d.holderId].filter(Boolean), { title: `Ownership of ${d.candidateName} decided`, message: `${winner.name} keeps the candidate. Reason: ${why}`, exceptUserId: viewer.id });
  return { status: 200, ok: true, winner: winner.name, moved };
}

// ============================================================ APPROVAL DELEGATION (761)
const DELEGATORS = ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'SUPER_ADMIN', 'ADMIN'];
async function delegate(user, { toUserId, fromDate, toDate }) {
  const roles = [user.atsRole, user.role, user.hrmsRole].filter(Boolean);
  if (!roles.some((r) => DELEGATORS.includes(r))) return { status: 403, error: 'Approvals are delegated by a team lead, BDE team lead or manager.' };
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if (!DAY.test(String(fromDate)) || !DAY.test(String(toDate)) || toDate < fromDate) return { status: 400, error: 'Pick the first and the last day you are away.' };
  if (toDate < todayIst()) return { status: 400, error: 'The last day cannot be in the past.' };
  if (toDate > new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10)) return { status: 400, error: 'Delegate for at most 120 days at a time.' };
  if (toUserId === user.id) return { status: 400, error: 'Choose somebody else.' };
  const to = await prisma.user.findUnique({ where: { id: String(toUserId || '') }, select: { id: true, name: true, status: true, atsAccess: true, atsRole: true, role: true } });
  if (!to || to.status !== 'Active' || !to.atsAccess) return { status: 400, error: 'Choose an active person with ATS access.' };
  const [clash] = await core.q('SELECT "id" FROM "AtsApprovalDelegation" WHERE "fromUserId" = ? AND "revokedAt" IS NULL AND "fromDate" <= ? AND "toDate" >= ?', user.id, toDate, fromDate);
  if (clash) return { status: 409, error: 'You already delegated for these days. Cancel that one first.' };
  await core.x('INSERT INTO "AtsApprovalDelegation" ("fromUserId","toUserId","toName","fromDate","toDate","createdAt") VALUES (?,?,?,?,?,?)', user.id, to.id, to.name, fromDate, toDate, core.nowIso());
  await logAudit({ userId: user.id, actorName: user.name, action: 'Approvals delegated', entity: 'User', entityId: user.id, toValue: `${to.name}: ${fromDate} to ${toDate}` });
  await notifyUsers([to.id], { title: `${user.name} handed their approvals to you`, message: `From ${fromDate} to ${toDate} you can approve what would wait for ${user.name}.` });
  return { status: 200, ok: true };
}
async function myDelegations(user) {
  const out = await core.q('SELECT * FROM "AtsApprovalDelegation" WHERE ("fromUserId" = ? OR "toUserId" = ?) AND "revokedAt" IS NULL AND "toDate" >= ? ORDER BY "fromDate"', user.id, user.id, todayIst());
  return out.map((r) => ({ ...r, id: Number(r.id), mine: r.fromUserId === user.id }));
}
async function revokeDelegation(user, id) {
  const n = await core.x('UPDATE "AtsApprovalDelegation" SET "revokedAt" = ? WHERE "id" = ? AND "fromUserId" = ? AND "revokedAt" IS NULL', core.nowIso(), Number(id), user.id);
  return Number(n) ? { status: 200, ok: true } : { status: 404, error: 'Not found.' };
}
// who has handed their approvals to `userId` today (the user ids)
async function delegatorsOf(userId, day = todayIst()) {
  const rows = await core.q('SELECT "fromUserId" FROM "AtsApprovalDelegation" WHERE "toUserId" = ? AND "revokedAt" IS NULL AND "fromDate" <= ? AND "toDate" >= ?', userId, day, day);
  return rows.map((r) => r.fromUserId);
}
// approvalWorkflow.act: may `actingId` act for the step's `approverId`?
async function delegatorFor(approverId, actingId) {
  const from = await delegatorsOf(actingId);
  if (!from.includes(approverId)) return null;
  const u = await prisma.user.findUnique({ where: { id: approverId }, select: { id: true, name: true } });
  return u || null;
}
// is this login standing in for a BDE team lead today?
async function standsInForBdeTl(user) {
  const from = await delegatorsOf(user.id);
  if (!from.length) return false;
  const tls = await prisma.user.findMany({ where: { id: { in: from }, atsRole: 'TL' }, select: { atsDepartment: true, atsScopeDepartments: true } });
  return tls.some((t) => /^bde$/i.test(String(t.atsDepartment || '')) || csv(t.atsScopeDepartments).some((d) => /^bde$/i.test(d)));
}

// ============================================================ WORKFLOW TRAIL (620)
const whoOf = (r) => r.actorName || (r.user && r.user.name) || null;
async function trailOf({ requirementId = null, applicationId = null }) {
  let reqId = requirementId; let app = null;
  if (applicationId) {
    app = await prisma.application.findUnique({ where: { id: applicationId }, select: { id: true, candidateId: true, requirementId: true, interviewAt: true, interviewStatus: true, offerStatus: true, offeredCtc: true, joiningDate: true, joinedAt: true, candidate: { select: { name: true } } } });
    if (!app) return { status: 404, error: 'Application not found' };
    reqId = app.requirementId;
  }
  const req = await prisma.requirement.findUnique({ where: { id: reqId }, select: { id: true, title: true, reqCode: true, createdAt: true, client: { select: { name: true } } } });
  if (!req) return { status: 404, error: 'Requirement not found' };
  const V = require('../atsVocab');
  const ev = [];
  const push = (at, kind, what, who, ref) => { if (at) ev.push({ at: new Date(at).toISOString(), kind, what, who: who || null, ref: ref || null }); };
  push(req.createdAt, 'Requirement', `Requirement raised: ${req.reqCode || req.title}${req.client ? ` for ${req.client.name}` : ''}`, null);
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ entity: 'Requirement', entityId: reqId }, ...(applicationId ? [{ entity: 'Application', entityId: applicationId }] : [])] }, select: { action: true, fromValue: true, toValue: true, reason: true, actorName: true, createdAt: true, entity: true, user: { select: { name: true } } }, orderBy: { createdAt: 'asc' }, take: 400 });
  audits.forEach((a) => push(a.createdAt, a.entity === 'Application' ? 'Candidate' : 'Requirement', `${a.action}${a.fromValue || a.toValue ? `: ${[a.fromValue, a.toValue].filter(Boolean).join(' → ')}` : ''}${a.reason ? ` (${String(a.reason).slice(0, 120)})` : ''}`, whoOf(a)));
  const openReqs = await prisma.requirementOpenRequest.findMany({ where: { requirementId: reqId } }).catch(() => []);
  openReqs.forEach((o) => { push(o.createdAt, 'Approval', 'Asked to open on an unsigned agreement', o.askedByName); if (o.decidedAt) push(o.decidedAt, 'Approval', `Opening ${String(o.status).toLowerCase()}`, o.decidedByName); });
  const stageWhere = applicationId ? { applicationId } : { requirementId: reqId };
  const events = await prisma.applicationStageEvent.findMany({ where: stageWhere, orderBy: { createdAt: 'asc' }, take: 600, select: { createdAt: true, action: true, comment: true, actorName: true, toStage: true, applicationId: true, candidateId: true } });
  const names = !applicationId && events.length ? new Map((await prisma.candidate.findMany({ where: { id: { in: [...new Set(events.map((e) => e.candidateId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : new Map();
  events.forEach((e) => push(e.createdAt, ['OFFER', 'OFFER_ACCEPTED'].includes(e.toStage) ? 'Offer' : (['JOINED', 'HIRED'].includes(e.toStage) ? 'Joining' : (/INTERVIEW/.test(e.toStage || '') ? 'Interview' : 'Candidate')),
    `${names.get(e.candidateId) ? `${names.get(e.candidateId)}: ` : ''}${e.action || V.stageLabel(e.toStage)}${e.comment ? ` — ${String(e.comment).slice(0, 120)}` : ''}`, e.actorName, e.applicationId));
  const interviews = await prisma.application.findMany({ where: applicationId ? { id: applicationId, interviewAt: { not: null } } : { requirementId: reqId, interviewAt: { not: null } }, select: { id: true, interviewAt: true, interviewStatus: true, candidate: { select: { name: true } } }, take: 200 });
  interviews.forEach((i) => push(i.interviewAt, 'Interview', `Interview ${String(i.interviewStatus || 'scheduled').toLowerCase()} for ${i.candidate && i.candidate.name}`, null, i.id));
  const invoices = await prisma.invoice.findMany({ where: applicationId && app ? { requirementId: reqId, candidateId: app.candidateId } : { requirementId: reqId }, select: { id: true, invoiceNumber: true, amount: true, createdAt: true, status: true } });
  invoices.forEach((i) => push(i.createdAt, 'Invoice', `Invoice ${i.invoiceNumber || ''} raised (${Math.round(i.amount || 0)}) — ${i.status}`, null, i.id));
  const pays = await core.q(`SELECT * FROM "AtsPayoutProposal" ${applicationId ? 'WHERE "applicationId" = ?' : ''}`, ...(applicationId ? [applicationId] : [])).catch(() => []);
  pays.forEach((p) => { if (!applicationId) return; push(p.createdAt, 'Payout', `${p.kind} proposal for ${p.personName || 'someone'} — ${p.status}`, p.decidedByName); });
  ev.sort((a, b) => a.at.localeCompare(b.at));
  return { status: 200, title: applicationId && app ? `${app.candidate && app.candidate.name} — ${req.reqCode || req.title}` : (req.reqCode || req.title), count: ev.length, events: ev };
}

// ============================================================ BULK PREVIEW (763)
async function bulkPreview(user, body) {
  const kind = String(body.kind || '');
  const out = { willMove: [], skipped: [] };
  if (kind === 'application-stage' || kind === 'application-assign') {
    const appIds = [...new Set((Array.isArray(body.applicationIds) ? body.applicationIds : []).map(String))];
    const candIds = [...new Set((Array.isArray(body.candidateIds) ? body.candidateIds : []).map(String))];
    if (!appIds.length && !candIds.length) return { status: 400, error: 'Select at least one candidate.' };
    if (appIds.length + candIds.length > 500) return { status: 400, error: 'At most 500 at a time.' };
    const V = require('../atsVocab');
    const target = kind === 'application-stage' ? String(body.stage || '') : null;
    if (kind === 'application-stage' && !target) return { status: 400, error: 'Choose the stage.' };
    let refusal = null;
    if (kind === 'application-stage') { const { canMoveToStage } = require('../permissions'); refusal = await canMoveToStage(user, target); }
    const rows = [];
    appIds.forEach((id) => rows.push({ applicationId: id }));
    if (candIds.length) {
      const cands = await prisma.candidate.findMany({ where: { id: { in: candIds } }, select: { id: true, name: true, applications: { include: { requirement: true } } } });
      candIds.forEach((cid) => {
        const c = cands.find((x) => x.id === cid);
        const vis = c ? c.applications.filter((a) => S.applicationInScope(user, a)) : [];
        const latest = vis.sort((x, y) => String(y.id).localeCompare(String(x.id)))[0];
        if (!c) out.skipped.push({ id: cid, name: cid, reason: 'Candidate not found' });
        else if (!latest) out.skipped.push({ id: cid, name: c.name, reason: c.applications.length ? 'Outside your access' : 'No application — nothing to act on' });
        else rows.push({ applicationId: latest.id });
      });
    }
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const a = await prisma.application.findUnique({ where: { id: row.applicationId }, include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: true, recruiter: true, bde: true } } } });
      if (!a) { out.skipped.push({ id: row.applicationId, name: row.applicationId, reason: 'Application not found' }); continue; }
      const name = a.candidate && a.candidate.name;
      if (!S.applicationInScope(user, a)) { out.skipped.push({ id: a.id, name, reason: 'Outside your access' }); continue; }
      if (kind === 'application-stage') {
        if (refusal) { out.skipped.push({ id: a.id, name, reason: (refusal.body && refusal.body.error) || 'You may not move people to this step' }); continue; }
        if (a.stage === target) { out.skipped.push({ id: a.id, name, reason: `Already at ${V.stageLabel(target)}` }); continue; }
        if (['JOINED', 'HIRED'].includes(a.stage) && target !== a.stage) { out.skipped.push({ id: a.id, name, reason: `Already placed (${V.stageLabel(a.stage)})` }); continue; }
        out.willMove.push({ id: a.id, name, from: V.stageLabel(a.stage), to: V.stageLabel(target) });
      } else if (a.ownerRecruiterId === body.recruiterId) out.skipped.push({ id: a.id, name, reason: 'Already with that recruiter' });
      else if (['JOINED', 'HIRED'].includes(a.stage) && body.correct !== true) out.skipped.push({ id: a.id, name, reason: 'Placed — stays with who placed them' });
      else out.willMove.push({ id: a.id, name, from: a.ownerRecruiterId || 'nobody', to: 'the chosen recruiter' });
    }
  } else if (kind === 'requirement-assign' || kind === 'requirement-priority') {
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))];
    if (!ids.length) return { status: 400, error: 'Select at least one requirement.' };
    const rows = await prisma.requirement.findMany({ where: { id: { in: ids } } });
    ids.forEach((id) => {
      const r = rows.find((x) => x.id === id);
      const name = r ? (r.reqCode || r.title) : id;
      if (!r) out.skipped.push({ id, name, reason: 'Requirement not found' });
      else if (!S.matches(r, S.requirementWhere(user))) out.skipped.push({ id, name, reason: 'Outside your access' });
      else if (kind === 'requirement-priority' && r.priority === body.priority) out.skipped.push({ id, name, reason: `Already ${r.priority}` });
      else if (kind === 'requirement-assign' && body.userId && (r.recruiterId === body.userId || r.tlId === body.userId)) out.skipped.push({ id, name, reason: 'Already assigned to them' });
      else out.willMove.push({ id, name, from: r.recruiterId || r.tlId || 'unassigned', to: 'the chosen person' });
    });
  } else return { status: 400, error: 'Unknown bulk action.' };
  // names, never record ids (founder 2026-11-21: "From" showed an id and "To" said "the chosen person")
  const pickIds = [...new Set([body.userId, ...(Array.isArray(body.userIds) ? body.userIds : []), body.recruiterId].filter(Boolean).map(String))];
  const fromIds = [...new Set(out.willMove.map((r) => r.from).filter((x) => /^c[a-z0-9]{15,}$/i.test(String(x))))];
  const ppl = (pickIds.length || fromIds.length) ? await prisma.user.findMany({ where: { id: { in: [...pickIds, ...fromIds] } }, select: { id: true, name: true } }).catch(() => []) : [];
  const nm = new Map(ppl.map((u) => [u.id, u.name]));
  const toWord = pickIds.map((id) => nm.get(id)).filter(Boolean).join(', ');
  out.willMove = out.willMove.map((r) => ({ ...r, from: nm.get(r.from) || (r.from === 'unassigned' ? 'nobody yet' : r.from), to: /^the chosen/.test(r.to) && toWord ? toWord : r.to }));
  return { status: 200, counts: { willMove: out.willMove.length, skipped: out.skipped.length }, ...out };
}

// ============================================================ JOINING PROOF (753)
// -> a sentence when the invoice must wait, else null
async function proofGate(application) {
  const s = await core.load();
  if (!s.joiningProof.required) return null;
  const [p] = await core.q('SELECT "applicationId" FROM "AtsJoiningProof" WHERE "applicationId" = ?', application.id);
  return p ? null : 'Upload the joining confirmation proof first.';
}
async function proofOf(applicationId) {
  const [p] = await core.q('SELECT "applicationId","fileName","mime","uploadedByName","uploadedAt" FROM "AtsJoiningProof" WHERE "applicationId" = ?', applicationId);
  const s = await core.load();
  return { required: s.joiningProof.required, proof: p || null };
}
async function saveProof(user, applicationId, file) {
  const A = require('../attachments');
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { candidate: true, requirement: { include: { client: true } } } });
  if (!app) return { status: 404, error: 'Application not found' };
  if (!S.applicationInScope(user, app)) return { status: 403, ...S.OUT_OF_SCOPE };
  if (!['JOINED', 'HIRED', 'OFFER_ACCEPTED'].includes(app.stage)) return { status: 409, error: 'Upload the proof once the candidate has joined.' };
  let stored;
  try { stored = A.store(file); } catch (e) {
    const words = { NO_FILE: 'Choose the file to upload.', TOO_LARGE: 'The file is too big.', BAD_TYPE: 'Upload a PDF or a picture (PNG, JPG).', CONTENT_MISMATCH: 'The file is not what its name says.' };
    return { status: 400, error: words[e.code] || 'The file could not be saved.' };
  }
  await core.x('INSERT OR REPLACE INTO "AtsJoiningProof" ("applicationId","fileName","mime","data","uploadedById","uploadedByName","uploadedAt") VALUES (?,?,?,?,?,?,?)', applicationId, stored.billName, stored.billMime, stored.billFile, user.id, user.name, core.nowIso());
  await logAudit({ userId: user.id, actorName: user.name, action: 'Joining proof uploaded', entity: 'Application', entityId: applicationId, toValue: stored.billName });
  let invoiceId = null;
  if (app.billingStatus === 'Waiting for joining proof' && !require('../joining').isInternalHire(app, app.requirement)) {
    const inv = await require('../joining').raiseJoiningInvoice({ application: app, existing: app, userId: user.id });
    if (inv) { invoiceId = inv.id; await prisma.application.update({ where: { id: applicationId }, data: { billingStatus: 'Invoiced' } }); }
  }
  return { status: 200, ok: true, invoiceId, name: stored.billName };
}

module.exports = {
  canReach, reassignPeople, reassignPreview, reassignDo, ownershipOf, claimExpired, openDispute, disputes, decideDispute,
  delegate, myDelegations, revokeDelegation, delegatorsOf, delegatorFor, standsInForBdeTl, trailOf, bulkPreview, proofGate, proofOf, saveProof, isLead,
};
