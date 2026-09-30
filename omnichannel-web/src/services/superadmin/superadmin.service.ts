import type {
  AdminOrg, AdminOrgDetail, AdminUser, ListParams, OrgStatus, Paginated, SuperAdminStats,
} from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedOrgDetail, seedOrgs, seedStats, seedUsers } from '@/mocks/superAdmin.mock';

const real = config.isRealApi('super-admin');

// Mock stores mutate in place so status changes persist within the session.
let orgStore: AdminOrg[] | null = null;
let userStore: AdminUser[] | null = null;
const orgs = () => (orgStore ??= seedOrgs());
const users = () => (userStore ??= seedUsers());

export const superAdminService = {
  async stats(): Promise<SuperAdminStats> {
    if (real) return apiRequest('admin/stats');
    await mockLatency(150);
    return seedStats();
  },

  async organizations(params: ListParams): Promise<Paginated<AdminOrg>> {
    if (real) return apiRequest(`admin/organizations${toQuery(params)}`);
    await mockLatency();
    let rows = [...orgs()];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q));
    if (params.filters?.status) rows = rows.filter((o) => o.status === params.filters!.status);
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async organization(id: string): Promise<AdminOrgDetail> {
    if (real) return apiRequest(`admin/organizations/${id}`);
    await mockLatency(150);
    return seedOrgDetail(id);
  },

  async setOrgStatus(id: string, status: OrgStatus): Promise<{ id: string; status: OrgStatus }> {
    if (real) return apiRequest(`admin/organizations/${id}/status`, { method: 'POST', body: { status } });
    await mockLatency(150);
    const o = orgs().find((x) => x.id === id);
    if (o) o.status = status;
    return { id, status };
  },

  async users(params: ListParams): Promise<Paginated<AdminUser>> {
    if (real) return apiRequest(`admin/users${toQuery(params)}`);
    await mockLatency();
    let rows = [...users()];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    if (params.filters?.status) rows = rows.filter((u) => u.status === params.filters!.status);
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async setUserStatus(id: string, status: 'active' | 'suspended'): Promise<{ id: string; status: string }> {
    if (real) return apiRequest(`admin/users/${id}/status`, { method: 'POST', body: { status } });
    await mockLatency(150);
    const u = users().find((x) => x.id === id);
    if (u) u.status = status;
    return { id, status };
  },
};
