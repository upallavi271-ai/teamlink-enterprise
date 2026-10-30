# ---------------------------------------------------------------------------
# NAUKRI / SHINE MAIL RESPONSES -> ATS APPLICATIONS, ON THE LIVE SITE (founder 2026-10-30) - CHECK, and add only when asked.
#
#   .\check-mail-imports-on-vps.ps1            shows which ATS requirement each mail response goes to, and what waits (no change)
#   .\check-mail-imports-on-vps.ps1 -Apply     adds them to ATS Applications now (the server also does it after "Sync now" and hourly)
#
# Deploy first (.\deploy-local-to-vps.ps1). Copy the lines back to Claude if something looks wrong.
# ---------------------------------------------------------------------------
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$extra = if ($Apply) { ' --apply' } else { '' }
ssh $VpsHost "cd /opt/teamlink-enterprise/backend && [ -f scripts/mail-imports-check.js ] || { echo 'Deploy first: .\deploy-local-to-vps.ps1'; exit 1; }; node scripts/mail-imports-check.js --days=120$extra"
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
