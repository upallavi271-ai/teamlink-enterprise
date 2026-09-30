import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Upload, Sheet, Download, Columns3, Copy, Check, Pencil, Trash2, UserPlus, MoreHorizontal, ChevronLeft, ChevronRight, ArrowUpDown,
  X, FileInput, Bot, GripVertical, ArrowUp, ArrowDown, EyeOff, Mail,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { useQuery } from '@tanstack/react-query';
import { useCustomers, useAgents, useCustomerMutations } from './useCustomers';
import { CustomerFormModal, AssignAgentModal, ImportCustomersWizard, GoogleSheetsSyncModal } from './CustomerModals';
import { LEAD_STAGES, LEAD_STATUSES, cap } from '../crmLabels';
import { toast } from '@/components/toast/toastStore';
import { PageHeader } from '@/components/layout/PageHeader';
import { customersService, type BulkImportResult } from '@/services/crm/customers.service';
import { useOrgStore } from '@/stores/orgStore';
import { webformsService } from '@/services/webforms/webforms.service';
import { botDataService } from '@/services/botdata/botData.service';
import type { Customer, CustomerInput, LeadStage, LeadStatus } from '@/types';

// ── Columns (Manage Columns toggles these; Customer Name + Actions are fixed) ──
type ColKey = 'phone' | 'source' | 'campaign' | 'email' | 'createdOn' | 'platformId' | 'leadStage' | 'leadStatus' | 'agent';
type SortKey = 'name' | 'createdAt' | 'leadStage';
/** `chip` marks the two lead columns the reference highlights in the header. */
const COLUMNS: { key: ColKey; label: string; sort?: SortKey; chip?: boolean }[] = [
  { key: 'phone', label: 'Phone Number' },
  { key: 'source', label: 'Source' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'email', label: 'Email Address' },
  { key: 'createdOn', label: 'Created On', sort: 'createdAt' },
  { key: 'platformId', label: 'Platform ID' },
  { key: 'leadStage', label: 'Lead Stage', sort: 'leadStage', chip: true },
  { key: 'leadStatus', label: 'Lead Status', chip: true },
  { key: 'agent', label: 'Assign' },
];
const PAGE_SIZES = [10, 20, 50, 100];

const SOURCE_TONE: Record<string, 'neutral' | 'green' | 'blue' | 'orange' | 'violet'> = {
  WhatsApp: 'green', 'Web Form': 'blue', 'CSV Import': 'orange', Facebook: 'violet', Referral: 'neutral',
};

const xmlEsc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));

// Real Excel-openable workbook (SpreadsheetML), same shape as the Communication selector export.
function buildSpreadsheet(rows: Customer[], agentName: Record<string, string>): string {
  const headers = ['Customer Name', 'Phone', 'Email', 'Source', 'Campaign', 'Platform ID', 'Lead Stage', 'Lead Status', 'Assigned Agent', 'Created On'];
  const cell = (v: string) => `<Cell><Data ss:Type="String">${xmlEsc(v ?? '')}</Data></Cell>`;
  const row = (cells: string[]) => `<Row>${cells.map(cell).join('')}</Row>`;
  const body = rows.map((c) => row([
    c.name ?? '', c.phone ?? '', c.email ?? '', c.source ?? '', c.campaignName ?? '', c.platformId ?? '',
    cap(c.leadStage ?? ''), cap(c.leadStatus ?? ''), c.assignedAgentId ? agentName[c.assignedAgentId] ?? '' : '',
    new Date(c.createdAt).toLocaleString(),
  ])).join('');
  return `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Customers"><Table>${row(headers)}${body}</Table></Worksheet></Workbook>`;
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';

/** An absent value. The reference shows a dash here and keeps italic "Empty"
 *  for the email cell alone, which also carries an envelope icon. */
const Empty = () => <span className="text-muted">—</span>;

function CopyPhone({ phone }: { phone: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(phone); setDone(true); setTimeout(() => setDone(false), 1200); }
    catch { toast.error('Could not copy'); }
  };
  return (
    <button type="button" onClick={copy} title="Copy phone" aria-label="Copy phone"
      className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink">
      {done ? <Check size={13} className="text-green" /> : <Copy size={13} />}
    </button>
  );
}

