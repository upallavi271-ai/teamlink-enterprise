// ---------------------------------------------------------------------------
// REJECTION HISTORY — the candidate profile block (spec 2026-10-03 §A1).
// Self-contained: <RejectionHistory candidateId onChanged />. Renders
// nothing for a person who was never rejected.
//
//   * one entry per rejected application: job (client), who (Client / Our
//     team + person / Candidate), reason, note, what the client said, date
//   * "Do not use": red when approved (blocked from every job), orange while
//     the TL has not decided; the TL / Super Admin / Admin get Approve and
//     Decline here; a Super Admin / Admin can lift an approved block
//
// Data: GET /api/rejections/candidate/:id (scoped on the server — a reject on
// another team's job is counted, not described). Clients appear by NAME only.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { shortDate } from './rejectionUi.jsx';
import StillFits, { forgetStillFits } from './StillFits.jsx';
import './Rejections.css';

export default function RejectionHistory({ candidateId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});
  const [lift, setLift] = useState(null); // reason text while lifting

  const load = useCallback(() => {
    if (!candidateId) return;
    api.get(`/rejections/candidate/${candidateId}`)
      .then((r) => { setData(r.data); setError(''); })
      .catch((err) => {
        setData(null);
        // Not internal / not in this login's area: say nothing at all.
        if (err.response && [403, 404].includes(err.response.status)) setError('');
        else setError(err.response?.data?.error || 'Could not load the rejections. Please try again.');
      });
  }, [candidateId]);
  useEffect(() => { load(); }, [load]);

  async function decide(stepId, decision) {
    setBusy(stepId);
    setError('');
    try {
      await api.post(`/rejections/do-not-use/${stepId}/decide`, { decision, note: notes[stepId] || '' });
      setSaid(decision === 'approve' ? 'Approved. This person is now blocked from every job.' : 'Declined. The reject stays for that one job only.');
      forgetStillFits(candidateId);
      load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save. Please try again.');
    } finally {
      setBusy('');
    }
  }
  async function liftBlock() {
    setBusy('lift');
    setError('');
    try {
      await api.post(`/rejections/do-not-use/candidate/${candidateId}/lift`, { reason: lift });
      setLift(null);
      setSaid('Block lifted. This person can be added to jobs again.');
      load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not lift the block. Please try again.');
    } finally {
      setBusy('');
    }
  }

  if (!data) return error ? <div className="error-text">{error}</div> : null;
  const { history = [], requests = [], doNotUse, total = 0, hiddenCount = 0 } = data;
  if (!total && !doNotUse && !requests.length) return null;

  return (
    <div className="card section rjx-hist">
      <h3>{`Rejection history · ${total === 1 ? 'rejected once' : `rejected ${total} times`}`}</h3>

      {doNotUse === 'approved' && (
        <div className="rjx-warn">
          <b>Do not use.</b> The TL approved this. This person is blocked from every job and cannot be added or moved forward.
          {data.canLift && lift === null && (
            <div className="rjx-row"><button type="button" className="btn btn-sm" onClick={() => setLift('')}>Lift the block</button></div>
          )}
          {data.canLift && lift !== null && (
            <div className="rjx-row" style={{ marginTop: 8 }}>
              <input style={{ flex: 1, minWidth: 180 }} value={lift} onChange={(e) => setLift(e.target.value)} placeholder="Why is the block being lifted?" />
              <button type="button" className="btn btn-sm btn-primary" disabled={!lift.trim() || busy === 'lift'} onClick={liftBlock}>Lift block</button>
              <button type="button" className="btn btn-sm" onClick={() => setLift(null)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {doNotUse === 'pending' && (
        <div className="rjx-wait"><b>Do not use — waiting for the TL.</b> Until the TL approves, this person can still be used on other jobs.</div>
      )}

      {requests.filter((q) => q.canDecide).map((q) => (
        <div key={q.stepId} className="rjx-req">
          <div>
            <b>{`${q.requestedBy || 'Someone'} asked to mark this person "Do not use"`}</b>
            {` — ${q.reason || 'no reason'}${q.detail ? `: ${q.detail}` : ''}`}
          </div>
          <div className="small-muted">{`${q.requirementTitle || 'Job'}${q.clientName ? ` (${q.clientName})` : ''} · ${shortDate(q.at)}`}</div>
          <input
            value={notes[q.stepId] || ''}
            onChange={(e) => setNotes((n) => ({ ...n, [q.stepId]: e.target.value }))}
            placeholder="Note (optional)"
          />
          <div className="rjx-row" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy === q.stepId} onClick={() => decide(q.stepId, 'approve')}>Approve — block everywhere</button>
            <button type="button" className="btn btn-sm" disabled={busy === q.stepId} onClick={() => decide(q.stepId, 'decline')}>Decline</button>
          </div>
        </div>
      ))}

      {history.map((h) => (
        <div key={h.applicationId} className={`rjx-item${h.kind === 'do_not_use' ? ' is-dnu' : ''}`}>
          <div className="rjx-top">
            <Link to={`/requirements/${h.requirementId}`}>{h.requirementTitle || 'Job'}</Link>
            {h.clientName ? ` (${h.clientName})` : ''}
            {h.kind === 'do_not_use' && (
              <span className={`rjx-badge${h.dnu && h.dnu.status === 'Pending' ? ' is-wait' : ''}`}>
                {h.dnu && h.dnu.status === 'Approved' ? 'Do not use' : h.dnu && h.dnu.status === 'Pending' ? 'Do not use asked' : 'Do not use declined'}
              </span>
            )}
          </div>
          <div className="rjx-sub">
            {[`Rejected by ${h.byLabel || h.sideLabel || 'not recorded'}`, h.reason || 'Reason not recorded', h.at && shortDate(h.at), h.fromStage && `at ${h.fromStage}`].filter(Boolean).join(' · ')}
          </div>
          {h.detail && <div className="rjx-sub">{h.detail}</div>}
          {h.clientSaid && <div className="rjx-said">{`Client said: "${h.clientSaid}"`}</div>}
        </div>
      ))}
      {doNotUse !== 'approved' && (
        <div className="rjx-fits">
          <div className="section-label" style={{ margin: '10px 0 4px' }}>Still a good fit for</div>
          <StillFits candidateId={candidateId} full />
        </div>
      )}
      {hiddenCount > 0 && (
        <div className="small-muted">{`${hiddenCount} more rejection${hiddenCount === 1 ? '' : 's'} on other teams' jobs (not in your area, so not shown).`}</div>
      )}
      {said && <div className="rjx-ok" role="status">{said}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
