import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus, Info, AlertTriangle, ArrowUpDown } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LineChart } from '@/components/charts/LineChart';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { DateRangeModal, useDateRange } from '@/features/_shared/DateRangeModal';
import { useCan } from '@/features/auth/useCan';
import { toast } from '@/components/toast/toastStore';
import { formatNumber } from '@/lib/format';
import { keywordsService } from '@/services/seo/keywords.service';
import { searchConsoleService } from '@/services/seo/searchConsole.service';
import type { TrackedKeyword } from '@/services/seo/seo.types';
import { useOrgStore } from '@/stores/orgStore';

const GSC_LAG_DAYS = 3;
type SortKey = 'keyword' | 'position' | 'change' | 'clicks' | 'impressions';
const shortDate = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtPos = (v: number | null) => (v == null ? '—' : v.toFixed(1));
const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function Change({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted">—</span>;
  const r = Math.round(v * 10) / 10;
  if (Math.abs(r) < 0.05) return <span className="inline-flex items-center gap-1 text-muted"><Minus size={13} /> 0</span>;
  // Positive = moved UP the results (position number went down).
  return r > 0
    ? <span className="inline-flex items-center gap-1 text-green"><TrendingUp size={13} /> +{r}</span>
    : <span className="inline-flex items-center gap-1 text-red"><TrendingDown size={13} /> {r}</span>;
}

function AddKeywordsModal({ onClose, onAdd, saving }: { onClose: () => void; onAdd: (kw: string[], country: string, device: string) => void; saving: boolean }) {
  const [text, setText] = useState('');
  const [country, setCountry] = useState('');
  const [device, setDevice] = useState('');
  const list = useMemo(() => [...new Set(text.split(/\n|,/).map((s) => s.trim().toLowerCase()).filter(Boolean))], [text]);
  return (
    <Modal open onClose={onClose} title="Track keywords" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={saving} disabled={!list.length || list.length > 50} onClick={() => onAdd(list, country.trim().toLowerCase(), device)}>
          Track {list.length || ''} keyword{list.length === 1 ? '' : 's'}
        </Button>
      </>}>
      <div className="space-y-3">
        <Field label="Keywords (one per line, or comma-separated)" hint={list.length > 50 ? 'Up to 50 at a time.' : `${list.length} unique`}>
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'recruitment agency hyderabad\nstaffing company bangalore'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Country (optional)" hint="3-letter code Search Console uses, e.g. ind, usa">
            <Input value={country} maxLength={3} onChange={(e) => setCountry(e.target.value)} placeholder="ind" />
          </Field>
          <Field label="Device (optional)">
            <Select value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="">All devices</option><option value="MOBILE">Mobile</option><option value="DESKTOP">Desktop</option><option value="TABLET">Tablet</option>
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted">Positions come from Google Search Console for the exact query — a keyword shows data only on days your site was actually shown for it.</p>
      </div>
    </Modal>
  );
}

