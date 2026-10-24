import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Section from './Section.jsx';
import '../vendor/vendorPortal.css';
import './VendorBillsReview.css';
import Combo from '../../components/Combo.jsx';

// ---------------------------------------------------------------------------
// OFFICE & ACCOUNTS -> "VENDOR INVOICES AND MONTHLY BILLS" (2026-10-14).
// What vendors without an asset (ID cards, telecom, office rent, other) send through the Vendor Portal: invoices,
// monthly bills (with the charge per number) and receipts. Submitted -> Approved -> Paid, or Rejected with a reason the
// vendor sees. Inserted in pages/Office.jsx next to "Bills from vendors". Server: routes/vendorModuleBills.js.
// Hidden until the first one arrives.
// ---------------------------------------------------------------------------
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s); return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const TONE = { Submitted: 'yellow', Approved: 'blue', Paid: 'green', Rejected: 'red' };
const KIND = { invoice: 'Invoice', monthly_bill: 'Monthly bill', receipt: 'Receipt' };

async function download(url, name) {
  const res = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name || 'file'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export default function VendorModuleBillsReview({ onChanged }) {
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('Submitted');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [rej, setRej] = useState(null);
  const [pay, setPay] = useState(null);
  const [view, setView] = useState(null);
  const load = useCallback(() => {
    api.get('/vendor-module-bills', { params: { status: status || undefined } })
      .then((r) => { setD(r.data); setErr(''); })
      .catch((e) => { if (![403, 503].includes(e.response?.status)) setErr(errText(e, 'Could not load the vendor invoices.')); });
  }, [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(''), 4000); return () => clearTimeout(t); }, [msg]);
  if (!d) return null;
  const total = Object.values(d.counts || {}).reduce((s, n) => s + n, 0);
  if (!total) return null;
  const waiting = d.counts.Submitted || 0;

  async function act(b, what, body) {
    setErr('');
    try { const r = await api.post(`/vendor-module-bills/${b.id}/${what}`, body || {}); setMsg(r.data.message); setRej(null); setPay(null); setView(null); load(); if (onChanged) onChanged(); } catch (e) { setErr(errText(e, 'Could not do that.')); }
  }
  return (
    <Section
      id="vendormodulebills" title="Vendor invoices and monthly bills"
      info="Invoices, monthly bills and receipts sent from the Vendor Portal by vendors that have no asset (ID cards, telecom, office rent, others). Approve, then mark Paid with the payment reference. Reject sends your reason back to the vendor."
      sub={waiting ? <><span className="vb-badge">{waiting}</span> waiting for your check</> : 'Nothing waiting'}
    >
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
      <div className="vb-bar">
        <div className="vb-status">
          {['Submitted', 'Approved', 'Paid', 'Rejected'].map((k) => (
            <button type="button" key={k} className={`vb-chip vb-${TONE[k]}${status === k ? ' on' : ''}`} onClick={() => setStatus(status === k ? '' : k)}>{k} <b>{d.counts[k] || 0}</b></button>
          ))}
        </div>
      </div>
      {!d.rows.length ? <div className="vp-none">Nothing in this group.</div> : (
        <div className="tbl-wrap">
          <table className="vb-table">
            <thead><tr><th>Vendor</th><th>What</th><th>Number</th><th>Date</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
            <tbody>
              {d.rows.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.vendorName}</strong><div className="cell-muted">{b.billCode}</div></td>
                  <td>{KIND[b.kind] || b.kind}{b.kind === 'monthly_bill' && b.periodLabel ? ` · ${b.periodLabel}` : ''}{b.orderCode && <div className="cell-muted">for order {b.orderCode}</div>}</td>
                  <td>{b.billNumber || '—'}</td>
                  <td>{day(b.kind === 'monthly_bill' ? b.dueDate : b.billDate)}{b.kind === 'monthly_bill' && <div className="cell-muted">due date</div>}</td>
                  <td className="num"><strong>{inr(b.total)}</strong></td>
                  <td><span className={`vp-tag vp-${TONE[b.status] || 'grey'}`}>{b.statusText}</span>{b.status === 'Paid' && <div className="cell-muted">{day(b.paidOn)} · {b.paymentRef}</div>}</td>
                  <td className="vb-nowrap">
                    <button type="button" className="btn btn-sm" onClick={() => setView(b)}>Open</button>
                    {b.status === 'Submitted' && <button type="button" className="btn btn-sm btn-primary" onClick={() => act(b, 'approve')}>Approve</button>}
                    {b.status === 'Approved' && b.kind !== 'receipt' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setPay({ b, paidOn: new Date().toISOString().slice(0, 10), amount: String(b.total), reference: '', mode: 'Bank Transfer' })}>Mark paid</button>}
                    {['Submitted', 'Approved'].includes(b.status) && <button type="button" className="btn btn-sm btn-danger" onClick={() => setRej({ b, reason: '' })}>Reject</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view && (
        <Modal title={`${KIND[view.kind]} ${view.billCode}`} size="wide" onClose={() => setView(null)} footer={<button type="button" className="btn" onClick={() => setView(null)}>Close</button>}>
          <dl className="vp-dl">
            <dt>Vendor</dt><dd>{view.vendorName}</dd><dt>Number</dt><dd>{view.billNumber || '—'}</dd>
            {view.period && <><dt>Month</dt><dd>{view.periodLabel}</dd></>}
            <dt>Date</dt><dd>{day(view.billDate)}</dd>{view.dueDate && <><dt>Due date</dt><dd>{day(view.dueDate)}</dd></>}
            {view.quantity != null && <><dt>Quantity × rate</dt><dd>{view.quantity} × {inr(view.rate)}</dd></>}
            <dt>Amount</dt><dd>{inr(view.amount)}</dd><dt>GST</dt><dd>{inr(view.gst)}</dd><dt>Total</dt><dd><strong>{inr(view.total)}</strong></dd>
            {view.orderCode && <><dt>Order</dt><dd>{view.orderCode}</dd></>}
            {view.remarks && <><dt>Vendor remarks</dt><dd>{view.remarks}</dd></>}
            {view.reviewedByName && <><dt>Checked by</dt><dd>{view.reviewedByName}{view.reviewRemarks ? ` · ${view.reviewRemarks}` : ''}</dd></>}
          </dl>
          {view.lines?.length > 0 && (
            <>
              <h4 style={{ margin: '10px 0 4px' }}>Charge per number</h4>
              <div className="tbl-wrap"><table><thead><tr><th>Number</th><th className="num">Amount</th></tr></thead><tbody>{view.lines.map((l, i) => <tr key={i}><td>{l.number}{l.description ? ` · ${l.description}` : ''}</td><td className="num">{inr(l.amount)}</td></tr>)}</tbody></table></div>
            </>
          )}
          {view.document && <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => download(`/vendor-module-bills/${view.id}/document`, view.document.name).catch((e) => setErr(errText(e, 'Could not open the file.')))}>Open the file ({view.document.name})</button></div>}
        </Modal>
      )}
      {rej && (
        <Modal title={`Reject ${rej.b.billCode}`} onClose={() => setRej(null)} footer={<><button type="button" className="btn" onClick={() => setRej(null)}>Cancel</button><button type="button" className="btn btn-danger" onClick={() => act(rej.b, 'reject', { reason: rej.reason })}>Reject</button></>}>
          <label htmlFor="mbRejR">Why? The vendor will see this.</label>
          <textarea id="mbRejR" rows={3} value={rej.reason} onChange={(e) => setRej({ ...rej, reason: e.target.value })} />
        </Modal>
      )}
      {pay && (
        <Modal title={`Mark ${pay.b.billCode} paid`} onClose={() => setPay(null)} footer={<><button type="button" className="btn" onClick={() => setPay(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => act(pay.b, 'paid', { paidOn: pay.paidOn, amount: pay.amount, reference: pay.reference, mode: pay.mode })}>Mark paid</button></>}>
          <div className="vp-form">
            <label htmlFor="mbPDate">Paid on</label><input id="mbPDate" type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
            <label htmlFor="mbPAmt">Amount paid (₹)</label><input id="mbPAmt" value={pay.amount} inputMode="decimal" onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <label htmlFor="mbPRef">Payment reference no.</label><input id="mbPRef" value={pay.reference} maxLength={80} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="UTR / cheque no." />
            <label htmlFor="mbPMode">How</label>
            <Combo id="mbPMode" value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })}>{(d.modes || []).map((m) => <option key={m} value={m}>{m}</option>)}</Combo>
          </div>
        </Modal>
      )}
    </Section>
  );
}
