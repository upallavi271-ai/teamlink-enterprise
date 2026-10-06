// B2 — raise (or change) a credit note / debit note against ONE invoice.
// Everything is worked out on the server with the invoice's own GST type and
// rates and TDS base (GET /invoices/credit-notes/prefill, POST …/preview), so
// the figures here are the ones the note will carry. Saving makes a DRAFT;
// another Accounts approver issues it (maker-checker).
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { money2, fmtD, todayIso } from './invFormat';
import './creditNotes.css';

const WORD = { credit: 'credit note', debit: 'debit note' };

// Open a note's PDF with the login's token, in a new tab.
export async function openNotePdf(id, onError) {
  try {
    const res = await api.get(`/invoices/credit-notes/${id}/pdf`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    onError?.('The PDF could not be opened.');
  }
}

export default function NoteModal({
  kind = 'credit', invoiceId = '', applicationId = '', rows = [], draft = null, onClose, onSaved,
}) {
  const [invId, setInvId] = useState(draft?.invoiceId || invoiceId || '');
  const [pre, setPre] = useState(null);
  const [amount, setAmount] = useState(draft ? String(draft.amount) : '');
  const [reason, setReason] = useState(draft?.reason || '');
  const [text, setText] = useState(draft?.reasonText || '');
  const [date, setDate] = useState(draft?.noteDate || todayIso());
  const [preview, setPreview] = useState(null);
  const [warn, setWarn] = useState('');
  const [fail, setFail] = useState('');
  const [busy, setBusy] = useState(false);
  const k = draft?.kind || kind;

  // Invoices a note can go against (from the register already on screen).
  const pickable = useMemo(() => rows.filter((r) => r.status !== 'Cancelled')
    .sort((a, b) => String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || ''))), [rows]);

  useEffect(() => {
    if (!invId && !applicationId) return undefined;
    let live = true;
    setFail('');
    const params = { kind: k, ...(applicationId && !draft ? { applicationId } : { invoiceId: invId }) };
    api.get('/invoices/credit-notes/prefill', { params })
      .then((res) => {
        if (!live) return;
        setPre(res.data);
        if (!invId) setInvId(res.data.invoice.id);
        if (!draft) {
          if (res.data.suggested.amount) setAmount(String(res.data.suggested.amount));
          if (res.data.suggested.reason) setReason(res.data.suggested.reason);
          if (res.data.suggested.reasonText) setText(res.data.suggested.reasonText);
        }
      })
      .catch((e) => { if (live) { setPre(null); setFail(e.response?.data?.error || 'That invoice could not be read.'); } });
    return () => { live = false; };
  }, [invId, applicationId, k]); // eslint-disable-line react-hooks/exhaustive-deps

  // The live calculation, from the server.
  useEffect(() => {
    const id = pre?.invoice?.id;
    if (!id || !(Number(amount) > 0)) { setPreview(null); setWarn(''); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.post('/invoices/credit-notes/preview', { invoiceId: id, kind: k, amount })
        .then((res) => { if (live) { setPreview(res.data.preview); setWarn(res.data.warning || ''); } })
        .catch(() => { if (live) setPreview(null); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [pre, amount, k]);

  const inv = pre?.invoice;
  const reasons = pre?.reasons || [];
  const save = async () => {
    setFail('');
    if (!inv) { setFail('Pick the invoice first.'); return; }
    if (!(Number(amount) > 0)) { setFail('Enter the amount before GST.'); return; }
    if (!reason) { setFail('Pick a reason.'); return; }
    if (reason === 'other' && !text.trim()) { setFail('Say in a few words why.'); return; }
    setBusy(true);
    try {
      const body = { amount, reason, reasonText: text.trim(), noteDate: date };
      const res = draft
        ? await api.patch(`/invoices/credit-notes/${draft.id}`, body)
        : await api.post('/invoices/credit-notes', { ...body, invoiceId: inv.id, kind: k, applicationId: pre.applicationId || undefined });
      onSaved(res.data, draft
        ? `Saved. The draft ${WORD[k]} now takes ${money2(res.data.net)}.`
        : `Saved as a draft ${WORD[k]} on ${inv.number}. Another Accounts approver now issues it.`);
    } catch (e) {
      setFail(e.response?.data?.error || 'The note could not be saved.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${draft ? 'Change draft' : 'New'} ${WORD[k]}`}
      onClose={onClose}
      size="wide"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !inv} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button>
        </>
      )}
    >
      <div className="cn-form">
        {!applicationId && !draft && !invoiceId && (
          <label className="field"><span>Invoice *</span>
            <Combo value={invId} onChange={(e) => { setPre(null); setInvId(e.target.value); }}>
              <option value="">Pick the invoice…</option>
              {pickable.map((r) => (
                <option key={r.id} value={r.id}>{`${r.invoiceNumber} · ${r.client}${r.candidateName ? ` · ${r.candidateName}` : ''} · ${money2(r.receivable)}`}</option>
              ))}
            </Combo>
          </label>
        )}
        {inv && (
          <div className="cn-inv">
            <b>{inv.number}</b> · {inv.client}{inv.candidate ? ` · ${inv.candidate}` : ''} · {fmtD(inv.date)}
            <div className="small-muted">
              Before GST {money2(inv.base)} · GST {inv.gstTypeLabel}{inv.gstPercent ? ` ${inv.gstPercent}%` : ''} · TDS {inv.tdsPercent ? `${inv.tdsPercent}%` : 'none'}
              {' '}· Net {money2(inv.net)} · Received {money2(inv.received)} · <b>Balance {money2(inv.balance)}</b>
            </div>
          </div>
        )}
        {inv && (
          <>
            <div className="cn-grid">
              <label className="field"><span>Reason *</span>
                <Combo value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">Pick a reason…</option>
                  {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </Combo>
              </label>
              <label className="field"><span>Amount before GST * (₹)</span>
                <input type="number" min="1" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={k === 'credit' ? `up to ${inv.maxCredit}` : ''} />
              </label>
              <label className="field"><span>Note date</span>
                <input type="date" value={date} min={inv.date ? String(inv.date).slice(0, 10) : undefined} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="field cn-span"><span>Details{reason === 'other' ? ' *' : ' (optional)'}</span>
                <input value={text} maxLength={1000} placeholder="e.g. Candidate left in week 3, client agreed to a credit" onChange={(e) => setText(e.target.value)} />
              </label>
            </div>
            {warn && <div className="notice amber"><span>{warn}</span></div>}
            {preview && (
              <table className="cn-calc">
                <tbody>
                  <tr><td>Amount before GST</td><td>{money2(preview.base)}</td></tr>
                  {preview.gstType === 'CGST_SGST' && (
                    <>
                      <tr className="sub"><td>CGST @ {preview.gstPercent / 2}%</td><td>{money2(preview.cgst)}</td></tr>
                      <tr className="sub"><td>SGST @ {preview.gstPercent / 2}%</td><td>{money2(preview.sgst)}</td></tr>
                    </>
                  )}
                  {preview.gstType === 'IGST' && <tr className="sub"><td>IGST @ {preview.gstPercent}%</td><td>{money2(preview.igst)}</td></tr>}
                  {preview.gstType === 'NONE' && <tr className="sub"><td>No GST on this invoice</td><td>{money2(0)}</td></tr>}
                  <tr><td>{k === 'credit' ? 'Less TDS the client no longer deducts' : 'Less TDS the client will deduct'} @ {preview.tdsPercent}%</td><td>− {money2(preview.tds)}</td></tr>
                  <tr className="tot"><td>{k === 'credit' ? 'Taken off what the client owes' : 'Added to what the client owes'}</td><td>{money2(preview.net)}</td></tr>
                  <tr><td>Invoice balance now → after</td><td>{money2(preview.balanceNow)} → <b>{money2(preview.balanceAfter)}</b></td></tr>
                  {preview.refundDue > 0.005 && (
                    <tr className="refund"><td>More than the balance — refund due to the client</td><td>{money2(preview.refundDue)}</td></tr>
                  )}
                </tbody>
              </table>
            )}
            <div className="small-muted">Saved as a draft. It changes nothing until another Accounts approver issues it.</div>
          </>
        )}
        {fail && <div className="notice red"><span>{fail}</span></div>}
      </div>
    </Modal>
  );
}
