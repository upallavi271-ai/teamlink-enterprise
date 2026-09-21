import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Modal, { SectionHead } from '../components/Modal.jsx';
import {
  DEPTS, LOCS, PRIORITIES, REQUIREMENT_TYPES, EDUCATION_LEVELS, EMPLOYMENT_TYPES, WORK_MODES,
  JOINING_TIMELINES, NOTICE_PERIODS_MAX, JOB_PREFERENCES, SALARY_TYPES, CURRENCIES,
  POSTING_SOURCES, priorityBadgeClass,
  requirementStatusLabel, requirementBadgeClass, requirementIsLive, REQUIREMENT_STATUS_CODES,
  agreementStatusLabel, agreementIsActive,
} from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { canRaiseRequirement } from '../permissions';
import ClientModuleTabs from '../components/ClientModuleTabs.jsx';

// The prototype's Jobs / Requirements screen: requirementListShell() (6917),
// renderRequirementList() (6937), openRequirementsHtml() (6832),
// agreementMonthHtml() (6906) and the Create Requirement modal
// openAddRequirementModal() (6956) with its seven lettered sections.
const EMPTY = {
  type: 'Client Requirement',
  title: '',
  clientId: '',
  department: DEPTS[0],
  openings: 1,
  priority: 'Medium',
  closingDate: '',
  jobDescription: '',
  responsibilities: '',
  qualifications: '',
  education: 'Any Degree',
  skills: '',
  goodToHaveSkills: '',
  employmentType: 'Full Time',
  workMode: 'Work From Office',
  location: LOCS[0],
  preferredLocation: '',
  expMin: 2,
  expMax: 6,
  relevantExperience: 2,
  joiningTimeline: 'Within 15 Days',
  noticePeriodMax: '30 Days',
  jobPreference: 'Permanent',
  salaryType: 'Annual CTC',
  currency: 'INR',
  salaryMin: '',
  salaryMax: '',
  // The assignment chain:
  //   Requirement → Assigned TL → Assigned Recruiter(s) → BDE → Client
  // These are user IDs, not names — they are what scope filters on.
  recruiterId: '',
  recruiterIds: [],
  bdeId: '',
  tlId: '',
  stlId: '',
  tl: '',
  stl: '',
  targetDate: '',
  accountManager: '',
  postingSources: [],
};

const MONTH = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return { key: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), at: d };
};

