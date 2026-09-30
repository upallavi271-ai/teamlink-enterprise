import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, RefreshCw, Plus, Zap, ChevronDown, Facebook, Instagram, Linkedin, Youtube, Twitter,
  Pencil, Trash2, Info,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { useCan } from '@/features/auth/useCan';
import { toast } from '@/components/toast/toastStore';
import { PageHeader } from '@/components/layout/PageHeader';
import { adsService } from '@/services/ads/ads.service';
import { useOrgStore } from '@/stores/orgStore';
import { BoostPostModal } from './BoostPostModal';
import { FacebookAdWizard } from './FacebookAdWizard';
import type { AdDraft, AdPlatformKey, BoostCampaign } from '@/services/ads/ads.types';

const PLATFORMS: { key: AdPlatformKey; label: string; Icon: typeof Facebook; tint: string }[] = [
  { key: 'facebook', label: 'Facebook Ad', Icon: Facebook, tint: 'text-blue' },
  { key: 'instagram', label: 'Instagram Ad', Icon: Instagram, tint: 'text-violet' },
  { key: 'linkedin', label: 'LinkedIn Ad', Icon: Linkedin, tint: 'text-blue' },
  { key: 'youtube', label: 'YouTube Ad', Icon: Youtube, tint: 'text-red' },
  { key: 'twitter', label: 'X / Twitter Ad', Icon: Twitter, tint: 'text-ink' },
];

const STATUS_TONE: Record<BoostCampaign['status'], 'green' | 'blue' | 'orange' | 'neutral' | 'red'> = {
  active: 'green', scheduled: 'blue', paused: 'orange', completed: 'neutral',
  draft: 'neutral', failed: 'red', cancelled: 'neutral',
};

