import type { LeadStage, LeadStatus, Channel } from '@/types';
export const LEAD_STAGES: LeadStage[] = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
export const LEAD_STATUSES: LeadStatus[] = ['active', 'inactive', 'unqualified'];
export const SOURCES = ['WhatsApp', 'Web Form', 'CSV Import', 'Facebook', 'Referral'];
export const CHANNELS: Channel[] = ['whatsapp', 'sms', 'email', 'rcs', 'voice'];
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const stageTone: Record<LeadStage, 'neutral' | 'blue' | 'green' | 'orange' | 'red' | 'violet'> = {
  new: 'blue', contacted: 'violet', qualified: 'orange', proposal: 'orange', won: 'green', lost: 'red',
};
