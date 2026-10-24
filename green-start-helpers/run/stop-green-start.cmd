@echo off
rem Double-click to stop Green Start. TeamLink is not touched.
powershell -ExecutionPolicy Bypass -File "%~dp0stop-green-start.ps1"
pause
