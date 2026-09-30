// ---------------------------------------------------------------------------
// THE EXECUTION PANEL — one client's agreement as the server sees it:
//
//   · where it is (Sent → Viewed → Signed → Countersigned → Active)
//   · the last send, per channel: Sent / Not configured / Skipped / Failed
//   · both signatures and stamps, how each was made, the OTP destination
//   · TeamLink's countersign (Super Admin / Admin only — the server refuses
//     anyone else), edit dates, void
//   · the signed PDF, and the full audit trail
//
// Used on the client's Agreement tab and on /agreements/:clientId (the view
// for the client's own login, the BDE and Accounts). What a viewer may do
// comes from the server's `access` — nothing is decided here.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import SignatureCapture from './SignatureCapture.jsx';
import './agreements.css';

const LABEL = {
  DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', CLIENT_CONFIRMATION_PENDING: 'Confirmation pending',
  SIGNED: 'Signed', ACTIVE: 'Active', EXPIRED: 'Expired', REJECTED: 'Rejected',
};
function when(d) {
  return d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
function chipClass(outcome) {
  if (outcome === 'Sent') return 'agr-chip ok';
  if (outcome === 'Failed') return 'agr-chip bad';
  return 'agr-chip warn';
}
// "Email: Skipped · SMS: Sent · WhatsApp: Not configured" -> [[ch, outcome]]
function parseSend(detail) {
  const first = String(detail || '').split(' · ').filter((p) => /^(Email|SMS|WhatsApp): /.test(p));
  return first.map((p) => p.split(': '));
}

function AuthImage({ clientId, kind, alt }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    let live = true;
    api.get(`/agreement/${clientId}/file/${kind}`, { responseType: 'blob' })
      .then((r) => { if (!live) return; url = URL.createObjectURL(r.data); setSrc(url); })
      .catch(() => setSrc(''));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [clientId, kind]);
  return src ? <img src={src} alt={alt} /> : null;
}

