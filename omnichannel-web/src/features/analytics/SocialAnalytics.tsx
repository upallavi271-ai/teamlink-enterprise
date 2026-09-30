import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, Heart, Eye, MessageCircle, Users, Activity, AlertTriangle, ExternalLink,
} from 'lucide-react';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { LineChart, type LineSeries } from '@/components/charts/LineChart';
import { GroupedBarChart, type BarSeries } from '@/components/charts/GroupedBarChart';
import { DonutChart, type DonutSlice } from '@/components/charts/DonutChart';
import { LoadingState, ErrorState, EmptyState } from '@/components/feedback/states';
import { socialService } from '@/services/social/social.service';
import { publishingService } from '@/services/social/publishing.service';
import { useOrgStore } from '@/stores/orgStore';
import { formatNumber } from '@/lib/format';
import { cap } from '@/features/crm/crmLabels';
import type { SocialAccount } from '@/types';
import type { SocialPostMetricsRow } from '@/services/social/publishing.types';

/** Validated: worst all-pairs ΔE 9.7 protan / 23.6 normal against a white surface. */
const C = {
  reach: 'var(--accent)',
  engagement: 'var(--violet)',
  views: 'var(--blue)',
  comments: 'var(--orange)',
  likes: 'var(--accent)',
  shares: 'var(--blue)',
};

