# ============================================================
# TEAMLINK - SYNC BOTH WAYS (the one daily command)
#
#   .\sync-both.ps1 -DryRun        read the report only. Nothing is changed anywhere.
#   .\sync-both.ps1                report, then type  SYNC BOTH  to really sync
#   .\sync-both.ps1 -Auto          unattended (used by the scheduled task): applies ONLY changes
#                                  that do not conflict, never prefers a side, shows a Windows
#                                  notification and exits with a non-zero code on any conflict/error
#   .\sync-both.ps1 -Prefer VPS    settle every conflict in favour of the LIVE site (or -Prefer Local)
#   .\sync-both.ps1 -UndoLast      put both databases back as they were before the last sync
#   .\sync-both.ps1 -LocalToLiveOnly   only send localhost changes to the live site; nothing from the live
#                                  site is written to localhost (combine with -DryRun to preview)
#
# What it does: new and edited rows made on localhost are added to the live site, and new and edited
# rows made on the live site are added to localhost. Only the changed boxes are written. Nothing is
# deleted. Secrets / logins / queues / notifications / test data never travel.
# It never stops the live site (pm2) and never stops your local server.
# ============================================================

param(
    [switch]$DryRun,
    [switch]$Auto,
    [ValidateSet("None", "Local", "VPS")][string]$Prefer = "None",
    [switch]$InitBaselineFromOriginal,
    [switch]$UndoLast,
    [switch]$LocalToLiveOnly
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
$Original    = Join-Path $BaseDir "vps-at-pull-20261015-093919.db"
$BackupDir   = "C:\Users\user\.teamlink-backups\sync-both"
$ReportDir   = "C:\Users\user\Desktop\All_Projects\TeamLink-Sync-Reports"
$Stamp       = Get-Date -Format "yyyyMMdd-HHmmss"
$Work        = Join-Path $env:TEMP "teamlink-sync-$Stamp"
$Hist        = Join-Path $BackupDir $Stamp
$LockFile    = Join-Path $BaseDir "sync.lock"
$LastFile    = Join-Path $BaseDir "last-sync.json"
$RemoteWork  = "/tmp/teamlink-sync-$Stamp"
$RemoteBackup = "/root/teamlink-backups/before-sync-$Stamp.db"
$RemoteUndo  = "/root/teamlink-backups/sync-undo-$Stamp.json"
$Code        = 0
$LockMine    = $false
$RemoteCleanup = $false

# ssh must never wait for a password in -Auto mode
# 2026-10-22: a stalled connection used to hang the run forever (an ssh "rm" cleanup sat for 40 minutes after the live copy was downloaded).
# These options make every ssh/scp give up by itself when the line goes silent (about 30 seconds) instead of waiting for ever.
$SshOpt = @("-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3")
if ($Auto) { $SshOpt = @("-o", "BatchMode=yes") + $SshOpt }

function Say($t, $c = "White") { Write-Host $t -ForegroundColor $c }
function Fail($t) { throw $t }
function Notify($title, $text) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Warning
        $n.Visible = $true
        $n.ShowBalloonTip(15000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Seconds 6
        $n.Dispose()
    } catch { }
}
function NodeRun {
    param([string[]]$Arguments)
    $out = & node @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "A helper step failed: node $($Arguments -join ' ')" }
    return $out
}
function Helper($sub, [string[]]$more) { return NodeRun (@((Join-Path $Tool "helper.js"), $sub) + $more) }

