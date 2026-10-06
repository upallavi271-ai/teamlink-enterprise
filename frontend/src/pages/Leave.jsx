import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import TabsPage from '../components/TabsPage.jsx';
import { Panel, PanelPad, PanelHead, AssignRow, EmptyMini, ScopeNote, SectionLabel, TwoCol, Status, Modal } from '../components/proto.jsx';
import { isAdmin, isHR as hasHrmsAdmin, can } from '../permissions';
import Combo from '../components/Combo.jsx';
import { HR_STATUSES, hrStatusOf } from '../hrStatus';
import ApprovalChain, { ApprovalChainLine } from '../components/ApprovalChain.jsx';
import ExportMenu from '../components/ExportMenu.jsx';
import InsightsPanel from '../components/charts/InsightsPanel.jsx';
import DataIoBar from '../components/dataio/DataIoBar.jsx';
// Requests list (team, designation, approved-by, comments), Approve · Reject ·
// Reassign with the TL rule, month-wise balance + report, TL rule setting.
import {
  LeaveRequestsTable, LeaveFacts, LeaveDecidePanel, MonthlyBalance, MonthlyReport, TlRuleSetting,
} from './leave/LeaveExtras.jsx';
// Balances (one employee / all employees month-wise / all employees now) and
// the holiday calendar with the full Add Holiday form.
import LeaveBalancesTab from './leave/LeaveBalancesTab.jsx';
import HolidayCalendar from './leave/HolidaysTab.jsx';
import LeaveKpiCards from './leave/LeaveKpiCards.jsx';

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// THE APPROVAL WORKFLOW (§15, spec item 2).
//
//   Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin
//
// The chain, the tracking facts (Submitted By / On, Current Approver,
// Approval Level, Previous Approvers, Status, Approved/Rejected By / On,
// Remarks, Direct Super Admin Approval) and the Approve / Reject controls are
// the shared components/ApprovalChain.jsx — the same view Regularization,
// Resignation, Rewards and Courses use. Nothing here decides who may act:
// the server sends `canAct` (your turn) / `canDirect` (Super Admin), and
// approving out of turn is answered 403 by the API.
// ---------------------------------------------------------------------------
function ApprovalWorkflowModal({ requestId, onClose, onActed }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  function load() {
    setError('');
    api.get(`/leave/${requestId}/workflow`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the approval workflow'));
  }
  useEffect(load, [requestId]);

  const leave = data?.leave;
  const wf = data?.workflow;

  return (
    <Modal title="Approval Workflow" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!data && !error && <EmptyMini>Loading…</EmptyMini>}
      {leave && (
        <>
          <div className="wf-head">
            <div><span className="cell-muted">Leave ID:</span> <b>LV-{String(leave.id).slice(-4).toUpperCase()}</b></div>
          </div>
          <LeaveFacts leave={leave} handoffs={data.handoffs} />

          <SectionLabel style={{ marginTop: 14 }}>Approval Workflow</SectionLabel>
          <ApprovalChain workflow={wf} recordStatus={leave.status} />
          {/* APPROVE · REJECT · REASSIGN — the TL rule is decided by the server. */}
          <LeaveDecidePanel data={data} onDone={() => { load(); onActed(); }} />
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            Pending-since and overdue are worked out when you open this screen — there is no background job
            chasing these, so an overdue step starts reading &quot;Overdue&quot; the next time somebody looks.
          </div>
        </>
      )}
    </Modal>
  );
}

