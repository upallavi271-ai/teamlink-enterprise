import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users, CalendarDays, Mail, ArrowRight, Building2, Clock, Check } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { organizationsService } from '@/services/organizations/organizations.service';
import { useOrgStore } from '@/stores/orgStore';
import { useAuthStore } from '@/stores/authStore';
import type {
  InvitableRole, OrganizationDetail, OrganizationSummary,
} from '@/services/organizations/organizations.types';

const initials = (s: string) =>
  s.trim().split(/\s+/).slice(0, 1).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' });

/**
 * Organization Workspace — the tenant picker. It sits OUTSIDE the app shell (no
 * sidebar), because you reach it precisely when you have not yet decided which
 * workspace you are working in.
 */
export function OrganizationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const switchWorkspace = useOrgStore((s) => s.switchWorkspace);
  const currentWorkspaceId = useOrgStore((s) => s.currentWorkspaceId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const listQ = useQuery({ queryKey: ['organizations'], queryFn: () => organizationsService.list() });
  const orgs = useMemo(() => listQ.data ?? [], [listQ.data]);

  // Land on the organization the user is already working in, so the panel is
  // never empty for someone who arrived here just to switch.
  useEffect(() => {
    if (selectedId || orgs.length === 0) return;
    const active = orgs.find((o) => o.defaultWorkspaceId === currentWorkspaceId);
    if (active) setSelectedId(active.id);
  }, [orgs, currentWorkspaceId, selectedId]);

  const detailQ = useQuery({
    queryKey: ['organization', selectedId], enabled: !!selectedId,
    queryFn: () => organizationsService.detail(selectedId!),
  });

  const enter = (org: OrganizationSummary) => {
    if (!org.defaultWorkspaceId) {
      toast.error('This organization has no workspace yet.');
      return;
    }
    switchWorkspace(org.defaultWorkspaceId);
    // A full navigation, so every workspace-scoped query refetches under the new tenant.
    window.location.assign(`${import.meta.env.BASE_URL}app/dashboard`);
  };

  return (
    <div className="min-h-screen bg-surface-2">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-6 py-3.5">
        <div className="flex items-center gap-2 font-display font-semibold text-ink">
          <Building2 size={18} className="text-accent" /> Green Start
        </div>
        <div className="flex items-center gap-3">
          {user?.email && <span className="hidden text-sm text-muted sm:inline">{user.email}</span>}
          <Button variant="secondary" size="sm" onClick={() => navigate('/app/dashboard')}>
            Back to app <ArrowRight size={15} />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink">Organization Workspace</h1>
            <p className="mt-1 text-sm text-muted">Manage your teams and subscription credits.</p>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> New Organization
          </Button>
        </div>

        {listQ.isLoading ? <LoadingState label="Loading your organizations…" />
          : listQ.isError ? <ErrorState message={(listQ.error as Error)?.message ?? 'Could not load organizations.'} onRetry={() => listQ.refetch()} />
          : orgs.length === 0 ? (
            <Card><CardBody>
              <EmptyState title="No organizations yet" detail="Create one to start a workspace."
                action={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={15} /> New Organization</Button>} />
            </CardBody></Card>
          ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            {/* ── the grid ── */}
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">Your Organizations ({orgs.length})</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {orgs.map((org) => {
                  const active = org.id === selectedId;
                  const current = org.defaultWorkspaceId === currentWorkspaceId;
                  return (
                    <button
                      key={org.id} type="button"
                      onClick={() => setSelectedId(org.id)}
                      onDoubleClick={() => enter(org)}
                      className={`rounded-card border p-4 text-left transition-colors ${
                        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <span className="mb-3 flex items-start justify-between gap-2">
                        <span className={`grid h-10 w-10 place-items-center rounded-[10px] text-sm font-semibold ${
                          active ? 'bg-accent text-white' : 'bg-surface-2 text-muted'
                        }`}>{initials(org.name)}</span>
                        <span className="flex items-center gap-1.5">
                          {current && <Badge tone="green">Current</Badge>}
                          <Badge tone={org.owner ? 'orange' : 'neutral'}>{org.roleLabel}</Badge>
                        </span>
                      </span>
                      <span className={`block font-semibold ${active ? 'text-accent' : 'text-ink'}`}>{org.name}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                        <Users size={12} /> {org.memberCount} {org.memberCount === 1 ? 'Member' : 'Members'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ── the detail panel ── */}
            <aside>
              {!selectedId ? (
                <div className="flex h-[260px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line px-6 text-center">
                  <Users size={28} className="text-muted opacity-50" />
                  <p className="text-sm text-muted">Select an organization to view dashboard</p>
                </div>
              ) : (
                <OrgDetailPanel
                  detail={detailQ.data}
                  loading={detailQ.isLoading}
                  error={detailQ.isError}
                  onRetry={() => detailQ.refetch()}
                  summary={orgs.find((o) => o.id === selectedId)}
                  onAddMember={() => setInviteOpen(true)}
                  onEnter={() => {
                    const org = orgs.find((o) => o.id === selectedId);
                    if (org) enter(org);
                  }}
                  isCurrent={orgs.find((o) => o.id === selectedId)?.defaultWorkspaceId === currentWorkspaceId}
                />
              )}
            </aside>
          </div>
        )}
      </main>

      {createOpen && (
        <NewOrganizationModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            setSelectedId(id);
            qc.invalidateQueries({ queryKey: ['organizations'] });
          }}
        />
      )}
      {inviteOpen && selectedId && (
        <InviteMemberModal
          organizationId={selectedId}
          roles={detailQ.data?.roles ?? []}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false);
            qc.invalidateQueries({ queryKey: ['organization', selectedId] });
          }}
        />
      )}
    </div>
  );
}

function OrgDetailPanel({ detail, summary, loading, error, onRetry, onAddMember, onEnter, isCurrent }: {
  detail?: OrganizationDetail;
  summary?: OrganizationSummary;
  loading: boolean; error: boolean; onRetry: () => void;
  onAddMember: () => void; onEnter: () => void; isCurrent: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-sm font-semibold text-accent">
          {initials(detail?.name ?? summary?.name ?? '?')}
        </span>
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{detail?.name ?? summary?.name}</div>
          {summary && (
            <div className="flex items-center gap-1 text-xs text-muted">
              <CalendarDays size={11} /> Joined {day(summary.joinedAt)}
            </div>
          )}
        </div>
      </div>

      <CardBody className="space-y-3">
        {loading ? <LoadingState label="Loading team…" />
          : error ? <ErrorState message="Could not load this organization." onRetry={onRetry} />
          : detail ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Users size={14} className="text-muted" /> Team ({detail.memberCount})
                </span>
                <Button variant="secondary" size="sm" onClick={onAddMember}><Plus size={14} /> Add Member</Button>
              </div>

              {detail.members.length === 0 ? (
                <p className="py-3 text-sm text-muted">No members yet.</p>
              ) : (
                <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {detail.members.map((m) => (
                    <li key={m.userId} className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
                        {initials(m.name || m.email)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{m.email}</span>
                        <span className="mt-0.5 inline-block rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                          {m.roleName}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {detail.pendingInvites.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Pending invitations</p>
                  <ul className="space-y-1.5">
                    {detail.pendingInvites.map((inv) => (
                      <li key={inv.id} className="flex items-center gap-2 rounded-[10px] border border-dashed border-line px-3 py-2">
                        <Clock size={12} className="shrink-0 text-orange" />
                        <span className="min-w-0 flex-1 truncate text-xs text-ink">{inv.email}</span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{inv.roleName}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Button size="sm" className="w-full" disabled={isCurrent} onClick={onEnter}>
                {isCurrent ? <><Check size={15} /> You are here</> : <>Open this organization <ArrowRight size={15} /></>}
              </Button>
            </>
          ) : null}
      </CardBody>
    </Card>
  );
}

function NewOrganizationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [err, setErr] = useState('');

  const create = useMutation({
    mutationFn: () => organizationsService.create({
      name: name.trim(), workspaceName: workspaceName.trim() || undefined,
    }),
    onSuccess: (res) => { toast.success(`Created “${res.name}”`); onCreated(res.id); },
    onError: (e: Error) => { const m = e?.message ?? 'Could not create the organization'; setErr(m); toast.error(m); },
  });

  const submit = () => {
    if (name.trim().length < 2) { setErr('Give the organization a name.'); return; }
    setErr('');
    create.mutate();
  };

  return (
    <Modal open onClose={onClose} size="sm" title="New Organization"
      footer={<>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={create.isPending} onClick={submit}>Create</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          An organization holds your workspaces, team and subscription credits. You will be its owner.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="org-name" className="block text-xs font-semibold uppercase tracking-wide text-muted">Organization name</label>
          <Input id="org-name" value={name} invalid={!!err} placeholder="Teamlink Medical"
            onChange={(e) => setName(e.target.value)} />
          {err && <p className="text-xs text-red">{err}</p>}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ws-name" className="block text-xs font-semibold uppercase tracking-wide text-muted">First workspace (optional)</label>
          <Input id="ws-name" value={workspaceName} placeholder="Defaults to the organization name"
            onChange={(e) => setWorkspaceName(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function InviteMemberModal({ organizationId, roles, onClose, onInvited }: {
  organizationId: string; roles: InvitableRole[]; onClose: () => void; onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const invite = useMutation({
    mutationFn: () => organizationsService.invite(organizationId, { email: email.trim(), roleKeys: picked }),
    onSuccess: (res) => {
      toast.success(
        res.delivery === 'demo'
          ? `Invitation created for ${res.email} (demo mode — no email is sent).`
          : `Invitation sent to ${res.email}.`,
      );
      if (res.ignoredRoles.length) {
        toast.info(`Only “${res.role.name}” was granted — a membership carries one role.`);
      }
      onInvited();
    },
    onError: (e: Error) => { const m = e?.message ?? 'Could not send the invitation'; setErr(m); toast.error(m); },
  });

  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const submit = () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErr('Enter a valid email address.'); return; }
    if (picked.length === 0) { setErr('Choose at least one role.'); return; }
    setErr('');
    invite.mutate();
  };

  return (
    <Modal open onClose={onClose} size="sm" title="Invite Team Member"
      footer={<>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={invite.isPending} disabled={!email.trim() || picked.length === 0} onClick={submit}>
          <Mail size={15} /> Send Invite
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-xs text-muted">Enter an email address to send an invitation.</p>

        <div className="space-y-1.5">
          <label htmlFor="inv-email" className="block text-xs font-semibold uppercase tracking-wide text-muted">Email address</label>
          <span className="relative block">
            <Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input id="inv-email" type="email" className="pl-9" value={email} invalid={!!err && !email.trim()}
              placeholder="colleague@example.com" onChange={(e) => setEmail(e.target.value)} />
          </span>
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted">Assign roles</span>
          {roles.length === 0 ? (
            <p className="text-sm text-muted">No invitable roles in this organization yet.</p>
          ) : (
            <div className="space-y-1.5">
              {roles.map((r) => {
                const on = picked.includes(r.key);
                return (
                  <label key={r.key}
                    className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3 py-2.5 transition-colors ${
                      on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                    }`}>
                    <Checkbox checked={on} onChange={() => toggle(r.key)} aria-label={r.name} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{r.name}</span>
                      {r.description && <span className="block truncate text-xs text-muted">{r.description}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {picked.length > 1 && (
          <p className="text-xs text-muted">
            A membership carries one role — the first you picked is the one granted.
          </p>
        )}
        {err && <p className="text-sm text-red">{err}</p>}
      </div>
    </Modal>
  );
}
