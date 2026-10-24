#!/usr/bin/env bash
# ============================================================================
# TEAMLINK VPS SYNC  (runs ON THE VPS every 2 minutes, by teamlink-sync.timer)
#
#   GitHub (branch main) is the ONE source of truth for the code of every app:
#     TeamLink (HRMS / ATS / Accounts / Omni)   backend/ frontend/        -> /opt/teamlink-enterprise
#     Job Portal                                job-portal-app/           -> /opt/teamlink-enterprise/job-portal-app
#     Green Start                               green-start-app/          -> /opt/green-start
#
#   STEP 1  VPS -> GitHub : a file that somebody edited DIRECTLY on the VPS (compared with what the last deploy put there)
#                           is committed ("VPS-edit: ...") and pushed to main, so it reaches the PC and everyone.
#   STEP 2  GitHub -> VPS : when main has a new commit, the apps whose folders changed are rebuilt and restarted
#                           (backup first, health check after, automatic rollback if it fails).
#
#   Never touched: databases, .env files, uploads, node_modules, logs, the Job Portal's var/ (its live database).
#   Pause it:  touch /opt/teamlink-sync/PAUSE      Resume:  rm /opt/teamlink-sync/PAUSE
#   Look:      tail -50 /opt/teamlink-sync/sync.log        Status:  cat /opt/teamlink-sync/STATUS
#   Test run:  DRY_RUN=1 /opt/teamlink-sync/teamlink-sync.sh      (prints what it WOULD do; changes nothing)
# ============================================================================
set -uo pipefail

LIVE=${LIVE:-/opt/teamlink-enterprise}
GS=${GS:-/opt/green-start}
SRC=${SRC:-/opt/teamlink-src}
STATE=${STATE:-/opt/teamlink-sync}
BRANCH=${BRANCH:-main}
REPO=${REPO:-git@github.com:upallavi271-ai/teamlink-enterprise.git}
KEY=${KEY:-/root/.ssh/teamlink_github_ed25519}
PM2_NAME=${PM2_NAME:-teamlink-enterprise}
PORT=${PORT:-4010}
GS_API_PORT=${GS_API_PORT:-4020}
GS_USER=${GS_USER:-greenstart}
DRY=${DRY_RUN:-0}
STAMP=$(date +%Y-%m-%d-%H%M%S)
MODE=${1:-normal}     # normal | accept-github (a VPS edit that clashes: keep the GitHub version) | accept-vps (keep the VPS version)
CONFLICTS=""

