import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Pager, { usePaged } from '../components/Pager.jsx';
import ScopeLine from '../components/ScopeLine.jsx';
import { agreementStatusLabel } from '../atsVocab';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';
import Combo from '../components/Combo.jsx';
import AtsDataTools from '../components/AtsDataTools.jsx';
import FilterChips from '../components/FilterChips.jsx';
import '../components/jobs/jobs.css';
import ClientDuplicatesButton from '../components/ClientDuplicatesButton.jsx';
import ColumnChooser, { useColumns } from '../components/jobs/ColumnChooser.jsx';
import { RelNum, lastActivityText } from '../components/clients/relationship.jsx';
import { inr } from '../utils/csv';
import '../components/clients/clients.css';
import '../components/clients/clientsrole.css';
import MoreFilters from '../components/ui/MoreFilters.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ScrollTable from '../components/ScrollTable.jsx';
import ClientsTabs from '../components/clients/ClientsTabs.jsx';
import ClientEditModal from '../components/clients/ClientEditModal.jsx';
import AddClientWizard from '../components/clients/AddClientWizard.jsx';
import ClientRowActions, { NoteModal, ReassignModal } from '../components/clients/ClientRowActions.jsx';
import { useClientsMeta, HEALTH_HINT } from '../components/clients/clientsMeta.js';

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
  code: 'Client ID', industry: 'Industry', location: 'Location', legal: 'Legal Name', tax: 'GSTIN / PAN',
  contact: 'Contact Person', bde: 'Owner BDE', activeReqs: 'Open Reqs', candidates: 'Candidates',
  submitted: 'Submissions', interviews: 'Interviews', selected: 'Selected', joined: 'Joined',
  pending: 'Pending Decisions', agreement: 'Agreement Status', status: 'Status', health: 'Health',
  fee: 'Fee %', terms: 'Payment Terms', guarantee: 'Guarantee', invoiced: 'Invoiced', received: 'Received',
  outstanding: 'Outstanding', overdueDays: 'Overdue Days', revenue: 'Revenue', invoiceStatus: 'Invoice Status',
  lastActivity: 'Last Activity', owner: 'Account Manager', next: 'Next Action',
};
const labelFor = (key, role) => {
  if (key === 'submitted') return role === 'tl' ? 'Team Submissions' : 'Submissions';
  if (key === 'joined' && role === 'accounts') return 'Joined Count';
  return COL_LABELS[key] || key;
};
const NUM_COLS = ['activeReqs', 'candidates', 'submitted', 'interviews', 'selected', 'joined', 'pending'];
const MONEY_COLS = ['invoiced', 'received', 'outstanding', 'revenue', 'overdueDays'];
const agreementTone = (code) => (code === 'ACTIVE' ? 'green' : ['EXPIRED', 'REJECTED'].includes(code) ? 'red' : 'amber');

