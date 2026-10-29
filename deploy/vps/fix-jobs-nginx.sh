#!/usr/bin/env bash
# ============================================================================
# /jobs ON THE LIVE SITE = THE REAL JOB PORTAL (founder 2026-10-29: "server lo old file chupistundi, local host lo unna version kavali").
#
# Found: nginx answered https://teamlink.teamlinks.in/jobs/ ITSELF from an old static copy (the Sep 2026 single-file prototype,
# 1,587,110 bytes, with the "Login credentials" / "Quick demo login" boxes). The real portal, started by the TeamLink backend and
# served by it at 127.0.0.1:4010/jobs/, was never reached - so every deploy "passed" (it checks 4010) and the site stayed old.
#
# This adds ONE rule to the teamlink.teamlinks.in nginx site, next to its /api rule: /jobs/ goes to the TeamLink backend.
# The site file is backed up first (/root/nginx-site-before-jobs-<time>.conf); if nginx -t fails the backup is put back and nothing
# changes. The old static folder is not deleted (it is simply no longer used). Run by push-jobs-fix-to-vps.ps1 from the PC.
# ============================================================================
set -u
MARK='NOTHING ON THIS PAGE HINTS AT A CREDENTIAL'   # a line only the current portal page has
BACKEND=${BACKEND:-http://127.0.0.1:4010}

F=$(grep -lsE 'server_name[^;]*teamlink\.teamlinks\.in' ${SITES:-/etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf} 2>/dev/null | head -1)
[ -n "$F" ] || { echo 'STOPPED: no nginx site for teamlink.teamlinks.in found in /etc/nginx/sites-enabled or conf.d'; exit 2; }
F=$(readlink -f "$F")
echo "nginx site file: $F"

# the backend address = where this site's /api rule already sends requests (not a guess)
API=$(grep -A6 -E '^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?/api' "$F" | grep -oE 'proxy_pass[[:space:]]+https?://[^;/[:space:]]+' | head -1 | awk '{print $2}')
[ -n "$API" ] && BACKEND=$API
echo "TeamLink backend (from the /api rule): $BACKEND"

diag() {   # what the backend and the portal really answer, so the cause is on the screen
  echo '---- what the server answers ----'
  echo "backend $BACKEND/jobs/ : $(curl -s -m 20 -o /tmp/jobs-b.html -w 'HTTP %{http_code}, %{size_download} bytes' "$BACKEND/jobs/"), new-page line: $(grep -c "$MARK" /tmp/jobs-b.html 2>/dev/null)"
  head -c 300 /tmp/jobs-b.html 2>/dev/null | tr '\n' ' '; echo
  R=/opt/teamlink-enterprise
  P=$(sed -n 's/^JOB_PORTAL_PORT=//p' $R/backend/.env 2>/dev/null | tail -1 | tr -d '\042\047\r'); P=${P:-4323}
  echo "portal itself 127.0.0.1:$P/ : $(curl -s -m 20 -o /tmp/jobs-p.html -w 'HTTP %{http_code}, %{size_download} bytes' "http://127.0.0.1:$P/"), new-page line: $(grep -c "$MARK" /tmp/jobs-p.html 2>/dev/null)"
  W=$R/job-portal-app/job_portal-main/web/index.html
  echo "portal file on disk: $(stat -c '%s bytes %y' $W 2>/dev/null), new-page line: $(grep -c "$MARK" $W 2>/dev/null)"
  echo "backend .env: $(grep -E '^(PORT|JOB_PORTAL_[A-Z_]*(EMBED|PORT|DIR|URL))=' $R/backend/.env 2>/dev/null | tr '\n' ' ')"
  echo "listening: $(ss -ltnp 2>/dev/null | grep -E ":(4010|4323|$P)\b" | awk '{print $4, $6}' | tr '\n' ' ')"
  echo '---- portal log (last 15 lines) ----'; tail -n 15 $R/job-portal-app/run/portal.log 2>/dev/null
  rm -f /tmp/jobs-b.html /tmp/jobs-p.html
}

n=0
for i in $(seq 1 36); do   # up to 3 minutes: the backend may still be starting the portal again
  n=$(curl -s -m 20 "$BACKEND/jobs/" | grep -c "$MARK")
  [ "$n" -ge 1 ] && break
  [ "$i" = 1 ] && echo 'waiting for the Job Portal to answer (up to 3 minutes)...'
  sleep 5
done
echo "TeamLink backend /jobs/ (the real portal): $([ "$n" -ge 1 ] && echo 'NEW version' || echo 'not the new page')"
[ "$n" -ge 1 ] || { diag; echo 'STOPPED: the backend itself does not serve the new portal page - nothing changed.'; exit 3; }

# Where the rule goes. The live site (seen 2026-10-29) ALREADY had a hand-made static rule:
#   location /jobs/ { alias /opt/teamlink-enterprise/frontend/dist/job-portal/; ... }   <- the old prototype copy
# That block is REPLACED by the proxy block; with no /jobs/ block at all, the proxy block goes next to the /api rule.
S0=$(grep -nE '^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?/jobs/?[[:space:]]*\{' "$F" | head -1 | cut -d: -f1)
HAS_REDIRECT=$(grep -cE '^[[:space:]]*location[[:space:]]*=[[:space:]]*/jobs[[:space:]]*\{' "$F")
MODE=''; L=''; E0=''
if [ -n "$S0" ]; then
  if sed -n "${S0}p" "$F" | grep -q '}'; then E0=$S0; else
    E0=$(awk -v s="$S0" 'NR>s && /^[[:space:]]*}[[:space:]]*$/ { print NR; exit }' "$F"); fi
  [ -n "$E0" ] || { echo "STOPPED: could not find the end of the /jobs rule at line $S0 - nothing changed"; exit 4; }
  echo "nginx /jobs rule now (lines $S0-$E0):"; sed -n "${S0},${E0}p" "$F"
  if sed -n "${S0},${E0}p" "$F" | grep -q 'proxy_pass'; then
    echo 'it already sends /jobs to a backend - left as it is'
  else
    MODE=replace
  fi
else
  L=$(grep -nE '^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?/api' "$F" | head -1 | cut -d: -f1)
  if [ -z "$L" ]; then
    echo "STOPPED: no /api rule in $F to put the /jobs rule next to - nothing changed. Its rules:"
    grep -nE 'server_name|listen|root |alias |location|proxy_pass|try_files' "$F"
    exit 4
  fi
  MODE=insert
fi

if [ -n "$MODE" ]; then
  S=$(date +%Y%m%d-%H%M%S)
  B=/root/nginx-site-before-jobs-$S.conf
  cp -a "$F" "$B" && echo "nginx site backed up: $B"
  awk -v MODE="$MODE" -v S0="$S0" -v E0="$E0" -v L="$L" -v BE="$BACKEND" -v REDIR="$HAS_REDIRECT" '
  function blk() {
    print "    # TeamLink Job Portal (2026-10-29): /jobs is the real portal, served by the TeamLink backend (it was an old static copy:"
    print "    # alias .../frontend/dist/job-portal/ - backup of the old file in /root/nginx-site-before-jobs-*.conf)"
    if (REDIR == 0) print "    location = /jobs { return 301 /jobs/; }"
    print "    location ^~ /jobs/ {"
    print "        proxy_pass " BE ";"
    print "        proxy_http_version 1.1;"
    print "        proxy_set_header Host $host;"
    print "        proxy_set_header X-Real-IP $remote_addr;"
    print "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
    print "        proxy_set_header X-Forwarded-Proto $scheme;"
    print "        client_max_body_size 50m;"
    print "        proxy_read_timeout 300s;"
    print "    }"
  }
  MODE == "replace" && NR == S0 { blk(); next }
  MODE == "replace" && NR > S0 && NR <= E0 { next }
  MODE == "insert" && NR == L { blk(); print "" }
  { print }' "$B" > "$F"
  if nginx -t 2>&1; then
    systemctl reload nginx && echo "NGINX /jobs RULE $( [ "$MODE" = replace ] && echo REPLACED || echo ADDED )"
  else
    cp -a "$B" "$F"
    echo 'STOPPED: nginx did not accept the new rule - the old site file is back, nothing changed.'
    exit 5
  fi
fi

sleep 2
p=$(curl -s -m 20 https://teamlink.teamlinks.in/jobs/ | grep -c "$MARK")
if [ "$p" -ge 1 ]; then echo 'PUBLIC /jobs/ = NEW PORTAL'; else echo 'PUBLIC /jobs/ still answers the old page'; diag; exit 6; fi
