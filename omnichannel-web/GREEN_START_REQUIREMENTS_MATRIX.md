# GREEN START — REQUIREMENTS MATRIX

**Maintained per project process.** Updated whenever a feature changes status.
**Last updated:** September 12, 2026 (Phase 0 re-audit) · **Frontend:** `green-start-web` (React+Vite, mock services) · **Backend:** `gs-api` (NestJS, code-complete, not yet run-verified against this frontend).

## Status legend
`PASS` implemented & verified · `PARTIAL` some functionality missing · `MOCK` demo/mock implementation · `MISSING` not implemented · `BROKEN` implemented but not working · `BLOCKED` waiting on external dependency/credential.

## Verification note (applies to every "MOCK" row)
The frontend is **statically verified** (0 unresolved imports, 0 syntax errors, 0 missing exports, 0 non-dependency type errors, on-disk==source). It is **not yet runtime-verified**: this cloud sandbox blocks the npm registry, so `npm install` → `tsc`/`eslint`/`vite build`/headless have **not** run. Those must be run on a normal-network machine before any MOCK row is promoted toward PASS. No row is marked PASS yet for this reason.

---

## PHASE 1 — CORE APPLICATION

| Module | Feature | Expected Behavior | Implementation | Status | Backend | Database | API | Integration | Tests | Remaining Work |
|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard | KPI cards | Show reach/engagement/leads/conversions/campaigns with trend + sparkline | `DashboardPage` + `useDashboard` + `dashboard.service` (mock) | MOCK | MISSING | MISSING | contract only (`GET /dashboard/overview`) | — | none | Build backend endpoint; compute from real events |
| Dashboard | Performance chart / channel health / insights | Render series + channel status + clickable insights | inline SVG `AreaChart`, channel cards, insight nav | MOCK | MISSING | MISSING | contract | — | none | Real analytics source |
| Dashboard | Date range | Filter overview by range | 7/14/30-day selector wired to query | MOCK | MISSING | MISSING | contract | — | none | Backend honors range |
| Communication | Console (channel → template → recipients → compose → send-run → delivery log) | Full direct-send workflow with validation, live progress + per-recipient delivery log | `ConsolePage` + `communication.service` (reuses the campaign send engine) | MOCK | REUSED (campaigns svc + worker) | REUSED (campaigns/recipients/messages) | `POST /campaigns/direct-send`, `GET /campaigns/:id`, `GET /campaigns/:id/recipients` | mock/real via `VITE_REAL_APIS=campaigns`; WhatsApp requires an approved template; mock/real provider send (never faked) | none | Run-to-verify; body text is template-driven (real WhatsApp sends the approved template) |
| CRM · Customers | List: search/filter/sort/paginate | Server-style list with source/stage/status filters | `CustomersPage` + `useCustomers` + `customers.service` (WorkspaceScopedMock) | MOCK | MISSING | MISSING | contract (`/customers`) | — | none | Wire to gs-api customers endpoint |
| CRM · Customers | Create / Edit | Validated drawer form → persists, cache invalidated | `CustomerFormDrawer` + mutations | MOCK | MISSING | MISSING | contract | — | none | Real POST/PATCH |
| CRM · Customers | Delete / Bulk delete | Confirm dialog → removes | mutations + `ConfirmDialog` | MOCK | MISSING | MISSING | contract | — | none | Real DELETE/bulk |
| CRM · Customers | Agent assignment | Assign org member to customer | select in form, `agents.service` | MOCK | MISSING | MISSING | contract (`/agents`) | — | none | Real agents endpoint |
| CRM · Customers | CSV export | Download current view as CSV | `lib/csv` browser download | MOCK | — | — | — | — | none | Server-side export for large sets |
| CRM · Customers | RBAC gating | Hide create/edit/delete/export by permission | `useCan` (mock perms) | MOCK | MISSING | — | — | — | none | Enforce server-side (authoritative) |
| CRM · Fields | Custom field CRUD | Type-aware create/delete, options, colour, required | `CrmFieldsPage` + `crmFields.service` | MOCK | MISSING | MISSING | contract (`/crm-fields`) | — | none | Real endpoint; edit support |
| CRM · Segments | Rule builder + live preview | Build AND/OR rules, live matching count | `SegmentsPage` + `segments.service` + `segmentMatch` | MOCK | MISSING | MISSING | contract (`/segments`,`/segments/preview`) | — | none | Backend runs predicate as SQL |
| CRM · Segments | Create/edit/duplicate/delete | Manage segments | mutations | MOCK | MISSING | MISSING | contract | — | none | Real endpoints |
| Campaigns | List: search/filter/sort/paginate | Filter by channel/status | `CampaignsPage` + `campaigns.service` | MOCK | MISSING | MISSING | contract (`/campaigns`) | — | none | Wire to gs-api |
| Campaigns | Create draft | Name + channel → draft | create modal | MOCK | MISSING | MISSING | contract | — | none | Real POST |
| Campaigns | Pause/Resume/Duplicate/Delete | Status-aware row actions | `setStatus`/`duplicate`/`remove` | MOCK | MISSING | MISSING | contract | — | none | Real state transitions |
| Campaigns | **Builder** (audience→template→variables→schedule→send) | Full campaign creation workflow | — | **MISSING** | MISSING | MISSING | contract | — | none | **Build (Phase 1/2 boundary)** |

**Cross-cutting (Phase 1):** navigation `PASS`(static) · shared UI primitives `MOCK`/complete · loading/empty/error/success states present on all built modules · workspace-scoped state + per-tenant isolation `MOCK` · responsive `MOCK` (needs headless confirm).

---

## PHASE 2 — MESSAGING & MARKETING

| Module | Feature | Expected Behavior | Implementation | Status | Remaining Work |
|---|---|---|---|---|---|
| WhatsApp | Inbox, account config, send, delivery | Conversations + webhook-driven status | placeholder page | MISSING/BLOCKED | Needs backend + Meta creds |
| Templates | Manage templates by channel + validator | List/tabs/preview/create + WhatsApp policy check | `TemplatesPage` + `whatsappTemplateValidator` | MOCK | Real endpoint; edit; provider sync |
| Social | Composer, accounts, schedule, insights | Multi-platform publishing | placeholder | MISSING/BLOCKED | OAuth apps + backend |
| Email | Accounts, templates, send | Email channel workflow | placeholder | MISSING/BLOCKED | SMTP/provider + backend |

---

## PHASE 3 — MANAGEMENT & SECURITY

| Module | Feature | Expected Behavior | Implementation | Status | Remaining Work |
|---|---|---|---|---|---|
| Authentication | Login/logout/session/protected routes | Real JWT session + guard | `LoginPage`+`authStore`+`ProtectedRoute` (mock auth) + gs-api real auth exists | MOCK (fe) / PASS-ish (be, unwired) | Wire frontend to gs-api `/auth/login`+`/auth/me` |
| Users / Team | Member list, invite, role change, remove | Team management | placeholder (gs-api team module exists) | MISSING (fe) | Build UI, wire to gs-api |
| Roles & Permissions | Role CRUD + permission matrix | RBAC admin | `useCan` seam only; gs-api RBAC exists | PARTIAL | Build UI; enforce end-to-end |
| Settings | Profile/integrations/security/api-keys/webhooks/audit | Settings sections | placeholder | MISSING | Build per API contract |

---

## PHASE 4 — INTELLIGENCE & REPORTING

| Module | Feature | Status | Remaining Work |
|---|---|---|---|
| Analytics | Communication/social/campaign analytics from real events | MISSING/BLOCKED | Needs message_events + backend |
| Reports | Exportable reports | MISSING | After analytics |
| SEO / Website Analytics | Real analysis system (not a static score) | MISSING/BLOCKED | Search Console integration + backend |

---

## PHASE 5 — REAL INTEGRATIONS

