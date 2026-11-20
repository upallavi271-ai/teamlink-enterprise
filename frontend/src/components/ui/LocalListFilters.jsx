import { useMemo, useState } from 'react';
import MultiSelect, { csvToList } from '../ats/MultiSelect.jsx';
import { DateRangeFilter } from '../ats/FilterBar.jsx';
import { istDayOf } from '../../utils/dateRanges.js';

// ---------------------------------------------------------------------------
// THE FILTERS OF A LIST THE PAGE ALREADY HOLDS WHOLE (founder 2026-11-20: "every place, every list must have filters"):
// a search box, checkbox dropdowns (several values at once, counted over the rows every OTHER filter lets through, a ticked
// value stays offered at 0) and a From / To over the list's own date (IST days, both ends included).
//
//   const lf = useLocalListFilters(rows, {
//     search: (r) => [r.name, r.code],                       // the text the search box looks in
//     fields: [{ key: 'dept', label: 'Department', get: (r) => r.department, labelOf: (v) => v }],
//     date: { label: 'Joined on', get: (r) => r.joinedOn },  // optional
//   });
//   {lf.bar}   ... lf.rows ...   lf.on (any filter set)   lf.clear()
//
// The rows are what the server already sent for this login (inside its scope), so a TL / recruiter is only ever offered
// values of their own rows. A field with fewer than two values (and nothing ticked) is not drawn.
// ---------------------------------------------------------------------------
const text = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
const NONE = '—';
const dayOf = (v) => (!v ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : istDayOf(v));

export function useLocalListFilters(rows, { search, fields = [], date = null, placeholder = 'Search…', minValues = 2 } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState({});
  const [days, setDays] = useState({ from: '', to: '' });
  const t = q.trim().toLowerCase();
  const textOk = (r) => !t || (search ? search(r) : Object.values(r)).some((v) => (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(t));
  const dayOk = (r) => {
    if (!date || (!days.from && !days.to)) return true;
    const d = dayOf(date.get(r));
    return !!d && (!days.from || d >= days.from) && (!days.to || d <= days.to);
  };
  const valOf = (f, r) => {
    const v = f.get(r);
    return (Array.isArray(v) ? v : [v]).map((x) => text(x) || NONE);
  };
  const ok = (r, skip) => fields.every((f) => f.key === skip || !picked[f.key] || valOf(f, r).some((v) => csvToList(picked[f.key]).includes(v)));
  const base = useMemo(() => all.filter((r) => textOk(r) && dayOk(r)), [all, t, days.from, days.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => base.filter((r) => ok(r, null)), [base, picked]); // eslint-disable-line react-hooks/exhaustive-deps
  const facets = useMemo(() => fields.map((f) => {
    const m = new Map();
    base.forEach((r) => { if (!ok(r, f.key)) return; valOf(f, r).forEach((v) => m.set(v, (m.get(v) || 0) + 1)); });
    csvToList(picked[f.key]).forEach((v) => { if (!m.has(v)) m.set(v, 0); });
    const options = [...m.entries()]
      .map(([value, count]) => ({ value, count, label: value === NONE ? (f.noneLabel || 'Not given') : (f.labelOf ? f.labelOf(value) : value) }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
    return { ...f, options };
  }).filter((f) => f.options.length >= minValues || picked[f.key]), [base, picked, fields.map((f) => f.key).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = !!(t || days.from || days.to || Object.values(picked).some(Boolean));
  const clear = () => { setQ(''); setPicked({}); setDays({ from: '', to: '' }); };
  const bar = (
    <div className="llf-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '6px 0' }} role="search">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder.replace(/…$/, '')} style={{ minWidth: 180, maxWidth: 280 }} />
      {facets.map((f) => <MultiSelect key={f.key} label={f.label} allLabel={f.allLabel || 'All'} value={picked[f.key] || ''} onChange={(v) => setPicked((p) => ({ ...p, [f.key]: v }))} options={f.options} />)}
      {date && <DateRangeFilter label={date.label} from={days.from} to={days.to} onChange={setDays} />}
      {on && <button type="button" className="link-btn" onClick={clear}>Clear filters</button>}
      {on && <span className="small-muted">{`${shown.length.toLocaleString('en-IN')} of ${all.length.toLocaleString('en-IN')}`}</span>}
    </div>
  );
  return {
    rows: shown, bar, on, clear, q, setQ, picked, days,
    // the same filters over another copy of the rows (a file built from a fresh, larger read)
    apply: (list) => (list || []).filter((r) => textOk(r) && dayOk(r) && ok(r, null)),
  };
}

export default useLocalListFilters;
