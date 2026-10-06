// ---------------------------------------------------------------------------
// A SMALL IN-MEMORY RATE LIMIT for the no-login agreement link endpoints
// (2026-10-05). Per caller IP and bucket, a fixed window:
//
//   rateLimit({ bucket: 'agreement-link', max: 120, windowMs: 10 * 60000 })
//
// Over the limit the request gets 429 in plain words and a Retry-After
// header. One process, no dependency, no table — the link is already a
// secret token, this only stops someone hammering it (guessing tokens,
// spraying codes). Buckets are swept as they age so memory stays flat.
// ---------------------------------------------------------------------------
const hits = new Map(); // `${bucket}|${ip}` -> { start, count }
let lastSweep = Date.now();

// The caller: the socket peer, unless that peer is a local proxy (the Vite
// dev proxy, nginx on the same box) — then the LAST X-Forwarded-For hop, the
// one the proxy itself appended (a caller can fake the first hops, not that one).
function ipOf(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || req.ip || '').replace(/^::ffff:/, '');
  const local = /^(127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(peer);
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
  return ((local && hops.length ? hops[hops.length - 1] : peer) || 'unknown').slice(0, 60);
}

function sweep(now) {
  if (now - lastSweep < 60000) return;
  lastSweep = now;
  hits.forEach((v, k) => { if (now - v.start > v.windowMs) hits.delete(k); });
}

function rateLimit({ bucket, max, windowMs, message } = {}) {
  const limit = Math.max(1, Number(max) || 60);
  const win = Math.max(1000, Number(windowMs) || 600000);
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);
    const key = `${bucket}|${ipOf(req)}`;
    let row = hits.get(key);
    if (!row || now - row.start > win) { row = { start: now, count: 0, windowMs: win }; hits.set(key, row); }
    row.count += 1;
    if (row.count > limit) {
      const retry = Math.max(1, Math.ceil((row.start + win - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({
        error: message || `Too many tries from your network. Please wait ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''} and try again.`,
        retryAfter: retry,
      });
    }
    return next();
  };
}

// Tests only: forget every counter.
function resetRateLimits() { hits.clear(); }

module.exports = { rateLimit, resetRateLimits, ipOf };
