import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { atsRoleOf } from '../../nav';
import { FacetSelect, useFacets } from './ListPageHeader.jsx';
import './ListPageHeader.css';
import './PageFilterBar.css';

// ---------------------------------------------------------------------------
// THE SAME FILTERS ON EVERY PAGE (ATS layout v3, 2026-10-03):
//
//   [ Department ] [ Date range ] [ Client ] [ Recruiter / BDE ]   Clear
//
//   const [filters, setFilters] = usePageFilters();          // state in the URL
//   <PageFilterBar value={filters} onChange={setFilters} />
//   api.get('/x', { params: filterParams(filters) })          // -> API params
//
// value: { department, range, from, to, clientId, recruiterId, bdeId }
//   range: '' (any time) | 'today' | 'week' | 'month' | '30d' | 'custom'
//   from / to: 'YYYY-MM-DD' — filled for every preset by filterParams(); only
//   stored in the URL for 'custom'.
//
// CASCADING with counts: the options come from the SERVER
// (GET /api/ats-io/facets/<facetModule>, backend/src/utils/atsFacets.js),
// counted over the rows matching every OTHER chosen filter and the login's
// own scope — so picking Manufacturing narrows Client and Recruiter / BDE to
// Manufacturing ones. An option with nothing behind it is not offered.
// facetModule defaults to 'requirements' (every requirement carries a
// department, client, recruiter and BDE). Pass `options` to supply your own
// lists instead: { department, clientId, people: [{ value: 'rec:<id>' |
// 'bde:<id>', label, count }] } (e.g. from useLocalFacets).
//
// show: { department, dateRange, client, people } — all true by default.
// A RECRUITER never gets the people filter, and client options are names only.
// URL keys: department, range, from, to, clientId, recruiterId, bdeId.
// ---------------------------------------------------------------------------

export const DATE_RANGES = [
  ['', 'Any time'],
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['30d', 'Last 30 days'],
  ['custom', 'Custom'],
];
const KEYS = ['department', 'range', 'from', 'to', 'clientId', 'recruiterId', 'bdeId'];
export const EMPTY_FILTERS = Object.freeze({
  department: '', range: '', from: '', to: '', clientId: '', recruiterId: '', bdeId: '',
});

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The dates a range stands for, in local time. {} for "any time".
export function rangeDates(range, from, to, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (range) {
    case 'today': return { from: ymd(today), to: ymd(today) };
    case 'week': {
      const s = new Date(today);
      s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // Monday
      return { from: ymd(s), to: ymd(today) };
    }
    case 'month': return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
    case '30d': {
      const s = new Date(today);
      s.setDate(s.getDate() - 29);
      return { from: ymd(s), to: ymd(today) };
    }
    case 'custom': return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    default: return {};
  }
}

// Only the filters that are set, ready for an API call's params. The date
// range becomes from / to (and `range` stays, so a server may name it).
export function filterParams(value) {
  const v = value || {};
  const out = {};
  ['department', 'clientId', 'recruiterId', 'bdeId'].forEach((k) => { if (v[k]) out[k] = v[k]; });
  if (v.range) {
    out.range = v.range;
    Object.assign(out, rangeDates(v.range, v.from, v.to));
  }
  return out;
}

export function rangeLabel(value) {
  const v = value || {};
  if (v.range === 'custom') {
    if (v.from && v.to) return `${v.from} to ${v.to}`;
    if (v.from) return `From ${v.from}`;
    if (v.to) return `Until ${v.to}`;
  }
  return (DATE_RANGES.find(([k]) => k === (v.range || '')) || DATE_RANGES[0])[1];
}

// Filters kept in the URL (so a link, Back and a refresh keep them).
// defaults: e.g. { range: 'month' } when the URL says nothing.
export function usePageFilters(defaults) {
  const [sp, setSp] = useSearchParams();
  const defKey = JSON.stringify(defaults || {});
  const value = useMemo(() => {
    const d = defaults || {};
    const out = { ...EMPTY_FILTERS };
    KEYS.forEach((k) => {
      const got = sp.get(k);
      out[k] = got !== null ? got : (d[k] || '');
    });
    return out;
  }, [sp, defKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const setValue = useCallback((next) => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      const cur = {};
      KEYS.forEach((k) => { cur[k] = p.get(k) || ''; });
      const n = typeof next === 'function' ? next(cur) : next;
      const d = defaults || {};
      KEYS.forEach((k) => {
        const val = n && n[k] ? String(n[k]) : '';
        if (k === 'from' || k === 'to') {
          if (n && n.range === 'custom' && val) p.set(k, val); else p.delete(k);
          return;
        }
        // A value equal to the default is still written when the default is
        // set, so "Any time" can override a default of "This month".
        if (val) p.set(k, val);
        else if (d[k]) p.set(k, '');
        else p.delete(k);
      });
      return p;
    }, { replace: true });
  }, [setSp, defKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue];
}

