import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Trash2, Pencil, Facebook, Instagram, Linkedin, Twitter, Youtube, AtSign,
  X, Image as ImageIcon, Video, Sparkles, Images, SlidersHorizontal, Send, Clock,
  AlertTriangle, ThumbsUp, MessageCircle, Share2, Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Pagination } from '@/components/ui/Pagination';
import { Tabs } from '@/components/ui/Tabs';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { socialService } from '@/services/social/social.service';
import { socialPostsService } from '@/services/social/social-posts.service';
import { SocialAudiences } from './SocialAudiences';
import { SocialPromotions } from './SocialPromotions';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import type {
  SocialAccount, SocialCapabilities, SocialPlatform, SocialPost, SocialPostInput,
  SocialPostMediaInput, SocialProviderStatus,
} from '@/types';

// Visual platform set (Threads is display-only; the backend publishes to FB/IG/LinkedIn).
type PlatKey = SocialPlatform | 'THREADS';
type PlatDef = { key: PlatKey; label: string; icon: LucideIcon; brand: string };
const PLATFORMS: PlatDef[] = [
  { key: 'FACEBOOK', label: 'Facebook', icon: Facebook, brand: '#1877F2' },
  { key: 'INSTAGRAM', label: 'Instagram', icon: Instagram, brand: '#E4405F' },
  { key: 'LINKEDIN', label: 'LinkedIn', icon: Linkedin, brand: '#0A66C2' },
  { key: 'THREADS', label: 'Threads', icon: AtSign, brand: '#111111' },
  { key: 'TWITTER', label: 'X (Twitter)', icon: Twitter, brand: '#111111' },
  { key: 'YOUTUBE', label: 'YouTube', icon: Youtube, brand: '#FF0000' },
];
const platDef = (k: PlatKey) => PLATFORMS.find((p) => p.key === k)!;
const TEXT_MAX = 5000;

const statusTone = (s: string) =>
  (s === 'published' ? 'green' : s === 'failed' ? 'red' : s === 'scheduled' || s === 'publishing' ? 'blue'
    : s === 'partially_published' ? 'orange' : 'neutral') as 'green' | 'red' | 'blue' | 'orange' | 'neutral';

// ── Page ──────────────────────────────────────────────────────────────────────
export function SocialPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canPublish = useCan('social.publish');
  const [tab, setTab] = useState<'posts' | 'audiences' | 'promotions'>('posts');

  if (!canPublish) {
    return (
      <div>
        <PageHeader title="Social Media Management" subtitle="Create, schedule, and manage posts across all platforms" />
        <Card><EmptyState title="No access" detail="You need the social.publish permission to work with social posts." /></Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Social Media Management" subtitle="Create, schedule, and manage posts across all platforms" />
      <Tabs tabs={[{ key: 'posts', label: 'Posts' }, { key: 'audiences', label: 'Audiences' }, { key: 'promotions', label: 'Promotions' }]}
        active={tab} onChange={(k) => setTab(k as typeof tab)} />
      {tab === 'audiences' ? <div className="pt-4"><SocialAudiences orgId={orgId} /></div>
        : tab === 'promotions' ? <div className="pt-4"><SocialPromotions orgId={orgId} /></div>
        : <div className="pt-4"><SocialPosts orgId={orgId} /></div>}
    </div>
  );
}

