// ---------------------------------------------------------------------------
// RECRUITER & BDE — the operational control centre for Recruiter / TL / BDE
// work (the user's binding spec, 2026-09-29). Everything behind
// GET /api/ats/team (routes/atsExtras.js):
//
//   People & Workload  WHO is responsible — one row per person, by role:
//     Recruiter  Person · Dept · Section · TL · Open Requirements ·
//                Active Candidates · Needs Action
//     BDE        (CLIENT-centric) BDE · Clients · Open Requirements ·
//                Submitted · Client Feedback Pending · Interviews · Selected
//                (+ Active Clients, Client Actions)
//     TL         TL · Recruiters · Requirements · Candidates · Pending Reviews
//   Assignments        WHAT is assigned to whom — one row per requirement,
//                      Department → Section → TL → Recruiter → Requirement and
//                      Client → BDE, with an assignment status
//   Pending Actions    what must be done NOW — one row per active ATS
//                      application: Current Stage → Next Action → Owner → Due
//   360s               GET /api/ats/team/:userId (Recruiter / BDE / TL 360)
//   Lists              GET /api/ats/team/:userId?metric=… — the EXACT rows
//                      behind every number (a number and its list are the same
//                      set, computed once, here)
//
// WHAT THE NUMBERS MEAN
//   Active application   an ATS application (not still in the Job Portal
//                        screening — atsVocab isPreAtsApplication) whose stage
//                        is not Hold / Rejected / Joined / Hired
//   Recruiter's          attributed to them by utils/workers.js attribute() —
//                        the one "whose work is this" rule every ATS person
//                        filter uses. Active Candidates counts APPLICATIONS
//                        (the pipeline rows they own), never Candidate Master
//   Needs Action         the active applications whose ONE next action is
//                        owned by this person — the shared next-action helper
//                        (see nextActionOf below), not "sitting in a stage"
//   BDE's clients        Client.bdeOwner = the BDE's name, the clients assigned
//                        to them on Users (atsScopeClients), or a client with
//                        a requirement naming them as BDE (Requirement.bdeId)
//   TL's team            the recruiters whose seat reports to their TL seat
//                        (or whose employee record names them as TL)
//
// WHO SEES WHAT (server-side; the UI only hides):
//   Super Admin / Admin   everything
//   Manager / Asst Mgr    everything, read-only (nothing here writes)
//   STL                   their departments
//   TL                    their own team
//   Recruiter             their own workload
//   BDE                   their own clients / requirements / client-side work
//   HR                    internal hiring only (the internal requirements and
//                         the people assigned to them)
//   Accounts / Client /   refused (teamAccess)
//   Candidate / no role
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  applicationWhere, requirementWhere, scopeOf, atsViewRole,
} = require('./scope');
const {
  REQUIREMENT_LIVE_STATUSES, stageLabel, isPreAtsApplication, requirementStatusLabel,
} = require('./atsVocab');
const { ATTR_SELECT, attribute, loadDirectory } = require('./workers');

const TEAM_ROLES = ['RECRUITER', 'BDE', 'TL', 'STL'];
const TEAM_ROLE_ORDER = { RECRUITER: 0, BDE: 1, TL: 2, STL: 3 };
const TEAM_ROLE_LABELS = { RECRUITER: 'Recruiter', BDE: 'BDE', TL: 'TL', STL: 'STL' };
// Not active: the Candidates page's "Active" view leaves these out.
const NOT_ACTIVE = ['HOLD', 'REJECTED', 'JOINED', 'HIRED'];
const LEFT_STATUSES = ['Relieved', 'Exited', 'Exit Process'];
const INTERVIEW_STAGES = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'];
const SELECTED_STAGES = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const JOINED_STAGES = ['JOINED', 'HIRED'];
// Submitted to the client and still active (Client Submission onward).
const SUBMITTED_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', ...INTERVIEW_STAGES, ...SELECTED_STAGES];
// Waiting on the client's decision on a submitted profile.
const FEEDBACK_PENDING_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'];
const DEAD_INTERVIEW = ['CANCELLED', 'NO_SHOW'];
const LIVE = new Set(REQUIREMENT_LIVE_STATUSES);
const INTERNAL_CLIENT_LABEL = 'TeamLink Internal';
// Test / demo logins are never shown or resolved as real people (agent rules
// 2026-09-29): a ZZTEST user holding a real role must not be picked up as an
// owner by real screens.
const isTestPerson = (u) => !!u && /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);

const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const lc = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The team a seat sits in, in words: "Medical Team", "Education Team A". A
// department with no seat reads "<Department> Team" ("IT Team").
function seatTeamOf(p) {
  if (!p) return null;
  const team = String(p.team || '').trim();
  const dept = String(p.department || '').trim();
  if (!dept) return team || null;
  if (!team || /^team$/i.test(team)) return `${dept} Team`;
  return /^team\b/i.test(team) ? `${dept} ${team}` : `${dept} · ${team}`;
}
const sectionOf = (seat, department) => seatTeamOf(seat) || (department ? seatTeamOf({ department }) : null);

// Logins that only ever see their own row.
const SELF_ONLY = ['RECRUITER', 'BDE', 'EMPLOYEE', 'CLIENT', 'CANDIDATE', 'ACCOUNTANT', 'NONE'];

// Super Admin / Admin — the only viewers shown former seat holders.
function isAdminViewer(user) {
  const u = user || {};
  const sr = u.scopeRoles || {};
  return [u.role, u.atsRole, sr.ats].some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
}

// WHO MAY OPEN RECRUITER & BDE AT ALL. Accounts has no need for this screen
// (spec: hide); a client / candidate / roleless login is not internal ATS.
const REFUSED_VIEWS = ['accounts', 'client', 'candidate', 'none'];
function teamAccess(user) {
  const view = atsViewRole(user);
  if (REFUSED_VIEWS.includes(view)) {
    return { ok: false, view, error: 'Recruiter & BDE is not part of your role.' };
  }
  return { ok: true, view };
}

