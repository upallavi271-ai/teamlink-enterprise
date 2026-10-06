import { useEffect, useMemo, useRef, useState } from 'react';
import BulkSendPanel from '../components/BulkSendPanel.jsx';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { SourceExtras } from '../components/candidate/CandidateRecord.jsx'; // ATS-100 B5/B6
import Modal, { SectionHead } from '../components/Modal.jsx';
// docfill_: "Upload the resume" / "Type it myself" on Add candidate (components/ui/FillFromFile.jsx).
import { useFillFromFile, FillEntryModal, FillBanner } from '../components/ui/FillFromFile.jsx';
import { candidateFieldsToForm, CANDIDATE_FIELD_NAMES } from '../components/ui/fillMaps.js';
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
import HierarchyFilter, { EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy } from '../components/HierarchyFilter.jsx';
import AtsDataTools, { runAtsExport, useAtsIoAccess } from '../components/AtsDataTools.jsx';
// cand7_ (Candidates §7): the Progress board.
import CandidateBoard from '../components/candidate/CandidateBoard.jsx';
import ListPageHeader, {
  StatusTabs, ListToolbar, ListFooter, FacetSelect, PanelField, useFacets,
} from '../components/ui/ListPageHeader.jsx';
import ColumnChooser, { useStoredState } from '../components/ColumnChooser.jsx';
import CandidateDrawer from '../components/CandidateDrawer.jsx';
import CandidateBulkActions from '../components/CandidateBulkActions.jsx';
import BulkCallQueue from '../components/BulkCallQueue.jsx';
import SavedViews from '../components/SavedViews.jsx';
import CandidateDuplicatePanel from '../components/CandidateDuplicatePanel.jsx';
import JobPortalCandidates from '../components/portal/JobPortalCandidates.jsx';
import CandidateDuplicates from './CandidateDuplicates.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import { nextActionsFor, ReturnDialog } from '../components/Candidate360.jsx';
import '../components/CandidatePipeline.css';
import './CandidatesViews.css';
// The follow-ups agent's Last contact cell, when it exists (falls back to ours).
const LC_MOD = import.meta.glob('../components/followups/LastContact.jsx', { eager: true });
const LastContactCell = (Object.values(LC_MOD)[0] || {}).default || null;
// Rejections (spec 2026-10-03 §A1): the Rejected tab's own columns + the "Rejected 2×" badge.
import { RejectedBadge, shortDate, sendWithSameClientCheck } from '../components/rejections/rejectionUi.jsx';
import StillFits from '../components/rejections/StillFits.jsx';
// ATS layout v3 (2026-10-03): the shared filter bar + cards, and the step popups.
import PageFilterBar, { rangeDates } from '../components/ui/PageFilterBar.jsx';

import StepPopup from '../components/candidate/StepPopups.jsx';
// "A new person gets it in 20–30 s" (user, 2026-10-05): How it works · first-visit tips · ? tips.
import {
  HowItWorks, FirstTips, Help, usePipelineSteps, stepStageFilter, stepOfStageFilter, PIPELINE_STEPS,
} from '../components/ui/Guide.jsx';

// The Step filter's options in everyday words (the server's names are the
// old ones: "TL Review", "Client Submitted"…). Internal hiring keeps its own.
const STEP_PLAIN = {
  recruiter_review: 'Check by recruiter', tl_review: 'Waiting for team lead check', bde_review: 'Check by client manager',
  client_submitted: 'Sent to client', client_shortlisted: 'Client shortlisted', interview_scheduled: 'Interview booked',
  interview_completed: 'Interview done', feedback_pending: 'Waiting for interview feedback', selected: 'Selected',
  offer: 'Offer', joined: 'Joined', hold: 'On hold', rejected: 'Rejected',
};
const CAND_TIPS = [
  'Each row is one person for one job. The Step column says where they are now.',
  'Click a row to see the person, their CV and their history.',
  'Press the blue Next step button on a row to move them on (for example, Send to client).',
];

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
  // Spec 2026-10-03 §B (pipeline only): Skills · Experience · Notice period ·
  // Salary · Match ≥ %.
  skills: '', minExp: '', maxExp: '', notice: '', maxSalary: '', minMatch: '',
  // cand7_ (§7 Filters): Qualification · Specialization (masters) · Owner ·
  // Last contact · Rejected before.
  qualificationId: '', specialisationId: '', owner: '', contact: '', rejectedBefore: '',
  // Rejections (spec 2026-10-03 §A1): the Rejected tab — whose decision · reason.
  rejSide: '', rejReason: '',
  // ATS layout v3 cards: "Not followed up 7+ / 30+ days" (pipeline) and
  // "Available for matching" (People).
  contactAge: '', available: '',
};
// Typed filters wait for typing to pause before they reach the server.
const TYPED_KEYS = ['skills', 'minExp', 'maxExp', 'maxSalary', 'minMatch'];
// Filters the Candidate Master (one row per person) does not take.
const PIPELINE_ONLY = ['stage', 'followUp', 'status', 'skills', 'minExp', 'maxExp', 'notice', 'maxSalary', 'minMatch', 'owner', 'contact', 'rejectedBefore', 'rejSide', 'rejReason', 'contactAge'];
// The pipeline does not take the People-only "available" filter.
const MASTER_ONLY = ['available'];
const SOURCED_STAGES = 'stage:NEW,AI_INTERVIEW_REQUIRED,AI_INTERVIEW_SCHEDULED,AI_INTERVIEW_COMPLETED';
// A facet list that always carries the chosen value (a deep-linked 'id:…' or
// 'seat:…' value is not one of the server's 'name:…' options).
function withCurrent(options, value, label) {
  const list = options || [];
  if (!value || list.some((o) => String(o.value) === String(value))) return list;
  return [{ value, label: label || value, count: 0 }, ...list];
}
const personLabel = (v) => (String(v || '').startsWith('name:') ? v.slice(5) : String(v || '').startsWith('seat:') ? `Recruiter seat ${v.slice(5)}` : 'Selected person');

const MAIN_VIEWS = [
  { id: 'pipeline', label: 'Job applications', say: 'One row for each person + job. A person who applied to 3 jobs shows 3 times.', hint: 'People already working through a job' },
  { id: 'job-portal', label: 'New from job portal', say: 'People who applied on the job portal and are not checked yet. Check them, then send to a job.', hint: 'Not checked yet — check, then send to a job' },
  { id: 'master', label: 'People', say: 'One row for each person, however many jobs they applied to.', hint: 'One row per person, with all their applications' },
];
const PIPE_SUBS = [
  { id: 'all', label: 'All', hint: 'Every application, any status' },
  { id: 'active', label: 'Active', hint: 'Still in progress' },
  { id: 'hold', label: 'Hold', hint: 'Applications on hold' },
  { id: 'selected', label: 'Selected', hint: 'Selected, offer made or offer accepted' },
  { id: 'joined', label: 'Joined', hint: 'Joined / hired' },
  { id: 'rejected', label: 'Rejected', hint: 'Rejected applications — kept, never deleted' },
];
const MASTER_SUBS = [
  { id: 'all', label: 'All people', hint: 'Every person you can see — one row each, however many jobs' },
  { id: 'duplicates', label: 'Duplicates', hint: 'Possible duplicate profiles — compare, then Merge or Keep Separate (never automatic)', admin: true },
  { id: 'inactive', label: 'Inactive', hint: 'No application activity in the chosen number of days' },
  // cand7_: archived people are hidden everywhere else; open one to bring it back.
  { id: 'archived', label: 'Archived', hint: 'Archived people — hidden from every list, nothing deleted. Open one to bring it back.', archive: true },
];
const INACTIVE_CHOICES = [90, 180, 365];

// The queues (spec §5-§7). Ids kept for old links; labels are the spec's.
const QUICK = [
  ['my_pending', 'Needs my action'],
  ['overdue', 'Late'],
  ['due_today', 'Due today'],
  ['new', 'New, not checked yet'],
  ['client_feedback', 'Waiting for client feedback'],
  ['my_candidates', 'My candidates'],
  ['today_interviews', 'Interviews today'],
];
// Only the four daily queues stay on screen; the rest live in Filters → "Show only".
const QUICK_ON_SCREEN = ['my_pending', 'overdue', 'due_today', 'today_interviews'];
const QUICK_IN_FILTERS = QUICK.filter(([id]) => !QUICK_ON_SCREEN.includes(id));

