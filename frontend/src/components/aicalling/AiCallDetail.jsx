import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import {
  purposeLabel, statusWord, STATUS_CLASS, when, minutes, errorOf,
} from './aiCallingShared.js';

// One AI call in full: what happened, what the candidate said (answers), what is next. Cancel / Retry live here too.
export default function AiCallDetail({ id, onClose, onChanged }) {
  const [call, setCall] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get(`/ai-calling/calls/${id}`).then((r) => setCall(r.data.call)).catch((e) => setErr(errorOf(e, 'Could not open this call.')));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  async function act(path) {
    setErr('');
    try { await api.post(`/ai-calling/calls/${id}/${path}`); await load(); if (onChanged) onChanged(); } catch (e) { setErr(errorOf(e, 'That did not work.')); }
  }
  const waiting = call && (call.status === 'queued' || (['busy', 'no-answer', 'failed'].includes(call.status) && call.nextAttemptAt));
  const may = call && ['failed', 'busy', 'no-answer'].includes(call.status) && call.attempts < call.maxAttempts;
  const a = (call && call.answers) || {};
  return (
    <Modal title="AI call" size="wide" onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
      {err && <div className="error-text">{err}</div>}
      {!call && !err && <div className="small-muted">Loading…</div>}
      {call && (
        <div>
          <div style={{ marginBottom: 8 }}>
            <b>{call.candidateName}</b>
            <span className="small-muted">{` · ${call.jobTitle || ''} · ${purposeLabel(call.purpose)} · ${call.language || ''}`}</span>
            {call.mode === 'test' && <span className="status pending" style={{ marginLeft: 8 }}>Test call</span>}
          </div>
          <div className="row-actions" style={{ marginBottom: 8 }}>
            <span className={`status ${STATUS_CLASS[call.status] || 'new'}`}>{statusWord(call.status)}</span>
            {call.outcome && <b>{call.outcome}</b>}
            {call.durationSec != null && <span className="small-muted">{minutes(call.durationSec)}</span>}
            {waiting && <button className="btn btn-sm btn-danger" onClick={() => act('cancel')}>Cancel this call</button>}
            {may && <button className="btn btn-sm" onClick={() => act('retry')}>Try again</button>}
          </div>
          {call.waitReason && <div className="notice amber">{call.waitReason}{call.nextAttemptAt ? ` (${when(call.nextAttemptAt)})` : ''}</div>}
          {call.failReason && call.status !== 'completed' && <div className="small-muted" style={{ marginBottom: 6 }}>{call.failReason}</div>}
          {call.summary && <p style={{ margin: '6px 0' }}>{call.summary}</p>}
          <table>
            <tbody>
              <tr><td className="small-muted">Started by</td><td>{`${call.initiatedByName || call.initiatedVia} (${call.initiatedVia})`}</td></tr>
              <tr><td className="small-muted">When</td><td>{when(call.startedAt || call.createdAt)}</td></tr>
              <tr><td className="small-muted">Tries</td><td>{`${call.attempts} of ${call.maxAttempts}`}</td></tr>
              {a.experienceYears != null && <tr><td className="small-muted">Experience</td><td>{`${a.experienceYears} years`}</td></tr>}
              {a.currentLocation && <tr><td className="small-muted">Lives in</td><td>{a.currentLocation}</td></tr>}
              {a.noticePeriodText && <tr><td className="small-muted">Notice period</td><td>{a.noticePeriodText}</td></tr>}
              {a.willingToProceed != null && <tr><td className="small-muted">Willing to go ahead</td><td>{a.willingToProceed ? 'Yes' : 'No'}</td></tr>}
              {call.rescheduleWish && <tr><td className="small-muted">Wants the interview at</td><td>{call.rescheduleWish} (the interview was NOT changed)</td></tr>}
              {call.nextAction && <tr><td className="small-muted">What to do next</td><td>{call.nextAction}{call.followUpDate ? ` (by ${call.followUpDate})` : ''}</td></tr>}
            </tbody>
          </table>
          {call.transcript && call.transcript.length > 0 && (
            <>
              <div className="section-label" style={{ margin: '12px 0 4px' }}>What was said</div>
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px', maxHeight: 220, overflow: 'auto' }}>
                {call.transcript.map((t, i) => <p key={i} style={{ margin: '3px 0', fontSize: 13 }}><b>{t.who === 'assistant' ? 'Assistant' : 'Candidate'}:</b> {t.text}</p>)}
              </div>
            </>
          )}
          {(call.events || []).length > 0 && (
            <>
              <div className="section-label" style={{ margin: '12px 0 4px' }}>What Exotel told us</div>
              {call.events.filter((e) => e.kind !== 'attempt').map((e, i) => <div key={i} className="small-muted">{`${when(e.receivedAt)} · ${e.status || e.kind}${e.note ? ` · ${e.note}` : ''}`}</div>)}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
