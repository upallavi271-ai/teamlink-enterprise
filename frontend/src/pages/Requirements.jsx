import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import RequirementForm from '../components/RequirementForm.jsx';
import PostingStatusPanel from '../components/jobs/PostingStatusPanel.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import Pager from '../components/Pager.jsx';
import {
  requirementStatusLabel, requirementIsLive,
} from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { can, canRaiseRequirement, productRole } from '../permissions';
import { splitPersonValue, useAtsWorkers } from '../components/PeopleFilter.jsx';
import AtsDataTools, { useAtsIoAccess } from '../components/AtsDataTools.jsx';
import ExportMenu from '../components/ExportMenu.jsx';
import HierarchyFilter, {
  EMPTY_HIERARCHY, toRequirementParams, hierarchyChips, useHierarchy,
} from '../components/HierarchyFilter.jsx';
import SavedViews from '../components/SavedViews.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ScrollTable from '../components/ScrollTable.jsx';
import ColumnChooser, { useColumns } from '../components/jobs/ColumnChooser.jsx';
import RequirementDrawer from '../components/jobs/RequirementDrawer.jsx';
import RequirementBulk from '../components/jobs/RequirementBulk.jsx';
// Pause (reason + date) / Close (filled or cancelled) — change list 2026-10-03 §5.
import { JobLifecycleDialog } from '../components/jobs/JobLifecycle.jsx';
import RequestJobModal from '../components/jobs/RequestJobModal.jsx';
import { waitingText, secondaryActions } from '../components/jobs/reqActions.js';
import {
  PriorityChip, priorityLabel, ageText, slaInfo, lastActivityText, fmtDay, fmtWhen, nf,
} from '../components/jobs/reqFormat.jsx';
import '../components/jobs/jobs.css';
import '../components/jobs/reqrole.css';
import { ClientPausedBadge } from '../components/clients/ClientLifecycle.jsx';
import ListPageHeader, {
  StatusTabs, ListToolbar, FacetSelect, PanelField, useFacets,
} from '../components/ui/ListPageHeader.jsx';
import { deadlineInfo, DEADLINE_LABEL } from '../components/jobs/deadline.js';
import { useSpecTree, specName, qualName } from '../utils/specMaster'; // spec D
// ATS layout v3 — filters bar → cards (max 6) → charts (max 3) → table.
import PageFilterBar, { rangeDates } from '../components/ui/PageFilterBar.jsx';
import JobsSummary from '../components/jobs/JobsSummary.jsx';
import { JobStatusChip, jobStatusByKey } from '../components/jobs/reqStatus.jsx';
// "A new person gets it in 20–30 s" (user, 2026-10-05).
import {
  HowItWorks, FirstTips, Help, usePipelineSteps, stepStageFilter,
} from '../components/ui/Guide.jsx';

const JOB_TIPS = [
  'Each row is one job: a client (or our company) wants people for it.',
  'Click a row to see who works on it and how many people are at each step.',
  'Press + Add job to start a new one. People for a job are in Candidates & Pipeline.',
];
// The server's tab names still say "Requirement" / "scope": everyday words on screen.
const plainWords = (s) => String(s || '')
  .replace(/\bRequirements\b/g, 'Jobs').replace(/\bRequirement\b/g, 'Job')
  .replace(/\brequirements\b/g, 'jobs').replace(/\brequirement\b/g, 'job')
  .replace(/in your scope/g, 'in your area').replace(/\bOverdue\b/g, 'Late');

// ---------------------------------------------------------------------------
// JOBS / REQUIREMENTS — per role (the user's role spec, 2026-09-29).
//
// Requirements ONLY. No tab strip: Clients is its own ATS menu entry, the
// agreements live in the Clients module, and the Job Portal is candidate
// intake under Candidates & Pipeline.
//
//   chips       per role, FROM THE SERVER (routes/requirements.js roleViewDefs):
//               Recruiter  My Requirements · Open  (Closed only on "Show closed")
//               TL         My Team · Unassigned · Open · Closed
//               BDE        My Clients · Open · Closed
//               Accounts   Joined / Billing
//               Admin/Mgmt All · Open · Closed · My Requirements · Unassigned
//   + Client | Internal filter, Search, Department · Status · Recruiter, More
//   columns     per role (§5); Columns ⚙ offers only what that role may see —
//               and the API does not send a commercial field to a role that
//               may not see it (Fee %, guarantee, invoice status)
//   row         Type badge (CLIENT / INTERNAL), "Assigned to" or an orange
//               Unassigned badge, Days Open (15+ red), mini pipeline
//               Screened → Submitted → Interview → Selected, ONE main action
//   bulk        checkbox for Admin, TL and BDE only
//   top         Add Requirement / Import / Template / Export by permission;
//               "X requirements unassigned" alert for TL / Admin
//
// The list is always scoped by the server; chips, filters and saved views can
// only narrow it. Every action button is also enforced by the API.
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'requirement', label: 'Job ID' },
  { key: 'client', label: 'Client' },
  { key: 'department', label: 'Department' },
  { key: 'position', label: 'Job' },
  { key: 'location', label: 'Location' },
  { key: 'tl', label: 'Team lead' },
  { key: 'recruiter', label: 'Recruiter' },
  { key: 'openings', label: 'Openings', sort: 'openings' },
  { key: 'skills', label: 'Skills' },
  { key: 'priority', label: 'Priority', sort: 'priority' },
  { key: 'daysOpen', label: 'Days open' },
  { key: 'myPipeline', label: 'My progress' },
  { key: 'pipeline', label: 'Progress' },
  { key: 'submittedRequired', label: 'Sent to client / needed' },
  { key: 'submissions', label: 'Sent to client' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'selected', label: 'Selected' },
  { key: 'joined', label: 'Joined' },
  { key: 'fee', label: 'Fee %', commercial: true },
  { key: 'guarantee', label: 'Guarantee', commercial: true },
  { key: 'invoice', label: 'Invoice', commercial: true },
  { key: 'status', label: 'Status' },
  { key: 'nextAction', label: 'Next step' },
  // Columns ⚙ — available, not shown by default.
  { key: 'section', label: 'Section' },
  { key: 'bde', label: 'Client manager (BDE)' },
  { key: 'candidates', label: 'Candidates', sort: 'candidates' },
  { key: 'pendingReview', label: 'Waiting for check' },
  { key: 'stage', label: 'Step' },
  { key: 'sla', label: 'Late?', sort: 'sla' },
  { key: 'lastActivity', label: 'Last activity' },
  { key: 'created', label: 'Posted', sort: 'created' },
  // User 2026-10-03: "12 Oct · 5 days left" (Target date, else Closing date).
  { key: 'deadline', label: 'Deadline' },
];
const ALL_KEYS = COLUMNS.map((c) => c.key);
// One-line ? tips on the headings a new person may not know.
const COL_TIPS = {
  openings: 'How many people the client wants for this job',
  myPipeline: 'Your people on this job, by step',
  pipeline: 'People on this job, by step: checking → sent → interview → selected',
  submittedRequired: 'People sent to the client so far / people the client wants',
  submissions: 'People sent to the client so far',
  daysOpen: 'Days since the job was opened',
  nextAction: 'The one thing to do now on this job',
  sla: 'Late = past the time allowed for its step',
  deadline: 'The date the client wants the job filled by',
  pendingReview: 'People waiting for a recruiter or team lead check',
  status: 'Open = people are being found; On hold = paused; Closed = done',
};