export function KeywordsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('content.manage');
  const dr = useDateRange('30', GSC_LAG_DAYS);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'clicks', dir: 'desc' });
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<TrackedKeyword | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const conn = useQuery({ queryKey: ['seo-gsc', orgId, 'connection'], queryFn: () => searchConsoleService.connection(), enabled: !!orgId });
  const ready = conn.data?.status === 'CONNECTED' && !!conn.data.property;
  const list = useQuery({
    queryKey: ['seo-keywords', orgId, dr.range.from, dr.range.to, search],
    queryFn: () => keywordsService.list(dr.range.from, dr.range.to, search || undefined),
    enabled: !!orgId && ready,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['seo-keywords', orgId] });

  const add = useMutation({
    mutationFn: (v: { kw: string[]; country: string; device: string }) => keywordsService.add(v.kw, v.country || undefined, v.device || undefined),
    onSuccess: (r) => {
      toast.success(`Tracking ${r.created} new keyword${r.created === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} already tracked` : ''}`);
      if (r.sync?.failed) toast.error(`${r.sync.failed} keyword${r.sync.failed === 1 ? '' : 's'} could not be synced: ${r.sync.errors[0]?.reason ?? ''}`);
      setAddOpen(false); invalidate();
    },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not add keywords'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => keywordsService.remove(id),
    onSuccess: (_r, id) => { toast.success('Keyword removed'); setToDelete(null); if (selectedId === id) setSelectedId(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Delete failed'),
  });
  const sync = useMutation({
    mutationFn: (onlyStale: boolean) => keywordsService.sync(onlyStale),
    onSuccess: (r) => {
      if (r.keywords === 0) toast.info('Nothing to sync yet');
      else toast[r.failed ? 'error' : 'success'](`Synced ${r.synced}/${r.keywords} keywords from Search Console${r.failed ? ` — ${r.failed} failed` : ''}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e?.message ?? 'Sync failed'),
  });

  // Data older than 12 h refreshes itself once, quietly.
  useEffect(() => {
    if (list.data?.stale && list.data.total > 0 && canManage && !sync.isPending) sync.mutate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data?.stale]);

  const rows = useMemo(() => {
    const items = [...(list.data?.items ?? [])];
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (k: TrackedKeyword): number | string => {
      if (sort.key === 'keyword') return k.keyword;
      const v = k[sort.key];
      return v == null ? (sort.key === 'position' ? Infinity : -Infinity) : v;
    };
    return items.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  }, [list.data, sort]);
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];
  const toggleSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : key === 'position' ? 'asc' : 'desc' }));

  const summary = useMemo(() => {
    const items = list.data?.items ?? [];
    const ranked = items.filter((k) => k.position != null);
    return {
      tracked: items.length,
      top10: ranked.filter((k) => (k.position as number) <= 10).length,
      improved: items.filter((k) => (k.change ?? 0) > 0.05).length,
      declined: items.filter((k) => (k.change ?? 0) < -0.05).length,
      clicks: items.reduce((s, k) => s + k.clicks, 0),
    };
  }, [list.data]);

  const chart = useMemo(() => {
    if (!selected || !selected.series.length) return null;
    return {
      labels: selected.series.map((p) => shortDate(p.date)),
      series: [{ key: 'pos', label: `Position — ${selected.keyword}`, color: 'var(--green)', values: selected.series.map((p) => p.position) }],
    };
  }, [selected]);

  const header = (
    <PageHeader title="Keywords" subtitle="Track where your site ranks for the searches that matter"
      actions={<>
        <RefreshButton keys={['seo-keywords']} />
        {ready && <Button variant="secondary" size="sm" onClick={() => dr.setPickerOpen(true)}><CalendarDays size={15} /> {dr.label}</Button>}
        {ready && canManage && <Button variant="secondary" size="sm" loading={sync.isPending} onClick={() => sync.mutate(false)}><RefreshCw size={15} /> Sync now</Button>}
        {ready && canManage && <Button size="sm" onClick={() => setAddOpen(true)}><Plus size={15} /> Track keywords</Button>}
      </>} />
  );

  if (conn.isLoading) return <div>{header}<LoadingState label="Checking the Google connection…" /></div>;
  if (!ready) {
    return (
      <div>{header}
        <Card><CardBody className="flex flex-col items-center gap-3 py-14 text-center">
          <div className="rounded-full bg-surface-2 p-3 text-muted"><AlertTriangle size={22} /></div>
          <p className="font-medium text-ink">{conn.data?.status === 'CONNECTED' ? 'Choose a Search Console property first' : 'Keyword tracking needs Google Search Console'}</p>
          <p className="max-w-md text-sm text-muted">Positions come from your own Search Console data (no scraping). Connect it and pick the property for your site, then come back here.</p>
          <Button size="sm" onClick={() => navigate('/app/seo/search-console')}>Open Search Console</Button>
        </CardBody></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: 'Tracked', value: summary.tracked },
          { label: 'In top 10', value: summary.top10 },
          { label: 'Improved', value: summary.improved, tone: 'text-green' },
          { label: 'Declined', value: summary.declined, tone: 'text-red' },
          { label: 'Clicks in range', value: summary.clicks },
        ].map((k) => (
          <Card key={k.label}><CardBody className="py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted">{k.label}</div>
            <div className={`font-display text-2xl font-semibold ${k.tone ?? 'text-ink'}`}>{formatNumber(k.value)}</div>
          </CardBody></Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-ink">Tracked keywords</h3>
            <span className="text-xs text-muted">{conn.data?.property} · synced {ago(list.data?.lastSyncedAt)}</span>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Filter keywords…" />
        </CardHeader>
        {list.isLoading ? <LoadingState label="Loading keywords…" />
          : list.isError ? <ErrorState message={(list.error as Error)?.message ?? 'Could not load keywords.'} onRetry={() => list.refetch()} />
          : rows.length === 0 ? (
            <EmptyState title={search ? 'No keywords match' : 'No keywords tracked yet'} detail={search ? 'Try a different filter.' : 'Add the searches you want to rank for and Green Start will pull their daily position from Search Console.'}
              action={!search && canManage ? <Button size="sm" onClick={() => setAddOpen(true)}><Plus size={15} /> Track keywords</Button> : undefined} />
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2/60 text-left text-xs font-semibold text-muted">
                  {([['keyword', 'Keyword'], ['position', 'Position'], ['change', 'Change'], ['clicks', 'Clicks'], ['impressions', 'Impressions']] as [SortKey, string][]).map(([k, l]) => (
                    <th key={k} className={`px-4 py-2.5 ${k === 'keyword' ? '' : 'text-right'}`}>
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort(k)}>{l} <ArrowUpDown size={12} /></button>
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right">CTR</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id} onClick={() => setSelectedId(k.id)} className={`cursor-pointer border-b border-line last:border-0 hover:bg-surface-2/60 ${selected?.id === k.id ? 'bg-accent-soft/40' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{k.keyword}</div>
                      <div className="flex flex-wrap gap-1 text-[11px] text-muted">
                        {k.country && <Badge tone="neutral">{k.country.toUpperCase()}</Badge>}
                        {k.device && <Badge tone="neutral">{k.device.toLowerCase()}</Badge>}
                        {k.lastError && <span className="text-red" title={k.lastError}>sync failed</span>}
                        {!k.lastError && k.position == null && <span>no impressions in range</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-ink" title={k.positionDate ? `on ${shortDate(k.positionDate)}` : ''}>{fmtPos(k.position)}</td>
                    <td className="px-4 py-3 text-right"><Change v={k.change} /></td>
                    <td className="px-4 py-3 text-right text-ink">{formatNumber(k.clicks)}</td>
                    <td className="px-4 py-3 text-right text-muted">{formatNumber(k.impressions)}</td>
                    <td className="px-4 py-3 text-right text-muted">{(k.ctr * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" disabled={!canManage} onClick={(e) => { e.stopPropagation(); setToDelete(k); }} title="Stop tracking" aria-label={`Stop tracking ${k.keyword}`}
                        className="rounded-lg p-1.5 text-muted hover:bg-red/10 hover:text-red disabled:opacity-40"><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-ink">Position over time — <span className="text-accent">{selected.keyword}</span></h3>
            <span className="text-xs text-muted">avg {fmtPos(selected.avgPosition)} · {selected.series.length} days with data</span>
          </CardHeader>
          <CardBody>
            {chart ? <LineChart labels={chart.labels} series={chart.series} formatValue={(v) => v.toFixed(1)} />
              : <EmptyState title="No data yet" detail="Google has no days with impressions for this keyword in the range." />}
            <div className="mt-2 flex items-start gap-1.5 text-xs text-muted">
              <Info size={13} className="mt-0.5 shrink-0" />
              <span>Lower is better (1 = top result). Days without impressions are skipped. Search Console publishes about {GSC_LAG_DAYS} days late; data refreshes nightly and whenever it is older than 12 hours.</span>
            </div>
          </CardBody>
        </Card>
      )}

      {dr.pickerOpen && <DateRangeModal preset={dr.preset} from={dr.customFrom} to={dr.customTo} onApply={dr.apply} onClose={() => dr.setPickerOpen(false)} />}
      {addOpen && <AddKeywordsModal onClose={() => setAddOpen(false)} saving={add.isPending} onAdd={(kw, country, device) => add.mutate({ kw, country, device })} />}
      <ConfirmDialog open={!!toDelete} title="Stop tracking keyword" danger confirmLabel="Remove" loading={remove.isPending}
        message={`Stop tracking "${toDelete?.keyword}"? Its history will be deleted.`} onConfirm={() => toDelete && remove.mutate(toDelete.id)} onClose={() => setToDelete(null)} />
    </div>
  );
}
