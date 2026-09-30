import type { SocialAccount, SocialConnectResult, SocialProviderStatus } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedProviders, seedAccounts } from '@/mocks/social.mock';

const real = config.isRealApi('social');
const SEED_WS = 'w2';

// In-memory mock store so connect/disconnect persist within a session.
let accountStore: SocialAccount[] | null = null;
const accounts = (orgId: string) => (accountStore ??= orgId === SEED_WS ? seedAccounts() : []);

export const socialService = {
  async providers(orgId: string): Promise<SocialProviderStatus[]> {
    if (real) return apiRequest('social/providers');
    await mockLatency(150);
    const conn = accounts(orgId);
    return seedProviders().map((p) => {
      const count = conn.filter((a) => a.provider === p.provider && a.status === 'ACTIVE').length;
      return { ...p, connected: count > 0, accountCount: count };
    });
  },

  async accounts(orgId: string): Promise<SocialAccount[]> {
    if (real) return apiRequest('social/accounts');
    await mockLatency();
    return accounts(orgId).filter((a) => a.status !== 'DISCONNECTED');
  },

  async connect(_orgId: string, provider: string): Promise<SocialConnectResult> {
    if (real) return apiRequest(`social/${provider}/connect`, { method: 'POST' });
    await mockLatency(150);
    // Mock/demo: never fabricate a real connection — report configuration required.
    return { configured: false, message: 'Social publishing is not configured on the server. Add Meta app credentials to connect a real account.' };
  },

  async callback(_orgId: string, provider: string, code: string, state: string): Promise<{ connected: number; accounts: SocialAccount[] }> {
    return apiRequest(`social/${provider}/callback`, { method: 'POST', body: { code, state } });
  },

  async sync(orgId: string, provider: string): Promise<{ synced: number; accounts: SocialAccount[] }> {
    if (real) return apiRequest(`social/${provider}/sync`, { method: 'POST' });
    await mockLatency();
    return { synced: 0, accounts: accounts(orgId).filter((a) => a.status !== 'DISCONNECTED') };
  },

  async disconnect(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`social/accounts/${id}`, { method: 'DELETE' }); return; }
    await mockLatency(150);
    const a = accounts(orgId).find((x) => x.id === id);
    if (a) a.status = 'DISCONNECTED';
  },
};
