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
#   SUBMODULES (2026-10-24): job-portal-app/job_portal-main and green-start-app are git SUBMODULES of this repo (the founder's Job Portal and
#   Green Start repos, other GitHub accounts). This script therefore (a) runs  git submodule update  after every checkout of the clone,
#   (b) works out what changed in Green Start by comparing the two pinned commits INSIDE the submodule (the main repo only sees one pointer),
#   (c) never pushes a VPS edit of those two folders (it only reports it: copy the change into that sub repo by hand), and
#   (d) takes Green Start's TeamLink-owned helper files (gate.mjs, seed scripts ...) from green-start-helpers/run in THIS repo.
#   The Green Start repo is PRIVATE: the VPS needs read access to it (token or deploy key, see docs/SUBMODULES.md). SUBS=job-portal-app/job_portal-main
#   (an environment setting) makes this script ignore Green Start until that access exists.
#
#   Never touched: databases, .env files, uploads, node_modules, logs, the Job Portal's var/ (its live database).
#   Pause it:  touch /opt/teamlink-sync/PAUSE      Resume:  rm /opt/teamlink-sync/PAUSE
#   Look:      tail -50 /opt/teamlink-sync/sync.log        Status:  cat /opt/teamlink-sync/STATUS
#   Test run:  DRY_RUN=1 /opt/teamlink-sync/teamlink-sync.sh      (prints what it WOULD do; changes nothing)
# ============================================================================
set -uo pipefail
export HOME=${HOME:-/root}      # systemd gives a service no HOME: git then cannot find its saved GitHub login, and "set -u" stops on $HOME

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
GS_DB=${GS_DB:-greenstart}           # name of Green Start's Postgres database; it is dumped before every Green Start deploy ("" = do not)
DRY=${DRY_RUN:-0}
STAMP=$(date +%Y-%m-%d-%H%M%S)
MODE=${1:-normal}     # normal | rebuild-gs (rebuild + migrate + restart Green Start now) | accept-github (a VPS edit that clashes: keep the GitHub version) | accept-vps (keep the VPS version)
CONFLICTS=""
SUBS=${SUBS:-"job-portal-app/job_portal-main green-start-app"}   # the git submodules this server uses
SUBS_BAD=""
SUBBRANCH=${SUBBRANCH:-main}                    # the branch of the two sub repos that the main repo follows
GH_PREFIX=${GH_PREFIX:-git@github.com:}         # .gitmodules lists https://github.com/... ; this server fetches them over ssh with the same key instead
# VPS_EDITS=0 (default) = ONE WAY: code goes PC -> GitHub -> VPS only. A file changed directly on the VPS is never sent back to GitHub.
# VPS_EDITS=1 = step 1 is on: such edits of the TeamLink folders (backend/, frontend/, ...) are pushed to GitHub. Edits of the two sub repos are never pushed.
VPS_EDITS=${VPS_EDITS:-0}

mkdir -p "$STATE" "$STATE/base" "$STATE/backups"
LOG=$STATE/sync.log
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20"
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.${GH_PREFIX}.insteadOf"
export GIT_CONFIG_VALUE_0="https://github.com/"

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

# Bring each submodule folder of the clone to the commit the main repo pins. A sub repo that cannot be read is reported (SUBS_BAD), never fatal here.
sync_subs() {
  SUBS_BAD=""
  g submodule sync --quiet >/dev/null 2>&1
  local s
  for s in $SUBS; do
    g submodule update --init --force --quiet -- "$s" >>"$LOG" 2>&1 || { SUBS_BAD="$SUBS_BAD $s"; alert "cannot read the sub repo $s (private? the VPS needs read access, see docs/SUBMODULES.md): its code was NOT updated"; }
  done
  [ -z "$SUBS_BAD" ]
}
sub_used() { case " $SUBS " in *" $1 "*) return 0;; esac; return 1; }
# files that changed in the Green Start submodule between two main-repo commits (paths start with green-start-app/, like before it was a submodule)
gs_changed_files() {   # old_main_commit new_main_commit
  local o="" n; [ -n "$1" ] && o=$(g rev-parse -q --verify "$1:green-start-app" 2>/dev/null); n=$(g rev-parse -q --verify "$2:green-start-app" 2>/dev/null)
  [ -n "$n" ] || return 0
  if [ -n "$o" ] && git -C "$SRC/green-start-app" cat-file -e "$o^{commit}" 2>/dev/null; then git -C "$SRC/green-start-app" diff --name-only "$o" "$n"
  else git -C "$SRC/green-start-app" ls-tree -r --name-only "$n"; fi | sed 's#^#green-start-app/#'
}

