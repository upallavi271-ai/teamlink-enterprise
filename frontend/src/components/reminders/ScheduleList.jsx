import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import { when, STATUS_WORD, STATUS_TONE } from './remUtil.js';

// ---------------------------------------------------------------------------
// The schedules of the advanced scheduler (utils/messageSchedules.js), shared by the candidate tab and the Scheduled Messages page:
//   ScheduleList     one line per schedule: frequency (Daily x 5 / One-time ...), progress 3/5, status, next, Pause / Resume / Edit / Cancel
//   OccurrenceTable  every message of one schedule: scheduled, sent, delivered (only from the provider's report), provider id, status, reason, tries
// ---------------------------------------------------------------------------
export const SCHED_WORD = { upcoming: 'Upcoming', active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' };
export const SCHED_TONE = { upcoming: 'blue', active: 'green', paused: 'yellow', completed: 'green', cancelled: 'grey', failed: 'red' };
const OCC_WORD = { ...STATUS_WORD, planned: 'Scheduled', sending: 'Sending' };
export const progressOf = (s) => `${s.progress.done}/${s.totalPlanned == null ? '∞' : s.totalPlanned}`;

export async function scheduleAction(s, kind) {
  if (kind === 'cancel') {
    const reason = window.prompt('Cancel this schedule? No more messages will go. Why (optional):', '');
    if (reason === null) return null;
    return api.post(`/ats/scheduled-messages/${s.id}/cancel`, { reason });
  }
  if (kind === 'pause') return api.post(`/ats/scheduled-messages/${s.id}/pause`, {});
  return api.post(`/ats/scheduled-messages/${s.id}/resume`, {});
}

export function OccurrenceTable({ id, refreshKey = 0 }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.get(`/ats/scheduled-messages/${id}`).then((r) => { if (live) setD(r.data); }).catch((e) => { if (live) setErr(e.response?.data?.error || 'Could not load the messages.'); });
    return () => { live = false; };
  }, [id, refreshKey]);
  if (err) return <div className="rem-bad">{err}</div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const full = d.access === 'full';
  return (
    <div style={{ overflowX: 'auto' }} data-testid="sm-occurrences">
      {d.schedule.stopReason && <div className="rem-hist" style={{ marginBottom: 4 }}>{`Stopped: ${d.schedule.stopReason}`}</div>}
      <table className="rem-table">
        <thead><tr><th>#</th><th>Scheduled</th><th>Sent</th><th>Delivered</th><th>Status</th>{full && <th>Provider id</th>}<th>Reason</th><th>Tries</th></tr></thead>
        <tbody>
          {d.occurrences.map((o) => (
            <tr key={o.id}>
              <td>{o.seq || ''}</td>
              <td><b>{when(o.scheduledAt)}</b></td>
              <td>{o.sentAt ? when(o.sentAt) : '—'}</td>
              <td>{o.deliveredAt ? when(o.deliveredAt) : '—'}</td>
              <td><StatusChip tone={STATUS_TONE[o.status] || 'blue'}>{OCC_WORD[o.status] || o.status}</StatusChip></td>
              {full && <td className="small-muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{o.providerMessageId || '—'}</td>}
              <td className="small-muted" style={{ fontSize: 11.5 }}>{o.failureReason || ''}</td>
              <td>{o.attempts || 0}</td>
            </tr>
          ))}
          {!d.occurrences.length && <tr><td colSpan={8} className="small-muted">No messages planned right now.</td></tr>}
        </tbody>
      </table>
      {d.schedule.kind === 'recurring' && d.schedule.endMode !== 'manual' && d.schedule.totalPlanned > d.occurrences.length && (
        <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{`The next ${d.schedule.totalPlanned - d.occurrences.length} are planned as these go (20 waiting at a time).`}</div>
      )}
    </div>
  );
}

export default function ScheduleList({ rows, onChanged, onEdit, compact = false }) {
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const act = async (s, kind) => {
    setBusy(s.id); setErr('');
    try { const r = await scheduleAction(s, kind); if (r) { onChanged && onChanged(); setTick((n) => n + 1); } } catch (e) { setErr(e.response?.data?.error || 'Could not do that.'); } finally { setBusy(''); }
  };
  return (
    <div>
      {err && <div className="rem-bad" role="alert">{err}</div>}
      {rows.map((s) => (
        <div key={s.id} className="sm-row" data-testid="sm-schedule">
          <div className="sm-row-top">
            <b>{s.automatic ? `Automatic: ${s.triggerLabel}` : s.frequencyLabel}</b>
            <span className="small-muted">{s.channel}</span>
            <StatusChip tone={SCHED_TONE[s.status] || 'grey'}>{SCHED_WORD[s.status] || s.status}</StatusChip>
            <span className="small-muted">{`${progressOf(s)} sent${s.counts.delivered ? ` · ${s.counts.delivered} delivered` : ''}${s.counts.failed ? ` · ${s.counts.failed} failed` : ''}`}</span>
            <span className="small-muted sm-by">{s.nextAt ? `next ${when(s.nextAt)}` : ''}</span>
          </div>
          {!compact && s.requirement && <div className="small-muted" style={{ fontSize: 12 }}>{s.requirement}</div>}
          {s.body && <div className="sm-words">{s.body}</div>}
          {s.stopReason && <div className="rem-hist">{s.stopReason}</div>}
          <div className="rem-actions" style={{ marginTop: 4 }}>
            {['upcoming', 'active'].includes(s.status) && <button type="button" className="btn btn-sm" disabled={busy === s.id} onClick={() => act(s, 'pause')}>Pause</button>}
            {s.status === 'paused' && <button type="button" className="btn btn-sm btn-primary" disabled={busy === s.id} onClick={() => act(s, 'resume')}>Resume</button>}
            {onEdit && !s.automatic && ['upcoming', 'active', 'paused'].includes(s.status) && <button type="button" className="btn btn-sm" disabled={busy === s.id} onClick={() => onEdit(s)}>Edit</button>}
            {['upcoming', 'active', 'paused'].includes(s.status) && <button type="button" className="btn btn-sm btn-ghost" disabled={busy === s.id} onClick={() => act(s, 'cancel')}>Cancel</button>}
            <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide messages' : 'Messages'}</button>
          </div>
          {open === s.id && <OccurrenceTable id={s.id} refreshKey={tick} />}
        </div>
      ))}
    </div>
  );
}
