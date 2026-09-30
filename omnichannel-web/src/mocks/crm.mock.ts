import type { Customer, CustomField, Segment, Agent, LeadStage, LeadStatus } from '@/types';
import { nowIso } from '@/services/scopedMock';

const stages: LeadStage[] = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const statuses: LeadStatus[] = ['active', 'inactive', 'unqualified'];
const sources = ['WhatsApp', 'Web Form', 'CSV Import', 'Facebook', 'Referral'];
const first = ['Aarav', 'Diya', 'Vivaan', 'Ananya', 'Aditya', 'Ishaan', 'Kavya', 'Rohan', 'Meera', 'Kabir', 'Sara', 'Arjun'];
const last = ['Sharma', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Iyer', 'Rao', 'Menon', 'Das', 'Khan'];

export const MOCK_AGENTS: Agent[] = [
  { id: 'ag1', name: 'Admin', color: '#11985a' },
  { id: 'ag2', name: 'Meera S.', color: '#4d7ddb' },
  { id: 'ag3', name: 'Rohit P.', color: '#ef9b35' },
];

export function seedCustomers(): Customer[] {
  const rows: Customer[] = [];
  for (let i = 0; i < 57; i++) {
    const name = `${first[i % first.length]} ${last[i % last.length]}`;
    rows.push({
      id: `cus_${1000 + i}`,
      name,
      phone: `+9198${String(10000000 + i * 137).slice(0, 8)}`,
      email: i % 4 === 0 ? undefined : `${name.toLowerCase().replace(' ', '.')}@example.com`,
      platformId: `wa_${900000 + i}`,
      source: sources[i % sources.length],
      campaignName: i % 3 === 0 ? 'Weekend Reward' : undefined,
      leadStage: stages[i % stages.length],
      leadStatus: statuses[i % statuses.length],
      assignedAgentId: i % 5 === 0 ? undefined : MOCK_AGENTS[i % MOCK_AGENTS.length].id,
      createdAt: new Date(Date.now() - i * 36e5 * 6).toISOString(),
      updatedAt: nowIso(),
    });
  }
  return rows;
}

export function seedFields(): CustomField[] {
  return [
    { id: 'cf1', name: 'City', key: 'city', type: 'text', color: '#4d7ddb', required: false, createdAt: nowIso() },
    { id: 'cf2', name: 'Lifetime Value', key: 'ltv', type: 'number', color: '#11985a', required: false, createdAt: nowIso() },
    { id: 'cf3', name: 'Tier', key: 'tier', type: 'dropdown', options: ['Bronze', 'Silver', 'Gold'], color: '#ef9b35', required: false, createdAt: nowIso() },
  ];
}

export function seedSegments(): Segment[] {
  return [
    { id: 'seg1', name: 'VIP Members', description: 'Won deals, active', rules: [{ field: 'leadStage', operator: 'equals', value: 'won' }, { field: 'leadStatus', operator: 'equals', value: 'active' }], logic: 'AND', createdAt: nowIso() },
    { id: 'seg2', name: 'Engaged WhatsApp', description: 'Sourced from WhatsApp', rules: [{ field: 'source', operator: 'equals', value: 'WhatsApp' }], logic: 'AND', createdAt: nowIso() },
    { id: 'seg3', name: 'At-risk', description: 'Inactive leads', rules: [{ field: 'leadStatus', operator: 'equals', value: 'inactive' }], logic: 'OR', createdAt: nowIso() },
  ];
}
