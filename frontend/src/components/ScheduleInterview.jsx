import { useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import Combo from './Combo.jsx';
import { INTERVIEW_TYPES } from '../atsVocab';

// ---------------------------------------------------------------------------
// SCHEDULE INTERVIEW (§8).
//
// The button used to be a LINK TO THE CANDIDATES PAGE. Somebody presses
// "Schedule Interview", lands on a list of candidates and has to work out what
// to do next — which is the opposite of what the button said it would do.
//
// This asks the questions in order and does the thing:
//
//   Candidate -> Requirement -> Type -> Date & Time -> Mode -> Interviewer
//
// The candidate list is the SHORTLISTED ONES FIRST, because those are the
// people an interview is actually scheduled for; everyone else in scope is
// still offered underneath, since a re-schedule or an early round is real.
// Scheduling moves the application to Interview Scheduled through the normal
// stage endpoint, so the permission check, the pipeline history and the
// automatic "confirm the candidate is attending" follow-up all happen exactly
// as they do anywhere else.
// ---------------------------------------------------------------------------

const MODES = ['In Person', 'Video Call', 'Telephonic'];

export default function ScheduleInterview({ onClose, onScheduled }) {
  const [candidates, setCandidates] = useState([]);
  const [candidateId, setCandidateId] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [form, setForm] = useState({
    interviewType: INTERVIEW_TYPES[0] || 'Client Interview',
    date: '', time: '', interviewMode: MODES[0], interviewer: '', interviewMeetingLink: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/candidates')
      .then((r) => setCandidates(Array.isArray(r.data) ? r.data : (r.data.rows || [])))
      .catch(() => setCandidates([]));
  }, []);

  // Shortlisted first — those are the people this button exists for.
  const READY = ['CLIENT_SHORTLISTED', 'CLIENT_REVIEW', 'SHARED_WITH_CLIENT'];
  const ready = candidates.filter((c) => READY.includes(c.currentStage));
  const others = candidates.filter((c) => !READY.includes(c.currentStage) && c.latestApplicationId);

  const chosen = candidates.find((c) => c.id === candidateId);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  function pickCandidate(id) {
    setCandidateId(id);
    const c = candidates.find((x) => x.id === id);
    setApplicationId(c ? (c.latestApplicationId || '') : '');
  }

  async function submit() {
    setError(''); setBusy(true);
    try {
      // The NORMAL stage endpoint, so permissions, pipeline history and the
      // automatic follow-up all behave exactly as they do elsewhere.
      await api.patch(`/applications/${applicationId}/stage`, {
        stage: 'INTERVIEW_SCHEDULED',
        interviewAt: form.date ? `${form.date}T${form.time || '10:00'}:00` : undefined,
        interviewer: form.interviewer || undefined,
        interviewMode: form.interviewMode || undefined,
        interviewMeetingLink: form.interviewMeetingLink || undefined,
      });
      onScheduled();
    } catch (err) {
      setError(err.response?.data?.error || 'That interview could not be scheduled.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Schedule Interview"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || !applicationId || !form.date}
          onClick={submit}
        >
          {busy ? 'Scheduling…' : 'Confirm'}
        </button>
      </>}
    >
      <div className="field">
        <label>Candidate</label>
        <Combo value={candidateId} onChange={(e) => pickCandidate(e.target.value)}>
          <option value="">Choose a candidate…</option>
          {ready.length > 0 && (
            <optgroup label="Shortlisted — ready to interview">
              {ready.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.requirementTitle || 'no requirement'}</option>)}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Others in your scope">
              {others.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.requirementTitle || 'no requirement'}</option>)}
            </optgroup>
          )}
        </Combo>
      </div>

      {/* The requirement is not a second question — it is the application the
          candidate was chosen for. Shown so the person can see which one. */}
      {chosen && (
        <div className="notice">
          Requirement: <b>{chosen.requirementTitle || '—'}</b>
          {chosen.clientName ? <> · Client: <b>{chosen.clientName}</b></> : null}
          {chosen.currentStage ? <> · Currently: {chosen.stageGroupLabel || chosen.currentStage}</> : null}
        </div>
      )}

      <div className="grid-2">
        <div className="field">
          <label>Interview type</label>
          <Combo value={form.interviewType} onChange={(e) => set({ interviewType: e.target.value })}>
            {INTERVIEW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Combo>
        </div>
        <div className="field">
          <label>Mode</label>
          <Combo value={form.interviewMode} onChange={(e) => set({ interviewMode: e.target.value })}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </Combo>
        </div>
        <div className="field">
          <label>Date *</label>
          <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
        </div>
        <div className="field">
          <label>Time</label>
          <input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
        </div>
        <div className="field">
          <label>Interviewer</label>
          <input value={form.interviewer} onChange={(e) => set({ interviewer: e.target.value })} />
        </div>
        <div className="field">
          <label>Meeting link / location</label>
          <input value={form.interviewMeetingLink} onChange={(e) => set({ interviewMeetingLink: e.target.value })} />
        </div>
      </div>

      <div className="small-muted">
        Confirming moves the candidate to <b>Interview Scheduled</b> and raises the follow-up to confirm they
        are attending.
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
