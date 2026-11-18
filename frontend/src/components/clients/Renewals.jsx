import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';

// ---------------------------------------------------------------------------
// AGREEMENT RENEWALS (audit 720): every agreement by its end date. Upcoming (within 60 days), Due (within 30), Expired, Renewed. A BDE is
// assigned to each; "Mark renewed" takes the new dates and starts the next agreement. Reminders to the BDE are an Admin switch (OFF).
// Backend: routes/clientDepth.js (/api/ats-clients/renewals), utils/clientDepth.js.
// ---------------------------------------------------------------------------
const TONE = { Upcoming: 'blue', Due: 'orange', Expired: 'red', Renewed: 'green' };
const err = (e, f) => e?.response?.data?.error || f;
const day = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const plusYear = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + 1); return x.toISOString().slice(0, 10); };

function RenewDialog({ row, onClose, onDone }) {
  const start = new Date(`${row.expiryDate}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 1);
  const s0 = start.toISOString().slice(0, 10);
  const [newStart, setNewStart] = useState(s0);
  const [newEnd, setNewEnd] = useState(plusYear(s0));
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setMsg('');
    try { await api.post(`/ats-clients/renewals/${row.clientId}/renew`, { newStart, newEnd, note }); onDone(`${row.client}: the next agreement runs ${day(newStart)} to ${day(newEnd)}.`); } catch (e) { setMsg(err(e, 'Could not renew.')); } finally { setBusy(false); }
  }
  return (
    <div className="overlay show" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head"><h3 style={{ fontSize: 15 }}>Mark renewed: {row.client}</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <div className="small-muted">The old agreement ended {day(row.expiryDate)}. Give the dates of the next one.</div>
          <div style={{ display: 'flex', gap: 10, margin: '8px 0', flexWrap: 'wrap' }}>
            <label><span className="small-muted">New start</span><input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} /></label>
            <label><span className="small-muted">New end</span><input type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} /></label>
          </div>
          <input placeholder="Note (optional)" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} />
          {msg && <div className="error-text" role="alert">{msg}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="btn btn-primary" disabled={busy} onClick={go}>{busy ? 'Saving…' : 'Mark renewed'}</button></div>
      </div>
    </div>
  );
}

export default function Renewals() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('all');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [renew, setRenew] = useState(null);
  const [bdes, setBdes] = useState([]);
  const load = useCallback(() => api.get('/ats-clients/renewals', { params: status === 'all' ? {} : { status } }).then((r) => { setData(r.data); setError(''); }).catch((e) => setError(err(e, 'The renewals could not be loaded.'))), [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/ats-clients/bdes').then((r) => setBdes(r.data.rows || [])).catch(() => setBdes([])); }, []);
  const assign = async (row, bdeId) => { try { await api.put(`/ats-clients/renewals/${row.clientId}/assign`, { bdeId: bdeId || null }); load(); } catch (e) { setError(err(e, 'Could not assign.')); } };
  if (error && !data) return <div className="notice red"><span>{error}</span></div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
        {[['all', 'All'], ['Due', `Due (${data.counts.Due})`], ['Upcoming', `Upcoming (${data.counts.Upcoming})`], ['Expired', `Expired (${data.counts.Expired})`], ['Renewed', `Renewed (${data.counts.Renewed})`]].map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-sm${status === k ? ' btn-primary' : ''}`} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>
        ))}
        <span className="small-muted" style={{ alignSelf: 'center' }}>Upcoming = ends within {data.windows.upcomingDays} days · Due = within {data.windows.dueDays} days · BDE reminders are {data.remindersOn ? 'ON' : 'OFF (an Admin switches them on)'}.</span>
      </div>
      {flash && <div className="notice" role="status">{flash}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Client</th><th>Agreement</th><th>Ends</th><th>Status</th><th>BDE</th><th /></tr></thead>
          <tbody>
            {data.rows.length === 0 && <tr><td colSpan={6} className="empty-mini">Nothing to renew in this view.</td></tr>}
            {data.rows.map((r) => (
              <tr key={`${r.clientId}|${r.expiryDate}|${r.status}`}>
                <td><Link to={`/clients/${r.clientId}`}>{r.client}</Link></td>
                <td className="cell-muted">{r.agreementId || '—'}</td>
                <td>{day(r.expiryDate)}{r.daysLeft != null && <div className="small-muted">{r.daysLeft < 0 ? `${-r.daysLeft} day${r.daysLeft === -1 ? '' : 's'} ago` : `in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`}</div>}</td>
                <td><span className={`status ${TONE[r.status]}`}>{r.status}</span>{r.status === 'Renewed' && <div className="small-muted">now {day(r.newStart)} to {day(r.newEnd)}</div>}</td>
                <td>
                  {data.canEdit && r.status !== 'Renewed' && bdes.length > 0
                    ? <select aria-label={`BDE for ${r.client}`} value={r.assignedBdeId || ''} onChange={(e) => assign(r, e.target.value)}><option value="">{r.assignedBdeName ? `${r.assignedBdeName} (owner)` : 'Not assigned'}</option>{bdes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                    : (r.assignedBdeName || '—')}
                </td>
                <td>{data.canEdit && r.status !== 'Renewed' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setRenew(r)}>Mark renewed</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renew && <RenewDialog row={renew} onClose={() => setRenew(null)} onDone={(m) => { setRenew(null); setFlash(m); load(); }} />}
    </div>
  );
}
