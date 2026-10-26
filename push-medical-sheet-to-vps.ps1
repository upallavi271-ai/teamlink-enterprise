# ---------------------------------------------------------------------------
# REPLACE THE MEDICAL REQUIREMENTS ON THE LIVE SITE WITH THE FOUNDER'S SHEET (2026-10-26).
#
#   .\push-medical-sheet-to-vps.ps1          DRY RUN on the VPS: the numbers (nothing changes)
#   .\push-medical-sheet-to-vps.ps1 -Apply   does it (backup + undo file on the VPS)
#   -DeleteOthers   AFTER the replace: delete every Medical requirement that is not in the sheet, with its candidate applications
#                   (founder 2026-10-26: "only the sheet's, nothing extra"); one with an invoice is kept. Dry run unless -Apply.
#   -Sheet "<path>"   another file (default: Downloads\Medical team requirements sheet.xlsx)
#
# Uploads the sheet and runs backend/scripts/replace-medical-requirements.js on the VPS: Running = open, Stopped = closed, a requirement
# already there is updated in place (its candidates stay), new ones are created, every other Medical requirement is CLOSED (never deleted).
# Deploy first (.\deploy-local-to-vps.ps1) so the VPS has the script. Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param([switch]$Apply, [switch]$DeleteOthers, [string]$Sheet = (Join-Path $env:USERPROFILE 'Downloads\Medical team requirements sheet.xlsx'))
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
if (-not (Test-Path $Sheet)) { throw "The sheet is not here: $Sheet" }

Write-Host "[1/2] Uploading the sheet..." -ForegroundColor Cyan
scp $Sheet "${VpsHost}:/root/medical-requirements.xlsx"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }

Write-Host "[2/2] $(if ($Apply) { 'Replacing the Medical requirements on the VPS...' } else { 'Dry run on the VPS (nothing changes)...' })" -ForegroundColor Cyan
$cmd = if ($Apply) { 'TL_ALLOW_REAL_APPLY=1 node scripts/replace-medical-requirements.js --file /root/medical-requirements.xlsx --apply --really-real --out /root/teamlink-backups/replace-medical-run' } else { 'node scripts/replace-medical-requirements.js --file /root/medical-requirements.xlsx' }
if ($DeleteOthers) {
  $cmd = if ($Apply) { 'TL_ALLOW_REAL_APPLY=1 node scripts/replace-medical-requirements.js --file /root/medical-requirements.xlsx --delete-others --with-candidates --apply --really-real' } else { 'node scripts/replace-medical-requirements.js --file /root/medical-requirements.xlsx --delete-others --with-candidates' }
}
ssh $VpsHost "cd $VpsRoot/backend && $cmd"
if ($LASTEXITCODE -ne 0) { throw 'The run on the VPS failed (see the lines above).' }
if (-not $Apply) { Write-Host "`nDRY RUN finished. If the numbers look right, run:  .\push-medical-sheet-to-vps.ps1 -Apply" -ForegroundColor Yellow }
else { Write-Host "`nDone. Undo (if ever needed), on the VPS:  cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/replace-medical-requirements.js --undo /root/teamlink-backups/replace-medical-run/undo.json --really-real" -ForegroundColor Green }
