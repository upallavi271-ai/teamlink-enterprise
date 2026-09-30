// ---------------------------------------------------------------------------
// WORKERS — everyone who worked ATS records, current and former, and WHICH
// records are theirs. Defined once, here, and read by every ATS person filter:
//
//   GET /api/ats/workers            the Recruiter / TL / BDE filter lists
//   GET /api/requirements/workers   the older Requirements-only shape
//   Candidates, Interview Calendar, Recruiter & BDE (Show former), ATS
//   Reports — "filter by this person" means the SAME thing on all of them.
//
// A PERSON is a login (u:<userId>) or, for somebody who never had one or has
// left, a name (n:<lower-cased name>). A name that matches a login IS that
// login, so one person is never two options. The values the screens send:
//   id:<userId>   a person who can sign in today in that role
//   name:<name>   anyone else — a recruiter who has left, whose work came in
//                 with a tracker and is attributed by name
// Both are accepted everywhere (and the ATS Reports' own u:/n: keys too).
//
// ATTRIBUTION — whose record an application is. One rule, used by the list
// filters AND the reports, so a filtered list and a report figure agree:
//   Recruiter  the owner on its follow-up record (imported trackers carry the
//              recruiter, seat and TL there — including people who have left)
//              → otherwise the requirement's recruiter
//              → otherwise the last real person with a Recruiter role who
//                moved it (stage events; the importers' placeholder actors
//                "Imported — …" are not people)
//   Seat       the seat stamped on that same record (follow-up / stage event),
//              otherwise the requirement's own seat
//   TL         the TL on its follow-up record → the requirement's TL → a TL
//              who moved it
//   BDE        the requirement's BDE → the BDE on its follow-up → a BDE who
//              moved it
//
// SEATS come from PositionAssignment (Position.kind TL / RECRUITER; BDE seats
// by their code). A same-day tenure is a data-entry stub and was never held.
//
// SCOPE — the lists are built from records inside the caller's scope
// (utils/scope.js applicationWhere / requirementWhere) plus the seats and
// logins of their own team: a TL sees their team's people (current and
// former holders of their seats), a recruiter sees only themselves, Super
// Admin / Admin / Manager everyone.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  applicationWhere, requirementWhere, clientWhere, scopeOf,
} = require('./scope');

const ROLES = ['RECRUITER', 'TL', 'BDE'];
const ROLE_LABEL = { RECRUITER: 'Recruiter', TL: 'TL', BDE: 'BDE' };
const LIST_OF = { RECRUITER: 'recruiters', TL: 'tls', BDE: 'bdes' };
const LEFT_STATUSES = ['Relieved', 'Exited', 'Exit Process'];

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const nameKey = (v) => clean(v).toLowerCase();
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
// The importers wrote "Imported — Medical tracker" etc. as the actor of the
// stage moves they created. That is a process, not a person.
const isPlaceholderName = (n) => {
  const k = nameKey(n);
  return !k || k.startsWith('imported') || k === 'system';
};
// A same-day tenure is a stub (a seat typed in and corrected the same day).
const realTenure = (a) => !(a.toDate && a.toDate <= a.fromDate);

function roleOfLabel(r) {
  const k = String(r || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (k === 'RECRUITER') return 'RECRUITER';
  if (k === 'TL' || k === 'TEAM_LEAD') return 'TL';
  if (k === 'BDE') return 'BDE';
  return null;
}

// Which list a seat's holders belong on. Position.kind decides (TL /
// RECRUITER); BDE seats are recorded as OTHER and are known by their code.
// With no kind recorded, the code pattern (…-TL = TL) stands in.
function seatRole(p) {
  if (!p) return null;
  if (p.kind === 'TL') return 'TL';
  if (p.kind === 'RECRUITER') return 'RECRUITER';
  if (p.kind === 'STL') return null;
  const code = String(p.code || '');
  if (/\bBDE\b/i.test(code) || /^bde$/i.test(clean(p.department))) return 'BDE';
  if (p.kind === undefined || p.kind === null) return /-\s*TL$/i.test(code) ? 'TL' : 'RECRUITER';
  return null;
}

// Stage events that were made by a person (not an importer).
const REAL_EVENT = {
  OR: [
    { actorUserId: { not: null } },
    { AND: [{ actorName: { not: null } }, { NOT: { actorName: { startsWith: 'Imported' } } }, { NOT: { actorName: 'System' } }] },
  ],
};
const realActor = (e) => !!e.actorUserId || !isPlaceholderName(e.actorName);

// --- People directory ---------------------------------------------------------
// Resolves (userId, name) to ONE person, the way ATS Reports always has.
function makeResolver(users) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const byName = new Map();
  users.forEach((u) => { const k = nameKey(u.name); if (k && !byName.has(k)) byName.set(k, u); });
  const asPerson = (u) => ({ key: `u:${u.id}`, userId: u.id, label: u.name, team: u.team || null });
  const person = (id, name) => {
    if (id && byId.has(id)) return asPerson(byId.get(id));
    const u = byName.get(nameKey(name));
    if (u) return asPerson(u);
    return clean(name) ? { key: `n:${nameKey(name)}`, userId: null, label: clean(name), team: null } : null;
  };
  person.userById = byId;
  person.userByName = byName;
  return person;
}

