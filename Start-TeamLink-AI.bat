@echo off
rem ---------------------------------------------------------------------------
rem Double-click to run TeamLink AND the free AI phone-call voices on this computer.
rem Opens up to five windows; a server that is already running is left alone:
rem   TeamLink backend (4010) . TeamLink frontend (5183)
rem   AI voice - Telugu/Hindi listening (8091) . AI voice - English and language (8093) . AI voice - Hindi speaking (8094)
rem Keep the windows open (minimise them). Close them to stop.
rem The AI voices live in C:\Users\Administrator\voice-ai (models, Python, the shared key).
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
set VOICE=C:\Users\Administrator\voice-ai

netstat -ano | findstr /R /C:":4010 .*LISTENING" >nul || start "TeamLink backend" /D "%~dp0backend" cmd /k npm run dev
netstat -ano | findstr /R /C:":5183 .*LISTENING" >nul || start "TeamLink frontend" /D "%~dp0frontend" cmd /k npm run dev

rem DEFAULT (2026-10-29): the AI listening and the Hindi voice run on the SERVER (fast); this PC reaches them through an
rem encrypted tunnel (127.0.0.1:18091 / 18093 / 18094 in backend\.env). To run every model on this PC instead, create
rem %VOICE%\use-local-voices.txt and point backend\.env AI_VOICE_*_URL back to 8091 / 8093 / 8094.
if not exist "%VOICE%\use-local-voices.txt" (
  netstat -ano | findstr /R /C:"127.0.0.1:18093 .*LISTENING" >nul || start "AI voice - server link" /D "%~dp0deploy\ai-voice" cmd /c ai-voice-server-link.bat
  goto open
)

if not exist "%VOICE%\.voice-key" (
  echo The AI voices are not installed on this computer ^(%VOICE%^). TeamLink still runs.
  goto open
)

netstat -ano | findstr /R /C:":8091 .*LISTENING" >nul || start "AI voice - Telugu/Hindi listening" /D "%VOICE%\vexyl-stt" cmd /k "set /p VEXYL_STT_API_KEY=<..\.voice-key && set VEXYL_STT_HOST=127.0.0.1&& set VEXYL_STT_PORT=8091&& set PORT=8091&& set VEXYL_STT_MODEL=%VOICE:\=/%/models/indic-conformer&& set VEXYL_STT_DEVICE=cpu&& set HF_HUB_OFFLINE=1&& set OMP_NUM_THREADS=4&& set PYTHONUNBUFFERED=1&& set PYTHONIOENCODING=utf-8&& ..\venv-stt\Scripts\python vexyl_stt_server.py"
netstat -ano | findstr /R /C:":8093 .*LISTENING" >nul || start "AI voice - English and language" /D "%VOICE%" cmd /k "set /p WHISPER_API_KEY=<.voice-key && set WHISPER_MODEL=base&& set WHISPER_PORT=8093&& set WHISPER_THREADS=4&& set HF_HOME=%VOICE:\=/%/models/hf&& set PYTHONUNBUFFERED=1&& set PYTHONIOENCODING=utf-8&& venv-whisper\Scripts\python "%~dp0deploy\ai-voice\whisper_server.py""
netstat -ano | findstr /R /C:":8094 .*LISTENING" >nul || start "AI voice - Hindi speaking" /D "%VOICE%\models\kokoro" cmd /k "set /p KOKORO_API_KEY=<..\..\.voice-key && set KOKORO_PORT=8094&& set OMP_NUM_THREADS=2&& set PYTHONUNBUFFERED=1&& set PYTHONIOENCODING=utf-8&& ..\..\venv-kokoro\Scripts\python "%~dp0deploy\ai-voice\kokoro_server.py""

:open
echo.
echo Opening http://localhost:5183 - the first load can take 20-30 seconds; the AI voices need about a minute.
timeout /t 8 /nobreak >nul
start "" http://localhost:5183
