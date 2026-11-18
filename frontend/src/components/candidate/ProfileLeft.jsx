// ---------------------------------------------------------------------------
// CANDIDATE PROFILE — LEFT SIDE (ATS layout v3, 2026-10-03)
//
//   personal info · skills · CTC · notice period · the rest of the profile
//   facts · Qualification / Specialization line · the resume viewer
//   (resume/fit agent's ResumePanel) · Archive / Delete tools (internal).
//
// The right side holds the tabs: Applications · Notes · Documents · Timeline.
// Used by the big window (CandidateDrawer.jsx) and the full page
// (pages/CandidateDetail.jsx). Data: GET /candidates/:id (scoped + redacted on
// the server — salary is never sent to a client login).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { protoDate } from '../../atsVocab';
import { mayEditProfile } from './EditCandidateProfile.jsx'; // editing a profile = Recruiter / Super Admin (2026-10-29)
import { AddSalaryDialog } from '../SalaryFit.jsx'; // add / correct the salary (cleaned and checked on the server)
import ResumePanel from '../resume/ResumePanel.jsx';
import { SpecialisationSlot } from './ProfileSlots.jsx';
import { ProfileTools } from './ProfileTop.jsx';
import './ProfileLeft.css';
// ATS-100 B5/B6: Consent + Where they came from (referred by, campus, campaign).
import { RecordCards } from './CandidateRecord.jsx';
import ReachPriorityCard from './ReachPriorityCard.jsx'; // AI call / WhatsApp / SMS ranked by how the person answers (2026-11-04)

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function Row({ k, v }) {
  return (
    <div className="pfl-kv">
      <span>{k}</span>
      <b>{v === null || v === undefined || v === '' ? '—' : v}</b>
    </div>
  );
}

// The Resume card (user, 2026-10-09): it used to sit on the left of the page; it is
// now the body of the "Resume" tab (C360_TABS in Candidate360Tabs.jsx). The card
// itself — ResumePanel and its wrapper — is exactly what it was.
export function ResumeTabCard({ c }) {
  if (!c) return null;
  return (
    <section className="pfl-card pfl-resume">
      <div className="pfl-label">Resume</div>
      <ResumePanel candidateId={c.id} candidateName={c.name} candidatePhone={c.phone} candidateEmail={c.email} />
    </section>
  );
}

