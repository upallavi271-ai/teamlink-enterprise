import type { LeadStage, LeadStatus } from '@/types';

export type BotSubmissionStatus = 'new' | 'in_progress' | 'completed' | 'abandoned';

export interface BotFlowSummary {
  id: string; name: string; description?: string; channel: string;
  keyword?: string; status: 'active' | 'disabled'; submissions: number; createdAt: string;
}

export interface BotSubmission {
  id: string;
  identity: string;
  phone?: string;
  email?: string;
  platformId?: string;
  botFlowId?: string;
  botFlowName?: string;
  status: BotSubmissionStatus;
  source: string;
  /** Whatever the flow captured: field key → value, plus a `messages` transcript. */
  data: Record<string, unknown>;
  customerId?: string;
  /** From the linked CRM contact; absent when the submission is not linked. */
  leadStage?: LeadStage;
  leadStatus?: LeadStatus;
  assignedAgentId?: string;
  occurredAt: string;
  createdAt: string;
}

export interface BotSubmissionQuery {
  page?: number; pageSize?: number; search?: string; botId?: string;
  status?: BotSubmissionStatus; sort?: 'identity' | 'email' | 'status' | 'occurredAt'; dir?: 'asc' | 'desc';
}
