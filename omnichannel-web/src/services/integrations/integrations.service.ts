import type { IntegrationView, ConnectResult, DirectCredentialsInput, ProviderSendResult } from '@/types';
import { config } from '../config';
import { apiRequest } from '../apiClient';
import { mockLatency } from '../mockDb';
import type {
  ChannelTestResult, ChannelVerifyResult, EmailConnectInput, EmailProviderView,
  SmsConnectInput, SmsProviderView, SmsTestInput,
} from './integrations.types';

// Demo catalog. Honest: nothing is CONNECTED and nothing is "configured" without
// server credentials — mock data is never presented as a live account.
const DEMO_CATALOG: IntegrationView[] = [
  { provider: 'whatsapp', label: 'WhatsApp Business', status: 'NOT_CONNECTED', configured: false },
];

const real = config.isRealApi('integrations');

const NEEDS_API = 'Connecting a real provider account requires the Green Start API. Set VITE_REAL_APIS to include “integrations”.';

export const integrationsService = {
  async list(_orgId: string): Promise<IntegrationView[]> {
    if (!real) { await mockLatency(150); return DEMO_CATALOG.map((x) => ({ ...x })); }
    return apiRequest<IntegrationView[]>('integrations');
  },
  async connect(_orgId: string, provider: string): Promise<ConnectResult> {
    if (!real) {
      await mockLatency(120);
      return { configured: false, message: 'Connecting requires the backend and provider credentials. Not available in demo mode.' };
    }
    return apiRequest<ConnectResult>(`integrations/${provider}/connect`, { method: 'POST' });
  },
  async callback(_orgId: string, provider: string, code: string, state: string): Promise<IntegrationView> {
    return apiRequest<IntegrationView>(`integrations/${provider}/callback`, { method: 'POST', body: { code, state } });
  },
  /**
   * Connect with credentials the workspace already holds (WhatsApp Cloud API).
   * Requires the real backend — there is nothing honest to simulate here, since
   * the whole point is that Meta verifies the token.
   */
  async connectWithCredentials(_orgId: string, provider: string, input: DirectCredentialsInput): Promise<IntegrationView> {
    if (!real) throw new Error(NEEDS_API);
    return apiRequest<IntegrationView>(`integrations/${provider}/credentials`, { method: 'POST', body: input });
  },
  /** Send one real message through a connected provider. */
  async sendTestMessage(_orgId: string, id: string, input: { to: string; text?: string; templateName?: string; templateLanguage?: string }): Promise<ProviderSendResult> {
    return apiRequest<ProviderSendResult>(`integrations/${id}/test-message`, { method: 'POST', body: input });
  },
  async test(_orgId: string, id: string): Promise<{ healthy: boolean; detail?: string }> {
    return apiRequest(`integrations/${id}/test`, { method: 'POST' });
  },
  async sync(_orgId: string, id: string): Promise<IntegrationView> {
    return apiRequest(`integrations/${id}/sync`, { method: 'POST' });
  },
  async disconnect(_orgId: string, id: string): Promise<{ disconnected: boolean }> {
    return apiRequest(`integrations/${id}`, { method: 'DELETE' });
  },

  // ── Email (SMTP) — this workspace's own mailbox ────────────────────────────
  /**
   * This workspace's mailbox (never the password) and which sender its email
   * would use. Null in demo mode: there is no server to ask, and inventing a
   * status would be dishonest.
   */
  async emailProvider(_orgId: string): Promise<EmailProviderView | null> {
    if (!real) { await mockLatency(120); return null; }
    return apiRequest<EmailProviderView>('integrations/email');
  },
  /** Connect or update. The server authenticates against the mail server before saving. */
  async connectEmail(_orgId: string, input: EmailConnectInput): Promise<EmailProviderView> {
    if (!real) throw new Error(NEEDS_API);
    return apiRequest<EmailProviderView>('integrations/email', { method: 'PUT', body: input });
  },
  /** Open an SMTP session and authenticate. Sends nothing. */
  async emailVerify(_orgId: string): Promise<ChannelVerifyResult> {
    return apiRequest<ChannelVerifyResult>('integrations/email/verify', { method: 'POST' });
  },
  /** Send one real email through this workspace's sender. */
  async emailSendTest(_orgId: string, to: string): Promise<ChannelTestResult> {
    return apiRequest<ChannelTestResult>('integrations/email/send-test', { method: 'POST', body: { to } });
  },
  async disconnectEmail(_orgId: string): Promise<{ disconnected: boolean }> {
    return apiRequest('integrations/email', { method: 'DELETE' });
  },

  // ── SMS (MSG91) — this workspace's own account ─────────────────────────────
  /** This workspace's MSG91 account (never the auth key). Null in demo mode. */
  async smsProvider(_orgId: string): Promise<SmsProviderView | null> {
    if (!real) { await mockLatency(120); return null; }
    return apiRequest<SmsProviderView>('integrations/sms');
  },
  async connectSms(_orgId: string, input: SmsConnectInput): Promise<SmsProviderView> {
    if (!real) throw new Error(NEEDS_API);
    return apiRequest<SmsProviderView>('integrations/sms', { method: 'PUT', body: input });
  },
  /** Honest check: reports the credentials are present; MSG91 cannot be verified without sending. */
  async smsVerify(_orgId: string): Promise<ChannelVerifyResult> {
    return apiRequest<ChannelVerifyResult>('integrations/sms/verify', { method: 'POST' });
  },
  /** One real DLT-registered SMS — the only proof MSG91 offers. */
  async smsSendTest(_orgId: string, input: SmsTestInput): Promise<ChannelTestResult> {
    return apiRequest<ChannelTestResult>('integrations/sms/send-test', { method: 'POST', body: input });
  },
  async disconnectSms(_orgId: string): Promise<{ disconnected: boolean }> {
    return apiRequest('integrations/sms', { method: 'DELETE' });
  },
};