// The `where` on User for the people this caller may see.
function teamPeopleWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  const departments = uniq([...(s.departments || []), ...((s.positions && s.positions.departments) || [])]);
  if (SELF_ONLY.includes(s.atsRole)) return { id: s.userId || '__none__' };
  if (s.atsRole === 'HR') return { id: '__none__' }; // HR: see peopleFor()
  if (s.atsRole === 'TL' && s.teamUserIds) return { id: { in: [s.userId, ...s.teamUserIds] } };
  if (!departments.length && !s.teamUserIds) return { id: s.userId || '__none__' };
  // A TL with no team configured falls back to their department — its
  // recruiters and BDEs, never a peer TL's or their STL's row.
  if (s.atsRole === 'TL') {
    return { OR: [{ id: s.userId }, { atsDepartment: { in: departments }, atsRole: { in: ['RECRUITER', 'BDE'] } }] };
  }
  const or = [{ id: s.userId }];
  if (s.teamUserIds) or.push({ id: { in: s.teamUserIds } });
  if (departments.length) or.push({ atsDepartment: { in: departments } });
  return { OR: or };
}

// ---------------------------------------------------------------------------
// THE NEXT ACTION of one active application — ONE Current Stage, ONE Next
// Action, ONE Owner, ONE Due date, ONE due status. Delegated to the shared
// helper the Candidates module owns, so the Candidates list, Candidate 360
// and this screen can never disagree. `nextActionOf(app, ctx)` returns
//   { stage, stageLabel, action, actionType, ownerRole, ownerUserId,
//     ownerName, dueAt, dueStatus: 'overdue' | 'today' | 'upcoming' }
// ---------------------------------------------------------------------------
const nextAction = require('./nextAction');
// The helper's due statuses, as this screen names them.
const DUE_STATUS = { overdue: 'overdue', due_today: 'today', upcoming: 'upcoming', no_due: 'none' };

// ---------------------------------------------------------------------------
// THE WORLD — everything the three tabs and the 360s read, loaded once per
// caller and kept for a few seconds, so a number and the list it opens are
// computed from the same rows.
// ---------------------------------------------------------------------------
const WORLD = new Map();
const WORLD_TTL_MS = 20 * 1000;

const APP_SELECT = {
  ...ATTR_SELECT,
  requirement: {
    select: {
      ...ATTR_SELECT.requirement.select,
      id: true, title: true, reqCode: true, internal: true, clientId: true, status: true,
      recruiterIds: true, stlId: true, hiringType: true,
      client: { select: { id: true, name: true, bdeOwner: true } },
      recruiter: { select: { name: true } },
      bde: { select: { name: true } },
    },
  },
  createdAt: true,
  updatedAt: true,
  source: true,
  portalImportedAt: true,
  interviewAt: true,
  interviewStatus: true,
  hiringType: true,
  joinedAt: true,
  interviewResult: true,
  interviewCompletedAt: true,
  candidate: { select: { id: true, name: true } },
};

// Applications in `where`, read in chunks: a whole-scope nested read hits
// SQLite's parameter limit (P2029).
async function readApplications(where, select) {
  const slim = await prisma.application.findMany({ where, select: { id: true } });
  const ids = slim.map((a) => a.id);
  const out = [];
  const SIZE = 500;
  for (let i = 0; i < ids.length; i += SIZE * 4) {
    const batch = [];
    for (let j = i; j < Math.min(ids.length, i + SIZE * 4); j += SIZE) {
      batch.push(prisma.application.findMany({ where: { id: { in: ids.slice(j, j + SIZE) } }, select }));
    }
    // eslint-disable-next-line no-await-in-loop
    (await Promise.all(batch)).forEach((rows) => out.push(...rows));
  }
  return out;
}

// The people on this caller's screen.
async function peopleFor(user) {
  const s = scopeOf(user);
  let where = teamPeopleWhere(user);
  if (s.atsRole === 'HR' && !s.global) {
    // HR — internal hiring: the people assigned to the internal requirements.
    const reqs = await prisma.requirement.findMany({
      where: { internal: true },
      select: { recruiterId: true, recruiterIds: true, tlId: true, stlId: true },
    });
    where = { id: { in: uniq(reqs.flatMap((r) => [r.recruiterId, ...csv(r.recruiterIds), r.tlId, r.stlId])) } };
  }
  const users = await prisma.user.findMany({
    where: { AND: [{ atsRole: { in: TEAM_ROLES } }, where] },
    select: {
      id: true, name: true, email: true, status: true, atsRole: true, atsDepartment: true, atsScopeClients: true,
      employee: { select: { id: true, employeeCode: true, designation: true, department: true, tl: true, stl: true, employmentStatus: true, email: true } },
    },
  });
  return users.filter((u) => !isTestPerson(u) || isTestViewer(user));
}
// A ZZTEST caller (the automated tests) does see its own fixtures.
const isTestViewer = (user) => isTestPerson(user);

// Concurrent requests from one screen (the three tabs load together) share
// one read.
async function loadWorld(user, { fresh = false } = {}) {
  const key = user.id;
  const hit = WORLD.get(key);
  if (!fresh && hit && Date.now() - hit.at < WORLD_TTL_MS) return hit.promise;
  const promise = buildWorld(user);
  WORLD.set(key, { at: Date.now(), promise });
  while (WORLD.size > 30) WORLD.delete(WORLD.keys().next().value);
  promise.catch(() => { if (WORLD.get(key) && WORLD.get(key).promise === promise) WORLD.delete(key); });
  return promise;
}

