import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal, { SectionHead } from './Modal.jsx';
import Combo from './Combo.jsx';
import { useJobLocations } from './jobs/jobLocations.js';
import LocationPicker from './jobs/LocationPicker.jsx'; // places: list + Remote / Any + "Other (type it)" (2026-10-14)
import ComboOther from './jobs/ComboOther.jsx'; // a dropdown whose "Other" opens a text box (2026-10-14)
import TlChecklist from './jobs/TlChecklist.jsx'; // several team leads as checkboxes (2026-10-14)
import { Help } from './ui/Guide.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { can, productRole } from '../permissions';
import { PRIORITY_CHOICES, priorityLabel } from './jobs/reqFormat.jsx';
import {
  RecruiterMulti, useAllTls, useRecruiterBench, benchPeople,
} from './jobs/assignPeople.jsx';
import SpecPicker from './SpecPicker.jsx'; // spec D: Qualification + Specialization (Admin master)
// B9.1 / B9.4 (ATS-100): duplicate-job warning with "Create anyway", and job templates.
import DuplicateJobWarning from './jobs/DuplicateJobWarning.jsx';
import JobTemplates from './jobs/JobTemplates.jsx';
// 2026-10-14: a NORMAL single-column form (the side preview is gone); the text is still prepared in the background for Save & Post
import ReqSection from './jobs/reqsplit/ReqSection.jsx';
import PostStep, { placesFromSources } from './jobs/reqsplit/PostStep.jsx';
import { useLiveTemplate, templateFields } from './jobs/reqsplit/liveTemplate.js';
import './clients/clientForm.css';
import './clients/addClientModal.css';
import './jobs/reqsplit/reqsplit.css';
import './jobs/postingChoices.css'; // Save & Post: the six sites and what each one does (2026-10-10)
// docfill_: "Upload the requirement" / "Type it myself" (components/ui/FillFromFile.jsx).
import { useFillFromFile, FillEntryModal, FillBanner } from './ui/FillFromFile.jsx';
import { jobFieldsToForm, JOB_FIELD_NAMES } from './ui/fillMaps.js';
import { useActiveDepartments, keepActive } from '../utils/activeDepartments.js';
import useClientLabel from './clients/useClientLabel.js'; // one company, many locations: "Name - Location" for same-name clients (2026-10-22)
import {
  DEPTS, deptOptions, LOCS, PRIORITIES, REQUIREMENT_TYPES, EDUCATION_LEVELS, EMPLOYMENT_TYPES, WORK_MODES,
  JOINING_TIMELINES, NOTICE_PERIODS_MAX, JOB_PREFERENCES, SALARY_TYPES, CURRENCIES,
  agreementStatusLabel, agreementIsActive,
  deptLabel,
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
  departments: [DEPTS[0]], // 2026-10-13: a job can be in several departments; the first one is the MAIN one (= department)
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
  preferredLocation: '', // stored as "Hyderabad, Pune" / "Remote" / "Any"; picked from the location list
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
  tlIds: [], // SEVERAL TEAM LEADS (2026-10-14): [main, also assigned...]; tlId always mirrors the first
  stlId: '',
  tl: '',
  stl: '',
  targetDate: '',
  accountManager: '',
  postingSources: [],
  // spec D: master Qualification / Specialization ids (Administration -> Master lists).
  qualificationId: '',
  specialisationId: '',
  // typed when the list had no match (2026-10-14)
  qualificationCustom: '',
  specialisationCustom: '',
};

const listOf = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// Our own sites, ticked by default on a new job (they post at once). The usual set the Admin chose
// (and the four boards, by default) replaces this when the site list arrives from the server.
const OWN_SITES = ['TeamLink Job Portal', 'TeamLink Website', 'Google Jobs'];
// Internal TeamLink hiring stays on our own two sites; Google Jobs rides along with the Website.
const INTERNAL_SITES = ['TeamLink Job Portal', 'TeamLink Website'];
const SITE_NAME = { jobportal: 'Job Portal', website: 'Website' };

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
// 2026-10-13: NO red asterisks. A missing answer is said in plain words ("Please add the job title.") and the field and its
// section turn red. The array carries `.fields` (the form keys that are missing) for the red highlight.
export function formProblems(form, { kind, internal, editing }) {
  const out = [];
  const fields = [];
  const bad = (field, text) => { out.push(text); fields.push(field); };
  const blank = (v) => !String(v ?? '').trim();
  if (blank(form.title)) bad('title', 'Please add the requirement title.');
  if (blank(form.department) && !(form.departments || []).length) bad('department', 'Please pick at least one department.');
  const openings = Number(form.openings);
  if (!Number.isInteger(openings) || openings < 1 || openings > 999) bad('openings', 'Please enter how many people are needed (1 to 999).');
  if (!editing && !internal && !form.clientId) bad('clientId', 'Please pick the client (or choose a TeamLink requirement).');
  if (blank(form.priority)) bad('priority', 'Please pick how urgent the requirement is.');
  // The answers a live job needs (a draft may skip the job details).
  if (kind !== 'draft') {
    if (blank(form.jobDescription)) bad('jobDescription', 'Please write the job description.');
    if (blank(form.skills)) bad('skills', 'Please add at least one must-have skill.');
    if (blank(form.employmentType)) bad('employmentType', 'Please pick the employment type.');
    if (blank(form.workMode)) bad('workMode', 'Please pick the work mode.');
    if (blank(form.location)) bad('location', 'Please add the work location.');
    if (blank(form.expMin) || Number(form.expMin) < 0) bad('expMin', 'Please add the minimum experience.');
    if (blank(form.joiningTimeline)) bad('joiningTimeline', 'Please pick when the person should join.');
  }
  const min = Number(form.expMin); const max = Number(form.expMax);
  if (form.expMin !== '' && form.expMax !== '' && min > max) bad('expMin', 'Minimum experience can not be more than maximum.');
  const sMin = Number(form.salaryMin); const sMax = Number(form.salaryMax);
  if (form.salaryMin !== '' && form.salaryMax !== '' && sMin > sMax) bad('salaryMin', 'Minimum salary can not be more than maximum.');
  if (!editing) {
    const today = new Date().toISOString().slice(0, 10);
    if (form.closingDate && form.closingDate < today) bad('closingDate', 'The closing date is in the past.');
    if (form.targetDate && form.targetDate < today) bad('targetDate', 'The target date is in the past.');
  }
  out.fields = fields;
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
    departments: (Array.isArray(r.departments) && r.departments.length ? r.departments : [r.department || EMPTY.department]),
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
    tlIds: Array.isArray(r.tlIds) && r.tlIds.length ? r.tlIds : [r.tlId, ...(r.extraTlIds || [])].filter(Boolean),
    stlId: r.stlId || '',
    tl: r.tlName || r.tl || '',
    stl: r.stlName || r.stl || '',
    targetDate: r.targetDate || '',
    accountManager: r.accountManager || '',
    postingSources: listOf(r.postingSources),
    qualificationId: r.qualificationId || '',
    specialisationId: r.specialisationId || '',
    qualificationCustom: '',
    // a typed specialization with no list entry is kept as text on the job: show it as 'Your own'
    specialisationCustom: !r.specialisationId && r.specialisation ? r.specialisation : '',
  };
}

