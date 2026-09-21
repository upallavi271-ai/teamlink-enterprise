import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import { TeamLinkMark } from '../components/Logo.jsx';

// The page the "your sign-in details" email lands on. Outside the login wall,
// because the employee has no password yet — the single-use token in the URL
// is the only thing that grants access, and it grants exactly one thing:
// setting this one login's password.
//
// HR never sees this password, it is never emailed and it is never logged.
// See backend/src/utils/employeeInvite.js.

export default function SetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/public/set-password/${token}`)
      .then((res) => setState({ loading: false, ...res.data }))
      .catch((err) => setState({ loading: false, invalid: err.response?.data?.error || 'This link is not valid.' }));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Choose a password of at least 8 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');
    setSaving(true);
    try {
      await api.post(`/public/set-password/${token}`, { password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Ask HR to send a new link.');
    } finally {
      setSaving(false);
    }
  }

  if (state.loading) return <div className="login-shell"><div className="login-card">Checking your link…</div></div>;

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="logo-lockup"><TeamLinkMark width={168} /></div>
        <h1 style={{ fontSize: 20, marginBottom: 6 }}>Set your password</h1>

        {state.invalid ? (
          <>
            <div className="error-text">{state.invalid}</div>
            <div className="small-muted" style={{ marginTop: 10 }}>
              Sign-in links are single-use and expire. Ask HR to send you a new one.
            </div>
            <Link className="btn" style={{ marginTop: 14 }} to="/login">Back to sign in</Link>
          </>
        ) : done ? (
          <>
            <div className="notice">Your password is set. Taking you to the sign-in screen…</div>
            <Link className="btn btn-primary" style={{ marginTop: 14 }} to="/login">Sign in now</Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="page-sub" style={{ marginBottom: 14 }}>
              Hello {state.name}. This link works once and expires on{' '}
              {state.expiresAt ? new Date(state.expiresAt).toLocaleString('en-GB') : 'its expiry date'}.
            </div>
            <div className="field"><label>Sign-in email</label><input value={state.email || ''} disabled /></div>
            <div className="field"><label>New password *</label>
              <input type="password" required minLength={8} autoComplete="new-password"
                value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div className="field"><label>Confirm password *</label>
              <input type="password" required minLength={8} autoComplete="new-password"
                value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={saving} style={{ marginTop: 10, width: '100%' }}>
              {saving ? 'Saving…' : 'Set password and continue'}
            </button>
            <div className="small-muted" style={{ marginTop: 12 }}>
              After signing in, open My Profile, fill in the rest of your details and submit them
              for review. Once they are approved the profile locks.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
