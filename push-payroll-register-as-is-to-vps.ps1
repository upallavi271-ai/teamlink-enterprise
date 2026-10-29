# ---------------------------------------------------------------------------
# LIVE PAYROLL FOR A MONTH = THE PAY REGISTER, AS IT IS (founder 2026-10-29: "oct payroll clear ga calculate chesi echaru deni em
# change kuda upload chey payrollos loki evvi correct claculation ne").
#
#   .\push-payroll-register-as-is-to-vps.ps1
#   .\push-payroll-register-as-is-to-vps.ps1 -Register "C:\...\Pay Register for Nov 2026.xlsx" -Month 2026-11
#
# Uploads the register, shows on the screen what the live payroll will get (every person, days, gross, LOP, deductions, net,
# the totals) WITHOUT changing anything, and asks. Only when you type YES it writes: a backup of the live database is taken
# first, then every row becomes that person's payroll record with the register's own figures (nothing recalculated; the
# records stay Draft so Submit -> Approve -> Paid works as usual; "Calculate" never overwrites them).
# Records already submitted / approved / paid are never touched. Drafts of people NOT in the register: -DropOthers removes them.
# Deploy first (.\deploy-local-to-vps.ps1): the VPS needs backend/scripts/payroll-import-register-as-is.js.
# ---------------------------------------------------------------------------
param(
  [string]$Register = (Join-Path $env:USERPROFILE 'Downloads\Pay Register for Oct 2026.xlsx'),
  [string]$Month = '2026-10',
  [switch]$DropOthers
)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Backend = '/opt/teamlink-enterprise/backend'
if (-not (Test-Path $Register)) { throw "The pay register is not here: $Register" }
if ($Month -notmatch '^\d{4}-(0[1-9]|1[0-2])$') { throw "Month must look like 2026-10" }
$Drop = if ($DropOthers) { ' --drop-others' } else { '' }

Write-Host "[1/3] Uploading the register..." -ForegroundColor Cyan
scp $Register "${VpsHost}:/root/pay-register-as-is.xlsx"
if ($LASTEXITCODE -ne 0) { throw 'The upload did not work.' }

Write-Host "[2/3] What the live payroll will get (nothing changes yet)..." -ForegroundColor Cyan
ssh $VpsHost "cd $Backend && node scripts/payroll-import-register-as-is.js --register /root/pay-register-as-is.xlsx --month $Month$Drop"
if ($LASTEXITCODE -ne 0) { throw 'Stopped (see the lines above). Nothing was changed. Did you deploy first?' }

$ok = Read-Host "`nType YES to put exactly these figures into the live $Month payroll"
if ($ok -cne 'YES') { Write-Host 'Not changed.' -ForegroundColor Yellow; ssh $VpsHost 'rm -f /root/pay-register-as-is.xlsx'; exit 0 }

Write-Host "[3/3] Writing it (backup first)..." -ForegroundColor Cyan
ssh $VpsHost "cd $Backend && node scripts/payroll-import-register-as-is.js --register /root/pay-register-as-is.xlsx --month $Month$Drop --apply; rc=`$?; rm -f /root/pay-register-as-is.xlsx; exit `$rc"
if ($LASTEXITCODE -ne 0) { throw 'It did not finish (see the lines above).' }
Write-Host "`nDone. Open Payroll -> $Month: the figures are the register's." -ForegroundColor Green
