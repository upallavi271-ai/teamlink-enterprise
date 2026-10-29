import { useState } from 'react';
import api from '../../../api';
import Modal from '../../Modal.jsx';
import Combo from '../../Combo.jsx';
import PostStep, { placesFromSources } from './PostStep.jsx';
import { useRecruiterBench, benchPeople } from '../assignPeople.jsx';
import '../../clients/clientForm.css';
import '../../clients/addClientModal.css';
import './reqsplit.css';

// The Post step on its own, for a job that is already saved ("Post this job" on the job page): sites, logins, dry run, results.
// Founder 2026-10-29: the TL posts the requirement and, while posting, picks the recruiter who gets ALL its responses
// (POST /requirements/:id/assign: every response becomes that recruiter's - utils/applicationOwner.js). After posting:
// "Successfully posted. Now all the responses will come to <name>."
const SAVED_ONLY_START = 'Saved. Nothing was posted yet';

export default function PostStepDialog({ job, sources = [], onClose, onChanged, startTargets = null }) {
  const bench = useRecruiterBench(job.tlId || '', true, job.department || '');
  const people = benchPeople(bench);
  const [pick, setPick] = useState(job.recruiterId || '');
  const [owner, setOwner] = useState(null); // { id, name } once confirmed
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [posted, setPosted] = useState(false);
  const close = () => { onClose(); if (onChanged) onChanged(); };
  const nameOf = (id) => (people.find((p) => p.id === id) || {}).name || (id === job.recruiterId ? (job.recruiter && job.recruiter.name) : '') || 'the recruiter';

  async function confirm() {
    if (!pick) { setErr('Pick the recruiter who gets the responses.'); return; }
    setBusy(true); setErr('');
    try {
      if (pick !== job.recruiterId) await api.post(`/requirements/${job.id}/assign`, { recruiterId: pick });
      setOwner({ id: pick, name: nameOf(pick) });
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not set the recruiter. Please try again.');
    } finally { setBusy(false); }
  }
  const done = (res) => {
    const summary = res && res.summary ? String(res.summary) : '';
    if (summary && !summary.startsWith(SAVED_ONLY_START)) { setPosted(true); if (onChanged) onChanged(); return; }
    close();
  };

  let body;
  if (posted) {
    body = (
      <div className="notice green" role="status" style={{ margin: 16 }}>
        <b>Successfully posted.</b>
        {` Now all the responses will come to ${owner ? owner.name : 'the recruiter'}.`}
      </div>
    );
  } else if (!owner) {
    body = (
      <div style={{ padding: 16, maxWidth: 520 }}>
        <label className="field">
          <span>Assign a recruiter — every response to this posting goes to them</span>
          <Combo value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{bench ? (people.length ? 'Pick a recruiter' : 'No recruiter in your team') : 'Loading…'}</option>
            {(bench && bench.groups ? bench.groups : []).map((g) => (
              <optgroup key={g.key} label={g.label}>
                {g.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            ))}
          </Combo>
        </label>
        <div className="small-muted" style={{ marginTop: 6 }}>Only this recruiter sees the responses. Other recruiters do not.</div>
        {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || !pick} onClick={confirm}>
          {busy ? 'Saving…' : 'Next — choose where to post'}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <div className="small-muted" style={{ padding: '8px 16px 0' }}>{`Responses go to: ${owner.name}`}</div>
        <PostStep job={job} initial={placesFromSources(sources)} startTargets={startTargets} onDone={done} stay />
      </>
    );
  }

  return (
    <Modal
      title={`Post this requirement — ${job.title}`}
      size="xwide acw-modal"
      onClose={close}
      footer={(
        <div className="cf-bar">
          {posted
            ? <button type="button" className="btn btn-primary" onClick={close}>Close</button>
            : <span className="cf-bar-note">Nothing is called Posted until the site really shows the requirement.</span>}
        </div>
      )}
    >
      <div className="acw-wrap" style={{ display: 'block', overflowY: 'auto' }}>
        <div className="acw-form" style={{ overflow: 'visible' }}>{body}</div>
      </div>
    </Modal>
  );
}
