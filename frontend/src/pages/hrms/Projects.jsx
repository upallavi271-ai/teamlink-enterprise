import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, canManageDevelopment, canEditDevelopment } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { peopleMatches, peopleOptions, statusOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import AudiencePicker, { DeliverVia, audienceReady } from '../../components/AudiencePicker.jsx';
import {
  ComposeModal, Field, Row, CheckLine, ResultNote, useSubmit,
} from '../../components/ComposeForm.jsx';
import EmployeeStatusTag from '../../components/EmployeeStatusTag.jsx';

// A project's own states (schema: Active | Completed | On Hold). The person
// filters read its assignments: a project stays when anyone on it matches, and
// only the matching people are listed under it.
const PROJECT_STATUSES = ['Active', 'Completed', 'On Hold'];
const EMPTY_PROJECT_FILTERS = { q: '', code: '', name: '', department: '', role: '', empStatus: '', status: '', from: '', to: '' };
// ACTIVE EMPLOYEES FIRST (founder 2026-11-14): each project lists the people who are still on it; Employee status brings back the Exited / Relieved
// assignees (their status is written beside the name). Employee status only shapes the people listed under a project: every project stays on the
// page, and the counts are unchanged.
const OPENING_PROJECT_FILTERS = { ...EMPTY_PROJECT_FILTERS, empStatus: 'Active' };
const PROJECT_SORTS = [
  ['new', 'Newest first', (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))],
  ['name', 'Name A–Z', (a, b) => String(a.name || '').localeCompare(String(b.name || ''))],
  ['people', 'Most people', (a, b) => (b.assignments || []).length - (a.assignments || []).length],
];
const pickError = (a) => (a.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.');

// The reference compose layout. A project can be staffed as it is created:
// the shared AudiencePicker assigns one person, several, one or MANY
// departments, or everyone in scope — one assignment per person.
function NewProjectModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', status: 'Active', role: '' });
  const [staffNow, setStaffNow] = useState(false);
  const [audience, setAudience] = useState({ mode: 'individuals', departments: [], employeeIds: [] });
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    if (!form.name.trim()) { setError('Enter the project name.'); return; }
    if (staffNow && !audienceReady(audience)) { setError(pickError(audience)); return; }
    const body = { name: form.name.trim(), status: form.status };
    if (staffNow) Object.assign(body, { audience, channels, role: form.role || null });
    const res = await run(() => api.post('/projects', body), 'Could not create the project');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="New Project" onClose={onClose} onSubmit={submit} submitLabel="Create Project" busy={busy} error={error} wide={staffNow}>
      <Field label="Project name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Status">
        <Combo value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          {PROJECT_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </Combo>
      </Field>
      <CheckLine checked={staffNow} onChange={setStaffNow}>Assign people now</CheckLine>
      {staffNow && (
        <>
          <AudiencePicker value={audience} onChange={setAudience} label="Assign to" required />
          <Field label="Role on the project"><input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="Optional — e.g. Developer" /></Field>
          <DeliverVia value={channels} onChange={setChannels} />
        </>
      )}
    </ComposeModal>
  );
}

// Staff an existing project — same picker; people already on it are skipped.
function AssignProjectModal({ project, onClose, onSaved }) {
  const [role, setRole] = useState('');
  const [audience, setAudience] = useState({ mode: 'individuals', departments: [], employeeIds: [] });
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    if (!audienceReady(audience)) { setError(pickError(audience)); return; }
    const res = await run(() => api.post(`/projects/${project.id}/assign`, { audience, channels, role: role || null }), 'Could not assign people');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title={`Assign People — ${project.name}`} onClose={onClose} onSubmit={submit} submitLabel="Assign" busy={busy} error={error} wide>
      <AudiencePicker value={audience} onChange={setAudience} label="Assign to" required />
      <Row>
        <Field label="Role on the project"><input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Optional — e.g. Developer" /></Field>
        <div />
      </Row>
      <DeliverVia value={channels} onChange={setChannels} />
    </ComposeModal>
  );
}

