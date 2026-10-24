import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';

// WHO HAS INTERNAL HR ACCESS (founder, 2026-10-14). A tab inside Administration -> Audit Logs (no sidebar entry).
// Internal HR works like a Super Admin, but every delete / export / import is reported to the Super Admins, and a few
// things stay Super-Admin-only (listed below, with the reason) so nobody can give themselves unlimited power.
export default function HrSuperAccess() {
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    api.get('/admin/hr-super-access').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load this list.'));
  }
  useEffect(() => {
    load();
    api.get('/admin/users').then((r) => setPeople((r.data || []).filter((u) => !['SUPER_ADMIN', 'ADMIN', 'CLIENT', 'CANDIDATE'].includes(u.role) && u.status === 'Active'))).catch(() => {});
  }, []);

  async function save(body, done) {
    setBusy(true); setError(''); setNotice('');
    try { await api.put('/admin/hr-super-access', body); setNotice(done); setPick(''); load(); } catch (e) { setError(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }

  if (!data) return <div className="small-muted">{error || 'Loading…'}</div>;
  const options = people.filter((p) => !data.users.some((u) => u.id === p.id)).map((p) => ({ value: p.id, label: `${p.name}${p.employeeId ? ` (${p.employeeId})` : ''}${p.department ? ` · ${p.department}` : ''}` }));
  return (
    <div className="card section" style={{ marginTop: 10 }}>
      <h3>People with Internal HR access</h3>
      <p className="small-muted">
        They can do everything a Super Admin can, including delete, export and import. Every delete, export and import they do is sent to all
        Super Admins as a notification and written to the audit log. {data.mail.note}
      </p>
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Employee ID</th><th>Department</th><th>Given by</th><th /></tr></thead>
          <tbody>
            {data.users.length === 0 && <tr><td colSpan="5" className="small-muted">Nobody yet. Pick a person below and press Give access.</td></tr>}
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td><td>{u.employeeCode || '—'}</td><td>{u.department || '—'}</td>
                <td>{u.via === 'role' ? 'Role "Internal HR"' : 'This list'}</td>
                <td>{data.canEdit && u.via === 'list' && <button className="btn btn-sm" disabled={busy} onClick={() => save({ remove: [u.id] }, `Internal HR access taken from ${u.name}.`)}>Remove access</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.canEdit ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 280 }}>
            <Combo value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Search a person…</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Combo>
          </div>
          <button className="btn btn-sm btn-primary" disabled={busy || !pick} onClick={() => save({ add: [pick] }, 'Internal HR access given.')}>Give access</button>
        </div>
      ) : <div className="small-muted" style={{ marginTop: 8 }}>Only a Super Admin or an Admin can change this list.</div>}
      {data.canEdit && (
        <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={data.emailSuperAdmins} onChange={(e) => save({ emailSuperAdmins: e.target.checked }, 'Saved.')} />
            Email Super Admins about HR delete / export / import
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={data.notifyAdmins} onChange={(e) => save({ notifyAdmins: e.target.checked }, 'Saved.')} />
            Also tell Admins (not only Super Admins)
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={data.enabled} onChange={(e) => save({ enabled: e.target.checked }, 'Saved.')} />
            Internal HR access is switched on (untick to pause it for everybody on the list)
          </label>
        </div>
      )}
      <h3 style={{ marginTop: 18 }}>Still only for the Super Admin</h3>
      <ul style={{ margin: '6px 0 0 18px', fontSize: 13.5 }}>
        {data.guards.map((g) => <li key={g.id}><b>{g.label}.</b> <span className="small-muted">{g.why}</span></li>)}
      </ul>
    </div>
  );
}
