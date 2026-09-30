/**
 * The one TanStack Query cache for the app.
 *
 * It lives in its own module (rather than inside providers.tsx) so code outside
 * React — the auth store's signOut — can empty it. The cache holds server data
 * for whichever user and workspace were active when it was filled; when either
 * changes, what is in it belongs to someone else and must not be shown.
 */
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/services/apiClient';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => {
        // Never retry 4xx; retry transient errors twice.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return count < 2;
      },
    },
  },
});

/** Drop every cached query and in-flight mutation — used on sign-out and on a tenant switch. */
export function clearServerCache(): void {
  queryClient.cancelQueries().catch(() => undefined);
  queryClient.clear();
}
