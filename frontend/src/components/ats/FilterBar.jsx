import { t as tr } from '../../i18n.jsx'; // Telugu / Hindi when chosen (ATS wave 2 Z, 13.06)
import { isValidElement, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MultiSelect from './MultiSelect.jsx';
import FilterChips from '../FilterChips.jsx';
import { PRESETS, presetDates, matchPreset, dateProblem } from '../../utils/dateRanges.js';
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

// ONE LOOK FOR EVERY FILTER (founder 2026-11-27: "this page looks very clumsy, a new person will not understand it"): every control is one
// box of the same height with its name inside it, like the pick lists ("Education: All"). FBox is that box for a number pair, a date
// pick, a yes / no or a typed word.
export function FBox({ label, title, className = '', children }) {
  return (
    <span className={`fbar-box ${className}`} title={title || label}>
      <span className="fbar-box-l">{label}</span>
      {children}
    </span>
  );
}

function Bands({ f, values, onChange, facets, loading }) {
  return (
    <MultiSelect
      label={`${f.label} bands`}
      allLabel="Any"
      plural="bands"
      value={values[f.keys.bucket] || ''}
      onChange={(v) => onChange({ [f.keys.bucket]: v })}
      options={(facets[f.facet || f.keys.bucket] || []).map((o) => ({ ...o, label: o.label }))}
      loading={loading}
      title={`Quick bands with how many people are in each${f.unit ? ` (${f.unit})` : ''}`}
    />
  );
}

function Range({ f, values, onChange, facets, loading, bands = true }) {
  const [kMin, kMax] = [f.keys.min, f.keys.max];
  return (
    <>
      <FBox label={`${tr(f.label)}${f.unit ? ` (${f.unitShort || f.unit})` : ''}`} title={f.title || `${f.label}${f.unit ? ` (${f.unit})` : ''}`} className="fbar-range">
        <input type="number" min="0" step={f.step || 1} placeholder="Min" aria-label={`${f.label} minimum`} value={values[kMin] || ''} onChange={(e) => onChange({ [kMin]: e.target.value })} />
        <span className="fbar-dash" aria-hidden="true">–</span>
        <input type="number" min="0" step={f.step || 1} placeholder="Max" aria-label={`${f.label} maximum`} value={values[kMax] || ''} onChange={(e) => onChange({ [kMax]: e.target.value })} />
      </FBox>
      {bands && f.keys.bucket && (
        <MultiSelect
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

// A date range: the quick picks (Today, Yesterday, This week ... the same list on every screen, IST days) and the two dates.
// A quick pick fills both dates (so the address bar and the server only ever see From and To); typing a date makes it Custom.
// (2026-11-27) the two date boxes show only for "Custom dates", so a date filter is one tidy box like the others.
function DateRangeField({ f, values, onChange }) {
  const from = values[f.keys.from] || '';
  const to = values[f.keys.to] || '';
  const picked = matchPreset(from, to);
  const problem = dateProblem(from, to);
  const [custom, setCustom] = useState(false);
  const showDates = custom || picked === 'custom';
  const pick = (k) => {
    if (k === 'custom') { setCustom(true); return undefined; }
    setCustom(false);
    if (!k) return onChange({ [f.keys.from]: '', [f.keys.to]: '' });
    const d = presetDates(k);
    return onChange({ [f.keys.from]: d.from || '', [f.keys.to]: d.to || '' });
  };
  return (
    <span className={`fbar-datewrap${showDates ? ' is-custom' : ''}`}>
      <FBox label={tr(f.label)} title={f.title || f.label} className="fbar-dates">
        <select aria-label={`${f.label}: when`} value={showDates ? 'custom' : picked} onChange={(e) => pick(e.target.value)}>
          {PRESETS.map(([k, l]) => <option key={k} value={k}>{k === '' ? 'Any time' : k === 'custom' ? 'Custom dates…' : l}</option>)}
        </select>
      </FBox>
      {showDates && (
        <span className="fbar-box fbar-dates2">
          <input type="date" aria-label={`${f.label} from`} value={from} max={to || undefined} onChange={(e) => onChange({ [f.keys.from]: e.target.value })} />
          <span className="fbar-dash">to</span>
          <input type="date" aria-label={`${f.label} to`} value={to} min={from || undefined} onChange={(e) => onChange({ [f.keys.to]: e.target.value })} />
        </span>
      )}
      {problem && <span className="small-muted" role="alert" style={{ color: 'var(--danger, #b42318)' }}>{problem}</span>}
    </span>
  );
}

// The same From / To box with the quick picks, for a screen that keeps its own state (not the address bar):
//   <DateRangeFilter label="Last updated" from={f} to={t} onChange={({ from, to }) => ...} />
export function DateRangeFilter({ label, from = '', to = '', onChange, title }) {
  const f = { label, title, keys: { from: 'from', to: 'to' } };
  return <DateRangeField f={f} values={{ from, to }} onChange={(p) => onChange({ from: 'from' in p ? p.from : from, to: 'to' in p ? p.to : to })} />;
}

function Control({
  f, values, onChange, facets, loading, openToken = 0, bands = true,
}) {
  const key = f.keys.value;
  const opts = f.options || facets[f.facet || key] || [];
  if (f.type === 'multi' || f.type === 'select' || f.type === 'multimode') {
    return (
      <span className={f.type === 'multimode' ? 'fbar-multimode' : 'fbar-cell'}>
        <MultiSelect openToken={openToken} label={tr(f.label)} allLabel={tr(f.allLabel || 'Any')} plural={f.plural || ''} value={values[key] || ''} onChange={(v) => onChange({ [key]: v })} options={opts} loading={loading} title={f.title || f.label} />
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
  if (f.type === 'range') return <Range f={f} values={values} onChange={onChange} facets={facets} loading={loading} bands={bands} />;
  if (f.type === 'period') {
    const k = f.keys;
    return (
      <span className="lph-facet fbar-period" title={f.title || f.label}>
        <span className="lph-facet-lbl">{tr(f.label)}</span>
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
  if (f.type === 'daterange') return <DateRangeField f={f} values={values} onChange={onChange} />;
  if (f.type === 'yesno') {
    return (
      <FBox label={tr(f.label)} title={f.title || f.label}>
        <select aria-label={f.label} value={values[key] || ''} onChange={(e) => onChange({ [key]: e.target.value })}>
          <option value="">{f.allLabel || 'Either'}</option>
          <option value="yes">{f.yesLabel || 'Yes'}</option>
          <option value="no">{f.noLabel || 'No'}</option>
        </select>
      </FBox>
    );
  }
  return (
    <FBox label={tr(f.label)} title={f.title || f.label}>
      <input type="text" aria-label={f.label} placeholder={f.placeholder || ''} value={values[key] || ''} onChange={(e) => onChange({ [key]: e.target.value })} />
    </FBox>
  );
}

/** the chips of a config for the values now set */
const namesText = (names) => (names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`);
export function chipsOf(config, values, facets, onChange, skip = [], onOpenField = null) {
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
      const shown = f.type === 'text' ? v : namesText(csvOf(v).map((x) => label(f, x)));
      const mode = f.type === 'multimode' && csvOf(v).length > 1 && values[f.keys.mode] === 'all' ? ' (all)' : '';
      out.push({ key: f.id, label: f.label, value: `${shown}${mode}`, onOpen: f.type !== 'text' && onOpenField ? () => onOpenField(f.id) : undefined, onRemove: () => onChange({ [f.keys.value]: '', ...(f.keys.mode ? { [f.keys.mode]: '' } : {}) }) });
    }
  });
  return out;
}

/** How many of the config's fields are on (for the "More filters (n)" badge). */
function activeIn(fields, values) {
  return fields.filter((f) => Object.values(f.keys || {}).some((k) => k && values[k])).length;
}

export default function FilterBar({
  config, values, onChange, facets = {}, loading = false, total = null, noun = 'results', onClear, saved = null, extraChips = [], lead = null, className = '', storageKey = '', chipSkip = [], canClear, allTime = false, moreExtra = null, moreExtraCount = 0,
  groups = null,
}) {
  // GROUPS (2026-11-27): [{ id, title, hint }] puts "More filters" in labelled parts on an even grid; a field says its part with `group`,
  // and moreExtra may then be { [groupId]: nodes } for the screen's own controls. Without groups the panel is one list, as before.
  const extraByGroup = !!moreExtra && typeof moreExtra === 'object' && !isValidElement(moreExtra) && !Array.isArray(moreExtra);
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
  const [openFor, setOpenFor] = useState({ id: '', n: 0 });
  const openField = (id) => { if (more.some((m) => m.id === id)) setOpen(true); setOpenFor((o) => ({ id, n: o.n + 1 })); };
  const chips = [...chipsOf(config, values, facets, onChange, chipSkip, openField), ...extraChips];
  const showClear = !!onClear && (canClear !== undefined ? canClear : chips.length > 0);
  const moreN = activeIn(more, values) + Number(moreExtraCount || 0);
  const hasMore = more.length > 0 || (extraByGroup ? Object.values(moreExtra).some(Boolean) : !!moreExtra);
  const grouped = Array.isArray(groups) && groups.length > 0;
  const groupList = grouped ? [...groups, ...(more.some((f) => !groups.some((g) => g.id === f.group)) ? [{ id: '__other', title: 'Other' }] : [])] : [];
  const inGroup = (g, f) => (g.id === '__other' ? !groups.some((x) => x.id === f.group) : f.group === g.id);
  const nf = (n) => Number(n).toLocaleString('en-IN');
  return (
    <div className={`fbar ${className}`}>
      <div className="fbar-row">
        {lead}
        {primary.map((f) => <Control key={f.id} f={f} values={values} onChange={onChange} facets={facets} loading={loading} openToken={openFor.id === f.id ? openFor.n : 0} bands={!grouped} />)}
        {hasMore && (
          <button type="button" className={`mf-toggle fbar-more${open ? ' on' : ''}`} onClick={toggle} aria-expanded={open}>
            {tr('More filters')}{moreN ? ` (${moreN})` : ''} {open ? '▴' : '▾'}
          </button>
        )}
        {/* the chips line below has its own Clear all: not twice (2026-11-27) */}
        {showClear && !chips.length && <button type="button" className="mf-clear" onClick={onClear}>{tr('Clear all')}</button>}
        {saved}
        {total !== null && total !== undefined && <span className="small-muted fbar-count" role="status">{`${nf(total)} ${noun}`}{allTime ? ' · Showing all time' : ''}</span>}
      </div>
      {open && hasMore && (
        <>
          <div className="fbar-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="fbar-panel" role="dialog" aria-label="More filters">
            <div className="fbar-panel-head">
              <b>{tr('More filters')}</b>
              <span>
                {showClear && <button type="button" className="link-btn" onClick={onClear}>{tr('Clear all')}</button>}
                <button type="button" className="btn btn-sm fbar-close" onClick={() => setOpen(false)}>{`Show ${total !== null && total !== undefined ? nf(total) : ''} ${noun}`.replace(/\s+/g, ' ')}</button>
              </span>
            </div>
            {grouped ? (
              <div className="fbar-groups">
                {groupList.map((g) => {
                  const fs = more.filter((f) => inGroup(g, f));
                  const bandsHere = primary.filter((f) => f.type === 'range' && f.keys.bucket && inGroup(g, f));
                  const extra = extraByGroup ? moreExtra[g.id] : null;
                  if (!fs.length && !bandsHere.length && !extra) return null;
                  return (
                    <section key={g.id} className="fbar-group" aria-label={g.title}>
                      <h4 className="fbar-group-h">{tr(g.title)}{g.hint && <span>{g.hint}</span>}</h4>
                      <div className="fbar-grid">
                        {bandsHere.map((f) => <Bands key={`b-${f.id}`} f={f} values={values} onChange={onChange} facets={facets} loading={loading} />)}
                        {fs.map((f) => <Control key={f.id} f={f} values={values} onChange={onChange} facets={facets} loading={loading} openToken={openFor.id === f.id ? openFor.n : 0} />)}
                        {extra}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="fbar-panel-body">
                {more.map((f) => <Control key={f.id} f={f} values={values} onChange={onChange} facets={facets} loading={loading} openToken={openFor.id === f.id ? openFor.n : 0} />)}
                {moreExtra}
              </div>
            )}
          </div>
        </>
      )}
      <FilterChips filters={chips} onClearAll={showClear ? onClear : undefined} label="Filters:" />
    </div>
  );
}