export default function Projects() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageDevelopment(user);
  // Staffing an existing project is its own write (P&D edit on the API).
  const canStaff = hasHrmsAdmin(user) && canEditDevelopment(user);
  // The person filters are for a login that sees other people on projects; an
  // employee's own read lists only their own assignment.
  const seesOthers = hasHrmsAdmin(user);
  const [sort, setSort] = useState('new');
  const [projects, setProjects] = useState([]);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(null);
  const [done, setDone] = useState('');
  const [pf, setPf] = useState(OPENING_PROJECT_FILTERS);

  function load() {
    api.get('/projects').then((res) => setProjects(res.data));
  }
  useEffect(load, []);

  const staffed = (r) => (r.assigned != null
    ? `${r.assigned} assigned (${r.label})${r.alreadyOn ? ` · ${r.alreadyOn} already on it` : ''}. ${r.deliveryText || ''}`
    : '');

  const personOn = pf.code || pf.name || pf.department || pf.role;
  // Employee status is drawn only for a login that sees other people on projects (and then it only shapes the assignee lines).
  const personFilters = { ...pf, status: '', empStatus: seesOthers ? pf.empStatus : '' };
  const sameButStatus = { ...personFilters, empStatus: '' };
  const shown = projects
    .filter((p) => textMatches(p.name, pf.q) && (!pf.status || p.status === pf.status)
      && peopleMatches(p, { from: pf.from, to: pf.to }, undefined, undefined, (r) => r.createdAt))
    .map((p) => ({
      ...p,
      assignments: p.assignments.filter((a) => peopleMatches(a, personFilters)),
      // assignees kept out only because of Employee status (people who have left)
      leftHidden: p.assignments.filter((a) => peopleMatches(a, sameButStatus) && !peopleMatches(a, personFilters)).length,
    }))
    .filter((p) => !personOn || p.assignments.length || p.leftHidden)
    .sort((PROJECT_SORTS.find(([k]) => k === sort) || PROJECT_SORTS[0])[2]);
  const page = usePaged(shown);
  const opts = peopleOptions(projects.flatMap((p) => p.assignments));
  const pfLike = { activeCount: Object.values(pf).filter(Boolean).length, clear: () => setPf(EMPTY_PROJECT_FILTERS) };

  return (
    <div>
      <div className="page-head"><h1>Projects</h1></div>

      {isHR && (
        <div className="qa-row" style={{ marginBottom: 14 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New Project</button>
        </div>
      )}
      <ResultNote>{done}</ResultNote>
      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onSaved={(p) => { setCreating(false); setDone(`Project "${p.name}" created. ${staffed(p)}`); load(); }}
        />
      )}
      {assigning && (
        <AssignProjectModal
          project={assigning}
          onClose={() => setAssigning(null)}
          onSaved={(r) => { setDone(`${assigning.name}: ${staffed(r)}`); setAssigning(null); load(); }}
        />
      )}

      <PeopleFilterBar
        filters={pf} setFilters={setPf} search="Project name" people={seesOthers} activeFirst
        departments={seesOthers ? opts.departments : undefined} roles={seesOthers ? opts.roles : undefined}
        statuses={statusOptions(projects, PROJECT_STATUSES)} shown={shown.length} total={projects.length}
        dates="Created on"
      >
        <label className="lf-sort">
          Sort
          <Combo value={sort} onChange={(e) => setSort(e.target.value)}>
            {PROJECT_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Combo>
        </label>
      </PeopleFilterBar>

      {page.slice.map((p) => (
        <div className="card section" key={p.id}>
          <h3>{p.name} <span className="status">{p.status}</span></h3>
          {p.assignments.map((a) => (
            <div className="kv" key={a.id}><span className="k">{a.employee?.name}<EmployeeStatusTag employee={a.employee} /></span><span>{a.role || '—'}</span></div>
          ))}
          {p.assignments.length === 0 && !p.leftHidden && <div className="small-muted">No one assigned yet.</div>}
          {p.leftHidden > 0 && (
            <div className="small-muted">{p.assignments.length === 0 ? 'No one who is still here is assigned. ' : ''}{p.leftHidden} {p.leftHidden === 1 ? 'person who has' : 'people who have'} left {p.leftHidden === 1 ? 'is' : 'are'} not listed: choose Employee status → All.</div>
          )}
          {canStaff && (
            <div className="qa-row" style={{ marginTop: 10 }}>
              <button className="btn btn-sm" onClick={() => setAssigning(p)}>+ Assign people</button>
            </div>
          )}
        </div>
      ))}
      {shown.length === 0 ? <ListEmpty lf={pfLike} noun="projects" /> : <Pager page={page} noun="projects" />}
    </div>
  );
}
