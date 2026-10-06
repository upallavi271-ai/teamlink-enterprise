// ---------------------------------------------------------------------------
// THE CANDIDATE'S OFFER PAGE (B3, 2026-10-06) — opened from the link the
// recruiter shares (Copy / WhatsApp). No login: the token is the key (stored
// hashed; it stops when a newer link or offer is made; the offer expires).
//
//   1. READ     the job, CTC, joining date and the letter
//   2. ANSWER   two big buttons: Accept · Decline
//   3a. ACCEPT  your signature (draw / type / upload — the same SignatureCapture
//               as the client agreement; Aadhaar eSign when TeamLink set it up)
//               → your name → "Email me the code" → the code → tick → Accept & sign
//   3b. DECLINE a reason → Send my answer
//   4. DONE     Thank you + Download the signed PDF
// The server enforces the same order (routes/offerLink.js).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import SignatureCapture from '../components/agreements/SignatureCapture.jsx';
import '../components/agreements/agreements.css';
import '../components/agreements/agreementSignPage.css';
import './offerSigning.css';

const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const money = (n) => (Number(n) > 0 ? `₹${Math.round(Number(n)).toLocaleString('en-IN')} a year` : 'To be confirmed');

export default function OfferSigning() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState(''); // '' | 'accept' | 'decline'
  const [sig, setSig] = useState({ method: 'drawn', blob: null });
  const [name, setName] = useState('');
  const [sent, setSent] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [otp, setOtp] = useState('');
  const [agree, setAgree] = useState(false);
  const [reason, setReason] = useState('');
  const [redoSign, setRedoSign] = useState(false);
  const [bust, setBust] = useState(0);
  const back = new URLSearchParams(window.location.search);
  const emBack = back.get('emudhra');

  const load = useCallback(() => {
    api.get(`/offer-link/${token}`)
      .then((r) => {
        setView(r.data);
        if (r.data.otp?.cooldownRemaining) setCooldown(r.data.otp.cooldownRemaining);
        if (r.data.otp?.waiting && r.data.otp.sentTo) setSent((x) => x || { sentTo: r.data.otp.sentTo, ttlMinutes: r.data.otp.ttlMinutes });
        if (r.data.signature?.name) setName((n) => n || r.data.signature.name);
        if (r.data.candidateName) setName((n) => n || r.data.candidateName.replace(/^ZZTEST\S*\s*/i, ''));
      })
      .catch((err) => setFatal(err.response?.data?.error || 'This link does not work. Ask your recruiter for a new link.'));
  }, [token]);
  useEffect(load, [load]);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function act(key, fn) {
    setBusy(key); setError(''); setNotice('');
    try {
      const r = await fn();
      if (r && r.data && r.data.status) setView(r.data);
      if (r && r.data && r.data.message) setNotice(r.data.message);
      setBust((b) => b + 1);
      return r;
    } catch (err) {
      const d = err.response?.data || {};
      if (d.retryAfter) setCooldown(d.retryAfter);
      if (d.locked || d.expired) { setSent(null); setOtp(''); }
      if (d.expired && !d.attemptsLeft) load();
      setError(d.error || 'That did not work. Please try again.');
      return null;
    } finally { setBusy(''); }
  }
  const saveSignature = () => act('sign', () => {
    const b = new FormData();
    b.append('method', sig.method);
    if (name.trim()) b.append('name', name.trim());
    b.append('file', sig.blob, sig.method === 'uploaded' && sig.blob.name ? sig.blob.name : 'signature.png');
    return api.post(`/offer-link/${token}/signature`, b);
  }).then((r) => { if (r) { setRedoSign(false); setSent(null); setOtp(''); } });
  const sendCode = () => act('code', async () => {
    const r = await api.post(`/offer-link/${token}/email-code`, {});
    setSent(r.data); setCooldown(r.data.resendInSeconds || 60); setOtp('');
    return null;
  });
  const accept = (e) => { e.preventDefault(); return act('accept', () => api.post(`/offer-link/${token}/accept`, { otp, name: name.trim(), agree })); };
  const decline = (e) => { e.preventDefault(); return act('decline', () => api.post(`/offer-link/${token}/decline`, { reason: reason.trim() })); };
  async function goEmudhra() {
    setBusy('emudhra'); setError('');
    try {
      const r = await api.post(`/offer-link/${token}/emudhra/start`, { name: name.trim(), agree });
      const form = document.createElement('form');
      form.method = 'POST'; form.action = r.data.gatewayUrl;
      Object.entries(r.data.fields || {}).forEach(([k, v]) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i); });
      document.body.appendChild(form); form.submit();
    } catch (err) { setBusy(''); setError(err.response?.data?.error || 'Aadhaar eSign could not start. Please sign another way.'); }
  }

  const header = (
    <header className="careers-header">
      <div className="logo-lockup">
        <div className="mark">TL</div>
        <div><div style={{ fontWeight: 600 }}>TeamLink</div><div className="small-muted">Your job offer</div></div>
      </div>
    </header>
  );
  if (fatal) {
    return <div className="careers-shell">{header}<main className="agr-sign ofs-page"><div className="agr-card agrs-stop"><h3>This link does not work</h3><p>{fatal}</p></div></main></div>;
  }
  if (!view) return <div className="careers-shell">{header}<main className="agr-sign ofs-page"><div className="small-muted">Loading your offer…</div></main></div>;

  const signed = view.signature?.captured && !redoSign;
  const ready = name.trim().length >= 2 && otp.length === 6 && agree && signed;

  return (
    <div className="careers-shell">
      {header}
      <main className="agr-sign ofs-page">
        <div className="ofs-head">
          <h1>{`Offer: ${view.job}`}</h1>
          <div className="small-muted">{[view.company, `Letter version ${view.version}`].filter(Boolean).join(' · ')}</div>
        </div>

        {view.status === 'Accepted' && (
          <div className="agr-card agr-done">
            <div className="tick" aria-hidden="true">✓</div>
            <h3>You accepted this offer. Congratulations!</h3>
            <p className="small-muted">{`Signed by ${view.signedName || '—'} on ${when(view.signedAt)}. Your recruiter will share the joining steps.`}</p>
            {view.pdfAvailable && <a className="btn btn-primary ofs-main" href={`/api/offer-link/${token}/pdf`}>Download the signed PDF</a>}
          </div>
        )}
        {view.status === 'Declined' && (
          <div className="agr-card ofs-info"><h3>You said no to this offer</h3><p className="small-muted">{`Your reason: ${view.declineReason || '—'}. Your recruiter has been told.`}</p></div>
        )}
        {view.status === 'Expired' && (
          <div className="agr-card agrs-stop"><h3>This offer has expired</h3><p>{`It was open until ${day(view.expiresAt)}. Ask your recruiter if a new offer is possible.`}</p></div>
        )}
        {emBack && view.open && (
          <div className="notice red" role="status">{emBack === 'cancelled' ? 'Aadhaar eSign was cancelled. Nothing was signed.' : 'Aadhaar eSign did not finish. Nothing was signed. You can sign another way below.'}</div>
        )}
        {error && <div className="notice red" role="alert">{error}</div>}
        {notice && !error && <div className="notice" role="status">{notice}</div>}

        <section className="ofs-facts" aria-label="Offer details">
          <div><span>Yearly CTC</span><b>{money(view.ctc)}</b></div>
          <div><span>Joining date</span><b>{view.joiningDate ? day(`${view.joiningDate}T00:00:00`) : 'To be confirmed'}</b></div>
          {view.open && <div className="ofs-due"><span>Answer by</span><b>{day(view.expiresAt)}</b></div>}
        </section>

        <pre className="ofs-letter">{view.letter}</pre>

        {view.open && !mode && (
          <div className="agr-card ofs-answer">
            <h3>Your answer</h3>
            <div className="ofs-two">
              <button type="button" className="btn btn-primary ofs-main" onClick={() => { setMode('accept'); setError(''); }}>Accept offer</button>
              <button type="button" className="btn ofs-main" onClick={() => { setMode('decline'); setError(''); }}>Decline</button>
            </div>
          </div>
        )}

        {view.open && mode === 'decline' && (
          <form className="agr-card" onSubmit={decline}>
            <h3>Decline the offer</h3>
            <label className="field"><span>Why? (a few words) *</span>
              <textarea rows="3" maxLength={500} value={reason} placeholder="e.g. I took another job" onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="ofs-two">
              <button type="button" className="btn" onClick={() => setMode('')}>Back</button>
              <button type="submit" className="btn btn-primary ofs-main" disabled={reason.trim().length < 2 || busy === 'decline'}>{busy === 'decline' ? 'Saving…' : 'Send my answer'}</button>
            </div>
          </form>
        )}

        {view.open && mode === 'accept' && !signed && (
          <div className="agr-card">
            <h3>Step 1 — Your signature</h3>
            <p className="small-muted">Pick one way: draw it, type your name, or upload a picture of it.</p>
            <label className="field"><span>Your full name *</span>
              <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" />
            </label>
            <SignatureCapture name={name} onChange={setSig} />
            <div className="ofs-two">
              <button type="button" className="btn" onClick={() => { setMode(''); setRedoSign(false); }}>Back</button>
              <button type="button" className="btn btn-primary ofs-main" disabled={!sig.blob || busy === 'sign'} onClick={saveSignature}>{busy === 'sign' ? 'Saving…' : 'Use this signature'}</button>
            </div>
            <div className="agrs-emudhra">
              <button type="button" className={`sig-tab agrs-emudhra-btn${view.emudhra?.available ? '' : ' is-off'}`} disabled={!view.emudhra?.available || name.trim().length < 2 || !agree || busy === 'emudhra'} onClick={goEmudhra}>
                Or: sign with Aadhaar eSign (eMudhra)
              </button>
              {view.emudhra?.available && (
                <label className="agr-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{`I accept this offer for ${view.job}.`}</span></label>
              )}
              <div className="small-muted">{view.emudhra?.available ? 'You sign on eMudhra\'s page with an OTP to your Aadhaar-linked mobile. TeamLink never sees your Aadhaar number.' : 'Not available yet.'}</div>
            </div>
          </div>
        )}

        {view.open && mode === 'accept' && signed && (
          <form className="agr-card agrs-sign" onSubmit={accept}>
            <h3>Step 2 — Confirm and accept</h3>
            <div className="agrs-have">
              <span>Your signature: <img src={`/api/offer-link/${token}/file/sign?v=${bust}`} alt="Your signature" /></span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRedoSign(true)}>Change</button>
            </div>
            <label className="field"><span>Your full name *</span>
              <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="agrs-step">
              <div className="agrs-num">✉</div>
              <div style={{ flex: 1 }}>
                <b>The code from your email</b>
                <div className="small-muted">{sent ? `Code sent by ${sent.sentTo}. It works for ${sent.ttlMinutes || 10} minutes.` : `We email a 6-digit code to ${view.contactEmail || 'your email on record'}.`}</div>
                <button type="button" className="btn agrs-codebtn" disabled={busy === 'code' || cooldown > 0} onClick={sendCode}>
                  {busy === 'code' ? 'Sending…' : (cooldown > 0 ? `Send again in ${cooldown}s` : (sent ? 'Send the code again' : 'Email me the code'))}
                </button>
                <label className="field" style={{ marginTop: 8 }}><span>The 6-digit code *</span>
                  <input className="agr-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
                </label>
              </div>
            </div>
            <label className="agr-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{`I have read this offer and I accept it (${view.job}${view.company ? `, ${view.company}` : ''}).`}</span></label>
            <button type="submit" className="btn btn-primary ofs-main" disabled={!ready || busy === 'accept'}>{busy === 'accept' ? 'Signing…' : 'Accept & sign'}</button>
            {!ready && <div className="small-muted agrs-hint">Fill your name and the code, and tick the box.</div>}
          </form>
        )}
      </main>
    </div>
  );
}
