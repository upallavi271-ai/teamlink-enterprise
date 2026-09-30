import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw, Send, Info, AlertCircle, Paperclip, ExternalLink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { PageHeader } from '@/components/layout/PageHeader';
import { inboxService } from '@/services/inbox/inbox.service';
import { useOrgStore } from '@/stores/orgStore';
import type { Conversation, InboxMessage } from '@/types';

/** Meta allows a free-form reply only within 24h of the person's last message. */
const WINDOW_MS = 24 * 3600_000;

/** What the API sends for an attachment it stored (Instagram today). */
export interface DmAttachment { type: string; url: string | null }
/** An inbox message plus the Instagram-only extras; other channels never set them. */
export type DmMessage = InboxMessage & {
  attachments?: DmAttachment[];
  unsupported?: boolean;
  replyToStoryUrl?: string;
};

export interface MetaDmInboxProps {
  /** The conversation channel this inbox lists — the API filters on it. */
  channel: 'facebook' | 'instagram';
  /** Prefix for react-query keys, kept per channel so the two caches never mix. */
  queryKeyPrefix: string;
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  subtitle: string;
  /** Shown when a thread has no contact name yet. */
  contactFallback: string;
  /** Line under the contact's name in the thread header. */
  threadCaption: string;
  emptyListDetail: string;
  placeholderTitle: string;
  /** The hint under the composer while the window is open. */
  windowOpenHint: (hoursLeft: number) => string;
  /** The notice shown instead of the composer once the window has closed. */
  windowClosed: ReactNode;
  /** Provider limit on one message, in UTF-8 bytes (Instagram: 1,000). */
  maxBytes?: number;
  /** Optional block between the header and the inbox — e.g. a setup checklist. */
  banner?: ReactNode;
}

const initials = (s: string) =>
  s.trim().replace(/^@/, '').split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
const shortDay = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * A Meta direct-message inbox — thread list, thread, composer. Facebook
 * Messenger and Instagram DMs are the same shape (webhook in, Page token out,
 * 24-hour window), so both pages render this and differ only in wording.
 *
 * The 24-hour window is computed here from the last inbound message so the
 * composer can say why it is closed BEFORE someone types a reply Meta would
 * refuse. The API enforces the same rule; this is only the early warning.
 */
