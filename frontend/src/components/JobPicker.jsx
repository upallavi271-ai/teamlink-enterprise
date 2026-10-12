import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import api from '../api';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// THE LIGHT JOB LIST for every "pick a job" box.
//
// The old boxes downloaded EVERY job with its whole pipeline (18 MB, 13-20 s)
// just to draw a list of names. These read GET /requirements/picker instead:
// the 30 newest open jobs, narrowed by what the person types (waits 300 ms
// after the last key), and any job that is already chosen is fetched by id so
// it can always be named.
//
//   useJobRows(ids)          -> Map(id -> { id, reqCode, title, status, department,
//                               internal, clientId, client:{id,name}|null, openings })
//   useJobSearch(enabled)    -> { rows, total, loading, search(q) }
//   useAttentionTop()        -> { total, top } — the Candidates page "Top requirements"
//   useClientNameOfJobs(id)  -> the client's name, read from that client's jobs
//   <JobPickerCombo />       -> the dropdown (looks like every other dropdown)
// ---------------------------------------------------------------------------

// One cache for the whole page: a job fetched for a label is not fetched again.
const ROW_CACHE = new Map();
const IN_FLIGHT = new Map();

export const jobLabel = (r) => `${r.title} — ${r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || '—'}`;

export function useJobRows(ids) {
  const key = (ids || []).filter(Boolean).sort().join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    const missing = key.split(',').filter((id) => id && !ROW_CACHE.has(id));
    if (!missing.length) return undefined;
    let live = true;
    const ask = missing.filter((id) => !IN_FLIGHT.has(id));
    if (ask.length) {
      const p = api.get('/requirements/picker', { params: { ids: ask.join(','), limit: 100 } })
        .then((res) => { (res.data.rows || []).forEach((r) => ROW_CACHE.set(r.id, r)); })
        .catch(() => {})
        .finally(() => ask.forEach((id) => IN_FLIGHT.delete(id)));
      ask.forEach((id) => IN_FLIGHT.set(id, p));
    }
    Promise.all(missing.map((id) => IN_FLIGHT.get(id)).filter(Boolean)).then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, [key]);
  return useMemo(() => new Map(key.split(',').filter((id) => ROW_CACHE.has(id)).map((id) => [id, ROW_CACHE.get(id)])), [key, ROW_CACHE.size]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useJobSearch(enabled = true) {
  const [state, setState] = useState({ rows: [], total: 0, loading: !!enabled });
  const timer = useRef(null);
  const seq = useRef(0);
  const lastQ = useRef('');
  const run = useCallback((q) => {
    lastQ.current = q || '';
    seq.current += 1;
    const mine = seq.current;
    setState((s) => ({ ...s, loading: true }));
    api.get('/requirements/picker', { params: { q: q || undefined, limit: 30 } })
      .then((res) => {
        if (mine !== seq.current) return;
        (res.data.rows || []).forEach((r) => ROW_CACHE.set(r.id, r));
        setState({ rows: res.data.rows || [], total: res.data.total || 0, loading: false });
      })
      .catch(() => { if (mine === seq.current) setState({ rows: [], total: 0, loading: false }); });
  }, []);
  useEffect(() => {
    if (enabled) run('');
    return () => { clearTimeout(timer.current); seq.current += 1; };
  }, [enabled, run]);
  const search = useCallback((q) => {
    const want = String(q || '').trim();
    clearTimeout(timer.current);
    if (want === lastQ.current) return;
    timer.current = setTimeout(() => run(want), 300);
  }, [run]);
  return { ...state, search };
}

// "Top requirements": the jobs that need attention, worked out on the server.
export function useAttentionTop() {
  const [out, setOut] = useState({ total: 0, top: [] });
  useEffect(() => {
    let live = true;
    api.get('/requirements/attention', { params: { limit: 5 } })
      .then((res) => { if (live) setOut({ total: Number(res.data.total) || 0, top: res.data.top || [] }); })
      .catch(() => { if (live) setOut({ total: 0, top: [] }); });
    return () => { live = false; };
  }, []);
  return out;
}

// A client's name when no facet knows it: read from that client's jobs.
export function useClientNameOfJobs(clientId) {
  const [name, setName] = useState('');
  useEffect(() => {
    setName('');
    if (!clientId) return undefined;
    let live = true;
    api.get('/requirements/picker', { params: { clientId, limit: 1 } })
      .then((res) => { const r = (res.data.rows || [])[0]; if (live && r && r.client) setName(r.client.name || ''); })
      .catch(() => {});
    return () => { live = false; };
  }, [clientId]);
  return name;
}

// The dropdown. `blank` is the empty choice ("None — add to database only");
// `disabledIds` greys out jobs that cannot be chosen (already applied).
export function JobPickerCombo({
  value, onChange, blank = 'Choose a job…', disabledIds = [], enabled = true, labelOf = jobLabel, ...rest
}) {
  const { rows, total, loading, search } = useJobSearch(enabled);
  const chosen = useJobRows(value ? [value] : []);
  const options = useMemo(() => {
    const seen = new Set(rows.map((r) => r.id));
    const extra = value && !seen.has(value) && chosen.get(value) ? [chosen.get(value)] : [];
    return [...extra, ...rows];
  }, [rows, value, chosen]);
  return (
    <Combo value={value} onChange={onChange} onSearch={search} emptyText={loading ? 'Loading...' : 'No job found'} {...rest}>
      <option value="">{blank}</option>
      {options.map((r) => (
        <option key={r.id} value={r.id} disabled={disabledIds.includes(r.id)}>{labelOf(r)}</option>
      ))}
      {total > rows.length && (
        <option value="__more" disabled>{`Showing ${rows.length} of ${total.toLocaleString('en-IN')} jobs — type a job, code or client to find others`}</option>
      )}
    </Combo>
  );
}

export default JobPickerCombo;
