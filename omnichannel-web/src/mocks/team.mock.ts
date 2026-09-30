import type { TeamMember, TeamRole, PermissionDef } from '@/types';

/**
 * Demo-only seed for the Team + RBAC admin UI (workspace w2). Mirrors the
 * backend's permission catalog + system roles so the page is fully browsable
 * without a backend. Real mode fetches the same shapes from gs-api.
 */
export const permissionCatalog: PermissionDef[] = [
  { key: 'workspace.view', group: 'workspace', description: 'View this workspace' },
  { key: 'workspace.manage', group: 'workspace', description: 'Rename, configure or archive the workspace' },
  { key: 'team.view', group: 'team', description: 'See team members and roles' },
  { key: 'team.manage', group: 'team', description: 'Invite, remove and re-role members' },
  { key: 'role.manage', group: 'role', description: 'Create and edit roles and permissions' },
  { key: 'customer.view', group: 'customer', description: 'View customers' },
  { key: 'customer.edit', group: 'customer', description: 'Create and edit customers' },
  { key: 'customer.delete', group: 'customer', description: 'Delete customers' },
  { key: 'customer.export', group: 'customer', description: 'Export customer data' },
  { key: 'segment.manage', group: 'segment', description: 'Create and edit segments' },
  { key: 'campaign.view', group: 'campaign', description: 'View campaigns' },
  { key: 'campaign.create', group: 'campaign', description: 'Create and edit campaigns' },
  { key: 'campaign.send', group: 'campaign', description: 'Launch and schedule campaigns' },
  { key: 'campaign.delete', group: 'campaign', description: 'Delete campaigns' },
  { key: 'template.view', group: 'template', description: 'View message templates' },
  { key: 'template.manage', group: 'template', description: 'Create, edit and submit templates' },
  { key: 'inbox.view', group: 'inbox', description: 'Open the inbox' },
  { key: 'inbox.reply', group: 'inbox', description: 'Reply to conversations' },
  { key: 'automation.manage', group: 'automation', description: 'Create and edit automations and bots' },
  { key: 'content.manage', group: 'content', description: 'Use Content Studio and the media library' },
  { key: 'social.publish', group: 'social', description: 'Publish and schedule social posts' },
  { key: 'analytics.view', group: 'analytics', description: 'View analytics and reports' },
  { key: 'integration.manage', group: 'integration', description: 'Connect and disconnect integrations' },
  { key: 'billing.view', group: 'billing', description: 'View plan, usage and invoices' },
  { key: 'billing.manage', group: 'billing', description: 'Change plan and payment methods' },
  { key: 'audit.view', group: 'audit', description: 'Read the audit log' },
];

const ALL = permissionCatalog.map((p) => p.key);
const without = (...keys: string[]) => ALL.filter((k) => !keys.includes(k));

export const seedRoles = (): TeamRole[] => [
  { id: 'r-owner', key: 'owner', name: 'Owner', description: 'Full control, including billing and deletion', isSystem: true, memberCount: 1, permissionKeys: ALL },
  { id: 'r-admin', key: 'admin', name: 'Admin', description: 'Everything except billing and workspace deletion', isSystem: true, memberCount: 0, permissionKeys: without('billing.manage', 'workspace.manage') },
  { id: 'r-manager', key: 'manager', name: 'Manager', description: 'Runs campaigns and the team day to day', isSystem: true, memberCount: 1, permissionKeys: ['workspace.view', 'team.view', 'team.manage', 'customer.view', 'customer.edit', 'customer.export', 'segment.manage', 'campaign.view', 'campaign.create', 'campaign.send', 'template.view', 'template.manage', 'inbox.view', 'inbox.reply', 'automation.manage', 'content.manage', 'social.publish', 'analytics.view'] },
  { id: 'r-sales', key: 'sales', name: 'Sales', description: 'Works leads and conversations', isSystem: true, memberCount: 1, permissionKeys: ['workspace.view', 'team.view', 'customer.view', 'customer.edit', 'campaign.view', 'template.view', 'inbox.view', 'inbox.reply', 'analytics.view'] },
  { id: 'r-viewer', key: 'viewer', name: 'Viewer', description: 'Read-only access to the workspace', isSystem: true, memberCount: 0, permissionKeys: ['workspace.view', 'customer.view', 'campaign.view', 'template.view', 'analytics.view'] },
];

export const seedMembers = (): TeamMember[] => [
  { id: 'm1', user: { id: 'u1', name: 'Admin', email: 'admin@greenstart.demo' }, role: { id: 'r-owner', key: 'owner', name: 'Owner' }, status: 'active', joinedAt: '2026-06-01T09:00:00.000Z', lastActiveAt: '2026-09-12T08:10:00.000Z' },
  { id: 'm2', user: { id: 'u2', name: 'Meera S.', email: 'meera@greenstart.demo' }, role: { id: 'r-manager', key: 'manager', name: 'Manager' }, status: 'active', joinedAt: '2026-06-14T09:00:00.000Z', lastActiveAt: '2026-09-11T17:40:00.000Z' },
  { id: 'm3', user: { id: 'u3', name: 'Rohit P.', email: 'rohit@greenstart.demo' }, role: { id: 'r-sales', key: 'sales', name: 'Sales' }, status: 'active', joinedAt: '2026-07-02T09:00:00.000Z', lastActiveAt: '2026-09-10T12:05:00.000Z' },
  { id: 'm4', user: { id: 'u4', name: 'Priya (invited)', email: 'priya@greenstart.demo' }, role: { id: 'r-viewer', key: 'viewer', name: 'Viewer' }, status: 'invited', joinedAt: '2026-09-09T09:00:00.000Z' },
];
