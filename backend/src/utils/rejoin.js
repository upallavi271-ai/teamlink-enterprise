// ---------------------------------------------------------------------------
// REJOIN EMPLOYEE (founder, 2026-10-15): "Employee TL424 rejoined on the 5th Oct but she is shown as EXITED /
// Relieved. How do I retrieve the rejoining?"
//
// ONE PERSON, ONE ID, ONE HISTORY. A person who comes back keeps the SAME Employee row and code (TL424) and every old
// record. Nothing is duplicated and nothing old is deleted. What a rejoin writes (all in ONE database transaction):
//
//   Employee            employmentStatus -> Active, offboarding flags cleared, the new department / designation / team /
//                       TL / STL / work location / employee type. dateOfJoining is NOT changed: it stays the FIRST joining
//                       date ("First joined on"); the new stint is stored separately (below).
//   EmployeeRecord      ONE new record, type REJOINING, status Done: date = the rejoining date, plus (in `notes`, JSON)
//                       the old and the new values, the gap and everything needed to undo. This record IS the
//                       "Rejoined on <date>" fact every screen reads (utils/rejoin.js info()).
//   EmployeeRecord      the old RESIGNATION record is KEPT (status stays Relieved); a line "Rejoined on <date>" is added to it.
//   PositionAssignment  the new seat tenure from the rejoining date (an earlier ended tenure stays in the seat history);
//                       a seat whose holder has left is released on that person's last working day first.
//   User (when linked)  status Active again, lock cleared, department / scope / team / branch follow the new desk.
//                       The password is NOT touched and none is made: a person with no login is told "needs a login".
//   AppSetting          the person's "switch off former access" entry (utils/formerAccess.js) is removed.
//   AuditLog            rejoin + department change + seat change (3 rows when all three apply).
//   After the commit    a bell and an information task to every Super Admin. No e-mail, no SMS.
//
// THE GAP. The days between the last working day of the earlier stint and the day before the rejoining date are stored as
// `gap` in the REJOINING record's notes. The day engine (utils/attendanceDays.js loadDays) reads them as 'Left' (not
// counted), so a person who came back is not shown absent (or charged LOP) for the months they were away.
//
// NOT TOUCHED: leave balances (the LeaveBalance rows carry on as they are; no new yearly credit is invented), past leave,
// past attendance, payslips and payroll runs, the exit / full & final records.
//
// UNDO (Admin / Super Admin): restores every field from the snapshot kept in the REJOINING record, removes the seat tenure
// this rejoin made and marks the record 'Undone'. Refused when anything has been recorded since the rejoining date.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const exitDate = require('./exitDate');
const positions = require('./positions');

const LEFT = ['Relieved', 'Exited', 'Terminated'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = (iso) => (ISO.test(String(iso || '')) ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
const iso = (v) => { try { return v ? new Date(v).toISOString().slice(0, 10) : null; } catch { return null; } };
const clean = (v, max = 200) => { const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' '); return s ? s.slice(0, max) : null; };
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TEST_RE = /zztest|example\.test/i;
const TYPE = 'REJOINING';
const MAX_FUTURE_DAYS = 30;

// A seat code's FIRST word decides its department (founder rule 2026-10-05, same table as the asset screens).
const SEAT_DEPARTMENTS = { BDE: 'BDE', MED: 'Medical', MFG: 'Manufacturing', EDU: 'Education', HR: 'HR', 'R&D': 'R&D', IHR: 'Internal HR', INTERNAL: 'Internal HR' };
const seatDeptOfCode = (code) => SEAT_DEPARTMENTS[String(code || '').toUpperCase().split(/[\s-]+/)[0]] || null;

const fail = (status, error, code) => ({ refusal: { status, error, code: code || null } });
const top = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].some((r) => [u.role, u.hrmsRole, u.atsRole, u.accountsRole].includes(r));

