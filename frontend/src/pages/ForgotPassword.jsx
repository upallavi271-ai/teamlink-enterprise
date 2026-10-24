import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import api from '../api';
import { TeamLinkMark } from '../components/Logo.jsx';

// FORGOT PASSWORD - step 1. One box, one button. The answer is the SAME whether
// or not the email is registered (the server never says), so nobody can use this
// screen to find out who has an account. The only different answers are plain
// ones that say nothing about any account: "too many tries" and "email is off".
export default function ForgotPassword() {
  const location = useLocation();
  const [email, setEmail] = useState((location.state && location.state.email) || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send(e) {
    if (e) e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setSentTo(email.trim());
      setWait(60);
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card" style={{ maxWidth: 420 }}>
        <div className="logo-lockup"><TeamLinkMark width={168} /></div>

        {sentTo ? (
          <div data-testid="forgot-sent">
            <h1 style={{ fontSize: 20, margin: '8px 0 10px' }}>Check your email</h1>
            <div className="notice" style={{ display: 'block', marginBottom: 12 }}>
              If this email is registered, a reset link is on its way. Check Inbox and Spam.
            </div>
            <div className="small-muted" style={{ marginBottom: 14 }}>
              The link works once and stops working in 30 minutes.
            </div>
            <button type="button" className="btn" disabled={busy || wait > 0} onClick={() => send()} style={{ width: '100%', justifyContent: 'center' }}>
              {wait > 0 ? `Send again (wait ${wait}s)` : 'Send again'}
            </button>
            {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
            <div style={{ marginTop: 14, textAlign: 'center' }}><Link to="/login">Back to sign in</Link></div>
          </div>
        ) : (
          <form onSubmit={send}>
            <h1 style={{ fontSize: 20, margin: '8px 0 6px' }}>Forgot your password?</h1>
            <div className="small-muted" style={{ marginBottom: 14 }}>
              Enter your email. We will send you a link to set a new password.
              If more than one login uses your email, the email lists each login with its own link.
            </div>
            <label htmlFor="forgotEmail">Email</label>
            <input
              id="forgotEmail"
              type="email"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              placeholder="you@company.com"
            />
            {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}>
              {busy ? 'Sending…' : 'Send me the link'}
            </button>
            <div style={{ marginTop: 14, textAlign: 'center' }}><Link to="/login">Back to sign in</Link></div>
          </form>
        )}
      </div>
    </div>
  );
}
