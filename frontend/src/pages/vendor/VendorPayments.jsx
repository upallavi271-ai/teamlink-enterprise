import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { inr, day } from './vendorFormat.js';
import { VendorIoBar } from './VendorIo.jsx';

// /vendor/payments - Payments & Outstanding, the third of the vendor's four modules. READ ONLY: what the company has paid this vendor (date,
// reference, the invoice it was for, amount, method, status) and what is still to be paid. Each payment is the paid part of ONE of the vendor's
// invoices (see Bills & Invoices), so a payment is never counted twice and the outstanding balance is the same figure the Dashboard shows.
// A vendor cannot record or confirm a payment here: the company's Accounts records are the only source. Nothing about the company's bank is shown
// beyond the reference of the line that paid this vendor.
const SORTS = [['date', 'Date'], ['amount', 'Amount'], ['invoiceNo', 'Invoice'], ['status', 'Status']];
const PAY_TONE = { Paid: 'green', 'Partially Paid': 'yellow', Overdue: 'red', Unpaid: 'blue', 'Pending Verification': 'yellow' };

export default function VendorPayments() {
  return (
    <VendorShell title="Payments & Outstanding" sub="What the company has paid you, and what is still to be paid.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', method: '', from: '', to: '', sort: 'date', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/records/payments', { params: { q: qDeb || undefined, method: f.method || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your payments.')));
  }, [qDeb, f.method, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const s = data?.summary;
  const filtered = !!(f.q || f.method || f.from || f.to);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile green"><span>Total amount paid</span><b>{inr(s.paid)}</b></div>
          <div className="vp-tile orange"><span>Total outstanding</span><b>{inr(s.outstanding)}</b></div>
          <div className="vp-tile"><span>Pending payments</span><b>{s.pending.count}</b><small>{inr(s.pending.amount)}</small></div>
          <div className="vp-tile red"><span>Overdue amount</span><b>{inr(s.overdue.amount)}</b><small>{s.overdue.count} invoice{s.overdue.count === 1 ? '' : 's'}</small></div>
          <div className="vp-tile"><span>Partially paid invoices</span><b>{s.partial.count}</b></div>
        </div>
      )}
      <div className="vp-actions-row">
        <button type="button" className="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      {data && data.outstanding && data.outstanding.length > 0 && (
        <section className="vp-section" aria-label="Outstanding invoices">
          <h3 className="vm-h3">Outstanding invoices</h3>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Invoice</th><th>Due date</th><th className="num">Invoice amount</th><th className="num">Paid so far</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {data.outstanding.map((r) => (
                  <tr key={r.key}>
                    <td><Link to={`/vendor/invoices?q=${encodeURIComponent(r.invoiceNo)}`}><strong>{r.invoiceNo}</strong></Link></td>
                    <td>{r.dueDate ? day(r.dueDate) : <span className="vp-na">Not available</span>}{r.overdue ? <small className="vp-why"> {r.daysOverdue} day{r.daysOverdue === 1 ? '' : 's'} late</small> : null}</td>
                    <td className="num">{inr(r.total)}</td>
                    <td className="num">{inr(r.paid)}</td>
                    <td className="num"><strong>{inr(r.outstanding)}</strong></td>
                    <td><span className={`vp-tag vp-${PAY_TONE[r.payStatus] || 'grey'}`}>{r.payStatus}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="vp-section" aria-label="Payment history">
        <h3 className="vm-h3">Payment history</h3>
        <VendorIoBar list="payments" params={{ ...f, q: qDeb }} />
        <div className="vp-filters" role="search">
          <input className="vp-search" type="search" placeholder="Search reference or invoice number" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
          {data && data.methods.length > 0 && (
            <select aria-label="Payment method" value={f.method} onChange={(e) => set({ method: e.target.value })}>
              <option value="">Any method</option>
              {data.methods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <div className="vp-dates">
            <input type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <span className="vp-to">to</span>
            <input type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </div>
          <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
          <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
          {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', method: '', from: '', to: '', sort: 'date', dir: 'desc', page: 1 })}>Clear</button>}
        </div>
        {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
          <div className="vp-empty">
            {data.all ? <><h3>No payment matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No payments yet</h3><p>When the company pays an invoice of yours it shows here with the date and reference.</p></>}
          </div>
        ) : (
          <>
            <div className="tbl-wrap vp-scroll">
              <table>
                <thead><tr><th>Date</th><th>Reference</th><th>Invoice</th><th className="num">Paid</th><th className="num">Still to pay on invoice</th><th>Method</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="vp-row-click" onClick={() => setOpen(r.key)}>
                      <td>{day(r.date)}</td>
                      <td>{r.reference || (r.bankRef && r.bankRef.reference) || <span className="vp-na">Not available</span>}</td>
                      <td><strong>{r.invoiceNo}</strong></td>
                      <td className="num"><strong>{inr(r.amount)}</strong></td>
                      <td className="num">{inr(r.remaining)}</td>
                      <td>{r.method || <span className="vp-na">Not available</span>}</td>
                      <td><span className={`vp-tag vp-${PAY_TONE[r.status] || 'grey'}`}>{r.status}</span></td>
                      <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.key); }}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
          </>
        )}
      </section>

      {data && data.documents && data.documents.length > 0 && (
        <section className="vp-section" aria-label="Payment documents">
          <h3 className="vm-h3">Payment advices, TDS certificates and statements</h3>
          <DocList docs={data.documents} onError={setError} />
        </section>
      )}
      {open && <PaymentDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function DocList({ docs, onError }) {
  async function openDoc(d) {
    try { await openVendorFile({ kind: d.document.kind, id: d.document.id }); } catch (e) { onError(vendorError(e, 'Could not open the document.')); }
  }
  return (
    <ul className="vp-list-simple">
      {docs.map((d) => (
        <li key={d.id}>
          <strong>{d.title}</strong>
          <span className="vp-tag vp-grey">{d.type}</span>
          <span className="cell-muted">{d.sharedOn ? `Shared ${day(d.sharedOn)}` : ''}</span>
          {d.note && <span className="cell-muted">{d.note}</span>}
          <button type="button" className="btn btn-sm" onClick={() => openDoc(d)}>Open</button>
        </li>
      ))}
    </ul>
  );
}

function PaymentDetail({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { vendorApi.get(`/records/payments/${encodeURIComponent(id)}`).then((r) => setD(r.data.payment)).catch((e) => setError(vendorError(e, 'Could not open this payment.'))); }, [id]);
  const na = <span className="vp-na">Not available</span>;
  return (
    <Modal title="Payment" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red"><span>{error}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && (
        <div className="vp-detail">
          <dl>
            <dt>Amount paid</dt><dd><strong>{inr(d.amount)}</strong></dd>
            <dt>Payment date</dt><dd>{d.date ? day(d.date) : na}</dd>
            <dt>Reference</dt><dd>{d.reference || (d.bankRef && d.bankRef.reference) || na}</dd>
            <dt>Method</dt><dd>{d.method || na}</dd>
            <dt>For invoice</dt><dd><Link to={`/vendor/invoices?q=${encodeURIComponent(d.invoiceNo)}`} onClick={onClose}>{d.invoiceNo}</Link>{d.invoiceDate ? ` (${day(d.invoiceDate)})` : ''}</dd>
            <dt>Invoice amount</dt><dd>{inr(d.invoiceTotal)}</dd>
            <dt>Allocated to this invoice</dt><dd>{inr(d.allocated)}</dd>
            <dt>Still to pay on the invoice</dt><dd>{inr(d.remaining)}</dd>
            <dt>Status</dt><dd>{d.status}</dd>
            {d.bankRef && (<><dt>Bank statement line</dt><dd>{[d.bankRef.reference, d.bankRef.date ? day(d.bankRef.date) : null].filter(Boolean).join(' · ') || 'Linked'}</dd></>)}
            {d.description && (<><dt>Note</dt><dd>{d.description}</dd></>)}
          </dl>
        </div>
      )}
    </Modal>
  );
}
