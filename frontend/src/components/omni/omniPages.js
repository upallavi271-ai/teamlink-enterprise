// ---------------------------------------------------------------------------
// OMNI-CHANNEL PAGE REGISTRY (pure, no React).
// FOUNDER, 2026-10-17 (latest spec): the Omni-Channel group in the sidebar shows EXACTLY these ten sections and nothing else:
//   Overview · Inbox & Replies · Templates · Campaigns · Promotions · Contacts & Audiences · Automation · Channel Connections · Reports · Settings & Audit Log
// Every screen that used to be its own sidebar entry (the Green Start prototype pages) is now a TAB (a "view") inside the closest section; nothing was
// deleted. A view id is the old page id (the prototype's data-page id), so every old address keeps working: /omni-channel/<old page id> is rewritten to
// /omni-channel/<section>/<view> by resolveRoute() below. The address of a screen is /omni-channel/<section>[/<view>] (the screen's own ?tab=.. is kept).
// WHO sees which view is decided by the server (backend/src/outreach/access.js pagesFor, answer of GET /api/outreach/me `pages`): a view the server does not
// list is never drawn, and a section with no allowed view is not in the sidebar. The server checks every API route again.
// ---------------------------------------------------------------------------
export const PAGES = {
  overview: { label: 'Overview', icon: '⌂', title: 'Overview' },
  inbox: { label: 'Inbox', icon: '▣', title: 'Inbox' },
  review: { label: 'Needs review', icon: '❓', title: 'Replies that need a person to check' },
  tplshared: { label: 'Template library', icon: '▤', title: 'Template library' },
  templates: { label: 'Create & channels', icon: '✎', title: 'Templates' },
  studio: { label: 'Content Studio', icon: '✦', title: 'Content Studio' },
  campaigns: { label: 'Campaigns', icon: '◉', title: 'All Campaigns' },
  appcampaigns: { label: 'From other apps', icon: '⇄', title: 'Campaigns from ATS, Job Portal, HRMS and Accounts' },
  console: { label: 'Send now', icon: '◌', title: 'Communication Console' },
  social: { label: 'Social Media', icon: '✦', title: 'Social Media Management' },
  adsmanager: { label: 'Ads Manager', icon: '◆', title: 'Ads Manager' },
  googlecampaigns: { label: 'Google Campaigns', icon: '◭', title: 'Google Campaigns' },
  googleads: { label: 'Google Ads', icon: '◮', title: 'Google Ads' },
  ganalytics: { label: 'Google Analytics', icon: '◬', title: 'Google Analytics' },
  customers: { label: 'Contacts', icon: '◎', title: 'Customers' },
  segments: { label: 'Audiences', icon: '◍', title: 'Segments' },
  crm: { label: 'Custom fields', icon: '#', title: 'Custom Fields' },
  forms: { label: 'Web forms', icon: '▥', title: 'Forms' },
  automation: { label: 'Automations', icon: '⟳', title: 'Automations' },
  botbuilder: { label: 'Bot builder', icon: '⚡', title: 'Bot Builder' },
  botdata: { label: 'Bot data', icon: '◈', title: 'WhatsApp Bot Data' },
  connections: { label: 'Connection status', icon: '⚯', title: 'Channel Connections and sync health' },
  fbchannel: { label: 'Facebook', icon: '📘', title: 'Facebook' },
  igchannel: { label: 'Instagram', icon: '📸', title: 'Instagram' },
  fbcatalogs: { label: 'Facebook Catalogs', icon: '▨', title: 'Facebook Catalogs' },
  shopify: { label: 'Shopify', icon: '▧', title: 'Shopify' },
  analytics: { label: 'Reports', icon: '⌁', title: 'Analytics & Reports' },
  settings: { label: 'Settings', icon: '⚙', title: 'Settings' },
  team: { label: 'Team & roles', icon: '◔', title: 'Team & Roles' },
  billing: { label: 'Billing', icon: '₹', title: 'Billing' },
  superadmin: { label: 'Super Admin', icon: '◇', title: 'Super Admin' },
  audit: { label: 'Audit log', icon: '☰', title: 'Audit log' },
};
// the ten sections, in the founder's order. `views` = the tabs of the section (first allowed one opens by itself)
export const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: '⌂', views: ['overview'] },
  { id: 'inbox', label: 'Inbox & Replies', icon: '▣', views: ['inbox', 'review'] },
  { id: 'templates', label: 'Templates', icon: '▤', views: ['tplshared', 'templates', 'studio'] },
  { id: 'campaigns', label: 'Campaigns', icon: '◉', views: ['campaigns', 'appcampaigns', 'console'] },
  { id: 'promotions', label: 'Promotions', icon: '✦', views: ['social', 'adsmanager', 'googlecampaigns', 'googleads', 'ganalytics'] },
  { id: 'contacts', label: 'Contacts & Audiences', icon: '◎', views: ['customers', 'segments', 'crm', 'forms'] },
  { id: 'automation', label: 'Automation', icon: '⟳', views: ['automation', 'botbuilder', 'botdata'] },
  { id: 'connections', label: 'Channel Connections', icon: '⚯', views: ['connections', 'fbchannel', 'igchannel', 'fbcatalogs', 'shopify'] },
  { id: 'reports', label: 'Reports', icon: '⌁', views: ['analytics'] },
  { id: 'settings', label: 'Settings & Audit Log', icon: '⚙', views: ['settings', 'team', 'billing', 'superadmin', 'audit'] },
];
export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const ALL_IDS = Object.keys(PAGES);
export const HOME = 'overview';
export const sectionById = (id) => SECTIONS.find((s) => s.id === id) || null;
// which section a view (an old page id) lives in
export const sectionOf = (view) => (SECTIONS.find((s) => s.views.includes(view)) || {}).id || null;
// the address of a section, or of one of its views
// 2026-10-21: the native Omni-Channel pages moved to a hidden address (the sidebar entry /omni-channel now opens the founder's Green Start product).
// Type this address to reach them: /omni-channel-native/overview. One constant, so a switch back is one line (see OMNI_BASE).
export const OMNI_BASE = '/omni-channel-native';
export const sectionPath = (section, view) => `${OMNI_BASE}/${section}${view ? `/${view}` : ''}`;
export const pagePath = (view) => { const s = sectionOf(view); return s ? sectionPath(s, view) : sectionPath(HOME); };

