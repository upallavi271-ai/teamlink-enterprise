import type { AdminOrg, AdminOrgDetail, AdminUser, SuperAdminStats } from '@/types';

export const seedStats = (): SuperAdminStats => ({
  organizations: 3, workspaces: 5, users: 12, activeSubscriptions: 2, suspendedOrgs: 1, superAdmins: 1,
});

export const seedOrgs = (): AdminOrg[] => [
  {
    id: 'org1', name: 'Teamlink Consultants', slug: 'teamlink-consultants', status: 'active',
    country: 'IN', currency: 'INR', ownerName: 'Vasu C.', ownerEmail: 'admin@greenstart.demo',
    workspaceCount: 2, plan: 'Professional', subscriptionStatus: 'active', creditBalance: 48200,
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'org2', name: 'Bright Retail Co', slug: 'bright-retail', status: 'trial',
    country: 'IN', currency: 'INR', ownerName: 'Sana K.', ownerEmail: 'sana@brightretail.in',
    workspaceCount: 1, plan: 'Starter', subscriptionStatus: 'trialing', creditBalance: 1000,
    createdAt: '2026-09-02T09:00:00.000Z',
  },
  {
    id: 'org3', name: 'Old Ledger LLP', slug: 'old-ledger', status: 'suspended',
    country: 'IN', currency: 'INR', ownerName: 'Ravi M.', ownerEmail: 'ravi@oldledger.in',
    workspaceCount: 2, plan: 'Free', subscriptionStatus: 'cancelled', creditBalance: 0,
    createdAt: '2026-06-15T09:00:00.000Z',
  },
];

export const seedOrgDetail = (id: string): AdminOrgDetail => {
  const base = seedOrgs().find((o) => o.id === id) ?? seedOrgs()[0]!;
  return {
    id: base.id, name: base.name, slug: base.slug, status: base.status,
    country: base.country, currency: base.currency, timezone: 'Asia/Kolkata',
    owner: { id: 'u1', name: base.ownerName ?? '—', email: base.ownerEmail ?? '—' },
    workspaces: [
      { id: 'w2', name: 'Teamlink Medical', slug: 'teamlink-medical', memberCount: 3, createdAt: '2026-08-01T09:00:00.000Z' },
      { id: 'w3', name: 'Teamlink IT', slug: 'teamlink-it', memberCount: 2, createdAt: '2026-08-20T09:00:00.000Z' },
    ].slice(0, base.workspaceCount),
    subscription: { plan: base.plan, tier: (base.plan ?? 'free').toLowerCase(), status: base.subscriptionStatus ?? 'active', creditBalance: base.creditBalance ?? 0, periodEnd: '2026-10-01T09:00:00.000Z' },
    createdAt: base.createdAt,
  };
};

export const seedUsers = (): AdminUser[] => [
  { id: 'root', name: 'Platform Operator', email: 'root@greenstart.app', status: 'active', isSuperAdmin: true, membershipCount: 0, lastLoginAt: '2026-09-12T08:00:00.000Z', createdAt: '2026-07-01T09:00:00.000Z' },
  { id: 'u1', name: 'Vasu C.', email: 'admin@greenstart.demo', status: 'active', isSuperAdmin: false, membershipCount: 2, lastLoginAt: '2026-09-11T16:40:00.000Z', createdAt: '2026-08-01T09:00:00.000Z' },
  { id: 'u2', name: 'Meera S.', email: 'meera@greenstart.demo', status: 'active', isSuperAdmin: false, membershipCount: 1, lastLoginAt: '2026-09-10T12:00:00.000Z', createdAt: '2026-08-01T09:00:00.000Z' },
  { id: 'u3', name: 'Rohit P.', email: 'rohit@greenstart.demo', status: 'suspended', isSuperAdmin: false, membershipCount: 1, lastLoginAt: null, createdAt: '2026-08-05T09:00:00.000Z' },
];
