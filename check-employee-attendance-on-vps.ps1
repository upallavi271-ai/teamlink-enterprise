# ---------------------------------------------------------------------------
# WHY DO EMPLOYEE LOGINS SHOW NO ATTENDANCE ON THE LIVE SITE? (founder 2026-10-28) - READ-ONLY, nothing is changed.
#
#   .\check-employee-attendance-on-vps.ps1                 (from 13 Oct to today)
#   .\check-employee-attendance-on-vps.ps1 -Code TL306     (one person)
#
# Run it AFTER .\deploy-local-to-vps.ps1 (the script must be on the server). For every active employee it shows whether a login is
# linked, how many attendance rows / punches / imported days the live database has, and what that person's My Attendance screen
# shows. Copy the PROBLEMS part back to Claude.
# ---------------------------------------------------------------------------
param([string]$From = '2026-10-13', [string]$Code = '')
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$extra = if ($Code) { " --code $Code" } else { '' }
ssh $VpsHost "cd $VpsRoot/backend && node scripts/check-employee-attendance.js --from $From$extra"
if ($LASTEXITCODE -ne 0) { throw 'The check failed (see the lines above).' }