const blankVal = (v) => !String(v ?? '').trim();
// "3 of 9 filled" for a section
function sectionStat(form, keys) {
  return { total: keys.length, filled: keys.filter((k) => !blankVal(form[k])).length };
}
// Which numbered section a missing field belongs to (so that section opens and turns red).
const SECTION_OF_FIELD = {
  skills: 'skills', salaryMin: 'pay', joiningTimeline: 'pay', targetDate: 'pay', jobDescription: 'desc',
};
const sectionOfField = (f) => SECTION_OF_FIELD[f] || 'basics';
const OWN_SITE_NAMES = ['TeamLink Job Portal', 'TeamLink Website', 'Google Jobs'];

// DEPARTMENTS AS AN OPEN CHECKLIST (founder, 2026-10-23): every department is visible with a tick, any number at once, whatever the client's own department is.
// The first ticked one is the MAIN department (its team lead is suggested first); "Make main" moves another one to the front.
function DeptChecklist({ options, value, onChange }) {
  const list = Array.isArray(value) ? value : [];
  // Only switched-on Department & Team names (founder 2026-10-28); a ticked old one stays.
  const liveDepts = useActiveDepartments();
  const toggle = (v) => onChange(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const makeMain = (v) => onChange([v, ...list.filter((x) => x !== v)]);
  return (
    <div className="rf-deptlist" role="group" aria-label="Departments" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', padding: '6px 2px' }}>
      {keepActive(liveDepts, options, (o) => o.value, list).map((o) => {
        const on = list.includes(o.value);
        return (
          <label key={o.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={on} onChange={() => toggle(o.value)} style={{ width: 'auto' }} />
            <span>{o.label}</span>
            {on && list[0] === o.value && <span className="small-muted">(main)</span>}
            {on && list[0] !== o.value && <button type="button" className="link-btn" onClick={(e) => { e.preventDefault(); makeMain(o.value); }}>make main</button>}
          </label>
        );
      })}
    </div>
  );
}

export default function RequirementForm({
  mode = 'create',
  requirement = null,
  clients = [],
  team = [],
  canAssign = true,
  // A client's new job request (Draft): this login may also OPEN it, so the form
  // offers "Save & Post" (save, open, post on the ticked sites) - 2026-10-09.
  canOpen = false,
  // FULL EDIT (founder, 2026-10-16): Super Admin / Admin and the BDE team may change every field of a job at any stage, the
  // client and the job type included. The server decides (permissions.fullEdit) and checks it again on save.
  canFullEdit = false,
  // ?new=1&clientId= (Clients → + New Requirement) pre-selects the client.
  initialClientId = '',
  onClose,
  onSaved,
}) {
  const clientLabel = useClientLabel();
  // RAISING a requirement is scoped too: a Medical TL picks Medical, not the
  // whole company. Same server-computed list the filters use.
  const { user } = useAuth();
  // THE DEPARTMENT PICKER lists EVERY department of the company for Admin / Super Admin and the whole BDE team (a job can be worked by
  // any department); everybody else keeps the list their own scope gives them. A closed list: typing a new name creates nothing.
  const [allDepts, setAllDepts] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/requirements/department-options').then((r) => { if (live && Array.isArray(r.data?.departments) && r.data.departments.length) setAllDepts(r.data.departments); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const departments = allDepts || deptOptions(user);
  const editing = mode === 'edit';
  const atsRole = productRole(user, 'ats');
  // Agreement steps are the Admin's (clients / Agreement Lifecycle); the
  // client record is the client desk's. The gate message says who does what.
  const canRunAgreement = can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit');
  const hideAgr = !can(user, 'ats', 'clients', 'Agreement Lifecycle', 'view'); // TL / Recruiter / HR: no agreement words at all (2026-10-12)
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const mayPostJob = can(user, 'ats', 'requirements', 'Job Posting', 'edit');
  const openAndPost = editing && canOpen && !!requirement && requirement.status === 'DRAFT' && !requirement.internal;
  const [form, setForm] = useState(() => (editing
    ? (() => {
      const f = formFromRequirement(requirement);
      // A request nobody has posted yet starts with our own sites ticked, as a new job does.
      if (openAndPost && !f.postingSources.length) f.postingSources = [...OWN_SITES];
      return f;
    })()
    // EMPTY.department is DEPTS[0] ('IT'), which a Medical TL may not raise
    // for — start them on the first department they actually hold. A TL / STL
    // / BDE raising a requirement starts on its chain in their own role (the
    // server does the same), so it never vanishes from their own list.
    : {
      ...EMPTY,
      department: departments[0] || EMPTY.department,
      tlId: atsRole === 'TL' ? (user?.id || '') : '',
      tlIds: atsRole === 'TL' && user?.id ? [user.id] : [],
      tl: atsRole === 'TL' ? (user?.name || '') : '',
      stlId: atsRole === 'STL' ? (user?.id || '') : '',
      stl: atsRole === 'STL' ? (user?.name || '') : '',
      bdeId: atsRole === 'BDE' ? (user?.id || '') : '',
      clientId: initialClientId || '',
      postingSources: [...OWN_SITES],
      // HR adds TeamLink's OWN openings only (2026-10-13): client jobs are created by the client manager (BDE) team.
      ...(atsRole === 'HR' ? { type: 'Internal Requirement' } : {}),
    }));
  const [problems, setProblems] = useState([]);
  const [missingFields, setMissingFields] = useState([]); // form keys that still need an answer (shown red, no asterisks)
  const deptTouched = useRef(false); // picking a client fills the department only until the person picks one
  const places = useJobLocations(); // the Preferred location list (offices, added places, cities)
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(''); // '' | 'draft' | 'create' | 'post' | 'save'
  const [open, setOpen] = useState({ basics: true, skills: true, pay: true, desc: true, posting: false, team: false }); // like Add client: the first four open
  const [postStep, setPostStep] = useState(null); // after Save & Post: { job, initial, info }
  const seededText = useRef(null); // the text a person saved earlier (Edit job): saved again only when it changed
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
  const [canSetUsual, setCanSetUsual] = useState(false); // Admin: "Use these ticks for every new job"
  const [usualNote, setUsualNote] = useState('');
  const tickTouched = useRef(false);
  useEffect(() => {
    let on = true;
    api.get('/requirements/posting-sources')
      .then((r) => {
        if (!on) return;
        const list = r.data.sources || [];
        setSources(list);
        // A new job (or a request nobody has posted yet) starts with the usual sites ticked, boards included.
        const fresh = !editing || (openAndPost && !requirement.postingSources);
        if (fresh && !tickTouched.current && list.length) {
          setForm((f) => ({ ...f, postingSources: list.filter((s) => s.isDefault).map((s) => s.source) }));
        }
      })
      .catch(() => { if (on) setSources([]); });
    api.get('/requirements/posting/defaults').then((r) => { if (on) setCanSetUsual(!!r.data.canEdit); }).catch(() => {});
    return () => { on = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const internal = form.type === 'Internal Requirement';
  // The ready template, written as the person types (600 ms after the last key) by the same server writer the broadcast panel uses.
  const live = useLiveTemplate(templateFields(form, { internal, salary: form.salaryMin || form.salaryMax ? salaryBand(form.salaryMin, form.salaryMax) : '' }));
  const toggleSec = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const badSec = {};
  missingFields.forEach((f) => { badSec[sectionOfField(f)] = true; });
  const miss = (f) => (missingFields.includes(f) ? ' is-missing' : ''); // a field that still needs an answer turns red
  const showProblems = (found) => {
    setProblems(found);
    const fields = (found && found.fields) || [];
    setMissingFields(fields);
    if (!found.length) return;
    const first = sectionOfField(fields[0]);
    setOpen((o) => ({ ...o, ...Object.fromEntries(fields.map((f) => [sectionOfField(f), true])) }));
    setTimeout(() => document.getElementById(`rf-sec-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };
  // An edited job whose text a person already changed: show that text (marked as edited) rather than a fresh one.
  useEffect(() => {
    if (!editing || !requirement?.id) return;
    api.get(`/job-broadcast/jobs/${requirement.id}/ready-template`).then((r) => { if (r.data && r.data.edited && r.data.texts) { seededText.current = r.data.texts; live.setMany(r.data.texts); } }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // What is really stored: Google Jobs rides along with the Website; internal jobs stay on our own two sites.
  const sitesToSave = () => {
    let s = form.postingSources.filter((n) => n !== 'Google Jobs');
    if (internal) s = s.filter((n) => INTERNAL_SITES.includes(n));
    if (s.includes('TeamLink Website')) s = [...s, 'Google Jobs'];
    return s;
  };
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
  const bench = useRecruiterBench(form.tlId, !lockAssign, form.department);
  const keepRecruiters = editing ? [
    requirement?.recruiterId ? { id: requirement.recruiterId, name: requirement.recruiter?.name } : null,
    ...((requirement?.coRecruiters || []).map((c) => ({ id: c.id, name: c.name }))),
  ].filter(Boolean) : [];
  const benchList = benchPeople(bench);
  void benchList; void allRecruiters;
  // Several team leads (first = main): tlId / tl mirror the main one so everything that reads them keeps working.
  const setTeamLeads = (list) => {
    const main = list[0] || '';
    const tl = tlChoices.find((t) => t.id === main) || tls.find((t) => t.id === main);
    set({ tlIds: list, tlId: main, tl: main ? (tl?.name || (main === form.tlId ? form.tl : '') || '') : '' });
  };

  // The same body both modes send. On an edit the server drops status and
  // clientId itself, and drops the assignment fields for anyone without
  // `assign` — nothing here relies on the browser to withhold them.
  function payload(status, sitesOverride = null) {
    return {
      ...form,
      // an unchanged typed specialization is not sent again (it is already on the job)
      specialisationCustom: editing && form.specialisationCustom === (requirement?.specialisation || '') ? '' : form.specialisationCustom,
      status,
      internal,
      clientId: form.clientId,
      experience: `${form.expMin}-${form.expMax} yrs`,
      relevantExperience: `${form.relevantExperience} yrs`,
      preferredLocation: form.preferredLocation || 'Any',
      department: (form.departments && form.departments[0]) || form.department,
      departments: (form.departments && form.departments.length ? form.departments : [form.department]).filter(Boolean),
      salary: salaryBand(form.salaryMin, form.salaryMax),
      openings: Number(form.openings),
      bdeId: internal ? '' : form.bdeId,
      description: form.jobDescription,
      // Nothing ticked is stored as 'None' (empty would read as "our own sites").
      postingSources: (sitesOverride || sitesToSave()).length ? (sitesOverride || sitesToSave()).join(', ') : 'None',
    };
  }
  // Save & Post: the boards are handled one by one in the Post step (logins, switch, dry run); only our own sites go out with the save.
  const ownSites = () => sitesToSave().filter((n) => OWN_SITE_NAMES.includes(n));
  const expectLive = internal || (!!selectedClient && agreementIsActive(selectedClient.agreementStatus));


  // The ready text (written from the form in the background) is kept with the job: ready template version, marked "in use".
  // Edit it afterwards with the Edit template button in the Post step, or on the job page (Distribute tab).
  async function saveTexts(jobId, kind) {
    const must = !editing && kind !== 'draft';
    if (!live.data || !(live.editedAny || must)) return '';
    if (seededText.current && ['jobPost', 'whatsapp', 'sms', 'emailSubject', 'emailBody'].every((k) => (live.texts[k] || '') === (seededText.current[k] || ''))) return ''; // unchanged since it was loaded
    try {
      const v = await api.post(`/job-broadcast/jobs/${jobId}/ready-template`, { texts: live.texts, note: live.editedAny ? 'Edited before the requirement was saved' : 'Written from the form when the requirement was saved' });
      await api.post(`/job-broadcast/jobs/${jobId}/ready-template/use`, { version: v.data.version });
      return '';
    } catch (e) {
      if (e.response?.status === 403) return ''; // this login can not keep a text (e.g. HR): the job still has the standard text
      return e.response?.data?.error || 'The text could not be saved.';
    }
  }
  // Leaving the Post step: tell the page what happened, in one sentence.
  function finishPostStep(r, another = false) {
    const st = postStep;
    setPostStep(null);
    const posting = r && r.summary ? r.summary : 'Saved. Open the requirement to post it or to see where it is posted.';
    onSaved?.(st.job, { ...st.info, posting, openJob: false, another });
  }

  async function save(kind, extra = {}) { // kind: draft | create (saved, not posted) | post (saved, then the Post step). B9.1: extra = { duplicateOverride, duplicateReason }
    if (saving || busy.current) return;
    setError('');
    const found = formProblems(form, { kind: kind === 'draft' ? 'draft' : 'post', internal, editing: false });
    showProblems(found);
    if (found.length) return;
    busy.current = true;
    setSaving(kind);
    try {
      // 'create' saves the job live but posts nothing; 'post' sends only our own sites with the save when the job will be live at once.
      const sites = kind === 'create' ? [] : (kind === 'post' && expectLive ? ownSites() : null);
      const res = await api.post('/requirements', { ...payload(kind === 'draft' ? 'DRAFT' : 'OPEN', sites), ...extra }, { headers: { 'Idempotency-Key': onceKey.current } });
      const isLive = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].includes(res.data?.status);
      const textErr = res.data?.id ? await saveTexts(res.data.id, kind) : '';
      if (textErr) { setError(`The requirement is saved, but its text could not be saved: ${textErr} Open the requirement and use Edit template, then post it.`); return; }
      let posting = null;
      const n = sitesToSave().length;
      if (kind === 'post' && n && !isLive && res.data?.status === 'AGREEMENT_CHECK') posting = 'Will post when the agreement is Active.';
      else if (kind === 'post' && n && !isLive && hideAgr && res.data?.gateNote) posting = 'Saved. It will be posted once the requirement is live.';
      else if (kind === 'create') posting = 'Nothing was posted. Open the requirement and press Post when you are ready.';
      // docfill_: keep the uploaded requirement on the job as its source document.
      const sourceNote = await fill.attach('job', res.data?.id);
      if (sourceNote) posting = [posting, sourceNote].filter(Boolean).join(' ');
      if (kind === 'post' && isLive && res.data?.id) { setPostStep({ job: res.data, initial: placesFromSources(form.postingSources), info: { created: true } }); return; }
      onSaved?.(res.data, { created: true, posting, openJob: false });
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.code === 'DUPLICATE_JOB') { setDup({ ...err.response.data, kind }); return; } // B9.1
      setError(err.response?.data?.error || 'Could not save the requirement. Please try again.');
    } finally {
      setSaving('');
      busy.current = false;
    }
  }

  // thenOpen = open a request that is still a Draft; thenPost = then show the Post step. B9.1: extra = { duplicateOverride, duplicateReason }
  async function saveEdit(extra = {}, thenOpen = false, thenPost = false) {
    if (saving || busy.current) return;
    setError('');
    const found = formProblems(form, { kind: thenOpen || thenPost ? 'post' : (requirement?.status === 'DRAFT' ? 'draft' : 'edit'), internal, editing: true });
    showProblems(found);
    if (found.length) return;
    busy.current = true;
    setSaving(thenPost ? 'post' : 'save');
    const body = payload(undefined, thenOpen && thenPost && expectLive ? ownSites() : null);
    // Never send a field the user is not allowed to change: the server
    // refuses the whole request when an unchanged-looking assignment value
    // round-trips differently, and a refusal the user cannot act on is worse
    // than not offering the control.
    if (lockAssign) {
      ['recruiterId', 'recruiterIds', 'bdeId', 'tlId', 'tlIds', 'stlId', 'accountManager', 'tl', 'stl']
        .forEach((k) => { delete body[k]; });
    }
    delete body.status;
    if (!canFullEdit) delete body.clientId;
    // `description` is the short form of the job description and the create
    // form derives one from the other. On an edit that leaves the JD alone,
    // sending it anyway would report "Description changed" on every record
    // whose description was never separately filled in. Send it only when the JD actually moved.
    if (form.jobDescription === (requirement.jobDescription || requirement.description || '')) {
      delete body.description;
    }
    try {
      const res = await api.put(`/requirements/${requirement.id}`, { ...body, ...extra });
      let job = res.data;
      let opened = null;
      if (thenOpen) {
        // The job is saved; now open it - that is what makes it live.
        try {
          opened = await api.post(`/requirements/${requirement.id}/activate`, {});
          job = opened.data;
        } catch (err) {
          setError(`Your changes are saved, but the requirement is not open yet. ${err.response?.data?.error || 'Please try again.'}`);
          return;
        }
      }
      const textErr = await saveTexts(requirement.id, 'edit');
      if (textErr) { setError(`The requirement is saved, but its text could not be saved: ${textErr} Open the requirement and use Edit template, then post it.`); return; }
      const changedFields = res.data?.changedFields || [];
      const isLive = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].includes(job?.status);
      if (thenPost && isLive) { setPostStep({ job: { ...job, id: requirement.id, title: job.title || form.title, reqCode: job.reqCode || requirement.reqCode }, initial: placesFromSources(form.postingSources), info: { created: false, opened: !!opened, changedFields } }); return; }
      if (thenPost) { onSaved?.(job, { created: false, opened: !!opened, posting: 'Saved. It will be posted once the requirement is live.', changedFields }); return; }
      onSaved?.(job, { created: false, changedFields });
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.code === 'DUPLICATE_JOB') { setDup({ ...err.response.data, kind: 'edit' }); return; } // B9.1
      setError(err.response?.data?.error || 'Could not save the requirement. Please try again.');
    } finally {
      setSaving('');
      busy.current = false;
    }
  }

  const togglePostingSource = (name) => {
    tickTouched.current = true;
    set({
      postingSources: form.postingSources.includes(name)
        ? form.postingSources.filter((s) => s !== name)
        : [...form.postingSources, name],
    });
  };
  // The six sites shown (Google Jobs is not a seventh tick: it follows the Website).
  const siteList = (sources || OWN_SITES.slice(0, 2).map((name, i) => ({ id: i ? 'website' : 'jobportal', name, source: name, mode: 'auto', line: 'Goes out by itself.' }))).filter((s) => s.id !== 'google');
  const tickedList = sitesToSave();
  const handTicked = siteList.filter((s) => s.mode === 'hand' && tickedList.includes(s.source));
  function postingMessage() {
    const n = siteList.filter((s) => tickedList.includes(s.source)).length;
    const hand = handTicked.length;
    return hand
      ? `${n - hand} of ${n} sites go out by themselves. ${hand} for you to post by hand: ${handTicked.map((s) => s.name).join(', ')}.`
      : `Posting to ${n} site${n === 1 ? '' : 's'} now. Each site's result shows on the requirement page.`;
  }
  async function saveUsual() {
    setUsualNote('');
    try {
      const ids = siteList.filter((s) => tickedList.includes(s.source)).map((s) => s.id);
      const r = await api.put('/requirements/posting/defaults', { sites: ids });
      setUsualNote(r.data.ok || 'Saved.');
    } catch (e) { setUsualNote(e.response?.data?.error || 'Could not save that. Please try again.'); }
  }

  // docfill_: on Add, the two big choices come first; "Type it myself" or a
  // read file then shows the form below exactly as today.
  if (!editing && fill.entry !== 'form') {
    return (
      <FillEntryModal
        title="Add requirement"
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

  // ---- THE POST STEP: after Save & Post the same window shows where to post (sites, logins, results).
  if (postStep) {
    return (
      <Modal
        title={`Post this requirement — ${postStep.job.title}`}
        size="xwide acw-modal"
        onClose={() => finishPostStep()}
        footer={<div className="cf-bar"><span className="cf-bar-note">Nothing is called Posted until the site really shows the requirement.</span></div>}
      >
        <div className="acw-wrap" style={{ display: 'block', overflowY: 'auto' }}>
          <div className="acw-form" style={{ overflow: 'visible' }}>
            <PostStep job={postStep.job} initial={postStep.initial} onDone={(r) => finishPostStep(r)} onAnother={postStep.info && postStep.info.created ? (r) => finishPostStep(r, true) : null} />
          </div>
        </div>
      </Modal>
    );
  }

  const stat = (keys) => sectionStat(form, keys);
  const secProps = (id, n, title, hint, keys, required) => {
    const st = stat(keys);
    return {
      id, n, title, hint, filled: st.filled, total: st.total, done: required ? required.every((k) => !blankVal(form[k])) : false, bad: badSec[id], open: !!open[id], onToggle: toggleSec,
    };
  };
  const basicsKeys = ['title', ...(internal ? [] : ['clientId']), 'department', 'openings', 'priority', 'location', 'employmentType', 'workMode', 'expMin'];
  const sitesN = tickedList.length;
  const o = internal ? 0 : 1; // the Client section (B) is only for client jobs, so the letters after it shift

  return (
    <Modal
      title={editing ? `Edit requirement — ${requirement.reqCode || requirement.title}` : 'Add requirement'}
      size="xwide acw-modal"
      onClose={onClose}
      footer={(
        <div className="cf-bar">
          <span className="cf-bar-note">
            {editing
              ? 'Save changes keeps the requirement as it is. Save & Post also asks where to post it.'
              : 'Save for later needs only the requirement title and the client. Save & create and Save & Post also need the requirement details; anything missing turns red. Save & Post then asks where to post.'}
          </span>
          {editing ? (
            <>
              <button className="btn" type="button" onClick={onClose}>Cancel</button>
              <button className={`btn${openAndPost || !mayPostJob ? '' : ''}`} type="button" disabled={saving} onClick={() => saveEdit()} title={requirement?.status === 'DRAFT' ? 'Saves the draft. Nothing is posted.' : 'Saves the requirement. The sites it is already on are updated.'}>
                {saving === 'save' ? 'Saving…' : 'Save changes'}
              </button>
              {(openAndPost || (mayPostJob && requirement?.status !== 'DRAFT')) && (
                <button className="btn btn-primary" type="button" disabled={saving} onClick={() => saveEdit({}, openAndPost, true)} title="Saves the requirement and its text, then lets you choose the sites and post.">
                  {saving === 'post' ? 'Saving…' : 'Save & Post'}
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn" type="button" disabled={!!saving} onClick={onClose}>Cancel</button>
              <button className="btn" type="button" disabled={!!saving} onClick={() => save('draft')} title="Keeps the requirement without opening it: nothing is live or posted yet">{saving === 'draft' ? 'Saving…' : 'Save for later'}</button>
              <button className="btn" type="button" disabled={!!saving} onClick={() => save('create')} title="Saves the requirement and its text. Nothing is posted yet.">{saving === 'create' ? 'Saving…' : 'Save & create'}</button>
              <button className="btn btn-primary" type="button" disabled={!!saving} onClick={() => save('post')} title="Saves the requirement and its text, then asks where to post it.">{saving === 'post' ? 'Saving…' : 'Save & Post'}</button>
            </>
          )}
        </div>
      )}
    >
      {/* B9.1: the same client already has this job open — show it, "Create anyway" needs a reason. */}
      <DuplicateJobWarning dup={dup} editing={editing} onCancel={() => setDup(null)} onCreateAnyway={(reason) => { const k = dup.kind; setDup(null); if (k === 'edit') saveEdit({ duplicateOverride: true, duplicateReason: reason }); else save(k, { duplicateOverride: true, duplicateReason: reason }); }} />
      <div className="acw-wrap rf-wrap rf-one">
        <div className="acw-form">
          {!editing && <FillBanner fill={fill} names={JOB_FIELD_NAMES} />}
          {clientSuggest && (
            <div className="notice amber">
              <span>
                {'The file names the client '}
                <b>{clientSuggest}</b>
                {', which is not in your client list. Add the client first (Clients → Add client), then pick it in section 1 — or pick the right client below.'}
              </span>
            </div>
          )}
          {/* B9.4: "Start from a template" / "Save as template" (components/jobs/JobTemplates.jsx) — Add job only. */}
          {!editing && <JobTemplates form={form} toForm={formFromRequirement} payload={() => payload('DRAFT')} onApply={set} onSaved={() => {}} />}
          <div className="cf">
            <ReqSection {...secProps('basics', 1, 'Basic Information', '', basicsKeys, basicsKeys.filter((k) => k !== 'priority'))}>
              <div className="grid-2">
                <label className="field">
                  <span>Requirement ID</span>
                  <input disabled value={editing ? (requirement.reqCode || requirement.id) : 'Assigned automatically on save'} />
                </label>
                <label className="field">
                  <span>Requirement type</span>
                  <Combo value={form.type} disabled={(editing && !canFullEdit) || atsRole === 'HR'} onChange={(e) => set({ type: e.target.value })}>
                    {REQUIREMENT_TYPES.filter((t) => atsRole !== 'HR' || t === 'Internal Requirement').map((t) => <option key={t} value={t}>{t}</option>)}
                  </Combo>
                </label>
                <label className={`field${ff('title')}${miss('title')}`} id="rf-title">
                  <span>Requirement title{ft('title')}</span>
                  <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Senior Java Developer" />
                  {miss('title') && <div className="rf-missing-note">Please add the requirement title.</div>}
                </label>
                <div className={`field${ff('department')}${miss('department')}`}>
                  <span>Departments{ft('department')}<Help text="Pick every department that can work on this requirement. The first one is the main one; its team lead is suggested first. Any department's team lead can still take the requirement." /></span>
                  <DeptChecklist
                    options={departments.map((d) => ({ value: d, label: deptLabel(d) }))}
                    value={form.departments || []}
                    onChange={(list) => {
                      deptTouched.current = true;
                      const department = list[0] || '';
                      // The chosen TL stays: a job may go to any department's TL (2026-10-05).
                      set({
                        departments: list,
                        department,
                        // spec D: the qualification / specialization belong to the MAIN department.
                        ...(department !== form.department ? { qualificationId: '', specialisationId: '', qualificationCustom: '', specialisationCustom: '' } : {}),
                      });
                    }}
                  />
                  {miss('department') && <div className="rf-missing-note">Please pick at least one department.</div>}
                </div>
                <SpecPicker
                  wrapClass={null}
                  department={form.department}
                  qualificationId={form.qualificationId}
                  specialisationId={form.specialisationId}
                  qualificationCustom={form.qualificationCustom}
                  specialisationCustom={form.specialisationCustom}
                  canAdd={!!places.canAdd}
                  oldValue={editing ? requirement?.specialisation || '' : ''}
                  onChange={(v) => set(v)}
                />
                <label className={`field${ff('openings')}${miss('openings')}`}>
                  <span>Number of openings{ft('openings')}<Help text="How many people the client wants for this requirement. 3 openings = 3 people can join." /></span>
                  <input type="number" min="1" value={form.openings} onChange={(e) => set({ openings: e.target.value })} />
                </label>
                <label className="field">
                  <span>Priority</span>
                  <Combo value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                    {/* Stored values unchanged; "Urgent" reads Critical (review #2 §6). */}
                    {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_CHOICES.find((c) => c.value === p)?.label || p}</option>)}
                  </Combo>
                </label>
                <label className="field">
                  <span>Requirement status</span>
                  <input disabled value={editing ? (requirement.status === 'CLOSED' ? 'Closed' : requirement.status === 'DRAFT' ? 'Open (not live yet)' : 'Open') : 'Open (not live yet)'} />
                </label>
                <label className="field">
                  <span>Closing Date</span>
                  <input type="date" value={form.closingDate} onChange={(e) => set({ closingDate: e.target.value })} />
                </label>
              </div>

            </ReqSection>

            {!internal && (
              <ReqSection {...secProps('client', 2, 'Client & Contact', '', [], [])}>
                <>
                  <div className="grid-2">
                    <label className={`field${clientMark}${miss('clientId')}`} id="rf-client">
                      <span>Client{clientTag}</span>
                      <Combo
                        value={form.clientId}
                        disabled={editing && !canFullEdit}
                        onChange={(e) => {
                          const clientId = e.target.value;
                          const c = clients.find((x) => x.id === clientId);
                          // The client's own department fills the department - until the person has picked one themselves.
                          const own = c && c.ownerDepartment && departments.includes(c.ownerDepartment) ? c.ownerDepartment : '';
                          set({ clientId, ...(!editing && own && !deptTouched.current ? { department: own, departments: [own], qualificationId: '', specialisationId: '', qualificationCustom: '', specialisationCustom: '' } : {}) });
                        }}
                      >
                        <option value="">— Select —</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
                      </Combo>
                      {miss('clientId') && <div className="rf-missing-note">Please pick the client.</div>}
                      {editing && canFullEdit && <div className="small-muted" style={{ fontSize: 12 }}>You can change the client. People already added keep their step. A requirement that has an invoice cannot change client.</div>}
                    </label>
                    {!hideAgr && (
                      <>
                        <label className="field">
                          <span>Agreement</span>
                          <input disabled readOnly placeholder="Pick the client first" value={selectedClient?.agreementId || (selectedClient ? 'Not raised yet' : '')} />
                        </label>
                        <label className="field">
                          <span>Agreement Status</span>
                          <input disabled readOnly placeholder="Pick the client first" value={selectedClient ? agreementStatusLabel(selectedClient.agreementStatus) : ''} />
                        </label>
                      </>
                    )}
                    <label className="field">
                      <span>Client Contact</span>
                      <input
                        disabled
                        readOnly
                        placeholder="Pick the client first"
                        value={selectedClient
                          ? [selectedClient.contactName, selectedClient.contactPhone].filter(Boolean).join(' · ') || '—'
                          : ''}
                      />
                    </label>
                  </div>
                  {selectedClient && !hideAgr && (
                    agreementIsActive(selectedClient.agreementStatus)
                      ? <div className="notice">Agreement is Active — this requirement goes live and is posted when you press Save &amp; Post.</div>
                      : (
                        <div className="notice amber">
                          <div>
                            {'The service agreement with '}
                            <b>{selectedClient.name}</b>
                            {' is '}
                            <b>{agreementStatusLabel(selectedClient.agreementStatus)}</b>
                            {', so this requirement cannot go live or be posted yet. You can still save it. It stays Open and waits, and goes live by itself when the agreement is Active.'}
                          </div>
                          <div style={{ marginTop: 6 }}>
                            {canRunAgreement
                              ? `To make it live: Clients → ${selectedClient.name} → Agreement tab → Generate / Send to Client → the client signs → Activate Agreement. The requirement then opens and posts by itself.`
                              : clientDesk
                                ? `An Admin must complete the agreement (Clients → ${selectedClient.name} → Agreement tab). The requirement then opens and posts by itself.`
                                : `Ask the BDE or an Admin who owns ${selectedClient.name} to complete the agreement. The requirement then opens and posts by itself.`}
                          </div>
                        </div>
                      )
                  )}
                </>
              </ReqSection>
            )}

            <ReqSection {...secProps('place', 2 + o, 'Location & Employment Details', '', [], [])}>
              <div className="grid-2">
                <label className={`field${ff('employmentType')}${miss('employmentType')}`}>
                  <span>Employment type{ft('employmentType')}</span>
                  <ComboOther value={form.employmentType} options={EMPLOYMENT_TYPES} onChange={(v) => set({ employmentType: v })} customLabel={places.canAdd ? 'Add' : 'Use'} />
                </label>
                <label className={`field${ff('workMode')}${miss('workMode')}`}>
                  <span>Work mode{ft('workMode')}</span>
                  <Combo value={form.workMode} onChange={(e) => set({ workMode: e.target.value })}>
                    {WORK_MODES.map((x) => <option key={x}>{x}</option>)}
                  </Combo>
                </label>
                <div className={`field${ff('location')}${miss('location')}`}>
                  <span>Work location{ft('location')}<Help text="The one place where the person will work. Type letters to find it. Not in the list? Choose Other (type it) at the end." /></span>
                  <LocationPicker single places={places} value={form.location} onChange={(v) => set({ location: v })} />
                  {miss('location') && <div className="rf-missing-note">Please add the work location.</div>}
                </div>
                <div className="field">
                  <span>Preferred locations<Help text="Where the person may live or want to work. Pick several places, or choose Remote or Any location. Not in the list? Choose Other (type it) at the end of the list." /></span>
                  <LocationPicker places={places} value={form.preferredLocation} onChange={(v) => set({ preferredLocation: v })} />
                </div>
                <label className={`field${ff('expMin')}${miss('expMin')}`}>
                  <span>Minimum experience (years){ft('expMin')}</span>
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
              </div>
            </ReqSection>

            <ReqSection {...secProps('skills', 3 + o, 'Skills & Qualification', '', ['skills', 'education', 'goodToHaveSkills', 'qualifications'], ['skills'])}>
              <div className="grid-2">
                <label className={`field${ff('education')}`}>
                  <span>Education{ft('education')}</span>
                  <ComboOther value={form.education} options={EDUCATION_LEVELS} onChange={(v) => set({ education: v })} customLabel={places.canAdd ? 'Add' : 'Use'} />
                </label>
                <label className={`field${ff('skills')}${miss('skills')}`} id="rf-skills">
                  <span>Must-have skills (comma separated){ft('skills')}</span>
                  <input value={form.skills} placeholder="Java, Spring Boot, SQL" onChange={(e) => set({ skills: e.target.value })} />
                  {miss('skills') && <div className="rf-missing-note">Please add at least one must-have skill.</div>}
                </label>
              </div>
              <label className={`field${ff('goodToHaveSkills')}`}>
                <span>Good-to-have Skills (comma separated){ft('goodToHaveSkills')}</span>
                <input value={form.goodToHaveSkills} placeholder="AWS, Docker" onChange={(e) => set({ goodToHaveSkills: e.target.value })} />
              </label>
              <label className={`field${ff('qualifications')}`}>
                <span>Qualifications{ft('qualifications')}</span>
                <textarea rows="2" value={form.qualifications} onChange={(e) => set({ qualifications: e.target.value })} />
              </label>
            </ReqSection>

            <ReqSection {...secProps('pay', 4 + o, 'Pay & Timing', '', ['salaryMin', 'salaryMax', 'joiningTimeline', 'noticePeriodMax', 'jobPreference', 'targetDate'], ['joiningTimeline'])}>
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
                <label className={`field${miss('joiningTimeline')}`} id="rf-joining">
                  <span>Joining timeline</span>
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
                <label className="field">
                  <span>Target Date</span>
                  <input type="date" value={form.targetDate} onChange={(e) => set({ targetDate: e.target.value })} />
                </label>
              </div>
            </ReqSection>

            <ReqSection {...secProps('desc', 5 + o, 'Description & Key Responsibilities', '', ['jobDescription', 'responsibilities'], ['jobDescription'])}>
              <label className={`field${ff('jobDescription')}${miss('jobDescription')}`} id="rf-desc">
                <span>Full job description{ft('jobDescription')}</span>
                <textarea rows="5" value={form.jobDescription} onChange={(e) => set({ jobDescription: e.target.value })} />
                {miss('jobDescription') && <div className="rf-missing-note">Please write the job description.</div>}
              </label>
              <label className={`field${ff('responsibilities')}`}>
                <span>Responsibilities{ft('responsibilities')}</span>
                <textarea rows="4" placeholder="One per line" value={form.responsibilities} onChange={(e) => set({ responsibilities: e.target.value })} />
              </label>
            </ReqSection>

            <ReqSection {...secProps('team', 6 + o, 'Team & Internal Notes', '', ['tlId', 'stlId', ...(internal ? [] : ['bdeId']), 'accountManager'], [])}>
              <div className="rf-private">Only TeamLink sees this section. It is never shown on the job post.</div>
              {editing && !canAssign && (
                <div className="notice amber">Read-only for you: changing the team needs the <b>assign</b> permission. Ask a TL or an admin to re-assign it.</div>
              )}
              <div className="rf-teamhelp">Pick who works on this requirement. Leave empty to assign later.</div>
              <div className="rf-chain">
                <span>Requirement → Team lead → Recruiter → Client manager (BDE) → Client</span>
                <Help text="This chain decides who can see the requirement: a recruiter sees the requirements given to them, a team lead the ones they lead, a BDE their clients' requirements." />
              </div>
              <div className="field" id="rf-tls">
                <span>Team leads<Help text={`Any department's team leads. Tick a department to take all its team leads. The first one is the main team lead; the others see this requirement too.${editing ? ` It stays a ${form.department || ''} requirement whichever department you tick.` : ''}`} /></span>
                <TlChecklist
                  tls={allTls || tls}
                  loading={!lockAssign && allTls === null && !tls.length}
                  value={form.tlIds || []}
                  department={form.department}
                  keep={(form.tlIds || []).map((id) => ({ id, name: id === form.tlId ? form.tl : ((requirement?.extraTlNames || [])[(requirement?.extraTlIds || []).indexOf(id)] || '') }))}
                  disabled={lockAssign}
                  onChange={setTeamLeads}
                />
              </div>
              {/* A client manager (BDE) does not pick recruiters (founder, 2026-10-23): the requirement goes to the team lead, and the team lead
                  gives it to the right recruiters. Everybody else (team leads, managers, admins) keeps this field. */}
              {user?.atsRole !== 'BDE' && (
                <div className="field">
                  <span>Recruiters<Help text="Each recruiter sees the requirement and its people. The first one is the main recruiter. Least busy people are marked." /></span>
                  <RecruiterMulti
                    bench={bench}
                    keep={keepRecruiters}
                    disabled={lockAssign}
                    value={{ recruiterId: form.recruiterId, recruiterIds: form.recruiterIds }}
                    onChange={(r) => set(r)}
                  />
                </div>
              )}
              {lockAssign ? (selectedClient && ((form.stl || stls.find((t) => t.id === form.stlId)?.name || '') || form.bdeId || form.accountManager || selectedClient.accountManager) ? (
                <div className="rf-people">
                  {!internal && form.bdeId && <span>BDE: <b>{(bdes.find((x) => x.id === form.bdeId)?.bdeLabel) || bdes.find((x) => x.id === form.bdeId)?.name || '—'}</b></span>}
                  {(form.stl || stls.find((t) => t.id === form.stlId)?.name || '') && <span>STL: <b>{(form.stl || stls.find((t) => t.id === form.stlId)?.name || '')}</b></span>}
                  {(form.accountManager || selectedClient.accountManager) && <span>Account manager: <b>{form.accountManager || selectedClient.accountManager}</b></span>}
                </div>
              ) : null) : (
                <div className="grid-2">
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
                        {bdes.map((b) => <option key={b.id} value={b.id}>{b.bdeLabel || b.name}</option>)}
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
                </div>
              )}
            </ReqSection>
          </div>
          {(problems.length > 0 || error) && (
            <div className="error-text rf-errbox" role="alert">
              {problems.length > 0 && (
                <>
                  <b>{problems.length === 1 ? 'Fix this before saving:' : `Fix these ${problems.length} things before saving:`}</b>
                  <ul>{problems.map((x) => <li key={x}>{x}</li>)}</ul>
                </>
              )}
              {error && <div>{error}</div>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