// "each level approval required aa / visibility-only aa separate ga define
// cheyyali" — the chain is the MODEL, this panel is the POLICY. It applies to
// the NEXT request raised; a request already climbing keeps the levels and due
// dates it was raised with.
function ApprovalLevelsPanel({ canConfigure }) {
  const [levels, setLevels] = useState([]);
  const [error, setError] = useState('');

  function load() {
    api.get('/leave/approval-levels').then((res) => setLevels(res.data.levels)).catch(() => setLevels([]));
  }
  useEffect(load, []);

  async function save(level, patch) {
    setError('');
    try {
      const res = await api.put(`/leave/approval-levels/${level.level}`, patch);
      setLevels(res.data.levels);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that level');
    }
  }

  return (
    <Panel>
      <PanelHead title="⑤ Approval Workflow Levels" />
      <div style={{ padding: '8px 18px 4px' }} className="cell-muted">
        {['Employee', ...levels.filter((l) => l.active && !l.paused).map((l) => l.label)].join(' → ')}. The levels come from
        Administration → Organization Structure. Each level is either a
        <b> required approver</b> (the request stops and waits) or <b>visibility only</b> (they see it, it never waits on them).
        A level with nobody in the employee&apos;s department is skipped, and says so on the request.
      </div>
      {error && <div className="error-text">{error}</div>}
      {levels.map((l) => (
        <AssignRow key={l.level} style={l.active ? undefined : { opacity: 0.55 }}>
          <span>
            {l.label}
            {!l.active && <> <span className="status pending">Off</span></>}
            {l.paused && <> <span className="status pending">Paused — skipped</span></>}
            <br />
            <span className="cell-muted" style={{ fontSize: 11.5 }}>
              {l.mode === 'required' ? 'Required approver' : 'Visibility only — never gates'}
              {l.slaHours ? ` · due ${l.slaHours}h after it arrives` : ' · no due date'}
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`status ${l.mode === 'required' ? 'pending' : 'applied'}`}>{l.mode === 'required' ? 'Required' : 'Visibility'}</span>
            {canConfigure && (
              <Combo
                value={l.mode}
                onChange={(e) => save(l, { mode: e.target.value })}
                style={{ minWidth: 150 }}
              >
                <option value="required">Required approver</option>
                <option value="visibility">Visibility only</option>
              </Combo>
            )}
            {canConfigure && (
              <button className="btn btn-sm" onClick={() => { const v = prompt(`Hours before ${l.label} is overdue (blank for none)`, l.slaHours ?? ''); if (v !== null) save(l, { slaHours: v === '' ? null : Number(v) }); }}>Due</button>
            )}
            {canConfigure && <button className="btn btn-sm" onClick={() => save(l, { active: !l.active })}>{l.active ? 'Remove from chain' : 'Add to chain'}</button>}
          </span>
        </AssignRow>
      ))}
    </Panel>
  );
}

function capLabel(t) {
  return t.unit === 'unpaid' ? 'Unpaid' : `${t.cap}/${t.unit}`;
}