export default function PageFilterBar({
  value: valueProp, onChange: onChangeProp, show, options, facetModule = 'requirements', facetParams, className = '',
}) {
  const { user } = useAuth() || {};
  const [urlValue, setUrlValue] = usePageFilters();
  const value = valueProp || urlValue;
  const onChange = onChangeProp || setUrlValue;
  const isRecruiter = atsRoleOf(user) === 'RECRUITER';
  const want = {
    department: true, dateRange: true, client: true, people: true, ...(show || {}),
  };
  if (isRecruiter) want.people = false;

  const params = useMemo(() => {
    const p = { ...(facetParams || {}) };
    if (value.department) p.department = value.department;
    if (value.clientId) p.clientId = value.clientId;
    if (value.recruiterId) p.recruiterId = value.recruiterId;
    if (value.bdeId) p.bdeId = value.bdeId;
    return p;
  }, [value.department, value.clientId, value.recruiterId, value.bdeId, facetParams]);
  const needServer = !options && (want.department || want.client || want.people);
  const { facets, loading } = useFacets(facetModule, params, { enabled: needServer });

  const deptOpts = (options && options.department) || facets.department || [];
  // Client options carry the NAME only (a recruiter sees no more than that).
  const clientOpts = ((options && options.clientId) || facets.clientId || []).map((o) => ({ value: o.value, label: o.label, count: o.count }));
  const peopleOpts = useMemo(() => {
    if (options && options.people) return options.people;
    const rec = (facets.recruiterId || []).map((o) => ({ ...o, value: `rec:${o.value}`, group: 'Recruiters' }));
    const bde = (facets.bdeId || []).map((o) => ({ ...o, value: `bde:${o.value}`, group: 'Client managers (BDE)' }));
    return [...rec, ...bde];
  }, [options, facets.recruiterId, facets.bdeId]);

  const set = (patch) => onChange({ ...value, ...patch });
  const personValue = value.recruiterId ? `rec:${value.recruiterId}` : value.bdeId ? `bde:${value.bdeId}` : '';
  const setPerson = (v) => {
    if (!v) return set({ recruiterId: '', bdeId: '' });
    const [kind, id] = [v.slice(0, 3), v.slice(4)];
    return set(kind === 'rec' ? { recruiterId: id, bdeId: '' } : { bdeId: id, recruiterId: '' });
  };
  const anySet = !!(value.department || value.range || value.clientId || value.recruiterId || value.bdeId);
  const peopleList = peopleOpts.filter((o) => Number(o.count) > 0 || o.value === personValue);
  const groups = [...new Set(peopleList.map((o) => o.group || ''))];

  return (
    <div className={`pfb ${className}`} role="search" aria-label="Filters for this page">
      {want.department && (
        <FacetSelect label="Department" value={value.department} onChange={(v) => set({ department: v })} options={deptOpts} allLabel="All departments" loading={loading} />
      )}
      {want.dateRange && (
        <label className="lph-facet pfb-range">
          <span className="lph-facet-lbl">Date range</span>
          <select value={value.range || ''} onChange={(e) => set({ range: e.target.value, ...(e.target.value === 'custom' ? {} : { from: '', to: '' }) })}>
            {DATE_RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      )}
      {want.dateRange && value.range === 'custom' && (
        <span className="lph-facet pfb-custom">
          <span className="lph-facet-lbl">From – to</span>
          <span className="lph-pair">
            <input type="date" aria-label="From date" value={value.from || ''} max={value.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <input type="date" aria-label="To date" value={value.to || ''} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </span>
        </span>
      )}
      {want.client && (
        <FacetSelect label="Client" value={value.clientId} onChange={(v) => set({ clientId: v })} options={clientOpts} allLabel="All clients" loading={loading} />
      )}
      {want.people && (peopleList.length > 0 || personValue) && (
        <label className="lph-facet">
          <span className="lph-facet-lbl">Recruiter / BDE</span>
          <select value={personValue} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Everyone</option>
            {groups.map((g) => {
              const opts = peopleList.filter((o) => (o.group || '') === g).map((o) => (
                <option key={o.value} value={o.value}>{`${o.label}${o.count !== undefined && o.count !== null ? ` (${Number(o.count).toLocaleString('en-IN')})` : ''}`}</option>
              ));
              return g ? <optgroup key={g} label={g}>{opts}</optgroup> : opts;
            })}
          </select>
        </label>
      )}
      {anySet && (
        <button type="button" className="btn btn-sm btn-ghost pfb-clear" onClick={() => onChange({ ...EMPTY_FILTERS })}>
          Clear filters
        </button>
      )}
    </div>
  );
}
