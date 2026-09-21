import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal, { SectionHead } from '../components/Modal.jsx';
import {
  ALL_STAGE_CODES, stageLabel, LIFE_STATUSES, DEPTS, LOCS,
  CANDIDATE_SOURCES, CANDIDATE_FIRST_SOURCES, CANDIDATE_FILTER_SOURCES, APPLICATION_METHODS,
  CANDIDATE_GENDERS, CANDIDATE_NOTICE_PERIODS, CANDIDATE_AVAILABILITY, CANDIDATE_JOB_PREFERENCES,
  CANDIDATE_EMPLOYMENT_TYPES, CANDIDATE_WORK_MODES, CANDIDATE_EDUCATION,
  stageBadgeClass, lifeStatusClass, aiStatusClass, protoDate, initials,
} from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';

// The prototype's Add Candidate modal (openAddCandidateModal, line 8150),
// section by section: A Personal, B Professional, C Education, D Skills,
// E Resume, F Source, G Requirement.
const EMPTY = {
  firstName: '', lastName: '', phone: '', email: '', dob: '', gender: '',
  location: LOCS[0], preferredLocation: '',
  currentCompany: '', currentDesignation: '', experienceYears: '', relevantExperienceYears: '',
  currentSalary: '', expectedSalary: '', noticePeriod: '30 Days',
  availability: 'Available after notice period', jobPreference: 'Permanent',
  preferredEmploymentType: 'Full Time', preferredWorkMode: 'Hybrid',
  education: 'B.Tech', specialization: '', institute: '', passingYear: '',
  skills: '', goodToHaveSkills: '', technicalSkills: '', softSkills: '',
  resumeName: '', source: 'Direct', firstSource: '', sourceCampaign: '',
  applicationMethod: 'Manual', requirementId: '',
};

const EMPTY_FILTERS = {
  search: '', department: '', clientId: '', requirementId: '', recruiter: '',
  tl: '', bde: '', location: '', source: '', stage: '', status: '', appliedOn: '',
};

