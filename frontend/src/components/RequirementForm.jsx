import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal, { SectionHead } from './Modal.jsx';
import Combo from './Combo.jsx';
import { Help } from './ui/Guide.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { can, productRole } from '../permissions';
import { PRIORITY_CHOICES, priorityLabel } from './jobs/reqFormat.jsx';
import {
  TlOptions, RecruiterOptions, useAllTls, useRecruiterBench, benchPeople,
} from './jobs/assignPeople.jsx';
import SpecPicker from './SpecPicker.jsx'; // spec D: Qualification + Specialization (Admin master)
// B9.1 / B9.4 (ATS-100): duplicate-job warning with "Create anyway", and job templates.
import DuplicateJobWarning from './jobs/DuplicateJobWarning.jsx';
import JobTemplates from './jobs/JobTemplates.jsx';
// docfill_: "Upload the requirement" / "Type it myself" (components/ui/FillFromFile.jsx).
import { useFillFromFile, FillEntryModal, FillBanner } from './ui/FillFromFile.jsx';
import { jobFieldsToForm, JOB_FIELD_NAMES } from './ui/fillMaps.js';
import {
  DEPTS, deptOptions, LOCS, PRIORITIES, REQUIREMENT_TYPES, EDUCATION_LEVELS, EMPLOYMENT_TYPES, WORK_MODES,
  JOINING_TIMELINES, NOTICE_PERIODS_MAX, JOB_PREFERENCES, SALARY_TYPES, CURRENCIES,
  requirementStatusLabel,
  agreementStatusLabel, agreementIsActive,
} from '../atsVocab';

// ---------------------------------------------------------------------------
// THE REQUIREMENT FORM — ONE form, two modes.
//
// This is the prototype's seven-lettered Create Requirement modal
// (openAddRequirementModal, line 6956), moved out of pages/Requirements.jsx
// unchanged so that EDIT REQUIREMENT reuses it rather than growing a second
// copy that drifts. The sections, the fields, the Combo dropdowns and the
// preview are the same markup they always were; what is new is `mode`.
//
//   mode="create"  Requirements -> Add Requirement.   POST /requirements
//   mode="edit"    Requirement Detail -> Edit.        PUT  /requirements/:id
//
// WHAT AN EDIT MAY CHANGE, and who may change it, is the SERVER's decision —
// backend/src/routes/requirements.js resolves it from the one permission
// engine and refuses anything else. This component mirrors that decision so
// the screen does not offer a control the API will reject:
//
//   * Requirement Type and Client are fixed once saved. Re-pointing a saved
//     requirement at another client re-decides the agreement gate and the
//     whole commercial record; that is a new requirement, not an edit.
//   * Status is not edited here at all. It moves through Activate / the
//     workflow buttons on the detail page, which enforce the agreement gate.
//   * THE ASSIGNMENT CHAIN needs the `assign` action, not `edit`. TL /
//     Recruiter(s) / BDE / STL / Account Manager decide who can SEE the
//     record, so changing them is a scope change. A recruiter holds `edit`
//     on requirements assigned to them and does not hold `assign`; section F
//     is read-only for them and says why. The API refuses it as well — the
//     read-only state is an explanation, not the enforcement.
// ---------------------------------------------------------------------------

export const EMPTY = {
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
  //   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
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
  // spec D: master Qualification / Specialization ids (Administration -> Master lists).
  qualificationId: '',
  specialisationId: '',
};

const listOf = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// Our own sites, ticked by default on a new job (they post at once).
const OWN_SITES = ['TeamLink Job Portal', 'TeamLink Website', 'Google Jobs'];

// "5-8 yrs" / "2 yrs" back into the two number inputs the form carries. The
// server stores the rendered string; the form edits the numbers behind it.
function splitExperience(value, fallback) {
  const nums = String(value || '').match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return fallback;
  return [Number(nums[0]), nums[1] !== undefined ? Number(nums[1]) : fallback[1]];
}
function splitSalary(value) {
  const nums = String(value || '').match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return ['', ''];
  // "up to ₹15L" is a maximum only.
  if (/up to/i.test(String(value))) return ['', nums[0]];
  return [nums[0], nums[1] !== undefined ? nums[1] : ''];
}
// The stored salary band. Either end may be left blank — a one-sided band
// used to be thrown away as "—".
function salaryBand(min, max) {
  if (min && max) return `₹${min}L - ₹${max}L`;
  if (min) return `₹${min}L+`;
  if (max) return `up to ₹${max}L`;
  return '—';
}

