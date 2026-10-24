import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, GsModal, Pill } from '../ui.jsx';
import { CH_WORD, fmtClock, fmtShort, saveBlob } from './shared.jsx';

const STATUSES = [['all', 'All Statuses'], ['read', 'Read'], ['delivered', 'Delivered'], ['sent', 'Sent'], ['rehearsed', 'Rehearsed (test)'], ['queued', 'Waiting / To call'], ['failed', 'Failed'], ['skipped', 'Left out']];
const TONE = { read: 'live', delivered: 'scheduled', sent: 'draft', rehearsed: 'warn', queued: 'draft', failed: 'red', skipped: 'warn', cancelled: 'draft' };

// "Live Message Logs": one row per person per channel, real statuses and plain error reasons. The phone / email is masked by the server for the masked roles.
export default function MessageLogsModal({ campaignKey, name, onClose }) {
  const { toast } = useOmni();
  const [status, setStatus] = useState('all');
  const [channel, setChannel] = useState('');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setData(await omni.get(`/gs/campaigns/campaign/${campaignKey}/logs`, { status, channel, q: qLive, page, pageSize })); setErr(''); } catch (e) { setErr(errOf(e, 'The log could not be loaded.')); }
  }, [campaignKey, status, channel, qLive, page, pageSize]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setQLive(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const t = setInterval(load, 12000); return () => clearInterval(t); }, [load]);

  const csv = async () => {
    try { saveBlob(await omni.blob(`/gs/campaigns/campaign/${campaignKey}/logs.csv`, { status, channel, q: qLive }), `${campaignKey}_message_logs.csv`); toast('Message log downloaded'); } catch (e) { toast('The file could not be made. Only an Admin or a Manager can download the log.'); }
  };
  const total = data ? data.total : 0;
  const from = total ? (page - 1) * pageSize + 1 : 0; const to = Math.min(total, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <GsModal title="Live Message Logs" sub={`Total Records: ${data ? data.total : 0}${name ? ` · ${name}` : ''}`} width={980} onClose={onClose} bodyStyle={{ maxHeight: '70vh' }}
      foot={(
        <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, fontSize: 10, color: 'var(--muted)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>Rows per page:
            <select className="select" style={{ height: 32 }} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>{[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>{total ? `Showing ${from} - ${to} of ${total}` : 'Showing 0 of 0'}</span>
            <button type="button" className="tiny-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>
            <button type="button" className="tiny-btn" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">›</button>
          </span>
        </div>
      )}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input className="search" style={{ flex: 1, minWidth: 220 }} placeholder={data && data.masked ? 'Search name...' : 'Search Phone or name...'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}{data && data.facets && v !== 'all' && data.facets[v] != null ? ` (${data.facets[v]})` : ''}</option>)}</select>
        {data && data.channels && data.channels.length > 1 && (
          <select className="select" value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }} aria-label="Channel"><option value="">All channels</option>{data.channels.map((c) => <option key={c} value={c}>{CH_WORD[c]}</option>)}</select>
        )}
        <button type="button" className="icon-btn" aria-label="Refresh" onClick={() => { load(); toast('Logs refreshed'); }}>↻</button>
        {data && data.canExport && <Btn primary onClick={csv}>⬇ Download CSV</Btn>}
      </div>
      {data && data.rehearsal && <div style={{ fontSize: 10.5, color: '#8a6410', background: '#fff6df', borderRadius: 9, padding: '7px 10px', marginBottom: 10 }}>Test mode: the rows marked Rehearsed were made and logged, but nothing was really sent.</div>}
      {err && <div className="cmp-err">{err}</div>}
      <div className="table-scroll" style={{ border: '1px solid var(--line)', borderRadius: 12 }}>
        <table className="table cmp-table-small cmp-logs-table">
          <thead><tr><th>Recipient</th><th>Status</th><th>Sent/Started At</th><th>Delivered At</th><th>Read At</th><th>Error Code</th><th>Error Description</th><th>Name</th></tr></thead>
          <tbody>
            {data && data.messages.map((m) => {
              const key = m.readAt ? 'read' : m.statusKey;
              return (
                <tr key={m.id}>
                  <td style={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{m.contact || '—'}<span className="cmp-sub">{CH_WORD[m.channel] || m.channel}</span></td>
                  <td><Pill tone={TONE[key] || 'draft'}>{m.readAt ? 'Read' : m.statusWords}</Pill></td>
                  <td>{fmtShort(m.sentAt || m.at)}</td><td>{fmtClock(m.deliveredAt)}</td><td>{fmtClock(m.readAt)}</td>
                  <td>{m.errorCode || '—'}</td><td style={{ overflowWrap: 'anywhere' }}>{m.errorWords || '—'}</td><td style={{ overflowWrap: 'anywhere' }}>{m.name}</td>
                </tr>
              );
            })}
            {data && !data.messages.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>No log entries match this filter.</td></tr>}
            {!data && !err && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </GsModal>
  );
}
