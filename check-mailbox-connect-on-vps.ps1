# ---------------------------------------------------------------------------
# WHY DID "CONNECT" ON THE NAUKRI / SHINE MAILBOX SCREEN SAY "Request failed with status code 502"? (founder 2026-10-29)
#
#   .\check-mailbox-connect-on-vps.ps1
#
# READ ONLY - changes nothing. A bare 502 comes from nginx, not from TeamLink (TeamLink's own errors carry a message):
# nginx got no answer because the TeamLink backend was restarting or had stopped while the mailbox login was being checked.
# This shows the evidence: backend uptime and restarts, recent auto-sync deploys, the nginx errors and the backend's own errors
# for /api/portal-mailboxes, and whether the Job Portal can save mailbox passwords (key set: yes/no - the key itself is never shown).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$Cmd = @'
R=/opt/teamlink-enterprise
echo "now (server): $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo '---- TeamLink backend (pm2) ----'
pm2 jlist 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s||'[]'))if(p.name==='teamlink-enterprise'){const e=p.pm2_env;console.log('status',e.status,'| restarts',e.restart_time,'| up since',new Date(e.pm_uptime).toISOString())}})"
echo '---- auto-sync (GitHub -> server) last deploys ----'
systemctl is-active teamlink-sync.timer 2>/dev/null | sed 's/^/timer: /'
[ -f /opt/teamlink-sync/sync.log ] && grep -iE 'deploy|restart|rollback|fail' /opt/teamlink-sync/sync.log | tail -n 8
echo '---- nginx errors (last 2 hours) for /api ----'
grep -h '/api/' /var/log/nginx/error.log 2>/dev/null | tail -n 8 | cut -c1-260
echo '---- nginx access: portal-mailboxes requests ----'
grep -h 'portal-mailboxes' /var/log/nginx/access.log 2>/dev/null | tail -n 8 | awk '{print $4, $6, $7, $9, "bytes=" $10}'
echo '---- backend errors ----'
L=$(pm2 jlist 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s||'[]'))if(p.name==='teamlink-enterprise')console.log(p.pm2_env.pm_err_log_path)})")
[ -n "$L" ] && tail -n 25 "$L" | cut -c1-260
echo '---- Job Portal can save mailbox passwords? ----'
grep -qE '^JOBPORTAL__INTEGRATION_SECRET_KEY=.{16,}' $R/backend/.env && echo 'key set: YES' || echo 'key set: NO  (run .\set-job-portal-mail-key.ps1)'
curl -s -m 5 -o /dev/null -w 'job portal health: HTTP %{http_code}\n' http://127.0.0.1:4323/api/health
'@
$Cmd = $Cmd.Trim().Replace("`r", '')
$Tmp = Join-Path $env:TEMP 'check-mailbox-connect.sh'
[IO.File]::WriteAllText($Tmp, $Cmd + "`n", (New-Object Text.UTF8Encoding($false)))
try {
  scp $Tmp "${VpsHost}:/root/check-mailbox-connect.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server.' }
  ssh $VpsHost 'bash /root/check-mailbox-connect.sh; rm -f /root/check-mailbox-connect.sh'
} finally { Remove-Item -Force $Tmp -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host 'Send this whole screen.' -ForegroundColor Cyan
