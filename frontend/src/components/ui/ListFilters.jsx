import { useEffect, useMemo, useState } from 'react';
import Combo from '../Combo.jsx';
import MoreFilters from './MoreFilters.jsx';
import FilterChips from '../FilterChips.jsx';
import EmptyState from './EmptyState.jsx';
import './ui.css';
import './ListFilters.css';

// ---------------------------------------------------------------------------
// THE LIST FILTER STANDARD IN ONE PLACE (user notes #1 / #11, review #3 §14,
// §21, §22) — "every module, every tab has filters; easy for every employee".
//
// Built ON the shared pieces (MoreFilters, FilterChips, EmptyState, Combo), not
// instead of them: this only saves every list from re-writing the same state,
// option lists, chips and matching.
//
//   const lf = useListFilters(rows, [
//     { key: 'q', type: 'search', placeholder: 'Search title or employee…',
//       get: (r) => `${r.title} ${r.employee?.name}` },
//     { key: 'status', label: 'Status', get: (r) => r.status, primary: true },
//     { key: 'department', label: 'Department', get: (r) => r.employee?.department,
//       primary: true, show: seesOthers },                  // role-aware
//     { key: 'date', type: 'daterange', label: 'Date range', get: (r) => r.createdAt },
//     { key: 'category', label: 'Category', get: (r) => r.category },  // More Filters
//   ], {
//     sorts: [
//       { key: 'new', label: 'Newest first', cmp: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) },
//       { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name).localeCompare(String(b.name)) },
//     ],
//   });
//   <ListFilterBar lf={lf} storageKey="helpdesk" />
//   const page = usePaged(lf.rows);              // components/Pager.jsx
//   … page.slice.map(…) …
//   {lf.rows.length === 0 && <tr><td colSpan={9}><ListEmpty lf={lf} noun="tickets" /></td></tr>}
//   <Pager page={page} noun="tickets" />
//
// FIELD
//   key        state key ('q' for the search box by convention)
//   type       'search' (always visible, first) | 'select' (default) |
//              'text' (contains) | 'daterange' (From / To, ISO dates)
//   label      the plain word shown on the control and the chip ("Status",
//              "Department", "Date range", "Type", "Owner")
//   get(row)   the row's value — a string, a number, an array (matches any
//              element) or, for daterange, a date / ISO string
//   options    optional [value] or [{ value, label }]; omitted -> the distinct
//              values actually present in `rows` (sorted)
//   allLabel   the "no filter" option ("All statuses"); default "All <label>"
//   primary    true -> always on screen; otherwise under "More Filters ▾"
//   show       false -> not offered (role-aware: no Department filter for a
//              login that sees only its own records)
//   match(row, value)  optional custom predicate (overrides get)
//
// OPTIONS
//   server     true -> rows are NOT filtered here (the page sends lf.params to
//              the API); the search value is debounced in lf.params.
//   initial    starting values, e.g. seeded from the URL
//   sorts / defaultSort   Sort dropdown (first sort is the default)
// ---------------------------------------------------------------------------

const EMPTY = (v) => v === '' || v === null || v === undefined;
const iso = (v) => {
  if (!v) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
const norm = (o) => (o && typeof o === 'object' ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: String(o) });

function keysOf(fields) {
  const out = [];
  fields.forEach((f) => {
    if (f.type === 'daterange') out.push(`${f.key}From`, `${f.key}To`);
    else out.push(f.key);
  });
  return out;
}

