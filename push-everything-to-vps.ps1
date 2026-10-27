# ---------------------------------------------------------------------------
# EVERYTHING FROM THIS PC TO THE LIVE SITE, IN ONE GO (founder 2026-10-26: "ippati varaku chesina changes anni, complete ga server loki
# push avvali, include view agreement etc... anni").
#
#   .\push-everything-to-vps.ps1
#
# Runs, in this order (each step stops the whole run if it fails):
#   1  deploy the code (.\deploy-local-to-vps.ps1 - the live database is KEPT; new migrations apply there, e.g. attendance times)
#   2  the real signed agreement PDFs ("View agreement" shows the real signed copy)  - push-signed-agreements-to-vps.ps1 -Apply
#   3  keep only the signed-agreements zip clients                                   - push-zip-clients-only-to-vps.ps1 -Apply
#   4  ATS emptied and only the founder's sheets imported (2026-10-27): requirement sheets (Medical, Education, Manufacturing),
#      joinings sheets, joinings list; what Accounts invoices point at is kept       - push-ats-reset-to-vps.ps1 -Apply
#   5  whose candidate is it: applications get their recruiter (backfill-application-owners.js, backup first)
#   6  leaves already granted (TL within the limit, or HR) but still Pending -> Approved (finish-approved-leaves.js, backup first)
#   7  HRMS dashboard data: R&D TL Mrudula as reporting manager of her 3 people, the 3 demo announcements deleted (backup first)
#   8  the developer login as Super Admin (asks for its password; press Enter to skip; never stored or shown)
# (Step 4 replaces the earlier separate Medical / Education + Manufacturing / joinings steps: their scripts are still there and are run
#  by push-ats-reset-to-vps.ps1 in the right order.)
# Every data step backs up the live database first. Do not click inside this window while it runs (a click pauses PowerShell; press Enter
# to continue). The sheets are read from Downloads (see push-ats-reset-to-vps.ps1 for the file names).
#   -SkipDeploy   start from step 2 (the code is already deployed)
# ---------------------------------------------------------------------------
param([switch]$SkipDeploy)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
function Step($n, $text) { Write-Host "`n==================== STEP $n of 9: $text ====================" -ForegroundColor Cyan }

if (-not $SkipDeploy) {
  Step 1 'Deploying the code (live database kept)'
  & (Join-Path $Root 'deploy-local-to-vps.ps1')
  if (-not $?) { throw 'Step 1 (deploy) failed. Nothing else was run.' }
}

Step 2 'Real signed agreements (View agreement)'
& (Join-Path $Root 'push-signed-agreements-to-vps.ps1') -Apply

Step 3 'Only the signed-agreements zip clients'
& (Join-Path $Root 'push-zip-clients-only-to-vps.ps1') -Apply

Step 4 'ATS emptied; only the sheets imported (requirements + joinings)'
& (Join-Path $Root 'push-ats-reset-to-vps.ps1') -Apply

Step 5 'Applications: their recruiter (own-candidates rule)'
ssh $VpsHost "cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/backfill-application-owners.js --apply --really-real"
if ($LASTEXITCODE -ne 0) { throw 'Step 5 (owners) failed (see the lines above).' }

Step 6 'Leaves already granted but still Pending'
ssh $VpsHost "cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/finish-approved-leaves.js --apply --really-real"
if ($LASTEXITCODE -ne 0) { throw 'Step 6 (leaves) failed (see the lines above).' }

Step 7 'HRMS dashboard data (reporting manager, demo announcements)'
ssh $VpsHost "cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/hrms-dashboard-fixes-2026-10-27.js --apply --really-real"
if ($LASTEXITCODE -ne 0) { throw 'Step 7 (HRMS dashboard data) failed (see the lines above).' }

Step 8 'R&D designations (R&D TL, R&D-1, R&D-2, R&D-3; same permissions)'
ssh $VpsHost "cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/rnd-designations-2026-10-27.js --apply --really-real"
if ($LASTEXITCODE -ne 0) { throw 'Step 8 (R&D designations) failed (see the lines above).' }

Step 9 'Developer login (Super Admin)'
$sec = Read-Host 'Password for the developer login (press Enter to skip)' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if ($plain) {
  $quoted = "'" + ($plain -replace "'", "'\''") + "'"
  ssh $VpsHost "cd $VpsRoot/backend && TL_NEW_PASSWORD=$quoted TL_ALLOW_REAL_APPLY=1 node scripts/create-developer-login.js --apply --really-real && TL_ALLOW_REAL_APPLY=1 node scripts/create-developer-login.js --make-super-admin --apply --really-real"
  if ($LASTEXITCODE -ne 0) { throw 'Step 9 (developer login) failed (see the lines above).' }
  $plain = $null
} else { Write-Host 'Skipped.' -ForegroundColor Yellow }

Write-Host "`nALL DONE. Open https://teamlink.teamlinks.in and check: Requirements and Joining (only the sheets), Attendance, Apply Leave, Clients (View agreement), HRMS dashboard." -ForegroundColor Green
