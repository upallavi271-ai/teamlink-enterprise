import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import TabsPage from '../components/TabsPage.jsx';
import { downloadCsv, to12h } from '../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, TwoCol, QaRow, Status } from '../components/proto.jsx';
import { can, isAdmin, isSuperAdmin, isHR as hasHrmsAdmin, canEditAttendance, canDecideAttendance } from '../permissions';
import HistoryImport from './attendance/HistoryImport.jsx';
import Combo from '../components/Combo.jsx';
import { HR_STATUSES, hrStatusOf } from '../hrStatus';
import { ApprovalChainModal, ApprovalChainLine } from '../components/ApprovalChain.jsx';
// HRMS-24 §4/§5/§10/§11 — My Attendance (live face + location check-in), team
// attendance, the monthly summary and the check-in settings live in their own files.
import MyAttendance, { downloadFrom } from './attendance/MyAttendance.jsx';
// The Monthly Summary also carries the old "Reports (Monthly)" figures; the
// Team Attendance tab is gone — the Biometric list is the day-by-day view.
import { MonthlySummaryTab, PunchImageButton } from './attendance/TeamAttendance.jsx';
import { DayKpis, RangeBar, RangeKpis, DateTotalsTable, ScrollTable, matchesKpi, fmtDay, clock12, localToday, BUCKET_LABEL } from './attendance/DayReport.jsx';
import { DayStatus } from './attendance/MyAttendance.jsx';
import NotifySettings from './attendance/NotifySettings.jsx';
import CheckinSettings from './attendance/CheckinSettings.jsx';
import AlertSettings from './attendance/AlertSettings.jsx';
import KpiReport from './attendance/KpiReport.jsx';
import ExportMenu from '../components/ExportMenu.jsx';
import InsightsPanel from '../components/charts/InsightsPanel.jsx';
import DataIoBar from '../components/dataio/DataIoBar.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import PeopleFilterBar from '../components/PeopleFilterBar.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../components/ui/ListFilters.jsx';

// The daily-marking status filter. "On Leave" is stored as Leave; "Not marked"
// is a row with no attendance yet for the day.
const MARK_STATUSES = ['Present', 'Absent', 'Late', 'Half Day', 'On Leave', 'Not marked'];
const markStatusOf = (s) => (!s ? 'Not marked' : s === 'Leave' ? 'On Leave' : s);
const EMPTY_MARK = { q: '', department: '', empStatus: '', status: '' };

// The office's local calendar day (toISOString() would be UTC, and put the
// early morning on the previous day).
const today = () => localToday();

// The code/name/department/role filters shared by the Biometric, Punch Log and
// Reports tabs — kept in one place so all three read the same way.
function filterQuery(filters) {
  const params = new URLSearchParams();
  Object.keys(filters).forEach((k) => { if (filters[k]) params.set(k, filters[k]); });
  return params.toString();
}

// The prototype's role select lists every designation actually on file.
function useRoles(enabled) {
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    api.get('/employees')
      .then((res) => setRoles([...new Set(res.data.map((e) => e.designation).filter(Boolean))].sort()))
      .catch(() => setRoles([]));
  }, [enabled]);
  return roles;
}

function StatusPill({ status }) {
  if (!status) return <span className="status pending">Not marked</span>;
  const cls = ['Present', 'WFH'].includes(status) ? 'active' : status === 'Absent' ? 'rejected' : 'pending';
  return <span className={`status ${cls}`}>{status}</span>;
}

// ---- Tab 1: Dashboard -------------------------------------------------------

const TREND_RANGE_KEY = 'tl_range_attendance_trend';

const KPI_NAME = {
  ...BUCKET_LABEL,
  headcount: 'Everyone (headcount)', late: 'Late arrivals', checkedIn: 'Checked in', checkedOut: 'Checked out', missingCheckOut: 'Missing check-out', punched: 'People with punches',
  presentAny: 'Present on ≥ 1 day', presentAll: 'Present every working day', halfDayAny: 'Half day on ≥ 1 day', absentAny: 'Absent on ≥ 1 day',
  onLeaveAny: 'On leave on ≥ 1 day', noRecordAny: 'No device data on ≥ 1 day', lateAny: 'Late on ≥ 1 day',
};

function NoDataNotice({ data, to }) {
  if (!data || !data.latestDataDate || !(to > data.latestDataDate) || to > data.today) return null;
  return (
    <div className="notice att-notice">
      No punch or marked attendance has been recorded after <b>{fmtDay(data.latestDataDate)}</b> — past working days since then show as
      <b> No device data</b> (not Absent) until the device punches or an import arrive.
    </div>
  );
}

