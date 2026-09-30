import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Pencil, Trash2, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { segmentsService } from '@/services/crm/segments.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LEAD_STAGES, LEAD_STATUSES, SOURCES, cap } from '../crmLabels';
import type { Segment, SegmentInput, SegmentRule, SegmentField, SegmentOperator } from '@/types';

const FIELDS: SegmentField[] = ['leadStage', 'leadStatus', 'source'];
const OPS: SegmentOperator[] = ['equals', 'not_equals', 'contains', 'in'];
const valuesFor = (f: SegmentField) => f === 'leadStage' ? LEAD_STAGES : f === 'leadStatus' ? LEAD_STATUSES : SOURCES;
const emptyRule = (): SegmentRule => ({ field: 'leadStage', operator: 'equals', value: 'new' });

export function SegmentsPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const qc = useQueryClient();
  const { data: segments = [], isLoading, isError, refetch } = useQuery({ queryKey: ['segments', orgId], queryFn: () => segmentsService.list(orgId), enabled: !!orgId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['segments', orgId] });
  const createM = useMutation({ mutationFn: (i: SegmentInput) => segmentsService.create(orgId, i), onSuccess: invalidate });
  const updateM = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<SegmentInput> }) => segmentsService.update(orgId, id, patch), onSuccess: invalidate });
  const dupM = useMutation({ mutationFn: (id: string) => segmentsService.duplicate(orgId, id), onSuccess: invalidate });
  const delM = useMutation({ mutationFn: (id: string) => segmentsService.remove(orgId, id), onSuccess: invalidate });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [toDelete, setToDelete] = useState<Segment | null>(null);
  const [form, setForm] = useState<SegmentInput>({ name: '', description: '', rules: [emptyRule()], logic: 'AND' });
  const [nameErr, setNameErr] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const openNew = () => { setEditing(null); setForm({ name: '', description: '', rules: [emptyRule()], logic: 'AND' }); setNameErr(''); setPreview(null); setOpen(true); };
  const openEdit = (s: Segment) => { setEditing(s); setForm({ name: s.name, description: s.description, rules: s.rules.length ? s.rules : [emptyRule()], logic: s.logic }); setNameErr(''); setPreview(null); setOpen(true); };

  // Live audience preview (debounced) — real matches via the shared predicate.
  useEffect(() => {
    if (!open) return;
    setPreviewing(true);
    const t = setTimeout(() => {
      segmentsService.preview(orgId, form.rules, form.logic)
        .then((r) => setPreview(r.count)).catch(() => setPreview(null)).finally(() => setPreviewing(false));
    }, 300);
    return () => clearTimeout(t);
  }, [open, orgId, form.rules, form.logic]);

  const setRule = (i: number, patch: Partial<SegmentRule>) => setForm((f) => {
    const rules = f.rules.map((r, idx) => idx === i ? { ...r, ...patch } : r);
    return { ...f, rules };
  });
  const addRule = () => setForm((f) => ({ ...f, rules: [...f.rules, emptyRule()] }));
  const removeRule = (i: number) => setForm((f) => ({ ...f, rules: f.rules.filter((_, idx) => idx !== i) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setNameErr('Name is required.'); return; }
    const payload = { ...form, name: form.name.trim() };
    const action = editing ? updateM.mutateAsync({ id: editing.id, patch: payload }) : createM.mutateAsync(payload);
    action.then(() => { toast.success(editing ? 'Segment updated' : 'Segment created'); setOpen(false); })
      .catch((e) => toast.error(e?.message ?? 'Save failed'));
  };

  return (
    <div>
      <PageHeader title="Segments" subtitle="Dynamic audiences from your CRM"
        actions={<><RefreshButton keys={['segments']} /><Button size="sm" onClick={openNew}><Plus size={15} /> New segment</Button></>} />

      {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
        : segments.length === 0 ? <Card><EmptyState title="No segments yet" detail="Build a dynamic audience from CRM rules." action={<Button size="sm" onClick={openNew}><Plus size={15} /> New segment</Button>} /></Card>
        : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {segments.map((s) => (
            <Card key={s.id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div><h3 className="font-display font-semibold text-ink">{s.name}</h3>{s.description && <p className="text-xs text-muted">{s.description}</p>}</div>
                  <Badge tone="green">{s.logic}</Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {s.rules.map((r, i) => <Badge key={i}>{r.field} {r.operator.replace('_', ' ')} {r.value}</Badge>)}
                </div>
                <div className="flex gap-1 pt-1">
                  <Button variant="secondary" size="sm" onClick={() => openEdit(s)}><Pencil size={14} /> Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => dupM.mutateAsync(s.id).then(() => toast.success('Duplicated')).catch(() => toast.error('Failed'))}><Copy size={14} /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setToDelete(s)}><Trash2 size={14} /></Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit segment' : 'New segment'} size="lg"
        footer={<><Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" loading={createM.isPending || updateM.isPending} onClick={submit}>{editing ? 'Save' : 'Create'}</Button></>}>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name" error={nameErr}><Input value={form.name} invalid={!!nameErr} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
          <Field label="Description"><Textarea rows={2} value={form.description ?? ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Match</span>
            <Select className="h-9 w-auto" value={form.logic} onChange={(e) => setForm((f) => ({ ...f, logic: e.target.value as 'AND' | 'OR' }))}><option value="AND">ALL (AND)</option><option value="OR">ANY (OR)</option></Select>
            <span className="text-muted">of these rules</span>
          </div>
          <div className="space-y-2">
            {form.rules.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line p-2">
                <Select className="h-9 w-auto" value={r.field} onChange={(e) => { const field = e.target.value as SegmentField; setRule(i, { field, value: valuesFor(field)[0] }); }}>{FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}</Select>
                <Select className="h-9 w-auto" value={r.operator} onChange={(e) => setRule(i, { operator: e.target.value as SegmentOperator })}>{OPS.map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}</Select>
                <Select className="h-9 w-auto" value={r.value} onChange={(e) => setRule(i, { value: e.target.value })}>{valuesFor(r.field).map((v) => <option key={v} value={v}>{cap(v)}</option>)}</Select>
                {form.rules.length > 1 && <Button variant="ghost" size="sm" onClick={() => removeRule(i)} aria-label="Remove rule"><Trash2 size={14} /></Button>}
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={addRule}><Plus size={14} /> Add rule</Button>
          </div>
          <div className="flex items-center gap-2 rounded-[10px] bg-accent-tint p-3 text-sm text-ink">
            <Users size={16} className="text-accent" />
            {previewing ? 'Calculating audience…' : preview === null ? 'Preview unavailable' : <><b>{preview}</b> matching contact{preview === 1 ? '' : 's'}</>}
          </div>
        </form>
      </Modal>
      <ConfirmDialog open={!!toDelete} title="Delete segment" danger confirmLabel="Delete" loading={delM.isPending}
        message={`Delete "${toDelete?.name}"?`} onConfirm={() => toDelete && delM.mutateAsync(toDelete.id).then(() => { toast.success('Segment deleted'); setToDelete(null); }).catch(() => toast.error('Delete failed'))} onClose={() => setToDelete(null)} />
    </div>
  );
}