export default function Candidates() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [candidates, setCandidates] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [team, setTeam] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [filters, setFilters] = useState({
    ...EMPTY_FILTERS,
    stage: searchParams.get('stage') || '',
    status: searchParams.get('status') || '',
  });
  const [showForm, setShowForm] = useState(false);
  const [duplicate, setDuplicate] = useState('');
  const [error, setError] = useState('');
  // The prototype's three tabs: Pipeline / Rejected (n) / Source Analytics.
  const [view, setView] = useState(searchParams.get('view') || 'pipeline');

  // The sidebar's Hold / Rejected / Selected / Screening entries are VIEWS of
  // this list, reached by query string. React Router keeps the component
  // mounted when only the query changes, so the URL has to be re-read here or
  // clicking one of those nav entries would leave the last filter in place.
  useEffect(() => {
    setFilters((f) => ({
      ...f,
      stage: searchParams.get('stage') || '',
      status: searchParams.get('status') || '',
    }));
    setView(searchParams.get('view') || 'pipeline');
  }, [searchParams]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

  function load() {
    api.get('/candidates').then((res) => setCandidates(res.data));
  }
  useEffect(() => {
    load();
    api.get('/requirements').then((res) => setRequirements(res.data)).catch(() => setRequirements([]));
    api.get('/ats/team').then((res) => setTeam(res.data)).catch(() => setTeam([]));
  }, []);

  const clientOptions = useMemo(() => {
    const seen = new Map();
    requirements.forEach((r) => { if (r.client) seen.set(r.client.id, r.client.name); });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [requirements]);

  // Requirement-derived filters match if ANY of the candidate's applications
  // match — the prototype's renderCandidateList().
  const rows = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return candidates.filter((c) => {
      if (q && !(`${c.name} ${c.skills || ''}`.toLowerCase().includes(q))) return false;
      if (filters.location && c.location !== filters.location) return false;
      if (filters.source && c.source !== filters.source) return false;
      // `stage` may be a comma-separated set, so one nav entry (or one
      // dashboard row) can open a queue that spans several stages.
      if (filters.stage && !filters.stage.split(',').includes(c.currentStage)) return false;
      if (filters.status && c.lifeStatus !== filters.status) return false;

      const apps = c.applications || [];
      const any = (pred) => apps.length > 0 && apps.some(pred);
      if (filters.department && !any((a) => a.requirement?.department === filters.department)) return false;
      if (filters.clientId && !any((a) => a.requirement?.clientId === filters.clientId)) return false;
      if (filters.requirementId && !any((a) => a.requirementId === filters.requirementId)) return false;
      if (filters.recruiter && !any((a) => a.requirement?.recruiter?.name === filters.recruiter)) return false;
      if (filters.tl && !any((a) => a.requirement?.tl === filters.tl)) return false;
      if (filters.bde && !any((a) => a.requirement?.bde?.name === filters.bde)) return false;
      if (filters.appliedOn && !any((a) => String(a.createdAt || '').slice(0, 10) === filters.appliedOn)) return false;
      return true;
    });
  }, [candidates, filters]);

  async function checkDuplicate() {
    if (!form.email && !form.phone) return setDuplicate('');
    const res = await api.get('/candidates/check-duplicate', { params: { email: form.email, phone: form.phone } });
    setDuplicate(
      res.data.duplicate
        ? `Already on file: ${res.data.matches.map((m) => m.name).join(', ')}. Save again to add anyway.`
        : ''
    );
  }

  async function createCandidate(e) {
    e.preventDefault();
    setError('');
    const body = {
      ...form,
      name: `${form.firstName} ${form.lastName}`.trim(),
      preferredLocation: form.preferredLocation || form.location,
      firstSource: form.firstSource || form.source,
      allowDuplicate: Boolean(duplicate),
    };
    try {
      await api.post('/candidates', body);
    } catch (err) {
      if (err.response?.status === 409) return setDuplicate(err.response.data.error);
      return setError(err.response?.data?.error || 'Could not save this candidate');
    }
    setForm(EMPTY);
    setDuplicate('');
    setShowForm(false);
    load();
  }

  const tlNames = [...new Set(requirements.map((r) => r.tl).filter(Boolean))];

  // Rejected view — the prototype's rejectedListHtml(). A rejection closes one
  // application; the Candidate Master record is never deleted.
  const rejectedRows = useMemo(() => {
    const out = [];
    candidates.forEach((c) => (c.applications || []).forEach((a) => {
      if (a.stage === 'REJECTED') out.push({ candidate: c, application: a });
    }));
    return out;
  }, [candidates]);

  // Source analytics — the prototype's sourceAnalyticsHtml(), computed live
  // from the candidate and application records.
  const sourceStats = useMemo(() => {
    const by = {};
    const bucket = (k) => {
      by[k] = by[k] || { first: 0, latest: 0, apps: 0, auto: 0, manual: 0 };
      return by[k];
    };
    let autoTotal = 0;
    candidates.forEach((c) => {
      const first = c.firstSource || c.source || 'Unknown';
      const latest = c.source || first;
      bucket(first).first += 1;
      bucket(latest).latest += 1;
      (c.applications || []).forEach((a) => {
        const src = a.source || c.source || 'Unknown';
        const b = bucket(src);
        b.apps += 1;
        if ((a.applicationMethod || 'Manual') === 'Auto-Apply') { b.auto += 1; autoTotal += 1; } else b.manual += 1;
      });
    });
    const totalApps = candidates.reduce((n, c) => n + (c.applications || []).length, 0);
    return {
      rows: Object.entries(by).sort((a, b) => b[1].latest - a[1].latest),
      autoTotal,
      manualTotal: totalApps - autoTotal,
    };
  }, [candidates]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Candidates &amp; Pipeline</h1>
          <div className="page-sub">{candidates.length} candidates in the database</div>
        </div>
        {can(user, 'ats', 'candidates', 'Add Candidate', 'create') && (
          <button className="btn btn-primary" onClick={() => { setError(''); setShowForm(true); }}>Add Candidate</button>
        )}
      </div>

      {showForm && (
        <Modal
          title="Add Candidate"
          size="xwide"
          onClose={() => setShowForm(false)}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn btn-primary" type="submit" form="addCandidateForm">Save Candidate</button>
            </>
          )}
        >
        <form id="addCandidateForm" onSubmit={createCandidate}>
          <SectionHead first caps>A. Personal</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>First Name *</span>
              <input required value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
            </label>
            <label className="field">
              <span>Last Name</span>
              <input value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
            </label>
            <label className="field">
              <span>Mobile *</span>
              <input required placeholder="10-digit mobile" value={form.phone} onBlur={checkDuplicate} onChange={(e) => set({ phone: e.target.value })} />
            </label>
            <label className="field">
              <span>Email *</span>
              <input required value={form.email} onBlur={checkDuplicate} onChange={(e) => set({ email: e.target.value })} />
            </label>
            <label className="field">
              <span>Date of Birth</span>
              <input type="date" value={form.dob} onChange={(e) => set({ dob: e.target.value })} />
            </label>
            <label className="field">
              <span>Gender</span>
              <select value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
                {CANDIDATE_GENDERS.map((g) => <option key={g}>{g}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Current Location</span>
              <select value={form.location} onChange={(e) => set({ location: e.target.value })}>
                {LOCS.map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Preferred Location</span>
              <select value={form.preferredLocation} onChange={(e) => set({ preferredLocation: e.target.value })}>
                <option value="">Same as current</option>
                {LOCS.map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
          </div>

          <SectionHead caps>B. Professional</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Current Company</span>
              <input value={form.currentCompany} onChange={(e) => set({ currentCompany: e.target.value })} />
            </label>
            <label className="field">
              <span>Current Designation</span>
              <input value={form.currentDesignation} onChange={(e) => set({ currentDesignation: e.target.value })} />
            </label>
            <label className="field">
              <span>Total Experience (yrs)</span>
              <input type="number" step="0.5" value={form.experienceYears} onChange={(e) => set({ experienceYears: e.target.value })} />
            </label>
            <label className="field">
              <span>Relevant Experience (yrs)</span>
              <input type="number" step="0.5" value={form.relevantExperienceYears} onChange={(e) => set({ relevantExperienceYears: e.target.value })} />
            </label>
            <label className="field">
              <span>Current Salary (₹L)</span>
              <input placeholder="e.g. 12L" value={form.currentSalary} onChange={(e) => set({ currentSalary: e.target.value })} />
            </label>
            <label className="field">
              <span>Expected Salary (₹L)</span>
              <input placeholder="e.g. 18L" value={form.expectedSalary} onChange={(e) => set({ expectedSalary: e.target.value })} />
            </label>
            <label className="field">
              <span>Notice Period</span>
              <select value={form.noticePeriod} onChange={(e) => set({ noticePeriod: e.target.value })}>
                {CANDIDATE_NOTICE_PERIODS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Availability</span>
              <select value={form.availability} onChange={(e) => set({ availability: e.target.value })}>
                {CANDIDATE_AVAILABILITY.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Job Preference</span>
              <select value={form.jobPreference} onChange={(e) => set({ jobPreference: e.target.value })}>
                {CANDIDATE_JOB_PREFERENCES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Employment Type</span>
              <select value={form.preferredEmploymentType} onChange={(e) => set({ preferredEmploymentType: e.target.value })}>
                {CANDIDATE_EMPLOYMENT_TYPES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Preferred Work Mode</span>
              <select value={form.preferredWorkMode} onChange={(e) => set({ preferredWorkMode: e.target.value })}>
                {CANDIDATE_WORK_MODES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          </div>

          <SectionHead caps>C. Education</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Highest Qualification</span>
              <select value={form.education} onChange={(e) => set({ education: e.target.value })}>
                {CANDIDATE_EDUCATION.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Specialization</span>
              <input placeholder="e.g. Computer Science" value={form.specialization} onChange={(e) => set({ specialization: e.target.value })} />
            </label>
            <label className="field">
              <span>Institute</span>
              <input value={form.institute} onChange={(e) => set({ institute: e.target.value })} />
            </label>
            <label className="field">
              <span>Passing Year</span>
              <input type="number" placeholder="2019" value={form.passingYear} onChange={(e) => set({ passingYear: e.target.value })} />
            </label>
          </div>

          <SectionHead caps>D. Skills</SectionHead>
          <label className="field">
            <span>Mandatory Skills * (comma separated)</span>
            <input required placeholder="Java, Spring Boot, SQL" value={form.skills} onChange={(e) => set({ skills: e.target.value })} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Good-to-have Skills</span>
              <input placeholder="AWS, Docker" value={form.goodToHaveSkills} onChange={(e) => set({ goodToHaveSkills: e.target.value })} />
            </label>
            <label className="field">
              <span>Technical Skills</span>
              <input placeholder="Git, Jenkins" value={form.technicalSkills} onChange={(e) => set({ technicalSkills: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Soft Skills</span>
            <input placeholder="Communication, Stakeholder management" value={form.softSkills} onChange={(e) => set({ softSkills: e.target.value })} />
          </label>

          <SectionHead caps>E. Resume</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Upload Resume</span>
              <input
                type="file"
                onChange={(e) => set({ resumeName: e.target.files?.[0]?.name || '' })}
              />
            </label>
            <label className="field">
              <span>Resume Name</span>
              <input readOnly placeholder="No file chosen" value={form.resumeName} />
            </label>
          </div>
          <div className="cell-muted" style={{ fontSize: 12 }}>
            Resume Score and AI-parsed fields appear only after a resume is attached — no score is shown for a
            candidate without one.
          </div>

          <SectionHead caps>F. Source</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Source</span>
              <select value={form.source} onChange={(e) => set({ source: e.target.value })}>
                {CANDIDATE_SOURCES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>First Source</span>
              <select value={form.firstSource} onChange={(e) => set({ firstSource: e.target.value })}>
                <option value="">Same as source</option>
                {CANDIDATE_FIRST_SOURCES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Source Campaign</span>
              <input placeholder="e.g. Sep-2026 Java drive" value={form.sourceCampaign} onChange={(e) => set({ sourceCampaign: e.target.value })} />
            </label>
            <label className="field">
              <span>Application Method</span>
              <select value={form.applicationMethod} onChange={(e) => set({ applicationMethod: e.target.value })}>
                {APPLICATION_METHODS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          </div>

          <SectionHead caps>G. Requirement</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Apply to Requirement</span>
              <select value={form.requirementId} onChange={(e) => set({ requirementId: e.target.value })}>
                <option value="">None — add to database only</option>
                {requirements.filter((r) => r.status !== 'CLOSED').map((r) => (
                  <option key={r.id} value={r.id}>{r.title} — {r.internal ? 'TeamLink Internal' : r.client?.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Requirement ID / Client</span>
              <input
                readOnly
                placeholder="—"
                value={(() => {
                  const r = requirements.find((x) => x.id === form.requirementId);
                  return r ? `${r.title} · ${r.internal ? 'TeamLink Internal' : r.client?.name || '—'}` : '';
                })()}
              />
            </label>
          </div>
          <div className="cell-muted" style={{ fontSize: 12 }}>
            AI Match Score is calculated against the selected requirement once mandatory skills and experience
            are filled in. AI Interview status starts as <b>Required</b>.
          </div>

          {/* The prototype writes its duplicate warning into an element its own
              modal never renders, and its Save path bypasses the check entirely.
              Here the warning is shown where it is raised, and the API blocks
              the save until it is acknowledged. */}
          {duplicate && <div className="notice amber" style={{ marginTop: 12 }}>{duplicate}</div>}
          {error && <div className="error-text">{error}</div>}
        </form>
        </Modal>
      )}

      <div className="filter-row">
        <input type="text" placeholder="Search name or skill…" value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} />
        <select value={filters.department} onChange={(e) => setFilter({ department: e.target.value })}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={filters.clientId} onChange={(e) => setFilter({ clientId: e.target.value })}>
          <option value="">All clients</option>
          {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={filters.requirementId} onChange={(e) => setFilter({ requirementId: e.target.value })}>
          <option value="">All requirements</option>
          {requirements.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <select value={filters.recruiter} onChange={(e) => setFilter({ recruiter: e.target.value })}>
          <option value="">All recruiters</option>
          {team.filter((t) => t.role === 'RECRUITER').map((t) => <option key={t.id}>{t.name}</option>)}
        </select>
        <select value={filters.tl} onChange={(e) => setFilter({ tl: e.target.value })}>
          <option value="">All TLs</option>
          {tlNames.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={filters.bde} onChange={(e) => setFilter({ bde: e.target.value })}>
          <option value="">All BDEs</option>
          {team.filter((t) => t.role === 'BDE').map((t) => <option key={t.id}>{t.name}</option>)}
        </select>
        <select value={filters.location} onChange={(e) => setFilter({ location: e.target.value })}>
          <option value="">All locations</option>
          {LOCS.map((l) => <option key={l}>{l}</option>)}
        </select>
        <select value={filters.source} onChange={(e) => setFilter({ source: e.target.value })}>
          <option value="">All sources</option>
          {CANDIDATE_FILTER_SOURCES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={filters.stage} onChange={(e) => setFilter({ stage: e.target.value })}>
          <option value="">All stages</option>
          {/* A nav entry or a dashboard row can open several stages at once;
              name that set so the filter row still reads true. */}
          {filters.stage.includes(',') && (
            <option value={filters.stage}>{filters.stage.split(',').map(stageLabel).join(' / ')}</option>
          )}
          {ALL_STAGE_CODES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
          <option value="">All statuses</option>
          {LIFE_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input type="date" title="Applied on" value={filters.appliedOn} onChange={(e) => setFilter({ appliedOn: e.target.value })} />
        <button className="btn btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
      </div>

      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'pipeline' ? ' active' : ''}`} onClick={() => setView('pipeline')}>Pipeline</div>
        <div className={`tab${view === 'rejected' ? ' active' : ''}`} onClick={() => setView('rejected')}>
          {`Rejected (${rejectedRows.length})`}
        </div>
        <div className={`tab${view === 'sources' ? ' active' : ''}`} onClick={() => setView('sources')}>Source Analytics</div>
      </div>

      {view === 'pipeline' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th><th>ID</th><th>Current Stage</th><th>Owner</th><th>Next Action</th>
                <th>Due Date</th><th>Match Score</th><th>Status</th><th>AI Interview</th><th>Follow-up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="row-link" onClick={() => navigate(`/candidates/${c.id}`)}>
                  <td><span className="avatarsm">{initials(c.name)}</span>{c.name}</td>
                  <td>{c.id}</td>
                  <td>
                    {c.currentStage
                      ? <span className={`status ${stageBadgeClass(c.currentStage)}`}>{c.currentStageLabel}</span>
                      : <span className="small-muted">No application</span>}
                  </td>
                  <td className="cell-muted">{c.owner || '—'}</td>
                  <td className="cell-muted">{c.nextAction || '—'}</td>
                  <td className="cell-muted">
                    {protoDate(c.dueDate)}
                    {c.overdue && <> <span className="status rejected">Overdue</span></>}
                  </td>
                  <td>{c.matchScore != null ? `${c.matchScore}%` : '—'}</td>
                  <td>
                    {c.lifeStatus
                      ? <span className={`status ${lifeStatusClass(c.lifeStatus)}`}>{c.lifeStatus}</span>
                      : <span className="cell-muted">—</span>}
                  </td>
                  <td>
                    {c.currentStage
                      ? <span className={`status ${aiStatusClass(c.aiInterviewStatus)}`}>{c.aiInterviewStatus}</span>
                      : <span className="cell-muted">—</span>}
                  </td>
                  {/* Follow-up logging is not implemented yet — the column is the
                      prototype's, the action behind it is still to come. */}
                  <td className="cell-muted">—</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan="10" className="small-muted" style={{ padding: 16 }}>No candidates match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'rejected' && (
        <>
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Rejected candidates stay in the Candidate Master and remain searchable and matchable for other
            requirements. Internal rejection reasoning is never shown to client users.
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Candidate ID</th><th>Requirement</th><th>Client</th><th>Previous Stage</th>
                  <th>Rejected By</th><th>Rejected Side</th><th>Reason</th><th>Detailed Reason</th>
                  <th>Rejected Date</th><th>Recruiter</th><th>BDE</th><th>TL</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rejectedRows.map(({ candidate: c, application: a }) => (
                  <tr key={a.id}>
                    <td>{c.name}</td>
                    <td className="cell-muted">{c.id}</td>
                    <td>{a.requirement?.title || '—'}</td>
                    <td className="cell-muted">{a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'}</td>
                    <td className="cell-muted">—</td>
                    <td className="cell-muted">—</td>
                    <td className="cell-muted">—</td>
                    <td className="cell-muted">—</td>
                    <td>—</td>
                    <td className="cell-muted">{protoDate(a.updatedAt)}</td>
                    <td className="cell-muted">{a.requirement?.recruiter?.name || '—'}</td>
                    <td className="cell-muted">{a.requirement?.bde?.name || '—'}</td>
                    <td className="cell-muted">{a.requirement?.tl || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn btn-sm" to={`/candidates/${c.id}`}>View Profile</Link>
                    </td>
                  </tr>
                ))}
                {rejectedRows.length === 0 && (
                  <tr><td colSpan="14" className="small-muted" style={{ padding: 16 }}>No rejected candidates in your scope.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'sources' && (
        <>
          <div className="section-label">Auto-apply</div>
          <div className="cell-muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {'Total auto-apply: '}<b>{sourceStats.autoTotal}</b>
            {' · Manual applications: '}<b>{sourceStats.manualTotal}</b>
          </div>
          <div className="section-label">Source-wise candidates</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th><th>Candidates (latest source)</th><th>Candidates (first source)</th>
                  <th>Applications</th><th>Auto-apply</th><th>Manual</th>
                </tr>
              </thead>
              <tbody>
                {sourceStats.rows.map(([name, s]) => (
                  <tr
                    key={name}
                    className="row-link"
                    onClick={() => { setView('pipeline'); setFilter({ source: name }); }}
                  >
                    <td><b>{name}</b></td>
                    <td>{s.latest}</td>
                    <td className="cell-muted">{s.first}</td>
                    <td className="cell-muted">{s.apps}</td>
                    <td className="cell-muted">{s.auto}</td>
                    <td className="cell-muted">{s.manual}</td>
                  </tr>
                ))}
                {sourceStats.rows.length === 0 && (
                  <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>No source data yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            Counts are computed live from the candidate and application records — a candidate arriving from a
            second source updates their latest source, it never creates a duplicate master record.
          </div>
        </>
      )}
    </div>
  );
}
