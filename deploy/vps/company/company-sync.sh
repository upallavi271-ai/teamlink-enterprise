#!/usr/bin/env bash
# ============================================================================
# COMPANY FOLLOWER - keeps a separate company's copy on the SAME release as TeamLink (docs/second-company.md).
#
#   company-sync.sh <key>        run every 2 minutes by company-sync@<key>.timer
#
# It never looks at GitHub. It looks at ONE file: the commit TeamLink's own sync recorded after a SUCCESSFUL, healthy deploy
# (/opt/teamlink-sync/deployed-commit). When that differs from what this company runs, it builds that same commit for the company
# (company-deploy.sh). So:
#   - a release only reaches the company after it has proven healthy on TeamLink; a TeamLink rollback never leaves the company ahead;
#   - TeamLink's own deploy is not changed in any way, and is never waited for or slowed down (this only READS its state);
#   - it waits while TeamLink is deploying, and while either side is paused (touch /opt/teamlink-sync/PAUSE or <company>/state/PAUSE).
# ============================================================================
set -uo pipefail
KEY=${1:?usage: company-sync.sh <key>}
ROOT=${ROOT:-/opt/company-$KEY}
SRC=${SRC:-/opt/teamlink-src}
TL_STATE=${TL_STATE:-/opt/teamlink-sync}
STATE=$ROOT/state
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$STATE"

[ -f "$STATE/PAUSE" ] && { echo "$(date '+%F %T')  PAUSED here (rm $STATE/PAUSE to resume)" > "$STATE/STATUS"; exit 0; }
[ -f "$TL_STATE/PAUSE" ] && exit 0                    # TeamLink's deploys are paused: so is this
want=$(cat "$TL_STATE/deployed-commit" 2>/dev/null || true)
have=$(cat "$STATE/deployed-commit" 2>/dev/null || true)
[ -n "$want" ] || exit 0
[ "$want" = "$have" ] && exit 0
[ "$want" = "$(cat "$STATE/failed-commit" 2>/dev/null || true)" ] && { echo "$(date '+%F %T')  waiting: ${want:0:8} failed here before; a newer TeamLink release will be tried" > "$STATE/STATUS"; exit 0; }

# TeamLink is in the middle of a deploy: its clone is changing and its release may still roll back. Try again in 2 minutes.
exec 8>"$TL_STATE/lock"
flock -n 8 || exit 0
flock -u 8

# a commit that says [skip deploy] was not built on TeamLink either (it only moves the marker): not built here
if git -C "$SRC" log -1 --format=%B "$want" 2>/dev/null | grep -qi '\[skip deploy\]'; then echo "$want" > "$STATE/deployed-commit"; exit 0; fi

if ROOT=$ROOT SRC=$SRC TL_STATE=$TL_STATE bash "$HERE/company-deploy.sh" "$KEY" "$want"; then rm -f "$STATE/failed-commit"; else echo "$want" > "$STATE/failed-commit"; fi
