# ---------------------------------------------------------------------------
# THE JOININGS LIST ON THE LIVE SITE = THE JOININGS SHEETS (2026-10-27).
#
#   .\push-joinings-sheets-to-vps.ps1          DRY RUN on the VPS: the numbers (nothing changes)
#   .\push-joinings-sheets-to-vps.ps1 -Apply   does it (every step backs up the live database first, on the VPS)
#   -Med / -Edu / -Mfg "<path>"   other files (default: the three joinings sheets in Downloads)
#
# Uploads the three joinings sheets, then on the VPS:
#   1  scripts/restore-joining-clients.js        the 26 colleges the zip clean-up removed that still have joinings come back as INACTIVE
#   2  scripts/import-joinings-2026-10-17.js     every sheet row in (candidates, closed requirements, applications); safe to run twice
#   3  scripts/sync-joinings-list-to-sheets.js   joined but not in a sheet -> back to Selected (an invoiced one stays); the Joining
#                                                screen's list loses the records of deleted applications and gets the missing ones
# Run it AFTER .\push-zip-clients-only-to-vps.ps1 -Apply (it needs that clean-up's backup on the VPS). Deploy first.
# Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param(
  [switch]$Apply,
  [string]$Med = (Join-Path $env:USERPROFILE 'Downloads\_Medical Team Joinings Sheet .xlsx'),
  [string]$Edu = (Join-Path $env:USERPROFILE 'Downloads\Education-Team Joinings-2022-2025.xlsx'),
  [string]$Mfg = (Join-Path $env:USERPROFILE 'Downloads\Manufacturing-Joing sheet (3).xlsx')
)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
foreach ($f in @($Med, $Edu, $Mfg)) { if (-not (Test-Path $f)) { throw "The sheet is not here: $f" } }

Write-Host "[1/4] Uploading the three joinings sheets..." -ForegroundColor Cyan
ssh $VpsHost "mkdir -p /root/joinings"
# the import reads these exact file names (scripts/lib/joinings-2026-10-17/parse.js)
scp $Med "${VpsHost}:'/root/joinings/_Medical Team Joinings Sheet .xlsx'"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed (Medical sheet).' }
scp $Edu "${VpsHost}:'/root/joinings/Education-Team Joinings-2022-2025.xlsx'"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed (Education sheet).' }
scp $Mfg "${VpsHost}:'/root/joinings/Manufacturing-Joing sheet (1).xlsx'"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed (Manufacturing sheet).' }

$real = if ($Apply) { 'TL_ALLOW_REAL_APPLY=1 ' } else { '' }
$go = if ($Apply) { ' --apply --really-real' } else { '' }

Write-Host "[2/4] Colleges with joinings back as Inactive clients$(if (-not $Apply) { ' (dry run)' })..." -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && ${real}node scripts/restore-joining-clients.js$go"
if ($LASTEXITCODE -ne 0) { throw 'Step 2 failed (see the lines above).' }

Write-Host "[3/4] Joinings from the sheets$(if (-not $Apply) { ' (dry run)' })..." -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && ${real}node scripts/import-joinings-2026-10-17.js --only joinings --downloads /root/joinings --out /root/teamlink-backups/import-joinings-run$go"
if ($LASTEXITCODE -ne 0) { throw 'Step 3 failed (see the lines above).' }

if ($Apply) {
  Write-Host "[4/4] Joinings list = the sheets..." -ForegroundColor Cyan
  ssh $VpsHost "cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/sync-joinings-list-to-sheets.js --apply --really-real"
  if ($LASTEXITCODE -ne 0) { throw 'Step 4 failed (see the lines above).' }
  Write-Host "`nDone. Open Joining -> Joined and dropped on the live site." -ForegroundColor Green
} else {
  Write-Host "[4/4] (runs with -Apply, after the import has written the rows)" -ForegroundColor Cyan
  Write-Host "`nDRY RUN finished. If the numbers look right, run:  .\push-joinings-sheets-to-vps.ps1 -Apply" -ForegroundColor Yellow
}
