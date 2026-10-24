import { useState } from 'react';
import { jp, jpError, when } from './jpKit.js';
import './jobpublish.css';

// ---------------------------------------------------------------------------
// "NEEDS YOUR HELP" box (human in the loop). Shown on the Post step, the job page and the Health screen.
//   * the site asked for a one-time code (OTP) and the run is WAITING with its browser open:
//       a box to type the code + [Send the code]. The code goes straight to the waiting run and is never stored or shown again.
//   * a CAPTCHA / 2-step / unusual-activity page stopped the run: TeamLink never solves these. It says what to do
//       (open the portal session on the posting computer, sign in yourself) and offers [I did it, try again].
// props: item = a queue entry (id, status, waiting, help, portal)  canPost  onChanged()
// ---------------------------------------------------------------------------
export default function NeedsHelp({ item, name, canPost, onChanged }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  if (!item) return null;
  const waiting = item.waiting && item.waiting.kind === 'OTP' ? item.waiting : null;
  const help = item.status === 'NEEDS_HUMAN' ? item.help : null;
  if (!waiting && !help) return null;

  async function sendCode(e) {
    e.preventDefault();
    const c = code.trim();
    if (!/^[A-Za-z0-9]{4,10}$/.test(c)) { setErr('Type the code exactly as it was sent: 4 to 10 letters or digits, no spaces.'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      await jp.post(`/queue/${item.id}/otp`, { code: c });
      setCode('');
      setMsg('The code was handed to the posting helper. Checking...');
      if (onChanged) setTimeout(onChanged, 1500);
    } catch (x) { setErr(jpError(x, 'The code could not be sent.')); } finally { setBusy(false); }
  }
  async function again() {
    setBusy(true); setErr(''); setMsg('');
    try { await jp.post(`/queue/${item.id}/retry`); setMsg('Sent again.'); if (onChanged) onChanged(); } catch (x) { setErr(jpError(x)); } finally { setBusy(false); }
  }
  return (
    <div className="jp-help" role="group" aria-label={`${name || 'The site'} needs your help`}>
      <b>Needs your help{name ? `: ${name}` : ''}</b>
      {waiting && (
        <>
          <div className="jp-note" style={{ color: '#6a4700' }}>{waiting.reason}</div>
          {canPost ? (
            <form className="jp-otp" onSubmit={sendCode}>
              <label className="jp-field">Enter the OTP
                <input className="jp-otpbox" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} aria-label="One-time code" />
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>Send the code</button>
            </form>
          ) : <div className="jp-note">Your team lead or the client manager types the code.</div>}
          <div className="jp-note">TeamLink waits until {when(waiting.until)}. The code is used once and is never saved.</div>
        </>
      )}
      {!waiting && help && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{help.title}</div>
          <div className="jp-note" style={{ color: '#6a4700' }}>{help.how}</div>
          {help.command && <div><span className="jp-code">{help.command}</span> <span className="jp-note">(type this on the computer that runs the posting helper)</span></div>}
          {canPost && ['CAPTCHA', 'OTP', 'TWO_FACTOR', 'UNUSUAL_ACTIVITY', 'EMAIL_VERIFY', 'BLOCKED'].includes(help.kind) && (
            <div className="jp-row"><button type="button" className="btn btn-primary" disabled={busy} onClick={again}>{help.kind === 'OTP' ? 'Try again' : 'I did it, try again'}</button></div>
          )}
        </>
      )}
      <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}{err && <div className="jp-err" role="alert">{err}</div>}</div>
    </div>
  );
}
