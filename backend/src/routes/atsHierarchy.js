// GET /api/ats/hierarchy
//
// THE DEPENDENT FILTER TREE (spec §7): Department -> Section -> TL -> Recruiter,
// inside the caller's own scope. Read by frontend/src/components/HierarchyFilter.jsx
// on every ATS screen that filters by people.
//
//   departments[]            every department the caller can see (the seat
//                            structure's AND the departments of requirements
//                            in scope, so nothing the old Department picker
//                            offered disappears)
//     sections[]             a department's teams, from the seat structure
//                            (Position.team of the TL seat): Education has
//                            Team A (EDU TL + EDU-1…5) and Team B (EDU-TL +
//                            EDU-6…10); Medical and Manufacturing one each
//       tlSeats / seats      the seat codes ("Recruiter Code") in the section
//       tls[]                everyone who has held the section's TL seat(s)
//       recruiters[]         everyone who has held one of its recruiter seats
//     unplaced               people who worked the department's records but
//                            never sat in one of its structure seats
//                            (imported trackers' names) — still filterable
//
// PEOPLE are exactly the people of GET /api/ats/workers (utils/workers.js
// listWorkers — current AND former, already scoped), and each carries the SAME
// `value` ("id:<userId>" / "name:<name>") that list offers, so a choice made
// here filters every endpoint identically to components/PeopleFilter.jsx.
//
// SCOPE — never wider than the caller's: a TL gets their own team's seats
// (utils/positionScope.js), a recruiter only themselves, an STL their
// departments, Manager / Asst Manager / Admin / Super Admin everything.
// `viewer.levels` says which levels are worth drawing for this login.
//
// Section has no server-side filter parameter of its own; see PARAMS below for
// how a section is expressed with the parameters the list endpoints already
// take (department + tl).
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { requirementWhere, atsScopeOf: scopeOf } = require('../utils/scope');
const { listWorkers } = require('../utils/workers');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
// Outside logins (Client / Candidate) never use this internal surface —
// review #3 access audit; their screens are /api/portal/*.
router.use(require('../utils/permissions').requireInternal);

// The same screens GET /api/ats/workers opens for.
const SCREENS = [
  ['ats', 'requirements', 'Requirement List', 'view'],
  ['ats', 'candidates', 'Candidate List', 'view'],
  ['ats', 'interviews', 'Calendar View', 'view'],
  ['ats', 'recruiterbde', 'Team View', 'view'],
  [null, 'reports', 'ATS Reports', 'view'],
];

// How a choice becomes query parameters on the list endpoints. The frontend
// helpers toParams() / toRequirementParams() implement exactly this.
const PARAMS = {
  department: 'department=<name>',
  section: 'no parameter of its own: department=<name> plus, when no TL / recruiter is chosen, '
    + 'tl=<the section\'s current TL value> (the TL attribution rule of utils/workers.js). '
    + 'Seat codes of the section are in sections[].seats for screens that filter locally.',
  tl: 'tl=id:<userId> | tl=name:<name>   (Requirements list: tlId= / tlName=)',
  recruiter: 'recruiter=id:<userId> | recruiter=name:<name>   (Requirements list: recruiterId= / workedByName=)',
  recruiterCode: 'value "seat:<CODE>" -> positionCode=<CODE>   (work done from that seat, whoever sat in it)',
};

const SAME_DAY_STUB = (a) => a.toDate && a.toDate <= a.fromDate;
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const byCode = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const monthYear = (iso) => (iso
  ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  : '');

// A structure seat: a TL / STL seat, or a recruiter seat that reports to one.
const isStructure = (p) => ['TL', 'STL'].includes(p.kind) || (p.kind === 'RECRUITER' && !!p.reportsToId);

// "Team A" -> "Section A (Team A)" when a department has several sections.
function sectionLabel(team, department, many) {
  if (!many) return `${department} team`;
  const m = /^team[\s-]*([a-z0-9]+)$/i.exec(String(team || '').trim());
  return m ? `Section ${m[1].toUpperCase()} (${team})` : (team || 'No team');
}

