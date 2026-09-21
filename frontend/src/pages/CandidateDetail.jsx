import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import {
  stageLabel, stageBadgeClass, lifeStatusClass, aiStatusClass, protoDate,
} from '../atsVocab';
import { isClientUser } from '../permissions';

// The prototype's candidateDetail() (line 8447): Overview, Applications (n),
// Matching Requirements, Interviews, Activity Timeline, plus Rejection History
// and Hold History for internal roles.
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

export default function CandidateDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [candidate, setCandidate] = useState(null);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState('');

  function load() {
    api.get(`/candidates/${id}`)
      .then((res) => setCandidate(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
  }
  useEffect(load, [id]);

  async function addToPipeline(requirementId) {
    setError('');
    try {
      await api.post('/applications', { candidateId: id, requirementId });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add this candidate to the pipeline');
    }
  }

  if (denied) return <div className="notice">{denied}</div>;
  if (!candidate) return <div className="small-muted">Loading…</div>;

  const c = candidate;
  const isClient = isClientUser(user);
  const applications = c.applications || [];
  const matching = c.matchingRequirements || [];
  const interviews = applications.filter((a) => a.interviewStatus);
  const rejected = applications.filter((a) => a.stage === 'REJECTED');
  const held = applications.filter((a) => a.stage === 'HOLD');

  const TABS = [
    ['overview', 'Overview'],
    ['applications', `Applications (${applications.length})`],
    ['matching', 'Matching Requirements'],
    ['interviews', 'Interviews'],
    ['timeline', 'Activity Timeline'],
    ...(isClient ? [] : [['rejection', 'Rejection History'], ['hold', 'Hold History']]),
  ];

  // The prototype's Activity Timeline joins each application's stage history.
  // This app keeps the milestones on the application row itself.
  const timeline = applications.flatMap((a) => {
    const ctx = a.requirement?.title || '—';
    const items = [{ date: a.createdAt, label: `Application created — ${ctx}` }];
    if (a.interviewAt) items.push({ date: a.interviewAt, label: `Interview ${a.interviewStatus ? a.interviewStatus.toLowerCase().replace(/_/g, ' ') : 'scheduled'} — ${ctx}` });
    if (a.interviewCompletedAt) items.push({ date: a.interviewCompletedAt, label: `Interview completed — ${ctx}` });
    if (a.joiningDate) items.push({ date: a.joiningDate, label: `Joining recorded — ${ctx}` });
    items.push({ date: a.updatedAt, label: `${stageLabel(a.stage)} — ${ctx}` });
    return items;
  }).filter((i) => i.date).sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div>
      <Link className="small-muted" to="/candidates">← Back to candidates</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{c.name}</h1>
          <div className="page-sub">
            {[
              c.location,
              c.experienceYears != null ? `${c.experienceYears} yrs exp` : null,
              c.source ? `source: ${c.source}` : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <div key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</div>
        ))}
      </div>

      {error && <div className="error-text">{error}</div>}

      {tab === 'overview' && (
        <div className="two-col">
          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Profile</h3>
              <div className="grid-2">
                <div className="kv"><span className="k">Email</span><span>{c.email || '—'}</span></div>
                <div className="kv"><span className="k">Mobile</span><span>{c.phone || '—'}</span></div>
                <div className="kv"><span className="k">Preferred Location</span><span>{c.preferredLocation || '—'}</span></div>
                <div className="kv"><span className="k">Education</span><span>{c.education || '—'}</span></div>
                <div className="kv"><span className="k">Current Company</span><span>{c.currentCompany || '—'}</span></div>
                <div className="kv"><span className="k">Current Designation</span><span>{c.currentDesignation || '—'}</span></div>
                <div className="kv">
                  <span className="k">Total / Relevant Experience</span>
                  <span>{`${c.experienceYears != null ? `${c.experienceYears} yrs` : '—'} / ${c.relevantExperienceYears != null ? `${c.relevantExperienceYears} yrs` : '—'}`}</span>
                </div>
                <div className="kv"><span className="k">Current / Expected Salary</span><span>{`${c.currentSalary || '—'} / ${c.expectedSalary || '—'}`}</span></div>
                <div className="kv"><span className="k">Notice Period</span><span>{c.noticePeriod || '—'}</span></div>
                <div className="kv"><span className="k">Availability</span><span>{c.availability || '—'}</span></div>
                <div className="kv"><span className="k">Job Preference</span><span>{c.jobPreference || '—'}</span></div>
                <div className="kv"><span className="k">Preferred Work Mode</span><span>{c.preferredWorkMode || '—'}</span></div>
                <div className="kv"><span className="k">Resume</span><span>{c.resumeName || '—'}{c.resumeScore != null ? ` · ${c.resumeScore}%` : ''}</span></div>
                <div className="kv"><span className="k">Source / First Source</span><span>{`${c.source || '—'} / ${c.firstSource || '—'}`}</span></div>
              </div>
              <div style={{ marginTop: 10 }}>
                {list(c.skills).length
                  ? list(c.skills).map((s) => <span className="skillpill" key={s}>{s}</span>)
                  : <span className="small-muted">No skills on file</span>}
              </div>
            </div>
          </div>
          <div>
            <div className="card">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Sync status</h3>
              <div className="kv"><span className="k">Origin</span><span>{c.source || '—'}</span></div>
              <div className="kv">
                <span className="k">Status</span>
                <span><span className="status active">Synced</span></span>
              </div>
              <div className="kv"><span className="k">Added</span><span>{protoDate(c.createdAt)}</span></div>
            </div>
          </div>
        </div>
      )}

      {tab === 'applications' && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Application</th><th>Requirement</th><th>Client</th><th>Current Stage</th>
                  <th>Owner</th><th>Next Action</th><th>Due Date</th><th>Match Score</th>
                  <th>Status</th><th>Resume</th><th>AI Interview</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td><Link to={`/requirements/${a.requirement.id}`}>{a.requirement.title}</Link></td>
                    <td>{a.requirement.internal ? 'TeamLink Internal' : a.requirement.client?.name || '—'}</td>
                    <td><span className={`status ${stageBadgeClass(a.stage)}`}>{a.stageLabel || stageLabel(a.stage)}</span></td>
                    <td className="cell-muted">{a.owner || '—'}</td>
                    <td className="cell-muted">{a.nextAction || '—'}</td>
                    <td className="cell-muted">
                      {protoDate(a.dueDate)}
                      {a.overdue && <> <span className="status rejected">Overdue</span></>}
                    </td>
                    <td>{a.matchScore != null ? `${a.matchScore}%` : '—'}</td>
                    <td><span className={`status ${lifeStatusClass(a.lifeStatus)}`}>{a.lifeStatus}</span></td>
                    <td>{a.resumeScore != null ? `${a.resumeScore}%` : '—'}</td>
                    <td>
                      {a.aiInterviewScore != null
                        ? `${a.aiInterviewScore}% (Simulated)`
                        : <span className={`status ${aiStatusClass(a.aiInterviewStatus)}`}>{a.aiInterviewStatus || 'Required'}</span>}
                    </td>
                  </tr>
                ))}
                {applications.length === 0 && (
                  <tr><td colSpan="11" className="small-muted" style={{ padding: 16 }}>No applications yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {rejected.length > 0 && (
            <div className="notice" style={{ marginTop: 14 }}>
              This candidate has a rejection on record but remains active and searchable for other
              requirements — profiles are never deleted on rejection.
            </div>
          )}
        </>
      )}

      {tab === 'matching' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Requirement</th><th>Client</th><th>Location</th><th>Match</th><th>Action</th></tr></thead>
            <tbody>
              {matching.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/requirements/${r.id}`}>{r.title}</Link></td>
                  <td>{r.internal ? 'TeamLink Internal' : r.client?.name || '—'}</td>
                  <td>{r.location || '—'}</td>
                  <td><span className="link-btn">{r.match.overall}%</span></td>
                  <td>
                    {isClient
                      ? <span className="small-muted">No permission</span>
                      : <button className="btn btn-sm btn-primary" onClick={() => addToPipeline(r.id)}>Add to Pipeline</button>}
                  </td>
                </tr>
              ))}
              {matching.length === 0 && (
                <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>No new matching requirements above 50%.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'interviews' && (
        interviews.length === 0
          ? <div className="empty"><h3>No interviews yet</h3></div>
          : interviews.map((a) => (
            <div className="card section" key={a.id}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>
                {`${a.requirement.title} — ${a.requirement.internal ? 'TeamLink Internal' : a.requirement.client?.name || '—'}`}
              </h3>
              <div className="kv">
                <span className="k">Date / Time</span>
                <span>{a.interviewAt ? new Date(a.interviewAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
              </div>
              <div className="kv"><span className="k">Mode</span><span>{a.interviewMode || '—'}</span></div>
              <div className="kv"><span className="k">Interviewer</span><span>{a.interviewer || '—'}</span></div>
              <div className="kv"><span className="k">Status</span><span>{a.interviewStatus}</span></div>
              {a.interviewScore != null && (
                <>
                  <div className="kv"><span className="k">Score</span><span>{`${a.interviewScore}%`}</span></div>
                  <div className="kv"><span className="k">Feedback</span><span>{a.interviewFeedback || '—'}</span></div>
                </>
              )}
            </div>
          ))
      )}

      {tab === 'timeline' && (
        <div className="card">
          <div className="timeline">
            {timeline.map((t, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div className="timeline-item" key={i}>
                <div className="timeline-date">{protoDate(t.date)}</div>
                <div className="timeline-label">{t.label}</div>
              </div>
            ))}
            {timeline.length === 0 && <div className="small-muted">No activity yet.</div>}
          </div>
        </div>
      )}

      {tab === 'rejection' && (
        rejected.length === 0
          ? (
            <div className="empty">
              <h3>No rejections on record</h3>
              <div>This candidate has never been rejected on any requirement.</div>
            </div>
          )
          : (
            <>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Requirement</th><th>Client</th><th>Previous Stage</th><th>Rejected By</th><th>Side</th>
                      <th>Reason Category</th><th>Detailed Reason</th><th>Date / Time</th><th>Comments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rejected.map((a) => (
                      <tr key={a.id}>
                        <td>{a.requirement?.title || '—'}</td>
                        <td className="cell-muted">{a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}</td>
                        <td className="cell-muted">—</td>
                        <td className="cell-muted">—</td>
                        <td className="cell-muted">—</td>
                        <td className="cell-muted">—</td>
                        <td>—</td>
                        <td className="cell-muted">{protoDate(a.updatedAt)}</td>
                        <td className="cell-muted">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="notice" style={{ marginTop: 14 }}>
                A rejection closes one application only — the Candidate Master is never deleted and stays
                searchable for other requirements.
              </div>
            </>
          )
      )}

      {tab === 'hold' && (
        held.length === 0
          ? (
            <div className="empty">
              <h3>No holds on record</h3>
              <div>This candidate has never been put on hold.</div>
            </div>
          )
          : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Requirement</th><th>Previous Stage</th><th>Hold Reason</th><th>Hold By</th>
                    <th>Hold Date</th><th>Review Date</th><th>Comment</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {held.map((a) => (
                    <tr key={a.id}>
                      <td>{a.requirement?.title || '—'}</td>
                      <td className="cell-muted">—</td>
                      <td>—</td>
                      <td className="cell-muted">—</td>
                      <td className="cell-muted">{protoDate(a.updatedAt)}</td>
                      <td className="cell-muted">—</td>
                      <td className="cell-muted">—</td>
                      <td><span className="status pending">On Hold</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}
    </div>
  );
}
