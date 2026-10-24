import { useEffect, useState } from 'react';
import api from '../../api';

// CREATE MISSING LOGINS (founder, 2026-10-14): people who still work here and have no login. The list IS the preview
// (nothing is created until the confirm button). Link-only: each person gets a single-use set-password link by e-mail.
export default function MissingLogins({ onDone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setError('');
    api.post('/employees/management/create-missing-logins', { dryRun: true })
      .then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not check who has no login.'));
  }
  useEffect(load, []);

  async function create() {
    if (!window.confirm(`Create ${data.wouldCreate} login${data.wouldCreate === 1 ? '' : 's'} and e-mail each person a link to set their own password?`)) return;
    setBusy(true); setError('');
    try {
      const r = await api.post('/employees/management/create-missing-logins', { dryRun: false });
      setResult(r.data);
      load();
      if (onDone) onDone();
    } catch (e) { setError(e.response?.data?.error || 'The logins could not be created.'); } finally { setBusy(false); }
  }

  if (!data) return <div className="card section small-muted">{error || 'Checking…'}</div>;
  return (
    <div className="card section">
      <h3>Employees with no login ({data.rows.length})</h3>
      <p className="small-muted">Only people who still work here are listed. Nothing is created until you press the green button. Nobody types or sees a password: each person gets a link to set their own.</p>
      {error && <div className="error-text">{error}</div>}
      {result && <div className="notice" style={{ marginBottom: 8 }}>{result.created} login{result.created === 1 ? '' : 's'} created. {result.results.filter((x) => !x.done).map((x) => `${x.name}: ${x.reason}`).join(' · ')}</div>}
      {data.rows.length === 0 ? <div className="small-muted">Everyone who works here has a login.</div> : (
        <>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Name</th><th>Employee ID</th><th>Department</th><th>E-mail</th><th>Role it will get</th><th>What happens</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td><td>{r.employeeCode || '—'}</td><td>{r.department || '—'}</td>
                    <td>{r.emailDomain ? `…@${r.emailDomain}` : <span style={{ color: 'var(--danger, #c0392b)' }}>none</span>}</td>
                    <td>{r.role || '—'}</td>
                    <td style={{ color: r.canCreate ? undefined : 'var(--danger, #c0392b)' }}>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary" disabled={busy || !data.wouldCreate} onClick={create}>
              {busy ? 'Creating…' : `Create ${data.wouldCreate} login${data.wouldCreate === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
