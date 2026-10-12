import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, StatRow } from '../../components/proto.jsx';
import Modal from '../../components/Modal.jsx';
import { downloadFrom } from './MyAttendance.jsx';
import { ScrollTable, PersonDayTiles } from './DayReport.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import '../../components/ui/ListFilters.css';
import MonthCalendar from './MonthCalendar.jsx';
import './attendance-self.css';
import './attendance-calendar.css';

// ---------------------------------------------------------------------------
// HRMS-24 §11 — the MONTHLY SUMMARY (with the old "Reports (Monthly)" merged
// in) and the punch-photo button the Punch Log uses. The Team Attendance tab
// that lived here was removed: the Biometric Attendance List is the
// date-wise, in-scope view of every person. Everything is inside the RBAC scope (the server applies
// utils/scope.js employeeWhere(): TL -> team, STL -> departments, Assistant
// Manager / Manager / HR -> their scope, Super Admin -> everyone). Every row
// is derived from real punches (web, mobile AND biometric), marked days,
// approved leave and holidays — see backend/src/utils/attendanceDays.js.
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function useDepartments() {
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/admin/departments').then((r) => setList(r.data.map((d) => d.name))).catch(() => setList([])); }, []);
  return list;
}

// The live picture stored with a verified punch, fetched with the login's token.
export function PunchImageButton({ punchId, label = 'Photo' }) {
  const [src, setSrc] = useState('');
  const [err, setErr] = useState('');
  async function open() {
    setErr('');
    try {
      const r = await api.get(`/attendance/punches/${punchId}/image`, { responseType: 'blob' });
      setSrc(URL.createObjectURL(r.data));
    } catch { setErr('Not available'); }
  }
  function close() { if (src) URL.revokeObjectURL(src); setSrc(''); }
  if (!punchId) return null;
  return (
    <>
      <button type="button" className="link-btn" onClick={open}>{label}</button>
      {err && <span className="small-muted"> {err}</span>}
      {src && (
        <Modal title="Live capture at check-in" onClose={close}>
          <div className="att-self"><img className="att-capture" src={src} alt="Live capture stored with the punch" /></div>
        </Modal>
      )}
    </>
  );
}


// ---------------------------------------------------------------------------
// MONTHLY SUMMARY — with the old "Reports (Monthly)" merged in.
//
// Per person, the month's working days by status (the one day rule,
// backend/src/utils/attendanceDays.js), plus what the monthly report had:
// attendance %, the payroll late half-day cuts and the employee-status and
// role filters. A custom period (up to a year) is allowed too, and when the
// period is exactly one the old HRMS summary was imported for, its figures are
// shown alongside, so the two can be compared line by line.
//
// People who have since left are included for the months they worked; their
// days after leaving are not counted.
// ---------------------------------------------------------------------------
function useRoles() {
  const [list, setList] = useState([]);
  useEffect(() => {
    api.get('/employees').then((r) => setList([...new Set(r.data.map((e) => e.designation).filter(Boolean))].sort())).catch(() => setList([]));
  }, []);
  return list;
}

