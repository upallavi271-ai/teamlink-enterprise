import type { DashboardOverview, DateRangeParams } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { MOCK_DASHBOARD } from '@/mocks/dashboard.mock';

// One-line mock<->real switch; identical signature both ways.
export const dashboardService = {
  async overview(_orgId: string, range: DateRangeParams = {}): Promise<DashboardOverview> {
    if (!config.isRealApi('dashboard')) {
      await mockLatency();
      return MOCK_DASHBOARD;
    }
    return apiRequest<DashboardOverview>(`dashboard/overview${toQuery({ filters: { from: range.from, to: range.to } })}`);
  },
};
