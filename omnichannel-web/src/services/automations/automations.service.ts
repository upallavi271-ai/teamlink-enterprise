import type {
  Automation, AutomationInput, AutomationRun, AutomationStatus, AutomationTestResult, ListParams, Paginated,
} from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedAutomations, seedRuns } from '@/mocks/automations.mock';

const real = config.isRealApi('automations');
const SEED_WS = 'w2';

// Per-workspace in-memory stores keep the mock honest about tenant isolation.
const autosByWs = new Map<string, Automation[]>();
const runsByWs = new Map<string, Record<string, AutomationRun[]>>();
function autos(orgId: string): Automation[] {
  if (!autosByWs.has(orgId)) autosByWs.set(orgId, orgId === SEED_WS ? seedAutomations() : []);
  return autosByWs.get(orgId)!;
}
function runs(orgId: string): Record<string, AutomationRun[]> {
  if (!runsByWs.has(orgId)) runsByWs.set(orgId, orgId === SEED_WS ? seedRuns() : {});
  return runsByWs.get(orgId)!;
}

export const automationsService = {
  async list(orgId: string, params: ListParams): Promise<Paginated<Automation>> {
    if (real) return apiRequest(`automations${toQuery(params)}`);
    await mockLatency();
    let rows = [...autos(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((a) => a.name.toLowerCase().includes(q));
    if (params.filters?.trigger) rows = rows.filter((a) => a.trigger === params.filters!.trigger);
    if (params.filters?.status) rows = rows.filter((a) => a.status === params.filters!.status);
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async create(orgId: string, input: AutomationInput): Promise<Automation> {
    if (real) return apiRequest('automations', { method: 'POST', body: input });
    await mockLatency();
    const now = new Date().toISOString();
    const a: Automation = {
      id: `au_${Date.now()}`, name: input.name, description: input.description,
      trigger: input.trigger, logic: input.logic, conditions: input.conditions, actions: input.actions,
      status: 'active', runCount: 0, matchCount: 0, createdAt: now, updatedAt: now,
    };
    autos(orgId).unshift(a);
    runs(orgId)[a.id] = [];
    return { ...a };
  },

  async update(orgId: string, id: string, input: Partial<AutomationInput>): Promise<Automation> {
    if (real) return apiRequest(`automations/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const a = autos(orgId).find((x) => x.id === id);
    if (!a) throw new Error('Automation not found');
    Object.assign(a, input, { updatedAt: new Date().toISOString() });
    return { ...a };
  },

  async setStatus(orgId: string, id: string, status: AutomationStatus): Promise<Automation> {
    if (real) return apiRequest(`automations/${id}/status`, { method: 'POST', body: { status } });
    await mockLatency(150);
    const a = autos(orgId).find((x) => x.id === id);
    if (!a) throw new Error('Automation not found');
    a.status = status;
    a.updatedAt = new Date().toISOString();
    return { ...a };
  },

  async remove(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`automations/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    autosByWs.set(orgId, autos(orgId).filter((a) => a.id !== id));
  },

  async runs(orgId: string, id: string): Promise<AutomationRun[]> {
    if (real) {
      const p = await apiRequest<Paginated<AutomationRun>>(`automations/${id}/runs?pageSize=100`);
      return p.items;
    }
    await mockLatency(150);
    return [...(runs(orgId)[id] ?? [])];
  },

  async test(orgId: string, id: string, customerId: string): Promise<AutomationTestResult> {
    if (real) return apiRequest(`automations/${id}/test`, { method: 'POST', body: { customerId } });
    await mockLatency(200);
    const a = autos(orgId).find((x) => x.id === id);
    return {
      automationId: id, automationName: a?.name ?? 'Automation', status: 'success',
      actionsApplied: (a?.actions ?? []).map((ac) => ac.type),
    };
  },
};
