import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Facebook, Instagram, Linkedin, Twitter, Youtube, RefreshCw, PlugZap as PlugIcon,
  Copy, Check, AlertCircle, Info, ExternalLink, KeyRound, ShieldCheck, Clock,
  Send, Eye, EyeOff,
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { useOrgStore } from '@/stores/orgStore';
import { useCan } from '@/features/auth/useCan';
import { publishingService } from '@/services/social/publishing.service';
import { toast } from '@/components/toast/toastStore';
import { InstagramMessagingChecklist } from '@/features/instagram/InstagramMessagingChecklist';
import type {
  FacebookConnectionStatus, FacebookTokenConnectResult, NetworkReadiness, NetworkReadinessStatus,
} from '@/services/social/publishing.types';

/**
 * Settings → Integrations → Social Media Accounts. Real connections only, wired
 * to the live `/api/v1/social/*` + `/integrations/*` backend. Each card handles
 * both demo mode (honest "not configured") and a real OAuth connection. No token
 * ever reaches the client.
 */
const STATUS_LABEL: Record<NetworkReadinessStatus, string> = {
  connected: 'Connected',
  ready: 'Ready to connect',
  needs_credentials: 'Needs credentials',
  disabled: 'Turned off',
  pending_support: 'Not built yet',
};
const STATUS_TONE: Record<NetworkReadinessStatus, 'green' | 'blue' | 'orange' | 'neutral'> = {
  connected: 'green', ready: 'blue', needs_credentials: 'orange', disabled: 'neutral', pending_support: 'neutral',
};

export function SocialAccountsPanel() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const readyQ = useQuery({
    queryKey: ['social-readiness', orgId], queryFn: () => publishingService.readiness(), enabled: !!orgId,
  });
  const net = (provider: string) => readyQ.data?.networks.find((n) => n.provider === provider);

  return (
    <div className="space-y-6">
      <SetupSummary
        loading={readyQ.isLoading}
        error={readyQ.isError}
        onRetry={() => readyQ.refetch()}
        networks={readyQ.data?.networks ?? []}
        appUrl={readyQ.data?.appUrl}
      />
      <FacebookInstagramCard fbNet={net('facebook')} igNet={net('instagram')} />
      <LinkedInConnectCard net={net('linkedin')} />
      <PendingNetworkCard net={net('twitter')} Icon={Twitter} fallbackLabel="X (Twitter)" />
      <PendingNetworkCard net={net('youtube')} Icon={Youtube} fallbackLabel="YouTube" />
    </div>
  );
}

/** One line of copyable text — the redirect URI has to be pasted exactly. */
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

/**
 * What still has to happen before this network can connect. Env variables are
 * named, never printed — the redirect URI is the exception, because it is public
 * by definition and has to be pasted into the provider's console verbatim.
 */
function ReadinessDetails({ net }: { net?: NetworkReadiness }) {
  if (!net) return null;
  const blocked = net.status === 'needs_credentials' || net.status === 'disabled';
  return (
    <div className="space-y-2.5 rounded-[10px] border border-line bg-surface-2/40 p-3">
      {net.missingEnv.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <KeyRound size={13} className="text-orange" /> Missing in the server’s .env
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {net.missingEnv.map((k) => (
              <li key={k} className="rounded-md border border-orange/40 bg-orange/5 px-2 py-0.5 font-mono text-[11px] text-ink">{k}</li>
            ))}
          </ul>
        </div>
      )}

      {net.status === 'disabled' && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>This network is switched off on the server, so it will not appear as a publishing destination.</span>
        </p>
      )}

      <div>
        <p className="text-xs font-semibold text-ink">Redirect URI for the developer console</p>
        <div className="mt-1.5">
          <CopyLine value={net.redirectUri || net.expectedRedirectUri} />
        </div>
        {net.redirectWarning && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-red">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{net.redirectWarning}</span>
          </p>
        )}
        {!net.redirectUri && (
          <p className="mt-1 text-[11px] text-muted">Not set on the server yet — this is the value it should be.</p>
        )}
      </div>

      {net.scopes.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-ink">Scopes to request</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {net.scopes.map((sc) => (
              <li key={sc} className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-muted">{sc}</li>
            ))}
          </ul>
        </div>
      )}

      {net.publishBlocker && (
        <p className="mt-2 flex items-start gap-1.5 rounded-[10px] border border-red/30 bg-red/5 p-2.5 text-xs text-red">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{net.publishBlocker}</span>
        </p>
      )}
      {net.appReview && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <ShieldCheck size={13} className="mt-0.5 shrink-0 text-blue" />
          <span>{net.appReview}</span>
        </p>
      )}
      {net.caveat && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{net.caveat}</span>
        </p>
      )}

      <a href={net.docsUrl} target="_blank" rel="noreferrer noopener"
        className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
        Open the developer console <ExternalLink size={11} />
      </a>

      {blocked && (
        <p className="text-[11px] text-muted">
          Paste the values into <code className="font-mono">gs-api/.env</code> and restart the API — this panel updates itself.
        </p>
      )}
    </div>
  );
}

