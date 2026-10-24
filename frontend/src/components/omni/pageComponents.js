// view id -> the lazily loaded component (one file per view in ./pages; a view is a TAB of one of the ten sections, see omniPages.js SECTIONS). Each page default-exports a component that takes no props and reads
// everything from useOmni() (omniContext.js). Add a page here only if it is also in omniPages.js.
import { lazy } from 'react';

export const PAGE_COMPONENTS = {
  overview: lazy(() => import('./pages/OverviewPage.jsx')),
  fbcatalogs: lazy(() => import('./pages/FbCatalogsPage.jsx')),
  shopify: lazy(() => import('./pages/ShopifyPage.jsx')),
  inbox: lazy(() => import('./pages/InboxPage.jsx')),
  fbchannel: lazy(() => import('./pages/FbChannelPage.jsx')),
  igchannel: lazy(() => import('./pages/IgChannelPage.jsx')),
  console: lazy(() => import('./pages/ConsolePage.jsx')),
  campaigns: lazy(() => import('./pages/CampaignsPage.jsx')),
  social: lazy(() => import('./pages/SocialPage.jsx')),
  analytics: lazy(() => import('./pages/AnalyticsPage.jsx')),
  templates: lazy(() => import('./pages/TemplatesPage.jsx')),
  studio: lazy(() => import('./pages/StudioPage.jsx')),
  crm: lazy(() => import('./pages/CrmFieldsPage.jsx')),
  customers: lazy(() => import('./pages/CustomersPage.jsx')),
  segments: lazy(() => import('./pages/SegmentsPage.jsx')),
  botdata: lazy(() => import('./pages/BotDataPage.jsx')),
  forms: lazy(() => import('./pages/FormsPage.jsx')),
  adsmanager: lazy(() => import('./pages/AdsManagerPage.jsx')),
  googlecampaigns: lazy(() => import('./pages/GoogleCampaignsPage.jsx')),
  googleads: lazy(() => import('./pages/GoogleAdsPage.jsx')),
  ganalytics: lazy(() => import('./pages/GoogleAnalyticsPage.jsx')),
  automation: lazy(() => import('./pages/AutomationsPage.jsx')),
  botbuilder: lazy(() => import('./pages/BotBuilderPage.jsx')),
  team: lazy(() => import('./pages/TeamPage.jsx')),
  billing: lazy(() => import('./pages/BillingPage.jsx')),
  superadmin: lazy(() => import('./pages/SuperAdminPage.jsx')),
  settings: lazy(() => import('./pages/SettingsPage.jsx')),
  // 2026-10-17: the tabs the ten sections added
  review: lazy(() => import('./pages/ReviewPage.jsx')),
  tplshared: lazy(() => import('./pages/TemplateLibraryPage.jsx')),
  appcampaigns: lazy(() => import('./pages/AppCampaignsPage.jsx')),
  connections: lazy(() => import('./pages/ConnectionsPage.jsx')),
  audit: lazy(() => import('./pages/AuditPage.jsx')),
};
