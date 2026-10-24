import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { NotRecorded, AirTag } from './airtelCommon.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import './vendorModules.css';

// /vendor/airtel-portal/sims - SIMs: the company's Airtel SIMs, READ ONLY. They are the company's own asset records (nothing is copied here, so a
// SIM can never appear twice). The number is masked (98xxxxxx21); only the department is shown, never the person who holds the SIM.
export default function AirtelSims() {
  return (
    <VendorShell title="SIMs" sub="The company's Airtel SIMs. You can look at them here; the company keeps them up to date.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', department: '', status: '', sort: 'simRef', dir: 'asc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/airtel-portal/sims', { params: { q: qDeb || undefined, department: f.department || undefined, status: f.status || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the SIMs.')));
  }, [qDeb, f.department, f.status, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.department || f.status);
  const s = data?.summary;
  const opt = (list) => (list || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>SIMs</span><b>{s.total}</b></div>
          <div className="vp-tile green"><span>In use</span><b>{s.inUse}</b></div>
          <div className="vp-tile"><span>In stock</span><b>{s.inStock}</b></div>
        </div>
      )}
      <VendorIoBar list="sims" params={{ ...f, q: qDeb }} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search SIM ID or number (98xxxxxx21)" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <select aria-label="Department" value={f.department} onChange={(e) => set({ department: e.target.value })}><option value="">Any department</option>{opt(data?.facets.department)}</select>
        <select aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Any status</option>{opt(data?.facets.status)}</select>
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{[['simRef', 'SIM ID'], ['number', 'Number'], ['department', 'Department'], ['status', 'Status']].map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'A to Z' : 'Z to A'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', department: '', status: '', sort: 'simRef', dir: 'asc', page: 1 })}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">{data.all ? <><h3>No SIM matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No SIMs yet</h3><p>When the company has Airtel SIMs on its asset list, they show here.</p></>}</div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>SIM ID</th><th>Mobile number</th><th>SIM card</th><th>Department</th><th>Status</th><th>Last bill</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="abp-nowrap"><strong>{r.simRef}</strong><div className="cell-muted">{r.provider}</div></td>
                    <td>{r.number || <NotRecorded />}</td>
                    <td>{r.iccid || <NotRecorded />}</td>
                    <td>{r.department || <NotRecorded />}</td>
                    <td><span className={`vp-tag ${r.status === 'In use' || r.status === 'Active' ? 'vp-green' : (r.status === 'Suspended' || r.status === 'Disconnected' ? 'vp-red' : 'vp-grey')}`}>{r.status}</span></td>
                    <td className="abp-wrap-cell">{r.lastBill
                      ? <><Link to={`/vendor/airtel-portal/bills?q=${encodeURIComponent(r.lastBill.invoiceNo || '')}`}>{r.lastBill.invoiceNo || r.lastBill.periodLabel || 'Open'}</Link> <AirTag pay={{ status: r.lastBill.payment, tone: null }} /></>
                      : <span className="cell-muted">Not recorded (one bill covers all numbers)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
    </>
  );
}
