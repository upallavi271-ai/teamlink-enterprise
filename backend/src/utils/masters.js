// ---------------------------------------------------------------------------
// THE LIVE MASTER LISTS — "when a role is added, it must automatically appear
// in the dropdowns" (the user's rule, 2026-09-29).
//
// ONE server-side reader for every option list the employee screens, the
// filters and the import "Lists" sheets offer. Nothing here is a hard-coded
// list of roles, designations, departments or teams: each comes from its
// master table (Role / DesignationRole / Department / Team / ShiftPattern),
// UNIONED with the values already on employee records, so a legacy value is
// never silently dropped from a picker.
//
//   roles          active roles from Role Catalog (system + custom), not the
//                  external Client / Candidate kinds
//   designations   DesignationRole
//   departments    Department master ∪ Employee.department in use
//   teams          Team master (with its department)
//   branches       office branches in use (∪ the three offices)
//   locations      work locations in use (∪ the ATS location vocabulary)
//   employmentStatuses / employmentTypes / genders / bloodGroups /
//   addressTypes / experience / shifts
//   version        changes whenever any of the above changes (cache-bust key)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { designationRows } = require('./employeeAdmin');
const { listRoles } = require('./roleRegistry');
const { EMP_TYPES } = require('./adminCatalog');
const { LOCS } = require('./atsVocab');

// The Employee.employmentStatus vocabulary the app writes (prisma schema).
const EMPLOYMENT_STATUSES = ['Active', 'On Probation', 'Notice Period', 'Exit Process', 'Relieved', 'Exited'];
const DEFAULT_BRANCHES = ['Bengaluru', 'Chennai', 'Hyderabad'];
const GENDERS = ['Male', 'Female', 'Other'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const ADDRESS_TYPES = ['Current', 'Permanent'];
const EXPERIENCE = ['Fresher', 'Experienced'];

const uniq = (list) => [...new Set(list.map((v) => (v == null ? '' : String(v).trim())).filter(Boolean))];
const sorted = (list) => uniq(list).sort((a, b) => a.localeCompare(b));

// opts.departments (optional): the department names the caller's scope
// reaches (utils/scope.js scopeDepartments). When given, the department /
// team lists — and the in-use values read off employee records — are cut to
// those departments, so a Medical TL is never even OFFERED "IT" (the rule
// GET /admin/departments already follows). Undefined = company-wide.
async function masterLists(opts = {}) {
  const allowed = Array.isArray(opts.departments)
    ? new Set(opts.departments.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const inScope = (name) => !allowed || allowed.has(String(name || '').trim().toLowerCase());
  const [roles, desig, depts, teams, shifts, inUseAll] = await Promise.all([
    listRoles({ activeOnly: true }),
    designationRows(),
    prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.team.findMany({ select: { name: true, department: { select: { name: true } } }, orderBy: { name: 'asc' } }).catch(() => []),
    prisma.shiftPattern.findMany({ where: { active: true }, select: { name: true, startTime: true, endTime: true }, orderBy: { name: 'asc' } }).catch(() => []),
    prisma.employee.findMany({
      select: {
        department: true, designation: true, branch: true, location: true, employmentStatus: true, employeeType: true, team: true, shift: true,
      },
    }),
  ]);
  const inUse = allowed ? inUseAll.filter((e) => inScope(e.department)) : inUseAll;
  const teamsIn = allowed ? teams.filter((t) => t.department && inScope(t.department.name)) : teams;
  const col = (k) => inUse.map((e) => e[k]);
  const out = {
    roles: roles.filter((r) => !r.external).map((r) => ({ code: r.code, name: r.name, isSystem: r.isSystem, products: r.products })),
    designations: uniq(desig.map((d) => d.designation)),
    departments: sorted([...depts.map((d) => d.name).filter(inScope), ...col('department')]),
    teams: teamsIn.map((t) => ({ name: t.name, department: t.department ? t.department.name : null })),
    teamNames: sorted([...teamsIn.map((t) => t.name), ...col('team')]),
    branches: sorted([...DEFAULT_BRANCHES, ...col('branch')]),
    locations: sorted([...LOCS, ...col('location')]),
    employmentStatuses: uniq([...EMPLOYMENT_STATUSES, ...col('employmentStatus')]),
    employmentTypes: uniq([...EMP_TYPES, ...col('employeeType')]),
    genders: GENDERS,
    bloodGroups: BLOOD_GROUPS,
    addressTypes: ADDRESS_TYPES,
    experience: EXPERIENCE,
    shifts: uniq([...shifts.map((s) => s.name), ...col('shift')]),
  };
  out.version = crypto.createHash('sha1').update(JSON.stringify(out)).digest('hex').slice(0, 12);
  return out;
}

module.exports = {
  masterLists, EMPLOYMENT_STATUSES, DEFAULT_BRANCHES, GENDERS, BLOOD_GROUPS, ADDRESS_TYPES, EXPERIENCE,
};