async function buildWorld(user) {
  const [, people, positions, current, reqs, apps, joinedApps, dir] = await Promise.all([
    nextAction.ensureNextActionContext(),
    peopleFor(user),
    prisma.position.findMany({ select: { id: true, code: true, kind: true, department: true, team: true, reportsToId: true, active: true } }),
    prisma.positionAssignment.findMany({
      where: { toDate: null },
      select: { positionId: true, employeeId: true, employee: { select: { name: true, userId: true } } },
    }),
    prisma.requirement.findMany({
      where: requirementWhere(user),
      select: {
        id: true, title: true, reqCode: true, status: true, department: true, internal: true, hiringType: true,
        clientId: true, recruiterId: true, recruiterIds: true, bdeId: true, tlId: true, tl: true, stlId: true,
        positionCode: true, openings: true, createdAt: true,
        client: { select: { id: true, name: true, bdeOwner: true, clientType: true } },
      },
    }),
    readApplications({ AND: [applicationWhere(user), { stage: { notIn: NOT_ACTIVE } }] }, APP_SELECT),
    readApplications({ AND: [applicationWhere(user), { stage: { in: JOINED_STAGES } }] }, APP_SELECT),
    loadDirectory(),
  ]);

  // --- Seats: who holds what, and the TL each recruiter seat reports to ----
  const posById = new Map(positions.map((p) => [p.id, p]));
  const posByCode = new Map(positions.map((p) => [p.code, p]));
  const holderOf = new Map();
  current.forEach((a) => { if (a.employee) holderOf.set(a.positionId, a.employee); });
  const seatsByEmp = new Map();
  current.forEach((a) => {
    const p = posById.get(a.positionId);
    if (!p) return;
    if (!seatsByEmp.has(a.employeeId)) seatsByEmp.set(a.employeeId, []);
    seatsByEmp.get(a.employeeId).push(p);
  });
  const userById = new Map(dir.users.map((u) => [u.id, u]));
  const userName = (id) => (id && userById.has(id) ? userById.get(id).name : null);
  const personByName = (name) => { const p = name ? dir.person(null, name) : null; return p && p.userId ? p.userId : null; };
  const seatOfUser = (u) => {
    const seats = (u.employee && seatsByEmp.get(u.employee.id)) || [];
    const want = (p) => (u.atsRole === 'BDE' ? /\bBDE\b/i.test(p.code) : p.kind === u.atsRole);
    return seats.find(want) || seats[0] || null;
  };
  // The TL above a seat, as it stands today.
  const tlOfSeat = (seat) => {
    if (!seat || seat.kind !== 'RECRUITER' || !seat.reportsToId) return null;
    const h = holderOf.get(seat.reportsToId);
    return h ? { id: h.userId || null, name: h.name } : null;
  };

  // A recruiter's current seat by user id (for requirements that name only
  // the recruiter).
  const seatByUserId = new Map();
  const shapedPeople = people.map((u) => {
    const seat = seatOfUser(u);
    let tl = null;
    if (u.atsRole !== 'TL' && u.atsRole !== 'STL') {
      tl = tlOfSeat(seat);
      if (!tl && u.employee && u.employee.tl) tl = { id: personByName(u.employee.tl), name: u.employee.tl };
    }
    if (seat) seatByUserId.set(u.id, seat);
    const department = u.atsDepartment || (seat && seat.department) || (u.employee && u.employee.department) || null;
    return {
      id: u.id,
      userId: u.id,
      name: u.name,
      role: u.atsRole,
      roleGroup: u.atsRole === 'STL' ? 'TL' : u.atsRole,
      roleLabel: TEAM_ROLE_LABELS[u.atsRole] || u.atsRole,
      department,
      section: sectionOf(seat, department),
      seat: seat ? seat.code : null,
      recruiterCode: seat ? seat.code : null,
      seatLabel: seat ? [seat.code, seatTeamOf(seat)].filter(Boolean).join(' · ') : null,
      employeeCode: (u.employee && u.employee.employeeCode) || null,
      designation: (u.employee && u.employee.designation) || null,
      email: (u.employee && u.employee.email) || u.email || null,
      tl: tl ? tl.name : null,
      tlUserId: tl ? tl.id : null,
      stl: (u.employee && u.employee.stl) || null,
      status: (u.status || 'Active') === 'Active' && !LEFT_STATUSES.includes(u.employee && u.employee.employmentStatus) ? 'Active' : 'Left',
      scopeClients: csv(u.atsScopeClients),
    };
  });
  // Seats of people outside this screen's list still count for requirement
  // sections / TLs.
  current.forEach((a) => {
    const p = posById.get(a.positionId);
    if (p && p.kind === 'RECRUITER' && a.employee && a.employee.userId && !seatByUserId.has(a.employee.userId)) {
      seatByUserId.set(a.employee.userId, p);
    }
  });

  // --- Requirements: section, TL, recruiter(s), BDE -------------------------
  const clientOwnerId = (client) => (client && client.bdeOwner ? personByName(client.bdeOwner) : null);
  const shapeReq = (r) => {
    const seat = (r.positionCode && posByCode.get(r.positionCode)) || (r.recruiterId && seatByUserId.get(r.recruiterId)) || null;
    const recruiterIds = uniq([r.recruiterId, ...csv(r.recruiterIds)]);
    const recruiters = recruiterIds.map((id) => ({ id, name: userName(id) || '—' }));
    let tl = null;
    if (r.tlId) tl = { id: r.tlId, name: userName(r.tlId) || r.tl || '—', source: 'assigned' };
    else if (r.tl) tl = { id: personByName(r.tl), name: r.tl, source: 'assigned' };
    else {
      const viaSeat = tlOfSeat(seat);
      if (viaSeat) tl = { ...viaSeat, source: 'seat' };
    }
    let bde = null;
    if (!r.internal) {
      if (r.bdeId) bde = { id: r.bdeId, name: userName(r.bdeId) || '—', source: 'requirement' };
      else if (r.client && r.client.bdeOwner) bde = { id: clientOwnerId(r.client), name: r.client.bdeOwner, source: 'client' };
    }
    const missing = [];
    if (!recruiters.length) missing.push('Recruiter');
    if (!tl) missing.push('TL');
    // Internal requirements need no BDE — never "BDE Missing" for them.
    if (!r.internal && !bde) missing.push('BDE');
    let assignment = 'Fully Assigned';
    if (missing.length === 1) assignment = `${missing[0]} Missing`;
    else if (missing.length > 1) assignment = 'Needs Assignment';
    return {
      id: r.id,
      reqCode: r.reqCode || null,
      title: r.title,
      clientId: r.clientId,
      client: r.internal ? INTERNAL_CLIENT_LABEL : (r.client && r.client.name) || '—',
      clientRecordName: (r.client && r.client.name) || null,
      type: r.internal ? 'Internal' : 'Client',
      internal: !!r.internal,
      department: r.department || (seat && seat.department) || null,
      section: sectionOf(seat, r.department || (seat && seat.department)),
      seat: seat ? seat.code : null,
      tl,
      recruiters,
      recruiter: recruiters[0] || null,
      bde,
      status: r.status,
      statusLabel: requirementStatusLabel(r.status) || r.status,
      live: LIVE.has(r.status),
      openings: r.openings,
      createdAt: r.createdAt,
      assignment,
      missing,
      bdeRequired: !r.internal,
    };
  };
  const shapedReqs = reqs.map(shapeReq);
  const reqById = new Map(shapedReqs.map((r) => [r.id, r]));

  // --- Applications: attribution + the ONE next action ----------------------
  const shapeApp = (a) => {
    const at = attribute(a.requirement, a.followUps, a.stageEvents, dir.person);
    const req = reqById.get(a.requirementId) || (a.requirement ? shapeReq({
      ...a.requirement, department: a.requirement.department, client: a.requirement.client, openings: null,
    }) : null);
    return {
      id: a.id,
      candidateId: a.candidateId,
      candidate: a.candidate ? a.candidate.name : '—',
      requirementId: a.requirementId,
      requirement: req ? req.title : '—',
      reqCode: req ? req.reqCode : null,
      clientId: req ? req.clientId : null,
      client: req ? req.client : null,
      internal: req ? req.internal : false,
      department: req ? req.department : null,
      section: req ? req.section : null,
      reqTl: req ? req.tl : null,
      stage: a.stage,
      stageLabel: stageLabel(a.stage),
      updatedAt: a.updatedAt,
      createdAt: a.createdAt,
      interviewAt: a.interviewAt,
      interviewStatus: a.interviewStatus,
      recruiterUserId: at.recruiter && at.recruiter.userId,
      recruiterName: at.recruiter && at.recruiter.label,
      tlUserId: at.tl && at.tl.userId,
      tlName: at.tl && at.tl.label,
      bdeUserId: at.bde && at.bde.userId,
      raw: a,
    };
  };
  const activeApps = apps.filter((a) => !isPreAtsApplication(a)).map(shapeApp);
  const joined = joinedApps.map(shapeApp);

  // THE NEXT ACTION of every active application (one each).
  const today = nextAction.todayIst();
  const actions = [];
  activeApps.forEach((a) => {
    const na = helperAction(a, nextAction.nextActionFor(a.raw, { today }), { userName, clientOwnerId });
    if (na) actions.push(na);
  });

  // --- BDE → clients (Client → BDE) ------------------------------------------
  const bdes = shapedPeople.filter((p) => p.role === 'BDE');
  const bdeClientIds = new Map(bdes.map((b) => [b.id, new Set(b.scopeClients)]));
  if (bdes.length) {
    const names = uniq(bdes.map((b) => b.name));
    const owned = names.length ? await prisma.client.findMany({ where: { bdeOwner: { not: null } }, select: { id: true, bdeOwner: true } }) : [];
    owned.forEach((c) => {
      bdes.filter((b) => lc(b.name) === lc(c.bdeOwner)).forEach((b) => bdeClientIds.get(b.id).add(c.id));
    });
    shapedReqs.forEach((r) => {
      if (r.bde && r.bde.source === 'requirement' && bdeClientIds.has(r.bde.id) && r.clientId) bdeClientIds.get(r.bde.id).add(r.clientId);
    });
  }
  const allClientIds = uniq([...bdeClientIds.values()].flatMap((s) => [...s]));
  const clients = allClientIds.length
    ? await prisma.client.findMany({ where: { id: { in: allClientIds } }, select: { id: true, name: true, status: true, ownerDepartment: true, clientType: true } })
    : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const world = {
    at: Date.now(),
    people: shapedPeople,
    peopleById: new Map(shapedPeople.map((p) => [p.id, p])),
    reqs: shapedReqs,
    reqById,
    apps: activeApps,
    joined,
    actions,
    actionByApp: new Map(actions.map((x) => [x.applicationId, x])),
    helperReady: true,
    today,
    bdeClientIds,
    clientById,
  };
  return world;
}

