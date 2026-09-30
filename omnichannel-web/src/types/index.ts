/**
 * Green Start — frontend types = the frontend<->backend contract.
 * Enums are lowercase on the wire; the NestJS API maps to/from its Prisma enums.
 * Kept in sync with claude/green-start.types.ts (the canonical contract).
 */

/* ---- API envelope + list contract ---- */
export interface ApiSuccess<T> { success: true; data: T; message?: string }
export interface ApiFailure {
  success: false;
  error: { code: ApiErrorCode; message: string; details?: Array<{ field: string; message: string }> };
}
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type ApiErrorCode =
  | 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'UNPROCESSABLE' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'NETWORK_ERROR';

export interface ListParams {
  search?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  filters?: Record<string, string | undefined>;
}
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

export type ISODateString = string;

/* ---- enums ---- */
export type Channel = 'whatsapp' | 'facebook' | 'sms' | 'email' | 'rcs' | 'voice';
export type LeadStage = 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';
export type LeadStatus = 'active' | 'inactive' | 'unqualified';
export type CampaignStatus =
  | 'draft' | 'scheduled' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
export type ConnectionHealth =
  | 'connected' | 'healthy' | 'needs_reconnect' | 'expired' | 'rate_limited' | 'error' | 'disconnected';

/* ---- identity / tenancy ---- */
export interface User { id: string; name: string; email: string; avatarColor?: string; isSuperAdmin?: boolean }
export interface Workspace { id: string; name: string; plan?: string; logoText?: string; role?: string }
export interface MeResponse { user: User; workspaces: Workspace[]; permissions: string[] }

/* ---- dashboard ---- */
export interface Kpi { key: string; label: string; value: number; deltaPct: number; unit: string; spark: number[] }
export interface ChannelHealthCard {
  channel: Channel; label: string; status: ConnectionHealth; deliveredPct: number; volume: number;
}
export interface RecentCampaign {
  id: string; name: string; channel: Channel; status: CampaignStatus; sent: number; delivered: number;
}
export interface DashboardInsight {
  id: string; title: string; detail: string; tone: 'positive' | 'neutral' | 'warning'; href?: string;
}
export interface PerformancePoint { label: string; reach: number; engagement: number }
export interface DashboardOverview {
  kpis: Kpi[];
  channels: ChannelHealthCard[];
  recentCampaigns: RecentCampaign[];
  insights: DashboardInsight[];
  performance: PerformancePoint[];
}
export interface DateRangeParams { from?: ISODateString; to?: ISODateString; timezone?: string }

/* ---- CRM ---- */
export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  platformId?: string;
  source: string;
  campaignName?: string;
  leadStage: LeadStage;
  leadStatus: LeadStatus;
  assignedAgentId?: string;
  /** DPDP marketing consent, rolled up from the consent records. */
  consentStatus?: ConsentStatus;
  /** The web form or bot flow that captured this contact, when one did. */
  capturedBy?: { kind: 'web_form' | 'bot'; id: string; name: string };
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
export type ConsentStatus = 'unknown' | 'granted' | 'withdrawn';
export interface ConsentRecord {
  id: string; purpose: string; status: 'granted' | 'withdrawn'; source: string;
  noticeVersion?: string; note?: string; recordedById?: string; occurredAt: ISODateString;
}
export type CustomerInput = Omit<Customer, 'id' | 'createdAt' | 'updatedAt' | 'consentStatus'>;

export type CustomFieldType =
  | 'text' | 'number' | 'boolean' | 'date' | 'time' | 'url' | 'dropdown' | 'multiselect';
export interface CustomField {
  id: string;
  name: string;
  key: string;
  type: CustomFieldType;
  options?: string[];
  color: string;
  required: boolean;
  /** Web forms whose picker includes this field — read-only, set by the server. */
  usedByForms?: { id: string; name: string }[];
  createdAt: ISODateString;
}
export type CustomFieldInput = Omit<CustomField, 'id' | 'createdAt' | 'usedByForms'>;

