# ============================================================
# TEAMLINK - INSTALL AUTO SYNC (Windows Scheduled Task)
#
#   .\Install-AutoSync.ps1                 every night at 02:00
#   .\Install-AutoSync.ps1 -Time 23:30     every night at another time
#   .\Install-AutoSync.ps1 -Hourly         every hour
#   Remove it again with  .\Uninstall-AutoSync.ps1
#
# The task runs   sync-both.ps1 -Auto   as YOU (while you are logged in). Auto mode applies ONLY changes that
# do not conflict, never prefers a side, and shows a Windows notification on any conflict or error.
# It needs passwordless ssh to the live server (steps are in TeamLink-Sync-Guide.md).
# The PC must be switched on (and you logged in) at the scheduled time.
# ============================================================
param(
    [string]$Time = "02:00",
    [switch]$Hourly,
    [string]$TaskName = "TeamLink Auto Sync"
)
$ErrorActionPreference = "Stop"
$Script = Join-Path $PSScriptRoot "sync-both.ps1"
if (!(Test-Path $Script)) { throw "sync-both.ps1 not found next to this script." }
$HostVPS = "root@72.61.233.104"

Write-Host "Checking that ssh works WITHOUT a password..."
$t = ssh -o BatchMode=yes -o ConnectTimeout=20 $HostVPS "echo ok"
if ($LASTEXITCODE -ne 0 -or "$t".Trim() -ne "ok") {
    Write-Host "ssh still asks for a password (or cannot connect)." -ForegroundColor Red
    Write-Host "Do the one-time ssh key steps in TeamLink-Sync-Guide.md first, then run this again." -ForegroundColor Red
    exit 1
}
Write-Host "ssh works without a password." -ForegroundColor Green

$Arg = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Auto"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arg -WorkingDirectory $PSScriptRoot
if ($Hourly) {
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours((Get-Date).Hour + 1) -RepetitionInterval (New-TimeSpan -Hours 1)
    $When = "every hour"
} else {
    $Trigger = New-ScheduledTaskTrigger -Daily -At $Time
    $When = "every day at $Time"
}
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Me = "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "TeamLink: sync localhost and the live site (non-conflicting changes only)" -Force | Out-Null

Write-Host ""
Write-Host "Installed: '$TaskName' runs $When as $Me." -ForegroundColor Green
Write-Host "Reports go to C:\Users\user\Desktop\All_Projects\TeamLink-Sync-Reports"
Write-Host "Test it now:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remember: the PC must be ON and you logged in at that time. Run by hand for a week first."
