// ---------------------------------------------------------------------------
// CONSENT, OPT-OUT AND THE DO-NOT-CONTACT REGISTRY.
//   * Per contact and channel: optIn  unknown | opted_in | opted_out  (+ when, where from, the evidence).
//   * OutreachConsentEvent: append-only history (never updated, never removed). Holds a HASH of the address, not the address.
//   * OutreachSuppression: hash + channel ('*' = all channels). Survives erasure, so a deleted person who is imported again lands opted out.
//   * An opt-out is NEVER overridden by an import, a merge or an update. Only an Admin's own "Opted in again" (with a reason) lifts it.
// Logs and audit rows carry ids and counts, never a phone number or an email address.
// ---------------------------------------------------------------------------
const S = require('./store');
const { logAudit } = require('../utils/audit');

const CHANNELS = ['email', 'whatsapp', 'sms'];
const OPT_OUT_REASONS = {
  unsubscribe_link: 'Used the unsubscribe link', stop_reply: 'Replied STOP', admin: 'Marked by an Admin', manual: 'Marked by the team', complaint: 'Complained',
  hard_bounce: 'Address does not exist', import_flag: 'The file said no permission', suppression: 'Was opted out before (do-not-contact list)', erased: 'Removed at their request',
};
// the people-words for a channel
const CHANNEL_WORDS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };

const kindOf = (channel) => (channel === 'email' ? 'email' : 'phone');
function hashFor(contact, channel) {
  return S.hashAddress(kindOf(channel), channel === 'email' ? contact.email : (contact.phoneE164 || contact.phone));
}

async function getContactRow(id) {
  const r = await S.q('SELECT * FROM "OutreachContact" WHERE id = ?', id);
  return r[0] || null;
}
async function channelRows(contactId) {
  return S.q('SELECT * FROM "OutreachContactChannel" WHERE contactId = ?', contactId);
}

async function recordEvent({ contactId = null, hash, channel, action, source = null, evidence = null, textVersion = null, byUserId = null, at = Date.now() }) {
  if (!hash) return null;
  const id = S.newId('oce');
  await S.run('INSERT INTO "OutreachConsentEvent" (id, contactId, addressHash, channel, action, source, evidence, textVersion, byUserId, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, contactId, hash, channel, action, S.clip(source, 60) || null, S.clip(evidence, 400) || null, S.clip(textVersion, 40) || null, byUserId, at);
  return id;
}
async function suppress(hash, channel, reason, source) {
  if (!hash) return;
  await S.run('INSERT OR IGNORE INTO "OutreachSuppression" (addressHash, channel, reason, at, source) VALUES (?,?,?,?,?)', hash, channel, reason, Date.now(), S.clip(source, 60) || null);
}
// is this address on the do-not-contact registry for this channel (or for all)?
async function isSuppressedHash(hash, channel) {
  if (!hash) return false;
  const r = await S.q('SELECT 1 AS x FROM "OutreachSuppression" WHERE addressHash = ? AND channel IN (?, \'*\') LIMIT 1', hash, channel);
  return r.length > 0;
}

// Opt a contact out of ONE channel or all. Idempotent: an already opted-out channel gets no second history row.
// by: { id, name } or null (a public link / a STOP reply). Returns { changed: [channels] }.
async function optOut(contactId, channel, { reason = 'manual', source = null, evidence = null, by = null } = {}) {
  const contact = await getContactRow(contactId);
  if (!contact) return { error: 'This person was not found.', status: 404 };
  const want = channel === 'all' || !channel ? CHANNELS : [channel];
  if (want.some((c) => !CHANNELS.includes(c))) return { error: 'Unknown channel.', status: 400 };
  const now = Date.now();
  const rows = await channelRows(contactId);
  const changed = [];
  for (const ch of want) {
    const row = rows.find((r) => r.channel === ch);
    const hash = hashFor(contact, ch);
    if (!hash) continue; // nothing to opt out on a channel the person has no address for
    await suppress(hash, ch, reason, source || reason); // eslint-disable-line no-await-in-loop
    if (row && row.optIn === 'opted_out') continue; // eslint-disable-line no-continue
    if (row) await S.run('UPDATE "OutreachContactChannel" SET optIn = \'opted_out\', optOutAt = ?, optOutReason = ? WHERE id = ?', now, reason, row.id); // eslint-disable-line no-await-in-loop
    else await S.run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optOutAt, optOutReason) VALUES (?,?,?,?,?,?,?)', S.newId('occ'), contactId, ch, ch === 'email' ? contact.email : contact.phoneE164, 'opted_out', now, reason); // eslint-disable-line no-await-in-loop
    await recordEvent({ contactId, hash, channel: ch, action: 'opt_out', source: source || reason, evidence: evidence || OPT_OUT_REASONS[reason] || reason, byUserId: by && by.id, at: now }); // eslint-disable-line no-await-in-loop
    changed.push(ch);
  }
  if (changed.length && ['unsubscribe_link', 'stop_reply', 'complaint'].includes(reason)) {
    await S.run('UPDATE "OutreachContact" SET unsubscribedAt = ?, updatedAt = ? WHERE id = ?', now, now, contactId);
  }
  if (changed.length && by) {
    await logAudit({ userId: by.id, actorName: by.name, action: 'Outreach contact opted out', entity: 'OutreachContact', entityId: contactId, reason: S.clip(evidence || OPT_OUT_REASONS[reason] || reason, 300), toValue: `channels: ${changed.join(', ')}` });
  }
  return { changed, alreadyOut: changed.length === 0 };
}