// Everything the server would refuse, said up front and all at once.
// kind: 'draft' | 'activate' | 'post' | 'edit'.
export function formProblems(form, { kind, internal, editing }) {
  const out = [];
  const blank = (v) => !String(v ?? '').trim();
  if (blank(form.title)) out.push('Enter the job title.');
  if (blank(form.department)) out.push('Pick a department.');
  const openings = Number(form.openings);
  if (!Number.isInteger(openings) || openings < 1 || openings > 999) out.push('Openings must be a number from 1 to 999.');
  if (!editing && !internal && !form.clientId) out.push('Pick a client, or choose Internal.');
  if (blank(form.priority)) out.push('Pick the priority.');
  // Every field marked * on the form is checked here (a draft may skip the job details).
  if (kind !== 'draft') {
    if (blank(form.jobDescription)) out.push('Enter the job description.');
    if (blank(form.skills)) out.push('Enter at least one must-have skill.');
    if (blank(form.employmentType)) out.push('Pick the employment type.');
    if (blank(form.workMode)) out.push('Pick the work mode.');
    if (blank(form.location)) out.push('Enter the location.');
    if (blank(form.expMin) || Number(form.expMin) < 0) out.push('Enter the minimum experience.');
    if (blank(form.joiningTimeline)) out.push('Pick when the person should join.');
  }
  const min = Number(form.expMin); const max = Number(form.expMax);
  if (form.expMin !== '' && form.expMax !== '' && min > max) out.push('Minimum experience can not be more than maximum.');
  const sMin = Number(form.salaryMin); const sMax = Number(form.salaryMax);
  if (form.salaryMin !== '' && form.salaryMax !== '' && sMin > sMax) out.push('Minimum salary can not be more than maximum.');
  if (!editing) {
    const today = new Date().toISOString().slice(0, 10);
    if (form.closingDate && form.closingDate < today) out.push('The closing date is in the past.');
    if (form.targetDate && form.targetDate < today) out.push('The target date is in the past.');
  }
  return out;
}

// A saved requirement, read back into the form's shape. Every field the form
// edits is filled from the record, so opening Edit shows what is stored
// rather than a half-blank form the save would then wipe.
export function formFromRequirement(r) {
  if (!r) return { ...EMPTY };
  const [expMin, expMax] = splitExperience(r.experience, [EMPTY.expMin, EMPTY.expMax]);
  const [relevant] = splitExperience(r.relevantExperience, [EMPTY.relevantExperience]);
  const [salaryMin, salaryMax] = splitSalary(r.salary);
  return {
    ...EMPTY,
    type: r.internal ? 'Internal Requirement' : 'Client Requirement',
    title: r.title || '',
    clientId: r.clientId || '',
    department: r.department || EMPTY.department,
    openings: r.openings ?? 1,
    priority: r.priority || 'Medium',
    closingDate: r.closingDate || '',
    jobDescription: r.jobDescription || r.description || '',
    responsibilities: r.responsibilities || '',
    qualifications: r.qualifications || '',
    education: r.education || EMPTY.education,
    skills: r.skills || '',
    goodToHaveSkills: r.goodToHaveSkills || '',
    employmentType: r.employmentType || EMPTY.employmentType,
    workMode: r.workMode || EMPTY.workMode,
    location: r.location || EMPTY.location,
    preferredLocation: r.preferredLocation && r.preferredLocation !== 'Any' ? r.preferredLocation : '',
    expMin,
    expMax,
    relevantExperience: relevant,
    joiningTimeline: r.joiningTimeline || EMPTY.joiningTimeline,
    noticePeriodMax: r.noticePeriodMax || EMPTY.noticePeriodMax,
    jobPreference: r.jobPreference || EMPTY.jobPreference,
    salaryType: r.salaryType || EMPTY.salaryType,
    currency: r.currency || EMPTY.currency,
    salaryMin,
    salaryMax,
    recruiterId: r.recruiterId || '',
    recruiterIds: (r.coRecruiters || []).map((c) => c.id),
    bdeId: r.bdeId || '',
    tlId: r.tlId || '',
    stlId: r.stlId || '',
    tl: r.tlName || r.tl || '',
    stl: r.stlName || r.stl || '',
    targetDate: r.targetDate || '',
    accountManager: r.accountManager || '',
    postingSources: listOf(r.postingSources),
    qualificationId: r.qualificationId || '',
    specialisationId: r.specialisationId || '',
  };
}

