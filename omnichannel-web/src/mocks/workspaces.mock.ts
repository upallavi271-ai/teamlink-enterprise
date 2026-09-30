import type { Workspace } from '@/types';

// Dev-only seed. Imported ONLY by service mock branches, never by components.
export const MOCK_WORKSPACES: Workspace[] = [
  { id: 'w1', name: 'Northwind Retail', plan: 'Growth', logoText: 'NR', role: 'Owner' },
  { id: 'w2', name: 'Green Start Demo', plan: 'Pro', logoText: 'GS', role: 'Owner' },
  { id: 'w3', name: 'Brightline Services', plan: 'Starter', logoText: 'BS', role: 'Admin' },
];

export const MOCK_USER = { id: 'u1', name: 'Admin', email: 'admin@greenstart.demo', avatarColor: '#11985a', isSuperAdmin: true };

// Full permission set for the demo owner (mock mode has no RBAC gating).
export const MOCK_PERMISSIONS = [
  'workspace.view', 'team.view', 'team.manage', 'customer.view', 'customer.edit',
  'customer.delete', 'customer.export', 'segment.manage', 'campaign.view', 'campaign.create',
  'campaign.send', 'campaign.delete', 'template.view', 'template.manage', 'inbox.view',
  'inbox.reply', 'automation.manage', 'content.manage', 'social.publish', 'analytics.view',
  'integration.manage', 'billing.view', 'billing.manage', 'audit.view', 'role.manage',
];
