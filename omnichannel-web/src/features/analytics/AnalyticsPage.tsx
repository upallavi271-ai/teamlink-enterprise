import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, CheckCircle2, MessageSquare, CheckCheck, XCircle,
  CalendarDays, ArrowRight, MessageCircle, Smartphone, Mail, Mic,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { DonutChart, type DonutSlice } from '@/components/charts/DonutChart';
import { BarChart, type BarDatum } from '@/components/charts/BarChart';
import { LoadingState, ErrorState, EmptyState } from '@/components/feedback/states';
import { SocialAnalytics } from './SocialAnalytics';
import { DateRangeModal, DATE_PRESETS as PRESETS, isoDay as iso, prettyDay as pretty } from '@/features/_shared/DateRangeModal';
import { analyticsService } from '@/services/analytics/analytics.service';
import { campaignsService } from '@/services/campaigns/campaigns.service';
import { useOrgStore } from '@/stores/orgStore';
import { formatNumber } from '@/lib/format';
import { cap } from '@/features/crm/crmLabels';
import type { Campaign, CommunicationAnalytics } from '@/types';

type Icon = LucideIcon;

/** Ring order keeps green and red apart for colour-blind readers (ΔE 9.7 worst adjacent). */
const STATUS_COLORS = { delivered: 'var(--green)', read: 'var(--blue)', failed: 'var(--red)', sent: 'var(--orange)' };
const CHANNELS = ['sms', 'rcs', 'whatsapp', 'email', 'voice'];
const CHANNEL_ICON: Record<string, Icon> = {
  whatsapp: MessageCircle, sms: Smartphone, rcs: MessageSquare, email: Mail, voice: Mic,
};


