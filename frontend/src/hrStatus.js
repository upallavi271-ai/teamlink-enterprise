// ---------------------------------------------------------------------------
// THE FIVE HRMS STATUSES
//
// Every status filter in HRMS (Employee Management, Users, the HRMS dashboard)
// offers exactly these five. A person's HR record and their login are two
// separate fields, so this is the one place that folds both into one answer:
//
//   Exit           employment Relieved / Exited / Exit Process — they have left,
//                  whatever their login still says
//   Suspended      login suspended
//   Inactive       login disabled, or the HR record marked Inactive
//   Notice Period  serving notice
//   Active         everyone else (Active, On Probation)
//
// Keep in step with backend/src/utils/hrStatus.js.
// ---------------------------------------------------------------------------
export const HR_STATUSES = ['Active', 'Inactive', 'Notice Period', 'Suspended', 'Exit'];
export const EXIT_EMPLOYMENT = ['Relieved', 'Exited', 'Exit Process'];

export function hrStatusOf(employmentStatus, loginStatus) {
  if (EXIT_EMPLOYMENT.includes(employmentStatus)) return 'Exit';
  if (loginStatus === 'Suspended' || employmentStatus === 'Suspended') return 'Suspended';
  if (loginStatus === 'Inactive' || employmentStatus === 'Inactive') return 'Inactive';
  if (employmentStatus === 'Notice Period') return 'Notice Period';
  return 'Active';
}


// ---------------------------------------------------------------------------
// ACTIVE EMPLOYEES FIRST (founder, 2026-11-14)
//
// Every list of people opens with the people who are still here. Exited and
// Relieved people are one choice away in the screen's "Employee status"
// filter, and their status is written next to the name (EmployeeStatusTag).
//
//   Active    everybody who has not left: Active, On Probation, Notice Period,
//             Exit Process, Inactive, Suspended ...
//   Exited    employmentStatus 'Exited'
//   Relieved  employmentStatus 'Relieved'
//
// Same grouping as backend/src/routes/recruiterJoinings.js (statusGroupOf) and
// pages/hrms/Targets.jsx: do not invent another rule. The five HR statuses
// above stay available as the finer choices (Notice Period, Inactive,
// Suspended) for the screens that always had them.
// ---------------------------------------------------------------------------
export const STATUS_GROUPS = ['Active', 'Exited', 'Relieved'];
export const DEFAULT_EMPLOYEE_STATUS = 'Active';
export const ALL_EMPLOYEE_STATUSES = 'All: Active, Exited and Relieved';

export function statusGroupOf(employmentStatus) {
  return employmentStatus === 'Relieved' ? 'Relieved' : employmentStatus === 'Exited' ? 'Exited' : 'Active';
}

// The Employee status choices every list offers, in order (the three groups, then the finer HR statuses).
export const EMPLOYEE_STATUS_CHOICES = [...STATUS_GROUPS, 'Notice Period', 'Inactive', 'Suspended'];

// For components/ui/ListFilters.jsx (useListFilters): the Employee status field, and the view the list OPENS on.
//   const lf = useListFilters(rows, [ ..., employeeStatusField({ get: (r) => r.employee?.employmentStatus }) ], { opening: EMPLOYEE_OPENING });
export function employeeStatusField({ key = 'status', label = 'Employee status', get, getLogin, primary = true } = {}) {
  return {
    key, label, allLabel: ALL_EMPLOYEE_STATUSES, options: EMPLOYEE_STATUS_CHOICES, primary,
    match: (row, choice) => employeeStatusMatches(choice, get(row), getLogin ? getLogin(row) : undefined),
  };
}
export const EMPLOYEE_OPENING = { status: DEFAULT_EMPLOYEE_STATUS };

// Does this person fit the Employee status choice on screen? '' = everybody.
// Active / Exited / Relieved are the three groups; Notice Period, Inactive
// and Suspended are the finer HR statuses (hrStatusOf).
export function employeeStatusMatches(choice, employmentStatus, loginStatus) {
  if (!choice) return true;
  if (STATUS_GROUPS.includes(choice)) return statusGroupOf(employmentStatus) === choice;
  return hrStatusOf(employmentStatus, loginStatus) === choice;
}
