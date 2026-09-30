import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Globe, Link2, Unplug, MousePointerClick, Eye, Percent, Hash, Info, AlertTriangle, Settings2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LineChart } from '@/components/charts/LineChart';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { DateRangeModal, useDateRange } from '@/features/_shared/DateRangeModal';
import { useCan } from '@/features/auth/useCan';
import { toast } from '@/components/toast/toastStore';
import { formatNumber } from '@/lib/format';
import { searchConsoleService, GSC_PROVIDER } from '@/services/seo/searchConsole.service';
import { integrationsService } from '@/services/integrations/integrations.service';
import type { GscMetrics, GscNamed } from '@/services/seo/seo.types';
import { useOrgStore } from '@/stores/orgStore';

type Icon = LucideIcon;
type Metric = keyof GscMetrics;
const METRICS: { key: Metric; label: string; icon: Icon; color: string; fmt: (v: number) => string }[] = [
  { key: 'clicks', label: 'Clicks', icon: MousePointerClick, color: 'var(--green)', fmt: (v) => formatNumber(Math.round(v)) },
  { key: 'impressions', label: 'Impressions', icon: Eye, color: 'var(--violet)', fmt: (v) => formatNumber(Math.round(v)) },
  { key: 'ctr', label: 'Avg CTR', icon: Percent, color: 'var(--orange)', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  { key: 'position', label: 'Avg position', icon: Hash, color: 'var(--blue)', fmt: (v) => v ? v.toFixed(1) : '—' },
];
const fmtOf = (k: Metric) => METRICS.find((m) => m.key === k)!.fmt;
const shortDate = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
/** Search Console publishes ~3 days late, so presets end 3 days ago. */
const GSC_LAG_DAYS = 3;

function NamedTable({ title, rows, keyLabel, linkify }: { title: string; rows: GscNamed[]; keyLabel: string; linkify?: boolean }) {
  return (
    <Card>
      <CardHeader><h3 className="text-sm font-semibold text-ink">{title}</h3><span className="text-xs text-muted">{rows.length} rows</span></CardHeader>
      {rows.length === 0 ? <EmptyState title="No data" detail="Google returned nothing for this range." /> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-left text-xs font-semibold text-muted">
                <th className="px-4 py-3">{keyLabel}</th><th className="px-4 py-3 text-right">Clicks</th><th className="px-4 py-3 text-right">Impr.</th><th className="px-4 py-3 text-right">CTR</th><th className="px-4 py-3 text-right">Pos.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                  <td className="max-w-[320px] px-4 py-3">
                    {linkify ? <a href={r.key} target="_blank" rel="noreferrer" className="block truncate text-ink hover:underline" title={r.key}>{r.key.replace(/^https?:\/\//, '')}</a>
                      : <span className="block truncate text-ink" title={r.key}>{r.key}</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-ink">{formatNumber(r.clicks)}</td>
                  <td className="px-4 py-3 text-right text-muted">{formatNumber(r.impressions)}</td>
                  <td className="px-4 py-3 text-right text-muted">{(r.ctr * 100).toFixed(1)}%</td>
                  <td className="px-4 py-3 text-right text-muted">{r.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PropertyModal({ current, onClose, onPick, saving }: { current?: string; onClose: () => void; onPick: (siteUrl: string) => void; saving: boolean }) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const sites = useQuery({ queryKey: ['seo-gsc', orgId, 'sites'], queryFn: () => searchConsoleService.sites(), enabled: !!orgId });
  const [sel, setSel] = useState(current ?? '');
  useEffect(() => { if (!sel && sites.data?.[0]) setSel(sites.data[0].siteUrl); }, [sites.data, sel]);
  return (
    <Modal open onClose={onClose} title="Choose a Search Console property" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={saving} disabled={!sel} onClick={() => onPick(sel)}>Use this property</Button>
      </>}>
      {sites.isLoading ? <LoadingState label="Asking Google for your properties…" />
        : sites.isError ? <ErrorState message={(sites.error as Error)?.message ?? 'Could not list properties.'} onRetry={() => sites.refetch()} />
        : !sites.data?.length ? (
          <EmptyState title="No properties on this Google account"
            detail="Add and verify your site in Google Search Console first (search.google.com/search-console), then reconnect." />
        ) : (
          <div className="divide-y divide-line rounded-[10px] border border-line">
            {sites.data.map((s) => (
              <label key={s.siteUrl} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
                <input type="radio" name="gsc-site" checked={sel === s.siteUrl} onChange={() => setSel(s.siteUrl)} />
                <span className="flex-1 truncate text-sm text-ink">{s.siteUrl}</span>
                <Badge tone={s.permissionLevel === 'siteOwner' ? 'green' : 'neutral'}>{s.permissionLevel.replace('site', '').toLowerCase() || s.permissionLevel}</Badge>
              </label>
            ))}
          </div>
        )}
      <p className="mt-3 text-xs text-muted">Only properties the connected Google account can see are listed. Domain properties look like <code>sc-domain:example.com</code>.</p>
    </Modal>
  );
}

export function SearchConsolePage() {
  const qc = useQueryClient();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('integration.manage');
  const dr = useDateRange('30', GSC_LAG_DAYS);
  const [metric, setMetric] = useState<Metric>('clicks');
  const [propOpen, setPropOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const conn = useQuery({ queryKey: ['seo-gsc', orgId, 'connection'], queryFn: () => searchConsoleService.connection(), enabled: !!orgId });
  const connected = conn.data?.status === 'CONNECTED';
  const property = conn.data?.property;
  const overview = useQuery({
    queryKey: ['seo-gsc', orgId, 'overview', property, dr.range.from, dr.range.to],
    queryFn: () => searchConsoleService.overview(dr.range.from, dr.range.to),
    enabled: !!orgId && connected && !!property,
  });

  const connect = useMutation({
    mutationFn: () => integrationsService.connect(orgId, GSC_PROVIDER),
    onSuccess: (r) => {
      if (r.configured && r.authorizeUrl) window.location.assign(r.authorizeUrl);
      else toast.error(r.message ?? 'Google OAuth is not configured on the server.');
    },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not start Google sign-in'),
  });
  const pick = useMutation({
    mutationFn: (siteUrl: string) => searchConsoleService.selectProperty(siteUrl),
    onSuccess: (r) => { toast.success(`Showing ${r.property}`); setPropOpen(false); qc.invalidateQueries({ queryKey: ['seo-gsc', orgId] }); },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not save the property'),
  });
  const disconnect = useMutation({
    mutationFn: () => integrationsService.disconnect(orgId, conn.data?.integrationId as string),
    onSuccess: () => { toast.success('Google Search Console disconnected'); setConfirmDisconnect(false); qc.invalidateQueries({ queryKey: ['seo-gsc', orgId] }); qc.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e: Error) => toast.error(e?.message ?? 'Disconnect failed'),
  });

  const ov = overview.data;
  const chart = useMemo(() => {
    if (!ov?.available) return null;
    const m = METRICS.find((x) => x.key === metric)!;
    return {
      labels: ov.daily.map((d) => shortDate(d.date)),
      series: [{ key: m.key, label: m.label, color: m.color, values: ov.daily.map((d) => (metric === 'ctr' ? d.ctr * 100 : d[metric])) }],
      fmt: metric === 'ctr' ? (v: number) => `${v.toFixed(1)}%` : m.fmt,
    };
  }, [ov, metric]);

  // Once connected without a property, ask for it straight away.
  useEffect(() => { if (connected && !property && canManage) setPropOpen(true); }, [connected, property, canManage]);

  const header = (
    <PageHeader title="Search Console" subtitle="Clicks, impressions, CTR and ranking position from Google Search"
      actions={<>
        <RefreshButton keys={['seo-gsc']} />
        {connected && property && (
          <Button variant="secondary" size="sm" onClick={() => dr.setPickerOpen(true)}><CalendarDays size={15} /> {dr.label}</Button>
        )}
      </>} />
  );

  if (conn.isLoading) return <div>{header}<LoadingState label="Checking the Google connection…" /></div>;
  if (conn.isError) return <div>{header}<ErrorState message="Could not check the Google connection." onRetry={() => conn.refetch()} /></div>;

  // ── Not configured on the server ─────────────────────────────────────────
  if (!conn.data?.configured) {
    return (
      <div>{header}
        <Card><CardBody className="space-y-3">
          <div className="flex items-start gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-3 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" />
            <div><div className="font-medium text-ink">Google sign-in is not set up on this server yet</div>
              <div className="text-xs text-muted">Search Console needs a Google OAuth client. This is a one-time setup — no passwords are ever stored.</div></div>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink">
            <li>Go to <b>console.cloud.google.com</b> → create (or open) a project.</li>
            <li><b>APIs &amp; Services → Library</b> → enable <b>Google Search Console API</b>.</li>
            <li><b>OAuth consent screen</b> → External → add your Google account as a test user.</li>
            <li><b>Credentials → Create credentials → OAuth client ID → Web application</b>; add this redirect URI:<br />
              <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{`${window.location.origin}${import.meta.env.BASE_URL}app/settings/oauth/${GSC_PROVIDER}`}</code></li>
            <li>Add to the API <code>.env</code>: <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REDIRECT_URI</code> (the URI above), then restart the API.</li>
          </ol>
        </CardBody></Card>
      </div>
    );
  }

  // ── Not connected ────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <div>{header}
        <Card><CardBody className="flex flex-col items-center gap-3 py-14 text-center">
          <div className="rounded-full bg-surface-2 p-3 text-muted"><Globe size={22} /></div>
          <p className="font-medium text-ink">Connect Google Search Console</p>
          <p className="max-w-md text-sm text-muted">
            Sign in with the Google account that owns your site in Search Console. Green Start asks for <b>read-only</b> access and never sees your password.
          </p>
          {conn.data.status === 'EXPIRED' && <p className="text-xs text-red">{conn.data.lastError ?? 'The previous connection expired.'}</p>}
          <Button disabled={!canManage} loading={connect.isPending} onClick={() => connect.mutate()}><Link2 size={15} /> Continue with Google</Button>
          {!canManage && <p className="text-xs text-muted">You need the “Manage integrations” permission to connect.</p>}
        </CardBody></Card>
      </div>
    );
  }

  // ── Connected ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {header}
      <Card><CardBody className="flex flex-wrap items-center gap-3">
        <Badge tone="green">Connected</Badge>
        <span className="text-sm text-ink">{conn.data.account}</span>
        <span className="text-muted">·</span>
        {property ? <span className="text-sm text-ink" title={property}><Globe size={14} className="mr-1 inline text-muted" />{property}</span>
          : <span className="text-sm text-orange">No property chosen</span>}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" disabled={!canManage} onClick={() => setPropOpen(true)}><Settings2 size={14} /> {property ? 'Change property' : 'Choose property'}</Button>
          <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => setConfirmDisconnect(true)}><Unplug size={14} /> Disconnect</Button>
        </div>
      </CardBody></Card>

      {!property ? (
        <Card><EmptyState title="Choose which site to show" detail="Pick one of the properties this Google account can see." action={<Button size="sm" disabled={!canManage} onClick={() => setPropOpen(true)}>Choose property</Button>} /></Card>
      ) : overview.isLoading ? <Card><LoadingState label="Fetching Search Console data…" /></Card>
        : overview.isError ? <Card><ErrorState message={(overview.error as Error)?.message ?? 'Google did not answer.'} onRetry={() => overview.refetch()} /></Card>
        : ov && !ov.available ? (
          <Card><CardBody className="flex items-start gap-2 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" /><span className="text-ink">{ov.reason}</span></CardBody></Card>
        ) : ov && ov.available ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {METRICS.map((m) => (
                <button key={m.key} type="button" onClick={() => setMetric(m.key)}
                  className={`rounded-card border bg-surface p-4 text-left shadow-sm transition-colors ${metric === m.key ? 'border-accent' : 'border-line hover:border-muted'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-muted">{m.label}</span>
                    <m.icon size={16} className="text-muted" />
                  </div>
                  <div className="mt-1 font-display text-2xl font-semibold text-ink">{m.fmt(ov.totals[m.key])}</div>
                </button>
              ))}
            </div>

            <Card>
              <CardHeader>
                <h3 className="text-sm font-semibold text-ink">{METRICS.find((m) => m.key === metric)?.label} by day</h3>
                <span className="text-xs text-muted">{ov.daily.length} days</span>
              </CardHeader>
              <CardBody>
                {chart && ov.daily.length > 0 ? <LineChart labels={chart.labels} series={chart.series} formatValue={chart.fmt} />
                  : <EmptyState title="No daily data" detail="Google has no rows for this range yet." />}
                <div className="mt-2 flex items-start gap-1.5 text-xs text-muted">
                  <Info size={13} className="mt-0.5 shrink-0" />
                  <span>Google publishes Search Console data about {GSC_LAG_DAYS} days late{ov.latestDataDate ? ` — newest day available: ${shortDate(ov.latestDataDate)}` : ''}. Average position is impression-weighted, the same way Search Console reports it.</span>
                </div>
              </CardBody>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <NamedTable title="Top queries" rows={ov.queries} keyLabel="Query" />
              <NamedTable title="Top pages" rows={ov.pages} keyLabel="Page" linkify />
              <NamedTable title="Devices" rows={ov.devices.map((d) => ({ ...d, key: d.key.toLowerCase() }))} keyLabel="Device" />
              <NamedTable title="Countries" rows={ov.countries.map((c) => ({ ...c, key: c.key.toUpperCase() }))} keyLabel="Country (ISO)" />
            </div>
            <div className="text-[11px] text-muted">{fmtOf('clicks')(ov.totals.clicks)} clicks · data from Google Search Console for {ov.property}</div>
          </>
        ) : null}

      {dr.pickerOpen && <DateRangeModal preset={dr.preset} from={dr.customFrom} to={dr.customTo} onApply={dr.apply} onClose={() => dr.setPickerOpen(false)} />}
      {propOpen && <PropertyModal current={property} saving={pick.isPending} onClose={() => setPropOpen(false)} onPick={(s) => pick.mutate(s)} />}
      <ConfirmDialog open={confirmDisconnect} title="Disconnect Google Search Console" danger confirmLabel="Disconnect" loading={disconnect.isPending}
        message="Green Start will forget the Google tokens for this workspace. You can reconnect any time."
        onConfirm={() => disconnect.mutate()} onClose={() => setConfirmDisconnect(false)} />
    </div>
  );
}