// The prototype's Apply Leave modal (openApplyLeaveModal, line 3908).
function ApplyLeaveModal({ types, employees, isHR, canOverride, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', type: types[0]?.name || '', dayMode: 'full', halfDay: 'First Half', days: 1, fromDate: '', toDate: '', reason: '' });
  const [error, setError] = useState('');
  const [avail, setAvail] = useState(null);
  const [override, setOverride] = useState(false);
  const half = form.dayMode === 'half';

  // What is available right now (balance on record minus pending) — the same
  // figure the server validates against.
  useEffect(() => {
    if (isHR && !form.employeeId) { setAvail(null); return; }
    api.get('/leave/availability', { params: { employeeId: isHR ? form.employeeId : undefined } })
      .then((r) => setAvail(r.data.types || [])).catch(() => setAvail(null));
  }, [isHR, form.employeeId]);
  const a = (avail || []).find((t) => t.type === form.type);
  const span = form.fromDate && form.toDate ? Math.max(1, Math.round((new Date(form.toDate) - new Date(form.fromDate)) / 86400000) + 1) : null;
  const days = half ? 0.5 : Number(form.days) || 0;
  const over = !!(a && a.limited && days > a.available);

  async function submit() {
    setError('');
    if (!form.fromDate || (!half && !form.toDate)) { setError(half ? 'Choose the date.' : 'From and To dates are required.'); return; }
    if (!half && form.toDate < form.fromDate) { setError('To date cannot be before From date.'); return; }
    if (!half && (days <= 0 || (span && days > span))) { setError(`Days must be between 0.5 and ${span || 1}.`); return; }
    if (over && !(canOverride && override)) { setError(`Not enough ${form.type} balance: ${a.available} day(s) available, ${days} requested.`); return; }
    try {
      await api.post('/leave', {
        employeeId: isHR ? form.employeeId : undefined,
        type: form.type,
        fromDate: form.fromDate,
        toDate: half ? form.fromDate : form.toDate,
        days,
        halfDay: half ? form.halfDay : undefined,
        reason: form.reason,
        overrideBalance: canOverride && override ? true : undefined,
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
          <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
            <option value="">Select employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Combo>
        </div>
      )}
      <div className="field">
        <label>Type</label>
        <Combo value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {types.map((t) => <option key={t.id}>{t.name}</option>)}
        </Combo>
        {a && (
          <div className={`lvx-avail${over ? ' bad' : ''}`}>
            {a.limited
              ? <>Available: <b>{a.available}</b> day(s) — {a.remaining} left of {a.total}{a.pending ? `, ${a.pending} pending` : ''}.</>
              : <>No entitlement limit on {a.type}{a.pending ? ` · ${a.pending} day(s) pending` : ''}.</>}
          </div>
        )}
      </div>
      {/* FULL DAY / HALF DAY */}
      <div className="lvx-halfday">
        <label><input type="radio" name="dayMode" checked={!half} onChange={() => setForm({ ...form, dayMode: 'full' })} /> Full day</label>
        <label><input type="radio" name="dayMode" checked={half} onChange={() => setForm({ ...form, dayMode: 'half' })} /> Half day</label>
        {half && (
          <Combo value={form.halfDay} onChange={(e) => setForm({ ...form, halfDay: e.target.value })} style={{ minWidth: 140 }}>
            <option>First Half</option>
            <option>Second Half</option>
          </Combo>
        )}
      </div>
      <div className="grid-2">
        <div className="field"><label>{half ? 'Date' : 'From'}</label><input type="date" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value, toDate: form.toDate && form.toDate >= e.target.value ? form.toDate : e.target.value, days: form.toDate && form.toDate >= e.target.value ? form.days : 1 })} /></div>
        {!half && <div className="field"><label>To</label><input type="date" value={form.toDate} min={form.fromDate || undefined} onChange={(e) => { const to = e.target.value; const n = form.fromDate && to ? Math.max(1, Math.round((new Date(to) - new Date(form.fromDate)) / 86400000) + 1) : 1; setForm({ ...form, toDate: to, days: n }); }} /></div>}
        {!half && <div className="field"><label>Days</label><input type="number" min="0.5" step="0.5" max={span || undefined} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></div>}
        {half && <div className="field"><label>Days</label><input value="0.5" disabled /></div>}
      </div>
      <div className="field"><label>Reason</label><textarea rows="2" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
      {over && canOverride && (
        <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={override} onChange={(e) => setOverride(e.target.checked)} /> Apply beyond the balance (HR override)
        </label>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// ONE FILTER BAR FOR EVERY LEAVE TAB. Employee ID, name, department, leave
// type, a date range (a request matches when its dates overlap the range) and
// status — all working together over whatever the server already scoped.
const LEAVE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancellation Requested', 'Cancelled'];
const EMPTY_LEAVE_FILTERS = { code: '', name: '', department: '', empStatus: '', type: '', from: '', to: '', status: '' };

// hrms-24 §3 — the filter bar, as the server-side export's query. The export
// runs the Leave list's own scoped query with these narrowing it, so the file
// holds exactly the matching rows (routes/insights.js).
function leaveExportParams(f) {
  return {
    code: f.code, name: f.name, department: f.department, empStatus: f.empStatus,
    type: f.type, status: f.status, leaveFrom: f.from, leaveTo: f.to,
  };
}

function leaveMatches(r, f, { skipRequestFields = false } = {}) {
  const e = r.employee || r;
  if (f.code && !String(e.employeeCode || '').toLowerCase().includes(f.code.trim().toLowerCase())) return false;
  if (f.name && !String(e.name || '').toLowerCase().includes(f.name.trim().toLowerCase())) return false;
  if (f.department && e.department !== f.department) return false;
  // The person's HRMS status — Active, Inactive, Notice Period, Suspended, Exit.
  if (f.empStatus && hrStatusOf(e.employmentStatus) !== f.empStatus) return false;
  if (skipRequestFields) return true;
  if (f.type && r.type !== f.type) return false;
  if (f.status && r.status !== f.status) return false;
  const start = r.fromDate || '';
  const end = r.toDate || r.fromDate || '';
  if (f.from && end && end < f.from) return false;
  if (f.to && start && start > f.to) return false;
  return true;
}

function LeaveFilterBar({ filters, setFilters, departments, types, children, requestFields = true }) {
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const on = Object.values(filters).some(Boolean);
  return (
    <div className="filter-row" style={{ marginTop: 14, marginBottom: 12 }}>
      <input placeholder="Employee ID" value={filters.code} onChange={(e) => set('code', e.target.value)} />
      <input placeholder="Employee name" value={filters.name} onChange={(e) => set('name', e.target.value)} />
      <Combo value={filters.department} onChange={(e) => set('department', e.target.value)}>
        <option value="">All departments</option>
        {departments.map((d) => <option key={d}>{d}</option>)}
      </Combo>
      <Combo value={filters.empStatus} onChange={(e) => set('empStatus', e.target.value)}>
        <option value="">All employee statuses</option>
        {HR_STATUSES.map((s) => <option key={s}>{s}</option>)}
      </Combo>
      {requestFields && (
        <>
          <Combo value={filters.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">All leave types</option>
            {types.map((t) => <option key={t.id || t.name} value={t.name}>{t.code ? `${t.name} (${t.code})` : t.name}</option>)}
          </Combo>
          <input type="date" aria-label="From" title="From" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          <input type="date" aria-label="To" title="To" value={filters.to} onChange={(e) => set('to', e.target.value)} />
          <Combo value={filters.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {LEAVE_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </Combo>
        </>
      )}
      {on && <button className="btn btn-sm" onClick={() => setFilters(EMPTY_LEAVE_FILTERS)}>Clear</button>}
      {children}
    </div>
  );
}

function DashboardTab({ user, isHR, canEditPolicy, canApprove, canConfigure, reloadKey, onReload }) {
  const [chainFor, setChainFor] = useState(null);
  const [requests, setRequests] = useState([]);
  const [types, setTypes] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [caps, setCaps] = useState(null);
  const [onLeave, setOnLeave] = useState(null);
  const [filters, setFilters] = useState(EMPTY_LEAVE_FILTERS);
  const [error, setError] = useState('');

  function load() {
    api.get('/leave').then((res) => setRequests(res.data));
    api.get('/leave/types').then((res) => setTypes(res.data));
    api.get('/leave/reasons').then((res) => setReasons(res.data));
    api.get('/leave/concurrency-policy').then((res) => setCaps(res.data));
    if (isHR) api.get('/leave/on-leave-today').then((res) => setOnLeave(res.data)).catch(() => setOnLeave(null));
  }
  useEffect(load, [isHR, reloadKey]);

  const [policyMsg, setPolicyMsg] = useState('');
  async function saveSandwich(on) {
    setPolicyMsg('');
    try {
      const res = await api.put('/leave/sandwich-policy', { sandwichLeave: on });
      setCaps((c) => ({ ...c, sandwichLeave: res.data.sandwichLeave }));
      setPolicyMsg(`Saved. Holidays between leave days are ${res.data.sandwichLeave ? 'now counted as leave' : 'no longer counted as leave'}.`);
    } catch (e) { setPolicyMsg(e.response?.data?.error || 'Could not save. Try again.'); }
  }

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

  const scoped = requests.filter((r) => leaveMatches(r, filters));
  const pending = scoped.filter((r) => r.status === 'Pending');
  const departments = [...new Set(requests.map((r) => r.employee?.department).filter(Boolean))].sort();

  return (
    <div>
      {/* hrms-24 §1 / §9 — From → To → Apply, and the tiles and charts
          (by type, by status, department-wise) for requests overlapping it,
          counted on the server in this login's scope. */}
      {/* ONE KPI row, from the range: requests, pending, approved,
          rejected, cancelled, cancellation requests, approved days and who
          is on leave today. Filters → tiles → charts, then the lists below
          with their own filter bar. */}
      <InsightsPanel module="leave" storageKey="tl_range_leave" />

      <LeaveFilterBar filters={filters} setFilters={setFilters} departments={departments} types={types}>
        <span className="small-muted" style={{ alignSelf: 'center' }}>{scoped.length} of {requests.length}</span>
        <span style={{ marginLeft: 'auto' }}>
          <ExportMenu url="/insights/leave/export" params={leaveExportParams(filters)} note="The requests matching these filters" />
        </span>
      </LeaveFilterBar>

      {error && <div className="error-text">{error}</div>}

      <TwoCol>
        {/* ① Approval chain — WHERE EACH REQUEST CURRENTLY SITS */}
        <Panel>
          <PanelHead title="① Leave Approval Chain" />
          <div style={{ padding: '8px 18px 4px' }} className="cell-muted">
            Employee → TL → STL → HR → Assistant Manager → Manager → Super Admin.
            Open a request to see the full chain, who has acted and what it is waiting on.
          </div>
          {pending.length === 0
            ? <EmptyMini>No pending requests.</EmptyMini>
            : pending.slice(0, 8).map((r) => {
              const wf = r.workflow;
              // ACTING IS THE CURRENT OWNER'S ALONE. The matrix half comes
              // from the engine (canApprove); the ownership half is the
              // resolved owner of the step the request is actually on. A
              // Manager made view-only in Role Catalog fails the first half
              // and simply has no buttons. Either way the API is what
              // refuses — out-of-turn is answered 403, not merely hidden.
              const isOwner = !!wf && wf.currentOwnerUserId === user?.id;
              // A Super Admin may decide directly from any step — recorded as
              // a Direct Super Admin Approval, never as somebody else's turn.
              const isSA = user?.role === 'SUPER_ADMIN' || user?.hrmsRole === 'SUPER_ADMIN';
              const mayDecide = canApprove && (isOwner || isSA);
              const direct = mayDecide && !isOwner;
              return (
                <AssignRow key={r.id}>
                  <span>
                    {r.employee?.name || 'You'}<br />
                    <span className="cell-muted" style={{ fontSize: 11.5 }}>
                      {r.type} · {r.fromDate}{r.toDate && r.toDate !== r.fromDate ? ` → ${r.toDate}` : ''}
                    </span>
                    {wf && wf.currentLabel && (
                      <div style={{ fontSize: 11.5, marginTop: 3 }}>
                        <b>Current Approval: {wf.currentLabel}</b>
                        {wf.currentOwnerName ? <span className="cell-muted"> – {wf.currentOwnerName}</span> : null}
                        {wf.nextLabel && <span className="cell-muted"> · next {wf.nextLabel}</span>}
                        {wf.overdue && <> <span className="status overdue">Overdue</span></>}
                      </div>
                    )}
                    {wf && <ApprovalChainLine workflow={wf} compact />}
                    {!wf && <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 3 }}>No approval chain — decided in one step.</div>}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => setChainFor(r.id)}>Chain</button>
                    {/* Approve / Reject / Reassign open the request: the reason,
                        the employee's comments, the TL rule and the reassign
                        picker are all there. */}
                    {mayDecide && <button className="btn btn-sm btn-primary" title={direct ? 'Direct Super Admin decision — skips the levels still waiting' : 'Approve, reject or reassign'} onClick={() => setChainFor(r.id)}>{direct ? 'Decide directly' : 'Decide'}</button>}
                  </span>
                </AssignRow>
              );
            })}
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
              {/* HRMS item 6 — the sandwich rule. */}
              <AssignRow>
                <span>
                  <b>Holiday between two leave days</b><br />
                  <span className="cell-muted" style={{ fontSize: 11.5 }}>
                    {caps.sandwichLeave
                      ? 'Counted as leave. Example: leave on Friday and Monday — Saturday and Sunday are leave too.'
                      : 'Not counted. A holiday or weekly off stays a day off, even between two leave days.'}
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`status ${caps.sandwichLeave ? 'active' : 'hold'}`}>{caps.sandwichLeave ? 'On' : 'Off'}</span>
                  {canConfigure && <button className="btn btn-sm" onClick={() => saveSandwich(!caps.sandwichLeave)}>{caps.sandwichLeave ? 'Turn off' : 'Turn on'}</button>}
                </span>
              </AssignRow>
              {policyMsg && <div className="small-muted" style={{ padding: '4px 18px 8px' }}>{policyMsg}</div>}
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

      <ApprovalLevelsPanel canConfigure={canEditPolicy} />

      <TlRuleSetting canConfigure={canConfigure} />

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="All leave requests" />
        {/* Team, designation, who approved / decided it and the employee's
            comments — the full list is on the Requests tab. */}
        <LeaveRequestsTable
          requests={scoped}
          onOpen={setChainFor}
          limit={10}
          renderActions={(r) => (
            <>
              {/* Confirming a cancellation is a DECISION, so it needs the
                  approve permission. */}
              {canApprove && r.status === 'Cancellation Requested' && <button className="btn btn-sm" onClick={() => decide(r, 'Cancelled')}>Confirm Cancel</button>}
              {!isHR && r.status === 'Approved' && <button className="btn btn-sm" onClick={() => requestCancel(r.id)}>Request Cancellation</button>}
            </>
          )}
        />
      </Panel>

      {chainFor && (
        <ApprovalWorkflowModal
          requestId={chainFor}
          onClose={() => setChainFor(null)}
          onActed={onReload}
        />
      )}
    </div>
  );
}

// REQUESTS — every request this login may see (HR / TL / Manager: their scope;
// an employee: their own), with Team, Designation, who approved / decided it
// and the employee's comments. Open → the request, its chain and Approve ·
// Reject · Reassign.
function RequestsTab({ isHR, canApprove, reloadKey, onReload }) {
  const [requests, setRequests] = useState([]);
  const [types, setTypes] = useState([]);
  const [filters, setFilters] = useState(EMPTY_LEAVE_FILTERS);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/leave').then((res) => setRequests(res.data)).catch((e) => setError(e.response?.data?.error || 'Could not load leave requests'));
    api.get('/leave/types').then((res) => setTypes(res.data)).catch(() => setTypes([]));
  }, [reloadKey]);
  const scoped = requests.filter((r) => leaveMatches(r, filters));
  const departments = [...new Set(requests.map((r) => r.employee?.department).filter(Boolean))].sort();
  async function confirmCancel(r) {
    setError('');
    try { await api.patch('/leave/' + r.id + '/decision', { status: 'Cancelled' }); onReload(); } catch (e) { setError(e.response?.data?.error || 'Could not cancel'); }
  }
  async function requestCancel(id) { await api.patch('/leave/' + id + '/cancel-request'); onReload(); }
  return (
    <div>
      <LeaveFilterBar filters={filters} setFilters={setFilters} departments={departments} types={types}>
        <span className="small-muted" style={{ alignSelf: 'center' }}>{scoped.length} of {requests.length}</span>
        <span style={{ marginLeft: 'auto' }}>
          {/* Export all (these filters) · Export one employee · Import leave
              history with the compulsory sample (backend src/io/leaveHistory.js).
              The export's columns ARE the import sample's. */}
          <DataIoBar ioKey="leave-history" exportUrl="/insights/leave/export" params={leaveExportParams(filters)} onImported={onReload} />
        </span>
      </LeaveFilterBar>
      {error && <div className="error-text">{error}</div>}
      <Panel>
        <PanelHead title="Leave requests" />
        {/* HRMS item 23: the list scrolls inside its card (header stays put). */}
        <div className="lvk-scroll">
        <LeaveRequestsTable
          requests={scoped}
          onOpen={setOpenId}
          renderActions={(r) => (
            <>
              {canApprove && r.status === 'Cancellation Requested' && <button className="btn btn-sm" onClick={() => confirmCancel(r)}>Confirm Cancel</button>}
              {!isHR && r.status === 'Approved' && <button className="btn btn-sm" onClick={() => requestCancel(r.id)}>Request Cancellation</button>}
            </>
          )}
        />
        </div>
      </Panel>
      {openId && <ApprovalWorkflowModal requestId={openId} onClose={() => setOpenId(null)} onActed={onReload} />}
    </div>
  );
}

