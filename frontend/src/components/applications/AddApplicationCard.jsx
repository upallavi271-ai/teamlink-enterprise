import { useRef, useState } from 'react';
import { JobPickerCombo, jobLabel } from '../JobPicker.jsx';
import { usePairCheck, AlreadyAppliedNotice } from './AlreadyApplied.jsx';

// ---------------------------------------------------------------------------
// "ADD APPLICATION" on a person's profile (Applications tab): pick a job from the
// dropdown OR type its name, code (REQ-...) or client. The moment a job is picked
// the pair is checked, so 'already on this job' is shown BEFORE the click, with
// [Open this application]. The button is locked while it works (no double add).
// onAddToJob(requirementId) comes from the profile slots; it throws on a refusal
// (api.js has already opened the 'Already on this job' box for a duplicate).
// ---------------------------------------------------------------------------
const label = (r) => `${r.reqCode ? `${r.reqCode} · ` : ''}${jobLabel(r)}`;

export default function AddApplicationCard({ c, onAddToJob }) {
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const check = usePairCheck(c.id, jobId);
  const stop = check.exists || !!check.blocked;

  async function go() {
    if (!jobId || lock.current || stop) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaid('');
    try {
      await onAddToJob(jobId);
      setSaid(`${c.name} is added to the requirement. It shows in this person's applications now.`);
      setJobId('');
    } catch (err) {
      if (!err.alreadyApplied) setError((err.response && err.response.data && err.response.data.error) || 'Could not add this person to the requirement. Please try again.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="c360t-card">
      <div className="c360t-label">Add application</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: '1 1 320px', minWidth: 220 }}>
          <JobPickerCombo value={jobId} onChange={(e) => { setJobId(e.target.value); setSaid(''); setError(''); }} blank="Pick a requirement, or type a title, code or client" labelOf={label} />
        </div>
        <button type="button" className="btn btn-primary" disabled={!jobId || busy || stop || check.loading} onClick={go}>
          {busy ? 'Adding...' : 'Add application'}
        </button>
      </div>
      {jobId && <AlreadyAppliedNotice check={check} name={c.name} />}
      {said && <div className="notice green" style={{ marginTop: 8 }}>{said}</div>}
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
