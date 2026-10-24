// ---------------------------------------------------------------------------
// EMAIL DELIVERY WEBHOOK (a stub for the future mail provider): POST /api/public/outreach/webhook/email
//   Signed with a shared secret: headers  x-outreach-timestamp: <unix seconds>  and  x-outreach-signature: hex(HMAC-SHA256(secret, timestamp + "." + rawBody)).
//   The secret is OUTREACH_WEBHOOK_SECRET, or (when that is not set) a key derived from INTEGRATION_SECRET_KEY; an Admin reads it in Campaigns > Settings.
//   A timestamp more than 5 minutes old (or in the future) is refused, so a captured request cannot be replayed later.
//   Body: { events: [ { eventId, type: 'delivered' | 'bounce' | 'complaint', bounceType?: 'hard' | 'soft', providerRef?, messageId?, at? } ] }  (or one event)
//   IDEMPOTENT: every event is written to OutreachWebhookReceipt first (provider + eventId, primary key); the same event twice changes nothing.
//   A status never goes backwards: sent -> delivered; a bounce / complaint always wins and never gets undone by a late 'delivered'.
//   Hard bounce -> the address is marked bad (health) and put on the do-not-contact list (hash). Complaint -> opted out + do-not-contact + health.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./store');
const C = require('./consent');
const Ev = require('./events');

const PROVIDER = 'email';
const SKEW_MS = 5 * 60000;
const secret = () => process.env.OUTREACH_WEBHOOK_SECRET || S.keyFor('outreach.webhook.v1').toString('hex');
const sign = (ts, raw) => crypto.createHmac('sha256', secret()).update(`${ts}.${Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)}`).digest('hex');

// -> { ok } | { ok: false, reason }
function verify(headers, raw, now = Date.now()) {
  const ts = String(headers['x-outreach-timestamp'] || '');
  const sig = String(headers['x-outreach-signature'] || '');
  if (!/^\d{9,13}$/.test(ts) || !/^[a-f0-9]{64}$/i.test(sig)) return { ok: false, reason: 'missing' };
  const t = Number(ts) * (ts.length > 11 ? 1 : 1000);
  if (Math.abs(now - t) > SKEW_MS) return { ok: false, reason: 'stale' };
  const want = Buffer.from(sign(ts, raw), 'hex'); const got = Buffer.from(sig, 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

const RANK = { queued: 0, sending: 1, sent: 2, test_captured: 2, delivered: 3 };
const TERMINAL_BAD = ['bounced', 'complained'];

async function applyOne(ev, now) {
  const eventId = S.clip(ev && ev.eventId, 120);
  const type = String(ev && ev.type || '');
  if (!eventId || !['delivered', 'bounce', 'complaint'].includes(type)) return { ignored: 'bad_event' };
  const fresh = await S.run('INSERT OR IGNORE INTO "OutreachWebhookReceipt" (provider, providerEventId, receivedAt) VALUES (?,?,?)', PROVIDER, eventId, now);
  if (!fresh) return { duplicate: true };
  try {
    const ref = S.clip(ev.providerRef, 200); const mid = S.clip(ev.messageId, 80);
    const m = (ref ? (await S.q('SELECT * FROM "OutreachMessage" WHERE providerRef = ? LIMIT 1', ref))[0] : null) || (mid ? (await S.q('SELECT * FROM "OutreachMessage" WHERE id = ?', mid))[0] : null);
    if (!m) {
      // Not a campaign message: it may be a VENDOR login email (welcome / reset / new address). Same signed webhook, same events:
      // "delivered" is the provider CONFIRMING delivery; a bounce marks the email Failed (utils/vendorMail.js applyProviderEvent).
      const vm = await require('../utils/vendorMail').applyProviderEvent(ev, ev.at ? (Date.parse(ev.at) || now) : now).catch(() => null); // eslint-disable-line global-require
      if (vm && vm.updated) return { updated: vm.updated };
      return { unmatched: true };
    }
    const camp = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', m.campaignId))[0];
    const at = ev.at ? (Date.parse(ev.at) || now) : now;
    if (type === 'delivered') {
      if (!(m.status in RANK) || RANK[m.status] >= RANK.delivered) return { unchanged: true };
      await S.run('UPDATE "OutreachMessage" SET status = \'delivered\', deliveredAt = ? WHERE id = ? AND status IN (\'sent\',\'test_captured\')', at, m.id);
      await Ev.record('delivered', m, camp, { at, source: 'provider' });
      return { updated: 'delivered' };
    }
    const hard = type === 'complaint' || ev.bounceType === 'hard';
    const next = type === 'complaint' ? 'complained' : (hard ? 'bounced' : 'failed');
    if (TERMINAL_BAD.includes(m.status)) return { unchanged: true };
    if (!hard && m.status === 'delivered') return { unchanged: true }; // a late soft bounce cannot undo a delivery
    await S.run('UPDATE "OutreachMessage" SET status = ?, reason = ?, failedAt = ? WHERE id = ?', next, type === 'complaint' ? 'complaint' : (hard ? 'hard_bounce' : 'soft_bounce'), at, m.id);
    await Ev.record('failed', m, camp, { at, source: 'provider', detail: { reason: type === 'complaint' ? 'complaint' : (hard ? 'hard_bounce' : 'soft_bounce') } });
    if (hard) {
      await C.optOut(m.contactId, 'email', { reason: type === 'complaint' ? 'complaint' : 'hard_bounce', source: 'webhook', evidence: type === 'complaint' ? 'Marked our email as spam' : 'The address does not exist (bounce)', by: null });
      await S.run('UPDATE "OutreachContactChannel" SET health = ?, lastBounceAt = ? WHERE contactId = ? AND channel = \'email\'', type === 'complaint' ? 'complained' : 'hard_bounced', at, m.contactId);
    }
    return { updated: next };
  } catch (e) {
    await S.run('DELETE FROM "OutreachWebhookReceipt" WHERE provider = ? AND providerEventId = ?', PROVIDER, eventId); // so the provider's retry can work
    throw e;
  }
}

async function apply(body, now = Date.now()) {
  const list = Array.isArray(body && body.events) ? body.events : (body && body.eventId ? [body] : []);
  const out = { received: list.length, updated: 0, duplicates: 0, unmatched: 0, ignored: 0 };
  for (const ev of list.slice(0, 500)) {
    const r = await applyOne(ev, now); // eslint-disable-line no-await-in-loop
    if (r.updated) out.updated += 1; else if (r.duplicate) out.duplicates += 1; else if (r.unmatched) out.unmatched += 1; else if (r.ignored) out.ignored += 1;
  }
  return out;
}

module.exports = { verify, sign, secret, apply, PROVIDER };
