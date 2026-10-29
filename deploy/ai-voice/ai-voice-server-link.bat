@echo off
rem ---------------------------------------------------------------------------
rem THE LINK TO THE SERVER'S AI VOICES (2026-10-29: the laptop was too slow to listen; the server hears an answer in ~1 s).
rem An encrypted SSH tunnel: this PC's 127.0.0.1:18091 / 18093 / 18094 reach the server's Telugu-Hindi listening (8091),
rem English + language (8093) and Hindi voice (8094), which listen on the server's 127.0.0.1 only. Reconnects by itself.
rem Keep this window open while AI calls are made from this PC.
rem ---------------------------------------------------------------------------
title AI voice - server link
:loop
echo %date% %time%  connecting to the server's AI voices...
ssh -N -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L 18091:127.0.0.1:8091 -L 18093:127.0.0.1:8093 -L 18094:127.0.0.1:8094 root@72.61.233.104
echo %date% %time%  the link dropped - trying again in 5 seconds
timeout /t 5 /nobreak >nul
goto loop