# STEP 1b: the main repo follows the newest commit of each sub repo (branch $SUBBRANCH), so a push to Green Start or to the Job Portal reaches the
# main repo and then this server by itself. Only a change to something that gets deployed moves the pin (docs / notes do not).
# Only the MAIN repo is written to (a one-line pointer commit); the sub repos are only read.
sg() { git -C "$SRC/$1" "${@:2}"; }                                                 # sg <submodule folder> <git args...>
deployable() {   # <submodule folder> : keeps (from stdin) the file paths whose change must reach the VPS
  if [ "$1" = "green-start-app" ]; then grep -E '^green-start-app/(gs-api|green-start-web)/'; else grep -Ev '/(docs|\.claude)/|\.md$'; fi
}
bump_subs() {
  local s cur latest files moved=""
  for s in $SUBS; do
    [ -e "$SRC/$s/.git" ] || continue
    sg "$s" fetch --quiet origin "$SUBBRANCH" 2>>"$LOG" || { log "cannot reach the repo of $s (offline?) - will try again"; continue; }
    cur=$(sg "$s" rev-parse HEAD); latest=$(sg "$s" rev-parse "origin/$SUBBRANCH")
    [ "$cur" = "$latest" ] && continue
    sg "$s" merge-base --is-ancestor "$cur" "$latest" 2>/dev/null || { log "$s: the commit the main repo pins is not an ancestor of $SUBBRANCH in its repo - left alone"; continue; }
    files=$(sg "$s" diff --name-only "$cur" "$latest" | sed "s#^#$s/#" | deployable "$s")
    [ -n "$files" ] || continue                  # only docs / notes changed: the main repo keeps its pin
    if [ "$DRY" = 1 ]; then log "[dry-run] would move the pin of $s from ${cur:0:8} to ${latest:0:8} ($(echo "$files" | wc -l) deployable file(s))"; continue; fi
    sg "$s" checkout --quiet --detach "$latest" && g add "$s" && moved="$moved ${s##*/}@${latest:0:7}"
  done
  [ -n "$moved" ] || return 0
  g commit -q -m "Update submodule(s):$moved" || return 0
  if ! g pull --quiet --rebase origin "$BRANCH" 2>>"$LOG"; then
    g rebase --abort 2>/dev/null; g reset --hard --quiet "origin/$BRANCH"; sync_subs
    log "could not move the pin(s) now (the main repo changed at the same moment) - will try again"; return 1
  fi
  if g push --quiet origin "$BRANCH" 2>>"$LOG"; then log "the main repo now pins:$moved"
  else g reset --hard --quiet "origin/$BRANCH"; sync_subs; log "push failed (offline?) - will try again"; return 1; fi
  sync_subs
}

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
# A relative require() whose file name differs only by letter case works on Windows and crashes on Linux ("Cannot find module './routes/followUps'").
# Run on the VPS BEFORE the app is stopped: any relative require() in backend/src that does not resolve here stops the deploy.
cat > "$STATE/check-requires.js" <<'EOF'
const fs = require('fs'), path = require('path');
let bad = 0;
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const resolves = (t) => [t, t + '.js', t + '.cjs', t + '.json', t + '.node'].some(isFile) || (isDir(t) && (isFile(path.join(t, 'index.js')) || isFile(path.join(t, 'package.json'))));
const check = (f) => {
  const s = fs.readFileSync(f, 'utf8'), re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(s))) if (!resolves(path.resolve(path.dirname(f), m[1]))) { console.log(f + ': cannot find ' + m[1]); bad++; }
};
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.c?js$/.test(e.name)) check(p); } };
walk(process.argv[2] || 'src');
if (bad) { console.log(bad + ' relative require(s) point at a file that does not exist here (a letter-case difference?)'); process.exit(1); }
EOF

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
  case "$repo" in   # a sub repo belongs to another GitHub account: report once per change, never commit it into this repo
    job-portal-app/job_portal-main*|green-start-app*)
      local h; h=$(echo "$list" | md5sum | cut -c1-12)
      if [ "$(cat "$STATE/subedit-$app" 2>/dev/null)" != "$h" ]; then
        [ "$DRY" = 1 ] || echo "$h" > "$STATE/subedit-$app"
        alert "edited on the VPS ($app): $(echo "$list" | wc -l) file(s) in the sub repo $repo - NOT pushed (separate GitHub repo). Copy the change into that repo by hand: $(echo "$list" | head -3 | tr '
