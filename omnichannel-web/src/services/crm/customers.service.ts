import type { ConsentRecord, Customer, CustomerInput, ListParams, Paginated } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { collectAll } from '@/lib/collectAll';
import { WorkspaceScopedMock, genId, nowIso } from '../scopedMock';
import { mockLatency } from '../mockDb';
import { seedCustomers } from '@/mocks/crm.mock';

const mock = new WorkspaceScopedMock<Customer>('w2', seedCustomers, {
  searchFields: ['name', 'email', 'phone', 'platformId'],
  sortFields: ['name', 'createdAt', 'leadStage'],
  defaultSort: 'createdAt',
  filter: (c, f) =>
    (!f.source || c.source === f.source) &&
    (!f.leadStage || c.leadStage === f.leadStage) &&
    (!f.leadStatus || c.leadStatus === f.leadStatus) &&
    (!f.agent || c.assignedAgentId === f.agent),
});

const real = config.isRealApi('customers');

export interface BulkImportResult {
  created: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

export const customersService = {
  list(orgId: string, params: ListParams): Promise<Paginated<Customer>> {
    return real ? apiRequest(`customers${toQuery(params)}`) : mock.list(orgId, params);
  },
  create(orgId: string, input: CustomerInput): Promise<Customer> {
    return real ? apiRequest('customers', { method: 'POST', body: input })
      : mock.create(orgId, { ...input, id: genId('cus'), createdAt: nowIso(), updatedAt: nowIso() });
  },
  update(orgId: string, id: string, patch: Partial<CustomerInput>): Promise<Customer> {
    return real ? apiRequest(`customers/${id}`, { method: 'PATCH', body: patch })
      : mock.update(orgId, id, { ...patch, updatedAt: nowIso() });
  },
  remove(orgId: string, id: string): Promise<void> {
    return real ? apiRequest(`customers/${id}`, { method: 'DELETE' }) : mock.remove(orgId, id);
  },
  /**
   * Import many at once. The server validates each row on its own and reports
   * created/skipped with reasons — one bad line never rejects the file. Rows are
   * sent in chunks of 500 to match the API cap.
   */
  async bulkImport(orgId: string, rows: Partial<CustomerInput>[], source = 'CSV Import'): Promise<BulkImportResult> {
    const total: BulkImportResult = { created: 0, skipped: 0, errors: [] };
    if (!real) {
      await mockLatency(200);
      for (const r of rows) {
        if (!r.name || (!r.phone && !r.email)) { total.skipped++; continue; }
        await mock.create(orgId, {
          name: r.name, phone: r.phone, email: r.email, platformId: r.platformId,
          source: r.source || source, campaignName: r.campaignName,
          leadStage: r.leadStage ?? 'new', leadStatus: r.leadStatus ?? 'active',
          id: genId('cus'), createdAt: nowIso(), updatedAt: nowIso(),
        });
        total.created++;
      }
      return total;
    }
    for (let i = 0; i < rows.length; i += 500) {
      const res = await apiRequest<BulkImportResult>('customers/bulk', {
        method: 'POST', body: { rows: rows.slice(i, i + 500), source },
      });
      total.created += res.created;
      total.skipped += res.skipped;
      total.errors.push(...res.errors.map((e) => ({ ...e, row: e.row + i })));
    }
    return total;
  },
  removeMany(orgId: string, ids: string[]): Promise<void> {
    return real ? apiRequest('customers/bulk-delete', { method: 'POST', body: { ids } }) : mock.removeMany(orgId, ids);
  },
  /**
   * Every matching customer, paged through the list endpoint (which caps
   * pageSize at 100). `params` lets callers scope the export to the current
   * search/filters; omitted, it returns the whole workspace.
   */
  all(orgId: string, params: ListParams = {}): Promise<Customer[]> {
    return collectAll((page, pageSize) => this.list(orgId, { ...params, page, pageSize }));
  },

  // ── Consent (DPDP) ────────────────────────────────────────────────────────
  consents(_orgId: string, id: string): Promise<ConsentRecord[]> {
    return real ? apiRequest(`customers/${id}/consents`) : Promise.resolve([]);
  },
  recordConsent(orgId: string, id: string, input: { status: 'granted' | 'withdrawn'; source?: string; note?: string; noticeVersion?: string }): Promise<Customer> {
    return real ? apiRequest(`customers/${id}/consents`, { method: 'POST', body: { purpose: 'marketing', source: 'manual', ...input } })
      : mock.update(orgId, id, { consentStatus: input.status } as Partial<Customer>);
  },
};
