#!/usr/bin/env bash
# ============================================================================
# COMPANY GREEN START INSTALL - give ONE separate company its OWN Omni-Channel (Green Start) (docs/second-company.md section 12).
#
#   bash company-green-install.sh --key nish --domain omni.nish.teamlinks.in --stage prepare            plan only
#   bash company-green-install.sh --key nish --domain omni.nish.teamlinks.in --stage prepare --apply    do it
#   ... --stage start  --apply     start it (needs the company's own sending mailbox: company-green-smtp.sh)
#   ... --stage public --apply     the web address + certificate + the company's server learns about it (needs the DNS record for the address)
#
# WHAT IT IS: Green Start is a separate program (NestJS + its own PostgreSQL database + Redis). TeamLink runs one. A company gets a SECOND, completely separate set:
#   its own database + database login    greenstart_<key> / gs_<key>   (a new database in the same PostgreSQL server; TeamLink's database is never opened)
#   its own Redis                        its own port, its own password, its own folder
#   its own settings and secrets         /opt/company-<key>/green/config/gs-api.env   (mode 640; nothing is copied from TeamLink's Green Start)
#   its own API + background worker      green-start-<key>-api (port 4021), green-start-<key>-worker, green-start-<key>-redis (port 6380)
#   its own uploads                      /opt/company-<key>/green/uploads
# The PROGRAM FILES (gs-api/dist, the built website) are TeamLink's own read-only copy: the same program, so a Green Start update reaches both
# (company-green-sync.sh migrates the company's database and restarts its services after TeamLink's own deploy has finished).
# TeamLink's Green Start (its services, database, settings, address) is only READ, never changed. Nothing here edits another nginx site.
#
# STAGES: prepare = checks, database, Redis, folders, settings, migrations, services installed but NOT started (needs nothing from outside);
#         start   = starts them (refuses until the company's own mailbox is in the settings: Green Start will not run as a real server without one);
#         public  = the company's own web address in nginx + certificate (certbot) + the company's server is switched to its own Green Start.
# ============================================================================
set -uo pipefail

KEY=""; DOMAIN=""; STAGE=prepare; APPLY=0; API_PORT=4021; REDIS_PORT=6380
while [ $# -gt 0 ]; do case "$1" in
  --key) KEY=${2:-}; shift ;; --domain) DOMAIN=${2:-}; shift ;; --stage) STAGE=${2:-}; shift ;; --apply) APPLY=1 ;;
  --api-port) API_PORT=${2:-}; shift ;; --redis-port) REDIS_PORT=${2:-}; shift ;;
  *) echo "unknown option $1"; exit 2 ;; esac; shift; done
