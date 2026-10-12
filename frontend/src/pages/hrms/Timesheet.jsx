import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { peopleMatches, peopleOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import '../../components/ui/ListFilters.css';
import AudiencePicker, { DeliverVia, audienceReady } from '../../components/AudiencePicker.jsx';
import { AiAssist } from '../../components/ComposeForm.jsx';
import InsightsPanel from '../../components/charts/InsightsPanel.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import './timesheet-priority.css';

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
    priority: 'Medium',
    startDate: (options && options.today) || new Date().toISOString().slice(0, 10),
    endDate: '',
    dependent: false,
    dependsOnId: '',
    // "Assign To" for a lead: myself, one person (the single select), or
    // several at once through the shared Send-to picker — one or MANY
    // departments or named people, one task per person.
    assignMode: 'single',
    audience: { mode: 'individuals', departments: [], employeeIds: [] },
    channels: [],
  };
}

// Priority colours: High red, Medium orange, Low blue (the four-colour rule).
function priorityClass(p) {
  if (p === 'High') return 'rejected';
  if (p === 'Low') return 'interview';
  return 'hold';
}
const PRIORITY_ORDER = ['High', 'Medium', 'Low'];
const STATUS_ORDER = ['Overdue', 'Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];

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
  if (!['High', 'Medium', 'Low'].includes(form.priority)) errors.priority = 'Priority must be High, Medium or Low.';
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
  // department + assigneeId are the hrms-24 §8 picker: Department first, then
  // an Employee list holding only that department's people IN THIS LOGIN'S
  // SCOPE (GET /tasks/people). Both go to the server, which refuses anything
  // outside the scope.
  // Department, Employee, Priority and Status are picked from lists that are
  // COUNTED over the tasks this login may see (cascading, with counts): picking
  // one narrows the others. Only the date range goes to the server.
  const [filters, setFilters] = useState({ department: '', assigneeId: '', from: '', to: '' });
  // The ASSIGNEE's ID, name and role and the task's status, applied here over
  // the rows the server returned; department and dates stay server-side.
  const [pf, setPf] = useState({ q: '', code: '', name: '', role: '', status: '', review: '', priority: '', dueFrom: '', dueTo: '' });
  const [sort, setSort] = useState('');
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
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    setLoading(true);
    api.get('/tasks', { params })
      .then((res) => setTasks(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load tasks.'))
      .finally(() => setLoading(false));
  }, [filters.from, filters.to]);

  useEffect(() => {
    api.get('/tasks/options')
      .then((res) => setOptions(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the task options.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  // The Employee select refreshes whenever the Department changes: Medical
  // -> only Medical employees. An Employee login has no picker at all.
  const canPickEmployee = !!options?.canPickEmployee;

  const people = options?.assignable || [];
  const canAssignOthers = !!options?.canAssignOthers;
  // Signing work off is its own permission (hrms / Employee Services /
  // approve), resolved by the server — this only hides the button.
  const canReview = !!options?.canReview;
  const myId = options?.me?.id;
  // Who may drive Start / Complete: the person the work is for, the person who
  // handed it out, or a lead who may edit it. The API asks the same question.
  const mayWork = (t) => !!myId && (t.assigneeId === myId || t.assignedById === myId || canAssignOthers);
  // The assignee as the filters read them — the name the task was given to,
  // plus the employee ID and designation the list now carries.
  const assigneeOf = (t) => ({ ...(t.assignee || {}), name: t.assigneeName });
  const FACET_FIELDS = useMemo(() => [
    { key: 'priority', get: (t) => t.priority || 'Medium' },
    { key: 'status', get: (t) => (t.overdue ? [t.status, 'Overdue'] : [t.status]) },
    { key: 'assigneeId', get: (t) => t.assigneeId, label: (v, t) => t.assigneeName },
    { key: 'department', get: (t) => t.department || (t.assignee && t.assignee.department) || '' },
  ], []);
  const facetValues = { priority: pf.priority, status: pf.status, assigneeId: filters.assigneeId, department: filters.department };
  const facets = useLocalFacets(tasks, FACET_FIELDS, facetValues);
  const orderBy = (list, order) => [...list].sort((a, b) => (order.indexOf(a.value) < 0 ? 99 : order.indexOf(a.value)) - (order.indexOf(b.value) < 0 ? 99 : order.indexOf(b.value)));
  const taskDept = (t) => t.department || (t.assignee && t.assignee.department) || '';
  const shown = tasks.filter((t) => textMatches(`${t.name || ''} ${t.subTaskName || ''} ${t.description || ''} ${t.assigneeName || ''} ${t.assignedByName || ''}`, pf.q)
    && peopleMatches(t, pf, assigneeOf) && (!pf.review || (t.reviewState || 'Not Submitted') === pf.review)
    && (!pf.priority || (t.priority || 'Medium') === pf.priority)
    && (!pf.status || t.status === pf.status || (pf.status === 'Overdue' && t.overdue))
    && (!filters.assigneeId || t.assigneeId === filters.assigneeId)
    && (!filters.department || taskDept(t) === filters.department)
    && (!pf.dueFrom || (t.endDate && t.endDate >= pf.dueFrom))
    && (!pf.dueTo || (t.endDate && t.endDate <= pf.dueTo)));
  const assigneeRoles = peopleOptions(tasks, assigneeOf).roles;
  const reviewStates = [...new Set(tasks.map((t) => t.reviewState || 'Not Submitted'))].sort();
  const setP = (k, v) => setPf((f) => ({ ...f, [k]: v }));
  // Sort: as the server returned them (newest first), or by date / name.
  const TASK_SORTS = {
    start: (a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')),
    due: (a, b) => String(a.endDate || '9999').localeCompare(String(b.endDate || '9999')),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
  };
  const page = usePaged(TASK_SORTS[sort] ? [...shown].sort(TASK_SORTS[sort]) : shown);
  const NO_SERVER = { department: '', assigneeId: '', from: '', to: '' };
  const NO_CLIENT = { q: '', code: '', name: '', role: '', status: '', review: '', priority: '', dueFrom: '', dueTo: '' };
  const clearTaskFilters = () => { setFilters(NO_SERVER); setPf(NO_CLIENT); };
  const taskFiltersOn = Object.values(filters).some(Boolean) || Object.values(pf).some(Boolean);
  const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
  const pickedName = (tasks.find((t) => t.assigneeId === filters.assigneeId) || {}).assigneeName || filters.assigneeId;
  const taskChips = [
    { key: 'q', label: 'Search', value: pf.q, onRemove: () => setP('q', '') },
    { key: 'department', label: 'Department', value: filters.department, onRemove: () => setFilters((f) => ({ ...f, department: '', assigneeId: '' })) },
    { key: 'assigneeId', label: 'Employee', value: filters.assigneeId ? pickedName : '', onRemove: () => setFilters((f) => ({ ...f, assigneeId: '' })) },
    { key: 'priority', label: 'Priority', value: pf.priority, onRemove: () => setP('priority', '') },
    { key: 'status', label: 'Status', value: pf.status, onRemove: () => setP('status', '') },
    {
      key: 'due', label: 'Due date',
      value: pf.dueFrom || pf.dueTo ? (pf.dueFrom && pf.dueTo ? `${dmy(pf.dueFrom)} → ${dmy(pf.dueTo)}` : pf.dueFrom ? `from ${dmy(pf.dueFrom)}` : `to ${dmy(pf.dueTo)}`) : '',
      onRemove: () => setPf((f) => ({ ...f, dueFrom: '', dueTo: '' })),
    },
    { key: 'review', label: 'Review', value: pf.review, onRemove: () => setP('review', '') },
    {
      key: 'dates', label: 'Date range',
      value: filters.from || filters.to ? (filters.from && filters.to ? `${dmy(filters.from)} → ${dmy(filters.to)}` : filters.from ? `from ${dmy(filters.from)}` : `to ${dmy(filters.to)}`) : '',
      onRemove: () => setFilters((f) => ({ ...f, from: '', to: '' })),
    },
    { key: 'code', label: 'Employee ID', value: pf.code, onRemove: () => setP('code', '') },
    { key: 'name', label: 'Assignee name', value: pf.name, onRemove: () => setP('name', '') },
    { key: 'role', label: 'Role', value: pf.role, onRemove: () => setP('role', '') },
  ];
  const moreOn = [filters.from || filters.to, pf.dueFrom || pf.dueTo, pf.review, pf.code, pf.name, pf.role].filter(Boolean).length;
  // The Send-to picker lists exactly the people assignable() offers — the
  // same set the API accepts — keyed by employee id.
  const pickable = useMemo(() => people.filter((p) => p.employeeId).map((p) => ({
    id: p.employeeId, name: p.name, employeeCode: p.designation || '', department: p.department || '',
  })), [people]);
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
      priority: task.priority || 'Medium',
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
    const many = !form.id && canAssignOthers && form.assignMode === 'many';
    if (many && !audienceReady(form.audience)) errors.assigneeId = form.audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one person.';
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
      priority: form.priority,
      startDate: form.startDate,
      endDate: form.endDate || null,
      dependent: form.dependent,
      dependsOnId: form.dependent ? (form.dependsOnId || null) : null,
    };
    try {
      if (form.id) {
        await api.put(`/tasks/${form.id}`, body);
        setNotice(`"${form.name}" updated.`);
      } else if (many) {
        const res = await api.post('/tasks', { ...body, assigneeId: undefined, audience: form.audience, channels: form.channels });
        const d = res.data;
        setNotice(`"${d.name}" created for ${d.label} — ${d.created} task(s).${d.skipped?.length ? ` Skipped (no login): ${d.skipped.join(', ')}.` : ''} ${d.deliveryText || ''}`);
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
      ) : null}

      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* hrms-24 §1 / §9 — hours worked (check-in to check-out) by period,
          department and employee, and the tasks in the range, for the people
          this Timesheet may show; with the per-employee export. */}
      {/* Filters first: inside a tab strip the Task Reports button joins the
          panel's filter row instead of sitting in a row of its own above it. */}
      <InsightsPanel module="timesheet" storageKey="tl_range_timesheet">
        {!standalone && reportsButton}
      </InsightsPanel>

      <div className="panel">
        <div className="panel-head">
          <h3>My Tasks</h3>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Tasks: export everyone in scope (these filters) / one employee,
                and import with the compulsory sample (backend src/io/timesheet.js).
                The hours summary keeps the Export above the charts. */}
            <DataIoBar
              ioKey="timesheet"
              params={{ department: filters.department, from: filters.from, to: filters.to, status: pf.status === 'Overdue' ? '' : pf.status }}
              onImported={load}
            />
            <button className="btn btn-primary btn-sm" onClick={openNew} disabled={!options}>+ New Task</button>
          </span>
        </div>
        <div className="panel-pad">
          {/* The list filter standard: Search · Department · Employee · Status
              on screen, the rest under More Filters, active filters as chips.
              Department, Employee and the dates go to the server (GET /tasks);
              the rest narrow the rows it returned. */}
          <div className="lf" style={{ marginBottom: 10 }}>
            <MoreFilters
              storageKey="timesheet-tasks"
              activeMore={moreOn}
              onClearAll={taskFiltersOn ? clearTaskFilters : undefined}
              primary={(
                <>
                  <input type="search" placeholder="Search task, sub task or person…" value={pf.q} onChange={(e) => setP('q', e.target.value)} aria-label="Search" style={{ minWidth: 220 }} />
                  <FacetSelect label="Priority" allLabel="Any priority" value={pf.priority} onChange={(v) => setP('priority', v)} options={orderBy(facets.priority || [], PRIORITY_ORDER)} />
                  <FacetSelect label="Status" allLabel="Any status" value={pf.status} onChange={(v) => setP('status', v)} options={orderBy(facets.status || [], STATUS_ORDER)} />
                  {canPickEmployee && (
                    <FacetSelect label="Employee" allLabel="Everyone" value={filters.assigneeId} onChange={(v) => setFilters((f) => ({ ...f, assigneeId: v }))}
                      options={(facets.assigneeId || []).slice().sort((a, b) => a.label.localeCompare(b.label))} />
                  )}
                  {canPickEmployee && (
                    <FacetSelect label="Department" allLabel="All departments" value={filters.department} onChange={(v) => setFilters((f) => ({ ...f, department: v }))} options={facets.department || []} />
                  )}
                </>
              )}
              extra={(
                <>
                  <label className="lf-sort">
                    Sort
                    <select value={sort} onChange={(e) => setSort(e.target.value)}>
                      <option value="">Newest first</option>
                      <option value="start">Start date (latest first)</option>
                      <option value="due">End date (soonest first)</option>
                      <option value="name">Task A–Z</option>
                    </select>
                  </label>
                  <span className="small-muted lf-count">{taskFiltersOn ? `${shown.length} of ${tasks.length} tasks` : `${tasks.length} tasks`}</span>
                </>
              )}
            >
              <span className="lf-dates" title="Date range">
                <span className="lf-dates-lbl">Date range</span>
                <input type="date" aria-label="Date range from" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
                <span aria-hidden="true">→</span>
                <input type="date" aria-label="Date range to" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
              </span>
              <span className="lf-dates" title="Due date (the task's End Date)">
                <span className="lf-dates-lbl">Due date</span>
                <input type="date" aria-label="Due from" value={pf.dueFrom} max={pf.dueTo || undefined} onChange={(e) => setP('dueFrom', e.target.value)} />
                <span aria-hidden="true">→</span>
                <input type="date" aria-label="Due to" value={pf.dueTo} min={pf.dueFrom || undefined} onChange={(e) => setP('dueTo', e.target.value)} />
              </span>
              <Combo value={pf.review} title="Review" onChange={(e) => setP('review', e.target.value)}>
                <option value="">All review states</option>
                {reviewStates.map((s) => <option key={s}>{s}</option>)}
              </Combo>
              {canAssignOthers && (
                <>
                  <input placeholder="Employee ID" aria-label="Employee ID" value={pf.code} onChange={(e) => setP('code', e.target.value)} />
                  <input placeholder="Assignee name" aria-label="Assignee name" value={pf.name} onChange={(e) => setP('name', e.target.value)} />
                  <Combo value={pf.role} title="Role" onChange={(e) => setP('role', e.target.value)}>
                    <option value="">All roles</option>
                    {assigneeRoles.map((r) => <option key={r}>{r}</option>)}
                  </Combo>
                </>
              )}
            </MoreFilters>
            <FilterChips filters={taskChips} onClearAll={taskFiltersOn ? clearTaskFilters : undefined} />
          </div>

          {/* Status-wise at a glance: tap a word to see just those tasks. The
              numbers follow the other filters (Priority, Employee, Department). */}
          <div className="ts-strip" role="group" aria-label="Tasks by status">
            <button type="button" className={`ts-chip${!pf.status ? ' on' : ''}`} onClick={() => setP('status', '')}>All <b>{tasks.filter((t) => (!pf.priority || (t.priority || 'Medium') === pf.priority) && (!filters.assigneeId || t.assigneeId === filters.assigneeId) && (!filters.department || taskDept(t) === filters.department)).length}</b></button>
            {orderBy(facets.status || [], STATUS_ORDER).filter((o) => o.count > 0).map((o) => (
              <button key={o.value} type="button" className={`ts-chip tone-${o.value === 'Overdue' ? 'red' : o.value === 'Completed' ? 'green' : o.value === 'In Progress' ? 'blue' : o.value === 'Cancelled' ? 'grey' : 'orange'}${pf.status === o.value ? ' on' : ''}`}
                onClick={() => setP('status', pf.status === o.value ? '' : o.value)}>{o.label} <b>{o.count}</b></button>
            ))}
          </div>

          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Task</th><th>Priority</th><th>Start Date</th><th>Due Date</th><th>Progress</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {page.slice.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.name}</b>{' '}
                      <span className={`status ${statusClass(t.status)}`}>{t.status}</span>{' '}
                      {t.overdue && <span className="status rejected" title={`Due ${ddmmyyyy(t.endDate)}`}>Overdue</span>}{' '}
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
                    <td><span className={`status ${priorityClass(t.priority)}`}>{t.priority || 'Medium'}</span></td>
                    <td className="cell-muted">{ddmmyyyy(t.startDate)}</td>
                    <td className="cell-muted">
                      {ddmmyyyy(t.endDate)}
                      {t.overdue && <div className="ts-late">{t.daysLate} day{t.daysLate === 1 ? '' : 's'} late</div>}
                    </td>
                    <td className="cell-muted">
                      {t.completion}
                      {t.completedAt && t.status === 'Completed' && <div className="small-muted">on {ddmmyyyy(String(t.completedAt).slice(0, 10))}</div>}
                    </td>
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
                {!shown.length && (
                  <tr>
                    <td colSpan="6" className="small-muted" style={{ padding: loading ? 16 : 0 }}>
                      {loading ? 'Loading…' : <ListEmpty lf={{ activeCount: taskFiltersOn ? 1 : 0, clear: clearTaskFilters }} noun="tasks" title="No tasks yet." hint={'"+ New Task" creates the first one.'} />}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {page.total > 0 && <Pager page={page} noun="tasks" />}
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
            <button className="btn btn-primary" type="submit" form="task-form" disabled={saving}>
              {saving ? 'Saving…' : form.id ? 'Save' : '+ Create'}
            </button>
            <button className="btn" type="button" onClick={() => setForm(null)}>Cancel</button>
          </>}
        >
          <form id="task-form" onSubmit={submit}>
            {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
            <div className="grid-2">
              {/* `required` is left off on purpose: the browser's own bubble
                  would pre-empt these messages, and the wording of THESE is
                  the spec. validate() runs on submit and the API re-checks. */}
              <label className="field"><span>Select Department *</span>
                <Combo creatable value={form.department} onChange={(e) => set({ department: e.target.value })}>
                  <option value="">-- Select Department --</option>
                  {(options?.departments || []).map((d) => <option key={d}>{d}</option>)}
                </Combo>
                {fieldErrors.department && <p className="error-text">{fieldErrors.department}</p>}
              </label>
              <label className="field"><span>Task Name *</span>
                <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
                {fieldErrors.name && <p className="error-text">{fieldErrors.name}</p>}
              </label>

              <div className="field compose-form"><span>Task Description</span>
                <AiAssist kind="task" title={form.name} text={form.description} onText={(description) => set({ description })} />
                <textarea rows="3" value={form.description} onChange={(e) => set({ description: e.target.value })} />
              </div>
              <label className="field"><span>Sub Task Name</span>
                <input value={form.subTaskName} onChange={(e) => set({ subTaskName: e.target.value })} />
              </label>

              <label className="field"><span>Assign To</span>
                {!form.id && canAssignOthers && (
                  <Combo value={form.assignMode} onChange={(e) => set({ assignMode: e.target.value })}>
                    <option value="single">One person</option>
                    <option value="many">Several people / departments</option>
                  </Combo>
                )}
                {form.assignMode === 'many' && !form.id && canAssignOthers ? null : (
                <Combo
                  value={form.assigneeId}
                  onChange={(e) => set({ assigneeId: e.target.value })}
                  disabled={!canAssignOthers}
                >
                  <option value="">Myself</option>
                  {people.filter((p) => !p.self && (!form.department || form.id || p.department === form.department || !people.some((q) => !q.self && q.department === form.department))).map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}{p.designation ? ` — ${p.designation}` : ''}
                    </option>
                  ))}
                </Combo>
                )}
                <span className="small-muted">
                  {form.assignMode === 'many' && !form.id && canAssignOthers
                    ? 'One task is created for each person picked below.'
                    : <>Optional — leave blank for yourself.{canAssignOthers ? '' : ' Your role assigns work to yourself only.'}</>}
                </span>
                {fieldErrors.assigneeId && <p className="error-text">{fieldErrors.assigneeId}</p>}
              </label>
              <label className="field"><span>Status *</span>
                <Combo value={form.status} onChange={(e) => set({ status: e.target.value })}>
                  <option value="">-- Select Status --</option>
                  {(options?.statuses || []).map((s) => <option key={s}>{s}</option>)}
                </Combo>
                {fieldErrors.status && <p className="error-text">{fieldErrors.status}</p>}
              </label>

              <label className="field"><span>Priority *</span>
                <Combo value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                  {(options?.priorities || ['High', 'Medium', 'Low']).map((x) => <option key={x}>{x}</option>)}
                </Combo>
                <span className="small-muted">How urgent it is. Medium unless you say otherwise.</span>
                {fieldErrors.priority && <p className="error-text">{fieldErrors.priority}</p>}
              </label>
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

            {form.assignMode === 'many' && !form.id && canAssignOthers && (
              <>
                <AudiencePicker value={form.audience} onChange={(audience) => set({ audience })} people={pickable} label="Send to" required />
                <DeliverVia value={form.channels} onChange={(channels) => set({ channels })} />
              </>
            )}
            <div className="field">
              <span>Dependent Task</span>
              <YesNo value={form.dependent} onChange={(v) => set({ dependent: v, dependsOnId: v ? form.dependsOnId : '' })} />
            </div>
            {form.dependent && (
              <label className="field"><span>Waits on</span>
                <Combo value={form.dependsOnId} onChange={(e) => set({ dependsOnId: e.target.value })}>
                  <option value="">— pick the task this one waits on —</option>
                  {tasks.filter((t) => t.id !== form.id).map((t) => (
                    <option key={t.id} value={t.id}>{t.name} — {t.assigneeName}</option>
                  ))}
                </Combo>
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

              {!!(reports.byPriority || []).length && (
                <>
                  <div className="section-label">By priority</div>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Priority</th><th>Tasks</th><th>Still open</th><th>Overdue</th></tr></thead>
                      <tbody>
                        {reports.byPriority.map((r) => (
                          <tr key={r.priority}><td>{r.priority}</td><td>{r.total}</td><td>{r.open}</td><td>{r.overdue}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
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
