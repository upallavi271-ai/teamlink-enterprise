# ---------------------------------------------------------------------------
# JOB PORTAL LOGINS FOR EVERY HRMS RECRUITER / TL, ON THE LIVE SITE (founder 2026-10-29: "ahh positions lo new ga add ina employee
# kanipinchadamledhu").
#
#   .\sync-job-portal-recruiters-on-vps.ps1        (after .\deploy-local-to-vps.ps1)
#
# Shows first who would get a Job Portal recruiter login (an active HRMS Recruiter / TL / STL with no portal login of the same
# email), then makes them only when you type YES. They then appear in Integrations -> Naukri & Shine mailboxes and open the Job
# Portal from TeamLink without a password. Nothing that exists is changed or removed. After the deploy the server also does this
# by itself (every Job Portal sync, and when the mailbox screen opens), so this is the "do it now and show me" button.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Run = "cd /opt/teamlink-enterprise/backend && [ -f scripts/sync-job-portal-recruiters.js ] || { echo 'Deploy first: .\deploy-local-to-vps.ps1'; exit 1; }; node scripts/sync-job-portal-recruiters.js"
ssh $VpsHost $Run
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
$answer = Read-Host "`nType YES to make the logins listed above (anything else stops here)"
if ($answer -ne 'YES') { Write-Host 'Stopped. Nothing was changed.'; exit 0 }
ssh $VpsHost "$Run --apply"
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
Write-Host "`nDone. They now show in Integrations -> Naukri & Shine mailboxes and open the Job Portal from TeamLink." -ForegroundColor Green
