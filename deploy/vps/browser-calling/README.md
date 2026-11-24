# Browser calling - PBX side (applied by hand, with backups; nothing here restarts Asterisk)
1. /etc/asterisk/pjsip_browser.conf, empty /etc/asterisk/pjsip_browser_users.conf, then `#include` both at the END of pjsip.conf.
2. extensions_browser.conf -> `#include extensions_browser.conf` at the end of extensions.conf.
3. manager.conf: add a read-only user [tlevents] (read=call,user, write empty, 127.0.0.1 only); its secret goes to backend .env BROWSER_CALL_AMI_SECRET.
4. nginx: nginx-sip-ws.txt inside the teamlink.teamlinks.in 443 server block.
5. Backend .env: BROWSER_CALL_WSS_URL=wss://teamlink.teamlinks.in/sip-ws, BROWSER_CALL_AMI_USER=tlevents, BROWSER_CALL_AMI_SECRET=...
6. No audio either way (fixed live 23 Nov 2026): the `[webrtc-tpl]` template must carry `media_address=72.61.233.104` and `bind_rtp_to_media_address=yes` (after `dtmf_mode=rfc4733`). The ws transport is bound to 127.0.0.1 behind nginx, and without these lines Asterisk binds the call audio (RTP) to 127.0.0.1 too, so ICE never connects. After changing it: `asterisk -rx "module reload res_pjsip.so"`.
7. Firewall: UDP 10000-10200 open to the world (browser media). Nothing else new is public.

## Phone lines (Synway / Dinstar / ViciDial / other SIP by IP) - 23 Nov 2026
An Admin adds lines in Omni-Channel > AI Voice > Browser calling > Phone lines. The backend (root on the VPS) writes two files and reloads Asterisk itself
(`module reload res_pjsip.so`, `dialplan reload`); the built-in office Synway (`teamlink-gw`) is never written by it.
- `/etc/asterisk/pjsip_tl_lines.conf` (endpoints `tl-line-<id>`)
- `/etc/asterisk/extensions_tl_lines.conf` (context `[tl-line-route]`: `default` = teamlink-gw, plus one extension `l<id>` per line)

Install once, in this order (backups first):
8. Create both files empty and readable by Asterisk:
   `touch /etc/asterisk/pjsip_tl_lines.conf /etc/asterisk/extensions_tl_lines.conf && chgrp asterisk /etc/asterisk/*_tl_lines.conf && chmod 640 /etc/asterisk/*_tl_lines.conf`
9. At the END of pjsip.conf: `#include pjsip_tl_lines.conf`
10. At the END of extensions.conf: `#include extensions_tl_lines.conf`
11. Replace `[browser-out]` in extensions_browser.conf with the copy in this folder (reads the `X-TL-Line` header, keeps only a-z 0-9, uses it only when
    `DIALPLAN_EXISTS(tl-line-route,<line>,1)`, else `default`; the call token check is unchanged; without step 10 it still dials teamlink-gw as before).
12. `asterisk -rx "module reload res_pjsip.so"` and `asterisk -rx "dialplan reload"`. Then in TeamLink save any line once (or switch one off and on) so the
    backend writes the files.
13. A line that uses TCP needs a `[transport-tcp]` (type=transport, protocol=tcp, bind=0.0.0.0:5060) in pjsip.conf; UDP lines use the existing `transport-udp`,
    devices that register to us use `transport-gw` (UDP 5160).
14. Firewall: a device that registers to us comes in on UDP 5160 (already open for the office IP); open it for that device's IP too, and if pjsip.conf has the global `[provider-acl]` (type=acl), add a `permit=<device IP>` line there. A line we send calls to
    by IP needs nothing new inbound (Asterisk starts the call), but the far end must allow 72.61.233.104.
15. Line status (Registered / Reachable / Unreachable, round-trip ms) is read with AMI `PJSIPShowContacts` when the manager user has the `system` right,
    otherwise with `asterisk -rx "pjsip show contacts"` (the backend runs as root). Nothing to install for it.

## Silent call recording, transcript and summary - 23 Nov 2026
The generated `[tl-line-route]` puts `MixMonitor(/var/spool/asterisk/monitor/teamlink/${FILTER(a-z0-9,${TLTOKEN})}.wav,b)` before every Dial while the
Admin switch "Record calls" is on (default on): option `b` = only the answered (bridged) part, both sides mixed, no beep, no announcement to anyone.
Click-to-call on a phone line records the same way from `[tl-c2c-answer]` (Dial option `U(tl-c2c-answer^<token>)`). Switching it off rewrites the file without it.
16. `mkdir -p /var/spool/asterisk/monitor/teamlink && chown asterisk:asterisk /var/spool/asterisk/monitor/teamlink && chmod 750 /var/spool/asterisk/monitor/teamlink`
17. Nothing else on Asterisk: recording needs steps 9-11 (the include and the new `[browser-out]`); without them calls still work, unrecorded.
18. After each hangup the backend (root) reads the WAV, runs ONE `ffmpeg -i <wav> -ac 1 -ar 16000 -c:a libmp3lame -b:a 24k <mp3>` (one call at a time),
    stores the MP3 in `<UPLOAD_DIR>/call-recordings/`, transcribes (AI_VOICE_WHISPER_URL if set, else Groq whisper-large-v3 with the Fast AI Groq key),
    summarises through Fast AI (phone numbers and e-mails masked first) and deletes the WAV. Audio + transcript are deleted after "Keep recordings" days (default 180).

