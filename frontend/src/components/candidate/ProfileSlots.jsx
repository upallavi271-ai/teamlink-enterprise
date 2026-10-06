// ---------------------------------------------------------------------------
// CANDIDATE PROFILE — MOUNT POINTS for other agents (Candidates §7, 2026-10-03)
//
// The profile layout (header, tabs, Overview) belongs to the Candidates work:
// components/CandidateDrawer.jsx, pages/CandidateDetail.jsx and
// components/Candidate360Tabs.jsx. The CONTENT of these slots belongs to the
// agent named on each one. That agent may replace the body of its own export;
// the profile only calls it. Every slot gets the same props:
//
//   { c, app, user, internal, onChanged, onAddToJob, onSeeTab }
//     c          GET /candidates/:id (already scoped + redacted on the server)
//     app        the application the profile is showing (picked or latest)
//     internal   true for a TeamLink login
//     onChanged  re-read the profile (and the list behind it)
//     onAddToJob (requirementId) => Promise — add this person to a job
//     onSeeTab   (tabKey) => void — switch the profile to another tab
//
//   ResumeSlot            resume/fit agent    the whole Resume tab
//   FitSlot               resume/fit agent    the whole Fit tab
//   AlsoGoodFitSlot       resume/fit agent    "Also a good fit for …" on Overview
//   RejectionHistorySlot  rejections agent    on Overview (internal only)
//   SpecialisationSlot    specializations agent  Qualification · Specialization line on Overview (internal only)
//   HistoryTimelineSlot   follow-ups agent    top of the History tab
//   ContactButtons        follow-ups agent    the big Call / WhatsApp / Mail / SMS
//                                             buttons in the profile header
//   logContactClick       follow-ups agent    (kept as a no-op: QuickContact logs
//                                             its own clicks)
// ---------------------------------------------------------------------------
import ResumePanel from '../resume/ResumePanel.jsx';
import { EligibleRequirementsPanel, AlsoGoodFitCard } from '../resume/MatchSplit.jsx';
import RejectionHistory from '../rejections/RejectionHistory.jsx';
import FollowUpTimeline from '../followups/FollowUpTimeline.jsx';
import QuickContact from '../followups/QuickContact.jsx';
import SpecialisationLine from './SpecialisationLine.jsx';
import { ResumeCard, AiScoresTab, ActivityTab } from '../Candidate360Tabs.jsx';

// --- Resume (resume/fit agent) -------------------------------------------------
export function ResumeSlot({ c }) {
  return (
    <>
      <ResumePanel candidateId={c.id} candidateName={c.name} candidatePhone={c.phone} candidateEmail={c.email} />
      <ResumeCard c={c} hideDocuments />
    </>
  );
}

// --- Fit (resume/fit agent) ----------------------------------------------------
export function FitSlot({
  c, app, internal, onAddToJob,
}) {
  if (!internal) return <div className="small-muted">Fit is internal to TeamLink.</div>;
  return (
    <>
      <AiScoresTab c={c} app={app} internal={internal} />
      <AiMatchDetail c={c} />
      <div className="c360t-card">
        <div className="c360t-label">Jobs this person fits</div>
        <EligibleRequirementsPanel candidateId={c.id} onAdd={onAddToJob} />
      </div>
    </>
  );
}

// The AI match against the current job (moved here from the full page so the
// drawer and the page show the same Fit tab).
function AiMatchDetail({ c }) {
  const m = c.aiMatch;
  if (!m) return null;
  const line = (label, part, extra) => (part ? (
    <div className="c360t-kv"><span>{label}</span><b>{`${part[extra ? 'relevantPercent' : 'percent']}% — ${(extra ? part.relevantReason : part.reason) || '—'}`}</b></div>
  ) : null);
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`Fit for: ${m.requirementTitle || 'the current job'} — ${m.overall}%`}</div>
      {m.advisory && <div className="small-muted" style={{ marginBottom: 6 }}>{m.advisory}</div>}
      {line('Experience', m.experienceMatch)}
      {line('Relevant experience', m.experienceMatch, true)}
      {line('Education', m.educationMatch)}
      {line('Location', m.locationMatch)}
      {line('Salary', m.salaryMatch)}
      {line('Notice period', m.noticeMatch)}
      <div className="c360t-kv"><span>Matched skills</span><b>{(m.matchedSkills || []).join(', ') || 'None'}</b></div>
      <div className="c360t-kv"><span>Missing skills</span><b>{(m.missingSkills || []).join(', ') || 'None'}</b></div>
      {m.recommendation && <div className="small-muted" style={{ marginTop: 6 }}>{m.recommendation}</div>}
      {(m.gaps || []).length > 0 && <div className="small-muted">{`Gaps: ${m.gaps.join('; ')}`}</div>}
      <div className="small-muted" style={{ marginTop: 4 }}>The recruiter decides. Fit never moves a person by itself.</div>
    </div>
  );
}

// --- "Also a good fit for …" (resume/fit agent) --------------------------------
export function AlsoGoodFitSlot({
  c, internal, onSeeTab, onAddToJob,
}) {
  if (!internal) return null;
  // Same rule and scorer as the Fit tab (components/resume/MatchSplit.jsx).
  return <AlsoGoodFitCard candidateId={c.id} onSeeTab={onSeeTab} onAdd={onAddToJob} />;
}

// --- Rejection history (rejections agent) --------------------------------------
// --- Qualification · Specialization (specializations agent, spec D) -------------
export function SpecialisationSlot({ c, internal, onChanged }) {
  if (!internal) return null;
  return <SpecialisationLine candidateId={c.id} onChanged={onChanged} />;
}

export function RejectionHistorySlot({ c, internal, onChanged }) {
  if (!internal) return null;
  return <RejectionHistory candidateId={c.id} onChanged={onChanged} />;
}

// --- History timeline (follow-ups agent) ---------------------------------------
export function HistoryTimelineSlot({
  c, internal, refreshKey = 0, withActivity = true,
}) {
  return (
    <>
      {internal && <FollowUpTimeline candidateId={c.id} refreshKey={refreshKey} />}
      {withActivity && <ActivityTab c={c} internal={internal} limit={60} />}
    </>
  );
}

// --- Contact buttons (follow-ups agent) ----------------------------------------
// ONE set of buttons: the follow-ups agent's QuickContact (Call / Mail /
// WhatsApp / SMS-disabled, each click auto-logged).
export function ContactButtons({
  c, app, internal, onChanged,
}) {
  if (!internal) return null;
  const client = app && app.requirement ? (app.requirement.internal ? 'TeamLink (internal)' : (app.requirement.client && app.requirement.client.name) || '') : '';
  return (
    <QuickContact
      candidate={{
        id: c.id, name: c.name, phone: c.phone, email: c.email,
      }}
      applicationId={app ? app.id : null}
      role={app && app.requirement ? app.requirement.title : ''}
      client={client}
      onLogged={onChanged}
    />
  );
}

// eslint-disable-next-line no-unused-vars
export function logContactClick({ candidateId, applicationId, channel }) { /* QuickContact logs its own clicks */ }
