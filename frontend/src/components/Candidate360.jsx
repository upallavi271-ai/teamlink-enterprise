import { useEffect, useRef, useState } from 'react';
import api from '../api';
import Combo from './Combo.jsx';
import Modal from './Modal.jsx';
import ContactPanel from './ContactPanel.jsx';
import CandidateBulkActions from './CandidateBulkActions.jsx';
import StatusChip from './ui/StatusChip.jsx';
import {
  can, canMoveToStage, workflowStages, productRole,
} from '../permissions';
import {
  stageLabel, protoDate, interviewStatusLabel, stageLabelFor, isPreAtsApplication, INTERNAL_HIRE,
  HOLD_REASON_CATEGORIES, REJECTED_BY_OPTIONS, REJECTION_REASONS_BY_SIDE, REJECTION_REASON_CATEGORIES,
} from '../atsVocab';
import { STAGE_GROUPS } from '../pipelineView';
import './CandidateDrawer.css';

// ---------------------------------------------------------------------------
// CANDIDATE 360° building blocks (review #2 §11, review #3 §6 §7 §16) — shared
// by the side panel (CandidateDrawer), the full page (CandidateDetail) and the
// list (Candidates) so the three can never disagree.
//
//   viewerStageRole / relevantGroups   which pipeline stages matter to THIS
//                    login (review #3 §6): Recruiter New → (AI Interview if
//                    used) → Recruiter Review → TL Review; TL Recruiter Review
//                    → TL Review → BDE / Client Review; BDE BDE Review → Client
//                    Review → Interview → Selected → Offer → Joined; Super
//                    Admin / Manager / Asst Manager / STL everything
//   nextActionsFor   the ONE next move for this login at this stage (§16):
//                    Review Candidate → · Send to TL → · Approve → / Return →
//                    · Share with Client → · Schedule →
//   PipelineSteps    the role's steps, ✓ on the completed ones; a candidate
//                    outside them still shows its real stage as a chip
//   CandidateActions [next action] [Move Stage] [Schedule Interview] [⋯] —
//                    only what the role may do; the API re-checks every move
//   AiInterviewSection / ClientFeedbackSection — two SEPARATE sections, never
//                    mixed ("AI Interview · Score 82% · Completed 27 Sep")
//   ReturnDialog     TL Return → with a reason (POST /candidates/applications/
//                    :id/return, permission-checked server-side + audited)
// ---------------------------------------------------------------------------

// --- Role-relevant stages ----------------------------------------------------
export const ROLE_GROUPS = {
  recruiter: ['new', 'ai_interview', 'recruiter_review', 'tl_review'],
  tl: ['recruiter_review', 'tl_review', 'bde_review', 'client_review'],
  bde: ['bde_review', 'client_review', 'interview', 'selected', 'offer', 'joining', 'joined'],
  client: ['client_review', 'interview', 'selected', 'offer', 'joining', 'joined'],
  // HR runs internal hiring: HR Review → Dept Head / TL → Interview → … →
  // Joining (→ HRMS). No BDE / client steps (the actual workflow, 2026-09-29).
  hr: ['new', 'ai_interview', 'recruiter_review', 'tl_review', 'interview', 'selected', 'offer', 'joining', 'joined'],
  all: STAGE_GROUPS.map((g) => g.id),
};
// Shown to a non-"all" login only when it is actually in use (count > 0 /
// the candidate took it) — "AI Interview if used".
export const OPTIONAL_GROUPS = new Set(['ai_interview']);

const GLOBAL_ROLES = ['SUPER_ADMIN', 'ADMIN'];
export function viewerAtsRole(user) {
  if (!user) return '';
  const alias = user.scopeRoles && user.scopeRoles.ats;
  return (alias && alias !== 'NONE' ? alias : productRole(user, 'ats')) || '';
}
export function viewerStageRole(user) {
  if (!user) return 'all';
  const r = viewerAtsRole(user);
  if (GLOBAL_ROLES.includes(user.role) || GLOBAL_ROLES.includes(r)) return 'all';
  if (r === 'RECRUITER') return 'recruiter';
  if (r === 'TL') return 'tl';
  if (r === 'BDE') return 'bde';
  if (r === 'CLIENT') return 'client';
  if (r === 'HR') return 'hr';
  return 'all'; // Manager / Asst Manager / STL / an admin-like custom role
}
export function relevantGroups(user) {
  return ROLE_GROUPS[viewerStageRole(user)] || ROLE_GROUPS.all;
}

