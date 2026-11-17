#!/usr/bin/env bash
# ============================================================================
# COMPANY GREEN START FOLLOWER - keeps a company's OWN Green Start on the program version TeamLink's Green Start runs (docs/second-company.md section 12).
#
#   company-green-sync.sh <key>        called every 2 minutes by company-sync.sh (and harmless to run by hand)
#
# The company's Green Start runs TeamLink's read-only program files (/opt/green-start/gs-api/dist, the built website). When TeamLink's own sync has rebuilt them,
# the company's database needs the new migrations (its OWN database only) and its API and worker need a restart. This only starts after TeamLink's own deploy has
# FINISHED (it waits while /opt/teamlink-sync/lock is held and while TeamLink's Green Start API is not active), never touches TeamLink's database or services,
# and does nothing for a company that has no Green Start of its own, or one that is not started yet.
# ============================================================================
set -uo pipefail
KEY=${1:?usage: company-green-sync.sh <key>}
ROOT=${ROOT:-/opt/company-$KEY}; G=$ROOT/green; ENVF=$G/config/gs-api.env; STATE=$G/state
GS=${GS:-/opt/green-start}; TL_STATE=${TL_STATE:-/opt/teamlink-sync}
U_API=green-start-$KEY-api; U_WORKER=green-start-$KEY-worker
[ -f "$ENVF" ] || exit 0
[ -f "$STATE/PAUSE" ] && exit 0
[ -f "$TL_STATE/PAUSE" ] && exit 0
NOW=$(stat -c %Y "$GS/gs-api/dist/main.js" 2>/dev/null) || exit 0
HAVE=$(cat "$STATE/dist-stamp" 2>/dev/null || true)
[ -n "$HAVE" ] || exit 0                  # never started yet (company-green-install.sh --stage start writes the stamp)
[ "$NOW" = "$HAVE" ] && exit 0
# TeamLink is in the middle of a deploy: its program files may still be changing
exec 8>"$TL_STATE/lock"; flock -n 8 || exit 0; flock -u 8
systemctl is-active --quiet green-start-api || exit 0
sleep 20; [ "$(stat -c %Y "$GS/gs-api/dist/main.js")" = "$NOW" ] || exit 0       # still being written: try again next time

mkdir -p "$STATE"; LOG=$STATE/green-sync.log
log() { printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
DB=$(sed -n 's/^DATABASE_URL=//p' "$ENVF" | tail -1 | tr -d '"\047\r')
log "TeamLink's Green Start program changed: migrating the company's own database, then restarting its API and worker"
if ! ( cd "$G/gs-api" && runuser -u greenstart -- env -i PATH="$PATH" HOME="$G" DATABASE_URL="$DB" node node_modules/prisma/build/index.js migrate deploy ) >> "$LOG" 2>&1; then
  printf '%s  the company Green Start migration FAILED (see %s); its services were NOT restarted\n' "$(date '+%F %T')" "$LOG" > "$STATE/ALERT"; log "migration FAILED"; exit 1
fi
if systemctl is-active --quiet "$U_API"; then
  systemctl restart "$U_API" "$U_WORKER" >> "$LOG" 2>&1 || true
  P=$(sed -n 's/^PORT=//p' "$ENVF" | tail -1 | tr -d '"\047\r'); ok=0
  for i in $(seq 1 40); do if curl -s -m 3 "http://127.0.0.1:$P/api/v1/health" | grep -qi "ok\|up"; then ok=1; break; fi; sleep 3; done
  [ $ok = 1 ] || { printf '%s  the company Green Start did not come back after the update (journalctl -u %s)\n' "$(date '+%F %T')" "$U_API" > "$STATE/ALERT"; log "did not come back"; exit 1; }
fi
echo "$NOW" > "$STATE/dist-stamp"; rm -f "$STATE/ALERT"; log "done"
