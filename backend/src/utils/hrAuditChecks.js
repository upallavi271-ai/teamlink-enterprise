// ---------------------------------------------------------------------------
// HR AUDIT CHECKS (founder 2026-11-24, from the HR audit questionnaire: the "Show employees who ..." red-flag questions, 214-223,
// 464-483, 531-538, and the KPI questions 185-189).
//
// READ-ONLY. Every check below only READS data the app already keeps and lists the people (or tickets, or departments) that look
// wrong. Nothing here writes to the database, changes a setting, sends a message or touches how any existing screen works.
// A check that cannot run returns an `error` text; the others still show.
//
//   summary()       { kpis, checks:[{ key, group, title, severity, questions, why, count, error? }] }   (cached 2 minutes)
//   detail(key)     { check, columns, rows:[{ employeeId, name, code, department, designation, detail }] }
//
// Who may see it: HR and Admin with company-wide scope (routes/hrAudit.js). Account numbers are shown by their last four digits only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { withoutSystemAccounts } = require('./systemAccounts');
const exitDate = require('./exitDate');

const LEFT = ['Exited', 'Relieved', 'Terminated', 'Inactive', 'Exit Process'];
const GONE = ['Exited', 'Relieved', 'Terminated'];
const DAY = 86400000;
const LATE_LIMIT = 5; // late marks in the last 30 days that make a person show up
const ABSENT_LIMIT = 3; // days absent with no leave in the last 30 days
const HELPDESK_DAYS = 3; // a ticket still open after this many days
const NO_LOGIN_DAYS = 90;

