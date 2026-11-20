import MultiSelect, { csvToList } from './ats/MultiSelect.jsx'; // checkboxes: several values per filter (founder 2026-11-20)
import MoreFilters from './ui/MoreFilters.jsx';
import FilterChips from './FilterChips.jsx';
import { STATUS_GROUPS, DEFAULT_EMPLOYEE_STATUS, ALL_EMPLOYEE_STATUSES, employeeStatusMatches } from '../hrStatus';
import './ui/ListFilters.css';

// ---------------------------------------------------------------------------
// ONE FILTER BAR FOR EVERY HRMS LIST (the Leave filter bar, made shared).
//
//   Search · Employee name · Department · Status · <page filters> ·
//   More Filters ▾ (Employee ID · Role · Employee status · Date range · <more>)
//   · Clear All · N of M, then the active filters as chips.
//
// It follows the list filter standard (review #3 §14 / user notes #1): the
// few filters people use every day stay on screen, the rest sit under "More
// Filters ▾" (components/ui/MoreFilters.jsx), and every active filter — the
// hidden ones too — is shown as a removable chip (components/FilterChips.jsx),
// so nothing ever narrows the list silently.
//
// Filtering is client-side over the rows the page already loaded — the server
// has scoped them to what this login may see, so the bar can only narrow.
//
//   Role    = the employee's designation, which is what every "All roles"
//             filter in HRMS already means.
//   Status  = whatever the ROW's status is. A ticket list offers ticket
//             statuses, an asset list asset statuses; only a list of PEOPLE
//             offers the five HR statuses (hrStatus.js). The page passes the
//             options and, when the row's status is not `row.status`, how to
//             read it.
//
//   Employee status = the PERSON's status, on every list of people, next to
//             the record's own status: "the open tickets of people who have
//             left". ACTIVE EMPLOYEES FIRST (founder 2026-11-14): the list
//             OPENS on Active (everybody who has not left: Active, On
//             Probation, Notice Period ...); Exited and Relieved are one
//             choice away, and "All" shows everybody. Write the status next
//             to the name with components/EmployeeStatusTag.jsx. The choices
//             are the three groups of hrStatus.js (Active / Exited /
//             Relieved) plus the finer HR statuses (Notice Period, Inactive,
//             Suspended). It is on screen, not under More Filters, and it is
//             a chip like every other filter, so nothing narrows silently.
//             "Clear All" returns to the opening view (Active), not to All.
//             A page OPTS IN to "Active first": its state starts from
//             OPENING_PEOPLE_FILTERS (empStatus 'Active') and the bar gets
//             activeFirst, so "Clear All" goes back to Active. A page that
//             keeps EMPTY_PEOPLE_FILTERS still opens on All (screens where
//             hiding the people who left would hide pending money or work).
//             A bar with no Employee status control (people={false}, or a
//             login that sees one person) ignores the key - and the page must
//             too: call peopleMatches with { ...pf, empStatus: '' } there.
//
//   Date range (optional, `dates="Raised on"`) = filters.from / filters.to,
//             matched by peopleMatches() against the row's date (5th
//             argument; default row.date || row.createdAt).
//
// A control is drawn only when the page passes its options, so a list with no
// employee on it (announcements, policy documents) can use the same bar with
// just a title search, a department and its own status.
//
// Page-specific filters: `children` stay on screen, `more` goes under More
// Filters. Their chips are labelled from `labels` ({ category: 'Category' });
// a key with no label is shown with its own name capitalised.
// ---------------------------------------------------------------------------
export const EMPTY_PEOPLE_FILTERS = { code: '', name: '', department: '', role: '', empStatus: '', status: '' };
// ACTIVE EMPLOYEES FIRST (founder 2026-11-14): the same filters, opening on the people who are still here. Pass activeFirst to the bar too.
export const OPENING_PEOPLE_FILTERS = { ...EMPTY_PEOPLE_FILTERS, empStatus: DEFAULT_EMPLOYEE_STATUS };

