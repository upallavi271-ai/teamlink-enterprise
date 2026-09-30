import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import RequirementForm from '../components/RequirementForm.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import Pager from '../components/Pager.jsx';
import {
  LOCS, requirementStatusLabel, requirementIsLive, REQUIREMENT_STATUS_CODES,
} from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { can, canRaiseRequirement, productRole } from '../permissions';
import Combo from '../components/Combo.jsx';
import PeopleFilter, { splitPersonValue, useAtsWorkers } from '../components/PeopleFilter.jsx';
import AtsDataTools, { useAtsIoAccess } from '../components/AtsDataTools.jsx';
import ExportMenu from '../components/ExportMenu.jsx';
import HierarchyFilter, {
  EMPTY_HIERARCHY, toRequirementParams, hierarchyChips, useHierarchy,
} from '../components/HierarchyFilter.jsx';
import FilterChips from '../components/FilterChips.jsx';
import SavedViews from '../components/SavedViews.jsx';
import MoreFilters from '../components/ui/MoreFilters.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ScrollTable from '../components/ScrollTable.jsx';
import ColumnChooser, { useColumns } from '../components/jobs/ColumnChooser.jsx';
import RequirementDrawer from '../components/jobs/RequirementDrawer.jsx';
import RequirementBulk from '../components/jobs/RequirementBulk.jsx';
import RowMenu from '../components/jobs/RowMenu.jsx';
import { waitingText, secondaryActions } from '../components/jobs/reqActions.js';
import {
  PriorityChip, PRIORITY_CHOICES, priorityLabel, ageText, slaInfo, lastActivityText, fmtDay, fmtWhen, nf,
} from '../components/jobs/reqFormat.jsx';
import '../components/jobs/jobs.css';
import '../components/jobs/reqrole.css';

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
  { key: 'requirement', label: 'REQ ID' },
  { key: 'client', label: 'Client' },
  { key: 'department', label: 'Dept' },
  { key: 'position', label: 'Position' },
  { key: 'location', label: 'Location' },
  { key: 'tl', label: 'TL' },
  { key: 'recruiter', label: 'Recruiter' },
  { key: 'openings', label: 'Openings', sort: 'openings' },
  { key: 'skills', label: 'Skills' },
  { key: 'priority', label: 'Priority', sort: 'priority' },
  { key: 'daysOpen', label: 'Days Open' },
  { key: 'myPipeline', label: 'My Pipeline' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'submittedRequired', label: 'Submitted / Required' },
  { key: 'submissions', label: 'Submissions' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'selected', label: 'Selected' },
  { key: 'joined', label: 'Joined' },
  { key: 'fee', label: 'Fee %', commercial: true },
  { key: 'guarantee', label: 'Guarantee', commercial: true },
  { key: 'invoice', label: 'Invoice Status', commercial: true },
  { key: 'status', label: 'Status' },
  { key: 'nextAction', label: 'Action' },
  // Columns ⚙ — available, not shown by default.
  { key: 'section', label: 'Section' },
  { key: 'bde', label: 'BDE' },
  { key: 'candidates', label: 'Candidates', sort: 'candidates' },
  { key: 'pendingReview', label: 'Pending Review' },
  { key: 'stage', label: 'Stage' },
  { key: 'sla', label: 'Aging / SLA', sort: 'sla' },
  { key: 'lastActivity', label: 'Last Activity' },
  { key: 'created', label: 'Created', sort: 'created' },
];
const ALL_KEYS = COLUMNS.map((c) => c.key);

