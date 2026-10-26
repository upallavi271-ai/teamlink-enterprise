# ---------------------------------------------------------------------------
# ONLY THE SIGNED-AGREEMENTS ZIP CLIENTS ON THE LIVE SITE (founder 2026-10-26: "zip file lo ey clients vuntey, vallu matramey vundali").
#
#   .\push-zip-clients-only-to-vps.ps1          DRY RUN on the VPS: how many clients / requirements / applications / invoices would go
#   .\push-zip-clients-only-to-vps.ps1 -Apply   does it (whole-database backup first, on the VPS under /root/.teamlink-backups)
#
# Runs backend/scripts/keep-only-zip-clients.js on the VPS: every client that does not hold a signed agreement file is deleted with its
# requirements, candidate applications and invoices (candidate profiles stay).
# ORDER: 1) .\deploy-local-to-vps.ps1   2) .\push-signed-agreements-to-vps.ps1 -Apply   3) this.
# It refuses when fewer than 200 clients on the VPS hold a signed file (step 2 not done yet). Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'

Write-Host "$(if ($Apply) { 'Deleting the clients that are not in the zip, on the VPS...' } else { 'Dry run on the VPS (nothing changes)...' })" -ForegroundColor Cyan
$cmd = if ($Apply) { 'TL_ALLOW_REAL_APPLY=1 node scripts/keep-only-zip-clients.js --min-keep 200 --apply --really-real' } else { 'node scripts/keep-only-zip-clients.js --min-keep 200' }
ssh $VpsHost "cd $VpsRoot/backend && $cmd"
if ($LASTEXITCODE -ne 0) { throw 'The run on the VPS failed (see the lines above).' }
if (-not $Apply) { Write-Host "`nDRY RUN finished. If the numbers look right, run:  .\push-zip-clients-only-to-vps.ps1 -Apply" -ForegroundColor Yellow }
else { Write-Host "`nDone. The backup path is printed above (undo = put that file back while TeamLink is stopped)." -ForegroundColor Green }
