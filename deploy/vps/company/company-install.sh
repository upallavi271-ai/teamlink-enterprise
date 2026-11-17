#!/usr/bin/env bash
# ============================================================================
# COMPANY INSTALL - set up ONE separate company (its own folder, database, process, address) on this server  (docs/second-company.md)
#
#   company-install.sh --key nish --name "NISHTECHNOLOGIES INDIA PVT LTD" --domain nish.example.org \
#                      --admin-name "Full Name" --admin-email "name@company.com" [--port 4012] [--certbot-email you@x.com] [--apply]
#
#   WITHOUT --apply it only PRINTS THE PLAN and runs the read-only checks (port free, address points here, memory, disk). Nothing is changed.
#   WITH --apply it does, in this order, and stops at the first problem:
#     1  checks            port free, the folder / pm2 name / nginx site are new, the domain points at this server, enough memory and disk
#     2  folders + settings  /opt/company-<key>/..., its own secrets (random), its own folders for uploads and backups   (mode 600)
#     3  release           company-deploy.sh builds the commit TeamLink last deployed OK, next to nothing live (there is nothing live yet)
#     4  settings check    scripts/company-check.js: the copy shares NOTHING with TeamLink (port, secrets, folders, Green Start, Job Portal)
#     5  database          scripts/company-init.js: empty database, the one Super Admin, a ONE-TIME password link in a private file
#     6  process           pm2 start (its own name), pm2 save
#     7  address           ONE new nginx site for the domain (the existing sites are not edited), nginx -t, reload, then HTTPS with certbot
#     8  follower          systemd timer: a newer release that TeamLink deployed OK reaches this company too, within a few minutes
#   Not touched, ever: /opt/teamlink-enterprise, /opt/green-start, TeamLink's database, any existing nginx site, TeamLink's pm2 process.
# ============================================================================
set -uo pipefail

KEY=""; NAME=""; DOMAIN=""; ADMIN_NAME=""; ADMIN_EMAIL=""; PORT=4012; APPLY=0; CERT_EMAIL=""; STEPS="2,3,4,5,6,7,8"; FROM_DIR=""; LABEL=""; NO_DNS_CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY=$2; shift 2 ;; --name) NAME=$2; shift 2 ;; --domain) DOMAIN=$2; shift 2 ;;
    --admin-name) ADMIN_NAME=$2; shift 2 ;; --admin-email) ADMIN_EMAIL=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;; --certbot-email) CERT_EMAIL=$2; shift 2 ;; --apply) APPLY=1; shift ;;
    --steps) STEPS=$2; shift 2 ;; --no-dns-check) NO_DNS_CHECK=1; shift ;; --from-dir) FROM_DIR=$2; shift 2 ;; --label) LABEL=$2; shift 2 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done
bad() { echo "STOPPED: $*"; exit 2; }
want() { [[ ",$STEPS," == *",$1,"* ]]; }   # --steps 2,3,4,5,6 does only those (for example: everything except the web address, which needs DNS first)
[[ "$KEY" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || bad "--key must be a short lower-case name, for example nish"
[ -n "$NAME" ] || bad "--name is required"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || bad "--domain is required, for example nish.example.org"
[ -n "$ADMIN_NAME" ] && [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$ ]] || bad "--admin-name and --admin-email are required"
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] || bad "--port must be a number"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=${ROOT:-/opt/company-$KEY}
SRC=${SRC:-/opt/teamlink-src}
TL_STATE=${TL_STATE:-/opt/teamlink-sync}
TL_ENV=${TL_ENV:-/opt/teamlink-enterprise/backend/.env}
PM2_NAME=company-$KEY
SITE=${SITE_DIR:-/etc/nginx/sites-available}/company-$KEY.conf
SITE_LINK=${SITE_ENABLED_DIR:-/etc/nginx/sites-enabled}/company-$KEY.conf
BASE_URL=https://$DOMAIN
say() { echo; echo "== $*"; }
step() { if [ $APPLY = 1 ]; then echo "-- $*"; else echo "PLAN: $*"; fi; }
fail() { echo "STOPPED: $*"; exit 1; }

say "1  checks (read only)"
[ -d "$SRC/.git" ] || fail "TeamLink's clone $SRC was not found"
if [ -n "$FROM_DIR" ]; then COMMIT=${LABEL:-manual}; echo "release to install: the tested copy in $FROM_DIR (label $COMMIT), not a commit of TeamLink's clone"
else
  COMMIT=$(cat "$TL_STATE/deployed-commit" 2>/dev/null) || true
  [ -n "${COMMIT:-}" ] || fail "$TL_STATE/deployed-commit is empty: TeamLink has not deployed anything yet"
  echo "release to install: ${COMMIT:0:8} (the commit TeamLink last deployed successfully)"
