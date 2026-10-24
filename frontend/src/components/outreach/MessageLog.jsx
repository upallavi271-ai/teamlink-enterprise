import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './campaigns.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > MESSAGE LOG (quick wins, T1). Every message the Outreach queue made: who (phone / email hidden for the roles that may not see them),
// which way, what happened, why, when. One campaign (campaignId given) or every campaign you may see. Search, filters (status, campaign, way, dates),
// pages, and "Download CSV" (same filters, only for the logins that may download; the server decides). Server: /api/outreach/messages.
// Plain words: Waiting, Sent, Rehearsed (nothing really sent), Delivered, Failed, Skipped.
// ---------------------------------------------------------------------------
const STATUS = [['queued', 'Waiting', 'yellow'], ['sent', 'Sent', 'blue'], ['rehearsed', 'Rehearsed', 'blue'], ['delivered', 'Delivered', 'green'], ['failed', 'Failed', 'red'], ['skipped', 'Skipped', 'grey'], ['cancelled', 'Cancelled', 'grey']];
const TONE = Object.fromEntries(STATUS.map(([k, , t]) => [k, t]));
const WAYS = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS']];
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

export default function MessageLog({ campaignId = null, reason = '', onClearReason, refreshMs = 0 }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [way, setWay] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [camp, setCamp] = useState('');
  const [camps, setCamps] = useState([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dl, setDl] = useState(false);
  const cid = campaignId || camp || undefined;
  const params = { campaignId: cid, status: status || undefined, channel: way || undefined, from: from || undefined, to: to || undefined, q: q || undefined, reason: reason || undefined };
  const load = useCallback(() => {
    setBusy(true);
    api.get('/outreach/messages', { params: { ...params, page, pageSize: 25 } }).then((r) => { setData(r.data); setErr(''); })
      .catch((e) => { setErr(errOf(e, 'The message log could not be loaded.')); setData((d) => d || { messages: [], total: 0, pageSize: 25, facets: {} }); }).finally(() => setBusy(false));
  }, [cid, status, way, from, to, q, reason, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (!refreshMs) return undefined; const t = setInterval(load, refreshMs); return () => clearInterval(t); }, [load, refreshMs]);
  useEffect(() => { if (campaignId) return; api.get('/outreach/messages/campaigns').then((r) => setCamps(r.data.campaigns)).catch(() => setCamps([])); }, [campaignId]);
  const reset = () => { setQ(''); setStatus(''); setWay(''); setFrom(''); setTo(''); setCamp(''); setPage(1); if (onClearReason) onClearReason(); };
  const filtered = !!(q || status || way || from || to || camp || reason);
  const pages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || 25))) : 1;
  const facets = (data && data.facets) || {};
  const download = async () => {
    setDl(true); setErr('');
    try {
      const r = await api.get('/outreach/messages/export', { params, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'outreach-message-log.csv'; a.click();
    } catch (e) { setErr('The file could not be made. Please try again.'); } finally { setDl(false); }
  };
  const one = (fn) => (v) => { setPage(1); fn(v); };

  return (
    <div className="occ-log">
      <div className="oc-bar">
        <input type="search" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} placeholder={data && data.masked ? 'Search a name or a campaign' : 'Search a name, an email, a phone or a campaign'} aria-label="Search the message log" />
        {!campaignId && (
          <div style={{ minWidth: 220 }}>
            <Combo value={camp} onChange={(e) => one(setCamp)(e.target.value)}>
              <option value="">All campaigns</option>
              {camps.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.messages})</option>)}
            </Combo>
          </div>
        )}
        {data && data.canExport && <button type="button" className="btn btn-sm" disabled={dl || !data.total} onClick={download}>{dl ? 'Making the file…' : 'Download CSV'}</button>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={load}>Refresh</button>
      </div>
      <div className="oc-choice" aria-label="What happened">
        <button type="button" className={status === '' ? 'on' : ''} onClick={() => one(setStatus)('')}>All</button>
        {STATUS.filter(([k]) => facets[k] || status === k).map(([k, w]) => <button type="button" key={k} className={status === k ? 'on' : ''} onClick={() => one(setStatus)(status === k ? '' : k)}>{w} ({facets[k] || 0})</button>)}
      </div>
      <div className="occ-logrow">
        <div className="oc-choice" aria-label="Which way">
          <button type="button" className={way === '' ? 'on' : ''} onClick={() => one(setWay)('')}>Every way</button>
          {WAYS.map(([k, w]) => <button type="button" key={k} className={way === k ? 'on' : ''} onClick={() => one(setWay)(way === k ? '' : k)}>{w}</button>)}
        </div>
        <label className="occ-date"><span>From</span><input type="date" value={from} max={to || undefined} onChange={(e) => one(setFrom)(e.target.value)} aria-label="From date" /></label>
        <label className="occ-date"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => one(setTo)(e.target.value)} aria-label="To date" /></label>
        {filtered && <button type="button" className="btn btn-sm" onClick={reset}>Clear</button>}
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!data && <div className="oc-note">Loading…</div>}
      {data && data.messages.length === 0 && !err && (
        <div className="oc-empty"><b>{filtered ? 'No messages match.' : 'No messages yet.'}</b><div>{filtered ? 'Press Clear to see everything again.' : 'A message appears here as soon as a campaign is sent.'}</div></div>
      )}
      {data && data.messages.length > 0 && (
        <>
          <div className="oc-note">{data.total} {data.total === 1 ? 'message' : 'messages'}{data.masked ? ' · phone and email are hidden for your role' : ''}{!data.canExport ? ' · only an Admin or a Manager can download the list' : ''}</div>
          <div className="oc-scroll">
            <table className="oc-table">
              <thead><tr><th>Person</th><th>Phone or email</th>{!campaignId && <th className="oc-hide-m">Campaign</th>}<th className="oc-hide-m">Way</th><th>What happened</th><th className="oc-hide-m">When</th></tr></thead>
              <tbody>
                {data.messages.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td><td>{m.contact || '-'}</td>
                    {!campaignId && <td className="oc-hide-m">{m.campaignName}</td>}
                    <td className="oc-hide-m">{m.channel === 'email' ? 'Email' : (m.channel === 'whatsapp' ? 'WhatsApp' : 'SMS')}</td>
                    <td>
                      <StatusChip tone={TONE[m.statusKey]}>{m.statusWords}</StatusChip>
                      {m.reasonWords && <div className="oc-note">{m.reasonWords}</div>}
                      {m.error && <div className="oc-note">{m.error}</div>}
                      {m.clickedAt && <div className="oc-note">Opened the link {fmt(m.clickedAt)}</div>}
                    </td>
                    <td className="oc-hide-m oc-note">{fmt(m.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data && pages > 1 && <div className="oc-bar"><button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button><span className="oc-note">Page {page} of {pages}</span><button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>}
    </div>
  );
}
