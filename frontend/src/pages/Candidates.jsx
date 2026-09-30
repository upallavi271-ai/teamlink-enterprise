import { useEffect, useMemo, useRef, useState } from 'react';
import BulkSendPanel from '../components/BulkSendPanel.jsx';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal, { SectionHead } from '../components/Modal.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import {
  STAGE_LABELS, LOCS,
  CANDIDATE_SOURCES, CANDIDATE_FIRST_SOURCES, CANDIDATE_FILTER_SOURCES, APPLICATION_METHODS,
  CANDIDATE_GENDERS, CANDIDATE_NOTICE_PERIODS, CANDIDATE_AVAILABILITY, CANDIDATE_JOB_PREFERENCES,
  CANDIDATE_EMPLOYMENT_TYPES, CANDIDATE_WORK_MODES, CANDIDATE_EDUCATION,
  protoDate, initials,
  FOLLOWUP_STATUSES,
} from '../atsVocab';
import { STAGE_GROUPS } from '../pipelineView';
import { useAuth } from '../context/AuthContext.jsx';
import {
  can, canModule, canMoveToStage, workflowStages, productRole, canSeePortalApplications,
} from '../permissions';
import Combo from '../components/Combo.jsx';
import PeopleFilter from '../components/PeopleFilter.jsx';
import HierarchyFilter, { EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy } from '../components/HierarchyFilter.jsx';
import FilterChips from '../components/FilterChips.jsx';
import AtsDataTools from '../components/AtsDataTools.jsx';
import ColumnChooser, { useStoredState } from '../components/ColumnChooser.jsx';
import CandidateDrawer from '../components/CandidateDrawer.jsx';
import CandidateBulkActions from '../components/CandidateBulkActions.jsx';
import BulkCallQueue from '../components/BulkCallQueue.jsx';
import SavedViews from '../components/SavedViews.jsx';
import CandidateDuplicatePanel from '../components/CandidateDuplicatePanel.jsx';
import JobPortalCandidates from '../components/portal/JobPortalCandidates.jsx';
import CandidateDuplicates from './CandidateDuplicates.jsx';
import MoreFilters from '../components/ui/MoreFilters.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import { nextActionsFor, ReturnDialog } from '../components/Candidate360.jsx';
import '../components/CandidatePipeline.css';
import './CandidatesViews.css';

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

// ---------------------------------------------------------------------------
// CANDIDATES & PIPELINE — ONE MODULE, THREE VIEWS (user spec 2026-09-29).
//
//   [ ATS Pipeline ]      one row per APPLICATION (candidate + requirement)
//                         already SENT TO ATS. All | Active | Hold | Selected
//                         | Joined · All | Client | Internal · the queues.
//   [ Job Portal ]        the pre-ATS screening (components/portal/
//                         JobPortalCandidates.jsx) ending in Send to ATS.
//   [ Candidate Master ]  one row per PERSON. All Candidates · Duplicates ·
//                         Inactive.
//
// URL: ?view=pipeline|job-portal|master (&sub=…). Old links keep working:
// ?view=active|all|any|hold|selected|joined land on the ATS Pipeline tab of
// that name, ?view=rejected on All + Status = Rejected.
//
// Everything is paged, filtered and COUNTED on the server (GET /candidates
// ?paged=1&view=…); the queue rules are backend/src/utils/nextAction.js —
// the same numbers the dashboard and bell use.
// ---------------------------------------------------------------------------
const EMPTY_FILTERS = {
  search: '', clientId: '', requirementId: '', bde: '', location: '', source: '',
  stage: '', status: '', followUp: '', appliedFrom: '', appliedTo: '',
  // Client | Internal (the actual workflow).
  hiring: '',
};

const MAIN_VIEWS = [
  { id: 'pipeline', label: 'ATS Pipeline', hint: 'Applications (candidate + requirement) already sent to the ATS — the recruitment process' },
  { id: 'job-portal', label: 'Job Portal', hint: 'Applications before the ATS — resume score, AI interview, recruiter review, then Send to ATS' },
  { id: 'master', label: 'Candidate Master', hint: 'One row per person, with all their applications' },
];
const PIPE_SUBS = [
  { id: 'all', label: 'All', hint: 'Every application in the ATS, any status' },
  { id: 'active', label: 'Active', hint: 'Applications still moving through the pipeline' },
  { id: 'hold', label: 'Hold', hint: 'Applications on hold' },
  { id: 'selected', label: 'Selected', hint: 'Selected, offer made or offer accepted' },
  { id: 'joined', label: 'Joined', hint: 'Joined / hired' },
];
const MASTER_SUBS = [
  { id: 'all', label: 'All Candidates', hint: 'Every person you can see — one row each, however many applications' },
  { id: 'duplicates', label: 'Duplicates', hint: 'Possible duplicate profiles — compare, then Merge or Keep Separate (never automatic)', admin: true },
  { id: 'inactive', label: 'Inactive', hint: 'No application activity in the chosen number of days' },
];
const INACTIVE_CHOICES = [90, 180, 365];

// The queues (spec §5-§7). Ids kept for old links; labels are the spec's.
const QUICK = [
  ['my_pending', 'Needs Action'],
  ['overdue', 'Overdue'],
  ['due_today', 'Due Today'],
  ['new', 'New / Unreviewed'],
  ['client_feedback', 'Client Feedback Pending'],
  ['my_candidates', 'My Candidates'],
  ['today_interviews', "Today's Interviews"],
];
const QUICK_GROUPS = [['my_pending', 'overdue', 'due_today'], ['new', 'client_feedback'], ['my_candidates', 'today_interviews']];

// ATS Pipeline columns: Candidate | Requirement | Client | Stage | Owner |
// Next Action | Due by default; the rest optional under Columns ⚙.
const COLUMNS = [
  { id: 'candidate', label: 'Candidate', locked: true },
  { id: 'requirement', label: 'Requirement' },
  { id: 'client', label: 'Client' },
  { id: 'stage', label: 'Stage', sort: 'stage' },
  { id: 'owner', label: 'Owner' },
  { id: 'next', label: 'Next Action' },
  { id: 'due', label: 'Due', sort: 'due' },
  { id: 'department', label: 'Department' },
  { id: 'section', label: 'Section' },
  { id: 'followup', label: 'Follow-up', sort: 'followUp' },
  { id: 'status', label: 'Status' },
  { id: 'recruiter', label: 'Recruiter' },
  { id: 'tl', label: 'TL' },
  { id: 'bde', label: 'BDE' },
  { id: 'interview', label: 'Interview', sort: 'interview' },
  { id: 'applied', label: 'Applied', sort: 'applied' },
  { id: 'activity', label: 'Last Activity', sort: 'activity' },
  { id: 'location', label: 'Location' },
  { id: 'source', label: 'Source' },
  { id: 'phone', label: 'Phone' },
];
const DEFAULT_COLS = ['candidate', 'requirement', 'client', 'stage', 'owner', 'next', 'due'];
const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id));
// Client Feedback Pending shows its own list (spec §7).
const FEEDBACK_COLUMNS = ['candidate', 'client', 'requirement', 'ivdate', 'waiting', 'next'];
const SORT_OPTIONS = [
  ['applied', 'Applied date'], ['followUp', 'Follow-up date'], ['stage', 'Stage'],
  ['due', 'Due date'], ['interview', 'Interview date'], ['activity', 'Last activity'],
  ['created', 'Created date'], ['name', 'Name'],
];
const MASTER_SORTS = [['created', 'Added'], ['name', 'Name'], ['activity', 'Last application activity']];
// Built-in Saved Views (filters only — the server still decides what each
// login may see).
const SAVED_PRESETS = [
  { name: 'Needs Action', hint: 'Your next moves', filters: { view: 'pipeline', sub: 'all', quick: 'my_pending' } },
  { name: 'My Candidates', hint: 'On requirements you are named on', filters: { view: 'pipeline', sub: 'all', quick: 'my_candidates' } },
  { name: 'Overdue', hint: 'Due date before today', filters: { view: 'pipeline', sub: 'all', quick: 'overdue' } },
  { name: 'Client Feedback Pending', hint: 'Client interview done, no feedback recorded', filters: { view: 'pipeline', sub: 'all', quick: 'client_feedback' } },
  { name: 'Pending TL Review', hint: 'Waiting for the TL', filters: { view: 'pipeline', sub: 'active', filters: { stage: 'st:tl_review' } } },
  { name: "Today's Interviews", filters: { view: 'pipeline', sub: 'all', quick: 'today_interviews' } },
];
const PAGE_SIZES = [25, 50, 100];
const STATUS_OPTIONS = [['Active', 'Active'], ['Hold', 'Hold'], ['Rejected', 'Rejected'], ['Joined', 'Joined']];