All `BLOCKED` on external credentials + backend adapters: Meta, WhatsApp Business, Facebook, Instagram, Email provider, Google Analytics, Google Search Console, LinkedIn/X/YouTube, MSG91/JioCX/SmartPing/Sparc, Shopify, payments (UPI/Razorpay/PayU), AI provider, S3 storage. Pattern per integration: OAuth → callback (server token exchange) → encrypted storage → account retrieval → sync → operations → webhooks → health/disconnect/reconnect → tests. Ship UI + clearly-labelled mock adapter until credentialed; never fake success.

---

## Summary counts (this update)
- **MOCK (built, statically verified, mock-backed):** Dashboard, CRM Customers, CRM Fields, CRM Segments, Campaigns (list/CRUD/actions), Templates.
- **MISSING (Phase 1):** Campaign builder (multi-step audience→template→schedule wizard). *(Communication console — built Sep 15, now MOCK/code-complete; reuses the campaign send engine.)*
- **MISSING/BLOCKED:** all of Phase 2–5 (placeholders or not started), except gs-api auth/RBAC/team which exist server-side but are not wired to this frontend.
- **PASS:** none yet — gated on running `npm install` + build + headless on a normal-network machine.

---

## UPDATE — Auth + Customers REAL vertical (Sep 11, 2026)

The first UI→service→API→NestJS→PostgreSQL slice is **implemented in code** (frontend + `gs-api`). It is **statically verified** (0 syntax/import/export errors both repos) but **not runtime-verified here** (sandbox blocks npm/Prisma). Status stays `MOCK→PASS pending` until the user runs it per `gs-api/VERTICAL_AUTH_CUSTOMERS.md`.

| Module | Feature | Implementation | Status | Backend | Database | API | Remaining Work |
|---|---|---|---|---|---|---|---|
| Authentication | Login / session / hydrate | gs-api real auth (argon2+JWT+rotating refresh); `/auth/me` returns `{user,workspaces,permissions}`; frontend wired | MOCK→PASS pending run | PASS (exists) | PASS (identity core) | `POST /auth/login`, `GET /auth/me` | Run + verify; email-verify/reset UI later |
| CRM · Customers | List/search/filter/sort/paginate | gs-api `GET /customers` (tenant-scoped, enum-mapped) → Postgres | MOCK→PASS pending run | **real** | **real** (`customers` table + migration) | `/customers` | Flip `VITE_REAL_APIS=customers`, verify |
| CRM · Customers | Create/Edit/Delete/Bulk | gs-api POST/PATCH/DELETE + `/customers/bulk-delete` | MOCK→PASS pending run | real | real | real | verify persistence + reload |
| CRM · Customers | Agent assignment | gs-api `GET /agents` (workspace members) | MOCK→PASS pending run | real | real | `/agents` | verify |
| CRM · Customers | RBAC gating | `useCan` ← `/auth/me` permissions; `PermissionGuard` server-side (`customer.view/edit/delete`) | MOCK→PASS pending run | real (authoritative) | — | — | verify hidden vs enforced |
| Tenant isolation | Cross-workspace 404 | `WorkspaceGuard` (verified membership) on every customers route | MOCK→PASS pending run | real | real | — | verify Northwind workspace is empty |

**Not in this slice (unchanged):** OAuth/third-party (BLOCKED — needs credentials), all other modules (MOCK/MISSING as above).

---

## UPDATE — Backend architecture + CRM/Dashboard modules (Sep 12, 2026)

Implemented in `gs-api` (statically verified, run-to-verify): the backend the *actual frontend* already calls. Design captured in `gs-api/BACKEND_ARCHITECTURE.md`.

| Module | Endpoint(s) | Backend | Database | Frontend real branch | Status |
|---|---|---|---|---|---|
| CRM · Custom Fields | `GET/POST /crm-fields`, `PATCH/DELETE /crm-fields/:id` | **real** | `custom_fields` (+migration) | exists (`VITE_REAL_APIS=crm-fields`) | MOCK→PASS pending run |
| CRM · Segments | `GET/POST /segments`, `PATCH/DELETE /:id`, `/:id/duplicate`, `POST /segments/preview` | **real** (preview = SQL count over customers) | `segments` (JSONB rules) | exists (`…,segments`) | MOCK→PASS pending run |
| CRM · Tags | model + join (`tags`, `customer_tags`) | **model real**, endpoints pending | tables created | not wired (no FE Tags UI yet) | PARTIAL |
| Dashboard | `GET /dashboard/overview` | **real** (contact-derived KPIs; channels/campaigns honestly empty) | reads `customers` | exists (`…,dashboard`) | MOCK→PASS pending run |

**To connect:** `VITE_REAL_APIS=customers,crm-fields,segments,dashboard` after running gs-api migrate+seed. No frontend component changes — service real branches already match these contracts.

**Layers now real:** UI → service → apiClient → NestJS controller (zod) → guards (JWT/Workspace/Permission) → service → Prisma → Postgres, for auth + all of CRM + dashboard. Integration/webhooks/jobs = designed, BLOCKED on credentials.

---

## UPDATE — WhatsApp/Meta integration layer (Sep 12, 2026)

First third-party integration, built as the reusable adapter pattern. Ships **NOT CONNECTED** (demo) and flips live on Meta credentials — no fake account. Detail in `gs-api/WHATSAPP_INTEGRATION.md`.

| Feature | Endpoint / file | Status |
|---|---|---|
| OAuth authorize + server-side token exchange | `POST /integrations/whatsapp/{connect,callback}` | INTEGRATION_READY (BLOCKED on Meta creds) |
| Encrypted token storage (AES-256-GCM) | `integrations.accessTokenEnc` | PASS (code) |
| Provider adapter (Graph API) + mock | `src/integrations/providers/whatsapp.adapter.ts` | INTEGRATION_READY |
| Webhooks: verify challenge + HMAC signature + idempotent | `GET/POST /webhooks/whatsapp`, `webhook_events` | INTEGRATION_READY |
| Connection status UI (6 states) | `features/settings/IntegrationsPage.tsx` (`/app/settings`) | MOCK→PASS pending run (shows NOT CONNECTED honestly) |
| Connect / test / sync / disconnect / reconnect | `/integrations/:id/{test,sync}`, `DELETE /:id` | INTEGRATION_READY |
| Permission handling | `@RequirePermissions('integration.manage')` + `useCan` | PASS (code) |
| Send + delivery events | via adapter `send` + webhook events | PARTIAL (send path lands with the campaign engine) |

**States distinguished:** CONNECTED · NOT_CONNECTED · SYNCING · ERROR · EXPIRED · DISCONNECTED.
**Blocked on:** your Meta app credentials. Next integrations (Facebook/Instagram, Email, Google) follow the same adapter + `/integrations/:provider` pattern, one at a time.

---

## UPDATE — Templates backend (Sep 12, 2026)

The Campaign → **Template** → Provider link of the product-context flow. Frontend `templates.service` real branch already matches.

| Feature | Endpoint | Backend | Database | Status |
|---|---|---|---|---|
| Templates list (channel/status/category filters, sort, paginate) | `GET /templates` | **real** | `templates` (+migration) | MOCK→PASS pending run |
| Create (server re-runs WhatsApp policy; FAIL → 422) | `POST /templates` | **real** (authoritative validation) | real | MOCK→PASS pending run |
| Update (draft/rejected only) / Delete | `PATCH/DELETE /templates/:id` | **real** | real | MOCK→PASS pending run |

**Connect:** add `templates` to `VITE_REAL_APIS`. **Next:** Campaigns backend + the send engine (Campaign → recipients → WhatsApp adapter → messages/webhooks), which completes Backend → Real Integrations.

---

## PHASE 0 AUDIT — code-verified against on-disk source (Sep 12, 2026)

Inspected the actual files in `C:\Users\user\Documents\Omni channel\{green-start-web, gs-api}` (not docs). Findings **confirm this matrix is accurate**; nothing above changed status. What exists on disk:

