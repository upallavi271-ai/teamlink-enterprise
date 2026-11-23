# Browser calling - PBX side (applied by hand, with backups; nothing here restarts Asterisk)
1. /etc/asterisk/pjsip_browser.conf, empty /etc/asterisk/pjsip_browser_users.conf, then `#include` both at the END of pjsip.conf.
2. extensions_browser.conf -> `#include extensions_browser.conf` at the end of extensions.conf.
3. manager.conf: add a read-only user [tlevents] (read=call,user, write empty, 127.0.0.1 only); its secret goes to backend .env BROWSER_CALL_AMI_SECRET.
4. nginx: nginx-sip-ws.txt inside the teamlink.teamlinks.in 443 server block.
5. Backend .env: BROWSER_CALL_WSS_URL=wss://teamlink.teamlinks.in/sip-ws, BROWSER_CALL_AMI_USER=tlevents, BROWSER_CALL_AMI_SECRET=...
6. No audio either way (fixed live 23 Nov 2026): the `[webrtc-tpl]` template must carry `media_address=72.61.233.104` and `bind_rtp_to_media_address=yes` (after `dtmf_mode=rfc4733`). The ws transport is bound to 127.0.0.1 behind nginx, and without these lines Asterisk binds the call audio (RTP) to 127.0.0.1 too, so ICE never connects. After changing it: `asterisk -rx "module reload res_pjsip.so"`.
7. Firewall: UDP 10000-10200 open to the world (browser media). Nothing else new is public.
Rollback: restore the /root/browser-calling-backup-* copies, `module reload res_pjsip.so`, `dialplan reload`, `manager reload`, remove the nginx location.
