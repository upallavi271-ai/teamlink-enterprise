import { useEffect, useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import partnerApi, {
  setPartnerToken, partnerToken, partnerError, PARTNER_NOTICE_KEY,
} from '../../partnerApi';
import './partnerPortal.css';

const PW_HINT = 'At least 10 characters with a capital letter, a small letter, a number and a symbol.';

// /partner-login — the PARTNER (agency / freelancer) sign-in (B7). Separate
// from the staff /login and the vendor /vendor-login: its own API, its own
// token. First sign-in asks for a new password before anything else.
export default function PartnerLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const inviteToken = params.get('invite') || '';
  const [invite, setInvite] = useState(null); // { name, email, partnerName, purpose } once the link checks out
  const [step, setStep] = useState(inviteToken ? 'invite' : 'signin'); // signin | password | invite | badlink
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
      const n = sessionStorage.getItem(PARTNER_NOTICE_KEY);
      if (n) { setNotice(n); sessionStorage.removeItem(PARTNER_NOTICE_KEY); }
    } catch { /* ignore */ }
    if (inviteToken) {
      partnerApi.get(`/invite/${encodeURIComponent(inviteToken)}`).then((r) => { setInvite(r.data); setStep('invite'); })
        .catch(() => setStep('badlink'));
      return;
    }
    if (!partnerToken()) return;
    partnerApi.get('/me').then((r) => {
      if (r.data.mustChangePassword) setStep('password');
      else navigate('/partner/jobs', { replace: true });
    }).catch(() => setPartnerToken(null));
  }, [navigate, inviteToken]);

  async function acceptInvite(e) {
    e.preventDefault();
    setError('');
    if (newPw !== newPw2) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      const r = await partnerApi.post('/invite/accept', { token: inviteToken, newPassword: newPw, confirmPassword: newPw2 });
      setPartnerToken(r.data.token);
      navigate('/partner/jobs', { replace: true });
    } catch (err) {
      if (err.response?.data?.linkProblem) setStep('badlink'); else setError(partnerError(err, 'Could not set the password.'));
    } finally { setBusy(false); }
  }

  async function signIn(e) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await partnerApi.post('/login', { email, password });
      setPartnerToken(r.data.token);
      if (r.data.partner?.mustChangePassword) setStep('password');
      else navigate('/partner/jobs', { replace: true });
    } catch (err) {
      const d = err.response?.data;
      setError(d?.triesLeft ? `${partnerError(err)} ${d.triesLeft} ${d.triesLeft === 1 ? 'try' : 'tries'} left before the login locks.` : partnerError(err, 'Could not sign in.'));
    } finally { setBusy(false); }
  }

  async function changePw(e) {
    e.preventDefault();
    setError('');
    if (newPw !== newPw2) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      await partnerApi.post('/change-password', { currentPassword: password, newPassword: newPw, confirmPassword: newPw2 });
      navigate('/partner/jobs', { replace: true });
    } catch (err) {
      setError(partnerError(err, 'Could not change the password.'));
    } finally { setBusy(false); }
  }

  async function cancel() {
    try { await partnerApi.post('/logout'); } catch { /* already out */ }
    setPartnerToken(null);
    setStep('signin'); setPassword(''); setNewPw(''); setNewPw2('');
  }

  if (step === 'badlink') {
    return (
      <div className="login-shell pp-login">
        <div className="login-card">
          <div className="logo-lockup"><TeamLinkMark width={140} /><div className="pp-login-title">This link has expired</div></div>
          <div className="small-muted" style={{ marginBottom: 14 }}>The link was already used, has expired or was replaced by a newer one. Ask TeamLink to send you a new link.</div>
          <Link className="btn btn-primary pp-wide" to="/partner-login">Go to sign in</Link>
        </div>
      </div>
    );
  }
  if (step === 'invite') {
    return (
      <div className="login-shell pp-login">
        <form className="login-card" onSubmit={acceptInvite}>
          <div className="logo-lockup"><TeamLinkMark width={140} /><div className="pp-login-title">{invite?.purpose === 'reset' ? 'Choose a new password' : 'Welcome - choose your password'}</div></div>
          {!invite ? <div className="small-muted">Checking your link...</div> : (
            <>
              <div className="small-muted" style={{ marginBottom: 14 }}>{invite.partnerName} - {invite.email}<br />Choose a password. Only you will know it.</div>
              <label htmlFor="ppInvNew">New password</label>
              <input id="ppInvNew" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required />
              <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{PW_HINT}</div>
              <div style={{ marginTop: 12 }}>
                <label htmlFor="ppInvNew2">New password again</label>
                <input id="ppInvNew2" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" required />
              </div>
              {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
              <button className="btn btn-primary pp-wide" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save and sign in'}</button>
            </>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="login-shell pp-login">
      {step === 'signin' ? (
        <form className="login-card" onSubmit={signIn}>
          <div className="logo-lockup">
            <TeamLinkMark width={168} />
            <div className="pp-login-title">Partner Portal</div>
          </div>
          <div className="small-muted" style={{ marginBottom: 14 }}>
            For our recruitment partners (agencies and freelancers): see the jobs shared with you, send candidates, follow their progress and your payouts.
          </div>
          {notice && <div className="notice amber" style={{ marginBottom: 10 }}><span>{notice}</span></div>}
          <label htmlFor="ppEmail">Email</label>
          <input id="ppEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          <div style={{ marginTop: 12 }}>
            <label htmlFor="ppPassword">Password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="ppPassword" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" style={{ paddingRight: 64 }} required
              />
              <button type="button" className="link-btn pp-show" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div className="small-muted" style={{ marginTop: 8, fontSize: 12 }}>Forgot your password? Ask TeamLink to reset it for you.</div>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
          <button className="btn btn-primary pp-wide" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button>
          <div className="small-muted" style={{ marginTop: 14, fontSize: 12, textAlign: 'center' }}>
            TeamLink staff? <Link to="/login">Staff sign-in</Link>
          </div>
        </form>
      ) : (
        <form className="login-card" onSubmit={changePw}>
          <div className="logo-lockup">
            <TeamLinkMark width={140} />
            <div className="pp-login-title">Set your own password</div>
          </div>
          <div className="small-muted" style={{ marginBottom: 14 }}>
            This is your first sign-in (or your password was reset). Choose a new password to continue.
          </div>
          {!password && (
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="ppCur">Password you were given</label>
              <input id="ppCur" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
          )}
          <label htmlFor="ppNew">New password</label>
          <input id="ppNew" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required />
          <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{PW_HINT}</div>
          <div style={{ marginTop: 12 }}>
            <label htmlFor="ppNew2">New password again</label>
            <input id="ppNew2" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" required />
          </div>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
          <button className="btn btn-primary pp-wide" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
          <button type="button" className="btn btn-ghost pp-wide" style={{ marginTop: 8 }} onClick={cancel}>Cancel and sign out</button>
        </form>
      )}
    </div>
  );
}
