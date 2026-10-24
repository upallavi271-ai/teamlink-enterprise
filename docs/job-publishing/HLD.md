# Job publishing: high-level design

One job is written once in the ATS. A person who may post it (TL, BDE, BDE TL, Admin, Super Admin) picks the sites on one screen and presses **Publish**. The job goes into a database queue; a separate **worker** process posts it to each site and records what really happened.

## What exists and what was added

| Spec idea | Already in TeamLink (kept, untouched) | Added |
|---|---|---|
| jobs | `Requirement` | nothing |
| publish status per site | `RequirementPosting` (old six sites, by-hand tasks) | `PortalPosting` (new engine truth, 7 states) + a bridge that keeps the old rows honest |
| queue | none (background `setImmediate`) | `PostingQueue` + `src/jobPublish/queue.js` |
| logs | `AuditLog` | `PostingLog` (step by step, screenshots) |
| credentials | Integrations (`Integration.values`, AES-GCM) | `PortalCredential` (same `utils/secrets.js` key) |
| mappings | none | `PortalMapping` (252 seeded rows) |
| internal career page | `careersPublic.js`, Job Portal, `jobConnectors.js` | `InternalCareerAdapter` (reuses them) |
| Naukri / Shine / Foundit | partner-API connectors (wait for keys), by-hand | Playwright adapters (switch OFF by default) |
| LinkedIn | partner API (off), by-hand | structure only, **automation disabled** |

## System context

```mermaid
flowchart LR
  P[Person: TL / BDE / Admin] -->|Publish| API[/api/job-publish/]
  API --> DB[(SQLite: PostingQueue, PortalPosting, PostingLog, PortalCredential, PortalMapping)]
  W[Worker process: npm run posting-worker] -->|claim one entry| DB
  W --> AD[Adapters]
  AD --> BR[Chrome / Edge via playwright-core]
  BR --> NK[Naukri]
  BR --> FD[Foundit]
  BR --> SH[Shine]
  AD --> CP[Career page: no browser]
  AD -. never automated .-> LI[LinkedIn: by-hand task]
  W -->|status, logs, audit, notice| DB
  API -->|status, dashboard| UI[Screens: separate task]
```

## Publish sequence

```mermaid
sequenceDiagram
  participant U as Person
  participant A as API
  participant Q as Queue (DB)
  participant W as Worker
  participant B as Portal (browser)
  U->>A: POST /jobs/:id/publish {portals}
  A->>A: RBAC, job live?, switch ON?, fields complete?, client name hidden?
  A->>Q: enqueue (idempotency key) + PortalPosting = QUEUED
  A-->>U: 202 queue ids (at once)
  W->>Q: atomic claim (1 per portal, global cap)
  W->>W: kill switch? rate limit? credentials? build payload + mappings
  W->>B: sign in (saved session or login)
  W->>B: fill form (DRY RUN stops here)
  W->>Q: mark "Submit pressed" (never retried after this)
  W->>B: Submit, read confirmation, capture id + link
  W->>B: open the listing, verify it shows the job
  W->>Q: SUCCEEDED, PortalPosting = PUBLISHED (id + link + verified)
  W->>A: status, logs, audit, bridge to the old job page row
```

## State machines

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> RUNNING: claim
  RUNNING --> SUCCEEDED
  RUNNING --> QUEUED: retry with backoff / kill / shutdown
  RUNNING --> FAILED: not retryable (wrong password, rejected)
  RUNNING --> DEAD: tries used up
  RUNNING --> NEEDS_HUMAN: CAPTCHA, OTP, unverified, no id
  QUEUED --> CANCELLED
  NEEDS_HUMAN --> QUEUED: Retry (a person checked)
  DEAD --> QUEUED: Retry
  DEAD --> CANCELLED: Discard
```

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> QUEUED: Publish
  QUEUED --> PUBLISHED: id/link captured AND listing verified
  QUEUED --> NEEDS_CHECK: accepted but not verified / CAPTCHA
  QUEUED --> FAILED
  PUBLISHED --> UNPUBLISHED: Unpublish
  PUBLISHED --> EXPIRED: expiry a person set
  EXPIRED --> QUEUED: republish (only if a person chose it)
  UNPUBLISHED --> QUEUED: Publish again
```

## ER diagram

```mermaid
erDiagram
  Requirement ||--o{ PostingQueue : "queued for"
  Requirement ||--o{ PortalPosting : "status per portal"
  Requirement ||--o{ PostingLog : "logged"
  PostingQueue ||--o{ PostingLog : "steps"
  Requirement ||--o{ RequirementPosting : "old six sites (kept)"
  PortalCredential }o--|| PortalMapping : "same portal key"
```

## Ten-line architecture

1. API only queues; it never posts and never starts a browser (except the career page, which needs none).
2. Queue = SQLite table; claim = one atomic `UPDATE ... RETURNING`; no Redis.
3. Worker = separate process, never started by `src/index.js`, refuses the real `dev.db` without `TL_ALLOW_REAL_POSTING=1`.
4. One browser at a time (global cap 1), one per portal; persistent profile per portal outside the repo.
5. Adapters share `BasePortal`; all selectors and URLs are JSON per portal, tunable without code.
6. Safety rules live in `BasePortal`: no CAPTCHA/OTP bypass, no stealth, Submit once, no retry after Submit, DRY RUN.
7. PUBLISHED = id/link captured + listing verified. Otherwise NEEDS_CHECK.
8. Credentials AES-256-GCM via `utils/secrets.js`; never in an answer, log, audit row or screenshot.
9. RBAC server side: post = may post the job; view = own area; credentials/switches/mappings = Admin / Super Admin.
10. Every command is an audit row; every run is a step log; the old by-hand task and job-page rows stay correct.
