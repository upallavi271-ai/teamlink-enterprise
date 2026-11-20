import { useEffect, useState, useCallback } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import ReminderDetailsFields from './ReminderDetailsFields.jsx';
import {
  istDate, istTime, fromIst, when, STATUS_WORD, STATUS_TONE, LANG_NAME,
} from './remUtil.js';
import './reminders.css';

// ---------------------------------------------------------------------------
// "Scheduled messages" - the messages that will go (or went) to the candidate before an interview and before the joining
// (founder 2026-11-20). On the candidate / application page and in the interview calendar's detail window.
//   recruiter, TL, STL, Manager, Admin: every message with its words, who changed it and why
//   BDE side: only the count (never the words)
//   recruiter / TL / STL / Admin (and a BDE who may book): change the time, skip one with a reason, add one, send now, cancel all, edit the venue details.
// (backend: GET /api/ats/reminders/application/:id, utils/scheduledReminders.js)
// ---------------------------------------------------------------------------
function KindBlock({ appId, kind, k, reload }) {
  const [openText, setOpenText] = useState({});
  const [editing, setEditing] = useState(null); // { id, date, time }
  const [adding, setAdding] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const word = kind === 'joining' ? 'Joining' : 'Interview';
  const run = async (fn, ok) => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await fn(); if (ok) setMsg(typeof ok === 'function' ? ok(r) : ok); reload(); return r; } catch (e) { setErr(e.response?.data?.error || 'Could not save. Please try again.'); return null; } finally { setBusy(false); }
  };
  const skip = (row) => {
    const reason = window.prompt('Why is this message skipped? (a few words)');
    if (reason && reason.trim()) run(() => api.patch(`/ats/reminders/rows/${row.id}`, { skip: true, reason: reason.trim() }), 'Skipped.');
  };
  const cancelAll = () => {
    const reason = window.prompt('Why are all the unsent messages cancelled? (a few words)');
    if (reason && reason.trim()) run(() => api.post(`/ats/reminders/application/${appId}/cancel-all`, { kind, reason: reason.trim() }), (r) => `Cancelled ${r.data.cancelled} message(s).`);
  };
  if (!k) return null;
  const c = k.counts;
  if (!k.live && !c.total) return null;
  const openCount = c.planned;
  return (
    <div className="rem-box" style={{ marginBottom: 8 }}>
      <div className="rem-head">
        <b>{`${word} reminders`}</b>
        {k.live ? <span className="small-muted">{`${word} ${when(k.eventAt)}${k.mode === 'offline' ? ' · offline' : k.mode === 'online' ? ' · online' : k.mode === 'phone' ? ' · by phone' : ''}`}</span> : <StatusChip tone="grey">{k.endedBecause || 'Not live'}</StatusChip>}
        <span className="small-muted">{`${c.total} message${c.total === 1 ? '' : 's'}: ${c.planned} waiting · ${c.sent + c.delivered} sent${c.failed ? ` · ${c.failed} failed` : ''}${c.skipped ? ` · ${c.skipped} skipped` : ''}`}</span>
      </div>
      {k.countOnly && <div className="small-muted">Only the number of messages is shown to your team. The recruiter and the team lead see the words.</div>}
      {!k.countOnly && k.rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="rem-table">
            <thead><tr><th>Goes</th><th>Way</th><th>Language</th><th>Status</th><th /></tr></thead>
            <tbody>
              {k.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {editing && editing.id === r.id ? (
                      <div className="rem-actions">
                        <input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                        <input type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} />
                        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { const ok = await run(() => api.patch(`/ats/reminders/rows/${r.id}`, { sendAt: fromIst(editing.date, editing.time) }), 'Time changed.'); if (ok) setEditing(null); }}>Save</button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <b>{when(r.sendAt)}</b>
                        <div className="small-muted" style={{ fontSize: 11 }}>{r.label}</div>
                      </>
                    )}
                    {openText[r.id] && <div className="rem-text" style={{ marginTop: 4 }}>{r.text}</div>}
                    {r.history && r.history.length > 0 && <div className="rem-hist">{r.history.slice(-2).map((h) => `${h.by}: ${h.text}`).join(' · ')}</div>}
                  </td>
                  <td>{r.channel}</td>
                  <td>{LANG_NAME[r.language] || r.language}</td>
                  <td>
                    <StatusChip tone={STATUS_TONE[r.status] || 'grey'}>{STATUS_WORD[r.status] || r.status}</StatusChip>
                    {r.deliveryStatus && ['sent', 'delivered', 'failed'].includes(r.status) && r.deliveryStatus !== 'Sent' && <div className="small-muted" style={{ fontSize: 11 }}>{r.deliveryStatus}</div>}
                    {r.reason && ['failed', 'skipped', 'cancelled'].includes(r.status) && <div className="rem-hist">{r.reason}</div>}
                    {r.status === 'planned' && r.reason && <div className="rem-warn">{r.reason}</div>}
                    {r.editedBy && <div className="rem-hist">{`Changed by ${r.editedBy}`}</div>}
                  </td>
                  <td>
                    <div className="rem-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpenText((o) => ({ ...o, [r.id]: !o[r.id] }))}>{openText[r.id] ? 'Hide words' : 'Words'}</button>
                      {k.canEdit && ['planned', 'skipped'].includes(r.status) && <button type="button" className="btn btn-sm" onClick={() => setEditing({ id: r.id, date: istDate(r.sendAt), time: istTime(r.sendAt) })}>Change time</button>}
                      {k.canEdit && r.status === 'planned' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => skip(r)}>Skip</button>}
                      {k.canEdit && r.status === 'planned' && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/ats/reminders/rows/${r.id}/send-now`), (x) => (x.data.ok ? 'Sent.' : `Not sent: ${x.data.reason || x.data.outcome}`))}>Send now</button>}
                      {k.canEdit && r.status === 'failed' && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/ats/reminders/rows/${r.id}/send-now`), (x) => (x.data.ok ? 'Sent.' : `Not sent: ${x.data.reason || x.data.outcome}`))}>Try again</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {k.canEdit && k.live && (
        <div className="rem-actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => setAdding(adding ? null : { date: '', time: '10:00', channel: '', language: '' })}>+ Add a message</button>
          {openCount > 0 && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={cancelAll}>Cancel all unsent</button>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setDetails(k.info || {}); setDetailsOpen(!detailsOpen); }}>{detailsOpen ? 'Close details' : 'Venue and contact details'}</button>
        </div>
      )}
      {adding && (
        <div className="rem-actions" style={{ marginTop: 6 }}>
          <input type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} aria-label="Date" />
          <input type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} aria-label="Time" />
          <select value={adding.channel} onChange={(e) => setAdding({ ...adding, channel: e.target.value })} aria-label="Way">
            <option value="">Usual way</option>
            {['WhatsApp', 'SMS', 'Email'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={adding.language} onChange={(e) => setAdding({ ...adding, language: e.target.value })} aria-label="Language">
            <option value="">Usual language</option>
            <option value="en">English</option>
            <option value="te">Telugu</option>
          </select>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !adding.date} onClick={async () => { const ok = await run(() => api.post(`/ats/reminders/application/${appId}/rows`, { kind, sendAt: fromIst(adding.date, adding.time), channel: adding.channel || undefined, language: adding.language || undefined }), 'Added.'); if (ok) setAdding(null); }}>Add</button>
        </div>
      )}
      {detailsOpen && details && (
        <div style={{ marginTop: 8 }}>
          <ReminderDetailsFields kind={kind} value={details} onChange={setDetails} />
          <div style={{ marginTop: 6 }}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { const ok = await run(() => api.put(`/ats/reminders/application/${appId}/details`, { kind, details }), 'Details saved. The messages use them.'); if (ok) setDetailsOpen(false); }}>Save details</button></div>
        </div>
      )}
      {msg && <div className="notice" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export default function ScheduledMessagesPanel({ applicationId, only = null, compact = false }) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!applicationId) return undefined;
    let live = true;
    api.get(`/ats/reminders/application/${applicationId}`).then((r) => { if (live) setData(r.data); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [applicationId, tick]);
  if (!data) return null;
  const kinds = ['interview', 'joining'].filter((x) => !only || only === x);
  const any = kinds.some((x) => data.kinds[x] && (data.kinds[x].live || data.kinds[x].counts.total));
  if (!any) return null;
  return (
    <div className="ivx-sec" style={compact ? { marginTop: 8 } : undefined}>
      <b>Scheduled messages</b>
      {data.switchNote && <div className="rem-warn" style={{ margin: '4px 0' }}>{data.switchNote}</div>}
      {kinds.map((x) => <KindBlock key={x} appId={applicationId} kind={x} k={data.kinds[x]} reload={reload} />)}
    </div>
  );
}
