import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, CheckCircle2, CheckCheck, XCircle, MessageSquare, MessageCircle,
  RefreshCw, FileDown, Eye, ArrowLeft, X, Download,
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Card, CardBody } from '@/components/ui/Card';
import { DonutChart, type DonutSlice } from '@/components/charts/DonutChart';
import { LoadingState, ErrorState, EmptyState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { communicationService } from '@/services/communication/communication.service';
import { formatNumber } from '@/lib/format';
import { cap } from '@/features/crm/crmLabels';
import type { Campaign, CampaignRecipient, RecipientStatus, Template } from '@/types';

/** Ring order keeps green and red apart — they are the pair CVD readers cannot separate. */
const RING: { key: string; label: string; color: string }[] = [
  { key: 'delivered', label: 'Delivered', color: 'var(--green)' },
  { key: 'read', label: 'Read/Answered', color: 'var(--blue)' },
  { key: 'failed', label: 'Failed/Busy', color: 'var(--red)' },
  { key: 'sent', label: 'Sent/Ringing', color: 'var(--orange)' },
];

const STATUS_OPTIONS: RecipientStatus[] = ['pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'];

const statusTone = (s: string): 'green' | 'blue' | 'orange' | 'red' | 'neutral' =>
  s === 'read' ? 'green' : s === 'delivered' ? 'blue' : s === 'sent' ? 'orange' : s === 'failed' ? 'red' : 'neutral';

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Campaign analytics. Opens with a fresh fetch every time (`refetchOnMount:
 * 'always'`) so the numbers are never a stale cache from a previous open.
 */
export function CampaignDetailModal({ campaign, template, onClose }: {
  campaign: Campaign;
  template: Template | null;
  onClose: () => void;
}) {
  const [showLogs, setShowLogs] = useState(false);

  const campaignQ = useQuery({
    queryKey: ['campaign-detail', campaign.id],
    queryFn: () => communicationService.getCampaign('', campaign.id),
    initialData: campaign,
    refetchOnMount: 'always',
  });
  const c = campaignQ.data ?? campaign;

  // Failure reasons are derived from the failed recipients themselves — the
  // campaign record only carries a count, not the reasons behind it.
  const failuresQ = useQuery({
    queryKey: ['campaign-failures', campaign.id],
    queryFn: () => communicationService.getRecipients('', campaign.id, {
      page: 1, pageSize: 200, filters: { status: 'failed' },
    }),
    refetchOnMount: 'always',
    enabled: c.failed > 0,
  });

  const reasons = useMemo(() => {
    const rows = (failuresQ.data?.items ?? []).filter((r) => r.status === 'failed');
    const byReason = new Map<string, number>();
    for (const r of rows) {
      const key = (r.error || 'Unspecified error').trim();
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    return [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  }, [failuresQ.data]);

  const slices: DonutSlice[] = RING.map((r) => ({
    key: r.key,
    label: r.label,
    color: r.color,
    value: r.key === 'delivered' ? c.delivered : r.key === 'read' ? c.read : r.key === 'failed' ? c.failed : c.sent,
  }));

  const refreshing = campaignQ.isFetching || failuresQ.isFetching;
  const refreshAll = () => {
    campaignQ.refetch();
    if (c.failed > 0) failuresQ.refetch();
    toast.success('Campaign refreshed');
  };

  const exportCsv = async () => {
    try {
      const all = await communicationService.getRecipients('', campaign.id, { page: 1, pageSize: 1000 });
      const header = ['Recipient', 'Status', 'Sent/Started At', 'Error'];
      const body = all.items.map((r) => [r.phone ?? r.email ?? '', r.status, new Date(r.createdAt).toLocaleString(), r.error ?? '']);
      const csv = [header, ...body].map((row) => row.map(csvCell).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${c.name}-recipients.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${all.items.length} rows`);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Export failed');
    }
  };

  const maxReason = Math.max(...reasons.map((r) => r.count), 1);

  return (
    <>
      <Modal open onClose={onClose} size="xl" title={c.name}>
        <div className="space-y-4">
          {/* Header row — meta on the left, actions on the right */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                <ArrowLeft size={13} /> Back to Campaigns
              </button>
              <span className="text-line">·</span>
              <span className="text-muted">{cap(c.channel)}</span>
              <span className="text-line">·</span>
              <span className="text-muted">{new Date(c.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
              <Badge tone={c.status === 'completed' ? 'green' : c.status === 'failed' ? 'red' : 'neutral'}>{cap(c.status)}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={refreshAll} disabled={refreshing} aria-label="Refresh" title="Refresh"
                className="grid h-9 w-9 place-items-center rounded-[10px] border border-line bg-surface text-muted hover:bg-surface-2 disabled:opacity-50">
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : undefined} />
              </button>
              <Button variant="secondary" size="sm" onClick={exportCsv}><FileDown size={15} /> Export CSV</Button>
              <Button size="sm" onClick={() => setShowLogs(true)}><Eye size={15} /> View Detailed Logs</Button>
            </div>
          </div>

          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Total Messages" value={c.recipients} icon={TrendingUp} tone="orange" />
            <Kpi label="Successfully Sent" value={c.sent} icon={TrendingUp} tone="orange" />
            <Kpi label="Delivered" value={c.delivered} icon={CheckCircle2} tone="orange" />
            <Kpi label="Read / Answered" value={c.read} icon={CheckCheck} tone="green" />
            <Kpi label="Failed" value={c.failed} icon={XCircle} tone="red" />
            {/* Inbound replies are not attributed to a campaign by the API yet. */}
            <Kpi label="Responses" value={null} icon={MessageSquare} tone="blue" note="Not tracked per campaign yet" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardBody className="space-y-3">
                  <h3 className="text-sm font-semibold text-ink">Delivery Status Distribution</h3>
                  {campaignQ.isLoading ? <LoadingState /> : <DonutChart slices={slices} size={210} />}
                </CardBody>
              </Card>

              <Card>
                <CardBody className="space-y-3">
                  <h3 className="text-sm font-semibold text-ink">Failure Reasons Analysis</h3>
                  {c.failed === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-8 text-center">
                      <CheckCircle2 size={20} className="text-green-2" />
                      <p className="text-sm text-muted">No delivery failures recorded.</p>
                    </div>
                  ) : failuresQ.isLoading ? <LoadingState />
                    : failuresQ.isError ? <ErrorState message="Could not load failure reasons." onRetry={() => failuresQ.refetch()} />
                    : reasons.length === 0 ? <EmptyState title="No reasons returned" detail="The provider did not record a reason for these failures." />
                    : (
                      <ul className="space-y-3">
                        {reasons.slice(0, 6).map((r) => (
                          <li key={r.reason}>
                            <div className="mb-1 flex items-start justify-between gap-3">
                              <span className="line-clamp-2 text-xs text-ink" title={r.reason}>{r.reason}</span>
                              <span className="shrink-0 text-xs font-medium text-ink">{formatNumber(r.count)}</span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                              <div className="h-full rounded-full bg-red" style={{ width: `${Math.max((r.count / maxReason) * 100, 2)}%` }} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  {failuresQ.data && failuresQ.data.total > (failuresQ.data.items?.length ?? 0) && (
                    <p className="text-xs text-muted">
                      Based on the first {failuresQ.data.items.length} of {formatNumber(failuresQ.data.total)} failed messages.
                    </p>
                  )}
                </CardBody>
              </Card>
            </div>

            {/* Template + preview */}
            <Card>
              <CardBody className="space-y-3">
                {template ? (
                  <>
                    <div className="text-center">
                      <div className="text-xs text-muted">Template Name: <span className="font-mono text-ink">{template.name}</span></div>
                      <div className="mt-1 flex justify-center gap-1.5">
                        <Badge>{(template.category || 'Utility').toUpperCase()}</Badge>
                        <Badge>{(template.language || 'en').toUpperCase().replace('_', ' ')}</Badge>
                      </div>
                    </div>
                    <PhonePreview template={template} />
                  </>
                ) : (
                  <EmptyState title="No template" detail="This campaign was not linked to a template." />
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      </Modal>

      {showLogs && <LiveMessageLogsModal campaign={c} onClose={() => setShowLogs(false)} />}
    </>
  );
}

// ── Live message logs ────────────────────────────────────────────────────────
/** Per-recipient delivery log. Refetches on every open, and has its own refresh. */
function LiveMessageLogsModal({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => { setPage(1); }, [search, status, pageSize]);

  const q = useQuery({
    queryKey: ['campaign-logs', campaign.id, { search, status, page, pageSize }],
    queryFn: () => communicationService.getRecipients('', campaign.id, {
      page, pageSize, search: search || undefined, filters: status ? { status } : {},
    }),
    refetchOnMount: 'always',
  });

  const rows: CampaignRecipient[] = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const downloadCsv = async () => {
    try {
      const all = await communicationService.getRecipients('', campaign.id, { page: 1, pageSize: 1000, filters: status ? { status } : {} });
      const header = ['Recipient', 'Status', 'Sent/Started At', 'Error'];
      const body = all.items.map((r) => [r.phone ?? r.email ?? '', r.status, new Date(r.createdAt).toLocaleString(), r.error ?? '']);
      const csv = [header, ...body].map((row) => row.map(csvCell).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${campaign.name}-message-logs.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Downloaded ${all.items.length} rows`);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Download failed');
    }
  };

  return (
    <Modal open onClose={onClose} size="xl" title="Live Message Logs">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">Total Records: {formatNumber(total)}</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={downloadCsv} disabled={total === 0}>
              <Download size={15} /> Download CSV
            </Button>
            <button type="button" onClick={onClose} aria-label="Close logs" title="Close"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2"><X size={16} /></button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[220px] flex-1"><SearchInput value={search} onChange={setSearch} placeholder="Search phone…" /></div>
          <Select className="h-10 !w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
          </Select>
          <button type="button" onClick={() => { q.refetch(); toast.success('Logs refreshed'); }} disabled={q.isFetching}
            aria-label="Refresh logs" title="Refresh"
            className="grid h-10 w-10 place-items-center rounded-[10px] border border-line bg-surface text-muted hover:bg-surface-2 disabled:opacity-50">
            <RefreshCw size={15} className={q.isFetching ? 'animate-spin' : undefined} />
          </button>
        </div>

        {q.isLoading ? <LoadingState />
          : q.isError ? <ErrorState message="Could not load the message logs." onRetry={() => q.refetch()} />
          : rows.length === 0 ? <EmptyState title="No messages" detail="Nothing matches this filter." />
          : (
            <div className="max-h-[52vh] overflow-auto rounded-[10px] border border-line">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Recipient</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Sent/Started At</th>
                    <th className="px-3 py-2 text-left">Delivered At</th>
                    <th className="px-3 py-2 text-left">Read At</th>
                    <th className="px-3 py-2 text-left">Error Code</th>
                    <th className="px-3 py-2 text-left">Error Description</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-line hover:bg-surface-2">
                      <td className="px-3 py-2 font-mono text-xs text-ink">{r.phone ?? r.email ?? '—'}</td>
                      <td className="px-3 py-2"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                      <td className="px-3 py-2 text-muted">{new Date(r.createdAt).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      {/* Per-event timestamps are not exposed by the API yet. */}
                      <td className="px-3 py-2 text-muted" title="Not returned by the API yet">—</td>
                      <td className="px-3 py-2 text-muted" title="Not returned by the API yet">—</td>
                      <td className="px-3 py-2 text-muted" title="Not returned by the API yet">—</td>
                      <td className="px-3 py-2">
                        {r.error ? <span className="text-xs text-red" title={r.error}>{r.error}</span> : <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <label className="flex items-center gap-2">
            Rows per page:
            <Select className="h-8 !w-20" value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </label>
          <div className="flex items-center gap-3">
            <span>Showing {total === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} of {formatNumber(total)}</span>
            <div className="flex gap-1">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"
                className="rounded-lg border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-40">‹</button>
              <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"
                className="rounded-lg border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-40">›</button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
const TONES: Record<string, string> = {
  orange: 'bg-orange/10 text-orange',
  green: 'bg-green-3 text-green-2',
  red: 'bg-red/10 text-red',
  blue: 'bg-blue/10 text-blue',
};

function Kpi({ label, value, icon: Icon, tone, note }: {
  label: string; value: number | null; icon: typeof TrendingUp; tone: keyof typeof TONES; note?: string;
}) {
  return (
    <div className="rounded-[10px] border border-line p-3" title={note}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] text-muted">{label}</div>
          <div className="font-display text-xl font-semibold text-ink">
            {value === null ? <span className="text-muted">—</span> : formatNumber(value)}
          </div>
        </div>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${TONES[tone]}`}><Icon size={14} /></span>
      </div>
    </div>
  );
}

/** WhatsApp-style preview of the template this campaign sent. */
function PhonePreview({ template }: { template: Template }) {
  const body = (template.body ?? '').split('\n');
  return (
    <div className="mx-auto w-full max-w-[260px] overflow-hidden rounded-[22px] border-4 border-ink/80 bg-[#e5ddd5]">
      <div className="flex items-center gap-2 bg-green-2 px-3 py-2 text-white">
        <MessageCircle size={16} />
        <div className="leading-tight">
          <div className="text-xs font-medium">WhatsApp Business</div>
          <div className="text-[10px] opacity-80">Business Account</div>
        </div>
      </div>
      <div className="max-h-[320px] space-y-2 overflow-y-auto p-2.5">
        <div className="rounded-lg bg-[#fff8e1] px-2 py-1.5 text-[10px] text-ink/70">
          Messages and calls are end-to-end encrypted. Only people in this chat can read or listen to them.
        </div>
        <div className="rounded-lg bg-white p-2.5 shadow-sm">
          {template.headerText && <div className="mb-1 text-xs font-semibold text-ink">{template.headerText}</div>}
          {body.map((line, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-[11px] leading-snug text-ink">{line || ' '}</p>
          ))}
          {template.footer && <p className="mt-1 text-[10px] text-muted">{template.footer}</p>}
        </div>
        {(template.buttons ?? []).map((b, i) => (
          <div key={i} className="rounded-lg bg-white py-1.5 text-center text-[11px] font-medium text-blue shadow-sm">{b.text}</div>
        ))}
      </div>
    </div>
  );
}