const HR_STATUS_CHOICES = ['Active', 'Inactive', 'Notice Period', 'Suspended', 'Exit'];
// THE COUNTS (user, 2026-10-10: same numbers as the Biometric list): one tile definition for every attendance screen.
// Present INCLUDES late / early logout / missing check-in / missing check-out (notes inside it). Present + Absent + Half day +
// On leave + Week off / Holiday = Days on the rolls. Clicking a count opens the Biometric list with exactly those days.
const TILE_COLS = [
  { key: 'days', label: 'Days on the rolls', title: 'Present + Absent + Half day + On leave + Week off / Holiday (+ No device data / Not checked in yet / coming days)', plain: true },
  { key: 'present', label: 'Present', title: 'Came to work. Includes the late, early logout and missing check-in / check-out days counted in the columns after Working days' },
  { key: 'absent', label: 'Absent', title: 'No check-in, and no leave or request' },
  { key: 'halfDay', label: 'Half day', title: 'Worked one half, or has a half-day leave' },
  { key: 'onLeave', label: 'On leave', title: 'Leave (approved or waiting) or told the manager' },
  { key: 'offDay', label: 'Week off / Holiday', title: 'Sunday and company holidays' },
  { key: 'noRecord', label: 'No device data', title: 'Days the device has not sent yet (not counted as Absent)' },
  { key: 'late', label: 'of Present: Late', title: 'Inside Present: came after the Late-after time (approved ones stay Present and are not payroll lates)' },
  { key: 'earlyLogout', label: 'of Present: Early logout', title: 'Inside Present: left before the end of the working day' },
  { key: 'missingCheckIn', label: 'of Present: Missing check-in', title: 'Inside Present: only a check-out was recorded' },
  { key: 'missingCheckOut', label: 'of Present: Missing check-out', title: 'Inside Present: came in, never pressed check-out' },
  { key: 'workingDays', label: 'Working days', title: 'Days on the rolls minus Week off / Holiday and coming days', plain: true },
  { key: 'punchDays', label: 'Days with a punch', title: 'Plain fact, not a status: days with at least one punch (device, web, mobile or import)' },
];
// What payroll reads (one raw status per column) - kept, but under "Payroll detail" so nobody compares it with the counts above.
const NUM_COLS = [
  { key: 'workingDays', label: 'Working Days', title: 'Days that count: every day except weekly offs and holidays (with nothing worked), before joining or after leaving' },
  { key: 'present', label: 'Present' },
  { key: 'late', label: 'Late Coming', title: 'Present, but checked in after the Late time set in the Attendance policy' },
  { key: 'missingCheckIn', label: 'Missing Check-In', title: 'Only a check-out was recorded - no check-in' },
  { key: 'missingCheckOut', label: 'Missing Check-Out', title: 'Came in, never pressed check-out' },
  { key: 'earlyLogout', label: 'Early Logout', title: 'Left between 5:00 PM and 6:00 PM (a full day, flagged)' },
  { key: 'halfDay', label: 'Half Day', title: 'Left before 5:00 PM (1st half) or came after 1:30 PM (2nd half), no leave for the other half' },
  { key: 'halfDayHalfLeave', label: 'Half Day + Half Leave', title: 'Worked one half, approved leave for the other' },
  { key: 'absent', label: 'Absent', title: 'No check-in, and no leave or request (did not inform)' },
  { key: 'onLeave', label: 'On Leave' },
  { key: 'noData', label: 'No device data', title: 'Working days the biometric device has not sent yet (not counted as Absent)' },
  { key: 'weeklyOffs', label: 'Week off', title: 'Week off days with nothing worked (not working days for them)' },
  { key: 'holidays', label: 'Holidays' },
  { key: 'hoursWorked', label: 'Hours' },
  { key: 'paidDays', label: 'Paid Days', title: 'Present + leave (half days at ½). Leave still waiting is not paid until it is approved.' },
];

