import { useQuery } from '@tanstack/react-query';
import { dashboardService } from '@/services/dashboard/dashboard.service';
import { useOrgStore } from '@/stores/orgStore';
import type { DateRangeParams } from '@/types';

export function useDashboard(range: DateRangeParams = {}) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  return useQuery({
    queryKey: ['dashboard', orgId, range],
    queryFn: () => dashboardService.overview(orgId, range),
    enabled: !!orgId,
  });
}