// ── Posts tab: composer + list ────────────────────────────────────────────────
function SocialPosts({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const lp = useListParams({ pageSize: 10 });
  const [subTab, setSubTab] = useState<'posted' | 'scheduled'>('posted');
  const [editing, setEditing] = useState<SocialPost | null>(null);
  const [toDelete, setToDelete] = useState<SocialPost | null>(null);

  const accountsQ = useQuery({ queryKey: ['social-accounts', orgId], queryFn: () => socialService.accounts(orgId), enabled: !!orgId });
  const providersQ = useQuery({ queryKey: ['social-providers', orgId], queryFn: () => socialService.providers(orgId), enabled: !!orgId });
  const postsQ = useQuery({ queryKey: ['social-posts', orgId, lp.params], queryFn: () => socialPostsService.list(orgId, lp.params), enabled: !!orgId });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['social-posts', orgId] });
  const remove = useMutation({ mutationFn: (id: string) => socialPostsService.remove(orgId, id), onSuccess: invalidate });
  const publishM = useMutation({ mutationFn: (id: string) => socialPostsService.publish(orgId, id), onSuccess: invalidate });
  const cancelM = useMutation({ mutationFn: (id: string) => socialPostsService.cancel(orgId, id), onSuccess: invalidate });

  const accounts = accountsQ.data ?? [];
  const providers = providersQ.data ?? [];

  const rows = postsQ.data?.items ?? [];
  const posted = rows.filter((p) => ['published', 'partially_published', 'failed', 'publishing'].includes(p.status));
  const scheduled = rows.filter((p) => ['scheduled', 'draft'].includes(p.status));
  const shown = subTab === 'posted' ? posted : scheduled;

  return (
    <div className="space-y-5">
      <Composer
        orgId={orgId} accounts={accounts} providers={providers} editing={editing}
        onDone={() => { setEditing(null); invalidate(); }}
      />

      {/* Posts list */}
      <Card>
        <div className="flex items-center justify-between gap-2 border-b border-line p-3">
          <div className="font-display font-semibold text-ink">Posts</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <Tabs tabs={[{ key: 'posted', label: `Posted${posted.length ? ` (${posted.length})` : ''}` }, { key: 'scheduled', label: `Scheduled${scheduled.length ? ` (${scheduled.length})` : ''}` }]}
            active={subTab} onChange={(k) => setSubTab(k as typeof subTab)} />
          <Select className="h-9 !w-20" value={String(lp.pageSize)} onChange={() => { /* fixed page size */ }} disabled>
            <option>{lp.pageSize}</option>
          </Select>
        </div>
        {postsQ.isLoading ? <LoadingState /> : postsQ.isError ? <ErrorState onRetry={() => postsQ.refetch()} />
          : shown.length === 0 ? <EmptyState title={`No ${subTab} posts`} detail="Compose a post above to get started." />
          : (
            <div>
              <ul className="divide-y divide-line">
                {shown.map((p) => <PostRow key={p.id} post={p}
                  onEdit={() => { setEditing(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  onDelete={() => setToDelete(p)}
                  onPublish={() => publishM.mutateAsync(p.id).then(() => toast.success('Publishing…')).catch((e) => toast.error(e?.message ?? 'Publish failed'))}
                  onCancel={() => cancelM.mutateAsync(p.id).then(() => toast.success('Cancelled')).catch((e) => toast.error(e?.message ?? 'Cancel failed'))}
                />)}
              </ul>
              <Pagination page={lp.page} pageSize={lp.pageSize} total={postsQ.data?.total ?? 0} onPage={lp.setPage} />
            </div>
          )}
      </Card>

      <ConfirmDialog open={!!toDelete} title="Delete post" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete "${toDelete?.name}"?`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id).then(() => { toast.success('Post deleted'); setToDelete(null); }).catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </div>
  );
}

function PostRow({ post, onEdit, onDelete, onPublish, onCancel }: {
  post: SocialPost; onEdit: () => void; onDelete: () => void; onPublish: () => void; onCancel: () => void;
}) {
  const firstImg = post.media.find((m) => m.type === 'IMAGE');
  const platforms = [...new Set(post.targets.map((t) => t.platform))];
  const when = post.scheduledAt ?? post.publishedAt ?? post.updatedAt;
  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
      <div className="min-w-[110px]">
        <div className="text-sm font-semibold text-ink">Post #{post.id.slice(-4)}</div>
        <div className="flex items-center gap-1 text-xs text-muted"><Clock size={11} /> {new Date(when).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      {firstImg
        ? <img src={firstImg.url} alt="" className="h-10 w-14 shrink-0 rounded-[6px] border border-line object-cover" />
        : <span className="grid h-10 w-14 shrink-0 place-items-center rounded-[6px] border border-line bg-surface-2 text-muted"><ImageIcon size={15} /></span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{post.caption || post.name || '—'}</div>
        <Badge tone={statusTone(post.status)}>{post.status.replace('_', ' ')}</Badge>
      </div>
      <div className="flex items-center gap-1 text-muted">
        {platforms.map((p) => { const I = platDef(p as PlatKey)?.icon ?? Share2; return <span key={p} title={p}><I size={15} /></span>; })}
      </div>
      <div className="flex items-center gap-1">
        {['draft', 'failed', 'partially_published'].includes(post.status) && (
          <Button variant="ghost" size="sm" title="Publish now" aria-label="Publish" onClick={onPublish}><Send size={15} /></Button>
        )}
        {['scheduled', 'draft'].includes(post.status) && (
          <Button variant="ghost" size="sm" aria-label="Edit" onClick={onEdit}><Pencil size={15} /></Button>
        )}
        {['scheduled'].includes(post.status) && (
          <Button variant="ghost" size="sm" title="Cancel" aria-label="Cancel" onClick={onCancel}><X size={15} /></Button>
        )}
        <Button variant="ghost" size="sm" aria-label="Delete" onClick={onDelete}><Trash2 size={15} /></Button>
      </div>
    </li>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────
type PlatformSettings = {
  fbAlbum: string;
  igHideCounts: boolean; igLocation: string;
  xReplyTo: string; xSensitive: boolean;
  threadsReply: string; threadsHideCounts: boolean;
  ytPrivacy: string; ytCategory: string; ytTags: string;
  liVisibility: string; liNoReshare: boolean;
};
const DEFAULT_SETTINGS: PlatformSettings = {
  fbAlbum: 'timeline', igHideCounts: false, igLocation: '',
  xReplyTo: '', xSensitive: false, threadsReply: 'everyone', threadsHideCounts: false,
  ytPrivacy: 'private', ytCategory: 'people', ytTags: '', liVisibility: 'anyone', liNoReshare: false,
};

function Composer({ orgId, accounts, providers, editing, onDone }: {
  orgId: string; accounts: SocialAccount[]; providers: SocialProviderStatus[]; editing: SocialPost | null; onDone: () => void;
}) {
  const capsByPlatform = useMemo(() => {
    const m = new Map<SocialPlatform, SocialCapabilities>();
    for (const p of providers) if (p.capabilities) m.set(p.platform, p.capabilities);
    return m;
  }, [providers]);
  const accountsByPlatform = useMemo(() => {
    const m: Partial<Record<PlatKey, SocialAccount[]>> = {};
    for (const a of accounts) (m[a.platform] ??= []).push(a);
    return m;
  }, [accounts]);

  const [name, setName] = useState(editing?.name ?? '');
  const [content, setContent] = useState(editing?.caption ?? '');
  const [selPlatforms, setSelPlatforms] = useState<Set<PlatKey>>(new Set(editing?.targets.map((t) => t.platform as PlatKey) ?? []));
  const [selAccounts, setSelAccounts] = useState<Set<string>>(new Set(editing?.targets.map((t) => t.socialAccountId) ?? []));
  const [ytTitle, setYtTitle] = useState('');
  const [media, setMedia] = useState<SocialPostMediaInput[]>(editing?.media.map((m) => ({ type: m.type, url: m.url, altText: m.altText })) ?? []);
  const [settings, setSettings] = useState<PlatformSettings>(DEFAULT_SETTINGS);
  const [previewPlat, setPreviewPlat] = useState<PlatKey>('FACEBOOK');
  const [uploading, setUploading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [busy, setBusy] = useState(false);

  const platformsList = [...selPlatforms];
  const previewSelected = platformsList.includes(previewPlat) ? previewPlat : (platformsList[0] ?? 'FACEBOOK');

  const togglePlatform = (k: PlatKey) => setSelPlatforms((s) => {
    const n = new Set(s); if (n.has(k)) n.delete(k); else { n.add(k); setPreviewPlat(k); }
    return n;
  });
  const toggleAccount = (id: string) => setSelAccounts((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Which real accounts will actually be posted to.
  const chosenAccountIds = useMemo(() => {
    const ids: string[] = [];
    for (const p of selPlatforms) {
      const accs = accountsByPlatform[p] ?? [];
      if (p === 'FACEBOOK') ids.push(...accs.filter((a) => selAccounts.has(a.id)).map((a) => a.id));
      else ids.push(...accs.map((a) => a.id));
    }
    return [...new Set(ids)];
  }, [selPlatforms, selAccounts, accountsByPlatform]);

  const minLimit = platformsList.length
    ? Math.min(...platformsList.map((p) => capsByPlatform.get(p as SocialPlatform)?.maxTextLength ?? TEXT_MAX))
    : TEXT_MAX;

  const reset = () => {
    setName(''); setContent(''); setSelPlatforms(new Set()); setSelAccounts(new Set());
    setYtTitle(''); setMedia([]); setSettings(DEFAULT_SETTINGS); setShowSchedule(false); setScheduleAt('');
  };

  const onPickFile = async (kind: 'IMAGE' | 'VIDEO', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const res = await socialPostsService.uploadMedia(orgId, file);
      setMedia((m) => [...m, { type: res.type, url: res.url }]);
      toast.success('Media added');
    } catch (err) {
      toast.error((err as Error)?.message ?? 'Upload failed');
    } finally { setUploading(false); void kind; }
  };

  const buildInput = (): SocialPostInput => ({
    name: name.trim() || content.slice(0, 40) || 'Untitled post',
    caption: content, linkUrl: null, hashtags: [],
    accountIds: chosenAccountIds, media, audienceId: null,
  });

  const guard = (): boolean => {
    if (selPlatforms.size === 0) { toast.error('Select at least one platform.'); return false; }
    if (selPlatforms.has('FACEBOOK') && (accountsByPlatform.FACEBOOK?.length ?? 0) > 0 && chosenAccountIds.length === 0) {
      toast.error('Select at least one Facebook Page to post to.'); return false;
    }
    if (chosenAccountIds.length === 0) {
      toast.error('None of the selected platforms have a connected account. Connect one in Settings → Social Accounts.');
      return false;
    }
    if (content.trim().length === 0) { toast.error('Write some content first.'); return false; }
    return true;
  };

  const doPublish = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const post = editing ? await socialPostsService.update(orgId, editing.id, buildInput()) : await socialPostsService.create(orgId, buildInput());
      await socialPostsService.publish(orgId, post.id);
      toast.success('Publishing — track each account’s status in Posts below.');
      reset(); onDone();
    } catch (e) { toast.error((e as Error)?.message ?? 'Publish failed'); }
    finally { setBusy(false); }
  };

  const doSchedule = async () => {
    if (!guard()) return;
    if (!scheduleAt) { toast.error('Pick a date and time.'); return; }
    const iso = new Date(scheduleAt).toISOString();
    if (new Date(iso).getTime() <= Date.now()) { toast.error('Scheduled time must be in the future.'); return; }
    setBusy(true);
    try {
      const post = editing ? await socialPostsService.update(orgId, editing.id, buildInput()) : await socialPostsService.create(orgId, buildInput());
      await socialPostsService.schedule(orgId, post.id, iso);
      toast.success('Post scheduled.');
      reset(); onDone();
    } catch (e) { toast.error((e as Error)?.message ?? 'Schedule failed'); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="font-display text-lg font-semibold text-ink">{editing ? `Edit Post #${editing.id.slice(-4)}` : 'Create New Post'}</div>
        {editing && <Button variant="ghost" size="sm" onClick={() => { reset(); onDone(); }}>Cancel edit</Button>}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* Left: composer */}
        <div className="space-y-4">
          {/* Select platforms */}
          <div>
            <div className="mb-1.5 text-sm font-medium text-ink">Select Platforms</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PLATFORMS.map((p) => {
                const accs = accountsByPlatform[p.key] ?? [];
                const provider = providers.find((pr) => pr.platform === p.key);
                const connected = accs.length > 0;
                const label = connected ? accs[0].name : provider?.configured ? 'Connect in Settings' : 'Not available';
                const active = selPlatforms.has(p.key);
                const Icon = p.icon;
                return (
                  <button key={p.key} type="button" onClick={() => togglePlatform(p.key)}
                    className={`flex flex-col items-center gap-1 rounded-[10px] border p-3 text-center transition-colors ${active ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
                    <Icon size={18} className={active ? 'text-accent' : 'text-muted'} />
                    <span className="truncate text-[11px] font-medium text-ink">{label}</span>
                    {!connected && <span className="text-[9px] text-muted">{p.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Facebook Pages sub-panel */}
          {selPlatforms.has('FACEBOOK') && (
            <SubPanel icon={Facebook} title="Select Facebook Pages" tone="accent">
              {(accountsByPlatform.FACEBOOK?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted">No Facebook Pages connected. Connect a Page in Settings → Social Accounts.</p>
              ) : (
                <>
                  <label className="flex items-center gap-2 border-b border-line py-1.5 text-sm">
                    <Checkbox
                      checked={(accountsByPlatform.FACEBOOK ?? []).every((a) => selAccounts.has(a.id))}
                      onChange={(e) => setSelAccounts((s) => {
                        const n = new Set(s); const fb = accountsByPlatform.FACEBOOK ?? [];
                        if ((e.target as HTMLInputElement).checked) fb.forEach((a) => n.add(a.id)); else fb.forEach((a) => n.delete(a.id));
                        return n;
                      })} />
                    Select All Pages ({accountsByPlatform.FACEBOOK?.length})
                  </label>
                  {(accountsByPlatform.FACEBOOK ?? []).map((a) => (
                    <label key={a.id} className="flex items-center gap-2 py-1.5 text-sm">
                      <Checkbox checked={selAccounts.has(a.id)} onChange={() => toggleAccount(a.id)} /> {a.name}
                    </label>
                  ))}
                  {chosenAccountIds.filter((id) => (accountsByPlatform.FACEBOOK ?? []).some((a) => a.id === id)).length === 0 && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-orange"><AlertTriangle size={12} /> Please select at least one page to post to Facebook.</p>
                  )}
                </>
              )}
            </SubPanel>
          )}

          {/* LinkedIn Business Pages sub-panel */}
          {selPlatforms.has('LINKEDIN') && (
            <SubPanel icon={Linkedin} title="Select LinkedIn Business Pages" tone="accent">
              <p className="text-xs text-muted">
                {(accountsByPlatform.LINKEDIN?.length ?? 0) === 0
                  ? <>No business pages found. Posting will default to your <span className="font-medium text-ink">Personal Profile</span>.</>
                  : `${accountsByPlatform.LINKEDIN?.length} connected LinkedIn account(s) will be used.`}
              </p>
            </SubPanel>
          )}

          {/* YouTube title */}
          {selPlatforms.has('YOUTUBE') && (
            <SubPanel icon={Youtube} title="Title" tone="red">
              <Input value={ytTitle} maxLength={100} onChange={(e) => setYtTitle(e.target.value)} placeholder="Enter title for your video" />
              <div className="mt-1 flex justify-between text-xs text-muted"><span>Titles over 100 chars will be rejected by YouTube.</span><span>{ytTitle.length}/100</span></div>
            </SubPanel>
          )}

          {/* Post content */}
          <div>
            <div className="mb-1.5 text-sm font-medium text-ink">Post Content</div>
            <Textarea rows={5} value={content} maxLength={TEXT_MAX} onChange={(e) => setContent(e.target.value)} placeholder="What do you want to share with your audience?" />
            <div className="mt-1 flex items-center justify-between text-xs">
              <div className="flex flex-wrap items-center gap-3 text-muted">
                <label className="flex cursor-pointer items-center gap-1 hover:text-ink"><ImageIcon size={14} /> Add Image
                  <input type="file" accept="image/*" hidden disabled={uploading} onChange={(e) => onPickFile('IMAGE', e)} /></label>
                <label className="flex cursor-pointer items-center gap-1 hover:text-ink"><Video size={14} /> Add Video
                  <input type="file" accept="video/*" hidden disabled={uploading} onChange={(e) => onPickFile('VIDEO', e)} /></label>
                <button type="button" className="flex items-center gap-1 hover:text-ink" onClick={() => setShowAi(true)}><Sparkles size={14} /> Generate AI Content</button>
                <button type="button" className="flex items-center gap-1 hover:text-ink" onClick={() => setShowLibrary(true)}><Images size={14} /> Content Library</button>
              </div>
              <span className={content.length > minLimit ? 'text-red' : 'text-muted'}>{content.length}/{minLimit}</span>
            </div>
            {media.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {media.map((m, i) => (
                  <div key={i} className="relative">
                    {m.type === 'IMAGE'
                      ? <img src={m.url} alt="" className="h-16 w-16 rounded-[8px] border border-line object-cover" />
                      : <span className="grid h-16 w-16 place-items-center rounded-[8px] border border-line bg-surface-2 text-[10px] text-muted">VIDEO</span>}
                    <button onClick={() => setMedia((x) => x.filter((_, idx) => idx !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-ink p-0.5 text-surface" aria-label="Remove"><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* CTA row */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Button variant="secondary" size="md" onClick={() => setShowSettings(true)}><SlidersHorizontal size={15} /> Configure Post Settings</Button>
            <Button size="md" loading={busy} onClick={doPublish}><Send size={15} /> Post Now</Button>
            {showSchedule ? (
              <div className="flex items-center gap-1">
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
                  className="h-10 flex-1 rounded-[10px] border border-line bg-surface px-2 text-sm text-ink" />
                <Button size="md" loading={busy} onClick={doSchedule}>Set</Button>
              </div>
            ) : (
              <Button variant="secondary" size="md" onClick={() => setShowSchedule(true)}><Clock size={15} /> Schedule</Button>
            )}
          </div>
        </div>

        {/* Right: preview */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          {platformsList.length > 1 && (
            <div className="mb-2 flex flex-wrap justify-center gap-1">
              {platformsList.map((k) => { const I = platDef(k).icon; const on = k === previewSelected; return (
                <button key={k} type="button" onClick={() => setPreviewPlat(k)}
                  className={`grid h-8 w-8 place-items-center rounded-[8px] border ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2'}`}><I size={15} /></button>
              ); })}
            </div>
          )}
          <SocialPreview platform={previewSelected} content={content} media={media}
            account={(accountsByPlatform[previewSelected] ?? [])[0]} title={ytTitle} />
        </div>
      </div>

      {showSettings && <PlatformSettingsModal settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
      {showAi && <GenerateAiModal onClose={() => setShowAi(false)} onInsert={(text) => { setContent((c) => (c ? c + '\n\n' : '') + text); setShowAi(false); }} />}
      {showLibrary && <ContentLibraryModal onClose={() => setShowLibrary(false)} onAdd={(m) => { setMedia((x) => [...x, m]); setShowLibrary(false); }} />}
    </Card>
  );
}

