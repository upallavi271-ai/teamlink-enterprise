import type { AuditLogEntry, ListParams, Paginated } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedAudit } from '@/mocks/audit.mock';

const real = config.isRealApi('audit');
const SEED_WS = 'w2';

export const auditService = {
  async list(orgId: string, params: ListParams): Promise<Paginated<AuditLogEntry>> {
    if (real) return apiRequest(`audit${toQuery(params)}`);
    await mockLatency();
    let rows = orgId === SEED_WS ? seedAudit() : [];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.summary.toLowerCase().includes(q) || r.action.toLowerCase().includes(q));
    if (params.filters?.action) rows = rows.filter((r) => r.action === params.filters!.action);
    if (params.filters?.entityType) rows = rows.filter((r) => r.entityType === params.filters!.entityType);
    const page = params.page ?? 1, pageSize = params.pageSize ?? 25;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async actions(orgId: string): Promise<string[]> {
    if (real) return apiRequest('audit/actions');
    await mockLatency(120);
    return [...new Set((orgId === SEED_WS ? seedAudit() : []).map((r) => r.action))].sort();
  },
};
