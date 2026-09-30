import type {
  PasswordChangeInput, ProfileInput, WorkspaceSettings, WorkspaceSettingsInput,
} from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';

const real = config.isRealApi('settings');

export const settingsService = {
  async updateProfile(input: ProfileInput): Promise<{ id: string; name: string; email?: string; avatarUrl?: string | null }> {
    if (real) return apiRequest('users/me', { method: 'PATCH', body: input });
    await mockLatency();
    return { id: 'u1', name: input.name ?? 'Admin', avatarUrl: input.avatarUrl ?? null };
  },

  async changePassword(input: PasswordChangeInput): Promise<void> {
    if (real) { await apiRequest('users/me/password', { method: 'POST', body: input }); return; }
    await mockLatency();
    if (input.newPassword.length < 8) throw new Error('Use at least 8 characters');
    // Demo mode has no real credential to verify against.
  },

  async getWorkspace(orgId: string): Promise<WorkspaceSettings> {
    if (real) return apiRequest('workspaces/current');
    await mockLatency(120);
    return { id: orgId, name: 'Green Start Demo', slug: 'green-start-demo', timezone: 'Asia/Kolkata', currency: 'INR', status: 'active' };
  },

  async updateWorkspace(orgId: string, input: WorkspaceSettingsInput): Promise<WorkspaceSettings> {
    if (real) return apiRequest(`workspaces/${orgId}`, { method: 'PATCH', body: input });
    await mockLatency();
    return { id: orgId, name: input.name ?? 'Green Start Demo', timezone: input.timezone ?? 'Asia/Kolkata' };
  },
};
