# ============================================================
# TEAMLINK ENTERPRISE - LOCAL TO VPS DEPLOYMENT
# ============================================================

param(
    # SAFE BY DEFAULT (security review, 2026-10-09): the VPS database is ALWAYS KEPT.
    # Only the very first load of a brand-new VPS needs the local database, and that
    # needs the explicit -FirstLoadDatabase switch plus a typed confirmation.
    [switch]$FirstLoadDatabase,

    # Old name of the default behaviour. Still accepted so old habits keep working;
    # it changes nothing now because keeping the VPS database IS the default.
    [switch]$KeepVpsDatabase,

    # Put a previous release back, e.g.  -RollbackTo 2026-10-09-153000
    # (the stamp is the end of the folder name  backend-old-<stamp>  on the VPS).
    [string]$RollbackTo = ""
)

$ErrorActionPreference = "Stop"

if ($FirstLoadDatabase -and $KeepVpsDatabase) {
    throw "Choose one: -FirstLoadDatabase (replace the VPS database with the local one) or the default (keep the VPS database)."
}
# $KeepVps is what the rest of this script reads.
$KeepVps = -not $FirstLoadDatabase

# ------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------

$LocalRoot = "C:\Users\user\Desktop\All_Projects\teamlink-enterprise"
$VpsHost = "root@72.61.233.104"
$VpsRoot = "/opt/teamlink-enterprise"

$TempRoot = "$env:TEMP\teamlink-deploy"
$Archive = "$env:TEMP\teamlink-deploy.tar.gz"

$Date = Get-Date -Format "yyyy-MM-dd-HHmmss"

$RemotePackage = "/root/teamlink-deploy.tar.gz"
$RemoteDeployNew = "$VpsRoot/release-new"   # next to the live folders (same disk): the switch is a rename and the packages can be hard links
$RemoteBackup = "/root/teamlink-backups/$Date-before-local-deploy"

$OldBackend = "$VpsRoot/backend-old-$Date"
$OldFrontend = "$VpsRoot/frontend-old-$Date"

# ------------------------------------------------------------
# ROLLBACK (also used automatically when a deploy step fails)
#
# Every deploy keeps the PREVIOUS release on the VPS next to the new one:
#   /opt/teamlink-enterprise/backend-old-<stamp>   (code + node_modules + the
#   /opt/teamlink-enterprise/frontend-old-<stamp>   database as it was before)
# Rolling back = swap those folders back and restart. The failed release is
# kept as backend-failed-<stamp> / frontend-failed-<stamp> for inspection.
# Anything written to the database AFTER the restart of the failed release is
# not in the old folder - the health check runs seconds after the restart, so
# that is normally nothing.
# ------------------------------------------------------------

function Invoke-VpsRollback {
    param([string]$Stamp)

    $RollbackCmd = "cd '$VpsRoot' && if [ ! -d 'backend-old-$Stamp' ]; then pm2 restart teamlink-enterprise --update-env; echo 'NOTHING HAD BEEN REPLACED YET - TeamLink restarted as it was'; exit 0; fi && pm2 stop teamlink-enterprise; if [ -d backend ]; then mv backend 'backend-failed-$Stamp'; fi && mv 'backend-old-$Stamp' backend && if [ -d 'frontend-old-$Stamp' ]; then if [ -d frontend ]; then mv frontend 'frontend-failed-$Stamp'; fi && mv 'frontend-old-$Stamp' frontend; fi && cd backend && pm2 restart teamlink-enterprise --update-env && pm2 save && echo 'ROLLED BACK TO THE RELEASE OF $Stamp'"

    ssh $VpsHost $RollbackCmd

    return ($LASTEXITCODE -eq 0)
}

if ($RollbackTo -ne "") {
    if ($RollbackTo -notmatch '^\d{4}-\d{2}-\d{2}-\d{6}$') {
        throw "-RollbackTo must look like 2026-10-09-153000 (the end of the backend-old-... folder name on the VPS)."
    }
    Write-Host "Rolling back TeamLink to the release kept as backend-old-$RollbackTo ..." -ForegroundColor Yellow
    if (Invoke-VpsRollback -Stamp $RollbackTo) {
        Write-Host "Rolled back. TeamLink is running the previous release again." -ForegroundColor Green
        exit 0
    }
    throw "Rollback failed. Nothing more was changed - check the VPS by hand."
}

# ------------------------------------------------------------
# START
# ------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "        TEAMLINK LOCAL TO VPS DEPLOYMENT" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "LOCAL CODE = MASTER" -ForegroundColor Green

if ($KeepVps) {
    Write-Host "DATABASE = KEEP VPS DATABASE" -ForegroundColor Green
} else {
    Write-Host "DATABASE = FIRST LOAD: LOCAL DATABASE REPLACES THE VPS DATABASE (confirmation asked)" -ForegroundColor Red
}

Write-Host "VPS ENV = PRESERVED" -ForegroundColor Yellow
Write-Host "VPS DATABASE BACKUP = CREATED" -ForegroundColor Yellow
Write-Host "TEAMLINK PORT = 4010" -ForegroundColor Green
Write-Host "HRMS PORT = 4000 AND WILL NOT BE TOUCHED" -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------
# VALIDATE LOCAL PROJECT
# ------------------------------------------------------------

