import { useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { TeamLinkMark } from './Logo.jsx';

// "CHANGE YOUR PASSWORD NOW" - shown BEFORE anything else when this login still
// uses a starting (seed / demo) password. The server refuses every other call
// until it is changed (backend/src/utils/seedPasswords.js), so this screen is
// the only way forward. It uses the normal change-password flow and rules.
export default function ForcePasswordChange() {
  const { user, logout, endSessionWithNotice } = useAuth();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState({ field: '', text: '' });
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setError({ field: '', text: '' }); };

  async function submit(e) {
    e.preventDefault();
    if (f.newPassword !== f.confirmPassword) { setError({ field: 'confirmPassword', text: 'The two new passwords do not match.' }); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', f);
      endSessionWithNotice('Your password is changed. Please sign in again with your new password.');
    } catch (err) {
      setError({ field: err.response?.data?.field || '', text: err.response?.data?.error || 'The password could not be changed.' });
      setBusy(false);
    }
  }
  const fieldErr = (k) => (error.field === k ? <p className="error-text">{error.text}</p> : null);

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit} data-testid="force-password-change">
        <div className="logo-lockup"><TeamLinkMark width={150} /></div>
        <h2 style={{ fontSize: 20, margin: '4px 0 6px' }}>Change your password now</h2>
        <div className="notice amber" style={{ display: 'block', marginBottom: 12 }}>
          {user?.name ? `${user.name}, ` : ''}this account still uses the password it was given at the start. For your safety, choose your own password before you continue.
        </div>
        {error.text && !error.field && <div className="error-text">{error.text}</div>}
        <div className="field"><label htmlFor="fpcCur">Password you were given</label>
          <input id="fpcCur" type="password" autoComplete="current-password" value={f.currentPassword} onChange={set('currentPassword')} required />
          {fieldErr('currentPassword')}</div>
        <div className="field"><label htmlFor="fpcNew">Your new password</label>
          <input id="fpcNew" type="password" autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} required minLength="8" />
          {fieldErr('newPassword')}</div>
        <div className="field"><label htmlFor="fpcNew2">New password again</label>
          <input id="fpcNew2" type="password" autoComplete="new-password" value={f.confirmPassword} onChange={set('confirmPassword')} required minLength="8" />
          {fieldErr('confirmPassword')}</div>
        <div className="small-muted" style={{ marginBottom: 10 }}>At least 8 characters, with a letter and a number. Not your name or email, and not a common password.</div>
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Saving...' : 'Save my new password'}</button>
        <button type="button" className="link-btn" style={{ marginTop: 10 }} onClick={logout}>Sign out</button>
      </form>
    </div>
  );
}
