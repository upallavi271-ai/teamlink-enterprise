# ============================================================
# TEAMLINK - PUSH ONLY MY LOCAL CHANGES TO THE LIVE SITE
#
# The one command to run every day.
#   .\push-changes-to-vps.ps1 -DryRun     read the report only (nothing is uploaded or changed)
#   .\push-changes-to-vps.ps1             report, then type  PUSH CHANGES  to really push
#
# What it does: takes your new and edited rows from localhost and adds them to the live
# database. NOTHING ELSE on the live site changes (no other row, no other table, no file replaced).
# It never stops the live site (pm2) and never stops your local server.
# ============================================================

param(
    # Report only. Never asks, never uploads, never changes the live site.
    [switch]$DryRun,

    # Only for the very first time, when baseline.db does not exist yet: start from the
    # verified copy of the live site that was pulled on 15 Oct 2026 09:39.
    [switch]$InitBaselineFromOriginal,

    # Go on even though the local database has newer database updates than the baseline.
    # (New tables are fine; the values in NEW columns of OLD rows will not be compared.)
    [switch]$AllowNewMigrations
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
$HistoryRoot = "C:\Users\user\.teamlink-backups\push-history"
$Stamp       = Get-Date -Format "yyyyMMdd-HHmmss"
$Work        = Join-Path $env:TEMP "teamlink-push-$Stamp"
$RemoteView  = "/tmp/teamlink-pushview-$Stamp.db"
$RemoteWork  = "/tmp/teamlink-push-$Stamp"
$RemoteBackup = "/root/teamlink-backups/before-push-$Stamp.db"
$RemoteUndo  = "/root/teamlink-backups/push-undo-$Stamp.json"

function Say($t, $c = "White") { Write-Host $t -ForegroundColor $c }
function Fail($t) { throw $t }
function NodeRun {
    param([string[]]$Arguments)
    $out = & node @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "A helper step failed: node $($Arguments -join ' ')" }
    return $out
}

