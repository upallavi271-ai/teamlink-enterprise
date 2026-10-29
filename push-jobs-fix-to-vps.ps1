# ---------------------------------------------------------------------------
# MAKE https://teamlink.teamlinks.in/jobs/ SHOW THE REAL JOB PORTAL (founder 2026-10-29).
#
#   .\push-jobs-fix-to-vps.ps1
#
# nginx on the server answered /jobs/ itself from an old static copy (the Sep 2026 prototype with "Quick demo login"),
# so the real portal - the same version as localhost - was never reached. This sends deploy\vps\fix-jobs-nginx.sh and runs it:
# it adds one /jobs rule to the nginx site (backup first, put back if nginx refuses it) and checks the public page.
# No code, no database, no portal data is touched.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Script = Join-Path $PSScriptRoot 'deploy\vps\fix-jobs-nginx.sh'
if (-not (Test-Path $Script)) { throw "Missing $Script" }

# the server must get the file with Linux line endings
$Tmp = Join-Path $env:TEMP 'fix-jobs-nginx.sh'
[IO.File]::WriteAllText($Tmp, ([IO.File]::ReadAllText($Script)).Replace("`r", ''), (New-Object Text.UTF8Encoding($false)))
try {
  scp $Tmp "${VpsHost}:/root/fix-jobs-nginx.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload to the server.' }
  ssh $VpsHost 'bash /root/fix-jobs-nginx.sh; c=$?; rm -f /root/fix-jobs-nginx.sh; exit $c'
  if ($LASTEXITCODE -ne 0) { throw 'The fix stopped (see the lines above). Send this screen.' }
} finally {
  Remove-Item -Force $Tmp -ErrorAction SilentlyContinue
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
