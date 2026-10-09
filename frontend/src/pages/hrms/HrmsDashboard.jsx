import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, can } from '../../permissions';
import ProfileStatusBanner from '../../components/ProfileStatusBanner.jsx';
import Combo from '../../components/Combo.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import DateRangePicker, { useDateRange, rangeParams } from '../../components/DateRangePicker.jsx';
import ChartFromSpec from '../../components/charts/ChartFromSpec.jsx';
// Recruiter joinings (2026-10-05): Super Admin's month-end popup + a recruiter's own figure.
import RecruiterJoiningsPopup from '../../components/recruiterJoinings/RecruiterJoiningsPopup.jsx';
import MyJoiningsCard from '../../components/recruiterJoinings/MyJoiningsCard.jsx';
import { isSuperAdmin } from '../../permissions';

const NO_FILTERS = { department: '', location: '', status: '', manager: '' };
// "Medical (16)" — the filter rule: every option says how many people it holds.
const withCount = (label, n) => (n == null ? label : `${label} (${n})`);

// The HR/manager view: every tile, panel and the CSV export are computed by
// /api/hrms/dashboard against the same filtered employee set.
//
// The date range (it replaces a "Date Range" select that was never sent to
// the server) moves the dated tiles — attendance, on leave, new joiners and
// the leave overview — and their labels say so. Tiles marked "(now)" are the
// state of things today whatever range is picked.
function HrDashboard() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [range, setRange] = useDateRange('tl_dash_range_hrms');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(rangeParams(range));
    Object.keys(filters).forEach((k) => { if (filters[k]) params.set(k, filters[k]); });
    api.get(`/hrms/dashboard?${params.toString()}`)
      .then((res) => { setData(res.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the dashboard'));
  }, [filters, range]);

  function exportCsv() {
    downloadCsv(
      'hrms-dashboard-export.csv',
      ['Employee ID', 'Name', 'Department', 'Designation', 'Status'],
      data.exportRows.map((r) => [r.employeeCode, r.name, r.department, r.designation, r.status])
    );
  }

  if (!data) return error ? <div className="notice red">{error}</div> : <div className="small-muted">Loading…</div>;
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const anyFilter = Object.values(filters).some(Boolean) || range.range !== 'today';
  const o = data.filterOptions;
  // "New Joiners — This Month" moved with the range; "Active (now)" did not.
  const p = data.period;
  const inP = (label) => `${label} — ${p.name}`;
  const now = (label) => `${label} (now)`;

  return (
    <div>
      <div className="filter-row" style={{ marginBottom: 16 }}>
        <DateRangePicker value={range} onChange={setRange} period={data.period} />
        <Combo value={filters.department} title="Department" onChange={(e) => set('department', e.target.value)}>
          <option value="">All departments</option>
          {o.departments.map((d) => <option key={d} value={d}>{withCount(d, o.counts?.department?.[d])}</option>)}
        </Combo>
        <Combo value={filters.location} title="Location" onChange={(e) => set('location', e.target.value)}>
          <option value="">All locations</option>
          {o.locations.map((l) => <option key={l} value={l}>{withCount(l, o.counts?.location?.[l])}</option>)}
        </Combo>
        <Combo value={filters.status} title="Employee status" onChange={(e) => set('status', e.target.value)}>
          <option value="">All employee statuses</option>
          {o.statuses.map((s) => <option key={s} value={s}>{withCount(s, o.counts?.status?.[s])}</option>)}
        </Combo>
        <Combo value={filters.manager} title="Reporting manager" onChange={(e) => set('manager', e.target.value)}>
          <option value="">{o.managers.length ? 'All reporting managers' : 'No reporting managers set'}</option>
          {o.managers.map((m) => <option key={m.id} value={m.id}>{withCount(m.name, m.count)}</option>)}
        </Combo>
        {anyFilter && <button className="btn btn-sm" onClick={() => { setFilters(NO_FILTERS); setRange({ range: 'today', from: '', to: '' }); }}>Clear All</button>}
        <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={exportCsv}>Export</button>
      </div>
      {/* Every active filter as a removable chip, so nothing narrows the
          tiles silently (the date range shows on its own picker). */}
      <FilterChips
        filters={[
          { key: 'department', label: 'Department', value: filters.department, onRemove: () => set('department', '') },
          { key: 'location', label: 'Location', value: filters.location, onRemove: () => set('location', '') },
          { key: 'status', label: 'Employee status', value: filters.status, onRemove: () => set('status', '') },
          { key: 'manager', label: 'Reporting manager', value: filters.manager ? ((o.managers.find((m) => String(m.id) === String(filters.manager)) || {}).name || filters.manager) : '', onRemove: () => set('manager', '') },
        ]}
        onClearAll={Object.values(filters).some(Boolean) ? () => setFilters(NO_FILTERS) : undefined}
      />

      {error && <div className="notice red">{error}</div>}

      {data.employeeOverview.total === 0 && (
        <ScopeNote>No employee records match these filters — the counts below are genuinely zero, not placeholders.</ScopeNote>
      )}

      <SectionLabel>Employee Overview</SectionLabel>
      <StatRow cells={[
        { value: data.employeeOverview.total, label: now('Total Employees'), to: '/employees' },
        { value: data.employeeOverview.active, label: now('Active') },
        { value: data.employeeOverview.newJoiners, label: inP('New Joiners') },
        { value: data.employeeOverview.onLeave, label: inP('On Leave'), to: '/leave' },
        { value: data.employeeOverview.servingNotice, label: now('Serving Notice') },
        { value: data.employeeOverview.exitProcess, label: now('Exit Process') },
        { value: data.employeeOverview.relieved, label: now('Relieved') },
      ]} />

      {/* PEOPLE ON ONE DAY, not person-days: the range's last day (today when
          the range runs on past it), out of the people on the rolls that day.
          The buckets add up to the headcount, and match the Attendance
          page's Dashboard for the same date. */}
      <SectionLabel>{`Attendance on ${data.attendanceOverview.asOf} — people on the rolls that day${p.days > 1 ? ` (last day of ${p.name}; the charts below cover the whole range)` : ''}`}</SectionLabel>
      <StatRow cells={[
        { value: data.attendanceOverview.headcount, label: 'Headcount on the rolls', to: '/attendance' },
        { value: data.attendanceOverview.present, label: 'Present (incl. late)', to: '/attendance' },
        { value: data.attendanceOverview.halfDay, label: 'Half Day', to: '/attendance' },
        { value: data.attendanceOverview.absent, label: 'Absent', to: '/attendance' },
        { value: data.attendanceOverview.onLeave, label: 'On Leave', to: '/leave' },
        ...(data.attendanceOverview.offDay ? [{ value: data.attendanceOverview.offDay, label: 'Week-off / Holiday', to: '/attendance' }] : []),
        ...(data.attendanceOverview.noRecord ? [{ value: data.attendanceOverview.noRecord, label: 'No device data', to: '/attendance' }] : []),
        ...(data.attendanceOverview.notYet ? [{ value: data.attendanceOverview.notYet, label: 'Not checked in yet', to: '/attendance' }] : []),
        ...(data.attendanceOverview.upcoming ? [{ value: data.attendanceOverview.upcoming, label: 'Upcoming day', to: '/attendance' }] : []),
        { value: data.attendanceOverview.late, label: 'Of whom late', to: '/attendance' },
        { value: data.attendanceOverview.missingPunch, label: 'Missing punch', to: '/attendance' },
        // Regularization Pending (now) was the same figure as "Attendance
        // Regularization" under Pending Tasks & Approvals — shown there once.
      ]} />
      <div className="small-muted" style={{ fontSize: 12, margin: '-2px 0 12px' }}>
        Present + Half Day + Absent + On Leave{data.attendanceOverview.offDay ? ' + Week-off / Holiday' : ''}{data.attendanceOverview.noRecord ? ' + No device data' : ''}
        {data.attendanceOverview.notYet ? ' + Not checked in yet' : ''}{data.attendanceOverview.upcoming ? ' + Upcoming' : ''} = headcount {data.attendanceOverview.headcount}.
        {' '}Total Employees above counts every employee record, including people who have left.
      </div>

      <SectionLabel>{`Leave Overview — requests overlapping ${p.name}`}</SectionLabel>
      <StatRow cells={[
        { value: data.leaveOverview.total, label: 'Leave Requests', to: '/leave' },
        { value: data.leaveOverview.pending, label: 'Pending Approvals', to: '/leave' },
        { value: data.leaveOverview.approved, label: 'Approved', to: '/leave' },
        { value: data.leaveOverview.rejected, label: 'Rejected', to: '/leave' },
        { value: data.leaveOverview.upcoming, label: 'Upcoming Leaves (from today)', to: '/leave' },
      ]} />

      {/* hrms-24 §9 — built by the server from exactly the figures in the
          tiles above: same range, same filters, same scope. */}
      {(data.charts || []).length > 0 && (
        <>
          <SectionLabel>{`Charts — ${p.name} (attendance charts are person-days: every day of the range added up)`}</SectionLabel>
          <div className="tlc-grid2">
            {data.charts.map((c) => <ChartFromSpec key={c.id} spec={c} />)}
          </div>
        </>
      )}

      <div style={{ marginTop: 16 }}>
        <PanelPad>
          <h3 style={{ marginBottom: 12, fontSize: 14 }}>Pending Tasks &amp; Approvals (now)</h3>
          <StatRow cells={[
            { value: data.pendingTasks.leaveApprovals, label: 'Leave Approvals', to: '/leave' },
            { value: data.pendingTasks.attendanceRegularization, label: 'Attendance Regularization', to: '/attendance' },
            { value: data.pendingTasks.assetsAssigned, label: 'Assets Assigned', to: '/employee-services' },
            { value: data.pendingTasks.trainingPending, label: 'Training Pending', to: '/performance' },
            { value: data.pendingTasks.openTargets, label: 'Open Targets', to: '/performance' },
            { value: data.pendingTasks.openTickets, label: 'Open Tickets', to: '/employee-services' },
          ]} />
        </PanelPad>
      </div>

      <TwoCol>
        <Panel>
          <PanelHead title="Headcount by Department (now)" />
          {data.headcountByDepartment.length === 0
            ? <EmptyMini>No employees in scope.</EmptyMini>
            : data.headcountByDepartment.map((d) => (
              <AssignRow key={d.department}>
                <span>{d.department}</span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{d.employees} employee(s)</span>
              </AssignRow>
            ))}
        </Panel>
        <Panel>
          <PanelHead title="Birthdays & Anniversaries (next 30 days)" />
          {data.celebrations.length === 0
            ? <EmptyMini>None in the next 30 days.</EmptyMini>
            : data.celebrations.map((c) => (
              <AssignRow key={`${c.name}-${c.kind}`}>
                <span>{c.name} <span className="cell-muted" style={{ fontSize: 11.5 }}>— {c.kind}</span></span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{String(c.date).slice(0, 10)}</span>
              </AssignRow>
            ))}
        </Panel>
      </TwoCol>

      <TwoCol>
        <Panel>
          <PanelHead title="Announcements" />
          {data.announcements.length === 0
            ? <EmptyMini>No announcements posted.</EmptyMini>
            : data.announcements.map((a) => (
              <AssignRow key={a.id}>
                <span>{a.title} <span className="cell-muted" style={{ fontSize: 11.5 }}>— {a.category || 'General'}</span></span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{a.date}</span>
              </AssignRow>
            ))}
        </Panel>
        <Panel>
          <PanelHead title="Upcoming Holidays" />
          {data.upcomingHolidays.length === 0
            ? <EmptyMini>No upcoming holidays configured.</EmptyMini>
            : data.upcomingHolidays.map((h) => (
              <AssignRow key={h.id}>
                <span>{h.name}</span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{h.date}</span>
              </AssignRow>
            ))}
        </Panel>
      </TwoCol>
    </div>
  );
}

