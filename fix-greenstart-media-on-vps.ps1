# ---------------------------------------------------------------------------
# OMNI-CHANNEL (GREEN START) IMAGES: make the server show the files it saved (founder 2026-10-31: images in Omni-Channel posts were broken and
# Facebook answered "Missing or invalid image file").
#
# Found on the live server: STORAGE_LOCAL_DIR=/opt/green-start/uploads (a full path). Green Start SAVES files there, but SHOWS /media/ from
# <working folder> + STORAGE_LOCAL_DIR (main.ts joins them), i.e. /opt/green-start/gs-api/opt/green-start/uploads - a folder that does not
# exist - so every image answered 404. With the relative value ../uploads both point at the same folder /opt/green-start/uploads (the API
# and the worker run in /opt/green-start/gs-api). Files already saved stay where they are and start showing.
#
#   .\fix-greenstart-media-on-vps.ps1            shows what it finds and what it would change (changes nothing), then asks YES
# A copy of the .env is kept next to it (.env.before-media-fix-<time>). Green Start's API and worker are restarted; the image is checked.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Check = 'https://greenstart.teamlinks.in/media/social/a0f57343-c063-4241-934b-df2e56cf9377/fe13113b-7b8b-47e3-b40b-438b933a9d68.png'

$Look = @'
ENVF=/opt/green-start/gs-api/.env
echo "now:     $(grep -E '^STORAGE_LOCAL_DIR=' $ENVF || echo 'STORAGE_LOCAL_DIR not set')"
echo "API runs in:    $(systemctl show -p WorkingDirectory --value green-start-api)"
echo "worker runs in: $(systemctl show -p WorkingDirectory --value green-start-worker 2>/dev/null)"
echo "files saved in /opt/green-start/uploads: $(find /opt/green-start/uploads -type f 2>/dev/null | wc -l)"
'@
Write-Host "[1/2] What the live server has (nothing changes)..." -ForegroundColor Cyan
# tr on the server: PowerShell ends piped text with a Windows line end, which bash would read as a command (the dollar-backslash-r "command not found" error)
$Look.Replace("`r", "") | ssh $VpsHost 'tr -d ''\r'' | bash -s'
if ($LASTEXITCODE -ne 0) { throw 'Could not read the server.' }
Write-Host ""
Write-Host "It will set STORAGE_LOCAL_DIR=../uploads (only when the API and the worker run in /opt/green-start/gs-api), then restart them." -ForegroundColor Yellow

$ok = Read-Host "`nType YES to make the change"
if ($ok.Trim() -ne 'YES') { Write-Host 'Not changed.' -ForegroundColor Yellow; exit 0 }

$Fix = @'
set -e
ENVF=/opt/green-start/gs-api/.env
API_WD=$(systemctl show -p WorkingDirectory --value green-start-api)
WK_WD=$(systemctl show -p WorkingDirectory --value green-start-worker 2>/dev/null || true)
if [ "$API_WD" != "/opt/green-start/gs-api" ]; then echo "STOPPED: the API runs in '$API_WD', not /opt/green-start/gs-api - nothing changed"; exit 1; fi
if [ -n "$WK_WD" ] && [ "$WK_WD" != "/opt/green-start/gs-api" ]; then echo "STOPPED: the worker runs in '$WK_WD' - nothing changed"; exit 1; fi
cp -p $ENVF "$ENVF.before-media-fix-$(date +%Y%m%d-%H%M%S)"
if grep -qE '^STORAGE_LOCAL_DIR=' $ENVF; then sed -i -E 's#^STORAGE_LOCAL_DIR=.*#STORAGE_LOCAL_DIR=../uploads#' $ENVF; else echo 'STORAGE_LOCAL_DIR=../uploads' >> $ENVF; fi
echo "set: $(grep -E '^STORAGE_LOCAL_DIR=' $ENVF)"
systemctl restart green-start-api green-start-worker
for i in $(seq 1 30); do if curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4020/api/v1/health | grep -q 200; then echo "Green Start API is up"; break; fi; sleep 2; done
'@
Write-Host "[2/2] Changing it (a copy of the .env is kept)..." -ForegroundColor Cyan
$Fix.Replace("`r", "") | ssh $VpsHost 'tr -d ''\r'' | bash -s'
if ($LASTEXITCODE -ne 0) { throw 'It did not finish (see the lines above).' }

Start-Sleep -Seconds 3
try { $code = (Invoke-WebRequest -Uri $Check -Method Head -UseBasicParsing -TimeoutSec 20).StatusCode } catch { $code = $_.Exception.Response.StatusCode.value__ }
if ($code -eq 200) { Write-Host "`nDONE: the image now opens (200). Post again from Omni-Channel." -ForegroundColor Green }
else { Write-Host "`nThe image still answers $code. Send these lines to Claude." -ForegroundColor Red }
