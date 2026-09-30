import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, AlertCircle, HelpCircle, Hand, RefreshCw, ChevronDown, Copy, Check, Webhook, Instagram,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { useOrgStore } from '@/stores/orgStore';
import { useCan } from '@/features/auth/useCan';
import { cn } from '@/lib/cn';
import { publishingService } from '@/services/social/publishing.service';
import type { MessagingCheck, MessagingCheckStatus } from '@/services/social/publishing.types';

const STATUS_VIEW: Record<MessagingCheckStatus, { Icon: LucideIcon; className: string; label: string }> = {
  ok: { Icon: CheckCircle2, className: 'text-green', label: 'Done' },
  problem: { Icon: AlertCircle, className: 'text-red', label: 'Needs attention' },
  unknown: { Icon: HelpCircle, className: 'text-muted', label: 'Could not be verified' },
  manual: { Icon: Hand, className: 'text-blue', label: 'Manual step' },
};

/** One line of copyable text — the callback URL has to be compared/pasted exactly. */
function CopyLine({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="flex items-center gap-1.5 rounded-[10px] border border-line bg-surface-2/60 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{value}</code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value)
            .then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })
            .catch(() => toast.info(value));
        }}
        aria-label="Copy"
        className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-ink"
      >
        {done ? <Check size={12} className="text-green" /> : <Copy size={12} />}
      </button>
    </span>
  );
}

function CheckRow({ check }: { check: MessagingCheck }) {
  const { Icon, className, label } = STATUS_VIEW[check.status];
  // Only something the person has to act on gets a fix box; an 'ok' row's fix is noise.
  const showFix = !!check.fix && check.status !== 'ok';
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon size={16} className={cn('mt-0.5 shrink-0', className)} aria-label={label} role="img" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{check.label}</p>
        {check.detail && <p className="mt-0.5 break-words text-xs text-muted">{check.detail}</p>}
        {showFix && (
          <p className={cn(
            'mt-1.5 rounded-[10px] px-2.5 py-1.5 text-xs text-ink',
            check.status === 'problem' ? 'bg-orange/10' : 'border border-line bg-surface-2',
          )}>
            {check.fix}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Why Instagram DMs are (or are not) arriving: the server checks each link of
 * the chain — app config, Page, linked account, token, permissions, webhook
 * subscriptions — and names the manual Meta/Instagram steps no API can verify.
 * A silent empty inbox otherwise gives no hint which of those is missing.
 *
 * The endpoints require `integration.manage`, so without it this renders
 * nothing rather than a permission error.
 */
export function InstagramMessagingChecklist({ compact = false, defaultOpen = false }: {
  compact?: boolean;
  defaultOpen?: boolean;
}) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('integration.manage');
  const qc = useQueryClient();
  const queryKey = ['ig-messaging-readiness', orgId];

  const q = useQuery({
    queryKey,
    queryFn: () => publishingService.instagramMessagingReadiness(),
    enabled: !!orgId && canManage,
  });
  const data = q.data;

  // null = the person has not chosen yet. The first result decides once, so a
  // checklist that turns green after "Subscribe" does not snap shut mid-read.
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (open === null && data) setOpen(defaultOpen || !data.ready);
  }, [open, data, defaultOpen]);
  const isOpen = !compact || (open ?? (defaultOpen || !data?.ready));

  const subscribe = useMutation({
    mutationFn: () => publishingService.subscribeInstagramMessaging(),
    onSuccess: (res) => {
      qc.setQueryData(queryKey, res);
      toast.success('Page subscribed to webhooks.');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not subscribe the Page to webhooks.'),
  });

  if (!canManage) return null;

  const pageSubscribed = data?.checks.find((c) => c.key === 'page_subscribed')?.status === 'ok';
  const toggle = compact ? () => setOpen(!isOpen) : undefined;

  return (
    <Card>
      <CardHeader
        onClick={toggle}
        className={cn(compact && 'cursor-pointer select-none', !isOpen && 'border-b-0')}
      >
        {/* The click bubbles to the header; a real button keeps it keyboard-reachable. */}
        {compact ? (
          <button type="button" aria-expanded={isOpen}
            className="flex min-w-0 items-center gap-2 text-left font-display font-semibold text-ink">
            <Instagram size={18} className="shrink-0 text-violet" />
            <span className="truncate">Instagram messaging setup</span>
            <ChevronDown size={16} className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2 font-display font-semibold text-ink">
            <Instagram size={18} className="shrink-0 text-violet" />
            <span className="truncate">Instagram messaging setup</span>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {data && (data.ready
            ? <Badge tone="green">Ready</Badge>
            : <Badge tone="orange">Needs setup</Badge>)}
          <Button
            variant="ghost" size="sm" className="px-2"
            aria-label="Re-check Instagram messaging setup"
            disabled={!orgId || q.isFetching}
            onClick={(e) => { e.stopPropagation(); q.refetch(); }}
          >
            <RefreshCw size={14} className={cn(q.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>

      {isOpen && (
        <CardBody className="space-y-3">
          {q.isLoading ? <LoadingState label="Checking Instagram messaging…" />
            : q.isError ? (
              <ErrorState
                message={q.error instanceof Error ? q.error.message : 'Could not check Instagram messaging.'}
                onRetry={() => q.refetch()}
              />
            )
            : data ? (
              <>
                {(data.pageName || data.instagramUsername) && (
                  <p className="text-xs text-muted">
                    {data.instagramUsername && <>Account <span className="font-semibold text-ink">@{data.instagramUsername}</span></>}
                    {data.instagramUsername && data.pageName && ' · '}
                    {data.pageName && <>Page <span className="font-semibold text-ink">{data.pageName}</span></>}
                  </p>
                )}

                <ul className="divide-y divide-line">
                  {data.checks.map((c) => <CheckRow key={c.key} check={c} />)}
                </ul>

                {data.webhookCallbackUrl && (
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                      <Webhook size={13} className="text-muted" /> Instagram webhook callback URL on file with Meta
                    </p>
                    <div className="mt-1.5"><CopyLine value={data.webhookCallbackUrl} /></div>
                  </div>
                )}

                {data.canSubscribe && !pageSubscribed && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" loading={subscribe.isPending} onClick={() => subscribe.mutate()}>
                      <Webhook size={14} /> Subscribe Page to webhooks
                    </Button>
                    <span className="text-[11px] text-muted">Asks Meta to send this Page’s messages to Green Start.</span>
                  </div>
                )}

                <p className="text-[11px] text-muted">
                  Checked {new Date(data.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </>
            ) : null}
        </CardBody>
      )}
    </Card>
  );
}
