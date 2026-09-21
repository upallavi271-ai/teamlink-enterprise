import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import TabsPage from '../components/TabsPage.jsx';
import { downloadCsv } from '../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, ScopeNote, TwoCol, Status, Modal } from '../components/proto.jsx';
import { isAdmin, isHR as hasHrmsAdmin } from '../permissions';

const today = () => new Date().toISOString().slice(0, 10);

function capLabel(t) {
  return t.unit === 'unpaid' ? 'Unpaid' : `${t.cap}/${t.unit}`;
}

// The prototype's Apply Leave modal (openApplyLeaveModal, line 3908).
function ApplyLeaveModal({ types, employees, isHR, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', type: types[0]?.name || '', days: 1, fromDate: '', toDate: '', reason: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.fromDate || !form.toDate) { setError('From and To dates are required.'); return; }
    try {
      await api.post('/leave', {
        employeeId: isHR ? form.employeeId : undefined,
        type: form.type,
        fromDate: form.fromDate,
        toDate: form.toDate,
        days: Number(form.days) || 1,
        reason: form.reason,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit the request');
    }
  }

  return (
    <Modal
      title="Apply Leave"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Submit</button></>}
    >
      {isHR && (
        <div className="field">
          <label>Employee</label>
          <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
            <option value="">Select employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
      )}
      <div className="grid-2">
        <div className="field">
          <label>Type</label>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {types.map((t) => <option key={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Days</label><input type="number" min="1" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></div>
        <div className="field"><label>From</label><input type="date" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} /></div>
        <div className="field"><label>To</label><input type="date" value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} /></div>
      </div>
      <div className="field"><label>Reason</label><textarea rows="2" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function DashboardTab({ isHR, canEditPolicy, reloadKey, onReload }) {
  const [requests, setRequests] = useState([]);
  const [types, setTypes] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [caps, setCaps] = useState(null);
  const [onLeave, setOnLeave] = useState(null);
  const [filters, setFilters] = useState({ department: '', type: '' });
  const [error, setError] = useState('');

  function load() {
    api.get('/leave').then((res) => setRequests(res.data));
    api.get('/leave/types').then((res) => setTypes(res.data));
    api.get('/leave/reasons').then((res) => setReasons(res.data));
    api.get('/leave/concurrency-policy').then((res) => setCaps(res.data));
    if (isHR) api.get('/leave/on-leave-today').then((res) => setOnLeave(res.data)).catch(() => setOnLeave(null));
  }
  useEffect(load, [isHR, reloadKey]);

  async function saveCaps(patch) {
    const res = await api.put('/leave/concurrency-policy', patch);
    // The PUT echoes the whole HrConfig row, where escalationOrder is still the
    // raw comma string — keep the parsed array the GET gave us.
    setCaps({
      ...caps,
      concurrentLeaveCapPct: res.data.concurrentLeaveCapPct,
      concurrentLeaveCapFlat: res.data.concurrentLeaveCapFlat,
      leaveReasonThresholdDays: res.data.leaveReasonThresholdDays,
    });
  }

  // Approvals of leaveReasonThresholdDays or more need one of the configured
  // reasons; rejections always need free text.
  async function decide(request, status) {
    setError('');
    const body = { status };
    if (status === 'Rejected') {
      const why = prompt(`Reject ${request.employee?.name || 'this'} leave request — reason (the employee sees this):`, '');
      if (why === null) return;
      if (!why.trim()) { setError('A rejection reason is required.'); return; }
      body.rejectReason = why.trim();
    }
    if (status === 'Approved') {
      const days = request.days || 1;
      const active = reasons.filter((r) => r.active);
      if (caps && days >= caps.leaveReasonThresholdDays && active.length) {
        const list = active.map((r, i) => `${i + 1}. ${r.label}`).join('\n');
        const pick = prompt(`Approve leave — ${days} day(s). Reason:\n${list}`, '1');
        if (pick === null) return;
        body.approvalReason = (active[(Number(pick) || 1) - 1] || active[0]).label;
      }
    }
    try {
      await api.patch(`/leave/${request.id}/decision`, body);
      onReload();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record the decision');
    }
  }

  async function requestCancel(id) { await api.patch(`/leave/${id}/cancel-request`); onReload(); }

  async function editCap(type) {
    const v = prompt(`Annual/monthly cap for ${type.name} (${type.unit})`, type.cap);
    if (v === null) return;
    await api.put(`/leave/types/${type.id}`, { cap: Number(v) || 0 });
    onReload();
  }
  async function toggleType(type) { await api.put(`/leave/types/${type.id}`, { active: !type.active }); onReload(); }
  async function addType() {
    const name = prompt('Leave type name?');
    if (!name || !name.trim()) return;
    const code = prompt('Short code (e.g. CL)?', '') || name.slice(0, 2).toUpperCase();
    const cap = Number(prompt('Cap per year?', '12')) || 0;
    await api.post('/leave/types', { name: name.trim(), code, cap, unit: 'yr' });
    onReload();
  }
  async function addReason() {
    const label = prompt('Approval reason?');
    if (!label || !label.trim()) return;
    await api.post('/leave/reasons', { label: label.trim() });
    onReload();
  }
  async function toggleReason(reason) { await api.put(`/leave/reasons/${reason.id}`, { active: !reason.active }); onReload(); }

  const scoped = requests.filter((r) => (
    (!filters.department || r.employee?.department === filters.department)
    && (!filters.type || r.type === filters.type)
  ));
  const pending = scoped.filter((r) => r.status === 'Pending');
  const approved = scoped.filter((r) => r.status === 'Approved');
  const rejected = scoped.filter((r) => r.status === 'Rejected');
  const cancellations = scoped.filter((r) => r.status === 'Cancellation Requested');
  const onLeaveToday = approved.filter((r) => r.fromDate <= today() && (r.toDate || r.fromDate) >= today());
  const departments = [...new Set(requests.map((r) => r.employee?.department).filter(Boolean))].sort();

  function exportRequests() {
    downloadCsv(
      'leave-requests.csv',
      ['Employee', 'Department', 'Type', 'From', 'To', 'Days', 'Status', 'Reason'],
      scoped.map((r) => [r.employee?.name || '', r.employee?.department || '', r.type, r.fromDate, r.toDate, r.days ?? 1, r.status, r.reason || ''])
    );
  }

  return (
    <div>
      <div className="filter-row" style={{ marginTop: 14, marginBottom: 12 }}>
        <select value={filters.department} onChange={(e) => setFilters({ ...filters, department: e.target.value })}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">Leave Type</option>
          {types.map((t) => <option key={t.id} value={t.name}>{t.name} ({t.code})</option>)}
        </select>
        <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={exportRequests}>Export</button>
      </div>

      <StatRow cells={[
        { value: pending.length, label: 'Pending Requests' },
        { value: approved.length, label: 'Approved (MTD)' },
        { value: rejected.length, label: 'Rejected (MTD)' },
        { value: onLeaveToday.length, label: 'Employees on Leave Today' },
        { value: cancellations.length, label: 'Cancellation Requests' },
      ]} />

      {error && <div className="error-text">{error}</div>}

      <TwoCol>
        {/* ① Approval chain */}
        <Panel>
          <PanelHead title="① Leave Approval Chain" />
          <div style={{ padding: '8px 18px 4px' }} className="cell-muted">
            {(caps?.escalationOrder || []).slice(0, 3).join(' → ')}
          </div>
          {pending.length === 0
            ? <EmptyMini>No pending requests.</EmptyMini>
            : pending.slice(0, 8).map((r) => (
              <AssignRow key={r.id}>
                <span>
                  {r.employee?.name || 'You'}<br />
                  <span className="cell-muted" style={{ fontSize: 11.5 }}>
                    {r.type} · {r.fromDate}{r.toDate && r.toDate !== r.fromDate ? ` → ${r.toDate}` : ''}
                  </span>
                </span>
                {isHR && (
                  <span>
                    <button className="btn btn-sm btn-primary" onClick={() => decide(r, 'Approved')}>Approve</button>{' '}
                    <button className="btn btn-sm btn-danger" onClick={() => decide(r, 'Rejected')}>Reject</button>
                  </span>
                )}
              </AssignRow>
            ))}
        </Panel>

        {/* ② Leave types & policy */}
        <Panel>
          <PanelHead title="② Leave Types & Policy">
            {canEditPolicy && <button className="btn btn-sm" onClick={addType}>+ Add</button>}
          </PanelHead>
          {types.map((t) => (
            <AssignRow key={t.id} style={t.active ? undefined : { opacity: 0.55 }}>
              <span>
                {t.name} ({t.code})
                {t.carries && <> <span className="status active">Carries forward</span></>}
                {!t.active && <> <span className="status pending">Paused</span></>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="cell-muted">{capLabel(t)}</span>
                {canEditPolicy && <button className="btn btn-sm" onClick={() => editCap(t)}>Edit</button>}
                {canEditPolicy && <button className="btn btn-sm" onClick={() => toggleType(t)}>{t.active ? 'Pause' : 'Resume'}</button>}
              </span>
            </AssignRow>
          ))}
          {caps && (
            <>
              <AssignRow>
                <span>
                  <b>Concurrent Leave Cap</b><br />
                  <span className="cell-muted" style={{ fontSize: 11.5 }}>Max % of a department that can be on leave for the same dates at once.</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <b>{caps.concurrentLeaveCapPct}%</b>
                  {canEditPolicy && <button className="btn btn-sm" onClick={() => { const v = prompt('New value for Concurrent Leave Cap %', caps.concurrentLeaveCapPct); if (v !== null) saveCaps({ concurrentLeaveCapPct: Number(v) || 0 }); }}>Edit</button>}
                </span>
              </AssignRow>
              <AssignRow>
                <span>
                  <b>Concurrent Leave Cap — Flat Headcount</b><br />
                  <span className="cell-muted" style={{ fontSize: 11.5 }}>Absolute max people from one department on leave at once — the stricter cap wins.</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <b>{caps.concurrentLeaveCapFlat}</b>
                  {canEditPolicy && <button className="btn btn-sm" onClick={() => { const v = prompt('New value for Flat headcount cap', caps.concurrentLeaveCapFlat); if (v !== null) saveCaps({ concurrentLeaveCapFlat: Number(v) || 0 }); }}>Edit</button>}
                </span>
              </AssignRow>
            </>
          )}
        </Panel>
      </TwoCol>

      <TwoCol>
        {/* ③ Approval reasons */}
        <Panel>
          <PanelHead title="③ Leave Approval Reasons">
            {canEditPolicy && <button className="btn btn-sm" onClick={addReason}>+ Add</button>}
          </PanelHead>
          <div style={{ padding: '8px 18px 4px' }} className="cell-muted">
            Shown as options when approving a leave request of {caps?.leaveReasonThresholdDays ?? 4}+ days.
          </div>
          {reasons.map((r) => (
            <AssignRow key={r.id} style={r.active ? undefined : { opacity: 0.55 }}>
              <span>{r.label}{!r.active && <> <span className="status pending">Paused</span></>}</span>
              <span>{canEditPolicy && <button className="btn btn-sm" onClick={() => toggleReason(r)}>{r.active ? 'Pause' : 'Resume'}</button>}</span>
            </AssignRow>
          ))}
        </Panel>

        {/* ④ Department-wise */}
        <Panel>
          <PanelHead title="④ Employees on Leave — Department Wise" />
          {onLeave && onLeave.total === 0 && <EmptyMini>No one on leave today.</EmptyMini>}
          {(onLeave?.departments || []).map((d) => (
            <AssignRow key={d.department}>
              <span>{d.department}</span>
              <span><span className={`status ${d.onLeave > 0 ? 'pending' : 'active'}`}>{d.onLeave} on leave</span></span>
            </AssignRow>
          ))}
          {!onLeave && <EmptyMini>Not available for your role.</EmptyMini>}
        </Panel>
      </TwoCol>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="All leave requests" />
        {scoped.length === 0
          ? <EmptyMini>No leave requests yet.</EmptyMini>
          : scoped.slice(0, 10).map((r) => (
            <AssignRow key={r.id}>
              <span>
                {r.employee?.name || 'You'}<br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>
                  {r.type} · {r.fromDate}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Status>{r.status}</Status>
                {isHR && r.status === 'Cancellation Requested' && <button className="btn btn-sm" onClick={() => decide(r, 'Cancelled')}>Confirm Cancel</button>}
                {!isHR && r.status === 'Approved' && <button className="btn btn-sm" onClick={() => requestCancel(r.id)}>Request Cancellation</button>}
              </span>
            </AssignRow>
          ))}
      </Panel>
    </div>
  );
}

// Reports: the filterable request log plus the remaining/total balance grid.
function ReportsTab({ reloadKey }) {
  const [requests, setRequests] = useState([]);
  const [balances, setBalances] = useState(null);
  const [filters, setFilters] = useState({ code: '', name: '', department: '', role: '' });
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    api.get('/leave').then((res) => setRequests(res.data));
    api.get('/leave/balances').then((res) => setBalances(res.data));
    api.get('/employees')
      .then((res) => setRoles([...new Set(res.data.map((e) => e.designation).filter(Boolean))].sort()))
      .catch(() => setRoles([]));
  }, [reloadKey]);

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const matches = (emp) => (
    (!filters.code || (emp?.employeeCode || '').toLowerCase().includes(filters.code.toLowerCase()))
    && (!filters.name || (emp?.name || '').toLowerCase().includes(filters.name.toLowerCase()))
    && (!filters.department || emp?.department === filters.department)
    && (!filters.role || emp?.designation === filters.role)
  );
  const scoped = requests.filter((r) => matches(r.employee));
  const balanceRows = balances?.rows || [];
  const departments = [...new Set(requests.map((r) => r.employee?.department).filter(Boolean))].sort();

  function exportRequests() {
    downloadCsv(
      'leave-requests.csv',
      ['Code', 'Employee', 'Department', 'Type', 'From', 'To', 'Days', 'Status', 'Reason'],
      scoped.map((r) => [r.employee?.employeeCode || '', r.employee?.name || '', r.employee?.department || '', r.type, r.fromDate, r.toDate, r.days ?? 1, r.status, r.reason || ''])
    );
  }

  return (
    <div>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Leave Requests Report">
          <button className="btn btn-sm btn-primary" onClick={exportRequests}>Export (Excel)</button>
        </PanelHead>
        <div style={{ padding: '12px 18px' }}>
          <div className="filter-row">
            <input placeholder="Employee ID…" value={filters.code} onChange={(e) => set('code', e.target.value)} />
            <input placeholder="Employee name…" value={filters.name} onChange={(e) => set('name', e.target.value)} />
            <select value={filters.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d}>{d}</option>)}
            </select>
            <select value={filters.role} onChange={(e) => set('role', e.target.value)}>
              <option value="">All Roles</option>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </select>
            <span className="cell-muted" style={{ fontSize: 12, alignSelf: 'center' }}>{scoped.length} of {requests.length}</span>
          </div>
        </div>
        {scoped.length === 0 ? <EmptyMini>No leave requests yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Code</th><th>Employee</th><th>Department</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th></tr></thead>
              <tbody>
                {scoped.map((r) => (
                  <tr key={r.id}>
                    <td>{r.employee?.employeeCode || '—'}</td><td>{r.employee?.name}</td>
                    <td className="cell-muted">{r.employee?.department || '—'}</td>
                    <td className="cell-muted">{r.type}</td>
                    <td className="cell-muted">{r.fromDate}</td>
                    <td className="cell-muted">{r.toDate || r.fromDate}</td>
                    <td className="cell-muted">{r.days ?? 1}</td>
                    <td><Status>{r.status}</Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title={<>Leave Balances <span className="cell-muted" style={{ fontSize: 12 }}>(remaining / total — paused leave types are hidden)</span></>} />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Employee</th><th>Department</th>
                {(balances?.types || []).map((t) => <th key={t.code} title={t.name} style={{ textAlign: 'center' }}>{t.code}</th>)}
              </tr>
            </thead>
            <tbody>
              {balanceRows.map((r) => (
                <tr key={r.employeeId}>
                  <td><b>{r.employeeCode}</b></td><td>{r.name}</td><td className="cell-muted">{r.department || '—'}</td>
                  {r.balances.map((b) => <td key={b.code} style={{ textAlign: 'center' }}>{b.total == null ? '—' : `${b.remaining} / ${b.total}`}</td>)}
                </tr>
              ))}
              {balanceRows.length === 0 && <tr><td colSpan={3 + (balances?.types.length || 0)} className="small-muted" style={{ padding: 16 }}>No balances yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function HolidaysTab({ canManage }) {
  const [holidays, setHolidays] = useState([]);

  function load() { api.get('/leave/holidays').then((res) => setHolidays(res.data)); }
  useEffect(load, []);

  async function add() {
    const name = prompt('Holiday name?');
    if (!name || !name.trim()) return;
    const date = prompt('Date (YYYY-MM-DD)?', `${new Date().getFullYear()}-12-25`);
    if (!date) return;
    const type = prompt('Type?', 'Festival') || 'Festival';
    await api.post('/leave/holidays', { name: name.trim(), date, type });
    load();
  }

  async function remove(id) { await api.delete(`/leave/holidays/${id}`); load(); }

  const sorted = [...holidays].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Company Holiday Calendar">
        {canManage && <button className="btn btn-sm btn-primary" onClick={add}>+ Add Holiday</button>}
      </PanelHead>
      {sorted.length === 0 ? <EmptyMini>No holidays added yet — add the company holiday calendar for the year.</EmptyMini> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Holiday</th><th>Type</th><th>Actions</th></tr></thead>
            <tbody>
              {sorted.map((h) => (
                <tr key={h.id}>
                  <td className="cell-muted">
                    {h.date}{' '}
                    {h.date === today() && <span className="status active">Today</span>}
                    {h.date < today() && <span className="status pending">Past</span>}
                  </td>
                  <td>{h.name}</td>
                  <td className="cell-muted">{h.type || '—'}</td>
                  <td>{canManage && <button className="btn btn-sm" onClick={() => remove(h.id)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function Leave() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const canEditPolicy = isAdmin(user);
  const [applyOpen, setApplyOpen] = useState(false);
  const [types, setTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.get('/leave/types').then((res) => setTypes(res.data.filter((t) => t.active)));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }, [isHR, reloadKey]);

  const banner = canEditPolicy
    ? <ScopeNote amber>Full, unrestricted access — configures Leave Types/Policy and every approval cap itself.</ScopeNote>
    : <ScopeNote>You can action requests and read the policy. Only a Super Admin changes leave types and caps.</ScopeNote>;

  return (
    <>
      <TabsPage
        title="Leave Management"
        subtitle={<>Signed in as: <b>{user?.name}</b></>}
        head={<button className="btn btn-primary" onClick={() => setApplyOpen(true)}>Apply Leave</button>}
        banner={banner}
        tabs={[
          { key: 'dashboard', label: 'Dashboard', element: <DashboardTab isHR={isHR} canEditPolicy={canEditPolicy} reloadKey={reloadKey} onReload={() => setReloadKey((k) => k + 1)} /> },
          { key: 'reports', label: 'Reports', element: <ReportsTab reloadKey={reloadKey} /> },
          { key: 'holidays', label: 'Holidays', element: <HolidaysTab canManage={isHR} /> },
        ]}
      />
      {applyOpen && (
        <ApplyLeaveModal
          types={types}
          employees={employees}
          isHR={isHR}
          onClose={() => setApplyOpen(false)}
          onSaved={() => { setApplyOpen(false); setReloadKey((k) => k + 1); }}
        />
      )}
    </>
  );
}
