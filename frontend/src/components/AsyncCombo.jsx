import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// ASYNCCOMBO (2026-10-16) - a dropdown you can ALSO type into, for lists that are
// too big to download (candidates: 17,000 people).
//
//   <AsyncCombo
//     value={candidateId}
//     selected={{ value, label }}          the chosen row's label (so it can be named while the list is searching)
//     search={(q) => Promise<[{ value, label, disabled? }]>}   the server search (scope / privacy are the server's job)
//     onChange={(value, row) => ...}       row = the option object the search returned (null when cleared)
//   />
//
// It opens with the first rows (search('')), waits 250 ms after the last key, ignores answers that arrive late,
// says 'Searching...' while it waits and 'No match for "x"' when nothing comes back. It is the existing Combo inside,
// so it looks and types like every other dropdown. Closed ID pickers only: a typed word that matches nothing is refused.
// ---------------------------------------------------------------------------
export default function AsyncCombo({
  value, onChange, search, selected = null, placeholder = 'Select or type to search...', emptyText = 'Nothing to pick yet.',
  disabled = false, id, debounceMs = 250, className, style,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const seq = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;
  const lastQ = useRef(null);

  const run = useCallback((q) => {
    lastQ.current = q;
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    Promise.resolve(searchRef.current(q))
      .then((list) => { if (mine === seq.current) { setRows(Array.isArray(list) ? list : []); setLoading(false); } })
      .catch(() => { if (mine === seq.current) { setRows([]); setLoading(false); } });
  }, []);

  // Combo tells us what is typed (and '' when closed): the first call fills the opening list.
  const onSearch = useCallback((q) => {
    const want = String(q || '').trim();
    if (want === lastQ.current) return;
    clearTimeout(timer.current);
    if (lastQ.current === null) { run(want); return; }
    setLoading(true);
    timer.current = setTimeout(() => run(want), debounceMs);
  }, [run, debounceMs]);
  useEffect(() => () => { clearTimeout(timer.current); seq.current += 1; }, []);

  const byValue = useMemo(() => new Map(rows.map((r) => [r.value, r])), [rows]);
  const options = useMemo(() => {
    const list = [...rows];
    if (selected && selected.value && !byValue.has(selected.value)) list.unshift(selected);
    return list;
  }, [rows, selected, byValue]);

  return (
    <Combo
      id={id}
      className={className}
      style={style}
      value={value || ''}
      disabled={disabled}
      placeholder={placeholder}
      emptyText={loading ? 'Searching...' : emptyText}
      onSearch={onSearch}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v, byValue.get(v) || (selected && selected.value === v ? selected : null));
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value} disabled={!!o.disabled}>{o.label}</option>)}
      {loading && options.length === 0 && <option value="__searching" disabled>Searching...</option>}
    </Combo>
  );
}

// The candidate search shared by every "pick a person" box: GET /candidates/picker (name, CAN-code, phone tail, email;
// a client-manager login gets names and codes only - the server decides). `requirementId` marks people already on that job.
export function candidateSearcher(api, { requirementId } = {}) {
  return async (q) => {
    const res = await api.get('/candidates/picker', { params: { q: q || undefined, requirementId: requirementId || undefined } });
    return (res.data.rows || []).map((c) => ({
      value: c.id,
      label: [c.name, c.code, c.phoneTail ? `phone ...${c.phoneTail}` : null, c.location, c.onJob ? `already on this requirement (${c.onJob.step})` : null].filter(Boolean).join(' · '),
      name: c.name,
      onJob: c.onJob,
    }));
  };
}
