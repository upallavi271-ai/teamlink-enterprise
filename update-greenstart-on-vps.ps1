# ---------------------------------------------------------------------------
# UPDATE GREEN START ON THE LIVE SITE (greenstart.teamlinks.in, /opt/green-start on the VPS). 2026-10-31.
#
#   .\update-greenstart-on-vps.ps1           DRY RUN: uploads the new code, builds it NEXT TO the live one, shows which database changes
#                                            would run. Live Green Start keeps running and nothing is switched.
#   .\update-greenstart-on-vps.ps1 -Apply    does it: database backup, build next to live, a SHORT stop (switch + database changes),
#                                            start, health check. If the health check fails it switches back to the old code by itself.
#
# What goes live: Green Start "release" d2f52bce (30 Oct, the owner's fully tested version) + SEO -> Keyword Research.
# The archive: Desktop\TeamLink-GreenStart-VPS\green-start-update-20261031-kr.tar.gz (code only: no .env, no packages, no data).
# Kept as they are: gs-api/.env (secrets), green-start-web/.env.production, /opt/green-start/uploads, run/ (gate etc.), the database
# (only NEW tables are added: 5 changes of the release + 7 Keyword Research tables). The old code stays in /opt/green-start/.old-<time>.
# TeamLink (pm2, port 4010) is not touched. Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param([switch]$Apply, [string]$Archive = (Join-Path $env:USERPROFILE 'Desktop\TeamLink-GreenStart-VPS\green-start-update-20261031-kr.tar.gz'))
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
if (-not (Test-Path $Archive)) { throw "The update archive is not here: $Archive" }

Write-Host "[1/2] Uploading the new Green Start code ($([math]::Round((Get-Item $Archive).Length / 1MB, 1)) MB)..." -ForegroundColor Cyan
scp $Archive "${VpsHost}:/root/green-start-update.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }

$script = @'
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
MODE=__MODE__
ROOT=/opt/green-start; U=greenstart; SRC=/root/green-start-update.tar.gz
T=$(date +%Y%m%d-%H%M%S); NEW=$ROOT/.update-$T; OLD=$ROOT/.old-$T; BK=/var/backups/green-start
say() { echo "== $*"; }
as_gs() { runuser -u "$U" -- env HOME="$ROOT" NODE_OPTIONS=--max-old-space-size=3072 bash -c "$1"; }
[ -f "$SRC" ] || { echo "NO ARCHIVE AT $SRC"; exit 1; }
[ -f "$ROOT/gs-api/.env" ] || { echo "NO $ROOT/gs-api/.env - is Green Start installed here?"; exit 1; }
FREE=$(df -Pm "$ROOT" | awk 'NR==2{print $4}'); [ "$FREE" -gt 3000 ] || { echo "Only ${FREE} MB free disk: need 3000 MB."; exit 1; }

say "building the new code next to the live one (live keeps running) in $NEW"
install -d -o "$U" -g "$U" "$NEW"
tar -xzf "$SRC" -C "$NEW" --no-same-owner
install -m 600 -o "$U" -g "$U" "$ROOT/gs-api/.env" "$NEW/gs-api/.env"
[ -f "$ROOT/green-start-web/.env.production" ] && install -m 644 -o "$U" -g "$U" "$ROOT/green-start-web/.env.production" "$NEW/green-start-web/.env.production"
[ -d "$ROOT/gs-api/storage" ] && cp -a "$ROOT/gs-api/storage" "$NEW/gs-api/storage"
chown -R "$U:$U" "$NEW"
as_gs "cd '$NEW/gs-api' && nice -n 10 npm ci --no-audit --no-fund --loglevel=error && nice -n 10 npx prisma generate && nice -n 10 npm run build" > /root/gs-update-build-$T.log 2>&1 || { echo "API BUILD FAILED (log /root/gs-update-build-$T.log). Live was not touched."; tail -30 /root/gs-update-build-$T.log; exit 1; }
as_gs "cd '$NEW/green-start-web' && nice -n 10 npm ci --no-audit --no-fund --loglevel=error && nice -n 10 npm run build" >> /root/gs-update-build-$T.log 2>&1 || { echo "WEB BUILD FAILED (log /root/gs-update-build-$T.log). Live was not touched."; tail -30 /root/gs-update-build-$T.log; exit 1; }
[ -f "$NEW/gs-api/dist/main.js" ] && [ -f "$NEW/green-start-web/dist/index.html" ] || { echo "BUILD OUTPUT MISSING. Live was not touched."; exit 1; }
say "build ok"
say "database changes waiting (should be only what this package adds, e.g. 20261031140000_seo_keyword_research):"
MS=$(as_gs "cd '$NEW/gs-api' && set -a && . ./.env && set +a && npx prisma migrate status" 2>&1 || true)
echo "$MS" | grep -E "^20|following|up to date|not yet been applied|not found locally|have not been found" || true
# GUARD (2026-10-31): live already shows Reviews / Site Audit, so it may run a NEWER Green Start than this package. If the live
# database has changes this package does not know, switching would put OLDER code on a newer database: stop, change nothing.
if echo "$MS" | grep -qiE "not found locally|have not been found|applied to the database but"; then
  rm -rf "$NEW"
  echo "STOPPED: live Green Start is NEWER than this package (its database has changes the package does not have). Nothing was switched. Ask for a package built on the live version."
  exit 1
