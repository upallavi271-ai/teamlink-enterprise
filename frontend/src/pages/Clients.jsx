import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Pager, { usePaged } from '../components/Pager.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import AtsDataTools from '../components/AtsDataTools.jsx';
import {
  ListToolbar, ListFooter, FacetSelect, useLocalFacets,
} from '../components/ui/ListPageHeader.jsx';
import '../components/jobs/jobs.css';
import ClientDuplicatesButton from '../components/ClientDuplicatesButton.jsx';
import ColumnChooser, { useColumns } from '../components/jobs/ColumnChooser.jsx';
import { RelNum, lastActivityText } from '../components/clients/relationship.jsx';
import { inr } from '../utils/csv';
import '../components/clients/clients.css';
import '../components/clients/clientsrole.css';
import StatusChip from '../components/ui/StatusChip.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ScrollTable from '../components/ScrollTable.jsx';
import ClientEditModal from '../components/clients/ClientEditModal.jsx';
import AddClientWizard from '../components/clients/AddClientWizard.jsx';
import ClientRowActions, { NoteModal } from '../components/clients/ClientRowActions.jsx';
import { useClientsMeta, HEALTH_HINT } from '../components/clients/clientsMeta.js';
import { LifecycleChip, PauseRequestsPanel } from '../components/clients/ClientLifecycle.jsx';
// Spec 6 — the agreement step badge (Draft → Sent → Viewed → Signed → Active → Expired).
import { agreementStepLabel, agreementStepOf } from '../components/clients/AgreementStep.jsx';
// Clients & Requirements v4 (2026-10-08) — the reference layout on the ATS kit:
// KPI icon tiles, by department, needs attention, agreement steps, top
// clients, the dense list. Every number is counted from the loaded GET /clients.
import { KpiRow, KpiTile } from '../components/atskit/AtsKit.jsx';
import {
  Panel, AttentionRows, ShareBars, RankList,
} from '../components/clientsreq-v4/JobsOverview.jsx';
import { CrqHead, MiniPager, FilterCard } from '../components/clientsreq-v4/ListBits.jsx';
import { agreementIsSigned } from '../atsVocab';
import '../components/clients/ccr.css';
import PageFilterBar, { usePageFilters, rangeDates } from '../components/ui/PageFilterBar.jsx';
import { Help } from '../components/ui/Guide.jsx';

// One-line ? tips on the headings a new person may not know (2026-10-05).
const COL_TIPS = {
  activeReqs: 'Jobs we are still finding people for',
  submitted: 'People we sent to this client',
  pending: 'People sent and waiting for the client to answer',
  agreement: 'Our contract with the client: Draft → Sent → Signed → Active',
  health: 'Green = busy and fine, yellow = quiet for a while, red = nothing for a long time',
  bde: 'Client manager (BDE) = our person who looks after this client',
  guarantee: 'Days we must replace a person who leaves early',
  outstanding: 'Invoiced but not paid yet',
};

// ---------------------------------------------------------------------------
// ATS → CLIENTS — the one place clients live (clients role spec 2026-09-29).
//
// WHAT a login sees is the server's: GET /clients returns exactly the
// caller's scope (utils/scope.js clientWhere — Admin / Management all, a BDE
// their own, a TL their team's, Accounts the billing clients), every row cut
// to the caller's field level and carrying only the numbers that role may
// have (no amounts for a BDE, no pipeline for Accounts, no commercial terms
// for a TL). GET /clients/meta says which columns, filters, views and
// buttons to draw for that role (§1–§4, §7, §8), so hiding here matches what
// the API would honour. A Recruiter never reaches this screen (the API
// answers 403 and the page says so).
// ---------------------------------------------------------------------------

// Every column the list can draw; /clients/meta decides which a role gets.
const COL_LABELS = {
  code: 'Client ID', industry: 'Industry', location: 'Location', legal: 'Legal name', tax: 'GSTIN / PAN',
  contact: 'Contact', bde: 'Client manager (BDE)', activeReqs: 'Open jobs', candidates: 'Candidates',
  submitted: 'People sent', interviews: 'Interviews', selected: 'Selected', joined: 'Joined',
  pending: 'Waiting for client', agreement: 'Agreement', status: 'Status', health: 'Health', department: 'Department',
  fee: 'Fee %', terms: 'Payment terms', guarantee: 'Guarantee', invoiced: 'Invoiced', received: 'Received',
  outstanding: 'Outstanding', overdueDays: 'Days late', revenue: 'Revenue', invoiceStatus: 'Invoice status',
  lastActivity: 'Last update', owner: 'Account manager', next: 'Next step',
};
const labelFor = (key, role) => {
  if (key === 'submitted') return role === 'tl' ? 'People sent (team)' : 'People sent';
  return COL_LABELS[key] || key;
};
const NUM_COLS = ['activeReqs', 'candidates', 'submitted', 'interviews', 'selected', 'joined', 'pending'];
const MONEY_COLS = ['invoiced', 'received', 'outstanding', 'revenue', 'overdueDays'];