/** The one-glance answer: how much of this is actually set up. */
function SetupSummary({ networks, appUrl, loading, error, onRetry }: {
  networks: NetworkReadiness[]; appUrl?: string; loading: boolean; error: boolean; onRetry: () => void;
}) {
  if (loading) return <Card><CardBody><LoadingState label="Checking what’s set up…" /></CardBody></Card>;
  if (error) return <Card><CardBody><ErrorState message="Could not read the setup state." onRetry={onRetry} /></CardBody></Card>;
  if (networks.length === 0) return null;

  const connected = networks.filter((n) => n.status === 'connected');
  const ready = networks.filter((n) => n.status === 'ready');
  const blocked = networks.filter((n) => n.status === 'needs_credentials');
  const warning = networks.find((n) => n.redirectWarning);

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-sm font-semibold text-ink">Setup status</h3>
          <Badge tone={connected.length ? 'green' : 'neutral'}>{connected.length} connected</Badge>
          {ready.length > 0 && <Badge tone="blue">{ready.length} ready to connect</Badge>}
          {blocked.length > 0 && <Badge tone="orange">{blocked.length} awaiting credentials</Badge>}
        </div>

        {connected.length === 0 && (
          <p className="text-xs text-muted">
            No network is connected yet. Each one needs its own developer app — Facebook and Instagram
            share a single Meta app, LinkedIn has its own. Every card below names exactly what is missing.
          </p>
        )}

        {warning && (
          <p className="flex items-start gap-1.5 rounded-[10px] border border-red/40 bg-red/5 p-2.5 text-xs text-ink">
            <AlertCircle size={13} className="mt-0.5 shrink-0 text-red" />
            <span>
              <span className="font-semibold">The OAuth redirect will not come back.</span>{' '}
              {warning.redirectWarning}
            </span>
          </p>
        )}

        {appUrl && (
          <p className="text-[11px] text-muted">
            Redirect URIs are derived from <code className="font-mono">APP_URL</code> (<code className="font-mono">{appUrl}</code>).
            If the app is served from a different address, change that first — everything else follows from it.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** A network Green Start does not publish to yet. Honest, not a teaser. */
function PendingNetworkCard({ net, Icon, fallbackLabel }: {
  net?: NetworkReadiness; Icon: typeof Twitter; fallbackLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 font-display font-semibold text-ink">
          <Icon size={18} className="text-muted" /> {net?.label ?? fallbackLabel}
        </div>
        <Badge tone="neutral"><Clock size={11} /> {net ? STATUS_LABEL[net.status] : 'Not built yet'}</Badge>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-xs text-muted">
          Green Start has no publishing adapter for this network yet, so there is nothing to connect.
          The requirements are listed here so they can be weighed before anyone plans around it.
        </p>
        <ReadinessDetails net={net} />
      </CardBody>
    </Card>
  );
}

/**
 * Connect by pasting a token you already hold.
 *
 * This is the path that needs NO OAuth app: a Meta app in Development mode issues
 * working tokens to anyone with a role on it, and App Review is only needed to
 * publish for other people's Pages. So someone who has already proved
 * app → permissions → Page token → Graph → published post can bring that exact
 * token here and be connected in one step.
 *
 * The token is typed into a masked field, POSTed once, verified against Graph and
 * stored encrypted server-side. It is never echoed back, never logged, and never
 * held in component state after the request resolves.
 */
function ConnectWithTokenPanel({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [result, setResult] = useState<FacebookTokenConnectResult | null>(null);

  const connect = useMutation({
    mutationFn: () => publishingService.connectFacebookWithToken(token.trim()),
    onSuccess: (res) => {
      setToken('');            // the client keeps no copy once the server has it
      setReveal(false);
      setResult(res);
      toast.success(res.kind === 'page'
        ? `Connected to ${res.status.pageName ?? 'your Page'}.`
        : `Connected. Choose which of your ${res.pages.length} Page${res.pages.length === 1 ? '' : 's'} to publish to.`);
      onConnected();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not verify that token.'),
  });

  return (
    <div className="rounded-[10px] border border-line bg-surface-2/40 p-3">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <KeyRound size={13} className="text-accent" /> Connect with a token instead
        </span>
        <span className="text-[11px] text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2.5">
          <p className="text-xs text-muted">
            If you already have a working Page or User access token — from the Graph API Explorer, say —
            paste it here. No OAuth app, redirect URI or App Review is needed for a Page you administer.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="fb-token" className="block text-xs font-semibold uppercase tracking-wide text-muted">
              Access token
            </label>
            <span className="relative block">
              <Input
                id="fb-token"
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                className="pr-10 font-mono text-xs"
                value={token}
                placeholder="EAAG…"
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="button" onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? 'Hide token' : 'Show token'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-surface-2 hover:text-ink">
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </span>
            <p className="text-[11px] text-muted">
              Sent once to your own server, checked against Graph, then stored encrypted. It is never returned to the browser.
            </p>
          </div>

          <Button size="sm" loading={connect.isPending} disabled={token.trim().length < 20}
            onClick={() => connect.mutate()}>
            <PlugIcon size={15} /> Verify &amp; connect
          </Button>

          {result && (
            <div className="space-y-1.5 rounded-[10px] border border-line bg-surface p-2.5 text-xs">
              <p className="text-ink">
                {result.kind === 'page'
                  ? <>That is a <span className="font-semibold">Page token</span> — the Page is selected and ready to publish.</>
                  : <>That is a <span className="font-semibold">User token</span>. Choose a Page below to finish.</>}
              </p>
              {result.shortLived && (
                <p className="flex items-start gap-1.5 text-orange">
                  <AlertCircle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    This token is short-lived{result.expiresAt ? ` (expires ${new Date(result.expiresAt).toLocaleString()})` : ''} —
                    fine for a first real post, but set META_APP_ID and META_APP_SECRET to have the server exchange it
                    for a long-lived one.
                  </span>
                </p>
              )}
              {result.note && <p className="text-muted">{result.note}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Prove the connection by publishing one real post to the selected Page. */
function TestPostPanel() {
  const [message, setMessage] = useState('Hello from Green Start — this is a test post.');
  const post = useMutation({
    mutationFn: () => publishingService.facebookTestPost(message.trim()),
    onSuccess: (res) => {
      if (res.accepted) toast.success('Published. Check the Page.');
      else toast.error(res.errorMessage ?? 'Facebook did not publish that.');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not publish the test post.'),
  });

  return (
    <div className="space-y-2 rounded-[10px] border border-line bg-surface-2/40 p-3">
      <p className="text-xs font-semibold text-ink">Send a test post</p>
      <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
        aria-label="Test post message" className="text-xs" />
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" loading={post.isPending} disabled={!message.trim()}
          onClick={() => post.mutate()}>
          <Send size={14} /> Publish test post
        </Button>
        <span className="text-[11px] text-muted">This publishes for real to the selected Page.</span>
      </div>
      {post.data?.permalink && (
        <a href={post.data.permalink} target="_blank" rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          Open the post <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

/**
 * Real Facebook + Instagram connection (LIVE `/api/v1/social/*`): connect via
 * Meta OAuth, choose the Page to publish to, and see the linked Instagram
 * Business account. Instagram publishes through the same connection, so linking
 * a Page with a linked IG account enables both. No token ever reaches the client.
 */
function FacebookInstagramCard({ fbNet, igNet }: { fbNet?: NetworkReadiness; igNet?: NetworkReadiness }) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('integration.manage');
  const qc = useQueryClient();
  const statusQ = useQuery({ queryKey: ['fb-connection', orgId], queryFn: () => publishingService.facebookStatus(), enabled: !!orgId });
  const [pages, setPages] = useState<{ id: string; name: string; category?: string }[] | null>(null);
  const [loadingPages, setLoadingPages] = useState(false);
  const st: FacebookConnectionStatus | undefined = statusQ.data;

  const connect = useMutation({
    mutationFn: () => publishingService.connectFacebook(orgId),
    onSuccess: (res) => {
      if (res.configured && res.authorizeUrl) {
        // Same-tab redirect (reliable — a popup opened after an async call is often blocked).
        // The session persists, so the OAuth callback page re-hydrates and returns here.
        window.location.assign(res.authorizeUrl);
      } else {
        toast.info(res.message ?? 'Facebook is not configured on the server yet.');
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not start Facebook connection.'),
  });
  const select = useMutation({
    mutationFn: (pageId: string) => publishingService.selectFacebookPage(pageId),
    onSuccess: () => { toast.success('Page selected — you can publish to it now.'); setPages(null); qc.invalidateQueries({ queryKey: ['fb-connection', orgId] }); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not select that Page.'),
  });
  const loadPages = async () => {
    setLoadingPages(true);
    try { setPages(await publishingService.facebookPages()); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load your Facebook Pages.'); }
    finally { setLoadingPages(false); }
  };

  const badge = !st ? null
    : st.needsReauth ? <Badge tone="orange">Reauth required</Badge>
    : st.pageSelected ? <Badge tone="green">Page connected</Badge>
    : st.connected ? <Badge tone="blue">Connected</Badge>
    : <Badge tone="neutral">Not connected</Badge>;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 font-display font-semibold text-ink">
          <Facebook size={18} className="text-accent" />
          <Instagram size={18} className="text-accent" /> Facebook &amp; Instagram
        </div>
        <div className="flex items-center gap-1.5">
          {fbNet && fbNet.status !== 'connected' && <Badge tone={STATUS_TONE[fbNet.status]}>{STATUS_LABEL[fbNet.status]}</Badge>}
          {badge}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {statusQ.isLoading ? <LoadingState label="Checking connection…" />
          : statusQ.isError ? <ErrorState message="Could not check the connection." onRetry={() => statusQ.refetch()} />
          : st ? (
            <>
              {st.pageSelected && st.pageName && (
                <p className="rounded-[10px] bg-green-3 p-2.5 text-xs text-green-2">
                  Publishing to <span className="font-semibold">{st.pageName}</span>.
                  {st.instagramLinked
                    ? <> Instagram: <span className="font-semibold">{st.instagramUsername ? `@${st.instagramUsername}` : 'linked'}</span>.</>
                    : <> No Instagram Business account is linked to this Page yet.</>}
                </p>
              )}
              {st.needsReauth && (
                <p className="rounded-[10px] bg-orange/10 p-2.5 text-xs text-orange">This connection needs reauthorization. Reconnect to keep publishing.</p>
              )}
              {!st.connected && (
                <p className="text-xs text-muted">
                  Connect through Meta’s official login (OAuth only — no password is entered here). Facebook and Instagram both publish through the Page you select; Instagram must be a Business/Creator account linked to that Page.
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!canManage || connect.isPending} onClick={() => connect.mutate()}>
                  <PlugIcon size={15} /> {st.connected ? 'Reconnect' : 'Connect Facebook & Instagram'}
                </Button>
                {st.connected && (
                  <Button variant="secondary" size="sm" disabled={!canManage || loadingPages} onClick={loadPages}>
                    <RefreshCw size={15} /> {st.pageSelected ? 'Change Page' : 'Choose Page'}
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
                          <Button size="sm" variant="ghost" disabled={select.isPending} onClick={() => select.mutate(p.id)}>Select</Button>
                        </div>
                      ))}
                    </div>
                  )
              )}
              {!canManage && <p className="text-xs text-muted">You need the “Manage integrations” permission to change this.</p>}

              {canManage && (
                <ConnectWithTokenPanel
                  onConnected={() => { qc.invalidateQueries({ queryKey: ['fb-connection', orgId] }); setPages(null); }}
                />
              )}
              {st.pageSelected && canManage && <TestPostPanel />}
              {st.pageSelected && st.instagramLinked && <InstagramMessagingChecklist compact />}

              <ReadinessDetails net={fbNet} />
              {igNet?.status === 'disabled' && (
                <p className="text-xs text-muted">
                  Instagram is switched off on the server (<code className="font-mono">INSTAGRAM_ENABLED</code>), so the
                  Page connection above publishes to Facebook only.
                </p>
              )}
            </>
          ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Real LinkedIn connection (LIVE, its own OAuth app). Posts as the connected
 * member. No Page-select step — connecting is enough to publish. No token
 * reaches the client.
 */
function LinkedInConnectCard({ net }: { net?: NetworkReadiness }) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('integration.manage');
  const statusQ = useQuery({ queryKey: ['linkedin-connection', orgId], queryFn: () => publishingService.linkedinStatus(orgId), enabled: !!orgId });
  const st = statusQ.data;

  const connect = useMutation({
    mutationFn: () => publishingService.connectLinkedIn(orgId),
    onSuccess: (res) => {
      if (res.configured && res.authorizeUrl) {
        // Same-tab redirect (a popup opened after an async call is often blocked).
        window.location.assign(res.authorizeUrl);
      } else {
        toast.info(res.message ?? 'LinkedIn is not configured on the server yet.');
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not start LinkedIn connection.'),
  });

  const badge = !st ? null
    : st.needsReauth ? <Badge tone="orange">Reauth required</Badge>
    : st.connected ? <Badge tone="green">Connected</Badge>
    : <Badge tone="neutral">Not connected</Badge>;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 font-display font-semibold text-ink">
          <Linkedin size={18} className="text-accent" /> LinkedIn
        </div>
        <div className="flex items-center gap-1.5">
          {net && net.status !== 'connected' && <Badge tone={STATUS_TONE[net.status]}>{STATUS_LABEL[net.status]}</Badge>}
          {badge}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {statusQ.isLoading ? <LoadingState label="Checking connection…" />
          : statusQ.isError ? <ErrorState message="Could not check LinkedIn." onRetry={() => statusQ.refetch()} />
          : (
            <>
              {st?.connected
                ? <p className="rounded-[10px] bg-green-3 p-2.5 text-xs text-green-2">Publishing as <span className="font-semibold">{st.displayName ?? 'your LinkedIn member'}</span>.</p>
                : <p className="text-xs text-muted">Connect through LinkedIn’s official login (OAuth only). Posts publish as the connected member.</p>}
              {st?.needsReauth && (
                <p className="rounded-[10px] bg-orange/10 p-2.5 text-xs text-orange">This connection needs reauthorization. Reconnect to keep publishing.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!canManage || connect.isPending} onClick={() => connect.mutate()}>
                  <PlugIcon size={15} /> {st?.connected ? 'Reconnect' : 'Connect LinkedIn'}
                </Button>
              </div>
              {!canManage && <p className="text-xs text-muted">You need the “Manage integrations” permission to change this.</p>}

              <ReadinessDetails net={net} />
            </>
          )}
      </CardBody>
    </Card>
  );
}
