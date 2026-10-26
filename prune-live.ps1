# ============================================================
# TEAMLINK - SHRINK THE LIVE SITE TO MATCH LOCALHOST (deletes on the live site)
#
#   .\prune-live.ps1 -DryRun        make the plan and show it. NOTHING is deleted anywhere.
#   .\prune-live.ps1                plan, then type  DELETE FROM LIVE  to really delete
#   .\prune-live.ps1 -IncludeMoney  also remove deleted invoices and payments (kept by default)
#   .\prune-live.ps1 -Undo          put the rows of the last run back on the live site
#
# What it deletes: ONLY rows you deleted on localhost (they are in the baseline, and gone from localhost) in these ATS tables:
#   Application, ApplicationFollowUp, ApplicationStageEvent, InterviewEvent, Requirement, RequirementPosting,
#   Client, ClientAlias, PortalRequest   (+ Invoice, InvoicePayment with -IncludeMoney)
# It keeps (never deletes):
#   * anything the live site changed after the baseline (live work is never deleted),
#   * any row that a row staying on the live site still points to,
#   * every table in exclusions.json: leave, timesheets, attendance, biometric devices and punches,
#     e-mail / WhatsApp / SMS / integration settings, message templates, users, logins ...
#   * candidates, employees, uploaded files.
# Safety: full backup of the live database first; rows go in small batches (the live site is never stopped and is
# never blocked for long); every deleted row is saved so  -Undo  can put it back.
# ============================================================

param(
    [switch]$DryRun,
    [switch]$IncludeMoney,
    [switch]$Undo,
    [string]$Tables = ""
)

$ErrorActionPreference = "Stop"

$LocalRoot   = $PSScriptRoot
$Backend     = Join-Path $LocalRoot "backend"
$Tool        = Join-Path $Backend "scripts\delta-sync"
$LocalDb     = Join-Path $Backend "prisma\dev.db"
$HostVPS     = "root@72.61.233.104"
$VpsRoot     = "/opt/teamlink-enterprise"
$RemoteDb    = "$VpsRoot/backend/prisma/dev.db"
$RemoteTool  = "$VpsRoot/backend/scripts/delta-sync"
$BaseDir     = "C:\Users\user\.teamlink-backups\sync-baseline"
$Baseline    = Join-Path $BaseDir "baseline.db"
$BackupDir   = "C:\Users\user\.teamlink-backups\sync-both"
$ReportDir   = "C:\Users\user\Desktop\All_Projects\TeamLink-Sync-Reports"
$Stamp       = Get-Date -Format "yyyyMMdd-HHmmss"
$Work        = Join-Path $env:TEMP "teamlink-prune-$Stamp"
$Hist        = Join-Path $BackupDir "prune-$Stamp"
$LockFile    = Join-Path $BaseDir "sync.lock"
$LastFile    = Join-Path $BaseDir "last-prune.json"
$RemoteWork  = "/tmp/teamlink-prune-$Stamp"
$RemoteBackup = "/root/teamlink-backups/before-prune-$Stamp.db"
$RemoteUndo  = "/root/teamlink-backups/prune-undo-$Stamp.json"
$Code        = 0
$LockMine    = $false
$RemoteCleanup = $false

# every ssh/scp gives up by itself when the line goes silent (about 30 seconds) instead of waiting for ever
$SshOpt = @("-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3")

function Say($t, $c = "White") { Write-Host $t -ForegroundColor $c }
function Fail($t) { throw $t }
function NodeRun {
    param([string[]]$Arguments)
    $out = & node @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "A helper step failed: node $($Arguments -join ' ')" }
    return $out
}
function Helper($sub, [string[]]$more) { return NodeRun (@((Join-Path $Tool "helper.js"), $sub) + $more) }

