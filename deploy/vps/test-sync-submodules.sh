#!/usr/bin/env bash
# Scratch test of teamlink-sync.sh for the SUBMODULE layout: Job Portal (job-portal-app/job_portal-main) and Green Start (green-start-app)
# are their own repos, main only pins a commit of each (Green Start's server-only helper files live in green-start-helpers/run of the MAIN repo). Touches NOTHING real: its own folders under /tmp/tsx2, its own bare git repos
# (main + the two submodule repos), stub pm2/npm/npx/runuser/systemctl, and a tiny health server on ports 48110 / 48120.
# Run on any Linux box with git, rsync, flock, python3:      bash test-sync-submodules.sh /path/to/teamlink-sync.sh
set -u
SCRIPT=$(readlink -f "${1:-./teamlink-sync.sh}")
T=/tmp/tsx2; rm -rf "$T"; mkdir -p "$T/bin" "$T/subs"
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
printf '#!/bin/sh\necho "-- dump of $*"\n' > "$T/bin/pg_dump"
chmod +x "$T"/bin/*
# ---- a health server that always answers 200 {"ok":true} ----
fuser -k 48110/tcp 48120/tcp >/dev/null 2>&1; sleep 1
python3 - <<'PY' &
import http.server, socketserver, threading
socketserver.TCPServer.allow_reuse_address = True
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self,*a): pass
for p in (48110, 48120):
    s = socketserver.TCPServer(('127.0.0.1', p), H); threading.Thread(target=s.serve_forever, daemon=True).start()
import time; time.sleep(900)
PY
HP=$!
trap 'kill $HP 2>/dev/null; fuser -k 48110/tcp 48120/tcp >/dev/null 2>&1; true' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 2 http://127.0.0.1:48110/api/health | grep -q ok && curl -s -m 2 http://127.0.0.1:48120/ | grep -q ok && break; sleep 1; done

PORTAL=job-portal-app/job_portal-main
G() { git -C "$@"; }
# ---- the two submodule repos (own GitHub repos) ----
mkbare() { git init -q --bare "$1"; git -C "$1" symbolic-ref HEAD refs/heads/main; }
mkbare "$T/subs/job_portal.git"; mkbare "$T/subs/omni.git"; mkbare "$T/remote.git"
git clone -q "$T/subs/job_portal.git" "$T/dev_jp" 2>/dev/null; cd "$T/dev_jp"; git config user.email d@x; git config user.name dev; git checkout -q -b main
mkdir -p api web docs supabase/migrations; printf 'select 1;\n' > supabase/migrations/0001_a.sql; printf 'select 2;\n' > supabase/migrations/0002_b.sql; echo '{"name":"p"}' > package.json; echo '{}' > api/package.json; echo j1 > api/x.js; echo '<html>' > web/index.html; echo d1 > docs/readme.md; echo r > README.md
git add -A; git commit -qm "portal base"; git push -q origin main
git clone -q "$T/subs/omni.git" "$T/dev_omni" 2>/dev/null; cd "$T/dev_omni"; git config user.email d@x; git config user.name dev; git checkout -q -b main
mkdir -p gs-api/src green-start-web/src docs sdk; echo '{"name":"gs"}' > gs-api/package.json; echo g1 > gs-api/src/main.ts; echo w1 > green-start-web/src/app.ts; echo n1 > docs/note.md; echo s1 > sdk/s.js
git add -A; git commit -qm "omni base"; git push -q origin main
# ---- main: TeamLink + the two submodules (the .gitmodules urls are https://github.com/... like on the real repo) ----
git clone -q "$T/remote.git" "$T/dev" 2>/dev/null; cd "$T/dev"; git config user.email d@x; git config user.name dev; git checkout -q -b main
mkdir -p backend/src backend/prisma frontend/src/pages job-portal-app/embed green-start-helpers/run
echo '{"name":"b"}' > backend/package.json; echo '{"l":1}' > backend/package-lock.json; echo 'v1' > backend/src/a.js; echo 'x' > backend/prisma/schema.prisma
echo '{"name":"f"}' > frontend/package.json; echo 'inv' > frontend/src/pages/Invoices.jsx; echo e > job-portal-app/embed/e.js; echo gate1 > green-start-helpers/run/gate.mjs
git add -A; git commit -qm "teamlink base"
git -c protocol.file.allow=always submodule add -q "$T/subs/job_portal.git" $PORTAL 2>/dev/null
git -c protocol.file.allow=always submodule add -q "$T/subs/omni.git" green-start-app 2>/dev/null
git config -f .gitmodules "submodule.$PORTAL.url" https://github.com/subs/job_portal.git
git config -f .gitmodules submodule.green-start-app.url https://github.com/subs/omni.git
git add -A; git commit -qm "add the two submodules"; git push -q origin main
cd "$T"
mkdir -p live/backend/prisma live/backend/src live/frontend/src/pages live/$PORTAL/api gs/gs-api/src gs/green-start-web/src gs/run
echo old > live/backend/src/a.js; echo 'SECRET=1' > live/backend/.env; echo db > live/backend/prisma/dev.db; echo walrows > live/backend/prisma/dev.db-wal; echo '{"l":1}' > live/backend/package-lock.json; mkdir -p live/backend/node_modules
echo 'inv-old' > live/frontend/src/pages/Invoices.jsx; echo jold > live/$PORTAL/api/x.js; echo '{"name":"p"}' > live/$PORTAL/package.json
echo gold > gs/gs-api/src/main.ts; touch gs/gs-api/.env; echo gate0 > gs/run/gate.mjs
mkdir -p live/backend/keepdata gs/run/pgdata live/$PORTAL/var; echo kept > live/backend/keepdata/state.json; echo biometric-rows > gs/run/pgdata/PG_VERSION; echo portal-db > live/$PORTAL/var/db.sqlite
mkdir -p live/$PORTAL/supabase/migrations; printf 'select 1;\r\n' > live/$PORTAL/supabase/migrations/0001_a.sql
mkdir -p live/$PORTAL/var/dev-db; ( sleep 5 ) & echo $! > live/$PORTAL/var/dev-db/postmaster.pid
touch key
run() { VPS_EDITS=${VPS_EDITS:-1} GH_PREFIX=file://$T/ GIT_ALLOW_PROTOCOL=file:https:ssh:git LIVE=$T/live GS=$T/gs SRC=$T/src STATE=$T/state REPO=$T/remote.git KEY=$T/key PORT=48110 GS_API_PORT=48120 PM2_NAME=tl-test GS_USER=root PATH=$T/bin:$PATH bash "$SCRIPT" "$@" 2>&1; }
mainhead() { G "$T/remote.git" rev-parse main; }
pin() { G "$T/remote.git" ls-tree main "$1" | awk '{print $3}'; }
subhead() { G "$T/subs/$1.git" rev-parse main; }
mainmsg() { G "$T/remote.git" log -1 --format=%s main; }
refresh_dev() { G "$T/dev" pull -q origin main 2>/dev/null; G "$T/dev" -c protocol.file.allow=always submodule update -q --init 2>/dev/null; }

# ---- S1: dry run changes nothing ----
out=$(DRY_RUN=1 run)
ok "S1 dry run: replaced nothing, stopped nothing" "$(! ls -d $T/live/backend-old-* >/dev/null 2>&1 && ! grep -q 'pm2 stop' $T/calls.log 2>/dev/null && [ "$(cat $T/live/$PORTAL/api/x.js)" = jold ] && echo 1 || echo 0)" "$out"
# ---- S2: first real run deploys TeamLink + the Job Portal from its submodule + Green Start from its submodule ----
out=$(run)
ok "S2 first run: TeamLink deployed (a.js v1), .env and database kept" "$([ "$(cat $T/live/backend/src/a.js)" = v1 ] && [ "$(head -1 $T/live/backend/.env)" = 'SECRET=1' ] && [ "$(cat $T/live/backend/prisma/dev.db)" = db ] && echo 1 || echo 0)" "$out"
ok "S2b Job Portal came from the submodule (api/x.js = j1, web/index.html there, no .git copied)" "$([ "$(cat $T/live/$PORTAL/api/x.js)" = j1 ] && [ -f $T/live/$PORTAL/web/index.html ] && [ ! -e $T/live/$PORTAL/.git ] && echo 1 || echo 0)" "$out"
ok "S2b2 existing VPS data untouched: backend extra folder, Green Start pgdata, Job Portal var/ database" "$([ "$(cat $T/live/backend/keepdata/state.json)" = kept ] && [ "$(cat $T/gs/run/pgdata/PG_VERSION)" = biometric-rows ] && [ "$(cat $T/live/$PORTAL/var/db.sqlite)" = portal-db ] && echo 1 || echo 0)" "$(ls $T/live/backend $T/gs/run)"
ok "S2b3 Job Portal migrations: the already-applied file keeps its VPS bytes (CRLF), the new one arrives" "$([ "$(grep -c $'\r' $T/live/$PORTAL/supabase/migrations/0001_a.sql)" -ge 1 ] && [ -f $T/live/$PORTAL/supabase/migrations/0002_b.sql ] && echo 1 || echo 0)" "$(od -c $T/live/$PORTAL/supabase/migrations/0001_a.sql | head -2)"
ok "S2b5 the deploy WAITED for the Job Portal's Postgres to stop before saving var/ (no half-written copy)" "$(grep -q 'waited .*s for the Job Portal database to stop' $T/state/sync.log && echo 1 || echo 0)" "$(grep -i 'portal database' $T/state/sync.log | tail -3)"
ok "S2b4 database backups made by the deploy: TeamLink dev.db, Job Portal var/, Green Start Postgres dump" "$(b=$(ls -dt /root/teamlink-backups/*-before-auto-deploy | head -1); g=$(ls -dt $T/state/backups/greenstart-* | head -1); [ -f $b/dev.db ] && [ -s $b/portal-var.tgz ] && tar -tzf $b/portal-var.tgz | grep -q db.sqlite && [ -f $g/greenstart-db.sql.gz ] && echo 1 || echo 0)" "$(ls -dt /root/teamlink-backups/*-before-auto-deploy | head -1)"
ok "S2c Green Start came from the submodule (main.ts g1, app.ts w1) and was BUILT (first deploy = everything is new)" "$([ "$(cat $T/gs/gs-api/src/main.ts)" = g1 ] && [ "$(cat $T/gs/green-start-web/src/app.ts)" = w1 ] && grep -q 'gs-api && npm run build' $T/calls.log && grep -q 'systemctl restart green-start-api' $T/calls.log && echo 1 || echo 0)" "$(tail -5 $T/calls.log)"
ok "S2c2 the helper file gate.mjs came from green-start-helpers/run of the MAIN repo; the database WAL file (newest rows) stayed" "$([ "$(cat $T/gs/run/gate.mjs)" = gate1 ] && [ "$(cat $T/live/backend/prisma/dev.db-wal 2>/dev/null)" = walrows ] && echo 1 || echo 0)" "$(ls $T/live/backend/prisma)"
ok "S2d deployed commit recorded; docs/ and sdk/ of Green Start are not on the server" "$([ "$(cat $T/state/deployed-commit)" = "$(mainhead)" ] && [ ! -e $T/gs/docs ] && [ ! -e $T/gs/gs-api/docs ] && echo 1 || echo 0)" "$(cat $T/state/STATUS)"
# ---- S3: quiet when nothing changed ----
: > $T/calls.log; out=$(run)
ok "S3 nothing new: nothing stopped or restarted, main untouched" "$(! grep -q pm2 $T/calls.log && ! grep -q systemctl $T/calls.log && [ "$(mainmsg)" = 'add the two submodules' ] && echo 1 || echo 0)" "$out"

# ---- S4: somebody pushes to the Green Start repo -> main follows by itself -> only Green Start is rebuilt ----
cd $T/dev_omni; echo g2 > gs-api/src/main.ts; git commit -qam "omni: change api"; git push -q origin main; cd $T
: > $T/calls.log; out=$(run)
ok "S4 omni repo push: main's pin moved by the VPS (commit 'Update submodule(s)')" "$(mainmsg | grep -q '^Update submodule(s): green-start-app@' && [ "$(pin green-start-app)" = "$(subhead omni)" ] && echo 1 || echo 0)" "$(mainmsg) / $out"
ok "S4b ...and deployed: main.ts g2 live, Green Start rebuilt + restarted, TeamLink NOT stopped" "$([ "$(cat $T/gs/gs-api/src/main.ts)" = g2 ] && grep -q 'gs-api && npm run build' $T/calls.log && grep -q 'systemctl restart green-start-api' $T/calls.log && ! grep -q 'pm2 stop' $T/calls.log && echo 1 || echo 0)" "$(cat $T/calls.log)"
ok "S4c the PC gets it too: after a pull the dev copy of main shows the same pin" "$(refresh_dev; [ "$(G $T/dev rev-parse HEAD:green-start-app)" = "$(subhead omni)" ] && echo 1 || echo 0)" ""

# ---- S5: a docs-only push to the Green Start repo does not move main or deploy ----
before=$(mainhead)
cd $T/dev_omni; echo n2 > docs/note.md; echo s2 > sdk/s.js; git commit -qam "omni: docs and sdk only"; git push -q origin main; cd $T
: > $T/calls.log; out=$(run)
ok "S5 docs/sdk-only change: main unchanged, nothing deployed" "$([ "$(mainhead)" = "$before" ] && ! grep -q pm2 $T/calls.log && ! grep -q systemctl $T/calls.log && echo 1 || echo 0)" "$out"

# ---- S6: a push to the Job Portal repo -> main follows -> TeamLink side redeployed, Green Start left alone ----
cd $T/dev_jp; echo j2 > api/x.js; git commit -qam "portal: change"; git push -q origin main; cd $T
: > $T/calls.log; out=$(run)
ok "S6 portal repo push: pin moved, portal file j2 live, TeamLink restarted, Green Start NOT touched" "$([ "$(pin $PORTAL)" = "$(subhead job_portal)" ] && [ "$(cat $T/live/$PORTAL/api/x.js)" = j2 ] && grep -q 'pm2 stop' $T/calls.log && ! grep -q systemctl $T/calls.log && echo 1 || echo 0)" "$out"

# ---- S7: the PC moves the pin by hand (a normal commit on main) -> deployed ----
refresh_dev
cd $T/dev_omni; git pull -q origin main; echo g3 > gs-api/src/main.ts; git commit -qam "omni: pc change"; git push -q origin main; cd $T
cd $T/dev/green-start-app && git fetch -q origin && git checkout -q origin/main && cd .. && git add green-start-app && git commit -qm "pc: use the newest Green Start" && git push -q origin main; cd $T
: > $T/calls.log; out=$(run)
ok "S7 PC moved the pin: Green Start g3 live" "$([ "$(cat $T/gs/gs-api/src/main.ts)" = g3 ] && grep -q 'systemctl restart green-start-api' $T/calls.log && echo 1 || echo 0)" "$out"

# ---- S8: with VPS_EDITS=1 an edit of a SUB REPO folder on the VPS is only REPORTED, never pushed (the sub repos belong to other accounts) ----
echo 'vps-j' > $T/live/$PORTAL/api/x.js
before_jp=$(subhead job_portal); before_main=$(mainhead)
out=$(run)
ok "S8 VPS edit inside the Job Portal folder: ALERT 'NOT pushed', the portal repo and main are unchanged" "$([ -f $T/state/ALERT ] && grep -q 'NOT pushed' $T/state/ALERT && [ "$(subhead job_portal)" = "$before_jp" ] && [ "$(mainhead)" = "$before_main" ] && echo 1 || echo 0)" "$out"
rm -f $T/state/ALERT; echo j2 > $T/live/$PORTAL/api/x.js; rsync -a --exclude var $T/live/$PORTAL/ $T/state/base/jobportal-main/

# ---- S9: with VPS_EDITS=1 an edit of the TeamLink code itself is pushed to main (step 1 stays available, but it is OFF by default) ----
echo 'vps-edit' > $T/live/backend/src/a.js
: > $T/calls.log; out=$(run)
ok "S9 VPS_EDITS=1: a.js edit reached main, and was not redeployed" "$([ "$(G $T/remote.git show main:backend/src/a.js)" = vps-edit ] && ! grep -q 'pm2 stop' $T/calls.log && echo 1 || echo 0)" "$out"

# ---- S13: ONE-WAY mode (the default, VPS_EDITS=0): nothing edited on the VPS is sent back, but the sub repos still flow into main and the VPS ----
echo hotfix > $T/live/backend/src/a.js
cd $T/dev_omni; git pull -q origin main; echo g9 > gs-api/src/main.ts; git commit -qam "omni: after the one-way switch"; git push -q origin main; cd $T
: > $T/calls.log; out=$(VPS_EDITS=0 run)
ok "S13 one-way: the hotfix on the VPS was NOT pushed to GitHub" "$([ "$(G $T/remote.git show main:backend/src/a.js)" != hotfix ] && echo 1 || echo 0)" "$out"
ok "S13b one-way: the Green Start repo still flowed into main (pin moved) and onto the VPS (g9 live)" "$(mainmsg | grep -q '^Update submodule(s):.*green-start-app@' && [ "$(pin green-start-app)" = "$(subhead omni)" ] && [ "$(cat $T/gs/gs-api/src/main.ts)" = g9 ] && echo 1 || echo 0)" "$(mainmsg) / $out"

# ---- S14: a require() that only works on Windows (letter case) must stop the deploy BEFORE the app is touched ----
cd $T/dev; git pull -q origin main; mkdir -p backend/src/routes; echo 'module.exports = 1' > backend/src/routes/followups.js; printf "const f = require('./routes/followUps');\n" > backend/src/index.js
git add -A; git commit -qm "bad letter case in a require"; git push -q origin main; cd $T
: > $T/calls.log; out=$(VPS_EDITS=0 run)
ok "S14 letter-case require: ALERT 'would crash on start', the app was NOT stopped" "$([ -f $T/state/ALERT ] && grep -q 'would crash on start' $T/state/ALERT && ! grep -q 'pm2 stop' $T/calls.log && echo 1 || echo 0)" "$out"
cd $T/dev; printf "const f = require('./routes/followups');\n" > backend/src/index.js; git commit -qam "fix the letter case"; git pull -q --rebase origin main; git push -q origin main; cd $T
: > $T/calls.log; out=$(VPS_EDITS=0 run)
ok "S14b after the fix the deploy goes through" "$(grep -q 'pm2 restart' $T/calls.log && [ ! -f $T/state/ALERT ] && echo 1 || echo 0)" "$out"

echo; echo "$pass passed, $fail failed"; rm -rf "$T/pkg"; [ "$fail" = 0 ]
