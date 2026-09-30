import { useEffect, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// EMAIL VERIFICATION on the employee's own details form.
//
//   the email in the form ── Send code ──▶ a 6-digit code in that inbox
//                          ◀── Verify ──── typed back here → Verified
//
// It checks whatever address is in the form RIGHT NOW, so a changed email
// reads "Not verified" until the new one is proved. It lives inside the
// profile <form>, so it uses plain buttons (type="button"), never a nested
// form. Not verifying is allowed — but HR is told (utils/
// employeeEmailVerification.js): when the profile is submitted unverified,
// and when a sent code is not entered within a day.
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function EmailVerify({ email, disabled }) {
  const address = String(email || '').trim().toLowerCase();
  const [state, setState] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  // Re-read whenever the address in the form settles.
  useEffect(() => {
    setError(''); setNote(''); setCode('');
    if (!EMAIL_RE.test(address)) { setState(null); return undefined; }
    const t = setTimeout(() => {
      api.get('/employees/me/verify-email', { params: { email: address } })
        .then((r) => setState(r.data)).catch(() => setState(null));
    }, 400);
    return () => clearTimeout(t);
  }, [address]);

  async function send() {
    setBusy('send'); setError(''); setNote('');
    try {
      const r = await api.post('/employees/me/verify-email/start', { email: address });
      setState(r.data.state);
      setNote(r.data.alreadyVerified ? 'This address is already verified.' : `Code sent to ${address}. It expires in ${r.data.ttlMinutes} minutes.`);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not send the code.');
      if (e.response?.data?.state) setState(e.response.data.state);
    } finally { setBusy(''); }
  }

  async function verify() {
    setBusy('verify'); setError(''); setNote('');
    try {
      const r = await api.post('/employees/me/verify-email/confirm', { email: address, code });
      setState(r.data.state); setCode('');
      setNote('Email verified.');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not verify that code.');
      if (e.response?.data?.state) setState(e.response.data.state);
    } finally { setBusy(''); }
  }

  if (!address) return null;
  const valid = EMAIL_RE.test(address);
  const verified = !!(state && state.verified);
  const pending = !!(state && state.pending);

  return (
    <div className="email-verify">
      <div className="email-verify-row">
        <span className="k">Email verification</span>
        <span className="small-muted">{address}</span>
        {!valid && <span className="status pending">Enter a valid email</span>}
        {valid && verified && <span className="status approved">✓ Verified</span>}
        {valid && !verified && <span className="status priority-high">Not verified</span>}
        {valid && !verified && !disabled && (
          <button type="button" className="btn btn-sm" onClick={send} disabled={!!busy}>
            {busy === 'send' ? 'Sending…' : pending ? 'Resend code' : 'Send code'}
          </button>
        )}
      </div>
      {valid && !verified && pending && !disabled && (
        <div className="email-verify-row">
          <input
            inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (code.length === 6) verify(); } }}
            style={{ width: 130 }}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={verify} disabled={code.length !== 6 || !!busy}>
            {busy === 'verify' ? 'Verifying…' : 'Verify'}
          </button>
          <span className="small-muted">{state.pending.attemptsLeft} attempt(s) left</span>
        </div>
      )}
      {note && <div className="small-muted">{note}</div>}
      {error && <div className="error-text">{error}</div>}
      {valid && !verified && !pending && !error && (
        <div className="small-muted" style={{ fontSize: 11.5 }}>
          Press Send code and enter the code from your inbox. If you submit without verifying, HR is notified.
        </div>
      )}
    </div>
  );
}