// §5 — the default columns per role, and what Columns ⚙ may add.
const ROLE_COLS = {
  recruiter: {
    def: ['requirement', 'client', 'position', 'location', 'openings', 'skills', 'priority', 'daysOpen', 'myPipeline', 'status', 'nextAction'],
    extra: ['department', 'stage', 'sla', 'lastActivity', 'created'],
  },
  tl: {
    def: ['requirement', 'client', 'position', 'recruiter', 'openings', 'submittedRequired', 'daysOpen', 'priority', 'status', 'nextAction'],
    extra: ['department', 'section', 'tl', 'location', 'skills', 'pipeline', 'candidates', 'pendingReview', 'stage', 'sla', 'lastActivity', 'created'],
  },
  bde: {
    def: ['requirement', 'client', 'position', 'tl', 'recruiter', 'openings', 'submissions', 'interviews', 'selected', 'status', 'nextAction'],
    extra: ['department', 'location', 'priority', 'daysOpen', 'pipeline', 'joined', 'fee', 'guarantee', 'invoice', 'bde', 'candidates', 'stage', 'sla', 'lastActivity', 'created'],
  },
  accounts: {
    def: ['requirement', 'client', 'position', 'joined', 'fee', 'guarantee', 'invoice', 'nextAction'],
    extra: ['department', 'openings', 'status', 'created'],
  },
  // "All columns (current + Fee, Age)".
  admin: {
    def: ['requirement', 'client', 'department', 'position', 'tl', 'recruiter', 'openings', 'priority', 'daysOpen', 'pipeline', 'fee', 'status', 'nextAction'],
    extra: ALL_KEYS,
  },
  other: {
    def: ['requirement', 'client', 'department', 'position', 'tl', 'recruiter', 'openings', 'priority', 'daysOpen', 'pipeline', 'status', 'nextAction'],
    extra: ALL_KEYS.filter((k) => !['myPipeline'].includes(k)),
  },
};
ROLE_COLS.mgmt = ROLE_COLS.admin;

const SORTS = [
  ['created', 'Created date'], ['openings', 'Openings'], ['candidates', 'Candidates'], ['sla', 'SLA (most urgent)'], ['priority', 'Priority'],
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
};

