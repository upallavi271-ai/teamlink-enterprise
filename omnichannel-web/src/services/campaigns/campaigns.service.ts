import type { Campaign, CampaignCreateInput, CampaignStatus, ListParams, Paginated } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { WorkspaceScopedMock, genId, nowIso } from '../scopedMock';
import { seedCampaigns } from '@/mocks/campaigns.mock';

const mock = new WorkspaceScopedMock<Campaign>('w2', seedCampaigns, {
  searchFields: ['name'],
  sortFields: ['name', 'createdAt', 'recipients'],
  defaultSort: 'createdAt',
  filter: (c, f) => (!f.channel || c.channel === f.channel) && (!f.status || c.status === f.status),
});
const real = config.isRealApi('campaigns');

export const campaignsService = {
  list(orgId: string, params: ListParams): Promise<Paginated<Campaign>> {
    return real ? apiRequest(`campaigns${toQuery(params)}`) : mock.list(orgId, params);
  },
  create(orgId: string, input: CampaignCreateInput): Promise<Campaign> {
    const draft: Campaign = { ...input, id: genId('cmp'), status: 'draft', recipients: 0, sent: 0, delivered: 0, read: 0, failed: 0, createdAt: nowIso() };
    return real ? apiRequest('campaigns', { method: 'POST', body: input }) : mock.create(orgId, draft);
  },
  setStatus(orgId: string, id: string, status: CampaignStatus): Promise<Campaign> {
    return real ? apiRequest(`campaigns/${id}/status`, { method: 'POST', body: { status } }) : mock.update(orgId, id, { status });
  },
  async duplicate(orgId: string, id: string): Promise<Campaign> {
    if (real) return apiRequest(`campaigns/${id}/duplicate`, { method: 'POST' });
    const src = await mock.get(orgId, id);
    if (!src) throw new Error('Not found');
    return mock.create(orgId, { ...src, id: genId('cmp'), name: `${src.name} (copy)`, status: 'draft', sent: 0, delivered: 0, read: 0, failed: 0, createdAt: nowIso() });
  },
  remove(orgId: string, id: string): Promise<void> {
    return real ? apiRequest(`campaigns/${id}`, { method: 'DELETE' }) : mock.remove(orgId, id);
  },
};