export function AnalyticsPage() {
  const navigate = useNavigate();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const [tab, setTab] = useState('communication');

  const [preset, setPreset] = useState('30');
  const [customFrom, setCustomFrom] = useState(iso(new Date(Date.now() - 30 * 864e5)));
  const [customTo, setCustomTo] = useState(iso(new Date()));
  const [pickerOpen, setPickerOpen] = useState(false);

  const range = useMemo(() => {
    if (preset === 'custom') return { from: `${customFrom}T00:00:00.000Z`, to: `${customTo}T23:59:59.999Z` };
    const days = Number(preset);
    return { from: new Date(Date.now() - days * 864e5).toISOString(), to: new Date().toISOString() };
  }, [preset, customFrom, customTo]);

  const rangeLabel = preset === 'custom'
    ? `${pretty(range.from)} – ${pretty(range.to)}`
    : `${PRESETS.find((p) => p.key === preset)?.label}: ${pretty(range.from)} – ${pretty(range.to)}`;

  return (
    <div className="space-y-4">
      <PageHeader title="Analytics &amp; Reports" subtitle="Track performance across all your marketing channels."
        actions={<>
          <RefreshButton keys={['analytics-comm', 'analytics-campaigns', 'social-accounts', 'social-posts-analytics']} />
          <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
            <CalendarDays size={15} /> {rangeLabel}
          </Button>
        </>} />

      <Tabs
        tabs={[
          { key: 'communication', label: 'Communication Analytics' },
          { key: 'social', label: 'Social Media Analytics' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'communication'
        ? <CommunicationAnalytics orgId={orgId} range={range} onOpenCampaigns={() => navigate('/app/campaigns')} />
        : <SocialAnalytics from={range.from} to={range.to} />}

      {pickerOpen && (
        <DateRangeModal
          preset={preset} from={customFrom} to={customTo}
          onApply={(p, f, t) => { setPreset(p); setCustomFrom(f); setCustomTo(t); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ── Communication tab ────────────────────────────────────────────────────────
function CommunicationAnalytics({ orgId, range, onOpenCampaigns }: {
  orgId: string; range: { from: string; to: string }; onOpenCampaigns: () => void;
}) {
  const statsQ = useQuery({
    queryKey: ['analytics-comm', orgId, range],
    queryFn: () => analyticsService.communication(orgId, range),
    enabled: !!orgId,
    refetchOnMount: 'always',
  });
  const campaignsQ = useQuery({
    queryKey: ['analytics-campaigns', orgId],
    queryFn: () => campaignsService.list(orgId, { page: 1, pageSize: 5, sort: 'createdAt', dir: 'desc' }),
    enabled: !!orgId,
    refetchOnMount: 'always',
  });

  const stats: CommunicationAnalytics | undefined = statsQ.data;
  const campaigns: Campaign[] = campaignsQ.data?.items ?? [];

  if (statsQ.isLoading) return <LoadingState label="Loading analytics…" />;
  if (statsQ.isError) return <ErrorState message="Could not load analytics." onRetry={() => statsQ.refetch()} />;
  if (!stats) return <EmptyState title="No data yet" detail="Send a campaign to see performance here." />;

  const slices: DonutSlice[] = [
    { key: 'delivered', label: 'Delivered', value: stats.totals.delivered, color: STATUS_COLORS.delivered },
    { key: 'read', label: 'Read', value: stats.totals.read, color: STATUS_COLORS.read },
    { key: 'failed', label: 'Failed', value: stats.totals.failed, color: STATUS_COLORS.failed },
    { key: 'sent', label: 'Sent', value: stats.totals.sent, color: STATUS_COLORS.sent },
  ];
  const bars: BarDatum[] = CHANNELS.map((ch) => ({
    key: ch,
    label: ch === 'whatsapp' ? 'WhatsApp' : ch.toUpperCase(),
    value: stats.byChannel.find((c) => c.channel === ch)?.total ?? 0,
  }));
  const maxFailure = Math.max(...stats.failureReasons.map((f) => f.count), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Total Messages" value={stats.totals.total} icon={TrendingUp} tone="orange" />
        <Kpi label="Success Sent" value={stats.totals.sent} icon={CheckCircle2} tone="green" />
        <Kpi label="Delivered" value={stats.totals.delivered} icon={MessageSquare} tone="orange" />
        <Kpi label="Read" value={stats.totals.read} icon={CheckCheck} tone="green" />
        <Kpi label="Failed" value={stats.totals.failed} icon={XCircle} tone="red" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Live Status"><DonutChart slices={slices} /></Panel>
        <Panel title="Channel Breakdown"><BarChart data={bars} /></Panel>
        <Panel title="Top Failure Reasons">
          {stats.failureReasons.length === 0 ? (
            <div className="flex h-[190px] flex-col items-center justify-center gap-2 text-center">
              <CheckCircle2 size={22} className="text-green-2" />
              <p className="text-sm text-muted">No delivery failures in this period.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {stats.failureReasons.slice(0, 5).map((f) => (
                <li key={f.reason}>
                  <div className="mb-1 flex items-start justify-between gap-3">
                    <span className="line-clamp-2 text-xs text-ink" title={f.reason}>{f.reason}</span>
                    <span className="shrink-0 text-xs font-medium text-ink">{formatNumber(f.count)}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-red" style={{ width: `${Math.max((f.count / maxFailure) * 100, 2)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-4">
          <h3 className="font-display font-semibold text-ink">Recent Communication Activity</h3>
          <button onClick={onOpenCampaigns} className="text-xs text-accent hover:underline">
            View All Campaigns <ArrowRight size={11} className="inline" />
          </button>
        </div>
        {campaignsQ.isLoading ? <div className="p-5"><LoadingState /></div>
          : campaigns.length === 0 ? <div className="p-5"><EmptyState title="No campaigns yet" /></div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="bg-surface-2 text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3 text-left">Campaign</th>
                    <th className="px-4 py-3 text-left">Channel</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const CIcon = CHANNEL_ICON[c.channel] ?? MessageSquare;
                    return (
                      <tr key={c.id} className="border-t border-line hover:bg-surface-2">
                        <td className="px-4 py-3 font-medium text-ink">{c.name}</td>
                        <td className="px-4 py-3"><Badge tone="green" className="uppercase"><CIcon size={12} /> {c.channel}</Badge></td>
                        <td className="px-4 py-3"><Badge>{cap(c.status)}</Badge></td>
                        <td className="px-4 py-3 text-muted">{new Date(c.createdAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={onOpenCampaigns} className="text-xs text-accent hover:underline">
                            View Details <ArrowRight size={11} className="inline" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
const TONES: Record<string, string> = {
  orange: 'bg-orange/10 text-orange',
  green: 'bg-green-3 text-green-2',
  red: 'bg-red/10 text-red',
};

function Kpi({ label, value, icon: Icon, tone }: { label: string; value: number; icon: Icon; tone: keyof typeof TONES }) {
  return (
    <Card>
      <CardBody className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] uppercase tracking-wide text-muted">{label}</div>
          <div className="font-display text-2xl font-semibold text-ink">{formatNumber(value)}</div>
        </div>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${TONES[tone]}`}><Icon size={17} /></span>
      </CardBody>
    </Card>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="h-full">
      <CardBody className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {children}
      </CardBody>
    </Card>
  );
}