// The self-service view for employees, who can't read company-wide aggregates.
function MyDashboard() {
  const [attendance, setAttendance] = useState([]);
  const [leave, setLeave] = useState([]);
  const [balances, setBalances] = useState(null);
  const [holidays, setHolidays] = useState([]);
  const [announcements, setAnnouncements] = useState([]);

  useEffect(() => {
    api.get('/attendance').then((res) => setAttendance(res.data));
    api.get('/leave').then((res) => setLeave(res.data));
    api.get('/leave/balances').then((res) => setBalances(res.data)).catch(() => setBalances(null));
    api.get('/leave/holidays').then((res) => setHolidays(res.data));
    api.get('/announcements').then((res) => setAnnouncements(res.data));
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayRecord = attendance.find((a) => a.date === today);
  const myBalances = balances?.rows?.[0]?.balances || [];
  const upcoming = holidays.filter((h) => h.date >= today);

  return (
    <div>
      <SectionLabel>My Day</SectionLabel>
      <StatRow columns={3} cells={[
        { value: todayRecord?.status || 'Not marked', label: "Today's Attendance", to: '/attendance' },
        { value: leave.filter((l) => l.status === 'Pending').length, label: 'Leave Pending', to: '/leave' },
        { value: leave.filter((l) => l.status === 'Approved').length, label: 'Leave Approved', to: '/leave' },
      ]} />

      <TwoCol style={{ marginTop: 16 }}>
        <Panel>
          <PanelHead title="My Leave Balances" />
          {myBalances.length === 0
            ? <EmptyMini>No balances configured yet.</EmptyMini>
            : myBalances.map((b) => (
              <AssignRow key={b.code}><span>{b.type}</span><b>{b.total == null ? '—' : `${b.remaining} / ${b.total}`}</b></AssignRow>
            ))}
        </Panel>
        <Panel>
          <PanelHead title="Upcoming Holidays" />
          {upcoming.length === 0
            ? <EmptyMini>None configured.</EmptyMini>
            : upcoming.slice(0, 4).map((h) => (
              <AssignRow key={h.id}><span>{h.name}</span><span className="cell-muted" style={{ fontSize: 11.5 }}>{h.date}</span></AssignRow>
            ))}
        </Panel>
      </TwoCol>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Announcements" />
        {announcements.length === 0
          ? <EmptyMini>No announcements posted.</EmptyMini>
          : announcements.slice(0, 3).map((a) => (
            <AssignRow key={a.id}><span>{a.title}</span><span className="cell-muted" style={{ fontSize: 11.5 }}>{a.date}</span></AssignRow>
          ))}
      </Panel>
    </div>
  );
}

export default function HrmsDashboard() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  // A Quick Action is a shortcut to a screen, so it is offered only where the
  // screen itself is. Payroll is the Accounts desk's (see utils/permissions.js)
  // and is not in the HR desk's nav (§6), so "Process Payroll" must not be the
  // one link that puts it back.
  const canSeePayroll = can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'view');

  return (
    <div>
      <div className="page-head"><div><h1>HRMS Dashboard</h1><div className="page-sub">Employee &amp; Workforce Management</div></div></div>

      {/* FIRST LOGIN. A new employee used to land here with nothing telling
          them a profile was waiting to be filled in. The banner says so, and
          routes them to the form; once HR approves it says that instead. */}
      {!isHR && <ProfileStatusBanner variant="landing" />}

      {isSuperAdmin(user) && <RecruiterJoiningsPopup />}
      <MyJoiningsCard />

      {isHR ? <HrDashboard /> : <MyDashboard />}

      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Quick Actions</h3>
        <QaRow>
          <Link className="btn btn-sm" to="/attendance">Attendance</Link>
          <Link className="btn btn-sm" to="/leave">Leave Requests</Link>
          {canSeePayroll && <Link className="btn btn-sm" to="/payroll">Process Payroll</Link>}
          <Link className="btn btn-sm" to="/performance">Performance</Link>
          <Link className="btn btn-sm" to="/employee-services">Employee Services</Link>
          {isHR && <Link className="btn btn-sm" to="/employees">Employee Management</Link>}
          {!isHR && <Link className="btn btn-sm" to="/my-profile">My Profile</Link>}
          {/* Single sign-on: Recruiter and Admin only, as in the sidebar. */}
          {user?.jobPortal?.allowed && <Link className="btn btn-sm" to="/sso/job-portal">💼 Job Portal</Link>}
        </QaRow>
      </PanelPad>
    </div>
  );
}