[[ "$KEY" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "usage: company-green-install.sh --key <key> --domain <address> --stage prepare|start|public [--apply]"; exit 2; }
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || { echo "--domain is required: the company's own address for Omni-Channel, for example omni.nish.teamlinks.in"; exit 2; }
[[ "$STAGE" =~ ^(prepare|start|public)$ ]] || { echo "--stage must be prepare, start or public"; exit 2; }
[[ "$API_PORT" =~ ^[0-9]+$ && "$REDIS_PORT" =~ ^[0-9]+$ ]] || { echo "ports must be numbers"; exit 2; }

ROOT=/opt/company-$KEY; G=$ROOT/green; CFG=$G/config; ENVF=$CFG/gs-api.env; REDISCONF=$CFG/redis.conf
CENV=$ROOT/config/.env
GS=/opt/green-start
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
U_API=green-start-$KEY-api; U_WORKER=green-start-$KEY-worker; U_REDIS=green-start-$KEY-redis
DBNAME=greenstart_${KEY//-/_}; DBROLE=gs_${KEY//-/_}
PM2_NAME=company-$KEY
STAMP=$(date +%Y%m%d-%H%M%S)
TL_ENV=${TL_ENV:-/opt/teamlink-enterprise/backend/.env}
fail() { echo "STOPPED: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
[ "$API_PORT" != 4020 ] && [ "$REDIS_PORT" != 6379 ] || fail "ports 4020 / 6379 belong to TeamLink's Green Start; choose others"
genv() { sed -n "s/^$1=//p" "$ENVF" 2>/dev/null | tail -1 | tr -d '"\047\r'; }
cenv() { sed -n "s/^$1=//p" "$CENV" 2>/dev/null | tail -1 | tr -d '"\047\r'; }
setv() { local f=$1 k=$2 v=$3; if grep -q "^$k=" "$f"; then sed -i "s#^$k=.*#$k=$v#" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi; }
portfree() { ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }
hex() { openssl rand -hex "$1"; }

# ---------------------------------------------------------------------------------------------------------------------------------- checks
step "1  checks (read only)"
[ "$(id -u)" = 0 ] || fail "run as root"
[ -f "$CENV" ] || fail "$CENV is missing: install the company first (company-install.sh)"
APP_PORT=$(cenv PORT); curl -s -m 5 "http://127.0.0.1:$APP_PORT/api/health" | grep -q "\"company\":\"$KEY\"" || fail "company $KEY does not answer on port $APP_PORT"
echo "company $KEY is healthy on port $APP_PORT"
[ -f "$GS/gs-api/dist/main.js" ] && [ -f "$GS/gs-api/prisma/schema.prisma" ] && [ -d "$GS/green-start-web/dist" ] || fail "TeamLink's Green Start program files were not found in $GS"
id greenstart >/dev/null 2>&1 || fail "the Linux user 'greenstart' does not exist"
systemctl is-active --quiet postgresql@16-main || fail "PostgreSQL 16 (cluster main) is not running"
command -v redis-server >/dev/null || fail "redis-server is not installed"
echo "TeamLink's Green Start: api $(systemctl is-active green-start-api), worker $(systemctl is-active green-start-worker) (only looked at, never changed)"
INSTALLED=0; [ -f "$ENVF" ] && INSTALLED=1
if [ $INSTALLED = 1 ]; then
  API_PORT=$(genv PORT); REDIS_PORT=$(genv REDIS_URL | sed -E 's#.*:([0-9]+)$#\1#'); echo "this company already has Green Start settings (api port $API_PORT, redis port $REDIS_PORT): they are kept"
else
  portfree "$API_PORT" || fail "port $API_PORT is in use"; portfree "$REDIS_PORT" || fail "port $REDIS_PORT is in use"; echo "ports $API_PORT and $REDIS_PORT are free"
fi
free=$(df -Pm /opt | awk 'NR==2{print $4}'); [ "${free:-0}" -ge 3000 ] || fail "only ${free} MB free on /opt (needs about 3000 MB)"
avail=$(free -m | awk 'NR==2{print $7}'); [ "${avail:-0}" -ge 1500 ] || fail "only ${avail} MB of memory is free (needs about 1500 MB for the three services)"
echo "free disk ${free} MB, free memory ${avail} MB"

if [ $APPLY = 0 ]; then
  echo; echo "PLAN ($STAGE): $(case $STAGE in prepare) echo "database $DBNAME + login $DBROLE, Redis on $REDIS_PORT, folders and settings in $G, migrations, services $U_API / $U_WORKER / $U_REDIS installed (not started)";; start) echo "start $U_REDIS, $U_API, $U_WORKER and check them (needs the company's own mailbox in the settings)";; public) echo "nginx site for $DOMAIN, certificate, GREENSTART_* settings of company-$KEY, restart of company-$KEY only";; esac)"
  echo "That was only the plan. Nothing was changed. Run again with --apply to do it."; exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------------------- stages
if [ "$STAGE" = prepare ]; then
  step "2  the company's own database and database login"
  PGPW=$(hex 24)
  if ! sudo -u postgres psql -Atc "select 1 from pg_roles where rolname='$DBROLE'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -qc "create role $DBROLE login password '$PGPW'" || fail "could not create the database login"
    echo "database login $DBROLE created"
  else echo "database login $DBROLE already exists"; [ $INSTALLED = 1 ] || fail "$DBROLE exists but this company has no settings file: refusing to guess its password; remove the login by hand if it is a leftover"; fi
  if ! sudo -u postgres psql -Atc "select 1 from pg_database where datname='$DBNAME'" | grep -q 1; then
    sudo -u postgres createdb -O "$DBROLE" "$DBNAME" || fail "could not create the database"; echo "database $DBNAME created (empty)"
  else echo "database $DBNAME already exists"; fi
  sudo -u postgres psql -qc "revoke connect on database $DBNAME from public" >/dev/null 2>&1 || true

  step "3  folders, Redis settings, Green Start settings"
  mkdir -p "$G/gs-api" "$G/uploads" "$G/redis" "$G/state" "$CFG"
  for l in dist node_modules package.json prisma; do ln -sfn "$GS/gs-api/$l" "$G/gs-api/$l"; done      # program files: TeamLink's read-only copy; NO .env in this folder
  [ ! -e "$G/gs-api/.env" ] || fail "$G/gs-api/.env must not exist (it would be read next to the company's own settings)"
  if [ $INSTALLED = 0 ]; then
    RPW=$(hex 24)
    umask 077
    cat > "$ENVF" <<EOF
# The company's OWN Green Start (Omni-Channel). Written $(date '+%F') by company-green-install.sh. Every secret here is this company's own;
# nothing is copied from TeamLink's Green Start. Never send this file anywhere.
NODE_ENV=production
APP_MODE=production
PORT=$API_PORT
APP_URL=https://$DOMAIN
CORS_ORIGINS=https://$DOMAIN
MEDIA_PUBLIC_URL=https://$DOMAIN
DATABASE_URL=postgresql://$DBROLE:$PGPW@127.0.0.1:5432/$DBNAME?schema=public
REDIS_URL=redis://:$RPW@127.0.0.1:$REDIS_PORT
JWT_SECRET=$(hex 32)
ENCRYPTION_KEY=$(hex 32)
CONSENT_SUPPRESSION_SALT=$(hex 32)
OPS_REPORT_TOKEN=$(hex 32)
META_WEBHOOK_VERIFY_TOKEN=$(hex 24)
TEAMLINK_SSO_SECRET=$(hex 32)
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=$G/uploads
BRAND_NAME=Green Start
SIGNUP_MODE=approve_each
AUTH_EMAIL_DELIVERY=smtp
META_GRAPH_VERSION=v25.0
META_ADS_AUTO_REFRESH=false
SHOPIFY_AUTO_SYNC=false
SMSPUSH_DLR_PULL=off
# The company's own sending mailbox (run company-green-smtp.sh; Green Start will not start as a real server without it)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
EOF
    umask 022
    cat > "$REDISCONF" <<EOF
# The company's own Redis for Green Start (queues, sessions). Port $REDIS_PORT, this computer only.
port $REDIS_PORT
bind 127.0.0.1
protected-mode yes
requirepass $RPW
dir $G/redis
appendonly yes
save ""
maxmemory 256mb
maxmemory-policy noeviction
EOF
    echo "settings and Redis settings written (secrets are random and stay in $CFG)"
  else echo "settings already exist: kept"; RPW=$(genv REDIS_URL | sed -E 's#^redis://:([^@]*)@.*#\1#'); fi
  chown -R greenstart:greenstart "$G/uploads" "$G/redis" "$G/state"; chown root:greenstart "$G" "$G/gs-api" "$CFG" "$ENVF" "$REDISCONF"; chmod 750 "$G" "$CFG"; chmod 640 "$ENVF" "$REDISCONF"; chmod 755 "$G/gs-api"
  # the company's own settings must never name TeamLink's Green Start
  grep -qE "127\.0\.0\.1:6379|:4020\b" "$ENVF" && fail "the settings mention a TeamLink Green Start port: refusing"

  step "4  database tables (migrations of THIS database only)"
  ( cd "$G/gs-api" && runuser -u greenstart -- env -i PATH="$PATH" HOME="$G" DATABASE_URL="$(genv DATABASE_URL)" node node_modules/prisma/build/index.js migrate deploy 2>&1 | tail -4 ) || fail "the migrations failed"
  TABLES=$(sudo -u postgres psql -d "$DBNAME" -Atc "select count(*) from information_schema.tables where table_schema='public'")
  TLTABLES=$(sudo -u postgres psql -d greenstart -Atc "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null)
  echo "tables in $DBNAME: $TABLES (TeamLink's Green Start database has $TLTABLES)"; [ "${TABLES:-0}" -gt 100 ] || fail "too few tables were made"
  ROWS=$(sudo -u postgres psql -d "$DBNAME" -Atc "select coalesce(sum(n_live_tup),0) from pg_stat_user_tables")
  echo "rows in the new database (what the program itself installs, no company data): $ROWS"

  step "5  services installed, NOT started"
  cat > /etc/systemd/system/$U_REDIS.service <<EOF
[Unit]
Description=Green Start of company $KEY: its own Redis (port $REDIS_PORT, 127.0.0.1 only)
After=network-online.target
[Service]
Type=simple
User=greenstart
Group=greenstart
ExecStart=/usr/bin/redis-server $REDISCONF
Restart=on-failure
RestartSec=3
MemoryMax=320M
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$G
SyslogIdentifier=$U_REDIS
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/$U_API.service <<EOF
[Unit]
Description=Green Start of company $KEY: API (NestJS, port $API_PORT, 127.0.0.1 only)
After=network-online.target postgresql.service $U_REDIS.service
Wants=postgresql.service $U_REDIS.service
StartLimitIntervalSec=600
StartLimitBurst=8
[Service]
Type=simple
User=greenstart
Group=greenstart
WorkingDirectory=$G/gs-api
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node --max-old-space-size=512 --require $GS/run/bind-local.cjs dist/main
Restart=on-failure
RestartSec=5
OOMScoreAdjust=300
MemoryHigh=640M
MemoryMax=768M
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$G
SyslogIdentifier=$U_API
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/$U_WORKER.service <<EOF
[Unit]
Description=Green Start of company $KEY: worker (campaign sender, background jobs; no port)
After=network-online.target postgresql.service $U_REDIS.service $U_API.service
Wants=postgresql.service $U_REDIS.service
StartLimitIntervalSec=600
StartLimitBurst=8
[Service]
Type=simple
User=greenstart
Group=greenstart
WorkingDirectory=$G/gs-api
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node --max-old-space-size=320 --require $GS/run/bind-local.cjs dist/queue/worker.bootstrap
Restart=on-failure
RestartSec=5
OOMScoreAdjust=300
MemoryHigh=448M
MemoryMax=512M
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$G
SyslogIdentifier=$U_WORKER
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable "$U_REDIS" "$U_API" "$U_WORKER" >/dev/null 2>&1
  install -d /opt/company-sync
  install -m 755 "$HERE/company-green-sync.sh" /opt/company-sync/company-green-sync.sh
  install -m 755 "$HERE/company-sync.sh" /opt/company-sync/company-sync.sh          # the 2-minute check now also calls company-green-sync.sh
  echo "installed: $U_REDIS $U_API $U_WORKER (enabled for the next boot, not started)"
  echo; echo "NEXT: the company's own sending mailbox:  bash $HERE/company-green-smtp.sh --key $KEY   then  --stage start --apply"
  echo "      and the DNS record for $DOMAIN (A -> this server), then  --stage public --apply"
  exit 0
fi

[ -f "$ENVF" ] || fail "run --stage prepare first"

if [ "$STAGE" = start ]; then
  step "2  the company's own mailbox must be set"
  for k in SMTP_HOST SMTP_USER SMTP_PASS SMTP_FROM; do [ -n "$(genv $k)" ] || fail "$k is empty in $ENVF. Run:  bash $HERE/company-green-smtp.sh --key $KEY"; done
  echo "mailbox settings are present (values not shown)"
  step "3  start Redis, the API and the worker"
  systemctl start "$U_REDIS"; sleep 2
  REDISCLI_AUTH="$(genv REDIS_URL | sed -E 's#^redis://:([^@]*)@.*#\1#')" redis-cli -p "$REDIS_PORT" ping | grep -q PONG || fail "the company's Redis does not answer (journalctl -u $U_REDIS)"
  echo "Redis answers on $REDIS_PORT"
  systemctl start "$U_API"
  ok=0; for i in $(seq 1 45); do if curl -s -m 3 "http://127.0.0.1:$API_PORT/api/v1/health" | grep -qi "ok\|up"; then ok=1; break; fi; sleep 3; done
  [ $ok = 1 ] || { journalctl -u "$U_API" -n 25 --no-pager | cut -c1-220; fail "the company's Green Start API did not come up on port $API_PORT"; }
  echo "API health: $(curl -s -m 5 "http://127.0.0.1:$API_PORT/api/v1/health" | head -c 120)"
  systemctl start "$U_WORKER"; sleep 6
  systemctl is-active --quiet "$U_WORKER" || { journalctl -u "$U_WORKER" -n 25 --no-pager | cut -c1-220; fail "the worker did not stay up"; }
  echo "worker: active"
  step "4  checks"
  echo "company's API listens on: $(ss -ltn | awk '{print $4}' | grep -E ":($API_PORT|$REDIS_PORT)$" | tr '\n' ' ') (127.0.0.1 only is right)"
  echo "TeamLink's Green Start: api $(systemctl is-active green-start-api) worker $(systemctl is-active green-start-worker)  its health: $(curl -s -m 5 http://127.0.0.1:4020/api/v1/health | head -c 60)"
  echo "memory of the company's services: $(systemctl show -p MemoryCurrent --value "$U_API" | awk '{printf "api %d MB", $1/1048576}'), $(systemctl show -p MemoryCurrent --value "$U_WORKER" | awk '{printf "worker %d MB", $1/1048576}')"
  mkdir -p "$G/state"; stat -c %Y "$GS/gs-api/dist/main.js" > "$G/state/dist-stamp"; chown greenstart:greenstart "$G/state/dist-stamp"
  echo; echo "DONE (start). NEXT: the DNS record for $DOMAIN, then  --stage public --apply"
  exit 0
fi

if [ "$STAGE" = public ]; then
  step "2  the DNS record for $DOMAIN must point at this server"
  MYIPS=" $(hostname -I) "; GOT=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | head -1)
  [ -n "$GOT" ] || fail "$DOMAIN does not resolve yet: add the DNS record (A, name omni.nish, this server's address) and wait a few minutes"
  case "$MYIPS" in *" $GOT "*) echo "$DOMAIN -> $GOT (this server)";; *) fail "$DOMAIN resolves to $GOT, which is not this server ($MYIPS)";; esac
  curl -s -m 5 "http://127.0.0.1:$API_PORT/api/v1/health" | grep -qi "ok\|up" || fail "the company's Green Start API is not running: run --stage start first"

  step "3  the company's own nginx site (ONE new file; nginx is tested before it is reloaded)"
  SITE_A=/etc/nginx/sites-available/$KEY-omni.conf; SITE_E=/etc/nginx/sites-enabled/$KEY-omni.conf
  APP_ORIGIN=$(cenv APP_BASE_URL | sed -E 's#(https?://[^/]+).*#\1#')
  if [ ! -f "$SITE_A" ]; then
    sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__API_PORT__#$API_PORT#g" -e "s#__KEY__#$KEY#g" -e "s#__ZONE__#${KEY//-/_}#g" -e "s#__COMPANY__#$KEY#g" -e "s#__APP_ORIGIN__#$APP_ORIGIN#g" "$HERE/nginx-omni.conf.tmpl" > "$SITE_A"
    ln -sfn "$SITE_A" "$SITE_E"
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx && echo "nginx reloaded with $SITE_A"; else rm -f "$SITE_E" "$SITE_A"; nginx -t 2>&1 | tail -2; fail "nginx -t failed: the new site was removed again, nothing changed"; fi
  else echo "the site file already exists: kept"; fi
  step "4  certificate (certbot) and the https redirect"
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then echo "a certificate for $DOMAIN already exists"; else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect 2>&1 | tail -4 || fail "certbot failed (is the DNS record visible from outside yet?)"
  fi
  nginx -t >/dev/null 2>&1 || fail "nginx -t failed after certbot: look at it before going on"
  echo "https://$DOMAIN/api/v1/health -> $(curl -s -m 15 "https://$DOMAIN/api/v1/health" | head -c 100)"

  step "5  the company's server learns about its own Green Start (only company-$KEY restarts)"
  cp -p "$CENV" "$CENV.bak-before-green-$STAMP"
  setv "$CENV" GREENSTART_ENABLED true
  setv "$CENV" GREENSTART_API_PORT "$API_PORT"
  setv "$CENV" GREENSTART_REDIS_PORT "$REDIS_PORT"
  setv "$CENV" GREENSTART_SSO_SECRET "$(genv TEAMLINK_SSO_SECRET)"
  setv "$CENV" GREENSTART_SUPERVISE false
  setv "$CENV" GREENSTART_AUTOSTART false
  chmod 600 "$CENV"
  EMAIL=$(cd "$ROOT/backend" && node -e '
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync((process.argv[1] || "").replace(/^file:/, ""), { readOnly: true });
const r = d.prepare("select email from User where role = ? and status = ? and email not like ? order by createdAt limit 1").get("SUPER_ADMIN", "Active", "teamlink-owner+%");
console.log(r ? r.email : "");' "$(cenv DATABASE_URL)" 2>/dev/null)
  [ -n "$EMAIL" ] || fail "could not find the company's own Super Admin"
  ( cd "$ROOT/backend" && SSO_EMAIL="$EMAIL" node -e '
require("dotenv").config();
const prisma = require("./src/db");
(async () => {
  const key = "omni.gs.ssoEmail"; const value = JSON.stringify(process.env.SSO_EMAIL);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });' ) || fail "could not store the company's Green Start account"
  echo "the company's Green Start account will be made on the first click (the Super Admin of the company)"
  PM2_HOME="${PM2_HOME:-${HOME:-/root}/.pm2}" HOME="$ROOT/home" pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || fail "pm2 could not restart $PM2_NAME"
  ok=0; for i in $(seq 1 30); do curl -s -m 3 "http://127.0.0.1:$APP_PORT/api/health" | grep -q "\"company\":\"$KEY\"" && { ok=1; break; }; sleep 3; done
  [ $ok = 1 ] || fail "company $KEY did not come back (settings backup: $CENV.bak-before-green-$STAMP)"
  step "6  checks"
  P=$(pm2 pid "$PM2_NAME" | head -1); echo "company server HOME: $(tr '\0' '\n' < /proc/$P/environ | sed -n 's/^HOME=//p')"
  ( cd "$ROOT/backend" && node scripts/company-check.js --env "$CENV" --home "$ROOT/home" --teamlink-env "$TL_ENV" 2>&1 | grep -E "^(FAIL|All checks|[0-9]+ check)" )
  echo "TeamLink: $(curl -s -m 8 http://127.0.0.1:4010/api/health)   TeamLink's Green Start site: HTTP $(curl -s -o /dev/null -m 15 -w '%{http_code}' https://greenstart.teamlinks.in/)"
  echo; echo "DONE (public). The company's Omni-Channel is at https://$DOMAIN (opened from the menu: Omni-Channel)."
  exit 0
fi
