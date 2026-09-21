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

function reviewClass(state) {
  if (state === 'Approved') return 'approved';
  if (state === 'Pending Review') return 'hold';
  if (state === 'Changes Requested') return 'rejected';
  return 'new';
}

// --- Validation -------------------------------------------------------------
//
// THE WORDING IS THE SPEC. These exact sentences are what the field shows, and
// backend/src/routes/tasks.js refuses the same five things with the same five
// sentences — the browser check is a courtesy, the API is the gate. Returning
// a map keyed by field name is what lets each message sit under its own box
// instead of one banner at the top.
function validate(form) {
  const errors = {};
  if (!form.department || !form.department.trim()) errors.department = 'Please select a department.';
  if (!form.name || !form.name.trim()) errors.name = 'Please enter a task name.';
  if (!form.status) errors.status = 'Please select a status.';
  if (!form.startDate) errors.startDate = 'Please select a start date.';
  if (form.startDate && form.endDate && form.endDate < form.startDate) {
    errors.endDate = 'End date cannot be before start date.';
  }
  return errors;
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
  const [fieldErrors, setFieldErrors] = useState({});
  const [review, setReview] = useState(null); // { task, decision, note }
  const [busyId, setBusyId] = useState('');

  // Typing in a box clears that box's message, so a corrected field stops
  // shouting before the next submit.
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setFieldErrors((e) => {
      const next = { ...e };
      Object.keys(patch).forEach((k) => delete next[k]);
      // Start and end are judged together, so fixing either clears the pair.
      if (patch.startDate !== undefined || patch.endDate !== undefined) delete next.endDate;
      return next;
    });
  };

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
  // Signing work off is its own permission (hrms / Employee Services /
  // approve), resolved by the server — this only hides the button.
  const canReview = !!options?.canReview;
  const myId = options?.me?.id;
  // Who may drive Start / Complete: the person the work is for, the person who
  // handed it out, or a lead who may edit it. The API asks the same question.
  const mayWork = (t) => !!myId && (t.assigneeId === myId || t.assignedById === myId || canAssignOthers);
  const nameOf = useMemo(() => {
    const map = {};
    people.forEach((p) => { map[p.userId] = p.name; });
    return map;
  }, [people]);

  function openNew() {
    setError(''); setNotice(''); setFieldErrors({});
    const f = emptyForm(options);
    // The department defaults to the one this login works in when there is
    // only one it can pick.
    if (options && options.departments.length === 1) f.department = options.departments[0];
    setForm(f);
  }

  function openEdit(task) {
    setError(''); setNotice(''); setFieldErrors({});
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
    setError('');
    // VALIDATION RUNS BEFORE CREATE. Nothing is sent while a required box is
    // empty or the dates are the wrong way round; the messages appear under
    // the boxes they belong to.
    const errors = validate(form);
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setError('Please correct the highlighted fields.');
      return;
    }
    setFieldErrors({});
    setSaving(true);
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
      const data = err.response?.data || {};
      // The API names the field it refused, so a server-side refusal lands
      // under the same box the browser check would have used.
      if (data.field) setFieldErrors({ [data.field]: data.error });
      setError(data.error || 'That task could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  // --- The lifecycle: start -> complete -> review ---------------------------
  //
  // Each button is one API call; the row re-reads from the server afterwards,
  // so what is on screen is what was actually stored, never an optimistic
  // guess. The buttons are hidden when the transition does not apply, and the
  // API refuses it anyway.
  async function act(task, path, successText) {
    setError(''); setNotice(''); setBusyId(task.id);
    try {
      await api.post(`/tasks/${task.id}/${path}`, {});
      setNotice(successText);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That could not be done.');
    } finally {
      setBusyId('');
    }
  }

  async function submitReview(e) {
    e.preventDefault();
    setError('');
    if (review.decision === 'changes' && !review.note.trim()) {
      setError('Say what needs changing.');
      return;
    }
    setBusyId(review.task.id);
    try {
      await api.post(`/tasks/${review.task.id}/review`, {
        decision: review.decision, note: review.note.trim(),
      });
      setNotice(review.decision === 'approve'
        ? `"${review.task.name}" approved.`
        : `"${review.task.name}" sent back for changes.`);
      setReview(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That review could not be saved.');
    } finally {
      setBusyId('');
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
                      <span className={`status ${statusClass(t.status)}`}>{t.status}</span>{' '}
                      {t.reviewState && t.reviewState !== 'Not Submitted' && (
                        <span className={`status ${reviewClass(t.reviewState)}`}>{t.reviewState}</span>
                      )}
                      {t.subTaskName && <div className="small-muted">Sub task: {t.subTaskName}</div>}
                      <div className="small-muted">{t.department || '—'}</div>
                      <div className="small-muted">
                        Assigned to {t.assigneeName} · Assigned by {t.assignedByName}
                      </div>
                      {t.reviewedByName && (
                        <div className="small-muted">
                          Reviewed by {t.reviewedByName}
                          {t.reviewNote ? ` — ${t.reviewNote}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="cell-muted">{ddmmyyyy(t.startDate)}</td>
                    <td className="cell-muted">{ddmmyyyy(t.endDate)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* The workflow, in the order it happens. A button only
                          appears where its transition is actually available. */}
                      {mayWork(t) && ['Not Started', 'On Hold'].includes(t.status) && (
                        <>
                          <button
                            className="btn btn-sm btn-primary" disabled={busyId === t.id}
                            onClick={() => act(t, 'start', `"${t.name}" started.`)}
                          >
                            Start
                          </button>{' '}
                        </>
                      )}
                      {mayWork(t) && t.status === 'In Progress' && (
                        <>
                          <button
                            className="btn btn-sm btn-primary" disabled={busyId === t.id}
                            onClick={() => act(t, 'complete', `"${t.name}" completed and sent for review.`)}
                          >
                            Complete
                          </button>{' '}
                        </>
                      )}
                      {canReview && t.reviewState === 'Pending Review' && (
                        <>
                          <button
                            className="btn btn-sm" disabled={busyId === t.id}
                            onClick={() => { setError(''); setNotice(''); setReview({ task: t, decision: 'approve', note: '' }); }}
                          >
                            Review
                          </button>{' '}
                        </>
                      )}
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
              {/* `required` is left off on purpose: the browser's own bubble
                  would pre-empt these messages, and the wording of THESE is
                  the spec. validate() runs on submit and the API re-checks. */}
              <label className="field"><span>Select Department *</span>
                <select value={form.department} onChange={(e) => set({ department: e.target.value })}>
                  <option value="">-- Select Department --</option>
                  {(options?.departments || []).map((d) => <option key={d}>{d}</option>)}
                </select>
                {fieldErrors.department && <p className="error-text">{fieldErrors.department}</p>}
              </label>
              <label className="field"><span>Task Name *</span>
                <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
                {fieldErrors.name && <p className="error-text">{fieldErrors.name}</p>}
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
                <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
                  <option value="">-- Select Status --</option>
                  {(options?.statuses || []).map((s) => <option key={s}>{s}</option>)}
                </select>
                {fieldErrors.status && <p className="error-text">{fieldErrors.status}</p>}
              </label>

              {/* The left cell of this row is empty in the design — Task Start
                  Date sits beside Assign To's helper line. */}
              <div />
              <label className="field"><span>Task Start Date *</span>
                <input type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
                {fieldErrors.startDate && <p className="error-text">{fieldErrors.startDate}</p>}
              </label>
            </div>

            <label className="field"><span>Task End Date</span>
              {/* No `min` here on purpose, for the same reason `required` is
                  left off above: the browser's native range bubble ("Value
                  must be 21-09-2026 or later") would fire first and the
                  specified message would never be seen. validate() owns it. */}
              <input type="date" value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} />
              {fieldErrors.endDate && <p className="error-text">{fieldErrors.endDate}</p>}
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

      {/* ---- Review ------------------------------------------------------- */}
      {review && (
        <Modal
          title={`Review — ${review.task.name}`}
          onClose={() => setReview(null)}
          foot={<>
            <button className="btn" type="button" onClick={() => setReview(null)}>Cancel</button>
            <button
              className="btn btn-primary" type="submit" form="task-review"
              disabled={busyId === review.task.id}
            >
              {review.decision === 'approve' ? 'Approve' : 'Request changes'}
            </button>
          </>}
        >
          <form id="task-review" onSubmit={submitReview}>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              {review.task.department || '—'} · completed by {review.task.assigneeName}
              {review.task.completedAt ? ` on ${new Date(review.task.completedAt).toLocaleString()}` : ''}
              {review.task.endDate ? ` · due ${ddmmyyyy(review.task.endDate)}` : ' · no due date'}
            </div>
            <div className="field">
              <span>Decision</span>
              <div style={{ display: 'inline-flex' }}>
                <button
                  type="button"
                  className={`btn btn-sm${review.decision === 'approve' ? ' btn-primary' : ''}`}
                  style={{ borderRadius: '8px 0 0 8px' }}
                  onClick={() => setReview((r) => ({ ...r, decision: 'approve' }))}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={`btn btn-sm${review.decision === 'changes' ? ' btn-primary' : ''}`}
                  style={{ borderRadius: '0 8px 8px 0', marginLeft: -1 }}
                  onClick={() => setReview((r) => ({ ...r, decision: 'changes' }))}
                >
                  Request changes
                </button>
              </div>
            </div>
            <label className="field">
              <span>Reviewer note {review.decision === 'changes' ? '*' : ''}</span>
              <textarea
                rows="3" value={review.note}
                onChange={(e) => setReview((r) => ({ ...r, note: e.target.value }))}
              />
              <span className="small-muted">
                {review.decision === 'approve'
                  ? 'Optional. The note is added to the task’s comment thread.'
                  : 'Required — the task reopens as In Progress with this note on it.'}
              </span>
            </label>
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
                <div className="statitem"><div className="n">{reports.awaitingReview ?? 0}</div><div className="l">Awaiting review</div></div>
                <div className="statitem"><div className="n">{reports.approved ?? 0}</div><div className="l">Approved</div></div>
                <div className="statitem">
                  <div className="n">{reports.onTime?.rate == null ? '—' : `${reports.onTime.rate}%`}</div>
                  <div className="l">On time</div>
                </div>
              </div>
              {reports.onTime?.judged > 0 && (
                <div className="small-muted" style={{ marginTop: -4, marginBottom: 10 }}>
                  On time measured over {reports.onTime.judged} completed task(s) with a due date —{' '}
                  {reports.onTime.onTime} on time, {reports.onTime.late} late.
                </div>
              )}

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

              {!!(reports.byReview || []).length && (
                <>
                  <div className="section-label">By review state</div>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Review</th><th>Tasks</th></tr></thead>
                      <tbody>
                        {reports.byReview.map((r) => (
                          <tr key={r.state}><td>{r.state}</td><td>{r.count}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="section-label">By person</div>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Assignee</th><th>Total</th><th>Open</th><th>Completed</th>
                      <th>Awaiting review</th><th>Approved</th><th>Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.byPerson.map((r) => (
                      <tr key={r.userId}>
                        <td>{r.name}</td><td>{r.total}</td><td>{r.open}</td><td>{r.completed}</td>
                        <td>{r.awaitingReview ?? 0}</td><td>{r.approved ?? 0}</td><td>{r.overdue}</td>
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
