// ---------------------------------------------------------------------------
// THE TRANSFER CARD (Employee Management -> Transfer).
//
// Founder, 2026-11-17: "transfer role lo field ... when the role recruiter / TL moves, that role or position
// automatically changes on the application". The card used to move the DEPARTMENT only; the role, the seat,
// the reporting line and the team that hung off a TL stayed where they were and somebody fixed them by hand.
//
// WHAT "ROLE" MEANS HERE. The person's job: Recruiter, TL, STL, BDE, Manager, Employee ... It is the DESIGNATION
// (Employee Management's Designation, which drives Vacancies and the HRMS reporting rules) plus the working ATS
// role on the same login (a Recruiter / a BDE is an "Employee" in HRMS who carries that ATS role). The list is read
// from the designation master and the Role Catalog, never typed in here, so another company's copy offers its own.
//
// ONE PLAN, TWO USES. planTransfer() works out everything a confirmed transfer would do and writes NOTHING:
//   * preview  -> the card shows it ("Confirm: these things change") and the options for each dropdown;
//   * confirm  -> applyTransfer() writes exactly that plan in ONE transaction.
// So what the founder is shown is what is saved, and a refused combination is refused before anything is touched.
//
// WHAT A CONFIRMED TRANSFER KEEPS IN STEP
//   Employee   department, team, designation, TL / STL / reporting manager
//   Login      role, HRMS / ATS / Accounts roles + access, landing workspace, ATS department / team scope
//   Seat       the old seat's tenure is closed (never deleted), the new one opens today (Positions & Seat History)
//   Team       a TL / STL who stops leading hands their people to a named lead (or leaves them with no lead on purpose);
//              a person who takes a TL seat adopts the people of the seats under it whose lead is missing
//   Audit      one history row per thing that changed, with the old value
// Vacancies, Role performance, ATS scope and the dashboards read these same rows, so they follow by themselves.
//
// SAFETY (the same rules as granting the role anywhere else)
//   * the Role list is only the roles THIS person may hand out (privileged ones only for a Super Admin / Admin;
//     Super Admin / Admin are never offered here at all);
//   * utils/roleGuard.js decides every role change (nobody changes their own role, Admin / Super Admin logins are
//     touched only by a Super Admin, ...) and its refusal is shown in plain words BEFORE anything is saved;
//   * a seat is refused when it is taken, retired, in another department or the wrong kind for the role;
//   * a TL / STL who leads people may not be moved until the card says what happens to those people.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const reportingLine = require('./reportingLine');
const roleGuard = require('./roleGuard');
const seatRelease = require('./seatRelease');
const { canonicalDepartment } = require('./bdeDesk');
const { teamKey } = require('./teamNames');
const { today: seatToday, hasLeft, lastWorkingDayOf } = require('./positions');
const { logAudit, logFieldChanges } = require('./audit');
const {
  designationRows, productRolesForDesignation, loginRoleFor, planLoginSync,
} = require('./employeeAdmin');
const { listRoles, isPrivilegedRole } = require('./roleRegistry');

const TOP = ['SUPER_ADMIN', 'ADMIN'];
const lc = (v) => String(v || '').trim().toLowerCase();
const sameDept = (a, b) => !!canonicalDepartment(a) && lc(canonicalDepartment(a)) === lc(canonicalDepartment(b));
const sameTeam = (a, b) => teamKey(a) === teamKey(b);
const show = (v) => (v === null || v === undefined || String(v).trim() === '' ? '—' : String(v));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const nameList = (xs, max = 6) => {
  const names = xs.map((x) => x.name || x);
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
};

// ---------------------------------------------------------------------------
// THE ROLE LIST
// ---------------------------------------------------------------------------
// `allowedRows` = the designation rows the CALLER may hand out (the route passes addEmployeeDesignations(req, rows)).
async function roleOptions(allowedRows) {
  const registry = await listRoles({ activeOnly: true }).catch(() => []);
  const may = (code) => {
    const r = registry.find((x) => x.code === code);
    return !!r && !r.external && !isPrivilegedRole(r);
  };
  const out = [];
  let plainRow = null;
  // A Recruiter / a BDE: the plain Employee designation + that ATS role on the same login. Listed right after Employee.
  const variants = (row) => [['RECRUITER', 'Recruiter', 'RECRUITER'], ['BDE', 'BDE', null]].filter(([code]) => may(code)).map(([code, label, kind]) => ({
    key: `r:${code}`, label, designation: row.designation, atsRole: code, expectKind: kind, level: 'STAFF', plain: false,
  }));
  allowedRows.forEach((row) => {
    const d = productRolesForDesignation(row);
    if ([d.hrmsRole, d.atsRole, d.accountsRole].some((r) => TOP.includes(r))) return; // a transfer never makes an Admin
    const plain = loginRoleFor(row) === 'EMPLOYEE';
    const firstPlain = plain && !plainRow;
    if (firstPlain) plainRow = row;
    const kind = ['TL', 'STL'].includes(d.atsRole) ? d.atsRole : null;
    out.push({
      key: `d:${row.designation}`,
      label: plain ? `${row.designation} (HRMS only, no ATS work)` : row.designation,
      designation: row.designation,
      atsRole: null,
      expectKind: kind,
      level: reportingLine.levelOf({ designation: row.designation }),
      plain,
    });
    if (firstPlain) out.push(...variants(row));
  });
  return out;
}

