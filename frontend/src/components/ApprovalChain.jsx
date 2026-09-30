import { useEffect, useState } from 'react';
import api from '../api';
import { Modal, EmptyMini, SectionLabel } from './proto.jsx';
import './ApprovalChain.css';

// ---------------------------------------------------------------------------
// THE APPROVAL CHAIN — one component for every request on the shared engine
// (backend/src/utils/approvalWorkflow.js): Leave, Attendance Regularization,
// Resignation, Performance/Reward recommendations and LMS courses.
//
//   Employee → TL ✓ → STL ✓ → HR ⏳ → AM → Manager → SA
//
// It shows what spec item 2 asks every request to show — Submitted By,
// Submitted Date & Time, Current Approver, Approval Level, Previous
// Approvers, Status, Approved/Rejected By, Approved/Rejected Date & Time,
// Remarks, the complete history, and the "Direct Super Admin Approval" flag —
// and, when the server says so, the Approve / Reject controls:
//   canAct    — it is this login's turn
//   canDirect — this login is a Super Admin and may decide directly
// Nothing here decides who may act; the API refuses anything out of turn.
//
// Exports:
//   default ApprovalChain  — renders a view() object (+ optional actions)
//   ApprovalChainLine      — the one-line chain for a list row (summary)
//   ApprovalChainModal     — loads /api/approvals/:type/:id and decides
// ---------------------------------------------------------------------------

const MARK = { Applied: '', Approved: '✓', Rejected: '✗', Pending: '⏳', Waiting: '', Visibility: '', Skipped: '' };
const PILL = { Applied: 'is-done', Approved: 'is-done', Rejected: 'is-rejected', Pending: 'is-current', Skipped: 'is-skipped' };
const HISTORY = {
  Applied: { mark: '✓', cls: 'wf-done', text: 'Submitted' },
  Approved: { mark: '✓', cls: 'wf-done', text: 'Approved' },
  Pending: { mark: '●', cls: 'wf-current', text: 'Pending approval' },
  Rejected: { mark: '✗', cls: 'wf-rejected', text: 'Rejected' },
  Waiting: { mark: '○', cls: 'wf-waiting', text: 'Waiting' },
  Visibility: { mark: '○', cls: 'wf-waiting', text: 'Visibility only' },
  Skipped: { mark: '–', cls: 'wf-skipped', text: 'Skipped' },
};

