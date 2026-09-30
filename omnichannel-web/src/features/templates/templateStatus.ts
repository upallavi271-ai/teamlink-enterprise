/**
 * What a template's Status badge is allowed to say.
 *
 * For WhatsApp the local `status` column cannot answer the question the user is
 * actually asking ("where does this stand with Meta?"), because the same word
 * means two different things:
 *
 *   • The server creates every WhatsApp template as PENDING, meaning "not yet
 *     registered with Meta" (gs-api templates.service.ts `create`). Meta ALSO
 *     returns PENDING for a template it is reviewing. Same word, opposite facts.
 *   • APPROVED can be a label a person set by hand (`approvalSource: 'local'`,
 *     via PATCH …/status) that Meta never granted.
 *
 * The fact that separates them is `metaTemplateId` — Meta's own id, written by
 * the server ONLY from a real Meta response or a signature-verified webhook
 * (gs-api template-meta.ts `toWire()` → `meta.remote.id`). So:
 *
 *   no metaTemplateId  → "Not submitted", whatever the local column claims.
 *                        A claim of a Meta decision is shown next to it as
 *                        "marked … locally", so it is visible, not hidden.
 *   has metaTemplateId → Meta's OWN word (`metaStatus`, verbatim from Meta),
 *                        never the local column, which a local label can
 *                        overwrite while `meta.remote` stays untouched
 *                        (templates.service.ts `setStatus`).
 *
 * Non-WhatsApp channels have no external approval gate and keep the plain local
 * status badge exactly as before.
 *
 * Pure: no React, so the mapping can be read (and tested) on its own.
 */
import type { Template, TemplateStatus } from '@/types';
import type { TemplateWithMeta } from '@/services/templates/templates.types';

export type StatusTone = 'neutral' | 'green' | 'blue' | 'orange' | 'red' | 'violet';

/** Which icon the badge carries. Resolved to a lucide component by the badge. */
export type StatusGlyph =
  | 'none' | 'not-submitted' | 'review' | 'approved' | 'rejected' | 'paused' | 'blocked' | 'missing' | 'unknown';

export interface TemplateStatusView {
  /** The badge text. */
  label: string;
  tone: StatusTone;
  glyph: StatusGlyph;
  /**
   * Short secondary text shown beside the badge — used when the local column
   * contradicts the badge, or to carry Meta's rejection reason.
   */
  secondary?: string;
  /** True when `secondary` flags a claim the badge does not back (drawn as a warning). */
  secondaryWarn?: boolean;
  /** Longer explanation for the hover title. */
  title: string;
}

/** Local status tones — unchanged from the original badge, used for non-WhatsApp. */
export const LOCAL_STATUS_TONE: Record<TemplateStatus, StatusTone> = {
  draft: 'neutral', pending: 'orange', approved: 'green', rejected: 'red', in_review: 'blue',
};

