import type { SocialAccount, SocialProviderStatus } from '@/types';

const FB_CAPS = {
  maxTextLength: 63206,
  media: { image: true, video: true, maxImages: 10, required: false },
  supportsLink: true, supportsHashtags: true, supportsMentions: false, supportsCta: true,
  imageFormats: ['jpg', 'jpeg', 'png', 'gif'], videoFormats: ['mp4', 'mov'],
  notes: ['Person @mentions are not supported through the API.'],
};
const IG_CAPS = {
  maxTextLength: 2200,
  media: { image: true, video: true, maxImages: 10, required: true },
  supportsLink: false, supportsHashtags: true, supportsMentions: true, supportsCta: false,
  imageFormats: ['jpg', 'jpeg', 'png'], videoFormats: ['mp4', 'mov'],
  notes: ['A feed post requires at least one image or video.', 'Links in captions are not clickable on Instagram.', 'Up to 30 hashtags per post.'],
};

// Demo mode: providers show as available but NOT configured / NOT connected —
// never as a fake live connection.
export const seedProviders = (): SocialProviderStatus[] => [
  { provider: 'facebook', label: 'Facebook Pages', platform: 'FACEBOOK', available: true, configured: false, connected: false, accountCount: 0, capabilities: FB_CAPS },
  { provider: 'instagram', label: 'Instagram Business', platform: 'INSTAGRAM', available: true, configured: false, connected: false, accountCount: 0, capabilities: IG_CAPS },
  { provider: 'linkedin', label: 'LinkedIn', platform: 'LINKEDIN', available: false, configured: false, connected: false, accountCount: 0, capabilities: null },
  { provider: 'twitter', label: 'X (Twitter)', platform: 'TWITTER', available: false, configured: false, connected: false, accountCount: 0, capabilities: null },
  { provider: 'youtube', label: 'YouTube', platform: 'YOUTUBE', available: false, configured: false, connected: false, accountCount: 0, capabilities: null },
];

// No connected accounts in demo mode — connecting requires real credentials.
export const seedAccounts = (): SocialAccount[] => [];
