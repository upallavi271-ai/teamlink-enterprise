# ---------------------------------------------------------------------------
# WHY ARE SOME CHECK-OUTS MISSING ON THE LIVE SITE? (founder 2026-10-28) - READ-ONLY, nothing is changed. No deploy needed:
# the check is copied to the server, run once against the live database, and removed.
#
#   .\diagnose-checkouts-on-vps.ps1                         (15 Oct to 26 Oct)
#   .\diagnose-checkouts-on-vps.ps1 -From 2026-10-15 -To 2026-10-26 -Code TL511
#
# Copy the top part (the counts) and a few of the day blocks back to Claude.
# ---------------------------------------------------------------------------
param([string]$From = '2026-10-15', [string]$To = '2026-10-26', [string]$Code = '')
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Remote = "/tmp/tl-diagnose-checkouts-$(Get-Date -Format 'yyyyMMddHHmmss').js"
scp -- "$Here\backend\scripts\diagnose-checkouts.js" "${VpsHost}:$Remote"
if ($LASTEXITCODE -ne 0) { throw 'Could not copy the check to the server.' }
$extra = if ($Code) { " --code $Code" } else { '' }
ssh $VpsHost "cd $VpsRoot/backend && TL_BACKEND=$VpsRoot/backend node $Remote --from $From --to $To$extra; rm -f $Remote"
