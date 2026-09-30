import type { Segment, SegmentInput } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { WorkspaceScopedMock, genId, nowIso } from '../scopedMock';
import { mockLatency } from '../mockDb';
import { seedSegments } from '@/mocks/crm.mock';
import { customerMatchesSegment } from '@/lib/segmentMatch';
import { customersService } from './customers.service';

const mock = new WorkspaceScopedMock<Segment>('w2', seedSegments, {
  searchFields: ['name', 'description'], sortFields: ['name', 'createdAt'], defaultSort: 'createdAt',
});
const real = config.isRealApi('segments');

export const segmentsService = {
  async list(orgId: string): Promise<Segment[]> {
    if (real) return apiRequest('segments');
    return mock.all(orgId);
  },
  create(orgId: string, input: SegmentInput): Promise<Segment> {
    return real ? apiRequest('segments', { method: 'POST', body: input })
      : mock.create(orgId, { ...input, id: genId('seg'), createdAt: nowIso() });
  },
  update(orgId: string, id: string, patch: Partial<SegmentInput>): Promise<Segment> {
    return real ? apiRequest(`segments/${id}`, { method: 'PATCH', body: patch }) : mock.update(orgId, id, patch);
  },
  remove(orgId: string, id: string): Promise<void> {
    return real ? apiRequest(`segments/${id}`, { method: 'DELETE' }) : mock.remove(orgId, id);
  },
  async duplicate(orgId: string, id: string): Promise<Segment> {
    if (real) return apiRequest(`segments/${id}/duplicate`, { method: 'POST' });
    const src = await mock.get(orgId, id);
    if (!src) throw new Error('Not found');
    return mock.create(orgId, { ...src, id: genId('seg'), name: `${src.name} (copy)`, createdAt: nowIso() });
  },
  async preview(orgId: string, rules: SegmentInput['rules'], logic: SegmentInput['logic']): Promise<{ count: number }> {
    if (real) return apiRequest('segments/preview', { method: 'POST', body: { rules, logic } });
    await mockLatency(180);
    const all = await customersService.all(orgId);
    return { count: all.filter((c) => customerMatchesSegment(c, { rules, logic })).length };
  },
};
