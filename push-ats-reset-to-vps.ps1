# ---------------------------------------------------------------------------
# EMPTY THE ATS ON THE LIVE SITE AND IMPORT ONLY THE FOUNDER'S SHEETS (2026-10-27: "mottham ATS ni empty cheyyu, ippudu nenu ichevi
# matramey import cheyyu, remaining em vundakudadhu").
#
#   .\push-ats-reset-to-vps.ps1          DRY RUN on the VPS (only the first step can show numbers before anything is emptied)
#   .\push-ats-reset-to-vps.ps1 -Apply   does it, on the VPS, in this order (each step backs up the live database first):
#     1 reset-ats-2026-10-27.js            every application, requirement and candidate deleted - except what an Accounts invoice
#                                          points at (kept; the requirement Closed); clients, HRMS, Accounts untouched
#     2 replace-medical-requirements.js    Medical requirement sheet, zip clients only (--zip-only)
#     3 replace-edu-mfg-requirements.js    Education + Manufacturing requirement sheets, zip clients only
#     4 restore-joining-clients.js         colleges that have joinings but no signed agreement, back as Inactive
#     5 import-joinings-2026-10-17.js      the three joinings sheets (Education 2022-2026, Medical, Manufacturing)
#     6 sync-joinings-list-to-sheets.js    the Joining screen's list = the sheets
#     7 finish-ats-reset-clients.js        a client the import made twice is folded into the existing one; new non-zip clients Inactive
# Run it AFTER the deploy, the signed agreements and the zip-clients step (push-everything-to-vps.ps1 does it in that order).
# Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param(
  [switch]$Apply,
  [string]$Downloads = (Join-Path $env:USERPROFILE 'Downloads')
)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$files = @{
  'medical-requirements.xlsx'              = 'Medical team requirements sheet.xlsx'
  'education-requirements.xlsx'            = 'Edu - 2 Requirement Sheet  (3).xlsx'
  'manufacturing-requirements.xlsx'        = 'ManuFacture Requirements  Sheet.xlsx'
  'joinings/_Medical Team Joinings Sheet .xlsx'          = '_Medical Team Joinings Sheet .xlsx'
  'joinings/Education-Team Joinings-2022-2025.xlsx'      = 'Education-Team Joinings-2022-2025.xlsx'
  'joinings/Manufacturing-Joing sheet (1).xlsx'          = 'Manufacturing-Joing sheet (3).xlsx'
}
foreach ($k in $files.Keys) { $p = Join-Path $Downloads $files[$k]; if (-not (Test-Path $p)) { throw "The sheet is not here: $p" } }

Write-Host "[upload] the requirement and joinings sheets..." -ForegroundColor Cyan
ssh $VpsHost "mkdir -p /root/joinings"
foreach ($k in $files.Keys) {
  scp (Join-Path $Downloads $files[$k]) "${VpsHost}:'/root/$k'"
  if ($LASTEXITCODE -ne 0) { throw "Upload failed: $($files[$k])" }
}

$real = 'TL_ALLOW_REAL_APPLY=1 '
$go = ' --apply --really-real'
function Run($n, $text, $cmd) {
  Write-Host "[$n/7] $text" -ForegroundColor Cyan
  ssh $VpsHost "cd $VpsRoot/backend && $cmd"
  if ($LASTEXITCODE -ne 0) { throw "Step $n failed (see the lines above)." }
}

if (-not $Apply) {
  Run 1 'What the reset would delete (dry run)' 'node scripts/reset-ats-2026-10-27.js'
  Write-Host "`nDRY RUN finished. The other steps run only with -Apply (they need the emptied ATS). If the numbers look right:  .\push-ats-reset-to-vps.ps1 -Apply" -ForegroundColor Yellow
  return
}
$start = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Run 1 'Emptying the ATS (invoiced records kept)' "${real}node scripts/reset-ats-2026-10-27.js$go"
Run 2 'Medical requirements (zip clients only)' "${real}node scripts/replace-medical-requirements.js --file /root/medical-requirements.xlsx --zip-only$go --out /root/teamlink-backups/replace-medical-reset"
Run 3 'Education + Manufacturing requirements' "${real}node scripts/replace-edu-mfg-requirements.js --edu /root/education-requirements.xlsx --mfg /root/manufacturing-requirements.xlsx$go --out /root/teamlink-backups/replace-edu-mfg-reset"
Run 4 'Colleges with joinings back as Inactive' "${real}node scripts/restore-joining-clients.js$go"
Run 5 'Joinings from the sheets' "${real}node scripts/import-joinings-2026-10-17.js --only joinings --downloads /root/joinings --out /root/teamlink-backups/import-joinings-reset$go"
Run 6 'Joinings list = the sheets' "${real}node scripts/sync-joinings-list-to-sheets.js$go"
Run 7 'Clients made twice folded; new non-zip clients Inactive' "${real}node scripts/finish-ats-reset-clients.js --since $start$go"
Write-Host "`nDone. The live ATS now holds only the sheets' requirements and joinings (and what Accounts invoices point at)." -ForegroundColor Green