async function loadDirectory() {
  const [users, employees] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true, name: true, team: true, status: true, atsRole: true, atsAccess: true,
        atsDepartment: true, atsScopeDepartments: true, atsScopeClients: true,
      },
    }),
    prisma.employee.findMany({
      select: { id: true, name: true, userId: true, department: true, employmentStatus: true },
    }),
  ]);
  const person = makeResolver(users);
  const empByUser = new Map();
  const empByName = new Map();
  employees.forEach((e) => {
    if (e.userId) empByUser.set(e.userId, e);
    const k = nameKey(e.name);
    if (k && !empByName.has(k)) empByName.set(k, e);
  });
  const empById = new Map(employees.map((e) => [e.id, e]));
  return { users, employees, person, empByUser, empByName, empById };
}

// Every spelling on file that is this name (case / spacing), so an exact
// SQL match finds all of them — SQLite compares text case-sensitively.
async function nameVariantsFor(keys) {
  const want = new Set(keys.map(nameKey).filter(Boolean));
  if (!want.size) return [];
  const [o, t, b, rt, ev] = await Promise.all([
    prisma.applicationFollowUp.groupBy({ by: ['ownerName'], where: { ownerName: { not: null } }, _count: { _all: true } }),
    prisma.applicationFollowUp.groupBy({ by: ['tlName'], where: { tlName: { not: null } }, _count: { _all: true } }),
    prisma.applicationFollowUp.groupBy({ by: ['bdeName'], where: { bdeName: { not: null } }, _count: { _all: true } }),
    prisma.requirement.groupBy({ by: ['tl'], where: { tl: { not: null } }, _count: { _all: true } }),
    prisma.applicationStageEvent.groupBy({ by: ['actorName'], where: REAL_EVENT, _count: { _all: true } }),
  ]);
  const out = new Set();
  const take = (v) => { if (v && want.has(nameKey(v))) out.add(v); };
  o.forEach((g) => take(g.ownerName));
  t.forEach((g) => take(g.tlName));
  b.forEach((g) => take(g.bdeName));
  rt.forEach((g) => take(g.tl));
  ev.forEach((g) => take(g.actorName));
  return [...out];
}

// "id:…" / "name:…" (and the reports' "u:…" / "n:…", and a bare id or name)
// -> { key, userId, label, names[] }.
async function resolvePersonValue(value, dir) {
  const v = clean(value);
  if (!v) return null;
  const d = dir || await loadDirectory();
  let p = null;
  const rest = v.slice(v.indexOf(':') + 1);
  if (v.startsWith('id:') || v.startsWith('u:')) {
    const u = d.person.userById.get(rest);
    p = u ? d.person(u.id) : { key: `u:${rest}`, userId: rest, label: rest };
  } else if (v.startsWith('name:') || v.startsWith('n:')) {
    p = d.person(null, rest);
  } else {
    p = d.person.userById.has(v) ? d.person(v) : d.person(null, v);
  }
  if (!p) return null;
  p.names = await nameVariantsFor([p.label]);
  if (p.label && !p.names.includes(p.label)) p.names.push(p.label);
  return p;
}

// --- Attribution ----------------------------------------------------------------
const lastOf = (rows, pred) => {
  for (let i = (rows || []).length - 1; i >= 0; i -= 1) if (pred(rows[i])) return rows[i];
  return null;
};

