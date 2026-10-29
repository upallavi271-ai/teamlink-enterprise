# ---------------------------------------------------------------------------
# ONE NAME FOR R&D ON THE LIVE SITE (founder 2026-10-28: "R & D untadi, R n D undadu").
#
#   .\push-rnd-name-to-vps.ps1
#
# Run it AFTER .\deploy-local-to-vps.ps1. It shows (dry run, nothing written) every department value spelled "R n D", "RnD",
# "R and D" ... that becomes "R&D", the "RND-<n>" seats renamed to "R&D-<n>" (an old copy keeps its history as "-OLD"), and the
# active R&D seats with who sits on them (R&D-TL Banka Mrudula, R&D-1 G.V. Keerthi, R&D-2 Mangalapalli Sravanthi, R&D-3 Durga
# Nagendra). Type YES to apply (a whole-database backup first; nothing is deleted).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
Write-Host "`n=== Dry run: what would change (nothing is written) ===" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && node scripts/fix-rnd-name.js"
if ($LASTEXITCODE -ne 0) { throw 'The dry run failed (see the lines above).' }
$ok = Read-Host "`nType YES to make R&D one name on the live site (anything else = stop)"
if ($ok -ne 'YES') { Write-Host 'Stopped. Nothing was changed.' -ForegroundColor Yellow; exit 0 }
ssh $VpsHost "cd $VpsRoot/backend && node scripts/fix-rnd-name.js --apply"
if ($LASTEXITCODE -ne 0) { throw 'The change failed (see the lines above).' }
Write-Host "`nDONE." -ForegroundColor Green
