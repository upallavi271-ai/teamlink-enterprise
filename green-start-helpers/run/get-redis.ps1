# TeamLink helper (NOT part of the Green Start zip). Run by the FOUNDER, once, by double-clicking get-redis.cmd.
#
# What it does, step by step (nothing happens before you press a key):
#   1. If a Redis (Memurai, or any other) already answers on 127.0.0.1:6379, it does NOTHING and tells you so.
#   2. Shows the exact file name, address and size, and asks you to press a key.
#   3. Downloads ONE zip from the official GitHub release page of tporadowski/redis (the Windows port of Redis 5).
#   4. Checks it is a real zip and contains redis-server.exe, prints its SHA-256 so you can keep it for your records.
#   5. Unzips into  green-start-app\run\redis\   and checks  redis-server.exe --version.
# What it does NOT do: no Windows service, no installer, no registry, no PATH change, nothing outside green-start-app\run\redis.
# After this, TeamLink starts Redis by itself (127.0.0.1 only, 256 MB limit, password set automatically) when it starts Green Start.
#
# HONEST NOTE about the SHA-256: the publisher's hash for this file is not known to this script, so it cannot be compared with a pinned value
# unless YOU give one:  .\get-redis.ps1 -Sha256 <64 hex letters from the release page>.  Without it the hash is only printed for your records.
param(
  [string]$Sha256 = '',
  [switch]$Force   # download even if a Redis already answers on 6379
)

# ---- change these two lines if a newer 5.0.x release is wanted -------------------------------------------------------------
$Version = '5.0.14.1'
$Url     = "https://github.com/tporadowski/redis/releases/download/v$Version/Redis-x64-$Version.zip"
# -----------------------------------------------------------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Run     = $PSScriptRoot
$Target  = Join-Path $Run 'redis'
$Work    = Join-Path $Run 'redis-download'
$ZipName = [IO.Path]::GetFileName(([Uri]$Url).AbsolutePath)
$Zip     = Join-Path $Work $ZipName

function Test-Redis([int]$Port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $r = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $r.AsyncWaitHandle.WaitOne(800)) { $c.Close(); return $false }
    $c.EndConnect($r)
    $s = $c.GetStream(); $s.ReadTimeout = 800
    $b = [Text.Encoding]::ASCII.GetBytes("*1`r`n`$4`r`nPING`r`n"); $s.Write($b, 0, $b.Length)
    $buf = New-Object byte[] 64; $n = $s.Read($buf, 0, 64); $c.Close()
    $t = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    return ($t -match '^\+PONG' -or $t -match 'NOAUTH')
  } catch { return $false }
}

Write-Host ''
Write-Host 'Green Start needs Redis (a small message queue). This gets the Windows port of Redis 5 for you.' -ForegroundColor Cyan
Write-Host ''

if ((Test-Redis 6379) -and -not $Force) {
  Write-Host 'A Redis already answers on 127.0.0.1:6379 (Memurai or another Redis). Nothing to download. Nothing was changed.' -ForegroundColor Green
  Write-Host 'TeamLink will use it. (Add -Force to download this one anyway.)'
  exit 0
}
if (Test-Path (Join-Path $Target 'redis-server.exe')) {
  Write-Host "redis-server.exe is already in $Target" -ForegroundColor Green
  & (Join-Path $Target 'redis-server.exe') --version
  Write-Host 'Nothing to do. TeamLink starts it by itself.'
  exit 0
}

# size before downloading (a HEAD request: nothing is downloaded yet)
$size = 'unknown'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $h = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 30
  $len = [int64]($h.Headers['Content-Length'] | Select-Object -First 1)
  if ($len -gt 0) { $size = ('{0:N1} MB' -f ($len / 1MB)) }
} catch { Write-Host "Could not read the size ($($_.Exception.Message)). The address may have changed; the download below will tell." -ForegroundColor Yellow }

Write-Host "File    : $ZipName"
Write-Host "From    : $Url"
Write-Host "Size    : $size"
Write-Host "Goes to : $Target   (nothing else on this computer is changed)"
Write-Host ''
Write-Host 'Press any key to download, or close this window to cancel...' -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

New-Item -ItemType Directory -Force $Work | Out-Null
try {
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
} catch {
  Write-Host "Download failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Open https://github.com/tporadowski/redis/releases in a browser, download the Redis-x64-5.0.x.zip file, and unzip it so that redis-server.exe is in:'
  Write-Host "  $Target"
  exit 1
}

# is it a zip, and is redis-server.exe inside?
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ok = $false
try {
  $z = [IO.Compression.ZipFile]::OpenRead($Zip)
  try { $ok = [bool]($z.Entries | Where-Object { $_.Name -ieq 'redis-server.exe' }) } finally { $z.Dispose() }
} catch { $ok = $false }
if (-not $ok) { Write-Host 'The downloaded file is not a zip with redis-server.exe inside. Nothing was installed. Deleting it.' -ForegroundColor Red; Remove-Item $Zip -Force; exit 1 }

$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash
Write-Host "SHA-256 : $hash"
Write-Host '(keep this for your records)'
if ($Sha256) {
  if ($hash -ne $Sha256.Trim().ToUpper()) { Write-Host 'The SHA-256 does NOT match the one you gave. Nothing was installed. Deleting the file.' -ForegroundColor Red; Remove-Item $Zip -Force; exit 1 }
  Write-Host 'SHA-256 matches the one you gave.' -ForegroundColor Green
} else {
  Write-Host 'No -Sha256 was given, so this was NOT compared with the publisher''s value.' -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force $Target | Out-Null
Expand-Archive -Path $Zip -DestinationPath $Target -Force
Remove-Item $Work -Recurse -Force
$exe = Join-Path $Target 'redis-server.exe'
if (-not (Test-Path $exe)) { Write-Host 'redis-server.exe is not where it should be after unzipping. Look inside the redis folder.' -ForegroundColor Red; exit 1 }
Write-Host ''
& $exe --version
Write-Host ''
Write-Host 'Done. Redis is ready in green-start-app\run\redis. TeamLink starts it by itself within a minute (Omni-Channel page: "Starting...").' -ForegroundColor Green
