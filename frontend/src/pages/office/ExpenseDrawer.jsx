// The right-side DETAILS DRAWER of the one-page Expenses table (spec 12):
// every field of one expense, the bill, who added and who last changed it,
// and — for the Accounts Admin / Approver — Mark as Paid (Approve, Reject and
// Mark as Reimbursed were retired by Accounts spec S1.3c, 2026-10-05). Edit,
// Edit (full details), Delete and Close. No page change.
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import AddGstin from './AddGstin.jsx';
import { ApprovalBadge, detailCache } from './approval.jsx';
import { money2, fmtD } from './officeUtil';

const when = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${fmtD(d.toISOString().slice(0, 10))}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
};
const BILL_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const BILL_EXT = /\.(pdf|png|jpe?g)$/i;

function Row({ k, children }) {
  return <div className="oe-drw-kv"><span>{k}</span><div>{children}</div></div>;
}

export default function ExpenseDrawer({
  id, summary, canManage, onClose, onChanged, onEdit, onEditFull, onDelete, onViewBill,
}) {
  const [d, setD] = useState(() => detailCache.get(id) || null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const [line, setLine] = useState(null);
  const closeRef = useRef(null);
  const fileRef = useRef(null);

  const load = () => {
    setErr('');
    api.get(`/office-expenses/${id}`)
      .then((r) => { detailCache.set(id, r.data); setD(r.data); })
      .catch((e) => setErr(e.response?.data?.error || 'The details could not be loaded.'));
  };
  useEffect(() => {
    const hit = detailCache.get(id);
    if (hit) setD(hit); else { setD(null); load(); }
    setAdding(false); setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = () => { detailCache.drop(id); load(); onChanged(); };
  // The bank statement line this bill was paid off (the register's "View line").
  const viewLine = async () => {
    setLine({ loading: true });
    try { setLine((await api.get(`/office-expenses/${id}/bank-line`)).data); } catch (e) {
      setLine(null); setErr(e.response?.data?.error || 'The bank line could not be loaded.');
    }
  };
  const act = async (action, extra = {}) => {
    setBusy(action); setErr('');
    try {
      const r = await api.patch(`/office-expenses/${id}/status`, { action, ...extra });
      detailCache.set(id, r.data);
      setD(r.data);
      onChanged();
    } catch (e) {
      setErr(e.response?.data?.error || 'That could not be done.');
    }
    setBusy('');
  };
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!BILL_TYPES.includes(file.type) && !BILL_EXT.test(file.name)) { setErr(`${file.name} is not a PDF, JPG, JPEG or PNG file.`); return; }
    if (file.size > 5 * 1024 * 1024) { setErr(`${file.name} is larger than 5 MB.`); return; }
    const fd = new FormData();
    fd.append('file', file);
    setBusy('bill'); setErr('');
    try {
      await api.post(`/office-expenses/${id}/proof`, fd);
      setNote(`${file.name} attached.`);
      refresh();
    } catch (e2) { setErr(e2.response?.data?.error || 'The file could not be attached.'); }
    setBusy('');
  };

  const s = summary || {};
  const x = d || {};
  const st = d ? d.status : s.status;
  const code = x.expenseCode || s.expenseCode || '—';
  const amount = d ? x.base : s.amount;
  const gst = d ? x.gst : s.gst;
  const gstRate = d ? x.gstRate : s.gstRate;
  const total = d ? x.afterGst : s.total;
  const tds = d ? x.tds : s.tds;
  const billName = d ? x.proofName : s.bill?.name;
  const billOnServer = d ? !!x.attachment?.onServer : !!s.bill?.onServer;
  const can = x.can || {};
  const editable = canManage && d && (can.edit || can.override);

  return (
    <>
      <div className="oe-drw-back" onMouseDown={onClose} aria-hidden="true" />
      <aside className="oe-drw" role="dialog" aria-modal="true" aria-label={`Expense ${code}`}>
        <div className="oe-drw-head">
          <div>
            <div className="oe-drw-code num">{code}</div>
            <div className="oe-drw-title">{(d ? x.description : s.description) || (d ? x.category : s.category) || '—'}</div>
          </div>
          <ApprovalBadge s={st} />
          <button type="button" ref={closeRef} className="oe-acc-x" onClick={onClose} aria-label="Close the details" title="Close">✕</button>
        </div>

        <div className="oe-drw-body">
          {!d && !err && <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading the details…</div>}
          {err && <div className="notice red" role="alert"><span>{err} {!d && <button type="button" className="link-btn" onClick={load}>Retry</button>}</span></div>}
          {note && <div className="notice" role="status"><span>{note}</span></div>}

          <div className="oe-drw-money">
            <div><span>Amount</span><b>{money2(amount)}</b></div>
            <div><span>GST{gstRate ? ` @ ${gstRate}%` : ''}</span><b>{money2(gst)}</b></div>
            <div className="tot"><span>Total</span><b>{money2(total)}</b></div>
          </div>
          {Number(tds || 0) > 0 && (
            <div className="oe-drw-tds">
              TDS held back{(d ? x.tdsRate : s.tdsRate) ? ` @ ${d ? x.tdsRate : s.tdsRate}%` : ''}: <b>{money2(tds)}</b> · paid to the vendor after TDS: <b>{money2((d ? x.net : s.netAfterTds))}</b>
              <div className="small-muted">Total above is Amount + GST; the TDS is deposited with Government for the vendor.</div>
            </div>
          )}

          <Row k="Expense ID"><span className="num">{code}</span></Row>
          <Row k="Date">{fmtD(d ? x.expenseDate : s.expenseDate)}</Row>
          <Row k="Category">{(d ? x.category : s.category) || '—'}</Row>
          <Row k="Description">{(d ? x.description : s.description) || <em className="small-muted">none given</em>}</Row>
          <Row k="Vendor / Paid to">{(d ? x.vendor : s.vendor) || '—'}</Row>
          <Row k="Payment mode">{(d ? x.paymentMode : s.paymentMode) || '—'}</Row>
          <Row k="Amount">{money2(amount)}</Row>
          <Row k="GST %">{`${gstRate || 0}%`}</Row>
          <Row k="GST Amount">{money2(gst)}</Row>
          <Row k="Total">{money2(total)}</Row>
          <Row k="Status"><ApprovalBadge s={st} /></Row>
          <Row k="Bill / Invoice">
            {(d ? x.billNumber : s.billNumber) && <div className="num">{d ? x.billNumber : s.billNumber}</div>}
            {billName ? (
              <div className="oe-drw-bill">
                <span className="oe-drw-bill-n" title={billName}>{billName}</span>
                {billOnServer
                  ? <button type="button" className="btn btn-sm" onClick={() => onViewBill({ ...s, id, bill: { name: billName, onServer: true } })}>View</button>
                  : <span className="small-muted">only the file name is on record</span>}
              </div>
            ) : <span className="small-muted">No bill attached</span>}
            {canManage && (
              <button type="button" className="link-btn oe-drw-attach" disabled={busy === 'bill'} onClick={() => { if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } }}>
                {busy === 'bill' ? 'Attaching…' : (billName ? 'Replace the bill' : 'Attach the bill')}
              </button>
            )}
          </Row>
          <Row k="Added by">{d ? (x.createdBy ? x.createdBy.name : <em className="small-muted">not recorded (entered before Added By was kept)</em>) : (s.addedBy || '—')}</Row>
          <Row k="Created">{when(d ? x.createdAt : s.createdAt)}</Row>
          {d && <Row k="Modified">{x.updatedBy ? `${x.updatedBy.name} · ${when(x.updatedAt)}` : when(x.updatedAt)}</Row>}
          <Row k="Notes">{(d ? (x.remarks || x.notes) : s.notes) || <em className="small-muted">—</em>}</Row>
          {d && (
            <>
              <Row k="Vendor GSTIN">
                {x.effGstin
                  ? <>{x.effGstin} {x.gstinSource === 'vendor' && <em className="small-muted">(from the vendor)</em>} {!x.gstinOnFile && <span className="status priority-high">fails the check</span>}</>
                  : (x.gst > 0.5 ? <span className="status priority-high">missing — the GST cannot be claimed</span> : <em className="small-muted">not needed — no GST</em>)}
              </Row>
              <Row k="Signed off by">{x.approvedByUser ? `${x.approvedByUser.name}${x.approvedAt ? ` · ${when(x.approvedAt)}` : ''}` : <em className="small-muted">{['PAID', 'REIMBURSED'].includes(st) ? 'not recorded' : 'not yet'}</em>}</Row>
              {x.paidByUser && <Row k="Marked paid">{x.paidByUser.name} · {when(x.paidAt)}</Row>}
              {st === 'REIMBURSED' && x.reimbursedByUser && <Row k="Reimbursed">{x.reimbursedByUser.name} · {when(x.reimbursedAt)}</Row>}
              {st === 'REJECTED' && <Row k="Rejected">{x.rejectedBy?.name || '—'} · {when(x.rejectedAt)} — <b>{x.rejectionReason}</b></Row>}
              {x.bankTxnId && (
                <Row k="Proof of payment">
                  Bank statement line{' '}
                  <button type="button" className="link-btn" onClick={viewLine}>View line</button>
                </Row>
              )}
            </>
          )}

          {adding && d && <AddGstin bill={x} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
        </div>

        <div className="oe-drw-foot">
          {d && can.markPaid && (
            <div className="oe-drw-acts">
              <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('mark_paid')}>{busy === 'mark_paid' ? 'Saving…' : '₹ Mark as Paid'}</button>
            </div>
          )}
          <div className="oe-drw-acts">
            {canManage && d && (
              <button type="button" className="btn btn-sm" disabled={!editable} onClick={() => onEdit(x)}
                title={editable ? (can.edit ? 'Edit this expense' : 'Admin correction after approval — a reason is asked for, and it is audited') : 'Only a Pending expense can be edited (Super Admin / Admin may correct a later one)'}>
                ✎ Edit
              </button>
            )}
            {canManage && d && editable && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onEditFull(x)}>Edit (full details)</button>}
            {canManage && d && x.atRisk && !adding && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}>Add GSTIN</button>}
            {canManage && d && (
              <button type="button" className="btn btn-sm oe-del" disabled={!can.delete} onClick={() => onDelete(x)}
                title={can.delete ? 'Delete this expense' : 'Only the Accounts Admin / Approver can delete an approved or paid expense'}>
                Delete
              </button>
            )}
            <span style={{ marginLeft: 'auto' }} />
            <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        <input ref={fileRef} type="file" hidden accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/png,image/jpeg" onChange={onFile} />
      </aside>
      {line && (
        <Modal title="Bank statement line" note={code} size="wide" onClose={() => setLine(null)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setLine(null)}>Close</button>}>
          {line.loading ? <div className="small-muted">Loading the statement…</div> : (
            <div className="tbl-wrap">
              <table className="oe-stmt">
                <thead><tr><th>Date</th><th>Narration</th><th>Ref / UTR</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  {line.around.map((t) => (
                    <tr key={t.id} className={t.match ? 'oe-stmt-match' : 'oe-stmt-dim'}>
                      <td className="oe-nowrap">{fmtD(t.date)}</td>
                      <td>{t.description}</td>
                      <td className="oe-nowrap">{t.reference || '—'}</td>
                      <td className="num">{t.type === 'Debit' ? money2(t.amount) : ''}</td>
                      <td className="num">{t.type === 'Credit' ? money2(t.amount) : ''}</td>
                      <td className="num">{t.balance != null ? money2(t.balance) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small-muted" style={{ marginTop: 8 }}>
                Difference against the bill (after TDS): {Math.abs(line.difference) < 0.5 ? 'exact match' : money2(line.difference)}
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
