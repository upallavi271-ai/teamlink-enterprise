import { Link } from 'react-router-dom';
import { protoDate, stageLabel } from '../atsVocab';
import StatusChip from './ui/StatusChip.jsx';
import {
  PipelineSteps, pausedFrom, ActivityList, AiInterviewSection, ClientFeedbackSection, isInternalApp,
} from './Candidate360.jsx';
import { ApplicationsList } from './CandidateReach.jsx';
import './Candidate360Tabs.css';

// ---------------------------------------------------------------------------
// CANDIDATE 360 — header + tabs shared by the big window
// (components/CandidateDrawer.jsx) and the full page (pages/CandidateDetail.jsx)
// (user spec 2026-09-29 §9).
//
//   Header, always: name + ID (CAN-…), Current Application (requirement ·
//   client, or "TeamLink (internal)"), Current Stage, Next Action and who owns
//   it — where is the candidate now, who acts next, what to do.
//   Tabs: Overview · Resume · AI Scores · Applications · Pipeline ·
//   Interviews · Client Submissions · Offers · Joining · Activity.
//   Picking an application on the Applications tab switches the "current
//   application" everything else reads.
//
// Candidate = person; Application = candidate + one requirement; Stage = that
// application's stage. All the data comes from GET /candidates/:id (already
// scoped and redacted per role on the server).
// ---------------------------------------------------------------------------
export const candidateCode = (id) => `CAN-${String(id || '').slice(-8).toUpperCase()}`;
export const C360_TABS = [
  ['overview', 'Overview'],
  ['resume', 'Resume'],
  ['ai', 'AI Scores'],
  ['applications', 'Applications'],
  ['pipeline', 'Pipeline'],
  ['interviews', 'Interviews'],
  ['submissions', 'Client Submissions'],
  ['offers', 'Offers'],
  ['joining', 'Joining'],
  ['activity', 'Activity'],
];
const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const CLIENT_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
export const clientOf = (a) => {
  if (!a) return null;
  if (isInternalApp(a)) return 'TeamLink (internal)';
  return (a.requirement && a.requirement.client && a.requirement.client.name) || null;
};
const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

// The application a 360 shows: the picked one, else the latest.
export function currentAppOf(c, selectedId) {
  const apps = (c && c.applications) || [];
  return apps.find((a) => a.id === selectedId) || apps.find((a) => a.id === (c && c.latestApplicationId)) || apps[0] || null;
}

