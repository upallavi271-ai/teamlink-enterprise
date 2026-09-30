import type { Paginated } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import type { AuditStrategy, SeoAudit, SeoAuditRow, SeoStatus } from './seo.types';

/**
 * SEO → Site Audit. Real API only: an audit fetches a live web page and asks
 * Google PageSpeed, neither of which can be faked honestly. In mock mode the
 * page explains that instead of inventing scores.
 */
const real = config.isRealApi('seo');
const needsApi = () => Promise.reject(new Error('Site Audit needs the real API (set VITE_USE_MOCKS=false).'));

export const seoService = {
  status(): Promise<SeoStatus> {
    return real ? apiRequest('seo/status') : Promise.resolve({ pageSpeed: { enabled: false, keyed: false, note: 'Mock mode — audits are unavailable.' } });
  },
  runAudit(url: string, strategy: AuditStrategy): Promise<SeoAudit> {
    return real ? apiRequest('seo/audits', { method: 'POST', body: { url, strategy } }) : needsApi();
  },
  listAudits(page = 1, pageSize = 20, search?: string): Promise<Paginated<SeoAuditRow>> {
    const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search) q.set('search', search);
    return real ? apiRequest(`seo/audits?${q}`) : Promise.resolve({ items: [], total: 0, page, pageSize });
  },
  getAudit(id: string): Promise<SeoAudit> {
    return real ? apiRequest(`seo/audits/${id}`) : needsApi();
  },
  deleteAudit(id: string): Promise<{ deleted: true }> {
    return real ? apiRequest(`seo/audits/${id}`, { method: 'DELETE' }) : needsApi();
  },
};
