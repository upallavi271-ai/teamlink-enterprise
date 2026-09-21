import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';

import { ALL_STAGE_CODES, stageLabel, requirementStatusLabel } from '../atsVocab';
import { canEditRequirement } from '../permissions';


const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

// The prototype's jobDescriptionHtml() (line 6398): the same document, shown
// internally with the closing date and the client blurb, and candidate-facing
// without them.
function JobDescription({ requirement: r, forCandidate }) {
  const row = (k, v) => (v ? <div className="kv" key={k}><span className="k">{k}</span><span>{v}</span></div> : null);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 20, background: '#fff' }}>
      <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>{r.title}</h2>
      <div className="small-muted" style={{ marginBottom: 14 }}>
        {[r.internal ? 'Internal TeamLink hiring' : r.client?.name, r.location || '—', r.workMode || '—'].join(' · ')}
      </div>
      <div className="section-label">About the role</div>
      <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>
        {r.jobDescription || r.description || 'No description recorded yet.'}
      </div>
      {r.responsibilities && (
        <>
          <div className="section-label">Responsibilities</div>
          <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>{r.responsibilities}</div>
        </>
      )}
      {r.qualifications && (
        <>
          <div className="section-label">Qualifications</div>
          <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>{r.qualifications}</div>
        </>
      )}
      <div className="section-label">Skills</div>
      <div style={{ marginBottom: 6 }}>
        {list(r.skills).length
          ? list(r.skills).map((s) => <span className="skillpill match" key={s}>{s}</span>)
          : <span className="cell-muted">—</span>}
        <span className="cell-muted" style={{ fontSize: 11.5 }}> mandatory</span>
      </div>
      <div>
        {list(r.goodToHaveSkills).length
          ? list(r.goodToHaveSkills).map((s) => <span className="skillpill" key={s}>{s}</span>)
          : <span className="cell-muted">—</span>}
        <span className="cell-muted" style={{ fontSize: 11.5 }}> good to have</span>
      </div>
      <div className="section-label">Details</div>
      {row('Experience', r.experience)}
      {row('Relevant experience', r.relevantExperience)}
      {row('Education', r.education)}
      {row('Location', r.location)}
      {row('Preferred location', r.preferredLocation)}
      {row('Work mode', r.workMode)}
      {row('Employment type', r.employmentType)}
      {row('Salary range', r.salary)}
      {row('Notice period', r.noticePeriodMax)}
      {row('Joining timeline', r.joiningTimeline)}
      {row('Openings', r.openings)}
      {!forCandidate && row('Closing date', r.closingDate)}
      {!r.internal && r.client && !forCandidate && (
        <>
          <div className="section-label">About the client</div>
          <div className="small-muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {[r.client.name, r.client.industry, r.client.location].filter(Boolean).join(' · ')}
          </div>
        </>
      )}
      {forCandidate && (
        <div className="notice" style={{ marginTop: 14 }}>
          This is how the opening appears to candidates on the TeamLink Job Portal and external boards.
          Client commercial terms and internal notes are never included.
        </div>
      )}
    </div>
  );
}

