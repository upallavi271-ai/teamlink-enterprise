// One bank line in full: its dates, narration, reference, who it was matched to, what it
// was allocated to and the difference - plus the safe ways to put a wrong match right:
// take one allocation back, mark a receipt as bounced / returned, tie a payment-out to a
// client refund. Everything is a separate, plainly named button (no menus).
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { money2, fmtD } from '../invoices/invFormat';

const Row = ({ k, children }) => (<div className="td-kv"><i>{k}</i><b>{children}</b></div>);

export default function TxnDetail({ txnId, transactions = [], canManage, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [form, setForm] = useState(null); // null | 'bounce' | 'refund' | { takeBack: paymentId }
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [returnLine, setReturnLine] = useState('');
  const [notes, setNotes] = useState([]);
  const [noteId, setNoteId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/bank/${txnId}/detail`).then((r) => { setD(r.data); setErr(''); })
    .catch((e) => setErr(e.response?.data?.error || 'This line could not be opened.'));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [txnId]);
  useEffect(() => {
    if (form === 'refund' && !notes.length) {
      api.get('/invoices/credit-notes').then((r) => setNotes((r.data.rows || []).filter((n) => n.kind !== 'debit' && n.status === 'Issued' && Number(n.refundDue || 0) > 0.005 && !n.refundPaidOn))).catch(() => setNotes([]));
    }
  }, [form, notes.length]);

  const run = async (path, body, msg) => {
    setBusy(true); setErr(''); setSaid('');
    try {
      await api.post(`/bank/${txnId}/${path}`, body);
      setSaid(msg); setForm(null); setReason('');
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not work. Nothing was changed.');
    } finally { setBusy(false); }
  };

  const returns = d && d.type === 'Credit'
    ? transactions.filter((t) => t.type === 'Debit' && Math.round(Number(t.amount) * 100) === Math.round(Number(d.credit) * 100) && t.state !== 'Reversed' && String(t.date) >= String(d.transactionDate))
    : [];
  const canReverse = canManage && d && d.type === 'Credit' && d.state !== 'Reversed' && d.state !== 'Ignored';

  return (
    <Modal wide title="Bank transaction" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
      {said && <div className="notice" style={{ marginBottom: 8 }}><span>{said}</span></div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && (
        <>
          <div className="td-grid">
            <Row k="Transaction date (on the statement)">{fmtD(d.transactionDate)}</Row>
            <Row k="Value date">{d.valueDate ? fmtD(d.valueDate) : '—'}</Row>
            <Row k="Imported on">{d.importedAt ? fmtD(d.importedAt) : '—'}</Row>
            <div className="td-wide"><Row k="Narration">{d.narration}</Row></div>
            <Row k="Debit (money out)">{d.debit != null ? money2(d.debit) : '—'}</Row>
            <Row k="Credit (money in)">{d.credit != null ? money2(d.credit) : '—'}</Row>
            <Row k="Reference / UTR">{d.reference || '—'}</Row>
            <Row k="Bank transaction id">{d.bankTxnId || '—'}</Row>
            <Row k="Bank">{d.bank || '—'}</Row>
            <Row k="Client / vendor">{d.clientOrVendor || '—'}</Row>
            <Row k="Status">{d.reviewReason && d.state === 'Unmatched' ? 'Needs review' : d.state}</Row>
            <Row k="Difference (amount minus what it is linked to)">{d.difference == null ? '—' : money2(d.difference)}</Row>
          </div>
          {d.reviewReason && d.state === 'Unmatched' && <div className="notice amber" style={{ marginTop: 8 }}><span><b>Why it needs a look:</b> {d.reviewReason}</span></div>}
          {d.reverses && <div className="small-muted" style={{ marginTop: 8 }}>This debit is the return of the credit of {fmtD(d.reverses.date)} ({money2(d.reverses.amount)}).</div>}
          {d.reversedBy && <div className="small-muted" style={{ marginTop: 8 }}>This credit was returned on {fmtD(d.reversedBy.date)}.</div>}
          {d.import && <div className="small-muted" style={{ marginTop: 8 }}>From {d.import.file} (imported {fmtD(d.import.importedOn)} by {d.import.by || '—'}){d.sourceLine ? `, row ${d.sourceLine}` : ''}.</div>}

          {(d.allocations.length > 0) && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Allocated to invoices · {money2(d.allocated)} of {money2(d.credit)}{d.unallocated > 0.004 ? ` · ${money2(d.unallocated)} still unallocated` : ''}</h4>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Invoice</th><th>Client</th><th>Candidate</th><th>Date</th><th className="num">Amount</th><th /></tr></thead>
                  <tbody>
                    {d.allocations.map((a) => (
                      <tr key={a.paymentId}>
                        <td>{a.invoiceNumber || '—'}{a.reversal ? ' (reversal)' : ''}</td><td>{a.client || '—'}</td><td>{a.candidate || '—'}</td>
                        <td>{fmtD(a.date)}</td><td className="num">{money2(a.amount)}</td>
                        <td>{canManage && !a.reversal && d.state !== 'Reversed' && <button type="button" className="btn btn-sm" onClick={() => { setForm({ takeBack: a.paymentId }); setReason(''); }}>Take back</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {d.bills.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Linked to office expense(s)</h4>
              <ul style={{ margin: '0 0 0 18px' }}>
                {d.bills.map((b) => <li key={b.id}>{b.expenseCode || b.id} · {b.vendor || b.category} · {money2(b.net)}{b.paymentDate ? ` · paid ${fmtD(b.paymentDate)}` : ''}</li>)}
              </ul>
            </>
          )}
          {d.handLoan && <div className="small-muted" style={{ marginTop: 8 }}>Hand loan: {d.handLoan.name} ({d.handLoan.kind}).</div>}
          {d.refund && <div className="small-muted" style={{ marginTop: 8 }}>Paid as a refund to {d.refund.client || 'a client'}.</div>}

          {canManage && (
            <div className="qa-row" style={{ marginTop: 14 }}>
              {canReverse && <button type="button" className="btn btn-sm" onClick={() => { setForm('bounce'); setReason(''); setDate(''); }}>Bounced / returned…</button>}
              {canManage && d.type === 'Debit' && !d.refund && d.state === 'Unmatched' && <button type="button" className="btn btn-sm" onClick={() => { setForm('refund'); }}>This pays a client refund…</button>}
              {d.refund && <button type="button" className="btn btn-sm" onClick={() => run('unlink-refund', { reason: 'Undone from the bank screen' }, 'The refund link was undone.')}>Undo refund link</button>}
            </div>
          )}

          {form && form.takeBack && (
            <div className="td-form">
              <b>Take this allocation back</b>
              <p className="small-muted">The invoice goes back to owing this amount. Say why - it is kept in the history.</p>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (for example: paid against the wrong invoice)" style={{ width: '100%' }} />
              <div className="qa-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length < 3} onClick={() => run('deallocate', { paymentId: form.takeBack, reason }, 'Taken back. The money is unallocated again - allocate it from Unallocated payments.')}>Take it back</button>
                <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
              </div>
            </div>
          )}
          {form === 'bounce' && (
            <div className="td-form">
              <b>This payment came back (bounced cheque / returned)</b>
              <p className="small-muted">The original receipt stays on record; a dated reversal is added and the invoice owes the money again.</p>
              <label className="field"><span>The line where it came back (optional)</span>
                <select value={returnLine} onChange={(e) => setReturnLine(e.target.value)}>
                  <option value="">— none: I will type the date —</option>
                  {returns.map((t) => <option key={t.id} value={t.id}>{fmtD(t.date)} · {String(t.description).slice(0, 60)}</option>)}
                </select>
              </label>
              {!returnLine && <label className="field"><span>Date it came back</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened? (for example: cheque bounced - insufficient funds)" style={{ width: '100%' }} />
              <div className="qa-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length < 3 || (!returnLine && !date)} onClick={() => run('reverse', { reason, returnLineId: returnLine || undefined, date: returnLine ? undefined : date }, 'Done. The invoice owes this money again.')}>Mark as returned</button>
                <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
              </div>
            </div>
          )}
          {form === 'refund' && (
            <div className="td-form">
              <b>Which credit note is this refund for?</b>
              <p className="small-muted">Only credit notes whose refund due equals this payment to the paisa are listed.</p>
              {(() => {
                const fits = notes.filter((n) => Math.round(Number(n.refundDue) * 100) === Math.round(Number(d.debit) * 100));
                return fits.length ? (
                  <>
                    <select value={noteId} onChange={(e) => setNoteId(e.target.value)} style={{ width: '100%' }}>
                      <option value="">— choose —</option>
                      {fits.map((n) => <option key={n.id} value={n.id}>{n.number} · {n.client || n.invoiceNumber} · refund {money2(n.refundDue)}</option>)}
                    </select>
                    <div className="qa-row">
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !noteId} onClick={() => run('link-refund', { creditNoteId: noteId }, 'Linked. The credit note now shows the refund as paid on the statement date.')}>Link the refund</button>
                      <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
                    </div>
                  </>
                ) : <div className="small-muted">No credit note has a refund due of exactly {money2(d.debit)}.</div>;
              })()}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
