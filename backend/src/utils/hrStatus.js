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
// Keep in step with frontend/src/hrStatus.js.
// ---------------------------------------------------------------------------
const HR_STATUSES = ['Active', 'Inactive', 'Notice Period', 'Suspended', 'Exit'];
const EXIT_EMPLOYMENT = ['Relieved', 'Exited', 'Exit Process'];

function hrStatusOf(employmentStatus, loginStatus) {
  if (EXIT_EMPLOYMENT.includes(employmentStatus)) return 'Exit';
  if (loginStatus === 'Suspended' || employmentStatus === 'Suspended') return 'Suspended';
  if (loginStatus === 'Inactive' || employmentStatus === 'Inactive') return 'Inactive';
  if (employmentStatus === 'Notice Period') return 'Notice Period';
  return 'Active';
}

// ACTIVE EMPLOYEES FIRST (founder 2026-11-14): the Employee status choice of a people list is one of the three groups
// Active (everybody who has not left) / Exited / Relieved, or one of the finer HR statuses above. Keep in step with
// frontend/src/hrStatus.js and routes/recruiterJoinings.js (statusGroupOf).
const STATUS_GROUPS = ['Active', 'Exited', 'Relieved'];
const statusGroupOf = (employmentStatus) => (employmentStatus === 'Relieved' ? 'Relieved' : employmentStatus === 'Exited' ? 'Exited' : 'Active');
function employeeStatusMatches(choice, employmentStatus, loginStatus) {
  if (!choice) return true;
  if (STATUS_GROUPS.includes(choice)) return statusGroupOf(employmentStatus) === choice;
  return hrStatusOf(employmentStatus, loginStatus) === choice;
}

module.exports = { HR_STATUSES, EXIT_EMPLOYMENT, hrStatusOf, STATUS_GROUPS, statusGroupOf, employeeStatusMatches };
