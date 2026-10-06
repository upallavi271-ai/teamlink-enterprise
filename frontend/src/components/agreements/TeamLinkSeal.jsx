// ---------------------------------------------------------------------------
// TEAMLINK'S SIGNATURE + COMPANY STAMP (2026-10-05) — Super Admin / Admin.
//
//   mode="settings"   saved once in Agreement settings; used by default on
//                     every agreement (when the link is made, or when the
//                     client signs if TeamLink has not signed yet)
//   mode="agreement"  this one agreement: "Use the saved signature & stamp",
//                     or sign + stamp here (before sending = pre-signed, or
//                     after the client signed = countersign)
//
// Server: routes/agreementSealExtra.js (settings, use-saved) and
// routes/agreementSeal.js company-seal. Both refuse anyone but SA / Admin.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import SignatureCapture from './SignatureCapture.jsx';
import './agreements.css';
import './agreementLink.css';

export function AuthImg({ path, alt, bust }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    let live = true;
    api.get(path, { responseType: 'blob' })
      .then((r) => { if (!live) return; url = URL.createObjectURL(r.data); setSrc(url); })
      .catch(() => setSrc(''));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path, bust]);
  return src ? <img className="tls-img" src={src} alt={alt} /> : <div className="tls-none">Not added yet</div>;
}

export function StampPicker({ onFile, file }) {
  const [preview, setPreview] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!file) { setPreview(''); return undefined; }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="tls-stamp">
      <input
        type="file"
        accept="image/png,image/jpeg"
        onChange={(e) => {
          const f = e.target.files[0] || null;
          setErr('');
          if (f && !/\.(png|jpe?g)$/i.test(f.name)) { setErr('Only a PNG or JPG picture of the stamp.'); return onFile(null); }
          if (f && f.size > 5 * 1024 * 1024) { setErr('That picture is over 5 MB. Please pick a smaller one.'); return onFile(null); }
          return onFile(f);
        }}
      />
      {preview && <img className="tls-img" src={preview} alt="Stamp preview" />}
      <div className="small-muted">A clear photo or scan of the company stamp / seal (PNG or JPG, up to 5 MB).</div>
      {err && <div className="cf-err" role="alert">{err}</div>}
    </div>
  );
}

