// ---------------------------------------------------------------------------
// THE CLIENT'S AGREEMENT PAGE — opened from the agreement link TeamLink shares
// (Copy link / WhatsApp / Email). No TeamLink login: the token in the link is
// the key (stored hashed on our side, it expires and can be stopped).
//
// In order (2026-10-05, the user's note item 8 — "e-sign & digital stamp
// from BOTH sides"):
//   1. READ      the key terms + the full agreement (Print works) → "OK, proceed"
//   2. E-SIGN    Draw with finger / mouse · Type my name · Upload a signature
//                image → preview → "Use this signature"
//   3. STAMP     the company stamp / seal (PNG / JPG) → preview → "Use this stamp"
//   4. CONFIRM   name + designation → "Email me the code" (to the contact email
//                on the company record) → the code → tick → "I agree & sign"
//   5. DONE      Thank you + Download the signed PDF
//
// The server enforces the same order (routes/agreementSeal.js): no signature
// before "OK, proceed", no "I agree & sign" without the signature AND the
// stamp AND the right code. Opening = Viewed; signing = Signed (time, IP,
// name recorded); Active once TeamLink has signed and stamped too.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import SignatureCapture from '../components/agreements/SignatureCapture.jsx';
import { StampPicker } from '../components/agreements/TeamLinkSeal.jsx';
import AgreementDocView, { signersFrom } from '../components/agreements/AgreementDocView.jsx';
import '../components/agreements/agreements.css';
import '../components/agreements/agreementSignPage.css';

function when(d) {
  return d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}
function day(d) {
  return d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}
const STEPS = [['read', '1. Read'], ['sign', '2. Sign'], ['stamp', '3. Stamp'], ['confirm', '4. Confirm']];

function Term({ k, v }) {
  return (
    <div className="agrs-term">
      <div className="k">{k}</div>
      <div className="v">{v || '—'}</div>
    </div>
  );
}

