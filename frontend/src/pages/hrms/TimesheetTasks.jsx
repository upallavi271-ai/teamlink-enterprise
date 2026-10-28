import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { AiAssist } from '../../components/ComposeForm.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import { useActiveDepartments, keepActive } from '../../utils/activeDepartments.js';
import './timesheet-tasks.css';

// ---------------------------------------------------------------------------
// TIMESHEET - tasks a lead gives to their team (2026-10-12).
//
//   <TaskForm>       the plain "New task" form (also used to edit)
//   <TaskCard>       one task as a card: the next step is the big button
//   <GivenToMe>      "Given to me" - the assignee's list
//   <IGave>          "Tasks I gave" - filters with counts, per-person summary,
//                    approve in one click, Excel / PDF of tasks and hours
//   useTaskDialogs   Add hours · Done · Move date · Give to someone else ·
//                    Cancel · Note · Check - one place, used by every list
//
// Everything is asked of the server (/api/tasks); the buttons only show what
// the row's `rights` allow and the API refuses the rest. Plain words: Overdue,
// Done, Normal priority. Four colours: green done / blue going on / orange
// waiting / red problem.
// ---------------------------------------------------------------------------

export const PRI_WORD = { High: 'High', Medium: 'Normal', Low: 'Low' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dmy(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y && m && d ? `${Number(d)} ${MON[Number(m) - 1]} ${y}` : iso;
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The words and the colour for a task's state.
export function stateOf(t) {
  if (t.status === 'Cancelled') return { word: 'Cancelled', tone: 'grey' };
  if (t.status === 'Completed') {
    // founder 2026-10-27: done is COMPLETED only after the TL approves it
    if (t.reviewState === 'Approved') return { word: 'Completed (TL approved)', tone: 'green' };
    if (t.reviewState === 'Changes Requested') return { word: 'Needs changes', tone: 'red' };
    if (t.reviewState === 'Pending Review') return { word: `Done - waiting for ${t.approver ? `${t.approver}'s` : 'TL'} approval`, tone: 'orange' };
    return { word: 'Completed', tone: 'green' };
  }
  if (t.overdue) return { word: 'Overdue', tone: 'red' };
  if (t.status === 'In Progress') return { word: 'Working on it', tone: 'blue' };
  if (t.status === 'On Hold') return { word: 'On hold', tone: 'orange' };
  return { word: 'Not started', tone: 'orange' };
}
export function dueOf(t, today) {
  if (!t.endDate) return { text: 'No due date', tone: '' };
  if (['Completed', 'Cancelled'].includes(t.status)) return { text: `Due ${dmy(t.endDate)}`, tone: '' };
  const d = dayDiff(today, t.endDate);
  if (d < 0) return { text: `${plural(-d, 'day')} overdue`, tone: 'red' };
  if (d === 0) return { text: 'Due today', tone: 'orange' };
  if (d === 1) return { text: 'Due tomorrow', tone: 'orange' };
  return { text: `Due ${dmy(t.endDate)}`, tone: '' };
}
const hoursText = (n) => (Math.round(Number(n || 0) * 100) / 100).toString();

// "Cancelled on 26 Oct 2026 by Divya - reason" (founder 2026-10-26: the day a task was cancelled must show)
export function cancelLine(t) {
  if (t.status !== 'Cancelled') return null;
  const on = t.cancelledAt ? ` on ${dmy(String(t.cancelledAt).slice(0, 10))}` : '';
  const by = t.cancelledByName ? ` by ${t.cancelledByName}` : '';
  return `Cancelled${on}${by}${t.cancelReason ? ` - ${t.cancelReason}` : ''}`;
}

// FILES (founder 2026-10-26: "marked as done lo uploads option kuda pettu"): photos / documents on a task.
const FILE_ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf,.doc,.docx';
export async function uploadTaskFiles(taskId, files) {
  const failed = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    // eslint-disable-next-line no-await-in-loop
    try { await api.post(`/tasks/${taskId}/files`, fd); } catch (er) { failed.push(`${file.name}: ${apiError(er, 'could not be uploaded')}`); }
  }
  return failed;
}
export function TaskFiles({ t }) {
  const list = t.files || [];
  if (!list.length) return null;
  async function open(f) {
    const w = window.open('', '_blank');
    try {
      const r = await api.get(`/tasks/${t.id}/files/${f.id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      if (w) w.location.href = url; else window.location.href = url;
    } catch { if (w) w.close(); }
  }
  return (
    <div className="small-muted" style={{ marginTop: 6 }}>
      <b>Files ({list.length}):</b>{' '}
      {list.map((f, i) => (
        <span key={f.id}>{i ? ' · ' : ''}<button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} onClick={() => open(f)} title={`Added by ${f.uploadedByName}`}>{f.contentType && f.contentType.startsWith('image/') ? '🖼' : '📄'} {f.fileName}</button></span>
      ))}
    </div>
  );
}

// ADD-ONS: more work added onto a task (instead of changing it). The person ticks each one when it is done.
export function AddOnList({ t, me, onChanged, setError }) {
  const list = t.addOns || [];
  if (!list.length) return null;
  const r = t.rights || {};
  const mayTick = r.assignee || r.manage || t.assigneeId === me;
  async function tick(a) {
    try { await api.patch(`/tasks/${t.id}/addons/${a.id}`, { done: !a.done }); onChanged(); } catch (er) { setError(apiError(er, 'That could not be saved.')); }
  }
  async function drop(a) {
    if (!window.confirm(`Remove the add-on "${a.text}"?`)) return;
    try { await api.delete(`/tasks/${t.id}/addons/${a.id}`); onChanged(); } catch (er) { setError(apiError(er, 'That could not be removed.')); }
  }
  return (
    <div className="tt-addons">
      <div className="small-muted" style={{ fontWeight: 600, marginTop: 6 }}>Add-ons ({list.filter((a) => a.done).length} of {list.length} done)</div>
      {list.map((a) => (
        <div key={a.id} className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 2 }}>
          <input type="checkbox" checked={a.done} disabled={!mayTick} onChange={() => tick(a)} aria-label={`Done: ${a.text}`} />
          <span style={{ textDecoration: a.done ? 'line-through' : 'none' }}>
            {a.text}{a.dueDate ? ` (by ${dmy(a.dueDate)})` : ''} <span style={{ opacity: 0.75 }}>- added by {a.addedByName}{a.done && a.doneAt ? `, done ${dmy(String(a.doneAt).slice(0, 10))}` : ''}</span>
          </span>
          {r.manage && !a.done && <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 6px' }} onClick={() => drop(a)} title="Remove this add-on">✕</button>}
        </div>
      ))}
    </div>
  );
}

function apiError(err, fallback) {
  const d = err && err.response && err.response.data;
  return (d && d.error) || fallback;
}

// ---------------------------------------------------------------------------
// FEEDBACK TO THE R&D TEAM (founder, 2026-10-24): any department can send feedback to R&D from the Timesheet. It becomes a task for one
// R&D person (the one picked, or whoever is least busy), shows in their Timesheet, and the sender follows it in "Feedback I sent".
// ---------------------------------------------------------------------------
export const FEEDBACK_TAG = 'Feedback to R&D';

export function FeedbackToRd({ onClose, onSent }) {
  const [opts, setOpts] = useState(null);
  const [f, setF] = useState({ subject: '', details: '', priority: 'Medium', assigneeId: '' });
  const [errs, setErrs] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get('/tasks/feedback/options').then((r) => setOpts(r.data)).catch((er) => setError(apiError(er, 'The R&D team could not be loaded.')));
  }, []);
  const set = (p) => setF((v) => ({ ...v, ...p }));
  async function save(e) {
    e.preventDefault();
    const next = {};
    if (!f.subject.trim()) next.subject = 'Say in a few words what the feedback is about.';
    if (!f.details.trim()) next.details = 'Write the feedback for the R&D team.';
    setErrs(next);
    if (Object.keys(next).length) return;
    setSaving(true); setError('');
    try {
      const r = await api.post('/tasks/feedback', { subject: f.subject, details: f.details, priority: f.priority, assigneeId: f.assigneeId || undefined });
      onSent(`Your feedback is with ${r.data.givenTo} in the R&D team. You can follow it under "Feedback I sent".`);
    } catch (er) { setError(apiError(er, 'That could not be sent.')); setSaving(false); }
  }
  return (
    <Modal
      title="Feedback to the R&D team"
      onClose={onClose}
      foot={(
        <>
          <button className="btn" type="button" onClick={onClose}>Close</button>
          <button className="btn btn-primary" type="submit" form="tt-feedback" disabled={saving || !opts || !opts.available}>{saving ? 'Sending...' : 'Send to R&D'}</button>
        </>
      )}
    >
      <form id="tt-feedback" onSubmit={save} noValidate>
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        {opts && !opts.available && <div className="error-text" style={{ marginBottom: 10 }}>Nobody in the R&D team has a login yet, so feedback cannot be sent. Tell the Super Admin.</div>}
        <div className="small-muted" style={{ marginBottom: 10 }}>Your feedback goes to the R&D team as a task. They can see who sent it and reply on it.</div>
        <label className="field"><span>What is it about</span>
          <input value={f.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="For example: The attendance page is slow" autoFocus />
          {errs.subject && <p className="error-text">{errs.subject}</p>}
        </label>
        <label className="field"><span>Your feedback</span>
          <textarea rows="4" value={f.details} onChange={(e) => set({ details: e.target.value })} placeholder="Tell them what you saw, what you expected, or what you want changed" />
          {errs.details && <p className="error-text">{errs.details}</p>}
        </label>
        <label className="field"><span>How important</span>
          <Combo value={f.priority} onChange={(e) => set({ priority: e.target.value })}>
            {(opts ? opts.priorities : ['High', 'Medium', 'Low']).map((p) => <option key={p} value={p}>{PRI_WORD[p] || p}</option>)}
          </Combo>
        </label>
        <label className="field"><span>Who in R&D</span>
          <Combo value={f.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })}>
            <option value="">Anyone — the one with the fewest open tasks</option>
            {(opts ? opts.people : []).map((p) => (
              <option key={p.userId} value={p.userId}>{p.name}{p.designation ? ` · ${p.designation}` : ''}{p.open ? ` · ${plural(p.open, 'open task')}` : ' · free now'}</option>
            ))}
          </Combo>
        </label>
      </form>
    </Modal>
  );
}

// The feedback this person sent, with where each one stands. Shown only when there is something to show.
export function FeedbackSent({ tasks, myId }) {
  const rows = (tasks || []).filter((t) => t.assignedById === myId && t.subTaskName === FEEDBACK_TAG);
  if (!rows.length) return null;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head"><h3>Feedback I sent</h3></div>
      <div className="panel-pad">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>About</th><th>With (R&D)</th><th>Status</th><th>Sent</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{String(t.name).replace(/^Feedback:\s*/, '')}</td>
                  <td>{t.assigneeName}</td>
                  <td>{t.status === 'Completed' && t.reviewState === 'Pending Review' ? 'Done — waiting for your check' : t.status}</td>
                  <td>{dmy(t.startDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The New task / Edit task form
// ---------------------------------------------------------------------------
// A team as it is worth showing: 'Team-A' -> 'Team A'; a bare 'Team', '-', 'NA' ... is no team at all.
const JUNK_TEAM = new Set(['team', '-', '--', 'na', 'n/a', 'none', 'nil', '0', '.']);
export function teamOf(p) {
  const t = String((p && p.team) || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || JUNK_TEAM.has(t.toLowerCase())) return '';
  return t.replace(/^team\s+([a-z0-9]+)$/i, (m, x) => `Team ${x.toUpperCase()}`);
}

export function TaskForm({ options, task, onClose, onSaved }) {
  const editing = !!task;
  const me = options.me || {};
  const canGive = !!options.canGive && !editing;
  const today = options.today || new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    name: task ? task.name : '',
    description: task ? (task.description || '') : '',
    project: task ? (task.subTaskName || '') : '',
    priority: task ? (task.priority || 'Medium') : 'Medium',
    startDate: task ? (task.startDate || today) : today,
    endDate: task ? (task.endDate || '') : '',
    estimate: task && task.estimatedHours != null ? String(task.estimatedHours) : '',
  });
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [team, setTeam] = useState('');
  // designation group (Super Admin / HR / STL / TL / Manager / Assistant Manager / Employees), from the HRMS role
  const [role, setRole] = useState('');
  const [errs, setErrs] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    api.get('/projects').then((r) => setProjects((r.data || []).filter((p) => (p.status || 'Active') === 'Active').map((p) => p.name))).catch(() => {});
  }, []);

  const set = (patch) => { setF((x) => ({ ...x, ...patch })); setErrs((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => delete n[k]); return n; }); };
  const people = options.assignable || [];
  const liveDepts = useActiveDepartments(); // only switched-on Department & Team names get a chip

  // Department and Team chips with counts: each is counted over the people the
  // OTHER choices leave (search included), and a choice with nobody is not shown.
  const matchQ = (p) => !q.trim() || `${p.name} ${p.designation || ''} ${p.employeeCode || ''}`.toLowerCase().includes(q.trim().toLowerCase());
  const countBy = (list, key) => {
    const m = new Map();
    list.forEach((p) => { const v = p[key]; if (v) m.set(v, (m.get(v) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const base = people.filter(matchQ);
  const okRole = (p) => !role || p.roleGroup === role;
  // TEAMS (founder 2026-10-27): only once a department is picked, and only real teams - Education's Team A / Team B. A department
  // with one team (its seats say just "Team") or a placeholder word shows no Team row.
  const teams = (() => {
    if (!dept) return [];
    const m = new Map();
    base.filter((p) => p.department === dept && okRole(p)).forEach((p) => { const t = teamOf(p); if (t) m.set(t, (m.get(t) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  })();
  const depts = keepActive(liveDepts, countBy(base.filter((p) => (!team || teamOf(p) === team) && okRole(p)), 'department'), ([d]) => d, dept);
  const ROLE_ORDER = ['Super Admin', 'HR', 'STL', 'TL', 'Manager', 'Assistant Manager', 'Employees'];
  const roleCount = (r) => base.filter((p) => (!dept || p.department === dept) && (!team || teamOf(p) === team) && p.roleGroup === r).length;
  const shown = base.filter((p) => (!dept || p.department === dept) && (!team || teamOf(p) === team) && okRole(p));

  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShownOn = shown.length > 0 && shown.every((p) => picked.has(p.userId));
  const toggleShown = () => setPicked((s) => {
    const n = new Set(s);
    if (allShownOn) shown.forEach((p) => n.delete(p.userId)); else shown.forEach((p) => n.add(p.userId));
    return n;
  });

  async function save(e) {
    e.preventDefault();
    const er = {};
    if (!f.name.trim()) er.name = 'Please type the task name.';
    if (!f.startDate) er.startDate = 'Pick the day it starts.';
    if (f.startDate && f.endDate && f.endDate < f.startDate) er.endDate = 'The due date cannot be before the start date.';
    if (f.estimate !== '' && !(Number(f.estimate) >= 0 && Number(f.estimate) <= 1000)) er.estimate = 'Type hours like 6 or 1.5.';
    if (canGive && !picked.size) er.assignee = 'Tick at least one person.';
    if (Object.keys(er).length) { setErrs(er); setError('Please fix the red messages.'); return; }
    setError(''); setSaving(true);
    const body = {
      name: f.name.trim(), description: f.description, subTaskName: f.project.trim(), priority: f.priority,
      startDate: f.startDate, endDate: f.endDate || null, estimatedHours: f.estimate === '' ? null : Number(f.estimate),
    };
    try {
      if (editing) {
        const res = await api.put(`/tasks/${task.id}`, body);
        onSaved(res.data && res.data.unchanged ? 'Nothing was changed.' : `Saved "${f.name.trim()}".`);
      } else {
        const ids = canGive ? [...picked] : [me.id];
        const res = await api.post('/tasks', { ...body, assigneeIds: ids });
        const d = res.data;
        onSaved(d.created === 1
          ? `Task given to ${d.assigneeName}. They have it in their Timesheet now.`
          : `${d.created} tasks created, one for each of the ${d.created} people. They have them in their Timesheet now.`);
      }
    } catch (err) {
      const data = (err.response && err.response.data) || {};
      if (data.field) setErrs({ [data.field === 'assigneeId' ? 'assignee' : data.field === 'estimatedHours' ? 'estimate' : data.field]: data.error });
      setError(data.error || 'That task could not be saved.');
    } finally { setSaving(false); }
  }

  return (
    <Modal
      title={editing ? 'Change this task' : 'New task'}
      size="wide"
      onClose={onClose}
      foot={(
        <>
          <button className="btn" type="button" onClick={onClose}>Close</button>
          <button className="btn btn-primary" type="submit" form="tt-form" disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save' : picked.size > 1 ? `Give to ${picked.size} people` : 'Give task'}
          </button>
        </>
      )}
    >
      <form id="tt-form" onSubmit={save} noValidate>
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        <label className="field"><span>Task name</span>
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="For example: Call 20 new candidates" autoFocus />
          {errs.name && <p className="error-text">{errs.name}</p>}
        </label>
        <div className="field compose-form"><span>What to do</span>
          <AiAssist kind="task" title={f.name} text={f.description} onText={(description) => set({ description })} />
          <textarea rows="3" value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Write the steps in simple words (optional)" />
        </div>

        {canGive && (
          <div className="field"><span>Give to</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search anyone by name" aria-label="Search people" style={{ marginBottom: 8 }} />
            {depts.length > 1 && (
              <div className="tt-chips" role="group" aria-label="Department">
                <button type="button" className={`tt-chip${!dept ? ' on' : ''}`} onClick={() => setDept('')}>All departments <b>{base.filter((p) => !team || teamOf(p) === team).length}</b></button>
                {depts.map(([d, n]) => (
                  <button type="button" key={d} className={`tt-chip${dept === d ? ' on' : ''}`} onClick={() => { setDept(dept === d ? '' : d); setTeam(''); }}>{d} <b>{n}</b></button>
                ))}
              </div>
            )}
            {teams.length > 1 && (
              <div className="tt-chips" role="group" aria-label="Team">
                <button type="button" className={`tt-chip${!team ? ' on' : ''}`} onClick={() => setTeam('')}>All of {dept} <b>{base.filter((p) => p.department === dept && okRole(p)).length}</b></button>
                {teams.map(([t, n]) => (
                  <button type="button" key={t} className={`tt-chip${team === t ? ' on' : ''}`} onClick={() => setTeam(team === t ? '' : t)}>{t} <b>{n}</b></button>
                ))}
              </div>
            )}
            {people.some((p) => p.roleGroup) && (
              <div className="tt-chips" role="group" aria-label="Designation">
                <button type="button" className={`tt-chip${!role ? ' on' : ''}`} onClick={() => setRole('')}>All designations <b>{base.filter((p) => (!dept || p.department === dept) && (!team || teamOf(p) === team)).length}</b></button>
                {ROLE_ORDER.map((r) => {
                  const n = roleCount(r);
                  return <button type="button" key={r} className={`tt-chip${role === r ? ' on' : ''}`} disabled={!n && role !== r} onClick={() => setRole(role === r ? '' : r)}>{r} <b>{n}</b></button>;
                })}
              </div>
            )}
            <div className="tt-people" role="group" aria-label="People">
              {shown.slice(0, 300).map((p) => (
                <label key={p.userId} className={`tt-person${picked.has(p.userId) ? ' on' : ''}`}>
                  <input type="checkbox" checked={picked.has(p.userId)} onChange={() => toggle(p.userId)} />
                  <span>
                    <span className="tt-pn">{p.self ? `${p.name} (me)` : p.name}</span>
                    <span className="tt-ps">{[p.designation, p.department, teamOf(p)].filter(Boolean).join(' · ')}{p.open ? ` · ${plural(p.open, 'open task')}` : ' · free now'}</span>
                  </span>
                </label>
              ))}
              {!shown.length && <div className="small-muted" style={{ padding: 12 }}>{people.length ? 'Nobody matches. Clear the search or the filters.' : 'There is nobody to give a task to yet.'}</div>}
            </div>
            <div className="tt-bar" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm" onClick={toggleShown} disabled={!shown.length}>{allShownOn ? 'Untick everyone shown' : `Tick everyone shown (${shown.length})`}</button>
              {picked.size > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>Clear</button>}
            </div>
            <div className="tt-picked">{picked.size ? `${picked.size} ${picked.size === 1 ? 'person' : 'people'} picked${picked.size > 1 ? ' - each one gets their own task' : ''}` : 'Nobody picked yet'}</div>
            {errs.assignee && <p className="error-text">{errs.assignee}</p>}
          </div>
        )}
        {!canGive && !editing && <div className="small-muted" style={{ marginBottom: 12 }}>This task is for you.</div>}
        {editing && <div className="small-muted" style={{ marginBottom: 12 }}>Given to {task.assigneeName}. To move it to someone else, use "Give to someone else" on the task.</div>}

        <div className="field"><span>How urgent</span>
          <div className="tt-pri-btns" role="group" aria-label="Priority">
            {['Low', 'Medium', 'High'].map((p) => (
              <button type="button" key={p} className={`tt-pri-btn ${p}${f.priority === p ? ' on' : ''}`} onClick={() => set({ priority: p })}>{PRI_WORD[p]}</button>
            ))}
          </div>
        </div>
        <div className="tt-two">
          <label className="field"><span>Starts on</span>
            <input type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            {errs.startDate && <p className="error-text">{errs.startDate}</p>}
          </label>
          <label className="field"><span>Due on</span>
            <input type="date" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            {errs.endDate && <p className="error-text">{errs.endDate}</p>}
          </label>
          <label className="field"><span>Hours it should take</span>
            <input type="number" inputMode="decimal" min="0" max="1000" step="0.25" value={f.estimate} onChange={(e) => set({ estimate: e.target.value })} placeholder="Optional, like 6" />
            {errs.estimate && <p className="error-text">{errs.estimate}</p>}
          </label>
          <label className="field"><span>Project or job</span>
            <input list="tt-projects" value={f.project} onChange={(e) => set({ project: e.target.value })} placeholder="Optional" />
            <datalist id="tt-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          </label>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// One task as a card
// ---------------------------------------------------------------------------
// LATE TASKS (founder 2026-10-27): past the due day, the person writes WHY + the NEW day; the giver (for a self-given task: their
// reporting manager / lead) approves - the date moves - or says no. Shown on the card; the bell carries the same.
export function LateBox({ t, mine, r, dlg }) {
  const d = t.lastDelay;
  const open = ['Not Started', 'In Progress', 'On Hold'].includes(t.status);
  if (!open) return null;
  if (t.delayPending && d) {
    const decide = !mine && r.manage;
    return (
      <div className="tt-late wait">
        <div><b>{mine ? 'You asked' : `${d.askedByName} asked`} for more time</b>: due {dmy(d.oldDate)} → <b>{dmy(d.newDate)}</b></div>
        <div>Why late: {d.reason}</div>
        {decide
          ? <div className="tt-late-acts"><button className="btn btn-primary btn-sm" onClick={() => dlg.open('delayDecide', t)}>Approve or say no</button></div>
          : <div className="small-muted">Waiting for the answer.</div>}
      </div>
    );
  }
  if (!t.needsReason) return null;
  const no = d && d.status === 'Rejected' ? d : null;
  return (
    <div className="tt-late">
      <div><b>{t.daysLate} {t.daysLate === 1 ? 'day' : 'days'} late</b> - it was due {dmy(t.endDate)}.{mine ? ' Write why it is late and the new day you will finish it.' : ` ${t.assigneeName} has not said why yet.`}</div>
      {no && <div>Last ask ({dmy(no.newDate)}) - {no.decidedByName} said no: {no.decideNote}</div>}
      {mine && <div className="tt-late-acts"><button className="btn btn-primary btn-sm" onClick={() => dlg.open('delay', t)}>Ask for more time</button></div>}
    </div>
  );
}

// The strip on top of the Timesheet: my late tasks with no reason yet, and the asks waiting for me.
export function LateStrip({ tasks, me, dlg }) {
  const owe = tasks.filter((t) => t.assigneeId === me && t.needsReason);
  const asks = tasks.filter((t) => t.assigneeId !== me && t.delayPending && t.rights && t.rights.manage);
  if (!owe.length && !asks.length) return null;
  return (
    <div className="tt-late-strip">
      {owe.length > 0 && (
        <div className="tt-late">
          <b>{owe.length === 1 ? '1 of your tasks is late' : `${owe.length} of your tasks are late`}.</b> For each one, write why and the new day.
          <div className="tt-late-list">
            {owe.map((t) => <button type="button" key={t.id} className="btn btn-sm" onClick={() => dlg.open('delay', t)}>{t.name} · {t.daysLate} {t.daysLate === 1 ? 'day' : 'days'} late</button>)}
          </div>
        </div>
      )}
      {asks.length > 0 && (
        <div className="tt-late wait">
          <b>{asks.length === 1 ? '1 person asks' : `${asks.length} people ask`} for more time.</b>
          <div className="tt-late-list">
            {asks.map((t) => <button type="button" key={t.id} className="btn btn-sm" onClick={() => dlg.open('delayDecide', t)}>{t.assigneeName}: {t.name} → {dmy(t.lastDelay.newDate)}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

// END OF DAY (founder 2026-10-27): every task's state today - completed (TL approved), waiting for TL approval, partly done,
// in progress, not started, sent back, late - one row per person. The Super Admin / HR see everyone, a lead their own people.
const DAY_TONE = { completed: 'green', waiting: 'orange', sentback: 'red', partial: 'blue', inprogress: 'blue', onhold: 'orange', notstarted: 'grey' };
export function DayEndDialog({ onClose, today }) {
  const [day, setDay] = useState(today || new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [only, setOnly] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setErr('');
    api.get('/tasks/day-end', { params: { date: day } }).then((r) => { if (live) setData(r.data); }).catch((e) => { if (live) setErr(apiError(e, 'The end-of-day list could not be opened.')); });
    return () => { live = false; };
  }, [day]);
  const people = data ? data.people.map((p) => ({ ...p, tasks: p.tasks.filter((t) => !only || (only === 'late' ? t.late : t.state === only)) })).filter((p) => p.tasks.length) : [];
  return (
    <Modal title="End of day - task status" wide onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
      <label className="small-muted tt-date">Day <input type="date" value={day} onChange={(e) => setDay(e.target.value || day)} /></label>
      {err && <div className="error-text">{err}</div>}
      {!data && !err && <div className="small-muted">Loading...</div>}
      {data && (
        <>
          <div className="tt-chips" role="group" aria-label="Show" style={{ margin: '10px 0' }}>
            <button type="button" className={`tt-chip${!only ? ' on' : ''}`} onClick={() => setOnly('')}>All <b>{data.total}</b></button>
            {data.states.filter((s) => data.counts[s.key] > 0).map((s) => (
              <button type="button" key={s.key} className={`tt-chip ${DAY_TONE[s.key]}${only === s.key ? ' on' : ''}`} onClick={() => setOnly(only === s.key ? '' : s.key)}>{s.label} <b>{data.counts[s.key]}</b></button>
            ))}
            {data.late > 0 && <button type="button" className={`tt-chip red${only === 'late' ? ' on' : ''}`} onClick={() => setOnly(only === 'late' ? '' : 'late')}>Late <b>{data.late}</b></button>}
          </div>
          {!people.length && <div className="empty-mini">No task to show for this day.</div>}
          {people.map((p) => (
            <div key={p.userId} style={{ marginBottom: 12 }}>
              <div className="tt-name">{p.name}<span className="small-muted">{[p.employeeCode, p.department, p.tl ? `TL ${p.tl}` : 'no TL on file'].filter(Boolean).join(' · ') ? ` · ${[p.employeeCode, p.department, p.tl ? `TL ${p.tl}` : 'no TL on file'].filter(Boolean).join(' · ')}` : ''}</span></div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Task</th><th>Status</th><th>Given by</th><th>Due</th><th className="num">Hours today</th><th className="num">Hours in all</th></tr></thead>
                  <tbody>
                    {p.tasks.map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td><span className={`tt-state ${DAY_TONE[t.state]}`}>{t.label}</span>{t.late && <span className="tt-state red" style={{ marginLeft: 4 }}>{t.daysLate} {t.daysLate === 1 ? 'day' : 'days'} late</span>}{t.why && <div className="small-muted">{t.why}</div>}</td>
                        <td>{t.givenBy}</td>
                        <td>{t.due ? dmy(t.due) : '—'}</td>
                        <td className="num">{hoursText(t.hoursToday)}</td>
                        <td className="num">{hoursText(t.hoursTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

export function TaskCard({ t, me, today, canReview, who, dlg, onStart, busy }) {
  const st = stateOf(t);
  const due = dueOf(t, today);
  const r = t.rights || {};
  const mine = t.assigneeId === me;
  const open = ['Not Started', 'In Progress', 'On Hold'].includes(t.status);
  const est = t.estimatedHours;
  const pct = est ? Math.min(100, Math.round(((t.hoursLogged || 0) / est) * 100)) : 0;
  const waiting = t.reviewState === 'Pending Review';
  return (
    <div className={`tt-card ${st.tone}`}>
      <div className="tt-card-top">
        <div>
          <div className="tt-name">{t.name}</div>
          <div className="tt-meta">
            <span className={`tt-state ${st.tone}`}>{st.word}</span>
            <span className={`tt-pri ${t.priority || 'Medium'}`}>{PRI_WORD[t.priority || 'Medium']}</span>
            {who === 'from' && <span>From <b>{t.assignedByName}</b></span>}
            {who === 'to' && <span>For <b>{t.assigneeName}</b></span>}
            {t.subTaskName && <span>Project: {t.subTaskName}</span>}
          </div>
        </div>
        <div className={`tt-due ${due.tone}`}>{due.text}</div>
      </div>
      {t.description && <div className="tt-notes">{t.description}</div>}
      <LateBox t={t} mine={mine} r={r} dlg={dlg} />
      {t.status === 'Cancelled' && <div className="tt-notes">{cancelLine(t)}</div>}
      <AddOnList t={t} me={me} onChanged={() => dlg.reload()} setError={dlg.setError} />
      <TaskFiles t={t} />
      {t.reviewState === 'Changes Requested' && t.reviewNote && <div className="tt-notes">{t.reviewedByName} asked for changes: {t.reviewNote}</div>}
      {(t.hoursLogged > 0 || est != null) && (
        <div className="tt-hours">
          <b>{hoursText(t.hoursLogged)} h</b> worked{est != null ? ` of ${hoursText(est)} h planned` : ''}
          {est ? <div className="tt-bar-track"><div className={`tt-bar-fill${(t.hoursLogged || 0) > est ? ' over' : ''}`} style={{ width: `${pct}%` }} /></div> : null}
        </div>
      )}
      <div className="tt-actions">
        {mine && open && (t.status === 'In Progress'
          ? <button className="btn btn-primary btn-sm" onClick={() => dlg.open('done', t)}>Mark as done</button>
          : <button className="btn btn-primary btn-sm" disabled={busy === t.id} onClick={() => onStart(t)}>Start</button>)}
        {mine && t.status !== 'Cancelled' && <button className="btn btn-sm" onClick={() => dlg.open('hours', t)}>Add hours</button>}
        {mine && open && t.status !== 'In Progress' && <button className="btn btn-sm" onClick={() => dlg.open('done', t)}>Mark as done</button>}
        {!mine && (r.assignee || r.manage) && t.status !== 'Cancelled' && <button className="btn btn-sm" onClick={() => dlg.open('hours', t)}>See hours</button>}
        {r.review && waiting && <button className="btn btn-primary btn-sm" onClick={() => dlg.open('review', t)}>Check it and approve</button>}
        {r.manage && open && !(mine && t.overdue) && <button className="btn btn-sm" onClick={() => dlg.open('extend', t)}>Move date</button>}
        {r.manage && open && <button className="btn btn-sm" onClick={() => dlg.open('reassign', t)}>Give to someone else</button>}
        {r.manage && open && <button className="btn btn-sm" title="Add more work to this task without changing it" onClick={() => dlg.open('addon', t)}>＋ Add-on</button>}
        {r.manage && t.status !== 'Completed' && t.status !== 'Cancelled' && <button className="btn btn-sm" onClick={() => dlg.open('edit', t)}>Change</button>}
        {r.manage && open && <button className="btn btn-sm" onClick={() => dlg.open('cancel', t)}>Cancel task</button>}
        {r.manage && (t.status === 'Completed' || t.status === 'Cancelled') && <button className="btn btn-sm" onClick={() => dlg.open('reopen', t)}>Open it again</button>}
        <button className="btn btn-sm btn-ghost" onClick={() => dlg.open('note', t)}>Notes {t.commentCount ? `(${t.commentCount})` : ''}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialogs, in one place
// ---------------------------------------------------------------------------
export function useTaskDialogs({ options, reload, setNotice, setError }) {
  const [d, setD] = useState(null); // { kind, task }
  const open = (kind, task) => { setError(''); setNotice(''); setD({ kind, task }); };
  const close = () => setD(null);
  const done = (msg) => { close(); if (msg) setNotice(msg); reload(); };
  let node = null;
  if (d) {
    const props = { task: d.task, options, onClose: close, onDone: done, setError };
    if (d.kind === 'edit') node = <TaskForm options={options} task={d.task} onClose={close} onSaved={done} />;
    else if (d.kind === 'hours') node = <HoursDialog {...props} />;
    else if (d.kind === 'done') node = <DoneDialog {...props} />;
    else if (d.kind === 'cancel') node = <CancelDialog {...props} />;
    else if (d.kind === 'extend') node = <ExtendDialog {...props} />;
    else if (d.kind === 'reassign') node = <ReassignDialog {...props} />;
    else if (d.kind === 'review') node = <ReviewDialog {...props} />;
    else if (d.kind === 'reopen') node = <ReopenDialog {...props} />;
    else if (d.kind === 'note') node = <NoteDialog {...props} />;
    else if (d.kind === 'addon') node = <AddOnDialog {...props} />;
    else if (d.kind === 'delay') node = <DelayDialog {...props} />;
    else if (d.kind === 'delayDecide') node = <DelayDecideDialog {...props} />;
  }
  return { node, open, close, reload, setError };
}

function Footer({ onClose, busy, label, form, danger }) {
  return (
    <>
      <button className="btn" type="button" onClick={onClose}>Close</button>
      {label && <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} type="submit" form={form} disabled={busy}>{busy ? 'Saving...' : label}</button>}
    </>
  );
}

function DoneDialog({ task, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const done = await api.post(`/tasks/${task.id}/complete`, { note });
      const approver = done && done.data ? done.data.approver : null;
      const failed = files.length ? await uploadTaskFiles(task.id, files) : [];
      const added = files.length - failed.length;
      onDone(`"${task.name}" is marked as done${added ? ` with ${added} file${added === 1 ? '' : 's'}` : ''}. It counts as completed after ${approver ? `${approver} (your TL)` : 'your TL'} approves it.${failed.length ? ` Not uploaded: ${failed.join('; ')}` : ''}`);
    } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="Mark as done" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Mark as done" form="tt-done" />}>
      <form id="tt-done" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 8 }}>{task.name}</div>
        <label className="field"><span>What did you do? (optional)</span>
          <textarea rows="3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: Called all 20, 6 are interested" />
        </label>
        <label className="field"><span>Photos or documents (optional)</span>
          <input type="file" multiple accept={FILE_ACCEPT} onChange={(e) => setFiles([...e.target.files].slice(0, 10))} />
        </label>
        {files.length > 0 && <div className="small-muted" style={{ marginBottom: 8 }}>{files.map((x) => x.name).join(', ')} - photos (PNG, JPEG, WebP), PDF or Word, 5 MB each</div>}
        <div className="small-muted">Add your hours first with "Add hours" so your lead can see the time you spent.</div>
      </form>
    </Modal>
  );
}

function CancelDialog({ task, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    if (!reason.trim()) { setErr('Say why you are cancelling it.'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/tasks/${task.id}/cancel`, { reason }); onDone(`"${task.name}" is cancelled. ${task.assigneeName} has been told.`); } catch (er) { setErr(apiError(er, 'That could not be cancelled.')); setBusy(false); }
  }
  return (
    <Modal title="Cancel this task" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Cancel task" form="tt-cancel" danger />}>
      <form id="tt-cancel" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>For {task.assigneeName}</div>
        <label className="field"><span>Why?</span>
          <textarea rows="3" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: The client cancelled this job" autoFocus />
        </label>
      </form>
    </Modal>
  );
}

function ExtendDialog({ task, onClose, onDone }) {
  const [date, setDate] = useState(task.endDate || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    if (!date) { setErr('Pick the new due date.'); return; }
    setBusy(true); setErr('');
    try { const r = await api.post(`/tasks/${task.id}/extend`, { endDate: date, reason }); onDone(r.data && r.data.unchanged ? 'The date is the same, nothing changed.' : `Due date moved to ${dmy(date)}. ${task.assigneeName} has been told.`); } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="Move the due date" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Save new date" form="tt-extend" />}>
      <form id="tt-extend" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>For {task.assigneeName} - now due {task.endDate ? dmy(task.endDate) : 'with no date'}</div>
        <label className="field"><span>New due date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span>Why? (optional)</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Waiting for the client" /></label>
      </form>
    </Modal>
  );
}

function DelayDialog({ task, onClose, onDone }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const min = new Date().toISOString().slice(0, 10);
  async function go(e) {
    e.preventDefault();
    if (reason.trim().length < 5) { setErr('Write why it is late, in a few words.'); return; }
    if (!date) { setErr('Pick the new day you will finish it.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/tasks/${task.id}/delay`, { reason: reason.trim(), newDate: date });
      const who = (r.data && r.data.askedFrom && r.data.askedFrom.length) ? r.data.askedFrom.join(', ') : 'your lead';
      onDone(`Asked ${who} for ${dmy(date)}. The due day moves when they approve.`);
    } catch (er) { setErr(apiError(er, 'That could not be sent.')); setBusy(false); }
  }
  return (
    <Modal title="Ask for more time" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Send" form="tt-delay" />}>
      <form id="tt-delay" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>It was due {dmy(task.endDate)}{task.daysLate ? ` - ${task.daysLate} ${task.daysLate === 1 ? 'day' : 'days'} late` : ''}.</div>
        <label className="field"><span>Why is it late?</span><textarea rows="3" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Waiting for the data from Accounts" /></label>
        <label className="field"><span>New day you will finish it</span><input type="date" value={date} min={min} onChange={(e) => setDate(e.target.value)} /></label>
      </form>
    </Modal>
  );
}

function DelayDecideDialog({ task, onClose, onDone }) {
  const d = task.lastDelay || {};
  const [approve, setApprove] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    if (!approve && note.trim().length < 3) { setErr('Write why not, so they know what to do.'); return; }
    setBusy(true); setErr('');
    try {
      await api.post(`/tasks/${task.id}/delay/${d.id}/decision`, { approve, note: note.trim() });
      onDone(approve ? `Approved. New due day: ${dmy(d.newDate)}. ${task.assigneeName} has been told.` : `Said no. ${task.assigneeName} has been told; the task stays late.`);
    } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="More time asked" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label={approve ? 'Approve' : 'Say no'} form="tt-delay-decide" danger={!approve} />}>
      <form id="tt-delay-decide" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 8 }}>{d.askedByName} · due {dmy(d.oldDate)} → asks for <b>{dmy(d.newDate)}</b></div>
        <div className="tt-notes" style={{ marginBottom: 10 }}>Why late: {d.reason}</div>
        <div className="tt-chips" role="group" aria-label="Decision">
          <button type="button" className={`tt-chip green${approve ? ' on' : ''}`} onClick={() => setApprove(true)}>Approve - move the date</button>
          <button type="button" className={`tt-chip red${!approve ? ' on' : ''}`} onClick={() => setApprove(false)}>Say no</button>
        </div>
        <label className="field"><span>{approve ? 'Note (optional)' : 'Why not?'}</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={approve ? 'For example: OK, but no more delays' : 'For example: The client needs it today'} /></label>
      </form>
    </Modal>
  );
}

