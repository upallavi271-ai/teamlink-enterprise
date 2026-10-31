// ---------------------------------------------------------------------------
// THE CLIENT PUTS THEIR COMPANY STAMP ON THE AGREEMENT (founder 2026-10-31: "client ey stamp veyyali"). No login: the link in the
// "Send to client" email (/agreement/<token>/stamp) is the key.
//   1. upload a photo / scan of the company stamp       POST /api/agreement/token/:token/client-seal (kind client-stamp)
//   2. download the agreement to eSign, both stamps on   GET  /api/agreement/token/:token/esign-pdf
//   3. eSign it with Aadhaar in DigiLocker, reply to the email with the signed PDF
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

  const header = <AgreementHeader />;
  if (fatal) return <div className="careers-shell">{header}<main className="agr-sign"><div className="agr-card agrs-stop"><h3>This link cannot be used</h3><p>{fatal}</p></div></main></div>;
  if (!view) return <div className="careers-shell">{header}<main className="agr-sign"><div className="small-muted">Loading the agreement…</div></main></div>;
  // out for signature (utils/agreementSigning.js OUT_FOR_SIGNATURE): the stamp can be put on / changed until the client has signed
  const open = ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(String(view.status || '').toUpperCase());
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
              <ol className="agr-steps">
                <li>Open <a href="https://www.digilocker.gov.in" target="_blank" rel="noreferrer">digilocker.gov.in</a> and sign in with your Aadhaar (linked to your mobile).</li>
                <li>Go to Drive, press Upload and choose the PDF you downloaded.</li>
                <li>On the uploaded file, press eSign and enter the Aadhaar OTP sent to your mobile.</li>
                <li>Download the signed PDF and reply to our email with that file attached, as it is.</li>
              </ol>
              <p className="small-muted">Please do not edit, merge, print or compress the signed file: that removes the digital signature.</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