// Admin only (the route checks): opt a contact back in, with a written reason. The history stays.
async function optIn(contactId, channel, { reason, by }) {
  const why = S.clip(reason, 300);
  if (why.length < 5) return { error: 'Write in a few words why they may be contacted again.', status: 400 };
  const contact = await getContactRow(contactId);
  if (!contact || contact.status !== 'active') return { error: 'This person was not found.', status: 404 };
  const want = channel === 'all' || !channel ? CHANNELS : [channel];
  if (want.some((c) => !CHANNELS.includes(c))) return { error: 'Unknown channel.', status: 400 };
  const now = Date.now();
  const rows = await channelRows(contactId);
  const changed = [];
  for (const ch of want) {
    const hash = hashFor(contact, ch);
    if (!hash) continue; // eslint-disable-line no-continue
    const row = rows.find((r) => r.channel === ch);
    if (row && ['hard_bounced', 'complained', 'invalid'].includes(row.health)) continue; // eslint-disable-line no-continue
    await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ? AND channel = ?', hash, ch); // eslint-disable-line no-await-in-loop
    if (row) await S.run('UPDATE "OutreachContactChannel" SET optIn = \'opted_in\', optInAt = ?, optInSource = ?, optInEvidence = ?, optOutAt = NULL, optOutReason = NULL WHERE id = ?', now, 'admin', why, row.id); // eslint-disable-line no-await-in-loop
    else await S.run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optInAt, optInSource, optInEvidence) VALUES (?,?,?,?,?,?,?,?)', S.newId('occ'), contactId, ch, ch === 'email' ? contact.email : contact.phoneE164, 'opted_in', now, 'admin', why); // eslint-disable-line no-await-in-loop
    await recordEvent({ contactId, hash, channel: ch, action: 'opt_in', source: 'admin', evidence: why, byUserId: by.id, at: now }); // eslint-disable-line no-await-in-loop
    changed.push(ch);
  }
  if (changed.length) {
    const stillOut = (await channelRows(contactId)).some((r) => r.optIn === 'opted_out');
    if (!stillOut) await S.run('UPDATE "OutreachContact" SET unsubscribedAt = NULL, updatedAt = ? WHERE id = ?', now, contactId);
    await logAudit({ userId: by.id, actorName: by.name, action: 'Outreach contact opted in again', entity: 'OutreachContact', entityId: contactId, reason: why, toValue: `channels: ${changed.join(', ')}` });
  }
  return { changed };
}

