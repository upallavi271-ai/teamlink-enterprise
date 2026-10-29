# ---------------------------------------------------------------------------
# PUT SRAVANTHI'S JOB PORTAL DATA ON THE LIVE SITE (founder 2026-10-29: back up first, then REPLACE).
#
#   .\push-job-portal-data-to-vps.ps1 -Zip "C:\Users\user\Desktop\teamlink-data-for-server-<date>.zip"            DRY RUN on the server
#   .\push-job-portal-data-to-vps.ps1 -Zip "C:\Users\user\Desktop\teamlink-data-for-server-<date>.zip" -Apply     REPLACE the live portal data
#
# The zip is the one EXPORT-DATA-FOR-SERVER.bat made on Sravanthi's PC. Only its two data files go to the server
# (teamlink-data.ndjson.gz, uploads.tar.gz); env-from-pc.txt (her PC's passwords) never leaves this PC.
# On the server, job-portal-app/embed/load-portal-data.mjs stops the portal, BACKS UP its data
# (job-portal-app/backups/before-data-load-<time>), loads the rows with the portal's own loader in one transaction
# (all or nothing), replaces the uploads and starts the portal again. Run push-everything-to-vps.ps1 FIRST, so the
# server has the same Job Portal code as the PC the data came from (the loader refuses different migrations).
# ---------------------------------------------------------------------------
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$Remote = '/root/jp-data'

if (-not (Test-Path $Zip)) { throw "The zip is not here: $Zip" }
$work = Join-Path $env:TEMP ("jp-data-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if ((Get-Item $Zip).PSIsContainer) { Copy-Item -Path (Join-Path $Zip '*') -Destination $work -Recurse } else { Expand-Archive -Path $Zip -DestinationPath $work -Force }
  $rows = Get-ChildItem -Path $work -Recurse -Filter 'teamlink-data.ndjson.gz' | Select-Object -First 1
  $ups = Get-ChildItem -Path $work -Recurse -Filter 'uploads.tar.gz' | Select-Object -First 1
  if (-not $rows) { throw 'The zip has no teamlink-data.ndjson.gz - make it with EXPORT-DATA-FOR-SERVER.bat on Sravanthi''s PC.' }

  Write-Host "[upload] the Job Portal data (rows$(if ($ups) { ' + uploads' }), no passwords)..." -ForegroundColor Cyan
  ssh $VpsHost "rm -rf $Remote && mkdir -p $Remote && chmod 700 $Remote"
  if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server.' }
  scp $rows.FullName "${VpsHost}:$Remote/teamlink-data.ndjson.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Upload of the rows failed.' }
  if ($ups) { scp $ups.FullName "${VpsHost}:$Remote/uploads.tar.gz"; if ($LASTEXITCODE -ne 0) { throw 'Upload of the uploads failed.' } }

  $envLine = "export `$(grep -E '^(JOB_PORTAL_PORT|JOB_PORTAL_DIR|JOB_PORTAL_RUN_DIR)=' $VpsRoot/backend/.env | xargs) >/dev/null 2>&1;"
  Write-Host "[dry run] checking everything on the server (nothing is kept)..." -ForegroundColor Cyan
  ssh $VpsHost "$envLine cd $VpsRoot && node job-portal-app/embed/load-portal-data.mjs --zip $Remote"
  if ($LASTEXITCODE -ne 0) { throw 'The dry run stopped - nothing was changed on the server (see the message above).' }

  if ($Apply) {
    Write-Host "[apply] replacing the live Job Portal data (a backup is taken first)..." -ForegroundColor Yellow
    ssh $VpsHost "$envLine cd $VpsRoot && node job-portal-app/embed/load-portal-data.mjs --zip $Remote --apply && rm -rf $Remote"
    if ($LASTEXITCODE -ne 0) { throw 'The load stopped - the server data is as it was (backup kept in job-portal-app/backups).' }
    Write-Host 'Done. The Job Portal starts again in about 10 seconds with the new data.' -ForegroundColor Green
  } else {
    Write-Host 'Dry run passed. Run again with -Apply to replace the live Job Portal data.' -ForegroundColor Green
  }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