// How many rows each tab holds (shown on the tab).
export function tabCounts(c) {
  const apps = (c && c.applications) || [];
  const hist = (c && c.pipelineHistory) || [];
  return {
    applications: apps.length,
    interviews: apps.filter((a) => a.interviewStatus || a.interviewAt).length,
    submissions: new Set(hist.filter((h) => h.toStage === 'SHARED_WITH_CLIENT').map((h) => h.applicationId)
      .concat(apps.filter((a) => !isInternalApp(a) && CLIENT_STAGES.includes(a.stage)).map((a) => a.id))).size,
    offers: apps.filter((a) => a.offerStatus || ['OFFER', 'OFFER_ACCEPTED'].includes(a.stage) || a.offerDate).length,
    joining: apps.filter((a) => ['OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(a.stage) || a.joiningStatus || a.joiningDate).length,
    resume: ((c && c.documents) || []).length,
  };
}

export function C360Tabs({ tab, setTab, c, className = '' }) {
  const n = tabCounts(c);
  return (
    <div className={`tabs c360t-tabs ${className}`} role="tablist">
      {C360_TABS.map(([key, label]) => (
        <div
          key={key}
          role="tab"
          aria-selected={tab === key}
          tabIndex={0}
          className={`tab${tab === key ? ' active' : ''}`}
          onClick={() => setTab(key)}
          onKeyDown={(e) => { if (e.key === 'Enter') setTab(key); }}
        >
          {label}
          {n[key] != null && n[key] > 0 && <span className="c360t-n">{n[key]}</span>}
        </div>
      ))}
    </div>
  );
}

// The always-visible header strip.
export function C360Header({
  c, app, onBackToLatest, compact = false,
}) {
  if (!c) return null;
  const picked = app && c.latestApplicationId && app.id !== c.latestApplicationId;
  const live = app && !CLOSED.includes(app.stage);
  const fu = app && app.followUp && !app.followUp.completedAt ? app.followUp : null;
  // One named owner with an active login (utils/nextAction.js), or none.
  const owner = (fu && fu.ownerName) || app?.nextActionOwnerName || null;
  const ownerRole = (fu && fu.ownerRole) || app?.nextActionOwnerRole;
  const due = (fu && fu.dueDate) || app?.dueDate;
  const client = clientOf(app);
  return (
    <div className={`c360t-head${compact ? ' is-compact' : ''}`}>
      <div className="c360t-cell">
        <span className="c360t-k">{picked ? 'Selected application' : 'Current application'}</span>
        {app
          ? (
            <b className="c360t-v">
              {app.requirement?.title || '—'}
              <span className="c360t-sub">{client ? ` · ${client}` : ''}</span>
            </b>
          )
          : <b className="c360t-v small-muted">No application yet</b>}
        {picked && onBackToLatest && <button type="button" className="link-btn c360t-link" onClick={onBackToLatest}>back to latest</button>}
        {app && app.preAts && <span className="c360t-note">In Job Portal screening — not sent to ATS yet</span>}
      </div>
      <div className="c360t-cell">
        <span className="c360t-k">Current stage</span>
        {app
          ? <span className="c360t-v"><StatusChip status={app.stageGroupLabel || stageLabel(app.stage)}>{app.stageLabel || stageLabel(app.stage)}</StatusChip></span>
          : <span className="c360t-v small-muted">—</span>}
      </div>
      <div className="c360t-cell c360t-next">
        <span className="c360t-k">Next action</span>
        {app && live
          ? (
            <>
              <b className="c360t-v">{(fu && fu.nextAction) || app.nextAction || '—'}</b>
              <span className="c360t-sub">
                {[owner ? `${owner}${ownerRole && ownerRole !== '—' ? ` (${ownerRole})` : ''}` : (ownerRole && ownerRole !== '—' ? `${ownerRole} — no owner named` : 'No owner named'),
                  app.waitingOnParty ? 'waiting on the client' : null,
                  due ? `due ${protoDate(due)}` : 'no due date yet'].filter(Boolean).join(' · ')}
              </span>
              {app.dueStatus === 'overdue' && <StatusChip status="Overdue" />}
            </>
          )
          : <span className="c360t-v small-muted">{app ? (app.nextAction && app.nextAction !== '—' ? app.nextAction : 'Closed') : '—'}</span>}
      </div>
    </div>
  );
}

// --- Tab bodies ------------------------------------------------------------------
export function ApplicationsTab({ c, app, onSelect }) {
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`All applications of ${c.name}`}</div>
      <div className="small-muted" style={{ marginBottom: 6 }}>
        One person, many applications — each with its own stage. Click a row to make it the current application.
      </div>
      <ApplicationsList c={c} selectedId={app ? app.id : null} onSelect={(c.applications || []).length ? onSelect : null} />
    </div>
  );
}

