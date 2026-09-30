import type { Campaign, Channel, CampaignStatus } from '@/types';
import { nowIso } from '@/services/scopedMock';

const channels: Channel[] = ['whatsapp', 'sms', 'email', 'rcs'];
const statuses: CampaignStatus[] = ['draft', 'scheduled', 'running', 'completed', 'paused', 'completed'];
const names = ['Weekend Reward', 'Cart Reminder', 'Spring Newsletter', 'Flash Sale', 'Welcome Series', 'Win-back', 'Festive Offer', 'Product Launch'];

export function seedCampaigns(): Campaign[] {
  return names.map((name, i) => {
    const recipients = 1000 + i * 850;
    const sent = statuses[i % statuses.length] === 'draft' ? 0 : recipients;
    const delivered = Math.round(sent * 0.96);
    return {
      id: `cmp_${200 + i}`,
      name,
      channel: channels[i % channels.length],
      status: statuses[i % statuses.length],
      recipients, sent, delivered,
      read: Math.round(delivered * 0.6),
      failed: sent - delivered,
      createdAt: new Date(Date.now() - i * 864e5).toISOString(),
    };
  });
}
export { nowIso };
