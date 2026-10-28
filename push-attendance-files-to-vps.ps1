# ---------------------------------------------------------------------------
# IMPORT OLD HRMS (PulseHRM) ATTENDANCE FILES INTO THE LIVE SITE (founder 2026-10-28: employees must see their attendance).
#
#   .\push-attendance-files-to-vps.ps1 "C:\Users\user\Downloads\bio-metric_logs (9).csv" "C:\Users\user\Downloads\first_check-in_&_last_check-out_report_form_16-oct-2026_to_22-oct-2026.csv"
#
# Run it AFTER .\deploy-local-to-vps.ps1 (the importer that updates days imported before must be on the server). It copies the
# files to the server, shows a DRY RUN (what would be created / filled / updated - nothing written), asks you to type YES, then
# imports with the same importer as Attendance -> Import History. Nothing is doubled; HR / Super Admin times and Absent / Leave
# days stand. The copies on the server are deleted afterwards.
# ---------------------------------------------------------------------------
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$Stamp = Get-Date -Format 'yyyyMMddHHmmss'
$RemoteDir = "/tmp/tl-attendance-$Stamp"
foreach ($f in $Files) { if (-not (Test-Path -LiteralPath $f)) { throw "File not found: $f" } }
ssh $VpsHost "mkdir -p $RemoteDir"
$remote = @()
$i = 0
foreach ($f in $Files) {
  $i++
  $name = "file$i.csv"
  scp -- "$f" "${VpsHost}:$RemoteDir/$name"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy $f to the server." }
  $remote += "$RemoteDir/$name"
}
$list = ($remote -join ' ')
Write-Host "`n=== Dry run: what would change (nothing is written) ===" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && node scripts/import-attendance-files.js $list"
if ($LASTEXITCODE -ne 0) { ssh $VpsHost "rm -rf $RemoteDir"; throw 'The dry run failed (see the lines above).' }
$ok = Read-Host "`nType YES to import these files on the live site (anything else = stop)"
if ($ok -ne 'YES') { ssh $VpsHost "rm -rf $RemoteDir"; Write-Host 'Stopped. Nothing was changed.' -ForegroundColor Yellow; exit 0 }
ssh $VpsHost "cd $VpsRoot/backend && node scripts/import-attendance-files.js $list --apply"
$code = $LASTEXITCODE
ssh $VpsHost "rm -rf $RemoteDir"
if ($code -ne 0) { throw 'The import failed (see the lines above). Nothing was written (it is all-or-nothing).' }
Write-Host "`nDONE. Employees see these days on My Attendance now." -ForegroundColor Green
