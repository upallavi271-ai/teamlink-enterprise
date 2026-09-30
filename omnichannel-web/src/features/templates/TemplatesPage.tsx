import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sanitizeHtml } from '@/lib/sanitizeHtml';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, ArrowLeft, Upload, X, Phone, Globe, Reply, Copy, ChevronDown,
  ClipboardList, Workflow as WorkflowIcon, RefreshCw, ArrowUp, ArrowDown,
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, List, ListOrdered, Mail, ShieldQuestion,
  CloudDownload, Send,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Tabs } from '@/components/ui/Tabs';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { templatesService } from '@/services/templates/templates.service';
import { useCan } from '@/features/auth/useCan';
import { MetaConnectionPanel } from './MetaConnectionPanel';
import { MetaSyncPanel } from './MetaSyncPanel';
import { SubmitToMetaDialog } from './SubmitToMetaDialog';
import { TemplateStatusBadge } from './TemplateStatusBadge';
import { statusFilterLabel, templateStatusView } from './templateStatus';
import { validateWhatsAppTemplate } from '@/lib/whatsappTemplateValidator';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { cap } from '@/features/crm/crmLabels';
import type { TemplateWithMeta } from '@/services/templates/templates.types';
import type {
  Template, TemplateInput, TemplateStatus, TemplateHeaderType, TemplateButton,
  TemplateButtonType, Channel,
} from '@/types';

// ── Static config ─────────────────────────────────────────────────────────────
const CHANNEL_TABS = [
  { key: 'whatsapp', label: 'WhatsApp' }, { key: 'sms', label: 'SMS' },
  { key: 'rcs', label: 'RCS' }, { key: 'voice', label: 'Voice' }, { key: 'email', label: 'Email' },
];
const STATUSES: TemplateStatus[] = ['draft', 'pending', 'approved', 'rejected', 'in_review'];
// Status badges (list + read-only view) come from TemplateStatusBadge /
// templateStatus.ts, which for WhatsApp reads Meta's fields rather than the
// local column. The local tone map moved there as LOCAL_STATUS_TONE.
const CATEGORIES = ['Marketing', 'Utility', 'Authentication'];
const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'English (US)' }, { code: 'en_GB', label: 'English (UK)' },
  { code: 'hi', label: 'Hindi' }, { code: 'te', label: 'Telugu' }, { code: 'ta', label: 'Tamil' },
  { code: 'kn', label: 'Kannada' }, { code: 'mr', label: 'Marathi' }, { code: 'es', label: 'Spanish' },
];
const langLabel = (c?: string) => LANGS.find((l) => l.code === c)?.label ?? (c ?? 'en');
const HEADER_TYPES: { value: TemplateHeaderType; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'text', label: 'Text' },
  { value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }, { value: 'document', label: 'Document' },
];
const PROVIDER_BY_CHANNEL: Record<Channel, string> = {
  whatsapp: 'Meta', facebook: 'Meta', sms: 'MSG91', rcs: 'Jio RCS', voice: 'Jio Voice', email: 'SMTP',
};

type ActionDef = { type: TemplateButtonType; label: string; max: number; makeDefault: () => TemplateButton };
const ACTIONS: ActionDef[] = [
  { type: 'QUICK_REPLY', label: 'Custom Reply', max: 5, makeDefault: () => ({ type: 'QUICK_REPLY', text: 'Quick reply' }) },
  { type: 'URL', label: 'Visit Website', max: 2, makeDefault: () => ({ type: 'URL', text: 'Visit website', url: 'https://' }) },
  { type: 'PHONE', label: 'Call phone number', max: 1, makeDefault: () => ({ type: 'PHONE', text: 'Call us', countryCode: '+91', phone: '' }) },
  { type: 'WA_CALL', label: 'Call on WhatsApp', max: 1, makeDefault: () => ({ type: 'WA_CALL', text: 'Call on WhatsApp', countryCode: '+91', phone: '' }) },
  { type: 'COPY_CODE', label: 'Copy Offer Code', max: 1, makeDefault: () => ({ type: 'COPY_CODE', text: 'Copy code', offerCode: '' }) },
  { type: 'FLOW', label: 'Complete flow', max: 1, makeDefault: () => ({ type: 'FLOW', text: 'Complete flow' }) },
  { type: 'ORDER_DETAILS', label: 'Order Details', max: 1, makeDefault: () => ({ type: 'ORDER_DETAILS', text: 'Order details' }) },
];
const MAX_BUTTONS = 10;
const actionLabel = (t: TemplateButtonType) => ACTIONS.find((a) => a.type === t)?.label ?? t;
const countVars = (body: string) => (body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;

/**
 * Can this row be registered with Meta right now?
 *
 * Two conditions, each read off something the server actually sends:
 *   • WhatsApp only — POST /v1/templates/:id/submit answers 400
 *     TEMPLATE_NOT_WHATSAPP for every other channel.
 *   • No Meta counterpart — `metaTemplateId` is Meta's own id, written only
 *     after a real Meta response or a signature-verified webhook. Its ABSENCE
 *     is what "Meta has never acknowledged this row" means.
 *
 * The local status deliberately does NOT gate this, and an earlier version that
 * required draft/rejected was wrong in the worst way: the server creates every
 * new WhatsApp template PENDING ("not yet registered with Meta", its words), so
 * the action was hidden from precisely the rows that needed it. The same applies
 * to a row carrying a hand-set APPROVED that Meta never granted — that label is
 * local, the template is still unregistered, and submitting is the fix.
 *
 * Rows that DO carry a Meta id are left alone: re-submitting one would create a
 * second template at Meta under the same name. The server refuses those anyway
 * (409 TEMPLATE_ALREADY_SUBMITTED).
 */
const canSubmitToMeta = (t: Template): boolean =>
  t.channel === 'whatsapp' && !(t as TemplateWithMeta).metaTemplateId;

// WhatsApp field limits + variable helpers (frontend-only)
const BODY_MAX = 1024, HEADER_MAX = 60, FOOTER_MAX = 60, BTN_TEXT_MAX = 25;
const SAMPLE_VALUES = ['Rahul', '12 Aug 2026', 'GREEN20', '2:00 PM', 'Teamlink', 'Bengaluru'];
const renderSamples = (body: string) => body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => SAMPLE_VALUES[Number(n) - 1] ?? `{{${n}}}`);
const nextVarToken = (body: string) => {
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return `{{${nums.length ? Math.max(...nums) + 1 : 1}}}`;
};

