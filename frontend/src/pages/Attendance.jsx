import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import TabsPage from '../components/TabsPage.jsx';
import { downloadCsv, to12h } from '../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, TwoCol, QaRow, Status } from '../components/proto.jsx';
import { isAdmin, isHR as hasHrmsAdmin, canEditAttendance, canDecideAttendance } from '../permissions';
import Combo from '../components/Combo.jsx';

const METHODS = ['Web Check-in', 'Mobile App', 'Biometric (Fingerprint)'];

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

// The code/name/department/role filters shared by the Biometric, Punch Log and
// Reports tabs — kept in one place so all three read the same way.
function filterQuery(filters) {
  const params = new URLSearchParams();
  Object.keys(filters).forEach((k) => { if (filters[k]) params.set(k, filters[k]); });
  return params.toString();
}

function useDepartments(enabled) {
  const [departments, setDepartments] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    api.get('/admin/departments').then((res) => setDepartments(res.data.map((d) => d.name))).catch(() => setDepartments([]));
  }, [enabled]);
  return departments;
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

function DashboardTab({ isHR, canMark, goTab }) {
  const [date, setDate] = useState(today());
  const [data, setData] = useState(null);
  const [showMarking, setShowMarking] = useState(true);

  function load() {
    api.get(`/attendance/dashboard?date=${date}`).then((res) => setData(res.data));
  }
  useEffect(load, [date]);

  async function mark(employeeId, status) {
    await api.post('/attendance', { employeeId, date, status });
    load();
  }

  if (!isHR) return <SelfServiceTab />;
  if (!data) return <div className="small-muted">Loading…</div>;
  const k = data.kpis;

  return (
    <div>
      <StatRow cells={[
        { value: k.presentToday, label: 'Present Today' },
        { value: k.absentToday, label: 'Absent Today' },
        { value: k.lateCheckIn, label: 'Late Check-in' },
        { value: k.halfDayCut, label: 'Half-day Cut' },
        { value: k.missingPunchIn, label: 'Missing Punch-in' },
      ]} />

      <TwoCol>
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>① Biometric Reports — Check-in / Check-out</h3>
          <StatRow columns={2} cells={[
            { value: k.totalCheckedIn, label: 'Total Checked In' },
            { value: k.totalCheckedOut, label: 'Total Checked Out' },
          ]} />
          {data.byMethod.map((m) => (
            <AssignRow flush key={m.method}>
              <span>{m.method}</span>
              <span className="cell-muted" style={{ fontSize: 12 }}>In: {m.in} · Out: {m.out}</span>
            </AssignRow>
          ))}
        </PanelPad>
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
              <button className="btn btn-sm" onClick={() => setShowMarking((s) => !s)}>{showMarking ? '− Hide daily marking' : '+ Show daily marking'}</button>
              <button className="btn btn-sm" onClick={() => goTab('regularization')}>+ Request Regularization</button>
              <button className="btn btn-sm" onClick={() => goTab('methods')}>+ Configure Policies</button>
            </QaRow>
          </PanelPad>
        </div>
      </TwoCol>

      {showMarking && (
        <Panel style={{ marginTop: 16 }}>
          <PanelHead title={`Daily marking — ${date}`}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </PanelHead>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Status</th><th>In</th><th>Location</th><th style={{ textAlign: 'right' }}>Mark</th></tr></thead>
              <tbody>
                {data.marking.map((r) => (
                  <tr key={r.employeeId}>
                    <td><b>{r.employeeCode}</b></td>
                    <td>{r.name}</td>
                    <td className="cell-muted">{r.department || '—'}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="cell-muted">{r.checkIn ? to12h(r.checkIn) : '—'}</td>
                    <td className="cell-muted">{r.location || '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canMark ? ['Present', 'Absent', 'Half Day'].map((s) => (
                        <button key={s} className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => mark(r.employeeId, s)}>{s}</button>
                      )) : <span className="cell-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {data.marking.length === 0 && <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No employees.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

// An employee's own view of the Dashboard tab: punch in/out and see their history.
function SelfServiceTab() {
  const [records, setRecords] = useState([]);
  const [punches, setPunches] = useState([]);
  const [method, setMethod] = useState(METHODS[0]);
  const [message, setMessage] = useState('');

  function load() {
    api.get('/attendance').then((res) => setRecords(res.data));
    api.get('/attendance/punches').then((res) => setPunches(res.data));
  }
  useEffect(load, []);

  async function punch(direction) {
    setMessage('');
    const res = await api.post('/attendance/punches', { direction, method });
    setMessage(`Punched ${direction} at ${to12h(res.data.time)} via ${res.data.method}.`);
    load();
  }

  const todayPunches = punches.filter((p) => p.date === today());

  return (
    <div>
      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Check in / Check out</h3>
        <div className="filter-row">
          <Combo value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </Combo>
          <button className="btn btn-sm btn-primary" onClick={() => punch('In')}>Punch In</button>
          <button className="btn btn-sm" onClick={() => punch('Out')}>Punch Out</button>
        </div>
        {message && <div className="small-muted" style={{ marginTop: 8 }}>{message}</div>}
        <div className="small-muted" style={{ marginTop: 8 }}>
          {todayPunches.length ? `${todayPunches.length} punch(es) recorded today.` : 'No punches recorded today yet.'}
        </div>
      </PanelPad>

      <Panel>
        <PanelHead title="My attendance" />
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>Check-in</th><th>Check-out</th></tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>{r.date}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td className="cell-muted">{r.checkIn ? to12h(r.checkIn) : '—'}</td>
                  <td className="cell-muted">{r.checkOut ? to12h(r.checkOut) : '—'}</td>
                </tr>
              ))}
              {records.length === 0 && <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No attendance records yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ---- Tab 2: Biometric Attendance List ---------------------------------------

const EMPTY_BIO = { date: '', code: '', name: '', department: '', role: '' };

function BiometricTab() {
  const [filters, setFilters] = useState(EMPTY_BIO);
  const [data, setData] = useState(null);
  const departments = useDepartments(true);
  const roles = useRoles(true);

  useEffect(() => {
    api.get(`/attendance/biometric?${filterQuery(filters)}`).then((res) => setData(res.data));
  }, [filters]);

  function exportCsv() {
    downloadCsv(
      `attendance-${data.month}.csv`,
      ['Code', 'Name', 'Department', 'Role', 'Present', 'Late', 'Half-day Cut', 'Attendance %'],
      data.rows.map((r) => [r.employeeCode, r.name, r.department, r.role, r.present, r.late, r.halfDayCut, `${r.pct}%`])
    );
  }

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <Panel>
      <PanelHead title={<>Biometric &amp; Device Attendance — Employee List <span className="cell-muted" style={{ fontSize: 12, fontStyle: 'italic' }}>({data?.month || ''})</span></>}>
        <button className="btn btn-sm btn-primary" onClick={exportCsv} disabled={!data}>Export</button>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <div className="filter-row">
          <input type="date" value={filters.date} onChange={(e) => set('date', e.target.value)} />
          <input placeholder="Employee ID" value={filters.code} onChange={(e) => set('code', e.target.value)} />
          <input placeholder="Employee name" value={filters.name} onChange={(e) => set('name', e.target.value)} />
          <Combo value={filters.department} onChange={(e) => set('department', e.target.value)}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d}>{d}</option>)}
          </Combo>
          <Combo value={filters.role} onChange={(e) => set('role', e.target.value)}>
            <option value="">All Roles</option>
            {roles.map((r) => <option key={r}>{r}</option>)}
          </Combo>
          <button className="btn btn-sm" onClick={() => setFilters(EMPTY_BIO)}>Clear</button>
        </div>
      </div>
      <div className="small-muted" style={{ fontSize: 12.5, padding: '0 18px 10px' }}>
        {filters.date
          ? `Showing the biometric report for ${filters.date}. Clear the date to go back to each employee's last-ever punch.`
          : "Showing each employee's last-ever punch. Pick a date above to see that specific day's biometric report instead."}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Name</th><th>Department</th><th>Role</th><th>Method</th>
              <th>{filters.date ? 'Punches' : 'Last punch (ever)'}</th>
              <th>Check-in</th><th>Check-out</th><th>Location</th>
              <th>Present (month)</th><th>Late (month)</th><th>Half-day Cut (month)</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={r.employeeId}>
                <td><b>{r.employeeCode}</b></td><td>{r.name}</td>
                <td className="cell-muted">{r.department || '—'}</td><td className="cell-muted">{r.role || '—'}</td>
                <td className="cell-muted">{r.method}</td><td className="cell-muted">{r.lastPunch}</td>
                <td className="cell-muted">{to12h(r.checkIn)}</td><td className="cell-muted">{to12h(r.checkOut)}</td>
                <td className="cell-muted">{r.location}</td>
                <td style={{ textAlign: 'center' }}>{r.present}</td>
                <td style={{ textAlign: 'center' }}>{r.late}</td>
                <td style={{ textAlign: 'center' }}>{r.halfDayCut}</td>
              </tr>
            ))}
            {data && data.rows.length === 0 && <tr><td colSpan="12" className="small-muted" style={{ padding: 16 }}>No employees match these filters</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 18px' }} className="small-muted">{data?.rows.length ?? 0} employee(s)</div>
    </Panel>
  );
}

