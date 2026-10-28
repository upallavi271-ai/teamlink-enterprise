import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { when } from './assetPortalCommon.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import './vendorModules.css';

// /vendor/asset-portal/history - Repair History: every change on every repair of this vendor, newest first (its own saves and the company's own
// changes to the same repairs). Read from the append-only repair history; nothing can be edited here. Search, filter and pages are on the server.
export default function AssetPortalHistory() {
  return (
    <VendorShell title="Repair History" sub="Every change made to your repairs: who changed what, and when.">
      <Body />
    </VendorShell>
  );
}

// Also the "Repair history" tab of Repairs & HRMS Tickets (27 Oct 2026)
export function HistoryBody() { return <Body />; }

function Body() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', kind: '', from: '', to: '', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/history', { params: { q: qDeb || undefined, kind: f.kind || undefined, from: f.from || undefined, to: f.to || undefined, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the history.')));
  }, [qDeb, f.kind, f.from, f.to, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.kind || f.from || f.to);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      <VendorIoBar list="history" params={{ ...f, q: qDeb }} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search repair number, asset or what was changed" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <select aria-label="Kind of change" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
          <option value="">Any kind of change</option>
          {(data?.kinds || []).map((k) => <option key={k.value} value={k.value}>{k.label} ({k.count})</option>)}
        </select>
        <div className="vp-dates">
          <input type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', kind: '', from: '', to: '', dir: 'desc', page: 1 })}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">{data.all ? <><h3>No change matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No history yet</h3><p>When a repair is updated, every change is listed here.</p></>}</div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>When</th><th>Repair</th><th>Asset</th><th>Changed by</th><th>What changed</th><th>From</th><th>To</th></tr></thead>
              <tbody>{rows.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.at)}</td>
                  <td><Link to={`/vendor/asset-portal/repairs?open=${encodeURIComponent(e.repairId)}`}><strong>{e.repairNo}</strong></Link></td>
                  <td>{e.assetCode} &middot; {e.assetName}</td>
                  <td>{e.by}</td>
                  <td>{e.field || e.kind}{e.kind === 'remark' ? '' : ''}</td>
                  <td>{e.kind === 'remark' ? '-' : (e.from == null || e.from === '' ? '-' : e.from)}</td>
                  <td>{e.to == null || e.to === '' ? (e.note || '-') : e.to}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      <p className="cell-muted">This list can only grow: a change that was made can never be removed or edited.</p>
    </>
  );
}
