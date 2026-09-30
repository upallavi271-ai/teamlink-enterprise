import type { Template, Channel, TemplateStatus } from '@/types';
import { nowIso } from '@/services/scopedMock';

const seed: Array<Partial<Template> & { name: string; channel: Channel; status: TemplateStatus; body: string }> = [
  { name: 'weekend_reward_v1', channel: 'whatsapp', provider: 'Meta', category: 'Marketing', status: 'approved', body: 'Hi {{1}}, enjoy 20% off this weekend. Reply STOP to opt out.' },
  { name: 'order_confirmation', channel: 'whatsapp', provider: 'Meta', category: 'Utility', status: 'approved', body: 'Your order {{1}} is confirmed and ships on {{2}}.' },
  { name: 'cart_reminder_v2', channel: 'whatsapp', provider: 'Meta', category: 'Marketing', status: 'pending', body: 'You left items in your cart, {{1}}. Complete your order today. Reply STOP to unsubscribe.' },
  { name: 'sales_welcome', channel: 'sms', provider: 'MSG91', category: 'Marketing', status: 'draft', body: 'Welcome to Green Start, {{1}}!' },
  { name: 'otp_login', channel: 'sms', provider: 'MSG91', category: 'Authentication', status: 'approved', body: 'Your login code is {{1}}. Valid for 10 minutes.' },
  { name: 'newsletter_apr', channel: 'email', provider: 'SMTP', category: 'Marketing', status: 'in_review', body: 'This month at Green Start: {{1}}' },
];

export function seedTemplates(): Template[] {
  return seed.map((t, i) => ({
    id: `tpl_${300 + i}`,
    name: t.name, channel: t.channel, provider: t.provider ?? 'Meta',
    category: t.category ?? 'Marketing', language: 'en', status: t.status,
    body: t.body, header: undefined, footer: undefined,
    variables: (t.body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length,
    updatedAt: new Date(Date.now() - i * 36e5 * 12).toISOString(),
  }));
}
export { nowIso };