function SubPanel({ icon: Icon, title, tone, children }: { icon: LucideIcon; title: string; tone: 'accent' | 'red'; children: React.ReactNode }) {
  const border = tone === 'red' ? 'border-red/30 bg-red/5' : 'border-accent/30 bg-accent-soft/40';
  return (
    <div className={`rounded-[10px] border p-3 ${border}`}>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink"><Icon size={15} className="text-accent" /> {title}</div>
      {children}
    </div>
  );
}

// ── Social phone preview ──────────────────────────────────────────────────────
function SocialPreview({ platform, content, media, account, title }: {
  platform: PlatKey; content: string; media: SocialPostMediaInput[]; account?: SocialAccount; title: string;
}) {
  const def = platDef(platform);
  const Icon = def.icon;
  const img = media.find((m) => m.type === 'IMAGE');
  const name = account?.name ?? 'Your Name';
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[28px] border-[6px] border-[#111b21] bg-white shadow-lg">
      <div className="flex items-center justify-between rounded-t-[20px] px-3 py-2 text-white" style={{ backgroundColor: def.brand }}>
        <div className="flex items-center gap-2"><Icon size={16} /><span className="text-[12px] font-semibold">{def.label}</span></div>
        <span className="text-[9px] opacity-80">Now</span>
      </div>
      <div className="min-h-[280px] p-3">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-muted"><Icon size={15} /></span>
          <div className="leading-tight"><div className="text-[12px] font-semibold text-ink">{name}</div><div className="text-[9px] text-muted">now</div></div>
        </div>
        {platform === 'YOUTUBE' && title && <div className="mt-2 text-[12px] font-semibold text-ink">{title}</div>}
        <div className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-snug text-ink">
          {content || <span className="text-muted">Write something…</span>}
        </div>
        {img && <img src={img.url} alt="" className="mt-2 w-full rounded-[8px] border border-line object-cover" />}
        <div className="mt-3 flex items-center gap-4 border-t border-line pt-2 text-[11px] text-muted">
          <span className="flex items-center gap-1"><ThumbsUp size={13} /> Like</span>
          <span className="flex items-center gap-1"><MessageCircle size={13} /> Comment</span>
          <span className="flex items-center gap-1"><Share2 size={13} /> Share</span>
        </div>
      </div>
    </div>
  );
}

