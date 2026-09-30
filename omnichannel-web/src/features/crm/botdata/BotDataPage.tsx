import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search, RefreshCw, Download, Sheet, SlidersHorizontal, MoreHorizontal, ArrowUp, ArrowDown, EyeOff,
  Eye, Trash2, UserPlus, ChevronLeft, ChevronRight, Bot, Info, Users, ExternalLink,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { useCan } from '@/features/auth/useCan';
import { useAgents } from '@/features/crm/customers/useCustomers';
import { toast } from '@/components/toast/toastStore';
import { PageHeader } from '@/components/layout/PageHeader';
import { botDataService } from '@/services/botdata/botData.service';
import type { BotSubmission, BotSubmissionStatus } from '@/services/botdata/botData.types';
import { useOrgStore } from '@/stores/orgStore';
import { LEAD_STAGES, LEAD_STATUSES, cap } from '@/features/crm/crmLabels';
import type { Agent, LeadStage, LeadStatus } from '@/types';

// ── column model ─────────────────────────────────────────────────────────────
type ColKey = 'leadStage' | 'leadStatus' | 'email' | 'platformId' | 'botFlow' | 'status' | 'timestamp' | 'assign';
type SortKey = 'identity' | 'email' | 'status' | 'occurredAt';
const COLUMNS: { key: ColKey; label: string; sort?: SortKey; chip?: boolean }[] = [
  // Lead fields belong to the linked CRM contact — shown as chips, like the CRM field columns.
  { key: 'leadStage', label: 'Lead Stage', chip: true },
  { key: 'leadStatus', label: 'Lead Status', chip: true },
  { key: 'email', label: 'Email', sort: 'email' },
  { key: 'platformId', label: 'Platform ID' },
  { key: 'botFlow', label: 'Bot Flow' },
  { key: 'status', label: 'Status', sort: 'status' },
  { key: 'timestamp', label: 'Timestamp', sort: 'occurredAt' },
  { key: 'assign', label: 'Assign' },
];
const PAGE_SIZES = [10, 20, 50, 100];

const STATUSES: { value: BotSubmissionStatus; label: string; tone: 'blue' | 'orange' | 'green' | 'neutral' }[] = [
  { value: 'new', label: 'New', tone: 'blue' },
  { value: 'in_progress', label: 'In progress', tone: 'orange' },
  { value: 'completed', label: 'Completed', tone: 'green' },
  { value: 'abandoned', label: 'Abandoned', tone: 'neutral' },
];
const statusMeta = (s: BotSubmissionStatus) => STATUSES.find((x) => x.value === s) ?? STATUSES[0];
/** Colour is never the only signal — the select text carries the same meaning. */
const DOT: Record<'blue' | 'orange' | 'green' | 'neutral', string> = {
  blue: 'bg-blue', orange: 'bg-orange', green: 'bg-green', neutral: 'bg-muted',
};

/** One segment of the toolbar's action group — flat, divided, no per-button border. */
const SEGMENT = 'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-sm text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── header menu (the "⋯" on each column) ─────────────────────────────────────
function ColumnMenu({ label, sortable, onSort, onHide }: {
  label: string; sortable: boolean; onSort: (dir: 'asc' | 'desc') => void; onHide: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <span ref={ref} className="relative inline-block align-middle">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`${label} column options`}
        className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink">
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-44 rounded-[10px] border border-line bg-surface p-1 text-left shadow-card">
          {sortable && (
            <>
              <button type="button" onClick={() => { setOpen(false); onSort('asc'); }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-surface-2">
                <ArrowUp size={14} /> Sort ascending
              </button>
              <button type="button" onClick={() => { setOpen(false); onSort('desc'); }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-surface-2">
                <ArrowDown size={14} /> Sort descending
              </button>
              <div className="my-1 h-px bg-line" />
            </>
          )}
          <button type="button" onClick={() => { setOpen(false); onHide(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-surface-2">
            <EyeOff size={14} /> Hide column
          </button>
        </div>
      )}
    </span>
  );
}

// ── "View" — column visibility ───────────────────────────────────────────────
function ViewMenu({ visible, onToggle, onReset }: {
  visible: Set<ColKey>; onToggle: (k: ColKey) => void; onReset: () => void;
}) {
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
      <button type="button" className={SEGMENT} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <SlidersHorizontal size={15} className="text-muted" /> View
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-[10px] border border-line bg-surface p-2 shadow-card">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Columns</div>
          {COLUMNS.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-surface-2">
              <Checkbox checked={visible.has(c.key)} onChange={() => onToggle(c.key)} /> {c.label}
            </label>
          ))}
          <button type="button" onClick={() => { onReset(); setOpen(false); }}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-accent hover:bg-surface-2">
            Show all columns
          </button>
        </div>
      )}
    </div>
  );
}

