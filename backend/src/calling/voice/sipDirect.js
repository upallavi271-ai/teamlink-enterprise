// ---------------------------------------------------------------------------
// DIRECT TO THE SIM GATEWAY - a real phone call without Asterisk (2026-10-28).
//
// When TeamLink and the Synway SMG gateway are on the same office network, the backend itself can ask the gateway to dial:
// the gateway's IP->Tel route sends a call from any address out through its SIMs. This module is a small SIP caller (UDP)
// plus the voice (RTP, G.711) and plays the part Asterisk plays on the server: when the person answers it connects to the AI
// gateway over AudioSocket (127.0.0.1:9092) with the call's UUID, so gateway.js runs the same conversation.
//
//   originate({ host, port, number, uuid, gatewayPort, localIp, ringSec }) -> Promise<{ ok } | { ok:false, status, reason }>
//     resolves when the person answers (ok) or the call ends without an answer (busy / no-answer / failed)
//
// Only what one outgoing call needs: INVITE (+ retransmit, CANCEL on ring timeout), ACK, BYE both ways, PCMA / PCMU.
// ---------------------------------------------------------------------------
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const A = require('./audioSocket');

const log = (...a) => console.log('[ai-sip]', ...a); // eslint-disable-line no-console
const rnd = (n = 8) => crypto.randomBytes(n).toString('hex');

// --- G.711 ------------------------------------------------------------------------------------------------------------------------
function ulawDecode(u) {
  const x = ~u & 0xff; const t = (((x & 0x0f) << 3) + 0x84) << ((x & 0x70) >> 4);
  return x & 0x80 ? 0x84 - t : t - 0x84;
}
function ulawEncode(s) {
  const sign = s < 0 ? 0x80 : 0; let v = Math.min(32635, Math.abs(s)) + 0x84;
  let e = 7; for (let m = 0x4000; (v & m) === 0 && e > 0; m >>= 1) e -= 1;
  return ~(sign | (e << 4) | ((v >> (e + 3)) & 0x0f)) & 0xff;
}
function alawDecode(a) {
  const x = a ^ 0x55; const e = (x & 0x70) >> 4; let t = (x & 0x0f) << 4;
  t = e === 0 ? t + 8 : ((t + 0x108) << (e - 1));
  return x & 0x80 ? t : -t;
}
function alawEncode(s) {
  const sign = s >= 0 ? 0x80 : 0; const v = Math.min(32767, Math.abs(s));
  let out;
  if (v < 256) out = v >> 4;
  else { let e = 1; while (v >= (256 << e) && e < 7) e += 1; out = (e << 4) | ((v >> (e + 3)) & 0x0f); }
  return (out | sign) ^ 0x55;
}
const CODECS = { 8: { name: 'PCMA', dec: alawDecode, enc: alawEncode }, 0: { name: 'PCMU', dec: ulawDecode, enc: ulawEncode } };
const decode = (pt, buf) => { const c = CODECS[pt]; const out = Buffer.alloc(buf.length * 2); for (let i = 0; i < buf.length; i += 1) out.writeInt16LE(c.dec(buf[i]), i * 2); return out; };
const encode = (pt, pcm) => { const c = CODECS[pt]; const out = Buffer.alloc(pcm.length >> 1); for (let i = 0; i < out.length; i += 1) out[i] = c.enc(pcm.readInt16LE(i * 2)); return out; };

// --- SIP text -----------------------------------------------------------------------------------------------------------------------
function parseSip(text) {
  const [head, body = ''] = text.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const first = lines.shift();
  const h = {};
  for (const l of lines) { const i = l.indexOf(':'); if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); (h[k] = h[k] || []).push(l.slice(i + 1).trim()); } }
  const m = /^SIP\/2\.0 (\d{3})/.exec(first);
  return { first, status: m ? Number(m[1]) : null, method: m ? null : first.split(' ')[0], h, get: (k) => (h[k] || [])[0] || '', body };
}
function parseSdp(body) {
  const ip = (/^c=IN IP4 (\S+)/m.exec(body) || [])[1];
  const m = /^m=audio (\d+) RTP\/AVP ([\d ]+)/m.exec(body);
  if (!ip || !m) return null;
  const pts = m[2].trim().split(/\s+/).map(Number);
  return { ip, port: Number(m[1]), pt: pts.find((p) => CODECS[p] !== undefined) };
}
const tagOf = (v) => (/;tag=([^;>\s]+)/.exec(v) || [])[1] || null;
const uriOf = (v) => (/<([^>]+)>/.exec(v) || [])[1] || null;