// ---- Tab 3: Punch Log (Detailed) --------------------------------------------

function PunchLogTab() {
  const emptyFilters = { from: `${thisMonth()}-01`, to: today(), name: '', department: '' };
  const [filters, setFilters] = useState(emptyFilters);
  const [data, setData] = useState(null);
  const departments = useDepartments(true);

  useEffect(() => {
    api.get(`/attendance/punch-log?${filterQuery(filters)}`).then((res) => setData(res.data));
  }, [filters]);

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  function exportCsv() {
    downloadCsv(
      `punch-log-${filters.from}_${filters.to}.csv`,
      ['Date', 'Code', 'Name', 'Department', 'Punches', 'First In', 'Last Out', 'Hours', 'Method', 'Location', 'Late?'],
      data.rows.map((r) => [r.date, r.employeeCode, r.name, r.department, r.punches, r.firstIn, r.lastOut, r.hours ?? '—', r.method, r.location, r.late ? 'Late' : 'On time'])
    );
  }

  return (
    <Panel>
      <PanelHead title="Punch Log — every device punch, paired into sessions">
        <button className="btn btn-sm btn-primary" onClick={exportCsv} disabled={!data}>Export</button>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <div className="filter-row">
          <label className="small-muted" style={{ alignSelf: 'center', margin: 0 }}>From</label>
          <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          <label className="small-muted" style={{ alignSelf: 'center', margin: 0 }}>To</label>
          <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
          <input placeholder="Employee name" value={filters.name} onChange={(e) => set('name', e.target.value)} />
          <Combo value={filters.department} onChange={(e) => set('department', e.target.value)}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d}>{d}</option>)}
          </Combo>
          <button className="btn btn-sm" onClick={() => setFilters(emptyFilters)}>Clear</button>
        </div>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Date</th><th>Code</th><th>Name</th><th>Punches</th><th>First In</th><th>Last Out</th><th>Hours</th><th>Method</th><th>Location</th><th>Late?</th></tr></thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={`${r.employeeId}-${r.date}`}>
                <td>{r.date}</td><td><b>{r.employeeCode}</b></td><td>{r.name}</td>
                <td className="cell-muted">{r.punches}</td>
                <td className="cell-muted">{to12h(r.firstIn)}</td>
                <td className="cell-muted">{to12h(r.lastOut)}</td>
                <td className="cell-muted">{r.hours ?? '—'}</td>
                <td className="cell-muted">{r.method}</td>
                <td className="cell-muted">{r.location}</td>
                <td><span className={`status ${r.late ? 'pending' : 'active'}`}>{r.late ? 'Late' : 'On time'}</span></td>
              </tr>
            ))}
            {data && data.rows.length === 0 && <tr><td colSpan="10" className="small-muted" style={{ padding: 16 }}>No punches in this date range.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 18px' }} className="small-muted">{data?.rows.length ?? 0} session(s)</div>
    </Panel>
  );
}