// The key of the role the person holds today (so "no change" is recognised and the dropdown opens on it).
function currentRoleOf(emp, options) {
  const user = emp.user || null;
  // A plain Employee, or a legacy designation the master no longer lists ("Recruiter"), who carries a working ATS role.
  const row = options.find((o) => lc(o.designation) === lc(emp.designation) && o.plain)
    || (!options.some((o) => lc(o.designation) === lc(emp.designation)) ? { legacy: true } : null);
  if (row && user) {
    const ats = String(user.atsRole || '').toUpperCase();
    if (ats === 'RECRUITER' && options.some((o) => o.key === 'r:RECRUITER')) return options.find((o) => o.key === 'r:RECRUITER');
    if (ats === 'BDE' && options.some((o) => o.key === 'r:BDE')) return options.find((o) => o.key === 'r:BDE');
  }
  const exact = options.find((o) => o.key === `d:${emp.designation}`);
  if (exact) return exact;
  // A legacy / privileged role the caller cannot hand out: shown as the current one, never offered to switch to.
  const label = emp.designation || (user && (user.atsRole || user.role)) || 'Not set';
  return {
    key: 'keep', label: `${label} (current)`, designation: emp.designation || null, atsRole: null, expectKind: null,
    level: reportingLine.levelOf({ designation: emp.designation, user }), plain: false, synthetic: true,
  };
}

// Which seats suit a role. OTHER seats (BDE desk, HR, R&D ...) suit anybody; a TL / STL / Recruiter seat suits only that role.
const seatFits = (seatKind, expectKind) => seatKind === 'OTHER' || (!!expectKind && seatKind === expectKind);

const WORKING = (s) => !reportingLine.NOT_WORKING.includes(s) && !['Terminated', 'Resigned', 'Absconded'].includes(s);