// Status (spec 2026-10-03 §A): Active / Paused / Archived — the server's
// lifecycle (Suspended reads as Paused; legacy Inactive stays Inactive).
// "Prospect" (§4) — an Active client on file with no requirement yet and no
// Active agreement (or stored as one).
function statusOf(c) {
  const s = String(c.status || '').trim();
  const lc = c.lifecycle || (['Paused', 'Suspended'].includes(s) ? 'Paused' : s === 'Archived' ? 'Archived' : s === 'Inactive' ? 'Inactive' : 'Active');
  if (lc !== 'Active') return lc;
  if (s === 'Prospect') return 'Prospect';
  if (!(c.totalRequirements > 0) && c.agreementStatus !== 'ACTIVE') return 'Prospect';
  return 'Active';
}

// §1 — views per role; the first is the role's default.
const VIEWS = {
  admin: [['active', 'All Active'], ['all', 'All Clients']],
  mgmt: [['active', 'All Active'], ['all', 'All Clients']],
  bde: [['mine', 'My Clients'], ['active', 'Active only']],
  tl: [['team', "My Team's Clients"]],
  accounts: [['billing', 'Billing / Outstanding'], ['outstanding', 'Outstanding only']],
  client: [['all', 'My Company']],
};

const SORTS = {
  name: ['Name (A–Z)', (a, b) => a.name.localeCompare(b.name)],
  activeReqs: ['Open jobs', (a, b) => (b.activeRequirements || 0) - (a.activeRequirements || 0)],
  submitted: ['People sent', (a, b) => (b.candidatesSubmitted || 0) - (a.candidatesSubmitted || 0)],
  joined: ['Joined', (a, b) => (b.joinedCount || 0) - (a.joinedCount || 0)],
  lastActivity: ['Last update', (a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''))],
  outstanding: ['Outstanding', (a, b) => (b.invoiceSummary?.outstanding || 0) - (a.invoiceSummary?.outstanding || 0)],
  overdue: ['Days late', (a, b) => (b.invoiceSummary?.overdueDays || 0) - (a.invoiceSummary?.overdueDays || 0)],
  // ATS layout v3 — the table's own columns sort too (click the heading).
  department: ['Department', (a, b) => String(a.ownerDepartment || '~').localeCompare(String(b.ownerDepartment || '~'))],
  bde: ['Client manager (BDE)', (a, b) => String(a.bdeOwner || a.bdeName || '~').localeCompare(String(b.bdeOwner || b.bdeName || '~'))],
  agreement: ['Agreement (signed first)', (a, b) => Number(agreementIsSigned(b.agreementStatus)) - Number(agreementIsSigned(a.agreementStatus))],
};
// Column → sort key, for the clickable table headings.
const COL_SORT = {
  activeReqs: 'activeReqs', joined: 'joined', submitted: 'submitted', department: 'department', bde: 'bde',
  agreement: 'agreement', lastActivity: 'lastActivity', outstanding: 'outstanding', overdueDays: 'overdue',
};
// Signed / Unsigned — read off the agreement step (Signed or Active = signed).
const SIGNED_LABEL = { yes: 'Signed', no: 'Unsigned' };
const NO_DEPT = '__none__';
const EMPTY_FILTERS = {
  search: '', industry: '', status: '', owner: '', expiring: '', unassigned: '', department: '', location: '',
  agreement: '', hasOpen: '', outstanding: '', overdue: '', signed: '',
};
const ymd = (d) => d.toISOString().slice(0, 10);

// Filter option labels (spec 2026-10-03 §B — Clients filters).
const EXPIRY_LABEL = {
  expired: 'Expired', 30: 'Ends in 30 days', later: 'Ends later', none: 'No end date',
};
const HAS_OPEN_LABEL = { yes: 'Yes', no: 'No' };
const OVERDUE_STEPS = ['30', '60', '90'];
// The agreement-expiry bucket of a client, from its agreement end date (and
// the server's own "expiring in 30 days" list, so "Show them" matches the alert).
function expiryOf(c, expiringIds, today, in30) {
  if (expiringIds.has(c.id)) return '30';
  if (c.agreementStatus === 'EXPIRED' || (c.agreementEnd && c.agreementEnd < today)) return 'expired';
  if (!c.agreementEnd) return 'none';
  return c.agreementEnd <= in30 ? '30' : 'later';
}
const hitField = (f, c, v) => {
  const got = f.get(c);
  return (Array.isArray(got) ? got : [got]).some((x) => String(x ?? '') === String(v));
};
const inView = (c, v) => !(v === 'active' && statusOf(c) === 'Inactive')
  && !(v === 'outstanding' && !(c.invoiceSummary?.outstanding > 0.5));

