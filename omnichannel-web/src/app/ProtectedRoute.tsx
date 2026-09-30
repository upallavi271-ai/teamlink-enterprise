import { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useOrgStore } from '@/stores/orgStore';
import { authService } from '@/services/auth/auth.service';
import { config } from '@/services/config';
import { LoadingState } from '@/components/feedback/states';

/**
 * In mock mode the demo user is auto-signed-in so the shell is browsable.
 * In real-auth mode, a persisted token is re-hydrated via /auth/me on load.
 */
export function ProtectedRoute() {
  const { isAuthenticated, token, setSession } = useAuthStore();
  const setWorkspaces = useOrgStore((s) => s.setWorkspaces);
  const [hydrating, setHydrating] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      if (isAuthenticated) { setHydrating(false); return; }
      // Auto-auth demo user in mock mode; re-hydrate persisted session in real mode.
      if (!config.realAuth || token) {
        try {
          const ctx = await authService.me();
          if (!active) return;
          setWorkspaces(ctx.workspaces);
          // Read the token at WRITE time, not from this effect's closure. The
          // effect has an empty dep array, so `token` above is whatever was in
          // localStorage on first render. If `me()` 401'd, apiClient silently
          // refreshed and `setToken` already persisted a new access token —
          // writing the captured one back here would overwrite the live token
          // with the expired one. The app keeps working (every call refreshes
          // and retries) while localStorage hands out a dead token.
          const current = useAuthStore.getState().token;
          setSession({
            user: ctx.user,
            token: current ?? token ?? 'mock-token',
            permissions: ctx.permissions,
          });
        } catch { /* fall through to login */ }
      }
      if (active) setHydrating(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (hydrating) return <div className="flex min-h-screen items-center justify-center"><LoadingState label="Starting Green Start…" /></div>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}
