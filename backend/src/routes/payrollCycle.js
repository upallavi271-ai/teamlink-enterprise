// ---------------------------------------------------------------------------
// PAYROLL CYCLE + ABSENT-WITHOUT-LEAVE routes (user, 2026-10-12), registered on
// the /api/payroll router (routes/payroll.js), which has already authenticated.
//
//   GET  /cycle                the settings, the month list with NAMES and DATE RANGES
//   PUT  /cycle                save the cycle / the absent rule (Super Admin / Admin only)
//   GET  /cycle/precheck?month=   "Pending leaves that affect pay" + absent-without-leave days
//   GET  /cycle/lop-summary?month=&format=csv|xlsx   LOP split: leave-based vs absent without leave
//   GET  /cycle/my-absences    the caller's own absent-without-leave days (the gentle banner)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { can, DENIED } = require('../utils/permissions');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');
const { logAudit } = require('../utils/audit');
const E = require('../utils/payrollEngine');
const PC = require('../utils/payrollCycle');
const ANL = require('../utils/absentNoLeave');
const D = require('../utils/attendanceDays');
const { toCsv, toXlsx } = require('../utils/tabularExport');

const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.hrmsRole);

module.exports = function registerPayrollCycle(router, { payrollEmployeeWhere }) {
  async function canView(req) {
    const u = req.user;
    const flags = await Promise.all([
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'create'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'approve'),
      can(u, 'hrms', 'hrms', 'Payroll & Compensation', 'export'),
      can(u, 'accounts', 'accounts', 'Journal & Ledger', 'view'),
    ]);
    return flags.some(Boolean);
  }
  const desk = async (req, res, next) => {
    try { return (await canView(req)) ? next() : res.status(403).json(DENIED); } catch (err) { return next(err); }
  };

  // The months to pick from: this payroll month and the previous ones, newest first,
  // with the state of the payroll behind each.
  async function monthRows(settings, { back = 14, forward = 1 } = {}) {
    const today = D.localDate();
    const cur = (PC.monthOfDate(today, settings.cycle) || { month: today.slice(0, 7), months: [today.slice(0, 7)] });
    const latest = PC.addMonths(cur.months[cur.months.length - 1], forward);
    const earliest = PC.addMonths(latest, -(back + forward));
    const list = PC.monthList(settings.cycle, { from: earliest, to: latest });
    const runs = await prisma.payrollRun.findMany({ where: { month: { gte: earliest, lte: latest } }, select: { month: true, status: true, employees: true } });
    const runOf = new Map(runs.map((r) => [r.month, r]));
    return list.map((c) => ({
      key: c.key, name: c.name, label: c.label, longLabel: c.longLabel, from: c.from, to: c.to, days: c.days, custom: c.custom,
      rangeText: c.rangeText, heading: c.heading, title: c.title,
      status: runOf.has(c.key) ? runOf.get(c.key).status : null, employees: runOf.has(c.key) ? runOf.get(c.key).employees : 0,
      current: cur.months.includes(c.key),
    }));
  }

  router.get('/cycle', async (req, res) => {
    const settings = await PC.getSettings({ fresh: true });
    const months = await monthRows(settings);
    res.json({
      settings: { cycle: settings.cycle, absent: settings.absent, saved: settings.saved },
      canEdit: isAdmin(req.user),
      months,
      current: months.find((m) => m.current) || null,
      text: {
        cycle: 'A payroll month runs from the start day of the previous month to the day before it, and is named after the month it ends in.',
        absent: 'A working day absent with no leave applied counts as extra loss-of-pay days, valued from the monthly salary.',
      },
    });
  });

  router.put('/cycle', async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only Super Admin or Admin can change the payroll cycle.' });
    const body = req.body || {};
    const actor = { id: req.user.id, name: req.user.name || req.user.email };
    const before = await PC.getSettings({ fresh: true });
    const out = { };
    if (body.cycle) {
      const r = await PC.saveCycle(body.cycle, actor);
      if (r.error) return res.status(400).json({ error: r.error });
      out.cycle = r.cycle;
    }
    if (body.absent) {
      const r = await PC.saveAbsentRule(body.absent, actor);
      if (r.error) return res.status(400).json({ error: r.error });
      out.absent = r.absent;
    }
    const after = await PC.getSettings({ fresh: true });
    await logAudit({
      userId: req.user.id, actorName: actor.name, action: 'Payroll cycle settings changed', entity: 'AppSetting', entityId: PC.CYCLE_KEY,
      fromValue: JSON.stringify({ cycle: before.cycle, absent: before.absent }), toValue: JSON.stringify({ cycle: after.cycle, absent: after.absent }),
    });
    // What the owner should know: payrolls already beyond draft inside the new range keep their money.
    const notes = [];
    if (after.cycle.startDay > 1) {
      const locked = await prisma.employeePayrollRun.groupBy({ by: ['month'], where: { month: { gte: after.cycle.effectiveFrom }, status: { not: 'DRAFT' } }, _count: { _all: true } });
      if (locked.length) notes.push(`${locked.length} payroll month(s) from ${PC.cycleOf(after.cycle.effectiveFrom, after.cycle).label} on are already paid or approved: their money is NOT changed, only the dates shown beside them.`);
      const first = PC.cycleOf(after.cycle.effectiveFrom, after.cycle);
      const prev = PC.cycleOf(PC.addMonths(after.cycle.effectiveFrom, -1), after.cycle);
      const gap = PC.overlapDays(first, prev);
      if (gap > 0 && !(await prisma.employeePayrollRun.count({ where: { month: first.key } }))) {
        notes.push(`${first.label} (${first.rangeText}) overlaps ${gap} day(s) of ${prev.label} (${prev.rangeText}) that were already paid. Set "First period starts on" to ${PC.addDays(prev.to, 1)} so nothing is paid twice.`);
      }
    }
    return res.json({ settings: { cycle: after.cycle, absent: after.absent, saved: after.saved }, notes });
  });

  // ---- The check before locking: pending leaves + absent days --------------------------------
  router.get('/cycle/precheck', desk, async (req, res) => {
    const month = req.query.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const settings = await PC.getSettings();
    const cycle = PC.cycleOf(month, settings.cycle);
    const rule = PC.absentRuleFor(month, settings.absent);
    const where = { AND: [payrollEmployeeWhere(req), { employmentStatus: { in: E.PAYABLE_STATUSES } }, NOT_SYSTEM_EMPLOYEE] };
    const employees = await prisma.employee.findMany({ where, orderBy: { name: 'asc' }, select: { id: true, name: true, employeeCode: true, department: true } });
    const ids = employees.map((e) => e.id);
    const nameOf = new Map(employees.map((e) => [e.id, e]));
    const pend = await prisma.leaveRequest.findMany({
      where: { employeeId: { in: ids }, status: 'Pending', fromDate: { lte: cycle.to }, toDate: { gte: cycle.from } },
      orderBy: { fromDate: 'asc' },
      select: { id: true, employeeId: true, type: true, fromDate: true, toDate: true, days: true, reason: true },
    });
    const pendingLeaves = pend.map((l) => {
      const from = String(l.fromDate).slice(0, 10) < cycle.from ? cycle.from : String(l.fromDate).slice(0, 10);
      const to = String(l.toDate).slice(0, 10) > cycle.to ? cycle.to : String(l.toDate).slice(0, 10);
      const e = nameOf.get(l.employeeId) || {};
      return {
        id: l.id, employeeId: l.employeeId, name: e.name, employeeCode: e.employeeCode, department: e.department, type: l.type,
        from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10), daysInThisPayroll: D.eachDay(from, to).length, days: l.days,
        effect: 'Until it is approved these days are unpaid (loss of pay). Approve it and recalculate to pay them.',
      };
    });
    let absentNoLeave = [];
    if (rule.active) {
      const policy = await E.getPolicy();
      const { map } = await E.attendanceDefaults(employees, month, policy);
      absentNoLeave = employees.map((e) => ({ e, a: (map.get(e.id) || {}).awl })).filter((x) => x.a && (x.a.days || x.a.halfDays))
        .map(({ e, a }) => ({
          employeeId: e.id, name: e.name, employeeCode: e.employeeCode, department: e.department,
          dates: a.dates, halfDates: a.halfDates, days: a.days, halfDays: a.halfDays, lopDays: a.lop, text: ANL.lineText(a),
        }));
    }
    res.json({
      month, cycle: { label: cycle.label, from: cycle.from, to: cycle.to, days: cycle.days, rangeText: cycle.rangeText, heading: cycle.heading },
      absentRule: rule, pendingLeaves, absentNoLeave,
      note: rule.active
        ? `A day absent with no leave applied counts as ${rule.days} LOP days. If a leave is approved for that day before the payroll is locked, recalculate: the leave decides instead.`
        : 'The absent-without-leave rule is not on for this payroll month.',
    });
  });

  // ---- LOP summary per payroll month -----------------------------------------------------------
  router.get('/cycle/lop-summary', desk, async (req, res) => {
    const month = req.query.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    const settings = await PC.getSettings();
    const cycle = PC.cycleOf(month, settings.cycle);
    const entries = await prisma.employeePayrollRun.findMany({
      where: { month, employee: payrollEmployeeWhere(req) },
      include: { employee: { select: { name: true, employeeCode: true, department: true } } },
      orderBy: { employee: { name: 'asc' } },
    });
    const snap = await E.readSnapshot(month);
    const rows = entries.map((e) => {
      const a = snap && snap.people && snap.people[e.employeeId] ? snap.people[e.employeeId].awl : null;
      const awlLop = a ? a.lop : 0;
      const base = Number(e.grossPay || 0) - Number(e.incentive || 0) - Number(e.arrears || 0); // the full-month pay the per-day rate comes from (no incentive / arrears)
      const perDay = e.workingDays > 0 ? base / e.workingDays : 0;
      return {
        employeeId: e.employeeId, code: e.employee.employeeCode, name: e.employee.name, department: e.employee.department, status: e.status,
        workingDays: e.workingDays, lopDays: e.daysLop, awlDays: a ? a.days + (a.halfDays || 0) : 0, awlLopDays: awlLop,
        leaveLopDays: Math.max(0, Math.round((e.daysLop - awlLop) * 100) / 100),
        awlAmount: Math.round(perDay * awlLop), lopAmount: e.lopDeduction,
        awlDates: a ? [...(a.dates || []), ...(a.halfDates || [])].join(' ') : '',
      };
    });
    const sum = (k) => Math.round(rows.reduce((n, r) => n + (Number(r[k]) || 0), 0) * 100) / 100;
    const totals = { employees: rows.length, lopDays: sum('lopDays'), awlDays: sum('awlDays'), awlLopDays: sum('awlLopDays'), leaveLopDays: sum('leaveLopDays'), awlAmount: sum('awlAmount'), lopAmount: sum('lopAmount') };
    const fmt = req.query.format;
    if (fmt === 'csv' || fmt === 'xlsx') {
      const headers = ['Code', 'Employee', 'Department', 'Status', 'Pay days in period', 'Total LOP days', 'LOP days from leave (unpaid / pending / late etc.)',
        'Absent-without-leave days', 'LOP days from it', 'Amount from it (Rs)', 'Total LOP amount (Rs)', 'Absent-without-leave dates'];
      const data = rows.map((r) => [r.code || '', r.name, r.department || '', r.status, r.workingDays, r.lopDays, r.leaveLopDays, r.awlDays, r.awlLopDays, r.awlAmount, r.lopAmount, r.awlDates]);
      data.push(['TOTAL', `${totals.employees} employee(s)`, '', '', '', totals.lopDays, totals.leaveLopDays, totals.awlDays, totals.awlLopDays, totals.awlAmount, totals.lopAmount, '']);
      const name = `lop-summary-${cycle.label.replace(/\s+/g, '-')}`;
      await logAudit({ userId: req.user.id, action: `LOP summary exported (${fmt.toUpperCase()})`, entity: 'EmployeePayrollRun', toValue: month });
      if (fmt === 'xlsx') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
        return res.send(toXlsx(headers, data, 'LOP summary'));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.send(toCsv(headers, data));
    }
    return res.json({ month, cycle: { label: cycle.label, rangeText: cycle.rangeText, heading: cycle.heading, from: cycle.from, to: cycle.to, days: cycle.days }, rows, totals });
  });

  // ---- The employee's own absent-without-leave days (banner on My attendance) -------------------
  router.get('/cycle/my-absences', async (req, res) => {
    const emp = await prisma.employee.findUnique({ where: { userId: req.user.id } });
    if (!emp) return res.json({ days: [], rule: null });
    const settings = await PC.getSettings();
    const today = D.localDate();
    const cur = PC.monthOfDate(today, settings.cycle);
    const curMonth = cur.months[cur.months.length - 1];
    const prevMonth = PC.addMonths(curMonth, -1);
    const prevCycle = PC.cycleOf(prevMonth, settings.cycle);
    const curCycle = PC.cycleOf(curMonth, settings.cycle);
    const rule = PC.absentRuleFor(curMonth, settings.absent);
    if (!rule.active) return res.json({ days: [], rule });
    const cfg = await E.getPolicy();
    const { days } = await D.loadDays(prisma, { employees: [emp], from: prevCycle.from, to: today < curCycle.to ? today : curCycle.to, cfg });
    const open = new Set((await prisma.employeePayrollRun.findMany({ where: { employeeId: emp.id, month: { in: [prevMonth, curMonth] }, status: { not: 'DRAFT' } }, select: { month: true } })).map((r) => r.month));
    const list = days(emp).filter((r) => r.awlKind).map((r) => {
      const mm = PC.monthOfDate(r.date, settings.cycle).months;
      const m = mm[mm.length - 1];
      return { date: r.date, kind: r.awlKind, lop: r.awlLop, text: r.awlText, payrollMonth: m, payrollLabel: PC.cycleOf(m, settings.cycle).label, canFix: !open.has(m) };
    });
    return res.json({
      rule, days: list,
      // Backdated leave applications are allowed (routes/leave.js has no past-date limit), so the deadline is the payroll being locked.
      howToFix: 'Apply leave for that day (Leave → Apply) before that payroll is locked: the leave then decides, instead of the extra loss of pay.',
    });
  });
};