// §4 BDE status filter: Active / Inactive / Prospect. "Prospect" — a client
// on file with no requirement yet and no Active agreement (or stored as one).
function statusOf(c) {
  const s = String(c.status || '').trim();
  if (['Inactive', 'Suspended'].includes(s)) return 'Inactive';
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
  activeReqs: ['Open requirements', (a, b) => (b.activeRequirements || 0) - (a.activeRequirements || 0)],
  submitted: ['Submissions', (a, b) => (b.candidatesSubmitted || 0) - (a.candidatesSubmitted || 0)],
  joined: ['Joined', (a, b) => (b.joinedCount || 0) - (a.joinedCount || 0)],
  lastActivity: ['Last activity', (a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''))],
  outstanding: ['Outstanding', (a, b) => (b.invoiceSummary?.outstanding || 0) - (a.invoiceSummary?.outstanding || 0)],
  overdue: ['Overdue days', (a, b) => (b.invoiceSummary?.overdueDays || 0) - (a.invoiceSummary?.overdueDays || 0)],
};
const EMPTY_FILTERS = {
  search: '', industry: '', status: '', owner: '', expiring: '', unassigned: '', department: '', location: '',
  agreement: '', hasOpen: '', outstanding: '', overdue: '',
};
const ymd = (d) => d.toISOString().slice(0, 10);

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
  const [reassignFor, setReassignFor] = useState(null);

  function load() {
    api.get('/clients')
      .then((res) => { setClients(res.data); setLoadError(''); })
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load clients'))
      .finally(() => setLoaded(true));
  }
  useEffect(() => { if (allowed) load(); }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Columns: only what this role may see (§4); defaults are the spec's list.
  const allowedCols = meta?.columns || [];
  const defaultCols = meta?.defaultColumns || [];
  const [cols, setCols] = useColumns(`tl.clientcols3.${user?.id || 'anon'}.${role || 'x'}`, allowedCols, defaultCols);
  const visibleCols = allowedCols.filter((k) => cols.includes(k));

  const views = VIEWS[role] || [['all', 'All Clients']];
  const [view, setView] = useState('');
  const currentView = view || meta?.defaultView || views[0][0];
  const [sortBy, setSortBy] = useState('');
  const currentSort = sortBy || (role === 'accounts' ? 'outstanding' : 'name');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  const has = (k) => (meta?.filters || []).includes(k);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const opts = useMemo(() => {
    const uniq = (f) => [...new Set(clients.map(f).filter(Boolean))].sort();
    return {
      industry: uniq((c) => c.industry),
      department: uniq((c) => c.ownerDepartment),
      location: uniq((c) => c.location),
      agreement: uniq((c) => c.agreementStatus),
      owner: uniq((c) => c.bdeOwner || c.bdeName),
    };
  }, [clients]);

  const expiringIds = useMemo(() => new Set(meta?.expiring?.ids || []), [meta]);
  const today = ymd(new Date());

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const sortFn = (SORTS[currentSort] || SORTS.name)[1];
    return clients.filter((c) => {
      // The view (§1) — the scope itself is already the server's.
      if (currentView === 'active' && statusOf(c) === 'Inactive') return false;
      if (currentView === 'outstanding' && !(c.invoiceSummary?.outstanding > 0.5)) return false;
      if (q && !`${c.name || ''} ${c.legalName || ''} ${c.clientCode || ''} ${c.displayCode || ''} ${c.contactName || ''} ${c.gst || ''}`.toLowerCase().includes(q)) return false;
      if (filters.industry && c.industry !== filters.industry) return false;
      if (filters.status && statusOf(c) !== filters.status) return false;
      if (filters.owner && (c.bdeOwner || c.bdeName) !== filters.owner) return false;
      if (filters.unassigned && String(c.bdeOwner || '').trim()) return false;
      if (filters.expiring === '30' && !(expiringIds.has(c.id) || (c.agreementEnd && c.agreementEnd >= today && c.agreementEnd <= ymd(new Date(Date.now() + 30 * 86400000))))) return false;
      if (filters.expiring === 'expired' && !(c.agreementStatus === 'EXPIRED' || (c.agreementEnd && c.agreementEnd < today))) return false;
      if (filters.department && c.ownerDepartment !== filters.department) return false;
      if (filters.location && c.location !== filters.location) return false;
      if (filters.agreement && c.agreementStatus !== filters.agreement) return false;
      if (filters.hasOpen === 'yes' && !(c.openRequirements > 0)) return false;
      if (filters.hasOpen === 'no' && c.openRequirements > 0) return false;
      if (filters.outstanding && !(c.invoiceSummary?.outstanding > 0.5)) return false;
      if (filters.overdue && !((c.invoiceSummary?.overdueDays || 0) >= Number(filters.overdue))) return false;
      return true;
    }).sort(sortFn);
  }, [clients, filters, currentView, currentSort, expiringIds, today]);
  const paged = usePaged(filtered);

  if (!allowed) {
    return (
      <div className="notice clrole-denied">
        The Clients module is not part of your role. You see each client&apos;s name on the requirements you work on.
      </div>
    );
  }

  const chips = [
    { key: 'search', label: 'Search', value: filters.search, onRemove: () => setFilter({ search: '' }) },
    { key: 'industry', label: 'Industry', value: filters.industry, onRemove: () => setFilter({ industry: '' }) },
    { key: 'status', label: 'Status', value: filters.status, onRemove: () => setFilter({ status: '' }) },
    { key: 'owner', label: 'Owner BDE', value: filters.owner, onRemove: () => setFilter({ owner: '' }) },
    { key: 'unassigned', label: 'Owner', value: filters.unassigned ? 'Unassigned' : '', onRemove: () => setFilter({ unassigned: '' }) },
    { key: 'expiring', label: 'Agreement', value: filters.expiring === '30' ? 'Expiring in 30 days' : filters.expiring === 'expired' ? 'Expired' : '', onRemove: () => setFilter({ expiring: '' }) },
    { key: 'department', label: 'Department', value: filters.department, onRemove: () => setFilter({ department: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => setFilter({ location: '' }) },
    { key: 'agreement', label: 'Agreement status', value: filters.agreement ? agreementStatusLabel(filters.agreement) : '', onRemove: () => setFilter({ agreement: '' }) },
    { key: 'hasOpen', label: 'Open requirements', value: filters.hasOpen === 'yes' ? 'Has open' : filters.hasOpen === 'no' ? 'None open' : '', onRemove: () => setFilter({ hasOpen: '' }) },
    { key: 'outstanding', label: 'Outstanding', value: filters.outstanding ? '> 0' : '', onRemove: () => setFilter({ outstanding: '' }) },
    { key: 'overdue', label: 'Overdue', value: filters.overdue ? `${filters.overdue}+ days` : '', onRemove: () => setFilter({ overdue: '' }) },
  ];

  const a = meta?.actions || {};
  const showMini = role && role !== 'accounts';
  const money = (v, bad = false) => (v == null ? '—' : <span className={`clrole-money${bad && v > 0 ? ' bad' : ''}`}>{inr(v)}</span>);

  const cell = (key, c) => {
    const to = (t) => `/clients/${c.id}?tab=${t}`;
    const inv = c.invoiceSummary;
    switch (key) {
      case 'code': return <td key={key}><span className="clrel-code">{c.displayCode || '—'}</span></td>;
      case 'industry': return <td key={key} className="cell-muted">{c.industry || '—'}</td>;
      case 'location': return <td key={key} className="cell-muted clrel-wrap">{c.location || '—'}{c.state && c.state !== c.location ? <span className="clrel-sub">{c.state}</span> : null}</td>;
      case 'legal': return <td key={key} className="cell-muted">{c.legalName || '—'}</td>;
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
            {c.bdeOwner || (c.bdeName ? <span title="From its requirements — no Owner BDE set">{c.bdeName}</span> : null)}
            {!String(c.bdeOwner || '').trim() && (role === 'admin' || role === 'mgmt')
              ? <span className="clrel-sub"><span className="clrel-pill warn">Unassigned</span></span> : null}
            {!c.bdeOwner && !c.bdeName && !(role === 'admin' || role === 'mgmt') ? '—' : null}
          </td>
        );
      case 'activeReqs': return <td key={key} className="clrel-num"><RelNum value={c.activeRequirements} to={to('requirements')} title={`${c.totalRequirements || 0} requirement(s) in total`} /></td>;
      case 'candidates': return <td key={key} className="clrel-num"><RelNum value={c.candidatesTotal} to={to('candidates')} /></td>;
      case 'submitted': return <td key={key} className="clrel-num"><RelNum value={c.candidatesSubmitted} to={to('candidates')} /></td>;
      case 'interviews': return <td key={key} className="clrel-num"><RelNum value={c.clientInterviews} to={to('interviews')} /></td>;
      case 'selected': return <td key={key} className="clrel-num"><RelNum value={c.selectedCount} to={to('selected')} /></td>;
      case 'joined': return <td key={key} className="clrel-num"><RelNum value={c.joinedCount} to={role === 'accounts' ? to('invoices') : to('selected')} /></td>;
      case 'pending': return <td key={key} className="clrel-num"><RelNum value={c.pendingDecisions} to={to('candidates')} /></td>;
      case 'agreement':
        return (
          <td key={key}>
            <StatusChip status={agreementStatusLabel(c.agreementStatus)} tone={agreementTone(c.agreementStatus)} />
            {c.agreementEnd ? <span className="clrel-sub">{`to ${c.agreementEnd}`}{expiringIds.has(c.id) ? ' · expiring' : ''}</span> : null}
          </td>
        );
      case 'status': return <td key={key}><StatusChip status={statusOf(c)} tone={statusOf(c) === 'Active' ? 'green' : statusOf(c) === 'Prospect' ? 'blue' : 'grey'} title={c.workStatus || c.status || ''} /></td>;
      case 'health':
        return (
          <td key={key}>
            {c.health ? <span className={`clrole-health ${c.health}`} title={`${HEALTH_HINT[c.health] || ''}${c.healthDays != null ? ` — last activity ${c.healthDays} day(s) ago` : ''}`}>{c.healthLabel}</span> : '—'}
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
            {inv && inv.overdue ? <span className="clrel-sub" style={{ textAlign: 'right' }}>{`${inv.overdue} overdue`}</span> : null}
          </td>
        );
      case 'overdueDays':
        return <td key={key} className={`clrole-money${inv && inv.overdueDays ? ' bad' : ''}`}>{inv && inv.overdueDays ? `${inv.overdueDays} d` : '—'}</td>;
      case 'invoiceStatus':
        return (
          <td key={key}>
            {inv && inv.status
              ? <StatusChip status={inv.status} tone={inv.status === 'Paid' ? 'green' : inv.status === 'Overdue' ? 'red' : 'amber'} title={`${inv.count} invoice(s) · ${inv.paid} paid · ${inv.pending} pending`} />
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

  const viewLabel = (views.find(([k]) => k === currentView) || views[0])[1];
  const narrowed = filtered.length !== clients.length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <div className="page-sub">
            {`${viewLabel} — `}
            <ScopeLine user={user} count={clients.length} noun="client account" inline />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* §3 — Import (Admin) · Export (Admin, Management, BDE own,
              Accounts): /ats-io/access decides, the ats-io routes enforce.
              The export sends the ids of the rows shown when narrowed; the
              server keeps only those of its own scoped GET /clients. */}
          {meta && (a.import || a.export) && (
            <AtsDataTools
              module="clients"
              kinds={a.import ? ['clients'] : []}
              onImported={load}
              body={() => ({ ids: narrowed ? filtered.map((c) => c.id) : null })}
            />
          )}
          {a.merge && <ClientDuplicatesButton />}
          {a.add && (
            <button type="button" className="btn btn-primary" onClick={() => { setFlash(''); setAdding(true); }}>+ Add Client</button>
          )}
        </div>
      </div>

      {/* The Clients module's own strip: Clients | Agreements. */}
      <ClientsTabs active="clients" />

      {metaError && <div className="notice red">{metaError}</div>}
      {loadError && <div className="notice red">{loadError}</div>}
      {flash && <div className="notice">{flash}</div>}

      {/* §8.3 — agreement expiry alert (Admin, BDE). */}
      {meta?.expiring?.count > 0 && (
        <div className="clrole-alert">
          <span>
            <b>{meta.expiring.count}</b>
            {` client${meta.expiring.count === 1 ? "'s agreement expires" : "s' agreements expire"} in ${meta.expiring.days} days.`}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setFilter({ expiring: '30' })}>Show them</button>
        </div>
      )}

      <div className="clrole-viewbar">
        {views.length > 1 && (
          <div className="clrole-view" role="tablist" aria-label="View">
            {views.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={currentView === k} className={currentView === k ? 'on' : ''} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="jobsws-mf">
        <MoreFilters
          storageKey="clients-role"
          activeMore={['department', 'location', 'agreement', 'hasOpen'].filter((k) => filters[k]).length}
          onClearAll={activeFilterCount ? clearFilters : undefined}
          primary={(
            <>
              <input
                type="text"
                placeholder={role === 'tl' || role === 'accounts' ? 'Search client…' : 'Search client, code, contact or GST…'}
                value={filters.search}
                onChange={(e) => setFilter({ search: e.target.value })}
                style={{ minWidth: 220 }}
              />
              {has('industry') && (
                <Combo value={filters.industry} title="Industry" onChange={(e) => setFilter({ industry: e.target.value })}>
                  <option value="">All industries</option>
                  {opts.industry.map((v) => <option key={v} value={v}>{v}</option>)}
                </Combo>
              )}
              {has('status') && (
                <Combo value={filters.status} title="Status" onChange={(e) => setFilter({ status: e.target.value })}>
                  <option value="">Any status</option>
                  {['Active', 'Inactive', 'Prospect'].map((v) => <option key={v} value={v}>{v}</option>)}
                </Combo>
              )}
              {has('owner') && (
                <Combo value={filters.owner} title="Owner BDE" onChange={(e) => setFilter({ owner: e.target.value })}>
                  <option value="">{role === 'bde' ? 'Any owner' : 'All Owner BDEs'}</option>
                  {opts.owner.map((v) => <option key={v} value={v}>{v}</option>)}
                </Combo>
              )}
              {has('unassigned') && (
                <label className="clrole-check">
                  <input type="checkbox" checked={!!filters.unassigned} onChange={(e) => setFilter({ unassigned: e.target.checked ? '1' : '' })} style={{ width: 'auto' }} />
                  Unassigned (no Owner BDE)
                </label>
              )}
              {has('expiring') && (
                <Combo value={filters.expiring} title="Agreement expiring" onChange={(e) => setFilter({ expiring: e.target.value })}>
                  <option value="">Agreement expiry — any</option>
                  <option value="30">Expiring in 30 days</option>
                  <option value="expired">Expired</option>
                </Combo>
              )}
              {has('outstanding') && (
                <Combo value={filters.outstanding} title="Outstanding" onChange={(e) => setFilter({ outstanding: e.target.value })}>
                  <option value="">Outstanding — any</option>
                  <option value="1">Outstanding &gt; 0</option>
                </Combo>
              )}
              {has('overdue') && (
                <Combo value={filters.overdue} title="Overdue" onChange={(e) => setFilter({ overdue: e.target.value })}>
                  <option value="">Overdue — any</option>
                  <option value="30">Overdue 30+ days</option>
                  <option value="60">Overdue 60+ days</option>
                  <option value="90">Overdue 90+ days</option>
                </Combo>
              )}
            </>
          )}
        >
          {has('department') && (
            <Combo value={filters.department} title="Department" onChange={(e) => setFilter({ department: e.target.value })}>
              <option value="">All departments</option>
              {opts.department.map((v) => <option key={v} value={v}>{v}</option>)}
            </Combo>
          )}
          {has('location') && (
            <Combo value={filters.location} title="Location" onChange={(e) => setFilter({ location: e.target.value })}>
              <option value="">All locations</option>
              {opts.location.map((v) => <option key={v} value={v}>{v}</option>)}
            </Combo>
          )}
          {has('agreement') && (
            <Combo value={filters.agreement} title="Agreement status" onChange={(e) => setFilter({ agreement: e.target.value })}>
              <option value="">Any agreement status</option>
              {opts.agreement.map((v) => <option key={v} value={v}>{agreementStatusLabel(v)}</option>)}
            </Combo>
          )}
          {has('hasOpen') && (
            <Combo value={filters.hasOpen} title="Open requirements" onChange={(e) => setFilter({ hasOpen: e.target.value })}>
              <option value="">Open requirements?</option>
              <option value="yes">Has open requirements</option>
              <option value="no">None open</option>
            </Combo>
          )}
        </MoreFilters>
      </div>

      <FilterChips filters={chips} onClearAll={activeFilterCount ? clearFilters : undefined} />

      <div className="clrel-toolbar">
        <span className="small-muted" style={{ marginRight: 'auto', fontSize: 12 }}>
          {narrowed ? `${filtered.length.toLocaleString('en-IN')} of ${clients.length.toLocaleString('en-IN')} clients` : `${clients.length.toLocaleString('en-IN')} clients`}
        </span>
        <label>
          Sort
          <select value={currentSort} onChange={(e) => setSortBy(e.target.value)}>
            {Object.entries(SORTS)
              .filter(([k]) => (!['outstanding', 'overdue'].includes(k) || meta?.invoiceMode === 'amounts')
                && (k !== 'submitted' || allowedCols.includes('submitted')))
              .map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        {allowedCols.length > 0 && (
          <ColumnChooser
            columns={allowedCols.map((k) => ({ key: k, label: labelFor(k, role) }))}
            value={cols}
            onChange={setCols}
            defaults={defaultCols}
          />
        )}
      </div>

      <ScrollTable maxHeight={null} bodyClassName="tbl-fit">
        <table className="clrel-table">
          <thead>
            <tr>
              <th className="clrel-sticky">Client</th>
              {visibleCols.map((k) => (
                <th key={k} className={NUM_COLS.includes(k) ? 'clrel-num' : MONEY_COLS.includes(k) ? 'clrole-money' : undefined}>{labelFor(k, role)}</th>
              ))}
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((c) => (
              <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}`)}>
                <td className="clrel-sticky">
                  <b>{c.name}</b>
                  {!visibleCols.includes('code') && <span className="clrel-sub clrel-code">{c.displayCode}</span>}
                  {/* §8.2 — mini stats: Open Reqs · Submitted · Selected · Joined. */}
                  {showMini && (
                    <span className="clrole-mini" title="Open requirements · Submitted to the client · Selected · Joined (in your scope)">
                      <span><b>{c.activeRequirements || 0}</b> open</span>
                      <span><b>{c.candidatesSubmitted || 0}</b> submitted</span>
                      <span><b>{c.selectedCount || 0}</b> selected</span>
                      <span><b>{c.joinedCount || 0}</b> joined</span>
                    </span>
                  )}
                </td>
                {visibleCols.map((k) => cell(k, c))}
                <td className="clrole-act" onClick={(e) => e.stopPropagation()}>
                  <ClientRowActions
                    c={c}
                    meta={meta}
                    onChanged={() => { setFlash(''); load(); }}
                    onEdit={(row) => setEditing(row)}
                    onNote={(row) => setNoteFor(row)}
                    onReassign={(row) => setReassignFor(row)}
                  />
                </td>
              </tr>
            ))}
            {loaded && filtered.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length + 2}>
                  {clients.length
                    ? <EmptyState compact title="No clients match this view and filters." hint="Remove a filter chip above, switch the view, or Clear All." action={<button type="button" className="btn btn-sm" onClick={() => { clearFilters(); setView(views[views.length > 1 ? 1 : 0][0]); }}>Show all</button>} />
                    : <EmptyState compact title="No clients in your scope." hint={role === 'tl' ? "Clients appear here once your team works one of their requirements." : role === 'accounts' ? 'Clients appear here once they have a joined candidate or an invoice.' : 'Clients you own or are assigned to appear here.'} />}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollTable>
      <Pager page={paged} noun="clients" />

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
      {reassignFor && (
        <ReassignModal client={reassignFor} onClose={() => setReassignFor(null)} onSaved={() => { setReassignFor(null); setFlash(`Owner BDE of ${reassignFor.name} updated.`); load(); }} />
      )}
    </div>
  );
}
