# ---------------------------------------------------------------------------
# PUT THE REAL SIGNED AGREEMENTS ON THE LIVE SITE (founder 2026-10-26).
#
#   .\push-signed-agreements-to-vps.ps1          DRY RUN on the VPS: shows what would be added (nothing changes)
#   .\push-signed-agreements-to-vps.ps1 -Apply   adds them (backup + undo file on the VPS)
#
# It packs the signed agreement files of this PC (backend/scripts/signed-agreements-bundle.js export: the files unchanged + manifest.json),
# uploads the pack to the VPS and runs the same script's "import" there. The import only ADDS the files to the matching clients (same id,
# else same name); it never changes a client's agreement step and never adds a file twice. Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$Root = $PSScriptRoot
$Bundle = Join-Path $env:TEMP 'tl-signed-bundle'
$Archive = Join-Path $env:TEMP 'tl-signed-bundle.tar.gz'

Write-Host "[1/4] Packing the signed agreements of this PC..." -ForegroundColor Cyan
if (Test-Path $Bundle) { Remove-Item $Bundle -Recurse -Force }
Push-Location (Join-Path $Root 'backend')
node scripts/signed-agreements-bundle.js export --out $Bundle
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Packing failed.' }
Pop-Location

Write-Host "[2/4] Compressing..." -ForegroundColor Cyan
if (Test-Path $Archive) { Remove-Item $Archive -Force }
tar -czf $Archive -C $Bundle .
Write-Host ("Pack: {0:N1} MB" -f ((Get-Item $Archive).Length / 1MB)) -ForegroundColor Green

Write-Host "[3/4] Uploading to the VPS (this can take a few minutes)..." -ForegroundColor Cyan
scp $Archive "${VpsHost}:/root/tl-signed-bundle.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }

Write-Host "[4/4] $(if ($Apply) { 'Adding them on the VPS...' } else { 'Dry run on the VPS (nothing changes)...' })" -ForegroundColor Cyan
$applyArgs = if ($Apply) { 'TL_ALLOW_REAL_APPLY=1 node scripts/signed-agreements-bundle.js import --bundle /root/tl-signed-bundle --apply --really-real' } else { 'node scripts/signed-agreements-bundle.js import --bundle /root/tl-signed-bundle' }
ssh $VpsHost "rm -rf /root/tl-signed-bundle && mkdir -p /root/tl-signed-bundle && tar -xzf /root/tl-signed-bundle.tar.gz -C /root/tl-signed-bundle && cd $VpsRoot/backend && $applyArgs"
if ($LASTEXITCODE -ne 0) { throw 'The import on the VPS failed (see the lines above).' }
if (-not $Apply) { Write-Host "`nDRY RUN finished. If the numbers look right, run:  .\push-signed-agreements-to-vps.ps1 -Apply" -ForegroundColor Yellow }
else { Write-Host "`nDone. Open a client on https://teamlink.teamlinks.in and press the agreement PDF: the real signed file opens." -ForegroundColor Green }