fi
if want 2 && [ -e "$ROOT" ]; then fail "$ROOT already exists: this company is already installed (or half installed). Look at it first; this script will not overwrite it."; fi
if want 6 && pm2 describe "$PM2_NAME" >/dev/null 2>&1; then fail "a pm2 process called $PM2_NAME already exists"; fi
if want 7 && { [ -e "$SITE" ] || [ -e "$SITE_LINK" ]; }; then fail "nginx site $SITE already exists"; fi
if want 6 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$PORT$"; then fail "port $PORT is already in use on this server (ss -ltn). Choose another with --port"; fi
echo "steps chosen: $STEPS. Port $PORT, $ROOT, the pm2 name $PM2_NAME and the nginx site are checked above (only the ones these steps would create)"
MYIP=${MYIP:-$(hostname -I 2>/dev/null | awk '{print $1}')}
DNSIP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')
if [ -n "$DNSIP" ] && [ "$DNSIP" = "$MYIP" ]; then echo "$DOMAIN points at this server ($DNSIP)"; DNS_OK=1
else echo "NOTE: $DOMAIN does not point at this server yet (it answers '${DNSIP:-nothing}', this server is ${MYIP:-unknown}). Add an A record for it, then run again."; DNS_OK=0; fi
AVAIL=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}'); echo "free memory: ${AVAIL:-?} MB (a company copy needs about 600 MB while it runs, more while building)"
DISK=$(df -m /opt 2>/dev/null | awk 'NR==2 {print $4}'); echo "free disk on /opt: ${DISK:-?} MB (needs about 3000 MB)"
if [ -n "$AVAIL" ] && [ "$AVAIL" -lt 700 ]; then echo "WARNING: low free memory: building may need swap. Look at 'free -m' before --apply."; fi
if [ -n "$DISK" ] && [ "$DISK" -lt 3000 ]; then fail "not enough free disk"; fi

want 2 && step "2  create $ROOT/{config,data/{uploads,ats-io,message-jobs,backups,qr},home,state} and config/.env with new random secrets (mode 600)"
want 3 && step "3  build release ${COMMIT:0:8} into $ROOT/backend + $ROOT/frontend (company-deploy.sh $KEY --no-start)"
want 4 && step "4  run scripts/company-check.js on the new settings (must pass every line)"
want 5 && step "5  create the empty database + the Super Admin $ADMIN_NAME <$ADMIN_EMAIL> (company-init.js); the one-time password link goes to $ROOT/config/first-login.txt (mode 600)"
want 6 && step "6  start pm2 process $PM2_NAME on port $PORT, pm2 save"
want 7 && step "7  nginx site $SITE for $DOMAIN (one new file), nginx -t, reload, then certbot HTTPS"
want 8 && step "8  systemd timer company-sync@$KEY.timer (a newer TeamLink release follows within about 5 minutes)"
if [ $APPLY = 0 ]; then echo; echo "That was only the plan. Nothing was changed. Run again with --apply to do it."; exit 0; fi
if want 7 && [ $DNS_OK = 0 ] && [ $NO_DNS_CHECK = 0 ]; then fail "the domain does not point at this server yet; nothing was changed. Add the A record first, or leave step 7 out with --steps 2,3,4,5,6"; fi

if want 2; then
say "2  folders and settings"
mkdir -p "$ROOT"/config "$ROOT"/data/{uploads,ats-io,message-jobs,backups,qr} "$ROOT"/home "$ROOT"/state "$ROOT"/logs
chmod 700 "$ROOT/config" "$ROOT/home"
rand() { openssl rand -hex 32; }
cat > "$ROOT/config/.env" <<EOF
# ${NAME} - its OWN settings. Secrets are random and belong to this company only. Written by company-install.sh $(date +%F).
COMPANY_KEY=$KEY
NODE_ENV=production
PORT=$PORT
DATABASE_URL="file:$ROOT/data/$KEY.db"
JWT_SECRET=$(rand)
INTEGRATION_SECRET_KEY=$(rand)
AGREEMENT_LINK_SECRET=$(rand)
OFFER_LINK_SECRET=$(rand)
PREP_LINK_SECRET=$(rand)
LMS_MEDIA_SECRET=$(rand)
PARTNER_JWT_SECRET=$(rand)
VENDOR_JWT_SECRET=$(rand)
APP_BASE_URL=$BASE_URL
FRONTEND_URL=$BASE_URL
CORS_ORIGINS=$BASE_URL
TRUST_PROXY=loopback
# every folder this company writes to is its own (the defaults would be TeamLink's, under the shared home folder)
UPLOAD_DIR=$ROOT/data/uploads
ATS_IO_DIR=$ROOT/data/ats-io
MESSAGE_JOB_DIR=$ROOT/data/message-jobs
BACKUP_DIR=$ROOT/data/backups
TL_QR_SESSION_DIR=$ROOT/data/qr
AI_VOICE_LIVE_FILE=$ROOT/state/live-calls
# TeamLink's neighbours on this server are NOT used by this company
GREENSTART_ENABLED=false
GREENSTART_SUPERVISE=false
GREENSTART_AUTOSTART=false
JOB_PORTAL_EMBED=0
JOB_PORTAL_SYNC_INTERVAL_MS=0
FACE_WORKERS=1
EOF
chmod 600 "$ROOT/config/.env"
printf 'VITE_BRAND_NAME=%q\n' "$NAME" > "$ROOT/config/brand.env"
cat > "$ROOT/ecosystem.config.js" <<EOF
module.exports = { apps: [{
  name: '$PM2_NAME', cwd: '$ROOT/backend', script: 'src/index.js',
  env: { HOME: '$ROOT/home', NODE_ENV: 'production' },
  max_memory_restart: '900M', autorestart: true, kill_timeout: 10000,
  out_file: '$ROOT/logs/out.log', error_file: '$ROOT/logs/error.log', time: true,
}] };
EOF

