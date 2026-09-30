# GREEN START — CHANGELOG

Changes made during the sequential phase work. Dates are the working session date.

## 2026-09-15 — Communication Console (direct send)  **(NEW CODE)**

Built the Communication Console end-to-end, reusing the existing campaign send engine (no duplicate send path, no faked delivery). Statically verified in both repos; run-to-verify on the user's machine.

**Backend (`gs-api/src/modules/campaigns`)**
- `dto/campaigns.dto.ts`: added `directSendSchema` / `DirectSendDto` (name, channel, optional templateId, audience `all`|`segment`|`manual`; WhatsApp requires a template).
- `campaigns.service.ts`: added `directSend()` — validates template (exists, channel match, WhatsApp must be `APPROVED`) and segment, creates the fully-configured campaign, then reuses `send()` to enqueue the worker job.
- `campaigns.controller.ts`: added `POST /campaigns/direct-send` (`campaign.send`). Status + delivery log reuse existing `GET /campaigns/:id` and `GET /campaigns/:id/recipients`.

**Frontend (`green-start-web/src`)**
- `features/communication/ConsolePage.tsx`: channel picker, approved-template selector (WhatsApp-gated), composer + live preview, recipients from Segment / All customers / paste-or-CSV, and a send-run modal with progress bar + per-recipient delivery log (polls status + recipients). Loading/empty/error states; `campaign.send` RBAC gating; responsive.
- `services/communication/communication.service.ts`: real API (`direct-send` / `:id` / `:id/recipients`) + full mock simulation (resolves audience against CRM/segment mocks; deterministic provider verdicts) so the console is demo-usable pre-wiring.
- `types/index.ts`: `CampaignRecipient`, `RecipientStatus`, `DirectSendAudience/Input/Result`.
- `app/navigation.ts` (`console` → `real: true`) and `app/router.tsx` (`console: <ConsolePage />`).

**Honesty:** until a live provider is connected, sends use the labelled mock provider (same as campaigns) — never presented as delivered to a real inbox.

## 2026-09-12 — Sequential phase pass (Phases 0–20)

### Phase 0 — Audit
- Code-verified the on-disk project (frontend `green-start-web`, backend `gs-api`) against the docs.
- Result: 6 real FE pages + integrations; 12 BE modules; 22 DB tables/22 models 1:1 with 5 migrations.
- Updated `GREEN_START_REQUIREMENTS_MATRIX.md` with a Phase-0 stamp. No code changed.

### Phase 1 — Frontend verification (static)
- Ran an import/export/route-graph check on `green-start-web/src`: 77 files, 0 unresolved imports, 0 missing exports, route↔nav consistent, single HTTP boundary (`apiClient` only).
- Found the campaigns real-branch/no-backend gap (fixed later in Phase 9). Runtime verification deferred to the user's machine (sandbox blocks npm).

### Phase 2 — Frontend architecture
- Verified architecture against source; corrected `GREEN_START_FRONTEND_ARCHITECTURE.md`: added the Integrations module (service + page + `/app/settings`), corrected types (`index.ts` only, no `domain.ts`), corrected `lib/` list, file count 72→77. No code refactor.

### Phase 3 — Database
- Verified `schema.prisma` ↔ migrations 1:1 (22 tables), tenancy (`workspaceId` + cascade), indexes, uniques, idempotency keys, no plaintext secrets.
- Recorded as-built vs target divergences in `GREEN_START_DATABASE_DESIGN.md` (uuid vs cuid; workspaceId + Org→Workspace hierarchy; no soft-delete; leaner Customer; no custom-field values). No schema change.

### Phase 4 — API contracts
- Verified controllers/DTOs/envelope/validation/guards against source. Documented as-built in `GREEN_START_API_CONTRACT.md`.
- Recorded 2 divergences: `team` uses a different pagination shape than the customer-facing modules; server error codes (`VALIDATION_FAILED`/`UNAUTHENTICATED`) differ from doc/FE names. Neither breaks a current consumer. No code change.

