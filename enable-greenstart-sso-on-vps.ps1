# ---------------------------------------------------------------------------
# OMNI-CHANNEL WITHOUT THE GREEN START LOGIN PAGE, ON THE LIVE SITE (founder 2026-10-26: "login page remove cheyyu, direct ga omnichannel open cheyyi").
#
#   .\enable-greenstart-sso-on-vps.ps1 -Email admin@yourcompany.com
#
# -Email = the company's Green Start account (the Organization Admin of your workspace in Green Start; NOT the platform Super Admin).
# On the VPS it makes ONE random secret (never shown) and writes it to both sides, only if it is not there yet:
#   /opt/teamlink-enterprise/backend/.env   GREENSTART_SSO_SECRET=...   GREENSTART_SSO_EMAIL=<Email>
#   /opt/green-start/gs-api/.env            TEAMLINK_SSO_SECRET=...      (the same value)
# then restarts TeamLink (PM2) and the Green Start API. The Admin can change the account later in Omni-Channel -> Manage.
# Deploy first (.\deploy-local-to-vps.ps1 or .\push-everything-to-vps.ps1). Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param([Parameter(Mandatory = $true)][string]$Email)
$ErrorActionPreference = 'Stop'
if ($Email -notmatch '^[^\s@''"]+@[^\s@''"]+\.[^\s@''"]+$') { throw "That is not an email address: $Email" }
$VpsHost = 'root@72.61.233.104'
$script = @'
set -e
TL=/opt/teamlink-enterprise/backend/.env
GS=/opt/green-start/gs-api/.env
[ -f "$TL" ] || { echo "TeamLink .env not found at $TL"; exit 1; }
[ -f "$GS" ] || { echo "Green Start .env not found at $GS"; exit 1; }
if grep -q '^GREENSTART_SSO_SECRET=' "$TL" && grep -q '^TEAMLINK_SSO_SECRET=' "$GS"; then
  echo "The secret is already set on both sides (not changed)."
else
  S=$(openssl rand -hex 32)
  sed -i '/^GREENSTART_SSO_SECRET=/d' "$TL"; sed -i '/^TEAMLINK_SSO_SECRET=/d' "$GS"
  printf '\n# One-click sign-in to Green Start (same value as %s TEAMLINK_SSO_SECRET)\nGREENSTART_SSO_SECRET=%s\n' "$GS" "$S" >> "$TL"
  printf '\n# One-click sign-in from TeamLink (same value as %s GREENSTART_SSO_SECRET)\nTEAMLINK_SSO_SECRET=%s\n' "$TL" "$S" >> "$GS"
  unset S
  echo "Secret written to both .env files (not shown)."
fi
sed -i '/^GREENSTART_SSO_EMAIL=/d' "$TL"; printf 'GREENSTART_SSO_EMAIL=%s\n' "__EMAIL__" >> "$TL"
pm2 restart teamlink-enterprise --update-env >/dev/null && echo "TeamLink restarted."
systemctl restart green-start-api && echo "Green Start API restarted."
'@
$script = $script.Replace('__EMAIL__', $Email.ToLower()).Replace("`r", '')
$script | ssh $VpsHost 'bash -s'
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
Write-Host "`nDone. Open TeamLink -> Omni-Channel: Green Start opens already signed in as $Email." -ForegroundColor Green
