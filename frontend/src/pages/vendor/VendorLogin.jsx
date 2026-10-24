import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import vendorApi, {
  setVendorToken, setPreviewToken, setVendorHome, vendorHome, vendorToken, vendorError, VENDOR_NOTICE_KEY,
} from '../../vendorApi';
import './vendorPortal.css';

// /vendor-login — the VENDOR sign-in (P3, v2). Separate from the staff
// /login: its own API, its own token. A stranger gets the plain "Invalid credentials.";
// somebody who holds a real credential is told the real reason (replaced by a
// newer email, paused after wrong tries ...) - the words come from the server. First sign-in (and after an Admin reset)
// asks for a new password before anything else.
// 2026-10-19: the welcome email carries the login ID, a TEMPORARY password and a secure link. Sign in with the temporary password (you
// are asked to choose your own at once) or open the link first. "Forgot your password?" below sends a one-time link (same answer for
// every address, so nobody can find out who has a login). A link ?verify=... confirms a NEW email address for this login.
export const PW_HINT = 'At least 10 characters, with a capital letter, a small letter, a number and a symbol.';

export default function VendorLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The link's secret is read ONCE and then taken out of the address bar (history, screenshots and shared screens never show it).
  const [inviteToken] = useState(() => params.get('invite') || '');
  const [verifyToken] = useState(() => params.get('verify') || '');
  useEffect(() => { if ((inviteToken || verifyToken) && window.location.search) window.history.replaceState(null, '', window.location.pathname); }, [inviteToken, verifyToken]);
  const [verifyInfo, setVerifyInfo] = useState(null);
  const [forgotEmail, setForgotEmail] = useState('');
  const [invite, setInvite] = useState(null); // { name, email, vendorName, purpose } once the link checks out
  const [step, setStep] = useState(inviteToken ? 'invite' : (verifyToken ? 'verify' : 'signin')); // signin | password | invite | badlink | off | forgot | forgotDone | verify | verifyDone
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const n = sessionStorage.getItem(VENDOR_NOTICE_KEY);
      if (n) { setNotice(n); sessionStorage.removeItem(VENDOR_NOTICE_KEY); }
    } catch { /* ignore */ }
    // The feature flag: a switched-off portal says so instead of a dead form.
    vendorApi.get('/status').catch((err) => { if (err.response?.status === 404) setStep('off'); });
    // ADMIN PREVIEW: Vendor logins → "Open portal" sends a single-use token in the
    // URL #fragment (never sent to a server log). Trade it, then drop it from the address.
    const pv = new URLSearchParams((window.location.hash || '').replace(/^#/, '')).get('preview');
    if (pv) {
      window.history.replaceState(null, '', window.location.pathname);
      setStep('preview');
      vendorApi.post('/preview/redeem', { token: pv }).then((r) => {
        setPreviewToken(r.data.token);
        setVendorHome(r.data.landing);
        navigate(vendorHome(), { replace: true });
      }).catch((err) => { setPreviewToken(null); setError(vendorError(err, 'This link is not valid or has expired.')); setStep('badlink'); });
      return;
    }
    if (inviteToken) {
      // A secure link wins over any older session in this browser.
      vendorApi.get(`/invite/${encodeURIComponent(inviteToken)}`).then((r) => { setInvite(r.data); setStep('invite'); })
        .catch(() => setStep('badlink'));
      return;
    }
    if (verifyToken) {
      vendorApi.get(`/email/verify/${encodeURIComponent(verifyToken)}`).then((r) => { setVerifyInfo(r.data); setStep('verify'); }).catch(() => setStep('badlink'));
      return;
    }
    if (!vendorToken()) return;
    vendorApi.get('/me').then((r) => {
      setVendorHome(r.data.landing);
      if (r.data.mustChangePassword) setStep('password');
      else navigate(vendorHome(), { replace: true });
    }).catch(() => setVendorToken(null));
  }, [navigate, inviteToken, verifyToken]);

  async function acceptInvite(e) {
    e.preventDefault();
    setError('');
    if (newPw !== newPw2) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      const r = await vendorApi.post('/invite/accept', { token: inviteToken, newPassword: newPw, confirmPassword: newPw2 });
      setVendorToken(r.data.token);
      try { const me = await vendorApi.get('/me'); setVendorHome(me.data.landing); } catch { /* default landing */ }
      navigate(vendorHome(), { replace: true });
    } catch (err) {
      if (err.response?.data?.linkProblem) setStep('badlink');
      else setError(vendorError(err, 'Could not set the password.'));
    } finally { setBusy(false); }
  }

  async function sendForgot(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await vendorApi.post('/forgot-password', { email: forgotEmail }); setStep('forgotDone'); } catch (err) { setError(vendorError(err, 'Could not send the request. Please try again.')); } finally { setBusy(false); }
  }
  async function confirmEmail() {
    setBusy(true); setError('');
    try { const r = await vendorApi.post('/email/verify/confirm', { token: verifyToken }); setVerifyInfo({ ...verifyInfo, done: r.data.message, newEmail: r.data.email }); setStep('verifyDone'); } catch (err) { if (err.response?.data?.linkProblem) setStep('badlink'); else setError(vendorError(err, 'Could not confirm the new email.')); } finally { setBusy(false); }
  }

  async function signIn(e) {
    e.preventDefault();
    setBusy(true); setError(''); setHint(''); setNotice('');
    try {
      const r = await vendorApi.post('/login', { email, password });
      setVendorToken(r.data.token);
      setVendorHome(r.data.landing);
      if (r.data.vendor?.mustChangePassword) setStep('password');
      else navigate(vendorHome(), { replace: true });
    } catch (err) {
      // The server now says WHY when it is safe to (replaced by a newer email, paused after wrong tries, switched off ...). Show its words as they are.
      setError(vendorError(err, 'Could not sign in.'));
      setHint(err.response?.data?.hint || '');
    } finally { setBusy(false); }
  }

  async function changePw(e) {
    e.preventDefault();
    setError('');
    if (newPw !== newPw2) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      await vendorApi.post('/change-password', { currentPassword: password, newPassword: newPw, confirmPassword: newPw2 });
      try { const me = await vendorApi.get('/me'); setVendorHome(me.data.landing); } catch { /* default landing */ }
      navigate(vendorHome(), { replace: true });
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

  if (step === 'preview') {
    return (
      <div className="login-shell vp-login">
        <div className="login-card"><div className="logo-lockup"><TeamLinkMark width={168} /><div className="vp-login-title">Vendor Portal</div></div><div className="small-muted">Opening the portal…</div></div>
      </div>
    );
  }

  if (step === 'badlink') {
    return (
      <div className="login-shell vp-login">
        <div className="login-card">
          <div className="logo-lockup"><TeamLinkMark width={168} /><div className="vp-login-title">Vendor Portal</div></div>
          <div className="notice amber"><span>This link is not valid or has expired. A link works only once. If you already set your password, sign in below. If you forgot it, use &ldquo;Forgot your password?&rdquo;. Otherwise ask your contact at the company to send you a new invitation.</span></div>
          <div className="small-muted" style={{ marginTop: 14, fontSize: 12, textAlign: 'center' }}><a href="/vendor-login">Sign in</a></div>
        </div>
      </div>
    );
  }

  if (step === 'forgot' || step === 'forgotDone') {
    return (
      <div className="login-shell vp-login">
        <form className="login-card" onSubmit={sendForgot}>
          <div className="logo-lockup"><TeamLinkMark width={140} /><div className="vp-login-title">Forgot your password?</div></div>
          {step === 'forgot' ? (
            <>
              <div className="small-muted" style={{ marginBottom: 12 }}>Type the email you sign in with. If it belongs to an active Vendor Portal login, we email you a secure link to choose a new password.</div>
              <label htmlFor="vpForgot">Email (your login ID)</label>
              <input id="vpForgot" type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} autoComplete="username" required />
              {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
              <button className="btn btn-primary vp-wide" type="submit" disabled={busy}>{busy ? 'Sending\u2026' : 'Email me a link'}</button>
            </>
          ) : (
            <div className="notice green"><span>If this email belongs to an active Vendor Portal login, we have emailed a link to choose a new password. Check your inbox and spam folder; the link works once for 1 hour. If you never set up your login, ask TeamLink to send your invitation again.</span></div>
          )}
          <button type="button" className="btn btn-ghost vp-wide" style={{ marginTop: 8 }} onClick={() => { setStep('signin'); setError(''); }}>Back to sign in</button>
        </form>
      </div>
    );
  }

  if (step === 'verify' || step === 'verifyDone') {
    return (
      <div className="login-shell vp-login">
        <div className="login-card">
          <div className="logo-lockup"><TeamLinkMark width={140} /><div className="vp-login-title">Confirm your new email</div></div>
          {step === 'verify' ? (
            !verifyInfo ? <div className="small-muted">Checking your link&hellip;</div> : (
              <>
                <div className="small-muted" style={{ marginBottom: 12 }}>{verifyInfo.vendorName}<br />Your login email will change from <b>{verifyInfo.currentEmail}</b> to <b>{verifyInfo.newEmail}</b>. Your password stays the same.</div>
                {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
                <button type="button" className="btn btn-primary vp-wide" disabled={busy} onClick={confirmEmail}>{busy ? 'Confirming\u2026' : 'Yes, use this email'}</button>
              </>
            )
          ) : (
            <>
              <div className="notice green"><span>{verifyInfo?.done}</span></div>
              <a className="btn btn-primary vp-wide" style={{ display: 'block', textAlign: 'center', marginTop: 10 }} href="/vendor-login">Go to sign in</a>
            </>
          )}
        </div>
      </div>
    );
  }

  if (step === 'invite') {
    return (
      <div className="login-shell vp-login">
        <form className="login-card" onSubmit={acceptInvite}>
          <div className="logo-lockup"><TeamLinkMark width={140} /><div className="vp-login-title">{invite?.purpose === 'reset' ? 'Choose a new password' : 'Welcome — choose your password'}</div></div>
          {!invite ? <div className="small-muted">Checking your link…</div> : (
            <>
              <div className="small-muted" style={{ marginBottom: 14 }}>
                {invite.vendorName}<br />Login ID: <b>{invite.loginId || invite.email}</b><br />Choose a password. Only you will know it.
              </div>
              <label htmlFor="vpNew">New password</label>
              <input id="vpNew" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required />
              <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{PW_HINT}</div>
              <div style={{ marginTop: 12 }}>
                <label htmlFor="vpNew2">New password again</label>
                <input id="vpNew2" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" required />
              </div>
              {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
              <button className="btn btn-primary vp-wide" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password and continue'}</button>
            </>
          )}
        </form>
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
            For our vendors: see your bills and payments, the documents shared with you, and the assets you look after.
          </div>
          {notice && <div className="notice amber" style={{ marginBottom: 10 }}><span>{notice}</span></div>}
          <div className="small-muted" style={{ marginBottom: 10, fontSize: 12.5 }}>First sign-in? Use the login ID and the temporary password from the <b>newest</b> email we sent you. You will then choose your own password.</div>
          <label htmlFor="vpEmail">Login ID (your email)</label>
          <input id="vpEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
          <div style={{ marginTop: 12 }}>
            <label htmlFor="vpPassword">Password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="vpPassword" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ paddingRight: 64 }} required
              />
              <button type="button" className="link-btn vp-show" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5 }}><button type="button" className="link-btn" onClick={() => { setStep('forgot'); setError(''); setForgotEmail(email); }}>Forgot your password?</button></div>
          {error && <div className="error-text" role="alert" style={{ marginTop: 10 }}>{error}</div>}
          {error && hint && <div className="small-muted" style={{ marginTop: 6, fontSize: 12.5 }}>{hint}</div>}
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
            This is your first sign-in (or your password was reset). Choose your own password to continue. The temporary password stops working once you do.
          </div>
          {!password && (
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="vpCur">Temporary password from your email</label>
              <input id="vpCur" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
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
