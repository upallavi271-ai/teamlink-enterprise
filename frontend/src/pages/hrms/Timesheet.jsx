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
import InsightsPanel from '../../components/charts/InsightsPanel.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import './timesheet-priority.css';
import './timesheet-tasks.css';
import { TaskForm, GivenToMe, IGave, LateStrip, DayEndDialog, useTaskDialogs, PRI_WORD, cancelLine, AddOnList, TaskFiles, FeedbackToRd, FeedbackSent } from './TimesheetTasks.jsx';
import IdeasBox from './IdeasBox.jsx';

// Timesheet — "Track and assign work".
//
// THREE VIEWS of the same tasks (2026-10-12):
//   Given to me    the tasks you do: start, add hours, mark as done
//   Tasks I gave   a lead's tasks: each person's summary, move the date, give
//                  to someone else, cancel, approve, Excel / PDF
//                  (both in TimesheetTasks.jsx)
//   Everyone       the full table with every filter, for anyone who may look at
//                  more than their own tasks
// Plus the hours-at-work charts, the New task form and the Task Reports roll-up.
// Everything on this screen is backed by /api/tasks; nothing here is a placeholder.
//
// GIVE TO IS NOT A PLAIN PEOPLE LIST. The options endpoint runs the request
// through the permission engine and utils/scope.js and returns only the people
// this login may hand work to — a recruiter gets themselves, a TL their team.
// The form renders what the server returned and nothing else; the API refuses
// anyone else regardless of what the browser sends.

const SUBTITLE = 'Tasks for you and your team: give a task, add your hours, mark it done.';

// YYYY-MM-DD (the wire format and what <input type="date"> carries) rendered
// dd-mm-yyyy, the way the rest of this screen's date boxes read.
function ddmmyyyy(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).split('-');
  return y && m && d ? `${d}-${m}-${y}` : value;
}

// Priority colours: High red, Normal orange, Low blue (the four-colour rule).
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