// One Pending Actions row from the shared helper's answer. The helper names
// the owner from an open follow-up or the requirement; where it names nobody
// (imported tracker work: the recruiter / TL is recorded on the follow-up or
// stage history, not on the requirement) the owner is the person the work is
// ATTRIBUTED to for that role (utils/workers.js) — for a BDE step, the
// client's Owner BDE — so every active application has one named owner
// wherever one is known. ownerSource says which.
const ROLE_ATTR = { Recruiter: 'recruiter', HR: 'recruiter', TL: 'tl', 'Dept Head / TL': 'tl', BDE: 'bde' };
function helperAction(a, na, ctx) {
  if (!na || !na.live || !na.action) return null;
  let ownerUserId = na.ownerUserId || null;
  let ownerName = na.ownerName || (ownerUserId && ctx.userName(ownerUserId)) || null;
  let ownerSource = ownerUserId ? 'assigned' : null;
  // A BDE step on a requirement that names no BDE: the helper falls back to
  // the requirement's recruiter. Where the CLIENT has an Owner BDE, that BDE
  // owns the client-side step (spec: Client Submitted → Follow up for Client
  // Decision · owner BDE). An open follow-up's own owner is left alone.
  const req = a.raw.requirement || {};
  const fu = nextAction.snapshot().openFu.get(a.id);
  const openFuOwner = !!(fu && fu.ownerUserId);
  if (na.ownerRole === 'BDE' && !req.bdeId && !openFuOwner) {
    const clientBde = ctx.clientOwnerId(req.client);
    if (clientBde) { ownerUserId = clientBde; ownerName = req.client.bdeOwner; ownerSource = 'client owner'; }
  }
  if (!ownerUserId) {
    const k = ROLE_ATTR[na.ownerRole];
    let id = null;
    let name = null;
    if (k === 'recruiter') { id = a.recruiterUserId; name = a.recruiterName; }
    if (k === 'tl') { id = (a.reqTl && a.reqTl.id) || a.tlUserId; name = (a.reqTl && a.reqTl.name) || a.tlName; }
    if (k === 'bde') {
      const client = a.raw.requirement && a.raw.requirement.client;
      id = ctx.clientOwnerId(client) || a.bdeUserId;
      name = (client && client.bdeOwner) || (id && ctx.userName(id)) || null;
    }
    // Only a person with a login can act: a name alone (a recruiter who has
    // left, or tracker text) leaves the step without a named owner.
    if (id) { ownerUserId = id; ownerName = ctx.userName(id) || name; ownerSource = 'attributed'; }
  }
  return {
    id: a.id,
    applicationId: a.id,
    candidateId: a.candidateId,
    candidate: a.candidate,
    requirementId: a.requirementId,
    requirement: a.requirement,
    reqCode: a.reqCode,
    client: a.client,
    internal: a.internal,
    department: a.department,
    section: a.section,
    tl: a.reqTl ? a.reqTl.name : a.tlName || null,
    tlUserId: a.reqTl ? a.reqTl.id : a.tlUserId || null,
    stage: a.stage,
    stageLabel: na.stageLabel || a.stageLabel,
    action: na.action,
    actionType: na.action,
    ownerRole: na.ownerRole || null,
    ownerUserId,
    owner: ownerName || null,
    ownerSource,
    waitingOn: na.waitingOn || null,
    dueAt: na.dueAt || null,
    dueSource: na.dueSource || null,
    dueStatus: DUE_STATUS[na.dueStatus] || 'none',
  };
}

