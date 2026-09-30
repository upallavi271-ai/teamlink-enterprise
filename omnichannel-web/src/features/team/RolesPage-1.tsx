import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Lock, ShieldCheck, Layers } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
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
import type { PermissionDef, Policy, RoleInput, TeamRole } from '@/types';

/**
 * Roles & permissions. Rendered inside TeamPage's "Roles & Permissions" tab —
 * there is no second route for it, so the page header (and its RefreshButton)
 * belong to TeamPage and are deliberately absent here.
 *
 * `team/roles` is not a paginated endpoint: it answers a plain TeamRole[]
 * (see services/team/team.service.ts). Roles are a short list, so search and
 * paging are done client-side over that payload, using the same useListParams
 * hook the server-paged modules use so the toolbar behaves identically.
 *
 * A role's effective permissions come from TWO sources — the keys set directly
 * on the role, and the keys carried by the policies attached to it. This screen
 * never merges the two into one number: `permissionKeys` stays "direct", and
 * anything a policy contributes is labelled as such, here and in the editor.
 */
export function RolesPanel() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('role.manage');
  const qc = useQueryClient();

  const rolesQ = useQuery({
    queryKey: ['team-roles', orgId],
    queryFn: () => teamService.listRoles(orgId),
    enabled: !!orgId,
  });
  const permsQ = useQuery({ queryKey: ['team-permissions'], queryFn: () => teamService.listPermissions() });
  /**
   * The full policy catalogue, for the editor's attach list and for showing what
   * each attached policy actually grants. `team/roles` embeds only {id,name,
   * description} per policy, so the permission keys have to come from here.
   *
   * Deliberately NOT part of the error gate: if the Policy resource is missing
   * or failing, roles must still be listed and edited. The editor then says the
   * catalogue is unavailable rather than pretending there are no policies.
   */
  const policiesQ = useQuery({
    queryKey: ['policies', orgId, 'all'],
    queryFn: () => policiesService.list(orgId, { page: 1, pageSize: 200 }),
    enabled: !!orgId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['team-roles', orgId] });

  const create = useMutation({
    mutationFn: (input: RoleInput) => teamService.createRole(orgId, input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; input: Partial<RoleInput> }) => teamService.updateRole(orgId, v.id, v.input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => teamService.deleteRole(orgId, id),
    onSuccess: invalidate,
  });
  /** PUT team/roles/:roleKey/policies — replaces the whole set in one call. */
  const setPolicies = useMutation({
    mutationFn: (v: { roleKey: string; policyIds: string[] }) => policiesService.setRolePolicies(orgId, v.roleKey, v.policyIds),
    onSuccess: () => {
      invalidate();
      // roleCount on every policy just moved.
      qc.invalidateQueries({ queryKey: ['policies', orgId] });
    },
  });

  const lp = useListParams({ pageSize: 10 });
  const [editing, setEditing] = useState<TeamRole | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [toDelete, setToDelete] = useState<TeamRole | null>(null);

  const openNew = () => { setEditing(null); setIsNew(true); };
  const openEdit = (r: TeamRole) => { setIsNew(false); setEditing(r); };
  const closeEditor = () => { setIsNew(false); setEditing(null); };

  const roles = useMemo(() => rolesQ.data ?? [], [rolesQ.data]);
  const perms = permsQ.data ?? [];
  const allPolicies = useMemo(() => policiesQ.data?.items ?? [], [policiesQ.data]);
  const policyPerms = useMemo(
    () => new Map(allPolicies.map((p) => [p.id, p.permissionKeys])),
    [allPolicies],
  );

  const filtered = useMemo(() => {
    const q = lp.search.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((r) => `${r.name} ${r.description ?? ''}`.toLowerCase().includes(q));
  }, [roles, lp.search]);

  const total = filtered.length;
  const lastPage = Math.max(1, Math.ceil(total / lp.pageSize));
  const page = Math.min(lp.page, lastPage);
  const rows = filtered.slice((page - 1) * lp.pageSize, page * lp.pageSize);

  const createBtn = canManage
    ? <Button size="sm" onClick={openNew}><Plus size={15} /> New role</Button>
    : undefined;

  // A query with `enabled: false` stays isPending forever in TanStack Query v5,
  // so the no-workspace case is answered before the loading gate is reached.
  if (!orgId) {
    return <Card><EmptyState title="No workspace selected" detail="Pick a workspace to manage its roles." /></Card>;
  }
  if (rolesQ.isPending || permsQ.isPending || policiesQ.isPending) return <Card><LoadingState /></Card>;
  if (rolesQ.isError) return <Card><ErrorState message="Could not load roles." onRetry={() => rolesQ.refetch()} /></Card>;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search roles…" />
        <span className="text-sm text-muted">
          {total} role{total === 1 ? '' : 's'} · {perms.length} permissions
        </span>
        <div className="ml-auto">{createBtn}</div>
      </div>

      {total === 0 ? (
        <EmptyState
          title={lp.search ? 'No roles match that search' : 'No roles yet'}
          detail={lp.search
            ? 'Clear the search to see every role in this workspace.'
            : 'Create a role to group permissions and assign them to your team.'}
          action={lp.search
            ? <Button variant="secondary" size="sm" onClick={() => lp.setSearch('')}>Clear search</Button>
            : createBtn}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Members</th>
                <th className="px-4 py-3 font-medium">Permissions</th>
                <th className="px-4 py-3 font-medium">Policies attached</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      {r.isSystem
                        ? <Lock size={13} className="shrink-0 text-muted" />
                        : <ShieldCheck size={13} className="shrink-0 text-accent" />}
                      {r.name}
                      {r.isSystem && <Badge tone="neutral">System</Badge>}
                    </div>
                    {r.description && <div className="text-xs text-muted">{r.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-muted">{r.memberCount}</td>
                  <td className="px-4 py-3">
                    <PermissionCell role={r} policyPerms={policyPerms} />
                  </td>
                  <td className="px-4 py-3">
                    <PolicyCell role={r} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)}
                        aria-label={r.isSystem || !canManage ? `View ${r.name}` : `Edit ${r.name}`}
                        title={r.isSystem ? 'System role — read-only' : 'Edit role'}>
                        <Pencil size={15} />
                      </Button>
                      {canManage && !r.isSystem && (
                        <Button variant="ghost" size="sm" aria-label={`Delete ${r.name}`} onClick={() => setToDelete(r)}>
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={lp.pageSize} total={total} onPage={lp.setPage} />
        </div>
      )}

      {(isNew || editing) && (
        <RoleEditor
          role={editing}
          perms={perms}
          allPolicies={allPolicies}
          policiesUnavailable={policiesQ.isError}
          readOnly={!canManage || (editing?.isSystem ?? false)}
          saving={create.isPending || update.isPending || setPolicies.isPending}
          onClose={closeEditor}
          onSave={(input, policyIds) => {
            // The role itself and its policy set are two endpoints. The role is
            // saved first because a new one has no key to address until the
            // server answers; policyIds is undefined when the set is unchanged,
            // so an ordinary edit still makes exactly one request.
            const run = async () => {
              const saved = isNew
                ? await create.mutateAsync(input)
                : await update.mutateAsync({ id: editing!.id, input });
              if (policyIds) await setPolicies.mutateAsync({ roleKey: saved.key, policyIds });
            };
            run()
              .then(() => { toast.success(isNew ? 'Role created' : 'Role updated'); closeEditor(); })
              .catch((e) => toast.error(e?.message ?? 'Save failed'));
          }}
        />
      )}

      <ConfirmDialog open={!!toDelete} title="Delete role" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete the "${toDelete?.name}" role? Members using it will need another role. This cannot be undone.`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id)
          .then(() => { toast.success('Role deleted'); setToDelete(null); })
          .catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </Card>
  );
}

/**
 * Permissions set DIRECTLY on the role, plus — as a separate line, never added
 * into the first number — how many MORE the attached policies contribute.
 * Needs the policy catalogue for the keys; when that is unavailable only the
 * direct count is shown, which stays true.
 */
function PermissionCell({ role, policyPerms }: { role: TeamRole; policyPerms: Map<string, string[]> }) {
  const extra = useMemo(() => {
    const direct = new Set(role.permissionKeys);
    const added = new Set<string>();
    for (const p of role.policies ?? []) {
      for (const k of policyPerms.get(p.id) ?? []) if (!direct.has(k)) added.add(k);
    }
    return added.size;
  }, [role, policyPerms]);

  return (
    <div>
      <span className="text-muted">{role.permissionKeys.length} direct</span>
      {extra > 0 && (
        <span className="block text-xs text-accent" title="Granted by the attached policies, on top of the direct keys">
          +{extra} via policies
        </span>
      )}
    </div>
  );
}

/**
 * Policies attached to a role, straight from `TeamRole.policies` — the field
 * `GET team/roles` now populates. Nothing here infers a policy from a
 * permission key, and no extra request is made per row.
 *
 * The field stays optional (see src/types/index.ts): mock mode and any gs-api
 * older than the Policy resource can omit it. Absent and empty both render an
 * em-dash, which is the honest answer in either case.
 */
function PolicyCell({ role }: { role: TeamRole }) {
  const policies = role.policies ?? [];
  if (policies.length === 0) return <span className="text-muted" title="No policies attached">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {policies.map((p) => <Badge key={p.id} tone="green" title={p.description ?? p.name}>{p.name}</Badge>)}
    </div>
  );
}

function RoleEditor({ role, perms, allPolicies, policiesUnavailable, readOnly, saving, onClose, onSave }: {
  role: TeamRole | null;
  perms: PermissionDef[];
  allPolicies: Policy[];
  policiesUnavailable: boolean;
  readOnly: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (input: RoleInput, policyIds: string[] | undefined) => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissionKeys ?? []));
  const [nameErr, setNameErr] = useState('');

  const initialPolicyIds = useMemo(() => (role?.policies ?? []).map((p) => p.id), [role]);
  const [policyIds, setPolicyIds] = useState<Set<string>>(() => new Set(initialPolicyIds));

  const policyById = useMemo(() => new Map(allPolicies.map((p) => [p.id, p])), [allPolicies]);

  /**
   * permission key -> names of the ATTACHED policies granting it. This is the
   * whole distinction the editor has to make legible: a checkbox means "granted
   * directly on this role", and a row tagged here is granted whether or not the
   * checkbox is ticked. The two are never merged, so unticking a box tells you
   * exactly what the role loses and what the policy keeps giving it.
   */
  const inheritedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const id of policyIds) {
      const p = policyById.get(id);
      if (!p) continue;
      for (const k of p.permissionKeys) {
        const at = m.get(k);
        if (at) at.push(p.name); else m.set(k, [p.name]);
      }
    }
    return m;
  }, [policyIds, policyById]);

  const fromPoliciesOnly = useMemo(
    () => [...inheritedBy.keys()].filter((k) => !selected.has(k)).length,
    [inheritedBy, selected],
  );
  const effectiveCount = selected.size + fromPoliciesOnly;

  const toggle = (key: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleGroup = (list: PermissionDef[], on: boolean) => setSelected((s) => {
    const next = new Set(s);
    for (const p of list) { if (on) next.add(p.key); else next.delete(p.key); }
    return next;
  });
  const togglePolicy = (id: string) => setPolicyIds((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const policiesChanged = useMemo(() => {
    const a = [...policyIds].sort().join(',');
    const b = [...initialPolicyIds].sort().join(',');
    return a !== b;
  }, [policyIds, initialPolicyIds]);

  const submit = () => {
    if (!name.trim()) { setNameErr('Role name is required.'); return; }
    onSave(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        permissionKeys: [...selected],
      },
      policiesChanged ? [...policyIds] : undefined,
    );
  };

  const title = role ? (readOnly ? `Role: ${role.name}` : `Edit role: ${role.name}`) : 'New role';

  return (
    <Modal open onClose={onClose} title={title} size="lg"
      footer={readOnly
        ? <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={submit}>{role ? 'Save changes' : 'Create role'}</Button>
          </>
        )}>
      <div className="space-y-4">
        {readOnly && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            {role?.isSystem
              ? 'System roles are read-only, policies included. Create a new role with the same permissions to customise it.'
              : 'You do not have the role.manage permission, so this role cannot be changed.'}
          </p>
        )}

        <Field label="Role name" error={nameErr}>
          <Input value={name} invalid={!!nameErr} disabled={readOnly} maxLength={60}
            onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(''); }}
            placeholder="e.g. Marketing Lead" />
        </Field>
        <Field label="Description" hint="What this role is for">
          <Textarea rows={2} value={description} disabled={readOnly} maxLength={200}
            onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {/* Source 1 of a role's permissions: attached policies. */}
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink">
            <Layers size={14} className="text-accent" />
            Policies attached
            <span className="text-xs font-normal text-muted">({policyIds.size} of {allPolicies.length})</span>
          </div>
          {policiesUnavailable ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
              The policy list could not be loaded, so policies cannot be changed here right now. The role's own
              permissions below are unaffected.
            </p>
          ) : allPolicies.length === 0 ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
              No policies exist in this workspace yet. Create one in the Policies tab, then attach it here.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {allPolicies.map((p) => (
                <label key={p.id} className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-sm hover:bg-surface-2">
                  <Checkbox className="mt-0.5" checked={policyIds.has(p.id)} disabled={readOnly}
                    onChange={() => togglePolicy(p.id)} />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{p.name}</span>
                    {p.description && <span className="block text-xs text-muted">{p.description}</span>}
                    <span className="block text-xs text-muted">{p.permissionKeys.length} permission{p.permissionKeys.length === 1 ? '' : 's'}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {policiesChanged && (
            <p className="mt-1.5 text-xs text-accent">
              Saving replaces this role's whole policy set.
            </p>
          )}
        </div>

        {/* Source 2: keys set directly on the role. Counted separately, always. */}
        <div>
          <div className="mb-2 text-sm font-medium text-ink">
            Permissions{' '}
            <span className="text-xs font-normal text-muted">
              ({selected.size} direct
              {fromPoliciesOnly > 0 && <> · {fromPoliciesOnly} from policies · {effectiveCount} effective</>})
            </span>
          </div>
          {fromPoliciesOnly > 0 && (
            <p className="mb-2 rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink">
              Highlighted rows are already granted by an attached policy. The checkbox still means “granted directly on
              this role” — leave it clear to let the policy own that permission, tick it to keep it if the policy is
              ever detached.
            </p>
          )}
          <PermissionPicker perms={perms} selected={selected} inheritedBy={inheritedBy} readOnly={readOnly}
            onToggle={toggle} onToggleGroup={toggleGroup} />
        </div>
      </div>
    </Modal>
  );
}
