import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Layers } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { teamService } from '@/services/team/team.service';
import { policiesService } from '@/services/policies/policies.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { PermissionPicker } from './PermissionPicker';
import type { PermissionDef, Policy, PolicyInput } from '@/types';

/**
 * Policies — named permission bundles that roles attach.
 *
 * Rendered inside TeamPage's third tab, beside Members and Roles & Permissions.
 * It is the same administrative object as a role (both are collections of
 * permission keys, both are gated on `role.manage`), it is only ever reached
 * from this screen, and navigation.ts already routes /app/roles here — so it
 * needs no route and no sidebar entry of its own. The page header and its
 * RefreshButton belong to TeamPage and are deliberately absent here.
 *
 * `GET policies` IS paginated (unlike `team/roles`), so search and paging go to
 * the server through useListParams, exactly like the other list modules.
 */
export function PoliciesPanel() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('role.manage');
  const qc = useQueryClient();
  const lp = useListParams({ pageSize: 10 });

  const listQ = useQuery({
    queryKey: ['policies', orgId, lp.params],
    queryFn: () => policiesService.list(orgId, lp.params),
    enabled: !!orgId,
  });
  const permsQ = useQuery({ queryKey: ['team-permissions'], queryFn: () => teamService.listPermissions() });

  // Attaching or detaching a policy changes a role's effective permissions, so
  // the roles list is invalidated alongside the policies list on every write.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['policies', orgId] });
    qc.invalidateQueries({ queryKey: ['team-roles', orgId] });
  };

  const create = useMutation({ mutationFn: (input: PolicyInput) => policiesService.create(orgId, input), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (v: { id: string; input: Partial<PolicyInput> }) => policiesService.update(orgId, v.id, v.input),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => policiesService.remove(orgId, id), onSuccess: invalidate });

  const [editing, setEditing] = useState<Policy | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [toDelete, setToDelete] = useState<Policy | null>(null);

  const openNew = () => { setEditing(null); setIsNew(true); };
  const openEdit = (p: Policy) => { setIsNew(false); setEditing(p); };
  const closeEditor = () => { setIsNew(false); setEditing(null); };

  const perms = permsQ.data ?? [];
  const rows = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;

  const createBtn = canManage
    ? <Button size="sm" onClick={openNew}><Plus size={15} /> New policy</Button>
    : undefined;

  // A query with `enabled: false` stays isPending forever in TanStack Query v5,
  // so the no-workspace case is answered before the loading gate is reached.
  if (!orgId) {
    return <Card><EmptyState title="No workspace selected" detail="Pick a workspace to manage its policies." /></Card>;
  }
  if (listQ.isPending || permsQ.isPending) return <Card><LoadingState /></Card>;
  if (listQ.isError) return <Card><ErrorState message="Could not load policies." onRetry={() => listQ.refetch()} /></Card>;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search policies…" />
        <span className="text-sm text-muted">
          {total} polic{total === 1 ? 'y' : 'ies'}
        </span>
        <div className="ml-auto">{createBtn}</div>
      </div>

      {total === 0 ? (
        <EmptyState
          title={lp.search ? 'No policies match that search' : 'No policies yet'}
          detail={lp.search
            ? 'Clear the search to see every policy in this workspace.'
            : 'A policy is a named bundle of permissions. Create one, then attach it to any role from the Roles & Permissions tab.'}
          action={lp.search
            ? <Button variant="secondary" size="sm" onClick={() => lp.setSearch('')}>Clear search</Button>
            : createBtn}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Policy</th>
                <th className="px-4 py-3 font-medium">Permissions</th>
                <th className="px-4 py-3 font-medium">Roles using it</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      <Layers size={13} className="shrink-0 text-accent" />
                      {p.name}
                    </div>
                    <div className="font-mono text-[11px] text-muted">{p.key}</div>
                    {p.description && <div className="text-xs text-muted">{p.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-muted">{p.permissionKeys.length}</td>
                  <td className="px-4 py-3">
                    {p.roleCount === 0
                      ? <span className="text-muted" title="Not attached to any role">—</span>
                      : <Badge tone="green">{p.roleCount}</Badge>}
                  </td>
                  <td className="px-4 py-3 text-muted">{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}
                        aria-label={canManage ? `Edit ${p.name}` : `View ${p.name}`}
                        title={canManage ? 'Edit policy' : 'View policy'}>
                        <Pencil size={15} />
                      </Button>
                      {canManage && (
                        <Button variant="ghost" size="sm" aria-label={`Delete ${p.name}`} onClick={() => setToDelete(p)}>
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={listQ.data?.page ?? lp.page} pageSize={listQ.data?.pageSize ?? lp.pageSize} total={total} onPage={lp.setPage} />
        </div>
      )}

      {(isNew || editing) && (
        <PolicyEditor
          policy={editing}
          perms={perms}
          readOnly={!canManage}
          saving={create.isPending || update.isPending}
          onClose={closeEditor}
          onSave={(input) => {
            const p = isNew
              ? create.mutateAsync(input)
              : update.mutateAsync({
                  id: editing!.id,
                  // `key` is immutable server-side — PATCH carries only what can change.
                  input: { name: input.name, description: input.description, permissionKeys: input.permissionKeys },
                });
            p.then(() => { toast.success(isNew ? 'Policy created' : 'Policy updated'); closeEditor(); })
              .catch((e) => toast.error(e?.message ?? 'Save failed'));
          }}
        />
      )}

      <ConfirmDialog open={!!toDelete} title="Delete policy" danger confirmLabel="Delete" loading={remove.isPending}
        message={toDelete && toDelete.roleCount > 0
          ? `Delete "${toDelete.name}"? ${toDelete.roleCount} role${toDelete.roleCount === 1 ? '' : 's'} attach it and will lose the permissions it grants. This cannot be undone.`
          : `Delete the "${toDelete?.name}" policy? This cannot be undone.`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id)
          .then(() => { toast.success('Policy deleted'); setToDelete(null); })
          .catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </Card>
  );
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function PolicyEditor({ policy, perms, readOnly, saving, onClose, onSave }: {
  policy: Policy | null;
  perms: PermissionDef[];
  readOnly: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (input: PolicyInput) => void;
}) {
  const [name, setName] = useState(policy?.name ?? '');
  const [key, setKey] = useState(policy?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!policy);
  const [description, setDescription] = useState(policy?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(policy?.permissionKeys ?? []));
  const [nameErr, setNameErr] = useState('');
  const [keyErr, setKeyErr] = useState('');

  const effectiveKey = keyTouched ? key : slugify(name);

  const toggle = (k: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleGroup = (list: PermissionDef[], on: boolean) => setSelected((s) => {
    const next = new Set(s);
    for (const p of list) { if (on) next.add(p.key); else next.delete(p.key); }
    return next;
  });

  const submit = () => {
    if (!name.trim()) { setNameErr('Policy name is required.'); return; }
    if (!effectiveKey) { setKeyErr('A key is required — it is how the API addresses this policy.'); return; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(effectiveKey)) { setKeyErr('Use lowercase letters, numbers and hyphens.'); return; }
    if (selected.size === 0) { setNameErr('Pick at least one permission — an empty policy grants nothing.'); return; }
    onSave({
      key: effectiveKey,
      name: name.trim(),
      description: description.trim() || undefined,
      permissionKeys: [...selected],
    });
  };

  const title = policy ? (readOnly ? `Policy: ${policy.name}` : `Edit policy: ${policy.name}`) : 'New policy';

  return (
    <Modal open onClose={onClose} title={title} size="lg"
      footer={readOnly
        ? <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={submit}>{policy ? 'Save changes' : 'Create policy'}</Button>
          </>
        )}>
      <div className="space-y-4">
        {readOnly && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            You do not have the role.manage permission, so this policy cannot be changed.
          </p>
        )}

        <Field label="Policy name" error={nameErr}>
          <Input value={name} invalid={!!nameErr} disabled={readOnly} maxLength={60}
            onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(''); }}
            placeholder="e.g. Campaign Operations" />
        </Field>
        <Field label="Key" error={keyErr}
          hint={policy ? 'The key is fixed once a policy exists.' : 'Stable identifier used by the API. Derived from the name unless you change it.'}>
          <Input value={effectiveKey} invalid={!!keyErr} disabled={readOnly || !!policy} maxLength={60}
            className="font-mono"
            onChange={(e) => { setKeyTouched(true); setKey(e.target.value); if (keyErr) setKeyErr(''); }}
            placeholder="campaign-ops" />
        </Field>
        <Field label="Description" hint="What this bundle is for">
          <Textarea rows={2} value={description} disabled={readOnly} maxLength={200}
            onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {policy && policy.roleCount > 0 && !readOnly && (
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink">
            {policy.roleCount} role{policy.roleCount === 1 ? '' : 's'} attach this policy. Changing its permissions changes
            what those roles can do, immediately.
          </p>
        )}

        <div>
          <div className="mb-2 text-sm font-medium text-ink">
            Permissions <span className="text-xs font-normal text-muted">({selected.size} selected)</span>
          </div>
          <PermissionPicker perms={perms} selected={selected} readOnly={readOnly}
            onToggle={toggle} onToggleGroup={toggleGroup} />
        </div>
      </div>
    </Modal>
  );
}