async function buildHierarchy(user) {
  const s = scopeOf(user);
  const workers = await listWorkers(user);

  const [positions, scopedReqDepts] = await Promise.all([
    prisma.position.findMany({
      select: {
        id: true, code: true, kind: true, department: true, team: true, active: true, reportsToId: true,
        assignments: {
          select: { employeeId: true, fromDate: true, toDate: true, employee: { select: { name: true, userId: true } } },
          orderBy: { fromDate: 'asc' },
        },
      },
    }),
    prisma.requirement.groupBy({ by: ['department'], where: requirementWhere(user), _count: { _all: true } }),
  ]);
  const posById = new Map(positions.map((p) => [p.id, p]));

  // Which structure seats are in scope — the same rule as listWorkers'.
  const own = s.positions ? new Set(s.positions.positionIds) : null;
  const seatInScope = (p) => {
    if (s.global) return true;
    if (own) return own.has(p.id);
    if (['RECRUITER', 'BDE', 'HR'].includes(s.atsRole)) return false;
    return (s.departments || []).includes(p.department);
  };
  const seats = positions.filter((p) => isStructure(p) && seatInScope(p)
    && (p.active || p.assignments.some((a) => !SAME_DAY_STUB(a))));

  // The TL seat a seat belongs under: itself, or the nearest TL above it.
  const tlSeatOf = (p) => {
    let cur = p;
    for (let i = 0; cur && i < 6; i += 1) {
      if (cur.kind === 'TL') return cur;
      cur = cur.reportsToId ? posById.get(cur.reportsToId) : null;
    }
    return null;
  };

  // People, by employee and by name, from the workers list (same values).
  const indexOf = (list) => {
    const byEmp = new Map();
    const byName = new Map();
    (list || []).forEach((w) => {
      if (w.employeeId && !byEmp.has(w.employeeId)) byEmp.set(w.employeeId, w);
      const k = String(w.name || '').trim().toLowerCase();
      if (k && !byName.has(k)) byName.set(k, w);
    });
    return (emp, empId) => byEmp.get(empId) || byName.get(String((emp && emp.name) || '').trim().toLowerCase()) || null;
  };
  const recruiterOf = indexOf(workers.recruiters);
  const tlOf = indexOf(workers.tls);

  // department -> section key -> section
  const depts = new Map();
  const deptOf = (name) => {
    if (!depts.has(name)) depts.set(name, { id: name, label: name, sections: new Map(), placed: { tls: new Set(), recruiters: new Set() } });
    return depts.get(name);
  };

  // A person entry in a section: the workers-list person + the seats they
  // held IN THIS SECTION (so "left" is about this seat, not the company).
  const addPerson = (bucket, w, seat, tenure) => {
    let e = bucket.get(w.value);
    if (!e) {
      e = {
        value: w.value, name: w.name, userId: w.userId || null, employeeId: w.employeeId || null,
        login: !!w.login, leftCompany: !w.current, seats: [],
      };
      bucket.set(w.value, e);
    }
    e.seats.push({ code: seat.code, from: tenure.fromDate, to: tenure.toDate || null, current: !tenure.toDate && w.current });
  };

  seats.forEach((p) => {
    const tlSeat = tlSeatOf(p);
    if (p.kind === 'STL') return; // an STL seat heads departments, not a section
    const home = tlSeat || p;
    const department = home.department || p.department || 'No department';
    const d = deptOf(department);
    const key = `${department}|${home.team || home.code}`;
    if (!d.sections.has(key)) {
      d.sections.set(key, {
        id: key, team: home.team || null, department, tlSeats: [], seats: [],
        tls: new Map(), recruiters: new Map(),
      });
    }
    const sec = d.sections.get(key);
    if (p.kind === 'TL') sec.tlSeats.push(p.code);
    sec.seats.push(p.code);
    p.assignments.filter((a) => !SAME_DAY_STUB(a)).forEach((a) => {
      // Only the people the workers list offers THIS login (its scope rules:
      // a recruiter sees only themselves, never the seat's other holders).
      if (p.kind === 'TL') {
        const w = tlOf(a.employee, a.employeeId);
        if (w) { addPerson(sec.tls, w, p, a); d.placed.tls.add(w.value); }
      } else {
        const w = recruiterOf(a.employee, a.employeeId);
        if (w) { addPerson(sec.recruiters, w, p, a); d.placed.recruiters.add(w.value); }
      }
    });
  });

  // Departments with requirements in scope but no seat structure (e.g. IT).
  scopedReqDepts.forEach((g) => { if (g.department) deptOf(g.department); });
  // A recruiter's / TL's own department when they have no seat in scope.
  if (!s.global && !depts.size && user && user.atsDepartment) deptOf(user.atsDepartment);

  // People who worked a department's records but never sat in its structure.
  const unplaced = (list, placedKey) => {
    const out = new Map();
    (list || []).forEach((w) => {
      const ds = uniq([w.department, ...(w.departments || [])]);
      ds.forEach((dn) => {
        const d = depts.get(dn);
        if (!d || d.placed[placedKey].has(w.value)) return;
        if (!out.has(dn)) out.set(dn, []);
        out.get(dn).push(w);
      });
    });
    return out;
  };
  const looseRecruiters = unplaced(workers.recruiters, 'recruiters');
  const looseTls = unplaced(workers.tls, 'tls');

  const personOut = (e) => {
    const cur = e.seats.filter((x) => x.current);
    const last = [...e.seats].sort((a, b) => String(a.from).localeCompare(String(b.from))).pop();
    const shown = cur[cur.length - 1] || last;
    const current = cur.length > 0;
    return {
      value: e.value,
      name: e.name,
      userId: e.userId,
      employeeId: e.employeeId,
      seat: shown ? shown.code : null,
      current,
      leftOn: current ? null : (last && last.to) || null,
      label: [e.name, shown && shown.code, current ? '' : `left${last && last.to ? ` ${monthYear(last.to)}` : ''}`].filter(Boolean).join(' · '),
      seats: e.seats.sort((a, b) => String(a.from).localeCompare(String(b.from))),
    };
  };
  const looseOut = (w) => ({
    value: w.value,
    name: w.name,
    userId: w.userId || null,
    employeeId: w.employeeId || null,
    seat: w.currentSeat || w.seat || null,
    current: !!w.current,
    leftOn: w.current ? null : (w.to || null),
    label: [w.name, w.currentSeat || w.seat, w.current ? '' : `left${w.to ? ` ${monthYear(w.to)}` : ''}`].filter(Boolean).join(' · '),
    seats: [],
  });
  const ordered = (list) => [...list.filter((x) => x.current), ...list.filter((x) => !x.current)];
  const byName = (a, b) => a.name.localeCompare(b.name);

  const departments = [...depts.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((d) => {
      const secs = [...d.sections.values()].sort((a, b) => String(a.team || '').localeCompare(String(b.team || '')));
      const many = secs.length > 1;
      return {
        id: d.id,
        // §38: purely a display label. The data value (id) stays "Manufacturing".
        label: /^manufacturing$/i.test(d.id) ? 'Manufacturing (Non-IT)' : d.label,
        sections: secs.map((sec) => {
          const tls = [...sec.tls.values()].map(personOut).sort(byName);
          const recs = [...sec.recruiters.values()].map(personOut).sort(byName);
          const currentTl = tls.find((t) => t.current) || null;
          return {
            id: sec.id,
            department: d.id,
            label: sectionLabel(sec.team, d.label, many),
            team: sec.team,
            tlSeats: sec.tlSeats.sort(byCode),
            seats: sec.seats.sort(byCode),
            currentTl: currentTl ? currentTl.value : null,
            tls: ordered(tls),
            recruiters: ordered(recs),
          };
        }),
        unplaced: {
          tls: ordered((looseTls.get(d.id) || []).map(looseOut).sort(byName)),
          recruiters: ordered((looseRecruiters.get(d.id) || []).map(looseOut).sort(byName)),
        },
      };
    });

  // People with no department — or only departments with no ATS work in
  // scope (a BDE desk) — stay reachable when nothing is chosen.
  const noDept = (list) => ordered((list || [])
    .filter((w) => !uniq([w.department, ...(w.departments || [])]).some((dn) => depts.has(dn)))
    .map(looseOut));

  const role = s.atsRole;
  const isRecruiter = !s.global && role === 'RECRUITER';
  const isTl = !s.global && role === 'TL';
  const levels = {
    department: !isRecruiter && departments.length > 1,
    section: !isRecruiter && !isTl && departments.some((d) => d.sections.length > 1),
    tl: !isRecruiter && !isTl && departments.some((d) => d.sections.some((x) => x.tls.length) || d.unplaced.tls.length),
    recruiter: !isRecruiter && workers.viewer.personFilters !== false,
  };

  return {
    viewer: {
      userId: s.userId,
      atsRole: role,
      global: !!s.global,
      label: s.positions ? s.positions.label : null,
      levels,
    },
    departments,
    noDepartment: { tls: noDept(workers.tls), recruiters: noDept(workers.recruiters) },
    params: PARAMS,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const allowed = await Promise.all(SCREENS.map((p) => can(req.user, ...p)));
    if (!allowed.some(Boolean)) {
      return res.status(403).json({ error: "This list isn't included in your role's permissions" });
    }
    return res.json(await buildHierarchy(req.user));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.buildHierarchy = buildHierarchy;
