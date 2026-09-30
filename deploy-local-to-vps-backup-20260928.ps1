# Usage:
#   .\deploy-local-to-vps.ps1                   code + LOCAL database (replaces the VPS database)
#   .\deploy-local-to-vps.ps1 -KeepVpsDatabase  code only; the VPS keeps its own database
#                                               (biometric punches, device users, anything
#                                               entered on the VPS). Migrations still apply.
param([switch]$KeepVpsDatabase)

$ErrorActionPreference = "Stop"

$LocalRoot = "C:\Users\user\Desktop\All_Projects\teamlink-enterprise"
$VpsHost = "root@72.61.233.104"
$VpsRoot = "/opt/teamlink-enterprise"

$TempRoot = "$env:TEMP\teamlink-deploy"
$Archive = "$env:TEMP\teamlink-deploy.tar.gz"
$Date = Get-Date -Format "yyyy-MM-dd-HHmmss"
$RemoteBackup = "/root/teamlink-backups/$Date-before-local-deploy"

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "      TEAMLINK LOCAL -> VPS DEPLOYMENT"
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "LOCAL CODE     = MASTER" -ForegroundColor Green
if ($KeepVpsDatabase) {
    Write-Host "VPS DATABASE   = KEPT (local database NOT copied)" -ForegroundColor Green
} else {
    Write-Host "LOCAL DATABASE = MASTER (replaces the VPS database)" -ForegroundColor Green
}
Write-Host "VPS .env       = PRESERVED" -ForegroundColor Yellow
Write-Host "VPS DB BACKUP  = CREATED FIRST" -ForegroundColor Yellow
Write-Host "HRMS           = NOT TOUCHED" -ForegroundColor Green
Write-Host ""

Set-Location $LocalRoot

if (!(Test-Path "$LocalRoot\backend")) { throw "Local backend folder not found." }
if (!(Test-Path "$LocalRoot\frontend")) { throw "Local frontend folder not found." }
if (!(Test-Path "$LocalRoot\backend\prisma\dev.db")) { throw "Local database not found." }

Write-Host "[1/10] Preparing local deployment package..." -ForegroundColor Cyan

Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Archive -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

$LocalDb = "$LocalRoot\backend\prisma\dev.db"
$DbInfo = Get-Item $LocalDb

if ($DbInfo.Length -le 0) {
    throw "Local database is empty."
}

Write-Host "LOCAL DATABASE OK - $([math]::Round($DbInfo.Length / 1MB,2)) MB" -ForegroundColor Green

Write-Host "Copying backend..." -ForegroundColor Yellow

robocopy "$LocalRoot\backend" "$TempRoot\backend" /E /XD node_modules backups /XF .env dev.db-wal dev.db-shm integration-sync.json apply-integrations.js verify-vps-integrations.js check-vps-users.js check-vps-users2.js check-superadmin.js check-claude.js check-integrations.js check-employees.js check-vps-employees.js check-vps-codes.js export-vps-employees.js compare-employees.js compare-employee-codes.js compare-local-vps-json.js

if ($LASTEXITCODE -gt 7) {
    throw "Backend copy failed."
}

$PackageDb = "$TempRoot\backend\prisma\dev.db"

if ($KeepVpsDatabase) {
    # robocopy above copied the local dev.db along with the code; take it out
    # so nothing in the package can replace the VPS database.
    Remove-Item $PackageDb -Force -ErrorAction SilentlyContinue
    if (Test-Path $PackageDb) { throw "Could not remove the local database from the package." }
    Write-Host "LOCAL DATABASE LEFT OUT - THE VPS KEEPS ITS OWN" -ForegroundColor Green
} else {
    Write-Host "Copying LOCAL database..." -ForegroundColor Yellow

    Copy-Item -Path $LocalDb -Destination $PackageDb -Force

    if (!(Test-Path $PackageDb)) {
        throw "Local database was not copied."
    }

    if ((Get-Item $PackageDb).Length -ne $DbInfo.Length) {
        throw "Database copy size mismatch."
    }

    Write-Host "LOCAL DATABASE COPIED SUCCESSFULLY" -ForegroundColor Green
}

Write-Host "Copying frontend..." -ForegroundColor Yellow

robocopy "$LocalRoot\frontend" "$TempRoot\frontend" /E /XD node_modules dist

if ($LASTEXITCODE -gt 7) {
    throw "Frontend copy failed."
}

if (!$KeepVpsDatabase) { Write-Host "LOCAL DATABASE INCLUDED IN PACKAGE." -ForegroundColor Green }

Write-Host "[2/10] Creating deployment archive..." -ForegroundColor Cyan

tar -czf $Archive -C $TempRoot .

if (!(Test-Path $Archive)) {
    throw "Archive creation failed."
}

Write-Host "Archive size: $([math]::Round((Get-Item $Archive).Length / 1MB,2)) MB" -ForegroundColor Green

Write-Host "[3/10] Uploading package to VPS..." -ForegroundColor Cyan

scp $Archive "$VpsHost`:/root/teamlink-deploy.tar.gz"

if ($LASTEXITCODE -ne 0) {
    throw "Upload failed."
}

Write-Host "[4/10] BACKING UP VPS DATABASE AND ENV..." -ForegroundColor Cyan