// §5 — the default columns per role (≤ 7, user 2026-10-05: "max 7 columns"),
// and what Columns ⚙ may add. The job code sits under the title; "Job ID"
// is an extra column.
const ROLE_COLS = {
  recruiter: {
    def: ['position', 'client', 'location', 'openings', 'myPipeline', 'status', 'nextAction'],
    extra: ['requirement', 'priority', 'daysOpen', 'skills', 'department', 'stage', 'sla', 'lastActivity', 'created', 'deadline'],
  },
  tl: {
    def: ['position', 'client', 'recruiter', 'submittedRequired', 'daysOpen', 'status', 'nextAction'],
    extra: ['requirement', 'openings', 'priority', 'department', 'section', 'tl', 'location', 'skills', 'pipeline', 'candidates', 'pendingReview', 'stage', 'sla', 'lastActivity', 'created', 'bde', 'deadline'],
  },
  bde: {
    def: ['position', 'client', 'recruiter', 'submissions', 'interviews', 'status', 'nextAction'],
    extra: ['requirement', 'tl', 'openings', 'selected', 'department', 'location', 'priority', 'daysOpen', 'pipeline', 'joined', 'fee', 'guarantee', 'invoice', 'bde', 'candidates', 'stage', 'sla', 'lastActivity', 'created', 'deadline'],
  },
  accounts: {
    def: ['position', 'client', 'joined', 'fee', 'guarantee', 'invoice', 'nextAction'],
    extra: ['requirement', 'department', 'openings', 'status', 'created', 'deadline'],
  },
  // Admin / Management: 7 by default; Department, TL, BDE, Posted, Priority, Days open,
  // Progress and Fee % are one tick away in Columns ⚙.
  admin: {
    def: ['position', 'client', 'recruiter', 'openings', 'deadline', 'status', 'nextAction'],
    extra: ALL_KEYS,
  },
  other: {
    def: ['position', 'client', 'recruiter', 'openings', 'deadline', 'status', 'nextAction'],
    extra: ALL_KEYS.filter((k) => !['myPipeline'].includes(k)),
  },
};
ROLE_COLS.mgmt = ROLE_COLS.admin;

const SORTS = [
  ['created', 'Newest'], ['openings', 'Openings'], ['candidates', 'Candidates'], ['sla', 'Most late first'], ['priority', 'Priority'],
];

// The role this screen is drawn for, from the login's ATS role — the same
// answer the server gives (data.viewRole), known before the first response.
function roleOf(user) {
  const r = (user && user.scopeRoles && user.scopeRoles.ats) || productRole(user, 'ats');
  if (['SUPER_ADMIN', 'ADMIN'].includes(r) || ['SUPER_ADMIN', 'ADMIN'].includes(user && user.role)) return 'admin';
  return {
    MANAGER: 'mgmt', ASSISTANT_MANAGER: 'mgmt', RECRUITER: 'recruiter', TL: 'tl', BDE: 'bde', ACCOUNTANT: 'accounts',
  }[r] || 'other';
}

// Filters. `mine`, `sla`, `closing`, `nocand` have no dropdown — they come
// from saved views and show as chips like any other filter.
const EMPTY_FILTERS = {
  search: '', clientId: '', location: '', bde: '', status: '', priority: '', from: '', to: '', mine: '', sla: '', agreement: '',
  closing: '', nocand: '',
  // Client | Internal split (the actual workflow; internal hiring is not a separate module).
  type: '',
  // Deadline: overdue | week | month | none (routes/requirements.js listWhere).
  deadline: '',
  // spec D: master Qualification / Specialization ids ('none' = not mapped yet).
  qualificationId: '', specialisationId: '',
  // ATS layout v3: the status chain people see (?dstatus=, display only).
  dstatus: '',
};

function simpleStatus(r) {
  if (r.status === 'AGREEMENT_CHECK' || (r.agreementPending && !requirementIsLive(r.status) && r.status !== 'CLOSED' && r.status !== 'ON_HOLD')) return 'Waiting for agreement';
  if (requirementIsLive(r.status)) return 'Open';
  if (r.status === 'ON_HOLD') return 'On Hold';
  if (r.status === 'DRAFT') return 'Draft';
  if (r.status === 'CLOSED') return 'Closed';
  return requirementStatusLabel(r.status);
}

function readSize() {
  try { const v = Number(window.localStorage.getItem('tl.requirements.pageSize')); return [25, 50, 100].includes(v) ? v : 25; } catch { return 25; }
}
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const money = (v) => (v === undefined || v === null ? '—' : `₹${nf(Math.round(Number(v) || 0))}`);