### Phase 5 — Backend foundation
- Verified bootstrap, env (fail-fast), Prisma (pg adapter), guards, health, Swagger, logging redaction, security middleware. Stamped `GREEN_START_BACKEND_ARCHITECTURE.md`. Nothing missing; no code change.

### Phase 9 — Campaigns + message engine  **(NEW CODE)**
- **Schema:** added `Campaign`, `CampaignRecipient`, `Message`, `MessageEvent` + 5 enums; back-relations on `Workspace`. Migration `20260913000000_campaigns`.
- **Module `gs-api/src/modules/campaigns/`:** `campaigns.controller.ts`, `campaigns.service.ts`, `dto/campaigns.dto.ts`, `campaigns.module.ts`, `campaign-send.runner.ts`.
- **Endpoints:** `GET /campaigns`, `GET/POST /campaigns`, `PATCH /:id`, `POST /:id/status|duplicate|audience|send|schedule`, `DELETE /:id`, `GET /:id/recipients`. List shape matches the FE `Campaign` contract exactly.
- **Send engine:** BullMQ `campaign-send` queue; worker (`worker.bootstrap.ts`) runs `runCampaignSend` — resolves audience (all/segment/manual), materializes recipients idempotently, creates messages + message_events, rolls up counters, completes the campaign. Uses the WhatsApp adapter when Meta creds exist, otherwise a clearly-labelled **mock** provider (`provider='mock'`).
- **Wiring:** registered `CampaignsModule` in `app.module.ts`.
- Static-verified: gs-api graph 0 unresolved / 0 missing exports (75 files). Removes the FE↔BE campaigns contract gap.
- Not yet wired: credit debiting on send (Phase 17), delivery/read webhooks → message status (Phase 10, needs creds), campaign builder UI.

### Phase 18 — Security audit (static)
- No secrets in FE source; encrypted tokens never returned to clients; only parameterized SQL (`$queryRaw\`SELECT 1\`` in health); tenant scoping enforced (guard + per-query `workspaceId`); argon2id password hashing with timing-safe dummy verify; webhook HMAC + `timingSafeEqual`; JWT re-reads the user (instant revocation); helmet + CORS(credentials) + throttling; pino log redaction. No high/critical issues found.

### Phases 6, 7, 8, 10–17, 19, 20
- Verified/statused without code changes — see the "PHASES 6–20 consolidated status" table in `GREEN_START_REQUIREMENTS_MATRIX.md`. Runtime-dependent phases (6, 19) and credential-dependent phases (10, 11, 12, 15, 16) are blocked in this environment; several modules (13 Inbox, 14 Analytics endpoints, 15 SEO, 16 Automation/AI, 17 Billing UI) remain to build.

### Standing constraint
This cloud sandbox blocks the npm registry + Prisma engine host, and this session has no shell on the user's computer — so nothing was compiled or run. All new/verified code is **code-complete, run-to-verify on the user's machine**.

## 2026-09-12 — Phase: Team + RBAC Admin UI

### Already present (reused, not rebuilt)
- Backend `team` module: `GET /team/members`, `GET /team/roles`, `POST /team/invites`, `PATCH /team/members/:id/role`, `DELETE /team/members/:id`, `POST /invites/accept`; RBAC guards + 26-permission catalog + 8 system roles; last-owner protection.

### Implemented (backend — extended the existing module, no duplicates)
- `PATCH /team/members/:memberId/status` — activate/deactivate (last-owner guard on suspend).
- `POST /team/roles`, `PATCH /team/roles/:roleId`, `DELETE /team/roles/:roleId` — custom role create/edit(name/desc/permissions)/delete; system roles blocked from edit/delete; in-use roles blocked from delete; permission keys validated against the catalog.
- `GET /team/permissions` — permission catalog (grouped) from `permissions.ts`.
- Realigned `GET /team/members` to `{items,total,page,pageSize}` (was `data+meta`) via a per-module `memberQuerySchema` (page/pageSize/sort/dir + status/roleKey filters) — resolves Phase-4 divergence #1. Removed the now-unused generic-pagination imports from the team module.

