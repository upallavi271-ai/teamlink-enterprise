import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { REJECTION_REASONS_BY_SIDE } from '../../atsVocab';
import { DropDialog } from '../joindrop/JdParts.jsx';

// ---------------------------------------------------------------------------
// "Dropped" in the Move step list (founder 2026-10-29): the candidate dropped out. A reason AND a note are a must.
//   joined / hired     -> the Joining & Drop record's own drop window (POST /join-drop/:id/drop)
//   offer accepted     -> "did not join" (POST /ats/joining/:id/not-joined), the row stays under "Did not join"
//   any earlier step   -> rejected as the CANDIDATE's decision for this requirement (the stage PATCH)
// ---------------------------------------------------------------------------
export const DROP = '__DROP';

export function dropKind(app) {
  if (!app) return null;
  if (['JOINED', 'HIRED'].includes(app.stage)) return 'joined';
  if (app.stage === 'OFFER_ACCEPTED') return app.joiningStatus === 'Dropped' ? null : 'offer';
  if (app.stage === 'REJECTED') return null;
  return 'reject';
}

const REASONS = REJECTION_REASONS_BY_SIDE.Candidate;

export default function DropCandidate({
  app, move, onClose, onDone,
}) {
  const kind = dropKind(app);
  const [reason, setReason] = useState(kind === 'offer' ? 'Did Not Join' : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [joined, setJoined] = useState(null);

  useEffect(() => {
    if (kind !== 'joined') return;
    Promise.all([api.get(`/join-drop/application/${app.id}`), api.get('/join-drop/meta')])
      .then(([r, m]) => {
        const rec = r.data.record;
        if (!rec) setErr('The joining is not recorded yet, so a drop cannot be saved.');
        else if (rec.status === 'Dropped') setErr('This candidate is already marked as dropped.');
        else setJoined({ rec, meta: m.data });
      })
      .catch((e) => setErr(e.response?.data?.error || 'Could not open the drop window.'));
  }, [kind, app.id]);

  if (kind === 'joined') {
    if (joined) {
      return (
        <DropDialog
          rec={joined.rec}
          meta={joined.meta}
          endpoint={`/join-drop/${joined.rec.id}/drop`}
          onClose={onClose}
          onDone={(r) => onDone(r.message || 'Saved. The drop is recorded.')}
        />
      );
    }
    return err ? (
      <div className="cdw-card cdw-decision" style={{ marginTop: 8 }}>
        <div className="form-error">{err}</div>
        <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={onClose}>Close</button>
      </div>
    ) : null;
  }

  const ready = reason && note.trim().length >= 3;
  async function save() {
    setBusy(true);
    setErr('');
    try {
      if (kind === 'offer') {
        await api.post(`/ats/joining/${app.id}/not-joined`, { reason: `${reason} — ${note.trim()}` });
        onDone('Saved. Marked as dropped (did not join).');
      } else {
        await move('REJECTED', {
          rejectedBy: 'Candidate', rejectKind: 'not_suitable', reasonCategory: reason, reasonDetail: note.trim(), comment: 'Candidate dropped out',
        });
      }
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save the drop. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cdw-card cdw-decision" style={{ marginTop: 8 }}>
      <div className="cdw-label">Dropped — why did the candidate drop?</div>
      <Combo value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="">Reason…</option>
        {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </Combo>
      <textarea
        rows="3"
        maxLength={1000}
        style={{ marginTop: 6, width: '100%' }}
        placeholder="What happened? e.g. Took another job, family reasons, not picking calls"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {err && <div className="form-error">{err}</div>}
      <div className="cdw-row" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy || !ready} onClick={save}>Save as dropped</button>
      </div>
      <div className="small-muted" style={{ marginTop: 4 }}>
        {kind === 'offer' ? 'It stays under "Did not join" on the Joining screen.' : 'Saved as the candidate\'s decision for this requirement. Nothing is deleted.'}
      </div>
    </div>
  );
}
