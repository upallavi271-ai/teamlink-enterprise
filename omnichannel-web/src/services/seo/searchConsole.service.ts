import { config } from '../config';
import { apiRequest } from '../apiClient';
import type { GscConnection, GscOverview, GscSite } from './seo.types';

/**
 * SEO → Search Console. Real API only — the numbers are Google's, so there is
 * nothing honest to mock. Connect / disconnect reuse the generic integrations
 * endpoints under provider `google_search_console`.
 */
export const GSC_PROVIDER = 'google_search_console';
const real = config.isRealApi('seo');
const needsApi = () => Promise.reject(new Error('Search Console needs the real API (set VITE_USE_MOCKS=false).'));

export const searchConsoleService = {
  connection(): Promise<GscConnection> {
    return real ? apiRequest('seo/search-console/connection')
      : Promise.resolve({ configured: false, status: 'NOT_CONNECTED', hasRefreshToken: false });
  },
  sites(): Promise<GscSite[]> {
    return real ? apiRequest('seo/search-console/sites') : needsApi();
  },
  selectProperty(siteUrl: string): Promise<{ property: string }> {
    return real ? apiRequest('seo/search-console/property', { method: 'POST', body: { siteUrl } }) : needsApi();
  },
  overview(from: string, to: string, siteUrl?: string): Promise<GscOverview> {
    const q = new URLSearchParams({ from, to });
    if (siteUrl) q.set('siteUrl', siteUrl);
    return real ? apiRequest(`seo/search-console/overview?${q}`) : needsApi();
  },
};
