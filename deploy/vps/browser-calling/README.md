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

Optional backend .env: BROWSER_CALL_LINES_PJSIP_FILE, BROWSER_CALL_LINES_DIALPLAN_FILE (the two paths above), BROWSER_CALL_PUBLIC_IP (72.61.233.104),
BROWSER_CALL_REGISTER_PORT (5160). Click-to-call on a line from the Call window uses the AI_VOICE_AMI_* manager login (the same as the SIP line).

Rollback: restore the /root/browser-calling-backup-* copies, `module reload res_pjsip.so`, `dialplan reload`, `manager reload`, remove the nginx location.
For the phone lines only: remove the two `#include` lines (or empty the two files), put the old `[browser-out]` back, reload.
