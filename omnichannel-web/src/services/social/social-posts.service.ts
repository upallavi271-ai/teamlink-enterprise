import type {
  ListParams, Paginated, SocialPost, SocialPostInput, SocialValidateResult,
} from '@/types';
import type { SocialMediaUploadResult } from '@/types';
import { config } from '../config';
import { apiRequest, apiUpload, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';

const real = config.isRealApi('social');

// In-memory mock store (drafts persist within a session).
let store: Record<string, SocialPost[]> = {};
const posts = (orgId: string) => (store[orgId] ??= []);

type ValidateInput = { caption: string; linkUrl?: string | null; hashtags: string[]; accountIds: string[]; media: { type: 'IMAGE' | 'VIDEO' }[] };

export const socialPostsService = {
  async list(orgId: string, params: ListParams): Promise<Paginated<SocialPost>> {
    if (real) return apiRequest(`social/posts${toQuery(params)}`);
    await mockLatency();
    let rows = [...posts(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    if (params.filters?.status) rows = rows.filter((p) => p.status === params.filters!.status);
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async get(orgId: string, id: string): Promise<SocialPost> {
    if (real) return apiRequest(`social/posts/${id}`);
    await mockLatency(120);
    const p = posts(orgId).find((x) => x.id === id);
    if (!p) throw new Error('Post not found');
    return p;
  },

  async create(orgId: string, input: SocialPostInput): Promise<SocialPost> {
    if (real) return apiRequest('social/posts', { method: 'POST', body: input });
    await mockLatency();
    const now = new Date().toISOString();
    const p: SocialPost = {
      id: `sp_${Date.now()}`, name: input.name, caption: input.caption, linkUrl: input.linkUrl ?? undefined,
      hashtags: input.hashtags, status: 'draft',
      targets: input.accountIds.map((accId, i) => ({ id: `t_${i}_${Date.now()}`, socialAccountId: accId, platform: 'FACEBOOK', status: 'pending' })),
      media: input.media.map((m, i) => ({ id: `m_${i}_${Date.now()}`, type: m.type, url: m.url, thumbnailUrl: m.thumbnailUrl, altText: m.altText, order: i })),
      createdAt: now, updatedAt: now,
    };
    posts(orgId).unshift(p);
    return { ...p };
  },

  async update(orgId: string, id: string, input: Partial<SocialPostInput>): Promise<SocialPost> {
    if (real) return apiRequest(`social/posts/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const p = posts(orgId).find((x) => x.id === id);
    if (!p) throw new Error('Post not found');
    if (input.name !== undefined) p.name = input.name;
    if (input.caption !== undefined) p.caption = input.caption;
    if (input.linkUrl !== undefined) p.linkUrl = input.linkUrl ?? undefined;
    if (input.hashtags !== undefined) p.hashtags = input.hashtags;
    if (input.media !== undefined) p.media = input.media.map((m, i) => ({ id: `m_${i}_${Date.now()}`, type: m.type, url: m.url, thumbnailUrl: m.thumbnailUrl, altText: m.altText, order: i }));
    p.updatedAt = new Date().toISOString();
    return { ...p };
  },

  async remove(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`social/posts/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    store[orgId] = posts(orgId).filter((p) => p.id !== id);
  },

  async validate(_orgId: string, input: ValidateInput): Promise<SocialValidateResult> {
    if (real) return apiRequest('social/posts/validate', { method: 'POST', body: input });
    await mockLatency(120);
    return { violations: [], platforms: [] };
  },

  async publish(_orgId: string, id: string): Promise<{ status: string }> {
    if (real) return apiRequest(`social/posts/${id}/publish`, { method: 'POST' });
    await mockLatency(200);
    // Honest in demo: no real provider, so nothing is actually published.
    throw new Error('Publishing requires connected accounts and the real API. Connect Facebook/Instagram to publish.');
  },

  async schedule(orgId: string, id: string, scheduledAt: string): Promise<{ status: string; scheduledAt?: string }> {
    if (real) return apiRequest(`social/posts/${id}/schedule`, { method: 'POST', body: { scheduledAt } });
    await mockLatency(200);
    const p = posts(orgId).find((x) => x.id === id);
    if (p) { p.status = 'scheduled'; p.scheduledAt = scheduledAt; }
    return { status: 'scheduled', scheduledAt };
  },

  async cancel(orgId: string, id: string): Promise<{ status: string }> {
    if (real) return apiRequest(`social/posts/${id}/cancel`, { method: 'POST' });
    await mockLatency(150);
    const p = posts(orgId).find((x) => x.id === id);
    if (p) p.status = 'cancelled';
    return { status: 'cancelled' };
  },

  async uploadMedia(_orgId: string, file: File): Promise<SocialMediaUploadResult> {
    if (real) {
      const form = new FormData();
      form.append('file', file);
      return apiUpload('social/media', form);
    }
    // Mock/demo: no server storage — surface an honest error rather than a fake URL.
    await mockLatency(200);
    throw new Error('File upload requires the server (connect the real API). You can add media by URL in demo mode.');
  },
};
