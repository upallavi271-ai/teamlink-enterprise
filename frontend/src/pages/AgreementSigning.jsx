// ---------------------------------------------------------------------------
// THE CLIENT-FACING SIGNING PAGE — reached by the link TeamLink sends by
// email, SMS and WhatsApp. No TeamLink login: the token in the link is the key.
//
//   1. READ      the agreement, then "OK, Proceed"
//   2. SIGN      type your name (signature font), draw, or upload a signature
//   3. VERIFY    a 6-digit code goes to the REGISTERED mobile on your client
//                record (SMS; WhatsApp if SMS is not set up; email only as a
//                last fallback) — the page says exactly where it went
//   4. SUBMIT    the right code signs the agreement; download the PDF
//
// The server enforces the same order, expiry, cooldown and attempt limit —
// this page is the courteous version of rules that live in the API.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import SignatureCapture from '../components/agreements/SignatureCapture.jsx';
import '../components/agreements/agreements.css';

const STEPS = [['read', 'Read'], ['sign', 'Sign'], ['verify', 'Verify & submit']];

function when(d) {
  return d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export default function AgreementSigning() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [read, setRead] = useState(false);
  const [resign, setResign] = useState(false);
  const [who, setWho] = useState({ signedBy: '', signedByTitle: '' });
  const [sig, setSig] = useState({ method: 'typed', blob: null });
  const [stamp, setStamp] = useState(null);
  const [sent, setSent] = useState(null);
  const [otp, setOtp] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState(null);

  const load = useCallback(() => {
    api.get(`/public/agreement/${token}`)
      .then((res) => {
        setView(res.data);
        if (res.data.otp && res.data.otp.cooldownRemaining) setCooldown(res.data.otp.cooldownRemaining);
        if (res.data.otp && res.data.otp.waiting && res.data.otp.sentTo) setSent((s) => s || { destination: res.data.otp.sentTo, ttlMinutes: res.data.otp.ttlMinutes, restored: true });
      })
      .catch((err) => setFatal(err.response?.data?.error || 'This signing link is not valid.'));
  }, [token]);
  useEffect(load, [load]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const step = !view ? 'read'
    : (!view.proceededAt ? 'read' : ((!view.signature.captured || resign) ? 'sign' : 'verify'));
  const done = view && !view.open;

  async function proceed() {
    setBusy('proceed'); setError('');
    try {
      const res = await api.post(`/agreement/token/${token}/proceed`, {});
      setView(res.data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { setError(err.response?.data?.error || 'Could not continue.'); } finally { setBusy(''); }
  }

  async function saveSignature() {
    if (!sig.blob) { setError('Add your signature first — type, draw or upload it.'); return; }
    setBusy('sign'); setError('');
    try {
      const body = new FormData();
      body.append('method', sig.method);
      body.append('signedBy', who.signedBy.trim());
      body.append('signedByTitle', who.signedByTitle.trim());
      body.append('file', sig.blob, sig.method === 'uploaded' && sig.blob.name ? sig.blob.name : 'signature.png');
      let res = await api.post(`/agreement/token/${token}/signature`, body);
      if (stamp) {
        const s = new FormData();
        s.append('kind', 'client-stamp');
        s.append('file', stamp, stamp.name || 'stamp.png');
        res = await api.post(`/agreement/token/${token}/client-seal`, s);
      }
      setView(res.data);
      setResign(false);
      setSent(null);
      setOtp('');
    } catch (err) { setError(err.response?.data?.error || 'The signature could not be saved.'); } finally { setBusy(''); }
  }

  async function sendCode() {
    setBusy('send'); setError('');
    try {
      const res = await api.post(`/agreement/token/${token}/otp/send`, {});
      setSent(res.data);
      setCooldown(res.data.resendInSeconds || 60);
      setAttemptsLeft(res.data.attemptsLeft);
      setOtp('');
    } catch (err) {
      const d = err.response?.data || {};
      if (d.retryAfter) setCooldown(d.retryAfter);
      setError(d.error || 'The code could not be sent.');
    } finally { setBusy(''); }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy('verify'); setError('');
    try {
      const res = await api.post(`/agreement/token/${token}/otp/verify`, { otp });
      setView(res.data);
    } catch (err) {
      const d = err.response?.data || {};
      if (d.attemptsLeft !== undefined) setAttemptsLeft(d.attemptsLeft);
      if (d.locked || d.expired) setSent(null);
      setError(d.error || 'That code could not be checked.');
    } finally { setBusy(''); }
  }

  const header = (
    <header className="careers-header">
      <div className="logo-lockup">
        <div className="mark">TL</div>
        <div>
          <div style={{ fontWeight: 600 }}>TeamLink Consultants</div>
          <div className="small-muted">Service agreement — secure e-signing</div>
        </div>
      </div>
    </header>
  );

  if (fatal) {
    return (
      <div className="careers-shell">{header}
        <main className="agr-sign"><div className="agr-card"><h3>This link cannot be used</h3><p>{fatal}</p></div></main>
      </div>
    );
  }
  if (!view) return <div className="careers-shell">{header}<main className="agr-sign"><div className="small-muted">Loading…</div></main></div>;

  return (
    <div className="careers-shell">
      {header}
      <main className="agr-sign">
        <h1>Recruitment / Staffing Services Agreement</h1>
        <div className="small-muted">
          {view.clientName}{view.agreementId ? ` · ${view.agreementId}` : ''}
          {view.open && view.linkExpiresAt ? ` · link valid until ${when(view.linkExpiresAt)}` : ''}
        </div>

        {done ? (
          <div className="agr-card agr-done">
            <div className="tick" aria-hidden="true">✓</div>
            <h3>Agreement signed</h3>
            <p className="small-muted">
              Signed by {view.signedBy}{view.signedByTitle ? ` (${view.signedByTitle})` : ''} on {when(view.signedAt)}.
            </p>
            <p style={{ fontSize: 13.5 }}>
              {view.status === 'ACTIVE'
                ? 'TeamLink has countersigned — the agreement is now Active.'
                : 'TeamLink will countersign it; you will be able to see the final copy in your TeamLink client login.'}
            </p>
            {view.pdfAvailable && (
              <a className="btn btn-primary" href={`/api/agreement/token/${token}/pdf`}>Download signed PDF</a>
            )}
          </div>
        ) : (
          <>
            <ol className="agr-steps">
              {STEPS.map(([k, label], i) => {
                const idx = STEPS.findIndex(([x]) => x === step);
                return <li key={k} className={k === step ? 'on' : (i < idx ? 'done' : '')}>{`${i + 1}. ${label}`}</li>;
              })}
            </ol>
            {error && <div className="notice red" role="alert">{error}</div>}

            {step === 'read' && (
              <>
                <div className="agr-doc" tabIndex={0}>{view.document}</div>
                <label className="agr-check">
                  <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
                  <span>I have read the agreement and I am authorised to sign it for {view.clientName}.</span>
                </label>
                <div className="agr-actions">
                  <button type="button" className="btn btn-primary" disabled={!read || busy === 'proceed'} onClick={proceed}>
                    {busy === 'proceed' ? 'Please wait…' : 'OK, Proceed'}
                  </button>
                </div>
              </>
            )}

            {step === 'sign' && (
              <div className="agr-card">
                <h3>Sign the agreement</h3>
                <div className="agr-fields">
                  <label className="field"><span>Signatory full name *</span>
                    <input value={who.signedBy} onChange={(e) => setWho({ ...who, signedBy: e.target.value })} placeholder="Full name" autoComplete="name" />
                  </label>
                  <label className="field"><span>Designation</span>
                    <input value={who.signedByTitle} onChange={(e) => setWho({ ...who, signedByTitle: e.target.value })} placeholder="Director / Authorised Signatory" />
                  </label>
                </div>
                <SignatureCapture name={who.signedBy} onChange={setSig} />
                <details style={{ marginTop: 10 }}>
                  <summary className="small-muted" style={{ cursor: 'pointer' }}>Add your company stamp (optional)</summary>
                  <input type="file" accept="image/png,image/jpeg" onChange={(e) => setStamp(e.target.files[0] || null)} style={{ marginTop: 6 }} />
                </details>
                <div className="agr-actions">
                  {resign && <button type="button" className="btn" onClick={() => setResign(false)}>Keep my earlier signature</button>}
                  <button type="button" className="btn btn-primary" disabled={busy === 'sign' || who.signedBy.trim().length < 2 || !sig.blob} onClick={saveSignature}>
                    {busy === 'sign' ? 'Saving…' : 'Save signature & continue'}
                  </button>
                </div>
              </div>
            )}

            {step === 'verify' && (
              <div className="agr-card">
                <h3>Confirm with a one-time code</h3>
                <div className="agr-kv" style={{ marginBottom: 10 }}>
                  <span className="k">Signed as</span>
                  <span>{view.signature.signedBy}{view.signature.signedByTitle ? `, ${view.signature.signedByTitle}` : ''} · {view.signature.method} <button type="button" className="btn btn-sm btn-ghost" onClick={() => setResign(true)}>Change</button></span>
                </div>
                {!sent ? (
                  <>
                    <p style={{ fontSize: 13.5 }}>
                      We will send a 6-digit code to your registered mobile number
                      {view.registeredMobile ? <> <b>{view.registeredMobile}</b></> : ' on your client record'} by SMS
                      (or WhatsApp if SMS is unavailable). The code is valid for {view.otp.ttlMinutes} minutes.
                    </p>
                    <div className="agr-actions">
                      <button type="button" className="btn btn-primary" disabled={busy === 'send' || cooldown > 0} onClick={sendCode}>
                        {busy === 'send' ? 'Sending…' : (cooldown > 0 ? `Send code (${cooldown}s)` : 'Send code')}
                      </button>
                    </div>
                  </>
                ) : (
                  <form onSubmit={submit}>
                    <div className="notice" role="status">
                      Code sent by <b>{sent.destination}</b>.{sent.ttlMinutes ? ` It is valid for ${sent.ttlMinutes} minutes.` : ''}
                      {sent.note && <div style={{ marginTop: 4 }}>{sent.note}</div>}
                    </div>
                    <label className="field" style={{ marginTop: 10 }}>
                      <span>Enter the 6-digit code</span>
                      <input className="agr-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
                    </label>
                    {attemptsLeft !== null && attemptsLeft < 5 && <div className="small-muted">{attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left.</div>}
                    <div className="agr-actions">
                      <button type="button" className="btn" disabled={busy === 'send' || cooldown > 0} onClick={sendCode}>
                        {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
                      </button>
                      <button type="submit" className="btn btn-primary" disabled={otp.length !== 6 || busy === 'verify'}>
                        {busy === 'verify' ? 'Submitting…' : 'Submit'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
