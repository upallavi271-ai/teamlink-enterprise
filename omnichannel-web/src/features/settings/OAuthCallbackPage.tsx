import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useOrgStore } from '@/stores/orgStore';
import { integrationsService } from '@/services/integrations/integrations.service';
import { toast } from '@/components/toast/toastStore';

const LABEL: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', google_search_console: 'Google Search Console' };
/** Where to land after a successful connection; Settings unless the provider has its own home. */
const AFTER: Record<string, string> = { google_search_console: '/app/seo/search-console' };

/**
 * OAuth redirect landing page. A provider (Facebook / LinkedIn) redirects the
 * browser here with ?code&state after the user authorises. This page hands the
 * code to the backend (server-side token exchange — the client secret never
 * touches the browser), then returns the user to Settings. Register this page's
 * URL as the provider's redirect URI (e.g. .../app/settings/oauth/facebook).
 */
export function OAuthCallbackPage() {
  const { provider = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [detail, setDetail] = useState('');
  const ran = useRef(false);

  const label = LABEL[provider] ?? provider;
  const code = params.get('code');
  const oauthState = params.get('state') ?? '';
  const providerError = params.get('error_description') ?? params.get('error');

  useEffect(() => {
    if (ran.current) return; // exchange exactly once

    if (providerError) { ran.current = true; setState('error'); setDetail(providerError); return; }
    if (!code) { ran.current = true; setState('error'); setDetail('No authorization code was returned.'); return; }
    // Workspace hydrates from the persisted session on load — wait for it rather than failing.
    if (!orgId) return;

    ran.current = true;
    integrationsService
      .callback(orgId, provider, code, oauthState)
      .then(() => {
        setState('ok');
        toast.success(`${label} connected.`);
        // Facebook still needs a Page chosen — send them to Settings to finish.
        setTimeout(() => navigate(AFTER[provider] ?? '/app/settings', { replace: true }), 1200);
      })
      .catch((e: unknown) => {
        setState('error');
        setDetail(e instanceof Error ? e.message : 'Could not complete the connection.');
      });
  }, [code, oauthState, orgId, provider, providerError, label, navigate]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center py-20">
      <Card className="w-full">
        <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
          {state === 'working' && (
            <>
              <Loader2 size={28} className="animate-spin text-accent" />
              <p className="font-display text-lg font-semibold text-ink">Finishing {label} connection…</p>
              <p className="text-sm text-muted">Exchanging the authorization securely on the server.</p>
            </>
          )}
          {state === 'ok' && (
            <>
              <CheckCircle2 size={28} className="text-green-2" />
              <p className="font-display text-lg font-semibold text-ink">{label} connected</p>
              <p className="text-sm text-muted">{AFTER[provider] ? 'Opening the Search Console dashboard' : `Taking you back to Settings${provider === 'facebook' ? ' to choose a Page' : ''}`}…</p>
            </>
          )}
          {state === 'error' && (
            <>
              <XCircle size={28} className="text-red" />
              <p className="font-display text-lg font-semibold text-ink">Couldn’t connect {label}</p>
              <p className="max-w-sm text-sm text-muted">{detail}</p>
              <Button className="mt-2" onClick={() => navigate('/app/settings', { replace: true })}>Back to Settings</Button>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
