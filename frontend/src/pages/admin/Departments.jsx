import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isSuperAdmin as hasSuperAdmin } from '../../permissions';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { invalidateMasters } from '../../utils/masters';

export default function Departments() {
  const { user } = useAuth();
  const isSuperAdmin = hasSuperAdmin(user);
  const [depts, setDepts] = useState([]);
  const [newDept, setNewDept] = useState('');
  const [newTeam, setNewTeam] = useState({});
  const [error, setError] = useState('');

  const [notice, setNotice] = useState('');

  // ?all=1 — this screen also lists the switched-off ones (spec item 18), so
  // they can be switched back on. Every other picker gets active ones only.
  function load() {
    api.get('/admin/departments', { params: { all: 1 } }).then((res) => setDepts(res.data));
  }

  async function toggle(kind, row) {
    setError(''); setNotice('');
    const on = row.active === false;
    try {
      await api.put(`/admin/${kind === 'team' ? 'teams' : 'departments'}/${row.id}/active`, { active: on });
      invalidateMasters(); // every dropdown re-reads now
      setNotice(on ? `${row.name} is switched on — it shows in the lists again.` : `${row.name} is switched off — it no longer shows in any list. People already in it keep it on their record.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    }
  }

  // THE FILTER STANDARD: Search (department or team) · Teams, and a Sort.
  const lf = useListFilters(depts, [
    { key: 'q', type: 'search', placeholder: 'Search department or team…',
      get: (d) => `${d.name} ${(d.teams || []).map((t) => t.name).join(' ')}` },
    { key: 'teams', label: 'Teams', allLabel: 'With or without teams', primary: true,
      options: [{ value: 'with', label: 'With teams' }, { value: 'none', label: 'No teams yet' }],
      match: (d, v) => (v === 'with') === ((d.teams || []).length > 0) },
  ], {
    sorts: [
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name).localeCompare(String(b.name)) },
      { key: 'teams', label: 'Most teams', cmp: (a, b) => (b.teams || []).length - (a.teams || []).length },
    ],
  });
  useEffect(load, []);

  async function addDepartment(e) {
    e.preventDefault();
    setError('');
    if (!newDept.trim()) return;
    try {
      await api.post('/admin/departments', { name: newDept.trim() });
      setNewDept('');
      invalidateMasters(); // the new department joins every Department dropdown now
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add department.');
    }
  }

  async function removeDepartment(id, name) {
    if (!confirm(`Remove department "${name}" and all its teams?`)) return;
    setError(''); setNotice('');
    try {
      await api.delete(`/admin/departments/${id}`);
      invalidateMasters();
      setNotice(`${name} removed.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove the department.');
    }
  }

  async function addTeam(e, deptId) {
    e.preventDefault();
    setError('');
    const name = (newTeam[deptId] || '').trim();
    if (!name) return;
    try {
      await api.post(`/admin/departments/${deptId}/teams`, { name });
      setNewTeam({ ...newTeam, [deptId]: '' });
      invalidateMasters();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add team.');
    }
  }

  async function removeTeam(id, name) {
    if (!confirm(`Remove team "${name}"?`)) return;
    setError(''); setNotice('');
    try {
      await api.delete(`/admin/teams/${id}`);
      invalidateMasters();
      setNotice(`${name} removed.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove the team.');
    }
  }

  return (
    <div>
      <div className="page-head"><div><h1>Departments & Teams</h1><div className="page-sub">Populates the Department/Team dropdowns used across Employee Management</div></div></div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      {isSuperAdmin && (
        <form className="card section" onSubmit={addDepartment}>
          <h3>Add Department</h3>
          <div className="grid-2">
            <label className="field"><span>Department name</span><input value={newDept} onChange={(e) => setNewDept(e.target.value)} placeholder="e.g. Manufacturing" /></label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Add Department</button>
        </form>
      )}

      <ListFilterBar lf={lf} storageKey="admin-departments" noun="departments" />

      {lf.rows.map((d) => (
        <div className="card section" key={d.id}>
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, opacity: d.active === false ? 0.55 : 1 }}>
              {d.name}
              {d.active === false && <> <span className="status pending">Off — hidden from lists</span></>}
            </h3>
            {isSuperAdmin && (
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {d.active !== undefined && (
                  <button className="btn btn-sm" onClick={() => toggle('department', d)}>{d.active === false ? 'Switch on' : 'Switch off'}</button>
                )}
                <button className="btn btn-sm btn-danger" onClick={() => removeDepartment(d.id, d.name)}>Remove</button>
              </span>
            )}
          </div>

          <div className="small-muted" style={{ marginBottom: 6 }}>Teams</div>
          {d.teams.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {d.teams.map((t) => (
                <span key={t.id} className={`status${t.active === false ? ' pending' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {t.name}{t.active === false ? ' (off)' : ''}
                  {isSuperAdmin && t.active !== undefined && (
                    <button className="btn btn-sm" style={{ padding: '0 6px' }} onClick={() => toggle('team', t)}>{t.active === false ? 'Switch on' : 'Switch off'}</button>
                  )}
                  {isSuperAdmin && <button className="btn btn-sm" style={{ padding: '0 6px' }} title={`Remove ${t.name}`} onClick={() => removeTeam(t.id, t.name)}>×</button>}
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

      {lf.rows.length === 0 && <ListEmpty lf={lf} noun="departments" />}
    </div>
  );
}
