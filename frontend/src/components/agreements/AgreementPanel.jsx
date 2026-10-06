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
import { Link } from 'react-router-dom';
import api from '../../api';
import SignatureCapture from './SignatureCapture.jsx';
import AgreementDocView, { signersFrom } from './AgreementDocView.jsx';
import { AgreementStepChip } from '../clients/AgreementStep.jsx';
import './agreements.css';

// Plain words for the per-channel send result (the value itself is unchanged).
const OUTCOME_TEXT = { 'Not configured': 'not set up' };
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

// `bare` — drawn inside another card (Client 360 → Agreement → Show signing
// details): sections without their own card border (no nested cards).
export default function AgreementPanel({
  clientId, refreshKey, showDocument = false, onChanged, bare = false,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [countersign, setCountersign] = useState(false);
  // "Cancel agreement" dialog (was a browser prompt): null = closed.
  const [voidReason, setVoidReason] = useState(null);
  const box = bare ? 'section' : 'card section';
  const [signer, setSigner] = useState('');
  const [sig, setSig] = useState({ method: 'typed', blob: null });
  const [stamp, setStamp] = useState(null);
  const [dates, setDates] = useState(null);
  // Every kept signed PDF (older versions stay in history, 2026-10-05).
  const [versions, setVersions] = useState([]);

  const load = useCallback(() => {
    api.get(`/agreement/${clientId}`)
      .then((r) => { setData(r.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the agreement. Please try again.'));
  }, [clientId]);
  useEffect(load, [load, refreshKey]);
  useEffect(() => {
    api.get(`/agreement/${clientId}/versions`).then((r) => setVersions(r.data || [])).catch(() => setVersions([]));
  }, [clientId, refreshKey, data?.summary?.status]);

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
      setError(err.response?.data?.error || 'That did not work. Please try again.');
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
    }, (r) => (r.data.autoActivated ? 'Signed. The agreement is now Active.' : 'Signed. It goes Active when the client signs.'));
    setCountersign(false);
  }

  return (
    <div className="agr-panel">
      {note && <div className="notice" role="status" style={{ marginBottom: 8 }}>{note}</div>}

      <div className={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <h3 style={{ fontSize: 13 }}>
            Signing {s.agreementId ? `· ${s.agreementId}` : ''}
          </h3>
          <AgreementStepChip status={s.status} />
        </div>
        {s.awaitingCountersign && (
          <div className="notice amber" style={{ marginTop: 8 }}>
            {`Signed by the client${s.signedAt ? ` on ${when(s.signedAt)}` : ''}. Waiting for TeamLink to sign.`}
            {edit ? ' Sign below to make it Active.' : ' An Admin signs for TeamLink.'}
          </div>
        )}
        {s.linkExpired && <div className="notice red" style={{ marginTop: 8 }}>{`The signing link ended on ${when(s.linkExpiresAt)}. Make a new link.`}</div>}

        {sendRows.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="small-muted" style={{ marginBottom: 4 }}>
              {data.lastSend.event.startsWith('Agreement signing reminder') ? 'Reminder sent' : 'Last sent'} · {when(data.lastSend.at)}
              {s.linkExpiresAt && !s.linkExpired && ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(s.status) ? ` · link works until ${when(s.linkExpiresAt)}` : ''}
            </div>
            <div className="agr-channels">
              {sendRows.map(([ch, outcome]) => <span key={ch} className={chipClass(outcome)}>{ch}: {OUTCOME_TEXT[outcome] || outcome}</span>)}
            </div>
            {data.lastSend.detail && data.lastSend.detail.includes(' — ') && (
              <div className="small-muted" style={{ marginTop: 4, fontSize: 11.5 }}>Some messages did not go out.</div>
            )}
          </div>
        )}
        {/* Who may do what here, in one line (the server decides). */}
        <div className="small-muted" style={{ marginTop: 6, fontSize: 12 }}>
          {edit ? 'You can view and edit this agreement.' : 'You can view and download this agreement.'}
        </div>
        {edit && (
          <div className="agr-actions" style={{ justifyContent: 'flex-start' }}>
            <Link className="btn btn-sm" to={`/clients/${clientId}?tab=agreement`}>✏️ Edit terms / sign &amp; stamp for TeamLink</Link>
          </div>
        )}
        {data.signingPath && data.access?.as === 'client' && (
          <div className="agr-actions" style={{ justifyContent: 'flex-start' }}>
            <a className="btn btn-primary" href={data.signingPath}>Review, sign &amp; stamp →</a>
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
            {s.clientSide.hasSignature ? <AuthImage clientId={clientId} kind="client-sign" alt="Client signature" />
              : (s.clientSide.esign ? <div style={{ fontSize: 13 }}><b>Aadhaar eSign (eMudhra)</b><div className="small-muted">{`Transaction ${s.clientSide.esignTxnId || '—'} · the digitally signed PDF is under "Signed copies"`}</div></div> : <div className="small-muted">Not signed yet</div>)}
            {s.clientSide.hasStamp && <AuthImage clientId={clientId} kind="client-stamp" alt="Client stamp" />}
            <div className="small-muted" style={{ fontSize: 12 }}>
              {s.clientSide.signedBy ? `${s.clientSide.signedBy}${s.clientSide.signedByTitle ? `, ${s.clientSide.signedByTitle}` : ''}` : ''}
              {s.clientSide.signMethod ? ` · ${s.clientSide.signMethod}` : ''}
              {s.verification ? ` · code checked ${when(s.verification.verifiedAt)} (${s.verification.sentTo || 'registered contact'})` : ''}
            </div>
          </div>
          <div className="agr-sigbox">
            <b style={{ fontSize: 12.5 }}>TeamLink</b>
            {s.company.hasSignature ? <AuthImage clientId={clientId} kind="company-sign" alt="TeamLink signature" /> : <div className="small-muted">Not signed yet</div>}
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
          {edit && s.pdfAvailable && (
            <button type="button" className="btn btn-sm" disabled={busy === 'rebuild'} title="Makes a fresh signed PDF from the saved signatures and stamps. The older copy stays below." onClick={() => run('rebuild', () => api.post(`/agreement/${clientId}/pdf/rebuild`, {}), 'Done. A fresh signed PDF is kept; the older copy stays in the list below.').then(() => api.get(`/agreement/${clientId}/versions`).then((r) => setVersions(r.data || [])).catch(() => {}))}>
              {busy === 'rebuild' ? 'Making…' : 'Make the PDF again'}
            </button>
          )}
          {canCountersign && !countersign && (
            <button type="button" className="btn btn-sm" onClick={() => { setCountersign(true); setSigner(''); }}>
              {s.company.hasSignature ? 'Sign again for TeamLink' : 'Sign for TeamLink'}
            </button>
          )}
          {edit && !dates && (
            <button type="button" className="btn btn-sm" onClick={() => setDates({ agreementStart: data.start || '', agreementEnd: data.end || '' })}>Edit dates</button>
          )}
          {edit && s.status !== 'DRAFT' && voidReason === null && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setVoidReason('')}>
              Cancel agreement…
            </button>
          )}
        </div>

        {voidReason !== null && (
          <div className="agr-card">
            <h3>Cancel agreement</h3>
            <div className="small-muted" style={{ marginBottom: 6 }}>Both signatures are cleared. It goes back to Draft.</div>
            <label className="field"><span>Reason *</span>
              <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} autoFocus />
            </label>
            <div className="agr-actions">
              <button type="button" className="btn" onClick={() => setVoidReason(null)}>Keep it</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy === 'void' || !voidReason.trim()}
                onClick={() => run('void', () => api.post(`/agreement/${clientId}/void`, { reason: voidReason }), 'Cancelled. Make a new draft and send it.').then(() => setVoidReason(null))}
              >
                {busy === 'void' ? 'Saving…' : 'Cancel agreement'}
              </button>
            </div>
          </div>
        )}

        {countersign && (
          <div className="agr-card">
            <h3>Sign for TeamLink</h3>
            <label className="field"><span>Your name *</span>
              <input value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Authorised signatory" />
            </label>
            <SignatureCapture name={signer} onChange={setSig} />
            <label className="field" style={{ marginTop: 8 }}><span>Company stamp (optional)</span>
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => setStamp(e.target.files[0] || null)} />
            </label>
            <div className="agr-actions">
              <button type="button" className="btn" onClick={() => setCountersign(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy === 'seal' || signer.trim().length < 2 || !sig.blob} onClick={submitCountersign}>
                {busy === 'seal' ? 'Saving…' : 'Save signature'}
              </button>
            </div>
          </div>
        )}

        {dates && (
          <div className="agr-card">
            <h3>Agreement dates</h3>
            <div className="agr-fields">
              <label className="field"><span>Start</span><input type="date" value={dates.agreementStart} onChange={(e) => setDates({ ...dates, agreementStart: e.target.value })} /></label>
              <label className="field"><span>End date (empty = renews yearly)</span><input type="date" value={dates.agreementEnd} onChange={(e) => setDates({ ...dates, agreementEnd: e.target.value })} /></label>
            </div>
            <div className="agr-actions">
              <button type="button" className="btn" onClick={() => setDates(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy === 'dates'} onClick={() => run('dates', () => api.patch(`/agreement/${clientId}`, dates), 'Dates saved.').then(() => setDates(null))}>Save</button>
            </div>
          </div>
        )}
      </div>

      {showDocument && data.document && (
        <div className={box}>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>Agreement text</h3>
          <div className="agr-doc agr-doc-word">
            <AgreementDocView
              text={data.document}
              {...signersFrom({ ...s, signedAt: s.signedAt, teamlinkName: data.teamlinkName, teamlinkTitle: data.teamlinkTitle }, (kind) => <AuthImage clientId={clientId} kind={kind} alt={kind} />)}
            />
          </div>
        </div>
      )}

      {versions.length > 0 && (
        <div className={box}>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>Signed copies (kept)</h3>
          <ul className="agr-timeline">
            {versions.map((v) => (
              <li key={v.id}>
                <span className="when">{when(v.at)}</span>
                <span>
                  <b>{v.kind}</b>
                  {v.sha256 && <div className="small-muted" style={{ fontSize: 11 }}>{`PDF fingerprint (sha256): ${v.sha256.slice(0, 16)}…`}</div>}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={async () => {
                    const r = await api.get(`/agreement/${clientId}/pdf`, { responseType: 'blob', params: { copy: v.id } });
                    const url = URL.createObjectURL(r.data);
                    const a = document.createElement('a'); a.href = url; a.download = `${s.agreementId || 'agreement'}-signed-${String(v.at).slice(0, 10)}.pdf`;
                    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
                  }}>Download this copy</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={box}>
        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Signing history</h3>
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
