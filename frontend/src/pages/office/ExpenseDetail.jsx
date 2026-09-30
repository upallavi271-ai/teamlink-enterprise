// The row-click accordion (spec A §D): the money off the list row at once, and
// the rest — description, vendor, paid by, the attachment, who created and who
// approved it — from GET /office-expenses/:id, cached for the session.
// Approve / Reject (reason required) on a pending bill and Mark as Paid on an
// approved one, for the Accounts Admin / Approver only (the API refuses
// everyone else as well).
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import AddGstin from './AddGstin.jsx';
import { ApprovalBadge, detailCache } from './approval.jsx';
import { money, fmtD, saveBlob } from './officeUtil';

const PAID_BY = { cash: 'Cash', bank: 'Bank', card: 'Card' };
const when = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${fmtD(d.toISOString().slice(0, 10))}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
};
const Missing = ({ what }) => <span className="status priority-high oe-miss" title={`${what} is not on this bill`}>missing</span>;

function Thumb({ d }) {
  const [url, setUrl] = useState(null);
  const [bad, setBad] = useState(false);
  const a = d.attachment;
  useEffect(() => {
    if (!a || !a.isImage) return undefined;
    let live = true;
    let made = null;
    api.get(`/office-expenses/${d.id}/proof/file`, { responseType: 'blob' })
      .then((r) => { if (!live) return; made = URL.createObjectURL(r.data); setUrl(made); })
      .catch(() => { if (live) setBad(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [d.id, a]);
  if (!a) return <span className="small-muted">No attachment</span>;
  const open = async () => {
    try {
      const r = await api.get(`/office-expenses/${d.id}/proof/file`, { responseType: 'blob' });
      saveBlob(r, a.name || 'attachment');
    } catch { /* the link says so below */ setBad(true); }
  };
  if (!a.onServer) return <span title="Only the file name is on record">{a.name}</span>;
  return (
    <span className="oe-acc-att">
      {a.isImage && url && <button type="button" className="oe-acc-thumb" onClick={open} title={`Download ${a.name}`}><img src={url} alt={a.name} /></button>}
      <button type="button" className="link-btn" onClick={open}>{a.isImage ? 'Download' : `📄 ${a.name}`}</button>
      {bad && <span className="small-muted"> — the file could not be opened</span>}
    </span>
  );
}

export default function ExpenseDetail({
  row, colSpan, canManage, onClose, onChanged, onEdit, onNote,
}) {
  const [d, setD] = useState(() => detailCache.get(row.id) || null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const box = useRef(null);

  const load = () => {
    setErr('');
    api.get(`/office-expenses/${row.id}`)
      .then((r) => { detailCache.set(row.id, r.data); setD(r.data); })
      .catch((e) => setErr(e.response?.data?.error || 'The details could not be loaded.'));
  };
  useEffect(() => {
    const hit = detailCache.get(row.id);
    if (hit) setD(hit); else { setD(null); load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);
  useEffect(() => { box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);

  const act = async (action, extra = {}) => {
    setBusy(action); setErr('');
    try {
      const r = await api.patch(`/office-expenses/${row.id}/status`, { action, ...extra });
      setD(r.data);
      setRejecting(false); setReason('');
      onChanged();
      detailCache.set(row.id, r.data);
      if (action === 'reject') onNote(`Rejected — ${row.vendor || row.billName} is out of the totals now; pick Status: Rejected to see it.`);
    } catch (e) {
      setErr(e.response?.data?.error || 'That could not be done.');
    }
    setBusy('');
  };

  const r = row;
  const s = d ? d.status : r.approvalStatus;
  return (
    <tr className="oe-detail oe-acc">
      <td colSpan={colSpan}>
        <div className="oe-acc-in" ref={box}>
          <div className="oe-acc-head">
            <ApprovalBadge s={s} />
            <b className="oe-acc-title">{r.billName}</b>
            <span className="small-muted">{r.category || '—'} · {fmtD(r.expenseDate)}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="oe-acc-x" onClick={onClose} aria-label="Close the details" title="Close">✕</button>
          </div>

          <div className="oe-detail-grid">
            <div className="oe-detail-money">
              {[
                ['Before GST', r.base, ''],
                ['GST', r.gst, r.gstRate ? `${r.gstRate}%` : ''],
                ['TDS', r.tds, r.tdsRate ? `${r.tdsRate}%` : ''],
                ['After GST', r.afterGst, 'before GST + GST'],
                ['Total', r.net, 'after GST − TDS'],
              ].map(([l, n, sub]) => (
                <div key={l}><span>{l}</span><b className="num">{money(n)}</b><em>{sub}</em></div>
              ))}
            </div>

            {!d && !err && <div className="oe-acc-loading"><span className="oe-spin" aria-hidden="true" /> Loading the details…</div>}
            {err && (
              <div className="notice red oe-acc-err" role="alert">
                <span>{err} {!d && <button type="button" className="link-btn" onClick={load}>Retry</button>}</span>
              </div>
            )}

            {d && (
              <div className="oe-detail-facts oe-acc-facts">
                <div><span>Description</span>{d.description || <em>none given</em>}</div>
                <div><span>Vendor</span>{d.vendor || <Missing what="The vendor" />}</div>
                <div><span>Paid by</span>{PAID_BY[d.paid_by] || '—'}{d.paymentMode ? <em> · {d.paymentMode}</em> : null}</div>
                <div><span>Attachment</span><Thumb d={d} /></div>
                <div><span>Vendor GSTIN</span>{d.effGstin
                  ? <>{d.effGstin} {d.gstinSource === 'vendor' && <em>(from the vendor)</em>} {!d.gstinOnFile && <span className="status priority-high">fails the check</span>}</>
                  : (d.gst > 0.5 ? <Missing what="The vendor GSTIN" /> : <em>not needed — no GST on this bill</em>)}</div>
                <div><span>Created</span>{d.createdBy ? d.createdBy.name : <em>before approvals were recorded</em>} · {when(d.createdAt)}</div>
                <div><span>Approved</span>{d.approvedByUser ? `${d.approvedByUser.name}${d.approvedAt ? ` · ${when(d.approvedAt)}` : ''}` : (s === 'PAID' ? <em>paid before approvals were recorded</em> : <em>not yet</em>)}</div>
                {s === 'REJECTED' && <div><span>Rejected</span>{d.rejectedBy?.name || '—'} · {when(d.rejectedAt)} — <b>{d.rejectionReason}</b></div>}
                {s === 'PAID' && d.paidByUser && <div><span>Marked paid</span>{d.paidByUser.name} · {when(d.paidAt)}</div>}
                {s === 'REIMBURSED' && d.reimbursedByUser && <div><span>Reimbursed</span>{d.reimbursedByUser.name} · {when(d.reimbursedAt)}</div>}
                {d.pending && d.dueOn && <div><span>Due</span>{fmtD(d.dueOn)}{d.daysPending > 0 ? ` · ${d.daysPending}d overdue` : ''}</div>}
                {d.remarks && <div><span>Remarks</span>{d.remarks}</div>}
                {d.missing.length > 0 && <div><span>Missing</span>{d.missing.join(', ')}</div>}
              </div>
            )}
          </div>

          {d && (
            <div className="oe-detail-actions oe-acc-actions">
              {d.can.approve && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('approve')}>{busy === 'approve' ? 'Approving…' : '✓ Approve'}</button>}
              {d.can.reject && !rejecting && <button type="button" className="btn btn-sm oe-del" disabled={!!busy} onClick={() => setRejecting(true)}>✕ Reject</button>}
              {d.can.markPaid && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('mark_paid')}>{busy === 'mark_paid' ? 'Saving…' : '₹ Mark as Paid'}</button>}
              {d.can.markReimbursed && <button type="button" className="btn btn-sm" disabled={!!busy} title="Someone paid this out of pocket and the office has paid them back" onClick={() => act('mark_reimbursed')}>{busy === 'mark_reimbursed' ? 'Saving…' : 'Mark as Reimbursed'}</button>}
              {canManage && d.can.edit && <button type="button" className="btn btn-sm" onClick={() => onEdit(r)}>✎ Edit</button>}
              {canManage && d.can.override && <button type="button" className="btn btn-sm" title="Super Admin / Admin correction — audited, a reason is asked for" onClick={() => onEdit(r)}>✎ Correct (admin)</button>}
              {canManage && r.atRisk && !adding && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>Add GSTIN</button>}
              {s === 'PENDING' && !d.can.approve && <span className="small-muted">Waiting for the Accounts Admin / Approver.</span>}
            </div>
          )}
          {rejecting && (
            <div className="oe-acc-reject">
              <label className="field"><span>Why is it rejected? *</span>
                <textarea rows={2} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate of the rent bill already paid on 5 Sep" />
              </label>
              <div className="oe-acc-reject-a">
                <button type="button" className="btn btn-sm" onClick={() => { setRejecting(false); setReason(''); }}>Cancel</button>
                <button type="button" className="btn btn-sm oe-del" disabled={reason.trim().length < 3 || !!busy} onClick={() => act('reject', { reason: reason.trim() })}>
                  {busy === 'reject' ? 'Rejecting…' : 'Reject expense'}
                </button>
              </div>
            </div>
          )}
          {adding && <AddGstin bill={r} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); detailCache.drop(r.id); onChanged(); load(); }} />}
        </div>
      </td>
    </tr>
  );
}
