// ---------------------------------------------------------------------------
// THE CLIENT PUTS THEIR COMPANY STAMP ON THE AGREEMENT (founder 2026-10-31: "client ey stamp veyyali"). No login: the link in the
// "Send to client" email (/agreement/<token>/stamp) is the key.
//   1. upload a photo / scan of the company stamp       POST /api/agreement/token/:token/client-seal (kind client-stamp)
//   2. download the agreement to eSign, both stamps on   GET  /api/agreement/token/:token/esign-pdf
//   3. eSign it with Aadhaar in DigiLocker
//   4. upload the signed PDF -> preview (checked) -> Submit -> thank you   POST /token/:token/esigned/check, then /esigned
// The stamp is printed into the PDF BEFORE the eSign, so the digital signature covers it.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { StampPicker } from '../components/agreements/TeamLinkSeal.jsx';
import { AgreementHeader } from '../components/agreements/AgreementBrand.jsx';
import '../components/agreements/agreements.css';
import '../components/agreements/agreementSignPage.css';

export default function AgreementStamp() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [fatal, setFatal] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stampUrl, setStampUrl] = useState('');
  // step 4: the signed PDF, its check, the preview, the thank-you
  const [signed, setSigned] = useState(null);
  const [checked, setChecked] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy4, setBusy4] = useState('');
  const [err4, setErr4] = useState('');
  const [done, setDone] = useState(null);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const loadStamp = useCallback(() => {
    api.get(`/agreement/token/${token}/file/client-stamp`, { responseType: 'blob' })
      .then((r) => setStampUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(r.data); }))
      .catch(() => setStampUrl(''));
  }, [token]);
  const load = useCallback(() => {
    api.get(`/public/agreement/${token}`)
      .then((r) => { setView(r.data); if (r.data && r.data.hasStamp) loadStamp(); })
      .catch((e) => setFatal(e.response?.data?.error || 'This link could not be opened. Ask your TeamLink contact for a new one.'));
  }, [token, loadStamp]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!file) { setErr('Choose the picture of your company stamp first.'); return; }
    setBusy(true); setErr('');
    try {
      const b = new FormData();
      b.append('kind', 'client-stamp');
      b.append('file', file, file.name || 'stamp.png');
      const r = await api.post(`/agreement/token/${token}/client-seal`, b);
      setView(r.data); setFile(null); loadStamp();
    } catch (e) {
      setErr(e.response?.data?.error || 'The stamp could not be saved. Please try again.');
    } finally { setBusy(false); }
  };

  const pick = (f) => {
    setErr4(''); setChecked(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl('');
    if (f && !/\.pdf$/i.test(f.name)) { setSigned(null); setErr4('Choose the PDF you downloaded from DigiLocker after eSign.'); return; }
    setSigned(f || null);
  };
  const sendSigned = async (path) => {
    const b = new FormData();
    b.append('file', signed, signed.name || 'signed.pdf');
    return api.post(`/agreement/token/${token}/${path}`, b);
  };
  const check = async () => {
    if (!signed) { setErr4('Choose the signed PDF first.'); return; }
    setBusy4('check'); setErr4('');
    try {
      const r = await sendSigned('esigned/check');
      setChecked(r.data);
      setPreviewUrl(URL.createObjectURL(signed));
    } catch (e) {
      setErr4(e.response?.data?.error || 'The file could not be checked. Please try again.');
    } finally { setBusy4(''); }
  };
  const submit = async () => {
    setBusy4('submit'); setErr4('');
    try {
      const r = await sendSigned('esigned');
      setDone(r.data);
    } catch (e) {
      setErr4(e.response?.data?.error || 'The file could not be submitted. Please try again.');
    } finally { setBusy4(''); }
  };
  const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  const header = <AgreementHeader />;
  if (fatal) return <div className="careers-shell">{header}<main className="agr-sign"><div className="agr-card agrs-stop"><h3>This link cannot be used</h3><p>{fatal}</p></div></main></div>;
  if (!view) return <div className="careers-shell">{header}<main className="agr-sign"><div className="small-muted">Loading the agreement…</div></main></div>;
  // out for signature (utils/agreementSigning.js OUT_FOR_SIGNATURE): the stamp can be put on / changed until the client has signed
  const open = ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(String(view.status || '').toUpperCase());
  if (done) {
    return (
      <div className="careers-shell">
        {header}
        <main className="agr-sign agrs-page">
          <div className="agr-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40, color: 'var(--green, #15803d)' }} aria-hidden="true">✓</div>
            <h2 style={{ marginTop: 4 }}>Thank you!</h2>
            <p>Your signed agreement {view.agreementId || ''} has reached TeamLink{done.signer ? `, eSigned by ${done.signer}` : ''}.</p>
            <p className="small-muted">{done.agreementStatus === 'ACTIVE'
              ? 'Both sides have signed: the agreement is active. A copy of both signed files comes to your email.'
              : 'TeamLink will complete its side and send you both signed copies by email.'}</p>
          </div>
        </main>
      </div>
    );
  }
  const has = !!view.hasStamp;

  return (
    <div className="careers-shell">
      {header}
      <main className="agr-sign agrs-page">
        <div className="agr-card">
          <h2 style={{ marginTop: 0 }}>Service agreement {view.agreementId || ''}</h2>
          <p className="small-muted" style={{ marginTop: 0 }}>{view.clientName} and TeamLink Consultants. Put your company stamp on it, then sign it with your Aadhaar eSign in DigiLocker.</p>
        </div>
        {!open ? (
          <div className="agr-card agrs-stop"><h3>This agreement is not open for signing</h3><p>It may already be signed. Ask your TeamLink contact if you need a copy.</p></div>
        ) : (
          <>
            <div className="agr-card">
              <h3 style={{ marginTop: 0 }}>1. Your company stamp {has && <span style={{ color: 'var(--green, #15803d)', fontSize: 14 }}>✓ added</span>}</h3>
              {has && stampUrl && <img src={stampUrl} alt="Your company stamp" style={{ maxWidth: 140, maxHeight: 140, display: 'block', marginBottom: 8 }} />}
              <StampPicker file={file} onFile={setFile} />
              <div className="agr-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                <button type="button" className="btn btn-primary" disabled={busy || !file} onClick={save}>{busy ? 'Saving…' : (has ? 'Replace the stamp' : 'Put this stamp on the agreement')}</button>
              </div>
              {err && <div className="error-text" role="alert">{err}</div>}
            </div>
            <div className="agr-card">
              <h3 style={{ marginTop: 0 }}>2. Download the agreement to eSign</h3>
              <p className="small-muted" style={{ marginTop: 0 }}>It comes with your stamp and TeamLink&apos;s stamp printed on every page.</p>
              {has
                ? <a className="btn btn-primary" href={`/api/agreement/token/${token}/esign-pdf`}>Download agreement PDF to eSign</a>
                : <button type="button" className="btn" disabled>Add your stamp first (step 1)</button>}
            </div>
            <div className="agr-card">
              <h3 style={{ marginTop: 0 }}>3. Sign it with Aadhaar eSign (DigiLocker, free)</h3>
              <ol style={{ paddingLeft: 20, lineHeight: 1.6, margin: '6px 0' }}>
                <li>Open <a href="https://www.digilocker.gov.in" target="_blank" rel="noreferrer">digilocker.gov.in</a> and sign in with your Aadhaar (linked to your mobile).</li>
                <li>Go to Drive, press Upload and choose the PDF you downloaded.</li>
                <li>On the uploaded file, press eSign and enter the Aadhaar OTP sent to your mobile.</li>
                <li>Download the signed PDF, as it is. Then hand it in below (step 4).</li>
              </ol>
              <p className="small-muted">Please do not edit, merge, print or compress the signed file: that removes the digital signature.</p>
            </div>
            <div className="agr-card">
              <h3 style={{ marginTop: 0 }}>4. Upload the signed PDF, preview and submit</h3>
              <input type="file" accept="application/pdf,.pdf" onChange={(e) => pick(e.target.files[0])} />
              <div className="agr-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                <button type="button" className={`btn${checked ? '' : ' btn-primary'}`} disabled={!signed || !!busy4} onClick={check}>{busy4 === 'check' ? 'Checking…' : 'Check & preview'}</button>
              </div>
              {checked && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ color: 'var(--green, #15803d)', fontWeight: 600 }}>✓ Valid Aadhaar eSign by {checked.signer}{checked.signedAt ? ` · ${when(checked.signedAt)}` : ''}</div>
                  {previewUrl && <iframe title="Signed agreement preview" src={previewUrl} style={{ width: '100%', height: 480, border: '1px solid #d6dbe4', borderRadius: 8, marginTop: 8 }} />}
                  <div className="agr-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                    <button type="button" className="btn btn-primary" disabled={!!busy4} onClick={submit}>{busy4 === 'submit' ? 'Submitting…' : 'Submit signed agreement'}</button>
                  </div>
                </div>
              )}
              {err4 && <div className="error-text" role="alert">{err4}</div>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
