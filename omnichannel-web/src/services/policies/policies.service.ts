import type { ListParams, Paginated, Policy, PolicyInput, RolePolicy } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedPolicies, seedRolePolicyIds } from '@/mocks/policies.mock';

/**
 * Policies — reusable permission bundles that roles attach, so a permission set
 * can be maintained in one place instead of being re-checked on every role.
 *
 * Endpoints (fixed contract with gs-api):
 *   GET    policies                      -> Paginated<Policy>
 *   POST   policies                      body PolicyInput
 *   PATCH  policies/:id                  body Partial<PolicyInput>
 *   DELETE policies/:id
 *   PUT    team/roles/:roleKey/policies  body { policyIds } — REPLACES the set
 *
 * Reads need `team.view`, writes need `role.manage`; the API is authoritative
 * and the UI only gates for UX (see features/auth/useCan.ts).
 *
 * The mock<->real decision lives here, never in a component — same shape as
 * team.service.ts next door.
 */
const real = config.isRealApi('policies');

// ── Mock store (demo workspace w2 only; others start empty) ──────────────────
const SEED_WS = 'w2';
const policiesByWs = new Map<string, Policy[]>();
/** roleKey -> policyIds, per workspace. The mock's copy of the join table. */
const linksByWs = new Map<string, Record<string, string[]>>();

function store(orgId: string): Policy[] {
  if (!policiesByWs.has(orgId)) policiesByWs.set(orgId, orgId === SEED_WS ? seedPolicies() : []);
  return policiesByWs.get(orgId)!;
}
function links(orgId: string): Record<string, string[]> {
  if (!linksByWs.has(orgId)) linksByWs.set(orgId, orgId === SEED_WS ? seedRolePolicyIds() : {});
  return linksByWs.get(orgId)!;
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'policy';

/** roleCount is derived from the join table, never stored — it cannot go stale. */
function withRoleCount(orgId: string, p: Policy): Policy {
  const all = Object.values(links(orgId));
  return { ...p, roleCount: all.reduce((n, ids) => (ids.includes(p.id) ? n + 1 : n), 0) };
}

/**
 * What `GET team/roles` embeds per role, for the MOCK branch of team.service.
 * The real API does this join server-side; in mock mode the two services have
 * to agree, and this is the one direction of the dependency (team -> policies).
 */
export function mockAttachedPolicies(orgId: string, roleKey: string): RolePolicy[] {
  const ids = new Set(links(orgId)[roleKey] ?? []);
  return store(orgId)
    .filter((p) => ids.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, description: p.description }));
}

export const policiesService = {
  async list(orgId: string, params: ListParams): Promise<Paginated<Policy>> {
    if (real) return apiRequest(`policies${toQuery(params)}`);
    await mockLatency();
    let rows = store(orgId).map((p) => withRoleCount(orgId, p));
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((p) => `${p.name} ${p.key} ${p.description ?? ''}`.toLowerCase().includes(q));
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 10;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async create(orgId: string, input: PolicyInput): Promise<Policy> {
    if (real) return apiRequest('policies', { method: 'POST', body: input });
    await mockLatency();
    const key = input.key || slug(input.name);
    if (store(orgId).some((p) => p.key === key)) throw new Error('A policy with that key already exists');
    const policy: Policy = {
      id: `pol_${Date.now()}`,
      key,
      name: input.name,
      description: input.description,
      permissionKeys: [...input.permissionKeys],
      roleCount: 0,
      createdAt: new Date().toISOString(),
    };
    store(orgId).unshift(policy);
    return { ...policy };
  },

  async update(orgId: string, id: string, input: Partial<PolicyInput>): Promise<Policy> {
    if (real) return apiRequest(`policies/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const p = store(orgId).find((x) => x.id === id);
    if (!p) throw new Error('Policy not found');
    if (input.name !== undefined) p.name = input.name;
    if (input.description !== undefined) p.description = input.description;
    if (input.permissionKeys !== undefined) p.permissionKeys = [...input.permissionKeys];
    return withRoleCount(orgId, p);
  },

  async remove(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`policies/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    policiesByWs.set(orgId, store(orgId).filter((p) => p.id !== id));
    // Detaching from every role mirrors the server's cascade: a deleted policy
    // must not keep granting permissions through a dangling link.
    const l = links(orgId);
    for (const roleKey of Object.keys(l)) l[roleKey] = l[roleKey].filter((pid) => pid !== id);
  },

  /** Replaces the whole set of policies on a role. Addressed by role KEY, not id. */
  async setRolePolicies(orgId: string, roleKey: string, policyIds: string[]): Promise<void> {
    if (real) {
      await apiRequest(`team/roles/${roleKey}/policies`, { method: 'PUT', body: { policyIds } });
      return;
    }
    await mockLatency();
    const known = new Set(store(orgId).map((p) => p.id));
    const unknown = policyIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error('Unknown policy');
    links(orgId)[roleKey] = [...policyIds];
  },
};
