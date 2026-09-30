import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Send, ArrowLeft, MessagesSquare } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { inboxService } from '@/services/inbox/inbox.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { cn } from '@/lib/cn';
import type { Conversation, ConversationStatus } from '@/types';

const statusTone: Record<ConversationStatus, 'green' | 'orange' | 'neutral' | 'blue'> = {
  open: 'green', pending: 'orange', snoozed: 'blue', closed: 'neutral',
};

export function InboxPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canReply = useCan('inbox.reply');
  const lp = useListParams({ sort: 'lastMessageAt' });
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ['conversations', orgId, lp.params],
    queryFn: () => inboxService.listConversations(orgId, lp.params),
    enabled: !!orgId,
  });
  const conversations = listQ.data?.items ?? [];
  const active = conversations.find((c) => c.id === activeId) ?? null;

  return (
    <div>
      <PageHeader title="Inbox" subtitle="Conversations across your connected channels"
        actions={<RefreshButton keys={['conversations', 'conversation-messages']} />} />
      <Card className="overflow-hidden">
        <div className="flex h-[calc(100vh-230px)] min-h-[440px]">
          {/* Conversation list */}
          <div className={cn('flex w-full flex-col border-r border-line sm:w-80', active && 'hidden sm:flex')}>
            <div className="space-y-2 border-b border-line p-3">
              <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search conversations…" />
              <Select className="h-9" value={lp.filters.status ?? ''} onChange={(e) => lp.setFilter('status', e.target.value)}>
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="snoozed">Snoozed</option>
                <option value="closed">Closed</option>
              </Select>
            </div>
            <div className="flex-1 overflow-y-auto">
              {listQ.isLoading ? <LoadingState /> : listQ.isError ? <ErrorState onRetry={() => listQ.refetch()} />
                : conversations.length === 0 ? <EmptyState title="No conversations" detail="Inbound messages from your channels will appear here." />
                : conversations.map((c) => (
                  <button key={c.id} onClick={() => { setActiveId(c.id); if (c.unreadCount) inboxService.markRead(orgId, c.id).then(() => qc.invalidateQueries({ queryKey: ['conversations', orgId] })); }}
                    className={cn('flex w-full flex-col gap-0.5 border-b border-line px-3 py-2.5 text-left hover:bg-surface-2', activeId === c.id && 'bg-surface-2')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-ink">{c.contactName ?? c.contactPhone ?? 'Unknown'}</span>
                      {c.unreadCount > 0 && <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-white">{c.unreadCount}</span>}
                    </div>
                    <span className="truncate text-xs text-muted">{c.lastMessagePreview ?? '—'}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted"><Badge tone={statusTone[c.status]}>{c.status}</Badge>{c.channel}</span>
                  </button>
                ))}
            </div>
          </div>

          {/* Thread */}
          <div className={cn('flex flex-1 flex-col', !active && 'hidden sm:flex')}>
            {active ? <Thread orgId={orgId} conversation={active} canReply={canReply} onBack={() => setActiveId(null)}
              onChanged={() => qc.invalidateQueries({ queryKey: ['conversations', orgId] })} />
              : <div className="flex flex-1 items-center justify-center text-sm text-muted"><div className="text-center"><MessagesSquare className="mx-auto mb-2 text-muted" /> Select a conversation</div></div>}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Thread({ orgId, conversation, canReply, onBack, onChanged }: {
  orgId: string; conversation: Conversation; canReply: boolean; onBack: () => void; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const msgsQ = useQuery({
    queryKey: ['conversation-messages', orgId, conversation.id],
    queryFn: () => inboxService.listMessages(orgId, conversation.id),
    enabled: !!orgId,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['conversation-messages', orgId, conversation.id] });
    onChanged();
  };
  const reply = useMutation({ mutationFn: (text: string) => inboxService.reply(orgId, conversation.id, text), onSuccess: invalidate });
  const setStatus = useMutation({ mutationFn: (s: ConversationStatus) => inboxService.setStatus(orgId, conversation.id, s), onSuccess: invalidate });

  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const messages = msgsQ.data ?? [];
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    reply.mutateAsync(t).then(() => setText('')).catch((e) => toast.error(e?.message ?? 'Send failed'));
  };
  const closed = conversation.status === 'closed';

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Button variant="ghost" size="sm" className="sm:hidden" onClick={onBack} aria-label="Back"><ArrowLeft size={16} /></Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink">{conversation.contactName ?? conversation.contactPhone ?? 'Unknown'}</div>
          <div className="text-xs text-muted">{conversation.channel} · {conversation.contactPhone ?? ''}</div>
        </div>
        <Badge tone={statusTone[conversation.status]}>{conversation.status}</Badge>
        {closed
          ? <Button variant="secondary" size="sm" loading={setStatus.isPending} onClick={() => setStatus.mutateAsync('open').then(() => toast.success('Reopened')).catch(() => toast.error('Failed'))}>Reopen</Button>
          : <Button variant="secondary" size="sm" loading={setStatus.isPending} onClick={() => setStatus.mutateAsync('closed').then(() => toast.success('Closed')).catch(() => toast.error('Failed'))}>Close</Button>}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-surface-2 p-4">
        {msgsQ.isLoading ? <LoadingState /> : msgsQ.isError ? <ErrorState onRetry={() => msgsQ.refetch()} />
          : messages.length === 0 ? <EmptyState title="No messages yet" detail="Start the conversation with a reply below." />
          : messages.map((m) => (
            <div key={m.id} className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[78%] rounded-card px-3 py-2 text-sm shadow-sm',
                m.direction === 'outbound' ? 'bg-accent text-white' : 'bg-surface text-ink border border-line')}>
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                <div className={cn('mt-1 text-[10px]', m.direction === 'outbound' ? 'text-white/70' : 'text-muted')}>
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {m.direction === 'outbound' && <> · {m.status}{m.provider === 'mock' ? ' · demo' : ''}</>}
                </div>
              </div>
            </div>
          ))}
        <div ref={endRef} />
      </div>

      {canReply && !closed && (
        <div className="flex items-end gap-2 border-t border-line p-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Type a reply…"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-[10px] border border-line bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent" />
          <Button size="md" loading={reply.isPending} onClick={send} aria-label="Send"><Send size={16} /></Button>
        </div>
      )}
      {closed && <div className="border-t border-line p-3 text-center text-xs text-muted">This conversation is closed. Reopen it to reply.</div>}
    </>
  );
}
