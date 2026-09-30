/**
 * In-memory mock helpers. The ONLY place mock data is stored/mutated.
 * Adds artificial latency so loading states are exercised in development.
 */
import type { ListParams, Paginated } from '@/types';

export const mockLatency = (ms = 220) => new Promise<void>((r) => setTimeout(r, ms));

export function paginate<T>(rows: T[], params: ListParams = {}): Paginated<T> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 10));
  const start = (page - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
}