export function MetaDmInbox(props: MetaDmInboxProps) {
  const { channel, queryKeyPrefix, icon: Icon, iconClassName } = props;
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listKey = `${queryKeyPrefix}-conversations`;

  const listQ = useQuery({
    queryKey: [listKey, orgId, search],
    enabled: !!orgId,
    queryFn: () => inboxService.listConversations(orgId, {
      page: 1, pageSize: 50, search: search.trim() || undefined,
      filters: { channel },
    }),
  });

  const conversations = useMemo(() => listQ.data?.items ?? [], [listQ.data]);
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && conversations.length > 0) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  return (
    <div>
      <PageHeader
        title={<><Icon size={20} className={iconClassName} /> {props.title}</>}
        subtitle={props.subtitle}
      />

      {props.banner && <div className="mb-4">{props.banner}</div>}

      <Card className="overflow-hidden">
        <div className="grid h-[calc(100dvh-15rem)] min-h-[420px] grid-cols-1 md:grid-cols-[320px_1fr]">
          {/* ── thread list ── */}
          <aside className="flex min-h-0 flex-col border-b border-line md:border-b-0 md:border-r">
            <div className="flex items-center gap-2 border-b border-line p-3">
              <div className="relative min-w-0 flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search messages..."
                  aria-label="Search messages"
                  className="h-9 w-full rounded-[10px] border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
                />
              </div>
              <button
                type="button"
                onClick={() => qc.invalidateQueries({ queryKey: [listKey, orgId] })}
                aria-label="Refresh"
                className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
              >
                <RefreshCw size={15} className={listQ.isFetching ? 'animate-spin' : ''} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {listQ.isLoading ? <LoadingState label="Loading conversations…" />
                : listQ.isError ? <ErrorState message="Could not load conversations." onRetry={() => listQ.refetch()} />
                : conversations.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No messages yet" detail={props.emptyListDetail} />
                  </div>
                ) : conversations.map((c) => (
                  <button
                    key={c.id} type="button" onClick={() => setSelectedId(c.id)}
                    className={`flex w-full items-start gap-2.5 border-b border-line px-3 py-3 text-left transition-colors last:border-0 ${
                      c.id === selectedId ? 'bg-accent-soft' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
                      {initials(c.contactName ?? props.contactFallback)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">{c.contactName ?? props.contactFallback}</span>
                        <span className="shrink-0 text-[11px] text-muted">{shortDay(c.lastMessageAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">{c.lastMessagePreview ?? ''}</span>
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="mt-1 shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">{c.unreadCount}</span>
                    )}
                  </button>
                ))}
            </div>
          </aside>

          {/* ── thread ── */}
          <section className="min-h-0 min-w-0">
            {selected
              ? <Thread key={selected.id} orgId={orgId} conversation={selected} {...props} />
              : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
                  <span className="grid h-16 w-16 place-items-center rounded-full border-2 border-line">
                    <Icon size={28} className="text-muted" />
                  </span>
                  <p className="font-display text-lg font-semibold text-ink">{props.placeholderTitle}</p>
                  <p className="text-sm text-muted">Select a conversation to start messaging</p>
                </div>
              )}
          </section>
        </div>
      </Card>
    </div>
  );
}

function Thread({ orgId, conversation, queryKeyPrefix, contactFallback, threadCaption, windowOpenHint, windowClosed, maxBytes }:
  MetaDmInboxProps & { orgId: string; conversation: Conversation }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const listKey = `${queryKeyPrefix}-conversations`;
  const msgKey = `${queryKeyPrefix}-messages`;

  const msgsQ = useQuery({
    queryKey: [msgKey, orgId, conversation.id],
    queryFn: () => inboxService.listMessages(orgId, conversation.id),
  });
  const messages: DmMessage[] = msgsQ.data ?? [];

  // Opening a thread clears its unread badge. Thread is keyed on the
  // conversation id so it remounts per thread, which is what makes the ref a
  // sufficient guard against firing twice for the same one. A failure resets
  // the guard so the next render can retry rather than leaving a stale badge.
  const markedRef = useRef(false);
  useEffect(() => {
    if (markedRef.current || conversation.unreadCount <= 0) return;
    markedRef.current = true;
    inboxService.markRead(orgId, conversation.id)
      .then(() => qc.invalidateQueries({ queryKey: [listKey, orgId] }))
      .catch(() => { markedRef.current = false; });
  }, [orgId, conversation.id, conversation.unreadCount, qc, listKey]);

  // Keep the newest message in view — on open, and after every send.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  // The window runs from the person's last INBOUND message — an outbound reply
  // does not reopen it, which is exactly the rule people get wrong.
  const lastInbound = useMemo(
    () => [...messages].reverse().find((m) => m.direction === 'inbound'),
    [messages],
  );
  const msLeft = lastInbound ? WINDOW_MS - (Date.now() - new Date(lastInbound.createdAt).getTime()) : -1;
  const open = msLeft > 0;
  const hoursLeft = Math.floor(msLeft / 3600_000);

  const bytes = maxBytes ? utf8Bytes(text) : 0;
  const tooLong = maxBytes !== undefined && bytes > maxBytes;
  const canSend = !!text.trim() && !tooLong;

  const send = useMutation({
    mutationFn: () => inboxService.reply(orgId, conversation.id, text.trim()),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: [msgKey, orgId, conversation.id] });
      qc.invalidateQueries({ queryKey: [listKey, orgId] });
    },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not send that reply'),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
          {initials(conversation.contactName ?? contactFallback)}
        </span>
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{conversation.contactName ?? contactFallback}</div>
          <div className="text-xs text-muted">{threadCaption}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-surface-2/40 p-4">
        {msgsQ.isLoading ? <LoadingState label="Loading messages…" />
          : msgsQ.isError ? <ErrorState message="Could not load this thread." onRetry={() => msgsQ.refetch()} />
          : messages.length === 0 ? <p className="text-sm text-muted">No messages in this thread yet.</p>
          : messages.map((m) => {
            const mine = m.direction === 'outbound';
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-[12px] px-3 py-2 text-sm ${
                  mine ? 'bg-accent text-white' : 'border border-line bg-surface text-ink'
                }`}>
                  {m.replyToStoryUrl && (
                    <a href={m.replyToStoryUrl} target="_blank" rel="noreferrer"
                      className={`mb-1 inline-flex items-center gap-1 text-[11px] underline ${mine ? 'text-white/80' : 'text-muted'}`}>
                      Replied to your story <ExternalLink size={10} />
                    </a>
                  )}
                  {m.attachments?.map((a, i) => <AttachmentView key={i} attachment={a} mine={mine} />)}
                  {m.unsupported && (
                    <p className={`italic ${mine ? 'text-white/80' : 'text-muted'}`}>
                      This message type isn’t available through the API — open Instagram to see it.
                    </p>
                  )}
                  {(m.text || (!m.attachments?.length && !m.unsupported)) && (
                    <p className="whitespace-pre-wrap break-words">{m.text ?? ''}</p>
                  )}
                  <p className={`mt-1 text-[10px] ${mine ? 'text-white/70' : 'text-muted'}`}>{clock(m.createdAt)}</p>
                </div>
              </div>
            );
          })}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line p-3">
        {open ? (
          <>
            <div className="flex items-end gap-2">
              <Textarea
                rows={2} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Write a reply…" aria-label="Reply" invalid={tooLong}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && canSend) { e.preventDefault(); send.mutate(); }
                }}
              />
              <Button size="sm" className="mb-0.5" loading={send.isPending} disabled={!canSend}
                onClick={() => send.mutate()}>
                <Send size={15} /> Send
              </Button>
            </div>
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
              <Info size={11} />
              <span className="flex-1">{windowOpenHint(hoursLeft)}</span>
              {maxBytes !== undefined && (
                <span className={tooLong ? 'font-semibold text-red' : ''}>{bytes}/{maxBytes}</span>
              )}
            </p>
          </>
        ) : (
          <p className="flex items-start gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-3 text-xs text-ink">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-orange" />
            <span>{windowClosed}</span>
          </p>
        )}
      </div>
    </div>
  );
}