export const fmtDateTime = (iso) => (iso
  ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

function stateText(wf) {
  if (!wf) return '—';
  if (wf.state === 'Pending') return 'Pending approval';
  if (wf.state === 'Rejected') return wf.direct ? 'Rejected (Direct Super Admin)' : 'Rejected';
  return wf.direct ? 'Approved (Direct Super Admin)' : (wf.decision ? 'Approved' : 'Approved (no approver above the requester)');
}

// The chain as pills. `chain` is [{ short, status, name, direct }] from the
// server (summary or view); skipped rungs are hidden in compact mode and
// shown struck-through (with their reason as a tooltip) in full mode.
export function ApprovalChainLine({ workflow, steps, compact = false }) {
  const list = steps
    ? steps.map((s) => ({ short: s.short || s.label, status: s.status, name: s.actedByName || s.approverName, direct: s.direct, note: s.note }))
    : (workflow && workflow.chain) || [];
  const shown = compact ? list.filter((s) => s.status !== 'Skipped') : list;
  if (!shown.length) return null;
  return (
    <div className={`apc-line${compact ? ' apc-line-compact' : ''}`} aria-label={workflow?.chainText || 'Approval chain'}>
      {shown.map((s, i) => (
        <span key={`${s.short}-${i}`} style={{ display: 'contents' }}>
          {i > 0 && <span className="apc-arrow" aria-hidden="true">→</span>}
          <span
            className={`apc-pill ${PILL[s.status] || ''}${s.direct ? ' is-direct' : ''}`}
            title={[s.name, s.status, s.direct ? 'Direct Super Admin decision' : '', s.note].filter(Boolean).join(' · ')}
          >
            <b>{s.short}</b>{MARK[s.status] ? <span>{MARK[s.status]}</span> : null}
          </span>
        </span>
      ))}
    </div>
  );
}

// The Approve / Reject box. Remarks are optional to approve and required to
// reject. `reasons` appears when the server asks for one (leave approvals of
// the configured length).
function DecideBox({ direct, busy, onDecide, error, reasons }) {
  const [remarks, setRemarks] = useState('');
  const [reason, setReason] = useState('');
  const [localErr, setLocalErr] = useState('');
  useEffect(() => { if (reasons && reasons.length && !reason) setReason(reasons[0]); }, [reasons]);
  function go(decision) {
    setLocalErr('');
    if (decision === 'Rejected' && !remarks.trim()) { setLocalErr('Remarks are required to reject.'); return; }
    onDecide(decision, remarks.trim(), reasons && reasons.length ? reason : undefined);
  }
  return (
    <div className={`apc-act${direct ? ' apc-act-direct' : ''}`}>
      <div className="apc-act-title">{direct ? 'Super Admin — decide directly' : 'Your decision'}</div>
      {direct && (
        <div className="apc-hint">
          This skips every level still waiting. It is recorded as a Direct Super Admin Approval with your name, the time and your remarks.
        </div>
      )}
      {reasons && reasons.length > 0 && (
        <label className="apc-hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Approval reason (required for this request)
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
      <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Remarks (required to reject)" />
      {(localErr || error) && <div className="error-text" style={{ margin: 0 }}>{localErr || error}</div>}
      <div className="apc-act-row">
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => go('Approved')}>{direct ? 'Approve directly' : 'Approve'}</button>
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => go('Rejected')}>{direct ? 'Reject directly' : 'Reject'}</button>
      </div>
    </div>
  );
}

export default function ApprovalChain({ workflow, onDecide, busy = false, error = '', reasons = null, recordStatus = null }) {
  if (!workflow) return <EmptyMini>No approval chain on this request.</EmptyMini>;
  const wf = workflow;
  const prev = (wf.previousApprovers || []).filter((p) => p.level !== 'EMPLOYEE');
  const levelText = wf.approvalLevel
    ? `${wf.approvalLevel}${wf.approvalLevelNo ? ` (step ${wf.approvalLevelNo} of ${wf.approvalLevelCount})` : ''}`
    : '—';
  return (
    <div className="apc">
      <ApprovalChainLine workflow={wf} steps={wf.steps} />

      {wf.direct && <span className="apc-direct-flag">★ {wf.directLabel || 'Direct Super Admin Approval'}</span>}

      <div className="apc-facts">
        <div><span>Submitted By</span><b>{wf.submittedBy || '—'}</b></div>
        <div><span>Submitted On</span><b>{fmtDateTime(wf.submittedAt)}</b></div>
        <div><span>Status</span><b>{wf.state !== 'Pending' && recordStatus && recordStatus !== wf.state ? `${recordStatus} · ` : ''}{stateText(wf)}</b></div>
        <div><span>Current Approver</span><b>{wf.currentApprover ? `${wf.currentApprover}` : '—'}</b></div>
        <div><span>Approval Level</span><b>{levelText}</b></div>
        <div>
          <span>{wf.decision === 'Rejected' ? 'Rejected By' : 'Approved By'}</span>
          <b>{wf.decidedBy ? `${wf.decidedBy}${wf.decidedByLevel ? ` (${wf.decidedByLevel})` : ''}` : '—'}</b>
        </div>
        <div><span>{wf.decision === 'Rejected' ? 'Rejected On' : 'Approved On'}</span><b>{fmtDateTime(wf.decidedAt)}</b></div>
        <div><span>Direct Super Admin Approval</span><b>{wf.direct ? 'Yes' : 'No'}</b></div>
        <div>
          <span>Due</span>
          <b>{wf.dueAt ? fmtDateTime(wf.dueAt) : '—'}{wf.overdue ? <> <span className="status overdue">Overdue</span></> : null}</b>
        </div>
        <div className="apc-wide">
          <span>Previous Approvers</span>
          <b>{prev.length ? prev.map((p) => `${p.label}: ${p.name} (${p.decision}${p.actedAt ? `, ${fmtDateTime(p.actedAt)}` : ''})`).join(' · ') : '—'}</b>
        </div>
        <div className="apc-wide"><span>Remarks</span><b>{wf.remarks || '—'}</b></div>
      </div>

      <div>
        <SectionLabel>Approval History</SectionLabel>
        <div className="wf-chain">
          {(wf.steps || []).map((s) => {
            const h = HISTORY[s.status] || HISTORY.Waiting;
            const current = s.status === 'Pending';
            return (
              <div key={s.id} className={`wf-step ${h.cls}${current ? ' wf-step-current' : ''}`}>
                <span className="wf-mark">{h.mark}</span>
                <span className="wf-who">
                  <b>{s.label}</b>
                  {s.approverName ? <span className="cell-muted"> – {s.approverName}</span> : null}
                  {s.direct && <> <span className="status applied">Direct Super Admin</span></>}
                  {s.actedAt && (
                    <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {s.status === 'Applied' ? 'Submitted' : s.status} by {s.actedByName || s.approverName} · {fmtDateTime(s.actedAt)}
                    </div>
                  )}
                  {s.note && <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 2 }}>{s.status === 'Skipped' ? s.note : `Remarks: ${s.note}`}</div>}
                  {current && (
                    <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                      Waiting since {fmtDateTime(s.pendingSince)}{s.dueAt ? ` · due ${fmtDateTime(s.dueAt)}` : ''}
                      {s.overdue && <> <span className="status overdue">Overdue</span></>}
                    </div>
                  )}
                </span>
                <span className="wf-state"><span className="cell-muted" style={{ fontSize: 12 }}>{h.text}</span></span>
              </div>
            );
          })}
        </div>
      </div>

      {onDecide && wf.state === 'Pending' && wf.canAct && (
        <DecideBox busy={busy} onDecide={onDecide} error={error} reasons={reasons} />
      )}
      {onDecide && wf.state === 'Pending' && !wf.canAct && wf.canDirect && (
        <DecideBox direct busy={busy} onDecide={onDecide} error={error} reasons={reasons} />
      )}
      {!onDecide && error && <div className="error-text">{error}</div>}
    </div>
  );
}