const haveSet = (acc) => new Set((acc && Array.isArray(acc.pages) ? acc.pages : []).filter((p) => PAGES[p]));
// the views this login may open, in sidebar order (all sections)
export function openPages(acc) {
  const have = haveSet(acc);
  return SECTIONS.flatMap((s) => s.views).filter((p) => have.has(p));
}
// the views of ONE section this login may open
export function openViews(acc, section) {
  const have = haveSet(acc);
  const s = sectionById(section);
  return s ? s.views.filter((v) => have.has(v)) : [];
}
export const groupOf = (view) => sectionOf(view);

// the sidebar children of Omni-Channel for the Shell: exactly one leaf per section this login may open (no extra entries, no sub-groups).
// badges = { inboxUnread, approvals } -> the number next to Inbox & Replies and next to Campaigns.
export function sidebarItems(acc, badges = {}) {
  const out = [];
  SECTIONS.forEach((s) => {
    if (!openViews(acc, s.id).length) return;
    const b = s.id === 'inbox' ? badges.inboxUnread : (s.id === 'campaigns' ? badges.approvals : 0);
    out.push({ to: sectionPath(s.id), label: s.label, icon: s.icon, ...(b > 0 ? { badge: b } : {}) });
  });
  return out;
}
export function omniChildren(acc, badges) { return acc && acc.level !== 'none' ? sidebarItems(acc, badges) : []; }

// /omni-channel/<segment>[/<view>] -> { section, view } or null
export function pageOfPath(pathname) {
  const m = /^\/omni-channel-native\/([a-z]+)(?:\/([a-z]+))?(\/|$)/.exec(String(pathname || '')); // = OMNI_BASE
  if (!m) return null;
  if (SECTION_IDS.includes(m[1])) return { section: m[1], view: m[2] && sectionById(m[1]).views.includes(m[2]) ? m[2] : null };
  return PAGES[m[1]] ? { section: sectionOf(m[1]), view: m[1] } : null;
}

