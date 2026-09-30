// ---------------------------------------------------------------------------
// SYSTEM ACCOUNTS — "Super Admin is a system role, not an employee".
//
// A Super Admin login is the company's administrative account. It is NOT a
// member of staff, so it must never be swept into the flows that exist for
// employees:
//
//   * Employee Management lists / counts / exports, HRMS headcount
//   * attendance rules (a missing check-in is not marked against it)
//   * payroll runs, salary structure lists
//   * leave balances
//   * LMS "Everyone" / department assignments and audience "Everyone" fan-out
//   * the approval chain AS A REQUESTER (leave, regularization, resignation)
//
// It stays the FINAL APPROVER on the chain (utils/approvalWorkflow.js).
//
// ONE PLACE decides who is a system account: SYSTEM_ACCOUNT_ROLES below. A
// login is one while its account-level role (or its HRMS role) is one of
// those. When a real person holds Super Admin AND has an Employee record (a
// founder, say), nothing is deleted: the record simply drops out of the
// employee-only flows WHILE the login holds the role, and comes back the
// moment the role is changed — every filter here is evaluated against the
// login's CURRENT role, never a stored flag.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SYSTEM_ACCOUNT_ROLES = ['SUPER_ADMIN'];

// Sync test on a resolved identity (req.user) or a User row.
function isSystemAccount(user) {
  if (!user) return false;
  return SYSTEM_ACCOUNT_ROLES.includes(user.role) || SYSTEM_ACCOUNT_ROLES.includes(user.hrmsRole);
}

// Prisma `where` fragment for the Employee model: "not linked to a system
// account". An employee with no login is, by definition, not one.
const NOT_SYSTEM_EMPLOYEE = Object.freeze({
  OR: [
    { userId: null },
    {
      user: {
        is: {
          role: { notIn: SYSTEM_ACCOUNT_ROLES },
          OR: [{ hrmsRole: null }, { hrmsRole: { notIn: SYSTEM_ACCOUNT_ROLES } }],
        },
      },
    },
  ],
});

// Wrap any Employee `where` so system accounts drop out of it.
function withoutSystemAccounts(where) {
  const base = where && Object.keys(where).length ? [where] : [];
  return { AND: [...base, NOT_SYSTEM_EMPLOYEE] };
}

// The same fragment lifted through a relation (Attendance.employee, ...).
function recordWithoutSystemAccounts(relation = 'employee') {
  return { [relation]: NOT_SYSTEM_EMPLOYEE };
}

// Employee ids currently linked to a system account (for in-memory filters).
async function systemEmployeeIds() {
  const rows = await prisma.employee.findMany({
    where: {
      userId: { not: null },
      user: { is: { OR: [{ role: { in: SYSTEM_ACCOUNT_ROLES } }, { hrmsRole: { in: SYSTEM_ACCOUNT_ROLES } }] } },
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

// Is this Employee row (or id) linked to a system account right now?
async function isSystemEmployee(employee) {
  if (!employee) return false;
  const id = typeof employee === 'string' ? employee : employee.id;
  let userId = typeof employee === 'object' ? employee.userId : undefined;
  if (userId === undefined) {
    const e = await prisma.employee.findUnique({ where: { id }, select: { userId: true } });
    userId = e ? e.userId : null;
  }
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, hrmsRole: true } });
  return isSystemAccount(u);
}

// The refusal every request-raising route answers with, or null when the
// employee may raise it. `what` names the request ("leave", "a resignation").
async function systemRequesterError(employee, what = 'this request') {
  if (!(await isSystemEmployee(employee))) return null;
  return `${employee && employee.name ? `${employee.name} is` : 'This login is'} a Super Admin — a system account, not an employee — so it does not raise ${what} on the approval chain. Super Admin approves; it does not apply.`;
}

module.exports = {
  SYSTEM_ACCOUNT_ROLES,
  isSystemAccount,
  NOT_SYSTEM_EMPLOYEE,
  withoutSystemAccounts,
  recordWithoutSystemAccounts,
  systemEmployeeIds,
  isSystemEmployee,
  systemRequesterError,
};
