import { useCallback, useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell, { openVendorFile } from './VendorShell.jsx';

// /vendor/invoices - the vendor's OWN bills and what happened to the money:
// billed, paid, still to pay, TDS deducted, net. Nothing else - the server
// returns only this vendor's rows and only these fields (never journals,
// ledgers, approver names or other vendors).
const inr = (n) => (n == null || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const two = (n) => String(n).padStart(2, '0');
const day = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
};
const TONE = { PAID: 'green', PENDING_PAYMENT: 'blue', PENDING_REVIEW: 'yellow', VERIFIED: 'yellow', REJECTED: 'red', WITHDRAWN: 'grey' };

export default function VendorInvoices() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ status: '', q: '' });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/invoices', { params: { status: f.status || undefined, q: qDeb || undefined } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your bills.')));
  }, [f.status, qDeb]);
  useEffect(() => { load(); }, [load]);

  async function openBill(r) {
    try { await openVendorFile({ kind: 'bill', id: r.submissionId }); } catch (e) { setError(vendorError(e, 'Could not open the file.')); }
  }
  const s = data?.summary;
  const rows = data?.rows || [];
  return (
    <VendorShell title="Your bills and payments" sub="Every bill of yours, what has been paid, what is still to come, and the TDS we deducted.">
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Billed (after TDS)</span><b>{inr(s.invoiced)}</b></div>
          <div className="vp-tile green"><span>Paid to you</span><b>{inr(s.paid)}</b></div>
          <div className="vp-tile orange"><span>Still to be paid</span><b>{inr(s.outstanding)}</b></div>
          <div className="vp-tile"><span>TDS deducted</span><b>{inr(s.tds)}</b></div>
        </div>
      )}
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search bill number" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search" />
        <div className="vp-seg">
          {[['', 'All'], ['unpaid', 'Still to be paid'], ['paid', 'Paid']].map(([v, l]) => (
            <button type="button" key={v} className={`vp-chip${f.status === v ? ' on' : ''}`} onClick={() => setF({ ...f, status: v })}>{l}</button>
          ))}
        </div>
      </div>
      {!data ? <div className="empty-mini">Loading…</div> : !rows.length ? (
        <div className="vp-empty">
          {data.total ? <><h3>No bill matches</h3><p>Clear the search to see all {data.total}.</p></>
            : <><h3>No bills yet</h3><p>When the company records a bill of yours, or you send one from “Your assets”, it shows here with its payment.</p></>}
        </div>
      ) : (
        <div className="tbl-wrap vp-table">
          <table>
            <thead>
              <tr>
                <th>Bill no.</th><th>Bill date</th><th className="num">Amount</th><th className="num">GST</th><th className="num">TDS deducted</th>
                <th className="num">You receive</th><th>Status</th><th>Paid on</th><th className="num">Still to be paid</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><strong>{r.billNumber || r.billCode || '—'}</strong>{r.assetCode && <div className="cell-muted">{r.assetCode}</div>}</td>
                  <td>{day(r.billDate)}</td>
                  <td className="num">{inr(r.amount)}</td>
                  <td className="num">{inr(r.gst)}</td>
                  <td className="num">{inr(r.tds)}</td>
                  <td className="num"><strong>{inr(r.netPayable)}</strong></td>
                  <td>
                    <span className={`vp-tag vp-${TONE[r.status] || 'grey'}`}>{r.statusText}</span>
                    {r.rejectionReason && <div className="vp-why">{r.rejectionReason}</div>}
                  </td>
                  <td>{day(r.paymentDate)}{r.paymentMode && <div className="cell-muted">{r.paymentMode}</div>}</td>
                  <td className="num">{inr(r.outstanding)}</td>
                  <td>{r.hasDocument && r.submissionId && <button type="button" className="btn btn-sm" onClick={() => openBill(r)}>Open bill</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="vp-invnote">“You receive” is the bill amount plus GST, minus the TDS the company deducts and pays to the government on your behalf.</p>
    </VendorShell>
  );
}