// ATS Pipeline columns: Candidate | Requirement | Client | Stage | Owner |
// Next Action | Due by default; the rest optional under Columns ⚙.
// cand7_ (§7 List columns): Name, phone, current job, step, owner, last
// contact, fit, source, added date — plus Next step (the one-click action).
// ATS layout v3 (2026-10-03): Name · Phone · Skills · Experience · CTC ·
// Notice period · Department · Status (+ last contact) by default, plus the
// one-click Next step. Everything else stays under ⚙ Columns.
const COLUMNS = [
  { id: 'candidate', label: 'Name', locked: true, sort: 'name' },
  { id: 'phone', label: 'Phone' },
  { id: 'skills', label: 'Skills' },
  { id: 'experience', label: 'Experience', sort: 'experience' },
  { id: 'ctc', label: 'CTC', sort: 'ctc', tip: 'CTC = yearly salary now (and what they want)' },
  { id: 'notice', label: 'Notice period' },
  { id: 'department', label: 'Department' },
  { id: 'stage', label: 'Step', sort: 'stage', tip: 'Where the person is now: checking → sent to client → interview → offer → joined' },
  { id: 'requirement', label: 'Job' },
  { id: 'owner', label: 'Owner', tip: 'The person whose move it is now' },
  { id: 'next', label: 'Next step', tip: 'The one thing to do now for this person, and its button' },
  { id: 'lastContact', label: 'Last contact', sort: 'lastContact' },
  { id: 'fit', label: 'Fit %', sort: 'fit', tip: 'Fit % = how well the CV matches the job (0–100). Higher is better.' },
  { id: 'source', label: 'Source' },
  { id: 'applied', label: 'Added', sort: 'applied' },
  { id: 'client', label: 'Client' },
  { id: 'due', label: 'Due', sort: 'due' },
  { id: 'section', label: 'Section' },
  { id: 'followup', label: 'Follow-up', sort: 'followUp' },
  { id: 'status', label: 'Status' },
  { id: 'recruiter', label: 'Recruiter' },
  { id: 'tl', label: 'Team lead' },
  { id: 'bde', label: 'Client manager (BDE)' },
  { id: 'interview', label: 'Interview', sort: 'interview' },
  { id: 'activity', label: 'Last update', sort: 'activity' },
  { id: 'location', label: 'Location' },
];
// 7 columns by default (user, 2026-10-05: "max 7, the rest via Columns"):
// name (with the job under it) first, then the step and the next step.
// Notice period, Department, Source… stay one click away under ⚙ Columns.
const DEFAULT_COLS = ['candidate', 'phone', 'skills', 'experience', 'ctc', 'stage', 'next'];
const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id));
// Client Feedback Pending shows its own list (spec §7).
const FEEDBACK_COLUMNS = ['candidate', 'client', 'requirement', 'ivdate', 'waiting', 'next'];
// The Rejected tab shows its own set (change list §10): Job (client) · Rejected by · Reason · Date.
const REJECTED_COLUMNS = [
  { id: 'candidate', label: 'Candidate', locked: true },
  { id: 'rjjob', label: 'Job (client)' },
  { id: 'rjby', label: 'Rejected by' },
  { id: 'rjreason', label: 'Reason' },
  { id: 'rjdate', label: 'Date' },
  { id: 'rjfit', label: 'Still a good fit for' },
  { id: 'next', label: '' },
];
const SORT_OPTIONS = [
  ['applied', 'Added date'], ['lastContact', 'Last contact'], ['fit', 'Fit %'], ['experience', 'Experience'], ['ctc', 'CTC'], ['followUp', 'Follow-up date'], ['stage', 'Step'],
  ['due', 'Due date'], ['interview', 'Interview date'], ['activity', 'Last activity'],
  ['created', 'Newest'], ['name', 'Name'],
];
const MASTER_SORTS = [['created', 'Added'], ['name', 'Name'], ['activity', 'Last update']];
// Built-in Saved Views (filters only — the server still decides what each
// login may see).
const SAVED_PRESETS = [
  { name: 'Needs my action', hint: 'Your next moves', filters: { view: 'pipeline', sub: 'all', quick: 'my_pending' } },
  { name: 'My candidates', hint: 'On jobs you are named on', filters: { view: 'pipeline', sub: 'all', quick: 'my_candidates' } },
  { name: 'Late', hint: 'Due date before today', filters: { view: 'pipeline', sub: 'all', quick: 'overdue' } },
  { name: 'Waiting for client feedback', hint: 'Client interview done, no feedback yet', filters: { view: 'pipeline', sub: 'all', quick: 'client_feedback' } },
  { name: 'Check by team lead', hint: 'Waiting for the team lead', filters: { view: 'pipeline', sub: 'active', filters: { stage: 'st:tl_review' } } },
  { name: 'Interviews today', filters: { view: 'pipeline', sub: 'all', quick: 'today_interviews' } },
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

// Archive: Team lead / Admin / Super Admin (the server checks again).
const ARCHIVE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL'];
const mayArchive = (user) => !!user && (ARCHIVE_ROLES.includes(user.role) || ARCHIVE_ROLES.includes(productRole(user, 'ats')));
// "2 days ago" / "Today" / "Never".
function agoText(v) {
  if (!v) return 'Never';
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 31) return `${d} days ago`;
  return protoDate(v);
}
const REJECTED_BEFORE = [['yes', 'Yes, rejected before'], ['no', 'Never rejected']];

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
  const [rowFlash, setRowFlash] = useState(null);
  const [returnFor, setReturnFor] = useState(null);
  const [rowKind, setRowKind] = useState(null);
  const [rowBusy, setRowBusy] = useState('');
  // ATS layout v3: the filter bar's date range (Added date), the cards, and
  // the step popup (Verify · TL check · BDE Review · Client response · Joined).
  const [dateRange, setDateRange] = useState({ range: '', from: '', to: '' });
  const [cards, setCards] = useState(null);
  const [stepPopup, setStepPopup] = useState(null);

  const [pageSize, setPageSize] = useStoredState(`tl.candidates.pageSize.${uid}`, 25, (v) => PAGE_SIZES.includes(v));
  const [sort, setSort] = useStoredState(`tl.candidates.sort.${uid}`, { key: 'applied', dir: 'desc' },
    (v) => v && SORT_OPTIONS.some(([k]) => k === v.key));
  const [masterSort, setMasterSort] = useStoredState(`tl.candidates.msort.${uid}`, { key: 'created', dir: 'desc' },
    (v) => v && MASTER_SORTS.some(([k]) => k === v.key));
  // v3: the ATS Pipeline column set (Candidate | Requirement | Client | Stage |
  // Owner | Next Action | Due).
  const [cols, setCols] = useStoredState(`tl.candidates.cols.v6.${uid}`, DEFAULT_COLS,
    (v) => Array.isArray(v) && v.length > 0 && v.every((id) => COLUMN_IDS.has(id)));
  const [page, setPage] = useState(1);
  // cand7_: List | Progress board (pipeline view, TeamLink staff).
  const [layout, setLayout] = useStoredState(`tl.candidates.layout.${uid}`, 'list', (v) => ['list', 'board'].includes(v));
  const boardAllowed = !['CLIENT', 'CANDIDATE'].includes(user?.role);
  const onBoard = boardAllowed && layout === 'board' && main === 'pipeline';
  const [moreBulk, setMoreBulk] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null);
  const ioAccess = useAtsIoAccess();
  const mayExportSel = !!(ioAccess && (ioAccess.exports || {}).candidates);

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
    ['add', 'status', 'stage', 'followUp', 'quick', 'layout'].forEach((k) => sp.delete(k));
    ownWrite.current = true;
    setSearchParams(sp, { replace: true });
  }
  function goMain(m) {
    setMain(m);
    setQuick('');
    setSelected(new Map());
    writeUrl(m, m === 'master' ? masterSub : pipeSub);
  }
  function goPipeSub(s) {
    setPipeSub(s); setQuick(''); writeUrl('pipeline', s);
    // The board shows the live steps; Hold / Selected / Joined / Rejected are lists.
    if (onBoard && !['all', 'active'].includes(s)) setLayout('list');
  }
  function goMasterSub(s) { setMasterSub(s); writeUrl('master', s); }

  // React Router keeps this page mounted when only the query string changes
  // (sidebar entries, dashboard rows), so the URL is re-read here.
  const qsKey = searchParams.toString();
  // ?layout=board|list wins when present (the Requirement page's "View
  // Pipeline" opens the board for that job) and becomes the user's choice.
  useEffect(() => {
    const l = String(searchParams.get('layout') || '').toLowerCase();
    if (['board', 'list'].includes(l)) setLayout(l);
  }, [qsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The List / Progress board buttons: the user's own choice from then on.
  function pickLayout(l) {
    setLayout(l);
    if (searchParams.get('layout')) {
      const sp = new URLSearchParams(searchParams);
      sp.delete('layout');
      ownWrite.current = true;
      setSearchParams(sp, { replace: true });
    }
  }
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
  const typedNow = TYPED_KEYS.map((k) => String(filters[k] || '').trim()).join('\u0001');
  const [typed, setTyped] = useState(typedNow);
  useEffect(() => {
    const t = setTimeout(() => setTyped(typedNow), 450);
    return () => clearTimeout(t);
  }, [typedNow]);

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
      if (!v || k === 'search' || TYPED_KEYS.includes(k)) return;
      if (master && PIPELINE_ONLY.includes(k)) return;
      if (!master && MASTER_ONLY.includes(k)) return;
      p[k] = v;
    });
    if (!master) {
      typed.split('\u0001').forEach((v, i) => { if (v) p[TYPED_KEYS[i]] = v; });
    }
    return p;
  }, [main, pipeSub, masterSub, sort, masterSort, hier, hierTree.data, quick, search, filters, typed, inactiveDays]);
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
      .catch((err) => { if (mine === seq.current) setLoadError(err.response?.data?.error || 'Could not load the list. Please try again.'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [baseKey, page, pageSize, tick, listOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // A response belongs to the view it was asked for — never draw master rows
  // in the pipeline table while the next page is on its way.
  const fresh = data && data.view === (main === 'master' ? 'master' : 'pipeline') ? data : null;
  const rows = (fresh && fresh.rows) || [];
  const counts = (fresh && fresh.counts) || { views: {}, subs: {}, quick: {}, stageOptions: [] };
  const viewCounts = (data && data.counts && data.counts.views) || {};
  const defs = (fresh && fresh.definitions) || {};

  // Filter options with counts, cascading (spec 2026-10-03 §B): the server
  // counts each option over the pipeline with every OTHER filter applied —
  // the same params the list sends, without page / sort.
  const facetParams = useMemo(() => {
    const { sort: _s, dir: _d, ...rest } = baseParams; // eslint-disable-line no-unused-vars
    return rest;
  }, [baseParams]);
  const { facets, loading: facetsLoading } = useFacets('candidates', facetParams, { enabled: main !== 'job-portal' });
  const facetLabel = (key, value) => ((facets[key] || []).find((o) => String(o.value) === String(value)) || {}).label;
  // How it works: the count at each step, over everything in your area with
  // the other filters on; a click shows the people at that step.
  const stepCounts = usePipelineSteps(facetParams, { enabled: main === 'pipeline' });
  const stepOn = stepOfStageFilter(filters.stage);
  function pickStep(id) {
    if (id === 'job') { navigate('/requirements'); return; }
    setFilter({ stage: id ? stepStageFilter(id) : '' });
    if (id) {
      setQuick('');
      if (pipeSub !== 'all') goPipeSub('all');
    }
  }
  const plainStep = (o) => (filters.hiring === 'internal' ? o.label : (STEP_PLAIN[o.key] || o.label));

  // --- ATS layout v3: the filter bar (Department · Date range · Client ·
  // Recruiter / BDE) is a front for the list's own filters, so the list,
  // the board, the cards and the Filters panel stay one set. Options come
  // from the candidates facets (cascading, with counts).
  const pfValue = {
    department: hier.department || '',
    clientId: filters.clientId || '',
    recruiterId: hier.recruiter || '',
    bdeId: filters.bde || '',
    range: dateRange.range,
    from: dateRange.from,
    to: dateRange.to,
  };
  function setPageFilters(v) {
    const n = v || {};
    setHier((h) => ({ ...h, department: n.department || '', ...(n.department !== h.department ? { section: '' } : {}), recruiter: n.recruiterId || '' }));
    const d = rangeDates(n.range || '', n.from || '', n.to || '');
    setDateRange({ range: n.range || '', from: n.from || '', to: n.to || '' });
    setFilters((f) => ({
      ...f,
      clientId: n.clientId || '',
      ...(n.clientId !== f.clientId ? { requirementId: '' } : {}),
      bde: n.bdeId || '',
      appliedFrom: d.from || '',
      appliedTo: d.to || '',
    }));
  }
  const pfOptions = {
    department: withCurrent(facets.department, hier.department),
    clientId: withCurrent(facets.clientId, filters.clientId),
    people: [
      ...withCurrent(facets.recruiter, hier.recruiter, personLabel(hier.recruiter)).map((o) => ({ ...o, value: `rec:${o.value}`, group: 'Recruiters' })),
      ...(tierOf(user) !== 'bde' ? withCurrent(facets.bde, filters.bde, personLabel(filters.bde)).map((o) => ({ ...o, value: `bde:${o.value}`, group: 'Client managers (BDE)' })) : []),
    ],
  };

  // --- ATS layout v3: the cards (GET /candidates/cards) -----------------------
  const cardParams = useMemo(() => {
    const { view: _v, sub: _s, paged: _p, ...rest } = facetParams; // eslint-disable-line no-unused-vars
    return rest;
  }, [facetParams]);
  const cardKey = JSON.stringify(cardParams);
  useEffect(() => {
    if (main === 'job-portal' || ['CLIENT', 'CANDIDATE'].includes(user?.role)) return undefined;
    let live = true;
    api.get('/candidates/cards', { params: cardParams })
      .then((r) => { if (live) setCards(r.data); })
      .catch(() => { if (live) setCards(null); });
    return () => { live = false; };
  }, [cardKey, tick, main]); // eslint-disable-line react-hooks/exhaustive-deps
  // Card → its list (drill-down).
  function openCard(which) {
    const reset = {
      stage: '', status: '', contactAge: '', available: '', followUp: '', contact: '',
    };
    setQuick('');
    if (which === 'available') {
      setFilters((f) => ({ ...f, ...reset, available: '1' }));
      setMain('master'); setMasterSub('all'); writeUrl('master', 'all');
      return;
    }
    const patch = which === 'unverified' ? { stage: SOURCED_STAGES }
      : which === 'nf7' ? { contactAge: '7' } : which === 'nf30' ? { contactAge: '30' } : {};
    const sub = which === 'total' ? 'all' : 'active';
    setFilters((f) => ({ ...f, ...reset, ...patch }));
    setMain('pipeline'); setPipeSub(sub); writeUrl('pipeline', sub);
    if (onBoard && which !== 'total') setLayout('list');
  }
  const cardOn = filters.available === '1' ? 'available' : filters.contactAge === '30' ? 'nf30' : filters.contactAge === '7' ? 'nf7'
    : filters.stage === SOURCED_STAGES ? 'unverified' : '';

  // Who gets which filter. Client options carry the client NAME only, so
  // every login may filter by client (user decision 2026-10-03).
  const levels = (hierTree.data && hierTree.data.viewer && hierTree.data.viewer.levels) || {};
  const show = {
    source: tier === 'admin' || tier === 'tl',
    bde: tier !== 'recruiter' && tier !== 'bde',
    tl: !!levels.tl,
    recruiter: !!levels.recruiter,
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
    addToJob: can(user, 'ats', 'candidates', 'Applications', 'create'),
  };
  async function exportSelected() {
    setBulkMsg(null);
    try {
      const out = await runAtsExport('candidates', {
        view: `pipeline-${pipeSub}`, params: { ...baseParams, all: '1' }, ids: [...selected.keys()], scope: 'view',
      }, 'xlsx');
      setBulkMsg({ ok: true, text: out.text });
    } catch (err) {
      setBulkMsg({ ok: false, text: 'The export could not be made. Try again, or use Export at the top.' });
    }
  }

  // --- One-click row actions ---------------------------------------------------
  const openRow = (r) => setDrawer({ candidateId: r.candidateId || r.id, applicationId: r.candidateId ? r.id : null });
  async function rowAct(c, a) {
    if (!c.latestApplicationId) return;
    if (a.kind === 'return') { setReturnFor(c); return; }
    if (a.kind === 'schedule') { setRowKind({ kind: 'interview', items: [itemOf(c)] }); return; }
    // e2e gaps 2 / 10: the offer is prepared on the profile; Offers screen link.
    if (a.kind === 'link') { navigate(a.href); return; }
    if (a.kind === 'prepare_offer') { openRow(c); return; }
    // ATS layout v3: Verify · TL check · BDE Review · Client response · Joined.
    if (a.kind === 'popup') {
      setStepPopup({
        kind: a.popup === 'reject_client' ? 'reject' : a.popup,
        presetBy: a.popup === 'reject_client' ? 'Client' : '',
        app: {
          id: c.latestApplicationId,
          candidateId: c.candidateId,
          name: c.name,
          stage: c.currentStage,
          internal: !!c.internal,
          facts: {
            skills: c.skills, experienceYears: c.experienceYears, noticePeriod: c.noticePeriod, currentSalary: c.currentSalary, expectedSalary: c.expectedSalary,
          },
        },
      });
      return;
    }
    setRowBusy(c.id);
    setRowFlash(null);
    try {
      // Same client again (rejections): the server warns, we ask, then resend.
      const sent = await sendWithSameClientCheck((more) => api.patch(`/applications/${c.latestApplicationId}/stage`, { stage: a.to, ...more }));
      if (!sent) return;
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
  const rowCtx = {
    user, onAct: rowAct, menuFor: rowMenuFor, busyId: rowBusy, rejectedTab: main === 'pipeline' && pipeSub === 'rejected',
  };

  function sortBy(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  }
  function clearAll() {
    setFilters(EMPTY_FILTERS);
    setHier(EMPTY_HIERARCHY);
    setQuick('');
    setDateRange({ range: '', from: '', to: '' });
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
  // Filters (n): what is set inside the Filters panel.
  const filterCount = main === 'master'
    ? [hier.department, hier.section, filters.location, filters.source, filters.appliedFrom || filters.appliedTo].filter(Boolean).length
    : [hier.department, hier.section, hier.tl, hier.recruiter, filters.clientId, filters.requirementId, filters.bde,
      filters.stage, filters.status, filters.followUp, filters.location, filters.source, filters.skills,
      filters.minExp || filters.maxExp, filters.notice, filters.maxSalary, filters.minMatch,
      filters.appliedFrom || filters.appliedTo,
      filters.qualificationId, filters.specialisationId, filters.owner, filters.contact, filters.rejectedBefore, filters.rejSide, filters.rejReason].filter(Boolean).length;

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
      const step = PIPELINE_STEPS.find((x) => x.id === stepOfStageFilter(st));
      if (step) return step.label;
      const keys = st.slice(3).split(',');
      return keys.map((k) => STEP_PLAIN[k] || ((counts.stageOptions || []).find((o) => o.key === k) || {}).label || k.replace(/_/g, ' ')).join(', ');
    }
    if (st.startsWith('group:')) return (STAGE_GROUPS.find((g) => g.id === st.slice(6)) || {}).label || st.slice(6);
    return st.slice(6).split(',').map((s) => STAGE_LABELS[s] || s).join(', ');
  })();
  const chips = [
    ...hierarchyChips(hier, hierTree.data, setHier).map((ch) => (ch.value ? ch : {
      ...ch, value: String(hier[ch.key] || '').startsWith('name:') ? hier[ch.key].slice(5) : 'selected person',
    })),
    { key: 'search', label: 'Search', value: filters.search, onRemove: () => setFilter({ search: '' }) },
    { key: 'hiring', label: 'Hiring', value: filters.hiring === 'internal' ? 'Internal' : filters.hiring === 'client' ? 'Client' : '', onRemove: () => setFilter({ hiring: '' }) },
    { key: 'quick', label: 'Show', value: main === 'pipeline' && quick ? (QUICK.find((x) => x[0] === quick) || [])[1] : '', onRemove: () => setQuick('') },
    { key: 'bde', label: 'Client manager', value: filters.bde ? (filters.bde.startsWith('name:') ? filters.bde.slice(5) : 'selected') : '', onRemove: () => setFilter({ bde: '' }) },
    { key: 'client', label: 'Client', value: filters.clientId ? (facetLabel('clientId', filters.clientId) || ((requirements.find((r) => r.clientId === filters.clientId) || {}).client || {}).name || 'selected') : '', onRemove: () => setFilter({ clientId: '', requirementId: '' }) },
    { key: 'req', label: 'Job', value: filters.requirementId ? ((requirements.find((r) => r.id === filters.requirementId) || {}).title || facetLabel('requirementId', filters.requirementId) || 'selected') : '', onRemove: () => setFilter({ requirementId: '' }) },
    { key: 'stage', label: 'Step', value: main === 'pipeline' ? stageChipLabel : '', onRemove: () => setFilter({ stage: '' }) },
    { key: 'status', label: 'Status', value: main === 'pipeline' ? filters.status : '', onRemove: () => setFilter({ status: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => setFilter({ location: '' }) },
    { key: 'source', label: 'Source', value: filters.source, onRemove: () => setFilter({ source: '' }) },
    { key: 'followUp', label: 'Follow-up', value: main === 'pipeline' ? String(filters.followUp || '').replace(/Overdue/g, 'Late').replace(/Due Today/g, 'Due today') : '', onRemove: () => setFilter({ followUp: '' }) },
    { key: 'from', label: 'Applied from', value: filters.appliedFrom, onRemove: () => setFilter({ appliedFrom: '' }) },
    { key: 'to', label: 'Applied to', value: filters.appliedTo, onRemove: () => setFilter({ appliedTo: '' }) },
    { key: 'skills', label: 'Skills', value: main === 'pipeline' ? filters.skills : '', onRemove: () => setFilter({ skills: '' }) },
    {
      key: 'exp',
      label: 'Experience',
      value: main === 'pipeline' && (filters.minExp || filters.maxExp)
        ? (filters.minExp && filters.maxExp ? `${filters.minExp}–${filters.maxExp} yrs` : filters.minExp ? `≥ ${filters.minExp} yrs` : `≤ ${filters.maxExp} yrs`)
        : '',
      onRemove: () => setFilter({ minExp: '', maxExp: '' }),
    },
    { key: 'notice', label: 'Notice period', value: main === 'pipeline' ? filters.notice : '', onRemove: () => setFilter({ notice: '' }) },
    { key: 'salary', label: 'Expected salary', value: main === 'pipeline' && filters.maxSalary ? `≤ ₹${filters.maxSalary}L` : '', onRemove: () => setFilter({ maxSalary: '' }) },
    { key: 'match', label: 'Fit', value: main === 'pipeline' && filters.minMatch ? `≥ ${filters.minMatch}%` : '', onRemove: () => setFilter({ minMatch: '' }) },
    { key: 'qual', label: 'Qualification', value: filters.qualificationId ? (facetLabel('qualificationId', filters.qualificationId) || 'selected') : '', onRemove: () => setFilter({ qualificationId: '' }) },
    { key: 'spec', label: 'Specialization', value: filters.specialisationId ? (facetLabel('specialisationId', filters.specialisationId) || 'selected') : '', onRemove: () => setFilter({ specialisationId: '' }) },
    { key: 'owner', label: 'Owner', value: main === 'pipeline' && filters.owner ? (facetLabel('owner', filters.owner) || 'selected') : '', onRemove: () => setFilter({ owner: '' }) },
    { key: 'contact', label: 'Last contact', value: main === 'pipeline' && filters.contact ? (facetLabel('contact', filters.contact) || filters.contact) : '', onRemove: () => setFilter({ contact: '' }) },
    { key: 'rej', label: 'Rejected before', value: main === 'pipeline' && filters.rejectedBefore ? ((REJECTED_BEFORE.find((x) => x[0] === filters.rejectedBefore) || [])[1] || '') : '', onRemove: () => setFilter({ rejectedBefore: '' }) },
    { key: 'rjside', label: 'Rejected by', value: main === 'pipeline' && filters.rejSide ? (facetLabel('rejSide', filters.rejSide) || filters.rejSide) : '', onRemove: () => setFilter({ rejSide: '' }) },
    { key: 'rjreason', label: 'Reason', value: main === 'pipeline' && filters.rejReason ? filters.rejReason : '', onRemove: () => setFilter({ rejReason: '' }) },
    { key: 'cage', label: 'Not followed up', value: main === 'pipeline' && filters.contactAge ? `${filters.contactAge}+ days` : '', onRemove: () => setFilter({ contactAge: '' }) },
    { key: 'avail', label: 'Show', value: main === 'master' && filters.available === '1' ? 'Available for matching' : '', onRemove: () => setFilter({ available: '' }) },
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

  // resume_: the chosen resume FILE (not just its name) — uploaded to the new
  // candidate right after the save (routes/candidateResumes.js).
  const resumeFileRef = useRef(null);
  // docfill_: the two-choice entry. "Upload the resume" reads it with the
  // SAME parser as the Resume tab (nothing invented), fills the form, marks the
  // fields, and the file itself is uploaded as the ORIGINAL on save (above).
  const fill = useFillFromFile('candidate');
  const ff = (name) => fill.cls(name);
  const ft = (name) => fill.tag(name);
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
    let created = null;
    try {
      created = (await api.post('/candidates', body)).data;
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
    let uploadError = '';
    if (created && created.id && resumeFileRef.current) {
      const fd = new FormData();
      fd.append('file', resumeFileRef.current);
      try { await api.post(`/candidate-resumes/${created.id}/upload`, fd); } catch (err) {
        uploadError = `Candidate saved, but the resume file was not stored: ${err.response?.data?.error || 'upload failed'}`;
      }
    }
    closeForm();
    reload();
    // eslint-disable-next-line no-alert
    if (uploadError) window.alert(uploadError);
    return undefined;
  }

  function closeForm() {
    resumeFileRef.current = null;
    fill.reset();
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

  const rejectedTab = main === 'pipeline' && pipeSub === 'rejected' && quick !== 'client_feedback';
  const visibleCols = rejectedTab ? REJECTED_COLUMNS : quick === 'client_feedback'
    ? FEEDBACK_COLUMNS.map((id) => ({ id, label: { candidate: 'Candidate', client: 'Client', requirement: 'Job', ivdate: 'Interview date', waiting: 'Days waiting', next: 'Next step' }[id], locked: id === 'candidate' }))
    : COLUMNS.filter((c) => c.locked || cols.includes(c.id));
  const masterView = main === 'master';
  // The Job cell carries the client name when the Client column is off.
  const cellCtx = {
    ...rowCtx, showClient: !cols.includes('client'), showJob: !cols.includes('requirement'), contactInStatus: !cols.includes('lastContact'),
  };
  const viewNoun = masterView ? 'candidate' : 'application';

  return (
    <div className="cpl">
      <ListPageHeader
        title="Candidates & Pipeline"
        question="Everyone who applied, and which step they're at."
        sub={main !== 'job-portal'
          ? <ScopeLine user={user} count={fresh ? fresh.scopeTotal : (viewCounts.master || 0)} noun={viewNoun} />
          : <span className="small-muted">New from the job portal — not checked yet</span>}
        data={listOn && (
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
        primary={can(user, 'ats', 'candidates', 'Add Candidate', 'create') && (
          <button className="btn btn-primary" onClick={() => { setError(''); setDupe(null); setShowForm(true); }}>+ Add candidate</button>
        )}
      />

      {cardOn && main !== 'job-portal' && (
        <div className="small-muted cviews-def">
          {{
            unverified: 'Showing: unverified — new people nobody has checked yet.',
            nf7: 'Showing: not followed up for 7+ days (never contacted counts from the day they were added).',
            nf30: 'Showing: not followed up for 30+ days.',
            available: 'Showing: available for matching — not on any live job, not joined, not "Do not use".',
          }[cardOn]}
          {' '}
          <button type="button" className="link-btn" onClick={() => setFilter({ stage: cardOn === 'unverified' ? '' : filters.stage, contactAge: '', available: '' })}>Show everyone</button>
        </div>
      )}
      {stepPopup && (
        <StepPopup
          kind={stepPopup.kind}
          presetBy={stepPopup.presetBy || ''}
          app={stepPopup.app}
          user={user}
          onClose={() => setStepPopup(null)}
          onNeedInterview={(a) => setRowKind({ kind: 'interview', items: [{ id: a.candidateId, rowId: a.id, latestApplicationId: a.id, name: a.name }] })}
          onDone={(x) => { setRowFlash({ ok: true, text: x.text || 'Saved.' }); reload(); }}
        />
      )}

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
          onDone={() => { setRowFlash({ ok: true, text: `${returnFor.name} — sent back to the recruiter.` }); reload(); }}
        />
      )}

      {showForm && fill.entry !== 'form' && (
        <FillEntryModal
          title="Add Candidate"
          target="candidate"
          fill={fill}
          onClose={closeForm}
          onFilled={(r) => {
            const patch = candidateFieldsToForm(r.fields || {});
            if (r.file) { resumeFileRef.current = r.file; patch.resumeName = r.file.name; }
            set(patch);
          }}
        />
      )}
      {showForm && fill.entry === 'form' && (
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
          <FillBanner fill={fill} names={CANDIDATE_FIELD_NAMES} />
          <SectionHead first caps>A. Personal</SectionHead>
          <div className="grid-2">
            <label className={`field${ff('firstName')}`}>
              <span>First Name *{ft('firstName')}</span>
              <input required value={form.firstName} onBlur={checkDuplicate} onChange={(e) => set({ firstName: e.target.value })} />
            </label>
            <label className={`field${ff('lastName')}`}>
              <span>Last Name{ft('lastName')}</span>
              <input value={form.lastName} onBlur={checkDuplicate} onChange={(e) => set({ lastName: e.target.value })} />
            </label>
            <label className={`field${ff('phone')}`}>
              <span>Mobile *{ft('phone')}</span>
              <input required placeholder="10-digit mobile" value={form.phone} onBlur={checkDuplicate} onChange={(e) => set({ phone: e.target.value })} />
            </label>
            <label className={`field${ff('email')}`}>
              <span>Email *{ft('email')}</span>
              <input required value={form.email} onBlur={checkDuplicate} onChange={(e) => set({ email: e.target.value })} />
            </label>
            <label className={`field${ff('dob')}`}>
              <span>Date of Birth{ft('dob')}</span>
              <input type="date" value={form.dob} onChange={(e) => set({ dob: e.target.value })} />
            </label>
            <label className={`field${ff('gender')}`}>
              <span>Gender{ft('gender')}</span>
              <Combo value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
                {CANDIDATE_GENDERS.map((g) => <option key={g}>{g}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('location')}`}>
              <span>Current Location{ft('location')}</span>
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
              onOpen={(m) => { closeForm(); setDrawer({ candidateId: m.id }); }}
              onApplied={(m) => { closeForm(); reload(); setDrawer({ candidateId: m.id }); }}
              onCreateNew={dupAdmin ? createNewProfile : null}
            />
          )}

          <SectionHead caps>B. Professional</SectionHead>
          <div className="grid-2">
            <label className={`field${ff('currentCompany')}`}>
              <span>Current Company{ft('currentCompany')}</span>
              <input value={form.currentCompany} onChange={(e) => set({ currentCompany: e.target.value })} />
            </label>
            <label className={`field${ff('currentDesignation')}`}>
              <span>Current Designation{ft('currentDesignation')}</span>
              <input value={form.currentDesignation} onChange={(e) => set({ currentDesignation: e.target.value })} />
            </label>
            <label className={`field${ff('experienceYears')}`}>
              <span>Total Experience (yrs){ft('experienceYears')}</span>
              <input type="number" step="0.5" value={form.experienceYears} onChange={(e) => set({ experienceYears: e.target.value })} />
            </label>
            <label className="field">
              <span>Relevant Experience (yrs)</span>
              <input type="number" step="0.5" value={form.relevantExperienceYears} onChange={(e) => set({ relevantExperienceYears: e.target.value })} />
            </label>
            <label className={`field${ff('currentSalary')}`}>
              <span>Current Salary (₹L){ft('currentSalary')}</span>
              <input placeholder="e.g. 12L" value={form.currentSalary} onChange={(e) => set({ currentSalary: e.target.value })} />
            </label>
            <label className={`field${ff('expectedSalary')}`}>
              <span>Expected Salary (₹L){ft('expectedSalary')}</span>
              <input placeholder="e.g. 18L" value={form.expectedSalary} onChange={(e) => set({ expectedSalary: e.target.value })} />
            </label>
            <label className={`field${ff('noticePeriod')}`}>
              <span>Notice Period{ft('noticePeriod')}</span>
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
            <label className={`field${ff('education')}`}>
              <span>Highest Qualification{ft('education')}</span>
              <Combo value={form.education} onChange={(e) => set({ education: e.target.value })}>
                {CANDIDATE_EDUCATION.map((x) => <option key={x}>{x}</option>)}
              </Combo>
            </label>
            <label className={`field${ff('specialization')}`}>
              <span>Specialization{ft('specialization')}</span>
              <input placeholder="e.g. Computer Science" value={form.specialization} onChange={(e) => set({ specialization: e.target.value })} />
            </label>
            <label className={`field${ff('institute')}`}>
              <span>Institute{ft('institute')}</span>
              <input value={form.institute} onChange={(e) => set({ institute: e.target.value })} />
            </label>
            <label className={`field${ff('passingYear')}`}>
              <span>Passing Year{ft('passingYear')}</span>
              <input type="number" placeholder="2019" value={form.passingYear} onChange={(e) => set({ passingYear: e.target.value })} />
            </label>
          </div>

          <SectionHead caps>D. Skills</SectionHead>
          <label className={`field${ff('skills')}`}>
            <span>Mandatory Skills * (comma separated){ft('skills')}</span>
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
            <label className={`field${fill.file ? ' ff-found' : ''}`}>
              <span>Upload Resume{fill.file && <span className="ff-tag ok">From your upload — kept as the original</span>}</span>
              <input
                type="file"
                accept=".pdf,.docx,.doc"
                onChange={(e) => { resumeFileRef.current = e.target.files?.[0] || null; set({ resumeName: e.target.files?.[0]?.name || '' }); }}
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
          {/* ATS-100 B5/B6: Referred by (Source = Referral), Campus drive (Source = Campus), consent heard. */}
          <SourceExtras form={form} set={set} />

          <SectionHead caps>G. Job</SectionHead>
          <div className="grid-2">
            <label className="field">
              <span>Add to job</span>
              <Combo value={form.requirementId} onChange={(e) => set({ requirementId: e.target.value })}>
                <option value="">None — add to database only</option>
                {requirements.filter((r) => r.status !== 'CLOSED').map((r) => (
                  <option key={r.id} value={r.id}>{r.title} — {r.internal ? 'TeamLink Internal' : r.client?.name}</option>
                ))}
              </Combo>
            </label>
            <label className="field">
              <span>Job / Client</span>
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
            Fit % is worked out once skills and experience are filled in.
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
      <FirstTips uid={uid} page="candidates" tips={CAND_TIPS} />
      <div className="cviews" role="tablist" aria-label="Candidates views" title={(MAIN_VIEWS.find((v) => v.id === main) || {}).say}>
        {MAIN_VIEWS.filter((v) => v.id !== 'job-portal' || portalTab).map((v) => {
          const n = v.id === 'pipeline' ? viewCounts.pipeline : v.id === 'master' ? viewCounts.master : viewCounts.jobPortal;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={main === v.id}
              title={v.id === 'job-portal' ? `${v.hint}. The number is how many are still waiting to be checked.` : v.hint}
              className={`cviews-btn${main === v.id ? ' is-on' : ''}`}
              onClick={() => goMain(v.id)}
            >
              {v.label}
              {n != null && Number(n) > 0 && <span className="cviews-n">{Number(n).toLocaleString('en-IN')}</span>}
            </button>
          );
        })}
      </div>

      {main === 'job-portal' && portalTab && <JobPortalCandidates onSentToAts={reload} />}

      {main === 'master' && (
        <>
          <StatusTabs
            label="Candidate Master"
            tabs={MASTER_SUBS.filter((s) => (!s.admin || dupAdmin) && (!s.archive || mayArchive(user))).map((s) => ({
              key: s.id,
              label: s.label,
              count: counts.subs ? counts.subs[s.id] : undefined,
              hint: s.id === 'inactive' ? (defs.inactive || s.hint) : s.hint,
            }))}
            value={masterSub}
            onChange={goMasterSub}
            hideZero={!dupAdmin}
            extra={masterSub === 'inactive' && (
              <label className="cpl-sort" title={defs.inactive || ''}>
                No activity for
                <select value={inactiveDays} onChange={(e) => setInactiveDays(Number(e.target.value))}>
                  {INACTIVE_CHOICES.map((d) => <option key={d} value={d}>{`${d} days`}</option>)}
                </select>
              </label>
            )}
          />
          {masterSub === 'duplicates' && dupAdmin && <CandidateDuplicates embedded />}
          {masterSub !== 'duplicates' && (
            <>
              <ListToolbar
                search={filters.search}
                onSearch={(v) => setFilter({ search: v })}
                placeholder="Search name, phone, email, requirement…"
                filterCount={filterCount}
                panel={(
                  <>
                    <div className="cpl-panelbar">
                      <PageFilterBar
                    value={pfValue}
                    onChange={setPageFilters}
                    options={pfOptions}
                    show={{ department: true, dateRange: true, client: true, people: show.recruiter || show.bde }}
                  />
                    </div>
                    <HierarchyFilter value={hier} onChange={setHier} show={{ department: false, tl: false, recruiter: false }} />
                    <PanelField label="Location">
                      <Combo value={filters.location} onChange={(e) => setFilter({ location: e.target.value })} title="Location">
                        <option value="">All locations</option>
                        {LOCS.map((l) => <option key={l}>{l}</option>)}
                      </Combo>
                    </PanelField>
                    {show.source && (
                      <PanelField label="Source">
                        <Combo value={filters.source} onChange={(e) => setFilter({ source: e.target.value })} title="Source">
                          <option value="">All sources</option>
                          {CANDIDATE_FILTER_SOURCES.map((x) => <option key={x}>{x}</option>)}
                        </Combo>
                      </PanelField>
                    )}
                  </>
                )}
                sort={masterSort.key}
                sortOptions={MASTER_SORTS}
                onSort={(k) => setMasterSort({ key: k, dir: masterSort.dir })}
                sortExtra={(
                  <button type="button" className="btn btn-sm" title="Reverse the order" onClick={() => setMasterSort({ key: masterSort.key, dir: masterSort.dir === 'asc' ? 'desc' : 'asc' })}>
                    {masterSort.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
                  </button>
                )}
                right={<span className="small-muted">{loading ? 'Loading…' : 'One row per candidate, however many applications'}</span>}
                chips={chips}
                onClearAll={clearAll}
              />
              {masterSub === 'inactive' && defs.inactive && <div className="small-muted cviews-def">{defs.inactive}</div>}
              {loadError && <div className="error-text">{loadError}</div>}
              <PhoneCards rows={rows} onOpen={openRow} fresh={!!fresh} loading={loading} />
              <div className={`tbl-wrap tbl-fit cpl-tablewrap${loading ? ' cpl-loading' : ''}`}>
                <table className="cpl-table cviews-master">
                  <thead>
                    <tr>
                      <th className="cpl-sticky cpl-sticky-1">Candidate</th>
                      <th>Phone</th>
                      <th>Email</th>
                      <th style={{ textAlign: 'right' }}>Applications</th>
                      <th>Current job</th>
                      <th>Step</th>
                      {masterSub === 'inactive' && <th>Last update</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className={`row-link${drawer && drawer.candidateId === c.id ? ' cpl-row-open' : ''}`} onClick={() => openRow(c)}>
                        <td className="cpl-sticky cpl-sticky-1 cpl-cand">
                          <span className="avatarsm">{initials(c.name)}</span>
                          <span className="cpl-cand-name">{c.name}</span>
                          <RejectedBadge row={c} />
                          {c.partner && <PartnerBadge p={c.partner} />}
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
              {fresh && (
                <ListFooter from={fresh.total ? (fresh.page - 1) * pageSize + 1 : 0} to={Math.min(fresh.page * pageSize, fresh.total)} total={fresh.total} noun={fresh.total === 1 ? 'candidate' : 'candidates'}>
                  <ServerPager total={fresh.total} page={fresh.page} pages={fresh.pages} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} noun="candidates" hideCount />
                </ListFooter>
              )}
            </>
          )}
        </>
      )}

      {main === 'pipeline' && (
        <>
          <HowItWorks uid={uid} page="candidates" counts={stepCounts ? { ...stepCounts } : null} active={stepOn} onPick={pickStep} />
          <StatusTabs
            label="Job applications"
            tabs={PIPE_SUBS.map((s) => ({
              key: s.id, label: s.label, hint: s.hint, count: fresh ? Number((counts.subs || {})[s.id] ?? 0) : undefined,
            }))}
            value={pipeSub}
            onChange={goPipeSub}
            hideZero={!dupAdmin}
            extra={(
              <div className="cpl-quick" role="group" aria-label="Today's work">
                {QUICK_ON_SCREEN.map((id) => {
                  const label = (QUICK.find((x) => x[0] === id) || [])[1];
                  const n = Number((counts.quick || {})[id] ?? 0);
                  return (
                    <button
                      key={id}
                      type="button"
                      title={defs[id] || label}
                      className={`cpl-chip${quick === id ? ' is-on' : ''}${id === 'overdue' && n ? ' is-red' : ''}`}
                      aria-pressed={quick === id}
                      onClick={() => pickQuick(id)}
                    >
                      {label}
                      {n > 0 && <span className="cpl-chip-n">{n.toLocaleString('en-IN')}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          />
          <ListToolbar
            search={filters.search}
            onSearch={(v) => setFilter({ search: v })}
            placeholder="Search name, phone, email or job…"
            filterCount={filterCount}
            panel={(
              <>
                <div className="cpl-panelbar">
                  <PageFilterBar
                    value={pfValue}
                    onChange={setPageFilters}
                    options={pfOptions}
                    show={{ department: true, dateRange: true, client: true, people: show.recruiter || show.bde }}
                  />
                </div>
            <label className="lph-facet">
              <span className="lph-facet-lbl">Skill</span>
              <input type="text" placeholder="e.g. Java, SQL" value={filters.skills} onChange={(e) => setFilter({ skills: e.target.value })} />
            </label>
            <span className="lph-facet">
              <span className="lph-facet-lbl">Experience (years)</span>
              <span className="lph-pair">
                <input type="number" min="0" step="0.5" placeholder="Min" aria-label="Minimum experience (years)" value={filters.minExp} onChange={(e) => setFilter({ minExp: e.target.value })} />
                <input type="number" min="0" step="0.5" placeholder="Max" aria-label="Maximum experience (years)" value={filters.maxExp} onChange={(e) => setFilter({ maxExp: e.target.value })} />
              </span>
            </span>
            <FacetSelect label="Location" allLabel="All locations" value={filters.location} onChange={(v) => setFilter({ location: v })} options={withCurrent(facets.location, filters.location)} loading={facetsLoading} />
            <FacetSelect
              label="Status"
              allLabel="All statuses"
              value={filters.status}
              onChange={(v) => pickStatus(v)}
              options={withCurrent((facets.status || []).map((o) => ({ ...o, label: o.value === 'Hold' ? 'On hold' : o.label })), filters.status)}
              loading={facetsLoading}
            />
                <PanelField label="Show only">
                  <select value={QUICK_IN_FILTERS.some(([id]) => id === quick) ? quick : ''} onChange={(e) => { if (e.target.value) pickQuick(e.target.value); else if (QUICK_IN_FILTERS.some(([id]) => id === quick)) setQuick(''); }}>
                    <option value="">Everyone</option>
                    {QUICK_IN_FILTERS.map(([id, l]) => {
                      const n = Number((counts.quick || {})[id] ?? 0);
                      return <option key={id} value={id}>{n > 0 ? `${l} (${n.toLocaleString('en-IN')})` : l}</option>;
                    })}
                  </select>
                </PanelField>
                <HierarchyFilter value={hier} onChange={setHier} show={{ department: false, tl: false, recruiter: false }} />
                <FacetSelect label="Qualification" allLabel="Any qualification" value={filters.qualificationId} onChange={(v) => setFilter({ qualificationId: v })} options={withCurrent(facets.qualificationId, filters.qualificationId)} loading={facetsLoading} />
                <FacetSelect label="Specialization" allLabel="Any specialization" value={filters.specialisationId} onChange={(v) => setFilter({ specialisationId: v })} options={withCurrent(facets.specialisationId, filters.specialisationId)} loading={facetsLoading} />
                {show.source && (
                  <FacetSelect label="Source" allLabel="All sources" value={filters.source} onChange={(v) => setFilter({ source: v })} options={withCurrent(facets.source, filters.source)} loading={facetsLoading} />
                )}
                <FacetSelect
                  label="Step"
                  allLabel="All steps"
                  value={filters.stage}
                  onChange={(v) => setFilter({ stage: v })}
                  options={withCurrent(
                    [...(counts.stageOptions || []).filter((o) => o.relevant), ...(counts.stageOptions || []).filter((o) => !o.relevant)]
                      .map((o) => ({ value: `st:${o.key}`, label: plainStep(o), count: o.count })),
                    filters.stage,
                    stageChipLabel,
                  )}
                  title="Where the person is now"
                />
                <FacetSelect label="Owner" allLabel="Anyone" value={filters.owner} onChange={(v) => setFilter({ owner: v })} options={withCurrent(facets.owner, filters.owner)} loading={facetsLoading} title="Whose move it is now" />
                <FacetSelect label="Last contact" allLabel="Any time" value={filters.contact} onChange={(v) => setFilter({ contact: v })} options={withCurrent(facets.contact, filters.contact)} loading={facetsLoading} />
                <FacetSelect label="Rejected before" allLabel="Either" value={filters.rejectedBefore} onChange={(v) => setFilter({ rejectedBefore: v })} options={withCurrent(facets.rejectedBefore, filters.rejectedBefore)} loading={facetsLoading} />
                {(pipeSub === 'rejected' || filters.status === 'Rejected' || filters.rejSide || filters.rejReason) && (
                  <>
                    <FacetSelect label="Rejected by" allLabel="Anyone" value={filters.rejSide} onChange={(v) => setFilter({ rejSide: v })} options={withCurrent(facets.rejSide, filters.rejSide)} loading={facetsLoading} />
                    <FacetSelect label="Reject reason" allLabel="Any reason" value={filters.rejReason} onChange={(v) => setFilter({ rejReason: v })} options={withCurrent(facets.rejReason, filters.rejReason)} loading={facetsLoading} />
                  </>
                )}
                <span className="lph-facet wide cpl-panel-sep">More filters</span>
                {user?.atsRole !== 'HR' && (
                  <PanelField label="Hiring type">
                    <select value={filters.hiring || ''} onChange={(e) => setFilter({ hiring: e.target.value, stage: '' })}>
                      <option value="">Client + internal</option>
                      <option value="client">Client jobs</option>
                      <option value="internal">Our own openings (internal)</option>
                    </select>
                  </PanelField>
                )}
                <PanelField label="Saved views">
                  <SavedViews storageKey="cand" current={savedState} onApply={applySaved} presets={SAVED_PRESETS} />
                </PanelField>
                <FacetSelect
                  label="Job"
                  allLabel="All jobs"
                  value={filters.requirementId}
                  onChange={(v) => setFilter({ requirementId: v })}
                  options={withCurrent(facets.requirementId, filters.requirementId, (chips.find((ch) => ch.key === 'req') || {}).value)}
                  loading={facetsLoading}
                />
                {show.tl && (
                  <FacetSelect
                    label="Team lead"
                    allLabel="All team leads"
                    value={hier.tl}
                    onChange={(v) => setHier({ ...hier, tl: v })}
                    options={withCurrent(facets.tl, hier.tl, personLabel(hier.tl))}
                    loading={facetsLoading}
                  />
                )}
                <PanelField label="Follow-up">
                  <select value={filters.followUp} onChange={(e) => setFilter({ followUp: e.target.value })}>
                    <option value="">All follow-ups</option>
                    <option value="Due Today,Overdue">Due now (today + late)</option>
                    {FOLLOWUP_STATUSES.map((x) => <option key={x} value={x}>{x === 'Overdue' ? 'Late' : x === 'Due Today' ? 'Due today' : x}</option>)}
                    <option value="Not set">Not set</option>
                  </select>
                </PanelField>
                <FacetSelect label="Notice period" allLabel="Any notice" value={filters.notice} onChange={(v) => setFilter({ notice: v })} options={withCurrent(facets.notice, filters.notice)} loading={facetsLoading} />
                <PanelField label="Expected salary up to (₹L)">
                  <input type="number" min="0" step="0.5" placeholder="e.g. 12" value={filters.maxSalary} onChange={(e) => setFilter({ maxSalary: e.target.value })} />
                </PanelField>
                <PanelField label="Fit at least (%)">
                  <input type="number" min="0" max="100" step="5" placeholder="e.g. 70" value={filters.minMatch} onChange={(e) => setFilter({ minMatch: e.target.value })} />
                </PanelField>
                {/* v3: Skills · Experience · Location · Status are on screen; Department ·
                    Date · Client · Recruiter / BDE are in the bar on top. */}
              </>
            )}
            sort={sort.key}
            sortOptions={SORT_OPTIONS}
            onSort={(k) => setSort({ key: k, dir: sort.dir })}
            sortExtra={(
              <button type="button" className="btn btn-sm" title={sort.dir === 'asc' ? 'Oldest first — click for newest first' : 'Newest first — click for oldest first'} aria-label="Reverse the order" onClick={() => setSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}>
                {sort.dir === 'asc' ? '↑' : '↓'}
              </button>
            )}
            right={(
              <>
                {loading && !onBoard && <span className="small-muted">Loading…</span>}
                {boardAllowed && (
                  <span className="cpl-layout" role="group" aria-label="Show as">
                    <button type="button" className={layout !== 'board' ? 'is-on' : ''} aria-pressed={layout !== 'board'} onClick={() => pickLayout('list')}>List</button>
                    <button
                      type="button"
                      className={layout === 'board' ? 'is-on' : ''}
                      aria-pressed={layout === 'board'}
                      onClick={() => { pickLayout('board'); clearSelection(); if (!['all', 'active'].includes(pipeSub)) { setPipeSub('active'); writeUrl('pipeline', 'active'); } }}
                    >
                      Progress board
                    </button>
                  </span>
                )}
                {!onBoard && quick !== 'client_feedback' && !rejectedTab && <ColumnChooser columns={COLUMNS} value={cols} onChange={setCols} defaults={DEFAULT_COLS} />}
              </>
            )}
            chips={chips}
            onClearAll={clearAll}
          />
          {quick && defs[quick] && <div className="small-muted cviews-def">{defs[quick]}</div>}
          {rowFlash && (
            <div className={`notice${rowFlash.ok ? '' : ' red'} cpl-flash`}>
              <span>{rowFlash.text}</span>
              <button type="button" className="link-btn" onClick={() => setRowFlash(null)}>Dismiss</button>
            </div>
          )}

          {onBoard && (
            <CandidateBoard
              params={facetParams}
              user={user}
              reloadKey={tick}
              onOpen={(card) => setDrawer({ candidateId: card.candidateId, applicationId: card.id })}
              onNeedInterview={(card) => setRowKind({ kind: 'interview', items: [{ id: card.candidateId, rowId: card.id, latestApplicationId: card.id, name: card.name }] })}
              onChanged={reload}
              jobOptions={withCurrent(facets.requirementId, filters.requirementId, (chips.find((ch) => ch.key === 'req') || {}).value)}
              jobId={filters.requirementId}
              onJob={(v) => setFilter({ requirementId: v })}
            />
          )}
          {!onBoard && selected.size > 0 && (
            <div className="cpl-bulk">
              <b>{`${selected.size.toLocaleString()} application${selected.size === 1 ? '' : 's'} selected`}</b>
              {fresh && selected.size < fresh.total && (
                <button type="button" className="link-btn" onClick={selectAllMatching}>
                  {`Select all ${fresh.total.toLocaleString()} matching`}
                </button>
              )}
              <button type="button" className="link-btn" onClick={clearSelection}>Clear</button>
              <span className="cpl-bulk-sep" />
              {may.assign && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('assign')}>Assign recruiter</button>}
              {may.stage && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('stage')}>Move step</button>}
              {may.addToJob && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('addToJob')}>Add to job</button>}
              {mayExportSel && <button type="button" className="btn btn-sm" onClick={exportSelected}>⬇ Export selected</button>}
              <button type="button" className="link-btn" aria-expanded={moreBulk} onClick={() => setMoreBulk((x) => !x)}>{moreBulk ? 'Fewer actions' : 'More actions'}</button>
              {moreBulk && (
                <>
                  {may.interview && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('interview')}>Schedule interview</button>}
                  {may.call && <button type="button" className="btn btn-sm" onClick={() => setCallQueue(true)}>📞 Call selected</button>}
                  {may.message && [['WhatsApp', '💬 WhatsApp'], ['Email', '📧 Email'], ['SMS', '✉️ SMS']].map(([mode, label]) => (
                    <button key={mode} type="button" className="btn btn-sm" onClick={() => setBulkMode(mode)}>{label}</button>
                  ))}
                  {may.hold && <button type="button" className="btn btn-sm" onClick={() => setBulkKind('hold')}>Put on hold</button>}
                  {may.reject && <button type="button" className="btn btn-sm btn-danger" onClick={() => setBulkKind('reject')}>Reject</button>}
                </>
              )}
              {selectNote && <span className="small-muted">{selectNote}</span>}
              {bulkMsg && <span className={bulkMsg.ok ? 'small-muted' : 'error-text'}>{bulkMsg.text}</span>}
            </div>
          )}

          {!onBoard && loadError && <div className="error-text">{loadError}</div>}
          {!onBoard && (
          <>
          <PhoneCards rows={rows} onOpen={openRow} fresh={!!fresh} loading={loading} />
          <div className={`tbl-wrap tbl-fit cpl-tablewrap${loading ? ' cpl-loading' : ''}`}>
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
                      {col.tip && <Help text={col.tip} />}
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
                    {visibleCols.map((col) => <Cell key={col.id} col={col.id} c={c} ctx={cellCtx} onOpen={() => openRow(c)} />)}
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
            <ListFooter from={fresh.total ? (fresh.page - 1) * pageSize + 1 : 0} to={Math.min(fresh.page * pageSize, fresh.total)} total={fresh.total} noun={fresh.total === 1 ? 'application' : 'applications'}>
              <ServerPager total={fresh.total} page={fresh.page} pages={fresh.pages} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} noun="applications" hideCount />
            </ListFooter>
          )}
          </>
          )}
          {filters.status === 'Rejected' && rows.length > 0 && (
            <div className="notice" style={{ marginTop: 14 }}>
              Rejected people are never deleted: they stay under People, and can still be found and matched to
              other jobs. The client never sees our own reason.
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
          <RejectedBadge row={c} minTimes={ctx && ctx.rejectedTab ? 2 : 1} />
          <div className="small-muted cviews-code">
            {/* v3: the job this row is about, when the Job column is off. */}
            {ctx && ctx.showJob && c.requirementTitle ? `${c.requirementTitle}${c.clientName ? ` · ${c.clientName}` : ''}` : c.code}
            {c.applicationsCount > 1 && <span title="This person applied to other jobs too — see the People tab">{` · ${c.applicationsCount} applications`}</span>}
          </div>
        </td>
      );
    // --- ATS layout v3 columns ---
    case 'skills': {
      const sk = String(c.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
      return (
        <td className="cviews-skills" title={sk.join(', ') || undefined}>
          {sk.length ? <>{sk.slice(0, 3).join(', ')}{sk.length > 3 && <span className="small-muted">{` +${sk.length - 3}`}</span>}</> : dash}
        </td>
      );
    }
    case 'experience': return <td className="cpl-nowrap">{c.experienceYears != null ? `${c.experienceYears} yrs` : dash}</td>;
    case 'ctc':
      return (
        <td className="cpl-nowrap" title={[c.currentSalary && `Now: ${c.currentSalary}`, c.expectedSalary && `Wants: ${c.expectedSalary}`].filter(Boolean).join('\n') || undefined}>
          {c.currentSalary || dash}
          {c.expectedSalary && <div className="small-muted" style={{ fontSize: 11 }}>{`wants ${c.expectedSalary}`}</div>}
        </td>
      );
    case 'notice': return <td className="cell-muted cpl-nowrap">{c.noticePeriod || '—'}</td>;
    case 'requirement':
      return (
        <td className="cviews-req">
          {c.requirementTitle || dash}
          {ctx && ctx.showClient && c.clientName && <div className="small-muted" style={{ fontSize: 11.5 }}>{c.clientName}</div>}
          {c.reqCode && <div className="small-muted" style={{ fontSize: 11 }}>{c.reqCode}</div>}
        </td>
      );
    case 'lastContact':
      if (LastContactCell) return <td className="cpl-nowrap"><LastContactCell row={c} /></td>;
      return (
        <td className="cpl-nowrap" title={c.lastContactAt ? [c.lastContactMode, c.lastContactBy && `by ${c.lastContactBy}`].filter(Boolean).join(' ') : 'Nobody has contacted this person from the app yet'}>
          {c.lastContactAt
            ? <>{agoText(c.lastContactAt)}{c.lastContactMode && <div className="small-muted" style={{ fontSize: 11 }}>{c.lastContactMode}</div>}</>
            : <span className="cviews-late">Never</span>}
        </td>
      );
    case 'fit':
      return <td className="cpl-nowrap">{c.matchScore != null ? <b>{`${c.matchScore}%`}</b> : dash}</td>;
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
    // --- The Rejected tab (rejections, spec 2026-10-03 §A1) ---
    case 'rjjob':
      return (
        <td className="cviews-req">
          {c.requirementTitle || dash}
          <div className="small-muted" style={{ fontSize: 11 }}>{c.internal ? 'TeamLink internal' : (c.clientName || '—')}</div>
        </td>
      );
    case 'rjby': {
      const r = c.rejection || {};
      const dnu = r.kind === 'do_not_use';
      return (
        <td className="cpl-nowrap">
          {r.byLabel || r.sideLabel || <span className="small-muted">Not recorded</span>}
          {dnu && <div><span className={`rjx-badge${r.dnuStatus === 'Pending' ? ' is-wait' : ''}`} style={{ marginLeft: 0 }}>{r.dnuStatus === 'Approved' ? 'Do not use' : r.dnuStatus === 'Pending' ? 'Do not use asked' : 'Do not use declined'}</span></div>}
        </td>
      );
    }
    case 'rjreason': {
      const r = c.rejection || {};
      return (
        <td style={{ maxWidth: 260 }} title={[r.detail, r.fromStage && `Rejected at ${r.fromStage}`].filter(Boolean).join('\n') || undefined}>
          {r.reason || <span className="small-muted">Not recorded</span>}
          {r.detail && <div className="small-muted" style={{ marginTop: 2, lineHeight: 1.35 }}>{String(r.detail).length > 90 ? `${String(r.detail).slice(0, 90)}…` : r.detail}</div>}
        </td>
      );
    }
    case 'rjdate': return <td className="cell-muted cpl-nowrap">{c.rejection && c.rejection.at ? shortDate(c.rejection.at) : '—'}</td>;
    case 'rjfit': return <td style={{ maxWidth: 260, fontSize: 12.5 }}><StillFits candidateId={c.candidateId} /></td>;
    case 'department': return <td className="cell-muted cpl-nowrap">{c.requirementDepartment || '—'}</td>;
    case 'section': return <td className="cell-muted cpl-nowrap">{c.section || '—'}</td>;
    case 'stage':
      return (
        <td>
          {c.currentStage
            ? (
              <>
                <StatusChip status={c.stageGroupLabel}>{c.currentStageLabel || c.stageGroupLabel}</StatusChip>
                {c.stageKey === 'feedback_pending' && <div className="small-muted" style={{ marginTop: 3 }}>Waiting for feedback</div>}
                {c.rejection && (
                  <div className="small-muted" style={{ marginTop: 3 }} title={[c.rejection.reason, c.rejection.detail, c.rejection.by && `Recorded by ${c.rejection.by}`].filter(Boolean).join('\n')}>
                    {`by ${c.rejection.sideLabel}`}
                  </div>
                )}
                {/* v3: Status + last contact in one cell. */}
                {ctx && ctx.contactInStatus && ['Active', 'Hold'].includes(c.pipelineStatus) && (
                  <div className={`small-muted cpl-lc${!c.lastContactAt || c.lastContactDays >= 7 ? ' cviews-late' : ''}`} style={{ marginTop: 3 }}>
                    {`Last contact: ${agoText(c.lastContactAt)}`}
                  </div>
                )}
              </>
            )
            : dash}
        </td>
      );
    case 'owner': {
      const chain = [
        c.requirementDepartment, c.section, c.tlName && `Team lead ${c.tlName}`,
        c.recruiterName && `Recruiter ${c.recruiterName}`, c.bdeName && `Client manager ${c.bdeName}`,
      ].filter(Boolean);
      const live = ['Active', 'Hold'].includes(c.pipelineStatus);
      return (
        <td title={['Department', 'Section', 'Team lead', 'Recruiter', 'Client manager (BDE)'].map((k, i) => `${k}: ${[c.requirementDepartment, c.section, c.tlName, c.recruiterName, c.bdeName][i] || '—'}`).join('\n')}>
          {live && c.owner && c.owner !== '—' ? <b style={{ fontWeight: 600 }}>{c.owner}</b> : (live ? <span className="small-muted" title="Nobody is named for this step. Assign the job, or set a follow-up.">No one named</span> : dash)}
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
          <td className="cell-muted" title="No due date yet. Moving the step or adding a follow-up sets one.">
            <span className="small-muted">No due date</span>
          </td>
        );
      }
      return (
        <td className="cpl-nowrap" title={c.dueSource === 'follow-up' ? 'Due date of the open follow-up' : `Days allowed for this step — started ${c.stageEnteredAt ? protoDate(c.stageEnteredAt) : ''}`}>
          <span className={c.dueStatus === 'overdue' ? 'cviews-late' : undefined}>{dueLabel(c.dueDate)}</span>
          {c.dueStatus === 'overdue' && <div><StatusChip status="Late" /></div>}
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
                <StatusChip status={c.followUp.status}>{c.followUp.status === 'Overdue' ? 'Late' : c.followUp.status === 'Due Today' ? 'Due today' : c.followUp.status}</StatusChip>
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

// B7: "Partner: <name> · yours till <date>" — a person an agency / freelancer sent.
function PartnerBadge({ p }) {
  if (!p) return null;
  const until = p.until ? new Date(`${p.until}T00:00:00`) : null;
  const live = until && until >= new Date();
  return (
    <span
      title={until ? (live ? `Owned by partner ${p.name} until ${p.until}` : `Partner ${p.name}'s ownership ended ${p.until}`) : `Sent by partner ${p.name}`}
      style={{ display: 'inline-block', marginLeft: 6, padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: live ? 'var(--blue-tint)' : 'var(--line-soft)', color: live ? 'var(--blue)' : 'var(--ink-soft)', whiteSpace: 'nowrap' }}
    >
      Partner: {p.name}{p.until ? ` · ${live ? 'till' : 'ended'} ${shortDate ? shortDate(p.until) : p.until}` : ''}
    </span>
  );
}

// ON A PHONE: one card per row instead of the wide table (CSS swaps them).
function PhoneCards({
  rows, onOpen, fresh, loading,
}) {
  return (
    <div className="cpl-cards" aria-label="Candidates">
      {rows.map((c) => (
        <button key={c.id} type="button" className="cpl-card" onClick={() => onOpen(c)}>
          <span className="cpl-card-top">
            <span className="avatarsm">{initials(c.name)}</span>
            <b>{c.name}</b>
            {c.currentStage && <StatusChip status={c.stageGroupLabel}>{c.currentStageLabel || c.stageGroupLabel}</StatusChip>}
          </span>
          <span className="cpl-card-line">{[c.requirementTitle, c.clientName].filter(Boolean).join(' · ') || 'No job yet'}</span>
          {c.partner && <span className="cpl-card-line"><PartnerBadge p={c.partner} /></span>}
          <span className="cpl-card-line small-muted">
            {[c.owner && c.owner !== '—' ? `With ${c.owner}` : null, `Last contact: ${agoText(c.lastContactAt)}`, c.matchScore != null ? `Fit ${c.matchScore}%` : null].filter(Boolean).join(' · ')}
          </span>
          {c.nextAction && c.nextAction !== '—' && <span className={`cpl-card-next${c.dueStatus === 'overdue' ? ' is-late' : ''}`}>{`Next: ${c.nextAction}${c.dueStatus === 'overdue' ? ' (late)' : ''}`}</span>}
        </button>
      ))}
      {fresh && !loading && rows.length === 0 && <div className="small-muted" style={{ padding: 12 }}>No one matches. Try removing a filter.</div>}
      {!fresh && <div className="small-muted" style={{ padding: 12 }}>Loading…</div>}
    </div>
  );
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
            title={a.kind === 'return' ? 'Back to the recruiter, with a reason' : undefined}
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
        {/* No "⋯" menu on the row (simplicity checklist #11): Move step,
            Schedule, Assign, Hold and Reject are visible buttons in the
            candidate window (row click) and in the bar that appears when
            rows are ticked. */}
        {false && menu.length > 0 && <RowMenu items={menu} label={c.name} />}
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

// Server-side pager: page numbers plus rows per page (25 / 50 / 100).
function ServerPager({
  total, page, pages, pageSize, onPage, onPageSize, noun = 'rows', hideCount = false,
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
      {/* With ListFooter around it, "Showing 1 to 25 of N" is already said. */}
      <div className="pager-count" hidden={hideCount && total > 0}>
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
