export type AuditStrategy = 'mobile' | 'desktop';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface AuditCheck {
  key: string; label: string; status: CheckStatus; found: string; advice: string; weight: number;
}
export interface AuditSummary {
  title?: string; description?: string; h1: string[]; wordCount: number;
  images: number; imagesWithoutAlt: number; internalLinks: number; externalLinks: number;
  canonical?: string; lang?: string;
}
export interface PsiResult {
  available: boolean;
  reason?: string;
  strategy: AuditStrategy;
  scores?: { performance?: number; seo?: number; accessibility?: number; bestPractices?: number };
  lab?: { lcpMs?: number; cls?: number; tbtMs?: number; fcpMs?: number; speedIndexMs?: number; ttiMs?: number };
  field?: { lcpMs?: number; cls?: number; inpMs?: number; overall?: string };
  fetchedAt: string;
}
export interface SeoAudit {
  id: string; url: string; finalUrl: string; strategy: AuditStrategy;
  score: number; psiScore: number | null; httpStatus: number;
  summary: AuditSummary; checks: AuditCheck[]; psi: PsiResult | null;
  createdAt: string;
}
/** List rows carry no check payload — it is fetched per audit. */
export type SeoAuditRow = Pick<SeoAudit, 'id' | 'url' | 'finalUrl' | 'strategy' | 'score' | 'psiScore' | 'httpStatus' | 'createdAt'>;
export interface SeoStatus {
  pageSpeed: { enabled: boolean; keyed: boolean; note?: string };
}

// ── Search Console ───────────────────────────────────────────────────────────
export interface GscConnection {
  configured: boolean;
  status: 'CONNECTED' | 'NOT_CONNECTED' | 'SYNCING' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED';
  integrationId?: string;
  account?: string;
  property?: string;
  hasRefreshToken: boolean;
  lastError?: string;
  connectedAt?: string;
}
export interface GscSite { siteUrl: string; permissionLevel: string }
export interface GscMetrics { clicks: number; impressions: number; ctr: number; position: number }
export interface GscDaily extends GscMetrics { date: string }
export interface GscNamed extends GscMetrics { key: string }
export type GscOverview =
  | { available: false; reason: string; property?: string; range: { from: string; to: string } }
  | {
      available: true; property: string; account?: string; range: { from: string; to: string };
      latestDataDate?: string; totals: GscMetrics; daily: GscDaily[];
      queries: GscNamed[]; pages: GscNamed[]; devices: GscNamed[]; countries: GscNamed[];
    };

// ── Keywords ─────────────────────────────────────────────────────────────────
export interface KeywordPoint { date: string; position: number; clicks: number; impressions: number }
export interface TrackedKeyword {
  id: string; keyword: string; property: string; country?: string; device?: string;
  createdAt: string; lastSyncedAt?: string; lastError?: string;
  clicks: number; impressions: number; ctr: number;
  avgPosition: number | null; position: number | null; positionDate: string | null; change: number | null;
  series: KeywordPoint[];
}
export interface KeywordsList { items: TrackedKeyword[]; total: number; range: { from: string; to: string }; stale: boolean; lastSyncedAt?: string }
export interface KeywordSyncResult { keywords: number; synced: number; failed: number; rows: number; errors: Array<{ keyword: string; reason: string }> }

// ── Content Ideas ────────────────────────────────────────────────────────────
export type ContentTone = 'professional' | 'friendly' | 'persuasive' | 'informative';
export type ContentType = 'blog' | 'landing' | 'social';
export interface ContentIdeas {
  titles: string[]; metaDescriptions: string[];
  outline: Array<{ heading: string; points: string[] }>;
  faq: Array<{ question: string; answer: string }>;
  socialCaption: string; hashtags: string[]; keywordsUsed: string[];
}
export interface ContentDraft {
  id: string; topic: string; keywords: string[]; audience?: string; tone: ContentTone; contentType: ContentType; language: string;
  model: string; result: ContentIdeas; createdAt: string; socialPostId?: string; sentAt?: string;
}
export type ContentDraftRow = Pick<ContentDraft, 'id' | 'topic' | 'keywords' | 'contentType' | 'tone' | 'model' | 'createdAt' | 'sentAt' | 'socialPostId'>;
export interface GenerateContentInput { topic: string; keywords: string[]; audience?: string; tone: ContentTone; contentType: ContentType; language: string }
