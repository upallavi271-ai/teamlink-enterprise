import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin } from '../permissions';
import Combo from './Combo.jsx';


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
  // When true the record can carry a real uploaded bill/receipt: the file is
  // POSTed as multipart to `${apiPath}/:id/bill` and stored on the server
  // OUTSIDE the repository (backend/src/utils/attachments.js). Every other
  // "document" in this app is still a filename typed into a box; this is the
  // first screen that stores bytes, and it is meant to be the pattern the
  // others adopt.
  showAttachment = false,
  attachmentLabel = 'Bill / Receipt',
}) {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const emptyForm = { employeeId: '', title: '', detail: '', date: '', amount: '', hours: '', category: '', priority: 'Medium', location: '', progressPct: 0 };
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // resets the <input type="file">
  const [error, setError] = useState('');

  function load() {
    api.get(apiPath).then((res) => setRecords(res.data));
    if (createByHrOnly && isHR) api.get('/employees').then((res) => setEmployees(res.data));
  }
  useEffect(load, [apiPath]);

  // Mirrors the server's limits so the common mistakes are caught before a
  // 5MB upload crosses the wire. The server enforces them regardless.
  const MAX_BILL_BYTES = 5 * 1024 * 1024;
  const BILL_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

  async function uploadBill(recordId, chosen) {
    const body = new FormData();
    body.append('file', chosen);
    // No explicit Content-Type: the browser has to set the multipart boundary.
    await api.post(`${apiPath}/${recordId}/bill`, body);
  }

  // Fetch the bill through the API (the download route is authenticated and
  // scope-checked) and hand the bytes to the browser as a save.
  async function downloadBill(r) {
    setError('');
    try {
      const res = await api.get(`${apiPath}/${r.id}/bill`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.billName || 'bill';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download that file.');
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const payload = { title: form.title, detail: form.detail };
    if (createByHrOnly) payload.employeeId = form.employeeId;
    if (showDate) payload.date = form.date;
    if (showAmount) payload.amount = form.amount;
    if (showHours) payload.hours = form.hours;
    if (showCategory) payload.category = form.category;
    if (showPriority) payload.priority = form.priority;
    if (showLocation) payload.location = form.location;
    if (showProgress) payload.progressPct = form.progressPct;
    if (showAttachment && file) {
      if (file.size > MAX_BILL_BYTES) { setError('That file is larger than 5MB.'); return; }
      if (!BILL_TYPES.includes(file.type)) { setError('Only PNG, JPEG, WebP images and PDF files can be attached.'); return; }
    }
    let created;
    try {
      created = (await api.post(apiPath, payload)).data;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that record.');
      return;
    }
    if (showAttachment && file) {
      try {
        await uploadBill(created.id, file);
      } catch (err) {
        // The claim saved; only the file failed. Say which, rather than
        // leaving the user guessing why the row has no bill on it.
        setError(`${err.response?.data?.error || 'The file could not be uploaded.'} The claim was saved without it.`);
      }
    }
    setForm(emptyForm);
    setFile(null);
    setFileKey((k) => k + 1);
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
                <Combo required value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                  <option value="">Select employee</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Combo>
              </label>
            )}
            <label className="field"><span>{titleLabel}</span><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field"><span>{detailLabel}</span><input value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></label>
            {showCategory && (
              <label className="field">
                <span>{categoryLabel}</span>
                {categoryOptions.length > 0 ? (
                  <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="">Select</option>
                    {categoryOptions.map((c) => <option key={c}>{c}</option>)}
                  </Combo>
                ) : (
                  <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                )}
              </label>
            )}
            {showPriority && (
              <label className="field">
                <span>Priority</span>
                <Combo value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  <option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
                </Combo>
              </label>
            )}
            {showLocation && <label className="field"><span>Location</span><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>}
            {showDate && <label className="field"><span>{dateLabel}</span><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>}
            {showAmount && <label className="field"><span>{amountLabel}</span><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>}
            {showHours && <label className="field"><span>Hours</span><input type="number" step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>}
            {showProgress && <label className="field"><span>Progress (%)</span><input type="number" min="0" max="100" value={form.progressPct} onChange={(e) => setForm({ ...form, progressPct: e.target.value })} /></label>}
            {showAttachment && (
              <label className="field">
                <span>{attachmentLabel}</span>
                <input
                  key={fileKey}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
            )}
          </div>
          {showAttachment && (
            <div className="small-muted" style={{ marginBottom: 8 }}>
              PNG, JPEG, WebP or PDF, up to 5MB. The file is stored on the server and only people who can see this claim can download it.
            </div>
          )}
          {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
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
              {showAttachment && <th>{attachmentLabel}</th>}
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
                {showAttachment && (
                  <td>
                    {r.billFile ? (
                      <button type="button" className="link-btn" onClick={() => downloadBill(r)}>
                        {r.billName || 'Download'}
                        <span className="small-muted"> ({Math.max(1, Math.round((r.billSize || 0) / 1024))} KB)</span>
                      </button>
                    ) : <span className="small-muted">—</span>}
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
