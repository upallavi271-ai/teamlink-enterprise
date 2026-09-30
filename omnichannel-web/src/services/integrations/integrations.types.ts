import type { IntegrationStatus, ProviderSendResult } from '@/types';

/**
 * Wire types for a workspace's OWN email (SMTP) and SMS (MSG91) providers.
 *
 * Secrets are write-only: a password or auth key goes to the server in a
 * connect request and never comes back. `hasSecret` is the only thing the
 * browser learns about it — enough to say "leave blank to keep the current one".
 */

export type SenderSource = 'workspace' | 'platform';

/** Which account this workspace's email / SMS would actually go out through right now. */
export interface SenderView {
  ready: boolean;
  source: SenderSource | null;
  /** When not ready: what to do about it. */
  reason?: string;
}

interface ChannelProviderBase {
  status: IntegrationStatus;
  /** This workspace has its OWN provider connected. */
  connected: boolean;
  id?: string;
  displayName?: string;
  externalAccountId?: string;
  lastSyncedAt?: string;
  lastError?: string;
  hasSecret: boolean;
  sender: SenderView;
}

export interface EmailSettingsView {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  fromName?: string;
  replyTo?: string;
}

export interface EmailProviderView extends ChannelProviderBase {
  provider: 'email';
  settings?: EmailSettingsView;
}

export interface SmsSettingsView {
  senderId: string;
  route: string;
  defaultCountryCode: string;
  dltEntityId?: string;
}

export interface SmsProviderView extends ChannelProviderBase {
  provider: 'sms';
  /** Always false — MSG91 cannot be proved without sending. */
  verified: false;
  detail?: string;
  settings?: SmsSettingsView;
}

/** PUT /integrations/email. Omit `password` to keep the stored one (same host + username only). */
export interface EmailConnectInput {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  label?: string;
}

/** PUT /integrations/sms. Omit `authKey` to keep the stored one. */
export interface SmsConnectInput {
  authKey?: string;
  senderId: string;
  route: '1' | '4';
  defaultCountryCode: string;
  dltEntityId?: string;
  label?: string;
}

export interface SmsTestInput {
  to: string;
  flowId: string;
  variables?: Record<string, string>;
}

export interface ChannelVerifyResult {
  healthy: boolean;
  detail?: string;
  source?: SenderSource;
}

export interface ChannelTestResult extends ProviderSendResult {
  source?: SenderSource;
}
