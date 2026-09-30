import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal.jsx';
import Combo from './Combo.jsx';
import { workflowStages } from '../permissions';
import {
  stageLabel, INTERVIEW_MODES, HOLD_REASON_CATEGORIES, REJECTED_BY_OPTIONS,
  REJECTION_REASONS_BY_SIDE, REJECTION_REASON_CATEGORIES,
} from '../atsVocab';

// ---------------------------------------------------------------------------
// BULK ACTIONS on the selected candidates (spec §25):
//   assign     Assign Recruiter      recruiterbde / Team View / assign
//   stage      Change Stage          any stage this login owns
//   interview  Schedule Interview    -> Interview Scheduled, with the slot
//   hold       Put on Hold           reason required
//   reject     Reject                whose decision + reason required
//
// Every row goes through POST /applications/bulk, which runs the SAME rules
// as a single move (permission, stage ownership, scope, one-phase chain) per
// row and reports each one. Sent in batches of 50; the result lists what
// moved and why anything did not.
//
// items: [{ id, latestApplicationId, name }]
// ---------------------------------------------------------------------------
const BATCH = 50;
const TITLES = {
  assign: 'Assign recruiter',
  stage: 'Change stage',
  interview: 'Schedule interview',
  hold: 'Put on hold',
  reject: 'Reject',
};