export function PipelineTab({ c, app, user }) {
  if (!app) return <div className="small-muted">No application yet.</div>;
  const hist = (c.pipelineHistory || []).filter((h) => h.applicationId === app.id);
  return (
    <>
      <div className="c360t-card">
        <div className="c360t-label">{`Pipeline — ${app.requirement?.title || 'this application'}`}</div>
        <PipelineSteps
          user={user}
          app={app}
          stage={app.stage}
          pausedAt={pausedFrom(c.pipelineHistory, app)}
          detail={app.stageDetailLabel && app.stageDetailLabel !== app.stageGroupLabel ? `Currently ${app.stageDetailLabel}` : null}
        />
        {app.stageEnteredAt && <div className="small-muted" style={{ marginTop: 6 }}>{`In this stage since ${protoDate(app.stageEnteredAt)}`}</div>}
      </div>
      <div className="c360t-card">
        <div className="c360t-label">{`Stage history (${hist.length})`}</div>
        {hist.length === 0 && <div className="small-muted">No stage moves recorded for this application.</div>}
        {hist.slice().reverse().map((h, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`${h.when}-${i}`} className="c360t-row">
            <span className="c360t-when">{when(h.when)}</span>
            <span>
              <b>{h.fromStageLabel ? `${h.fromStageLabel} → ${h.toStageLabel}` : (h.toStageLabel || h.action)}</b>
              <span className="small-muted">{` · ${h.who && h.who !== '—' ? h.who : 'system / import'}${h.role ? ` (${h.role})` : ''}`}</span>
              {(h.reasonCategory || h.reasonDetail || h.comment) && <div className="small-muted">{[h.reasonCategory, h.reasonDetail, h.comment].filter(Boolean).join(' — ')}</div>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function InterviewsTab({ c, app, internal }) {
  const list = (c.applications || []).filter((a) => a.interviewStatus || a.interviewAt);
  return (
    <>
      <div className="c360t-card">
        <div className="c360t-label">{`Interviews (${list.length})`}</div>
        {list.length === 0 && <div className="small-muted">No interview scheduled on any application.</div>}
        {list.length > 0 && (
          <div className="tbl-wrap">
            <table className="c360t-table">
              <thead><tr><th>Requirement</th><th>Client</th><th>When</th><th>Round</th><th>Mode</th><th>Status</th><th>Result</th></tr></thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id} className={app && a.id === app.id ? 'is-selected' : undefined}>
                    <td>{a.requirement?.title || '—'}</td>
                    <td className="cell-muted">{clientOf(a) || '—'}</td>
                    <td className="cpl-nowrap">{when(a.interviewAt)}</td>
                    <td>{a.interviewRound || '—'}</td>
                    <td className="cell-muted">{a.interviewMode || '—'}</td>
                    <td>{a.interviewStatusLabel || '—'}</td>
                    <td className="cell-muted">{a.interviewResult || (a.clientFeedbackPending ? 'Feedback pending' : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {app && <ClientFeedbackSection app={app} feedbacks={c.interviewFeedbacks} internal={internal} />}
    </>
  );
}

export function SubmissionsTab({ c }) {
  const apps = c.applications || [];
  const hist = c.pipelineHistory || [];
  const sharedAt = new Map();
  hist.forEach((h) => { if (h.toStage === 'SHARED_WITH_CLIENT' && !sharedAt.has(h.applicationId)) sharedAt.set(h.applicationId, h); });
  const rows = apps.filter((a) => !isInternalApp(a) && (sharedAt.has(a.id) || CLIENT_STAGES.includes(a.stage)));
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`Client submissions (${rows.length})`}</div>
      {rows.length === 0 && <div className="small-muted">Not submitted to any client yet.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th>Client</th><th>Submitted</th><th>By</th><th>Now</th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const h = sharedAt.get(a.id);
                return (
                  <tr key={a.id}>
                    <td>{a.requirement?.title || '—'}</td>
                    <td className="cell-muted">{clientOf(a) || '—'}</td>
                    <td className="cpl-nowrap">{h ? protoDate(h.when) : <span className="small-muted">not recorded</span>}</td>
                    <td className="cell-muted">{h && h.who && h.who !== '—' ? h.who : '—'}</td>
                    <td><StatusChip status={a.stageGroupLabel || stageLabel(a.stage)}>{a.stageLabel || stageLabel(a.stage)}</StatusChip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function OffersTab({ c }) {
  const rows = (c.applications || []).filter((a) => a.offerStatus || a.offerDate || ['OFFER', 'OFFER_ACCEPTED'].includes(a.stage));
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`Offers (${rows.length})`}</div>
      {rows.length === 0 && <div className="small-muted">No offer recorded on any application.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th>Client</th><th>Offer status</th><th>Offer date</th><th>Accepted</th>{rows.some((a) => a.offeredCtc != null) && <th>CTC</th>}</tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{a.requirement?.title || '—'}</td>
                  <td className="cell-muted">{clientOf(a) || '—'}</td>
                  <td>{a.offerStatus || stageLabel(a.stage)}</td>
                  <td className="cpl-nowrap">{a.offerDate ? protoDate(a.offerDate) : '—'}</td>
                  <td className="cpl-nowrap">{a.offerAcceptedAt ? protoDate(a.offerAcceptedAt) : '—'}</td>
                  {rows.some((x) => x.offeredCtc != null) && <td>{a.offeredCtc != null ? a.offeredCtc : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function JoiningTab({ c }) {
  const rows = (c.applications || []).filter((a) => ['OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(a.stage) || a.joiningStatus || a.joiningDate);
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`Joining (${rows.length})`}</div>
      {rows.length === 0 && <div className="small-muted">No joining on any application yet.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th>Client</th><th>Joining status</th><th>Joining date</th><th>Joined</th><th>Documents</th><th>After joining</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{a.requirement?.title || '—'}</td>
                  <td className="cell-muted">{clientOf(a) || '—'}</td>
                  <td>{a.joiningStatus || stageLabel(a.stage)}</td>
                  <td className="cpl-nowrap">{a.joiningDate ? protoDate(a.joiningDate) : '—'}</td>
                  <td className="cpl-nowrap">{a.joinedAt ? protoDate(a.joinedAt) : '—'}</td>
                  <td className="cell-muted">{a.documentsStatus || '—'}</td>
                  <td className="cell-muted">{isInternalApp(a) ? (a.hrmsEmployeeId ? 'HRMS employee created' : 'HRMS employee pending') : (a.billingStatus || '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AiScoresTab({ c, app, internal }) {
  if (!internal) return <div className="small-muted">AI evaluation is internal to TeamLink.</div>;
  const apps = c.applications || [];
  return (
    <>
      {app && <AiInterviewSection app={app} history={c.pipelineHistory} />}
      <div className="c360t-card">
        <div className="c360t-label">Scores per application</div>
        <div className="small-muted" style={{ marginBottom: 6 }}>AI scores are never mixed with client interview feedback.</div>
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th style={{ textAlign: 'right' }}>Resume / match</th><th>AI interview</th><th style={{ textAlign: 'right' }}>AI score</th></tr></thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className={app && a.id === app.id ? 'is-selected' : undefined}>
                  <td>{a.requirement?.title || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{a.matchScore != null ? `${a.matchScore}%` : (a.resumeScore != null ? `${a.resumeScore}%` : '—')}</td>
                  <td className="cell-muted">{a.aiInterviewStatus || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{a.aiInterviewScore != null ? `${a.aiInterviewScore}%` : '—'}</td>
                </tr>
              ))}
              {apps.length === 0 && <tr><td colSpan={4} className="small-muted">No application yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {c.aiMatch && c.aiMatch.overall != null && (
          <div className="small-muted" style={{ marginTop: 6 }}>{`AI match against the current requirement: ${c.aiMatch.overall}%`}</div>
        )}
      </div>
    </>
  );
}

export function ActivityTab({ c, internal, limit = 0 }) {
  const items = internal
    ? (c.activity || [])
    : (c.pipelineHistory || []).map((h) => ({ when: h.when, who: h.who, what: h.toStageLabel || h.action, requirement: h.requirementTitle, kind: 'stage' }));
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`Activity (${items.length})`}</div>
      <ActivityList items={items} limit={limit || undefined} />
    </div>
  );
}

export function ResumeCard({ c }) {
  const docs = c.documents || [];
  const resume = c.resumeName || (docs.find((d) => d.docType === 'Resume') || {}).name;
  return (
    <div className="c360t-card">
      <div className="c360t-label">Resume</div>
      <div className="c360t-kv"><span>Resume</span><b>{resume || '—'}</b></div>
      {(c.currentCompany || c.currentDesignation) && <div className="c360t-kv"><span>Current</span><b>{[c.currentDesignation, c.currentCompany].filter(Boolean).join(' · ')}</b></div>}
      <div className="c360t-kv"><span>Experience</span><b>{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}{c.relevantExperienceYears != null ? ` (${c.relevantExperienceYears} relevant)` : ''}</b></div>
      {c.education && <div className="c360t-kv"><span>Education</span><b>{[c.education, c.specialization, c.institute].filter(Boolean).join(' · ')}</b></div>}
      <div className="c360t-kv"><span>Skills</span><b>{c.skills || '—'}</b></div>
      <div className="c360t-label" style={{ marginTop: 10 }}>{`Documents (${docs.length})`}</div>
      {docs.length === 0 && <div className="small-muted">No documents on file.</div>}
      {docs.slice(0, 20).map((d) => (
        <div key={d.id} className="c360t-row">
          <span className="c360t-when">{protoDate(d.createdAt)}</span>
          <span><b>{d.name}</b><span className="small-muted">{` · ${d.docType || 'Document'}`}</span></span>
        </div>
      ))}
    </div>
  );
}

export function openFullProfile(c) {
  return <Link className="btn btn-sm" to={`/candidates/${c.id}`}>Open full profile →</Link>;
}
