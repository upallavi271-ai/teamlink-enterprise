import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
// Shown inside the built-in job portal's header and footer (2026-10-05).
import CareersChrome from './careers/CareersChrome.jsx';

// Public "My Applications" page (/careers/my-applications).
//
// SAFE BY DESIGN (spec B2 + the "My applications by email" fix, 2026-10-03):
// nothing about a person is shown here. The visitor types their email, gets a
// 6-digit ONE-TIME CODE in that inbox (POST /api/portal/public/otp/request —
// the same answer whether or not the email is known), and only a right code
// signs them in to their own candidate portal (/my-applications). A new person
// with no applications yet is asked for their name and becomes a candidate
// (careers-portal self-registration).
const keepToken = (token) => {
  try { localStorage.setItem('tl_token', token); } catch { /* storage blocked */ }
  window.location.assign('/my-applications');
};

export default function MyApplications() {
  const [step, setStep] = useState('email'); // email | code | name
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  async function sendCode(e) {
    if (e) e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api.post('/portal/public/otp/request', { email });
      setInfo(res.data.message);
      setCode('');
      setStep('code');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the code right now. Please try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { email, code };
      if (step === 'name') Object.assign(body, { name, phone });
      const res = await api.post('/portal/public/otp/verify', body);
      if (res.data.needsName) {
        setInfo(res.data.message);
        setStep('name');
        return;
      }
      if (res.data.token) keepToken(res.data.token);
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Ask for a new code and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <CareersChrome>
      <div className="jp-wrap jp-otp">
        <Link className="jp-back" to="/careers">← All jobs</Link>
        <h1 style={{ marginTop: 10 }}>See your applications</h1>

        <div className="card section">
          {step === 'email' && (
            <form onSubmit={sendCode}>
              <h3 style={{ marginTop: 0 }}>Step 1 of 2 — your email</h3>
              <p className="small-muted">Type the email you applied with. We will send a 6-digit code to it.</p>
              <input
                style={{ width: '100%' }}
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@gmail.com"
                aria-label="Your email"
              />
              <button className="btn btn-primary" style={{ marginTop: 12, width: '100%' }} type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send me a code'}
              </button>
            </form>
          )}

          {(step === 'code' || step === 'name') && (
            <form onSubmit={verify}>
              <h3 style={{ marginTop: 0 }}>{step === 'code' ? 'Step 2 of 2 — the code' : 'Last step — your name'}</h3>
              {info && <div className="notice" style={{ marginBottom: 10 }}><span>{info}</span></div>}
              {step === 'code' && (
                <input
                  style={{ width: '100%', fontSize: 22, letterSpacing: 6, textAlign: 'center' }}
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6-digit code"
                  aria-label="6-digit code"
                />
              )}
              {step === 'name' && (
                <>
                  <label htmlFor="maName">Your full name</label>
                  <input id="maName" style={{ width: '100%' }} required value={name} onChange={(e) => setName(e.target.value)} />
                  <label htmlFor="maPhone" style={{ marginTop: 8, display: 'block' }}>Mobile number (optional)</label>
                  <input id="maPhone" style={{ width: '100%' }} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </>
              )}
              <button className="btn btn-primary" style={{ marginTop: 12, width: '100%' }} type="submit" disabled={busy || (step === 'code' && code.length !== 6)}>
                {busy ? 'Checking…' : (step === 'code' ? 'Show my applications' : 'Create my profile')}
              </button>
              <div className="small-muted" style={{ marginTop: 10 }}>
                No code? Check spam, or{' '}
                <button type="button" className="link-btn" onClick={() => { setStep('email'); setInfo(''); setError(''); }}>use another email / send again</button>.
              </div>
            </form>
          )}
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <p className="small-muted">
          Have a password already? <Link to="/login">Sign in here</Link>. TeamLink never asks for your code on a call or chat.
        </p>
      </div>
    </CareersChrome>
  );
}