**Frontend (`green-start-web/src`)** — real pages wired in `app/router.tsx` via `REAL_PAGES`: `overview` (Dashboard), `customers`, `crm` (Fields), `segments`, `campaigns`, `templates`, plus `/app/settings` → `IntegrationsPage`. Every other `navigation.ts` item renders `PlaceholderPage` (honest). Mock↔real is centralized in `services/config.ts` (`isRealApi(module)` off `VITE_USE_MOCKS` + `VITE_REAL_APIS`); services carry identical mock/real signatures (verified in `customers.service.ts`, `integrations.service.ts`). Auth wired (`authStore`/`ProtectedRoute`/`initApiClient`).

**Backend (`gs-api/src`)** — modules present: `auth` (register/verify/resend/login/refresh/logout/forgot/reset/me), `users` (me + sessions), `workspaces`, `team` (members/roles/invites), `customers` + `agents`, `crm-fields`, `segments` (+preview/duplicate), `dashboard/overview`, `templates`, `integrations` (connect/callback/test/sync/disconnect), `webhooks/:provider` (GET verify + POST), `health`. Global `JwtGuard` + `ThrottlerGuard` + `EnvelopeInterceptor` + `AllExceptionsFilter`; per-controller `WorkspaceGuard`/`PermissionGuard`. `QueueModule` (BullMQ) wired. **No `campaigns` backend module exists** — confirming Campaigns is frontend-MOCK only.

**Database (`gs-api/prisma`)** — `schema.prisma` has 21 models (User, Session, VerificationToken, Organization, Workspace, WorkspaceMember, Role, Permission, RolePermission, AuditLog, Plan, Subscription, CreditTransaction, Customer, CustomField, Tag, CustomerTag, Segment, Integration, WebhookEvent, Template) across 5 migrations (`init`, `customers`, `crm_fields_tags_segments`, `integrations`, `templates`) + `seed.ts`. No campaign/message/conversation/analytics tables yet.

**Standing caveat (unchanged):** this cloud sandbox blocks the npm registry + Prisma engine host, so nothing here has been `npm install`ed, compiled, or run. All backend/DB/CRM/templates rows remain **MOCK→PASS pending run on your machine**. No row is PASS.

**First unfinished phase:** **Phase 1 — Frontend Verification**, which requires running the app (blocked in this sandbox → must run on your machine). The largest pure-code gap that needs no external credentials is the **Campaigns backend + send engine** (controller Phase 9): Campaign → audience(Segments) → Template → recipients → BullMQ → provider(mock) → messages → delivery events → analytics.

---

## PHASE 1 — FRONTEND VERIFICATION (Sep 12, 2026)

**Static verification (run in cloud, no npm needed) — PASS:**
- Import/export/route graph checker over `green-start-web/src`: **77 files, 333 imports, 0 unresolved imports, 0 missing exports** (11 initial flags were heuristic false positives — `export async function apiRequest`, inline `type ToastTone`/`Column` — confirmed present in source).
- **Route ↔ nav consistency: PASS** — `REAL_PAGES` ids (`overview, customers, crm, segments, campaigns, templates`) all exist in `navigation.ts` (26 nav ids); every other nav item falls through to `PlaceholderPage`. No dead routes.
- **Service → backend contract cross-check: PASS with one known gap** — every frontend real-branch endpoint matches an existing `gs-api` controller route (`auth/login`,`auth/me`,`customers*`,`agents`,`crm-fields*`,`segments*`,`segments/preview`,`dashboard/overview`,`templates*`,`integrations*`). **Exception: `campaigns*`** — the frontend `campaigns.service` real branch calls `campaigns`,`campaigns/:id/status`,`campaigns/:id/duplicate`,`campaigns/:id` but **no campaigns controller exists** in gs-api. → **Do NOT add `campaigns` to `VITE_REAL_APIS`** until its backend is built (Phase 9). Campaigns stays MOCK.

**Runtime verification — BLOCKED (must run on your machine):** this cloud sandbox blocks the npm registry, and this session has no shell on your computer, so `npm install` → `tsc`/`eslint`/`vite build` and the in-browser click-through (navigation, forms, modals, filters, sort, pagination, loading/empty/error/success states, responsive) have **not** been executed. These are the only checks that can promote MOCK→PASS. Run, on `green-start-web`:
```
npm install
npm run typecheck      # tsc --noEmit
npm run lint
npm run build
npm run dev            # click through the 6 real pages
```
Report any error output and I'll fix it. Until then no frontend row is PASS; static integrity is confirmed clean.

**Frozen (unchanged, working):** app shell, sidebar, header, navigation model, routing, the 6 real pages, shared UI primitives, mock/real config seam. No redesign performed.

---

## PHASES 6–20 — consolidated status (Sep 12, 2026)

Worked continuously per "complete the rest of the phases." Legend as above.

### Phase 9 — Campaigns & message engine — **BUILT (code-complete, run-to-verify)**
New in `gs-api`: `campaigns` module + the send engine. Removes the one FE↔BE contract gap — the frontend `campaigns.service` real branch now has a matching backend.

| Feature | Endpoint / file | Status |
|---|---|---|
| Campaign list (search/filter/sort/paginate) | `GET /campaigns` → `{items,total,page,pageSize}` | code-complete |
| Create draft / update (draft·scheduled) | `POST /campaigns`, `PATCH /:id` | code-complete |
| Pause / resume / cancel (validated transitions) | `POST /:id/status` | code-complete |
| Duplicate / delete | `POST /:id/duplicate`, `DELETE /:id` | code-complete |
| Set audience (all·segment·manual) | `POST /:id/audience` | code-complete |
| Send (enqueue) / schedule (delayed) | `POST /:id/send`, `POST /:id/schedule` | code-complete |
| Recipients list | `GET /:id/recipients` | code-complete |
| Send engine | `campaign-send.runner.ts` + BullMQ worker: audience → recipients (idempotent) → messages → message_events → counters | code-complete |
| Provider | WhatsApp adapter when Meta creds present; otherwise **labelled mock** (`provider='mock'`) — never a fake "connected account" | code-complete |
| Data model | `campaigns, campaign_recipients, messages, message_events` (+5 enums) + migration `20260913000000_campaigns` | code-complete |

**FE cutover:** add `campaigns` to `VITE_REAL_APIS` (safe now that the backend exists). **Not yet wired:** credit debiting on send (Phase 17 billing), delivery/read webhooks updating message status (needs Meta creds, Phase 10), campaign builder UI (FE).

### Phases 6–8, 10–20 — status

| Phase | Area | Status | Note |
|---|---|---|---|
| 6 | Frontend→Backend connection | **BLOCKED (run on your machine)** | All seams exist; set `VITE_REAL_APIS=customers,crm-fields,segments,dashboard,templates,campaigns`; sandbox can't run it |
| 7 | Authentication | **PASS (code) / run-to-verify** | Real argon2id + JWT + rotating refresh + email-verify/reset; FE wired; verified in Phases 0/5/18 |
| 8 | RBAC | **PASS (code, backend) / admin UI MISSING** | 26-perm catalog, 8 system roles, guards enforce; no Roles/Permissions **admin UI** yet |
| 10 | WhatsApp/Meta | **INTEGRATION_READY / BLOCKED on Meta creds** | OAuth+encrypted tokens+webhooks+adapter built; send path now consumes it (real when creds present) |
| 11 | Social | **MISSING / BLOCKED** | Needs OAuth apps + backend (same adapter pattern) |
| 12 | Email | **MISSING / BLOCKED** | Needs SMTP/provider + backend |
| 13 | Communication / Inbox | **MISSING** | Needs conversations/messages inbox UI + backend (messages table now exists) |
| 14 | Analytics | **PARTIAL** | Dashboard KPIs real (contacts); campaign/message analytics now have a data source (`message_events`) but no analytics endpoints/UI yet |
| 15 | SEO | **MISSING / BLOCKED** | Net-new module; needs Search Console |
| 16 | Automation / AI | **MISSING / BLOCKED** | Workflow engine + AI provider |
| 17 | Billing | **PARTIAL (schema only)** | Plan/Subscription/CreditTransaction models exist; credit debit not wired into send; no billing UI |
| 18 | Security | **PASS (static audit)** | No FE secrets; tokens encrypted+never returned; parameterized SQL only; tenant scoping enforced; argon2id; webhook HMAC+timing-safe; JWT re-reads user; helmet/CORS/throttle; log redaction |
| 19 | Final QA | **BLOCKED (run on your machine)** | Static graphs clean both repos (0 unresolved/0 missing exports); `npm typecheck/lint/build/test` + e2e must run locally |
| 20 | Production readiness | **NOT READY** | Foundation solid; gated on: run+verify, real integrations (creds), remaining modules (13/15/16), billing wiring, monitoring/CI/CD |