export default function RequirementForm({
  mode = 'create',
  requirement = null,
  clients = [],
  team = [],
  canAssign = true,
  // ?new=1&clientId= (Clients → + New Requirement) pre-selects the client.
  initialClientId = '',
  onClose,
  onSaved,
}) {
  // RAISING a requirement is scoped too: a Medical TL picks Medical, not the
  // whole company. Same server-computed list the filters use.
  const { user } = useAuth();
  const departments = deptOptions(user);
  const editing = mode === 'edit';
  const atsRole = productRole(user, 'ats');
  // Agreement steps are the Admin's (clients / Agreement Lifecycle); the
  // client record is the client desk's. The gate message says who does what.
  const canRunAgreement = can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit');
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const [form, setForm] = useState(() => (editing
    ? formFromRequirement(requirement)
    // EMPTY.department is DEPTS[0] ('IT'), which a Medical TL may not raise
    // for — start them on the first department they actually hold. A TL / STL
    // / BDE raising a requirement starts on its chain in their own role (the
    // server does the same), so it never vanishes from their own list.
    : {
      ...EMPTY,
      department: departments[0] || EMPTY.department,
      tlId: atsRole === 'TL' ? (user?.id || '') : '',
      tl: atsRole === 'TL' ? (user?.name || '') : '',
      stlId: atsRole === 'STL' ? (user?.id || '') : '',
      stl: atsRole === 'STL' ? (user?.name || '') : '',
      bdeId: atsRole === 'BDE' ? (user?.id || '') : '',
      clientId: initialClientId || '',
      postingSources: [...OWN_SITES],
    }));
  const [problems, setProblems] = useState([]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState(null); // B9.1: the server's 409 DUPLICATE_JOB answer (+ which save)
  // docfill_: the two-choice entry (Add only) and the green / orange marks on
  // the fields a file filled. Edit opens the form straight away.
  const fill = useFillFromFile('job', { enabled: !editing });
  const ff = (name) => fill.cls(name);
  const ft = (name) => fill.tag(name);
  // ONE CLICK = ONE JOB (spec §25): a ref blocks a second click before the
  // button re-renders as disabled, and the one-time key per form opening
  // makes the server answer a repeat with the same job (utils/idempotency.js).
  const busy = useRef(false);
  const onceKey = useRef(`rf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
  // SAVE & POST (2026-10-05): the sources, each with whether it can post now
  // or needs setup in Administration → Integrations (utils/jobConnectors.js).
  const [sources, setSources] = useState(null);
  useEffect(() => {
    let on = true;
    api.get('/requirements/posting-sources')
      .then((r) => { if (on) setSources(r.data.sources || []); })
      .catch(() => { if (on) setSources([]); });
    return () => { on = false; };
  }, []);

  const internal = form.type === 'Internal Requirement';
  // Section F is locked only on an EDIT the user may not re-assign. Creating
  // a requirement is where the chain is first set, and `create` carries it.
  const lockAssign = editing && !canAssign;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const selectedClient = clients.find((c) => c.id === form.clientId);
  const roleOf = (t) => t.atsRole || t.role;
  const bdes = useMemo(() => team.filter((t) => roleOf(t) === 'BDE'), [team]);
  // TLs sorted by department and labelled with it — "Medical TL", "IT TL" —
  // so the right desk is picked first.
  const deptOf = (t) => t.atsDepartment || t.department || '';
  const tls = useMemo(() => team.filter((t) => roleOf(t) === 'TL')
    .sort((a, b) => deptOf(a).localeCompare(deptOf(b)) || a.name.localeCompare(b.name)), [team]);
  const stls = useMemo(() => team.filter((t) => roleOf(t) === 'STL'), [team]);
  const allRecruiters = useMemo(() => team.filter((t) => roleOf(t) === 'RECRUITER'), [team]);
  // ASSIGNMENT (user, 2026-10-05 — supersedes the 2026-10-03 "only this
  // department's TLs" rule): "Assigned to" lists the TLs of EVERY department,
  // grouped by department, the job's own first, each with their open jobs. A
  // busy Medical desk can hand a job to the Manufacturing team; the job keeps
  // its department. The TL then picks the recruiter — on Edit, the chosen
  // TL's team, least busy first (components/jobs/assignPeople.jsx). On Add the
  // recruiter fields stay hidden: the TL assigns them.
  const allTls = useAllTls(!lockAssign);
  const tlChoices = allTls || tls;
  const bench = useRecruiterBench(form.tlId, editing && !lockAssign, form.department);
  const keepRecruiters = editing ? [
    requirement?.recruiterId ? { id: requirement.recruiterId, name: requirement.recruiter?.name } : null,
    ...((requirement?.coRecruiters || []).map((c) => ({ id: c.id, name: c.name }))),
  ].filter(Boolean) : [];
  const benchList = benchPeople(bench);
  const recruiters = bench
    ? [...keepRecruiters.filter((k) => !benchList.some((p) => p.id === k.id)), ...benchList]
    : allRecruiters;
  const pickTl = (tlId) => {
    const tl = tlChoices.find((t) => t.id === tlId) || tls.find((t) => t.id === tlId);
    set({ tlId, tl: tl?.name || '' });
  };

  // The same body both modes send. On an edit the server drops status and
  // clientId itself, and drops the assignment fields for anyone without
  // `assign` — nothing here relies on the browser to withhold them.
  function payload(status) {
    return {
      ...form,
      status,
      internal,
      clientId: form.clientId,
      experience: `${form.expMin}-${form.expMax} yrs`,
      relevantExperience: `${form.relevantExperience} yrs`,
      preferredLocation: form.preferredLocation || 'Any',
      salary: salaryBand(form.salaryMin, form.salaryMax),
      openings: Number(form.openings),
      bdeId: internal ? '' : form.bdeId,
      description: form.jobDescription,
      // Nothing ticked is stored as 'None' (empty would read as "our own sites").
      postingSources: form.postingSources.length ? form.postingSources.join(', ') : 'None',
    };
  }

  async function save(kind, extra = {}) { // B9.1: extra = { duplicateOverride, duplicateReason } on "Create anyway"
    if (saving || busy.current) return;
    setError('');
    const found = formProblems(form, { kind, internal, editing: false });
    setProblems(found);
    if (found.length) return;
    busy.current = true;
    setSaving(true);
    try {
      const res = await api.post('/requirements', { ...payload(kind === 'draft' ? 'DRAFT' : 'OPEN'), ...extra }, { headers: { 'Idempotency-Key': onceKey.current } });
      // SAVE & POST: the server publishes the ONE job on every ticked site at
      // once, in the background (utils/jobConnectors.js). The job page shows
      // each site's own result as it comes in.
      let posting = null;
      const live = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].includes(res.data?.status);
      const n = form.postingSources.length;
      if (kind === 'post' && n && live) posting = `Posting to ${n} site${n === 1 ? '' : 's'} now. Each site's result shows on the job page.`;
      else if (kind === 'post' && n && res.data?.status === 'AGREEMENT_CHECK') posting = 'Will post when the agreement is Active.';
      else if (kind === 'post' && !n) posting = 'No posting site was ticked, so it is not posted anywhere.';
      // docfill_: keep the uploaded requirement on the job as its source document.
      const sourceNote = await fill.attach('job', res.data?.id);
      if (sourceNote) posting = [posting, sourceNote].filter(Boolean).join(' ');
      onSaved?.(res.data, { created: true, posting, openJob: kind === 'post' });
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.code === 'DUPLICATE_JOB') { setDup({ ...err.response.data, kind }); return; } // B9.1
      setError(err.response?.data?.error || 'Could not save the job. Please try again.');
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }

  async function saveEdit(extra = {}) { // B9.1: extra = { duplicateOverride, duplicateReason } on "Save anyway"
    if (saving || busy.current) return;
    setError('');
    const found = formProblems(form, { kind: requirement?.status === 'DRAFT' ? 'draft' : 'edit', internal, editing: true });
    setProblems(found);
    if (found.length) return;
    busy.current = true;
    setSaving(true);
    const body = payload(undefined);
    // Never send a field the user is not allowed to change: the server
    // refuses the whole request when an unchanged-looking assignment value
    // round-trips differently, and a refusal the user cannot act on is worse
    // than not offering the control.
    if (lockAssign) {
      ['recruiterId', 'recruiterIds', 'bdeId', 'tlId', 'stlId', 'accountManager', 'tl', 'stl']
        .forEach((k) => { delete body[k]; });
    }
    delete body.status;
    delete body.clientId;
    // `description` is the short form of the job description and the create
    // form derives one from the other. On an edit that leaves the JD alone,
    // sending it anyway would report "Description changed" on every record
    // whose description was never separately filled in — a true diff, but a
    // meaningless one. Send it only when the JD actually moved.
    if (form.jobDescription === (requirement.jobDescription || requirement.description || '')) {
      delete body.description;
    }
    try {
      const res = await api.put(`/requirements/${requirement.id}`, { ...body, ...extra });
      onSaved?.(res.data, { created: false, changedFields: res.data?.changedFields || [] });
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.code === 'DUPLICATE_JOB') { setDup({ ...err.response.data, kind: 'edit' }); return; } // B9.1
      setError(err.response?.data?.error || 'Could not save the job. Please try again.');
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }

  const togglePostingSource = (name) => set({
    postingSources: form.postingSources.includes(name)
      ? form.postingSources.filter((s) => s !== name)
      : [...form.postingSources, name],
  });

  if (preview) {
    return (
      <Modal
        title={`Preview — ${form.title || '(untitled)'}`}
        size="xwide"
        onClose={() => setPreview(false)}
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
        <div className="kv"><span className="k">Openings / Priority</span><span>{`${form.openings} · ${priorityLabel(form.priority)}`}</span></div>
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
          <span>{salaryBand(form.salaryMin, form.salaryMax)}</span>
        </div>
        <div className="section-label">Team</div>
        {/* Add job: only the team lead (the TL picks the recruiters later). */}
        {editing ? (
          <div className="kv">
            <span className="k">{`Recruiter / Team lead / Senior team lead${internal ? '' : ' / Client manager (BDE)'}`}</span>
            <span>
              {[
                allRecruiters.find((r) => r.id === form.recruiterId)?.name || '—',
                form.tl || '—',
                form.stl || '—',
                ...(internal ? [] : [bdes.find((b) => b.id === form.bdeId)?.name || '—']),
              ].join(' · ')}
            </span>
          </div>
        ) : (
          <div className="kv"><span className="k">Team lead</span><span>{form.tl || '—'}</span></div>
        )}
        <div className="section-label">Posting Sources</div>
        <div className="kv"><span className="k">Selected</span><span>{form.postingSources.join(', ') || 'None'}</span></div>
      </Modal>
    );
  }

  // docfill_: on Add, the two big choices come first; "Type it myself" or a
  // read file then shows the form below exactly as today.
  if (!editing && fill.entry !== 'form') {
    return (
      <FillEntryModal
        title="Add job"
        target="job"
        fill={fill}
        onClose={onClose}
        onFilled={(r) => set(jobFieldsToForm(r.fields || {}, { clients, departments }))}
      />
    );
  }
  const clientSuggest = !editing && fill.state && !form.clientId ? fill.state.fields.clientSuggest : null;
  const clientMark = !editing && fill.state ? (form.clientId ? ' ff-found' : ' ff-missing') : '';
  const clientTag = !editing && fill.state ? (form.clientId ? <span className="ff-tag ok">Found in the file</span> : <span className="ff-tag no">Not found: pick one</span>) : null;

  return (
      <Modal
        title={editing ? `Edit job — ${requirement.reqCode || requirement.title}` : 'Add job'}
        size="xwide"
        onClose={onClose}
        footer={(
          <>
            {(problems.length > 0 || error) && (
              <div className="error-text" role="alert" style={{ flex: '1 1 100%', margin: '0 0 6px', textAlign: 'left' }}>
                {problems.length > 0 && (
                  <>
                    <b>{problems.length === 1 ? 'Fix this before saving:' : `Fix these ${problems.length} things before saving:`}</b>
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{problems.map((x) => <li key={x}>{x}</li>)}</ul>
                  </>
                )}
                {error && <div>{error}</div>}
              </div>
            )}
            {/* B9.1: the same client already has this job open — show it, "Create anyway" needs a reason. */}
            <DuplicateJobWarning dup={dup} editing={editing} onCancel={() => setDup(null)} onCreateAnyway={(reason) => { const k = dup.kind; setDup(null); if (k === 'edit') saveEdit({ duplicateOverride: true, duplicateReason: reason }); else save(k, { duplicateOverride: true, duplicateReason: reason }); }} />
            {editing ? (
              <>
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn" onClick={() => setPreview(true)}>Preview</button>
                <button className="btn btn-primary" disabled={saving} onClick={saveEdit} title={requirement?.status === 'DRAFT' ? 'Saves the draft. Nothing is posted.' : 'Saves the job and updates it on every ticked site'}>
                  {saving ? 'Saving…' : (requirement?.status === 'DRAFT' ? 'Save Changes' : 'Save & Post')}
                </button>
              </>
            ) : (
              <>
                <button className="btn" disabled={saving} onClick={onClose}>Cancel</button>
                <button className="btn" onClick={() => setPreview(true)}>Preview</button>
                <button className="btn" disabled={saving} onClick={() => save('draft')} title="Saved as Draft — nothing is live or posted">Save Draft</button>
                <button className="btn btn-primary" disabled={saving} onClick={() => save('post')} title="Saves the job and posts it on every ticked site. A client job whose agreement is not Active yet posts by itself when it becomes Active.">
                  {saving ? 'Saving…' : 'Save & Post'}
                </button>
                <div className="cell-muted" style={{ flex: '1 1 100%', textAlign: 'right', fontSize: 11.5, marginTop: 4 }}>
                  We post this job on the ticked sites and show each site&apos;s status on the job page.
                </div>
              </>
            )}
          </>
        )}
      >
          {!editing && <FillBanner fill={fill} names={JOB_FIELD_NAMES} />}
          {clientSuggest && (
            <div className="notice amber">
              <span>
                {'The file names the client '}
                <b>{clientSuggest}</b>
                {', which is not in your client list. Add the client first (Clients → Add client), then pick it in section B — or pick the right client below.'}
              </span>
            </div>
          )}
          {/* B9.4: "Start from a template" / "Save as template" (components/jobs/JobTemplates.jsx) — Add job only. */}
          {!editing && <JobTemplates form={form} toForm={formFromRequirement} payload={() => payload('DRAFT')} onApply={set} />}
          <SectionHead first>A. Basic Information</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Job ID</span>
              <input disabled value={editing ? (requirement.reqCode || requirement.id) : 'Assigned automatically on save'} />
            </label>
            <label className="field">
              <span>Job type *</span>
              <Combo value={form.type} disabled={editing} onChange={(e) => set({ type: e.target.value })}>
                {REQUIREMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/Requirement$/, 'job')}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('title')}`}>
              <span>Job Title *{ft('title')}</span>
              <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Senior Java Developer" />
            </label>
            <label className={`field${ff('department')}`}>
              <span>Department *{ft('department')}</span>
              <Combo
                creatable
                value={form.department}
                onChange={(e) => {
                  const department = e.target.value;
                  // The chosen TL stays: a job may go to any department's TL (2026-10-05).
                  set({
                    department,
                    // spec D: the qualification / specialization belong to the department.
                    ...(department !== form.department ? { qualificationId: '', specialisationId: '' } : {}),
                  });
                }}
              >
                {departments.map((d) => <option key={d}>{d}</option>)}
              </Combo>
            </label>
            <SpecPicker
              wrapClass={null}
              department={form.department}
              qualificationId={form.qualificationId}
              specialisationId={form.specialisationId}
              oldValue={editing ? requirement?.specialisation || '' : ''}
              onChange={(v) => set(v)}
            />
            <label className={`field${ff('openings')}`}>
              <span>Number of openings *{ft('openings')}<Help text="How many people the client wants for this job. 3 openings = 3 people can join." /></span>
              <input type="number" min="1" value={form.openings} onChange={(e) => set({ openings: e.target.value })} />
            </label>
            <label className="field">
              <span>Priority *</span>
              <Combo value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                {/* Stored values unchanged; "Urgent" reads Critical (review #2 §6). */}
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_CHOICES.find((c) => c.value === p)?.label || p}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Job status</span>
              <input disabled value={editing ? requirementStatusLabel(requirement.status) : 'Draft (until activated)'} />
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
                <label className={`field${clientMark}`}>
                  <span>Client *{clientTag}</span>
                  <Combo value={form.clientId} disabled={editing} onChange={(e) => set({ clientId: e.target.value })}>
                    <option value="">— Select —</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Combo>
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
                  ? <div className="notice">Agreement is Active — this job goes live and is posted when you press Save & Post.</div>
                  : (
                    <div className="notice amber">
                      <div>
                        {'The service agreement with '}
                        <b>{selectedClient.name}</b>
                        {' is '}
                        <b>{agreementStatusLabel(selectedClient.agreementStatus)}</b>
                        {', so this job cannot go live or be posted yet. You can still save it: Save & Post keeps it at '}
                        <b>Agreement Check</b>
                        {'; Save Draft keeps it as a Draft.'}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        {canRunAgreement
                          ? `To make it live: Clients → ${selectedClient.name} → Agreement tab → Generate / Send to Client → the client signs → Activate Agreement. The job then opens and posts by itself.`
                          : clientDesk
                            ? `An Admin must complete the agreement (Clients → ${selectedClient.name} → Agreement tab). The job then opens and posts by itself.`
                            : `Ask the BDE or an Admin who owns ${selectedClient.name} to complete the agreement. The job then opens and posts by itself.`}
                      </div>
                    </div>
                  )
              )}
            </>
          )}

          <SectionHead>C. Job Description</SectionHead>
          <label className={`field${ff('jobDescription')}`}>
            <span>Full Job Description *{ft('jobDescription')}</span>
            <textarea rows="3" value={form.jobDescription} onChange={(e) => set({ jobDescription: e.target.value })} />
          </label>
          <label className={`field${ff('responsibilities')}`}>
            <span>Responsibilities{ft('responsibilities')}</span>
            <textarea rows="2" placeholder="One per line" value={form.responsibilities} onChange={(e) => set({ responsibilities: e.target.value })} />
          </label>
          <label className={`field${ff('qualifications')}`}>
            <span>Qualifications{ft('qualifications')}</span>
            <textarea rows="2" value={form.qualifications} onChange={(e) => set({ qualifications: e.target.value })} />
          </label>
          <div className="grid-2">
            <label className={`field${ff('education')}`}>
              <span>Education{ft('education')}</span>
              <Combo creatable value={form.education} onChange={(e) => set({ education: e.target.value })}>
                {EDUCATION_LEVELS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('skills')}`}>
              <span>Mandatory Skills * (comma separated){ft('skills')}</span>
              <input value={form.skills} placeholder="Java, Spring Boot, SQL" onChange={(e) => set({ skills: e.target.value })} />
            </label>
          </div>
          <label className={`field${ff('goodToHaveSkills')}`}>
            <span>Good-to-have Skills (comma separated){ft('goodToHaveSkills')}</span>
            <input value={form.goodToHaveSkills} placeholder="AWS, Docker" onChange={(e) => set({ goodToHaveSkills: e.target.value })} />
          </label>

          <SectionHead>D. Job Conditions</SectionHead>
          <div className="grid-2">
            <label className={`field${ff('employmentType')}`}>
              <span>Employment Type *{ft('employmentType')}</span>
              <Combo value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('workMode')}`}>
              <span>Work Mode *{ft('workMode')}</span>
              <Combo value={form.workMode} onChange={(e) => set({ workMode: e.target.value })}>
                {WORK_MODES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('location')}`}>
              <span>Work Location *{ft('location')}</span>
              <Combo creatable value={form.location} onChange={(e) => set({ location: e.target.value })}>
                {LOCS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Preferred Location</span>
              <Combo value={form.preferredLocation} onChange={(e) => set({ preferredLocation: e.target.value })}>
                <option value="">Any</option>
                {LOCS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('expMin')}`}>
              <span>Minimum Experience (yrs) *{ft('expMin')}</span>
              <input type="number" min="0" value={form.expMin} onChange={(e) => set({ expMin: e.target.value })} />
            </label>
            <label className={`field${ff('expMax')}`}>
              <span>Maximum Experience (yrs){ft('expMax')}</span>
              <input type="number" min="0" value={form.expMax} onChange={(e) => set({ expMax: e.target.value })} />
            </label>
            <label className="field">
              <span>Relevant Experience (yrs)</span>
              <input type="number" min="0" value={form.relevantExperience} onChange={(e) => set({ relevantExperience: e.target.value })} />
            </label>
            <label className="field">
              <span>Joining Timeline *</span>
              <Combo value={form.joiningTimeline} onChange={(e) => set({ joiningTimeline: e.target.value })}>
                {JOINING_TIMELINES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('noticePeriodMax')}`}>
              <span>Maximum notice period{ft('noticePeriodMax')}<Help text="The longest time a person may still have to serve at their current company before joining. Example: 30 Days = they can join within a month." /></span>
              <Combo value={form.noticePeriodMax} onChange={(e) => set({ noticePeriodMax: e.target.value })}>
                {NOTICE_PERIODS_MAX.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Job Preference</span>
              <Combo value={form.jobPreference} onChange={(e) => set({ jobPreference: e.target.value })}>
                {JOB_PREFERENCES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
          </div>

          <SectionHead>E. Compensation</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Salary type<Help text="CTC = Cost To Company: the full yearly pay including bonus and benefits, before tax. Annual CTC is the usual choice." /></span>
              <Combo value={form.salaryType} onChange={(e) => set({ salaryType: e.target.value })}>
                {SALARY_TYPES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Currency</span>
              <Combo value={form.currency} onChange={(e) => set({ currency: e.target.value })}>
                {CURRENCIES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('salaryMin')}`}>
              <span>Minimum salary (₹ lakh per year){ft('salaryMin')}<Help text="In lakh rupees a year (CTC). 6 = ₹6,00,000 a year." /></span>
              <input type="number" step="0.5" placeholder="10" value={form.salaryMin} onChange={(e) => set({ salaryMin: e.target.value })} />
            </label>
            <label className={`field${ff('salaryMax')}`}>
              <span>Maximum salary (₹ lakh per year){ft('salaryMax')}</span>
              <input type="number" step="0.5" placeholder="15" value={form.salaryMax} onChange={(e) => set({ salaryMax: e.target.value })} />
            </label>
          </div>

          <SectionHead>F. Assignment</SectionHead>
          {editing && !canAssign && (
            <div className="notice amber">
              The assignment chain decides who can SEE this job, so changing it needs the
              {' '}
              <b>assign</b>
              {' '}
              permission rather than edit. These fields are read-only for you, and the server refuses the
              change as well — this is not a hidden button. Ask a TL or an admin to re-assign it.
            </div>
          )}
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            Job → Team lead → Recruiter(s) → Client manager (BDE) → Client. This chain is what decides who
            can see this job: a recruiter sees the ones assigned to them, a TL the ones they lead,
            a BDE their clients&apos;.
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Assigned to (Team lead)</span>
              <Combo
                disabled={lockAssign}
                value={form.tlId}
                onChange={(e) => pickTl(e.target.value)}
              >
                <option value="">{tlChoices.length ? '— Pick a team lead —' : 'No team lead yet'}</option>
                {TlOptions({ tls: tlChoices, first: form.department, keep: form.tlId ? { id: form.tlId, name: form.tl } : null })}
              </Combo>
              <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                {editing
                  ? 'Any department\'s team lead can take this job. It stays a ' + (form.department || '') + ' job.'
                  : 'Any department\'s team lead can take this job. The team lead picks the recruiters after it is saved.'}
              </div>
            </label>
            {editing && (
            <label className="field">
              <span>Recruiter · least busy first</span>
              <Combo disabled={lockAssign} value={form.recruiterId} onChange={(e) => set({ recruiterId: e.target.value })}>
                <option value="">{bench === null && !lockAssign ? 'Loading…' : '— Not assigned —'}</option>
                {bench
                  ? RecruiterOptions({ groups: bench.groups, keep: keepRecruiters })
                  : recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Combo>
            </label>
            )}
            <label className="field">
              <span>STL</span>
              <Combo
                disabled={lockAssign}
                value={form.stlId}
                onChange={(e) => set({ stlId: e.target.value, stl: stls.find((t) => t.id === e.target.value)?.name || '' })}
              >
                <option value="">— None —</option>
                {stls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Combo>
            </label>
            {!internal && (
              <label className="field">
                <span>BDE</span>
                <Combo disabled={lockAssign} value={form.bdeId} onChange={(e) => set({ bdeId: e.target.value })}>
                  <option value="">— Not assigned —</option>
                  {bdes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Combo>
              </label>
            )}
            <label className="field">
              <span>Account Manager / BDE owner</span>
              <input
                disabled={lockAssign}
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
          {editing && (
          <div className="field">
            <span>Co-recruiters (a job can have more than one)</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
              {recruiters.filter((r) => r.id !== form.recruiterId).map((r) => (
                <label key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    disabled={lockAssign}
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
          )}

          <SectionHead>G. Where to post</SectionHead>
          <div className="field">
            <span>Tick where this job should appear. We post it for you.</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {(sources || OWN_SITES.map((name) => ({ id: name, name, source: name, ready: true }))).map((src) => {
                const off = src.id === 'google' && internal;
                return (
                  <label key={src.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontWeight: 400, fontSize: 12.5, opacity: src.ready && !off ? 1 : 0.65 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      disabled={off}
                      checked={!off && form.postingSources.includes(src.source)}
                      onChange={() => togglePostingSource(src.source)}
                    />
                    <b style={{ fontWeight: 600 }}>{src.name}</b>
                    {off && <span className="cell-muted">Not for TeamLink internal jobs</span>}
                    {!off && src.ready && <span className="cell-muted">{src.readyText || 'Posts automatically'}</span>}
                    {!off && !src.ready && (
                      <span className="cell-muted">
                        {src.setupLink
                          ? <Link to={src.setupLink} target="_blank" rel="noreferrer">Needs account setup →</Link>
                          : 'Needs account setup'}
                        {src.hint ? <span style={{ display: 'block', whiteSpace: 'pre-line' }}>{src.hint}</span> : ''}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="cell-muted" style={{ fontSize: 11.5 }}>
            After Save &amp; Post, the job page shows each site: Posted, Posting…, Failed (with Retry) or Needs account setup.
            Save Draft posts nothing.
          </div>

        </Modal>
  );
}
