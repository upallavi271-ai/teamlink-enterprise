/**
 * Auth service — mock/real split. Real mode talks to gs-api:
 *   POST /auth/login → { accessToken, user }
 *   GET  /auth/me    → { user, workspaces, permissions }   (permissions = active workspace)
 * The frontend enums/shapes are mapped here so stores stay backend-agnostic.
 */
import type { User, Workspace } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import { MOCK_USER, MOCK_WORKSPACES, MOCK_PERMISSIONS } from '@/mocks/workspaces.mock';

export interface LoginResult { token: string; user: User }
export interface SessionContext { user: User; workspaces: Workspace[]; permissions: string[] }

interface ApiUser { id: string; name: string; email: string; avatarColor?: string; isSuperAdmin?: boolean }
interface ApiWorkspace { id: string; name: string; logoUrl?: string | null; role?: { key: string; name: string } | string }

const mapUser = (u: ApiUser): User => ({ id: u.id, name: u.name, email: u.email, avatarColor: u.avatarColor, isSuperAdmin: u.isSuperAdmin });
const mapWorkspaces = (list: ApiWorkspace[]): Workspace[] =>
  list.map((w) => ({
    id: w.id,
    name: w.name,
    role: typeof w.role === 'string' ? w.role : w.role?.key,
    logoText: (w.name || 'GS').slice(0, 2).toUpperCase(),
  }));

export const authService = {
  async login(email: string, password: string): Promise<LoginResult> {
    if (!config.realAuth) {
      await mockLatency();
      return { token: 'mock-token', user: { ...MOCK_USER, email: email || MOCK_USER.email } };
    }
    const res = await apiRequest<{ accessToken: string; user: ApiUser }>('auth/login', {
      method: 'POST', body: { email, password },
    });
    return { token: res.accessToken, user: mapUser(res.user) };
  },

  async me(): Promise<SessionContext> {
    if (!config.realAuth) {
      await mockLatency(120);
      return { user: MOCK_USER, workspaces: MOCK_WORKSPACES, permissions: MOCK_PERMISSIONS };
    }
    const ctx = await apiRequest<{ user: ApiUser; workspaces: ApiWorkspace[]; permissions: string[] }>('auth/me');
    return { user: mapUser(ctx.user), workspaces: mapWorkspaces(ctx.workspaces), permissions: ctx.permissions ?? [] };
  },
};