function DashboardTab({ isHR, canMark, goTab, canImportHistory = false }) {
  const [range, setRange] = useState({ from: today(), to: today() });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showMarking, setShowMarking] = useState(true);
  const [mf, setMf] = useState(EMPTY_MARK);
  // A KPI card clicked = the list below narrowed to those people.
  const [kpi, setKpi] = useState('');
  // The trend charts start on This Month (a one-day trend says nothing);
  // a period the user picked before is kept.
  useState(() => {
    try {
      if (!localStorage.getItem(TREND_RANGE_KEY)) localStorage.setItem(TREND_RANGE_KEY, JSON.stringify({ range: 'this_month', from: '', to: '' }));
    } catch { /* private window */ }
    return null;
  });
  const single = range.from === range.to;
  const date = range.to;

  // Only the latest request may land (a quick ◀ ▶ must not show an older day).
  const seq = useRef(0);
  function load() {
    const mine = ++seq.current;
    setError('');
    api.get('/attendance/dashboard', { params: single ? { date } : range })
      .then((res) => { if (mine === seq.current) setData(res.data); })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'Could not load the dashboard.'); });
  }
  useEffect(() => { if (isHR) load(); }, [range.from, range.to, isHR]); // eslint-disable-line react-hooks/exhaustive-deps

  async function mark(employeeId, status) {
    await api.post('/attendance', { employeeId, date, status });
    load();
  }
  const pickRange = (from, to) => { setRange({ from, to }); setKpi(''); };

  // Mark Attendance filters — all of them work together, with the KPI card.
  // Worked out before the early returns so the pager hook below always runs.
  const markingAll = (data && data.marking) || [];
  const markDepts = [...new Set(markingAll.map((r) => r.department).filter(Boolean))].sort();
  const marking = markingAll.filter((r) => {
    if (mf.q && !`${r.employeeCode || ''} ${r.name || ''}`.toLowerCase().includes(mf.q.trim().toLowerCase())) return false;
    if (mf.department && r.department !== mf.department) return false;
    if (mf.empStatus && r.hrStatus !== mf.empStatus) return false;
    if (mf.status && markStatusOf(r.status) !== mf.status) return false;
    if (!matchesKpi(r, kpi)) return false;
    return true;
  });
  const markPage = usePaged(marking, 100);

  if (!isHR) return <MyAttendance />;
  if (error && !data) return <div className="notice red">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  // The response in hand may still be the previous choice for a moment.
  const isRange = !!data.range;
  const k = data.kpis;

  return (
    <div className="att-day">
      {/* PEOPLE, NOT RECORDS. One day: the people on the rolls that day, each
          in exactly one bucket. A range: people with at least one such day
          and per-day averages, plus the date-wise totals. The same
          computation as the Biometric list and the Punch Log
          (routes/attendance.js dayReport()). */}
      <Panel>
        <PanelHead title="Attendance">
          {/* Data I/O for the chosen period: Export all (a summary row per
              person) · Export one employee (every day) — GET
              /api/insights/attendance/export. Attendance is imported with the
              existing Import History (old-HRMS CSV files and their samples),
              so the shared bar's own Import stays off and points there. */}
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <DataIoBar ioKey="attendance" exportUrl="/insights/attendance/export" params={{ from: range.from, to: range.to }} showImport={false} />
            {canImportHistory && <button type="button" className="btn btn-sm" onClick={() => goTab('history')} title="Import past attendance from the old HRMS's CSV exports — sample files are on that tab">Import History →</button>}
            <button type="button" className="btn btn-sm" onClick={() => goTab('biometric')}>Open date-wise list →</button>
          </span>
        </PanelHead>
        {/* THE ATTENDANCE REPORT (user, 2026-10-05): Day / Week / Month,
            Department -> Employee, the cards and their lists, Export to Excel
            (./attendance/KpiReport.jsx). Its period also drives the daily
            marking and the regularization list below. */}
        <KpiReport onRangeChange={(f, t) => { if (f !== range.from || t !== range.to) pickRange(f, t); }} />
      </Panel>

      <TwoCol>
        {!isRange ? (
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>① Check-in / Check-out by method</h3>
            <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>People on {data.date}, by the method of their first check-in / last check-out</div>
            {data.byMethod.map((m) => (
              <AssignRow flush key={m.method}>
                <span>{m.method}</span>
                <span className="cell-muted" style={{ fontSize: 12 }}>In: {m.in} · Out: {m.out}</span>
              </AssignRow>
            ))}
          </PanelPad>
        ) : (
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>① Check-in / Check-out by method</h3>
            <EmptyMini>Pick a single day to see the check-ins by method.</EmptyMini>
          </PanelPad>
        )}
        <div>
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>② Regularization Requests</h3>
            {data.regularizations.length === 0
              ? <EmptyMini>No regularization requests.</EmptyMini>
              : data.regularizations.map((r) => (
                <AssignRow flush key={r.id}>
                  <span>
                    <b>{r.employee?.name}</b><br />
                    <span className="cell-muted" style={{ fontSize: 11.5 }}>{r.date}: {r.reason || '—'}</span>
                  </span>
                  <span><Status>{r.status}</Status></span>
                </AssignRow>
              ))}
          </PanelPad>
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>③ Quick Actions</h3>
            <QaRow>
              {!isRange && <button className="btn btn-sm" onClick={() => setShowMarking((s) => !s)}>{showMarking ? '− Hide daily marking' : '+ Show daily marking'}</button>}
              <button className="btn btn-sm" onClick={() => goTab('regularization')}>+ Request Regularization</button>
              <button className="btn btn-sm" onClick={() => goTab('methods')}>+ Configure Policies</button>
            </QaRow>
          </PanelPad>
        </div>
      </TwoCol>

      {!isRange && showMarking && (
        <Panel style={{ marginTop: 16 }}>
          <PanelHead title={`Daily marking — ${fmtDay(data.date)}${kpi ? ` · ${KPI_NAME[kpi] || kpi}` : ''}`} />
          <PeopleFilterBar
            filters={mf} setFilters={setMf} people={false} employeeStatus search="employee name or ID"
            departments={markDepts.length > 1 ? markDepts : undefined} statuses={MARK_STATUSES}
            shown={marking.length} total={markingAll.length} style={{ margin: '12px 18px' }}
          >
            {kpi && <button className="btn btn-sm" onClick={() => setKpi('')} title="Show everyone again">✕ {KPI_NAME[kpi] || kpi}</button>}
          </PeopleFilterBar>
          <ScrollTable>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Department</th><th title="From punches, marks, leave, holidays">Day status</th><th title="What HR marked (the Mark buttons change this)">Marked</th><th>In</th><th>Out</th><th>Location</th><th style={{ textAlign: 'right' }}>Mark</th></tr></thead>
              <tbody>
                {markPage.slice.map((r) => (
                  <tr key={r.employeeId}>
                    <td><b>{r.employeeCode}</b></td>
                    <td>{r.name}</td>
                    <td className="cell-muted">{r.department || '—'}</td>
                    <td>{r.dayStatus ? <DayStatus status={r.bucket === 'noRecord' ? 'No device data' : r.dayStatus} /> : '—'}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="cell-muted">{r.checkIn ? to12h(r.checkIn) : '—'}</td>
                    <td className="cell-muted">{r.checkOut ? to12h(r.checkOut) : '—'}</td>
                    <td className="cell-muted">{r.location || '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canMark ? ['Present', 'Absent', 'Half Day'].map((s) => (
                        <button key={s} className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => mark(r.employeeId, s)}>{s}</button>
                      )) : <span className="cell-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {marking.length === 0 && <tr><td colSpan="9"><ListEmpty lf={{ activeCount: Object.values(mf).some(Boolean) || kpi ? 1 : 0, clear: () => { setMf(EMPTY_MARK); setKpi(''); } }} noun="employees" title="No employees on the rolls on this date." /></td></tr>}
              </tbody>
            </table>
          </ScrollTable>
          {markPage.total > 0 && <div style={{ padding: '0 18px' }}><Pager page={markPage} noun="employees" /></div>}
        </Panel>
      )}

      {/* Trends over a range — person-days, clearly labelled, and apart from
          the KPIs above. */}
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Trends over a period (person-days)" />
        <div style={{ padding: '10px 18px 16px' }}>
          <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            These charts add up every day of the chosen period, so a person present on 20 days counts 20 — they are person-days, not people.
            The KPIs above are people.
          </div>
          <InsightsPanel module="attendance" storageKey={TREND_RANGE_KEY} tiles={false} />
        </div>
      </Panel>
    </div>
  );
}