export default function CandidateBulkActions({ kind, items, user, onClose, onDone }) {
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState({
    recruiterId: '', stage: '', interviewAt: '', interviewMode: INTERVIEW_MODES[0], interviewer: '',
    interviewMeetingLink: '', rejectedBy: '', reasonCategory: '', reasonDetail: '', comment: '',
  });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (kind !== 'assign') return;
    api.get('/requirements/assignable-people')
      .then((r) => setPeople((r.data || []).filter((p) => ['RECRUITER', 'TL', 'STL'].includes(p.atsRole))))
      .catch(() => setPeople([]));
  }, [kind]);

  const movable = workflowStages(user).filter((s) => !['HOLD', 'REJECTED'].includes(s));

  function body() {
    if (kind === 'assign') return { action: 'assign', recruiterId: form.recruiterId, comment: form.comment };
    if (kind === 'stage') return { action: 'stage', stage: form.stage, comment: form.comment };
    if (kind === 'interview') {
      return {
        action: 'stage',
        stage: 'INTERVIEW_SCHEDULED',
        interviewAt: form.interviewAt ? new Date(form.interviewAt).toISOString() : undefined,
        interviewMode: form.interviewMode,
        interviewer: form.interviewer || undefined,
        interviewMeetingLink: form.interviewMeetingLink || undefined,
        comment: form.comment,
      };
    }
    if (kind === 'hold') {
      return { action: 'stage', stage: 'HOLD', reasonCategory: form.reasonCategory, reasonDetail: form.reasonDetail, comment: form.comment };
    }
    return {
      action: 'stage', stage: 'REJECTED', rejectedBy: form.rejectedBy,
      reasonCategory: form.reasonCategory, reasonDetail: form.reasonDetail, comment: form.comment,
    };
  }

  const ready = (kind === 'assign' && form.recruiterId)
    || (kind === 'stage' && form.stage)
    || (kind === 'interview' && form.interviewAt)
    || (kind === 'hold' && form.reasonCategory)
    || (kind === 'reject' && form.rejectedBy && form.reasonCategory);

  async function run() {
    setError('');
    setBusy(true);
    setProgress(0);
    const all = [];
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH);
        const applicationIds = chunk.filter((x) => x.latestApplicationId).map((x) => x.latestApplicationId);
        const candidateIds = chunk.filter((x) => !x.latestApplicationId).map((x) => x.id);
        // eslint-disable-next-line no-await-in-loop
        const res = await api.post('/applications/bulk', { ...body(), applicationIds, candidateIds });
        all.push(...(res.data.results || []));
        setProgress(Math.min(items.length, i + BATCH));
      }
      setResult(all);
      if (all.some((x) => x.ok) && onDone) onDone();
    } catch (err) {
      // A refusal of the whole action (no permission for this stage, etc.).
      setError(err.response?.data?.error || 'The action could not be completed.');
      if (all.length) setResult(all);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const okRows = result.filter((x) => x.ok);
    const bad = result.filter((x) => !x.ok);
    const notes = okRows.filter((x) => x.note);
    return (
      <Modal
        title={`${TITLES[kind]} — done`}
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}
      >
        <div className={`notice${bad.length ? ' amber' : ''}`}>
          <b>{okRows.length}</b> of {result.length} done.
          {bad.length > 0 && <> <b>{bad.length}</b> not changed — reasons below.</>}
        </div>
        {error && <div className="error-text">{error}</div>}
        {notes.length > 0 && (
          <div className="small-muted" style={{ margin: '8px 0' }}>{notes[0].note}</div>
        )}
        {bad.length > 0 && (
          <div className="cbulk-results">
            {bad.map((x, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={`${x.candidateId}-${i}`} className="cbulk-row">
                <span>{x.candidateName || x.candidateId}</span>
                <span className="small-muted">{x.error}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={`${TITLES[kind]} — ${items.length} candidate${items.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={`btn ${kind === 'reject' ? 'btn-danger' : 'btn-primary'}`}
            disabled={!ready || busy}
            onClick={run}
          >
            {busy ? `Working… ${progress}/${items.length}` : `${TITLES[kind]} (${items.length})`}
          </button>
        </>
      )}
    >
      {kind === 'assign' && (
        <>
          <label className="field">
            <span>Recruiter *</span>
            <Combo value={form.recruiterId} onChange={(e) => set({ recruiterId: e.target.value })}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {`${p.name}${p.seat ? ` · ${p.seat.code || p.seat}` : ''}${p.atsDepartment ? ` · ${p.atsDepartment}` : ''}`}
                </option>
              ))}
            </Combo>
          </label>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            They become the owner of each candidate&apos;s current follow-up (the previous one is closed and kept in
            the history). Only people in your own team are offered and accepted.
          </div>
        </>
      )}

      {kind === 'stage' && (
        <>
          <label className="field">
            <span>Move to *</span>
            <Combo value={form.stage} onChange={(e) => set({ stage: e.target.value })}>
              <option value="">Choose…</option>
              {movable.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
            </Combo>
          </label>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Only the stages your role owns are listed. The workflow moves one phase at a time, so a candidate who is
            not at the step before this one is skipped and listed with the reason.
          </div>
        </>
      )}

      {kind === 'interview' && (
        <div className="grid-2">
          <label className="field">
            <span>Date &amp; time *</span>
            <input type="datetime-local" value={form.interviewAt} onChange={(e) => set({ interviewAt: e.target.value })} />
          </label>
          <label className="field">
            <span>Mode</span>
            <Combo value={form.interviewMode} onChange={(e) => set({ interviewMode: e.target.value })}>
              {INTERVIEW_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Interviewer</span>
            <input value={form.interviewer} onChange={(e) => set({ interviewer: e.target.value })} />
          </label>
          <label className="field">
            <span>Meeting link</span>
            <input value={form.interviewMeetingLink} onChange={(e) => set({ interviewMeetingLink: e.target.value })} />
          </label>
        </div>
      )}

      {kind === 'reject' && (
        <div className="field">
          <span>Rejected by *</span>
          <div className="contact-methods">
            {REJECTED_BY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                title={o.hint}
                className={`contact-method${form.rejectedBy === o.value ? ' is-on' : ''}`}
                onClick={() => set({ rejectedBy: o.value, reasonCategory: '' })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {(kind === 'hold' || kind === 'reject') && (
        <>
          <label className="field">
            <span>Reason *</span>
            <Combo
              creatable
              disabled={kind === 'reject' && !form.rejectedBy}
              value={form.reasonCategory}
              onChange={(e) => set({ reasonCategory: e.target.value })}
            >
              <option value="">{kind === 'reject' && !form.rejectedBy ? 'Choose who rejected first' : 'Choose…'}</option>
              {(kind === 'reject'
                ? (REJECTION_REASONS_BY_SIDE[form.rejectedBy] || REJECTION_REASON_CATEGORIES)
                : HOLD_REASON_CATEGORIES).map((x) => <option key={x} value={x}>{x}</option>)}
            </Combo>
          </label>
          <label className="field">
            <span>Detailed reason</span>
            <textarea rows="2" value={form.reasonDetail} onChange={(e) => set({ reasonDetail: e.target.value })} />
          </label>
        </>
      )}

      <label className="field">
        <span>Comment</span>
        <input value={form.comment} onChange={(e) => set({ comment: e.target.value })} placeholder="Optional — kept on each candidate's history" />
      </label>
      {kind === 'reject' && (
        <div className="small-muted">Rejected candidates stay in the Candidate Master — nothing is deleted.</div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
