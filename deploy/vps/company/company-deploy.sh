#!/usr/bin/env bash
# ============================================================================
# COMPANY DEPLOY - put one release of the application into ONE separate company's own folder (docs/second-company.md).
#
#   company-deploy.sh <key> [commit] [--no-start]
#
#   <key>      the company's short name (nish). Everything of that company lives in /opt/company-<key>:
#                config/.env  config/brand.env   its settings (secrets stay here, never in git)
#                data/        its database, uploaded files, backups      <- a deploy NEVER touches this
#                home/        the "home folder" of its process (every default data folder hangs under it)
#                backend/ frontend/               the release that is live now (code only)
#                state/                           deployed-commit, lock, STATUS, ALERT
#   [commit]   default: the commit TeamLink's own sync last deployed SUCCESSFULLY (/opt/teamlink-sync/deployed-commit).
#              The company therefore only ever runs code that is already proven healthy on TeamLink.
#   --no-start build and switch only (the first install starts it after the database has been created).
#
# Nothing outside /opt/company-<key> is written, and TeamLink's folders are only READ (git archive of the clone).
# Same method as TeamLink's own deploy: the new release is built NEXT to the live one; the company's server stops only for the switch,
# the migrations and the start; a failed health check puts the previous release back.
# ============================================================================
set -uo pipefail