export type SegmentField = 'leadStage' | 'leadStatus' | 'source';
export type SegmentOperator = 'equals' | 'not_equals' | 'contains' | 'in';
export interface SegmentRule { field: SegmentField; operator: SegmentOperator; value: string }
export interface Segment {
  id: string;
  name: string;
  description?: string;
  rules: SegmentRule[];
  logic: 'AND' | 'OR';
  createdAt: ISODateString;
}
export type SegmentInput = Omit<Segment, 'id' | 'createdAt'>;

export interface Agent { id: string; name: string; color?: string }

/* ---- Campaigns ---- */
export interface Campaign {
  id: string;
  name: string;
  channel: Channel;
  status: CampaignStatus;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  templateId?: string;
  scheduledAt?: ISODateString;
  createdAt: ISODateString;
}
export interface CampaignCreateInput { name: string; channel: Channel }

/** Per-recipient send row (the Communication Console delivery log). */
export type RecipientStatus = 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
export interface CampaignRecipient {
  id: string;
  customerId?: string;
  phone?: string;
  email?: string;
  status: RecipientStatus;
  error?: string;
  createdAt: ISODateString;
}

/* ---- Communication Console (direct send) ---- */
export type DirectSendAudienceType = 'all' | 'segment' | 'manual';
export interface DirectSendAudience {
  type: DirectSendAudienceType;
  segmentId?: string;
  /** Phone numbers (or emails, for the email channel) when type = 'manual'. */
  recipients?: string[];
}
export interface DirectSendInput {
  name: string;
  channel: Channel;
  templateId?: string | null;
  /**
   * Values for the template's numbered variables, keyed by index: { "1": "…" }.
   * A value may contain {{name}} / {{first_name}} / {{email}} / {{phone}}, which
   * are filled from each contact at send time.
   */
  variableValues?: Record<string, string>;
  audience: DirectSendAudience;
}
export interface DirectSendResult { campaignId: string; status: 'queued' }

/* ---- Templates ---- */
export type TemplateStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'in_review';
export type TemplateHeaderType = 'none' | 'text' | 'image' | 'video' | 'document';
export type TemplateButtonType =
  | 'QUICK_REPLY' | 'URL' | 'PHONE' | 'WA_CALL' | 'COPY_CODE' | 'FLOW' | 'ORDER_DETAILS';
export interface TemplateButton {
  type: TemplateButtonType;
  text: string;
  phone?: string;
  countryCode?: string;
  url?: string;
  offerCode?: string;
}
export interface Template {
  id: string;
  name: string;
  channel: Channel;
  provider: string;
  category: string;
  language: string;
  status: TemplateStatus;
  header?: string;
  body: string;
  footer?: string;
  variables: number;
  updatedAt: ISODateString;
  // Rich WhatsApp structure (persisted in the backend Template.meta JSON)
  headerType?: TemplateHeaderType;
  headerText?: string;
  headerMediaName?: string;
  callPermission?: boolean;
  buttons?: TemplateButton[];
}
export type TemplateInput = Omit<Template, 'id' | 'status' | 'updatedAt'>;

export type TemplateVerdict = 'PASS' | 'WARN' | 'FAIL';
export interface TemplateViolation { code: string; severity: 'WARN' | 'FAIL'; message: string }
export interface TemplateValidationResult { verdict: TemplateVerdict; violations: TemplateViolation[] }

/* ---- Integrations ---- */
export type IntegrationStatus =
  | 'CONNECTED' | 'NOT_CONNECTED' | 'SYNCING' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED';
export interface IntegrationView {
  provider: string;
  label: string;
  status: IntegrationStatus;
  configured: boolean;
  displayName?: string;
  externalAccountId?: string;
  lastSyncedAt?: string;
  lastError?: string;
  id?: string;
  /** True when the server has OAuth app credentials for this provider. */
  oauthConfigured?: boolean;
  /** True when the provider can be connected by entering your own API credentials. */
  supportsCredentials?: boolean;
}
export interface ConnectResult { configured: boolean; authorizeUrl?: string; state?: string; message?: string }
/** Credentials the workspace already holds, entered by the user. Write-only — the
 *  server verifies them, stores them encrypted, and never returns the token. */
