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
const { CATALOG_ROLES } = require('./roleAccess');

const ALL_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL',
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
function productAccessOf(user) {
  return {
    hrms: user.hrmsAccess ? 'Yes' : 'No Access',
    ats: user.atsAccess ? (user.atsRole || 'Yes') : 'No Access',
    accounts: user.accountsAccess ? 'Yes' : 'No Access',
  };
}

function scopeLabelOf(user, emp) {
  if (!user) return null;
  if (user.role === 'CLIENT') return `Client: ${user.client?.name || 'not assigned'}`;
  if (user.role === 'CANDIDATE') return 'Own profile only';
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return 'All departments';
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
  if (mapping.accounts && !mapping.ats) return 'ACCOUNTANT';
  return 'EMPLOYEE';
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
  ALL_ROLES,
  ATS_ROLES,
  EMAIL_RE,
  normalEmail,
  productAccessOf,
  scopeLabelOf,
  designationRows,
  defaultProductAccessByRole,
  loginRoleFor,
  fmtDate,
  EMP_MGMT_INCLUDE,
  shapeEmployeeMgmtRow,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_PURPOSE,
  hashOtp,
  liveVerification,
};
