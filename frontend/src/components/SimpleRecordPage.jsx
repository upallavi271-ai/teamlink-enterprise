import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin } from '../permissions';


// Generic list + create + (optional) status-decision page for the EmployeeRecord-backed
// HRMS areas (KT, Targets, Resignation, Recognition, Disciplinary, Shift Roster, Timesheet,
// Assets, Expenses, Helpdesk, Access Requests, Weekly Ideas) — one component, ~12 configs.
export default function SimpleRecordPage({
  title,
  apiPath,
  titleLabel = 'Title',
  detailLabel = 'Detail',
  showDate = false,
  dateLabel = 'Date',
  showAmount = false,
  amountLabel = 'Amount (₹)',
  showHours = false,
  showCategory = false,
  categoryLabel = 'Category',
  categoryOptions = [],
  showPriority = false,
  showLocation = false,
  showProgress = false,
  statuses = ['Open', 'In Progress', 'Resolved'],
  decisions = null, // e.g. ['Approved', 'Rejected'] to show decision buttons for HR roles
  createByHrOnly = false, // when true, only HR roles see the create form (e.g. assigning goals/assets)
}) {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const emptyForm = { employeeId: '', title: '', detail: '', date: '', amount: '', hours: '', category: '', priority: 'Medium', location: '', progressPct: 0 };
  const [form, setForm] = useState(emptyForm);

  function load() {
    api.get(apiPath).then((res) => setRecords(res.data));
    if (createByHrOnly && isHR) api.get('/employees').then((res) => setEmployees(res.data));
  }
  useEffect(load, [apiPath]);

  async function submit(e) {
    e.preventDefault();
    const payload = { title: form.title, detail: form.detail };
    if (createByHrOnly) payload.employeeId = form.employeeId;
    if (showDate) payload.date = form.date;
    if (showAmount) payload.amount = form.amount;
    if (showHours) payload.hours = form.hours;
    if (showCategory) payload.category = form.category;
    if (showPriority) payload.priority = form.priority;
    if (showLocation) payload.location = form.location;
    if (showProgress) payload.progressPct = form.progressPct;
    await api.post(apiPath, payload);
    setForm(emptyForm);
    load();
  }

  async function decide(id, status) {
    await api.patch(`${apiPath}/${id}/status`, { status });
    load();
  }

  async function updateProgress(id, current) {
    const v = prompt('Progress (%)', current ?? 0);
    if (v === null) return;
    await api.patch(`${apiPath}/${id}`, { progressPct: Number(v) || 0 });
    load();
  }

  const canCreate = !createByHrOnly || isHR;

  return (
    <div>
      <div className="page-head"><h1>{title}</h1></div>

      {canCreate && (
        <form className="card section" onSubmit={submit}>
          <div className="grid-2">
            {createByHrOnly && (
              <label className="field">
                <span>Employee</span>
                <select required value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                  <option value="">Select employee</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </label>
            )}
            <label className="field"><span>{titleLabel}</span><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field"><span>{detailLabel}</span><input value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></label>
            {showCategory && (
              <label className="field">
                <span>{categoryLabel}</span>
                {categoryOptions.length > 0 ? (
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="">Select</option>
                    {categoryOptions.map((c) => <option key={c}>{c}</option>)}
                  </select>
                ) : (
                  <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                )}
              </label>
            )}
            {showPriority && (
              <label className="field">
                <span>Priority</span>
                <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  <option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
                </select>
              </label>
            )}
            {showLocation && <label className="field"><span>Location</span><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>}
            {showDate && <label className="field"><span>{dateLabel}</span><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>}
            {showAmount && <label className="field"><span>{amountLabel}</span><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>}
            {showHours && <label className="field"><span>Hours</span><input type="number" step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>}
            {showProgress && <label className="field"><span>Progress (%)</span><input type="number" min="0" max="100" value={form.progressPct} onChange={(e) => setForm({ ...form, progressPct: e.target.value })} /></label>}
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Submit</button>
        </form>
      )}

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              {isHR && <th>Employee</th>}
              <th>{titleLabel}</th>
              <th>{detailLabel}</th>
              {showCategory && <th>{categoryLabel}</th>}
              {showPriority && <th>Priority</th>}
              {showLocation && <th>Location</th>}
              {showDate && <th>{dateLabel}</th>}
              {showAmount && <th>Amount</th>}
              {showHours && <th>Hours</th>}
              {showProgress && <th>Progress</th>}
              <th>Status</th>
              {isHR && decisions && <th></th>}
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                {isHR && <td>{r.employee?.name}</td>}
                <td>{r.title}</td>
                <td>{r.detail || '—'}</td>
                {showCategory && <td>{r.category || '—'}</td>}
                {showPriority && <td>{r.priority ? <span className={`status ${r.priority === 'Urgent' || r.priority === 'High' ? 'priority-high' : r.priority === 'Medium' ? 'priority-medium' : 'priority-low'}`}>{r.priority}</span> : '—'}</td>}
                {showLocation && <td>{r.location || '—'}</td>}
                {showDate && <td>{r.date || '—'}</td>}
                {showAmount && <td>{r.amount != null ? `₹${r.amount.toLocaleString('en-IN')}` : '—'}</td>}
                {showHours && <td>{r.hours ?? '—'}</td>}
                {showProgress && (
                  <td>
                    <span style={{ cursor: 'pointer' }} onClick={() => updateProgress(r.id, r.progressPct)}>{r.progressPct ?? 0}%</span>
                  </td>
                )}
                <td><span className="status">{r.status}</span></td>
                {isHR && decisions && (
                  <td>
                    {decisions.map((d) => (
                      <button key={d} className="btn btn-sm" style={{ marginRight: 6 }} onClick={() => decide(r.id, d)}>{d}</button>
                    ))}
                  </td>
                )}
              </tr>
            ))}
            {records.length === 0 && (
              <tr><td colSpan="12" className="small-muted">No records yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