export default function RequirementDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [requirement, setRequirement] = useState(null);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [matching, setMatching] = useState([]);
  const [linkCandidateId, setLinkCandidateId] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null); // 'jd' | 'posting'

  function load() {
    api.get(`/requirements/${id}`)
      .then((res) => setRequirement(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
    api.get(`/requirements/${id}/matching-candidates`).then((res) => setMatching(res.data)).catch(() => setMatching([]));
  }
  useEffect(() => {
    load();
    api.get('/candidates').then((res) => setCandidates(res.data));
  }, [id]);

  async function setStage(applicationId, stage) {
    setError('');
    try {
      await api.patch(`/applications/${applicationId}/stage`, { stage });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change stage');
    }
  }

  async function linkCandidate(e, candidateId) {
    e?.preventDefault();
    const cid = candidateId || linkCandidateId;
    if (!cid) return;
    setError('');
    try {
      await api.post('/applications', { candidateId: cid, requirementId: id });
      setLinkCandidateId('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add this candidate to the pipeline');
    }
  }

  async function runAction(path) {
    setError('');
    try {
      await api.post(`/requirements/${id}/${path}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action');
    }
  }

  if (denied) return <div className="notice">{denied}</div>;
  if (!requirement) return <div className="small-muted">Loading…</div>;

  const r = requirement;
  const canManage = canEditRequirement(user);
  const clientName = r.internal ? 'TeamLink Internal' : r.client?.name || '—';
  const agreementSigned = r.internal || r.client?.agreementStatus === 'ACTIVE';
  const sources = list(r.postingSources);
  const postingStatus = r.status === 'OPEN' && sources.length ? 'Posted' : sources.length ? 'Ready to Post' : 'Draft';
  const applications = r.applications || [];

  return (
    <div>
      {/* The shell already renders the prototype's breadcrumb bar above the
          page, so only the "back" affordance belongs here. */}
      <Link className="small-muted" to="/requirements">← Back to requirements</Link>

      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{r.title}</h1>
          <div className="page-sub">{[clientName, r.department].filter(Boolean).join(' · ')}</div>
        </div>
        <span className="status active">{requirementStatusLabel(r.status)}</span>
      </div>

      {r.status === 'DRAFT' && !r.internal && (
        <div className="notice amber">
          <div>
            This requirement is saved as Draft.
            {' '}
            {agreementSigned
              ? 'The client agreement is signed — you can activate it now.'
              : 'It cannot go live until the client agreement is signed.'}
            <div style={{ marginTop: 10 }}>
              {agreementSigned
                ? <button className="btn btn-sm btn-primary" onClick={() => runAction('activate')}>Activate Requirement</button>
                : (
                  <span className="link-btn" style={{ cursor: 'pointer' }} onClick={() => navigate(`/clients/${r.clientId}`)}>
                    Go to Agreement →
                  </span>
                )}
            </div>
          </div>
        </div>
      )}

      <div
        className="card section"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}
      >
        <div>
          <b style={{ fontSize: 13 }}>Job Posting</b>
          <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {'Status: '}
            <span className={`status ${postingStatus === 'Posted' ? 'active' : 'pending'}`}>{postingStatus}</span>
            {sources.length ? ` · ${sources.map((s) => `${s}: ${postingStatus}`).join(' · ')}` : ' · no sources selected yet'}
            {!agreementSigned && <span style={{ color: 'var(--red)' }}> · agreement not signed — posting blocked</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => setDialog('jd')}>View Job Description</button>
          <button className="btn btn-sm" onClick={() => setDialog('posting')}>Preview Job Posting</button>
          {canManage && <button className="btn btn-sm" onClick={() => runAction('generate-jd')}>Generate job description</button>}
        </div>
      </div>

      <div
        className="card section"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}
      >
        <div>
          <b style={{ fontSize: 13 }}>Matching Candidates</b>
          <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {`Candidates in the master at or above ${r.matchThreshold ?? 70}% match · `}
            {`Openings ${r.openings} · Filled ${r.filled ?? 0} · Remaining ${r.remaining ?? r.openings}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 22, fontWeight: 600 }}>{r.matchingCandidates ?? 0}</span>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="two-col">
        <div>
          <div className="card section">
            <div className="grid-2">
              <div className="kv"><span className="k">Location</span><span>{[r.location, r.workMode].filter(Boolean).join(' · ') || '—'}</span></div>
              <div className="kv"><span className="k">Experience</span><span>{r.experience || '—'}</span></div>
              <div className="kv"><span className="k">Salary</span><span>{r.salary || '—'}</span></div>
              <div className="kv"><span className="k">Openings</span><span>{r.openings}</span></div>
              <div className="kv"><span className="k">Priority</span><span>{r.priority}</span></div>
              <div className="kv"><span className="k">Recruiter / BDE</span><span>{`${r.recruiter?.name || '—'} / ${r.bde?.name || '—'}`}</span></div>
            </div>
            <div style={{ margin: '10px 0' }}>
              {list(r.skills).map((s) => <span className="skillpill" key={s}>{s}</span>)}
            </div>
            <div className="small-muted">{r.description || r.jobDescription || '—'}</div>
          </div>

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 4 }}>
              {`Matching Candidates for ${r.internal ? 'this internal role' : `${r.title} — ${clientName}`}`}
            </h3>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              Deterministically matched on the same signals used candidate-side. Recruiter review is required
              before any candidate is shared further.
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th><th>Location</th><th>Experience</th>
                    <th>Matching Skills</th><th>Missing Mandatory</th><th>Score</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {matching.slice(0, 8).map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.location || '—'}</td>
                      <td>{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}</td>
                      <td>
                        {c.match.matchedSkills.slice(0, 3).length
                          ? c.match.matchedSkills.slice(0, 3).map((s) => <span className="skillpill match" key={s}>{s}</span>)
                          : <span className="cell-muted">—</span>}
                      </td>
                      <td>
                        {c.match.missingSkills.length
                          ? c.match.missingSkills.slice(0, 3).map((s) => <span className="skillpill" key={s}>{s}</span>)
                          : <span className="status active">None</span>}
                      </td>
                      <td><span className="link-btn">{c.match.overall}%</span></td>
                      <td>
                        <button className="btn btn-sm btn-primary" onClick={(e) => linkCandidate(e, c.id)}>Add to Pipeline</button>
                      </td>
                    </tr>
                  ))}
                  {matching.length === 0 && (
                    <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No unmatched candidates above 50% right now.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>{`Candidates in pipeline (${applications.length})`}</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Stage</th><th>Score</th><th>Move to…</th></tr></thead>
                <tbody>
                  {applications.map((a) => (
                    <tr key={a.id}>
                      <td><Link to={`/candidates/${a.candidate.id}`}>{a.candidate.name}</Link></td>
                      <td><span className="status">{stageLabel(a.stage)}</span></td>
                      <td>{a.matchScore != null ? `${a.matchScore}%` : a.resumeScore != null ? `${a.resumeScore}%` : '—'}</td>
                      <td>
                        <select value={a.stage} onChange={(e) => setStage(a.id, e.target.value)}>
                          {ALL_STAGE_CODES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                  {applications.length === 0 && (
                    <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No candidates in the pipeline yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Link a candidate</h3>
            <form onSubmit={linkCandidate} className="filter-row" style={{ marginBottom: 0 }}>
              <select value={linkCandidateId} onChange={(e) => setLinkCandidateId(e.target.value)}>
                <option value="">Select candidate</option>
                {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn btn-sm btn-primary" type="submit">Add to pipeline</button>
            </form>
          </div>
        </div>

        <div>
          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Requirement info</h3>
            <div className="kv"><span className="k">Created</span><span>{r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</span></div>
            <div className="kv"><span className="k">Closing</span><span>{r.closingDate || '—'}</span></div>
            <div className="kv"><span className="k">Type</span><span>{r.internal ? 'Internal' : 'Client'}</span></div>
            {canManage && (
              <>
                <div className="divider" />
                <button
                  className="btn btn-sm"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => runAction(r.status === 'DRAFT' ? 'activate' : 'toggle-status')}
                >
                  {r.status === 'DRAFT' ? 'Activate Requirement' : r.status === 'OPEN' ? 'Close Requirement' : 'Reopen Requirement'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {dialog === 'jd' && (
        <Modal
          title="Job Description"
          size="wide"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => setDialog('posting')}>Preview Job Posting →</button>
            </>
          )}
        >
          <JobDescription requirement={r} />
        </Modal>
      )}

      {dialog === 'posting' && (
        <Modal
          title="Preview Job Posting"
          size="wide"
          onClose={() => setDialog(null)}
          footer={<button className="btn" onClick={() => setDialog('jd')}>← Back to JD</button>}
        >
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Candidate-facing preview. This is the same JD that goes to the Job Portal and each selected source.
          </div>
          <div className="kv">
            <span className="k">Posting status</span>
            <span><span className={`status ${postingStatus === 'Posted' ? 'active' : 'pending'}`}>{postingStatus}</span></span>
          </div>
          <div className="kv">
            <span className="k">Sources</span>
            <span>{sources.length ? sources.map((s) => `${s} (${postingStatus})`).join(', ') : 'None selected'}</span>
          </div>
          <JobDescription requirement={r} forCandidate />
        </Modal>
      )}
    </div>
  );
}