fi

if want 3; then
say "3  release"
if [ -n "$FROM_DIR" ]; then DEPLOY_ARGS=(--from-dir "$FROM_DIR" --label "$COMMIT"); else DEPLOY_ARGS=("$COMMIT"); fi
ROOT=$ROOT SRC=$SRC TL_STATE=$TL_STATE bash "$HERE/company-deploy.sh" "$KEY" "${DEPLOY_ARGS[@]}" --no-start || fail "the release could not be built (see $ROOT/state/deploy.log). Nothing is running yet."

fi

if want 4; then
say "4  settings check"
( cd "$ROOT/backend" && node scripts/company-check.js --env "$ROOT/config/.env" --home "$ROOT/home" --teamlink-env "$TL_ENV" --port-free ) || fail "the settings check failed: this copy would share something with TeamLink. Nothing was started."

fi

if want 5; then
say "5  database and Super Admin"
( cd "$ROOT/backend" && set -a && . "$ROOT/config/.env" && set +a && HOME="$ROOT/home" node scripts/company-init.js --key "$KEY" --name "$NAME" --admin-name "$ADMIN_NAME" --admin-email "$ADMIN_EMAIL" --app-url "$BASE_URL" --link-file "$ROOT/config/first-login.txt" --strict ) || fail "the database could not be created. Nothing was started."

fi

if want 6; then
say "6  process"
pm2 start "$ROOT/ecosystem.config.js" || fail "pm2 could not start $PM2_NAME"
ok=0; for i in $(seq 1 18); do if curl -s -m 4 "http://127.0.0.1:$PORT/api/health" | grep -q "\"company\":\"$KEY\""; then ok=1; break; fi; sleep 5; done
[ $ok = 1 ] || { pm2 delete "$PM2_NAME" >/dev/null 2>&1; fail "it did not answer /api/health with company \"$KEY\" (see $ROOT/logs/error.log). It was stopped and removed from pm2."; }
pm2 save >/dev/null
echo "$COMMIT" > "$ROOT/state/deployed-commit"

fi

if want 7; then
say "7  address"
cat > "$SITE" <<EOF
# ${NAME} - written by company-install.sh. Its own site; no other nginx file was edited.
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 50m;
    root $ROOT/frontend/dist;
    index index.html;
    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
    location / { try_files \$uri /index.html; }
}
EOF
ln -s "$SITE" "$SITE_LINK"
if nginx -t 2>&1; then systemctl reload nginx; else rm -f "$SITE_LINK" "$SITE"; fail "nginx did not accept the new site; it was removed and nginx was not reloaded. The company's server is running on port $PORT but has no address yet."; fi
if [ $DNS_OK = 0 ]; then echo "NOTE: $DOMAIN does not point at this server yet, so HTTPS was NOT requested. The site answers on http only for that name. When the A record exists run: certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect"
elif command -v certbot >/dev/null 2>&1; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect ${CERT_EMAIL:+-m "$CERT_EMAIL"} || echo "NOTE: certbot did not finish (it may need --certbot-email). The site works on http://$DOMAIN; run: certbot --nginx -d $DOMAIN"
else echo "NOTE: certbot is not installed; the site works on http://$DOMAIN only."; fi

fi

if want 8; then
say "8  follower"
install -m 644 "$HERE/company-sync@.service" /etc/systemd/system/company-sync@.service
install -m 644 "$HERE/company-sync@.timer" /etc/systemd/system/company-sync@.timer
install -d /opt/company-sync
install -m 755 "$HERE/company-sync.sh" /opt/company-sync/company-sync.sh
install -m 755 "$HERE/company-deploy.sh" /opt/company-sync/company-deploy.sh
systemctl daemon-reload && systemctl enable --now "company-sync@$KEY.timer"

fi

say "DONE"
echo "Company '$NAME' is running as pm2 process $PM2_NAME on port $PORT, address $BASE_URL"
echo "The Super Admin's one-time password link is in $ROOT/config/first-login.txt (private; delete it once the password is chosen)."
echo "Check anytime:  node $ROOT/backend/scripts/company-check.js --env $ROOT/config/.env --home $ROOT/home --teamlink-env $TL_ENV"
