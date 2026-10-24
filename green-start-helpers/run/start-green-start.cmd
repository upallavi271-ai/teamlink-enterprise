@echo off
rem Double-click to start Green Start (database, server, entrance). Close nothing; the small windows are the program.
powershell -ExecutionPolicy Bypass -File "%~dp0start-green-start.ps1" %*
pause