export interface DirectCredentialsInput {
  accessToken: string;
  phoneNumberId?: string;
  wabaId?: string;
  label?: string;
}
export interface ProviderSendResult {
  accepted: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/* ---- Team & RBAC ---- */
export type MemberStatus = 'active' | 'invited' | 'suspended';
export interface TeamMember {
  id: string;
  user: { id: string; name: string; email: string; avatarUrl?: string };
  role: { id: string; key: string; name: string };
  status: MemberStatus;
  joinedAt: ISODateString;
  lastActiveAt?: ISODateString;
}
export interface TeamRole {
  id: string;
  key: string;
  name: string;
  description?: string;
  isSystem: boolean;
  memberCount: number;
  /** Permissions granted DIRECTLY on the role. Policy grants are never folded in here. */
  permissionKeys: string[];
  /**
   * Policies attached to this role, as `GET team/roles` reports them. The
   * "Policies attached" column and the role editor read this field and nothing
   * else — no policy is ever inferred from `permissionKeys`.
   *
   * Still OPTIONAL, deliberately: the mock branch of team.service builds roles
   * locally, and a gs-api instance older than the Policy resource answers roles
   * without the field. Both cases must read as "no policies known" rather than
   * crash, so every reader does `role.policies ?? []`. A role that genuinely has
   * none sends `[]`; the column shows an em-dash for both, which is truthful.
   */
  policies?: RolePolicy[];
}
/** A named policy as it appears ON a role — the summary shape `team/roles` embeds. */
export interface RolePolicy {
  id: string;
  name: string;
  description?: string;
}
/**
 * A reusable permission bundle, as the Policies resource lists it.
 * `roleCount` is server-computed: how many roles currently attach this policy.
 */
export interface Policy {
  id: string;
  key: string;
  name: string;
  description?: string;
  permissionKeys: string[];
  roleCount: number;
  createdAt: ISODateString;
}
/** POST body; PATCH takes a Partial of it (the server never reassigns `key`). */
export interface PolicyInput {
  key: string;
  name: string;
  description?: string;
  permissionKeys: string[];
}
export interface PermissionDef { key: string; group: string; description: string }
export interface RoleInput { name: string; description?: string; permissionKeys: string[] }
export interface InviteInput { email: string; roleKey: string }
export interface InviteResult {
  id: string;
  email: string;
  role: { key: string; name: string };
  token?: string;
  delivery: 'demo' | 'email';
}

/* ---- Inbox / Conversations ---- */
export type ConversationStatus = 'open' | 'pending' | 'snoozed' | 'closed';
export interface Conversation {
  id: string;
  channel: Channel;
  customerId?: string;
  contactName?: string;
  contactPhone?: string;
  /** The channel's own id when it is not a phone — a Messenger PSID, say. */
  externalContactId?: string;
  status: ConversationStatus;
  assignedAgentId?: string;
  lastMessageAt?: ISODateString;
  lastMessagePreview?: string;
  unreadCount: number;
  createdAt: ISODateString;
}
export type MessageDirection = 'inbound' | 'outbound';
export interface InboxMessage {
  id: string;
  direction: MessageDirection;
  status: string;
  text: string;
  provider?: string;
  errorReason?: string;
  createdAt: ISODateString;
}

/* ---- Analytics ---- */
export interface CommChannelStat {
  channel: string; total: number; queued: number; sent: number; delivered: number; read: number; failed: number;
}
export interface FailureReason { reason: string; count: number }
export interface CommunicationAnalytics {
  range: { from: ISODateString; to: ISODateString };
  totals: { total: number; queued: number; sent: number; delivered: number; read: number; failed: number };
  rates: { deliveredRate: number; readRate: number; failRate: number };
  byChannel: CommChannelStat[];
  failureReasons: FailureReason[];
  performance: PerformancePoint[];
}
export interface CampaignPerf {
  id: string; name: string; channel: string; status: string;
  recipients: number; sent: number; delivered: number; read: number; failed: number; createdAt: ISODateString;
}

/* ---- Settings ---- */
export interface ProfileInput { name?: string; avatarUrl?: string | null }
export interface PasswordChangeInput { currentPassword: string; newPassword: string }
export interface WorkspaceSettings {
  id: string; name: string; slug?: string; logoUrl?: string | null; timezone?: string; currency?: string; status?: string;
}
export interface WorkspaceSettingsInput { name?: string; timezone?: string; logoUrl?: string | null }

/* ---- Web Forms ---- */
export type WebFormFieldType = 'text' | 'email' | 'phone' | 'number' | 'textarea';
export interface WebFormField { key: string; label: string; type: WebFormFieldType; required: boolean }
export type WebFormStatus = 'active' | 'disabled';
export interface WebForm {
  id: string; name: string; description?: string; fields: WebFormField[];
  /** CRM custom fields this form collects, by CustomField id. */
  customFieldIds: string[];
  /** Workspace members (user ids) allowed to read this form's captured data. Empty = unrestricted. */
  permittedMemberIds: string[];
  isDefault: boolean;
  assignedMemberId?: string; publicSlug: string; status: WebFormStatus;
  submissionCount: number; createdAt: ISODateString;
}
export interface WebFormInput {
  name: string; description?: string;
  customFieldIds: string[]; permittedMemberIds: string[];
  fields?: WebFormField[]; assignedMemberId?: string | null;
}
export interface WebFormSubmission { id: string; data: Record<string, unknown>; customerId?: string; createdAt: ISODateString }

/* ---- Billing ---- */
export interface BillingPlan {
  key: string; name: string; tier: string; priceMinor: number; currency: string;
  includedCredits: number; maxSeats?: number; maxWorkspaces?: number; features: string[];
}
export interface BillingSubscription {
  id: string; status: string; creditBalance: number; autoTopUp: boolean;
  periodStart: ISODateString; periodEnd: ISODateString; cancelledAt?: ISODateString;
}
export interface BillingOverview {
  subscription: BillingSubscription | null;
  plan: BillingPlan | null;
  usage: { creditsUsed: number; creditsIncluded: number; creditBalance: number };
}
export interface CreditTxn { id: string; delta: number; balanceAfter: number; reason: string; description?: string; createdAt: ISODateString }

/* ---- Automations ---- */
export type AutomationTrigger = 'customer_created' | 'form_submitted' | 'stage_changed';
export type AutomationStatus = 'active' | 'paused';
export type AutomationConditionField = 'source' | 'leadStage' | 'leadStatus';
export type AutomationConditionOperator = 'equals' | 'not_equals' | 'contains' | 'in';
export interface AutomationCondition {
  field: AutomationConditionField;
  operator: AutomationConditionOperator;
  value: string | string[];
}
export type AutomationActionType = 'add_tag' | 'set_stage' | 'set_status' | 'assign_agent';
export interface AutomationAction {
  type: AutomationActionType;
  tag?: string;
  stage?: LeadStage;
  status?: LeadStatus;
  agentId?: string;
}
export interface Automation {
  id: string; name: string; description?: string;
  trigger: AutomationTrigger; logic: 'AND' | 'OR';
  conditions: AutomationCondition[]; actions: AutomationAction[];
  status: AutomationStatus; runCount: number; matchCount: number;
  lastRunAt?: ISODateString; createdAt: ISODateString; updatedAt: ISODateString;
}
export interface AutomationInput {
  name: string; description?: string; trigger: AutomationTrigger; logic: 'AND' | 'OR';
  conditions: AutomationCondition[]; actions: AutomationAction[];
}
export type AutomationRunStatus = 'success' | 'skipped' | 'failed';
export interface AutomationRun {
  id: string; automationId: string; trigger: AutomationTrigger; status: AutomationRunStatus;
  entityType: string; entityId?: string; actionsApplied: string[]; error?: string; createdAt: ISODateString;
}
export interface AutomationTestResult {
  automationId: string; automationName: string; status: AutomationRunStatus;
  actionsApplied: string[]; error?: string;
}

/* ---- Audit Log ---- */
export interface AuditActor { id: string; name: string; email: string }
export interface AuditLogEntry {
  id: string; action: string; entityType?: string; entityId?: string;
  summary: string; actor?: AuditActor; ipAddress?: string;
  metadata?: Record<string, unknown>; createdAt: ISODateString;
}

/* ---- Super Admin (platform operator console) ---- */
export interface SuperAdminStats {
  organizations: number; workspaces: number; users: number;
  activeSubscriptions: number; suspendedOrgs: number; superAdmins: number;
}
export type OrgStatus = 'active' | 'trial' | 'suspended';
export interface AdminOrg {
  id: string; name: string; slug: string; status: OrgStatus;
  country: string; currency: string;
  ownerName: string | null; ownerEmail: string | null;
  workspaceCount: number; plan: string | null;
  subscriptionStatus: string | null; creditBalance: number | null;
  createdAt: ISODateString;
}
export interface AdminOrgWorkspace { id: string; name: string; slug: string; memberCount: number; createdAt: ISODateString }
export interface AdminOrgDetail {
  id: string; name: string; slug: string; status: OrgStatus;
  country: string; currency: string; timezone: string;
  owner: { id: string; name: string; email: string } | null;
  workspaces: AdminOrgWorkspace[];
  subscription: { plan: string | null; tier: string | null; status: string; creditBalance: number; periodEnd: ISODateString } | null;
  createdAt: ISODateString;
}
export type AdminUserStatus = 'pending' | 'active' | 'suspended';
export interface AdminUser {
  id: string; name: string; email: string; status: AdminUserStatus;
  isSuperAdmin: boolean; membershipCount: number;
  lastLoginAt: ISODateString | null; createdAt: ISODateString;
}

/* ---- Social (accounts & publishing) ---- */
export type SocialPlatform = 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'TWITTER' | 'YOUTUBE';
export type SocialAccountStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'DISCONNECTED';
export interface SocialCapabilities {
  maxTextLength: number;
  media: { image: boolean; video: boolean; maxImages: number; required: boolean };
  supportsLink: boolean;
  supportsHashtags: boolean;
  supportsMentions: boolean;
  supportsCta: boolean;
  imageFormats: string[];
  videoFormats: string[];
  notes: string[];
}
export interface SocialProviderStatus {
  provider: string;
  label: string;
  platform: SocialPlatform;
  available: boolean;
  configured: boolean;
  connected: boolean;
  accountCount: number;
  capabilities: SocialCapabilities | null;
}
export interface SocialAccount {
  id: string;
  provider: string;
  platform: SocialPlatform;
  externalId: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  category?: string;
  status: SocialAccountStatus;
  lastSyncedAt?: ISODateString;
  lastError?: string;
}
export interface SocialConnectResult { configured: boolean; authorizeUrl?: string; state?: string; message?: string }

/* ---- Social posts ---- */
export type SocialPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partially_published' | 'failed' | 'cancelled';
export type SocialTargetStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'skipped' | 'cancelled';
export type SocialMediaType = 'IMAGE' | 'VIDEO';
export interface SocialPostTarget {
  id: string; socialAccountId: string; platform: SocialPlatform; status: SocialTargetStatus;
  providerPostId?: string; permalink?: string; error?: string; publishedAt?: ISODateString;
}
export interface SocialPostMediaItem {
  id: string; type: SocialMediaType; url: string; thumbnailUrl?: string; altText?: string; order: number;
}
export interface SocialPost {
  id: string; name: string; caption: string; linkUrl?: string; hashtags: string[];
  status: SocialPostStatus; audienceId?: string; scheduledAt?: ISODateString; publishedAt?: ISODateString;
  targets: SocialPostTarget[]; media: SocialPostMediaItem[];
  createdAt: ISODateString; updatedAt: ISODateString;
}
export interface SocialPostMediaInput { type: SocialMediaType; url: string; thumbnailUrl?: string; altText?: string }
export interface SocialPostInput {
  name: string; caption: string; linkUrl?: string | null; hashtags: string[];
  accountIds: string[]; media: SocialPostMediaInput[]; audienceId?: string | null;
}
export interface SocialViolation {
  platform: SocialPlatform; code: string; severity: 'ERROR' | 'WARN'; message: string;
}
export interface SocialValidateResult { violations: SocialViolation[]; platforms: SocialPlatform[] }

export interface SocialMediaUploadResult {
  type: SocialMediaType; url: string; contentType: string; size: number; fileName: string;
}

/* ---- Social audiences (targeting/planning profiles) ---- */
export type SocialLocationType = 'country' | 'state' | 'city' | 'postal' | 'radius';
export interface SocialAudience {
  id: string; name: string; description?: string; sector?: string; interests: string[];
  locationType?: SocialLocationType; country?: string; state?: string; city?: string; postalCode?: string;
  radiusKm?: number; centerLabel?: string; centerLat?: number; centerLng?: number;
  ageMin?: number; ageMax?: number; genders: string[]; languages: string[];
  segmentId?: string; segmentName?: string; createdAt: ISODateString; updatedAt: ISODateString;
}
export interface SocialAudienceInput {
  name: string; description?: string | null; sector?: string | null; interests?: string[];
  locationType?: SocialLocationType | null; country?: string | null; state?: string | null; city?: string | null; postalCode?: string | null;
  radiusKm?: number | null; centerLabel?: string | null;
  ageMin?: number | null; ageMax?: number | null; genders?: string[]; languages?: string[]; segmentId?: string | null;
}

/* ---- Social promotions (PAID — separate from organic) ---- */
export type SocialPromotionObjective = 'awareness' | 'traffic' | 'engagement' | 'leads' | 'conversions';
export type SocialBudgetType = 'daily' | 'lifetime';
export type SocialPromotionStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface SocialPromotion {
  id: string; name: string; postId?: string; audienceId?: string;
  objective: SocialPromotionObjective; budgetType: SocialBudgetType; budgetMinor: number; currency: string;
  startAt?: ISODateString; endAt?: ISODateString; status: SocialPromotionStatus;
  provider: string; providerCampaignId?: string; lastError?: string;
  createdAt: ISODateString; updatedAt: ISODateString;
}
export interface SocialPromotionInput {
  name: string; postId?: string | null; audienceId?: string | null;
  objective: SocialPromotionObjective; budgetType: SocialBudgetType; budgetMinor: number; currency: string;
  startAt?: string | null; endAt?: string | null;
}
export interface AdsTargetingSpec {
  geo_locations: Record<string, unknown>; interests: string[];
  age_min?: number; age_max?: number; genders?: number[]; publisher_platforms: string[]; notes: string[];
}
export interface SocialPromotionLaunchResult {
  launched: boolean; configured: boolean; code?: string; message?: string; targetingPreview?: AdsTargetingSpec; promotion?: SocialPromotion;
}

/**
 * The server's outbound-email configuration, as Settings is allowed to see it.
 * Email is configured server-side (SMTP_* in .env), not connected per
 * workspace, so this is reported and tested — never saved from the UI. The
 * password is never part of this shape.
 */
export interface EmailStatusView {
  configured: boolean;
  host?: string;
  port: number;
  secure: boolean;
  username?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  /** Env keys still unset — the one thing that unblocks a stuck install. */
  missing: string[];
}
