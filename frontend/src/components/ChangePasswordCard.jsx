import { useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { passwordLine } from './PasswordStatus.jsx';

// SELF-SERVICE PASSWORD CHANGE (hrms-24 §12) — current password, new password
// and confirmation, sent to POST /api/auth/change-password, which checks the
// current password, applies the strength rule and bcrypt-hashes the new one.
// Nothing here stores or logs a password; the fields are cleared on success.
export default function ChangePasswordCard({ style }) {
  const { user } = useAuth();
  const ps = user?.passwordStatus;
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState({ field: '', text: '' });
  const [done, setDone] = useState('');
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setError({ field: '', text: '' }); setDone(''); };

  async function submit(e) {
    e.preventDefault();
    if (f.newPassword !== f.confirmPassword) { setError({ field: 'confirmPassword', text: 'The two new passwords do not match.' }); return; }
    setBusy(true);
    try {
      const res = await api.post('/auth/change-password', f);
      setF({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setDone(res.data.message || 'Password changed.');
    } catch (err) {
      setError({ field: err.response?.data?.field || '', text: err.response?.data?.error || 'The password could not be changed.' });
    } finally { setBusy(false); }
  }

  const fieldErr = (k) => (error.field === k ? <p className="error-text">{error.text}</p> : null);
  return (
    <form className="card section" onSubmit={submit} style={{ maxWidth: 420, ...style }}>
      <h3 style={{ fontSize: 14, marginTop: 0 }}>Change password</h3>
      {ps?.passwordResetRequired && (
        <div className="notice amber" style={{ display: 'block' }}>Your password was reset by HR. Choose a new one now.</div>
      )}
      {ps && <div className="small-muted" style={{ marginBottom: 8 }}>Status: {passwordLine(ps)}</div>}
      {error.text && !error.field && <div className="error-text">{error.text}</div>}
      <div className="field"><label>Current password</label>
        <input type="password" autoComplete="current-password" value={f.currentPassword} onChange={set('currentPassword')} required />
        {fieldErr('currentPassword')}</div>
      <div className="field"><label>New password</label>
        <input type="password" autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} required minLength="8" />
        {fieldErr('newPassword')}</div>
      <div className="field"><label>Confirm new password</label>
        <input type="password" autoComplete="new-password" value={f.confirmPassword} onChange={set('confirmPassword')} required minLength="8" />
        {fieldErr('confirmPassword')}</div>
      <div className="small-muted" style={{ marginBottom: 8 }}>At least 8 characters, with a letter and a number; not your name or email.</div>
      <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      {done && <span className="small-muted" style={{ marginLeft: 10 }}>{done}</span>}
    </form>
  );
}
