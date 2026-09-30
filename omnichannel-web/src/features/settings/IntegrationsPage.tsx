import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Facebook, Instagram, Linkedin, Twitter, Youtube, AtSign, MessageCircle, Mail,
  Plug, PlugZap, RefreshCw, Wifi, Plus, CreditCard, Radio, Mic, Bot, Smartphone,
  Table2, CalendarDays, Video, Building2, ShoppingBag, AlertTriangle,
  KeyRound, Send, ExternalLink, ShieldCheck, CheckCircle2, LogIn,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { Tabs } from '@/components/ui/Tabs';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { useOrgStore } from '@/stores/orgStore';
import { useCan } from '@/features/auth/useCan';
import { integrationsService } from '@/services/integrations/integrations.service';
import type { EmailProviderView, SmsProviderView, SenderView } from '@/services/integrations/integrations.types';
import { publishingService } from '@/services/social/publishing.service';
import type { FacebookPageOption } from '@/services/social/publishing.types';
import { toast } from '@/components/toast/toastStore';
import type { IntegrationStatus, IntegrationView } from '@/types';

type Icon = LucideIcon;

const STATUS: Record<IntegrationStatus, { label: string; tone: 'green' | 'neutral' | 'blue' | 'red' | 'orange' }> = {
  CONNECTED: { label: 'Connected', tone: 'green' },
  NOT_CONNECTED: { label: 'Not connected', tone: 'neutral' },
  SYNCING: { label: 'Syncing', tone: 'blue' },
  ERROR: { label: 'Error', tone: 'red' },
  EXPIRED: { label: 'Expired', tone: 'orange' },
  DISCONNECTED: { label: 'Disconnected', tone: 'neutral' },
};
const isLive = (s: IntegrationStatus) => s === 'CONNECTED' || s === 'SYNCING' || s === 'ERROR' || s === 'EXPIRED';

/** Social platforms shown in the picker. `provider` is set only where the server has a real adapter. */
type SocialDef = { key: string; label: string; icon: Icon; provider?: string; note?: string };
const SOCIAL_PLATFORMS: SocialDef[] = [
  { key: 'facebook', label: 'Facebook', icon: Facebook, provider: 'facebook' },
  { key: 'instagram', label: 'Instagram', icon: Instagram, provider: 'facebook', note: 'Connects with your Facebook Page (Instagram Business account).' },
  { key: 'linkedin', label: 'LinkedIn', icon: Linkedin, provider: 'linkedin' },
  { key: 'twitter', label: 'Twitter / X', icon: Twitter },
  { key: 'youtube', label: 'YouTube', icon: Youtube },
  { key: 'threads', label: 'Threads', icon: AtSign },
];
const CRM_PROVIDERS: { key: string; label: string; icon: Icon }[] = [
  { key: 'google-sheets', label: 'Google Sheets', icon: Table2 },
  { key: 'google-calendar', label: 'Google Calendar (Meet)', icon: CalendarDays },
  { key: 'zoom', label: 'Zoom', icon: Video },
  { key: 'zoho', label: 'Zoho', icon: Building2 },
  { key: 'hubspot', label: 'HubSpot', icon: Building2 },
  { key: 'shopify', label: 'Shopify', icon: ShoppingBag },
];

