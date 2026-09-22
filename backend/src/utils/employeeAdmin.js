// ---------------------------------------------------------------------------
// Employee administration — the shared pieces.
//
// WHY THIS FILE EXISTS
// "Add Employee", the email one-time code that gates it, the designation ->
// role mapping it derives access from and the wide row Employee Management
// renders all used to live inside routes/admin.js, behind the
// `administration / Users` permission. That made them Admin-only, which is
// why a TL opening Employee Management saw nothing but the review queue.
//
// The ROUTES now live in routes/employees.js, behind
// `hrms / Employee Management / …`, so the same screen works for every HR role
// at that role's own data scope. The helpers below are the shared vocabulary:
// routes/employees.js owns the employee-administration surface, and
// routes/admin.js still reads productAccessOf()/designationRows() for the
// Users screen's own columns. There is ONE implementation of each of them, in
// here, and no second copy anywhere.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const { FALLBACK_DESIGNATION_MAP } = require('./identity');
const { CATALOG_ROLES, NO_ROLE } = require('./roleAccess');

const ALL_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR',
  'RECRUITER', 'BDE', 'CLIENT', 'ACCOUNTANT', 'EMPLOYEE', 'CANDIDATE',
];
const ATS_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL',
  'RECRUITER', 'BDE', 'CLIENT',
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const normalEmail = (email) => String(email || '').trim().toLowerCase();

// The Users screen's product columns. Stored, editable booleans — never
// derived from the role at read time.
// One column per product, each naming THAT PRODUCT'S ROLE. "Yes" told the
// reader nothing now that a login can be an Employee in one product and a
// Recruiter in another.
function productAccessOf(user) {
  const shown = (held, role) => {
    if (!held) return 'No Access';
    const r = role && role !== NO_ROLE ? role : (user.role || null);
    return r || 'Yes';
  };
  return {
    hrms: shown(user.hrmsAccess, user.hrmsRole),
    ats: shown(user.atsAccess, user.atsRole),
    accounts: shown(user.accountsAccess, user.accountsRole),
  };
}

function scopeLabelOf(user, emp) {
  if (!user) return null;
  if (user.role === 'CLIENT') return `Client: ${user.client?.name || 'not assigned'}`;
  if (user.role === 'CANDIDATE') return 'Own profile only';
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return 'All departments';
  // HR (§6) is company-wide in HRMS — "all employees are visible to HR" — so
  // its row must not read "HR department", which is where the person SITS.
  if (user.hrmsRole === 'HR') return 'All employees (HRMS)';
  const depts = String(user.atsScopeDepartments || user.atsDepartment || emp?.department || '')
    .split(',').map((d) => d.trim()).filter(Boolean);
  const teams = String(user.atsScopeTeams || user.team || emp?.team || '')
    .split(',').map((d) => d.trim()).filter(Boolean);
  if (!depts.length) return 'Own records';
  if (user.atsRole === 'TL' && teams.length) return `${depts.join(', ')} · team ${teams.join(', ')}`;
  return `${depts.join(', ')} department${depts.length > 1 ? 's' : ''}`;
}

// The designation -> ATS role mapping, as data. Falls back to the seeded
// defaults until the table has rows.
async function designationRows() {
  const rows = await prisma.designationRole.findMany({
    orderBy: [{ position: 'asc' }, { designation: 'asc' }],
  });
  return rows.length ? rows : FALLBACK_DESIGNATION_MAP;
}

// The default product reach of each role, read off the designation mapping so
// there is one source for it. Display only: what a login actually has is its
// own hrmsAccess / atsAccess / accountsAccess columns.
async function defaultProductAccessByRole() {
  const rows = await designationRows();
  const out = {};
  for (const role of CATALOG_ROLES) {
    const row = rows.find((r) => r.atsRole === role);
    const external = ['CLIENT', 'CANDIDATE'].includes(role);
    const hrms = row ? row.hrms : !external;
    const ats = row ? row.ats : external;
    const accounts = row ? row.accounts : (role === 'ACCOUNTANT' || external);
    out[role] = {
      hrms: hrms ? 'Yes' : 'No Access',
      ats: ats ? (role === 'CANDIDATE' ? 'Candidate' : role) : 'No Access',
      accounts: accounts ? 'Yes' : 'No Access',
    };
  }
  return out;
}

