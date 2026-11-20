import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import { when, STATUS_WORD, STATUS_TONE } from './remUtil.js';
import './reminders.css';

// ---------------------------------------------------------------------------
// The candidate profile's communication history: EVERY message of every schedule of this person (founder 2026-11-20: "for every occurrence:
// scheduled date/time, actual send date/time, delivery confirmation date/time, provider message ID, Sent / Delivered / Failed status, failure
// reason, retry attempts"). Delivered only from the provider's own delivery report. (backend: GET /api/ats/scheduled-messages/candidate/:id)
// ---------------------------------------------------------------------------
const WORD = { ...STATUS_WORD, planned: 'Scheduled', sending: 'Sending' };

export default function ScheduledHistory({ candidateId }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!candidateId) return undefined;
    let live = true;
    api.get(`/ats/scheduled-messages/candidate/${candidateId}`).then((r) => { if (live) setD(r.data); }).catch(() => { if (live) setD(null); });
    return () => { live = false; };
  }, [candidateId]);
  if (!d || d.access !== 'full' || !d.occurrences.length) return null;
  return (
    <div style={{ marginTop: 12 }} data-testid="sm-history">
      <div className="section-label">{`Scheduled messages: each message (${d.occurrences.length})`}</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Scheduled</th><th>Schedule</th><th>Channel</th><th>Sent</th><th>Delivered</th><th>Status</th><th>Provider id</th><th>Reason</th><th>Tries</th></tr></thead>
          <tbody>
            {d.occurrences.map((o) => (
              <tr key={o.id}>
                <td className="cell-muted">{when(o.scheduledAt)}</td>
                <td>{o.trigger ? `Automatic: ${o.trigger}` : o.scheduleLabel}{o.seq ? <span className="small-muted">{` · ${o.seq}${o.of ? ` of ${o.of}` : ''}`}</span> : null}</td>
                <td>{o.channel}</td>
                <td className="cell-muted">{o.sentAt ? when(o.sentAt) : '—'}</td>
                <td className="cell-muted">{o.deliveredAt ? when(o.deliveredAt) : '—'}</td>
                <td><StatusChip tone={STATUS_TONE[o.status] || 'blue'}>{WORD[o.status] || o.status}</StatusChip></td>
                <td className="cell-muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{o.providerMessageId || '—'}</td>
                <td className="cell-muted" style={{ fontSize: 11.5 }}>{o.failureReason || ''}</td>
                <td>{o.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
