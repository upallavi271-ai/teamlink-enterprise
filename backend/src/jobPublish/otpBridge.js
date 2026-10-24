// ---------------------------------------------------------------------------
// OTP HAND-OVER (human in the loop). NOTHING here solves, guesses, reads or bypasses a one-time code.
//
// When a portal asks for an OTP the worker's run does NOT give up at once: it stops, keeps its browser open, shows
// "Needs your help" and waits for a PERSON to type the code that reached THEIR phone or e-mail. The code travels
//   person's browser  ->  API (POST /api/job-publish/queue/:id/otp)  ->  loopback socket  ->  the waiting run  ->  the OTP box
// and lives ONLY in memory on the way: it is never written to the database, a log line, an audit row, a file, a
// screenshot (the box is masked) or an API answer. The run's logger also scrubs it (addSecret).
//
// The socket listens on 127.0.0.1 only (a random port, announced in the queue entry's "waiting" note, which holds no
// secret). Every message is signed (HMAC of the queue id with the server secret), so another program on the same
// computer cannot feed the run a code. The API and the worker must run on the SAME computer (they do on the VPS and on
// the dev machine); if not, the screen says so and the person signs in through the portal session instead.
// ---------------------------------------------------------------------------
const net = require('net');
const crypto = require('crypto');

const CODE_RE = /^[A-Za-z0-9]{4,10}$/;
const waiters = new Map(); // queueId -> { resolve, reject, kind }
let server = null;
let serverPort = null;

function secret() {
  const s = process.env.JWT_SECRET || process.env.INTEGRATION_SECRET_KEY || '';
  return s && s.length >= 8 ? s : null;
}
const sign = (queueId) => crypto.createHmac('sha256', secret() || 'x').update(`otp:${queueId}`).digest('hex');
const sameSig = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const validCode = (code) => CODE_RE.test(String(code || '').trim());

// ---------------------------------------------------------------- the worker side
function ensureServer() {
  if (serverPort) return Promise.resolve(serverPort);
  if (!secret()) return Promise.reject(Object.assign(new Error('The server has no secret key, so the OTP hand-over is off.'), { code: 'NO_SECRET' }));
  return new Promise((resolve, reject) => {
    server = net.createServer((sock) => {
      let buf = '';
      sock.setTimeout(5000, () => sock.destroy());
      sock.on('error', () => {});
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.length > 600) { sock.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        let msg = null;
        try { msg = JSON.parse(buf.slice(0, nl)); } catch { msg = null; }
        buf = '';
        const reply = (o) => { try { sock.end(`${JSON.stringify(o)}\n`); } catch { /* gone */ } };
        if (!msg || !msg.q || !sameSig(msg.s, sign(msg.q))) return reply({ ok: false, why: 'BAD_SIGNATURE' });
        const w = waiters.get(String(msg.q));
        if (!w) return reply({ ok: false, why: 'NOT_WAITING' });
        if (!validCode(msg.c)) return reply({ ok: false, why: 'BAD_FORMAT' });
        waiters.delete(String(msg.q));
        w.resolve(String(msg.c).trim());
        return reply({ ok: true });
      });
    });
    server.on('error', (e) => { server = null; serverPort = null; reject(e); });
    server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; server.unref(); resolve(serverPort); });
  });
}

// Wait for a person's code. -> the code | null (nobody typed one in time).  `watch` is called every 2 s and may throw
// (a kill switch / shutdown): the wait then ends with that error.
function waitForCode(queueId, { timeoutMs = 300000, watch = null } = {}) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); clearInterval(tick); waiters.delete(String(queueId)); fn(v); };
    const timer = setTimeout(() => done(resolve, null), timeoutMs);
    const tick = setInterval(async () => { if (watch) { try { await watch(); } catch (e) { done(reject, e); } } }, 2000);
    waiters.set(String(queueId), { kind: 'OTP', resolve: (c) => done(resolve, c), reject: (e) => done(reject, e) });
  });
}
const isWaiting = (queueId) => waiters.has(String(queueId));
function stopServer() { if (server) { try { server.close(); } catch { /* closed */ } } server = null; serverPort = null; waiters.clear(); }

// ---------------------------------------------------------------- the API side
// -> { ok:true } | { ok:false, why: 'NOT_WAITING'|'BAD_FORMAT'|'BAD_SIGNATURE'|'UNREACHABLE'|'NO_SECRET' }
function deliver(queueId, port, code) {
  return new Promise((resolve) => {
    if (!secret()) return resolve({ ok: false, why: 'NO_SECRET' });
    if (!validCode(code)) return resolve({ ok: false, why: 'BAD_FORMAT' });
    if (!Number.isInteger(Number(port)) || Number(port) < 1024) return resolve({ ok: false, why: 'UNREACHABLE' });
    let out = '';
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    sock.setTimeout(5000, () => { sock.destroy(); resolve({ ok: false, why: 'UNREACHABLE' }); });
    sock.on('error', () => resolve({ ok: false, why: 'UNREACHABLE' }));
    sock.on('connect', () => sock.write(`${JSON.stringify({ q: String(queueId), s: sign(queueId), c: String(code).trim() })}\n`));
    sock.on('data', (d) => { out += d.toString('utf8'); });
    sock.on('end', () => { try { resolve(JSON.parse(out.trim())); } catch { resolve({ ok: false, why: 'UNREACHABLE' }); } });
    return undefined;
  });
}

module.exports = {
  ensureServer, waitForCode, isWaiting, stopServer, deliver, validCode, CODE_RE,
};
