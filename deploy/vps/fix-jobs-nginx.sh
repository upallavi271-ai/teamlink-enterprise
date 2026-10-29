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

n=$(curl -s -m 15 "$BACKEND/jobs/" | grep -c "$MARK")
echo "TeamLink backend /jobs/ (the real portal): $([ "$n" -ge 1 ] && echo 'NEW version' || echo 'not the new page')"
[ "$n" -ge 1 ] || { echo 'STOPPED: the backend itself does not serve the new portal page - nothing changed. Run push-everything-to-vps.ps1 first.'; exit 3; }

if grep -qE 'location[^{]*/jobs' "$F"; then
  echo 'nginx already has a /jobs rule:'
  grep -nE 'location[^{]*/jobs' -A6 "$F"
else
  L=$(grep -nE '^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?/api' "$F" | head -1 | cut -d: -f1)
  if [ -z "$L" ]; then
    echo "STOPPED: no /api rule in $F to put the /jobs rule next to - nothing changed. Its rules:"
    grep -nE 'server_name|listen|root |location|proxy_pass|try_files' "$F"
    exit 4
  fi
  S=$(date +%Y%m%d-%H%M%S)
  B=/root/nginx-site-before-jobs-$S.conf
  cp -a "$F" "$B" && echo "nginx site backed up: $B"
  awk -v L="$L" 'NR==L {
    print "    # TeamLink Job Portal (2026-10-29): /jobs is the real portal, served by the TeamLink backend (not an old static copy)"
    print "    location = /jobs { return 301 /jobs/; }"
    print "    location ^~ /jobs/ {"
    print "        proxy_pass http://127.0.0.1:4010;"
    print "        proxy_http_version 1.1;"
    print "        proxy_set_header Host $host;"
    print "        proxy_set_header X-Real-IP $remote_addr;"
    print "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
    print "        proxy_set_header X-Forwarded-Proto $scheme;"
    print "        client_max_body_size 50m;"
    print "        proxy_read_timeout 300s;"
    print "    }"
    print ""
  } { print }' "$B" > "$F"
  if nginx -t 2>&1; then
    systemctl reload nginx && echo 'NGINX /jobs RULE ADDED'
  else
    cp -a "$B" "$F"
    echo 'STOPPED: nginx did not accept the new rule - the old site file is back, nothing changed.'
    exit 5
  fi
fi

sleep 2
p=$(curl -s -m 20 https://teamlink.teamlinks.in/jobs/ | grep -c "$MARK")
if [ "$p" -ge 1 ]; then echo 'PUBLIC /jobs/ = NEW PORTAL'; else echo 'PUBLIC /jobs/ still answers the old page'; exit 6; fi
