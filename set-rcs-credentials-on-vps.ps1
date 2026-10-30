# ---------------------------------------------------------------------------
# RCS (rcssms.in) LOGIN -> backend/.env ON THE VPS (or on this PC with -Local). 2026-10-30.
#
#   .\set-rcs-credentials-on-vps.ps1           asks for the RCS details, writes them to /opt/teamlink-enterprise/backend/.env, restarts TeamLink
#   .\set-rcs-credentials-on-vps.ps1 -Local    the same for this PC's backend\.env (restart the local backend yourself: Start TeamLink.bat)
#
# The password and client secret are typed HIDDEN and never appear on screen, in a file name or in a command line: they travel inside the
# ssh connection's input (base64), and the old .env is backed up first (/root/teamlink-backups/env-before-rcs-<time>). Press Enter on a
# question to keep what is there now. Only the RCS_* lines you answer are replaced; every other line of .env stays as it is.
# At the end it shows the webhook address to give rcssms.in (template approvals + delivery reports).
# ---------------------------------------------------------------------------
param([switch]$Local)
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$VpsRoot = '/opt/teamlink-enterprise'
$SiteUrl = 'https://teamlink.teamlinks.in'

function Plain($sec) { if (-not $sec) { return '' }; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } }
# a value as .env reads it back exactly (dotenv: single quotes = literal)
function Quote($v) { if ($v -notmatch "'") { return "'" + $v + "'" } elseif ($v -notmatch '"') { return '"' + $v + '"' } else { return '`' + $v + '`' } }

$set = [ordered]@{}
Write-Host "RCS (rcssms.in) settings. Press Enter to keep the value that is there now." -ForegroundColor Cyan
$u = Read-Host 'RCS username'
if ($u) { $set['RCS_USERNAME'] = $u.Trim() }
$p = Plain (Read-Host 'RCS password (hidden)' -AsSecureString)
if ($p) { $set['RCS_PASSWORD'] = $p }
$id = Read-Host 'RCS ID / rcsid (Enter = 230)'
$set['RCS_ID'] = $(if ($id) { $id.Trim() } else { '230' })
if ($set['RCS_ID'] -notmatch '^\d{1,12}$') { throw 'The RCS ID is a number, for example 230.' }
$mode = Read-Host 'Login kind: password or token (Enter = password)'
$set['RCS_AUTH_MODE'] = $(if ($mode -match '^\s*token\s*$') { 'token' } else { 'password' })
if ($set['RCS_AUTH_MODE'] -eq 'token') {
  $cs = Plain (Read-Host 'RCS client secret (hidden)' -AsSecureString)
  if ($cs) { $set['RCS_CLIENT_SECRET'] = $cs }
  $tm = Read-Host 'Token address method: POST or GET (Enter = POST)'
  $set['RCS_TOKEN_METHOD'] = $(if ($tm -match '^\s*get\s*$') { 'GET' } else { 'POST' })
}
Write-Host "apitype: the sending document says 2, the brief says 1. Type it ONLY when rcssms.in has confirmed it (Enter = leave it as it is)." -ForegroundColor Yellow
$a1 = Read-Host 'apitype for the same message to many (/rcsapi/jsonapi.jsp): 1 or 2'
if ($a1) { if ($a1.Trim() -notmatch '^\d{1,2}$') { throw 'apitype is a number (1 or 2).' }; $set['RCS_SEND_APITYPE'] = $a1.Trim() }
$a2 = Read-Host 'apitype for a different message per person (/rcsapimtpl/jsonapi.jsp): 1 or 2'
if ($a2) { if ($a2.Trim() -notmatch '^\d{1,2}$') { throw 'apitype is a number (1 or 2).' }; $set['RCS_PERSONAL_APITYPE'] = $a2.Trim() }
$newHook = Read-Host 'Make a NEW webhook token? Only the first time, or if the old one leaked (y/N)'
$hook = $null
if ($newHook -match '^\s*y') {
  $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hook = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $set['RCS_WEBHOOK_SECRET'] = $hook
}
$set['RCS_BASE_URL'] = 'https://web.rcssms.in'

$block = ($set.Keys | ForEach-Object { "$_=$(Quote $set[$_])" }) -join "`n"
$keys = ($set.Keys -join '|')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if ($Local) {
  $envFile = Join-Path $PSScriptRoot 'backend\.env'
  if (-not (Test-Path $envFile)) { throw "Not found: $envFile" }
  $bk = Join-Path $env:USERPROFILE '.teamlink-backups'
  New-Item -ItemType Directory -Force $bk | Out-Null
  Copy-Item $envFile (Join-Path $bk "env-before-rcs-$stamp") -Force
  $kept = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -notmatch "^($keys)=" }
  $all = @($kept) + ($block -split "`n")
  [IO.File]::WriteAllText($envFile, (($all -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
  Write-Host "RCS settings written to backend\.env (old copy: $bk\env-before-rcs-$stamp). Restart the local backend (Start TeamLink.bat)." -ForegroundColor Green
  $site = 'http://localhost:4010'
} else {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($block + "`n"))
  $script = @'
set -e
ENVF=__ROOT__/backend/.env
[ -f "$ENVF" ] || { echo "NO .env AT $ENVF"; exit 1; }
mkdir -p /root/teamlink-backups
cp "$ENVF" /root/teamlink-backups/env-before-rcs-__STAMP__ && chmod 600 /root/teamlink-backups/env-before-rcs-__STAMP__
umask 077
TMP=$(mktemp)
grep -v -E '^(__KEYS__)=' "$ENVF" > "$TMP" || true
printf '%s' '__B64__' | base64 -d >> "$TMP"
cat "$TMP" > "$ENVF"
rm -f "$TMP"
echo "RCS SETTINGS WRITTEN (old .env: /root/teamlink-backups/env-before-rcs-__STAMP__)"
pm2 restart teamlink-enterprise --update-env > /dev/null && echo "TEAMLINK RESTARTED"
'@
  $script = $script.Replace('__ROOT__', $VpsRoot).Replace('__STAMP__', $stamp).Replace('__KEYS__', $keys).Replace('__B64__', $b64).Replace("`r", '')
  # tr: PowerShell ends the piped text with a Windows line end, which bash would read as a command
  $script | ssh $VpsHost 'tr -d ''\r'' | bash -s'
  if ($LASTEXITCODE -ne 0) { throw 'Writing the RCS settings on the VPS failed (see the lines above). Nothing else was changed.' }
  $site = $SiteUrl
}
$p = $null; $cs = $null; $block = $null; $b64 = $null; $script = $null
if ($hook) {
  Write-Host "`nGive rcssms.in this webhook address (template approvals + delivery reports). Keep it private:" -ForegroundColor Cyan
  Write-Host "  $site/api/webhooks/rcs?token=$hook"
} else {
  Write-Host "`nThe webhook address is unchanged: $site/api/webhooks/rcs?token=<RCS_WEBHOOK_SECRET>." -ForegroundColor Cyan
}
Write-Host "Next: Administration > Integrations > RCS > Test send, to ONE number of your own. Sending to many stays locked until that is accepted." -ForegroundColor Green
