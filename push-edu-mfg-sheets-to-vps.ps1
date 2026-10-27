# ---------------------------------------------------------------------------
# EDUCATION + MANUFACTURING REQUIREMENTS ON THE LIVE SITE = THE FOUNDER'S SHEETS (2026-10-27).
#
#   .\push-edu-mfg-sheets-to-vps.ps1          DRY RUN on the VPS: the numbers (nothing changes)
#   .\push-edu-mfg-sheets-to-vps.ps1 -Apply   does it (the whole live database is backed up first, on the VPS)
#   -Edu "<path>" / -Mfg "<path>"   other files (default: Downloads\Edu - 2 Requirement Sheet  (3).xlsx and
#                                   Downloads\ManuFacture Requirements  Sheet.xlsx)
#
# Uploads the two sheets and runs backend/scripts/replace-edu-mfg-requirements.js on the VPS: each sheet position takes over the client's
# best-fitting requirement (official name from the sheet, its candidates stay) or is created; every other Education / Manufacturing
# requirement is DELETED with its candidate applications (one with an invoice is closed instead). Only zip clients count, so run it AFTER
# .\push-zip-clients-only-to-vps.ps1 -Apply. Deploy first (.\deploy-local-to-vps.ps1) so the VPS has the script.
# Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param(
  [switch]$Apply,
  [string]$Edu = (Join-Path $env:USERPROFILE 'Downloads\Edu - 2 Requirement Sheet  (3).xlsx'),
  [string]$Mfg = (Join-Path $env:USERPROFILE 'Downloads\ManuFacture Requirements  Sheet.xlsx')
)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
foreach ($f in @($Edu, $Mfg)) { if (-not (Test-Path $f)) { throw "The sheet is not here: $f" } }

Write-Host "[1/2] Uploading the two sheets..." -ForegroundColor Cyan
scp $Edu "${VpsHost}:/root/education-requirements.xlsx"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed (Education sheet).' }
scp $Mfg "${VpsHost}:/root/manufacturing-requirements.xlsx"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed (Manufacturing sheet).' }

Write-Host "[2/2] $(if ($Apply) { 'Replacing the Education + Manufacturing requirements on the VPS...' } else { 'Dry run on the VPS (nothing changes)...' })" -ForegroundColor Cyan
$files = '--edu /root/education-requirements.xlsx --mfg /root/manufacturing-requirements.xlsx --out /root/teamlink-backups/replace-edu-mfg-run'
$cmd = if ($Apply) { "TL_ALLOW_REAL_APPLY=1 node scripts/replace-edu-mfg-requirements.js $files --apply --really-real" } else { "node scripts/replace-edu-mfg-requirements.js $files" }
ssh $VpsHost "cd $VpsRoot/backend && $cmd"
if ($LASTEXITCODE -ne 0) { throw 'The run on the VPS failed (see the lines above).' }
if (-not $Apply) { Write-Host "`nDRY RUN finished. If the numbers look right, run:  .\push-edu-mfg-sheets-to-vps.ps1 -Apply" -ForegroundColor Yellow }
else { Write-Host "`nDone. The backup path is printed above (to undo: stop TeamLink on the VPS and copy that backup over the live database)." -ForegroundColor Green }
