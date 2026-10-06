import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import FilterChips from '../FilterChips.jsx';
import './ListPageHeader.css';

// ---------------------------------------------------------------------------
// THE SAME LAYOUT IN EVERY MODULE (user's spec 2026-10-03 §B):
//
//   Candidates & Pipeline     [ Import ] [ Export ] [ History ]  [ + Add Candidate ]
//   Where is each candidate right now?
//    To do 12 | Active | Interview | Selected | Joined
//    [ Search...                      ] [ Filters (3) ]  [ Sort: newest ]
//    Medical ✕   Orbit Software ✕   Ravi K. ✕          Clear all
//    ──────────────────────────────────────────────────────────
//    table
//    Showing 1 to 25 of 7,794
//
//   <ListPageHeader title="Candidates & Pipeline" question="Where is each candidate right now?"
//     data={<AtsDataTools … />} primary={<button className="btn btn-primary">+ Add Candidate</button>} />
//   <StatusTabs tabs={[{ key, label, count, hint }]} value={tab} onChange={setTab} hideZero={!admin} />
//   <ListToolbar search={q} onSearch={setQ} filterCount={n} panel={<>…FacetSelect…</>}
//     sort={sort} sortOptions={[['new','Newest']]} onSort={setSort} chips={chips} onClearAll={clear} />
//   …table…
//   <ListFooter from={1} to={25} total={7794} />
//
// ONE primary button; import / export are SEPARATE plain buttons (user change
// 2026-10-03: no dropdown) — Import · Export · History
// (components/AtsDataTools.jsx). Filters are ONE button opening a panel;
// what is set shows as removable chips + "Clear all". Filter options carry
// counts and an option with nothing behind it is not offered (FacetSelect).
// ---------------------------------------------------------------------------

export default function ListPageHeader({
  title, question, sub, data, primary, extra, className = '',
}) {
  return (
    <div className={`page-head lph-head ${className}`}>
      <div className="lph-titles">
        <h1>{title}</h1>
        {question && <div className="lph-question">{question}</div>}
        {sub && <div className="page-sub lph-sub">{sub}</div>}
      </div>
      <div className="lph-actions">
        {extra}
        {data}
        {primary}
      </div>
    </div>
  );
}

// Status tabs with counts. hideZero: a tab with 0 is not drawn (non-admins —
// "don't show empty things"), except the one that is selected.
export function StatusTabs({
  tabs = [], value, onChange, hideZero = false, label = 'Status', extra, className = '',
}) {
  const shown = tabs.filter((t) => !hideZero || t.key === value || t.count === undefined || t.count === null || Number(t.count) > 0);
  if (!shown.length) return null;
  return (
    <div className={`lph-tabs ${className}`}>
      <div className="tabs" role="tablist" aria-label={label}>
        {shown.map((t) => (
          <div
            key={t.key}
            role="tab"
            tabIndex={0}
            aria-selected={value === t.key}
            className={`tab${value === t.key ? ' active' : ''}`}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(t.key); } }}
            title={t.hint}
          >
            {t.label}
            {/* Never a bare zero: "Today", not "Today 0". */}
            {t.count !== undefined && t.count !== null && Number(t.count) > 0 && <span className="n">{Number(t.count).toLocaleString('en-IN')}</span>}
          </div>
        ))}
      </div>
      {extra}
    </div>
  );
}

