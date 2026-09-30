/** Tenant context: the workspaces the user belongs to + the current one. */
import { create } from 'zustand';
import type { Workspace } from '@/types';

const WS_KEY = 'gs.workspaceId';
const readWs = () => { try { return localStorage.getItem(WS_KEY); } catch { return null; } };
const writeWs = (id: string | null) => {
  try { id ? localStorage.setItem(WS_KEY, id) : localStorage.removeItem(WS_KEY); } catch { /* ignore */ }
};

interface OrgState {
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  setWorkspaces: (ws: Workspace[]) => void;
  switchWorkspace: (id: string) => void;
  clear: () => void;
}

export const useOrgStore = create<OrgState>((set, get) => ({
  workspaces: [],
  currentWorkspaceId: readWs(),
  setWorkspaces: (ws) => {
    const saved = readWs();
    const current = ws.find((w) => w.id === saved)?.id ?? ws[0]?.id ?? null;
    writeWs(current);
    set({ workspaces: ws, currentWorkspaceId: current });
  },
  switchWorkspace: (id) => {
    // A workspace that is not in the list yet (an organization created a moment
    // ago) is still remembered, so the full reload that follows a switch lands
    // in it. setWorkspaces() re-validates the id against the server's list on
    // that reload and falls back to the first workspace if it is not one of ours.
    writeWs(id);
    if (!get().workspaces.some((w) => w.id === id)) return;
    set({ currentWorkspaceId: id });
  },
  clear: () => { writeWs(null); set({ workspaces: [], currentWorkspaceId: null }); },
}));

export const useCurrentWorkspace = () => {
  const { workspaces, currentWorkspaceId } = useOrgStore();
  return workspaces.find((w) => w.id === currentWorkspaceId) ?? null;
};
