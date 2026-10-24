$ErrorActionPreference = "Stop"

$HostVPS = "root@72.61.233.104"
$RemoteDb = "/opt/teamlink-enterprise/backend/prisma/dev.db"
$LocalDb = "C:\Users\user\Desktop\All_Projects\teamlink-enterprise\backend\prisma\dev.db"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RemoteCopy = "/tmp/teamlink-pull-$Stamp.db"
$Download = Join-Path $env:TEMP "teamlink-pull-$Stamp.db"
$Backup = "$LocalDb.before-vps-pull-$Stamp.bak"

if (!(Test-Path $LocalDb)) { throw "Local database not found: $LocalDb" }

# --- WARN if localhost has work that was never sent to the live site (changes-only sync baseline) ---
$ToolDir = "C:\Users\user\Desktop\All_Projects\teamlink-enterprise\backend\scripts\delta-sync"
$BaselineDir = "C:\Users\user\.teamlink-backups\sync-baseline"
$BaselineFile = Join-Path $BaselineDir "baseline.db"
if (Test-Path $BaselineFile) {
    $SnapTmp = Join-Path $env:TEMP "teamlink-unpushed-$Stamp.db"
    try {
        node (Join-Path $ToolDir "helper.js") snapshot --src $LocalDb --dest $SnapTmp | Out-Null
        $CountJson = node (Join-Path $ToolDir "helper.js") count --baseline $BaselineFile --local $SnapTmp
        if ($LASTEXITCODE -eq 0) {
            $Cnt = $CountJson | ConvertFrom-Json
            if (($Cnt.inserts + $Cnt.updates) -gt 0) {
                Write-Host ""
                Write-Host "WARNING: localhost has changes that were NEVER sent to the live site: $($Cnt.inserts) new row(s), $($Cnt.updates) edited row(s)." -ForegroundColor Red
                Write-Host "Replacing the local database now would ERASE that local work." -ForegroundColor Red
                Write-Host "Safer: .\sync-both.ps1 (brings the live changes here AND sends yours there)." -ForegroundColor Yellow
                $Go = Read-Host "Type exactly  ERASE LOCAL WORK  to replace the local database anyway"
                if ($Go -cne "ERASE LOCAL WORK") { throw "Cancelled. Local database unchanged." }
            }
        }
    } finally { Remove-Item $SnapTmp -Force -ErrorAction SilentlyContinue }
} else {
    Write-Host "Note: no sync baseline found, so I cannot check for un-pushed local work." -ForegroundColor Yellow
}

$Listener = Get-NetTCPConnection -LocalPort 4010 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

if ($Listener) {
    Write-Host "Local TeamLink API is running on port 4010."
    $Answer = Read-Host "Stop its process before replacing the database? Type YES"
    if ($Answer.Trim() -ine "YES") { throw "Cancelled. No database replaced." }
    Stop-Process -Id $Listener.OwningProcess -Force
    Start-Sleep -Seconds 2
    if (Get-NetTCPConnection -LocalPort 4010 -State Listen -ErrorAction SilentlyContinue) {
        throw "Port 4010 is still active. No database replaced."
    }
}

Write-Host "Creating a consistent VPS database backup..."
$RemoteCommand = "set -e; sqlite3 '$RemoteDb' '.backup $RemoteCopy'; test `"`$(sqlite3 '$RemoteCopy' 'PRAGMA integrity_check;')`" = ok; echo VPS_BACKUP_OK"
ssh $HostVPS $RemoteCommand
if ($LASTEXITCODE -ne 0) { throw "VPS backup failed." }

Write-Host "Downloading VPS database..."
scp "${HostVPS}:$RemoteCopy" $Download
if ($LASTEXITCODE -ne 0) { throw "Download failed." }

$Check = node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close()" $Download
if ($LASTEXITCODE -ne 0 -or $Check.Trim() -ne "ok") {
    throw "Downloaded database integrity check failed. Local database unchanged."
}

Write-Host "Checking and checkpointing local database..."
$Checkpoint = node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()" $LocalDb
if ($LASTEXITCODE -ne 0 -or $Checkpoint.Trim() -ne "ok") {
    throw "Local database check failed. Local database not replaced."
}

Copy-Item $LocalDb $Backup
foreach ($Suffix in @("-wal", "-shm")) {
    $Sidecar = "$LocalDb$Suffix"
    if (Test-Path $Sidecar) { Remove-Item $Sidecar -Force }
}
Copy-Item $Download $LocalDb -Force

$FinalCheck = node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close()" $LocalDb
if ($LASTEXITCODE -ne 0 -or $FinalCheck.Trim() -ne "ok") {
    Copy-Item $Backup $LocalDb -Force
    throw "Final check failed. Restored the previous local database; check backup and sidecar files before restarting."
}

# --- Right after a full pull, localhost == live site: remember this as the new BASELINE ---
try {
    New-Item -ItemType Directory -Force $BaselineDir | Out-Null
    $NewBase = Join-Path $BaselineDir "baseline.new.db"
    node (Join-Path $ToolDir "helper.js") snapshot --src $Download --dest $NewBase | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "baseline snapshot failed" }
    if (Test-Path $BaselineFile) { Copy-Item $BaselineFile (Join-Path $BaselineDir "baseline.prev.db") -Force }
    Move-Item $NewBase $BaselineFile -Force
    Write-Host "Sync baseline saved: $BaselineFile (previous one kept as baseline.prev.db)"
} catch {
    Write-Host "WARNING: could not save the sync baseline: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "SUCCESS: VPS database copied to Local."
Write-Host "Local backup: $Backup"
Write-Host "Integrity: $FinalCheck"
Write-Host "Start your local TeamLink backend again when ready."