export function useListFilters(rows, fieldsIn, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const fields = (fieldsIn || []).filter((f) => f && f.show !== false);
  const blank = useMemo(() => Object.fromEntries(keysOf(fieldsIn || []).map((k) => [k, ''])), [fieldsIn && fieldsIn.map((f) => f && f.key).join('|')]);
  const [values, setValues] = useState(() => ({ ...blank, ...(opts.initial || {}) }));
  const sorts = opts.sorts || [];
  const [sort, setSort] = useState(opts.defaultSort || (sorts[0] && sorts[0].key) || '');

  // Debounced copy of the values for server-side lists (typing in the search
  // box must not fire a request per keystroke).
  const [debounced, setDebounced] = useState(values);
  useEffect(() => {
    if (!opts.server) return undefined;
    const t = setTimeout(() => setDebounced(values), 300);
    return () => clearTimeout(t);
  }, [values, opts.server]);

  const setValue = (key, v) => setValues((cur) => ({ ...cur, [key]: v }));
  const clear = () => setValues({ ...blank });

  // Options: given, or the distinct values present in the rows.
  const resolved = useMemo(() => fields.map((f) => {
    if (f.type === 'search' || f.type === 'text' || f.type === 'daterange') return f;
    let options;
    if (f.options) options = f.options.map(norm);
    else {
      const seen = new Set();
      list.forEach((r) => {
        const v = f.get ? f.get(r) : r[f.key];
        (Array.isArray(v) ? v : [v]).forEach((x) => { if (!EMPTY(x) && x !== '—') seen.add(String(x)); });
      });
      options = [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(norm);
    }
    return { ...f, options };
  }), [fields, list]);

  const filtered = useMemo(() => {
    if (opts.server) return list;
    const active = resolved.filter((f) => (f.type === 'daterange'
      ? (values[`${f.key}From`] || values[`${f.key}To`]) : !EMPTY(values[f.key])));
    if (!active.length) return list;
    return list.filter((r) => active.every((f) => {
      if (f.type === 'daterange') {
        const d = iso(f.get ? f.get(r) : r[f.key]);
        const from = values[`${f.key}From`]; const to = values[`${f.key}To`];
        if (!d) return false;
        return (!from || d >= from) && (!to || d <= to);
      }
      const want = values[f.key];
      if (f.match) return f.match(r, want);
      const v = f.get ? f.get(r) : r[f.key];
      if (f.type === 'search' || f.type === 'text') {
        const q = String(want).trim().toLowerCase();
        return String((Array.isArray(v) ? v.join(' ') : v) ?? '').toLowerCase().includes(q);
      }
      return (Array.isArray(v) ? v : [v]).some((x) => String(x ?? '') === String(want));
    }));
  }, [list, resolved, values, opts.server]);

  const sorted = useMemo(() => {
    const s = sorts.find((x) => x.key === sort);
    if (!s || !s.cmp) return filtered;
    return [...filtered].sort(s.cmp);
  }, [filtered, sort, sorts]);

  const isOn = (f) => (f.type === 'daterange' ? !!(values[`${f.key}From`] || values[`${f.key}To`]) : !EMPTY(values[f.key]));
  const activeCount = resolved.filter(isOn).length;
  const moreActive = resolved.filter((f) => f.type !== 'search' && !f.primary && isOn(f)).length;

  const chips = resolved.filter(isOn).map((f) => {
    if (f.type === 'daterange') {
      const from = values[`${f.key}From`]; const to = values[`${f.key}To`];
      return {
        key: f.key, label: f.label || 'Date range',
        value: from && to ? `${dmy(from)} → ${dmy(to)}` : from ? `from ${dmy(from)}` : `to ${dmy(to)}`,
        onRemove: () => setValues((cur) => ({ ...cur, [`${f.key}From`]: '', [`${f.key}To`]: '' })),
      };
    }
    const v = values[f.key];
    const opt = (f.options || []).find((o) => o.value === String(v));
    return {
      key: f.key,
      label: f.type === 'search' ? 'Search' : (f.label || f.key),
      value: opt ? opt.label : v,
      onRemove: () => setValue(f.key, ''),
    };
  });

  // Query parameters for a server-side list: only the set ones.
  const src = opts.server ? debounced : values;
  const params = {};
  resolved.forEach((f) => {
    if (f.type === 'daterange') {
      if (src[`${f.key}From`]) params[f.param ? `${f.param}From` : `${f.key}From`] = src[`${f.key}From`];
      if (src[`${f.key}To`]) params[f.param ? `${f.param}To` : `${f.key}To`] = src[`${f.key}To`];
    } else if (!EMPTY(src[f.key])) params[f.param || f.key] = src[f.key];
  });

  return {
    values, setValue, setValues, clear, fields: resolved,
    rows: sorted, filtered: sorted, total: list.length,
    activeCount, moreActive, chips, params, paramsKey: JSON.stringify(params),
    sorts, sort, setSort,
  };
}

// "Status" -> "statuses", "Category" -> "categories", "Type" -> "types",
// "Payment mode" -> "payment modes"; only the last word changes.
function pluralOf(label) {
  if (/^[A-Z]{2,4}$/.test(String(label || ''))) return `${label}s`; // TL -> TLs, BDE -> BDEs
  const s = String(label || '').toLowerCase();
  if (!s) return '';
  if (s === 'who') return 'people';
  if (/(us|ss|x|ch|sh)$/.test(s)) return `${s}es`;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/s$/.test(s)) return s;
  return `${s}s`;
}