// ── Root page: switches between list / builder / read-only view ───────────────
type ViewState =
  | { kind: 'list' }
  | { kind: 'builder'; mode: 'create' | 'edit'; template?: Template }
  | { kind: 'view'; template: Template };

export function TemplatesPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const [tab, setTab] = useState<Channel>('whatsapp');
  const [view, setView] = useState<ViewState>({ kind: 'list' });
  const lp = useListParams({ sort: 'updatedAt' });
  const qc = useQueryClient();
  const params = useMemo(() => ({ ...lp.params, filters: { ...lp.params.filters, channel: tab } }), [lp.params, tab]);
  const { data, isLoading, isFetching, isError, refetch } = useQuery({ queryKey: ['templates', orgId, params], queryFn: () => templatesService.list(orgId, params), enabled: !!orgId && view.kind === 'list' });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['templates', orgId] });
  const delM = useMutation({ mutationFn: (id: string) => templatesService.remove(orgId, id), onSuccess: invalidate });
  const [toDelete, setToDelete] = useState<Template | null>(null);
  // Meta connection check. A MUTATION, not a query: it must run on the click and
  // never before it, and a mutation is `isPending: false` until `mutate()` is
  // called — a disabled query would report pending forever and spin on arrival.
  // Gated on 'template.view', the permission GET /v1/templates/meta-status requires.
  const canCheckMeta = useCan('template.view');
  const [metaOpen, setMetaOpen] = useState(false);
  const metaM = useMutation({ mutationFn: () => templatesService.metaStatus(orgId) });
  const runMetaCheck = () => { setMetaOpen(true); metaM.mutate(); };

  // Sync and submit both need 'template.manage' — the permission their endpoints
  // require. Both are mutations for the same reason the Meta check is.
  const canManageTemplates = useCan('template.manage');
  const [syncOpen, setSyncOpen] = useState(false);
  // TWO mutations, not one with a flag: the preview and the write are different
  // events with different consequences, and keeping their results apart is what
  // lets the panel show "here is the plan" and then "here is what was done"
  // without one overwriting the other.
  const syncPlanM = useMutation({ mutationFn: () => templatesService.syncFromMeta(orgId, true) });
  const syncApplyM = useMutation({
    mutationFn: () => templatesService.syncFromMeta(orgId, false),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Sync applied — ${r.updated.length} updated, ${r.imported.length} imported`);
    },
  });
  const previewSync = () => { syncApplyM.reset(); syncPlanM.mutate(); setSyncOpen(true); };
  const closeSync = () => { setSyncOpen(false); syncPlanM.reset(); syncApplyM.reset(); };

  const [toSubmit, setToSubmit] = useState<Template | null>(null);
  const submitM = useMutation({
    mutationFn: (id: string) => templatesService.submitToMeta(orgId, id),
    // Meta decided the new status, so the list has to be re-read to show it.
    onSuccess: (r) => { invalidate(); toast.success(`Submitted to Meta — Meta returned ${r.meta.status}`); },
  });

  if (view.kind === 'builder' || view.kind === 'view') {
    return (
      <TemplateBuilder
        orgId={orgId}
        channel={view.kind === 'view' ? view.template.channel : (view.template?.channel ?? tab)}
        mode={view.kind === 'view' ? 'view' : view.mode}
        initial={view.kind === 'view' ? view.template : view.template}
        onEdit={(t) => setView({ kind: 'builder', mode: 'edit', template: t })}
        onExit={() => { setView({ kind: 'list' }); invalidate(); }}
      />
    );
  }

  const rows = data?.items ?? [];
  return (
    <div>
      <PageHeader title="Manage Templates" subtitle="Message templates by channel"
        actions={<>
          {canCheckMeta && (
            <Button variant="secondary" size="sm" onClick={runMetaCheck} loading={metaM.isPending}>
              <ShieldQuestion size={15} /> Check Meta connection
            </Button>
          )}
          {canManageTemplates && (
            <Button variant="secondary" size="sm" onClick={previewSync} loading={syncPlanM.isPending}>
              <CloudDownload size={15} /> Sync from Meta
            </Button>
          )}
          <Button size="sm" onClick={() => setView({ kind: 'builder', mode: 'create' })}><Plus size={15} /> Create Template</Button>
        </>} />
      {metaOpen && (
        <MetaConnectionPanel
          status={metaM.data}
          pending={metaM.isPending}
          error={metaM.error}
          onRecheck={() => metaM.mutate()}
          onClose={() => setMetaOpen(false)}
        />
      )}
      {syncOpen && (
        <MetaSyncPanel
          plan={syncPlanM.data}
          applied={syncApplyM.data}
          planning={syncPlanM.isPending}
          applying={syncApplyM.isPending}
          error={syncPlanM.error}
          applyError={syncApplyM.error}
          onReplan={() => { syncApplyM.reset(); syncPlanM.mutate(); }}
          onApply={() => syncApplyM.mutate()}
          onClose={closeSync}
        />
      )}
      <div className="mb-4"><Tabs tabs={CHANNEL_TABS} active={tab} onChange={(k) => { setTab(k as Channel); lp.setPage(1); }} /></div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search by name or category…" />
          {/* The server filters on the LOCAL status column, not on Meta's verdict.
              On the WhatsApp tab the options say so, so that picking one never
              promises something the badges below contradict. */}
          <Select className={tab === 'whatsapp' ? 'h-10 !w-56' : 'h-10 !w-40'} value={lp.filters.status ?? ''}
            onChange={(e) => lp.setFilter('status', e.target.value)}
            aria-label={tab === 'whatsapp' ? 'Filter by local status' : 'Filter by status'}
            title={tab === 'whatsapp' ? "Filters on Green Start's own status field, not on Meta's review result" : undefined}>
            <option value="">{tab === 'whatsapp' ? 'All local statuses' : 'All statuses'}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusFilterLabel(s, tab === 'whatsapp')}</option>)}
          </Select>
          <Select className="h-10 !w-40" value={lp.filters.category ?? ''} onChange={(e) => lp.setFilter('category', e.target.value)}>
            <option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          {/* isFetching, not isLoading: v5 keeps isLoading false during a refetch,
              so without this a working refresh of unchanged rows is
              indistinguishable from a dead button. */}
          <Button variant="secondary" size="sm" className="ml-auto" disabled={isFetching}
            onClick={() => refetch()}>
            <RefreshCw size={15} className={isFetching ? 'animate-spin' : undefined} />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
        {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
          : rows.length === 0 ? <EmptyState title={`No ${tab} templates`} detail="Create a template for this channel." action={<Button size="sm" onClick={() => setView({ kind: 'builder', mode: 'create' })}><Plus size={15} /> Create Template</Button>} />
          : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">
                  <button type="button" className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink" onClick={() => lp.toggleSort('name')}>
                    Template Name {lp.sort === 'name' && (lp.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                </th>
                <th className="px-4 py-3">Status</th><th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Language</th>
                <th className="px-4 py-3">
                  <button type="button" className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink" onClick={() => lp.toggleSort('updatedAt')}>
                    Last Updated {lp.sort === 'updatedAt' && (lp.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => setView({ kind: 'view', template: t })}>
                    <td className="px-4 py-3 font-mono text-xs text-ink">{t.name}</td>
                    <td className="px-4 py-3"><TemplateStatusBadge template={t} /></td>
                    <td className="px-4 py-3"><Badge>{t.category}</Badge></td>
                    <td className="px-4 py-3"><Badge>{langLabel(t.language || 'en')}</Badge></td>
                    <td className="px-4 py-3 text-muted">{new Date(t.updatedAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" onClick={() => setView({ kind: 'view', template: t })} aria-label="Open"><Pencil size={15} /></Button>
                      {canManageTemplates && canSubmitToMeta(t) && (
                        <Button variant="ghost" size="sm" title="Submit to Meta" aria-label="Submit to Meta"
                          onClick={() => { submitM.reset(); setToSubmit(t); }}><Send size={15} /></Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setToDelete(t)} aria-label="Delete"><Trash2 size={15} /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={lp.page} pageSize={lp.pageSize} total={data?.total ?? 0} onPage={lp.setPage} />
          </div>
        )}
      </Card>

      <ConfirmDialog open={!!toDelete} title="Delete template" danger confirmLabel="Delete" loading={delM.isPending}
        message={`Delete "${toDelete?.name}"?`} onConfirm={() => toDelete && delM.mutateAsync(toDelete.id).then(() => { toast.success('Template deleted'); setToDelete(null); }).catch(() => toast.error('Delete failed'))} onClose={() => setToDelete(null)} />

      <SubmitToMetaDialog
        template={toSubmit}
        pending={submitM.isPending}
        error={submitM.error}
        result={submitM.data}
        onSubmit={() => toSubmit && submitM.mutate(toSubmit.id)}
        onClose={() => { setToSubmit(null); submitM.reset(); }}
      />
    </div>
  );
}

// ── Builder / viewer ──────────────────────────────────────────────────────────
type BuilderForm = {
  name: string; category: string; language: string;
  headerType: TemplateHeaderType; headerText: string; headerMediaName: string;
  body: string; footer: string; callPermission: boolean; buttons: TemplateButton[];
};

function initialForm(t?: Template, channel?: Channel): BuilderForm {
  return {
    name: t?.name ?? '',
    category: t?.category ?? 'Utility',
    language: t?.language ?? 'en',
    headerType: t?.headerType ?? 'none',
    headerText: (channel === 'email' ? t?.header : t?.headerText) ?? '',
    headerMediaName: t?.headerMediaName ?? '',
    body: t?.body ?? '',
    footer: t?.footer ?? '',
    callPermission: t?.callPermission ?? false,
    buttons: t?.buttons ?? [],
  };
}

function TemplateBuilder({ orgId, channel, mode, initial, onExit, onEdit }: {
  orgId: string; channel: Channel; mode: 'create' | 'edit' | 'view';
  initial?: Template; onExit: () => void; onEdit: (t: Template) => void;
}) {
  const readOnly = mode === 'view';
  const isWa = channel === 'whatsapp';
  const isEmail = channel === 'email';
  const [form, setForm] = useState<BuilderForm>(() => initialForm(initial, channel));
  const [err, setErr] = useState<Record<string, string>>({});
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const set = <K extends keyof BuilderForm>(k: K, v: BuilderForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const insertVar = (token: string) => {
    const el = bodyRef.current;
    if (!el) { set('body', (form.body + token).slice(0, BODY_MAX)); return; }
    const start = el.selectionStart ?? form.body.length;
    const end = el.selectionEnd ?? form.body.length;
    const next = (form.body.slice(0, start) + token + form.body.slice(end)).slice(0, BODY_MAX);
    set('body', next);
    requestAnimationFrame(() => { el.focus(); const pos = Math.min(start + token.length, next.length); el.setSelectionRange(pos, pos); });
  };
  const status = initial?.status;
  const locked = mode === 'edit' && status !== undefined && status !== 'draft' && status !== 'rejected';

  const validation = useMemo(() => isWa
    ? validateWhatsAppTemplate({ category: form.category, body: form.body, footer: form.footer, buttonCount: form.buttons.length })
    : null, [isWa, form.category, form.body, form.footer, form.buttons.length]);

  const createM = useMutation({ mutationFn: (i: TemplateInput) => templatesService.create(orgId, i) });
  const updateM = useMutation({ mutationFn: (i: Partial<TemplateInput>) => templatesService.update(orgId, initial!.id, i) });
  const saving = createM.isPending || updateM.isPending;

  const buildInput = (): TemplateInput => ({
    name: form.name,
    channel,
    provider: initial?.provider ?? PROVIDER_BY_CHANNEL[channel],
    category: form.category,
    language: form.language,
    body: form.body,
    footer: form.footer || undefined,
    variables: countVars(form.body),
    header: isEmail ? (form.headerText || undefined) : undefined,
    headerType: isWa ? form.headerType : 'none',
    headerText: isWa && form.headerType === 'text' ? form.headerText : undefined,
    headerMediaName: isWa && ['image', 'video', 'document'].includes(form.headerType) ? form.headerMediaName : undefined,
    callPermission: isWa ? form.callPermission : undefined,
    buttons: isWa ? form.buttons : undefined,
  });

  const submit = () => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    else if (!/^[a-z0-9_]+$/.test(form.name)) errs.name = 'Lowercase letters, numbers and underscores only.';
    if (isEmail && !form.headerText.trim()) errs.subject = 'Subject is required.';
    if (form.body.replace(/<[^>]*>/g, '').trim().length < 3) errs.body = isEmail ? 'Email content is required.' : 'Body is too short.';
    if (isWa && validation?.verdict === 'FAIL') errs.body = 'Fix policy failures before submitting.';
    setErr(errs);
    if (Object.keys(errs).length) return;
    const input = buildInput();
    if (mode === 'create') {
      // Creating does NOT contact Meta: the server stores a WhatsApp template as
      // PENDING = "not yet registered". Saying "submitted" here was the origin of
      // the Pending-means-two-things confusion; the list's Submit to Meta is the step.
      createM.mutateAsync(input).then(() => { toast.success(isWa ? 'Template saved — not sent to Meta yet. Use "Submit to Meta" in the list to start the review.' : 'Template saved'); onExit(); })
        .catch((e) => toast.error(e?.message ?? 'Submit failed'));
    } else {
      updateM.mutateAsync(input).then(() => { toast.success('Template updated'); onExit(); })
        .catch((e) => toast.error(e?.message ?? 'Update failed'));
    }
  };

  const onMediaPick = (file?: File | null) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error('File must be 5MB or smaller.'); return; }
    set('headerMediaName', file.name);
    if (file.type.startsWith('image/')) { try { setMediaPreview(URL.createObjectURL(file)); } catch { setMediaPreview(null); } }
    else setMediaPreview(null);
  };

  const title = mode === 'create' ? `Create ${cap(channel)} Template` : initial?.name ?? 'Template';

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onExit} aria-label="Back"><ArrowLeft size={18} /></Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-semibold text-ink">{title}</h1>
              {readOnly && initial && <TemplateStatusBadge template={initial} />}
            </div>
            <div className="text-sm text-muted">
              {mode === 'create'
                ? (isEmail ? <>Design your email content</> : <>Creating for <span className="font-medium text-ink">{PROVIDER_BY_CHANNEL[channel]}</span></>)
                : <>Channel: {cap(channel)}</>}
            </div>
          </div>
        </div>
        {readOnly && initial && <Button size="sm" onClick={() => onEdit(initial)}><Pencil size={15} /> Edit Template</Button>}
      </div>

      {locked && (
        <div className="mb-4 rounded-[10px] border border-orange/30 bg-orange/5 p-3 text-sm text-orange">
          {/* The lock is Green Start's own rule (gs-api update: DRAFT/REJECTED only),
              not Meta's — a never-submitted WhatsApp row is PENDING and locked too. */}
          This template's status is <b>{initial ? templateStatusView(initial).label : cap(status!.replace('_', ' '))}</b>. Green Start only allows editing draft or rejected templates.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* Config */}
        <Card className="p-5">
          <div className="mb-4">
            <div className="font-display font-semibold text-ink">Template Configuration</div>
            <div className="text-sm text-muted">Define the content, variables, and settings for your template.</div>
          </div>

          <div className="space-y-4">
            <Field label={`${isWa ? 'WhatsApp ' : ''}Template Name`} error={err.name} hint="Lowercase letters, numbers and underscores only (Meta requirement).">
              <Input value={form.name} disabled={readOnly} invalid={!!err.name}
                onChange={(e) => set('name', e.target.value.toLowerCase().replace(/\s+/g, '_'))} placeholder="welcome_alert_v1" />
            </Field>

            {isEmail ? (
              <>
                <Field label="Email Subject" error={err.subject}>
                  <Input value={form.headerText} disabled={readOnly} onChange={(e) => set('headerText', e.target.value)} placeholder="Subject line for the recipient" />
                </Field>
                <Field label="Email Content" error={err.body}>
                  <EmailBodyEditor value={form.body} disabled={readOnly} onChange={(html) => set('body', html)} />
                </Field>
              </>
            ) : (
              <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <Select value={form.category} disabled={readOnly} onChange={(e) => set('category', e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </Select>
              </Field>
              <Field label="Language">
                <Select value={form.language} disabled={readOnly} onChange={(e) => set('language', e.target.value)}>
                  {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </Select>
              </Field>
            </div>

            {isWa && (
              <Field label="Header — Optional">
                <Select value={form.headerType} disabled={readOnly} onChange={(e) => { set('headerType', e.target.value as TemplateHeaderType); setMediaPreview(null); }}>
                  {HEADER_TYPES.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                </Select>
              </Field>
            )}

            {isWa && form.headerType === 'text' && (
              <Field label="Header Text">
                <Input value={form.headerText} disabled={readOnly} maxLength={HEADER_MAX} onChange={(e) => set('headerText', e.target.value)} placeholder="e.g. Your application update" />
                <div className="mt-1 flex justify-between text-xs text-muted"><span>Shown in bold above the message.</span><span>{form.headerText.length}/{HEADER_MAX}</span></div>
              </Field>
            )}

            {isWa && ['image', 'video', 'document'].includes(form.headerType) && (
              <MediaDropzone type={form.headerType} fileName={form.headerMediaName} readOnly={readOnly} onPick={onMediaPick} onClear={() => { set('headerMediaName', ''); setMediaPreview(null); }} />
            )}

            <Field label="Message Body" error={err.body}>
              <Textarea ref={bodyRef} rows={5} maxLength={BODY_MAX} value={form.body} disabled={readOnly} invalid={!!err.body} onChange={(e) => set('body', e.target.value)} placeholder="Hello {{1}}, …" />
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                <span className="flex items-center gap-2">
                  {!readOnly && <button type="button" className="rounded-[6px] border border-line px-2 py-0.5 font-medium text-accent hover:bg-surface-2" onClick={() => insertVar(nextVarToken(form.body))}>+ Variable</button>}
                  <span>Use {'{{1}}'}, {'{{2}}'} for dynamic values.</span>
                </span>
                <span>{form.body.length}/{BODY_MAX}</span>
              </div>
            </Field>

            <Field label="Footer Text — Optional">
              <Input value={form.footer} disabled={readOnly} maxLength={FOOTER_MAX} onChange={(e) => set('footer', e.target.value)} placeholder="e.g. Reply STOP to unsubscribe" />
              <div className="mt-1 flex justify-between text-xs text-muted"><span>Short text at the bottom of your message.</span><span>{form.footer.length}/{FOOTER_MAX}</span></div>
            </Field>

            {isWa && (
              <div className="flex items-center justify-between rounded-[10px] border border-line p-3">
                <div className="flex items-center gap-2">
                  <Phone size={18} className="text-accent" />
                  <div>
                    <div className="text-sm font-medium text-ink">Call Permission Request</div>
                    <div className="text-xs text-muted">Ask user's permission to receive calls from your business.</div>
                  </div>
                </div>
                <Toggle checked={form.callPermission} disabled={readOnly} onChange={(v) => set('callPermission', v)} />
              </div>
            )}

            {isWa && (
              <ButtonsEditor buttons={form.buttons} readOnly={readOnly} onChange={(b) => set('buttons', b)} />
            )}

            {validation && (form.body.length > 0) && (
              <div className={`rounded-[10px] border p-3 text-sm ${validation.verdict === 'FAIL' ? 'border-red/30 bg-red/5' : validation.verdict === 'WARN' ? 'border-orange/30 bg-orange/5' : 'border-green-3 bg-green-3'}`}>
                <div className="mb-1 font-medium">Policy check: {validation.verdict}</div>
                {validation.violations.length === 0 ? <span className="text-muted">No issues detected. Meta remains authoritative.</span>
                  : <ul className="list-inside list-disc space-y-0.5 text-muted">{validation.violations.map((v) => <li key={v.code}><b>{v.severity}</b> — {v.message}</li>)}</ul>}
              </div>
            )}
              </>
            )}
          </div>

          {!readOnly && (
            <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-4">
              <Button variant="secondary" size="sm" onClick={onExit}>Cancel</Button>
              <Button size="sm" loading={saving} disabled={locked || (isWa && validation?.verdict === 'FAIL')} onClick={submit}>
                {mode === 'create' ? 'Save Template' : 'Save Changes'}
              </Button>
            </div>
          )}
        </Card>

        {/* Live preview */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card className="p-4">
            <div className="mb-3">
              <div className="font-display font-semibold text-ink">Live Preview</div>
              <div className="text-xs text-muted">{readOnly ? 'How this template looks on mobile.' : `Real-time preview of your ${isEmail ? 'email' : 'message'}.`}</div>
            </div>
            {isEmail
              ? <MailPreview subject={form.headerText} body={form.body} />
              : <PhonePreview form={form} isWa={isWa} mediaPreview={mediaPreview} />}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Media upload dropzone ─────────────────────────────────────────────────────
function MediaDropzone({ type, fileName, readOnly, onPick, onClear }: {
  type: string; fileName: string; readOnly: boolean; onPick: (f?: File | null) => void; onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : '.pdf,.doc,.docx';
  const hint = type === 'image' ? 'JPG or PNG (Max 5MB)' : type === 'video' ? 'MP4 (Max 5MB)' : 'PDF or DOC (Max 5MB)';
  return (
    <Field label={`${cap(type)} Header`} hint="This media will be uploaded to Meta as an example for reviewers.">
      {fileName ? (
        <div className="flex items-center justify-between rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-sm">
          <span className="truncate text-ink">{fileName}</span>
          {!readOnly && <button type="button" className="text-muted hover:text-red" onClick={onClear} aria-label="Remove file"><X size={16} /></button>}
        </div>
      ) : readOnly ? (
        <div className="rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No {type} attached</div>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center gap-1 rounded-[10px] border border-dashed border-line bg-surface-2 px-4 py-6 text-center hover:border-accent">
          <Upload size={22} className="text-accent" />
          <span className="text-sm font-medium text-ink">Click to upload or drag and drop</span>
          <span className="text-xs text-muted">{hint}</span>
          <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => onPick(e.target.files?.[0])} />
        </button>
      )}
    </Field>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line'} ${disabled ? 'opacity-50' : ''}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

// ── Buttons / actions editor ──────────────────────────────────────────────────
function ButtonIcon({ type, size = 15 }: { type: TemplateButtonType; size?: number }) {
  const c = 'text-accent';
  if (type === 'URL') return <Globe size={size} className={c} />;
  if (type === 'PHONE') return <Phone size={size} className={c} />;
  if (type === 'WA_CALL') return <Phone size={size} className={c} />;
  if (type === 'COPY_CODE') return <Copy size={size} className={c} />;
  if (type === 'FLOW') return <WorkflowIcon size={size} className={c} />;
  if (type === 'ORDER_DETAILS') return <ClipboardList size={size} className={c} />;
  return <Reply size={size} className={c} />;
}

function ButtonsEditor({ buttons, readOnly, onChange }: { buttons: TemplateButton[]; readOnly: boolean; onChange: (b: TemplateButton[]) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const counts = useMemo(() => {
    const m: Partial<Record<TemplateButtonType, number>> = {};
    buttons.forEach((b) => { m[b.type] = (m[b.type] ?? 0) + 1; });
    return m;
  }, [buttons]);
  const add = (def: ActionDef) => {
    if (buttons.length >= MAX_BUTTONS) { toast.error('Up to 10 buttons.'); return; }
    onChange([...buttons, def.makeDefault()]);
    setMenuOpen(false);
  };
  const patch = (i: number, p: Partial<TemplateButton>) => onChange(buttons.map((b, idx) => idx === i ? { ...b, ...p } : b));
  const remove = (i: number) => onChange(buttons.filter((_, idx) => idx !== i));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-ink">Buttons — Optional</span>
          <span className="ml-2 text-xs text-muted">{buttons.length}/{MAX_BUTTONS}</span>
          <div className="text-xs text-muted">Drive interactions. More than 3 buttons will appear as a list.</div>
        </div>
        {!readOnly && (
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setMenuOpen((o) => !o)}><Plus size={15} /> Add Action <ChevronDown size={14} /></Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-[10px] border border-line bg-surface shadow-lg">
                  {ACTIONS.map((a) => {
                    const used = counts[a.type] ?? 0;
                    const disabled = used >= a.max || buttons.length >= MAX_BUTTONS;
                    return (
                      <button key={a.type} type="button" disabled={disabled} onClick={() => add(a)}
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${disabled ? 'cursor-not-allowed text-muted opacity-60' : 'text-ink hover:bg-surface-2'}`}>
                        <span className="flex items-center gap-2"><ButtonIcon type={a.type} /> {a.label}</span>
                        <span className="text-xs text-muted">{used}/{a.max}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {buttons.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
          {readOnly ? 'No buttons.' : 'No buttons added yet. Click "Add Action" to start.'}
        </div>
      ) : (
        <div className="space-y-2">
          {buttons.map((b, i) => (
            <div key={i} className="rounded-[10px] border border-line p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted"><ButtonIcon type={b.type} /> {actionLabel(b.type)}</span>
                {!readOnly && <button type="button" className="text-muted hover:text-red" onClick={() => remove(i)} aria-label="Remove button"><X size={15} /></button>}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Button Text">
                  <Input value={b.text} disabled={readOnly} maxLength={BTN_TEXT_MAX} onChange={(e) => patch(i, { text: e.target.value })} />
                  <div className="mt-1 text-right text-xs text-muted">{b.text.length}/{BTN_TEXT_MAX}</div>
                </Field>
                {b.type === 'URL' && (
                  <Field label="Website URL"><Input value={b.url ?? ''} disabled={readOnly} onChange={(e) => patch(i, { url: e.target.value })} placeholder="https://example.com" /></Field>
                )}
                {(b.type === 'PHONE' || b.type === 'WA_CALL') && (
                  <div className="grid grid-cols-[90px_1fr] gap-2">
                    <Field label="Code"><Input value={b.countryCode ?? ''} disabled={readOnly} onChange={(e) => patch(i, { countryCode: e.target.value })} placeholder="+91" /></Field>
                    <Field label="Phone Number"><Input value={b.phone ?? ''} disabled={readOnly} onChange={(e) => patch(i, { phone: e.target.value })} placeholder="9876543210" /></Field>
                  </div>
                )}
                {b.type === 'COPY_CODE' && (
                  <Field label="Offer Code"><Input value={b.offerCode ?? ''} disabled={readOnly} onChange={(e) => patch(i, { offerCode: e.target.value })} placeholder="SAVE20" /></Field>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Email rich-text editor (contentEditable) ─────────────────────────────────
function EmailBodyEditor({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Seed the editable div once, so React re-renders never move the caret.
  // Sanitised on the way in: a stored body is data from another user, not trusted markup.
  useEffect(() => { if (ref.current && ref.current.innerHTML !== (value || '')) ref.current.innerHTML = sanitizeHtml(value || ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const exec = (cmd: string) => {
    if (disabled) return;
    document.execCommand(cmd);
    ref.current?.focus();
    onChange(ref.current?.innerHTML ?? '');
  };
  const Tool = ({ cmd, title, children }: { cmd: string; title: string; children: ReactNode }) => (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(cmd)}
      className="grid h-8 w-8 place-items-center rounded-[6px] text-ink hover:bg-surface-2">{children}</button>
  );
  return (
    <div className="rounded-[10px] border border-line">
      <div ref={ref} contentEditable={!disabled} suppressContentEditableWarning
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
        data-placeholder="Write your email…"
        className="min-h-[220px] overflow-auto p-3 text-sm text-ink focus:outline-none [&:empty::before]:text-muted [&:empty::before]:content-[attr(data-placeholder)]" />
      {!disabled && (
        <div className="flex flex-wrap items-center gap-1 border-t border-line p-2">
          <Tool cmd="bold" title="Bold"><Bold size={15} /></Tool>
          <Tool cmd="italic" title="Italic"><Italic size={15} /></Tool>
          <Tool cmd="underline" title="Underline"><Underline size={15} /></Tool>
          <span className="mx-1 h-5 w-px bg-line" />
          <Tool cmd="justifyLeft" title="Align left"><AlignLeft size={15} /></Tool>
          <Tool cmd="justifyCenter" title="Align center"><AlignCenter size={15} /></Tool>
          <Tool cmd="justifyRight" title="Align right"><AlignRight size={15} /></Tool>
          <span className="mx-1 h-5 w-px bg-line" />
          <Tool cmd="insertUnorderedList" title="Bulleted list"><List size={15} /></Tool>
          <Tool cmd="insertOrderedList" title="Numbered list"><ListOrdered size={15} /></Tool>
        </div>
      )}
    </div>
  );
}

// ── Email (Mail app) preview ──────────────────────────────────────────────────
function MailPreview({ subject, body }: { subject: string; body: string }) {
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[28px] border-[6px] border-[#111b21] bg-white shadow-lg">
      <div className="flex items-center gap-2 rounded-t-[20px] bg-[#f2f4f6] px-3 py-2">
        <div className="grid h-7 w-7 place-items-center rounded-full bg-accent/10"><Mail size={15} className="text-accent" /></div>
        <div className="leading-tight"><div className="text-[12px] font-semibold text-ink">Mail</div><div className="text-[9px] text-muted">now</div></div>
      </div>
      <div className="min-h-[300px] px-3 py-3">
        <div className="rounded-[10px] border border-line p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-ink">{subject || 'No Subject'}</div>
            <div className="shrink-0 text-[9px] text-muted">10:30 AM</div>
          </div>
          <div className="mt-2 break-words text-[11px] leading-snug text-ink [&_*]:!text-[11px]"
            dangerouslySetInnerHTML={{ __html: body ? sanitizeHtml(body) : '<span style="color:#9aa3a0">Your email content preview…</span>' }} />
        </div>
      </div>
    </div>
  );
}

// ── WhatsApp-style phone preview ──────────────────────────────────────────────
function PhonePreview({ form, isWa, mediaPreview }: { form: BuilderForm; isWa: boolean; mediaPreview: string | null }) {
  const hasMedia = ['image', 'video', 'document'].includes(form.headerType);
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[28px] border-[6px] border-[#111b21] bg-[#e6ddd4] p-0 shadow-lg">
      {/* status bar */}
      <div className="flex items-center justify-between rounded-t-[20px] bg-[#0b7d63] px-3 pb-2 pt-2 text-white">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-white/20 text-[11px]">WA</div>
          <div className="leading-tight">
            <div className="text-[12px] font-semibold">{isWa ? 'WhatsApp Business' : cap(form.category)}</div>
            <div className="text-[9px] opacity-80">Business Account</div>
          </div>
        </div>
      </div>
      {/* chat */}
      <div className="min-h-[280px] space-y-2 px-3 py-3">
        <div className="mx-auto w-fit rounded-[6px] bg-[#fdf6c9] px-2 py-1 text-center text-[8px] leading-tight text-[#8a7f52]">
          Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
        </div>
        <div className="max-w-[85%] rounded-[10px] rounded-tl-[2px] bg-white p-2 shadow-sm">
          {isWa && hasMedia && (
            <div className="mb-1 grid h-24 w-full place-items-center overflow-hidden rounded-[6px] bg-[#cfd8dc] text-[9px] font-semibold uppercase text-[#607d8b]">
              {form.headerType === 'image' && mediaPreview
                ? <img src={mediaPreview} alt="header" className="h-full w-full object-cover" />
                : `${form.headerType} header`}
            </div>
          )}
          {isWa && form.headerType === 'text' && form.headerText && (
            <div className="mb-1 text-[12px] font-bold text-ink">{form.headerText}</div>
          )}
          <div className="whitespace-pre-wrap break-words text-[12px] leading-snug text-ink">
            {form.body ? renderSamples(form.body) : <span className="text-muted">Your message preview appears here…</span>}
          </div>
          {form.footer && <div className="mt-1 text-[10px] text-[#8a929a]">{form.footer}</div>}
          <div className="mt-1 text-right text-[9px] text-[#8a929a]">10:30 AM</div>
          {isWa && form.buttons.length > 0 && (
            <div className="mt-1 space-y-1 border-t border-[#eef1f2] pt-1">
              {form.buttons.map((b, i) => (
                <div key={i} className="flex items-center justify-center gap-1 rounded-[6px] py-1 text-[11px] font-medium text-[#1f8fd6]">
                  <ButtonIcon type={b.type} size={13} /> {b.text || actionLabel(b.type)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-b-[20px] bg-[#e6ddd4] px-3 pb-3 pt-1">
        <div className="flex-1 rounded-full bg-white px-3 py-1.5 text-[10px] text-muted">Message</div>
      </div>
    </div>
  );
}
