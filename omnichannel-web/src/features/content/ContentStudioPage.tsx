import { useMemo, useState } from 'react';
import {
  Facebook, Send, Clock, CheckCircle2, XCircle, RotateCw, Loader2, Link2,
  AlertTriangle, PlugZap, Share2,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingState, ErrorState, EmptyState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { useCan } from '@/features/auth/useCan';
import { publishingService } from '@/services/social/publishing.service';
import {
  usePublishProviders, usePublishPosts, useFacebookConnection, useContentStudioActions,
} from './useContentStudio';
import type {
  FacebookConnectionStatus, PublishDestinationView, PublishDestStatus,
  PublishPostStatus, SocialPublishPost,
} from '@/services/social/publishing.types';

const PROVIDER_ICON: Record<string, typeof Facebook> = { facebook: Facebook };
const MAX_LEN = 63206;

export function ContentStudioPage() {
  const canView = useCan('content.manage');
  const canPublish = useCan('social.publish');

  const providersQ = usePublishProviders();
  const postsQ = usePublishPosts();
  const { createPost, cancelDestination, retryDestination } = useContentStudioActions();

  // Only offer destinations Green Start can actually publish to. Listing a
  // platform with no adapter invites a failure the user cannot act on.
  const providers = (providersQ.data ?? []).filter((p) => p.available !== false && p.configured !== false);
  const configured = providers.length > 0;

  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [scheduleAt, setScheduleAt] = useState('');

  // Default the destination selection to whatever the workspace can publish to.
  const effectiveSelected = useMemo(
    () => selected.filter((p) => providers.some((x) => x.provider === p)),
    [selected, providers],
  );

  const toggle = (provider: string) =>
    setSelected((s) => (s.includes(provider) ? s.filter((x) => x !== provider) : [...s, provider]));

  const canSubmit =
    canPublish && configured && content.trim().length > 0 && effectiveSelected.length > 0 &&
    (mode === 'now' || scheduleAt !== '') && !createPost.isPending;

  const submit = async () => {
    if (mediaUrl && !/^https:\/\//i.test(mediaUrl)) { toast.error('Media URL must start with https://'); return; }
    let scheduledAt: string | undefined;
    if (mode === 'schedule') {
      const when = new Date(scheduleAt);
      if (Number.isNaN(when.getTime())) { toast.error('Pick a valid date and time to schedule.'); return; }
      if (when.getTime() - Date.now() < 90_000) { toast.error('Schedule a time at least ~2 minutes from now, or publish now.'); return; }
      scheduledAt = when.toISOString();
    }
    try {
      let mediaAssetId: string | undefined;
      if (mediaUrl.trim()) {
        const media = await publishMedia(mediaUrl.trim());
        mediaAssetId = media;
      }
      await createPost.mutateAsync({
        content: content.trim(),
        mediaAssetId,
        destinations: effectiveSelected,
        publishNow: mode === 'now',
        scheduledAt,
      });
      toast.success(mode === 'now' ? 'Post queued for publishing.' : 'Post scheduled.');
      setContent(''); setMediaUrl(''); setSelected([]); setScheduleAt(''); setMode('now');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the post.');
    }
  };

  if (!canView) {
    return (
      <div>
        <PageHeader title="Content Studio" subtitle="Compose once, publish to every connected channel." />
        <Card><EmptyState title="No access" detail="You need the “Manage content” permission to use Content Studio." /></Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Content Studio"
        subtitle="Compose once, publish to every connected channel — each destination tracked independently."
      />

      {!configured && (
        <div className="mb-5 flex items-start gap-3 rounded-card border border-orange/30 bg-orange/10 p-4 text-sm">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-orange" />
          <div>
            <p className="font-medium text-ink">Publishing isn’t configured yet</p>
            <p className="mt-0.5 text-muted">
              No live publishing destinations are available for this workspace. Connect Facebook below and add Meta app
              credentials on the server. You can still draft a post — it just won’t go live until a real Page is connected.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Composer */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><div className="font-display font-semibold text-ink">Create post</div></CardHeader>
            <CardBody className="space-y-4">
              <Field label="Message" hint={`${content.length.toLocaleString()} / ${MAX_LEN.toLocaleString()} characters`}>
                <Textarea
                  rows={5}
                  maxLength={MAX_LEN}
                  placeholder="What do you want to share?"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </Field>

              <Field label="Image or video URL (optional)" hint="Must be a public https:// link. Reuses your Media Library server-side.">
                <div className="flex items-center gap-2">
                  <span className="text-muted"><Link2 size={16} /></span>
                  <Input
                    placeholder="https://…"
                    value={mediaUrl}
                    onChange={(e) => setMediaUrl(e.target.value)}
                    invalid={!!mediaUrl && !/^https:\/\//i.test(mediaUrl)}
                  />
                </div>
              </Field>

              <div>
                <div className="mb-2 text-sm font-medium text-ink">Destinations</div>
                {providersQ.isLoading ? <LoadingState label="Loading destinations…" />
                  : providersQ.isError ? <ErrorState message="Could not load destinations." onRetry={() => providersQ.refetch()} />
                  : !configured ? (
                    <p className="rounded-[10px] bg-surface-2 p-3 text-xs text-muted">
                      No destinations available yet. Connect a channel to publish.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {providers.map((p) => {
                        const Icon = PROVIDER_ICON[p.provider] ?? Share2;
                        const on = effectiveSelected.includes(p.provider);
                        return (
                          <label
                            key={p.provider}
                            className={`flex cursor-pointer items-center gap-3 rounded-[10px] border p-3 transition-colors ${on ? 'border-accent bg-accent/5' : 'border-line hover:bg-surface-2'}`}
                          >
                            <Checkbox checked={on} onChange={() => toggle(p.provider)} />
                            <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-surface-2 text-accent"><Icon size={17} /></span>
                            <span className="text-sm font-medium text-ink">{p.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
              </div>

              <div>
                <div className="mb-2 text-sm font-medium text-ink">When</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant={mode === 'now' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('now')}>
                    <Send size={15} /> Publish now
                  </Button>
                  <Button variant={mode === 'schedule' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('schedule')}>
                    <Clock size={15} /> Schedule
                  </Button>
                  {mode === 'schedule' && (
                    <input
                      type="datetime-local"
                      className="h-9 rounded-[10px] border border-line bg-surface px-3 text-sm text-ink"
                      value={scheduleAt}
                      onChange={(e) => setScheduleAt(e.target.value)}
                    />
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-line pt-4">
                {!canPublish
                  ? <p className="text-xs text-muted">You need the “Publish” permission to send posts.</p>
                  : <span />}
                <Button onClick={submit} loading={createPost.isPending} disabled={!canSubmit}>
                  {mode === 'now' ? 'Publish' : 'Schedule'}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Facebook connection */}
        <div>
          <FacebookPanel />
        </div>
      </div>

      {/* Recent posts */}
      <div className="mt-8">
        <div className="mb-3 font-display text-lg font-semibold text-ink">Recent posts</div>
        {postsQ.isLoading ? <LoadingState label="Loading posts…" />
          : postsQ.isError ? <ErrorState message="Could not load posts." onRetry={() => postsQ.refetch()} />
          : (postsQ.data?.items.length ?? 0) === 0
            ? <Card><EmptyState title="No posts yet" detail="Your published and scheduled posts will appear here with per-channel status." /></Card>
            : (
              <div className="space-y-3">
                {postsQ.data!.items.map((post) => (
                  <PostRow
                    key={post.id}
                    post={post}
                    canPublish={canPublish}
                    onCancel={(destId) => cancelDestination.mutate({ postId: post.id, destId })}
                    onRetry={(destId) => retryDestination.mutate({ postId: post.id, destId })}
                    busy={cancelDestination.isPending || retryDestination.isPending}
                  />
                ))}
              </div>
            )}
      </div>
    </div>
  );
}

// Register the media asset server-side, return its id.
async function publishMedia(url: string): Promise<string> {
  const media = await publishingService.createMedia({ type: 'IMAGE', url });
  return media.id;
}

// ── Facebook connection panel ────────────────────────────────────────────────
function FacebookPanel() {
  const canManage = useCan('integration.manage');
  const fbQ = useFacebookConnection();
  const { connectFacebook, selectPage } = useContentStudioActions();
  const [pages, setPages] = useState<{ id: string; name: string; category?: string }[] | null>(null);
  const [loadingPages, setLoadingPages] = useState(false);

  const status = fbQ.data;

  const doConnect = async () => {
    try {
      const res = await connectFacebook.mutateAsync();
      if (res.configured && res.authorizeUrl) {
        window.open(res.authorizeUrl, '_blank', 'noopener');
        toast.info('Continue in the Facebook window to authorise, then return and choose a Page.');
      } else {
        toast.info(res.message ?? 'Facebook is not configured on the server yet.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start Facebook connection.');
    }
  };

  const loadPages = async () => {
    setLoadingPages(true);
    try {
      setPages(await publishingService.facebookPages());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load your Facebook Pages.');
    } finally {
      setLoadingPages(false);
    }
  };

  const choose = async (pageId: string) => {
    try {
      await selectPage.mutateAsync(pageId);
      toast.success('Facebook Page selected — you can now publish to it.');
      setPages(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not select that Page.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 font-display font-semibold text-ink">
          <Facebook size={18} className="text-accent" /> Facebook
        </div>
        {status && <FacebookStatusBadge status={status} />}
      </CardHeader>
      <CardBody className="space-y-3">
        {fbQ.isLoading ? <LoadingState label="Checking connection…" />
          : fbQ.isError ? <ErrorState message="Could not check Facebook status." onRetry={() => fbQ.refetch()} />
          : status ? (
            <>
              {status.pageSelected && status.pageName && (
                <p className="rounded-[10px] bg-green-3 p-2.5 text-xs text-green-2">
                  Publishing to <span className="font-semibold">{status.pageName}</span>.
                </p>
              )}
              {status.needsReauth && (
                <p className="rounded-[10px] bg-orange/10 p-2.5 text-xs text-orange">
                  This connection needs reauthorization. Reconnect Facebook to keep publishing.
                </p>
              )}
              {!status.connected && (
                <p className="text-xs text-muted">
                  Connect a Facebook Page through Meta’s official login. No password is ever entered here — only OAuth.
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!canManage || connectFacebook.isPending} onClick={doConnect}>
                  <PlugZap size={15} /> {status.connected ? 'Reconnect' : 'Connect Facebook'}
                </Button>
                {status.connected && (
                  <Button variant="secondary" size="sm" disabled={!canManage || loadingPages} onClick={loadPages}>
                    {loadingPages ? <Loader2 size={15} className="animate-spin" /> : null} Choose Page
                  </Button>
                )}
              </div>

              {pages && (
                pages.length === 0
                  ? <p className="text-xs text-muted">No Pages found on this account.</p>
                  : (
                    <div className="divide-y divide-line rounded-[10px] border border-line">
                      {pages.map((p) => (
                        <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-ink">{p.name}</div>
                            {p.category && <div className="text-xs text-muted">{p.category}</div>}
                          </div>
                          <Button size="sm" variant="ghost" disabled={selectPage.isPending} onClick={() => choose(p.id)}>Select</Button>
                        </div>
                      ))}
                    </div>
                  )
              )}

              {!canManage && (
                <p className="text-xs text-muted">You need the “Manage integrations” permission to change this.</p>
              )}
            </>
          ) : null}
      </CardBody>
    </Card>
  );
}

function FacebookStatusBadge({ status }: { status: FacebookConnectionStatus }) {
  if (status.needsReauth) return <Badge tone="orange">Reauth required</Badge>;
  if (status.pageSelected) return <Badge tone="green">Page connected</Badge>;
  if (status.connected) return <Badge tone="blue">Connected</Badge>;
  return <Badge tone="neutral">Not connected</Badge>;
}

// ── Post + destination rows ──────────────────────────────────────────────────
const POST_TONE: Record<PublishPostStatus, Parameters<typeof Badge>[0]['tone']> = {
  DRAFT: 'neutral', SCHEDULED: 'blue', QUEUED: 'blue', PUBLISHING: 'violet',
  PUBLISHED: 'green', PARTIALLY_PUBLISHED: 'orange', FAILED: 'red', CANCELLED: 'neutral',
};

function PostRow({ post, canPublish, onCancel, onRetry, busy }: {
  post: SocialPublishPost;
  canPublish: boolean;
  onCancel: (destId: string) => void;
  onRetry: (destId: string) => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <p className="line-clamp-2 whitespace-pre-wrap text-sm text-ink">{post.content}</p>
          <Badge tone={POST_TONE[post.status]}>{prettyStatus(post.status)}</Badge>
        </div>
        <div className="text-xs text-muted">
          {post.scheduledAt ? `Scheduled for ${new Date(post.scheduledAt).toLocaleString()}` : `Created ${new Date(post.createdAt).toLocaleString()}`}
        </div>
        <div className="divide-y divide-line rounded-[10px] border border-line">
          {post.destinations.map((d) => (
            <DestinationRow
              key={d.id}
              d={d}
              canPublish={canPublish}
              busy={busy}
              onCancel={() => onCancel(d.id)}
              onRetry={() => onRetry(d.id)}
            />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function DestinationRow({ d, canPublish, busy, onCancel, onRetry }: {
  d: PublishDestinationView;
  canPublish: boolean;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const Icon = PROVIDER_ICON[d.provider] ?? Share2;
  const cancellable = d.status === 'PENDING' || d.status === 'QUEUED';
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-surface-2 text-accent"><Icon size={15} /></span>
        <div className="min-w-0">
          <div className="text-sm font-medium capitalize text-ink">{d.provider}</div>
          {d.errorMessage && <div className="truncate text-xs text-red" title={d.errorMessage}>{d.errorMessage}</div>}
          {d.externalPostId && !d.errorMessage && <div className="truncate text-xs text-muted">Post ID {d.externalPostId}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DestinationBadge status={d.status} />
        {canPublish && cancellable && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} aria-label="Cancel"><XCircle size={15} /></Button>
        )}
        {canPublish && d.status === 'FAILED' && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry} aria-label="Retry"><RotateCw size={15} /></Button>
        )}
      </div>
    </div>
  );
}

function DestinationBadge({ status }: { status: PublishDestStatus }) {
  switch (status) {
    case 'PUBLISHED': return <Badge tone="green"><CheckCircle2 size={12} /> Published</Badge>;
    case 'FAILED': return <Badge tone="red"><XCircle size={12} /> Failed</Badge>;
    case 'PROCESSING': return <Badge tone="violet"><Loader2 size={12} className="animate-spin" /> Publishing</Badge>;
    case 'QUEUED': return <Badge tone="blue"><Clock size={12} /> Queued</Badge>;
    case 'PENDING': return <Badge tone="blue"><Clock size={12} /> Scheduled</Badge>;
    case 'CANCELLED': return <Badge tone="neutral">Cancelled</Badge>;
    default: return <Badge tone="neutral">{status}</Badge>;
  }
}

function prettyStatus(s: PublishPostStatus): string {
  return s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
