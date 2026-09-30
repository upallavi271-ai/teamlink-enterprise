import type { Conversation, InboxMessage } from '@/types';

/** Demo inbox seed (workspace w2). Real mode is populated by inbound webhooks. */
export const seedConversations = (): Conversation[] => [
  { id: 'cv1', channel: 'whatsapp', contactName: 'Anita Rao', contactPhone: '+919000000001', status: 'open', lastMessageAt: '2026-09-12T08:05:00.000Z', lastMessagePreview: 'Is the weekend offer still on?', unreadCount: 2, createdAt: '2026-09-10T10:00:00.000Z' },
  { id: 'cv2', channel: 'whatsapp', contactName: 'Vikram Shah', contactPhone: '+919000000002', status: 'pending', lastMessageAt: '2026-09-11T16:20:00.000Z', lastMessagePreview: 'Thanks, I will check and revert.', unreadCount: 0, createdAt: '2026-09-09T09:00:00.000Z' },
  { id: 'cv3', channel: 'sms', contactName: 'Neha Kapoor', contactPhone: '+919000000003', status: 'open', lastMessageAt: '2026-09-11T11:10:00.000Z', lastMessagePreview: 'Please share the brochure.', unreadCount: 1, createdAt: '2026-09-08T09:00:00.000Z' },
  { id: 'cv4', channel: 'whatsapp', contactName: 'Rahul Mehta', contactPhone: '+919000000004', status: 'closed', lastMessageAt: '2026-09-05T14:00:00.000Z', lastMessagePreview: 'Sorted, thank you!', unreadCount: 0, createdAt: '2026-09-03T09:00:00.000Z' },
];

export const seedMessages = (): Record<string, InboxMessage[]> => ({
  cv1: [
    { id: 'x1', direction: 'inbound', status: 'delivered', text: 'Hi! Saw your WhatsApp about the weekend reward.', createdAt: '2026-09-12T07:58:00.000Z' },
    { id: 'x2', direction: 'outbound', status: 'read', text: 'Hi Anita! Yes, the weekend offer is live until Sunday 9pm.', provider: 'mock', createdAt: '2026-09-12T08:00:00.000Z' },
    { id: 'x3', direction: 'inbound', status: 'delivered', text: 'Is the weekend offer still on?', createdAt: '2026-09-12T08:05:00.000Z' },
  ],
  cv2: [
    { id: 'x4', direction: 'outbound', status: 'delivered', text: 'Your order has shipped and will arrive tomorrow.', provider: 'mock', createdAt: '2026-09-11T16:10:00.000Z' },
    { id: 'x5', direction: 'inbound', status: 'delivered', text: 'Thanks, I will check and revert.', createdAt: '2026-09-11T16:20:00.000Z' },
  ],
  cv3: [
    { id: 'x6', direction: 'inbound', status: 'delivered', text: 'Please share the brochure.', createdAt: '2026-09-11T11:10:00.000Z' },
  ],
  cv4: [
    { id: 'x7', direction: 'outbound', status: 'read', text: 'Glad we could help — anything else?', provider: 'mock', createdAt: '2026-09-05T13:55:00.000Z' },
    { id: 'x8', direction: 'inbound', status: 'delivered', text: 'Sorted, thank you!', createdAt: '2026-09-05T14:00:00.000Z' },
  ],
});
