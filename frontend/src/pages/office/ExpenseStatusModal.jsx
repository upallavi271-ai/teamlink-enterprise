// "CHANGE STATUS" for one office expense (founder 2026-10-31: "status change chese option evvu, status change chesthe proof kavali,
// proof attach cheyakapoyina ok, status change cheyochu").
//   Paid     the money went out: the payment date + mode, and the proof (receipt / bill / transfer screenshot)
//   Pending  back from Paid (marked paid by mistake): a reason is asked; the server refuses it while a bank line or a journal entry holds it
// The proof is ASKED for, never forced: without a file the status still changes and the bill shows "proof missing" until one is added.
// Uses the existing calls: POST /office-expenses/:id/proof (the file, first) then PATCH /office-expenses/:id/status.
import { useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { NEW_MODES } from './QuickExpenseModal.jsx';
import { money2 } from './officeUtil';

const TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const EXT = /\.(pdf|png|jpe?g)$/i;
const todayIso = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export default function ExpenseStatusModal({ expense, onClose, onDone }) {
  const x = expense;
  const from = x.status || x.approvalStatus;
  const can = x.can || {};
  const options = [
    ...(can.markPaid ? [['PAID', 'Paid', 'The money went out to the vendor.']] : []),
    ...(can.markPending ? [['PENDING', 'Pending (not paid)', 'It was marked Paid by mistake: it goes back to Pending / Unpaid.']] : []),
  ];
  const [to, setTo] = useState(options[0] ? options[0][0] : '');
  const [date, setDate] = useState(x.paymentDate || todayIso());
  const [mode, setMode] = useState(x.paymentMode || 'Bank Transfer');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pick = (f) => {
    setErr('');
    if (!f) { setFile(null); return; }
    if (!TYPES.includes(f.type) && !EXT.test(f.name)) { setErr(`${f.name} is not a PDF, JPG, JPEG or PNG file.`); return; }
    if (f.size > 5 * 1024 * 1024) { setErr(`${f.name} is larger than 5 MB.`); return; }
    setFile(f);
  };

  const save = async () => {
    if (busy || !to) return;
    if (to === 'PENDING' && reason.trim().length < 3) { setErr('Write why it goes back to Pending.'); return; }
    setBusy(true); setErr('');
    try {
      if (file) { // the proof first: if it cannot be stored, nothing else changes
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/office-expenses/${x.id}/proof`, fd);
      }
      const body = to === 'PAID' ? { action: 'mark_paid', paymentDate: date, paymentMode: mode } : { action: 'mark_pending', reason: reason.trim() };
      const r = await api.patch(`/office-expenses/${x.id}/status`, body);
      onDone(r.data, `Status changed to ${to === 'PAID' ? 'Paid' : 'Pending'}${file ? `, proof ${file.name} attached` : (to === 'PAID' && !x.attachment ? ' - no proof attached yet' : '')}.`);
    } catch (e) {
      setErr(e.response?.data?.error || 'The status could not be changed. Nothing else was changed.');
      setBusy(false);
    }
  };

  const noProof = to === 'PAID' && !file && !x.attachment;
  return (
    <Modal
      title={`Change status · ${x.expenseCode || 'expense'}`}
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
        Now: <b>{from === 'PAID' ? 'Paid' : from === 'APPROVED' ? 'Approved' : 'Pending'}</b> · {x.vendor || x.category} · {money2(x.net != null ? x.net : x.amount)}
      </div>
      {!options.length ? <div className="notice amber"><span>This expense&apos;s status cannot be changed here.</span></div> : (
        <>
          <div className="field">
            <span>New status</span>
            {options.map(([k, label, hint]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0', cursor: 'pointer' }}>
                <input type="radio" name="exp-status" checked={to === k} onChange={() => { setTo(k); setErr(''); }} />
                <span><b>{label}</b><div className="small-muted">{hint}</div></span>
              </label>
            ))}
          </div>
          {to === 'PAID' && (
            <div className="grid-2">
              <label className="field"><span>Payment date</span><input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></label>
              <label className="field"><span>Paid by</span><Combo value={mode} onChange={(e) => setMode(e.target.value)}>{NEW_MODES.map((m) => <option key={m}>{m}</option>)}</Combo></label>
            </div>
          )}
          {to === 'PENDING' && (
            <label className="field"><span>Why it goes back to Pending</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: marked paid by mistake" /></label>
          )}
          {to === 'PAID' && (
            <div className="field">
              <span>Proof of payment (PDF / JPG / PNG, up to 5 MB)</span>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(e) => pick(e.target.files && e.target.files[0])} />
              {x.attachment && !file && <div className="small-muted">Already attached: {x.attachment.name}. Choose a file only to replace it.</div>}
            </div>
          )}
          {noProof && (
            <div className="notice amber" style={{ marginTop: 6 }}>
              <span>No proof is attached. You can still change the status: the expense will show <b>proof missing</b> until you attach the receipt or transfer screenshot.</span>
            </div>
          )}
        </>
      )}
      {err && <div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div>}
    </Modal>
  );
}
