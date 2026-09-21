import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';


export default function Projects() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ name: '' });
  const [assignForm, setAssignForm] = useState({});

  function load() {
    api.get('/projects').then((res) => setProjects(res.data));
  }
  useEffect(() => {
    load();
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data));
  }, [isHR]);

  async function createProject(e) {
    e.preventDefault();
    await api.post('/projects', form);
    setForm({ name: '' });
    load();
  }

  async function assign(projectId) {
    const employeeId = assignForm[projectId];
    if (!employeeId) return;
    await api.post(`/projects/${projectId}/assign`, { employeeId });
    setAssignForm({ ...assignForm, [projectId]: '' });
    load();
  }

  return (
    <div>
      <div className="page-head"><h1>Projects</h1></div>

      {isHR && (
        <form className="card section" onSubmit={createProject}>
          <div className="filter-row">
            <input required placeholder="Project name" value={form.name} onChange={(e) => setForm({ name: e.target.value })} />
            <button className="btn btn-sm btn-primary" type="submit">Add project</button>
          </div>
        </form>
      )}

      {projects.map((p) => (
        <div className="card section" key={p.id}>
          <h3>{p.name} <span className="status">{p.status}</span></h3>
          {p.assignments.map((a) => (
            <div className="kv" key={a.id}><span className="k">{a.employee?.name}</span><span>{a.role || '—'}</span></div>
          ))}
          {p.assignments.length === 0 && <div className="small-muted">No one assigned yet.</div>}
          {isHR && (
            <div className="filter-row" style={{ marginTop: 10 }}>
              <select value={assignForm[p.id] || ''} onChange={(e) => setAssignForm({ ...assignForm, [p.id]: e.target.value })}>
                <option value="">Assign employee…</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <button className="btn btn-sm" onClick={() => assign(p.id)}>Assign</button>
            </div>
          )}
        </div>
      ))}
      {projects.length === 0 && <div className="small-muted">No projects yet.</div>}
    </div>
  );
}
