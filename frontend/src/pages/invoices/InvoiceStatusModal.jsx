// "CHANGE STATUS" for one invoice (founder 2026-10-31: "invoices ayina status change chese option evvu, status change chesthe proof kavali,
// proof attach cheyakapoyina ok, status change cheyochu").
// An invoice's status follows the money received, so each choice is the EXISTING money action, never a bare label:
//   Paid            the rest is received in full      -> PATCH /invoices/:id/pay      (a receipt for the outstanding amount)
//   Partially paid  part of it is received            -> POST  /invoices/:id/payments (a receipt for that amount)
//   Cancelled       only while nothing is received     -> PATCH /invoices/:id/cancel
//   Pending again   is not a button: remove the receipt(s) in Payment history (a bank-matched one is undone on the bank screen)
// The proof (client's payment screenshot / bank advice, or the UTR) is ASKED for, never forced: it is attached first
// (POST /dashboard/accounts/control/proof/invoice/:id); without it the status still changes and the invoice shows "proof missing".
import { useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { money2 } from './invFormat';

const METHODS = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Other'];
const TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const EXT = /\.(pdf|png|jpe?g|webp)$/i;
const todayIso = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export default function InvoiceStatusModal({ invoice, pending, received, onClose, onDone }) {
  const cancelled = invoice.status === 'Cancelled';
  const options = [
    ['Paid', 'Paid', pending > 0.5 && !cancelled, `The client paid the rest: ${money2(pending)}.`, cancelled ? 'This invoice is cancelled.' : 'Nothing is left to collect.'],
    ['Partial', 'Partially paid', pending > 0.5 && !cancelled, 'The client paid part of it. Type the amount that came in.', cancelled ? 'This invoice is cancelled.' : 'Nothing is left to collect.'],
    ['Cancelled', 'Cancelled', !cancelled && received <= 0, 'The invoice is not valid any more (nothing was received).', cancelled ? 'Already cancelled.' : 'Money has been received, so it cannot be cancelled. Remove the payments first.'],
  ];
  const first = options.find((o) => o[2]);
  const [to, setTo] = useState(first ? first[0] : '');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('Bank Transfer');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pick = (f) => {
    setErr('');
    if (!f) { setFile(null); return; }
    if (!TYPES.includes(f.type) && !EXT.test(f.name)) { setErr(`${f.name} is not a PDF or image file.`); return; }
    if (f.size > 5 * 1024 * 1024) { setErr(`${f.name} is larger than 5 MB.`); return; }
    setFile(f);
  };

  const save = async () => {
    if (busy || !to) return;
    const amt = Math.round(Number(amount) * 100) / 100;
    if (to === 'Partial' && !(amt > 0 && amt < pending - 0.004)) { setErr(`Type the amount received: more than 0 and less than ${money2(pending)} (for the full amount choose Paid).`); return; }
    setBusy(true); setErr('');
    try {
      // the proof first (a file, or only the UTR): if it cannot be stored, the status is not changed
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        if (reference.trim()) fd.append('reference', reference.trim());
        await api.post(`/dashboard/accounts/control/proof/invoice/${invoice.id}`, fd);
      } else if (reference.trim() && to !== 'Cancelled') {
        await api.post(`/dashboard/accounts/control/proof/invoice/${invoice.id}`, { reference: reference.trim() });
      }
      if (to === 'Paid') await api.patch(`/invoices/${invoice.id}/pay`, { date, method });
      else if (to === 'Partial') await api.post(`/invoices/${invoice.id}/payments`, { amount: amt, date, method, reference: reference.trim() || undefined });
      else await api.patch(`/invoices/${invoice.id}/cancel`);
      const word = to === 'Partial' ? 'Partially paid' : to;
      onDone(`Status changed to ${word}${file ? `, proof ${file.name} attached` : (to !== 'Cancelled' && !invoice.proofHasFile ? ' - no proof attached yet' : '')}.`);
    } catch (e) {
      setErr(e.response?.data?.error || 'The status could not be changed.');
      setBusy(false);
    }
  };

  const noProof = to && to !== 'Cancelled' && !file && !invoice.proofHasFile;
  return (
    <Modal
      title={`Change status · ${invoice.invoiceNumber || 'invoice'}`}
      onClose={() => !busy && onClose()}
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !to} onClick={save}>
            {busy ? 'Saving…' : (noProof ? 'Change status without proof' : 'Change status')}
          </button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 10 }}>
        Now: <b>{invoice.status}</b> · received {money2(received)} · still to collect {money2(pending)}
      </div>
      <div className="field">
        <span>New status</span>
        {options.map(([k, label, ok, hint, why]) => (
          <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0', cursor: ok ? 'pointer' : 'not-allowed', opacity: ok ? 1 : 0.55 }}>
            <input type="radio" name="inv-status" disabled={!ok} checked={to === k} onChange={() => { setTo(k); setErr(''); }} />
            <span><b>{label}</b><div className="small-muted">{ok ? hint : why}</div></span>
          </label>
        ))}
        {received > 0 && <div className="small-muted" style={{ marginTop: 4 }}>To make it Pending again, remove the payment(s) in Payment history (a bank-matched one is undone on Bank &amp; Reconciliation).</div>}
      </div>
      {(to === 'Paid' || to === 'Partial') && (
        <>
          <div className="grid-2">
            {to === 'Partial' && <label className="field"><span>Amount received (₹)</span><input type="number" step="0.01" min="0" max={pending} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={pending.toFixed(2)} /></label>}
            <label className="field"><span>Payment date</span><input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="field"><span>Payment method</span><Combo value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</Combo></label>
            <label className="field"><span>Transaction / UTR reference</span><input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></label>
          </div>
          <div className="field">
            <span>Proof of payment (PDF or image, up to 5 MB)</span>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" onChange={(e) => pick(e.target.files && e.target.files[0])} />
            {invoice.proofHasFile && !file && <div className="small-muted">A proof is already attached{invoice.proofName ? ` (${invoice.proofName})` : ''}. Choose a file only to replace it.</div>}
          </div>
          {noProof && (
            <div className="notice amber" style={{ marginTop: 6 }}>
              <span>No proof is attached. You can still change the status: the invoice will show <b>proof missing</b> until you attach the client&apos;s payment proof.</span>
            </div>
          )}
        </>
      )}
      {err && <div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div>}
    </Modal>
  );
}
