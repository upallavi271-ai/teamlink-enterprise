// ---------------------------------------------------------------------------
// FORMER PEOPLE IN ATS (user, 2026-10-05): "Past employees' data must also be
// visible in ATS. Whichever department they worked in, they must be visible in
// that department ... show the old employees and their whole work history."
//
// HRMS IS THE SOURCE. Nothing is copied into ATS tables. Everything here is
// READ, on every request (cached for a minute), from:
//   Employee            who has left (utils/positions.js hasLeft), their HRMS
//                       department, designation, joining date
//   EmployeeRecord /    the last working day (RESIGNATION record date, else
//   ResignationDetail   the approved / requested last working date, else the
//                       end of their last seat)
//   Position /          their seats with dates (Positions & Seat History) —
//   PositionAssignment  the departments / teams over time and who sat in the
//                       seat after them
//   Application + its   the ATS work attributed to them — the ONE "whose work
//   follow-ups / stage  is this" rule every ATS person filter and report uses
//   events              (utils/workers.js attribute()): as recruiter, TL, BDE
//
// WHO IS A FORMER ATS PERSON: an employee who has left AND has an ATS trace —
// a Recruiter / TL / STL / BDE seat, ATS work attributed to them, an ATS role
// on their login, or a Recruiter / TL / STL / BDE designation. A leaver with
// none of these (office staff) is not an ATS person and is not listed.
//
// THE DEPARTMENTS THEY WORKED IN (each with dates): every seat's department,
// every department their attributed work sits in, and their HRMS department.
// A person who moved departments is listed under each.
//
// WHO SEES WHOM (server-side; the UI only hides):
//   Super Admin / Admin   everyone, all their work
//   Manager / Asst Mgr /  the former people who worked in their departments,
//   STL / HR              and only the work in those departments
//   TL (holds a TL seat)  the former holders of their team's seats, plus the
//                         department's former people who never sat in another
//                         team's seat; only their departments' work
//   TL (no seat)          their departments, as a Manager
//   Recruiter / BDE /     nobody — a recruiter does not get others' history
//   anyone else
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { atsScopeOf } = require('./scope');
const { hasLeft } = require('./positions');
const { stageIndex } = require('./pipelineView');
const {
  attribute, loadDirectory, seatRole, clean,
} = require('./workers');

const TTL_MS = 60 * 1000;
let CACHE = null;

const isTestName = (v) => /zztest|example\.test/i.test(String(v || ''));
const ymd = (v) => {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const month = (d) => (d ? d.slice(0, 7) : null);
const minD = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
const maxD = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));
// A same-day tenure is a data-entry stub, never really held (workers.js).
const realTenure = (a) => !(a.toDate && a.toDate <= a.fromDate);
const isBdeDept = (d) => /^bde$/i.test(clean(d));

function seatTeamOf(p) {
  if (!p) return null;
  const team = String(p.team || '').trim();
  const dept = String(p.department || '').trim();
  if (!dept) return team || null;
  if (!team || /^team$/i.test(team)) return `${dept} Team`;
  return /^team\b/i.test(team) ? `${dept} ${team}` : `${dept} · ${team}`;
}

// The steps "reached" is measured at (the ATS Reports' rule).
const M = {
  shared: stageIndex('SHARED_WITH_CLIENT'),
  interview: stageIndex('INTERVIEW_SCHEDULED'),
  selected: stageIndex('SELECTED'),
  accepted: stageIndex('OFFER_ACCEPTED'),
};
const JOINED = ['JOINED', 'HIRED'];
const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];

function roleFromDesignation(d) {
  const s = String(d || '');
  if (/\bS?TL\b|team\s*lead/i.test(s)) return 'TL';
  if (/recruit/i.test(s)) return 'RECRUITER';
  if (/\bBDE\b|business\s*dev/i.test(s)) return 'BDE';
  return null;
}
const ROLE_LABEL = { RECRUITER: 'Recruiter', TL: 'TL', STL: 'STL', BDE: 'BDE' };
const TEAM_ROLES = ['RECRUITER', 'BDE', 'TL', 'STL'];

