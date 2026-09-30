import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Send, Clock, Upload, Users, Download, Info, X, Check,
  MessageCircle, Smartphone, Mail, MessageSquare, Mic, FileText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { LoadingState, EmptyState } from '@/components/feedback/states';
import { useCan } from '@/features/auth/useCan';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { cap } from '@/features/crm/crmLabels';
import { templatesService } from '@/services/templates/templates.service';
import { communicationService } from '@/services/communication/communication.service';
import { integrationsService } from '@/services/integrations/integrations.service';
import type { EmailProviderView, SmsProviderView } from '@/services/integrations/integrations.types';
import { CrmContactSelector } from './CrmContactSelector';
import type {
  Campaign, CampaignRecipient, Channel, RecipientStatus, Template,
} from '@/types';

type Icon = LucideIcon;

const CHANNEL_TABS: { key: Channel; label: string; icon: Icon }[] = [
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { key: 'sms', label: 'SMS', icon: Smartphone },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'rcs', label: 'RCS', icon: MessageSquare },
  { key: 'voice', label: 'Voice', icon: Mic },
];
// `facebook` is part of `Channel`, so these exhaustive maps have to cover it.
// It is deliberately absent from CHANNEL_TABS above: this console sends to a list
// of individual addresses (CRM contacts, or a CSV of mobile/email columns), while
// Facebook in Green Start is a Page broadcast — publishing lives in Social and
// one-to-one replies live in the Facebook Inbox. So the entries below are correct
// but unreachable today; they make the maps total over `Channel` and already say
// the right thing if a Facebook surface is ever added here.
const CHANNEL_TIPS: Record<Channel, string[]> = {
  facebook: ['A Facebook post goes to a whole Page, not to a recipient list — publish it from Social.', 'Connect the Page in Settings → Integrations first; replies are handled in the Facebook Inbox.'],
  whatsapp: ['Use approved Meta templates.', 'Phone numbers need country codes.'],
  sms: ['A DLT-approved sender ID is required in India.', 'Keep each message under 160 characters per segment.'],
  email: ['CSV must contain an “email” column.', 'Check spam score before sending.'],
  rcs: ['Rich cards fall back to SMS where unsupported.', 'The RCS agent must be approved first.'],
  voice: ['Keep IVR scripts short and clear.', 'Always include an opt-out option.'],
};
const NAME_PLACEHOLDER: Record<Channel, string> = {
  whatsapp: 'e.g., Diwali Sale', facebook: 'e.g., Page Announcement', sms: 'e.g., Flash Offer', email: 'e.g., Newsletter',
  rcs: 'e.g., Product Launch', voice: 'e.g., Reminder Call',
};
/** The integration provider that supplies sending accounts for each channel. */
const CHANNEL_PROVIDER: Partial<Record<Channel, string>> = { whatsapp: 'whatsapp' };

/** One selectable sending account, whatever channel it came from. */
interface SenderCard { key: string; title: string; subtitle: string }

const recipientTone = (s: RecipientStatus): 'green' | 'red' | 'blue' | 'neutral' | 'orange' =>
  s === 'sent' || s === 'delivered' || s === 'read' ? 'green'
    : s === 'failed' ? 'red' : s === 'skipped' ? 'orange' : s === 'queued' ? 'blue' : 'neutral';

/** Forgiving address extraction — emails for the email channel, phone digits otherwise. */
function extractAddresses(values: string[], channel: Channel): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const tok = (raw ?? '').trim();
    if (!tok) continue;
    let addr = '';
    if (channel === 'email') {
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tok)) addr = tok.toLowerCase();
    } else {
      const digits = tok.replace(/[^\d]/g, '');
      if (digits.length >= 10 && digits.length <= 15) addr = digits;
    }
    if (addr && !seen.has(addr)) { seen.add(addr); out.push(addr); }
  }
  return out;
}

/** Minimal CSV parse (handles quoted cells). Returns header row + data rows. */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitLine = (line: string): string[] => {
    const cells: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  return { headers, rows: lines.slice(1).map(splitLine) };
}

type Audience =
  | { kind: 'none' }
  | { kind: 'crm'; addresses: string[]; count: number }
  | { kind: 'csv'; fileName: string; addresses: string[] };

