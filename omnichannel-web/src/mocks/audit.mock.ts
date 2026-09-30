import type { AuditLogEntry } from '@/types';

export const seedAudit = (): AuditLogEntry[] => [
  {
    id: 'al1', action: 'auth.login', summary: 'Signed in',
    actor: { id: 'u1', name: 'Priya Nair', email: 'priya@greenstart.in' },
    ipAddress: '203.0.113.10', createdAt: '2026-09-11T16:40:00.000Z',
  },
  {
    id: 'al2', action: 'team.member_role_changed', entityType: 'member', entityId: 'm3',
    summary: 'Changed Rahul Verma from Sales to Manager',
    actor: { id: 'u1', name: 'Priya Nair', email: 'priya@greenstart.in' },
    ipAddress: '203.0.113.10', createdAt: '2026-09-11T15:12:00.000Z',
  },
  {
    id: 'al3', action: 'integration.connected', entityType: 'integration', entityId: 'in1',
    summary: 'Connected WhatsApp Business (Meta)',
    actor: { id: 'u2', name: 'Arjun Rao', email: 'arjun@greenstart.in' },
    metadata: { provider: 'meta', channel: 'whatsapp' },
    ipAddress: '203.0.113.22', createdAt: '2026-09-10T11:05:00.000Z',
  },
  {
    id: 'al4', action: 'workspace.update', entityType: 'workspace', entityId: 'w2',
    summary: 'Renamed workspace to “Green Start HQ”',
    actor: { id: 'u1', name: 'Priya Nair', email: 'priya@greenstart.in' },
    ipAddress: '203.0.113.10', createdAt: '2026-09-09T09:30:00.000Z',
  },
  {
    id: 'al5', action: 'team.member_invited', entityType: 'invite', entityId: 'iv7',
    summary: 'Invited neha@greenstart.in as Support Agent',
    actor: { id: 'u2', name: 'Arjun Rao', email: 'arjun@greenstart.in' },
    ipAddress: '203.0.113.22', createdAt: '2026-09-08T14:20:00.000Z',
  },
  {
    id: 'al6', action: 'campaign.sent', entityType: 'campaign', entityId: 'cm4',
    summary: 'Queued campaign "Weekend Reward" (whatsapp) for sending',
    actor: { id: 'u2', name: 'Arjun Rao', email: 'arjun@greenstart.in' },
    createdAt: '2026-09-11T10:15:00.000Z',
  },
  {
    id: 'al7', action: 'customer.bulk_deleted', entityType: 'customer',
    summary: 'Deleted 12 contacts',
    actor: { id: 'u1', name: 'Priya Nair', email: 'priya@greenstart.in' },
    metadata: { count: 12 }, createdAt: '2026-09-10T09:45:00.000Z',
  },
];
