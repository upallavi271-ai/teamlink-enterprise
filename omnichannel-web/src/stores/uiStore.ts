/** UI client-state: sidebar collapse (desktop) + mobile drawer open. */
import { create } from 'zustand';

interface UiState {
  sidebarCompact: boolean;
  mobileNavOpen: boolean;
  toggleSidebar: () => void;
  setMobileNav: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCompact: false,
  mobileNavOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarCompact: !s.sidebarCompact })),
  setMobileNav: (open) => set({ mobileNavOpen: open }),
}));