function originate({
  host, port = 5060, number, uuid, gatewayPort = 9092, localIp, ringSec = 35,
}) {
  return new Promise((resolve) => {
    const sip = dgram.createSocket('udp4'); const rtp = dgram.createSocket('udp4');
    const callId = `${rnd(10)}@${localIp}`; const fromTag = rnd(4); const branch = `z9hG4bK${rnd(8)}`;
    const target = `sip:${number}@${host}:${port}`;
    let toHeader = `<sip:${number}@${host}>`; let remoteUri = target; let cseq = 1;
    let state = 'calling'; let settled = false; let timers = []; let media = null; let as = null;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const send = (text) => { try { sip.send(Buffer.from(text), port, host); } catch { /* closed */ } };
    const via = (b) => `Via: SIP/2.0/UDP ${localIp}:${sip.address().port};branch=${b};rport`;
    const from = `From: <sip:teamlink@${localIp}>;tag=${fromTag}`;

    function finish(why) {
      if (state === 'ended') return;
      state = 'ended'; clear();
      if (as && !as.destroyed) { as.write(A.encode(A.KIND.HANGUP)); as.end(); }
      setTimeout(() => { try { sip.close(); } catch { /* */ } try { rtp.close(); } catch { /* */ } }, 300);
      log('ended:', why);
    }
    function request(method, b, extra = '', body = '') {
      return `${method} ${method === 'INVITE' || method === 'CANCEL' ? target : remoteUri} SIP/2.0\r\n${via(b)}\r\nMax-Forwards: 70\r\n${from}\r\nTo: ${toHeader}\r\nCall-ID: ${callId}\r\n`
        + `CSeq: ${method === 'CANCEL' || method === 'ACK' ? 1 : cseq} ${method}\r\nContact: <sip:teamlink@${localIp}:${sip.address().port}>\r\nUser-Agent: TeamLink-AI\r\n${extra}`
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function bye() { cseq += 1; send(request('BYE', `z9hG4bK${rnd(8)}`)); finish('we hung up'); }

    // media: RTP from the gateway's SIM -> AudioSocket to the AI; the AI's frames -> RTP back
    function startMedia(sdp) {
      media = { ...sdp, seq: Math.floor(Math.random() * 65535), ts: Math.floor(Math.random() * 1e9), ssrc: crypto.randomBytes(4).readUInt32BE(0) };
      as = net.connect(gatewayPort, '127.0.0.1');
      const reader = new A.Reader();
      as.on('connect', () => as.write(A.encode(A.KIND.UUID, A.uuidBytes(uuid))));
      as.on('data', (c) => {
        for (const m of reader.feed(c)) {
          if (m.kind === A.KIND.AUDIO && state === 'up') {
            const pay = encode(media.pt, m.payload);
            const hdr = Buffer.alloc(12); hdr[0] = 0x80; hdr[1] = media.pt;
            media.seq = (media.seq + 1) & 0xffff; media.ts = (media.ts + pay.length) >>> 0;
            hdr.writeUInt16BE(media.seq, 2); hdr.writeUInt32BE(media.ts, 4); hdr.writeUInt32BE(media.ssrc, 8);
            rtp.send(Buffer.concat([hdr, pay]), media.port, media.ip);
          } else if (m.kind === A.KIND.HANGUP && state === 'up') bye();
        }
      });
      as.on('close', () => { if (state === 'up') bye(); });
      as.on('error', (e) => { log('AI gateway:', e.message); if (state === 'up') bye(); });
    }
    rtp.on('message', (msg) => {
      if (!media || !as || as.destroyed || msg.length < 12) return;
      const pt = msg[1] & 0x7f; if (!CODECS[pt]) return; // telephone-event etc.
      let off = 12 + (msg[0] & 0x0f) * 4;
      if (msg[0] & 0x10) off += 4 + msg.readUInt16BE(off + 2) * 4;
      const pcm = decode(pt, msg.subarray(off));
      for (let i = 0; i + A.FRAME_BYTES <= pcm.length; i += A.FRAME_BYTES) as.write(A.encode(A.KIND.AUDIO, pcm.subarray(i, i + A.FRAME_BYTES)));
    });

    sip.on('message', (buf) => {
      const r = parseSip(buf.toString());
      if (r.get('call-id') !== callId) return;
      if (r.method) { // a request from the gateway (BYE when the person hangs up)
        const ok = `SIP/2.0 200 OK\r\n${(r.h.via || []).map((v) => `Via: ${v}`).join('\r\n')}\r\nFrom: ${r.get('from')}\r\nTo: ${r.get('to')}\r\nCall-ID: ${callId}\r\nCSeq: ${r.get('cseq')}\r\nContent-Length: 0\r\n\r\n`;
        send(ok);
        if (r.method === 'BYE') finish('the person hung up');
        return;
      }
      const meth = r.get('cseq').split(' ')[1];
      if (meth !== 'INVITE') return;
      if (r.status < 200) { if (state === 'calling') { state = 'ringing'; timers.slice(0, -1).forEach(clearTimeout); } return; }
      const tag = tagOf(r.get('to'));
      if (tag) toHeader = `<sip:${number}@${host}>;tag=${tag}`;
      if (r.status < 300) {
        remoteUri = uriOf(r.get('contact')) || target;
        send(request('ACK', `z9hG4bK${rnd(8)}`));
        if (state === 'up') return; // a resent 200: ACK again only
        clear(); state = 'up';
        const sdp = parseSdp(r.body);
        if (!sdp || sdp.pt === undefined) { bye(); done({ ok: false, status: 'failed', reason: 'The gateway answered without a voice channel we can use (needs G.711 A-law or U-law).' }); return; }
        log(`answered: ${CODECS[sdp.pt].name} ${sdp.ip}:${sdp.port}`);
        startMedia(sdp);
        done({ ok: true, hangup: bye });
        return;
      }
      // the call did not connect: the INVITE transaction still needs its ACK
      send(request('ACK', branch));
      const status = [486, 600, 603].includes(r.status) ? 'busy' : [408, 480, 487].includes(r.status) ? 'no-answer' : 'failed';
      const reason = { busy: 'The line was busy.', 'no-answer': 'The candidate did not answer.' }[status] || `The gateway refused the call (${r.first.slice(8, 60)}).`;
      finish(reason); done({ ok: false, status, reason, code: r.status });
    });

    rtp.bind(0, localIp, () => sip.bind(0, localIp, () => {
      const sess = Date.now();
      const sdp = `v=0\r\no=teamlink ${sess} ${sess} IN IP4 ${localIp}\r\ns=TeamLink AI\r\nc=IN IP4 ${localIp}\r\nt=0 0\r\n`
        + `m=audio ${rtp.address().port} RTP/AVP 8 0 101\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=ptime:20\r\na=sendrecv\r\n`;
      const invite = request('INVITE', branch, 'Content-Type: application/sdp\r\n', sdp);
      send(invite);
      [500, 1000, 2000, 4000].reduce((at, d) => { timers.push(setTimeout(() => { if (state === 'calling') send(invite); }, at + d)); return at + d; }, 0);
      timers.push(setTimeout(() => { // nothing at all from the gateway
        if (state === 'calling') { finish('no reply'); done({ ok: false, status: 'failed', reason: `The SIM gateway at ${host} did not reply.` }); }
      }, 8000));
      timers.push(setTimeout(() => { // rang too long
        if (state === 'ringing' || state === 'calling') { send(request('CANCEL', branch)); finish('ring timeout'); done({ ok: false, status: 'no-answer', reason: 'The candidate did not answer.' }); }
      }, ringSec * 1000));
    }));
  });
}

module.exports = { originate, parseSip, parseSdp, ulawEncode, ulawDecode, alawEncode, alawDecode };
