/**
 * Content Studio publishing — talks to the LIVE backend (`/api/v1/social/*`).
 * A central post fans out to one INDEPENDENT destination per selected provider
 * (Facebook never depends on any other channel). Publishing is queued
 * server-side; this client only creates posts and reads per-destination status.
 *
 * Honesty: in mock/demo mode nothing is presented as a live connection or a
 * real publish. No access token is ever sent or received here — Facebook Page
 * tokens live only in the server's encrypted store.
 */
import type {
  CreateMediaInput, CreateSocialPostInput, FacebookConnectionStatus, FacebookPageOption,
  LinkedInConnectionStatus, MediaAssetRef, PublishProviderOption, SocialPublishPost,
  SocialReadinessReport, FacebookTokenConnectResult, SocialTestPostResult,
  SocialAnalyticsView, SocialAnalyticsParams, InstagramMessagingReadiness,
} from './publishing.types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { integrationsService } from '../integrations/integrations.service';
import { mockLatency } from '../mockDb';

const real = config.isRealApi('social');

const NOT_CONFIGURED_MSG =
  'Publishing is not configured on the server. Add Meta app credentials (server-side) and connect a Facebook Page to publish for real.';

// ── Demo store: created posts persist within the session only (never a real publish).
let demoPosts: SocialPublishPost[] = [];

function mutateDemoDest(postId: string, destId: string, status: 'CANCELLED' | 'QUEUED'): SocialPublishPost {
  const p = demoPosts.find((x) => x.id === postId);
  if (!p) throw new Error('Post not found');
  const d = p.destinations.find((x) => x.id === destId);
  if (d) { d.status = status; d.errorCategory = undefined; d.errorMessage = undefined; }
  return { ...p, destinations: p.destinations.map((x) => ({ ...x })) };
}

function demoMessagingReadiness(): InstagramMessagingReadiness {
  return {
    ready: false,
    canSubscribe: false,
    checkedAt: new Date().toISOString(),
    checks: [{
      key: 'page_connected',
      label: 'Facebook Page connected',
      status: 'problem',
      detail: 'Demo mode — no Facebook Page is connected.',
      fix: 'Instagram messaging needs the real API: run against the live backend and connect a Facebook Page with a linked Instagram professional account.',
    }],
  };
}

