import { statusGroupOf } from '../hrStatus';

// ---------------------------------------------------------------------------
// WHERE A PERSON STANDS, WRITTEN NEXT TO THE NAME (founder 2026-11-14).
//
// Every list of people opens with the Active employees; when the screen's
// Employee status filter brings back the Exited / Relieved ones, this writes
// "Exited" or "Relieved" beside the name. An Active person gets nothing, so
// the opening list stays clean.
//
//   <td>{e.name}<EmployeeStatusTag employee={e} /></td>        beside the name
//   <td>{e.name}<EmployeeStatusTag employee={e} block /></td>  under the name
//   <EmployeeStatusTag status="Exited" />                      when you only have the status text
//
// Grouping = hrStatus.js statusGroupOf (the same rule as Recruiter joinings
// and Monthly Targets).
// ---------------------------------------------------------------------------
// One line under a list that opens on Active: how many rows of people who have left are not shown (founder 2026-11-14).
//   <HiddenLeftNote filters={pf} rows={records} noun="tickets" extra={openLeft ? ' (' + openLeft + ' still open)' : ''} />
// active = false when the bar does not draw the Employee status control (the filter is then not applied either).
export function HiddenLeftNote({ filters, rows, getEmployee = (r) => r.employee || r, noun = 'records', active = true, extra = '', style }) {
  const on = active && filters && filters.empStatus === 'Active';
  const n = on ? (rows || []).filter((r) => statusGroupOf((getEmployee(r) || {}).employmentStatus) !== 'Active').length : 0;
  if (!n) return null;
  return (
    <p className="small-muted" style={{ margin: '0 0 8px', ...style }}>
      Showing the people who are still here. {n} {noun} of people who have left {n === 1 ? 'is' : 'are'} not shown{extra}: choose <b>Employee status → All</b> (or Exited / Relieved).
    </p>
  );
}

export default function EmployeeStatusTag({ employee, employmentStatus, status, block = false }) {
  const group = status || statusGroupOf(employmentStatus !== undefined ? employmentStatus : employee?.employmentStatus);
  if (!group || group === 'Active') return null;
  return <span className={`emp-status-tag emp-status-${String(group).toLowerCase()}${block ? ' block' : ''}`} title={`${group}: no longer working here`}>{group}</span>;
}