// ---------------------------------------------------------------------------
// THE PLAN
// ---------------------------------------------------------------------------
// ctx = { actor, employeeId, body, allowedRows }
// returns { ok, blockers, warnings, lines, options, noChange, resolved }
async function planTransfer({ actor, employeeId, body, allowedRows }) {
  const b = body || {};
  const blockers = [];
  const warnings = [];
  const lines = [];

  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
  if (!emp) return { notFound: true };

  const department = String(b.department || '').trim() || emp.department || '';
  const deptChanged = !sameDept(department, emp.department) && lc(department) !== lc(emp.department);
  const dept = deptChanged ? department : (emp.department || department);
  if (!dept) blockers.push('Choose a department.');

  // --- the role --------------------------------------------------------------
  const options = await roleOptions(allowedRows);
  const cur = currentRoleOf(emp, options);
  const wantedKey = b.roleKey ? String(b.roleKey) : cur.key;
  const wanted = options.find((o) => o.key === wantedKey) || (wantedKey === cur.key ? cur : null);
  if (!wanted) blockers.push('That role is not one you can give. Choose a role from the list.');
  const role = wanted || cur;
  const roleChanged = role.key !== cur.key;

  const oldLevel = reportingLine.levelOf({ designation: emp.designation, user: emp.user });
  const newLevel = roleChanged ? role.level : oldLevel;
  const expectKind = roleChanged ? role.expectKind : (cur.expectKind
    || (emp.user && ['TL', 'STL'].includes(String(emp.user.atsRole).toUpperCase()) ? String(emp.user.atsRole).toUpperCase() : null));

  // --- the team --------------------------------------------------------------
  let team = b.team !== undefined ? (String(b.team || '').trim() || null) : (deptChanged ? null : (emp.team || null));

  // --- the seat --------------------------------------------------------------
  await seatRelease.ensureFresh().catch(() => {});
  const open = await prisma.positionAssignment.findFirst({
    where: { employeeId: emp.id, toDate: null }, include: { position: true }, orderBy: { fromDate: 'desc' },
  });
  const allSeats = await prisma.position.findMany({ orderBy: [{ code: 'asc' }] });
  const deptSeats = allSeats.filter((p) => sameDept(p.department, dept));
  const openHolds = await prisma.positionAssignment.findMany({
    where: { positionId: { in: deptSeats.map((p) => p.id) }, toDate: null },
    include: { employee: { select: { id: true, name: true, employmentStatus: true } } },
  });
  const heldBy = new Map(); // seat id -> { name, left, notice }
  openHolds.forEach((a) => {
    if (a.employeeId === emp.id) return;
    const st = a.employee && a.employee.employmentStatus;
    if (a.employee && hasLeft(st)) return; // somebody who has left does not hold it
    if (!heldBy.has(a.positionId) || !seatRelease.isNotice(st)) heldBy.set(a.positionId, { name: a.employee ? a.employee.name : 'somebody', notice: seatRelease.isNotice(st) });
  });
  // A seat on notice is still free for a replacement (founder, 2026-10-23) - it only says so.
  const seatRows = deptSeats.map((p) => {
    const h = heldBy.get(p.id) || null;
    const fits = seatFits(p.kind, expectKind);
    const free = p.active && (!h || h.notice);
    return {
      code: p.code, name: p.name || null, team: p.team || null, kind: p.kind, active: p.active,
      holder: h ? h.name : null, onNotice: !!(h && h.notice), vacant: !h, fits, selectable: free && fits,
      why: !p.active ? 'retired' : (h && !h.notice ? `held by ${h.name}` : (!fits ? `${kindWord(p.kind)} seat` : null)),
    };
  });

  const deptTeamNames = await teamNames(dept);
  const keepSeat = !!(open && open.position && sameDept(open.position.department, dept)
    && (!roleChanged || seatFits(open.position.kind, expectKind)));
  // The seat the card sends: undefined = keep the one that still fits, else none (what an older caller that sends only a
  // department gets); 'auto' = keep the one that still fits, else the first vacant seat that fits the role and the team;
  // '' = no seat; a code = that seat.
  let wantedSeat = b.seat === undefined ? undefined : String(b.seat || '').trim();
  const recommendedSeat = () => {
    const mine = seatRows.filter((s) => s.selectable && s.vacant);
    if (team) return mine.find((s) => s.team && sameTeam(s.team, team)) || null;
    // No team chosen: only auto-pick where the department has no teams to choose between (a pick between Team A and Team B is the founder's).
    if (deptTeamNames.length) return mine.find((s) => !s.team) || null;
    return mine[0] || null;
  };
  let newSeat = null;
  let departedHolder = null;
  let prevEnd = null;
  let closeOld = false;
  if (wantedSeat === undefined || wantedSeat === 'auto') {
    if (keepSeat) wantedSeat = open.position.code;
    else { const rec = wantedSeat === 'auto' && !hasLeft(emp.employmentStatus) ? recommendedSeat() : null; wantedSeat = rec ? rec.code : ''; }
  }
  if (wantedSeat === '') {
    closeOld = !!open;
  } else if (open && keepSeat && lc(open.position.code) === lc(wantedSeat)) {
    closeOld = false; // the same seat stays
  } else {
    closeOld = !!open;
    const hit = deptSeats.find((p) => lc(p.code) === lc(wantedSeat));
    if (!hit) {
      const elsewhere = allSeats.find((p) => lc(p.code) === lc(wantedSeat));
      blockers.push(elsewhere
        ? `Seat ${elsewhere.code} belongs to ${elsewhere.department || 'another department'}, not ${dept}. Choose a seat in ${dept}.`
        : `There is no seat "${wantedSeat}". Choose one from the list.`);
    } else if (!hit.active) {
      blockers.push(`Seat ${hit.code} is retired. Reactivate it on Administration > Positions, or choose another.`);
    } else if (hasLeft(emp.employmentStatus)) {
      blockers.push(`${emp.name} has left the company (${emp.employmentStatus}), so cannot take a seat.`);
    } else if (!seatFits(hit.kind, expectKind)) {
      blockers.push(`Seat ${hit.code} is a ${kindWord(hit.kind)} seat, but the role is ${role.label}. Choose a seat that suits the role.`);
    } else {
      const holds = await seatRelease.holdersOf(hit.id, { exceptEmployeeId: emp.id });
      if (holds.active.length) {
        const h = holds.active[0];
        blockers.push(`${hit.code} is held by ${h.employee ? h.employee.name : 'somebody else'}. Choose a vacant seat, or vacate it first.`);
      } else {
        newSeat = hit;
        if (holds.left.length) {
          departedHolder = holds.left[0];
          prevEnd = await lastWorkingDayOf(departedHolder.employeeId);
          if (prevEnd < departedHolder.fromDate) prevEnd = departedHolder.fromDate;
        }
      }
    }
    // The seat's team becomes the person's team only where the department really has teams to choose between (Education: Team-A / Team-B);
    // a seat of a department without teams carries the placeholder "Team", which is not worth writing on a person.
    if (!team && newSeat && newSeat.team && deptTeamNames.some((n) => sameTeam(n, newSeat.team))) team = seatTeamName(newSeat.team, deptTeamNames);
  }
  const seatPlan = { open, closeOld, newSeat, departedHolder, prevEnd };
  const teamChanged = (team || null) !== (emp.team || null) && !(sameTeam(team, emp.team));

  // --- the person's own reporting line ---------------------------------------
  const lineReview = deptChanged || (roleChanged && newLevel !== oldLevel);
  const leads = await reportingLine.candidatesFor({ department: dept, level: newLevel, excludeId: emp.id });
  const leadsById = new Map(leads.options.map((o) => [o.id, o]));
  const leadsByName = new Map(leads.options.map((o) => [lc(o.name), o]));
  const lineIsValid = () => {
    const rmOk = !emp.reportingManagerId || leadsById.has(emp.reportingManagerId);
    const tlOk = !emp.tl || lc(emp.tl) === lc(emp.name) || leadsByName.has(lc(emp.tl));
    const stlOk = !emp.stl || lc(emp.stl) === lc(emp.name) || leadsByName.has(lc(emp.stl));
    return rmOk && tlOk && stlOk && !!(emp.reportingManagerId || emp.tl);
  };
  let reportsTo; // the lead the person will report to, or null
  let lineChange = null; // the employee fields to write
  if (!lineReview && b.reportsTo === undefined) {
    reportsTo = undefined; // nothing about the line changes
  } else if (b.reportsTo === '') {
    reportsTo = null;
  } else if (b.reportsTo) {
    reportsTo = leadsById.get(String(b.reportsTo)) || null;
    if (!reportsTo) blockers.push(`That person is not a lead of ${dept}. ${leads.empty || 'Choose someone from the list.'}`.trim());
  } else if (lineIsValid()) {
    reportsTo = undefined; // the current line still fits the new department
  } else if (leads.single) {
    reportsTo = leadsById.get(leads.single);
  } else {
    reportsTo = null;
    if (emp.reportingManagerId || emp.tl) warnings.push(`${emp.name} will have no reporting manager until you choose one${leads.options.length ? ` (${plural(leads.options.length, 'lead')} in ${dept} to choose from)` : ` (there is no lead in ${dept} yet)`}.`);
  }
  if (reportsTo !== undefined) {
    let leadEmp = null;
    if (reportsTo) leadEmp = await prisma.employee.findUnique({ where: { id: reportsTo.id }, select: { id: true, name: true, stl: true } });
    lineChange = lineFor(newLevel, reportsTo, leadEmp);
  }

  // --- who reports to this person, if they stop leading them ------------------
  const stopsLeading = oldLevel === 'LEAD' && (deptChanged || newLevel === 'STAFF');
  const everyone = await prisma.employee.findMany({
    where: { id: { not: emp.id } },
    select: { id: true, name: true, department: true, designation: true, team: true, tl: true, stl: true, reportingManagerId: true, employmentStatus: true, userId: true },
  });
  // Their team: whoever names them (reporting manager / TL / STL) AND whoever sits in the seats under their own TL / STL seat,
  // even where nobody typed the name - the seats ARE the team structure.
  const myOpen = await prisma.positionAssignment.findMany({ where: { employeeId: emp.id, toDate: null }, include: { position: true } });
  const myLeadSeatIds = myOpen.filter((a) => ['TL', 'STL'].includes(a.position.kind)).map((a) => a.position.id);
  const underSeatIds = allSeats.filter((p) => myLeadSeatIds.includes(p.reportsToId)).map((p) => p.id);
  const seatMembers = new Set(underSeatIds.length
    ? (await prisma.positionAssignment.findMany({ where: { positionId: { in: underSeatIds }, toDate: null }, select: { employeeId: true } })).map((a) => a.employeeId)
    : []);
  const reports = everyone.filter((e) => WORKING(e.employmentStatus || 'Active')
    && (e.reportingManagerId === emp.id || (lc(e.tl) && lc(e.tl) === lc(emp.name)) || (lc(e.stl) && lc(e.stl) === lc(emp.name)) || seatMembers.has(e.id)));
  let teamPlan = { needed: false };
  let handoverTo = null;
  let repoints = []; // [{ id, name, data, from }]
  let seatRepoints = []; // [{ id, code, reportsToId, to }]
  if (reports.length && stopsLeading) {
    // Who may take them over: a lead of the OLD department, valid for every level among the people.
    const levels = [...new Set(reports.map((r) => reportingLine.levelOf({ designation: r.designation })))];
    let cands = null;
    for (const lv of levels) {
      // eslint-disable-next-line no-await-in-loop
      const set = await reportingLine.candidatesFor({ department: emp.department, level: lv, excludeId: emp.id });
      const ids = new Set(set.options.map((o) => o.id));
      cands = cands ? new Map([...cands].filter(([id]) => ids.has(id))) : new Map(set.options.map((o) => [o.id, o]));
    }
    // Not somebody who is one of the people being handed over.
    const handed = new Set(reports.map((r) => r.id));
    const candidates = [...(cands || new Map()).values()].filter((o) => !handed.has(o.id));
    const mode = b.teamMode === 'leave' ? 'leave' : (b.teamTo ? 'handover' : null);
    teamPlan = {
      needed: true,
      count: reports.length,
      people: reports.map((r) => ({ id: r.id, name: r.name, designation: r.designation || null, department: r.department || null })),
      candidates: candidates.map((o) => ({ id: o.id, name: o.name, label: o.label })),
      department: emp.department,
      mode,
      to: b.teamTo ? String(b.teamTo) : null,
    };
    const roleWord = oldLevel === 'LEAD' ? 'a team lead' : 'a lead';
    if (!mode) {
      blockers.push(`${emp.name} is ${roleWord} in ${emp.department} with ${plural(reports.length, 'person', 'people')} reporting to them (${nameList(reports)}). Choose who takes over their team, or tick "leave them without a lead for now", before moving ${emp.name}.`);
    } else if (mode === 'handover') {
      handoverTo = candidates.find((o) => o.id === String(b.teamTo)) || null;
      if (!handoverTo) blockers.push(`That person cannot take over the team of ${emp.name}. Choose a lead of ${emp.department} from the list.`);
    }
    if (mode === 'leave') {
      warnings.push(`${plural(reports.length, 'person', 'people')} (${nameList(reports)}) will have no TL / reporting manager until you set one. Their seats stay where they are.`);
    }
    if (mode === 'leave' || handoverTo) {
      let leadEmp = null;
      if (handoverTo) leadEmp = await prisma.employee.findUnique({ where: { id: handoverTo.id }, select: { id: true, name: true, stl: true } });
      // A field that NAMED the person (or, on a hand-over, was left blank) takes the new lead; a field that names somebody else is left alone.
      repoints = reports.map((r) => {
        const data = {};
        const to = handoverTo ? lineFor(reportingLine.levelOf({ designation: r.designation }), handoverTo, leadEmp) : null;
        const named = { rm: r.reportingManagerId === emp.id, tl: lc(r.tl) === lc(emp.name), stl: lc(r.stl) === lc(emp.name) };
        if (to) {
          if (named.rm || !r.reportingManagerId) data.reportingManagerId = to.reportingManagerId;
          if (named.tl || !lc(r.tl)) data.tl = to.tl;
          if (named.stl) data.stl = to.stl;
        } else {
          if (named.rm) data.reportingManagerId = null;
          if (named.tl) data.tl = '';
          if (named.stl) data.stl = '';
        }
        return { id: r.id, name: r.name, userId: r.userId, data, from: { tl: r.tl, stl: r.stl, reportingManagerId: r.reportingManagerId } };
      }).filter((p) => lineDiff(p).length);
      // The SEATS under the TL's seat follow the new TL's own TL seat, so the new lead's ATS scope reaches them.
      if (handoverTo) {
        const mySeats = await prisma.positionAssignment.findMany({ where: { employeeId: emp.id, toDate: null }, include: { position: true } });
        const myTlSeatIds = mySeats.filter((a) => a.position.kind === 'TL').map((a) => a.position.id);
        const theirs = await prisma.positionAssignment.findMany({ where: { employeeId: handoverTo.id, toDate: null }, include: { position: true } });
        const theirTl = theirs.find((a) => a.position.kind === 'TL');
        if (myTlSeatIds.length) {
          const children = allSeats.filter((p) => myTlSeatIds.includes(p.reportsToId));
          if (children.length && theirTl) {
            seatRepoints = children.map((p) => ({ id: p.id, code: p.code, to: theirTl.position.id, toCode: theirTl.position.code }));
          } else if (children.length) {
            warnings.push(`The seats ${nameList(children.map((p) => p.code))} still report to ${emp.name}'s TL seat. ${handoverTo.name} holds no TL seat, so put a TL in that seat so ATS scope follows.`);
          }
        }
      }
    }
  } else if (reports.length && !stopsLeading && oldLevel === 'MGMT' && deptChanged) {
    warnings.push(`${plural(reports.length, 'person', 'people')} (${nameList(reports)}) still report to ${emp.name}. Their reporting line was not changed.`);
  }

  // --- a person who takes a TL seat adopts the people of the seats under it --
  let adoptees = [];
  if (newSeat && newSeat.kind === 'TL') {
    const childIds = allSeats.filter((p) => p.reportsToId === newSeat.id).map((p) => p.id);
    if (childIds.length) {
      const held = await prisma.positionAssignment.findMany({
        where: { positionId: { in: childIds }, toDate: null },
        include: { employee: { select: { id: true, name: true, department: true, designation: true, tl: true, stl: true, reportingManagerId: true, employmentStatus: true, userId: true } } },
      });
      let leadEmp = null;
      leadEmp = { id: emp.id, name: emp.name, stl: (lineChange && lineChange.stl) || emp.stl || '' };
      const workingLeads = await reportingLine.candidatesFor({ department: dept, level: 'STAFF', excludeId: null });
      const validIds = new Set(workingLeads.options.map((o) => o.id));
      adoptees = held.map((a) => a.employee).filter((e) => e && WORKING(e.employmentStatus || 'Active') && e.id !== emp.id)
        .filter((e) => !(e.reportingManagerId && validIds.has(e.reportingManagerId) && sameDept(e.department, dept)))
        .map((e) => ({
          id: e.id, name: e.name, userId: e.userId,
          data: lineFor('STAFF', { id: emp.id, name: emp.name, role: 'TL' }, leadEmp),
          from: { tl: e.tl, stl: e.stl, reportingManagerId: e.reportingManagerId },
        }));
    }
  }

  // --- the login ---------------------------------------------------------------
  const after = {
    ...emp, department: dept, team, designation: roleChanged ? role.designation : emp.designation,
  };
  let loginPlan = null;
  if (emp.user) {
    loginPlan = await planLoginSync(emp.user, after, emp, { designationChanged: roleChanged, atsRoleOverride: roleChanged ? role.atsRole : null });
    if (roleChanged) {
      const refusal = await roleGuard.checkRoleChange({ actor, current: emp.user, next: loginPlan.data });
      if (refusal) blockers.push(refusal);
    }
  }

  // --- nothing at all to do ------------------------------------------------------
  const seatMove = !!(seatPlan.newSeat || seatPlan.closeOld);
  const noChange = !deptChanged && !teamChanged && !roleChanged && !seatMove && reportsTo === undefined && !repoints.length;

  // --- the lines the founder confirms --------------------------------------------
  if (deptChanged) lines.push({ label: 'Department', from: show(emp.department), to: dept });
  if (teamChanged) lines.push({ label: 'Team', from: show(emp.team), to: show(team) });
  if (roleChanged) lines.push({ label: 'Role', from: cur.label.replace(/ \(current\)$/, ''), to: role.label });
  // The designation on the employee record (what Vacancies and the Employee list show) follows the role; Recruiter / BDE stay "Employee" in HRMS.
  if (roleChanged && lc(role.designation) !== lc(emp.designation)) lines.push({ label: 'Designation', from: show(emp.designation), to: show(role.designation) });
  if (roleChanged && loginPlan && loginPlan.data.atsRole !== undefined) {
    const u = emp.user;
    const bits = [];
    [['hrmsRole', 'HRMS'], ['atsRole', 'ATS'], ['accountsRole', 'Accounts']].forEach(([f, l]) => {
      const to = loginPlan.data[f];
      if (to !== undefined && String(u[f] || 'NONE') !== String(to || 'NONE')) bits.push(`${l}: ${show(u[f])} -> ${show(to)}`);
    });
    if (bits.length) lines.push({ label: 'Login access', from: '', to: bits.join('; ') });
  } else if (roleChanged && !emp.user) {
    warnings.push(`${emp.name} has no login yet, so only the HR record changes. The new role applies when a login is created.`);
  }
  if (seatPlan.closeOld || seatPlan.newSeat) {
    const oldCode = open && open.position ? open.position.code : null;
    lines.push({
      label: 'Seat',
      from: oldCode ? `${oldCode} (ends today)` : 'no seat',
      to: seatPlan.newSeat ? `${seatPlan.newSeat.code}${seatPlan.newSeat.team ? ` · ${seatPlan.newSeat.team}` : ''} (starts today)` : 'no seat',
    });
    if (!seatPlan.newSeat && !hasLeft(emp.employmentStatus)) {
      warnings.push(oldCode
        ? `${oldCode} does not fit the new ${deptChanged ? 'department' : 'role'}, so ${emp.name} leaves it and has no seat in ${dept} yet. Choose a seat to give one now.`
        : `${emp.name} has no seat in ${dept}. Choose one to give a seat now.`);
    }
    if (newSeat && require('./bdeSeatHandover').isBdeDeskSeat(newSeat.code) && role.atsRole !== 'BDE' && !['TL', 'STL'].includes(expectKind || '') && !role.synthetic && ['STAFF'].includes(newLevel)) { // eslint-disable-line global-require
      warnings.push(`${newSeat.code} is a BDE desk seat: whoever sits in it is made an ATS BDE automatically, so choose the BDE role to match.`);
    }
    if (departedHolder) lines.push({ label: 'Seat note', from: '', to: `${seatPlan.newSeat.code} was held by ${departedHolder.employee ? departedHolder.employee.name : 'someone'}, who has left; that tenure is closed.` });
  } else if (!open && (deptChanged || roleChanged) && !hasLeft(emp.employmentStatus) && expectKind) {
    warnings.push(`${emp.name} has no seat. A ${role.label} normally sits in a seat; choose one from the list to give one now.`);
  }
  if (reportsTo !== undefined) {
    const fromLine = [emp.tl && `TL ${emp.tl}`, emp.stl && `STL ${emp.stl}`].filter(Boolean).join(', ') || (emp.reportingManagerId ? 'reporting manager set' : 'none');
    lines.push({ label: 'Reports to', from: fromLine, to: reportsTo ? `${reportsTo.name} (${labelOfRole(reportsTo.role)})` : 'nobody yet' });
  }
  if (repoints.length) {
    lines.push({
      label: 'Their team',
      from: `${plural(repoints.length, 'person', 'people')} reported to ${emp.name}`,
      to: handoverTo ? `now report to ${handoverTo.name}: ${nameList(repoints)}` : `have no lead for now: ${nameList(repoints)}`,
    });
  }
  if (seatRepoints.length) lines.push({ label: 'Team seats', from: nameList(seatRepoints.map((s) => s.code)), to: `now report to the TL seat ${seatRepoints[0].toCode}` });
  if (adoptees.length) lines.push({ label: 'Their new team', from: '', to: `${plural(adoptees.length, 'person', 'people')} in the seats under ${newSeat.code} will report to ${emp.name}: ${nameList(adoptees)}` });

  // --- things that depend on them that this card does not move ---------------------
  if (stopsLeading) {
    try {
      if (emp.userId) {
        const openReqs = await prisma.requirement.count({ where: { tlId: emp.userId, NOT: { status: { in: ['CLOSED', 'Closed', 'Filled', 'Cancelled', 'Rejected'] } } } });
        if (openReqs) warnings.push(`${plural(openReqs, 'open job requirement')} still name ${emp.name} as the TL. Reassign them under Jobs / Requirements.`);
      }
    } catch (e) { /* best effort */ }
  }

  // --- the options the card's dropdowns show ---------------------------------------
  const recommended = hasLeft(emp.employmentStatus) ? null : recommendedSeat();
  const out = {
    ok: !blockers.length,
    noChange,
    blockers,
    warnings,
    lines,
    options: {
      roles: options.some((o) => o.key === cur.key) ? options : [cur, ...options],
      currentRoleKey: cur.key,
      roleKey: role.key,
      level: newLevel,
      expectKind,
      seats: seatRows,
      currentSeat: open && open.position ? open.position.code : null,
      keepSeat: !!(keepSeat && open),
      recommendedSeat: recommended ? recommended.code : null,
      seatSelected: newSeat ? newSeat.code : (closeOld || !open ? '' : open.position.code),
      reportsTo: {
        options: leads.options.map((o) => ({ id: o.id, name: o.name, role: o.role, label: o.label })),
        empty: leads.empty || '',
        selected: reportsTo === undefined ? 'keep' : (reportsTo ? reportsTo.id : ''),
        suggested: leads.single || null,
        review: lineReview,
      },
      team: teamPlan,
    },
    resolved: {
      emp, dept, deptChanged, team, teamChanged, role, cur, roleChanged, seatPlan, lineChange, reportsTo,
      repoints, seatRepoints, adoptees, handoverTo, loginPlan, lines, reason: String(b.reason || '').trim().slice(0, 200),
    },
  };
  return out;
}