export default function Requirements() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requirements, setRequirements] = useState([]);
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The prototype's three views: All Requirements / Open Requirements /
  // Agreement Report. They are sub-views of the Requirements TAB now — the
  // module's own tab strip (Clients · Requirements · Agreements · Job Portal)
  // sits above them.
  const [view, setView] = useState('all');

  // ONE consistent filter set across both list views, exactly as specified:
  //   Department · Client · Location · Recruiter · TL · BDE · Status ·
  //   Priority · Date Range
  // Applied SERVER-SIDE (GET /requirements?…), so a filter can only narrow
  // what the signed-in user is already allowed to see.
  const [filters, setFilters] = useState({
    search: '', department: '', clientId: '', location: '',
    recruiterId: '', tlId: '', bdeId: '', status: '', priority: '', from: '', to: '',
  });
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => setFilters({
    search: '', department: '', clientId: '', location: '',
    recruiterId: '', tlId: '', bdeId: '', status: '', priority: '', from: '', to: '',
  });
  const activeFilterCount = Object.entries(filters).filter(([, v]) => v).length;

  const internal = form.type === 'Internal Requirement';
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  function load() {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.get('/requirements', { params }).then((res) => setRequirements(res.data));
  }
  useEffect(load, [filters]);
  useEffect(() => {
    api.get('/clients').then((res) => setClients(res.data)).catch(() => setClients([]));
    // The assignment picker's source — scoped server-side.
    api.get('/requirements/assignable-people').then((res) => setTeam(res.data)).catch(() => {
      api.get('/ats/team').then((r) => setTeam(r.data)).catch(() => setTeam([]));
    });
  }, []);

  const selectedClient = clients.find((c) => c.id === form.clientId);
  // /requirements/assignable-people returns atsRole; the older /ats/team
  // fallback returns role. Read whichever the response carries.
  const roleOf = (t) => t.atsRole || t.role;
  const recruiters = team.filter((t) => roleOf(t) === 'RECRUITER');
  const bdes = team.filter((t) => roleOf(t) === 'BDE');
  const tls = team.filter((t) => roleOf(t) === 'TL');
  const stls = team.filter((t) => roleOf(t) === 'STL');

  const clientNameOf = (r) => (r.internal ? 'TeamLink Internal' : r.client?.name || '—');

  // The server already applied every filter; these are just the two views.
  const rows = requirements;
  const openRows = useMemo(() => requirements.filter((r) => requirementIsLive(r.status)), [requirements]);

  // The prototype's agreementMonthReport() — counts derived from each client's
  // own agreement milestones, months with no activity are not shown.
  const agreementMonths = useMemo(() => {
    const months = {};
    const bump = (value, key) => {
      const m = MONTH(value);
      if (!m) return;
      months[m.key] = months[m.key] || { created: 0, signed: 0, active: 0, expired: 0, pending: 0, at: m.at };
      months[m.key][key] += 1;
    };
    clients.forEach((c) => {
      bump(c.createdAt, 'created');
      if (c.agreementSignedAt) bump(c.agreementSignedAt, 'signed');
      if (c.agreementStatus === 'ACTIVE') bump(c.agreementActivatedAt || c.agreementSignedAt || c.createdAt, 'active');
      if (c.agreementStatus === 'EXPIRED') bump(c.agreementEnd, 'expired');
      if (['DRAFT', 'SENT'].includes(c.agreementStatus)) bump(c.createdAt, 'pending');
    });
    return Object.entries(months).sort((a, b) => a[1].at - b[1].at);
  }, [clients]);

  function payload(status) {
    return {
      ...form,
      status,
      internal,
      clientId: form.clientId,
      experience: `${form.expMin}-${form.expMax} yrs`,
      relevantExperience: `${form.relevantExperience} yrs`,
      preferredLocation: form.preferredLocation || 'Any',
      salary: form.salaryMin && form.salaryMax ? `₹${form.salaryMin}L - ₹${form.salaryMax}L` : '—',
      bdeId: internal ? '' : form.bdeId,
      description: form.jobDescription,
      postingSources: form.postingSources.join(', '),
    };
  }

  async function save(mode) {
    setError('');
    setNotice('');
    let res;
    try {
      res = await api.post('/requirements', payload(mode === 'draft' ? 'DRAFT' : 'OPEN'));
    } catch (err) {
      return setError(err.response?.data?.error || 'Could not save this requirement');
    }
    // The agreement gate parks a client requirement at Agreement Check rather
    // than refusing the save — say so instead of pretending it went live.
    if (res.data?.gateNote) setNotice(res.data.gateNote);
    setForm(EMPTY);
    setShowForm(false);
    setPreview(false);
    load();
    return undefined;
  }

  const togglePostingSource = (name) => set({
    postingSources: form.postingSources.includes(name)
      ? form.postingSources.filter((s) => s !== name)
      : [...form.postingSources, name],
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Jobs / Requirements</h1>
          <div className="page-sub">
            {`${requirements.length} requirement(s) in your scope`}
          </div>
        </div>
        {canRaiseRequirement(user) && (
          <button className="btn btn-primary" onClick={() => { setForm(EMPTY); setError(''); setShowForm(true); }}>
            Add Requirement
          </button>
        )}
      </div>

      {/* Clients and Requirements are one module now — this is its tab strip. */}
      <ClientModuleTabs active="requirements" />

      {notice && <div className="notice amber">{notice}</div>}

      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'all' ? ' active' : ''}`} onClick={() => setView('all')}>All Requirements</div>
        <div className={`tab${view === 'open' ? ' active' : ''}`} onClick={() => setView('open')}>Open Requirements</div>
        <div className={`tab${view === 'agreements' ? ' active' : ''}`} onClick={() => setView('agreements')}>Agreement Report</div>
      </div>

      {/* ONE filter set, shared by both list views, applied server-side:
          Department · Client · Location · Recruiter · TL · BDE · Status ·
          Priority · Date Range. */}
      {view !== 'agreements' && (
        <>
          <div className="filter-row">
            <input
              type="text"
              placeholder="Search title, skill or REQ id…"
              value={filters.search}
              onChange={(e) => setFilter({ search: e.target.value })}
            />
            <select value={filters.department} onChange={(e) => setFilter({ department: e.target.value })}>
              <option value="">All departments</option>
              {DEPTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={filters.clientId} onChange={(e) => setFilter({ clientId: e.target.value })}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={filters.location} onChange={(e) => setFilter({ location: e.target.value })}>
              <option value="">All locations</option>
              {LOCS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <select value={filters.recruiterId} onChange={(e) => setFilter({ recruiterId: e.target.value })}>
              <option value="">All recruiters</option>
              {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select value={filters.tlId} onChange={(e) => setFilter({ tlId: e.target.value })}>
              <option value="">All TLs</option>
              {tls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select value={filters.bdeId} onChange={(e) => setFilter({ bdeId: e.target.value })}>
              <option value="">All BDEs</option>
              {bdes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="">All statuses</option>
              <option value="LIVE">Live (open → candidates available)</option>
              {REQUIREMENT_STATUS_CODES.map((s) => <option key={s} value={s}>{requirementStatusLabel(s)}</option>)}
            </select>
            <select value={filters.priority} onChange={(e) => setFilter({ priority: e.target.value })}>
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input type="date" title="Created from" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
            <input type="date" title="Created to" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
            {activeFilterCount > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={clearFilters}>{`Clear ${activeFilterCount} filter(s)`}</button>
            )}
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
            Filters run on the server against your own scope — they narrow what you may see, never widen it.
          </div>
        </>
      )}

      {view === 'all' && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Requirement ID</th><th>Job Title</th><th>Client</th><th>Department</th><th>Location</th>
                <th>Experience</th><th>Recruiter</th><th>TL</th><th>BDE</th>
                <th>Priority</th><th>Openings</th><th>Target Date</th><th>Portal Sync</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                  <td><b>{r.reqCode || r.id.slice(0, 8)}</b></td>
                  <td>{r.title}</td>
                  <td className="cell-muted">{clientNameOf(r)}</td>
                  <td className="cell-muted">{r.department || '—'}</td>
                  <td className="cell-muted">{r.location || '—'}</td>
                  <td className="cell-muted">{r.experience || '—'}</td>
                  <td className="cell-muted">
                    {r.recruiter?.name || '—'}
                    {r.coRecruiterNames?.length ? ` +${r.coRecruiterNames.length}` : ''}
                  </td>
                  <td className="cell-muted">{r.tlName || r.tl || '—'}</td>
                  <td className="cell-muted">{r.bde?.name || '—'}</td>
                  <td><span className={`status ${priorityBadgeClass(r.priority)}`}>{r.priority}</span></td>
                  <td>{r.openings}</td>
                  <td className="cell-muted">{r.targetDate || r.closingDate || '—'}</td>
                  <td className="cell-muted">{r.portalSyncStatus || 'Not Synced'}</td>
                  <td><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan="14" className="small-muted" style={{ padding: 16 }}>No requirements match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'open' && (
        <>
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {`${openRows.length} live requirement(s) — Open, Recruiter Assigned, Sourcing or Candidates Available.`}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requirement ID</th><th>Job Title</th><th>Client / Internal</th><th>Department</th><th>Location</th>
                  <th>Openings</th><th>Filled</th><th>Remaining</th><th>Matching</th><th>Recruiter</th><th>TL</th><th>BDE</th>
                  <th>Priority</th><th>Created</th><th>Closing</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {openRows.map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                    <td><b>{r.reqCode || r.id.slice(0, 8)}</b></td>
                    <td>{r.title}</td>
                    <td className="cell-muted">{clientNameOf(r)}</td>
                    <td className="cell-muted">{r.department || '—'}</td>
                    <td className="cell-muted">{r.location || '—'}</td>
                    <td className="cell-muted">{r.openings || 1}</td>
                    <td className="cell-muted">{r.filled ?? 0}</td>
                    <td><b>{r.remaining ?? r.openings}</b></td>
                    <td onClick={(e) => { e.stopPropagation(); navigate(`/requirements/${r.id}`); }}>
                      <span className="link-btn">{r.matchingCandidates ?? 0}</span>
                    </td>
                    <td className="cell-muted">{r.recruiter?.name || '—'}</td>
                    <td className="cell-muted">{r.tlName || r.tl || "—"}</td>
                    <td className="cell-muted">{r.bde?.name || '—'}</td>
                    <td className="cell-muted">{r.priority || '—'}</td>
                    <td className="cell-muted">{r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
                    <td className="cell-muted">{r.closingDate || '—'}</td>
                    <td><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></td>
                  </tr>
                ))}
                {openRows.length === 0 && (
                  <tr><td colSpan="16" className="small-muted" style={{ padding: 16 }}>No open requirements in your scope.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'agreements' && (
        agreementMonths.length === 0
          ? <div className="empty-mini">No agreement activity recorded yet.</div>
          : (
            <>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th><th>Agreements Created</th><th>Signed</th><th>Active</th><th>Expired</th><th>Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agreementMonths.map(([key, m]) => (
                      <tr key={key}>
                        <td><b>{key}</b></td>
                        <td>{m.created}</td>
                        <td className="cell-muted">{m.signed}</td>
                        <td className="cell-muted">{m.active}</td>
                        <td className="cell-muted">{m.expired}</td>
                        <td className="cell-muted">{m.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                Computed from each client&apos;s agreement history — months with no activity are not shown.
              </div>
            </>
          )
      )}

      {showForm && !preview && (
        <Modal
          title="Create Requirement"
          size="xwide"
          onClose={() => setShowForm(false)}
          footer={(
            <>
              <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn" onClick={() => setPreview(true)}>Preview</button>
              <button className="btn" onClick={() => save('draft')}>Save Draft</button>
              <button className="btn" onClick={() => save('activate')}>Save &amp; Activate</button>
              <button className="btn btn-primary" onClick={() => save('post')}>Save &amp; Post</button>
            </>
          )}
        >
          <SectionHead first>A. Basic Information</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Requirement ID</span>
              <input disabled value="Assigned automatically on save" />
            </label>
            <label className="field">
              <span>Requirement Type *</span>
              <select value={form.type} onChange={(e) => set({ type: e.target.value })}>
                {REQUIREMENT_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Job Title *</span>
              <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Senior Java Developer" />
            </label>
            <label className="field">
              <span>Department *</span>
              <select value={form.department} onChange={(e) => set({ department: e.target.value })}>
                {DEPTS.map((d) => <option key={d}>{d}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Number of Openings *</span>
              <input type="number" min="1" value={form.openings} onChange={(e) => set({ openings: e.target.value })} />
            </label>
            <label className="field">
              <span>Priority *</span>
              <select value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Requirement Status</span>
              <input disabled value="Draft (until activated)" />
            </label>
            <label className="field">
              <span>Closing Date</span>
              <input type="date" value={form.closingDate} onChange={(e) => set({ closingDate: e.target.value })} />
            </label>
          </div>

          {!internal && (
            <>
              <SectionHead>B. Client Information</SectionHead>
              <div className="grid-2">
                <label className="field">
                  <span>Client *</span>
                  <select value={form.clientId} onChange={(e) => set({ clientId: e.target.value })}>
                    <option value="">— Select —</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Agreement</span>
                  <input disabled value={selectedClient?.agreementId || (selectedClient ? 'Not raised yet' : '')} />
                </label>
                <label className="field">
                  <span>Agreement Status</span>
                  <input disabled value={selectedClient ? agreementStatusLabel(selectedClient.agreementStatus) : ''} />
                </label>
                <label className="field">
                  <span>Client Contact</span>
                  <input
                    disabled
                    value={selectedClient
                      ? [selectedClient.contactName, selectedClient.contactPhone].filter(Boolean).join(' · ') || '—'
                      : ''}
                  />
                </label>
              </div>
              {selectedClient && (
                agreementIsActive(selectedClient.agreementStatus)
                  ? <div className="notice">Agreement is Active — this requirement can be activated and posted.</div>
                  : (
                    <div className="notice amber">
                      Agreement is <b>{agreementStatusLabel(selectedClient.agreementStatus)}</b>. You can save this
                      requirement as Draft, but it cannot be activated or posted until the agreement is Active.
                    </div>
                  )
              )}
            </>
          )}

          <SectionHead>C. Job Description</SectionHead>
          <label className="field">
            <span>Full Job Description *</span>
            <textarea rows="3" value={form.jobDescription} onChange={(e) => set({ jobDescription: e.target.value })} />
          </label>
          <label className="field">
            <span>Responsibilities</span>
            <textarea rows="2" placeholder="One per line" value={form.responsibilities} onChange={(e) => set({ responsibilities: e.target.value })} />
          </label>
          <label className="field">
            <span>Qualifications</span>
            <textarea rows="2" value={form.qualifications} onChange={(e) => set({ qualifications: e.target.value })} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Education</span>
              <select value={form.education} onChange={(e) => set({ education: e.target.value })}>
                {EDUCATION_LEVELS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Mandatory Skills * (comma separated)</span>
              <input value={form.skills} placeholder="Java, Spring Boot, SQL" onChange={(e) => set({ skills: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Good-to-have Skills (comma separated)</span>
            <input value={form.goodToHaveSkills} placeholder="AWS, Docker" onChange={(e) => set({ goodToHaveSkills: e.target.value })} />
          </label>

          <SectionHead>D. Job Conditions</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Employment Type *</span>
              <select value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Work Mode *</span>
              <select value={form.workMode} onChange={(e) => set({ workMode: e.target.value })}>
                {WORK_MODES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Work Location *</span>
              <select value={form.location} onChange={(e) => set({ location: e.target.value })}>
                {LOCS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Preferred Location</span>
              <select value={form.preferredLocation} onChange={(e) => set({ preferredLocation: e.target.value })}>
                <option value="">Any</option>
                {LOCS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Minimum Experience (yrs) *</span>
              <input type="number" min="0" value={form.expMin} onChange={(e) => set({ expMin: e.target.value })} />
            </label>
            <label className="field">
              <span>Maximum Experience (yrs)</span>
              <input type="number" min="0" value={form.expMax} onChange={(e) => set({ expMax: e.target.value })} />
            </label>
            <label className="field">
              <span>Relevant Experience (yrs)</span>
              <input type="number" min="0" value={form.relevantExperience} onChange={(e) => set({ relevantExperience: e.target.value })} />
            </label>
            <label className="field">
              <span>Joining Timeline *</span>
              <select value={form.joiningTimeline} onChange={(e) => set({ joiningTimeline: e.target.value })}>
                {JOINING_TIMELINES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Maximum Notice Period</span>
              <select value={form.noticePeriodMax} onChange={(e) => set({ noticePeriodMax: e.target.value })}>
                {NOTICE_PERIODS_MAX.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Job Preference</span>
              <select value={form.jobPreference} onChange={(e) => set({ jobPreference: e.target.value })}>
                {JOB_PREFERENCES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          </div>

          <SectionHead>E. Compensation</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Salary Type</span>
              <select value={form.salaryType} onChange={(e) => set({ salaryType: e.target.value })}>
                {SALARY_TYPES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Currency</span>
              <select value={form.currency} onChange={(e) => set({ currency: e.target.value })}>
                {CURRENCIES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Minimum Salary (₹L)</span>
              <input type="number" step="0.5" placeholder="10" value={form.salaryMin} onChange={(e) => set({ salaryMin: e.target.value })} />
            </label>
            <label className="field">
              <span>Maximum Salary (₹L)</span>
              <input type="number" step="0.5" placeholder="15" value={form.salaryMax} onChange={(e) => set({ salaryMax: e.target.value })} />
            </label>
          </div>

          <SectionHead>F. Assignment</SectionHead>
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            Requirement → Assigned TL → Assigned Recruiter(s) → BDE → Client. This chain is what decides who
            can see this requirement: a recruiter sees the ones assigned to them, a TL the ones they lead,
            a BDE their clients&apos;.
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Assigned TL</span>
              <select
                value={form.tlId}
                onChange={(e) => set({ tlId: e.target.value, tl: tls.find((t) => t.id === e.target.value)?.name || '' })}
              >
                <option value="">— Not assigned —</option>
                {tls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Assigned Recruiter *</span>
              <select value={form.recruiterId} onChange={(e) => set({ recruiterId: e.target.value })}>
                <option value="">— Not assigned —</option>
                {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>STL</span>
              <select
                value={form.stlId}
                onChange={(e) => set({ stlId: e.target.value, stl: stls.find((t) => t.id === e.target.value)?.name || '' })}
              >
                <option value="">— None —</option>
                {stls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            {!internal && (
              <label className="field">
                <span>BDE</span>
                <select value={form.bdeId} onChange={(e) => set({ bdeId: e.target.value })}>
                  <option value="">— Not assigned —</option>
                  {bdes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span>Account Manager / BDE owner</span>
              <input
                value={form.accountManager}
                placeholder={selectedClient?.accountManager || 'Defaults to the client account manager'}
                onChange={(e) => set({ accountManager: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Target Date</span>
              <input type="date" value={form.targetDate} onChange={(e) => set({ targetDate: e.target.value })} />
            </label>
          </div>
          <div className="field">
            <span>Co-recruiters (a requirement can carry more than one)</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
              {recruiters.filter((r) => r.id !== form.recruiterId).map((r) => (
                <label key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={form.recruiterIds.includes(r.id)}
                    onChange={() => set({
                      recruiterIds: form.recruiterIds.includes(r.id)
                        ? form.recruiterIds.filter((x) => x !== r.id)
                        : [...form.recruiterIds, r.id],
                    })}
                  />
                  {r.name}
                </label>
              ))}
              {recruiters.length === 0 && <span className="cell-muted" style={{ fontSize: 12 }}>No recruiters in your scope.</span>}
            </div>
          </div>

          <SectionHead>G. Job Posting</SectionHead>
          <div className="field">
            <span>Posting Sources</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
              {POSTING_SOURCES.map((name) => (
                <label key={name} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={form.postingSources.includes(name)}
                    onChange={() => togglePostingSource(name)}
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5 }}>
            Posting Status, External Job ID and External URL are managed by the existing Job Posting lifecycle
            (Draft → Ready to Post → Posted / Partially Posted / Failed → Paused → Closed) on the requirement
            page after saving.
          </div>

          {error && <div className="error-text">{error}</div>}
        </Modal>
      )}

      {showForm && preview && (
        <Modal
          title={`Preview — ${form.title || '(untitled)'}`}
          size="xwide"
          onClose={() => { setPreview(false); setShowForm(false); }}
          footer={<button className="btn btn-primary" onClick={() => setPreview(false)}>← Back to form</button>}
        >
          <div className="section-label">Basic</div>
          <div className="kv"><span className="k">Type</span><span>{form.type}</span></div>
          {!internal && (
            <div className="kv">
              <span className="k">Client</span>
              <span>{`${selectedClient?.name || '—'} · Agreement ${selectedClient ? agreementStatusLabel(selectedClient.agreementStatus) : '—'}`}</span>
            </div>
          )}
          <div className="kv"><span className="k">Department</span><span>{form.department}</span></div>
          <div className="kv"><span className="k">Openings / Priority</span><span>{`${form.openings} · ${form.priority}`}</span></div>
          <div className="kv"><span className="k">Closing Date</span><span>{form.closingDate || '—'}</span></div>
          <div className="section-label">Job Description</div>
          <div className="cell-muted" style={{ fontSize: 12.5, whiteSpace: 'pre-line' }}>{form.jobDescription || '—'}</div>
          {form.responsibilities && (
            <>
              <div className="section-label">Responsibilities</div>
              <div className="cell-muted" style={{ fontSize: 12.5, whiteSpace: 'pre-line' }}>{form.responsibilities}</div>
            </>
          )}
          {form.qualifications && (
            <>
              <div className="section-label">Qualifications</div>
              <div className="cell-muted" style={{ fontSize: 12.5, whiteSpace: 'pre-line' }}>{form.qualifications}</div>
            </>
          )}
          <div className="section-label">Skills</div>
          <div className="kv"><span className="k">Mandatory</span><span>{form.skills || '—'}</span></div>
          <div className="kv"><span className="k">Good-to-have</span><span>{form.goodToHaveSkills || '—'}</span></div>
          <div className="section-label">Conditions</div>
          <div className="kv"><span className="k">Employment / Mode</span><span>{`${form.employmentType} · ${form.workMode}`}</span></div>
          <div className="kv"><span className="k">Location</span><span>{`${form.location} (preferred: ${form.preferredLocation || 'Any'})`}</span></div>
          <div className="kv"><span className="k">Experience</span><span>{`${form.expMin}-${form.expMax} yrs (relevant ${form.relevantExperience} yrs)`}</span></div>
          <div className="kv"><span className="k">Joining / Notice</span><span>{`${form.joiningTimeline} · max ${form.noticePeriodMax}`}</span></div>
          <div className="kv"><span className="k">Job Preference</span><span>{form.jobPreference}</span></div>
          <div className="section-label">Compensation</div>
          <div className="kv">
            <span className="k">{`${form.salaryType} (${form.currency})`}</span>
            <span>{form.salaryMin && form.salaryMax ? `₹${form.salaryMin}L - ₹${form.salaryMax}L` : '—'}</span>
          </div>
          <div className="section-label">Assignment</div>
          <div className="kv">
            <span className="k">{`Recruiter / TL / STL${internal ? '' : ' / BDE'}`}</span>
            <span>
              {[
                recruiters.find((r) => r.id === form.recruiterId)?.name || '—',
                form.tl || '—',
                form.stl || '—',
                ...(internal ? [] : [bdes.find((b) => b.id === form.bdeId)?.name || '—']),
              ].join(' · ')}
            </span>
          </div>
          <div className="section-label">Posting Sources</div>
          <div className="kv"><span className="k">Selected</span><span>{form.postingSources.join(', ') || 'None'}</span></div>
        </Modal>
      )}
    </div>
  );
}
