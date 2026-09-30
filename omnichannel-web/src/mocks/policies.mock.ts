import type { Policy } from '@/types';

/**
 * Demo-only seed for the Policies resource (workspace w2), mirroring the shapes
 * `GET /v1/policies` answers. Every `permissionKeys` entry below is a real key
 * from `permissionCatalog` in mocks/team.mock.ts — a policy that granted a
 * permission the catalogue does not define would render as an unlabelled row in
 * the picker and teach the wrong thing about the product.
 *
 * `roleCount` is NOT stored here. The server computes it from the role⇄policy
 * join, so the mock service derives it from its own attachment map instead of
 * carrying a number that goes stale the moment someone attaches a policy.
 */
export const seedPolicies = (): Policy[] => [
  {
    id: 'pol_campaign_ops',
    key: 'campaign-ops',
    name: 'Campaign Operations',
    description: 'Build, schedule and launch campaigns across every channel.',
    permissionKeys: [
      'campaign.view', 'campaign.create', 'campaign.send',
      'template.view', 'template.manage', 'social.publish',
    ],
    roleCount: 0,
    createdAt: '2026-08-04T09:00:00.000Z',
  },
  {
    id: 'pol_inbox_agent',
    key: 'inbox-agent',
    name: 'Inbox Agent',
    description: 'Answer conversations without touching campaign configuration.',
    permissionKeys: ['inbox.view', 'inbox.reply', 'customer.view'],
    roleCount: 0,
    createdAt: '2026-08-11T09:00:00.000Z',
  },
  {
    id: 'pol_data_export',
    key: 'data-export',
    name: 'Data Export',
    description: 'Read and export the customer database. Granted sparingly.',
    permissionKeys: ['customer.view', 'customer.export', 'analytics.view'],
    roleCount: 0,
    createdAt: '2026-08-19T09:00:00.000Z',
  },
  {
    id: 'pol_read_only_reporting',
    key: 'read-only-reporting',
    name: 'Read-only Reporting',
    description: 'See analytics and the audit log, change nothing.',
    permissionKeys: ['analytics.view', 'audit.view', 'campaign.view'],
    roleCount: 0,
    createdAt: '2026-09-02T09:00:00.000Z',
  },
];

/**
 * Which policies each seeded role starts with, keyed by ROLE KEY — the same
 * identifier `PUT /v1/team/roles/:roleKey/policies` addresses, so the mock and
 * the real API are indexed the same way.
 */
export const seedRolePolicyIds = (): Record<string, string[]> => ({
  manager: ['pol_campaign_ops'],
  sales: ['pol_inbox_agent'],
});
