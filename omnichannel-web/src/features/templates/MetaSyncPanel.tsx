/**
 * `POST /v1/templates/sync`, rendered for a person — and gated behind its own
 * dry run.
 *
 * Sync is the one templates call that writes to rows the user did not ask about:
 * it takes Meta's status over the local one AND creates local rows for templates
 * that exist only in the WABA. So this panel never syncs-then-reports. It shows
 * the plan the server produced with `dryRun: true`, and "Apply" is a second,
 * deliberate call with `dryRun: false`.
 *
 * Two things the report must not be allowed to swallow:
 *
 * 1. `skippedImports` — templates the WABA holds that Green Start would not
 *    import, each with the server's reason. They are the account's real
 *    templates and Green Start cannot send them; dropping them silently would
 *    leave the list quietly misrepresenting the account.
 * 2. `listingComplete: false` — Meta's listing was truncated at the client's
 *    page cap, so the remote set is partial. On such a run the server does not
 *    populate `missingAtMeta` at all (absence proves nothing), which would
 *    otherwise read as "nothing is missing". It is said out loud instead.
 *
 * `missingAtMeta` and `neverSubmitted` are also kept apart on purpose: the first
 * is a row Meta once acknowledged and now does not list — a change at Meta worth
 * looking at — and the second is a row that was simply never pushed, which is
 * normal and needs no alarm.
 */
import type { ReactNode } from 'react';
import {
  AlertTriangle, ArrowRightLeft, Ban, CheckCircle2, CirclePlus, CloudDownload,
  FileWarning, Info, ListChecks, RefreshCw, X, type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { apiErrorDetailLines, apiErrorMessage } from './metaErrorDetails';
import type { TemplateSyncReport } from '@/services/templates/templates.types';

type Tone = 'neutral' | 'green' | 'blue' | 'orange' | 'red' | 'violet';
const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted', green: 'text-green', blue: 'text-blue',
  orange: 'text-orange', red: 'text-red', violet: 'text-violet',
};