export default function ProfileLeft({
  c, user, internal, onChanged, onDeleted, slot,
}) {
  const [editSalary, setEditSalary] = useState(false);
  if (!c) return null;
  const skills = list(c.skills);
  const more = [...list(c.goodToHaveSkills), ...list(c.technicalSkills)].filter((s) => !skills.includes(s));
  const salaryShown = c.currentSalary !== undefined || c.expectedSalary !== undefined;
  return (
    <div className="pfl">
      <section className="pfl-card">
        <div className="pfl-label">Personal info</div>
        <Row k="Phone" v={c.phone} />
        <Row k="Email" v={c.email} />
        <Row k="Location" v={[c.location, c.preferredLocation && c.preferredLocation !== c.location ? `wants ${c.preferredLocation}` : ''].filter(Boolean).join(' · ')} />
        {c.dob && <Row k="Date of birth" v={protoDate(c.dob)} />}
        {c.gender && <Row k="Gender" v={c.gender} />}
        {/* more of the candidate's own details (ATS audit 2026-11-18 batch 1) */}
        {c.alternatePhone && <Row k="Alternate phone" v={c.alternatePhone} />}
        {c.nativePlace && <Row k="Native place" v={c.nativePlace} />}
        {c.address && <Row k="Address" v={c.address} />}
        {c.maritalStatus && <Row k="Marital status" v={c.maritalStatus} />}
        {c.languagesKnown && <Row k="Languages" v={c.languagesKnown} />}
        <Row k="Current job" v={[c.currentDesignation, c.currentCompany].filter(Boolean).join(' · ')} />
        <Row k="Education" v={[c.education, c.specialization, c.institute].filter(Boolean).join(' · ')} />
        {c.superSpecialization && <Row k="Super-speciality" v={c.superSpecialization} />}
        {c.eligibilityTests && <Row k="Tests cleared" v={c.eligibilityTests} />}
        {c.machineryExperience && <Row k="Machinery" v={c.machineryExperience} />}
        {/* PROFESSIONAL REGISTRATION (ATS audit 2026-11-18): council, number, state, validity and whether TeamLink verified it */}
        {(c.registrationNumber || c.registrationCouncil) && (() => {
          const expired = c.registrationValidTill && c.registrationValidTill < new Date().toISOString().slice(0, 10);
          const status = expired ? 'Expired' : (c.registrationStatus || 'Not checked');
          const tone = status === 'Verified' ? 'var(--teal, #0f9d74)' : (status === 'Failed' || status === 'Expired') ? 'var(--red, #b42318)' : 'var(--amber, #b7791f)';
          return (
            <>
              <Row k="Registration" v={[c.registrationCouncil, c.registrationNumber, c.registrationState].filter(Boolean).join(' · ')} />
              <div className="pfl-row" style={{ display: 'flex', gap: 8, fontSize: 13, padding: '2px 0' }}>
                <span className="small-muted" style={{ minWidth: 96 }}>Verification</span>
                <span style={{ color: tone, fontWeight: 600 }}>{status}</span>
                <span className="small-muted">{[c.registrationValidTill ? `valid till ${c.registrationValidTill}` : '', c.registrationVerifiedBy ? `by ${c.registrationVerifiedBy}` : '', c.registrationVerifiedAt ? protoDate(c.registrationVerifiedAt) : ''].filter(Boolean).join(' · ')}</span>
              </div>
            </>
          );
        })()}
        <Row k="Where from" v={c.sourceKey || [c.source, c.firstSource && c.firstSource !== c.source ? `first: ${c.firstSource}` : ''].filter(Boolean).join(' · ')} />
        {c.sourceKey && c.sourceRaw && c.sourceRaw !== c.sourceKey && <Row k="Recorded as" v={c.sourceRaw} />}
        <Row k="Added" v={protoDate(c.createdAt)} />
      </section>

      {internal && <ReachPriorityCard candidateId={c.id} />}

      <section className="pfl-card">
        <div className="pfl-label">Work facts</div>
        <Row k="Experience" v={c.experienceYears != null ? `${c.experienceYears} yrs${c.relevantExperienceYears != null ? ` (${c.relevantExperienceYears} relevant)` : ''}` : ''} />
        {salaryShown && <Row k="Current CTC" v={c.currentSalary} />}
        {salaryShown && <Row k="Expected CTC" v={c.expectedSalary} />}
        {salaryShown && internal && mayEditProfile(user) && <button type="button" className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => setEditSalary(true)}>{c.salaryMissing ? '+ Add salary' : 'Edit salary'}</button>}
        {editSalary && <AddSalaryDialog candidateId={c.id} name={c.name} current={c.currentSalary || ''} expected={c.expectedSalary || ''} why="Write it as 4.5 LPA, or as an amount per month. It is saved as lakhs per year." onClose={() => setEditSalary(false)} onSaved={onChanged} />}
        <Row k="Notice period" v={c.noticePeriod} />
        {c.availability && <Row k="Availability" v={c.availability} />}
        <div className="pfl-label" style={{ marginTop: 10 }}>Skills</div>
        <div className="pfl-skills">
          {skills.length ? skills.map((s) => <span className="skillpill" key={s}>{s}</span>) : <span className="small-muted">No skills on file</span>}
          {more.slice(0, 10).map((s) => <span className="skillpill pfl-soft" key={`m-${s}`}>{s}</span>)}
        </div>
      </section>

      {internal && <RecordCards c={c} internal={internal} />}

      {slot && <SpecialisationSlot {...slot} />}

      {internal && <ProfileTools c={c} user={user} onChanged={onChanged} onDeleted={onDeleted} />}
    </div>
  );
}