const kindWord = (k) => ({ TL: 'TL', STL: 'STL', RECRUITER: 'recruiter', OTHER: 'general' }[k] || String(k || '').toLowerCase());
const labelOfRole = (r) => ({
  TL: 'TL', STL: 'STL', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin',
}[r] || r || 'lead');

// The employee fields that say who somebody reports to, for a level and a lead.
function lineFor(level, lead, leadEmp) {
  if (!lead) return { tl: '', stl: '', reportingManagerId: null };
  const role = lead.role;
  if (level === 'STAFF') {
    return {
      reportingManagerId: lead.id,
      tl: role === 'TL' ? lead.name : '',
      stl: role === 'STL' ? lead.name : (role === 'TL' ? ((leadEmp && leadEmp.stl) || '') : ''),
    };
  }
  return { reportingManagerId: lead.id, tl: lead.name, stl: role === 'STL' ? lead.name : '' };
}

// The department's team names as the Departments & Teams master spells them ("Team-A").
async function teamNames(dept) {
  try {
    const d = await prisma.department.findFirst({ where: { name: dept }, include: { teams: true } });
    return d ? d.teams.map((t) => t.name) : [];
  } catch (e) { return []; }
}
const seatTeamName = (seatTeam, names) => names.find((n) => teamKey(n) === teamKey(seatTeam)) || seatTeam;

