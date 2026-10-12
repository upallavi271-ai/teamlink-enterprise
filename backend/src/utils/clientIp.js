// ---------------------------------------------------------------------------
// WHO IS CALLING - ONE SAFE ANSWER (security review, Batch 1, 2026-10-09).
//
// X-Forwarded-For is written by whoever sends the request, so the FIRST hop in
// it is whatever the caller typed. Rate limits, the agreement / offer audit
// trail ("signed from IP ...") and the biometric device log all used to take
// that first hop. This helper believes the header only when the TCP peer is a
// reverse proxy on this machine or private network (the Vite dev proxy, nginx),
// and then only the LAST hop - the one that proxy itself appended.
//
//   TRUST_PROXY (env, default OFF) also sets Express' own 'trust proxy' (see
//   utils/webSecurity.js) for req.ip / req.protocol:
//     unset / 0 / false   do not trust any proxy header (Express default)
//     loopback            nginx on the same machine (the usual VPS set-up)
//     1, 2 ...            trust that many proxy hops
//     a subnet list       e.g. "10.0.0.0/8, loopback"
//   Nothing in the app changes while it is unset.
// ---------------------------------------------------------------------------
const PRIVATE = /^(127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i;

function peerOf(req) {
  return String((req.socket && req.socket.remoteAddress) || req.ip || '').replace(/^::ffff:/, '');
}

// The caller's address (string, '' never: 'unknown' as the last resort).
function ipOf(req) {
  if (!req) return 'unknown';
  const peer = peerOf(req);
  const hops = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((h) => h.trim()).filter(Boolean);
  return ((PRIVATE.test(peer) && hops.length ? hops[hops.length - 1] : peer) || 'unknown').slice(0, 60);
}

// True when the request really arrived over https (directly, or through a local proxy that says so).
function isHttps(req) {
  if (req.secure) return true;
  return PRIVATE.test(peerOf(req)) && String((req.headers && req.headers['x-forwarded-proto']) || '').split(',').pop().trim().toLowerCase() === 'https';
}

// The value for app.set('trust proxy', ...) from TRUST_PROXY; undefined = leave it off.
function trustProxySetting(raw = process.env.TRUST_PROXY) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || /^(0|false|off|no)$/i.test(v)) return undefined;
  if (/^(true|on|yes)$/i.test(v)) return 'loopback'; // never blindly "true": that would trust a spoofed header from anywhere
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

module.exports = { ipOf, isHttps, peerOf, trustProxySetting, PRIVATE };