fi

if [ "$MODE" != apply ]; then
  rm -rf "$NEW"
  echo "DRY RUN OK: the new code builds on the server. Nothing was switched. Run again with -Apply."
  exit 0
fi

say "database backup"
install -d -m 700 "$BK"
runuser -u postgres -- pg_dump -Fc greenstart > "$BK/greenstart-before-update-$T.dump"
install -m 600 "$ROOT/gs-api/.env" "$BK/env-before-update-$T.copy"
echo "backup: $BK/greenstart-before-update-$T.dump"

say "short stop: switch + database changes"
systemctl stop green-start-worker green-start-api
if ! as_gs "cd '$NEW/gs-api' && set -a && . ./.env && set +a && npx prisma migrate deploy"; then
  echo "DATABASE CHANGES FAILED: starting the OLD code again (nothing switched)."; systemctl start green-start-api green-start-worker; exit 1
fi
install -d "$OLD"
mv "$ROOT/gs-api" "$OLD/gs-api"; mv "$ROOT/green-start-web" "$OLD/green-start-web"
mv "$NEW/gs-api" "$ROOT/gs-api"; mv "$NEW/green-start-web" "$ROOT/green-start-web"; rmdir "$NEW" 2>/dev/null || true
systemctl start green-start-api green-start-worker
systemctl restart green-start-gate

say "health check"
ok=0
for i in $(seq 1 60); do
  if curl -fsS -m 5 http://127.0.0.1:4020/api/v1/health > /dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ "$ok" != 1 ]; then
  echo "HEALTH CHECK FAILED: switching back to the old code."
  journalctl -u green-start-api -n 40 --no-pager || true
  systemctl stop green-start-worker green-start-api
  mv "$ROOT/gs-api" "$ROOT/.failed-$T-gs-api"; mv "$ROOT/green-start-web" "$ROOT/.failed-$T-green-start-web"
  mv "$OLD/gs-api" "$ROOT/gs-api"; mv "$OLD/green-start-web" "$ROOT/green-start-web"
  systemctl start green-start-api green-start-worker; systemctl restart green-start-gate
  echo "ROLLED BACK to the old code. The new tables stay in the database (the old code ignores them). Backup: $BK/greenstart-before-update-$T.dump"
  exit 1
fi
rm -f "$SRC"
echo "GREEN START UPDATED: release d2f52bce + Keyword Research. Old code kept in $OLD (delete it after a few good days)."
systemctl is-active green-start-api green-start-worker green-start-gate | paste -sd' '
'@
$mode = if ($Apply) { 'apply' } else { 'dry' }
$script = $script.Replace('__MODE__', $mode).Replace("`r", '')
Write-Host "[2/2] $(if ($Apply) { 'Updating Green Start on the VPS (backup, build next to live, short stop, health check)...' } else { 'DRY RUN on the VPS: building next to live, nothing is switched...' })" -ForegroundColor Cyan
# tr: PowerShell ends the piped text with a Windows line end, which bash would read as a command
$script | ssh $VpsHost 'tr -d ''\r'' | bash -s'
if ($LASTEXITCODE -ne 0) { throw 'The update on the VPS stopped (see the lines above). If it said ROLLED BACK, the old Green Start is running again.' }
if (-not $Apply) { Write-Host "`nDRY RUN finished. If it built fine, run:  .\update-greenstart-on-vps.ps1 -Apply" -ForegroundColor Yellow }
else { Write-Host "`nDone. Open https://greenstart.teamlinks.in (from TeamLink > Omni-Channel) > SEO > Keyword Research." -ForegroundColor Green }