// ---- what we know about the earlier stint -----------------------------------------------
async function previousStint(employee) {
  const live = (await exitDate.liveRecords([employee.id])).get(employee.id) || null;
  let lastDay = live ? exitDate.dateOf(live.record, live.detail) : null;
  let source = lastDay ? 'the last working day on the exit record' : null;
  if (!lastDay) {
    const maxOf = async (m) => { const r = await m.aggregate({ where: { employeeId: employee.id }, _max: { date: true } }).catch(() => null); return r && r._max && r._max.date ? String(r._max.date).slice(0, 10) : null; };
    const days = (await Promise.all([maxOf(prisma.attendance), maxOf(prisma.attendancePunch), maxOf(prisma.attendanceHistory)])).filter(Boolean).sort();
    if (days.length) { lastDay = days[days.length - 1]; source = 'the last day with attendance (no last working day was recorded)'; }
  }
  const seats = await prisma.positionAssignment.findMany({ where: { employeeId: employee.id }, orderBy: { fromDate: 'desc' }, include: { position: { select: { id: true, code: true, department: true } } } });
  if (!lastDay) {
    const ended = seats.filter((s) => s.toDate).map((s) => s.toDate).sort().pop();
    if (ended) { lastDay = ended; source = 'the end of the last seat'; }
  }
  if (!lastDay && employee.dateOfJoining) { lastDay = iso(employee.dateOfJoining); source = 'the joining date (nothing else on record)'; }
  return { live, lastDay, source, seats };
}

// ---- seats the person can be given ----------------------------------------------------
// Every ACTIVE seat of a department with who holds it. vacant = nobody, or the holder has left (they are released when this
// seat is taken). A seat of somebody on notice is not offered as free.
async function seatsOf(department) {
  if (!department) return [];
  const rows = await prisma.position.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
  const inDept = rows.filter((p) => same(p.department, department) && (!seatDeptOfCode(p.code) || same(seatDeptOfCode(p.code), department)));
  const open = await prisma.positionAssignment.findMany({
    where: { positionId: { in: inDept.map((p) => p.id) }, toDate: null },
    include: { employee: { select: { id: true, name: true, employeeCode: true, employmentStatus: true } } },
  });
  const heldBy = new Map(open.map((a) => [a.positionId, a]));
  return inDept
    .map((p) => {
      const a = heldBy.get(p.id);
      const e = a && a.employee;
      const gone = !!(e && positions.hasLeft(e.employmentStatus));
      const notice = !!(e && !gone && /notice/i.test(e.employmentStatus || ''));
      return {
        id: p.id, code: p.code, name: p.name || null, kind: p.kind, department: p.department,
        vacant: !a || gone, holder: e && !gone ? e.name : null, holderCode: e && !gone ? e.employeeCode : null, onNotice: notice,
        formerHolder: gone ? `${e.name} (${e.employeeCode}, ${e.employmentStatus})` : null,
      };
    })
    .sort((a, b) => (b.vacant ? 1 : 0) - (a.vacant ? 1 : 0) || a.code.localeCompare(b.code, undefined, { numeric: true }));
}

