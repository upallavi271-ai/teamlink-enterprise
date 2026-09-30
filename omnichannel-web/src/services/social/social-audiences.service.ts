import type { ListParams, Paginated, SocialAudience, SocialAudienceInput } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';

const real = config.isRealApi('social');
const SEED_WS = 'w2';

let store: Record<string, SocialAudience[]> = {};
const seed = (): SocialAudience[] => [
  {
    id: 'aud1', name: 'Hyderabad IT Decision Makers', description: 'B2B SaaS buyers in Hyderabad',
    sector: 'IT / Software', interests: ['Software', 'SaaS', 'Technology'],
    locationType: 'radius', city: 'Hyderabad', country: 'India', radiusKm: 25, centerLabel: 'Hyderabad, Telangana',
    ageMin: 25, ageMax: 55, genders: ['all'], languages: ['English', 'Telugu'],
    createdAt: '2026-09-10T09:00:00.000Z', updatedAt: '2026-09-10T09:00:00.000Z',
  },
];
const rows = (orgId: string) => (store[orgId] ??= orgId === SEED_WS ? seed() : []);

export const socialAudiencesService = {
  async list(orgId: string, params: ListParams): Promise<Paginated<SocialAudience>> {
    if (real) return apiRequest(`social/audiences${toQuery(params)}`);
    await mockLatency();
    let r = [...rows(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) r = r.filter((a) => a.name.toLowerCase().includes(q));
    const page = params.page ?? 1, pageSize = params.pageSize ?? 50;
    return { items: r.slice((page - 1) * pageSize, page * pageSize), total: r.length, page, pageSize };
  },
  async create(orgId: string, input: SocialAudienceInput): Promise<SocialAudience> {
    if (real) return apiRequest('social/audiences', { method: 'POST', body: input });
    await mockLatency();
    const now = new Date().toISOString();
    const a: SocialAudience = {
      id: `aud_${Date.now()}`, name: input.name, description: input.description ?? undefined, sector: input.sector ?? undefined,
      interests: input.interests ?? [], locationType: input.locationType ?? undefined, country: input.country ?? undefined,
      state: input.state ?? undefined, city: input.city ?? undefined, postalCode: input.postalCode ?? undefined,
      radiusKm: input.radiusKm ?? undefined, centerLabel: input.centerLabel ?? undefined,
      ageMin: input.ageMin ?? undefined, ageMax: input.ageMax ?? undefined, genders: input.genders ?? [], languages: input.languages ?? [],
      segmentId: input.segmentId ?? undefined, createdAt: now, updatedAt: now,
    };
    rows(orgId).unshift(a);
    return { ...a };
  },
  async update(orgId: string, id: string, input: Partial<SocialAudienceInput>): Promise<SocialAudience> {
    if (real) return apiRequest(`social/audiences/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const a = rows(orgId).find((x) => x.id === id);
    if (!a) throw new Error('Audience not found');
    Object.assign(a, input, { updatedAt: new Date().toISOString() });
    return { ...a };
  },
  async remove(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`social/audiences/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    store[orgId] = rows(orgId).filter((a) => a.id !== id);
  },
};
