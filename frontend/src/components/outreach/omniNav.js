// ---------------------------------------------------------------------------
// OMNI-CHANNEL NAVIGATION (pure, no React). Five hubs on top, sub-tabs under the open hub (founder structure plan, 2026-10-17):
//   Dashboard      one role-based summary
//   Communication  Inbox, WhatsApp, SMS, Email, Calls, Conversations
//   Campaigns      Campaigns, Promotions, Templates, Automations (+ Contacts, Audiences, Distribution; for the staff side People, Groups, Imports, Scheduled)
//   Insights       Performance, Credits, ROI, Reports (each only when the login may open it)
//   Configuration  Meta WhatsApp, Channels, Departments, Permissions, Settings (Admins only: the tab is not drawn for anybody else)
// The server (outreach/access.js hubsFor) decides which hubs and Insights tabs a login has: `acc.hubs`. LINKS: ?hub=<id>&tab=<id>[&aud=internal].
// OLD LINKS (?mode=promo|internal|settings&tab=<old id>, or only ?tab=<old id>) are still understood and sent to their new place (LEGACY below).
// MEMORY: the last hub is kept in localStorage 'tl_omni_hub' (always inside try / catch).
// ---------------------------------------------------------------------------
export const HUB_KEY = 'tl_omni_hub';
export const HUBS = {
  dashboard: { label: 'Dashboard', sub: 'Your numbers for today and this month.', home: 'overview' },
  communication: { label: 'Communication', sub: 'Engagement Hub: all messages, replies and calls in one place.', home: 'inbox' },
  campaigns: { label: 'Campaigns', sub: 'Campaign Hub: campaigns, promotions, templates and automatic follow-ups.', home: 'campaigns' },
  insights: { label: 'Insights', sub: 'Analytics Hub: performance, credits, ROI and reports.', home: 'performance' },
  configuration: { label: 'Configuration', sub: 'Configuration Hub: WhatsApp account, channels, departments, permissions and settings (Admins only).', home: 'meta' },
};
export const HUB_ORDER = ['dashboard', 'communication', 'campaigns', 'insights', 'configuration'];
const INSIGHT_WORDS = { performance: 'Performance', credits: 'Credits', roi: 'ROI', reports: 'Reports' };
const INSIGHT_ORDER = ['performance', 'credits', 'roi', 'reports'];
export const CHANNEL_OF = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', calls: 'Call' };

// the staff side (HR) and the job side are two flavours of the Campaigns hub; an Admin may switch between them
export function audChoices(acc) {
  const out = [];
  if (acc && acc.canPromo) out.push(['promo', 'Requirement and candidate messages']);
  if (acc && acc.canInternal) out.push(['internal', 'Staff messages (internal)']);
  return out;
}
export function pickAud(acc, want) {
  const ch = audChoices(acc).map((c) => c[0]);
  if (want && ch.includes(want)) return want;
  return ch[0] || 'promo';
}

