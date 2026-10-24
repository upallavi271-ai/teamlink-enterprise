// ---------------------------------------------------------------------------
// "SIGNED AGREEMENT ON DRIVE" — the card on a client's Agreement tab (2026-10-12).
// The Google Drive link of the client's signed agreement: open it, add or replace it, tick "signed copy on file"
// (Admin / BDE team lead), take it away (Admin). It does NOT change the e-sign agreement above it.
// GET /clients/:id/agreement-links decides who sees what (the server also checks every button).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import AgreementLinksDialog from './AgreementLinksDialog.jsx';
import './agreementDriveLinks.css';

const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function AgreementDriveCard({ clientId, clientName }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get(`/clients/${clientId}/agreement-links`).then((r) => setData(r.data)).catch(() => setData(null));
  }, [clientId]);
  useEffect(load, [load]);
  if (!data || (!data.canSee && !data.canAdd)) return null;
  const cur = data.current;

  async function tick(value) {
    setErr(''); setMsg('');
    try { await api.patch(`/clients/${clientId}/agreement-links/${cur.id}`, { signedCopy: value }); setMsg(value ? 'Marked as signed copy on file.' : 'Mark removed.'); load(); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); }
  }
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Remove this Drive link? It stays in the history.')) return;
    setErr(''); setMsg('');
    try { await api.delete(`/clients/${clientId}/agreement-links/${cur.id}`, { data: { reason: 'Removed from the agreement screen' } }); setMsg('Removed. It stays in the history.'); load(); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); }
  }

  return (
    <div className="card section agr6-card adl-card">
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>
        {'Signed agreement on Drive '}
        {cur && <span className={`adl-chip ${cur.signedCopy ? 'green' : 'blue'}`}>{cur.signedCopy ? 'Signed copy on file' : 'Agreement on Drive'}</span>}
      </h3>
      {data.canSee ? (
        cur ? (
          <>
            <div className="adl-linkrow">
              <a className="btn btn-sm btn-primary" href={cur.url} target="_blank" rel="noopener noreferrer">Signed agreement: open in Drive ↗</a>
              {data.canMarkSigned && (
                <button type="button" className="btn btn-sm" onClick={() => tick(!cur.signedCopy)}>{cur.signedCopy ? 'Remove “signed copy” mark' : 'Mark as signed copy on file'}</button>
              )}
              {data.canAdd && <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Replace the Drive link</button>}
              {data.canRemove && <button type="button" className="btn btn-sm btn-ghost" onClick={remove}>Remove</button>}
            </div>
            <div className="small-muted" style={{ fontSize: 12 }}>
              {[cur.agreementDate && `Agreement date ${day(cur.agreementDate)}`, cur.endDate && `ends ${day(cur.endDate)}`, `added by ${cur.addedByName || 'someone'} on ${day(cur.addedAt)}`, cur.signedCopy && cur.signedCopyByName && `marked by ${cur.signedCopyByName}`].filter(Boolean).join(' · ')}
            </div>
            {cur.note && <div className="small-muted" style={{ fontSize: 12 }}>{cur.note}</div>}
          </>
        ) : (
          <div className="small-muted">
            {'No Drive link yet. '}
            {data.canAdd && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 6 }} onClick={() => setOpen(true)}>Add the Drive link</button>}
          </div>
        )
      ) : (
        <div className="small-muted">{data.why || 'Only this client’s BDE can see the link.'}</div>
      )}
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>This only keeps the link. It does not change the agreement above (its step, number or signatures).</div>
      {data.history && data.history.length > 0 && (
        <details className="adl-hist">
          <summary>{`Earlier links (${data.history.length})`}</summary>
          <ul>
            {data.history.map((h) => (
              <li key={h.id}>
                {h.url ? <a href={h.url} target="_blank" rel="noopener noreferrer">{h.label}</a> : h.label}
                {` · ${h.state.toLowerCase()}${h.endedAt ? ` ${day(h.endedAt)}` : ''}${h.endedByName ? ` by ${h.endedByName}` : ''} · added ${day(h.addedAt)}${h.addedByName ? ` by ${h.addedByName}` : ''}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {msg && <div className="small-muted" role="status">{msg}</div>}
      {err && <div className="cf-err" role="alert">{err}</div>}
      {open && <AgreementLinksDialog client={{ id: clientId, name: clientName }} onClose={() => setOpen(false)} onDone={load} />}
    </div>
  );
}