export default function Clients() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const allowed = can(user, 'ats', 'clients', 'Client List', 'view');
  const { meta, error: metaError } = useClientsMeta(user, allowed);
  const role = meta?.role || null;
  const [clients, setClients] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [flash, setFlash] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [noteFor, setNoteFor] = useState(null);

  // Archived clients come too (?archived=1) — hidden below unless the
  // Status filter asks for them.
  function load() {
    api.get('/clients', { params: { archived: 1 } })
      .then((res) => { setClients(res.data); setLoadError(''); })
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load clients. Please try again.'))
      .finally(() => setLoaded(true));
  }
  useEffect(() => { if (allowed) load(); }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Columns: only what this role may see (§4); defaults are the spec's list.
  const allowedCols = meta?.columns || [];
  // Max 7 columns on screen by default (user, 2026-10-05): Client + 5 + Actions.
  // The rest stay one tick away under ⚙ Columns.
  const defaultCols = (meta?.defaultColumns || []).slice(0, 5);
  // v4 key: ATS layout v3 defaults (Department · BDE · Open jobs · Joined · Agreement).
  const [cols, setCols] = useColumns(`tl.clientcols4.${user?.id || 'anon'}.${role || 'x'}`, allowedCols, defaultCols);
  const visibleCols = allowedCols.filter((k) => cols.includes(k));

  const views = VIEWS[role] || [['all', 'All Clients']];
  const [view, setView] = useState('');
  const currentView = view || meta?.defaultView || views[0][0];
  const [sortBy, setSortByState] = useState('');
  const [sortRev, setSortRev] = useState(false);
  const setSortBy = (k) => { setSortByState(k); setSortRev(false); };
  const currentSort = sortBy || (role === 'accounts' ? 'outstanding' : 'name');
  // A table heading: the first click sorts by it, the next reverses it.
  const sortByCol = (k) => { if (!k) return; if (k === currentSort) setSortRev((r) => !r); else setSortBy(k); };
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  // ATS layout v3 — the page filter bar on top (Department · Date range ·
  // Client · Client manager), kept in the URL; counted here in the browser,
  // cascading with every other filter.
  const [pf, setPf] = usePageFilters();
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setPf({}); };
  const pfDates = rangeDates(pf.range, pf.from, pf.to);
  // The effective filter set: the panel's + the bar's.
  const ef = useMemo(() => ({
    ...filters, department: pf.department || '', owner: pf.bdeId || '', clientId: pf.clientId || '',
  }), [filters, pf.department, pf.bdeId, pf.clientId]);
  const has = (k) => (meta?.filters || []).includes(k);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const panelFilterCount = Object.entries(filters).filter(([k, v]) => k !== 'search' && v).length;

  const expiringIds = useMemo(() => new Set(meta?.expiring?.ids || []), [meta]);
  const today = ymd(new Date());

  // Spec 2026-10-03 §B — every filter is counted here in the browser (the
  // page holds the whole scoped list): each option carries its count over the
  // rows matching every OTHER filter (cascading), and 0-count options are
  // never offered (FacetSelect).
  const fields = useMemo(() => {
    const in30 = ymd(new Date(Date.now() + 30 * 86400000));
    return [
      { key: 'industry', get: (c) => c.industry },
      { key: 'owner', get: (c) => c.bdeOwner || c.bdeName },
      { key: 'unassigned', get: (c) => (String(c.bdeOwner || '').trim() ? null : '1') },
      { key: 'department', get: (c) => c.ownerDepartment || NO_DEPT, label: (v) => (v === NO_DEPT ? 'No department' : v) },
      { key: 'clientId', get: (c) => c.id, label: (v, c) => c.name },
      { key: 'signed', get: (c) => (agreementIsSigned(c.agreementStatus) ? 'yes' : 'no'), label: (v) => SIGNED_LABEL[v] || v },
      { key: 'location', get: (c) => c.location },
      { key: 'agreement', get: (c) => agreementStepOf(c.agreementStatus), label: (v) => agreementStepLabel(v) },
      { key: 'expiring', get: (c) => expiryOf(c, expiringIds, today, in30), label: (v) => EXPIRY_LABEL[v] || v },
      { key: 'hasOpen', get: (c) => (c.openRequirements > 0 ? 'yes' : 'no'), label: (v) => HAS_OPEN_LABEL[v] || v },
      { key: 'status', get: (c) => statusOf(c) },
      { key: 'outstanding', get: (c) => (c.invoiceSummary?.outstanding > 0.5 ? '1' : null), label: () => 'Has unpaid invoices' },
      { key: 'overdue', get: (c) => OVERDUE_STEPS.filter((d) => (c.invoiceSummary?.overdueDays || 0) >= Number(d)), label: (v) => `Late ${v}+ days` },
    ];
  }, [expiringIds, today]);
  const matchAll = (c) => fields.every((f) => !ef[f.key] || hitField(f, c, ef[f.key]));

  // search → (view) → archived rule. ARCHIVED — hidden from every view
  // unless Status = Archived is chosen; the Status options still count them.
  // The bar's Date range = when the client came on board (its Since date).
  const searched = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const inRange = (c) => {
      if (!pfDates.from && !pfDates.to) return true;
      const d = String(c.activeDate || c.createdAt || '').slice(0, 10);
      return !!d && (!pfDates.from || d >= pfDates.from) && (!pfDates.to || d <= pfDates.to);
    };
    return clients.filter((c) => inRange(c)
      && (!q || `${c.name || ''} ${c.legalName || ''} ${c.clientCode || ''} ${c.displayCode || ''} ${c.contactName || ''} ${c.gst || ''}`.toLowerCase().includes(q)));
  }, [clients, filters.search, pfDates.from, pfDates.to]);
  // The view (§1) — the scope itself is already the server's.
  // Picking a Status (Inactive, say) reaches past the view: the All Active
  // view must not swallow the very clients the filter asks for.
  const viewRows = useMemo(
    () => (filters.status ? searched : searched.filter((c) => inView(c, currentView))),
    [searched, currentView, filters.status],
  );
  const listRows = useMemo(
    () => (filters.status === 'Archived' ? viewRows : viewRows.filter((c) => statusOf(c) !== 'Archived')),
    [viewRows, filters.status],
  );
  const facets = useLocalFacets(listRows, fields, ef);
  // Every status is offered — Inactive and Archived included — whatever the view.
  const statusFacets = useLocalFacets(searched, fields, ef);

  const filtered = useMemo(() => {
    const sortFn = (SORTS[currentSort] || SORTS.name)[1];
    const out = listRows.filter(matchAll).sort(sortFn);
    return sortRev ? out.reverse() : out;
  }, [listRows, ef, fields, currentSort, sortRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const paged = usePaged(filtered);

  // The bar's options — the same counted facets (names only).
  const barOptions = useMemo(() => ({
    department: facets.department || [],
    clientId: facets.clientId || [],
    people: (facets.owner || []).map((o) => ({ ...o, value: `bde:${o.value}`, group: 'Client managers (BDE)' })),
  }), [facets]);


  if (!allowed) {
    return (
      <div className="notice clrole-denied">
        Clients is not part of your role. You see client names on your jobs.
      </div>
    );
  }

  const chips = [
    { key: 'search', label: 'Search', value: filters.search, onRemove: () => setFilter({ search: '' }) },
    { key: 'industry', label: 'Industry', value: filters.industry, onRemove: () => setFilter({ industry: '' }) },
    { key: 'status', label: 'Status', value: filters.status, onRemove: () => setFilter({ status: '' }) },
    { key: 'unassigned', label: 'Client manager', value: filters.unassigned ? 'Nobody yet' : '', onRemove: () => setFilter({ unassigned: '' }) },
    { key: 'expiring', label: 'Agreement ends', value: filters.expiring ? (EXPIRY_LABEL[filters.expiring] || filters.expiring) : '', onRemove: () => setFilter({ expiring: '' }) },
    { key: 'signed', label: 'Agreement', value: SIGNED_LABEL[filters.signed] || '', onRemove: () => setFilter({ signed: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => setFilter({ location: '' }) },
    { key: 'agreement', label: 'Agreement', value: filters.agreement ? agreementStepLabel(filters.agreement) : '', onRemove: () => setFilter({ agreement: '' }) },
    { key: 'hasOpen', label: 'Has open jobs', value: HAS_OPEN_LABEL[filters.hasOpen] || '', onRemove: () => setFilter({ hasOpen: '' }) },
    { key: 'outstanding', label: 'Has unpaid invoices', value: filters.outstanding ? 'Yes' : '', onRemove: () => setFilter({ outstanding: '' }) },
    { key: 'overdue', label: 'Late', value: filters.overdue ? `${filters.overdue}+ days` : '', onRemove: () => setFilter({ overdue: '' }) },
  ];

  const a = meta?.actions || {};
  // The mini numbers only when the columns themselves are hidden (fewer elements).
  const showMini = role && role !== 'accounts' && !visibleCols.includes('activeReqs');
  const money = (v, bad = false) => (v == null ? '—' : <span className={`clrole-money${bad && v > 0 ? ' bad' : ''}`}>{inr(v)}</span>);

  const cell = (key, c) => {
    const to = (t) => `/clients/${c.id}?tab=${t}`;
    const inv = c.invoiceSummary;
    switch (key) {
      case 'code': return <td key={key}><span className="clrel-code">{c.displayCode || '—'}</span></td>;
      case 'industry': return <td key={key} className="cell-muted">{c.industry || '—'}</td>;
      case 'location': return <td key={key} className="cell-muted clrel-wrap">{c.location || '—'}{c.state && c.state !== c.location ? <span className="clrel-sub">{c.state}</span> : null}</td>;
      case 'legal': return <td key={key} className="cell-muted">{c.legalName || '—'}</td>;
      case 'department': return <td key={key} className="cell-muted">{c.ownerDepartment || '—'}</td>;
      case 'tax': return <td key={key} className="cell-muted">{c.gst || '—'}<span className="clrel-sub">{c.pan ? `PAN ${c.pan}` : ''}</span></td>;
      case 'contact':
        return (
          <td key={key} className="cell-muted clrel-wrap">
            {c.contactName || '—'}
            <span className="clrel-sub">{[c.contactPhone, c.contactEmail].filter(Boolean).join(' · ')}</span>
          </td>
        );
      case 'bde':
        return (
          <td key={key} className="cell-muted">
            {c.bdeOwner || (c.bdeName ? <span title="From its jobs. No client manager set.">{c.bdeName}</span> : null)}
            {!String(c.bdeOwner || '').trim() && (role === 'admin' || role === 'mgmt')
              ? <span className="clrel-sub"><span className="clrel-pill warn">Nobody yet</span></span> : null}
            {!c.bdeOwner && !c.bdeName && !(role === 'admin' || role === 'mgmt') ? '—' : null}
          </td>
        );
      case 'activeReqs': return <td key={key} className="clrel-num"><RelNum value={c.activeRequirements} to={to('requirements')} title={`${c.totalRequirements || 0} jobs in total`} /></td>;
      case 'candidates': return <td key={key} className="clrel-num"><RelNum value={c.candidatesTotal} to={to('candidates')} /></td>;
      case 'submitted': return <td key={key} className="clrel-num"><RelNum value={c.candidatesSubmitted} to={to('candidates')} /></td>;
      case 'interviews': return <td key={key} className="clrel-num"><RelNum value={c.clientInterviews} to={to('interviews')} /></td>;
      case 'selected': return <td key={key} className="clrel-num"><RelNum value={c.selectedCount} to={to('selected')} /></td>;
      case 'joined': return <td key={key} className="clrel-num"><RelNum value={c.joinedCount} to={role === 'accounts' ? to('invoices') : to('selected')} /></td>;
      case 'pending': return <td key={key} className="clrel-num"><RelNum value={c.pendingDecisions} to={to('candidates')} /></td>;
      case 'agreement': {
        // ATS layout v3 — Signed / Unsigned, read off the agreement step.
        const signed = agreementIsSigned(c.agreementStatus);
        return (
          <td key={key}>
            <StatusChip status={signed ? 'Signed' : 'Unsigned'} tone={signed ? 'green' : 'amber'} title={`Step: ${agreementStepLabel(c.agreementStatus)}`} />
            <span className="clrel-sub">
              {`Step: ${agreementStepLabel(c.agreementStatus)}`}
              {c.agreementEnd ? ` · ends ${c.agreementEnd}${expiringIds.has(c.id) ? ' (soon)' : ''}` : ''}
            </span>
          </td>
        );
      }
      case 'status': return <td key={key}><StatusChip status={statusOf(c)} tone={statusOf(c) === 'Active' ? 'green' : statusOf(c) === 'Prospect' ? 'blue' : 'amber'} title={c.workStatus || c.status || ''} /></td>;
      case 'health':
        return (
          <td key={key}>
            {c.health ? <span className={`clrole-health ${c.health}`} title={`${HEALTH_HINT[c.health] || ''}${c.healthDays != null ? `. Last update ${c.healthDays} days ago.` : ''}`}>{c.healthLabel}</span> : '—'}
          </td>
        );
      case 'fee': return <td key={key} className="clrel-num">{c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : '—'}</td>;
      case 'terms': return <td key={key} className="cell-muted clrel-wrap">{c.paymentTerms || '—'}</td>;
      case 'guarantee':
        return (
          <td key={key} className="cell-muted clrel-wrap">
            {c.guaranteePeriod || '—'}
            {c.inGuarantee ? <span className="clrel-sub"><span className="clrel-pill warn">{`${c.inGuarantee} in guarantee`}</span></span> : null}
          </td>
        );
      case 'invoiced': return <td key={key}>{inv ? money(inv.invoiced) : '—'}</td>;
      case 'received': return <td key={key}>{inv ? money(inv.received) : '—'}</td>;
      case 'revenue': return <td key={key}>{c.revenue != null ? money(c.revenue) : '—'}</td>;
      case 'outstanding':
        return (
          <td key={key}>
            {inv ? money(inv.outstanding, true) : '—'}
            {inv && inv.overdue ? <span className="clrel-sub" style={{ textAlign: 'right' }}>{`${inv.overdue} late`}</span> : null}
          </td>
        );
      case 'overdueDays':
        return <td key={key} className={`clrole-money${inv && inv.overdueDays ? ' bad' : ''}`}>{inv && inv.overdueDays ? `${inv.overdueDays} days late` : '—'}</td>;
      case 'invoiceStatus':
        return (
          <td key={key}>
            {inv && inv.status
              ? <StatusChip status={inv.status === 'Overdue' ? 'Late' : inv.status} tone={inv.status === 'Paid' ? 'green' : inv.status === 'Overdue' ? 'red' : 'amber'} title={`${inv.count} invoice(s) · ${inv.paid} paid · ${inv.pending} pending`} />
              : <span className="cell-muted">—</span>}
          </td>
        );
      case 'lastActivity':
        return (
          <td key={key} className="cell-muted clrel-wrap" title={c.lastActivityWhat || ''}>
            {lastActivityText(c) || '—'}
            {c.lastActivityWhat ? <span className="clrel-sub">{c.lastActivityWhat}</span> : null}
          </td>
        );
      case 'owner': return <td key={key} className="cell-muted clrel-wrap">{c.accountManager || '—'}<span className="clrel-sub">{c.ownerDepartment || ''}</span></td>;
      case 'next':
        return (
          <td key={key} className="clrel-next">
            <span className="cell-muted" style={{ fontSize: 12 }}>
              {c.nextAction || c.workStatus || '—'}
              {c.nextActionOwner ? ` · ${c.nextActionOwner}` : ''}
              {c.nextActionDue ? ` · due ${c.nextActionDue}` : ''}
            </span>
          </td>
        );
      default: return <td key={key} />;
    }
  };

  // Counts leave the archived clients out unless Status = Archived is chosen.
  const listedCount = filters.status === 'Archived' ? clients.length : clients.filter((c) => statusOf(c) !== 'Archived').length;
  const narrowed = filtered.length !== listedCount;

  // v4 overview — counted over the rows the list shows (filtered), as the cards were.
  const seeAgreement = allowedCols.includes('agreement');
  const activeN = filtered.filter((c) => statusOf(c) === 'Active').length;
  const prospectN = filtered.filter((c) => statusOf(c) === 'Prospect').length;
  const unsignedN = filtered.filter((c) => !agreementIsSigned(c.agreementStatus)).length;
  const noOpenN = filtered.filter((c) => !(c.openRequirements > 0)).length;
  const openJobsN = role === 'accounts' ? null : filtered.reduce((n, c) => n + (Number(c.activeRequirements) || 0), 0);
  const toTable = () => document.getElementById('ccr-client-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const deptRows = (facets.department || []).map((o) => ({
    key: o.value, label: o.label, value: o.count, active: pf.department === o.value,
    onClick: () => setPf({ ...pf, department: pf.department === o.value ? '' : o.value }),
  })).sort((x, y) => y.value - x.value);
  const agrRows = (facets.agreement || []).map((o) => ({
    key: o.value, label: o.label, value: o.count, active: filters.agreement === o.value,
    onClick: has('agreement') ? () => setFilter({ agreement: filters.agreement === o.value ? '' : o.value }) : undefined,
  })).sort((x, y) => y.value - x.value);
  const topClients = role === 'accounts' ? [] : [...filtered]
    .filter((c) => Number(c.activeRequirements) > 0)
    .sort((x, y) => (Number(y.activeRequirements) || 0) - (Number(x.activeRequirements) || 0))
    .slice(0, 5)
    .map((c) => ({ key: c.id, name: c.name, value: Number(c.activeRequirements), to: `/clients/${c.id}` }));
  const unassignedN = (facets.unassigned || [])[0]?.count;
  const attention = [
    seeAgreement && {
      key: 'unsigned', count: unsignedN, tone: 'red', label: 'Unsigned agreement', sub: 'Jobs wait for the client to sign', active: filters.signed === 'no',
      onClick: () => setFilter({ signed: filters.signed === 'no' ? '' : 'no' }),
    },
    meta?.expiring?.count > 0 && {
      key: 'expiring', count: meta.expiring.count, tone: 'red', label: 'Agreement ending soon', sub: `Ends or renews in ${meta.expiring.days} days`, active: filters.expiring === '30',
      onClick: () => setFilter({ expiring: filters.expiring === '30' ? '' : '30' }),
    },
    has('unassigned') && unassignedN > 0 && {
      key: 'nobde', count: unassignedN, tone: 'red', label: 'No client manager', sub: 'Nobody looks after these clients', active: !!filters.unassigned,
      onClick: () => setFilter({ unassigned: filters.unassigned ? '' : '1' }),
    },
    {
      key: 'noopen', count: noOpenN, tone: 'red', label: 'No open job', sub: 'Nothing to hire for right now', active: filters.hasOpen === 'no',
      onClick: () => setFilter({ hasOpen: filters.hasOpen === 'no' ? '' : 'no' }),
    },
  ].filter(Boolean);

  return (
    <div className="crq4 crq4-clients">
      {/* Spec 2026-10-03 §B — title, question, Import / Export / History, ONE
          primary button (v4: the module header; the Shell's strip sits under it).
          §3 — Import (Admin) · Export (Admin, Management, BDE own, Accounts):
          /ats-io/access decides, the ats-io routes enforce. The "current view"
          export sends the ids of the rows shown when narrowed; the server keeps
          only those of its own scoped GET /clients. */}
      <CrqHead
        sub="Every company we find people for, and how their jobs are going."
        scope={loaded ? <ScopeLine user={user} count={listedCount} noun="client" inline /> : 'Loading…'}
        tools={(
          <>
            {a.merge ? <span className="crq4-extra"><ClientDuplicatesButton /></span> : null}
            {meta && (a.import || a.export) ? (
              <AtsDataTools
                module="clients"
                kinds={a.import ? ['clients'] : []}
                onImported={load}
                body={() => ({ ids: narrowed ? filtered.map((c) => c.id) : null })}
              />
            ) : null}
            {a.add ? (
              <button type="button" className="btn btn-primary" onClick={() => { setFlash(''); setAdding(true); }}>+ Add client</button>
            ) : null}
          </>
        )}
      />

      {/* ONE filter card: Department · Date range · Client · Client manager (the
          page filter bar, kept in the URL) + Status · Signed? · Location + Search. */}
      <FilterCard
        search={{
          value: filters.search,
          onChange: (v) => setFilter({ search: v }),
          placeholder: role === 'tl' || role === 'accounts' ? 'Search clients…' : 'Search name, code, contact or GST…',
        }}
      >
        <PageFilterBar value={pf} onChange={setPf} options={barOptions} show={{ department: true, dateRange: true, client: true, people: role !== 'tl' && role !== 'accounts' }} />
        {has('status') && <FacetSelect label="Status" value={filters.status} onChange={(v) => setFilter({ status: v })} options={statusFacets.status} allLabel="Any status" />}
        {(has('agreement') || seeAgreement) && <FacetSelect label="Signed?" value={filters.signed} onChange={(v) => setFilter({ signed: v })} options={facets.signed} allLabel="Signed or not" />}
        {has('location') && <FacetSelect label="Location" value={filters.location} onChange={(v) => setFilter({ location: v })} options={facets.location} allLabel="All locations" />}
      </FilterCard>

      {loaded && clients.length > 0 && (
        <>
          <KpiRow className="crq4-kpis">
            <KpiTile icon="building" tone="blue" label="Total Clients" value={filtered.length} sub="In the list below" onClick={toTable} title="Go to the list" />
            <KpiTile icon="check" tone="green" label="Active" value={activeN} sub="Working with them" active={filters.status === 'Active'} onClick={has('status') ? () => setFilter({ status: filters.status === 'Active' ? '' : 'Active' }) : undefined} />
            <KpiTile icon="star" tone="violet" label="Prospects" value={prospectN} sub="Not started yet" active={filters.status === 'Prospect'} onClick={has('status') ? () => setFilter({ status: filters.status === 'Prospect' ? '' : 'Prospect' }) : undefined} />
            {seeAgreement && <KpiTile icon="file" tone="amber" label="Unsigned Agreement" value={unsignedN} sub="Jobs wait for it" active={filters.signed === 'no'} onClick={() => setFilter({ signed: filters.signed === 'no' ? '' : 'no' })} />}
            <KpiTile icon="pause" tone="slate" label="No Open Job" value={noOpenN} sub="Nothing to hire" active={filters.hasOpen === 'no'} onClick={() => setFilter({ hasOpen: filters.hasOpen === 'no' ? '' : 'no' })} />
            {openJobsN !== null && <KpiTile icon="briefcase" tone="teal" label="Open Jobs" value={openJobsN} sub="Across these clients" />}
          </KpiRow>

          <div className={`crq4-row4${seeAgreement ? '' : ' crq4-three'}`}>
            <Panel title="Clients by Department" sub="Click a department to see its clients">
              <ShareBars rows={deptRows} max={5} />
            </Panel>
            <Panel title="Needs Attention" icon="alert" iconTone="red">
              <AttentionRows items={attention} />
            </Panel>
            {seeAgreement ? (
              <Panel title="Agreement Steps" sub={has('agreement') ? 'Draft → Sent → Signed → Active · click one' : 'Draft → Sent → Signed → Active'}>
                <ShareBars rows={agrRows} max={5} />
              </Panel>
            ) : null}
            <Panel title="Top Clients by Open Jobs" action={role === 'accounts' ? undefined : { label: 'Sort list', onClick: () => { setSortBy('activeReqs'); toTable(); } }}>
              <RankList rows={topClients} max={5} empty={role === 'accounts' ? 'Not part of your role' : 'No open jobs'} />
            </Panel>
          </div>
        </>
      )}

      {metaError && <div className="notice red">{metaError}</div>}
      {loadError && <div className="notice red">{loadError}</div>}
      {flash && <div className="notice">{flash}</div>}

      <Panel className="crq4-list" title="Clients List" extra={<MiniPager page={paged} />}>
        <div className="crq4-list-tools">
          {/* Simplicity checklist #5 — ONE row of daily chips:
              "Ending soon (N)" — agreements ending or renewing in 30 days
              (Admin, BDE; §8.3 / spec 6), and "Pause requests (N)" — Admins / the
              department Manager approve or reject; a BDE sees the ones they sent
              (spec 2026-10-03 §A). The panel opens under the chips. */}
          {(meta?.expiring?.count > 0 || meta?.actions?.pauseRequests) && (
            <div className="clrole-daily">
              {meta?.expiring?.count > 0 && (
                <button
                  type="button"
                  className={`btn btn-sm clrole-daychip${filters.expiring === '30' ? ' on' : ''}`}
                  aria-pressed={filters.expiring === '30'}
                  title={`Agreements that end or renew in ${meta.expiring.days} days`}
                  onClick={() => setFilter({ expiring: filters.expiring === '30' ? '' : '30' })}
                >
                  {`Ending soon (${meta.expiring.count})`}
                </button>
              )}
              <PauseRequestsPanel enabled={!!meta?.actions?.pauseRequests} reloadKey={clients} onChanged={(msg) => { setFlash(msg); load(); }} />
            </div>
          )}

          {/* [ Filters (n) ] [ Sort ] [ Columns ] — the other filters (only those
              /clients/meta gives this role) sit in ONE panel; chips + Clear all.
              Search, Status, Signed? and Location are on the filter card above. */}
          <ListToolbar
            filterCount={Object.entries(filters).filter(([k, v]) => !['search', 'status', 'signed', 'location'].includes(k) && v).length}
            panel={(meta?.filters || []).some((k) => ['industry', 'agreement', 'expiring', 'hasOpen', 'outstanding', 'overdue', 'unassigned'].includes(k)) ? (
              <>
                {has('industry') && <FacetSelect label="Industry" value={filters.industry} onChange={(v) => setFilter({ industry: v })} options={facets.industry} allLabel="All industries" />}
                {has('agreement') && <FacetSelect label="Agreement" value={filters.agreement} onChange={(v) => setFilter({ agreement: v })} options={facets.agreement} allLabel="Any agreement step" />}
                {has('expiring') && <FacetSelect label="Agreement ends" value={filters.expiring} onChange={(v) => setFilter({ expiring: v })} options={facets.expiring} allLabel="Any end date" />}
                {has('hasOpen') && <FacetSelect label="Has open jobs" value={filters.hasOpen} onChange={(v) => setFilter({ hasOpen: v })} options={facets.hasOpen} />}
                {has('outstanding') && <FacetSelect label="Unpaid invoices" value={filters.outstanding} onChange={(v) => setFilter({ outstanding: v })} options={facets.outstanding} />}
                {has('overdue') && <FacetSelect label="Late" value={filters.overdue} onChange={(v) => setFilter({ overdue: v })} options={facets.overdue} />}
                {has('unassigned') && (filters.unassigned || (facets.unassigned || []).length > 0) && (
                  <label className="clrole-check">
                    <input type="checkbox" checked={!!filters.unassigned} onChange={(e) => setFilter({ unassigned: e.target.checked ? '1' : '' })} style={{ width: 'auto' }} />
                    {`No client manager${(facets.unassigned || [])[0] ? ` (${facets.unassigned[0].count})` : ''}`}
                  </label>
                )}
              </>
            ) : null}
            sort={currentSort}
            sortOptions={Object.entries(SORTS)
              .filter(([k]) => (!['outstanding', 'overdue'].includes(k) || meta?.invoiceMode === 'amounts')
                && (k !== 'submitted' || allowedCols.includes('submitted')))
              .map(([k, [label]]) => [k, label])}
            onSort={setSortBy}
            right={allowedCols.length > 0 ? (
              <ColumnChooser
                columns={allowedCols.map((k) => ({ key: k, label: labelFor(k, role) }))}
                value={cols}
                onChange={setCols}
                defaults={defaultCols}
              />
            ) : null}
            chips={chips}
            onClearAll={activeFilterCount ? clearFilters : undefined}
          />
        </div>

      <div id="ccr-client-table" className="ccr-section" />
      <ScrollTable maxHeight={null} bodyClassName="tbl-fit">
        <table className="clrel-table">
          <thead>
            <tr>
              {/* Click a heading to sort; click again to reverse. */}
              <th className="clrel-sticky jobsws-sort" onClick={() => sortByCol('name')} title="Sort by name">
                Client
                {currentSort === 'name' && <span className="arrow">{sortRev ? '▼' : '▲'}</span>}
              </th>
              {visibleCols.map((k) => {
                const sk = COL_SORT[k];
                const cls = [NUM_COLS.includes(k) ? 'clrel-num' : MONEY_COLS.includes(k) ? 'clrole-money' : '', sk ? 'jobsws-sort' : ''].filter(Boolean).join(' ') || undefined;
                return (
                  <th key={k} className={cls} onClick={sk ? () => sortByCol(sk) : undefined} title={sk ? `Sort by ${labelFor(k, role)}` : undefined}>
                    {labelFor(k, role)}
                    {COL_TIPS[k] && <Help text={COL_TIPS[k]} />}
                    {sk && currentSort === sk && <span className="arrow">{sortRev ? '▲' : '▼'}</span>}
                  </th>
                );
              })}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((c) => (
              <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}`)}>
                <td className="clrel-sticky">
                  <b>{c.name}</b>
                  {statusOf(c) === 'Paused' || statusOf(c) === 'Archived' ? <> <LifecycleChip lifecycle={statusOf(c)} /></> : null}
                  {!visibleCols.includes('code') && <span className="clrel-sub clrel-code">{c.displayCode}</span>}
                  {/* §8.2 — mini stats: Open jobs · People sent · Selected · Joined.
                      A zero is not drawn (never a bare zero). */}
                  {showMini && (c.activeRequirements > 0 || c.candidatesSubmitted > 0 || c.selectedCount > 0 || c.joinedCount > 0) && (
                    <span className="clrole-mini" title="Open jobs · People sent · Selected · Joined (in your area)">
                      {c.activeRequirements > 0 && <span><b>{c.activeRequirements}</b> open</span>}
                      {c.candidatesSubmitted > 0 && <span><b>{c.candidatesSubmitted}</b> sent</span>}
                      {c.selectedCount > 0 && <span><b>{c.selectedCount}</b> selected</span>}
                      {c.joinedCount > 0 && <span><b>{c.joinedCount}</b> joined</span>}
                    </span>
                  )}
                </td>
                {visibleCols.map((k) => cell(k, c))}
                <td className="clrole-act" onClick={(e) => e.stopPropagation()}>
                  <ClientRowActions
                    c={c}
                    meta={meta}
                    onEdit={(row) => setEditing(row)}
                    onNote={(row) => setNoteFor(row)}
                  />
                </td>
              </tr>
            ))}
            {!loaded && !loadError && (
              <tr>
                <td colSpan={visibleCols.length + 2} className="small-muted" style={{ padding: 16 }}>Loading clients…</td>
              </tr>
            )}
            {loaded && filtered.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length + 2}>
                  {clients.length
                    ? <EmptyState compact title="No clients match these filters." hint="Remove a filter, or press Show all." action={<button type="button" className="btn btn-sm" onClick={() => { clearFilters(); setView(views[views.length > 1 ? 1 : 0][0]); }}>Show all</button>} />
                    : <EmptyState compact title="No clients yet." hint={role === 'tl' ? 'Clients show here when your team works on their jobs.' : role === 'accounts' ? 'Clients show here once they have a joining or an invoice.' : a.add ? 'Press + Add client to add your first client.' : 'Clients you look after show here.'} />}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollTable>
      <ListFooter from={paged.from} to={paged.to} total={paged.total} noun="clients">
        <Pager page={paged} noun="clients" />
      </ListFooter>
      </Panel>

      {adding && (
        <AddClientWizard
          user={user}
          meta={meta}
          onClose={() => setAdding(false)}
          onSaved={(created, warning) => {
            setAdding(false);
            setFlash(warning || `${created.name} added.`);
            load();
          }}
        />
      )}
      {editing && (
        <ClientEditModal
          client={editing}
          canCommercial={!!a.commercial && !!editing.permissions?.commercialTerms}
          canReassign={!!a.reassign}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setFlash('Client saved.'); load(); }}
        />
      )}
      {noteFor && (
        <NoteModal client={noteFor} onClose={() => setNoteFor(null)} onSaved={() => { setNoteFor(null); setFlash(`Note added to ${noteFor.name}.`); load(); }} />
      )}
    </div>
  );
}
