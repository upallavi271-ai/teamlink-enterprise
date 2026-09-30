/**
 * SINGLE SOURCE OF TRUTH for sidebar + routes. The sidebar renders from this,
 * and the router generates routes from it, so the two can never drift.
 *
 * Groups, labels and order match the WhiteStart sidebar 1:1 (screen record,
 * 2026-09-17), plus the SEO group Vasu asked for (not in WhiteStart). `real: true` marks a module with a built page; the rest render
 * an honest placeholder. `hidden: true` keeps a built page routable (deep links
 * from other modules still work) without showing it in the sidebar.
 */
export interface NavItem {
  id: string;         // stable id (matches the prototype's data-page)
  label: string;
  path: string;       // addressable URL
  icon: string;       // lucide-react icon name
  real?: boolean;
  hidden?: boolean;
  badge?: string;
}
export interface NavGroup { title?: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { items: [
    { id: 'overview', label: 'Dashboard', path: '/app/dashboard', icon: 'LayoutDashboard', real: true },
    { id: 'shopify', label: 'Shopify', path: '/app/shopify', icon: 'ShoppingBag' },
  ] },
  { title: 'Channels', items: [
    { id: 'inbox', label: 'WhatsApp', path: '/app/inbox', icon: 'MessagesSquare', real: true },
    { id: 'fbchannel', label: 'Facebook', path: '/app/facebook', icon: 'Facebook' },
    { id: 'igchannel', label: 'Instagram', path: '/app/instagram', icon: 'Instagram', real: true },
  ] },
  { title: 'Campaign center', items: [
    { id: 'console', label: 'Communication', path: '/app/communication', icon: 'Send', real: true },
    { id: 'campaigns', label: 'Campaigns', path: '/app/campaigns', icon: 'Megaphone', real: true },
    { id: 'social', label: 'Social Media', path: '/app/social', icon: 'Share2', real: true },
    { id: 'analytics', label: 'Analytics', path: '/app/analytics', icon: 'LineChart', real: true },
    { id: 'templates', label: 'Manage Templates', path: '/app/templates', icon: 'LayoutTemplate', real: true },
  ] },
  { title: 'CRM', items: [
    { id: 'crm', label: 'CRM Fields', path: '/app/crm/fields', icon: 'Tags', real: true },
    { id: 'customers', label: 'All Customers', path: '/app/crm/customers', icon: 'Users', real: true },
    { id: 'botdata', label: 'WhatsApp Bot Data', path: '/app/crm/bot-data', icon: 'Bot', real: true },
    { id: 'forms', label: 'Web Forms', path: '/app/crm/web-forms', icon: 'FileInput', real: true },
  ] },
  { title: 'Ads & Campaigns', items: [
    { id: 'adsmanager', label: 'Ads Manager', path: '/app/ads', icon: 'Target' },
    { id: 'googlecampaigns', label: 'Google Campaigns', path: '/app/google-campaigns', icon: 'Chrome' },
    { id: 'googleads', label: 'Google Ads', path: '/app/google-ads', icon: 'BadgeDollarSign' },
    { id: 'ganalytics', label: 'Google Analytics', path: '/app/google-analytics', icon: 'Activity' },
  ] },
  { title: 'SEO', items: [
    { id: 'seoaudit', label: 'Site Audit', path: '/app/seo/audit', icon: 'ScanSearch', real: true },
    { id: 'seokeywords', label: 'Keywords', path: '/app/seo/keywords', icon: 'KeyRound', real: true },
    { id: 'seoconsole', label: 'Search Console', path: '/app/seo/search-console', icon: 'Globe', real: true },
    { id: 'seocontent', label: 'Content Ideas', path: '/app/seo/content', icon: 'Lightbulb', real: true },
  ] },
  { title: 'Automation', items: [
    { id: 'botbuilder', label: 'Bot Builder', path: '/app/bot-builder', icon: 'Cpu' },
    { id: 'automation', label: 'Workflows', path: '/app/workflows', icon: 'Workflow', real: true },
    { id: 'keywords', label: 'Keyword Triggers', path: '/app/keyword-triggers', icon: 'Zap' },
  ] },
  { title: 'Tools', items: [
    { id: 'waflows', label: 'WhatsApp Flows', path: '/app/whatsapp-flows', icon: 'GitBranch' },
    { id: 'studio', label: 'Content Library', path: '/app/content-library', icon: 'FolderOpen', real: true },
    { id: 'aicontent', label: 'AI Content', path: '/app/ai-content', icon: 'Sparkles' },
  ] },
  { title: 'Admin', items: [
    { id: 'billing', label: 'Credits', path: '/app/credits', icon: 'Coins', real: true },
    { id: 'team', label: 'Roles & Permissions', path: '/app/roles', icon: 'ShieldCheck', real: true },
  ] },
  // Built pages that WhiteStart does not list in its sidebar. Still routable.
  { items: [
    { id: 'segments', label: 'Segments', path: '/app/crm/segments', icon: 'Filter', real: true, hidden: true },
    { id: 'audit', label: 'Audit Log', path: '/app/audit', icon: 'ScrollText', real: true, hidden: true },
    { id: 'superadmin', label: 'Super Admin', path: '/app/super-admin', icon: 'ShieldCheck', real: true, hidden: true },
  ] },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
/** What the sidebar draws — groups with at least one visible item. */
export const SIDEBAR_NAV: NavGroup[] = NAV
  .map((g) => ({ ...g, items: g.items.filter((i) => !i.hidden) }))
  .filter((g) => g.items.length > 0);
