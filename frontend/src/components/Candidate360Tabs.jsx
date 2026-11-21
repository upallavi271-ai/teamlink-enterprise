import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import TabStrip from './ui/TabStrip.jsx'; // main tabs + More menu + the caption line (founder 2026-11-20)
import { useAuth } from '../context/AuthContext.jsx';
import { useReachRights } from './reach/reachKit.js';
import {
  C360_TAB_ALIAS, C360_MORE, C360_INTERNAL_ONLY, C360_REACH_ONLY, rememberTab,
} from '../utils/tabMap.js'; // old tab keys -> the tab that holds them now
import { protoDate, stageLabel } from '../atsVocab';
import StatusChip from './ui/StatusChip.jsx';
import {
  PipelineSteps, pausedFrom, ActivityList, AiInterviewSection, ClientFeedbackSection, isInternalApp,
} from './Candidate360.jsx';
import { ApplicationsList } from './CandidateReach.jsx';
import JoiningDropPanel from './joindrop/JoiningDropPanel.jsx'; // Joining & Drop panel (the drawer and the full page)
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
// cand7_ (Candidates §7, 2026-10-03): seven plain tabs instead of ten.
//   Overview      top facts, next step, small Applications table, "Also a good
//                 fit for …", Rejection history
//   Resume        the resume (resume/fit agent — ProfileSlots ResumeSlot)
//   Applications  every application + its steps, interviews, client
//                 submissions, offers and joining (was 6 tabs)
//   Fit           AI scores + Fit per job (resume/fit agent — FitSlot)
//   History       follow-ups timeline, activity, messages, audit (was Activity)
//   Notes         internal notes
//   Documents     documents on file
// Old tab keys (ai, pipeline, interviews, submissions, offers, joining,
// activity) map onto the new ones (C360_TAB_ALIAS) so old links keep working.
// ATS LAYOUT v3 (2026-10-03): the left side holds personal info, the resume,
// skills, CTC and notice period (components/candidate/ProfileLeft.jsx); the
// right side has the tabs — Applications (the result per client, steps,
// interviews, offers, joining, Fit, rejection history) · Resume (2026-10-09: the
// Resume card moved here from the left) · Notes · Documents ·
// Timeline (follow-ups, activity, messages; key 'history'). Overview / Fit
// fold in, so their old keys land on Applications.
// 2026-11-20 (founder: "too many tabs, it must be clear what each is for"): six main tabs, the rest under More.
//   Overview · Resume · Career · Follow-ups & notes · Documents · History | More: Conversation · AI Calling
// Notes and the follow-up log were two tabs about the same thing (what we said to this person and what
// is next): one tab now. Old keys land on the new tab (utils/tabMap.js).
export const C360_TABS = [
  ['applications', 'Overview'], // the whole profile: personal info, work facts, skills, consent and the applications
  ['resume', 'Resume'], // the Resume card (file, Edit resume, versions, facts) — was on the left of the page
  // 2026-11-17 (founder audit): education list, employment history, gaps, career progression, summary, tags, custom fields (internal logins only)
  ['career', 'Career'],
  // Notes + the dated follow-up log (internal logins only). Key stays 'followups'; ?tab=notes lands here.
  ['followups', 'Follow-ups & notes'],
  ['documents', 'Documents'],
  ['history', 'History'], // steps, interviews, offers, messages and calls, and every change — in date order (?tab=timeline lands here)
  // Under More: omnichannel Call · Mail · WhatsApp · SMS in one timeline, with a reply box (needs the right to contact the person)
  ['conversation', 'Conversation'],
  // 2026-11-20 (founder: "schedule ANY kind of message ... on the candidate's profile"): write a message and send it later on WhatsApp / SMS / Email;
  // every scheduled, sent, failed and cancelled message of this person, plus their automatic interview / joining reminders (internal logins only; under More)
  ['scheduled', 'Schedule a message'],
  // 2026-11-04: this candidate's AI calls and the Call button (needs the right to contact the person)
  ['aicalling', 'AI Calling'],
  // market wave B (2026-11-21): client resume PDF, submission notes + packet, update link, enrichment, pools, checks (internal; under More)
  ['tools', 'Hiring tools'],
];
// What each tab is for: the line under the strip, and the tab's tooltip.
export const C360_SAY = {
  applications: 'The whole profile at a glance: who this person is, where each application stands, and the next step.',
  resume: 'The CV on file: open it, replace it, see its versions and the facts read from it.',
  career: 'Education, jobs, gaps and career progression, with tags and custom fields.',
  followups: 'When we last spoke to this person and what is due next, plus the internal notes about them.',
  documents: 'Documents on file for this person: ID, certificates, offer and joining papers.',
  history: 'Everything that happened, in date order: steps, interviews, offers, messages, calls and changes.',
  conversation: 'Call, mail, WhatsApp or SMS this person from one place, and read every reply.',
  scheduled: 'Write a WhatsApp, SMS or email now and send it later; every scheduled, sent and cancelled message of this person.',
  aicalling: 'Calls the AI made to this person, and a button to start another.',
  tools: 'The client resume PDF, submission notes and packets, the profile-update link, gaps filled from the resume, talent pools and checks.',
};
export const tabKeyOf = (k) => { const v = String(k || '').toLowerCase(); return C360_TAB_ALIAS[v] || (C360_TABS.some(([x]) => x === v) ? v : 'applications'); };
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
    notes: ((c && c.notes) || []).length, // drawn on Follow-ups & notes
    documents: ((c && c.documents) || []).length,
  };
}

