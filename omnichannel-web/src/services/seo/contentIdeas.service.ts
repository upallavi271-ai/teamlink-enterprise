import type { Paginated } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import type { ContentDraft, ContentDraftRow, GenerateContentInput } from './seo.types';

/** SEO → Content Ideas. Real API only — generation runs on the server with the workspace's AI key. */
const real = config.isRealApi('seo');
const needsApi = () => Promise.reject(new Error('Content Ideas needs the real API (set VITE_USE_MOCKS=false).'));

export const contentIdeasService = {
  status(): Promise<{ configured: boolean; model?: string }> {
    return real ? apiRequest('seo/content/status') : Promise.resolve({ configured: false });
  },
  generate(input: GenerateContentInput): Promise<ContentDraft> {
    return real ? apiRequest('seo/content/generate', { method: 'POST', body: input }) : needsApi();
  },
  list(page = 1, pageSize = 20): Promise<Paginated<ContentDraftRow>> {
    return real ? apiRequest(`seo/content/drafts?page=${page}&pageSize=${pageSize}`) : Promise.resolve({ items: [], total: 0, page, pageSize });
  },
  get(id: string): Promise<ContentDraft> {
    return real ? apiRequest(`seo/content/drafts/${id}`) : needsApi();
  },
  remove(id: string): Promise<{ deleted: true }> {
    return real ? apiRequest(`seo/content/drafts/${id}`, { method: 'DELETE' }) : needsApi();
  },
  sendToLibrary(id: string, body: { titleIndex: number; caption?: string; linkUrl?: string }): Promise<{ socialPostId: string; name: string }> {
    return real ? apiRequest(`seo/content/drafts/${id}/send-to-library`, { method: 'POST', body }) : needsApi();
  },
};
