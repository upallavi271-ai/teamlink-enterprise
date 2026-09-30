import type { CommunicationAnalytics, CampaignPerf } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedCommunication, seedCampaignPerf } from '@/mocks/analytics.mock';

const real = config.isRealApi('analytics');

export interface AnalyticsParams { from?: string; to?: string; channel?: string }

function query(p: AnalyticsParams): string {
  const q = new URLSearchParams();
  if (p.from) q.set('from', p.from);
  if (p.to) q.set('to', p.to);
  if (p.channel) q.set('channel', p.channel);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const analyticsService = {
  async communication(_orgId: string, params: AnalyticsParams = {}): Promise<CommunicationAnalytics> {
    if (real) return apiRequest(`analytics/communication${query(params)}`);
    await mockLatency();
    const base = seedCommunication();
    if (!params.channel) return base;
    const ch = base.byChannel.find((c) => c.channel === params.channel);
    if (!ch) return { ...base, totals: { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 }, byChannel: [], failureReasons: [], rates: { deliveredRate: 0, readRate: 0, failRate: 0 } };
    return {
      ...base,
      totals: { total: ch.total, queued: ch.queued, sent: ch.sent, delivered: ch.delivered, read: ch.read, failed: ch.failed },
      byChannel: [ch],
      rates: {
        deliveredRate: ch.total ? Math.round(((ch.delivered + ch.read) / ch.total) * 1000) / 10 : 0,
        readRate: ch.total ? Math.round((ch.read / ch.total) * 1000) / 10 : 0,
        failRate: ch.total ? Math.round((ch.failed / ch.total) * 1000) / 10 : 0,
      },
    };
  },

  async campaigns(_orgId: string): Promise<CampaignPerf[]> {
    if (real) return apiRequest('analytics/campaigns');
    await mockLatency(150);
    return seedCampaignPerf();
  },
};
