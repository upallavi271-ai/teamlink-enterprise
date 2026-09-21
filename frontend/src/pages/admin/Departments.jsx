import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isSuperAdmin as hasSuperAdmin } from '../../permissions';

export default function Departments() {
  const { user } = useAuth();
  const isSuperAdmin = hasSuperAdmin(user);
  const [depts, setDepts] = useState([]);
  const [newDept, setNewDept] = useState('');
  const [newTeam, setNewTeam] = useState({});
  const [error, setError] = useState('');

  function load() {
    api.get('/admin/departments').then((res) => setDepts(res.data));
  }
  useEffect(load, []);

  async function addDepartment(e) {
    e.preventDefault();
    setError('');
    if (!newDept.trim()) return;
    try {
      await api.post('/admin/departments', { name: newDept.trim() });
      setNewDept('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add department.');
    }
  }

  async function removeDepartment(id, name) {
    if (!confirm(`Remove department "${name}" and all its teams? Employees already assigned to it keep the department name on their record.`)) return;
    await api.delete(`/admin/departments/${id}`);
    load();
  }

  async function addTeam(e, deptId) {
    e.preventDefault();
    setError('');
    const name = (newTeam[deptId] || '').trim();
    if (!name) return;
    try {
      await api.post(`/admin/departments/${deptId}/teams`, { name });
      setNewTeam({ ...newTeam, [deptId]: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add team.');
    }
  }

  async function removeTeam(id, name) {
    if (!confirm(`Remove team "${name}"?`)) return;
    await api.delete(`/admin/teams/${id}`);
    load();
  }

  return (
    <div>
      <div className="page-head"><div><h1>Departments & Teams</h1><div className="page-sub">Populates the Department/Team dropdowns used across Employee Management</div></div></div>

      {error && <div className="error-text">{error}</div>}

      {isSuperAdmin && (
        <form className="card section" onSubmit={addDepartment}>
          <h3>Add Department</h3>
          <div className="grid-2">
            <label className="field"><span>Department name</span><input value={newDept} onChange={(e) => setNewDept(e.target.value)} placeholder="e.g. Manufacturing" /></label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Add Department</button>
        </form>
      )}

      {depts.map((d) => (
        <div className="card section" key={d.id}>
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 14 }}>{d.name}</h3>
            {isSuperAdmin && <button className="btn btn-sm" onClick={() => removeDepartment(d.id, d.name)}>Remove Department</button>}
          </div>

          <div className="small-muted" style={{ marginBottom: 6 }}>Teams</div>
          {d.teams.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {d.teams.map((t) => (
                <span key={t.id} className="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {t.name}
                  {isSuperAdmin && <button className="btn btn-sm" style={{ padding: '0 6px' }} onClick={() => removeTeam(t.id, t.name)}>×</button>}
                </span>
              ))}
            </div>
          ) : (
            <div className="small-muted" style={{ marginBottom: 10 }}>No teams yet.</div>
          )}

          {isSuperAdmin && (
            <form onSubmit={(e) => addTeam(e, d.id)} style={{ display: 'flex', gap: 8 }}>
              <input placeholder="New team name (e.g. Team-A)" value={newTeam[d.id] || ''} onChange={(e) => setNewTeam({ ...newTeam, [d.id]: e.target.value })} />
              <button className="btn btn-sm" type="submit">Add Team</button>
            </form>
          )}
        </div>
      ))}

      {depts.length === 0 && <div className="small-muted">No departments yet.</div>}
    </div>
  );
}