mkdir -p "$STATE" "$STATE/base" "$STATE/backups"
LOG=$STATE/sync.log
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20"
export GIT_TERMINAL_PROMPT=0

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }
status() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" > "$STATE/STATUS"; }
alert() { log "ALERT: $*"; printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" > "$STATE/ALERT"; }
do_or_say() { if [ "$DRY" = 1 ]; then log "[dry-run] would run: $*"; return 0; fi; "$@"; }

# only one copy at a time (the timer may fire while a deploy is still running)
exec 9>"$STATE/lock"
flock -n 9 || exit 0
[ -f "$STATE/PAUSE" ] && { status "PAUSED (remove $STATE/PAUSE to resume)"; exit 0; }
[ -f "$KEY" ] || { status "waiting: the GitHub key $KEY does not exist yet"; exit 0; }

g() { git -C "$SRC" "$@"; }

# ---- the clone ----------------------------------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  log "first start: cloning $REPO into $SRC"
  git clone --quiet --branch "$BRANCH" "$REPO" "$SRC" || { alert "could not clone $REPO (is the deploy key added on GitHub?)"; exit 1; }
fi
g config user.name "TeamLink VPS" >/dev/null; g config user.email "vps@teamlinks.in" >/dev/null
g config core.autocrlf false >/dev/null

# ---- what each app is, where it lives on the VPS, and what is never copied -------------------------------------------------
# name | repo folder (in the clone) | live folder | exclude file
write_excludes() {
  cat > "$STATE/exclude-backend.txt" <<'EOF'
node_modules
backups
uploads
.git
.env
.env.*
*.bak
*.bak-*
*.db.bak*
*.tmp
*.log
*.orig
sandbox*.db*
sandbox.db.*
vps-*
integration-key*
integration-sync*
dev.db
dev.db-wal
dev.db-shm
dev.db-journal
*.db
*.db-wal
*.db-shm
apply-integrations.js
verify-vps-*.js
check-vps-*.js
export-vps-*.js
update-vps-*.js
check-superadmin.js
check-claude*.js
check-integrations.*
check-employees.js
compare-*.js
find-missing-employees.js
EOF
  cat > "$STATE/exclude-frontend.txt" <<'EOF'
node_modules
dist
.git
.vite
*.log
*.tmp
EOF
  cat > "$STATE/exclude-portal.txt" <<'EOF'
node_modules
var
run
.git
*.log
*.pid
*.tmp
.env
.env.*
EOF
  cat > "$STATE/exclude-gs.txt" <<'EOF'
node_modules
dist
.git
.env
.env.*
uploads
pgdata
redis
*.log
*.tmp
*.pdb
.cache
.npm
EOF
}
write_excludes

# ---- STEP 1: edits made directly on the VPS -> GitHub ------------------------------------------------------------------------
# Compare each live folder with the copy of what the last deploy put there ($STATE/base/<app>).
# Only changed and new files count. A deleted file is never pushed (deploys leave some files out on purpose).
EDITS_FOUND=0
collect_edits() {   # app  live_dir  repo_dir  exclude_file  [extra rsync args...]
  local app=$1 live=$2 repo=$3 exc=$4; shift 4
  local base="$STATE/base/$app"
  [ -d "$base" ] || return 0            # nothing deployed by this system yet: nothing to compare with
  [ -d "$live" ] || return 0
  local list
  list=$(rsync -rcn --itemize-changes --exclude=package-lock.json --exclude='*.tsbuildinfo' --exclude-from="$exc" "$@" "$live/" "$base/" 2>/dev/null | awk '/^>f/ {sub(/^[^ ]+ /,""); print}')
  [ -z "$list" ] && return 0
  EDITS_FOUND=1
  log "edited on the VPS ($app): $(echo "$list" | wc -l) file(s): $(echo "$list" | head -3 | tr '\n' ' ')"
  [ "$DRY" = 1 ] && return 0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local rf="$SRC/$repo/$f" bf="$base/$f" lf="$live/$f"
    # CLASH = the file was ALSO changed on GitHub since the last deploy (it differs from what the deploy put on the VPS) and differs from the VPS edit
    if [ -f "$rf" ] && ! cmp -s "$rf" "$lf" && { [ ! -f "$bf" ] || ! cmp -s "$rf" "$bf"; }; then
      case "$MODE" in
        accept-github) mkdir -p "$(dirname "$lf")"; cp -p "$rf" "$lf"; mkdir -p "$(dirname "$bf")"; cp -p "$rf" "$bf"; log "kept the GitHub version of $repo/$f"; continue ;;
        accept-vps) : ;;
        *) CONFLICTS="$CONFLICTS $repo/$f"; log "clash detail $repo/$f: github=$(md5sum < "$rf" 2>/dev/null | cut -c1-6) base=$(md5sum < "$bf" 2>/dev/null | cut -c1-6) vps=$(md5sum < "$lf" | cut -c1-6)"; continue ;;
      esac
    fi
    mkdir -p "$SRC/$repo/$(dirname "$f")"
    cp -p "$lf" "$rf"
  done <<< "$list"
}
push_vps_edits() {
  g fetch --quiet origin "$BRANCH" || { log "GitHub not reachable (offline?) - will try again"; return 1; }
  g checkout --quiet "$BRANCH" 2>/dev/null
  # start from the newest GitHub state so the copied files land on top of it
  if [ -n "$(g status --porcelain)" ]; then g reset --hard --quiet "origin/$BRANCH"; g clean -fdq; fi
  if [ "$(g rev-parse HEAD)" != "$(g rev-parse origin/$BRANCH)" ]; then g merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null || g reset --hard --quiet "origin/$BRANCH"; fi
  EDITS_FOUND=0
  collect_edits teamlink-backend  "$LIVE/backend"  backend  "$STATE/exclude-backend.txt"
  collect_edits teamlink-frontend "$LIVE/frontend" frontend "$STATE/exclude-frontend.txt"
  collect_edits jobportal-main    "$LIVE/job-portal-app/job_portal-main" job-portal-app/job_portal-main "$STATE/exclude-portal.txt"
  collect_edits jobportal-embed   "$LIVE/job-portal-app/embed" job-portal-app/embed "$STATE/exclude-portal.txt"
  collect_edits greenstart-api    "$GS/gs-api"          green-start-app/gs-api          "$STATE/exclude-gs.txt"
  collect_edits greenstart-web    "$GS/green-start-web" green-start-app/green-start-web "$STATE/exclude-gs.txt"
  collect_edits greenstart-run    "$GS/run"             green-start-app/run             "$STATE/exclude-gs.txt"
  if [ -n "$CONFLICTS" ]; then
    g reset --hard --quiet "origin/$BRANCH"; g clean -fdq
    alert "VPS edit CLASHES with a newer GitHub change in:$CONFLICTS . Nothing was pushed or deployed. Keep GitHub's version: teamlink-sync.sh accept-github   Keep the VPS version: teamlink-sync.sh accept-vps"
    return 2
  fi
  [ "$EDITS_FOUND" = 0 ] && return 0
  [ "$DRY" = 1 ] && return 0
  g add -A
  # a secret never goes up
  local bad; bad=$(g diff --cached --name-only | grep -E '(^|/)\.env($|\.)|\.(pem|key|p12|pfx)$' | grep -Ev '\.example$' || true)
  if [ -n "$bad" ]; then g reset -q; alert "an edited file on the VPS looks like a secret ($bad); nothing was pushed"; return 2; fi
  local n names
  n=$(g diff --cached --name-only | wc -l)
  names=$(g diff --cached --name-only | head -3 | xargs -n1 basename | paste -sd, - | sed 's/,/, /g')
  g commit -q -m "VPS-edit: $names$([ "$n" -gt 3 ] && echo ", +$((n-3)) more")" || return 0
  if ! g pull --quiet --rebase origin "$BRANCH"; then
    g rebase --abort 2>/dev/null; g reset --hard --quiet "origin/$BRANCH"
    alert "a VPS edit CONFLICTS with a newer change on GitHub; the VPS edit was NOT pushed (the edited file is still on the VPS). Resolve by hand."
    return 1
  fi
  local before; before=$(g rev-parse "origin/$BRANCH")
  if g push --quiet origin "$BRANCH"; then
    log "VPS edits pushed to GitHub ($n file(s))"
    # nothing else arrived meanwhile: the VPS already runs these files, so this commit is not "new" for it
    if [ "$(cat "$STATE/deployed-commit" 2>/dev/null)" = "$before" ]; then g rev-parse HEAD > "$STATE/deployed-commit"; fi
    # these files now ARE the base, so they are not reported again
    sync_base_from_live
  else
    g reset --hard --quiet "origin/$BRANCH"; log "push failed (offline?) - will try again"; return 1
  fi
}
sync_base_from_live() {
  rsync -ac --exclude-from="$STATE/exclude-backend.txt"  "$LIVE/backend/"  "$STATE/base/teamlink-backend/"  2>/dev/null
  rsync -ac --exclude-from="$STATE/exclude-frontend.txt" "$LIVE/frontend/" "$STATE/base/teamlink-frontend/" 2>/dev/null
  [ -d "$LIVE/job-portal-app/job_portal-main" ] && rsync -ac --exclude-from="$STATE/exclude-portal.txt" "$LIVE/job-portal-app/job_portal-main/" "$STATE/base/jobportal-main/" 2>/dev/null
  [ -d "$LIVE/job-portal-app/embed" ] && rsync -ac --exclude-from="$STATE/exclude-portal.txt" "$LIVE/job-portal-app/embed/" "$STATE/base/jobportal-embed/" 2>/dev/null
  [ -d "$GS/gs-api" ] && rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$GS/gs-api/" "$STATE/base/greenstart-api/" 2>/dev/null
  [ -d "$GS/green-start-web" ] && rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$GS/green-start-web/" "$STATE/base/greenstart-web/" 2>/dev/null
  [ -d "$GS/run" ] && rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$GS/run/" "$STATE/base/greenstart-run/" 2>/dev/null
}