export function SocialAnalytics({ from, to }: { from: string; to: string }) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const [accountId, setAccountId] = useState('');
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);

  const accountsQ = useQuery({
    queryKey: ['social-accounts', orgId],
    queryFn: () => socialService.accounts(orgId),
    enabled: !!orgId,
    refetchOnMount: 'always',
  });
  const accounts: SocialAccount[] = accountsQ.data ?? [];
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;

  const statsQ = useQuery({
    queryKey: ['social-analytics', orgId, from, to, account?.id],
    queryFn: () => publishingService.socialAnalytics(orgId, { from, to, accountId: account?.id }),
    enabled: !!orgId && accounts.length > 0,
    refetchOnMount: 'always',
  });
  const stats = statsQ.data;

  const labels = useMemo(() => (stats?.daily ?? []).map((d) => d.date.slice(5)), [stats]);

  const reachSeries: LineSeries[] = useMemo(() => [
    { key: 'reach', label: 'Reach', color: C.reach, values: (stats?.daily ?? []).map((d) => d.reach) },
    { key: 'engagement', label: 'Total Engagement', color: C.engagement, values: (stats?.daily ?? []).map((d) => d.engagement) },
  ], [stats]);

  const trendSeries: LineSeries[] = useMemo(() => [
    { key: 'reach', label: 'Reach', color: C.reach, values: (stats?.daily ?? []).map((d) => d.reach) },
    { key: 'views', label: 'Views', color: C.views, values: (stats?.daily ?? []).map((d) => d.views) },
  ], [stats]);

  const engagementBars: BarSeries[] = useMemo(() => [
    { key: 'comments', label: 'Comments', color: C.comments, values: (stats?.daily ?? []).map((d) => d.comments) },
    { key: 'likes', label: 'Likes', color: C.likes, values: (stats?.daily ?? []).map((d) => d.likes) },
    { key: 'shares', label: 'Shares', color: C.shares, values: (stats?.daily ?? []).map((d) => d.shares) },
  ], [stats]);

  const interaction: DonutSlice[] = useMemo(() => {
    const t = stats?.totals;
    if (!t) return [];
    return [
      { key: 'likes', label: 'Likes', value: t.likes, color: 'var(--green)' },
      { key: 'comments', label: 'Comments', value: t.comments, color: 'var(--blue)' },
      { key: 'shares', label: 'Shares', value: t.shares, color: 'var(--red)' },
      { key: 'clicks', label: 'Clicks', value: t.clicks, color: 'var(--orange)' },
    ];
  }, [stats]);

  const posts: SocialPostMetricsRow[] = stats?.posts ?? [];
  const pageRows = posts.slice((page - 1) * perPage, page * perPage);
  const pages = Math.max(1, Math.ceil(posts.length / perPage));

  if (accountsQ.isLoading) return <LoadingState label="Loading social accounts…" />;
  if (accountsQ.isError) return <ErrorState message="Could not load social accounts." onRetry={() => accountsQ.refetch()} />;

  if (accounts.length === 0) {
    return (
      <Card><CardBody>
        <EmptyState title="No social accounts connected"
          detail="Connect a Facebook Page or LinkedIn account in Settings → Integrations to see analytics here." />
      </CardBody></Card>
    );
  }

  const unavailable = stats && !stats.available;

  return (
    <div className="space-y-4">
      {/* ── Post Performance ─────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold text-ink">Post Performance</h3>
          <Select className="h-8 !w-32" value={String(perPage)} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}>
            {[10, 25, 50].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </Select>
        </div>

        {statsQ.isLoading ? <div className="p-5"><LoadingState /></div>
          : statsQ.isError ? <div className="p-5"><ErrorState onRetry={() => statsQ.refetch()} /></div>
          : posts.length === 0 ? <div className="p-5"><EmptyState title="No published posts in this period" detail="Publish from Content Studio and they will appear here." /></div>
          : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-surface-2 text-xs uppercase text-muted">
                    <tr>
                      <th className="px-4 py-3 text-left">Content</th>
                      <th className="px-4 py-3 text-left">Platform</th>
                      <th className="px-4 py-3 text-right">Views</th>
                      <th className="px-4 py-3 text-right">Likes</th>
                      <th className="px-4 py-3 text-right">Comments</th>
                      <th className="px-4 py-3 text-right">Shares</th>
                      <th className="px-4 py-3 text-right">Reach</th>
                      <th className="px-4 py-3 text-right">Interactions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((p) => {
                      const m = p.metrics;
                      const interactions = m ? (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0) : null;
                      return (
                        <tr key={p.targetId} className="border-t border-line hover:bg-surface-2">
                          <td className="max-w-[300px] px-4 py-3">
                            <div className="truncate text-ink" title={p.name || p.caption}>{p.name || p.caption || 'Untitled Post'}</div>
                            {p.publishedAt && <div className="text-[11px] text-muted">{new Date(p.publishedAt).toLocaleDateString()}</div>}
                          </td>
                          <td className="px-4 py-3">
                            <Badge tone="blue">{cap(p.platform.toLowerCase())}</Badge>
                          </td>
                          <Cell v={m?.impressions} />
                          <Cell v={m?.likes} />
                          <Cell v={m?.comments} />
                          <Cell v={m?.shares} />
                          <Cell v={m?.reach} />
                          <td className="px-4 py-3 text-right">
                            {interactions === null
                              ? <span className="text-muted" title="No insights returned for this post">—</span>
                              : <span className="font-medium text-orange">{formatNumber(interactions)}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-xs text-muted">
                <span>Showing {(page - 1) * perPage + 1} – {Math.min(page * perPage, posts.length)} of {posts.length}</span>
                <div className="flex gap-1">
                  <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"
                    className="rounded-lg border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-40">‹</button>
                  <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"
                    className="rounded-lg border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-40">›</button>
                </div>
              </div>
            </>
          )}
      </Card>

      {/* ── Account header + selector ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Card className="min-w-[280px] flex-1">
          <CardBody className="flex items-center gap-3">
            <span className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft text-sm font-semibold text-accent">
              {account?.avatarUrl
                ? <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
                : (account?.name ?? '?').slice(0, 2).toUpperCase()}
              <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-green" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium text-ink">{account?.name}</div>
              <div className="mt-0.5 flex items-center gap-2">
                {account && <Badge tone="blue">{account.platform}</Badge>}
                {account?.username && <span className="text-xs text-muted">@{account.username}</span>}
              </div>
            </div>
          </CardBody>
        </Card>
        <Select className="h-10 !w-56" value={account?.id ?? ''} onChange={(e) => { setAccountId(e.target.value); setPage(1); }}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.platform.toLowerCase()})</option>)}
        </Select>
      </div>

      {/* ── Stat tiles ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label="Total Reach" value={stats?.totals.reach} live={!!stats?.available} icon={TrendingUp} tone="accent" />
        <Stat label="Total Likes" value={stats?.totals.likes} live={!!stats?.available} icon={Heart} tone="orange" />
        <Stat label="Total Posts" value={stats?.totals.posts} live icon={Eye} tone="blue" />
        <Stat label="Total Comments" value={stats?.totals.comments} live={!!stats?.available} icon={MessageCircle} tone="violet" />
        <Stat label="Total Engagement" value={stats?.totals.engagement} live={!!stats?.available} icon={Users} tone="green" />
      </div>

      {unavailable && (
        <div className="flex items-start gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-3 text-xs text-ink">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-orange" />
          <span>
            <b>Provider insights unavailable.</b> {stats?.reason} Post counts and publish dates below are real;
            reach, likes and comments are shown as “—” rather than zero so they are not mistaken for measured values.
          </span>
        </div>
      )}

      {/* ── The four panels ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Reach & Engagement Over Time" icon={TrendingUp} className="lg:col-span-2">
          {statsQ.isLoading ? <LoadingState /> : <LineChart labels={labels} series={reachSeries} />}
        </Panel>

        <Panel title="Interaction Breakdown" icon={Activity}>
          {statsQ.isLoading ? <LoadingState />
            : interaction.every((i) => i.value === 0)
              ? <EmptyState title="No interactions" detail={unavailable ? 'Insights are not available for this account.' : 'Nothing recorded in this period.'} />
              : <DonutChart slices={interaction} size={190} thickness={44} />}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Detailed Engagement Metrics" icon={Heart}>
          {statsQ.isLoading ? <LoadingState /> : <GroupedBarChart labels={labels} series={engagementBars} />}
        </Panel>

        <Panel title="Reach Trend Analysis" icon={Eye}>
          {statsQ.isLoading ? <LoadingState /> : <LineChart labels={labels} series={trendSeries} />}
        </Panel>
      </div>

      {account && (
        <p className="text-xs text-muted">
          Viewing <span className="text-ink">{account.name}</span>
          {posts[0]?.permalink && (
            <> · <a className="inline-flex items-center gap-1 text-accent hover:underline" href={posts[0].permalink} target="_blank" rel="noreferrer">
              Open latest post <ExternalLink size={11} />
            </a></>
          )}
        </p>
      )}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Cell({ v }: { v?: number }) {
  return (
    <td className="px-4 py-3 text-right">
      {v === undefined || v === null
        ? <span className="text-muted" title="No insights returned for this post">—</span>
        : <span className="text-ink">{formatNumber(v)}</span>}
    </td>
  );
}

function Panel({ title, icon: Icon, className, children }: {
  title: string; icon: typeof Eye; className?: string; children: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardBody className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Icon size={15} className="text-accent" /> {title}
        </h3>
        {children}
      </CardBody>
    </Card>
  );
}

const TONES: Record<string, string> = {
  accent: 'bg-accent-soft text-accent',
  green: 'bg-green-3 text-green-2',
  blue: 'bg-blue/10 text-blue',
  orange: 'bg-orange/10 text-orange',
  violet: 'bg-violet/10 text-violet',
};

function Stat({ label, value, live, icon: Icon, tone }: {
  label: string; value?: number; live: boolean; icon: typeof Eye; tone: keyof typeof TONES;
}) {
  const show = live && value !== undefined;
  return (
    <Card>
      <CardBody className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] text-muted">{label}</div>
          <div className="font-display text-xl font-semibold text-ink">
            {show ? formatNumber(value) : <span className="text-muted" title="Provider insights unavailable">—</span>}
          </div>
        </div>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${TONES[tone]}`}><Icon size={15} /></span>
      </CardBody>
    </Card>
  );
}
