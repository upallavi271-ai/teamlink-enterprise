# Job publishing: low-level design

## Files

| Path (backend/) | What |
|---|---|
| `src/jobPublish/db.js` | plain-SQL helpers, feature detection, real-db check |
| `src/jobPublish/constants.js` | portals, states, actions, error codes, defaults |
| `src/jobPublish/settings.js` | kill switches, pause, human hold, limits, worker heartbeat (AppSetting rows) |
| `src/jobPublish/queue.js` | enqueue, atomic claim, backoff, dead letters, stale locks, rate limits, retry / cancel / discard |
| `src/jobPublish/credentials.js` | PortalCredential: encrypt, mask, save, switch, verify request |
| `src/jobPublish/mappings.js` + `defaultMappings.js` | PortalMapping seed, lookups (experience band, salary band, city) |
| `src/jobPublish/jobPayload.js` | the job as a portal gets it (client masked, text from "Write the job posts") |
| `src/jobPublish/portalPosting.js` | PortalPosting store |
| `src/jobPublish/runner.js` | one queue entry to its outcome |
| `src/jobPublish/service.js` | publish / republish / unpublish / update / bulk / status / dashboard |
| `src/jobPublish/legacyBridge.js` | keeps RequirementPosting and the by-hand task right |
| `src/jobPublish/access.js` | RBAC |
| `src/routes/jobPublish.js` | `/api/job-publish` |
| `src/playwright/` | `browser.js` `session.js` `retry.js` `screenshot.js` `logger.js` |
| `src/portals/base/BasePortal.js` | the whole flow + safety rules |
| `src/portals/{naukri,foundit,shine,linkedin,career}/` | adapters |
| `src/portals/selectors/*.json` | page settings (UNVERIFIED for real sites) |
| `src/portals/registry.js` | adapter pattern |
| `src/workers/postingWorker.js` | the worker |
| `scripts/portal-session.js` | the human sign-in step |
| `scripts/job-publish-test.js` | acceptance test |
| `test-fixtures/mock-portal/` | local mock job board + its page settings |

## Database tables (final)

DateTime = epoch milliseconds. Migration `20261013120000_job_publish_queue` (`migration.sql`, `rollback.sql`).

**PostingQueue**: `id` PK; `requirementId` FK Requirement (cascade, null for VERIFY); `portal`; `action` PUBLISH|REPUBLISH|UNPUBLISH|UPDATE|VERIFY; `status` QUEUED|RUNNING|SUCCEEDED|FAILED|NEEDS_HUMAN|DEAD|CANCELLED; `attempts`; `maxAttempts` (3); `nextRunAt`; `scheduledFor`; `lockedBy`; `lockedAt`; `startedAt`; `finishedAt`; `payloadHash`; `idempotencyKey` UNIQUE; `dryRun`; `batchId`; `requestedBy`; `requestedByName`; `errorCode`; `errorMessage`; `retryable`; `resultJson`; `createdBy`; `updatedBy`; `createdAt`; `updatedAt`. Indexes: (status,nextRunAt) (portal,status) (requirementId,portal) (batchId) (createdAt).

**PostingLog**: `id`; `queueId` FK PostingQueue (cascade); `requirementId` FK; `portal`; `step`; `level` INFO|WARN|ERROR; `message` (scrubbed); `screenshotPath` (file in a private folder); `durationMs`; `createdAt`.

**PortalCredential**: `id`; `portal`; `accountLabel` ("default"); `usernameEnc` `passwordEnc` `secretEnc` (`enc:v1:` AES-256-GCM); `status` CONNECTED|FAILED|UNVERIFIED|NEEDS_HUMAN|DISABLED; `lastVerifiedAt`; `lastError`; `enabled` (default 0); `dailyLimit`; `hourlyLimit`; `minGapSeconds`; audit columns. UNIQUE (portal, accountLabel).

**PortalMapping**: `id`; `portal`; `field` employmentType|workMode|experience|salary|location|industry|functionalArea; `atsValue`; `portalValue`; `portalCode`; `sortOrder`; `active`; `origin` default|admin; audit columns. UNIQUE (portal, field, atsValue).

**PortalPosting**: `id`; `requirementId` FK (cascade); `portal`; `status` DRAFT|QUEUED|PUBLISHED|FAILED|NEEDS_CHECK|UNPUBLISHED|EXPIRED; `portalJobId`; `portalUrl`; `publishedAt`; `expiresAt`; `autoRepublish`; `lastError`; `lastQueueId`; `lastAction`; `payloadHash`; `verifiedAt`; audit columns. UNIQUE (requirementId, portal).

Why `PortalPosting` and not new columns on `RequirementPosting`: the old connectors treat every `RequirementPosting` row as theirs (they would re-update or take down an engine post by themselves). The engine keeps its own table and writes the outcome into the old row as `Posted by hand` (a status the old code leaves alone and takes down by hand when the job closes).

## Settings (AppSetting, no table)

`jobpublish.killAll`, `jobpublish.pauseAll`, `jobpublish.portal.<p>.kill`, `.humanHold`, `.limits`, `jobpublish.limits`, `jobpublish.worker.heartbeat`, `jobpublish.selectorsDir`.

## Claim (the one important statement)

```sql
UPDATE PostingQueue SET status='RUNNING', lockedBy=?, lockedAt=?, startedAt=?, attempts=attempts+1 ...
WHERE id = (SELECT id FROM PostingQueue q WHERE status='QUEUED' AND nextRunAt<=? AND portal NOT IN (blocked)
            AND NOT EXISTS (RUNNING on this portal) AND (SELECT COUNT(*) FROM RUNNING) < globalConcurrency
            ORDER BY VERIFY first, UNPUBLISH next, nextRunAt, createdAt LIMIT 1)
  AND status='QUEUED'
RETURNING *
```

SQLite runs one writer at a time, so two workers can never take the same row. Tested with four processes.

## Run outcome table

| Adapter result | Queue | PortalPosting | Other |
|---|---|---|---|
| ok + verified + id/link | SUCCEEDED | PUBLISHED | legacy row `Posted by hand`, audit, notice |
| ok, no id or not verified | NEEDS_HUMAN (never retried) | NEEDS_CHECK | notice "check the site" |
| CAPTCHA / OTP / 2-step / unusual / blocked | NEEDS_HUMAN | NEEDS_CHECK | portal on hold, credential NEEDS_HUMAN, by-hand task kept |
| wrong password | FAILED | FAILED | credential FAILED, automation stops |
| rejected form, selector missing | FAILED | FAILED | |
| timeout / network before Submit | QUEUED with backoff, then DEAD | QUEUED, then FAILED | |
| any failure after Submit | NEEDS_HUMAN | NEEDS_CHECK | |
| kill / pause / shutdown | QUEUED (try not used) | unchanged | |
| DRY RUN | SUCCEEDED (dryRun) | unchanged | screenshot saved |
