// Shared furniture for the Interviews & Joining screens (Interview Feedback,
// Offers, Joining, Internal Hiring). Nothing here decides anything: the API
// refuses, these helpers only render.

import { useEffect, useMemo, useState } from 'react';
import { ListToolbar, FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import PeopleFilter, { useAtsWorkers, personOptions } from '../../components/PeopleFilter.jsx';
import HierarchyFilter, { toParams, hierarchyChips, useHierarchy } from '../../components/HierarchyFilter.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';

export const fmtDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
export const money = (n) => (n === '' || n == null ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);

// The module's five tabs. The nav links here too; this strip keeps the group
// navigable from inside any one of them.
// §1 — OFFERS, JOINING AND INTERNAL HIRING ARE NOT ATS MODULES.
//
// They were rendered as a five-item tab strip at the top of the Interview
// Calendar, which reads exactly like five more top-level modules and
// invites "ATS lo inka 5 modules unnaya?". They are workflow states of a
// CANDIDATE, so they are reached from the candidate record and from the
// pipeline tabs that already carry them (Selected, Offer, Joining, Joined).
//
// The screens still exist and are still routed — nothing was deleted, and
// a link or a bookmark still opens them. What changed is that the Interview
// Calendar no longer advertises them as peers of itself.
// §1 — OFFERS, JOINING AND INTERNAL HIRING ARE NOT ATS MODULES.
//
// They were in a five-item strip at the TOP OF THE INTERVIEW CALENDAR, which
// reads exactly like five more top-level modules and invites "ATS lo inka 5
// modules unnaya?". They are workflow states of a CANDIDATE.
//
// So the strip stays on the four workflow screens — they are a workspace group
// and still need to reach each other — and the Interview Calendar, which is a
// real ATS module, no longer advertises them as its peers. Nothing was
// deleted: every screen is still routed, and the pipeline tabs (Selected,
// Offer, Joining, Joined) and the candidate record are how they are reached.
export const INTJOIN_TABS = [
  { to: '/ats/interview-feedback', label: 'Interview Feedback' },
  { to: '/ats/offers', label: 'Offers' },
  { to: '/ats/joining', label: 'Joining' },
  // No "Internal Hiring" tab: internal hiring is not a separate module (the
  // user's rule, 2026-09-29) — internal hires are on Offers / Joining with a
  // hiring-type chip, and Create HRMS Employee is on Joining and Candidate 360.
];

// Where those workspaces are reached from instead: the candidate record.
// Kept as data so the screens themselves can still show each other.
export const WORKFLOW_WORKSPACES = [
  { to: '/ats/interview-feedback', label: 'Interview Feedback' },
  { to: '/ats/offers', label: 'Offers' },
  { to: '/ats/joining', label: 'Joining' },
  { to: '/ats/internal-hiring', label: 'Internal Hiring' },
];

// One loader + one action runner, so every screen fails the same way.
export function useWorkspace(url) {
  const [data, setData] = useState({ rows: [], filterOptions: {}, loading: true });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    api.get(url)
      .then((res) => setData(res.data))
      .catch((err) => { setData((d) => ({ ...d, loading: false })); setError(err.response?.data?.error || 'Could not load the list. Please try again.'); });
  }
  useEffect(load, [url]);

  async function act(fn, successMessage) {
    setError(''); setNotice(''); setBusy(true);
    try {
      const res = await fn();
      if (successMessage) setNotice(successMessage);
      else if (res && res.data && res.data.message) setNotice(res.data.message);
      load();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that change. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { data, error, notice, busy, act, load, setError, setNotice };
}

export function Banner({ error, notice }) {
  return (
    <>
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section" style={{ marginBottom: 14 }}>{notice}</div>}
    </>
  );
}

// styles.css has no modal, so every form on these screens opens as an inline
// card below the table — the same pattern the Interview Calendar uses.
export function Panel({ title, subtitle, children, onClose }) {
  return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><h3>{title}</h3>{subtitle && <div className="page-sub">{subtitle}</div>}</div>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
      {children}
    </div>
  );
}

export function HiringTypeChip({ value }) {
  const internal = value === 'TeamLink Internal Hire';
  // The hiring type is information, not a state: small grey text, not a
  // coloured chip, and no step strip in a tooltip (simplicity checklist).
  return <span className="small-muted">{internal ? 'TeamLink hire' : 'Client hire'}</span>;
}

// The shared filter set for Interviews & Joining (user notes #1 / #11, review
// #3 §10 / §14 / §21 / §22) — the list standard:
//   always visible  Search · Department → Section → Recruiter (HierarchyFilter,
//                   levels the login can't use are hidden) · Status · Hiring type
//   More Filters ▾  TL · Client (client desk only) · Requirement · Candidate ·
//                   BDE · Date range
//   then the active filters as chips, Clear All, a Sort and "N of M".
// recruiter / tl / bde hold "id:<userId>" or "name:<name>" (current AND former
// people); recruiter may also be "seat:<CODE>" (a Recruiter Code). Whose work a
// row is, is decided by the server (usePersonApplicationIds).
export const EMPTY_INTJOIN_FILTERS = {
  q: '', department: '', section: '', client: '', requirement: '', candidate: '',
  recruiter: '', positionCode: '', tl: '', bde: '', hiringType: '', status: '', from: '', to: '', sort: '',
};

const hierOf = (f) => ({
  department: f.department || '', section: f.section || '', tl: f.tl || '', recruiter: f.recruiter || '',
});

// The person / seat query for the chosen hierarchy + BDE, in the parameter
// names GET /ats/workers/applications takes. {} = no person filter.
function personParams(filters, data) {
  const p = toParams(hierOf(filters), data || undefined);
  const out = {};
  if (p.tl) out.tl = p.tl;
  if (p.recruiter) out.recruiter = p.recruiter;
  if (p.positionCode || filters.positionCode) out.positionCode = p.positionCode || filters.positionCode;
  if (filters.bde) out.bde = filters.bde;
  return out;
}

// The application ids attributed to the chosen Recruiter / TL / BDE / seat /
// section (GET /ats/workers/applications — the attribution ATS Reports counts
// with), or null when no person filter is set. Pass it to matchesShared().
export function usePersonApplicationIds(filters) {
  const tree = useHierarchy();
  const params = personParams(filters, tree.data);
  const key = JSON.stringify(params);
  const [ids, setIds] = useState(null);
  useEffect(() => {
    if (!Object.keys(params).length) { setIds(null); return undefined; }
    let live = true;
    api.get('/ats/workers/applications', { params })
      .then((res) => { if (live) setIds(new Set(res.data.ids || [])); })
      .catch(() => { if (live) setIds(new Set()); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return ids;
}

const MORE_KEYS = ['tl', 'client', 'requirement', 'candidate', 'bde', 'from', 'to'];
const FILTER_KEYS = ['q', 'department', 'section', 'recruiter', 'positionCode', 'status', 'hiringType', ...MORE_KEYS];
export const intJoinActive = (filters) => FILTER_KEYS.filter((k) => filters[k]).length;

// Sort: the server's order (most recently updated first) by default, or the
// screen's own date either way, or candidate A–Z.
export function intJoinSorts(dateLabel = 'Date') {
  return [
    { key: '', label: 'Latest change' },
    { key: 'dateDesc', label: 'Newest' },
    { key: 'dateAsc', label: 'Oldest' },
    { key: 'name', label: 'Name A–Z' },
  ];
}
export function sortIntJoin(rows, sort, getDate) {
  if (!sort) return rows;
  const out = [...rows];
  if (sort === 'name') return out.sort((a, b) => String(a.candidate?.name || '').localeCompare(String(b.candidate?.name || '')));
  const t = (r) => { const v = getDate ? getDate(r) : null; const n = v ? new Date(v).getTime() : NaN; return Number.isNaN(n) ? null : n; };
  return out.sort((a, b) => {
    const x = t(a); const y = t(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sort === 'dateAsc' ? x - y : y - x;
  });
}

// "No X match these filters — Clear filters" / "No X yet."
export function IntJoinEmpty({ filters, onClear, noun, title, hint, loading }) {
  // Still fetching: say so, rather than an empty-state that reads as "none".
  if (loading) return <div className="small-muted" style={{ padding: 16 }}>Loading {noun}…</div>;
  return <ListEmpty lf={{ activeCount: intJoinActive(filters), clear: onClear }} noun={noun} title={title} hint={hint} />;
}

const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

export function IntJoinFilters({
  filters, setFilter, opts, onClear, count, total, noun = 'rows', storageKey = 'intjoin',
  statuses, statusLabel = 'Status', statusAll = 'All statuses', dateLabel = 'Date range', noClient = false, noHiringType = false, children,
}) {
  const { user } = useAuth();
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const tree = useHierarchy();
  const workers = useAtsWorkers();
  const h = hierOf(filters);
  const setHier = (next) => setFilter({
    department: next.department || '', section: next.section || '', tl: next.tl || '', recruiter: next.recruiter || '', positionCode: '',
  });
  const sel = (key, blank, list, title) => (
    <Combo value={filters[key]} title={title} onChange={(e) => setFilter({ [key]: e.target.value })}>
      <option value="">{blank}</option>
      {(list || []).map((v) => <option key={v}>{v}</option>)}
    </Combo>
  );
  const statusOpt = (statuses || []).find((s) => s.value === filters.status);
  const bdeLabel = filters.bde
    ? ((personOptions(workers, 'BDE').find((o) => o.value === filters.bde) || {}).label
      || (filters.bde.startsWith('name:') ? filters.bde.slice(5) : 'Selected BDE'))
    : '';
  const dates = filters.from && filters.to ? `${dmy(filters.from)} → ${dmy(filters.to)}`
    : filters.from ? `from ${dmy(filters.from)}` : filters.to ? `to ${dmy(filters.to)}` : '';
  const active = intJoinActive(filters);
  const chips = [
    { key: 'q', label: 'Search', value: filters.q, onRemove: () => setFilter({ q: '' }) },
    ...hierarchyChips(h, tree.data, setHier),
    { key: 'positionCode', label: 'Recruiter Code', value: filters.positionCode, onRemove: () => setFilter({ positionCode: '' }) },
    { key: 'status', label: statusLabel, value: statusOpt ? statusOpt.label : filters.status, onRemove: () => setFilter({ status: '' }) },
    { key: 'hiringType', label: 'Hiring type', value: filters.hiringType, onRemove: () => setFilter({ hiringType: '' }) },
    { key: 'client', label: 'Client', value: filters.client, onRemove: () => setFilter({ client: '' }) },
    { key: 'requirement', label: 'Job', value: filters.requirement, onRemove: () => setFilter({ requirement: '' }) },
    { key: 'candidate', label: 'Candidate', value: filters.candidate, onRemove: () => setFilter({ candidate: '' }) },
    { key: 'bde', label: 'Client manager (BDE)', value: bdeLabel, onRemove: () => setFilter({ bde: '' }) },
    { key: 'dates', label: dateLabel, value: dates, onRemove: () => setFilter({ from: '', to: '' }) },
  ];
  const sorts = intJoinSorts(dateLabel.replace(/ range$/i, ''));
  return (
    <div className="lf">
      <MoreFilters
        storageKey={storageKey}
        activeMore={MORE_KEYS.filter((k) => filters[k]).length - (filters.from && filters.to ? 1 : 0)}
        onClearAll={active ? onClear : undefined}
        primary={(
          <>
            <input
              type="search"
              placeholder="Search name or job…"
              value={filters.q}
              onChange={(e) => setFilter({ q: e.target.value })}
              style={{ minWidth: 220 }}
              aria-label="Search"
            />
            <HierarchyFilter value={h} onChange={setHier} show={{ tl: false }} />
            {statuses && statuses.length > 0 && (
              <Combo value={filters.status} title={statusLabel} onChange={(e) => setFilter({ status: e.target.value })}>
                <option value="">{statusAll}</option>
                {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Combo>
            )}
            {!noHiringType && sel('hiringType', 'All hiring types', opts.hiringTypes, 'Hiring type')}
            {children}
          </>
        )}
        extra={(
          <>
            <label className="lf-sort">
              Sort
              <select value={filters.sort || ''} onChange={(e) => setFilter({ sort: e.target.value })}>
                {sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <span className="small-muted lf-count">
              {active && total != null
                ? `${Number(count).toLocaleString('en-IN')} of ${Number(total).toLocaleString('en-IN')} ${noun}`
                : `${Number(count).toLocaleString('en-IN')} ${noun}`}
            </span>
          </>
        )}
      >
        <HierarchyFilter value={h} onChange={setHier} show={{ department: false, section: false, recruiter: false }} />
        {!noClient && clientDesk && sel('client', 'All clients', opts.clients, 'Client')}
        {sel('requirement', 'All jobs', opts.requirements, 'Job')}
        {sel('candidate', 'All candidates', opts.candidates, 'Candidate')}
        <PeopleFilter role="BDE" department={filters.department} value={filters.bde} onChange={(v) => setFilter({ bde: v })} />
        <span className="lf-dates" title={dateLabel}>
          <span className="lf-dates-lbl">{dateLabel}</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter({ from: e.target.value })} aria-label={`${dateLabel} from`} />
          <span aria-hidden="true">→</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter({ to: e.target.value })} aria-label={`${dateLabel} to`} />
        </span>
      </MoreFilters>
      <FilterChips filters={chips} onClearAll={active ? onClear : undefined} />
    </div>
  );
}

// The date-range half of the filter, applied to whichever date the screen is
// about (the interview slot, the joining date, …).
export function inRange(value, from, to) {
  if (!from && !to) return true;
  if (!value) return false;
  const d = new Date(value).toISOString().slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

export function matchesShared(row, filters, dateValue, personIds = null) {
  const q = (filters.q || '').trim().toLowerCase();
  if (filters.department && row.requirement.department !== filters.department) return false;
  if (filters.client && row.requirement.client?.name !== filters.client) return false;
  if (filters.requirement && row.requirement.title !== filters.requirement) return false;
  if (filters.candidate && row.candidate.name !== filters.candidate) return false;
  // Recruiter / Position / TL / BDE: the server's answer (usePersonApplicationIds).
  if (personIds && !personIds.has(row.id)) return false;
  if (filters.hiringType && row.hiringType !== filters.hiringType) return false;
  if (!inRange(dateValue, filters.from, filters.to)) return false;
  if (q && !`${row.candidate.name} ${row.candidate.email || ''} ${row.requirement.title} ${row.requirement.client?.name || ''} ${row.interviewCode || ''}`.toLowerCase().includes(q)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// THE SIMPLE LIST TOOLBAR for Feedback / Offers / Joining (simplicity
// checklist 2026-10-03, §9 §10): one search box, ONE Filters button, a
// compact sort, active filters as chips with Clear all. The options CASCADE
// and carry counts (useLocalFacets over the screen's own rows — the rows are
// already your area, cut by the server), zero options are hidden.
//   const { rows, toolbar } = useIntJoinList(allRows, { status, dateOf, … })
// ---------------------------------------------------------------------------
const EMPTY_LIST = { q: '', department: '', client: '', job: '', recruiter: '', hiringType: '', status: '' };
export function useIntJoinList(allRows, {
  status = null, // { label, get(row) -> value, text(value) -> label }
  dateOf = () => null,
  defaultSort = '',
  placeholder = 'Search name or job…',
  sortOptions = null,
} = {}) {
  const { user } = useAuth();
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const [f, setF] = useState(EMPTY_LIST);
  const [sort, setSort] = useState(defaultSort);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const fields = useMemo(() => [
    { key: 'department', get: (r) => r.requirement.department },
    ...(clientDesk ? [{ key: 'client', get: (r) => (r.hiringType === 'TeamLink Internal Hire' ? 'TeamLink (internal)' : r.requirement.client?.name) }] : []),
    { key: 'job', get: (r) => r.requirement.title },
    { key: 'recruiter', get: (r) => (r.requirement.recruiter ? r.requirement.recruiter.id : null), label: (v, r) => r.requirement.recruiter.name },
    { key: 'hiringType', get: (r) => r.hiringType, label: (v) => (v === 'TeamLink Internal Hire' ? 'TeamLink hire' : 'Client hire') },
    ...(status ? [{ key: 'status', get: status.get, label: (v) => (status.text ? status.text(v) : v) }] : []),
  ], [clientDesk, status]);
  const searched = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return (allRows || []).filter((r) => !q || `${r.candidate.name} ${r.requirement.title} ${r.requirement.client?.name || ''}`.toLowerCase().includes(q));
  }, [allRows, f.q]);
  const values = useMemo(() => Object.fromEntries(fields.map((x) => [x.key, f[x.key]])), [fields, f]);
  const facets = useLocalFacets(searched, fields, values);
  const rows = useMemo(() => {
    const list = searched.filter((r) => fields.every((x) => !values[x.key] || String(x.get(r) ?? '') === String(values[x.key])));
    if (sort === 'name') return [...list].sort((a, b) => String(a.candidate.name).localeCompare(String(b.candidate.name)));
    if (sort === 'oldest' || sort === 'newest') {
      const t = (r) => { const v = dateOf(r); const n = v ? new Date(v).getTime() : NaN; return Number.isNaN(n) ? Infinity : n; };
      return [...list].sort((a, b) => (sort === 'oldest' ? t(a) - t(b) : t(b) - t(a)));
    }
    return list;
  }, [searched, fields, values, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = (key, v) => ((facets[key] || []).find((o) => String(o.value) === String(v)) || {}).label || v;
  const NAMES = { department: 'Department', client: 'Client', job: 'Job', recruiter: 'Recruiter', hiringType: 'Hiring', status: status ? status.label : 'Status' };
  const chips = [
    ...fields.filter((x) => f[x.key]).map((x) => ({ key: x.key, label: NAMES[x.key], value: label(x.key, f[x.key]), onRemove: () => set({ [x.key]: '' }) })),
    f.q && { key: 'q', label: 'Search', value: f.q, onRemove: () => set({ q: '' }) },
  ].filter(Boolean);
  const toolbar = (
    <ListToolbar
      search={f.q}
      onSearch={(v) => set({ q: v })}
      placeholder={placeholder}
      filterCount={chips.filter((c) => c.key !== 'q').length}
      sort={sort}
      sortOptions={sortOptions || [['', 'Latest change'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name A–Z']]}
      onSort={setSort}
      chips={chips}
      onClearAll={() => setF(EMPTY_LIST)}
      panel={(
        <>
          {status && <FacetSelect label={status.label} value={f.status} onChange={(v) => set({ status: v })} options={facets.status} allLabel="Any" />}
          <FacetSelect label="Department" value={f.department} onChange={(v) => set({ department: v })} options={facets.department} allLabel="All departments" />
          {clientDesk && <FacetSelect label="Client" value={f.client} onChange={(v) => set({ client: v })} options={facets.client} allLabel="All clients" />}
          <FacetSelect label="Job" value={f.job} onChange={(v) => set({ job: v })} options={facets.job} allLabel="All jobs" />
          <FacetSelect label="Recruiter" value={f.recruiter} onChange={(v) => set({ recruiter: v })} options={facets.recruiter} allLabel="All recruiters" />
          <FacetSelect label="Hiring" value={f.hiringType} onChange={(v) => set({ hiringType: v })} options={facets.hiringType} allLabel="Both kinds" />
        </>
      )}
    />
  );
  return { rows, toolbar, active: chips.length, clear: () => setF(EMPTY_LIST) };
}
