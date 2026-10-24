@echo off
rem Double-click ONCE to get Redis for Green Start (shows what it will download and waits for your key press).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-redis.ps1" %*
pause
