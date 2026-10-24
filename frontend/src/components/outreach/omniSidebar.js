// ---------------------------------------------------------------------------
// OMNI-CHANNEL IN THE SIDEBAR (founder, 2026-10-17): the single "Omni-Channel" entry is an expandable group like ATS. Its CHILDREN are the hubs
// the login may open: Dashboard, Communication, Campaigns, Insights, Configuration. Pure functions (no React) so the rule can be tested:
//   omniChildren(acc)   acc = the GET /api/outreach/me answer -> [{ id, label, to, icon }]   (empty = no Omni-Channel group at all)
//   hubOfPath(pathname) /omni-channel/<hub>  ->  hub id, or null
// The server decides who has which hub (outreach/access.js hubsFor); Configuration is Admin / Super Admin only, Finance gets Insights only.
// ---------------------------------------------------------------------------
import { HUBS, openHubs } from './omniNav.js';

export const HUB_ICON = { dashboard: '📊', communication: '💬', campaigns: '📣', insights: '📈', configuration: '⚙️' };
export const hubPath = (hub) => `/omni-channel-native/${hub}`;

export function omniChildren(acc) {
  if (!acc || acc.level === 'none') return [];
  return openHubs(acc).map((id) => ({ id, label: HUBS[id].label, to: hubPath(id), icon: HUB_ICON[id] }));
}
export function hubOfPath(pathname) {
  const m = /^\/omni-channel-native\/([a-z]+)(\/|$)/.exec(String(pathname || ''));
  return m && HUBS[m[1]] ? m[1] : null;
}