// How each request type is decided — its own router applies its own final
// side effects (leave balance, attendance correction, notice period, …).
const DECIDERS = {
  leave: (id, decision, remarks, reason) => api.patch(`/leave/${id}/decision`, decision === 'Approved'
    ? { status: 'Approved', approvalReason: reason || undefined, comment: remarks || undefined }
    : { status: 'Rejected', rejectReason: remarks }),
  regularization: (id, decision, remarks) => api.patch(`/attendance/regularizations/${id}/decision`, { status: decision, reason: remarks || undefined }),
  resignation: (id, decision, remarks) => api.patch(`/resignations/${id}/status`, { status: decision === 'Approved' ? 'Accepted' : 'Rejected', reason: remarks || undefined }),
  reward: (id, decision, remarks) => api.patch(`/performance/${id}/decision`, { status: decision, reason: remarks || undefined }),
  course: (id, decision, remarks) => api.patch(`/lms/courses/${id}/decision`, { status: decision, reason: remarks || undefined }),
};

export function ApprovalChainModal({ type, recordId, title, onClose, onChanged, children }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState(null);

  function load() {
    setLoadError('');
    api.get(`/approvals/${type}/${recordId}`)
      .then((res) => setData(res.data))
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load the approval chain'));
  }
  useEffect(load, [type, recordId]);

  async function decide(decision, remarks, reason) {
    const fn = DECIDERS[type];
    if (!fn) return;
    setError('');
    setBusy(true);
    try {
      await fn(recordId, decision, remarks, reason);
      setReasons(null);
      load();
      if (onChanged) onChanged();
    } catch (err) {
      const d = err.response?.data;
      if (d?.reasons?.length) setReasons(d.reasons);
      setError(d?.error || 'Could not record the decision');
    } finally {
      setBusy(false);
    }
  }

  const req = data?.request;
  return (
    <Modal title={title || `${req?.label || 'Request'} — Approval Chain`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loadError && <div className="error-text">{loadError}</div>}
      {!data && !loadError && <EmptyMini>Loading…</EmptyMini>}
      {data && (
        <div className="apc">
          <div className="apc-head">
            <div><span className="cell-muted">Request:</span> <b>{req.title}</b></div>
            {req.employee && (
              <div>
                <span className="cell-muted">Employee:</span> <b>{req.employee.name}</b>
                <span className="cell-muted">{req.employee.code ? ` · ${req.employee.code}` : ''}{req.employee.department ? ` · ${req.employee.department}` : ''}</span>
              </div>
            )}
          </div>
          {children}
          <ApprovalChain workflow={data.workflow} onDecide={decide} busy={busy} error={error} reasons={reasons} recordStatus={req.status} />
        </div>
      )}
    </Modal>
  );
}
