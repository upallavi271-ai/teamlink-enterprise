import { useMemo } from 'react';
import FilterBar from './FilterBar.jsx';
import { configFor, useListXf } from './ListFilters.jsx';
import { filterRows, localFacets } from './rowFilters.js';

// A filter bar for a list held whole in the browser (components/ats/rowFilters.js): URL-kept values, chips, Clear all, counts.
//   const cf = useClientFilters('employees', rows, { location: (e) => e.location, ... }, user, { noun: 'employees' });
//   draw cf.bar above the table and the rows from cf.rows; cf.active says a filter is on (the page then drops its default status).
export default function useClientFilters(list, rows, get, user, { noun = 'results', storageKey = '' } = {}) {
  const config = useMemo(() => configFor(list, user), [list, user]);
  const xf = useListXf(list, user);
  const filtered = useMemo(() => filterRows(rows, config, xf.values, get), [rows, config, xf.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const facets = useMemo(() => localFacets(rows, config, xf.values, get), [rows, config, xf.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = Object.keys(xf.values).length > 0;
  const bar = (
    <FilterBar
      config={config}
      values={xf.values}
      onChange={xf.set}
      facets={facets}
      total={filtered.length}
      noun={noun}
      onClear={xf.clear}
      canClear={active}
      allTime={active}
      storageKey={storageKey || `cf-${list}`}
      className={`fbar-${list}`}
    />
  );
  return { rows: filtered, bar, active, xf };
}