// Anyone's own attendance — check in / out with a live face + location, and
// their own days — is ./attendance/MyAttendance.jsx (HRMS-24 §5, §10).

// ---- Tab 2: Biometric Attendance List — the old "First Check-In & Last
// Check-Out Report" -----------------------------------------------------------
// One line per person per day, exactly the old report's columns: Employee No ·
// Employee Ref No · Employee Name · Department · Designation · Date · First
// Check In · Last Check Out · Work Location · Total Time Worked · Total Time In
// Break · Total Hours. Imported days show the CSV's values as exported; device
// days are worked out from the stored punches (server: reportDay()). Name,
// department and designation come from Employee Management. Like the old
// report, only days with a check-in are listed unless "Show people without a
// check-in" is ticked or a KPI card / status is picked. The KPI cards and the
// date-wise totals stay (people, never person-days).

// The dropdown options a filter bar has seen so far on this tab: the union of
// every response's facets, so picking "Biometric" never shrinks the Method
// list to that one value (and a department filter never hides the others).
function useSeen(data, pick) {
  const [seen, setSeen] = useState({});
  useEffect(() => {
    if (!data) return;
    const p = pick(data) || {};
    setSeen((cur) => {
      const next = { ...cur };
      Object.entries(p).forEach(([k, list]) => {
        next[k] = [...new Set([...(cur[k] || []), ...(list || []).filter((v) => v && v !== '—')])].sort();
      });
      return next;
    });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  return seen;
}

// Search · Department · Status | More: Role · Employee status · Method · Source.
// All of them are sent to the server (GET /attendance/biometric), so the
// KPI-free totals, the rows and the CSV / Excel export follow the same filters.
// Department only when the login's scope holds more than one.
const bioFields = (seen, roles) => [
  { key: 'q', type: 'search', placeholder: 'Search employee name or ID…' },
  { key: 'department', label: 'Department', primary: true, options: seen.departments || [], show: (seen.departments || []).length > 1 },
  { key: 'status', label: 'Status', allLabel: 'All day statuses', primary: true, options: seen.statuses || [] },
  { key: 'role', label: 'Role', options: roles },
  { key: 'hrStatus', label: 'Employee status', options: HR_STATUSES },
  { key: 'method', label: 'Method', options: seen.methods || [] },
  { key: 'source', label: 'Source', options: seen.sources || [] },
];

const REPORT_COLS = [
  ['employeeNo', 'Employee No'], ['employeeRef', 'Employee Ref No'], ['name', 'Employee Name'], ['department', 'Department'],
  ['designation', 'Designation'], ['dateLabel', 'Date'], ['dayStatusCol', 'Day status'], ['firstCheckIn', 'First Check In'], ['lastCheckOut', 'Last Check Out'],
  ['workLocation', 'Work Location'], ['totalTimeWorked', 'Total Time Worked'], ['totalBreak', 'Total Time In Break'], ['totalHours', 'Total Hours'],
];

function BiometricTab() {
  const [range, setRange] = useState({ from: today(), to: today() });
  const [kpi, setKpi] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const roles = useRoles(true);
  const seen = useSeen(data, (d) => ({ departments: (d.rows || []).map((r) => r.department), ...(d.facets || {}) }));
  const lf = useListFilters([], bioFields(seen, roles), { server: true });

  const single = range.from === range.to;
  // A KPI card lists people who may have no check-in (Absent, On Leave…), so
  // it asks for everyone too.
  const params = { ...(single ? { date: range.from } : range), ...lf.params, ...(everyone || kpi ? { all: '1' } : {}) };
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    setError('');
    api.get('/attendance/biometric', { params })
      .then((res) => { if (alive) setData(res.data); })
      .catch((e) => { if (alive) { setData(null); setError(e.response?.data?.error || 'Could not load the biometric list.'); } });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRange = !!data?.range;
  // In range mode the "≥ 1 day" cards pick PEOPLE; their day rows are listed.
  const rangePeople = isRange && kpi ? new Set((data.summary?.rows || []).filter((p) => matchesKpi(p, kpi)).map((p) => p.employeeId)) : null;
  const rows = (data?.rows || []).filter((r) => (rangePeople ? rangePeople.has(r.employeeId) : matchesKpi(r, kpi)));
  const page = usePaged(rows, 100);
  const clearAll = () => { lf.clear(); setKpi(''); };

  async function exportAs(format) {
    setBusy(true);
    try {
      const name = single ? range.from : `${range.from}_to_${range.to}`;
      await downloadFrom('/attendance/biometric', { ...params, ...(kpi && !isRange ? { dayStatus: kpi } : {}), format }, `first-check-in-last-check-out-${name}.${format}`);
    } catch { setError('Could not export the list.'); } finally { setBusy(false); }
  }

  return (
    <Panel className="att-day">
      <PanelHead title={`First Check-In & Last Check-Out Report — ${single ? fmtDay(range.from) : `${fmtDay(range.from)} → ${fmtDay(range.to)}`}`}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => exportAs('csv')} disabled={!data || busy} title="The rows matching these filters, with the same 12 columns">Export CSV</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => exportAs('xlsx')} disabled={!data || busy} title="The rows matching these filters, with the same 12 columns">Export Excel</button>
        </div>
      </PanelHead>
      <div style={{ padding: '12px 18px 0' }}>
        <RangeBar from={range.from} to={range.to} onChange={(f, t) => { setRange({ from: f, to: t }); setKpi(''); }} latest={data?.latestDataDate} today={data?.today} />
        <ListFilterBar lf={lf} storageKey="att-bio">
          <label className="small-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, margin: 0 }} title="Also list the people on the rolls with no check-in that day (absent, on leave, no record, week-off)">
            <input type="checkbox" style={{ width: 15, height: 15, minHeight: 0, minWidth: 0 }} checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            Show people without a check-in
          </label>
          {kpi && <button type="button" className="btn btn-sm" onClick={() => setKpi('')} title="Show everyone again">✕ {KPI_NAME[kpi] || kpi}</button>}
        </ListFilterBar>
        {error && <div className="notice red">{error}</div>}
        <NoDataNotice data={data} to={range.to} />
        {data && !isRange && <DayKpis kpis={data.totals} date={data.date} headcount={data.headcount} active={kpi} onPick={setKpi} />}
        {data && isRange && (
          <>
            <RangeKpis summary={data.summary} from={data.from} to={data.to} active={kpi} onPick={setKpi} />
            <div className="att-kpi-sep">Date-wise totals — click a date to open that day</div>
            <DateTotalsTable days={data.days} onPickDay={(d) => { setRange({ from: d, to: d }); setKpi(''); }} />
          </>
        )}
        <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
          Imported days show the old HRMS report&apos;s values as exported. Device days: First Check In = the first check-in, Last Check Out = the last
          check-out the employee pressed, Total Hours = last out − first in, Total Time In Break = the gaps from a check-out to the next check-in,
          Total Time Worked = Total Hours − breaks. Hover a row for the day&apos;s status.
          {data && !data.everyone && data.withoutCheckIn > 0 && (
            <> {' '}<b>{data.withoutCheckIn}</b> person-day(s) on the rolls without a check-in are not listed —{' '}
              <button type="button" className="link-btn" onClick={() => setEveryone(true)}>show them</button>.
            </>
          )}
        </div>
      </div>
      <ScrollTable>
        <table>
          <thead>
            <tr>{REPORT_COLS.map(([k, label]) => <th key={k} style={{ whiteSpace: 'nowrap' }}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {page.slice.map((r) => (
              <tr key={`${r.employeeId}-${r.date}`} title={`${r.dateLabel}: ${r.bucket === 'noRecord' ? 'No device data' : r.status}${r.note ? ` — ${r.note}` : ''}${r.source && r.source !== '—' ? ` · ${r.source}` : ''}`}>
                <td><b>{r.employeeNo}</b></td>
                <td>{r.employeeRef}</td>
                <td>{r.name}</td>
                <td className="cell-muted">{r.department || ''}</td>
                <td className="cell-muted">{r.designation || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.dateLabel}</td>
                <td>{r.status ? <DayStatus status={r.bucket === 'noRecord' ? 'No device data' : r.status} earlyLogout={r.earlyLogout} /> : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.firstCheckIn || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.lastCheckOut || ''}</td>
                <td className="cell-muted">{r.workLocation || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.totalTimeWorked || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.totalBreak || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.totalHours || ''}</td>
              </tr>
            ))}
            {data && rows.length === 0 && (
              <tr><td colSpan="13">
                <ListEmpty lf={{ activeCount: lf.activeCount || kpi ? 1 : 0, clear: clearAll }} noun="rows" title="No check-ins in this period." />
              </td></tr>
            )}
            {!data && !error && <tr><td colSpan="13" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
          </tbody>
        </table>
      </ScrollTable>
      <div style={{ padding: '4px 18px 10px' }}>
        {rows.length > 0 && <Pager page={page} noun="rows" />}
        <div className="small-muted" style={{ fontSize: 12 }}>
          {data && rows.length !== data.rows.length ? `${data.rows.length} row(s) before the card filter` : ''}{kpi ? ` · ${KPI_NAME[kpi] || kpi}` : ''}
          {data && rows.length > page.size ? ' · the export has every matching row' : ''}
        </div>
      </div>
    </Panel>
  );
}

// ---- Tab 3: Punch Log — the old "Bio-Metric Logs" screen --------------------
// Employee · Department · Designation · Attendance Date · Time Interval: every
// punch time of the day joined with "|" (device punches and the imported
// bio-metric log merged by time, each once — server: timeIntervalOf()).
// Employee by employee, dates ascending; the Employee / Department /
// Designation cells are shown on an employee's first row (and again at the top
// of a page) and left blank on the following dates. No KPI cards here.

const PUNCH_STATUS_CHOICES = [
  { value: 'Checked In', label: 'Still checked in (no check-out)' },
  { value: 'Checked Out', label: 'Checked out' },
];

// Search · Department · Punch status · Day status | More: Role · Method · Source.
// All sent to GET /attendance/punch-log, so the rows and the exports follow them.
const punchFields = (seen, roles) => [
  { key: 'q', type: 'search', placeholder: 'Search employee name or ID…' },
  { key: 'department', label: 'Department', primary: true, options: seen.departments || [], show: (seen.departments || []).length > 1 },
  { key: 'punchStatus', label: 'Punch status', allLabel: 'Checked In & Checked Out', primary: true, options: PUNCH_STATUS_CHOICES },
  { key: 'dayStatus', label: 'Day status', allLabel: 'All day statuses', primary: true, options: seen.dayStatuses || [] },
  { key: 'role', label: 'Role', options: roles },
  { key: 'method', label: 'Method', options: seen.methods || [] },
  { key: 'source', label: 'Source', options: seen.sources || [] },
];

function PunchLogTab() {
  const [range, setRange] = useState({ from: today(), to: today() });
  const [absentees, setAbsentees] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const roles = useRoles(true);
  const seen = useSeen(data, (d) => ({ departments: (d.rows || []).map((r) => r.department), ...(d.facets || {}) }));
  const lf = useListFilters([], punchFields(seen, roles), { server: true });
  const punchStatus = lf.params.punchStatus || '';

  const query = { ...range, ...lf.params, ...(absentees ? { absentees: '1' } : {}) };
  useEffect(() => {
    let alive = true;
    setError('');
    api.get(`/attendance/punch-log?${filterQuery(query)}`)
      .then((res) => { if (alive) setData(res.data); })
      .catch((e) => { if (alive) { setData(null); setError(e.response?.data?.error || 'Could not load punch log.'); } });
    return () => { alive = false; };
  }, [JSON.stringify(query)]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const page = usePaged(rows, 100);
  const oneDay = range.from === range.to;

  async function exportAs(format) {
    setBusy(true);
    try {
      await downloadFrom('/attendance/punch-log', { ...query, format }, `bio-metric-logs-${range.from}_to_${range.to}.${format}`);
    } catch { setError('Could not export the punch log.'); } finally { setBusy(false); }
  }

  return (
    <Panel className="att-day">
      <PanelHead title={`Bio-Metric Logs — ${oneDay ? fmtDay(range.from) : `${fmtDay(range.from)} → ${fmtDay(range.to)}`}`}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => exportAs('csv')} disabled={!data || busy} title="The rows matching these filters, with the same 5 columns">Export CSV</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => exportAs('xlsx')} disabled={!data || busy} title="The rows matching these filters, with the same 5 columns">Export Excel</button>
        </div>
      </PanelHead>
      <div style={{ padding: '12px 18px 0' }}>
        <RangeBar from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} latest={data?.latestDataDate} today={data?.today} />
        <ListFilterBar lf={lf} storageKey="att-punch">
          <label className="small-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, margin: 0 }} title="Also list the people on the rolls with no punch that day (their Time Interval is empty)">
            <input type="checkbox" style={{ width: 15, height: 15, minHeight: 0, minWidth: 0 }} checked={absentees && !punchStatus} disabled={!!punchStatus} onChange={(e) => setAbsentees(e.target.checked)} />
            Show people without punches
          </label>
        </ListFilterBar>
        <NoDataNotice data={data} to={range.to} />
        <div className="small-muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
          Time Interval = every punch of the day, earliest first — the biometric device and the imported old-HRMS log merged, each time once.
        </div>
      </div>
      {error && <div className="notice red" style={{ margin: '0 18px 10px' }}>{error}</div>}
      <ScrollTable>
        <table>
          <thead>
            <tr><th>Employee</th><th>Department</th><th>Designation</th><th>Attendance Date</th><th>Time Interval</th></tr>
          </thead>
          <tbody>
            {page.slice.map((r, i) => {
              // The employee's cells on their first row (and at the top of a page).
              const first = i === 0 || page.slice[i - 1].employeeId !== r.employeeId;
              return (
                <tr key={`${r.employeeId}-${r.date}`} className={first && i > 0 ? 'att-emp-first' : undefined}
                  title={r.dayStatus ? `${r.dateLabel}: ${r.dayStatus}` : undefined}>
                  <td style={{ whiteSpace: 'nowrap' }}>{first ? <b>{r.employeeLabel}</b> : ''}</td>
                  <td className="cell-muted">{first ? (r.department || '') : ''}</td>
                  <td className="cell-muted">{first ? (r.designation || '') : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.dateLabel}</td>
                  <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 }}>
                    {r.timeInterval || <span className="cell-muted">{r.dayStatus || 'No punch'}</span>}
                  </td>
                </tr>
              );
            })}
            {data && rows.length === 0 && (
              lf.activeCount > 0
                ? <tr><td colSpan="5"><ListEmpty lf={lf} noun="punch rows" /></td></tr>
                : <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>No punches in this period.</td></tr>
            )}
            {!data && !error && <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
          </tbody>
        </table>
      </ScrollTable>
      <div style={{ padding: '4px 18px 10px' }}>
        {rows.length > 0 && <Pager page={page} noun="rows" />}
        <div className="small-muted" style={{ fontSize: 12 }}>
          {data ? `${rows.length} row(s) · ${new Set(rows.map((r) => r.employeeId)).size} employee(s)${absentees && !punchStatus ? ' — people without punches included' : ''}` : ''}
          {data && rows.length > page.size ? ' · the export has every matching row' : ''}
        </div>
      </div>
    </Panel>
  );
}

