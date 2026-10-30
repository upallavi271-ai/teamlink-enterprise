#!/usr/bin/env bash
# Stand-in test of deploy_teamlink_fast (teamlink-sync.sh): stub pm2 / npm / npx / rsync / curl, temp folders only.
# Run:  bash deploy/vps/test-sync-fast.sh deploy/vps/teamlink-sync.sh     (works in Git Bash too: no rsync / pm2 needed)
SYNC=$1
T=${TMPDIR:-/tmp}/tsx-fast
rm -rf "$T"; mkdir -p "$T/bin"
# stubs: write what they were asked to do
cat > "$T/bin/pm2" <<'X'
#!/bin/sh
echo "pm2 $*" >> "$CALLS"
X
cat > "$T/bin/npm" <<'X'
#!/bin/sh
echo "npm $* in $(basename "$PWD")" >> "$CALLS"
if [ "$1" = "run" ] && [ "$2" = "build" ]; then [ -f "$FAIL_BUILD" ] && exit 1; mkdir -p dist; echo "<html>$(cat VERSION 2>/dev/null)</html>" > dist/index.html; fi
if [ "$1" = "install" ]; then mkdir -p node_modules; fi
exit 0
X
cat > "$T/bin/npx" <<'X'
#!/bin/sh
echo "npx $* in $(basename "$PWD")" >> "$CALLS"
[ "$2" = "generate" ] && mkdir -p node_modules/.prisma/client && echo new > node_modules/.prisma/client/index.js
exit 0
X
cat > "$T/bin/rsync" <<'X'
#!/bin/sh
echo "rsync $*" >> "$CALLS"
exit 0
X
cat > "$T/bin/curl" <<'X'
#!/bin/sh
echo '{"ok":true}'
X
chmod +x "$T"/bin/*
export PATH="$T/bin:$PATH" CALLS="$T/calls.txt" FAIL_BUILD="$T/fail-build"

# pull the functions out of the real script
sed -n '/^health_teamlink()/p;/^rollback_teamlink()/,/^}/p;/^deploy_teamlink_fast()/,/^}/p' "$SYNC" | tr -d '\r' > "$T/funcs.sh"

setup() {
  rm -rf "$T/live" "$T/state"; : > "$CALLS"; rm -f "$FAIL_BUILD"
  mkdir -p "$T/live/backend/prisma" "$T/live/backend/node_modules/.prisma/client" "$T/live/frontend/dist" "$T/live/frontend/node_modules/.vite" \
           "$T/state/pkg/backend/prisma" "$T/state/pkg/frontend" "$T/state/base"
  echo old > "$T/live/backend/VERSION"; echo old > "$T/live/frontend/VERSION"; echo '<html>old</html>' > "$T/live/frontend/dist/index.html"
  echo live-db > "$T/live/backend/prisma/dev.db"; echo wal > "$T/live/backend/prisma/dev.db-wal"; echo SECRET=1 > "$T/live/backend/.env"
  echo lock > "$T/live/backend/package-lock.json"; echo lock > "$T/live/frontend/package-lock.json"
  echo old > "$T/live/backend/node_modules/.prisma/client/index.js"; echo pkg > "$T/live/backend/node_modules/x.js"; echo cache > "$T/live/frontend/node_modules/.vite/c"
  echo new > "$T/state/pkg/backend/VERSION"; echo new > "$T/state/pkg/frontend/VERSION"
  echo lock > "$T/state/pkg/backend/package-lock.json"; echo lock > "$T/state/pkg/frontend/package-lock.json"
}
pass=0; fail=0
ok() { if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

run() { ( LIVE="$T/live" STATE="$T/state" PM2_NAME=teamlink-enterprise PORT=4010 STAMP=$1 LOG="$T/log.txt"
          log() { echo "LOG $*" >> "$T/log.txt"; }; alert() { echo "ALERT $*" >> "$T/log.txt"; }; sleep() { :; }
          . "$T/funcs.sh"; deploy_teamlink_fast abcdef1234 "$2" "$3" "$T/bk" ); }

# 1. screens only: the server is never stopped
setup; run s1 0 1; rc=$?
ok "screens only: succeeds" "[ $rc -eq 0 ]"
ok "screens only: pm2 never called" "! grep -q '^pm2' '$CALLS'"
ok "screens only: new screens are live" "grep -q new '$T/live/frontend/dist/index.html'"
ok "screens only: old screens kept aside" "grep -q old '$T/live/frontend-old-s1/dist/index.html'"
ok "screens only: live packages' build cache untouched" "[ -f '$T/live/frontend-old-s1/node_modules/.vite/c' ]"
ok "screens only: server folder untouched" "grep -q old '$T/live/backend/VERSION'"

# 2. server only: one stop, switch, migrations, start; database + WAL kept; live Prisma client file never rewritten
setup; run s2 1 0; rc=$?
ok "server: succeeds" "[ $rc -eq 0 ]"
ok "server: stopped once and restarted once" "[ \$(grep -c '^pm2 stop' '$CALLS') -eq 1 ] && [ \$(grep -c '^pm2 restart' '$CALLS') -eq 1 ]"
ok "server: generate ran BEFORE the stop" "[ \$(grep -n 'prisma generate' '$CALLS' | cut -d: -f1) -lt \$(grep -n '^pm2 stop' '$CALLS' | cut -d: -f1) ]"
ok "server: migrations AFTER the stop" "[ \$(grep -n 'migrate deploy' '$CALLS' | cut -d: -f1) -gt \$(grep -n '^pm2 stop' '$CALLS' | cut -d: -f1) ]"
ok "server: new code live" "grep -q new '$T/live/backend/VERSION'"
ok "server: database and WAL kept" "grep -q live-db '$T/live/backend/prisma/dev.db' && grep -q wal '$T/live/backend/prisma/dev.db-wal'"
ok "server: .env kept" "grep -q SECRET=1 '$T/live/backend/.env'"
ok "server: old release's Prisma client not overwritten" "grep -q old '$T/live/backend-old-s2/node_modules/.prisma/client/index.js'"
ok "server: packages shared (hard link)" "[ '$T/live/backend/node_modules/x.js' -ef '$T/live/backend-old-s2/node_modules/x.js' ]"
ok "server: screens untouched" "grep -q old '$T/live/frontend/dist/index.html'"

# 3. build fails: nothing switched, server never stopped, live as it was
setup; touch "$FAIL_BUILD"; run s3 1 1; rc=$?
ok "failed build: reports failure" "[ $rc -ne 0 ]"
ok "failed build: server never stopped" "! grep -q '^pm2 stop' '$CALLS'"
ok "failed build: live screens and server as before" "grep -q old '$T/live/frontend/dist/index.html' && grep -q old '$T/live/backend/VERSION'"
ok "failed build: no leftovers" "[ ! -d '$T/live/frontend-new-s3' ] && [ ! -d '$T/live/backend-new-s3' ]"
ok "failed build: alert says nothing was switched" "grep -q 'Nothing was switched' '$T/log.txt'"

echo "SUMMARY pass=$pass fail=$fail"
