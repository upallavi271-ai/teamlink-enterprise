import { useMemo, useState } from 'react';
import type { ListParams } from '@/types';

export function useListParams(defaults?: Partial<ListParams>) {
  const [search, setSearch] = useState(defaults?.search ?? '');
  const [sort, setSort] = useState(defaults?.sort ?? '');
  const [dir, setDir] = useState<'asc' | 'desc'>(defaults?.dir ?? 'desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaults?.pageSize ?? 10);
  const [filters, setFilters] = useState<Record<string, string | undefined>>(defaults?.filters ?? {});

  const params: ListParams = useMemo(
    () => ({ search: search || undefined, sort: sort || undefined, dir, page, pageSize, filters }),
    [search, sort, dir, page, pageSize, filters],
  );

  const setFilter = (key: string, value: string | undefined) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  };
  /** Set sort field and direction outright — for menus that name the direction. */
  const applySort = (field: string, next: 'asc' | 'desc') => {
    setSort(field);
    setDir(next);
    setPage(1);
  };
  const toggleSort = (field: string) => {
    if (sort === field) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(field); setDir('asc'); }
    setPage(1);
  };
  const changeSearch = (v: string) => { setSearch(v); setPage(1); };
  /** Changing the page size always returns to page 1 — page 4 of the old size
   *  is rarely page 4 of the new one, and landing past the end shows nothing. */
  const setPageSize = (n: number) => { setPageSizeState(n); setPage(1); };

  return { params, search, setSearch: changeSearch, sort, dir, toggleSort, applySort, page, setPage, pageSize, setPageSize, filters, setFilter };
}
