# ---------------------------------------------------------------------------
# NAUKRI / SHINE MAILBOXES "NOT CONFIGURED" AFTER THE DATA LOAD (founder 2026-10-29) - let the Job Portal save mailbox passwords.
#
#   .\set-job-portal-mail-key.ps1
#
# The portal keeps each mailbox app password encrypted with INTEGRATION_SECRET_KEY. The live server (and this PC) never had one:
# the passwords that came with Sravanthi's data are locked with HER PC's key, and new ones cannot be saved either.
# This gives the live server and this PC their own key (generated, never shown) and restarts the Job Portal. A key that is already
# there is kept. Afterwards enter each app password again in TeamLink:
#   Administration > Integrations > Job Portal settings > Naukri & Shine mailboxes > Reconnect (or Connect for a new one).
# ---------------------------------------------------------------------------
param([switch]$SkipLocal)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Name = 'JOBPORTAL__INTEGRATION_SECRET_KEY'
$Sh = Join-Path $PSScriptRoot 'deploy\vps\set-portal-secret-key.sh'

Write-Host '[1/2] live server: Job Portal key (and a Job Portal restart, up to 3 minutes)...' -ForegroundColor Cyan
$Tmp = Join-Path $env:TEMP 'set-portal-secret-key.sh'
[IO.File]::WriteAllText($Tmp, ([IO.File]::ReadAllText($Sh)).Replace("`r", ''), (New-Object Text.UTF8Encoding($false)))
try {
  scp $Tmp "${VpsHost}:/root/set-portal-secret-key.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload to the server. Nothing was changed there.' }
} finally { Remove-Item -Force $Tmp -ErrorAction SilentlyContinue }
ssh $VpsHost 'bash /root/set-portal-secret-key.sh; c=$?; rm -f /root/set-portal-secret-key.sh; exit $c'
if ($LASTEXITCODE -ne 0) { throw 'The server step stopped (see the lines above). Send this screen.' }

if (-not $SkipLocal) {
  Write-Host '[2/2] this PC (localhost): Job Portal key...' -ForegroundColor Cyan
  $LocalEnv = Join-Path $PSScriptRoot 'backend\.env'
  $lines = @(Get-Content -LiteralPath $LocalEnv)
  if ($lines | Where-Object { $_ -match "^$Name=.{16,}" }) {
    Write-Host '      already set - kept as it is.'
  } else {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $lines = @($lines | Where-Object { $_ -notmatch "^$Name=" }) + ("$Name=" + (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
    [IO.File]::WriteAllLines($LocalEnv, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
    $bytes = $null; $lines = $null
    Write-Host '      new key saved in backend\.env (not shown). Restart localhost with the Desktop "Start TeamLink.bat".'
  }
}

Write-Host ''
Write-Host 'DONE. Now enter the app passwords again in TeamLink (live site):' -ForegroundColor Green
Write-Host '  Administration > Integrations > Job Portal settings > Naukri & Shine mailboxes' -ForegroundColor Green
Write-Host '  each mailbox: Reconnect > paste its 16-character app password > Reconnect (the login is tested before it is saved).' -ForegroundColor Green
Write-Host '  teamlinkmed001@tmlink.in and mteamlink@gmail.com: the same (or Connect if they are not in the list).' -ForegroundColor Green
Write-Host 'Mail is then read every 5 minutes; Sync now reads it at once.' -ForegroundColor Green