// "Reports (Monthly)" now lives inside the Monthly Summary tab
// (./attendance/TeamAttendance.jsx MonthlySummaryTab) — attendance %, the
// payroll half-day cuts and the employee-status filter came with it.

// ---- Check-in method assignment — Super Admin only ---------------------------
// One row per employee, a tick per method. Changes are held on screen until
// Save, and only the rows that changed are sent. "Tick all shown" works on
// whatever the filters leave on screen, so a whole department is two clicks.
function MethodAssignment() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [f, setF] = useState({ q: '', department: '', method: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.get('/attendance/checkin-methods')
      .then((res) => { setData(res.data); setDraft({}); })
      .catch((e) => setErr(e.response?.data?.error || 'Could not load the assignments.'));
  }
  useEffect(load, []);

  if (err && !data) return <div className="notice red">{err}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;

  const current = (e) => draft[e.id] || e.methods;
  const depts = [...new Set(data.employees.map((e) => e.department).filter(Boolean))].sort();
  const shown = data.employees.filter((e) => {
    const q = f.q.trim().toLowerCase();
    if (q && !`${e.employeeCode} ${e.name}`.toLowerCase().includes(q)) return false;
    if (f.department && e.department !== f.department) return false;
    if (f.method === 'none' && current(e).length) return false;
    if (f.method && f.method !== 'none' && !current(e).includes(f.method)) return false;
    return true;
  });
  const toggle = (e, key) => {
    const now = current(e);
    setDraft((d) => ({ ...d, [e.id]: now.includes(key) ? now.filter((k) => k !== key) : [...now, key] }));
  };
  const setAllShown = (key, on) => {
    setDraft((d) => {
      const next = { ...d };
      shown.forEach((e) => {
        const now = next[e.id] || e.methods;
        next[e.id] = on ? [...new Set([...now, key])] : now.filter((k) => k !== key);
      });
      return next;
    });
  };
  const changed = data.employees.filter((e) => draft[e.id]
    && [...draft[e.id]].sort().join(',') !== [...e.methods].sort().join(','));

  async function save() {
    setMsg(''); setErr(''); setSaving(true);
    try {
      const res = await api.put('/attendance/checkin-methods', {
        assignments: changed.map((e) => ({ employeeId: e.id, methods: draft[e.id] })),
      });
      setMsg(`${res.data.changed} employee(s) updated.`);
      load();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save.');
    } finally { setSaving(false); }
  }

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Assign check-in methods — Super Admin">
        <button className="btn btn-sm btn-primary" disabled={!changed.length || saving} onClick={save}>
          {saving ? 'Saving…' : changed.length ? `Save ${changed.length} change(s)` : 'Save'}
        </button>
      </PanelHead>
      <div style={{ padding: '12px 18px 0' }}>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          An employee can check in only by the methods ticked here. With nothing ticked they cannot check in at all.
        </div>
        <div className="filter-row">
          <input placeholder="Employee ID or name" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <Combo value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
            <option value="">All departments</option>
            {depts.map((d) => <option key={d}>{d}</option>)}
          </Combo>
          <Combo value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="">Any method</option>
            {data.methods.map((m) => <option key={m.key} value={m.key}>Has {m.label}</option>)}
            <option value="none">No method assigned</option>
          </Combo>
          <span className="small-muted" style={{ alignSelf: 'center' }}>{shown.length} employee(s)</span>
        </div>
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="notice red">{err}</div>}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Employee</th><th>Department</th>
              {data.methods.map((m) => (
                <th key={m.key} style={{ textAlign: 'center' }}>
                  {m.label}
                  <div style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginTop: 3 }}>
                    <button type="button" className="link-btn" onClick={() => setAllShown(m.key, true)}>all</button>
                    {' · '}
                    <button type="button" className="link-btn" onClick={() => setAllShown(m.key, false)}>none</button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const now = current(e);
              return (
                <tr key={e.id}>
                  <td><b>{e.employeeCode}</b></td>
                  <td>{e.name}<div className="small-muted">{e.designation || ''}</div></td>
                  <td className="cell-muted">{e.department || '—'}</td>
                  {data.methods.map((m) => (
                    <td key={m.key} style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        style={{ width: 16, height: 16, minHeight: 0 }}
                        aria-label={`${m.label} for ${e.name}`}
                        checked={now.includes(m.key)}
                        onChange={() => toggle(e, m.key)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={3 + data.methods.length}><ListEmpty lf={{ activeCount: f.q || f.department || f.method ? 1 : 0, clear: () => setF({ q: '', department: '', method: '' }) }} noun="employees" /></td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---- Tab 5: Check-in Methods (usage + attendance policy) --------------------

function MethodsTab({ canEdit, canAssign, canAlerts }) {
  const [methods, setMethods] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState('');

  function load() {
    api.get('/attendance/methods').then((res) => setMethods(res.data));
    api.get('/attendance/policy').then((res) => setPolicy(res.data));
  }
  useEffect(load, []);

  const [saved, setSaved] = useState('');
  async function save(patch) {
    setError(''); setSaved('');
    const next = { ...policy, ...patch };
    setPolicy(next);
    try {
      const res = await api.put('/attendance/policy', next);
      setPolicy(res.data);
      setSaved('Saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the policy');
    }
  }

  return (
    <>
    <TwoCol style={{ gridTemplateColumns: '1fr 1fr' }}>
      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Check-in Methods</h3>
        <div className="small-muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Each employee may use only the methods Super Admin assigns them. Usage counts are from the punch log.
        </div>
        {methods.map((m) => (
          <AssignRow flush key={m.method}>
            <span>{m.method}</span>
            <span className="cell-muted" style={{ fontSize: 12 }}>{m.punches} punch(es) recorded</span>
          </AssignRow>
        ))}
        <div className="small-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Web and mobile check-in (GPS / Location or Face Recognition) needs a live camera capture, matched on the server to the
          employee&apos;s registered photo with a head-turn or blink liveness step, plus the location. Biometric punches come from the fingerprint device.
        </div>
      </PanelPad>

      {policy && (
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Attendance Policies</h3>
          <div className="field">
            <label>Grace time (late after)</label>
            <input type="text" disabled={!canEdit} defaultValue={policy.graceTime} onBlur={(e) => save({ graceTime: e.target.value })} />
          </div>
          <div className="field">
            <label>Free late arrivals per month</label>
            <input type="number" disabled={!canEdit} defaultValue={policy.freeLateArrivalsPerMonth} onBlur={(e) => save({ freeLateArrivalsPerMonth: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Minimum hours for a half day</label>
            <input type="number" disabled={!canEdit} defaultValue={policy.halfDayHours} onBlur={(e) => save({ halfDayHours: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Minimum hours for a full day</label>
            <input type="number" disabled={!canEdit} defaultValue={policy.fullDayHours} onBlur={(e) => save({ fullDayHours: Number(e.target.value) })} />
          </div>
          {/* HRMS items 2 / 3: the working day and its two halves. */}
          <div className="grid-2">
            <div className="field">
              <label>Working day starts</label>
              <input type="time" disabled={!canEdit} defaultValue={policy.workStartTime} onBlur={(e) => save({ workStartTime: e.target.value })} />
            </div>
            <div className="field">
              <label>Working day ends</label>
              <input type="time" disabled={!canEdit} defaultValue={policy.workEndTime} onBlur={(e) => save({ workEndTime: e.target.value })} />
            </div>
            <div className="field">
              <label>First half ends / second half starts</label>
              <input type="time" disabled={!canEdit} defaultValue={policy.halfDaySplit} onBlur={(e) => save({ halfDaySplit: e.target.value })} />
            </div>
            <div className="field">
              <label>Early logout from (leaving before this = Half day)</label>
              <input type="time" disabled={!canEdit} defaultValue={policy.earlyLogoutFrom || '17:00'} onBlur={(e) => save({ earlyLogoutFrom: e.target.value })} />
            </div>
            <div className="field">
              <label>Early logout: minutes allowed before the end</label>
              <input type="number" min="0" max="240" disabled={!canEdit} defaultValue={policy.earlyLogoutGraceMinutes} onBlur={(e) => save({ earlyLogoutGraceMinutes: Number(e.target.value) })} />
            </div>
          </div>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5, marginBottom: 8 }}>
            <input type="checkbox" style={{ width: 16, height: 16, minHeight: 0 }} disabled={!canEdit} checked={!!policy.halfDayBySession} onChange={(e) => save({ halfDayBySession: e.target.checked })} />
            A half day needs one full half (not just the half-day hours)
          </label>
          {saved && <div className="small-muted">{saved}</div>}
          {error && <div className="error-text">{error}</div>}
          <div className="small-muted" style={{ fontSize: 11.5 }}>
            Late days beyond the free allowance become half-day cuts in the monthly report.
            {' '}First half {policy.workStartTime}–{policy.halfDaySplit}, second half {policy.halfDaySplit}–{policy.workEndTime}.
            {' '}Leaving between {policy.earlyLogoutFrom || '17:00'} and {policy.workEndTime} is an <b>Early Logout</b> ({policy.earlyLogoutFrom || '17:00'} sharp counts as early logout).
            {' '}Leaving before {policy.earlyLogoutFrom || '17:00'}, or coming at / after {policy.halfDaySplit}, is a <b>Half Day</b>.
            {' '}No check-in and no leave or request is <b>Absent</b>.
            {!policy.attendanceRulesFrom && <> The minimum hours above are the old rule — payroll still uses them until the new rule is switched on for pay.</>}
          </div>
        </PanelPad>
      )}
    </TwoCol>
    <CheckinSettings canEditPolicy={canEdit} isSuperAdmin={canAssign} />
    {canAssign && <MethodAssignment />}
    {/* Late / missing-punch alerts — HR settings (configure permission). */}
    {canAlerts && <AlertSettings />}
    {/* HRMS item 14: which events send an in-app note and an email. */}
    {canAlerts && <NotifySettings />}
    </>
  );
}

// ---- Regularization (kept from main — correcting a missed punch after the fact) ----
// The prototype calls regularizationModalHtml(), which it never defines, so its
// own "+ Request Regularization" button is dead; this is the working version.

const REG_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
const EMPTY_REG = { code: '', name: '', department: '', empStatus: '', date: '', status: '' };

function RegularizationTab({ isHR, canDecide }) {
  const { user } = useAuth();
  const [requests, setRequests] = useState([]);
  const [form, setForm] = useState({ date: today(), requestedCheckIn: '', requestedCheckOut: '', reason: '' });
  const [rf, setRf] = useState(EMPTY_REG);
  const [error, setError] = useState('');
  const [chainFor, setChainFor] = useState(null);

  function load() {
    api.get('/attendance/regularizations').then((res) => setRequests(res.data));
  }
  useEffect(load, []);

  async function cancel(id) {
    setError('');
    try { await api.patch(`/attendance/regularizations/${id}/cancel`); load(); } catch (e) {
      setError(e.response?.data?.error || 'Could not cancel the request.');
    }
  }

  // The five filters work together over every request on screen.
  const setR = (k, v) => setRf((f) => ({ ...f, [k]: v }));
  const regDepts = [...new Set(requests.map((r) => r.employee?.department).filter(Boolean))].sort();
  const shown = requests.filter((r) => {
    const e = r.employee || {};
    if (rf.code && !String(e.employeeCode || '').toLowerCase().includes(rf.code.trim().toLowerCase())) return false;
    if (rf.name && !String(e.name || '').toLowerCase().includes(rf.name.trim().toLowerCase())) return false;
    if (rf.department && e.department !== rf.department) return false;
    if (rf.empStatus && hrStatusOf(e.employmentStatus) !== rf.empStatus) return false;
    if (rf.date && r.date !== rf.date) return false;
    if (rf.status && r.status !== rf.status) return false;
    return true;
  });
  const regPage = usePaged(shown);

  async function submit(e) {
    e.preventDefault();
    await api.post('/attendance/regularizations', form);
    setForm({ ...form, reason: '' });
    load();
  }

  // Quick approve for the login whose turn it is. Rejecting (remarks
  // required) and the Super Admin's direct decision live in the chain view.
  async function decide(id, status) {
    setError('');
    try {
      await api.patch(`/attendance/regularizations/${id}/decision`, { status });
    } catch (e) {
      setError(e.response?.data?.error || 'Could not record the decision.');
    }
    load();
  }

  return (
    <div>
      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Request Regularization</h3>
        <form onSubmit={submit}>
          <div className="grid-2">
            <div className="field"><label>Date *</label><input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
            <div className="field"><label>Requested Check-in</label><input value={form.requestedCheckIn} onChange={(e) => setForm({ ...form, requestedCheckIn: e.target.value })} placeholder="09:15" /></div>
            <div className="field"><label>Requested Check-out</label><input value={form.requestedCheckOut} onChange={(e) => setForm({ ...form, requestedCheckOut: e.target.value })} placeholder="18:15" /></div>
            <div className="field"><label>Reason</label><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Submit request</button>
        </form>
      </PanelPad>

      <Panel>
        <PanelHead title="Regularization requests" />
        <PeopleFilterBar
          filters={rf} setFilters={setRf} people={isHR} employeeStatus={isHR}
          departments={isHR ? regDepts : undefined} statuses={REG_STATUSES}
          labels={{ date: 'Date' }} shown={shown.length} total={requests.length}
          style={{ margin: '12px 18px' }}
        >
          <input type="date" aria-label="Date" title="Date" value={rf.date} onChange={(e) => setR('date', e.target.value)} />
          {/* hrms-24 §3 — the requests matching these filters, from the
              server's own scoped query (own requests only without export). */}
          <span style={{ marginLeft: 'auto' }}>
            <ExportMenu url="/insights/regularization/export" params={rf} note="The requests matching these filters" />
          </span>
        </PeopleFilterBar>
        {error && <div className="notice red" style={{ margin: '0 18px 10px' }}>{error}</div>}
        <div className="tbl-wrap">
          <table>
            <thead><tr>{isHR && <th>Code</th>}{isHR && <th>Employee</th>}{isHR && <th>Department</th>}<th>Date</th><th>Requested In</th><th>Requested Out</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {regPage.slice.map((r) => {
                const mineRow = r.employee?.userId && r.employee.userId === user?.id;
                return (
                  <tr key={r.id}>
                    {isHR && <td><b>{r.employee?.employeeCode || '—'}</b></td>}
                    {isHR && <td>{r.employee?.name}</td>}
                    {isHR && <td className="cell-muted">{r.employee?.department || '—'}</td>}
                    <td>{r.date}</td>
                    <td className="cell-muted">{r.requestedCheckIn || '—'}</td>
                    <td className="cell-muted">{r.requestedCheckOut || '—'}</td>
                    <td className="cell-muted">{r.reason || '—'}</td>
                    <td><Status>{r.status}</Status>{r.workflow && <ApprovalChainLine workflow={r.workflow} compact />}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.workflow && <button className="btn btn-sm" onClick={() => setChainFor(r.id)}>Chain</button>}{' '}
                      {canDecide && r.status === 'Pending' && !mineRow && r.workflow?.currentOwnerUserId === user?.id && <button className="btn btn-sm btn-primary" onClick={() => decide(r.id, 'Approved')}>Approve</button>}
                      {mineRow && r.status === 'Pending' && <button className="btn btn-sm" onClick={() => cancel(r.id)}>Cancel request</button>}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={isHR ? 9 : 6}><ListEmpty lf={{ activeCount: Object.values(rf).some(Boolean) ? 1 : 0, clear: () => setRf(EMPTY_REG) }} noun="regularization requests" /></td></tr>}
            </tbody>
          </table>
        </div>
        {regPage.total > 0 && <Pager page={regPage} noun="requests" />}
      </Panel>
      {chainFor && (
        <ApprovalChainModal type="regularization" recordId={chainFor} onClose={() => setChainFor(null)} onChanged={load} />
      )}
    </div>
  );
}

export default function Attendance() {
  const { user } = useAuth();
  // THREE ANSWERS, NOT ONE.
  //   isHR          READ — may this login see everybody's attendance? It picks
  //                 the administration tabs over the self-service one, and a
  //                 view-only Manager (§3) keeps every one of them.
  //   canMark       WRITE — may this login mark somebody Present / Absent?
  //   canDecide     APPROVE — may it decide a regularization request?
  // The last two are the actions routes/attendance.js actually requires; a
  // Manager holds neither now, so those buttons are simply not drawn.
  const isHR = hasHrmsAdmin(user);
  const canMark = canEditAttendance(user);
  const canDecide = canDecideAttendance(user);
  const canEditPolicy = isAdmin(user);
  const canImportHistory = can(user, 'hrms', 'hrms', 'Attendance & Time', 'configure');
  const canAssignMethods = isSuperAdmin(user);
  const [tab, setTab] = useState('dashboard');

  return (
    <TabsPage
      title="Attendance & Time"
      subtitle="Day-by-day attendance of the people on the rolls, device punches, the monthly summary and the check-in methods your people may use."
      value={tab}
      onChange={setTab}
      tabs={[
        { key: 'dashboard', label: 'Dashboard', element: <DashboardTab isHR={isHR} canMark={canMark} goTab={setTab} canImportHistory={canImportHistory} /> },
        // HR, Managers, STLs and TLs have their own attendance too.
        // …but Super Admin is a system account, not an employee: no self-service tab.
        ...(isHR && !user?.systemAccount ? [{ key: 'mine', label: 'My Attendance', element: <MyAttendance /> }] : []),
        ...(isHR ? [
          { key: 'biometric', label: 'Biometric Attendance List', element: <BiometricTab /> },
          { key: 'punchlog', label: 'Punch Log (Detailed)', element: <PunchLogTab /> },
          // HRMS-24 §11 — the monthly summary, in scope. It now carries the old
          // "Reports (Monthly)" figures too; "Team Attendance" is gone — the
          // Biometric list above is the date-wise, in-scope view of every person.
          { key: 'summary', label: 'Monthly Summary', element: <MonthlySummaryTab /> },
        ] : []),
        ...(canImportHistory ? [{ key: 'history', label: 'Import History', element: <HistoryImport /> }] : []),
        { key: 'methods', label: 'Check-in Methods', element: <MethodsTab canEdit={canEditPolicy} canAssign={canAssignMethods} canAlerts={canImportHistory} /> },
        { key: 'regularization', label: 'Regularization', element: <RegularizationTab isHR={isHR} canDecide={canDecide} /> },
      ]}
    />
  );
}
