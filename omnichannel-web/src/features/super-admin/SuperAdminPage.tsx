import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Users, CreditCard, ShieldCheck, Ban, CheckCircle2, Layers } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tabs } from '@/components/ui/Tabs';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { superAdminService } from '@/services/superadmin/superadmin.service';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/components/toast/toastStore';
import type { AdminOrg, AdminUser, OrgStatus } from '@/types';

const orgTone = (s: OrgStatus) => (s === 'active' ? 'green' : s === 'trial' ? 'blue' : 'red') as 'green' | 'blue' | 'red';
const userTone = (s: string) => (s === 'active' ? 'green' : s === 'suspended' ? 'red' : 'orange') as 'green' | 'red' | 'orange';

export function SuperAdminPage() {
  const isSuperAdmin = useAuthStore((s) => s.user?.isSuperAdmin ?? false);
  const [tab, setTab] = useState('overview');

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Super Admin" subtitle="Platform operator console" />
        <Card><EmptyState title="Operators only" detail="This console is restricted to platform operators (super admins)." /></Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Super Admin" subtitle="Platform operator console — spans all tenants" />
      <Tabs
        tabs={[{ key: 'overview', label: 'Overview' }, { key: 'orgs', label: 'Organizations' }, { key: 'users', label: 'Users' }]}
        active={tab} onChange={setTab}
      />
      <div className="pt-4">
        {tab === 'overview' ? <OverviewTab /> : tab === 'orgs' ? <OrgsTab /> : <UsersTab />}
      </div>
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────
function OverviewTab() {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['admin-stats'], queryFn: () => superAdminService.stats() });
  if (isLoading) return <Card><LoadingState /></Card>;
  if (isError || !data) return <Card><ErrorState onRetry={() => refetch()} /></Card>;
  const cards = [
    { label: 'Organizations', value: data.organizations, icon: Building2 },
    { label: 'Workspaces', value: data.workspaces, icon: Layers },
    { label: 'Users', value: data.users, icon: Users },
    { label: 'Active subscriptions', value: data.activeSubscriptions, icon: CreditCard },
    { label: 'Suspended orgs', value: data.suspendedOrgs, icon: Ban },
    { label: 'Super admins', value: data.superAdmins, icon: ShieldCheck },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.label} className="flex items-center gap-4 p-5">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-accent"><c.icon size={20} /></span>
          <div>
            <div className="text-2xl font-semibold text-ink">{c.value.toLocaleString('en-IN')}</div>
            <div className="text-xs uppercase tracking-wide text-muted">{c.label}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Organizations ────────────────────────────────────────────────────────────
function OrgsTab() {
  const lp = useListParams({ pageSize: 20 });
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-orgs', lp.params], queryFn: () => superAdminService.organizations(lp.params),
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: OrgStatus }) => superAdminService.setOrgStatus(v.id, v.status),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-orgs'] }); qc.invalidateQueries({ queryKey: ['admin-stats'] }); },
  });
  const [confirm, setConfirm] = useState<{ org: AdminOrg; status: OrgStatus } | null>(null);
  const rows = data?.items ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search organizations…" />
        <Select className="h-10 w-auto" value={lp.filters.status ?? ''} onChange={(e) => lp.setFilter('status', e.target.value)}>
          <option value="">All statuses</option><option value="active">Active</option><option value="trial">Trial</option><option value="suspended">Suspended</option>
        </Select>
      </div>
      {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
        : rows.length === 0 ? <EmptyState title="No organizations" detail="No organizations match your filters." />
        : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3">Organization</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Workspaces</th><th className="px-4 py-3">Credits</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-3"><div className="font-medium text-ink">{o.name}</div><div className="text-xs text-muted">{o.slug} · {o.country}</div></td>
                  <td className="px-4 py-3 text-muted">{o.ownerName ?? '—'}<div className="text-xs">{o.ownerEmail}</div></td>
                  <td className="px-4 py-3 text-muted">{o.plan ?? '—'}{o.subscriptionStatus && <div className="text-xs">{o.subscriptionStatus}</div>}</td>
                  <td className="px-4 py-3 text-muted">{o.workspaceCount}</td>
                  <td className="px-4 py-3 text-muted">{o.creditBalance != null ? o.creditBalance.toLocaleString('en-IN') : '—'}</td>
                  <td className="px-4 py-3"><Badge tone={orgTone(o.status)}>{o.status}</Badge></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      {o.status === 'suspended'
                        ? <Button variant="ghost" size="sm" onClick={() => setConfirm({ org: o, status: 'active' })}><CheckCircle2 size={15} /> Reactivate</Button>
                        : <Button variant="ghost" size="sm" onClick={() => setConfirm({ org: o, status: 'suspended' })}><Ban size={15} /> Suspend</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={lp.page} pageSize={lp.pageSize} total={data?.total ?? 0} onPage={lp.setPage} />
        </div>
      )}

      <ConfirmDialog open={!!confirm} title={confirm?.status === 'suspended' ? 'Suspend organization' : 'Reactivate organization'}
        danger={confirm?.status === 'suspended'} confirmLabel={confirm?.status === 'suspended' ? 'Suspend' : 'Reactivate'} loading={setStatus.isPending}
        message={confirm?.status === 'suspended'
          ? `Suspend "${confirm?.org.name}"? Its members keep their data but the organization is flagged suspended.`
          : `Reactivate "${confirm?.org.name}"?`}
        onConfirm={() => confirm && setStatus.mutateAsync({ id: confirm.org.id, status: confirm.status })
          .then(() => { toast.success(`Organization ${confirm.status === 'suspended' ? 'suspended' : 'reactivated'}`); setConfirm(null); })
          .catch((e) => toast.error(e?.message ?? 'Update failed'))}
        onClose={() => setConfirm(null)} />
    </Card>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────
