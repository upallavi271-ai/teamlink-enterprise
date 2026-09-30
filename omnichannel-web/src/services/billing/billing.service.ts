import type { BillingOverview, BillingPlan, CreditTxn, Paginated } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedOverview, seedPlans, seedTxns } from '@/mocks/billing.mock';

const real = config.isRealApi('billing');

export const billingService = {
  async overview(_orgId: string): Promise<BillingOverview> {
    if (real) return apiRequest('billing/overview');
    await mockLatency();
    return seedOverview();
  },
  async plans(): Promise<BillingPlan[]> {
    if (real) return apiRequest('billing/plans');
    await mockLatency(120);
    return seedPlans();
  },
  async transactions(_orgId: string): Promise<CreditTxn[]> {
    if (real) {
      const p = await apiRequest<Paginated<CreditTxn>>('billing/transactions?pageSize=100');
      return p.items;
    }
    await mockLatency(150);
    return seedTxns();
  },
};
