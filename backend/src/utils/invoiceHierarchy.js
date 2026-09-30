// ---------------------------------------------------------------------------
// INVOICE HIERARCHY — who an invoice belongs to inside the organisation, for
// the Accounts -> Invoice cascading filter:
//
//   Department -> Section -> TL + recruiters -> Candidate -> Client -> Joining -> Invoice
//
// THE HIERARCHY is the stored POSITION STRUCTURE (the same one
// utils/positionScope.js scopes the ATS with): Position.kind TL / RECRUITER,
// Position.team, Position.reportsToId, and PositionAssignment for who held
// each seat between which dates. A "section" is a Position.team:
//   Education   Team A -> "Section A" (EDU TL + EDU-1…5)
//               Team B -> "Section B" (EDU-TL + EDU-6…10)
//   Medical     its single team (MED-TL + MED-1…5)
//   Manufacturing (the older sheets' "Non-IT") its single team (MFG-TL + MFG-1…5)
// People are EMPLOYEES (one person = one Employee), current AND former holders
// of those seats — invoices come from past work too. A person who held two
// seats (a recruiter who became a TL) is still ONE person with two entries.
//
// ATTRIBUTION is utils/workers.js attribute() — the one rule every ATS person
// filter and report uses — applied to the application behind the invoice
// (candidate + requirement, else the candidate's application at the invoice's
// client). Recruiter + seat + TL come from it; the seat gives the section and
// department. A person is matched to an Employee by login id, else by the
// name the tracker recorded (that is how imported work is attributed). The
// screen filters on the resulting EMPLOYEE KEY ("e:<employeeId>"), never on
// name text.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  loadDirectory, attribute, clean, nameKey, ATTR_SELECT, LEFT_STATUSES,
} = require('./workers');

const TEAM_KINDS = ['TL', 'RECRUITER'];
const realTenure = (a) => !(a.toDate && a.toDate <= a.fromDate);
const today = () => new Date().toISOString().slice(0, 10);

// The department's real name stays; the older sheets' word rides along.
const DEPT_ALIAS = { Manufacturing: 'Non-IT' };
const deptLabel = (d) => (DEPT_ALIAS[d] ? `${d} (${DEPT_ALIAS[d]})` : d);
const sectionKeyOf = (dept, team) => `${dept}|${team}`;
function sectionLabelOf(dept, team, teamsInDept) {
  const m = /^team\s+([a-z0-9]+)$/i.exec(clean(team));
  if (m) return `Section ${m[1].toUpperCase()}`;
  return teamsInDept > 1 ? clean(team) : `${dept} team`;
}

// What an application needs selected for attribute() — spread into a
// Prisma `select` (the requirement's own fields are merged by the caller).
const APP_ATTR_SELECT = { followUps: ATTR_SELECT.followUps, stageEvents: ATTR_SELECT.stageEvents };
const REQ_ATTR_SELECT = ATTR_SELECT.requirement.select;