function UsersTab() {
  const lp = useListParams({ pageSize: 20 });
  const currentUserId = useAuthStore((s) => s.user?.id);
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-users', lp.params], queryFn: () => superAdminService.users(lp.params),
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'suspended' }) => superAdminService.setUserStatus(v.id, v.status),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-users'] }); qc.invalidateQueries({ queryKey: ['admin-stats'] }); },
  });
  const [confirm, setConfirm] = useState<{ user: AdminUser; status: 'active' | 'suspended' } | null>(null);
  const rows = data?.items ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search users…" />
        <Select className="h-10 w-auto" value={lp.filters.status ?? ''} onChange={(e) => lp.setFilter('status', e.target.value)}>
          <option value="">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option>
        </Select>
      </div>
      {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
        : rows.length === 0 ? <EmptyState title="No users" detail="No users match your filters." />
        : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3">User</th><th className="px-4 py-3">Memberships</th><th className="px-4 py-3">Last login</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody>
              {rows.map((u) => {
                const self = u.id === currentUserId;
                return (
                  <tr key={u.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink">{u.name}</span>
                        {u.isSuperAdmin && <Badge tone="violet">Operator</Badge>}
                      </div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </td>
                    <td className="px-4 py-3 text-muted">{u.membershipCount}</td>
                    <td className="px-4 py-3 text-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}</td>
                    <td className="px-4 py-3"><Badge tone={userTone(u.status)}>{u.status}</Badge></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {self ? <span className="text-xs text-muted">You</span>
                          : u.status === 'suspended'
                          ? <Button variant="ghost" size="sm" onClick={() => setConfirm({ user: u, status: 'active' })}><CheckCircle2 size={15} /> Reactivate</Button>
                          : <Button variant="ghost" size="sm" onClick={() => setConfirm({ user: u, status: 'suspended' })}><Ban size={15} /> Suspend</Button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination page={lp.page} pageSize={lp.pageSize} total={data?.total ?? 0} onPage={lp.setPage} />
        </div>
      )}

      <ConfirmDialog open={!!confirm} title={confirm?.status === 'suspended' ? 'Suspend user' : 'Reactivate user'}
        danger={confirm?.status === 'suspended'} confirmLabel={confirm?.status === 'suspended' ? 'Suspend' : 'Reactivate'} loading={setStatus.isPending}
        message={confirm?.status === 'suspended'
          ? `Suspend ${confirm?.user.email}? They will be signed out and unable to sign in until reactivated.`
          : `Reactivate ${confirm?.user.email}?`}
        onConfirm={() => confirm && setStatus.mutateAsync({ id: confirm.user.id, status: confirm.status })
          .then(() => { toast.success(`User ${confirm.status === 'suspended' ? 'suspended' : 'reactivated'}`); setConfirm(null); })
          .catch((e) => toast.error(e?.message ?? 'Update failed'))}
        onClose={() => setConfirm(null)} />
    </Card>
  );
}