// ---------------------------------------------------------------------------
// APPLY - one transaction, then the history.
// ---------------------------------------------------------------------------
async function applyTransfer({ actor, plan }) {
  const r = plan.resolved;
  const { emp } = r;
  const empData = {};
  if (r.deptChanged) empData.department = r.dept;
  if (r.deptChanged || r.teamChanged) empData.team = r.team || null;
  if (r.roleChanged) empData.designation = r.role.designation;
  if (r.lineChange) Object.assign(empData, r.lineChange);
  const today = seatToday();
  const done = { seat: null };

  await prisma.$transaction(async (tx) => {
    if (Object.keys(empData).length) await tx.employee.update({ where: { id: emp.id }, data: empData });
    if (emp.userId && r.loginPlan && Object.keys(r.loginPlan.data).length) {
      await tx.user.update({ where: { id: emp.userId }, data: r.loginPlan.data });
    }
    // The seat: the old tenure is CLOSED (the seat keeps what was done under it), the new one opens today.
    const sp = r.seatPlan;
    if (sp.closeOld && sp.open) {
      await tx.positionAssignment.updateMany({
        where: { id: sp.open.id, toDate: null },
        data: { toDate: today, note: sp.open.note || (sp.newSeat ? `Transferred to ${sp.newSeat.code}` : `Transferred to ${r.dept}`) },
      });
    }
    if (sp.newSeat) {
      // Re-check inside the transaction: somebody may have taken it while the card was open.
      const taken = await tx.positionAssignment.findFirst({
        where: { positionId: sp.newSeat.id, toDate: null, NOT: { employeeId: emp.id } },
        include: { employee: { select: { name: true, employmentStatus: true } } },
      });
      if (taken && !(taken.employee && (hasLeft(taken.employee.employmentStatus) || seatRelease.isNotice(taken.employee.employmentStatus)))) {
        const e = new Error(`${sp.newSeat.code} has just been taken by ${taken.employee ? taken.employee.name : 'somebody else'}. Choose another seat.`);
        e.status = 409;
        throw e;
      }
      if (sp.departedHolder) {
        await tx.positionAssignment.update({ where: { id: sp.departedHolder.id }, data: { toDate: sp.prevEnd } });
      }
      let fromDate = today;
      if (sp.prevEnd && fromDate < sp.prevEnd) fromDate = sp.prevEnd;
      await tx.positionAssignment.create({
        data: {
          positionId: sp.newSeat.id, employeeId: emp.id, fromDate,
          note: sp.open && sp.open.position ? `Transferred from ${sp.open.position.code}` : `Transferred to ${r.dept}`,
        },
      });
      done.seat = sp.newSeat.code;
    }
    for (const p of [...r.repoints, ...r.adoptees]) {
      if (Object.keys(p.data).length) await tx.employee.update({ where: { id: p.id }, data: p.data });
    }
    for (const s of r.seatRepoints) await tx.position.update({ where: { id: s.id }, data: { reportsToId: s.to } });
  }, { timeout: 30000, maxWait: 15000 });

  // ----- the history (after the commit: an audit failure never undoes a transfer, and never throws) -----
  const by = { userId: actor.id, actorName: actor.name };
  const why = r.reason ? ` (${r.reason})` : '';
  if (r.deptChanged) {
    await logAudit({ ...by, action: `Employee transferred${why}`, entity: 'Employee', entityId: emp.id, fromValue: emp.department, toValue: r.dept });
  }
  if (r.roleChanged) {
    await logAudit({
      ...by, action: `Role changed (transfer)${why}`, entity: 'Employee', entityId: emp.id,
      field: 'role', fieldLabel: 'Role', fromValue: r.cur.label.replace(/ \(current\)$/, ''), toValue: r.role.label, reason: r.reason || null,
    });
  }
  const fields = [];
  if ((r.team || null) !== (emp.team || null) && !sameTeam(r.team, emp.team)) fields.push({ field: 'team', label: 'Team', from: emp.team, to: r.team });
  if (r.lineChange) {
    if ((r.lineChange.tl || '') !== (emp.tl || '')) fields.push({ field: 'tl', label: 'TL', from: emp.tl, to: r.lineChange.tl });
    if ((r.lineChange.stl || '') !== (emp.stl || '')) fields.push({ field: 'stl', label: 'STL', from: emp.stl, to: r.lineChange.stl });
    if ((r.lineChange.reportingManagerId || null) !== (emp.reportingManagerId || null)) {
      fields.push({ field: 'reportingManagerId', label: 'Reporting manager', from: emp.reportingManagerId ? (await nameOf(emp.reportingManagerId)) : '', to: r.reportsTo ? r.reportsTo.name : '' });
    }
  }
  await logFieldChanges({ ...by, entity: 'Employee', entityId: emp.id, action: `Employee transferred${why}`, changes: fields, approvalStatus: null, reason: r.reason || null });
  const sp = r.seatPlan;
  if (sp.closeOld || sp.newSeat) {
    await logAudit({
      ...by, action: 'Position changed', entity: 'Employee', entityId: emp.id,
      fromValue: sp.open && sp.open.position ? sp.open.position.code : '(none)', toValue: sp.newSeat ? sp.newSeat.code : '(none)',
    });
    if (sp.newSeat) {
      await logAudit({
        ...by, action: `${emp.name} assigned to position ${sp.newSeat.code} from ${today} (transfer)`, entity: 'PositionAssignment', entityId: sp.newSeat.id,
        fromValue: sp.departedHolder && sp.departedHolder.employee ? sp.departedHolder.employee.name : 'vacant', toValue: emp.name,
      });
    }
  }
  if (r.loginPlan && Object.keys(r.loginPlan.data).length) {
    await logAudit({
      ...by, action: 'Login scope followed transfer', entity: 'User', entityId: emp.userId, toValue: r.loginPlan.changes.join('; ').slice(0, 200),
    });
    if (r.roleChanged) await roleGuard.noteRoleChange({ actor, current: emp.user, next: r.loginPlan.data, source: 'transfer' });
  }
  for (const p of r.repoints) {
    await logFieldChanges({
      ...by, entity: 'Employee', entityId: p.id, action: `Reporting line followed ${emp.name}'s transfer`, approvalStatus: null,
      changes: lineDiff(p),
    });
  }
  for (const p of r.adoptees) {
    await logFieldChanges({
      ...by, entity: 'Employee', entityId: p.id, action: `Reporting line follows ${emp.name} (new TL of the seat)`, approvalStatus: null,
      changes: lineDiff(p),
    });
  }
  for (const s of r.seatRepoints) {
    await logAudit({ ...by, action: `Position ${s.code} now reports to ${s.toCode} (${emp.name}'s team handed over)`, entity: 'Position', entityId: s.id });
  }
  // A BDE desk seat makes an ATS BDE (utils/bdeSeatHandover.js); somebody has to re-check that after a seat is given.
  if (done.seat) { try { require('./bdeSeatHandover').soon(); } catch (e) { /* hourly job catches up */ } } // eslint-disable-line global-require
  // The person is told, in the bell, what changed.
  if (emp.userId && (r.deptChanged || r.roleChanged)) {
    try {
      const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
      const bits = [r.deptChanged && `department ${r.dept}`, r.roleChanged && `role ${r.role.label}`, done.seat && `seat ${done.seat}`].filter(Boolean);
      await notifyUsers([emp.userId], { title: 'Your role or department was updated', message: `You were moved: ${bits.join(', ')}.`, exceptUserId: actor.id });
    } catch (e) { /* a missed bell never undoes a transfer */ }
  }
  return { seat: done.seat };
}

async function nameOf(id) {
  const e = await prisma.employee.findUnique({ where: { id }, select: { name: true } }).catch(() => null);
  return e ? e.name : id;
}
function lineDiff(p) {
  const out = [];
  if (p.data.tl !== undefined && (p.data.tl || '') !== (p.from.tl || '')) out.push({ field: 'tl', label: 'TL', from: p.from.tl, to: p.data.tl });
  if (p.data.stl !== undefined && (p.data.stl || '') !== (p.from.stl || '')) out.push({ field: 'stl', label: 'STL', from: p.from.stl, to: p.data.stl });
  if (p.data.reportingManagerId !== undefined && (p.data.reportingManagerId || null) !== (p.from.reportingManagerId || null)) {
    out.push({ field: 'reportingManagerId', label: 'Reporting manager', from: p.from.reportingManagerId || '', to: p.data.reportingManagerId || '' });
  }
  return out;
}

module.exports = { planTransfer, applyTransfer, roleOptions, currentRoleOf, seatFits };