export const publishingService = {
  /** Providers this workspace can publish to right now (empty in demo mode). */
  async providers(): Promise<PublishProviderOption[]> {
    if (real) return apiRequest('social/providers');
    await mockLatency(120);
    return [];
  },

  async listPosts(take = 20, skip = 0): Promise<{ items: SocialPublishPost[]; total: number }> {
    if (real) return apiRequest(`social/posts?take=${take}&skip=${skip}`);
    await mockLatency();
    return { items: demoPosts.slice(skip, skip + take), total: demoPosts.length };
  },

  async getPost(id: string): Promise<SocialPublishPost> {
    if (real) return apiRequest(`social/posts/${id}`);
    await mockLatency(120);
    const p = demoPosts.find((x) => x.id === id);
    if (!p) throw new Error('Post not found');
    return p;
  },

  async createPost(input: CreateSocialPostInput): Promise<SocialPublishPost> {
    if (real) return apiRequest('social/posts', { method: 'POST', body: input });
    // Demo: fabricate a local, clearly-simulated post. Destinations stay QUEUED —
    // nothing is actually published without a configured server + connected Page.
    await mockLatency(180);
    const now = new Date().toISOString();
    const post: SocialPublishPost = {
      id: `demo_${Date.now()}`,
      content: input.content,
      mediaAssetId: input.mediaAssetId,
      status: input.publishNow ? 'QUEUED' : 'SCHEDULED',
      scheduledAt: input.publishNow ? undefined : input.scheduledAt,
      createdAt: now,
      destinations: [...new Set(input.destinations)].map((provider, i) => ({
        id: `demo_d${i}_${Date.now()}`,
        provider,
        status: input.publishNow ? 'QUEUED' : 'PENDING',
        scheduledAt: input.publishNow ? undefined : input.scheduledAt,
        retryCount: 0,
      })),
    };
    demoPosts = [post, ...demoPosts];
    return post;
  },

  async cancelDestination(postId: string, destId: string): Promise<SocialPublishPost> {
    if (real) return apiRequest(`social/posts/${postId}/destinations/${destId}/cancel`, { method: 'POST' });
    await mockLatency(120);
    return mutateDemoDest(postId, destId, 'CANCELLED');
  },

  async retryDestination(postId: string, destId: string): Promise<SocialPublishPost> {
    if (real) return apiRequest(`social/posts/${postId}/destinations/${destId}/retry`, { method: 'POST' });
    await mockLatency(120);
    return mutateDemoDest(postId, destId, 'QUEUED');
  },

  async createMedia(input: CreateMediaInput): Promise<MediaAssetRef> {
    if (real) return apiRequest('social/media', { method: 'POST', body: input });
    await mockLatency(120);
    return { id: `demo_m_${Date.now()}`, url: input.url, type: input.type };
  },

  // ── Facebook connection (Page-level) ──────────────────────────────────────
  /** Per-network setup state for Settings → Social Accounts. Names, never secrets. */
  async readiness(): Promise<SocialReadinessReport> {
    if (real) return apiRequest('social/readiness');
    // Demo: nothing is configured, and saying so is the honest answer.
    return {
      appUrl: window.location.origin,
      anyConfigured: false,
      networks: [],
    };
  },

  async facebookStatus(): Promise<FacebookConnectionStatus> {
    if (real) return apiRequest('social/facebook/status');
    await mockLatency(120);
    return { provider: 'facebook', connected: false, status: 'NOT_CONNECTED', pageSelected: false, needsReauth: false };
  },

  /**
   * Connect Facebook by pasting an access token you already hold — no OAuth app,
   * no redirect URI, no App Review. The token is sent once to the server, checked
   * against Graph, and stored encrypted; it is never returned or kept in the client.
   */
  async connectFacebookWithToken(accessToken: string): Promise<FacebookTokenConnectResult> {
    if (real) return apiRequest('social/facebook/connect-token', { method: 'POST', body: { accessToken } });
    await mockLatency(200);
    throw new Error('Connecting with a token needs the real API.');
  },

  /** Publish one real post to the selected Page, to prove the connection end to end. */
  async facebookTestPost(message: string, imageUrl?: string): Promise<SocialTestPostResult> {
    if (real) return apiRequest('social/facebook/test-post', { method: 'POST', body: { message, imageUrl } });
    await mockLatency(200);
    throw new Error('Publishing a test post needs the real API.');
  },

  /** Publish one real post to the connected LinkedIn member's feed. */
  async linkedinTestPost(commentary: string): Promise<SocialTestPostResult> {
    if (real) return apiRequest('social/linkedin/test-post', { method: 'POST', body: { commentary } });
    await mockLatency(200);
    throw new Error('Publishing a test post needs the real API.');
  },

  /** Drop the LinkedIn connection and its stored token. */
  async disconnectLinkedIn(): Promise<{ disconnected: true }> {
    if (real) return apiRequest('social/linkedin', { method: 'DELETE' });
    await mockLatency(150);
    throw new Error('Disconnecting needs the real API.');
  },

  // ── Instagram messaging (webhook DMs through the linked Page) ────────────
  /**
   * Why Instagram DMs are (or are not) reaching this workspace, as a list of
   * checks the server ran against Meta. Demo mode answers "not ready" with the
   * one honest reason — a fabricated green checklist would hide a setup that
   * cannot receive anything.
   */
  async instagramMessagingReadiness(): Promise<InstagramMessagingReadiness> {
    if (real) return apiRequest('social/facebook/messaging-readiness');
    await mockLatency(150);
    return demoMessagingReadiness();
  },

  /** Subscribe the connected Page to the app's webhooks; returns the re-checked readiness. */
  async subscribeInstagramMessaging(): Promise<InstagramMessagingReadiness> {
    if (real) return apiRequest('social/facebook/messaging-subscribe', { method: 'POST' });
    await mockLatency(200);
    throw new Error('Subscribing the Page to webhooks needs the real API.');
  },

  async facebookPages(): Promise<FacebookPageOption[]> {
    if (real) {
      const res = await apiRequest<{ pages: FacebookPageOption[] }>('social/facebook/pages');
      return res.pages;
    }
    await mockLatency(150);
    return [];
  },

  async selectFacebookPage(pageId: string): Promise<FacebookConnectionStatus> {
    if (real) return apiRequest('social/facebook/pages/select', { method: 'POST', body: { pageId } });
    await mockLatency(150);
    return { provider: 'facebook', connected: false, status: 'NOT_CONNECTED', pageSelected: false, needsReauth: false };
  },

  /**
   * Begin Facebook OAuth. Reuses the generic integrations connect endpoint,
   * which returns an authorize URL (real) or an honest "not configured" message
   * (demo). Meta OAuth only — no password or browser automation, ever.
   */
  async connectFacebook(orgId: string): Promise<{ configured: boolean; authorizeUrl?: string; message?: string }> {
    if (!real) { await mockLatency(120); return { configured: false, message: NOT_CONFIGURED_MSG }; }
    const res = await integrationsService.connect(orgId, 'facebook');
    return { configured: res.configured, authorizeUrl: res.authorizeUrl, message: res.message };
  },

  // ── LinkedIn connection (member-level, its own OAuth app) ──────────────────
  /** Begin LinkedIn OAuth via the generic integrations connect endpoint. */
  async connectLinkedIn(orgId: string): Promise<{ configured: boolean; authorizeUrl?: string; message?: string }> {
    if (!real) { await mockLatency(120); return { configured: false, message: 'LinkedIn is not configured on the server. Add LinkedIn app credentials (server-side) to connect.' }; }
    const res = await integrationsService.connect(orgId, 'linkedin');
    return { configured: res.configured, authorizeUrl: res.authorizeUrl, message: res.message };
  },

  /**
   * LinkedIn connection status, read from the endpoint built for it
   * (`GET social/linkedin/status` → LinkedInConnectionService.status).
   *
   * This used to be derived from the generic `GET integrations` list, which
   * carries neither `configured` nor `expiresAt`: the UI's "Sign in with
   * LinkedIn" button is gated on `configured`, so it sat permanently disabled,
   * and the token-expiry line never rendered. The LinkedIn endpoint answers
   * both, and applies the server's own expiry check before calling a
   * connection live — so an expired token reads as EXPIRED here rather than as
   * a healthy connection that fails on the next post.
   *
   * The workspace is carried by the X-Workspace-Id header, so the id is taken
   * only to keep the call shape consistent with the rest of this service.
   */
  async linkedinStatus(_orgId: string): Promise<LinkedInConnectionStatus> {
    if (real) return apiRequest('social/linkedin/status');
    await mockLatency(120);
    // Demo: nothing is connected and the server holds no credentials. Saying so
    // is the honest answer — a fabricated "configured" would offer a sign-in
    // that cannot complete.
    return {
      provider: 'linkedin',
      connected: false,
      status: 'NOT_CONNECTED',
      needsReauth: false,
      configured: false,
    };
  },

  /**
   * Post insights for a date range, read live from each provider by the server.
   *
   * The server answers `available: false` with a reason when it could not reach
   * any provider, rather than returning zeroes — so a disconnected account and a
   * quiet week never look the same. In demo mode this returns that same shape
   * with the honest reason, which is why the page needs no mock branch of its own.
   */
  // The workspace is carried by the X-Workspace-Id header, so the id is taken
  // only to keep the call shape consistent with the rest of this service.
  async socialAnalytics(_orgId: string, params: SocialAnalyticsParams = {}): Promise<SocialAnalyticsView> {
    const now = new Date();
    const to = params.to ?? now.toISOString();
    const from = params.from ?? new Date(now.getTime() - 30 * 864e5).toISOString();

    if (!real) {
      await mockLatency(180);
      return {
        available: false,
        reason: NOT_CONFIGURED_MSG,
        range: { from, to },
        accountId: params.accountId,
        totals: { reach: 0, impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, engagement: 0, posts: 0 },
        daily: [],
        posts: [],
      };
    }

    const q = new URLSearchParams({ from, to });
    if (params.accountId) q.set('accountId', params.accountId);
    return apiRequest(`social/analytics?${q.toString()}`);
  },
};
