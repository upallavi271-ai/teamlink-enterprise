import type { Paginated } from '@/types';

/**
 * Collect every row of a paginated endpoint by walking its pages. List
 * endpoints cap pageSize (100 for most), so "export everything" must page
 * through rather than ask for one huge page. Filters/search are whatever the
 * caller bakes into fetchPage, so the export matches what's on screen.
 *
 * Bounded by maxRows (default 10k) and a hard page ceiling so a bad `total`
 * can never loop forever.
 */
export async function collectAll<T>(
  fetchPage: (page: number, pageSize: number) => Promise<Paginated<T>>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxRows = opts.maxRows ?? 10_000;
  const out: T[] = [];
  for (let page = 1; page <= 200; page++) {
    const res = await fetchPage(page, pageSize);
    out.push(...res.items);
    if (out.length >= maxRows) return out.slice(0, maxRows);
    if (res.items.length < pageSize) break;               // last (partial) page
    if (res.total && out.length >= res.total) break;      // collected everything
  }
  return out;
}
