# Deployment (nothing here is deployed by this work)

The worker is a **separate process** from the web server. Without it, Publish queues entries that wait (`/health` says "The worker is not running").

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `INTEGRATION_SECRET_KEY` | (existing) | encrypts the portal logins (same key as Integrations). No key = a login cannot be saved |
| `TL_ALLOW_REAL_POSTING` | unset | the worker refuses `dev.db` unless `1`. On the VPS (its own DB) set it deliberately |
| `PLAYWRIGHT_CHROME_PATH` | auto (Chrome, then Edge) | the browser the worker drives. No browser is downloaded |
| `TL_PORTAL_PROFILE_DIR` | `~/.teamlink-portal-sessions` | browser sign-in profiles (cookies in the clear: private, chmod 700, outside the repo) |
| `TL_PORTAL_SCREENSHOT_DIR` | `~/.teamlink-portal-shots` | screenshots |
| `TL_PORTAL_LOG_DIR` | `~/.teamlink-portal-logs` | run log files (also in `PostingLog`) |
| `TL_PORTAL_SELECTORS_DIR` / `TL_PORTAL_SELECTORS_<PORTAL>` | built-in | page settings override |
| `TL_POSTING_STRICT_LOCAL` | unset | `1` = the browser may open localhost only (tests) |
| `TL_POSTING_INLINE` | unset | the API may run a credential check itself |
| `TL_POSTING_NO_INLINE` | unset | `1` = even the career page waits for the worker |
| `TL_POSTING_BACKOFF_BASE_MS` | 30000 | first retry delay |
| `TL_PORTAL_NO_PACING` | unset | `1` = no 1-3 s pauses (tests only) |
| `DATABASE_URL`, `PORT`, `APP_BASE_URL` | (existing) | the worker needs the same database; `PORT` = the web server's (the career page check calls it) |

Concurrency and limits are settings, not variables: `PUT /api/job-publish/portals/all/limits` (`globalConcurrency` 1, `minGapSeconds` 30, `maxGapSeconds` 45, `perHour` 10, `perDay` 40, `maxAttempts` 3).

## pm2 (VPS)

```js
// ecosystem.worker.config.js  (add next to the existing teamlink entry)
module.exports = { apps: [{
  name: 'teamlink-posting-worker',
  cwd: '/var/www/teamlink-enterprise/backend',
  script: 'src/workers/postingWorker.js',
  autorestart: true, max_memory_restart: '700M', kill_timeout: 190000,   // lets a run finish on SIGTERM
  env: { NODE_ENV: 'production', TL_ALLOW_REAL_POSTING: '1', PLAYWRIGHT_CHROME_PATH: '/usr/bin/google-chrome-stable', TL_PORTAL_PROFILE_DIR: '/var/lib/teamlink/portal-sessions' },
}] };
```
`pm2 start ecosystem.worker.config.js`. Install Chrome on the VPS (`google-chrome-stable`). `mkdir -p /var/lib/teamlink/portal-sessions && chmod 700` owned by the worker user. A person signs in on the VPS with a desktop session or `xvfb-run` plus a remote viewer (`npm run portal-session -- naukri`), or signs in on a PC and copies the profile folder over a private channel (cookies = the account: treat as a password).

## Docker (worker only; optional)

`Dockerfile.worker`:
```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y wget gnupg ca-certificates fonts-liberation \
 && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/chrome.list \
 && apt-get update && apt-get install -y google-chrome-stable && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
ENV PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome-stable TL_PORTAL_PROFILE_DIR=/data/sessions TL_PORTAL_SCREENSHOT_DIR=/data/shots TL_PORTAL_LOG_DIR=/data/logs
USER node
CMD ["node", "src/workers/postingWorker.js"]
```
`docker-compose.worker.yml`:
```yaml
services:
  posting-worker:
    build: { context: ., dockerfile: Dockerfile.worker }
    restart: unless-stopped
    shm_size: 512m          # Chrome needs shared memory
    env_file: backend/.env
    environment: { TL_ALLOW_REAL_POSTING: "1" }
    volumes:
      - ./backend/prisma:/app/backend/prisma     # the same SQLite file as the web server
      - worker-data:/data                         # sessions, screenshots, logs (private volume)
volumes: { worker-data: {} }
```
Chrome in a container: run it without a visible window; the first sign-in (CAPTCHA / OTP) must be done on a machine with a screen and the profile copied in. SQLite on a shared volume works on one host only.

## Backup and restore of the posting tables
They live in the same SQLite file as everything else, so the daily backup (`utils/backup.js`) already covers them. To copy only them: `sqlite3 dev.db ".dump PostingQueue PostingLog PortalPosting PortalMapping PortalCredential" > posting.sql`. Restore with `sqlite3 dev.db < posting.sql` after the migration. `PortalCredential` is ciphertext: it is only readable with the same `INTEGRATION_SECRET_KEY`. Undo of the whole feature: `prisma/migrations/20261013120000_job_publish_queue/rollback.sql`.

## Log retention
`PostingLog` grows with every run. Keep 90 days: `DELETE FROM "PostingLog" WHERE "createdAt" < strftime('%s','now','-90 day')*1000;` and delete finished queue rows older than a year (`SUCCEEDED`, `CANCELLED`). Screenshots and `~/.teamlink-portal-logs` files: delete files older than 30 days (a cron `find ... -mtime +30 -delete`).

## Apply the migration
`backend/prisma/migrations/20261013120000_job_publish_queue/migration.sql` (the main agent applies it; `prisma generate` after). The code reads and writes the five tables with plain SQL, so it works before and after `generate`.