try {
    Say ""
    Say "=== TeamLink: sync localhost and the live site (both ways) ===" Cyan
    if ($Auto -and $Prefer -ne "None") { Fail "-Auto never prefers a side. Remove -Prefer, or run by hand." }
    if ($Auto -and -not $DryRun) { Say "(AUTO mode: only changes that do not conflict are applied.)" Yellow }
    if ($DryRun) { Say "(DRY RUN: report only. Nothing is changed on either side.)" Yellow }

    foreach ($f in @("make-delta.js","classify-delta.js","apply-delta.js","update-baseline.js","compare-dbs.js","engine.js","lib.js","report.js","helper.js","exclusions.json")) {
        if (!(Test-Path (Join-Path $Tool $f))) { Fail "Tool file missing: $Tool\$f" }
    }
    if (!(Test-Path $LocalDb)) { Fail "Local database not found: $LocalDb" }
    if (!(Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found on this computer." }
    New-Item -ItemType Directory -Force $BaseDir, $BackupDir, $ReportDir | Out-Null

    # ---------------- undo the last sync ----------------
    if ($UndoLast) {
        if (!(Test-Path $LastFile)) { Fail "No record of a previous sync (last-sync.json)." }
        $Last = Get-Content $LastFile -Raw | ConvertFrom-Json
        Say "This puts BOTH databases back as they were before the sync of $($Last.stamp):"
        Say "  - live site: rows added by that sync are removed, edited boxes get their old values back"
        Say "  - localhost: same"
        Say "  - the baseline goes back too"
        Say "Anything changed after that sync, in those same rows, is left alone and listed."
        $A = Read-Host "Type  UNDO SYNC  to continue"
        if ($A -cne "UNDO SYNC") { Say "Cancelled." Yellow; return }
        if ($Last.remoteUndo) {
            ssh @SshOpt $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/apply-delta.js --revert '$($Last.remoteUndo)'"
            if ($LASTEXITCODE -ne 0) { Say "Live-site undo did not finish. The full backup is on the server: $($Last.remoteBackup)" Red }
        }
        if ($Last.localUndo -and (Test-Path $Last.localUndo)) {
            Push-Location $Backend
            & node (Join-Path $Tool "apply-delta.js") --db $LocalDb --really-this-database --revert $Last.localUndo
            Pop-Location
        }
        if ($Last.baselineBackup -and (Test-Path $Last.baselineBackup)) { Copy-Item $Last.baselineBackup $Baseline -Force; Say "Baseline restored." Green }
        Say "Undo finished. Refresh your browser tabs." Green
        return
    }

    # ---------------- lock: one sync at a time ----------------
    if (Test-Path $LockFile) {
        $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
        if ($age.TotalHours -lt 3) { Fail "Another sync seems to be running (lock file $LockFile, $([int]$age.TotalMinutes) minutes old). If not, delete that file." }
    }
    Set-Content $LockFile "$PID $Stamp"
    $LockMine = $true

    # ---------------- passwordless ssh check (auto) ----------------
    if ($Auto) {
        $t = ssh @SshOpt $HostVPS "echo ok"
        if ($LASTEXITCODE -ne 0 -or "$t".Trim() -ne "ok") { Fail "ssh would ask for a password or cannot connect. Set up the ssh key first (see TeamLink-Sync-Guide.md). Nothing was changed." }
    }

    # ---------------- baseline ----------------
    if (!(Test-Path $Baseline)) {
        if ($InitBaselineFromOriginal -and (Test-Path $Original)) {
            Say "No baseline yet. Starting it from the verified 15 Oct 09:39 copy of the live site..." Yellow
            Helper "snapshot" @("--src", $Original, "--dest", $Baseline) | Out-Null
        } else {
            Say "STOP: the baseline file is missing: $Baseline" Red
            Say "The baseline is the copy of the database as it was when localhost and the live site last matched."
            Say "First time only:  .\sync-both.ps1 -InitBaselineFromOriginal"
            Say "Or run .\sync-vps-to-local.ps1 (it saves the baseline) if you have no local work to keep."
            $Code = 1; return
        }
    }

    New-Item -ItemType Directory -Force $Work, $Hist | Out-Null
    $LocalSnap = Join-Path $Work "local-snapshot.db"
    $LiveCopy  = Join-Path $Work "live-copy.db"
    $DL = Join-Path $Work "delta-local.json"      # what is new on localhost  (goes to the live site)
    $DV = Join-Path $Work "delta-live.json"       # what is new on the live site (comes to localhost)
    $CL = Join-Path $Work "classified-local.json"
    $CV = Join-Path $Work "classified-live.json"

    # ---------------- 1. snapshots ----------------
    Say "1/8  Safe snapshot of localhost (your local server keeps running)..."
    Helper "snapshot" @("--src", $LocalDb, "--dest", $LocalSnap) | Out-Null
    Say "2/8  READ-ONLY copy of the live database (the live site is not stopped or changed)..."
    $RemoteView = "/tmp/teamlink-syncview-$Stamp.db"
    ssh @SshOpt $HostVPS "set -e; sqlite3 '$RemoteDb' '.backup $RemoteView'; test `"`$(sqlite3 '$RemoteView' 'PRAGMA integrity_check;')`" = ok; echo LIVE_COPY_OK"
    if ($LASTEXITCODE -ne 0) { Fail "Could not copy the live database. Nothing was changed." }
    scp @SshOpt "${HostVPS}:$RemoteView" $LiveCopy
    $dl = $LASTEXITCODE
    ssh @SshOpt $HostVPS "rm -f '$RemoteView'" | Out-Null
    if ($dl -ne 0) { Fail "Download of the live copy failed. Nothing was changed." }
    $Chk = & node (Join-Path $Tool "helper.js") integrity --db $LiveCopy
    if ($LASTEXITCODE -ne 0 -or "$Chk".Trim() -ne "ok") { Fail "The downloaded live copy is damaged. Nothing was changed." }

    # database versions: only a warning, tables/columns on one side only are skipped and reported
    $Sch = & node (Join-Path $Tool "helper.js") schema --baseline $LiveCopy --local $LocalSnap
    if ($LASTEXITCODE -ne 0) {
        Say "Note: localhost and the live site have different database versions (pending updates)." Yellow
        Say "      Tables/columns that only one side has are skipped and listed in the report." Yellow
        Say "      Best: run deploy-local-to-vps.ps1 first (it updates the live database) and update localhost the same way." Yellow
    }

    # ---------------- 2. both deltas ----------------
    Say "3/8  Finding what changed on each side since the last time they matched..."
    NodeRun @((Join-Path $Tool "make-delta.js"), "--baseline", $Baseline, "--local", $LocalSnap, "--out", $DL) | Out-Null
    NodeRun @((Join-Path $Tool "make-delta.js"), "--baseline", $Baseline, "--local", $LiveCopy, "--out", $DV) | Out-Null
    Say "4/8  Checking every change against the other side..."
    $PreferArgs = @()
    $PL = @(); $PV = @()
    if ($Prefer -eq "Local") { $PL = @("--prefer") }
    if ($Prefer -eq "VPS")   { $PV = @("--prefer") }
    Say ""
    Say "################  LOCALHOST  ->  LIVE SITE  ################" Cyan
    $T1 = & node (Join-Path $Tool "classify-delta.js") --delta $DL --target $LiveCopy --report (Join-Path $Hist "report-local-to-live.txt") --json $CL @PL
    if ($LASTEXITCODE -ne 0) { Fail "Could not classify the local changes." }
    $T1 | ForEach-Object { Write-Host $_ }
    Say ""
    Say "################  LIVE SITE  ->  LOCALHOST  ################" Cyan
    $T2 = & node (Join-Path $Tool "classify-delta.js") --delta $DV --target $LocalSnap --report (Join-Path $Hist "report-live-to-local.txt") --json $CV @PV
    if ($LASTEXITCODE -ne 0) { Fail "Could not classify the live-site changes." }
    $T2 | ForEach-Object { Write-Host $_ }
    $RL = Get-Content $CL -Raw | ConvertFrom-Json
    $RV = Get-Content $CV -Raw | ConvertFrom-Json
    $ToLive  = [int]$RL.counts.added + [int]$RL.counts.changed
    $ToLocal = [int]$RV.counts.added + [int]$RV.counts.changed
    $AlLive  = [int]$RL.counts.already
    $AlLocal = [int]$RV.counts.already
    $Conf    = [int]$RL.counts.conflicts + [int]$RV.counts.conflicts
    if ($LocalToLiveOnly) {
        # nothing from the live site is written to localhost: ignore that half completely
        $ToLocal = 0; $AlLocal = 0
        $Conf    = [int]$RL.counts.conflicts
    }
    Copy-Item $DL (Join-Path $Hist "delta-local.json") -Force
    Copy-Item $DV (Join-Path $Hist "delta-live.json") -Force

    Say ""
    if ($LocalToLiveOnly) { Say "-LocalToLiveOnly: the LIVE SITE -> LOCALHOST half above is for information only. Nothing is written to localhost." Yellow }
    Say "SUMMARY: $ToLive row(s) go to the LIVE site, $ToLocal row(s) come to LOCALHOST, $Conf conflict(s)." Yellow
    if ($Conf -gt 0 -and $Prefer -eq "None") { Say "Conflicts are skipped on BOTH sides. To settle them yourself: -Prefer VPS (live wins) or -Prefer Local (localhost wins)." Yellow }
    if ($Prefer -ne "None") { Say "-Prefer $Prefer : on every conflict the $Prefer value wins; the other value is saved in the undo file." Yellow }

    $CompareBefore = Join-Path $ReportDir "sync-$Stamp-before.md"
    if ($DryRun) {
        $null = & node (Join-Path $Tool "compare-dbs.js") --a $LocalSnap --b $LiveCopy --dl $DL --dv $DV --rl $CL --rv $CV --labelA "Localhost" --labelB "Live site" --title "State BEFORE syncing (dry run)." --out $CompareBefore
        Say ""
        Say "DRY RUN finished. Nothing was changed on either side." Green
        Say "How the two look right now (comparison): $CompareBefore"
        Say "Reports saved in: $Hist"
        return
    }

    if (($ToLive + $ToLocal) -eq 0 -and ($AlLive + $AlLocal) -eq 0) {
        Say "Nothing to sync. Both sides already have each other's changes." Green
    }

    # ---------------- 3. the one question ----------------
    if (-not $Auto -and ($ToLive + $ToLocal + $AlLive + $AlLocal) -gt 0) {
        $Ans = Read-Host "Type  SYNC BOTH  to continue (anything else cancels)"
        if ($Ans -cne "SYNC BOTH") { Say "Cancelled. Nothing was changed." Yellow; return }
    }

    # ---------------- 4. back up BOTH databases ----------------
    Say "5/8  Backing up both databases first..."
    $LocalBackup = Join-Path $Hist "before-sync-local.db"
    Helper "snapshot" @("--src", $LocalDb, "--dest", $LocalBackup) | Out-Null
    ssh @SshOpt $HostVPS "set -e; mkdir -p /root/teamlink-backups; sqlite3 '$RemoteDb' '.backup $RemoteBackup'; test `"`$(sqlite3 '$RemoteBackup' 'PRAGMA integrity_check;')`" = ok; echo BACKUP_OK"
    if ($LASTEXITCODE -ne 0) { Fail "Live backup failed. Nothing was changed." }
    $BaselineBackup = Join-Path $Hist "baseline-before-sync.db"
    Copy-Item $Baseline $BaselineBackup -Force

    # ---------------- 5. apply to the live site ----------------
    $LiveOk = $false; $LocalOk = $false
    $RLres = Join-Path $Hist "result-to-live.json"; $RVres = Join-Path $Hist "result-to-local.json"
    $LocalUndo = Join-Path $Hist "undo-local.json"
    if ($ToLive -gt 0 -or $AlLive -gt 0) {
        Say "6/8  Applying localhost changes to the LIVE site (one all-or-nothing step)..."
        $RemoteCleanup = $true
        ssh @SshOpt $HostVPS "mkdir -p '$RemoteWork' '$RemoteTool'"
        if ($LASTEXITCODE -ne 0) { Fail "Could not prepare the live server folder." }
        scp @SshOpt $DL "${HostVPS}:$RemoteWork/delta.json"
        if ($LASTEXITCODE -ne 0) { Fail "Upload failed. Nothing was changed on the live site." }
        foreach ($f in @("apply-delta.js","engine.js","lib.js","report.js")) {
            scp @SshOpt (Join-Path $Tool $f) "${HostVPS}:$RemoteTool/$f"
            if ($LASTEXITCODE -ne 0) { Fail "Upload of $f failed. Nothing was changed on the live site." }
        }
        $PreferRemote = ""
        if ($Prefer -eq "Local") { $PreferRemote = "--prefer" }
        $ApplyLog = Join-Path $Hist "apply-live-output.txt"
        ssh @SshOpt $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/apply-delta.js --delta '$RemoteWork/delta.json' --apply $PreferRemote --undo-out '$RemoteUndo' --result-out '$RemoteWork/result.json'" | Tee-Object -FilePath $ApplyLog
        $ex = $LASTEXITCODE
        if ($ex -eq 3) { Say "SAFETY STOP on the live site: a broken link was found, NOTHING was changed there." Red; $Code = 1 }
        elseif ($ex -ne 0) { Say "The live apply step failed (exit $ex). Backup on the server: $RemoteBackup" Red; $Code = 1 }
        else {
            $V = ssh @SshOpt $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/apply-delta.js --delta '$RemoteWork/delta.json' $PreferRemote"
            $VL = ($V | Where-Object { $_ -like "DRY_SUMMARY*" } | Select-Object -Last 1)
            $va = [int]([regex]::Match($VL, 'added=(\d+)').Groups[1].Value); $vc = [int]([regex]::Match($VL, 'changed=(\d+)').Groups[1].Value)
            if ($Prefer -ne "Local" -and ($va -ne 0 -or $vc -ne 0)) { Say "Check failed on the live site: $va new / $vc edited rows still pending. Baseline not moved for this side." Red; $Code = 1 }
            else {
                scp @SshOpt "${HostVPS}:$RemoteWork/result.json" $RLres
                if ($LASTEXITCODE -eq 0) { $LiveOk = $true } else { Say "Could not download the live result file; baseline not moved for this side (safe)." Red; $Code = 1 }
            }
        }
    }

    # ---------------- 6. apply to localhost ----------------
    if ($ToLocal -gt 0 -or $AlLocal -gt 0) {
        Say "7/8  Applying live-site changes to LOCALHOST (short transaction; your local server keeps running)..."
        $PreferLocal = @()
        if ($Prefer -eq "VPS") { $PreferLocal = @("--prefer") }
        Push-Location $Backend
        $LogLocal = Join-Path $Hist "apply-local-output.txt"
        & node (Join-Path $Tool "apply-delta.js") --db $LocalDb --really-this-database --delta $DV --apply @PreferLocal --undo-out $LocalUndo --result-out $RVres | Tee-Object -FilePath $LogLocal
        $ex = $LASTEXITCODE
        Pop-Location
        if ($ex -eq 3) { Say "SAFETY STOP on localhost: a broken link was found, NOTHING was changed there." Red; $Code = 1 }
        elseif ($ex -ne 0) { Say "The local apply step failed (exit $ex). Backup: $LocalBackup" Red; $Code = 1 }
        else { $LocalOk = $true }
    }

    # ---------------- 7. move the baseline ----------------
    Say "8/8  Moving the baseline forward by exactly what was applied, then comparing both sides..."
    if ($LiveOk) { NodeRun @((Join-Path $Tool "update-baseline.js"), "--baseline", $Baseline, "--delta", $DL, "--result", $RLres, "--ddl-from", "$LocalSnap,$LiveCopy") | Out-Host }
    if ($LocalOk) { NodeRun @((Join-Path $Tool "update-baseline.js"), "--baseline", $Baseline, "--delta", $DV, "--result", $RVres, "--ddl-from", "$LocalSnap,$LiveCopy") | Out-Host }
    $Rem = if ($LiveOk) { $RemoteUndo } else { "" }
    $LU = if ($LocalOk) { $LocalUndo } else { "" }
    @{ stamp = $Stamp; remoteUndo = $Rem; remoteBackup = $RemoteBackup; localUndo = $LU; baselineBackup = $BaselineBackup; localBackup = $LocalBackup } | ConvertTo-Json | Set-Content $LastFile

    # ---------------- 8. the comparison ----------------
    $LocalAfter = Join-Path $Work "local-after.db"
    $LiveAfter  = Join-Path $Work "live-after.db"
    Helper "snapshot" @("--src", $LocalDb, "--dest", $LocalAfter) | Out-Null
    $RemoteView2 = "/tmp/teamlink-syncview2-$Stamp.db"
    ssh @SshOpt $HostVPS "sqlite3 '$RemoteDb' '.backup $RemoteView2'"
    scp @SshOpt "${HostVPS}:$RemoteView2" $LiveAfter
    ssh @SshOpt $HostVPS "rm -f '$RemoteView2'" | Out-Null
    $CmpFile = Join-Path $ReportDir "sync-$Stamp.md"
    $CmpArgs = @((Join-Path $Tool "compare-dbs.js"), "--a", $LocalAfter, "--b", $LiveAfter, "--dl", $DL, "--dv", $DV, "--labelA", "Localhost", "--labelB", "Live site", "--title", "State AFTER syncing.", "--out", $CmpFile)
    if ($LiveOk) { $CmpArgs += @("--rl", $RLres) } else { $CmpArgs += @("--rl", $CL) }
    if ($LocalOk) { $CmpArgs += @("--rv", $RVres) } else { $CmpArgs += @("--rv", $CV) }
    $CmpOut = & node @CmpArgs
    $CmpExit = $LASTEXITCODE
    $CmpOut | ForEach-Object { Write-Host $_ }
    Copy-Item $CmpFile (Join-Path $Hist "compare.md") -Force -ErrorAction SilentlyContinue

    Say ""
    if ($Code -eq 0 -and $CmpExit -eq 0 -and $Conf -eq 0) { Say "SYNC DONE. Both sides now hold the same data (comparison report below)." Green }
    else { Say "SYNC FINISHED WITH THINGS TO LOOK AT (conflicts: $Conf). Read the comparison report." Yellow }
    Say "Comparison report: $CmpFile"
    if ($LocalOk) { Say "Please REFRESH your browser tabs for localhost (Ctrl+F5) to see the new rows." Cyan }
    Say ""
    Say "TO UNDO THIS SYNC (both databases + baseline):  .\sync-both.ps1 -UndoLast"
    Say "Full backups: localhost $LocalBackup ; live site $RemoteBackup (on the server)"
    if ($Conf -gt 0) { $Code = 2 }
    if ($CmpExit -ne 0) { $Code = 2 }
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $Code = 1
    if ($Auto) { Notify "TeamLink auto sync FAILED" $_.Exception.Message }
}
finally {
    if ($RemoteCleanup) { ssh @SshOpt $HostVPS "rm -rf '$RemoteWork'" | Out-Null }
    if ($LockMine -and (Test-Path $LockFile)) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path $Work) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($Auto -and $Code -eq 2) { Notify "TeamLink auto sync: conflicts need you" "Some changes conflict and were left alone. Read the report in TeamLink-Sync-Reports." }
if ($Auto) { exit $Code }
