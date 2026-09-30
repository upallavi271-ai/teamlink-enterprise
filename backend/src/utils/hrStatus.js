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

module.exports = { HR_STATUSES, EXIT_EMPLOYMENT, hrStatusOf };
