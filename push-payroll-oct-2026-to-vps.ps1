# ---------------------------------------------------------------------------
# MAKE THE LIVE SITE'S OCTOBER 2026 PAYROLL = THE TEAM'S PAY REGISTER (founder 2026-10-28).
#
#   .\push-payroll-oct-2026-to-vps.ps1          DRY RUN on the VPS: runs everything on a throw-away copy of the live
#                                               database and prints the app's numbers next to the register's (nothing changes)
#   .\push-payroll-oct-2026-to-vps.ps1 -Apply   does it on the live database (a backup is taken first, see the last lines)
#   -Register "<path>"     the Pay Register (default: Desktop\All_Projects\payroll\Pay Register for Oct 2026.xlsx)
#   -Attendance "<path>"   the month's attendance sheet (default: Downloads\To pavan sharing sheet Sep16-Oct15_update.xlsx)
#   -Month 2026-10         the payroll month
#
# Uploads the two sheets and runs backend/scripts/payroll-from-register.js on the VPS: the pay-register rules from
# October 2026 on, one salary structure per person (the register's own amounts + PF rule + TDS), the month's payable
# days, then recalculates October 2026 (only Draft records; anything submitted / approved / paid is never touched).
# Expected: Group A 505,901.86 + Stipend 150,166.65 = 656,068.51.
# Deploy first (.\deploy-local-to-vps.ps1) so the VPS has the new code. Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param(
  [switch]$Apply,
  [string]$Register = (Join-Path $env:USERPROFILE 'Desktop\All_Projects\payroll\Pay Register for Oct 2026.xlsx'),
  [string]$Attendance = (Join-Path $env:USERPROFILE 'Downloads\To pavan sharing sheet Sep16-Oct15_update.xlsx'),
  [string]$Month = '2026-10'
)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
if (-not (Test-Path $Register)) { throw "The pay register is not here: $Register" }
if (-not (Test-Path $Attendance)) { throw "The attendance sheet is not here: $Attendance" }

Write-Host "[1/2] Uploading the two sheets..." -ForegroundColor Cyan
scp $Register "${VpsHost}:/root/pay-register.xlsx"
if ($LASTEXITCODE -ne 0) { throw 'Upload of the pay register failed.' }
scp $Attendance "${VpsHost}:/root/pay-attendance.xlsx"
if ($LASTEXITCODE -ne 0) { throw 'Upload of the attendance sheet failed.' }

$base = "node scripts/payroll-from-register.js --register /root/pay-register.xlsx --attendance /root/pay-attendance.xlsx --month $Month --out /root/teamlink-backups/payroll-from-register-$Month"
$cmd = if ($Apply) { "TL_ALLOW_REAL_APPLY=1 $base --apply --really-real" } else { $base }
Write-Host "[2/2] $(if ($Apply) { "Making the $Month payroll from the pay register on the VPS..." } else { 'Dry run on the VPS (nothing changes)...' })" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && $cmd"
if ($LASTEXITCODE -ne 0) { throw 'The run on the VPS failed or found a difference (see the lines above).' }
if (-not $Apply) { Write-Host "`nDRY RUN finished. If every line says 0.00 and the totals match, run:  .\push-payroll-oct-2026-to-vps.ps1 -Apply" -ForegroundColor Yellow }
else { Write-Host "`nDone. The backup of the live database before this run is under /root/.teamlink-backups/ on the VPS (named payroll-from-register-$Month-...db)." -ForegroundColor Green }
