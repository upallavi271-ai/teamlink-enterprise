import { useCallback, useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import {
  AirTag, NotRecorded, money, dateOr, rs,
} from './airtelCommon.jsx';
import './vendorModules.css';

// /vendor/airtel-portal/history - Monthly History: one row for every month from the first Airtel bill to this month. Bill amount, due date, paid,
// still to pay, status, invoice numbers and the (masked) payment reference. A month with no bill says so ("No bill recorded"): it is never shown as
// zero rupees. Money is added up only for bills Accounts holds; a bill you only sent is counted separately. Read only.
const SORTS = [['month', 'Month'], ['billAmount', 'Bill amount'], ['outstanding', 'Still to pay'], ['status', 'Status']];

export default function AirtelHistory() {
  return (
    <VendorShell title="Monthly History" sub="Month by month: what Airtel billed, what is paid and what is still to pay.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', status: '', period: '', from: '', to: '', sim: '', sort: 'month', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [simDeb, setSimDeb] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  useEffect(() => { const t = setTimeout(() => setSimDeb(f.sim), 350); return () => clearTimeout(t); }, [f.sim]);
  const load = useCallback(() => {
    vendorApi.get('/airtel-portal/history', { params: { q: qDeb || undefined, status: f.status || undefined, period: f.period || undefined, from: f.from || undefined, to: f.to || undefined, sim: simDeb || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the history.')));
  }, [qDeb, simDeb, f.status, f.period, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.status || f.period || f.from || f.to || f.sim);
  const t = data?.totals;
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {t && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Months with a bill</span><b>{t.months}</b></div>
          <div className="vp-tile"><span>Billed (bills in Accounts)</span><b>{rs(t.billed)}</b></div>
          <div className="vp-tile green"><span>Paid</span><b>{rs(t.paid)}</b></div>
          <div className="vp-tile orange"><span>Still to pay</span><b>{rs(t.outstanding)}</b></div>
        </div>
      )}
      {t && t.notInAccounts > 0 && <p className="abp-note">{t.notInAccounts} bill{t.notInAccounts === 1 ? '' : 's'} you sent {t.notInAccounts === 1 ? 'is' : 'are'} not in Accounts yet, so {t.notInAccounts === 1 ? 'it is' : 'they are'} not added to these totals.</p>}
      <VendorIoBar list="history" params={{ ...f, q: qDeb, sim: simDeb }} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search a month or an invoice number" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <select aria-label="Bill month" value={f.period} onChange={(e) => set({ period: e.target.value })}>
          <option value="">Any month</option>
          {(data?.facets.month || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select aria-label="Payment status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Any payment status</option>
          {(data?.facets.status || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
        </select>
        <div className="vp-dates">
          <input type="month" aria-label="From month" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="month" aria-label="To month" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <input type="search" placeholder="One SIM (AST-0146)" value={f.sim} onChange={(e) => set({ sim: e.target.value })} aria-label="One SIM" style={{ maxWidth: 170 }} />
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', status: '', period: '', from: '', to: '', sim: '', sort: 'month', dir: 'desc', page: 1 })}>Clear</button>}
      </div>
      {data?.simFilterNote && <p className="abp-note">{data.simFilterNote}</p>}
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">{data.all ? <><h3>No month matches</h3><p>Clear the search to see all months.</p></> : <><h3>No history yet</h3><p>When Accounts records your Airtel bill, its month shows here.</p></>}</div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Month</th><th className="num">Bill amount</th><th>Due date</th><th className="num">Paid</th><th className="num">Still to pay</th><th>Status</th><th>Invoice number</th><th>Payment reference</th></tr></thead>
              <tbody>
                {rows.map((r) => (r.noBill ? (
                  <tr key={r.month} className="abp-nobill"><td><strong>{r.label}</strong></td><td colSpan={7}>No bill recorded for this month.</td></tr>
                ) : (
                  <tr key={r.month}>
                    <td><strong>{r.label}</strong>{r.bills > 1 ? <div className="cell-muted">{r.bills} bills</div> : null}</td>
                    <td className="num">{r.billAmount === null ? <NotRecorded /> : <strong>{rs(r.billAmount)}</strong>}{r.notLinked ? <div className="cell-muted">{r.notLinked} not in Accounts yet</div> : null}</td>
                    <td>{dateOr(r.dueDate)}</td>
                    <td className="num">{money(r.paidAmount)}</td>
                    <td className="num">{money(r.outstanding)}</td>
                    <td><AirTag pay={{ status: r.status, tone: r.tone, overdue: r.overdue && r.status !== 'Overdue', note: null }} /></td>
                    <td className="abp-wrap-cell">{r.invoiceNos.length ? r.invoiceNos.map((x) => <div key={x} className="abp-nowrap">{x}</div>) : <NotRecorded />}</td>
                    <td className="abp-wrap-cell">{r.references.length ? r.references.map((x, i) => <div key={i} className="abp-nowrap">{x}</div>) : <NotRecorded />}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
    </>
  );
}
