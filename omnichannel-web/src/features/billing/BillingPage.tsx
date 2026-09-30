import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { billingService } from '@/services/billing/billing.service';
import { useCan } from '@/features/auth/useCan';
import { useOrgStore } from '@/stores/orgStore';
import { cn } from '@/lib/cn';
import type { BillingPlan, CreditTxn } from '@/types';

const money = (minor: number, currency = 'INR') =>
  minor === 0 ? 'Free' : new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
const num = (n: number) => n.toLocaleString('en-IN');

export function BillingPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canView = useCan('billing.view');

  const ovQ = useQuery({ queryKey: ['billing-overview', orgId], queryFn: () => billingService.overview(orgId), enabled: !!orgId && canView });
  const plansQ = useQuery({ queryKey: ['billing-plans'], queryFn: () => billingService.plans(), enabled: canView });
  const txQ = useQuery({ queryKey: ['billing-txns', orgId], queryFn: () => billingService.transactions(orgId), enabled: !!orgId && canView });

  if (!canView) {
    return (
      <div>
        <PageHeader title="Billing" subtitle="Plan, usage and credits" />
        <Card><EmptyState title="No access" detail="You need the billing.view permission to see billing." /></Card>
      </div>
    );
  }

  const ov = ovQ.data;
  const usedPct = ov?.usage.creditsIncluded ? Math.min(100, Math.round((ov.usage.creditsUsed / ov.usage.creditsIncluded) * 100)) : 0;

  return (
    <div>
      <PageHeader title="Billing" subtitle="Plan, credit usage and transactions" />

      {ovQ.isLoading ? <Card><LoadingState /></Card>
        : ovQ.isError ? <Card><ErrorState onRetry={() => ovQ.refetch()} /></Card>
        : !ov?.plan ? <Card><EmptyState title="No subscription" detail="This organization has no active plan yet." /></Card>
        : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-1">
              <div className="text-xs uppercase tracking-wide text-muted">Current plan</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xl font-semibold text-ink">{ov.plan.name}</span>
                <Badge tone={ov.subscription?.status === 'active' ? 'green' : 'orange'}>{ov.subscription?.status}</Badge>
              </div>
              <div className="mt-1 text-sm text-muted">{money(ov.plan.priceMinor, ov.plan.currency)}{ov.plan.priceMinor > 0 ? ' / period' : ''}</div>
              {ov.subscription && <div className="mt-3 text-xs text-muted">Renews {new Date(ov.subscription.periodEnd).toLocaleDateString()}{ov.subscription.autoTopUp ? ' · auto top-up on' : ''}</div>}
              <Button size="sm" variant="secondary" className="mt-4" disabled title="Payment setup is not available yet">Change plan</Button>
            </Card>

            <Card className="p-5 lg:col-span-2">
              <div className="flex items-baseline justify-between">
                <div className="text-xs uppercase tracking-wide text-muted">Message credits</div>
                <div className="text-sm text-muted">{num(ov.usage.creditBalance)} left</div>
              </div>
              <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-accent" style={{ width: `${usedPct}%` }} />
              </div>
              <div className="mt-2 text-sm text-muted">{num(ov.usage.creditsUsed)} used of {num(ov.usage.creditsIncluded)} this period ({usedPct}%)</div>
              <Button size="sm" variant="secondary" className="mt-4" disabled title="Payment setup is not available yet">Buy credits</Button>
            </Card>
          </div>

          <Card>
            <div className="border-b border-line px-4 py-3 text-sm font-medium text-ink">Plans</div>
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              {(plansQ.data ?? []).map((p) => <PlanCard key={p.key} plan={p} current={p.key === ov.plan!.key} />)}
            </div>
          </Card>

          <Card>
            <div className="border-b border-line px-4 py-3 text-sm font-medium text-ink">Credit transactions</div>
            {txQ.isLoading ? <LoadingState /> : txQ.isError ? <ErrorState onRetry={() => txQ.refetch()} />
              : (txQ.data ?? []).length === 0 ? <EmptyState title="No transactions" detail="Credit grants and message sends will appear here." />
              : <TxnTable rows={txQ.data ?? []} />}
          </Card>
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan, current }: { plan: BillingPlan; current: boolean }) {
  return (
    <div className={cn('rounded-card border p-4', current ? 'border-accent ring-1 ring-accent' : 'border-line')}>
      <div className="flex items-center justify-between">
        <span className="font-semibold text-ink">{plan.name}</span>
        {current && <Badge tone="green">Current</Badge>}
      </div>
      <div className="mt-1 text-lg font-semibold text-ink">{money(plan.priceMinor, plan.currency)}</div>
      <ul className="mt-3 space-y-1.5 text-sm text-muted">
        {plan.features.map((f) => <li key={f} className="flex items-start gap-1.5"><Check size={14} className="mt-0.5 text-accent" />{f}</li>)}
      </ul>
    </div>
  );
}

function TxnTable({ rows }: { rows: CreditTxn[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <th className="px-4 py-3">Date</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3">Description</th><th className="px-4 py-3 text-right">Change</th><th className="px-4 py-3 text-right">Balance</th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-line last:border-0">
              <td className="px-4 py-3 text-muted">{new Date(t.createdAt).toLocaleDateString()}</td>
              <td className="px-4 py-3"><Badge tone="neutral">{t.reason.replace(/_/g, ' ')}</Badge></td>
              <td className="px-4 py-3 text-muted">{t.description ?? '—'}</td>
              <td className={cn('px-4 py-2 text-right font-medium', t.delta >= 0 ? 'text-green-2' : 'text-red')}>{t.delta >= 0 ? '+' : ''}{num(t.delta)}</td>
              <td className="px-4 py-3 text-right text-muted">{num(t.balanceAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