function ManageColumns({ visible, onToggle }: { visible: Set<ColKey>; onToggle: (k: ColKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Columns3 size={15} /> Manage Columns
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-52 rounded-[10px] border border-line bg-surface p-2 shadow-card">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Show columns</div>
          {COLUMNS.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-surface-2">
              <Checkbox checked={visible.has(c.key)} onChange={() => onToggle(c.key)} /> {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Per-column header menu — sort, reorder, hide. The reference puts one on every
 * column; this is the same menu Bot Data uses, so the two tables behave alike.
 */
function ColumnMenu({ label, sortKey, onSort, onMove, onHide, canMoveLeft, canMoveRight }: {
  label: string;
  sortKey?: SortKey;
  onSort: (key: SortKey, dir: 'asc' | 'desc') => void;
  onMove: (delta: -1 | 1) => void;
  onHide: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const item = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`${label} column options`} aria-expanded={open}
        className="rounded p-0.5 text-muted opacity-60 transition-opacity hover:bg-surface-2 hover:text-ink group-hover:opacity-100">
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-40 rounded-[10px] border border-line bg-surface p-1 text-left shadow-card">
          {sortKey && (
            <>
              <button type="button" className={item} onClick={() => { onSort(sortKey, 'asc'); setOpen(false); }}>
                <ArrowUp size={12} className="text-muted" /> Sort ascending
              </button>
              <button type="button" className={item} onClick={() => { onSort(sortKey, 'desc'); setOpen(false); }}>
                <ArrowDown size={12} className="text-muted" /> Sort descending
              </button>
              <div className="my-1 h-px bg-line" />
            </>
          )}
          <button type="button" className={item} disabled={!canMoveLeft} onClick={() => { onMove(-1); setOpen(false); }}>
            <ChevronLeft size={12} className="text-muted" /> Move left
          </button>
          <button type="button" className={item} disabled={!canMoveRight} onClick={() => { onMove(1); setOpen(false); }}>
            <ChevronRight size={12} className="text-muted" /> Move right
          </button>
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => { onHide(); setOpen(false); }}>
            <EyeOff size={12} className="text-muted" /> Hide column
          </button>
        </div>
      )}
    </div>
  );
}

export function CustomersPage() {
  const [sp, setSp] = useSearchParams();
  // Capture-source filters arrive in the URL (Web Forms "View", Bot Data
  // "contacts"), so the filtered list is bookmarkable and shareable.
  const webFormId = sp.get('webFormId') ?? undefined;
  const botFlowId = sp.get('botFlowId') ?? undefined;
  const lp = useListParams({
    sort: 'createdAt', dir: 'desc', pageSize: 20,
    filters: { webFormId, botFlowId, source: sp.get('source') ?? undefined },
  });
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, isFetching } = useCustomers(lp.params);
  const { data: agents = [] } = useAgents();
  const m = useCustomerMutations();
  const canEdit = useCan('customer.edit'), canDelete = useCan('customer.delete'), canExport = useCan('customer.export');
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState<Set<ColKey>>(new Set(COLUMNS.map((c) => c.key)));
  // Column order is real: the grip drags, and the header menu moves by keyboard.
  const [order, setOrder] = useState<ColKey[]>(COLUMNS.map((c) => c.key));
  const [dragKey, setDragKey] = useState<ColKey | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [assigning, setAssigning] = useState<Customer | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Customer | null>(null);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [inlineBusy, setInlineBusy] = useState<string | null>(null);

  // Honor global header search (?q=). Consume only `q` — wiping every param
  // would drop the capture filter (and its chip) that arrived in the same URL.
  useEffect(() => {
    const q = sp.get('q');
    if (!q) return;
    lp.setSearch(q);
    const next = new URLSearchParams(sp);
    next.delete('q');
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentName = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])), [agents]);

  // The chip names what it is filtering by, so a short list never looks like
  // missing data. Names are read from the source module, not the URL.
  const formFilter = useQuery({
    queryKey: ['web-form', orgId, webFormId], enabled: !!orgId && !!webFormId,
    queryFn: () => webformsService.get(orgId, webFormId!),
  });
  const botFlows = useQuery({
    queryKey: ['bot-data', orgId, 'bots'], enabled: !!orgId && !!botFlowId,
    queryFn: () => botDataService.bots(),
  });
  const activeFilter = webFormId
    ? { kind: 'form' as const, label: formFilter.data?.name ?? 'this form', to: '/app/crm/web-forms' }
    : botFlowId
      ? { kind: 'bot' as const, label: (botFlows.data ?? []).find((b) => b.id === botFlowId)?.name ?? 'this bot', to: '/app/crm/bot-data' }
      : null;

  const clearCaptureFilter = () => {
    lp.setFilter('webFormId', undefined);
    lp.setFilter('botFlowId', undefined);
    const next = new URLSearchParams(sp);
    next.delete('webFormId');
    next.delete('botFlowId');
    setSp(next, { replace: true });
  };

  /** Clicking a Source badge narrows the list to that source (click again to clear). */
  const toggleSourceFilter = (source: string) => {
    const on = lp.filters.source === source;
    lp.setFilter('source', on ? undefined : source);
    const next = new URLSearchParams(sp);
    if (on) next.delete('source'); else next.set('source', source);
    setSp(next, { replace: true });
  };
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / lp.pageSize));
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allChecked) rows.forEach((r) => n.delete(r.id)); else rows.forEach((r) => n.add(r.id));
    return n;
  });
  const toggleOne = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleCol = (k: ColKey) => setVisible((v) => { const n = new Set(v); n.has(k) ? n.delete(k) : n.add(k); return n; });

  /** The visible columns, in the user's order — what both header and body iterate. */
  const shownCols = useMemo(
    () => order.map((k) => COLUMNS.find((c) => c.key === k)!).filter((c) => visible.has(c.key)),
    [order, visible],
  );
  /** Move within the VISIBLE sequence, so a hidden neighbour never eats the move. */
  const moveCol = (key: ColKey, delta: -1 | 1) => setOrder((o) => {
    const vis = o.filter((k) => visible.has(k));
    const i = vis.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= vis.length) return o;
    const swapped = [...vis];
    [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
    // Rebuild the full order, leaving hidden columns where they sat.
    let n = 0;
    return o.map((k) => (visible.has(k) ? swapped[n++] : k));
  });
  const dropCol = (target: ColKey) => {
    if (!dragKey || dragKey === target) return;
    setOrder((o) => {
      const next = o.filter((k) => k !== dragKey);
      next.splice(next.indexOf(target), 0, dragKey);
      return next;
    });
    setDragKey(null);
  };
  const sortBy = (key: SortKey, dir: 'asc' | 'desc') => lp.applySort(key, dir);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (c: Customer) => { setEditing(c); setFormOpen(true); };

  const onSave = (input: CustomerInput) => {
    const action = editing ? m.update.mutateAsync({ id: editing.id, patch: input }) : m.create.mutateAsync(input);
    action.then(() => { toast.success(editing ? 'Customer updated' : 'Customer added'); setFormOpen(false); })
      .catch((e) => toast.error(e?.message ?? 'Save failed'));
  };

  // Inline Lead Stage / Lead Status change → PATCH straight away.
  const patchInline = (c: Customer, patch: Partial<CustomerInput>, label: string) => {
    setInlineBusy(c.id);
    m.update.mutateAsync({ id: c.id, patch })
      .then(() => toast.success(`${label} updated`))
      .catch((e) => toast.error(e?.message ?? 'Update failed'))
      .finally(() => setInlineBusy(null));
  };

  const onAssign = (agentId: string | undefined) => {
    if (!assigning) return;
    m.update.mutateAsync({ id: assigning.id, patch: { assignedAgentId: agentId } })
      .then(() => { toast.success(agentId ? `Assigned to ${agentName[agentId] ?? 'agent'}` : 'Agent unassigned'); setAssigning(null); })
      .catch((e) => toast.error(e?.message ?? 'Assign failed'));
  };

  const confirmDelete = () => {
    if (!toDelete) return;
    m.remove.mutateAsync(toDelete.id).then(() => { toast.success('Customer deleted'); setToDelete(null); })
      .catch((e) => toast.error(e?.message ?? 'Delete failed'));
  };
  const confirmBulkDelete = () => {
    m.removeMany.mutateAsync([...selected]).then(() => { toast.success(`${selected.size} deleted`); setSelected(new Set()); setBulkDelete(false); })
      .catch((e) => toast.error(e?.message ?? 'Delete failed'));
  };

  // Export every matching contact (respecting the current search), not just this page.
  const exportExcel = async () => {
    setExporting(true);
    try {
      const all = await customersService.all(orgId, lp.params);
      if (!all.length) { toast.info('Nothing to export'); return; }
      const blob = new Blob([buildSpreadsheet(all, agentName)], { type: 'application/vnd.ms-excel' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `customers-${new Date().toISOString().slice(0, 10)}.xls`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${all.length} customer${all.length === 1 ? '' : 's'} to Excel`);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const onImported = (r: BulkImportResult) => {
    setImportOpen(false);
    refetch();
    toast.success(`Imported ${r.created} customer${r.created === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped` : ''}`);
  };

  const colSpan = 2 + shownCols.length + 1;
  const stickyShadow = 'shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.25)]';

  return (
    <div>
      {/* Header — title left, Import Data / Google Sheets / + Add Customer right */}
      <PageHeader
        title="Customers"
        subtitle="Manage leads and view captured data."
        actions={<>
          {canEdit && <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}><Upload size={15} /> Import Data</Button>}
          <Button variant="secondary" size="sm" onClick={() => setSheetsOpen(true)}><Sheet size={15} className="text-green" /> Google Sheets</Button>
          {canEdit && <Button size="sm" onClick={openAdd}><Plus size={15} /> Add Customer</Button>}
        </>}
      />

      {/* Toolbar sits on the page, above the table — as in the reference. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search..." />
        <ManageColumns visible={visible} onToggle={toggleCol} />
        <RefreshButton keys={['customers', 'agents']} />
        {canExport && (
          <Button variant="secondary" size="sm" onClick={exportExcel} loading={exporting} disabled={total === 0}>
            <Download size={15} /> Export Excel
          </Button>
        )}
        {selected.size > 0 && canDelete && (
          <Button variant="danger" size="sm" className="ml-auto" onClick={() => setBulkDelete(true)}>
            <Trash2 size={15} /> Delete ({selected.size})
          </Button>
        )}
      </div>

      {/* View tabs, also on the page background and directly above the table. */}
      <div className="flex items-center gap-1">
        <button type="button" className="inline-flex items-center gap-1.5 rounded-t-[10px] border border-b-0 border-line bg-surface px-3 py-2 text-sm font-medium text-ink">
          <FileInput size={14} className="text-accent" /> Default
        </button>
        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-ink" title="Saved views"
          onClick={() => toast.info('Saved views: only the Default view exists for now')} aria-label="More views">
          <MoreHorizontal size={16} />
        </button>
      </div>

      <Card className="overflow-hidden rounded-tl-none">

        {/* Active capture filter — named, and one click to clear. */}
        {activeFilter && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-3 py-2 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-2.5 py-1 text-xs font-medium text-ink">
              {activeFilter.kind === 'form' ? <FileInput size={12} className="text-accent" /> : <Bot size={12} className="text-accent" />}
              {activeFilter.kind === 'form' ? 'Form' : 'Bot'}: {activeFilter.label}
              <button type="button" onClick={clearCaptureFilter} aria-label="Clear filter" className="ml-0.5 rounded-full p-0.5 text-muted hover:bg-surface-2 hover:text-ink">
                <X size={11} />
              </button>
            </span>
            <span className="text-xs text-muted">Showing only contacts captured here.</span>
            <button type="button" onClick={() => navigate(activeFilter.to)} className="ml-auto text-xs font-medium text-accent hover:underline">
              Back to {activeFilter.kind === 'form' ? 'Web Forms' : 'WhatsApp Bot Data'}
            </button>
          </div>
        )}

        {isLoading ? <LoadingState label="Loading customers…" />
          : isError ? <ErrorState message="Could not load customers." onRetry={() => refetch()} />
          : (
          <>
            <div className="overflow-x-auto">
              <table className={`w-full min-w-[1560px] border-collapse text-sm ${isFetching ? 'opacity-60' : ''}`}>
                <thead>
                  <tr className="border-b border-line bg-surface-2/60 text-left text-xs">
                    <th className="w-10 px-3 py-3"><Checkbox checked={allChecked} onChange={toggleAll} aria-label="Select all" /></th>
                    <th className="group min-w-[180px] px-3 py-3">
                      <div className="flex items-center gap-1">
                        <button type="button" className="inline-flex items-center gap-1 whitespace-nowrap font-semibold text-ink"
                          onClick={() => lp.toggleSort('name')}>
                          Customer Name <ArrowUpDown size={11} className="text-muted" />
                        </button>
                        <ColumnMenu label="Customer Name" sortKey="name" onSort={sortBy}
                          onMove={() => undefined} onHide={() => undefined} canMoveLeft={false} canMoveRight={false} />
                      </div>
                    </th>
                    {shownCols.map((col, i) => (
                      <th key={col.key}
                        draggable
                        onDragStart={() => setDragKey(col.key)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => dropCol(col.key)}
                        onDragEnd={() => setDragKey(null)}
                        className={`group whitespace-nowrap px-3 py-3 ${dragKey === col.key ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-1">
                          <GripVertical size={12} className="cursor-grab text-muted opacity-40 transition-opacity group-hover:opacity-100" aria-hidden />
                          {col.sort ? (
                            <button type="button"
                              className={`inline-flex items-center gap-1 font-semibold ${
                                col.chip ? 'rounded-md bg-accent-soft px-2 py-0.5 text-accent' : 'text-ink'
                              }`}
                              onClick={() => lp.toggleSort(col.sort!)}>
                              {col.label} <ArrowUpDown size={11} className="opacity-60" />
                            </button>
                          ) : (
                            <span className={`font-semibold ${
                              col.chip ? 'rounded-md bg-accent-soft px-2 py-0.5 text-accent' : 'text-ink'
                            }`}>{col.label}</span>
                          )}
                          <ColumnMenu
                            label={col.label} sortKey={col.sort} onSort={sortBy}
                            onMove={(d) => moveCol(col.key, d)}
                            onHide={() => toggleCol(col.key)}
                            canMoveLeft={i > 0} canMoveRight={i < shownCols.length - 1}
                          />
                        </div>
                      </th>
                    ))}
                    <th className={`sticky right-0 whitespace-nowrap border-l border-line bg-[#f6f8f7] px-3 py-3 text-right font-semibold uppercase tracking-wide text-ink ${stickyShadow}`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={colSpan}>
                      <EmptyState title="No customers found" detail={lp.search ? 'Try a different search.' : 'Add your first customer or import a CSV.'}
                        action={canEdit ? <Button size="sm" onClick={openAdd}><Plus size={15} /> Add Customer</Button> : undefined} />
                    </td></tr>
                  ) : rows.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                      <td className="px-3 py-3"><Checkbox checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} aria-label={`Select ${c.name}`} /></td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{initials(c.name)}</span>
                          <button type="button" className="font-medium text-ink hover:underline" onClick={() => openEdit(c)} title="Open customer">{c.name}</button>
                        </div>
                      </td>
                      {shownCols.map((col) => (
                        <td key={col.key} className="whitespace-nowrap px-3 py-3">
                          {col.key === 'phone' && (c.phone
                            ? <span className="inline-flex items-center gap-1 text-ink">{c.phone} <CopyPhone phone={c.phone} /></span>
                            : <Empty />)}

                          {col.key === 'source' && (
                            <>
                              <button type="button" onClick={() => toggleSourceFilter(c.source)}
                                title={lp.filters.source === c.source ? 'Clear this source filter' : `Show only ${c.source} contacts`}>
                                <Badge tone={SOURCE_TONE[c.source] ?? 'neutral'}>{c.source}</Badge>
                              </button>
                              {c.capturedBy && (
                                <button type="button"
                                  onClick={() => navigate(c.capturedBy!.kind === 'web_form'
                                    ? `/app/crm/web-forms?highlight=${c.capturedBy!.id}`
                                    : `/app/crm/bot-data?botId=${c.capturedBy!.id}`)}
                                  className="mt-0.5 block max-w-[140px] truncate text-left text-[11px] text-muted hover:text-accent hover:underline">
                                  via {c.capturedBy.name}
                                </button>
                              )}
                            </>
                          )}

                          {col.key === 'campaign' && <span className="text-ink">{c.campaignName || <Empty />}</span>}

                          {/* The reference marks a missing address rather than leaving the cell blank. */}
                          {col.key === 'email' && (
                            <span className="inline-flex items-center gap-1.5">
                              <Mail size={13} className="shrink-0 text-muted" aria-hidden />
                              {c.email
                                ? <span className="text-ink">{c.email}</span>
                                : <span className="text-xs italic text-muted">Empty</span>}
                            </span>
                          )}

                          {col.key === 'createdOn' && <span className="text-muted">{fmtDate(c.createdAt)}</span>}
                          {col.key === 'platformId' && <span className="font-mono text-xs text-muted">{c.platformId || <Empty />}</span>}

                          {col.key === 'leadStage' && (
                            <Select className="h-9 !w-36 text-xs" value={c.leadStage} disabled={!canEdit || inlineBusy === c.id}
                              onChange={(e) => patchInline(c, { leadStage: e.target.value as LeadStage }, 'Lead stage')} aria-label={`Lead stage for ${c.name}`}>
                              {LEAD_STAGES.map((st) => <option key={st} value={st}>{cap(st)}</option>)}
                            </Select>
                          )}
                          {col.key === 'leadStatus' && (
                            <Select className="h-9 !w-36 text-xs" value={c.leadStatus} disabled={!canEdit || inlineBusy === c.id}
                              onChange={(e) => patchInline(c, { leadStatus: e.target.value as LeadStatus }, 'Lead status')} aria-label={`Lead status for ${c.name}`}>
                              {LEAD_STATUSES.map((st) => <option key={st} value={st}>{cap(st)}</option>)}
                            </Select>
                          )}

                          {col.key === 'agent' && (
                            <Button variant="secondary" size="sm" className="h-9" disabled={!canEdit} onClick={() => setAssigning(c)}>
                              <UserPlus size={14} /> {c.assignedAgentId ? agentName[c.assignedAgentId] ?? 'Assigned' : 'Assign Agent'}
                            </Button>
                          )}
                        </td>
                      ))}
                      <td className={`sticky right-0 border-l border-line bg-surface px-3 py-3 text-right ${stickyShadow}`}>
                        <div className="inline-flex items-center gap-1">
                          <button type="button" disabled={!canEdit} onClick={() => openEdit(c)} title="Edit" aria-label={`Edit ${c.name}`}
                            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40"><Pencil size={15} /></button>
                          <button type="button" disabled={!canDelete} onClick={() => setToDelete(c)} title="Delete" aria-label={`Delete ${c.name}`}
                            className="rounded-lg p-1.5 text-muted hover:bg-red/10 hover:text-red disabled:opacity-40"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer: Page X of Y • Total N | rows per page | prev/next */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5 text-sm text-muted">
              <div>Page {Math.min(lp.page, pageCount)} of {pageCount} <span className="mx-1">•</span> Total {total}</div>
              <div className="flex items-center gap-2">
                <Select className="h-8 !w-20 text-xs" value={lp.pageSize} onChange={(e) => lp.setPageSize(Number(e.target.value))} aria-label="Rows per page">
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
                <Button variant="secondary" size="sm" disabled={lp.page <= 1} onClick={() => lp.setPage(lp.page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></Button>
                <Button variant="secondary" size="sm" disabled={lp.page >= pageCount} onClick={() => lp.setPage(lp.page + 1)} aria-label="Next page"><ChevronRight size={15} /></Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {formOpen && (
        <CustomerFormModal customer={editing} saving={m.create.isPending || m.update.isPending} onClose={() => setFormOpen(false)} onSave={onSave} />
      )}
      {assigning && (
        <AssignAgentModal customer={assigning} agents={agents} saving={m.update.isPending} onAssign={onAssign} onClose={() => setAssigning(null)} />
      )}
      {importOpen && <ImportCustomersWizard orgId={orgId} onClose={() => setImportOpen(false)} onDone={onImported} />}
      {sheetsOpen && (
        <GoogleSheetsSyncModal onClose={() => setSheetsOpen(false)}
          onGoToSettings={() => { setSheetsOpen(false); navigate('/app/settings?tab=integrations'); }} />
      )}

      <ConfirmDialog open={!!toDelete} title="Delete customer" danger confirmLabel="Delete" loading={m.remove.isPending}
        message={`Delete ${toDelete?.name}? This cannot be undone.`} onConfirm={confirmDelete} onClose={() => setToDelete(null)} />
      <ConfirmDialog open={bulkDelete} title="Delete selected" danger confirmLabel="Delete" loading={m.removeMany.isPending}
        message={`Delete ${selected.size} selected customer(s)? This cannot be undone.`} onConfirm={confirmBulkDelete} onClose={() => setBulkDelete(false)} />
    </div>
  );
}
