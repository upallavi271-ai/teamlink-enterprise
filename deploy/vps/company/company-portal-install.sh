#!/usr/bin/env bash
# ============================================================================
# COMPANY PORTAL INSTALL - give ONE separate company its OWN Job Portal (docs/second-company.md section 11).
#
#   bash company-portal-install.sh --key nish --name "NISHTECHNOLOGIES INDIA PVT LTD" [--port 4324] [--pg-port 5435]            plan only
#   bash company-portal-install.sh --key nish --name "..." --apply                                                              do it
#
# WHAT IT DOES (in this order; it stops at the first problem; TeamLink's portal, folders and settings are only READ):
#   1  checks (read only): the company is installed and healthy, the two ports are free and are NOT TeamLink's (4323 / 5434), enough disk.
#   2  settings: the portal's own ports, folders (under /opt/company-<key>/data/job-portal), and NEW random secrets, written into the company's own
#      settings file (a dated copy is kept). JOB_PORTAL_EMBED stays 0 for now. The screens are built with the Job Portal menu (brand.env).
#   3  the portal's code and packages are put next to the company's own release (company-deploy.sh, same method as TeamLink's own deploy).
#   4  FIRST START, OFF TO THE SIDE: the portal is started once by hand (its own database folder, a throw-away password), stopped cleanly, and then
#      company-portal-init.mjs removes what the portal writes on a new database that is not this company's (a "TeamLink Consultants" company, two
#      demo logins) and gives the company's own Admin(s) a portal admin login. Only then:
#   5  JOB_PORTAL_EMBED=1 and the company's server restarts; its supervisor starts the portal (on the company's own port).
#   6  checks: the portal answers on ITS port, /jobs works through the company's address, TeamLink's portal is untouched, company-check passes.
# Taking it away: set JOB_PORTAL_EMBED=0 and pm2 restart company-<key>; the data folder data/job-portal can then be kept or deleted.
# ============================================================================
set -uo pipefail

KEY=""; NAME=""; WEB_PORT=4324; PG_PORT=5435; APPLY=0
while [ $# -gt 0 ]; do case "$1" in
  --key) KEY=${2:-}; shift ;; --name) NAME=${2:-}; shift ;; --port) WEB_PORT=${2:-}; shift ;; --pg-port) PG_PORT=${2:-}; shift ;; --apply) APPLY=1 ;;
  *) echo "unknown option $1"; exit 2 ;; esac; shift; done
