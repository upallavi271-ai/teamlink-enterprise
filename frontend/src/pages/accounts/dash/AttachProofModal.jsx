import { useState } from 'react';
import api from '../../../api';
import Modal from '../../../components/Modal.jsx';
import { money2, fmtD } from '../../invoices/invFormat';

// ATTACH PROOF for one record on the proof reminder (Accounts spec S8.3).
//   an invoice receipt  -> POST /dashboard/accounts/control/proof/invoice/:id
//                          (a PDF / image, plus an optional bank reference)
//   an office bill      -> POST /office-expenses/:id/proof (the Office page's own)
// A typed reference on its own is kept, but it is "Reference only — document
// missing" until a document (or a bank line) is on file.
const TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
export default function AttachProofModal({ rec, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isInvoice = rec.kind === 'invoice';

  const save = async () => {
    setErr('');
    if (file && !TYPES.includes(file.type)) { setErr(`${file.name} is not a PDF, JPG or PNG file.`); return; }
    if (file && file.size > 5 * 1024 * 1024) { setErr(`${file.name} is larger than 5 MB.`); return; }
    if (!file && !(isInvoice && ref.trim())) { setErr(isInvoice ? 'Choose the proof file, or type the bank reference / UTR.' : 'Choose the bill / vendor invoice file.'); return; }
    setBusy(true);
    try {
      if (isInvoice) {
        if (file) {
          const fd = new FormData();
          fd.append('file', file);
          if (ref.trim()) fd.append('reference', ref.trim());
          await api.post(`/dashboard/accounts/control/proof/invoice/${rec.id}`, fd);
        } else {
          await api.post(`/dashboard/accounts/control/proof/invoice/${rec.id}`, { reference: ref.trim() });
        }
      } else {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/office-expenses/${rec.id}/proof`, fd);
      }
      onDone(file ? `Proof attached to ${rec.ref || 'the record'} — marked Resolved.` : `Reference saved on ${rec.ref || 'the invoice'} — the document is still missing.`);
    } catch (e) {
      setErr(e.response?.data?.error || 'The proof could not be saved. Please try again.');
    }
    setBusy(false);
  };

  return (
    <Modal
      title="Attach proof"
      note={rec.ref || null}
      onClose={() => !busy && onClose()}
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save proof'}</button>
        </>
      )}
    >
      <div className="acd-kv"><span className="k">{isInvoice ? 'Client' : 'Vendor'}</span><b>{rec.party || '—'}</b></div>
      <div className="acd-kv"><span className="k">Amount</span><b>{money2(rec.amount)}</b></div>
      <div className="acd-kv"><span className="k">Payment date</span><b>{fmtD(rec.paidOn)}</b></div>
      <div className="acd-kv" style={{ marginBottom: 12 }}><span className="k">Missing</span><b>{rec.proofType}</b></div>
      <label className="acd-modal-row">
        <span>{isInvoice ? 'Receipt / bank proof (PDF, JPG or PNG, up to 5 MB)' : 'Bill / vendor tax invoice (PDF, JPG or PNG, up to 5 MB)'}</span>
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files && e.target.files[0])} />
      </label>
      {isInvoice && (
        <label className="acd-modal-row">
          <span>Bank reference / UTR (optional)</span>
          <input value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} placeholder="e.g. UTR 123456789012" />
        </label>
      )}
      {isInvoice && !file && ref.trim() && (
        <div className="notice amber"><span>A reference on its own is not a document — this record will show &quot;Reference only — document missing&quot; until a file is attached.</span></div>
      )}
      {err && <div className="notice red"><span>{err}</span></div>}
    </Modal>
  );
}