// ---- THE PLAN: validate everything and say what will change, writing nothing -------------
// input: { date, department, designation, team, tlId, stlId, seat, roleCode, employeeType, location, remarks }
async function prepare({ employee, actor, input = {}, today = positions.today() }) {
  const name = employee.name;
  const isDesk = exitDate.isHrDesk(actor);
  if (!actor || !isDesk) return fail(403, 'Only HR, an Admin or the Super Admin can bring someone back.', 'NOT_HR');
  if (!LEFT.includes(employee.employmentStatus)) {
    return fail(409, `${name} is not relieved or exited (the status is ${employee.employmentStatus || 'not set'}), so there is nothing to bring back.`, 'NOT_LEFT');
  }
  if ((actor.employeeId && actor.employeeId === employee.id) || (employee.userId && employee.userId === actor.id)) {
    return fail(403, 'Nobody can rejoin their own record. Ask another HR person or the Super Admin.', 'SELF');
  }
  const user = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId } }) : null;
  if (user && top(user) && !(actor.role === 'SUPER_ADMIN' && !actor.hrSuper)) {
    return fail(403, `${name} has a Super Admin or Admin login. Only a Super Admin can do this.`, 'TOP_ACCOUNT');
  }

  const stint = await previousStint(employee);
  // HR may state the earlier last working day when the record has none (or a wrong one): it only moves the 'gap'.
  const prevOverride = clean(input.previousLastDay, 10);
  if (prevOverride) {
    if (!exitDate.realDate(prevOverride)) return fail(400, 'The last working day of the earlier stint must be a date.', 'PREV_DATE');
    if (iso(employee.dateOfJoining) && prevOverride < iso(employee.dateOfJoining)) return fail(400, 'The earlier last working day cannot be before the first joining date.', 'PREV_DATE');
    stint.lastDay = prevOverride; stint.source = 'the date entered by HR';
  }
  // ---- date
  const date = clean(input.date, 10);
  if (!date || !exitDate.realDate(date)) return fail(400, 'Pick the date the person rejoined.', 'DATE');
  const limit = addDays(today, MAX_FUTURE_DAYS);
  if (date > limit) return fail(400, `The rejoining date cannot be more than ${MAX_FUTURE_DAYS} days from today (${nice(limit)} at the latest).`, 'DATE_FUTURE');
  if (stint.lastDay && date < stint.lastDay) {
    return fail(400, `The rejoining date cannot be before the last working day of the earlier stint (${nice(stint.lastDay)}).`, 'DATE_BEFORE_EXIT');
  }
  const doj = iso(employee.dateOfJoining);
  if (doj && date < doj) return fail(400, `The rejoining date cannot be before the first joining date (${nice(doj)}).`, 'DATE_BEFORE_JOIN');

  // ---- department (default: the old one; must be a real one)
  const deptWanted = clean(input.department, 80) || employee.department;
  if (!deptWanted) return fail(400, 'Pick the department the person rejoins.', 'DEPARTMENT');
  const known = [
    ...(await prisma.department.findMany({ select: { name: true } }).catch(() => [])).map((d) => d.name),
    ...(await prisma.employee.findMany({ where: { department: { not: null } }, distinct: ['department'], select: { department: true } })).map((e) => e.department),
  ];
  const canonical = known.find((d) => same(d, deptWanted));
  if (!canonical) return fail(400, `There is no department called "${deptWanted}". Pick one from the list.`, 'DEPARTMENT');
  const department = canonical;
  const deptChanged = !same(department, employee.department);

  // ---- designation (custom allowed)
  const designation = clean(input.designation, 80) || employee.designation || null;
  const level = require('./reportingLine').levelOf({ designation });

  // ---- seat
  let seat = null; let formerHolder = null;
  const seatCode = clean(input.seat, 60);
  if (seatCode && !/^no seat/i.test(seatCode)) {
    const hit = await prisma.position.findFirst({ where: { code: seatCode } })
      || (await prisma.position.findMany()).find((p) => same(p.code, seatCode));
    if (!hit) return fail(404, `There is no seat called ${seatCode}.`, 'SEAT_NONE');
    const wantedDept = seatDeptOfCode(hit.code);
    if (!same(hit.department, department) || (wantedDept && !same(wantedDept, department))) {
      return fail(409, `Seat ${hit.code} belongs to ${wantedDept || hit.department || 'another department'}, not ${department}. Pick a seat of ${department}.`, 'SEAT_DEPARTMENT');
    }
    if (!hit.active) return fail(409, `Seat ${hit.code} is retired. Switch it on in Administration > Positions first, or pick another seat.`, 'SEAT_RETIRED');
    const held = await prisma.positionAssignment.findFirst({ where: { positionId: hit.id, toDate: null }, include: { employee: { select: { id: true, name: true, employmentStatus: true } } } });
    if (held && held.employeeId !== employee.id) {
      if (held.employee && positions.hasLeft(held.employee.employmentStatus)) formerHolder = held;
      else {
        const notice = held.employee && /notice/i.test(held.employee.employmentStatus || '');
        return fail(409, `Seat ${hit.code} is held by ${held.employee ? held.employee.name : 'somebody else'}${notice ? ', who is on notice' : ''}. Pick a vacant seat.`, 'SEAT_HELD');
      }
    }
    seat = hit;
  }

  // ---- team lead / senior team lead (checked against the working leads)
  const reportingLine = require('./reportingLine');
  let tl = null; let stl = null;
  const pickLead = async (id, kind) => {
    if (!id) return null;
    const e = await prisma.employee.findUnique({ where: { id: String(id) }, select: { id: true, name: true, employeeCode: true, employmentStatus: true, department: true } });
    if (!e) return { error: `The ${kind} you picked was not found.` };
    if (e.id === employee.id) return { error: 'A person cannot report to themselves.' };
    const why = await reportingLine.problemFor({ id: employee.id, department, level }, { managerId: e.id }, { cross: true });
    if (why) return { error: `${e.name}: ${why}` };
    return e;
  };
  const t1 = await pickLead(input.tlId, 'team lead');
  if (t1 && t1.error) return fail(409, t1.error, 'TL');
  const t2 = await pickLead(input.stlId, 'senior team lead');
  if (t2 && t2.error) return fail(409, t2.error, 'STL');
  tl = t1; stl = t2;

  // ---- login role (only when the person has a login)
  let roleCode = clean(input.roleCode, 60);
  if (roleCode) {
    const reg = require('./roleRegistry');
    const role = await reg.roleByCode(roleCode).catch(() => null);
    if (!role || role.external) return fail(400, 'Pick a role from the list.', 'ROLE');
    roleCode = role.code;
    if (user && user.role !== roleCode) {
      const why = await require('./roleGuard').checkRoleChange({ actor, current: user, next: { role: roleCode } });
      if (why) return fail(403, why, 'ROLE_GUARD');
    } else if (user) roleCode = null; // same role: nothing to change
  }
  const empTypes = require('./adminCatalog').EMP_TYPES;
  // A typed employee type is kept (same rule as the Add / Edit employee form); a listed one is matched without regard to capitals.
  const typedType = clean(String(input.employeeType == null ? '' : input.employeeType).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' '), 40);
  const employeeType = (typedType && (empTypes.find((t) => same(t, typedType)) || typedType)) || employee.employeeType || null;
  const location = clean(input.location, 80) || null;
  const remarks = clean(input.remarks, 400);

  // ---- the new employee fields
  const keepLeads = !deptChanged;
  const next = {
    employmentStatus: 'Active', offboardingStatus: null, offboardingTasks: null,
    department, designation,
    team: input.team !== undefined && input.team !== null ? clean(input.team, 60) : (deptChanged ? null : employee.team),
    tl: tl ? tl.name : (keepLeads ? employee.tl : null),
    stl: stl ? stl.name : (keepLeads ? employee.stl : null),
    reportingManagerId: tl ? tl.id : (stl ? stl.id : (keepLeads ? employee.reportingManagerId : null)),
    employeeType,
    ...(location ? { location, branch: location } : {}),
  };
  const gap = stint.lastDay && addDays(stint.lastDay, 1) <= addDays(date, -1) ? { from: addDays(stint.lastDay, 1), to: addDays(date, -1) } : null;
  const warnings = [];
  if (!user) warnings.push('needs login: this person has no login. Make one from the profile (Create login) once the details are right; it follows the new department and designation.');
  else if (user.status === 'Suspended') warnings.push('the login is Suspended (set on purpose by an Admin) and stays Suspended; an Admin can switch it on.');
  if (deptChanged && !tl && !stl) warnings.push(`team lead / senior team lead to be assigned (the old ones belonged to ${employee.department || 'the old department'}).`);
  if (!seat) warnings.push('seat to be assigned (none was chosen).');
  if (!designation) warnings.push('designation is empty.');
  return {
    plan: {
      employee, user, date, department, deptChanged, designation, next, seat, formerHolder, tl, stl, roleCode, location, remarks, employeeType,
      stint, gap, warnings, today,
    },
  };
}

