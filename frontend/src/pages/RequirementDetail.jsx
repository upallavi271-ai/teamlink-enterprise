import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';

import {
  ALL_STAGE_CODES, stageLabel, stageBadgeClass, priorityBadgeClass,
  requirementStatusLabel, requirementBadgeClass, requirementIsLive,
  agreementStatusLabel, agreementBadgeClass,
  PORTAL_SYNC_STATUSES, protoDate,
} from '../atsVocab';

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
      {!forCandidate && row('Target date', r.targetDate)}
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

function Row({ k, children }) {
  return <div className="kv"><span className="k">{k}</span><span>{children || '—'}</span></div>;
}

// Draft → Agreement Check → Open → Recruiter Assigned → Sourcing
//   → Candidates Available → On Hold / Closed
const FLOW = ['DRAFT', 'AGREEMENT_CHECK', 'OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const PARKED = ['ON_HOLD', 'CLOSED'];

export default function RequirementDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [requirement, setRequirement] = useState(null);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [matching, setMatching] = useState([]);
  const [activity, setActivity] = useState([]);
  const [people, setPeople] = useState([]);
  const [linkCandidateId, setLinkCandidateId] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null); // 'jd' | 'posting' | 'assign'
  const [assign, setAssign] = useState(null);

  function load() {
    api.get(`/requirements/${id}`)
      .then((res) => setRequirement(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
    api.get(`/requirements/${id}/matching-candidates`).then((res) => setMatching(res.data)).catch(() => setMatching([]));
    api.get(`/requirements/${id}/activity`).then((res) => setActivity(res.data)).catch(() => setActivity([]));
  }
  useEffect(() => {
    load();
    api.get('/candidates').then((res) => setCandidates(res.data)).catch(() => setCandidates([]));
    api.get('/requirements/assignable-people').then((res) => setPeople(res.data)).catch(() => setPeople([]));
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

  async function runAction(path, body) {
    setError('');
    try {
      await api.post(`/requirements/${id}/${path}`, body || {});
      load();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action');
      return false;
    }
  }

  if (denied) return <div className="notice">{denied}</div>;
  if (!requirement) return <div className="small-muted">Loading…</div>;

  const r = requirement;
  const p = r.permissions || {};
  const clientName = r.internal ? 'TeamLink Internal' : r.client?.name || '—';
  const agreementActive = r.agreementActive;
  const sources = list(r.postingSources);
  const postingStatus = requirementIsLive(r.status) && sources.length ? 'Posted' : sources.length ? 'Ready to Post' : 'Draft';
  const applications = r.applications || [];
  const roleOf = (t) => t.atsRole || t.role;
  const byRole = (code) => people.filter((t) => roleOf(t) === code);
  const nameOf = (uid) => people.find((t) => t.id === uid)?.name || null;

  const openAssign = () => {
    setAssign({
      tlId: r.tlId || '',
      stlId: r.stlId || '',
      recruiterId: r.recruiterId || '',
      bdeId: r.bdeId || '',
      recruiterIds: (r.coRecruiters || []).map((c) => c.id),
      accountManager: r.accountManager || '',
    });
    setDialog('assign');
  };

  return (
    <div>
      {/* The shell already renders the prototype's breadcrumb bar above the
          page, so only the "back" affordance belongs here. */}
      <Link className="small-muted" to="/requirements">← Back to requirements</Link>

      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{`${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`}</h1>
          <div className="page-sub">{[clientName, r.department, r.location].filter(Boolean).join(' · ')}</div>
        </div>
        <span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span>
      </div>

      {/* Draft → Agreement Check → Open → Recruiter Assigned → Sourcing →
          Candidates Available → On Hold / Closed */}
      <div className="card section">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {FLOW.map((s) => (
            <span
              key={s}
              className={`status ${r.status === s ? requirementBadgeClass(s) : ''}`}
              style={r.status === s ? undefined : { background: 'var(--line-soft)', color: 'var(--ink-soft)' }}
            >
              {requirementStatusLabel(s)}
            </span>
          ))}
          {PARKED.includes(r.status) && (
            <span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span>
          )}
        </div>
        {p.approve && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {!requirementIsLive(r.status) && !PARKED.includes(r.status) && (
              <button className="btn btn-sm btn-primary" onClick={() => runAction('activate')}>Activate Requirement</button>
            )}
            {['OPEN', 'ON_HOLD'].includes(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'RECRUITER_ASSIGNED' })}>
                → Recruiter Assigned
              </button>
            )}
            {['OPEN', 'RECRUITER_ASSIGNED', 'ON_HOLD'].includes(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'SOURCING' })}>→ Sourcing</button>
            )}
            {['SOURCING', 'ON_HOLD'].includes(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'CANDIDATES_AVAILABLE' })}>
                → Candidates Available
              </button>
            )}
            {requirementIsLive(r.status) && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'ON_HOLD' })}>Put On Hold</button>
            )}
            {r.status !== 'CLOSED' && (
              <button className="btn btn-sm btn-danger" onClick={() => runAction('status', { status: 'CLOSED' })}>Close</button>
            )}
            {r.status === 'CLOSED' && (
              <button className="btn btn-sm" onClick={() => runAction('status', { status: 'OPEN' })}>Reopen</button>
            )}
          </div>
        )}
        {p.readOnlyReason && <div className="small-muted" style={{ marginTop: 8 }}>{p.readOnlyReason}</div>}
      </div>

      {!agreementActive && !r.internal && (
        <div className="notice amber">
          <div>
            {'Agreement gate: this requirement cannot go live until '}
            <b>{clientName}</b>
            {"'s service agreement is Active — it is currently "}
            <b>{agreementStatusLabel(r.client?.agreementStatus)}</b>
            {'. The server refuses the transition; this is not a hidden button.'}
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-sm" onClick={() => navigate(`/clients/${r.clientId}?tab=agreement`)}>
                Go to Agreement →
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div
        className="card section"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}
      >
        <div>
          <b style={{ fontSize: 13 }}>Job Posting &amp; Portal Sync</b>
          <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {'Posting: '}
            <span className={`status ${postingStatus === 'Posted' ? 'active' : 'pending'}`}>{postingStatus}</span>
            {' · Job Portal Sync: '}
            <span className={`status ${r.portalSyncStatus === 'Synced' ? 'active' : r.portalSyncStatus === 'Failed' ? 'rejected' : 'pending'}`}>
              {r.portalSyncStatus || 'Not Synced'}
            </span>
            {sources.length ? ` · sources: ${sources.join(', ')}` : ' · no sources selected yet'}
            {!agreementActive && <span style={{ color: 'var(--red)' }}> · agreement not Active — posting blocked</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setDialog('jd')}>View Job Description</button>
          <button className="btn btn-sm" onClick={() => setDialog('posting')}>Preview Job Posting</button>
          {p.share && <button className="btn btn-sm" onClick={() => runAction('generate-jd')}>Generate job description</button>}
          {p.share && (
            <select
              value={r.portalSyncStatus || 'Not Synced'}
              onChange={(e) => runAction('portal-sync', { portalSyncStatus: e.target.value })}
            >
              {PORTAL_SYNC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
      </div>

      {p.matching && (
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
          <span style={{ fontSize: 22, fontWeight: 600 }}>{r.matchingCandidates ?? 0}</span>
        </div>
      )}

      <div className="two-col">
        <div>
          {/* Every field the requirement carries. */}
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Requirement</h3>
            <div className="grid-2">
              <div>
                <Row k="Requirement ID">{r.reqCode || r.id}</Row>
                <Row k="Job Title">{r.title}</Row>
                <Row k="Client">{clientName}</Row>
                <Row k="Department">{r.department}</Row>
                <Row k="Location">{r.location}</Row>
                <Row k="Work Mode">{r.workMode}</Row>
                <Row k="Experience">{[r.experience, r.relevantExperience && `relevant ${r.relevantExperience}`].filter(Boolean).join(' · ')}</Row>
                <Row k="Qualification">{[r.education, r.qualifications].filter(Boolean).join(' · ')}</Row>
              </div>
              <div>
                <Row k="Openings">{`${r.openings} · filled ${r.filled ?? 0} · remaining ${r.remaining ?? r.openings}`}</Row>
                <Row k="Priority"><span className={`status ${priorityBadgeClass(r.priority)}`}>{r.priority}</span></Row>
                <Row k="Salary / CTC Range">{`${r.salary || '—'}${r.salaryType ? ` (${r.salaryType}${r.currency ? `, ${r.currency}` : ''})` : ''}`}</Row>
                <Row k="Notice Period">{r.noticePeriodMax}</Row>
                <Row k="Employment Type">{[r.employmentType, r.jobPreference].filter(Boolean).join(' · ')}</Row>
                <Row k="Created Date">{r.createdAt ? protoDate(r.createdAt) : null}</Row>
                <Row k="Target Date">{r.targetDate || r.closingDate}</Row>
                <Row k="Status"><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></Row>
              </div>
            </div>
            <Row k="Skills">
              {list(r.skills).length
                ? list(r.skills).map((s) => <span className="skillpill match" key={s}>{s}</span>)
                : null}
            </Row>
            <div className="section-label">Job Description</div>
            <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.7 }}>
              {r.jobDescription || r.description || '—'}
            </div>
          </div>

          {p.pipeline && (
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
          )}

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>{`Candidates in pipeline (${applications.length})`}</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Stage</th><th>Score</th><th>Move to…</th></tr></thead>
                <tbody>
                  {applications.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/candidates/${a.candidateId || a.candidate?.id}`}>{a.candidate?.name || a.candidateName}</Link>
                      </td>
                      <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                      <td>{a.matchScore != null ? `${a.matchScore}%` : a.resumeScore != null ? `${a.resumeScore}%` : '—'}</td>
                      <td>
                        {p.pipeline ? (
                          <select value={a.stage} onChange={(e) => setStage(a.id, e.target.value)}>
                            {ALL_STAGE_CODES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
                          </select>
                        ) : <span className="cell-muted">—</span>}
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

          {p.pipeline && (
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
          )}

          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Activity</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>When</th><th>Action</th><th>From</th><th>To</th><th>By</th></tr></thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td className="cell-muted">{protoDate(a.createdAt)}</td>
                      <td>{a.action}</td>
                      <td className="cell-muted">{a.fromValue || '—'}</td>
                      <td className="cell-muted">{a.toValue || '—'}</td>
                      <td className="cell-muted">{a.by || 'System'}</td>
                    </tr>
                  ))}
                  {activity.length === 0 && (
                    <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>No activity recorded yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div>
          {/* THE ASSIGNMENT CHAIN — this is what drives scope. */}
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 4 }}>Assignment</h3>
            <div className="small-muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
              Requirement → Assigned TL → Assigned Recruiter(s) → BDE → Client
            </div>
            <Row k="Assigned TL">{r.tlName || nameOf(r.tlId) || r.tl}</Row>
            <Row k="Assigned Recruiter">{r.recruiter?.name}</Row>
            <Row k="Co-recruiters">
              {(r.coRecruiters || []).length ? (r.coRecruiters || []).map((c) => c.name).join(', ') : null}
            </Row>
            <Row k="BDE">{r.bde?.name}</Row>
            <Row k="STL">{r.stlName || nameOf(r.stlId) || r.stl}</Row>
            <Row k="Account Manager">{r.accountManager || r.client?.accountManager}</Row>
            <Row k="Client">{clientName}</Row>
            {p.assign && (
              <button
                className="btn btn-sm btn-primary"
                style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={openAssign}
              >
                Change assignment
              </button>
            )}
            {!p.assign && (
              <div className="small-muted" style={{ marginTop: 8 }}>
                You can view this assignment but not change it — ASSIGN is a separate permission from VIEW.
              </div>
            )}
          </div>

          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement</h3>
            {r.internal ? (
              <div className="small-muted">Internal TeamLink hiring — no client agreement applies.</div>
            ) : (
              <>
                <Row k="Status">
                  <span className={`status ${agreementBadgeClass(r.client?.agreementStatus)}`}>
                    {agreementStatusLabel(r.client?.agreementStatus)}
                  </span>
                </Row>
                <Row k="Agreement ID">{r.client?.agreementId}</Row>
                <Row k="Agreement Date">{r.client?.agreementStart}</Row>
                <Row k="Expiry">{r.client?.agreementEnd}</Row>
                <Row k="Gate">{agreementActive ? 'Open — this requirement may go live' : 'Blocked — requirement cannot go live'}</Row>
                <Link className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} to={`/clients/${r.clientId}?tab=agreement`}>
                  Open the agreement →
                </Link>
              </>
            )}
          </div>

          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Your permissions on this record</h3>
            {[['View', p.view], ['Edit', p.edit], ['Approve', p.approve], ['Assign', p.assign], ['Share / post', p.share], ['Export', p.export]]
              .map(([label, on]) => (
                <div className="kv" key={label}>
                  <span className="k">{label}</span>
                  <span className={`status ${on ? 'active' : 'rejected'}`}>{on ? 'Allowed' : 'Not allowed'}</span>
                </div>
              ))}
            <div className="small-muted" style={{ marginTop: 8, fontSize: 11.5 }}>
              Resolved server-side by the permission engine and this record&apos;s own assignment — the API
              refuses anything marked Not allowed, whatever this page renders.
            </div>
          </div>
        </div>
      </div>

      {dialog === 'assign' && assign && (
        <Modal
          title="Change assignment"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={async () => { if (await runAction('assign', assign)) setDialog(null); }}
              >
                Save assignment
              </button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            Changing this changes who can see the requirement. A recruiter sees the ones assigned to them,
            a TL the ones they lead plus their department&apos;s, a BDE their clients&apos;.
          </div>
          <label className="field">
            <span>Assigned TL</span>
            <select value={assign.tlId} onChange={(e) => setAssign({ ...assign, tlId: e.target.value })}>
              <option value="">— Not assigned —</option>
              {byRole('TL').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Assigned Recruiter</span>
            <select value={assign.recruiterId} onChange={(e) => setAssign({ ...assign, recruiterId: e.target.value })}>
              <option value="">— Not assigned —</option>
              {byRole('RECRUITER').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <div className="field">
            <span>Co-recruiters</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
              {byRole('RECRUITER').filter((t) => t.id !== assign.recruiterId).map((t) => (
                <label key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={assign.recruiterIds.includes(t.id)}
                    onChange={() => setAssign({
                      ...assign,
                      recruiterIds: assign.recruiterIds.includes(t.id)
                        ? assign.recruiterIds.filter((x) => x !== t.id)
                        : [...assign.recruiterIds, t.id],
                    })}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            <span>BDE</span>
            <select value={assign.bdeId} onChange={(e) => setAssign({ ...assign, bdeId: e.target.value })}>
              <option value="">— Not assigned —</option>
              {byRole('BDE').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>STL</span>
            <select value={assign.stlId} onChange={(e) => setAssign({ ...assign, stlId: e.target.value })}>
              <option value="">— None —</option>
              {byRole('STL').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Account Manager</span>
            <input value={assign.accountManager} onChange={(e) => setAssign({ ...assign, accountManager: e.target.value })} />
          </label>
        </Modal>
      )}

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
          <Row k="Posting status">
            <span className={`status ${postingStatus === 'Posted' ? 'active' : 'pending'}`}>{postingStatus}</span>
          </Row>
          <Row k="Job Portal Sync">{r.portalSyncStatus || 'Not Synced'}</Row>
          <Row k="Sources">{sources.length ? sources.map((s) => `${s} (${postingStatus})`).join(', ') : 'None selected'}</Row>
          <JobDescription requirement={r} forCandidate />
        </Modal>
      )}
    </div>
  );
}