// One row's file, straight from the server's scoped export.
async function exportOne(r) {
  const res = await api.post('/ats-io/export/requirements', JSON.stringify({ params: { ids: r.id }, view: 'all', ids: [r.id] }), {
    params: { format: 'xlsx' }, responseType: 'blob', headers: { 'Content-Type': 'text/plain' },
  });
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = (m && m[1]) || `${r.reqCode || 'requirement'}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export default function Requirements() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const role = roleOf(user);
  // The Add Requirement form loads full client records only for the client
  // desk that may see them (Admin / BDE); everyone else picks from names.
  const clientDesk = ['admin', 'bde'].includes(role) && can(user, null, 'clients', 'Client List', 'view');

  const [data, setData] = useState({ rows: [], total: 0, counts: {}, pages: 1, permissions: {}, views: [] });
  // The server's answer once loaded; before that the same matrix answer.
  const commercial = data.permissions && data.permissions.commercial !== undefined
    ? !!data.permissions.commercial : can(user, 'ats', 'clients', 'Commercial Terms', 'view');
  const roleCols = ROLE_COLS[role] || ROLE_COLS.other;
  // Columns ⚙ may add only the columns this role may see (commercial ones
  // only when the server says this login holds Commercial Terms).
  const allowedCols = useMemo(() => [...new Set([...roleCols.def, ...roleCols.extra])]
    .filter((k) => commercial || !COLUMNS.find((c) => c.key === k)?.commercial), [role, commercial]); // eslint-disable-line react-hooks/exhaustive-deps
  const defaultCols = roleCols.def.filter((k) => allowedCols.includes(k));
  // v6 key: defaults cut to ≤ 9 per role (simplicity checklist 2026-10-03).
  const [cols, setCols] = useColumns(`tl.reqcols7.${user?.id || 'anon'}.${role}`, allowedCols, defaultCols);
  const chooserColumns = COLUMNS.filter((c) => allowedCols.includes(c.key));
  const show = (k) => cols.includes(k) && allowedCols.includes(k);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // '' = the role's default chip (the server decides: §1 default tab).
  const [view, setView] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [sort, setSort] = useState('created');
  const [dir, setDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [size, setSizeState] = useState(readSize);
  const setSize = (s) => { setSizeState(s); try { window.localStorage.setItem('tl.requirements.pageSize', String(s)); } catch { /* ignore */ } };

  // LINKS INTO THIS LIST open it already filtered (People & Workload, the role
  // dashboards, Clients → + New Requirement / View Requirements):
  //   ?view=all|open|closed|mine|team|unassigned|myclients  ?mine=1
  //   ?status= ?clientId= ?type= ?department= ?tlId= ?recruiterId= ?bdeId=
  //   ?new=1 (&clientId=) opens Add Requirement.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlMine = searchParams.get('mine') === '1';
  const urlNew = searchParams.get('new') === '1';
  const urlClient = searchParams.get('clientId') || '';
  const urlView = searchParams.get('view');
  const initial = useMemo(() => ({
    filters: {
      ...EMPTY_FILTERS,
      status: searchParams.get('status') || (urlMine && urlView === 'open' ? 'LIVE' : ''),
      clientId: urlNew ? '' : urlClient,
      type: ['client', 'internal'].includes(searchParams.get('type')) ? searchParams.get('type') : '',
      bde: ['admin', 'mgmt'].includes(role) && searchParams.get('bdeId') ? `id:${searchParams.get('bdeId')}` : '',
      agreement: urlView === 'agreement' || searchParams.get('agreement') === 'pending' ? 'pending' : '',
      // spec D: ?specialisationId= (Reports → Specialization opens its jobs here).
      qualificationId: searchParams.get('qualificationId') || '',
      specialisationId: searchParams.get('specialisationId') || '',
    },
    h: role === 'recruiter' ? EMPTY_HIERARCHY : {
      ...EMPTY_HIERARCHY,
      department: searchParams.get('department') || '',
      tl: searchParams.get('tlId') ? `id:${searchParams.get('tlId')}` : '',
      recruiter: searchParams.get('recruiterId') ? `id:${searchParams.get('recruiterId')}` : '',
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // ?mine=1 → the role's own-work chip (a recruiter's default already is).
    const wanted = urlMine ? (role === 'tl' ? 'team' : role === 'bde' ? 'myclients' : 'mine') : urlView;
    if (wanted && wanted !== 'agreement') setView(wanted);
    // The URL has done its job; keep the address bar clean so Clear really clears.
    if ([...searchParams.keys()].length) setSearchParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The filter panel edits a DRAFT; Apply commits it. Chips show what is
  // applied; removing one applies at once.
  const [applied, setApplied] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const filters = applied.filters;
  const h = applied.h;
  // Spec 2026-10-03 §B: a filter chosen in the Filters panel applies at once
  // (its options are counted over what is applied). Only the search box is
  // a draft — it applies on Enter or after a short pause.
  const setDraftFilter = (patch) => {
    setDraft((d) => ({ ...d, filters: { ...d.filters, ...patch } }));
    if (!('search' in patch)) setApplied((a) => ({ ...a, filters: { ...a.filters, ...patch } }));
  };
  const setDraftH = (next) => { setDraft((d) => ({ ...d, h: next })); setApplied((a) => ({ ...a, h: next })); };
  const applyDraft = () => setApplied(draft);
  useEffect(() => {
    if (draft.filters.search === applied.filters.search) return undefined;
    const t = setTimeout(() => setApplied((a) => ({ ...a, filters: { ...a.filters, search: draft.filters.search } })), 450);
    return () => clearTimeout(t);
  }, [draft.filters.search]); // eslint-disable-line react-hooks/exhaustive-deps
  const removeFilter = (patch, hPatch) => {
    const next = { filters: { ...applied.filters, ...(patch || {}) }, h: hPatch ? { ...applied.h, ...hPatch } : applied.h };
    setApplied(next);
    setDraft(next);
  };
  const clearFilters = () => { const e = { filters: EMPTY_FILTERS, h: EMPTY_HIERARCHY }; setApplied(e); setDraft(e); setBarRange(''); };

  const tree = useHierarchy();
  const workers = useAtsWorkers();
  const ioAccess = useAtsIoAccess();

  // §4 — what each role filters by. A recruiter: Client, Status, Priority —
  // no Recruiter / Department dropdown. Accounts: Client and dates.
  const canFilter = {
    hierarchy: !['recruiter', 'accounts'].includes(role),
    bde: ['admin', 'mgmt'].includes(role),
    agreement: ['admin', 'mgmt', 'bde'].includes(role),
    hiring: !['accounts'].includes(role) && user?.atsRole !== 'HR',
  };

  const [clients, setClients] = useState([]); // names for the Client filter
  const [formClients, setFormClients] = useState(null); // full records for the form
  const [team, setTeam] = useState([]);
  const [showForm, setShowForm] = useState(false);
  // Save & Post: the live per-site posting status, right here (spec §15).
  const [postPanel, setPostPanel] = useState(null);
  const [formClientId, setFormClientId] = useState('');
  const [notice, setNotice] = useState(null);
  // Request a job (per-role spec 2026-10-03): a BDE asks, a Manager / Admin opens it.
  const [showRequest, setShowRequest] = useState(false);
  const mayRequestJob = !canRaiseRequirement(user) && can(user, 'ats', 'requirements', 'Requirement Request', 'create');
  const [drawer, setDrawer] = useState(null);
  const [bulk, setBulk] = useState(null); // { kind, items }
  const [selected, setSelected] = useState(() => new Map());
  const [rowError, setRowError] = useState('');
  const [lifeDialog, setLifeDialog] = useState(null); // { kind: 'pause'|'close', job }

  useEffect(() => {
    api.get('/requirements/client-options').then((res) => setClients(res.data)).catch(() => setClients([]));
  }, []);

  const params = useMemo(() => {
    const p = { ...(canFilter.hierarchy ? toRequirementParams(h, tree.data) : {}) };
    Object.entries(filters).forEach(([k, v]) => { if (v && k !== 'bde') p[k] = v; });
    if (filters.bde) { const b = splitPersonValue(filters.bde); if (b.id) p.bdeId = b.id; else if (b.name) p.bdeName = b.name; }
    return p;
  }, [filters, h, tree.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const paramKey = JSON.stringify(params);

  useEffect(() => { setPage(1); }, [paramKey, view, sort, dir, size, showClosed]);
  useEffect(() => { setSelected(new Map()); }, [paramKey, view]);

  function load() {
    setLoading(true);
    setLoadError('');
    return api.get('/requirements', {
      params: {
        ...params, view: view || undefined, showClosed: showClosed ? '1' : undefined, sort, dir, page, pageSize: size,
      },
    })
      .then((res) => {
        setData(res.data);
        // The server answers which chip it used (the role default on first load).
        if (res.data && res.data.view && res.data.view !== view) setView(res.data.view);
      })
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load jobs. Please try again.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, [paramKey, view, sort, dir, page, size, showClosed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (urlNew && canRaiseRequirement(user)) openForm(urlClient); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openForm(presetClientId = '') {
    setNotice(null);
    setFormClientId(presetClientId || '');
    setShowForm(true);
    if (formClients === null) {
      (clientDesk ? api.get('/clients') : Promise.reject())
        .then((res) => setFormClients(Array.isArray(res.data) ? res.data : (res.data?.rows || clients)))
        .catch(() => setFormClients(clients));
    }
    if (!team.length) {
      api.get('/requirements/assignable-people').then((res) => setTeam(res.data))
        .catch(() => api.get('/ats/team').then((r) => setTeam(r.data)).catch(() => setTeam([])));
    }
  }

  const specTree = useSpecTree(); // spec D: chip labels for the Qualification / Specialization filters
  const activeCount = Object.values(filters).filter(Boolean).length + Object.values(h).filter(Boolean).length;
  const clientName = (id) => clients.find((c) => c.id === id)?.name || 'Selected client';
  const priorityFilterLabel = (v) => (v === 'Urgent,High' ? 'Critical + High' : priorityLabel(v));
  const chips = [
    ...(canFilter.hierarchy ? hierarchyChips(h, tree.data, (next) => removeFilter(null, next)) : []).map((chip) => {
      if (chip.value !== 'Selected person') return chip;
      const list = chip.key === 'tl' ? workers.tls : workers.recruiters;
      const hit = (list || []).find((w) => w.value === h[chip.key]);
      return hit ? { ...chip, value: hit.name } : chip;
    }),
    { key: 'type', label: 'Hiring', value: filters.type === 'internal' ? 'Internal' : filters.type === 'client' ? 'Client' : '', onRemove: () => removeFilter({ type: '' }) },
    { key: 'mine', label: 'Mine', value: filters.mine ? 'Yes' : '', onRemove: () => removeFilter({ mine: '' }) },
    { key: 'sla', label: 'Late', value: filters.sla === 'overdue' ? 'Yes' : '', onRemove: () => removeFilter({ sla: '' }) },
    { key: 'closing', label: 'Closing', value: filters.closing === 'week' ? 'This week' : '', onRemove: () => removeFilter({ closing: '' }) },
    { key: 'nocand', label: 'People', value: filters.nocand ? 'None yet' : '', onRemove: () => removeFilter({ nocand: '' }) },
    { key: 'search', label: 'Search', value: filters.search, onRemove: () => removeFilter({ search: '' }) },
    { key: 'client', label: 'Client', value: filters.clientId ? clientName(filters.clientId) : '', onRemove: () => removeFilter({ clientId: '' }) },
    { key: 'bde', label: 'Client manager (BDE)', value: filters.bde ? (workers.bdes?.find?.((w) => w.value === filters.bde)?.name || splitPersonValue(filters.bde).name || 'Selected person') : '', onRemove: () => removeFilter({ bde: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => removeFilter({ location: '' }) },
    { key: 'status', label: 'Status', value: filters.status ? (filters.status === 'LIVE' ? 'Open' : requirementStatusLabel(filters.status)) : '', onRemove: () => removeFilter({ status: '' }) },
    { key: 'agreement', label: 'Agreement', value: filters.agreement === 'pending' ? 'Waiting' : '', onRemove: () => removeFilter({ agreement: '' }) },
    { key: 'priority', label: 'Priority', value: filters.priority ? priorityFilterLabel(filters.priority) : '', onRemove: () => removeFilter({ priority: '' }) },
    { key: 'from', label: 'Created from', value: filters.from, onRemove: () => removeFilter({ from: '' }) },
    { key: 'to', label: 'Created to', value: filters.to, onRemove: () => removeFilter({ to: '' }) },
    { key: 'deadline', label: 'Deadline', value: DEADLINE_LABEL[filters.deadline] || '', onRemove: () => removeFilter({ deadline: '' }) },
    { key: 'dstatus', label: 'Status', value: filters.dstatus ? (jobStatusByKey(filters.dstatus)?.label || filters.dstatus) : '', onRemove: () => removeFilter({ dstatus: '' }) },
    { key: 'qualificationId', label: 'Qualification', value: filters.qualificationId === 'none' ? 'Not mapped yet' : (filters.qualificationId ? qualName(specTree, filters.qualificationId) || 'Selected' : ''), onRemove: () => removeFilter({ qualificationId: '' }) },
    { key: 'specialisationId', label: 'Specialization', value: filters.specialisationId === 'none' ? 'Not mapped yet' : (filters.specialisationId ? specName(specTree, filters.specialisationId) || 'Selected' : ''), onRemove: () => removeFilter({ specialisationId: '' }) },
  ];

  // SAVED VIEWS: the whole screen state, per user. §8.5 presets: Urgent,
  // Closing this week, No candidates yet — each over the role's own default
  // chip, so a recruiter's "Urgent" is their own urgent requirements.
  const defaultView = data.defaultView || '';
  const savedState = { view, sort, dir, filters, h };
  const viewKeys = (data.views || []).map((v) => v.key);
  const applySaved = (s) => {
    const legacyAgreement = s.view === 'agreement';
    const next = {
      filters: { ...EMPTY_FILTERS, ...(s.filters || {}), ...(legacyAgreement ? { agreement: 'pending' } : {}) },
      h: role === 'recruiter' ? EMPTY_HIERARCHY : { ...EMPTY_HIERARCHY, ...(s.h || {}) },
    };
    setApplied(next);
    setDraft(next);
    setView(viewKeys.includes(s.view) ? s.view : defaultView);
    setSort(SORTS.some(([k]) => k === s.sort) ? s.sort : 'created');
    setDir(s.dir === 'asc' ? 'asc' : 'desc');
  };
  const preset = (name, patch, hint) => ({
    name, hint, filters: { view: defaultView, sort: 'created', dir: 'desc', filters: EMPTY_FILTERS, h: EMPTY_HIERARCHY, ...patch },
  });
  // Shown as up to 4 one-click chips under the tabs (and in Saved views).
  const presets = [
    preset('Urgent', { sort: 'sla', filters: { ...EMPTY_FILTERS, status: 'LIVE', priority: 'Urgent,High' } }, 'Open jobs marked Critical or High'),
    preset('Due this week', { sort: 'sla', filters: { ...EMPTY_FILTERS, closing: 'week' } }, 'Open jobs due in 7 days'),
    preset('No people yet', { filters: { ...EMPTY_FILTERS, status: 'LIVE', nocand: '1' } }, 'Open jobs with no people yet'),
    preset('Late', { sort: 'sla', filters: { ...EMPTY_FILTERS, deadline: 'overdue' } }, 'Jobs past their deadline'),
  ];
  const presetOn = (pr) => sameState(savedState, pr.filters);
  const pickPreset = (pr) => (presetOn(pr)
    ? applySaved({ view: defaultView, sort: 'created', dir: 'desc', filters: EMPTY_FILTERS, h: EMPTY_HIERARCHY })
    : applySaved(pr.filters));

  const clickSort = (key) => {
    if (sort === key) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSort(key); setDir('desc'); }
  };
  const pageObj = {
    total: data.total || 0,
    pages: data.pages || 1,
    size,
    setSize,
    page: data.page || page,
    setPage,
    from: data.total ? ((data.page || page) - 1) * size + 1 : 0,
    to: Math.min((data.page || page) * size, data.total || 0),
  };
  // The pinned first column (Job ID, else Job) is ALWAYS drawn first, then Job,
  // then the rest. With it in the middle, the pinned column slid over its
  // neighbours on a sideways scroll (user, 2026-10-03: "ee window ni proper ga
  // fit cheyyu… mainly Job column").
  const FIRST = ['requirement', 'position'];
  const visible = [
    ...FIRST.map((k) => COLUMNS.find((c) => c.key === k)).filter((c) => c && show(c.key)),
    ...COLUMNS.filter((c) => !FIRST.includes(c.key) && show(c.key)),
  ];
  const counts = data.counts || {};
  const views = data.views || [];
  // How it works: open jobs, then the people at each step (Candidates &
  // Pipeline's own counts, for this client / department when one is picked).
  const stepParams = { ...(filters.clientId ? { clientId: filters.clientId } : {}), ...(h.department ? { department: h.department } : {}) };
  const stepCounts = usePipelineSteps(stepParams, { enabled: role !== 'accounts' });
  const hiwCounts = { ...(stepCounts || {}), ...(counts.open !== undefined ? { job: counts.open } : {}) };
  function pickStep(id) {
    if (!id) return;
    if (id === 'job') { if (views.some((v) => v.key === 'open')) setView('open'); return; }
    const qs = new URLSearchParams({ view: 'pipeline', sub: 'all', stage: stepStageFilter(id) });
    if (filters.clientId) qs.set('clientId', filters.clientId);
    navigate(`/candidates?${qs.toString()}`);
  }
  const tabLabel = views.find((v) => v.key === view)?.label || 'Requirements';

  // §6 — bulk checkbox for Admin, TL and BDE only; each action only when the
  // server says this login holds it.
  const perms = data.permissions || {};
  const mayExport = !!(ioAccess && (ioAccess.exports || {}).requirements);
  const bulkActions = { assign: !!perms.assign, priority: !!perms.approve && role !== 'bde', export: mayExport };
  const canSelect = !!perms.bulk && (bulkActions.assign || bulkActions.priority || bulkActions.export);
  const rowItem = (r) => ({ id: r.id, reqCode: r.reqCode, title: r.title });
  const toggleRow = (r) => setSelected((m) => { const next = new Map(m); if (next.has(r.id)) next.delete(r.id); else next.set(r.id, rowItem(r)); return next; });
  const pageAllSelected = data.rows.length > 0 && data.rows.every((r) => selected.has(r.id));
  const togglePage = () => setSelected((m) => {
    const next = new Map(m);
    if (pageAllSelected) data.rows.forEach((r) => next.delete(r.id));
    else data.rows.forEach((r) => next.set(r.id, rowItem(r)));
    return next;
  });
  const selectedItems = [...selected.values()];

  // Resume a paused job / reopen a closed one (POST /:id/resume | /:id/reopen).
  async function reopenRow(r) {
    setRowError('');
    try {
      const res = await api.post(`/requirements/${r.id}/${r.status === 'ON_HOLD' ? 'resume' : 'reopen'}`, {});
      setNotice({ lines: [`${r.reqCode || r.title}: ${res.data.ok || 'Open again.'}`], tone: '' });
      load();
    } catch (err) {
      setRowError(err.response?.data?.error || 'That did not work. Please try again.');
    }
  }
  async function setStatus(r, status, verb) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${verb} ${r.reqCode || r.title}?`)) return;
    setRowError('');
    try {
      await api.post(`/requirements/${r.id}/status`, { status });
      load();
    } catch (err) {
      setRowError(err.response?.data?.error || `Could not ${verb.toLowerCase()} this job. Please try again.`);
    }
  }
  async function deleteRow(r) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${r.reqCode || r.title} for good? Jobs with people can only be closed.`)) return;
    setRowError('');
    try {
      await api.delete(`/requirements/${r.id}`);
      setNotice({ lines: [`Deleted ${r.reqCode || r.title}.`], tone: '' });
      load();
    } catch (err) {
      setRowError(err.response?.data?.error || 'Could not delete this job. Please try again.');
    }
  }
  // The row's other actions (no "⋯" menu, 2026-10-03): up to 2 small
  // buttons on the row, ALL of them in the quick drawer (row click).
  // A BDE closes (never reopens); Admin may also delete.
  const menuFor = (r) => {
    let items = secondaryActions(r, { mayExport });
    if (role === 'bde') items = items.filter((i) => !['hold', 'reopen'].includes(i.key));
    // A Manager / Assistant Manager acts in their own scope now (2026-10-03);
    // an Assistant Manager / STL holds and resumes only (r.holdOnly).
    if (role === 'recruiter' || role === 'accounts') items = items.filter((i) => ['open', 'export'].includes(i.key));
    if (r.holdOnly) items = items.filter((i) => i.key !== 'close' && !(i.key === 'reopen' && r.status === 'CLOSED'));
    if (r.mayDelete) items = [...items, { key: 'delete', label: 'Delete job', danger: true }];
    return items;
  };
  // The two that sit on the row: Edit, then Pause / Reopen.
  const QUICK_KEYS = ['edit', 'hold', 'reopen'];
  const quickFor = (r, items, mainKey) => QUICK_KEYS
    .map((k) => items.find((i) => i.key === k && i.key !== mainKey)).filter(Boolean).slice(0, 2);
  const QUICK_LABEL = { edit: 'Edit', hold: 'Pause' };
  function pickRowAction(r, key) {
    switch (key) {
      case 'open': navigate(`/requirements/${r.id}`); break;
      case 'edit': navigate(`/requirements/${r.id}?action=edit`); break;
      case 'assign-recruiter': setBulk({ kind: 'assign-recruiter', items: [rowItem(r)], single: true }); break;
      case 'assign-tl': setBulk({ kind: 'assign-tl', items: [rowItem(r)], single: true }); break;
      case 'hold': setLifeDialog({ kind: 'pause', job: rowItem(r) }); break;
      case 'close': setLifeDialog({ kind: 'close', job: rowItem(r) }); break;
      case 'reopen': reopenRow(r); break;
      case 'delete': deleteRow(r); break;
      case 'export': exportOne(r).catch(() => setRowError('Could not export this job. Please try again.')); break;
      // §6 main actions
      case 'add-candidate': navigate(`/candidates?add=1&requirementId=${encodeURIComponent(r.id)}`); break;
      case 'view-candidates': navigate(`/candidates?requirementId=${encodeURIComponent(r.id)}`); break;
      case 'submit-client': navigate(`/candidates?requirementId=${encodeURIComponent(r.id)}&stage=WITH_BDE,BDE_APPROVED`); break;
      case 'generate-invoice': navigate(r.generateTo || r.primaryAction?.to || '/invoices'); break;
      default: break;
    }
  }

  const mini = (p) => (p ? (
    <span className="rr-mini" title="Checked → Sent to client → Interview → Selected">
      <b>{nf(p.screened)}</b><span className="sep">→</span><b>{nf(p.submitted)}</b><span className="sep">→</span><b>{nf(p.interview)}</b><span className="sep">→</span><b>{nf(p.selected)}</b>
    </span>
  ) : <span className="small-muted">—</span>);

  const assigneeLine = (r) => (
    <div className="rr-assignee">
      {r.assignedTo ? <span>{`Assigned to: ${r.assignedTo}`}</span>
        : r.workedBy ? <span title="Worked from the tracker, not formally assigned">{`Worked by: ${r.workedBy}`}</span> : null}
      {r.needs && <span className="rr-unassigned" title={r.needs === 'tl' ? 'No team lead on this job yet' : 'Has a team lead, no recruiter yet'}>{r.needs === 'tl' ? 'Needs a team lead' : 'Needs a recruiter'}</span>}
    </div>
  );
  // The row checkbox sits in the first column: "Job ID" when shown, else "Job".
  const checkKey = show('requirement') ? 'requirement' : 'position';
  const rowCheck = (r) => (canSelect ? (
    <input
      type="checkbox"
      aria-label={`Select ${r.reqCode || r.title}`}
      checked={selected.has(r.id)}
      onClick={(e) => e.stopPropagation()}
      onChange={() => toggleRow(r)}
    />
  ) : null);

  const cell = (c, r) => {
    const p = r.pipelineMini || {};
    switch (c.key) {
      case 'requirement':
        return (
          <td key={c.key} className="sticky-col">
            <div className="req-cell">
              {rowCheck(r)}
              <div style={{ minWidth: 0 }}>
                <span className="req-code">{r.reqCode || r.id.slice(0, 8)}</span>
                <div><span className={`rr-type ${r.internal ? 'internal' : 'client'}`}>{r.internal ? 'Internal' : 'Client'}</span></div>
                {!show('position') && <div className="req-title" title={r.title}>{r.title}</div>}
                {!show('position') && assigneeLine(r)}
              </div>
            </div>
          </td>
        );
      case 'client':
        if (r.internal) return <td key={c.key}><span className="rr-org-internal">TeamLink (internal)</span></td>;
        return (
          <td key={c.key} className="cell-muted">
            {r.clientLink && r.clientId
              ? <Link className="rr-client-link" to={`/clients/${r.clientId}`} onClick={(e) => e.stopPropagation()} title="Open client">{r.client?.name || '—'}</Link>
              : (r.client?.name || '—')}
            {/* Spec 2026-10-03 §A — open job of a paused client: warn. */}
            <ClientPausedBadge lifecycle={r.client?.lifecycle} />
          </td>
        );
      case 'department': return <td key={c.key} className="cell-muted">{r.department || '—'}</td>;
      case 'position':
        return (
          <td key={c.key} className={`pos${checkKey === 'position' ? ' sticky-col' : ''}`}>
            <div className="req-cell">
              {checkKey === 'position' && rowCheck(r)}
              <div style={{ minWidth: 0 }}>
                <span className="req-title" title={r.title}>{r.title || '—'}</span>
                {/* The job code (and Internal) under the title when "Job ID" is not a column. */}
                {!show('requirement') && <div className="small-muted" style={{ fontSize: 11 }}>{`${r.reqCode || r.id.slice(0, 8)}${r.internal ? ' · Internal' : ''}`}</div>}
                {assigneeLine(r)}
              </div>
            </div>
          </td>
        );
      case 'location': return <td key={c.key} className="cell-muted">{r.location || '—'}</td>;
      case 'skills': return <td key={c.key} className="cell-muted" title={r.skills || ''}>{r.skills ? String(r.skills).split(',').slice(0, 3).join(', ') : '—'}</td>;
      case 'section': return <td key={c.key} className="cell-muted">{r.section || '—'}</td>;
      case 'tl': return <td key={c.key} className="cell-muted">{r.tlName || '—'}</td>;
      case 'recruiter':
        return (
          <td key={c.key}>
            {r.workedBy || <span className="small-muted">—</span>}
            {r.coRecruiterNames?.length ? <span className="small-muted">{` +${r.coRecruiterNames.length}`}</span> : null}
            {role !== 'recruiter' && r.workedByPosition && <div className="small-muted" style={{ fontSize: 11 }}>{r.workedByPosition}</div>}
          </td>
        );
      case 'bde': return <td key={c.key} className="cell-muted">{r.bde?.name || '—'}</td>;
      case 'priority': return <td key={c.key}><PriorityChip value={r.priority} /></td>;
      case 'daysOpen':
        return (
          <td key={c.key} className="jobsws-num">
            {r.daysOpen === null || r.daysOpen === undefined
              ? <span className="small-muted">—</span>
              : <span className={`rr-days${r.ageOverdue ? ' overdue' : ''}`} title={r.ageOverdue ? 'Open 15+ days — late' : 'Days since it was added'}>{`${nf(r.daysOpen)} day${r.daysOpen === 1 ? '' : 's'}`}</span>}
          </td>
        );
      case 'myPipeline':
        return (
          <td key={c.key} title="Your people: Checked / Sent to client / Interview">
            <span className="rr-mini"><b>{nf(p.screened)}</b><span className="sep">/</span><b>{nf(p.submitted)}</b><span className="sep">/</span><b>{nf(p.interview)}</b></span>
          </td>
        );
      case 'pipeline': return <td key={c.key}>{mini(r.pipelineMini)}</td>;
      case 'submittedRequired': return <td key={c.key} className="jobsws-num" title="Sent to the client / openings">{`${nf(p.submitted)} / ${nf(r.openings || 1)}`}</td>;
      case 'submissions': return <td key={c.key} className="jobsws-num">{nf(p.submitted)}</td>;
      case 'interviews': return <td key={c.key} className="jobsws-num">{nf(p.interview)}</td>;
      case 'selected': return <td key={c.key} className="jobsws-num">{nf(p.selected)}</td>;
      case 'joined': return <td key={c.key} className="jobsws-num">{nf(r.pipeline?.joined)}</td>;
      case 'fee': return <td key={c.key} className="jobsws-num">{r.commercial && r.commercial.feePercent !== null && r.commercial.feePercent !== undefined ? `${r.commercial.feePercent}%` : <span className="small-muted">—</span>}</td>;
      case 'guarantee': return <td key={c.key} className="cell-muted">{r.commercial && r.commercial.guaranteeDays ? (/^\d+$/.test(String(r.commercial.guaranteeDays).trim()) ? `${r.commercial.guaranteeDays} days` : r.commercial.guaranteeDays) : '—'}</td>;
      case 'invoice': {
        const inv = r.invoice;
        if (!inv) return <td key={c.key}><span className="small-muted">—</span></td>;
        const tone = { Paid: 'green', Overdue: 'red', 'Partially Paid': 'blue', Pending: 'amber' }[inv.status] || 'grey';
        return (
          <td key={c.key}>
            <StatusChip tone={tone}>{inv.status === 'Overdue' ? 'Late' : inv.status}</StatusChip>
            {inv.amount !== undefined && inv.count > 0 && <div className="small-muted rr-money" style={{ fontSize: 11 }}>{`${money(inv.received)} of ${money(inv.amount)}`}</div>}
          </td>
        );
      }
      case 'openings':
        return (
          <td key={c.key} className="jobsws-num">
            {nf(r.openings || 1)}
            {r.filled ? <div className="small-muted" style={{ fontSize: 11 }}>{`${nf(r.filled)} filled`}</div> : null}
          </td>
        );
      case 'candidates':
        return (
          <td key={c.key} className="jobsws-num" title={`${r.activeCandidates ?? 0} active · ${r.candidates ?? 0} in total (incl. rejected / hold)`}>
            {nf(r.activeCandidates ?? r.candidates)}
            {r.candidates > (r.activeCandidates ?? 0) && <span className="small-muted">{` / ${nf(r.candidates)}`}</span>}
          </td>
        );
      case 'pendingReview': return <td key={c.key} className="jobsws-num">{r.pendingReview ? <b>{nf(r.pendingReview)}</b> : <span className="small-muted">—</span>}</td>;
      case 'stage':
        return (
          <td key={c.key}>
            {['—', 'Not live'].includes(r.stage) ? <span className="small-muted">{r.stage}</span> : <StatusChip status={r.stage} tone="amber">{`${r.stage}${r.stageCount ? ` · ${r.stageCount}` : ''}`}</StatusChip>}
          </td>
        );
      case 'sla': {
        const s = slaInfo(r.sla);
        const tone = s ? ({ overdue: 'red', pending: 'amber', active: 'blue' }[s.cls] || 'grey') : null;
        return (
          <td key={c.key}>
            <div className="two-line">
              <span>{ageText(r.ageDays)}</span>
              {s ? <StatusChip tone={tone} title={s.title}>{s.text}</StatusChip> : <span className="small-muted">No deadline</span>}
            </div>
          </td>
        );
      }
      case 'lastActivity':
        return (
          <td key={c.key} title={r.lastActivity ? `${fmtWhen(r.lastActivity.at)}${r.lastActivity.what ? ` — ${r.lastActivity.what}` : ''}` : 'No activity recorded'}>
            {r.lastActivity ? lastActivityText(r.lastActivity) : <span className="small-muted">—</span>}
          </td>
        );
      case 'created': return <td key={c.key} className="cell-muted">{fmtDay(r.createdAt)}</td>;
      case 'deadline': {
        const dl = deadlineInfo(r);
        return (
          <td key={c.key} className={dl.none ? 'cell-muted' : undefined} style={dl.overdue ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
            {dl.text}
          </td>
        );
      }
      case 'status':
        // ATS layout v3 — Draft → Agreement Approved → Assigned → Open →
        // On Hold → Filled / Closed (display label; the stored status is unchanged).
        return <td key={c.key}>{r.displayStatus ? <JobStatusChip job={r} /> : <StatusChip status={simpleStatus(r)} />}</td>;
      case 'nextAction': {
        const act = r.primaryAction || { key: 'open', label: 'View' };
        const wait = waitingText(r);
        const quick = quickFor(r, menuFor(r), act.key);
        return (
          <td key={c.key} onClick={(e) => e.stopPropagation()}>
            <div className="jobsws-rowact">
              <div className="jobsws-next">
                <button
                  type="button"
                  className={`btn btn-sm${act.key === 'open' ? '' : ' btn-primary'}`}
                  onClick={() => pickRowAction(r, act.key)}
                >
                  {act.label}
                </button>
                {wait && role !== 'accounts' && <span className="who" title={wait}>{wait}</span>}
              </div>
              {/* At most 2 small buttons; every other action is in the drawer. */}
              {quick.map((q) => (
                <button key={q.key} type="button" className="btn btn-sm btn-ghost" onClick={() => pickRowAction(r, q.key)}>
                  {QUICK_LABEL[q.key] || q.label}
                </button>
              ))}
            </div>
          </td>
        );
      }
      default: return <td key={c.key} />;
    }
  };

  // The export of this screen: the chip + every filter (routes/requirements.js
  // reads ?rview= so an export is exactly what the chip shows).
  const exportBody = () => ({ params: { ...params, rview: view, ...(showClosed ? { showClosed: '1' } : {}) }, view: 'all' });

  // THE FILTERS PANEL (spec 2026-10-03 §B + the user's Jobs list items):
  // Department, Client, Location, Recruiter, TL, BDE (cascading — every
  // option is counted over the list with the OTHER filters applied, so
  // Medical narrows the rest), Status, Priority, Deadline, Client/Internal,
  // Agreement, Created date. Counts on options; an option with none is not
  // offered (FacetSelect). Server-counted: GET /ats-io/facets/requirements.
  const facetParams = useMemo(() => ({ ...params, rview: view || undefined, ...(showClosed ? { showClosed: '1' } : {}) }), [paramKey, view, showClosed]); // eslint-disable-line react-hooks/exhaustive-deps
  const { facets, loading: facetsLoading } = useFacets('requirements', facetParams);
  const fo = (k) => facets[k] || [];
  const idOf = (v) => (v && v.startsWith('id:') ? v.slice(3) : '');
  const priorityOptions = [
    ...fo('priority').map((o) => ({ ...o, label: priorityLabel(o.value) || o.label })),
    ...(String(filters.priority || '').includes(',') ? [{ value: filters.priority, label: priorityFilterLabel(filters.priority), count: null }] : []),
  ];
  // THE FILTER BAR (ATS layout v3) drives the list's own filters: Department
  // (the hierarchy), Client, Recruiter OR Client manager (BDE) and the date
  // range (the Created date filter). Kept in this screen's state like the rest.
  const [barRange, setBarRange] = useState('');
  const barValue = {
    department: h.department || '',
    range: barRange || (filters.from || filters.to ? 'custom' : ''),
    from: filters.from || '',
    to: filters.to || '',
    clientId: filters.clientId || '',
    recruiterId: idOf(h.recruiter),
    bdeId: idOf(filters.bde),
  };
  const setBar = (v) => {
    const range = v.range || '';
    const d = range === 'custom' ? { from: v.from || '', to: v.to || '' } : rangeDates(range);
    setBarRange(range);
    const deptChanged = (v.department || '') !== (h.department || '');
    const nextH = deptChanged
      ? { ...EMPTY_HIERARCHY, department: v.department || '', recruiter: v.recruiterId ? `id:${v.recruiterId}` : '' }
      : { ...h, recruiter: v.recruiterId ? `id:${v.recruiterId}` : '' };
    removeFilter({
      clientId: v.clientId || '', bde: v.bdeId ? `id:${v.bdeId}` : '', from: d.from || '', to: d.to || '',
    }, nextH);
  };
  const panel = (
    <>
      {/* Most used first: Department, Client, Status, Priority, Deadline. */}
      {/* Department, Client, Recruiter / BDE and the date range are on the filter bar above. */}
      {role !== 'accounts' && <FacetSelect label="Status" allLabel="All statuses" value={filters.status} options={fo('status')} onChange={(v) => setDraftFilter({ status: v })} />}
      <FacetSelect label="Priority" allLabel="All priorities" value={filters.priority} options={priorityOptions} onChange={(v) => setDraftFilter({ priority: v })} />
      <FacetSelect label="Deadline" allLabel="Any deadline" value={filters.deadline} options={fo('deadline')} onChange={(v) => setDraftFilter({ deadline: v })} />
      {canFilter.hierarchy && role !== 'bde' && (
        <HierarchyFilter value={draft.h} onChange={setDraftH} data={tree.data} show={{ department: false, section: true, tl: false, recruiter: false }} />
      )}
      {role !== 'accounts' && <FacetSelect label="Location" allLabel="All locations" value={filters.location} options={fo('location')} onChange={(v) => setDraftFilter({ location: v })} />}
      {/* spec D: cascade from Department (shown once a department is picked,
          or for a role without the Department filter, or while one is set). */}
      {role !== 'accounts' && (!canFilter.hierarchy || h.department || filters.qualificationId || filters.specialisationId) && (
        <>
          <FacetSelect label="Qualification" allLabel="Any qualification" value={filters.qualificationId} options={fo('qualificationId')} loading={facetsLoading} onChange={(v) => setDraftFilter({ qualificationId: v })} />
          <FacetSelect label="Specialization" allLabel="Any specialization" value={filters.specialisationId} options={fo('specialisationId')} loading={facetsLoading} onChange={(v) => setDraftFilter({ specialisationId: v })} />
        </>
      )}
      {canFilter.hierarchy && (
        <FacetSelect label="Team lead" allLabel="All team leads" value={idOf(h.tl)} options={fo('tlId')} loading={facetsLoading}
          onChange={(v) => setDraftH({ ...h, tl: v ? `id:${v}` : '' })} />
      )}
      {canFilter.hiring && <FacetSelect label="Client / Internal" allLabel="Client and internal" value={filters.type} options={fo('type')} onChange={(v) => setDraftFilter({ type: v })} />}
      {canFilter.agreement && (
        <PanelField label="Agreement">
          <select value={filters.agreement} onChange={(e) => setDraftFilter({ agreement: e.target.value })}>
            <option value="">Any agreement</option>
            <option value="pending">Waiting for agreement</option>
          </select>
        </PanelField>
      )}
    </>
  );


  return (
    <div className="reqrole">
      {/* Spec 2026-10-03 §B — title · question · Import / Export / History · ONE primary button. */}
      <ListPageHeader
        title="Jobs"
        question="Every job we are hiring for, and how far each one has got."
        sub={<ScopeLine user={user} count={counts.scopeTotal ?? '…'} noun="job" />}
        data={<AtsDataTools module="requirements" kinds={['requirements']} onImported={load} body={exportBody} />}
        primary={canRaiseRequirement(user)
          ? <button type="button" className="btn btn-primary" onClick={() => openForm()}>+ Add job</button>
          : mayRequestJob ? <button type="button" className="btn btn-primary" onClick={() => setShowRequest(true)}>+ Request job</button> : null}
      />

      {notice && (
        <div className={`notice ${notice.tone === 'amber' ? 'amber' : ''}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            {notice.lines.map((l) => <div key={l}>{l}</div>)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {notice.id && <button type="button" className="btn btn-sm" onClick={() => navigate(`/requirements/${notice.id}`)}>Open job</button>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}

      <FirstTips uid={user?.id} page="jobs" tips={JOB_TIPS} />
      <HowItWorks uid={user?.id} page="jobs" counts={hiwCounts} active={view === 'open' ? 'job' : ''} onPick={pickStep} />

      {/* ATS layout v3 — the same filters bar as every page (cascading,
          server-counted), then the cards and charts, then the table. */}
      <PageFilterBar
        value={barValue}
        onChange={setBar}
        facetParams={facetParams}
        show={{ department: canFilter.hierarchy, dateRange: true, client: true, people: canFilter.hierarchy }}
      />
      <JobsSummary
        params={params}
        views={views.map((v) => v.key)}
        onView={(k) => { setView(k); if (k === 'open' && filters.dstatus) removeFilter({ dstatus: '' }); }}
        onFilter={(patch) => removeFilter(patch)}
        onDepartment={canFilter.hierarchy ? (d) => setDraftH({ ...EMPTY_HIERARCHY, department: h.department === d ? '' : d }) : null}
        activeStatus={filters.dstatus}
        reloadKey={notice}
      />

      {/* Status tabs with counts — a 0 tab is hidden for everyone. */}
      <StatusTabs
        label="Jobs"
        tabs={views.map((v) => ({ key: v.key, label: plainWords(v.label), count: counts[v.key], hint: plainWords(v.hint) }))}
        value={view}
        onChange={setView}
        hideZero
        extra={role === 'recruiter' && (
          <label className="rr-showclosed">
            <input type="checkbox" checked={showClosed} onChange={(e) => { setShowClosed(e.target.checked); if (!e.target.checked && view === 'closed') setView('mine'); }} />
            Show closed
          </label>
        )}
      />

      {/* Up to 4 one-click chips (the saved-view presets). Click again to clear. */}
      <div className="reqq-chips" role="group" aria-label="Quick views">
        {presets.map((pr) => (
          <button key={pr.name} type="button" title={pr.hint} aria-pressed={presetOn(pr)} className={`reqq-chip${presetOn(pr) ? ' is-on' : ''}`} onClick={() => pickPreset(pr)}>
            {pr.name}
          </button>
        ))}
      </div>

      {/* [ Search ] [ Filters (n) ] [ Sort ] — chips + Clear all below.
          Saved views and Columns ⚙ live in the Filters panel footer. */}
      <ListToolbar
        search={draft.filters.search}
        onSearch={(v) => setDraftFilter({ search: v })}
        onSearchSubmit={applyDraft}
        placeholder="Search jobs…"
        filterCount={activeCount - (filters.search ? 1 : 0)}
        panel={panel}
        sort={sort}
        sortOptions={SORTS}
        onSort={(v) => { setSort(v); setDir('desc'); }}
        sortExtra={(
          <button type="button" className="btn btn-sm btn-ghost" title="Reverse the order" onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
            {dir === 'desc' ? '↓' : '↑'}
          </button>
        )}
        panelFooter={(
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 'auto' }}>
            <SavedViews storageKey="req" current={savedState} onApply={applySaved} presets={presets} />
            <ColumnChooser columns={chooserColumns} value={cols.filter((k) => allowedCols.includes(k))} onChange={setCols} defaults={defaultCols} />
          </span>
        )}
        chips={chips}
        onClearAll={activeCount ? clearFilters : undefined}
      />

      {loadError && <div className="notice red">{loadError}</div>}
      {rowError && <div className="notice red" style={{ display: 'flex', justifyContent: 'space-between' }}>{rowError}<button type="button" className="btn btn-sm btn-ghost" onClick={() => setRowError('')}>×</button></div>}

      {canSelect && selected.size > 0 && (
        <div className="reqbulk-bar" role="region" aria-label="Bulk actions">
          <span className="count">{`${nf(selected.size)} selected`}</span>
          {/* "Needs a TL" → Assign TL is the one main action; "Needs a recruiter" → Assign recruiter. */}
          {bulkActions.assign && view !== 'needstl' && <button type="button" className={`btn btn-sm${view === 'unassigned' ? ' btn-primary' : ''}`} onClick={() => setBulk({ kind: 'assign-recruiter', items: selectedItems })}>Assign recruiter</button>}
          {bulkActions.assign && view !== 'unassigned' && <button type="button" className={`btn btn-sm${view === 'needstl' ? ' btn-primary' : ''}`} onClick={() => setBulk({ kind: 'assign-tl', items: selectedItems })}>Assign team lead</button>}
          {bulkActions.priority && <button type="button" className="btn btn-sm" onClick={() => setBulk({ kind: 'priority', items: selectedItems })}>Change priority</button>}
          {bulkActions.export && (
            <ExportMenu
              url="/ats-io/export/requirements"
              body={() => ({ params: { ids: selectedItems.map((x) => x.id).join(',') }, view: 'all', ids: selectedItems.map((x) => x.id) })}
              label={`Export (${selected.size})`}
              note="Only the jobs you picked."
            />
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Map())}>Clear selection</button>
        </div>
      )}

      <div style={{ opacity: loading ? 0.6 : 1 }}>
        <ScrollTable maxHeight={null} bodyClassName="tbl-fit jobsws-table">
          <table>
            <thead>
              <tr>
                {visible.map((c) => {
                  const sticky = c.key === checkKey ? ' sticky-col' : '';
                  const head = (
                    <>
                      {c.key === checkKey && canSelect && (
                        <input
                          type="checkbox"
                          aria-label="Select all on this page"
                          checked={pageAllSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={togglePage}
                          style={{ width: 'auto', marginRight: 8, verticalAlign: 'middle' }}
                        />
                      )}
                      {c.label}
                      {COL_TIPS[c.key] && <Help text={COL_TIPS[c.key]} />}
                      {c.sort && sort === c.sort && <span className="arrow">{dir === 'desc' ? '▼' : '▲'}</span>}
                    </>
                  );
                  return c.sort
                    ? <th key={c.key} className={`jobsws-sort${sticky}`} onClick={() => clickSort(c.sort)} title={`Sort by ${c.label}`}>{head}</th>
                    : <th key={c.key} className={sticky.trim() || undefined}>{head}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className={`row-link${selected.has(r.id) ? ' is-selected' : ''}`} onClick={() => setDrawer(r)}>
                  {visible.map((c) => cell(c, r))}
                </tr>
              ))}
              {!loading && data.rows.length === 0 && (
                <tr>
                  <td colSpan={visible.length}>
                    {activeCount ? (
                      <EmptyState compact title="No jobs match." hint="Clear filters to see all jobs." action={<button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button>} />
                    ) : view === 'mine' && role === 'recruiter' ? (
                      <EmptyState compact icon="💼" title="No jobs for you yet." hint="Ask your team lead to give you a job. It shows here as soon as you are named on it." />
                    ) : (
                      <EmptyState
                        compact
                        icon="💼"
                        title="No jobs here yet."
                        hint={canRaiseRequirement(user) ? 'Press + Add job to add the first one.' : mayRequestJob ? 'Press + Request job, or ask your team lead.' : 'Ask your team lead or the client manager to add one.'}
                        action={canRaiseRequirement(user) ? <button type="button" className="btn btn-sm btn-primary" onClick={() => openForm()}>+ Add job</button> : undefined}
                      />
                    )}
                  </td>
                </tr>
              )}
              {loading && data.rows.length === 0 && (
                <tr><td colSpan={visible.length} className="small-muted" style={{ padding: 16 }}>Loading jobs…</td></tr>
              )}
            </tbody>
          </table>
        </ScrollTable>
      </div>
      <Pager page={pageObj} noun="jobs" />

      {/* Row click opens this quick view; "Open job" goes to the full page.
          It carries every row action that is not on the row itself. */}
      {drawer && (
        <RequirementDrawer
          row={drawer}
          onClose={() => setDrawer(null)}
          onAssign={(r) => setBulk({ kind: 'assign-recruiter', items: [rowItem(r)], fromDrawer: true })}
          actions={menuFor(drawer).filter((a) => a.key !== 'open')}
          onPick={(k) => { const row = drawer; setDrawer(null); pickRowAction(row, k); }}
        />
      )}

      {lifeDialog && (
        <JobLifecycleDialog
          kind={lifeDialog.kind}
          job={lifeDialog.job}
          onClose={() => setLifeDialog(null)}
          onDone={(res) => {
            setNotice({ lines: [`${lifeDialog.job.reqCode || lifeDialog.job.title}: ${res.ok || 'Saved.'}`], tone: '' });
            setLifeDialog(null);
            load();
          }}
        />
      )}

      {bulk && (
        <RequirementBulk
          kind={bulk.kind}
          items={bulk.items}
          onClose={() => setBulk(null)}
          onDone={() => {
            load();
            if (bulk.fromDrawer) setDrawer(null);
            else if (!bulk.single) setSelected(new Map());
          }}
        />
      )}

      {postPanel && <PostingStatusPanel requirementId={postPanel.id} code={postPanel.code} title={postPanel.title} onClose={() => setPostPanel(null)} />}
      {showForm && (
        <RequirementForm
          mode="create"
          clients={formClients || clients}
          team={team}
          initialClientId={formClientId}
          onClose={() => setShowForm(false)}
          onSaved={(saved, info) => {
            const lines = [
              `Saved. ${saved?.reqCode ? `Job ${saved.reqCode}` : 'The job'} is ${requirementStatusLabel(saved?.status)}.`,
              saved?.gateNote,
              info?.posting,
            ].filter(Boolean);
            setNotice({ lines, id: saved?.id, code: saved?.reqCode, tone: saved?.gateNote || info?.warn || /not published|could not/i.test(info?.posting || '') ? 'amber' : '' });
            setShowForm(false);
            // Save & Post: each site's status shows live in the corner panel.
            if (info?.openJob && saved?.id) setPostPanel({ id: saved.id, code: saved.reqCode, title: saved.title });
            setSort('created');
            setDir('desc');
            load();
          }}
        />
      )}
      {showRequest && (
        <RequestJobModal
          endpoint="/requirements/requests"
          clients={clients}
          onClose={() => setShowRequest(false)}
          onSent={(r) => {
            setShowRequest(false);
            setNotice({ lines: [r?.message || 'Request sent.'], id: r?.id, code: r?.reqCode, tone: '' });
            load();
          }}
        />
      )}
    </div>
  );
}