// ---- Tab 4: Reports (Monthly) -----------------------------------------------

function ReportsTab() {
  const [month, setMonth] = useState(thisMonth());
  const [filters, setFilters] = useState({ code: '', name: '', department: '', role: '' });
  const [report, setReport] = useState(null);
  const departments = useDepartments(true);
  const roles = useRoles(true);

  useEffect(() => {
    api.get(`/attendance/report?month=${month}&${filterQuery(filters)}`).then((res) => setReport(res.data));
  }, [month, filters]);

  function exportCsv() {
    downloadCsv(
      `attendance-report-${month}.csv`,
      ['Code', 'Name', 'Department', 'Working Days', 'Present', 'Half Day', 'Absent', 'Leave', 'Late', 'Half-day Cut', 'Attendance %'],
      report.rows.map((r) => [r.employeeCode, r.name, r.department, r.workingDays, r.present, r.halfDay, r.absent, r.leave, r.late, r.halfDayCut, `${r.pct}%`])
    );
  }

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <Panel>
      <PanelHead title={`Monthly Attendance Report — ${report?.monthLabel || month}`}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button className="btn btn-sm btn-primary" onClick={exportCsv} disabled={!report}>Export</button>
        </div>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <div className="filter-row">
          <input placeholder="Employee ID" value={filters.code} onChange={(e) => set('code', e.target.value)} />
          <input placeholder="Employee name" value={filters.name} onChange={(e) => set('name', e.target.value)} />
          <Combo value={filters.department} onChange={(e) => set('department', e.target.value)}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d}>{d}</option>)}
          </Combo>
          <Combo value={filters.role} onChange={(e) => set('role', e.target.value)}>
            <option value="">All Roles</option>
            {roles.map((r) => <option key={r}>{r}</option>)}
          </Combo>
        </div>
      </div>
      {report && (
        <div style={{ padding: '2px 18px 14px' }}>
          <StatRow cells={[
            { value: report.totals.present, label: 'Total Present Days' },
            { value: report.totals.absent, label: 'Total Absent Days' },
            { value: report.totals.late, label: 'Total Late Days' },
            { value: report.totals.halfDayCut, label: 'Total Half-day Cuts' },
          ]} />
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Working Days</th><th>Present</th><th>Half Day</th><th>Absent</th><th>Leave</th><th>Late</th><th>Half-day Cut</th><th>Attendance %</th></tr></thead>
          <tbody>
            {(report?.rows || []).map((r) => (
              <tr key={r.employeeId}>
                <td><b>{r.employeeCode}</b></td><td>{r.name}</td><td className="cell-muted">{r.department || '—'}</td>
                <td style={{ textAlign: 'center' }}>{r.workingDays}</td>
                <td style={{ textAlign: 'center' }}>{r.present}</td>
                <td style={{ textAlign: 'center' }}>{r.halfDay}</td>
                <td style={{ textAlign: 'center' }}>{r.absent}</td>
                <td style={{ textAlign: 'center' }}>{r.leave}</td>
                <td style={{ textAlign: 'center' }}>{r.late}</td>
                <td style={{ textAlign: 'center' }}>{r.halfDayCut}</td>
                <td style={{ textAlign: 'center' }}><b>{r.pct}%</b></td>
              </tr>
            ))}
            {report && report.rows.length === 0 && <tr><td colSpan="11" className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---- Tab 5: Check-in Methods (usage + attendance policy) --------------------

function MethodsTab({ canEdit }) {
  const [methods, setMethods] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState('');

  function load() {
    api.get('/attendance/methods').then((res) => setMethods(res.data));
    api.get('/attendance/policy').then((res) => setPolicy(res.data));
  }
  useEffect(load, []);

  async function save(patch) {
    setError('');
    const next = { ...policy, ...patch };
    setPolicy(next);
    try {
      const res = await api.put('/attendance/policy', next);
      setPolicy(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the policy');
    }
  }

  return (
    <TwoCol style={{ gridTemplateColumns: '1fr 1fr' }}>
      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Check-in Methods</h3>
        <div className="small-muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Methods your people may use to record a punch. Usage counts are from the punch log.
        </div>
        {methods.map((m) => (
          <AssignRow flush key={m.method}>
            <span>{m.method}</span>
            <span className="cell-muted" style={{ fontSize: 12 }}>{m.punches} punch(es) recorded</span>
          </AssignRow>
        ))}
        <div className="small-muted" style={{ fontSize: 11.5, fontStyle: 'italic', marginTop: 10 }}>
          Prototype simulation — a production check-in would capture GPS location (with permission) and a face verification.
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
          {error && <div className="error-text">{error}</div>}
          <div className="small-muted" style={{ fontSize: 11.5 }}>
            Late days beyond the free allowance become half-day cuts in the monthly report.
          </div>
        </PanelPad>
      )}
    </TwoCol>
  );
}

// ---- Regularization (kept from main — correcting a missed punch after the fact) ----
// The prototype calls regularizationModalHtml(), which it never defines, so its
// own "+ Request Regularization" button is dead; this is the working version.

function RegularizationTab({ isHR, canDecide }) {
  const [requests, setRequests] = useState([]);
  const [form, setForm] = useState({ date: today(), requestedCheckIn: '', requestedCheckOut: '', reason: '' });

  function load() {
    api.get('/attendance/regularizations').then((res) => setRequests(res.data));
  }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault();
    await api.post('/attendance/regularizations', form);
    setForm({ ...form, reason: '' });
    load();
  }

  async function decide(id, status) {
    await api.patch(`/attendance/regularizations/${id}/decision`, { status });
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
        <div className="tbl-wrap">
          <table>
            <thead><tr>{isHR && <th>Employee</th>}<th>Date</th><th>Requested In</th><th>Requested Out</th><th>Reason</th><th>Status</th>{isHR && <th></th>}</tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  {isHR && <td>{r.employee?.name}</td>}
                  <td>{r.date}</td>
                  <td className="cell-muted">{r.requestedCheckIn || '—'}</td>
                  <td className="cell-muted">{r.requestedCheckOut || '—'}</td>
                  <td className="cell-muted">{r.reason || '—'}</td>
                  <td><Status>{r.status}</Status></td>
                  {isHR && <td>{canDecide && r.status === 'Pending' && (<><button className="btn btn-sm btn-primary" onClick={() => decide(r.id, 'Approved')}>Approve</button>{' '}<button className="btn btn-sm btn-danger" onClick={() => decide(r.id, 'Rejected')}>Reject</button></>)}</td>}
                </tr>
              ))}
              {requests.length === 0 && <tr><td colSpan={isHR ? 7 : 5} className="small-muted" style={{ padding: 16 }}>No regularization requests yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
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
  const [tab, setTab] = useState('dashboard');

  return (
    <TabsPage
      title="Attendance & Time"
      subtitle="Daily marking, device punches, monthly reports and the check-in methods your people may use."
      value={tab}
      onChange={setTab}
      tabs={[
        { key: 'dashboard', label: 'Dashboard', element: <DashboardTab isHR={isHR} canMark={canMark} goTab={setTab} /> },
        ...(isHR ? [
          { key: 'biometric', label: 'Biometric Attendance List', element: <BiometricTab /> },
          { key: 'punchlog', label: 'Punch Log (Detailed)', element: <PunchLogTab /> },
          { key: 'reports', label: 'Reports (Monthly)', element: <ReportsTab /> },
        ] : []),
        { key: 'methods', label: 'Check-in Methods', element: <MethodsTab canEdit={canEditPolicy} /> },
        { key: 'regularization', label: 'Regularization', element: <RegularizationTab isHR={isHR} canDecide={canDecide} /> },
      ]}
    />
  );
}
