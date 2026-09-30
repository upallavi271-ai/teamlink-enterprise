import type { Agent } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import { MOCK_AGENTS } from '@/mocks/crm.mock';

export const agentsService = {
  async list(_orgId: string): Promise<Agent[]> {
    if (config.isRealApi('customers')) return apiRequest('agents');
    await mockLatency(120);
    return MOCK_AGENTS;
  },
};
