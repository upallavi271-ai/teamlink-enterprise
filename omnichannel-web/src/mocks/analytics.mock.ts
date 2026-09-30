import type { CommunicationAnalytics, CampaignPerf } from '@/types';

/** Demo analytics (workspace w2). Real mode computes these from message rows. */
export function seedCommunication(): CommunicationAnalytics {
  const days = 30;
  const performance = Array.from({ length: days }, (_, i) => {
    const sent = 40 + Math.round(30 * Math.sin(i / 3) + i);
    return { label: `D${i + 1}`, reach: Math.max(0, sent), engagement: Math.max(0, Math.round(sent * 0.72)) };
  });
  const totals = { total: 1840, queued: 20, sent: 1840, delivered: 1520, read: 1180, failed: 120 };
  return {
    range: { from: new Date(Date.now() - days * 864e5).toISOString(), to: new Date().toISOString() },
    totals,
    rates: { deliveredRate: 82.6, readRate: 64.1, failRate: 6.5 },
    byChannel: [
      { channel: 'whatsapp', total: 1200, queued: 10, sent: 1200, delivered: 1040, read: 860, failed: 60 },
      { channel: 'sms', total: 420, queued: 6, sent: 420, delivered: 360, read: 240, failed: 40 },
      { channel: 'email', total: 220, queued: 4, sent: 220, delivered: 120, read: 80, failed: 20 },
    ],
    failureReasons: [
      { reason: 'Invalid number', count: 58 },
      { reason: 'Opted out', count: 34 },
      { reason: 'Provider rejected', count: 20 },
      { reason: 'Unknown', count: 8 },
    ],
    performance,
  };
}

export function seedCampaignPerf(): CampaignPerf[] {
  return [
    { id: 'cmp1', name: 'Weekend Reward', channel: 'whatsapp', status: 'completed', recipients: 620, sent: 620, delivered: 560, read: 430, failed: 22, createdAt: '2026-09-07T09:00:00.000Z' },
    { id: 'cmp2', name: 'Cart Reminder', channel: 'whatsapp', status: 'completed', recipients: 340, sent: 340, delivered: 300, read: 210, failed: 18, createdAt: '2026-09-05T09:00:00.000Z' },
    { id: 'cmp3', name: 'Sept Newsletter', channel: 'email', status: 'completed', recipients: 220, sent: 220, delivered: 120, read: 80, failed: 20, createdAt: '2026-09-02T09:00:00.000Z' },
  ];
}