' ' ')"
      fi
      return 0 ;;
  esac
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
  sync_subs || true      # (the sub repos' folders are only read here: their VPS edits are reported, not pushed)
  [ "$VPS_EDITS" = 1 ] || return 0       # one-way mode: nothing edited on the VPS is sent to GitHub
  EDITS_FOUND=0
  collect_edits teamlink-backend  "$LIVE/backend"  backend  "$STATE/exclude-backend.txt"
  collect_edits teamlink-frontend "$LIVE/frontend" frontend "$STATE/exclude-frontend.txt"
  collect_edits jobportal-main    "$LIVE/job-portal-app/job_portal-main" job-portal-app/job_portal-main "$STATE/exclude-portal.txt"
  collect_edits jobportal-embed   "$LIVE/job-portal-app/embed" job-portal-app/embed "$STATE/exclude-portal.txt"
  collect_edits greenstart-api    "$GS/gs-api"          green-start-app/gs-api          "$STATE/exclude-gs.txt"
  collect_edits greenstart-web    "$GS/green-start-web" green-start-app/green-start-web "$STATE/exclude-gs.txt"
  collect_edits greenstart-run    "$GS/run"             green-start-helpers/run         "$STATE/exclude-gs.txt"   # TeamLink-owned helper files (not in the Green Start repo)
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