# ---- STEP 2: GitHub -> VPS -----------------------------------------------------------------------------------------------------
health_teamlink() { for i in 1 2 3 4 5 6 7 8 9 10 11 12; do if curl -s -m 4 "http://127.0.0.1:$PORT/api/health" | grep -q 'ok.*true'; then return 0; fi; sleep 5; done; return 1; }

rollback_teamlink() {   # stamp
  local s=$1
  ( cd "$LIVE" || exit 1
    if [ ! -d "backend-old-$s" ]; then pm2 restart "$PM2_NAME" --update-env; exit 0; fi
    pm2 stop "$PM2_NAME"
    [ -d backend ] && mv backend "backend-failed-$s"
    mv "backend-old-$s" backend
    if [ -d "frontend-old-$s" ]; then [ -d frontend ] && mv frontend "frontend-failed-$s"; mv "frontend-old-$s" frontend; fi
    cd backend && pm2 restart "$PM2_NAME" --update-env && pm2 save ) >>"$LOG" 2>&1
}

deploy_teamlink() {   # new commit
  local PKG="$STATE/pkg" BK="/root/teamlink-backups/$STAMP-before-auto-deploy" step="packaging"
  rm -rf "$PKG"; mkdir -p "$PKG/backend" "$PKG/frontend"
  rsync -a --exclude-from="$STATE/exclude-backend.txt"  "$SRC/backend/"  "$PKG/backend/"
  rsync -a --exclude-from="$STATE/exclude-frontend.txt" "$SRC/frontend/" "$PKG/frontend/"
  local portal=0
  if [ -f "$SRC/job-portal-app/job_portal-main/package.json" ]; then
    portal=1; mkdir -p "$PKG/job-portal-app"
    rsync -a --exclude-from="$STATE/exclude-portal.txt" "$SRC/job-portal-app/job_portal-main/" "$PKG/job-portal-app/job_portal-main/"
    [ -d "$SRC/job-portal-app/embed" ] && rsync -a --exclude='*.log' "$SRC/job-portal-app/embed/" "$PKG/job-portal-app/embed/"
  fi
  [ -d "$PKG/job-portal-app/job_portal-main/var" ] && { alert "the Job Portal database folder (var) was in the package: stopped"; return 1; }
  [ -f "$PKG/frontend/src/pages/Invoices.jsx" ] || { alert "package check failed (Invoices.jsx missing): stopped"; return 1; }
  if [ "$DRY" = 1 ]; then log "[dry-run] TeamLink package built: backend $(du -sh "$PKG/backend" | cut -f1), frontend $(du -sh "$PKG/frontend" | cut -f1), portal=$portal. Nothing was stopped or replaced."; return 0; fi

  step="backup"
  mkdir -p "$BK" && cp "$LIVE/backend/prisma/dev.db" "$BK/dev.db" && cp "$LIVE/backend/.env" "$BK/.env" || { alert "backup failed: deploy stopped"; return 1; }
  local UPL; UPL=$(sed -n 's/^UPLOAD_DIR=//p' "$LIVE/backend/.env" | tail -1 | tr -d '\042\047\r'); UPL=${UPL:-$HOME/.teamlink-uploads}
  [ -d "$UPL/resumes" ] && tar -czf "$BK/resumes.tar.gz" -C "$UPL" resumes
  log "TeamLink deploy of ${1:0:8} starting (backup $BK)"
  (
    set -e
    S() { echo "$1" > "$STATE/laststep"; }
    S stopping; pm2 stop "$PM2_NAME"
    OLDB="$LIVE/backend-old-$STAMP"; OLDF="$LIVE/frontend-old-$STAMP"
    mv "$LIVE/backend" "$OLDB"; mv "$LIVE/frontend" "$OLDF"
    cp -a "$PKG/backend" "$LIVE/backend"; cp -a "$PKG/frontend" "$LIVE/frontend"
    cp "$OLDB/.env" "$LIVE/backend/.env"
    # the live database is KEPT (never replaced by a deploy)
    cp "$OLDB/prisma/dev.db" "$LIVE/backend/prisma/dev.db"; rm -f "$LIVE/backend/prisma/dev.db-wal" "$LIVE/backend/prisma/dev.db-shm"
    if [ "$portal" = 1 ]; then
      R=$LIVE; mkdir -p "$R/job-portal-app"
      if [ -d "$R/job-portal-app/job_portal-main" ]; then tar -czf "$BK/job-portal-code.tar.gz" -C "$R/job-portal-app" --exclude=node_modules --exclude=var --exclude=run . ; fi
      ( cd "$PKG/job-portal-app" && tar cf - . ) | ( cd "$R/job-portal-app" && tar xf - )
      ( cd "$R/job-portal-app/job_portal-main" && npm install --include=dev --no-audit --no-fund )
      ( cd "$R/job-portal-app/job_portal-main/api" && npm install --omit=dev --no-audit --no-fund )
      ENVF=$R/backend/.env
      grep -q '^JOB_PORTAL_EMBED=' "$ENVF" || echo 'JOB_PORTAL_EMBED=1' >> "$ENVF"
      grep -q '^JOB_PORTAL_SYNC_TOKEN=' "$ENVF" || echo "JOB_PORTAL_SYNC_TOKEN=$(openssl rand -hex 24)" >> "$ENVF"
      grep -q '^JOB_PORTAL_PUSH_SECRET=' "$ENVF" || echo "JOB_PORTAL_PUSH_SECRET=$(openssl rand -hex 24)" >> "$ENVF"
      grep -q '^JOBPORTAL__AUTH_SECRET=' "$ENVF" || echo "JOBPORTAL__AUTH_SECRET=$(openssl rand -hex 32)" >> "$ENVF"
    fi
    S "installing backend"
    cd "$LIVE/backend"
    if cmp -s "$OLDB/package-lock.json" package-lock.json && [ -d "$OLDB/node_modules" ]; then cp -al "$OLDB/node_modules" node_modules; else npm install --no-audit --no-fund; fi
    S "database migrations"; npx prisma migrate deploy
    npx prisma generate
    S "building the frontend"; cd "$LIVE/frontend" && npm install --no-audit --no-fund && npm run build
    S restarting; cd "$LIVE/backend" && pm2 restart "$PM2_NAME" --update-env && pm2 save
    sleep 5
  ) >>"$LOG" 2>&1
  local rc=$?
  if [ $rc -eq 0 ] && health_teamlink; then
    log "TeamLink is healthy on ${1:0:8}"
    rsync -ac --delete --exclude-from="$STATE/exclude-backend.txt"  "$PKG/backend/"  "$STATE/base/teamlink-backend/"
    rsync -ac --delete --exclude-from="$STATE/exclude-frontend.txt" "$PKG/frontend/" "$STATE/base/teamlink-frontend/"
    if [ "$portal" = 1 ]; then
      rsync -ac --delete "$PKG/job-portal-app/job_portal-main/" "$STATE/base/jobportal-main/"
      [ -d "$PKG/job-portal-app/embed" ] && rsync -ac --delete "$PKG/job-portal-app/embed/" "$STATE/base/jobportal-embed/"
    fi
    ls -dt "$LIVE"/backend-old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf     # keep the 3 newest previous releases
    ls -dt "$LIVE"/frontend-old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
    return 0
  fi
  step=$(cat "$STATE/laststep" 2>/dev/null || echo "the health check"); alert "TeamLink deploy of ${1:0:8} FAILED (step: $step). Rolling back to the previous release."
  if rollback_teamlink "$STAMP"; then log "rolled back to the previous release (failed release kept as backend-failed-$STAMP)"; else alert "AUTOMATIC ROLLBACK DID NOT COMPLETE: run the rollback by hand (backend-old-$STAMP)"; fi
  return 1
}