$RemoteCleanup = $false
try {
    Say ""
    Say "=== TeamLink: push ONLY my local changes to the live site ===" Cyan
    if ($DryRun) { Say "(DRY RUN: report only. Nothing will be uploaded or changed on the live site.)" Yellow }

    # ---------------- 0. tools present ----------------
    foreach ($f in @("make-delta.js","classify-delta.js","apply-delta.js","update-baseline.js","engine.js","lib.js","report.js","helper.js","exclusions.json")) {
        if (!(Test-Path (Join-Path $Tool $f))) { Fail "Tool file missing: $Tool\$f" }
    }
    if (!(Test-Path $LocalDb)) { Fail "Local database not found: $LocalDb" }
    if (!(Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found on this computer." }

    # ---------------- 1. baseline ----------------
    if (!(Test-Path $Baseline)) {
        if ($InitBaselineFromOriginal -and (Test-Path $Original)) {
            Say "No baseline yet. Starting it from the verified 15 Oct 09:39 copy of the live site..." Yellow
            New-Item -ItemType Directory -Force $BaseDir | Out-Null
            NodeRun @((Join-Path $Tool "helper.js"), "snapshot", "--src", $Original, "--dest", $Baseline) | Out-Null
            Say "Baseline created: $Baseline" Green
        } else {
            Say ""
            Say "STOP: the baseline file is missing:" Red
            Say "  $Baseline" Red
            Say "The baseline is the copy of the database as it was when localhost and the live site last matched."
            Say "Without it I cannot tell what is NEW on localhost, so I will not guess."
            Say "Fix (pick one):"
            Say "  1) First time only:  .\push-changes-to-vps.ps1 -InitBaselineFromOriginal   (uses the 15 Oct 09:39 pull)"
            Say "  2) If you just made localhost equal to the live site:  .\sync-vps-to-local.ps1  (it saves the baseline for you)"
            return
        }
    }

    # ---------------- 2. working folder + local snapshot ----------------
    New-Item -ItemType Directory -Force $Work | Out-Null
    $LocalSnap = Join-Path $Work "local-snapshot.db"
    $LiveCopy  = Join-Path $Work "live-readonly-copy.db"
    $DeltaFile = Join-Path $Work "delta.json"
    $ReportTxt = Join-Path $Work "report.txt"
    $ClassJson = Join-Path $Work "classified.json"

    Say "1/7  Taking a safe snapshot of localhost (your local server keeps running)..."
    NodeRun @((Join-Path $Tool "helper.js"), "snapshot", "--src", $LocalDb, "--dest", $LocalSnap) | Out-Null

    # baseline must match the database version (schema)
    $SchemaJson = & node (Join-Path $Tool "helper.js") schema --baseline $Baseline --local $LocalSnap
    $SchemaExit = $LASTEXITCODE
    if ($SchemaExit -ne 0) {
        $S = $SchemaJson | ConvertFrom-Json
        if ($S.baseNew.Count -gt 0) {
            Say ""
            Say "STOP: the baseline is NEWER than your local database ($($S.baseNew.Count) database update(s) missing locally)." Red
            Say "Your localhost is behind the live site. Run .\sync-vps-to-local.ps1 only if you have no local work to keep."
            return
        }
        if ($S.localNew.Count -gt 0 -and -not $AllowNewMigrations) {
            Say ""
            Say "STOP: the baseline is OLDER than the database version on localhost." Red
            Say "Localhost has $($S.localNew.Count) database update(s) the baseline does not know:"
            $S.localNew | ForEach-Object { Say "   $_" }
            Say "Why it matters: the values in the NEW columns of OLD rows cannot be compared, so they would not travel."
            Say "What to do: (1) deploy the code with deploy-local-to-vps.ps1 (it updates the live database too),"
            Say "            (2) then run this again with  -AllowNewMigrations  if you accept that."
            return
        }
        Say "Note: localhost has newer database updates than the baseline (allowed by -AllowNewMigrations)." Yellow
    }

    # ---------------- 3. read-only copy of the live database ----------------
    Say "2/7  Making a READ-ONLY copy of the live database (the live site is not stopped or changed)..."
    ssh $HostVPS "set -e; sqlite3 '$RemoteDb' '.backup $RemoteView'; test `"`$(sqlite3 '$RemoteView' 'PRAGMA integrity_check;')`" = ok; echo LIVE_COPY_OK"
    if ($LASTEXITCODE -ne 0) { Fail "Could not copy the live database. Nothing was changed." }
    scp "${HostVPS}:$RemoteView" $LiveCopy
    $dl = $LASTEXITCODE
    ssh $HostVPS "rm -f '$RemoteView'" | Out-Null
    if ($dl -ne 0) { Fail "Download of the live copy failed. Nothing was changed." }
    $Check = (& node (Join-Path $Tool "helper.js") integrity --db $LiveCopy)
    if ($LASTEXITCODE -ne 0 -or "$Check".Trim() -ne "ok") { Fail "The downloaded live copy is damaged. Nothing was changed." }

    # ---------------- 4. delta + report ----------------
    Say "3/7  Finding what is new or edited on localhost since the baseline..."
    NodeRun @((Join-Path $Tool "make-delta.js"), "--baseline", $Baseline, "--local", $LocalSnap, "--out", $DeltaFile) | Out-Null
    Say "4/7  Checking each change against the live database copy..."
    $ReportText = & node (Join-Path $Tool "classify-delta.js") --delta $DeltaFile --target $LiveCopy --report $ReportTxt --json $ClassJson
    if ($LASTEXITCODE -ne 0) { Fail "Could not classify the changes." }
    $ReportText | ForEach-Object { Write-Host $_ }
    $R = Get-Content $ClassJson -Raw | ConvertFrom-Json
    $ToPush = [int]$R.counts.added + [int]$R.counts.changed
    $Already = [int]$R.counts.already
    $Conf = [int]$R.counts.conflicts

    # keep a copy of what we looked at
    $Hist = Join-Path $HistoryRoot $Stamp
    New-Item -ItemType Directory -Force $Hist | Out-Null
    Copy-Item $ReportTxt (Join-Path $Hist "report.txt") -Force
    Copy-Item $DeltaFile (Join-Path $Hist "delta.json") -Force

    if ($DryRun) {
        Say ""
        Say "DRY RUN finished. Nothing was uploaded or changed on the live site." Green
        Say "Report saved: $(Join-Path $Hist 'report.txt')"
        return
    }

    if ($Already -gt 0 -and $ToPush -eq 0) {
        # nothing to send, but some changes are already on the live site: just move the baseline
        Say ""
        Say "Nothing new to send. $Already change(s) are already on the live site; marking them as done in the baseline." Green
        NodeRun @((Join-Path $Tool "helper.js"), "stamp", "--baseline", $Baseline, "--delta", $DeltaFile, "--result", $ClassJson, "--only-already") | Out-Host
        return
    }
    if ($ToPush -eq 0) {
        Say ""
        $NothingMsg = "Nothing to push. The live site already has everything from localhost."
        if ($Conf -gt 0) { $NothingMsg = "Nothing to push except $Conf conflict(s) listed above." }
        Say $NothingMsg Green
        return
    }

    # ---------------- 5. the one question ----------------
    Say ""
    Say "READY: $($R.counts.added) new + $($R.counts.changed) edited row(s) will be added to the LIVE site." Yellow
    Say "Nothing else on the live site will change. Conflicts ($Conf) are skipped. A full backup is made first."
    $Answer = Read-Host "Type  PUSH CHANGES  to continue (anything else cancels)"
    if ($Answer -cne "PUSH CHANGES") { Say "Cancelled. Nothing was uploaded or changed." Yellow; return }

    # ---------------- 6. backup, upload, apply ----------------
    Say "5/7  Backing up the live database first..."
    ssh $HostVPS "set -e; mkdir -p /root/teamlink-backups; sqlite3 '$RemoteDb' '.backup $RemoteBackup'; test `"`$(sqlite3 '$RemoteBackup' 'PRAGMA integrity_check;')`" = ok; echo BACKUP_OK"
    if ($LASTEXITCODE -ne 0) { Fail "Live backup failed. Nothing was pushed." }

    Say "6/7  Uploading the changes and applying them (one all-or-nothing step)..."
    $RemoteCleanup = $true
    ssh $HostVPS "mkdir -p '$RemoteWork' '$RemoteTool'"
    if ($LASTEXITCODE -ne 0) { Fail "Could not prepare the live server folder. Nothing was pushed." }
    scp $DeltaFile "${HostVPS}:$RemoteWork/delta.json"
    if ($LASTEXITCODE -ne 0) { Fail "Upload of the changes failed. Nothing was pushed." }
    foreach ($f in @("apply-delta.js","engine.js","lib.js","report.js")) {
        scp (Join-Path $Tool $f) "${HostVPS}:$RemoteTool/$f"
        if ($LASTEXITCODE -ne 0) { Fail "Upload of $f failed. Nothing was pushed." }
    }
    $ApplyLog = Join-Path $Hist "apply-output.txt"
    ssh $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/apply-delta.js --delta '$RemoteWork/delta.json' --apply --undo-out '$RemoteUndo' --result-out '$RemoteWork/result.json'" | Tee-Object -FilePath $ApplyLog
    $ApplyExit = $LASTEXITCODE
    if ($ApplyExit -eq 3) {
        Say ""
        Say "SAFETY STOP: the live database check found a broken link, so NOTHING was changed on the live site." Red
        Say "Read the SAFETY STOP lines above. The baseline was NOT moved."
        return
    }
    if ($ApplyExit -ne 0) { Fail "The apply step failed (exit $ApplyExit). The live database was changed only if the report above says so; backup: $RemoteBackup" }

    # ---------------- 7. verify, baseline, undo help ----------------
    Say "7/7  Checking the result and moving the baseline forward..."
    $Summary = (Get-Content $ApplyLog | Where-Object { $_ -like "APPLY_SUMMARY*" } | Select-Object -Last 1)
    if (!$Summary) { Fail "No result line from the live server. Baseline not moved. Backup: $RemoteBackup" }
    $Added = [int]([regex]::Match($Summary, 'added=(\d+)').Groups[1].Value)
    $Changed = [int]([regex]::Match($Summary, 'changed=(\d+)').Groups[1].Value)
    if (($Added + $Changed) -ne $ToPush) {
        Say "Note: the live server did $Added new + $Changed edited, the dry run expected $ToPush. Something on the live site changed in between; the report above is the truth." Yellow
    }
    # second look: running it again must find nothing left to add
    $Verify = ssh $HostVPS "cd '$VpsRoot/backend' && node scripts/delta-sync/apply-delta.js --delta '$RemoteWork/delta.json'"
    $VLine = ($Verify | Where-Object { $_ -like "DRY_SUMMARY*" } | Select-Object -Last 1)
    $VAdded = [int]([regex]::Match($VLine, 'added=(\d+)').Groups[1].Value)
    $VChanged = [int]([regex]::Match($VLine, 'changed=(\d+)').Groups[1].Value)
    if ($VAdded -ne 0 -or $VChanged -ne 0) { Fail "Check failed: $VAdded new / $VChanged edited rows still pending on the live site. Baseline NOT moved. Backup: $RemoteBackup" }
    Say "Check passed: nothing is left to add on the live site." Green

    $ResultLocal = Join-Path $Hist "result.json"
    scp "${HostVPS}:$RemoteWork/result.json" $ResultLocal
    if ($LASTEXITCODE -ne 0) { Fail "Could not download the result file. Baseline NOT moved (safe: next run will show those rows as 'already there')." }
    scp "${HostVPS}:$RemoteUndo" (Join-Path $Hist "undo.json") | Out-Null
    NodeRun @((Join-Path $Tool "update-baseline.js"), "--baseline", $Baseline, "--delta", $DeltaFile, "--result", $ResultLocal) | Out-Host

    Say ""
    Say "DONE. $Added new + $Changed edited row(s) are now on the live site." Green
    if ($Conf -gt 0) { Say "$Conf conflict(s) were left alone. They come back in the next report." Yellow }
    Say ""
    Say "TO UNDO THIS PUSH (puts the live rows back exactly as they were):"
    Say "  ssh $HostVPS `"cd $VpsRoot/backend && node scripts/delta-sync/apply-delta.js --revert $RemoteUndo`""
    Say "  (then run  .\sync-vps-to-local.ps1  only if you want localhost and live to match again)"
    Say "Full backup of the live database before this push (last resort):"
    Say "  $RemoteBackup   on the server"
    Say "Saved on this computer: $Hist"
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    if ($RemoteCleanup) { ssh $HostVPS "rm -rf '$RemoteWork'" | Out-Null }
    if (Test-Path $Work) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
