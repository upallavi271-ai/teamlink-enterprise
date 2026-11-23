import { useEffect, useState } from 'react';
import api from '../../api';
import { useBrowserCall } from './CallProvider.jsx';

export const mmss = (n) => (n == null ? '—' : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`);
export const statusWord = (s) => ({ completed: 'Connected', connected: 'Connected', failed: 'Failed', busy: 'Busy', missed: 'No answer', cancelled: 'Cancelled', calling: 'Calling', ringing: 'Ringing', initiated: 'Starting' }[s] || s);
const at = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// Real calls made from the browser to this candidate (rows written from Asterisk events). Hidden when the login may not use browser calling.
export default function CallHistory({ candidateId }) {
  const { available, state } = useBrowserCall();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!available || !candidateId) return;
    api.get(`/browser-calling/candidates/${candidateId}/calls`).then((r) => { setRows(r.data.rows || []); setErr(''); }).catch((e) => setErr((e.response && e.response.data && e.response.data.error) || 'Could not load the call history.'));
  }, [available, candidateId, state.phase === 'ended' || state.phase === 'failed']); // eslint-disable-line react-hooks/exhaustive-deps
  if (!available) return null;
  return (
    <div className="card section">
      <div className="section-label">Browser calls{rows ? ` (${rows.length})` : ''}</div>
      {err && <div className="notice red">{err}</div>}
      {rows && rows.length === 0 && <div className="small-muted">No browser calls yet.</div>}
      {rows && rows.length > 0 && (
        <table className="table">
          <thead><tr><th>When</th><th>Recruiter</th><th>Number</th><th>Line</th><th>Status</th><th>Talk time</th><th>Reason</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{at(r.startAt)}</td><td>{r.userName || '—'}</td><td>{r.number}</td><td>{r.lineName || 'Office Synway (SIM)'}</td><td>{statusWord(r.status)}</td><td>{mmss(r.talkSec)}</td>
                <td className="small-muted">{r.hangupReason || (r.status === 'completed' ? 'Hung up' : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
