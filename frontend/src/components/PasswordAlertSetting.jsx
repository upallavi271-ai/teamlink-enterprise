import { useEffect, useState } from 'react';
import api from '../api';

// COMPANY SETUP -> "Who is told when someone changes their password".
// They are told THAT it changed, and who, when and how - in the bell and by
// email. Nobody is ever shown a password, not even a Super Admin.
export default function PasswordAlertSetting() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  function load() {
    api.get('/admin/password-alert-setting').then((res) => setS(res.data)).catch(() => setS(null));
  }
  useEffect(load, []);
  if (!s) return null;

  async function save(next) {
    setMsg(''); setError('');
    try {
      const res = await api.put('/admin/password-alert-setting', next);
      setS((cur) => ({ ...cur, ...res.data }));
      load();
      setMsg('Saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'That could not be saved.');
    }
  }
  const has = (r) => s.roles.includes(r);
  const toggleRole = (r) => save({ roles: has(r) ? s.roles.filter((x) => x !== r) : [...s.roles, r], email: s.email });

  return (
    <div className="card section" data-testid="password-alert-setting">
      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Who is told when someone changes their password</h3>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        They get a message in the bell saying who changed it, when, and how - with a button to block the login if it was not them.
        Nobody is ever shown a password, not even a Super Admin.
      </div>
      <label style={{ display: 'block', marginBottom: 6 }}>
        <input type="checkbox" checked disabled /> Super Admin <span className="small-muted">(always told)</span>
      </label>
      <label style={{ display: 'block', marginBottom: 6 }}>
        <input type="checkbox" checked={has('ADMIN')} disabled={!s.canEdit} onChange={() => toggleRole('ADMIN')} /> Admin
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={s.email} disabled={!s.canEdit} onChange={() => save({ roles: s.roles, email: !s.email })} /> Also send an email
      </label>
      <div className="small-muted">
        Told now: {s.people.length ? `${s.people.slice(0, 6).map((p) => p.name).join(', ')}${s.people.length > 6 ? ` and ${s.people.length - 6} more` : ''}` : 'nobody yet'}.
        {!s.canEdit && ' Only a Super Admin can change this.'}
      </div>
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
