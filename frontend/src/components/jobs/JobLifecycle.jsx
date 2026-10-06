import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './jobops.css';

// ---------------------------------------------------------------------------
// JOB PAUSE / CLOSE / DELETE (ATS change list 2026-10-03 §5).
//
//   Pause  = on hold, with a reason and a date to look at it again
//   Close  = Filled or Cancelled
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

export function JobLifecycleDialog({ kind, job, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(inDays(7));
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = job.reqCode || job.title || 'this job';

  async function save() {
    setBusy(true); setError('');
    try {
      const res = kind === 'pause'
        ? await api.post(`/requirements/${job.id}/pause`, { reason, until })
        : await api.post(`/requirements/${job.id}/close`, { outcome, note: reason });
      onDone(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const ready = kind === 'pause' ? reason.trim().length >= 3 && !!until : (outcome === 'filled' || (outcome === 'cancelled' && reason.trim().length >= 3));
  return (
    <Modal
      title={kind === 'pause' ? `Pause ${name}` : `Close ${name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${kind === 'close' ? 'btn-danger' : 'btn-primary'}`} onClick={save} disabled={!ready || busy}>
            {busy ? 'Saving…' : kind === 'pause' ? 'Pause job' : 'Close job'}
          </button>
        </>
      )}
    >
      <div className="jobops">
        {kind === 'pause' ? (
          <>
            <p className="jobops-lead">The job goes off the job sites. Nobody new can be added until you resume it.</p>
            <label className="field">
              <span>Why? *</span>
              <input value={reason} maxLength={300} placeholder="For example: client asked to wait" onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className="field">
              <span>Look at it again on *</span>
              <input type="date" value={until} min={inDays(0)} onChange={(e) => setUntil(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="jobops-lead">Why is the job closing?</p>
            <div className="jobops-choice">
              <button type="button" className={`jobops-pick${outcome === 'filled' ? ' is-on' : ''}`} onClick={() => setOutcome('filled')}>
                <b>Filled</b><span>We gave the client the people they needed.</span>
              </button>
              <button type="button" className={`jobops-pick${outcome === 'cancelled' ? ' is-on' : ''}`} onClick={() => setOutcome('cancelled')}>
                <b>Cancelled</b><span>The client no longer needs it.</span>
              </button>
            </div>
            <label className="field">
              <span>{outcome === 'cancelled' ? 'Why was it cancelled? *' : 'Note (optional)'}</span>
              <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
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
  const job = { id: lc.id, reqCode: null, title: 'this job' };

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
    if (!window.confirm('Delete this job for good? This cannot be undone.')) return;
    setBusy(true); setError('');
    try {
      await api.delete(`/requirements/${requirementId}`);
      if (onDeleted) onDeleted();
    } catch (e) {
      setError(e.response?.data?.error || 'The job could not be deleted.');
    } finally {
      setBusy(false);
    }
  }

  const any = r.pause || r.resume || r.close || r.reopen || r.delete;
  return (
    <div className="jobops jobops-bar">
      {lc.hold && (
        <div className={`jobops-state ${lc.hold.late ? 'is-red' : 'is-orange'}`}>
          <StatusChip tone={lc.hold.late ? 'red' : 'amber'}>{lc.hold.late ? 'Pause date passed' : 'Paused'}</StatusChip>
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
          <StatusChip tone={lc.closed.outcome === 'Filled' ? 'green' : 'grey'}>{lc.closed.outcome ? `Closed · ${lc.closed.outcome}` : 'Closed'}</StatusChip>
          <span>
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
          {r.resume && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => post('resume', 'Resumed.')}>Resume job</button>}
          {r.reopen && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => post('reopen', 'Reopened.')}>Reopen job</button>}
          {r.pause && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDialog('pause')}>Pause</button>}
          {r.close && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDialog('close')}>Close job</button>}
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
