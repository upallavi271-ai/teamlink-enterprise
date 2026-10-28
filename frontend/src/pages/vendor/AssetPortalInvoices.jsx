import { useCallback, useEffect, useState } from 'react';
import VendorBankPayments from './VendorBankPayments.jsx'; // payments from the bank statement (founder 2026-10-28)
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell, { openVendorFile } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { day } from './vendorFormat.js';
import { rs, PayTag, PayLine } from './assetPortalCommon.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import { OrdersBody } from './AssetPortalOrders.jsx';
import { MyBills, UploadBillButton } from './AssetPortalBillUploads.jsx'; // "My bills": the repair bills this vendor uploaded as photos / PDFs
import './vendorModules.css';
import './billUploads.css';

// /vendor/asset-portal/invoices - Invoices: every invoice of this vendor and where its payment stands. An invoice is sent to Accounts from the
// repair itself (Repairs > Open > Send the invoice to Accounts). The payment status is DERIVED by the server from Accounts' own records and the
// bank statement: Pending, Paid (the bank payment is matched), Partially Paid, Overdue, Reversed. You cannot change it, and no bank detail is shown.
export default function AssetPortalInvoices() {
  return (
    <VendorShell title="Invoices & Payments" sub="Your invoices and bills, whether Accounts has paid them, and the orders the company gave you.">
      <InvoiceTabs />
    </VendorShell>
  );
}

// Two views of the same page: the invoices, and "My bills" (photos / PDFs of bills you uploaded, with where each one is).
function InvoiceTabs() {
  // INVOICES & PAYMENTS (one of the four modules, 27 Oct 2026): Invoices | My bills | Orders (the old /orders address opens Orders)
  const [tab, setTab] = useState(() => { const t = new URLSearchParams(window.location.search).get('tab'); return t === 'bills' || t === 'orders' || t === 'payments' ? t : 'invoices'; });
  const [unseen, setUnseen] = useState(0);
  const [stamp, setStamp] = useState(0);
  const loadSummary = useCallback(() => { vendorApi.get('/asset-portal/bill-uploads/summary').then((r) => setUnseen(r.data.unseen || 0)).catch(() => {}); }, []);
  useEffect(() => { loadSummary(); }, [loadSummary, tab]);
  const pick = (t) => { setTab(t); try { window.history.replaceState(null, '', t === 'invoices' ? window.location.pathname : `?tab=${t}`); } catch { /* ignore */ } };
  return (
    <>
      <div className="bu-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'invoices'} className={tab === 'invoices' ? 'on' : ''} onClick={() => pick('invoices')}>Invoices</button>
        <button type="button" role="tab" aria-selected={tab === 'bills'} className={tab === 'bills' ? 'on' : ''} onClick={() => pick('bills')}>My bills{unseen > 0 ? <span className="bu-new">{unseen} new</span> : null}</button>
        <button type="button" role="tab" aria-selected={tab === 'payments'} className={tab === 'payments' ? 'on' : ''} onClick={() => pick('payments')}>Bank payments</button>
        <button type="button" role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'on' : ''} onClick={() => pick('orders')}>Orders</button>
        <span style={{ marginLeft: 'auto' }}><UploadBillButton label="Import bills (photo or PDF)" onDone={() => { pick('bills'); setStamp((x) => x + 1); loadSummary(); }} /></span>
      </div>
      {tab === 'bills' ? <MyBills key={stamp} onChanged={loadSummary} showUpload={false} /> : tab === 'orders' ? <OrdersBody /> : tab === 'payments' ? <VendorBankPayments /> : <Body />}
    </>
  );
}

function Body() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', payment: '', from: '', to: '', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/invoices', { params: { q: qDeb || undefined, payment: f.payment || undefined, from: f.from || undefined, to: f.to || undefined, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the invoices.')));
  }, [qDeb, f.payment, f.from, f.to, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.payment || f.from || f.to);
  const s = data?.summary;
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Invoices</span><b>{s.count}</b></div>
          <div className="vp-tile green"><span>Paid to you</span><b>{rs(s.paidTotal)}</b></div>
          <div className="vp-tile orange"><span>Still to be paid</span><b>{rs(s.outstanding)}</b></div>
          <div className="vp-tile"><span>Overdue</span><b>{s.overdue}</b></div>
        </div>
      )}
      <VendorIoBar list="invoices" params={{ ...f, q: qDeb }} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search invoice number, repair or asset" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <select aria-label="Payment status" value={f.payment} onChange={(e) => set({ payment: e.target.value })}>
          <option value="">Any payment status</option>
          {(data?.facets.payment || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
        </select>
        <div className="vp-dates">
          <input type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', payment: '', from: '', to: '', dir: 'desc', page: 1 })}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">{data.all ? <><h3>No invoice matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No invoices yet</h3><p>When you add a final cost and an invoice to a repair, it shows here.</p></>}</div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Invoice number</th><th>Repair</th><th>Asset</th><th>Invoice date</th><th className="num">Total</th><th>Payment</th><th>Paid / balance</th><th>File</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.key}>
                  <td><strong>{r.invoiceNo || '-'}</strong>{r.billCode ? <div className="cell-muted">{r.billCode}</div> : null}</td>
                  <td>{r.repairId ? <Link to={`/vendor/asset-portal/repairs?open=${encodeURIComponent(r.repairId)}`}>{r.repairNo}</Link> : '-'}</td>
                  <td>{r.assetCode ? `${r.assetCode} · ${r.assetName || ''}` : '-'}</td>
                  <td>{day(r.billDate)}</td>
                  <td className="num"><strong>{rs(r.total)}</strong></td>
                  <td><PayTag pay={r.payment} />{r.rejectionReason ? <div className="vp-why">{r.rejectionReason}</div> : null}</td>
                  <td><PayLine pay={r.payment} /></td>
                  <td>{r.fileRepairId
                    ? <button type="button" className="btn btn-sm" onClick={() => openVendorFile({ kind: 'repair-invoice', id: r.fileRepairId }).catch((e) => setError(vendorError(e, 'Could not open the file.')))}>Open file</button>
                    : (r.repairId && r.payment.status === 'Not sent to Accounts' ? <Link to={`/vendor/asset-portal/repairs?open=${encodeURIComponent(r.repairId)}`}>Send it</Link> : '-')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
    </>
  );
}
