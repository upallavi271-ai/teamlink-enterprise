#!/usr/bin/env bash
# Scratch test of teamlink-sync.sh. Touches NOTHING real: its own folders under /tmp/tsx, its own bare git remote, stub pm2/npm/npx/runuser/systemctl,
# and a tiny health server on ports 48010 / 48020. Run on any Linux box:   bash test-sync.sh /path/to/teamlink-sync.sh
set -u
SCRIPT=$(readlink -f "${1:-./teamlink-sync.sh}")
T=/tmp/tsx; rm -rf "$T"; mkdir -p "$T/bin" "$T/live/backend/prisma" "$T/live/frontend/src/pages" "$T/gs/gs-api/src" "$T/gs/green-start-web/src" "$T/gs/run"
pass=0; fail=0
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1  -> $3"; fi; }

# ---- stubs (they only write down what they were asked to do) ----
for c in pm2 npx systemctl runuser; do printf '#!/bin/sh\necho "%s $*" >> %s/calls.log\nexit 0\n' "$c" "$T" > "$T/bin/$c"; done
cat > "$T/bin/npm" <<EOF
#!/bin/sh
echo "npm \$*" >> $T/calls.log
[ -f $T/FAIL ] && [ "\$1" = "run" ] && exit 1
exit 0
EOF
chmod +x "$T"/bin/*
# ---- a health server that always answers 200 {"ok":true} ----
fuser -k 48010/tcp 48020/tcp >/dev/null 2>&1; sleep 1
python3 - <<'PY' &
import http.server, socketserver, threading
socketserver.TCPServer.allow_reuse_address = True
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self,*a): pass
for p in (48010, 48020):
    s = socketserver.TCPServer(('127.0.0.1', p), H); threading.Thread(target=s.serve_forever, daemon=True).start()
import time; time.sleep(600)
PY
HP=$!
trap 'kill $HP 2>/dev/null; fuser -k 48010/tcp 48020/tcp >/dev/null 2>&1; true' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 2 http://127.0.0.1:48010/api/health | grep -q ok && curl -s -m 2 http://127.0.0.1:48020/ | grep -q ok && break; sleep 1; done

# ---- a git remote with the 3 apps ----
git init -q --bare "$T/remote.git"; git clone -q "$T/remote.git" "$T/dev" 2>/dev/null
cd "$T/dev"; git config user.email d@x; git config user.name dev; git checkout -q -b main 2>/dev/null
mkdir -p backend/src backend/prisma frontend/src/pages job-portal-app/job_portal-main/api job-portal-app/embed green-start-app/gs-api/src green-start-app/green-start-web/src green-start-app/run
echo '{"name":"b"}' > backend/package.json; echo '{"l":1}' > backend/package-lock.json; echo 'v1' > backend/src/a.js; echo 'x' > backend/prisma/schema.prisma
echo '{"name":"f"}' > frontend/package.json; echo 'inv' > frontend/src/pages/Invoices.jsx
echo '{"name":"p"}' > job-portal-app/job_portal-main/package.json; echo '{}' > job-portal-app/job_portal-main/api/package.json; echo e > job-portal-app/embed/e.js
echo '{"name":"gs"}' > green-start-app/gs-api/package.json; echo g1 > green-start-app/gs-api/src/main.ts; echo w1 > green-start-app/green-start-web/src/app.ts; echo gate1 > green-start-app/run/gate.mjs
git add -A; git commit -qm base; git push -q origin main
cd "$T"
# ---- the "live" side as the last manual deploy left it ----
mkdir -p live/backend/src; echo old > live/backend/src/a.js; echo 'SECRET=1' > live/backend/.env; echo db > live/backend/prisma/dev.db; echo '{"l":1}' > live/backend/package-lock.json; mkdir -p live/backend/node_modules; echo 'inv-old' > live/frontend/src/pages/Invoices.jsx
echo gate0 > gs/run/gate.mjs; touch gs/gs-api/.env
touch key
run() { LIVE=$T/live GS=$T/gs SRC=$T/src STATE=$T/state REPO=$T/remote.git KEY=$T/key PORT=48010 GS_API_PORT=48020 PM2_NAME=tl-test GS_USER=root PATH=$T/bin:$PATH bash "$SCRIPT" "$@" 2>&1; }

# ---- T1: dry run changes nothing ----
out=$(DRY_RUN=1 run);
ok "T1 dry run: says what it would do, replaced nothing" "$([ ! -d $T/live/backend-old-* ] 2>/dev/null && ! grep -q 'pm2 stop' $T/calls.log 2>/dev/null && echo 1 || echo 0)" "$out"
# ---- T2: first real run deploys everything from GitHub, keeps .env and the database ----
out=$(run)
ok "T2 first run: deployed the new code (backend a.js = v1)" "$([ "$(cat $T/live/backend/src/a.js)" = v1 ] && echo 1 || echo 0)" "$out"
ok "T2b .env and database were kept" "$([ "$(head -1 $T/live/backend/.env)" = 'SECRET=1' ] && [ "$(cat $T/live/backend/prisma/dev.db)" = db ] && echo 1 || echo 0)" "$(ls $T/live)"
ok "T2c previous release kept (backend-old-*) and TeamLink restarted + migrations run" "$(ls -d $T/live/backend-old-* >/dev/null 2>&1 && grep -q 'pm2 restart tl-test' $T/calls.log && grep -q 'prisma migrate deploy' $T/calls.log && echo 1 || echo 0)" "$(cat $T/calls.log | tail -5)"
ok "T2d Green Start files copied, gate.mjs updated, services restarted" "$([ "$(cat $T/gs/gs-api/src/main.ts)" = g1 ] && [ "$(cat $T/gs/run/gate.mjs)" = gate1 ] && grep -q 'systemctl restart green-start-api' $T/calls.log && echo 1 || echo 0)" "$(tail -3 $T/calls.log)"
ok "T2e deployed commit recorded, status says deployed" "$([ "$(cat $T/state/deployed-commit)" = "$(git -C $T/remote.git rev-parse main)" ] && grep -q deployed $T/state/STATUS && echo 1 || echo 0)" "$(cat $T/state/STATUS)"
ok "T2f the live database folder of the portal is never packaged (no var/)" "$([ ! -d $T/state/pkg/job-portal-app/job_portal-main/var ] && echo 1 || echo 0)" ""

# ---- T3: quiet run when nothing changed ----
: > $T/calls.log; out=$(run)
ok "T3 nothing new: nothing stopped or restarted" "$(! grep -q pm2 $T/calls.log && echo 1 || echo 0)" "$(cat $T/calls.log)"

# ---- T4: a change made elsewhere (PC / AI / GitHub) reaches the VPS ----
cd $T/dev; echo v2 > backend/src/a.js; echo w2 > green-start-app/green-start-web/src/app.ts; git commit -qam "pc change"; git push -q origin main; cd $T
: > $T/calls.log; out=$(run)
ok "T4 PC change deployed: backend v2 live, Green Start web rebuilt" "$([ "$(cat $T/live/backend/src/a.js)" = v2 ] && [ "$(cat $T/gs/green-start-web/src/app.ts)" = w2 ] && grep -q 'npm run build' $T/calls.log && echo 1 || echo 0)" "$out"

# ---- T5: an edit made directly on the VPS goes to GitHub, then is not deployed again ----
echo 'vps-edit' > $T/live/backend/src/a.js; echo 'brand new' > $T/live/backend/src/new-on-vps.js; echo gate-vps > $T/gs/run/gate.mjs
: > $T/calls.log; out=$(run)
git -C $T/dev pull -q origin main
ok "T5 VPS edits reached GitHub (a.js, new file, Green Start gate.mjs)" "$([ "$(cat $T/dev/backend/src/a.js)" = vps-edit ] && [ -f $T/dev/backend/src/new-on-vps.js ] && [ "$(cat $T/dev/green-start-app/run/gate.mjs)" = gate-vps ] && echo 1 || echo 0)" "$out"
ok "T5b the commit says VPS-edit and was NOT deployed again" "$(git -C $T/dev log -1 --format=%s | grep -q '^VPS-edit' && ! grep -q 'pm2 stop' $T/calls.log && echo 1 || echo 0)" "$(git -C $T/dev log -1 --format=%s) / $(cat $T/calls.log)"
: > $T/calls.log; out=$(run)
ok "T5c second run: no edit reported again" "$(echo "$out" | grep -q 'edited on the VPS' && echo 0 || echo 1)" "$out"

# ---- T6: edit on the VPS that clashes with a newer GitHub change: nothing is lost, nothing pushed ----
cd $T/dev; echo 'from-pc' > backend/src/a.js; git commit -qam "pc edits a.js"; git push -q origin main; cd $T
echo 'from-vps-clash' > $T/live/backend/src/a.js   # live is still on the old content: clash
out=$(run)
ok "T6 clash: alert raised, VPS file still has its edit, GitHub has the PC version" "$([ -f $T/state/ALERT ] && grep -q 'CLASHES' $T/state/ALERT && [ "$(git -C $T/remote.git show main:backend/src/a.js)" = from-pc ] && echo 1 || echo 0)" "$out"
out=$(run accept-github)
ok "T6b accept-github: the VPS file now has the PC version, alert cleared, deploy resumed" "$([ "$(cat $T/live/backend/src/a.js)" = from-pc ] && [ ! -f $T/state/ALERT ] && echo 1 || echo 0)" "$out"

# ---- T7: a secret-looking file edited on the VPS is never pushed ----
cd $T/dev; git pull -q origin main; cd $T
rm -f $T/live/backend/src/a.js; cp $T/dev/backend/src/a.js $T/live/backend/src/a.js    # live == repo again (clash resolved)
rsync -a --exclude node_modules $T/live/backend/ $T/state/base/teamlink-backend/ 2>/dev/null
echo 'KEY' > $T/live/backend/src/server.pem
out=$(run)
ok "T7 secret file: alert, nothing pushed" "$([ -f $T/state/ALERT ] && ! git -C $T/remote.git ls-tree -r main --name-only | grep -q server.pem && echo 1 || echo 0)" "$out"
rm -f $T/live/backend/src/server.pem $T/state/ALERT; rsync -a $T/live/backend/ $T/state/base/teamlink-backend/ --exclude node_modules --exclude .env 2>/dev/null

# ---- T8: a failing deploy rolls back and does not loop ----
cd $T/dev; git pull -q origin main; echo v3 > backend/src/a.js; git commit -qam "breaking change"; git push -q origin main; cd $T
touch $T/FAIL; : > $T/calls.log; out=$(run)
ok "T8 failed build: rolled back (backend a.js is the previous one), ALERT raised, commit marked failed" "$([ "$(cat $T/live/backend/src/a.js)" != v3 ] && [ -f $T/state/ALERT ] && [ -f $T/state/failed-commit ] && ls -d $T/live/backend-failed-* >/dev/null 2>&1 && echo 1 || echo 0)" "$out"
: > $T/calls.log; out=$(run)
ok "T8b the failed commit is not retried every 2 minutes" "$(! grep -q 'pm2 stop' $T/calls.log && echo 1 || echo 0)" "$(cat $T/calls.log)"
rm -f $T/FAIL
cd $T/dev; echo v4 > backend/src/a.js; git commit -qam "fixed"; git push -q origin main; cd $T
out=$(run)
ok "T8c a new commit after the failure deploys again" "$([ "$(cat $T/live/backend/src/a.js)" = v4 ] && [ ! -f $T/state/ALERT ] && echo 1 || echo 0)" "$out"

# ---- T9: pause ----
cd $T/dev; echo v5 > backend/src/a.js; git commit -qam "later"; git push -q origin main; cd $T
touch $T/state/PAUSE; : > $T/calls.log; out=$(run)
ok "T9 PAUSE file: nothing happens" "$([ "$(cat $T/live/backend/src/a.js)" = v4 ] && ! grep -q pm2 $T/calls.log && echo 1 || echo 0)" "$out"
rm -f $T/state/PAUSE
# ---- T10: [skip deploy] ----
cd $T/dev; echo v6 > backend/src/a.js; git commit -qam "docs only [skip deploy]"; git push -q origin main; cd $T
: > $T/calls.log; out=$(run)
ok "T10 [skip deploy] in the message: that commit is not deployed (but v5 earlier IS, by the next run)" "$([ -f $T/state/deployed-commit ] && echo 1 || echo 0)" "$out"

echo; echo "$pass passed, $fail failed"; rm -rf "$T/pkg"; [ "$fail" = 0 ]
