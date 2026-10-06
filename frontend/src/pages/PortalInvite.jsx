import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';
import { TeamLinkMark } from '../components/Logo.jsx';

// /portal-invite/:token — the "Invite to portal" link a recruiter sends a
// CANDIDATE (spec B2). The link alone opens nothing: the candidate proves the
// invited email with a 6-digit code first (routes/portalPublic.js), then may
// choose a password — or skip it and always sign in with a code.
export default function PortalInvite() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true });
  const [sent, setSent] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/portal/public/invite/${token}`)
      .then((r) => setState({ loading: false, ...r.data }))
      .catch((e) => setState({ loading: false, invalid: e.response?.data?.error || 'This link is not valid.' }));
  }, [token]);

  async function sendCode() {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/portal/public/invite/${token}/send-code`);
      setSent(r.data.message);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not send the code. Try again in a minute.');
    } finally { setBusy(false); }
  }

  async function accept(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.post(`/portal/public/invite/${token}/accept`, { code, password: password || undefined });
      try { localStorage.setItem('tl_token', r.data.token); } catch { /* storage blocked */ }
      if (r.data.passwordError) { try { sessionStorage.setItem('tl_portal_notice', r.data.passwordError); } catch { /* ignore */ } }
      window.location.assign('/my-applications');
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Ask for a new code.');
    } finally { setBusy(false); }
  }

  if (state.loading) return <div className="login-shell"><div className="login-card">Checking your link…</div></div>;

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="logo-lockup"><TeamLinkMark width={168} /></div>
        <h1 style={{ fontSize: 20, marginBottom: 6 }}>Your candidate portal</h1>
        {state.invalid ? (
          <>
            <div className="error-text">{state.invalid}</div>
            <Link className="btn" style={{ marginTop: 14 }} to="/careers/my-applications">Sign in with a code instead</Link>
          </>
        ) : !sent ? (
          <>
            <p className="small-muted">
              Hello {state.name}. To keep your details safe, first confirm your email.
              We will send a 6-digit code to <b>{state.email}</b>.
            </p>
            {error && <div className="error-text">{error}</div>}
            <button type="button" className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy} onClick={sendCode}>
              {busy ? 'Sending…' : 'Send me the code'}
            </button>
          </>
        ) : (
          <form onSubmit={accept}>
            <div className="notice" style={{ marginBottom: 10 }}><span>{sent}</span></div>
            <div className="field"><label htmlFor="piCode">6-digit code *</label>
              <input id="piCode" required inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center' }}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
            <div className="field"><label htmlFor="piPw">Choose a password (optional)</label>
              <input id="piPw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <div className="small-muted">Leave it empty to always sign in with a code by email.</div>
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6} style={{ width: '100%', marginTop: 10 }}>
              {busy ? 'Checking…' : 'Open my portal'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
