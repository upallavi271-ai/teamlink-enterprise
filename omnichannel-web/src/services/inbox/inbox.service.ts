import type { Conversation, ConversationStatus, InboxMessage, ListParams, Paginated } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedConversations, seedMessages } from '@/mocks/inbox.mock';

const real = config.isRealApi('inbox');
const SEED_WS = 'w2';

const convosByWs = new Map<string, Conversation[]>();
const msgsByWs = new Map<string, Record<string, InboxMessage[]>>();
function convos(orgId: string): Conversation[] {
  if (!convosByWs.has(orgId)) convosByWs.set(orgId, orgId === SEED_WS ? seedConversations() : []);
  return convosByWs.get(orgId)!;
}
function threads(orgId: string): Record<string, InboxMessage[]> {
  if (!msgsByWs.has(orgId)) msgsByWs.set(orgId, orgId === SEED_WS ? seedMessages() : {});
  return msgsByWs.get(orgId)!;
}

export const inboxService = {
  async listConversations(orgId: string, params: ListParams): Promise<Paginated<Conversation>> {
    if (real) return apiRequest(`conversations${toQuery(params)}`);
    await mockLatency();
    let rows = [...convos(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((c) => (c.contactName ?? '').toLowerCase().includes(q) || (c.contactPhone ?? '').includes(q));
    if (params.filters?.status) rows = rows.filter((c) => c.status === params.filters!.status);
    if (params.filters?.channel) rows = rows.filter((c) => c.channel === params.filters!.channel);
    rows.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async listMessages(orgId: string, id: string): Promise<InboxMessage[]> {
    if (real) {
      const p = await apiRequest<Paginated<InboxMessage>>(`conversations/${id}/messages?pageSize=200`);
      return p.items;
    }
    await mockLatency(150);
    return [...(threads(orgId)[id] ?? [])];
  },

  async reply(orgId: string, id: string, text: string): Promise<InboxMessage> {
    if (real) return apiRequest(`conversations/${id}/messages`, { method: 'POST', body: { text } });
    await mockLatency();
    const msg: InboxMessage = { id: `m_${Date.now()}`, direction: 'outbound', status: 'sent', text, provider: 'mock', createdAt: new Date().toISOString() };
    const t = threads(orgId);
    t[id] = [...(t[id] ?? []), msg];
    const c = convos(orgId).find((x) => x.id === id);
    if (c) { c.lastMessageAt = msg.createdAt; c.lastMessagePreview = text.slice(0, 140); if (c.status === 'pending') c.status = 'open'; }
    return msg;
  },

  async setStatus(orgId: string, id: string, status: ConversationStatus): Promise<void> {
    if (real) { await apiRequest(`conversations/${id}`, { method: 'PATCH', body: { status } }); return; }
    await mockLatency();
    const c = convos(orgId).find((x) => x.id === id);
    if (c) c.status = status;
  },

  async markRead(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`conversations/${id}/read`, { method: 'POST' }); return; }
    await mockLatency(80);
    const c = convos(orgId).find((x) => x.id === id);
    if (c) c.unreadCount = 0;
  },
};
