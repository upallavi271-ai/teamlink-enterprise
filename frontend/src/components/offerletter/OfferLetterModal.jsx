import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { openLetter } from '../clientTrack/ClientTrack.jsx';
import './offerLetter.css';

// ---------------------------------------------------------------------------
// OFFER LETTER - one joining (Joining screen -> "Offer letter"): was it mailed, when and by whom (or why not), the letter exactly as
// the candidate reads it, the PDF, and Send / Send again for a person. (backend: routes/offerLetterMailRoutes.js)
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const errText = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const dateWord = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

// The sentence the Joining screen adds after "Joining date saved" (the answer of POST /joining/:id/schedule).
export function offerLetterNote(ol) {
  if (!ol) return '';
  if (ol.state === 'SENT') return ' The offer letter was emailed to the candidate.';
  if (ol.state === 'FAILED') return ` The offer letter was NOT sent: ${String(ol.message || '').replace(/^The offer letter was not sent:\s*/i, '')}`;
  if (ol.state === 'SKIPPED') return ` The offer letter is on hold: ${ol.message}`;
  return '';
}

export default function OfferLetterModal({ r, canSend, onClose, onChanged }) {
  const [card, setCard] = useState(null);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const c = await api.get(`/ats/offer-letter-mail/${r.id}`);
      setCard(c.data); setErr('');
      // the letter itself (salary, address) is only for logins that may see candidate contact and salary
      if (c.data.maySeeLetter !== false) { const p = await api.get(`/ats/offer-letter-mail/${r.id}/preview`); setPv(p.data); }
    } catch (e) { setErr(errText(e, 'Could not load the offer letter.')); }
  }, [r.id]);
  useEffect(() => { load(); }, [load]);

  async function send(again) {
    setBusy(true); setMsg(''); setErr('');
    try {
      const res = await api.post(`/ats/offer-letter-mail/${r.id}/send`, { again });
      setMsg(res.data.message || 'Done.');
      if (res.data.card) setCard(res.data.card);
      if (onChanged) onChanged();
    } catch (e) {
      setErr(errText(e, 'The offer letter was not sent.'));
      load();
    } finally { setBusy(false); }
  }

  const st = card && card.state;
  const chip = !card ? null : (() => {
    if (!card.applicable) return ['Not for this joining', ''];
    if (st === 'SENT') return ['Sent', 'ok'];
    if (st === 'FAILED') return ['Could not be sent', 'bad'];
    if (st === 'SKIPPED') return ['On hold', 'wait'];
    if (st === 'SENDING') return ['Sending…', 'wait'];
    return ['Not sent yet', 'wait'];
  })();

  return (
    <Modal
      title={`Offer letter — ${r.candidate.name}`}
      onClose={onClose}
      wide
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          {card && card.applicable && canSend && card.maySend && (
            <button type="button" className="btn btn-primary" disabled={busy || !card.canSend} title={card.cannotSendWhy || ''} onClick={() => send(st === 'SENT')}>
              {busy ? 'Sending…' : (st === 'SENT' ? 'Send again' : 'Send offer letter')}
            </button>
          )}
        </>
      )}
    >
      {!card && !err && <div className="small-muted">Loading…</div>}
      {err && <div className="error-text">{err}</div>}
      {msg && <div className="notice">{msg}</div>}
      {card && (
        <>
          <div className="olc-state">
            <span className={`olc-chip ${chip[1]}`}>{chip[0]}</span>
            {st === 'SENT' && <span className="small-muted">{when(card.sentAt)}{card.sentByName ? ` · ${card.wasAutomatic ? 'automatically' : `by ${card.sentByName}`}` : ''}{card.sendCount > 1 ? ` · sent ${card.sendCount} times` : ''}{card.to ? ` · to ${card.to}` : ''}</span>}
            {st !== 'SENT' && card.applicable && <span className="small-muted">{card.to ? `Goes to ${card.to}` : 'No email address on the record'}</span>}
          </div>
          {!card.applicable && <div className="olc-why">{card.notApplicableWhy}</div>}
          {card.applicable && st === 'FAILED' && <div className="olc-why error-text">Not sent: {card.reason}</div>}
          {card.applicable && st === 'SKIPPED' && <div className="olc-why">{card.reason}</div>}
          {card.applicable && card.joiningDateChangedSinceSent && (
            <div className="notice amber">The joining date was changed to {dateWord(card.joiningDate)} after this letter was sent (it said {dateWord(card.sentForJoiningDate)}). Nothing was mailed again by itself. Press <b>Send again</b> if the candidate needs the new letter.</div>
          )}
          {card.applicable && st !== 'SENT' && !card.cannotSendWhy && (
            <div className="small-muted" style={{ marginBottom: 6 }}>
              {card.automatic.enabled
                ? (card.automatic.masterOn ? 'Automatic sending is ON: it goes when the joining date is set or a joining message is sent.' : 'Automatic sending is ON, but the master switch “Candidate emails” is OFF, so it is held until a person presses Send.')
                : 'Automatic sending is OFF (Administration → Company Setup → Message templates → Offer letter). A person presses Send.'}
            </div>
          )}
          {card.applicable && card.cannotSendWhy && <div className="olc-why">{card.cannotSendWhy}</div>}
          {card.applicable && card.maySeeLetter === false && <div className="small-muted" style={{ marginBottom: 6 }}>The letter carries the salary and contact details, which your login does not see. You can see whether it was sent{card.maySend ? ' and press Send' : ''}.</div>}
          {card.applicable && card.maySeeLetter !== false && (
            <div className="olc-actions">
              <button type="button" className="btn btn-sm" onClick={() => openLetter(`/ats/offer-letter-mail/${r.id}/pdf`).catch(() => setErr('The PDF could not be opened.'))}>Open the PDF</button>
            </div>
          )}
          {pv && pv.omitted && pv.omitted.length > 0 && <div className="small-muted" style={{ marginBottom: 6 }}>Left out of the letter for lack of details: {pv.omitted.join('; ')}.</div>}
          {pv && <iframe className="olc-frame" title="Offer letter" sandbox="" srcDoc={pv.html} />}
        </>
      )}
    </Modal>
  );
}