// [ Search ] [ Filters (n) ] [ Sort ] (+ saved views, extra on the right),
// the Filters panel, then the chips + Clear all.
export function ListToolbar({
  search, onSearch, onSearchSubmit, placeholder = 'Search…', searchWidth = 280,
  filterCount = 0, panel, panelFooter, defaultOpen = false,
  sort, sortOptions, onSort, sortExtra,
  savedViews, right, chips = [], onClearAll, className = '',
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  const hasPanel = !!panel;
  return (
    <div className={`lph-bar ${className}`} ref={wrap}>
      <div className="lph-row">
        {onSearch && (
          <input
            type="search"
            className="lph-search"
            placeholder={placeholder}
            value={search || ''}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && onSearchSubmit) { e.preventDefault(); onSearchSubmit(); } }}
            style={{ minWidth: searchWidth }}
            aria-label="Search"
          />
        )}
        {hasPanel && (
          <button
            type="button"
            className={`btn btn-sm lph-filters-btn${open ? ' on' : ''}${filterCount ? ' set' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {`Filters${filterCount ? ` (${filterCount})` : ''}`} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        )}
        {sortOptions && sortOptions.length > 1 && (
          <label className="lph-sort">
            <span>Sort</span>
            <select value={sort} onChange={(e) => onSort(e.target.value)}>
              {sortOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {sortExtra}
          </label>
        )}
        {savedViews}
        {right && <span className="lph-right">{right}</span>}
      </div>
      {hasPanel && open && (
        <div className="lph-panel" role="region" aria-label="Filters">
          <div className="lph-panel-grid">{panel}</div>
          <div className="lph-panel-foot">
            {panelFooter}
            {onClearAll && filterCount > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={onClearAll}>Clear all</button>}
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
      <FilterChips filters={chips} onClearAll={onClearAll} label="" className="lph-chips" />
    </div>
  );
}

// "Showing 1 to 25 of 7,794"
export function ListFooter({
  from, to, total, noun = '', children,
}) {
  if (!total) return children ? <div className="lph-foot">{children}</div> : null;
  const f = (n) => Number(n || 0).toLocaleString('en-IN');
  return (
    <div className="lph-foot">
      <span>{`Showing ${f(from)} to ${f(to)} of ${f(total)}${noun ? ` ${noun}` : ''}`}</span>
      {children}
    </div>
  );
}

// A select whose options carry counts — "Orbit Software (12)". Options with
// 0 are never offered (except the chosen one, so it can be seen and removed);
// with nothing to choose the control is not drawn at all.
export function FacetSelect({
  label, value, onChange, options, allLabel, loading = false, style, title,
}) {
  const list = (options || []).filter((o) => Number(o.count) > 0 || String(o.value) === String(value || ''));
  if (!list.length && !value) return loading ? <span className="lph-facet lph-facet-loading">{label}…</span> : null;
  return (
    <label className="lph-facet" title={title || label}>
      <span className="lph-facet-lbl">{label}</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} style={style}>
        <option value="">{allLabel || 'Any'}</option>
        {list.map((o) => (
          <option key={o.value} value={o.value}>{`${o.label}${o.count !== undefined && o.count !== null ? ` (${Number(o.count).toLocaleString('en-IN')})` : ''}`}</option>
        ))}
      </select>
    </label>
  );
}

// A plain labelled control for the panel (date range, number, text).
export function PanelField({ label, children, wide = false }) {
  return (
    <label className={`lph-facet${wide ? ' wide' : ''}`}>
      <span className="lph-facet-lbl">{label}</span>
      {children}
    </label>
  );
}

// Server-counted options: GET /api/ats-io/facets/:module with the screen's
// own filter params (utils/atsFacets.js). Debounced; the last answer wins.
export function useFacets(module, params, { enabled = true } = {}) {
  const key = JSON.stringify(params || {});
  const [state, setState] = useState({ facets: {}, total: null, loading: false });
  useEffect(() => {
    if (!enabled || !module) return undefined;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api.get(`/ats-io/facets/${module}`, { params: params || {} })
        .then((res) => { if (live) setState({ facets: res.data.facets || {}, total: res.data.total, loading: false }); })
        .catch(() => { if (live) setState((s) => ({ ...s, loading: false })); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [module, key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// Browser-counted options for a list the page already holds whole (Clients,
// Recruiter & BDE, Interview Calendar). fields: [{ key, get(row) -> value |
// [values], label?(value,row) }]; values: the current filter values. Each
// field is counted over the rows matching every OTHER set field (cascading).
// match(row, key, value) decides a match (default: get(row) equals / includes).
export function useLocalFacets(rows, fields, values, match) {
  return useMemo(() => {
    const list = Array.isArray(rows) ? rows : [];
    const has = (f, r, v) => {
      if (match) { const m = match(r, f.key, v); if (m !== undefined) return m; }
      const got = f.get(r);
      return (Array.isArray(got) ? got : [got]).some((x) => String(x ?? '') === String(v));
    };
    const active = fields.filter((f) => values[f.key] !== '' && values[f.key] !== undefined && values[f.key] !== null);
    const out = {};
    fields.forEach((f) => {
      const others = active.filter((a) => a.key !== f.key);
      const counts = new Map();
      const labels = new Map();
      list.forEach((r) => {
        if (!others.every((a) => has(a, r, values[a.key]))) return;
        const got = f.get(r);
        (Array.isArray(got) ? got : [got]).forEach((v) => {
          if (v === null || v === undefined || v === '' || v === '—') return;
          counts.set(String(v), (counts.get(String(v)) || 0) + 1);
          if (f.label && !labels.has(String(v))) labels.set(String(v), f.label(v, r));
        });
      });
      out[f.key] = [...counts.entries()]
        .map(([value, count]) => ({ value, label: labels.get(value) || value, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    });
    return out;
  }, [rows, fields, values, match]);
}