// A person ticked the consent box on one of OUR capture forms (source 'form'): record "yes" on the channels they chose.
// Evidence = the form name + the consent text version. It NEVER lifts an opt-out or a do-not-contact entry (only an Admin's own "Opted in again" does),
// and it leaves a channel that is already allowed exactly as it is. A channel the person has no address for is skipped.
// -> { allowed: [channels now allowed], kept: [channels left opted out], skipped: [channels with no address or no row] }
async function optInFromForm(contactId, channels, { evidence, textVersion } = {}) {
  const contact = await getContactRow(contactId);
  if (!contact || contact.status !== 'active') return { allowed: [], kept: [], skipped: [] };
  const rows = await channelRows(contactId);
  const now = Date.now();
  const out = { allowed: [], kept: [], skipped: [] };
  for (const ch of [...new Set(channels || [])].filter((c) => CHANNELS.includes(c))) {
    const hash = hashFor(contact, ch);
    const row = rows.find((r) => r.channel === ch);
    if (!hash || !row) { out.skipped.push(ch); continue; } // eslint-disable-line no-continue
    if (row.optIn === 'opted_out' || await isSuppressedHash(hash, ch) || await isSuppressedHash(hash, '*')) { out.kept.push(ch); continue; } // eslint-disable-line no-continue
    if (row.optIn === 'opted_in') { out.allowed.push(ch); continue; } // eslint-disable-line no-continue
    await S.run('UPDATE "OutreachContactChannel" SET optIn = \'opted_in\', optInAt = ?, optInSource = ?, optInEvidence = ?, optOutAt = NULL, optOutReason = NULL WHERE id = ?', now, 'form', S.clip(evidence, 400) || null, row.id);
    await recordEvent({ contactId, hash, channel: ch, action: 'opt_in', source: 'form', evidence, textVersion, byUserId: null, at: now });
    out.allowed.push(ch);
  }
  if (out.allowed.length) await S.run('UPDATE "OutreachContact" SET consentSource = COALESCE(consentSource, ?), consentAt = COALESCE(consentAt, ?), updatedAt = ? WHERE id = ?', 'form', now, now, contactId);
  return out;
}

// the history of one contact (newest first). No address in it, only what happened.
async function history(contactId) {
  const rows = await S.q('SELECT id, channel, action, source, evidence, byUserId, at FROM "OutreachConsentEvent" WHERE contactId = ? ORDER BY at DESC, id DESC LIMIT 100', contactId);
  return rows.map((r) => ({ id: r.id, channel: r.channel, action: r.action, source: r.source, evidence: r.evidence, byUserId: r.byUserId, at: S.iso(r.at) }));
}

// Can this contact be messaged on this channel RIGHT NOW (the data layer's own check, used by the adapters too)?
async function canMessage(contactId, channel) {
  const c = await getContactRow(contactId);
  if (!c || c.status !== 'active') return { ok: false, reason: 'gone' };
  const row = (await channelRows(contactId)).find((r) => r.channel === channel);
  const hash = hashFor(c, channel);
  if (!hash) return { ok: false, reason: 'no_address' };
  if (await isSuppressedHash(hash, channel)) return { ok: false, reason: 'suppressed' };
  if (!row || row.optIn !== 'opted_in') return { ok: false, reason: row && row.optIn === 'opted_out' ? 'opted_out' : 'no_opt_in' };
  if (row.health !== 'ok') return { ok: false, reason: 'bad_address' };
  return { ok: true, contactType: c.contactType };
}

// DPDP erasure (Admin): the person's details are wiped; only hashes stay so they are never contacted again.
async function erase(contactId, { by, reason }) {
  const c = await getContactRow(contactId);
  if (!c || c.status !== 'active') return { error: 'This person was not found.', status: 404 };
  const now = Date.now();
  for (const ch of CHANNELS) {
    const hash = hashFor(c, ch);
    if (hash) {
      await suppress(hash, '*', 'erased', 'erasure'); // eslint-disable-line no-await-in-loop
      await recordEvent({ contactId, hash, channel: ch, action: 'erasure', source: 'admin', evidence: S.clip(reason, 300) || 'Removed at their request', byUserId: by && by.id, at: now }); // eslint-disable-line no-await-in-loop
    }
  }
  await S.run('DELETE FROM "OutreachContactChannel" WHERE contactId = ?', contactId);
  await S.run('DELETE FROM "OutreachContactTag" WHERE contactId = ?', contactId);
  await S.run('UPDATE "OutreachContact" SET status = \'deleted\', deletedAt = ?, updatedAt = ?, name = NULL, phoneE164 = NULL, email = NULL, phoneKey = NULL, emailKey = NULL, company = NULL, city = NULL, skills = NULL, experience = NULL WHERE id = ?', now, now, contactId);
  if (by) await logAudit({ userId: by.id, actorName: by.name, action: 'Outreach contact erased (do-not-contact marker kept)', entity: 'OutreachContact', entityId: contactId, reason: S.clip(reason, 300) });
  return { ok: true };
}

module.exports = { CHANNELS, CHANNEL_WORDS, OPT_OUT_REASONS, hashFor, recordEvent, suppress, isSuppressedHash, optOut, optIn, optInFromForm, history, canMessage, erase, getContactRow, channelRows };
