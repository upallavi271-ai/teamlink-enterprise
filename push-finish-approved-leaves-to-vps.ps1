# ---------------------------------------------------------------------------
# EMPLOYEE LEAVES ALREADY GRANTED BUT STILL "PENDING" ON THE LIVE SITE (founder 2026-10-28: "employee 2 day leave TL approve chesthe
# malli chain lo Super Admin approve kosam wait cheyakudadu").
#
#   .\push-finish-approved-leaves-to-vps.ps1
#
# Leaves the TL approved within the TL limit (2 days) or HR approved BEFORE the 26 Oct rule still wait on the Super Admin. This
# shows them (dry run, nothing written), asks you to type YES, then makes them Approved exactly as the approve button does
# (a whole-database backup first; no message is sent). A TL's OWN leave is never touched - only the Super Admin approves it.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
Write-Host "`n=== Dry run: what would change (nothing is written) ===" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && node scripts/finish-approved-leaves.js"
if ($LASTEXITCODE -ne 0) { throw 'The dry run failed (see the lines above).' }
$ok = Read-Host "`nType YES to make these leaves Approved on the live site (anything else = stop)"
if ($ok -ne 'YES') { Write-Host 'Stopped. Nothing was changed.' -ForegroundColor Yellow; exit 0 }
ssh $VpsHost "cd $VpsRoot/backend && TL_ALLOW_REAL_APPLY=1 node scripts/finish-approved-leaves.js --apply --really-real"
if ($LASTEXITCODE -ne 0) { throw 'The change failed (see the lines above).' }
Write-Host "`nDONE." -ForegroundColor Green