// ---- the old five-hub addresses -> the old page id ------------------------------------------------------------------------
const HUB_TO_PAGE = { dashboard: 'overview', communication: 'inbox', campaigns: 'campaigns', insights: 'analytics', configuration: 'settings', inbox: 'inbox' };
const TAB_TO_PAGE = {
  // old Communication tabs
  whatsapp: ['inbox'], sms: ['console', 'sms'], email: ['console', 'email'], calls: ['console', 'call'], conversations: ['inbox', 'all'],
  // old Campaigns tabs
  promotions: ['campaigns'], templates: ['templates'], automations: ['automation'], contacts: ['customers'], audiences: ['segments'], distribution: ['campaigns', 'distribution'],
  messages: ['campaigns'], people: ['customers'], groups: ['segments'], imports: ['customers', 'imports'], scheduled: ['automation', 'scheduled'],
  // old Insights tabs
  performance: ['analytics', 'performance'], credits: ['billing'], roi: ['analytics', 'roi'], reports: ['analytics', 'reports'],
  // old Configuration tabs
  meta: ['settings', 'whatsapp'], channels: ['settings', 'channels'], departments: ['settings', 'departments'], permissions: ['team'], settings: ['settings'],
};
const MODE_TAB_TO_PAGE = {
  promo: { overview: ['overview'], campaigns: ['campaigns'], contacts: ['customers'], audiences: ['segments'], templates: ['templates'], inbox: ['inbox'], distribution: ['campaigns', 'distribution'], reports: ['analytics', 'reports'], activity: ['analytics', 'mine'] },
  internal: { overview: ['overview'], people: ['customers'], groups: ['segments'], imports: ['customers', 'imports'], messages: ['campaigns'], templates: ['templates'], inbox: ['inbox'], scheduled: ['automation', 'scheduled'], activity: ['analytics', 'mine'] },
  settings: { channels: ['settings', 'channels'], sender: ['settings', 'sender'], rules: ['settings', 'rules'], consent: ['settings', 'consent'], roles: ['team'], credits: ['billing'], connections: ['connections'] },
};
// path segment (the old :hub, an old page id or a section id), the query -> { page, tab } or null when the address is already a current section / view address
export function legacyPage(segment, search) {
  const sp = new URLSearchParams(search || '');
  const tab = sp.get('tab'); const mode = sp.get('mode');
  if (segment && (PAGES[segment] || SECTION_IDS.includes(segment)) && !(segment === 'campaigns' && tab && TAB_TO_PAGE[tab] && TAB_TO_PAGE[tab][0] !== 'campaigns')) return null; // a current address
  if (mode && MODE_TAB_TO_PAGE[mode]) { const hit = MODE_TAB_TO_PAGE[mode][tab] || Object.values(MODE_TAB_TO_PAGE[mode])[0]; return { page: hit[0], tab: hit[1] || null }; }
  if (tab && TAB_TO_PAGE[tab] && (!segment || segment === 'communication' || segment === 'campaigns' || segment === 'insights' || segment === 'configuration' || segment === 'dashboard')) { const hit = TAB_TO_PAGE[tab]; return { page: hit[0], tab: hit[1] || null }; }
  if (segment && HUB_TO_PAGE[segment]) return { page: HUB_TO_PAGE[segment], tab: null };
  return { page: HOME, tab: null };
}

// ONE function decides what to show for an address.
//   acc     the /outreach/me answer          segment, view   the two address parts          search   the query string
// -> { section, view, redirect: path | null, none: true when this login has nothing here }
export function resolveRoute(acc, segment, view, search = '') {
  const have = haveSet(acc);
  const firstSection = SECTIONS.find((s) => s.views.some((v) => have.has(v)));
  if (!firstSection) return { none: true, section: null, view: null, redirect: null };
  const fallback = () => { const s = SECTIONS.find((x) => x.id === HOME && x.views.some((v) => have.has(v))) || firstSection; return { section: s.id, view: s.views.find((v) => have.has(v)), redirect: sectionPath(s.id, s.views.find((v) => have.has(v))) }; };
  const q = (extra) => { const sp = new URLSearchParams(search || ''); if (extra) sp.set('tab', extra); const t = sp.toString(); return t ? `?${t}` : ''; };
  let section; let want; let tab = null;
  if (segment && SECTION_IDS.includes(segment)) {
    section = segment;
    // an old bare address of a screen that is now a tab (for example /omni-channel/templates?channel=sms&create=1) opens that tab
    const sp = new URLSearchParams(search || '');
    want = view || (segment === 'templates' && (sp.get('channel') || sp.get('create')) ? 'templates' : null);
    if (view && !sectionById(section).views.includes(view)) want = null;
    const legacy = !view ? legacyPage(segment, search) : null;
    if (legacy) { const s = sectionOf(legacy.page); if (s) { section = s; want = legacy.page; tab = legacy.tab; } }
  } else {
    const leg = legacyPage(segment, search);
    const page = leg ? leg.page : segment;
    if (leg) tab = leg.tab;
    section = sectionOf(page);
    want = page;
    if (!section) return fallback();
  }
  const views = sectionById(section).views.filter((v) => have.has(v));
  if (!views.length) return fallback();
  const shown = want && views.includes(want) ? want : views[0];
  const canonical = `${sectionPath(section, shown)}${q(tab)}`;
  const here = `${segment ? sectionPath(segment, view) : ''}${q()}`;
  // redirect when the address is not the canonical one of what will be shown (an old page id, an old hub address, a forbidden or unknown view)
  const needsMove = !(segment === section && view === shown) && !(segment === section && !view && shown === views[0] && !tab);
  return { section, view: shown, redirect: needsMove && canonical !== here ? canonical : null };
}
// the view to show for this login: the wanted one when it may open it, else the first it may
export function resolvePage(acc, want) {
  const open = openPages(acc);
  if (!open.length) return null;
  return open.includes(want) ? want : (open.includes(HOME) ? HOME : open[0]);
}

export const STORE_KEY = 'tl_omni_dept';
