import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { AppLayout } from './layouts/AppLayout';
import { LoginPage } from '@/features/auth/LoginPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { CustomersPage } from '@/features/crm/customers/CustomersPage';
import { CrmFieldsPage } from '@/features/crm/fields/CrmFieldsPage';
import { SegmentsPage } from '@/features/crm/segments/SegmentsPage';
import { CampaignsPage } from '@/features/campaigns/CampaignsPage';
import { TemplatesPage } from '@/features/templates/TemplatesPage';
import { TeamPage } from '@/features/team/TeamPage';
import { InboxPage } from '@/features/inbox/InboxPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { WebFormsPage } from '@/features/crm/webforms/WebFormsPage';
import { BotDataPage } from '@/features/crm/botdata/BotDataPage';
import { AdsManagerPage } from '@/features/ads/AdsManagerPage';
import { OrganizationsPage } from '@/features/organizations/OrganizationsPage';
import { FacebookInboxPage } from '@/features/facebook/FacebookInboxPage';
import { InstagramInboxPage } from '@/features/instagram/InstagramInboxPage';
import { BillingPage } from '@/features/billing/BillingPage';
import { AutomationsPage } from '@/features/automation/AutomationsPage';
import { AuditLogPage } from '@/features/audit/AuditLogPage';
import { SuperAdminPage } from '@/features/super-admin/SuperAdminPage';
import { SocialPage } from '@/features/social/SocialPage';
import { ContentStudioPage } from '@/features/content/ContentStudioPage';
import { ConsolePage } from '@/features/communication/ConsolePage';
import { SiteAuditPage } from '@/features/seo/SiteAuditPage';
import { SearchConsolePage } from '@/features/seo/SearchConsolePage';
import { KeywordsPage } from '@/features/seo/KeywordsPage';
import { ContentIdeasPage } from '@/features/seo/ContentIdeasPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { OAuthCallbackPage } from '@/features/settings/OAuthCallbackPage';
import { PlaceholderPage } from '@/features/misc/PlaceholderPage';
import { NotFoundPage } from '@/features/misc/NotFoundPage';
import { NAV_ITEMS } from './navigation';

// Real pages (built). Every other nav item falls through to an honest placeholder.
const REAL_PAGES: Record<string, JSX.Element> = {
  overview: <DashboardPage />,
  console: <ConsolePage />,
  customers: <CustomersPage />,
  crm: <CrmFieldsPage />,
  segments: <SegmentsPage />,
  campaigns: <CampaignsPage />,
  templates: <TemplatesPage />,
  team: <TeamPage />,
  inbox: <InboxPage />,
  analytics: <AnalyticsPage />,
  forms: <WebFormsPage />,
  botdata: <BotDataPage />,
  adsmanager: <AdsManagerPage />,
  fbchannel: <FacebookInboxPage />,
  igchannel: <InstagramInboxPage />,
  billing: <BillingPage />,
  automation: <AutomationsPage />,
  audit: <AuditLogPage />,
  superadmin: <SuperAdminPage />,
  social: <SocialPage />,
  studio: <ContentStudioPage />,
  seoaudit: <SiteAuditPage />,
  seoconsole: <SearchConsolePage />,
  seokeywords: <KeywordsPage />,
  seocontent: <ContentIdeasPage />,
};

const moduleRoutes = NAV_ITEMS.map((item) => ({
  path: item.path.replace(/^\/app\//, ''),
  element: REAL_PAGES[item.id] ?? <PlaceholderPage title={item.label} />,
}));

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/app/dashboard" replace /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/app',
    element: <ProtectedRoute />,
    children: [
      // Outside AppLayout on purpose: the tenant picker is reached precisely when
      // no workspace has been chosen yet, so it carries no sidebar.
      { path: 'organizations', element: <OrganizationsPage /> },
      { element: <AppLayout />, children: [
        { index: true, element: <Navigate to="/app/dashboard" replace /> },
        ...moduleRoutes,
        // Old URLs from before the sidebar matched WhiteStart — keep bookmarks working.
        { path: 'automation', element: <Navigate to="/app/workflows" replace /> },
        { path: 'content-studio', element: <Navigate to="/app/content-library" replace /> },
        { path: 'billing', element: <Navigate to="/app/credits" replace /> },
        { path: 'team', element: <Navigate to="/app/roles" replace /> },
        { path: 'settings', element: <SettingsPage /> },
        { path: 'settings/oauth/:provider', element: <OAuthCallbackPage /> },
      ] },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
], {
  // Served inside TeamLink.Enterprise at /omnichannel/ (vite --base). BASE_URL is
  // '/' in a standalone build, so running it on its own is unchanged.
  basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
});