export function ConsolePage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canSend = useCan('campaign.send');

  const [params] = useSearchParams();
  const wantedChannel = params.get('channel') as Channel | null;
  const wantedTemplate = params.get('templateId');

  const [channel, setChannel] = useState<Channel>(
    wantedChannel && CHANNEL_TABS.some((c) => c.key === wantedChannel) ? wantedChannel : 'whatsapp',
  );
  const [accountId, setAccountId] = useState<string>('');
  const chLabel = CHANNEL_TABS.find((c) => c.key === channel)?.label ?? cap(channel);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  // Values for the selected template's {{1}}, {{2}} … keyed by index.
  const [vars, setVars] = useState<Record<string, string>>({});
  const [audience, setAudience] = useState<Audience>({ kind: 'none' });
  const [showCrm, setShowCrm] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const csvRef = useRef<HTMLInputElement>(null);

  const integrationsQ = useQuery({ queryKey: ['integrations', orgId], queryFn: () => integrationsService.list(orgId), enabled: !!orgId });
  const templatesQ = useQuery({
    queryKey: ['console-templates', orgId, channel],
    queryFn: () => templatesService.list(orgId, { pageSize: 100, filters: { channel } }),
    enabled: !!orgId,
  });

  // Email and SMS are sent through the WORKSPACE'S OWN provider (Settings →
  // Integrations → Email (SMTP) / SMS (MSG91)), or an explicitly allowed platform
  // sender. Neither appears in the WhatsApp-style integrations list, so reading
  // that list here always showed "no accounts" even with a mailbox connected.
  // The dedicated endpoint also says whether sending is actually ready and, if
  // not, exactly why — which is what the empty state should repeat.
  const isCredentialChannel = channel === 'email' || channel === 'sms';
  // Typed explicitly: the query function returns one of two different promise
  // types depending on the channel, and TanStack cannot infer a data type from
  // that union — left to inference, `data` collapses to `{}`.
  const senderQ = useQuery<EmailProviderView | SmsProviderView | null>({
    queryKey: ['channel-sender', orgId, channel],
    queryFn: async (): Promise<EmailProviderView | SmsProviderView | null> =>
      channel === 'email' ? integrationsService.emailProvider(orgId) : integrationsService.smsProvider(orgId),
    enabled: !!orgId && isCredentialChannel,
  });

  // Sending accounts for this channel, in one shape for every channel.
  const accounts = useMemo<SenderCard[]>(() => {
    if (isCredentialChannel) {
      const v = senderQ.data;
      if (!v || !v.sender.ready) return [];
      const platform = v.sender.source === 'platform';
      if (v.provider === 'email') {
        const s = v.settings;
        return [{
          key: v.id ?? 'email',
          title: s?.fromName || s?.from || v.displayName || 'Email sender',
          subtitle: platform ? 'Platform sender' : (s?.from ?? s?.host ?? 'SMTP'),
        }];
      }
      const s = v.settings;
      return [{
        key: v.id ?? 'sms',
        title: s?.senderId ? `Sender ID ${s.senderId}` : (v.displayName ?? 'SMS sender'),
        subtitle: platform ? 'Platform sender' : 'MSG91',
      }];
    }
    const provider = CHANNEL_PROVIDER[channel];
    if (!provider) return [];
    return (integrationsQ.data ?? [])
      .filter((i) => i.provider === provider && ['CONNECTED', 'SYNCING', 'ERROR', 'EXPIRED'].includes(i.status))
      .map((i) => ({ key: i.id ?? i.provider, title: i.displayName ?? i.label, subtitle: i.externalAccountId ?? i.provider }));
  }, [integrationsQ.data, senderQ.data, channel, isCredentialChannel]);

  /** Why there is no sender, in the server's words when it gave any. */
  const noSenderReason = isCredentialChannel ? senderQ.data?.sender.reason : undefined;
  const accountsLoading = isCredentialChannel ? senderQ.isLoading : integrationsQ.isLoading;

  // WhatsApp genuinely requires a Meta-approved template before it can be sent.
  // The other channels have no external approval gate, so anything not rejected is usable.
  const usableTemplates: Template[] = useMemo(
    () => (templatesQ.data?.items ?? []).filter((t) => (channel === 'whatsapp' ? t.status === 'approved' : t.status !== 'rejected')),
    [templatesQ.data, channel],
  );
  const selectedTemplate = usableTemplates.find((t) => t.id === templateId) ?? null;
  const varCount = selectedTemplate?.variables ?? 0;

  // Template picking follows the reference: locked until an account is chosen.
  // When no accounts exist at all we leave it open so the console stays usable.
  const templateLocked = accounts.length > 0 && !accountId;
  const SenderIcon: LucideIcon = channel === 'email' ? Mail : channel === 'sms' ? Smartphone : MessageCircle;

  useEffect(() => { setAccountId(''); setTemplateId(''); setAudience({ kind: 'none' }); setVars({}); }, [channel]);
  // A different template has different variables; carrying old values across
  // would quietly send the previous template's text.
  useEffect(() => { setVars({}); }, [templateId]);

  // Arriving from Manage Templates with ?templateId=… — select it once the list
  // that contains it has loaded, and only if it is genuinely sendable.
  const appliedTemplate = useRef(false);
  useEffect(() => {
    if (appliedTemplate.current || !wantedTemplate) return;
    if (!usableTemplates.some((t) => t.id === wantedTemplate)) return;
    appliedTemplate.current = true;
    setTemplateId(wantedTemplate);
  }, [wantedTemplate, usableTemplates]);

  const audienceLabel = (): string => {
    if (audience.kind === 'crm') return `${audience.count} contact${audience.count === 1 ? '' : 's'} from CRM`;
    if (audience.kind === 'csv') return `${audience.fileName} — ${audience.addresses.length} recipient${audience.addresses.length === 1 ? '' : 's'}`;
    return '';
  };

  const onCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const { headers, rows } = parseCsv(text);
      if (headers.length === 0) { toast.error('That CSV looks empty.'); return; }
      const wanted = channel === 'email' ? ['email', 'e-mail', 'email address'] : ['mobile', 'phone', 'number', 'phone number', 'mobile number'];
      const idx = headers.findIndex((h) => wanted.includes(h));
      if (idx === -1) {
        toast.error(`CSV needs a “${channel === 'email' ? 'email' : 'mobile'}” column header.`);
        return;
      }
      const addresses = extractAddresses(rows.map((r) => r[idx] ?? ''), channel);
      if (addresses.length === 0) { toast.error('No valid recipients found in that column.'); return; }
      setAudience({ kind: 'csv', fileName: file.name, addresses });
      toast.success(`${addresses.length} recipients loaded from ${file.name}`);
    } catch {
      toast.error('Could not read that file.');
    }
  };

  const downloadSample = () => {
    const csv = 'mobile,email,name\n919876543210,rahul@example.com,Rahul\n919812345678,priya@example.com,Priya\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `green-start-sample-${channel}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── send run ───────────────────────────────────────────────────────────────
  const [sending, setSending] = useState(false);
  const [run, setRun] = useState<{ campaignId: string } | null>(null);
  const [runCampaign, setRunCampaign] = useState<Campaign | null>(null);
  const [runRecipients, setRunRecipients] = useState<CampaignRecipient[]>([]);
  const pollRef = useRef<number | null>(null);
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPolling(), []);

  const startPolling = (campaignId: string) => {
    stopPolling();
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const [camp, recs] = await Promise.all([
          communicationService.getCampaign(orgId, campaignId),
          communicationService.getRecipients(orgId, campaignId, { pageSize: 200 }),
        ]);
        setRunCampaign(camp); setRunRecipients(recs.items);
        if (['completed', 'failed', 'cancelled'].includes(camp.status) || tries >= 40) stopPolling();
      } catch { if (tries >= 40) stopPolling(); }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 1200);
  };

  const validate = (): string | null => {
    if (!name.trim()) return 'Please enter a campaign name.';
    if (channel === 'whatsapp' && !templateId) return 'Pick an approved WhatsApp template.';
    // Every channel's content comes from its template (the server refuses a
    // campaign without one), so catch it here rather than as a failed run.
    if (!templateId) return `Pick a ${chLabel} template — it supplies the message content.`;
    if (varCount > 0 && Array.from({ length: varCount }, (_, i) => vars[String(i + 1)]?.trim()).some((v) => !v)) {
      return `Fill in every variable the template needs ({{1}}…{{${varCount}}}).`;
    }
    if (audience.kind === 'none') return 'Choose recipients — from CRM or a CSV.';
    if ((audience.kind === 'crm' || audience.kind === 'csv') && audience.addresses.length === 0) return 'No valid recipients in that selection.';
    return null;
  };

  const doSend = async (whenIso?: string) => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSending(true);
    try {
      const res = await communicationService.directSend(orgId, {
        name: name.trim(), channel, templateId: templateId || null,
        ...(varCount > 0 ? { variableValues: vars } : {}),
        audience: { type: 'manual', recipients: audience.kind === 'none' ? [] : audience.addresses },
      });
      setRun({ campaignId: res.campaignId });
      setRunCampaign(null); setRunRecipients([]);
      startPolling(res.campaignId);
      toast.success(whenIso ? 'Campaign scheduled' : 'Send queued');
      setShowSchedule(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the send');
    } finally { setSending(false); }
  };

  if (!canSend) {
    return (
      <div>
        <PageHeader title="Communication" subtitle="Create and launch campaigns for this workspace" />
        <Card><EmptyState title="No access" detail="You need the campaign.send permission to launch campaigns." /></Card>
      </div>
    );
  }


  return (
    <div>
      <PageHeader title="Communication" subtitle="Create and launch campaigns for this workspace" />
      <Tabs tabs={CHANNEL_TABS.map((c) => ({ key: c.key, label: c.label }))} active={channel} onChange={(k) => setChannel(k as Channel)} />

      <div className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-[1fr_340px]">
        {/* ── Composer ─────────────────────────────────────────────────── */}
        <Card className="p-5">
          <div className="space-y-5">
            {/* Accounts */}
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink">Select {chLabel} Account</div>
              {accountsLoading ? <LoadingState />
                : accounts.length === 0 ? (
                  <div className="rounded-[10px] border border-dashed border-line px-4 py-5 text-center text-xs text-muted">
                    {noSenderReason ?? `No ${chLabel} accounts connected. Connect one in Settings → Integrations.`}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {accounts.map((a) => {
                      const key = a.key;
                      const on = accountId === key;
                      return (
                        <button key={key} type="button" onClick={() => setAccountId(on ? '' : key)}
                          className={`relative rounded-[10px] border p-3 text-center transition-colors ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
                          {on && <Check size={14} className="absolute right-2 top-2 text-accent" />}
                          <SenderIcon size={18} className={`mx-auto mb-1 ${on ? 'text-accent' : 'text-muted'}`} />
                          <div className="truncate text-sm font-medium text-ink">{a.title}</div>
                          <div className="truncate text-xs text-muted">{a.subtitle}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
            </div>

            {/* Campaign name */}
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink">Campaign Name</div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={NAME_PLACEHOLDER[channel]} />
            </div>

            {/* Template */}
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink">Select {chLabel} Template</div>
              <Select value={templateId} disabled={templateLocked} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">{templateLocked ? 'Select account first' : 'Choose a template…'}</option>
                {usableTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{channel === 'whatsapp' ? '' : ` — ${t.status}`}</option>
                ))}
              </Select>
              {!templateLocked && usableTemplates.length === 0 && !templatesQ.isLoading && (
                <p className="mt-1 text-xs text-muted">
                  {channel === 'whatsapp'
                    ? 'No Meta-approved WhatsApp templates yet — a template must be approved before it can be sent.'
                    : `No ${chLabel} templates yet — create one in Manage Templates.`}
                </p>
              )}
            </div>

            {/* Template variables — a Meta template renders from ITS registered
                copy, so {{1}} only has a value if we send one. */}
            {varCount > 0 && (
              <div>
                <div className="mb-1.5 text-sm font-medium text-ink">Template variables</div>
                <div className="space-y-2">
                  {Array.from({ length: varCount }, (_, i) => String(i + 1)).map((k) => (
                    <Field key={k} label={`{{${k}}}`}>
                      <Input
                        value={vars[k] ?? ''}
                        onChange={(e) => setVars((p) => ({ ...p, [k]: e.target.value }))}
                        placeholder={k === '1' ? '{{name}}' : 'Fixed text, or {{name}} / {{email}} / {{phone}}'}
                      />
                    </Field>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  Type <code className="rounded bg-surface-2 px-1">{'{{name}}'}</code>,{' '}
                  <code className="rounded bg-surface-2 px-1">{'{{first_name}}'}</code>,{' '}
                  <code className="rounded bg-surface-2 px-1">{'{{email}}'}</code> or{' '}
                  <code className="rounded bg-surface-2 px-1">{'{{phone}}'}</code> to fill from each
                  contact — anything else is sent as written.
                </p>
              </div>
            )}

            {/* Recipients source */}
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink">Recipients Source</div>
              <div className="space-y-2">
                <SourceRow icon={Users} title="Select from CRM" subtitle="Pick contacts directly from your database"
                  active={audience.kind === 'crm'} onClick={() => setShowCrm(true)} />
              </div>

              <div className="my-3 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-line" /> OR <span className="h-px flex-1 bg-line" />
              </div>

              <div className="mb-1.5 text-sm font-medium text-ink">Recipients (CSV)</div>
              <button type="button" onClick={() => csvRef.current?.click()}
                className={`flex w-full flex-col items-center gap-1 rounded-[10px] border border-dashed px-4 py-6 text-center transition-colors ${audience.kind === 'csv' ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent'}`}>
                <Upload size={20} className="text-accent" />
                <span className="text-sm font-medium text-accent">Upload CSV File</span>
                <span className="text-xs text-muted">Headers required for variable mapping</span>
                <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={onCsv} />
              </button>

              {audience.kind !== 'none' && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-[10px] bg-green-3 px-3 py-2 text-xs text-green-2">
                  <span className="truncate">{audienceLabel()}</span>
                  <button type="button" className="shrink-0 text-muted hover:text-red" onClick={() => setAudience({ kind: 'none' })} aria-label="Clear recipients"><X size={14} /></button>
                </div>
              )}
            </div>

            {/* CTAs */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button size="md" loading={sending} onClick={() => doSend()}><Send size={15} /> Send Now</Button>
              <Button variant="secondary" size="md" onClick={() => setShowSchedule(true)}><Clock size={15} /> Schedule</Button>
            </div>
          </div>
        </Card>

        {/* ── Right rail ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Info size={15} className="text-accent" /> Tips ({chLabel.toUpperCase()})
            </div>
            <ul className="mb-2 space-y-1 text-xs text-muted">
              {CHANNEL_TIPS[channel].map((t) => <li key={t}>• {t}</li>)}
            </ul>
            <p className="mb-3 text-xs text-muted">
              <b className="text-ink">mobile</b> and <b className="text-ink">email</b> headers are mandatory and must always be
              included to send SMS/email — make sure the CSV headers map exactly to those variable names.
            </p>
            <Button variant="secondary" size="sm" className="w-full" onClick={downloadSample}><Download size={14} /> Download Sample File</Button>
          </Card>

          <Card className="p-4">
            {selectedTemplate
              ? <TemplatePreview template={selectedTemplate} channel={channel} />
              : (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-muted"><FileText size={20} /></span>
                  <div className="text-sm font-medium text-ink">No Template Selected</div>
                  <div className="max-w-[220px] text-xs text-muted">Select an account and a template to see its preview here.</div>
                </div>
              )}
          </Card>
        </div>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────── */}
      {showCrm && (
        <CrmContactSelector orgId={orgId} channel={channel}
          onClose={() => setShowCrm(false)}
          onUse={(addresses, count) => { setAudience({ kind: 'crm', addresses, count }); setShowCrm(false); toast.success(`${count} contacts selected`); }} />
      )}
      {showSchedule && (
        <Modal open onClose={() => setShowSchedule(false)} title="Schedule campaign" size="sm"
          footer={<><Button variant="secondary" size="sm" onClick={() => setShowSchedule(false)}>Cancel</Button>
            <Button size="sm" loading={sending} onClick={() => {
              if (!scheduleAt) { toast.error('Pick a date and time.'); return; }
              const iso = new Date(scheduleAt).toISOString();
              if (new Date(iso).getTime() <= Date.now()) { toast.error('Pick a time in the future.'); return; }
              void doSend(iso);
            }}>Confirm schedule</Button></>}>
          <p className="mb-2 text-sm text-muted">Times are in your workspace timezone (IST).</p>
          <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
            className="h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-ink" />
        </Modal>
      )}

      {run && (
        <Modal open onClose={() => { stopPolling(); setRun(null); }} title="Send run" size="lg"
          footer={<Button variant="secondary" size="sm" onClick={() => { stopPolling(); setRun(null); }}>Close</Button>}>
          <SendRun campaign={runCampaign} recipients={runRecipients} />
        </Modal>
      )}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function SourceRow({ icon: Icon, title, subtitle, active, onClick }: {
  icon: Icon; title: string; subtitle: string; active: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-[10px] border p-3 text-left transition-colors ${active ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-surface-2 text-accent"><Icon size={16} /></span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-accent">{title}</span>
        <span className="block text-xs text-muted">{subtitle}</span>
      </span>
      {active && <Check size={15} className="ml-auto shrink-0 text-accent" />}
    </button>
  );
}

function TemplatePreview({ template, channel }: { template: Template; channel: Channel }) {
  const isChat = channel === 'whatsapp' || channel === 'sms' || channel === 'rcs';
  return (
    <div>
      <div className="mb-3">
        <div className="text-sm font-semibold text-ink">{template.name}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge>{template.category}</Badge>
          <Badge>{(template.language || 'en').toUpperCase()}</Badge>
          <Badge tone="green">Approved</Badge>
        </div>
      </div>
      {isChat ? (
        <div className="mx-auto w-full max-w-[260px] rounded-[22px] border-[5px] border-[#111b21] bg-[#e6ddd4]">
          <div className="rounded-t-[16px] bg-[#0b7d63] px-3 py-2 text-[11px] font-semibold text-white">{cap(channel)}</div>
          <div className="min-h-[180px] p-2.5">
            <div className="rounded-[10px] rounded-tl-[2px] bg-white p-2 shadow-sm">
              {template.header && <div className="mb-1 text-[11px] font-bold text-ink">{template.header}</div>}
              <div className="whitespace-pre-wrap break-words text-[11px] leading-snug text-ink">{template.body}</div>
              {template.footer && <div className="mt-1 text-[9px] text-[#8a929a]">{template.footer}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-[10px] border border-line p-3">
          {template.header && <div className="mb-1 text-sm font-semibold text-ink">{template.header}</div>}
          <div className="whitespace-pre-wrap break-words text-xs leading-snug text-ink">{template.body}</div>
          {template.footer && <div className="mt-2 text-[11px] text-muted">{template.footer}</div>}
        </div>
      )}
      {template.variables > 0 && (
        <p className="mt-2 text-xs text-muted">{template.variables} variable{template.variables === 1 ? '' : 's'} — map them from your CSV headers.</p>
      )}
    </div>
  );
}

function SendRun({ campaign, recipients }: { campaign: Campaign | null; recipients: CampaignRecipient[] }) {
  if (!campaign) return <LoadingState label="Starting the send…" />;
  const total = campaign.recipients ?? recipients.length;
  const done = (campaign.sent ?? 0) + (campaign.failed ?? 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{campaign.name}</span>
        <Badge tone={campaign.status === 'completed' ? 'green' : 'blue'}>{campaign.status}</Badge>
        <span className="ml-auto text-xs text-muted">{done} / {total}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-[10px] border border-line p-2"><div className="text-lg font-semibold text-ink">{campaign.sent ?? 0}</div>Sent</div>
        <div className="rounded-[10px] border border-line p-2"><div className="text-lg font-semibold text-ink">{campaign.delivered ?? 0}</div>Delivered</div>
        <div className="rounded-[10px] border border-line p-2"><div className="text-lg font-semibold text-red">{campaign.failed ?? 0}</div>Failed</div>
      </div>
      {recipients.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-[10px] border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-xs uppercase text-muted">
              <tr><th className="px-3 py-2 text-left">Recipient</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Detail</th></tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-1.5 text-ink">{r.phone ?? r.email ?? '—'}</td>
                  <td className="px-3 py-1.5"><Badge tone={recipientTone(r.status)}>{r.status}</Badge></td>
                  <td className="px-3 py-1.5 text-xs text-muted">{r.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