Write-Host "[1/10] Checking local project..." -ForegroundColor Cyan

if (!(Test-Path $LocalRoot)) {
    throw "Local project not found: $LocalRoot"
}

if (!(Test-Path "$LocalRoot\backend")) {
    throw "Backend folder not found."
}

if (!(Test-Path "$LocalRoot\frontend")) {
    throw "Frontend folder not found."
}

$LocalDb = "$LocalRoot\backend\prisma\dev.db"

if (!(Test-Path $LocalDb)) {
    throw "Local database not found: $LocalDb"
}

$DbInfo = Get-Item $LocalDb

if ($DbInfo.Length -le 0) {
    throw "Local database is empty."
}

Write-Host "Local project OK" -ForegroundColor Green
Write-Host "Local database size: $([math]::Round($DbInfo.Length / 1MB,2)) MB" -ForegroundColor Green

# ------------------------------------------------------------
# FIRST LOAD ONLY: the one way the VPS database gets replaced
# ------------------------------------------------------------

if ($FirstLoadDatabase) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host " FIRST LOAD OF THE DATABASE REQUESTED (-FirstLoadDatabase)" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "This REPLACES the live database on the VPS with your LOCAL database" -ForegroundColor Yellow
    Write-Host "($([math]::Round($DbInfo.Length / 1MB,2)) MB, $LocalDb)." -ForegroundColor Yellow
    Write-Host "Everything entered on the live site since the last load (people, candidates," -ForegroundColor Yellow
    Write-Host "attendance, invoices, signed agreements ...) will be GONE from the live site." -ForegroundColor Yellow
    Write-Host "A backup copy of the VPS database is made first: $RemoteBackup" -ForegroundColor Yellow
    Write-Host "Use this ONLY for the very first load. For every normal deploy, run the" -ForegroundColor Yellow
    Write-Host "script WITHOUT this switch: the live database is then kept." -ForegroundColor Yellow
    Write-Host ""
    ssh $VpsHost "ls -lh '$VpsRoot/backend/prisma/dev.db' 2>/dev/null || echo 'No database on the VPS yet.'"
    Write-Host ""
    $Answer = Read-Host "Type REPLACE VPS DATABASE to continue (anything else stops the deploy)"
    if ($Answer -cne "REPLACE VPS DATABASE") {
        throw "Stopped. The VPS database was not touched."
    }
    Write-Host "Confirmed. The local database will replace the VPS database." -ForegroundColor Red
}

# ------------------------------------------------------------
# PREPARE TEMP PACKAGE
# ------------------------------------------------------------

Write-Host ""
Write-Host "[2/10] Preparing deployment package..." -ForegroundColor Cyan

Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Archive -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

