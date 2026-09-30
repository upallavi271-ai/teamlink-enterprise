import type {
  InviteInput, InviteResult, ListParams, Paginated, PermissionDef, RoleInput, TeamMember, TeamRole,
} from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedMembers, seedRoles, permissionCatalog } from '@/mocks/team.mock';
import { mockAttachedPolicies } from '../policies/policies.service';

const real = config.isRealApi('team');

// ── Mock store (demo workspace w2 only; others start empty) ──────────────────
const SEED_WS = 'w2';
const membersByWs = new Map<string, TeamMember[]>();
const rolesByWs = new Map<string, TeamRole[]>();
function members(orgId: string): TeamMember[] {
  if (!membersByWs.has(orgId)) membersByWs.set(orgId, orgId === SEED_WS ? seedMembers() : []);
  return membersByWs.get(orgId)!;
}
function roles(orgId: string): TeamRole[] {
  if (!rolesByWs.has(orgId)) rolesByWs.set(orgId, orgId === SEED_WS ? seedRoles() : []);
  return rolesByWs.get(orgId)!;
}
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'role';

export const teamService = {
  async listMembers(orgId: string, params: ListParams): Promise<Paginated<TeamMember>> {
    if (real) return apiRequest(`team/members${toQuery(params)}`);
    await mockLatency();
    let rows = [...members(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((m) => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q));
    const status = params.filters?.status;
    if (status) rows = rows.filter((m) => m.status === status);
    const roleKey = params.filters?.roleKey;
    if (roleKey) rows = rows.filter((m) => m.role.key === roleKey);
    const total = rows.length;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
  },

  /**
   * The real endpoint embeds each role's attached policies (see TeamRole.policies);
   * the mock has to do that join itself, so the Roles screen behaves the same
   * with and without a backend.
   */
  async listRoles(orgId: string): Promise<TeamRole[]> {
    if (real) return apiRequest('team/roles');
    await mockLatency(150);
    return roles(orgId).map((r) => ({ ...r, policies: mockAttachedPolicies(orgId, r.key) }));
  },

  async listPermissions(): Promise<PermissionDef[]> {
    if (real) return apiRequest('team/permissions');
    await mockLatency(120);
    return permissionCatalog.map((p) => ({ ...p }));
  },

  async invite(orgId: string, input: InviteInput): Promise<InviteResult> {
    if (real) return apiRequest('team/invites', { method: 'POST', body: input });
    await mockLatency();
    const role = roles(orgId).find((r) => r.key === input.roleKey);
    if (!role) throw new Error('Role not found');
    if (members(orgId).some((m) => m.user.email.toLowerCase() === input.email.toLowerCase())) {
      throw new Error('That person is already in this workspace');
    }
    const m: TeamMember = {
      id: `m_${Date.now()}`,
      user: { id: `u_${Date.now()}`, name: input.email.split('@')[0], email: input.email },
      role: { id: role.id, key: role.key, name: role.name },
      status: 'invited',
      joinedAt: new Date().toISOString(),
    };
    members(orgId).unshift(m);
    return { id: m.id, email: input.email, role: { key: role.key, name: role.name }, token: 'demo-token', delivery: 'demo' };
  },

  async changeRole(orgId: string, memberId: string, roleKey: string): Promise<void> {
    if (real) { await apiRequest(`team/members/${memberId}/role`, { method: 'PATCH', body: { roleKey } }); return; }
    await mockLatency();
    const m = members(orgId).find((x) => x.id === memberId);
    const role = roles(orgId).find((r) => r.key === roleKey);
    if (m && role) m.role = { id: role.id, key: role.key, name: role.name };
  },

  async setStatus(orgId: string, memberId: string, status: 'active' | 'suspended'): Promise<void> {
    if (real) { await apiRequest(`team/members/${memberId}/status`, { method: 'PATCH', body: { status } }); return; }
    await mockLatency();
    const m = members(orgId).find((x) => x.id === memberId);
    if (m) m.status = status;
  },

  async removeMember(orgId: string, memberId: string): Promise<void> {
    if (real) { await apiRequest(`team/members/${memberId}`, { method: 'DELETE' }); return; }
    await mockLatency();
    membersByWs.set(orgId, members(orgId).filter((m) => m.id !== memberId));
  },

  async createRole(orgId: string, input: RoleInput): Promise<TeamRole> {
    if (real) return apiRequest('team/roles', { method: 'POST', body: input });
    await mockLatency();
    const role: TeamRole = {
      id: `r_${Date.now()}`, key: slug(input.name), name: input.name,
      description: input.description, isSystem: false, memberCount: 0, permissionKeys: [...input.permissionKeys],
      policies: [],
    };
    roles(orgId).push(role);
    return { ...role };
  },

  async updateRole(orgId: string, roleId: string, input: Partial<RoleInput>): Promise<TeamRole> {
    if (real) return apiRequest(`team/roles/${roleId}`, { method: 'PATCH', body: input });
    await mockLatency();
    const r = roles(orgId).find((x) => x.id === roleId);
    if (!r) throw new Error('Role not found');
    if (r.isSystem) throw new Error('System roles cannot be edited');
    if (input.name !== undefined) r.name = input.name;
    if (input.description !== undefined) r.description = input.description;
    if (input.permissionKeys !== undefined) r.permissionKeys = [...input.permissionKeys];
    return { ...r, policies: mockAttachedPolicies(orgId, r.key) };
  },

  async deleteRole(orgId: string, roleId: string): Promise<void> {
    if (real) { await apiRequest(`team/roles/${roleId}`, { method: 'DELETE' }); return; }
    await mockLatency();
    const r = roles(orgId).find((x) => x.id === roleId);
    if (!r) throw new Error('Role not found');
    if (r.isSystem) throw new Error('System roles cannot be deleted');
    if (r.memberCount > 0) throw new Error('Reassign members using this role before deleting it');
    rolesByWs.set(orgId, roles(orgId).filter((x) => x.id !== roleId));
  },
};
