// ---------------------------------------------------------------------------
// SIGNED, EXPIRING DOWNLOAD LINKS for the Vendor Portal.
//
// A vendor asks for a link (POST /api/vendor-portal/download-link — a signed-in
// request that checks the file belongs to the vendor). The answer is a URL with
// an HMAC-signed token (kind, file id, vendor id, vendor login id, session id,
// expiry — 3 minutes). Opening it needs no header (a browser tab can't send
// one), so the file route repeats EVERY check: signature, expiry, the session
// is still alive, the login is still active, the file still belongs to that
// vendor. The token alone is never enough, and a changed byte fails the HMAC.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const TTL_SECONDS = 180;
function secret() {
  const base = process.env.VENDOR_JWT_SECRET || process.env.JWT_SECRET || '';
  if (!base) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', base).update('teamlink-vendor-download-v1').digest();
}
const b64 = (b) => Buffer.from(b).toString('base64url');

function sign(claims, ttlSeconds = TTL_SECONDS) {
  const payload = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds, n: crypto.randomBytes(6).toString('hex') };
  const body = b64(JSON.stringify(payload));
  const sig = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return { token: `${body}.${sig}`, expiresAt: new Date(payload.exp * 1000) };
}

// Verified claims, or null (bad shape, bad signature, expired).
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const want = crypto.createHmac('sha256', secret()).update(parts[0]).digest();
  let got;
  try { got = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!c || typeof c !== 'object' || !(Number(c.exp) * 1000 > Date.now())) return null;
    return c;
  } catch { return null; }
}
module.exports = { sign, verify, TTL_SECONDS };
