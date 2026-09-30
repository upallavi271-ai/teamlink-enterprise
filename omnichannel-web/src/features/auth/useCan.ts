/** RBAC gate/seam. Mirrors the backend permission keys for UX gating only —
 *  the API is always authoritative. In mock mode the demo owner has all keys. */
import { useAuthStore } from '@/stores/authStore';

export function usePermissions(): string[] {
  return useAuthStore((s) => s.permissions);
}
export function useCan(permission: string): boolean {
  const perms = usePermissions();
  return perms.includes(permission);
}