### Implemented (frontend — new)
- `features/team/TeamPage.tsx` (Members tab + Roles & Permissions tab, with role editor), `services/team/team.service.ts` (mock+real), `mocks/team.mock.ts` (demo seed + catalog), Team/RBAC types in `types/index.ts`, route wired in `app/router.tsx` (`team` → `TeamPage`).

### Connected
- FE Team service real branch → `team/*` endpoints (list/invite/role/status/remove, roles CRUD, permissions). Actions gated by `useCan('team.manage'|'role.manage')` (UX only; backend authoritative).

### Intentionally not changed
- Auth, workspace guard, permission model, other modules. No redesign of existing pages. Invite flow reuses the existing endpoint (no second user system).

### Bugs found / fixed
- Found: `GET /team/members` returned a shape the frontend `apiClient`/`Paginated<T>` could not consume (`data+meta`, and apiClient drops `meta`). Fixed by realigning to `{items,…}` before the first FE consumer shipped.

### Remaining / blockers
- Run-to-verify on your machine (sandbox blocks npm). Email delivery of invites is demo-mode (token returned) until an email provider is connected. No dedicated per-member detail drawer (list row shows the essentials).

## 2026-09-12 — Phase: Communication / Inbox

### Already present (reused)
- `messages` + `message_events` tables (Phase 9); WhatsApp adapter + webhook ingest (`webhook_events`); `inbox.view`/`inbox.reply` permissions; guard chain; design-system primitives.

### Implemented (backend — new `conversations` module)
- DB: `Conversation` model + `ConversationStatus` enum; added `Message.conversationId` (FK, SetNull) + index; `Workspace.conversations` back-relation. Migration `20260913100000_conversations` (creates table + ALTERs `messages`).
- Endpoints: `GET /conversations` (filter status/channel/agent, search, paginate), `GET /conversations/:id`, `GET /conversations/:id/messages`, `POST /conversations/:id/messages` (reply; real provider when connected, else labelled mock), `PATCH /conversations/:id` (status/assignment), `POST /conversations/:id/read`. Registered in `app.module.ts`.

### Implemented (frontend — new)
- `features/inbox/InboxPage.tsx` (two-pane list + thread, responsive stack, reply composer, close/reopen, unread badges, mark-read on open), `services/inbox/inbox.service.ts` (mock+real), `mocks/inbox.mock.ts` (demo threads), inbox types in `types/index.ts`, route wired (`inbox` → `InboxPage`).

### Connected
- FE inbox service real branch → `conversations/*`. Reply/close/read gated by `inbox.view`/`inbox.reply` (`useCan`); backend authoritative.

### Intentionally not changed
- Auth, guards, other modules. Webhook→conversation ingest is deferred to the WhatsApp go-live phase (needs Meta creds); the schema + endpoints are ready for it.

### Remaining / blockers
- Run-to-verify on your machine. Real inbound population needs WhatsApp webhooks (Phase 10). Assign-agent has an endpoint but no dedicated UI control yet. No realtime push (poll/refetch on action; SSE/WebSocket later).

## 2026-09-12 — Phase: Analytics

### Already present (reused)
- `messages` + `message_events` + `campaigns` (counters) from Phase 9; `analytics.view` permission; `AreaChart`/`Sparkline`; real `GET /dashboard/overview` (unchanged).

### Implemented (backend — new `analytics` module)
- `GET /analytics/communication?from&to&channel` — totals by status, delivered/read/fail rates, per-channel breakdown, failure reasons, daily sent-vs-delivered series — all via Prisma `groupBy` over real `messages`.
- `GET /analytics/campaigns` — per-campaign performance from campaign counters. Registered in `app.module.ts`.

