import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile, useVendorMe } from './VendorShell.jsx';
import { ModuleBillsPanel } from './VendorMoney.jsx';
import VendorPager from './VendorPager.jsx';
import { inr, day, TONE } from './vendorFormat.js';

const PAY_TONE = { Paid: 'green', 'Partially Paid': 'yellow', Overdue: 'red', Unpaid: 'blue', 'Pending Verification': 'yellow', Rejected: 'red', Withdrawn: 'grey' };
const NA = <span className="vp-na">Not available</span>;
import { VendorIoBar } from './VendorIo.jsx';

// /vendor/invoices - Bills & Invoices, the second of the vendor's four modules. READ ONLY: the vendor's OWN invoices (Accounts bills and the invoices
// sent from the portal) with amount, paid, outstanding and status; search, filters, sorting and pages are done by the server, inside the
// vendor taken from the session. A detail window shows one invoice and opens its document through a signed, expiring link that the server
// checks belongs to this vendor. The one existing vendor action - sending an invoice - appears only when the company has switched it on for this login.
const SORTS = [['date', 'Date'], ['dueDate', 'Due date'], ['amount', 'Amount'], ['outstanding', 'Outstanding'], ['status', 'Status'], ['invoiceNo', 'Invoice number']];

export default function VendorInvoices() {
  return (
    <VendorShell title="Bills & Invoices" sub="Every bill and invoice of yours: GST, what has been paid and what is still to come.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const me = useVendorMe();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: params.get('q') || '', status: params.get('status') || '', category: '', period: '', from: '', to: '', sort: 'date', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState(f.q);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/records/invoices', { params: { q: qDeb || undefined, status: f.status || undefined, category: f.category || undefined, period: f.period || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your invoices.')));
  }, [qDeb, f.status, f.category, f.period, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => { setF((x) => ({ ...x, page: 1, ...patch })); if (patch.status !== undefined && params.get('status')) setParams({}, { replace: true }); };
  const s = data?.summary;
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.status || f.category || f.period || f.from || f.to);
  return (
    <>
      {me.canRaise && !me.preview && (
        <div style={{ marginBottom: 16 }}>
          <h3 className="vm-h3">Send an invoice</h3>
          <ModuleBillsPanel kind="invoice" orders={[]} presetOrderId="" />
        </div>
      )}
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Invoices</span><b>{s.total}</b></div>
          <div className="vp-tile"><span>Amount billed (you receive)</span><b>{inr(s.billed)}</b></div>
          <div className="vp-tile green"><span>Paid to you</span><b>{inr(s.received)}</b></div>
          <div className="vp-tile orange"><span>Outstanding</span><b>{inr(s.outstanding)}</b></div>
          <div className="vp-tile red"><span>Overdue</span><b>{s.overdue ? s.overdue.count : 0}</b><small>{inr(s.overdue ? s.overdue.amount : 0)}</small></div>
        </div>
      )}
      <VendorIoBar list="invoices" params={{ ...f, q: qDeb }} importKey="bills" onImported={load} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search invoice number or description" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <div className="vp-seg">
          {[['', 'All'], ['pending', 'Pending'], ['overdue', 'Overdue'], ['partial', 'Partially paid'], ['paid', 'Paid'], ['verification', 'Pending check'], ['rejected', 'Rejected']].map(([v, l]) => (
            <button type="button" key={v} className={`vp-chip${f.status === v ? ' on' : ''}`} onClick={() => set({ status: v })}>{l}</button>
          ))}
        </div>
        {data && data.categories && data.categories.length > 0 && (
          <select aria-label="Service or category" value={f.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="">Any service / category</option>
            {data.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {data && data.periods && data.periods.length > 0 && (
          <select aria-label="Billing period" value={f.period} onChange={(e) => set({ period: e.target.value })}>
            <option value="">Any billing period</option>
            {data.periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        )}
        <div className="vp-dates">
          <input type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })} aria-label="Change sort direction">{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setF({ q: '', status: '', category: '', period: '', from: '', to: '', sort: 'date', dir: 'desc', page: 1 }); setParams({}, { replace: true }); }}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">
          {data.all ? <><h3>No invoice matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No invoices yet</h3><p>When the company records an invoice of yours it shows here with its payment.</p></>}
        </div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Invoice no.</th><th>Date</th><th>Billing period</th><th>Due date</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Amount</th><th className="num">Paid</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="vp-row-click" onClick={() => setOpen(r.key)}>
                    <td><strong>{r.invoiceNo}</strong></td>
                    <td>{day(r.date)}</td>
                    <td>{r.period || NA}</td>
                    <td>{r.dueDate ? day(r.dueDate) : NA}</td>
                    <td className="num">{inr(r.taxable)}</td>
                    <td className="num">{r.gst ? inr(r.gst) : '-'}</td>
                    <td className="num">{inr(r.netPayable)}</td>
                    <td className="num">{inr(r.paidAmount)}</td>
                    <td className="num">{inr(r.outstanding)}</td>
                    <td><span className={`vp-tag vp-${PAY_TONE[r.payStatus] || TONE[r.status] || 'grey'}`} title={r.statusText}>{r.payStatus || r.statusText}</span>{r.overdue ? <small className="vp-why"> {r.daysOverdue} day{r.daysOverdue === 1 ? '' : 's'} late</small> : null}</td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.key); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      <p className="vp-invnote">&ldquo;Amount&rdquo; is what you receive: the invoice amount plus GST, minus any TDS the company deducts and pays to the government on your behalf.</p>
      {open && <InvoiceDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function InvoiceDetail({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { vendorApi.get(`/records/invoices/${encodeURIComponent(id)}`).then((r) => setD(r.data.invoice)).catch((e) => setError(vendorError(e, 'Could not open this invoice.'))); }, [id]);
  async function openDoc() {
    try { await openVendorFile({ kind: d.document.kind, id: d.document.id }); } catch (e) { setError(vendorError(e, 'Could not open the document.')); }
  }
  return (
    <Modal title={d ? `Invoice ${d.invoiceNo}` : 'Invoice'} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && (
        <div className="vp-detail">
          <dl>
            <dt>Status</dt><dd><span className={`vp-tag vp-${PAY_TONE[d.payStatus] || TONE[d.status] || 'grey'}`}>{d.payStatus || d.statusText}</span>{d.statusText && d.statusText !== d.payStatus ? <span className="cell-muted"> {d.statusText}</span> : null}{d.rejectionReason && <div className="vp-why">{d.rejectionReason}</div>}</dd>
            <dt>Invoice date</dt><dd>{d.date ? day(d.date) : NA}</dd>
            <dt>Billing period</dt><dd>{d.period || NA}</dd>
            <dt>Due date</dt><dd>{d.dueDate ? day(d.dueDate) : NA}</dd>
            <dt>Service / category</dt><dd>{d.category || NA}</dd>
            <dt>Vendor GSTIN</dt><dd>{d.gstin || NA}</dd>
            <dt>Taxable amount</dt><dd>{inr(d.taxable)}</dd>
            <dt>CGST</dt><dd>{d.cgst != null ? inr(d.cgst) : NA}</dd>
            <dt>SGST</dt><dd>{d.sgst != null ? inr(d.sgst) : NA}</dd>
            <dt>IGST</dt><dd>{d.igst != null ? inr(d.igst) : NA}</dd>
            <dt>Total GST</dt><dd>{d.gst ? inr(d.gst) : NA}{d.gstRatePct != null ? ` (${d.gstRatePct}%)` : ''}</dd>
            {d.hsnSac && (<><dt>HSN / SAC</dt><dd>{d.hsnSac}</dd></>)}
            {d.tds > 0 && (<><dt>TDS deducted</dt><dd>{inr(d.tds)}</dd></>)}
            <dt>You receive</dt><dd><strong>{inr(d.netPayable)}</strong></dd>
            <dt>Paid</dt><dd>{inr(d.paidAmount)}{d.paymentDate ? ` on ${day(d.paymentDate)}` : ''}{d.paymentMode ? ` (${d.paymentMode})` : ''}{d.paymentRef || (d.bankRef && d.bankRef.reference) ? `, reference ${d.paymentRef || d.bankRef.reference}` : ''}</dd>
            <dt>Outstanding</dt><dd>{inr(d.outstanding)}</dd>
            {d.description && (<><dt>Description</dt><dd>{d.description}</dd></>)}
            <dt>Document</dt><dd>{d.document ? <button type="button" className="btn btn-sm" onClick={openDoc}>View / download</button> : NA}</dd>
          </dl>
        </div>
      )}
    </Modal>
  );
}
