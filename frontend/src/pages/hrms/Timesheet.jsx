import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';

// Timesheet — "Track and assign work".
//
// My Tasks, the New Task modal, per-task comments and the Task Reports
// roll-up. Everything on this screen is backed by /api/tasks; nothing here is
// a placeholder.
//
// ASSIGN TO IS NOT A PLAIN PEOPLE LIST. The options endpoint runs the request
// through the permission engine and utils/scope.js and returns only the people
// this login may hand work to — a recruiter gets themselves, a TL gets their
// team. The select renders what the server returned and nothing else; the API
// refuses anyone else regardless of what the browser sends.

const SUBTITLE = 'Track and assign work across your team — create a task, assign it, and follow it to done.';

// YYYY-MM-DD (the wire format and what <input type="date"> carries) rendered
// dd-mm-yyyy, the way the rest of this screen's date boxes read.
function ddmmyyyy(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).split('-');
  return y && m && d ? `${d}-${m}-${y}` : value;
}

function emptyForm(options) {
  return {
    id: null,
    department: '',
    name: '',
    description: '',
    subTaskName: '',
    assigneeId: '',
    status: '',
    startDate: (options && options.today) || new Date().toISOString().slice(0, 10),
    endDate: '',
    dependent: false,
    dependsOnId: '',
  };
}

function statusClass(status) {
  if (status === 'Completed') return 'approved';
  if (status === 'In Progress') return 'interview';
  if (status === 'On Hold') return 'hold';
  if (status === 'Cancelled') return 'rejected';
  return 'new';
}

// The prototype has no segmented control, so the No / Yes toggle is built from
// two of its own buttons — the selected one carries .btn-primary.
function YesNo({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex' }}>
      <button
        type="button"
        className={`btn btn-sm${value ? '' : ' btn-primary'}`}
        style={{ borderRadius: '8px 0 0 8px' }}
        onClick={() => onChange(false)}
      >
        No
      </button>
      <button
        type="button"
        className={`btn btn-sm${value ? ' btn-primary' : ''}`}
        style={{ borderRadius: '0 8px 8px 0', marginLeft: -1 }}
        onClick={() => onChange(true)}
      >
        Yes
      </button>
    </div>
  );
}

