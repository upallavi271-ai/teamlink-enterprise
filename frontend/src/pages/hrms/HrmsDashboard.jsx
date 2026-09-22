import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, can } from '../../permissions';
import ProfileStatusBanner from '../../components/ProfileStatusBanner.jsx';
import Combo from '../../components/Combo.jsx';

const PERIODS = ['Today', 'This Week', 'This Month', 'This Quarter', 'This Year'];

// The HR/manager view: every tile, panel and the CSV export are computed by
// /api/hrms/dashboard against the same filtered employee set.
function HrDashboard() {
  const [filters, setFilters] = useState({ period: '', department: '', location: '', status: '', manager: '' });
  const [data, setData] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams();
    Object.keys(filters).forEach((k) => { if (filters[k] && k !== 'period') params.set(k, filters[k]); });
    api.get(`/hrms/dashboard?${params.toString()}`).then((res) => setData(res.data));
  }, [filters]);

  function exportCsv() {
    downloadCsv(
      'hrms-dashboard-export.csv',
      ['Employee ID', 'Name', 'Department', 'Designation', 'Status'],
      data.exportRows.map((r) => [r.employeeCode, r.name, r.department, r.designation, r.status])
    );
  }

  if (!data) return <div className="small-muted">Loading…</div>;
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const anyFilter = Object.values(filters).some(Boolean);
  const o = data.filterOptions;

  return (
    <div>
      <div className="filter-row" style={{ marginBottom: 16 }}>
        <Combo value={filters.period} onChange={(e) => set('period', e.target.value)}>
          <option value="">Date Range</option>
          {PERIODS.map((p) => <option key={p}>{p}</option>)}
        </Combo>
        <Combo value={filters.department} onChange={(e) => set('department', e.target.value)}>
          <option value="">Department</option>
          {o.departments.map((d) => <option key={d}>{d}</option>)}
        </Combo>
        <Combo value={filters.location} onChange={(e) => set('location', e.target.value)}>
          <option value="">Location</option>
          {o.locations.map((l) => <option key={l}>{l}</option>)}
        </Combo>
        <Combo value={filters.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Employee Status</option>
          {o.statuses.map((s) => <option key={s}>{s}</option>)}
        </Combo>
        <Combo value={filters.manager} onChange={(e) => set('manager', e.target.value)}>
          <option value="">Reporting Manager</option>
          {o.managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Combo>
        {anyFilter && <button className="btn btn-sm" onClick={() => setFilters({ period: '', department: '', location: '', status: '', manager: '' })}>Clear Filters</button>}
        <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={exportCsv}>Export</button>
      </div>

      {data.employeeOverview.total === 0 && (
        <ScopeNote>No employee records match these filters — the counts below are genuinely zero, not placeholders.</ScopeNote>
      )}

      <SectionLabel>Employee Overview</SectionLabel>
      <StatRow cells={[
        { value: data.employeeOverview.total, label: 'Total Employees', to: '/employees' },
        { value: data.employeeOverview.active, label: 'Active' },
        { value: data.employeeOverview.newJoiners30d, label: 'New Joiners (30d)' },
        { value: data.employeeOverview.onLeaveToday, label: 'On Leave Today', to: '/leave' },
        { value: data.employeeOverview.servingNotice, label: 'Serving Notice' },
        { value: data.employeeOverview.exitProcess, label: 'Exit Process' },
        { value: data.employeeOverview.relieved, label: 'Relieved' },
      ]} />

      <SectionLabel>Attendance Overview (Today)</SectionLabel>
      <StatRow cells={[
        { value: data.attendanceOverview.present, label: 'Present', to: '/attendance' },
        { value: data.attendanceOverview.absent, label: 'Absent', to: '/attendance' },
        { value: data.attendanceOverview.late, label: 'Late', to: '/attendance' },
        { value: data.attendanceOverview.halfDay, label: 'Half Day', to: '/attendance' },
        { value: data.attendanceOverview.missingPunch, label: 'Missing Punch', to: '/attendance' },
        { value: data.attendanceOverview.regularizationPending, label: 'Regularization Pending', to: '/attendance' },
      ]} />

      <SectionLabel>Leave Overview</SectionLabel>
      <StatRow cells={[
        { value: data.leaveOverview.total, label: 'Leave Requests', to: '/leave' },
        { value: data.leaveOverview.pending, label: 'Pending Approvals', to: '/leave' },
        { value: data.leaveOverview.approved, label: 'Approved', to: '/leave' },
        { value: data.leaveOverview.rejected, label: 'Rejected', to: '/leave' },
        { value: data.leaveOverview.upcoming, label: 'Upcoming Leaves', to: '/leave' },
      ]} />

      <div style={{ marginTop: 16 }}>
        <PanelPad>
          <h3 style={{ marginBottom: 12, fontSize: 14 }}>Pending Tasks &amp; Approvals</h3>
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
          <PanelHead title="Headcount by Department" />
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
        </QaRow>
      </PanelPad>
    </div>
  );
}
