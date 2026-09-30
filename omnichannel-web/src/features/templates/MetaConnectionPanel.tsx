/**
 * The result of `GET /v1/templates/meta-status`, rendered for a person.
 *
 * The one rule this component exists to keep: an UNKNOWN answer must read as
 * unknown. The server returns `canManageTemplates: null` and `tokenScopes.checked:
 * false` when Meta would not introspect the token, and in that state `granted` is
 * an empty array that means "Meta told us nothing" — NOT "Meta granted nothing".
 * Rendering that empty list as a scope comparison would turn "we don't know" into
 * "everything is missing", so the comparison is withheld and the reason is shown
 * instead. Nothing here ever resolves to a pass on absent evidence.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, X, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import type { TemplateMetaStatus } from '@/services/templates/templates.types';

const TEMPLATE_SCOPE = 'whatsapp_business_management';

export function MetaConnectionPanel({ status, pending, error, onRecheck, onClose }: {
  status?: TemplateMetaStatus;
  pending: boolean;
  error: Error | null;
  onRecheck: () => void;
  onClose: () => void;
}) {
  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Meta connection</h2>
          <p className="mt-0.5 text-xs text-muted">
            What Meta says the stored WhatsApp token may do, next to what Green Start recorded when it was connected.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onRecheck} loading={pending}>
            <RefreshCw size={14} /> Re-check
          </Button>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>
      </div>

      {pending ? <LoadingState label="Asking Meta about this token…" />
        : error ? <ErrorState message={error.message || 'The connection check could not be completed.'} onRetry={onRecheck} />
        : !status ? <ErrorState message="The server returned no result for this check." onRetry={onRecheck} />
        : <StatusBody status={status} />}
    </Card>
  );
}

function StatusBody({ status }: { status: TemplateMetaStatus }) {
  const { canManageTemplates, tokenScopes, recordedScopes, detail } = status;

  // Only meaningful when Meta actually answered. When `checked` is false the
  // granted list is empty because nothing was reported, so no comparison is made.
  const grantedSet = new Set(tokenScopes.granted);
  const recordedSet = new Set(recordedScopes);
  const claimedButNotGranted = tokenScopes.checked ? recordedScopes.filter((s) => !grantedSet.has(s)) : [];
  const grantedButNotRecorded = tokenScopes.checked ? tokenScopes.granted.filter((s) => !recordedSet.has(s)) : [];

  return (
    <div className="space-y-5 p-5">
      <Verdict value={canManageTemplates} connected={status.connected} detail={detail} />

      {tokenScopes.detail && (
        <div className="flex gap-2 rounded-card border border-line bg-surface-2 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" />
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">What Meta reported</p>
            <p className="mt-1 text-sm text-ink">{tokenScopes.detail}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <ScopeColumn
          title="Recorded by Green Start"
          note="Stored when the connection was made. A claim, not a fact — this list is hardcoded on connect."
          scopes={recordedScopes}
          empty="No scopes were recorded for this connection."
          toneFor={(s) => (tokenScopes.checked && !grantedSet.has(s) ? 'red' : 'neutral')}
        />
        <ScopeColumn
          title="Granted by Meta"
          note={tokenScopes.checked
            ? 'Read from Meta’s own token introspection. This is the list that decides what works.'
            : 'Meta did not report this token’s scopes, so there is nothing to compare against.'}
          scopes={tokenScopes.checked ? tokenScopes.granted : []}
          empty={tokenScopes.checked
            ? 'Meta listed no scopes for this token.'
            : 'Unknown — not reported.'}
          toneFor={(s) => (s === TEMPLATE_SCOPE ? 'green' : 'blue')}
        />
      </div>

      {!tokenScopes.checked ? (
        <p className="rounded-card border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          The two lists cannot be compared: Meta did not confirm this token’s permissions, so the recorded list is
          neither supported nor contradicted. It is still only a claim.
        </p>
      ) : claimedButNotGranted.length > 0 ? (
        <p className="rounded-card border border-red/20 bg-red/10 px-4 py-3 text-sm text-ink">
          <span className="font-medium text-red">
            {claimedButNotGranted.length === 1 ? '1 recorded scope was not granted' : `${claimedButNotGranted.length} recorded scopes were not granted`}
            :
          </span>{' '}
          {claimedButNotGranted.join(', ')}. Green Start’s record overstates what this token can do.
        </p>
      ) : (
        <p className="rounded-card border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          Every recorded scope was also granted by Meta
          {grantedButNotRecorded.length > 0 ? `; Meta granted ${grantedButNotRecorded.length} more that were not recorded (${grantedButNotRecorded.join(', ')}).` : '.'}
        </p>
      )}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Connection">{status.connected ? 'WhatsApp is connected for this workspace' : 'Not connected'}</Row>
        <Row label="Messaging scope">
          {tokenScopes.hasMessaging === null ? 'Unknown' : tokenScopes.hasMessaging ? 'Granted' : 'Missing'}
        </Row>
        {status.wabaId && <Row label="WhatsApp Business Account"><span className="font-mono text-xs">{status.wabaId}</span></Row>}
        {status.phoneNumberId && <Row label="Phone number id"><span className="font-mono text-xs">{status.phoneNumberId}</span></Row>}
      </dl>
    </div>
  );
}

/**
 * Three outcomes, never two. `null` is its own state with its own wording and
 * its own colour — it is not folded into either yes or no.
 *
 * `detail` is the server's own sentence about the same question, and in the
 * success case it is word-for-word the headline above it ("This token can manage
 * WhatsApp templates."). Printing both then reads as a stutter, so the server's
 * line is shown only when it actually adds something.
 */
function Verdict({ value, connected, detail }: { value: boolean | null; connected: boolean; detail: string }) {
  const view = value === true
    ? { tone: 'green' as const, icon: <CheckCircle2 size={18} className="text-green" />, label: 'Yes',
        headline: 'This token can manage WhatsApp templates.' }
    : value === false
      ? { tone: 'red' as const, icon: <XCircle size={18} className="text-red" />, label: 'No',
          headline: 'This token cannot manage WhatsApp templates.' }
      : { tone: 'orange' as const, icon: <HelpCircle size={18} className="text-orange" />, label: 'Could not determine',
          headline: connected
            ? 'Meta did not confirm this token’s permissions, so whether templates can be managed is unknown.'
            : 'There is no connected WhatsApp token to check, so nothing can be confirmed.' };

  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{view.icon}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">Can this token manage templates?</span>
          <Badge tone={view.tone}>{view.label}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink">{view.headline}</p>
        {detail.trim() && detail.trim() !== view.headline && (
          <p className="mt-1 text-sm text-muted">{detail}</p>
        )}
      </div>
    </div>
  );
}

function ScopeColumn({ title, note, scopes, empty, toneFor }: {
  title: string;
  note: string;
  scopes: string[];
  empty: string;
  toneFor: (scope: string) => 'neutral' | 'green' | 'blue' | 'red';
}) {
  return (
    <div className="rounded-card border border-line bg-surface-2 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {scopes.length === 0
          ? <span className="text-sm text-muted">{empty}</span>
          : scopes.map((s) => <Badge key={s} tone={toneFor(s)}><span className="font-mono text-[11px]">{s}</span></Badge>)}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}
