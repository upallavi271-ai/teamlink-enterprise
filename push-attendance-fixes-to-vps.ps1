# ---------------------------------------------------------------------------
# ALL THE ATTENDANCE FIXES ON THE LIVE SITE, IN ORDER (founder 2026-10-28: "employee logins lo attendance update kaledu").
#
#   .\push-attendance-fixes-to-vps.ps1
#   .\push-attendance-fixes-to-vps.ps1 -Files "C:\...\bio-metric_logs.csv","C:\...\first_check-in_&_last_check-out_report.csv"
#
#   1. deploy-local-to-vps.ps1          the new code (device check-out rule, importer that adds the device's own times)
#   2. push-biometric-checkout-fix      past device punches read by the key pressed / evening press = check-out (dry run, YES)
#   3. push-attendance-files            each given PulseHRM file set imported again (dry run, YES) - nothing is doubled
#   4. check-employee-attendance        read-only: what each employee's My Attendance shows now
# Each step stops the run if it fails.
# ---------------------------------------------------------------------------
param([string[]]$Files = @(
  "$env:USERPROFILE\Downloads\bio-metric_logs (9).csv",
  "$env:USERPROFILE\Downloads\first_check-in_&_last_check-out_report_form_16-oct-2026_to_22-oct-2026.csv"
))
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "`n=== 1/4 Deploy the new code ===" -ForegroundColor Cyan
& "$Here\deploy-local-to-vps.ps1"

Write-Host "`n=== 2/4 Device check-outs ===" -ForegroundColor Cyan
& "$Here\push-biometric-checkout-fix-to-vps.ps1"

$have = @($Files | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($have.Count) {
  Write-Host "`n=== 3/4 Import the attendance files again ===" -ForegroundColor Cyan
  & "$Here\push-attendance-files-to-vps.ps1" @have
} else {
  Write-Host "`n=== 3/4 skipped: no attendance files found ===" -ForegroundColor Yellow
}

Write-Host "`n=== 4/4 What employees see now ===" -ForegroundColor Cyan
& "$Here\check-employee-attendance-on-vps.ps1"
