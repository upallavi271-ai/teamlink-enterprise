import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import {
  stageLabel, lifeStatusClass, aiStatusClass, protoDate, interviewStatusLabel,
} from '../atsVocab';
import { STAGE_GROUPS, groupContents, groupBadgeClass, groupIndexById } from '../pipelineView';
import { can } from '../permissions';
import Combo from '../components/Combo.jsx';

// The candidate record, in nine tabs:
//   Overview · Application · AI Match · Pipeline History · Interviews ·
//   Communications · Documents · Notes · Audit History
//
// Which tabs exist is decided by the SERVER, not by this file. The payload
// carries `viewer.internal` and `viewer.withheld`, and the fields a client or
// candidate login may not see are simply absent from the JSON — the tabs below
// are hidden to match, not to enforce.
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

// The message-delivery vocabulary, mirrored from backend/src/utils/mailWorker.js.
// SENT means a provider accepted the message and returned a reference for it —
// nothing else in this file may put that word on a row.
const MESSAGE_STATUS_LABEL = {
  NOT_SENT_NO_PROVIDER: 'Not sent — no provider',
  QUEUED: 'Queued',
  RETRY: 'Retrying',
  SENT: 'Sent',
  FAILED: 'Failed',
};
const MESSAGE_STATUS_CLASS = {
  NOT_SENT_NO_PROVIDER: 'pending',
  QUEUED: 'pending',
  RETRY: 'pending',
  SENT: 'active',
  FAILED: 'rejected',
};

const dateTime = (value) => (value
  ? new Date(value).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  : '—');