try {
    Say ""
    Say "=== TeamLink: shrink the live site to match localhost ===" Cyan
    if ($DryRun) { Say "(DRY RUN: plan only. Nothing is deleted anywhere.)" Yellow }

    foreach ($f in @("make-delta.js","make-prune.js","prune-engine.js","prune-apply.js","prune-baseline.js","lib.js","helper.js","exclusions.json")) {
        if (!(Test-Path (Join-Path $Tool $f))) { Fail "Tool file missing: $Tool\$f (run git pull first)" }
    }
    if (!(Test-Path $LocalDb)) { Fail "Local database not found: $LocalDb" }
    if (!(Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found on this computer." }
    New-Item -ItemType Directory -Force $BaseDir, $BackupDir, $ReportDir | Out-Null

    # ---------------- undo the last prune ----------------
    if ($Undo) {
        if (!(Test-Path $LastFile)) { Fail "No record of a previous prune (last-prune.json)." }
        $Last = Get-Content $LastFile -Raw | ConvertFrom-Json
        Say "This puts back on the LIVE site the rows deleted by the prune of $($Last.stamp)."
        Say "Rows that exist again are left alone. Nothing else is touched."
        $A = Read-Host "Type  RESTORE DELETED  to continue"
        if ($A -cne "RESTORE DELETED") { Say "Cancelled." Yellow; return }
        ssh @SshOpt $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/prune-apply.js --restore '$($Last.remoteUndo)'"
        if ($LASTEXITCODE -ne 0) { Fail "The restore did not finish. The full backup is on the server: $($Last.remoteBackup)" }
        if ($Last.baselineBackup -and (Test-Path $Last.baselineBackup)) { Copy-Item $Last.baselineBackup $Baseline -Force; Say "Baseline restored." Green }
        Say "Undo finished. Refresh the live site in your browser." Green
        return
    }

    # ---------------- lock: never together with a sync ----------------
    if (Test-Path $LockFile) {
        $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
        if ($age.TotalHours -lt 3) { Fail "A sync (or another prune) seems to be running (lock file $LockFile, $([int]$age.TotalMinutes) minutes old). If not, delete that file." }
    }
    Set-Content $LockFile "$PID $Stamp"
    $LockMine = $true

    if (!(Test-Path $Baseline)) { Fail "The baseline file is missing: $Baseline (run .\sync-both.ps1 -DryRun once first)." }

    New-Item -ItemType Directory -Force $Work, $Hist | Out-Null
    $LocalSnap = Join-Path $Work "local-snapshot.db"
    $LiveCopy  = Join-Path $Work "live-copy.db"
    $DL        = Join-Path $Work "delta-local.json"
    $Plan      = Join-Path $Hist "prune.json"
    $PlanText  = Join-Path $Hist "prune-report.txt"

    # ---------------- 1. snapshots (read-only) ----------------
    Say "1/6  Safe snapshot of localhost (your local server keeps running)..."
    Helper "snapshot" @("--src", $LocalDb, "--dest", $LocalSnap) | Out-Null
    Say "2/6  READ-ONLY copy of the live database (the live site is not stopped or changed)..."
    $RemoteView = "/tmp/teamlink-pruneview-$Stamp.db"
    ssh @SshOpt $HostVPS "set -e; sqlite3 '$RemoteDb' '.backup $RemoteView'; test `"`$(sqlite3 '$RemoteView' 'PRAGMA integrity_check;')`" = ok; echo LIVE_COPY_OK"
    if ($LASTEXITCODE -ne 0) { Fail "Could not copy the live database. Nothing was changed." }
    scp @SshOpt "${HostVPS}:$RemoteView" $LiveCopy
    $dl = $LASTEXITCODE
    ssh @SshOpt $HostVPS "rm -f '$RemoteView'" | Out-Null
    if ($dl -ne 0) { Fail "Download of the live copy failed. Nothing was changed." }
    $Chk = & node (Join-Path $Tool "helper.js") integrity --db $LiveCopy
    if ($LASTEXITCODE -ne 0 -or "$Chk".Trim() -ne "ok") { Fail "The downloaded live copy is damaged. Nothing was changed." }

    # ---------------- 2. the plan ----------------
    Say "3/6  Finding what you deleted on localhost since the baseline..."
    NodeRun @((Join-Path $Tool "make-delta.js"), "--baseline", $Baseline, "--local", $LocalSnap, "--out", $DL) | Out-Null
    Say "4/6  Checking each of those rows on the live site (live work and rows still in use are kept)..."
    $MpArgs = @((Join-Path $Tool "make-prune.js"), "--delta", $DL, "--baseline", $Baseline, "--live", $LiveCopy, "--out", $Plan, "--report", $PlanText)
    if ($IncludeMoney) { $MpArgs += "--include-money" }
    if ($Tables) { $MpArgs += @("--tables", $Tables) }
    $MpOut = & node @MpArgs
    $ex = $LASTEXITCODE
    $MpOut | ForEach-Object { Write-Host $_ }
    if ($ex -eq 4) { Fail "The plan deletes more rows than the safety limit. Nothing was changed. Check the report above." }
    if ($ex -ne 0) { Fail "Could not make the delete plan. Nothing was changed." }
    Copy-Item $PlanText (Join-Path $ReportDir "prune-$Stamp.txt") -Force -ErrorAction SilentlyContinue
    $PL = ($MpOut | Where-Object { $_ -like "PRUNE_PLAN*" } | Select-Object -Last 1)
    $Total = [int]([regex]::Match($PL, 'total=(\d+)').Groups[1].Value)

    Say ""
    Say "SUMMARY: $Total row(s) would be DELETED from the live site." Yellow
    Say "Plan saved: $Plan   Report: $ReportDir\prune-$Stamp.txt"
    if ($DryRun) {
        Say ""
        Say "DRY RUN finished. Nothing was changed on either side." Green
        return
    }
    if ($Total -eq 0) { Say "Nothing to delete. The live site already matches localhost for these tables." Green; return }

    # ---------------- 3. the one question ----------------
    Say ""
    Say "This DELETES $Total rows from the REAL live database. A full backup is taken first and  .\prune-live.ps1 -Undo  puts them back." Yellow
    $Ans = Read-Host "Type  DELETE FROM LIVE  to continue (anything else cancels)"
    if ($Ans -cne "DELETE FROM LIVE") { Say "Cancelled. Nothing was changed." Yellow; return }

    # ---------------- 4. back up ----------------
    Say "5/6  Backing up the live database first..."
    $BaselineBackup = Join-Path $Hist "baseline-before-prune.db"
    Copy-Item $Baseline $BaselineBackup -Force
    ssh @SshOpt $HostVPS "set -e; mkdir -p /root/teamlink-backups; sqlite3 '$RemoteDb' '.backup $RemoteBackup'; test `"`$(sqlite3 '$RemoteBackup' 'PRAGMA integrity_check;')`" = ok; echo BACKUP_OK"
    if ($LASTEXITCODE -ne 0) { Fail "Live backup failed. Nothing was changed." }

    # ---------------- 5. delete on the live site ----------------
    Say "6/6  Deleting on the live site in small batches (the live site keeps running)..."
    $RemoteCleanup = $true
    ssh @SshOpt $HostVPS "mkdir -p '$RemoteWork'"
    if ($LASTEXITCODE -ne 0) { Fail "Could not prepare the live server folder. Nothing was changed." }
    scp @SshOpt $Plan "${HostVPS}:$RemoteWork/prune.json"
    if ($LASTEXITCODE -ne 0) { Fail "Upload failed. Nothing was changed on the live site." }
    foreach ($f in @("prune-apply.js","prune-engine.js","lib.js")) {
        scp @SshOpt (Join-Path $Tool $f) "${HostVPS}:$RemoteTool/$f"
        if ($LASTEXITCODE -ne 0) { Fail "Upload of $f failed. Nothing was changed on the live site." }
    }
    $ApplyLog = Join-Path $Hist "prune-live-output.txt"
    ssh @SshOpt $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/prune-apply.js --prune '$RemoteWork/prune.json' --apply --undo-out '$RemoteUndo' --result-out '$RemoteWork/result.json'" | Tee-Object -FilePath $ApplyLog
    $ex = $LASTEXITCODE
    if ($ex -ne 0) {
        Say "The delete step stopped early (exit $ex). Rows deleted so far can be put back with  .\prune-live.ps1 -Undo . Backup on the server: $RemoteBackup" Red
        $Code = 1
    }
    $ResultFile = Join-Path $Hist "prune-result.json"
    scp @SshOpt "${HostVPS}:$RemoteWork/result.json" $ResultFile
    if ($LASTEXITCODE -eq 0) {
        $BlOut = & node (Join-Path $Tool "prune-baseline.js") --baseline $Baseline --result $ResultFile
        if ($LASTEXITCODE -eq 0) { Say "$BlOut" } else { Say "The baseline could not be updated (harmless: the next report just counts those rows as deleted locally)." Yellow }
    } else {
        Say "Could not download the result file; the baseline was not changed (harmless)." Yellow
    }
    @{ stamp = $Stamp; remoteUndo = $RemoteUndo; remoteBackup = $RemoteBackup; baselineBackup = $BaselineBackup } | ConvertTo-Json | Set-Content $LastFile

    Say ""
    $Health = ssh @SshOpt $HostVPS 'P=$(grep -E "^PORT=" /opt/teamlink-enterprise/backend/.env | cut -d= -f2); curl -s http://127.0.0.1:${P:-4010}/api/health'
    Say "Live site health check: $Health"
    if ($Code -eq 0) { Say "PRUNE DONE. Refresh the live site (Ctrl+F5) and compare the ATS dashboard with localhost." Green }
    else { Say "PRUNE FINISHED WITH PROBLEMS. Read the output above." Yellow }
    Say "Report: $ReportDir\prune-$Stamp.txt"
    Say ""
    Say "TO UNDO:  .\prune-live.ps1 -Undo        (full backup of the live database: $RemoteBackup on the server)"
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $Code = 1
}
finally {
    if ($RemoteCleanup) { ssh @SshOpt $HostVPS "rm -rf '$RemoteWork'" | Out-Null }
    if ($LockMine -and (Test-Path $LockFile)) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path $Work) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
