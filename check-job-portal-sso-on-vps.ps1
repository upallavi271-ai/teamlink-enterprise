# ---------------------------------------------------------------------------
# JOB PORTAL WITH THE TEAMLINK LOGIN, ON THE LIVE SITE (founder 2026-10-29: "recruiters ni separate logins adagakudadhu") - CHECK ONLY.
#
#   .\check-job-portal-sso-on-vps.ps1        (after .\deploy-local-to-vps.ps1)
#
# Runs backend/scripts/job-portal-sso-test.js on the server: the portal accepts TeamLink's sign-in tickets, refuses forged / used
# ones, TeamLink answers the portal's session checks - and it lists the Recruiters / TLs who have NO Job Portal account with the
# same email (they get "There is no Job Portal account for your email address yet" until an Admin adds them in the portal).
# Changes nothing and opens no session for any real person. Copy the lines back to Claude.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
ssh $VpsHost "cd $VpsRoot/backend && [ -f scripts/job-portal-sso-test.js ] || { echo 'Deploy first: .\deploy-local-to-vps.ps1'; exit 1; }; node scripts/job-portal-sso-test.js"
if ($LASTEXITCODE -ne 0) { Write-Host "`nSomething did not pass (see FAIL above). Copy these lines to Claude." -ForegroundColor Yellow }
else { Write-Host "`nAll checks passed. Recruiters / TLs listed above still need a Job Portal account with the same email." -ForegroundColor Green }
