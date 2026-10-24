# TeamLink launcher for Green Start (the founder's own product in this folder, source unchanged). NOT part of the Green Start zip.
#
#   Start:  double-click start-green-start.cmd      (or: powershell -ExecutionPolicy Bypass -File .\start-green-start.ps1)
#   Stop:   double-click stop-green-start.cmd
#
# Starts, each in its own small window with a clear title (closing a window stops that part):
#   Green Start - DATABASE   portable PostgreSQL 16   127.0.0.1:5436   (no Windows service; data in run\pgdata)
#   Green Start - API        the product's server     127.0.0.1:4020
#   Green Start - WORKER     sends campaigns          (only when Redis is running)
#   Green Start - ENTRANCE   the TeamLink gate        http://localhost:5190   (what the Omni-Channel button opens)
# Safe to run twice: a part whose port is already open is left alone.
# NEVER started from here: the product's own start-all.ps1 / watch-sync.ps1 / auto-sync.ps1 (they push code to GitHub on a timer).
param([switch]$Force, [switch]$NoBuild)
$ErrorActionPreference = 'Continue'  # native tools (npm, prisma) write warnings to stderr; every step below is checked on its own
$Run  = $PSScriptRoot
$Root = Split-Path $Run -Parent
$Api  = Join-Path $Root 'gs-api'
$Web  = Join-Path $Root 'green-start-web'
$Logs = Join-Path $Run 'logs'
New-Item -ItemType Directory -Force $Logs | Out-Null
$PidFile = Join-Path $Run 'pids.json'
$pids = @{}
if (Test-Path $PidFile) { try { (Get-Content $PidFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $pids[$_.Name] = $_.Value } } catch { } }
function Save-Pids { ($pids | ConvertTo-Json) | Set-Content $PidFile -Encoding ascii }
function Test-Port([int]$p) { try { $c = New-Object Net.Sockets.TcpClient; $r = $c.BeginConnect('127.0.0.1', $p, $null, $null); $ok = $r.AsyncWaitHandle.WaitOne(700); if ($ok) { $c.EndConnect($r) }; $c.Close(); return $ok } catch { return $false } }
function Wait-Port([int]$p, [int]$sec) { for ($i = 0; $i -lt $sec; $i++) { if (Test-Port $p) { return $true }; Start-Sleep 1 }; return $false }
function Free-MB { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024) }
function Start-Part([string]$name, [string]$dir, [string]$cmd) {
  $title = "Green Start - $name"
  $full = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$dir'; $cmd"
  $p = Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $full -WindowStyle Minimized -PassThru
  $pids[$name] = $p.Id; Save-Pids
}

# the ports (change here AND in backend/.env GREENSTART_* only if one is taken)
$DbPort = 5436; $ApiPort = 4020; $GatePort = 5190; $RedisPort = 6379
foreach ($p in 4010, 5183, 4323, 5432, 5434) { if ($p -in $DbPort, $ApiPort, $GatePort) { Write-Host "Port $p belongs to TeamLink. Stopping." -ForegroundColor Red; exit 1 } }

Write-Host "Free memory: $(Free-MB) MB (Green Start needs about 1 GB with the database)"
if ((Free-MB) -lt 500 -and -not $Force) { Write-Host 'Less than 500 MB free. Close something first, then run this again (or add -Force).' -ForegroundColor Yellow; exit 1 }
$node = (Get-Command node).Source
if (-not (Test-Path (Join-Path $Api '.env'))) { Write-Host 'gs-api\.env is missing (local settings). See Install-Report.md.' -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $Api 'node_modules')) -or -not (Test-Path (Join-Path $Web 'node_modules'))) { Write-Host 'Run "npm ci" once in gs-api and in green-start-web first (see Install-Report.md).' -ForegroundColor Red; exit 1 }

# 1. database
if (Test-Port $DbPort) { Write-Host "Database: already running on $DbPort" }
else {
  Start-Part 'DATABASE' (Join-Path $Run 'pg-tool') "node pg.mjs"
  if (-not (Wait-Port $DbPort 120)) { Write-Host 'Database did not start. Look at its window.' -ForegroundColor Red; exit 1 }
  Write-Host "Database: started on 127.0.0.1:$DbPort"
}
# apply any new migrations (does nothing when up to date). Seed once: run\seed-demo.cmd
Push-Location $Api; try { & npx prisma migrate deploy 2>&1 | Select-Object -Last 1 } finally { Pop-Location }

