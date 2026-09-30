import type { Paginated } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import type {
  AdDraft, AdDraftInput, AdLaunchResult, AdPlatformState, AdsOverview, BoostablePost, FacebookAdTargets,
} from './ads.types';

const real = config.isRealApi('ads');

/** Demo store — drafts persist for the session so the builder is exercisable offline. */
const drafts: Record<string, AdDraft[]> = {};
const rows = (orgId: string) => (drafts[orgId] ??= []);

const MOCK_PLATFORMS: AdPlatformState[] = [
  { key: 'facebook', connected: false, builder: true },
  { key: 'instagram', connected: false, builder: true },
  { key: 'linkedin', connected: false, builder: false },
  { key: 'youtube', connected: false, builder: false },
  { key: 'twitter', connected: false, builder: false },
];

export const adsService = {
  async overview(orgId: string): Promise<AdsOverview> {
    if (real) return apiRequest('ads/overview');
    await mockLatency();
    return { boostCampaigns: [], recentDrafts: rows(orgId).slice(0, 10), draftCount: rows(orgId).length, adsConfigured: false };
  },

  async platforms(): Promise<AdPlatformState[]> {
    if (real) return apiRequest('ads/platforms');
    await mockLatency(120);
    return MOCK_PLATFORMS;
  },

  async boostablePosts(limit = 24): Promise<{ items: BoostablePost[] }> {
    if (real) return apiRequest(`ads/boostable-posts?limit=${limit}`);
    await mockLatency();
    return { items: [] };
  },

  async facebookTargets(): Promise<FacebookAdTargets> {
    if (real) return apiRequest('ads/facebook/targets');
    await mockLatency(150);
    return {
      accounts: [], pages: [],
      unavailableReason: 'Demo mode: connect Facebook with the real API to choose an ad account.',
    };
  },

  async listDrafts(orgId: string, params: { page?: number; pageSize?: number } = {}): Promise<Paginated<AdDraft>> {
    if (real) return apiRequest(`ads/drafts${toQuery(params)}`);
    await mockLatency();
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    const all = rows(orgId);
    return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize };
  },

  async createDraft(orgId: string, input: AdDraftInput): Promise<AdDraft> {
    if (real) return apiRequest('ads/drafts', { method: 'POST', body: input });
    await mockLatency();
    const now = new Date().toISOString();
    const d: AdDraft = {
      id: `ad_${Date.now()}`, platform: input.platform, name: input.name,
      adAccountId: input.adAccountId ?? undefined, pageId: input.pageId ?? undefined,
      buyingType: input.buyingType, objective: input.objective,
      primaryText: input.primaryText ?? undefined, headline: input.headline ?? undefined,
      linkUrl: input.linkUrl ?? undefined, callToAction: input.callToAction ?? undefined,
      mediaUrls: input.mediaUrls, status: 'draft', createdAt: now, updatedAt: now,
    };
    rows(orgId).unshift(d);
    return { ...d };
  },

  async updateDraft(orgId: string, id: string, input: Partial<AdDraftInput>): Promise<AdDraft> {
    if (real) return apiRequest(`ads/drafts/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const d = rows(orgId).find((x) => x.id === id);
    if (!d) throw new Error('Ad draft not found');
    Object.assign(d, input, { updatedAt: new Date().toISOString() });
    return { ...d };
  },

  async removeDraft(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`ads/drafts/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    drafts[orgId] = rows(orgId).filter((d) => d.id !== id);
  },

  async launchDraft(id: string): Promise<AdLaunchResult> {
    if (real) return apiRequest(`ads/drafts/${id}/launch`, { method: 'POST' });
    await mockLatency(200);
    // Honest in demo: no ad account, so nothing launches.
    return {
      launched: false, configured: false, code: 'ADS_NOT_CONFIGURED',
      message: 'Paid ads are not configured. Connect a Meta ad account to enable launching.', draftId: id,
    };
  },
};