KEY=${1:-}; [[ "$KEY" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "usage: company-deploy.sh <key> [commit] [--no-start] [--from-dir <folder with backend/ and frontend/> --label <name>]"; exit 2; }
shift
COMMIT=""; NOSTART=0; FROM_DIR=""; LABEL=""
while [ $# -gt 0 ]; do case "$1" in --no-start) NOSTART=1 ;; --from-dir) FROM_DIR=${2:-}; shift ;; --label) LABEL=${2:-}; shift ;; *) COMMIT=$1 ;; esac; shift; done

ROOT=${ROOT:-/opt/company-$KEY}
SRC=${SRC:-/opt/teamlink-src}                     # TeamLink's own clone of the GitHub repository (read only here)
TL_STATE=${TL_STATE:-/opt/teamlink-sync}
PM2_NAME=${PM2_NAME:-company-$KEY}
STATE=$ROOT/state
STAMP=$(date +%Y-%m-%d-%H%M%S)
LOG=$STATE/deploy.log

mkdir -p "$STATE" "$ROOT/data/backups" "$ROOT/home" "$ROOT/config"
log() { printf '%s  %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; }
alert() { log "ALERT: $*"; printf '%s  %s\n' "$(date '+%F %T')" "$*" > "$STATE/ALERT"; }
status() { printf '%s  %s\n' "$(date '+%F %T')" "$*" > "$STATE/STATUS"; }

exec 9>"$STATE/lock"
flock -n 9 || { echo "another deploy of $KEY is running"; exit 0; }

[ -f "$ROOT/config/.env" ] || { echo "$ROOT/config/.env is missing: run company-install.sh first"; exit 2; }
# --from-dir: a folder that holds backend/ and frontend/ (a tested copy sent to the server by hand) instead of a commit of TeamLink's clone.
# Used for the first install, before the company code is on GitHub main. The follower timer (company-sync.sh) is only switched on after that.
if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR/backend" ] && [ -d "$FROM_DIR/frontend" ] || { echo "$FROM_DIR must contain backend/ and frontend/"; exit 2; }
  [ -n "$LABEL" ] || LABEL=manual
  COMMIT=$LABEL
else
  [ -n "$COMMIT" ] || COMMIT=$(cat "$TL_STATE/deployed-commit" 2>/dev/null || true)
  [ -n "$COMMIT" ] || { alert "no commit to deploy ($TL_STATE/deployed-commit is empty)"; exit 1; }
  git -C "$SRC" cat-file -e "$COMMIT^{commit}" 2>/dev/null || { alert "commit ${COMMIT:0:8} is not in $SRC"; exit 1; }
fi

PORT=$(sed -n 's/^PORT=//p' "$ROOT/config/.env" | tail -1 | tr -d '"\047\r')
[ -n "$PORT" ] || { alert "PORT is not set in $ROOT/config/.env"; exit 1; }

PKG=$ROOT/.pkg-$STAMP
NEWB=$ROOT/backend-new-$STAMP;  OLDB=$ROOT/backend-old-$STAMP
NEWF=$ROOT/frontend-new-$STAMP; OLDF=$ROOT/frontend-old-$STAMP
NEWP=$ROOT/job-portal-app-new-$STAMP; OLDP=$ROOT/job-portal-app-old-$STAMP
cleanup() { rm -rf "$PKG" "$NEWB" "$NEWF" "$NEWP"; }
trap cleanup EXIT

log "deploy of ${COMMIT:0:8} to company '$KEY' starting (the live copy keeps running while the new one is built)"
status "building ${COMMIT:0:8}"

# 1. the code of that exact commit, taken from git (not from the clone's working files, which TeamLink's own sync may be changing)
mkdir -p "$PKG"
if [ -n "$FROM_DIR" ]; then cp -a "$FROM_DIR/backend" "$FROM_DIR/frontend" "$PKG/" || { alert "could not copy $FROM_DIR"; exit 1; }
else git -C "$SRC" archive "$COMMIT" backend frontend | tar -x -C "$PKG" || { alert "could not unpack ${COMMIT:0:8}"; exit 1; }; fi
[ -f "$PKG/backend/src/index.js" ] && [ -f "$PKG/frontend/package.json" ] || { alert "the package of ${COMMIT:0:8} is incomplete"; exit 1; }
if [ -f "$TL_STATE/check-requires.js" ]; then
  r=$(cd "$PKG/backend" && node "$TL_STATE/check-requires.js" src 2>&1) || { alert "the new backend would crash on start (nothing was stopped): $(echo "$r" | head -3 | tr '\n' ' ')"; exit 1; }
fi

# 1b. THIS COMPANY'S OWN JOB PORTAL (docs/second-company.md section 11). Only when its settings name a portal port (company-portal-install.sh writes it).
# The portal's code is a git SUBMODULE of TeamLink's repository, so it is taken from the submodule's own repository at the commit THIS release pins,
# plus the embed layer from the release itself. The portal's DATABASE, files and run folder live under data/job-portal (settings), never in this code folder.
PORTAL=0; PHASH=""; PORTAL_CHANGED=0
if grep -q '^JOB_PORTAL_PORT=' "$ROOT/config/.env" 2>/dev/null && [ -z "$FROM_DIR" ]; then
  sub=$(git -C "$SRC" ls-tree "$COMMIT" job-portal-app/job_portal-main 2>/dev/null | awk '{print $3}')
  if [ -n "$sub" ] && git -C "$SRC/job-portal-app/job_portal-main" cat-file -e "$sub^{commit}" 2>/dev/null; then
    mkdir -p "$PKG/job-portal-app/job_portal-main"
    if git -C "$SRC" archive "$COMMIT" job-portal-app/embed | tar -x -C "$PKG" && git -C "$SRC/job-portal-app/job_portal-main" archive "$sub" | tar -x -C "$PKG/job-portal-app/job_portal-main" && [ -f "$PKG/job-portal-app/job_portal-main/package.json" ]; then
      PORTAL=1
      PHASH=$(cd "$PKG/job-portal-app" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
      if [ "$PHASH" != "$(cat "$STATE/portal-hash" 2>/dev/null)" ] || [ ! -d "$ROOT/job-portal-app/job_portal-main/node_modules" ]; then PORTAL_CHANGED=1; fi
    else log "WARNING: the Job Portal code of ${COMMIT:0:8} could not be unpacked: the company's portal keeps its present code"; fi
  else log "WARNING: the Job Portal code that ${COMMIT:0:8} pins is not in the clone yet: the company's portal keeps its present code"; fi
fi

# 2. build both parts next to the live ones (hard links of the live packages when package-lock.json is the same: instant)
(
  set -e
  cp -a "$PKG/backend" "$NEWB"; cd "$NEWB"
  if [ -d "$ROOT/backend/node_modules" ] && cmp -s "$ROOT/backend/package-lock.json" package-lock.json; then cp -al "$ROOT/backend/node_modules" node_modules; rm -rf node_modules/.prisma; else npm ci --no-audit --no-fund; fi
  npx prisma generate
  cp -a "$PKG/frontend" "$NEWF"; cd "$NEWF"
  if [ -d "$ROOT/frontend/node_modules" ] && cmp -s "$ROOT/frontend/package-lock.json" package-lock.json; then cp -al "$ROOT/frontend/node_modules" node_modules; rm -rf node_modules/.vite node_modules/.cache; else npm ci --no-audit --no-fund; fi
  if [ -f "$ROOT/config/brand.env" ]; then set -a; . "$ROOT/config/brand.env"; set +a; fi
  npm run build
  [ -f dist/index.html ] || { echo "the screen build made no dist/index.html"; exit 1; }
) >>"$LOG" 2>&1 || { alert "building ${COMMIT:0:8} FAILED (see $LOG). Nothing was switched: the company's live copy was not touched."; status "FAILED building ${COMMIT:0:8}"; exit 1; }

# 2b. the portal's packages, next to the live ones (hard links of the live packages when package-lock.json is the same: instant). A portal that cannot be built
# never stops the company's own release: it keeps the code it has.
if [ $PORTAL_CHANGED = 1 ]; then
  LP=$ROOT/job-portal-app/job_portal-main
  (
    set -e
    cp -a "$PKG/job-portal-app" "$NEWP"
    cd "$NEWP/job_portal-main"
    if [ -d "$LP/node_modules" ] && cmp -s "$LP/package-lock.json" package-lock.json; then cp -al "$LP/node_modules" node_modules; else npm install --include=dev --no-audit --no-fund; fi
    cd api
    if [ -d "$LP/api/node_modules" ] && cmp -s "$LP/api/package-lock.json" package-lock.json; then cp -al "$LP/api/node_modules" node_modules; else npm install --omit=dev --no-audit --no-fund; fi
  ) >>"$LOG" 2>&1 || { log "WARNING: building the Job Portal of ${COMMIT:0:8} FAILED (see $LOG): the company's portal keeps its present code"; rm -rf "$NEWP"; PORTAL_CHANGED=0; }
fi
log "built; switching"
status "switching to ${COMMIT:0:8}"

# 3. switch. The database is outside backend/ (config/.env: DATABASE_URL=file:/opt/company-<key>/data/<key>.db) so nothing is copied.
had_live=0; [ -d "$ROOT/backend" ] && had_live=1
if [ $had_live = 1 ] && [ $NOSTART = 0 ]; then pm2 stop "$PM2_NAME" >>"$LOG" 2>&1 || true; fi
# the portal stops cleanly some seconds after its backend does (it closes its own database); its code is replaced only once it is down
if [ $PORTAL_CHANGED = 1 ] && [ -d "$NEWP" ]; then
  RUNDIR=$(sed -n 's/^JOB_PORTAL_RUN_DIR=//p' "$ROOT/config/.env" | tail -1 | tr -d '"\047\r')
  PIDF=$RUNDIR/portal.pid.json; w=0
  portal_up() { local p; [ -f "$PIDF" ] || return 1; p=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$PIDF" 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
  while portal_up && [ $w -lt 90 ]; do sleep 1; w=$((w+1)); done
  if portal_up; then log "WARNING: the company's Job Portal was still running after 90 s: its code was NOT replaced this time"; rm -rf "$NEWP"; PORTAL_CHANGED=0; fi
fi
DBFILE=$(sed -n 's/^DATABASE_URL=//p' "$ROOT/config/.env" | tail -1 | tr -d '"\047\r' | sed 's#^file:##')
if [ -f "$DBFILE" ]; then
  mkdir -p "$ROOT/data/backups/pre-deploy-$STAMP"
  cp "$DBFILE" "$DBFILE-wal" "$DBFILE-shm" "$ROOT/data/backups/pre-deploy-$STAMP/" 2>/dev/null || true
  ls -dt "$ROOT"/data/backups/pre-deploy-* 2>/dev/null | tail -n +11 | xargs -r rm -rf
fi
[ $had_live = 1 ] && mv "$ROOT/backend" "$OLDB"
[ -d "$ROOT/frontend" ] && mv "$ROOT/frontend" "$OLDF"
mv "$NEWB" "$ROOT/backend"; mv "$NEWF" "$ROOT/frontend"
had_portal=0
if [ $PORTAL_CHANGED = 1 ] && [ -d "$NEWP" ]; then
  [ -d "$ROOT/job-portal-app" ] && { had_portal=1; mv "$ROOT/job-portal-app" "$OLDP"; }
  mv "$NEWP" "$ROOT/job-portal-app"
fi
ln -sfn "$ROOT/config/.env" "$ROOT/backend/.env"
# the company's own logo for payslips / agreements / mails (the file keeps TeamLink's historical name); none given = those documents carry no logo
rm -rf "$ROOT/frontend/src"; mkdir -p "$ROOT/frontend/src/assets"
[ -f "$ROOT/config/logo.png" ] && cp "$ROOT/config/logo.png" "$ROOT/frontend/src/assets/teamlink-full-logo.png"
rm -rf "$ROOT/frontend/node_modules"

if [ $NOSTART = 1 ]; then
  echo "$COMMIT" > "$STATE/deployed-commit"; log "release ${COMMIT:0:8} is in place (not started: --no-start)"; status "in place ${COMMIT:0:8} (not started)"; exit 0
fi

# 4. migrations of THIS company's database only, then start
ok=1
( cd "$ROOT/backend" && npx prisma migrate deploy ) >>"$LOG" 2>&1 || ok=0
if [ $ok = 1 ]; then
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then pm2 restart "$PM2_NAME" --update-env >>"$LOG" 2>&1 || ok=0
  else pm2 start "$ROOT/ecosystem.config.js" >>"$LOG" 2>&1 || ok=0; fi
fi
healthy=0
if [ $ok = 1 ]; then
  for i in $(seq 1 12); do
    if curl -s -m 4 "http://127.0.0.1:$PORT/api/health" | grep -q "\"company\":\"$KEY\""; then healthy=1; break; fi
    sleep 5
  done
fi

if [ $healthy = 1 ]; then
  pm2 save >>"$LOG" 2>&1 || true
  echo "$COMMIT" > "$STATE/deployed-commit"; rm -f "$STATE/ALERT"
  [ $PORTAL = 1 ] && [ -n "$PHASH" ] && [ -d "$ROOT/job-portal-app/job_portal-main/node_modules" ] && echo "$PHASH" > "$STATE/portal-hash"
  ls -dt "$ROOT"/job-portal-app-old-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
  ls -dt "$ROOT"/backend-old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
  ls -dt "$ROOT"/frontend-old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
  log "company '$KEY' is healthy on ${COMMIT:0:8}"; status "deployed ${COMMIT:0:8}"; exit 0
fi

alert "deploy of ${COMMIT:0:8} FAILED for company '$KEY'. Putting the previous release back."
if [ $had_live = 1 ] && [ -d "$OLDB" ]; then
  pm2 stop "$PM2_NAME" >>"$LOG" 2>&1 || true
  mv "$ROOT/backend" "$ROOT/backend-failed-$STAMP"; mv "$OLDB" "$ROOT/backend"
  if [ -d "$OLDF" ]; then mv "$ROOT/frontend" "$ROOT/frontend-failed-$STAMP"; mv "$OLDF" "$ROOT/frontend"; fi
  if [ $had_portal = 1 ] && [ -d "$OLDP" ]; then mv "$ROOT/job-portal-app" "$ROOT/job-portal-app-failed-$STAMP"; mv "$OLDP" "$ROOT/job-portal-app"; fi
  pm2 restart "$PM2_NAME" --update-env >>"$LOG" 2>&1 && log "the previous release is back" || alert "AUTOMATIC ROLLBACK DID NOT COMPLETE for '$KEY': put backend-old / frontend-old back by hand"
fi
status "FAILED on ${COMMIT:0:8}"
exit 1