### Implemented (frontend — new)
- `features/analytics/AnalyticsPage.tsx` (KPIs, trend chart, channel breakdown, failure reasons, campaign table, range + channel filters), `services/analytics/analytics.service.ts` (mock+real), `mocks/analytics.mock.ts`, analytics types, route wired (`analytics` → `AnalyticsPage`).

### Connected
- FE analytics service real branch → `analytics/*`, gated by `analytics.view`.

### Intentionally not changed
- `dashboard/overview` (already real/honest) and all other modules. No raw SQL added (used Prisma groupBy + in-range bucketing).

### Remaining / blockers
- Run-to-verify on your machine. Delivered/read rates depend on delivery webhooks (Phase 10, needs Meta creds); until then messages show as `sent` and mock provider marks demo. No CSV export of analytics yet.

## 2026-09-12 — Phase: Settings

### Already present (reused)
- `GET/PATCH /users/me`, `GET /users/me/sessions`; `GET /workspaces/current`, `PATCH /workspaces/:id` (workspace.manage); the full `IntegrationsPage`.

### Implemented (backend)
- `POST /users/me/password` — verifies the current password (argon2id), rejects wrong with 422 `CURRENT_PASSWORD_WRONG`, sets the new hash, and revokes all other refresh sessions.

### Implemented (frontend — new)
- `features/settings/SettingsPage.tsx` — tabbed Settings (Profile · Workspace · Integrations). Profile: name + change password. Workspace: name + timezone (gated by `workspace.manage`). Integrations: existing page embedded.
- `services/settings/settings.service.ts` (mock+real); settings types; `IntegrationsPage` gained an `embedded` prop (hides its own PageHeader when shown as a tab); `/app/settings` route now renders `SettingsPage` (was `IntegrationsPage`).

### Connected
- Profile/password → `users/*`; workspace → `workspaces/*`. Name change updates the auth store so the header reflects it.

### Intentionally not changed
- Email is read-only in the UI (change belongs to an admin/verification flow). No API-keys/webhooks admin yet (separate settings section). IntegrationsPage behavior unchanged apart from the optional header.

### Remaining / blockers
- Run-to-verify on your machine (add `settings` to `VITE_REAL_APIS`). API-keys/webhooks/audit settings sections and avatar upload are future work.

## 2026-09-12 — Phase: Web Forms

### Already present (reused)
- `customers` table + `customer.view`/`customer.edit` permissions; guard chain; the global throttler; `@Public()` decorator; design-system primitives.

