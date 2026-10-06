import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import vendorApi, {
  setVendorToken, vendorToken, vendorError, VENDOR_NOTICE_KEY,
} from '../../vendorApi';
import './vendorPortal.css';

// /vendor-login — the VENDOR sign-in (P3, v2). Separate from the staff
// /login: its own API, its own token. The server answers every refusal with
// the same "Invalid credentials." First sign-in (and after an Admin reset)
// asks for a new password before anything else.
export const PW_HINT = 'At least 10 characters, with a capital letter, a small letter, a number and a symbol.';

export default function VendorLogin() {
  const navigate = useNavigate();
  const [step, setStep] = useState('signin'); // signin | password | off
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const n = sessionStorage.getItem(VENDOR_NOTICE_KEY);
      if (n) { setNotice(n); sessionStorage.removeItem(VENDOR_NOTICE_KEY); }
    } catch { /* ignore */ }
    // The feature flag: a switched-off portal says so instead of a dead form.
    vendorApi.get('/status').catch((err) => { if (err.response?.status === 404) setStep('off'); });
    if (!vendorToken()) return;
    vendorApi.get('/me').then((r) => {
      if (r.data.mustChangePassword) setStep('password');
      else navigate('/vendor/assets', { replace: true });
    }).catch(() => setVendorToken(null));
  }, [navigate]);

  async function signIn(e) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await vendorApi.post('/login', { email, password });
      setVendorToken(r.data.token);
      if (r.data.vendor?.mustChangePassword) setStep('password');
      else navigate('/vendor/assets', { replace: true });
    } catch (err) {
      setError(err.response?.status === 401 ? 'Invalid credentials. Check your email and password. If you cannot sign in, ask the company.' : vendorError(err, 'Could not sign in.'));
    } finally { setBusy(false); }
  }

  async function changePw(e) {
    e.preventDefault();
    setError('');
    if (newPw !== newPw2) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      await vendorApi.post('/change-password', { currentPassword: password, newPassword: newPw, confirmPassword: newPw2 });
      navigate('/vendor/assets', { replace: true });
    } catch (err) {
      setError(vendorError(err, 'Could not change the password.'));
    } finally { setBusy(false); }
  }

  async function cancel() {
    try { await vendorApi.post('/logout'); } catch { /* already out */ }
    setVendorToken(null);
    setStep('signin'); setPassword(''); setNewPw(''); setNewPw2('');
  }

  if (step === 'off') {
    return (
      <div className="login-shell vp-login">
        <div className="login-card">
          <div className="logo-lockup"><TeamLinkMark width={168} /><div className="vp-login-title">Vendor Portal</div></div>
          <div className="notice amber"><span>The Vendor Portal is not open yet. Please contact TeamLink Accounts.</span></div>
          <div className="small-muted" style={{ marginTop: 14, fontSize: 12, textAlign: 'center' }}>Company staff? <Link to="/login">Staff sign-in</Link></div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell vp-login">
      {step === 'signin' ? (
        <form className="login-card" onSubmit={signIn}>
          <div className="logo-lockup">
            <TeamLinkMark width={168} />
            <div className="vp-login-title">Vendor Portal</div>
          </div>
          <div className="small-muted" style={{ marginBottom: 14 }}>
            For our vendors: see the assets you supply or service, and send your bills.
          </div>
          {notice && <div className="notice amber" style={{ marginBottom: 10 }}><span>{notice}</span></div>}
          <label htmlFor="vpEmail">Email</label>
          <input id="vpEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          <div style={{ marginTop: 12 }}>
            <label htmlFor="vpPassword">Password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="vpPassword" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" style={{ paddingRight: 64 }} required
              />
              <button type="button" className="link-btn vp-show" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div className="small-muted" style={{ marginTop: 8, fontSize: 12 }}>Forgot your password? Ask the company to reset it for you.</div>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
          <button className="btn btn-primary vp-wide" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button>
          <div className="small-muted" style={{ marginTop: 14, fontSize: 12, textAlign: 'center' }}>
            Company staff? <Link to="/login">Staff sign-in</Link>
          </div>
        </form>
      ) : (
        <form className="login-card" onSubmit={changePw}>
          <div className="logo-lockup">
            <TeamLinkMark width={140} />
            <div className="vp-login-title">Set your own password</div>
          </div>
          <div className="small-muted" style={{ marginBottom: 14 }}>
            This is your first sign-in (or your password was reset). Choose a new password to continue.
          </div>
          {!password && (
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="vpCur">Password you were given</label>
              <input id="vpCur" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
          )}
          <label htmlFor="vpNew">New password</label>
          <input id="vpNew" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required />
          <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{PW_HINT} Not one you used before.</div>
          <div style={{ marginTop: 12 }}>
            <label htmlFor="vpNew2">New password again</label>
            <input id="vpNew2" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" required />
          </div>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
          <button className="btn btn-primary vp-wide" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
          <button type="button" className="btn btn-ghost vp-wide" style={{ marginTop: 8 }} onClick={cancel}>Cancel and sign out</button>
        </form>
      )}
    </div>
  );
}
