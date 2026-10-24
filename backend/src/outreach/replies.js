// ---------------------------------------------------------------------------
// REPLY TAGGING (Omni-Channel): when a person writes back (the one inbox, utils/conversations.js recordIn), find their Omni-Channel contact and
//   * OutreachContact.lastReplyAt        = when they last wrote back (shown on the customer page, see lastReplyOf)
//   * OutreachMessage.repliedAt          = the latest message we sent that contact in the last 14 days (the one they most likely answered)
//   * OutreachEvent 'replied'            = one funnel event for that message (PII-free: ids, a type, a time). Internal (staff) campaigns write
//                                          NO funnel events at all (the same rule as events.js), only the repliedAt time on the message.
// onReply() NEVER throws and never blocks the inbox: it is called fire-and-forget from recordIn, inside a try / catch.
// The event is written with plain SQL (source 'reply', eventKey 'replied:<messageId>' = one per message, a double webhook is one row), so it works
// whether or not events.js already lists 'replied' in its TYPES.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const K = require('./contacts');

const WINDOW_MS = 14 * 86400000;
const CH_OF = { email: 'email', mail: 'email', whatsapp: 'whatsapp', sms: 'sms', call: 'call' };

// the address of a person of the one inbox (a reply row often carries no address)
async function addressOfPerson(personType, personId) {
  try {
    if (personType === 'CANDIDATE') {
      const c = await prisma.candidate.findUnique({ where: { id: String(personId) }, select: { phone: true, email: true } });
      return c ? { phone: c.phone, email: c.email } : {};
    }
    if (personType === 'EMPLOYEE') {
      const e = await prisma.employee.findUnique({ where: { id: String(personId) }, select: { phone: true, email: true } });
      return e ? { phone: e.phone, email: e.email } : {};
    }
    if (personType === 'CLIENT') {
      const c = await prisma.client.findUnique({ where: { id: String(personId) }, select: { contactPhone: true, contactWhatsApp: true, contactEmail: true } });
      return c ? { phone: c.contactWhatsApp || c.contactPhone, email: c.contactEmail } : {};
    }
  } catch { /* nothing to find */ }
  return {};
}

// { address, channel, at, personType?, personId? } -> { contacts, message } (counts) ; never throws
async function onReply({ address, channel, at, personType, personId } = {}) {
  const out = { contacts: 0, tagged: 0, event: false };
  try {
    if (!(await S.ready())) return out;
    await require('./v3schema').ensure(); // eslint-disable-line global-require
    const when = S.ms(at) || Date.now();
    const ch = CH_OF[String(channel || '').toLowerCase()] || null;
    let phoneKey = null; let emailKey = null;
    const raw = String(address || '').trim();
    if (raw) {
      if (raw.includes('@')) { const e = K.emailOf(raw); if (e.ok) emailKey = e.key; } else { const p = K.phoneOf(raw); if (p.ok) phoneKey = p.key; }
    }
    // no address on the reply: use the person the reply belongs to
    if (!phoneKey && !emailKey && personType && personId) {
      const a = await addressOfPerson(personType, personId);
      const p = K.phoneOf(a.phone); const e = K.emailOf(a.email);
      if (ch === 'email') { if (e.ok) emailKey = e.key; } else if (p.ok) phoneKey = p.key; else if (e.ok) emailKey = e.key;
    }
    if (!phoneKey && !emailKey) return out;
    const contacts = await K.findByKeys(phoneKey, emailKey);
    out.contacts = contacts.length;
    for (const c of contacts) {
      await S.run('UPDATE "OutreachContact" SET lastReplyAt = ? WHERE id = ? AND (lastReplyAt IS NULL OR lastReplyAt < ?)', when, c.id, when); // eslint-disable-line no-await-in-loop
      if (!(await S.campaignsReady())) continue; // eslint-disable-line no-continue
      const since = when - WINDOW_MS;
      const rows = await S.q( // eslint-disable-line no-await-in-loop
        `SELECT m.id, m.channel, m.campaignId, m.requirementId, m.repliedAt, k.type AS campType, CAST(COALESCE(m.sentAt, m.queuedAt) AS TEXT) AS at
           FROM "OutreachMessage" m LEFT JOIN "OutreachCampaign" k ON k.id = m.campaignId
          WHERE m.contactId = ? AND m.status IN ('sent','delivered','test_captured') AND COALESCE(m.sentAt, m.queuedAt) >= ? AND COALESCE(m.sentAt, m.queuedAt) <= ?
          ORDER BY COALESCE(m.sentAt, m.queuedAt) DESC LIMIT 20`, c.id, since, when + 60000,
      );
      if (!rows.length) continue; // eslint-disable-line no-continue
      const msg = (ch && rows.find((r) => r.channel === ch)) || rows[0];
      if (msg.repliedAt == null) {
        await S.run('UPDATE "OutreachMessage" SET repliedAt = ? WHERE id = ? AND repliedAt IS NULL', when, msg.id); // eslint-disable-line no-await-in-loop
        out.tagged += 1;
      }
      if (msg.campType !== 'internal') {
        const key = `replied:${msg.id}`;
        const n = await S.run('INSERT OR IGNORE INTO "OutreachEvent" (id, eventKey, type, contactId, campaignId, messageId, requirementId, channel, source, occurredAt, receivedAt, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', // eslint-disable-line no-await-in-loop
          S.newId('oev'), key, 'replied', c.id, msg.campaignId, msg.id, msg.requirementId || null, msg.channel || ch || null, 'reply', when, Date.now(), null);
        if (n > 0) out.event = true;
      }
    }
  } catch (e) { console.error('[omni-replies]', e.message); } // eslint-disable-line no-console
  return out;
}

// when this contact last wrote back: { at (ISO) | null }. `contact` = an id or a contact row.
async function lastReplyOf(contact) {
  try {
    const id = contact && typeof contact === 'object' ? contact.id : contact;
    if (!id) return { at: null };
    await require('./v3schema').ensure(); // eslint-disable-line global-require
    const r = (await S.q('SELECT lastReplyAt FROM "OutreachContact" WHERE id = ?', String(id)))[0];
    return { at: r && r.lastReplyAt ? S.iso(r.lastReplyAt) : null };
  } catch { return { at: null }; }
}

module.exports = { onReply, lastReplyOf, WINDOW_MS };
