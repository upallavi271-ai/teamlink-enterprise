// A tiny shared store for the Omni-Channel chrome (the top bar chips sit in the Shell, outside the page, so they share state through this):
//   dept       the workspace (department) picked in the switcher ('' = all the login may see). Remembered in localStorage (always in try / catch).
//   wallet     the credits pill (GET /api/outreach/wallet)       workspaces  the switcher list (GET /api/outreach/workspaces)
//   badges     the sidebar numbers (GET /api/outreach/badges)
import { useSyncExternalStore } from 'react';
import api from '../../api';
import { STORE_KEY } from './omniPages.js';

const read = () => { try { return window.localStorage.getItem(STORE_KEY) || ''; } catch { return ''; } };
let state = { dept: read(), wallet: null, workspaces: null, badges: { inboxUnread: 0, approvals: 0, review: 0 }, uid: null };
const subs = new Set();
const emit = () => { subs.forEach((f) => f()); };
export const getState = () => state;
export const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
export const useOmniStore = () => useSyncExternalStore(subscribe, getState, getState);
export function set(patch) { state = { ...state, ...patch }; emit(); }

export function setDept(name) {
  const d = String(name || '');
  try { if (d) window.localStorage.setItem(STORE_KEY, d); else window.localStorage.removeItem(STORE_KEY); } catch { /* a blocked store is fine */ }
  set({ dept: d });
}
export async function refreshWallet() { try { set({ wallet: (await api.get('/outreach/wallet')).data }); } catch { /* keep the last */ } }
export async function refreshBadges() { try { set({ badges: (await api.get('/outreach/badges')).data }); } catch { /* keep the last */ } }
export async function refreshWorkspaces() {
  try {
    const w = (await api.get('/outreach/workspaces')).data;
    // a remembered department this login may no longer see falls back to "all"
    if (state.dept && !w.list.some((x) => x.name.toLowerCase() === state.dept.toLowerCase())) setDept('');
    set({ workspaces: w });
  } catch { /* keep the last */ }
}
let started = null;
// start (once per login) the numbers for the top bar and the sidebar; polls the small ones every minute
export function startChrome(uid) {
  if (started === uid) return;
  started = uid;
  set({ uid });
  refreshWallet(); refreshBadges(); refreshWorkspaces();
}
let timer = null;
export function pollBadges(on) {
  if (on && !timer) { timer = setInterval(() => { refreshBadges(); refreshWallet(); }, 60000); } else if (!on && timer) { clearInterval(timer); timer = null; }
}