### Static verification this pass
- `gs-api/src`: **75 files, 319 imports, 0 unresolved, 0 missing exports** (incl. the new campaigns module).
- `green-start-web/src`: **77 files, 0 unresolved, 0 missing exports**, route↔nav consistent, single HTTP boundary.
- **No row is PASS-verified at runtime** — the standing sandbox limitation (no npm, no shell on your machine) is unchanged.

---

## PHASE — TEAM + RBAC ADMIN UI (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Frontend Team & Roles admin built and wired to the existing `team` backend; missing backend admin operations added to the same module (no duplicate systems). `GET /team/members` aligned to `{items,total,page,pageSize}` (was `data+meta`) — resolves Phase-4 divergence #1.

| Feature | Frontend | Backend | Database | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| Team list (search/filter/sort/paginate) | new `TeamPage` Members tab | `GET /team/members` (realigned) | `workspace_members` | `team.view` | static | code-complete |
| Invite member | invite modal | `POST /team/invites` (existing) | `workspace_invites` | `team.manage` | static | code-complete |
| Change role | inline Select | `PATCH /team/members/:id/role` (existing) | — | `team.manage` | static | code-complete |
| Activate/Deactivate | row action | `PATCH /team/members/:id/status` (**new**) | — | `team.manage` | static | code-complete |
| Remove member | confirm dialog | `DELETE /team/members/:id` (existing) | — | `team.manage` | static | code-complete |
| Roles list + permission counts | Roles tab | `GET /team/roles` (existing, wire-mapped) | `roles`,`role_permissions` | `team.view` | static | code-complete |
| Create role | role editor | `POST /team/roles` (**new**) | — | `role.manage` | static | code-complete |
| Edit role (name/desc/permissions) | role editor | `PATCH /team/roles/:id` (**new**, blocks system) | — | `role.manage` | static | code-complete |
| Delete role | confirm dialog | `DELETE /team/roles/:id` (**new**, blocks system/assigned) | — | `role.manage` | static | code-complete |
| Permissions catalog | grouped checkboxes | `GET /team/permissions` (**new**, from catalog) | (static catalog) | `team.view` | static | code-complete |
| Backend authorization | — | guards + `@RequirePermissions` | — | enforced | static | PASS (code) |
| Frontend permission visibility | `useCan('team.manage'/'role.manage')` | mirrors server | — | UX-only | static | code-complete |

**Guardrails preserved/added:** last-owner protection (role change, remove, deactivate); system roles are read-only + undeletable; a role in use cannot be deleted; self-row cannot be removed/deactivated in the UI; tenant scoping via `WorkspaceGuard` unchanged. **RBAC remains backend-authoritative.**

**Run-to-verify:** add `team` to `VITE_REAL_APIS`, then exercise Members + Roles against gs-api. Static graphs clean (FE 80 files, BE 75 files, 0 unresolved / 0 missing exports).

---

## PHASE — COMMUNICATION / INBOX (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Full inbox module built from scratch on the existing architecture. New DB: `conversations` + `Message.conversationId`. New backend module `conversations`. New FE inbox page (two-pane, responsive) wired to it.

| Feature | Frontend | Backend | Database | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| Conversation list (search/filter/paginate) | `InboxPage` list pane | `GET /conversations` → `{items,…}` | `conversations` (+migration) | `inbox.view` | static | code-complete |
| Open thread + messages | thread pane | `GET /conversations/:id`, `GET /:id/messages` | `messages.conversationId` | `inbox.view` | static | code-complete |
| Reply (agent → contact) | composer (Enter to send) | `POST /:id/messages` (mock provider until WhatsApp live) | `messages` + `message_events` | `inbox.reply` | static | code-complete |
| Close / Reopen | header buttons | `PATCH /:id` (status) | — | `inbox.view` | static | code-complete |
| Assign agent | (API ready; UI later) | `PATCH /:id` (assignedAgentId) | — | `inbox.view` | static | code-complete (BE) |
| Mark read / unread badges | on open | `POST /:id/read` | `unreadCount` | `inbox.view` | static | code-complete |

**Honesty:** replies through a channel with no live credentials are sent via a **labelled mock** (`provider='mock'`, shown as "demo" in the bubble). In **real** mode the inbound side is populated by provider webhooks (Phase 10 wiring); real inbox starts empty rather than showing fake threads. **Run-to-verify:** add `inbox` to `VITE_REAL_APIS`. Static graphs clean (FE 83, BE 79, 0 unresolved / 0 missing exports).

---

## PHASE — ANALYTICS (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Real communication analytics computed from `messages` + `message_events` + `campaigns`. New backend `analytics` module + new FE Analytics page (nav `analytics`, previously a placeholder). No fabricated metrics — empty workspace shows honest zeros.

| Feature | Frontend | Backend | Source | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| Communication totals (sent/delivered/read/failed) + rates | `AnalyticsPage` KPI row | `GET /analytics/communication` | `messages` groupBy status | `analytics.view` | static | code-complete |
| Channel breakdown | table | same | `messages` groupBy channel×status | `analytics.view` | static | code-complete |
| Failure reasons | list | same | `messages` groupBy errorReason (FAILED) | `analytics.view` | static | code-complete |
| Sent-vs-delivered trend | `AreaChart` | same | daily bucket of message rows | `analytics.view` | static | code-complete |
| Campaign performance | table | `GET /analytics/campaigns` | `campaigns` cached counters | `analytics.view` | static | code-complete |
| Date-range + channel filter | selects | range/channel query params | — | — | static | code-complete |

**Depends on data:** numbers populate as campaigns send (Phase 9) and inbox replies flow; delivered/read fill in once WhatsApp delivery webhooks are wired (Phase 10). Dashboard `GET /dashboard/overview` left unchanged (already real/honest). **Run-to-verify:** add `analytics` to `VITE_REAL_APIS`. Static graphs clean (FE 86, BE 83, 0 unresolved / 0 missing exports).

---

## PHASE — SETTINGS (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

`/app/settings` upgraded from Integrations-only to a tabbed Settings page (Profile · Workspace · Integrations), wired to existing backend endpoints. One backend gap filled: password change.

| Feature | Frontend | Backend | Authorization | Verified | Status |
|---|---|---|---|---|---|
| Profile: name update | Settings → Profile | `PATCH /users/me` (existing) | authed (self) | static | code-complete |
| Change password | Settings → Profile | `POST /users/me/password` (**new**, verifies current, 422 on wrong, revokes other sessions) | authed (self) | static | code-complete |
| Workspace: name + timezone | Settings → Workspace | `GET /workspaces/current`, `PATCH /workspaces/:id` (existing) | `workspace.manage` (edit), `workspace.view` (read) | static | code-complete |
| Integrations | Settings → Integrations tab | reuses existing `IntegrationsPage` (now `embedded`) | `integration.manage` | static | code-complete |

**Reused, not rebuilt:** `/users/me`, `/workspaces/*`, the whole Integrations page. Email change intentionally read-only (admin/verification concern). **Run-to-verify:** add `settings` to `VITE_REAL_APIS`. Static graphs clean (FE 88, BE 83, 0 unresolved / 0 missing exports).

---

