export type AdPlatformKey = 'facebook' | 'instagram' | 'linkedin' | 'youtube' | 'twitter';
export type AdObjectiveKey = 'awareness' | 'traffic' | 'engagement' | 'leads' | 'app_promotion' | 'sales';
export type AdBuyingTypeKey = 'auction' | 'reservation';
export type AdDraftStatusKey = 'draft' | 'ready' | 'launched' | 'failed';

export interface AdPlatformState {
  key: AdPlatformKey;
  /** A live, connected account exists for this network. */
  connected: boolean;
  /** Green Start has an ad builder for it. Only the Meta networks do today. */
  builder: boolean;
}

export interface BoostCampaign {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  objective: string;
  budgetType: 'daily' | 'lifetime';
  budgetMinor: number;
  currency: string;
  startAt?: string;
  endAt?: string;
  postId?: string;
  providerCampaignId?: string;
  lastError?: string;
  createdAt: string;
}

export interface AdDraft {
  id: string;
  platform: AdPlatformKey;
  name: string;
  adAccountId?: string;
  adAccountName?: string;
  adAccountCurrency?: string;
  pageId?: string;
  pageName?: string;
  buyingType: AdBuyingTypeKey;
  objective: AdObjectiveKey;
  primaryText?: string;
  headline?: string;
  linkUrl?: string;
  callToAction?: string;
  mediaUrls: string[];
  status: AdDraftStatusKey;
  providerCampaignId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdDraftInput {
  platform: AdPlatformKey;
  name: string;
  adAccountId?: string | null;
  pageId?: string | null;
  buyingType: AdBuyingTypeKey;
  objective: AdObjectiveKey;
  primaryText?: string | null;
  headline?: string | null;
  linkUrl?: string | null;
  callToAction?: string | null;
  mediaUrls: string[];
}

export interface AdsOverview {
  boostCampaigns: BoostCampaign[];
  recentDrafts: AdDraft[];
  draftCount: number;
  /** A real ads provider is configured server-side. False = nothing can launch. */
  adsConfigured: boolean;
}

export interface BoostablePost {
  id: string;
  name: string;
  caption: string;
  publishedAt: string;
  thumbnailUrl?: string;
  platforms: AdPlatformKey[];
  permalink?: string;
}

export interface FacebookAdAccount {
  id: string;
  accountId?: string;
  name: string;
  currency?: string;
  active: boolean;
  /** This user may only ANALYZE the account — it cannot create ads. */
  readOnly: boolean;
}

export interface FacebookPageOption { id: string; name: string; category?: string }

export interface FacebookAdTargets {
  accounts: FacebookAdAccount[];
  pages: FacebookPageOption[];
  /** Why `accounts` is empty when it is — absent means "genuinely none". */
  unavailableReason?: string;
}

export interface AdLaunchResult {
  launched: boolean;
  configured: boolean;
  code: string;
  message: string;
  draftId: string;
}
