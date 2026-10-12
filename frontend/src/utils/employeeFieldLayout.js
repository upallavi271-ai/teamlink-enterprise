import { useEffect, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// MANAGE FIELDS -> what the screens draw.
//
// GET /api/employee-fields/layout says, for every built-in employee field, the
// label HR gave it, its help text, whether it is required, whether it is
// paused and where it sits. The Employee form, the profile, My Profile and the
// list read it through useFieldLayout() so a change made in Manage Fields shows
// on all of them. A paused field is simply not drawn; its saved value stays.
//
//   const L = useFieldLayout();
//   L.paused('bloodGroup')           true when HR paused it
//   L.label('phone', 'Phone')        HR's label, else the default given
//   L.help('phone')                  help text, '' when none
//   L.required('phone')              true when HR made it required
//   L.pos('phone', 99)               its place (compare within one section)
//   L.sort(items, (it) => it.key)    drop paused items, order the rest
// ---------------------------------------------------------------------------

let cached = null;
let cachedAt = 0;
let inflight = null;
const TTL_MS = 5000;

const listeners = new Set();
// Called by Manage Fields after every change: every screen showing a form re-reads the layout.
export function invalidateFieldLayout() {
  cached = null; cachedAt = 0;
  listeners.forEach((fn) => fn());
}

function load() {
  if (inflight) return inflight;
  inflight = api.get('/employee-fields/layout')
    .then((r) => { cached = r.data; cachedAt = Date.now(); return cached; })
    .catch(() => cached)
    .finally(() => { inflight = null; });
  return inflight;
}

export function makeLayout(data) {
  const f = (col) => (data && data.fields ? data.fields[col] : null);
  const api2 = {
    loaded: !!data,
    paused: (col) => !!f(col) && f(col).active === false,
    label: (col, fallback) => (f(col) && f(col).label) || fallback,
    help: (col) => (f(col) && f(col).helpText) || '',
    required: (col) => !!(f(col) && f(col).required),
    // Required by HR (the always-required name / email / department / designation keep their own checks).
    enforced: (col) => !!(f(col) && f(col).required && !f(col).locked && f(col).active !== false),
    pos: (col, fallback = 0) => (f(col) ? f(col).position : fallback),
    // Drop the paused ones, order the rest by their place in the list.
    sort: (items, keyOf = (it) => it[0]) => items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !api2.paused(keyOf(it)))
      .sort((a, b) => api2.pos(keyOf(a.it), a.i) - api2.pos(keyOf(b.it), b.i) || a.i - b.i)
      .map(({ it }) => it),
  };
  return api2;
}

export function useFieldLayout() {
  const [data, setData] = useState(cached);
  useEffect(() => {
    let alive = true;
    const pull = () => { load().then((d) => { if (alive && d) setData(d); }); };
    if (cached && Date.now() - cachedAt < TTL_MS) setData(cached); else pull();
    listeners.add(pull);
    return () => { alive = false; listeners.delete(pull); };
  }, []);
  return makeLayout(data);
}
