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
import { OwnershipPanel, TrailButton } from '../ats/AtsWork.jsx'; // who owns the candidate, dispute / claim, the workflow trail (round 3)
import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { JobPickerCombo, jobLabel } from '../JobPicker.jsx';
import ResumePanel from '../resume/ResumePanel.jsx';
import { EligibleRequirementsPanel, AlsoGoodFitCard } from '../resume/MatchSplit.jsx';
import RejectionHistory from '../rejections/RejectionHistory.jsx';
import FollowUpTimeline from '../followups/FollowUpTimeline.jsx';
import QuickContact from '../followups/QuickContact.jsx';
import SpecialisationLine from './SpecialisationLine.jsx';
import CandidateAutoMessages from '../automsg/CandidateAutoMessages.jsx'; // automatic stage messages for this person
import { ResumeCard, AiScoresTab, ActivityTab } from '../Candidate360Tabs.jsx';
import FitBreakdown from '../match/FitBreakdown.jsx'; // Fit = Resume · AI · Location · Salary
import AddApplicationCard from '../applications/AddApplicationCard.jsx'; // Add application: a job picker you can type into + the 'already on this job' notice
import { can } from '../../permissions';
import AiCallHistory from '../aicalling/AiCallHistory.jsx'; // Exotel AI Calling: this candidate's AI calls + the Call button

// --- Resume (resume/fit agent) -------------------------------------------------
export function ResumeSlot({ c }) {
  return (
    <>
      <ResumePanel candidateId={c.id} candidateName={c.name} candidatePhone={c.phone} candidateEmail={c.email} />
      <ResumeCard c={c} hideDocuments />
    </>
  );
}

// --- Add application (any TeamLink login that may add people to a job) ---------
export function AddApplicationSlot({ c, user, internal, onAddToJob }) {
  if (!internal || !onAddToJob || !user || !can(user, 'ats', 'candidates', 'Applications', 'create')) return null;
  return (
    <>
      <AddApplicationCard c={c} onAddToJob={onAddToJob} />
      <MoveApplicationCard c={c} />
      <OwnershipPanel candidateId={c.id} />
      <TrailCard c={c} />
    </>
  );
}

// --- Workflow trail per application (Audit 620): every event from the requirement request to the invoice, who and when ------------
function TrailCard({ c }) {
  const apps = c.applications || [];
  if (!apps.length) return null;
  return (
    <div className="c360t-card">
      <div className="c360t-label">Workflow trail</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {apps.slice(0, 6).map((a) => (
          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="small-muted">{(a.requirement && (a.requirement.reqCode || a.requirement.title)) || 'Requirement'} · {a.stageLabel || a.stage}</span>
            <TrailButton applicationId={a.id} label="Open trail" />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Move to another requirement (backend POST /applications/:id/move) ------------------------------------------------
// The old application is closed as "Moved to <job>" with the reason; the person is added to the new job (same rules as Add).
const PLACED = ['OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
function MoveApplicationCard({ c }) {
  const apps = (c.applications || []).filter((a) => !PLACED.includes(a.stage));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!apps.length) return null;
  const fromId = from || apps[0].id;
  return (
    <div className="c360t-card">
      <div className="c360t-label">Move to another requirement</div>
      <div className="small-muted" style={{ marginBottom: 6 }}>The current application is closed as &quot;Moved&quot; with your reason; the person is added to the new requirement. Both histories stay.</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {apps.length > 1 && (
          <select value={fromId} onChange={(e) => setFrom(e.target.value)}>
            {apps.map((a) => <option key={a.id} value={a.id}>{`From: ${(a.requirement && (a.requirement.reqCode || a.requirement.title)) || 'requirement'} (${a.stageLabel || a.stage})`}</option>)}
          </select>
        )}
        <JobPickerCombo value={to} onChange={(e) => { setTo(e.target.value); setMsg(null); }} blank="Move to: pick a requirement, or type a title, code or client" labelOf={(r) => `${r.reqCode ? `${r.reqCode} · ` : ''}${jobLabel(r)}`} />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. Fits the ICU opening better (salary, location)" />
        <div>
          <button type="button" className="btn" disabled={busy || !to || reason.trim().length < 5}
            onClick={async () => {
              setBusy(true); setMsg(null);
              try { const r = await api.post(`/applications/${fromId}/move`, { requirementId: to, reason }); setMsg({ ok: true, text: r.data.message }); setTimeout(() => window.location.reload(), 1200); } catch (e) { if (!e.alreadyApplied) setMsg({ ok: false, text: e.response?.data?.error || 'Could not move.' }); } finally { setBusy(false); }
            }}>{busy ? 'Moving…' : 'Move'}</button>
        </div>
        {msg && <div className={msg.ok ? 'notice green' : 'error-text'}>{msg.text}</div>}
      </div>
    </div>
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
        <div className="c360t-label">Requirements this person fits</div>
        {c.profileThin
          ? <div className="small-muted">Not enough details to score. Add skills, experience or a resume to see the requirements this person fits.</div>
          : <EligibleRequirementsPanel candidateId={c.id} onAdd={onAddToJob} />}
      </div>
    </>
  );
}

// The AI match against the current job (moved here from the full page so the
// drawer and the page show the same Fit tab).
function AiMatchDetail({ c }) {
  const m = c.aiMatch;
  if (!m) return null;
  // A thin profile (no skills, no experience, no resume) has nothing to score: say so, never "Good match".
  if (m.thin) {
    return (
      <div className="c360t-card">
        <div className="c360t-label">{`Fit for: ${m.requirementTitle || 'the current requirement'}`}</div>
        <div className="c360t-kv"><span>Fit</span><b>Not enough details to score</b></div>
        <div className="small-muted" style={{ marginTop: 6 }}>{m.recommendation}</div>
        <div className="small-muted" style={{ marginTop: 4 }}>The recruiter decides. Fit never moves a person by itself.</div>
      </div>
    );
  }
  const line = (label, part, extra) => (part ? (
    <div className="c360t-kv"><span>{label}</span><b>{part[extra ? 'relevantPercent' : 'percent'] == null ? `${part.word || 'Not known'}${part.reason && part.reason !== part.word ? ` — ${part.reason}` : ''}` : `${part[extra ? 'relevantPercent' : 'percent']}% — ${(extra ? part.relevantReason : part.reason) || '—'}`}</b></div>
  ) : null);
  return (
    <div className="c360t-card">
      <div className="c360t-label">{`Fit for: ${m.requirementTitle || 'the current requirement'} — ${m.approx ? 'about ' : ''}${m.overall}%`}</div>
      {m.breakdown && <div style={{ margin: '4px 0 8px' }}><FitBreakdown b={m.breakdown} showTotal={false} showFormula /></div>}
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

// --- AI Calling tab (2026-11-04): this candidate's AI calls + the Call button; the company-wide lists stay one click away ------
export function AiCallingSlot({ c, internal, refreshKey = 0 }) {
  if (!internal) return null;
  return (
    <>
      <AiCallHistory candidate={c} refreshKey={refreshKey} showDenied />
      <div className="small-muted" style={{ marginTop: 4 }}>
        Calling many candidates at once, the call-backs and the numbers: <Link to="/ats/ai-calling">all AI calls</Link>.
      </div>
    </>
  );
}

// --- History timeline (follow-ups agent) ---------------------------------------
export function HistoryTimelineSlot({
  c, internal, refreshKey = 0, withActivity = true,
}) {
  return (
    <>
      {internal && <CandidateAutoMessages candidateId={c.id} />}
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
