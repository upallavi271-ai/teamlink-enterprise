# The queue

A database queue (table `PostingQueue`) with the behaviour a BullMQ queue would give, and no Redis.

| Feature | How |
|---|---|
| Enqueue | `queue.enqueue()`. The same job + site + action + content already waiting or running is the **same entry** (`duplicate: true`). A caller's `Idempotency-Key` returns the stored entry. A racing duplicate hits the UNIQUE `idempotencyKey` and gets the first entry. |
| Claim | one atomic `UPDATE ... RETURNING` (see LLD). Two workers never get the same row. |
| Concurrency | 1 per portal, global cap `globalConcurrency` (default **1**: the machine has little RAM). |
| Retry | attempt 1 about 30 s, then 60 s, 120 s ... up to 30 min, plus or minus 25 % jitter (`TL_POSTING_BACKOFF_BASE_MS` shortens it for tests). `maxAttempts` default 3. |
| Dead letters | tries used up: status `DEAD`. `GET /dead-letters`, then **Retry** (fresh tries) or **Discard** (closed, row kept). |
| NEEDS_HUMAN | CAPTCHA / OTP / 2-step / unusual activity / blocked, an unconfirmed post, a missing id, a failure after Submit, a switch turned OFF. **Never retried by itself.** Retry is a person's decision. |
| Stale locks | the worker refreshes `lockedAt` every 15 s. A `RUNNING` entry whose lock is older than 5 min lost its worker: put back to `QUEUED`, or `DEAD` when tries are used up, or `NEEDS_HUMAN` when it had already pressed Submit. |
| Rate limits | per portal: at least `minGapSeconds` to `maxGapSeconds` (default 30-45 s, one fixed value in the window) between two posts, `perHour` (10) and `perDay` (40); a credential row may set its own `minGapSeconds`, `hourlyLimit`, `dailyLimit`. A held entry stays `QUEUED`; `/queue` and `/portals` say why. |
| Schedule | `scheduledFor` = the first `nextRunAt` ("publish at 6 pm"). Expiry and auto-republish exist **only** when a person sets `expiresAt` on a job's portal (`PUT .../schedule`); nothing is scheduled by default. The worker's sweep only looks at rows a person scheduled. |
| Kill switch | `PUT /switches {killAll}` or `{portal, kill}`. Checked at every claim and before every step of a run. A run in progress stops at the next safe step and goes back to `QUEUED` (no try used). |
| Pause all | quiet: nothing new starts, nothing is reported. |
| Human hold | after a CAPTCHA etc. that portal's queue waits (more attempts on a flagged account make it worse) until a person signs in (`portal-session`) or an Admin presses Resume. |
| Verify | a sign-in-only entry (`action: VERIFY`, no job) for "Test connection". |

States: QUEUED, RUNNING, SUCCEEDED, FAILED, NEEDS_HUMAN, DEAD, CANCELLED.

## The worker
`npm run posting-worker` (poll every 5 s), `--once`, `--drain`. SIGTERM / Ctrl+C: finish the run, release nothing wrongly, exit 0. Writes a heartbeat so `/health` can say "worker running". Refuses the real `dev.db` without `TL_ALLOW_REAL_POSTING=1`.