function AddOnDialog({ task, onClose, onDone }) {
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    if (text.trim().length < 3) { setErr('Write what more has to be done.'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/tasks/${task.id}/addons`, { text, dueDate: due || null }); onDone(`Add-on added to "${task.name}". ${task.assigneeName} has been told.`); } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="Add more work (add-on)" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Add it" form="tt-addon" />}>
      <form id="tt-addon" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>For {task.assigneeName}. The task stays as it was given; this is added below it.</div>
        <label className="field"><span>What more has to be done?</span>
          <textarea rows="3" value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: Also call the 5 candidates from last week" autoFocus />
        </label>
        <label className="field"><span>By when? (optional)</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      </form>
    </Modal>
  );
}

function ReassignDialog({ task, options, onClose, onDone }) {
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list = (options.assignable || []).filter((p) => p.userId !== task.assigneeId && `${p.name} ${p.designation || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  async function go(e) {
    e.preventDefault();
    if (!pick) { setErr('Pick who should do it now.'); return; }
    setBusy(true); setErr('');
    try { const r = await api.post(`/tasks/${task.id}/reassign`, { assigneeId: pick, note }); onDone(`"${task.name}" now belongs to ${r.data.assigneeName}. Both of you have been told.`.replace('Both of you', `${task.assigneeName} and ${r.data.assigneeName}`)); } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="Give to someone else" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Give it to them" form="tt-reassign" />}>
      <form id="tt-reassign" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>Now with {task.assigneeName}. Hours already worked stay on the task.</div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search my team" aria-label="Search my team" style={{ marginBottom: 8 }} />
        <div className="tt-people" role="radiogroup" aria-label="Who should do it now">
          {list.map((p) => (
            <label key={p.userId} className={`tt-person${pick === p.userId ? ' on' : ''}`}>
              <input type="radio" name="tt-re" checked={pick === p.userId} onChange={() => setPick(p.userId)} />
              <span><span className="tt-pn">{p.self ? `${p.name} (me)` : p.name}</span><span className="tt-ps">{[p.designation, p.department].filter(Boolean).join(' · ')}{p.open ? ` · ${plural(p.open, 'open task')}` : ' · free now'}</span></span>
            </label>
          ))}
          {!list.length && <div className="small-muted" style={{ padding: 12 }}>Nobody else in your team matches.</div>}
        </div>
        <label className="field" style={{ marginTop: 12 }}><span>Message to them (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </form>
    </Modal>
  );
}

function ReviewDialog({ task, onClose, onDone }) {
  const [decision, setDecision] = useState('approve');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    if (decision === 'changes' && !note.trim()) { setErr('Say what needs to change.'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/tasks/${task.id}/review`, { decision, note }); onDone(decision === 'approve' ? `"${task.name}" is checked and approved.` : `"${task.name}" was sent back to ${task.assigneeName}.`); } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="Check the finished task" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label={decision === 'approve' ? 'Approve' : 'Send back'} form="tt-review" />}>
      <form id="tt-review" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>Done by {task.assigneeName} - {hoursText(task.hoursLogged)} h worked{task.estimatedHours != null ? ` of ${hoursText(task.estimatedHours)} h planned` : ''}</div>
        <div className="tt-pri-btns" style={{ marginBottom: 12 }}>
          <button type="button" className={`tt-pri-btn${decision === 'approve' ? ' on Low' : ''}`} onClick={() => setDecision('approve')}>It is good</button>
          <button type="button" className={`tt-pri-btn${decision === 'changes' ? ' on High' : ''}`} onClick={() => setDecision('changes')}>It needs changes</button>
        </div>
        <label className="field"><span>{decision === 'changes' ? 'What needs to change?' : 'Message (optional)'}</span>
          <textarea rows="3" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

function ReopenDialog({ task, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.put(`/tasks/${task.id}`, { status: 'In Progress' }); onDone(`"${task.name}" is open again.`); } catch (er) { setErr(apiError(er, 'That could not be saved.')); setBusy(false); }
  }
  return (
    <Modal title="Open it again" onClose={onClose} foot={<Footer onClose={onClose} busy={busy} label="Open it again" form="tt-reopen" />}>
      <form id="tt-reopen" onSubmit={go}>
        {err && <div className="error-text">{err}</div>}
        <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
        <div className="small-muted">It goes back to "Working on it" for {task.assigneeName}.</div>
      </form>
    </Modal>
  );
}

function NoteDialog({ task, onClose, setError }) {
  const [rows, setRows] = useState(null);
  const [draft, setDraft] = useState('');
  useEffect(() => { api.get(`/tasks/${task.id}/comments`).then((r) => setRows(r.data.comments)).catch((e) => { setError(apiError(e, 'Those notes could not be opened.')); setRows([]); }); }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function add(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    try { const r = await api.post(`/tasks/${task.id}/comments`, { text: draft.trim() }); setRows((x) => [...(x || []), r.data]); setDraft(''); } catch (er) { setError(apiError(er, 'That note could not be saved.')); }
  }
  return (
    <Modal title="Notes" onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="tt-name" style={{ marginBottom: 8 }}>{task.name}</div>
      {rows === null ? <div className="small-muted">Loading...</div> : rows.length ? (
        <div className="timeline">
          {rows.map((c) => (
            <div className="timeline-item" key={c.id}>
              <div className="timeline-date">{new Date(c.createdAt).toLocaleString()} · {c.authorName}</div>
              <div className="timeline-label" style={{ fontWeight: 400 }}>{c.text}</div>
            </div>
          ))}
        </div>
      ) : <div className="empty-mini">No notes yet. Write how it is going, so everyone can see.</div>}
      <form onSubmit={add} style={{ marginTop: 14 }}>
        <label className="field"><span>Write a note</span><textarea rows="2" value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!draft.trim()}>Save note</button>
      </form>
    </Modal>
  );
}

function HoursDialog({ task, options, onClose, onDone, setError }) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ date: today, hours: '', note: '', reason: '' });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.get(`/tasks/${task.id}/hours`).then((r) => setData(r.data)).catch((e) => setErr(apiError(e, 'The hours could not be opened.')));
  useEffect(() => { load(); }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { /* the list behind refreshes when the dialog closes */ };
  async function save(e) {
    e.preventDefault(); setErr('');
    if (!(Number(form.hours) > 0)) { setErr('Type the hours you worked, like 1.5.'); return; }
    setBusy(true);
    try {
      if (editing) {
        await api.put(`/tasks/${task.id}/hours/${editing.id}`, { hours: Number(form.hours), date: form.date, note: form.note, reason: form.reason });
      } else {
        await api.post(`/tasks/${task.id}/hours`, { hours: Number(form.hours), date: form.date, note: form.note });
      }
      setForm({ date: today, hours: '', note: '', reason: '' }); setEditing(null); changed(); await load();
    } catch (er) { setErr(apiError(er, 'Those hours could not be saved.')); } finally { setBusy(false); }
  }
  async function remove(en) {
    let reason = '';
    if (!en.mine) { reason = window.prompt('Why are you removing these hours?') || ''; if (!reason.trim()) return; }
    setErr('');
    try { await api.delete(`/tasks/${task.id}/hours/${en.id}`, { data: { reason } }); await load(); } catch (er) { setErr(apiError(er, 'Those hours could not be removed.')); }
  }
  const startEdit = (en) => { setEditing(en); setForm({ date: en.date, hours: String(en.hours), note: en.note || '', reason: '' }); };
  const canLog = data && data.canLog;
  return (
    <Modal title={data && data.canLog ? 'Add your hours' : 'Hours on this task'} onClose={() => onDone('')} foot={<button className="btn btn-primary" onClick={() => onDone('')}>Done</button>}>
      <div className="tt-name" style={{ marginBottom: 4 }}>{task.name}</div>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        {data ? <><b>{hoursText(data.logged)} h</b> worked{data.estimated != null ? ` of ${hoursText(data.estimated)} h planned` : ''}</> : 'Loading...'}
      </div>
      {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
      {(canLog || editing) && (
        <form onSubmit={save} style={{ marginBottom: 14 }}>
          <div className="tt-two">
            <label className="field"><span>Which day</span><input type="date" value={form.date} max={today} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="field"><span>How many hours</span>
              <input type="number" inputMode="decimal" min="0.25" max="24" step="0.25" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="like 1.5" />
              <div className="tt-hrs-quick">{[0.5, 1, 2, 4].map((h) => <button type="button" key={h} className="btn btn-sm" onClick={() => setForm({ ...form, hours: String(h) })}>{h}</button>)}</div>
            </label>
          </div>
          <label className="field"><span>Note (optional)</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What did you do?" /></label>
          {editing && !editing.mine && <label className="field"><span>Why are you changing it?</span><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>}
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? 'Saving...' : editing ? 'Save change' : 'Add hours'}</button>{' '}
          {editing && <button className="btn btn-sm" type="button" onClick={() => { setEditing(null); setForm({ date: today, hours: '', note: '', reason: '' }); }}>Stop changing</button>}
        </form>
      )}
      {data && !data.canLog && !data.entries.length && <div className="small-muted">Only {task.assigneeName} can add hours here. Nothing is added yet.</div>}
      {data && data.entries.length > 0 && (
        <div>
          <div className="section-label">Hours added</div>
          {data.entries.map((en) => (
            <div className="tt-entry" key={en.id}>
              <span><b>{hoursText(en.hours)} h</b> on {dmy(en.date)}{en.note ? ` - ${en.note}` : ''}{!en.mine ? ` (${en.byName})` : ''}</span>
              {en.canEdit && data.task.status !== 'Cancelled' && (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => startEdit(en)}>Change</button>
                  <button className="btn btn-sm" onClick={() => remove(en)}>Remove</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Given to me
// ---------------------------------------------------------------------------
export function GivenToMe({ tasks, options, dlg, busy, onStart }) {
  const me = options.me.id;
  const today = options.today;
  const mine = useMemo(() => tasks.filter((t) => t.assigneeId === me), [tasks, me]);
  const [f, setF] = useState('open');
  const groups = {
    open: mine.filter((t) => ['Not Started', 'In Progress', 'On Hold'].includes(t.status)),
    late: mine.filter((t) => t.overdue),
    done: mine.filter((t) => t.status === 'Completed'),
    cancelled: mine.filter((t) => t.status === 'Cancelled'),
  };
  const rank = (t) => (t.overdue ? 0 : t.status === 'In Progress' ? 1 : 2);
  const shown = (f === 'all' ? mine : groups[f] || []).slice().sort((a, b) => rank(a) - rank(b) || String(a.endDate || '9999').localeCompare(String(b.endDate || '9999')));
  const chips = [['open', 'To do', 'blue'], ['late', 'Overdue', 'red'], ['done', 'Done', 'green'], ['cancelled', 'Cancelled', 'grey'], ['all', 'Everything', '']];
  return (
    <div>
      <p className="tt-lead">Tasks your lead gave you, and tasks you added for yourself. Start one, add your hours each day, then mark it as done.</p>
      <div className="tt-chips" role="group" aria-label="Show">
        {chips.filter(([k]) => k === 'open' || k === 'all' || (groups[k] || []).length).map(([k, label, tone]) => (
          <button type="button" key={k} className={`tt-chip ${tone}${f === k ? ' on' : ''}`} onClick={() => setF(k)}>{label} <b>{k === 'all' ? mine.length : groups[k].length}</b></button>
        ))}
      </div>
      <div className="tt-list">
        {shown.map((t) => <TaskCard key={t.id} t={t} me={me} today={today} who={t.assignedById === me ? '' : 'from'} dlg={dlg} onStart={onStart} busy={busy} canReview={options.canReview} />)}
        {!shown.length && (
          <div className="empty-mini">
            {f === 'open' ? (mine.length ? 'Nothing left to do. Well done!' : 'No tasks for you yet. When your lead gives you one, it shows up here and in your bell.') : 'Nothing here.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks I gave
// ---------------------------------------------------------------------------
const DUE_CHIPS = [['late', 'Overdue', 'red'], ['today', 'Due today', 'orange'], ['week', 'Next 7 days', 'blue'], ['later', 'Later', ''], ['none', 'No date', 'grey']];
function dueBucket(t, today) {
  if (['Completed', 'Cancelled'].includes(t.status)) return 'closed';
  if (!t.endDate) return 'none';
  const d = dayDiff(today, t.endDate);
  if (d < 0) return 'late';
  if (d === 0) return 'today';
  if (d <= 7) return 'week';
  return 'later';
}

export function IGave({ tasks, options, dlg, busy, onStart, reload, setNotice, setError }) {
  const me = options.me.id;
  const today = options.today;
  const mine = useMemo(() => tasks.filter((t) => t.assignedById === me), [tasks, me]);
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState('');
  const [due, setDue] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const inPeriod = (t) => (!from || !t.endDate || t.endDate >= from) && (!to || !t.startDate || t.startDate <= to);
  const rows = useMemo(() => mine.filter(inPeriod), [mine, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const FIELDS = useMemo(() => [
    { key: 'person', get: (t) => t.assigneeId, label: (v, t) => t.assigneeName },
    { key: 'status', get: (t) => (t.overdue ? ['Overdue'] : [t.status === 'Completed' && t.reviewState === 'Pending Review' ? 'Waiting to be checked' : t.status]) },
    { key: 'due', get: (t) => dueBucket(t, today) },
  ], [today]);
  const facets = useLocalFacets(rows, FIELDS, { person, status, due });
  const shown = rows.filter((t) => (!person || t.assigneeId === person)
    && (!status || (status === 'Overdue' ? t.overdue : status === 'Waiting to be checked' ? (t.status === 'Completed' && t.reviewState === 'Pending Review') : (t.status === status && !t.overdue)))
    && (!due || dueBucket(t, today) === due));

  // Per-person summary over the people / dates / status chosen (not the person).
  const summaryBase = rows.filter((t) => (!status || (status === 'Overdue' ? t.overdue : status === 'Waiting to be checked' ? (t.status === 'Completed' && t.reviewState === 'Pending Review') : (t.status === status && !t.overdue))) && (!due || dueBucket(t, today) === due));
  const summary = useMemo(() => {
    const m = new Map();
    summaryBase.forEach((t) => {
      const r = m.get(t.assigneeId) || { id: t.assigneeId, name: t.assigneeName, open: 0, done: 0, late: 0, waiting: 0, logged: 0, est: 0 };
      if (['Not Started', 'In Progress', 'On Hold'].includes(t.status)) r.open += 1;
      if (t.status === 'Completed') r.done += 1;
      if (t.overdue) r.late += 1;
      if (t.reviewState === 'Pending Review') r.waiting += 1;
      r.logged += t.hoursLogged || 0;
      r.est += t.estimatedHours || 0;
      m.set(t.assigneeId, r);
    });
    return [...m.values()].sort((a, b) => b.late - a.late || b.open - a.open || a.name.localeCompare(b.name));
  }, [summaryBase]);

  const waiting = shown.filter((t) => t.reviewState === 'Pending Review' && t.assigneeId !== me);
  const [approving, setApproving] = useState(false);
  async function approveAll() {
    setApproving(true); setError('');
    try {
      const r = await api.post('/tasks/review-batch', { ids: waiting.map((t) => t.id) });
      setNotice(`${plural(r.data.approved, 'finished task')} checked and approved.${r.data.skipped.length ? ` ${r.data.skipped.length} skipped.` : ''}`);
      reload();
    } catch (er) { setError(apiError(er, 'Those could not be approved.')); } finally { setApproving(false); }
  }
  const [exporting, setExporting] = useState('');
  async function exportAs(format) {
    setExporting(format); setError('');
    try {
      const params = { format, given: 1 };
      if (from) params.from = from;
      if (to) params.to = to;
      if (person) params.assigneeId = person;
      if (status && status !== 'Waiting to be checked') params.status = status;
      const res = await api.get('/tasks/export', { params, responseType: 'blob' });
      const cd = res.headers['content-disposition'] || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = (m && m[1]) || `tasks-and-hours.${format}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
      setNotice(`${format === 'xlsx' ? 'Excel' : 'PDF'} file is ready.`);
    } catch (er) {
      let msg = 'The file could not be made.';
      const data = er.response && er.response.data;
      if (data instanceof Blob) { try { msg = JSON.parse(await data.text()).error || msg; } catch { /* keep */ } } else if (data && data.error) msg = data.error;
      setError(msg);
    } finally { setExporting(''); }
  }

  const any = person || status || due || from || to;
  const clear = () => { setPerson(''); setStatus(''); setDue(''); setFrom(''); setTo(''); };
  const STATUS_ORDER = ['Overdue', 'Not Started', 'In Progress', 'On Hold', 'Waiting to be checked', 'Completed', 'Cancelled'];
  const statusFacets = (facets.status || []).slice().sort((a, b) => STATUS_ORDER.indexOf(a.value) - STATUS_ORDER.indexOf(b.value));
  const dueFacets = DUE_CHIPS.map(([k, label, tone]) => ({ k, label, tone, n: ((facets.due || []).find((x) => x.value === k) || {}).count || 0 })).filter((x) => x.n > 0 || due === x.k);
  const tone = (s) => ({ Overdue: 'red', Completed: 'green', 'In Progress': 'blue', Cancelled: 'grey' }[s] || 'orange');
  const wordOf = (s) => ({ 'Not Started': 'Not started', 'In Progress': 'Working on it', 'On Hold': 'On hold', Completed: 'Done' }[s] || s);

  if (!mine.length) {
    return (
      <div className="empty-mini">
        You have not given any task yet. Press <b>New task</b>, pick the people in your team, and they get it in their Timesheet at once.
      </div>
    );
  }
  return (
    <div>
      <div className="tt-bar">
        <label className="small-muted tt-date">From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From day" /></label>
        <label className="small-muted tt-date">To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To day" /></label>
        <span className="tt-grow" />
        {waiting.length > 0 && options.canReview && <button className="btn btn-primary" onClick={approveAll} disabled={approving}>{approving ? 'Approving...' : `Approve all finished (${waiting.length})`}</button>}
        {options.canExport && <button className="btn" onClick={() => exportAs('xlsx')} disabled={!!exporting}>{exporting === 'xlsx' ? 'Making Excel...' : 'Excel'}</button>}
        {options.canExport && <button className="btn" onClick={() => exportAs('pdf')} disabled={!!exporting}>{exporting === 'pdf' ? 'Making PDF...' : 'PDF'}</button>}
      </div>

      <div className="tt-bar">
        <FacetSelect label="Person" allLabel="Everyone" value={person} onChange={setPerson} options={(facets.person || []).slice().sort((a, b) => a.label.localeCompare(b.label))} />
        {any && <button className="btn btn-sm btn-ghost" onClick={clear}>Clear filters</button>}
        <span className="small-muted">{any ? `${shown.length} of ${mine.length} tasks` : plural(mine.length, 'task')}</span>
      </div>
      <div className="tt-chips" role="group" aria-label="Status">
        <button type="button" className={`tt-chip${!status ? ' on' : ''}`} onClick={() => setStatus('')}>Any status</button>
        {statusFacets.map((o) => <button type="button" key={o.value} className={`tt-chip ${tone(o.value)}${status === o.value ? ' on' : ''}`} onClick={() => setStatus(status === o.value ? '' : o.value)}>{wordOf(o.value)} <b>{o.count}</b></button>)}
      </div>
      <div className="tt-chips" role="group" aria-label="Due">
        <button type="button" className={`tt-chip${!due ? ' on' : ''}`} onClick={() => setDue('')}>Any due date</button>
        {dueFacets.map((o) => <button type="button" key={o.k} className={`tt-chip ${o.tone}${due === o.k ? ' on' : ''}`} onClick={() => setDue(due === o.k ? '' : o.k)}>{o.label} <b>{o.n}</b></button>)}
      </div>

      {summary.length > 0 && (
        <>
          <div className="section-label">Each person</div>
          <table className="tt-sum">
            <thead><tr><th>Person</th><th className="num">Still to do</th><th className="num">Done</th><th className="num">Overdue</th><th className="num">Hours worked / planned</th><th /></tr></thead>
            <tbody>
              {summary.map((r) => (
                <tr key={r.id} className={person === r.id ? 'on' : ''}>
                  <td className="who">{r.name}</td>
                  <td className="num" data-l="Still to do">{r.open}</td>
                  <td className="num" data-l="Done">{r.done}</td>
                  <td className={`num${r.late ? ' red' : ''}`} data-l="Overdue">{r.late}</td>
                  <td className="num" data-l="Hours">{hoursText(r.logged)} h{r.est ? ` of ${hoursText(r.est)} h` : ''}</td>
                  <td className="num"><button className="btn btn-sm" onClick={() => setPerson(person === r.id ? '' : r.id)}>{person === r.id ? 'Show all' : 'Show tasks'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="tt-list">
        {shown.map((t) => <TaskCard key={t.id} t={t} me={me} today={today} who="to" dlg={dlg} onStart={onStart} busy={busy} canReview={options.canReview} />)}
        {!shown.length && <div className="empty-mini">No task matches. <button className="btn btn-sm" onClick={clear}>Clear filters</button></div>}
      </div>
    </div>
  );
}
