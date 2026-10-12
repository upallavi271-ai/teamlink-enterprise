// ---------------------------------------------------------------------------
// AFTER SOMEBODY LEAVES (user, 2026-10-10): the loose ends their exit leaves.
//
// The seat itself is freed automatically (utils/seatRelease.js). What is NOT
// done silently is giving their work to someone else - that is a person's
// decision. This lists, in plain words, what is still pointing at a person who
// has left, so the right owner can reassign it:
//
//   clients   whose Owner BDE / Second BDE is a leaver (the name is kept as history)
//   jobs      whose team lead or recruiter is a leaver
//   people    whose team lead / STL / reporting manager is a leaver
//   approvals steps still waiting on a leaver
//   followUps / tasks   still open and owned by a leaver
//
//   await lists({ user })  ->  { counts, clients, jobs, people, approvals, followUps, tasks }
//
// Read-only. Reassigning is done by the person's own screens (Clients -> Reassign
// owner; Jobs -> Assign TL / recruiter) and, for team members, by
// POST /employees/management/reassign-manager.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { hasLeft } = require('./positions');
const { can } = require('../middleware/auth');
const {
  employeeWhere, clientWhere, requirementWhere,
} = require('./scope');

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIVE_JOB = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
// Test rows are hidden from the real lists; the sandbox shows them so they can be tested.
const TEST_PATTERN = /zztest|example\.test/i;
const TEST_ROW = { test: (v) => !require("./sandbox").isSandbox() && TEST_PATTERN.test(v) };

async function leavers() {
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: { in: ['Relieved', 'Exited', 'Exit Process', 'Terminated'] } },
    select: { id: true, name: true, userId: true, employeeCode: true, employmentStatus: true },
  });
  return rows.filter((e) => hasLeft(e.employmentStatus) && !TEST_ROW.test(`${e.name}`));
}

