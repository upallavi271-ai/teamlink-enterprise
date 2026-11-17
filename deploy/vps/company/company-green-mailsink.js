#!/usr/bin/env node
// ============================================================================
// E-MAIL SINK for a company's own Green Start (docs/second-company.md section 12).      node company-green-mailsink.js [port]   (default 2525)
//
// Green Start refuses to start as a real server without a mailbox (SMTP) setting, because it e-mails sign-up codes, password resets and invitations. Until a
// company has a mailbox of its own, this stands in for it: a tiny SMTP server that listens on THIS computer only (127.0.0.1), accepts every message and THROWS IT AWAY.
//   * Nothing leaves the server. Nothing is stored. The log says only that a message was dropped and how big it was: never an address, a subject or a word of the text.
//   * One-click sign-in from the company's app does not use e-mail, so it works. Green Start's OWN sign-up codes, password resets and invitations silently go nowhere,
//     which also means strangers cannot complete a sign-up.
// Replace it with a real mailbox any time: company-green-smtp.sh (it stops this and switches Green Start to the real one).
// No dependencies; plain Node.
// ============================================================================
'use strict';
const net = require('net');

const PORT = Number(process.argv[2] || process.env.SINK_PORT || 2525);
const HOST = '127.0.0.1';
const MAX_BYTES = 26214400;          // the size it announces (25 MB); a bigger message ends the connection
const IDLE_MS = 60000;
let dropped = 0;

function handle(sock) {
  sock.setEncoding('latin1');
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  let buf = '';
  let mode = 'cmd';                  // cmd | data | auth-user | auth-pass | auth-plain
  let size = 0;
  let tail = '';
  const say = (s) => { if (!sock.destroyed) sock.write(`${s}\r\n`); };
  const ok = (s = '250 OK') => say(s);

  function command(line) {
    if (mode === 'auth-plain') { mode = 'cmd'; return say('235 2.7.0 Authentication successful'); }
    if (mode === 'auth-user') { mode = 'auth-pass'; return say('334 UGFzc3dvcmQ6'); }
    if (mode === 'auth-pass') { mode = 'cmd'; return say('235 2.7.0 Authentication successful'); }
    const verb = line.trim().split(/\s+/)[0].toUpperCase();
    switch (verb) {
      case 'EHLO': say('250-sink'); say('250-SIZE 26214400'); say('250-8BITMIME'); return say('250 AUTH PLAIN LOGIN');
      case 'HELO': return say('250 sink');
      case 'AUTH': {
        const parts = line.trim().split(/\s+/);
        if ((parts[1] || '').toUpperCase() === 'PLAIN') { if (parts[2]) return say('235 2.7.0 Authentication successful'); mode = 'auth-plain'; return say('334 '); }
        if ((parts[1] || '').toUpperCase() === 'LOGIN') { if (parts[2]) { mode = 'auth-pass'; return say('334 UGFzc3dvcmQ6'); } mode = 'auth-user'; return say('334 VXNlcm5hbWU6'); }
        return say('504 5.5.4 mechanism not supported');
      }
      case 'MAIL': case 'RCPT': case 'RSET': case 'NOOP': return ok();
      case 'VRFY': return say('252 2.5.2 cannot verify');
      case 'STARTTLS': return say('502 5.5.1 not offered (this computer only)');
      case 'DATA': mode = 'data'; size = 0; tail = '\r\n'; return say('354 end with <CRLF>.<CRLF>');
      case 'QUIT': say('221 2.0.0 bye'); return sock.end();
      default: return say('500 5.5.2 command not recognized');
    }
  }

  say('220 sink ESMTP ready');
  sock.on('data', (chunk) => {
    if (mode === 'data') {
      size += chunk.length;
      if (size > MAX_BYTES) { say('552 5.3.4 message too large'); return sock.destroy(); }
      tail = (tail + chunk).slice(-5);
      if (tail.endsWith('\r\n.\r\n')) {
        mode = 'cmd'; dropped += 1; tail = '';
        console.log(JSON.stringify({ sink: 'dropped', n: dropped, bytes: size })); // eslint-disable-line no-console
        say('250 2.0.0 accepted and dropped');
      }
      return undefined;
    }
    buf += chunk;
    let i = buf.indexOf('\r\n');
    while (i >= 0 && mode !== 'data') {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      command(line);
      i = buf.indexOf('\r\n');
    }
    return undefined;
  });
  sock.on('error', () => {});
}

const server = net.createServer(handle);
server.maxConnections = 20;
server.on('error', (e) => { console.error(`[sink] ${e.message}`); process.exit(1); }); // eslint-disable-line no-console
server.listen(PORT, HOST, () => console.log(`[sink] listening on ${HOST}:${PORT}; every message is dropped, nothing is stored`)); // eslint-disable-line no-console
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
