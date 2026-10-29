#!/usr/bin/env bash
# ============================================================================
# LET THE LIVE JOB PORTAL SAVE MAILBOX PASSWORDS (founder 2026-10-29: Naukri / Shine mailboxes "not configured"; he enters the
# app passwords again himself).
#
# The portal stores each mailbox app password encrypted with INTEGRATION_SECRET_KEY. The server never had one, so it can neither
# open the passwords that came with Sravanthi's data (her PC's key) nor save new ones ("Connect is refused").
# This makes sure the server has its own key: when backend/.env has no JOBPORTAL__INTEGRATION_SECRET_KEY, a new random one is
# generated HERE (openssl, never printed, never leaves the server), .env is backed up first (/root/backend-env-before-portal-key-<time>,
# mode 600), TeamLink is restarted and the backend restarts the portal with it. A key that is already there is kept unchanged
# (changing it would lock every password saved with it). Run by set-job-portal-mail-key.ps1 from the PC.
# ============================================================================
set -eu
R=${VPSROOT:-/opt/teamlink-enterprise}
ENVF=$R/backend/.env
NAME=JOBPORTAL__INTEGRATION_SECRET_KEY
[ -f "$ENVF" ] || { echo "STOPPED: no $ENVF - nothing changed"; exit 2; }

if grep -qE "^$NAME=.{16,}" "$ENVF"; then
  echo 'The Job Portal key is already set on the server - kept as it is (nothing changed).'
  exit 0
fi

S=$(date +%Y%m%d-%H%M%S)
B=/root/backend-env-before-portal-key-$S
cp -a "$ENVF" "$B" && chmod 600 "$B"
echo "backend .env backed up: $B"
{ grep -v "^$NAME=" "$ENVF" || true; printf '%s=%s\n' "$NAME" "$(openssl rand -hex 32)"; } > "$ENVF.new"
chmod --reference="$ENVF" "$ENVF.new"
mv "$ENVF.new" "$ENVF"
echo 'new Job Portal key generated and saved in backend/.env (not shown)'

PIDF=$R/job-portal-app/run/portal.pid.json
before=$(cat "$PIDF" 2>/dev/null || true)
touch "$R/job-portal-app/embed/launcher.cjs"   # the backend sees the portal as older than its code and restarts it cleanly
cd "$R/backend" && pm2 restart teamlink-enterprise --update-env >/dev/null && pm2 save >/dev/null && echo 'TeamLink restarted'

for i in $(seq 1 36); do   # up to 3 minutes for the portal to come back with the key
  sleep 5
  now=$(cat "$PIDF" 2>/dev/null || true)
  if [ -n "$now" ] && [ "$now" != "$before" ] && curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4010/jobs/ | grep -q '^200'; then
    echo 'JOB PORTAL RESTARTED WITH THE KEY'
    exit 0
  fi
done
echo 'The key is saved, but the Job Portal did not come back within 3 minutes. Last lines of its log:'
tail -n 20 "$R/job-portal-app/run/portal.log" 2>/dev/null
exit 3
