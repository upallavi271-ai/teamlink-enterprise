import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, ArrowRight, MessageCircle, Smartphone, Mail, MessageSquare, Mic, CheckCircle2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { CampaignDetailModal } from './CampaignDetailModal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { campaignsService } from '@/services/campaigns/campaigns.service';
import { templatesService } from '@/services/templates/templates.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { formatNumber } from '@/lib/format';
import { cap } from '@/features/crm/crmLabels';
import type { Campaign, CampaignStatus, Channel } from '@/types';

type Icon = LucideIcon;

/** The reference lists campaigns per channel as tabs, not as a dropdown filter. */
const CHANNEL_TABS: { key: Channel; label: string; icon: Icon }[] = [
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { key: 'rcs', label: 'RCS', icon: MessageSquare },
  { key: 'sms', label: 'SMS', icon: Smartphone },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'voice', label: 'Voice', icon: Mic },
];

const statusTone: Record<CampaignStatus, 'neutral' | 'blue' | 'green' | 'orange' | 'red'> = {
  draft: 'neutral', scheduled: 'blue', queued: 'blue', running: 'blue', completed: 'green', failed: 'red', cancelled: 'red', paused: 'orange',
};

export function CampaignsPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const lp = useListParams({ sort: 'createdAt', filters: { channel: 'whatsapp' } });
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['campaigns', orgId, lp.params],
    queryFn: () => campaignsService.list(orgId, lp.params),
    enabled: !!orgId,
    // Opening the page always shows live numbers rather than a stale cache.
    refetchOnMount: 'always',
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['campaigns', orgId] });
  const delM = useMutation({ mutationFn: (id: string) => campaignsService.remove(orgId, id), onSuccess: invalidate });

  const canDelete = useCan('campaign.delete');
  // Campaigns store a templateId; the list shows the template's NAME, so resolve
  // the ids once per page rather than per row.
  const templatesQ = useQuery({
    queryKey: ['campaign-templates', orgId],
    queryFn: () => templatesService.list(orgId, { page: 1, pageSize: 100 }),
    enabled: !!orgId,
    refetchOnMount: 'always',
  });
  const template = (id?: string) => (id ? templatesQ.data?.items.find((t) => t.id === id) ?? null : null);
  const wsName = useOrgStore((st) => st.workspaces.find((w) => w.id === st.currentWorkspaceId)?.name) ?? 'this workspace';
  const [detail, setDetail] = useState<Campaign | null>(null);

  const [toDelete, setToDelete] = useState<Campaign | null>(null);


  const rows = data?.items ?? [];
  const activeChannel = (lp.filters.channel as Channel) || 'whatsapp';

  return (
    <div>
      <PageHeader title="All Campaigns" subtitle={`History for ${wsName}.`}
        actions={<SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search campaign…" />} />

      <Card>
        {/* Channel tabs + refresh — one row, as in the reference */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-3">
          <div className="flex flex-wrap gap-1.5">
            {CHANNEL_TABS.map((t) => {
              const on = activeChannel === t.key;
              return (
                <button key={t.key} type="button" onClick={() => { lp.setFilter('channel', t.key); lp.setPage(1); }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    on ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-muted hover:bg-surface-2'
                  }`}>
                  <t.icon size={14} /> {t.label}
                </button>
              );
            })}
          </div>
          <RefreshButton keys={['campaigns', 'campaign-templates']} />
        </div>

        {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
          : rows.length === 0 ? (
            <EmptyState title={`No ${cap(activeChannel)} campaigns`}
              detail="Launch one from the Communication console and it will appear here." />
          ) : (
          <div className="overflow-x-auto">
            <table className={`w-full min-w-[980px] border-collapse text-sm ${isFetching ? 'opacity-60' : ''}`}>
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Campaign Name</th>
                <th className="px-4 py-3">Account Name</th>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Sent / Failed</th>
                <th className="px-4 py-3">Created At</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr></thead>
              <tbody>
                {rows.map((c) => {
                  const tpl = template(c.templateId);
                  return (
                    <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-3 font-medium text-ink">{c.name}</td>
                      <td className="px-4 py-3 text-muted">
                        {/* The API does not record which connected account sent a
                            campaign, so this is left blank rather than guessed. */}
                        <span title="Not recorded by the API yet">—</span>
                      </td>
                      <td className="px-4 py-3">
                        {tpl ? (
                          <div className="leading-tight">
                            <div className="font-mono text-xs text-ink">{tpl.name}</div>
                            <div className="text-[11px] text-muted">{tpl.category}</div>
                          </div>
                        ) : <span className="text-xs text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3"><Badge tone={statusTone[c.status]}>{cap(c.status)}</Badge></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex items-center gap-1 text-green-2" title="Sent">
                            <CheckCircle2 size={13} /> {formatNumber(c.sent)}
                          </span>
                          <span className="text-line">|</span>
                          <span className={`inline-flex items-center gap-1 ${c.failed > 0 ? 'text-red' : 'text-muted'}`} title="Failed">
                            <XCircle size={13} /> {formatNumber(c.failed)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {new Date(c.createdAt).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button type="button" onClick={() => setDetail(c)} className="whitespace-nowrap text-xs text-accent hover:underline">
                            View Details <ArrowRight size={11} className="inline" />
                          </button>
                          {canDelete && (
                            <button type="button" onClick={() => setToDelete(c)} aria-label={`Delete ${c.name}`} title="Delete campaign"
                              className="rounded-lg p-1 text-muted hover:bg-red/10 hover:text-red">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Footer: rows-per-page on the left, range + arrows on the right */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-xs text-muted">
              <label className="flex items-center gap-2">
                Rows per page:
                <Select className="h-8 !w-20" value={String(lp.pageSize)}
                  onChange={(e) => lp.setPageSize(Number(e.target.value))}>
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </label>
              <div className="flex items-center gap-3">
                <span>
                  Showing {(lp.page - 1) * lp.pageSize + 1} - {Math.min(lp.page * lp.pageSize, data?.total ?? 0)} of {data?.total ?? 0}
                </span>
                <div className="flex gap-1">
                  <button type="button" disabled={lp.page <= 1} onClick={() => lp.setPage(lp.page - 1)} aria-label="Previous page"
                    className="rounded-lg border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-40">‹</button>
                  <button type="button" disabled={lp.page * lp.pageSize >= (data?.total ?? 0)} onClick={() => lp.setPage(lp.page + 1)} aria-label="Next page"
                    className="rounded-lg border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-40">›</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {detail && (
        <CampaignDetailModal campaign={detail} template={template(detail.templateId)} onClose={() => setDetail(null)} />
      )}

      <ConfirmDialog open={!!toDelete} title="Delete campaign" danger confirmLabel="Delete" loading={delM.isPending}
        message={`Delete "${toDelete?.name}"?`} onConfirm={() => toDelete && delM.mutateAsync(toDelete.id).then(() => { toast.success('Campaign deleted'); setToDelete(null); }).catch(() => toast.error('Delete failed'))} onClose={() => setToDelete(null)} />
    </div>
  );
}