// The login's primary role code for a designation. The ATS role is the
// designation's own when it has one; a designation with no ATS role but
// Accounts access is an accountant; everything else is a plain employee.
// There is never a compound role like "Medical Recruiter" — the DEPARTMENT
// carries the scope and the DESIGNATION carries the role.
function loginRoleFor(mapping) {
  if (!mapping) return 'EMPLOYEE';
  if (mapping.atsRole && ALL_ROLES.includes(mapping.atsRole)) return mapping.atsRole;
  // AN HRMS-ONLY DESIGNATION MAY STILL NAME A REAL ROLE. 'HR' (§6) is one: the
  // designation carries no ATS role at all, and without this line the login
  // would come out a plain EMPLOYEE and the HR desk would see only itself.
  // The pre-existing rows are unchanged by it — an 'Accountant' row derives
  // hrmsRole=ACCOUNTANT and still returns ACCOUNTANT, an 'Employee' row
  // derives EMPLOYEE and still returns EMPLOYEE.
  const hrms = mapping.hrmsRole && mapping.hrmsRole !== NO_ROLE ? mapping.hrmsRole : null;
  if (hrms && !mapping.ats && ALL_ROLES.includes(hrms)) return hrms;
  if (mapping.accounts && !mapping.ats) return 'ACCOUNTANT';
  return 'EMPLOYEE';
}

// ---------------------------------------------------------------------------
// THE THREE PRODUCT ROLES A DESIGNATION DERIVES.
//
//   USER
//    ├── HRMS Role      → hrmsRole
//    ├── ATS Role       → atsRole
//    └── Accounts Role  → accountsRole
//
// The mapping TABLE is the source: a row may name each role explicitly, and
// where it does not, the role is the designation's implied login role for the
// products it grants and 'NONE' for the products it does not. Every place
// that creates a login writes these three columns through this one function.
// It is never a compound name — "Medical Recruiter" is department=Medical +
// atsRole=RECRUITER, and no role anywhere carries a department in it.
// ---------------------------------------------------------------------------
function productRolesForDesignation(mapping) {
  const implied = loginRoleFor(mapping);
  const named = (v) => (v && v !== NO_ROLE ? v : null);
  const has = (p) => !!(mapping && mapping[p]);
  return {
    hrmsRole: has('hrms') ? (named(mapping.hrmsRole) || implied) : NO_ROLE,
    atsRole: has('ats') ? (named(mapping && mapping.atsRole) || implied) : NO_ROLE,
    accountsRole: has('accounts') ? (named(mapping.accountsRole) || implied) : NO_ROLE,
  };
}


// ---------------------------------------------------------------------------
// KEEPING THE LOGIN IN STEP WITH THE HR RECORD.
//
// "HRMS lo vundey employees ey ATS lo kuda work chesthar... HRMS lo thana
// designation Recruiter & department Medical ithe, automatic ga ATS lo Medical
// Recruiter ani ardham."
//
// That derivation was applied ONCE, when the login was created, and then never
// again — so the two halves drifted the moment anything changed:
//
//   * POST /employees/:id/transfer moved Employee.department and left
//     User.atsDepartment / atsScopeDepartments pointing at the OLD desk. The
//     person showed as IT in HRMS while still reading Medical's ATS data.
//   * PUT /employees/:id could change `designation` without re-deriving a
//     single role, so promoting a Recruiter to TL left an ATS login that was
//     still a RECRUITER.
//
// This is the one place that re-applies it. There is still no compound role
// anywhere: the DESIGNATION carries the role and the DEPARTMENT carries the
// scope, exactly as at creation.
//
// TWO THINGS IT DELIBERATELY WILL NOT DO:
//
//   1. It does not flatten a CONFIGURED scope. manager@ is scoped to
//      "Medical,IT,Manufacturing,Educational,BDE" on purpose; a department
//      move must not collapse that to one name. The scope is only re-pointed
//      when it still held exactly the department the person is leaving, i.e.
//      when nobody had customised it.
//   2. It does not re-derive roles unless the DESIGNATION ITSELF CHANGED.
//      An administrator may override a product role on Administration ->
//      Users, and editing an unrelated field on the HR record must not quietly
//      undo that.
// ---------------------------------------------------------------------------
function csvList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function syncLoginToEmployee(employee, previous, { designationChanged = false } = {}) {
  if (!employee || !employee.userId) return null;
  const user = await prisma.user.findUnique({ where: { id: employee.userId } });
  if (!user) return null;

  const data = {};
  const changes = [];

  // --- the desk the person sits at ----------------------------------------
  const oldDept = previous ? previous.department : null;
  if (employee.department && employee.department !== user.atsDepartment) {
    data.atsDepartment = employee.department;
    changes.push(`department ${user.atsDepartment || '—'} -> ${employee.department}`);
  }
  const scope = csvList(user.atsScopeDepartments);
  const scopeWasJustTheirDesk = scope.length === 0 || (scope.length === 1 && scope[0] === oldDept);
  if (employee.department && scopeWasJustTheirDesk && scope[0] !== employee.department) {
    data.atsScopeDepartments = employee.department;
    changes.push(`scope ${scope[0] || '—'} -> ${employee.department}`);
  }

  if ((employee.team || null) !== (user.team || null)) {
    data.team = employee.team || null;
    changes.push(`team ${user.team || '—'} -> ${employee.team || '—'}`);
  }
  const teams = csvList(user.atsScopeTeams);
  const teamScopeWasJustTheirs = teams.length === 0
    || (teams.length === 1 && teams[0] === (previous ? previous.team : null));
  if (teamScopeWasJustTheirs && teams[0] !== (employee.team || undefined)) {
    data.atsScopeTeams = employee.team || null;
  }

  // --- the role the designation carries ------------------------------------
  if (designationChanged) {
    const rows = await designationRows();
    const mapping = rows.find((r) => r.designation === employee.designation) || null;
    if (mapping) {
      const roles = productRolesForDesignation(mapping);
      Object.assign(data, {
        role: loginRoleFor(mapping),
        hrmsRole: roles.hrmsRole,
        atsRole: roles.atsRole,
        accountsRole: roles.accountsRole,
        hrmsAccess: !!mapping.hrms,
        atsAccess: !!mapping.ats,
        accountsAccess: !!mapping.accounts,
        landingWorkspace: mapping.landing || null,
      });
      changes.push(`role ${user.role} -> ${loginRoleFor(mapping)} (designation ${employee.designation})`);
    }
  }

  if (!Object.keys(data).length) return null;
  const updated = await prisma.user.update({ where: { id: employee.userId }, data });
  return { user: updated, changes };
}
// ---------------------------------------------------------------------------
// The wide Employee Management row: the HR record, its login and its reach.
// ---------------------------------------------------------------------------
const fmtDate = (d) => (d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : null);

