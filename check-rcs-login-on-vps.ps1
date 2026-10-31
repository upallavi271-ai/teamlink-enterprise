# ---------------------------------------------------------------------------
# WHY DOES "Send test RCS" KEEP SAYING 022 "Incorrect Username Password"? - READ-ONLY check of the live server. 2026-10-31.
#
#   .\check-rcs-login-on-vps.ps1
#
# Never prints the password or the full username. It shows:
#   1. backend/.env: how many RCS_USERNAME / RCS_PASSWORD lines (the LAST one counts), how each is quoted, its length, whether it
#      has spaces / # / $ / quotes at the ends, and RCS_AUTH_MODE (token mode sends NO password);
#   2. the running TeamLink (pm2): whether pm2 holds its OWN RCS_* values (they win over .env), and whether .env changed AFTER the
#      last restart (then the app still uses the old values);
#   3. a LOGIN TEST straight to rcssms.in with the values in .env and a template id that does not exist ("zz-login-check"), so NO
#      message can go out and no credit is used. Answer 018 (template not found) = the username + password are RIGHT.
#      022 = rcssms.in does not accept this username + password. 021 = the username does not exist.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$num = Read-Host 'Your own mobile number for the login test (no message is sent: the template id does not exist)'
$digits = ($num -replace '\D', '')
if ($digits.Length -eq 10) { $digits = "91$digits" }
if ($digits -notmatch '^91[6-9]\d{9}$') { throw 'Type a 10-digit Indian mobile number.' }

$script = @'
set -euo pipefail
cd /opt/teamlink-enterprise/backend
NUM=__NUM__ node - <<"EOF_NODE"
const fs = require("fs");
const { execSync } = require("child_process");
const raw = fs.readFileSync(".env", "utf8");
const env = require("dotenv").parse(raw);
const lines = raw.split(/\r?\n/);
const shape = (v) => v == null ? "NOT SET" : `${v.length} characters${/^\s|\s$/.test(v) ? ", SPACE at the start/end" : ""}${/\s/.test(v.trim()) ? ", has a space inside" : ""}${/[#$`"'\\]/.test(v) ? ", has # $ ` quote or backslash" : ""}`;
console.log("== 1. backend/.env");
for (const k of ["RCS_USERNAME", "RCS_PASSWORD", "RCS_CLIENT_SECRET"]) {
  const found = lines.filter((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
  const q = found[0] ? (/=\s*'/.test(found[0]) ? "single quotes" : /=\s*"/.test(found[0]) ? "double quotes" : /=\s*`/.test(found[0]) ? "backticks" : "no quotes") : "-";
  console.log(`  ${k}: ${found.length} line(s)${found.length > 1 ? " (the LAST one counts)" : ""}, ${q}, value as the app reads it: ${shape(env[k])}`);
}
const u = env.RCS_USERNAME || "";
console.log(`  RCS_USERNAME looks like: ${u ? u.slice(0, 2) + "*".repeat(Math.max(0, u.length - 2)) : "NOT SET"}`);
console.log(`  RCS_AUTH_MODE: ${env.RCS_AUTH_MODE || "(not set = password)"}${(env.RCS_AUTH_MODE || "").trim().toLowerCase() === "token" ? "  <- token mode sends NO password: 022 then means a wrong client secret / token" : ""}`);
console.log(`  RCS_ID: ${env.RCS_ID || "NOT SET"}   RCS_BASE_URL: ${env.RCS_BASE_URL || "(default https://web.rcssms.in)"}   RCS_SEND_APITYPE: ${env.RCS_SEND_APITYPE || "(default 1)"}`);
console.log("== 2. the running TeamLink (pm2)");
try {
  const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const p = list.find((x) => x.name === "teamlink-enterprise");
  if (!p) console.log("  teamlink-enterprise is not in pm2");
  else {
    const pe = p.pm2_env || {};
    const own = ["RCS_USERNAME", "RCS_PASSWORD", "RCS_AUTH_MODE"].filter((k) => pe[k] != null || (pe.env && pe.env[k] != null));
    console.log(`  status ${pe.status}, started ${new Date(pe.pm_uptime).toISOString()}`);
    console.log(own.length ? `  pm2 holds its OWN ${own.join(", ")}: these WIN over .env (dotenv never overrides). Fix: pm2 delete + start again, or remove them from the pm2 ecosystem file.` : "  pm2 holds no RCS_* values of its own: the app reads .env at start (good).");
    const envTime = fs.statSync(".env").mtimeMs;
    console.log(envTime > pe.pm_uptime ? "  .env CHANGED AFTER the last restart: the app still uses the OLD values. Run: pm2 restart teamlink-enterprise" : "  .env is older than the last restart: the app uses what .env says.");
  }
} catch (e) { console.log("  could not read pm2: " + String(e.message).slice(0, 120)); }
console.log("== 3. login test to rcssms.in (template zz-login-check does not exist: nothing is sent)");
(async () => {
  const base = (env.RCS_BASE_URL || "https://web.rcssms.in").trim().replace(/\/+$/, "");
  const body = { username: (env.RCS_USERNAME || "").trim(), password: (env.RCS_PASSWORD || "").trim(), rcstype: "BASIC", rcsid: (env.RCS_ID || "").trim(), msisdn: process.env.NUM, variables: [{}], templateid: "zz-login-check" };
  try {
    const r = await fetch(`${base}/rcsapi/jsonapi.jsp?apitype=${(env.RCS_SEND_APITYPE || "1").trim()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    let t = await r.text();
    for (const s of [body.password, body.username]) if (s && s.length >= 3) t = t.split(s).join("***");
    console.log(`  rcssms.in answered: HTTP ${r.status} ${t.replace(/\s+/g, " ").slice(0, 300)}`);
    const code = (/ErrorCode"\s*:\s*"?0*(\d+)/i.exec(t) || [])[1];
    if (code === "18") console.log("  => LOGIN IS RIGHT (only the fake template was refused). If Send test RCS still says 022, the running app uses other values: see part 2.");
    else if (code === "22") console.log("  => rcssms.in does NOT accept this username + password. Ask rcssms.in support for the API password of this username (the one 'shared at account creation'), then run .\\set-rcs-credentials-on-vps.ps1 again.");
    else if (code === "21") console.log("  => the USERNAME does not exist at rcssms.in. Check RCS_USERNAME (the API username, not an email or mobile).");
    else console.log("  => another answer: send these lines to Claude.");
  } catch (e) { console.log("  could not reach rcssms.in: " + String(e.message).slice(0, 150)); }
})();
EOF_NODE
'@
$script = $script.Replace('__NUM__', $digits).Replace("`r", '')
# tr on the server: PowerShell ends piped text with a Windows line end, which bash would read as a command
$script | ssh $VpsHost 'tr -d ''\r'' | bash -s'
if ($LASTEXITCODE -ne 0) { throw 'The check could not run (see the lines above).' }