export async function downloadAgreementPdf(clientId, name) {
  const r = await api.get(`/agreement/${clientId}/pdf`, { responseType: 'blob', params: { download: 1 } });
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name || 'agreement'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function AgreementPanel({ clientId, refreshKey, showDocument = false, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [countersign, setCountersign] = useState(false);
  const [signer, setSigner] = useState('');
  const [sig, setSig] = useState({ method: 'typed', blob: null });
  const [stamp, setStamp] = useState(null);
  const [dates, setDates] = useState(null);

  const load = useCallback(() => {
    api.get(`/agreement/${clientId}`)
      .then((r) => { setData(r.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'The agreement could not be loaded.'));
  }, [clientId]);
  useEffect(load, [load, refreshKey]);

  if (error) return <div className="notice red">{error}</div>;
  if (!data) return <div className="small-muted">Loading the agreement…</div>;
  const s = data.summary;
  const edit = !!data.access.edit;
  const canCountersign = edit && data.document && !['ACTIVE', 'EXPIRED', 'REJECTED'].includes(s.status);
  const sendRows = data.lastSend ? parseSend(data.lastSend.detail) : [];
  const title = (data.client.name || 'agreement').replace(/[^\w.-]+/g, '-');

  async function run(key, fn, ok) {
    setBusy(key); setError(''); setNote('');
    try {
      const r = await fn();
      if (ok) setNote(typeof ok === 'function' ? ok(r) : ok);
      load();
      if (onChanged) onChanged();
    } catch (err) {
      setNote('');
      setError(err.response?.data?.error || 'That did not work.');
    } finally { setBusy(''); }
  }

  async function submitCountersign() {
    if (!sig.blob) { setError('Add the signature first.'); return; }
    await run('seal', async () => {
      const f = new FormData();
      f.append('kind', 'company-sign');
      f.append('method', sig.method);
      f.append('signedBy', signer.trim());
      f.append('file', sig.blob, sig.blob.name || 'signature.png');
      const r = await api.post(`/agreement/${clientId}/company-seal`, f);
      if (stamp) {
        const g = new FormData();
        g.append('kind', 'company-stamp');
        g.append('file', stamp, stamp.name || 'stamp.png');
        return api.post(`/agreement/${clientId}/company-seal`, g).then((r2) => ({ data: { ...r2.data, autoActivated: r.data.autoActivated || r2.data.autoActivated } }));
      }
      return r;
    }, (r) => (r.data.autoActivated ? 'Countersigned — the client had already signed, so the agreement is now Active.' : 'Countersigned. It becomes Active automatically when the client signs with their OTP.'));
    setCountersign(false);
  }

  return (
    <div className="agr-panel">
      {note && <div className="notice" role="status" style={{ marginBottom: 8 }}>{note}</div>}

      <div className="card section">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <h3 style={{ fontSize: 13 }}>
            Execution — {data.client.name} {s.agreementId ? `· ${s.agreementId}` : ''}
          </h3>
          <span className={`status ${s.status === 'ACTIVE' ? 'active' : (['EXPIRED', 'REJECTED'].includes(s.status) ? 'rejected' : 'pending')}`}>{LABEL[s.status] || s.status}</span>
        </div>
        {s.awaitingCountersign && (
          <div className="notice amber" style={{ marginTop: 8 }}>
            Signed by the client{s.signedAt ? ` on ${when(s.signedAt)}` : ''} — waiting for TeamLink&apos;s countersign.
            {edit ? ' Countersign below and it becomes Active automatically.' : ' A Super Admin or Admin countersigns it.'}
          </div>
        )}
        {s.linkExpired && <div className="notice red" style={{ marginTop: 8 }}>The signing link expired on {when(s.linkExpiresAt)} without a signature. Resend the agreement to issue a new link.</div>}

        {sendRows.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="small-muted" style={{ marginBottom: 4 }}>
              {data.lastSend.event.startsWith('Agreement signing reminder') ? data.lastSend.event : 'Last sent'} · {when(data.lastSend.at)}
              {s.linkExpiresAt && !s.linkExpired && ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(s.status) ? ` · link valid until ${when(s.linkExpiresAt)}` : ''}
            </div>
            <div className="agr-channels">
              {sendRows.map(([ch, outcome]) => <span key={ch} className={chipClass(outcome)}>{ch}: {outcome}</span>)}
            </div>
            {data.lastSend.detail && data.lastSend.detail.includes(' — ') && (
              <div className="small-muted" style={{ marginTop: 4, fontSize: 11.5 }}>{data.lastSend.detail.split(' · ').filter((p) => p.includes(' — ')).join(' · ')}</div>
            )}
          </div>
        )}
        {data.signingPath && (
          <div className="small-muted" style={{ marginTop: 8, fontSize: 12 }}>
            Signing link: <a href={data.signingPath} target="_blank" rel="noreferrer">open</a>
            {' · '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard && navigator.clipboard.writeText(`${window.location.origin}${data.signingPath}`).then(() => setNote('Signing link copied.'))}>Copy link</button>
          </div>
        )}

        <div className="agr-sigs" style={{ marginTop: 12 }}>
          <div className="agr-sigbox">
            <b style={{ fontSize: 12.5 }}>Client</b>
            {s.clientSide.hasSignature ? <AuthImage clientId={clientId} kind="client-sign" alt="Client signature" /> : <div className="small-muted">Not signed yet</div>}
            {s.clientSide.hasStamp && <AuthImage clientId={clientId} kind="client-stamp" alt="Client stamp" />}
            <div className="small-muted" style={{ fontSize: 12 }}>
              {s.clientSide.signedBy ? `${s.clientSide.signedBy}${s.clientSide.signedByTitle ? `, ${s.clientSide.signedByTitle}` : ''}` : ''}
              {s.clientSide.signMethod ? ` · ${s.clientSide.signMethod}` : ''}
              {s.verification ? ` · OTP verified ${when(s.verification.verifiedAt)} (${s.verification.sentTo || 'registered contact'})` : ''}
            </div>
          </div>
          <div className="agr-sigbox">
            <b style={{ fontSize: 12.5 }}>TeamLink (countersign)</b>
            {s.company.hasSignature ? <AuthImage clientId={clientId} kind="company-sign" alt="TeamLink signature" /> : <div className="small-muted">Not countersigned yet</div>}
            {s.company.hasStamp && <AuthImage clientId={clientId} kind="company-stamp" alt="TeamLink stamp" />}
            <div className="small-muted" style={{ fontSize: 12 }}>
              {s.company.signedBy ? `${s.company.signedBy} · ${when(s.company.sealedAt)}` : ''}{s.company.signMethod ? ` · ${s.company.signMethod}` : ''}
            </div>
          </div>
        </div>

        <div className="agr-actions" style={{ justifyContent: 'flex-start' }}>
          {s.pdfAvailable && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'pdf'} onClick={() => run('pdf', () => downloadAgreementPdf(clientId, `${s.agreementId || 'agreement'}-${title}`))}>
              {busy === 'pdf' ? 'Preparing…' : 'Download signed PDF'}
            </button>
          )}
          {canCountersign && !countersign && (
            <button type="button" className="btn btn-sm" onClick={() => { setCountersign(true); setSigner(''); }}>
              {s.company.hasSignature ? 'Re-do TeamLink countersign' : 'Countersign for TeamLink'}
            </button>
          )}
          {edit && !dates && (
            <button type="button" className="btn btn-sm" onClick={() => setDates({ agreementStart: data.start || '', agreementEnd: data.end || '' })}>Edit dates</button>
          )}
          {edit && s.status !== 'DRAFT' && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                // eslint-disable-next-line no-alert
                const reason = window.prompt('Void this agreement? Both signatures are cleared and it goes back to Draft (requirements are held at Agreement Check again). Reason:');
                if (reason) run('void', () => api.post(`/agreement/${clientId}/void`, { reason }), 'Agreement voided — regenerate and send it again.');
              }}
            >
              Void…
            </button>
          )}
        </div>

        {countersign && (
          <div className="agr-card">
            <h3>TeamLink countersign</h3>
            <label className="field"><span>Signing for TeamLink (name) *</span>
              <input value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Authorised signatory" />
            </label>
            <SignatureCapture name={signer} onChange={setSig} />
            <label className="field" style={{ marginTop: 8 }}><span>Company stamp (optional)</span>
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => setStamp(e.target.files[0] || null)} />
            </label>
            <div className="agr-actions">
              <button type="button" className="btn" onClick={() => setCountersign(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy === 'seal' || signer.trim().length < 2 || !sig.blob} onClick={submitCountersign}>
                {busy === 'seal' ? 'Saving…' : 'Apply countersign'}
              </button>
            </div>
          </div>
        )}

        {dates && (
          <div className="agr-card">
            <h3>Agreement dates</h3>
            <div className="agr-fields">
              <label className="field"><span>Start</span><input type="date" value={dates.agreementStart} onChange={(e) => setDates({ ...dates, agreementStart: e.target.value })} /></label>
              <label className="field"><span>End (blank = renews every 12 months)</span><input type="date" value={dates.agreementEnd} onChange={(e) => setDates({ ...dates, agreementEnd: e.target.value })} /></label>
            </div>
            <div className="agr-actions">
              <button type="button" className="btn" onClick={() => setDates(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy === 'dates'} onClick={() => run('dates', () => api.patch(`/agreement/${clientId}`, dates), 'Dates saved.').then(() => setDates(null))}>Save</button>
            </div>
          </div>
        )}
      </div>

      {showDocument && data.document && (
        <div className="card section">
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>Agreement text</h3>
          <div className="agr-doc">{data.document}</div>
        </div>
      )}

      <div className="card section">
        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Audit trail</h3>
        {data.timeline.length === 0 ? <div className="small-muted">Nothing recorded yet.</div> : (
          <ul className="agr-timeline">
            {[...data.timeline].reverse().map((t, i) => (
              <li key={`${t.at}-${i}`}>
                <span className="when">{when(t.at)}</span>
                <span><b>{t.event}</b>{t.by ? ` · ${t.by}` : ''}{t.detail ? <div className="small-muted" style={{ fontSize: 11.5 }}>{t.detail}</div> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