export function MetaSyncPanel({
  plan, applied, planning, applying, error, applyError, onReplan, onApply, onClose,
}: {
  plan?: TemplateSyncReport;
  applied?: TemplateSyncReport;
  planning: boolean;
  applying: boolean;
  error: Error | null;
  applyError: Error | null;
  onReplan: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  // Once a write run has returned, ITS report is the truth about what happened;
  // the plan it was based on is history and is no longer shown.
  const report = applied ?? plan;
  const busy = planning || applying;

  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <CloudDownload size={15} className="text-accent" />
            Sync from Meta
            {applied
              ? <Badge tone="green">Applied</Badge>
              : plan ? <Badge tone="blue">Preview — nothing changed yet</Badge> : null}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Reads the WhatsApp Business Account’s templates and reconciles them against this workspace’s rows.
            Matched rows take Meta’s status; templates that exist only at Meta are imported. Nothing is ever deleted.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onReplan} loading={planning} disabled={applying}>
            <RefreshCw size={14} /> {applied ? 'Preview again' : 'Re-check'}
          </Button>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>
      </div>

      {planning ? <LoadingState label="Asking Meta what this WhatsApp Business Account holds…" />
        : applying ? <LoadingState label="Applying the sync…" />
        : error ? <ErrorState message={failureText(error, 'The sync preview could not be completed.')} onRetry={onReplan} />
        : !report ? <ErrorState message="The server returned no report for this sync." onRetry={onReplan} />
        : (
          <>
            {/* A failed WRITE run after a successful preview: the preview is
                still on screen, so the failure is shown beside it rather than
                replacing it — otherwise the plan the user was reading vanishes. */}
            {applyError && (
              <div className="mx-5 mt-5 rounded-card border border-red/20 bg-red/10 px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-medium text-red">
                  <AlertTriangle size={15} /> The sync was not applied. Nothing was changed.
                </p>
                <p className="mt-1 text-sm text-ink">{apiErrorMessage(applyError, 'The server refused the sync.')}</p>
                {apiErrorDetailLines(applyError).map((line) => (
                  <p key={line} className="mt-1 text-sm text-ink">{line}</p>
                ))}
              </div>
            )}
            <ReportBody report={report} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
              <p className="text-xs text-muted">
                {report.dryRun
                  ? 'This was a preview. No template row has been written.'
                  : 'These changes have been written to this workspace’s templates.'}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="secondary" size="sm" onClick={onClose}>{report.dryRun ? 'Cancel' : 'Close'}</Button>
                {report.dryRun && (
                  <Button size="sm" onClick={onApply} loading={applying} disabled={busy || !hasChanges(report)}>
                    {hasChanges(report) ? 'Apply sync' : 'Nothing to apply'}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
    </Card>
  );
}

function ReportBody({ report }: { report: TemplateSyncReport }) {
  const truncated = !report.listingComplete;

  return (
    <div className="space-y-5 p-5">
      {/* The headline sentence: what will change, or what did. */}
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          {report.dryRun
            ? <Info size={18} className="text-blue" />
            : <CheckCircle2 size={18} className="text-green" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{summarise(report)}</p>
          <p className="mt-1 text-sm text-muted">
            Meta listed {report.remoteCount} {report.remoteCount === 1 ? 'template' : 'templates'} in WhatsApp Business Account{' '}
            <span className="font-mono text-xs">{report.wabaId}</span>
            {truncated ? ' before the listing was cut short.' : '.'}
          </p>
        </div>
      </div>

      {/* Truncation is the finding that invalidates part of this report, so it
          is stated before the sections it invalidates — not in a footnote. */}
      {truncated && (
        <div className="flex gap-2 rounded-card border border-orange/20 bg-orange/10 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Meta’s listing was truncated — this report is partial.</p>
            <p className="mt-1 text-sm text-ink">
              The listing hit the page cap before Meta ran out of templates, so the {report.remoteCount} above is not the
              whole account. Anything absent from it may simply be on a page that was never read: “missing at Meta” cannot
              be determined on this run and is not reported below. Updates and imports for the templates that WERE listed
              are still accurate.
            </p>
          </div>
        </div>
      )}

      {!report.tokenScopes.checked && (
        <p className="rounded-card border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          Meta did not confirm this token’s permissions
          {report.tokenScopes.detail ? ` — ${report.tokenScopes.detail}` : '.'}{' '}
          The listing above is Meta’s own answer, so the sync itself was not blocked.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          icon={ArrowRightLeft} tone="blue" count={report.updated.length}
          title={report.dryRun ? 'Will take Meta’s status' : 'Took Meta’s status'}
          note="Matched to a template at Meta. The local status is replaced by Meta’s."
          empty="No local row’s status differs from Meta’s."
        >
          {report.updated.map((u) => (
            <Line key={`${u.id}-${u.language}`} name={u.name} language={u.language}>
              <span className="text-muted">{u.from}</span>
              <span className="text-muted"> → </span>
              <span className="font-medium text-ink">{u.to}</span>
              <span className="text-muted"> · Meta says </span>
              <span className="font-mono text-[11px] text-ink">{u.metaStatus}</span>
              <span className="text-muted"> · matched by {u.matchedBy}</span>
              {u.reason && <span className="block text-muted">Meta’s reason: {u.reason}</span>}
            </Line>
          ))}
        </Section>

        <Section
          icon={CirclePlus} tone="green" count={report.imported.length}
          title={report.dryRun ? 'Will be imported' : 'Imported'}
          note="Exists in the WhatsApp Business Account but not here. Importing is additive — delete the row to undo it."
          empty="Every template at Meta already has a local row."
        >
          {report.imported.map((i) => (
            <Line key={`${i.id}-${i.language}`} name={i.name} language={i.language}>
              <span className="text-muted">Meta status </span>
              <span className="font-mono text-[11px] text-ink">{i.metaStatus}</span>
            </Line>
          ))}
        </Section>

        {/* Deliberately NOT collapsed when empty-adjacent: these are the
            account's templates that Green Start will not hold, and each one is
            shown with the server's own reason. */}
        <Section
          icon={Ban} tone="orange" count={report.skippedImports.length}
          title={report.dryRun ? 'Will NOT be imported' : 'Not imported'}
          note="At Meta, but Green Start cannot store them. They will stay missing from this list until the cause is fixed at Meta."
          empty="Nothing at Meta was refused."
        >
          {report.skippedImports.map((s) => (
            <Line key={`${s.name}-${s.language}`} name={s.name} language={s.language}>
              <span className="text-ink">{s.reason}</span>
            </Line>
          ))}
        </Section>

        <Section
          icon={FileWarning} tone="red" count={report.missingAtMeta.length}
          title="Missing at Meta"
          note="Meta acknowledged these rows before and no longer lists them. Marked, never deleted — their status is left alone."
          empty={truncated
            ? 'Not determined on this run: the listing was truncated, so a template’s absence from it means nothing.'
            : 'Every row Meta has acknowledged is still listed.'}
          emptyTone={truncated ? 'orange' : 'neutral'}
        >
          {report.missingAtMeta.map((m) => (
            <Line key={`${m.id}-${m.language}`} name={m.name} language={m.language}>
              <span className="text-muted">
                Last status Meta gave: {m.lastKnownMetaStatus
                  ? <span className="font-mono text-[11px] text-ink">{m.lastKnownMetaStatus}</span>
                  : 'not recorded'}
              </span>
            </Line>
          ))}
        </Section>

        <Section
          icon={ListChecks} tone="neutral" count={report.neverSubmitted.length}
          title="Never submitted"
          note="Created here and never pushed to Meta, so Meta has nothing to report. Untouched by this sync — not a problem, just not sent."
          empty="Every local WhatsApp template has been submitted at least once."
        >
          {report.neverSubmitted.map((t) => (
            <Line key={`${t.id}-${t.language}`} name={t.name} language={t.language}>
              <span className="text-muted">Local status </span>
              <span className="text-ink">{t.status.replace('_', ' ')}</span>
            </Line>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ icon: Icon, tone, title, note, count, empty, emptyTone = 'neutral', children }: {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  note: string;
  count: number;
  empty: string;
  emptyTone?: Tone;
  children: ReactNode;
}) {
  return (
    <div className="rounded-card border border-line bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon size={15} className={TONE_TEXT[tone]} /> {title}
          </p>
          <p className="mt-1 text-xs text-muted">{note}</p>
        </div>
        <Badge tone={count > 0 ? tone : 'neutral'}>{count}</Badge>
      </div>
      {count === 0
        ? <p className={`mt-3 text-sm ${emptyTone === 'neutral' ? 'text-muted' : TONE_TEXT[emptyTone]}`}>{empty}</p>
        : <ul className="mt-3 space-y-2">{children}</ul>}
    </div>
  );
}

function Line({ name, language, children }: { name: string; language: string; children: ReactNode }) {
  return (
    <li className="rounded-[10px] border border-line bg-surface px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs text-ink">{name}</span>
        <span className="text-[11px] uppercase tracking-wide text-muted">{language}</span>
      </p>
      <p className="mt-1 text-xs">{children}</p>
    </li>
  );
}

/** Would this plan write anything at all? */
function hasChanges(r: TemplateSyncReport): boolean {
  return r.updated.length > 0 || r.imported.length > 0 || r.missingAtMeta.length > 0;
}

/**
 * "3 will be updated, 2 imported, 1 skipped." Skipped imports are counted in the
 * sentence even though they are not a write — they are the part of the account
 * this sync will not bring across, and the headline is where a person decides
 * whether to keep reading.
 */
function summarise(r: TemplateSyncReport): string {
  const bits: string[] = [];
  if (r.updated.length) bits.push(`${r.updated.length} updated`);
  if (r.imported.length) bits.push(`${r.imported.length} imported`);
  if (r.skippedImports.length) bits.push(`${r.skippedImports.length} skipped`);
  if (r.missingAtMeta.length) bits.push(`${r.missingAtMeta.length} marked missing at Meta`);

  if (bits.length === 0) {
    return r.dryRun
      ? 'Nothing would change — every local WhatsApp template already matches Meta.'
      : 'Nothing changed — every local WhatsApp template already matched Meta.';
  }
  const [first, ...rest] = bits;
  // "3 updated" → "3 will be updated" / "3 were updated", then the rest run on.
  const head = first.replace(' ', r.dryRun ? ' will be ' : ' were ');
  return `${head}${rest.length ? `, ${rest.join(', ')}` : ''}.`;
}

function failureText(err: Error, fallback: string): string {
  const lines = apiErrorDetailLines(err);
  return [apiErrorMessage(err, fallback), ...lines].join(' ');
}