ssh $VpsHost "mkdir -p '$RemoteBackup' && cp '$VpsRoot/backend/prisma/dev.db' '$RemoteBackup/dev.db' && cp '$VpsRoot/backend/.env' '$RemoteBackup/.env' && echo 'VPS BACKUP SUCCESSFUL' && ls -lh '$RemoteBackup'"

if ($LASTEXITCODE -ne 0) {
    throw "VPS backup failed."
}

Write-Host "[5/10] Stopping TeamLink ONLY..." -ForegroundColor Cyan

ssh $VpsHost "pm2 stop teamlink-enterprise"

if ($LASTEXITCODE -ne 0) {
    throw "Could not stop TeamLink."
}

Write-Host "[6/10] Deploying LOCAL CODE + LOCAL DATABASE..." -ForegroundColor Cyan

ssh $VpsHost "rm -rf '/root/teamlink-deploy-new' && mkdir -p '/root/teamlink-deploy-new' && tar -xzf '/root/teamlink-deploy.tar.gz' -C '/root/teamlink-deploy-new' && mv '$VpsRoot/backend' '$VpsRoot/backend-old-$Date' && mv '$VpsRoot/frontend' '$VpsRoot/frontend-old-$Date' && mv '/root/teamlink-deploy-new/backend' '$VpsRoot/backend' && mv '/root/teamlink-deploy-new/frontend' '$VpsRoot/frontend' && cp '$VpsRoot/backend-old-$Date/.env' '$VpsRoot/backend/.env' && rm -f '$VpsRoot/backend/prisma/dev.db-wal' '$VpsRoot/backend/prisma/dev.db-shm' && echo 'LOCAL CODE + LOCAL DATABASE DEPLOYED' && ls -lh '$VpsRoot/backend/prisma/dev.db'"

if ($LASTEXITCODE -ne 0) {
    throw "Code/database deployment failed."
}

if ($KeepVpsDatabase) {
    # Put the VPS's own database back into the new backend folder.
    ssh $VpsHost "cp '$VpsRoot/backend-old-$Date/prisma/dev.db' '$VpsRoot/backend/prisma/dev.db' && echo 'VPS DATABASE KEPT' && ls -lh '$VpsRoot/backend/prisma/dev.db'"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not restore the VPS database. Backup: $RemoteBackup"
    }
    Write-Host "VPS DATABASE KEPT." -ForegroundColor Green
} else {
    Write-Host "LOCAL DATABASE IS NOW ON VPS." -ForegroundColor Green
}
Write-Host "VPS .env WAS PRESERVED." -ForegroundColor Green

Write-Host "[7/10] Installing backend dependencies..." -ForegroundColor Cyan

ssh $VpsHost "cd '$VpsRoot/backend' && npm install"

if ($LASTEXITCODE -ne 0) {
    throw "Backend npm install failed."
}

Write-Host "[8/10] Applying Prisma migrations..." -ForegroundColor Cyan

ssh $VpsHost "cd '$VpsRoot/backend' && npx prisma migrate deploy"

if ($LASTEXITCODE -ne 0) {
    Write-Host "DATABASE MIGRATION FAILED" -ForegroundColor Red
    Write-Host "VPS BACKUP: $RemoteBackup" -ForegroundColor Yellow
    throw "Prisma migration failed."
}

Write-Host "DATABASE MIGRATIONS SUCCESSFUL" -ForegroundColor Green

Write-Host "[9/10] Generating Prisma client and building frontend..." -ForegroundColor Cyan

ssh $VpsHost "cd '$VpsRoot/backend' && npx prisma generate && cd '$VpsRoot/frontend' && npm install && npm run build"

if ($LASTEXITCODE -ne 0) {
    Write-Host "BUILD FAILED" -ForegroundColor Red
    Write-Host "VPS BACKUP: $RemoteBackup" -ForegroundColor Yellow
    throw "VPS build failed."
}

Write-Host "BUILD SUCCESSFUL" -ForegroundColor Green

Write-Host "[10/10] Restarting TeamLink ONLY and verifying..." -ForegroundColor Cyan

ssh $VpsHost "cd '$VpsRoot/backend' && pm2 restart teamlink-enterprise --update-env && sleep 5 && echo '--- TEAMLINK ---' && pm2 status teamlink-enterprise && echo '--- HRMS ---' && pm2 status hrms && echo '--- PORTS ---' && ss -lntp | grep -E ':4000|:4010' && echo '--- DATABASE ---' && ls -lh '$VpsRoot/backend/prisma/dev.db' && echo '--- ENV ---' && ls -lh '$VpsRoot/backend/.env'"

if ($LASTEXITCODE -ne 0) {
    throw "Final verification failed."
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "           DEPLOYMENT SUCCESSFUL"
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "LOCAL CODE     -> VPS : DONE" -ForegroundColor Green
if ($KeepVpsDatabase) {
    Write-Host "VPS DATABASE          : KEPT" -ForegroundColor Green
} else {
    Write-Host "LOCAL DATABASE -> VPS : DONE" -ForegroundColor Green
}
Write-Host "PRISMA MIGRATIONS     : APPLIED" -ForegroundColor Green
Write-Host "VPS .env              : PRESERVED" -ForegroundColor Green
Write-Host "VPS OLD DATABASE      : BACKED UP" -ForegroundColor Green
Write-Host "HRMS                  : NOT TOUCHED" -ForegroundColor Green
Write-Host ""
Write-Host "Backup: $RemoteBackup" -ForegroundColor Yellow
Write-Host ""
