# ---------------------------------------------------------------------------
# BIOMETRIC CHECK-OUT FIX ON THE LIVE SITE (founder 2026-10-28: "biometric device lo check-out button click chesi check-out vesaru, adi
# update kavadam ledu" + employees see "Missing Check-Out").
#
#   .\push-biometric-checkout-fix-to-vps.ps1
#
# Run it AFTER .\deploy-local-to-vps.ps1 (the new rule must be on the server first). It:
#   1. shows (dry run, nothing written) which keys the device really sends and which past device punches read the wrong way -
#      e.g. an evening Check-Out press that arrived as "Check-In" (the device left in Check-In mode);
#   2. asks you to type YES, then corrects them and re-marks those days (check-in / check-out / Present-Late). Hand-set times stand.
# New punches follow the rule by themselves after the deploy. Every change is in the audit log.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
Write-Host "`n=== Dry run: what would change (nothing is written) ===" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && node scripts/fix-biometric-directions.js --from 2026-10-01"
if ($LASTEXITCODE -ne 0) { throw 'The dry run failed (see the lines above).' }
$ok = Read-Host "`nType YES to correct these punches on the live site (anything else = stop)"
if ($ok -ne 'YES') { Write-Host 'Stopped. Nothing was changed.' -ForegroundColor Yellow; exit 0 }
ssh $VpsHost "cd $VpsRoot/backend && node scripts/fix-biometric-directions.js --from 2026-10-01 --commit"
if ($LASTEXITCODE -ne 0) { throw 'The fix failed (see the lines above).' }
Write-Host "`nDONE. Open Attendance: the evening device punches now read as check-outs." -ForegroundColor Green
