import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, CheckCircle2, MessageSquare, CheckCheck, XCircle,
  RefreshCw, Building2, Plus, ArrowRight, AlertTriangle,
  Smartphone, Mail, Mic, MessageCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { DonutChart, type DonutSlice } from '@/components/charts/DonutChart';
import { BarChart, type BarDatum } from '@/components/charts/BarChart';
import { LoadingState, ErrorState, EmptyState } from '@/components/feedback/states';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { analyticsService } from '@/services/analytics/analytics.service';
import { campaignsService } from '@/services/campaigns/campaigns.service';
import { formatNumber } from '@/lib/format';
import { cap } from '@/features/crm/crmLabels';
import type { Campaign, CommunicationAnalytics } from '@/types';

type Icon = LucideIcon;

/** The reference dashboard shows a rolling window with no picker. */
const WINDOW_DAYS = 30;

const CHANNELS = ['sms', 'rcs', 'whatsapp', 'email', 'voice'];

/** Channel pill icons, matching the reference's badge treatment. */
const CHANNEL_ICON: Record<string, Icon> = {
  whatsapp: MessageCircle, sms: Smartphone, rcs: MessageSquare, email: Mail, voice: Mic,
};

/**
 * Delivery-status ring colours. The ORDER matters and is not cosmetic: green and
 * red are the pair colour-blind readers cannot separate, so they sit on opposite
 * sides of the ring. Every adjacent pair, wrap seam included, clears ΔE 9.7.
 */
const STATUS_COLORS = {
  delivered: 'var(--green)',
  read: 'var(--blue)',
  failed: 'var(--red)',
  sent: 'var(--orange)',
} as const;

