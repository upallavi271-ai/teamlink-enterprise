/**
 * Content Studio publishing types — the LIVE-backend `/api/v1/social/*` contract.
 * Kept in the social service layer (not the shared `@/types` barrel) so the
 * publishing feature owns its own contract and doesn't collide with the social
 * audiences/promotions model. Never carries tokens/secrets.
 */
export type PublishPostStatus =
  | 'DRAFT' | 'SCHEDULED' | 'QUEUED' | 'PUBLISHING'
  | 'PUBLISHED' | 'PARTIALLY_PUBLISHED' | 'FAILED' | 'CANCELLED';
export type PublishDestStatus =
  | 'PENDING' | 'QUEUED' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';

export interface PublishDestinationView {
  id: string;
  provider: string;
  status: PublishDestStatus;
  externalPostId?: string;
  publishedAt?: string;
  scheduledAt?: string;
  errorCategory?: string;
  errorMessage?: string;
  retryCount: number;
}
export interface SocialPublishPost {
  id: string;
  content: string;
  mediaAssetId?: string;
  status: PublishPostStatus;
  scheduledAt?: string;
  createdAt: string;
  destinations: PublishDestinationView[];
}
/**
 * What a platform actually supports, as the server reports it. `null` when the
 * provider publishes without a discovery adapter (LinkedIn posts as the member),
 * which is not the same as "supports nothing".
 */
export interface PublishProviderCapabilities {
  maxTextLength: number;
  media: { image: boolean; video: boolean; maxImages: number; required: boolean };
  supportsLink: boolean;
  supportsHashtags: boolean;
  supportsMentions: boolean;
  supportsCta: boolean;
  imageFormats: string[];
  videoFormats: string[];
  /** Human notes shown in the composer for unsupported/limited features. */
  notes: string[];
}

/**
 * A publishing destination in the server's catalog (`GET social/providers`).
 * Every row in the catalog comes back — including ones this workspace cannot
 * publish to — so the caller must read the flags rather than assume the list is
 * already filtered:
 *  - `available`  — Green Start has an adapter for this network at all
 *                   (false for the declared-but-unbuilt ones, e.g. X, YouTube).
 *  - `configured` — this server holds credentials that can reach the live API.
 *  - `connected`  — this workspace has an account/integration linked.
 */
export interface PublishProviderOption {
  provider: string;
  label: string;
  /** FACEBOOK | INSTAGRAM | LINKEDIN | TWITTER | YOUTUBE */
  platform: string;
  available: boolean;
  configured: boolean;
  connected: boolean;
  accountCount: number;
  capabilities: PublishProviderCapabilities | null;
}

export interface CreateSocialPostInput {
  content: string;
  mediaAssetId?: string;
  destinations: string[];
  publishNow?: boolean;
  scheduledAt?: string;
}
export interface CreateMediaInput { type: 'IMAGE' | 'VIDEO'; url: string; mimeType?: string }
export interface MediaAssetRef { id: string; url: string; type: string }

/** Facebook (Page) connection status — never includes any access token. Instagram
 *  publishes through the linked Page, so its link state rides on this status. */
export interface FacebookConnectionStatus {
  provider: 'facebook';
  connected: boolean;
  status: string;               // NOT_CONNECTED | CONNECTED | REAUTH_REQUIRED | …
  pageSelected: boolean;
  pageId?: string;
  pageName?: string;
  instagramLinked?: boolean;
  instagramUsername?: string;
  needsReauth: boolean;
  lastError?: string;
}
export interface FacebookPageOption { id: string; name: string; category?: string }

/**
 * LinkedIn (member) connection status, as `GET social/linkedin/status` returns
 * it — never includes any access token. Mirrors the server's `LinkedInStatusView`.
 */
export interface LinkedInConnectionStatus {
  provider: 'linkedin';
  connected: boolean;
  status: string;               // NOT_CONNECTED | CONNECTED | EXPIRED | REAUTH_REQUIRED | …
  /** The member the posts will be authored by. */
  displayName?: string;
  authorUrn?: string;
  needsReauth: boolean;
  /** ISO-8601, from `integration.expiresAt.toISOString()`; absent when no token expiry is known. */
  expiresAt?: string;
  /** True when the SERVER has LinkedIn app credentials (OAuth can run at all). */
  configured: boolean;
  lastError?: string;
}

/* ---- Social setup readiness (Settings → Social Accounts) ---- */
export type NetworkReadinessStatus =
  | 'pending_support' | 'disabled' | 'needs_credentials' | 'ready' | 'connected';

export interface NetworkReadiness {
  provider: string;
  label: string;
  platform: string;
  status: NetworkReadinessStatus;
  /** Env var NAMES that are unset — never values. */
  missingEnv: string[];
  redirectUri?: string;
  expectedRedirectUri: string;
  redirectWarning?: string;
  scopes: string[];
  appReview?: string;
  caveat?: string;
  /** Set when the network is configured yet still cannot publish — e.g.
   *  Instagram with media Meta's servers cannot download. */
  publishBlocker?: string;
  docsUrl: string;
  connectedAccounts: number;
  connectedAs?: string;
}

