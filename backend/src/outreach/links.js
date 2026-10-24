// ---------------------------------------------------------------------------
// TOKENS: the tracked apply link and the unsubscribe link. Both are OPAQUE (no name, phone, email in them) and HMAC-signed.
//   tracked token  ctk = base64url( 9 random bytes + first 6 bytes of HMAC(key, "ctk.v1|" + random) ), 20 characters.
//                  72 bits of randomness (cannot be guessed); the MAC lets the server throw out a forged or mistyped token with no
//                  database lookup. Phase 3 stores it against the message row (OutreachMessage.token) and counts the click.
//                  INTERNAL campaigns never get a token: mintTracked() refuses.
//   unsubscribe    utk = "u1." + base64url("<contactId>|<channel>[|<messageId>]") + "." + base64url(HMAC(key, payload), 16 bytes)
//                  No expiry on purpose (an old email must still be able to unsubscribe). Verifying is constant time. Using it twice
//                  changes nothing the second time (consent.optOut is idempotent).
// Keys come from store.keyFor(label): HKDF of INTEGRATION_SECRET_KEY, a separate key per label.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./store');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (label, data, bytes) => crypto.createHmac('sha256', S.keyFor(label)).update(data).digest().subarray(0, bytes);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const CH_LETTER = { email: 'e', whatsapp: 'w', sms: 's' };

// ---- tracked apply link -------------------------------------------------------------
function mintTracked({ contactType, campaignType } = {}) {
  if (contactType === 'internal' || campaignType === 'internal') throw new S.OutreachError('internal_no_link', 'Internal messages never carry a tracked apply link.', 403);
  const rnd = crypto.randomBytes(9);
  return b64(Buffer.concat([rnd, mac('outreach.link.v1', `ctk.v1|${b64(rnd)}`, 6)]));
}
// true when the token is well formed and signed by us (no database needed)
function verifyTracked(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20}$/.test(t)) return false;
  const buf = Buffer.from(t, 'base64url');
  if (buf.length !== 15) return false;
  return same(buf.subarray(9), mac('outreach.link.v1', `ctk.v1|${b64(buf.subarray(0, 9))}`, 6));
}
// the apply link a contact gets: <portal apply url>?cid=<campaign code>&ctk=<token>&ch=<e|w|s>  (nothing personal in it)
function applyUrl(portalApplyUrl, { campaignCode, token, channel }) {
  const u = new URL(portalApplyUrl);
  u.searchParams.set('cid', String(campaignCode || ''));
  u.searchParams.set('ctk', String(token || ''));
  u.searchParams.set('ch', CH_LETTER[channel] || 'e');
  return u.toString();
}
// the short link on our own domain that counts the click, then redirects to applyUrl (Phase 3 mounts the route)
const shortUrl = (base, token) => `${String(base || '').replace(/\/+$/, '')}/r/${token}`;

// ---- unsubscribe -----------------------------------------------------------------------
function mintUnsubscribe(contactId, channel, messageId) {
  if (!['email', 'whatsapp', 'sms'].includes(channel)) throw new S.OutreachError('bad_channel', 'Unknown channel.');
  const payload = b64(`${contactId}|${channel}${messageId ? `|${messageId}` : ''}`);
  return `u1.${payload}.${b64(mac('outreach.unsub.v1', payload, 16))}`;
}
function verifyUnsubscribe(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'u1' || parts[1].length > 200 || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return { ok: false };
  const given = Buffer.from(parts[2], 'base64url');
  if (!same(given, mac('outreach.unsub.v1', parts[1], 16))) return { ok: false };
  const [contactId, channel, messageId] = Buffer.from(parts[1], 'base64url').toString('utf8').split('|');
  if (!contactId || !['email', 'whatsapp', 'sms'].includes(channel)) return { ok: false };
  return { ok: true, contactId, channel, messageId: messageId || null };
}
// where the link points (the dev site proxies /api only, so the link lives under /api/public)
const unsubscribeUrl = (base, token) => `${String(base || process.env.APP_BASE_URL || '').replace(/\/+$/, '')}/api/public/outreach/u/${token}`;

module.exports = { mintTracked, verifyTracked, applyUrl, shortUrl, mintUnsubscribe, verifyUnsubscribe, unsubscribeUrl, CH_LETTER };