export default function AgreementSigning() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [redo, setRedo] = useState('');
  const [sig, setSig] = useState({ method: 'drawn', blob: null });
  const [stamp, setStamp] = useState(null);
  const [who, setWho] = useState({ name: '', designation: '' });
  const [sent, setSent] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [otp, setOtp] = useState('');
  const [agree, setAgree] = useState(false);
  const [bust, setBust] = useState(0);
  // Aadhaar eSign at eMudhra (2026-10-05): chosen at the Sign step; the
  // stamp is still needed; then the client goes to eMudhra's page.
  const [emudhra, setEmudhra] = useState(false);
  const back = new URLSearchParams(window.location.search);
  const [emResult, setEmResult] = useState(back.get('emudhra') ? { state: back.get('emudhra'), why: back.get('why') || '' } : null);

  const load = useCallback(() => {
    api.get(`/public/agreement/${token}`)
      .then((res) => {
        setView(res.data);
        const o = res.data.otp || {};
        if (o.cooldownRemaining) setCooldown(o.cooldownRemaining);
        if (o.waiting && o.sentTo) setSent((s) => s || { sentTo: o.sentTo, ttlMinutes: o.ttlMinutes });
        if (res.data.signature?.signedBy) setWho((w) => ({ name: w.name || res.data.signature.signedBy || '', designation: w.designation || res.data.signature.signedByTitle || '' }));
      })
      .catch((err) => setFatal(err.response?.data?.error || 'This link does not work. Ask your TeamLink contact for a new link.'));
  }, [token]);
  useEffect(load, [load]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function act(key, fn) {
    setBusy(key); setError('');
    try {
      const res = await fn();
      if (res && res.data && res.data.status) setView(res.data);
      setBust((b) => b + 1);
      window.scrollTo({ top: document.querySelector('.agrs-steps')?.offsetTop || 0, behavior: 'smooth' });
      return res;
    } catch (err) {
      const d = err.response?.data || {};
      if (d.retryAfter) setCooldown(d.retryAfter);
      if (d.locked || d.expired) { setSent(null); setOtp(''); }
      setError(d.error || 'That did not work. Please try again.');
      return null;
    } finally { setBusy(''); }
  }
  const proceed = () => act('proceed', () => api.post(`/agreement/token/${token}/proceed`, {}));
  // Sends the encrypted agreement to eMudhra's Signer Gateway as a form POST
  // (the browser goes to eMudhra's page; Aadhaar OTP happens there).
  async function goEmudhra(e) {
    e.preventDefault();
    setBusy('emudhra'); setError('');
    try {
      const r = await api.post(`/agreement/token/${token}/emudhra/start`, { name: who.name.trim(), designation: who.designation.trim(), agree });
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = r.data.gatewayUrl;
      Object.entries(r.data.fields || {}).forEach(([k, v]) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = k; i.value = v;
        form.appendChild(i);
      });
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setBusy('');
      setError(err.response?.data?.error || 'Aadhaar eSign could not start. Please try again, or use another way to sign.');
    }
  }
  const saveSignature = () => act('sign', () => {
    const b = new FormData();
    b.append('method', sig.method);
    if (who.name.trim()) b.append('signedBy', who.name.trim());
    b.append('file', sig.blob, sig.method === 'uploaded' && sig.blob.name ? sig.blob.name : 'signature.png');
    return api.post(`/agreement/token/${token}/signature`, b);
  }).then((r) => { if (r) { setRedo(''); setSent(null); setOtp(''); } });
  const saveStamp = () => act('stamp', () => {
    const b = new FormData();
    b.append('kind', 'client-stamp');
    b.append('file', stamp, stamp.name || 'stamp.png');
    return api.post(`/agreement/token/${token}/client-seal`, b);
  }).then((r) => { if (r) { setRedo(''); setStamp(null); } });
  const sendCode = () => act('code', async () => {
    const res = await api.post(`/agreement/token/${token}/email-code`, {});
    setSent(res.data);
    setCooldown(res.data.resendInSeconds || 60);
    setOtp('');
    return null;
  });
  const sign = (e) => {
    e.preventDefault();
    return act('final', () => api.post(`/agreement/token/${token}/agree-sign`, {
      otp, name: who.name.trim(), designation: who.designation.trim(), agree,
    }));
  };

  const header = (
    <header className="careers-header agrs-noprint">
      <div className="logo-lockup">
        <div className="mark">TL</div>
        <div>
          <div style={{ fontWeight: 600 }}>TeamLink Consultants</div>
          <div className="small-muted">Service agreement</div>
        </div>
      </div>
    </header>
  );

  if (fatal) {
    return (
      <div className="careers-shell">{header}
        <main className="agr-sign"><div className="agr-card agrs-stop"><h3>This link does not work</h3><p>{fatal}</p></div></main>
      </div>
    );
  }
  if (!view) return <div className="careers-shell">{header}<main className="agr-sign"><div className="small-muted">Loading the agreement…</div></main></div>;

  const t = view.keyTerms || {};
  const signed = !view.open && ['SIGNED', 'ACTIVE', 'EXPIRED'].includes(view.status);
  const step = !view.open ? 'done'
    : (!view.proceededAt ? 'read'
      : (((!view.signature?.captured && !emudhra) || redo === 'sign') ? 'sign'
        : ((!view.hasStamp || redo === 'stamp') ? 'stamp' : 'confirm')));
  const stepIdx = STEPS.findIndex(([k]) => k === step);
  const ready = who.name.trim().length >= 2 && who.designation.trim().length >= 2 && otp.length === 6 && agree;
  const img = (kind) => `/api/agreement/token/${token}/file/${kind}?v=${bust}`;

  return (
    <div className="careers-shell">
      {header}
      <main className="agr-sign agrs-page">
        <div className="agrs-title">
          <div>
            <h1>Service agreement</h1>
            <div className="small-muted">
              {`For ${t.clientName || view.clientName}`}{view.agreementId ? ` · ${view.agreementId}` : ''}
              {view.open && view.linkExpiresAt ? ` · this link works until ${day(view.linkExpiresAt)}` : ''}
            </div>
          </div>
          <button type="button" className="btn agrs-noprint" onClick={() => window.print()}>Print</button>
        </div>

        {signed && (
          <div className="agr-card agr-done agrs-noprint">
            <div className="tick" aria-hidden="true">✓</div>
            <h3>Signed. Thank you.</h3>
            <p className="small-muted">{`Signed by ${view.signedBy || '—'}${view.signedByTitle ? ` (${view.signedByTitle})` : ''} on ${when(view.signedAt)}.`}</p>
            <p style={{ fontSize: 13.5 }}>
              {view.status === 'ACTIVE' ? 'TeamLink has signed and stamped too — the agreement is now Active.' : 'TeamLink will add its signature and stamp, and then it becomes Active.'}
            </p>
            {view.pdfAvailable && <a className="btn btn-primary" href={`/api/agreement/token/${token}/pdf`}>Download the signed PDF</a>}
            {view.emudhra?.signed && <a className="btn" style={{ marginLeft: 8 }} href={`/api/agreement/token/${token}/pdf?copy=emudhra`}>Download the eMudhra-signed PDF</a>}
          </div>
        )}
        {!signed && !view.open && (
          <div className="agr-card agrs-stop agrs-noprint"><h3>This agreement is not open for signing</h3><p>Ask your TeamLink contact for a new link.</p></div>
        )}

        {view.open && (
          <ol className="agr-steps agrs-steps agrs-noprint">
            {STEPS.map(([k, label], i) => <li key={k} className={k === step ? 'on' : (i < stepIdx ? 'done' : '')}>{i < stepIdx ? `✓ ${label}` : label}</li>)}
          </ol>
        )}
        {error && <div className="notice red agrs-noprint" role="alert">{error}</div>}
        {emResult && view.open && (
          <div className={`notice agrs-noprint${emResult.state === 'signed' ? '' : ' red'}`} role="status">
            {emResult.state === 'cancelled' ? 'Aadhaar eSign was cancelled. Nothing was signed.' : `Aadhaar eSign did not finish${emResult.why ? ` (${emResult.why})` : ''}. Nothing was signed.`}
            <div className="agr-actions" style={{ justifyContent: 'flex-start' }}>
              <button type="button" className="btn btn-sm" onClick={() => { setEmResult(null); setEmudhra(true); }}>Try again</button>
              <button type="button" className="btn btn-sm" onClick={() => { setEmResult(null); setEmudhra(false); setRedo('sign'); }}>Use another way to sign</button>
            </div>
          </div>
        )}

        <section className="agrs-terms" aria-label="Key terms">
          <Term k="Your company" v={t.clientName || view.clientName} />
          <Term k="Fee" v={t.feeType && t.feeType !== 'PERCENT_CTC' ? t.feeText : (t.feePercent != null ? `${t.feePercent}% of the yearly CTC${t.gstApplicable === false ? '' : ` + GST ${t.gstPercent ?? 18}%`}` : null)} />
          <Term k="Replacement guarantee" v={t.guaranteeDays != null ? (t.guaranteeDays === 0 ? 'No replacement' : `${t.guaranteeDays} days (${t.guaranteeWords})`) : t.guarantee} />
          <Term k="Payment" v={t.paymentDays != null ? `Within ${t.paymentDays} days of the invoice` : t.paymentTerms} />
          {t.startDate && <Term k="Starts" v={day(`${t.startDate}T00:00:00`)} />}
          <Term k="Signs for TeamLink" v={t.signatoryName ? `${t.signatoryName}${t.signatoryTitle ? `, ${t.signatoryTitle}` : ''}` : t.consultantName} />
        </section>

        <div className={`agr-doc agr-doc-word agrs-doc${step === 'read' ? ' agrs-doc-read' : ''}`} tabIndex={0}>
          <AgreementDocView
            text={view.document}
            {...signersFrom({
              company: { signedBy: view.consultant?.signedBy, sealedAt: view.consultant?.sealedAt, hasSignature: !!view.consultant?.hasSignature, hasStamp: !!view.consultant?.hasStamp },
              clientSide: { signedBy: view.signedBy || view.signature?.signedBy, signedByTitle: view.signedByTitle || view.signature?.signedByTitle, hasSignature: !!view.signature?.captured, hasStamp: !!view.hasStamp, esign: view.emudhra?.signed ? 'eMudhra' : null },
              signedAt: signed ? view.signedAt : null,
              teamlinkName: t.signatoryName, teamlinkTitle: t.signatoryTitle,
            }, (kind) => <img src={img(kind)} alt={kind} />)}
          />
        </div>

        {step === 'read' && (
          <div className="agr-card agrs-noprint">
            <h3>Step 1 — Read the agreement</h3>
            <p style={{ fontSize: 13.5 }}>Read it above (you can Print it). When you are ready, press OK, proceed.</p>
            <button type="button" className="btn btn-primary agrs-main" disabled={busy === 'proceed'} onClick={proceed}>{busy === 'proceed' ? 'Please wait…' : 'OK, proceed'}</button>
          </div>
        )}

        {step === 'sign' && (
          <div className="agr-card agrs-noprint">
            <h3>Step 2 — Your signature</h3>
            <p className="small-muted">Pick one way: draw it, type your name, or upload a picture of it.</p>
            {sig.method === 'typed' && (
              <label className="field"><span>Your full name *</span>
                <input value={who.name} autoComplete="name" placeholder="e.g. Priya Sharma" onChange={(e) => setWho({ ...who, name: e.target.value })} />
              </label>
            )}
            <SignatureCapture name={who.name} onChange={setSig} />
            <div className="agr-actions" style={{ justifyContent: 'flex-start' }}>
              {redo === 'sign' && <button type="button" className="btn" onClick={() => setRedo('')}>Keep my earlier signature</button>}
              <button type="button" className="btn btn-primary agrs-main" disabled={busy === 'sign' || !sig.blob} onClick={saveSignature}>{busy === 'sign' ? 'Saving…' : 'Use this signature'}</button>
            </div>
            {/* The 4th way: Aadhaar eSign at eMudhra (shown greyed until TeamLink sets it up). */}
            <div className="agrs-emudhra">
              <button
                type="button"
                className={`sig-tab agrs-emudhra-btn${view.emudhra?.available ? '' : ' is-off'}`}
                disabled={!view.emudhra?.available}
                onClick={() => { setEmudhra(true); setRedo(''); }}
              >
                Or: sign with Aadhaar eSign (eMudhra)
              </button>
              <div className="small-muted">
                {view.emudhra?.available
                  ? 'You sign on eMudhra\'s page with an OTP sent to your Aadhaar-linked mobile. TeamLink never sees your Aadhaar number.'
                  : 'Not available yet.'}
              </div>
            </div>
          </div>
        )}

        {step === 'stamp' && (
          <div className="agr-card agrs-noprint">
            <h3>Step 3 — Your company stamp / seal</h3>
            <div className="agrs-have">
              {emudhra && !view.signature?.captured
                ? <span>Your signature: Aadhaar eSign at eMudhra (after this step)</span>
                : <span>Your signature: <img src={img('client-sign')} alt="Your signature" /></span>}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setEmudhra(false); setRedo('sign'); }}>Change</button>
            </div>
            <p className="small-muted">Upload a clear photo or scan of your company stamp. It is needed to sign.</p>
            <StampPicker file={stamp} onFile={setStamp} />
            <div className="agr-actions" style={{ justifyContent: 'flex-start' }}>
              {redo === 'stamp' && <button type="button" className="btn" onClick={() => setRedo('')}>Keep my earlier stamp</button>}
              <button type="button" className="btn btn-primary agrs-main" disabled={busy === 'stamp' || !stamp} onClick={saveStamp}>{busy === 'stamp' ? 'Saving…' : 'Use this stamp'}</button>
            </div>
          </div>
        )}

        {step === 'confirm' && emudhra && !view.signature?.captured && (
          <form className="agr-card agrs-sign agrs-noprint" onSubmit={goEmudhra}>
            <h3>Step 4 — Sign with Aadhaar eSign (eMudhra)</h3>
            <div className="agrs-have">
              <span>Stamp: <img src={img('client-stamp')} alt="Your company stamp" /> <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRedo('stamp')}>Change</button></span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setEmudhra(false); setRedo('sign'); }}>Use another way to sign</button>
            </div>
            <div className="agr-fields agrs-fields">
              <label className="field"><span>Your full name (as on Aadhaar) *</span>
                <input value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} autoComplete="name" placeholder="e.g. Priya Sharma" />
              </label>
              <label className="field"><span>Your designation *</span>
                <input value={who.designation} onChange={(e) => setWho({ ...who, designation: e.target.value })} autoComplete="organization-title" placeholder="e.g. HR Manager" />
              </label>
            </div>
            <label className="agr-check">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>{`I have read this agreement and I agree to it for ${t.clientName || view.clientName}.`}</span>
            </label>
            <button type="submit" className="btn btn-primary agrs-main" disabled={who.name.trim().length < 2 || who.designation.trim().length < 2 || !agree || busy === 'emudhra'}>
              {busy === 'emudhra' ? 'Opening eMudhra…' : 'Continue to Aadhaar eSign'}
            </button>
            <div className="small-muted agrs-hint">You will go to eMudhra&apos;s page, type your Aadhaar number there and the OTP from your Aadhaar-linked mobile. Then you come back here.</div>
          </form>
        )}

        {step === 'confirm' && !(emudhra && !view.signature?.captured) && (
          <form className="agr-card agrs-sign agrs-noprint" onSubmit={sign}>
            <h3>Step 4 — Confirm and sign</h3>
            <div className="agrs-have">
              <span>Signature: <img src={img('client-sign')} alt="Your signature" /> <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRedo('sign')}>Change</button></span>
              <span>Stamp: <img src={img('client-stamp')} alt="Your company stamp" /> <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRedo('stamp')}>Change</button></span>
            </div>
            <div className="agr-fields agrs-fields">
              <label className="field"><span>Your full name *</span>
                <input value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} autoComplete="name" placeholder="e.g. Priya Sharma" />
              </label>
              <label className="field"><span>Your designation *</span>
                <input value={who.designation} onChange={(e) => setWho({ ...who, designation: e.target.value })} autoComplete="organization-title" placeholder="e.g. HR Manager" />
              </label>
            </div>
            <div className="agrs-step">
              <div className="agrs-num">✉</div>
              <div style={{ flex: 1 }}>
                <b>The code from your email</b>
                <div className="small-muted">
                  {sent ? `Code sent by ${sent.sentTo}. It works for ${sent.ttlMinutes || 10} minutes.` : `We email a 6-digit code to ${view.contactEmail || 'the email on your company record'}.`}
                </div>
                <button type="button" className="btn agrs-codebtn" disabled={busy === 'code' || cooldown > 0} onClick={sendCode}>
                  {busy === 'code' ? 'Sending…' : (cooldown > 0 ? `Send again in ${cooldown}s` : (sent ? 'Send the code again' : 'Email me the code'))}
                </button>
                <label className="field" style={{ marginTop: 8 }}><span>The 6-digit code *</span>
                  <input className="agr-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
                </label>
              </div>
            </div>
            <label className="agr-check">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>{`I have read this agreement and I agree to it for ${t.clientName || view.clientName}.`}</span>
            </label>
            <button type="submit" className="btn btn-primary agrs-main" disabled={!ready || busy === 'final'}>{busy === 'final' ? 'Signing…' : 'I agree & sign'}</button>
            {!ready && <div className="small-muted agrs-hint">Fill your name, designation and the code, and tick the box.</div>}
          </form>
        )}
      </main>
    </div>
  );
}