// fus / evs oldest first. `person` from makeResolver().
function attribute(req, fus, evs, person) {
  const r = req || {};
  const evOf = (role) => lastOf(evs, (e) => roleOfLabel(e.actorRole) === role && realActor(e));
  let recruiter = null;
  let seat = null;
  const ownerFu = lastOf(fus, (x) => x.ownerName || x.ownerUserId);
  if (ownerFu) {
    recruiter = person(ownerFu.ownerUserId, ownerFu.ownerName);
    seat = clean(ownerFu.ownerPositionCode) || r.positionCode || null;
  }
  if (!recruiter && r.recruiterId) {
    recruiter = person(r.recruiterId);
    seat = r.positionCode || null;
  }
  if (!recruiter) {
    const e = evOf('RECRUITER');
    if (e) {
      recruiter = person(e.actorUserId, e.actorName);
      seat = clean(e.actorPositionCode) || r.positionCode || null;
    }
  }
  const tlFu = lastOf(fus, (x) => x.tlName || x.tlUserId);
  let tl = tlFu ? person(tlFu.tlUserId, tlFu.tlName) : null;
  if (!tl && (r.tlId || r.tl)) tl = person(r.tlId, r.tl);
  if (!tl) { const e = evOf('TL'); if (e) tl = person(e.actorUserId, e.actorName); }
  let bde = r.bdeId ? person(r.bdeId) : null;
  if (!bde) { const b = lastOf(fus, (x) => x.bdeName || x.bdeUserId); if (b) bde = person(b.bdeUserId, b.bdeName); }
  if (!bde) { const e = evOf('BDE'); if (e) bde = person(e.actorUserId, e.actorName); }
  return { recruiter, seat, tl, bde };
}

// A Prisma `where` on Application that is a SUPERSET of "attributed to this
// person in this role" — the exact match is attribute() over what it finds.
function attributionWhere(role, p) {
  if (!p) return { id: '__none__' };
  const names = p.names || [];
  const id = (field) => (p.userId ? [{ [field]: p.userId }] : []);
  const nm = (field) => (names.length ? [{ [field]: { in: names } }] : []);
  const arms = [];
  const fu = (idField, nameField) => {
    const or = [...id(idField), ...nm(nameField)];
    if (or.length) arms.push({ followUps: { some: { OR: or } } });
  };
  if (role === 'RECRUITER') {
    fu('ownerUserId', 'ownerName');
    if (p.userId) arms.push({ requirement: { is: { recruiterId: p.userId } } });
  } else if (role === 'TL') {
    fu('tlUserId', 'tlName');
    const or = [...id('tlId'), ...nm('tl')];
    if (or.length) arms.push({ requirement: { is: { OR: or } } });
  } else if (role === 'BDE') {
    if (p.userId) arms.push({ requirement: { is: { bdeId: p.userId } } });
    fu('bdeUserId', 'bdeName');
  }
  const ev = [...id('actorUserId'), ...nm('actorName')];
  if (ev.length) arms.push({ stageEvents: { some: { OR: ev } } });
  return arms.length ? { OR: arms } : { id: '__none__' };
}

// A seat filter may name several seats, comma-separated ("EDU TL,EDU-1,EDU-2")
// — a Section of the hierarchy filter (routes/atsHierarchy.js). One code
// behaves exactly as before.
const seatCodes = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// Superset of "attributed to this seat" (or to any of these seats).
function seatWhere(code) {
  const codes = seatCodes(code);
  const eq = codes.length > 1 ? { in: codes } : (codes[0] || code);
  return {
    OR: [
      { followUps: { some: { ownerPositionCode: eq } } },
      { requirement: { is: { positionCode: eq } } },
      { stageEvents: { some: { actorPositionCode: eq } } },
    ],
  };
}

