import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customersService } from '@/services/crm/customers.service';
import { agentsService } from '@/services/crm/agents.service';
import { useOrgStore } from '@/stores/orgStore';
import type { CustomerInput, ListParams } from '@/types';

export function useCustomers(params: ListParams) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  return useQuery({ queryKey: ['customers', orgId, params], queryFn: () => customersService.list(orgId, params), enabled: !!orgId });
}
export function useAgents() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  return useQuery({ queryKey: ['agents', orgId], queryFn: () => agentsService.list(orgId), enabled: !!orgId });
}
export function useCustomerMutations() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['customers', orgId] });
  return {
    create: useMutation({ mutationFn: (input: CustomerInput) => customersService.create(orgId, input), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<CustomerInput> }) => customersService.update(orgId, id, patch), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (id: string) => customersService.remove(orgId, id), onSuccess: invalidate }),
    removeMany: useMutation({ mutationFn: (ids: string[]) => customersService.removeMany(orgId, ids), onSuccess: invalidate }),
  };
}
