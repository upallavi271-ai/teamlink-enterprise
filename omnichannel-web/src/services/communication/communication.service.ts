/**
 * Communication Console service. In REAL mode it drives the existing campaign
 * send engine via three endpoints — `POST campaigns/direct-send` (create +
 * configure + queue atomically), `GET campaigns/:id` (status + counters) and
 * `GET campaigns/:id/recipients` (the per-recipient delivery log) — so a direct
 * send is a first-class campaign, never a fake, and the worker + provider adapter
 * do the actual delivery.
 *
 * In MOCK mode it simulates the same shape end-to-end so the console is fully
 * usable in the demo before the backend is wired: it creates a real row in the
 * shared campaigns mock, resolves the audience against the CRM/segments mocks,
 * and produces a deterministic delivery log (a stable subset "fail" on provider
 * error codes, exactly as a real provider would reject some numbers). A mock run
 * is clearly a mock — nothing is presented as a live provider send.
 */
import type {
  Campaign, CampaignRecipient, DirectSendInput, DirectSendResult, ListParams, Paginated, RecipientStatus,
} from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { campaignsService } from '../campaigns/campaigns.service';
import { customersService } from '../crm/customers.service';
import { segmentsService } from '../crm/segments.service';
import { customerMatchesSegment } from '@/lib/segmentMatch';

const real = config.isRealApi('campaigns');

/** In-memory store of simulated runs (mock mode only), keyed by campaign id. */
interface MockRun { campaign: Campaign; recipients: CampaignRecipient[] }
const mockRuns = new Map<string, MockRun>();

/** A stable pseudo "last two digits" for any address, so reruns behave the same. */
function addressTail(addr: string): number {
  const digits = addr.replace(/\D/g, '');
  if (digits.length >= 2) return Number(digits.slice(-2));
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 100;
  return h;
}

/** Deterministic provider verdict — mirrors how a real gateway rejects some sends. */
function verdictFor(addr: string): { status: RecipientStatus; error?: string } {
  if (!addr) return { status: 'skipped', error: 'No destination for channel' };
  const t = addressTail(addr) % 100;
  if (t < 6) return { status: 'failed', error: '131026 · Message undeliverable' };
  if (t < 8) return { status: 'failed', error: '131047 · Re-engagement required' };
  return { status: 'sent' };
}

/** Resolve the chosen audience to concrete channel addresses (mock mode). */
async function resolveAddresses(orgId: string, input: DirectSendInput): Promise<string[]> {
  const wantEmail = input.channel === 'email';
  if (input.audience.type === 'manual') {
    return (input.audience.recipients ?? []).map((r) => r.trim()).filter(Boolean);
  }
  const all = await customersService.all(orgId);
  let list = all;
  if (input.audience.type === 'segment' && input.audience.segmentId) {
    const segs = await segmentsService.list(orgId);
    const seg = segs.find((s) => s.id === input.audience.segmentId);
    if (seg) list = all.filter((c) => customerMatchesSegment(c, { rules: seg.rules, logic: seg.logic }));
    else list = [];
  }
  return list.map((c) => (wantEmail ? c.email ?? '' : c.phone ?? '')).map((v) => v.trim()).filter(Boolean);
}

export const communicationService = {
  /** Create + configure + queue a direct send. */
  async directSend(orgId: string, input: DirectSendInput): Promise<DirectSendResult> {
    if (real) return apiRequest('campaigns/direct-send', { method: 'POST', body: input });

    // ---- Mock simulation ----
    await mockLatency(260);
    const addresses = await resolveAddresses(orgId, input);
    // Persist a real row in the shared campaigns mock so it also appears in Campaigns.
    const campaign = await campaignsService.create(orgId, { name: input.name, channel: input.channel });

    const seen = new Set<string>();
    const recipients: CampaignRecipient[] = [];
    for (const addr of addresses) {
      if (seen.has(addr)) continue;
      seen.add(addr);
      const v = verdictFor(addr);
      recipients.push({
        id: `rcp_${recipients.length}_${Math.random().toString(36).slice(2, 8)}`,
        phone: input.channel === 'email' ? undefined : addr,
        email: input.channel === 'email' ? addr : undefined,
        status: v.status,
        error: v.error,
        createdAt: new Date().toISOString(),
      });
    }

    const sent = recipients.filter((r) => r.status === 'sent').length;
    const failed = recipients.filter((r) => r.status === 'failed').length;
    const completed: Campaign = {
      ...campaign, status: 'completed', templateId: input.templateId ?? undefined,
      recipients: recipients.length, sent, failed, delivered: 0, read: 0,
    };
    mockRuns.set(campaign.id, { campaign: completed, recipients });
    // Reflect completion in the shared campaigns list too.
    try { await campaignsService.setStatus(orgId, campaign.id, 'completed'); } catch { /* best effort */ }

    return { campaignId: campaign.id, status: 'queued' };
  },

  /** Campaign status + rolled-up counters (drives the send-run progress bar). */
  async getCampaign(orgId: string, id: string): Promise<Campaign> {
    if (real) return apiRequest(`campaigns/${id}`);
    await mockLatency(160);
    const run = mockRuns.get(id);
    if (run) return run.campaign;
    const c = await campaignsService.list(orgId, { pageSize: 100 }).then((p) => p.items.find((x) => x.id === id));
    if (!c) throw new Error('Campaign not found');
    return c;
  },

  /**
   * Per-recipient delivery log.
   *
   * `_orgId` is intentionally unused — this is NOT an unscoped request. Workspace
   * scoping is the HTTP boundary's job: apiClient.apiRequest attaches the
   * `X-Workspace-Id` header to every call (services/apiClient.ts), so the server
   * scopes `campaigns/:id/recipients` itself. `getCampaign` and `directSend`
   * above, and every method of campaigns.service, do the same — none of them put
   * the org id in the path or query. The parameter stays in place so this method
   * keeps the `(orgId, id, ...)` shape its callers already pass.
   */
  async getRecipients(_orgId: string, id: string, params: ListParams = {}): Promise<Paginated<CampaignRecipient>> {
    if (real) return apiRequest(`campaigns/${id}/recipients${toQuery(params)}`);
    await mockLatency(160);
    const run = mockRuns.get(id);
    const rows = run?.recipients ?? [];
    const statusFilter = params.filters?.status;
    const filtered = statusFilter ? rows.filter((r) => r.status === statusFilter) : rows;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 50;
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length, page, pageSize,
    };
  },
};
