import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
// resume_: stored resume files + versions, and the 3-number match.
import ResumePanel from '../components/resume/ResumePanel.jsx';
import { EligibleRequirementsPanel } from '../components/resume/MatchSplit.jsx';
import PortalInviteButton from '../components/portal/PortalInviteButton.jsx';
import { ClientPausedBanner, lifecycleOf as clientLifecycleOf } from '../components/clients/ClientLifecycle.jsx';
// Candidate 360 (spec 2026-09-29 §9): the same header + tabs as the big window.
import {
  C360Header, C360Tabs, currentAppOf, tabKeyOf, ApplicationsMini,
  PipelineTab, SubmissionsTab, OffersTab, JoiningTab,
} from '../components/Candidate360Tabs.jsx';
// cand7_ (Candidates §7): the profile top and the other agents' mount points.
import ProfileTop from '../components/candidate/ProfileTop.jsx';
import ProfileLeft from '../components/candidate/ProfileLeft.jsx';
import { RecordDocuments } from '../components/candidate/CandidateRecord.jsx'; // ATS-100 B5
import {
  FitSlot, AlsoGoodFitSlot, RejectionHistorySlot, HistoryTimelineSlot,
} from '../components/candidate/ProfileSlots.jsx';

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
  NOT_SENT_SWITCHED_OFF: 'Not sent — candidate emails are switched off',
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
  NOT_SENT_SWITCHED_OFF: 'pending',
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
  const [tab, setTabRaw] = useState('applications');
  const setTab = (k) => setTabRaw(tabKeyOf(k));
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
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
        ? (err.response?.data?.error || 'You cannot open this person.')
        : 'Could not load this person. Please try again.'));
  }
  useEffect(load, [id]);
  useEffect(() => {
    if (tab !== 'history') return;
    api.get(`/candidates/${id}/followup-log`)
      .then((res) => setFollowUpLog(res.data.entries || []))
      .catch(() => setFollowUpLog([]));
  }, [tab, id, refreshKey]);

  async function addToPipeline(requirementId) {
    setError('');
    try {
      await api.post('/applications', { candidateId: id, requirementId });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add this person to the job. Please try again.');
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
      setError(err.response?.data?.error || 'Could not open the follow-up. Please try again.');
      return;
    }
    if (!data.canRecord) {
      setError('Only the people on this job can add its follow-up.');
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
      setFollowUpError(err.response?.data?.error || 'Could not save the follow-up. Please try again.');
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
      setError(err.response?.data?.error || 'Could not save the note. Please try again.');
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
      setError(err.response?.data?.error || 'Could not save the document. Please try again.');
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
  // cand7_: the props every ProfileSlots mount gets.
  const slot = {
    c, app: primary, user, internal, onChanged: load, onAddToJob: addToPipeline, onSeeTab: setTab,
  };
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
      {/* cand7_: initials · name · phone · email · location · current step +
          the big Call / WhatsApp / Mail / SMS buttons; the portal invite beside them. */}
      <div style={{ marginTop: 10 }}>
        <ProfileTop
          c={c}
          app={primary}
          internal={internal}
          onChanged={() => { setRefreshKey((n) => n + 1); load(); }}
          extra={internal ? <PortalInviteButton kind="candidate" id={c.id} /> : null}
        />
      </div>
      {c.profileStatus === 'Archived' && (
        <div className="notice amber" style={{ marginBottom: 10 }}>This person is archived — hidden from every list. Nothing was deleted.</div>
      )}
      {/* B7: sent by an agency / freelancer partner — who owns the person and until when. */}
      {c.partnerOwner && (
        <div className={`notice ${c.partnerOwner.active ? 'blue' : 'grey'}`} style={{ marginBottom: 10 }}>
          <span><b>Partner: {c.partnerOwner.name}</b> ({c.partnerOwner.type}) sent this person{c.partnerOwner.until ? ` · ${c.partnerOwner.active ? 'theirs till' : 'ownership ended'} ${c.partnerOwner.until}` : ''}. The partner sees each step in their portal; a joining creates their payout in Invoices → Partner payouts.</span>
        </div>
      )}

      {/* Always on top: Current Application · Current Stage · Next Action
          (+ who owns it) — the same strip as the big window. */}
      <C360Header c={c} app={primary} onBackToLatest={() => setSelectedAppId(null)} />

      {/* Spec 2026-10-03 §A — an application at a PAUSED / ARCHIVED client:
          warn before anyone submits (the server refuses the share anyway). */}
      {internal && (() => {
        const seen = new Set();
        return (c.applications || [])
          .filter((a) => a.requirement && !a.requirement.internal && a.requirement.client
            && ['Paused', 'Archived'].includes(clientLifecycleOf(a.requirement.client))
            && !['REJECTED', 'JOINED', 'HIRED'].includes(a.stage))
          .filter((a) => { const k = a.requirement.client.id || a.requirement.client.name; if (seen.has(k)) return false; seen.add(k); return true; })
          .map((a) => (
            <ClientPausedBanner key={a.id} clientName={a.requirement.client.name} lifecycle={clientLifecycleOf(a.requirement.client)}>
              {` (job: ${a.requirement.title || 'a job'})`}
            </ClientPausedBanner>
          ));
      })()}

      {/* §28 / §41 — where this is, who owns it, what is owed and when, then
          ONE button. Internal only: a client login has no follow-up chain to
          act on and no business seeing who inside TeamLink owes what. */}
      {internal && primary && !['REJECTED', 'HOLD'].includes(c.currentStage) && (
        <NextStepBlock
          stageLabel={primary.stageLabel || c.currentStageLabel}
          owner={primary.nextActionOwnerName || 'No one named'}
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
          {c.duplicateHint.canMerge && <> <Link to="/candidates/duplicates">See duplicates</Link></>}
        </div>
      )}
      {/* ATS layout v3: left = personal info, resume, skills, CTC, notice;
          right = Applications · Notes · Documents · Timeline (same as the big window). */}
      <div className="pfl-frame">
      <ProfileLeft c={c} user={user} internal={internal} slot={slot} onChanged={load} onDeleted={() => navigate('/candidates')} />
      <div className="pfl-right">
      <C360Tabs tab={tab} setTab={setTab} c={c} />

      {tab === 'applications' && (
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
              <div className="cdw-label">Progress</div>
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
      {/* v3: the per-client table (Job · Client · Step) is below; "Also a good fit" sits with Fit. */}
      {tab === 'applications' && <RejectionHistorySlot {...slot} />}

      {!internal && viewer.withheld?.length > 0 && (
        <div className="notice">
          Some details are only for the TeamLink team:
          {` ${viewer.withheld.join(', ')}.`}
        </div>
      )}


      {error && <div className="error-text">{error}</div>}

      {/* v3: the profile facts (personal info, skills, CTC, notice period), the resume and Archive / Delete are on the left (components/candidate/ProfileLeft.jsx). */}

      {/* --- Application: Requirement, Client, Recruiter, TL, BDE,
              Applied Date, Current Stage. --- */}
      {tab === 'applications' && (
        <>
          {/* v3: the current application (with Recruiter · TL · BDE) is the card at the top of this tab. */}
          {!primary && (
            <div className="empty"><h3>Not on any job yet</h3><div>Add this person to a job to start.</div></div>
          )}

          {(applications.length > 0 || c.otherTeamApplications > 0) && (
            <>
              <div className="section-label">
                {`Applications (${applications.length}) · ${new Set(applications.map((a) => (a.requirement?.internal ? 'internal' : a.requirement?.clientId))).size} client(s)`}
                {` · ${applications.filter((a) => !['REJECTED', 'JOINED', 'HIRED'].includes(a.stage)).length} active · ${applications.filter((a) => a.stage === 'REJECTED').length} rejected · ${applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length} joined`}
                {c.otherTeamApplications > 0 && <b>{` · +${c.otherTeamApplications} in other teams`}</b>}
                {applications.length > 1 && <span className="small-muted"> · click a row to see it above</span>}
              </div>
              <div className="tbl-wrap">
                <table className="rq-reach-apps">
                  <thead>
                    <tr>
                      {/* 8 columns (simplicity checklist #12). Department / team lead /
                          client manager of the picked job are in the card above. */}
                      <th>Job</th><th>Client</th><th>Applied on</th><th>Step</th><th>At this step since</th>
                      <th>Next step</th><th>Owner</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...applications].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).map((a, i) => (
                      <tr
                        key={a.id}
                        className={`${applications.length > 1 ? 'rq-click' : ''}${primary && a.id === primary.id ? ' is-selected' : ''}`}
                        onClick={applications.length > 1 ? () => openApplication(a.id) : undefined}
                        title={applications.length > 1 ? 'See this job above' : undefined}
                      >
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
                          {a.stageMoves > 0 && <div className="small-muted">{`${a.stageMoves} step move(s)`}</div>}
                        </td>
                        <td className="cell-muted">
                          {['REJECTED', 'JOINED', 'HIRED'].includes(a.stage)
                            ? '—'
                            : (a.followUp && !a.followUp.completedAt && a.followUp.nextAction) || a.nextAction || '—'}
                        </td>
                        <td className="cell-muted">{a.owner || '—'}</td>
                        <td><span className={`status ${lifeStatusClass(a.lifeStatus)}`}>{a.lifeStatus}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {c.otherTeamApplications > 0 && (
                <div className="small-muted" style={{ marginTop: 6 }}>
                  {`${c.otherTeamApplications} more with other teams (not shown).`}
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
                      <Link to={`/requirements/${r.requirementId}`}>{r.requirementTitle || 'Job'}</Link>
                      <span className="small-muted">
                        {r.at ? ` · ${protoDate(r.at)}` : ''}{r.side ? ` · ${r.side}` : ''}{r.reason ? ` · ${r.reason}` : ''}{r.by ? ` · recorded by ${r.by}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="section-label" style={{ margin: '0 0 4px' }}>
                {`Still a good fit for ${c.eligibleTotal ?? (c.eligibleClients?.filter((x) => !x.rejectedEarlier).length || 0)} client(s) — open jobs, Fit 60%+`}
                {(c.eligibleClients || []).length > 0 && ` · top ${c.eligibleClients.length} shown`}
              </div>
              {(c.eligibleClients || []).length === 0 && <div className="small-muted">No open job at another client fits yet.</div>}
              {(c.eligibleClients || []).map((ec) => (
                <div key={ec.clientId || 'internal'} style={{ fontSize: 13, marginBottom: 4 }}>
                  <span className={`status ${ec.rejectedEarlier ? 'pending' : 'active'}`}>{ec.clientName}</span>
                  {ec.rejectedEarlier && <span className="small-muted"> (rejected this person before — check first)</span>}
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
      {tab === 'history' && <HistoryTimelineSlot {...slot} refreshKey={refreshKey} withActivity={false} />}
      {tab === 'history' && internal && <div className="section-label">{followUpCount ? `Follow-ups (${followUpCount}) — one per job` : 'Follow-ups — one per job'}</div>}
      {tab === 'history' && internal && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  {/* 7 columns (checklist #12); team lead / client manager are on the Overview. */}
                  <th>Job</th><th>Owner</th><th>Last contacted</th><th>Next step</th>
                  <th>Due</th><th>Next follow-up</th><th>Status</th>
                  {canRecordFollowUp && <th />}
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => {
                  const f = a.followUp;
                  return (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/requirements/${a.requirementId}`}>{a.requirement?.title || '—'}</Link>
                        <div className="small-muted">{a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}</div>
                      </td>
                      <td>{f?.ownerName || a.owner || '—'}{f?.ownerRole ? <div className="small-muted">{f.ownerRole}</div> : null}</td>
                      <td className="cell-muted">{f?.lastContactedAt ? dateTime(f.lastContactedAt) : '—'}</td>
                      <td>{f?.nextAction || <span className="small-muted">{a.nextAction || '—'}</span>}</td>
                      <td className="cell-muted">{f?.dueDate ? protoDate(f.dueDate) : '—'}</td>
                      <td className="cell-muted">{f?.nextFollowUpAt ? protoDate(f.nextFollowUpAt) : '—'}</td>
                      <td>
                        {f
                          ? (
                            <>
                              <span className={`status ${followUpStatusClass(f.status)}`}>{f.status === 'Overdue' ? 'Late' : f.status === 'Due Today' ? 'Due today' : f.status}</span>
                              {f.daysOverdue > 0 && <div className="small-muted" style={{ marginTop: 3 }}>{`${f.daysOverdue} day(s) late`}</div>}
                              {f.escalatedAdminAt
                                ? <div className="small-muted">Sent up to Super Admin</div>
                                : f.escalatedTlAt ? <div className="small-muted">Sent up to team lead</div> : null}
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
                    <td colSpan={canRecordFollowUp ? 8 : 7} className="small-muted" style={{ padding: 16 }}>
                      Not on any job yet, so there is nothing to follow up.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            Each job has its own follow-up. A late one goes to the team lead.
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
                      <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No follow-up on this job yet.</td></tr>
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
              No calls or messages yet. Use the Call / WhatsApp buttons above.
            </div>
          )}
          {followUpLog && followUpLog.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th><th>Channel</th><th>What</th><th>Why</th>
                    <th>Outcome</th><th>What was said</th><th>By</th><th>Job</th>
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
            {`Team lead ${followUpDraft.tlName || '—'} · Client manager ${followUpDraft.bdeName || '—'}`}
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
              <span>Due date *</span>
              <input
                type="date"
                value={followUpDraft.dueDate}
                onChange={(e) => setFollowUpDraft({ ...followUpDraft, dueDate: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Next follow-up</span>
              <input
                type="date"
                value={followUpDraft.nextFollowUpAt}
                onChange={(e) => setFollowUpDraft({ ...followUpDraft, nextFollowUpAt: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Next step *</span>
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
            Saving closes the old follow-up and starts this one.
          </div>
          {followUpError && <div className="error-text">{followUpError}</div>}
        </Modal>
      )}

      {/* --- AI Match. Internal only, and framed as what it is. --- */}
      {/* v3: Fit folds into Applications. */}
      {tab === 'applications' && internal && <div className="section-label">Fit</div>}
      {tab === 'applications' && <FitSlot {...slot} />}
      {tab === 'applications' && <AlsoGoodFitSlot {...slot} />}
      {/* cand7_: the AI match detail moved to the Fit tab (components/candidate/ProfileSlots.jsx FitSlot). */}
      {/* --- Pipeline History: the stage chain, Who / When / Action / Comment. --- */}
      {/* --- Feedback: AI score and interview feedback, per application,
              in separate cards — never mixed. --- */}
      {tab === 'applications' && viewer.kind !== 'candidate' && applications.length > 0 && <div className="section-label">Interview feedback</div>}
      {tab === 'applications' && viewer.kind !== 'candidate' && (
        applications.length === 0
          ? <div className="empty"><h3>Not on any job yet</h3></div>
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

      {tab === 'applications' && <PipelineTab c={c} app={primary} user={user} />}
      {tab === 'applications' && <SubmissionsTab c={c} />}
      {tab === 'applications' && <OffersTab c={c} />}
      {tab === 'applications' && <JoiningTab c={c} />}
      {tab === 'history' && <div className="section-label">Activity history</div>}
      {tab === 'history' && (
        <>
          {internal && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Activity — who did what, when</h3>
              <ActivityList items={c.activity} />
            </div>
          )}
          <div className="section-label">Step history</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Who</th><th>Step</th><th>Action</th>
                  {internal && <th>Comment</th>}
                  <th>Job</th>
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
                      {h.derived && <div className="small-muted">From the job record (older entry)</div>}
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
                  <tr><td colSpan={internal ? 6 : 5} className="small-muted" style={{ padding: 16 }}>No step moves yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            Each step move is one row, with who made it.
          </div>
        </>
      )}

      {/* --- Interviews --- */}
      {tab === 'applications' && interviews.length > 0 && <div className="section-label">{`Interviews (${interviews.length})`}</div>}
      {tab === 'applications' && (
        interviews.length === 0
          ? null
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
                  <span className="k">AI interview</span>
                  <span>{aiHeadline(a, aiCompletedAt(history, a))}</span>
                </div>
              )}
            </div>
          ))
      )}

      {/* --- Communications: Email / SMS / WhatsApp history. --- */}
      {tab === 'history' && viewer.kind !== 'client' && <div className="section-label">{communications.length ? `Messages and calls (${communications.length})` : 'Messages and calls'}</div>}
      {tab === 'history' && viewer.kind !== 'client' && (
        <>
          <div className="notice amber">
            <span>
              {c.communications.some((m) => m.status === 'SENT')
                ? <b>Only rows marked Sent left the app.</b>
                : <b>No message has gone out yet.</b>}
              {c.communicationsNote ? <>{' '}{c.communicationsNote}</> : null}
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
                  <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No messages yet. Moving a step that contacts the person adds a row here.</td></tr>
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

      {/* --- Documents (ATS-100 B5): certifications + documents with a real file
              (upload / view / download, audited; delete with a reason). Old
              name-only rows are listed too. --- */}
      {tab === 'documents' && <RecordDocuments c={c} internal={internal} />}

      {/* --- Notes: internal recruiter / TL notes. Never served to a client. --- */}
      {tab === 'notes' && internal && <div className="section-label">{notes.length ? `Notes (${notes.length})` : 'Notes'}</div>}
      {tab === 'notes' && internal && (
        <>
          <div className="notice">
            Only TeamLink staff see these notes. Clients never do.
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
                  <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No notes yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* --- Audit History: who changed what, when. --- */}
      {tab === 'history' && internal && <div className="section-label">Changes</div>}
      {tab === 'history' && internal && (
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
                <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>No changes recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Eligible requirements: the 3-number match (resume_, components/resume/MatchSplit.jsx). --- */}
      {/* cand7_: "Eligible requirements" is on the Fit tab now (FitSlot). */}
      </div>
      </div>
    </div>
  );
}
