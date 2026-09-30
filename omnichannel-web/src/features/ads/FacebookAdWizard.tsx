import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Facebook, Instagram, Zap, Megaphone, MousePointerClick, MessageSquare, UserPlus, Download,
  ShoppingBag, ImagePlus, X, AlertCircle, Info, ArrowRight, ArrowLeft, Check,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { LoadingState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { adsService } from '@/services/ads/ads.service';
import { socialPostsService } from '@/services/social/social-posts.service';
import type { AdBuyingTypeKey, AdDraft, AdDraftInput, AdObjectiveKey, AdPlatformKey } from '@/services/ads/ads.types';
import { useOrgStore } from '@/stores/orgStore';

const MAX_MEDIA = 10;

type Objective = { key: AdObjectiveKey; label: string; detail: string; Icon: typeof Megaphone; tint: string };

/** Meta's six campaign objectives, in Facebook's own order. */
const OBJECTIVES: Objective[] = [
  { key: 'awareness', label: 'Awareness', Icon: Megaphone, tint: 'text-orange',
    detail: 'Show your ads to people who are most likely to remember them.' },
  { key: 'traffic', label: 'Traffic', Icon: MousePointerClick, tint: 'text-green',
    detail: 'Send people to a destination, like your website, app, or Instagram profile.' },
  { key: 'engagement', label: 'Engagement', Icon: MessageSquare, tint: 'text-violet',
    detail: 'Get more messages, video views, post engagement, Page likes or event responses.' },
  { key: 'leads', label: 'Leads', Icon: UserPlus, tint: 'text-blue',
    detail: 'Collect leads for your business or brand via forms, calls, or registration.' },
  { key: 'app_promotion', label: 'App promotion', Icon: Download, tint: 'text-orange',
    detail: 'Find new people to install your app and continue using it.' },
  { key: 'sales', label: 'Sales', Icon: ShoppingBag, tint: 'text-blue',
    detail: 'Find people likely to purchase your goods or services.' },
];

const CTA_OPTIONS = ['Learn more', 'Shop now', 'Sign up', 'Book now', 'Contact us', 'Get quote', 'Apply now', 'Download'];

const SECTION = 'rounded-[10px] border border-line bg-surface p-4';
const LABEL = 'block text-xs font-semibold uppercase tracking-wide text-muted';

const initials = (s: string) => s.trim().charAt(0).toUpperCase() || 'Y';

/** One feed mock. Deliberately plain: it previews the copy and media, not Facebook's chrome. */
function FeedPreview({ network, pageName, media, headline, primaryText, cta }: {
  network: 'facebook' | 'instagram';
  pageName: string; media?: string; headline?: string; primaryText?: string; cta: string;
}) {
  const Icon = network === 'facebook' ? Facebook : Instagram;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Icon size={12} /> {network} feed
      </div>
      <div className="overflow-hidden rounded-[10px] border border-line bg-surface">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
            {initials(pageName)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-ink">{pageName}</span>
            <span className="block text-[10px] text-muted">Sponsored</span>
          </span>
        </div>
        {primaryText && <p className="px-3 pb-2 text-xs text-ink line-clamp-3">{primaryText}</p>}
        <div className="flex aspect-[4/3] items-center justify-center bg-surface-2 text-xs text-muted">
          {media
            ? <img src={media} alt="" className="h-full w-full object-cover" />
            : 'No media'}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="min-w-0 truncate text-xs font-semibold text-ink">{headline || 'Post headline'}</span>
          <span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[10px] font-medium text-ink">{cta}</span>
        </div>
      </div>
    </div>
  );
}

export function FacebookAdWizard({ platform, existing, onClose, onSaved }: {
  platform: AdPlatformKey;
  existing?: AdDraft | null;
  onClose: () => void;
  onSaved: (d: AdDraft) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [adAccountId, setAdAccountId] = useState(existing?.adAccountId ?? '');
  const [pageId, setPageId] = useState(existing?.pageId ?? '');
  const [buyingType, setBuyingType] = useState<AdBuyingTypeKey>(existing?.buyingType ?? 'auction');
  const [objective, setObjective] = useState<AdObjectiveKey>(existing?.objective ?? 'awareness');
  const [name, setName] = useState(existing?.name ?? '');
  const [primaryText, setPrimaryText] = useState(existing?.primaryText ?? '');
  const [headline, setHeadline] = useState(existing?.headline ?? '');
  const [linkUrl, setLinkUrl] = useState(existing?.linkUrl ?? '');
  const [cta, setCta] = useState(existing?.callToAction ?? CTA_OPTIONS[0]);
  const [mediaUrls, setMediaUrls] = useState<string[]>(existing?.mediaUrls ?? []);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const targets = useQuery({ queryKey: ['ads', orgId, 'facebook-targets'], queryFn: () => adsService.facebookTargets(), enabled: !!orgId });
  const accounts = targets.data?.accounts ?? [];
  const pages = targets.data?.pages ?? [];
  const account = useMemo(() => accounts.find((a) => a.id === adAccountId), [accounts, adAccountId]);
  const page = useMemo(() => pages.find((p) => p.id === pageId), [pages, pageId]);
  const networkLabel = platform === 'instagram' ? 'Instagram' : 'Facebook';

  const addMedia = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_MEDIA - mediaUrls.length;
    if (room <= 0) { toast.info(`An ad can carry at most ${MAX_MEDIA} images or videos.`); return; }
    setUploading(true);
    try {
      const picked = Array.from(files).slice(0, room);
      const uploaded = await Promise.all(picked.map((f) => socialPostsService.uploadMedia('', f)));
      setMediaUrls((m) => [...m, ...uploaded.map((u) => u.url)]);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Could not upload that file');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    if (!name.trim()) { setError('Give the campaign a name.'); setStep(1); return; }
    setError('');
    setSaving(true);
    const input: AdDraftInput = {
      platform, name: name.trim(),
      adAccountId: adAccountId || null,
      pageId: pageId || null,
      buyingType, objective,
      primaryText: primaryText.trim() || null,
      headline: headline.trim() || null,
      linkUrl: linkUrl.trim() || null,
      callToAction: cta,
      mediaUrls,
    };
    try {
      const saved = existing
        ? await adsService.updateDraft('', existing.id, input)
        : await adsService.createDraft('', input);
      toast.success(existing ? 'Ad draft updated' : 'Ad draft saved');
      onSaved(saved);
    } catch (e) {
      const msg = (e as Error)?.message ?? 'Could not save the ad draft';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-2">
      {/* header */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
        <div className="flex items-center gap-2">
          {platform === 'instagram' ? <Instagram size={18} className="text-violet" /> : <Facebook size={18} className="text-blue" />}
          <h2 className="font-display text-base font-semibold text-ink">
            {existing ? 'Edit' : 'Create'} {networkLabel} Ad
          </h2>
          <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">Step {step} of 2</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close ad builder" className="rounded-lg p-1.5 text-muted hover:bg-surface-2">
          <X size={18} />
        </button>
      </div>

      {/* body: builder + feed previews */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {targets.isLoading ? <LoadingState label="Loading your Facebook ad accounts…" /> : step === 1 ? (
            <>
              {/* ── ad account ── */}
              <section className={SECTION}>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                  <Facebook size={15} className="text-blue" /> Select Facebook Ad Account
                </h3>
                <Select value={adAccountId} onChange={(e) => setAdAccountId(e.target.value)} aria-label="Ad account">
                  <option value="">Choose an ad account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.currency ? ` (${a.currency})` : ''}{a.readOnly ? ' — Read-only' : ''}
                    </option>
                  ))}
                </Select>

                {targets.data?.unavailableReason && (
                  <p className="mt-2 flex items-start gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-2.5 text-xs text-ink">
                    <Info size={14} className="mt-0.5 shrink-0 text-orange" />
                    <span>{targets.data.unavailableReason}</span>
                  </p>
                )}
                {account?.readOnly && (
                  <p className="mt-2 flex items-start gap-2 rounded-[10px] border border-red/40 bg-red/5 p-2.5 text-xs text-ink">
                    <AlertCircle size={14} className="mt-0.5 shrink-0 text-red" />
                    <span>This is a read-only account. You only have ANALYZE permission and cannot create or manage ads on it.</span>
                  </p>
                )}
                {account?.currency && (
                  <p className="mt-2 rounded-[10px] border border-line bg-surface-2/60 p-2.5 text-xs text-muted">
                    Account currency: {account.currency}. Make sure your budget is set in {account.currency}.
                  </p>
                )}
                {account && !account.active && (
                  <p className="mt-2 text-xs text-red">Facebook reports this ad account is not active.</p>
                )}
              </section>

              {/* ── page ── */}
              <section className={SECTION}>
                <h3 className={LABEL}>Select Facebook Page</h3>
                <p className="mb-3 mt-1 text-xs text-muted">
                  Choose the page on which your ad will run. The ad will be published under this page’s identity.
                </p>
                {pages.length === 0 ? (
                  <p className="text-sm text-muted">
                    No Pages available. Connect Facebook in Settings and select a Page first.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {pages.map((p) => {
                      const on = p.id === pageId;
                      return (
                        <button
                          key={p.id} type="button" onClick={() => setPageId(on ? '' : p.id)}
                          className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                            on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                          }`}
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
                            {initials(p.name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                            <span className="block truncate text-xs text-muted">
                              {p.category ? `${p.category} • ` : ''}ID: {p.id}
                            </span>
                          </span>
                          {on && (
                            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-accent">Selected</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ── buying type ── */}
              <section className={SECTION}>
                <h3 className={LABEL}>Buying type</h3>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {(['auction', 'reservation'] as const).map((k) => (
                    <button
                      key={k} type="button" onClick={() => setBuyingType(k)}
                      className={`h-11 rounded-[10px] border text-sm font-semibold uppercase tracking-wide transition-colors ${
                        buyingType === k ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2/60 text-muted hover:bg-surface-2'
                      }`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs italic text-muted">
                  {buyingType === 'auction'
                    ? 'Most common. Better for small budgets and flexibility.'
                    : 'Fixed price and predictable reach, bought in advance. Minimum spends apply.'}
                </p>
              </section>

              {/* ── objective ── */}
              <section>
                <h3 className={`${LABEL} mb-2`}>Campaign objective</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {OBJECTIVES.map((o) => {
                    const on = o.key === objective;
                    return (
                      <button
                        key={o.key} type="button" onClick={() => setObjective(o.key)}
                        className={`rounded-[10px] border p-4 text-left transition-colors ${
                          on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                        }`}
                      >
                        <o.Icon size={20} className={o.tint} />
                        <span className="mt-3 block text-sm font-semibold text-ink">{o.label}</span>
                        <span className="mt-1 block text-xs text-muted">{o.detail}</span>
                        {on && (
                          <span className="mt-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-accent">
                            <Zap size={11} /> Selected
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* ── creative ── */}
              <section className="rounded-[10px] border border-accent/40 bg-accent-soft/30 p-4">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                  <Zap size={15} className="text-accent" /> Ad creative
                </h3>

                <div className="space-y-1.5">
                  <label htmlFor="ad-name" className={LABEL}>Campaign name</label>
                  <Input id="ad-name" value={name} invalid={!!error && !name.trim()} placeholder="My Awesome Campaign"
                    onChange={(e) => setName(e.target.value)} />
                  <p className="text-xs italic text-muted">This is the name you’ll see in Ads Manager — not what people see.</p>
                </div>

                <div className="mt-4 rounded-[10px] border border-dashed border-line bg-surface p-3">
                  <p className={LABEL}>Ad media — choose up to {MAX_MEDIA} images or videos</p>
                  <p className="mt-1 text-xs text-muted">
                    For carousel and collection ads, only the first image/video appears as the primary media.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mediaUrls.map((url, i) => (
                      <span key={url + i} className="group relative h-24 w-24 overflow-hidden rounded-[10px] border border-line">
                        <img src={url} alt="" className="h-full w-full object-cover" />
                        <button
                          type="button" aria-label={`Remove media ${i + 1}`}
                          onClick={() => setMediaUrls((m) => m.filter((_, idx) => idx !== i))}
                          className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    <button
                      type="button" onClick={() => fileRef.current?.click()}
                      disabled={uploading || mediaUrls.length >= MAX_MEDIA}
                      className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-line text-muted transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ImagePlus size={18} />
                      <span className="text-[11px]">{uploading ? 'Uploading…' : `${mediaUrls.length}/${MAX_MEDIA}`}</span>
                    </button>
                    <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden"
                      onChange={(e) => addMedia(e.target.files)} />
                  </div>
                  <p className="mt-3 flex items-start gap-2 text-xs text-orange">
                    <Zap size={13} className="mt-0.5 shrink-0" />
                    <span>Media optimisation status: Not optimised — Facebook will test the best performing combination.</span>
                  </p>
                </div>

                <div className="mt-4 space-y-1.5">
                  <label htmlFor="ad-text" className={LABEL}>Primary text</label>
                  <Textarea id="ad-text" rows={3} value={primaryText} placeholder="What do you want to say to your audience?"
                    onChange={(e) => setPrimaryText(e.target.value)} />
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor="ad-headline" className={LABEL}>Headline</label>
                    <Input id="ad-headline" value={headline} placeholder="Grow your business with us"
                      onChange={(e) => setHeadline(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="ad-cta" className={LABEL}>Call to action</label>
                    <Select id="ad-cta" value={cta} onChange={(e) => setCta(e.target.value)}>
                      {CTA_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </div>
                </div>

                <div className="mt-4 space-y-1.5">
                  <label htmlFor="ad-link" className={LABEL}>Link (optional)</label>
                  <Input id="ad-link" value={linkUrl} placeholder="https://example.com/landing"
                    onChange={(e) => setLinkUrl(e.target.value)} />
                </div>
              </section>
            </>
          ) : (
            /* ── step 2: review ── */
            <section className={SECTION}>
              <h3 className="mb-4 text-sm font-semibold text-ink">Review</h3>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {[
                  ['Campaign name', name || '—'],
                  ['Network', networkLabel],
                  ['Ad account', account ? `${account.name}${account.currency ? ` (${account.currency})` : ''}` : 'Not selected'],
                  ['Page', page?.name ?? 'Not selected'],
                  ['Buying type', buyingType === 'auction' ? 'Auction' : 'Reservation'],
                  ['Objective', OBJECTIVES.find((o) => o.key === objective)?.label ?? objective],
                  ['Media', mediaUrls.length ? `${mediaUrls.length} file${mediaUrls.length === 1 ? '' : 's'}` : 'None'],
                  ['Call to action', cta],
                  ['Link', linkUrl || 'None'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className={LABEL}>{k}</dt>
                    <dd className="mt-0.5 text-sm text-ink">{v}</dd>
                  </div>
                ))}
              </dl>

              {/* The text is one <span>: in a flex row every child — including an
                  inline <code> — becomes its own flex item and the sentence breaks apart. */}
              <p className="mt-5 flex items-start gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-3 text-xs text-ink">
                <Info size={14} className="mt-0.5 shrink-0 text-orange" />
                <span>
                  Saving stores this as an ad draft in Green Start. Creating the ad on Facebook needs the Meta
                  Marketing API (the <code className="rounded bg-surface-2 px-1">ads_management</code> permission,
                  app review and a funded ad account), which isn’t enabled on this workspace — so nothing is sent
                  to Facebook and no budget is spent.
                </span>
              </p>
              {error && <p className="mt-3 text-sm text-red">{error}</p>}
            </section>
          )}
        </div>

        {/* feed previews */}
        <aside className="hidden w-[280px] shrink-0 overflow-y-auto rounded-[10px] border border-line bg-surface p-3 xl:block">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Feed previews</p>
          <div className="space-y-4">
            <FeedPreview network="facebook" pageName={page?.name ?? 'Your Page'} media={mediaUrls[0]}
              headline={headline} primaryText={primaryText} cta={cta} />
            <FeedPreview network="instagram" pageName={page?.name ?? 'Your Page'} media={mediaUrls[0]}
              headline={headline} primaryText={primaryText} cta={cta} />
          </div>
        </aside>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between gap-3 border-t border-line bg-surface px-5 py-3">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <div className="flex items-center gap-2">
          {step === 2 && (
            <Button variant="ghost" size="sm" onClick={() => setStep(1)}><ArrowLeft size={15} /> Back</Button>
          )}
          {step === 1 ? (
            <Button size="sm" onClick={() => setStep(2)}>Next <ArrowRight size={15} /></Button>
          ) : (
            <Button size="sm" loading={saving} onClick={save}><Check size={15} /> Save draft</Button>
          )}
        </div>
      </div>
    </div>
  );
}