const EMP_MGMT_INCLUDE = { user: true, reportingManager: true };

function shapeEmployeeMgmtRow(e) {
  const u = e.user;
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    name: e.name,
    email: e.email,
    phone: e.phone,
    department: e.department,
    designation: e.designation,
    team: e.team,
    reportingManager: e.reportingManager ? e.reportingManager.name : null,
    stl: e.stl,
    tl: e.tl,
    location: e.location,
    joiningDate: fmtDate(e.dateOfJoining),
    employmentStatus: e.employmentStatus || 'Active',
    userId: u ? u.id : null,
    // ROLE — the login's own role code, derived from the designation when the
    // record was created and changeable from Assign Roles.
    role: u ? u.role : null,
    productAccess: u ? productAccessOf(u) : null,
    // ONE LOGIN, THREE PRODUCT ROLES.
    productRoles: u ? {
      hrms: u.hrmsAccess ? (u.hrmsRole || u.role) : NO_ROLE,
      ats: u.atsAccess ? (u.atsRole || u.role) : NO_ROLE,
      accounts: u.accountsAccess ? (u.accountsRole || u.role) : NO_ROLE,
    } : null,
    atsRole: u ? u.atsRole : null,
    atsDepartment: u ? u.atsDepartment : null,
    // The three raw scope strings, so the Edit Scope editor on this screen can
    // open with the values the engine actually enforces.
    atsScopeDepartments: u ? (u.atsScopeDepartments || '') : '',
    atsScopeTeams: u ? (u.atsScopeTeams || '') : '',
    atsScopeClients: u ? (u.atsScopeClients || '') : '',
    // DATA SCOPE — which records this login may reach, as one sentence. It is
    // NOT the profile lock: granting someone edit access to their own profile
    // never changes this, and changing this never unlocks a profile.
    scope: u ? scopeLabelOf(u, e) : null,
    // "No login" is the prototype's own wording for an employee with no account.
    loginStatus: u ? (u.status || 'Active') : 'No login',
    lastLogin: u && u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : null,
  };
}

// ---------------------------------------------------------------------------
// Email one-time code — the gate in front of Add Employee.
//
// HONEST WITH NO PROVIDER. utils/mailer.js emailConfig() is the one place that
// decides whether email is switched on. When it is not, nothing is generated
// and nothing is stored: the response says exactly why, the button on the form
// says the same, and no code is ever claimed to have been sent.
// ---------------------------------------------------------------------------
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PURPOSE = 'employee-signup';

const hashOtp = (email, code) => crypto.createHash('sha256')
  .update(`${normalEmail(email)}:${String(code).trim()}`).digest('hex');

// The live, unconsumed, unexpired verification for an address, if any.
async function liveVerification(email) {
  return prisma.emailVerification.findFirst({
    where: {
      email: normalEmail(email),
      purpose: OTP_PURPOSE,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
}

module.exports = {
  productRolesForDesignation,
  ALL_ROLES,
  ATS_ROLES,
  EMAIL_RE,
  normalEmail,
  productAccessOf,
  scopeLabelOf,
  designationRows,
  defaultProductAccessByRole,
  loginRoleFor,
  productRolesForDesignation,
  syncLoginToEmployee,
  fmtDate,
  EMP_MGMT_INCLUDE,
  shapeEmployeeMgmtRow,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_PURPOSE,
  hashOtp,
  liveVerification,
};