export default function Timesheet({ standalone = false }) {
  const [options, setOptions] = useState(null);
  const [tasks, setTasks] = useState([]);
  // department + assigneeId are the hrms-24 §8 picker: Department first, then
  // an Employee list holding only that department's people IN THIS LOGIN'S
  // SCOPE. Both narrow the table below; the server refuses anything outside
  // the scope.
  // Department, Employee, Priority and Status are picked from lists that are
  // COUNTED over the tasks this login may see (cascading, with counts): picking
  // one narrows the others. Only the date range goes to the server.
  const [filters, setFilters] = useState({ department: '', assigneeId: '', from: '', to: '' });
  // The ASSIGNEE's ID, name and role and the task's status, applied here over
  // the rows the server returned; department and dates stay server-side.
  const [pf, setPf] = useState({ q: '', code: '', name: '', role: '', status: '', review: '', priority: '', dueFrom: '', dueTo: '' });
  const [sort, setSort] = useState('');
  const [view, setView] = useState(null); // 'mine' | 'gave' | 'all'
  const [newOpen, setNewOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [dayEndOpen, setDayEndOpen] = useState(false); // End of day: every task's state today (founder 2026-10-27) // feedback to the R&D team (any department may send it)
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reports, setReports] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    const params = {};
    // The date boxes belong to the full table only.
    if (view === 'all') {
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
    }
    setLoading(true);
    api.get('/tasks', { params })
      .then((res) => setTasks(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load tasks.'))
      .finally(() => setLoading(false));
  }, [filters.from, filters.to, view]);

  useEffect(() => {
    api.get('/tasks/options')
      .then((res) => setOptions(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the task options.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const canGive = !!options?.canGive;
  const canPickEmployee = !!options?.canPickEmployee;
  const canAssignOthers = !!options?.canAssignOthers;
  const canReview = !!options?.canReview;
  const myId = options?.me?.id;

  // Open on the view that has work in it: yours first, otherwise the ones you gave.
  useEffect(() => {
    if (view !== null || !options || loading) return;
    const mineOpen = tasks.some((t) => t.assigneeId === myId && ['Not Started', 'In Progress', 'On Hold'].includes(t.status));
    const gaveAny = tasks.some((t) => t.assignedById === myId && t.assigneeId !== myId);
    setView(!mineOpen && canGive && gaveAny ? 'gave' : 'mine');
  }, [view, options, loading, tasks, myId, canGive]);

  const dlg = useTaskDialogs({ options: options || {}, reload: load, setNotice, setError });

  async function onStart(task) {
    setError(''); setNotice(''); setBusyId(task.id);
    try {
      await api.post(`/tasks/${task.id}/start`, {});
      setNotice(`"${task.name}" started. Add your hours as you work.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That could not be done.');
    } finally { setBusyId(''); }
  }

  // The assignee as the filters read them — the name the task was given to,
  // plus the employee ID and designation the list now carries.
  const assigneeOf = (t) => ({ ...(t.assignee || {}), name: t.assigneeName });
  const FACET_FIELDS = useMemo(() => [
    { key: 'priority', get: (t) => t.priority || 'Medium', label: (v) => PRI_WORD[v] || v },
    { key: 'status', get: (t) => [t.overdue ? 'Overdue' : t.status] }, // not finished + date passed = Overdue, counted once (never also as In Progress)
    { key: 'assigneeId', get: (t) => t.assigneeId, label: (v, t) => t.assigneeName },
    { key: 'department', get: (t) => t.department || (t.assignee && t.assignee.department) || '' },
    // TEAM-WISE (founder 2026-10-26): with a department picked, its teams (Team A / Team B ...) as a filter
    { key: 'team', get: (t) => (t.assignee && t.assignee.team) || 'No team' },
  ], []);
  const [team, setTeam] = useState('');
  useEffect(() => { setTeam(''); }, [filters.department]);
  const facetValues = { priority: pf.priority, status: pf.status, assigneeId: filters.assigneeId, department: filters.department, team };
  const facets = useLocalFacets(tasks, FACET_FIELDS, facetValues);
  const orderBy = (list, order) => [...list].sort((a, b) => (order.indexOf(a.value) < 0 ? 99 : order.indexOf(a.value)) - (order.indexOf(b.value) < 0 ? 99 : order.indexOf(b.value)));
  const taskDept = (t) => t.department || (t.assignee && t.assignee.department) || '';
  const shown = tasks.filter((t) => textMatches(`${t.name || ''} ${t.subTaskName || ''} ${t.description || ''} ${t.assigneeName || ''} ${t.assignedByName || ''}`, pf.q)
    && peopleMatches(t, pf, assigneeOf) && (!pf.review || (t.reviewState || 'Not Submitted') === pf.review)
    && (!pf.priority || (t.priority || 'Medium') === pf.priority)
    && (!pf.status || (pf.status === 'Overdue' ? t.overdue : (t.status === pf.status && !t.overdue)))
    && (!filters.assigneeId || t.assigneeId === filters.assigneeId)
    && (!filters.department || taskDept(t) === filters.department)
    && (!team || ((t.assignee && t.assignee.team) || 'No team') === team)
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
    { key: 'priority', label: 'Priority', value: pf.priority ? PRI_WORD[pf.priority] : '', onRemove: () => setP('priority', '') },
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

  // Task Reports: From - To dates (founder 2026-10-26: "task reports lo dates filter undali"). Empty = every task.
  const [repRange, setRepRange] = useState({ from: '', to: '' });
  async function openReports(range = repRange) {
    setError('');
    try {
      const res = await api.get('/tasks/reports', { params: { from: range.from || undefined, to: range.to || undefined } });
      setReports(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'The task report could not be built.');
    }
  }

  const OPEN = ['Not Started', 'In Progress', 'On Hold'];
  const mineCount = tasks.filter((t) => t.assigneeId === myId && OPEN.includes(t.status)).length;
  const gaveCount = tasks.filter((t) => t.assignedById === myId && t.assigneeId !== myId && OPEN.includes(t.status)).length;
  const viewsOn = canGive || canPickEmployee;
  const cur = view || 'mine';

  return (
    <div>
      {standalone ? (
        <div className="page-head">
          <div>
            <h1>Timesheet</h1>
            <div className="page-sub">{SUBTITLE}</div>
          </div>
        </div>
      ) : null}

      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {notice && <div className="tt-notice-ok" role="status">{notice}</div>}

      <div className="panel">
        <div className="panel-head">
          <h3>Tasks</h3>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => openReports()}>Task Reports</button>
            <button className="btn" onClick={() => setDayEndOpen(true)} title="Every task today: completed (TL approved), waiting for TL approval, partly done, in progress">End of day</button>
            <button className="btn" onClick={() => { setError(''); setNotice(''); setFeedbackOpen(true); }} disabled={!options} title="Send feedback to the R&D team">💬 Feedback to R&D</button>
            <IdeasBox />
            <button className="btn btn-primary" onClick={() => { setError(''); setNotice(''); setNewOpen(true); }} disabled={!options}>+ New task</button>
          </span>
        </div>
        <div className="panel-pad">
          {/* One row of big buttons: which tasks do you want to see. */}
          {viewsOn && (
            <div className="tt-views" role="group" aria-label="Which tasks">
              <button type="button" className={`tt-view${cur === 'mine' ? ' on' : ''}`} onClick={() => setView('mine')}>Given to me <b>{mineCount}</b></button>
              {canGive && <button type="button" className={`tt-view${cur === 'gave' ? ' on' : ''}`} onClick={() => setView('gave')}>Tasks I gave <b>{gaveCount}</b></button>}
              {canPickEmployee && <button type="button" className={`tt-view${cur === 'all' ? ' on' : ''}`} onClick={() => setView('all')}>{canGive ? 'My whole area' : 'Everyone'} <b>{tasks.length}</b></button>}
            </div>
          )}

          {!options && <div className="small-muted">Loading...</div>}
          {options && <LateStrip tasks={tasks} me={options.me.id} dlg={dlg} />}
          {options && cur === 'mine' && <GivenToMe tasks={tasks} options={options} dlg={dlg} busy={busyId} onStart={onStart} />}
          {options && cur === 'gave' && canGive && (
            <IGave tasks={tasks} options={options} dlg={dlg} busy={busyId} onStart={onStart} reload={load} setNotice={setNotice} setError={setError} />
          )}

          {options && cur === 'all' && canPickEmployee && (
            <>
              <div className="tt-bar">
                {/* Tasks: export everyone in scope (these filters) / one employee,
                    and import with the compulsory sample (backend src/io/timesheet.js). */}
                <DataIoBar
                  ioKey="timesheet"
                  params={{ department: filters.department, from: filters.from, to: filters.to, status: pf.status }}
                  onImported={load}
                />
              </div>
              {/* The list filter standard: Search · Department · Employee · Status
                  on screen, the rest under More Filters, active filters as chips. */}
              <div className="lf" style={{ marginBottom: 10 }}>
                <MoreFilters
                  storageKey="timesheet-tasks"
                  activeMore={moreOn}
                  onClearAll={taskFiltersOn ? clearTaskFilters : undefined}
                  primary={(
                    <>
                      <input type="search" placeholder="Search task, project or person…" value={pf.q} onChange={(e) => setP('q', e.target.value)} aria-label="Search" style={{ minWidth: 220 }} />
                      <FacetSelect label="Priority" allLabel="Any priority" value={pf.priority} onChange={(v) => setP('priority', v)} options={orderBy(facets.priority || [], PRIORITY_ORDER)} />
                      <FacetSelect label="Status" allLabel="Any status" value={pf.status} onChange={(v) => setP('status', v)} options={orderBy(facets.status || [], STATUS_ORDER)} />
                      <FacetSelect label="Employee" allLabel="Everyone" value={filters.assigneeId} onChange={(v) => setFilters((f) => ({ ...f, assigneeId: v }))}
                        options={(facets.assigneeId || []).slice().sort((a, b) => a.label.localeCompare(b.label))} />
                      <FacetSelect label="Department" allLabel="All departments" value={filters.department} onChange={(v) => setFilters((f) => ({ ...f, department: v }))} options={facets.department || []} />
                      {filters.department && <FacetSelect label="Team" allLabel="All teams" value={team} onChange={setTeam} options={facets.team || []} />}
                    </>
                  )}
                  extra={(
                    <>
                      <label className="lf-sort">
                        Sort
                        <Combo value={sort} onChange={(e) => setSort(e.target.value)}>
                          <option value="">Newest first</option>
                          <option value="start">Start date (latest first)</option>
                          <option value="due">Due date (soonest first)</option>
                          <option value="name">Task A–Z</option>
                        </Combo>
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
                  <span className="lf-dates" title="Due date">
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
                    <tr><th>Task</th><th>Priority</th><th>Start Date</th><th>Due Date</th><th>Hours</th><th>Progress</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {page.slice.map((t) => {
                      const r = t.rights || {};
                      return (
                        <tr key={t.id}>
                          <td>
                            <b>{t.name}</b>{' '}
                            <span className={`status ${t.overdue ? 'rejected' : statusClass(t.status)}`} title={t.overdue ? `Due ${ddmmyyyy(t.endDate)}, not finished` : undefined}>{t.overdue ? 'Overdue' : t.status}</span>{' '}
                            {t.reviewState && t.reviewState !== 'Not Submitted' && (
                              <span className={`status ${reviewClass(t.reviewState)}`}>{t.reviewState}</span>
                            )}
                            {t.subTaskName && <div className="small-muted">Project: {t.subTaskName}</div>}
                            <div className="small-muted">{t.department || '—'}</div>
                            <div className="small-muted">
                              Given to {t.assigneeName} · Given by {t.assignedByName}
                            </div>
                            {t.status === 'Cancelled' && <div className="small-muted">{cancelLine(t)}</div>}
                            <AddOnList t={t} me={myId} onChanged={load} setError={setError} />
                            <TaskFiles t={t} />
                            {t.reviewedByName && (
                              <div className="small-muted">
                                Checked by {t.reviewedByName}
                                {t.reviewNote ? ` — ${t.reviewNote}` : ''}
                              </div>
                            )}
                          </td>
                          <td><span className={`status ${priorityClass(t.priority)}`}>{PRI_WORD[t.priority || 'Medium']}</span></td>
                          <td className="cell-muted">{ddmmyyyy(t.startDate)}</td>
                          <td className="cell-muted">
                            {ddmmyyyy(t.endDate)}
                            {t.overdue && <div className="ts-late">{t.daysLate} day{t.daysLate === 1 ? '' : 's'} overdue</div>}
                          </td>
                          <td className="cell-muted">
                            {t.hoursLogged || 0} h{t.estimatedHours != null ? ` of ${t.estimatedHours} h` : ''}
                          </td>
                          <td className="cell-muted">
                            {t.completion}
                            {t.completedAt && t.status === 'Completed' && <div className="small-muted">on {ddmmyyyy(String(t.completedAt).slice(0, 10))}</div>}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {/* The workflow, in the order it happens. A button only
                                appears where its transition is actually available. */}
                            {(r.assignee || r.manage) && ['Not Started', 'On Hold'].includes(t.status) && (
                              <button className="btn btn-sm btn-primary" disabled={busyId === t.id} onClick={() => onStart(t)}>Start</button>
                            )}{' '}
                            {(r.assignee || r.manage) && t.status === 'In Progress' && (
                              <button className="btn btn-sm btn-primary" onClick={() => dlg.open('done', t)}>Mark as done</button>
                            )}{' '}
                            {canReview && r.manage && t.reviewState === 'Pending Review' && t.assigneeId !== myId && (
                              <button className="btn btn-sm" onClick={() => dlg.open('review', t)}>Check it</button>
                            )}{' '}
                            {t.assigneeId === myId && t.status !== 'Cancelled' && <button className="btn btn-sm" onClick={() => dlg.open('hours', t)}>Add hours</button>}{' '}
                            {r.manage && !['Completed', 'Cancelled'].includes(t.status) && <button className="btn btn-sm" onClick={() => dlg.open('edit', t)}>Change</button>}{' '}
                            {/* not done yet: give it to someone else, or add more work to it (founder 2026-10-26) */}
                            {r.manage && ['Not Started', 'In Progress', 'On Hold'].includes(t.status) && <button className="btn btn-sm" onClick={() => dlg.open('reassign', t)}>Give to someone else</button>}{' '}
                            {r.manage && ['Not Started', 'In Progress', 'On Hold'].includes(t.status) && <button className="btn btn-sm" title="Add more work to this task without changing it" onClick={() => dlg.open('addon', t)}>＋ Add-on</button>}{' '}
                            <button className="btn btn-sm btn-ghost" onClick={() => dlg.open('note', t)}>Notes {t.commentCount || 0}</button>
                          </td>
                        </tr>
                      );
                    })}
                    {!shown.length && (
                      <tr>
                        <td colSpan="7" className="small-muted" style={{ padding: loading ? 16 : 0 }}>
                          {loading ? 'Loading…' : <ListEmpty lf={{ activeCount: taskFiltersOn ? 1 : 0, clear: clearTaskFilters }} noun="tasks" title="No tasks yet." hint={'"+ New task" creates the first one.'} />}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {page.total > 0 && <Pager page={page} noun="tasks" />}
            </>
          )}
          {options?.scopeNote && <div className="small-muted" style={{ marginTop: 10 }}>{options.scopeNote}</div>}
        </div>
      </div>

      {/* hrms-24 §1 / §9 — hours worked (check-in to check-out) by period,
          department and employee, and the tasks in the range, for the people
          this Timesheet may show; with the per-employee export. */}
      <FeedbackSent tasks={tasks} myId={myId} />

      <div className="section-label" style={{ marginTop: 18 }}>Hours at work</div>
      <InsightsPanel module="timesheet" storageKey="tl_range_timesheet" />

      {/* ---- New task ----------------------------------------------------- */}
      {newOpen && options && (
        <TaskForm
          options={options}
          onClose={() => setNewOpen(false)}
          onSaved={(msg) => {
            setNewOpen(false); setNotice(msg);
            if (view !== 'gave' && canGive) setView('gave'); else if (!canGive) setView('mine');
            load();
          }}
        />
      )}
      {dayEndOpen && <DayEndDialog today={options && options.today} onClose={() => setDayEndOpen(false)} />}
      {feedbackOpen && (
        <FeedbackToRd
          onClose={() => setFeedbackOpen(false)}
          onSent={(msg) => { setFeedbackOpen(false); setNotice(msg); load(); }}
        />
      )}
      {dlg.node}

      {/* ---- Task Reports -------------------------------------------------- */}
      {reports && (
        <Modal
          title="Task Reports"
          size="wide"
          note={`${reports.total} task(s) in your scope${repRange.from || repRange.to ? ` · ${repRange.from ? ddmmyyyy(repRange.from) : 'start'} to ${repRange.to ? ddmmyyyy(repRange.to) : 'today'}` : ' · all dates'}`}
          onClose={() => setReports(null)}
          foot={<button className="btn" onClick={() => setReports(null)}>Close</button>}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <label className="field" style={{ margin: 0 }}><span>From</span><input type="date" value={repRange.from} onChange={(e) => setRepRange((r) => ({ ...r, from: e.target.value }))} /></label>
            <label className="field" style={{ margin: 0 }}><span>To</span><input type="date" value={repRange.to} onChange={(e) => setRepRange((r) => ({ ...r, to: e.target.value }))} /></label>
            <button className="btn btn-sm btn-primary" onClick={() => openReports(repRange)}>Apply</button>
            {(repRange.from || repRange.to) && <button className="btn btn-sm" onClick={() => { const r = { from: '', to: '' }; setRepRange(r); openReports(r); }}>All dates</button>}
            <span className="small-muted">A task counts when its start-to-due days fall in this range.</span>
          </div>
          {reports.total === 0 ? (
            <div className="empty-mini">
              There are no tasks for these dates, so there is nothing to report on.
            </div>
          ) : (
            <>
              <div className="statbar">
                <div className="statitem"><div className="n">{reports.total}</div><div className="l">Tasks</div></div>
                <div className="statitem"><div className="n">{reports.overdue}</div><div className="l">Overdue</div></div>
                <div className="statitem"><div className="n">{reports.dueToday}</div><div className="l">Due today</div></div>
                <div className="statitem"><div className="n">{reports.noDueDate}</div><div className="l">No due date</div></div>
                <div className="statitem"><div className="n">{reports.awaitingReview ?? 0}</div><div className="l">Waiting to be checked</div></div>
                <div className="statitem"><div className="n">{reports.approved ?? 0}</div><div className="l">Checked</div></div>
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
                          <tr key={r.priority}><td>{PRI_WORD[r.priority] || r.priority}</td><td>{r.total}</td><td>{r.open}</td><td>{r.overdue}</td></tr>
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
                      <th>Person</th><th>Total</th><th>Still to do</th><th>Done</th>
                      <th>Waiting to be checked</th><th>Checked</th><th>Overdue</th><th>Hours worked / planned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.byPerson.map((r) => (
                      <tr key={r.userId}>
                        <td>{r.name}</td><td>{r.total}</td><td>{r.open}</td><td>{r.completed}</td>
                        <td>{r.awaitingReview ?? 0}</td><td>{r.approved ?? 0}</td><td>{r.overdue}</td>
                        <td>{r.hoursLogged ?? 0} h{r.estimatedHours ? ` of ${r.estimatedHours} h` : ''}</td>
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
