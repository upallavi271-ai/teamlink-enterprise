import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MultiFacetSelect from '../ui/MultiFacetSelect.jsx';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import FilterChips from '../FilterChips.jsx';
import './FilterBar.css';

// ---------------------------------------------------------------------------
// THE ONE FILTER BAR FOR EVERY ATS LIST (founder 2026-11-18: "every list in the ATS should have its filters").
//
// Driven by a per-screen CONFIG (an array of fields); the screen keeps its own list and API call. The bar draws
//   - the most used filters on the row (primary: true), the rest under "More filters (n)" (a drawer on a phone),
//   - active filters as chips with a cross, and "Clear all",
//   - the number of results,
//   - an optional slot for the screen's Saved filters.
// The values are a flat object of the SAME parameter names the list's API takes, kept in the address bar by
// useUrlFilters() below, so a filtered list can be shared and survives opening a record and pressing Back.
//
// FIELD  { id, label, type, primary?, show?, facet?, options?, keys, unit?, step?, placeholder?, allLabel?, plural? }
//   type 'multi'      keys: { value }                      tick several options, counts from facets[facet || value]
//   type 'select'     keys: { value }                      one option with counts
//   type 'range'      keys: { min, max }                   two numbers (unit shown), optional `buckets` facet key: { bucket }
//   type 'daterange'  keys: { from, to }                   two dates
//   type 'yesno'      keys: { value }                      Any / Yes / No (yesLabel, noLabel)
//   type 'text'       keys: { value }                      free text
//   type 'multimode'  keys: { value, mode }                a multi with an Any / All switch (skills)
//   `show: false` hides the field (a role that may not use it); `options` = static [{ value, label, count? }].
// ---------------------------------------------------------------------------
const csvOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const dmy = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : s);