// Which filter set a login gets. Seniors and admins see all.
function tierOf(user) {
  const r = productRole(user, 'ats');
  if (['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'HR'].includes(r)) return 'admin';
  if (r === 'TL') return 'tl';
  if (r === 'BDE') return 'bde';
  return 'recruiter';
}

const dateTime = (v) => (v
  ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');
const todayYmd = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dueLabel = (ymd) => {
  if (!ymd) return '';
  if (ymd === todayYmd()) return 'Today';
  return protoDate(ymd);
};

// Deep links (?stage= ?status= ?view= ?sub= ?followUp= ?quick= ?requirementId=).
const STATUS_VALUES = ['Active', 'Hold', 'Rejected', 'Joined', 'None'];
function normStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'on hold') return 'Hold';
  return STATUS_VALUES.find((x) => x.toLowerCase() === s) || '';
}
function stageFromUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v.startsWith('group:') || v.startsWith('stage:') || v.startsWith('st:')) return v;
  if (STAGE_GROUPS.some((g) => g.id === v)) return `group:${v}`;
  return `stage:${v.toUpperCase()}`;
}
const FOLLOWUP_ALIASES = { due: 'Due Today,Overdue', overdue: 'Overdue', today: 'Due Today', 'due today': 'Due Today', 'not set': 'Not set', upcoming: 'Upcoming' };
function followUpFromUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return FOLLOWUP_ALIASES[v.toLowerCase()] || v;
}
const LEGACY_SUB = { all: 'all', any: 'all', active: 'active', hold: 'hold', selected: 'selected', joined: 'joined' };
function fromUrl(sp, portalAllowed) {
  const followUp = followUpFromUrl(sp.get('followUp'));
  let stageFilter = stageFromUrl(sp.get('stage'));
  let status = normStatus(sp.get('status'));
  const rawView = String(sp.get('view') || '').toLowerCase();
  const rawSub = String(sp.get('sub') || sp.get('tab') || '').toLowerCase();
  let main = 'pipeline';
  let sub = '';
  if (rawView === 'job-portal' || rawView === 'jobportal') main = portalAllowed ? 'job-portal' : 'pipeline';
  else if (rawView === 'master') { main = 'master'; sub = MASTER_SUBS.some((x) => x.id === rawSub) ? rawSub : 'all'; } else if (rawView === 'rejected') { sub = 'all'; status = 'Rejected'; } else if (LEGACY_SUB[rawView]) sub = LEGACY_SUB[rawView];
  else if (rawView === 'pipeline' || !rawView) sub = PIPE_SUBS.some((x) => x.id === rawSub) ? rawSub : '';
  if (stageFilter === 'stage:REJECTED') { stageFilter = ''; status = status || 'Rejected'; }
  if (stageFilter === 'stage:HOLD') { stageFilter = ''; sub = sub || 'hold'; }
  if (status === 'None') { main = 'master'; sub = 'all'; status = ''; }
  if (main === 'pipeline' && !sub) {
    sub = stageFilter || status || followUp || sp.get('requirementId') || sp.get('clientId') || sp.get('quick') ? 'all' : 'active';
  }
  return {
    main,
    sub,
    quick: sp.get('quick') || '',
    filters: {
      ...EMPTY_FILTERS, stage: stageFilter, status, followUp, bde: sp.get('bde') || '',
      requirementId: sp.get('requirementId') || '', clientId: sp.get('clientId') || '',
      hiring: ['client', 'internal'].includes(sp.get('hiring') || sp.get('type')) ? (sp.get('hiring') || sp.get('type')) : '',
    },
    hier: {
      ...EMPTY_HIERARCHY,
      tl: sp.get('tl') || '',
      recruiter: sp.get('recruiter') || (sp.get('positionCode') ? `seat:${sp.get('positionCode')}` : ''),
    },
  };
}

