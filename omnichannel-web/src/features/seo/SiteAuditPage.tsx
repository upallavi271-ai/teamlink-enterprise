import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Eye, Trash2, ExternalLink, AlertTriangle, Smartphone, Monitor, Info } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useCan } from '@/features/auth/useCan';
import { toast } from '@/components/toast/toastStore';
import { seoService } from '@/services/seo/seo.service';
import type { AuditStrategy, AuditCheck, CheckStatus, PsiResult, SeoAudit, SeoAuditRow } from '@/services/seo/seo.types';
import { useOrgStore } from '@/stores/orgStore';

// ── helpers ──────────────────────────────────────────────────────────────────
type Tone = 'green' | 'orange' | 'red' | 'neutral' | 'blue';
const scoreTone = (s: number | null | undefined): Tone => (s == null ? 'neutral' : s >= 80 ? 'green' : s >= 50 ? 'orange' : 'red');
const scoreColor: Record<Tone, string> = { green: 'text-green', orange: 'text-orange', red: 'text-red', neutral: 'text-muted', blue: 'text-blue' };
const ringStroke: Record<Tone, string> = { green: 'var(--green)', orange: 'var(--orange)', red: 'var(--red)', neutral: 'var(--line)', blue: 'var(--blue)' };
const STATUS_TONE: Record<CheckStatus, Tone> = { pass: 'green', warn: 'orange', fail: 'red', info: 'blue' };
const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'Pass', warn: 'Improve', fail: 'Fix', info: 'Info' };
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ms = (v?: number) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** Core Web Vitals thresholds (Google's "good / needs improvement / poor"). */
const cwvTone = (metric: 'lcp' | 'cls' | 'tbt' | 'inp', v?: number): Tone => {
  if (v == null) return 'neutral';
  const [good, poor] = metric === 'lcp' ? [2500, 4000] : metric === 'cls' ? [0.1, 0.25] : metric === 'tbt' ? [200, 600] : [200, 500];
  return v <= good ? 'green' : v <= poor ? 'orange' : 'red';
};

function ScoreRing({ value, label, size = 120 }: { value: number | null | undefined; label: string; size?: number }) {
  const tone = scoreTone(value);
  const r = (size - 12) / 2, c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${value ?? 'not available'}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={10} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringStroke[tone]} strokeWidth={10} strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className={`fill-current font-display text-2xl font-semibold ${scoreColor[tone]}`}>
          {value == null ? '—' : value}
        </text>
      </svg>
      <span className="text-xs font-medium text-muted">{label}</span>
    </div>
  );
}

function PsiPanel({ psi }: { psi: PsiResult | null }) {
  if (!psi || !psi.available) {
    return (
      <div className="flex items-start gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-3 text-sm">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" />
        <div>
          <div className="font-medium text-ink">Google PageSpeed data not available for this run</div>
          <div className="text-xs text-muted">{psi?.reason ?? 'PageSpeed did not answer.'} The on-page checks above are unaffected.</div>
        </div>
      </div>
    );
  }
  const s = psi.scores ?? {}, lab = psi.lab ?? {};
  const metric = (label: string, value: string, tone: Tone, hint: string) => (
    <div key={label} className="rounded-[10px] border border-line p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 font-display text-lg font-semibold ${scoreColor[tone]}`}>{value}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-around gap-4">
        <ScoreRing value={s.performance} label="Performance" size={96} />
        <ScoreRing value={s.seo} label="SEO" size={96} />
        <ScoreRing value={s.accessibility} label="Accessibility" size={96} />
        <ScoreRing value={s.bestPractices} label="Best practices" size={96} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {metric('LCP', ms(lab.lcpMs), cwvTone('lcp', lab.lcpMs), 'Largest Contentful Paint · good ≤ 2.5 s')}
        {metric('CLS', lab.cls == null ? '—' : lab.cls.toFixed(3), cwvTone('cls', lab.cls), 'Cumulative Layout Shift · good ≤ 0.1')}
        {metric('TBT', ms(lab.tbtMs), cwvTone('tbt', lab.tbtMs), 'Total Blocking Time · good ≤ 200 ms')}
      </div>
      {psi.field?.overall && (
        <div className="text-xs text-muted">
          Real-user data (Chrome UX Report): <b className="text-ink">{psi.field.overall.replace('_', ' ').toLowerCase()}</b>
          {psi.field.inpMs != null && <> · INP {ms(psi.field.inpMs)}</>}
          {psi.field.lcpMs != null && <> · LCP {ms(psi.field.lcpMs)}</>}
        </div>
      )}
      <div className="text-[11px] text-muted">Lab data from Google PageSpeed Insights ({psi.strategy}) · {fmtDate(psi.fetchedAt)}</div>
    </div>
  );
}