export function C360Tabs({ tab, setTab, c, className = '' }) {
  const n = tabCounts(c);
  const { user } = useAuth() || {};
  const reach = useReachRights();
  const internal = !!(c && c.viewer && c.viewer.internal);
  // Same order and names for everyone; a login's irrelevant tabs are hidden: a client / candidate login has
  // none of TeamLink's own tabs, and Conversation / AI Calling need the right to contact the person
  // (the server decides: not a BDE, BDE TL or Accounts login).
  const visible = (key) => (internal || !C360_INTERNAL_ONLY.includes(key))
    && (!C360_REACH_ONLY.includes(key) || (internal && reach.loaded && reach.one));
  const tabs = C360_TABS.filter(([key]) => visible(key));
  // An address that names a tab this login does not get lands on Overview (once the rights are known).
  useEffect(() => {
    if (!c) return;
    if (C360_REACH_ONLY.includes(tab) && internal && !reach.loaded) return;
    if (!visible(tab)) setTab('applications');
  }, [tab, c, reach.loaded, reach.one]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = (key) => (key === 'followups' ? n.notes : key === 'applications' ? 0 : n[key]);
  return (
    <TabStrip
      className={`c360t-tabs ${className}`}
      label="Candidate tabs"
      value={tab}
      onChange={(k) => { rememberTab('c360', user && user.id, k); setTab(k); }}
      tabs={tabs.map(([key, label]) => ({
        key, label, say: C360_SAY[key], hint: C360_SAY[key], count: count(key), more: C360_MORE.includes(key),
      }))}
    />
  );
}

// The always-visible header strip.
export function C360Header({
  c, app, onBackToLatest, compact = false,
}) {
  if (!c) return null;
  const picked = app && c.latestApplicationId && app.id !== c.latestApplicationId;
  const live = app && !CLOSED.includes(app.stage) && !app.left; // a person who left after joining is not 'live': the strip shows the Dropped line instead
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
        {app && app.preAts && <span className="c360t-note">New from job portal — not checked yet</span>}
      </div>
      <div className="c360t-cell">
        <span className="c360t-k">Step</span>
        {app
          ? <span className="c360t-v"><StatusChip status={app.stageGroupLabel || stageLabel(app.stage)}>{app.stageLabel || stageLabel(app.stage)}</StatusChip></span>
          : <span className="c360t-v small-muted">—</span>}
      </div>
      <div className="c360t-cell c360t-next">
        <span className="c360t-k">Next step</span>
        {app && live
          ? (
            <>
              <b className="c360t-v">{(fu && fu.nextAction) || app.nextAction || '—'}</b>
              <span className="c360t-sub">
                {[owner ? `${owner}${ownerRole && ownerRole !== '—' ? ` (${ownerRole})` : ''}` : (ownerRole && ownerRole !== '—' ? `${ownerRole} — no one named` : 'No one named'),
                  app.waitingOnParty ? 'waiting for the client' : null,
                  due ? `due ${protoDate(due)}` : 'no due date yet'].filter(Boolean).join(' · ')}
              </span>
              {app.dueStatus === 'overdue' && <StatusChip status="Late" />}
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
        Each requirement has its own step. Click a row to see that requirement.
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
        <div className="c360t-label">{`Progress — ${app.requirement?.title || 'this requirement'}`}</div>
        <PipelineSteps
          user={user}
          app={app}
          stage={app.stage}
          pausedAt={pausedFrom(c.pipelineHistory, app)}
          detail={app.stageDetailLabel && app.stageDetailLabel !== app.stageGroupLabel ? `Currently ${app.stageDetailLabel}` : null}
        />
        {app.stageEnteredAt && <div className="small-muted" style={{ marginTop: 6 }}>{`At this step since ${protoDate(app.stageEnteredAt)}`}</div>}
      </div>
      <div className="c360t-card">
        <div className="c360t-label">{withCount('Step history', hist.length)}</div>
        {hist.length === 0 && <div className="small-muted">No step moves yet for this requirement.</div>}
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
        <div className="c360t-label">{withCount('Interviews', list.length)}</div>
        {list.length === 0 && <div className="small-muted">No interviews yet.</div>}
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
                    <td className="cell-muted">{a.interviewResult || (a.clientFeedbackPending ? 'Waiting for feedback' : '—')}</td>
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
      <div className="c360t-label">{withCount('Sent to client', rows.length)}</div>
      {rows.length === 0 && <div className="small-muted">Not sent to any client yet.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th>Client</th><th>Sent</th><th>By</th><th>Now</th></tr></thead>
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
      <div className="c360t-label">{withCount('Offers', rows.length)}</div>
      {rows.length === 0 && <div className="small-muted">No offers yet.</div>}
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
      <div className="c360t-label">{withCount('Joining', rows.length)}</div>
      {rows.length === 0 && <div className="small-muted">No one waiting to join yet.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th>Client</th><th>Joining status</th><th>Joining date</th><th>Joined</th><th>Documents</th><th>After joining</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{a.requirement?.title || '—'}</td>
                  <td className="cell-muted">{clientOf(a) || '—'}</td>
                  <td>{a.left ? <StatusChip tone="red">Dropped</StatusChip> : (a.joiningStatus || stageLabel(a.stage))}{a.left && a.leftOn && <div className="small-muted">{`on ${protoDate(a.leftOn)}${a.leftReason ? ` · ${a.leftReason}` : ''}`}</div>}</td>
                  <td className="cpl-nowrap">{a.joiningDate ? protoDate(a.joiningDate) : '—'}</td>
                  <td className="cpl-nowrap">{a.joinedAt ? protoDate(a.joinedAt) : '—'}</td>
                  <td className="cell-muted">{a.documentsStatus || '—'}</td>
                  <td className="cell-muted">{isInternalApp(a) ? (a.hrmsEmployeeId ? 'Employee added' : 'Employee not added yet') : (a.billingStatus || '—')}</td>
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
  if (!internal) return <div className="small-muted">AI scores are only for the TeamLink team.</div>;
  const apps = c.applications || [];
  return (
    <>
      {app && <AiInterviewSection app={app} history={c.pipelineHistory} />}
      <div className="c360t-card">
        <div className="c360t-label">Scores per requirement</div>
        <div className="small-muted" style={{ marginBottom: 6 }}>AI scores are kept apart from client feedback.</div>
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th style={{ textAlign: 'right' }}>Fit %</th><th>AI interview</th><th style={{ textAlign: 'right' }}>AI score</th></tr></thead>
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
          <div className="small-muted" style={{ marginTop: 6 }}>{`Fit for the current requirement: ${c.aiMatch.overall}%`}</div>
        )}
      </div>
    </>
  );
}

// Never a bare zero: "Notes", not "Notes (0)".
const withCount = (label, n) => (n ? `${label} (${n})` : label);

export function ActivityTab({ c, internal, limit = 0 }) {
  const items = internal
    ? (c.activity || [])
    : (c.pipelineHistory || []).map((h) => ({ when: h.when, who: h.who, what: h.toStageLabel || h.action, requirement: h.requirementTitle, kind: 'stage' }));
  return (
    <div className="c360t-card">
      <div className="c360t-label">{withCount('Activity', items.length)}</div>
      <ActivityList items={items} limit={limit || undefined} />
    </div>
  );
}

export function ResumeCard({ c, hideDocuments = false }) {
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
      {!hideDocuments && <DocumentsList docs={docs} />}
    </div>
  );
}

function DocumentsList({ docs }) {
  return (
    <>
      <div className="c360t-label" style={{ marginTop: 10 }}>{withCount('Documents', docs.length)}</div>
      {docs.length === 0 && <div className="small-muted">No documents on file.</div>}
      {docs.slice(0, 50).map((d) => (
        <div key={d.id} className="c360t-row">
          <span className="c360t-when">{protoDate(d.createdAt)}</span>
          <span>
            <b>{d.name}</b>
            <span className="small-muted">{` · ${d.docType || 'Document'}${d.uploadedByName ? ` · ${d.uploadedByName}` : ''}${d.internalOnly ? ' · internal only' : ''}`}</span>
            {d.note && <div className="small-muted">{d.note}</div>}
          </span>
        </div>
      ))}
    </>
  );
}

// --- cand7_: Overview's small Applications table -------------------------------
// Job · Client · Step · Fit % · Status. A row makes that application the one
// the profile shows.
export function ApplicationsMini({ c, app, onSelect }) {
  const apps = [...((c && c.applications) || [])].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  const internal = !!(c && c.viewer && c.viewer.internal);
  return (
    <div className="c360t-card">
      <div className="c360t-label">{withCount('Applications', apps.length)}</div>
      {apps.length === 0 && <div className="small-muted">Not added to any requirement yet.</div>}
      {apps.length > 0 && (
        <div className="tbl-wrap">
          <table className="c360t-table">
            <thead><tr><th>Requirement</th><th>Client</th><th>Step</th>{internal && <th>Where from</th>}{internal && <th style={{ textAlign: 'right' }}>Fit</th>}<th>Status</th></tr></thead>
            <tbody>
              {apps.slice(0, 8).map((a) => (
                <tr
                  key={a.id}
                  className={app && a.id === app.id ? 'is-selected' : undefined}
                  style={onSelect && apps.length > 1 ? { cursor: 'pointer' } : undefined}
                  onClick={onSelect && apps.length > 1 ? () => onSelect(a.id) : undefined}
                >
                  <td>{a.requirement?.title || '—'}</td>
                  <td className="cell-muted">{clientOf(a) || '—'}</td>
                  <td><StatusChip status={a.stageGroupLabel || stageLabel(a.stage)}>{a.stageLabel || stageLabel(a.stage)}</StatusChip></td>
                  {internal && <td className="cell-muted" title={a.sourceRaw && a.sourceRaw !== a.sourceKey ? `Recorded as: ${a.sourceRaw}` : undefined}>{a.sourceKey || '—'}</td>}
                  {internal && <td style={{ textAlign: 'right' }}>{a.matchScore != null ? `${a.matchScore}%` : (a.resumeScore != null ? `${a.resumeScore}%` : '—')}</td>}
                  <td className="cell-muted">{a.lifeStatus || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {apps.length > 8 && <div className="small-muted">{`+${apps.length - 8} more on the Applications tab`}</div>}
      {c.otherTeamApplications > 0 && <div className="small-muted">{`${c.otherTeamApplications} more with other teams.`}</div>}
    </div>
  );
}

// --- cand7_: the merged Applications tab -----------------------------------------
// Every application, then — for the one picked — its steps, and the person's
// interviews, client submissions, offers and joining (once six tabs).
export function ApplicationsFullTab({
  c, app, user, internal, onSelect, extra = null, hideList = false,
}) {
  const n = tabCounts(c);
  return (
    <>
      {/* v3: the profile shows the per-client table (ApplicationsMini) above, so it can skip this list. */}
      {!hideList && <ApplicationsTab c={c} app={app} onSelect={onSelect} />}
      <PipelineTab c={c} app={app} user={user} />
      {extra}
      {(n.interviews > 0 || app) && <InterviewsTab c={c} app={app} internal={internal} />}
      {n.submissions > 0 && <SubmissionsTab c={c} />}
      {n.offers > 0 && <OffersTab c={c} />}
      {n.joining > 0 && <JoiningTab c={c} />}
      {internal && app && <JoiningDropPanel app={app} />}
    </>
  );
}

// --- cand7_: Notes and Documents tabs ---------------------------------------------
export function NotesTab({ c, canAdd = false, onAdd }) {
  const notes = (c && c.notes) || [];
  return (
    <div className="c360t-card">
      <div className="c360t-label">{withCount('Notes', notes.length)}</div>
      <div className="small-muted" style={{ marginBottom: 6 }}>Only TeamLink staff see these notes. Clients never do.</div>
      {canAdd && <NoteForm onAdd={onAdd} />}
      {notes.length === 0 && <div className="small-muted">No notes yet.</div>}
      {notes.map((x) => (
        <div key={x.id} className="c360t-row">
          <span className="c360t-when">{when(x.createdAt)}</span>
          <span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{x.body}</span>
            <div className="small-muted">{[x.authorName, x.authorRole].filter(Boolean).join(' · ') || '—'}</div>
          </span>
        </div>
      ))}
    </div>
  );
}

function NoteForm({ onAdd }) {
  return (
    <form
      style={{ marginBottom: 10 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const body = f.elements.note.value.trim();
        if (!body) return;
        const ok = await onAdd(body);
        if (ok !== false) f.reset();
      }}
    >
      <textarea name="note" rows="3" style={{ width: '100%' }} placeholder="What the next person needs to know…" />
      <button type="submit" className="btn btn-sm btn-primary" style={{ marginTop: 6 }}>Save note</button>
    </form>
  );
}

export function DocumentsTab({ c, children = null }) {
  return (
    <div className="c360t-card">
      <DocumentsList docs={(c && c.documents) || []} />
      {children}
    </div>
  );
}

export function openFullProfile(c) {
  return <Link className="btn btn-sm" to={`/candidates/${c.id}`}>Open full profile →</Link>;
}
