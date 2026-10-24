// CLIENT PORTAL: offers and joining letters (2026-10-13). The client releases its own letters, sees when
// the candidate accepted / confirmed, acknowledges, and confirms joining. Buttons show only with the OFFERS tick.
import { useState } from 'react';
import api from '../../api';
import { Chip, fmtDate } from './portalUi.jsx';
import { ReleaseLetterModal, openLetter } from '../../components/clientTrack/ClientTrack.jsx';

export default function ClientOffers({ offers, onChanged }) {
  const [dlg, setDlg] = useState(null); // { kind, o }
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  if (!offers || !offers.length) return null;
  const act = async (url, o, msg) => {
    setBusy(o.applicationId + url); setErr('');
    try { await api.post(url); onChanged(msg); } catch (e) { setErr(e.response?.data?.error || 'That could not be saved.'); } finally { setBusy(''); }
  };
  return (
    <div className="ctk-offers">
      {err && <div className="notice red"><span>{err}</span></div>}
      {offers.map((o) => {
        const accepted = o.statusCode === 'OFFER_ACCEPTED';
        return (
          <div className="ctk-card" key={o.applicationId}>
            <div className="ctk-card-head">
              <div><b>{o.candidate}</b><div className="ctk-meta">{o.requirement || ''}</div></div>
              <Chip label={o.status} tone={o.tone} />
            </div>
            {o.offer && o.offer.answeredAt && o.offer.state === 'DECLINED' && (
              <div className="ctk-notice red">{`${o.candidate} declined your offer on ${fmtDate(o.offer.answeredAt)}${o.offer.declineReason ? `: ${o.offer.declineReason}` : ''}.`}</div>
            )}
            {o.offer && ['ACCEPTED', 'ACKNOWLEDGED'].includes(o.offer.state) && o.offer.answeredAt && (
              <div className="ctk-notice">{`${o.candidate} accepted your offer on ${fmtDate(o.offer.answeredAt)}.`}</div>
            )}
            {o.joining && o.joining.confirmedAt && (
              <div className="ctk-notice">{`${o.candidate} confirmed joining${o.joiningDate ? ` on ${fmtDate(o.joiningDate)}` : ''} (${fmtDate(o.joining.confirmedAt)}).`}</div>
            )}
            {o.joinedAt && <div className="ctk-notice">{`${o.candidate} joined on ${fmtDate(o.joinedAt)}.`}</div>}
            <div className="ctk-meta">
              {o.offer && o.offer.releasedAt ? `Your offer letter: released ${fmtDate(o.offer.releasedAt)}` : ''}
              {o.joining && o.joining.releasedAt ? ` · Your joining letter: released ${fmtDate(o.joining.releasedAt)}` : ''}
              {o.joiningDate ? ` · Joining date ${fmtDate(o.joiningDate)}` : ''}
            </div>
            <div className="ctk-actions">
              {o.canReleaseOffer && <button type="button" className="btn btn-primary" onClick={() => setDlg({ kind: 'offer', o })}>{o.offer && o.offer.releasedAt ? 'Release a new offer letter' : 'Release offer letter'}</button>}
              {o.canAcknowledge && (
                <button type="button" className="btn btn-primary" disabled={busy === o.applicationId + 'ack'} onClick={() => act(`/portal/client/offers/${o.applicationId}/acknowledge`, { applicationId: o.applicationId + 'ack' }, 'Thank you. You can now send the joining letter.')}>I have seen it — confirm</button>
              )}
              {o.canReleaseJoining && <button type="button" className={`btn${accepted || o.statusCode === 'CLIENT_ACKNOWLEDGED' ? ' btn-primary' : ''}`} onClick={() => setDlg({ kind: 'joining', o })}>{o.joining && o.joining.releasedAt ? 'Release a new joining letter' : 'Release joining letter'}</button>}
              {o.canMarkJoined && (
                <button type="button" className="btn" disabled={busy === o.applicationId + 'joined'} onClick={() => act(`/portal/client/joining/${o.applicationId}/joined`, { applicationId: o.applicationId + 'joined' }, 'Saved. The candidate is marked as joined.')}>Candidate joined</button>
              )}
              {o.offer && o.offer.file && <button type="button" className="btn btn-sm btn-ghost" onClick={() => openLetter(`/portal/client/letters/${o.applicationId}/offer`)}>Open my offer letter</button>}
              {o.joining && o.joining.file && <button type="button" className="btn btn-sm btn-ghost" onClick={() => openLetter(`/portal/client/letters/${o.applicationId}/joining`)}>Open my joining letter</button>}
            </div>
          </div>
        );
      })}
      {dlg && (
        <ReleaseLetterModal
          kind={dlg.kind}
          endpoint={`/portal/client/${dlg.kind === 'offer' ? 'offers' : 'joining'}/${dlg.o.applicationId}/release`}
          candidateName={dlg.o.candidate}
          showCtc
          onClose={() => setDlg(null)}
          onDone={(r) => { setDlg(null); onChanged(r.message); }}
        />
      )}
    </div>
  );
}
