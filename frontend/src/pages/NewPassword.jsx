import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { TeamLinkMark } from '../components/Logo.jsx';

// FORGOT PASSWORD - step 2: the page the emailed link opens (/new-password?token=...).
// The server decides everything (strength, expiry, single use); this page only
// shows it in plain words. The password is typed here and goes nowhere but the
// server; it is never kept, logged or shown back.

const COMMON = ['password', 'password1', 'password123', '12345678', 'qwerty123', 'teamlink1', 'welcome1', 'admin123'];

// A plain meter for a quick look. The server's rule is the real one.
function rate(pw) {
  const checks = [
    { ok: pw.length >= 8, text: 'At least 8 characters' },
    { ok: /[A-Za-z]/.test(pw) && /\d/.test(pw), text: 'A letter and a number' },
    { ok: !COMMON.includes(pw.toLowerCase()), text: 'Not a common password' },
  ];
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  if (!checks.every((c) => c.ok)) score = Math.min(score, 1);
  const level = !pw ? 0 : score <= 1 ? 1 : score <= 3 ? 2 : 3;
  return { checks, level };
}
const LEVELS = [
  { text: '', color: '#e5e7eb' },
  { text: 'Weak', color: '#dc2626' },
  { text: 'Good', color: '#2563eb' },
  { text: 'Strong', color: '#16a34a' },
];

// Outside the page component on purpose: defined inside, it would be a new
// component on every keystroke and the inputs would lose focus.
function Card({ children }) {
  return (
    <div className="login-shell"><div className="login-card" style={{ maxWidth: 420 }}>
      <div className="logo-lockup"><TeamLinkMark width={168} /></div>
      {children}
    </div></div>
  );
}

export default function NewPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true });
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState('');
  // "This password is already used by your other login on this email": a hint, asked once; pressing the button again uses it anyway.
  const [sameHint, setSameHint] = useState(false);

  useEffect(() => {
    if (!token) { setState({ loading: false, code: 'invalid', error: 'This link is not valid. Ask for a new one.' }); return; }
    api.get('/auth/reset-password/check', { params: { token } })
      .then((res) => setState({ loading: false, ok: true, minutesLeft: res.data.minutesLeft }))
      .catch((err) => setState({ loading: false, code: err.response?.data?.code || 'invalid', error: err.response?.data?.error || 'This link is not valid. Ask for a new one.' }));
  }, [token]);

  const meter = useMemo(() => rate(pw), [pw]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (pw !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      if (!sameHint) {
        const chk = await api.post('/auth/reset-password/same-check', { token, password: pw }).catch(() => ({ data: {} }));
        if (chk.data && chk.data.sameAsOther) { setSameHint(true); setBusy(false); return; }
      }
      await api.post('/auth/reset-password', { token, password: pw, confirmPassword: confirm });
      setPw(''); setConfirm('');
      setDone(true);
    } catch (err) {
      const d = err.response?.data || {};
      if (['expired', 'used', 'superseded', 'invalid'].includes(d.code)) setState({ loading: false, code: d.code, error: d.error });
      else setError(d.error || 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setResent('');
    try {
      await api.post('/auth/reset-password/resend', { token });
      setResent('If this email is registered, a new link is on its way. Check Inbox and Spam.');
    } catch (err) {
      setResent(err.response?.data?.error || 'We could not send the email right now. Please ask your Admin to help you.');
    } finally { setBusy(false); }
  }

  if (state.loading) return <Card><div className="small-muted">Checking your link…</div></Card>;

  if (done) {
    return (
      <Card>
        <div data-testid="reset-done">
          <h1 style={{ fontSize: 20, margin: '8px 0 10px' }}>Password changed</h1>
          <div className="notice" style={{ display: 'block' }}>Your new password is ready. Please sign in with it.</div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} onClick={() => navigate('/login')}>Sign in</button>
        </div>
      </Card>
    );
  }

  if (!state.ok) {
    return (
      <Card>
        <div data-testid="reset-bad-link">
          <h1 style={{ fontSize: 20, margin: '8px 0 10px' }}>{state.code === 'expired' ? 'This link has expired' : 'This link cannot be used'}</h1>
          <div className="error-text" style={{ marginBottom: 12 }}>{state.error}</div>
          {token && state.code !== 'invalid' ? (
            <>
              <button className="btn btn-primary" disabled={busy || !!resent} style={{ width: '100%', justifyContent: 'center' }} onClick={resend}>
                {busy ? 'Sending…' : 'Send me a new link'}
              </button>
              {resent && <div className="notice" style={{ display: 'block', marginTop: 12 }}>{resent}</div>}
            </>
          ) : (
            <Link className="btn btn-primary" to="/forgot-password" style={{ width: '100%', justifyContent: 'center' }}>Get a new link</Link>
          )}
          <div style={{ marginTop: 14, textAlign: 'center' }}><Link to="/login">Back to sign in</Link></div>
        </div>
      </Card>
    );
  }

  const lvl = LEVELS[meter.level];
  return (
    <Card>
      <form onSubmit={submit}>
        <h1 style={{ fontSize: 20, margin: '8px 0 6px' }}>Choose a new password</h1>
        <div className="small-muted" style={{ marginBottom: 14 }}>
          This link works once. It stops working in about {state.minutesLeft} minute{state.minutesLeft === 1 ? '' : 's'}.
        </div>

        <label htmlFor="npPw">New password</label>
        <div style={{ position: 'relative' }}>
          <input id="npPw" type={show ? 'text' : 'password'} autoComplete="new-password" required autoFocus value={pw}
            onChange={(e) => { setPw(e.target.value); setError(''); setSameHint(false); }} style={{ paddingRight: 64 }} />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, cursor: 'pointer', fontSize: 12 }}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>

        <div aria-hidden="true" style={{ display: 'flex', gap: 4, marginTop: 8 }}>
          {[1, 2, 3].map((i) => <div key={i} style={{ flex: 1, height: 6, borderRadius: 3, background: meter.level >= i ? lvl.color : '#e5e7eb' }} />)}
        </div>
        <div className="small-muted" style={{ marginTop: 4, minHeight: 16 }} data-testid="meter-text">{pw ? `Strength: ${lvl.text}` : ' '}</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 12px', fontSize: 12 }}>
          {meter.checks.map((c) => (
            <li key={c.text} style={{ color: pw ? (c.ok ? '#16a34a' : '#6b7280') : '#6b7280' }}>{pw && c.ok ? '✓' : '•'} {c.text}</li>
          ))}
        </ul>

        <label htmlFor="npConfirm">Type it again</label>
        <input id="npConfirm" type={show ? 'text' : 'password'} autoComplete="new-password" required value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setError(''); }} />
        {confirm && pw !== confirm && <div className="small-muted" style={{ color: '#b45309', marginTop: 4 }}>These two are not the same yet.</div>}

        {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
        {sameHint && (
          <div className="notice amber" style={{ display: 'block', marginTop: 10 }} data-testid="same-password-hint">
            This password is already used by your other login on this email. Choose a different one so each login can be opened
            separately. If you keep it, TeamLink will ask which login to open each time you sign in.
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}>
          {busy ? 'Saving…' : (sameHint ? 'Use this password anyway' : 'Save new password')}
        </button>
      </form>
    </Card>
  );
}
