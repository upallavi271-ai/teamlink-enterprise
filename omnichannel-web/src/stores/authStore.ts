/** Session client-state: user, token, permissions. Holds no server data. */
import { create } from 'zustand';
import type { User } from '@/types';
import { clearServerCache } from '@/app/queryClient';

const TOKEN_KEY = 'gs.token';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const writeToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
};

export interface Session { user: User; token: string; permissions: string[] }

interface AuthState {
  user: User | null;
  token: string | null;
  permissions: string[];
  isAuthenticated: boolean;
  setSession: (s: Session) => void;
  setPermissions: (permissions: string[]) => void;
  /** Swap in a rotated access token without touching user/permissions. */
  setToken: (token: string) => void;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: readToken(),
  permissions: [],
  isAuthenticated: false,
  setSession: (s) => {
    writeToken(s.token);
    set({ user: s.user, token: s.token, permissions: s.permissions, isAuthenticated: true });
  },
  setPermissions: (permissions) => set({ permissions }),
  setToken: (token) => { writeToken(token); set({ token }); },
  signOut: () => {
    writeToken(null);
    // Cached queries belong to the user who is leaving. Without this, the next
    // person to sign in on this tab is shown the previous user's organizations,
    // members and permissions until each query happens to refetch.
    clearServerCache();
    set({ user: null, token: null, permissions: [], isAuthenticated: false });
  },
}));
