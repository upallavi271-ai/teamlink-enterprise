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
$RemoteDeployNew = "/root/teamlink-deploy-new"
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

Write-Host ""
Write-Host "[5/10] Creating VPS backup..." -ForegroundColor Cyan

ssh $VpsHost "mkdir -p '$RemoteBackup' && cp '$VpsRoot/backend/prisma/dev.db' '$RemoteBackup/dev.db' && cp '$VpsRoot/backend/.env' '$RemoteBackup/.env' && echo 'VPS BACKUP SUCCESSFUL' && ls -lh '$RemoteBackup'"

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
# From here on the live site is DOWN until it is restarted, so any failure rolls
# back to the previous release automatically (see Invoke-VpsRollback above).
# ------------------------------------------------------------
$DeployStep = "stopping TeamLink"
try {

# ------------------------------------------------------------
# STOP TEAMLINK ONLY
# ------------------------------------------------------------

Write-Host ""
Write-Host "[6/10] Stopping TeamLink..." -ForegroundColor Cyan

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
Write-Host "[7/10] Deploying new code..." -ForegroundColor Cyan
$DeployStep = "deploying the new code"

$DeployCommand = "rm -rf '$RemoteDeployNew' && mkdir -p '$RemoteDeployNew' && tar -xzf '$RemotePackage' -C '$RemoteDeployNew' && mv '$VpsRoot/backend' '$OldBackend' && mv '$VpsRoot/frontend' '$OldFrontend' && mv '$RemoteDeployNew/backend' '$VpsRoot/backend' && mv '$RemoteDeployNew/frontend' '$VpsRoot/frontend' && cp '$OldBackend/.env' '$VpsRoot/backend/.env' && rm -f '$VpsRoot/backend/prisma/dev.db-wal' '$VpsRoot/backend/prisma/dev.db-shm' && echo 'LOCAL CODE DEPLOYED'"

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

    ssh $VpsHost "cp '$OldBackend/prisma/dev.db' '$VpsRoot/backend/prisma/dev.db' && rm -f '$VpsRoot/backend/prisma/dev.db-wal' '$VpsRoot/backend/prisma/dev.db-shm' && echo 'VPS DATABASE KEPT'"

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
# INSTALL BACKEND
# ------------------------------------------------------------

Write-Host ""
Write-Host "[8/10] Installing backend dependencies..." -ForegroundColor Cyan
$DeployStep = "installing backend dependencies"

ssh $VpsHost "cd '$VpsRoot/backend' && npm install"

if ($LASTEXITCODE -ne 0) {
    throw "Backend npm install failed."
}

Write-Host "Backend dependencies installed" -ForegroundColor Green

# ------------------------------------------------------------
# PRISMA MIGRATION
# ------------------------------------------------------------

Write-Host ""
Write-Host "[9/10] Applying Prisma migrations..." -ForegroundColor Cyan
$DeployStep = "applying Prisma migrations"

ssh $VpsHost "cd '$VpsRoot/backend' && npx prisma migrate deploy"

if ($LASTEXITCODE -ne 0) {
    throw "Prisma migration failed."
}

Write-Host "DATABASE MIGRATIONS SUCCESSFUL" -ForegroundColor Green

# ------------------------------------------------------------
# PRISMA GENERATE + FRONTEND BUILD
# ------------------------------------------------------------

Write-Host ""
Write-Host "Generating Prisma client..." -ForegroundColor Yellow

ssh $VpsHost "cd '$VpsRoot/backend' && npx prisma generate"

if ($LASTEXITCODE -ne 0) {
    throw "Prisma generate failed."
}

Write-Host "Prisma client generated" -ForegroundColor Green

Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow

ssh $VpsHost "cd '$VpsRoot/frontend' && npm install"

if ($LASTEXITCODE -ne 0) {
    throw "Frontend npm install failed."
}

Write-Host "Frontend dependencies installed" -ForegroundColor Green

Write-Host "Building frontend..." -ForegroundColor Yellow
$DeployStep = "building the frontend"

ssh $VpsHost "cd '$VpsRoot/frontend' && npm run build"

if ($LASTEXITCODE -ne 0) {

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "FRONTEND BUILD FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host ""

    Write-Host "VPS BACKUP: $RemoteBackup" -ForegroundColor Yellow
    Write-Host "The previous version will be put back automatically." -ForegroundColor Yellow

    throw "Frontend build failed."
}

Write-Host "FRONTEND BUILD SUCCESSFUL" -ForegroundColor Green

# ------------------------------------------------------------
# RESTART TEAMLINK
# ------------------------------------------------------------

Write-Host ""
Write-Host "[10/10] Restarting TeamLink..." -ForegroundColor Cyan
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
    throw "Deploy failed ($DeployStep): $Failure"
}

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
Write-Host "HRMS                      : NOT TOUCHED" -ForegroundColor Green
Write-Host "Previous version kept at  : $OldBackend  (and $OldFrontend)" -ForegroundColor Yellow
Write-Host "To go back to it          : .\deploy-local-to-vps.ps1 -RollbackTo $Date" -ForegroundColor Yellow
Write-Host "Reminder (VPS .env)       : add CORS_ORIGINS / TRUST_PROXY=loopback on the VPS .env if not there yet (the script keeps the VPS .env as it is)" -ForegroundColor Yellow

Write-Host ""
Write-Host "TeamLink: https://teamlink.teamlinks.in" -ForegroundColor Cyan
Write-Host ""