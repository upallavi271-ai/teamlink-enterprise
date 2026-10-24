# Job publishing API contract (`/api/job-publish`)

For the screens (a separate task). All routes need a login token (`Authorization: Bearer ...`) and ATS access. A client or candidate login gets 403. Until the migration `20261013120000_job_publish_queue` is applied every route except `/health` answers `503 {code:"NOT_MIGRATED"}`.

Portal keys: `naukri`, `foundit`, `shine`, `linkedin` (manual only), `career` (TeamLink's own page).
Plain-word labels in answers: job, site, queue, "needs a person". Errors are `{ "error": "plain sentence", "code": "OPTIONAL" }`.

## Who may do what

| Call | Allowed |
|---|---|
| publish, republish, unpublish, update, bulk, schedule, queue retry / cancel / discard | TL, BDE, BDE TL, Admin, Super Admin, for a job on their own chain (same rule as Save & Post). Recruiter, Manager, Asst Manager, STL: `403 POSTING_NOT_YOURS` |
| `GET /jobs/:id/status`, `/dashboard`, `/portals` | anyone with the job in their area (Recruiter: read-only status of an assigned job, no logs) |
| `GET /queue`, `/dead-letters`, `/logs`, `/logs/:id/screenshot`, `/mappings` | Admin, Super Admin, Manager, Asst Manager, BDE, BDE TL, TL, STL (their own area). Never a Recruiter |
| credentials, switch, kill switch, pause, limits, resume, `PUT /mappings` | Super Admin and Admin only (Role Catalog: "Job Portal Credentials") |

A site that cannot be automated (LinkedIn, switch OFF, no login saved, last sign-in failed) is **never queued**: the answer says `mode: "by_hand"` and the existing by-hand task is created or kept.

## Commands

### POST `/jobs/:id/publish`
Body: `{ "portals": ["naukri","career"], "dryRun": false, "scheduledFor": "2026-10-14T09:00:00Z", "idempotencyKey": "optional" }` (header `Idempotency-Key` also works). `republish`, `unpublish`, `update` take the same body.

202 (something queued) or 200:
```json
{ "requirementId": "cm...", "action": "PUBLISH", "queued": 1,
  "results": [
    { "portal": "naukri", "name": "Naukri", "ok": true, "queued": true, "mode": "queued", "queueId": "pq...", "reason": "Queued.", "entry": { "id": "pq...", "status": "QUEUED", "attempts": 0, "nextRunAt": "..." } },
    { "portal": "linkedin", "ok": true, "queued": false, "mode": "by_hand", "reason": "LinkedIn forbids automation: post by hand. A by-hand task keeps the job.", "handPath": "/api/requirements/cm.../posting-sites/linkedin/by-hand" } ] }
```
`mode`: `queued` | `by_hand` | `refused` (reason says why: job not open, missing fields, client name in text, kill switch) | `already` (live with the same content) | `nothing` (unpublish of a job that is not live). `dryRun: true` fills the form, saves a screenshot and stops before Submit. `scheduledFor` = post at that time. `career` runs at once (no browser) and the `entry` in the answer is already `SUCCEEDED`.

### POST `/publish-bulk`
`{ "jobIds": ["..."], "portals": ["naukri","shine"], "action": "PUBLISH", "dryRun": false }` (max 100 jobs). 202:
```json
{ "batchId": "bt...", "summary": { "jobs": 3, "queued": 6, "refused": 0 }, "jobs": [ { "requirementId": "...", "ok": true, "queued": 2, "results": [ ... ] } ] }
```
A job outside the caller's area or not postable by them is `{ "ok": false, "reason": "..." }` in its row; the others still go.

### PUT `/jobs/:id/portals/:portal/schedule`
`{ "expiresAt": "2026-11-01T00:00:00Z", "autoRepublish": false }`. Nothing is scheduled unless a person calls this; with `autoRepublish: true` the worker queues a REPUBLISH when the date passes, otherwise it marks EXPIRED and sends a notice.

## Reading

### GET `/jobs/:id/status`
```json
{ "requirementId": "...", "reqCode": "REQ-1025", "title": "...", "live": true, "canPost": true, "canViewLogs": true,
  "portals": [ { "portal": "naukri", "portalName": "Naukri", "status": "PUBLISHED", "statusWords": "Live",
    "portalJobId": "123456", "portalUrl": "https://...", "publishedAt": "...", "verifiedAt": "...", "expiresAt": null, "lastError": null,
    "mode": "auto", "waitingForPerson": false, "canRetry": false,
    "lastQueue": { "id": "pq...", "status": "SUCCEEDED", "attempts": 1, "errorCode": null },
    "byHand": { "path": "/api/requirements/.../posting-sites/naukri/by-hand" },
    "logs": [ { "step": "submit", "level": "INFO", "message": "Submit pressed", "at": "..." } ] } ] }
```
Portal status words: DRAFT "Not posted", QUEUED "Waiting to post", PUBLISHED "Live", FAILED "Failed", NEEDS_CHECK "Please check it on the site", UNPUBLISHED "Taken down", EXPIRED "Expired". `logs` is absent for a Recruiter.

### GET `/queue?status=&portal=&job=&from=&to=&page=&pageSize=`
`{ "total": 12, "page": 1, "pageSize": 25, "rows": [ { "id", "requirementId", "portal", "action", "status", "statusWords", "attempts", "maxAttempts", "nextRunAt", "scheduledFor", "startedAt", "finishedAt", "dryRun", "batchId", "requestedByName", "errorCode", "errorMessage", "result": { "portalJobId", "portalUrl", "verified", "dryRun" } } ] }`. Queue states: QUEUED RUNNING SUCCEEDED FAILED NEEDS_HUMAN DEAD CANCELLED.

### GET `/dead-letters`  same shape, `status=DEAD`.
### GET `/logs?queue=&job=&portal=&level=&from=&to=&page=&pageSize=`
`{ total, page, pageSize, rows: [ { id, queueId, requirementId, portal, step, level, message, hasScreenshot, durationMs, at } ] }`. Never a secret. `GET /logs/:id/screenshot` returns the PNG (password, OTP and CAPTCHA boxes are masked; on a page with a password box every input is masked), or, when the row has `fileKind: "structure"`, the page-structure snapshot as `text/plain` (no typed values, no personal text). Every attempt keeps at least one picture; pictures older than the retention time (default 30 days) are deleted.

### GET `/dashboard`
```json
{ "totals": { "totalJobs": 120, "liveJobs": 80, "published": 31, "pendingQueued": 4, "failed": 2, "needsHuman": 1, "draft": 49 },
  "queue": { "QUEUED": 3, "RUNNING": 1, "SUCCEEDED": 40, "FAILED": 1, "NEEDS_HUMAN": 1, "DEAD": 0, "CANCELLED": 2 },
  "portals": [ { "portal": "naukri", "name": "Naukri", "DRAFT": 0, "QUEUED": 1, "PUBLISHED": 12, "FAILED": 0, "NEEDS_CHECK": 0, "UNPUBLISHED": 3, "EXPIRED": 0 } ],
  "trend": [ { "date": "2026-10-07", "queued": 5, "succeeded": 4, "failed": 0, "needsHuman": 1 } ] }
```
Scoped to the caller's own jobs.

### GET `/portals`
`{ "portals": [ { "portal", "name", "kind": "browser|internal|manual", "manualOnly", "settings": { "ok", "problems", "version", "verified", "from" }, "limits": { "minGapSeconds", "maxGapSeconds", "perHour", "perDay" }, "credential": { ... } } ], "worker": { "running": true, "lastSeenAt": "..." }, "killAll": false, "paused": false, "canAdmin": true }`. A non-admin sees only `credential.status` and `credential.enabled`.

### GET `/health`
`{ "ok": true, "migrated": true, "worker": { "running": false }, "queue": { ... }, "killAll": false, "paused": false, "hint": "The worker is not running. Start it with: npm run posting-worker" }`

## Queue commands
`POST /queue/:id/retry` (FAILED, DEAD, NEEDS_HUMAN, CANCELLED back to QUEUED with fresh tries), `/cancel` (QUEUED or NEEDS_HUMAN), `/discard` (dead letters and failed ones; the row stays for the history). Answer `{ "ok": true, "entry": { ... } }`; 409 when the state does not allow it. Retrying a NEEDS_HUMAN entry whose code is UNVERIFIED / NO_JOB_ID: check the site first (the job may be live).

## Admin
- `GET /credentials` `{ credentials: [ { portal, name, kind, manualOnly, hasLogin, usernameMasked: "re••••@mock.test", hasPassword, status, statusWords, enabled, lastVerifiedAt, lastError, dailyLimit, hourlyLimit, minGapSeconds, killed, paused, humanHold, secretsConfigured } ] }`. **No secret is ever returned.**
- `PUT /credentials/:portal` `{ "username": "...", "password": "...", "enabled": false, "dailyLimit": 20, "hourlyLimit": 5, "minGapSeconds": 40 }`. A blank field keeps the stored value, `"-"` clears it. A changed login resets the status to "not checked". LinkedIn answers 400 (manual only).
- `POST /credentials/:portal/verify` queues a sign-in-only check for the worker (nothing is posted): 202 `{ queued, entry, worker }`.
- `POST /credentials/:portal/switch` `{ "enabled": true }` (needs a saved login that did not fail). `DELETE /credentials/:portal` removes the login and switches the portal off.
- `PUT /switches` `{ "killAll": true, "reason": "..." }` / `{ "pauseAll": true }` / `{ "portal": "naukri", "kill": true, "reason": "..." }`.
- `PUT /portals/:portal/limits` (`all` for every portal) `{ minGapSeconds, maxGapSeconds, perHour, perDay, maxAttempts, globalConcurrency }`.
- `POST /portals/:portal/resume` clears "needs a person" after a human signed in.
- `GET /mappings?portal=&field=` / `PUT /mappings` `{ "rows": [ { "portal": "naukri", "field": "location", "atsValue": "Hyderabad", "portalValue": "Hyderabad / Secunderabad", "portalCode": "HYD", "active": true } ] }` (`"delete": true` removes a row).

## Rate limit
40 commands a minute per login: `429 { code: "RATE_LIMIT" }`.

## Needs your help, OTP, diagnostics (2026-10-14)

### The queue entry's `waiting` and `help`
A queue entry (in `GET /queue`, `GET /jobs/:id/status` as `lastQueue`) may carry:
- `waiting: { kind: "OTP", reason, since, until }` while the run is RUNNING with its browser open, waiting for a person to type the one-time code. Never carries the hand-over port.
- `help: { kind, title, how, command }` when the run ended NEEDS_HUMAN for a check TeamLink must not do itself (CAPTCHA, 2-step, unusual activity, e-mail check, block page, OTP not typed in time, real posting off, page settings unverified). `command` is e.g. `npm run portal-session -- naukri`.
- `screenshots` (number of pictures kept) and `selectorDrift` (steps that only worked through a fallback).

### POST `/queue/:id/otp`   body `{ "code": "123456" }`
A person types the OTP the site sent them. Same people as Retry (post rights on the job; an Admin or a poster for a login check). 400 `BAD_FORMAT` (4 to 10 letters or digits), 409 `NOT_WAITING`, 429 `TOO_MANY` (3 tries per entry), 502 `UNREACHABLE` (the worker is not on this computer). Answer `{ "ok": true }`: the code is handed to the waiting run through a loopback socket and is stored and echoed nowhere.

### GET `/diagnostics?days=30`   (Admin; TL, BDE, BDE TL, STL, Manager for their own jobs; never a Recruiter)
Per portal: `health { state OK|ATTENTION|BROKEN, words, issues[] }`, `credential { hasLogin, status, enabled, lastTest { state, words, reason, at } }` (login name only for an Admin), `session { saved, ageHours, ageWords, stale }`, `selectors { version, verified, label, counts { ok, drift, broken, unknown }, steps[ { key, label, state, main, used, usedIndex, ways } ] }`, `failures { total, failed, rate, byCategory { LOGIN, OTP, CAPTCHA, SELECTOR, VALIDATION, PORTAL_DOWN, GUARD, OTHER }, driftRuns }`, `lastAttempts[]` (with `pictures`, `canRetry`, `waiting`, `help`). Top level: `worker`, `killAll`, `realPostingAllowed`, `retention { days, files, bytes }`, `categories` (the plain words).
Test connection states (`credential.lastTest.state`): NOT_TESTED TESTING CONNECTED WRONG_LOGIN NEEDS_OTP NEEDS_CAPTCHA NEEDS_CHECK BLOCKED PORTAL_DOWN PAGE_CHANGED NO_BROWSER ERROR.

### GET `/diagnostics/attempts/:id`
One attempt: `{ entry, job, logs[], files[ { logId, kind: "image"|"structure", step } ], selectorEvents[] }`. Files are fetched with `GET /logs/:logId/screenshot`.

### PUT `/diagnostics/retention` `{ "days": 30 }` (Admin) and POST `/diagnostics/sweep` (Admin: delete old pictures now)

### Credentials: format checks
`PUT /credentials/:portal` refuses a badly formed login with `400 { error, problems[] }` (incomplete e-mail, a space inside the name, password too short or equal to the name ...) and returns `warnings[]` for doubtful ones. Saving resets the last test to NOT_TESTED.
