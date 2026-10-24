// ---------------------------------------------------------------------------
// THE HR DESK  (user, 2026-10-13: "HR ki Clients & Requirements ni kanipinchakudadu.
// Only INTERNAL requirements matrame.")
//
// ONE rule, one place: isHrDesk() says whether a login is HR for the ATS side.
// An HR-desk login works ONLY on TeamLink's own (internal) openings: no clients,
// no client details, no agreements, no client jobs, no client candidates.
//
// utils/identity.js resolves it once per request and, for an HR desk login, sets
// the ATS role to 'HR'. Every ATS guard, scope (utils/scope.js: HR = internal only)
// and the sidebar then follow the HR role that already exists for it. The person's
// HRMS role is NOT touched.
//
// Who is the HR desk (the key is the PERSON, never the department name alone, so
// HR-department recruiters who work CLIENT jobs keep them):
//   1. ATS role HR (stored, or from the HR designation mapping)
//   2. HRMS role HR and no ATS working role (nothing else to work client jobs in)
//   3. department "Internal HR" (TL / STL / Employee / none; a RECRUITER keeps any client job assigned)
//   4. department "HR" / "Human Resource(s)" AND ATS role TL / STL / HR / Employee
//      (an HR-department TL is the HR desk's lead; a RECRUITER there is not,
//      so a recruiter assigned to client jobs keeps them)
//   5. designation "HR Manager" / "HR Executive" / "HR" with no ATS working role
// Never: Super Admin, Admin, Client, Candidate, an exited / relieved employee
// (their login is off anyway), Manager / Assistant Manager, BDE, BDE TL, Accountant.
// ---------------------------------------------------------------------------
const { isInternalHrName } = require('./internalHr');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const isHrDepartmentName = (d) => ['hr', 'humanresource', 'humanresources', 'hrdepartment'].includes(norm(d));
const isHrDesignation = (d) => ['hr', 'hrmanager', 'hrexecutive', 'hrassistant', 'hrofficer'].includes(norm(d));

// ATS roles that make a person a client-hiring worker (never the HR desk by weaker signals).
const WORKING = ['RECRUITER', 'TL', 'STL', 'BDE', 'MANAGER', 'ASSISTANT_MANAGER', 'ACCOUNTANT', 'SUPER_ADMIN', 'ADMIN'];
const NEVER = ['SUPER_ADMIN', 'ADMIN', 'CLIENT', 'CANDIDATE', 'MANAGER', 'ASSISTANT_MANAGER', 'BDE', 'ACCOUNTANT'];
const none = (r) => !r || r === 'NONE';

// p: { role, atsRole, hrmsRole, department, designation, employmentStatus, bdeTl }
function isHrDesk(p) {
  if (!p) return false;
  const ats = none(p.atsRole) ? null : p.atsRole;
  const hrms = none(p.hrmsRole) ? null : p.hrmsRole;
  if (NEVER.includes(p.role) || NEVER.includes(ats)) return false;
  if (p.bdeTl) return false;
  if (['Relieved', 'Exited'].includes(p.employmentStatus)) return false;
  if (ats === 'HR') return true;
  if (hrms === 'HR' && (!ats || ats === 'EMPLOYEE')) return true;
  if (isInternalHrName(p.department) && ats !== 'RECRUITER') return true;
  if (isHrDepartmentName(p.department) && ['TL', 'STL', 'EMPLOYEE'].includes(ats)) return true;
  if (isHrDesignation(p.designation) && (!ats || ats === 'EMPLOYEE')) return true;
  return false;
}

const MESSAGE = 'This section is for client hiring. You work on internal hiring.';
// Express guard: 403 with the plain sentence for an HR-desk login (mounted on the client routes).
function blockHrDesk(req, res, next) {
  if (req.user && req.user.hrDesk) return res.status(403).json({ error: MESSAGE });
  return next();
}

module.exports = { isHrDesk, isHrDepartmentName, isHrDesignation, blockHrDesk, MESSAGE, WORKING };
