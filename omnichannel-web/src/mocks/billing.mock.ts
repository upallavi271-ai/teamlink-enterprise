import type { BillingOverview, BillingPlan, CreditTxn } from '@/types';

export const seedPlans = (): BillingPlan[] => [
  { key: 'free', name: 'Free', tier: 'free', priceMinor: 0, currency: 'INR', includedCredits: 500, maxSeats: 2, maxWorkspaces: 1, features: ['500 messages', '2 seats'] },
  { key: 'starter', name: 'Starter', tier: 'starter', priceMinor: 249900, currency: 'INR', includedCredits: 10000, maxSeats: 3, maxWorkspaces: 1, features: ['10,000 messages', '3 seats'] },
  { key: 'professional', name: 'Professional', tier: 'professional', priceMinor: 799900, currency: 'INR', includedCredits: 50000, maxSeats: 10, maxWorkspaces: 3, features: ['50,000 messages', '10 seats'] },
  { key: 'enterprise', name: 'Enterprise', tier: 'enterprise', priceMinor: 1999900, currency: 'INR', includedCredits: 200000, features: ['200,000 messages', 'Unlimited seats'] },
];

export const seedOverview = (): BillingOverview => ({
  subscription: {
    id: 'sub1', status: 'active', creditBalance: 46180, autoTopUp: true,
    periodStart: new Date(Date.now() - 12 * 864e5).toISOString(),
    periodEnd: new Date(Date.now() + 18 * 864e5).toISOString(),
  },
  plan: seedPlans().find((p) => p.key === 'professional')!,
  usage: { creditsUsed: 3820, creditsIncluded: 50000, creditBalance: 46180 },
});

export const seedTxns = (): CreditTxn[] => [
  { id: 't1', delta: 50000, balanceAfter: 50000, reason: 'plan_grant', description: 'Professional plan — period grant', createdAt: new Date(Date.now() - 12 * 864e5).toISOString() },
  { id: 't2', delta: -620, balanceAfter: 49380, reason: 'message_send', description: 'Campaign: Weekend Reward', createdAt: new Date(Date.now() - 5 * 864e5).toISOString() },
  { id: 't3', delta: -3200, balanceAfter: 46180, reason: 'message_send', description: 'Campaign: Cart Reminder', createdAt: new Date(Date.now() - 3 * 864e5).toISOString() },
];
