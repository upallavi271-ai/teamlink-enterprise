import type { ListParams, Paginated, SocialPromotion, SocialPromotionInput, SocialPromotionLaunchResult } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';

const real = config.isRealApi('social');
const SEED_WS = 'w2';

let store: Record<string, SocialPromotion[]> = {};
const rows = (orgId: string) => (store[orgId] ??= []);

export interface PromotionListResult extends Paginated<SocialPromotion> { adsConfigured: boolean }

export const socialPromotionsService = {
  async list(orgId: string, params: ListParams): Promise<PromotionListResult> {
    if (real) return apiRequest(`social/promotions${toQuery(params)}`);
    await mockLatency();
    let r = [...rows(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) r = r.filter((p) => p.name.toLowerCase().includes(q));
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: r.slice((page - 1) * pageSize, page * pageSize), total: r.length, page, pageSize, adsConfigured: false };
  },
  async create(orgId: string, input: SocialPromotionInput): Promise<SocialPromotion> {
    if (real) return apiRequest('social/promotions', { method: 'POST', body: input });
    await mockLatency();
    const now = new Date().toISOString();
    const p: SocialPromotion = {
      id: `promo_${Date.now()}`, name: input.name, postId: input.postId ?? undefined, audienceId: input.audienceId ?? undefined,
      objective: input.objective, budgetType: input.budgetType, budgetMinor: input.budgetMinor, currency: input.currency,
      startAt: input.startAt ?? undefined, endAt: input.endAt ?? undefined, status: 'draft', provider: 'meta',
      createdAt: now, updatedAt: now,
    };
    rows(orgId).unshift(p);
    return { ...p };
  },
  async update(orgId: string, id: string, input: Partial<SocialPromotionInput>): Promise<SocialPromotion> {
    if (real) return apiRequest(`social/promotions/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const p = rows(orgId).find((x) => x.id === id);
    if (!p) throw new Error('Promotion not found');
    Object.assign(p, input, { updatedAt: new Date().toISOString() });
    return { ...p };
  },
  async remove(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`social/promotions/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    store[orgId] = rows(orgId).filter((p) => p.id !== id);
  },
  async launch(_orgId: string, id: string): Promise<SocialPromotionLaunchResult> {
    if (real) return apiRequest(`social/promotions/${id}/launch`, { method: 'POST' });
    await mockLatency(200);
    // Honest in demo: no ad account, so nothing launches.
    return { launched: false, configured: false, code: 'ADS_NOT_CONFIGURED', message: 'Paid promotion is not configured. Add a Meta ad account to enable it.' };
  },
};

void SEED_WS;
