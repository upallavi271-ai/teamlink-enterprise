import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { atsRoleOf } from '../../nav';
import { FacetSelect, useFacets } from './ListPageHeader.jsx';
import './ListPageHeader.css';
import './PageFilterBar.css';
import Combo from '../Combo.jsx';
import { PRESETS, presetDates, dateProblem } from '../../utils/dateRanges.js';

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

// The presets are the shared list (utils/dateRanges.js): the same words, in the same order, on every screen.
export const DATE_RANGES = PRESETS;
const KEYS = ['department', 'range', 'from', 'to', 'clientId', 'recruiterId', 'bdeId'];
export const EMPTY_FILTERS = Object.freeze({
  department: '', range: '', from: '', to: '', clientId: '', recruiterId: '', bdeId: '',
});

// The dates a range stands for, in IST days. {} for "any time".
export function rangeDates(range, from, to, now = new Date()) {
  return presetDates(range, from, to, now);
}

// Only the filters that are set, ready for an API call's params. The date
// range becomes from / to (and `range` stays, so a server may name it).
export function filterParams(value) {
  const v = value || {};
  const out = {};
  ['department', 'clientId', 'recruiterId', 'bdeId'].forEach((k) => { if (v[k]) out[k] = v[k]; });
  if (v.range) {
    // an unfinished or backwards custom range is not sent (the bar says why); the list stays as it was
    if (v.range === 'custom' && dateProblem(v.from, v.to)) return out;
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

// THE FILTERS ARE REMEMBERED PER PAGE (2026-11-18): going to another module and coming back used to drop them (a Custom
// date range had to be picked again). Each page's filters are kept for this login in sessionStorage (this browser tab,
// until it is closed) and put back in the URL when the page is opened again with no filters in its address. A link
// that carries its own filters wins; "Clear filters" is remembered as cleared.
const MEMORY_PREFIX = 'tl.pageFilters:';
function readRemembered(key) {
  try { const v = JSON.parse(window.sessionStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
function writeRemembered(key, value) {
  try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off: the URL still works */ }
}

// Filters kept in the URL (so a link, Back and a refresh keep them).
// defaults: e.g. { range: 'month' } when the URL says nothing.
// opts.extraKeys: more URL keys of this page to remember with the filters (the ATS dashboard's Team lead, Dashboard of).
// opts.remember: false = do not remember (PageFilterBar's own copy when the page passes value / onChange itself).
export function usePageFilters(defaults, opts) {
  const [sp, setSp] = useSearchParams();
  const { pathname } = useLocation();
  const { user } = useAuth() || {};
  const remember = !opts || opts.remember !== false;
  const memKeys = [...KEYS, ...((opts && opts.extraKeys) || [])];
  const memKeysKey = memKeys.join(',');
  const storeKey = remember && user && user.id ? `${MEMORY_PREFIX}${user.id}:${pathname}` : '';
  const restored = useRef('');
  useEffect(() => {
    if (!storeKey || restored.current === storeKey) return;
    restored.current = storeKey;
    if (memKeys.some((k) => sp.has(k))) return; // the address already says which filters
    const saved = readRemembered(storeKey);
    if (!saved || !Object.keys(saved).length) return;
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      memKeys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(saved, k) && !p.has(k)) p.set(k, String(saved[k])); });
      return p;
    }, { replace: true });
  }, [storeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!storeKey || restored.current !== storeKey) return;
    const out = {};
    memKeys.forEach((k) => { const v = sp.get(k); if (v !== null) out[k] = v; });
    writeRemembered(storeKey, out);
  }, [sp, storeKey, memKeysKey]); // eslint-disable-line react-hooks/exhaustive-deps
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

// Optional extras (the ATS dashboard, 2026-10-09): ranges = a different Date
// range list ([[value, label], …]); children = more filters drawn inside the bar
// (e.g. Team lead) before "Clear filters"; extraSet = true when one of those is
// set (so Clear shows); onClear = what Clear does when it must also reset them.
export default function PageFilterBar({
  value: valueProp, onChange: onChangeProp, show, options, facetModule = 'requirements', facetParams, className = '',
  ranges, children, extraSet = false, onClear,
}) {
  const { user } = useAuth() || {};
  const [urlValue, setUrlValue] = usePageFilters(undefined, { remember: !valueProp });
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
  const anySet = !!(value.department || value.range || value.clientId || value.recruiterId || value.bdeId || extraSet);
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
          <Combo value={value.range || ''} onChange={(e) => set({ range: e.target.value, ...(e.target.value === 'custom' ? {} : { from: '', to: '' }) })}>
            {(ranges || DATE_RANGES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Combo>
        </label>
      )}
      {want.dateRange && value.range === 'custom' && (
        <span className="lph-facet pfb-custom">
          <span className="lph-facet-lbl">From – to</span>
          <span className="lph-pair">
            <input type="date" aria-label="From date" value={value.from || ''} max={value.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <input type="date" aria-label="To date" value={value.to || ''} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </span>
          {dateProblem(value.from, value.to) && <span className="small-muted" role="alert" style={{ color: 'var(--danger, #b42318)' }}>{dateProblem(value.from, value.to)}</span>}
        </span>
      )}
      {want.client && (
        <FacetSelect label="Client" value={value.clientId} onChange={(v) => set({ clientId: v })} options={clientOpts} allLabel="All clients" loading={loading} />
      )}
      {want.people && (peopleList.length > 0 || personValue) && (
        <label className="lph-facet">
          <span className="lph-facet-lbl">Recruiter / BDE</span>
          <Combo value={personValue} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Everyone</option>
            {groups.map((g) => {
              const opts = peopleList.filter((o) => (o.group || '') === g).map((o) => (
                <option key={o.value} value={o.value}>{`${o.label}${o.count !== undefined && o.count !== null ? ` (${Number(o.count).toLocaleString('en-IN')})` : ''}`}</option>
              ));
              return g ? <optgroup key={g} label={g}>{opts}</optgroup> : opts;
            })}
          </Combo>
        </label>
      )}
      {children}
      {anySet && (
        <button type="button" className="btn btn-sm btn-ghost pfb-clear" onClick={() => (onClear ? onClear() : onChange({ ...EMPTY_FILTERS }))}>
          Clear filters
        </button>
      )}
    </div>
  );
}
