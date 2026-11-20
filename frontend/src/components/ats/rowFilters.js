// ---------------------------------------------------------------------------
// FILTERS OVER A LIST THE BROWSER ALREADY HOLDS WHOLE (HRMS employees, payroll structures, leave ...): the same config as the shared
// FilterBar (components/ats/FilterBar.jsx, configFor in ListFilters.jsx) applied to rows, plus the option counts. Pure functions, so
// they are tested without a browser (backend/scripts/ats-filters-test.js).
//   get = { <field id>: (row) => value }   the value the field compares (a string, an array, a number, a day 'YYYY-MM-DD', a boolean)
// ---------------------------------------------------------------------------
const lc = (s) => String(s === undefined || s === null ? '' : s).trim().toLowerCase();
export const csvOf = (v) => String(v === undefined || v === null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean);
const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const DAY = /^\d{4}-\d{2}-\d{2}/;

export const fieldOn = (f, values) => Object.values(f.keys || {}).some((k) => k && values[k] !== undefined && values[k] !== '');

function passes(row, f, values, get) {
  const g = get[f.id];
  if (!g) return true;
  const k = f.keys;
  switch (f.type) {
    case 'multi': case 'select': {
      const want = csvOf(values[k.value]).map(lc);
      if (!want.length) return true;
      return [].concat(g(row)).filter((x) => x !== undefined && x !== null && x !== '').map((x) => lc(x)).some((x) => want.includes(x));
    }
    case 'yesno': {
      const v = values[k.value];
      if (v !== 'yes' && v !== 'no') return true;
      return v === 'yes' ? !!g(row) : !g(row);
    }
    case 'range': {
      const lo = num(values[k.min]); const hi = num(values[k.max]);
      if (lo === null && hi === null) return true;
      const n = num(g(row));
      return n !== null && (lo === null || n >= lo) && (hi === null || n <= hi);
    }
    case 'daterange': {
      const from = DAY.test(String(values[k.from] || '')) ? values[k.from] : '';
      const to = DAY.test(String(values[k.to] || '')) ? values[k.to] : '';
      if (!from && !to) return true;
      const day = String(g(row) || '').slice(0, 10);
      return DAY.test(day) && (!from || day >= from) && (!to || day <= to);
    }
    case 'text': {
      const t = lc(values[k.value]);
      if (!t) return true;
      return lc([].concat(g(row)).join(' ')).includes(t);
    }
    default: return true;
  }
}

/** the rows that pass every field that is on */
export function filterRows(rows, fields, values, get) {
  const active = (fields || []).filter((f) => f.show !== false && fieldOn(f, values));
  if (!active.length) return rows;
  return rows.filter((r) => active.every((f) => passes(r, f, values, get)));
}

/** option counts for the multi / select fields: each counted over the rows that pass every OTHER field */
export function localFacets(rows, fields, values, get) {
  const out = {};
  const list = (fields || []).filter((f) => f.show !== false);
  list.filter((f) => f.type === 'multi' || f.type === 'select').forEach((f) => {
    const g = get[f.id];
    if (!g || f.options) return;
    const others = list.filter((o) => o.id !== f.id && fieldOn(o, values));
    const counts = new Map();
    rows.forEach((r) => {
      if (!others.every((o) => passes(r, o, values, get))) return;
      [].concat(g(r)).forEach((v) => {
        if (v === undefined || v === null || v === '') return;
        counts.set(String(v), (counts.get(String(v)) || 0) + 1);
      });
    });
    const chosen = csvOf(values[f.keys.value]);
    chosen.forEach((c) => { if (!counts.has(c)) counts.set(c, 0); });
    out[f.facet || f.keys.value] = [...counts.entries()].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  });
  return out;
}

/**
 * WHOLE HISTORY for a list that opens on a default status (Active employees first): a search, or any other filter, looks at everybody
 * unless the status was moved off the default on purpose. -> true when the default should NOT be applied.
 */
export function dropDefaultStatus(statusValue, defaultValue, searchOrFilterOn) {
  return !!searchOrFilterOn && !!defaultValue && statusValue === defaultValue;
}
