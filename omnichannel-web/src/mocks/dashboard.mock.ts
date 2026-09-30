import type { DashboardOverview } from '@/types';

// Dev-only seed for the Dashboard. Clearly mock; never presented as live data.
const spark = (base: number) =>
  Array.from({ length: 12 }, (_, i) => Math.round(base * (0.7 + 0.5 * Math.sin(i / 2) + i * 0.03)));

export const MOCK_DASHBOARD: DashboardOverview = {
  kpis: [
    { key: 'reach', label: 'Reach', value: 128400, deltaPct: 12.4, unit: '', spark: spark(9000) },
    { key: 'engagement', label: 'Engagement', value: 24380, deltaPct: 6.1, unit: '', spark: spark(1900) },
    { key: 'leads', label: 'Leads', value: 1840, deltaPct: -2.3, unit: '', spark: spark(150) },
    { key: 'conversions', label: 'Conversions', value: 612, deltaPct: 8.9, unit: '', spark: spark(48) },
    { key: 'campaigns', label: 'Campaigns', value: 37, deltaPct: 4.0, unit: '', spark: spark(3) },
  ],
  channels: [
    { channel: 'whatsapp', label: 'WhatsApp', status: 'healthy', deliveredPct: 98.2, volume: 42100 },
    { channel: 'email', label: 'Email', status: 'healthy', deliveredPct: 94.7, volume: 31800 },
    { channel: 'sms', label: 'SMS', status: 'needs_reconnect', deliveredPct: 88.1, volume: 12400 },
    { channel: 'rcs', label: 'RCS', status: 'disconnected', deliveredPct: 0, volume: 0 },
  ],
  recentCampaigns: [
    { id: 'c1', name: 'Weekend Reward', channel: 'whatsapp', status: 'completed', sent: 8200, delivered: 8060 },
    { id: 'c2', name: 'Cart Reminder', channel: 'whatsapp', status: 'running', sent: 3100, delivered: 2980 },
    { id: 'c3', name: 'Spring Newsletter', channel: 'email', status: 'completed', sent: 14200, delivered: 13440 },
    { id: 'c4', name: 'Flash Sale SMS', channel: 'sms', status: 'scheduled', sent: 0, delivered: 0 },
  ],
  insights: [
    { id: 'i1', title: 'WhatsApp is outperforming', detail: 'Delivery is 4pt above your other channels this week.', tone: 'positive', href: '/app/analytics' },
    { id: 'i2', title: 'Re-target engaged users', detail: '1,240 contacts opened but did not convert.', tone: 'neutral', href: '/app/crm/segments' },
    { id: 'i3', title: 'SMS needs reconnect', detail: 'The MSG91 account requires re-authentication.', tone: 'warning', href: '/app/settings' },
  ],
  performance: Array.from({ length: 12 }, (_, i) => ({
    label: `W${i + 1}`,
    reach: Math.round(6000 + 4000 * Math.sin(i / 2) + i * 220),
    engagement: Math.round(1200 + 900 * Math.sin(i / 2 + 1) + i * 60),
  })),
};