// --- The one next action (§16) ------------------------------------------------
const RECRUITER_STEP = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'];
export function mayReturn(user) {
  const r = viewerAtsRole(user);
  const lead = GLOBAL_ROLES.includes(user && user.role) || ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'].includes(r);
  return lead && canMoveToStage(user, 'RECRUITER_REVIEW');
}
export function maySchedule(user) {
  return canMoveToStage(user, 'INTERVIEW_SCHEDULED') && can(user, 'ats', 'interviews', 'Schedule Interview', 'create');
}
// [{ id, label, kind: 'move' | 'return' | 'schedule', to? }] — the first is the
// primary button. Only the moves THIS role owns at this step: a TL is not
// offered the recruiter's "Review Candidate", a recruiter not the TL's Approve.
// An application on one of TeamLink's own openings (the internal chain).
export function isInternalApp(app) {
  if (!app) return false;
  if (app.hiringType) return app.hiringType === INTERNAL_HIRE;
  const r = app.requirement || {};
  return !!r.internal || r.hiringType === INTERNAL_HIRE;
}
export function nextActionsFor(user, stage, app = null) {
  if (!stage || !user) return [];
  const role = viewerStageRole(user);
  const is = (...roles) => role === 'all' || roles.includes(role);
  const out = [];
  // STILL IN THE JOB PORTAL SCREENING: the work is on the Job Portal's
  // Applications & screening tab, ending in Send to ATS.
  if (app && isPreAtsApplication(app)) {
    if (['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(stage) && is('recruiter', 'hr')) {
      out.push({ id: 'send_to_ats', label: 'Send to ATS', kind: 'send_to_ats' });
    } else if (is('recruiter', 'hr')) {
      out.push({ id: 'screening', label: 'Open Job Portal screening', kind: 'screening' });
    }
    return out;
  }
  // INTERNAL HIRING: HR Review → Dept Head / TL → Interview (no BDE / client).
  if (app && isInternalApp(app)) {
    if (RECRUITER_STEP.includes(stage) || ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(stage)) {
      if (is('hr', 'recruiter') && canMoveToStage(user, 'TL_REVIEW')) out.push({ id: 'send_to_dept', label: 'Send to Dept Head / TL', kind: 'move', to: 'TL_REVIEW' });
    } else if (stage === 'TL_REVIEW') {
      if (is('tl') && maySchedule(user)) out.push({ id: 'approve_interview', label: 'Approve → Schedule Interview', kind: 'schedule' });
      if (is('tl') && mayReturn(user)) out.push({ id: 'return', label: 'Return to HR', kind: 'return' });
    } else if (stage === 'JOINED') {
      if (is('hr') && can(user, 'ats', 'interviews', 'Internal Hiring', 'approve')) out.push({ id: 'hrms', label: 'Create HRMS Employee', kind: 'hrms' });
    }
    return out;
  }
  if (RECRUITER_STEP.includes(stage)) {
    if (is('recruiter') && canMoveToStage(user, 'RECRUITER_REVIEW')) out.push({ id: 'review', label: 'Review Candidate', kind: 'move', to: 'RECRUITER_REVIEW' });
  } else if (['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(stage)) {
    if (is('recruiter') && canMoveToStage(user, 'TL_REVIEW')) out.push({ id: 'send_to_tl', label: 'Send to TL', kind: 'move', to: 'TL_REVIEW' });
  } else if (stage === 'TL_REVIEW') {
    if (is('tl') && canMoveToStage(user, 'WITH_BDE')) out.push({ id: 'approve', label: 'Approve', kind: 'move', to: 'WITH_BDE' });
    if (is('tl') && mayReturn(user)) out.push({ id: 'return', label: 'Return', kind: 'return' });
  } else if (['WITH_BDE', 'BDE_APPROVED'].includes(stage)) {
    if (is('bde') && canMoveToStage(user, 'SHARED_WITH_CLIENT')) out.push({ id: 'share', label: 'Submit to Client', kind: 'move', to: 'SHARED_WITH_CLIENT' });
  } else if (stage === 'CLIENT_SHORTLISTED') {
    if (is('bde') && maySchedule(user)) out.push({ id: 'schedule', label: 'Schedule', kind: 'schedule' });
  }
  return out;
}

// --- Pipeline steps -----------------------------------------------------------
// THE ACTUAL WORKFLOW (2026-09-29), drawn per kind of hire. `groups` names
// the pipelineView group ids a step belongs to, which is what the role's
// relevant-stage list (ROLE_GROUPS) filters on.
//   Client:   Screening → Recruiter Review → TL Review → BDE Review → Client
//             Submission → Client Decision → Interview → Feedback → Selected
//             → Offer → Offer Accepted → Joining
//   Internal: Screening → HR Review → Dept Head / TL → Interview → Feedback
//             → Selected → Offer → Joining → HRMS
const SCREENING_STEP = { id: 'screening', label: 'Screening', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'], groups: ['new', 'ai_interview'] };
export const PIPELINE_STEPS = [
  SCREENING_STEP,
  { id: 'recruiter_review', label: 'Recruiter Review', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { id: 'tl_review', label: 'TL Review', stages: ['TL_REVIEW'] },
  { id: 'bde_review', label: 'BDE Review', stages: ['WITH_BDE', 'BDE_APPROVED'] },
  { id: 'client_submission', label: 'Client Submission', stages: ['SHARED_WITH_CLIENT'], groups: ['client_review'] },
  { id: 'client_decision', label: 'Client Decision', stages: ['CLIENT_REVIEW', 'CLIENT_SHORTLISTED'], groups: ['client_review'] },
  { id: 'interview', label: 'Interview', stages: ['INTERVIEW_SCHEDULED'], groups: ['interview'] },
  { id: 'feedback', label: 'Feedback', stages: ['INTERVIEW_COMPLETED'], groups: ['interview'] },
  { id: 'selected', label: 'Selected', stages: ['SELECTED'] },
  { id: 'offer', label: 'Offer', stages: ['OFFER'], groups: ['offer'] },
  { id: 'offer_accepted', label: 'Offer Accepted', stages: ['OFFER_ACCEPTED'], groups: ['joining'] },
  { id: 'joined', label: 'Joining', stages: ['JOINED', 'HIRED'], groups: ['joined'] },
];
export const INTERNAL_PIPELINE_STEPS = [
  SCREENING_STEP,
  { id: 'recruiter_review', label: 'HR Review', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { id: 'tl_review', label: 'Dept Head / TL', stages: ['TL_REVIEW'] },
  { id: 'interview', label: 'Interview', stages: ['INTERVIEW_SCHEDULED'], groups: ['interview'] },
  { id: 'feedback', label: 'Feedback', stages: ['INTERVIEW_COMPLETED'], groups: ['interview'] },
  { id: 'selected', label: 'Selected', stages: ['SELECTED'] },
  { id: 'offer', label: 'Offer', stages: ['OFFER', 'OFFER_ACCEPTED'], groups: ['offer', 'joining'] },
  { id: 'joined', label: 'Joining', stages: ['JOINED'], groups: ['joined'] },
  { id: 'hrms', label: 'HRMS', stages: ['HIRED'], groups: ['joined'] },
];
export function stepsFor(app) {
  return isInternalApp(app) ? INTERNAL_PIPELINE_STEPS : PIPELINE_STEPS;
}
export function stepIndexOf(stage, steps = PIPELINE_STEPS) {
  return steps.findIndex((s) => s.stages.includes(stage));
}

// Did this application use the AI interview at all?
export function usedAiInterview(app) {
  if (!app) return false;
  if (app.aiInterviewScore != null) return true;
  if (['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'].includes(app.stage)) return true;
  return ['Scheduled', 'Started', 'Completed', 'Manual Review Requested'].includes(app.aiInterviewStatus);
}

// Where a held / rejected application was when it stopped: the latest move
// INTO that status, read from the pipeline history.
export function pausedFrom(history, app) {
  if (!app || !['HOLD', 'REJECTED'].includes(app.stage)) return null;
  const ev = (history || []).find((h) => h.applicationId === app.id && h.toStage === app.stage && h.fromStage);
  return ev ? ev.fromStage : null;
}

// The steps this login sees, ✓ on the completed ones. With no user (or an
// "all" login) every step is drawn.
export function PipelineSteps({
  stage, pausedAt, detail, user, app,
}) {
  const role = viewerStageRole(user);
  const rel = ROLE_GROUPS[role] || ROLE_GROUPS.all;
  const paused = stage === 'HOLD' || stage === 'REJECTED';
  const all = stepsFor(app);
  const internalApp = isInternalApp(app);
  const stepIndexById = (id) => all.findIndex((s) => s.id === id);
  const at = stepIndexOf(paused ? pausedAt : stage, all);
  const steps = all.filter((s) => {
    const ids = s.groups || [s.id];
    // An internal application is drawn in full for every viewer who can open
    // it (HR, the Dept Head / TL, management) — its chain is short.
    if (!internalApp && !ids.some((id) => rel.includes(id))) return false;
    return true;
  });
  const idxs = steps.map((s) => stepIndexById(s.id));
  const outside = at >= 0 && !idxs.includes(at) ? all[at] : null;
  const before = outside && idxs.length && at < idxs[0];
  const chip = outside && (
    <span className="c360-step-out">
      <StatusChip status={outside.label} tone={paused ? (stage === 'REJECTED' ? 'red' : 'amber') : 'blue'}>
        {`Now at ${outside.label}`}
      </StatusChip>
    </span>
  );
  return (
    <div className="c360-steps" role="list" aria-label={internalApp ? 'Internal hiring pipeline' : 'Client hiring pipeline'}>
      {app && (
        <span className="c360-step-kind small-muted" style={{ fontSize: 11, marginRight: 6 }}>
          {`${internalApp ? 'Internal hiring' : 'Client hiring'}${isPreAtsApplication(app) ? ' · in Job Portal screening' : ''}`}
        </span>
      )}
      {before && chip}
      {steps.map((s) => {
        const i = stepIndexById(s.id);
        let cls = '';
        const done = at >= 0 && i < at;
        if (done) cls = ' is-done';
        if (i === at) cls = paused ? (stage === 'REJECTED' ? ' is-rejected' : ' is-hold') : ' is-current';
        return (
          <div key={s.id} role="listitem" className={`c360-step${cls}`} aria-current={i === at ? 'step' : undefined}>
            <span className="c360-dot" aria-hidden="true">{done ? '✓' : ''}</span>
            <span className="c360-step-label">{s.label}</span>
          </div>
        );
      })}
      {!before && chip}
      {(paused || detail) && (
        <div className="c360-steps-note">
          {paused
            ? `${stage === 'REJECTED' ? 'Rejected' : 'On hold'}${pausedAt ? ` at ${stageLabelFor(pausedAt, { internal: internalApp })}` : ''}`
            : detail}
        </div>
      )}
    </div>
  );
}

export function OwnershipGrid({ o, compact }) {
  if (!o) return null;
  const rows = [
    ['Department', o.department],
    ['Section', o.section],
    ['TL', o.tl],
    ['Recruiter', o.recruiter ? `${o.recruiter}${o.positionCode ? ` · ${o.positionCode}` : ''}` : (o.positionCode || null)],
    ['BDE', o.bde],
  ];
  return (
    <div className={`c360-own${compact ? ' is-compact' : ''}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="c360-own-item">
          <span>{k}</span>
          <b>{v || '—'}</b>
        </div>
      ))}
    </div>
  );
}

const dt = (v) => (v
  ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const shortDate = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
};

export function ActivityList({ items, limit }) {
  const list = limit ? (items || []).slice(0, limit) : (items || []);
  if (!list.length) return <div className="small-muted">No activity recorded yet.</div>;
  return (
    <div className="c360-activity">
      {list.map((h, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="cdw-tl">
          <span className={`cdw-tl-dot${h.kind === 'audit' ? ' is-audit' : ''}`} />
          <div style={{ minWidth: 0 }}>
            <div>
              <b>{h.who || 'System'}</b>
              {h.role ? <span className="small-muted">{` (${h.role})`}</span> : null}
              {` · ${h.what}`}
            </div>
            <div className="small-muted">
              {`${protoDate(h.when)} ${h.when ? new Date(h.when).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}`}
              {h.requirement ? ` · ${h.requirement}` : ''}
              {h.derived ? ' · derived from the record' : ''}
            </div>
            {h.why && <div className="small-muted c360-why">{`Why: ${h.why}`}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- AI interview vs client feedback — SEPARATE (review #3 §7 §11) ----------
// The AI status has its own meaning, so its colour is given explicitly:
// Required is still owed (amber), Completed green, Expired red.
const AI_TONE = {
  Required: 'amber', Scheduled: 'blue', Started: 'amber', Completed: 'green', Expired: 'red', 'Manual Review Requested': 'amber',
};
export function aiCompletedAt(history, app) {
  if (!app) return null;
  const ev = (history || []).find((h) => h.applicationId === app.id && h.toStage === 'AI_INTERVIEW_COMPLETED');
  return ev ? ev.when : null;
}
// "AI Interview · Score 82% · Completed 27 Sep"
export function aiHeadline(app, completedAt) {
  if (!app) return null;
  const done = app.aiInterviewStatus === 'Completed' || app.aiInterviewScore != null;
  if (done) {
    return ['AI Interview', app.aiInterviewScore != null ? `Score ${app.aiInterviewScore}%` : null,
      `Completed${completedAt ? ` ${shortDate(completedAt)}` : ''}`].filter(Boolean).join(' · ');
  }
  if (!usedAiInterview(app) && !PIPELINE_STEPS.slice(0, 2).some((s) => s.stages.includes(app.stage))) {
    return 'AI Interview · Not taken — screened by the recruiter';
  }
  return `AI Interview · ${app.aiInterviewStatus || 'Required'}`;
}

export function AiInterviewSection({ app, history, bare }) {
  if (!app) return null;
  const at = aiCompletedAt(history, app);
  const status = app.aiInterviewScore != null ? 'Completed' : (app.aiInterviewStatus || 'Required');
  const body = (
    <>
      <div className="c360-ai-head">
        <b>{aiHeadline(app, at)}</b>
        <StatusChip status={status} tone={AI_TONE[status]} />
      </div>
      {app.aiInterviewFeedback && <div className="cdw-text">{app.aiInterviewFeedback}</div>}
      <div className="small-muted c360-fb-foot">Machine screening only — never mixed with client feedback.</div>
    </>
  );
  if (bare) return <div className="c360-fb-card">{body}</div>;
  return (
    <section className="cdw-card c360-ai">
      <div className="cdw-label">AI Interview</div>
      {body}
    </section>
  );
}

const scoreLine = (f) => ['technical', 'communication', 'experience', 'roleFit']
  .filter((k) => f[k] != null).map((k) => `${k === 'roleFit' ? 'Role fit' : k[0].toUpperCase() + k.slice(1)} ${f[k]}/5`).join(' · ');

// "Client Interview · Pending Feedback" — the client's own decision / feedback,
// plus (internal logins) the panel's internal interview feedback.
export function ClientFeedbackSection({ app, feedbacks, internal, bare }) {
  if (!app) return null;
  const mine = (feedbacks || []).filter((f) => f.applicationId === app.id);
  const client = mine.find((f) => f.kind === 'Client');
  const inner = mine.find((f) => f.kind === 'Internal');
  const ivLabel = app.interviewStatus ? (app.interviewStatusLabel || interviewStatusLabel(app.interviewStatus)) : null;
  const head = client
    ? `Client Interview · ${client.recommendation || 'Feedback recorded'}`
    : ivLabel ? `Client Interview · ${ivLabel}` : 'Client Interview · Not scheduled';
  const body = (
    <>
      <div className="c360-ai-head">
        <b>{head}</b>
        {client
          ? <StatusChip status={client.recommendation} />
          : ivLabel && <StatusChip status={ivLabel} />}
      </div>
      {client ? (
        <>
          {scoreLine(client) && <div className="small-muted">{scoreLine(client)}</div>}
          <div className="cdw-text">{client.overall}</div>
          <div className="small-muted c360-fb-foot">{`${client.submittedBy || 'Client'} · ${protoDate(client.createdAt)}`}</div>
        </>
      ) : (
        <>
          {app.interviewResult && <div className="cdw-kv"><span>Result</span><b>{app.interviewResult}</b></div>}
          {internal && app.interviewFeedback && <div className="cdw-text"><span className="small-muted">Interview notes (internal): </span>{app.interviewFeedback}</div>}
          {!app.interviewResult && !(internal && app.interviewFeedback) && <div className="small-muted">No client feedback recorded yet.</div>}
        </>
      )}
      {internal && inner && (
        <div className="c360-fb-card" style={{ marginTop: 8 }}>
          <div className="cdw-label">Internal interview feedback</div>
          <div className="cdw-kv"><span>Recommendation</span><StatusChip status={inner.recommendation} /></div>
          {scoreLine(inner) && <div className="small-muted">{scoreLine(inner)}</div>}
          <div className="cdw-text">{inner.overall}</div>
          <div className="small-muted c360-fb-foot">{`${inner.submittedBy || '—'} · ${protoDate(inner.createdAt)}`}</div>
        </div>
      )}
    </>
  );
  if (bare) return <div className="c360-fb-card">{body}</div>;
  return (
    <section className="cdw-card c360-client">
      <div className="cdw-label">Client Feedback</div>
      {body}
    </section>
  );
}

// Both, side by side, never averaged or mixed (the full page's Feedback tab).
export function FeedbackSplit({
  app, feedbacks, internal, history,
}) {
  if (!app) return <div className="small-muted">No application yet.</div>;
  return (
    <div className="c360-feedback">
      {internal && <AiInterviewSection app={app} history={history} bare />}
      <ClientFeedbackSection app={app} feedbacks={feedbacks} internal={internal} bare />
    </div>
  );
}

// --- TL Return → --------------------------------------------------------------
export function ReturnDialog({
  applicationId, candidateName, onClose, onDone,
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/candidates/applications/${applicationId}/return`, { reason });
      if (onDone) await onDone();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'The candidate could not be returned.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Return to recruiter — ${candidateName || 'candidate'}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="c360ReturnForm" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>Return →</button>
        </>
      )}
    >
      <form id="c360ReturnForm" onSubmit={submit}>
        <label className="field">
          <span>Why is this candidate going back? *</span>
          <textarea autoFocus rows="3" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. CTC details missing, re-check notice period" />
        </label>
        <div className="small-muted">The candidate goes back to Recruiter Review. The reason is recorded in the pipeline history and the audit trail, and the recruiter is notified.</div>
        {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// ACTIONS — [next action] [Move Stage] [Schedule Interview] [⋯], only what this
// login may do. Stage ownership comes from the server (user.workflow); the
// API re-checks every move.
// ---------------------------------------------------------------------------
const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const INTERVIEW_WINDOW = ['bde_review', 'client_submission', 'client_decision', 'interview', 'feedback'];

export function CandidateActions({
  c, app, user, onChanged, onFlash, compact,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decision, setDecision] = useState(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [contact, setContact] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [returning, setReturning] = useState(false);
  const moreRef = useRef(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const close = (e) => { if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreOpen]);

  const internal = !!(c && c.viewer && c.viewer.internal);
  if (!internal) return null;
  const stage = app ? app.stage : null;
  const next = stage ? nextActionsFor(user, stage, app) : [];
  const mayHold = !!stage && !['HOLD', ...CLOSED].includes(stage) && canMoveToStage(user, 'HOLD');
  const mayReject = !!stage && stage !== 'REJECTED' && canMoveToStage(user, 'REJECTED');
  const otherStages = stage
    ? workflowStages(user).filter((s) => s !== stage && !['HOLD', 'REJECTED'].includes(s) && !next.some((f) => f.to === s))
    : [];
  const editMaster = can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  // An interview is scheduled from BDE / Client Review, or for a further round
  // after one completed — not for somebody already at Offer or Joining.
  const step = PIPELINE_STEPS[stepIndexOf(stage)];
  const mayInterview = !!stage && !!step && INTERVIEW_WINDOW.includes(step.id) && stage !== 'INTERVIEW_SCHEDULED'
    && !isInternalApp(app) && maySchedule(user) && !next.some((f) => f.kind === 'schedule');
  const any = next.length || mayHold || mayReject || otherStages.length || editMaster || mayInterview;
  if (!any) return null;

  async function move(toStage, extra = {}) {
    if (!app) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/applications/${app.id}/stage`, { stage: toStage, ...extra });
      setDecision(null);
      setMoveTo('');
      setMoveOpen(false);
      if (onFlash) onFlash(`Moved to ${stageLabelFor(toStage, { internal: isInternalApp(app) })}.`);
      if (onChanged) await onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'That move was refused.');
    } finally {
      setBusy(false);
    }
  }
  // Send to ATS / Create HRMS Employee go through their own endpoints
  // (routes/jobPortal.js, routes/interviewsJoining.js), not a stage PATCH.
  async function post(url, said) {
    setBusy(true);
    setError('');
    try {
      const r = await api.post(url);
      if (onFlash) onFlash(said(r));
      if (onChanged) await onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'That action was refused.');
    } finally {
      setBusy(false);
    }
  }
  function runNext(a) {
    if (a.kind === 'move') move(a.to);
    else if (a.kind === 'return') setReturning(true);
    else if (a.kind === 'schedule') setSchedule(true);
    else if (a.kind === 'send_to_ats') post(`/job-portal/applications/${app.id}/send-to-ats`, (r) => `Sent to the ATS — now at ${r.data.stageLabel}.`);
    else if (a.kind === 'hrms') post(`/ats/internal-hiring/${app.id}/create-employee`, (r) => r.data.message || 'HRMS employee created.');
    else if (a.kind === 'screening') window.location.assign('/requirements/job-portal?view=apps');
  }

  async function saveNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/candidates/${c.id}/notes`, { body: note, applicationId: app ? app.id : undefined });
      setNote('');
      setNoteOpen(false);
      if (onFlash) onFlash('Note saved.');
      if (onChanged) await onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'The note could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  const clientName = app ? (app.requirement?.internal ? 'TeamLink Internal' : app.requirement?.client?.name) : null;
  const secondary = [
    editMaster && ['note', '📝 Add Note', () => setNoteOpen((x) => !x)],
    editMaster && ['contact', '📞 Follow Up', () => setContact(true)],
    app && mayHold && ['hold', 'Put on Hold', () => setDecision({ stage: 'HOLD', reasonCategory: '', reasonDetail: '' })],
    app && mayReject && ['reject', 'Reject', () => setDecision({ stage: 'REJECTED', rejectedBy: '', reasonCategory: '', reasonDetail: '' })],
  ].filter(Boolean);
  return (
    <section className={`c360-actions${compact ? ' is-compact' : ''}`}>
      <div className="cdw-label">Actions</div>
      <div className="cdw-actions">
        {app && next.map((a, i) => (
          <button
            key={a.id}
            type="button"
            className={`btn btn-sm${i === 0 ? ' btn-primary' : ''}`}
            disabled={busy}
            onClick={() => runNext(a)}
          >
            {`${a.label} →`}
          </button>
        ))}
        {app && otherStages.length > 0 && (
          <button type="button" className={`btn btn-sm${moveOpen ? ' is-on' : ''}`} disabled={busy} aria-expanded={moveOpen} onClick={() => setMoveOpen((x) => !x)}>
            Move Stage ▾
          </button>
        )}
        {app && mayInterview && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setSchedule(true)}>📅 Schedule Interview</button>
        )}
        {secondary.length > 0 && (
          <span className="c360-more" ref={moreRef}>
            <button type="button" className="btn btn-sm" aria-label="More actions" aria-expanded={moreOpen} onClick={() => setMoreOpen((x) => !x)}>⋯</button>
            {moreOpen && (
              <span className="c360-more-pop" role="menu">
                {secondary.map(([id, label, fn]) => (
                  <button key={id} type="button" role="menuitem" className={`c360-more-item${id === 'reject' ? ' is-danger' : ''}`} onClick={() => { setMoreOpen(false); fn(); }}>
                    {label}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </div>

      {moveOpen && app && otherStages.length > 0 && (
        <div className="cdw-moveto" style={{ marginTop: 6 }}>
          <Combo value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">Move to…</option>
            {otherStages.map((s) => <option key={s} value={s}>{stageLabelFor(s, { internal: isInternalApp(app) })}</option>)}
          </Combo>
          <button type="button" className="btn btn-sm btn-primary" disabled={!moveTo || busy} onClick={() => move(moveTo)}>Move</button>
        </div>
      )}

      {noteOpen && (
        <form onSubmit={saveNote} className="cdw-noteform">
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the next person…" />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !note.trim()}>Save</button>
        </form>
      )}

      {decision && (
        <div className="cdw-card cdw-decision" style={{ marginTop: 8 }}>
          <div className="cdw-label">{decision.stage === 'REJECTED' ? 'Reject — whose decision and why' : 'Put on hold — why'}</div>
          {decision.stage === 'REJECTED' && (
            <div className="contact-methods" style={{ marginBottom: 8 }}>
              {REJECTED_BY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  title={o.hint}
                  className={`contact-method${decision.rejectedBy === o.value ? ' is-on' : ''}`}
                  onClick={() => setDecision({ ...decision, rejectedBy: o.value, reasonCategory: '' })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <Combo
            creatable
            disabled={decision.stage === 'REJECTED' && !decision.rejectedBy}
            value={decision.reasonCategory}
            onChange={(e) => setDecision({ ...decision, reasonCategory: e.target.value })}
          >
            <option value="">{decision.stage === 'REJECTED' && !decision.rejectedBy ? 'Choose who rejected first' : 'Reason…'}</option>
            {(decision.stage === 'REJECTED'
              ? (REJECTION_REASONS_BY_SIDE[decision.rejectedBy] || REJECTION_REASON_CATEGORIES)
              : HOLD_REASON_CATEGORIES).map((x) => <option key={x} value={x}>{x}</option>)}
          </Combo>
          <textarea
            rows="2"
            style={{ marginTop: 6, width: '100%' }}
            placeholder="Detailed reason (optional)"
            value={decision.reasonDetail}
            onChange={(e) => setDecision({ ...decision, reasonDetail: e.target.value })}
          />
          <div className="cdw-row" style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => setDecision(null)}>Cancel</button>
            <button
              type="button"
              className={`btn btn-sm ${decision.stage === 'REJECTED' ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy || !decision.reasonCategory || (decision.stage === 'REJECTED' && !decision.rejectedBy)}
              onClick={() => move(decision.stage, {
                rejectedBy: decision.stage === 'REJECTED' ? decision.rejectedBy : undefined,
                reasonCategory: decision.reasonCategory,
                reasonDetail: decision.reasonDetail,
              })}
            >
              {decision.stage === 'REJECTED' ? 'Record rejection' : 'Record hold'}
            </button>
          </div>
          {decision.stage === 'REJECTED' && <div className="small-muted" style={{ marginTop: 4 }}>The candidate stays in the Candidate Master — nothing is deleted.</div>}
        </div>
      )}
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}

      {returning && app && (
        <ReturnDialog
          applicationId={app.id}
          candidateName={c.name}
          onClose={() => setReturning(false)}
          onDone={async () => { if (onFlash) onFlash('Returned to the recruiter (Recruiter Review).'); if (onChanged) await onChanged(); }}
        />
      )}
      {schedule && app && (
        <CandidateBulkActions
          kind="interview"
          items={[{ id: c.id, latestApplicationId: app.id, name: c.name }]}
          user={user}
          onClose={() => setSchedule(false)}
          onDone={() => { if (onFlash) onFlash('Interview scheduled.'); if (onChanged) onChanged(); }}
        />
      )}
      {contact && (
        <ContactPanel
          candidateId={c.id}
          name={c.name}
          phone={c.phone}
          email={c.email}
          role={app?.requirement?.title}
          client={clientName}
          applicationId={app?.id}
          onClose={() => { setContact(false); if (onChanged) onChanged(); }}
          onContacted={() => { setContact(false); if (onChanged) onChanged(); }}
        />
      )}
    </section>
  );
}

// "Current application" facts, shared by both views.
export function CurrentApplication({
  app, ownership, clientName, linkTo,
}) {
  if (!app) return <div className="small-muted">No application yet — this candidate is in the Candidate Master only.</div>;
  const fu = app.followUp;
  return (
    <>
      <div className="cdw-kv"><span>Requirement</span>{linkTo ? linkTo(app) : <b>{app.requirement?.title || '—'}</b>}</div>
      <div className="cdw-kv"><span>Client</span><b>{clientName || '—'}</b></div>
      <div className="cdw-kv"><span>Applied</span><b>{dt(app.createdAt)}</b></div>
      <div className="cdw-kv"><span>In this stage since</span><b>{dt(app.stageSince)}</b></div>
      <div className="cdw-kv"><span>Whose move</span><b>{(fu && !fu.completedAt && fu.ownerName) || app.owner || '—'}</b></div>
      {ownership && <OwnershipGrid o={ownership} compact />}
      {app.interviewStatus && (
        <div className="cdw-kv"><span>Interview</span><b>{`${app.interviewStatusLabel || interviewStatusLabel(app.interviewStatus)}${app.interviewAt ? ` · ${dt(app.interviewAt)}` : ''}`}</b></div>
      )}
    </>
  );
}
