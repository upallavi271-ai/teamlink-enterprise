# Stops the parts start-green-start.ps1 started (by the process ids it recorded in pids.json), then the database cleanly.
# TeamLink itself (4010 / 5183) and the Job Portal are never touched.
$Run = $PSScriptRoot
$PidFile = Join-Path $Run 'pids.json'
if (Test-Path $PidFile) {
  $o = Get-Content $PidFile -Raw | ConvertFrom-Json
  foreach ($prop in $o.PSObject.Properties) {
    if ($prop.Name -eq 'DATABASE') { continue }
    if (Get-Process -Id $prop.Value -ErrorAction SilentlyContinue) { & taskkill /PID $prop.Value /T /F | Out-Null; Write-Host "Stopped $($prop.Name)" }
  }
}
# database: ask Postgres to stop itself (keeps the data safe), then close its window
$ctl = Get-ChildItem (Join-Path $Run 'pg-tool\node_modules\@embedded-postgres') -Recurse -Filter pg_ctl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ctl -and (Test-Path (Join-Path $Run 'pgdata\postmaster.pid'))) { & $ctl.FullName stop -D (Join-Path $Run 'pgdata') -m fast | Out-Null; Write-Host 'Stopped DATABASE' }
if (Test-Path $PidFile) { $o = Get-Content $PidFile -Raw | ConvertFrom-Json; if ($o.DATABASE -and (Get-Process -Id $o.DATABASE -ErrorAction SilentlyContinue)) { & taskkill /PID $o.DATABASE /T /F | Out-Null } ; Remove-Item $PidFile }
Write-Host 'Green Start is stopped.'
