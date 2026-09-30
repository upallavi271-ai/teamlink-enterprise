import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import NextStepBlock from '../components/NextStepBlock.jsx';
import {
  stageLabel, lifeStatusClass, aiStatusClass, protoDate, interviewStatusLabel,
  followUpStatusClass, CONTACT_MODES,
} from '../atsVocab';
import { STAGE_GROUPS, groupContents, groupBadgeClass, groupIndexById } from '../pipelineView';
import { can } from '../permissions';
import Combo from '../components/Combo.jsx';
import Modal from '../components/Modal.jsx';
import {
  PipelineSteps, pausedFrom, CandidateActions, CurrentApplication, FeedbackSplit, ActivityList,
  AiInterviewSection, ClientFeedbackSection, aiHeadline, aiCompletedAt,
} from '../components/Candidate360.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import { LocationRequirementsPanel } from '../components/CandidateReach.jsx';
import PortalInviteButton from '../components/portal/PortalInviteButton.jsx';
// Candidate 360 (spec 2026-09-29 §9): the same header + tabs as the big window.
import {
  C360Header, C360Tabs, candidateCode, currentAppOf,
  PipelineTab, SubmissionsTab, OffersTab, JoiningTab, AiScoresTab,
} from '../components/Candidate360Tabs.jsx';

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
  // A call is not "sent" — it happened, and the row is the record of it.
  LOGGED: 'Call logged',
  // Opened in the recruiter's own WhatsApp / SMS app. Deliberately NOT "Sent":
  // the app never sees whether they pressed send.
  OPENED_ON_DEVICE: 'Opened on device',
};
const MESSAGE_STATUS_CLASS = {
  NOT_SENT_NO_PROVIDER: 'pending',
  QUEUED: 'pending',
  RETRY: 'pending',
  SENT: 'active',
  FAILED: 'rejected',
  LOGGED: 'active',
  OPENED_ON_DEVICE: 'new',
};

