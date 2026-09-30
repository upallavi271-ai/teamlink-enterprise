import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import type {
  CreateOrganizationInput, InviteInput, InviteResultView, OrganizationDetail, OrganizationSummary,
} from './organizations.types';

// Organizations ride the same switch as the rest of the tenancy surface.
const real = config.isRealApi('workspaces') || config.isRealApi('team') || !config.useMocks;

export const organizationsService = {
  async list(): Promise<OrganizationSummary[]> {
    if (real) return apiRequest('organizations');
    await mockLatency();
    return [];
  },

  async detail(id: string): Promise<OrganizationDetail> {
    if (real) return apiRequest(`organizations/${id}`);
    await mockLatency(150);
    return { id, name: 'Demo organization', memberCount: 0, members: [], pendingInvites: [], roles: [] };
  },

  async create(input: CreateOrganizationInput): Promise<{ id: string; name: string; defaultWorkspaceId: string }> {
    if (real) return apiRequest('organizations', { method: 'POST', body: input });
    await mockLatency();
    throw new Error('Creating an organization needs the real API.');
  },

  async invite(id: string, input: InviteInput): Promise<InviteResultView> {
    if (real) return apiRequest(`organizations/${id}/invites`, { method: 'POST', body: input });
    await mockLatency();
    throw new Error('Inviting a member needs the real API.');
  },
};
