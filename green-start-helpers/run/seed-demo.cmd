@echo off
rem Fills Green Start with its own DEMO data (fake people, fake workspace). Only for a trial; never on a database with real people. Safe to run twice.
cd /d "%~dp0.."
node run\seed-demo.cjs
pause