[[ "$KEY" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "usage: company-portal-install.sh --key <key> --name \"<company name>\" [--port N] [--pg-port N] [--apply]"; exit 2; }
[ -n "$NAME" ] || { echo "--name is required (the company's name, shown in the portal)"; exit 2; }
[[ "$WEB_PORT" =~ ^[0-9]+$ && "$PG_PORT" =~ ^[0-9]+$ ]] || { echo "ports must be numbers"; exit 2; }

ROOT=/opt/company-$KEY; ENVF=$ROOT/config/.env; BRANDF=$ROOT/config/brand.env
TL_ENV=${TL_ENV:-/opt/teamlink-enterprise/backend/.env}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DATA=$ROOT/data/job-portal
PM2_NAME=company-$KEY
STAMP=$(date +%Y%m%d-%H%M%S)
fail() { echo "STOPPED: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
getenv() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | tr -d '"\047\r'; }
setenv() { # setenv KEY VALUE : replace the line or add it (the file is the company's own)
  if grep -q "^$1=" "$ENVF"; then sed -i "s#^$1=.*#$1=$2#" "$ENVF"; else printf '%s=%s\n' "$1" "$2" >> "$ENVF"; fi; }
portfree() { ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }

step "1  checks (read only)"
[ -f "$ENVF" ] || fail "$ENVF is missing: install the company first (company-install.sh)"
APP_PORT=$(getenv PORT); [ -n "$APP_PORT" ] || fail "PORT is not set in $ENVF"
curl -s -m 5 "http://127.0.0.1:$APP_PORT/api/health" | grep -q "\"company\":\"$KEY\"" || fail "company $KEY does not answer on port $APP_PORT"
echo "company $KEY is healthy on port $APP_PORT"
[ "$WEB_PORT" != 4323 ] && [ "$PG_PORT" != 5434 ] && [ "$WEB_PORT" != "$PG_PORT" ] || fail "ports 4323 / 5434 are TeamLink's own Job Portal; choose others"
if grep -q '^JOB_PORTAL_PORT=' "$ENVF"; then ALREADY=1; echo "this company already has Job Portal settings (port $(getenv JOB_PORTAL_PORT)): they are kept"; WEB_PORT=$(getenv JOB_PORTAL_PORT); PG_PORT=$(getenv JOB_PORTAL_PG_PORT)
else ALREADY=0; portfree "$WEB_PORT" || fail "port $WEB_PORT is in use"; portfree "$PG_PORT" || fail "port $PG_PORT is in use"; echo "ports $WEB_PORT and $PG_PORT are free"; fi
free=$(df -Pm /opt | awk 'NR==2{print $4}'); [ "${free:-0}" -ge 2000 ] || fail "only ${free} MB free on /opt (needs about 2000 MB)"
echo "free disk on /opt: ${free} MB"
WANT=$(cat /opt/teamlink-sync/deployed-commit 2>/dev/null); [ -n "$WANT" ] || fail "no deployed commit in /opt/teamlink-sync"
SUB=$(git -C /opt/teamlink-src ls-tree "$WANT" job-portal-app/job_portal-main 2>/dev/null | awk '{print $3}')
git -C /opt/teamlink-src/job-portal-app/job_portal-main cat-file -e "${SUB:-x}^{commit}" 2>/dev/null || fail "the Job Portal code that ${WANT:0:8} pins is not in TeamLink's clone"
echo "release ${WANT:0:8} pins the Job Portal commit ${SUB:0:8}"
if [ -f /opt/teamlink-enterprise/job-portal-app/run/portal.pid.json ] || curl -s -m 3 http://127.0.0.1:4323/api/health | grep -q ok; then echo "TeamLink's own portal is running on 4323 (only looked at, never touched)"; fi

if [ $APPLY = 0 ]; then
  echo; echo "PLAN: 2 settings + folders ($DATA)   3 portal code placed (company-deploy.sh)   4 first start, clean-up, admin login   5 switch on (restart of company-$KEY only)   6 checks"
  echo "That was only the plan. Nothing was changed. Run again with --apply to do it."; exit 0
fi

step "2  settings and folders"
mkdir -p "$DATA/db" "$DATA/storage" "$DATA/run"
if [ $ALREADY = 0 ]; then
  cp -p "$ENVF" "$ENVF.bak-before-portal-$STAMP"
  { printf '\n# Job Portal of THIS company (docs/second-company.md section 11): its own ports, folders and secrets. Written %s.\n' "$(date '+%F')"; } >> "$ENVF"
  setenv JOB_PORTAL_EMBED 0
  setenv JOB_PORTAL_PORT "$WEB_PORT"
  setenv JOB_PORTAL_PG_PORT "$PG_PORT"
  setenv JOB_PORTAL_RUN_DIR "$DATA/run"
  setenv JOB_PORTAL_SYNC_TOKEN "$(openssl rand -hex 32)"
  setenv JOB_PORTAL_PUSH_SECRET "$(openssl rand -hex 32)"
  setenv JOBPORTAL__AUTH_SECRET "$(openssl rand -hex 32)"
  setenv JOBPORTAL__INTEGRATION_SECRET_KEY "$(openssl rand -hex 32)"
  setenv JOBPORTAL__DEV_PASSWORD "$(openssl rand -hex 16)"
  setenv JOBPORTAL__DEV_DB_DIR "$DATA/db"
  setenv JOBPORTAL__STORAGE_LOCAL_DIR "$DATA/storage"
  chmod 600 "$ENVF"
fi
touch "$BRANDF"; grep -q '^VITE_BRAND_JOB_PORTAL=' "$BRANDF" || echo 'VITE_BRAND_JOB_PORTAL=1' >> "$BRANDF"
echo "settings written (a dated copy of the old file: $ENVF.bak-before-portal-$STAMP); names only: $(grep -oE '^(JOB_PORTAL|JOBPORTAL)[A-Z_0-9]*' "$ENVF" | sort -u | tr '\n' ' ')"

step "3  the portal's code, packages and the screens (company-deploy.sh; the company restarts for a few seconds)"
install -d /opt/company-sync
install -m 755 "$HERE/company-deploy.sh" /opt/company-sync/company-deploy.sh
install -m 755 "$HERE/company-sync.sh" /opt/company-sync/company-sync.sh
PD=$ROOT/job-portal-app/job_portal-main
if [ ! -f "$PD/tools/dev-server.mjs" ]; then
  bash /opt/company-sync/company-deploy.sh "$KEY" "$WANT" || fail "the deploy failed (see $ROOT/state/deploy.log). The company's previous release is back."
fi
[ -f "$PD/tools/dev-server.mjs" ] || fail "the portal code is not in $PD after the deploy (see $ROOT/state/deploy.log)"
echo "portal code is in place: $PD"

step "4  first start off to the side, clean-up, the company's own admin login"
DEVDB=$(getenv JOBPORTAL__DEV_DB_DIR); [ -n "$DEVDB" ] || fail "JOBPORTAL__DEV_DB_DIR is not set"
if [ ! -f "$DEVDB/PG_VERSION" ]; then
  echo "starting the portal once (new database: its migrations run, about a minute) ..."
  ( cd "$PD" && env -i PATH="$PATH" HOME="$ROOT/home" PG_PORT="$PG_PORT" DEV_DB_DIR="$DEVDB" STORAGE_LOCAL_DIR="$(getenv JOBPORTAL__STORAGE_LOCAL_DIR)" \
      AUTH_SECRET="$(getenv JOBPORTAL__AUTH_SECRET)" INTEGRATION_SECRET_KEY="$(getenv JOBPORTAL__INTEGRATION_SECRET_KEY)" DEV_PASSWORD="$(getenv JOBPORTAL__DEV_PASSWORD)" \
      nohup node tools/dev-server.mjs "$WEB_PORT" > "$DATA/first-start.log" 2>&1 & echo $! > "$DATA/first-start.pid" )
  up=0; for i in $(seq 1 120); do if curl -s -m 2 "http://127.0.0.1:$WEB_PORT/api/health" | grep -q ok; then up=1; break; fi; sleep 2; done
  kill -TERM "$(cat "$DATA/first-start.pid")" 2>/dev/null || true
  for i in $(seq 1 30); do kill -0 "$(cat "$DATA/first-start.pid")" 2>/dev/null || break; sleep 1; done
  if kill -0 "$(cat "$DATA/first-start.pid")" 2>/dev/null; then kill -KILL "$(cat "$DATA/first-start.pid")" 2>/dev/null || true; fail "the portal did not stop cleanly after its first start (see $DATA/first-start.log)"; fi
  [ $up = 1 ] || fail "the portal did not answer on its first start (see $DATA/first-start.log)"
  echo "first start done and stopped cleanly"
fi
ADMINS=$(cd "$ROOT/backend" && node -e '
const { DatabaseSync } = require("node:sqlite");
const raw = (process.argv[1] || "").replace(/^file:/, "");
const d = new DatabaseSync(raw, { readOnly: true });
const rows = d.prepare("select name, email from User where role = ? and status = ? and email not like ?").all("SUPER_ADMIN", "Active", "teamlink-owner+%");
console.log(JSON.stringify(rows.map((r) => ({ name: r.name, email: r.email }))));' "$(getenv DATABASE_URL)" 2>/dev/null)
[ -n "$ADMINS" ] && [ "$ADMINS" != "[]" ] || fail "could not read the company's own Super Admin from its database"
( cd "$PD" && env -i PATH="$PATH" HOME="$ROOT/home" DEV_DB_DIR="$DEVDB" NISH_COMPANY_NAME="$NAME" NISH_ADMINS="$ADMINS" node --input-type=module < "$HERE/company-portal-init.mjs" ) || fail "the clean-up of the new portal database failed; nothing was changed (the portal is still not switched on)"

step "5  switch on (only the company's own server restarts)"
setenv JOB_PORTAL_EMBED 1
pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || fail "pm2 could not restart $PM2_NAME"
ok=0; for i in $(seq 1 40); do if curl -s -m 3 "http://127.0.0.1:$WEB_PORT/api/health" | grep -q ok; then ok=1; break; fi; sleep 3; done
[ $ok = 1 ] || fail "the portal did not come up on port $WEB_PORT (see $DATA/run/portal.log). Set JOB_PORTAL_EMBED=0 and pm2 restart $PM2_NAME to switch it off again."

step "6  checks"
echo "company health:   $(curl -s -m 5 "http://127.0.0.1:$APP_PORT/api/health")"
echo "portal health:    $(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/api/health" | head -c 120)"
echo "/jobs through the company's address: HTTP $(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$APP_PORT/jobs/")"
PPID_=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$DATA/run/portal.pid.json" 2>/dev/null)
[ -n "$PPID_" ] && echo "the company's portal process $PPID_ runs from: $(readlink "/proc/$PPID_/cwd")"
echo "TeamLink's portal (4323): $(curl -s -m 5 http://127.0.0.1:4323/api/health | head -c 60)   TeamLink: $(curl -s -m 5 http://127.0.0.1:4010/api/health)"
( cd "$ROOT/backend" && node scripts/company-check.js --env "$ENVF" --home "$ROOT/home" --teamlink-env "$TL_ENV" 2>&1 | grep -E "^(FAIL|All checks|[0-9]+ check)" )
echo; echo "DONE. The company's own Job Portal is on: $(getenv APP_BASE_URL)/jobs  (staff open it from the menu: Job Portal)."
