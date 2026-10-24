$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# LOCKED (changes-only sync). This script REPLACES THE WHOLE LIVE DATABASE with the local one.
# Everything people did on the live site since the last copy would be ERASED.
# The safe daily way is:  .\sync-both.ps1 -DryRun   then   .\sync-both.ps1
#                         (or .\push-changes-to-vps.ps1 for a push-only run)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "WARNING: this script REPLACES THE WHOLE LIVE DATABASE with your local one." -ForegroundColor Red
Write-Host "Everything entered on the live site since the last copy (new candidates, edits, attendance, demos) will be ERASED." -ForegroundColor Red
Write-Host "The safe way is .\sync-both.ps1 (or .\push-changes-to-vps.ps1): it sends only your changes and keeps everything on the live site." -ForegroundColor Yellow
Write-Host ""
$LockAnswer = Read-Host "To go on anyway type exactly:  OVERWRITE ALL LIVE DATA"
if ($LockAnswer -cne "OVERWRITE ALL LIVE DATA") { Write-Host "Cancelled. Nothing was changed. Use sync-both.ps1 instead." -ForegroundColor Green; return }


$HostVPS = "root@72.61.233.104"
$RemoteDb = "/opt/teamlink-enterprise/backend/prisma/dev.db"
$LocalDb = "C:\Users\user\Desktop\All_Projects\teamlink-enterprise\backend\prisma\dev.db"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Snapshot = Join-Path $env:TEMP "teamlink-push-$Stamp.db"
$RemoteUpload = "/tmp/teamlink-push-$Stamp.db"
$RemoteBackup = "/opt/teamlink-enterprise/backend/prisma/dev-before-local-push-$Stamp.db"
$Backup = "$LocalDb.before-vps-push-$Stamp.bak"
$StoppedLocal = $false
$StoppedVPS = $false

try {
    if (!(Test-Path $LocalDb)) { throw "Local database not found." }

    $Listener = Get-NetTCPConnection -LocalPort 4010 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($Listener) {
        $Answer = Read-Host "Stop the LOCAL TeamLink backend on port 4010? Type YES"
        if ($Answer.Trim() -ine "YES") { throw "Cancelled. No database uploaded." }
        Stop-Process -Id $Listener.OwningProcess -Force
        Start-Sleep -Seconds 2
        if (Get-NetTCPConnection -LocalPort 4010 -State Listen -ErrorAction SilentlyContinue) {
            throw "Port 4010 is still active."
        }
        $StoppedLocal = $true
    }

    $Check = node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()" $LocalDb
    if ($LASTEXITCODE -ne 0 -or $Check.Trim() -ne "ok") { throw "Local database integrity/checkpoint failed." }

    Copy-Item $LocalDb $Snapshot -Force
    Copy-Item $LocalDb $Backup -Force

    $Check = node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close()" $Snapshot
    if ($LASTEXITCODE -ne 0 -or $Check.Trim() -ne "ok") { throw "Local snapshot integrity failed." }

    Write-Host "Uploading verified Local database..."
    scp $Snapshot "${HostVPS}:$RemoteUpload"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed. VPS database unchanged." }

    $Check = ssh $HostVPS "sqlite3 '$RemoteUpload' 'PRAGMA integrity_check;'"
    if ($LASTEXITCODE -ne 0 -or $Check.Trim() -ne "ok") { throw "Uploaded database integrity failed. VPS database unchanged." }

    $Answer = Read-Host "Replace the VPS TeamLink database with LOCAL data? Type YES"
    if ($Answer.Trim() -ine "YES") { throw "Cancelled. VPS database unchanged." }

    ssh $HostVPS "pm2 stop teamlink-enterprise"
    if ($LASTEXITCODE -ne 0) { throw "Could not stop VPS TeamLink backend. VPS database unchanged." }
    $StoppedVPS = $true

    ssh $HostVPS "sqlite3 '$RemoteDb' '.backup $RemoteBackup'"
    if ($LASTEXITCODE -ne 0) { throw "VPS backup failed. Original database was not replaced." }

    $Check = ssh $HostVPS "sqlite3 '$RemoteBackup' 'PRAGMA integrity_check;'"
    if ($LASTEXITCODE -ne 0 -or $Check.Trim() -ne "ok") { throw "VPS backup verification failed." }

    $Check = ssh $HostVPS "cp '$RemoteUpload' '$RemoteDb' && rm -f '$RemoteDb-wal' '$RemoteDb-shm' && sqlite3 '$RemoteDb' 'PRAGMA integrity_check;'"
    if ($LASTEXITCODE -ne 0 -or $Check.Trim() -ne "ok") {
        ssh $HostVPS "cp '$RemoteBackup' '$RemoteDb' && rm -f '$RemoteDb-wal' '$RemoteDb-shm'"
        throw "Replacement failed. VPS backup restore was attempted."
    }

    Write-Host ""
    Write-Host "SUCCESS: Local database copied to VPS."
    Write-Host "VPS backup: $RemoteBackup"
    Write-Host "Local backup: $Backup"
    Write-Host "Integrity: ok"
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    if ($StoppedVPS) {
        Write-Host "Starting VPS TeamLink backend..."
        ssh $HostVPS "pm2 start teamlink-enterprise"
    }
    if ($StoppedLocal) {
        Write-Host "Local backend was stopped. Start it manually when ready."
    }
    Remove-Item $Snapshot -Force -ErrorAction SilentlyContinue
}
