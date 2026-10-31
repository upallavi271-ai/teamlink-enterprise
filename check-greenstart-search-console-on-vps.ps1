# ---------------------------------------------------------------------------
# WHY DOES GREEN START SAY "Keyword tracking needs Google Search Console"? - a READ-ONLY check of the live server. 2026-10-31.
#
#   .\check-greenstart-search-console-on-vps.ps1
#
# Shows (never a token, secret or password):
#   1. whether Green Start's Google sign-in is set up on the server: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (set or NOT SET) and the
#      GOOGLE_REDIRECT_URI address (an address, not a secret);
#   2. every workspace with a Search Console connection: status, the Google account (masked), the chosen property, refresh token yes/no,
#      the last error;
#   3. for a connected workspace: the properties Google really lets that account see (asked with the stored sign-in, read-only;
#      nothing is changed or saved).
# Verifying a site in Google Search Console does NOT connect it to Green Start: Green Start needs its own Google sign-in, per workspace.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'

$script = @'
set -euo pipefail
ROOT=/opt/green-start
[ -f "$ROOT/gs-api/.env" ] || { echo "Green Start is not installed at $ROOT"; exit 1; }
cd "$ROOT/gs-api"
echo "== 1. Google sign-in settings (gs-api/.env)"
for k in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  v=$(grep -E "^$k=" .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  if [ -n "$v" ]; then echo "  $k: set"; else echo "  $k: NOT SET"; fi
done
r=$(grep -E "^GOOGLE_REDIRECT_URI=" .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
echo "  GOOGLE_REDIRECT_URI: ${r:-NOT SET}   (must be https://greenstart.teamlinks.in/app/settings/oauth/google_search_console and listed in the Google Cloud OAuth client)"
echo "== 2 + 3. Search Console connections"
runuser -u greenstart -- env HOME="$ROOT" bash -c 'cd /opt/green-start/gs-api && set -a && . ./.env && set +a && node - <<"EOF_NODE"
const { Client } = require("pg");
let decrypt = null;
try { decrypt = require("./dist/common/lib/crypto.util").decryptSecret; } catch { /* old build */ }
const mask = (e) => (e ? String(e).replace(/^(.).*?(@.*)$/, "$1***$2") : "-");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const ws = await c.query("SELECT id, name FROM workspaces WHERE \"archivedAt\" IS NULL ORDER BY name");
  console.log("  workspaces: " + ws.rows.map((w) => w.name).join(", "));
  const r = await c.query("SELECT i.\"workspaceId\", w.name, i.status, i.\"displayName\", i.metadata, i.\"lastError\", i.\"updatedAt\", i.\"accessTokenEnc\", i.\"refreshTokenEnc\", i.\"expiresAt\" FROM integrations i JOIN workspaces w ON w.id = i.\"workspaceId\" WHERE i.provider = $1", ["google_search_console"]);
  if (!r.rows.length) console.log("  NO workspace has connected Google Search Console in Green Start (SEO -> Search Console -> Connect was never completed).");
  for (const x of r.rows) {
    const prop = (x.metadata || {}).property || null;
    console.log(`  - workspace "${x.name}": status ${x.status}, account ${mask(x.displayName)}, property ${prop || "NOT CHOSEN"}, refresh token ${x.refreshTokenEnc ? "yes" : "NO"}, last error ${x.lastError || "-"}, updated ${new Date(x.updatedAt).toISOString()}`);
    if (x.status !== "CONNECTED" || !decrypt || !x.accessTokenEnc) continue;
    try {
      let token = decrypt(x.accessTokenEnc, process.env.ENCRYPTION_KEY);
      if (x.expiresAt && new Date(x.expiresAt).getTime() < Date.now() + 60000 && x.refreshTokenEnc && process.env.GOOGLE_CLIENT_ID) {
        const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(x.refreshTokenEnc, process.env.ENCRYPTION_KEY), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }) });
        const tj = await t.json().catch(() => ({}));
        if (!tj.access_token) { console.log(`      Google refused the saved sign-in (${tj.error || t.status}): connect again.`); continue; }
        token = tj.access_token; // used only for this check, not saved
      }
      const s = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${token}` } });
      const sj = await s.json().catch(() => ({}));
      if (!s.ok) { console.log(`      Google answered HTTP ${s.status}: ${(sj.error && sj.error.message) || ""}`.slice(0, 300)); continue; }
      const list = (sj.siteEntry || []).map((e) => `${e.siteUrl} (${e.permissionLevel})`);
      console.log(`      properties this Google account can see: ${list.length ? list.join(", ") : "NONE"}`);
      if (prop && !(sj.siteEntry || []).some((e) => e.siteUrl === prop)) console.log("      ! the chosen property is NOT in that list: choose another or connect the account that owns it.");
    } catch (e) { console.log("      could not ask Google: " + String(e.message || e).slice(0, 200)); }
  }
  await c.end();
})().catch((e) => { console.log("  check failed: " + String(e.message || e).slice(0, 200)); process.exit(1); });
EOF_NODE'
'@
$script = $script.Replace("`r", '')
# tr: PowerShell ends the piped text with a Windows line end, which bash would read as a command
$script | ssh $VpsHost 'tr -d ''\r'' | bash -s'
if ($LASTEXITCODE -ne 0) { throw 'The check could not run (see the lines above).' }