const ATTR_SELECT = {
  id: true,
  candidateId: true,
  requirementId: true,
  stage: true,
  requirement: {
    select: { recruiterId: true, tlId: true, tl: true, bdeId: true, positionCode: true, department: true },
  },
  followUps: {
    select: {
      ownerUserId: true, ownerName: true, ownerPositionCode: true, tlUserId: true, tlName: true,
      bdeUserId: true, bdeName: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
  stageEvents: {
    where: REAL_EVENT,
    select: { actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
};

// The person / seat filters a request carries, in either spelling:
//   recruiter= tl= bde= (id:… / name:…)  positionCode=
//   recruiterId= workedByName= tlId= tlName= bdeId= bdeName= (Requirements')
function personQuery(q = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const pick = (value, idKey, nameKey2) => s(value) || (s(q[idKey]) ? `id:${s(q[idKey])}` : '') || (s(q[nameKey2]) ? `name:${s(q[nameKey2])}` : '');
  return {
    RECRUITER: pick(q.recruiter, 'recruiterId', 'workedByName'),
    TL: pick(q.tl, 'tlId', 'tlName'),
    BDE: pick(q.bde, 'bdeId', 'bdeName'),
    positionCode: s(q.positionCode) || s(q.seat),
  };
}
const hasPersonQuery = (q) => { const p = personQuery(q); return !!(p.RECRUITER || p.TL || p.BDE || p.positionCode); };

// The applications inside `scope` (default: the caller's applicationWhere)
// attributed to the person(s) / seat the query names. null = no such filter.
// Returns { ids:Set<appId>, apps:[{id,candidateId,requirementId,stage}] }.
async function attributedApplications(user, q, { scope, dir } = {}) {
  const want = personQuery(q);
  const roles = ROLES.filter((r) => want[r]);
  if (!roles.length && !want.positionCode) return null;
  const d = dir || await loadDirectory();
  const people = {};
  for (const role of roles) {
    // eslint-disable-next-line no-await-in-loop
    people[role] = await resolvePersonValue(want[role], d);
  }
  const and = [scope || applicationWhere(user)];
  roles.forEach((role) => and.push(attributionWhere(role, people[role])));
  if (want.positionCode) and.push(seatWhere(want.positionCode));
  const rows = await prisma.application.findMany({ where: { AND: and }, select: ATTR_SELECT });
  const field = { RECRUITER: 'recruiter', TL: 'tl', BDE: 'bde' };
  const apps = rows.filter((a) => {
    const at = attribute(a.requirement, a.followUps, a.stageEvents, d.person);
    if (!roles.every((role) => at[field[role]] && people[role] && at[field[role]].key === people[role].key)) return false;
    if (want.positionCode && !seatCodes(want.positionCode).includes(at.seat)) return false;
    return true;
  }).map((a) => ({ id: a.id, candidateId: a.candidateId, requirementId: a.requirementId, stage: a.stage }));
  return { ids: new Set(apps.map((a) => a.id)), apps, people };
}

// Historical counts per person (Recruiter & BDE "Show former"): the
// applications attributed to each, within the caller's scope.
async function attributedCounts(user, role, persons, { dir } = {}) {
  const d = dir || await loadDirectory();
  const field = { RECRUITER: 'recruiter', TL: 'tl', BDE: 'bde' }[role];
  const resolved = [];
  for (const w of persons) {
    // eslint-disable-next-line no-await-in-loop
    const p = await resolvePersonValue(w.value, d);
    if (p) resolved.push(p);
  }
  const out = new Map();
  if (!resolved.length) return out;
  const rows = await prisma.application.findMany({
    where: { AND: [applicationWhere(user), { OR: resolved.map((p) => attributionWhere(role, p)) }] },
    select: ATTR_SELECT,
  });
  const keys = new Set(resolved.map((p) => p.key));
  rows.forEach((a) => {
    const at = attribute(a.requirement, a.followUps, a.stageEvents, d.person);
    const who = at[field];
    if (!who || !keys.has(who.key)) return;
    if (!out.has(who.key)) out.set(who.key, { applications: 0, requirements: new Set(), joined: 0, candidates: new Set(), tls: new Map() });
    const c = out.get(who.key);
    c.applications += 1;
    c.requirements.add(a.requirementId);
    c.candidates.add(a.candidateId);
    if (['JOINED', 'HIRED'].includes(a.stage)) c.joined += 1;
    if (at.tl && at.tl.label) c.tls.set(at.tl.label, (c.tls.get(at.tl.label) || 0) + 1);
  });
  // The TL they worked under most — what a TL filter matches a former row on.
  out.forEach((c) => { c.tl = [...c.tls.entries()].sort((x, y) => y[1] - x[1]).map(([label]) => label)[0] || null; });
  return out;
}

// --- The lists --------------------------------------------------------------------
async function listWorkers(user, { department = '', role = '' } = {}) {
  const s = scopeOf(user);
  const empty = {
    recruiters: [], tls: [], bdes: [], positions: [],
    viewer: { userId: s.userId, atsRole: s.atsRole, personFilters: false },
  };
  if (!s.global && ['CLIENT', 'CANDIDATE', 'EMPLOYEE', 'ACCOUNTANT'].includes(s.atsRole)) return empty;

  const appScope = applicationWhere(user);
  const reqScope = requirementWhere(user);
  const [d, fus, evs, reqs, positions] = await Promise.all([
    loadDirectory(),
    prisma.applicationFollowUp.findMany({
      where: {
        application: { is: appScope },
        OR: [
          { ownerName: { not: null } }, { ownerUserId: { not: null } },
          { tlName: { not: null } }, { tlUserId: { not: null } },
          { bdeName: { not: null } }, { bdeUserId: { not: null } },
        ],
      },
      select: {
        ownerUserId: true, ownerName: true, ownerRole: true, tlUserId: true, tlName: true,
        bdeUserId: true, bdeName: true,
        application: { select: { requirement: { select: { department: true } } } },
      },
    }),
    prisma.applicationStageEvent.findMany({
      where: { AND: [{ application: { is: appScope } }, REAL_EVENT, { actorRole: { not: null } }] },
      select: {
        actorUserId: true, actorName: true, actorRole: true,
        application: { select: { requirement: { select: { department: true } } } },
      },
    }),
    prisma.requirement.findMany({
      where: {
        AND: [reqScope, {
          OR: [
            { recruiterId: { not: null } }, { recruiterIds: { not: null } }, { tlId: { not: null } },
            { tl: { not: null } }, { bdeId: { not: null } },
          ],
        }],
      },
      select: { recruiterId: true, recruiterIds: true, tlId: true, tl: true, bdeId: true, department: true },
    }),
    prisma.position.findMany({
      include: { assignments: { select: { employeeId: true, fromDate: true, toDate: true }, orderBy: { fromDate: 'asc' } } },
    }),
  ]);

  const reg = new Map();
  const touch = (listRole, p, { dept, variant, n = 1 } = {}) => {
    if (!p || !ROLES.includes(listRole)) return null;
    let rec = reg.get(p.key);
    if (!rec) {
      rec = { key: p.key, userId: p.userId || null, name: p.label, roles: new Map(), departments: new Set(), loginRole: null };
      reg.set(p.key, rec);
    }
    let r = rec.roles.get(listRole);
    if (!r) { r = { count: 0, names: new Map() }; rec.roles.set(listRole, r); }
    r.count += n;
    const v = clean(variant);
    if (v) r.names.set(v, (r.names.get(v) || 0) + Math.max(n, 1));
    if (dept) rec.departments.add(dept);
    return rec;
  };
  const deptOf = (x) => x.application && x.application.requirement && x.application.requirement.department;

  // 1. Work in scope.
  fus.forEach((f) => {
    const dept = deptOf(f);
    if (f.ownerName || f.ownerUserId) {
      const role0 = roleOfLabel(f.ownerRole);
      touch(role0 === 'TL' || role0 === 'BDE' ? role0 : 'RECRUITER', d.person(f.ownerUserId, f.ownerName), { dept, variant: f.ownerName });
    }
    if (f.tlName || f.tlUserId) touch('TL', d.person(f.tlUserId, f.tlName), { dept, variant: f.tlName });
    if (f.bdeName || f.bdeUserId) touch('BDE', d.person(f.bdeUserId, f.bdeName), { dept, variant: f.bdeName });
  });
  evs.forEach((e) => {
    const r = roleOfLabel(e.actorRole);
    if (r && realActor(e)) touch(r, d.person(e.actorUserId, e.actorName), { dept: deptOf(e), variant: e.actorName });
  });
  reqs.forEach((r) => {
    if (r.recruiterId) touch('RECRUITER', d.person(r.recruiterId), { dept: r.department });
    csv(r.recruiterIds).forEach((id) => touch('RECRUITER', d.person(id), { dept: r.department }));
    if (r.tlId || r.tl) touch('TL', d.person(r.tlId, r.tl), { dept: r.department, variant: r.tl });
    if (r.bdeId) touch('BDE', d.person(r.bdeId), { dept: r.department });
  });

  // 2. Seats in scope — their current AND former holders.
  const posScope = s.positions ? new Set(s.positions.positionIds) : null;
  const seatInScope = (p) => {
    if (s.global) return true;
    if (posScope) return posScope.has(p.id);
    if (['RECRUITER', 'BDE', 'HR'].includes(s.atsRole)) return false;
    return s.departments.includes(p.department);
  };
  const empPerson = (e) => (e.userId && d.person.userById.has(e.userId) ? d.person(e.userId) : d.person(null, e.name));
  positions.forEach((p) => {
    const r = seatRole(p);
    if (!r || !seatInScope(p)) return;
    p.assignments.filter(realTenure).forEach((a) => {
      const e = d.empById.get(a.employeeId);
      if (e) touch(r, empPerson(e), { dept: /^bde$/i.test(clean(p.department)) ? null : p.department, n: 0 });
    });
  });

  // 3. Logins in scope (a recruiter with no work yet is still a recruiter).
  let bdeClientIds = null;
  if (!s.global && ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole)) {
    const clients = await prisma.client.findMany({ where: clientWhere(user), select: { id: true } });
    bdeClientIds = clients.map((c) => c.id);
  }
  const loginInScope = (u) => {
    if (u.id === s.userId) return true;
    if (s.global) return true;
    if (!['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole)) return false;
    if (u.atsRole === 'BDE' && bdeClientIds && csv(u.atsScopeClients).some((c) => bdeClientIds.includes(c))) return true;
    if (s.positions) return s.positions.holderUserIds.includes(u.id);
    if (s.atsRole === 'TL' && s.teamUserIds) return s.teamUserIds.includes(u.id);
    return [u.atsDepartment, ...csv(u.atsScopeDepartments)].some((x) => x && s.departments.includes(x));
  };
  d.users.forEach((u) => {
    if (u.status !== 'Active' || !u.atsAccess || !ROLES.includes(u.atsRole) || !loginInScope(u)) return;
    const rec = touch(u.atsRole, d.person(u.id), { dept: u.atsDepartment, n: 0 });
    if (rec) rec.loginRole = u.atsRole;
  });

  // Seats of every employee, for labels and "left".
  const posById = new Map(positions.map((p) => [p.id, p]));
  const tenuresByEmp = new Map();
  positions.forEach((p) => p.assignments.forEach((a) => {
    if (!realTenure(a)) return;
    if (!tenuresByEmp.has(a.employeeId)) tenuresByEmp.set(a.employeeId, []);
    tenuresByEmp.get(a.employeeId).push({ ...a, positionId: p.id });
  }));
  const holdersOf = (positionId) => (posById.get(positionId)?.assignments || []).filter(realTenure);

  // Scope rules for the PEOPLE themselves.
  const structureSeat = (p) => p && ['TL', 'RECRUITER'].includes(p.kind) && (p.kind !== 'RECRUITER' || !!p.reportsToId);
  const isSelf = (rec) => rec.userId && rec.userId === s.userId;

  const out = { recruiters: [], tls: [], bdes: [] };
  reg.forEach((rec) => {
    if (!s.global && s.atsRole === 'RECRUITER' && !isSelf(rec)) return;
    const u = rec.userId ? d.person.userById.get(rec.userId) : null;
    const e = (rec.userId && d.empByUser.get(rec.userId)) || d.empByName.get(nameKey(rec.name)) || null;
    const seats = (e ? tenuresByEmp.get(e.id) || [] : [])
      .map((a) => ({ ...a, position: posById.get(a.positionId) }))
      .sort((a, b) => String(a.fromDate).localeCompare(String(b.fromDate)));
    // A TL / STL scoped by seats sees their team: somebody whose structure
    // seats all sit in another team is not on their lists.
    if (posScope && !isSelf(rec)) {
      const structural = seats.filter((a) => structureSeat(a.position));
      if (structural.length && !structural.some((a) => posScope.has(a.positionId))) return;
    }
    const left = (e ? LEFT_STATUSES.includes(e.employmentStatus) : false) || (u ? u.status !== 'Active' && !e : false);
    const open = seats.filter((a) => !a.toDate);
    const last = open[open.length - 1] || seats[seats.length - 1] || null;
    const departments = new Set(rec.departments);
    if (u && u.atsDepartment) departments.add(u.atsDepartment);
    if (e && e.department) departments.add(e.department);
    seats.forEach((a) => { if (a.position && a.position.department && !/^bde$/i.test(a.position.department)) departments.add(a.position.department); });

    rec.roles.forEach((r, listRole) => {
      const login = rec.loginRole === listRole;
      const current = login || (!!last && !last.toDate && !left);
      // The spelling the work is recorded under, for the name: value.
      const variant = [...r.names.entries()].sort((a, b) => b[1] - a[1])[0];
      let replacedBy = null;
      if (!current && last) {
        const next = holdersOf(last.positionId).find((a) => a.fromDate > last.fromDate && a.employeeId !== last.employeeId);
        if (next) replacedBy = (d.empById.get(next.employeeId) || {}).name || null;
      }
      out[LIST_OF[listRole]].push({
        key: rec.key,
        value: login ? `id:${rec.userId}` : `name:${variant ? variant[0] : rec.name}`,
        name: u ? u.name : (e ? e.name : rec.name),
        userId: rec.userId,
        employeeId: e ? e.id : null,
        role: listRole,
        roleLabel: ROLE_LABEL[listRole],
        login,
        department: (u && u.atsDepartment) || (e && e.department) || (last && last.position && last.position.department) || [...departments][0] || null,
        departments: [...departments].sort(),
        seat: last && last.position ? last.position.code : null,
        currentSeat: current && last && !last.toDate && last.position ? last.position.code : null,
        seats: seats.map((a) => ({
          code: a.position ? a.position.code : null,
          kind: a.position ? a.position.kind : null,
          department: a.position ? a.position.department : null,
          from: a.fromDate,
          to: a.toDate || null,
        })),
        from: last ? last.fromDate : null,
        to: last ? last.toDate || null : null,
        current,
        left: !current,
        leftOn: !current && last ? last.toDate || null : null,
        replacedBy,
        count: r.count,
      });
    });
  });
  const order = (a, b) => (b.current - a.current) || a.name.localeCompare(b.name);
  Object.values(out).forEach((list) => list.sort(order));

  // The seats in scope, for the Position filter: "MED-3 · 4 people".
  const posOut = positions
    .filter((p) => ROLES.includes(seatRole(p)) && seatInScope(p))
    .map((p) => {
      const tenures = p.assignments.filter(realTenure);
      const holder = tenures.filter((a) => !a.toDate).pop();
      const holderEmp = holder ? d.empById.get(holder.employeeId) : null;
      return {
        code: p.code,
        name: p.name,
        kind: p.kind || null,
        role: seatRole(p),
        department: p.department,
        team: p.team || null,
        active: p.active,
        people: new Set(tenures.map((a) => a.employeeId)).size,
        holderName: holderEmp ? holderEmp.name : null,
        holderUserId: holderEmp ? holderEmp.userId : null,
      };
    })
    .filter((p) => p.people > 0 || p.active)
    .filter((p) => s.global || !['RECRUITER', 'BDE'].includes(s.atsRole) || p.holderUserId === s.userId)
    .sort((a, b) => String(a.department || '').localeCompare(String(b.department || ''))
      || a.code.localeCompare(b.code, undefined, { numeric: true }));

  const inDept = (w) => !department || w.department === department || (w.departments || []).includes(department);
  const result = {
    recruiters: out.recruiters.filter(inDept),
    tls: out.tls.filter(inDept),
    bdes: out.bdes.filter(inDept),
    positions: posOut.filter((p) => !department || p.department === department),
    viewer: {
      userId: s.userId,
      atsRole: s.atsRole,
      // A recruiter's own work is all they see; a person filter would offer
      // only themselves.
      personFilters: s.global || !['RECRUITER'].includes(s.atsRole),
    },
  };
  if (role) {
    const k = LIST_OF[String(role).toUpperCase()];
    ['recruiters', 'tls', 'bdes'].forEach((x) => { if (x !== k) delete result[x]; });
  }
  return result;
}

module.exports = {
  ROLES, ROLE_LABEL, LEFT_STATUSES, REAL_EVENT, ATTR_SELECT,
  clean, nameKey, seatRole, roleOfLabel, realActor,
  makeResolver, loadDirectory, resolvePersonValue, nameVariantsFor,
  attribute, attributionWhere, seatWhere, seatCodes, personQuery, hasPersonQuery,
  attributedApplications, attributedCounts, listWorkers,
};