## PHASE — WEB FORMS (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Public lead-capture forms → CRM. New `web_forms` + `web_form_submissions` tables, a `web-forms` module (authed CRUD + a **public** submit endpoint), and the CRM Web Forms page (nav `forms`, previously a placeholder).

| Feature | Frontend | Backend | Authorization | Verified | Status |
|---|---|---|---|---|---|
| List / search / filter forms | `WebFormsPage` | `GET /web-forms` | `customer.view` | static | code-complete |
| Create / edit form (field builder) | form editor modal | `POST /web-forms`, `PATCH /:id` | `customer.edit` | static | code-complete |
| Enable / disable / delete | row actions | `PATCH /:id` (status), `DELETE /:id` | `customer.edit` | static | code-complete |
| View submissions | submissions modal | `GET /:id/submissions` | `customer.view` | static | code-complete |
| Public URL (copy) | Link button → `/api/v1/public/forms/:slug` | — | — | static | code-complete |
| **Public submit → CRM contact** | (external site posts) | `POST /public/forms/:slug` (**@Public**, required-field validation, dedupe by email/phone, creates/links `Customer`, source="Web Form", assigns to form's member) | none (rate-limited) | static | code-complete |

**Security:** public submit is the only unauthenticated write — it resolves the form by a globally-unique `publicSlug`, validates required fields, and is covered by the global throttler. Deleting a form removes its submissions but **keeps** captured CRM contacts. **Run-to-verify:** add `web-forms` to `VITE_REAL_APIS`. Static graphs clean (FE 91, BE 87, 0 unresolved / 0 missing exports).

---

## PHASE — BILLING (read-only) (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Read-only billing over the existing Plan/Subscription/CreditTransaction schema. New `billing` module + Billing page (nav `billing`, previously a placeholder). **No payment gateway** — plan change / credit purchase are deferred (never fake a payment).

| Feature | Frontend | Backend | Source | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| Plan + subscription status | Billing page cards | `GET /billing/overview` | `subscriptions`+`plans` | `billing.view` | static | code-complete |
| Credit usage (used/included/balance) | usage bar | overview (debits since periodStart) | `credit_transactions` | `billing.view` | static | code-complete |
| Plans comparison | plan grid | `GET /billing/plans` | `plans` | `billing.view` | static | code-complete |
| Credit ledger | transactions table | `GET /billing/transactions` | `credit_transactions` | `billing.view` | static | code-complete |
| Change plan / Buy credits | disabled buttons ("payment setup not available yet") | — (no gateway) | — | — | static | DEFERRED (honest) |

**Scoping:** billing is **organization-scoped** (resolved via `CurrentWorkspace.organizationId`), not workspace-scoped. Permission-denied users see an honest empty state. **Run-to-verify:** add `billing` to `VITE_REAL_APIS`. Static graphs clean (FE 94, BE 90, 0 unresolved / 0 missing exports).

---

## PHASE — AUTOMATIONS (rule-based workflows) (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Credential-free automation engine: **trigger → conditions → actions**. Triggers are internal events that already exist in the system; actions operate only on the existing CRM contact, so an automation runs end-to-end with **no third-party connection**. New `automations` module + Automations page (nav `automation`, previously a placeholder). Fires asynchronously through the existing `automation-run` BullMQ queue and worker.

| Feature | Frontend | Backend | Trigger source | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| List / search / filter | Automations table (trigger + status filters) | `GET /automations` | — | `automation.manage` | static | code-complete |
| Create / edit | Builder modal (trigger, AND/OR conditions, actions) | `POST /automations`, `PATCH /automations/:id` | — | `automation.manage` | static | code-complete |
| Activate / pause | Status toggle chip | `POST /automations/:id/status` | — | `automation.manage` | static | code-complete |
| Delete | Confirm dialog | `DELETE /automations/:id` | — | `automation.manage` | static | code-complete |
| Run history | Runs modal (success/skipped/failed + actions applied) | `GET /automations/:id/runs` | `automation_runs` | `automation.manage` | static | code-complete |
| Test (real apply) | Test modal → pick a contact → run now | `POST /automations/:id/test` | synchronous run | `automation.manage` | static | code-complete |
| **Trigger: contact created** | — | `AutomationEngine.dispatch` from `customers.create` | `customers` | — | static | code-complete |
| **Trigger: form submitted** | — | dispatch from public web-form submit | `web_forms` | — (public) | static | code-complete |
| **Trigger: stage changed** | — | dispatch from `customers.update` (only on real change) | `customers` | — | static | code-complete |
| Actions: add tag / set stage / set status / assign agent | action rows in builder | worker runner (transactional, allow-listed) | `tags`,`customers` | — | static | code-complete |

**Vocabulary (single source of truth):** `automation.constants.ts` (BE) mirrored by `types/index.ts` (FE) — triggers `customer_created|form_submitted|stage_changed`; condition fields `source|leadStage|leadStatus` (allow-listed) with operators `equals|not_equals|contains|in`; actions `add_tag|set_stage|set_status|assign_agent`.

**Safety & isolation:** dispatch is **fire-and-forget** and swallows its own errors — an automation can never break the write that triggered it. The worker runner **never throws**: a failing rule is logged as a FAILED run and the next rule still runs. Conditions are evaluated in memory against the allow-list; actions run in a transaction and touch only the triggering contact. Everything is workspace-scoped; `automation.manage` gates every management route. **No channel-send action** — messaging an external provider is a later, credentialed phase and is deliberately omitted.

**Run-to-verify:** `prisma migrate` (migration `20260913300000_automations`) + `prisma generate` + `prisma db seed`; run the worker process; add `automations` (and `customers`, `web-forms` for live triggers) to `VITE_REAL_APIS`. Static graphs clean (FE 97, BE 97, 0 unresolved / 0 missing exports).

---

## PHASE — AUDIT LOG (read-only viewer) (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Surfaces the audit trail that the app **already writes**. Audit rows are produced today by auth (register/login/password-reset), team (role/member/invite changes), workspace (create/update) and integration (connect/disconnect) actions — but nothing read them back. New `audit` module + Audit Log page (nav `audit`, added under Administration). **Read-only** — this phase never writes audit rows.

| Feature | Frontend | Backend | Source | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| Audit trail list | Audit Log table (actor, action, summary, time) | `GET /audit` | `audit_logs` (real, existing) | `audit.view` | static | code-complete |
| Filter by action | action dropdown (populated from data) | `GET /audit/actions` (distinct) | `audit_logs` | `audit.view` | static | code-complete |
| Search summary | search box | `GET /audit?search=` | `audit_logs` | `audit.view` | static | code-complete |
| Date range | From / To date pickers | `GET /audit?from=&to=` (gte / lt) | `audit_logs` | `audit.view` | static | code-complete |
| Entry details | details modal (entity, IP, metadata JSON) | included in list payload | `audit_logs` + actor join | `audit.view` | static | code-complete |

**Scoping & safety:** strictly workspace-scoped (`workspaceId = current`), `audit.view` on every route, actor joined for display. No fabricated data — the mock branch shows samples only for the demo workspace; real mode reads genuine rows. **No new audit writes** in this phase (existing writers unchanged).

**Documented follow-up:** broaden write coverage to more business actions (customer delete, campaign send, automation create/delete) via a shared audit helper — deferred to keep this phase focused and the working services untouched.

**Run-to-verify:** add `audit` to `VITE_REAL_APIS`. Static graphs clean (FE 100, BE 101, 0 unresolved / 0 missing exports).

---

## PHASE — SUPER ADMIN (platform operator console) (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Activates the `@SuperAdminOnly` seam that existed but was unused. A **cross-tenant** operator console — the only module that is NOT workspace-scoped. New `super-admin` module (routes under `/admin`) + Super Admin page (nav `superadmin`, previously a placeholder). Guarded in `JwtGuard`, which returns **404** to non-operators so the surface isn't even discoverable.

| Feature | Frontend | Backend | Source | Authorization | Verified | Status |
|---|---|---|---|---|---|---|
| Platform stats | Overview tab (6 metric cards) | `GET /admin/stats` | orgs/workspaces/users/subs counts | `@SuperAdminOnly` | static | code-complete |
| Organizations list | Orgs tab (search + status filter) | `GET /admin/organizations` | `organizations` (+owner, plan, workspace count) | `@SuperAdminOnly` | static | code-complete |
| Organization detail | (payload ready) | `GET /admin/organizations/:id` | org + workspaces + subscription | `@SuperAdminOnly` | static | code-complete |
| Suspend / reactivate org | confirm dialog | `POST /admin/organizations/:id/status` | `organizations` + audit | `@SuperAdminOnly` | static | code-complete |
| Users list | Users tab (search + status filter) | `GET /admin/users` | `users` (+membership count, operator flag) | `@SuperAdminOnly` | static | code-complete |
| Suspend / reactivate user | confirm dialog | `POST /admin/users/:id/status` | `users` + session revoke + audit | `@SuperAdminOnly` | static | code-complete |

**Security & safety:** every route `@SuperAdminOnly` (404 to non-operators). No `X-Workspace-Id` / WorkspaceGuard — cross-tenant by design. Mutations limited to org/account status; **cannot suspend your own account**; suspending a user **revokes their sessions** so access stops immediately (not at token expiry). Both status writes are recorded to the **audit log** (platform-level, no workspace). Frontend gates the page on `user.isSuperAdmin` (now threaded from the auth response through the FE `User` type) with an honest "operators only" state; server enforcement is authoritative.

**Run-to-verify:** add `super-admin` to `VITE_REAL_APIS`; sign in as the seeded operator (`root@greenstart.app`). Static graphs clean (FE 103, BE 105, 0 unresolved / 0 missing exports).

---

## PHASE — AUDIT WRITE-COVERAGE EXPANSION (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Follow-up to the Audit Log viewer: record the high-value business actions that previously produced no audit row, so the trail covers destructive, outbound and governance events — not just auth/team/workspace/integration changes. New shared `AuditRecorderService` (global, **non-throwing**); the actor is threaded from each controller.

| Action recorded | Where | Action key | Actor threaded |
|---|---|---|---|
| Delete contact | customers.remove | `customer.deleted` | ✅ @CurrentUser |
| Bulk-delete contacts | customers.removeMany | `customer.bulk_deleted` (metadata.count) | ✅ |
| Send campaign | campaigns.send | `campaign.sent` | ✅ |
| Schedule campaign | campaigns.schedule | `campaign.scheduled` | ✅ |
| Delete campaign | campaigns.remove | `campaign.deleted` | ✅ |
| Create automation | automations.create | `automation.created` | ✅ |
| Activate/pause automation | automations.setStatus | `automation.status_changed` | ✅ |
| Delete automation | automations.remove | `automation.deleted` | ✅ |
| Delete web form | web-forms.remove | `web_form.deleted` | ✅ |

**Design & safety:** `AuditRecorderService.record()` never throws — a failed audit write is logged and swallowed so it can never break the business operation it records. All new rows are workspace-scoped with the acting user. Existing inline audit writers (auth/team/workspaces/integrations) are **untouched**. All new actorId params are optional, so no existing caller broke. The Audit Log viewer is data-driven, so these actions appear with no UI change (two demo rows added to the mock for demo mode).

**Run-to-verify:** with `audit` + the relevant modules in `VITE_REAL_APIS`, perform any of the above actions and see the entry appear in the Audit Log. Static graphs clean (FE 103, BE 107, 0 unresolved / 0 missing exports).

---

## PHASE — CSV EXPORT (list views) (Sep 12, 2026) — BUILT (code-complete, run-to-verify)

Consistent, full-dataset CSV export across the main list views, reusing the existing `downloadCsv` helper. **Also fixes a latent bug:** `customersService.all()` requested `pageSize=1000`, but the list endpoint caps pageSize at 100 — so in real mode that call (used by segment preview and export) would return a 400. New shared `collectAll()` pages through the endpoint (≤100/page) instead.

| List | Export scope | Gate | Notes |
|---|---|---|---|
| Customers | all matching (search + filters), was current-page-only | `customer.export` | now paged, not `pageSize=1000` |
| Campaigns | all matching | `campaign.view` | name, channel, status, counts, dates |
| Audit Log | all matching (search/action/date filters) | `audit.view` | when, actor, action, summary, entity, IP |
| Automations | all matching | `automation.manage` | trigger, status, conditions, actions, run counts |

**Design:** `lib/collectAll.ts` walks pages (≤100 each) until complete, bounded by a 10k-row cap and a hard page ceiling so a bad `total` can't loop forever; filters/search are whatever the caller bakes into the page fetch, so **the export matches what's on screen**. Each button shows a loading state and is disabled when the list is empty. Fully client-side (browser Blob download) — **no backend changes**.

**Bug fixed:** `customersService.all(orgId, params?)` now pages via `collectAll` and is filter-aware; segment preview (which calls `all()`) no longer risks a 400 in real mode.

**Run-to-verify:** open any of the four lists, apply filters, click Export — the CSV should contain all matching rows. Static graphs clean (FE 104, BE 107, 0 unresolved / 0 missing exports).

---

## PHASE — WHATSAPP / META GO-LIVE (credential-free scaffolding) (Sep 12, 2026) — BUILT (code-complete, activates on credentials)

Completes the WhatsApp Cloud API loop so it goes live the moment Meta credentials + a connected account exist — **without ever faking a connected account**. Most of the loop already existed (OAuth begin/callback with encrypted token storage, real Graph send in the adapter, signature-verified idempotent webhook ingest); this phase closes the two real gaps.

| Piece | State before | Change |
|---|---|---|
| OAuth connect/callback | ✅ real (encrypted tokens, state-signed) | unchanged |
| Real Graph send | adapter ready, but **runner never decrypted the token** → always mock | runner now decrypts the stored token → real send activates when `mode==='real'` AND a CONNECTED integration exists |
| Phone-number discovery | business only | connect now walks business → owned WABA → phone number, storing `phoneNumberId` (needed by send + inbound routing) |
| Webhook verify (GET) | ✅ real (verify-token) | unchanged |
| Webhook ingest (POST) | ✅ signature-verified, idempotent, stored RECEIVED | now **enqueues** each new event for processing |
| Webhook **processing** | ❌ missing (rows sat RECEIVED) | new worker pipeline (below) |

**Webhook processing pipeline (`webhook-process.runner.ts`, worker queue `webhook-process`):**
- **Status callbacks** (sent/delivered/read/failed) → correlate the outbound `Message` by `providerMessageId`, record an idempotent `MessageEvent` (unique `providerEventId`), advance message status **forward-only**, and roll up `Campaign` counters + `CampaignRecipient` status **exactly once** (counter bumps only when the event row is newly inserted).
- **Inbound messages** → resolve the workspace from the receiving business number (`Integration.metadata.phoneNumberId`), find-or-open a `Conversation` for the contact (link the CRM customer by phone), store the inbound `Message`, bump `unreadCount` + preview. Deduped on `providerMessageId`.

**Credential-free & honest:** all new code is dormant until real creds exist — mode stays `mock` without `META_APP_ID/SECRET/REDIRECT_URI`, and the send path falls back to a **labelled mock** (never presented as real). Nothing fabricates a connected account. When creds + a connected account are added, the same code path goes live with no edits.

**To go live (operator):** set `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN` (+ existing `META_GRAPH_VERSION`, `ENCRYPTION_KEY`), point the Meta webhook to `POST /api/v1/webhooks/whatsapp` with that verify token, connect WhatsApp in Settings → Integrations, run the worker. Static graphs clean (FE 104, BE 108, 0 unresolved / 0 missing exports).

---

## PHASE — SOCIAL MEDIA (Phase A: audit) (Sep 15, 2026)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| A | Social audit | ALREADY BUILT (infra) / MISSING (feature) | Integration+OAuth, ProviderAdapter/registry, social-publish queue, social.publish/content.manage perms, `social` nav item, audit recorder, Segments | none (audit only) | code inspection | FB/IG live publishing BLOCKED — CREDENTIALS REQUIRED |

**Findings:** No Social models/module/adapters/page exist. Reusable: `Integration` (one OAuth conn/provider, encrypted tokens), `ProviderAdapter` pattern (`WhatsAppAdapter` is Meta-OAuth-based), reserved `social-publish` queue, `social.publish`+`content.manage` permissions, `social` nav (currently PlaceholderPage), shared audit recorder, Segments (CRM targeting). To build: `SocialAccount`/`SocialPost`/`SocialPostTarget`/`SocialPostMedia`/`SocialPublishAttempt`/`SocialAudience`/`SocialPostMetric` models; `FacebookAdapter`+`InstagramAdapter` (social-publish capability); `social` module + worker processor; FE Social page+composer+service. `Integration.@@unique([workspaceId,provider])` means a `SocialAccount` model is needed for multiple Pages/IG accounts under one Meta connection. All new code credential-free + self-activating (mock until creds), never faking a connected account or a successful publish.

## PHASE — SOCIAL (Phase B: account connection) (Sep 15, 2026) — BUILT (code-complete; live connect BLOCKED — CREDENTIALS REQUIRED)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| B | Social account connection | PARTIAL/MOCK (self-activating) | Integration model, JWT-signed OAuth state, AES-256-GCM token crypto, audit recorder, RBAC, Settings→Integrations location, ProviderAdapter pattern | added `SocialAccount` model+migration, `SocialProviderAdapter` interface, `MetaSocialBase`, Facebook+Instagram adapters, social registry, `social` module (providers/accounts/connect/callback/sync/disconnect), Social Accounts tab in Settings, FE service+mock+panel, types | static graphs clean (BE 117, FE 107, 0 unresolved; 2 BE "abstract class" false-positives) | Live FB/IG connect needs `META_APP_ID/SECRET/REDIRECT_URI` + Pages/IG scopes + app review |

**Design:** WhatsApp messaging integration untouched. Social uses a **separate** `SocialProviderAdapter` capability (publish/list/metrics) sharing the same Meta OAuth mechanics via `MetaSocialBase`. `Integration` holds the umbrella encrypted user token; `SocialAccount` (one row per Page/IG account, unique on workspace+provider+externalId) holds encrypted per-account Page tokens — the multi-account hub. Connect = `integration.manage`; view accounts = `social.publish`. Account connect/disconnect audited. `SOCIAL_PROVIDER_CATALOG` lists FB+IG (available) and LinkedIn/X/YouTube (coming soon, honest — no fake connections). Capabilities per platform (text limits, media rules, link/hashtag/mention/CTA support) exposed for composer validation in later phases.

**Honesty:** mock mode → providers show "Not configured", never a fake connection; connect returns `configured:false` with a clear message; no "Published" ever claimed. Self-activating: same code goes live when Meta creds + accounts are added.

**Run-to-verify (needs creds):** set Meta app creds with Pages/IG publishing scopes, complete OAuth, then Pages/IG accounts populate `SocialAccount` and appear in Settings → Social Accounts. The OAuth **redirect completion handler** (FE route) is finalized at go-live, same status as the existing WhatsApp integration.

## PHASE — SOCIAL (Phase D: post composer) (Sep 15, 2026) — BUILT (code-complete, run-to-verify)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| D | Post composer | PARTIAL (draft compose PASS static; publish later) | design system (Modal/Field/Textarea/Select/Checkbox/Badge/Pagination/states), useListParams, useCan, audit recorder, RBAC, SocialAccount hub + capabilities from Phase B | `SocialPost`/`SocialPostTarget`/`SocialPostMedia` models+migration; `social-validation.ts`; social-posts service/controller/DTO (list/get/create/update/delete/validate); Social page (nav `social`, was placeholder) with composer (name, multi-account select, caption+counter, hashtags, link, media-by-URL, live per-platform validation, preview); FE service+types | static graphs clean (BE 121, FE 109, 0 unresolved) | Live publish/schedule are Phases J/L; live FB/IG needs creds |

**Composer:** internal name, multi-account selection (grouped by platform), caption with most-restrictive character counter, hashtags, link, media (add-by-URL; file upload is Phase F), per-platform preview, and **live validation** driven by each platform's real capabilities (client mirror of the backend `validateForPlatform`; backend is authoritative at publish). Never silently drops unsupported content — every mismatch is shown as ERROR (blocks publish) or WARN. Drafts save regardless of violations. Post creation/deletion audited. Edits allowed only on DRAFT/SCHEDULED. All workspace-scoped; `social.publish` gated. Publish/schedule buttons intentionally deferred to Phases J/L (composer notes this honestly).

## PHASE — SOCIAL (Phase F: media handling & upload) (Sep 15, 2026) — BUILT (code-complete, run-to-verify)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| F | Media upload + validation | PARTIAL (code-complete; run-to-verify) | pre-scaffolded storage env (STORAGE_DRIVER/LOCAL_DIR/S3_*), audit recorder, RBAC, envelope, composer from Phase D | `StorageService` (local driver + S3 seam) + global module; `MEDIA_PUBLIC_URL` env; `POST /social/media` (multipart, type+size validation, audited); `/media` static serving (NestExpress useStaticAssets); FE `apiUpload` multipart helper; `uploadMedia` service; composer file picker (replaces URL-only) + URL fallback | static graphs clean (BE 124, FE 109, 0 unresolved) | S3 driver + real publish need creds |

**Upload:** `POST /social/media` accepts one image (JPG/PNG/GIF/WebP ≤10MB) or video (MP4/MOV ≤200MB), validates MIME + size (rejects clearly, never silently), stores via `StorageService`, and returns a public URL. **Local driver** (default, credential-free) writes under `STORAGE_LOCAL_DIR` and serves at `/media/...`; the **S3 driver** is a declared seam that reports "not configured" rather than faking storage. Public URL uses `MEDIA_PUBLIC_URL` or is derived from the request origin — the same URL the Meta Graph API fetches at publish time. `social.publish` gated, workspace-scoped, uploads audited. Composer now has a real file picker (with a URL fallback for already-hosted media); demo/mock mode surfaces an honest "upload needs the server" message instead of a fake URL.

## PHASE — SOCIAL (Phases G & H: verify media, Save Draft) (Sep 15, 2026)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| G | Verify media handling | PASS (in-environment) | — | none | static clean (BE 124, FE 109, 0 unresolved); storage key = scope/workspaceId/uuid.ext with ext from allow-list only (no path traversal); MIME allow-list + image/video size caps + multer fileSize limit; `social.publish` gated; workspace-scoped; uploads audited; contract `social/media` aligned; mock mode returns honest error, no fake URL | live file write/serve + Graph fetch = run-to-verify |
| H | Save Draft | ALREADY BUILT / VERIFIED | Phase-D post create/update | none | create() sets status DRAFT; edits restricted to DRAFT/SCHEDULED (POST_LOCKED otherwise); composer Save Draft wired to create/update; created/deleted audited; targets+media persist; list/get return status | live persist across refresh = run-to-verify |

## PHASE — SOCIAL (Phases J–M: schedule & publish) (Sep 15, 2026)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| J | Schedule | BUILT (code-complete, run-to-verify) | BullMQ QueueService + reserved `social-publish` queue, campaign schedule pattern, worker bootstrap | `SocialPublishJob`; `schedule()` (strict validate → SCHEDULED + delayed job); `cancel()` (drops queued job, targets→CANCELLED); `POST :id/schedule` + `:id/cancel`; composer datetime + Schedule button; list Cancel action | static clean (BE 125, FE 109, 0 unresolved); future-time enforced; audited | worker must run; live provider needs creds |
| K | Verify scheduling | PASS (in-environment) | — | none | delayed enqueue via `jobId('social',id)` (idempotent); cancel removes job; status transitions DRAFT/SCHEDULED→SCHEDULED, →CANCELLED; permission + workspace scoped | live fire = run-to-verify |
| L | Publish Now | BUILT (code-complete, run-to-verify) | QueueService, FB/IG adapters (Phase B), decrypt util, audit | `social-publish.runner` (per-target publish via adapter, honest status roll-up, idempotent skip of PUBLISHED); `publishNow()` (strict validate, resets FAILED→PENDING, enqueues); worker `social-publish` processor; `POST :id/publish`; composer Publish Now + list Publish action | static clean; **PUBLISHED only on provider accepted:true**; mock/no-token/API-error → target FAILED with real reason | live publish BLOCKED — Meta creds + connected accounts |
| M | Verify publishing | PARTIAL (static PASS; live BLOCKED) | — | none | roll-up PUBLISHED/PARTIALLY_PUBLISHED/FAILED from targets; idempotent (no double-post); no fake success; per-target providerPostId/permalink/error stored | real provider round-trip = BLOCKED (credentials) |

**Publish/schedule flow:** compose → strict per-platform validation (ERRORs block) → PUBLISHING/SCHEDULED → `social-publish` worker → each target published via its FB/IG adapter → target PUBLISHED (with providerPostId+permalink) or FAILED (with the real provider error) → post status rolled up. Idempotent via fixed `jobId('social',<postId>)` and PUBLISHED-target skip. Honesty: a target is PUBLISHED only when the adapter returns accepted:true; mock/unconfigured/errored never reports success. Publish/schedule/cancel all audited. Workspace-scoped, `social.publish` gated.

## PHASE — SOCIAL (Phase N: sector/location audience config) (Sep 15, 2026) — BUILT (code-complete, run-to-verify)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| N | Audience/targeting config | BUILT (code-complete, run-to-verify) | design system, useListParams, audit recorder, RBAC, `SocialPost.audienceId` (Phase D), Segments (for Phase-O link) | `SocialAudience` model+migration+enum `SocialLocationType`; audiences service/controller/DTO (CRUD); `audienceId` added to post create/update+wire; Social page **Audiences tab** + editor (sector dropdown+custom, location type + country/state/city/PIN/radius+center, interests, age/gender/language) + composer audience selector | static clean (BE 128, FE 109, 0 unresolved) | paid targeting API = Phase P + creds |

**Structured targeting stored:** sector/industry (list + custom), interests[], location (country/state/city/postal, or **radius + center place** — not hardcoded, user-entered), age min/max, genders, languages, optional `segmentId` (CRM link wired in Phase O). Reusable across posts (post.audienceId). **Honesty (critical):** the UI states plainly, in multiple places, that organic posts are **not** geo/sector-restricted by the platforms — the audience is saved for **planning** and reused for a **paid promotion** later (Phase P). Green Start never claims an organic post was geographically restricted. All workspace-scoped, `social.publish` gated, create/delete audited; deleting an audience detaches it from posts (keeps their content).

## PHASE — SOCIAL (Phase O: connect audience to CRM Segments) (Sep 15, 2026) — BUILT (code-complete, run-to-verify)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| O | Audience ↔ CRM Segment link | BUILT (code-complete, run-to-verify) | **existing Segments module/service (no duplicate segmentation logic)**, `SocialAudience.segmentId` + `assertSegment` (Phase N) | BE: audience wire enriched with `segmentName` (single join in list, lookup in get/create/update); FE: Segment picker in the audience editor (from `segmentsService.list`), `segmentName` type, CRM-segment badge on audience cards | static clean (BE 128, FE 109, 0 unresolved) | none |

**Reuse, not rebuild:** the audience links an **existing** CRM Segment via `segmentId` (validated to the workspace); no new segmentation logic. The UI states the distinction clearly: a **Segment = your own CRM contacts** (usable in campaigns); the **sector/location = an external platform audience** for planning/paid promotion — complementary, not the same. Cards show a green "CRM: <segment>" badge when linked. Workspace-scoped throughout.

## PHASE — SOCIAL (Phase P: paid targeting architecture) (Sep 15, 2026) — BUILT (code-complete; live ads BLOCKED — CREDENTIALS REQUIRED)

| Phase | Feature | Status | Existing Code Reused | Changes Made | Verification | Blocker |
|------|---------|--------|----------------------|--------------|--------------|---------|
| P | Paid social targeting seam | BUILT (code-complete, self-activating) | SocialAudience (Phase N), SocialPost, audit recorder, RBAC, Meta app env | `SocialPromotion` model+migration+enums; `META_AD_ACCOUNT_ID` env; `MetaAdsAdapter` (audience→targeting-spec builder + honest launch seam); promotions service/controller/DTO (CRUD + launch); Social **Promotions tab** + editor; FE service+types | static clean (BE 132, FE 113, 0 unresolved) | live ad launch BLOCKED — Meta ad account + Marketing API + app review |

**Architecture (clearly separate from organic):** a `SocialPromotion` pairs an optional post + a `SocialAudience` + objective + budget (daily/lifetime) + schedule. `MetaAdsAdapter.buildTargeting()` is the real, testable translation of a SocialAudience → a Meta ad targeting spec (geo_locations for radius/city/state/country/postal, interests, age, genders, publisher_platforms) with explicit notes for what needs resolving before launch (geocoding, interest IDs). `launch()` is the seam: without `META_AD_ACCOUNT_ID` it returns `ADS_NOT_CONFIGURED`; wired but not enabled it returns `ADS_NOT_IMPLEMENTED` — it **never** claims an ad ran or was charged, and a promotion stays DRAFT until a real launch succeeds. Launch gated by `integration.manage` (spending); CRUD by `social.publish`. Organic posts are untouched — paid targeting applies only to promotions. Create/delete/launch audited; workspace-scoped.

---

## UPDATE — Communication Console (Sep 15, 2026)

The **Communication Console** (direct send) is implemented in code across both repos and **statically verified** (0 syntax errors; TypeScript transpile clean; cross-file import/type contracts checked). Not yet runtime-verified here (sandbox blocks `npm`/Prisma) — run on your machine to promote MOCK → PASS.

**Reuse-first design — no duplication of the send engine.** A direct send is a first-class campaign: the console creates + configures + queues one campaign and the existing worker + provider adapter deliver it. No second send path; nothing faked.

- **Backend (`gs-api`):** `POST /campaigns/direct-send` (`campaign.send` permission) → `CampaignsService.directSend()` validates the template (exists, channel match, **WhatsApp must be APPROVED**) and segment, creates the campaign with audience (`all` | `segment` | `manual`), then reuses `send()` to enqueue the worker job. New Zod `directSendSchema`. Status/counters read via existing `GET /campaigns/:id`; delivery log via existing `GET /campaigns/:id/recipients`.
- **Frontend (`green-start-web`):** `features/communication/ConsolePage.tsx` — channel picker (whatsapp/sms/email/rcs/voice), approved-template selector (WhatsApp-gated), message composer + live preview, recipients from **Segment / All customers / paste-or-CSV**, and a **send-run modal** with progress bar + per-recipient delivery log (polls status + recipients). `services/communication/communication.service.ts` drives the real API and provides a full mock simulation (resolves audience against CRM/segment mocks; deterministic provider verdicts) so the console is demo-usable before wiring. Wired into `navigation.ts` (`real: true`) and `router.tsx`. New types: `CampaignRecipient`, `DirectSendInput/Result`.
- **Honesty:** until a live provider is connected, sends use the labelled **mock** provider (same as campaigns) — never a fake "delivered to a real inbox". WhatsApp is template-gated exactly as the real Graph API requires.

**Run-to-verify:** set `VITE_REAL_APIS=...,campaigns` on the frontend, ensure the API + worker + Redis are up, open **Communication**, pick a channel/template/audience, Send, and watch the delivery log populate from Postgres.
