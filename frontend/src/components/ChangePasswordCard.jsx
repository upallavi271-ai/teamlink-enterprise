import { useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { passwordLine } from './PasswordStatus.jsx';

// SELF-SERVICE PASSWORD CHANGE (hrms-24 §12) — current password, new password
// and confirmation, sent to POST /api/auth/change-password, which checks the
// current password, applies the strength rule and bcrypt-hashes the new one.
// Nothing here stores or logs a password; the fields are cleared on success.
export default function ChangePasswordCard({ style }) {
  const { user, endSessionWithNotice } = useAuth();
  const ps = user?.passwordStatus;
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState({ field: '', text: '' });
  const [done, setDone] = useState('');
  const [show, setShow] = useState(false); // lets the person SEE what they are typing (the three boxes only; nothing is stored or shown anywhere else)
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setError({ field: '', text: '' }); setDone(''); };

  async function submit(e) {
    e.preventDefault();
    if (f.newPassword !== f.confirmPassword) { setError({ field: 'confirmPassword', text: 'The two new passwords do not match.' }); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', f);
      // Changed: sign out right now. The sign-in page opens and the person signs in again with the NEW password.
      setF({ currentPassword: '', newPassword: '', confirmPassword: '' });
      endSessionWithNotice('Your password is changed. Please sign in again with your new password.');
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
        <input type={show ? 'text' : 'password'} autoComplete="current-password" value={f.currentPassword} onChange={set('currentPassword')} required />
        {fieldErr('currentPassword')}</div>
      <div className="field"><label>New password</label>
        <input type={show ? 'text' : 'password'} autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} required minLength="8" />
        {fieldErr('newPassword')}</div>
      <div className="field"><label>Confirm new password</label>
        <input type={show ? 'text' : 'password'} autoComplete="new-password" value={f.confirmPassword} onChange={set('confirmPassword')} required minLength="8" />
        {fieldErr('confirmPassword')}</div>
      <label className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show what I type
      </label>
      <div className="small-muted" style={{ marginBottom: 8 }}>At least 8 characters, with a letter and a number; not your name or email.</div>
      <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      {done && <span className="small-muted" style={{ marginLeft: 10 }}>{done}</span>}
    </form>
  );
}