export default function Candidates() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tier = tierOf(user);
  const uid = (user && user.id) || 'anon';
  const portalTab = canSeePortalApplications(user);
  const dupAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(user?.role) || ['SUPER_ADMIN', 'ADMIN'].includes(user?.atsRole);
  const initial = useMemo(() => fromUrl(searchParams, portalTab), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [requirements, setRequirements] = useState([]);
  const [form, setForm] = useState(() => (searchParams.get('add') === '1' && searchParams.get('requirementId')
    ? { ...EMPTY, requirementId: searchParams.get('requirementId') } : EMPTY));
  const [main, setMain] = useState(initial.main);
  const [pipeSub, setPipeSub] = useState(initial.main === 'pipeline' ? initial.sub : 'active');
  const [masterSub, setMasterSub] = useState(initial.main === 'master' ? initial.sub : 'all');
  const [filters, setFilters] = useState(initial.filters);
  const [hier, setHier] = useState(initial.hier);
  const [quick, setQuick] = useState(initial.quick);
  const [inactiveDays, setInactiveDays] = useStoredState(`tl.candidates.inactiveDays.${uid}`, 180, (v) => INACTIVE_CHOICES.includes(v));
  const [showForm, setShowForm] = useState(() => searchParams.get('add') === '1' && can(user, 'ats', 'candidates', 'Add Candidate', 'create'));
  const [dupe, setDupe] = useState(null);
  const [error, setError] = useState('');
  const [stageOpen, setStageOpen] = useState(false);
  const [rowFlash, setRowFlash] = useState(null);
  const [returnFor, setReturnFor] = useState(null);
  const [rowKind, setRowKind] = useState(null);
  const [rowBusy, setRowBusy] = useState('');

  const [pageSize, setPageSize] = useStoredState(`tl.candidates.pageSize.${uid}`, 25, (v) => PAGE_SIZES.includes(v));
  const [sort, setSort] = useStoredState(`tl.candidates.sort.${uid}`, { key: 'applied', dir: 'desc' },
    (v) => v && SORT_OPTIONS.some(([k]) => k === v.key));
  const [masterSort, setMasterSort] = useStoredState(`tl.candidates.msort.${uid}`, { key: 'created', dir: 'desc' },
    (v) => v && MASTER_SORTS.some(([k]) => k === v.key));
  // v3: the ATS Pipeline column set (Candidate | Requirement | Client | Stage |
  // Owner | Next Action | Due).
  const [cols, setCols] = useStoredState(`tl.candidates.cols.v3.${uid}`, DEFAULT_COLS,
    (v) => Array.isArray(v) && v.length > 0 && v.every((id) => COLUMN_IDS.has(id)));
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  // Selection (ATS Pipeline): application row id -> the facts the bulk bar
  // and call queue need ({ id: candidateId, latestApplicationId: appId, … }).
  const [selected, setSelected] = useState(() => new Map());
  const [selectNote, setSelectNote] = useState('');
  const [bulkMode, setBulkMode] = useState(null);
  const [bulkKind, setBulkKind] = useState(null);
  const [callQueue, setCallQueue] = useState(false);
  // The Candidate 360 window: { candidateId, applicationId }.
  const [drawer, setDrawer] = useState(null);

  // Keep ?view= / ?sub= in the address bar (shareable), without re-reading
  // our own write as a new deep link.
  const ownWrite = useRef(false);
  function writeUrl(nextMain, nextSub) {
    const sp = new URLSearchParams(searchParams);
    sp.set('view', nextMain);
    if (nextMain === 'job-portal') sp.delete('sub'); else sp.set('sub', nextSub);
    ['add', 'status', 'stage', 'followUp', 'quick'].forEach((k) => sp.delete(k));
    ownWrite.current = true;
    setSearchParams(sp, { replace: true });
  }
  function goMain(m) {
    setMain(m);
    setQuick('');
    setSelected(new Map());
    writeUrl(m, m === 'master' ? masterSub : pipeSub);
  }
  function goPipeSub(s) { setPipeSub(s); setQuick(''); writeUrl('pipeline', s); }
  function goMasterSub(s) { setMasterSub(s); writeUrl('master', s); }

  // React Router keeps this page mounted when only the query string changes
  // (sidebar entries, dashboard rows), so the URL is re-read here.
  const qsKey = searchParams.toString();
  const firstQs = useRef(true);
  useEffect(() => {
    if (firstQs.current) { firstQs.current = false; return; }
    if (ownWrite.current) { ownWrite.current = false; return; }
    const next = fromUrl(searchParams, portalTab);
    setMain(next.main);
    if (next.main === 'pipeline') setPipeSub(next.sub);
    if (next.main === 'master') setMasterSub(next.sub);
    setQuick(next.quick);
    setFilters(next.filters);
    setHier(next.hier);
    if (searchParams.get('add') === '1' && can(user, 'ats', 'candidates', 'Add Candidate', 'create')) {
      if (searchParams.get('requirementId')) setForm((f0) => ({ ...f0, requirementId: searchParams.get('requirementId') }));
      setShowForm(true);
    }
  }, [qsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    api.get('/requirements').then((res) => setRequirements(res.data)).catch(() => setRequirements([]));
  }, []);

  // Search waits for typing to pause.
  const [search, setSearch] = useState(filters.search);
  useEffect(() => {
    const t = setTimeout(() => setSearch(filters.search.trim()), 350);
    return () => clearTimeout(t);
  }, [filters.search]);

  const hierTree = useHierarchy();
  const baseParams = useMemo(() => {
    const master = main === 'master';
    const srt = master ? masterSort : sort;
    const p = {
      paged: '1', view: master ? 'master' : 'pipeline', sub: master ? masterSub : pipeSub, sort: srt.key, dir: srt.dir, ...toParams(hier, hierTree.data),
    };
    if (master) p.inactiveDays = String(inactiveDays);
    if (!master && quick) p.quick = quick;
    if (search) p.search = search;
    Object.entries(filters).forEach(([k, v]) => {
      if (!v || k === 'search') return;
      if (master && ['stage', 'followUp', 'status'].includes(k)) return;
      p[k] = v;
    });
    return p;
  }, [main, pipeSub, masterSub, sort, masterSort, hier, hierTree.data, quick, search, filters, inactiveDays]);
  const baseKey = JSON.stringify(baseParams);
  useEffect(() => { setPage(1); }, [baseKey, pageSize]);

  const listOn = main === 'pipeline' || (main === 'master' && masterSub !== 'duplicates');
  const seq = useRef(0);
  useEffect(() => {
    if (!listOn) return;
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    api.get('/candidates', { params: { ...baseParams, page, pageSize } })
      .then((res) => { if (mine === seq.current) { setData(res.data); setLoadError(''); } })
      .catch((err) => { if (mine === seq.current) setLoadError(err.response?.data?.error || 'The list could not be loaded.'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [baseKey, page, pageSize, tick, listOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // A response belongs to the view it was asked for — never draw master rows
  // in the pipeline table while the next page is on its way.
  const fresh = data && data.view === (main === 'master' ? 'master' : 'pipeline') ? data : null;
  const rows = (fresh && fresh.rows) || [];
  const counts = (fresh && fresh.counts) || { views: {}, subs: {}, quick: {}, stageOptions: [] };
  const viewCounts = (data && data.counts && data.counts.views) || {};
  const defs = (fresh && fresh.definitions) || {};

  // Client / requirement options, narrowed by the department picked.
  const deptRequirements = useMemo(
    () => (hier.department ? requirements.filter((r) => r.department === hier.department) : requirements),
    [requirements, hier.department],
  );
  const clientOptions = useMemo(() => {
    const seen = new Map();
    deptRequirements.forEach((r) => { if (r.client && !r.internal) seen.set(r.client.id, r.client.name); });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [deptRequirements]);
  const requirementOptions = useMemo(
    () => (filters.clientId ? deptRequirements.filter((r) => r.clientId === filters.clientId) : deptRequirements),
    [deptRequirements, filters.clientId],
  );

  // Client filter only for the client desk (SA / Admin / Manager / Asst
  // Manager / BDE); everyone else filters by requirement.
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const show = {
    client: clientDesk,
    source: tier === 'admin' || tier === 'tl',
    bde: tier !== 'recruiter' && tier !== 'bde',
  };

  // --- Selection -----------------------------------------------------------
  const itemOf = (r) => ({
    id: r.candidateId, rowId: r.id, latestApplicationId: r.id, name: r.name, phone: r.phone || null,
    requirementTitle: r.requirementTitle, clientName: r.clientName, stageLabel: r.stageDetailLabel || r.currentStageLabel,
  });
  function toggleRow(r) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id); else next.set(r.id, itemOf(r));
      return next;
    });
  }
  const pageAllOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function togglePage(on) {
    setSelected((prev) => {
      const next = new Map(prev);
      rows.forEach((r) => (on ? next.set(r.id, itemOf(r)) : next.delete(r.id)));
      return next;
    });
  }
  async function selectAllMatching() {
    setSelectNote('');
    try {
      const res = await api.get('/candidates', { params: { ...baseParams, idsOnly: '1' } });
      setSelected(new Map(res.data.items.map((x) => [x.rowId || x.latestApplicationId || x.id, x])));
      if (res.data.capped) setSelectNote(`Only the first ${res.data.items.length.toLocaleString()} of ${res.data.total.toLocaleString()} can be selected at once — narrow the filters.`);
    } catch (err) {
      setSelectNote(err.response?.data?.error || 'Could not select every match.');
    }
  }
  const clearSelection = () => { setSelected(new Map()); setSelectNote(''); };
  const selectedItems = [...selected.values()];
  const selectedCandidateIds = [...new Set(selectedItems.map((x) => x.id))];

  // What this login may do in bulk — hidden, not disabled.
  const canEditMaster = can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  const may = {
    assign: can(user, 'ats', 'recruiterbde', 'Team View', 'assign'),
    stage: workflowStages(user).some((s) => !['HOLD', 'REJECTED'].includes(s)),
    interview: canMoveToStage(user, 'INTERVIEW_SCHEDULED') && can(user, 'ats', 'interviews', 'Schedule Interview', 'create'),
    hold: canMoveToStage(user, 'HOLD'),
    reject: canMoveToStage(user, 'REJECTED'),
    message: canEditMaster,
    call: canEditMaster,
  };

  // --- One-click row actions ---------------------------------------------------
  const openRow = (r) => setDrawer({ candidateId: r.candidateId || r.id, applicationId: r.candidateId ? r.id : null });
  async function rowAct(c, a) {
    if (!c.latestApplicationId) return;
    if (a.kind === 'return') { setReturnFor(c); return; }
    if (a.kind === 'schedule') { setRowKind({ kind: 'interview', items: [itemOf(c)] }); return; }
    setRowBusy(c.id);
    setRowFlash(null);
    try {
      await api.patch(`/applications/${c.latestApplicationId}/stage`, { stage: a.to });
      setRowFlash({ ok: true, text: `${c.name} — moved to ${STAGE_LABELS[a.to] || a.to}.` });
      reload();
      if (a.id === 'review') openRow(c);
    } catch (err) {
      setRowFlash({ ok: false, text: `${c.name}: ${err.response?.data?.error || 'that move was refused.'}` });
    } finally {
      setRowBusy('');
    }
  }
  function rowMenuFor(c) {
    const live = ['Active', 'Hold'].includes(c.pipelineStatus) && !!c.latestApplicationId;
    const primary = nextActionsFor(user, c.currentStage, { stage: c.currentStage, requirement: { internal: !!c.internal } });
    const one = () => [itemOf(c)];
    return [
      ['open', 'Open Candidate 360', () => openRow(c)],
      ['page', 'Open full profile', () => navigate(`/candidates/${c.candidateId}`)],
      live && may.stage && ['move', 'Move Stage…', () => setRowKind({ kind: 'stage', items: one() })],
      live && may.interview && ['bde_review', 'client_review', 'interview'].includes(c.stageGroup)
        && !primary.some((a) => a.kind === 'schedule') && ['schedule', 'Schedule Interview', () => setRowKind({ kind: 'interview', items: one() })],
      live && may.assign && ['assign', 'Assign Recruiter', () => setRowKind({ kind: 'assign', items: one() })],
      live && c.pipelineStatus === 'Active' && may.hold && ['hold', 'Put on Hold', () => setRowKind({ kind: 'hold', items: one() })],
      c.latestApplicationId && c.pipelineStatus !== 'Rejected' && may.reject && ['reject', 'Reject', () => setRowKind({ kind: 'reject', items: one() })],
    ].filter(Boolean);
  }
  const rowCtx = { user, onAct: rowAct, menuFor: rowMenuFor, busyId: rowBusy };

  function sortBy(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  }
  function clearAll() {
    setFilters(EMPTY_FILTERS);
    setHier(EMPTY_HIERARCHY);
    setQuick('');
  }
  function pickQuick(id) {
    // A queue is about live work wherever it sits: its count is over every
    // sub-tab, so picking one shows All.
    if (quick === id) { setQuick(''); return; }
    setQuick(id);
    if (pipeSub !== 'all') { setPipeSub('all'); writeUrl('pipeline', 'all'); }
  }
  function pickStatus(v) {
    setFilter({ status: v });
    if (v === 'Rejected' && pipeSub !== 'all') goPipeSub('all');
    else if (v === 'Hold' && !['all', 'hold'].includes(pipeSub)) goPipeSub('hold');
    else if (v === 'Joined' && !['all', 'joined'].includes(pipeSub)) goPipeSub('joined');
    else if (v === 'Active' && ['hold', 'joined'].includes(pipeSub)) goPipeSub('active');
  }
  const moreCount = [filters.clientId, filters.requirementId, hier.tl, filters.bde, filters.location, filters.source,
    filters.followUp, filters.appliedFrom, filters.appliedTo, filters.status].filter(Boolean).length;

  // Saved Views: the view, sub-tab, queue, filters and hierarchy picks.
  const savedState = useMemo(() => ({
    view: main, sub: main === 'master' ? masterSub : pipeSub, quick, filters, hier,
  }), [main, masterSub, pipeSub, quick, filters, hier]);
  function applySaved(s) {
    // Views saved before the three-view structure: view = any | pipeline |
    // hold | selected | joined | master | rejected.
    const legacyRejected = s.view === 'rejected';
    let m = 'pipeline';
    let sub = s.sub || 'active';
    if (s.view === 'master') { m = 'master'; sub = MASTER_SUBS.some((x) => x.id === s.sub) ? s.sub : 'all'; } else if (s.view === 'job-portal') m = portalTab ? 'job-portal' : 'pipeline';
    else if (LEGACY_SUB[s.view]) sub = LEGACY_SUB[s.view];
    else if (legacyRejected) sub = 'all';
    else if (s.view === 'pipeline' && !s.sub) sub = 'active';
    setMain(m);
    if (m === 'pipeline') setPipeSub(sub);
    if (m === 'master') setMasterSub(sub);
    setQuick(s.quick || '');
    setFilters({ ...EMPTY_FILTERS, ...(s.filters || {}), ...(legacyRejected ? { status: 'Rejected' } : {}) });
    setHier({ ...EMPTY_HIERARCHY, ...(s.hier || {}) });
    writeUrl(m, sub);
  }

  // Active filter chips.
  const stageChipLabel = (() => {
    const st = filters.stage;
    if (!st) return '';
    if (st.startsWith('st:')) {
      const keys = st.slice(3).split(',');
      return keys.map((k) => ((counts.stageOptions || []).find((o) => o.key === k) || {}).label || k.replace(/_/g, ' ')).join(', ');
    }
    if (st.startsWith('group:')) return (STAGE_GROUPS.find((g) => g.id === st.slice(6)) || {}).label || st.slice(6);
    return st.slice(6).split(',').map((s) => STAGE_LABELS[s] || s).join(', ');
  })();
  const chips = [
    ...hierarchyChips(hier, hierTree.data, setHier).map((ch) => (ch.value ? ch : {
      ...ch, value: String(hier[ch.key] || '').startsWith('name:') ? hier[ch.key].slice(5) : 'selected person',
    })),
    { key: 'search', label: 'Search', value: filters.search, onRemove: () => setFilter({ search: '' }) },
    { key: 'hiring', label: 'Hiring', value: filters.hiring === 'internal' ? 'Internal (TeamLink)' : filters.hiring === 'client' ? 'Client' : '', onRemove: () => setFilter({ hiring: '' }) },
    { key: 'quick', label: 'Queue', value: main === 'pipeline' && quick ? (QUICK.find((x) => x[0] === quick) || [])[1] : '', onRemove: () => setQuick('') },
    { key: 'bde', label: 'BDE', value: filters.bde ? (filters.bde.startsWith('name:') ? filters.bde.slice(5) : 'selected') : '', onRemove: () => setFilter({ bde: '' }) },
    { key: 'client', label: 'Client', value: filters.clientId ? ((clientOptions.find(([id]) => id === filters.clientId) || [])[1] || 'selected') : '', onRemove: () => setFilter({ clientId: '', requirementId: '' }) },
    { key: 'req', label: 'Requirement', value: filters.requirementId ? ((requirements.find((r) => r.id === filters.requirementId) || {}).title || 'selected') : '', onRemove: () => setFilter({ requirementId: '' }) },
    { key: 'stage', label: 'Stage', value: main === 'pipeline' ? stageChipLabel : '', onRemove: () => setFilter({ stage: '' }) },
    { key: 'status', label: 'Status', value: main === 'pipeline' ? filters.status : '', onRemove: () => setFilter({ status: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => setFilter({ location: '' }) },
    { key: 'source', label: 'Source', value: filters.source, onRemove: () => setFilter({ source: '' }) },
    { key: 'followUp', label: 'Follow-up', value: main === 'pipeline' ? filters.followUp : '', onRemove: () => setFilter({ followUp: '' }) },
    { key: 'from', label: 'Applied from', value: filters.appliedFrom, onRemove: () => setFilter({ appliedFrom: '' }) },
    { key: 'to', label: 'Applied to', value: filters.appliedTo, onRemove: () => setFilter({ appliedTo: '' }) },
  ];

  // Duplicate check on the Add Candidate form.
  const dupSeq = useRef(0);
  async function checkDuplicate() {
    const name = `${form.firstName} ${form.lastName}`.trim();
    if (!form.email && !form.phone && name.split(/\s+/).length < 2) { setDupe(null); return; }
    dupSeq.current += 1;
    const mine = dupSeq.current;
    try {
      const res = await api.get('/candidates/check-duplicate', { params: { email: form.email, phone: form.phone, name } });
      if (mine !== dupSeq.current) return;
      setDupe(res.data.matches.length || res.data.possible.length ? { matches: res.data.matches, possible: res.data.possible } : null);
    } catch { /* the save re-checks on the server */ }
  }

  async function createCandidate(e, { override = false } = {}) {
    if (e) e.preventDefault();
    setError('');
    const body = {
      ...form,
      name: `${form.firstName} ${form.lastName}`.trim(),
      preferredLocation: form.preferredLocation || form.location,
      firstSource: form.firstSource || form.source,
      ...(override ? { overrideDuplicate: true, overrideReason: 'Create New Profile clicked on the duplicate warning' } : {}),
    };
    try {
      await api.post('/candidates', body);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.duplicate) {
        setDupe({ matches: err.response.data.matches || [], possible: err.response.data.possible || [] });
        setTimeout(() => {
          const el = document.querySelector('.cdup-exists');
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
        return undefined;
      }
      return setError(err.response?.data?.error || 'Could not save this candidate');
    }
    closeForm();
    reload();
    return undefined;
  }

  function closeForm() {
    setForm(EMPTY);
    setDupe(null);
    setShowForm(false);
  }

  function createNewProfile() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Create a SECOND profile even though this phone or email is already on file? This is recorded in the audit trail.')) return;
    const f = document.getElementById('addCandidateForm');
    if (f && !f.reportValidity()) return;
    createCandidate(null, { override: true });
  }

  const visibleCols = quick === 'client_feedback'
    ? FEEDBACK_COLUMNS.map((id) => ({ id, label: { candidate: 'Candidate', client: 'Client', requirement: 'Requirement', ivdate: 'Interview Date', waiting: 'Days Waiting', next: 'Next Action' }[id], locked: id === 'candidate' }))
    : COLUMNS.filter((c) => c.locked || cols.includes(c.id));
  const masterView = main === 'master';
  const viewNoun = masterView ? 'candidate' : 'application';

  return (
    <div className="cpl">
      <div className="page-head">
        <div>
          <h1>Candidates &amp; Pipeline</h1>
          <div className="page-sub">
            {main !== 'job-portal'
              ? <ScopeLine user={user} count={fresh ? fresh.scopeTotal : (viewCounts.master || 0)} noun={viewNoun} />
              : <span className="small-muted">Job Portal — applications before the ATS</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {listOn && (
            <AtsDataTools
              module="candidates"
              kinds={['candidates', 'applications']}
              onImported={reload}
              exportLabel={selected.size && !masterView ? `Export ${selected.size} selected` : 'Export'}
              body={() => ({
                view: masterView ? 'master' : `pipeline-${pipeSub}`,
                params: { ...baseParams, all: '1' },
                ids: selected.size && !masterView ? [...selected.keys()] : null,
              })}
            />
          )}
          {canEditMaster && (
            <button
              className="btn btn-sm"
              title="Open the Omnichannel app"
              onClick={() => window.open('/omnichannel/', '_blank', 'noopener,noreferrer')}
            >
              🔀 Omnichannel ↗
            </button>
          )}
          {can(user, 'ats', 'candidates', 'Add Candidate', 'create') && (
            <button className="btn btn-primary" onClick={() => { setError(''); setDupe(null); setShowForm(true); }}>Add Candidate</button>
          )}
        </div>
      </div>

      {bulkMode && (
        <BulkSendPanel
          mode={bulkMode}
          candidateIds={selectedCandidateIds}
          onClose={() => setBulkMode(null)}
          onSent={() => clearSelection()}
        />
      )}
      {bulkKind && (
        <CandidateBulkActions
          kind={bulkKind}
          items={selectedItems}
          user={user}
          onClose={() => setBulkKind(null)}
          onDone={() => { clearSelection(); reload(); }}
        />
      )}
      {callQueue && (
        <BulkCallQueue
          items={selectedItems}
          onClose={() => setCallQueue(false)}
          onDone={reload}
        />
      )}
      {drawer && (
        <CandidateDrawer
          candidateId={drawer.candidateId}
          applicationId={drawer.applicationId}
          user={user}
          onClose={() => setDrawer(null)}
          onChanged={reload}
        />
      )}
      {rowKind && (
        <CandidateBulkActions
          kind={rowKind.kind}
          items={rowKind.items}
          user={user}
          onClose={() => setRowKind(null)}
          onDone={reload}
        />
      )}
      {returnFor && (
        <ReturnDialog
          applicationId={returnFor.latestApplicationId}
          candidateName={returnFor.name}
          onClose={() => setReturnFor(null)}
          onDone={() => { setRowFlash({ ok: true, text: `${returnFor.name} — returned to the recruiter (Recruiter Review).` }); reload(); }}
        />
      )}

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
              <input required value={form.firstName} onBlur={checkDuplicate} onChange={(e) => set({ firstName: e.target.value })} />
            </label>
            <label className="field">
              <span>Last Name</span>
              <input value={form.lastName} onBlur={checkDuplicate} onChange={(e) => set({ lastName: e.target.value })} />
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

          {dupe && (
            <CandidateDuplicatePanel
              matches={dupe.matches}
              possible={dupe.possible}
              requirements={requirements}
              defaultRequirementId={form.requirementId}
              canApply={can(user, 'ats', 'candidates', 'Applications', 'create')}
              onOpen={(m) => { closeForm(); setDrawerId(m.id); }}
              onApplied={(m) => { closeForm(); reload(); setDrawerId(m.id); }}
              onCreateNew={createNewProfile}
            />
          )}

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
          {error && <div className="error-text">{error}</div>}
        </form>
        </Modal>
      )}

      {/* --- ONE MODULE, THREE VIEWS (spec: "not three pages to wander
              between"). Each view has its own sub-tabs, columns, filters
              and counts. --- */}
      <div className="cviews" role="tablist" aria-label="Candidates views">
        {MAIN_VIEWS.filter((v) => v.id !== 'job-portal' || portalTab).map((v) => {
          const n = v.id === 'pipeline' ? viewCounts.pipeline : v.id === 'master' ? viewCounts.master : viewCounts.jobPortal;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={main === v.id}
              title={v.id === 'job-portal' ? `${v.hint}. The number is how many are still in screening (not yet sent to ATS).` : v.hint}
              className={`cviews-btn${main === v.id ? ' is-on' : ''}`}
              onClick={() => goMain(v.id)}
            >
              {v.label}
              {n != null && <span className="cviews-n">{Number(n).toLocaleString()}</span>}
            </button>
          );
        })}
        {canModule(user, 'reports') && (
          <a className="cpl-moved" href="/reports/ats" onClick={(e) => { e.preventDefault(); navigate('/reports/ats'); }} title="Source performance (Naukri, Indeed, Referral …) is part of ATS Reports">
            Source analytics are in Reports →
          </a>
        )}
      </div>

      {main === 'job-portal' && portalTab && <JobPortalCandidates onSentToAts={reload} />}

      {main === 'master' && (
        <>
          <div className="tabs" style={{ marginBottom: 10 }}>
            {MASTER_SUBS.filter((s) => !s.admin || dupAdmin).map((s) => (
              <div
                key={s.id}
                title={s.id === 'inactive' ? (defs.inactive || s.hint) : s.hint}
                className={`tab${masterSub === s.id ? ' active' : ''}`}
                onClick={() => goMasterSub(s.id)}
              >
                {s.label}
                {counts.subs && counts.subs[s.id] != null && ` (${Number(counts.subs[s.id]).toLocaleString()})`}
              </div>
            ))}
          </div>
          {masterSub === 'duplicates' && dupAdmin && <CandidateDuplicates embedded />}
          {masterSub !== 'duplicates' && (
            <>
              <MoreFilters
                storageKey="candmaster"
                activeMore={[filters.location, filters.source, filters.appliedFrom, filters.appliedTo].filter(Boolean).length}
                onClearAll={clearAll}
                primary={(
                  <>
                    <input type="text" className="cpl-search" placeholder="Search name, phone, email, requirement…" value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} />
                    <HierarchyFilter value={hier} onChange={setHier} show={{ tl: false, recruiter: false }} />
                    {masterSub === 'inactive' && (
                      <label className="cpl-sort" title={defs.inactive || ''}>
                        No activity for
                        <select value={inactiveDays} onChange={(e) => setInactiveDays(Number(e.target.value))}>
                          {INACTIVE_CHOICES.map((d) => <option key={d} value={d}>{`${d} days`}</option>)}
                        </select>
                      </label>
                    )}
                  </>
                )}
              >
                <Combo value={filters.location} onChange={(e) => setFilter({ location: e.target.value })} title="Location">
                  <option value="">All locations</option>
                  {LOCS.map((l) => <option key={l}>{l}</option>)}
                </Combo>
                {show.source && (
                  <Combo value={filters.source} onChange={(e) => setFilter({ source: e.target.value })} title="Source">
                    <option value="">All sources</option>
                    {CANDIDATE_FILTER_SOURCES.map((x) => <option key={x}>{x}</option>)}
                  </Combo>
                )}
                <label className="cpl-date">Applied from <input type="date" value={filters.appliedFrom} onChange={(e) => setFilter({ appliedFrom: e.target.value })} /></label>
                <label className="cpl-date">to <input type="date" value={filters.appliedTo} onChange={(e) => setFilter({ appliedTo: e.target.value })} /></label>
              </MoreFilters>
              <FilterChips filters={chips} onClearAll={clearAll} />
              {masterSub === 'inactive' && defs.inactive && <div className="small-muted cviews-def">{defs.inactive}</div>}
              <div className="cpl-tablebar">
                <span className="small-muted">
                  {loading ? 'Loading…' : fresh ? `${fresh.total.toLocaleString()} ${fresh.total === 1 ? 'person' : 'people'} · one row per candidate, however many applications` : ''}
                </span>
                <label className="cpl-sort">
                  Sort
                  <select value={masterSort.key} onChange={(e) => setMasterSort({ key: e.target.value, dir: masterSort.dir })}>
                    {MASTER_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <button type="button" className="btn btn-sm" onClick={() => setMasterSort({ key: masterSort.key, dir: masterSort.dir === 'asc' ? 'desc' : 'asc' })}>
                    {masterSort.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
                  </button>
                </label>
              </div>
              {loadError && <div className="error-text">{loadError}</div>}
              <div className={`tbl-wrap tbl-fit${loading ? ' cpl-loading' : ''}`}>
                <table className="cpl-table cviews-master">
                  <thead>
                    <tr>
                      <th className="cpl-sticky cpl-sticky-1">Candidate</th>
                      <th>Phone</th>
                      <th>Email</th>
                      <th style={{ textAlign: 'right' }}>Applications</th>
                      <th>Current Application</th>
                      <th>Current Stage</th>
                      {masterSub === 'inactive' && <th>Last application activity</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className={`row-link${drawer && drawer.candidateId === c.id ? ' cpl-row-open' : ''}`} onClick={() => openRow(c)}>
                        <td className="cpl-sticky cpl-sticky-1 cpl-cand">
                          <span className="avatarsm">{initials(c.name)}</span>
                          <span className="cpl-cand-name">{c.name}</span>
                          <div className="small-muted cviews-code">{c.code}</div>
                        </td>
                        <td className="cell-muted cpl-nowrap">{c.phone || '—'}</td>
                        <td className="cell-muted cviews-email">{c.email || '—'}</td>
                        <td style={{ textAlign: 'right' }}><b>{c.applicationsCount}</b></td>
                        <td>
                          {c.requirementTitle || <span className="small-muted">No application</span>}
                          {c.clientName && <div className="small-muted" style={{ fontSize: 11.5 }}>{c.clientName === 'TeamLink Internal' ? 'TeamLink (internal)' : c.clientName}</div>}
                        </td>
                        <td>
                          {c.currentStage
                            ? (
                              <>
                                <StatusChip status={c.currentInJobPortal ? 'New' : c.stageGroupLabel}>{c.currentInJobPortal ? 'Job Portal screening' : (c.currentStageLabel || c.stageGroupLabel)}</StatusChip>
                                {c.applicationsCount > 1 && <div className="small-muted" style={{ fontSize: 11, marginTop: 2 }}>{`+${c.applicationsCount - 1} other application(s)`}</div>}
                              </>
                            )
                            : <span className="small-muted">—</span>}
                        </td>
                        {masterSub === 'inactive' && <td className="cell-muted cpl-nowrap">{c.lastApplicationActivityAt ? protoDate(c.lastApplicationActivityAt) : '—'}</td>}
                      </tr>
                    ))}
                    {!loading && fresh && rows.length === 0 && (
                      <tr><td colSpan={7} style={{ padding: 0 }}>
                        <EmptyState compact icon="🗂️" title={masterSub === 'inactive' ? 'Nobody is inactive for that long.' : 'No candidates match.'} hint="Try removing a filter." />
                      </td></tr>
                    )}
                    {!fresh && <tr><td colSpan={7} className="small-muted" style={{ padding: 16 }}>Loading candidates…</td></tr>}
                  </tbody>
                </table>
              </div>
              {fresh && <ServerPager total={fresh.total} page={fresh.page} pages={fresh.pages} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} noun="candidates" />}
            </>
          )}
        </>
      )}

      {main === 'pipeline' && (
        <>
          <div className="tabs" style={{ marginBottom: 10 }}>
            {PIPE_SUBS.map((s) => (
              <div
                key={s.id}
                title={s.hint}
                className={`tab${pipeSub === s.id ? ' active' : ''}`}
                onClick={() => goPipeSub(s.id)}
              >
                {`${s.label} (${Number((counts.subs || {})[s.id] ?? 0).toLocaleString()})`}
              </div>
            ))}
          </div>
          <div className="cpl-quick" role="group" aria-label="Queues">
            <SavedViews storageKey="cand" current={savedState} onApply={applySaved} presets={SAVED_PRESETS} />
            {user?.atsRole !== 'HR' && (
              <span role="group" aria-label="Client or internal hiring" style={{ display: 'inline-flex', gap: 2 }}>
                {[['', 'All'], ['client', 'Client'], ['internal', 'Internal']].map(([k, l]) => (
                  <button
                    key={k || 'all'}
                    type="button"
                    className={`cpl-chip${(filters.hiring || '') === k ? ' is-on' : ''}`}
                    aria-pressed={(filters.hiring || '') === k}
                    title={k === 'internal' ? "TeamLink's own openings — HR Review → Dept Head / TL → Interview → … → HRMS" : k === 'client' ? 'Client requirements — Recruiter → TL → BDE → Client → Interview → Selected → Joining' : 'Both'}
                    onClick={() => setFilter({ hiring: k, stage: '' })}
                  >
                    {l}
                  </button>
                ))}
              </span>
            )}
            {QUICK_GROUPS.map((grp, gi) => (
              <span key={grp.join()} className="cviews-qgroup">
                {gi > 0 && <span className="cpl-bulk-sep" />}
                {grp.map((id) => {
                  const label = (QUICK.find((x) => x[0] === id) || [])[1];
                  const n = (counts.quick || {})[id] ?? 0;
                  const tip = [defs[id], id === 'overdue' && counts.noDue ? `${Number(counts.noDue).toLocaleString()} live application(s) have no due date yet (imported with their stage — set a follow-up or move them to start the clock).` : null].filter(Boolean).join('\n\n');
                  return (
                    <button
                      key={id}
                      type="button"
                      title={tip || label}
                      className={`cpl-chip${quick === id ? ' is-on' : ''}${id === 'overdue' && n ? ' is-red' : ''}`}
                      onClick={() => pickQuick(id)}
                    >
                      {label}
                      <span className="cpl-chip-n">{Number(n).toLocaleString()}</span>
                    </button>
                  );
                })}
              </span>
            ))}
          </div>

          <MoreFilters
            storageKey="cand"
            activeMore={moreCount}
            onClearAll={clearAll}
            primary={(
              <>
                <input type="text" className="cpl-search" placeholder="Search candidate, phone, email or requirement…" value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} />
                <HierarchyFilter value={hier} onChange={setHier} show={{ tl: false, recruiter: false }} />
                <StageMenu
                  value={filters.stage}
                  label={stageChipLabel}
                  options={counts.stageOptions || []}
                  internal={filters.hiring === 'internal'}
                  open={stageOpen}
                  setOpen={setStageOpen}
                  onChange={(v) => setFilter({ stage: v })}
                />
                <HierarchyFilter value={hier} onChange={setHier} show={{ department: false, section: false, tl: false }} />
              </>
            )}
          >
            {show.client && (
              <Combo value={filters.clientId} onChange={(e) => setFilter({ clientId: e.target.value, requirementId: '' })} title="Client">
                <option value="">All clients</option>
                {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </Combo>
            )}
            <Combo value={filters.requirementId} onChange={(e) => setFilter({ requirementId: e.target.value })} title="Requirement">
              <option value="">All requirements</option>
              {requirementOptions.map((r) => <option key={r.id} value={r.id}>{show.client || !r.client ? r.title : `${r.title} · ${r.internal ? 'TeamLink (internal)' : r.client.name}`}</option>)}
            </Combo>
            <HierarchyFilter value={hier} onChange={setHier} show={{ department: false, section: false, recruiter: false }} />
            {show.bde && (
              <PeopleFilter role="BDE" department={hier.department} value={filters.bde} onChange={(v) => setFilter({ bde: v })} />
            )}
            <Combo value={filters.location} onChange={(e) => setFilter({ location: e.target.value })} title="Location">
              <option value="">All locations</option>
              {LOCS.map((l) => <option key={l}>{l}</option>)}
            </Combo>
            {show.source && (
              <Combo value={filters.source} onChange={(e) => setFilter({ source: e.target.value })} title="Source">
                <option value="">All sources</option>
                {CANDIDATE_FILTER_SOURCES.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            )}
            <Combo value={filters.followUp} onChange={(e) => setFilter({ followUp: e.target.value })} title="Follow-up">
              <option value="">All follow-ups</option>
              <option value="Due Today,Overdue">Due now (today + overdue)</option>
              {FOLLOWUP_STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
              <option value="Not set">Not set</option>
            </Combo>
            <label className="cpl-date">Applied from <input type="date" value={filters.appliedFrom} onChange={(e) => setFilter({ appliedFrom: e.target.value })} /></label>
            <label className="cpl-date">to <input type="date" value={filters.appliedTo} onChange={(e) => setFilter({ appliedTo: e.target.value })} /></label>
            <Combo value={filters.status} onChange={(e) => pickStatus(e.target.value)} title="Status">
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Combo>
          </MoreFilters>
          <FilterChips filters={chips} onClearAll={clearAll} />
          {quick && defs[quick] && <div className="small-muted cviews-def">{defs[quick]}</div>}
          {rowFlash && (
            <div className={`notice${rowFlash.ok ? '' : ' red'} cpl-flash`}>
              <span>{rowFlash.text}</span>
              <button type="button" className="link-btn" onClick={() => setRowFlash(null)}>Dismiss</button>
            </div>
          )}

          {selected.size > 0 && (
            <div className="cpl-bulk">
              <b>{`${selected.size.toLocaleString()} application${selected.size === 1 ? '' : 's'} selected`}</b>
              {fresh && selected.size < fresh.total && (
                <button type="button" className="link-btn" onClick={selectAllMatching}>
                  {`Select all ${fresh.total.toLocaleString()} matching`}
                </button>
              )}
              <button type="button" className="link-btn" onClick={clearSelection}>Clear</button>
              <span className="cpl-bulk-sep" />
              {may.assign && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('assign')}>Assign Recruiter</button>}
              {may.stage && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('stage')}>Change Stage</button>}
              {may.interview && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('interview')}>Schedule Interview</button>}
              {may.call && <button type="button" className="btn btn-sm" onClick={() => setCallQueue(true)}>📞 Call selected</button>}
              {may.message && [['WhatsApp', '💬 WhatsApp'], ['Email', '📧 Email'], ['SMS', '✉️ SMS']].map(([mode, label]) => (
                <button key={mode} type="button" className="btn btn-sm" onClick={() => setBulkMode(mode)}>{label}</button>
              ))}
              {may.hold && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('hold')}>Put on Hold</button>}
              {may.reject && <button type="button" className="btn btn-sm btn-danger" onClick={() => setBulkKind('reject')}>Reject</button>}
              <span className="small-muted">Export (top right) exports the selected rows.</span>
              {selectNote && <span className="small-muted">{selectNote}</span>}
            </div>
          )}

          <div className="cpl-tablebar">
            <span className="small-muted">
              {loading ? 'Loading…' : fresh ? `${fresh.total.toLocaleString()} application${fresh.total === 1 ? '' : 's'} · one row per candidate + requirement` : ''}
            </span>
            <label className="cpl-sort">
              Sort
              <select value={sort.key} onChange={(e) => setSort({ key: e.target.value, dir: sort.dir })}>
                {SORT_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <button type="button" className="btn btn-sm" title="Reverse the order" onClick={() => setSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}>
                {sort.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
              </button>
            </label>
            {quick !== 'client_feedback' && <ColumnChooser columns={COLUMNS} value={cols} onChange={setCols} defaults={DEFAULT_COLS} />}
          </div>

          {loadError && <div className="error-text">{loadError}</div>}
          <div className={`tbl-wrap tbl-fit${loading ? ' cpl-loading' : ''}`}>
            <table className="cpl-table">
              <thead>
                <tr>
                  <th className="cpl-sticky cpl-sticky-0" style={{ width: 36 }}>
                    <input type="checkbox" aria-label="Select this page" checked={pageAllOn} onChange={(e) => togglePage(e.target.checked)} />
                  </th>
                  {visibleCols.map((col) => (
                    <th key={col.id} className={col.id === 'candidate' ? 'cpl-sticky cpl-sticky-1' : undefined}>
                      {col.sort
                        ? (
                          <button type="button" className={`cpl-th${sort.key === col.sort ? ' is-on' : ''}`} onClick={() => sortBy(col.sort)}>
                            {col.label}
                            <span aria-hidden="true">{sort.key === col.sort ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
                          </button>
                        )
                        : col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={`row-link${drawer && drawer.applicationId === c.id ? ' cpl-row-open' : ''}`} onClick={() => openRow(c)}>
                    <td className="cpl-sticky cpl-sticky-0" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${c.name} — ${c.requirementTitle || ''}`} checked={selected.has(c.id)} onChange={() => toggleRow(c)} />
                    </td>
                    {visibleCols.map((col) => <Cell key={col.id} col={col.id} c={c} ctx={rowCtx} onOpen={() => openRow(c)} />)}
                  </tr>
                ))}
                {!loading && fresh && rows.length === 0 && (
                  <tr>
                    <td colSpan={visibleCols.length + 1} style={{ padding: 0 }}>
                      {chips.some((ch) => ch.value) || quick
                        ? (
                          <EmptyState
                            compact
                            icon="🔍"
                            title={quick ? `Nothing in ${(QUICK.find((x) => x[0] === quick) || [])[1]} right now.` : 'No applications match these filters.'}
                            hint={quick ? (defs[quick] || '') : 'Try removing a filter, or switch to the All tab.'}
                            action={<button type="button" className="btn btn-sm" onClick={clearAll}>Clear all filters</button>}
                          />
                        )
                        : (
                          <EmptyState
                            compact
                            icon={tier === 'recruiter' ? '🎉' : '🗂️'}
                            title={`No applications in ${(PIPE_SUBS.find((v) => v.id === pipeSub) || {}).label || 'this tab'}.`}
                            hint={tier === 'recruiter' ? "Nothing here right now — you're all caught up." : 'Try another tab, or add a candidate.'}
                          />
                        )}
                    </td>
                  </tr>
                )}
                {!fresh && (
                  <tr><td colSpan={visibleCols.length + 1} className="small-muted" style={{ padding: 16 }}>Loading applications…</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {fresh && (
            <ServerPager total={fresh.total} page={fresh.page} pages={fresh.pages} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} noun="applications" />
          )}
          {filters.status === 'Rejected' && rows.length > 0 && (
            <div className="notice" style={{ marginTop: 14 }}>
              Rejected candidates stay in the Candidate Master and remain searchable and matchable for other
              requirements. Internal rejection reasoning is never shown to client users.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One table cell, by column id — the header and the body both walk
// visibleCols, so a column chooser change can never misalign them.
const dash = <span className="small-muted">—</span>;
function Cell({
  col, c, onOpen, ctx,
}) {
  switch (col) {
    case 'candidate':
      return (
        <td className="cpl-sticky cpl-sticky-1 cpl-cand">
          <span className="avatarsm">{initials(c.name)}</span>
          <span className="cpl-cand-name">{c.name}</span>
          <div className="small-muted cviews-code">
            {c.code}
            {c.applicationsCount > 1 && <span title="This person has other applications — see Candidate Master or the Applications tab">{` · ${c.applicationsCount} applications`}</span>}
          </div>
        </td>
      );
    case 'requirement':
      return (
        <td className="cviews-req">
          {c.requirementTitle || dash}
          {c.reqCode && <div className="small-muted" style={{ fontSize: 11 }}>{c.reqCode}</div>}
        </td>
      );
    case 'client':
      return (
        <td className="cell-muted cviews-client">
          {c.internal
            ? (
              <>
                <span className="cviews-type" title="TeamLink's own opening — the internal hiring chain">Internal</span>
                <div className="small-muted" style={{ fontSize: 11 }}>TeamLink</div>
              </>
            )
            : (c.clientName || '—')}
        </td>
      );
    case 'department': return <td className="cell-muted cpl-nowrap">{c.requirementDepartment || '—'}</td>;
    case 'section': return <td className="cell-muted cpl-nowrap">{c.section || '—'}</td>;
    case 'stage':
      return (
        <td>
          {c.currentStage
            ? (
              <>
                <StatusChip status={c.stageGroupLabel}>{c.currentStageLabel || c.stageGroupLabel}</StatusChip>
                {c.stageKey === 'feedback_pending' && <div className="small-muted" style={{ marginTop: 3 }}>Feedback pending</div>}
                {c.rejection && (
                  <div className="small-muted" style={{ marginTop: 3 }} title={[c.rejection.reason, c.rejection.detail, c.rejection.by && `Recorded by ${c.rejection.by}`].filter(Boolean).join('\n')}>
                    {`by ${c.rejection.sideLabel}`}
                  </div>
                )}
              </>
            )
            : dash}
        </td>
      );
    case 'owner': {
      const chain = [
        c.requirementDepartment, c.section, c.tlName && `TL ${c.tlName}`,
        c.recruiterName && `Rec ${c.recruiterName}${c.positionCode ? ` (${c.positionCode})` : ''}`, c.bdeName && `BDE ${c.bdeName}`,
      ].filter(Boolean);
      const live = ['Active', 'Hold'].includes(c.pipelineStatus);
      return (
        <td title={['Department', 'Section', 'TL', 'Recruiter', 'BDE'].map((k, i) => `${k}: ${[c.requirementDepartment, c.section, c.tlName, c.recruiterName, c.bdeName][i] || '—'}`).join('\n')}>
          {live && c.owner && c.owner !== '—' ? <b style={{ fontWeight: 600 }}>{c.owner}</b> : (live ? <span className="small-muted" title="Nobody with an active login is named for this step — assign the requirement, or set a follow-up owner">No owner named</span> : dash)}
          {live && c.ownerRole && c.ownerRole !== '—' && <div className="small-muted cpl-own">{c.waitingOn ? `${c.ownerRole} · waiting on the client` : c.ownerRole}</div>}
          {!live && chain.length > 0 && <div className="small-muted cpl-own">{chain.join(' · ')}</div>}
        </td>
      );
    }
    case 'next':
      return <NextCell c={c} ctx={ctx} onOpen={onOpen} />;
    case 'due': {
      const live = ['Active', 'Hold'].includes(c.pipelineStatus);
      if (!live) return <td className="cell-muted">—</td>;
      if (!c.dueDate) {
        return (
          <td className="cell-muted" title="No real due date yet: imported with its stage already set. Moving the application or setting a follow-up starts the clock.">
            <span className="small-muted">No due date</span>
          </td>
        );
      }
      return (
        <td className="cpl-nowrap" title={c.dueSource === 'follow-up' ? 'Due date of the open follow-up' : `Stage SLA — entered this stage ${c.stageEnteredAt ? protoDate(c.stageEnteredAt) : ''}`}>
          <span className={c.dueStatus === 'overdue' ? 'cviews-late' : undefined}>{dueLabel(c.dueDate)}</span>
          {c.dueStatus === 'overdue' && <div><StatusChip status="Overdue" /></div>}
          {c.dueStatus === 'due_today' && <div className="small-muted" style={{ fontSize: 11 }}>due today</div>}
        </td>
      );
    }
    case 'ivdate': return <td className="cell-muted cpl-nowrap">{c.feedback && c.feedback.interviewDate ? protoDate(c.feedback.interviewDate) : '—'}</td>;
    case 'waiting':
      return (
        <td className="cpl-nowrap">
          {c.feedback && c.feedback.daysWaiting != null
            ? <b className={c.feedback.daysWaiting > 3 ? 'cviews-late' : undefined}>{`${c.feedback.daysWaiting} day${c.feedback.daysWaiting === 1 ? '' : 's'}`}</b>
            : '—'}
        </td>
      );
    case 'followup':
      return (
        <td className="cell-muted">
          {c.followUp
            ? (
              <>
                <StatusChip status={c.followUp.status} />
                <div className="small-muted" style={{ marginTop: 3 }}>
                  {`due ${protoDate(c.followUp.dueDate)}`}
                  {c.followUp.daysOverdue > 0 && ` · ${c.followUp.daysOverdue}d late`}
                </div>
              </>
            )
            : (
              <span className="small-muted">
                {c.followUpNeed === 'required' && <b className="fu-needed">Needs a follow-up</b>}
                {c.followUpNeed === 'optional' && 'Optional'}
                {(!c.followUpNeed || c.followUpNeed === 'none') && 'Not required'}
              </span>
            )}
        </td>
      );
    case 'status':
      return (
        <td>
          {c.pipelineStatus ? <StatusChip status={c.pipelineStatus} /> : dash}
          {c.rejection && (
            <div className="small-muted" style={{ marginTop: 4, maxWidth: 200, lineHeight: 1.35 }} title={[c.rejection.detail, c.rejection.fromStage && `Rejected at ${c.rejection.fromStage}`, c.rejection.by && `Recorded by ${c.rejection.by}`].filter(Boolean).join('\n')}>
              <b style={{ color: 'var(--ink)' }}>by {c.rejection.sideLabel}</b>
              {c.rejection.reason && <> · {c.rejection.reason}</>}
            </div>
          )}
        </td>
      );
    case 'recruiter':
      return <td className="cell-muted cpl-nowrap">{c.recruiterName || '—'}{c.positionCode && <div className="small-muted">{c.positionCode}</div>}</td>;
    case 'tl': return <td className="cell-muted cpl-nowrap">{c.tlName || '—'}</td>;
    case 'bde': return <td className="cell-muted cpl-nowrap">{c.bdeName || '—'}</td>;
    case 'interview': return <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{c.interviewAt ? dateTime(c.interviewAt) : '—'}</td>;
    case 'applied': return <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{protoDate(c.appliedDate || c.createdAt)}</td>;
    case 'activity': return <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{c.lastActivityAt ? dateTime(c.lastActivityAt) : '—'}</td>;
    case 'location': return <td className="cell-muted">{c.location || '—'}</td>;
    case 'source': return <td className="cell-muted">{c.source || '—'}</td>;
    case 'phone': return <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{c.phone || '—'}</td>;
    default: return <td />;
  }
}

// THE ONE NEXT ACTION: the move THIS login owns at this step, as one button
// that does it; anyone else sees whose move it is.
function NextCell({ c, ctx, onOpen }) {
  const live = c.pipelineStatus === 'Active' || c.pipelineStatus === 'Hold';
  const acts = live && ctx ? nextActionsFor(ctx.user, c.currentStage, { stage: c.currentStage, requirement: { internal: !!c.internal } }) : [];
  const menu = ctx ? ctx.menuFor(c) : [];
  const busy = ctx && ctx.busyId === c.id;
  const stop = (e) => e.stopPropagation();
  return (
    <td className="cpl-col-next" onClick={stop}>
      <div className="cpl-next-row">
        {acts.length > 0 && acts.map((a, i) => (
          <button
            key={a.id}
            type="button"
            disabled={busy}
            className={`btn btn-sm ${i === 0 ? 'btn-primary' : 'cpl-next-alt'}`}
            title={a.kind === 'return' ? 'Back to Recruiter Review, with a reason' : undefined}
            onClick={() => ctx.onAct(c, a)}
          >
            {i === 0 ? `${a.label} →` : a.label}
          </button>
        ))}
        {acts.length === 0 && live && c.pipelineStatus === 'Hold' && (
          <button type="button" className="link-btn cpl-next" onClick={onOpen}>Review hold →</button>
        )}
        {acts.length === 0 && live && c.pipelineStatus !== 'Hold' && (
          <span className="cpl-waiting" title={c.owner && c.owner !== '—' ? `Owner: ${c.owner}` : undefined}>
            {c.nextAction || '—'}
          </span>
        )}
        {!live && <span className="small-muted">{c.nextAction && c.nextAction !== '—' ? c.nextAction : '—'}</span>}
        {menu.length > 0 && <RowMenu items={menu} label={c.name} />}
      </div>
      {live && acts.length > 0 && c.nextAction && (
        <div className="small-muted cpl-sub">{c.nextAction}</div>
      )}
    </td>
  );
}

function RowMenu({ items, label }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="cpl-rowmenu" ref={box}>
      <button type="button" className="cpl-rowmenu-btn" aria-label={`More actions for ${label}`} aria-expanded={open} onClick={() => setOpen((x) => !x)}>⋯</button>
      {open && (
        <span className="cpl-rowmenu-pop" role="menu">
          {items.map(([id, text, fn]) => (
            <button key={id} type="button" role="menuitem" className={`cpl-rowmenu-item${id === 'reject' ? ' is-danger' : ''}`} onClick={() => { setOpen(false); fn(); }}>
              {text}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// "Stage: [All ▼]" (spec §2): exactly Recruiter Review, TL Review, BDE
// Review, Client Submitted, Client Shortlisted, Interview Scheduled,
// Interview Completed, Feedback Pending, Selected, Offer, Joined, Hold,
// Rejected — the internal chain's names when Internal is picked. The
// server sends the options with their counts; the ones outside this login's
// role come under "Other stages" only while they hold applications.
function StageMenu({
  value, label, options, internal, open, setOpen, onChange,
}) {
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setOpen]);
  const pick = (v) => { onChange(v); setOpen(false); };
  const mine = options.filter((o) => o.relevant);
  const other = options.filter((o) => !o.relevant && o.count > 0);
  const item = (o) => (
    <button key={o.key} type="button" className={`cpl-stagemenu-item cpl-stagemenu-main${value === `st:${o.key}` ? ' is-on' : ''}${o.count ? '' : ' is-empty'}`} onClick={() => pick(`st:${o.key}`)}>
      <span>{o.label}</span>
      <span className="cpl-chip-n">{Number(o.count || 0).toLocaleString()}</span>
    </button>
  );
  return (
    <div className="cpl-stagemenu" ref={box}>
      <button type="button" className={`btn btn-sm cpl-stagemenu-btn${value ? ' is-on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {'Stage: '}<b>{label || 'All'}</b><span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div className="cpl-stagemenu-pop" role="menu">
          <button type="button" className={`cpl-stagemenu-item${!value ? ' is-on' : ''}`} onClick={() => pick('')}>
            <span>All stages</span>
          </button>
          {mine.map(item)}
          {other.length > 0 && <div className="cpl-stagemenu-sep">Other stages (outside your role)</div>}
          {other.map(item)}
          <div className="cpl-stagemenu-foot">
            {internal ? 'Internal chain: HR Review → Dept Head / TL → Interview → Feedback → Selected → Offer → Joining → HRMS.' : 'Counts follow the filters and tab already on.'}
          </div>
        </div>
      )}
    </div>
  );
}

// Server-side pager: page numbers plus rows per page (25 / 50 / 100).
function ServerPager({
  total, page, pages, pageSize, onPage, onPageSize, noun = 'rows',
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const numbers = [];
  if (pages <= 7) for (let i = 1; i <= pages; i += 1) numbers.push(i);
  else if (page <= 4) numbers.push(1, 2, 3, 4, 5, '…', pages);
  else if (page >= pages - 3) numbers.push(1, '…', pages - 4, pages - 3, pages - 2, pages - 1, pages);
  else numbers.push(1, '…', page - 1, page, page + 1, '…', pages);
  return (
    <div className="pager">
      <div className="pager-count">
        {total === 0
          ? `No ${noun}`
          : <>Showing <strong>{from.toLocaleString()}–{to.toLocaleString()}</strong> of <strong>{total.toLocaleString()}</strong> {noun}</>}
      </div>
      {pages > 1 && (
        <div className="pager-nav">
          <button type="button" className="pager-btn" disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
          {numbers.map((n, i) => (n === '…'
            // eslint-disable-next-line react/no-array-index-key
            ? <span key={`gap${i}`} className="pager-gap">…</span>
            : (
              <button key={n} type="button" className={`pager-btn${n === page ? ' active' : ''}`} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}>
                {n}
              </button>
            )))}
          <button type="button" className="pager-btn" disabled={page === pages} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
        </div>
      )}
      <label className="pager-size">
        Rows per page
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    </div>
  );
}
