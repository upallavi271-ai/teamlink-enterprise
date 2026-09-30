import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, History, Play, X, Zap, Download } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { automationsService } from '@/services/automations/automations.service';
import { agentsService } from '@/services/crm/agents.service';
import { customersService } from '@/services/crm/customers.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { downloadCsv } from '@/lib/csv';
import { collectAll } from '@/lib/collectAll';
import type {
  Automation, AutomationAction, AutomationActionType, AutomationCondition, AutomationConditionField,
  AutomationConditionOperator, AutomationInput, AutomationTrigger, LeadStage, LeadStatus,
} from '@/types';

// ── Vocabulary (mirrors the backend automation.constants — the wire contract) ──
const TRIGGERS: { value: AutomationTrigger; label: string; hint: string }[] = [
  { value: 'customer_created', label: 'Contact created', hint: 'A new CRM contact is added (manual, import or web form)' },
  { value: 'form_submitted', label: 'Web form submitted', hint: 'A public web form captures a lead' },
  { value: 'stage_changed', label: 'Lead stage changed', hint: 'A contact moves to a new lead stage' },
];
const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  customer_created: 'Contact created', form_submitted: 'Web form submitted', stage_changed: 'Lead stage changed',
};
const FIELDS: { value: AutomationConditionField; label: string }[] = [
  { value: 'source', label: 'Source' }, { value: 'leadStage', label: 'Lead stage' }, { value: 'leadStatus', label: 'Lead status' },
];
const OPERATORS: { value: AutomationConditionOperator; label: string }[] = [
  { value: 'equals', label: 'is' }, { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' }, { value: 'in', label: 'is any of' },
];
const ACTIONS: { value: AutomationActionType; label: string }[] = [
  { value: 'add_tag', label: 'Add tag' }, { value: 'set_stage', label: 'Set lead stage' },
  { value: 'set_status', label: 'Set lead status' }, { value: 'assign_agent', label: 'Assign agent' },
];
const STAGES: LeadStage[] = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const STATUSES: LeadStatus[] = ['active', 'inactive', 'unqualified'];

const actionSummary = (a: AutomationAction): string => {
  if (a.type === 'add_tag') return `Tag "${a.tag}"`;
  if (a.type === 'set_stage') return `Stage → ${a.stage}`;
  if (a.type === 'set_status') return `Status → ${a.status}`;
  if (a.type === 'assign_agent') return 'Assign agent';
  return a.type;
};

export function AutomationsPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('automation.manage');
  const lp = useListParams({ sort: 'createdAt', pageSize: 20 });
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['automations', orgId, lp.params], queryFn: () => automationsService.list(orgId, lp.params),
    enabled: !!orgId && canManage,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['automations', orgId] });
  const create = useMutation({ mutationFn: (i: AutomationInput) => automationsService.create(orgId, i), onSuccess: invalidate });
  const update = useMutation({ mutationFn: (v: { id: string; input: Partial<AutomationInput> }) => automationsService.update(orgId, v.id, v.input), onSuccess: invalidate });
  const setStatus = useMutation({ mutationFn: (v: { id: string; status: 'active' | 'paused' }) => automationsService.setStatus(orgId, v.id, v.status), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => automationsService.remove(orgId, id), onSuccess: invalidate });

  const [editor, setEditor] = useState<{ auto: Automation | null } | null>(null);
  const [viewingRuns, setViewingRuns] = useState<Automation | null>(null);
  const [testing, setTesting] = useState<Automation | null>(null);
  const [toDelete, setToDelete] = useState<Automation | null>(null);
  const [exporting, setExporting] = useState(false);

  if (!canManage) {
    return (
      <div>
        <PageHeader title="Automations" subtitle="Trigger → conditions → actions" />
        <Card><EmptyState title="No access" detail="You need the automation.manage permission to work with automations." /></Card>
      </div>
    );
  }

  const rows = data?.items ?? [];
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await collectAll((page, pageSize) => automationsService.list(orgId, { ...lp.params, page, pageSize }));
      downloadCsv('automations.csv', all.map((a) => ({
        Name: a.name, Trigger: TRIGGER_LABEL[a.trigger], Status: a.status,
        Conditions: a.conditions.length, Logic: a.logic,
        Actions: a.actions.map(actionSummary).join(' | '),
        Matched: a.matchCount, Evaluated: a.runCount,
        LastRun: a.lastRunAt ? new Date(a.lastRunAt).toISOString() : '',
        Created: new Date(a.createdAt).toISOString(),
      })));
      toast.success(all.length ? `Exported ${all.length} automation${all.length === 1 ? '' : 's'} to CSV` : 'Nothing to export');
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader title="Automations" subtitle="When something happens, act on it automatically — no third-party setup needed"
        actions={<>
          <Button variant="secondary" size="sm" onClick={exportCsv} loading={exporting} disabled={(data?.total ?? 0) === 0}><Download size={15} /> Export</Button>
          <Button size="sm" onClick={() => setEditor({ auto: null })}><Plus size={15} /> New automation</Button>
        </>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search automations…" />
          <Select className="h-10 w-auto" value={lp.filters.trigger ?? ''} onChange={(e) => lp.setFilter('trigger', e.target.value)}>
            <option value="">All triggers</option>
            {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <Select className="h-10 w-auto" value={lp.filters.status ?? ''} onChange={(e) => lp.setFilter('status', e.target.value)}>
            <option value="">All statuses</option><option value="active">Active</option><option value="paused">Paused</option>
          </Select>
        </div>
        {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
          : rows.length === 0 ? <EmptyState title="No automations yet" detail="Create your first automation to tag, qualify and route contacts automatically."
              action={<Button size="sm" onClick={() => setEditor({ auto: null })}><Plus size={15} /> New automation</Button>} />
          : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Automation</th><th className="px-4 py-3">Trigger</th><th className="px-4 py-3">Actions</th>
                <th className="px-4 py-3">Runs</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th>
              </tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{a.name}</div>
                      {a.description && <div className="text-xs text-muted">{a.description}</div>}
                      {a.conditions.length > 0 && <div className="mt-0.5 text-xs text-muted">{a.conditions.length} condition{a.conditions.length > 1 ? 's' : ''} · {a.logic}</div>}
                    </td>
                    <td className="px-4 py-3"><Badge tone="blue">{TRIGGER_LABEL[a.trigger]}</Badge></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {a.actions.map((ac, i) => <Badge key={i} tone="neutral">{actionSummary(ac)}</Badge>)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted" title="matched / evaluated">{a.matchCount} / {a.runCount}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setStatus.mutate({ id: a.id, status: a.status === 'active' ? 'paused' : 'active' })}
                        className="cursor-pointer disabled:cursor-wait"
                        disabled={setStatus.isPending}
                        aria-label={a.status === 'active' ? 'Pause automation' : 'Activate automation'}
                      >
                        <Badge tone={a.status === 'active' ? 'green' : 'orange'}>{a.status}</Badge>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" aria-label="Test" onClick={() => setTesting(a)}><Play size={15} /></Button>
                        <Button variant="ghost" size="sm" aria-label="Run history" onClick={() => setViewingRuns(a)}><History size={15} /></Button>
                        <Button variant="ghost" size="sm" aria-label="Edit" onClick={() => setEditor({ auto: a })}><Pencil size={15} /></Button>
                        <Button variant="ghost" size="sm" aria-label="Delete" onClick={() => setToDelete(a)}><Trash2 size={15} /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={lp.page} pageSize={lp.pageSize} total={data?.total ?? 0} onPage={lp.setPage} />
          </div>
        )}
      </Card>

      {editor && (
        <AutomationEditor
          orgId={orgId}
          auto={editor.auto}
          saving={create.isPending || update.isPending}
          onClose={() => setEditor(null)}
          onSave={(input) => {
            const p = editor.auto ? update.mutateAsync({ id: editor.auto.id, input }) : create.mutateAsync(input);
            p.then(() => { toast.success(editor.auto ? 'Automation updated' : 'Automation created'); setEditor(null); })
              .catch((e) => toast.error(e?.message ?? 'Save failed'));
          }}
        />
      )}

      {viewingRuns && <RunsModal orgId={orgId} auto={viewingRuns} onClose={() => setViewingRuns(null)} />}
      {testing && <TestModal orgId={orgId} auto={testing} onClose={() => setTesting(null)} onDone={invalidate} />}

      <ConfirmDialog open={!!toDelete} title="Delete automation" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete "${toDelete?.name}"? Its run history will also be removed. Contacts it already changed stay as they are.`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id).then(() => { toast.success('Automation deleted'); setToDelete(null); }).catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </div>
  );
}

// ── Editor ────────────────────────────────────────────────────────────────────
function AutomationEditor({ orgId, auto, saving, onClose, onSave }: {
  orgId: string; auto: Automation | null; saving: boolean; onClose: () => void; onSave: (i: AutomationInput) => void;
}) {
  const [name, setName] = useState(auto?.name ?? '');
  const [description, setDescription] = useState(auto?.description ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(auto?.trigger ?? 'customer_created');
  const [logic, setLogic] = useState<'AND' | 'OR'>(auto?.logic ?? 'AND');
  const [conditions, setConditions] = useState<AutomationCondition[]>(auto?.conditions ?? []);
  const [actions, setActions] = useState<AutomationAction[]>(auto?.actions ?? [{ type: 'add_tag', tag: '' }]);
  const [err, setErr] = useState('');

  const { data: agents } = useQuery({ queryKey: ['agents', orgId], queryFn: () => agentsService.list(orgId), enabled: !!orgId });

  const addCond = () => setConditions((c) => [...c, { field: 'source', operator: 'equals', value: '' }]);
  const patchCond = (i: number, p: Partial<AutomationCondition>) => setConditions((c) => c.map((x, idx) => idx === i ? { ...x, ...p } : x));
  const rmCond = (i: number) => setConditions((c) => c.filter((_, idx) => idx !== i));

  const addAction = () => setActions((a) => [...a, { type: 'add_tag', tag: '' }]);
  const patchAction = (i: number, p: Partial<AutomationAction>) => setActions((a) => a.map((x, idx) => idx === i ? { ...x, ...p } : x));
  const rmAction = (i: number) => setActions((a) => a.filter((_, idx) => idx !== i));

  const changeActionType = (i: number, type: AutomationActionType) => {
    const base: AutomationAction = { type };
    if (type === 'set_stage') base.stage = 'new';
    if (type === 'set_status') base.status = 'active';
    patchAction(i, base);
  };

  const submit = () => {
    setErr('');
    if (!name.trim()) { setErr('Give the automation a name.'); return; }
    // Normalise conditions: 'in' takes a comma-separated list.
    const cleanConds: AutomationCondition[] = [];
    for (const c of conditions) {
      if (c.operator === 'in') {
        const list = (Array.isArray(c.value) ? c.value : String(c.value).split(',')).map((s) => String(s).trim()).filter(Boolean);
        if (!list.length) { setErr('Each "is any of" condition needs at least one value.'); return; }
        cleanConds.push({ ...c, value: list });
      } else {
        const v = String(Array.isArray(c.value) ? c.value[0] ?? '' : c.value).trim();
        if (!v) { setErr('Every condition needs a value.'); return; }
        cleanConds.push({ ...c, value: v });
      }
    }
    // Validate actions carry their required param.
    const cleanActions: AutomationAction[] = [];
    for (const a of actions) {
      if (a.type === 'add_tag') { if (!a.tag?.trim()) { setErr('A "tag" action needs a tag name.'); return; } cleanActions.push({ type: 'add_tag', tag: a.tag.trim() }); }
      else if (a.type === 'set_stage') { if (!a.stage) { setErr('Choose a stage for the "set stage" action.'); return; } cleanActions.push({ type: 'set_stage', stage: a.stage }); }
      else if (a.type === 'set_status') { if (!a.status) { setErr('Choose a status for the "set status" action.'); return; } cleanActions.push({ type: 'set_status', status: a.status }); }
      else if (a.type === 'assign_agent') { if (!a.agentId) { setErr('Choose an agent for the "assign" action.'); return; } cleanActions.push({ type: 'assign_agent', agentId: a.agentId }); }
    }
    if (!cleanActions.length) { setErr('Add at least one action.'); return; }
    onSave({ name: name.trim(), description: description.trim() || undefined, trigger, logic, conditions: cleanConds, actions: cleanActions });
  };

  const isEnumField = (f: AutomationConditionField) => f === 'leadStage' || f === 'leadStatus';
  const enumOptions = (f: AutomationConditionField) => (f === 'leadStage' ? STAGES : STATUSES);

  return (
    <Modal open onClose={onClose} title={auto ? `Edit: ${auto.name}` : 'New automation'} size="lg"
      footer={<><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button><Button size="sm" loading={saving} onClick={submit}>{auto ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name" error={err}><Input value={name} invalid={!!err} onChange={(e) => setName(e.target.value)} placeholder="Tag & qualify web leads" /></Field>
        <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this automation does" /></Field>

        <Field label="When (trigger)">
          <Select value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
            {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <p className="mt-1 text-xs text-muted">{TRIGGERS.find((t) => t.value === trigger)?.hint}</p>
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Conditions <span className="font-normal text-muted">(optional — leave empty to run on every trigger)</span></span>
            {conditions.length > 1 && (
              <Select className="h-8 w-24" value={logic} onChange={(e) => setLogic(e.target.value as 'AND' | 'OR')}>
                <option value="AND">Match all</option><option value="OR">Match any</option>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
                <Select className="h-9 w-36" value={c.field} onChange={(e) => patchCond(i, { field: e.target.value as AutomationConditionField, value: '' })}>
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </Select>
                <Select className="h-9 w-32" value={c.operator} onChange={(e) => patchCond(i, { operator: e.target.value as AutomationConditionOperator })}>
                  {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {isEnumField(c.field) && c.operator !== 'in' ? (
                  <Select className="h-9 flex-1 min-w-[120px]" value={String(c.value)} onChange={(e) => patchCond(i, { value: e.target.value })}>
                    <option value="">Choose…</option>
                    {enumOptions(c.field).map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ) : (
                  <Input className="h-9 flex-1 min-w-[120px]" value={Array.isArray(c.value) ? c.value.join(', ') : c.value}
                    onChange={(e) => patchCond(i, { value: e.target.value })}
                    placeholder={c.operator === 'in' ? 'value1, value2' : 'value'} />
                )}
                <Button variant="ghost" size="sm" aria-label="Remove condition" onClick={() => rmCond(i)}><X size={14} /></Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={addCond}><Plus size={14} /> Add condition</Button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink"><Zap size={14} className="text-accent" /> Then do</div>
          <div className="space-y-2">
            {actions.map((a, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
                <Select className="h-9 w-40" value={a.type} onChange={(e) => changeActionType(i, e.target.value as AutomationActionType)}>
                  {ACTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {a.type === 'add_tag' && <Input className="h-9 flex-1 min-w-[140px]" value={a.tag ?? ''} onChange={(e) => patchAction(i, { tag: e.target.value })} placeholder="Tag name" />}
                {a.type === 'set_stage' && (
                  <Select className="h-9 flex-1 min-w-[140px]" value={a.stage ?? ''} onChange={(e) => patchAction(i, { stage: e.target.value as LeadStage })}>
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </Select>
                )}
                {a.type === 'set_status' && (
                  <Select className="h-9 flex-1 min-w-[140px]" value={a.status ?? ''} onChange={(e) => patchAction(i, { status: e.target.value as LeadStatus })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </Select>
                )}
                {a.type === 'assign_agent' && (
                  <Select className="h-9 flex-1 min-w-[140px]" value={a.agentId ?? ''} onChange={(e) => patchAction(i, { agentId: e.target.value })}>
                    <option value="">Choose agent…</option>
                    {(agents ?? []).map((ag) => <option key={ag.id} value={ag.id}>{ag.name}</option>)}
                  </Select>
                )}
                <Button variant="ghost" size="sm" aria-label="Remove action" onClick={() => rmAction(i)} disabled={actions.length === 1}><X size={14} /></Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={addAction}><Plus size={14} /> Add action</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Run history ─────────────────────────────────────────────────────────────
function RunsModal({ orgId, auto, onClose }: { orgId: string; auto: Automation; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['automation-runs', orgId, auto.id], queryFn: () => automationsService.runs(orgId, auto.id),
  });
  const runs = data ?? [];
  const tone = (s: string) => (s === 'success' ? 'green' : s === 'failed' ? 'red' : 'neutral') as 'green' | 'red' | 'neutral';
  return (
    <Modal open onClose={onClose} title={`Run history · ${auto.name}`} size="lg"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
        : runs.length === 0 ? <EmptyState title="No runs yet" detail="This automation runs when its trigger fires. You can also test it against a contact." />
        : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3">When</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Actions applied</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3 text-muted whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3"><Badge tone={tone(r.status)}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-muted">
                    {r.status === 'failed' ? <span className="text-red">{r.error ?? 'Failed'}</span>
                      : r.actionsApplied.length ? r.actionsApplied.join(', ')
                      : <span className="text-muted">— conditions not met</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ── Test (real dry-run-then-apply against one contact) ───────────────────────
function TestModal({ orgId, auto, onClose, onDone }: { orgId: string; auto: Automation; onClose: () => void; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const { data } = useQuery({
    queryKey: ['test-customers', orgId, search], queryFn: () => customersService.list(orgId, { search: search || undefined, pageSize: 8 }), enabled: !!orgId,
  });
  const run = useMutation({ mutationFn: (customerId: string) => automationsService.test(orgId, auto.id, customerId) });
  const customers = data?.items ?? [];

  return (
    <Modal open onClose={() => { onDone(); onClose(); }} title={`Test · ${auto.name}`} size="md"
      footer={<Button variant="secondary" size="sm" onClick={() => { onDone(); onClose(); }}>Close</Button>}>
      <p className="mb-3 text-sm text-muted">
        Pick a contact and run this automation against them now. This applies the real actions (tags, stage, status) to that contact and records a run.
      </p>
      <SearchInput value={search} onChange={setSearch} placeholder="Search contacts…" />
      <div className="mt-3 space-y-1">
        {customers.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
            <div><span className="font-medium text-ink">{c.name}</span><span className="ml-2 text-xs text-muted">{c.email ?? c.phone ?? ''}</span></div>
            <Button size="sm" variant="secondary" loading={run.isPending && run.variables === c.id}
              onClick={() => run.mutateAsync(c.id).then((res) => {
                if (res.status === 'success') toast.success(`Applied: ${res.actionsApplied.join(', ') || 'no changes'}`);
                else if (res.status === 'skipped') toast.info('Conditions not met — nothing applied');
                else toast.error(res.error ?? 'Test failed');
              }).catch((e) => toast.error(e?.message ?? 'Test failed'))}>
              <Play size={14} /> Run
            </Button>
          </div>
        ))}
        {customers.length === 0 && <p className="py-4 text-center text-sm text-muted">No contacts found.</p>}
      </div>
      {run.data && (
        <div className="mt-3 rounded-lg border border-line p-3 text-sm">
          <Badge tone={run.data.status === 'success' ? 'green' : run.data.status === 'failed' ? 'red' : 'neutral'}>{run.data.status}</Badge>
          <span className="ml-2 text-muted">{run.data.status === 'success' ? (run.data.actionsApplied.join(', ') || 'No changes') : run.data.status === 'failed' ? (run.data.error ?? '') : 'Conditions not met'}</span>
        </div>
      )}
    </Modal>
  );
}
