import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import Modal from '../Modal.jsx';
import AiCallDialog from '../aicalling/AiCallDialog.jsx';
import { errorOf } from '../aicalling/aiCallingShared.js';

// ---------------------------------------------------------------------------
// JOB MATCH - Job Portal AI calling (founder 2026-10-30: "job portal ai calling separate ... candidates ki job
// eligibilities ki ... to find candidates for different job opportunities").
//   person given  -> their matching live requirements (GET /candidates/:id/matching-requirements, the ATS scorer, 50%+)
//   no person     -> pick a live requirement -> the Job Portal applicants who fit it (GET /job-portal/job-match)
// "Add and AI call": each person is added to the requirement through the normal Add (POST /applications: scope, duplicate,
// paused job / client, Do-not-use and the fit rules - a person who fails a rule needs a reason), then the AI assistant calls
// them about THAT requirement (purpose 'Job Match', the screening talk with its own opening line).
// ---------------------------------------------------------------------------
export default function JobMatchDialog({ person, onClose, onDone }) {
  const [jobs, setJobs] = useState(null);
  const [jobId, setJobId] = useState('');
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState({});
  const [reason, setReason] = useState('');
  const [need, setNeed] = useState([]); // people who need a reason: [{ name, why }]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [skipped, setSkipped] = useState([]);
  const [callIds, setCallIds] = useState(null);

  // person -> their matching requirements
  useEffect(() => {
    if (!person) return;
    api.get(`/candidates/${person.candidateId}/matching-requirements`, { params: { limit: 30 } })
      .then((r) => setRows((r.data.rows || []).map((x) => ({
        key: x.id, requirementId: x.id, candidateId: person.candidateId,
        title: [x.reqCode, x.title].filter(Boolean).join(' · '),
        sub: [x.client && x.client.name, x.location].filter(Boolean).join(' · '), fit: x.fit,
      }))))
      .catch((e) => setErr(errorOf(e, 'Could not load the matching requirements.')));
  }, [person]);
  // no person -> the live requirements to pick from
  useEffect(() => {
    if (person) return;
    api.get('/ai-calling/jobs').then((r) => setJobs(r.data.rows || [])).catch((e) => setErr(errorOf(e, 'Could not load your requirements.')));
  }, [person]);
  useEffect(() => {
    if (person || !jobId) return;
    setRows(null); setPicked({});
    api.get('/job-portal/job-match', { params: { requirementId: jobId } })
      .then((r) => setRows((r.data.rows || []).map((x) => ({
        key: x.candidateId, requirementId: jobId, candidateId: x.candidateId, title: x.name,
        sub: [x.location, x.experienceYears != null && `${x.experienceYears} yrs`, x.appliedFor && `applied for ${x.appliedFor}`].filter(Boolean).join(' · '), fit: x.fit,
      }))))
      .catch((e) => setErr(errorOf(e, 'Could not load the matching people.')));
  }, [person, jobId]);

  const chosen = (rows || []).filter((r) => picked[r.key]);
  const go = async () => {
    setBusy(true); setErr(''); setSkipped([]);
    const ids = []; const skip = []; const needWhy = [];
    for (const r of chosen) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await api.post('/applications', { candidateId: r.candidateId, requirementId: r.requirementId, comment: 'Job match (Job Portal AI calling)', ...(reason.trim() ? { overrideReason: reason.trim() } : {}) });
        ids.push(res.data.id);
      } catch (e) {
        const d = (e.response && e.response.data) || {};
        if (d.code === 'NEEDS_OVERRIDE') needWhy.push({ name: person ? r.title : r.title, why: (d.why || []).join('; ') });
        else skip.push({ name: r.title, why: errorOf(e, 'Could not add.') });
      }
    }
    setBusy(false); setSkipped(skip); setNeed(needWhy);
    if (ids.length) { setCallIds(ids); if (onDone) onDone(); }
  };

  if (callIds) return <AiCallDialog applicationIds={callIds} purpose="Job Match" onClose={onClose} onDone={onDone} />;
  return (
    <Modal
      title={person ? `Other matching jobs for ${person.name}` : 'Job match: find Job Portal people for a requirement'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" disabled={busy || !chosen.length} onClick={go}>
            {busy ? 'Adding…' : `Add to the requirement and AI call${chosen.length > 1 ? ` (${chosen.length})` : ''}`}
          </button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 8 }}>
        {person
          ? 'Live requirements this person fits (50% or more), best first. Pick one: they are added to it and the AI assistant tells them about it.'
          : 'Pick a live requirement. The people from the Job Portal list who fit it (50% or more) and are not on it yet are shown. Tick them: they are added to it and the AI assistant calls them.'}
      </div>
      {err && <div className="notice red">{err}</div>}
      {!person && (
        <div className="field" style={{ marginBottom: 8 }}>
          <label>Requirement</label>
          <Combo value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">{jobs ? 'Pick a requirement' : 'Loading…'}</option>
            {(jobs || []).map((j) => <option key={j.id} value={j.id}>{j.title}{j.location ? ` · ${j.location}` : ''}</option>)}
          </Combo>
        </div>
      )}
      {rows && rows.length === 0 && <div className="small-muted">{person ? 'No live requirement fits this person well enough (50%+).' : 'Nobody from the Job Portal list fits this requirement well enough (50%+), or they are already on it.'}</div>}
      {(rows || []).length > 0 && (
        <div className="tbl-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ width: 30 }}>
                    <input
                      type={person ? 'radio' : 'checkbox'} name="jm" checked={!!picked[r.key]}
                      onChange={(e) => setPicked(person ? { [r.key]: true } : { ...picked, [r.key]: e.target.checked })}
                    />
                  </td>
                  <td style={{ whiteSpace: 'normal' }}><b>{r.title}</b><div className="small-muted">{r.sub}</div></td>
                  <td style={{ textAlign: 'right' }}><span className="status blue">{`${r.fit}% fit`}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {need.length > 0 && (
        <div className="notice amber" style={{ marginTop: 8, display: 'block' }}>
          <div>{`${need.length} not added: they miss a rule of the requirement. To add them anyway, write why and press the button again.`}</div>
          {need.map((n) => <div key={n.name} className="small-muted">{`${n.name}: ${n.why}`}</div>)}
          <input style={{ width: '100%', marginTop: 6 }} maxLength={300} placeholder="Why add them anyway" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {skipped.length > 0 && (
        <div className="notice red" style={{ marginTop: 8, display: 'block' }}>
          {skipped.map((n) => <div key={n.name}>{`${n.name}: ${n.why}`}</div>)}
        </div>
      )}
    </Modal>
  );
}