# 2. Redis: only if it is already there. Nothing is downloaded or installed here.
if (Test-Port $RedisPort) { Write-Host "Redis: already running on $RedisPort" }
else {
  $cand = @((Join-Path $Run 'redis\redis-server.exe'), "$env:ProgramFiles\Memurai\memurai.exe", "$env:ProgramFiles\Redis\redis-server.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($cand) { Start-Part 'REDIS' (Split-Path $cand) "& '$cand' --port $RedisPort --bind 127.0.0.1"; if (Wait-Port $RedisPort 20) { Write-Host 'Redis: started' } }
  else {
    Write-Host 'Redis: NOT INSTALLED on this computer.' -ForegroundColor Red
    Write-Host 'Green Start cannot start without Redis: its server waits for Redis while starting (tested: it never opens its port). Nothing is installed by this script.' -ForegroundColor Red
    Write-Host 'Install ONE of these once, then run this again:  Memurai Developer (memurai.com, free, Windows service)  or  the tporadowski/redis zip unzipped into green-start-app\run\redis  (see Install-Report.md).' -ForegroundColor Yellow
    Write-Host 'The database is running; TeamLink Omni-Channel will say "Green Start is not started" until then.' -ForegroundColor Yellow
    exit 2
  }
}

# 3. builds (once)
if (-not $NoBuild) {
  if (-not (Test-Path (Join-Path $Api 'dist\main.js'))) {
    Write-Host 'Building the Green Start server (first time only, a few minutes)...'
    Push-Location $Api; try { $env:NODE_OPTIONS = '--max-old-space-size=1800'; & npm run build } finally { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; Pop-Location }
  }
  if (-not (Test-Path (Join-Path $Web 'dist\index.html'))) {
    Write-Host 'Building the Green Start screens (first time only, a few minutes)...'
    Push-Location $Web
    try { $env:NODE_OPTIONS = '--max-old-space-size=1800'; $env:VITE_USE_MOCKS = 'false'; $env:VITE_API_BASE_URL = '/api/v1'; & npm run build }
    finally { 'NODE_OPTIONS', 'VITE_USE_MOCKS', 'VITE_API_BASE_URL' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }; Pop-Location }
  }
}
if (-not (Test-Path (Join-Path $Api 'dist\main.js')) -or -not (Test-Path (Join-Path $Web 'dist\index.html'))) { Write-Host 'A build is missing. Look at the messages above.' -ForegroundColor Red; exit 1 }

# 4. API (listens on this computer only: bind-local.cjs; reads gs-api\.env itself)
$bind = (Join-Path $Run 'bind-local.cjs')
if (Test-Port $ApiPort) { Write-Host "API: already running on $ApiPort" }
else {
  Start-Part 'API' $Api "`$env:NODE_OPTIONS='--require $bind --max-old-space-size=512'; node --env-file=.env dist/main"
  if (-not (Wait-Port $ApiPort 120)) { Write-Host 'API did not start. Look at its window.' -ForegroundColor Red; exit 1 }
  Write-Host "API: started on 127.0.0.1:$ApiPort"
}

# 5. worker (needs Redis)
if (Test-Port $RedisPort) {
  if ($pids.ContainsKey('WORKER') -and (Get-Process -Id $pids['WORKER'] -ErrorAction SilentlyContinue)) { Write-Host 'Worker: already running' }
  elseif ((Free-MB) -gt 300 -or $Force) { Start-Part 'WORKER' $Api "`$env:NODE_OPTIONS='--max-old-space-size=384'; node --env-file=.env dist/queue/worker.bootstrap"; Write-Host 'Worker: started' }
  else { Write-Host 'Worker: not started (not enough free memory)' -ForegroundColor Yellow }
} else { Write-Host 'Worker: not started (needs Redis)' -ForegroundColor Yellow }

# 6. the entrance
if (Test-Port $GatePort) { Write-Host "Entrance: already running on $GatePort" }
else {
  Start-Part 'ENTRANCE' $Run "node gate.mjs"
  if (-not (Wait-Port $GatePort 30)) { Write-Host 'Entrance did not start. Look at its window.' -ForegroundColor Red; exit 1 }
  Write-Host "Entrance: started on http://localhost:$GatePort"
}

Write-Host ''
Write-Host 'Green Start is ready. In TeamLink click Omni-Channel in the left menu.' -ForegroundColor Green
Write-Host 'Stop it with stop-green-start.cmd'