async function lists({ user, limit = 200 } = {}) {
  const gone = await leavers();
  const names = new Map(gone.map((e) => [norm(e.name), e]));
  const userIds = new Set(gone.map((e) => e.userId).filter(Boolean));
  const empIds = new Set(gone.map((e) => e.id));
  const empty = { counts: { clients: 0, jobs: 0, people: 0, approvals: 0, followUps: 0, tasks: 0 }, clients: [], jobs: [], people: [], approvals: [], followUps: [], tasks: [], canOpenClient: false, canOpenJob: false };
  if (!gone.length) return empty;

  const mayClients = user ? await can(user, 'ats', 'clients', 'Client Detail', 'view').catch(() => false) : false;
  const mayJobs = user ? await can(user, 'ats', 'requirements', 'Requirement Detail', 'view').catch(() => false) : false;

  // --- clients without an active BDE ---------------------------------------
  let clients = [];
  if (mayClients) {
    const rows = await prisma.client.findMany({
      where: { AND: [clientWhere(user), { OR: [{ bdeOwner: { in: gone.map((e) => e.name) } }, { secondaryBde: { in: gone.map((e) => e.name) } }] }] },
      select: { id: true, name: true, ownerDepartment: true, status: true, bdeOwner: true, secondaryBde: true },
      orderBy: { name: 'asc' },
    }).catch(() => []);
    clients = rows.filter((c) => !TEST_ROW.test(c.name)).map((c) => {
      const ownerGone = names.has(norm(c.bdeOwner));
      const secondGone = names.has(norm(c.secondaryBde));
      // Is there still a working BDE on the client? (the other one of the two)
      const activeOther = ownerGone
        ? (c.secondaryBde && !secondGone ? c.secondaryBde : null)
        : (c.bdeOwner && !ownerGone ? c.bdeOwner : null);
      return {
        id: c.id, name: c.name, department: c.ownerDepartment || null, status: c.status || null,
        formerBde: ownerGone ? c.bdeOwner : c.secondaryBde,
        role: ownerGone ? 'Client manager (BDE)' : 'Second BDE',
        otherBde: activeOther,
        stillCovered: !!activeOther,
        needs: activeOther ? (ownerGone ? 'Client manager left' : 'Second BDE left') : 'No active BDE',
      };
    });
  }

  // --- jobs whose team lead / recruiter left --------------------------------
  let jobs = [];
  if (mayJobs && userIds.size) {
    const ids = [...userIds];
    const rows = await prisma.requirement.findMany({
      where: {
        AND: [requirementWhere(user), { status: { in: LIVE_JOB } },
          { OR: [{ tlId: { in: ids } }, { recruiterId: { in: ids } }, ...ids.map((id) => ({ recruiterIds: { contains: id } }))] }],
      },
      select: { id: true, reqCode: true, title: true, department: true, status: true, tlId: true, tl: true, recruiterId: true, recruiterIds: true, client: { select: { name: true } } },
      take: limit,
    }).catch(() => []);
    const byUser = new Map(gone.filter((e) => e.userId).map((e) => [e.userId, e]));
    rows.forEach((r) => {
      if (TEST_ROW.test(`${r.title} ${r.reqCode}`)) return;
      if (r.tlId && userIds.has(r.tlId)) {
        jobs.push({ id: r.id, reqCode: r.reqCode, title: r.title, client: r.client && r.client.name, department: r.department, status: r.status, missing: 'team lead', person: (byUser.get(r.tlId) || {}).name || r.tl });
      }
      const recs = [r.recruiterId, ...csv(r.recruiterIds)].filter((id) => id && userIds.has(id));
      if (recs.length) {
        jobs.push({ id: r.id, reqCode: r.reqCode, title: r.title, client: r.client && r.client.name, department: r.department, status: r.status, missing: 'recruiter', person: (byUser.get(recs[0]) || {}).name });
      }
    });
  }

  // --- people whose manager left -------------------------------------------
  let people = [];
  {
    const where = { AND: [user ? employeeWhere(user) : {}, { employmentStatus: { notIn: ['Relieved', 'Exited', 'Exit Process', 'Terminated'] } },
      { OR: [{ tl: { in: gone.map((e) => e.name) } }, { stl: { in: gone.map((e) => e.name) } }, { reportingManagerId: { in: [...empIds] } }] }] };
    const rows = await prisma.employee.findMany({
      where, select: { id: true, name: true, employeeCode: true, department: true, designation: true, team: true, tl: true, stl: true, reportingManagerId: true, reportingManager: { select: { name: true } } },
      orderBy: { name: 'asc' }, take: limit,
    }).catch(() => []);
    rows.forEach((e) => {
      if (TEST_ROW.test(e.name)) return;
      const bits = [];
      if (names.has(norm(e.tl))) bits.push({ field: 'tl', label: 'Team lead', who: e.tl });
      if (names.has(norm(e.stl))) bits.push({ field: 'stl', label: 'Senior team lead', who: e.stl });
      if (e.reportingManagerId && empIds.has(e.reportingManagerId)) bits.push({ field: 'reportingManagerId', label: 'Reporting manager', who: e.reportingManager && e.reportingManager.name });
      if (!bits.length) return;
      people.push({ id: e.id, code: e.employeeCode, name: e.name, department: e.department, designation: e.designation, team: e.team, gone: bits });
    });
  }

  // --- approvals, follow-ups, tasks ---------------------------------------
  const ids = [...userIds];
  const approvalsRaw = ids.length ? await prisma.approvalStep.findMany({ where: { approverUserId: { in: ids }, status: { in: ['Pending', 'Waiting'] } }, select: { id: true, workflow: true, recordId: true, level: true, approverName: true, status: true }, take: limit }).catch(() => []) : [];
  const followRaw = ids.length ? await prisma.applicationFollowUp.findMany({ where: { ownerUserId: { in: ids }, completedAt: null }, select: { id: true, ownerName: true, nextAction: true, dueDate: true, applicationId: true }, take: limit }).catch(() => []) : [];
  const tasksRaw = ids.length ? await prisma.task.findMany({ where: { assigneeId: { in: ids }, status: { notIn: ['Completed', 'Done', 'Cancelled', 'Closed'] } }, select: { id: true, name: true, assigneeName: true, endDate: true, status: true }, take: limit }).catch(() => []) : [];
  // Approvals and others are company-wide facts: only roles that see every employee get the lists.
  const wide = user ? (await can(user, null, 'hrms', 'Employee Management', 'configure').catch(() => false)) : false;
  const approvals = wide ? approvalsRaw : [];
  const followUps = wide ? followRaw : [];
  const tasks = wide ? tasksRaw : [];

  return {
    counts: { clients: clients.length, jobs: jobs.length, people: people.length, approvals: approvals.length, followUps: followUps.length, tasks: tasks.length },
    clients, jobs, people, approvals, followUps, tasks,
    canOpenClient: mayClients, canOpenJob: mayJobs,
  };
}

module.exports = { lists, leavers };