export function IntegrationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const qc = useQueryClient();
  const canManage = useCan('integration.manage');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['integrations', orgId], queryFn: () => integrationsService.list(orgId), enabled: !!orgId,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['integrations', orgId] });
  const fbQ = useQuery({
    queryKey: ['facebook-status', orgId],
    queryFn: () => publishingService.facebookStatus(),
    enabled: !!orgId,
  });
  const fb = fbQ.data;
  const refreshFb = () => { fbQ.refetch(); invalidate(); };
  const liQ = useQuery({
    queryKey: ['linkedin-status', orgId],
    queryFn: () => publishingService.linkedinStatus(orgId),
    enabled: !!orgId,
  });
  const li = liQ.data;
  const liDisconnect = useMutation({
    mutationFn: () => publishingService.disconnectLinkedIn(),
    onSuccess: () => { toast.success('LinkedIn disconnected'); liQ.refetch(); invalidate(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Disconnect failed'),
  });

  const connect = useMutation({
    mutationFn: (provider: string) => integrationsService.connect(orgId, provider),
    onSuccess: (res) => {
      if (res.configured && res.authorizeUrl) {
        // Same-tab redirect — a popup opened after an async call is usually blocked.
        window.location.assign(res.authorizeUrl);
      } else {
        toast.info(res.message ?? 'This provider is not configured on the server yet.');
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Connect failed'),
  });
  const test = useMutation({
    mutationFn: (id: string) => integrationsService.test(orgId, id),
    onSuccess: (r) => { toast[r.healthy ? 'success' : 'error'](r.detail ?? (r.healthy ? 'Healthy' : 'Unhealthy')); invalidate(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Test failed'),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => integrationsService.disconnect(orgId, id),
    onSuccess: () => { toast.success('Disconnected'); invalidate(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Disconnect failed'),
  });

  // Email (SMTP) and SMS (MSG91): this workspace's OWN accounts. Campaigns on
  // these channels send through them — never through another organisation's.
  const emailQ = useQuery({
    queryKey: ['email-provider', orgId], queryFn: () => integrationsService.emailProvider(orgId), enabled: !!orgId,
  });
  const smsQ = useQuery({
    queryKey: ['sms-provider', orgId], queryFn: () => integrationsService.smsProvider(orgId), enabled: !!orgId,
  });
  const email = emailQ.data ?? null;
  const sms = smsQ.data ?? null;
  const refreshEmail = () => qc.invalidateQueries({ queryKey: ['email-provider', orgId] });
  const refreshSms = () => qc.invalidateQueries({ queryKey: ['sms-provider', orgId] });
  const emailVerify = useMutation({
    mutationFn: () => integrationsService.emailVerify(orgId),
    onSuccess: (r) => { toast[r.healthy ? 'success' : 'error'](r.detail ?? (r.healthy ? 'Mailbox reachable' : 'Mailbox check failed')); refreshEmail(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Mailbox check failed'),
  });
  const emailDisconnect = useMutation({
    mutationFn: () => integrationsService.disconnectEmail(orgId),
    onSuccess: () => { toast.success('Mailbox disconnected — its password was erased'); refreshEmail(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Disconnect failed'),
  });
  const smsVerify = useMutation({
    mutationFn: () => integrationsService.smsVerify(orgId),
    // "Present, not verified" is the honest answer MSG91 allows — shown as info, not success.
    onSuccess: (r) => { toast[r.healthy ? 'info' : 'error'](r.detail ?? (r.healthy ? 'Credentials present' : 'SMS is not connected')); refreshSms(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Check failed'),
  });
  const smsDisconnect = useMutation({
    mutationFn: () => integrationsService.disconnectSms(orgId),
    onSuccess: () => { toast.success('MSG91 disconnected — its auth key was erased'); refreshSms(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Disconnect failed'),
  });
  const channelBusy = emailVerify.isPending || emailDisconnect.isPending || smsVerify.isPending || smsDisconnect.isPending;

  const rows = useMemo(() => data ?? [], [data]);
  const byProvider = (p: string) => rows.find((r) => r.provider === p);
  const socialRows = rows.filter((r) => ['facebook', 'linkedin'].includes(r.provider) && isLive(r.status));
  const whatsapp = byProvider('whatsapp');

  const [showSocial, setShowSocial] = useState(false);
  const [showCrm, setShowCrm] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showEmailTest, setShowEmailTest] = useState(false);
  const [showSms, setShowSms] = useState(false);
  const [showSmsTest, setShowSmsTest] = useState(false);
  const [showSmartPing, setShowSmartPing] = useState(false);
  const [showWaConnect, setShowWaConnect] = useState(false);
  const [waTestFor, setWaTestFor] = useState<IntegrationView | null>(null);
  const [showFbConnect, setShowFbConnect] = useState(false);
  const [showLiPost, setShowLiPost] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const busy = connect.isPending || test.isPending || disconnect.isPending;
  const guard = () => {
    if (!canManage) { toast.error('You need the “Manage integrations” permission.'); return false; }
    return true;
  };

  if (isLoading) return <LoadingState label="Loading integrations…" />;
  if (isError) return <ErrorState message="Could not load integrations." onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      {!embedded && <PageHeader title="Integrations" subtitle="Connect the channels and services Green Start sends through" />}

      {/* ── Social Media Accounts ─────────────────────────────────────────── */}
      <Card className="p-5">
        <SectionHead title="Social Media Accounts" subtitle="Connect social profiles for this workspace."
          cta={<Button size="sm" disabled={!canManage || busy} onClick={() => guard() && setShowSocial(true)}><Plus size={15} /> Connect Social Media Accounts</Button>} />
        {/* Facebook Page — connectable with your own token, no OAuth app needed */}
        <div className="mb-3 rounded-[10px] border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-blue/10 text-blue"><Facebook size={16} /></span>
              <div className="leading-tight">
                <div className="text-sm font-medium text-ink">Facebook Page</div>
                <div className="text-xs text-muted">
                  {fb?.pageSelected
                    ? <>Publishing to <b className="text-ink">{fb.pageName}</b>{fb.instagramLinked ? ` · Instagram @${fb.instagramUsername} linked` : ''}</>
                    : fb?.connected
                      ? 'Connected — choose which Page to publish to'
                      : 'Post to a Page you administer. Personal profiles cannot be posted to by any API.'}
                </div>
                {fb?.lastError && <div className="text-xs text-red">{fb.lastError}</div>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {fb?.pageSelected && <Badge tone="green">Connected</Badge>}
              {fb?.needsReauth && <Badge tone="orange">Reauth needed</Badge>}
              <Button variant={fb?.pageSelected ? 'secondary' : 'primary'} size="sm" disabled={!canManage}
                onClick={() => guard() && setShowFbConnect(true)}>
                <KeyRound size={14} /> {fb?.pageSelected ? 'Change Page / token' : 'Connect with token'}
              </Button>
            </div>
          </div>
        </div>

        {/* LinkedIn — posts as the connected member, personal profiles supported */}
        <div className="mb-3 rounded-[10px] border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-blue/10 text-blue"><Linkedin size={16} /></span>
              <div className="leading-tight">
                <div className="text-sm font-medium text-ink">LinkedIn</div>
                <div className="text-xs text-muted">
                  {li?.connected
                    ? <>Posting as <b className="text-ink">{li.displayName ?? 'your LinkedIn member'}</b></>
                    : li?.configured
                      ? 'Sign in with LinkedIn to post to your own profile feed.'
                      : 'Not configured on the server — add LinkedIn app credentials to enable sign-in.'}
                </div>
                {li?.expiresAt && li.connected && (
                  <div className="text-xs text-muted">Access expires {new Date(li.expiresAt).toLocaleDateString()}</div>
                )}
                {li?.lastError && <div className="text-xs text-red">{li.lastError}</div>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {li?.connected && <Badge tone="green">Connected</Badge>}
              {li?.needsReauth && <Badge tone="orange">Reconnect needed</Badge>}
              {li?.connected && (
                <Button variant="secondary" size="sm" onClick={() => setShowLiPost(true)}><Send size={14} /> Send test post</Button>
              )}
              <Button variant={li?.connected ? 'secondary' : 'primary'} size="sm"
                disabled={!canManage || busy || !li?.configured}
                onClick={() => guard() && connect.mutate('linkedin')}>
                <LogIn size={14} /> {li?.connected ? 'Reconnect' : 'Sign in with LinkedIn'}
              </Button>
              {li?.connected && (
                <Button variant="danger" size="sm" loading={liDisconnect.isPending} onClick={() => liDisconnect.mutate()}>
                  <PlugZap size={14} /> Disconnect
                </Button>
              )}
            </div>
          </div>
          {!li?.configured && (
            <p className="mt-2 text-xs text-muted">
              Needs <code>LINKEDIN_CLIENT_ID</code>, <code>LINKEDIN_CLIENT_SECRET</code> and
              <code className="ml-1">LINKEDIN_REDIRECT_URI</code> in the server’s <code>.env</code>.
            </p>
          )}
        </div>

        {socialRows.length === 0 ? (
          <EmptyBox>No OAuth-connected social accounts yet.</EmptyBox>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {socialRows.map((it) => (
              <AccountTile key={it.provider} it={it} busy={busy} canManage={canManage}
                onReconnect={() => connect.mutate(it.provider)}
                onDisconnect={() => it.id && disconnect.mutate(it.id)}
                onTest={() => it.id && test.mutate(it.id)} />
            ))}
          </div>
        )}
      </Card>

      {/* ── CRMs & Integrations ───────────────────────────────────────────── */}
      <Card className="p-5">
        <SectionHead title="CRMs & Integrations" subtitle="Connect tools and CRMs for this workspace."
          cta={<Button size="sm" disabled={!canManage} onClick={() => guard() && setShowCrm(true)}><Plus size={15} /> Connect CRM Accounts</Button>} />
        <EmptyBox>No CRMs or other integrations connected yet.</EmptyBox>
      </Card>

      {/* ── Communication Providers ───────────────────────────────────────── */}
      <Card className="p-5">
        <div className="mb-4">
          <div className="font-display font-semibold text-ink">Communication Providers</div>
          <div className="text-sm text-muted">Manage WhatsApp, SMS, voice and email gateways for this workspace.</div>
        </div>

        <div className="space-y-4">
          {/* WhatsApp — real Meta Cloud API */}
          <ProviderRow icon={MessageCircle} title="WhatsApp Accounts" subtitle="Meta WhatsApp Business Cloud API"
            cta={<Button size="sm" disabled={!canManage || busy} onClick={() => guard() && setShowWaConnect(true)}><Plus size={15} /> Add New</Button>}>
            {whatsapp && isLive(whatsapp.status) ? (
              <div className="flex items-center justify-between gap-3 rounded-[10px] border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-green-3 text-green-2"><MessageCircle size={15} /></span>
                  <div className="leading-tight">
                    <div className="text-sm font-medium text-ink">{whatsapp.displayName ?? 'WhatsApp Business'}</div>
                    <div className="text-xs text-muted">{whatsapp.externalAccountId ? `WABA ID: ${whatsapp.externalAccountId}` : whatsapp.label}</div>
                    {whatsapp.lastError && <div className="text-xs text-red">{whatsapp.lastError}</div>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[whatsapp.status].tone}>{STATUS[whatsapp.status].label}</Badge>
                  {whatsapp.id && <Button variant="secondary" size="sm" disabled={busy} onClick={() => test.mutate(whatsapp.id!)}><Wifi size={14} /> Test</Button>}
                  {whatsapp.id && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setWaTestFor(whatsapp)}><Send size={14} /> Send test</Button>}
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => guard() && setShowWaConnect(true)}><KeyRound size={14} /> Update credentials</Button>
                  {whatsapp.id && <Button variant="danger" size="sm" disabled={busy} onClick={() => disconnect.mutate(whatsapp.id!)}><PlugZap size={14} /> Disconnect</Button>}
                </div>
              </div>
            ) : (
              <EmptyBox>
                No WhatsApp account connected yet. Click “Add New” and enter your WhatsApp
                Cloud API credentials from Meta — no Meta app needs to be configured on this server.
                {whatsapp?.oauthConfigured && ' You can also authorise with Meta via OAuth.'}
              </EmptyBox>
            )}
          </ProviderRow>

          <ProviderRow icon={CreditCard} title="Payment Configurations" subtitle="WhatsApp In-Chat Payments — UPI, Razorpay, PayU"
            cta={<Button variant="secondary" size="sm" onClick={() => setUnavailable('Payment configurations')}><Plus size={15} /> Add Config</Button>}>
            <EmptyBox>No payment configurations yet. Click “Add Config” to get started.</EmptyBox>
          </ProviderRow>

          <ProviderRow icon={Radio} title="SmartPing Accounts" subtitle="Manage SMS, RCS &amp; Voice"
            cta={<Button variant="secondary" size="sm" onClick={() => setShowSmartPing(true)}><Plus size={15} /> Connect New</Button>}>
            <EmptyBox>No accounts connected yet.</EmptyBox>
          </ProviderRow>

          <ProviderRow icon={Mic} title="Sparc Voice Accounts" subtitle="Manage Voice"
            cta={<Button variant="secondary" size="sm" onClick={() => setUnavailable('Sparc Voice')}><Plus size={15} /> Connect New</Button>}>
            <EmptyBox>No accounts connected yet.</EmptyBox>
          </ProviderRow>

          <ProviderRow icon={Bot} title="RCS Assistants" subtitle="Manage your conversational agents"
            cta={<Button variant="secondary" size="sm" onClick={() => setUnavailable('RCS Assistants')}><Plus size={15} /> Create New</Button>}>
            <EmptyBox>No assistants found. You haven’t created any RCS agents for this workspace yet.</EmptyBox>
          </ProviderRow>

          <ProviderRow icon={Smartphone} title="JIOCX Accounts" subtitle="Manage SMS, RCS &amp; Voice"
            cta={<Button variant="secondary" size="sm" onClick={() => setUnavailable('JIOCX')}><Plus size={15} /> Connect New</Button>}>
            <EmptyBox>No accounts connected yet.</EmptyBox>
          </ProviderRow>

          {/* SMS — this workspace's own MSG91 account (its own DLT sender id) */}
          <ProviderRow icon={Smartphone} title="SMS (MSG91)" subtitle="This workspace’s own MSG91 account and DLT sender id"
            cta={sms?.connected ? null : (
              <Button size="sm" disabled={!canManage || channelBusy || sms === null} onClick={() => guard() && setShowSms(true)}><Plus size={15} /> Connect</Button>
            )}>
            {sms?.connected ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green-3 text-green-2"><Smartphone size={15} /></span>
                  <div className="min-w-0 leading-tight">
                    <div className="truncate text-sm font-medium text-ink">{sms.displayName ?? `MSG91 · ${sms.settings?.senderId ?? ''}`}</div>
                    {sms.settings && (
                      <div className="truncate text-xs text-muted">
                        Sender {sms.settings.senderId} · {sms.settings.route === '1' ? 'Promotional' : 'Transactional'} route · +{sms.settings.defaultCountryCode}
                      </div>
                    )}
                    {sms.detail && <div className="text-xs text-muted">{sms.detail}</div>}
                    {sms.lastError && <div className="text-xs text-red">{sms.lastError}</div>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[sms.status].tone}>{STATUS[sms.status].label}</Badge>
                  <Button variant="secondary" size="sm" disabled={channelBusy} loading={smsVerify.isPending} onClick={() => smsVerify.mutate()}><Wifi size={14} /> Test</Button>
                  <Button variant="secondary" size="sm" disabled={channelBusy} onClick={() => setShowSmsTest(true)}><Send size={14} /> Send test</Button>
                  <Button variant="secondary" size="sm" disabled={!canManage || channelBusy} onClick={() => guard() && setShowSms(true)}><KeyRound size={14} /> Update credentials</Button>
                  <Button variant="danger" size="sm" disabled={!canManage || channelBusy} loading={smsDisconnect.isPending} onClick={() => smsDisconnect.mutate()}><PlugZap size={14} /> Disconnect</Button>
                </div>
              </div>
            ) : (
              <EmptyBox>
                {smsQ.isPending ? 'Loading…'
                  : smsQ.isError ? 'Could not load this workspace’s SMS settings.'
                  : sms === null ? 'SMS settings live on the Green Start API, and this build is running against mock data.'
                  : <>
                      No MSG91 account connected. SMS from this workspace is sent with its own MSG91 auth key and
                      DLT-registered sender id — under DLT rules it cannot use another organisation’s.
                      {' '}<SenderStatus sender={sms.sender} channel="SMS" />
                    </>}
              </EmptyBox>
            )}
          </ProviderRow>

          {/* Email — this workspace's own mailbox (SMTP) */}
          <ProviderRow icon={Mail} title="Email (SMTP)" subtitle="This workspace’s own mailbox — campaign email is sent from it"
            cta={email?.connected ? null : (
              <Button size="sm" disabled={!canManage || channelBusy || email === null} onClick={() => guard() && setShowEmail(true)}><Plus size={15} /> Connect</Button>
            )}>
            {email?.connected ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green-3 text-green-2"><Mail size={15} /></span>
                  <div className="min-w-0 leading-tight">
                    <div className="truncate text-sm font-medium text-ink">{email.displayName ?? email.settings?.from ?? 'Mailbox'}</div>
                    {email.settings && (
                      <div className="truncate text-xs text-muted">
                        {email.settings.host}:{email.settings.port} · {email.settings.secure ? 'SSL/TLS' : 'STARTTLS'} · {email.settings.username}
                      </div>
                    )}
                    {email.lastError && <div className="text-xs text-red">{email.lastError}</div>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[email.status].tone}>{STATUS[email.status].label}</Badge>
                  <Button variant="secondary" size="sm" disabled={channelBusy} loading={emailVerify.isPending} onClick={() => emailVerify.mutate()}><Wifi size={14} /> Test</Button>
                  <Button variant="secondary" size="sm" disabled={channelBusy} onClick={() => setShowEmailTest(true)}><Send size={14} /> Send test</Button>
                  <Button variant="secondary" size="sm" disabled={!canManage || channelBusy} onClick={() => guard() && setShowEmail(true)}><KeyRound size={14} /> Update credentials</Button>
                  <Button variant="danger" size="sm" disabled={!canManage || channelBusy} loading={emailDisconnect.isPending} onClick={() => emailDisconnect.mutate()}><PlugZap size={14} /> Disconnect</Button>
                </div>
              </div>
            ) : (
              <EmptyBox>
                {emailQ.isPending ? 'Loading…'
                  : emailQ.isError ? 'Could not load this workspace’s email settings.'
                  : email === null ? 'Email settings live on the Green Start API, and this build is running against mock data.'
                  : <>
                      No mailbox connected. Campaign email from this workspace is sent from its own mailbox —
                      click “Connect” and enter its SMTP settings (Gmail needs an App Password).
                      {' '}<SenderStatus sender={email.sender} channel="email" />
                    </>}
              </EmptyBox>
            )}
          </ProviderRow>
        </div>
      </Card>

      {/* ── Google Analytics ──────────────────────────────────────────────── */}
      <Card className="p-5">
        <SectionHead title="Google Analytics" subtitle="Sync your GA4 property for advanced reporting."
          cta={<Button variant="secondary" size="sm" onClick={() => setUnavailable('Google Analytics')}><Plug size={15} /> Connect Account</Button>} />
        <EmptyBox>No Google Analytics property connected yet.</EmptyBox>
      </Card>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {showSocial && (
        <PickerModal title="Connect Social Account"
          subtitle={`You currently have ${socialRows.length} social account${socialRows.length === 1 ? '' : 's'} connected. Select a platform below to add another.`}
          items={SOCIAL_PLATFORMS.map((p) => ({
            key: p.key, label: p.label, icon: p.icon, enabled: !!p.provider, note: p.note,
            onAdd: () => { setShowSocial(false); if (p.provider) connect.mutate(p.provider); },
          }))}
          onClose={() => setShowSocial(false)} />
      )}

      {showCrm && (
        <PickerModal title="Connect CRM or Integration"
          subtitle="You currently have 0 CRM accounts connected. Select a platform below to add another."
          items={CRM_PROVIDERS.map((p) => ({ key: p.key, label: p.label, icon: p.icon, enabled: false, onAdd: () => {} }))}
          onClose={() => setShowCrm(false)} />
      )}

      {showWaConnect && (
        <ConnectWhatsAppModal orgId={orgId} existing={whatsapp}
          canOauth={!!whatsapp?.oauthConfigured}
          onOauth={() => { setShowWaConnect(false); connect.mutate('whatsapp'); }}
          onClose={() => setShowWaConnect(false)}
          onConnected={(row) => { setShowWaConnect(false); invalidate(); toast.success('WhatsApp connected — Meta accepted these credentials'); setWaTestFor(row); }} />
      )}
      {waTestFor?.id && (
        <SendTestMessageModal orgId={orgId} integrationId={waTestFor.id} account={waTestFor}
          onClose={() => setWaTestFor(null)} />
      )}
      {showFbConnect && (
        <ConnectFacebookPageModal
          canOauth={!!byProvider('facebook')?.oauthConfigured}
          onOauth={() => { setShowFbConnect(false); connect.mutate('facebook'); }}
          onClose={() => setShowFbConnect(false)}
          onChanged={refreshFb} />
      )}
      {showLiPost && (
        <LinkedInTestPostModal author={li?.displayName} onClose={() => setShowLiPost(false)}
          onPosted={() => liQ.refetch()} />
      )}
      {showEmail && (
        <ConnectEmailModal orgId={orgId} existing={email}
          onClose={() => setShowEmail(false)}
          onSaved={(v) => {
            setShowEmail(false);
            qc.setQueryData(['email-provider', orgId], v);
            refreshEmail();
            toast.success('Mailbox connected — the mail server accepted these credentials');
            setShowEmailTest(true);
          }} />
      )}
      {showEmailTest && <EmailTestModal orgId={orgId} account={email} onClose={() => setShowEmailTest(false)} onSent={refreshEmail} />}
      {showSms && (
        <ConnectSmsModal orgId={orgId} existing={sms}
          onClose={() => setShowSms(false)}
          onSaved={(v) => {
            setShowSms(false);
            qc.setQueryData(['sms-provider', orgId], v);
            refreshSms();
            toast.info('MSG91 saved — not verified yet. MSG91 validates on the first send; send a test to prove it.');
          }} />
      )}
      {showSmsTest && <SmsTestModal orgId={orgId} account={sms} onClose={() => setShowSmsTest(false)} onSent={refreshSms} />}
      {showSmartPing && <ConnectSmartPingModal onClose={() => setShowSmartPing(false)} />}
      {unavailable && (
        <Modal open onClose={() => setUnavailable(null)} title={`Connect ${unavailable}`} size="sm"
          footer={<Button variant="secondary" size="sm" onClick={() => setUnavailable(null)}>Close</Button>}>
          <NotConfigured what={unavailable} />
        </Modal>
      )}
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────
function SectionHead({ title, subtitle, cta }: { title: string; subtitle: string; cta?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <div className="font-display font-semibold text-ink">{title}</div>
        <div className="text-sm text-muted">{subtitle}</div>
      </div>
      {cta}
    </div>
  );
}

function ProviderRow({ icon: Icon, title, subtitle, cta, children }: {
  icon: Icon; title: string; subtitle: string; cta: ReactNode; children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-[8px] bg-surface-2 text-accent"><Icon size={16} /></span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink">{title}</div>
            <div className="text-xs text-muted">{subtitle}</div>
          </div>
        </div>
        {cta}
      </div>
      {children}
    </div>
  );
}

function EmptyBox({ children }: { children: ReactNode }) {
  return <div className="rounded-[10px] border border-dashed border-line px-4 py-5 text-center text-xs text-muted">{children}</div>;
}

function AccountTile({ it, busy, canManage, onReconnect, onDisconnect, onTest }: {
  it: IntegrationView; busy: boolean; canManage: boolean;
  onReconnect: () => void; onDisconnect: () => void; onTest: () => void;
}) {
  const def = SOCIAL_PLATFORMS.find((p) => p.provider === it.provider && p.key === it.provider);
  const Icon = def?.icon ?? Plug;
  const s = STATUS[it.status];
  return (
    <div className="rounded-[10px] border border-line p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-[8px] bg-surface-2 text-accent"><Icon size={16} /></span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium text-ink">{it.displayName ?? it.label}</div>
            <div className="text-xs capitalize text-muted">{it.provider}</div>
          </div>
        </div>
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${it.status === 'CONNECTED' ? 'bg-green-2' : it.status === 'ERROR' ? 'bg-red' : 'bg-orange'}`} title={s.label} />
      </div>
      {it.lastError && <p className="mb-2 rounded-[8px] bg-red/5 p-2 text-[11px] text-red">{it.lastError}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="sm" disabled={!canManage || busy} onClick={onReconnect}><RefreshCw size={14} /> Reconnect</Button>
        <Button variant="danger" size="sm" disabled={!canManage || busy} onClick={onDisconnect}><PlugZap size={14} /> Disconnect</Button>
      </div>
      {it.id && <button type="button" className="mt-2 w-full text-center text-[11px] text-muted hover:text-ink" onClick={onTest}>Test connection</button>}
    </div>
  );
}

function NotConfigured({ what }: { what: string }) {
  return (
    <div className="flex items-start gap-2 rounded-[10px] border border-orange/30 bg-orange/5 p-3 text-sm text-orange">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{what} isn’t configured on the server yet. Add the provider credentials server-side to enable a real connection — nothing is stored until then.</span>
    </div>
  );
}

// ── Platform picker modal (social / CRM) ─────────────────────────────────────
type PickerItem = { key: string; label: string; icon: Icon; enabled: boolean; note?: string; onAdd: () => void };
function PickerModal({ title, subtitle, items, onClose }: { title: string; subtitle: string; items: PickerItem[]; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={title} size="sm"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-sm text-muted">{subtitle}</p>
      <div className="divide-y divide-line rounded-[10px] border border-line">
        {items.map((i) => {
          const Icon = i.icon;
          return (
            <div key={i.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Icon size={16} className={i.enabled ? 'text-accent' : 'text-muted'} />
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">{i.label}</div>
                  {i.note && <div className="text-[11px] text-muted">{i.note}</div>}
                  {!i.enabled && <div className="text-[11px] text-muted">Not configured on the server</div>}
                </div>
              </div>
              <button type="button" disabled={!i.enabled} onClick={i.onAdd}
                className={`shrink-0 text-sm font-medium ${i.enabled ? 'text-accent hover:underline' : 'cursor-not-allowed text-muted opacity-60'}`}>
                Add +
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ── Email & SMS: this workspace's own providers ──────────────────────────────
/**
 * Email (SMTP) and SMS (MSG91) are connected PER WORKSPACE, like WhatsApp: each
 * organisation sends from its own mailbox and under its own DLT sender id. The
 * server proves an SMTP login before saving; MSG91 offers no free check, so an
 * SMS account is saved as "present, not verified" until a send succeeds.
 *
 * Secrets are write-only. A password / auth key field is never pre-filled from
 * the server — the server never sends it — and a blank one on an update means
 * "keep the stored one".
 */

/** What happens to this workspace's email / SMS while it has no account of its own. */
function SenderStatus({ sender, channel }: { sender: SenderView; channel: 'email' | 'SMS' }) {
  if (sender.ready && sender.source === 'platform') {
    return <span>Until then, {channel} goes out through the platform’s shared sender, which the operator has enabled for this workspace.</span>;
  }
  if (sender.ready) return null;
  return <span className="text-orange">Until then, {channel} campaigns from this workspace cannot be sent.</span>;
}

/** The server's message, plus per-field validation messages when there are any. */
function errorText(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  const details = (e as Error & { details?: Array<{ field: string; message: string }> }).details;
  return details?.length ? `${e.message}: ${details.map((d) => d.message).join('; ')}` : e.message;
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-[10px] border border-red/40 bg-red/5 p-3 text-sm text-red">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function ResultBox({ result }: { result: { ok: boolean; detail: string } }) {
  return (
    <div className={`rounded-[10px] border p-3 text-sm ${result.ok ? 'border-green-2/40 bg-green-3 text-green-2' : 'border-red/40 bg-red/5 text-red'}`}>
      {result.detail}
    </div>
  );
}

const SMTP_PRESETS: { label: string; host: string; port: number; secure: boolean }[] = [
  { label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, secure: false },
  { label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 587, secure: false },
];

// ── Connect / update this workspace's mailbox ────────────────────────────────
function ConnectEmailModal({ orgId, existing, onClose, onSaved }: {
  orgId: string;
  existing: EmailProviderView | null;
  onClose: () => void;
  onSaved: (view: EmailProviderView) => void;
}) {
  const s = existing?.settings;
  const [host, setHost] = useState(s?.host ?? '');
  const [port, setPort] = useState(String(s?.port ?? 587));
  const [secure, setSecure] = useState(s?.secure ?? false);
  const [username, setUsername] = useState(s?.username ?? '');
  // Write-only: never pre-filled. The server does not send the password back.
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(s?.from ?? '');
  const [fromName, setFromName] = useState(s?.fromName ?? '');
  const [replyTo, setReplyTo] = useState(s?.replyTo ?? '');
  const [err, setErr] = useState<string | null>(null);

  // A stored password can be kept only for the same server and login — the API
  // refuses to replay it anywhere else, so the form says so up front.
  const canKeepPassword = !!existing?.hasSecret && !!s
    && s.host.toLowerCase() === host.trim().toLowerCase() && s.username === username.trim();
  const isGmail = /(^|\.)(gmail|googlemail)\.com$/i.test(host.trim());

  const save = useMutation({
    mutationFn: () => integrationsService.connectEmail(orgId, {
      host: host.trim(),
      port: Number(port),
      secure,
      username: username.trim(),
      password: password || undefined,
      from: from.trim(),
      fromName: fromName.trim() || undefined,
      replyTo: replyTo.trim() || undefined,
    }),
    onSuccess: (view) => { setPassword(''); onSaved(view); },
    onError: (e: unknown) => setErr(errorText(e, 'The mail server rejected these settings')),
  });

  const onPort = (v: string) => {
    setPort(v);
    if (v === '465') setSecure(true);
    else if (v === '587') setSecure(false);
  };

  const submit = () => {
    setErr(null);
    const portN = Number(port);
    if (!host.trim()) { setErr('Enter the mail server, e.g. smtp.gmail.com.'); return; }
    if (!Number.isInteger(portN) || portN < 1 || portN > 65535) { setErr('Port is a number — usually 587, or 465 for SSL/TLS.'); return; }
    if (!username.trim()) { setErr('Enter the SMTP username — usually the full email address.'); return; }
    if (!password && !canKeepPassword) {
      setErr(existing?.hasSecret ? 'Enter the password again — the server or username changed.' : 'Enter the SMTP password.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+/.test(from.replace(/^.*</, '').replace(/>.*$/, '').trim())) {
      setErr('From must be an email address, e.g. hello@yourcompany.com.');
      return;
    }
    save.mutate();
  };

  return (
    <Modal open onClose={onClose} size="md"
      title={existing?.connected ? 'Update email (SMTP) credentials' : 'Connect this workspace’s mailbox'}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={save.isPending} onClick={submit}><ShieldCheck size={15} /> Verify &amp; connect</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Campaign email from this workspace is sent from this mailbox. Green Start logs in to the mail server
          before saving (nothing is sent), stores the password encrypted, and never sends it back to the browser.
        </p>

        <div className="flex flex-wrap gap-2">
          {SMTP_PRESETS.map((p) => (
            <Button key={p.host} variant={host === p.host ? 'primary' : 'secondary'} size="sm"
              onClick={() => { setHost(p.host); setPort(String(p.port)); setSecure(p.secure); }}>
              {p.label}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_110px]">
          <Field label="SMTP server">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourcompany.com" autoFocus spellCheck={false} />
          </Field>
          <Field label="Port">
            <Input value={port} onChange={(e) => onPort(e.target.value)} inputMode="numeric" placeholder="587" />
          </Field>
        </div>
        <label className="flex items-start gap-2">
          <Checkbox checked={secure} onChange={(e) => setSecure(e.target.checked)} className="mt-0.5" />
          <span className="text-sm text-ink">
            Use SSL/TLS on connect
            <span className="block text-xs text-muted">On for port 465. Off for 587 (STARTTLS upgrades the connection instead).</span>
          </span>
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Username" hint="Usually the full email address">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="hello@yourcompany.com"
              autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Password"
            hint={canKeepPassword ? 'Leave blank to keep the current password' : isGmail ? 'Gmail: a 16-character App Password' : undefined}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={canKeepPassword ? '•••••••• (unchanged)' : 'SMTP password'} autoComplete="new-password" />
          </Field>
        </div>
        <p className="text-xs text-muted">
          Gmail and Google Workspace need an <b className="text-ink">App Password</b> (Google Account → Security →
          2-Step Verification → App passwords), not your normal password.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From address" hint="Recipients see this. Must be allowed by the mailbox.">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="hello@yourcompany.com" spellCheck={false} />
          </Field>
          <Field label="From name" hint="Optional">
            <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your Company" />
          </Field>
        </div>
        <Field label="Reply-To" hint="Optional — where replies go, if not the From address">
          <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="support@yourcompany.com" spellCheck={false} />
        </Field>

        {err && <ErrorBox>{err}</ErrorBox>}
      </div>
    </Modal>
  );
}

// ── Send a real test email ───────────────────────────────────────────────────
/** Proves the whole path — the same resolution and adapter a campaign uses. */
function EmailTestModal({ orgId, account, onClose, onSent }: {
  orgId: string; account: EmailProviderView | null; onClose: () => void; onSent: () => void;
}) {
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());

  const send = useMutation({
    mutationFn: () => integrationsService.emailSendTest(orgId, to.trim()),
    onSuccess: (r) => {
      setResult(r.accepted
        ? { ok: true, detail: `Sent to ${to.trim()} — check the inbox and the spam folder.` }
        : { ok: false, detail: `${r.errorMessage ?? 'The mail server rejected it'}${r.errorCode ? ` [${r.errorCode}]` : ''}` });
      onSent();
    },
    onError: (e: unknown) => setResult({ ok: false, detail: errorText(e, 'Test send failed') }),
  });

  return (
    <Modal open onClose={onClose} title="Send a test email" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        <Button size="sm" loading={send.isPending} disabled={!valid}
          onClick={() => { setResult(null); send.mutate(); }}><Send size={15} /> Send</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Sends one real email from <b className="text-ink">{account?.settings?.from ?? account?.displayName ?? 'this workspace’s mailbox'}</b>.
          If it arrives, campaign email from this workspace works.
        </p>
        <Field label="Send to">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" autoFocus />
        </Field>
        {result && <ResultBox result={result} />}
      </div>
    </Modal>
  );
}

// ── Connect / update this workspace's MSG91 account ──────────────────────────
function ConnectSmsModal({ orgId, existing, onClose, onSaved }: {
  orgId: string;
  existing: SmsProviderView | null;
  onClose: () => void;
  onSaved: (view: SmsProviderView) => void;
}) {
  const s = existing?.settings;
  // Write-only: never pre-filled. The server does not send the key back.
  const [authKey, setAuthKey] = useState('');
  const [senderId, setSenderId] = useState(s?.senderId ?? '');
  const [route, setRoute] = useState<'1' | '4'>(s?.route === '1' ? '1' : '4');
  const [countryCode, setCountryCode] = useState(s?.defaultCountryCode ?? '91');
  const [dltEntityId, setDltEntityId] = useState(s?.dltEntityId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const canKeepKey = !!existing?.hasSecret;

  const save = useMutation({
    mutationFn: () => integrationsService.connectSms(orgId, {
      authKey: authKey.trim() || undefined,
      senderId: senderId.trim().toUpperCase(),
      route,
      defaultCountryCode: countryCode.replace(/\D/g, '') || '91',
      dltEntityId: dltEntityId.trim() || undefined,
    }),
    onSuccess: (view) => { setAuthKey(''); onSaved(view); },
    onError: (e: unknown) => setErr(errorText(e, 'These MSG91 settings were not accepted')),
  });

  const submit = () => {
    setErr(null);
    if (!authKey.trim() && !canKeepKey) { setErr('Enter the MSG91 auth key.'); return; }
    if (!/^[A-Za-z0-9]{3,11}$/.test(senderId.trim())) { setErr('Sender id is your DLT-registered header, e.g. TMLINK.'); return; }
    if (!/^\+?\d{1,4}$/.test(countryCode.trim())) { setErr('Default country code is 1–4 digits, e.g. 91.'); return; }
    save.mutate();
  };

  return (
    <Modal open onClose={onClose} size="md"
      title={existing?.connected ? 'Update SMS (MSG91) credentials' : 'Connect this workspace’s MSG91 account'}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={save.isPending} onClick={submit}><KeyRound size={15} /> Save</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          SMS from this workspace is sent with this MSG91 account and sender id. The auth key is stored encrypted
          and never sent back to the browser.
        </p>
        <div className="flex items-start gap-2 rounded-[10px] border border-orange/30 bg-orange/5 p-3 text-xs text-orange">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            MSG91 has no free way to check a key without sending, so this is saved as <b>not verified</b>.
            MSG91 validates it on the first send — use “Send test” afterwards to prove it.
          </span>
        </div>

        <Field label="MSG91 auth key" hint={canKeepKey ? 'Leave blank to keep the current key' : 'MSG91 → Settings → API → Auth key'}>
          <Input type="password" value={authKey} onChange={(e) => setAuthKey(e.target.value)}
            placeholder={canKeepKey ? '•••••••• (unchanged)' : 'Auth key'} autoComplete="new-password" autoFocus={!canKeepKey} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Sender id (DLT header)" hint="Your own registered header, e.g. TMLINK">
            <Input value={senderId} onChange={(e) => setSenderId(e.target.value.toUpperCase())} placeholder="TMLINK" maxLength={11} />
          </Field>
          <Field label="Route">
            <Select value={route} onChange={(e) => setRoute(e.target.value === '1' ? '1' : '4')}>
              <option value="4">Transactional (4)</option>
              <option value="1">Promotional (1)</option>
            </Select>
          </Field>
          <Field label="Default country code" hint="Added to 10-digit numbers">
            <Input value={countryCode} onChange={(e) => setCountryCode(e.target.value)} inputMode="numeric" placeholder="91" />
          </Field>
          <Field label="DLT entity id (PE ID)" hint="Optional — for your reference">
            <Input value={dltEntityId} onChange={(e) => setDltEntityId(e.target.value)} placeholder="1201…" />
          </Field>
        </div>
        <p className="text-xs text-muted">
          Under India’s DLT rules each business sends only under the header and templates it registered itself —
          so every organisation connects its own MSG91 account here. Each SMS template also needs its MSG91 Flow ID.
        </p>

        {err && <ErrorBox>{err}</ErrorBox>}
      </div>
    </Modal>
  );
}

// ── Send a real test SMS ─────────────────────────────────────────────────────
/** One real DLT-registered SMS — the only proof MSG91 offers. The verdict shown is MSG91's own. */
function SmsTestModal({ orgId, account, onClose, onSent }: {
  orgId: string; account: SmsProviderView | null; onClose: () => void; onSent: () => void;
}) {
  const [to, setTo] = useState('');
  const [flowId, setFlowId] = useState('');
  const [vars, setVars] = useState<string[]>(['', '', '']);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const send = useMutation({
    mutationFn: () => {
      const variables: Record<string, string> = {};
      vars.forEach((v, i) => { if (v.trim()) variables[String(i + 1)] = v.trim(); });
      return integrationsService.smsSendTest(orgId, {
        to: to.trim(), flowId: flowId.trim(),
        variables: Object.keys(variables).length ? variables : undefined,
      });
    },
    onSuccess: (r) => {
      setResult(r.accepted
        ? { ok: true, detail: `MSG91 accepted the message${r.providerMessageId ? ` (request ${r.providerMessageId})` : ''}.` }
        : { ok: false, detail: `${r.errorMessage ?? 'Rejected'}${r.errorCode ? ` [${r.errorCode}]` : ''}` });
      onSent();
    },
    onError: (e: unknown) => setResult({ ok: false, detail: errorText(e, 'Send failed') }),
  });

  return (
    <Modal open onClose={onClose} title="Send a test SMS" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        <Button size="sm" loading={send.isPending} disabled={to.trim().length < 8 || !flowId.trim()}
          onClick={() => { setResult(null); send.mutate(); }}><Send size={15} /> Send</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Sends one real SMS as <b className="text-ink">{account?.settings?.senderId ?? 'your sender id'}</b> through
          MSG91. Indian SMS can only carry a DLT-registered body, so choose a Flow (template) id from your MSG91 account.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Mobile number" hint="e.g. 919876543210 or 9876543210">
            <Input value={to} onChange={(e) => setTo(e.target.value)} inputMode="tel" placeholder="9876543210" autoFocus />
          </Field>
          <Field label="Flow (template) id" hint="MSG91 → SMS → Flow">
            <Input value={flowId} onChange={(e) => setFlowId(e.target.value)} placeholder="64f…" spellCheck={false} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {vars.map((v, i) => (
            <Field key={i} label={`VAR${i + 1}`} hint="Optional">
              <Input value={v} onChange={(e) => setVars((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
            </Field>
          ))}
        </div>
        {result && <ResultBox result={result} />}
      </div>
    </Modal>
  );
}

// ── Connect SmartPing modal ──────────────────────────────────────────────────
function ConnectSmartPingModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState('sms');
  const [senderId, setSenderId] = useState('');
  const [dltId, setDltId] = useState('');
  const [systemGateway, setSystemGateway] = useState(true);
  return (
    <Modal open onClose={onClose} title="Connect Account" size="md"
      footer={<><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled title="SmartPing isn’t configured on the server yet">Save Configuration</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Enter your SmartPing credentials below.</p>
        <NotConfigured what="SmartPing" />
        <Tabs tabs={[{ key: 'sms', label: 'SMS (DLT)' }, { key: 'rcs', label: 'RCS Business' }, { key: 'voice', label: 'Voice (OBD)' }]} active={tab} onChange={setTab} />
        <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
          <Field label="Sender ID (Header)"><Input value={senderId} onChange={(e) => setSenderId(e.target.value)} placeholder="JIOJIO" /></Field>
          <Field label="DLT Entity ID (PE ID)"><Input value={dltId} onChange={(e) => setDltId(e.target.value)} placeholder="12011…" /></Field>
        </div>
        <label className="flex items-start gap-2 rounded-[10px] border border-line p-3">
          <Checkbox checked={systemGateway} onChange={(e) => setSystemGateway((e.target as HTMLInputElement).checked)} className="mt-0.5" />
          <span><span className="block text-sm font-medium text-ink">Use System Gateway</span>
            <span className="block text-xs text-muted">Use the platform’s default gateway (credits deducted per SMS). Uncheck to use your own SmartPing credentials.</span></span>
        </label>
      </div>
    </Modal>
  );
}

// ── Connect WhatsApp Cloud API ───────────────────────────────────────────────
/**
 * The business pastes its OWN Meta credentials. Nothing is stored until the
 * server has proved them against the Graph API, so "Connected" always means
 * Meta answered — never that we accepted a string. The token is write-only: it
 * goes to the server once and is never read back into the browser.
 */
function ConnectWhatsAppModal({ orgId, existing, canOauth, onOauth, onClose, onConnected }: {
  orgId: string;
  existing?: IntegrationView;
  canOauth: boolean;
  onOauth: () => void;
  onClose: () => void;
  onConnected: (row: IntegrationView) => void;
}) {
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => integrationsService.connectWithCredentials(orgId, 'whatsapp', {
      accessToken: accessToken.trim(),
      phoneNumberId: phoneNumberId.trim() || undefined,
      wabaId: wabaId.trim() || undefined,
      label: label.trim() || undefined,
    }),
    onSuccess: (row) => { setAccessToken(''); onConnected(row); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Meta rejected these credentials'),
  });

  const submit = () => {
    setErr(null);
    if (!/^\d{5,}$/.test(phoneNumberId.trim())) { setErr('Phone Number ID is the long numeric ID from Meta — not the phone number itself.'); return; }
    if (accessToken.trim().length < 20) { setErr('Paste the full access token from Meta.'); return; }
    save.mutate();
  };

  return (
    <Modal open onClose={onClose} size="md"
      title={existing && isLive(existing.status) ? 'Update WhatsApp credentials' : 'Connect WhatsApp Business Cloud API'}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={save.isPending} onClick={submit}><ShieldCheck size={15} /> Verify &amp; connect</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Enter the credentials from your Meta app. Green Start checks them against Meta before
          saving, stores the token encrypted on the server, and never sends it back to the browser.
        </p>

        <Field label="WhatsApp Phone Number ID" hint="Meta → WhatsApp → API Setup → “Phone number ID” (numbers only)">
          <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)}
            inputMode="numeric" placeholder="e.g. 123456789012345" autoFocus />
        </Field>

        <Field label="WhatsApp Business Account ID" hint="Optional — Green Start looks it up from the number if you leave this blank">
          <Input value={wabaId} onChange={(e) => setWabaId(e.target.value)} inputMode="numeric" placeholder="e.g. 987654321098765" />
        </Field>

        <Field label="Permanent access token" hint="System User token from Meta Business Settings. A 24-hour temporary token works for testing.">
          <Textarea value={accessToken} onChange={(e) => setAccessToken(e.target.value)} rows={3}
            placeholder="EAAG…" spellCheck={false} autoComplete="off" />
        </Field>

        <Field label="Display name" hint="Optional label for this account inside Green Start">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Teamlink Medical — main line" />
        </Field>

        {err && (
          <div className="flex gap-2 rounded-[10px] border border-red/40 bg-red/5 p-3 text-sm text-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="rounded-[10px] border border-line bg-surface-2 p-3 text-xs text-muted">
          <div className="mb-1 font-medium text-ink">Where to find these</div>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>developers.facebook.com → your app → <b>WhatsApp → API Setup</b> — copy the Phone number ID and WhatsApp Business Account ID.</li>
            <li>business.facebook.com → <b>Business settings → Users → System users</b> — add a system user, give it your WhatsApp app and WABA, then <b>Generate new token</b> with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>.</li>
            <li>Add the recipient under <b>API Setup → To</b> until your number is out of test mode.</li>
          </ol>
          <a className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
            href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noreferrer">
            Meta’s Cloud API guide <ExternalLink size={12} />
          </a>
        </div>

        {canOauth && (
          <button type="button" onClick={onOauth} className="text-sm text-accent hover:underline">
            Or authorise with Meta instead (OAuth)
          </button>
        )}
      </div>
    </Modal>
  );
}

// ── Send a real test message ─────────────────────────────────────────────────
/** Proves the connection end-to-end. The result shown is Meta's own verdict. */
function SendTestMessageModal({ orgId, integrationId, account, onClose }: {
  orgId: string; integrationId: string; account: IntegrationView; onClose: () => void;
}) {
  const [to, setTo] = useState('');
  const [mode, setMode] = useState<'template' | 'text'>('template');
  const [templateName, setTemplateName] = useState('hello_world');
  const [templateLanguage, setTemplateLanguage] = useState('en_US');
  const [text, setText] = useState('Test message from Green Start.');
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const send = useMutation({
    mutationFn: () => integrationsService.sendTestMessage(orgId, integrationId, {
      to: to.trim(),
      ...(mode === 'template'
        ? { templateName: templateName.trim(), templateLanguage: templateLanguage.trim() || 'en_US' }
        : { text: text.trim() }),
    }),
    onSuccess: (r) => setResult(r.accepted
      ? { ok: true, detail: `Meta accepted the message${r.providerMessageId ? ` (id ${r.providerMessageId})` : ''}.` }
      : { ok: false, detail: `${r.errorMessage ?? 'Rejected'}${r.errorCode ? ` [${r.errorCode}]` : ''}` }),
    onError: (e: unknown) => setResult({ ok: false, detail: e instanceof Error ? e.message : 'Send failed' }),
  });

  return (
    <Modal open onClose={onClose} title="Send a test WhatsApp message" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        <Button size="sm" loading={send.isPending} disabled={to.trim().length < 8}
          onClick={() => { setResult(null); send.mutate(); }}><Send size={15} /> Send</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Sends one real message from <b className="text-ink">{account.displayName ?? 'your WhatsApp number'}</b> through
          Meta. Outside a 24-hour customer conversation only an approved template will deliver.
        </p>

        <Field label="Recipient" hint="International format, digits only — e.g. 919876543210">
          <Input value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" placeholder="919876543210" autoFocus />
        </Field>

        <div className="flex gap-2">
          <Button variant={mode === 'template' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('template')}>Template</Button>
          <Button variant={mode === 'text' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('text')}>Free text</Button>
        </div>

        {mode === 'template' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Template name" hint="“hello_world” ships with every new WhatsApp app">
              <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="hello_world" />
            </Field>
            <Field label="Language code">
              <Input value={templateLanguage} onChange={(e) => setTemplateLanguage(e.target.value)} placeholder="en_US" />
            </Field>
          </div>
        ) : (
          <Field label="Message" hint="Only delivers inside an open 24-hour conversation window">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </Field>
        )}

        {result && (
          <div className={`rounded-[10px] border p-3 text-sm ${result.ok ? 'border-green-2/40 bg-green-3 text-green-2' : 'border-red/40 bg-red/5 text-red'}`}>
            {result.detail}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Connect a Facebook Page with your own token ──────────────────────────────
/**
 * Three steps in one modal: paste a token → pick a Page → post a real test.
 * Meta validates the token before anything is stored, so "Connected" always
 * means Facebook answered. The token goes to the server once and is never read
 * back into the browser.
 */
function ConnectFacebookPageModal({ canOauth, onOauth, onClose, onChanged }: {
  canOauth: boolean; onOauth: () => void; onClose: () => void; onChanged: () => void;
}) {
  const [token, setToken] = useState('');
  const [pages, setPages] = useState<FacebookPageOption[] | null>(null);
  const [selectedPage, setSelectedPage] = useState<string | null>(null);
  const [pageName, setPageName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState('Hello from Green Start — this is a test post.');
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string; link?: string } | null>(null);

  const connectM = useMutation({
    mutationFn: () => publishingService.connectFacebookWithToken(token.trim()),
    onSuccess: (res) => {
      setErr(null);
      setToken('');
      setPages(res.pages);
      onChanged();
      if (res.kind === 'page' || res.pages.length === 1) {
        const only = res.pages[0];
        if (res.kind === 'page') {
          setSelectedPage(only?.id ?? null);
          setPageName(only?.name ?? null);
        }
      }
      setNotice(res.shortLived
        ? 'Connected. This token is short-lived — it will stop working in about an hour, and you can paste a fresh one then.'
        : res.note ?? 'Connected.');
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Facebook rejected this token'),
  });

  const selectM = useMutation({
    mutationFn: (pageId: string) => publishingService.selectFacebookPage(pageId),
    onSuccess: (st) => {
      setSelectedPage(st.pageId ?? null);
      setPageName(st.pageName ?? null);
      setNotice(st.instagramLinked
        ? `Publishing to ${st.pageName}. Instagram @${st.instagramUsername} is linked to this Page.`
        : `Publishing to ${st.pageName}.`);
      onChanged();
      toast.success(`Page selected — ${st.pageName}`);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not select that Page'),
  });

  const testM = useMutation({
    mutationFn: () => publishingService.facebookTestPost(testMsg.trim()),
    onSuccess: (r) => setTestResult(r.accepted
      ? { ok: true, detail: 'Published. Check your Page — the post should be there.', link: r.permalink }
      : { ok: false, detail: `${r.errorMessage ?? 'Rejected'}${r.errorCode ? ` [${r.errorCode}]` : ''}` }),
    onError: (e: unknown) => setTestResult({ ok: false, detail: e instanceof Error ? e.message : 'Test post failed' }),
  });

  return (
    <Modal open onClose={onClose} title="Connect a Facebook Page" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        {!selectedPage && (
          <Button size="sm" loading={connectM.isPending} disabled={token.trim().length < 20}
            onClick={() => { setErr(null); connectM.mutate(); }}><ShieldCheck size={15} /> Verify token</Button>
        )}
      </>}>
      <div className="space-y-3">
        {/* Step 1 — log in, or paste a token */}
        {!selectedPage && (
          <>
            {canOauth ? (
              <>
                <Button className="w-full" onClick={onOauth}>
                  <Facebook size={16} /> Continue with Facebook
                </Button>
                <p className="text-xs text-muted">
                  Opens Facebook’s own login page. You sign in there and choose which Page to
                  grant access to — your password never passes through Green Start.
                </p>
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span className="h-px flex-1 bg-line" /> or paste a token <span className="h-px flex-1 bg-line" />
                </div>
              </>
            ) : (
              <div className="rounded-[10px] border border-line bg-surface-2 p-3 text-xs text-muted">
                <b className="text-ink">“Continue with Facebook” isn’t switched on yet.</b> It needs
                <code className="mx-1">META_APP_ID</code>,<code className="mx-1">META_APP_SECRET</code> and
                <code className="mx-1">FACEBOOK_REDIRECT_URI</code> in the server’s <code>.env</code>.
                Until then, pasting a token below does exactly the same job.
              </div>
            )}

            <Field label="Facebook access token"
              hint="A User token (Green Start will list your Pages) or a Page token (that Page is used directly)">
              <Textarea value={token} onChange={(e) => setToken(e.target.value)} rows={3}
                placeholder="EAA…" spellCheck={false} autoComplete="off" />
            </Field>

            <div className="rounded-[10px] border border-line bg-surface-2 p-3 text-xs text-muted">
              <div className="mb-1 font-medium text-ink">Getting a token — about 5 minutes, no App Review</div>
              <ol className="list-decimal space-y-0.5 pl-4">
                <li>developers.facebook.com → <b>My Apps → Create App</b> → type <b>Business</b>. Leave it in Development mode.</li>
                <li>Open <b>Tools → Graph API Explorer</b>, pick your app in the dropdown.</li>
                <li>Under Permissions add <code>pages_show_list</code>, <code>pages_read_engagement</code> and <code>pages_manage_posts</code>.</li>
                <li>Click <b>Generate Access Token</b> and approve the Page when Facebook asks.</li>
                <li>Copy the token and paste it above.</li>
              </ol>
              <p className="mt-2">
                Development mode is enough because you administer the Page — App Review is only needed
                to publish for Pages belonging to other people.
              </p>
              <a className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
                href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">
                Open Graph API Explorer <ExternalLink size={12} />
              </a>
            </div>
          </>
        )}

        {/* Step 2 — pick a Page */}
        {pages && pages.length > 0 && !selectedPage && (
          <div>
            <div className="mb-1.5 text-sm font-medium text-ink">Choose the Page to publish to</div>
            <div className="divide-y divide-line rounded-[10px] border border-line">
              {pages.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{p.name}</span>
                    {p.category && <span className="block truncate text-xs text-muted">{p.category}</span>}
                  </span>
                  <Button size="sm" loading={selectM.isPending} onClick={() => selectM.mutate(p.id)}>Use this Page</Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3 — prove it works */}
        {selectedPage && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-[10px] border border-green-2/40 bg-green-3 p-3 text-sm text-green-2">
              <CheckCircle2 size={16} className="shrink-0" />
              <span>Connected to <b>{pageName}</b>. Post a test to confirm it really publishes.</span>
            </div>
            <Field label="Test post" hint="This publishes for real and will be visible on your Page">
              <Textarea value={testMsg} onChange={(e) => setTestMsg(e.target.value)} rows={3} />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" loading={testM.isPending} disabled={!testMsg.trim()}
                onClick={() => { setTestResult(null); testM.mutate(); }}><Send size={15} /> Publish test post</Button>
              <Button variant="secondary" size="sm" onClick={() => { setSelectedPage(null); setPages(null); setTestResult(null); setNotice(null); }}>
                Use a different token
              </Button>
            </div>
            {testResult && (
              <div className={`rounded-[10px] border p-3 text-sm ${testResult.ok ? 'border-green-2/40 bg-green-3 text-green-2' : 'border-red/40 bg-red/5 text-red'}`}>
                {testResult.detail}
                {testResult.link && (
                  <a className="ml-1 inline-flex items-center gap-1 underline" href={testResult.link} target="_blank" rel="noreferrer">
                    View post <ExternalLink size={12} />
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {notice && !err && <p className="text-xs text-muted">{notice}</p>}
        {err && (
          <div className="flex gap-2 rounded-[10px] border border-red/40 bg-red/5 p-3 text-sm text-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── LinkedIn test post ───────────────────────────────────────────────────────
/**
 * Publishes one real post to the connected member's feed. LinkedIn's verdict is
 * shown as-is: a rejection stays a rejection, with LinkedIn's own message.
 */
function LinkedInTestPostModal({ author, onClose, onPosted }: {
  author?: string; onClose: () => void; onPosted: () => void;
}) {
  const [text, setText] = useState('Testing our new Green Start omnichannel publishing setup.');
  const [result, setResult] = useState<{ ok: boolean; detail: string; link?: string } | null>(null);

  const post = useMutation({
    mutationFn: () => publishingService.linkedinTestPost(text.trim()),
    onSuccess: (r) => {
      setResult(r.accepted
        ? { ok: true, detail: 'Published to your LinkedIn feed.', link: r.permalink }
        : { ok: false, detail: `${r.errorMessage ?? 'Rejected'}${r.errorCode ? ` [${r.errorCode}]` : ''}` });
      onPosted();
    },
    onError: (e: unknown) => setResult({ ok: false, detail: e instanceof Error ? e.message : 'Post failed' }),
  });

  const over = text.trim().length > 3000;

  return (
    <Modal open onClose={onClose} title="Send a test LinkedIn post" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        <Button size="sm" loading={post.isPending} disabled={!text.trim() || over}
          onClick={() => { setResult(null); post.mutate(); }}><Send size={15} /> Publish</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          This publishes for real, to <b className="text-ink">{author ?? 'your LinkedIn profile'}</b>, visible to
          your connections. Delete it from LinkedIn afterwards if it was only a test.
        </p>
        <Field label="Post text"
          error={over ? 'LinkedIn allows 3,000 characters.' : undefined}
          hint={over ? undefined : `${text.trim().length} / 3000 characters`}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} invalid={over} />
        </Field>
        <p className="text-xs text-muted">
          Text only for now — a URL in the text still gets a link preview. Image posts need LinkedIn’s
          upload flow, which isn’t wired up yet.
        </p>
        {result && (
          <div className={`rounded-[10px] border p-3 text-sm ${result.ok ? 'border-green-2/40 bg-green-3 text-green-2' : 'border-red/40 bg-red/5 text-red'}`}>
            {result.detail}
            {result.link && (
              <a className="ml-1 inline-flex items-center gap-1 underline" href={result.link} target="_blank" rel="noreferrer">
                View post <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
