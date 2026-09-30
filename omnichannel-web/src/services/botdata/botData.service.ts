import type { Paginated } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { collectAll } from '@/lib/collectAll';
import type { BotFlowSummary, BotSubmission, BotSubmissionQuery } from './botData.types';

/**
 * WhatsApp Bot Data. Real API only — these rows are captured chatbot
 * interactions, so there is nothing honest to simulate: with no bot flow
 * connected the list is legitimately empty.
 */
const real = config.isRealApi('bot-data');
const needsApi = <T>(): Promise<T> =>
  Promise.reject(new Error('Bot data needs the Green Start API (set VITE_USE_MOCKS=false).'));

const toQuery = (q: BotSubmissionQuery): string => {
  const p = new URLSearchParams();
  if (q.page) p.set('page', String(q.page));
  if (q.pageSize) p.set('pageSize', String(q.pageSize));
  if (q.search) p.set('search', q.search);
  if (q.botId) p.set('botId', q.botId);
  if (q.status) p.set('status', q.status);
  if (q.sort) p.set('sort', q.sort);
  if (q.dir) p.set('dir', q.dir);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const botDataService = {
  bots(): Promise<BotFlowSummary[]> {
    return real ? apiRequest('bot-data/bots') : Promise.resolve([]);
  },
  list(q: BotSubmissionQuery = {}): Promise<Paginated<BotSubmission>> {
    return real
      ? apiRequest(`bot-data/submissions${toQuery(q)}`)
      : Promise.resolve({ items: [], total: 0, page: q.page ?? 1, pageSize: q.pageSize ?? 10 });
  },
  get(id: string): Promise<BotSubmission> {
    return real ? apiRequest(`bot-data/submissions/${id}`) : needsApi();
  },
  update(
    id: string,
    patch: { status?: BotSubmission['status']; assignedAgentId?: string | null; leadStage?: BotSubmission['leadStage']; leadStatus?: BotSubmission['leadStatus'] },
  ): Promise<BotSubmission> {
    return real ? apiRequest(`bot-data/submissions/${id}`, { method: 'PATCH', body: patch }) : needsApi();
  },
  remove(id: string): Promise<{ deleted: true }> {
    return real ? apiRequest(`bot-data/submissions/${id}`, { method: 'DELETE' }) : needsApi();
  },
  removeMany(ids: string[]): Promise<{ deleted: number }> {
    return real ? apiRequest('bot-data/submissions/bulk-delete', { method: 'POST', body: { ids } }) : needsApi();
  },
  /** Every row matching the current filters, paged through for export. */
  all(q: BotSubmissionQuery = {}): Promise<BotSubmission[]> {
    return collectAll((page, pageSize) => this.list({ ...q, page, pageSize }));
  },
};