// What the plan changes, as plain before/after pairs (the dry run prints this; the dialog summary reads it).
function changesOf(plan) {
  const { employee, next, user } = plan;
  const out = [];
  const put = (table, field, from, to) => { if (String(from == null ? '' : from) !== String(to == null ? '' : to)) out.push({ table, field, from: from == null ? '' : from, to: to == null ? '' : to }); };
  Object.keys(next).forEach((k) => put('Employee', k, employee[k], next[k]));
  if (user) {
    put('User', 'status', user.status, user.status === 'Inactive' ? 'Active' : user.status);
    put('User', 'atsDepartment', user.atsDepartment, plan.department);
    put('User', 'team', user.team, next.team);
    if (plan.roleCode) put('User', 'role', user.role, plan.roleCode);
  }
  return out;
}

// ---- THE APPLY --------------------------------------------------------------------------
const running = new Set();
async function apply({ plan, actor, testFail = false, notify = true }) {
  const { employee, user } = plan;
  if (running.has(employee.id)) throw Object.assign(new Error(`${employee.name} is already being saved. Please wait a moment.`), { status: 409, exitBlocked: true });
  running.add(employee.id);
  try {
    const who = actor.name || actor.email || 'HR';
    const day = plan.date;
    const stamp = new Date().toISOString();
    const manifest = {
      v: 1, at: stamp, by: { id: actor.id || null, name: who }, date: day, gap: plan.gap, previousLastDay: plan.stint.lastDay, previousLastDaySource: plan.stint.source,
      before: {
        employee: Object.fromEntries(Object.keys(plan.next).concat(['isLocked', 'unlockExpiresAt']).map((k) => [k, employee[k] instanceof Date ? employee[k].toISOString() : (employee[k] === undefined ? null : employee[k])])),
        user: user ? { status: user.status, lockedUntil: user.lockedUntil ? user.lockedUntil.toISOString() : null, failedLoginCount: user.failedLoginCount, atsDepartment: user.atsDepartment, atsScopeDepartments: user.atsScopeDepartments, team: user.team, branch: user.branch, role: user.role, hrmsRole: user.hrmsRole, atsRole: user.atsRole } : null,
        formerOff: null, exitRecord: null,
      },
      after: { department: plan.department, designation: plan.designation, seat: plan.seat ? plan.seat.code : null, tl: plan.next.tl, stl: plan.next.stl },
      created: { assignmentId: null, auditIds: [] }, closed: { holder: null }, needsLogin: !user,
    };
    let recordId = null;
    // Reads that need the shared connection are done BEFORE the transaction (a transaction holds the database).
    let holderEnd = null;
    if (plan.formerHolder) {
      const h = plan.formerHolder;
      const hEmp = await prisma.employee.findUnique({ where: { id: h.employeeId }, select: { id: true, name: true, employmentStatus: true, updatedAt: true } });
      const ev = await require('./seatRelease').endDateFor(hEmp, h, { live: false });
      holderEnd = ev.date < h.fromDate ? h.fromDate : ev.date;
      manifest.closed.holderEvidence = ev.source;
    }
    await prisma.$transaction(async (tx) => {
      // 1) the earlier exit record: keep it, add the line
      const exit = plan.stint.live ? plan.stint.live.record : null;
      const line = `Rejoined on ${nice(day)} (by ${who}): back as ${plan.designation || 'staff'}${plan.department ? ` in ${plan.department}` : ''}. The employee keeps the same ID.`;
      if (exit) {
        manifest.before.exitRecord = { id: exit.id, detail: exit.detail };
        await tx.employeeRecord.update({ where: { id: exit.id }, data: { detail: [exit.detail, line].filter(Boolean).join('\n').slice(0, 1900) } });
      }
      // 2) the seat
      if (plan.seat) {
        const others = await tx.positionAssignment.findMany({ where: { employeeId: employee.id, toDate: null } });
        for (const o of others) {
          // eslint-disable-next-line no-await-in-loop
          await tx.positionAssignment.update({ where: { id: o.id }, data: { toDate: o.fromDate > addDays(day, -1) ? o.fromDate : addDays(day, -1), note: o.note || `Ended: rejoined into ${plan.seat.code}` } });
        }
        let from = day;
        if (plan.formerHolder) {
          const h = plan.formerHolder;
          const end = holderEnd;
          if (end >= from) from = addDays(end, 1); // never rewrite the earlier holder's days: the new tenure starts the day after
          manifest.closed.holder = { id: h.id, toDate: h.toDate, note: h.note };
          await tx.positionAssignment.update({ where: { id: h.id }, data: { toDate: end, note: `Seat released for a rejoining employee (${employee.name}, ${employee.employeeCode}). ${h.note || ''}`.trim().slice(0, 500) } });
        }
        const made = await tx.positionAssignment.create({ data: { positionId: plan.seat.id, employeeId: employee.id, fromDate: from, note: `Rejoined on ${nice(day)}` } });
        manifest.created.assignmentId = made.id;
        manifest.seatFrom = from;
      }
      // 3) the employee
      const empBefore = employee.employmentStatus;
      await exitFlowOverride(() => tx.employee.update({ where: { id: employee.id }, data: plan.next }));
      // 4) the login
      if (user) {
        const data = { lockedUntil: null, failedLoginCount: 0, atsDepartment: plan.department, team: plan.next.team || null };
        if (user.status === 'Inactive') data.status = 'Active';
        if (plan.location) data.branch = plan.location;
        const scope = String(user.atsScopeDepartments || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (scope.length === 0 || (scope.length === 1 && same(scope[0], employee.department))) data.atsScopeDepartments = plan.department;
        if (plan.roleCode) {
          data.role = plan.roleCode;
          if (!user.hrmsRole || user.hrmsRole === user.role) data.hrmsRole = plan.roleCode;
          if (!user.atsRole || user.atsRole === user.role) data.atsRole = plan.roleCode;
        }
        await tx.user.update({ where: { id: user.id }, data });
        const off = await tx.appSetting.findUnique({ where: { key: 'former-access' } });
        if (off) {
          try {
            const v = JSON.parse(off.value || '{}');
            const list = Array.isArray(v.off) ? v.off : [];
            if (list.some((x) => x && x.userId === user.id)) {
              manifest.before.formerOff = list.filter((x) => x && x.userId === user.id);
              await tx.appSetting.update({ where: { key: 'former-access' }, data: { value: JSON.stringify({ ...v, off: list.filter((x) => !(x && x.userId === user.id)) }) } });
            }
          } catch { /* unreadable setting: left alone */ }
        }
      }
      // 5) the record that says "rejoined"
      const rec = await tx.employeeRecord.create({
        data: {
          type: TYPE, employeeId: employee.id, title: `Rejoined on ${nice(day)}`.slice(0, 200), status: 'Done', date: day,
          detail: [
            `First joined ${nice(iso(employee.dateOfJoining)) || 'on record'}. Earlier stint ended ${plan.stint.lastDay ? nice(plan.stint.lastDay) : '(date not known)'}.`,
            `Rejoined ${nice(day)} as ${plan.designation || 'staff'}, ${plan.department}${plan.seat ? `, seat ${plan.seat.code}` : ', seat to be assigned'}.`,
            plan.remarks ? `Remarks: ${plan.remarks}` : null,
          ].filter(Boolean).join('\n').slice(0, 1900),
          fromName: employee.department || null, toName: plan.department, category: plan.designation || null, location: plan.location || employee.location || null,
          raisedBy: who, resolution: plan.remarks || null, notes: '',
        },
      });
      recordId = rec.id;
      manifest.recordId = rec.id;
      // 6) audit: rejoin, department change, seat change
      const mk = async (data) => { const a = await tx.auditLog.create({ data: { userId: actor.id || null, actorName: who, ...data } }); manifest.created.auditIds.push(a.id); };
      await mk({ entity: 'Employee', entityId: employee.id, field: 'employmentStatus', fieldLabel: 'Status', action: `Employee rejoined on ${nice(day)}`, fromValue: empBefore, toValue: 'Active', reason: `${employee.name} (${employee.employeeCode}) rejoined on ${nice(day)}; same ID, history kept${plan.remarks ? `. ${plan.remarks}` : ''}`.slice(0, 480) });
      if (plan.deptChanged) await mk({ entity: 'Employee', entityId: employee.id, field: 'department', fieldLabel: 'Department', action: 'Department changed (rejoin)', fromValue: employee.department || '(none)', toValue: plan.department, reason: `Rejoined on ${nice(day)}` });
      if (plan.seat) await mk({ entity: 'Employee', entityId: employee.id, field: 'position', fieldLabel: 'Position', action: 'Position changed (rejoin)', fromValue: '(none)', toValue: `${plan.seat.code} from ${manifest.seatFrom}`, reason: `Rejoined on ${nice(day)}` });
      await tx.employeeRecord.update({ where: { id: rec.id }, data: { notes: JSON.stringify(manifest) } });
      if (testFail) throw new Error('Forced failure (test)');
    }, { timeout: 20000, maxWait: 10000 });

    // After the commit: the designation's role (when it changed and no role was named), the bell and the task.
    let roleSync = null;
    if (user && !plan.roleCode && plan.designation && !same(plan.designation, employee.designation)) {
      try {
        const fresh = await prisma.employee.findUnique({ where: { id: employee.id } });
        roleSync = await require('./employeeAdmin').syncLoginToEmployee(fresh, employee, { designationChanged: true, actor });
      } catch (e) { roleSync = { error: String(e && e.message) }; }
    }
    let told = 0;
    if (notify) {
      try {
        const exitFlow = require('./exitFlow');
        const sas = (await exitFlow.superAdmins({ allowTest: exitFlow.isTest(employee.name, employee.email) || exitFlow.isTest(actor.name, actor.email) })).filter((s) => s.id !== actor.id);
        const text = `${employee.name} rejoined on ${nice(day)}, ${plan.department}, by ${who}.`;
        const out = await exitFlow.tell({ userIds: sas.map((s) => s.id), title: `${employee.name} rejoined`, message: text, link: `/employees?emp=${employee.id}`, key: `${recordId}:rejoined`, email: false });
        told = out.told.length;
        for (const a of sas.filter((s) => out.told.includes(s.id))) {
          // eslint-disable-next-line no-await-in-loop
          const t = await prisma.task.create({ data: { name: `Info: ${employee.name} rejoined on ${nice(day)}`.slice(0, 190), department: 'HR', description: text, status: 'Not Started', priority: 'Low', assigneeId: a.id, assignedById: actor.id || a.id, assigneeName: a.name, assignedByName: `${who} (HR)` } }).catch(() => null);
          if (t) { manifest.created.taskIds = (manifest.created.taskIds || []).concat(t.id); }
        }
        if (manifest.created.taskIds) await prisma.employeeRecord.update({ where: { id: recordId }, data: { notes: JSON.stringify(manifest) } }).catch(() => null);
      } catch (e) { console.error('[rejoin] notice failed:', e && e.message); } // eslint-disable-line no-console
    }
    return { recordId, manifest, told, roleSync, needsLogin: !user, seat: plan.seat ? plan.seat.code : null, seatFrom: manifest.seatFrom || null, gap: plan.gap };
  } finally { running.delete(employee.id); }
}
// The Prisma exit guard only judges LEAVING statuses; Active passes. Kept as a function so a future guard has one place.
const exitFlowOverride = (fn) => require('./exitFlow').withOverride(fn);

// ---- INFO: what the screens read ----------------------------------------------------------
// { rejoined, firstJoined, rejoinedOn, previousLastDay, gap, recordId, department, canUndo } or { rejoined:false, firstJoined }
async function info(employeeId) {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { dateOfJoining: true } });
  const rows = await prisma.employeeRecord.findMany({ where: { type: TYPE, employeeId, status: 'Done' }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
  const firstJoined = e ? iso(e.dateOfJoining) : null;
  if (!rows.length) return { rejoined: false, firstJoined, history: [] };
  let m = {};
  try { m = JSON.parse(rows[0].notes || '{}'); } catch { m = {}; }
  return {
    rejoined: true, firstJoined, rejoinedOn: rows[0].date, previousLastDay: m.previousLastDay || null, gap: m.gap || null, recordId: rows[0].id,
    department: rows[0].toName || null, designation: rows[0].category || null, by: m.by ? m.by.name : rows[0].raisedBy || null,
    text: `First joined ${nice(firstJoined)} · Rejoined ${nice(rows[0].date)}`,
    history: rows.map((r) => ({ id: r.id, date: r.date, title: r.title })),
  };
}

// ---- UNDO ------------------------------------------------------------------------------------
async function undoRefusal(recordId, { force = false } = {}) {
  const rec = await prisma.employeeRecord.findUnique({ where: { id: recordId } });
  if (!rec || rec.type !== TYPE) return { status: 404, error: 'That rejoin record was not found.' };
  if (rec.status !== 'Done') return { status: 409, error: 'This rejoin was already undone.' };
  let m = null;
  try { m = JSON.parse(rec.notes || 'null'); } catch { m = null; }
  if (!m || !m.before) return { status: 409, error: 'This rejoin has no saved snapshot, so it cannot be undone automatically.' };
  if (!force) {
    const day = rec.date;
    const later = [
      ['attendance', await prisma.attendance.count({ where: { employeeId: rec.employeeId, date: { gte: day } } })],
      ['punches', await prisma.attendancePunch.count({ where: { employeeId: rec.employeeId, date: { gte: day } } })],
      ['leave requests', await prisma.leaveRequest.count({ where: { employeeId: rec.employeeId, toDate: { gte: day } } }).catch(() => 0)],
      ['payslips', await prisma.payslip.count({ where: { employeeId: rec.employeeId, createdAt: { gte: rec.createdAt } } }).catch(() => 0)],
    ].filter(([, n]) => n > 0);
    if (later.length) return { status: 409, code: 'ACTIVITY', error: `Cannot undo: since rejoining there are ${later.map(([k, n]) => `${n} ${k}`).join(', ')} recorded. Undo only works before anything else is recorded.` };
  }
  return null;
}
async function undo({ recordId, actor, force = false }) {
  const bad = await undoRefusal(recordId, { force });
  if (bad) throw Object.assign(new Error(bad.error), { status: bad.status, code: bad.code });
  const rec = await prisma.employeeRecord.findUnique({ where: { id: recordId } });
  const m = JSON.parse(rec.notes);
  const who = (actor && (actor.name || actor.email)) || 'System';
  const employee = await prisma.employee.findUnique({ where: { id: rec.employeeId } });
  await prisma.$transaction(async (tx) => {
    if (m.created && m.created.assignmentId) await tx.positionAssignment.deleteMany({ where: { id: m.created.assignmentId } });
    if (m.closed && m.closed.holder) await tx.positionAssignment.update({ where: { id: m.closed.holder.id }, data: { toDate: m.closed.holder.toDate, note: m.closed.holder.note } }).catch(() => null);
    const b = { ...m.before.employee };
    delete b.isLocked; delete b.unlockExpiresAt;
    await exitFlowOverride(() => tx.employee.update({ where: { id: rec.employeeId }, data: b }));
    if (m.before.user && employee.userId) {
      const u = m.before.user;
      await tx.user.update({ where: { id: employee.userId }, data: { status: u.status, lockedUntil: u.lockedUntil ? new Date(u.lockedUntil) : null, failedLoginCount: u.failedLoginCount || 0, atsDepartment: u.atsDepartment, atsScopeDepartments: u.atsScopeDepartments, team: u.team, branch: u.branch, role: u.role, hrmsRole: u.hrmsRole, atsRole: u.atsRole } });
    }
    if (m.before.formerOff && m.before.formerOff.length) {
      const off = await tx.appSetting.findUnique({ where: { key: 'former-access' } });
      if (off) { const v = JSON.parse(off.value || '{}'); await tx.appSetting.update({ where: { key: 'former-access' }, data: { value: JSON.stringify({ ...v, off: [...(Array.isArray(v.off) ? v.off : []), ...m.before.formerOff] }) } }); }
    }
    if (m.before.exitRecord) await tx.employeeRecord.update({ where: { id: m.before.exitRecord.id }, data: { detail: m.before.exitRecord.detail } });
    await tx.employeeRecord.update({ where: { id: recordId }, data: { status: 'Undone', title: `Rejoin undone (was ${nice(rec.date)})`.slice(0, 200) } });
    await tx.auditLog.create({ data: { userId: actor && actor.id ? actor.id : null, actorName: who, entity: 'Employee', entityId: rec.employeeId, field: 'employmentStatus', fieldLabel: 'Status', action: `Rejoin undone (${nice(rec.date)})`, fromValue: 'Active', toValue: m.before.employee.employmentStatus, reason: `Undone by ${who}` } });
  }, { timeout: 20000, maxWait: 10000 });
  return { ok: true, restoredStatus: m.before.employee.employmentStatus, manifest: m };
}

// ---- OPTIONS for the dialog (one call; department-specific parts refetched on change) ----------
async function optionsFor({ employee, actor, department = null }) {
  const stint = await previousStint(employee);
  const dept = clean(department, 80) || employee.department || null;
  const [depts, desigs, roles, leads, seats] = await Promise.all([
    prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }).catch(() => []),
    require('./employeeAdmin').designationRows().catch(() => []),
    require('./roleRegistry').listRoles({ activeOnly: true }).catch(() => []),
    dept ? require('./reportingLine').candidatesFor({ department: dept, level: 'STAFF', excludeId: employee.id, cross: true }).catch(() => ({ options: [] })) : { options: [] },
    seatsOf(dept),
  ]);
  const inUse = (await prisma.employee.findMany({ where: { department: { not: null } }, distinct: ['department'], select: { department: true } })).map((e) => e.department);
  const user = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId }, select: { role: true, status: true } }) : null;
  const locs = (await prisma.employee.findMany({ where: { location: { not: null } }, distinct: ['location'], select: { location: true } })).map((e) => e.location);
  const today = positions.today();
  return {
    today, maxDate: addDays(today, MAX_FUTURE_DAYS), minDate: stint.lastDay || iso(employee.dateOfJoining) || null, previousLastDay: stint.lastDay, previousLastDaySource: stint.source,
    firstJoined: iso(employee.dateOfJoining),
    current: { department: employee.department, designation: employee.designation, team: employee.team, tl: employee.tl, stl: employee.stl, location: employee.location, employeeType: employee.employeeType, status: employee.employmentStatus },
    departments: [...new Set([...depts.map((d) => d.name), ...inUse])].sort((a, b) => a.localeCompare(b)),
    designations: [...new Set(desigs.map((r) => r.designation).concat(employee.designation ? [employee.designation] : []))].filter(Boolean).sort((a, b) => a.localeCompare(b)),
    roles: roles.filter((r) => !r.external).map((r) => ({ code: r.code, name: r.name })),
    currentRole: user ? user.role : null,
    hasLogin: !!user,
    leads: (leads.options || []).map((o) => ({ id: o.id, name: o.name, role: o.role, department: o.department, label: o.label })),
    seats: seats.map((s) => ({ code: s.code, name: s.name, vacant: s.vacant, holder: s.holder, formerHolder: s.formerHolder, onNotice: s.onNotice })),
    employeeTypes: require('./adminCatalog').EMP_TYPES,
    locations: [...new Set([...locs, 'Hyderabad', 'Bengaluru', 'Pune'])].sort((a, b) => a.localeCompare(b)),
    department: dept,
    allowed: exitDate.isHrDesk(actor) && LEFT.includes(employee.employmentStatus),
  };
}

module.exports = {
  LEFT, TYPE, MAX_FUTURE_DAYS, SEAT_DEPARTMENTS, seatDeptOfCode, previousStint, seatsOf, prepare, changesOf, apply, info, undo, undoRefusal, optionsFor, nice, addDays, TEST_RE,
};