// Every application with its follow-ups and step history, read as four flat
// tables in parallel and joined here — a nested read of 23k applications is
// several times slower on SQLite.
async function readAllApplications() {
  const [apps, reqs, fus, evs, cands] = await Promise.all([
    prisma.application.findMany({
      select: {
        id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, interviewAt: true,
        interviewStatus: true, offerStatus: true, joinedAt: true, joiningDate: true,
      },
    }),
    prisma.requirement.findMany({
      select: {
        id: true, recruiterId: true, tlId: true, tl: true, bdeId: true, positionCode: true, department: true,
        title: true, reqCode: true, internal: true, status: true, client: { select: { name: true } },
      },
    }),
    prisma.applicationFollowUp.findMany({
      select: {
        applicationId: true, ownerUserId: true, ownerName: true, ownerPositionCode: true, tlUserId: true, tlName: true,
        bdeUserId: true, bdeName: true, createdAt: true, lastContactedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.applicationStageEvent.findMany({
      select: {
        applicationId: true, actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true,
        createdAt: true, fromStage: true, toStage: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.candidate.findMany({ select: { id: true, name: true } }),
  ]);
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const candById = new Map(cands.map((c) => [c.id, c]));
  const group = (rows) => {
    const m = new Map();
    rows.forEach((r) => { if (!m.has(r.applicationId)) m.set(r.applicationId, []); m.get(r.applicationId).push(r); });
    return m;
  };
  const fuBy = group(fus);
  const evBy = group(evs);
  return apps.map((a) => ({
    ...a,
    candidate: candById.get(a.candidateId) || null,
    requirement: reqById.get(a.requirementId) || null,
    followUps: fuBy.get(a.id) || [],
    stageEvents: evBy.get(a.id) || [],
  }));
}

// One application's dated milestones.
function milestones(a) {
  const evs = a.stageEvents || [];
  const fus = a.followUps || [];
  let work = ymd(a.createdAt);
  fus.forEach((f) => { work = minD(work, ymd(f.createdAt)); work = minD(work, ymd(f.lastContactedAt)); });
  evs.forEach((e) => { work = minD(work, ymd(e.createdAt)); });
  if (a.interviewAt) work = minD(work, ymd(a.interviewAt));
  let reach = Math.max(0, stageIndex(a.stage));
  const firstInto = (m) => {
    const e = evs.find((x) => stageIndex(x.toStage) >= m);
    return e ? ymd(e.createdAt) : null;
  };
  evs.forEach((e) => { reach = Math.max(reach, stageIndex(e.fromStage), stageIndex(e.toStage)); });
  const interviewed = !!(a.interviewStatus || a.interviewAt);
  if (interviewed) reach = Math.max(reach, M.interview);
  if (a.offerStatus === 'Offer Accepted') reach = Math.max(reach, M.accepted);
  else if (['Offer Released', 'Offer Declined'].includes(a.offerStatus)) reach = Math.max(reach, M.selected);
  const joined = JOINED.includes(a.stage);
  if (!joined) reach = Math.min(reach, M.accepted);
  const out = { work, added: work };
  if (reach >= M.shared) out.sent = firstInto(M.shared) || work;
  if (reach >= M.interview) out.interview = ymd(a.interviewAt) || firstInto(M.interview) || work;
  if (reach >= M.selected) out.selected = firstInto(M.selected) || work;
  if (joined) {
    const je = evs.find((x) => JOINED.includes(x.toStage));
    out.joined = ymd(a.joinedAt) || (/^\d{4}-\d{2}-\d{2}/.test(String(a.joiningDate || '')) ? a.joiningDate.slice(0, 10) : null)
      || (je ? ymd(je.createdAt) : null) || ymd(a.interviewAt) || work;
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE INDEX — every former ATS person and the work attributed to them, for
// the whole company. Built once a minute; each viewer reads a slice of it.
// ---------------------------------------------------------------------------
async function buildIndex() {
  const [dir, employees, positions, assignments, records, details, apps] = await Promise.all([
    loadDirectory(),
    prisma.employee.findMany({
      select: {
        id: true, name: true, userId: true, employeeCode: true, department: true, team: true,
        designation: true, employmentStatus: true, dateOfJoining: true, tl: true, email: true,
      },
    }),
    prisma.position.findMany({ select: { id: true, code: true, name: true, kind: true, department: true, team: true, reportsToId: true } }),
    prisma.positionAssignment.findMany({ select: { positionId: true, employeeId: true, fromDate: true, toDate: true }, orderBy: { fromDate: 'asc' } }),
    prisma.employeeRecord.findMany({
      where: { type: 'RESIGNATION', NOT: { status: 'Withdrawn' } },
      select: { employeeId: true, date: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.resignationDetail.findMany({
      select: { employeeId: true, approvedLastWorkingDate: true, requestedLastWorkingDate: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    readAllApplications(),
  ]);
  const posById = new Map(positions.map((p) => [p.id, p]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const tenuresOfSeat = new Map();
  const tenuresOfEmp = new Map();
  assignments.filter(realTenure).forEach((a) => {
    if (!tenuresOfSeat.has(a.positionId)) tenuresOfSeat.set(a.positionId, []);
    tenuresOfSeat.get(a.positionId).push(a);
    if (!tenuresOfEmp.has(a.employeeId)) tenuresOfEmp.set(a.employeeId, []);
    tenuresOfEmp.get(a.employeeId).push(a);
  });
  const lwdOf = new Map();
  details.forEach((d) => { const v = ymd(d.approvedLastWorkingDate || d.requestedLastWorkingDate); if (v) lwdOf.set(d.employeeId, v); });
  records.forEach((r) => { const v = ymd(r.date); if (v) lwdOf.set(r.employeeId, v); });

  // --- The leavers, and the attribution key each one's work is under ------
  const left = employees.filter((e) => hasLeft(e.employmentStatus));
  const byKey = new Map(); // person key -> person
  const people = [];
  left.forEach((e) => {
    const p = dir.person(e.userId, e.name);
    const u = e.userId ? dir.person.userById.get(e.userId) : null;
    let key = p ? p.key : null;
    // The name is somebody else's login (two people, one name): their work
    // cannot be told apart by name — list the leaver from HRMS / seats only.
    if (key && key.startsWith('u:') && key.slice(2) !== e.userId) {
      const other = dir.empByUser.get(key.slice(2));
      if (other && other.id !== e.id) key = null;
    }
    const person = {
      employeeId: e.id, e, user: u, key, apps: [], moves: [], roles: { RECRUITER: 0, TL: 0, BDE: 0 },
    };
    people.push(person);
    if (key && !byKey.has(key)) byKey.set(key, person);
  });

  // --- Their work --------------------------------------------------------------
  apps.forEach((a) => {
    if (a.candidate && isTestName(a.candidate.name)) return;
    const at = attribute(a.requirement, a.followUps, a.stageEvents, dir.person);
    const hits = new Map();
    [['RECRUITER', at.recruiter], ['TL', at.tl], ['BDE', at.bde]].forEach(([role, who]) => {
      const person = who && byKey.get(who.key);
      if (!person) return;
      if (!hits.has(person)) hits.set(person, []);
      hits.get(person).push(role);
    });
    // Step moves they made themselves (a person, not an importer).
    (a.stageEvents || []).forEach((ev) => {
      if (!ev.actorUserId && (!clean(ev.actorName) || /^imported|^system$/i.test(clean(ev.actorName)))) return;
      const who = dir.person(ev.actorUserId, ev.actorName);
      const person = who && byKey.get(who.key);
      if (person) person.moves.push({ appId: a.id, department: (a.requirement && a.requirement.department) || null, date: ymd(ev.createdAt) });
    });
    if (!hits.size) return;
    const ms = milestones(a);
    const r = a.requirement || {};
    const rec = {
      id: a.id,
      candidateId: a.candidateId,
      candidate: a.candidate ? a.candidate.name : null,
      requirementId: a.requirementId,
      title: r.title || null,
      reqCode: r.reqCode || null,
      client: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
      department: r.department || null,
      stage: a.stage,
      open: !CLOSED.includes(a.stage) && a.stage !== 'HOLD',
      nowRecruiterId: r.recruiterId || null,
      seat: at.seat || null,
      ...ms,
    };
    hits.forEach((roles, person) => {
      roles.forEach((role) => { person.roles[role] += 1; });
      person.apps.push({ ...rec, roles });
    });
  });

  // --- Shape each person ---------------------------------------------------------
  const out = [];
  people.forEach((person) => {
    const { e, user: u } = person;
    if (isTestName(`${e.name} ${e.email || ''}`)) return;
    const seats = (tenuresOfEmp.get(e.id) || [])
      .map((a) => ({ a, p: posById.get(a.positionId) }))
      .filter((x) => x.p && (seatRole(x.p) || x.p.kind === 'STL'))
      .sort((x, y) => String(x.a.fromDate).localeCompare(String(y.a.fromDate)));
    const lastSeat = seats[seats.length - 1] || null;
    const lwd = lwdOf.get(e.id) || (lastSeat && lastSeat.a.toDate) || null;

    // The role they are listed under.
    let role = null;
    if (lastSeat) role = lastSeat.p.kind === 'STL' ? 'STL' : seatRole(lastSeat.p);
    if (!role && u && TEAM_ROLES.includes(u.atsRole)) role = u.atsRole;
    if (!role) role = roleFromDesignation(e.designation);
    if (/\bSTL\b/i.test(e.designation || '') && role === 'TL') role = 'STL';
    if (!role) {
      const r = person.roles;
      const best = Object.entries(r).sort((x, y) => y[1] - x[1])[0];
      if (best && best[1] > 0) role = best[0];
    }
    if (!role) return; // no ATS trace — not an ATS person

    // The seats, with the TL above each during their time and who came next.
    const seatRows = seats.map(({ a, p }) => {
      const to = a.toDate || lwd || null;
      const holders = tenuresOfSeat.get(p.id) || [];
      const next = holders.find((h) => h.employeeId !== e.id && h.fromDate >= a.fromDate);
      let tl = null;
      if (p.reportsToId) {
        const over = (tenuresOfSeat.get(p.reportsToId) || [])
          .filter((h) => h.employeeId !== e.id && h.fromDate <= (to || '9999') && (!h.toDate || h.toDate >= a.fromDate));
        tl = [...new Set(over.map((h) => (empById.get(h.employeeId) || {}).name).filter(Boolean))].join(', ') || null;
      }
      const nextEmp = next ? empById.get(next.employeeId) : null;
      return {
        positionId: p.id,
        code: p.code,
        name: p.name || null,
        kind: p.kind,
        role: p.kind === 'STL' ? 'STL' : seatRole(p),
        department: p.department || null,
        team: seatTeamOf(p),
        from: a.fromDate,
        to,
        open: !a.toDate,
        tl,
        next: nextEmp ? { name: nextEmp.name, from: next.fromDate, left: hasLeft(nextEmp.employmentStatus) } : null,
      };
    });

    out.push({
      id: `fp:${e.id}`,
      employeeId: e.id,
      userId: e.userId || null,
      name: (u && u.name) || e.name,
      employeeCode: e.employeeCode,
      designation: e.designation || null,
      hrmsDepartment: e.department || null,
      hrmsTeam: e.team || null,
      hrmsTl: e.tl || null,
      employmentStatus: e.employmentStatus,
      joinedOn: ymd(e.dateOfJoining),
      leftOn: lwd,
      role,
      roleGroup: role === 'STL' ? 'TL' : role,
      roleLabel: ROLE_LABEL[role] || role,
      seats: seatRows,
      structural: seatRows.some((s) => ['TL', 'RECRUITER', 'STL'].includes(s.kind)),
      positionIds: seats.map((x) => x.p.id),
      apps: person.apps,
      moves: person.moves,
    });
  });
  return { at: Date.now(), people: out, byId: new Map(out.map((p) => [p.id, p])) };
}

// Fresh for a minute; after that the last index is served at once while a
// new one is built (a leaver's history changes rarely; the build reads every
// application). ?fresh=1 waits for a new one.
let BUILDING = null;
function rebuild() {
  if (BUILDING) return BUILDING;
  const promise = buildIndex();
  BUILDING = promise;
  promise.then((idx) => { CACHE = { at: Date.now(), idx }; })
    .catch(() => {})
    .finally(() => { if (BUILDING === promise) BUILDING = null; });
  return promise;
}
async function loadIndex({ fresh = false } = {}) {
  if (!fresh && CACHE) {
    if (Date.now() - CACHE.at >= TTL_MS) rebuild();
    return CACHE.idx;
  }
  return rebuild();
}

// ---------------------------------------------------------------------------
// THE VIEWER'S SLICE
// ---------------------------------------------------------------------------
const NOBODY = ['RECRUITER', 'BDE', 'EMPLOYEE', 'CLIENT', 'CANDIDATE', 'ACCOUNTANT', 'NONE'];
function viewerOf(user) {
  const s = atsScopeOf(user);
  if (s.global) return { all: true };
  if (NOBODY.includes(s.atsRole)) return { none: true };
  const departments = [...new Set([...(s.departments || []), ...((s.positions && s.positions.departments) || [])])].filter(Boolean);
  const seatIds = s.positions && s.atsRole === 'TL' ? new Set(s.positions.positionIds) : null;
  if (!departments.length && !seatIds) return { none: true };
  return { departments: new Set(departments), seatIds };
}

// The departments a person worked in, with dates and where each comes from.
function stintsOf(p, viewer) {
  const m = new Map();
  const add = (department, from, to, via) => {
    if (!department) return;
    if (!m.has(department)) m.set(department, { department, from: null, to: null, via: [] });
    const s = m.get(department);
    s.from = minD(s.from, from);
    s.to = maxD(s.to, to);
    if (via && !s.via.includes(via)) s.via.push(via);
  };
  p.seats.forEach((s) => add(s.department, s.from, s.to, `Seat ${s.code}`));
  p.apps.forEach((a) => add(a.department, a.work, a.work, 'Work records'));
  if (p.hrmsDepartment) add(p.hrmsDepartment, p.joinedOn, p.leftOn, 'HRMS');
  let list = [...m.values()];
  if (viewer && !viewer.all) list = list.filter((s) => viewer.departments.has(s.department));
  return list.sort((a, b) => String(a.from || '9999').localeCompare(String(b.from || '9999')) || a.department.localeCompare(b.department));
}

function visible(p, viewer) {
  if (viewer.none) return false;
  if (viewer.all) return true;
  if (viewer.seatIds) {
    if (p.positionIds.some((id) => viewer.seatIds.has(id))) return true;
    // Somebody who sat in another team's seat is that team's.
    const otherTeam = p.seats.some((s) => ['TL', 'RECRUITER', 'STL'].includes(s.kind));
    if (otherTeam) return false;
  }
  return stintsOf(p, viewer).length > 0;
}

const appInView = (a, viewer) => viewer.all || (a.department && viewer.departments.has(a.department));

function totalsOf(apps, moves) {
  const t = { added: 0, moved: moves.length, sent: 0, interviews: 0, selected: 0, joined: 0 };
  apps.forEach((a) => {
    t.added += 1;
    if (a.sent) t.sent += 1;
    if (a.interview) t.interviews += 1;
    if (a.selected) t.selected += 1;
    if (a.joined) t.joined += 1;
  });
  t.jobs = new Set(apps.map((a) => a.requirementId)).size;
  t.candidates = new Set(apps.map((a) => a.candidateId)).size;
  return t;
}

// GET /api/ats/team?view=former — one row per former person in the caller's
// area, with the departments (and dates) they worked in.
async function formerPeopleRows(user, { fresh = false } = {}) {
  const viewer = viewerOf(user);
  if (viewer.none) return { rows: [], allowed: false };
  const idx = await loadIndex({ fresh });
  const rows = idx.people.filter((p) => visible(p, viewer)).map((p) => {
    const stints = stintsOf(p, viewer);
    const apps = p.apps.filter((a) => appInView(a, viewer));
    const moves = p.moves.filter((x) => appInView(x, viewer));
    const t = totalsOf(apps, moves);
    const lastSeat = p.seats[p.seats.length - 1] || null;
    const tls = new Map();
    p.seats.forEach((s) => { if (s.tl) tls.set(s.tl, (tls.get(s.tl) || 0) + 1); });
    const tl = [...tls.keys()].pop() || p.hrmsTl || null;
    return {
      id: p.id,
      employeeId: p.employeeId,
      userId: p.userId,
      name: p.name,
      employeeCode: p.employeeCode,
      designation: p.designation,
      role: p.role,
      roleGroup: p.roleGroup,
      roleLabel: p.roleLabel,
      former: true,
      status: 'Left',
      leftOn: p.leftOn,
      employmentStatus: p.employmentStatus,
      department: (lastSeat && stints.some((s) => s.department === lastSeat.department) && lastSeat.department)
        || (stints[stints.length - 1] || {}).department || null,
      departments: stints.map((s) => s.department),
      stints,
      sections: [...new Set(p.seats.filter((s) => !viewer.departments || viewer.all || viewer.departments.has(s.department)).map((s) => s.team).filter(Boolean))],
      section: lastSeat ? lastSeat.team : null,
      seat: lastSeat ? lastSeat.code : null,
      recruiterCode: lastSeat ? lastSeat.code : null,
      seatLabel: p.seats.map((s) => s.code).join(', ') || null,
      tl,
      replacedBy: lastSeat && lastSeat.next ? lastSeat.next.name : null,
      totals: t,
      requirementsWorked: t.jobs,
      candidatesWorked: t.candidates,
      applicationsWorked: t.added,
      joined: t.joined,
      counts: {},
    };
  });
  rows.sort((a, b) => String(b.leftOn || '').localeCompare(String(a.leftOn || '')) || a.name.localeCompare(b.name));
  return { rows, allowed: true };
}

// GET /api/ats/team/former/:id — one former person's work history.
async function formerPersonHistory(user, id, { fresh = false } = {}) {
  const viewer = viewerOf(user);
  if (viewer.none) return { status: 403, body: { error: 'Former people\'s work history is for team leads, managers and admins.' } };
  const idx = await loadIndex({ fresh });
  const p = idx.byId.get(String(id));
  if (!p) return { status: 404, body: { error: 'This person was not found.' } };
  if (!visible(p, viewer)) return { status: 403, body: { error: 'This person did not work in your area.' } };

  const apps = p.apps.filter((a) => appInView(a, viewer));
  const moves = p.moves.filter((x) => appInView(x, viewer));
  const totals = totalsOf(apps, moves);

  // Month by month.
  const months = new Map();
  const bump = (d, k) => {
    const mo = month(d);
    if (!mo) return;
    if (!months.has(mo)) months.set(mo, { month: mo, added: 0, moved: 0, sent: 0, interviews: 0, selected: 0, joined: 0 });
    months.get(mo)[k] += 1;
  };
  apps.forEach((a) => {
    bump(a.added, 'added');
    if (a.sent) bump(a.sent, 'sent');
    if (a.interview) bump(a.interview, 'interviews');
    if (a.selected) bump(a.selected, 'selected');
    if (a.joined) bump(a.joined, 'joined');
  });
  moves.forEach((x) => bump(x.date, 'moved'));

  // The jobs they worked.
  const jobs = new Map();
  apps.forEach((a) => {
    if (!jobs.has(a.requirementId)) {
      jobs.set(a.requirementId, {
        id: a.requirementId, title: a.title, reqCode: a.reqCode, client: a.client, department: a.department,
        candidates: 0, sent: 0, joined: 0, from: null, to: null,
      });
    }
    const j = jobs.get(a.requirementId);
    j.candidates += 1;
    if (a.sent) j.sent += 1;
    if (a.joined) j.joined += 1;
    j.from = minD(j.from, a.work);
    j.to = maxD(j.to, a.work);
  });

  // Who took over: the seat's next holder; and their work still in process.
  const open = apps.filter((a) => a.open);
  const now = new Map();
  if (open.length) {
    const ids = [...new Set(open.map((a) => a.nowRecruiterId).filter(Boolean))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    open.forEach((a) => {
      const n = a.nowRecruiterId && a.nowRecruiterId !== p.userId ? nameOf.get(a.nowRecruiterId) : null;
      if (n) now.set(n, (now.get(n) || 0) + 1);
    });
  }
  const seats = viewer.all ? p.seats : p.seats.filter((s) => viewer.departments.has(s.department) || (viewer.seatIds && viewer.seatIds.has(s.positionId)));
  const takeover = seats.filter((s) => s.next).map((s) => ({ seat: s.code, name: s.next.name, from: s.next.from, left: s.next.left }));

  const asRole = { RECRUITER: 0, TL: 0, BDE: 0 };
  apps.forEach((a) => a.roles.forEach((r) => { asRole[r] += 1; }));

  return {
    status: 200,
    body: {
      person: {
        id: p.id,
        name: p.name,
        employeeCode: p.employeeCode,
        designation: p.designation,
        role: p.role,
        roleLabel: p.roleLabel,
        hrmsDepartment: p.hrmsDepartment,
        hrmsTeam: p.hrmsTeam,
        employmentStatus: p.employmentStatus,
        joinedOn: p.joinedOn,
        leftOn: p.leftOn,
      },
      partial: !viewer.all,
      seats,
      stints: stintsOf(p, viewer),
      totals,
      asRole,
      months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
      jobs: [...jobs.values()].sort((a, b) => b.candidates - a.candidates || String(b.to || '').localeCompare(String(a.to || ''))),
      takeover,
      openWork: {
        count: open.length,
        nowWith: [...now.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, count: n })),
      },
    },
  };
}

// For other screens (reports): the attribution keys of everyone who has left,
// so a row can carry a "Former" tag. Cheap — HRMS + the login directory only.
async function formerKeys() {
  const [dir, employees] = await Promise.all([
    loadDirectory(),
    prisma.employee.findMany({ select: { id: true, name: true, userId: true, employmentStatus: true } }),
  ]);
  const activeKeys = new Set();
  const out = new Set();
  employees.forEach((e) => {
    const p = dir.person(e.userId, e.name);
    if (!p) return;
    if (hasLeft(e.employmentStatus)) out.add(p.key);
    else activeKeys.add(p.key);
  });
  // A name an active employee also carries is not tagged.
  activeKeys.forEach((k) => out.delete(k));
  return out;
}

function forgetFormerIndex() { CACHE = null; }

module.exports = {
  formerPeopleRows, formerPersonHistory, formerKeys, forgetFormerIndex,
};
