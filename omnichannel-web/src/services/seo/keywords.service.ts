import { config } from '../config';
import { apiRequest } from '../apiClient';
import type { KeywordsList, KeywordSyncResult } from './seo.types';

/** SEO → Keywords. Real API only (numbers are Google's). */
const real = config.isRealApi('seo');
const needsApi = () => Promise.reject(new Error('Keyword tracking needs the real API (set VITE_USE_MOCKS=false).'));

export const keywordsService = {
  list(from: string, to: string, search?: string): Promise<KeywordsList> {
    const q = new URLSearchParams({ from, to });
    if (search) q.set('search', search);
    return real ? apiRequest(`seo/keywords?${q}`) : needsApi();
  },
  add(keywords: string[], country?: string, device?: string): Promise<{ created: number; skipped: number; sync?: KeywordSyncResult }> {
    return real ? apiRequest('seo/keywords', { method: 'POST', body: { keywords, country: country ?? '', device: device ?? '' } }) : needsApi();
  },
  remove(id: string): Promise<{ deleted: true }> {
    return real ? apiRequest(`seo/keywords/${id}`, { method: 'DELETE' }) : needsApi();
  },
  sync(onlyStale = false): Promise<KeywordSyncResult> {
    return real ? apiRequest(`seo/keywords/sync${onlyStale ? '?onlyStale=true' : ''}`, { method: 'POST' }) : needsApi();
  },
};
