// "Edit GST / TDS" on an invoice (P4). The amount before GST and the rates are
// typed; GST (CGST + SGST or IGST), the amount after GST, TDS, the net
// receivable and the balance are worked out on every change. PATCH
// /invoices/:id recalculates them on the server and refuses anything that
// does not add up — e.g. money already received above the new net receivable.
import { useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { money2 } from './invFormat';
import TaxFields, {
  taxFormFrom, taxOfForm, taxPayload, taxFormErrors,
} from './TaxFields.jsx';

export default function TaxEditModal({ invoice, onClose, onSaved }) {
  const t = invoice.tax || {};
  const [base, setBase] = useState(String(t.base ?? invoice.amount ?? ''));
  const [f, setF] = useState(() => taxFormFrom(t));
  const [cert, setCert] = useState(invoice.tdsCertRef || '');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  const received = Number(invoice.receivedAmount || 0);
  const b = Number(base);
  const c = taxOfForm(f, b > 0 ? b : 0);

  const save = async () => {
    const e = taxFormErrors(f);
    if (!(b > 0)) e.base = 'Enter the amount before GST — more than ₹0.';
    if (b > 0 && received > c.net + 0.5) e.base = `${money2(received)} has already been received — the net receivable cannot go below it.`;
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      const res = await api.patch(`/invoices/${invoice.id}`, {
        ...taxPayload(f, b),
        tdsSection: f.tdsOn ? f.tdsSection : '',
        tdsDeductedOn: f.tdsOn ? f.tdsDeductedOn : '',
      });
      // A certificate / reference number typed here marks the Form 16A in hand.
      const ref = cert.trim();
      if (c.tds > 0.5 && ref && ref !== (invoice.tdsCertRef || '')) {
        await api.patch(`/invoices/${invoice.id}/tds-certificate`, { received: true, reference: ref });
      }
      const d = res.data;
      onSaved(d.unchanged && !ref
        ? 'Nothing changed.'
        : `Saved — GST ${money2(d.gst)}, TDS ${money2(d.tds)}, net receivable ${money2(d.total)} · ${d.status}.`);
    } catch (err) {
      setFail(err.response?.data?.error || 'The changes could not be saved.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit GST / TDS — ${invoice.invoiceNumber || ''}`}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <div className="invx-form" style={{ marginBottom: 10 }}>
        <label className="field">
          <span>Amount before GST (₹)</span>
          <input type="number" min="0" step="0.01" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} aria-invalid={!!errs.base} />
          {errs.base && <div className="inv-err">{errs.base}</div>}
        </label>
        <div className="field">
          <span>Already received</span>
          <div style={{ paddingTop: 8 }}>{money2(received)}</div>
        </div>
      </div>
      <TaxFields value={f} onChange={setF} base={b > 0 ? b : 0} supplyWhy={invoice.tax?.supply?.why} errs={errs} received={received} />
      {f.tdsOn && (
        <div className="invx-form" style={{ marginTop: 10 }}>
          <label className="field invx-span3">
            <span>TDS certificate / reference no (optional)</span>
            <input value={cert} maxLength={80} placeholder="Form 16A number — marks the certificate as in hand" onChange={(e) => setCert(e.target.value)} />
          </label>
        </div>
      )}
      {fail && <div className="notice red" style={{ marginTop: 10 }}><span>{fail}</span></div>}
    </Modal>
  );
}