// The follow-up log's channel column. The channel is the first thing on every
// row, because "how did we reach them" is the question the log is for.
const CHANNEL_ICON = {
  Call: '📞', WhatsApp: '💬', SMS: '✉️', Email: '📧', 'In Person': '🤝',
};
const LOG_KIND_LABEL = {
  contact: 'Contacted',
  'followup-set': 'Follow-up set',
  'followup-done': 'Follow-up closed',
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
  const [flash, setFlash] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [docDraft, setDocDraft] = useState({ docType: 'Resume', name: '', note: '' });
  // user notes #5 — which application the 360 shows: the latest, until a row
  // of the Applications list is clicked.
  const [selectedAppId, setSelectedAppId] = useState(null);
  useEffect(() => { setSelectedAppId(null); }, [id]);
  // --- follow-ups. One thread per APPLICATION. -----------------------------
  const [followUpDraft, setFollowUpDraft] = useState(null);
  const [followUpThread, setFollowUpThread] = useState(null);
  const [followUpSaving, setFollowUpSaving] = useState(false);
  const [followUpError, setFollowUpError] = useState('');

  // The follow-up LOG — every touch, in order. Fetched when the tab is opened
  // (and again each time it is re-opened), so a call made a minute ago from
  // the contact panel is on it without reloading the page.
  const [followUpLog, setFollowUpLog] = useState(null);

  function load() {
    api.get(`/candidates/${id}`)
      .then((res) => setCandidate(res.data))
      .catch((err) => setDenied([403, 404].includes(err.response?.status)
        ? (err.response?.data?.error || 'This record is not available to you')
        : 'This candidate could not be loaded just now — refresh to try again.'));
  }
  useEffect(load, [id]);
  useEffect(() => {
    if (tab !== 'activity') return;
    api.get(`/candidates/${id}/followup-log`)
      .then((res) => setFollowUpLog(res.data.entries || []))
      .catch(() => setFollowUpLog([]));
  }, [tab, id]);

  async function addToPipeline(requirementId) {
    setError('');
    try {
      await api.post('/applications', { candidateId: id, requirementId });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add this candidate to the pipeline');
    }
  }

  // The owner, the TL, the BDE and the sensible defaults all come from the
  // SERVER — GET /followups/application/:id resolves them from the
  // requirement's assignment chain and the stage's own SLA. Nothing here
  // guesses who owns the call.
  async function openFollowUp(application) {
    setFollowUpError('');
    setError('');
    let data = null;
    try {
      const res = await api.get(`/followups/application/${application.id}`);
      data = res.data;
      setFollowUpThread({
        title: application.requirement?.title || 'this application',
        history: data.history || [],
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open the follow-up for this application');
      return;
    }
    if (!data.canRecord) {
      setError('A follow-up is recorded by its owner — you are not on this requirement’s assignment chain.');
      return;
    }
    const current = data.current;
    setFollowUpDraft({
      applicationId: application.id,
      requirementTitle: application.requirement?.title || 'this application',
      ownerName: data.chain?.ownerName,
      ownerRole: data.chain?.ownerRole,
      tlName: data.chain?.tlName,
      bdeName: data.chain?.bdeName,
      contactMode: '',
      nextAction: (current && current.nextAction) || data.suggestedNextAction || '',
      dueDate: data.suggestedDueDate || '',
      nextFollowUpAt: '',
      notes: '',
    });
  }

  async function saveFollowUp() {
    if (!followUpDraft) return;
    setFollowUpError('');
    if (!followUpDraft.nextAction.trim()) { setFollowUpError('Say what is owed next.'); return; }
    if (!followUpDraft.dueDate) { setFollowUpError('Pick a due date.'); return; }
    setFollowUpSaving(true);
    try {
      await api.post('/followups', {
        applicationId: followUpDraft.applicationId,
        contactMode: followUpDraft.contactMode || undefined,
        nextAction: followUpDraft.nextAction,
        dueDate: followUpDraft.dueDate,
        nextFollowUpAt: followUpDraft.nextFollowUpAt || undefined,
        notes: followUpDraft.notes || undefined,
      });
      const applicationId = followUpDraft.applicationId;
      const title = followUpDraft.requirementTitle;
      setFollowUpDraft(null);
      load();
      const res = await api.get(`/followups/application/${applicationId}`);
      setFollowUpThread({ title, history: res.data.history || [] });
    } catch (err) {
      setFollowUpError(err.response?.data?.error || 'Could not record this follow-up');
    } finally {
      setFollowUpSaving(false);
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
  const primary = currentAppOf(c, selectedAppId);
  const openApplication = (appId) => {
    setSelectedAppId(appId);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const canEditMaster = can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  // A follow-up is an APPLICATION's, so the count is how many of this
  // candidate's applications currently carry one — not a number on the
  // candidate.
  const followUpCount = applications.filter((a) => a.followUp).length;
  const canRecordFollowUp = internal && can(user, 'ats', 'candidates', 'Applications', 'edit');

  // Review #2 §11: Resume · Communication · Interview · Feedback · Activity
  // History · Applications, beside the profile and the internal working tabs.
  // Pipeline History and Audit History now live together in Activity History.
  // (Superseded by the shared Candidate 360 tabs — kept for reference.)
  // eslint-disable-next-line no-unused-vars
  const TABS = [
    ['overview', 'Profile'],
    ['application', `Applications (${applications.length})`],
    ['documents', `Resume & Documents (${documents.length})`],
    // Communications are between TeamLink and the candidate. A client is not a
    // party to them and the API serves them none, so the tab is not offered.
    ...(viewer.kind === 'client' ? [] : [['communications', `Communication (${communications.length})`]]),
    ['interviews', `Interview (${interviews.length})`],
    ...(viewer.kind === 'candidate' ? [] : [['feedback', 'Feedback']]),
    ['history', 'Activity History'],
    // Follow-ups are TeamLink's own operations — who inside this company owes
    // which call. A client or candidate login is served none of it, so the
    // tab is not offered either.
    ...(internal ? [['followups', `Follow-ups (${followUpCount})`]] : []),
    ...(internal ? [['notes', `Notes (${notes.length})`]] : []),
    ...(internal ? [['aimatch', 'AI Match']] : []),
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
              c.code || candidateCode(c.id),
              c.phone,
              c.email,
              c.location,
              c.experienceYears != null ? `${c.experienceYears} yrs exp` : null,
              c.source ? `source: ${c.source}` : null,
            ].filter(Boolean).join(' · ')}
          </div>
          {list(c.skills).length > 0 && (
            <div style={{ marginTop: 6 }}>
              {list(c.skills).slice(0, 12).map((s) => <span className="skillpill" key={s}>{s}</span>)}
            </div>
          )}
        </div>
        <div>
          {c.currentStage
            ? (
              <StatusChip status={c.stageGroupLabel}>
                {c.stageGroupLabel}
                {c.stageDetailLabel && c.stageDetailLabel !== c.stageGroupLabel ? ` · ${c.stageDetailLabel}` : ''}
              </StatusChip>
            )
            : <span className="small-muted">No application</span>}
          {/* User notes #4 — the candidate's own portal login (recruiter invite). */}
          {internal && <div style={{ marginTop: 8 }}><PortalInviteButton kind="candidate" id={c.id} /></div>}
        </div>
      </div>

      {/* Always on top: Current Application · Current Stage · Next Action
          (+ who owns it) — the same strip as the big window. */}
      <C360Header c={c} app={primary} onBackToLatest={() => setSelectedAppId(null)} />

      {/* §28 / §41 — where this is, who owns it, what is owed and when, then
          ONE button. Internal only: a client login has no follow-up chain to
          act on and no business seeing who inside TeamLink owes what. */}
      {internal && primary && !['REJECTED', 'HOLD'].includes(c.currentStage) && (
        <NextStepBlock
          stageLabel={primary.stageLabel || c.currentStageLabel}
          owner={primary.nextActionOwnerName || 'No owner named'}
          ownerRole={primary.nextActionOwnerRole}
          nextAction={primary.followUp?.nextAction || primary.nextAction}
          due={primary.followUp?.dueDate}
          dueTime={primary.followUp?.dueTime}
          status={primary.followUp?.status}
          candidateId={c.id}
          candidateName={c.name}
          phone={c.phone}
          email={c.email}
          role={primary.requirement?.title}
          client={primary.requirement?.internal ? 'TeamLink Internal' : primary.requirement?.client?.name}
          applicationId={primary.id}
          followUpId={primary.followUp?.id}
          onDone={load}
        />
      )}

      {/* --- Candidate 360° (review #2 §11): current application with its
              ownership, the pipeline with this candidate's step highlighted,
              and the actions this login may take. --- */}
      {c.duplicateHint && (
        <div className="notice amber" style={{ marginBottom: 12 }}>
          {`${c.duplicateHint.count} other profile(s) share this phone or email: ${c.duplicateHint.names.join(', ')}.`}
          {c.duplicateHint.canMerge && <> <Link to="/candidates/duplicates">Review duplicates →</Link></>}
        </div>
      )}
      {/* The ten Candidate 360 tabs (same as the big window). */}
      <C360Tabs tab={tab} setTab={setTab} c={c} />

      {tab === 'overview' && (
      <div className="c360-page">
        <div className="cdw-card">
          <div className="cdw-label">
            {primary && c.latestApplicationId && primary.id !== c.latestApplicationId ? 'Selected application' : 'Current application'}
            {primary && c.latestApplicationId && primary.id !== c.latestApplicationId && (
              <button type="button" className="link-btn" style={{ marginLeft: 8, fontSize: 11.5 }} onClick={() => setSelectedAppId(null)}>back to latest</button>
            )}
          </div>
          <CurrentApplication
            app={primary}
            ownership={c.ownership}
            clientName={primary ? (primary.requirement?.internal ? 'TeamLink Internal' : primary.requirement?.client?.name) : null}
            linkTo={(a) => <Link to={`/requirements/${a.requirementId}`}>{a.requirement?.title || '—'}</Link>}
          />
        </div>
        <div>
          {primary && (
            <div className="cdw-card">
              <div className="cdw-label">Pipeline</div>
              <PipelineSteps
                user={user}
                app={primary}
                stage={primary.stage}
                pausedAt={pausedFrom(history, primary)}
                detail={currentGroupIndex >= 0 && primary.stageDetailLabel ? `Currently ${primary.stageDetailLabel}` : null}
              />
            </div>
          )}
          <CandidateActions c={c} app={primary} user={user} onChanged={load} onFlash={setFlash} />
          {flash && <div className="notice" style={{ marginBottom: 10 }}>{flash}</div>}
          {/* Review #3 §7 — AI Interview and Client Feedback, two separate
              sections (a client login never gets the AI one). */}
          {primary && internal && <AiInterviewSection app={primary} history={history} />}
          {primary && <ClientFeedbackSection app={primary} feedbacks={c.interviewFeedbacks} internal={internal} />}
        </div>
      </div>
      )}

      {!internal && viewer.withheld?.length > 0 && (
        <div className="notice">
          Some of this record is internal to TeamLink and is not part of what you are shown:
          {` ${viewer.withheld.join(', ')}.`}
        </div>
      )}


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
      {tab === 'applications' && (
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
                    <StatusChip status={primary.stageGroupLabel} />
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

          {(applications.length > 0 || c.otherTeamApplications > 0) && (
            <>
              <div className="section-label">
                {`Applications (${applications.length}) · ${new Set(applications.map((a) => (a.requirement?.internal ? 'internal' : a.requirement?.clientId))).size} client(s)`}
                {` · ${applications.filter((a) => !['REJECTED', 'JOINED', 'HIRED'].includes(a.stage)).length} active · ${applications.filter((a) => a.stage === 'REJECTED').length} rejected · ${applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length} joined`}
                {c.otherTeamApplications > 0 && <b>{` · +${c.otherTeamApplications} in other teams`}</b>}
                {applications.length > 1 && <span className="small-muted"> · click a row to open that application above</span>}
              </div>
              <div className="tbl-wrap">
                <table className="rq-reach-apps">
                  <thead>
                    <tr>
                      <th>#</th><th>Requirement</th><th>Client</th><th>Applied on</th><th>Current stage</th><th>In this stage since</th>
                      <th>Last update</th><th>Next action</th>
                      <th>Department</th><th>Recruiter</th><th>TL</th><th>BDE</th><th>Owner</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...applications].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).map((a, i) => (
                      <tr
                        key={a.id}
                        className={`${applications.length > 1 ? 'rq-click' : ''}${primary && a.id === primary.id ? ' is-selected' : ''}`}
                        onClick={applications.length > 1 ? () => openApplication(a.id) : undefined}
                        title={applications.length > 1 ? 'Open this application above' : undefined}
                      >
                        <td className="cell-muted">{i + 1}</td>
                        <td>
                          <Link to={`/requirements/${a.requirementId}`} onClick={(e) => e.stopPropagation()}>
                            {a.requirement?.reqCode ? `${a.requirement.reqCode} · ` : ''}{a.requirement?.title || '—'}
                          </Link>
                        </td>
                        <td className="cell-muted">{a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}</td>
                        <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.createdAt)}</td>
                        <td>
                          <StatusChip status={a.stageGroupLabel} />
                          {a.stageDetailLabel && a.stageDetailLabel !== a.stageGroupLabel && <div className="small-muted">{a.stageDetailLabel}</div>}
                        </td>
                        <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                          {a.stageSince ? dateTime(a.stageSince) : '—'}
                          {a.stageMoves > 0 && <div className="small-muted">{`${a.stageMoves} stage change(s)`}</div>}
                        </td>
                        <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{a.updatedAt ? dateTime(a.updatedAt) : '—'}</td>
                        <td className="cell-muted">
                          {['REJECTED', 'JOINED', 'HIRED'].includes(a.stage)
                            ? '—'
                            : (a.followUp && !a.followUp.completedAt && a.followUp.nextAction) || a.nextAction || '—'}
                        </td>
                        <td className="cell-muted">{a.requirement?.department || '—'}</td>
                        <td className="cell-muted">{a.requirement?.recruiter?.name || '—'}</td>
                        <td className="cell-muted">{a.requirement?.tl || '—'}</td>
                        <td className="cell-muted">{a.requirement?.bde?.name || '—'}</td>
                        <td className="cell-muted">{a.owner || '—'}</td>
                        <td><span className={`status ${lifeStatusClass(a.lifeStatus)}`}>{a.lifeStatus}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {c.otherTeamApplications > 0 && (
                <div className="small-muted" style={{ marginTop: 6 }}>
                  {`${c.otherTeamApplications} more application(s) for this candidate belong to other teams — counted, not shown, because they are outside your access.`}
                </div>
              )}
            </>
          )}

          {/* user notes #6 — open requirements where this candidate is. */}
          {internal && <LocationRequirementsPanel candidateId={c.id} onApplied={load} />}

          {internal && (c.rejectedBy?.length > 0 || c.eligibleClients?.length > 0) && (
            <div className="card section" style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>Rejected by · still eligible for</h3>
              {c.rejectedBy?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div className="section-label" style={{ margin: '0 0 4px' }}>Rejected by</div>
                  {c.rejectedBy.map((r) => (
                    <div key={r.applicationId} style={{ fontSize: 13, marginBottom: 3 }}>
                      <span className="status rejected">{r.clientName || '—'}</span>{' '}
                      <Link to={`/requirements/${r.requirementId}`}>{r.requirementTitle || 'Requirement'}</Link>
                      <span className="small-muted">
                        {r.at ? ` · ${protoDate(r.at)}` : ''}{r.side ? ` · ${r.side}` : ''}{r.reason ? ` · ${r.reason}` : ''}{r.by ? ` · recorded by ${r.by}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="section-label" style={{ margin: '0 0 4px' }}>
                {`Still eligible for ${c.eligibleTotal ?? (c.eligibleClients?.filter((x) => !x.rejectedEarlier).length || 0)} client(s) — open requirements in the same department matching 60% or more`}
                {(c.eligibleClients || []).length > 0 && ` · top ${c.eligibleClients.length} shown`}
              </div>
              {(c.eligibleClients || []).length === 0 && <div className="small-muted">No open requirement at another client matches this candidate yet.</div>}
              {(c.eligibleClients || []).map((ec) => (
                <div key={ec.clientId || 'internal'} style={{ fontSize: 13, marginBottom: 4 }}>
                  <span className={`status ${ec.rejectedEarlier ? 'pending' : 'active'}`}>{ec.clientName}</span>
                  {ec.rejectedEarlier && <span className="small-muted"> (rejected this candidate before — check before sharing)</span>}
                  <span className="small-muted">
                    {' — '}{ec.requirements.slice(0, 4).map((r) => `${r.title} (${r.match}%)`).join(', ')}{ec.requirements.length > 4 ? ` +${ec.requirements.length - 4} more` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* --- FOLLOW-UPS -----------------------------------------------------
          ONE FOLLOW-UP PER APPLICATION, never one per candidate. This tab is
          the clearest place in the app where the candidate-master / application
          separation shows: CAND0001 on three requirements has three rows here,
          each with its own owner, its own next action and its own due date,
          and none of them is stored on the candidate record.

          The nine columns are the ones the brief names:
            Owner · Owner Role · TL · BDE · Last Contacted · Next Action ·
            Due Date · Next Follow-up · Status
          Status is Upcoming / Due Today / Overdue / Completed, derived on the
          server from the due date so it is never stale. --- */}
      {tab === 'activity' && internal && <div className="section-label">{`Follow-ups (${followUpCount}) — one per application`}</div>}
      {tab === 'activity' && internal && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requirement</th><th>Client</th><th>Owner</th><th>Owner Role</th>
                  <th>TL</th><th>BDE</th><th>Last Contacted</th><th>Next Action</th>
                  <th>Due Date</th><th>Next Follow-up</th><th>Status</th>
                  {canRecordFollowUp && <th />}
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => {
                  const f = a.followUp;
                  return (
                    <tr key={a.id}>
                      <td><Link to={`/requirements/${a.requirementId}`}>{a.requirement?.title || '—'}</Link></td>
                      <td className="cell-muted">
                        {a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}
                      </td>
                      <td>{f?.ownerName || a.owner || '—'}</td>
                      <td className="cell-muted">{f?.ownerRole || '—'}</td>
                      <td className="cell-muted">{f?.tlName || a.requirement?.tl || '—'}</td>
                      <td className="cell-muted">{f?.bdeName || a.requirement?.bde?.name || '—'}</td>
                      <td className="cell-muted">{f?.lastContactedAt ? dateTime(f.lastContactedAt) : '—'}</td>
                      <td>{f?.nextAction || <span className="small-muted">{a.nextAction || '—'}</span>}</td>
                      <td className="cell-muted">{f?.dueDate ? protoDate(f.dueDate) : '—'}</td>
                      <td className="cell-muted">{f?.nextFollowUpAt ? protoDate(f.nextFollowUpAt) : '—'}</td>
                      <td>
                        {f
                          ? (
                            <>
                              <span className={`status ${followUpStatusClass(f.status)}`}>{f.status}</span>
                              {f.daysOverdue > 0 && <div className="small-muted" style={{ marginTop: 3 }}>{`${f.daysOverdue} day(s) late`}</div>}
                              {f.escalatedAdminAt
                                ? <div className="small-muted">Escalated to Super Admin</div>
                                : f.escalatedTlAt ? <div className="small-muted">Escalated to TL</div> : null}
                            </>
                          )
                          : <span className="small-muted">Not set</span>}
                      </td>
                      {canRecordFollowUp && (
                        <td>
                          <button
                            className="btn btn-sm"
                            onClick={() => openFollowUp(a)}
                          >
                            {f ? 'Record follow-up' : 'Set follow-up'}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {applications.length === 0 && (
                  <tr>
                    <td colSpan={canRecordFollowUp ? 12 : 11} className="small-muted" style={{ padding: 16 }}>
                      This candidate is in the master but not in any pipeline, so there is nothing to follow up on.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            A follow-up belongs to the application, not to the person — the same candidate on two requirements
            owes two follow-ups. Recording one closes the open one and opens the next, so the thread below keeps
            its whole history. An overdue follow-up escalates to the TL, and then to a Super Admin; because this
            app runs no scheduler, that is evaluated whenever this list or the dashboard is loaded.
          </div>

          {followUpThread && (
            <>
              <div className="section-label">{`Follow-up history — ${followUpThread.title}`}</div>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Recorded</th><th>By</th><th>Mode</th><th>Action</th><th>Due</th><th>Notes</th><th>Completed</th></tr>
                  </thead>
                  <tbody>
                    {followUpThread.history.map((h) => (
                      <tr key={h.id}>
                        <td className="cell-muted">{dateTime(h.createdAt)}</td>
                        <td className="cell-muted">{h.createdByName || '—'}</td>
                        <td className="cell-muted">{h.contactMode || '—'}</td>
                        <td>{h.nextAction || '—'}</td>
                        <td className="cell-muted">{protoDate(h.dueDate)}</td>
                        <td className="cell-muted">{h.notes || '—'}</td>
                        <td className="cell-muted">{h.completedAt ? dateTime(h.completedAt) : '—'}</td>
                      </tr>
                    ))}
                    {followUpThread.history.length === 0 && (
                      <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No follow-up recorded on this application yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* THE FOLLOW-UP LOG. The table above is what is OWED; this is what
              was DONE — every call, WhatsApp, SMS and email, with how it
              went and what was said, plus each follow-up set and closed.
              Kept separate from Communications on purpose: that tab is
              every message including automatic stage mails, this is the
              people who chased this candidate and how. */}
          <h3 style={{ margin: '22px 0 10px' }}>Follow-up log</h3>
          {followUpLog === null && <div className="small-muted">Loading…</div>}
          {followUpLog && followUpLog.length === 0 && (
            <div className="empty-mini">
              Nobody has contacted this candidate from the app yet. Use Contact — every call, WhatsApp and SMS lands here.
            </div>
          )}
          {followUpLog && followUpLog.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th><th>Channel</th><th>What</th><th>Why</th>
                    <th>Outcome</th><th>What was said</th><th>By</th><th>Requirement</th>
                  </tr>
                </thead>
                <tbody>
                  {followUpLog.map((e, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <tr key={`${e.kind}-${e.at}-${i}`}>
                      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(e.at)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {e.channel
                          ? <><span aria-hidden="true">{CHANNEL_ICON[e.channel] || '•'}</span> {e.channel}</>
                          : <span className="small-muted">—</span>}
                      </td>
                      <td>
                        {LOG_KIND_LABEL[e.kind] || e.kind}
                        {e.kind === 'contact' && e.status && MESSAGE_STATUS_LABEL[e.status] && (
                          <div>
                            <span className={`status ${MESSAGE_STATUS_CLASS[e.status] || ''}`} title={e.statusDetail || ''}>
                              {MESSAGE_STATUS_LABEL[e.status]}
                            </span>
                          </div>
                        )}
                        {e.due && <div className="small-muted">due {protoDate(e.due)}</div>}
                      </td>
                      <td>{e.purpose || <span className="small-muted">—</span>}</td>
                      <td>{e.outcome || <span className="small-muted">—</span>}</td>
                      <td style={{ maxWidth: 320, whiteSpace: 'pre-wrap' }}>
                        {e.said || <span className="small-muted">—</span>}
                      </td>
                      <td className="cell-muted">{e.by || '—'}</td>
                      <td className="cell-muted">{e.requirement || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Record a follow-up. Owner / Owner Role / TL / BDE are not typed in —
          they are resolved from the requirement's assignment chain on the
          server and snapshotted onto the row, so a later reassignment cannot
          rewrite who owed the call. */}
      {followUpDraft && (
        <Modal
          title={`Record a follow-up — ${followUpDraft.requirementTitle}`}
          onClose={() => setFollowUpDraft(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setFollowUpDraft(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={followUpSaving} onClick={saveFollowUp}>
                {followUpSaving ? 'Saving…' : 'Save follow-up'}
              </button>
            </>
          )}
        >
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            {`Owner ${followUpDraft.ownerName || '—'} (${followUpDraft.ownerRole || '—'}) · `}
            {`TL ${followUpDraft.tlName || '—'} · BDE ${followUpDraft.bdeName || '—'}`}
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Contacted by</span>
              <Combo
                value={followUpDraft.contactMode}
                onChange={(e) => setFollowUpDraft({ ...followUpDraft, contactMode: e.target.value })}
              >
                <option value="">— Not recorded —</option>
                {CONTACT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Due Date *</span>
              <input
                type="date"
                value={followUpDraft.dueDate}
                onChange={(e) => setFollowUpDraft({ ...followUpDraft, dueDate: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Next Follow-up</span>
              <input
                type="date"
                value={followUpDraft.nextFollowUpAt}
                onChange={(e) => setFollowUpDraft({ ...followUpDraft, nextFollowUpAt: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Next Action *</span>
            <input
              value={followUpDraft.nextAction}
              placeholder="What is owed next?"
              onChange={(e) => setFollowUpDraft({ ...followUpDraft, nextAction: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea
              rows="3"
              value={followUpDraft.notes}
              placeholder="What happened on this contact"
              onChange={(e) => setFollowUpDraft({ ...followUpDraft, notes: e.target.value })}
            />
          </label>
          <div className="cell-muted" style={{ fontSize: 11.5 }}>
            Saving records that contact happened now, closes the open follow-up on this application and opens
            this one. Overdue follow-ups alert the TL, then a Super Admin.
          </div>
          {followUpError && <div className="error-text">{followUpError}</div>}
        </Modal>
      )}

      {/* --- AI Match. Internal only, and framed as what it is. --- */}
      {tab === 'ai' && <AiScoresTab c={c} app={primary} internal={internal} />}
      {tab === 'ai' && internal && (
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
      {/* --- Feedback: AI score and interview feedback, per application,
              in separate cards — never mixed. --- */}
      {tab === 'interviews' && viewer.kind !== 'candidate' && (
        applications.length === 0
          ? <div className="empty"><h3>No application yet</h3></div>
          : [...applications].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).map((a) => (
            <div className="card section" key={a.id}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>
                {`${a.requirement?.title || '—'} — ${a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}`}
                <span className="small-muted">{` · ${a.stageGroupLabel || stageLabel(a.stage)}`}</span>
              </h3>
              <FeedbackSplit app={a} feedbacks={c.interviewFeedbacks} internal={internal} history={history} />
            </div>
          ))
      )}

      {tab === 'pipeline' && <PipelineTab c={c} app={primary} user={user} />}
      {tab === 'submissions' && <SubmissionsTab c={c} />}
      {tab === 'offers' && <OffersTab c={c} />}
      {tab === 'joining' && <JoiningTab c={c} />}
      {tab === 'activity' && <div className="section-label">Activity history</div>}
      {tab === 'activity' && (
        <>
          {internal && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Activity — who did what, when</h3>
              <ActivityList items={c.activity} />
            </div>
          )}
          <div className="section-label">Pipeline history</div>
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
                      {/* The PREVIOUS stage is part of the record, not only
                          the new one — a rejection at Client Review and a
                          rejection at first screening are different events. */}
                      {h.fromStageLabel && (
                        <div className="small-muted" style={{ marginBottom: 3 }}>{`from ${h.fromStageLabel}`}</div>
                      )}
                      <StatusChip status={h.stageGroupLabel} />
                      <div className="small-muted" style={{ marginTop: 3 }}>{h.toStageLabel}</div>
                    </td>
                    <td>
                      {h.action}
                      {h.derived && <div className="small-muted">Derived from the application record — predates pipeline history</div>}
                      {/* The full Rejected / Hold record. Reason category and
                          the detailed reason are internal reasoning and the
                          server withholds them from external logins, so this
                          renders whatever it was actually served. */}
                      {h.reasonCategory && (
                        <div className="small-muted" style={{ marginTop: 3 }}>
                          <b>{h.reasonCategory}</b>
                          {h.reasonDetail ? ` — ${h.reasonDetail}` : ''}
                        </div>
                      )}
                      {h.actorSide && <div className="small-muted" style={{ marginTop: 2 }}>{`Decided ${h.actorSide === 'Client' ? 'by the client' : 'internally'}`}</div>}
                    </td>
                    {internal && <td className="cell-muted">{h.comment || '—'}</td>}
                    <td className="cell-muted">
                      {h.requirementTitleAtTime || h.requirementTitle}
                      {h.clientName && <div className="small-muted">{h.clientName}</div>}
                    </td>
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
              {internal && a.aiInterviewStatus && (
                <div className="kv">
                  <span className="k">AI screening interview (separate from the client interview)</span>
                  <span>{aiHeadline(a, aiCompletedAt(history, a))}</span>
                </div>
              )}
            </div>
          ))
      )}

      {/* --- Communications: Email / SMS / WhatsApp history. --- */}
      {tab === 'activity' && viewer.kind !== 'client' && <div className="section-label">{`Communication (${communications.length})`}</div>}
      {tab === 'activity' && viewer.kind !== 'client' && (
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
      {tab === 'resume' && (
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
      {tab === 'activity' && internal && <div className="section-label">{`Notes (${notes.length})`}</div>}
      {tab === 'activity' && internal && (
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
      {tab === 'activity' && internal && <div className="section-label">Audit trail</div>}
      {tab === 'activity' && internal && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>From</th><th>To</th><th>Record</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="cell-muted">{dateTime(a.when)}</td>
                  <td>{a.who}</td>
                  <td>{a.action}</td>
                  <td className="cell-muted">{a.fromValue ? (String(a.fromValue).startsWith('{') ? 'snapshot saved' : stageLabel(String(a.fromValue).slice(0, 160))) : '—'}</td>
                  <td className="cell-muted">{a.toValue ? (String(a.toValue).startsWith('{') ? 'details saved' : stageLabel(String(a.toValue).slice(0, 160))) : '—'}</td>
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
      {tab === 'applications' && internal && <div className="section-label">Matching requirements</div>}
      {tab === 'applications' && internal && (
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
