# Removes the TeamLink auto sync scheduled task. Your data and the sync tools are not touched.
param([string]$TaskName = "TeamLink Auto Sync")
$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the scheduled task '$TaskName'. Auto sync is OFF." -ForegroundColor Green
} else {
    Write-Host "There is no scheduled task called '$TaskName'. Nothing to remove." -ForegroundColor Yellow
}
