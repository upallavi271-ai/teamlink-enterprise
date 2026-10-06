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
import { protoDate } from '../../atsVocab';
import ResumePanel from '../resume/ResumePanel.jsx';
import { SpecialisationSlot } from './ProfileSlots.jsx';
import { ProfileTools } from './ProfileTop.jsx';
import './ProfileLeft.css';
// ATS-100 B5/B6: Consent + Where they came from (referred by, campus, campaign).
import { RecordCards } from './CandidateRecord.jsx';

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function Row({ k, v }) {
  return (
    <div className="pfl-kv">
      <span>{k}</span>
      <b>{v === null || v === undefined || v === '' ? '—' : v}</b>
    </div>
  );
}

export default function ProfileLeft({
  c, user, internal, onChanged, onDeleted, slot,
}) {
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
        <Row k="Current job" v={[c.currentDesignation, c.currentCompany].filter(Boolean).join(' · ')} />
        <Row k="Education" v={[c.education, c.specialization, c.institute].filter(Boolean).join(' · ')} />
        <Row k="Source" v={[c.source, c.firstSource && c.firstSource !== c.source ? `first: ${c.firstSource}` : ''].filter(Boolean).join(' · ')} />
        <Row k="Added" v={protoDate(c.createdAt)} />
      </section>

      <section className="pfl-card">
        <div className="pfl-label">Work facts</div>
        <Row k="Experience" v={c.experienceYears != null ? `${c.experienceYears} yrs${c.relevantExperienceYears != null ? ` (${c.relevantExperienceYears} relevant)` : ''}` : ''} />
        {salaryShown && <Row k="Current CTC" v={c.currentSalary} />}
        {salaryShown && <Row k="Expected CTC" v={c.expectedSalary} />}
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

      <section className="pfl-card pfl-resume">
        <div className="pfl-label">Resume</div>
        <ResumePanel candidateId={c.id} candidateName={c.name} candidatePhone={c.phone} candidateEmail={c.email} />
      </section>

      {internal && <ProfileTools c={c} user={user} onChanged={onChanged} onDeleted={onDeleted} />}
    </div>
  );
}
