# ---------------------------------------------------------------------------
# MAKE https://teamlink.teamlinks.in/jobs/ SHOW THE REAL JOB PORTAL (founder 2026-10-29).
#
#   .\push-jobs-fix-to-vps.ps1            CHECK only (shows what would be fixed, changes nothing)
#   .\push-jobs-fix-to-vps.ps1 -Apply     FIX
#
# Two problems on the server, both fixed here:
#   1. The Job Portal does not start since the data load: "migration 0003_seed.sql was edited". It was not - the server's file has
#      Windows line endings and the loader recorded the Linux ones. job-portal-app\embed\fix-migration-line-endings.mjs corrects
#      ONLY such line-ending-only checksums (old values saved in job-portal-app/backups; a real difference stops it, nothing changed).
#   2. nginx answered /jobs/ itself from an old static copy (the Sep 2026 prototype with "Quick demo login"). deploy\vps\fix-jobs-nginx.sh
#      adds one /jobs rule next to /api (site file backed up; put back if nginx refuses it).
# No portal code, no candidates / jobs / logins are touched.
# ---------------------------------------------------------------------------
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$Sh = Join-Path $PSScriptRoot 'deploy\vps\fix-jobs-nginx.sh'
$Mjs = Join-Path $PSScriptRoot 'job-portal-app\embed\fix-migration-line-endings.mjs'
foreach ($f in @($Sh, $Mjs)) { if (-not (Test-Path $f)) { throw "Missing $f" } }

# the server must get the files with Linux line endings
$Tmp = Join-Path $env:TEMP ('jobs-fix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($f in @($Sh, $Mjs)) { [IO.File]::WriteAllText((Join-Path $Tmp (Split-Path $f -Leaf)), ([IO.File]::ReadAllText($f)).Replace("`r", ''), $utf8) }
try {
  Write-Host '[upload] the two fix scripts...' -ForegroundColor Cyan
  scp (Join-Path $Tmp 'fix-migration-line-endings.mjs') "${VpsHost}:$VpsRoot/job-portal-app/embed/fix-migration-line-endings.mjs"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload to the server.' }
  scp (Join-Path $Tmp 'fix-jobs-nginx.sh') "${VpsHost}:/root/fix-jobs-nginx.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload to the server.' }

  $envLine = "export `$(grep -E '^(JOB_PORTAL_PORT|JOB_PORTAL_DIR|JOB_PORTAL_RUN_DIR)=' $VpsRoot/backend/.env | xargs) >/dev/null 2>&1;"
  Write-Host '[1/2] Job Portal start-up check (migration checksums)...' -ForegroundColor Cyan
  ssh $VpsHost "$envLine cd $VpsRoot && node job-portal-app/embed/fix-migration-line-endings.mjs"
  if ($LASTEXITCODE -ne 0) { throw 'The check stopped - nothing was changed on the server (see the lines above). Send this screen.' }

  if (-not $Apply) {
    Write-Host 'Check done, nothing changed. Run again with -Apply to fix:  .\push-jobs-fix-to-vps.ps1 -Apply' -ForegroundColor Green
    exit 0
  }
  ssh $VpsHost "$envLine cd $VpsRoot && node job-portal-app/embed/fix-migration-line-endings.mjs --apply"
  if ($LASTEXITCODE -ne 0) { throw 'The fix stopped - see the lines above. Send this screen.' }

  Write-Host '[2/2] nginx: /jobs to the real portal...' -ForegroundColor Cyan
  ssh $VpsHost 'bash /root/fix-jobs-nginx.sh; c=$?; rm -f /root/fix-jobs-nginx.sh; exit $c'
  if ($LASTEXITCODE -ne 0) { throw 'The nginx step stopped (see the lines above). Send this screen.' }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

try {
  $page = (Invoke-WebRequest -UseBasicParsing -Uri 'https://teamlink.teamlinks.in/jobs/' -TimeoutSec 30).Content
  if ($page -like '*NOTHING ON THIS PAGE HINTS AT A CREDENTIAL*') {
    Write-Host 'DONE: https://teamlink.teamlinks.in/jobs/ is the new Job Portal (same as localhost). Open it and press Ctrl+F5.' -ForegroundColor Green
  } else {
    Write-Host 'The server says it is fixed, but this PC still gets the old page - press Ctrl+F5 in the browser and check again.' -ForegroundColor Yellow
  }
} catch {
  Write-Host "Could not open the public page from this PC: $($_.Exception.Message)" -ForegroundColor Yellow
}