export interface SocialReadinessReport {
  networks: NetworkReadiness[];
  appUrl: string;
  anyConfigured: boolean;
}

/* ---- Facebook connect-by-token (no OAuth app required) ---- */
export interface FacebookTokenConnectResult {
  /** 'user' → choose a Page next; 'page' → that Page is already selected. */
  kind: 'user' | 'page';
  pages: FacebookPageOption[];
  status: FacebookConnectionStatus;
  /** Graph Explorer tokens last ~1-2h; the UI says so rather than letting a post fail later. */
  shortLived: boolean;
  expiresAt?: string;
  note?: string;
}

/**
 * What a "publish one real post" endpoint returns — identical for Facebook and
 * LinkedIn. `accepted` is the provider's verdict, not ours; on refusal the
 * provider's own message and code come back unmodified.
 */
export interface SocialTestPostResult {
  accepted: boolean;
  providerPostId?: string;
  permalink?: string;
  errorMessage?: string;
  errorCode?: string;
}

/* ---- Social analytics (Analytics → Social) ---- */

/**
 * What a provider could tell us about one post. Every field is optional on
 * purpose: a missing number means the provider returned nothing, which is not
 * the same as zero, and the UI renders the two differently.
 */
export interface SocialMetrics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
}

/** One published post, with whatever insights the provider had for it. */
export interface SocialPostMetricsRow {
  postId: string;
  targetId: string;
  name: string;
  caption: string;
  platform: string;
  accountId: string;
  permalink?: string;
  publishedAt?: string;
  /** null when the provider returned nothing for this post. */
  metrics: SocialMetrics | null;
}

export interface SocialAnalyticsTotals {
  reach: number; impressions: number; views: number;
  likes: number; comments: number; shares: number; clicks: number;
  engagement: number; posts: number;
}

export interface SocialAnalyticsDay {
  date: string;
  reach: number; views: number; engagement: number;
  likes: number; comments: number; shares: number; posts: number;
}

/**
 * `available: false` means no provider actually answered, and `reason` says why.
 * The page shows em-dashes rather than zeroes in that case — a zero would read
 * as "measured nothing" when the truth is "measured nothing at all".
 */
export interface SocialAnalyticsView {
  available: boolean;
  reason?: string;
  range: { from: string; to: string };
  accountId?: string;
  totals: SocialAnalyticsTotals;
  /** One entry per day in range, ascending. */
  daily: SocialAnalyticsDay[];
  posts: SocialPostMetricsRow[];
}

export interface SocialAnalyticsParams {
  from?: string;
  to?: string;
  accountId?: string;
}

/* ---- Instagram messaging readiness (Instagram inbox + Settings) ---- */
export type MessagingCheckStatus =
  | 'ok'        // verified true
  | 'problem'   // verified false — `fix` says what to do
  | 'unknown'   // could not be verified automatically (e.g. no app credentials on the server)
  | 'manual';   // cannot be checked by API at all — a step the person must do in Meta/Instagram

export interface MessagingCheck {
  key:
    | 'server_config'    // META_APP_SECRET + META_WEBHOOK_VERIFY_TOKEN set on the server
    | 'page_connected'   // Facebook connected and a Page selected
    | 'instagram_linked' // an Instagram professional account is linked to that Page
    | 'token_valid'      // Page token is valid (not expired)
    | 'permissions'      // token has instagram_basic, instagram_manage_messages, pages_manage_metadata
    | 'page_subscribed'  // Page subscribed to this app's webhooks with `messages`
    | 'app_webhook'      // App Dashboard has the "instagram" webhook object with the `messages` field
    | 'allow_access'     // manual: Instagram app → Allow access to messages
    | 'app_published'    // manual: Meta app published (Live)
    | 'last_message';    // info: last Instagram DM received ('ok' when one exists, else 'unknown')
  label: string;         // short human title, already written by the server
  status: MessagingCheckStatus;
  detail?: string;       // what was found (e.g. "Missing: instagram_manage_messages")
  fix?: string;          // what to do about it (plain sentence(s))
}

export interface InstagramMessagingReadiness {
  /** True when every check that CAN be verified is 'ok' (manual/info checks excluded). */
  ready: boolean;
  pageName?: string;
  instagramUsername?: string;
  /** The callback URL Meta has on file for the Instagram webhook, when readable. */
  webhookCallbackUrl?: string;
  /** ISO time of the most recent inbound Instagram DM in this workspace. */
  lastInboundAt?: string;
  /** True when a Page is connected, so the "Subscribe Page" action can be offered. */
  canSubscribe: boolean;
  /** Checks, in the order they should be displayed. */
  checks: MessagingCheck[];
  /** ISO time the server ran these checks. */
  checkedAt: string;
}
