import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal, { SectionHead } from '../components/Modal.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import {
  STAGE_LABELS, LIFE_STATUSES, deptOptions, LOCS,
  CANDIDATE_SOURCES, CANDIDATE_FIRST_SOURCES, CANDIDATE_FILTER_SOURCES, APPLICATION_METHODS,
  CANDIDATE_GENDERS, CANDIDATE_NOTICE_PERIODS, CANDIDATE_AVAILABILITY, CANDIDATE_JOB_PREFERENCES,
  CANDIDATE_EMPLOYMENT_TYPES, CANDIDATE_WORK_MODES, CANDIDATE_EDUCATION,
  lifeStatusClass, protoDate, initials,
  FOLLOWUP_STATUSES, followUpStatusClass,
} from '../atsVocab';
import {
  STAGE_GROUPS, CANDIDATE_VIEWS, matchesView, groupContents, groupBadgeClass,
} from '../pipelineView';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import Combo from '../components/Combo.jsx';

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

// The consistent filter set: Department, Client, Requirement, Recruiter, TL,
// BDE, Location, Source, Stage, Status, Date Range.
const EMPTY_FILTERS = {
  search: '', department: '', clientId: '', requirementId: '', recruiter: '',
  tl: '', bde: '', location: '', source: '', stage: '', status: '',
  appliedFrom: '', appliedTo: '', followUp: '',
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
    stage: searchParams.get('stage') ? `stage:${searchParams.get('stage')}` : '',
    status: searchParams.get('status') || '',
    // The dashboard's "Follow-ups Due" / "Overdue Follow-ups" rows link here.
    followUp: searchParams.get('followUp') || '',
  });
  const [showForm, setShowForm] = useState(false);
  const [duplicate, setDuplicate] = useState('');
  const [error, setError] = useState('');
  // Hold and Rejected are VIEWS over one list, not separate modules. The six
  // views: All · Active · Hold · Rejected · Selected · Joined.
  const [view, setView] = useState(searchParams.get('view') || 'all');
  const [tab, setTab] = useState('pipeline');
  const [sources, setSources] = useState(null);

  // The sidebar's Hold / Rejected / Selected / Screening entries and the
  // dashboard's queue rows are all VIEWS of this one list, reached by query
  // string. React Router keeps this component mounted when only the query
  // changes, so the URL has to be re-read here — otherwise clicking one of
  // those entries would leave the previous filter in place.
  const qsStage = searchParams.get('stage') || '';
  const qsStatus = searchParams.get('status') || '';
  const qsView = searchParams.get('view') || '';
  const qsFollowUp = searchParams.get('followUp') || '';
  useEffect(() => {
    setFilters((f) => ({
      ...f,
      stage: qsStage ? `stage:${qsStage}` : '',
      status: qsStatus,
      followUp: qsFollowUp,
    }));
    if (qsView) setView(qsView);
  }, [qsStage, qsStatus, qsView, qsFollowUp]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

  function load() {
    api.get('/candidates').then((res) => setCandidates(res.data));
  }
  useEffect(() => {
    load();
    api.get('/requirements').then((res) => setRequirements(res.data)).catch(() => setRequirements([]));
    api.get('/ats/team').then((res) => setTeam(res.data)).catch(() => setTeam([]));
    // Source analytics is computed on the server, over the same scoped list,
    // so the numbers can never disagree with the table.
    api.get('/candidates/source-analytics').then((res) => setSources(res.data)).catch(() => setSources(null));
  }, []);

  const clientOptions = useMemo(() => {
    const seen = new Map();
    requirements.forEach((r) => { if (r.client) seen.set(r.client.id, r.client.name); });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [requirements]);

  // Requirement-derived filters match if ANY of the candidate's applications
  // match — the prototype's renderCandidateList().
  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return candidates.filter((c) => {
      if (q && !(`${c.name} ${c.skills || ''}`.toLowerCase().includes(q))) return false;
      if (filters.location && c.location !== filters.location) return false;
      if (filters.source && c.source !== filters.source) return false;
      if (filters.status && c.lifeStatus !== filters.status) return false;
      // Follow-up status. The value can be a comma list (the dashboard links
      // Due Today + Overdue as one row), and "Not set" is a real answer —
      // an application nobody has committed a follow-up on is exactly what a
      // lead is looking for.
      if (filters.followUp) {
        const wanted = filters.followUp.split(',').map((x) => x.trim()).filter(Boolean);
        if (!wanted.includes(c.followUp ? c.followUp.status : 'Not set')) return false;
      }
      // The Stage filter accepts either a whole visible stage ("group:interview")
      // or one precise underlying status ("stage:INTERVIEW_COMPLETED"), so
      // folding the pipeline never costs anyone the fine-grained filter.
      if (filters.stage.startsWith('group:') && c.stageGroup !== filters.stage.slice(6)) return false;
      // `stage:` may carry a comma-separated set, so one nav entry or one
      // dashboard queue row can open a view spanning several stages.
      if (filters.stage.startsWith('stage:')
        && !filters.stage.slice(6).split(',').includes(c.currentStage)) return false;

      const apps = c.applications || [];
      const any = (pred) => apps.length > 0 && apps.some(pred);
      if (filters.department && !any((a) => a.requirement?.department === filters.department)) return false;
      if (filters.clientId && !any((a) => a.requirement?.clientId === filters.clientId)) return false;
      if (filters.requirementId && !any((a) => a.requirementId === filters.requirementId)) return false;
      if (filters.recruiter && !any((a) => a.requirement?.recruiter?.name === filters.recruiter)) return false;
      if (filters.tl && !any((a) => a.requirement?.tl === filters.tl)) return false;
      if (filters.bde && !any((a) => a.requirement?.bde?.name === filters.bde)) return false;
      if (filters.appliedFrom && !any((a) => String(a.createdAt || '').slice(0, 10) >= filters.appliedFrom)) return false;
      if (filters.appliedTo && !any((a) => String(a.createdAt || '').slice(0, 10) <= filters.appliedTo)) return false;
      return true;
    });
  }, [candidates, filters]);

  // The view is applied last, so the counts on the view tabs reflect the
  // filters that are already on.
  const rows = useMemo(
    () => filtered.filter((c) => matchesView(view, c.currentStage)),
    [filtered, view],
  );

  const viewCounts = useMemo(() => {
    const out = {};
    CANDIDATE_VIEWS.forEach((v) => {
      out[v.id] = filtered.filter((c) => matchesView(v.id, c.currentStage)).length;
    });
    return out;
  }, [filtered]);

  // How many candidates sit at each of the ten VISIBLE stages.
  const groupCounts = useMemo(() => {
    const out = {};
    filtered.forEach((c) => {
      if (!c.stageGroup) return;
      out[c.stageGroup] = (out[c.stageGroup] || 0) + 1;
    });
    return out;
  }, [filtered]);

  async function checkDuplicate() {
    if (!form.email && !form.phone) return setDuplicate('');
    const res = await api.get('/candidates/check-duplicate', { params: { email: form.email, phone: form.phone } });
    return setDuplicate(
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
    return undefined;
  }

  const tlNames = [...new Set(requirements.map((r) => r.tl).filter(Boolean))];
  const activeGroup = filters.stage.startsWith('group:') ? filters.stage.slice(6) : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Candidates &amp; Pipeline</h1>
          <div className="page-sub"><ScopeLine user={user} count={candidates.length} noun="candidate" /></div>
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
              <Combo value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
                {CANDIDATE_GENDERS.map((g) => <option key={g}>{g}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Current Location</span>
              <Combo creatable value={form.location} onChange={(e) => set({ location: e.target.value })}>
                {LOCS.map((l) => <option key={l}>{l}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Preferred Location</span>
              <Combo creatable value={form.preferredLocation} onChange={(e) => set({ preferredLocation: e.target.value })}>
                <option value="">Same as current</option>
                {LOCS.map((l) => <option key={l}>{l}</option>)}
              </Combo>
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
              <Combo value={form.noticePeriod} onChange={(e) => set({ noticePeriod: e.target.value })}>
                {CANDIDATE_NOTICE_PERIODS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Availability</span>
              <Combo value={form.availability} onChange={(e) => set({ availability: e.target.value })}>
                {CANDIDATE_AVAILABILITY.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Job Preference</span>
              <Combo value={form.jobPreference} onChange={(e) => set({ jobPreference: e.target.value })}>
                {CANDIDATE_JOB_PREFERENCES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Employment Type</span>
              <Combo value={form.preferredEmploymentType} onChange={(e) => set({ preferredEmploymentType: e.target.value })}>
                {CANDIDATE_EMPLOYMENT_TYPES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Preferred Work Mode</span>
              <Combo value={form.preferredWorkMode} onChange={(e) => set({ preferredWorkMode: e.target.value })}>
                {CANDIDATE_WORK_MODES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
          </div>

          <SectionHead caps>C. Education</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Highest Qualification</span>
              <Combo value={form.education} onChange={(e) => set({ education: e.target.value })}>
                {CANDIDATE_EDUCATION.map((x) => <option key={x}>{x}</option>)}
              </Combo>
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
            candidate without one. A named resume also becomes the first row of the Documents tab.
          </div>

          <SectionHead caps>F. Source</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Source</span>
              <Combo creatable value={form.source} onChange={(e) => set({ source: e.target.value })}>
                {CANDIDATE_SOURCES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>First Source</span>
              <Combo creatable value={form.firstSource} onChange={(e) => set({ firstSource: e.target.value })}>
                <option value="">Same as source</option>
                {CANDIDATE_FIRST_SOURCES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Source Campaign</span>
              <input placeholder="e.g. Sep-2026 Java drive" value={form.sourceCampaign} onChange={(e) => set({ sourceCampaign: e.target.value })} />
            </label>
            <label className="field">
              <span>Application Method</span>
              <Combo value={form.applicationMethod} onChange={(e) => set({ applicationMethod: e.target.value })}>
                {APPLICATION_METHODS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
          </div>

          <SectionHead caps>G. Requirement</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Apply to Requirement</span>
              <Combo value={form.requirementId} onChange={(e) => set({ requirementId: e.target.value })}>
                <option value="">None — add to database only</option>
                {requirements.filter((r) => r.status !== 'CLOSED').map((r) => (
                  <option key={r.id} value={r.id}>{r.title} — {r.internal ? 'TeamLink Internal' : r.client?.name}</option>
                ))}
              </Combo>
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

      {/* --- The six views. Hold and Rejected are filters over this one list,
              not modules of their own: a held candidate has paused in the
              pipeline, they have not moved to a different process. --- */}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {CANDIDATE_VIEWS.map((v) => (
          <div
            key={v.id}
            className={`tab${view === v.id ? ' active' : ''}`}
            onClick={() => { setView(v.id); setTab('pipeline'); }}
          >
            {`${v.label} (${viewCounts[v.id] ?? 0})`}
          </div>
        ))}
        <div className={`tab${tab === 'sources' ? ' active' : ''}`} onClick={() => setTab('sources')}>
          Source Analytics
        </div>
      </div>

      {tab === 'pipeline' && (
        <>
          {/* --- The VISIBLE pipeline: ten stages, not twenty. Each one folds
                  its detailed statuses inside; the title attribute and the
                  legend below say exactly which. Click to filter. --- */}
          <div className="tbl-wrap" style={{ padding: '12px 14px', marginBottom: 12 }}>
            <div className="stage-track">
              {STAGE_GROUPS.map((g, i) => (
                <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {i > 0 && <span className="stage-connector" />}
                  <span
                    className={`stage${activeGroup === g.id ? ' current' : ''}${groupCounts[g.id] ? ' done' : ''}`}
                    style={{ cursor: 'pointer' }}
                    title={`${g.label} contains: ${groupContents(g).join(', ')}`}
                    onClick={() => setFilter({ stage: activeGroup === g.id ? '' : `group:${g.id}` })}
                  >
                    <span className="dot" />
                    {`${g.label} (${groupCounts[g.id] || 0})`}
                  </span>
                </span>
              ))}
            </div>
            {/* §3 — HOVER IS NOT ENOUGH. What sits inside each stage is
                printed, not hidden behind a tooltip: a tooltip is invisible on
                a touch screen and invisible to anybody who does not think to
                hover. The selected stage's contents read out in full; with
                nothing selected, every stage lists its own. */}
            <div className="stage-contents">
              {(activeGroup
                ? STAGE_GROUPS.filter((g) => g.id === activeGroup)
                : STAGE_GROUPS
              ).map((g) => (
                <span className="stage-contents-item" key={g.id}>
                  <b>{g.label}:</b> {groupContents(g).join(' · ')}
                </span>
              ))}
            </div>
          </div>

          <div className="filter-row">
            <input type="text" placeholder="Search name or skill…" value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} />
            <Combo value={filters.department} onChange={(e) => setFilter({ department: e.target.value })}>
              <option value="">All departments</option>
              {deptOptions(user).map((d) => <option key={d}>{d}</option>)}
            </Combo>
            <Combo value={filters.clientId} onChange={(e) => setFilter({ clientId: e.target.value })}>
              <option value="">All clients</option>
              {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Combo>
            <Combo value={filters.requirementId} onChange={(e) => setFilter({ requirementId: e.target.value })}>
              <option value="">All requirements</option>
              {requirements.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </Combo>
            <Combo value={filters.recruiter} onChange={(e) => setFilter({ recruiter: e.target.value })}>
              <option value="">All recruiters</option>
              {team.filter((t) => t.role === 'RECRUITER').map((t) => <option key={t.id}>{t.name}</option>)}
            </Combo>
            <Combo value={filters.tl} onChange={(e) => setFilter({ tl: e.target.value })}>
              <option value="">All TLs</option>
              {tlNames.map((t) => <option key={t}>{t}</option>)}
            </Combo>
            <Combo value={filters.bde} onChange={(e) => setFilter({ bde: e.target.value })}>
              <option value="">All BDEs</option>
              {team.filter((t) => t.role === 'BDE').map((t) => <option key={t.id}>{t.name}</option>)}
            </Combo>
            <Combo value={filters.location} onChange={(e) => setFilter({ location: e.target.value })}>
              <option value="">All locations</option>
              {LOCS.map((l) => <option key={l}>{l}</option>)}
            </Combo>
            <Combo value={filters.source} onChange={(e) => setFilter({ source: e.target.value })}>
              <option value="">All sources</option>
              {CANDIDATE_FILTER_SOURCES.map((s) => <option key={s}>{s}</option>)}
            </Combo>
            {/* Stage: the ten visible stages, each with its detailed statuses
                nested underneath, so the fold costs nobody a filter. */}
            <Combo value={filters.stage} onChange={(e) => setFilter({ stage: e.target.value })}>
              <option value="">All stages</option>
              {STAGE_GROUPS.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  <option value={`group:${g.id}`}>{`${g.label} — all`}</option>
                  {g.stages.map((s) => (
                    <option key={s} value={`stage:${s}`}>{`  ${STAGE_LABELS[s] || s}`}</option>
                  ))}
                </optgroup>
              ))}
              <optgroup label="Off-pipeline">
                <option value="stage:HOLD">Hold</option>
                <option value="stage:REJECTED">Rejected</option>
              </optgroup>
            </Combo>
            <Combo value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="">All statuses</option>
              {LIFE_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </Combo>
            <Combo value={filters.followUp} onChange={(e) => setFilter({ followUp: e.target.value })}>
              <option value="">All follow-ups</option>
              <option value="Due Today,Overdue">Due now (today + overdue)</option>
              {FOLLOWUP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="Not set">Not set</option>
            </Combo>
            <input type="date" title="Applied from" value={filters.appliedFrom} onChange={(e) => setFilter({ appliedFrom: e.target.value })} />
            <input type="date" title="Applied to" value={filters.appliedTo} onChange={(e) => setFilter({ appliedTo: e.target.value })} />
            <button className="btn btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
          </div>

          {/* Eight columns, and Owner is one of them. Match score, AI interview
              status, resume score and the rest moved to the detail page. */}
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Requirement</th><th>Client</th><th>Stage</th>
                  <th>Owner</th><th>Next Action</th><th>Due</th><th>Follow-up</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="row-link" onClick={() => navigate(`/candidates/${c.id}`)}>
                    <td><span className="avatarsm">{initials(c.name)}</span>{c.name}</td>
                    <td>{c.requirementTitle || <span className="small-muted">No application</span>}</td>
                    <td className="cell-muted">{c.clientName || '—'}</td>
                    <td>
                      {c.currentStage
                        ? (
                          <>
                            <span className={`status ${groupBadgeClass(c.currentStage, c.stageGroup)}`}>
                              {c.stageGroupLabel}
                            </span>
                            {/* §3 — Stage AND Status, both written out. The
                                badge is the stage; this is where inside it the
                                candidate actually sits. */}
                            {c.stageDetailLabel && c.stageDetailLabel !== c.stageGroupLabel && (
                              <div className="small-muted" style={{ marginTop: 3 }}>
                                Status: {c.stageDetailLabel}
                              </div>
                            )}
                          </>
                        )
                        : <span className="small-muted">No application</span>}
                    </td>
                    {/* §5 — the OWNER is always the person responsible for the
                        next action. Who we are waiting on outside TeamLink is
                        shown under it, not instead of it. */}
                    <td>
                      {c.owner || '—'}
                      {c.waitingOn && (
                        <div className="small-muted" style={{ fontSize: 11 }}>waiting on {c.waitingOn}</div>
                      )}
                    </td>
                    <td className="cell-muted">{c.nextAction || '—'}</td>
                    <td className="cell-muted">
                      {protoDate(c.dueDate)}
                      {c.overdue && <> <span className="status rejected">Overdue</span></>}
                    </td>
                    {/* FOLLOW-UP — the real record, not the stage SLA in the
                        Due column beside it. They are two different
                        questions: Due is when the pipeline says this stage
                        runs out, Follow-up is what a person committed to and
                        when. Blank until somebody records one; a client or
                        candidate login is served none of it. */}
                    <td className="cell-muted">
                      {c.followUp
                        ? (
                          <>
                            <span className={`status ${followUpStatusClass(c.followUp.status)}`}>
                              {c.followUp.status}
                            </span>
                            <div className="small-muted" style={{ marginTop: 3 }}>
                              {c.followUp.nextAction || '—'}
                            </div>
                            <div className="small-muted">
                              {`due ${protoDate(c.followUp.dueDate)}`}
                              {c.followUp.daysOverdue > 0 && ` · ${c.followUp.daysOverdue}d late`}
                            </div>
                          </>
                        )
                        : (
                          // §4 — NOT EVERY STAGE OWES A PHONE CALL. Saying
                          // "Not set" on all of them nags about stages that
                          // need nothing AND makes the ones that do look the
                          // same. followUpNeed comes from utils/atsVocab.js, so
                          // the screen and the automatic follow-ups agree.
                          <span className="small-muted">
                            {c.followUpNeed === 'required' && <b className="fu-needed">Needs a follow-up</b>}
                            {c.followUpNeed === 'optional' && 'Optional'}
                            {(!c.followUpNeed || c.followUpNeed === 'none') && 'Not required'}
                          </span>
                        )}
                    </td>
                    <td>
                      {c.lifeStatus
                        ? <span className={`status ${lifeStatusClass(c.lifeStatus)}`}>{c.lifeStatus}</span>
                        : <span className="cell-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>No candidates match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {view === 'rejected' && rows.length > 0 && (
            <div className="notice" style={{ marginTop: 14 }}>
              Rejected candidates stay in the Candidate Master and remain searchable and matchable for other
              requirements. Internal rejection reasoning is never shown to client users.
            </div>
          )}
        </>
      )}

      {tab === 'sources' && (
        <>
          <div className="section-label">Source performance</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th><th>Total</th><th>Screened</th><th>Shortlisted</th><th>Client Shared</th>
                  <th>Interviewed</th><th>Selected</th><th>Rejected</th><th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {(sources?.rows || []).map((s) => (
                  <tr
                    key={s.source}
                    className="row-link"
                    onClick={() => { setTab('pipeline'); setFilter({ source: s.source }); }}
                  >
                    <td><b>{s.source}</b></td>
                    <td>{s.total}</td>
                    <td className="cell-muted">{s.screened}</td>
                    <td className="cell-muted">{s.shortlisted}</td>
                    <td className="cell-muted">{s.clientShared}</td>
                    <td className="cell-muted">{s.interviewed}</td>
                    <td className="cell-muted">{s.selected}</td>
                    <td className="cell-muted">{s.rejected}</td>
                    <td className="cell-muted">{s.joined}</td>
                  </tr>
                ))}
                {(!sources || sources.rows.length === 0) && (
                  <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>No source data in your scope.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            {sources?.note || 'Counts are computed live from the candidate and application records.'}
          </div>
        </>
      )}
    </div>
  );
}
