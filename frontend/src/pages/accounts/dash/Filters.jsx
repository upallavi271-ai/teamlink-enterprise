import { useEffect, useState } from 'react';
import Combo from '../../../components/Combo.jsx';
import PeriodPicker, { ALL_TIME, isAllTime, periodText } from '../../../components/accounts/PeriodPicker.jsx';

// 1. GLOBAL FILTERS (Accounts spec S8.2) — the same set drives every section
// below. Options and counts come from the server (utils/accountsControl.js
// facets): each list is counted over the invoices matching every OTHER
// filter, so picking a Department narrows Section, Role and Employee (and
// Client) to it. A choice the list no longer offers is cleared.
export const PRESETS = ['all', 'today', 'thisWeek', 'thisMonth', 'thisQuarter', 'cfy', 'custom'];
export const BLANK = {
  period: ALL_TIME, client: '', dept: '', section: '', role: '', emp: '', q: '',
};
// A change to one level clears the levels under it (Department → Section →
// Role → Employee).
const BELOW = { dept: ['section', 'role', 'emp'], section: ['role', 'emp'], role: ['emp'] };

export default function Filters({
  value, onChange, facets, counts, loading,
}) {
  const [q, setQ] = useState(value.q);
  useEffect(() => { setQ(value.q); }, [value.q]);
  // The search box goes to the server a moment after typing stops.
  useEffect(() => {
    if (q === value.q) return undefined;
    const t = setTimeout(() => onChange({ ...value, q }), 350);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => {
    const next = { ...value, [k]: v || '' };
    (BELOW[k] || []).forEach((x) => { next[x] = ''; });
    onChange(next);
  };
  const f = facets || {};
  const opts = (k) => f[k] || [];
  const labelOf = (k, v) => (opts(k).find((o) => o.value === v) || {}).label || v;
  const pick = (k, label, allLabel, searchable) => {
    const list = opts(k);
    const cur = value[k];
    const shown = cur && !list.some((o) => o.value === cur) ? [{ value: cur, label: labelOf(k, cur), count: 0 }, ...list] : list;
    const options = [<option key="" value="">{allLabel}</option>, ...shown.map((o) => <option key={o.value} value={o.value}>{`${o.label} · ${o.count}`}</option>)];
    return (
      <label className="acd-f">
        <span>{label} · {list.length}</span>
        {searchable
          ? <Combo value={cur} onChange={(e) => set(k, e.target.value)}>{options}</Combo>
          : <select value={cur} onChange={(e) => set(k, e.target.value)}>{options}</select>}
      </label>
    );
  };

  const chips = [
    !isAllTime(value.period) && { k: 'period', l: 'Period', v: periodText(value.period), clear: () => onChange({ ...value, period: ALL_TIME }) },
    value.client && { k: 'client', l: 'Client', v: value.client, clear: () => set('client', '') },
    value.dept && { k: 'dept', l: 'Department', v: labelOf('dept', value.dept), clear: () => set('dept', '') },
    value.section && { k: 'section', l: 'Section', v: labelOf('section', value.section), clear: () => set('section', '') },
    value.role && { k: 'role', l: 'Role', v: value.role, clear: () => set('role', '') },
    value.emp && { k: 'emp', l: 'Employee', v: labelOf('emp', value.emp), clear: () => set('emp', '') },
    value.q && { k: 'q', l: 'Search', v: value.q, clear: () => { setQ(''); onChange({ ...value, q: '' }); } },
  ].filter(Boolean);

  return (
    <section className="acd-sec" id="filters" aria-label="Filters">
      <h2><span className="acd-n">1</span> Filters</h2>
      <p className="acd-q">Every number on this page follows these filters.</p>
      <div className="acd-filters">
        <div className="acd-f">
          <span>Calendar</span>
          <PeriodPicker value={value.period} onChange={(v) => onChange({ ...value, period: v || ALL_TIME })} presets={PRESETS} label="" />
        </div>
        {pick('client', 'Client', 'All clients', true)}
        {pick('dept', 'Department', 'All departments')}
        {pick('section', 'Section', 'All sections')}
        {pick('role', 'Role', 'All roles', true)}
        {pick('emp', 'Employee', 'All employees', true)}
        <label className="acd-f wide">
          <span>Search anything</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search candidate, client, phone, invoice no, position, employee, vendor..." />
        </label>
      </div>
      <div className="acd-chips">
        {chips.map((c) => (
          <span key={c.k} className="acd-chip">{c.l}: <b>{c.v}</b><button type="button" onClick={c.clear} aria-label={`Remove ${c.l}`}>×</button></span>
        ))}
        {chips.length > 0 && <button type="button" className="btn btn-sm" onClick={() => { setQ(''); onChange(BLANK); }}>Clear filters</button>}
        <span className="acd-note" style={{ marginLeft: 'auto', marginTop: 0 }}>
          {loading ? 'Updating…' : counts ? `${counts.invoicesShown} of ${counts.invoicesEver} invoices · ${counts.expensesShown} office bills` : ''}
        </span>
      </div>
    </section>
  );
}