// The follow-ups and stage moves attribute() reads, for many applications.
// Chunked: SQLite's parameter limit cannot split a nested read that carries
// the NOT filters of workers.js REAL_EVENT.
async function attributionData(appIds) {
  const ids = [...new Set(appIds.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.application.findMany({
      where: { id: { in: ids.slice(i, i + 300) } },
      select: { id: true, ...APP_ATTR_SELECT },
    });
    rows.forEach((r) => out.set(r.id, r));
  }
  return out;
}

const overlapDays = (a1, a2, b1, b2) => {
  const s = a1 > b1 ? a1 : b1;
  const e = a2 < b2 ? a2 : b2;
  return e >= s ? (new Date(e) - new Date(s)) / 86400000 + 1 : 0;
};

// The org tree plus a seat map and an employee-key resolver. ONE payload the
// screen computes every dropdown from.
async function loadHierarchy(dir) {
  const d = dir || await loadDirectory();
  const positions = await prisma.position.findMany({
    select: {
      id: true, code: true, kind: true, department: true, team: true, reportsToId: true, active: true,
      assignments: { select: { employeeId: true, fromDate: true, toDate: true }, orderBy: { fromDate: 'asc' } },
    },
  });
  const posById = new Map(positions.map((p) => [p.id, p]));
  const inStructure = (p) => TEAM_KINDS.includes(p.kind) && p.department && p.team && (p.kind === 'TL' || !!p.reportsToId);
  const structural = positions.filter(inStructure);

  // Departments -> sections.
  const teamsByDept = new Map();
  structural.forEach((p) => {
    if (!teamsByDept.has(p.department)) teamsByDept.set(p.department, new Set());
    teamsByDept.get(p.department).add(p.team);
  });
  const departments = [...teamsByDept.keys()].sort().map((dept) => {
    const teams = [...teamsByDept.get(dept)].sort();
    return {
      name: dept,
      label: deptLabel(dept),
      sections: teams.map((team) => {
        const seats = structural.filter((p) => p.department === dept && p.team === team)
          .sort((a, b) => (a.kind === 'TL' ? -1 : 0) - (b.kind === 'TL' ? -1 : 0) || a.code.localeCompare(b.code, undefined, { numeric: true }));
        return {
          key: sectionKeyOf(dept, team),
          department: dept,
          team,
          label: sectionLabelOf(dept, team, teams.length),
          tlSeat: (seats.find((p) => p.kind === 'TL') || {}).code || null,
          seats: seats.map((p) => p.code),
        };
      }),
    };
  });
  const sectionByKey = new Map(departments.flatMap((x) => x.sections).map((s) => [s.key, s]));

  // Every seat (structural or not) -> its department / section, for invoices.
  const seats = new Map(positions.map((p) => [p.code, {
    code: p.code,
    kind: p.kind,
    department: clean(p.department) || null,
    sectionKey: inStructure(p) ? sectionKeyOf(p.department, p.team) : null,
  }]));

  // The TL who held the recruiter seat's TL seat for longest in the tenure.
  const tlDuring = (recPos, from, to) => {
    const tlPos = recPos.reportsToId ? posById.get(recPos.reportsToId) : null;
    if (!tlPos) return null;
    let best = null;
    tlPos.assignments.filter(realTenure).forEach((a) => {
      const days = overlapDays(from, to || today(), a.fromDate, a.toDate || today());
      if (days > 0 && (!best || days > best.days)) best = { days, employeeId: a.employeeId };
    });
    const e = best && d.empById.get(best.employeeId);
    return e ? { key: `e:${e.id}`, name: e.name, source: 'structure' } : null;
  };

  // People: current and former holders of the structural seats.
  const people = new Map();
  structural.forEach((p) => {
    p.assignments.filter(realTenure).forEach((a) => {
      const e = d.empById.get(a.employeeId);
      if (!e) return;
      const key = `e:${e.id}`;
      if (!people.has(key)) {
        people.set(key, {
          key,
          employeeId: e.id,
          userId: e.userId || null,
          name: e.name,
          employmentStatus: e.employmentStatus || null,
          entries: [],
        });
      }
      const left = LEFT_STATUSES.includes(e.employmentStatus);
      people.get(key).entries.push({
        role: p.kind === 'TL' ? 'TL' : 'Recruiter',
        seat: p.code,
        department: p.department,
        sectionKey: sectionKeyOf(p.department, p.team),
        section: sectionByKey.get(sectionKeyOf(p.department, p.team))?.label || p.team,
        from: a.fromDate,
        to: a.toDate || null,
        current: !a.toDate && !left,
        reportingTl: p.kind === 'TL' ? null : tlDuring(p, a.fromDate, a.toDate),
      });
    });
  });
  people.forEach((x) => {
    x.entries.sort((a, b) => String(a.from).localeCompare(String(b.from)));
    x.current = x.entries.some((en) => en.current);
  });

  // workers.js person ({key,userId,label}) -> the Employee it is.
  const employeeOf = (p) => {
    if (!p) return null;
    const e = (p.userId && d.empByUser.get(p.userId)) || d.empByName.get(nameKey(p.label));
    return e ? { key: `e:${e.id}`, name: e.name, employeeId: e.id } : { key: p.key, name: p.label, employeeId: null };
  };

  return {
    dir: d, departments, sectionByKey, seats, people, employeeOf,
  };
}

// One application -> who, which seat, which section / department.
// `fallback` ({ department, from } or a plain department name, read as the
// department when no seat is known: the requirement's, the candidate's, the client's).
function attributeApplication(app, h, fallback) {
  const fb = typeof fallback === 'string' || !fallback ? { department: clean(fallback) || null, from: 'client' } : fallback;
  if (!app) {
    return {
      recruiterKey: null, recruiterName: null, tlKey: null, tlName: null, seat: null,
      department: fb.department || null, sectionKey: null, departmentFrom: fb.department ? fb.from : null,
    };
  }
  const at = attribute(app.requirement, app.followUps || [], app.stageEvents || [], h.dir.person);
  const rec = h.employeeOf(at.recruiter);
  const tl = h.employeeOf(at.tl);
  const seat = at.seat ? h.seats.get(at.seat) : null;
  const reqDept = clean(app.requirement?.department);
  const department = (seat && seat.department) || reqDept || fb.department || null;
  return {
    recruiterKey: rec ? rec.key : null,
    recruiterName: rec ? rec.name : null,
    tlKey: tl ? tl.key : null,
    tlName: tl ? tl.name : null,
    seat: at.seat || null,
    department,
    sectionKey: seat ? seat.sectionKey : null,
    departmentFrom: seat && seat.department ? 'seat' : (reqDept ? 'requirement' : (fb.department ? fb.from : null)),
  };
}

// The payload the screen gets: departments -> sections, and every person
// with their seat history. `attributed` = [{ recruiterKey, recruiterName,
// tlKey, tlName, seat, department, invoice }] from the invoices (invoice:true)
// and the waiting joinings. Used for two things only:
//   - the tracker's TL for a recruiter tenure the structure has no TL for
//     (Education Team A had no TL seat holder before Sep 2026);
//   - somebody an INVOICE is attributed to who holds no structural seat is
//     sent flagged `unplaced` (reported; the Employee list offers only the
//     structure, so their invoices are reached through their department).
//     People named only on waiting joinings are counted, not listed.
function hierarchyPayload(h, attributed) {
  const trackerTl = new Map(); // `${personKey}|${seat}` -> Map(tlKey -> {name,n})
  const extra = new Map();
  const outside = new Set();
  attributed.forEach((a) => {
    if (a.recruiterKey && a.tlKey && a.seat) {
      const k = `${a.recruiterKey}|${a.seat}`;
      if (!trackerTl.has(k)) trackerTl.set(k, new Map());
      const m = trackerTl.get(k);
      m.set(a.tlKey, { name: a.tlName, n: ((m.get(a.tlKey) || {}).n || 0) + 1 });
    }
    [[a.recruiterKey, a.recruiterName, 'Recruiter'], [a.tlKey, a.tlName, 'TL']].forEach(([key, name, role]) => {
      if (!key || h.people.has(key)) return;
      if (!a.invoice) { outside.add(key); return; }
      if (!extra.has(key)) {
        extra.set(key, {
          key, employeeId: key.startsWith('e:') ? key.slice(2) : null, name, roles: new Set(), departments: new Set(),
        });
      }
      extra.get(key).roles.add(role);
      if (a.department) extra.get(key).departments.add(a.department);
    });
  });
  const people = [...h.people.values()].map((p) => ({
    ...p,
    entries: p.entries.map((en) => {
      if (en.role !== 'Recruiter' || en.reportingTl) return en;
      const m = trackerTl.get(`${p.key}|${en.seat}`);
      const top = m ? [...m.entries()].sort((x, y) => y[1].n - x[1].n)[0] : null;
      return top ? { ...en, reportingTl: { key: top[0], name: top[1].name, source: 'tracker' } } : en;
    }),
  }));
  extra.forEach((x) => people.push({
    key: x.key,
    employeeId: x.employeeId,
    name: x.name,
    unplaced: true,
    current: false,
    entries: [],
    roles: [...x.roles],
    departments: [...x.departments],
  }));
  people.sort((x, y) => (y.current - x.current) || String(x.name).localeCompare(String(y.name)));
  extra.forEach((x, k) => outside.delete(k));
  return { departments: h.departments, people, outsideStructure: outside.size };
}

module.exports = {
  APP_ATTR_SELECT, REQ_ATTR_SELECT, deptLabel, loadHierarchy, attributeApplication, hierarchyPayload, attributionData,
};
