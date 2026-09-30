/**
 * Per-workspace in-memory collections. Seeded ONLY for the demo workspace (w2);
 * other workspaces start empty (truthful — mirrors the org-scoped real API).
 * The ONE place mock domain data is stored and mutated.
 */
import type { ListParams, Paginated } from '@/types';
import { mockLatency, paginate } from './mockDb';

type WithId = { id: string };

export interface ListConfig<T> {
  searchFields: (keyof T)[];
  sortFields: string[];
  defaultSort: string;
  filter?: (row: T, filters: Record<string, string | undefined>) => boolean;
}

export class WorkspaceScopedMock<T extends WithId> {
  private byWorkspace = new Map<string, T[]>();
  constructor(
    private seedWorkspaceId: string,
    private seed: () => T[],
    private cfg: ListConfig<T>,
  ) {}

  private rows(orgId: string): T[] {
    if (!this.byWorkspace.has(orgId)) {
      this.byWorkspace.set(orgId, orgId === this.seedWorkspaceId ? this.seed() : []);
    }
    return this.byWorkspace.get(orgId)!;
  }

  async list(orgId: string, params: ListParams = {}): Promise<Paginated<T>> {
    await mockLatency();
    let rows = [...this.rows(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        this.cfg.searchFields.some((f) => String(r[f] ?? '').toLowerCase().includes(q)),
      );
    }
    if (params.filters && this.cfg.filter) {
      rows = rows.filter((r) => this.cfg.filter!(r, params.filters!));
    }
    const sort = this.cfg.sortFields.includes(params.sort ?? '') ? params.sort! : this.cfg.defaultSort;
    const dir = params.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[sort as keyof T] as unknown as string | number;
      const bv = b[sort as keyof T] as unknown as string | number;
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * dir;
    });
    return paginate(rows, params);
  }

  async all(orgId: string): Promise<T[]> { await mockLatency(120); return [...this.rows(orgId)]; }
  async get(orgId: string, id: string): Promise<T | undefined> { await mockLatency(120); return this.rows(orgId).find((r) => r.id === id); }

  async create(orgId: string, row: T): Promise<T> {
    await mockLatency();
    this.rows(orgId).unshift(row);
    return row;
  }
  async update(orgId: string, id: string, patch: Partial<T>): Promise<T> {
    await mockLatency();
    const rows = this.rows(orgId);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('Not found');
    rows[i] = { ...rows[i], ...patch };
    return rows[i];
  }
  async remove(orgId: string, id: string): Promise<void> {
    await mockLatency();
    const rows = this.rows(orgId);
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) rows.splice(i, 1);
  }
  async removeMany(orgId: string, ids: string[]): Promise<void> {
    await mockLatency();
    const set = new Set(ids);
    const rows = this.rows(orgId);
    for (let i = rows.length - 1; i >= 0; i--) if (set.has(rows[i].id)) rows.splice(i, 1);
  }
}

export const genId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
export const nowIso = () => new Date().toISOString();