## One SIM number per recruiter (Synway ports) - 25 Nov 2026
An Admin lists the Synway GSM ports in Omni-Channel > AI Voice > Browser calling > SIM numbers (port, SIM number, operator, on/off, given to one person,
dial prefix, incoming matched by SIM number or port tag). The backend writes, next to `extensions_tl_lines.conf`:
- `/etc/asterisk/extensions_tl_sims.conf`: `[tl-from-gateway]` (one extension per SIM number form / tag -> `Goto(tl-sim-ring,p<NN>,1)`; anything else -> `other`)
  and `[tl-sim-ring]` (rings the person's browser extension for 30 s with the same silent MixMonitor, sends AMI `UserEvent(TLInbound, ...)`; only calls from
  the endpoint `teamlink-gw` are rung, calls from any other line hang up as before).
- while "Port prefix routing" is ON, one extension `p<NN>` per port in `[tl-line-route]` (extensions_tl_lines.conf): `Dial(PJSIP/<prefix>${ARG1}@teamlink-gw,45)`,
  used only when `${CHANNEL(endpoint)}` is that person's own extension (anyone else falls back to `default`). OFF (the default) = the file is exactly as before.
`[browser-out]` does not change (it already passes the `X-TL-Line` value the server picks: `p01` for a person on port 1 with routing ON).

Install once (backups first: `cp /etc/asterisk/extensions.conf /root/extensions.conf.bak-$(date +%Y%m%d-%H%M%S)`):
19. `touch /etc/asterisk/extensions_tl_sims.conf && chgrp asterisk /etc/asterisk/extensions_tl_sims.conf && chmod 640 /etc/asterisk/extensions_tl_sims.conf`
20. At the END of extensions.conf (after `#include extensions_tl_lines.conf`): `#include extensions_tl_sims.conf`
21. In extensions.conf replace the whole `[from-provider]` context (today: `exten => _X.,1,Hangup()` and `exten => s,1,Hangup()`) with exactly:
```
[from-provider]
exten => _X.,1,Goto(tl-from-gateway,${EXTEN},1)
exten => _+X.,1,Goto(tl-from-gateway,${EXTEN},1)
exten => _[a-z].,1,Goto(tl-from-gateway,${EXTEN},1)
exten => s,1,Goto(tl-from-gateway,s,1)
```
   The AI phone calls are not affected: they are originated legs handed to Stasis, they never enter `[from-provider]`.
22. `asterisk -rx "dialplan reload"`. Then in TeamLink save any SIM port once (or switch Port prefix routing off and on) so the backend writes the files,
    and check: `asterisk -rx "dialplan show tl-from-gateway"`, `asterisk -rx "dialplan show tl-sim-ring"`.
23. Nothing new in pjsip: the browser extensions already accept calls (webrtc-tpl); the softphone of a person with a SIM now stays registered while TeamLink is open
    (one tab per browser), with a WebSocket keep-alive every 30 s (nginx `proxy_read_timeout 3600s` stays as it is).
24. On the Synway: (a) IP->GSM routing: one rule per port, called-number prefix `<prefix>` (default `01#` ... `16#`) -> that port, strip the prefix before dialling;
    (b) GSM->IP routing: calls from each port go to the SIP trunk (teamlink-gw) with the called number set to that port's SIM number (or the tag, e.g. `port01`).
    Only then switch "Port prefix routing" ON in TeamLink. Use "Check a called number" on the SIM numbers screen to test the matching.
Rollback: put the old `[from-provider]` back (two `Hangup()` lines), remove `#include extensions_tl_sims.conf`, switch Port prefix routing OFF, `dialplan reload`.

Optional backend .env: BROWSER_CALL_SIMS_DIALPLAN_FILE (default: extensions_tl_sims.conf next to BROWSER_CALL_LINES_DIALPLAN_FILE).

Optional backend .env: BROWSER_CALL_REC_DIR (default /var/spool/asterisk/monitor/teamlink), FFMPEG_PATH, BROWSER_CALL_LINES_PJSIP_FILE, BROWSER_CALL_LINES_DIALPLAN_FILE (the two paths above), BROWSER_CALL_PUBLIC_IP (72.61.233.104),
BROWSER_CALL_REGISTER_PORT (5160). Click-to-call on a line from the Call window uses the AI_VOICE_AMI_* manager login (the same as the SIP line).

Rollback: restore the /root/browser-calling-backup-* copies, `module reload res_pjsip.so`, `dialplan reload`, `manager reload`, remove the nginx location.
For the phone lines only: remove the two `#include` lines (or empty the two files), put the old `[browser-out]` back, reload.
