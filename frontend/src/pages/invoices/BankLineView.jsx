// The real bank statement line behind one payment, opened in place ("View Transaction").
// GET /invoices/:id/bank-line/:txnId - only a line that one of THIS invoice's payments points at.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { money2, fmtD } from './invFormat';
import { bankLineMessage } from '../bank/bankLineMessage';
import './proof.css';

export default function BankLineView({ invoiceId, txnId, canBank = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setD(null); setErr('');
    api.get(`/invoices/${invoiceId}/bank-line/${txnId}`)
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'This bank line could not be opened.'); });
    return () => { live = false; };
  }, [invoiceId, txnId]);

  if (err) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Loading the bank line…</div>;
  return (
    <div className="pf-grid" role="region" aria-label="Bank transaction">
      <div><i>Bank transaction date</i><b>{fmtD(d.transactionDate)}</b></div>
      <div><i>Value date</i><b>{d.valueDate ? fmtD(d.valueDate) : '—'}</b></div>
      <div className="pf-wide"><i>Narration</i><b>{d.narration}</b></div>
      <div><i>{d.type === 'Credit' ? 'Credit (money in)' : 'Debit (money out)'}</i><b>{money2(d.credit != null ? d.credit : d.debit)}</b></div>
      <div><i>Reference / UTR</i><b>{d.reference || '—'}</b></div>
      <div><i>Bank</i><b>{d.bank || '—'}</b></div>
      <div><i>Matched client / vendor</i><b>{d.clientOrVendor || '—'}</b></div>
      <div><i>Reconciliation status</i><b>{d.state}</b></div>
      <div><i>Applied to invoice {d.invoice && d.invoice.invoiceNumber}</i><b>{money2(d.appliedHere)}</b></div>
      <div><i>Difference (received minus allocated)</i><b>{d.difference == null ? '—' : money2(d.difference)}</b></div>
      {d.otherInvoices && d.otherInvoices.count > 0 && (
        <div className="pf-wide small-muted">The same bank line also paid {d.otherInvoices.count} other invoice(s) ({money2(d.otherInvoices.amount)}).</div>
      )}
      {d.import && <div className="pf-wide small-muted">From statement file {d.import.file}, imported {fmtD(d.import.importedOn)}.</div>}
      {/* The same sentence the Bank statements window uses (bank/bankLineMessage.js): this line is the proof of the receipt. */}
      {(() => {
        const msg = bankLineMessage({
          direction: d.type === 'Credit' ? 'in' : 'out',
          kind: d.type === 'Credit' ? 'invoice_receipt' : 'other',
          unallocated: d.type === 'Credit' ? d.unallocated : 0,
        });
        return <div className={`pf-wide pf-note ${msg.tone}`}><b>{msg.title}</b> {msg.text}</div>;
      })()}
      {canBank && <div className="pf-wide"><Link className="link-btn" to="/bank">Open in Bank &amp; Reconciliation →</Link></div>}
    </div>
  );
}