### Implemented (backend — new `web-forms` module)
- DB: `WebForm` + `WebFormSubmission` models (+ `WebFormStatus`), `Workspace.webForms` back-relation; migration `20260913200000_web_forms`.
- Authed CRUD: `GET /web-forms`, `GET /:id`, `POST /web-forms`, `PATCH /:id`, `DELETE /:id`, `GET /:id/submissions`.
- **Public:** `POST /public/forms/:slug` (@Public, no workspace header) — validates required fields, dedupes a contact by email/phone, creates/links a `Customer` (source "Web Form", assigned to the form's member), records the submission, increments the count. Registered in `app.module.ts`.

### Implemented (frontend — new)
- `features/crm/webforms/WebFormsPage.tsx` (list + field-builder editor + submissions viewer + copy public URL), `services/webforms/webforms.service.ts` (mock+real), `mocks/webforms.mock.ts`, web-form types, route wired (`forms` → `WebFormsPage`).

### Connected
- FE web-forms service real branch → `web-forms/*`, gated by `customer.view`/`customer.edit`. Public submit is designed for an external site (URL shown/copyable in the UI).

### Intentionally not changed
- CRM customers module (public submit reuses the `customers` table directly). No embeddable JS snippet/iframe generator yet (URL only). No captcha on public submit (throttler-limited).

### Remaining / blockers
- Run-to-verify on your machine. Future: embed snippet/iframe, spam protection (captcha/honeypot), custom field mapping to CRM custom fields.

## 2026-09-12 — Phase: Billing (read-only)

### Already present (reused)
- `Plan`/`Subscription`/`CreditTransaction` models + seed (4 plans + an ACTIVE Professional subscription for the demo org); `billing.view`/`billing.manage` permissions; guard chain.

### Implemented (backend — new `billing` module)
- `GET /billing/overview` (plan + subscription + credit usage: debits since periodStart), `GET /billing/plans`, `GET /billing/transactions` (credit ledger). Org-scoped via `CurrentWorkspace.organizationId`; `billing.view`. Registered in `app.module.ts`. All read-only.

### Implemented (frontend — new)
- `features/billing/BillingPage.tsx` (current-plan card, credit-usage bar, plans grid with current highlighted, transactions table; permission-gated), `services/billing/billing.service.ts` (mock+real), `mocks/billing.mock.ts`, billing types, route wired (`billing` → `BillingPage`).

### Intentionally not changed
- No payment gateway, plan-change, or credit-purchase writes — "Change plan"/"Buy credits" are disabled with an honest note. The credit **debit** path belongs to the send engine (Phase 9 follow-up) and remains unwired.

### Remaining / blockers
- Run-to-verify. Deferred: payment provider (UPI/Razorpay/PayU) for plan changes + top-ups; wiring credit debits into the campaign send path; invoices.

## PHASE — Automations (rule-based workflows) — Sep 12, 2026 — BUILT (code-complete, run-to-verify)

### Already present (reused)
- `automation.manage` permission (owner/admin/manager roles), `automation-run` BullMQ queue name, `Automation` nav item (was a placeholder), the guard chain, and the campaign runner/worker pattern this engine follows.

### Added (schema)
- `Automation` + `AutomationRun` models, enums `AutomationTrigger` / `AutomationStatus` / `AutomationRunStatus`, `Workspace.automations` back-relation. Migration `20260913300000_automations`. Three demo automations added to the seed.

### Implemented (backend — new `automations` module)
- CRUD + status + run-history + test endpoints (`GET/POST/PATCH/DELETE /automations`, `/:id/status`, `/:id/runs`, `/:id/test`), all `automation.manage`, workspace-scoped.
- `AutomationEngine` (exported) — fire-and-forget dispatch onto the `automation-run` queue; wired into `customers.create` (contact_created), `customers.update` (stage_changed, only on real change), and the public web-form submit (form_submitted).
- `automation-run.runner.ts` — worker logic (also used synchronously by the test endpoint): loads active automations for the trigger, evaluates allow-listed conditions in memory, applies actions (add_tag / set_stage / set_status / assign_agent) in a transaction, records every run, updates counters. Never throws.
- `worker.bootstrap.ts` now processes the `automation-run` queue. `queue.constants.ts` gained `AutomationRunJob`.

### Implemented (frontend — new)
- `features/automation/AutomationsPage.tsx` (table + builder modal with trigger/condition/action rows, status toggle, run-history modal, test-against-a-contact modal; permission-gated), `services/automations/automations.service.ts` (mock+real), `mocks/automations.mock.ts`, automation types in `types/index.ts`, route wired (`automation` → `AutomationsPage`).

### Intentionally not changed
- No channel-send action (WhatsApp/SMS/email from an automation) — that requires provider credentials and belongs to the WhatsApp/Meta go-live phase. Triggers are internal-only for the same reason.

### Remaining / blockers
- Run-to-verify (migrate + generate + seed + worker running). Future: scheduled/delay steps, multi-step sequences, and a channel-send action once integrations are live.

## PHASE — Audit Log (read-only viewer) — Sep 12, 2026 — BUILT (code-complete, run-to-verify)

### Already present (reused)
- `AuditLog` model + `audit.view` permission (analyst/admin/owner). Audit rows are already written by auth, team, workspaces and integrations services. The gap was that nothing surfaced them.

### Implemented (backend — new `audit` module)
- `GET /audit` (filter by action/entityType/actor/date-range + summary search, paginated, actor joined) and `GET /audit/actions` (distinct action keys for the filter). Both `audit.view`, workspace-scoped, read-only. Registered in `app.module.ts`.

### Implemented (frontend — new)
- `features/audit/AuditLogPage.tsx` (filter bar: search + action dropdown + From/To date pickers; table with actor avatar, colour-coded action badge, summary; entry-details modal showing entity, IP and metadata JSON; permission-gated), `services/audit/audit.service.ts` (mock+real), `mocks/audit.mock.ts`, audit types, nav item added under Administration, route wired (`audit` → `AuditLogPage`).

### Intentionally not changed
- No new audit writes — existing writers are untouched. Broadening write coverage (customer delete, campaign send, automation events) via a shared audit helper is a documented follow-up.

### Remaining / blockers
- Run-to-verify (add `audit` to `VITE_REAL_APIS`). Future: CSV export of the trail; expanded write coverage; retention policy.

## PHASE — Super Admin (platform operator console) — Sep 12, 2026 — BUILT (code-complete, run-to-verify)

### Already present (reused)
- `SuperAdminOnly` decorator + `SUPER_ADMIN_KEY` enforcement in `JwtGuard` (404 to non-operators), `isSuperAdmin` on User/JWT, a seeded operator (`root@greenstart.app`), and the `Super Admin` nav item (was a placeholder). The decorator existed but had no routes using it — this phase activates it.

### Implemented (backend — new `super-admin` module, routes under `/admin`)
- `GET /admin/stats` (platform counts), `GET /admin/organizations` (search/filter/paginate, +owner/plan/workspace-count), `GET /admin/organizations/:id` (detail + workspaces + subscription), `POST /admin/organizations/:id/status`, `GET /admin/users` (search/filter/paginate), `POST /admin/users/:id/status`. All `@SuperAdminOnly`, cross-tenant (no WorkspaceGuard). Status writes are audited; user suspend revokes sessions; self-suspend blocked. Registered in `app.module.ts`.

### Implemented (frontend — new)
- `features/super-admin/SuperAdminPage.tsx` (Overview / Organizations / Users tabs; suspend-reactivate with confirm dialogs; gated on `user.isSuperAdmin`), `services/superadmin/superadmin.service.ts` (mock+real), `mocks/superAdmin.mock.ts`, super-admin types, route wired (`superadmin` → `SuperAdminPage`).
- Threaded `isSuperAdmin` from the auth response into the FE `User` type + `mapUser`; `MOCK_USER` marked operator so the console is explorable in demo mode.

### Intentionally not changed
- No role/super-admin promotion from the console (dangerous), no org/user deletion, no billing mutations. Status changes only.

### Remaining / blockers
- Run-to-verify (add `super-admin` to `VITE_REAL_APIS`, sign in as the operator). Future: org/workspace impersonation for support, platform-wide audit view, plan overrides.

## PHASE — Audit write-coverage expansion — Sep 12, 2026 — BUILT (code-complete, run-to-verify)

### Added (shared)
- `common/audit/audit-recorder.service.ts` + `audit-recorder.module.ts` (@Global, exported) — a non-throwing `record()` used by feature modules that previously had no auditing. Registered in `app.module.ts`.

### Implemented (audit writes + actor threading)
- Customers: `customer.deleted`, `customer.bulk_deleted` (controller now passes `@CurrentUser`).
- Campaigns: `campaign.sent`, `campaign.scheduled`, `campaign.deleted` (send/schedule/remove now take actorId).
- Automations: `automation.created`, `automation.status_changed`, `automation.deleted`.
- Web Forms: `web_form.deleted`.
- Two demo rows added to `mocks/audit.mock.ts` so the new events show in mock mode.

### Intentionally not changed
- Existing inline audit writers (auth, team, workspaces, integrations) left as-is. New actorId params are optional → no existing caller changed behaviour. No new audit writes on non-destructive create/update of customers/segments/templates (kept the trail high-signal).

### Remaining / blockers
- Run-to-verify. Future: CSV export of the trail; optional coverage for template submit and segment changes if desired.

## PHASE — CSV export (list views) — Sep 12, 2026 — BUILT (code-complete, run-to-verify)

### Added (shared)
- `lib/collectAll.ts` — pages through any list endpoint (≤100/page) to collect all matching rows, bounded by a 10k cap + hard page ceiling.

### Fixed (latent bug)
- `customersService.all()` requested `pageSize=1000` which exceeds the list cap (100) and would 400 in real mode (affected segment preview + export). Now `all(orgId, params?)` pages via `collectAll` and is filter-aware.

### Implemented (frontend)
- Customers export now covers **all matching rows** (search + filters), not just the current page, with a loading state.
- Added Export to Campaigns (`campaign.view`), Audit Log (`audit.view`), Automations (`automation.manage`) — each exports all matching rows via `collectAll` + `downloadCsv`, with loading + empty-disabled states.

### Intentionally not changed
- No backend endpoints added — export reuses the existing list endpoints (workspace-scoped, permission-checked). No raising of pageSize caps.

### Remaining / blockers
- Run-to-verify. Future: server-streamed export for very large datasets; export on Templates/Segments if wanted.

## PHASE — WhatsApp / Meta go-live (credential-free scaffolding) — Sep 12, 2026 — BUILT (activates on credentials)

### Already present (reused)
- OAuth begin/callback with encrypted token storage + state signing (integrations module), real Graph send / HMAC signature verify / webhook parse in the WhatsApp adapter, GET verify handshake + signature-verified idempotent POST ingest (webhooks module).

### Fixed / completed
- `campaign-send.runner.ts`: now **decrypts the stored access token** (`decryptSecret` + `ENCRYPTION_KEY`) instead of the `accessToken = undefined` stub — real WhatsApp sends activate automatically when Meta creds + a CONNECTED integration exist; otherwise a clearly-labelled mock send.
- `whatsapp.adapter.ts` (`exchangeCode`): walks business → owned WABA → phone_numbers to capture `phoneNumberId`/`phoneNumber` into integration metadata (the key the send path and inbound routing need). `parseWebhook` now extracts correlation fields (message id, status, business phone id, sender, contact name, text) and makes status event ids status-specific so each callback is a distinct idempotent row.
- `webhooks.service.ts`: after storing events, enqueues an idempotent `webhook-process` job per new event.

### Added
- `webhooks/webhook-process.runner.ts` + worker `webhook-process` processor: status callbacks → Message/MessageEvent/Campaign/CampaignRecipient updates (idempotent, forward-only, count-once); inbound messages → Conversation + inbound Message (workspace resolved via `Integration.metadata.phoneNumberId`, deduped on providerMessageId).

### Intentionally not changed
- No credentials committed; nothing fakes a connected account. FE Integrations UI already existed and needed no change. Phone-number discovery is best-effort at connect (a `sync`-time refresh of phoneNumberId is a possible follow-up).

### To go live
- Set `META_APP_ID`/`META_APP_SECRET`/`META_REDIRECT_URI`/`META_WEBHOOK_VERIFY_TOKEN`, point Meta's webhook at `POST /api/v1/webhooks/whatsapp`, connect WhatsApp in Settings → Integrations, run the worker.

### Remaining / blockers
- Run-to-verify with real credentials. Follow-ups: sync-time phoneNumberId refresh; template-variable mapping in outbound sends; per-WABA multi-number support.