export function DashboardPage() {
  const navigate = useNavigate();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const [showOrgs, setShowOrgs] = useState(false);

  const range = useMemo(() => ({
    from: new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString(),
    to: new Date().toISOString(),
  }), []);

  const statsQ = useQuery({
    queryKey: ['dash-comm', orgId, range],
    queryFn: () => analyticsService.communication(orgId, range),
    enabled: !!orgId,
  });
  const campaignsQ = useQuery({
    queryKey: ['dash-campaigns', orgId],
    queryFn: () => campaignsService.list(orgId, { page: 1, pageSize: 5, sort: 'createdAt', dir: 'desc' }),
    enabled: !!orgId,
  });

  const refreshing = statsQ.isFetching || campaignsQ.isFetching;
  const refresh = () => {
    statsQ.refetch();
    campaignsQ.refetch();
    toast.success('Dashboard refreshed');
  };

  const stats: CommunicationAnalytics | undefined = statsQ.data;
  const campaigns: Campaign[] = campaignsQ.data?.items ?? [];

  const slices: DonutSlice[] = stats ? [
    { key: 'delivered', label: 'Delivered', value: stats.totals.delivered, color: STATUS_COLORS.delivered },
    { key: 'read', label: 'Read', value: stats.totals.read, color: STATUS_COLORS.read },
    { key: 'failed', label: 'Failed', value: stats.totals.failed, color: STATUS_COLORS.failed },
    { key: 'sent', label: 'Sent', value: stats.totals.sent, color: STATUS_COLORS.sent },
  ] : [];

  const bars: BarDatum[] = CHANNELS.map((ch) => ({
    key: ch,
    label: ch === 'whatsapp' ? 'WhatsApp' : ch.toUpperCase(),
    value: stats?.byChannel.find((c) => c.channel === ch)?.total ?? 0,
  }));

  const maxFailure = Math.max(...(stats?.failureReasons.map((f) => f.count) ?? [0]), 1);

  return (
    <div className="space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">Dashboard Overview</h1>
          <p className="mt-1 text-sm text-muted">Welcome back! Here's what's happening with your campaigns today.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={refresh} title="Refresh" aria-label="Refresh dashboard"
            className="grid h-9 w-9 place-items-center rounded-[10px] border border-line bg-surface text-muted hover:bg-surface-2 disabled:opacity-50"
            disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : undefined} />
          </button>
          <Button variant="secondary" size="sm" onClick={() => setShowOrgs(true)}>
            <Building2 size={15} /> Manage Orgs
          </Button>
          <Button size="sm" onClick={() => navigate('/app/communication')}>
            <Plus size={15} /> New Campaign
          </Button>
        </div>
      </div>

      {statsQ.isLoading ? <LoadingState label="Loading dashboard…" />
        : statsQ.isError ? <ErrorState message="Could not load the dashboard." onRetry={() => statsQ.refetch()} />
        : !stats ? <EmptyState title="No data yet" detail="Send your first campaign to see numbers here." />
        : (
        <>
          {/* ── KPI tiles ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <Kpi label="Total Messages" value={stats.totals.total} icon={TrendingUp} tone="orange" />
            <Kpi label="Success Sent" value={stats.totals.sent} icon={CheckCircle2} tone="green" />
            <Kpi label="Delivered" value={stats.totals.delivered} icon={MessageSquare} tone="orange" />
            <Kpi label="Read" value={stats.totals.read} icon={CheckCheck} tone="green" />
            <Kpi label="Failed" value={stats.totals.failed} icon={XCircle} tone="red" />
          </div>

          {/* ── Charts ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Panel title="Live Status">
              <DonutChart slices={slices} />
            </Panel>

            <Panel title="Channel Breakdown">
              <BarChart data={bars} />
            </Panel>

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
                        <div className="h-full rounded-full bg-red"
                          style={{ width: `${Math.max((f.count / maxFailure) * 100, 2)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ── Recent activity ───────────────────────────────────────── */}
          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-4">
              <h3 className="font-display font-semibold text-ink">Recent Communication Activity</h3>
              <button onClick={() => navigate('/app/campaigns')} className="text-xs text-accent hover:underline">
                View All Campaigns <ArrowRight size={11} className="inline" />
              </button>
            </div>
            {campaignsQ.isLoading ? <div className="p-5"><LoadingState /></div>
              : campaignsQ.isError ? <div className="p-5"><ErrorState onRetry={() => campaignsQ.refetch()} /></div>
              : campaigns.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="No campaigns yet"
                    detail="Launch one from the Communication console and it will appear here." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
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
                      {campaigns.map((c) => (
                        <tr key={c.id} className="border-t border-line hover:bg-surface-2">
                          <td className="px-4 py-3 font-medium text-ink">{c.name}</td>
                          <td className="px-4 py-3"><ChannelPill channel={c.channel} /></td>
                          <td className="px-4 py-3"><Badge tone={statusTone(c.status)}>{cap(c.status)}</Badge></td>
                          <td className="px-4 py-3 text-muted">{new Date(c.createdAt).toLocaleDateString()}</td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => navigate(`/app/campaigns?id=${c.id}`)}
                              className="text-xs text-accent hover:underline">
                              View Details <ArrowRight size={11} className="inline" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
        </>
      )}

      {showOrgs && <ManageOrgsModal onClose={() => setShowOrgs(false)} onGoToSettings={() => { setShowOrgs(false); navigate('/app/settings'); }} />}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
const TONES: Record<string, string> = {
  accent: 'bg-accent-soft text-accent',
  orange: 'bg-orange/10 text-orange',
  blue: 'bg-blue/10 text-blue',
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
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${TONES[tone]}`}>
          <Icon size={17} />
        </span>
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

function ChannelPill({ channel }: { channel: string }) {
  const Icon = CHANNEL_ICON[channel] ?? MessageSquare;
  return (
    <Badge tone="green" className="uppercase">
      <Icon size={12} /> {channel}
    </Badge>
  );
}

function statusTone(status: string): 'green' | 'blue' | 'orange' | 'red' | 'neutral' {
  if (status === 'completed' || status === 'sent') return 'green';
  if (status === 'running' || status === 'sending') return 'blue';
  if (status === 'scheduled') return 'orange';
  if (status === 'failed') return 'red';
  return 'neutral';
}

/**
 * Workspace switching and membership live in Settings — this modal points there
 * rather than reimplementing them, so there is one place that owns the truth.
 */
function ManageOrgsModal({ onClose, onGoToSettings }: { onClose: () => void; onGoToSettings: () => void }) {
  const workspaces = useOrgStore((s) => s.workspaces);
  const currentId = useOrgStore((s) => s.currentWorkspaceId);
  const switchWorkspace = useOrgStore((s) => s.switchWorkspace);

  return (
    <Modal open onClose={onClose} title="Organisation Workspace" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        <Button size="sm" onClick={onGoToSettings}><Building2 size={15} /> Workspace settings</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Switch the workspace this dashboard reports on.</p>
        {workspaces.length === 0 ? (
          <div className="flex items-start gap-2 rounded-[10px] border border-line bg-surface-2 p-3 text-sm text-muted">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" />
            <span>No workspaces loaded. Sign out and back in if this looks wrong.</span>
          </div>
        ) : (
          <div className="divide-y divide-line rounded-[10px] border border-line">
            {workspaces.map((w) => {
              const on = w.id === currentId;
              return (
                <div key={w.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">{w.name}</div>
                    {on && <div className="text-xs text-muted">Currently viewing</div>}
                  </div>
                  <Button variant={on ? 'secondary' : 'primary'} size="sm" disabled={on}
                    onClick={() => { switchWorkspace(w.id); onClose(); toast.success(`Switched to ${w.name}`); }}>
                    {on ? 'Active' : 'Switch'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