function Control({ f, lf }) {
  const v = lf.values;
  if (f.type === 'search') {
    return (
      <input
        type="search"
        placeholder={f.placeholder || 'Search…'}
        value={v[f.key] || ''}
        onChange={(e) => lf.setValue(f.key, e.target.value)}
        style={{ minWidth: f.minWidth || 220 }}
        aria-label={f.label || 'Search'}
      />
    );
  }
  if (f.type === 'text') {
    return (
      <input
        placeholder={f.placeholder || f.label}
        value={v[f.key] || ''}
        onChange={(e) => lf.setValue(f.key, e.target.value)}
        aria-label={f.label}
        title={f.label}
      />
    );
  }
  if (f.type === 'daterange') {
    const k1 = `${f.key}From`; const k2 = `${f.key}To`;
    return (
      <span className="lf-dates" title={f.label || 'Date range'}>
        <span className="lf-dates-lbl">{f.label || 'Date range'}</span>
        <input type="date" value={v[k1] || ''} max={v[k2] || undefined} onChange={(e) => lf.setValue(k1, e.target.value)} aria-label={`${f.label || 'Date range'} from`} />
        <span aria-hidden="true">→</span>
        <input type="date" value={v[k2] || ''} min={v[k1] || undefined} onChange={(e) => lf.setValue(k2, e.target.value)} aria-label={`${f.label || 'Date range'} to`} />
      </span>
    );
  }
  const all = f.allLabel || `All ${pluralOf(f.label)}`;
  return (
    <Combo value={v[f.key] || ''} title={f.label} onChange={(e) => lf.setValue(f.key, e.target.value)}>
      <option value="">{all}</option>
      {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Combo>
  );
}

// The bar: Search + primary filters | More Filters ▾ | Clear All | Sort, then
// the active filters as chips and "N of M".
export default function ListFilterBar({ lf, storageKey, extra, noun, className = '', children }) {
  const primary = lf.fields.filter((f) => f.type === 'search' || f.primary);
  const more = lf.fields.filter((f) => f.type !== 'search' && !f.primary);
  const sortCtl = lf.sorts && lf.sorts.length > 1 ? (
    <label className="lf-sort">
      Sort
      <select value={lf.sort} onChange={(e) => lf.setSort(e.target.value)}>
        {lf.sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </label>
  ) : null;
  return (
    <div className={`lf ${className}`}>
      <MoreFilters
        storageKey={storageKey}
        activeMore={lf.moreActive}
        onClearAll={lf.activeCount ? lf.clear : undefined}
        primary={<>{primary.map((f) => <Control key={f.key} f={f} lf={lf} />)}{children}</>}
        extra={(
          <>
            {sortCtl}
            {/* Never a bare zero: no count line when the list is empty. */}
            {noun && lf.total > 0 && (
              <span className="small-muted lf-count">
                {lf.activeCount ? `${lf.rows.length.toLocaleString('en-IN')} of ${lf.total.toLocaleString('en-IN')} ${noun}` : `${lf.total.toLocaleString('en-IN')} ${noun}`}
              </span>
            )}
            {extra}
          </>
        )}
      >
        {more.length ? more.map((f) => <Control key={f.key} f={f} lf={lf} />) : null}
      </MoreFilters>
      <FilterChips filters={lf.chips} onClearAll={lf.activeCount ? lf.clear : undefined} />
    </div>
  );
}

// "No X match these filters — Clear filters" / "No X yet."
export function ListEmpty({ lf, noun = 'records', title, hint, icon, compact = true }) {
  if (lf && lf.activeCount) {
    return (
      <EmptyState
        compact={compact}
        icon={icon || '🔍'}
        title={`No ${noun} match these filters.`}
        hint="Clear the filters to see everything."
        action={<button type="button" className="btn btn-sm" onClick={lf.clear}>Clear filters</button>}
      />
    );
  }
  return <EmptyState compact={compact} icon={icon} title={title || `No ${noun} yet.`} hint={hint} />;
}