const employeeOfRow = (r) => r.employee || r;
const statusOfRow = (r) => r.status;
const dateOfRow = (r) => r.date || r.createdAt;
const has = (value, q) => String(value || '').toLowerCase().includes(String(q).trim().toLowerCase());
const isoDay = (v) => {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

// One value or several ticked ones (a comma list, the checkbox dropdowns): the row's value is one of them.
export const oneOf = (picked, value) => !picked || String(picked) === String(value ?? '') || csvToList(picked).includes(String(value ?? ''));

// Free-text match for the optional search box (filters.q) and any page extras.
export function textMatches(value, q) {
  return !q || has(value, q);
}

export function peopleMatches(row, f, getEmployee = employeeOfRow, getStatus = statusOfRow, getDate = dateOfRow) {
  const e = getEmployee(row) || {};
  if (f.code && !has(e.employeeCode, f.code)) return false;
  if (f.name && !has(e.name, f.name)) return false;
  if (f.department && !oneOf(f.department, e.department)) return false;
  if (f.role && !oneOf(f.role, e.designation)) return false;
  if (f.empStatus && !csvToList(f.empStatus).some((s) => employeeStatusMatches(s, e.employmentStatus, e.loginStatus ?? e.user?.status))) return false;
  if (f.status && !oneOf(f.status, getStatus(row))) return false;
  if (f.from || f.to) {
    const d = isoDay(getDate(row));
    if (!d) return false;
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
  }
  return true;
}

// Department and role options from the rows actually loaded — distinct, sorted.
export function peopleOptions(rows, getEmployee = employeeOfRow) {
  // '—' is how some routes spell "none"; it is not an option.
  const pick = (k) => [...new Set(rows.map((r) => (getEmployee(r) || {})[k]).filter((v) => v && v !== '—'))].sort();
  return { departments: pick('department'), roles: pick('designation') };
}

// A record's status options: its known vocabulary first, in order, then any
// other value actually on file (older rows, a status added server-side), so
// the dropdown never offers a status the list cannot have nor hides one it has.
export function statusOptions(rows, known = [], getStatus = statusOfRow) {
  const extra = [...new Set(rows.map(getStatus).filter(Boolean))].filter((s) => !known.includes(s)).sort();
  return [...known, ...extra];
}

const BUILT_IN = {
  q: 'Search', code: 'Employee ID', name: 'Employee', department: 'Department', role: 'Role',
  empStatus: 'Employee status', status: 'Status',
};
const cap = (k) => String(k).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const HIDDEN = ['code', 'role'];
// Finer HR statuses that stay on offer after the three groups (they were always here).
const FINER_STATUSES = ['Notice Period', 'Inactive', 'Suspended'];

export default function PeopleFilterBar({
  filters, setFilters,
  people = true, // Employee ID + Employee name
  employeeStatus = people, // the Employee status of the person (Active / Exited / Relieved, and the finer HR statuses)
  statusChoices, // override the Employee status choices (a page whose rows only carry the five HR statuses passes HR_STATUSES)
  statusAllLabel = ALL_EMPLOYEE_STATUSES, // the "no filter" choice's wording
  activeFirst = false, // the page opens on Active (state from OPENING_PEOPLE_FILTERS): "Clear All" returns to Active, not to All
  search, // placeholder for a free-text box bound to filters.q
  departments, roles, statuses,
  statusLabel = 'All statuses',
  dates, // label of an optional Date range (filters.from / filters.to)
  labels = {}, // chip labels for page-specific keys
  moreKeys = [], // page-specific keys whose controls are passed in `more`
  shown, total,
  children, more, style,
}) {
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  // empStatus only counts where this bar draws the Employee status filter; its opening value is Active.
  const val = (k, v) => (k === 'empStatus' && !employeeStatus ? '' : v);
  const opening = (k) => (k === 'empStatus' && employeeStatus && activeFirst ? DEFAULT_EMPLOYEE_STATUS : '');
  const on = Object.entries(filters).some(([k, v]) => val(k, v));
  const changed = Object.entries(filters).some(([k, v]) => (val(k, v) || '') !== opening(k));
  // Clears every key the page keeps in this state, its own extras included - back to the OPENING view (Employee status Active when activeFirst).
  const clear = () => setFilters((f) => Object.fromEntries(Object.keys(f).map((k) => [k, opening(k)])));

  const moreOn = Object.entries(filters).filter(([k, v]) => v && (HIDDEN.includes(k) || moreKeys.includes(k))).length
    + (filters.from || filters.to ? 1 : 0);
  const hasMore = people || roles || dates || more;

  const chips = [];
  Object.entries(filters).forEach(([k, v]) => {
    if (!val(k, v) || k === 'from' || k === 'to') return;
    chips.push({ key: k, label: labels[k] || BUILT_IN[k] || cap(k), value: v, onRemove: () => set(k, '') });
  });
  if (filters.from || filters.to) {
    chips.push({
      key: 'dates',
      label: dates || 'Date range',
      value: filters.from && filters.to ? `${dmy(filters.from)} → ${dmy(filters.to)}` : filters.from ? `from ${dmy(filters.from)}` : `to ${dmy(filters.to)}`,
      onRemove: () => setFilters((f) => ({ ...f, from: '', to: '' })),
    });
  }

  return (
    <div className="pfb lf" style={{ marginTop: 14, marginBottom: 12, ...style }}>
      <MoreFilters
        activeMore={moreOn}
        onClearAll={changed ? clear : undefined}
        primary={(
          <>
            {search && <input type="search" placeholder={`Search ${String(search).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())}…`} value={filters.q || ''} onChange={(e) => set('q', e.target.value)} aria-label="Search" style={{ minWidth: 200 }} />}
            {people && <input placeholder="Employee name" value={filters.name || ''} onChange={(e) => set('name', e.target.value)} aria-label="Employee name" />}
            {/* A department is a plain name, or { value, label } when the page shows a count ("HR (3)"). */}
            {departments && <MultiSelect label="Department" allLabel="All departments" hideZero={false} value={filters.department || ''} onChange={(v) => set('department', v)} options={departments.map((d) => (typeof d === 'string' ? { value: d, label: d } : { value: d.value, label: d.label }))} />}
            {statuses && <MultiSelect label="Status" allLabel={statusLabel} hideZero={false} value={filters.status || ''} onChange={(v) => set('status', v)} options={statuses.map((s) => ({ value: s, label: s }))} />}
            {employeeStatus && <MultiSelect label="Employee status" allLabel={statusAllLabel} hideZero={false} title="Employee status: Active = everybody who has not left (including probation and notice period); Exited and Relieved have left" value={filters.empStatus || ''} onChange={(v) => set('empStatus', v)} options={(statusChoices || [...STATUS_GROUPS, ...FINER_STATUSES]).map((st) => ({ value: st, label: st }))} />}
            {children}
          </>
        )}
        extra={total != null ? <span className="small-muted lf-count">{on ? `${shown} of ${total}` : `${total}`} shown</span> : null}
      >
        {hasMore ? (
          <>
            {people && <input placeholder="Employee ID" value={filters.code || ''} onChange={(e) => set('code', e.target.value)} aria-label="Employee ID" />}
            {roles && <MultiSelect label="Role" allLabel="All roles" hideZero={false} value={filters.role || ''} onChange={(v) => set('role', v)} options={roles.map((r) => ({ value: r, label: r }))} />}
            {dates && (
              <span className="lf-dates" title={dates}>
                <span className="lf-dates-lbl">{dates}</span>
                <input type="date" value={filters.from || ''} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} aria-label={`${dates} from`} />
                <span aria-hidden="true">→</span>
                <input type="date" value={filters.to || ''} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} aria-label={`${dates} to`} />
              </span>
            )}
            {more}
          </>
        ) : null}
      </MoreFilters>
      <FilterChips filters={chips} onClearAll={changed ? clear : undefined} />
    </div>
  );
}
