import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, Search, Table2, ChevronLeft, ChevronRight, Copy, Check, ShieldCheck, Users,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useCan } from '@/features/auth/useCan';
import { webformsService } from '@/services/webforms/webforms.service';
import { crmFieldsService } from '@/services/crm/crmFields.service';
import { teamService } from '@/services/team/team.service';
import { collectAll } from '@/lib/collectAll';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { PageHeader } from '@/components/layout/PageHeader';
import { config } from '@/services/config';
import type { CustomField, TeamMember, WebForm, WebFormInput } from '@/types';

const PAGE_SIZES = [10, 20, 50, 100];
const publicUrl = (slug: string) => `${config.apiBaseUrl}/public/forms/${slug}`;
const initials = (s: string) =>
  s.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── page ─────────────────────────────────────────────────────────────────────
export function WebFormsPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('customer.edit');
  const canViewCustomers = useCan('customer.view');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  // Arriving from a contact's "via <form>" link highlights that row.
  const highlight = sp.get('highlight');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [editing, setEditing] = useState<{ form: WebForm | null } | null>(null);
  const [viewing, setViewing] = useState<WebForm | null>(null);
  const [toDelete, setToDelete] = useState<WebForm | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = useMemo(
    () => ({ page, pageSize, search: debounced || undefined, sort: 'createdAt', dir: 'asc' as const }),
    [page, pageSize, debounced],
  );

  const list = useQuery({
    queryKey: ['web-forms', orgId, params], queryFn: () => webformsService.list(orgId, params), enabled: !!orgId,
  });

  // The pickers and the table's two reference columns all read the same two
  // lookups, so they're fetched once here and shared rather than per-modal.
  const fields = useQuery({
    queryKey: ['crm-fields', orgId, 'all'], enabled: !!orgId,
    queryFn: () => collectAll<CustomField>((p, ps) => crmFieldsService.list(orgId, { page: p, pageSize: ps })),
  });
  const members = useQuery({
    queryKey: ['team-members', orgId, 'all'], enabled: !!orgId,
    queryFn: () => collectAll<TeamMember>((p, ps) => teamService.listMembers(orgId, { page: p, pageSize: ps })),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['web-forms', orgId] });
  const create = useMutation({
    mutationFn: (i: WebFormInput) => webformsService.create(orgId, i),
    onSuccess: () => { toast.success('Form created'); setEditing(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not create the form'),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; input: Partial<WebFormInput> }) => webformsService.update(orgId, v.id, v.input),
    onSuccess: () => { toast.success('Form updated'); setEditing(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not save the form'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => webformsService.remove(orgId, id),
    onSuccess: () => { toast.success('Form deleted'); setToDelete(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not delete the form'),
  });

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const memberName = useMemo(
    () => Object.fromEntries((members.data ?? []).map((m) => [m.user.id, m.user.name || m.user.email])),
    [members.data],
  );

  return (
    <div>
      <PageHeader
        title="Forms"
        subtitle="Manage templates and custom fields for your customers."
        actions={canManage && (
          <Button size="sm" className="shrink-0" onClick={() => setEditing({ form: null })}>
            <Plus size={15} /> New Form
          </Button>
        )}
      />

      {/* Search sits on the page, above the table card — as in the reference. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] max-w-[320px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search forms..."
            aria-label="Search forms"
            className="h-9 w-full rounded-[10px] border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? <LoadingState label="Loading forms…" />
          : list.isError ? <ErrorState message={(list.error as Error)?.message ?? 'Could not load forms.'} onRetry={() => list.refetch()} />
          : rows.length === 0 ? (
            <EmptyState
              title={debounced ? 'No matching forms' : 'No forms yet'}
              detail={debounced ? 'Try a different search term.' : 'Create a form to capture leads straight into your CRM.'}
              action={canManage && !debounced
                ? <Button size="sm" onClick={() => setEditing({ form: null })}><Plus size={15} /> New Form</Button>
                : undefined}
            />
          ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2/50 text-left text-xs font-semibold uppercase tracking-wide text-ink">
                    <th className="px-4 py-3">Form Title</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Custom Fields</th>
                    <th className="px-4 py-3">Permitted Members</th>
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => {
                    // Defensive: an API instance older than this page returns rows without
                    // the two id arrays, and a blank list beats a white screen.
                    const names = (f.permittedMemberIds ?? []).map((id) => memberName[id]).filter(Boolean);
                    return (
                      <tr key={f.id}
                        className={`border-b border-line last:border-0 hover:bg-surface-2/60 ${
                          highlight === f.id ? 'bg-accent-soft/50' : ''
                        }`}>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink">{f.name}</span>
                            {f.isDefault && <Badge tone="green"><ShieldCheck size={12} /> Default</Badge>}
                            {f.status === 'disabled' && <Badge tone="neutral">Disabled</Badge>}
                          </div>
                        </td>
                        <td className="max-w-[280px] px-4 py-3 text-muted">
                          {f.description || <span className="italic">No description</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone="neutral">{plural((f.customFieldIds ?? []).length, 'field')}</Badge>
                        </td>
                        <td className="max-w-[240px] px-4 py-3 text-muted">
                          {names.length === 0
                            ? <span className="italic">None</span>
                            : names.length <= 2
                              ? names.join(', ')
                              : `${names.slice(0, 2).join(', ')} +${names.length - 2}`}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {/* View opens the contacts this form captured, in All Customers. */}
                            <button
                              type="button"
                              disabled={!canViewCustomers}
                              onClick={() => navigate(`/app/crm/customers?webFormId=${f.id}`)}
                              title={canViewCustomers ? `Show the contacts ${f.name} captured` : 'You do not have permission to view customers'}
                              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Users size={13} className="text-muted" /> View
                            </button>
                            {/* The raw submissions stay reachable — they hold fields a contact does not. */}
                            <button
                              type="button"
                              onClick={() => setViewing(f)}
                              aria-label={`Raw submissions for ${f.name}`}
                              title="Raw submissions and public URL"
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                            >
                              <Table2 size={13} />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            {canManage && (
                              <Button variant="ghost" size="sm" aria-label={`Edit ${f.name}`} onClick={() => setEditing({ form: f })}>
                                <Pencil size={15} />
                              </Button>
                            )}
                            {canManage && !f.isDefault && (
                              <Button variant="ghost" size="sm" aria-label={`Delete ${f.name}`} onClick={() => setToDelete(f)}>
                                <Trash2 size={15} />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/50 px-4 py-3 text-sm text-muted">
              <div>Page {Math.min(page, pageCount)} of {total === 0 ? 0 : pageCount} <span className="mx-1">•</span> Total {total}</div>
              <div className="flex items-center gap-2">
                <Select className="h-8 !w-24 text-xs" value={pageSize} aria-label="Rows per page"
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
                </Select>
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={15} /></Button>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={15} /></Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {editing && (
        <FormEditorModal
          form={editing.form}
          fields={fields.data ?? []}
          members={members.data ?? []}
          loadingLookups={fields.isLoading || members.isLoading}
          saving={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) => {
            if (editing.form) update.mutate({ id: editing.form.id, input });
            else create.mutate(input);
          }}
        />
      )}

      {viewing && <SubmissionsModal orgId={orgId} form={viewing} onClose={() => setViewing(null)} />}

      <ConfirmDialog
        open={!!toDelete} title="Delete form" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete "${toDelete?.name}"? Its submissions will also be removed. Contacts already captured stay in your CRM.`}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}

// ── pickers ──────────────────────────────────────────────────────────────────

/** Header row of a picker: label, live count, and a select-all / deselect-all toggle. */
function PickerHeader({ label, selected, total, onToggleAll }: {
  label: string; selected: number; total: number; onToggleAll: () => void;
}) {
  const allSelected = total > 0 && selected === total;
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
          {selected} selected
        </span>
      </div>
      <button
        type="button" onClick={onToggleAll} disabled={total === 0}
        className="text-xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
      >
        {allSelected ? 'Deselect All' : 'Select All'}
      </button>
    </div>
  );
}

/** One selectable card. Selection is carried by the checkbox *and* the tint, never colour alone. */
function PickerRow({ checked, onToggle, primary, secondary, avatar }: {
  checked: boolean; onToggle: () => void; primary: string; secondary?: string; avatar?: string;
}) {
  return (
    <label className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3 py-2 transition-colors ${
      checked ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
    }`}>
      {avatar !== undefined && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
          {avatar}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{primary}</span>
        {secondary && <span className="block truncate text-xs text-muted">{secondary}</span>}
      </span>
      <Checkbox checked={checked} onChange={onToggle} aria-label={primary} />
    </label>
  );
}

function FormEditorModal({ form, fields, members, loadingLookups, saving, onClose, onSave }: {
  form: WebForm | null;
  fields: CustomField[];
  members: TeamMember[];
  loadingLookups: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (input: WebFormInput) => void;
}) {
  const [name, setName] = useState(form?.name ?? '');
  const [description, setDescription] = useState(form?.description ?? '');
  const [pickedFields, setPickedFields] = useState<string[]>(form?.customFieldIds ?? []);
  const [pickedMembers, setPickedMembers] = useState<string[]>(form?.permittedMemberIds ?? []);
  const [fieldQuery, setFieldQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [err, setErr] = useState('');

  const fq = fieldQuery.trim().toLowerCase();
  const mq = memberQuery.trim().toLowerCase();
  const shownFields = useMemo(
    () => fields.filter((f) => !fq || f.name.toLowerCase().includes(fq) || f.key.toLowerCase().includes(fq)),
    [fields, fq],
  );
  const shownMembers = useMemo(
    () => members.filter((m) => !mq || m.user.name.toLowerCase().includes(mq) || m.user.email.toLowerCase().includes(mq)),
    [members, mq],
  );

  // Select All acts on what is on screen, so it stays honest while a search filters the list.
  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const toggleAll = (visibleIds: string[], list: string[], set: (v: string[]) => void) => {
    const allIn = visibleIds.length > 0 && visibleIds.every((id) => list.includes(id));
    set(allIn ? list.filter((id) => !visibleIds.includes(id)) : [...new Set([...list, ...visibleIds])]);
  };

  const submit = () => {
    if (!name.trim()) { setErr('Form title is required.'); return; }
    setErr('');
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      customFieldIds: pickedFields,
      permittedMemberIds: pickedMembers,
    });
  };

  return (
    <Modal
      open onClose={onClose} size="xl" title={form ? 'Edit Form' : 'Create New Form'}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={submit}>Save Form</Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        {/* ── General information ── */}
        <section className="space-y-4">
          <h4 className="text-sm font-semibold text-ink">General Information</h4>
          <div className="space-y-1.5">
            <label htmlFor="wf-title" className="block text-xs font-semibold uppercase tracking-wide text-muted">Form title</label>
            <Input id="wf-title" value={name} invalid={!!err} placeholder="E.g., Customer Intake Form"
              onChange={(e) => setName(e.target.value)} />
            {err && <p className="text-xs text-red">{err}</p>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="wf-desc" className="block text-xs font-semibold uppercase tracking-wide text-muted">Description</label>
            <Textarea id="wf-desc" rows={5} value={description} placeholder="Provide details about this form's purpose…"
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <p className="text-xs text-muted">
            Name, email and phone are always captured. The custom fields you pick are added on top,
            and permitted members decide who can read what this form collects.
          </p>
        </section>

        {/* ── Configuration ── */}
        <section className="space-y-5">
          <h4 className="text-sm font-semibold text-ink">Configuration</h4>

          <div>
            <PickerHeader label="Custom fields" selected={pickedFields.length} total={fields.length}
              onToggleAll={() => toggleAll(shownFields.map((f) => f.id), pickedFields, setPickedFields)} />
            <Input className="mb-2 h-9" value={fieldQuery} placeholder="Search fields…" aria-label="Search custom fields"
              onChange={(e) => setFieldQuery(e.target.value)} />
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {loadingLookups ? <p className="py-3 text-sm text-muted">Loading fields…</p>
                : shownFields.length === 0 ? <p className="py-3 text-sm text-muted">{fields.length === 0 ? 'No custom fields in this workspace yet.' : 'No fields match that search.'}</p>
                : shownFields.map((f) => (
                  <PickerRow key={f.id} checked={pickedFields.includes(f.id)}
                    onToggle={() => toggle(pickedFields, setPickedFields, f.id)}
                    primary={f.name} secondary={f.type} />
                ))}
            </div>
          </div>

          <div>
            <PickerHeader label="Permitted members" selected={pickedMembers.length} total={members.length}
              onToggleAll={() => toggleAll(shownMembers.map((m) => m.user.id), pickedMembers, setPickedMembers)} />
            <Input className="mb-2 h-9" value={memberQuery} placeholder="Search members…" aria-label="Search members"
              onChange={(e) => setMemberQuery(e.target.value)} />
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {loadingLookups ? <p className="py-3 text-sm text-muted">Loading members…</p>
                : shownMembers.length === 0 ? <p className="py-3 text-sm text-muted">{members.length === 0 ? 'No members in this workspace yet.' : 'No members match that search.'}</p>
                : shownMembers.map((m) => (
                  <PickerRow key={m.id} checked={pickedMembers.includes(m.user.id)}
                    onToggle={() => toggle(pickedMembers, setPickedMembers, m.user.id)}
                    avatar={initials(m.user.name || m.user.email)}
                    primary={m.user.email} secondary={m.role.name} />
                ))}
            </div>
            {pickedMembers.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                Only these members will be able to open this form's captured data.
              </p>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}

// ── submissions ──────────────────────────────────────────────────────────────
function SubmissionsModal({ orgId, form, onClose }: { orgId: string; form: WebForm; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['web-form-subs', orgId, form.id], queryFn: () => webformsService.submissions(orgId, form.id),
  });
  const subs = data ?? [];
  const url = publicUrl(form.publicSlug);

  const copy = () => {
    navigator.clipboard?.writeText(url)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => toast.info(url));
  };

  return (
    <Modal open onClose={onClose} size="lg" title={`Data · ${form.name}`}
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface-2/50 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Public URL</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{url}</span>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
        </Button>
      </div>

      {isLoading ? <LoadingState label="Loading submissions…" />
        : isError ? <ErrorState message={(error as Error)?.message ?? 'Could not load submissions.'} onRetry={() => refetch()} />
        : subs.length === 0 ? <EmptyState title="No submissions yet" detail="Share the public URL to start collecting leads." />
        : (
        <div className="space-y-3">
          {subs.map((s) => (
            <div key={s.id} className="rounded-[10px] border border-line p-3 text-sm">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs text-muted">{new Date(s.createdAt).toLocaleString()}</span>
                {s.customerId && <Badge tone="green">Contact created</Badge>}
              </div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {Object.entries(s.data).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="font-medium text-muted">{k}:</dt>
                    <dd className="break-words text-ink">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
