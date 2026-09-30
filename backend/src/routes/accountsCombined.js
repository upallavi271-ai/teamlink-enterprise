// GET /api/accounts/combined-summary?month=&year=   (Office & Expenses spec A)
//
// { total_salary_outflow, total_office_expenses, total_outflow } for one month.
// Office expenses stay independent of the payroll tables; this is the only
// place the two are read side by side.
//
// DEFINITIONS (the same rule on both sides: what is paid OUT to the payee plus
// what the employer pays on top; tax and PF WITHHELD from the payee is a
// liability remitted separately and is not counted again):
//
//   total_salary_outflow  — for the payroll month, every per-employee payroll
//     record (EmployeePayrollRun, SPEC B) that is APPROVED, SYNCED_TO_ACCOUNTS
//     or PAID:  netPay + pfEmployer + esiEmployer.
//     A month with no per-employee records falls back to the older month run
//     (PayrollRun) when it is marked Paid: its payslips' netPay + employerPf +
//     esiEmployer, or the run's totalNet when no payslips are on file.
//     Draft / pending-approval payroll is not an outflow yet.
//
//   total_office_expenses — OfficeExpense dated in that month whose approval
//     status is APPROVED or PAID, hand loans excluded: the bill's Total,
//     monthlyAmount − tdsAmount (before GST + GST − TDS).
//
// Only per-route middleware here — never router.use — so this router can share
// the /api/accounts mount with the Accounts journal API without touching it.
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { ROUND, monthLabel } = require('../utils/accounts');

const router = express.Router();

const SALARY_OK = ['APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'];
// REIMBURSED (Office & Accounts one-page) is money out, the same as PAID.
const OFFICE_OK = ['APPROVED', 'PAID', 'REIMBURSED'];
// Office categories that look like salary or payroll dues: when both sides
// carry money for the month, the screen warns that the two may overlap.
const SALARY_LIKE = /(^|\b)(salary|salaries|wages|stipend|ctc|pf|epf|esi|esic|pt|professional tax)(\b|$)/i;

function monthKeyOf(q) {
  const now = new Date();
  const hasM = q.month !== undefined && q.month !== '';
  const hasY = q.year !== undefined && q.year !== '';
  if (!hasM && !hasY) return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const m = String(q.month ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(m)) return m;
  const y = hasY ? Number(q.year) : now.getFullYear();
  const mm = Number(m);
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(mm) || mm < 1 || mm > 12) return null;
  return `${y}-${String(mm).padStart(2, '0')}`;
}

async function salaryOutflow(mk) {
  // SPEC B's per-employee payroll records, when the table exists.
  if (prisma.employeePayrollRun) {
    try {
      const entries = await prisma.employeePayrollRun.findMany({
        where: { month: mk },
        select: {
          status: true, netPay: true, pfEmployer: true, esiEmployer: true, grossPay: true,
        },
      });
      if (entries.length) {
        const ok = entries.filter((e) => SALARY_OK.includes(String(e.status || '').toUpperCase()));
        const net = ROUND(ok.reduce((s, e) => s + Number(e.netPay || 0), 0));
        const employer = ROUND(ok.reduce((s, e) => s + Number(e.pfEmployer || 0) + Number(e.esiEmployer || 0), 0));
        const byStatus = {};
        entries.forEach((e) => { const k = String(e.status || '').toUpperCase(); byStatus[k] = (byStatus[k] || 0) + 1; });
        return {
          source: 'EmployeePayrollRun',
          total: ROUND(net + employer),
          net_pay: net,
          employer_contributions: employer,
          employees: ok.length,
          records: entries.length,
          not_yet_approved: entries.length - ok.length,
          by_status: byStatus,
        };
      }
    } catch (err) {
      // The table is not there yet on this database — use the month run.
    }
  }
  const run = await prisma.payrollRun.findUnique({ where: { month: mk } });
  if (!run) {
    return {
      source: 'none', total: 0, net_pay: 0, employer_contributions: 0, employees: 0, records: 0, not_yet_approved: 0, run_status: null,
    };
  }
  if (String(run.status || '').toLowerCase() !== 'paid') {
    return {
      source: 'PayrollRun', total: 0, net_pay: 0, employer_contributions: 0, employees: 0, records: run.employees || 0, not_yet_approved: run.employees || 0, run_status: run.status,
    };
  }
  const slips = await prisma.payslip.findMany({ where: { month: mk } });
  if (slips.length) {
    const net = ROUND(slips.reduce((s, p) => s + Number(p.netPay || 0), 0));
    const employer = ROUND(slips.reduce((s, p) => s + Number(p.employerPf || 0) + Number(p.esiEmployer || 0), 0));
    return {
      source: 'PayrollRun+Payslip', total: ROUND(net + employer), net_pay: net, employer_contributions: employer, employees: slips.length, records: slips.length, not_yet_approved: 0, run_status: run.status,
    };
  }
  const net = ROUND(Number(run.totalNet || 0));
  return {
    source: 'PayrollRun', total: net, net_pay: net, employer_contributions: 0, employees: run.employees || 0, records: run.employees || 0, not_yet_approved: 0, run_status: run.status, note: 'No payslips on file for this run — its total net pay is used; employer contributions are not known',
  };
}

async function officeOutflow(mk) {
  const rows = await prisma.officeExpense.findMany({
    where: { expenseDate: { startsWith: mk }, approvalStatus: { in: OFFICE_OK } },
    select: {
      monthlyAmount: true, tdsAmount: true, entryKind: true, category: true, approvalStatus: true,
    },
  });
  const live = rows.filter((r) => r.entryKind !== 'hand');
  const amt = (r) => Number(r.monthlyAmount || 0) - Number(r.tdsAmount || 0);
  const sum = (l) => ROUND(l.reduce((s, r) => s + amt(r), 0));
  const salaryLike = live.filter((r) => SALARY_LIKE.test(String(r.category || '')));
  return {
    total: sum(live),
    count: live.length,
    approved: sum(live.filter((r) => r.approvalStatus === 'APPROVED')),
    paid: sum(live.filter((r) => r.approvalStatus === 'PAID')),
    reimbursed: sum(live.filter((r) => r.approvalStatus === 'REIMBURSED')),
    salary_like_categories: sum(salaryLike),
    salary_like_list: [...new Set(salaryLike.map((r) => r.category))].sort(),
  };
}

router.get(
  '/combined-summary',
  requireAuth,
  requireProduct('accounts'),
  requirePerm('accounts', 'accounts', 'Accounts Dashboard', 'view'),
  async (req, res, next) => {
    try {
      const mk = monthKeyOf(req.query);
      if (!mk) return res.status(400).json({ error: 'month must be 1–12 and year a four-digit year (or month=YYYY-MM)' });
      const [salary, office] = await Promise.all([salaryOutflow(mk), officeOutflow(mk)]);
      return res.json({
        month: Number(mk.slice(5, 7)),
        year: Number(mk.slice(0, 4)),
        monthKey: mk,
        label: monthLabel(mk),
        total_salary_outflow: salary.total,
        total_office_expenses: office.total,
        total_outflow: ROUND(salary.total + office.total),
        salary,
        office,
        possible_overlap: salary.total > 0 && office.salary_like_categories > 0 ? office.salary_like_categories : 0,
        definitions: {
          salary: 'Approved / synced / paid payroll for the month: net pay + employer PF + employer ESI (older month runs count once marked Paid)',
          office: 'Approved, paid and reimbursed office expenses dated in the month: before GST + GST − TDS; hand loans excluded',
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
