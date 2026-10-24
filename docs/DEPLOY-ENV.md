# Environment flags for the real server (names only, no values)

Checked 2026-10-13 against `process.env` use in `backend/src`. Everything is OPTIONAL unless it says REQUIRED. Safe default = nothing is sent to real people by a timer and nothing is posted to a real portal.

## Must be set on the real server
| Name | Why | Default if unset |
|---|---|---|
| `JWT_SECRET` (REQUIRED) | signs every login | the server should not run without it |
| `INTEGRATION_SECRET_KEY` (REQUIRED to save credentials) | encrypts SMTP / API keys in Integrations | the screens refuse to store a secret |
| `DATABASE_URL`, `PORT`, `NODE_ENV=production` | basics | development values |
| `APP_BASE_URL` | public address in every emailed link and WhatsApp apply link | links become relative / localhost |
| `FRONTEND_URL` | set-password and reset links (falls back to `APP_BASE_URL`, then `http://localhost:5183`) | localhost |
| `CORS_ORIGINS`, `TRUST_PROXY=loopback` (behind nginx) | web hardening | production default = `APP_BASE_URL`; proxy trust off |
| `JOB_PORTAL_SYNC_TOKEN`, `JOB_PORTAL_PUSH_SECRET`, `JOB_PORTAL_PUBLIC_URL`, `JOB_PORTAL_API_URL` | job portal link (secrets must equal the portal's .env) | sync disabled |

## Switches that unlock REAL sending or posting (leave unset until the go-live day)
| Name | Effect when 1 |
|---|---|
| `TL_ALLOW_REAL_POSTING` | the posting worker may run against the real `dev.db` and post to real job portals (each portal's own switch must also be ON) |
| `TL_ALLOW_REAL_WHATSAPP_QR` | allows linking a real WhatsApp number by QR on the real database (unofficial, ban risk; use a spare number) |
| `ALLOW_PRIVATE_FETCH` | lets the server fetch private network addresses. Development only, never on the server |
| `BDE_JOB_REQUESTS` | re-opens the retired "BDE asks the TL to close / assign" requests |
| `TL_SEED_PASSWORDS` | extra starting passwords treated as "not yet changed" (forces the first-login change) |

## Tuning / sizing
`FACE_WORKERS` (1..3, lower on a small server), `API_RATE_LIMIT`, `API_RATE_WINDOW_MS`, `API_RATE_IP_MAX`, `API_RATE_USER_MAX`, `BACKUP_SCHEDULE` (0 = off), `BACKUP_HOUR`, `BACKUP_DIR`, `UPLOAD_DIR`, `ATS_IO_DIR`, `MESSAGE_JOB_DIR`, `SYSTEM_STATE_DIR`, `CANDIDATE_WARMUP`, `REPORT_WARMUP`, `JOB_PORTAL_EMBED` (default ON outside production, OFF in production unless set), `PARTNER_PORTAL_ENABLED` / `VENDOR_PORTAL_ENABLED` (same default), `*_PORTAL_ORIGINS`.

Timers (ms, 0 = off): `INTERVIEW_REMINDER_SWEEP_MS`, `PENDING_WORK_SWEEP_MS`, `AUTO_MESSAGES_SWEEP_MS`, `ATTENDANCE_ALERTS_INTERVAL_MS`, `ATTENDANCE_TASKS_INTERVAL_MS`, `ATS_ESCALATION_SWEEP_MS`, `DAILY_REPORT_MAIL_SWEEP_MS`, `PAYROLL_SYNC_SWEEP_MS`, `SEAT_SWEEP_MS`, `BULK_WORKER_INTERVAL_MS`, `MAIL_WORKER_INTERVAL_MS`, `JOB_PORTAL_SYNC_INTERVAL_MS`. A timer only matters if the matching engine setting is also ON (table below).

Signing secrets (each falls back to `JWT_SECRET`; give each its own value): `AGREEMENT_LINK_SECRET`, `OFFER_LINK_SECRET`, `PREP_LINK_SECRET`, `LMS_MEDIA_SECRET`, `PARTNER_JWT_SECRET`, `VENDOR_JWT_SECRET`.

## Test-only (never set on the real server)
`TEST_MODE`, `TL_SANDBOX`, `TEAMLINK_SANDBOX`, `TEST_ALLOW_AI`, `TEST_MOCK_PORTS`, `TL_RATE_LIMIT_IN_TEST` (turns the API rate limit ON inside the test sandbox), `TL_QR_BAILEYS_MODULE`, `TL_COMM_GAP_SCALE`, `TL_POSTING_STRICT_LOCAL`, `TL_POSTING_NO_INLINE`, `TL_POSTING_BACKOFF_BASE_MS`, `TL_PORTAL_NO_PACING`, `TL_MOCK_PORTAL_ORIGIN`, `TL_EXTERNAL_GUARD_LOG`, `TL_DEV_MESSAGING_BASE_URL`, `TL_IMPORT_SALARY_OPTIONAL`, `AP_ROLES` (test script only).

## Engines that send things: where they are switched on
| Engine | Setting (AppSetting key / Integration id) | Default |
|---|---|---|
| Pending-work reminders, escalation, end-of-day report | `pendingwork.settings` (enabled) | OFF |
| Pending-approval alerts (leave, exit, Pulse-sync reminder) | `pwr.chain` + the pending-work master switch | OFF |
| Interview reminders to candidate / client | `interview-reminders` (enabled) | OFF by code default. NOTE: already ON in the real dev.db |
| Interview reminder plan (who is told what) | `interview-reminder-plan` (armed) | OFF |
| Interview staff in-app bells | `interview-staff-reminders` | ON (in-app bell only, nothing leaves the app) |
| Automatic stage messages | `auto-messages` (goLiveAt null = old fixed messages) | new rules not live until first save |
| Attendance issue tasks | `attendance.issueTasks.settings` (enabled) | OFF |
| Attendance alerts / digest | Integration `attendance-alerts` (goLiveAt) | live only after its goLiveAt (already set in the real dev.db: 2026-09-29) |
| Exit approval reminders | `exit.settings` (reminderHours) + pending-approval master switch | OFF with the master switch |
| Job broadcast campaigns | `bc.settings` (master) | OFF |
| Job-portal posting | per-portal switch + `TL_ALLOW_REAL_POSTING` | OFF |
| WhatsApp QR worker | `comm.settings` (qr.killSwitch) + `TL_ALLOW_REAL_WHATSAPP_QR` | not linked |
| WhatsApp / SMS channels | Integration `whatsapp`, `sms` (enabled) | Not connected |
