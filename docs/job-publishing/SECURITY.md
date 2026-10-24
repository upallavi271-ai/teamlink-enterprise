# Security

## Who can do what (server side)
See the table in API.md. Posting uses the same permission as Save & Post (`Job Posting` / edit plus the job's own chain): TL, BDE, BDE TL, Admin, Super Admin. Recruiter, Manager, Assistant Manager and STL can look but not post. Viewing is cut to the viewer's own jobs (`utils/scope.js`). Credentials, switches, limits and mapping edits are Super Admin / Admin only (Role Catalog feature **Job Portal Credentials**, administration module). Client and candidate logins are refused. The Recruiter sees a job's status but never logs, the queue or credentials.

Agreement privacy is kept: the route is behind `agreementGuard`; a job held for the agreement says "on hold" to a TL / STL / Recruiter / HR; job text never carries agreement lines. A candidate never sees the client name: the company on a public board is "TeamLink Consultants" and the text comes from "Write the job posts" (client name replaced); a last check refuses a post that still names the client.

## Audit
One `AuditLog` row for every publish / republish / unpublish / retry / cancel / discard / bulk / schedule, credential change (names the field, never a value), switch ON/OFF, kill switch, pause, limits, mapping change, and each outcome (Published, Needs a person, Failed, Dead letter). Entity `JobPublish` (entityId = job), `PortalCredential`, `PortalMapping`. The old "Posted on" log also gets "Posted by automation".

## Credentials
`username`, `password`, `secret` are AES-256-GCM (`enc:v1:`) with the existing `INTEGRATION_SECRET_KEY` (`utils/secrets.js`). No key = saving refuses (never plaintext). API answers carry a masked username (`re••••@x.com`) and "has a password". Plaintext exists only in the worker's memory for one run. Logs are scrubbed of the run's secrets and of `password=` / `token=` / `Bearer` patterns. Screenshots mask password, OTP and CAPTCHA boxes; on a page that shows a password box **every** input is masked (so the typed login name is hidden too) and the picture is still kept, so every attempt has evidence. Pictures are stored in a private folder outside the repo, served only through the authenticated route (scope-checked), and deleted after the retention time (default 30 days; Admin can change it). Page-structure snapshots hold no typed value and no personal text. A changed login clears the browser profile. A wrong password marks the login FAILED and stops automation until a new login is saved (repeated wrong logins lock accounts).
**Browser profile folders hold the portal's cookies in the clear** (Chrome does that). They live outside the repo (`~/.teamlink-portal-sessions`), are never committed or deployed, and on the VPS must be owned by the worker user with `chmod 700`.

## OTP typed by a person
The OTP never touches storage. The Admin or poster types it in the *Enter the OTP* box; `POST /api/job-publish/queue/:id/otp` (post rights on that job, 3 tries per entry, 40 requests/min) checks only its shape (4-10 letters or digits) and hands it over a signed (HMAC of the queue id with the server secret) message on a **127.0.0.1-only** socket to the waiting run. The answer, the audit row ("OTP typed by a person": who, queue id) and the logs never contain the code; the run's logger also scrubs it. The API and the worker must run on the same computer. TeamLink never reads, guesses or auto-fills an OTP and never uses a code-solving service.

## Real posting gate
A real post needs `TL_ALLOW_REAL_POSTING=1` (set by the server owner, in the environment of the API and the worker), the portal's own switch ON (default OFF), not a Dry run, and page settings marked `"verified": true` after a person calibrated them (CALIBRATION.md). Otherwise the job is held back and the by-hand task is kept.

## Queue and worker
Only the API writes entries and only after the RBAC checks. The worker is a separate process, never started by the web server, and refuses the real database without `TL_ALLOW_REAL_POSTING=1`. Per-portal switch default OFF. Kill switch and pause. Idempotency keys stop duplicate posts. Submit is never repeated after it was pressed. Rate limits protect the company accounts.

## API
JWT login as the rest of the app; 40 commands per minute per login; bodies are validated (portal keys, ids, dates, mapping fields); screenshot files are served only from the private folder (path traversal refused) and only to someone who may see that job's logs; every response goes through the agreement guard and the "never serialise a password hash" rule.

## Why there is no CAPTCHA bypass
Solving or evading a CAPTCHA / OTP / 2-step check breaks the portals' terms, gets the company account blocked, and defeats a control that exists to protect the account. TeamLink stops, keeps the job (the by-hand task), tells a person, and puts that portal on hold. No stealth, no fingerprint spoofing, no proxy rotation.

## Terms-of-service risk (read this)
Naukri, Foundit, Shine and LinkedIn have **no open posting API**. Driving their recruiter pages with a program may be against their terms even with the company's own account. LinkedIn forbids it outright (so it stays manual). The adapters are off by default, the per-portal switch is OFF, pacing is human-like and limits are low, but the risk is the company's: get the portal's written agreement where you can (Naukri Amplify / account manager, Shine, Foundit relationship managers), and keep the by-hand flow as the fallback. The page settings are unverified until you run a DRY RUN with your own account.