# The Job Portal records a checksum of every migration file it applied (and refuses to start if one "was edited after being applied").
# So a migration file that is the same as the one on the VPS except for its line endings (CRLF from a Windows upload vs LF from git) keeps the
# bytes it has on the VPS. New migration files come from the package as they are.
keep_live_migration_bytes() {   # package_migrations_dir  live_migrations_dir
  local pd=$1 ld=$2 rel kept=0
  [ -d "$pd" ] && [ -d "$ld" ] || return 0
  while IFS= read -r rel; do
    [ -f "$ld/$rel" ] || continue
    cmp -s "$pd/$rel" "$ld/$rel" && continue
    if diff -q --strip-trailing-cr "$pd/$rel" "$ld/$rel" >/dev/null 2>&1; then cp -p "$ld/$rel" "$pd/$rel"; kept=$((kept+1)); fi
  done < <(cd "$pd" && find . -name '*.sql' | sed 's#^\./##')
  [ "$kept" -gt 0 ] && log "kept the VPS line endings of $kept already-applied migration file(s) in ${pd##*/job-portal-app/}"
  return 0
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
  local reqs; reqs=$(cd "$PKG/backend" && node "$STATE/check-requires.js" src 2>&1) || { alert "package check failed: the new backend would crash on start (nothing was stopped): $(echo "$reqs" | head -3 | tr '\n' ' ')"; return 1; }
  [ "$portal" = 1 ] && keep_live_migration_bytes "$PKG/job-portal-app/job_portal-main/supabase/migrations" "$LIVE/job-portal-app/job_portal-main/supabase/migrations"
  if [ "$DRY" = 1 ]; then log "[dry-run] TeamLink package built: backend $(du -sh "$PKG/backend" | cut -f1), frontend $(du -sh "$PKG/frontend" | cut -f1), portal=$portal. Nothing was stopped or replaced."; return 0; fi

  step="backup"
  mkdir -p "$BK" && cp "$LIVE/backend/prisma/dev.db" "$BK/dev.db" && for f in dev.db-wal dev.db-shm; do if [ -f "$LIVE/backend/prisma/$f" ]; then cp "$LIVE/backend/prisma/$f" "$BK/$f"; fi; done && cp "$LIVE/backend/.env" "$BK/.env" || { alert "backup failed: deploy stopped"; return 1; }
  local UPL; UPL=$(sed -n 's/^UPLOAD_DIR=//p' "$LIVE/backend/.env" | tail -1 | tr -d '\042\047\r'); UPL=${UPL:-$HOME/.teamlink-uploads}
  [ -d "$UPL/resumes" ] && tar -czf "$BK/resumes.tar.gz" -C "$UPL" resumes
  log "TeamLink deploy of ${1:0:8} starting (backup $BK)"
  (
    set -e
    S() { echo "$1" > "$STATE/laststep"; }
    S stopping; pm2 stop "$PM2_NAME"
    # the Job Portal's own database (var/) is saved too: its migrations run when it starts, and the rollback below does not undo them
    if [ -d "$LIVE/job-portal-app/job_portal-main/var" ]; then
      # the Job Portal runs its own Postgres inside var/dev-db; it needs a few seconds to shut down after "pm2 stop". Copy it only when it is down.
      PIDF="$LIVE/job-portal-app/job_portal-main/var/dev-db/postmaster.pid"; w=0
      portal_pg_up() { [ -f "$PIDF" ] && kill -0 "$(head -1 "$PIDF" 2>/dev/null)" 2>/dev/null; }
      S "waiting for the Job Portal database to stop"
      while portal_pg_up && [ $w -lt 90 ]; do sleep 1; w=$((w+1)); done
      if portal_pg_up; then echo "the Job Portal database is still running after 90 s: not saving it, deploy stopped"; exit 1; fi
      [ $w -gt 0 ] && echo "waited ${w}s for the Job Portal database to stop"
      S "saving the Job Portal database"
      tar -czf "$BK/portal-var.tgz" -C "$LIVE/job-portal-app/job_portal-main" var || [ $? -eq 1 ]     # exit 1 = a file changed while reading; fine once Postgres is down
    fi
    OLDB="$LIVE/backend-old-$STAMP"; OLDF="$LIVE/frontend-old-$STAMP"
    mv "$LIVE/backend" "$OLDB"; mv "$LIVE/frontend" "$OLDF"
    cp -a "$PKG/backend" "$LIVE/backend"; cp -a "$PKG/frontend" "$LIVE/frontend"
    cp "$OLDB/.env" "$LIVE/backend/.env"
    # the live database is KEPT (never replaced by a deploy). WAL mode: the newest committed rows sit in dev.db-wal until a checkpoint,
    # so the -wal / -shm files go WITH it (FIX 2026-10-24: deleting them threw those rows away). TeamLink is stopped here, so they are consistent.
    rm -f "$LIVE/backend/prisma/dev.db-wal" "$LIVE/backend/prisma/dev.db-shm"
    cp "$OLDB/prisma/dev.db" "$LIVE/backend/prisma/dev.db"
    for f in dev.db-wal dev.db-shm; do if [ -f "$OLDB/prisma/$f" ]; then cp "$OLDB/prisma/$f" "$LIVE/backend/prisma/$f"; fi; done
    # whatever else lives in the old backend folder and is not part of the package (state files, extra data folders) STAYS as it was
    # (never the code folders, never node_modules; the database sidecar files were handled above)
    rsync -a --ignore-existing --exclude=node_modules --exclude=/src --exclude=/scripts --exclude=/test-fixtures --exclude=/prisma/migrations --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' "$OLDB/" "$LIVE/backend/"
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
    # the base is what is LIVE now (the package plus the data that stayed), so data files are never mistaken for VPS code edits
    rsync -ac --delete --exclude-from="$STATE/exclude-backend.txt"  "$LIVE/backend/"  "$STATE/base/teamlink-backend/"
    rsync -ac --delete --exclude-from="$STATE/exclude-frontend.txt" "$PKG/frontend/" "$STATE/base/teamlink-frontend/"
    if [ "$portal" = 1 ]; then
      rsync -ac --delete "$PKG/job-portal-app/job_portal-main/" "$STATE/base/jobportal-main/"
      [ -d "$PKG/job-portal-app/embed" ] && rsync -ac --delete "$PKG/job-portal-app/embed/" "$STATE/base/jobportal-embed/"
    fi
    ls -dt "$LIVE"/backend-old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf     # keep the 3 newest previous releases
    ls -dt /root/teamlink-backups/*-before-auto-deploy 2>/dev/null | tail -n +11 | xargs -r rm -rf     # keep the 10 newest database backups
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
  local changed; changed=$(gs_changed_files "$old" "$new")   # inside the submodule (the main repo diff would show just one pointer line)
  if [ "$DRY" = 1 ]; then log "[dry-run] Green Start: $(echo "$changed" | grep -c .) changed file(s) would be deployed"; return 0; fi
  log "Green Start deploy of ${new:0:8} starting"
  mkdir -p "$BK"
  if command -v pg_dump >/dev/null 2>&1 && [ -n "$GS_DB" ]; then
    ( set -o pipefail; runuser -u postgres -- pg_dump "$GS_DB" | gzip > "$BK/greenstart-db.sql.gz" ) 2>>"$LOG" || { alert "could not save the Green Start database ($GS_DB): its deploy was stopped"; return 1; }
    log "Green Start database saved to $BK/greenstart-db.sql.gz"
  fi
  tar -czf "$BK/gs-code.tar.gz" -C "$GS" --exclude=node_modules --exclude=.env --exclude=uploads gs-api/src gs-api/dist gs-api/package.json gs-api/package-lock.json green-start-web/src green-start-web/dist run 2>/dev/null
  (
    set -e
    local_api=$SRC/green-start-app/gs-api; local_web=$SRC/green-start-app/green-start-web; local_run=$SRC/green-start-helpers/run   # helper files: main repo, not the submodule
    rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$local_api/" "$GS/gs-api/"
    rsync -ac --exclude-from="$STATE/exclude-gs.txt" "$local_web/" "$GS/green-start-web/"
    # only the helper files that already live in run/ on the server (gate, local bind, seed scripts); the rest of run/ is for the PC
    for f in "$GS"/run/*; do b=$(basename "$f"); [ -f "$local_run/$b" ] && cp -p "$local_run/$b" "$GS/run/$b"; done
    chown -R "$GS_USER:$GS_USER" "$GS/gs-api" "$GS/green-start-web" "$GS/run"
    # (grep -q <<< , not  echo | grep -q : with "set -o pipefail" a long list makes grep quit early, echo dies of SIGPIPE and the test says "no")
    if grep -q 'gs-api/package' <<< "$changed"; then runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npm install --no-audit --no-fund"; fi
    if grep -q 'green-start-web/package' <<< "$changed"; then runuser -u "$GS_USER" -- bash -lc "cd $GS/green-start-web && npm install --no-audit --no-fund"; fi
    if grep -q 'gs-api/prisma' <<< "$changed"; then runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npx prisma generate && npx prisma migrate deploy"; fi
    if grep -q '^green-start-app/gs-api/' <<< "$changed"; then runuser -u "$GS_USER" -- bash -lc "cd $GS/gs-api && npm run build"; fi
    if grep -q '^green-start-app/green-start-web/' <<< "$changed"; then runuser -u "$GS_USER" -- bash -lc "cd $GS/green-start-web && npm run build"; fi
    systemctl restart green-start-api green-start-worker green-start-gate
  ) >>"$LOG" 2>&1
  local rc=$?
  if [ $rc -eq 0 ] && health_gs; then
    log "Green Start is healthy on ${new:0:8}"
    ls -dt "$STATE"/backups/greenstart-* 2>/dev/null | tail -n +11 | xargs -r rm -rf     # keep the 10 newest
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
  if ! sync_subs; then status "waiting: cannot read the sub repo(s)$SUBS_BAD - give the VPS read access (docs/SUBMODULES.md) or set SUBS= without it"; return 0; fi
  local paths
  if [ -z "$old" ] || ! g cat-file -e "$old^{commit}" 2>/dev/null; then paths="backend frontend job-portal-app green-start-app green-start-helpers"
  else paths=$(g diff --name-only "$old" "$new" | cut -d/ -f1 | sort -u | tr '\n' ' '); fi
  log "new commit ${new:0:8} on $BRANCH (was ${old:0:8}); changed areas: ${paths:-none}"
  local ok=1
  # NOT "func || ok=0": inside an || list bash switches set -e off for the whole function, and a failed build would go unnoticed
  if echo " $paths " | grep -Eq ' (backend|frontend|job-portal-app) '; then deploy_teamlink "$new"; [ $? -eq 0 ] || ok=0; fi
  if [ $ok = 1 ] && sub_used green-start-app && echo " $paths " | grep -Eq ' (green-start-app|green-start-helpers) '; then deploy_greenstart "$new" "$old"; [ $? -eq 0 ] || ok=0; fi
  if [ "$DRY" = 1 ]; then return 0; fi
  if [ $ok = 1 ]; then echo "$new" > "$STATE/deployed-commit"; rm -f "$STATE/failed-commit" "$STATE/ALERT"; status "deployed ${new:0:8}"; log "DONE: ${new:0:8} is live"
  else echo "$new" > "$STATE/failed-commit"; status "FAILED on ${new:0:8} (see sync.log)"; fi
}

# ---- run ---------------------------------------------------------------------------------------------------------------------------
# rebuild-gs: build + migrate + restart Green Start from the code that is in the clone NOW (everything counts as changed). For a deploy whose Green Start
# build steps were skipped. The Green Start database is dumped first (deploy_greenstart does that), a failed build puts the previous code back.
if [ "$MODE" = rebuild-gs ]; then
  g fetch --quiet origin "$BRANCH" || { log "GitHub not reachable"; exit 1; }
  sync_subs || { log "cannot read the sub repos$SUBS_BAD"; exit 1; }
  sub_used green-start-app || { log "green-start-app is not in SUBS on this server"; exit 1; }
  log "rebuild-gs: rebuilding Green Start from $(g rev-parse --short HEAD)"
  deploy_greenstart "$(g rev-parse HEAD)" ""; exit $?
fi
if [ -z "$(cat "$STATE/deployed-commit" 2>/dev/null)" ] && [ ! -d "$STATE/base/teamlink-backend" ]; then
  log "first run: recording what is on the VPS now as the starting point for edit detection"
  [ "$DRY" = 1 ] || sync_base_from_live
fi
push_vps_edits; rc=$?
if [ $rc -eq 2 ]; then status "BLOCKED: see ALERT ($STATE/ALERT). Deploys are on hold until it is resolved."; exit 0; fi
if [ "$MODE" != normal ]; then rm -f "$STATE/ALERT"; log "resolved with $MODE"; fi
[ $rc -eq 0 ] && bump_subs
deploy_if_new
