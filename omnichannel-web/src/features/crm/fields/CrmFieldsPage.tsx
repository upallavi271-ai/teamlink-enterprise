import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { crmFieldsService } from '@/services/crm/crmFields.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { cap } from '../crmLabels';
import { useNavigate } from 'react-router-dom';
import type { CustomField, CustomFieldInput, CustomFieldType } from '@/types';

const TYPES: CustomFieldType[] = ['text', 'number', 'dropdown', 'date', 'boolean'];
const COLORS = ['#11985a', '#4d7ddb', '#ef9b35', '#de5c63', '#7867d9'];

export function CrmFieldsPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const navigate = useNavigate();
  const lp = useListParams({ sort: 'createdAt' });
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['crmFields', orgId, lp.params], queryFn: () => crmFieldsService.list(orgId, lp.params), enabled: !!orgId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['crmFields', orgId] });
  const create = useMutation({ mutationFn: (i: CustomFieldInput) => crmFieldsService.create(orgId, i), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => crmFieldsService.remove(orgId, id), onSuccess: invalidate });

  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<CustomField | null>(null);
  const [form, setForm] = useState<CustomFieldInput>({ name: '', key: '', type: 'text', color: COLORS[0], required: false, options: [] });
  const [optionsText, setOptionsText] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});

  const openNew = () => { setForm({ name: '', key: '', type: 'text', color: COLORS[0], required: false, options: [] }); setOptionsText(''); setErr({}); setOpen(true); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    if (form.type === 'dropdown' && !optionsText.trim()) errs.options = 'Add at least one option.';
    setErr(errs);
    if (Object.keys(errs).length) return;
    const options = form.type === 'dropdown' ? optionsText.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    create.mutateAsync({ ...form, name: form.name.trim(), options })
      .then(() => { toast.success('Field created'); setOpen(false); })
      .catch((e) => toast.error(e?.message ?? 'Create failed'));
  };

  const rows = data?.items ?? [];
  return (
    <div>
      <PageHeader title="CRM Fields" subtitle="Custom fields on your customer records"
        actions={<Button size="sm" onClick={openNew}><Plus size={15} /> New field</Button>} />
      <Card>
        <div className="flex items-center gap-2 border-b border-line p-3">
          <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search fields…" />
          <Select className="h-10 w-auto" value={lp.filters.type ?? ''} onChange={(e) => lp.setFilter('type', e.target.value)}>
            <option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
          </Select>
        </div>
        {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
          : rows.length === 0 ? <EmptyState title="No custom fields" detail="Create a field to capture extra customer data." action={<Button size="sm" onClick={openNew}><Plus size={15} /> New field</Button>} />
          : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Name</th><th className="px-4 py-3">Key</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Required</th><th className="px-4 py-3">Used by</th><th className="px-4 py-3"></th>
              </tr></thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3"><span className="inline-flex items-center gap-2 font-medium text-ink"><span className="h-2.5 w-2.5 rounded-full" style={{ background: f.color }} />{f.name}</span></td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{f.key}</td>
                    <td className="px-4 py-3"><Badge>{cap(f.type)}{f.type === 'dropdown' && f.options ? ` · ${f.options.length}` : ''}</Badge></td>
                    <td className="px-4 py-3 text-muted">{f.required ? 'Yes' : 'No'}</td>
                    {/* Which web forms collect this field — the other half of the
                        Web Forms picker, so the relationship is visible from both ends. */}
                    <td className="px-4 py-3">
                      {f.usedByForms?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {f.usedByForms.map((form) => (
                            <button key={form.id} type="button"
                              onClick={() => navigate(`/app/crm/web-forms?highlight=${form.id}`)}
                              title={`Open the ${form.name} form`}
                              className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-ink transition-colors hover:border-accent hover:text-accent">
                              {form.name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs italic text-muted">No forms</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right"><Button variant="ghost" size="sm" onClick={() => setToDelete(f)} aria-label="Delete"><Trash2 size={15} /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={lp.page} pageSize={lp.pageSize} total={data?.total ?? 0} onPage={lp.setPage} />
          </div>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="New custom field"
        footer={<><Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" loading={create.isPending} onClick={submit}>Create field</Button></>}>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Field name" error={err.name}><Input value={form.name} invalid={!!err.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
          <Field label="Key" hint="Auto-generated from the name if left blank"><Input value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="auto" /></Field>
          <Field label="Type"><Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as CustomFieldType }))}>{TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}</Select></Field>
          {form.type === 'dropdown' && <Field label="Options (comma-separated)" error={err.options}><Input value={optionsText} invalid={!!err.options} onChange={(e) => setOptionsText(e.target.value)} placeholder="Bronze, Silver, Gold" /></Field>}
          <Field label="Colour"><div className="flex gap-2">{COLORS.map((c) => <button key={c} type="button" onClick={() => setForm((f) => ({ ...f, color: c }))} className={`h-7 w-7 rounded-full ${form.color === c ? 'ring-2 ring-offset-2 ring-ink' : ''}`} style={{ background: c }} aria-label={c} />)}</div></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.required} onChange={(e) => setForm((f) => ({ ...f, required: e.target.checked }))} /> Required field</label>
        </form>
      </Modal>
      <ConfirmDialog open={!!toDelete} title="Delete field" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete "${toDelete?.name}"? Existing values for this field will no longer be shown.`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id).then(() => { toast.success('Field deleted'); setToDelete(null); }).catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </div>
  );
}