function simpleStatus(r) {
  if (r.status === 'AGREEMENT_CHECK' || (r.agreementPending && !requirementIsLive(r.status) && r.status !== 'CLOSED' && r.status !== 'ON_HOLD')) return 'Agreement Pending';
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
  // v4 key: the role spec changed every role's defaults.
  const [cols, setCols] = useColumns(`tl.reqcols4.${user?.id || 'anon'}.${role}`, allowedCols, defaultCols);
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
  const setDraftFilter = (patch) => setDraft((d) => ({ ...d, filters: { ...d.filters, ...patch } }));
  const setDraftH = (next) => setDraft((d) => ({ ...d, h: next }));
  const dirty = !sameState(draft, applied);
  const applyDraft = () => setApplied(draft);
  const removeFilter = (patch, hPatch) => {
    const next = { filters: { ...applied.filters, ...(patch || {}) }, h: hPatch ? { ...applied.h, ...hPatch } : applied.h };
    setApplied(next);
    setDraft(next);
  };
  const clearFilters = () => { const e = { filters: EMPTY_FILTERS, h: EMPTY_HIERARCHY }; setApplied(e); setDraft(e); };

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
  const [formClientId, setFormClientId] = useState('');
  const [notice, setNotice] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [bulk, setBulk] = useState(null); // { kind, items }
  const [selected, setSelected] = useState(() => new Map());
  const [rowError, setRowError] = useState('');

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
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load requirements.'))
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

  const activeCount = Object.values(filters).filter(Boolean).length + Object.values(h).filter(Boolean).length;
  const moreCount = ['location', 'bde', 'agreement', 'from', 'to', ...(role === 'recruiter' || role === 'accounts' || role === 'bde' ? [] : ['clientId']), ...(role === 'recruiter' ? [] : ['priority'])]
    .filter((k) => filters[k]).length + (h.section ? 1 : 0) + (h.tl ? 1 : 0) + (role === 'bde' && (h.department || h.recruiter) ? 1 : 0);
  const clientName = (id) => clients.find((c) => c.id === id)?.name || 'Selected client';
  const priorityFilterLabel = (v) => (v === 'Urgent,High' ? 'Critical + High' : priorityLabel(v));
  const chips = [
    ...(canFilter.hierarchy ? hierarchyChips(h, tree.data, (next) => removeFilter(null, next)) : []).map((chip) => {
      if (chip.value !== 'Selected person') return chip;
      const list = chip.key === 'tl' ? workers.tls : workers.recruiters;
      const hit = (list || []).find((w) => w.value === h[chip.key]);
      return hit ? { ...chip, value: hit.name } : chip;
    }),
    { key: 'type', label: 'Hiring', value: filters.type === 'internal' ? 'Internal (TeamLink)' : filters.type === 'client' ? 'Client' : '', onRemove: () => removeFilter({ type: '' }) },
    { key: 'mine', label: 'Assigned', value: filters.mine ? 'To me' : '', onRemove: () => removeFilter({ mine: '' }) },
    { key: 'sla', label: 'SLA', value: filters.sla === 'overdue' ? 'Overdue' : '', onRemove: () => removeFilter({ sla: '' }) },
    { key: 'closing', label: 'Closing', value: filters.closing === 'week' ? 'This week' : '', onRemove: () => removeFilter({ closing: '' }) },
    { key: 'nocand', label: 'Candidates', value: filters.nocand ? 'None yet' : '', onRemove: () => removeFilter({ nocand: '' }) },
    { key: 'search', label: 'Search', value: filters.search, onRemove: () => removeFilter({ search: '' }) },
    { key: 'client', label: 'Client', value: filters.clientId ? clientName(filters.clientId) : '', onRemove: () => removeFilter({ clientId: '' }) },
    { key: 'bde', label: 'BDE', value: filters.bde ? (workers.bdes?.find?.((w) => w.value === filters.bde)?.name || splitPersonValue(filters.bde).name || 'Selected BDE') : '', onRemove: () => removeFilter({ bde: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => removeFilter({ location: '' }) },
    { key: 'status', label: 'Status', value: filters.status ? (filters.status === 'LIVE' ? 'Open (live)' : requirementStatusLabel(filters.status)) : '', onRemove: () => removeFilter({ status: '' }) },
    { key: 'agreement', label: 'Agreement', value: filters.agreement === 'pending' ? 'Pending' : '', onRemove: () => removeFilter({ agreement: '' }) },
    { key: 'priority', label: 'Priority', value: filters.priority ? priorityFilterLabel(filters.priority) : '', onRemove: () => removeFilter({ priority: '' }) },
    { key: 'from', label: 'Created from', value: filters.from, onRemove: () => removeFilter({ from: '' }) },
    { key: 'to', label: 'Created to', value: filters.to, onRemove: () => removeFilter({ to: '' }) },
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
  const presets = [
    preset('Urgent', { sort: 'sla', filters: { ...EMPTY_FILTERS, status: 'LIVE', priority: 'Urgent,High' } }, 'Live requirements marked Critical or High, most urgent first'),
    preset('Closing this week', { sort: 'sla', filters: { ...EMPTY_FILTERS, closing: 'week' } }, 'Live requirements whose target / closing date is in the next 7 days'),
    preset('No candidates yet', { filters: { ...EMPTY_FILTERS, status: 'LIVE', nocand: '1' } }, 'Live requirements without a single candidate'),
  ];

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
  const visible = COLUMNS.filter((c) => show(c.key));
  const counts = data.counts || {};
  const views = data.views || [];
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

  async function setStatus(r, status, verb) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${verb} ${r.reqCode || r.title}?`)) return;
    setRowError('');
    try {
      await api.post(`/requirements/${r.id}/status`, { status });
      load();
    } catch (err) {
      setRowError(err.response?.data?.error || `Could not ${verb.toLowerCase()} this requirement.`);
    }
  }
  async function deleteRow(r) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${r.reqCode || r.title}? This cannot be undone. A requirement with candidates or invoices cannot be deleted — close it instead.`)) return;
    setRowError('');
    try {
      await api.delete(`/requirements/${r.id}`);
      load();
    } catch (err) {
      setRowError(err.response?.data?.error || 'Could not delete this requirement.');
    }
  }
  // The "⋯" menu: the actions this login may take on the row, beyond the
  // one main button. A BDE closes (never reopens); Admin may also delete.
  const menuFor = (r) => {
    let items = secondaryActions(r, { mayExport });
    if (role === 'bde') items = items.filter((i) => !['hold', 'reopen'].includes(i.key));
    if (role === 'recruiter' || role === 'accounts' || role === 'mgmt') items = items.filter((i) => ['open', 'export'].includes(i.key));
    if (r.mayDelete) items = [...items, { key: 'delete', label: 'Delete requirement', danger: true }];
    return items;
  };
  function pickRowAction(r, key) {
    switch (key) {
      case 'open': navigate(`/requirements/${r.id}`); break;
      case 'edit': navigate(`/requirements/${r.id}?action=edit`); break;
      case 'assign-recruiter': setBulk({ kind: 'assign-recruiter', items: [rowItem(r)], single: true }); break;
      case 'assign-tl': setBulk({ kind: 'assign-tl', items: [rowItem(r)], single: true }); break;
      case 'hold': setStatus(r, 'ON_HOLD', 'Put on hold'); break;
      case 'close': setStatus(r, 'CLOSED', 'Close'); break;
      case 'reopen': setStatus(r, 'OPEN', 'Reopen'); break;
      case 'delete': deleteRow(r); break;
      case 'export': exportOne(r).catch(() => setRowError('The export could not be produced.')); break;
      // §6 main actions
      case 'add-candidate': navigate(`/candidates?add=1&requirementId=${encodeURIComponent(r.id)}`); break;
      case 'view-candidates': navigate(`/candidates?requirementId=${encodeURIComponent(r.id)}`); break;
      case 'submit-client': navigate(`/candidates?requirementId=${encodeURIComponent(r.id)}&stage=WITH_BDE,BDE_APPROVED`); break;
      case 'generate-invoice': navigate(r.generateTo || r.primaryAction?.to || '/invoices'); break;
      default: break;
    }
  }

  const mini = (p) => (p ? (
    <span className="rr-mini" title="Screened → Submitted → Interview → Selected (candidates you can see)">
      <b>{nf(p.screened)}</b><span className="sep">→</span><b>{nf(p.submitted)}</b><span className="sep">→</span><b>{nf(p.interview)}</b><span className="sep">→</span><b>{nf(p.selected)}</b>
    </span>
  ) : <span className="small-muted">—</span>);

  const assigneeLine = (r) => (
    <div className="rr-assignee">
      {r.assignedTo ? <span>{`Assigned to: ${r.assignedTo}`}</span>
        : r.workedBy ? <span title="Worked from the tracker, not formally assigned">{`Worked by: ${r.workedBy}`}</span> : null}
      {r.unassigned && <span className="rr-unassigned" title="No TL, no recruiter and no co-recruiter on this requirement">Unassigned</span>}
    </div>
  );

  const cell = (c, r) => {
    const p = r.pipelineMini || {};
    switch (c.key) {
      case 'requirement':
        return (
          <td key={c.key} className="sticky-col">
            <div className="req-cell">
              {canSelect && (
                <input
                  type="checkbox"
                  aria-label={`Select ${r.reqCode || r.title}`}
                  checked={selected.has(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleRow(r)}
                />
              )}
              <div style={{ minWidth: 0 }}>
                <span className="req-code">{r.reqCode || r.id.slice(0, 8)}</span>
                <div><span className={`rr-type ${r.internal ? 'internal' : 'client'}`}>{r.internal ? 'INTERNAL' : 'CLIENT'}</span></div>
                {!show('position') && <div className="req-title" title={r.title}>{r.title}</div>}
                {!show('position') && assigneeLine(r)}
              </div>
            </div>
          </td>
        );
      case 'client':
        if (r.internal) return <td key={c.key}><span className="rr-org-internal" title="Type: INTERNAL · Organization: TeamLink">TeamLink (internal)</span></td>;
        return (
          <td key={c.key} className="cell-muted">
            {r.clientLink && r.clientId
              ? <Link className="rr-client-link" to={`/clients/${r.clientId}`} onClick={(e) => e.stopPropagation()} title="Open Client 360">{r.client?.name || '—'}</Link>
              : (r.client?.name || '—')}
          </td>
        );
      case 'department': return <td key={c.key} className="cell-muted">{r.department || '—'}</td>;
      case 'position':
        return (
          <td key={c.key} className="pos">
            <span className="req-title" title={r.title}>{r.title || '—'}</span>
            {assigneeLine(r)}
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
              : <span className={`rr-days${r.ageOverdue ? ' overdue' : ''}`} title={r.ageOverdue ? 'Open 15+ days — overdue' : 'Days since it was raised'}>{`${nf(r.daysOpen)}d`}</span>}
          </td>
        );
      case 'myPipeline':
        return (
          <td key={c.key} title="Your candidates: Screened / Submitted / Interview">
            <span className="rr-mini"><b>{nf(p.screened)}</b><span className="sep">/</span><b>{nf(p.submitted)}</b><span className="sep">/</span><b>{nf(p.interview)}</b></span>
          </td>
        );
      case 'pipeline': return <td key={c.key}>{mini(r.pipelineMini)}</td>;
      case 'submittedRequired': return <td key={c.key} className="jobsws-num" title="Submitted to the client / openings">{`${nf(p.submitted)} / ${nf(r.openings || 1)}`}</td>;
      case 'submissions': return <td key={c.key} className="jobsws-num">{nf(p.submitted)}</td>;
      case 'interviews': return <td key={c.key} className="jobsws-num">{nf(p.interview)}</td>;
      case 'selected': return <td key={c.key} className="jobsws-num">{nf(p.selected)}</td>;
      case 'joined': return <td key={c.key} className="jobsws-num">{nf(r.pipeline?.joined)}</td>;
      case 'fee': return <td key={c.key} className="jobsws-num">{r.commercial && r.commercial.feePercent !== null && r.commercial.feePercent !== undefined ? `${r.commercial.feePercent}%` : <span className="small-muted">—</span>}</td>;
      case 'guarantee': return <td key={c.key} className="cell-muted">{r.commercial && r.commercial.guaranteeDays ? (/^\d+$/.test(String(r.commercial.guaranteeDays).trim()) ? `${r.commercial.guaranteeDays} days` : r.commercial.guaranteeDays) : '—'}</td>;
      case 'invoice': {
        const inv = r.invoice;
        if (!inv) return <td key={c.key}><span className="small-muted">—</span></td>;
        const tone = { Paid: 'green', Overdue: 'red', 'Partially Paid': 'amber', Pending: 'amber' }[inv.status] || 'grey';
        return (
          <td key={c.key}>
            <StatusChip tone={tone}>{inv.status}</StatusChip>
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
      case 'pendingReview': return <td key={c.key} className="jobsws-num">{r.pendingReview ? <b>{nf(r.pendingReview)}</b> : <span className="small-muted">0</span>}</td>;
      case 'stage':
        return (
          <td key={c.key}>
            {['—', 'Not live'].includes(r.stage) ? <span className="small-muted">{r.stage}</span> : <StatusChip status={r.stage} tone="amber">{`${r.stage}${r.stageCount ? ` · ${r.stageCount}` : ''}`}</StatusChip>}
          </td>
        );
      case 'sla': {
        const s = slaInfo(r.sla);
        const tone = s ? ({ overdue: 'red', pending: 'amber', active: 'green' }[s.cls] || 'grey') : null;
        return (
          <td key={c.key}>
            <div className="two-line">
              <span>{ageText(r.ageDays)}</span>
              {s ? <StatusChip tone={tone} title={s.title}>{s.text}</StatusChip> : <span className="small-muted">No SLA date</span>}
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
      case 'status': {
        const label = simpleStatus(r);
        return <td key={c.key}><StatusChip status={label} title={`Workflow: ${requirementStatusLabel(r.status)}`} /></td>;
      }
      case 'nextAction': {
        const act = r.primaryAction || { key: 'open', label: 'View' };
        const wait = waitingText(r);
        const menu = menuFor(r);
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
              {menu.length > 1 && <RowMenu items={menu} onPick={(k) => pickRowAction(r, k)} label={`More actions for ${r.reqCode || r.title}`} />}
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

  const statusCombo = (
    <Combo value={draft.filters.status} title="Status" onChange={(e) => setDraftFilter({ status: e.target.value })}>
      <option value="">All statuses</option>
      <option value="LIVE">Open (live)</option>
      {REQUIREMENT_STATUS_CODES.map((s) => <option key={s} value={s}>{requirementStatusLabel(s)}</option>)}
    </Combo>
  );
  const clientCombo = (
    <Combo value={draft.filters.clientId} title="Client" onChange={(e) => setDraftFilter({ clientId: e.target.value })}>
      <option value="">All clients</option>
      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </Combo>
  );
  const priorityCombo = (
    <Combo value={draft.filters.priority} title="Priority" onChange={(e) => setDraftFilter({ priority: e.target.value })}>
      <option value="">All priorities</option>
      <option value="Urgent,High">🔴🟠 Critical + High</option>
      {PRIORITY_CHOICES.map((pc) => <option key={pc.value} value={pc.value}>{pc.label}</option>)}
    </Combo>
  );
  const primaryFilters = (
    <>
      <input
        type="text"
        placeholder="Search requirement, job title or REQ id…"
        value={draft.filters.search}
        onChange={(e) => setDraftFilter({ search: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyDraft(); } }}
        style={{ minWidth: 220 }}
      />
      {canFilter.hierarchy && role !== 'bde' && (
        <HierarchyFilter value={draft.h} onChange={setDraftH} data={tree.data} show={{ department: true, section: false, tl: false, recruiter: false }} />
      )}
      {role !== 'accounts' && statusCombo}
      {(role === 'recruiter' || role === 'accounts' || role === 'bde') && clientCombo}
      {role === 'recruiter' && priorityCombo}
      {canFilter.hierarchy && role !== 'bde' && (
        <HierarchyFilter value={draft.h} onChange={setDraftH} data={tree.data} show={{ department: false, section: false, tl: false, recruiter: true }} />
      )}
    </>
  );

  const alertN = data.alert && data.alert.unassigned;

  return (
    <div className="reqrole">
      <div className="page-head">
        <div>
          <h1>Jobs &amp; Requirements</h1>
          <div className="page-sub">
            <ScopeLine user={user} count={counts.scopeTotal ?? '…'} noun="requirement" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* §3 Template · Import (Admin, BDE) · Export (not a Recruiter) —
              AtsDataTools draws each only when /ats-io/access allows it. */}
          <AtsDataTools module="requirements" kinds={['requirements']} onImported={load} body={exportBody} />
          {canRaiseRequirement(user) && (
            <button className="btn btn-primary" onClick={() => openForm()}>Add Requirement</button>
          )}
        </div>
      </div>

      {notice && (
        <div className={`notice ${notice.tone === 'amber' ? 'amber' : ''}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            {notice.lines.map((l) => <div key={l}>{l}</div>)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {notice.id && <button type="button" className="btn btn-sm" onClick={() => navigate(`/requirements/${notice.id}`)}>{`Open ${notice.code || 'requirement'} →`}</button>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}

      {/* §8.4 — TL / Admin: the live requirements in scope nobody is on. */}
      {alertN > 0 && (
        <div className="rr-alert" role="status">
          <span>
            ⚠ <b>{nf(alertN)}</b>
            {` requirement${alertN === 1 ? '' : 's'} unassigned — no TL and no recruiter yet.`}
          </span>
          {viewKeys.includes('unassigned') && view !== 'unassigned' && (
            <button type="button" className="btn btn-sm" onClick={() => setView('unassigned')}>Show unassigned</button>
          )}
        </div>
      )}

      <div className="jobsws-views">
        <div className="tabs" role="tablist" aria-label="Requirements">
          {views.map((v) => (
            <div key={v.key} role="tab" aria-selected={view === v.key} className={`tab${view === v.key ? ' active' : ''}`} onClick={() => setView(v.key)} title={v.hint}>
              {v.label}<span className="n">{counts[v.key] === undefined ? '' : nf(counts[v.key])}</span>
            </div>
          ))}
          {role === 'recruiter' && (
            <label className="rr-showclosed" title="Closed requirements are hidden by default">
              <input type="checkbox" checked={showClosed} onChange={(e) => { setShowClosed(e.target.checked); if (!e.target.checked && view === 'closed') setView('mine'); }} />
              Show closed
            </label>
          )}
        </div>
        <div className="jobsws-tools">
          {/* CLIENT | INTERNAL — internal requirements are TeamLink's own openings. */}
          {canFilter.hiring && (
            <div className="req-hiring-seg" role="group" aria-label="Client or internal requirements" style={{ display: 'flex', gap: 2 }}>
              {[['', 'All'], ['client', 'Client'], ['internal', 'Internal']].map(([k, l]) => (
                <button key={k || 'all'} type="button" className={`btn btn-sm${(filters.type || '') === k ? ' btn-primary' : ' btn-ghost'}`} aria-pressed={(filters.type || '') === k} onClick={() => removeFilter({ type: k })}>{l}</button>
              ))}
            </div>
          )}
          <SavedViews storageKey="req" current={savedState} onApply={applySaved} presets={presets} />
          <label className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            Sort
            <select value={sort} onChange={(e) => { setSort(e.target.value); setDir('desc'); }}>
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-sm btn-ghost" title="Reverse the order" onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
            {dir === 'desc' ? '↓ High → low' : '↑ Low → high'}
          </button>
          <ColumnChooser columns={chooserColumns} value={cols.filter((k) => allowedCols.includes(k))} onChange={setCols} defaults={defaultCols} />
        </div>
      </div>

      {counts.scopeTotal !== undefined && (
        <div className="jobsws-total">
          {`${tabLabel}${activeCount ? ' (filtered)' : ''} `}
          <b>{nf(data.total)}</b>
          {` · of ${nf(counts.scopeTotal)} total in your scope`}
        </div>
      )}

      <form className="jobsws-filters jobsws-mf" onSubmit={(e) => { e.preventDefault(); applyDraft(); }}>
        <MoreFilters
          primary={primaryFilters}
          activeMore={moreCount}
          storageKey="req"
          onClearAll={activeCount || dirty ? clearFilters : undefined}
          extra={(
            <>
              <button type="submit" className="btn btn-sm btn-primary" disabled={!dirty}>Apply</button>
              {dirty && <span className="apply-note">Changes not applied yet</span>}
            </>
          )}
        >
          {canFilter.hierarchy && role === 'bde' && (
            <HierarchyFilter value={draft.h} onChange={setDraftH} data={tree.data} show={{ department: true, section: false, tl: false, recruiter: true }} />
          )}
          {canFilter.hierarchy && role !== 'bde' && (
            <HierarchyFilter value={draft.h} onChange={setDraftH} data={tree.data} show={{ department: false, section: true, tl: true, recruiter: false }} />
          )}
          {!['recruiter', 'accounts', 'bde'].includes(role) && clientCombo}
          {role !== 'accounts' && (
            <Combo value={draft.filters.location} title="Location" onChange={(e) => setDraftFilter({ location: e.target.value })}>
              <option value="">All locations</option>
              {LOCS.map((l) => <option key={l} value={l}>{l}</option>)}
            </Combo>
          )}
          {canFilter.bde && <PeopleFilter role="BDE" workers={workers} department={draft.h.department} value={draft.filters.bde} onChange={(value) => setDraftFilter({ bde: value })} />}
          {!['recruiter', 'accounts'].includes(role) && priorityCombo}
          {canFilter.agreement && (
            <Combo value={draft.filters.agreement} title="Agreement" onChange={(e) => setDraftFilter({ agreement: e.target.value })}>
              <option value="">Any agreement</option>
              <option value="pending">Agreement pending</option>
            </Combo>
          )}
          <label className="small-muted" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            Created
            <input type="date" title="Created from" value={draft.filters.from} onChange={(e) => setDraftFilter({ from: e.target.value })} />
            –
            <input type="date" title="Created to" value={draft.filters.to} onChange={(e) => setDraftFilter({ to: e.target.value })} />
          </label>
        </MoreFilters>
      </form>
      <FilterChips filters={chips} onClearAll={activeCount ? clearFilters : undefined} />

      {loadError && <div className="notice red">{loadError}</div>}
      {rowError && <div className="notice red" style={{ display: 'flex', justifyContent: 'space-between' }}>{rowError}<button type="button" className="btn btn-sm btn-ghost" onClick={() => setRowError('')}>×</button></div>}

      {canSelect && selected.size > 0 && (
        <div className="reqbulk-bar" role="region" aria-label="Bulk actions">
          <span className="count">{`${nf(selected.size)} selected`}</span>
          {bulkActions.assign && <button type="button" className="btn btn-sm" onClick={() => setBulk({ kind: 'assign-recruiter', items: selectedItems })}>Assign Recruiter</button>}
          {bulkActions.assign && <button type="button" className="btn btn-sm" onClick={() => setBulk({ kind: 'assign-tl', items: selectedItems })}>Assign TL</button>}
          {bulkActions.priority && <button type="button" className="btn btn-sm" onClick={() => setBulk({ kind: 'priority', items: selectedItems })}>Change Priority</button>}
          {bulkActions.export && (
            <ExportMenu
              url="/ats-io/export/requirements"
              body={() => ({ params: { ids: selectedItems.map((x) => x.id).join(',') }, view: 'all', ids: selectedItems.map((x) => x.id) })}
              label={`Export (${selected.size})`}
              note="The selected requirements, in your scope."
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
                  const sticky = c.key === 'requirement' ? ' sticky-col' : '';
                  const head = (
                    <>
                      {c.key === 'requirement' && canSelect && (
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
                      <EmptyState compact title="No requirements match these filters." hint="Remove a filter chip above, or Clear All." action={<button type="button" className="btn btn-sm" onClick={clearFilters}>Clear All</button>} />
                    ) : view === 'mine' && role === 'recruiter' ? (
                      <EmptyState compact icon="🎉" title="No requirements assigned to you." hint="When a TL assigns you a requirement it appears here." />
                    ) : (
                      <EmptyState compact title={`No ${tabLabel.toLowerCase()} requirements in your scope.`} />
                    )}
                  </td>
                </tr>
              )}
              {loading && data.rows.length === 0 && (
                <tr><td colSpan={visible.length} className="small-muted" style={{ padding: 16 }}>Loading requirements…</td></tr>
              )}
            </tbody>
          </table>
        </ScrollTable>
      </div>
      <Pager page={pageObj} noun={/requirement/i.test(tabLabel) ? tabLabel.toLowerCase() : `${tabLabel.toLowerCase()} requirements`} />

      {drawer && (
        <RequirementDrawer
          row={drawer}
          onClose={() => setDrawer(null)}
          onAssign={(r) => setBulk({ kind: 'assign-recruiter', items: [rowItem(r)], fromDrawer: true })}
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

      {showForm && (
        <RequirementForm
          mode="create"
          clients={formClients || clients}
          team={team}
          initialClientId={formClientId}
          onClose={() => setShowForm(false)}
          onSaved={(saved, info) => {
            const lines = [
              `${saved?.reqCode || 'Requirement'} saved — ${requirementStatusLabel(saved?.status)}.`,
              saved?.gateNote,
              info?.posting,
            ].filter(Boolean);
            setNotice({ lines, id: saved?.id, code: saved?.reqCode, tone: saved?.gateNote || /not published|could not/i.test(info?.posting || '') ? 'amber' : '' });
            setShowForm(false);
            setSort('created');
            setDir('desc');
            load();
          }}
        />
      )}
    </div>
  );
}
