# ---------------------------------------------------------------------------
# TL LEAVES BACK TO PENDING ON THE LIVE SITE (founder 2026-10-28: "ninna unna leave lo Renuka and Leela Usha villu iddaru TLs kani
# Super Admin approve cheyaledu kabatti vallu pending ane ravali").
#
#   .\push-tl-leaves-pending-to-vps.ps1
#
# Run it AFTER .\deploy-local-to-vps.ps1 (the new rule "a TL's leave is approved only by the Super Admin" must be on the server first). It:
#   1. shows (dry run, nothing written) every TL leave from 1 Oct 2026 that is Approved but was approved by someone other than the
#      Super Admin (e.g. HR) - Renuka.G (TL306) and D. Leela Usha Sri (TL484) on 27 Oct, approved by T Divya Sri Sivatmika (HR),
#      among them - with who approved it. A leave the Super Admin approved (e.g. TL406, by Vasu Chitturi) is left alone. It also
#      lists days marked "Leave" by hand that have no leave request (a Pending request is raised for each);
#   2. asks you to type YES, then puts them back to Pending with the Super Admin step waiting (a backup of the whole database is
#      written first; who approved stays in the approval chain and the audit log; nothing is deleted).
# The Super Admin then approves them from HRMS Dashboard -> Pending tasks -> Leave approvals (or Leave -> Requests).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
Write-Host "`n=== Dry run: what would change (nothing is written) ===" -ForegroundColor Cyan
ssh $VpsHost "cd $VpsRoot/backend && node scripts/tl-leaves-to-pending.js --from 2026-10-01"
if ($LASTEXITCODE -ne 0) { throw 'The dry run failed (see the lines above).' }
$ok = Read-Host "`nType YES to put these TL leaves back to Pending on the live site (anything else = stop)"
if ($ok -ne 'YES') { Write-Host 'Stopped. Nothing was changed.' -ForegroundColor Yellow; exit 0 }
ssh $VpsHost "cd $VpsRoot/backend && node scripts/tl-leaves-to-pending.js --from 2026-10-01 --apply --really-real"
if ($LASTEXITCODE -ne 0) { throw 'The change failed (see the lines above).' }
Write-Host "`nDONE. These TL leaves now show Pending - waiting for the Super Admin. Approve them in HRMS Dashboard -> Pending tasks." -ForegroundColor Green