const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(0)}`;
  }
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export function AdsManagerPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('social.publish');
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [menuOpen, setMenuOpen] = useState(false);
  const [boostOpen, setBoostOpen] = useState(false);
  const [wizard, setWizard] = useState<{ platform: AdPlatformKey; draft: AdDraft | null } | null>(null);
  const [toDelete, setToDelete] = useState<AdDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', esc); };
  }, [menuOpen]);

  const overview = useQuery({
    queryKey: ['ads', orgId, 'overview'], queryFn: () => adsService.overview(orgId), enabled: !!orgId,
  });
  const platforms = useQuery({
    queryKey: ['ads', orgId, 'platforms'], queryFn: () => adsService.platforms(), enabled: !!orgId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ads', orgId] });
  const refresh = async () => { await invalidate(); toast.success('Refreshed'); };

  const campaigns = overview.data?.boostCampaigns ?? [];
  const drafts = overview.data?.recentDrafts ?? [];
  const state = (k: AdPlatformKey) => platforms.data?.find((p) => p.key === k);

  const openWizard = (key: AdPlatformKey) => {
    setMenuOpen(false);
    const s = state(key);
    if (s && !s.builder) {
      toast.info(`${PLATFORMS.find((p) => p.key === key)?.label} isn’t built yet — Facebook and Instagram are the networks Green Start can build ads for today.`);
      return;
    }
    setWizard({ platform: key, draft: null });
  };

  const removeDraft = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await adsService.removeDraft(orgId, toDelete.id);
      toast.success('Ad draft deleted');
      setToDelete(null);
      invalidate();
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Could not delete the draft');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {/* header */}
      <PageHeader
        title={<><BarChart3 size={20} className="text-accent" /> Ads Manager</>}
        actions={<>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={overview.isFetching}>
            <RefreshCw size={15} className={overview.isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
          <Button size="sm" onClick={() => navigate('/app/social')}>
            <Plus size={15} /> Create New Post
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setBoostOpen(true)}>
              <Zap size={15} /> Boost Post
            </Button>
          )}
          {canManage && (
            <div ref={menuRef} className="relative">
              <Button size="sm" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-haspopup="menu">
                <Plus size={15} /> Create Ad <ChevronDown size={14} />
              </Button>
              {menuOpen && (
                <div role="menu" className="absolute right-0 z-20 mt-1 w-52 rounded-[10px] border border-line bg-surface p-1 shadow-card">
                  {PLATFORMS.map(({ key, label, Icon, tint }) => {
                    const s = state(key);
                    return (
                      <button
                        key={key} type="button" role="menuitem" onClick={() => openWizard(key)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-2"
                      >
                        <Icon size={15} className={tint} />
                        <span className="flex-1">{label}</span>
                        {s && !s.builder && <span className="text-[10px] uppercase tracking-wide text-muted">Soon</span>}
                        {s?.builder && !s.connected && <span className="text-[10px] uppercase tracking-wide text-orange">Connect</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>}
      />

      {/* boost campaigns */}
      <Card className="overflow-hidden">
        {overview.isLoading ? <LoadingState label="Loading campaigns…" />
          : overview.isError ? <ErrorState message={(overview.error as Error)?.message ?? 'Could not load Ads Manager.'} onRetry={() => overview.refetch()} />
          : campaigns.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-base text-ink">No active or recently completed boost campaigns found.</p>
              <p className="mt-1.5 text-sm text-muted">Start boosting a post to see performance metrics here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2/50 text-left text-xs font-semibold uppercase tracking-wide text-ink">
                    <th className="px-4 py-3">Campaign</th>
                    <th className="px-4 py-3">Objective</th>
                    <th className="px-4 py-3">Budget</th>
                    <th className="px-4 py-3">Runs</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{c.name}</div>
                        {c.lastError && <div className="text-xs text-red">{c.lastError}</div>}
                      </td>
                      <td className="px-4 py-3 text-muted">{cap(c.objective)}</td>
                      <td className="px-4 py-3 text-muted">
                        {money(c.budgetMinor, c.currency)} <span className="text-xs">/ {c.budgetType}</span>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {c.startAt ? new Date(c.startAt).toLocaleDateString() : '—'}
                        {c.endAt ? ` → ${new Date(c.endAt).toLocaleDateString()}` : ''}
                      </td>
                      <td className="px-4 py-3"><Badge tone={STATUS_TONE[c.status]}>{cap(c.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      {/* ad drafts — only once there are any, so the page matches the reference when empty */}
      {drafts.length > 0 && (
        <Card className="mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Ad drafts</h2>
            <span className="text-xs text-muted">{overview.data?.draftCount ?? drafts.length} total</span>
          </div>
          <ul className="divide-y divide-line">
            {drafts.map((d) => {
              const meta = PLATFORMS.find((p) => p.key === d.platform);
              const Icon = meta?.Icon ?? Facebook;
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Icon size={16} className={meta?.tint ?? 'text-muted'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{d.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {cap(d.objective)} • {cap(d.buyingType)}
                      {d.pageName ? ` • ${d.pageName}` : ''}
                      {d.mediaUrls.length ? ` • ${d.mediaUrls.length} media` : ''}
                    </span>
                  </span>
                  <Badge tone={d.status === 'launched' ? 'green' : d.status === 'failed' ? 'red' : 'neutral'}>{cap(d.status)}</Badge>
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" aria-label={`Edit ${d.name}`}
                        onClick={() => setWizard({ platform: d.platform, draft: d })}>
                        <Pencil size={15} />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete ${d.name}`} onClick={() => setToDelete(d)}>
                        <Trash2 size={15} />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {overview.data && !overview.data.adsConfigured && (
        <p className="mt-4 flex items-start gap-2 text-xs text-muted">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            Paid delivery isn’t configured on this workspace, so boosts and ads are saved as drafts and nothing is
            spent. Connecting a Meta ad account turns launching on.
          </span>
        </p>
      )}

      {boostOpen && (
        <BoostPostModal onClose={() => setBoostOpen(false)} onBoosted={() => { setBoostOpen(false); invalidate(); }} />
      )}
      {wizard && (
        <FacebookAdWizard
          platform={wizard.platform}
          existing={wizard.draft}
          onClose={() => setWizard(null)}
          onSaved={() => { setWizard(null); invalidate(); }}
        />
      )}
      <ConfirmDialog
        open={!!toDelete} title="Delete ad draft" danger confirmLabel="Delete" loading={deleting}
        message={`Delete "${toDelete?.name}"? Nothing was sent to Facebook, so nothing is cancelled.`}
        onConfirm={removeDraft} onClose={() => setToDelete(null)}
      />
    </div>
  );
}
