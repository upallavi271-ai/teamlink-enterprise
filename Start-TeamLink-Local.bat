@echo off
rem ---------------------------------------------------------------------------
rem Double-click to run TeamLink on this computer (localhost).
rem Opens two windows - "TeamLink backend" (port 4010) and "TeamLink frontend"
rem (port 5183) - then opens http://localhost:5183 in the browser.
rem A server that is already running is left alone (no second copy).
rem Close those two windows to stop TeamLink.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

netstat -ano | findstr /R /C:":4010 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting the backend...
  start "TeamLink backend" /D "%~dp0backend" cmd /k npm run dev
) else (
  echo The backend is already running.
)

netstat -ano | findstr /R /C:":5183 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting the frontend...
  start "TeamLink frontend" /D "%~dp0frontend" cmd /k npm run dev
) else (
  echo The frontend is already running.
)

echo.
echo Opening http://localhost:5183 - the first load can take 20-30 seconds.
timeout /t 8 /nobreak >nul
start "" http://localhost:5183
timeout /t 3 /nobreak >nul
