import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './jobops.css';

// ---------------------------------------------------------------------------
// JOB PAUSE / CLOSE / DELETE (ATS change list 2026-10-03 §5).
//
//   Close  = ONE dialog with a REASON: Filled / Client cancelled / On hold (paused) / Other  (2026-10-13: a job is only
//            Open or Closed; Pause is gone, "On hold" is a close reason; Reopen brings a closed job back)
//   Delete = Super Admin only, and never while people are on the job
//
// The server decides who may press what (GET /requirements/:id/lifecycle,
// routes/jobLifecycleRoutes.js); these components only draw what it allows,
// and say in plain words what happened.
//
//   <JobLifecycleBar requirementId onChanged onDeleted />   job page
//   <JobLifecycleDialog kind="pause"|"close" job onClose onDone />  any list
// ---------------------------------------------------------------------------
const inDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const niceDay = (s) => (s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// WHY a job closes. A reason kept with the close, never a status: the job is simply Closed.
const CLOSE_REASONS = [
  { key: 'filled', label: 'Filled', hint: 'We gave the client the people they needed.' },
  { key: 'cancelled', label: 'Client cancelled', hint: 'The client no longer needs it.' },
  { key: 'paused', label: 'On hold (paused)', hint: 'Stopped for now. You can reopen it later.' },
  { key: 'other', label: 'Other', hint: 'Something else. Say what in the note.' },
];

export function JobLifecycleDialog({ kind, job, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(inDays(7));
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = job.reqCode || job.title || 'this requirement';

  async function save() {
    setBusy(true); setError('');
    try {
      const res = kind === 'pause'
        ? await api.post(`/requirements/${job.id}/pause`, { reason, until })
        : kind === 'closeRequest'
          ? await api.post(`/requirements/${job.id}/close-request`, { outcome, note: reason })
          : kind === 'recruiter'
            ? await api.post(`/requirements/${job.id}/recruiter-request`, { note: reason })
            : await api.post(`/requirements/${job.id}/close`, { outcome, note: reason });
      onDone(kind === 'closeRequest' || kind === 'recruiter' ? { ok: res.data?.message || 'Sent.' } : res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const ready = kind === 'pause' ? reason.trim().length >= 3 && !!until
    : kind === 'recruiter' ? reason.trim().length >= 3
      : kind === 'closeRequest' ? (!!outcome && reason.trim().length >= 3)
        : (outcome === 'filled' || outcome === 'paused' || ((outcome === 'cancelled' || outcome === 'other') && reason.trim().length >= 3));
  const asking = kind === 'closeRequest' || kind === 'recruiter';
  const title = kind === 'pause' ? `Pause ${name}` : kind === 'closeRequest' ? `Ask to close ${name}` : kind === 'recruiter' ? `Ask for a recruiter — ${name}` : `Close ${name}`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${kind === 'close' ? 'btn-danger' : 'btn-primary'}`} onClick={save} disabled={!ready || busy}>
            {busy ? 'Saving…' : kind === 'pause' ? 'Pause requirement' : asking ? 'Send request' : 'Close requirement'}
          </button>
        </>
      )}
    >
      <div className="jobops">
        {kind === 'pause' ? (
          <>
            <p className="jobops-lead">The requirement goes off the job sites. Nobody new can be added until you resume it.</p>
            <label className="field">
              <span>Why?</span>
              <input value={reason} maxLength={300} placeholder="For example: client asked to wait" onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className="field">
              <span>Look at it again on</span>
              <input type="date" value={until} min={inDays(0)} onChange={(e) => setUntil(e.target.value)} />
            </label>
          </>
        ) : kind === 'recruiter' ? (
          <>
            <p className="jobops-lead">Your team lead picks the recruiter. Tell them what you need.</p>
            <label className="field">
              <span>What do you need?</span>
              <input value={reason} maxLength={300} placeholder="For example: someone who knows school hiring" onChange={(e) => setReason(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="jobops-lead">{kind === 'closeRequest' ? 'A Manager or an Admin approves closing a requirement. Why should it close?' : 'Why is the requirement closing?'}</p>
            <div className="jobops-choice">
              {CLOSE_REASONS.map((c) => (
                <button key={c.key} type="button" className={`jobops-pick${outcome === c.key ? ' is-on' : ''}`} onClick={() => setOutcome(c.key)}>
                  <b>{c.label}</b><span>{c.hint}</span>
                </button>
              ))}
            </div>
            <label className="field">
              <span>{kind === 'closeRequest' ? 'Tell the approver what happened' : outcome === 'cancelled' ? 'Why did the client cancel?' : outcome === 'other' ? 'What is the reason?' : 'Note (optional)'}</span>
              <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              {((outcome === 'cancelled' || outcome === 'other') && reason.trim().length < 3) && <div className="rf-missing-note">Please write a few words.</div>}
            </label>
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

export function JobLifecycleBar({ requirementId, onChanged, onDeleted }) {
  const [lc, setLc] = useState(null);
  const [dialog, setDialog] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/requirements/${requirementId}/lifecycle`).then((r) => setLc(r.data)).catch(() => setLc(false));
  useEffect(() => { setLc(null); load(); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!lc) return null;
  const r = lc.rights || {};
  const job = { id: lc.id, reqCode: null, title: 'this requirement' };

  async function post(path, okDefault) {
    setBusy(true); setError(''); setNote('');
    try {
      const res = await api.post(`/requirements/${requirementId}/${path}`, {});
      setLc(res.data.lifecycle);
      setNote(res.data.ok || okDefault);
      if (onChanged) onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this requirement for good? It is removed and cannot be brought back. A requirement with people or invoices on it cannot be deleted - close it instead.')) return;
    setBusy(true); setError('');
    try {
      await api.delete(`/requirements/${requirementId}`);
      if (onDeleted) onDeleted();
    } catch (e) {
      setError(e.response?.data?.error || 'The requirement could not be deleted.');
    } finally {
      setBusy(false);
    }
  }

  const any = r.pause || r.resume || r.close || r.reopen || r.delete || r.requestClose || r.requestRecruiter || r.closeRequested;
  return (
    <div className="jobops jobops-bar">
      {lc.hold && (
        <div className={`jobops-state ${lc.hold.late ? 'is-red' : 'is-orange'}`}>
          <span className="small-muted"><b>{lc.hold.late ? 'Pause date passed.' : 'Paused for now.'}</b></span>
          <span>
            {lc.hold.reason ? `“${lc.hold.reason}”` : 'No reason was written.'}
            {lc.hold.until ? ` · look again on ${niceDay(lc.hold.until)}` : ''}
            {lc.hold.by ? ` · by ${lc.hold.by}` : ''}
            {lc.hold.late ? ' — resume or close it.' : ''}
          </span>
        </div>
      )}
      {lc.closed && (
        <div className="jobops-state">
          <StatusChip tone="grey">Closed</StatusChip>
          <span>
            {lc.closed.outcome ? `Reason: ${lc.closed.outcome}. ` : ''}
            {lc.closed.note ? `“${lc.closed.note}”` : ''}
            {lc.closed.by ? ` by ${lc.closed.by}` : ''}
            {lc.closed.at ? `, ${niceDay(lc.closed.at)}` : ''}
          </span>
        </div>
      )}
      {lc.client && lc.client.paused && (
        <div className="jobops-state is-orange">
          <StatusChip tone="amber">Client paused</StatusChip>
          <span>{lc.client.message}</span>
        </div>
      )}
      {any && (
        <div className="jobops-actions">
          {r.resume && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => post('resume', 'Resumed.')}>Resume requirement</button>}
          {r.reopen && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => post('reopen', 'Reopened.')}>Reopen requirement</button>}
          {r.pause && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDialog('pause')}>Pause</button>}
          {r.close && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDialog('close')}>Close requirement</button>}
          {r.requestClose && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDialog('closeRequest')}>Ask to close</button>}
          {r.closeRequested && <StatusChip tone="amber">Close request waiting</StatusChip>}
          {r.requestRecruiter && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDialog('recruiter')}>Ask for a recruiter</button>}
          {r.delete && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>Delete for good</button>}
        </div>
      )}
      {r.deleteBlocked && <div className="small-muted">{r.deleteBlocked}</div>}
      {note && <div className="jobops-ok" role="status">{note}</div>}
      {error && <div className="error-text">{error}</div>}
      {dialog && (
        <JobLifecycleDialog
          kind={dialog}
          job={job}
          onClose={() => setDialog('')}
          onDone={(res) => {
            setDialog('');
            if (res.lifecycle) setLc(res.lifecycle);
            setNote(res.ok || 'Saved.');
            if (onChanged) onChanged();
          }}
        />
      )}
    </div>
  );
}