export default function CandidateDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [candidate, setCandidate] = useState(null);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [docDraft, setDocDraft] = useState({ docType: 'Resume', name: '', note: '' });

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

  async function addNote(e) {
    e.preventDefault();
    setError('');
    if (!noteDraft.trim()) return;
    try {
      await api.post(`/candidates/${id}/notes`, { body: noteDraft });
      setNoteDraft('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this note');
    }
  }

  async function addDocument(e) {
    e.preventDefault();
    setError('');
    if (!docDraft.name.trim()) return;
    try {
      await api.post(`/candidates/${id}/documents`, docDraft);
      setDocDraft({ docType: 'Resume', name: '', note: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record this document');
    }
  }

  if (denied) return <div className="notice">{denied}</div>;
  if (!candidate) return <div className="small-muted">Loading…</div>;

  const c = candidate;
  const viewer = c.viewer || { internal: false, withheld: [] };
  const internal = !!viewer.internal;
  const applications = c.applications || [];
  const matching = c.matchingRequirements || [];
  const interviews = applications.filter((a) => a.interviewStatus || a.interviewAt);
  const history = c.pipelineHistory || [];
  const communications = c.communications || [];
  const documents = c.documents || [];
  const notes = c.notes || [];
  const audit = c.audit || [];
  // The Application tab reads the candidate's current (most recent) application.
  const primary = applications.find((a) => a.id === c.latestApplicationId) || applications[0] || null;
  const canEditMaster = can(user, 'ats', 'candidates', 'Candidate Master', 'edit');

  const TABS = [
    ['overview', 'Overview'],
    ['application', 'Application'],
    ...(internal ? [['aimatch', 'AI Match']] : []),
    ['history', `Pipeline History (${history.length})`],
    ['interviews', `Interviews (${interviews.length})`],
    // Communications are between TeamLink and the candidate. A client is not a
    // party to them and the API serves them none, so the tab is not offered.
    ...(viewer.kind === 'client' ? [] : [['communications', `Communications (${communications.length})`]]),
    ['documents', `Documents (${documents.length})`],
    ...(internal ? [['notes', `Notes (${notes.length})`], ['audit', 'Audit History']] : []),
    ...(internal ? [['matching', 'Matching Requirements']] : []),
  ];

  const currentGroupIndex = groupIndexById(c.stageGroup);

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
        <div>
          {c.currentStage
            ? (
              <span className={`status ${groupBadgeClass(c.currentStage, c.stageGroup)}`}>
                {c.stageGroupLabel}
                {c.stageDetailLabel && c.stageDetailLabel !== c.stageGroupLabel ? ` · ${c.stageDetailLabel}` : ''}
              </span>
            )
            : <span className="small-muted">No application</span>}
        </div>
      </div>

      {/* The visible pipeline, with this candidate's position on it. The
          detailed status inside the current stage is shown underneath. */}
      {c.currentStage && !['REJECTED', 'HOLD'].includes(c.currentStage) && (
        <div className="tbl-wrap" style={{ padding: '12px 14px', marginBottom: 14 }}>
          <div className="stage-track">
            {STAGE_GROUPS.map((g, i) => (
              <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
                {i > 0 && <span className="stage-connector" />}
                <span
                  className={`stage${i === currentGroupIndex ? ' current' : ''}${i < currentGroupIndex ? ' done' : ''}`}
                  title={`${g.label} contains: ${groupContents(g).join(', ')}`}
                >
                  <span className="dot" />
                  {g.label}
                </span>
              </span>
            ))}
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            {currentGroupIndex >= 0
              ? `Inside ${STAGE_GROUPS[currentGroupIndex].label}: ${groupContents(STAGE_GROUPS[currentGroupIndex]).join(' · ')} — currently ${c.stageDetailLabel || stageLabel(c.currentStage)}.`
              : `Currently ${stageLabel(c.currentStage)}.`}
          </div>
        </div>
      )}

      {!internal && viewer.withheld?.length > 0 && (
        <div className="notice">
          Some of this record is internal to TeamLink and is not part of what you are shown:
          {` ${viewer.withheld.join(', ')}.`}
        </div>
      )}

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <div key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</div>
        ))}
      </div>

      {error && <div className="error-text">{error}</div>}

      {/* --- Overview: Name, Phone, Email, Location, Experience, Skills,
              Resume, Source. --- */}
      {tab === 'overview' && (
        <div className="two-col">
          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Profile</h3>
              <div className="grid-2">
                <div className="kv"><span className="k">Name</span><span>{c.name}</span></div>
                <div className="kv"><span className="k">Phone</span><span>{c.phone || '—'}</span></div>
                <div className="kv"><span className="k">Email</span><span>{c.email || '—'}</span></div>
                <div className="kv"><span className="k">Location</span><span>{c.location || '—'}</span></div>
                <div className="kv">
                  <span className="k">Experience (total / relevant)</span>
                  <span>{`${c.experienceYears != null ? `${c.experienceYears} yrs` : '—'} / ${c.relevantExperienceYears != null ? `${c.relevantExperienceYears} yrs` : '—'}`}</span>
                </div>
                <div className="kv"><span className="k">Resume</span><span>{c.resumeName || '—'}</span></div>
                <div className="kv"><span className="k">Source</span><span>{c.source || '—'}</span></div>
                <div className="kv"><span className="k">First Source</span><span>{c.firstSource || '—'}</span></div>
              </div>
              <div className="section-label">Skills</div>
              <div>
                {list(c.skills).length
                  ? list(c.skills).map((s) => <span className="skillpill" key={s}>{s}</span>)
                  : <span className="small-muted">No skills on file</span>}
              </div>
            </div>
          </div>
          <div>
            <div className="card">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>More</h3>
              <div className="kv"><span className="k">Preferred Location</span><span>{c.preferredLocation || '—'}</span></div>
              <div className="kv"><span className="k">Current Company</span><span>{c.currentCompany || '—'}</span></div>
              <div className="kv"><span className="k">Current Designation</span><span>{c.currentDesignation || '—'}</span></div>
              <div className="kv"><span className="k">Education</span><span>{c.education || '—'}</span></div>
              <div className="kv"><span className="k">Notice Period</span><span>{c.noticePeriod || '—'}</span></div>
              <div className="kv"><span className="k">Availability</span><span>{c.availability || '—'}</span></div>
              {/* Salary is a commercial internal — the server does not send it
                  to a client login, so there is nothing here to hide. */}
              {c.currentSalary !== undefined && (
                <div className="kv">
                  <span className="k">Current / Expected Salary</span>
                  <span>{`${c.currentSalary || '—'} / ${c.expectedSalary || '—'}`}</span>
                </div>
              )}
              <div className="kv"><span className="k">Added</span><span>{protoDate(c.createdAt)}</span></div>
            </div>
          </div>
        </div>
      )}

      {/* --- Application: Requirement, Client, Recruiter, TL, BDE,
              Applied Date, Current Stage. --- */}
      {tab === 'application' && (
        <>
          {primary ? (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Current application</h3>
              <div className="grid-2">
                <div className="kv">
                  <span className="k">Requirement</span>
                  <span><Link to={`/requirements/${primary.requirementId}`}>{primary.requirement?.title || '—'}</Link></span>
                </div>
                <div className="kv">
                  <span className="k">Client</span>
                  <span>{primary.requirement?.internal ? 'TeamLink Internal' : primary.requirement?.client?.name || '—'}</span>
                </div>
                <div className="kv"><span className="k">Recruiter</span><span>{primary.requirement?.recruiter?.name || '—'}</span></div>
                <div className="kv"><span className="k">TL</span><span>{primary.requirement?.tl || '—'}</span></div>
                <div className="kv"><span className="k">BDE</span><span>{primary.requirement?.bde?.name || '—'}</span></div>
                <div className="kv"><span className="k">Applied Date</span><span>{protoDate(primary.createdAt)}</span></div>
                <div className="kv">
                  <span className="k">Current Stage</span>
                  <span>
                    <span className={`status ${groupBadgeClass(primary.stage, primary.stageGroup)}`}>{primary.stageGroupLabel}</span>
                    {primary.stageDetailLabel && primary.stageDetailLabel !== primary.stageGroupLabel
                      ? <span className="small-muted">{` ${primary.stageDetailLabel}`}</span>
                      : null}
                  </span>
                </div>
                <div className="kv"><span className="k">Owner</span><span>{primary.owner || '—'}</span></div>
              </div>
            </div>
          ) : (
            <div className="empty"><h3>No application yet</h3><div>This candidate is in the master but not in any pipeline.</div></div>
          )}

          {applications.length > 1 && (
            <>
              <div className="section-label">All applications</div>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Requirement</th><th>Client</th><th>Recruiter</th><th>TL</th><th>BDE</th>
                      <th>Applied</th><th>Stage</th><th>Owner</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applications.map((a) => (
                      <tr key={a.id}>
                        <td><Link to={`/requirements/${a.requirementId}`}>{a.requirement?.title || '—'}</Link></td>
                        <td className="cell-muted">{a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}</td>
                        <td className="cell-muted">{a.requirement?.recruiter?.name || '—'}</td>
                        <td className="cell-muted">{a.requirement?.tl || '—'}</td>
                        <td className="cell-muted">{a.requirement?.bde?.name || '—'}</td>
                        <td className="cell-muted">{protoDate(a.createdAt)}</td>
                        <td>
                          <span className={`status ${groupBadgeClass(a.stage, a.stageGroup)}`}>{a.stageGroupLabel}</span>
                        </td>
                        <td className="cell-muted">{a.owner || '—'}</td>
                        <td><span className={`status ${lifeStatusClass(a.lifeStatus)}`}>{a.lifeStatus}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* --- AI Match. Internal only, and framed as what it is. --- */}
      {tab === 'aimatch' && (
        c.aiMatch ? (
          <>
            <div className="notice amber">
              {c.aiMatch.advisory}
            </div>
            <div className="two-col">
              <div>
                <div className="card section">
                  <h3 style={{ fontSize: 13, marginBottom: 10 }}>
                    {`Scored against: ${c.aiMatch.requirementTitle}`}
                  </h3>
                  <div className="kv"><span className="k">Match Score</span><span><b>{`${c.aiMatch.overall}%`}</b></span></div>
                  <div className="kv">
                    <span className="k">Experience Match</span>
                    <span>{`${c.aiMatch.experienceMatch.percent}% — ${c.aiMatch.experienceMatch.reason || '—'}`}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Relevant Experience</span>
                    <span>{`${c.aiMatch.experienceMatch.relevantPercent}% — ${c.aiMatch.experienceMatch.relevantReason || '—'}`}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Education Match</span>
                    <span>{`${c.aiMatch.educationMatch.percent}% — ${c.aiMatch.educationMatch.reason || '—'}`}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Location</span>
                    <span>{`${c.aiMatch.locationMatch.percent}% — ${c.aiMatch.locationMatch.reason || '—'}`}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Salary expectation</span>
                    <span>{`${c.aiMatch.salaryMatch.percent}% — ${c.aiMatch.salaryMatch.reason || '—'}`}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Notice period</span>
                    <span>{`${c.aiMatch.noticeMatch.percent}% — ${c.aiMatch.noticeMatch.reason || '—'}`}</span>
                  </div>

                  <div className="section-label">Matched skills</div>
                  <div>
                    {c.aiMatch.matchedSkills.length
                      ? c.aiMatch.matchedSkills.map((s) => <span className="skillpill match" key={s}>{s}</span>)
                      : <span className="small-muted">None of the mandatory skills matched.</span>}
                  </div>
                  <div className="section-label">Missing skills</div>
                  <div>
                    {c.aiMatch.missingSkills.length
                      ? c.aiMatch.missingSkills.map((s) => <span className="skillpill miss" key={s}>{s}</span>)
                      : <span className="small-muted">No mandatory skill is missing.</span>}
                  </div>
                </div>
              </div>
              <div>
                <div className="card section">
                  <h3 style={{ fontSize: 13, marginBottom: 10 }}>AI Recommendation</h3>
                  <div style={{ fontSize: 13 }}>{c.aiMatch.recommendation}</div>
                  <div className="divider" />
                  <div className="section-label">Why it scored</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                    {c.aiMatch.reasons.map((r) => <li key={r}>{r}</li>)}
                    {c.aiMatch.reasons.length === 0 && <li className="small-muted">No positive signals recorded.</li>}
                  </ul>
                  <div className="section-label">Gaps</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                    {c.aiMatch.gaps.map((g) => <li key={g}>{g}</li>)}
                    {c.aiMatch.gaps.length === 0 && <li className="small-muted">No gaps recorded.</li>}
                  </ul>
                  <div className="divider" />
                  <div className="small-muted">
                    The recruiter decides. Nothing on this tab moves a candidate forward or backward, and no
                    stage in Pipeline History was ever set by the scorer.
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">
            <h3>No AI match to show</h3>
            <div>A match score is calculated against a requirement, so it appears once this candidate is in a pipeline.</div>
          </div>
        )
      )}

      {/* --- Pipeline History: the stage chain, Who / When / Action / Comment. --- */}
      {tab === 'history' && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Who</th><th>Stage</th><th>Action</th>
                  {internal && <th>Comment</th>}
                  <th>Requirement</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <tr key={`${h.applicationId}-${i}`}>
                    <td className="cell-muted">{dateTime(h.when)}</td>
                    <td>
                      {h.who}
                      {h.role && <div className="small-muted">{h.role}</div>}
                    </td>
                    <td>
                      <span className={`status ${groupBadgeClass(h.toStage, null)}`}>{h.stageGroupLabel}</span>
                      <div className="small-muted" style={{ marginTop: 3 }}>{h.toStageLabel}</div>
                    </td>
                    <td>
                      {h.action}
                      {h.derived && <div className="small-muted">Derived from the application record — predates pipeline history</div>}
                    </td>
                    {internal && <td className="cell-muted">{h.comment || '—'}</td>}
                    <td className="cell-muted">{h.requirementTitle}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr><td colSpan={internal ? 6 : 5} className="small-muted" style={{ padding: 16 }}>No pipeline history yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            Every stage change writes one row here, with the person who made it. Rows marked
            &ldquo;derived&rdquo; are reconstructed from an application created before this history was kept.
          </div>
        </>
      )}

      {/* --- Interviews --- */}
      {tab === 'interviews' && (
        interviews.length === 0
          ? <div className="empty"><h3>No interviews yet</h3></div>
          : interviews.map((a) => (
            <div className="card section" key={a.id}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>
                {`${a.requirement?.title || '—'} — ${a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}`}
              </h3>
              <div className="grid-2">
                <div className="kv"><span className="k">Interview ID</span><span>{a.interviewCode || '—'}</span></div>
                <div className="kv"><span className="k">Round</span><span>{a.interviewRound || 1}</span></div>
                <div className="kv"><span className="k">Date / Time</span><span>{dateTime(a.interviewAt)}</span></div>
                <div className="kv"><span className="k">Mode</span><span>{a.interviewMode || '—'}</span></div>
                <div className="kv"><span className="k">Type</span><span>{a.interviewType || '—'}</span></div>
                <div className="kv"><span className="k">Interviewer</span><span>{a.interviewer || '—'}</span></div>
                <div className="kv">
                  <span className="k">Status</span>
                  <span>{a.interviewStatusLabel || interviewStatusLabel(a.interviewStatus)}</span>
                </div>
                <div className="kv"><span className="k">Result</span><span>{a.interviewResult || '—'}</span></div>
              </div>
              {internal && a.interviewScore != null && (
                <>
                  <div className="kv"><span className="k">Score</span><span>{`${a.interviewScore}%`}</span></div>
                  <div className="kv"><span className="k">Feedback</span><span>{a.interviewFeedback || '—'}</span></div>
                </>
              )}
              {a.aiInterviewStatus && (
                <div className="kv">
                  <span className="k">AI screening interview</span>
                  <span><span className={`status ${aiStatusClass(a.aiInterviewStatus)}`}>{a.aiInterviewStatus}</span></span>
                </div>
              )}
            </div>
          ))
      )}

      {/* --- Communications: Email / SMS / WhatsApp history. --- */}
      {tab === 'communications' && (
        <>
          <div className="notice amber">
            <span>
              {c.communications.some((m) => m.status === 'SENT')
                ? <b>Only rows marked Sent were accepted by the provider.</b>
                : <b>Nothing on this tab has been delivered yet.</b>}
              {' '}
              {c.communicationsNote}
              {' '}
              Each row is the record of a message this app decided to send when a stage changed — the trigger,
              the template, the recipient and the sending employee&rsquo;s own address. A Sent row carries the
              provider&rsquo;s own message reference; delivery to the inbox is not confirmed, because there is
              no bounce/delivery webhook yet.
            </span>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Channel</th><th>Template</th><th>Trigger</th>
                  <th>Recipient</th><th>From</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {communications.map((m) => (
                  <tr key={m.id}>
                    <td className="cell-muted">{dateTime(m.createdAt)}</td>
                    <td>{m.channel}</td>
                    <td>
                      {m.templateLabel || m.template}
                      {m.subject && <div className="small-muted">{m.subject}</div>}
                    </td>
                    <td className="cell-muted">{m.trigger}</td>
                    <td className="cell-muted">{m.recipient || <span className="status rejected">none on file</span>}</td>
                    <td className="cell-muted">
                      {m.senderEmail || '—'}
                      {m.senderName && <div className="small-muted">{m.senderName}</div>}
                    </td>
                    <td>
                      <span className={`status ${MESSAGE_STATUS_CLASS[m.status] || 'pending'}`}>
                        {MESSAGE_STATUS_LABEL[m.status] || m.status}
                      </span>
                      {m.sentAt && <div className="small-muted">{dateTime(m.sentAt)}</div>}
                      {m.providerRef && <div className="small-muted" title={m.providerRef}>ref {String(m.providerRef).slice(0, 28)}</div>}
                      {m.status !== 'SENT' && m.statusDetail && (
                        <div className="small-muted">{m.statusDetail}</div>
                      )}
                    </td>
                  </tr>
                ))}
                {communications.length === 0 && (
                  <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No communications recorded yet. Moving this candidate to a stage that contacts them (AI Interview Scheduled, Interview Scheduled, Selected, Offer, Joined, Hold, Rejected) writes rows here.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {communications.length > 0 && (
            <div className="card section" style={{ marginTop: 14 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Latest message body</h3>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{communications[0].body}</div>
              <div className="small-muted" style={{ marginTop: 8 }}>
                {`Sender address taken from: ${communications[0].senderSourceNote || '—'}`}
              </div>
            </div>
          )}
        </>
      )}

      {/* --- Documents: Resume, ID, Certificates, Offer, Joining. --- */}
      {tab === 'documents' && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Type</th><th>Document</th><th>Note</th><th>Recorded by</th><th>When</th>{internal && <th>Visibility</th>}</tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td><span className="status new">{d.docType}</span></td>
                    <td>{d.name}</td>
                    <td className="cell-muted">{d.note || '—'}</td>
                    <td className="cell-muted">{d.uploadedByName || '—'}</td>
                    <td className="cell-muted">{protoDate(d.createdAt)}</td>
                    {internal && (
                      <td className="cell-muted">
                        {d.internalOnly ? <span className="status hold">Internal only</span> : 'Shared'}
                      </td>
                    )}
                  </tr>
                ))}
                {documents.length === 0 && (
                  <tr><td colSpan={internal ? 6 : 5} className="small-muted" style={{ padding: 16 }}>No documents on file.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {internal && canEditMaster && (
            <form className="card section" style={{ marginTop: 14 }} onSubmit={addDocument}>
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Record a document</h3>
              <div className="grid-3">
                <label className="field">
                  <span>Type</span>
                  <Combo value={docDraft.docType} onChange={(e) => setDocDraft({ ...docDraft, docType: e.target.value })}>
                    {['Resume', 'ID', 'Certificate', 'Offer', 'Joining'].map((t) => <option key={t}>{t}</option>)}
                  </Combo>
                </label>
                <label className="field">
                  <span>Document name</span>
                  <input value={docDraft.name} onChange={(e) => setDocDraft({ ...docDraft, name: e.target.value })} placeholder="e.g. arjun-mehta-resume.pdf" />
                </label>
                <label className="field">
                  <span>Note</span>
                  <input value={docDraft.note} onChange={(e) => setDocDraft({ ...docDraft, note: e.target.value })} />
                </label>
              </div>
              <button className="btn btn-primary btn-sm" type="submit">Add document</button>
              <div className="small-muted" style={{ marginTop: 8 }}>
                This records the document against the candidate. File storage is not wired up — the row is a
                reference, not an uploaded file. Offer paperwork is marked internal-only by default because it
                carries the commercial terms.
              </div>
            </form>
          )}
        </>
      )}

      {/* --- Notes: internal recruiter / TL notes. Never served to a client. --- */}
      {tab === 'notes' && internal && (
        <>
          <div className="notice">
            Internal notes. The API does not serve this tab, or any note on it, to a client or candidate login —
            the field is absent from their payload, not merely hidden.
          </div>
          {canEditMaster && (
            <form className="card section" onSubmit={addNote}>
              <label className="field">
                <span>Add a note</span>
                <textarea rows="3" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="What the next recruiter needs to know…" />
              </label>
              <button className="btn btn-primary btn-sm" type="submit">Save note</button>
            </form>
          )}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Role</th><th>Note</th></tr></thead>
              <tbody>
                {notes.map((n) => (
                  <tr key={n.id}>
                    <td className="cell-muted">{dateTime(n.createdAt)}</td>
                    <td>{n.authorName || '—'}</td>
                    <td className="cell-muted">{n.authorRole || '—'}</td>
                    <td>{n.body}</td>
                  </tr>
                ))}
                {notes.length === 0 && (
                  <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No internal notes yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* --- Audit History: who changed what, when. --- */}
      {tab === 'audit' && internal && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>From</th><th>To</th><th>Record</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="cell-muted">{dateTime(a.when)}</td>
                  <td>{a.who}</td>
                  <td>{a.action}</td>
                  <td className="cell-muted">{a.fromValue ? stageLabel(a.fromValue) : '—'}</td>
                  <td className="cell-muted">{a.toValue ? stageLabel(a.toValue) : '—'}</td>
                  <td className="cell-muted">{a.entity}</td>
                </tr>
              ))}
              {audit.length === 0 && (
                <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>No audit entries for this candidate.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Matching Requirements (kept from the previous screen). --- */}
      {tab === 'matching' && internal && (
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
                    {can(user, 'ats', 'candidates', 'Applications', 'create')
                      ? <button className="btn btn-sm btn-primary" onClick={() => addToPipeline(r.id)}>Add to Pipeline</button>
                      : <span className="small-muted">No permission</span>}
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
    </div>
  );
}
