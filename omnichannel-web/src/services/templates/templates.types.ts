/**
 * Shapes the templates module's Meta-facing endpoints return.
 *
 * Mirrors `MetaTemplatesService.connectionStatus`, `TemplateSyncReport`,
 * `submit()` and `TokenScopeCheck` in gs-api one-for-one. Nothing here is
 * invented: every field below is one the server actually sends, and the optional
 * ones are optional there too.
 */
import type { Template, TemplateValidationResult } from '@/types';

/**
 * Meta's own answer about a stored token, from `GET /debug_token`.
 *
 * `checked: false` means Meta would not introspect the token — the result is
 * UNKNOWN, not "no permissions". `granted` is empty in that case and must never
 * be read as "Meta granted nothing", and `hasTemplateManagement` / `hasMessaging`
 * are `null` rather than `false` for the same reason.
 */
export interface TemplateTokenScopeCheck {
  checked: boolean;
  granted: string[];
  hasTemplateManagement: boolean | null;
  hasMessaging: boolean | null;
  /** Why the check could not be made, or why Meta considers the token invalid. */
  detail?: string;
}

/** `GET /v1/templates/meta-status`. */
export interface TemplateMetaStatus {
  connected: boolean;
  wabaId?: string;
  phoneNumberId?: string;
  /** `null` = could not be determined. Never render this as a pass. */
  canManageTemplates: boolean | null;
  tokenScopes: TemplateTokenScopeCheck;
  /**
   * The scopes Green Start RECORDED when the connection was made. The direct
   * credentials path stores a hardcoded list rather than what Meta granted, so
   * this is a claim to be compared against `tokenScopes.granted` — never a fact.
   */
  recordedScopes: string[];
  /** The server's plain-English summary of the two lists above. */
  detail: string;
}

// ── POST /v1/templates/sync ───────────────────────────────────────────────────

/**
 * A local row whose status was replaced by META's status. `from` / `to` are the
 * local wire statuses (lowercase); `metaStatus` is Meta's own word for the state,
 * which can be more specific than the local enum (PAUSED, DISABLED, …).
 */
export interface TemplateSyncUpdate {
  id: string;
  name: string;
  language: string;
  from: string;
  to: string;
  metaStatus: string;
  /** How the local row was matched to the remote one (id, name+language, …). */
  matchedBy: string;
  reason?: string;
}

/** A template that existed only in the WABA and was created as a local row. */
export interface TemplateSyncImport {
  /** Meta's template id — NOT a local row id. */
  id: string;
  name: string;
  language: string;
  metaStatus: string;
}

/**
 * A template the WABA holds that Green Start deliberately did NOT import, with
 * the server's own explanation. Never hide these: they are the templates the
 * account has and this product cannot send.
 */
export interface TemplateSyncSkip {
  name: string;
  language: string;
  reason: string;
}

/**
 * A local row Meta previously acknowledged (it has a stored Meta id) and a
 * COMPLETE listing no longer contained. Marked `missingSince`, never deleted.
 * The server only reports these when `listingComplete` is true.
 */
export interface TemplateSyncMissing {
  id: string;
  name: string;
  language: string;
  lastKnownMetaStatus?: string;
}

/** A local row Meta has never seen — created here and not submitted. Untouched. */
export interface TemplateSyncNeverSubmitted {
  id: string;
  name: string;
  language: string;
  /** The local wire status (lowercase). */
  status: string;
}

/**
 * `POST /v1/templates/sync` — mirrors `TemplateSyncReport` in gs-api.
 *
 * `listingComplete: false` means Meta's paginated listing hit the client's page
 * cap, so the set of remote templates is PARTIAL. On such a run `missingAtMeta`
 * is left empty on purpose (absence proves nothing), and it must not be rendered
 * as "nothing is missing".
 */
export interface TemplateSyncReport {
  wabaId: string;
  dryRun: boolean;
  listingComplete: boolean;
  /** How many templates the listing returned — partial when !listingComplete. */
  remoteCount: number;
  updated: TemplateSyncUpdate[];
  imported: TemplateSyncImport[];
  skippedImports: TemplateSyncSkip[];
  missingAtMeta: TemplateSyncMissing[];
  neverSubmitted: TemplateSyncNeverSubmitted[];
  tokenScopes: TemplateTokenScopeCheck;
}

// ── POST /v1/templates/:id/submit ─────────────────────────────────────────────

/**
 * `POST /v1/templates/:id/submit`. `meta.status` is the status META returned
 * (normally PENDING) — `template.status` is that mapped onto the local enum.
 */
export interface TemplateSubmitResult {
  template: Template;
  meta: { templateId: string; status: string; category?: string };
  /** The local WhatsApp policy check the server ran before calling Meta. */
  policy: TemplateValidationResult;
  tokenScopes: TemplateTokenScopeCheck;
}

// ── Meta-side fields on a template row ────────────────────────────────────────

/**
 * Fields the server's `toWire()` adds to every template it returns but which the
 * shared `Template` type does not declare. Declared here rather than widened into
 * `@/types` so the Meta-facing surface stays in one place; read them by narrowing
 * a `Template` to `TemplateWithMeta`.
 *
 * `metaTemplateId` is the one that matters for submission: its presence means
 * Meta has acknowledged this row at least once.
 */
export interface TemplateMetaFields {
  approvalSource?: 'local' | 'meta';
  approvalReason?: string;
  /** Meta's template id. Absent ⇒ Meta has never acknowledged this row. */
  metaTemplateId?: string;
  /** Meta's own status string, verbatim (may have no local equivalent). */
  metaStatus?: string;
  metaCategory?: string;
  metaQualityScore?: string;
  metaSyncedAt?: string;
  /** True when a COMPLETE WABA listing no longer contained this template. */
  missingAtMeta?: boolean;
  missingAtMetaSince?: string;
}

export type TemplateWithMeta = Template & TemplateMetaFields;