// ── modals ───────────────────────────────────────────────────────────────────
function AssignModal({ submission, agents, saving, onAssign, onClose }: {
  submission: BotSubmission; agents: Agent[]; saving: boolean;
  onAssign: (agentId: string | null) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState(submission.assignedAgentId ?? '');
  return (
    <Modal open onClose={onClose} title="Assign agent" size="sm"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={() => onAssign(sel || null)}>Save</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Who should follow up with <b className="text-ink">{submission.identity}</b>?</p>
        <Select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Agent">
          <option value="">Unassigned</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        {agents.length === 0 && <p className="text-xs text-muted">No workspace members available to assign.</p>}
      </div>
    </Modal>
  );
}

function DetailModal({ submission, agents, onClose }: { submission: BotSubmission; agents: Agent[]; onClose: () => void }) {
  const { messages, ...captured } = submission.data as { messages?: Array<{ at?: string; text?: string }> } & Record<string, unknown>;
  const fields = Object.entries(captured);
  const agent = agents.find((a) => a.id === submission.assignedAgentId);
  const meta = statusMeta(submission.status);
  return (
    <Modal open onClose={onClose} title="Bot submission" size="lg"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{initials(submission.identity)}</span>
          <div className="min-w-0">
            <div className="font-medium text-ink">{submission.identity}</div>
            <div className="text-xs text-muted">{submission.phone ?? '—'}{submission.email ? ` · ${submission.email}` : ''}</div>
          </div>
          <Badge tone={meta.tone} className="ml-auto">{meta.label}</Badge>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-[10px] border border-line p-3 text-sm sm:grid-cols-3">
          {[
            ['Bot flow', submission.botFlowName ?? '—'],
            ['Source', submission.source],
            ['Platform ID', submission.platformId ?? '—'],
            ['Captured', fmtDate(submission.occurredAt)],
            ['Assigned to', agent?.name ?? 'Unassigned'],
            ['Linked contact', submission.customerId ? 'Yes' : 'No'],
            ['Lead stage', submission.leadStage ? cap(submission.leadStage) : '—'],
            ['Lead status', submission.leadStatus ? cap(submission.leadStatus) : '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[11px] uppercase tracking-wide text-muted">{k}</dt>
              <dd className="truncate text-ink" title={String(v)}>{v}</dd>
            </div>
          ))}
        </dl>

        <div>
          <h4 className="mb-1 text-sm font-semibold text-ink">Captured fields</h4>
          {fields.length === 0 ? (
            <p className="text-sm text-muted">The flow captured no named fields for this run.</p>
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-line">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {fields.map(([k, v]) => (
                    <tr key={k} className="border-b border-line last:border-0">
                      <td className="w-40 bg-surface-2/60 px-3 py-1.5 align-top text-muted">{k}</td>
                      <td className="px-3 py-1.5 text-ink">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {Array.isArray(messages) && messages.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm font-semibold text-ink">Conversation ({messages.length})</h4>
            <ul className="max-h-56 space-y-1.5 overflow-y-auto rounded-[10px] border border-line p-3">
              {messages.map((m, i) => (
                <li key={i} className="text-sm">
                  <span className="text-ink">{m.text}</span>
                  {m.at && <span className="ml-2 text-[11px] text-muted">{fmtDate(m.at)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Google Sheets export — honest: nothing is connected, so nothing is claimed. */
function SheetsModal({ onClose, onGoToSettings }: { onClose: () => void; onGoToSettings: () => void }) {
  return (
    <Modal open onClose={onClose} title="Export to Google Sheets" size="sm"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled>Export</Button>
      </>}>
      <div className="flex flex-col items-center gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-5 text-center">
        <Sheet size={18} className="text-orange" />
        <p className="text-xs text-ink">No Google Sheets account connected. Connect one in Settings first.</p>
        <Button variant="secondary" size="sm" onClick={onGoToSettings}>Open Settings → Integrations</Button>
      </div>
      <p className="mt-3 text-xs text-muted">Export CSV works today and contains exactly the rows your current filters show.</p>
    </Modal>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export function BotDataPage() {
  const qc = useQueryClient();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canEdit = useCan('customer.edit');
  const canDelete = useCan('customer.delete');
  const canExport = useCan('customer.export');

  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  // A contact's "via <bot>" link lands here pre-filtered to that flow.
  const [botId, setBotId] = useState(sp.get('botId') ?? '');
  const [status, setStatus] = useState<'' | BotSubmissionStatus>('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'occurredAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [visible, setVisible] = useState<Set<ColKey>>(new Set(COLUMNS.map((c) => c.key)));
  const [detail, setDetail] = useState<BotSubmission | null>(null);
  const [assigning, setAssigning] = useState<BotSubmission | null>(null);
  const [toDelete, setToDelete] = useState<BotSubmission | null>(null);
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = useMemo(
    () => ({ page, pageSize, search: debounced || undefined, botId: botId || undefined, status: status || undefined, sort: sort.key, dir: sort.dir }),
    [page, pageSize, debounced, botId, status, sort],
  );

  const bots = useQuery({ queryKey: ['bot-data', orgId, 'bots'], queryFn: () => botDataService.bots(), enabled: !!orgId });
  const list = useQuery({ queryKey: ['bot-data', orgId, 'submissions', params], queryFn: () => botDataService.list(params), enabled: !!orgId });
  const { data: agents = [] } = useAgents();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['bot-data', orgId] });

  const update = useMutation({
    mutationFn: (v: { id: string; patch: { status?: BotSubmissionStatus; assignedAgentId?: string | null; leadStage?: LeadStage; leadStatus?: LeadStatus } }) =>
      botDataService.update(v.id, v.patch),
    onSuccess: () => { toast.success('Submission updated'); setAssigning(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Update failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => botDataService.remove(id),
    onSuccess: () => { toast.success('Submission deleted'); setToDelete(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Delete failed'),
  });

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const show = (k: ColKey) => visible.has(k);
  const toggleCol = (k: ColKey) => setVisible((v) => { const n = new Set(v); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const applySort = (key: SortKey, dir: 'asc' | 'desc') => { setSort({ key, dir }); setPage(1); };

  const refresh = async () => {
    await invalidate();
    toast.success('Refreshed');
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await botDataService.all({ ...params, page: undefined, pageSize: undefined });
      if (!all.length) { toast.info('Nothing to export'); return; }
      const headers = ['Identity', 'Phone', 'Email', 'Platform ID', 'Bot Flow', 'Status', 'Lead Stage', 'Lead Status', 'Source', 'Assigned Agent', 'Captured At', 'Captured Data'];
      const agentName = Object.fromEntries(agents.map((a) => [a.id, a.name]));
      const lines = all.map((s) => [
        s.identity, s.phone ?? '', s.email ?? '', s.platformId ?? '', s.botFlowName ?? '',
        statusMeta(s.status).label, s.leadStage ? cap(s.leadStage) : '', s.leadStatus ? cap(s.leadStatus) : '',
        s.source, s.assignedAgentId ? agentName[s.assignedAgentId] ?? '' : '',
        new Date(s.occurredAt).toLocaleString(), JSON.stringify(s.data ?? {}),
      ].map(csvCell).join(','));
      const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bot-submissions-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${all.length} submission${all.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const colSpan = 2 + COLUMNS.filter((c) => visible.has(c.key)).length;
  const stickyShadow = 'shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.25)]';

  return (
    <div>
      <PageHeader
        title="Bot Submissions"
        subtitle="View interactions and captured data from your chatbots."
      />

      {/* Toolbar sits on the page, above the table card — one row, as in the reference. */}
      <div className="mb-4 flex flex-nowrap items-center gap-2 overflow-x-auto">
        <div className="relative min-w-[150px] max-w-[260px] flex-1 shrink">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user or phone..."
            aria-label="Search submissions"
            className="h-9 w-full rounded-[10px] border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        <label className="shrink-0 pl-1 text-sm text-muted" htmlFor="bot-filter">Bot:</label>
        <Select id="bot-filter" className="h-9 !w-36 shrink-0 text-sm" value={botId}
          onChange={(e) => {
            const v = e.target.value;
            setBotId(v); setPage(1);
            const next = new URLSearchParams(sp);
            if (v) next.set('botId', v); else next.delete('botId');
            setSp(next, { replace: true });
          }}>
          <option value="">All Bots</option>
          {(bots.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>

        <label className="shrink-0 pl-1 text-sm text-muted" htmlFor="status-filter">Status:</label>
        <Select id="status-filter" className="h-9 !w-32 shrink-0 text-sm" value={status}
          onChange={(e) => { setStatus(e.target.value as '' | BotSubmissionStatus); setPage(1); }}>
          <option value="">Any</option>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>

        <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />

        {/* One segmented group, hairline dividers — not four separate buttons. */}
        <div className="inline-flex shrink-0 divide-x divide-line overflow-visible rounded-[10px] border border-line bg-surface">
          <ViewMenu visible={visible} onToggle={toggleCol} onReset={() => setVisible(new Set(COLUMNS.map((c) => c.key)))} />
          <button type="button" className={SEGMENT} onClick={refresh} disabled={list.isFetching}>
            <RefreshCw size={15} className={`text-muted ${list.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button type="button" className={SEGMENT} onClick={exportCsv} disabled={!canExport || total === 0 || exporting}>
            <Download size={15} className="text-muted" /> {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
          <button type="button" className={SEGMENT} disabled={!botId}
            title={botId ? 'Show the contacts this bot captured' : 'Choose a bot first'}
            onClick={() => navigate(`/app/crm/customers?botFlowId=${botId}`)}>
            <Users size={15} className="text-muted" /> Contacts
          </button>
          <button type="button" className={`${SEGMENT} text-green-2`} onClick={() => setSheetsOpen(true)}>
            <Sheet size={15} className="text-green" /> Export Sheets
          </button>
        </div>
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? <LoadingState label="Loading bot submissions…" />
          : list.isError ? <ErrorState message={(list.error as Error)?.message ?? 'Could not load bot submissions.'} onRetry={() => list.refetch()} />
          : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2/50 text-left text-xs">
                    <th className="w-[240px] border-r border-line px-4 py-3">
                      <button type="button" className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-ink"
                        onClick={() => applySort('identity', sort.key === 'identity' && sort.dir === 'asc' ? 'desc' : 'asc')}>
                        Identity
                      </button>
                    </th>
                    {COLUMNS.filter((c) => show(c.key)).map((c) => (
                      <th key={c.key} className="whitespace-nowrap px-3 py-3 font-medium text-ink/75">
                        <span className="inline-flex items-center gap-1.5">
                          {c.chip
                            ? <span className="rounded-md border border-green-3 bg-green-3 px-1.5 py-0.5 text-[11px] font-medium text-green-2">{c.label}</span>
                            : c.label}
                          <ColumnMenu label={c.label} sortable={!!c.sort}
                            onSort={(dir) => c.sort && applySort(c.sort, dir)}
                            onHide={() => toggleCol(c.key)} />
                        </span>
                      </th>
                    ))}
                    <th className={`sticky right-0 whitespace-nowrap border-l border-line bg-[#f6f8f7] px-4 py-3 text-right font-semibold uppercase tracking-wide text-ink ${stickyShadow}`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={colSpan} className="px-4 py-28 text-center">
                        <p className="text-sm text-muted">No submission data found.</p>
                        {(bots.data?.length ?? 0) === 0 && (
                          <p className="mx-auto mt-2 flex max-w-md items-start justify-center gap-1.5 text-xs text-muted">
                            <Info size={13} className="mt-0.5 shrink-0" />
                            <span>Rows appear here once a bot flow captures a WhatsApp conversation. Connect a bot through the API, or define a flow keyword — inbound messages that match are recorded automatically.</span>
                          </p>
                        )}
                      </td>
                    </tr>
                  ) : rows.map((s) => {
                    const meta = statusMeta(s.status);
                    const agent = agents.find((a) => a.id === s.assignedAgentId);
                    return (
                      <tr key={s.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                        <td className="border-r border-line px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{initials(s.identity)}</span>
                            <div className="min-w-0">
                              <button type="button" className="block truncate font-medium text-ink hover:underline" onClick={() => setDetail(s)}>{s.identity}</button>
                              {s.customerId ? (
                                <button type="button"
                                  onClick={() => navigate(`/app/crm/customers?botFlowId=${s.botFlowId ?? ''}&q=${encodeURIComponent(s.phone ?? s.email ?? s.identity)}`)}
                                  title="Open this contact in All Customers"
                                  className="flex items-center gap-1 truncate text-xs text-muted hover:text-accent hover:underline">
                                  {s.phone ?? 'View contact'} <ExternalLink size={10} className="shrink-0" />
                                </button>
                              ) : (
                                <span className="block truncate text-xs text-muted">{s.phone ?? '—'}</span>
                              )}
                            </div>
                          </div>
                        </td>
                        {show('leadStage') && (
                          <td className="px-3 py-3">
                            {s.leadStage ? (
                              <Select className="h-8 !w-32 text-xs" value={s.leadStage} disabled={!canEdit || update.isPending}
                                onChange={(e) => update.mutate({ id: s.id, patch: { leadStage: e.target.value as LeadStage } })}
                                aria-label={`Lead stage for ${s.identity}`}>
                                {LEAD_STAGES.map((x) => <option key={x} value={x}>{cap(x)}</option>)}
                              </Select>
                            ) : <span className="text-xs italic text-muted" title="Not linked to a CRM contact">Not linked</span>}
                          </td>
                        )}
                        {show('leadStatus') && (
                          <td className="px-3 py-3">
                            {s.leadStatus ? (
                              <Select className="h-8 !w-32 text-xs" value={s.leadStatus} disabled={!canEdit || update.isPending}
                                onChange={(e) => update.mutate({ id: s.id, patch: { leadStatus: e.target.value as LeadStatus } })}
                                aria-label={`Lead status for ${s.identity}`}>
                                {LEAD_STATUSES.map((x) => <option key={x} value={x}>{cap(x)}</option>)}
                              </Select>
                            ) : <span className="text-xs italic text-muted">Not linked</span>}
                          </td>
                        )}
                        {show('email') && <td className="px-3 py-3 text-ink">{s.email || <span className="italic text-muted">Empty</span>}</td>}
                        {show('platformId') && <td className="px-3 py-3 font-mono text-xs text-muted">{s.platformId || <span className="font-sans italic">Empty</span>}</td>}
                        {show('botFlow') && <td className="px-3 py-3 text-ink">{s.botFlowName ? <span className="inline-flex items-center gap-1"><Bot size={13} className="text-muted" />{s.botFlowName}</span> : <span className="italic text-muted">Empty</span>}</td>}
                        {show('status') && (
                          <td className="px-3 py-3">
                            <span className="inline-flex items-center gap-2">
                            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[meta.tone]}`} aria-hidden />
                            <Select className="h-8 !w-36 text-xs" value={s.status} disabled={!canEdit || update.isPending}
                              onChange={(e) => update.mutate({ id: s.id, patch: { status: e.target.value as BotSubmissionStatus } })}
                              aria-label={`Status for ${s.identity}`}>
                              {STATUSES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                            </Select>
                            </span>
                          </td>
                        )}
                        {show('timestamp') && <td className="whitespace-nowrap px-3 py-3 text-muted">{fmtDate(s.occurredAt)}</td>}
                        {show('assign') && (
                          <td className="px-3 py-3">
                            <Button variant="secondary" size="sm" disabled={!canEdit} onClick={() => setAssigning(s)}>
                              <UserPlus size={14} /> {agent?.name ?? 'Assign'}
                            </Button>
                          </td>
                        )}
                        <td className={`sticky right-0 border-l border-line bg-surface px-4 py-3 text-right ${stickyShadow}`}>
                          <div className="inline-flex items-center gap-1">
                            <button type="button" onClick={() => setDetail(s)} title="View" aria-label={`View ${s.identity}`}
                              className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"><Eye size={15} /></button>
                            <button type="button" disabled={!canDelete} onClick={() => setToDelete(s)} title="Delete" aria-label={`Delete ${s.identity}`}
                              className="rounded-lg p-1.5 text-muted hover:bg-red/10 hover:text-red disabled:opacity-40"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer */}
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

      {detail && <DetailModal submission={detail} agents={agents} onClose={() => setDetail(null)} />}
      {assigning && (
        <AssignModal submission={assigning} agents={agents} saving={update.isPending}
          onAssign={(agentId) => update.mutate({ id: assigning.id, patch: { assignedAgentId: agentId } })}
          onClose={() => setAssigning(null)} />
      )}
      {sheetsOpen && <SheetsModal onClose={() => setSheetsOpen(false)} onGoToSettings={() => { setSheetsOpen(false); window.location.assign(`${import.meta.env.BASE_URL}app/settings?tab=integrations`); }} />}
      <ConfirmDialog open={!!toDelete} title="Delete submission" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete the bot submission from ${toDelete?.identity}? This cannot be undone.`}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)} onClose={() => setToDelete(null)} />
    </div>
  );
}