// ── Platform-Specific Settings modal ──────────────────────────────────────────
function PlatformSettingsModal({ settings, onChange, onClose }: { settings: PlatformSettings; onChange: (s: PlatformSettings) => void; onClose: () => void }) {
  const [s, setS] = useState(settings);
  const set = <K extends keyof PlatformSettings>(k: K, v: PlatformSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const save = () => { onChange(s); onClose(); };
  return (
    <Modal open onClose={onClose} title="Platform-Specific Settings" size="md"
      footer={<Button size="sm" onClick={save}>Close and Save Settings</Button>}>
      <div className="space-y-3">
        <SettingsCard icon={Facebook} title="Facebook Settings">
          <Field label="Select Photo Album (Optional)">
            <Select value={s.fbAlbum} onChange={(e) => set('fbAlbum', e.target.value)}>
              <option value="timeline">Post to Timeline</option><option value="new">Create new album</option>
            </Select>
          </Field>
        </SettingsCard>
        <SettingsCard icon={Instagram} title="Instagram Settings">
          <label className="flex items-center gap-2 text-sm text-ink"><Checkbox checked={s.igHideCounts} onChange={(e) => set('igHideCounts', (e.target as HTMLInputElement).checked)} /> Hide like and view counts on this post</label>
          <Field label="Tag Location (Requires Location ID)">
            <Select value={s.igLocation} onChange={(e) => set('igLocation', e.target.value)}><option value="">Do Not Tag Location</option><option value="custom">Tag a location…</option></Select>
          </Field>
        </SettingsCard>
        <SettingsCard icon={Twitter} title="X (Twitter) Settings">
          <Field label="Reply To Tweet ID (Optional)"><Input value={s.xReplyTo} onChange={(e) => set('xReplyTo', e.target.value)} placeholder="e.g. 1735105260193235080" /></Field>
          <label className="flex items-center gap-2 text-sm text-ink"><Checkbox checked={s.xSensitive} onChange={(e) => set('xSensitive', (e.target as HTMLInputElement).checked)} /> Mark as containing sensitive content</label>
        </SettingsCard>
        <SettingsCard icon={AtSign} title="Threads (Meta) Settings">
          <Field label="Who can reply?">
            <Select value={s.threadsReply} onChange={(e) => set('threadsReply', e.target.value)}><option value="everyone">Everyone</option><option value="following">Profiles you follow</option><option value="mentioned">Mentioned only</option></Select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink"><Checkbox checked={s.threadsHideCounts} onChange={(e) => set('threadsHideCounts', (e.target as HTMLInputElement).checked)} /> Hide like and view counts on this post</label>
        </SettingsCard>
        <SettingsCard icon={Youtube} title="YouTube Settings">
          <Field label="Privacy Status">
            <Select value={s.ytPrivacy} onChange={(e) => set('ytPrivacy', e.target.value)}><option value="private">Private (Only visible to you)</option><option value="unlisted">Unlisted</option><option value="public">Public</option></Select>
          </Field>
          <Field label="Video Category">
            <Select value={s.ytCategory} onChange={(e) => set('ytCategory', e.target.value)}><option value="people">People & Blogs</option><option value="education">Education</option><option value="tech">Science & Technology</option></Select>
          </Field>
          <Field label="Tags (Comma-separated)"><Input value={s.ytTags} onChange={(e) => set('ytTags', e.target.value)} placeholder="e.g. #beginner tutorial" /></Field>
        </SettingsCard>
        <SettingsCard icon={Linkedin} title="LinkedIn Settings">
          <Field label="Post Visibility">
            <Select value={s.liVisibility} onChange={(e) => set('liVisibility', e.target.value)}><option value="anyone">Anyone</option><option value="connections">Connections only</option></Select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink"><Checkbox checked={s.liNoReshare} onChange={(e) => set('liNoReshare', (e.target as HTMLInputElement).checked)} /> Prevent post from being reshared</label>
        </SettingsCard>
      </div>
    </Modal>
  );
}

function SettingsCard({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-line p-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink"><Icon size={15} className="text-accent" /> {title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// ── Generate AI Content modal ─────────────────────────────────────────────────
const AI_TYPES = [
  { key: 'text', label: 'Text Content', icon: Sparkles },
  { key: 'image', label: 'Image Content', icon: ImageIcon },
  { key: 'voice', label: 'Voice Content', icon: MessageCircle },
  { key: 'video', label: 'Video Content', icon: Video },
  { key: 'reels', label: 'Short Reels', icon: Video },
];
function GenerateAiModal({ onClose, onInsert }: { onClose: () => void; onInsert: (text: string) => void }) {
  const [type, setType] = useState('text');
  const [desc, setDesc] = useState('');
  const generate = () => {
    if (!desc.trim()) { toast.error('Describe what you want to create.'); return; }
    if (type !== 'text') {
      toast.info('Only text drafts can be inserted here; media generation needs a connected AI provider.');
      return;
    }
    // No AI backend is connected — produce a local starter draft from the brief (clearly not real AI output).
    onInsert(desc.trim());
    toast.success('Draft inserted from your brief. (AI generation isn’t connected — this is a local starting draft.)');
  };
  return (
    <Modal open onClose={onClose} title="Generate Content with AI" size="md"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <div className="text-sm font-medium text-ink">Generate Content</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {AI_TYPES.map((t) => { const I = t.icon; const on = type === t.key; return (
            <button key={t.key} type="button" onClick={() => setType(t.key)}
              className={`flex flex-col items-center gap-1 rounded-[10px] border p-3 text-center text-[11px] ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink hover:bg-surface-2'}`}>
              <I size={16} /> {t.label}
            </button>
          ); })}
        </div>
        <Textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe what you want to create…" />
        <Button className="w-full" size="md" onClick={generate}><Sparkles size={15} /> Generate with AI</Button>
        <p className="text-xs text-muted">AI generation isn’t connected on the server yet. For now, this drops your brief in as a starting draft you can edit.</p>
      </div>
    </Modal>
  );
}

// ── Content Library modal ─────────────────────────────────────────────────────
function ContentLibraryModal({ onClose, onAdd }: { onClose: () => void; onAdd: (m: SocialPostMediaInput) => void }) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'IMAGE' | 'VIDEO'>('IMAGE');
  const add = () => {
    if (!url.trim()) { toast.error('Paste a media URL.'); return; }
    try { new URL(url); } catch { toast.error('Enter a valid URL.'); return; }
    onAdd({ type, url: url.trim() });
  };
  return (
    <Modal open onClose={onClose} title="Content Library" size="md"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Add media by URL, or use <b>Add Image / Add Video</b> to upload from your device. A full media library appears here once file storage is connected on the server.</p>
        <div className="flex gap-2">
          <Select className="h-10 !w-28" value={type} onChange={(e) => setType(e.target.value as 'IMAGE' | 'VIDEO')}><option value="IMAGE">Image</option><option value="VIDEO">Video</option></Select>
          <Input className="flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/photo.jpg" />
          <Button size="md" onClick={add}><Check size={15} /> Add</Button>
        </div>
      </div>
    </Modal>
  );
}