// The Monthly Summary tab: the CALENDAR (tap a day) and the per-person TABLE.
export function MonthlySummaryTab({ preset = null, goList = null }) {
  const [view, setView] = useState(() => (preset ? 'table' : 'calendar'));
  useEffect(() => { if (preset) setView('table'); }, [preset && preset.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div style={{ padding: '12px 18px 0' }}>
        <div className="att-cal-switch" role="group" aria-label="How to look at the month">
          <button type="button" className={`btn btn-sm${view === 'calendar' ? ' btn-primary' : ''}`} onClick={() => setView('calendar')}>Calendar</button>
          <button type="button" className={`btn btn-sm${view === 'table' ? ' btn-primary' : ''}`} onClick={() => setView('table')}>Table (one row per person)</button>
        </div>
      </div>
      {view === 'calendar' ? <div style={{ padding: '0 18px' }}><MonthCalendar /></div> : <MonthlyTable preset={preset} goList={goList} />}
    </div>
  );
}

function MonthlyTable({ preset = null, goList = null }) {
  const departments = useDepartments();
  const roles = useRoles();
  const thisMonth = localToday().slice(0, 7);
  const [mode, setMode] = useState('month'); // month | period
  const [month, setMonth] = useState(thisMonth);
  const [period, setPeriod] = useState({ from: `${thisMonth}-01`, to: localToday() });
  const [f, setF] = useState({ code: '', name: '', department: '', role: '', hrStatus: '' });
  const [applied, setApplied] = useState(() => (preset ? { from: preset.from, to: preset.to } : { month: thisMonth }));
  const [payroll, setPayroll] = useState(false); // show the payroll detail columns
  // opened from the Biometric list for the same dates
  useEffect(() => { if (preset) { setMode('period'); setPeriod({ from: preset.from, to: preset.to }); setApplied({ from: preset.from, to: preset.to }); } }, [preset && preset.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setError('');
    setBusy(true);
    api.get('/attendance/monthly-summary', { params: applied })
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) { setData(null); setError(e.response?.data?.error || 'Could not load the summary.'); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [applied]);

  const filters = () => Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const apply = (over) => setApplied({ ...(mode === 'month' ? { month } : { from: period.from, to: period.to }), ...filters(), ...(over || {}) });
  const showMonth = (m) => { setMode('month'); setMonth(m); setApplied({ month: m, ...filters() }); };
  const showPeriod = (from, to) => { setMode('period'); setPeriod({ from, to }); setApplied({ from, to, ...filters() }); };
  const shiftMonth = (n) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    showMonth(d.toISOString().slice(0, 7));
  };

  const t = data?.totals;
  const rows = data?.rows || [];
  const page = usePaged(rows);
  // The filters the server applied (chips), and clearing them re-asks it.
  const EMPTY_F = { code: '', name: '', department: '', role: '', hrStatus: '' };
  const periodOf = () => (mode === 'month' ? { month } : { from: period.from, to: period.to });
  const appliedOn = Object.keys(EMPTY_F).some((k) => applied[k]);
  const clearAll = () => { setF(EMPTY_F); setApplied(periodOf()); };
  const dropOne = (k) => {
    setF((cur) => ({ ...cur, [k]: '' }));
    setApplied((cur) => { const next = { ...cur }; delete next[k]; return next; });
  };
  const F_LABEL = { code: 'Employee ID', name: 'Employee', department: 'Department', role: 'Role', hrStatus: 'Employee status' };
  const chips = Object.keys(EMPTY_F).map((k) => ({ key: k, label: F_LABEL[k], value: applied[k] || '', onRemove: () => dropOne(k) }));
  const moreOn = ['code', 'role', 'hrStatus'].filter((k) => applied[k]).length;
  const imp = data?.importedTotals;
  const isMonth = !!data?.month;
  const fileName = (ext) => `attendance-summary-${applied.month || `${applied.from}_${applied.to}`}.${ext}`;

  return (
    <Panel className="att-self att-day">
      <PanelHead title={`Monthly Attendance Summary — ${data?.monthLabel || applied.month || `${applied.from} to ${applied.to}`}`}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm" disabled={!data} onClick={() => downloadFrom('/attendance/monthly-summary', { ...applied, format: 'csv' }, fileName('csv'))}>Export CSV</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!data} onClick={() => downloadFrom('/attendance/monthly-summary', { ...applied, format: 'xlsx' }, fileName('xlsx'))}>Export Excel</button>
        </div>
      </PanelHead>
      <div style={{ padding: '12px 18px 0' }}>
        {/* The list filter standard: period · Employee · Department · Apply on
            screen, Employee ID / Role / Employee status under More Filters,
            the applied filters as chips. The server does the filtering. */}
        <form className="lf att-range" style={{ marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <MoreFilters
            storageKey="attendance-monthly-summary"
            activeMore={moreOn}
            onClearAll={appliedOn ? clearAll : undefined}
            primary={(
              <>
                <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Month or period">
                  <option value="month">Month</option>
                  <option value="period">Custom period</option>
                </select>
                {mode === 'month' ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => shiftMonth(-1)} aria-label="Previous month">◀</button>
                    <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
                    <button type="button" className="btn btn-sm" onClick={() => shiftMonth(1)} aria-label="Next month">▶</button>
                  </>
                ) : (
                  <span className="lf-dates" title="Date range">
                    <span className="lf-dates-lbl">Date range</span>
                    <input type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} aria-label="From date" />
                    <span aria-hidden="true">→</span>
                    <input type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} aria-label="To date" />
                  </span>
                )}
                <input type="search" placeholder="Employee name…" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Employee name" />
                <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} aria-label="Department" title="Department">
                  <option value="">All departments</option>
                  {departments.map((d) => <option key={d}>{d}</option>)}
                </select>
                <button type="submit" className="btn btn-sm btn-primary">Apply</button>
              </>
            )}
          >
            <input placeholder="Employee ID" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} aria-label="Employee ID" />
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="Role" title="Role">
              <option value="">All roles</option>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </select>
            <select value={f.hrStatus} onChange={(e) => setF({ ...f, hrStatus: e.target.value })} aria-label="Employee status" title="Employee status">
              <option value="">All employee statuses</option>
              {HR_STATUS_CHOICES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </MoreFilters>
          <FilterChips filters={chips} onClearAll={appliedOn ? clearAll : undefined} />
        </form>
        {(data?.importedPeriods || []).length > 0 && (
          <div className="filter-row" style={{ marginTop: -4 }}>
            <span className="small-muted" style={{ alignSelf: 'center' }}>Imported old-HRMS summary:</span>
            {data.importedPeriods.map((p) => (
              <button key={`${p.from}-${p.to}`} type="button" className="btn btn-sm" onClick={() => showPeriod(p.from, p.to)}
                title="Show this exact period, with the imported summary alongside for comparison">
                {p.from} to {p.to} ({p.employees} employees)
              </button>
            ))}
          </div>
        )}
        <div style={{ marginBottom: 8 }}>
          <label className="small-muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" style={{ width: 15, height: 15, minHeight: 0, minWidth: 0 }} checked={payroll} onChange={(e) => setPayroll(e.target.checked)} />
            Also show the payroll detail columns (one raw status per column: what payroll reads, not the same as the counts above)
          </label>
        </div>
        <div className="small-muted" style={{ marginBottom: 8, fontSize: 12 }}>
          Counted day by day from actual records — biometric, web and mobile punches, the imported CSV days, marked days, approved leave,
          holidays and weekly offs. Each person counts once per day. A past working day with no check-in and no leave or request is <b>Absent</b>;
          a pending leave or attendance correction is not Absent. Days the biometric device has not sent yet are <b>No device data</b>.
          Attendance % = days worked (Present, Late, Early Logout, Missing Check-Out; a worked half at ½) ÷ Working Days.
          {isMonth && <> Late half-day cut = late days beyond the {data.freeLateArrivalsPerMonth ?? 0} free per month (what payroll deducts).</>}
          {' '}People who left are included for the days they worked.
        </div>
        {error && <div className="notice red">{error}</div>}
        {t && (
          <div style={{ margin: '4px 0 12px' }}>
            <StatRow cells={[
              { value: rows.length, label: 'Employees in this summary' },
              { value: `${t.attendancePct}%`, label: 'Attendance %' },
              ...(isMonth ? [{ value: t.lateCut, label: 'Late half-day cuts (payroll)' }] : []),
            ]} />
            <PersonDayTiles tiles={t.tiles} equation={t.equation} from={data.from} to={data.to} active="" onPick={goList ? (key) => goList(data.from, data.to, key, '') : null} />
          </div>
        )}
        {imp && (
          <div className="notice att-notice" style={{ fontSize: 12.5 }}>
            <b>Imported old-HRMS summary for this period</b> ({rows.filter((r) => r.imported).length} employees): Present {imp.present} · Half Day {imp.halfDay} ·
            Week-offs {imp.weekOffs} · Public holidays {imp.publicHolidays} · Leaves {imp.leaves} · Payable days {imp.payableDays}.
            {' '}It is shown as exported and not recalculated. Differences from TeamLink&apos;s count come from: days TeamLink has marked that the old
            HRMS did not (and the reverse); the old HRMS&apos;s own half-day rule (it counts net worked time — TeamLink uses first check-in to last check-out
            against the full-day / half-day hours in the Attendance policy); and holidays — TeamLink counts only the holidays in its Holiday list.
          </div>
        )}
      </div>
      <ScrollTable>
        <table>
          <thead>
            {imp && (
              <tr>
                <th colSpan={5} />
                <th colSpan={TILE_COLS.length + 2 + (isMonth ? 1 : 0) + (payroll ? NUM_COLS.length : 0)} className="att-group-head">TeamLink (counted day by day)</th>
                <th colSpan={6} className="att-group-head">Old HRMS (imported summary)</th>
              </tr>
            )}
            <tr>
              <th>Code</th><th>Employee</th><th>Department</th><th>Status</th><th>Left on</th>
              {TILE_COLS.map((c) => <th key={c.key} title={c.title}>{c.label}</th>)}
              <th title="Each row adds up like this">Adds up to</th>
              {payroll && NUM_COLS.map((c) => <th key={`p-${c.key}`} title={c.title} className="att-payroll-col">Payroll: {c.label}</th>)}
              <th>Attendance %</th>
              {isMonth && <th title="Late days beyond the free allowance — what payroll deducts">Late cut</th>}
              {imp && <><th>Present</th><th>Half Day</th><th>Week-offs</th><th>Holidays</th><th>Leaves</th><th>Payable</th></>}
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => (
              <tr key={r.employeeId}>
                <td><b>{r.employeeCode}</b></td>
                <td>{r.name}<div className="small-muted att-note">{r.designation || ''}</div></td>
                <td className="cell-muted">{r.department || '—'}</td>
                <td className="cell-muted">{r.hrStatus}</td>
                <td className="cell-muted" title="Last recorded attendance day of someone who has left">{r.lastDay || '—'}</td>
                {TILE_COLS.map((c) => (
                  <td key={c.key} className="att-num">
                    {goList && (!c.plain || c.key === 'punchDays')
                      ? <button type="button" className="link-btn" onClick={() => goList(data.from, data.to, `pd:${c.key === 'punchDays' ? 'punched' : c.key}`, r.employeeCode)} title="Open these days in the Biometric list">{r.tiles[c.key]}</button>
                      : r.tiles[c.key]}
                  </td>
                ))}
                <td className="small-muted att-eqcell">{r.equation}</td>
                {payroll && NUM_COLS.map((c) => <td key={`p-${c.key}`} className="att-num att-payroll-col">{r[c.key]}</td>)}
                <td className="att-num"><b>{r.attendancePct}%</b></td>
                {isMonth && <td className="att-num">{r.lateCut}</td>}
                {imp && (r.imported
                  ? <><td className="att-num">{r.imported.present}</td><td className="att-num">{r.imported.halfDay}</td><td className="att-num">{r.imported.weekOffs}</td>
                    <td className="att-num">{r.imported.publicHolidays}</td><td className="att-num">{r.imported.leaves}</td><td className="att-num">{r.imported.payableDays}</td></>
                  : <td colSpan={6} className="small-muted">Not in the imported summary</td>)}
              </tr>
            ))}
            {data && rows.length === 0 && (
              <tr><td colSpan={20}>
                <ListEmpty lf={{ activeCount: appliedOn ? 1 : 0, clear: clearAll }} noun="employees" title="No employees in your scope were on the rolls in this period." />
              </td></tr>
            )}
            {!data && !error && <tr><td colSpan={20} className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
          </tbody>
          {t && rows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={5}>Total — {rows.length} employee(s)</td>
                {TILE_COLS.map((c) => <td key={c.key} className="att-num">{t.tiles[c.key]}</td>)}
                <td className="small-muted att-eqcell">{t.equation}</td>
                {payroll && NUM_COLS.map((c) => <td key={`p-${c.key}`} className="att-num att-payroll-col">{t[c.key]}</td>)}
                <td className="att-num">{t.attendancePct}%</td>
                {isMonth && <td className="att-num">{t.lateCut}</td>}
                {imp && <><td className="att-num">{imp.present}</td><td className="att-num">{imp.halfDay}</td><td className="att-num">{imp.weekOffs}</td>
                  <td className="att-num">{imp.publicHolidays}</td><td className="att-num">{imp.leaves}</td><td className="att-num">{imp.payableDays}</td></>}
              </tr>
            </tfoot>
          )}
        </table>
      </ScrollTable>
      {page.total > 0 && <Pager page={page} noun="employees" />}
      <div className="small-muted" style={{ padding: '10px 18px' }}>
        {busy ? 'Loading…' : data ? `${rows.length} employee(s) · ${data.from} to ${data.to}` : ''}
        {data?.earlyStarts?.length > 0 && (
          <div style={{ marginTop: 4 }}>
            Note: {data.earlyStarts.length} employee(s) have attendance before their date of joining in Employee Management
            ({data.earlyStarts.map((x) => `${x.employeeCode} joined ${x.dateOfJoining}, first attendance ${x.firstAttendance}`).join('; ')}) —
            their days from the first attendance are counted. Correct the date of joining in Employee Management if it is wrong.
          </div>
        )}
      </div>
    </Panel>
  );
}