// signerName / signerTitle: given by the Agreement settings dialog (its own Name
// and Designation fields), so the name is typed once.
export default function TeamLinkSeal({ mode = 'settings', clientId = null, onDone, signerName, signerTitle }) {
  const [saved, setSaved] = useState(null);
  const [current, setCurrent] = useState(null);
  const [ownSigner, setSigner] = useState('');
  const [ownTitle, setTitle] = useState('');
  const external = signerName !== undefined;
  const signer = external ? String(signerName || '') : ownSigner;
  const title = external ? String(signerTitle || '') : ownTitle;
  const [sig, setSig] = useState({ method: 'drawn', blob: null });
  const [stamp, setStamp] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [bust, setBust] = useState(0);

  const load = () => {
    if (mode === 'settings' || mode === 'agreement') {
      api.get('/agreement/settings/teamlink-seal').then((r) => {
        setSaved(r.data);
        if (mode === 'settings') { setSigner((v) => v || r.data.signedBy || ''); setTitle((v) => v || r.data.signedByTitle || ''); }
      }).catch(() => setSaved(null));
    }
    if (mode === 'agreement' && clientId) {
      api.get(`/agreement/${clientId}/executed`).then((r) => setCurrent(r.data)).catch(() => setCurrent(null));
    }
  };
  useEffect(load, [mode, clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(key, fn, ok) {
    setBusy(key); setError(''); setNote('');
    try {
      const r = await fn();
      setNote(typeof ok === 'function' ? ok(r) : ok);
      setBust((b) => b + 1);
      load();
      if (onDone) onDone(r);
    } catch (e) { setError(e.response?.data?.error || 'That did not work. Please try again.'); }
    setBusy('');
  }
  const saveSign = () => run('sign', () => {
    const f = new FormData();
    if (mode === 'settings') { f.append('kind', 'sign'); f.append('signedByTitle', title.trim()); } else f.append('kind', 'company-sign');
    f.append('method', sig.method);
    f.append('signedBy', signer.trim());
    f.append('file', sig.blob, sig.blob.name || 'signature.png');
    return api.post(mode === 'settings' ? '/agreement/settings/teamlink-seal' : `/agreement/${clientId}/company-seal`, f);
  }, (r) => (r.data.autoActivated ? 'Saved. Both sides have signed and stamped — the agreement is Active.' : 'Saved. TeamLink signature added.'));
  const saveStamp = () => run('stamp', () => {
    const f = new FormData();
    f.append('kind', mode === 'settings' ? 'stamp' : 'company-stamp');
    f.append('file', stamp, stamp.name || 'stamp.png');
    return api.post(mode === 'settings' ? '/agreement/settings/teamlink-seal' : `/agreement/${clientId}/company-seal`, f);
  }, (r) => (r.data.autoActivated ? 'Saved. Both sides have signed and stamped — the agreement is Active.' : 'Saved. TeamLink stamp added.'));
  const useSaved = () => run('saved', () => api.post(`/agreement/${clientId}/company-seal/use-saved`, {}),
    (r) => (r.data.autoActivated ? 'Done. Both sides have signed and stamped — the agreement is Active.' : 'Done. TeamLink\'s saved signature and stamp are on this agreement.'));

  const signPath = mode === 'settings' ? '/agreement/settings/teamlink-seal/file/sign' : `/agreement/${clientId}/file/company-sign`;
  const stampPath = mode === 'settings' ? '/agreement/settings/teamlink-seal/file/stamp' : `/agreement/${clientId}/file/company-stamp`;
  const has = mode === 'settings' ? saved : (current ? { hasSign: current.company?.hasSignature, hasStamp: current.company?.hasStamp } : null);

  return (
    <div className="tls">
      <div className="small-muted" style={{ marginBottom: 8 }}>
        {mode === 'settings'
          ? 'Add TeamLink\'s signature and company stamp once. They go on every new agreement by themselves.'
          : 'TeamLink\'s side of this agreement. Sign before sending, or after the client signs. The agreement becomes Active when both sides have a signature and a stamp.'}
      </div>
      {mode === 'settings' && saved && saved.emudhra && (
        <div className={`tls-saved${saved.emudhra.ready ? '' : ' tls-off'}`}>
          {saved.emudhra.ready
            ? <span>{`Aadhaar eSign (eMudhra) is ready (${saved.emudhra.environment}). Clients see it as a 4th way to sign.`}</span>
            : <span>Aadhaar eSign (eMudhra) is not set up. Add the eMudhra account in Administration → Integrations → "eMudhra eSign (Aadhaar)".</span>}
        </div>
      )}
      {note && <div className="notice" role="status">{note}</div>}
      {error && <div className="notice red" role="alert">{error}</div>}

      {mode === 'agreement' && saved && (saved.hasSign || saved.hasStamp) && !(has?.hasSign && has?.hasStamp) && (
        <div className="tls-saved">
          <span>A saved TeamLink signature{saved.hasStamp ? ' and stamp' : ''}{saved.signedBy ? ` (${saved.signedBy})` : ''} is ready.</span>
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={useSaved}>{busy === 'saved' ? 'Adding…' : 'Use the saved signature & stamp'}</button>
        </div>
      )}

      <div className="tls-grid">
        <div className="tls-box">
          <b>1. TeamLink signature</b>
          <div className="tls-now">Now: <AuthImg path={signPath} alt="TeamLink signature" bust={`${bust}-${has?.hasSign}`} /></div>
          {!external && <label className="field"><span>Signed by (name) *</span><input value={signer} placeholder="e.g. Vasu Chitturi" onChange={(e) => setSigner(e.target.value)} /></label>}
          {external && signer.trim().length < 2 && <div className="small-muted">Write the signer's name above first.</div>}
          {mode === 'settings' && !external && <label className="field"><span>Designation</span><input value={title} placeholder="e.g. Director" onChange={(e) => setTitle(e.target.value)} /></label>}
          <SignatureCapture name={signer} onChange={setSig} />
          <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} disabled={!!busy || !sig.blob || signer.trim().length < 2} onClick={saveSign}>
            {busy === 'sign' ? 'Saving…' : 'Use this signature'}
          </button>
        </div>
        <div className="tls-box">
          <b>2. TeamLink company stamp</b>
          <div className="tls-now">Now: <AuthImg path={stampPath} alt="TeamLink stamp" bust={`${bust}-${has?.hasStamp}`} /></div>
          <StampPicker file={stamp} onFile={setStamp} />
          <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} disabled={!!busy || !stamp} onClick={saveStamp}>
            {busy === 'stamp' ? 'Saving…' : 'Use this stamp'}
          </button>
        </div>
      </div>
    </div>
  );
}
