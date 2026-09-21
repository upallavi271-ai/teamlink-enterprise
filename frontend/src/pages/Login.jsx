import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { TeamLinkMark } from '../components/Logo.jsx';

// Email and password. Nothing else.
//
// The prototype's login was a role picker — twelve clickable role tiles, a
// client dropdown and a candidate dropdown. It is gone, here and everywhere
// else: a person's role is derived from their employee record (department +
// designation), never chosen at sign-in. No demo password is displayed.
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await login(email, password);
      navigate(user?.landingPath || '/', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="logo-lockup">
          {/* The real artwork. The card is white, so it needs no plate and
              the brand colours show exactly as supplied. */}
          <TeamLinkMark width={168} />
          {/* NO PRODUCT NAME HERE. A client and a candidate sign in on this same
              card, and "HRMS" is internal vocabulary they must never see. */}
          <div className="small-muted" style={{ marginTop: 6 }}>TeamLink.Enterprise</div>
        </div>

        <div className="small-muted" style={{ marginBottom: 16 }}>
          Sign in with your email. One login covers everything you have access to —
          your access follows your role.
        </div>

        <div style={{ marginTop: 10 }}>
          <label htmlFor="loginEmail">Email</label>
          <input
            id="loginEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            placeholder="you@teamlink.test"
            required
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label htmlFor="loginPassword">Password</label>
          <div style={{ position: 'relative' }}>
            <input
              id="loginPassword"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ paddingRight: 64 }}
              required
            />
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 0, cursor: 'pointer', fontSize: 12,
              }}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button
            type="button"
            className="link-btn"
            style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 12 }}
            onClick={() => setError('Ask an administrator to reset your password from Administration → Users.')}
          >
            Forgot Password?
          </button>
        </div>

        {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}

        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}
          type="submit"
          disabled={busy}
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
