import { useMemo, useState } from 'react';
import api from '../api';
import Modal, { SectionHead } from './Modal.jsx';
import Combo from './Combo.jsx';
import {
  DEPTS, LOCS, PRIORITIES, REQUIREMENT_TYPES, EDUCATION_LEVELS, EMPLOYMENT_TYPES, WORK_MODES,
  JOINING_TIMELINES, NOTICE_PERIODS_MAX, JOB_PREFERENCES, SALARY_TYPES, CURRENCIES,
  POSTING_SOURCES, requirementStatusLabel,
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
};

const listOf = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  return [nums[0], nums[1] !== undefined ? nums[1] : ''];
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
  };
}

export default function RequirementForm({
  mode = 'create',
  requirement = null,
  clients = [],
  team = [],
  canAssign = true,
  onClose,
  onSaved,
}) {
  const editing = mode === 'edit';
  const [form, setForm] = useState(() => (editing ? formFromRequirement(requirement) : { ...EMPTY }));
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const internal = form.type === 'Internal Requirement';
  // Section F is locked only on an EDIT the user may not re-assign. Creating
  // a requirement is where the chain is first set, and `create` carries it.
  const lockAssign = editing && !canAssign;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const selectedClient = clients.find((c) => c.id === form.clientId);
  const roleOf = (t) => t.atsRole || t.role;
  const recruiters = useMemo(() => team.filter((t) => roleOf(t) === 'RECRUITER'), [team]);
  const bdes = useMemo(() => team.filter((t) => roleOf(t) === 'BDE'), [team]);
  const tls = useMemo(() => team.filter((t) => roleOf(t) === 'TL'), [team]);
  const stls = useMemo(() => team.filter((t) => roleOf(t) === 'STL'), [team]);

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
      salary: form.salaryMin && form.salaryMax ? `₹${form.salaryMin}L - ₹${form.salaryMax}L` : '—',
      bdeId: internal ? '' : form.bdeId,
      description: form.jobDescription,
      postingSources: form.postingSources.join(', '),
    };
  }

  async function save(kind) {
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/requirements', payload(kind === 'draft' ? 'DRAFT' : 'OPEN'));
      onSaved?.(res.data, { created: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this requirement');
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    setError('');
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
      const res = await api.put(`/requirements/${requirement.id}`, body);
      onSaved?.(res.data, { created: false, changedFields: res.data?.changedFields || [] });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this requirement');
    } finally {
      setSaving(false);
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
    );
  }

  return (
      <Modal
        title={editing ? `Edit Requirement — ${requirement.reqCode || requirement.title}` : 'Create Requirement'}
        size="xwide"
        onClose={onClose}
        footer={editing ? (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn" onClick={() => setPreview(true)}>Preview</button>
            <button className="btn btn-primary" disabled={saving} onClick={saveEdit}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
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
              <input disabled value={editing ? (requirement.reqCode || requirement.id) : 'Assigned automatically on save'} />
            </label>
            <label className="field">
              <span>Requirement Type *</span>
              <Combo value={form.type} disabled={editing} onChange={(e) => set({ type: e.target.value })}>
                {REQUIREMENT_TYPES.map((t) => <option key={t}>{t}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Job Title *</span>
              <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Senior Java Developer" />
            </label>
            <label className="field">
              <span>Department *</span>
              <Combo creatable value={form.department} onChange={(e) => set({ department: e.target.value })}>
                {DEPTS.map((d) => <option key={d}>{d}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Number of Openings *</span>
              <input type="number" min="1" value={form.openings} onChange={(e) => set({ openings: e.target.value })} />
            </label>
            <label className="field">
              <span>Priority *</span>
              <Combo value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Requirement Status</span>
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
                <label className="field">
                  <span>Client *</span>
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
              <Combo creatable value={form.education} onChange={(e) => set({ education: e.target.value })}>
                {EDUCATION_LEVELS.map((x) => <option key={x}>{x}</option>)}
              </Combo>
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
              <Combo value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Work Mode *</span>
              <Combo value={form.workMode} onChange={(e) => set({ workMode: e.target.value })}>
                {WORK_MODES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Work Location *</span>
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
              <Combo value={form.joiningTimeline} onChange={(e) => set({ joiningTimeline: e.target.value })}>
                {JOINING_TIMELINES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Maximum Notice Period</span>
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
              <span>Salary Type</span>
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
          {editing && !canAssign && (
            <div className="notice amber">
              The assignment chain decides who can SEE this requirement, so changing it needs the
              {' '}
              <b>assign</b>
              {' '}
              permission rather than edit. These fields are read-only for you, and the server refuses the
              change as well — this is not a hidden button. Ask a TL or an admin to re-assign it.
            </div>
          )}
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            Requirement → Assigned TL → Assigned Recruiter(s) → BDE → Client. This chain is what decides who
            can see this requirement: a recruiter sees the ones assigned to them, a TL the ones they lead,
            a BDE their clients&apos;.
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Assigned TL</span>
              <Combo
                disabled={lockAssign}
                value={form.tlId}
                onChange={(e) => set({ tlId: e.target.value, tl: tls.find((t) => t.id === e.target.value)?.name || '' })}
              >
                <option value="">— Not assigned —</option>
                {tls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Assigned Recruiter *</span>
              <Combo disabled={lockAssign} value={form.recruiterId} onChange={(e) => set({ recruiterId: e.target.value })}>
                <option value="">— Not assigned —</option>
                {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Combo>
            </label>
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
          <div className="field">
            <span>Co-recruiters (a requirement can carry more than one)</span>
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
  );
}