export const PERIODS = [['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['custom', 'Custom dates']];

/** every parameter name a config uses (so the bar can clear exactly its own) */
export function keysOfConfig(config) {
  const out = [];
  (config || []).forEach((f) => { Object.values(f.keys || {}).forEach((k) => { if (k && !out.includes(k)) out.push(k); }); });
  return out;
}

/**
 * The values of a bar, kept in the address bar. `keys` = the parameter names; `onWrite` runs just before the address changes
 * (a page that re-reads its own address uses it to ignore this write).
 */
export function useUrlFilters(keys, { onWrite } = {}) {
  const [sp, setSp] = useSearchParams();
  const read = (params) => { const v = {}; keys.forEach((k) => { const x = params.get(k); if (x) v[k] = x; }); return v; };
  const [values, setValuesRaw] = useState(() => read(sp));
  const sig = JSON.stringify(values);
  useEffect(() => {
    const now = JSON.stringify(read(sp));
    if (now === sig) return;
    const next = new URLSearchParams(sp);
    keys.forEach((k) => next.delete(k));
    Object.entries(values).forEach(([k, v]) => { if (v) next.set(k, v); });
    if (onWrite) onWrite();
    setSp(next, { replace: true });
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => setValuesRaw((cur) => {
    const n = { ...cur, ...patch };
    Object.keys(n).forEach((k) => { if (n[k] === '' || n[k] === undefined || n[k] === null) delete n[k]; });
    return n;
  });
  const replace = (all) => setValuesRaw(() => { const n = {}; Object.entries(all || {}).forEach(([k, v]) => { if (v && keys.includes(k)) n[k] = String(v); }); return n; });
  const clear = () => setValuesRaw({});
  return { values, set, replace, clear, sig };
}

function Range({ f, values, onChange, facets, loading }) {
  const [kMin, kMax] = [f.keys.min, f.keys.max];
  return (
    <>
      <span className="lph-facet fbar-range" title={f.title || f.label}>
        <span className="lph-facet-lbl">{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
        <span className="lph-pair">
          <input type="number" min="0" step={f.step || 1} placeholder="Min" aria-label={`${f.label} minimum`} value={values[kMin] || ''} onChange={(e) => onChange({ [kMin]: e.target.value })} />
          <input type="number" min="0" step={f.step || 1} placeholder="Max" aria-label={`${f.label} maximum`} value={values[kMax] || ''} onChange={(e) => onChange({ [kMax]: e.target.value })} />
        </span>
      </span>
      {f.keys.bucket && (
        <MultiFacetSelect
          label={`${f.label} bands`}
          allLabel="Any"
          plural="bands"
          value={values[f.keys.bucket] || ''}
          onChange={(v) => onChange({ [f.keys.bucket]: v })}
          options={(facets[f.facet || f.keys.bucket] || []).map((o) => ({ ...o, label: o.label }))}
          loading={loading}
          title={`Quick bands with how many people are in each${f.unit ? ` (${f.unit})` : ''}`}
        />
      )}
    </>
  );
}

// A list of fixed words (no counts): tick several, or pick one.
function StaticMulti({ f, value, onChange }) {
  const [open, setOpen] = useState(false);
  const chosen = csvOf(value);
  const toggle = (v) => onChange((chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]).join(','));
  const summary = !chosen.length ? (f.allLabel || 'Any') : chosen.length <= 2 ? chosen.map((v) => (f.options.find((o) => o.value === v) || {}).label || v).join(', ') : `${chosen.length} ${f.plural || 'selected'}`;
  return (
    <div className="lph-facet mfs" title={f.title || f.label}>
      <span className="lph-facet-lbl">{f.label}</span>
      <button type="button" className={`mfs-btn${chosen.length ? ' is-set' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mfs-sum">{summary}</span><span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="mfs-pop" role="listbox" aria-multiselectable="true" aria-label={f.label}>
          {f.options.map((o) => (
            <label key={o.value} className={`mfs-item${chosen.includes(o.value) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} />
              <span className="mfs-name">{o.label}</span>
            </label>
          ))}
          <div className="mfs-foot">
            <button type="button" className="link-btn" disabled={!chosen.length} onClick={() => onChange('')}>Clear</button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Control({ f, values, onChange, facets, loading }) {
  const key = f.keys.value;
  const opts = f.options || facets[f.facet || key] || [];
  const fixed = !!f.options && f.options.every((o) => o.count === undefined);
  if (fixed && f.type === 'multi') return <StaticMulti f={f} value={values[key]} onChange={(v) => onChange({ [key]: v })} />;
  if (fixed && f.type === 'select') {
    return (
      <label className="lph-facet" title={f.title || f.label}>
        <span className="lph-facet-lbl">{f.label}</span>
        <select value={values[key] || ''} onChange={(e) => onChange({ [key]: e.target.value })}>
          <option value="">{f.allLabel || 'Any'}</option>
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  if (f.type === 'multi' || f.type === 'multimode') {
    return (
      <span className={f.type === 'multimode' ? 'fbar-multimode' : 'fbar-cell'}>
        <MultiFacetSelect label={f.label} allLabel={f.allLabel || 'Any'} plural={f.plural || ''} value={values[key] || ''} onChange={(v) => onChange({ [key]: v })} options={opts} loading={loading} title={f.title || f.label} />
        {f.type === 'multimode' && csvOf(values[key]).length > 1 && (
          <span className="fbar-mode" role="group" aria-label={`${f.label}: match any or all`}>
            {['any', 'all'].map((m) => (
              <button key={m} type="button" className={(values[f.keys.mode] || 'any') === m ? 'is-on' : ''} aria-pressed={(values[f.keys.mode] || 'any') === m} onClick={() => onChange({ [f.keys.mode]: m === 'any' ? '' : m })}>
                {m === 'any' ? 'Any of these' : 'All of these'}
              </button>
            ))}
          </span>
        )}
      </span>
    );
  }
  if (f.type === 'select') return <FacetSelect label={f.label} allLabel={f.allLabel || 'Any'} value={values[key] || ''} onChange={(v) => onChange({ [key]: v })} options={opts} loading={loading} title={f.title || f.label} />;
  if (f.type === 'range') return <Range f={f} values={values} onChange={onChange} facets={facets} loading={loading} />;
  if (f.type === 'period') {
    const k = f.keys;
    return (
      <span className="lph-facet fbar-period" title={f.title || f.label}>
        <span className="lph-facet-lbl">{f.label}</span>
        <span className="lph-pair">
          <select value={values[k.range] || ''} aria-label={f.label} onChange={(e) => onChange({ [k.range]: e.target.value, ...(e.target.value === 'custom' ? {} : { [k.from]: '', [k.to]: '' }) })}>
            <option value="">{f.allLabel || 'Now (no period)'}</option>
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {values[k.range] === 'custom' && (
            <>
              <input type="date" aria-label={`${f.label} from`} value={values[k.from] || ''} max={values[k.to] || undefined} onChange={(e) => onChange({ [k.from]: e.target.value })} />
              <input type="date" aria-label={`${f.label} to`} value={values[k.to] || ''} min={values[k.from] || undefined} onChange={(e) => onChange({ [k.to]: e.target.value })} />
            </>
          )}
        </span>
      </span>
    );
  }
  if (f.type === 'daterange') {
    return (
      <span className="lph-facet fbar-dates" title={f.title || f.label}>
        <span className="lph-facet-lbl">{f.label}</span>
        <span className="lph-pair">
          <input type="date" aria-label={`${f.label} from`} value={values[f.keys.from] || ''} max={values[f.keys.to] || undefined} onChange={(e) => onChange({ [f.keys.from]: e.target.value })} />
          <input type="date" aria-label={`${f.label} to`} value={values[f.keys.to] || ''} min={values[f.keys.from] || undefined} onChange={(e) => onChange({ [f.keys.to]: e.target.value })} />
        </span>
      </span>
    );
  }
  if (f.type === 'yesno') {
    return (
      <label className="lph-facet" title={f.title || f.label}>
        <span className="lph-facet-lbl">{f.label}</span>
        <select value={values[key] || ''} onChange={(e) => onChange({ [key]: e.target.value })}>
          <option value="">{f.allLabel || 'Either'}</option>
          <option value="yes">{f.yesLabel || 'Yes'}</option>
          <option value="no">{f.noLabel || 'No'}</option>
        </select>
      </label>
    );
  }
  return (
    <label className="lph-facet" title={f.title || f.label}>
      <span className="lph-facet-lbl">{f.label}</span>
      <input type="text" placeholder={f.placeholder || ''} value={values[key] || ''} onChange={(e) => onChange({ [key]: e.target.value })} />
    </label>
  );
}

/** the chips of a config for the values now set */
export function chipsOf(config, values, facets, onChange, skip = []) {
  const out = [];
  const label = (f, v) => {
    const o = (f.options || facets[f.facet || f.keys.value] || []).find((x) => String(x.value).toLowerCase() === String(v).toLowerCase());
    return o ? o.label : v;
  };
  (config || []).filter((f) => f.show !== false && !skip.includes(f.id)).forEach((f) => {
    if (f.type === 'range') {
      const a = values[f.keys.min]; const b = values[f.keys.max];
      const u = f.unit ? ` ${f.unit}` : '';
      if (a || b) out.push({ key: f.id, label: f.label, value: a && b ? `${a}–${b}${u}` : a ? `from ${a}${u}` : `up to ${b}${u}`, onRemove: () => onChange({ [f.keys.min]: '', [f.keys.max]: '' }) });
      if (f.keys.bucket && values[f.keys.bucket]) {
        out.push({ key: `${f.id}-b`, label: `${f.label} band`, value: csvOf(values[f.keys.bucket]).map((v) => label({ ...f, keys: { value: f.keys.bucket }, facet: f.facet || f.keys.bucket }, v)).join(', '), onRemove: () => onChange({ [f.keys.bucket]: '' }) });
      }
    } else if (f.type === 'period') {
      const v = values[f.keys.range];
      if (v) out.push({ key: f.id, label: f.label, value: v === 'custom' ? `${dmy(values[f.keys.from]) || '…'} to ${dmy(values[f.keys.to]) || '…'}` : (PERIODS.find(([x]) => x === v) || [])[1] || v, onRemove: () => onChange({ [f.keys.range]: '', [f.keys.from]: '', [f.keys.to]: '' }) });
    } else if (f.type === 'daterange') {
      const a = values[f.keys.from]; const b = values[f.keys.to];
      if (a || b) out.push({ key: f.id, label: f.label, value: a && b ? `${dmy(a)} to ${dmy(b)}` : a ? `from ${dmy(a)}` : `to ${dmy(b)}`, onRemove: () => onChange({ [f.keys.from]: '', [f.keys.to]: '' }) });
    } else if (f.type === 'yesno') {
      const v = values[f.keys.value];
      if (v) out.push({ key: f.id, label: f.label, value: v === 'yes' ? (f.yesLabel || 'Yes') : (f.noLabel || 'No'), onRemove: () => onChange({ [f.keys.value]: '' }) });
    } else {
      const v = values[f.keys.value];
      if (!v) return;
      const shown = f.type === 'text' ? v : csvOf(v).map((x) => label(f, x)).join(', ');
      const mode = f.type === 'multimode' && csvOf(v).length > 1 && values[f.keys.mode] === 'all' ? ' (all)' : '';
      out.push({ key: f.id, label: f.label, value: `${shown}${mode}`, onRemove: () => onChange({ [f.keys.value]: '', ...(f.keys.mode ? { [f.keys.mode]: '' } : {}) }) });
    }
  });
  return out;
}

/** How many of the config's fields are on (for the "More filters (n)" badge). */
function activeIn(fields, values) {
  return fields.filter((f) => Object.values(f.keys || {}).some((k) => k && values[k])).length;
}

export default function FilterBar({
  config, values, onChange, facets = {}, loading = false, total = null, noun = 'results', onClear, saved = null, extraChips = [], lead = null, className = '', storageKey = '', chipSkip = [], canClear, allTime = false,
}) {
  const fields = useMemo(() => (config || []).filter((f) => f.show !== false), [config]);
  const primary = fields.filter((f) => f.primary);
  const more = fields.filter((f) => !f.primary);
  const [open, setOpen] = useState(() => { try { return !!storageKey && window.localStorage.getItem(`tl.fbar.${storageKey}`) === '1'; } catch { return false; } });
  const toggle = () => setOpen((o) => { const n = !o; try { if (storageKey) window.localStorage.setItem(`tl.fbar.${storageKey}`, n ? '1' : '0'); } catch { /* not remembered */ } return n; });
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  const chips = [...chipsOf(config, values, facets, onChange, chipSkip), ...extraChips];
  const showClear = !!onClear && (canClear !== undefined ? canClear : chips.length > 0);
  const moreN = activeIn(more, values);
  const nf = (n) => Number(n).toLocaleString('en-IN');
  return (
    <div className={`fbar ${className}`}>
      <div className="fbar-row">
        {lead}
        {primary.map((f) => <Control key={f.id} f={f} values={values} onChange={onChange} facets={facets} loading={loading} />)}
        {more.length > 0 && (
          <button type="button" className={`mf-toggle fbar-more${open ? ' on' : ''}`} onClick={toggle} aria-expanded={open}>
            More filters{moreN ? ` (${moreN})` : ''} {open ? '▴' : '▾'}
          </button>
        )}
        {showClear && <button type="button" className="mf-clear" onClick={onClear}>Clear all</button>}
        {saved}
        {total !== null && total !== undefined && <span className="small-muted fbar-count" role="status">{`${nf(total)} ${noun}`}{allTime ? ' · Showing all time' : ''}</span>}
      </div>
      {open && more.length > 0 && (
        <>
          <div className="fbar-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="fbar-panel" role="dialog" aria-label="More filters">
            <div className="fbar-panel-head">
              <b>More filters</b>
              <span>
                {showClear && <button type="button" className="link-btn" onClick={onClear}>Clear all</button>}
                <button type="button" className="btn btn-sm fbar-close" onClick={() => setOpen(false)}>{`Show ${total !== null && total !== undefined ? nf(total) : ''} ${noun}`.replace(/\s+/g, ' ')}</button>
              </span>
            </div>
            <div className="fbar-panel-body">
              {more.map((f) => <Control key={f.id} f={f} values={values} onChange={onChange} facets={facets} loading={loading} />)}
            </div>
          </div>
        </>
      )}
      <FilterChips filters={chips} onClearAll={showClear ? onClear : undefined} label="Filters:" />
    </div>
  );
}