/** `in_review` → `In review`. Same text the page has always shown. */
export const localStatusLabel = (s: TemplateStatus): string => {
  const t = s.replace('_', ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Meta's status word → the local enum it is stored as. A copy of gs-api
 * `mapMetaStatus` (whatsapp-template.mapper.ts); used only to tell whether the
 * local column still agrees with what Meta said. Unknown words → null.
 */
function localFromMeta(metaStatus: string): TemplateStatus | null {
  switch (metaStatus) {
    case 'APPROVED': return 'approved';
    case 'PENDING': case 'SUBMITTED': case 'PENDING_REVIEW': return 'pending';
    case 'IN_APPEAL': return 'in_review';
    case 'REJECTED': case 'PAUSED': case 'DISABLED': case 'PENDING_DELETION':
    case 'DELETED': case 'LIMIT_EXCEEDED': return 'rejected';
    default: return null;
  }
}

/** Meta's word → what the badge says. Every word gs-api's mapper knows is covered. */
function fromMetaWord(metaStatus: string): Pick<TemplateStatusView, 'label' | 'tone' | 'glyph'> {
  switch (metaStatus) {
    case 'APPROVED':
      return { label: 'Approved by Meta', tone: 'green', glyph: 'approved' };
    case 'PENDING': case 'SUBMITTED': case 'PENDING_REVIEW':
      return { label: 'In review at Meta', tone: 'blue', glyph: 'review' };
    case 'IN_APPEAL':
      return { label: 'In appeal at Meta', tone: 'blue', glyph: 'review' };
    case 'REJECTED':
      return { label: 'Rejected by Meta', tone: 'red', glyph: 'rejected' };
    case 'PAUSED':
      return { label: 'Paused by Meta', tone: 'orange', glyph: 'paused' };
    case 'DISABLED':
      return { label: 'Disabled by Meta', tone: 'red', glyph: 'blocked' };
    case 'LIMIT_EXCEEDED':
      return { label: 'Limit exceeded at Meta', tone: 'red', glyph: 'blocked' };
    case 'PENDING_DELETION':
      return { label: 'Being deleted at Meta', tone: 'red', glyph: 'blocked' };
    case 'DELETED':
      return { label: 'Deleted at Meta', tone: 'red', glyph: 'blocked' };
    default:
      // A word Meta added after this code was written: show it verbatim rather
      // than guess what it means.
      return { label: `Meta: ${metaStatus}`, tone: 'neutral', glyph: 'unknown' };
  }
}

const fmtDate = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
};

/** The presentation of any template's status. */
export function templateStatusView(template: Template): TemplateStatusView {
  const local = template.status;

  if (template.channel !== 'whatsapp') {
    return {
      label: localStatusLabel(local),
      tone: LOCAL_STATUS_TONE[local],
      glyph: 'none',
      title: `Status: ${localStatusLabel(local)}`,
    };
  }

  const t = template as TemplateWithMeta;
  const localNote = t.approvalSource === 'local' && t.approvalReason ? ` Local note: ${t.approvalReason}` : '';

  // ── Meta has never acknowledged this row ────────────────────────────────────
  if (!t.metaTemplateId) {
    // `pending` is how the server stores "created here, not sent" — nothing to add.
    const claimsMetaDecision = local === 'approved' || local === 'rejected' || local === 'in_review';
    const secondary = local === 'pending' ? undefined
      : local === 'draft' ? 'draft'
      : `marked ${localStatusLabel(local).toLowerCase()} locally`;
    return {
      label: 'Not submitted',
      tone: 'neutral',
      glyph: 'not-submitted',
      secondary,
      secondaryWarn: claimsMetaDecision,
      title: claimsMetaDecision
        ? `Meta has never seen this template. Its local status says "${localStatusLabel(local)}", `
          + 'but that label was set inside Green Start — Meta did not decide it. Submit it to Meta to get a real review.'
          + localNote
        : 'Created in Green Start and not yet sent to Meta. Submit it to Meta to start the review.' + localNote,
    };
  }

  // ── Meta knows this row ──────────────────────────────────────────────────────
  const metaWord = (t.metaStatus ?? '').trim().toUpperCase();
  const checked = fmtDate(t.metaSyncedAt);
  const checkedLine = checked ? ` Last heard from Meta: ${checked}.` : '';

  if (t.missingAtMeta) {
    const since = fmtDate(t.missingAtMetaSince);
    return {
      label: 'Missing at Meta',
      tone: 'red',
      glyph: 'missing',
      secondary: metaWord ? `last known: ${fromMetaWord(metaWord).label}` : undefined,
      title: `Meta registered this template (id ${t.metaTemplateId}) but a complete listing of the WhatsApp account `
        + `no longer contains it${since ? ` (first noticed ${since})` : ''}. It may have been deleted at Meta.`
        + (metaWord ? ` Meta's last reported status: ${metaWord}.` : '') + localNote,
    };
  }

  if (!metaWord) {
    return {
      label: 'Registered with Meta',
      tone: 'neutral',
      glyph: 'unknown',
      secondary: 'status unknown',
      title: `Meta has this template (id ${t.metaTemplateId}) but Green Start has no status from Meta for it. `
        + 'Run "Sync from Meta" to fetch it.' + checkedLine + localNote,
    };
  }

  const base = fromMetaWord(metaWord);
  // Meta's reason, only when the approval record came from Meta.
  const metaReason = t.approvalSource === 'meta' ? t.approvalReason : undefined;
  // A local label set on top of Meta's verdict (setStatus leaves meta.remote alone).
  const expectedLocal = localFromMeta(metaWord);
  const localDisagrees = t.approvalSource === 'local' && expectedLocal !== null && expectedLocal !== local;

  let secondary: string | undefined;
  let secondaryWarn = false;
  if (localDisagrees) {
    secondary = `marked ${localStatusLabel(local).toLowerCase()} locally`;
    secondaryWarn = true;
  } else if (metaReason && base.tone !== 'green') {
    secondary = metaReason;
  }

  return {
    ...base,
    secondary,
    secondaryWarn,
    title: `Meta reports ${metaWord} for this template (id ${t.metaTemplateId}).`
      + (metaReason ? ` Meta's reason: ${metaReason}.` : '')
      + (localDisagrees
        ? ` Its local status was set to "${localStatusLabel(local)}" inside Green Start; that label is not Meta's decision.`
        : '')
      + checkedLine + localNote,
  };
}

/**
 * Labels for the status FILTER. The list endpoint filters on the local status
 * column (gs-api templates.service.ts `list`), not on Meta's verdict, so on the
 * WhatsApp tab the options say so — "Approved" there would otherwise also match
 * rows whose badge reads "Not submitted · marked approved locally".
 */
export function statusFilterLabel(s: TemplateStatus, whatsapp: boolean): string {
  if (!whatsapp) return localStatusLabel(s);
  if (s === 'pending') return 'Local: Pending (incl. not submitted)';
  return `Local: ${localStatusLabel(s)}`;
}
