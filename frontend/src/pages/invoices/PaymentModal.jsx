// "Record a payment" — a receipt against one CLIENT INVOICE (the rows passed in
// are client invoices, invoices/clientInvoice.js). A client invoice of ONE
// candidate goes through the existing POST /invoices/:id/payments; one of several
// candidates goes through POST /invoices/group/payments, which splits the money
// across its candidate rows in one transaction (idempotent by `key`).
// The single-invoice route, which applies the shared receipt rules
// (utils/accounts.js receiptProblem / invoiceAfterReceipt): it writes the
// InvoicePayment row, moves receivedAmount, paidDate and the status, and
// writes the audit log. Nothing is kept in the browser.
import { useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { money2, fmtD, todayIso } from './invFormat';

const PAY_METHODS = ['Bank Transfer', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash', 'Other'];

export default function PaymentModal({ rows, initialId, onClose, onSaved }) {
  // Only what can still take money: not cancelled, something still pending.
  const open = useMemo(() => rows
    .filter((r) => r.status !== 'Cancelled' && r.pending > 0.5)
    .sort((a, b) => String(a.invoiceDate || '').localeCompare(String(b.invoiceDate || ''))), [rows]);
  const first = open.find((r) => r.id === initialId) || open[0] || null;
  const [id, setId] = useState(first?.id || '');
  const inv = open.find((r) => r.id === id) || null;
  const [amount, setAmount] = useState(first ? first.pending.toFixed(2) : '');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('Bank Transfer');
  const [reference, setReference] = useState(first?.proofRef || ''); // a proof's UTR is carried over (invoicePaymentState action)
  const [notes, setNotes] = useState('');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  // One key per opening of this window: pressing Save twice, or retrying after a
  // dropped connection, can never record the same money twice.
  const payKey = useRef(`p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

  // A payment cannot predate its invoice — unless the invoice is dated ahead
  // (the ATS dates a joining's invoice joining + 6 days), where money that
  // arrives early is still money received.
  const invDay = inv?.invoiceDate ? String(inv.invoiceDate).slice(0, 10) : '';
  const minDate = invDay && invDay <= todayIso() ? invDay : undefined;

  const pick = (nextId) => {
    setId(nextId);
    const r = open.find((x) => x.id === nextId);
    if (r) setAmount(r.pending.toFixed(2));
    if (r && r.proofRef) setReference(r.proofRef);
    setErrs({});
  };

  const save = async () => {
    if (!inv) return;
    const amt = Number(amount);
    const e = {};
    if (!(amt > 0)) e.amount = 'Enter the amount received, more than ₹0.';
    else if (amt > inv.pending + 0.5) e.amount = `That is more than the ${money2(inv.pending)} still pending.`;
    if (!date) e.date = 'Enter the date the money arrived.';
    else if (date > todayIso()) e.date = 'A payment date cannot be in the future.';
    else if (minDate && date < minDate) e.date = `A payment cannot be before the invoice date (${fmtD(inv.invoiceDate)}).`;
    if (method !== 'Cash' && !/^[A-Za-z0-9/\-_. ]{4,40}$/.test(reference.trim())) {
      e.reference = 'Enter the UTR, cheque or UPI reference — at least 4 letters or digits.';
    }
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      const body = {
        amount: Math.min(amt, inv.pending), date, method, reference: reference.trim() || null, notes: notes.trim() || null,
      };
      let left;
      if (inv.members && inv.members.length > 1) {
        const res = await api.post('/invoices/group/payments', { ...body, invoiceIds: inv.ids, key: payKey.current });
        left = Math.max(0, Math.round((inv.pending - res.data.total) * 100) / 100);
      } else {
        const res = await api.post(`/invoices/${inv.id}/payments`, body);
        const after = res.data.invoice;
        left = Math.max(0, Number(after.total || 0) - Number(after.receivedAmount || 0));
      }
      onSaved(inv.id, `Recorded ${money2(amt)} against ${inv.invoiceNumber}${left <= 0.5 ? ' — invoice fully paid.' : ` — ${money2(left)} still pending.`}`);
    } catch (err) {
      setFail(err.response?.data?.error || 'The payment could not be saved.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record a payment"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-gold" disabled={!inv || busy} onClick={save}>{busy ? 'Saving…' : 'Save payment'}</button>
        </>
      )}
    >
      {open.length === 0 ? (
        <div className="small-muted">Every invoice in view is fully paid — there is nothing to record a payment against.</div>
      ) : (
        <>
          <label className="field"><span>Invoice</span>
            <Combo value={id} onChange={(e) => pick(e.target.value)}>
              {open.map((r) => (
                <option key={r.id} value={r.id}>{`${r.invoiceNumber} · ${r.client}${r.members && r.members.length > 1 ? ` · ${r.members.length} candidates` : ''} · ${money2(r.pending)} pending`}</option>
              ))}
            </Combo>
          </label>
          {inv && (
            <div className="inv-callout">
              Receivable after TDS <b>{money2(inv.receivable)}</b> · received so far <b>{money2(inv.received)}</b> · still pending <b>{money2(inv.pending)}</b>
              {inv.members && inv.members.length > 1 && (
                <div className="small-muted">This payment is for the whole invoice of {inv.members.length} candidates. It is shared between them in proportion to what each still owes.</div>
              )}
            </div>
          )}
          <div className="inv-form">
            <label className="field"><span>Amount received (₹)</span>
              <input type="number" min="1" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {errs.amount && <div className="inv-err">{errs.amount}</div>}
            </label>
            <label className="field"><span>Date received</span>
              <input type="date" value={date} max={todayIso()} min={minDate} onChange={(e) => setDate(e.target.value)} />
              {errs.date && <div className="inv-err">{errs.date}</div>}
            </label>
            <label className="field"><span>Mode</span>
              <Combo value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAY_METHODS.map((m) => <option key={m}>{m}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Reference number{method === 'Cash' ? ' (optional)' : ''}</span>
              <input value={reference} placeholder="UTR / cheque / UPI ref" autoComplete="off" onChange={(e) => setReference(e.target.value)} />
              {errs.reference && <div className="inv-err">{errs.reference}</div>}
            </label>
            <label className="field span2"><span>Note (optional)</span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          {fail && <div className="notice red"><span>{fail}</span></div>}
        </>
      )}
    </Modal>
  );
}