// [id, label] list of the open hub for this login
export function subTabs(acc, hub, aud = 'promo') {
  const h = (acc && acc.hubs) || {};
  if (hub === 'dashboard') return h.dashboard ? [['overview', 'Dashboard']] : [];
  if (hub === 'communication') return h.communication ? [['inbox', 'Inbox'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email'], ['calls', 'Calls'], ['conversations', 'Conversations']] : [];
  if (hub === 'campaigns') {
    if (!h.campaigns) return [];
    if (aud === 'internal') return [['messages', 'Messages'], ['templates', 'Templates'], ['automations', 'Automations'], ['people', 'People'], ['groups', 'Groups'], ['imports', 'Imports'], ['scheduled', 'Scheduled messages']];
    const t = [['campaigns', 'Campaigns'], ['promotions', 'Promotions'], ['templates', 'Templates'], ['automations', 'Automations']];
    if (!acc.marketing || acc.kind !== 'marketing') t.push(['contacts', 'Contacts'], ['audiences', 'Audiences']);
    if (acc.seesDistribution !== false && acc.kind !== 'marketing') t.push(['distribution', 'Distribution']);
    return t;
  }
  if (hub === 'insights') return INSIGHT_ORDER.filter((i) => (h.insights || []).includes(i)).map((i) => [i, INSIGHT_WORDS[i]]);
  if (hub === 'configuration') return h.configuration ? [['meta', 'Meta WhatsApp'], ['channels', 'Channels'], ['departments', 'Departments'], ['permissions', 'Permissions'], ['settings', 'Settings']] : [];
  return [];
}

// old (mode, tab) and old plain tab -> [hub, tab, aud]
const LEGACY_MODE = {
  promo: { overview: ['dashboard', 'overview'], campaigns: ['campaigns', 'campaigns'], contacts: ['campaigns', 'contacts'], audiences: ['campaigns', 'audiences'], templates: ['campaigns', 'templates'], inbox: ['communication', 'inbox'], distribution: ['campaigns', 'distribution'], reports: ['insights', 'reports'], activity: ['insights', 'performance'] },
  internal: { overview: ['dashboard', 'overview'], people: ['campaigns', 'people', 'internal'], groups: ['campaigns', 'groups', 'internal'], imports: ['campaigns', 'imports', 'internal'], messages: ['campaigns', 'messages', 'internal'], templates: ['campaigns', 'templates', 'internal'], inbox: ['communication', 'inbox'], scheduled: ['campaigns', 'scheduled', 'internal'], activity: ['insights', 'performance'] },
  settings: { channels: ['configuration', 'channels'], sender: ['configuration', 'settings'], rules: ['configuration', 'settings'], consent: ['configuration', 'settings'], roles: ['configuration', 'permissions'], credits: ['configuration', 'permissions'], connections: ['configuration', 'channels'] },
};
const LEGACY_TAB = { campaigns: ['campaigns', 'campaigns'], contacts: ['campaigns', 'contacts'], templates: ['campaigns', 'templates'], inbox: ['communication', 'inbox'], reports: ['insights', 'reports'], internal: ['campaigns', 'people', 'internal'], channels: ['configuration', 'channels'] };
export function legacyTarget(mode, tab) {
  if (mode && LEGACY_MODE[mode] && tab && LEGACY_MODE[mode][tab]) return LEGACY_MODE[mode][tab];
  if (mode && LEGACY_MODE[mode] && !tab) { const first = Object.values(LEGACY_MODE[mode])[0]; return first; }
  if (!mode && tab && LEGACY_TAB[tab]) return LEGACY_TAB[tab];
  return null;
}

// the hubs this login may open, in the founder's order (the sidebar children and the page use this one rule)
export function openHubs(acc) {
  const h = (acc && acc.hubs) || {};
  return HUB_ORDER.filter((id) => (id === 'insights' ? (h.insights || []).length > 0 : !!h[id]));
}
// acc: the /outreach/me answer. want: { hub, tab, mode, aud } from the URL. stored: the remembered hub (or null).
// -> { hubs: [ids to draw], hub, tab, subs, aud, audChoices } or { none: true }
export function resolveNav(acc, want = {}, stored = null) {
  const open = openHubs(acc);
  if (!open.length) return { none: true, hubs: [], hub: null, tab: null, subs: [], aud: 'promo', audChoices: [] };
  let { hub, tab, aud } = want;
  if (!hub) {
    const old = legacyTarget(want.mode, want.tab);
    if (old) { [hub, tab] = old; aud = aud || old[2]; }
  }
  if (!hub || !open.includes(hub)) hub = stored && open.includes(stored) ? stored : open[0];
  const a = pickAud(acc, hub === 'campaigns' || hub === 'communication' ? aud : aud);
  const subs = subTabs(acc, hub, a);
  if (!subs.some((t) => t[0] === tab)) tab = HUBS[hub].home;
  if (!subs.some((t) => t[0] === tab)) tab = subs[0] ? subs[0][0] : null;
  // an old staff link on a login that has no staff side (or the reverse) falls back to what it has
  return { hubs: open, hub, tab, subs, aud: a, audChoices: audChoices(acc) };
}
export function readStored() { try { return window.localStorage.getItem(HUB_KEY); } catch { return null; } }
export function writeStored(hub) { try { window.localStorage.setItem(HUB_KEY, hub); } catch { /* a blocked store is fine */ } }