health_gs() { for i in 1 2 3 4 5 6 7 8 9 10 11 12; do if curl -s -m 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GS_API_PORT/api/v1/health" | grep -q '^200'; then return 0; fi; sleep 5; done; return 1; }

deploy_greenstart() {   # new commit  old commit
  local new=$1 old=$2 BK="$STATE/backups/greenstart-$STAMP"
  local changed; changed=$(g diff --name-only "$old" "$new" -- green-start-app 2>/dev/null)
  if [ "$DRY" = 1 ]; then log "[dry-run] Green Start: $(echo "$changed" | grep -c .) changed file(s) would be deployed"; return 0; fi
  log "Green Start deploy of ${new:0:8} starting"
  mkdir -p "$BK"
  tar -czf "$BK/gs-code.tar.gz" -C "$GS" --exclude=node_modules --exclude=.env --exclude=uploads gs-api/src gs-api/dist gs-api/package.json gs-api/package-lock.json green-start-web/src green-start-web/dist run 2>/dev/null
  (
    set -e
    local_api=$SRC/green-start-app/gs-api; local_web=$SRC/green-start-app/green-start-web; local_run=$SRC/green-start-app/run
    rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$local_api/" "$GS/gs-api/"
    rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$local_web/" "$GS/green-start-web/"
    # only the helper files that already live in run/ on the server (gate, local bind, seed scripts); the rest of run/ is for the PC
    for f in "$GS"/run/*; do b=$(basename "$f"); [ -f "$local_run/$b" ] && cp -p "$local_run/$b" "$GS/run/$b"; done
    chown -R "$GS_USER:$GS_USER" "$GS/gs-api" "$GS/green-start-web" "$GS/run"
    if echo "$changed" | grep -q 'gs-api/package'; then runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npm install --no-audit --no-fund"; fi
    if echo "$changed" | grep -q 'green-start-web/package'; then runuser -u "$GS_USER" -- bash -lc "cd $GS/green-start-web && npm install --no-audit --no-fund"; fi
    if echo "$changed" | grep -q 'gs-api/prisma'; then runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npx prisma generate && npx prisma migrate deploy"; fi
    if echo "$changed" | grep -q '^green-start-app/gs-api/'; then runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npm run build"; fi
    if echo "$changed" | grep -q '^green-start-app/green-start-web/'; then runuser -u "$GS_USER" -- bash -lc "cd $GS/green-start-web && npm run build"; fi
    systemctl restart green-start-api green-start-worker green-start-gate
  ) >>"$LOG" 2>&1
  local rc=$?
  if [ $rc -eq 0 ] && health_gs; then
    log "Green Start is healthy on ${new:0:8}"
    rsync -ac --delete --exclude-from="$STATE/exclude-gs.txt" "$GS/gs-api/" "$STATE/base/greenstart-api/" 2>/dev/null
    rsync -ac --delete --exclude-from="$STATE/exclude-gs.txt" "$GS/green-start-web/" "$STATE/base/greenstart-web/" 2>/dev/null
    rsync -ac --delete --exclude-from="$STATE/exclude-gs.txt" "$GS/run/" "$STATE/base/greenstart-run/" 2>/dev/null
    return 0
  fi
  alert "Green Start deploy of ${new:0:8} FAILED. Putting the previous code back."
  ( tar -xzf "$BK/gs-code.tar.gz" -C "$GS" && chown -R "$GS_USER:$GS_USER" "$GS/gs-api" "$GS/green-start-web" "$GS/run" \
    && runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npm run build" && systemctl restart green-start-api green-start-worker green-start-gate ) >>"$LOG" 2>&1 \
    && log "Green Start rolled back" || alert "GREEN START ROLLBACK DID NOT COMPLETE: restore $BK/gs-code.tar.gz by hand"
  return 1
}

deploy_if_new() {
  g fetch --quiet origin "$BRANCH" || { log "GitHub not reachable (offline?)"; return 1; }
  local new old
  new=$(g rev-parse "origin/$BRANCH"); old=$(cat "$STATE/deployed-commit" 2>/dev/null || echo "")
  [ "$new" = "$old" ] && { status "up to date on ${new:0:8}"; return 0; }
  [ "$new" = "$(cat "$STATE/failed-commit" 2>/dev/null)" ] && { status "waiting: ${new:0:8} failed before; push a new commit to try again"; return 0; }
  if g log -1 --format=%B "$new" | grep -qi '\[skip deploy\]'; then log "commit ${new:0:8} says [skip deploy]"; [ "$DRY" = 1 ] || echo "$new" > "$STATE/deployed-commit"; return 0; fi
  g reset --hard --quiet "origin/$BRANCH"
  local paths
  if [ -z "$old" ] || ! g cat-file -e "$old^{commit}" 2>/dev/null; then paths="backend frontend job-portal-app green-start-app"
  else paths=$(g diff --name-only "$old" "$new" | cut -d/ -f1 | sort -u | tr '\n' ' '); fi
  log "new commit ${new:0:8} on $BRANCH (was ${old:0:8}); changed areas: ${paths:-none}"
  local ok=1
  # NOT "func || ok=0": inside an || list bash switches set -e off for the whole function, and a failed build would go unnoticed
  if echo " $paths " | grep -Eq ' (backend|frontend|job-portal-app) '; then deploy_teamlink "$new"; [ $? -eq 0 ] || ok=0; fi
  if [ $ok = 1 ] && echo " $paths " | grep -q ' green-start-app '; then deploy_greenstart "$new" "${old:-$new}"; [ $? -eq 0 ] || ok=0; fi
  if [ "$DRY" = 1 ]; then return 0; fi
  if [ $ok = 1 ]; then echo "$new" > "$STATE/deployed-commit"; rm -f "$STATE/failed-commit" "$STATE/ALERT"; status "deployed ${new:0:8}"; log "DONE: ${new:0:8} is live"
  else echo "$new" > "$STATE/failed-commit"; status "FAILED on ${new:0:8} (see sync.log)"; fi
}

# ---- run ---------------------------------------------------------------------------------------------------------------------------
if [ -z "$(cat "$STATE/deployed-commit" 2>/dev/null)" ] && [ ! -d "$STATE/base/teamlink-backend" ]; then
  log "first run: recording what is on the VPS now as the starting point for edit detection"
  [ "$DRY" = 1 ] || sync_base_from_live
fi
push_vps_edits; rc=$?
if [ $rc -eq 2 ]; then status "BLOCKED: see ALERT ($STATE/ALERT). Deploys are on hold until it is resolved."; exit 0; fi
if [ "$MODE" != normal ]; then rm -f "$STATE/ALERT"; log "resolved with $MODE"; fi
deploy_if_new
