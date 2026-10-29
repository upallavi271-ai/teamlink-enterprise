# ---------------------------------------------------------------------------
# OMNI-CHANNEL WITHOUT THE GREEN START LOGIN PAGE, ON THE LIVE SITE (founder 2026-10-26: "login page remove cheyyu, direct ga omnichannel open cheyyi";
# 2026-10-29: "omnichannel ki login page thisai ani chepe kadha" - no email to look up first).
#
#   .\enable-greenstart-sso-on-vps.ps1                          (finds the company Green Start account by itself)
#   .\enable-greenstart-sso-on-vps.ps1 -Email admin@yourcompany.com   (or name it)
#
# Without -Email it reads Green Start's own database on the VPS and takes the owner of the company organisation (one whose name has
# "Teamlink", else the oldest active one; never a platform Super Admin, never a suspended / unconfirmed account) and prints which.
# On the VPS it makes ONE random secret (never shown) and writes it to both sides, only if it is not there yet:
#   /opt/teamlink-enterprise/backend/.env   GREENSTART_SSO_SECRET=...   GREENSTART_SSO_EMAIL=<Email>
#   /opt/green-start/gs-api/.env            TEAMLINK_SSO_SECRET=...      (the same value)
# then restarts TeamLink (PM2) and the Green Start API. The Admin can change the account later in Omni-Channel -> Manage.
# Deploy first (.\deploy-local-to-vps.ps1 or .\push-everything-to-vps.ps1). Do not click inside this window while it runs.
# ---------------------------------------------------------------------------
param([string]$Email = '')
$ErrorActionPreference = 'Stop'
if ($Email -and $Email -notmatch '^[^\s@''"]+@[^\s@''"]+\.[^\s@''"]+$') { throw "That is not an email address: $Email" }
$VpsHost = 'root@72.61.233.104'
$script = @'
set -e
TL=/opt/teamlink-enterprise/backend/.env
GS=/opt/green-start/gs-api/.env
[ -f "$TL" ] || { echo "TeamLink .env not found at $TL"; exit 1; }
[ -f "$GS" ] || { echo "Green Start .env not found at $GS"; exit 1; }
EMAIL="__EMAIL__"
if [ -z "$EMAIL" ]; then
  OUT=$(cd /opt/green-start/gs-api && node - <<'JS'
const fs = require('fs');
const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => /^DATABASE_URL=/.test(l)) || '';
const url = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '').replace(/\?.*$/, '');
const { Client } = require('pg');
const c = new Client({ connectionString: url });
c.connect().then(() => c.query(`SELECT o.name, u.email FROM organizations o JOIN users u ON u.id = o."ownerId"
  WHERE o.status IN ('ACTIVE','TRIAL') AND o."deletionScheduledFor" IS NULL
    AND u.status = 'ACTIVE' AND u."isSuperAdmin" = false AND u."deletedAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL
  ORDER BY o."createdAt" ASC`)).then(({ rows }) => {
  const pick = rows.find((r) => /team\s*links?/i.test(r.name)) || rows[0];
  if (!pick) { console.log('NONE'); return; }
  console.log(`ORG=${pick.name} (${rows.length} organisation(s): ${rows.map((r) => r.name).join(', ')})`);
  console.log(`EMAIL=${String(pick.email).toLowerCase()}`);
}).catch((e) => console.log(`ERROR=${String(e.message).split('\n')[0]}`)).finally(() => c.end());
JS
)
  echo "$OUT" | grep '^ORG=' | sed 's/^ORG=/Company Green Start organisation: /' || true
  EMAIL=$(echo "$OUT" | sed -n 's/^EMAIL=//p')
  if [ -z "$EMAIL" ]; then
    echo "Could not find the company Green Start account by itself: $(echo "$OUT" | head -1)"
    echo "Run it again with the email:  .\\enable-greenstart-sso-on-vps.ps1 -Email <company Green Start admin email>"
    exit 1
  fi
fi
echo "Everybody will open Green Start as: $EMAIL"
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
sed -i '/^GREENSTART_SSO_EMAIL=/d' "$TL"; printf 'GREENSTART_SSO_EMAIL=%s\n' "$EMAIL" >> "$TL"
pm2 restart teamlink-enterprise --update-env >/dev/null && echo "TeamLink restarted."
systemctl restart green-start-api && echo "Green Start API restarted."
'@
$script = $script.Replace('__EMAIL__', $Email.ToLower()).Replace("`r", '')
$script | ssh $VpsHost 'bash -s'
if ($LASTEXITCODE -ne 0) { throw 'It did not finish on the VPS (see the lines above).' }
Write-Host "`nDone. Open TeamLink -> Omni-Channel: Green Start opens already signed in (no login page)." -ForegroundColor Green
