import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Zap, Facebook, Instagram, Linkedin, Youtube, Twitter, ArrowLeft } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { adsService } from '@/services/ads/ads.service';
import { socialPromotionsService } from '@/services/social/social-promotions.service';
import { useOrgStore } from '@/stores/orgStore';
import type { AdPlatformKey, BoostablePost } from '@/services/ads/ads.types';
import type { SocialBudgetType, SocialPromotionObjective } from '@/types';

const PLATFORM_ICON: Record<AdPlatformKey, typeof Facebook> = {
  facebook: Facebook, instagram: Instagram, linkedin: Linkedin, youtube: Youtube, twitter: Twitter,
};
const PLATFORM_TINT: Record<AdPlatformKey, string> = {
  facebook: 'text-blue', instagram: 'text-violet', linkedin: 'text-blue', youtube: 'text-red', twitter: 'text-blue',
};
const OBJECTIVES: SocialPromotionObjective[] = ['awareness', 'traffic', 'engagement', 'leads', 'conversions'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();

/**
 * Boost = pick a published post, then set the campaign up. Two panes in one
 * modal so the flow reads as one action; Back returns to the grid.
 */
export function BoostPostModal({ onClose, onBoosted }: { onClose: () => void; onBoosted: () => void }) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const [picked, setPicked] = useState<BoostablePost | null>(null);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState<SocialPromotionObjective>('traffic');
  const [budgetType, setBudgetType] = useState<SocialBudgetType>('daily');
  const [budget, setBudget] = useState('500');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const posts = useQuery({ queryKey: ['ads', orgId, 'boostable-posts'], queryFn: () => adsService.boostablePosts(36), enabled: !!orgId });
  const items = useMemo(() => posts.data?.items ?? [], [posts.data]);

  const choose = (p: BoostablePost) => {
    setPicked(p);
    setName(p.name || p.caption.slice(0, 60) || 'Boosted post');
    setError('');
  };

  const boost = async () => {
    const minor = Math.round(Number(budget) * 100);
    if (!name.trim()) { setError('Give the boost campaign a name.'); return; }
    if (!Number.isFinite(minor) || minor <= 0) { setError('Enter a budget greater than zero.'); return; }
    setError('');
    setSaving(true);
    try {
      await socialPromotionsService.create(orgId, {
        name: name.trim(), postId: picked?.id ?? null, objective, budgetType, budgetMinor: minor, currency,
      });
      toast.success('Boost campaign created as a draft');
      onBoosted();
    } catch (e) {
      const msg = (e as Error)?.message ?? 'Could not create the boost campaign';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open onClose={onClose} size="xl"
      title={picked ? 'Boost this post' : 'Select a Post to Boost'}
      footer={picked ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setPicked(null)}><ArrowLeft size={15} /> Back</Button>
          <Button size="sm" loading={saving} onClick={boost}><Zap size={15} /> Create boost</Button>
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
      )}
    >
      {picked ? (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-[10px] border border-line bg-surface-2/50 p-3">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-surface-2 text-[10px] text-muted">
              {picked.thumbnailUrl ? <img src={picked.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : 'No media'}
            </span>
            <span className="min-w-0">
              <span className="block text-xs text-muted">{fmtDay(picked.publishedAt)}</span>
              <span className="mt-0.5 block line-clamp-2 text-sm text-ink">{picked.caption || picked.name}</span>
            </span>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="boost-name" className="block text-xs font-semibold uppercase tracking-wide text-muted">Campaign name</label>
            <Input id="boost-name" value={name} invalid={!!error && !name.trim()} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="boost-objective" className="block text-xs font-semibold uppercase tracking-wide text-muted">Objective</label>
              <Select id="boost-objective" value={objective} onChange={(e) => setObjective(e.target.value as SocialPromotionObjective)}>
                {OBJECTIVES.map((o) => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="boost-budget-type" className="block text-xs font-semibold uppercase tracking-wide text-muted">Budget type</label>
              <Select id="boost-budget-type" value={budgetType} onChange={(e) => setBudgetType(e.target.value as SocialBudgetType)}>
                <option value="daily">Daily</option>
                <option value="lifetime">Lifetime</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="boost-budget" className="block text-xs font-semibold uppercase tracking-wide text-muted">
                {budgetType === 'daily' ? 'Budget per day' : 'Total budget'}
              </label>
              <Input id="boost-budget" type="number" min="1" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="boost-currency" className="block text-xs font-semibold uppercase tracking-wide text-muted">Currency</label>
              <Select id="boost-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </div>

          {error && <p className="text-sm text-red">{error}</p>}
          <p className="text-xs text-muted">
            The boost is saved as a draft campaign. It only reaches Facebook once a Meta ad account is connected —
            until then nothing is spent.
          </p>
        </div>
      ) : posts.isLoading ? <LoadingState label="Loading your published posts…" />
        : posts.isError ? <ErrorState message={(posts.error as Error)?.message ?? 'Could not load posts.'} onRetry={() => posts.refetch()} />
        : items.length === 0 ? (
          <EmptyState title="No published posts yet" detail="Publish a post from the Social composer, then come back to boost it." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((p) => (
              <button
                key={p.id} type="button" onClick={() => choose(p)}
                className="overflow-hidden rounded-[10px] border border-line bg-surface text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
              >
                <span className="relative block aspect-[4/3] bg-surface-2">
                  {p.thumbnailUrl
                    ? <img src={p.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                    : <span className="flex h-full items-center justify-center text-xs text-muted">No media</span>}
                  <span className="absolute right-2 top-2 flex gap-1 rounded-md bg-surface/90 px-1.5 py-1">
                    {p.platforms.map((k) => {
                      const Icon = PLATFORM_ICON[k];
                      return <Icon key={k} size={12} className={PLATFORM_TINT[k]} aria-label={k} />;
                    })}
                  </span>
                </span>
                <span className="block p-3">
                  <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{fmtDay(p.publishedAt)}</span>
                  <span className="mt-1 block line-clamp-2 text-xs text-ink">{p.caption || p.name}</span>
                </span>
              </button>
            ))}
          </div>
        )}
    </Modal>
  );
}