const ATTACHMENT_LABEL: Record<string, string> = {
  image: 'Photo', video: 'Video', audio: 'Voice message', file: 'File',
  share: 'Shared post', story_mention: 'Mentioned you in their story', reel: 'Reel', ig_reel: 'Reel',
};

/**
 * One stored attachment. Meta's attachment URLs are CDN links that stop working
 * after a while, so an image that fails to load falls back to a plain link and
 * a label — never a broken-image icon with no explanation.
 */
function AttachmentView({ attachment, mine }: { attachment: DmAttachment; mine: boolean }) {
  const [broken, setBroken] = useState(false);
  const label = ATTACHMENT_LABEL[attachment.type] ?? 'Attachment';
  const tone = mine ? 'text-white/90' : 'text-ink';

  if (attachment.type === 'image' && attachment.url && !broken) {
    return (
      <a href={attachment.url} target="_blank" rel="noreferrer" className="mb-1 block">
        <img src={attachment.url} alt={label} loading="lazy" onError={() => setBroken(true)}
          className="max-h-56 max-w-full rounded-[8px] object-cover" />
      </a>
    );
  }
  return (
    <p className={`mb-1 flex items-center gap-1.5 ${tone}`}>
      <Paperclip size={12} className="shrink-0" />
      {attachment.url ? (
        <a href={attachment.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
          {label} <ExternalLink size={10} />
        </a>
      ) : <span>{label}</span>}
      {broken && <span className={mine ? 'text-white/70' : 'text-muted'}>(preview expired)</span>}
    </p>
  );
}
