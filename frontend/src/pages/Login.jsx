import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { TeamLinkMark } from '../components/Logo.jsx';
import { BRAND } from '../brand.js';
import { appHome } from '../pwa/pwa.js';
import vendorApi, { setVendorToken, setVendorHome, vendorHome } from '../vendorApi';
import api from '../api';
import { RecoveryCodes, SetupBox } from '../components/TwoStepCard.jsx';

// Email and password. Nothing else.
//
// The prototype's login was a role picker — twelve clickable role tiles, a
// client dropdown and a candidate dropdown. It is gone, here and everywhere
// else: a person's role is derived from their employee record (department +
// designation), never chosen at sign-in. No demo password is displayed.
export default function Login() {
  const { login, chooseLogin, finishMfa } = useAuth();
  // Two-step sign-in (backend routes/mfa.js): { mode: 'verify' | 'enrol', ticket, setup?, codes?, done? }
  const [mfa, setMfa] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  // Set by AuthContext.endSessionWithNotice() right after a password change; shown once.
  const [notice] = useState(() => {
    try { return sessionStorage.getItem('tl_login_notice') || ''; } catch { return ''; }
  });
  // (read first, cleared after the page has shown: React may run the initializer twice in development)
  useEffect(() => { try { sessionStorage.removeItem('tl_login_notice'); } catch { /* storage blocked */ } }, []);
  const [busy, setBusy] = useState(false);
  // "Choose your account": the same password opens more than one separate login on this email.
  const [choice, setChoice] = useState(null);
  const [picked, setPicked] = useState('');

  // The vendor sign-in (its own server, token and messages). Throws when it refuses.
  async function vendorSignIn(typedEmail, typedPassword) {
    const r = await vendorApi.post('/login', { email: typedEmail, password: typedPassword });
    try { localStorage.removeItem('tl_token'); } catch { /* storage blocked */ }
    setVendorToken(r.data.token);
    setVendorHome(r.data.landing);
    // A temporary password goes to the vendor's own "set your password" step first.
    navigate(r.data.vendor?.mustChangePassword ? '/vendor-login' : vendorHome(), { replace: true });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await login(email.trim(), password);
      if (user && user.mfa) { await startMfa(user); return; }
      if (user && user.chooseAccount) {
        setChoice(user);
        setPicked(user.accounts.length ? user.accounts[0].choice : '');
        return;
      }
      navigate(appHome(user, user?.landingPath || '/'), { replace: true });
    } catch (err) {
      // ONE login page for vendors too. Only a plain "no such staff login /
      // wrong password" (401) falls through to the vendor check; a locked or
      // switched-off staff login (423 / 403) never does. The vendor server
      // decides (VendorUser + active vendor); a vendor refusal shows the SAME
      // generic text as a staff one, so the page never says which kind of
      // account an email is.
      const generic = err.response?.data?.error || 'Login failed';
      if (err.response?.status === 401) {
        try {
          await vendorSignIn(email, password);
          return;
        } catch (ve) {
          setError(ve.response?.status === 429 ? (ve.response.data?.error || generic) : generic);
        }
      } else {
        setError(generic);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onChoose(e) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const user = await chooseLogin(choice.selectionToken, picked);
      if (user && user.mfa) { setChoice(null); await startMfa(user); return; }
      if (user && user.useVendor) {
        try {
          await vendorSignIn(email, password);
        } catch (ve) {
          setError(ve.response?.data?.error || 'Sign in failed. Please try again.');
          setChoice(null);
        }
        return;
      }
      navigate(appHome(user, user?.landingPath || '/'), { replace: true });
    } catch (err) {
      // The choice runs out after 5 minutes and works once: start again with a plain sentence.
      setError(err.response?.data?.error || 'That did not work. Please sign in again.');
      setChoice(null);
    } finally {
      setBusy(false);
    }
  }

  async function startMfa(r) {
    setMfaCode(''); setUseRecovery(false);
    if (r.mfa === 'enrol') {
      const s = await api.post('/auth/mfa/enrol/start', { mfaTicket: r.mfaTicket });
      setMfa({ mode: 'enrol', ticket: r.mfaTicket, setup: s.data });
    } else setMfa({ mode: 'verify', ticket: r.mfaTicket });
  }

  async function onMfa(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = mfa.mode === 'enrol' ? { mfaTicket: mfa.ticket, code: mfaCode }
        : (useRecovery ? { mfaTicket: mfa.ticket, recoveryCode: mfaCode } : { mfaTicket: mfa.ticket, code: mfaCode });
      const out = await finishMfa(mfa.mode === 'enrol' ? 'enrol/confirm' : 'verify', body);
      // new recovery codes (set-up) or few left: show them / say so before going in
      if (out.recoveryCodes || (out.recoveryLeft != null && out.recoveryLeft <= 3)) { setMfa({ ...mfa, done: out }); return; }
      out.commit();
      navigate(appHome(out.user, out.user?.landingPath || '/'), { replace: true });
    } catch (err) {
      const msg = err.response?.data?.error || 'That did not work. Try again.';
      setError(msg);
      if (err.response?.data?.code === 'MFA_TICKET_EXPIRED' || err.response?.status === 423) { setMfa(null); setPassword(''); }
    } finally { setBusy(false); }
  }

  if (mfa) {
    const done = mfa.done;
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={done ? (e) => { e.preventDefault(); done.commit(); navigate(appHome(done.user, done.user?.landingPath || '/'), { replace: true }); } : onMfa} style={mfa.mode === 'enrol' && !done ? { maxWidth: 560 } : undefined}>
          <div className="logo-lockup"><TeamLinkMark width={168} /><div className="small-muted" style={{ marginTop: 6 }}>TeamLink.Enterprise</div></div>
          {done ? (
            <>
              <h1 style={{ fontSize: 20, margin: '4px 0 6px' }}>{done.recoveryCodes ? 'Two-step sign-in is on' : 'Signed in with a recovery code'}</h1>
              {done.recoveryCodes ? <RecoveryCodes codes={done.recoveryCodes} />
                : <div className="notice" style={{ display: 'block' }}>Only {done.recoveryLeft} recovery code{done.recoveryLeft === 1 ? '' : 's'} left. Make new ones on your Profile → Two-step sign-in.</div>}
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} type="submit">{done.recoveryCodes ? 'I saved them, continue' : 'Continue'}</button>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 20, margin: '4px 0 6px' }}>{mfa.mode === 'enrol' ? 'Set up two-step sign-in' : 'Two-step sign-in'}</h1>
              {mfa.mode === 'enrol' ? (
                <>
                  <div className="small-muted">Your company asks your role to use a code from a phone app after the password. It takes a minute.</div>
                  <SetupBox setup={mfa.setup} code={mfaCode} setCode={setMfaCode} />
                </>
              ) : (
                <>
                  <div className="small-muted" style={{ marginBottom: 10 }}>{useRecovery ? 'Type one of your recovery codes.' : 'Type the 6-digit code from your authenticator app.'}</div>
                  <input
                    autoFocus inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" maxLength={useRecovery ? 14 : 6}
                    value={mfaCode} onChange={(e) => setMfaCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))}
                    placeholder={useRecovery ? 'XXXXX-XXXXX' : '123456'} aria-label={useRecovery ? 'Recovery code' : '6-digit code'} style={{ fontSize: 20, letterSpacing: 3, textAlign: 'center' }}
                  />
                  <div style={{ marginTop: 8, textAlign: 'right' }}>
                    <button type="button" className="link-btn" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 12 }} onClick={() => { setUseRecovery((v) => !v); setMfaCode(''); setError(''); }}>
                      {useRecovery ? 'Use the app code instead' : 'Lost your phone? Use a recovery code'}
                    </button>
                  </div>
                </>
              )}
              {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} type="submit" disabled={busy || (useRecovery ? mfaCode.replace(/[^A-Z0-9]/g, '').length < 10 : mfaCode.length !== 6)}>
                {busy ? 'Checking…' : (mfa.mode === 'enrol' ? 'Turn on and sign in' : 'Sign in')}
              </button>
              <div style={{ marginTop: 10, textAlign: 'center' }}>
                <button type="button" className="link-btn" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 12 }} onClick={() => { setMfa(null); setError(''); }}>Back</button>
              </div>
            </>
          )}
        </form>
      </div>
    );
  }

  if (choice) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={onChoose} data-testid="choose-account">
          <div className="logo-lockup">
            <TeamLinkMark width={168} />
            <div className="small-muted" style={{ marginTop: 6 }}>{BRAND.product}</div>
          </div>
          <h1 style={{ fontSize: 20, margin: '4px 0 6px' }}>Choose your account</h1>
          <div className="small-muted" style={{ marginBottom: 12 }}>
            More than one of your logins uses this email and this password. Pick the one you want to open now.
            (Tip: a different password for each login keeps them apart.)
          </div>
          <div role="radiogroup" aria-label="Choose your account" style={{ display: 'grid', gap: 8 }}>
            {choice.accounts.map((a) => (
              <label
                key={a.choice}
                style={{
                  display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  border: picked === a.choice ? '2px solid var(--primary, #1d4ed8)' : '1px solid var(--border, #d1d5db)',
                }}
              >
                <input type="radio" name="account" value={a.choice} checked={picked === a.choice} onChange={() => setPicked(a.choice)} style={{ width: 'auto' }} />
                <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{a.label}</b>
              </label>
            ))}
          </div>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} type="submit" disabled={busy || !picked}>
            {busy ? 'Opening…' : 'Open this login'}
          </button>
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <button type="button" className="link-btn" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 12 }}
              onClick={() => { setChoice(null); setError(''); }}>
              Back
            </button>
          </div>
        </form>
      </div>
    );
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
          <div className="small-muted" style={{ marginTop: 6 }}>{BRAND.product}</div>
        </div>

        {notice && <div className="notice green" role="status" style={{ display: 'block', marginBottom: 12 }}>{notice}</div>}
        <div className="small-muted" style={{ marginBottom: 16 }}>
          Sign in with your email. Your access follows your login.
        </div>

        <div style={{ marginTop: 10 }}>
          <label htmlFor="loginEmail">Email</label>
          <input
            id="loginEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="your email"
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
            onClick={() => navigate('/forgot-password', { state: { email } })}
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