function AuditResult({ audit }: { audit: SeoAudit }) {
  const [issuesOnly, setIssuesOnly] = useState(false);
  const checks = issuesOnly ? audit.checks.filter((c) => c.status === 'warn' || c.status === 'fail') : audit.checks;
  const counts = useMemo(() => audit.checks.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + 1 }), {} as Partial<Record<CheckStatus, number>>), [audit.checks]);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader><h3 className="text-sm font-semibold text-ink">On-page score</h3><Badge tone={audit.strategy === 'mobile' ? 'blue' : 'neutral'}>{audit.strategy}</Badge></CardHeader>
        <CardBody className="flex flex-col items-center gap-3">
          <ScoreRing value={audit.score} label="out of 100" size={140} />
          <div className="flex flex-wrap justify-center gap-1.5">
            {counts.pass ? <Badge tone="green">{counts.pass} pass</Badge> : null}
            {counts.warn ? <Badge tone="orange">{counts.warn} improve</Badge> : null}
            {counts.fail ? <Badge tone="red">{counts.fail} fix</Badge> : null}
          </div>
          <a href={audit.finalUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-xs text-accent hover:underline">
            <ExternalLink size={12} /> <span className="truncate">{audit.finalUrl}</span>
          </a>
          <div className="w-full space-y-1 border-t border-line pt-3 text-xs text-muted">
            <div className="flex justify-between"><span>Audited</span><span className="text-ink">{fmtDate(audit.createdAt)}</span></div>
            <div className="flex justify-between"><span>HTTP status</span><span className="text-ink">{audit.httpStatus}</span></div>
            <div className="flex justify-between"><span>Words</span><span className="text-ink">{audit.summary.wordCount}</span></div>
            <div className="flex justify-between"><span>Images / no alt</span><span className="text-ink">{audit.summary.images} / {audit.summary.imagesWithoutAlt}</span></div>
            <div className="flex justify-between"><span>Links in / out</span><span className="text-ink">{audit.summary.internalLinks} / {audit.summary.externalLinks}</span></div>
          </div>
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><h3 className="text-sm font-semibold text-ink">Google PageSpeed</h3></CardHeader>
        <CardBody><PsiPanel psi={audit.psi} /></CardBody>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <h3 className="text-sm font-semibold text-ink">Checks</h3>
          <div className="flex gap-1 rounded-[10px] bg-surface-2 p-0.5 text-xs">
            <button type="button" onClick={() => setIssuesOnly(false)} className={`rounded-lg px-2.5 py-1 ${!issuesOnly ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}>All ({audit.checks.length})</button>
            <button type="button" onClick={() => setIssuesOnly(true)} className={`rounded-lg px-2.5 py-1 ${issuesOnly ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}>Issues ({(counts.warn ?? 0) + (counts.fail ?? 0)})</button>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-left text-xs font-semibold text-muted">
                <th className="px-4 py-3">Status</th><th className="px-4 py-3">Check</th><th className="px-4 py-3">Found</th><th className="px-4 py-3">What to do</th>
              </tr>
            </thead>
            <tbody>
              {checks.length === 0 ? (
                <tr><td colSpan={4}><EmptyState title="No issues found" detail="Every check passed." /></td></tr>
              ) : checks.map((c: AuditCheck) => (
                <tr key={c.key} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge></td>
                  <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">{c.label}</td>
                  <td className="max-w-xs px-4 py-3 text-muted"><span className="line-clamp-2 break-words">{c.found}</span></td>
                  <td className="px-4 py-3 text-ink">{c.advice}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export function SiteAuditPage() {
  const qc = useQueryClient();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canRun = useCan('content.manage');
  const [url, setUrl] = useState('');
  const [strategy, setStrategy] = useState<AuditStrategy>('mobile');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<SeoAuditRow | null>(null);
  const PAGE_SIZE = 10;

  const status = useQuery({ queryKey: ['seo', orgId, 'status'], queryFn: () => seoService.status(), enabled: !!orgId });
  const history = useQuery({ queryKey: ['seo', orgId, 'audits', page], queryFn: () => seoService.listAudits(page, PAGE_SIZE), enabled: !!orgId });
  const selected = useQuery({ queryKey: ['seo', orgId, 'audit', selectedId], queryFn: () => seoService.getAudit(selectedId as string), enabled: !!orgId && !!selectedId });

  const run = useMutation({
    mutationFn: () => seoService.runAudit(url.trim(), strategy),
    onSuccess: (a) => {
      toast.success(`Audit finished — score ${a.score}/100`);
      qc.setQueryData(['seo', orgId, 'audit', a.id], a);
      setSelectedId(a.id); setPage(1);
      qc.invalidateQueries({ queryKey: ['seo', orgId, 'audits'] });
    },
    onError: (e: Error) => toast.error(e?.message ?? 'Audit failed'),
  });
  const del = useMutation({
    mutationFn: (id: string) => seoService.deleteAudit(id),
    onSuccess: (_r, id) => {
      toast.success('Audit deleted'); setToDelete(null);
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['seo', orgId, 'audits'] });
    },
    onError: (e: Error) => toast.error(e?.message ?? 'Delete failed'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!/^https?:\/\//i.test(v)) { toast.error('Enter the full address, starting with https://'); return; }
    run.mutate();
  };

  const rows = history.data?.items ?? [];
  const total = history.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ps = status.data?.pageSpeed;

  return (
    <div>
      <PageHeader title="Site Audit" subtitle="Check any public page for on-page SEO problems and Google PageSpeed scores"
        actions={<RefreshButton keys={['seo']} />} />

      <Card className="mb-4">
        <CardBody>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-xs font-medium text-muted" htmlFor="seo-url">Page URL</label>
              <Input id="seo-url" placeholder="https://www.example.com/" value={url} onChange={(e) => setUrl(e.target.value)} disabled={run.isPending} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted" htmlFor="seo-strategy">Device</label>
              <Select id="seo-strategy" className="!w-36" value={strategy} onChange={(e) => setStrategy(e.target.value as AuditStrategy)} disabled={run.isPending}>
                <option value="mobile">Mobile</option><option value="desktop">Desktop</option>
              </Select>
            </div>
            <Button type="submit" loading={run.isPending} disabled={!canRun || !url.trim()}>
              {strategy === 'mobile' ? <Smartphone size={15} /> : <Monitor size={15} />} Run Audit
            </Button>
          </form>
          <div className="mt-2 flex items-start gap-1.5 text-xs text-muted">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Fetches the page from the server, runs 15 on-page checks, and asks Google PageSpeed Insights for lab scores (takes up to a minute).
              {ps && !ps.enabled && ' PageSpeed is disabled on this server.'}
              {ps?.enabled && !ps.keyed && ' PageSpeed is running without an API key — Google allows only a few runs per day; add PAGESPEED_API_KEY to lift the limit.'}
              {!canRun && ' You need the "content.manage" permission to run audits.'}
            </span>
          </div>
        </CardBody>
      </Card>

      {run.isPending ? (
        <Card className="mb-4"><LoadingState label="Fetching the page and waiting for Google PageSpeed… this can take up to a minute." /></Card>
      ) : selectedId && selected.isLoading ? (
        <Card className="mb-4"><LoadingState label="Loading audit…" /></Card>
      ) : selectedId && selected.isError ? (
        <Card className="mb-4"><ErrorState message="Could not load this audit." onRetry={() => selected.refetch()} /></Card>
      ) : selected.data ? (
        <div className="mb-4"><AuditResult audit={selected.data} /></div>
      ) : null}

      <Card>
        <CardHeader><h3 className="text-sm font-semibold text-ink">Audit history</h3><span className="text-xs text-muted">Total {total}</span></CardHeader>
        {history.isLoading ? <LoadingState label="Loading audits…" />
          : history.isError ? <ErrorState message="Could not load audit history." onRetry={() => history.refetch()} />
          : rows.length === 0 ? <EmptyState title="No audits yet" detail="Enter a page URL above and run your first audit." />
          : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2/60 text-left text-xs font-semibold text-muted">
                    <th className="px-4 py-3">Page</th><th className="px-4 py-3">Device</th><th className="px-4 py-3">On-page</th><th className="px-4 py-3">PageSpeed</th><th className="px-4 py-3">HTTP</th><th className="px-4 py-3">Audited</th><th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={`border-b border-line last:border-0 hover:bg-surface-2/60 ${r.id === selectedId ? 'bg-accent-soft/40' : ''}`}>
                      <td className="max-w-md px-4 py-3"><button type="button" className="truncate text-left font-medium text-ink hover:underline" onClick={() => setSelectedId(r.id)}>{r.finalUrl}</button></td>
                      <td className="px-4 py-3"><Badge tone={r.strategy === 'mobile' ? 'blue' : 'neutral'}>{r.strategy}</Badge></td>
                      <td className={`px-4 py-2.5 font-semibold ${scoreColor[scoreTone(r.score)]}`}>{r.score}</td>
                      <td className={`px-4 py-2.5 font-semibold ${scoreColor[scoreTone(r.psiScore)]}`}>{r.psiScore ?? '—'}</td>
                      <td className="px-4 py-3 text-muted">{r.httpStatus}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{fmtDate(r.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button type="button" onClick={() => setSelectedId(r.id)} title="View" aria-label="View audit" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"><Eye size={15} /></button>
                          {canRun && <button type="button" onClick={() => { setUrl(r.url); setStrategy(r.strategy); }} title="Re-run" aria-label="Re-run audit" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"><Play size={15} /></button>}
                          {canRun && <button type="button" onClick={() => setToDelete(r)} title="Delete" aria-label="Delete audit" className="rounded-lg p-1.5 text-muted hover:bg-red/10 hover:text-red"><Trash2 size={15} /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-muted">
              <span>Page {page} of {pageCount}</span>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog open={!!toDelete} title="Delete audit" danger confirmLabel="Delete" loading={del.isPending}
        message={`Delete the audit of ${toDelete?.finalUrl}?`} onConfirm={() => toDelete && del.mutate(toDelete.id)} onClose={() => setToDelete(null)} />
    </div>
  );
}