# ------------------------------------------------------------
# FILE-NAME CASE CHECK (2026-10-28: a deploy failed with "Cannot find module './routes/followups'" because the file on this
# PC was named followUps.js. Windows ignores the case, the Linux VPS does not.) Every file git knows under backend / frontend
# must carry git's exact name on disk; a file that differs only in case is renamed to git's name before it is copied.
# ------------------------------------------------------------
$CaseFixed = 0
Push-Location $LocalRoot
try {
    $Tracked = git ls-files backend frontend 2>$null
    foreach ($Rel in $Tracked) {
        $Full = Join-Path $LocalRoot ($Rel -replace '/', '\')
        $Dir = Split-Path -Parent $Full
        $Want = Split-Path -Leaf $Full
        if (-not (Test-Path -LiteralPath $Dir)) { continue }
        $Have = [System.IO.Directory]::GetFiles($Dir) | ForEach-Object { [System.IO.Path]::GetFileName($_) } | Where-Object { $_ -ieq $Want }
        if ($Have -and ($Have -cne $Want)) {
            $Tmp = Join-Path $Dir ($Want + '.case-tmp')
            Move-Item -LiteralPath (Join-Path $Dir $Have) -Destination $Tmp -Force
            Move-Item -LiteralPath $Tmp -Destination $Full -Force
            Write-Host "Renamed $Have -> $Want (the VPS is case-sensitive)" -ForegroundColor Yellow
            $CaseFixed++
        }
    }
} finally { Pop-Location }
if ($CaseFixed) { Write-Host "$CaseFixed file name(s) put back to git's exact case." -ForegroundColor Yellow }

# ------------------------------------------------------------
# COPY BACKEND
# ------------------------------------------------------------

Write-Host "Copying backend..." -ForegroundColor Yellow

robocopy "$LocalRoot\backend" "$TempRoot\backend" /E `
    /XD node_modules backups uploads .git `
    /XF .env `
    ".env.*" `
    "*.bak" `
    "*.bak-*" `
    "*.db.bak*" `
    "*.tmp" `
    "*.log" `
    "*.orig" `
    "sandbox*.db*" `
    "sandbox.db.*" `
    "vps-*" `
    "integration-key*" `
    "integration-sync*" `
    "dev.db-wal" `
    "dev.db-shm" `
    "dev.db-journal" `
    "apply-integrations.js" `
    "verify-vps-*.js" `
    "check-vps-*.js" `
    "export-vps-*.js" `
    "update-vps-*.js" `
    "check-superadmin.js" `
    "check-claude*.js" `
    "check-integrations.*" `
    "check-employees.js" `
    "compare-*.js" `
    "find-missing-employees.js" `
    $(if ($KeepVps) { "dev.db" })

if ($LASTEXITCODE -gt 7) {
    throw "Backend copy failed. Robocopy exit code: $LASTEXITCODE"
}

Write-Host "Backend copied" -ForegroundColor Green

# ------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------

$PackageDb = "$TempRoot\backend\prisma\dev.db"

if ($KeepVps) {

    Write-Host "Removing local database from package..." -ForegroundColor Yellow

    Remove-Item $PackageDb -Force -ErrorAction SilentlyContinue

    if (Test-Path $PackageDb) {
        throw "Could not remove local database from deployment package."
    }

    Write-Host "VPS DATABASE WILL BE KEPT" -ForegroundColor Green

} else {

    Write-Host "Copying local database..." -ForegroundColor Yellow

    $PackageDbDirectory = Split-Path $PackageDb -Parent

    if (!(Test-Path $PackageDbDirectory)) {
        New-Item -ItemType Directory -Path $PackageDbDirectory -Force | Out-Null
    }

    Copy-Item $LocalDb $PackageDb -Force

    if (!(Test-Path $PackageDb)) {
        throw "Database was not copied into package."
    }

    $PackageDbInfo = Get-Item $PackageDb

    if ($PackageDbInfo.Length -ne $DbInfo.Length) {
        throw "Database copy size mismatch."
    }

    Write-Host "Local database copied successfully" -ForegroundColor Green
}

# ------------------------------------------------------------
# COPY FRONTEND
# ------------------------------------------------------------

Write-Host "Copying frontend..." -ForegroundColor Yellow

robocopy "$LocalRoot\frontend" "$TempRoot\frontend" /E /XD node_modules dist

$FrontendCopyCode = $LASTEXITCODE

if ($FrontendCopyCode -gt 7) {
    throw "Frontend copy failed. Robocopy exit code: $FrontendCopyCode"
}

Write-Host "Frontend copied" -ForegroundColor Green

# ------------------------------------------------------------
# COPY THE JOB PORTAL (founder, 2026-10-15)
#
# The Job Portal is a SEPARATE app (job-portal-app: its own engine + its own
# database) that the backend starts as a child process. Earlier deploys sent only
# backend + frontend, so new Job Portal features never reached the VPS.
# Sent: job_portal-main + embed (code only). NEVER sent: var (the portal's live
# database on the VPS), node_modules (installed on the VPS), run (pid/log/heartbeat),
# job_portal-v11 (the staged upgrade), the v10 backup folder.
#
# 2026-10-24: job-portal-appjob_portal-main is now a git SUBMODULE (the Job Portal repo), so a `.git` FILE (a pointer to ...gitmodules)
# sits inside it. It is excluded below (as a file AND as a folder) so it never reaches the VPS. Before packaging, make sure the folder holds the
# commit this repo pins:  git submodule update --init --recursive  (see docs/SUBMODULES.md). Green Start is not sent by this script.
# ------------------------------------------------------------

$LocalPortal = "$LocalRoot\job-portal-app"
$PackagePortal = $false
if (Test-Path "$LocalPortal\job_portal-main\package.json") {
    Write-Host "Copying job portal (code only)..." -ForegroundColor Yellow
    robocopy "$LocalPortal\job_portal-main" "$TempRoot\job-portal-app\job_portal-main" /E `
        /XD node_modules "$LocalPortal\job_portal-main\var" .git `
        /XF "*.log" "*.pid" "*.tmp" ".env" ".env.*" ".git" | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Job portal copy failed. Robocopy exit code: $LASTEXITCODE" }
    robocopy "$LocalPortal\embed" "$TempRoot\job-portal-app\embed" /E /XF "*.log" | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Job portal embed copy failed. Robocopy exit code: $LASTEXITCODE" }
    if (Test-Path "$TempRoot\job-portal-app\job_portal-main\var") { throw "The job portal database folder (var) must never be in the package." }
    $PackagePortal = $true
    Write-Host "Job portal copied" -ForegroundColor Green
} else {
    Write-Host "WARNING: job-portal-app\job_portal-main not found - the Job Portal will NOT be updated on the VPS." -ForegroundColor Yellow
}

# ------------------------------------------------------------
# VERIFY IMPORTANT FRONTEND FILES
# ------------------------------------------------------------

Write-Host "Verifying frontend files..." -ForegroundColor Yellow

$RequiredFrontendFiles = @(
    "src\pages\Invoices.jsx",
    "src\pages\invoices\ClientAccountModal.jsx"
)

foreach ($RequiredFile in $RequiredFrontendFiles) {

    $SourceFile = Join-Path "$LocalRoot\frontend" $RequiredFile
    $PackageFile = Join-Path "$TempRoot\frontend" $RequiredFile

    if (!(Test-Path $SourceFile)) {
        throw "Required local frontend file missing: $SourceFile"
    }

    if (!(Test-Path $PackageFile)) {

        Write-Host "File missing from package. Copying explicitly: $RequiredFile" -ForegroundColor Yellow

        $PackageDirectory = Split-Path $PackageFile -Parent

        if (!(Test-Path $PackageDirectory)) {
            New-Item -ItemType Directory -Path $PackageDirectory -Force | Out-Null
        }

        Copy-Item $SourceFile $PackageFile -Force
    }

    if (!(Test-Path $PackageFile)) {
        throw "Required frontend file missing from deployment package: $RequiredFile"
    }

    $FileInfo = Get-Item $PackageFile

    Write-Host "Verified: $RequiredFile ($($FileInfo.Length) bytes)" -ForegroundColor Green
}

# ------------------------------------------------------------
# CREATE ARCHIVE
# ------------------------------------------------------------

Write-Host ""
Write-Host "[3/10] Creating archive..." -ForegroundColor Cyan

tar -czf $Archive -C $TempRoot .

if (!(Test-Path $Archive)) {
    throw "Archive creation failed."
}

$ArchiveInfo = Get-Item $Archive

Write-Host "Archive created: $([math]::Round($ArchiveInfo.Length / 1MB,2)) MB" -ForegroundColor Green

# ------------------------------------------------------------
# UPLOAD
# ------------------------------------------------------------

Write-Host ""
Write-Host "[4/10] Uploading package to VPS..." -ForegroundColor Cyan

scp $Archive "$VpsHost`:$RemotePackage"

if ($LASTEXITCODE -ne 0) {
    throw "SCP upload failed."
}

Write-Host "Upload successful" -ForegroundColor Green

# ------------------------------------------------------------
# VPS BACKUP
# ------------------------------------------------------------

# ------------------------------------------------------------
# PAUSE THE VPS AUTO-SYNC (2026-10-29: "database is locked" at the migrations).
# The VPS runs its own deploy from GitHub every 2 minutes (deploy/vps/teamlink-sync.sh, teamlink-sync.timer). When it ran at the same
# time as this script, both worked on the same database and folders. So: pause it, wait until a run in progress has finished, and
# resume it at the end (success or rollback). A pause the founder set by hand is left as it is.
# ------------------------------------------------------------
$SyncPauseCmd = @'
S=/opt/teamlink-sync
if [ -d $S ]; then
  if [ -f $S/PAUSE ] && ! grep -q deploy-local-to-vps $S/PAUSE; then echo "VPS auto-sync was already paused by hand (left as it is)"; else echo deploy-local-to-vps > $S/PAUSE; echo "VPS auto-sync paused for this deploy"; fi
  if command -v flock >/dev/null; then
    echo "waiting for an auto-sync run in progress to finish (if any)..."
    flock -w 900 $S/lock true && echo "no auto-sync is running now" || { echo "an auto-sync run is still busy after 15 minutes"; exit 1; }
  fi
fi
exit 0
'@
$SyncResumeCmd = 'S=/opt/teamlink-sync; if [ -f $S/PAUSE ] && grep -q deploy-local-to-vps $S/PAUSE; then rm -f $S/PAUSE && echo VPS auto-sync resumed; fi; exit 0'
Write-Host ""
Write-Host "Pausing the VPS auto-sync while this deploy runs..." -ForegroundColor Cyan
($SyncPauseCmd.Replace("`r", "") + "`n") | ssh $VpsHost 'bash -s'
if ($LASTEXITCODE -ne 0) {
    ssh $VpsHost $SyncResumeCmd
    throw "The VPS auto-sync is busy deploying right now. Nothing was changed. Run this again in a few minutes."
}

Write-Host ""
Write-Host "[5/10] Creating VPS backup..." -ForegroundColor Cyan

ssh $VpsHost "mkdir -p '$RemoteBackup' && cp '$VpsRoot/backend/prisma/dev.db' '$RemoteBackup/dev.db' && for f in dev.db-wal dev.db-shm; do if [ -f '$VpsRoot/backend/prisma/'`$f ]; then cp '$VpsRoot/backend/prisma/'`$f '$RemoteBackup/'`$f; fi; done && cp '$VpsRoot/backend/.env' '$RemoteBackup/.env' && echo 'VPS BACKUP SUCCESSFUL' && ls -lh '$RemoteBackup'"

if ($LASTEXITCODE -ne 0) {
    throw "VPS backup failed. Deployment stopped."
}

# RESUME FILES (resume_): the stored resumes live OUTSIDE the code folder, in
# <UPLOAD_DIR>/resumes (UPLOAD_DIR from the VPS .env, default
# ~/.teamlink-uploads). The CandidateResume rows in dev.db point at them, so
# they are backed up WITH the database, into the same backup folder.
$ResumeBackupCmd = @'
UPL=$(sed -n 's/^UPLOAD_DIR=//p' __VPSROOT__/backend/.env | tail -1 | tr -d '\042\047\r'); UPL=${UPL:-$HOME/.teamlink-uploads}; if [ -d $UPL/resumes ]; then tar -czf __BACKUP__/resumes.tar.gz -C $UPL resumes && echo RESUME FILES BACKED UP: $(find $UPL/resumes -type f | wc -l) files from $UPL/resumes; else echo NO RESUME FOLDER ON THE VPS YET - nothing to back up; fi
'@
$ResumeBackupCmd = $ResumeBackupCmd.Trim().Replace('__VPSROOT__', $VpsRoot).Replace('__BACKUP__', $RemoteBackup)

ssh $VpsHost $ResumeBackupCmd

if ($LASTEXITCODE -ne 0) {
    throw "VPS resume-file backup failed. Deployment stopped."
}

Write-Host "VPS backup successful" -ForegroundColor Green
Write-Host "Backup: $RemoteBackup" -ForegroundColor Yellow

# ------------------------------------------------------------
# 2026-10-30 (founder: "update ledha server restart avuthuntey vallu edit chesindhii antha pothundhii ... motham entire application
# restart avodhuuu"): the new release is made READY next to the live one FIRST - unpacked, its packages, its Prisma client and the
# screens built - while TeamLink keeps running. TeamLink is stopped only for the switch, the migrations and the start (seconds, not
# minutes). A failure while preparing changes nothing live: the site keeps running the previous release.
# After the stop, any failure rolls back to the previous release automatically (see Invoke-VpsRollback above).
# ------------------------------------------------------------
$DeployStep = "preparing the new release (TeamLink still running)"
$Switched = $false
try {

Write-Host ""
Write-Host "[6/10] Preparing the new release next to the live one (TeamLink keeps running)..." -ForegroundColor Cyan
$PrepCmd = @'
set -e
NEW=__NEW__
LIVE=__VPSROOT__
rm -rf $NEW && mkdir -p $NEW && tar -xzf __PKG__ -C $NEW
cd $NEW/backend
# the same packages as live: hard links (instant); the generated Prisma client is removed from the NEW copy first, so "prisma generate"
# writes new files and never into the files the running server uses
if cmp -s $LIVE/backend/package-lock.json package-lock.json && [ -d $LIVE/backend/node_modules ]; then { cp -al $LIVE/backend/node_modules node_modules 2>/dev/null || { rm -rf node_modules; cp -a $LIVE/backend/node_modules node_modules; }; }; rm -rf node_modules/.prisma; echo "backend packages: same as live"; else npm install --no-audit --no-fund; fi
npx prisma generate
cd $NEW/frontend
if cmp -s $LIVE/frontend/package-lock.json package-lock.json && [ -d $LIVE/frontend/node_modules ]; then { cp -al $LIVE/frontend/node_modules node_modules 2>/dev/null || { rm -rf node_modules; cp -a $LIVE/frontend/node_modules node_modules; }; }; rm -rf node_modules/.vite node_modules/.cache; echo "screen packages: same as live"; else npm install --no-audit --no-fund; fi
npm run build
[ -f dist/index.html ] || { echo "the screen build made no dist/index.html"; exit 1; }
echo NEW RELEASE READY
'@
($PrepCmd.Replace("`r", "").Replace('__NEW__', $RemoteDeployNew).Replace('__VPSROOT__', $VpsRoot).Replace('__PKG__', $RemotePackage) + "`n") | ssh $VpsHost 'bash -s'
if ($LASTEXITCODE -ne 0) {
    throw "The new release could not be prepared (see the lines above)."
}
Write-Host "New release ready (packages, Prisma client, screens built) - the live site was not stopped" -ForegroundColor Green

$DeployStep = "stopping TeamLink"
$Switched = $true

# ------------------------------------------------------------
# STOP TEAMLINK ONLY
# ------------------------------------------------------------

Write-Host ""
Write-Host "[7/10] Stopping TeamLink (only for the switch: seconds)..." -ForegroundColor Cyan

ssh $VpsHost "pm2 stop teamlink-enterprise"

if ($LASTEXITCODE -ne 0) {
    throw "Could not stop TeamLink."
}

Write-Host "TeamLink stopped" -ForegroundColor Yellow
Write-Host "HRMS was NOT stopped" -ForegroundColor Green

# ------------------------------------------------------------
# DEPLOY NEW CODE
# ------------------------------------------------------------

Write-Host ""
Write-Host "Switching to the new release..." -ForegroundColor Cyan
$DeployStep = "deploying the new code"

$DeployCommand = "mv '$VpsRoot/backend' '$OldBackend' && mv '$VpsRoot/frontend' '$OldFrontend' && mv '$RemoteDeployNew/backend' '$VpsRoot/backend' && mv '$RemoteDeployNew/frontend' '$VpsRoot/frontend' && cp '$OldBackend/.env' '$VpsRoot/backend/.env' && rm -f '$VpsRoot/backend/prisma/dev.db-wal' '$VpsRoot/backend/prisma/dev.db-shm' && echo 'LOCAL CODE DEPLOYED'"

ssh $VpsHost $DeployCommand

if ($LASTEXITCODE -ne 0) {
    throw "Code deployment failed."
}

Write-Host "New code deployed" -ForegroundColor Green

# ------------------------------------------------------------
# DATABASE SELECTION
# ------------------------------------------------------------

if ($KeepVps) {

    Write-Host "Restoring VPS database..." -ForegroundColor Yellow

    # FIX 2026-10-24 (data loss): the database runs in WAL mode (backend/src/db.js), so the newest committed rows sit in dev.db-wal until
    # SQLite checkpoints them. Copying dev.db alone and deleting the -wal file threw those rows away on every deploy (found when the
    # developer login made minutes before a deploy vanished). TeamLink is stopped at this point (step 6), so the three files are consistent:
    # copy all of them; SQLite replays the WAL when the new code opens the database.
    ssh $VpsHost "rm -f '$VpsRoot/backend/prisma/dev.db-wal' '$VpsRoot/backend/prisma/dev.db-shm' && cp '$OldBackend/prisma/dev.db' '$VpsRoot/backend/prisma/dev.db' && for f in dev.db-wal dev.db-shm; do if [ -f '$OldBackend/prisma/'`$f ]; then cp '$OldBackend/prisma/'`$f '$VpsRoot/backend/prisma/'`$f; fi; done && echo 'VPS DATABASE KEPT (with its WAL)'"

    if ($LASTEXITCODE -ne 0) {
        throw "Could not restore VPS database."
    }

    Write-Host "VPS database kept" -ForegroundColor Green

} else {

    Write-Host "Local database is now on VPS" -ForegroundColor Green

    # RESUME FILES (resume_): the local database's CandidateResume rows point
    # at files in the LOCAL <UPLOAD_DIR>/resumes, so those files go with it.
    # Merged into the VPS folder with --skip-old-files: an existing VPS file is
    # never overwritten (stored names are random, so nothing collides anyway).
    $LocalUploads = if ($env:UPLOAD_DIR) { $env:UPLOAD_DIR } else { Join-Path $env:USERPROFILE ".teamlink-uploads" }
    $LocalResumes = Join-Path $LocalUploads "resumes"
    if (Test-Path $LocalResumes) {
        $ResumeArchive = "$env:TEMP\teamlink-resumes.tar.gz"
        Remove-Item $ResumeArchive -Force -ErrorAction SilentlyContinue
        tar -czf $ResumeArchive -C $LocalUploads resumes
        if ($LASTEXITCODE -ne 0) { throw "Could not pack the local resume files." }
        scp $ResumeArchive "$VpsHost`:/root/teamlink-resumes.tar.gz"
        if ($LASTEXITCODE -ne 0) { throw "Could not upload the resume files." }
        $ResumeRestoreCmd = @'
UPL=$(sed -n 's/^UPLOAD_DIR=//p' __VPSROOT__/backend/.env | tail -1 | tr -d '\042\047\r'); UPL=${UPL:-$HOME/.teamlink-uploads}; mkdir -p $UPL && tar -xzf /root/teamlink-resumes.tar.gz -C $UPL --skip-old-files && chmod 700 $UPL/resumes && rm -f /root/teamlink-resumes.tar.gz && echo RESUME FILES ON VPS: $(find $UPL/resumes -type f | wc -l)
'@
        ssh $VpsHost $ResumeRestoreCmd.Trim().Replace('__VPSROOT__', $VpsRoot)
        if ($LASTEXITCODE -ne 0) { throw "Could not unpack the resume files on the VPS." }
        Remove-Item $ResumeArchive -Force -ErrorAction SilentlyContinue
        Write-Host "Local resume files copied to the VPS" -ForegroundColor Green
    } else {
        Write-Host "No local resume folder - nothing to copy" -ForegroundColor Yellow
    }
}

Write-Host "VPS .env preserved" -ForegroundColor Green

# ------------------------------------------------------------
# JOB PORTAL ON THE VPS
# Code goes into <VpsRoot>/job-portal-app (overwriting files, never deleting the
# portal's own var/ database). A copy of the old portal CODE is kept in the backup
# folder. The backend's .env gets JOB_PORTAL_EMBED=1 and, only when missing, the
# secrets the backend and the portal share (generated here, on the VPS).
# ------------------------------------------------------------

if ($PackagePortal) {
    Write-Host ""
    Write-Host "Updating the Job Portal on the VPS..." -ForegroundColor Cyan
    $DeployStep = "updating the Job Portal"

    $PortalCmd = @'
set -e
R=__VPSROOT__
mkdir -p $R/job-portal-app
if [ -d $R/job-portal-app/job_portal-main ]; then tar -czf __BACKUP__/job-portal-code.tar.gz -C $R/job-portal-app --exclude=node_modules --exclude=var --exclude=run . && echo OLD PORTAL CODE BACKED UP; fi
# 2026-10-30: the same portal code as live = nothing to install while TeamLink is stopped
if [ -d $R/job-portal-app/job_portal-main ] && diff -rq --exclude=node_modules --exclude=var --exclude=run --exclude='*.log' __NEW__/job-portal-app $R/job-portal-app >/dev/null 2>&1; then echo JOB PORTAL CODE UNCHANGED - nothing to install; exit 0; fi
cd __NEW__/job-portal-app && tar cf - . | (cd $R/job-portal-app && tar xf -)
# 2026-10-22: the portal's own runtime (tools/dev-server.mjs: the embedded database @electric-sql/pglite, pg, js-yaml, smtp-server) is listed under
# devDependencies in its package.json, so this root install MUST include them or the portal stops with "Cannot find package '@electric-sql/pglite'".
cd $R/job-portal-app/job_portal-main && npm install --include=dev --no-audit --no-fund
# 2026-10-22: the portal API (express, bcryptjs, ...) has its OWN package.json in api/ and its own node_modules (it is not a workspace of the root).
# Without this the portal host stops with "Cannot find module 'express'" and /jobs does not answer after a deploy.
cd $R/job-portal-app/job_portal-main/api && npm install --omit=dev --no-audit --no-fund
ENVF=$R/backend/.env
grep -q '^JOB_PORTAL_EMBED=' $ENVF || echo 'JOB_PORTAL_EMBED=1' >> $ENVF
grep -q '^JOB_PORTAL_SYNC_TOKEN=' $ENVF || echo "JOB_PORTAL_SYNC_TOKEN=$(openssl rand -hex 24)" >> $ENVF
grep -q '^JOB_PORTAL_PUSH_SECRET=' $ENVF || echo "JOB_PORTAL_PUSH_SECRET=$(openssl rand -hex 24)" >> $ENVF
grep -q '^JOBPORTAL__AUTH_SECRET=' $ENVF || echo "JOBPORTAL__AUTH_SECRET=$(openssl rand -hex 32)" >> $ENVF
echo JOB PORTAL CODE UPDATED
'@
    $PortalCmd = $PortalCmd.Trim().Replace("`r", "").Replace('__VPSROOT__', $VpsRoot).Replace('__BACKUP__', $RemoteBackup).Replace('__NEW__', $RemoteDeployNew)

    ssh $VpsHost $PortalCmd

    if ($LASTEXITCODE -ne 0) {
        throw "Job portal update failed."
    }

    Write-Host "Job Portal code updated (its own database was not touched)" -ForegroundColor Green
}

# (the backend packages were installed while preparing, before the stop)

# ------------------------------------------------------------
# PRISMA MIGRATION
# ------------------------------------------------------------

Write-Host ""
Write-Host "[8/10] Applying Prisma migrations..." -ForegroundColor Cyan
$DeployStep = "applying Prisma migrations"

# "database is locked" (2026-10-29): something else still had the database open. Try again for 2 minutes, and show who has it open.
$MigrateCmd = @'
cd '__BACKEND__' || exit 1
for i in 1 2 3 4 5 6; do
  out=$(npx prisma migrate deploy 2>&1); rc=$?
  echo "$out"
  [ $rc -eq 0 ] && exit 0
  echo "$out" | grep -q 'database is locked' || exit $rc
  echo "--- the database is locked; what has it open right now:"
  (command -v fuser >/dev/null && fuser -v prisma/dev.db prisma/dev.db-wal 2>&1) || true
  ps -eo pid,etime,args | grep -E 'node|prisma|sqlite' | grep -v grep | cut -c1-160 | head -15
  echo "--- waiting 20 s, then trying again ($i of 6)"
  sleep 20
done
exit 1
'@
($MigrateCmd.Replace("`r", "").Replace('__BACKEND__', "$VpsRoot/backend") + "`n") | ssh $VpsHost 'bash -s'

if ($LASTEXITCODE -ne 0) {
    throw "Prisma migration failed."
}

Write-Host "DATABASE MIGRATIONS SUCCESSFUL" -ForegroundColor Green

# (the Prisma client and the screens were built while preparing, before the stop)

# ------------------------------------------------------------
# RESTART TEAMLINK
# ------------------------------------------------------------

Write-Host ""
Write-Host "[9/10] Starting TeamLink on the new release..." -ForegroundColor Cyan
$DeployStep = "restarting TeamLink"

ssh $VpsHost "cd '$VpsRoot/backend' && pm2 restart teamlink-enterprise --update-env && pm2 save"

if ($LASTEXITCODE -ne 0) {
    throw "TeamLink restart failed."
}

Start-Sleep -Seconds 5

# ------------------------------------------------------------
# HEALTH CHECK AFTER THE RESTART (automatic rollback if it fails)
# ------------------------------------------------------------

$DeployStep = "health check"
Write-Host ""
Write-Host "Health check (up to 60 seconds)..." -ForegroundColor Cyan

$HealthCmd = "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do if curl -s -m 4 http://127.0.0.1:4010/api/health | grep -q 'ok.*true'; then echo HEALTH OK; exit 0; fi; sleep 5; done; echo HEALTH FAILED; pm2 logs teamlink-enterprise --lines 25 --nostream; exit 1"

ssh $VpsHost $HealthCmd

if ($LASTEXITCODE -ne 0) {
    throw "TeamLink did not answer its health check after the restart."
}

Write-Host "TeamLink answers its health check" -ForegroundColor Green

# The Job Portal (own engine, own port): warning only, so a slow portal start never rolls back the main app.
if ($PackagePortal) {
    $PortalHealth = "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do if curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:4010/jobs/ | grep -q '^200'; then echo JOB PORTAL OK; exit 0; fi; sleep 5; done; echo JOB PORTAL NOT ANSWERING; tail -n 25 '$VpsRoot/job-portal-app/run/portal.log' 2>/dev/null; exit 1"
    ssh $VpsHost $PortalHealth
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Job Portal answers at /jobs" -ForegroundColor Green
    } else {
        Write-Host "WARNING: the Job Portal did not answer at /jobs within 60 seconds. TeamLink itself is fine. See the log lines above (job-portal-app/run/portal.log on the VPS)." -ForegroundColor Yellow
    }
}

# The same check through the public address (warning only: DNS / nginx are not this script's to fix).
try {
    $Public = Invoke-WebRequest -Uri "https://teamlink.teamlinks.in/api/health" -UseBasicParsing -TimeoutSec 20
    if ($Public.StatusCode -eq 200) {
        Write-Host "Public address https://teamlink.teamlinks.in answers too" -ForegroundColor Green
    } else {
        Write-Host "WARNING: the public address answered $($Public.StatusCode). Check nginx." -ForegroundColor Yellow
    }
} catch {
    Write-Host "WARNING: could not reach https://teamlink.teamlinks.in/api/health from here ($($_.Exception.Message)). Check nginx / DNS." -ForegroundColor Yellow
}


# ------------------------------------------------------------
# FINAL VERIFICATION
# ------------------------------------------------------------

Write-Host ""
Write-Host "Checking TeamLink and HRMS..." -ForegroundColor Cyan

ssh $VpsHost "echo '--- TEAMLINK ---' && pm2 status teamlink-enterprise && echo '--- HRMS ---' && pm2 status hrms && echo '--- PORTS ---' && ss -lntp | grep -E ':4000|:4010' && echo '--- DATABASE ---' && ls -lh '$VpsRoot/backend/prisma/dev.db' && echo '--- ENV ---' && ls -lh '$VpsRoot/backend/.env'"

if ($LASTEXITCODE -ne 0) {
    throw "Final VPS verification failed."
}

# ------------------------------------------------------------
} catch {
    $Failure = $_.Exception.Message
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "DEPLOY FAILED while: $DeployStep" -ForegroundColor Red
    Write-Host $Failure -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    if (-not $Switched) {
        # failed while preparing: nothing live was touched, TeamLink was never stopped
        ssh $VpsHost "rm -rf '$RemoteDeployNew'"
        Write-Host "Nothing was switched: the live site kept running the previous version (it was never stopped)." -ForegroundColor Green
        ssh $VpsHost $SyncResumeCmd
        throw "Deploy failed ($DeployStep): $Failure"
    }
    Write-Host "Putting the PREVIOUS version back..." -ForegroundColor Yellow

    $RolledBack = $false
    try { $RolledBack = Invoke-VpsRollback -Stamp $Date } catch { $RolledBack = $false }

    if ($RolledBack) {
        Write-Host "ROLLED BACK. The live site is running the previous version again." -ForegroundColor Green
        Write-Host "The failed release is kept on the VPS as backend-failed-$Date for inspection." -ForegroundColor Yellow
    } else {
        Write-Host "AUTOMATIC ROLLBACK DID NOT COMPLETE - fix by hand:" -ForegroundColor Red
        Write-Host "  .\deploy-local-to-vps.ps1 -RollbackTo $Date" -ForegroundColor Red
    }
    Write-Host "Database backup taken before this deploy: $RemoteBackup" -ForegroundColor Yellow
    ssh $VpsHost $SyncResumeCmd
    throw "Deploy failed ($DeployStep): $Failure"
}
ssh $VpsHost "rm -rf '$RemoteDeployNew'"
# The VPS auto-sync gets this repo's deploy script too (2026-10-30: it builds the next release next to the live one and stops TeamLink
# only for seconds; a change of the screens alone never stops it). Only when the auto-sync is installed; LF line endings for bash.
$SyncScript = Join-Path $LocalRoot "deploy/vps/teamlink-sync.sh"
if (Test-Path $SyncScript) {
    $SyncTmp = Join-Path $env:TEMP "teamlink-sync.sh"
    [System.IO.File]::WriteAllText($SyncTmp, ((Get-Content -Raw $SyncScript) -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
    scp $SyncTmp "${VpsHost}:/root/teamlink-sync.sh.new" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        ssh $VpsHost "if [ -d /opt/teamlink-sync ] && bash -n /root/teamlink-sync.sh.new; then install -m 755 /root/teamlink-sync.sh.new /opt/teamlink-sync/teamlink-sync.sh && echo 'VPS auto-sync script updated'; fi; rm -f /root/teamlink-sync.sh.new"
    }
    Remove-Item $SyncTmp -Force -ErrorAction SilentlyContinue
}
ssh $VpsHost $SyncResumeCmd

# ------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "              DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

Write-Host "Local code -> VPS          : DONE" -ForegroundColor Green

if ($KeepVps) {
    Write-Host "VPS database              : KEPT" -ForegroundColor Green
} else {
    Write-Host "Local database -> VPS     : DONE" -ForegroundColor Green
}

Write-Host "Prisma migrations         : DONE" -ForegroundColor Green
Write-Host "Prisma client             : DONE" -ForegroundColor Green
Write-Host "Frontend build            : DONE" -ForegroundColor Green
Write-Host "TeamLink PM2              : RESTARTED" -ForegroundColor Green
Write-Host "PM2 save                  : DONE" -ForegroundColor Green
Write-Host "VPS .env                  : PRESERVED" -ForegroundColor Green
Write-Host "VPS backup                : $RemoteBackup" -ForegroundColor Yellow
if ($PackagePortal) { Write-Host "Job Portal                : CODE UPDATED (its own database untouched)" -ForegroundColor Green }
Write-Host "HRMS                      : NOT TOUCHED" -ForegroundColor Green
Write-Host "Previous version kept at  : $OldBackend  (and $OldFrontend)" -ForegroundColor Yellow
Write-Host "To go back to it          : .\deploy-local-to-vps.ps1 -RollbackTo $Date" -ForegroundColor Yellow
Write-Host "Reminder (VPS .env)       : add CORS_ORIGINS / TRUST_PROXY=loopback on the VPS .env if not there yet (the script keeps the VPS .env as it is)" -ForegroundColor Yellow

Write-Host ""
Write-Host "TeamLink: https://teamlink.teamlinks.in" -ForegroundColor Cyan
Write-Host ""