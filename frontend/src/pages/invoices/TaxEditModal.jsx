// "Edit GST / TDS" on an invoice (P4). The amount before GST and the rates are
// typed; GST (CGST + SGST or IGST), the amount after GST, TDS, the net
// receivable and the balance are worked out on every change. PATCH
// /invoices/:id recalculates them on the server and refuses anything that
// does not add up — e.g. money already received above the new net receivable.
import { useEffect, useState } from 'react';
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
  // Invoice date, joining date, candidate name and salary - edited here too (saved on the candidate's ATS record).
  const [det, setDet] = useState(null); // as loaded
  const [d, setD] = useState({ invoiceDate: '', joiningDate: '', candidateName: '', offeredCtc: '' });
  useEffect(() => {
    api.get(`/invoices/${invoice.id}/details`).then((r) => {
      setDet(r.data);
      setD({ invoiceDate: r.data.invoiceDate || '', joiningDate: r.data.joiningDate || '', candidateName: r.data.candidateName || '', offeredCtc: r.data.offeredCtc != null ? String(r.data.offeredCtc) : '' });
    }).catch(() => setDet(null));
  }, [invoice.id]);
  const setField = (k) => (e) => setD((c0) => ({ ...c0, [k]: e.target.value }));
  // A new salary works the fee out again (the client's fee %); the amount can still be typed over.
  const setSalary = (e) => {
    const v = e.target.value;
    setD((c0) => ({ ...c0, offeredCtc: v }));
    if (det && Number(det.feePercent) > 0 && Number(v) > 0) setBase(String(Math.round((Number(v) * Number(det.feePercent)) / 100)));
  };
  const b = Number(base);
  const c = taxOfForm(f, b > 0 ? b : 0);

  const save = async () => {
    const e = taxFormErrors(f);
    if (!(b > 0)) e.base = 'Enter the amount before GST — more than ₹0.';
    if (b > 0 && received > c.net + 0.005
      && !window.confirm(`${money2(received)} was already received, more than the new net receivable ${money2(c.net)}.\nThe extra ${money2(received - c.net)} will be taken off this invoice and added to this client's next open invoices (oldest first), with its bank line as proof.\n\nContinue?`)) return;
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      let said = [];
      if (det) {
        const r0 = await api.patch(`/invoices/${invoice.id}/details`, d);
        said = r0.data.changed || [];
      }
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
      const out = res.data;
      onSaved(out.unchanged && !ref && !said.length
        ? 'Nothing changed.'
        : `Saved — GST ${money2(out.gst)}, TDS ${money2(out.tds)}, net receivable ${money2(out.total)} · ${out.status}.${out.movedMoney ? ` ${money2(out.movedMoney.amount)} of received money moved${out.movedMoney.reapplied.length ? ` to ${out.movedMoney.reapplied.map((x) => `${x.invoiceNumber || 'invoice'} (${money2(x.amount)})`).join(', ')}` : ''}${out.movedMoney.unappliedOnBank > 0.004 ? `; ${money2(out.movedMoney.unappliedOnBank)} is left unapplied on its bank line` : ''}.` : ''}`);
    } catch (err) {
      setFail(err.response?.data?.error || 'The changes could not be saved.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit invoice — ${invoice.invoiceNumber || ''}`}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      {det && (
        <div className="invx-form" style={{ marginBottom: 10 }}>
          <label className="field">
            <span>Invoice date</span>
            <input type="date" value={d.invoiceDate} onChange={setField('invoiceDate')} />
          </label>
          <label className="field">
            <span>Joining date</span>
            <input type="date" value={d.joiningDate} onChange={setField('joiningDate')} />
          </label>
          {det.hasCandidate && (
            <label className="field">
              <span>Candidate name</span>
              <input value={d.candidateName} maxLength={120} onChange={setField('candidateName')} />
            </label>
          )}
          <label className="field">
            <span>Salary / annual CTC (₹)</span>
            <input type="number" min="0" inputMode="numeric" value={d.offeredCtc} onChange={setSalary} />
          </label>
          <div className="small-muted" style={{ gridColumn: '1 / -1' }}>Joining date, name and salary are saved on the candidate&apos;s ATS record too.{Number(det.feePercent) > 0 ? ` Changing the salary works the amount out again at ${det.feePercent}%.` : ''}</div>
        </div>
      )}
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
