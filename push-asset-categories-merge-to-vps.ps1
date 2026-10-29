# ---------------------------------------------------------------------------
# DUPLICATE ASSET CATEGORIES -> ONE NAME ON THE LIVE SITE (founder 2026-10-28: "Mobile / Mobile Phone, Headset / Head Set - okate pettu").
#
#   .\push-asset-categories-merge-to-vps.ps1
#
# Run it AFTER .\deploy-local-to-vps.ps1. It shows (dry run, nothing written) every category and which spellings become one
# ("Head Set" -> "Headset", "Mobile" -> "Mobile Phone", case / space differences -> the most-used spelling), asks you to type
# YES, then moves the assets, vendor category grants and the category's ledgers to the one name (a whole-database backup first;
# nothing is deleted except a repeated vendor grant).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
Write-Host "`n=== Dry run: what would change (nothing is written) ===" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && node scripts/merge-asset-categories.js"
if ($LASTEXITCODE -ne 0) { throw 'The dry run failed (see the lines above).' }
$ok = Read-Host "`nType YES to merge these categories on the live site (anything else = stop)"
if ($ok -ne 'YES') { Write-Host 'Stopped. Nothing was changed.' -ForegroundColor Yellow; exit 0 }
ssh $VpsHost "cd $VpsRoot/backend && node scripts/merge-asset-categories.js --apply"
if ($LASTEXITCODE -ne 0) { throw 'The merge failed (see the lines above).' }
Write-Host "`nDONE. Assets show one name per category." -ForegroundColor Green
