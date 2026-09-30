/** Wire the HTTP layer to the stores once at startup (token, workspace, 401). */
import { configureApiClient } from '@/services/apiClient';
import { useAuthStore } from '@/stores/authStore';
import { useOrgStore } from '@/stores/orgStore';

export function initApiClient() {
  configureApiClient({
    getToken: () => useAuthStore.getState().token,
    getWorkspaceId: () => useOrgStore.getState().currentWorkspaceId,
    onUnauthorized: () => {
      useAuthStore.getState().signOut();
      useOrgStore.getState().clear();
    },
    onTokenRefreshed: (token) => useAuthStore.getState().setToken(token),
  });
}
