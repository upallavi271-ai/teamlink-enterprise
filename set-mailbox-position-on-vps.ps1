# ---------------------------------------------------------------------------
# A NAUKRI / SHINE MAILBOX BELONGS TO AN HRMS POSITION, ON THE LIVE SITE (founder 2026-10-29: "permanently mapped to the
# Manufacturing department/position, not to an individual recruiter").
#
#   .\set-mailbox-position-on-vps.ps1                                         (asks which mailbox and which position)
#   .\set-mailbox-position-on-vps.ps1 -Mailbox itrequirement042@gmail.com -Seat MFG-5
#
# Shows the mailboxes and the positions, then what would change (dry run), and changes it only when you type YES. The same
# connection and its app password stay; new imports go to whoever holds the position, now and after every change of person.
# Candidates imported earlier stay with their recruiter. Deploy first (.\deploy-local-to-vps.ps1). The same can be done on the
# screen: Administration -> Integrations -> Naukri & Shine mailboxes -> Change position / Link to a position.
# ---------------------------------------------------------------------------
param([string]$Mailbox = '', [string]$Seat = '')
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Base = "cd /opt/teamlink-enterprise/backend && [ -f scripts/set-mailbox-position.js ] || { echo 'Deploy first: .\deploy-local-to-vps.ps1'; exit 1; }; node scripts/set-mailbox-position.js"
if (-not $Mailbox -or -not $Seat) {
  ssh $VpsHost $Base
  if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
  if (-not $Mailbox) { $Mailbox = (Read-Host "`nMailbox email (from the list above)").Trim() }
  if (-not $Seat) { $Seat = (Read-Host 'Position (for example MFG-5)').Trim() }
}
if ($Mailbox -notmatch '^[^\s''"]+$' -or $Seat -notmatch '^[A-Za-z0-9&][A-Za-z0-9& _-]{0,30}$') { throw 'That mailbox or position does not look right.' }
$q = { param($s) "'" + $s.Replace("'", "") + "'" }
$Args1 = "--mailbox $(& $q $Mailbox) --seat $(& $q $Seat)"
ssh $VpsHost "$Base $Args1"
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
$answer = Read-Host "`nType YES to make this change (anything else stops here)"
if ($answer -ne 'YES') { Write-Host 'Stopped. Nothing was changed.'; exit 0 }
ssh $VpsHost "$Base $Args1 --apply"
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
Write-Host "`nDone. The mailbox now follows position $Seat." -ForegroundColor Green