export default function Timesheet({ standalone = false }) {
  const [options, setOptions] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [filters, setFilters] = useState({ department: '', from: '', to: '' });
  const [form, setForm] = useState(null); // the New Task / Edit Task modal
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [comments, setComments] = useState(null); // { task, rows, draft }
  const [reports, setReports] = useState(null);
  const [loading, setLoading] = useState(true);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const load = useCallback(() => {
    const params = {};
    if (filters.department) params.department = filters.department;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    setLoading(true);
    api.get('/tasks', { params })
      .then((res) => setTasks(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load tasks.'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    api.get('/tasks/options')
      .then((res) => setOptions(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the task options.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const people = options?.assignable || [];
  const canAssignOthers = !!options?.canAssignOthers;
  const nameOf = useMemo(() => {
    const map = {};
    people.forEach((p) => { map[p.userId] = p.name; });
    return map;
  }, [people]);

  function openNew() {
    setError(''); setNotice('');
    const f = emptyForm(options);
    // The department defaults to the one this login works in when there is
    // only one it can pick.
    if (options && options.departments.length === 1) f.department = options.departments[0];
    setForm(f);
  }

  function openEdit(task) {
    setError(''); setNotice('');
    setForm({
      id: task.id,
      department: task.department || '',
      name: task.name,
      description: task.description || '',
      subTaskName: task.subTaskName || '',
      assigneeId: task.assigneeId,
      status: task.status,
      startDate: task.startDate || '',
      endDate: task.endDate || '',
      dependent: !!task.dependent,
      dependsOnId: task.dependsOnId || '',
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError(''); setSaving(true);
    const body = {
      department: form.department,
      name: form.name,
      description: form.description,
      subTaskName: form.subTaskName,
      // Blank means "myself", exactly as the field says.
      assigneeId: form.assigneeId || (options?.me.id ?? ''),
      status: form.status,
      startDate: form.startDate,
      endDate: form.endDate || null,
      dependent: form.dependent,
      dependsOnId: form.dependent ? (form.dependsOnId || null) : null,
    };
    try {
      if (form.id) {
        await api.put(`/tasks/${form.id}`, body);
        setNotice(`"${form.name}" updated.`);
      } else {
        const res = await api.post('/tasks', body);
        setNotice(`"${res.data.name}" created and assigned to ${res.data.assigneeName}.`);
      }
      setForm(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That task could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function openComments(task) {
    setError('');
    try {
      const res = await api.get(`/tasks/${task.id}/comments`);
      setComments({ task: res.data.task, rows: res.data.comments, draft: '' });
    } catch (err) {
      setError(err.response?.data?.error || 'Those comments could not be opened.');
    }
  }

  async function addComment(e) {
    e.preventDefault();
    const text = comments.draft.trim();
    if (!text) return;
    try {
      const res = await api.post(`/tasks/${comments.task.id}/comments`, { text });
      setComments((c) => ({ ...c, rows: [...c.rows, res.data], draft: '' }));
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That comment could not be saved.');
    }
  }

  async function openReports() {
    setError('');
    try {
      const res = await api.get('/tasks/reports');
      setReports(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'The task report could not be built.');
    }
  }

  const reportsButton = (
    <button className="btn" onClick={openReports}>Task Reports</button>
  );

  return (
    <div>
      {standalone ? (
        <div className="page-head">
          <div>
            <h1>Timesheet</h1>
            <div className="page-sub">{SUBTITLE}</div>
          </div>
          {reportsButton}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>{reportsButton}</div>
      )}

      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="panel">
        <div className="panel-head">
          <h3>My Tasks</h3>
          <button className="btn btn-primary btn-sm" onClick={openNew} disabled={!options}>+ New Task</button>
        </div>
        <div className="panel-pad">
          <div className="filter-row">
            <select
              value={filters.department}
              onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}
            >
              <option value="">All departments</option>
              {(options?.departments || []).map((d) => <option key={d}>{d}</option>)}
            </select>
            <input
              type="date" title="From date"
              value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
            <input
              type="date" title="To date"
              value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
            <button className="btn btn-sm" onClick={() => setFilters({ department: '', from: '', to: '' })}>Clear</button>
            <span className="small-muted">{tasks.length} task(s)</span>
          </div>

          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Task</th><th>Start Date</th><th>End Date</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.name}</b>{' '}
                      <span className={`status ${statusClass(t.status)}`}>{t.status}</span>
                      {t.subTaskName && <div className="small-muted">Sub task: {t.subTaskName}</div>}
                      <div className="small-muted">{t.department || '—'}</div>
                      <div className="small-muted">
                        Assigned to {t.assigneeName} · Assigned by {t.assignedByName}
                      </div>
                    </td>
                    <td className="cell-muted">{ddmmyyyy(t.startDate)}</td>
                    <td className="cell-muted">{ddmmyyyy(t.endDate)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => openEdit(t)}>Edit</button>{' '}
                      <button
                        className="btn btn-sm btn-ghost" title="Comments"
                        onClick={() => openComments(t)}
                      >
                        💬 {t.commentCount || 0}
                      </button>
                    </td>
                  </tr>
                ))}
                {!tasks.length && (
                  <tr>
                    <td colSpan="4" className="small-muted" style={{ padding: 16 }}>
                      {loading ? 'Loading…' : 'No tasks yet. "+ New Task" creates the first one.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {options?.scopeNote && <div className="small-muted" style={{ marginTop: 10 }}>{options.scopeNote}</div>}
        </div>
      </div>

      {/* ---- New Task / Edit Task ---------------------------------------- */}
      {form && (
        <Modal
          title={form.id ? 'Edit Task' : 'New Task'}
          size="wide"
          onClose={() => setForm(null)}
          foot={<>
            <button className="btn" type="button" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" type="submit" form="task-form" disabled={saving}>
              {form.id ? 'Save' : '+ Create'}
            </button>
          </>}
        >
          <form id="task-form" onSubmit={submit}>
            {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
            <div className="grid-2">
              <label className="field"><span>Select Department *</span>
                <select required value={form.department} onChange={(e) => set({ department: e.target.value })}>
                  <option value="">-- Select Department --</option>
                  {(options?.departments || []).map((d) => <option key={d}>{d}</option>)}
                </select>
              </label>
              <label className="field"><span>Task Name *</span>
                <input required value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </label>

              <label className="field"><span>Task Description</span>
                <textarea rows="3" value={form.description} onChange={(e) => set({ description: e.target.value })} />
              </label>
              <label className="field"><span>Sub Task Name</span>
                <input value={form.subTaskName} onChange={(e) => set({ subTaskName: e.target.value })} />
              </label>

              <label className="field"><span>Assign To</span>
                <select
                  value={form.assigneeId}
                  onChange={(e) => set({ assigneeId: e.target.value })}
                  disabled={!canAssignOthers}
                >
                  <option value="">Myself</option>
                  {people.filter((p) => !p.self).map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}{p.designation ? ` — ${p.designation}` : ''}
                    </option>
                  ))}
                </select>
                <span className="small-muted">
                  Optional — leave blank for yourself.
                  {canAssignOthers ? '' : ' Your role assigns work to yourself only.'}
                </span>
              </label>
              <label className="field"><span>Status *</span>
                <select required value={form.status} onChange={(e) => set({ status: e.target.value })}>
                  <option value="">-- Select Status --</option>
                  {(options?.statuses || []).map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>

              {/* The left cell of this row is empty in the design — Task Start
                  Date sits beside Assign To's helper line. */}
              <div />
              <label className="field"><span>Task Start Date *</span>
                <input required type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
              </label>
            </div>

            <label className="field"><span>Task End Date</span>
              <input type="date" value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            </label>

            <div className="field">
              <span>Dependent Task</span>
              <YesNo value={form.dependent} onChange={(v) => set({ dependent: v, dependsOnId: v ? form.dependsOnId : '' })} />
            </div>
            {form.dependent && (
              <label className="field"><span>Waits on</span>
                <select value={form.dependsOnId} onChange={(e) => set({ dependsOnId: e.target.value })}>
                  <option value="">— pick the task this one waits on —</option>
                  {tasks.filter((t) => t.id !== form.id).map((t) => (
                    <option key={t.id} value={t.id}>{t.name} — {t.assigneeName}</option>
                  ))}
                </select>
                <span className="small-muted">A dependency has to be a task you can reach.</span>
              </label>
            )}
          </form>
        </Modal>
      )}

      {/* ---- Comments ----------------------------------------------------- */}
      {comments && (
        <Modal
          title={`Comments — ${comments.task.name}`}
          onClose={() => setComments(null)}
          foot={<button className="btn" onClick={() => setComments(null)}>Close</button>}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {comments.task.department || '—'} · assigned to {comments.task.assigneeName} · {comments.task.status}
          </div>
          {comments.rows.length ? (
            <div className="timeline">
              {comments.rows.map((c) => (
                <div className="timeline-item" key={c.id}>
                  <div className="timeline-date">{new Date(c.createdAt).toLocaleString()} · {c.authorName}</div>
                  <div className="timeline-label" style={{ fontWeight: 400 }}>{c.text}</div>
                </div>
              ))}
            </div>
          ) : <div className="empty-mini">No comments on this task yet.</div>}
          <form onSubmit={addComment} style={{ marginTop: 14 }}>
            <label className="field"><span>Add a comment</span>
              <textarea
                rows="3" value={comments.draft}
                onChange={(e) => setComments((c) => ({ ...c, draft: e.target.value }))}
              />
            </label>
            <button className="btn btn-primary btn-sm" type="submit" disabled={!comments.draft.trim()}>Comment</button>
          </form>
        </Modal>
      )}

      {/* ---- Task Reports -------------------------------------------------- */}
      {reports && (
        <Modal
          title="Task Reports"
          size="wide"
          note={`${reports.total} task(s) in your scope`}
          onClose={() => setReports(null)}
          foot={<button className="btn" onClick={() => setReports(null)}>Close</button>}
        >
          {reports.total === 0 ? (
            <div className="empty-mini">
              There are no tasks in your scope yet, so there is nothing to report on.
            </div>
          ) : (
            <>
              <div className="statbar">
                <div className="statitem"><div className="n">{reports.total}</div><div className="l">Tasks</div></div>
                <div className="statitem"><div className="n">{reports.overdue}</div><div className="l">Overdue</div></div>
                <div className="statitem"><div className="n">{reports.dueToday}</div><div className="l">Due today</div></div>
                <div className="statitem"><div className="n">{reports.noDueDate}</div><div className="l">No due date</div></div>
              </div>

              <div className="section-label">By status</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Status</th><th>Tasks</th></tr></thead>
                  <tbody>
                    {reports.byStatus.map((r) => (
                      <tr key={r.status}><td>{r.status}</td><td>{r.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="section-label">By person</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Assignee</th><th>Total</th><th>Open</th><th>Completed</th><th>Overdue</th></tr></thead>
                  <tbody>
                    {reports.byPerson.map((r) => (
                      <tr key={r.userId}>
                        <td>{r.name}</td><td>{r.total}</td><td>{r.open}</td><td>{r.completed}</td><td>{r.overdue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="section-label">By department</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Department</th><th>Total</th><th>Completed</th></tr></thead>
                  <tbody>
                    {reports.byDepartment.map((r) => (
                      <tr key={r.department}><td>{r.department}</td><td>{r.total}</td><td>{r.completed}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Said plainly rather than invented. */}
          <div className="notice amber" style={{ marginTop: 16, display: 'block' }}>
            <b>Not computed from this data:</b>
            <ul style={{ margin: '6px 0 0 18px' }}>
              {reports.notComputed.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
          <div className="small-muted">{reports.scopeNote}</div>
        </Modal>
      )}
    </div>
  );
}