// ---------------------------------------------------------------------------
// PER-PERSON SETS — each number is the size of one set, and the list it opens
// is that set's rows.
// ---------------------------------------------------------------------------
const isToday = (d) => !!d && new Date(d).toDateString() === new Date().toDateString();

function personSets(world, person) {
  const id = person.id;
  const role = person.roleGroup;
  const sets = {};
  if (role === 'RECRUITER') {
    const mine = world.apps.filter((a) => a.recruiterUserId === id);
    sets.openRequirements = { kind: 'requirements', ids: world.reqs.filter((r) => r.live && r.recruiters.some((x) => x.id === id)).map((r) => r.id) };
    sets.activeCandidates = { kind: 'applications', ids: mine.map((a) => a.id) };
    sets.needsAction = { kind: 'actions', ids: world.actions.filter((x) => x.ownerUserId === id).map((x) => x.id) };
    sets.interviewsToday = { kind: 'applications', ids: mine.filter((a) => isToday(a.interviewAt) && !DEAD_INTERVIEW.includes(a.interviewStatus)).map((a) => a.id) };
    sets.interviews = { kind: 'applications', ids: mine.filter((a) => INTERVIEW_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.selected = { kind: 'applications', ids: mine.filter((a) => SELECTED_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.joined = { kind: 'joined', ids: world.joined.filter((a) => a.recruiterUserId === id).map((a) => a.id) };
  } else if (role === 'BDE') {
    const clientIds = world.bdeClientIds.get(id) || new Set();
    const reqs = world.reqs.filter((r) => !r.internal && ((r.clientId && clientIds.has(r.clientId)) || (r.bde && r.bde.id === id)));
    const reqIds = new Set(reqs.map((r) => r.id));
    const apps = world.apps.filter((a) => reqIds.has(a.requirementId));
    const activeClientIds = new Set(reqs.filter((r) => r.live).map((r) => r.clientId));
    sets.clients = { kind: 'clients', ids: [...clientIds] };
    sets.activeClients = { kind: 'clients', ids: [...clientIds].filter((c) => activeClientIds.has(c)) };
    sets.openRequirements = { kind: 'requirements', ids: reqs.filter((r) => r.live).map((r) => r.id) };
    sets.submitted = { kind: 'applications', ids: apps.filter((a) => SUBMITTED_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.feedbackPending = { kind: 'applications', ids: apps.filter((a) => FEEDBACK_PENDING_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.interviews = { kind: 'applications', ids: apps.filter((a) => INTERVIEW_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.selected = { kind: 'applications', ids: apps.filter((a) => SELECTED_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.joined = { kind: 'joined', ids: world.joined.filter((a) => reqIds.has(a.requirementId)).map((a) => a.id) };
    sets.clientActions = { kind: 'actions', ids: world.actions.filter((x) => x.ownerUserId === id).map((x) => x.id) };
    sets.needsAction = sets.clientActions;
  } else {
    // TL / STL — the team and its review work.
    const team = world.people.filter((p) => p.roleGroup === 'RECRUITER' && p.tlUserId === id && p.status === 'Active');
    const teamIds = new Set(team.map((p) => p.id));
    const reqs = world.reqs.filter((r) => r.live && ((r.tl && r.tl.id === id) || r.recruiters.some((x) => teamIds.has(x.id))));
    const apps = world.apps.filter((a) => a.tlUserId === id || (a.recruiterUserId && teamIds.has(a.recruiterUserId)));
    sets.recruiters = { kind: 'people', ids: team.map((p) => p.id) };
    sets.requirements = { kind: 'requirements', ids: reqs.map((r) => r.id) };
    sets.candidates = { kind: 'applications', ids: apps.map((a) => a.id) };
    // Pending Reviews: the TL Review step (Approve / Reject / Hold) waiting on
    // this TL. Needs Action: every next action they own.
    const owned = world.actions.filter((x) => x.ownerUserId === id);
    sets.pendingReviews = { kind: 'actions', ids: owned.filter((x) => x.stage === 'TL_REVIEW').map((x) => x.id) };
    sets.needsAction = { kind: 'actions', ids: owned.map((x) => x.id) };
    sets.interviews = { kind: 'applications', ids: apps.filter((a) => INTERVIEW_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.selected = { kind: 'applications', ids: apps.filter((a) => SELECTED_STAGES.includes(a.stage)).map((a) => a.id) };
    sets.joined = {
      kind: 'joined',
      ids: world.joined.filter((a) => a.tlUserId === id || (a.recruiterUserId && teamIds.has(a.recruiterUserId))).map((a) => a.id),
    };
  }
  return sets;
}

const METRIC_LABELS = {
  openRequirements: 'Open Requirements',
  activeCandidates: 'Active Candidates',
  needsAction: 'Needs Action',
  interviewsToday: 'Interviews Today',
  interviews: 'Interviews',
  selected: 'Selected',
  joined: 'Joined',
  clients: 'Clients',
  activeClients: 'Active Clients',
  submitted: 'Submitted Candidates',
  feedbackPending: 'Client Feedback Pending',
  clientActions: 'Client Actions',
  recruiters: 'Recruiters',
  requirements: 'Requirements',
  candidates: 'Candidates',
  pendingReviews: 'Pending Reviews',
};
const METRIC_HINTS = {
  openRequirements: 'Live requirements assigned to them',
  activeCandidates: 'Active ATS applications they own (not Candidate Master; Hold / Rejected / Joined and Job Portal screening left out)',
  needsAction: 'Active applications whose one next action is theirs',
  interviewsToday: 'Their active applications with an interview booked today',
  interviews: 'Active applications at Interview Scheduled / Completed',
  selected: 'Selected, Offer or Offer Accepted — not yet joined',
  joined: 'Joined / hired',
  clients: 'Clients whose Owner BDE they are (or assigned to them)',
  activeClients: 'Their clients with at least one live requirement',
  submitted: 'Active applications on their clients submitted to the client (Client Submission onward)',
  feedbackPending: 'Submitted and waiting on the client decision (Shared with Client / Client Review)',
  clientActions: 'Client-side next actions owned by them',
  recruiters: 'Recruiters whose seat reports to them',
  requirements: 'Live requirements they lead or their recruiters hold',
  candidates: "Active applications of their team",
  pendingReviews: 'Applications at TL Review waiting on them (Approve / Reject / Hold)',
};

function countsOf(sets) {
  const out = {};
  Object.keys(sets).forEach((k) => { out[k] = sets[k].ids.length; });
  return out;
}

// ---------------------------------------------------------------------------
// PEOPLE & WORKLOAD rows (GET /api/ats/team). The legacy fields the export
// reads (openRequirements, activePipeline, …) are kept.
// ---------------------------------------------------------------------------
async function teamWorkloadRows(user, { includeLeft = true, fresh = false } = {}) {
  const world = await loadWorld(user, { fresh });
  const rows = world.people
    .filter((p) => includeLeft || p.status === 'Active')
    .map((p) => {
      const sets = personSets(world, p);
      const c = countsOf(sets);
      const extra = {};
      if (p.roleGroup === 'BDE') {
        const clientIds = [...(world.bdeClientIds.get(p.id) || [])];
        extra.clientOptions = clientIds.map((id) => world.clientById.get(id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name }));
      }
      return {
        ...p,
        scopeClients: undefined,
        counts: c,
        ...extra,
        // Legacy readers (export, older screens).
        openRequirements: c.openRequirements !== undefined ? c.openRequirements : c.requirements,
        activePipeline: c.activeCandidates !== undefined ? c.activeCandidates : c.candidates !== undefined ? c.candidates : c.submitted,
        activeApplications: c.activeCandidates !== undefined ? c.activeCandidates : c.candidates,
        pending: world.helperReady ? c.needsAction : null,
        interviews: c.interviews,
        selected: c.selected,
        joined: c.joined,
      };
    });
  rows.sort((a, b) => (TEAM_ROLE_ORDER[a.role] - TEAM_ROLE_ORDER[b.role]) || a.name.localeCompare(b.name));
  return { rows, helperReady: world.helperReady };
}

// ---------------------------------------------------------------------------
// ASSIGNMENTS (GET /api/ats/team?view=assignments) — one row per requirement
// in the caller's requirement scope.
// ---------------------------------------------------------------------------
async function assignmentRows(user, { fresh = false } = {}) {
  const world = await loadWorld(user, { fresh });
  return world.reqs
    .map((r) => ({ ...r }))
    .sort((a, b) => (b.live - a.live) || (new Date(b.createdAt) - new Date(a.createdAt)));
}

// ---------------------------------------------------------------------------
// PENDING ACTIONS (GET /api/ats/team?view=pending) — one row per active ATS
// application in the caller's scope, from the shared helper.
// ---------------------------------------------------------------------------
const DUE_ORDER = { overdue: 0, today: 1, upcoming: 2, none: 3 };
async function pendingActionRows(user, { fresh = false } = {}) {
  const world = await loadWorld(user, { fresh });
  const rows = world.actions.slice().sort((a, b) => (DUE_ORDER[a.dueStatus] - DUE_ORDER[b.dueStatus])
    || String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
  return { rows, helperReady: world.helperReady };
}

// ---------------------------------------------------------------------------
// LISTS BEHIND THE NUMBERS and the 360s.
// ---------------------------------------------------------------------------
function listRows(world, kind, ids, { clientDesk }) {
  const want = new Set(ids);
  if (kind === 'requirements') {
    return world.reqs.filter((r) => want.has(r.id)).map((r) => ({
      id: r.id, reqCode: r.reqCode, title: r.title, client: r.client, type: r.type, department: r.department,
      section: r.section, status: r.status, statusLabel: r.statusLabel, live: r.live,
      recruiter: r.recruiters.map((x) => x.name).join(', ') || null, tl: r.tl ? r.tl.name : null, bde: r.bde ? r.bde.name : null,
      assignment: r.assignment, openings: r.openings,
    }));
  }
  if (kind === 'applications' || kind === 'joined') {
    const src = kind === 'joined' ? world.joined : world.apps;
    return src.filter((a) => want.has(a.id)).map((a) => {
      const na = world.actionByApp.get(a.id);
      return {
        id: a.id, applicationId: a.id, candidateId: a.candidateId, candidate: a.candidate,
        requirementId: a.requirementId, requirement: a.requirement, reqCode: a.reqCode, client: a.client,
        stage: a.stage, stageLabel: a.stageLabel, updatedAt: a.updatedAt, interviewAt: a.interviewAt,
        recruiter: a.recruiterName || null,
        nextAction: na ? na.action : null, owner: na ? na.owner : null, dueStatus: na ? na.dueStatus : null,
      };
    }).sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
  }
  if (kind === 'actions') {
    return world.actions.filter((x) => want.has(x.id))
      .sort((a, b) => (DUE_ORDER[a.dueStatus] - DUE_ORDER[b.dueStatus]) || String(a.dueAt || '').localeCompare(String(b.dueAt || '')));
  }
  if (kind === 'clients') {
    return ids.map((id) => world.clientById.get(id)).filter(Boolean).map((c) => {
      const reqs = world.reqs.filter((r) => r.clientId === c.id && !r.internal);
      return {
        id: c.id, name: c.name, status: c.status || null, link: clientDesk,
        requirements: reqs.length, openRequirements: reqs.filter((r) => r.live).length,
      };
    }).sort((a, b) => b.openRequirements - a.openRequirements || a.name.localeCompare(b.name));
  }
  if (kind === 'people') {
    return world.people.filter((p) => want.has(p.id)).map((p) => {
      const c = countsOf(personSets(world, p));
      return { id: p.id, name: p.name, seatLabel: p.seatLabel, department: p.department, section: p.section, status: p.status, counts: c };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  return [];
}

async function findPerson(user, userId, world) {
  const person = world.peopleById.get(String(userId));
  if (person) return { person };
  const exists = await prisma.user.count({ where: { id: String(userId) } });
  return { status: exists ? 403 : 404, body: { error: exists ? 'This person is outside your scope' : 'Person not found' } };
}

// One number's exact rows: GET /api/ats/team/:userId?metric=…
async function memberMetricList(user, userId, metric, { clientDesk = false, fresh = false } = {}) {
  const world = await loadWorld(user, { fresh });
  const found = await findPerson(user, userId, world);
  if (!found.person) return found;
  const { person } = found;
  const sets = personSets(world, person);
  const set = sets[metric];
  if (!set) return { status: 400, body: { error: `Unknown number "${metric}" for a ${person.roleLabel}.` } };
  return {
    status: 200,
    body: {
      person: { id: person.id, name: person.name, role: person.role, roleGroup: person.roleGroup, roleLabel: person.roleLabel },
      metric,
      label: METRIC_LABELS[metric] || metric,
      hint: METRIC_HINTS[metric] || null,
      kind: set.kind,
      total: set.ids.length,
      rows: listRows(world, set.kind, set.ids, { clientDesk }),
      helperReady: world.helperReady,
    },
  };
}

// The numbers each 360 shows, in the spec's order.
const NUMBERS_360 = {
  RECRUITER: ['openRequirements', 'activeCandidates', 'needsAction', 'interviewsToday', 'selected', 'joined'],
  BDE: ['clients', 'openRequirements', 'submitted', 'feedbackPending', 'interviews', 'selected', 'joined'],
  TL: ['recruiters', 'requirements', 'candidates', 'pendingReviews', 'interviews', 'selected'],
};
// The sections each 360 shows: [id, title, metric]. A section previews the
// first rows of its metric's list and links to the whole list.
const SECTIONS_360 = {
  RECRUITER: [
    ['requirements', 'Requirements', 'openRequirements'],
    ['candidates', 'Candidates', 'activeCandidates'],
    ['interviews', 'Interviews', 'interviews'],
    ['pending', 'Pending Actions', 'needsAction'],
  ],
  BDE: [
    ['clients', 'Clients', 'clients'],
    ['requirements', 'Requirements', 'openRequirements'],
    ['submissions', 'Candidate Submissions', 'submitted'],
    ['feedback', 'Client Feedback', 'feedbackPending'],
    ['interviews', 'Interviews', 'interviews'],
    ['selections', 'Selections', 'selected'],
    ['joining', 'Joining', 'joined'],
    ['pending', 'Pending Actions', 'clientActions'],
  ],
  TL: [
    ['recruiters', 'Recruiters', 'recruiters'],
    ['requirements', 'Requirements', 'requirements'],
    ['candidates', 'Candidates', 'candidates'],
    ['reviews', 'Pending Reviews', 'pendingReviews'],
    ['interviews', 'Interviews', 'interviews'],
    ['selections', 'Selections', 'selected'],
  ],
};
const PREVIEW = 8;

async function teamMemberDetail(user, userId, { clientDesk = false, fresh = false } = {}) {
  const world = await loadWorld(user, { fresh });
  const found = await findPerson(user, userId, world);
  if (!found.person) return found;
  const { person } = found;
  const role = person.roleGroup;
  const sets = personSets(world, person);
  const counts = countsOf(sets);

  const numbers = NUMBERS_360[role].map((m) => ({ metric: m, label: METRIC_LABELS[m], hint: METRIC_HINTS[m], value: counts[m] }));
  const sections = SECTIONS_360[role].map(([id, title, metric]) => {
    const set = sets[metric];
    return {
      id, title, metric, kind: set.kind, total: set.ids.length,
      rows: listRows(world, set.kind, set.ids, { clientDesk }).slice(0, PREVIEW),
    };
  });

  // Activity: their stage moves on records the caller can see, plus the
  // requirement / interview actions the audit trail recorded.
  const [events, audits] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      where: { AND: [{ OR: [{ actorUserId: person.id }, { actorName: person.name }] }, { application: { is: applicationWhere(user) } }] },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { createdAt: true, action: true, toStage: true, requirementTitle: true, candidate: { select: { id: true, name: true } } },
    }).catch(() => []),
    prisma.auditLog.findMany({
      where: { userId: person.id, entity: { in: ['Requirement', 'Interview', 'Client'] } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { createdAt: true, action: true, entity: true },
    }).catch(() => []),
  ]);
  const activity = [
    ...events.map((e) => ({
      when: e.createdAt,
      what: e.action || `Moved to ${stageLabel(e.toStage)}`,
      candidate: e.candidate ? e.candidate.name : null,
      candidateId: e.candidate ? e.candidate.id : null,
      requirement: e.requirementTitle || null,
    })),
    ...audits.map((a) => ({ when: a.createdAt, what: `${a.action}${a.entity ? ` · ${a.entity}` : ''}`, candidate: null, requirement: null })),
  ].sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 15);

  // TL 360 → Team: the team as a whole.
  let team = null;
  if (role === 'TL') {
    const members = world.people.filter((p) => p.roleGroup === 'RECRUITER' && p.tlUserId === person.id);
    team = {
      size: members.length,
      sections: uniq(members.map((m) => m.section)),
      active: members.filter((m) => m.status === 'Active').length,
    };
  }

  return {
    status: 200,
    body: {
      person: {
        id: person.id,
        name: person.name,
        role: person.role,
        roleGroup: role,
        roleLabel: person.roleLabel,
        employeeCode: person.employeeCode,
        designation: person.designation,
        email: person.email,
        seat: person.seatLabel || person.recruiterCode,
        recruiterCode: person.recruiterCode,
        department: person.department,
        section: person.section,
        tl: person.tl,
        tlUserId: person.tlUserId,
        stl: person.stl,
        status: person.status,
      },
      numbers,
      counts,
      sections,
      team,
      activity,
      clientDesk: !!clientDesk,
      helperReady: world.helperReady,
      bdeEmpty: role === 'BDE' && counts.clients === 0,
    },
  };
}

// FORMER HOLDERS (admins only): the recruiters / BDEs who used to hold these
// seats or whose work is on these records and have left, with HISTORICAL
// counts from the work attributed to them.
async function formerWorkloadRows(user, currentIds) {
  // eslint-disable-next-line global-require
  const { listWorkers } = require('./workers');
  const [workers, apps, dir] = await Promise.all([
    listWorkers(user),
    readApplications(applicationWhere(user), { ...ATTR_SELECT }),
    loadDirectory(),
  ]);
  const want = new Map();
  [['RECRUITER', workers.recruiters], ['BDE', workers.bdes]].forEach(([role, list]) => {
    list.filter((w) => !w.current && !(w.userId && currentIds.has(w.userId)))
      .forEach((w) => want.set(`${role}:${w.key}`, { role, w }));
  });
  if (!want.size) return [];
  const counts = new Map();
  apps.forEach((a) => {
    const at = attribute(a.requirement, a.followUps, a.stageEvents, dir.person);
    [['RECRUITER', at.recruiter], ['BDE', at.bde]].forEach(([role, who]) => {
      if (!who) return;
      const k = `${role}:${who.key}`;
      if (!want.has(k)) return;
      if (!counts.has(k)) counts.set(k, { applications: 0, requirements: new Set(), candidates: new Set(), joined: 0, tls: new Map() });
      const c = counts.get(k);
      c.applications += 1;
      c.requirements.add(a.requirementId);
      c.candidates.add(a.candidateId);
      if (JOINED_STAGES.includes(a.stage)) c.joined += 1;
      if (at.tl && at.tl.label) c.tls.set(at.tl.label, (c.tls.get(at.tl.label) || 0) + 1);
    });
  });
  const rows = [];
  want.forEach(({ role, w }, k) => {
    const c = counts.get(k);
    const tl = c ? [...c.tls.entries()].sort((x, y) => y[1] - x[1]).map(([label]) => label)[0] || null : null;
    rows.push({
      id: `former:${role}:${w.key}`,
      name: w.name,
      value: w.value,
      role,
      roleGroup: role,
      roleLabel: TEAM_ROLE_LABELS[role],
      former: true,
      status: 'Left',
      department: w.department,
      departments: w.departments,
      seat: w.seat,
      recruiterCode: w.seat,
      seats: w.seats,
      tl,
      leftOn: w.leftOn,
      replacedBy: w.replacedBy,
      requirementsWorked: c ? c.requirements.size : 0,
      candidatesWorked: c ? c.candidates.size : 0,
      applicationsWorked: c ? c.applications : 0,
      joined: c ? c.joined : 0,
      counts: {},
    });
  });
  return rows;
}

// Kept for older callers; the world cache replaces the old row memo.
function rememberRows() {}
function forgetWorld(user) { if (user) WORLD.delete(user.id); else WORLD.clear(); }

module.exports = {
  TEAM_ROLE_LABELS, METRIC_LABELS, isAdminViewer, teamAccess, teamPeopleWhere,
  teamWorkloadRows, assignmentRows, pendingActionRows, formerWorkloadRows,
  teamMemberDetail, memberMetricList, rememberRows, forgetWorld,
};
