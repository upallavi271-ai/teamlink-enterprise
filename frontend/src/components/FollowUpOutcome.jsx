import { useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// "WHAT HAPPENED? / WHAT NEXT?" (§8, §9).
//
// This is the half that stops a follow-up ending in "we called them... and now
// nobody knows what happens". Two answers, both from a list, and where the next
// step implies another touch the DATE IS REQUIRED — the server refuses without
// it, and this dialog says so before the user gets there.
//
// Saving does two things in one call: it closes this follow-up with the answers
// on it, and it OPENS THE NEXT ONE where a date was given. Nobody has to
// remember to raise it.
//
// The outcome list is filtered by CONTEXT on the way in: a client chase is not
// offered "Joining Confirmed", and a candidate call is not offered "Client
// Decision Received". Showing every option to everybody is how a picker becomes
// noise.
// ---------------------------------------------------------------------------

const CONTEXT_OUTCOMES = {
  candidate: [
    'Answered', 'Interested', 'Not Interested', 'Requested Later',
    'No Response', 'Call Back', 'Interview Confirmed', 'Joining Confirmed',
  ],
  client: [
    'Answered', 'Requested Later', 'No Response', 'Call Back', 'Client Decision Received',
  ],
};

export default function FollowUpOutcome({
  followUpId, who, context = 'candidate', contactMode, onClose, onSaved,
}) {
  const [vocab, setVocab] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/followups/statuses').then((r) => setVocab(r.data)).catch(() => setVocab(null));
  }, []);

  const allOutcomes = vocab ? vocab.outcomes : [];
  const allowed = CONTEXT_OUTCOMES[context] || allOutcomes;
  const outcomes = allOutcomes.filter((o) => allowed.includes(o));
  const nextSteps = vocab ? vocab.nextSteps : [];
  const needsDate = !!(vocab && nextStep && vocab.nextStepsNeedingDate.includes(nextStep));

  async function save() {
    setError(''); setBusy(true);
    try {
      const res = await api.post(`/followups/${followUpId}/complete`, {
        outcome, nextStep, note, contactMode,
        nextFollowUpAt: date || undefined,
        nextFollowUpTime: time || undefined,
      });
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'That could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`What happened — ${who}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || !outcome || !nextStep || (needsDate && !date)}
          onClick={save}
        >
          {busy ? 'Saving…' : 'Save follow-up'}
        </button>
      </>}
    >
      <div className="field">
        <label>What happened?</label>
        <Combo value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">Choose…</option>
          {outcomes.map((o) => <option key={o} value={o}>{o}</option>)}
        </Combo>
      </div>

      <div className="field">
        <label>What should happen next?</label>
        <Combo value={nextStep} onChange={(e) => { setNextStep(e.target.value); setError(''); }}>
          <option value="">Choose…</option>
          {nextSteps.map((s) => <option key={s} value={s}>{s}</option>)}
        </Combo>
      </div>

      {needsDate && (
        <>
          <div className="grid-2">
            <div className="field">
              <label>Next follow-up date *</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label>Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            &quot;{nextStep}&quot; needs a date — otherwise nobody knows when it is owed. The next follow-up is
            created for you the moment you save.
          </div>
        </>
      )}
      {nextStep === 'No further action' && (
        <div className="small-muted" style={{ marginBottom: 8 }}>
          This closes the chain on this candidate. Nothing further will be raised.
        </div>
      )}

      <div className="field">
        <label>Notes</label>
        <textarea rows="3" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