const istToday = (now = Date.now()) => new Date(now + 330 * 60000).toISOString().slice(0, 10);
const shiftDay = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayOf = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t + 330 * 60000).toISOString().slice(0, 10);
};
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const pretty = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const monthPretty = (ym) => (ym ? new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

const WORKING_FIELDS = {
  id: true, name: true, employeeCode: true, department: true, designation: true, team: true, email: true, personalEmail: true, companyEmail: true,
  phone: true, dateOfBirth: true, dateOfJoining: true, reportingManagerId: true, bankAccountNumber: true, ifscCode: true, panNumber: true,
  userId: true, employmentStatus: true, createdAt: true,
};

const who = (e) => ({
  employeeId: e ? e.id : null,
  name: (e && e.name) || '',
  code: (e && e.employeeCode) || '',
  department: (e && e.department) || '',
  designation: (e && e.designation) || '',
});

// ONE context per run: the shared lists are loaded once, on first use.
function makeContext(now = Date.now()) {
  const today = istToday(now);
  const memo = {};
  const once = (k, fn) => { if (!memo[k]) memo[k] = fn(); return memo[k]; };
  return {
    now,
    today,
    working: () => once('working', () => prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { notIn: LEFT } }), select: WORKING_FIELDS, orderBy: { name: 'asc' } })),
    gone: () => once('gone', () => prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { in: GONE } }), select: { ...WORKING_FIELDS, offboardingStatus: true, user: { select: { status: true, lastLoginAt: true } } } })),
    allPeople: () => once('allPeople', () => prisma.employee.findMany({ where: withoutSystemAccounts({}), select: { id: true, department: true, employmentStatus: true, dateOfJoining: true } })),
    // Map(employeeId -> { record, detail }) of the current resignation of everybody who left or is leaving
    exits: () => once('exits', async () => {
      const gone = await prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { in: [...GONE, 'Exit Process', 'Notice Period'] } }), select: { id: true } });
      return exitDate.liveRecords(gone.map((e) => e.id));
    }),
    // Map(employeeId -> day rows of the last 30 days) from the attendance day engine (the same one the Attendance screens use)
    days30: () => once('days30', async () => {
      const D = require('./attendanceDays'); // eslint-disable-line global-require
      const people = await once('working', () => prisma.employee.findMany({ where: withoutSystemAccounts({ employmentStatus: { notIn: LEFT } }), select: WORKING_FIELDS }));
      const cfg = (await prisma.hrConfig.findFirst().catch(() => null)) || {};
      const { days } = await D.loadDays(prisma, { employees: people, from: shiftDay(today, -29), to: today, cfg });
      const out = new Map();
      people.forEach((e) => out.set(e.id, days(e).filter((d) => d.date >= shiftDay(today, -29) && d.date <= today)));
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------- the checks
const CHECKS = [
  // ---- People records ----
  {
    key: 'no-manager', group: 'People records', title: 'Active employees with no reporting manager', severity: 'Medium', questions: [216, 322, 317],
    why: 'Every employee should report to someone, otherwise leave, attendance and reviews have no owner.',
    async run(ctx) {
      return (await ctx.working()).filter((e) => !e.reportingManagerId).map((e) => ({ ...who(e), detail: 'No reporting manager is set.' }));
    },
  },
  {
    key: 'manager-left', group: 'People records', title: 'Employees whose reporting manager has left or has no active login', severity: 'High', questions: [466, 179],
    why: 'Requests from these people climb to a manager who is no longer there.',
    async run(ctx) {
      const working = await ctx.working();
      const ids = [...new Set(working.map((e) => e.reportingManagerId).filter(Boolean))];
      if (!ids.length) return [];
      const managers = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employmentStatus: true, user: { select: { status: true } } } });
      const bad = new Map(managers.filter((m) => LEFT.includes(m.employmentStatus) || (m.user && m.user.status === 'Inactive')).map((m) => [m.id, m]));
      return working.filter((e) => bad.has(e.reportingManagerId)).map((e) => {
        const m = bad.get(e.reportingManagerId);
        return { ...who(e), detail: `Reports to ${m.name}, who is ${LEFT.includes(m.employmentStatus) ? m.employmentStatus : 'login inactive'}.` };
      });
    },
  },
  {
    key: 'duplicate-people', group: 'People records', title: 'Possible duplicate employee records (same phone, email, or name and birth date)', severity: 'High', questions: [470, 172, 138, 412],
    why: 'Two records for one person can mean two salaries, two logins or split attendance.',
    async run(ctx) {
      const working = await ctx.working();
      const rows = []; const seen = new Set();
      const groupBy = (keyOf, label) => {
        const m = new Map();
        working.forEach((e) => { const k = keyOf(e); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(e); } });
        m.forEach((list) => {
          if (list.length < 2) return;
          list.forEach((e) => {
            const others = list.filter((o) => o.id !== e.id).map((o) => `${o.name} (${o.employeeCode || 'no code'})`).join(', ');
            const mark = `${e.id}|${label}`;
            if (seen.has(mark)) return;
            seen.add(mark);
            rows.push({ ...who(e), detail: `Same ${label} as ${others}.` });
          });
        });
      };
      groupBy((e) => { const d = digitsOf(e.phone); return d.length >= 10 ? d.slice(-10) : null; }, 'phone number');
      groupBy((e) => { const m = String(e.email || e.companyEmail || e.personalEmail || '').trim().toLowerCase(); return /@/.test(m) ? m : null; }, 'email');
      groupBy((e) => { const n = String(e.name || '').trim().toLowerCase().replace(/\s+/g, ' '); const b = dayOf(e.dateOfBirth); return n && b ? `${n}|${b}` : null; }, 'name and birth date');
      return rows;
    },
  },
  {
    key: 'duplicate-bank', group: 'People records', title: 'Employees sharing the same bank account number', severity: 'High', questions: [218, 471, 174],
    why: 'One account receiving two salaries is a classic ghost-employee signal.',
    async run(ctx) {
      const working = await ctx.working();
      const m = new Map();
      working.forEach((e) => {
        const d = digitsOf(e.bankAccountNumber);
        if (d.length < 6 || /^(\d)\1+$/.test(d)) return;
        if (!m.has(d)) m.set(d, []);
        m.get(d).push(e);
      });
      const rows = [];
      m.forEach((list, d) => {
        if (list.length < 2) return;
        list.forEach((e) => {
          const others = list.filter((o) => o.id !== e.id).map((o) => `${o.name} (${o.employeeCode || 'no code'})`).join(', ');
          rows.push({ ...who(e), detail: `Account ending ${d.slice(-4)} is also on ${others}.` });
        });
      });
      return rows;
    },
  },
  {
    key: 'missing-info', group: 'People records', title: 'Employees with key details missing (phone, birth date, joining date, bank, PAN ...)', severity: 'Medium', questions: [173, 396, 397],
    why: 'Statutory filings, payroll and audits need these on every record.',
    async run(ctx) {
      const rows = [];
      (await ctx.working()).forEach((e) => {
        const miss = [];
        if (!digitsOf(e.phone)) miss.push('phone');
        if (!(e.email || e.personalEmail || e.companyEmail)) miss.push('email');
        if (!e.dateOfBirth) miss.push('birth date');
        if (!e.dateOfJoining) miss.push('joining date');
        if (!e.department) miss.push('department');
        if (!e.designation) miss.push('designation');
        if (!digitsOf(e.bankAccountNumber)) miss.push('bank account');
        if (!String(e.ifscCode || '').trim()) miss.push('IFSC');
        if (!String(e.panNumber || '').trim()) miss.push('PAN');
        if (miss.length) rows.push({ ...who(e), detail: `Missing: ${miss.join(', ')}.` });
      });
      return rows;
    },
  },
  {
    key: 'no-documents', group: 'People records', title: 'Employees with no document uploaded', severity: 'Low', questions: [472],
    why: 'Nothing is on file for these people (a profile photo alone does not count).',
    async run(ctx) {
      const have = new Set((await prisma.employeeDocument.findMany({ where: { docType: { not: 'Photo' } }, select: { employeeId: true }, distinct: ['employeeId'] })).map((d) => d.employeeId));
      return (await ctx.working()).filter((e) => !have.has(e.id)).map((e) => ({ ...who(e), detail: 'No file has been uploaded to this employee’s documents.' }));
    },
  },
  // ---- Access ----
  {
    key: 'left-with-access', group: 'Access', title: 'People who have left but still have an active login', severity: 'High', questions: [219, 475, 197, 99, 348, 399],
    why: 'A person who left should not be able to sign in.',
    async run(ctx) {
      return (await ctx.gone()).filter((e) => e.user && e.user.status === 'Active').map((e) => ({
        ...who(e), detail: `${e.employmentStatus}, but the login is still Active. Last sign-in: ${e.user.lastLoginAt ? pretty(dayOf(e.user.lastLoginAt)) : 'never'}.`,
      }));
    },
  },
  {
    key: 'no-login-90d', group: 'Access', title: 'Employees who have not signed in for 90 days', severity: 'Low', questions: [214, 95, 178],
    why: 'Idle logins are an access risk, and may be people who no longer work here.',
    async run(ctx) {
      const cutoff = ctx.now - NO_LOGIN_DAYS * DAY;
      const working = await ctx.working();
      const ids = working.map((e) => e.userId).filter(Boolean);
      if (!ids.length) return [];
      const users = await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, lastLoginAt: true, createdAt: true } });
      const byId = new Map(users.map((u) => [u.id, u]));
      const rows = [];
      working.forEach((e) => {
        const u = byId.get(e.userId);
        if (!u || u.createdAt.getTime() > cutoff) return;
        if (!u.lastLoginAt || u.lastLoginAt.getTime() < cutoff) rows.push({ ...who(e), detail: u.lastLoginAt ? `Last sign-in ${pretty(dayOf(u.lastLoginAt))}.` : 'Has never signed in.' });
      });
      return rows;
    },
  },
  {
    key: 'admin-rights', group: 'Access', title: 'Logins with Admin or Super Admin rights outside HR, IT or Admin', severity: 'Medium', questions: [480, 401, 400],
    why: 'Admin rights should sit only with the people who need them.',
    async run() {
      const users = await prisma.user.findMany({
        where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { hrmsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] },
        select: { id: true, name: true, role: true, hrmsRole: true, employee: { select: { id: true, employeeCode: true, department: true, designation: true } } },
      });
      const OK = /(^|\b)(hr|human|it|admin|administration|management|technology|tech)(\b|$)/i;
      return users.filter((u) => !(u.employee && OK.test(String(u.employee.department || '')))).map((u) => ({
        employeeId: u.employee ? u.employee.id : null, name: u.name, code: (u.employee && u.employee.employeeCode) || '', department: (u.employee && u.employee.department) || '',
        designation: (u.employee && u.employee.designation) || '', detail: `Has ${u.hrmsRole && ['SUPER_ADMIN', 'ADMIN'].includes(u.hrmsRole) ? u.hrmsRole : u.role} rights; department on record: ${(u.employee && u.employee.department) || 'none'}.`,
      }));
    },
  },
  // ---- Attendance and leave ----
  {
    key: 'self-approved', group: 'Attendance and leave', title: 'Requests approved by the very person they were for (last 90 days)', severity: 'High', questions: [221, 469, 304, 145],
    why: 'Nobody should approve their own correction, leave or late permission.',
    async run(ctx) {
      const since = new Date(ctx.now - 90 * DAY);
      const steps = await prisma.approvalStep.findMany({
        where: { workflow: { in: ['regularization', 'leave', 'latePermission'] }, status: 'Approved', actedByUserId: { not: null }, actedAt: { gte: since } },
        select: { workflow: true, recordId: true, actedByUserId: true, actedAt: true }, take: 5000,
      });
      const rows = [];
      const SPEC = {
        regularization: { find: (ids) => prisma.attendanceRegularization.findMany({ where: { id: { in: ids } }, select: { id: true, date: true, employee: { select: { ...WORKING_FIELDS } } } }), label: (r) => `Attendance correction for ${pretty(r.date)}` },
        leave: { find: (ids) => prisma.leaveRequest.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, fromDate: true, employee: { select: { ...WORKING_FIELDS } } } }), label: (r) => `${r.type} leave from ${pretty(dayOf(r.fromDate))}` },
        latePermission: { find: (ids) => prisma.latePermission.findMany({ where: { id: { in: ids } }, select: { id: true, date: true, employee: { select: { ...WORKING_FIELDS } } } }), label: (r) => `Late permission for ${pretty(r.date)}` },
      };
      for (const wf of Object.keys(SPEC)) { // eslint-disable-line no-restricted-syntax
        const mine = steps.filter((s) => s.workflow === wf);
        if (!mine.length) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const recs = await SPEC[wf].find([...new Set(mine.map((s) => s.recordId))]);
        const byId = new Map(recs.map((r) => [r.id, r]));
        mine.forEach((s) => {
          const r = byId.get(s.recordId);
          if (r && r.employee && r.employee.userId && r.employee.userId === s.actedByUserId) rows.push({ ...who(r.employee), detail: `${SPEC[wf].label(r)} was approved on ${pretty(dayOf(s.actedAt))} by the same person it was for.` });
        });
      }
      return rows;
    },
  },
  {
    key: 'repeat-late', group: 'Attendance and leave', title: `Employees late ${LATE_LIMIT} or more times in the last 30 days`, severity: 'Low', questions: [478, 17, 326],
    why: 'Repeated late arrival is where a talk or a warning usually starts.',
    async run(ctx) {
      const days = await ctx.days30();
      const working = await ctx.working();
      const rows = [];
      working.forEach((e) => {
        const n = (days.get(e.id) || []).filter((d) => d.counted !== false && d.status === 'Late').length;
        if (n >= LATE_LIMIT) rows.push({ ...who(e), detail: `Late ${n} times in the last 30 days.`, _n: n });
      });
      return rows.sort((a, b) => b._n - a._n).map(({ _n, ...r }) => r);
    },
  },
  {
    key: 'repeat-absent', group: 'Attendance and leave', title: `Employees absent without leave ${ABSENT_LIMIT} or more days in the last 30 days`, severity: 'Medium', questions: [335, 478],
    why: 'Absence with no leave applied needs a conversation and may cost loss of pay.',
    async run(ctx) {
      const ANL = require('./absentNoLeave'); // eslint-disable-line global-require
      const days = await ctx.days30();
      const working = await ctx.working();
      // a date nobody has any attendance data for is "no device data", never an absence (the same guard payroll uses)
      const withData = new Set();
      days.forEach((rows) => rows.forEach((d) => { if (d.checkIn || d.checkOut) withData.add(d.date); }));
      const rows = [];
      working.forEach((e) => {
        const n = (days.get(e.id) || []).filter((d) => ANL.classify(d, { withData, rejected: false }) === 'full').length;
        if (n >= ABSENT_LIMIT) rows.push({ ...who(e), detail: `${n} days absent with no leave applied, in the last 30 days.`, _n: n });
      });
      return rows.sort((a, b) => b._n - a._n).map(({ _n, ...r }) => r);
    },
  },
  // ---- Payroll ----
  {
    key: 'salary-no-attendance', group: 'Payroll', title: 'Salary paid with no day present (last 3 months)', severity: 'High', questions: [215, 305, 141],
    why: 'Pay with no attendance can be a ghost employee or a wrong payroll input.',
    async run(ctx) {
      const months = [0, 1, 2].map((i) => { const d = new Date(`${ctx.today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
      const runs = await prisma.employeePayrollRun.findMany({
        where: { month: { in: months }, netPay: { gt: 0 }, daysPresent: 0, status: { not: 'DRAFT' }, importedBreakup: null, attendanceSource: 'ATTENDANCE' },
        select: { month: true, netPay: true, daysLop: true, workingDays: true, employee: { select: { ...WORKING_FIELDS } } }, orderBy: { month: 'desc' },
      });
      return runs.filter((r) => r.employee).map((r) => ({ ...who(r.employee), detail: `${money(r.netPay)} for ${monthPretty(r.month)} with 0 days present.` }));
    },
  },
  {
    key: 'salary-after-exit', group: 'Payroll', title: 'Salary paid for a month after the last working day', severity: 'High', questions: [482, 306, 305],
    why: 'Pay after the person left is money going out that should not.',
    async run(ctx) {
      const exits = await ctx.exits();
      const gone = await ctx.gone();
      const goneIds = new Set(gone.map((e) => e.id));
      const lwd = new Map();
      exits.forEach((v, id) => { if (goneIds.has(id)) { const d = exitDate.dateOf(v.record, v.detail); if (d) lwd.set(id, d); } });
      if (!lwd.size) return [];
      const runs = await prisma.employeePayrollRun.findMany({ where: { employeeId: { in: [...lwd.keys()] }, netPay: { gt: 0 }, status: { not: 'DRAFT' } }, select: { employeeId: true, month: true, netPay: true } });
      const byId = new Map(gone.map((e) => [e.id, e]));
      return runs.filter((r) => r.month > lwd.get(r.employeeId).slice(0, 7)).map((r) => ({ ...who(byId.get(r.employeeId)), detail: `${money(r.netPay)} paid for ${monthPretty(r.month)}; the last working day was ${pretty(lwd.get(r.employeeId))}.` }));
    },
  },
  // ---- Process ----
  {
    key: 'policy-not-acknowledged', group: 'Process', title: 'Employees who have not acknowledged a mandatory policy', severity: 'Medium', questions: [473, 46, 379],
    why: 'A policy is only enforceable when the person has accepted it.',
    async run(ctx) {
      const docs = await prisma.policyDocument.findMany({ where: { mandatory: true, published: true, approvalStatus: 'Approved' }, select: { id: true, title: true, departments: true, employeeIds: true } });
      if (!docs.length) return [];
      const acks = await prisma.acknowledgment.findMany({ where: { documentId: { in: docs.map((d) => d.id) } }, select: { documentId: true, employeeId: true } });
      const done = new Set(acks.map((a) => `${a.documentId}|${a.employeeId}`));
      const inAudience = (d, e) => {
        let ids = []; try { ids = JSON.parse(d.employeeIds || '[]'); } catch { ids = []; }
        if (Array.isArray(ids) && ids.length) return ids.includes(e.id);
        const deps = String(d.departments || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (deps.length) return deps.includes(String(e.department || '').toLowerCase());
        return true;
      };
      const rows = [];
      (await ctx.working()).forEach((e) => {
        const missing = docs.filter((d) => inAudience(d, e) && !done.has(`${d.id}|${e.id}`)).map((d) => d.title);
        if (missing.length) rows.push({ ...who(e), detail: `Not acknowledged: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.` });
      });
      return rows;
    },
  },
  {
    key: 'helpdesk-overdue', group: 'Process', title: `Help Desk tickets still open after ${HELPDESK_DAYS} days`, severity: 'Medium', questions: [479, 26, 27],
    why: 'Employee requests waiting this long are slipping.',
    async run(ctx) {
      const before = new Date(ctx.now - HELPDESK_DAYS * DAY);
      const tickets = await prisma.employeeRecord.findMany({
        where: { type: 'HELPDESK', status: { in: ['Open', 'In Progress'] }, createdAt: { lt: before } },
        select: { title: true, category: true, priority: true, status: true, createdAt: true, employee: { select: { ...WORKING_FIELDS } } }, orderBy: { createdAt: 'asc' },
      });
      return tickets.filter((t) => t.employee).map((t) => ({ ...who(t.employee), detail: `“${t.title}” (${t.category || 'General'}, ${t.priority || 'Medium'}) has been ${t.status.toLowerCase()} for ${Math.floor((ctx.now - t.createdAt.getTime()) / DAY)} days.` }));
    },
  },
  {
    key: 'exit-clearance-pending', group: 'Process', title: 'Last working day passed but exit clearance is not finished (last 90 days)', severity: 'Medium', questions: [474, 345, 144],
    why: 'Assets, access and documents should be cleared on the last working day.',
    async run(ctx) {
      const exits = await ctx.exits();
      const ids = [...exits.keys()];
      if (!ids.length) return [];
      const people = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { ...WORKING_FIELDS, offboardingStatus: true } });
      const from = shiftDay(ctx.today, -90);
      const rows = [];
      people.forEach((e) => {
        const v = exits.get(e.id); const d = v && exitDate.dateOf(v.record, v.detail);
        if (!d || d > ctx.today || d < from || e.offboardingStatus === 'Cleared') return;
        rows.push({ ...who(e), detail: `Last working day was ${pretty(d)}; clearance is ${e.offboardingStatus ? e.offboardingStatus.toLowerCase() : 'not started'}${e.employmentStatus === 'Notice Period' ? ' and the person is still on notice' : ''}.` });
      });
      return rows;
    },
  },
  {
    key: 'headcount-over-plan', group: 'Process', title: 'Roles where the actual headcount is above the approved plan', severity: 'Medium', questions: [223, 476, 308],
    why: 'More people than planned means cost above budget.',
    async run() {
      const view = await require('./vacancies').view(); // eslint-disable-line global-require
      const rows = [];
      (view.groups || []).forEach((g) => (g.rows || []).forEach((r) => {
        if (r.over > 0) rows.push({ employeeId: null, name: `${g.name} · ${r.role}`, code: '', department: g.name, designation: r.role, detail: `Planned ${r.planned}, actually ${r.filled} (${r.over} over).` });
      }));
      return rows;
    },
  },
  {
    key: 'no-review', group: 'Process', title: 'Employees with no performance review in the last 12 months', severity: 'Low', questions: [477, 217, 135],
    why: 'Nobody has recorded a review for these people.',
    async run(ctx) {
      const since = new Date(ctx.now - 365 * DAY);
      const have = new Set((await prisma.performanceReview.findMany({ where: { createdAt: { gte: since } }, select: { employeeId: true }, distinct: ['employeeId'] })).map((r) => r.employeeId));
      const cutoff = shiftDay(ctx.today, -180);
      return (await ctx.working()).filter((e) => !have.has(e.id) && dayOf(e.dateOfJoining) && dayOf(e.dateOfJoining) <= cutoff)
        .map((e) => ({ ...who(e), detail: 'No performance review in the last 12 months.' }));
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------- the KPI strip
async function kpis(ctx) {
  const today = ctx.today;
  const [working, all, exits, gone] = await Promise.all([ctx.working(), ctx.allPeople(), ctx.exits(), ctx.gone()]);
  const ago30 = shiftDay(today, -30); const ago90 = shiftDay(today, -90); const ago365 = shiftDay(today, -365);
  const goneIds = new Set(gone.map((e) => e.id));
  const joinOf = new Map(all.map((e) => [e.id, dayOf(e.dateOfJoining)]));
  const deptOf = new Map(all.map((e) => [e.id, e.department || 'No department']));
  const leavers = []; let unknownDate = 0;
  gone.forEach((e) => {
    const v = exits.get(e.id); const d = v ? exitDate.dateOf(v.record, v.detail) : null;
    if (d) leavers.push({ id: e.id, lwd: d }); else unknownDate += 1;
  });
  const within = (list, from) => list.filter((l) => l.lwd >= from && l.lwd <= today);
  const left30 = within(leavers, ago30).length; const left90 = within(leavers, ago90).length;
  const left365 = within(leavers, ago365);
  const joined = (from) => all.filter((e) => { const j = joinOf.get(e.id); return j && j >= from && j <= today; }).length;
  const headcount = working.length;
  const joined365 = joined(ago365);
  const before = headcount + left365.length - joined365; // people there a year ago (approximate)
  const avg = (headcount + Math.max(before, 0)) / 2;
  const attrition = avg > 0 ? (left365.length / avg) * 100 : null;
  // retention: of the people who were here 12 months ago, how many still are
  const base = all.filter((e) => { const j = joinOf.get(e.id); if (!j || j > ago365) return false; if (!goneIds.has(e.id)) return true; const l = leavers.find((x) => x.id === e.id); return !!l && l.lwd >= ago365; });
  const stay = base.filter((e) => !goneIds.has(e.id) && !LEFT.includes(e.employmentStatus));
  const retention = base.length ? (stay.length / base.length) * 100 : null;
  const early = left365.filter((l) => { const j = joinOf.get(l.id); return j && Math.round((Date.parse(`${l.lwd}T00:00:00Z`) - Date.parse(`${j}T00:00:00Z`)) / DAY) <= 90; }).length;
  // absenteeism: days absent (not on leave) over working days that count, last 30 days
  let absent = 0; let counted = 0;
  try {
    const days = await ctx.days30();
    days.forEach((rows) => rows.forEach((d) => { if (d.counted === false) return; counted += 1; if (d.status === 'Absent') absent += 1; }));
  } catch { counted = 0; }
  const tenure = working.map((e) => dayOf(e.dateOfJoining)).filter(Boolean).map((j) => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${j}T00:00:00Z`)) / (365.25 * DAY));
  // department turnover (last 12 months): leavers / (people now + half the leavers)
  const byDept = new Map();
  left365.forEach((l) => { const d = deptOf.get(l.id); byDept.set(d, (byDept.get(d) || 0) + 1); });
  const nowBy = new Map(); working.forEach((e) => nowBy.set(e.department || 'No department', (nowBy.get(e.department || 'No department') || 0) + 1));
  const departments = [...byDept.entries()].map(([name, n]) => ({ name, left: n, headcount: nowBy.get(name) || 0, turnoverPct: Math.round((n / ((nowBy.get(name) || 0) + n / 2)) * 1000) / 10 })).sort((a, b) => b.turnoverPct - a.turnoverPct).slice(0, 8);
  const r1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
  return {
    headcount, joinedLast30: joined(ago30), joinedLast90: joined(ago90), leftLast30: left30, leftLast90: left90, leftLast12Months: left365.length,
    attritionPct12m: r1(attrition), retentionPct12m: r1(retention), earlyLeaversLast12m: early,
    absenteeismPct30d: counted ? r1((absent / counted) * 100) : null, avgTenureYears: tenure.length ? r1(tenure.reduce((a, b) => a + b, 0) / tenure.length) : null,
    leaversWithoutLastDay: unknownDate, departments,
    notes: 'Attrition = people who left in the last 12 months / average headcount. Retention = of the people here 12 months ago, the share still here. Absenteeism = absent days (not on leave) / working days that count, last 30 days. Leavers with no recorded last working day are left out.',
  };
}

// ---------------------------------------------------------------------------------------------------------------- public API
let cache = { at: 0, value: null };
const TTL = 2 * 60 * 1000;

const meta = (c) => ({ key: c.key, group: c.group, title: c.title, severity: c.severity, questions: c.questions, why: c.why });

async function summary({ refresh = false, now = Date.now() } = {}) {
  if (!refresh && cache.value && now - cache.at < TTL) return cache.value;
  const ctx = makeContext(now);
  const settled = await Promise.allSettled(CHECKS.map((c) => c.run(ctx)));
  const checks = CHECKS.map((c, i) => {
    const s = settled[i];
    return s.status === 'fulfilled' ? { ...meta(c), count: s.value.length } : { ...meta(c), count: null, error: 'This check could not be worked out just now.' };
  });
  settled.forEach((s, i) => { if (s.status === 'rejected') console.error(`[hr-audit] ${CHECKS[i].key}`, s.reason && s.reason.message); }); // eslint-disable-line no-console
  let k = null; let kpiError = null;
  try { k = await kpis(ctx); } catch (e) { kpiError = 'The headline numbers could not be worked out just now.'; console.error('[hr-audit] kpis', e.message); } // eslint-disable-line no-console
  const value = { generatedAt: new Date(now).toISOString(), kpis: k, kpiError, checks };
  cache = { at: now, value };
  return value;
}

async function detail(key, { now = Date.now() } = {}) {
  const c = CHECKS.find((x) => x.key === key);
  if (!c) return null;
  const rows = await c.run(makeContext(now));
  return { check: meta(c), columns: ['Name', 'Employee code', 'Department', 'Designation', 'What is wrong'], rows };
}

const resetCache = () => { cache = { at: 0, value: null }; };

module.exports = { CHECKS, summary, detail, kpis, makeContext, resetCache, LEFT, GONE };
