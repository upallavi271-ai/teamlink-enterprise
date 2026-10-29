// THE CHAIN SCREEN (founder 2026-10-28: "leave management lo chain ani vere screen open avvali, dantlo evaru e dates lo approve
// chesaru ani detail ga chupinchali, leave reason kuda anni"). Read-only: the leave and its reason, every approval level with who
// did what and the date and time, and every recorded event of the request. Approve / Reject stays on its own button.
// Data: GET /api/leave/:id/workflow (leave, workflow.steps, history).
import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal, EmptyMini, SectionLabel, Status } from '../../components/proto.jsx';
import './LeaveChainScreen.css';

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const day = (s) => {
  if (!s) return '';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
// What a step's status means, in plain words.
const RESULT = {
  Applied: 'Applied', Approved: 'Approved', Rejected: 'Rejected', Pending: 'Waiting for them', Waiting: 'Not reached yet',
  Visibility: 'Seen only (not needed)', Skipped: 'Skipped', Cancelled: 'Cancelled', Reassigned: 'Handed over',
};

export default function LeaveChainScreen({ requestId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/leave/${requestId}/workflow`).then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load this leave.'));
  }, [requestId]);

  const lv = data && data.leave;
  const steps = (data && data.workflow && data.workflow.steps) || [];
  const history = (data && data.history) || [];
  const e = (lv && lv.employee) || {};
  return (
    <Modal title={lv ? `Leave chain - ${e.name || ''}` : 'Leave chain'} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!data && !error && <EmptyMini>Loading…</EmptyMini>}
      {lv && (
        <div className="lch">
          <SectionLabel>The leave</SectionLabel>
          <table className="lch-facts">
            <tbody>
              <tr><th>Employee</th><td><b>{e.name}</b> {e.code ? <span className="cell-muted">{e.code}</span> : null}{e.department ? <span className="cell-muted"> · {e.department}{e.designation ? ` · ${e.designation}` : ''}</span> : null}</td></tr>
              <tr><th>Leave</th><td><b>{lv.type}</b>{lv.halfDay ? ` (${lv.halfDay})` : ''}</td></tr>
              <tr><th>Dates</th><td>{day(lv.fromDate)}{lv.toDate && lv.toDate !== lv.fromDate ? ` to ${day(lv.toDate)}` : ''} · <b>{lv.days ?? 1} day{Number(lv.days ?? 1) === 1 ? '' : 's'}</b></td></tr>
              <tr><th>Status now</th><td><Status value={lv.status} />{lv.decidedBy ? <span className="cell-muted"> by {lv.decidedBy}{lv.decidedAt ? ` on ${when(lv.decidedAt)}` : ''}</span> : null}</td></tr>
              <tr><th>Applied on</th><td>{when(lv.appliedAt)}</td></tr>
              <tr><th>Reason</th><td className="lch-reason">{lv.reasonText || lv.reason || <span className="cell-muted">No reason given</span>}</td></tr>
              {lv.employeeComments && <tr><th>Employee&apos;s comments</th><td className="lch-reason">{lv.employeeComments}</td></tr>}
              {lv.approvalReason && <tr><th>Approval reason</th><td className="lch-reason">{lv.approvalReason}</td></tr>}
              {lv.rejectReason && <tr><th>Reject reason</th><td className="lch-reason">{lv.rejectReason}</td></tr>}
            </tbody>
          </table>

          <SectionLabel style={{ marginTop: 16 }}>Who approved, and when</SectionLabel>
          {steps.length === 0 ? <EmptyMini>No approval chain on this request (decided in one step).</EmptyMini> : (
            <div className="tbl-wrap">
              <table className="table lch-steps">
                <thead><tr><th>#</th><th>Level</th><th>Approver</th><th>Result</th><th>Done by</th><th>Date &amp; time</th><th>Comment</th></tr></thead>
                <tbody>
                  {steps.map((s, i) => (
                    <tr key={s.id} className={`lch-${String(s.status).toLowerCase()}`}>
                      <td>{i + 1}</td>
                      <td>{s.label}{s.mode && s.mode !== 'required' && s.status !== 'Applied' ? <span className="cell-muted"> ({s.mode})</span> : null}</td>
                      <td>{s.approverName || <span className="cell-muted">-</span>}</td>
                      <td><b>{RESULT[s.status] || s.status}</b>{s.direct ? <span className="cell-muted"> (direct)</span> : null}{s.status === 'Pending' && s.pendingSince ? <div className="cell-muted">since {when(s.pendingSince)}{s.overdue ? ' · overdue' : ''}</div> : null}</td>
                      <td>{s.actedByName || (s.status === 'Applied' ? s.approverName : '') || <span className="cell-muted">-</span>}</td>
                      <td>{s.actedAt ? when(s.actedAt) : <span className="cell-muted">-</span>}</td>
                      <td className="lch-note">{s.note || <span className="cell-muted">-</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <SectionLabel style={{ marginTop: 16 }}>{`Everything that happened (${history.length})`}</SectionLabel>
          {history.length === 0 ? <EmptyMini>Nothing recorded yet.</EmptyMini> : (
            <ol className="lch-history">
              {history.map((h, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={i}>
                  <span className="lch-when">{when(h.at)}</span>
                  <span><b>{h.action}</b>{h.by ? <> by {h.by}</> : null}
                    {(h.from || h.to) && <span className="cell-muted"> · {h.from || '-'} → {h.to || '-'}</span>}
                    {h.reason && <div className="cell-muted lch-reason">{h.reason}</div>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Modal>
  );
}

// The "Chain" button: opens the screen above for one request.
export function ChainButton({ requestId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" title="Who approved, when, and the reason" onClick={() => setOpen(true)}>Chain</button>
      {open && <LeaveChainScreen requestId={requestId} onClose={() => setOpen(false)} />}
    </>
  );
}