// Reports: the filterable request log plus the remaining/total balance grid.
// ---------------------------------------------------------------------------
// REPORTS — LAYOUT FIXED BY THE USER (2026-09-29). Keep, in this order:
//   1. "Leave Requests Report" card: Export ▾ in the head; filter grid
//      Employee ID · Employee name · All departments · All employee statuses ·
//      All leave types · from · to · All statuses · All roles · "N of M";
//      then the request table.
//   2. "Month-wise Leave Report" (search · leave type · year · Export Excel;
//      CODE · EMPLOYEE · TEAM · DESIGNATION · TYPE · CREDITED · JAN…DEC ·
//      TAKEN · PENDING · CLOSING).
//   3. "Leave Balances" grid.
// Do not restructure or swap these for a shared filter component.
// ---------------------------------------------------------------------------
function ReportsTab({ reloadKey, canExport }) {
  const [requests, setRequests] = useState([]);
  const [reqState, setReqState] = useState('loading'); // loading | ok | error
  const [retryTick, setRetryTick] = useState(0);
  const [balances, setBalances] = useState(null);
  const [filters, setFilters] = useState(EMPTY_LEAVE_FILTERS);
  const [role, setRole] = useState('');
  const [roles, setRoles] = useState([]);
  const [types, setTypes] = useState([]);
  const [balanceTick, setBalanceTick] = useState(0); // a balance import re-reads the grid

  useEffect(() => {
    api.get('/leave/balances').then((res) => setBalances(res.data));
  }, [reloadKey, balanceTick]);

  useEffect(() => {
    let alive = true;
    setReqState('loading');
    // One quiet retry: a read that lands while the API is restarting must not
    // leave the report empty.
    const read = (attempt) => api.get('/leave')
      .then((res) => { if (alive) { setRequests(Array.isArray(res.data) ? res.data : []); setReqState('ok'); } })
      .catch(() => { if (!alive) return; if (attempt === 0) setTimeout(() => read(1), 1500); else setReqState('error'); });
    read(0);
    api.get('/leave/types').then((res) => setTypes(res.data)).catch(() => setTypes([]));
    api.get('/employees')
      .then((res) => setRoles([...new Set(res.data.map((e) => e.designation).filter(Boolean))].sort()))
      .catch(() => setRoles([]));
    return () => { alive = false; };
  }, [reloadKey, retryTick]);

  const scoped = requests.filter((r) => leaveMatches(r, filters) && (!role || r.employee?.designation === role));
  // The balance grid is per person, so only the person filters apply to it.
  const balanceRows = (balances?.rows || []).filter((r) => leaveMatches(r, filters, { skipRequestFields: true }));
  const departments = [...new Set([
    ...requests.map((r) => r.employee?.department),
    ...(balances?.rows || []).map((r) => r.department),
  ].filter(Boolean))].sort();

  return (
    <div>
      {/* HRMS item 23: a quick summary of the requests the filters below pick. */}
      {reqState === 'ok' && <LeaveKpiCards requests={scoped} />}
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Leave Requests Report">
          <ExportMenu url="/insights/leave/export" params={{ ...leaveExportParams(filters), role }} note="The requests matching these filters" />
        </PanelHead>
        <div style={{ padding: '0 18px' }}>
          <LeaveFilterBar filters={filters} setFilters={setFilters} departments={departments} types={types}>
            <Combo value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </Combo>
            <span className="cell-muted" style={{ fontSize: 12, alignSelf: 'center' }}>{reqState === 'loading' ? 'Loading…' : `${scoped.length} of ${requests.length}`}</span>
          </LeaveFilterBar>
        </div>
        {reqState === 'error' && (
          <div className="error-text" style={{ margin: '0 18px 10px' }}>
            Could not load the leave requests. <button className="btn btn-sm" onClick={() => setRetryTick((t) => t + 1)}>Retry</button>
          </div>
        )}
        {reqState === 'loading' ? <EmptyMini>Loading leave requests…</EmptyMini> : <LeaveRequestsTable requests={scoped} />}
      </Panel>

      {/* MONTH-WISE — taken per month for everyone in scope, with export. */}
      <MonthlyReport canExport={canExport} />

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title={<>Leave Balances <span className="cell-muted" style={{ fontSize: 12 }}>(remaining / total — paused leave types are hidden)</span></>}>
          {/* Balances: export everyone in scope / one employee, import with the
              compulsory sample (backend src/io/leaveBalances.js). */}
          <DataIoBar ioKey="leave-balances" params={{ type: filters.type }} onImported={() => setBalanceTick((t) => t + 1)} />
        </PanelHead>
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

export default function Leave() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const canEditPolicy = isAdmin(user);
  // READ FROM THE ENGINE, NEVER FROM A ROLE NAME. A Manager or Assistant
  // Manager made view-only in Role Catalog loses `approve` on Leave &
  // Holidays and therefore loses the buttons — and gets them back the moment
  // the catalog grants it, with no code change here.
  const canApprove = can(user, 'hrms', 'hrms', 'Leave & Holidays', 'approve');
  // Same rule for the holidays desk: the API guards POST /leave/holidays with
  // the CREATE action, so the tab asks the engine that same question. isAdmin()
  // was too narrow — HR holds HRMS edit rights and the API already lets HR in.
  const canManageHolidays = can(user, 'hrms', 'hrms', 'Leave & Holidays', 'create');
  // HR leave settings (TL approval rule), the balance override and export.
  const canConfigure = can(user, 'hrms', 'hrms', 'Leave & Holidays', 'configure');
  // Edit / delete a holiday: the API guards both with `edit` (HR / Admin / SA).
  const canEditHolidays = can(user, 'hrms', 'hrms', 'Leave & Holidays', 'edit');
  const canExport = can(user, 'hrms', 'hrms', 'Leave & Holidays', 'export');
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
          { key: 'dashboard', label: 'Dashboard', element: <DashboardTab user={user} isHR={isHR} canEditPolicy={canEditPolicy} canApprove={canApprove} canConfigure={canConfigure} reloadKey={reloadKey} onReload={() => setReloadKey((k) => k + 1)} /> },
          { key: 'requests', label: 'Requests', element: <RequestsTab isHR={isHR} canApprove={canApprove} reloadKey={reloadKey} onReload={() => setReloadKey((k) => k + 1)} /> },
          { key: 'monthly', label: 'Month-wise Balance', element: <LeaveBalancesTab canExport={canExport} /> },
          { key: 'reports', label: 'Reports', element: <ReportsTab reloadKey={reloadKey} canExport={canExport} /> },
          // Managing holidays is a WRITE, so it follows the create permission
          // and not a role name — HR manages holidays, a view-only Manager does not.
          { key: 'holidays', label: 'Holidays', element: <HolidayCalendar canManage={canManageHolidays} canEdit={canEditHolidays} canExport={canExport} /> },
        ]}
      />
      {applyOpen && (
        <ApplyLeaveModal
          types={types}
          employees={employees}
          isHR={isHR}
          canOverride={canConfigure}
          onClose={() => setApplyOpen(false)}
          onSaved={() => { setApplyOpen(false); setReloadKey((k) => k + 1); }}
        />
      )}
    </>
  );
}
