# Copies TeamLink's own helper files (gate, local bind, seed, watchdog, start/stop scripts, pg-tool) into green-start-app\run.
#
# WHY: green-start-app\ is the founder's Green Start product, a git SUBMODULE (repo Omni-channel---Greenstart). Those helper files are NOT part
# of that repo (they are TeamLink's glue: backend\src\utils\greenStartSupervisor.js starts them), so they are kept HERE, in the main repo,
# and copied into the submodule's run\ folder. run\ itself (pgdata, redis, logs, pg-tool\node_modules) is local runtime data: never committed.
#
# Run after `git clone --recurse-submodules` or `git submodule update` (safe to run any time; it only overwrites the files listed below):
#   powershell -ExecutionPolicy Bypass -File green-start-helpers\install-helpers.ps1
# Then, once on a new PC: `npm install` inside green-start-app\run\pg-tool, and double-click run\get-redis.cmd (Redis is not committed).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dst  = Join-Path (Split-Path $here -Parent) 'green-start-app\run'
if (-not (Test-Path (Join-Path (Split-Path $here -Parent) 'green-start-app\gs-api'))) { throw 'green-start-app is empty: run  git submodule update --init --recursive  first.' }
New-Item -ItemType Directory (Join-Path $dst 'pg-tool') -Force | Out-Null
$n = 0
foreach ($f in Get-ChildItem (Join-Path $here 'run') -Recurse -File) {
  $rel = $f.FullName.Substring((Join-Path $here 'run').Length + 1)
  $to  = Join-Path $dst $rel
  $same = (Test-Path $to) -and ((Get-FileHash $to).Hash -eq (Get-FileHash $f.FullName).Hash)
  if (-not $same) { Copy-Item $f.FullName $to -Force; $n++; Write-Host "  copied $rel" }
}
Write-Host "Green Start helper files up to date ($n copied)."
if (-not (Test-Path (Join-Path $dst 'pg-tool\node_modules'))) { Write-Host 'NOTE: run\pg-tool\node_modules is missing: run  npm install  inside green-start-app\run\pg-tool (portable PostgreSQL).' }
