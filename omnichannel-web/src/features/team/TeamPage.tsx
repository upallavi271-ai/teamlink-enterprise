import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tabs } from '@/components/ui/Tabs';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { teamService } from '@/services/team/team.service';
import { useOrgStore } from '@/stores/orgStore';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/components/toast/toastStore';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { RolesPanel } from './RolesPage';
import { PoliciesPanel } from './PoliciesPage';
import type { MemberStatus, TeamMember } from '@/types';

const statusTone: Record<MemberStatus, 'green' | 'blue' | 'neutral'> = {
  active: 'green', invited: 'blue', suspended: 'neutral',
};

/**
 * The whole RBAC admin surface for a workspace, reached at /app/roles.
 *
 * Policies live here as a THIRD TAB rather than a route of their own:
 * navigation.ts is the single source of truth for routes and the sidebar, and
 * its Admin group deliberately carries one entry ("Roles & Permissions" ->
 * /app/roles -> this page). A policy is the same kind of object as a role — a
 * named set of permission keys, gated on the same `role.manage` — and is only
 * ever reached while administering roles, so it belongs beside them under one
 * page header instead of adding a sidebar row and a REAL_PAGES entry. Routing
 * needed no change when the Roles tab landed, and it needs none now.
 */
export function TeamPage() {
  const [tab, setTab] = useState('members');
  return (
    <div>
      <PageHeader title="Team & Roles" subtitle="Manage members, roles, policies and permissions for this workspace"
        actions={<RefreshButton keys={['team-members', 'team-roles', 'team-permissions', 'policies']} />} />
      <Tabs
        tabs={[
          { key: 'members', label: 'Members' },
          { key: 'roles', label: 'Roles & Permissions' },
          { key: 'policies', label: 'Policies' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="pt-4">
        {tab === 'members' ? <MembersTab /> : tab === 'roles' ? <RolesPanel /> : <PoliciesPanel />}
      </div>
    </div>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────
function MembersTab() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const currentUserId = useAuthStore((s) => s.user?.id);
  const canManage = useCan('team.manage');
  const lp = useListParams({ sort: 'createdAt' });
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['team-members', orgId, lp.params],
    queryFn: () => teamService.listMembers(orgId, lp.params),
    enabled: !!orgId,
  });
  const rolesQ = useQuery({ queryKey: ['team-roles', orgId], queryFn: () => teamService.listRoles(orgId), enabled: !!orgId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['team-members', orgId] });

  const changeRole = useMutation({ mutationFn: (v: { id: string; roleKey: string }) => teamService.changeRole(orgId, v.id, v.roleKey), onSuccess: invalidate });
  const setStatus = useMutation({ mutationFn: (v: { id: string; status: 'active' | 'suspended' }) => teamService.setStatus(orgId, v.id, v.status), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => teamService.removeMember(orgId, id), onSuccess: invalidate });
  const invite = useMutation({ mutationFn: (v: { email: string; roleKey: string }) => teamService.invite(orgId, v), onSuccess: invalidate });

  const roles = rolesQ.data ?? [];
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [emailErr, setEmailErr] = useState('');
  const [toRemove, setToRemove] = useState<TeamMember | null>(null);

  const openInvite = () => { setEmail(''); setRoleKey(roles.find((r) => r.key !== 'owner')?.key ?? roles[0]?.key ?? ''); setEmailErr(''); setInviteOpen(true); };
  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setEmailErr('Enter a valid email address.'); return; }
    if (!roleKey) { setEmailErr('Pick a role.'); return; }
    invite.mutateAsync({ email: email.trim(), roleKey })
      .then((r) => { toast.success(r.delivery === 'demo' ? 'Invite created (demo — no email sent)' : 'Invitation sent'); setInviteOpen(false); })
      .catch((e) => toast.error(e?.message ?? 'Invite failed'));
  };

  const rows = data?.items ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search members…" />
        <Select className="h-10 w-auto" value={lp.filters.status ?? ''} onChange={(e) => lp.setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="suspended">Suspended</option>
        </Select>
        <Select className="h-10 w-auto" value={lp.filters.roleKey ?? ''} onChange={(e) => lp.setFilter('roleKey', e.target.value)}>
          <option value="">All roles</option>
          {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </Select>
        <div className="ml-auto">
          {canManage && <Button size="sm" onClick={openInvite}><UserPlus size={15} /> Invite member</Button>}
        </div>
      </div>

      {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
        : rows.length === 0 ? <EmptyState title="No members" detail="Invite teammates to collaborate in this workspace." action={canManage ? <Button size="sm" onClick={openInvite}><UserPlus size={15} /> Invite member</Button> : undefined} />
        : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3">Member</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Joined</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody>
              {rows.map((m) => {
                const self = m.user.id === currentUserId;
                return (
                  <tr key={m.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{m.user.name}{self && <span className="ml-1 text-xs text-muted">(you)</span>}</div>
                      <div className="text-xs text-muted">{m.user.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      {canManage && !self ? (
                        <Select className="h-9 w-40" value={m.role.key}
                          onChange={(e) => changeRole.mutateAsync({ id: m.id, roleKey: e.target.value }).then(() => toast.success('Role updated')).catch((err) => toast.error(err?.message ?? 'Failed'))}>
                          {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                        </Select>
                      ) : <Badge tone="neutral">{m.role.name}</Badge>}
                    </td>
                    <td className="px-4 py-3"><Badge tone={statusTone[m.status]}>{m.status}</Badge></td>
                    <td className="px-4 py-3 text-muted">{new Date(m.joinedAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {canManage && !self && m.status !== 'invited' && (
                          <Button variant="ghost" size="sm"
                            onClick={() => setStatus.mutateAsync({ id: m.id, status: m.status === 'active' ? 'suspended' : 'active' }).then(() => toast.success('Status updated')).catch((err) => toast.error(err?.message ?? 'Failed'))}>
                            {m.status === 'active' ? 'Deactivate' : 'Activate'}
                          </Button>
                        )}
                        {canManage && !self && (
                          <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => setToRemove(m)}><Trash2 size={15} /></Button>
                        )}
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

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite a member"
        footer={<><Button variant="secondary" size="sm" onClick={() => setInviteOpen(false)}>Cancel</Button><Button size="sm" loading={invite.isPending} onClick={submitInvite}>Send invite</Button></>}>
        <form onSubmit={submitInvite} className="space-y-4">
          <Field label="Email address" error={emailErr}><Input type="email" value={email} invalid={!!emailErr} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" /></Field>
          <Field label="Role"><Select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>{roles.filter((r) => r.key !== 'owner').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></Field>
        </form>
      </Modal>

      <ConfirmDialog open={!!toRemove} title="Remove member" danger confirmLabel="Remove" loading={remove.isPending}
        message={`Remove ${toRemove?.user.name} from this workspace? They will lose access immediately.`}
        onConfirm={() => toRemove && remove.mutateAsync(toRemove.id).then(() => { toast.success('Member removed'); setToRemove(null); }).catch((e) => toast.error(e?.message ?? 'Remove failed'))}
        onClose={() => setToRemove(null)} />
    </Card>
  );
}
