// ---------------------------------------------------------------------------
// FUNNEL EVENTS (OutreachEvent). One row per thing that happened to one message: sent, delivered, clicked, failed, skipped, replied now;
// applied / AI interview / qualified are written by Phase 4.
//   * eventKey = "<type>:<messageId>" is UNIQUE: recording the same event twice is one row (a retry, a double webhook, a second click).
//   * PII-free: ids, a type, a time and a tiny detail (a user-agent CLASS, a reason code). Never a name, phone, email or IP.
//   * INTERNAL campaigns write NO funnel events at all (record() returns { skipped: 'internal' }).
//   * 'replied' (2026-10-17): written by outreach/replies.js when a person answers a campaign message (it also sets OutreachMessage.repliedAt).
// ---------------------------------------------------------------------------
const S = require('./store');

const TYPES = ['sent', 'delivered', 'clicked', 'failed', 'skipped', 'applied', 'ai_interview_started', 'ai_interview_completed', 'qualified', 'replied'];

// msg: an OutreachMessage row; camp: its OutreachCampaign row (or { type }). Returns { created, skipped? }.
async function record(type, msg, camp, { detail = null, at = Date.now(), source = 'outreach' } = {}) {
  if (!TYPES.includes(type)) throw new S.OutreachError('bad_event', 'Unknown event type.');
  if (!msg || !camp) return { created: false, skipped: 'no_message' };
  if (camp.type === 'internal') return { created: false, skipped: 'internal' };
  const key = `${type}:${msg.id}`;
  const before = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE eventKey = ?', key))[0].n);
  if (before) return { created: false };
  try {
    await S.run('INSERT OR IGNORE INTO "OutreachEvent" (id, eventKey, type, contactId, campaignId, messageId, requirementId, channel, source, occurredAt, receivedAt, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      S.newId('oev'), key, type, msg.contactId, msg.campaignId, msg.id, msg.requirementId || camp.requirementId || null, msg.channel || 'email', source, at, Date.now(), detail ? JSON.stringify(detail).slice(0, 400) : null);
  } catch (e) { if (!/unique|constraint/i.test(String(e && e.message))) throw e; return { created: false }; }
  return { created: true };
}

// the numbers of one campaign's funnel (distinct messages per stage)
async function funnel(campaignId) {
  const rows = await S.q('SELECT type, COUNT(*) n FROM "OutreachEvent" WHERE campaignId = ? GROUP BY type', campaignId);
  const out = {};
  TYPES.forEach((t) => { out[t] = 0; });
  rows.forEach((r) => { out[r.type] = S.num(r.n); });
  return out;
}

// DELIVERY REPORTS from a provider (the WhatsApp / SMS webhooks call this; nothing here talks to a provider).
//   ev = { providerRef | messageId, event: 'delivered' | 'read' | 'failed', at, code, text }
//   A status never goes backwards (sent -> delivered; 'read' also fills the delivered time). 'failed' keeps the provider's code and words.
//   Idempotent. Returns { updated } | { unmatched } | { unchanged }. Needs OutreachMessage.readAt (v3schema.js) for 'read'.
async function applyDelivery(ev, now = Date.now()) {
  const ref = S.clip(ev && ev.providerRef, 200); const mid = S.clip(ev && ev.messageId, 80);
  const m = (ref ? (await S.q('SELECT * FROM "OutreachMessage" WHERE providerRef = ? LIMIT 1', ref))[0] : null) || (mid ? (await S.q('SELECT * FROM "OutreachMessage" WHERE id = ?', mid))[0] : null);
  if (!m) return { unmatched: true };
  const camp = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', m.campaignId))[0];
  const at = ev.at ? (typeof ev.at === 'number' ? ev.at : (Date.parse(ev.at) || now)) : now;
  if (ev.event === 'delivered' || ev.event === 'read') {
    if (['failed', 'bounced', 'complained', 'skipped', 'cancelled'].includes(m.status)) return { unchanged: true };
    if (ev.event === 'read') await S.run('UPDATE "OutreachMessage" SET readAt = COALESCE(readAt, ?), deliveredAt = COALESCE(deliveredAt, ?), status = CASE WHEN status IN (\'sent\',\'test_captured\') THEN \'delivered\' ELSE status END WHERE id = ?', at, at, m.id);
    else await S.run('UPDATE "OutreachMessage" SET deliveredAt = COALESCE(deliveredAt, ?), status = CASE WHEN status IN (\'sent\',\'test_captured\') THEN \'delivered\' ELSE status END WHERE id = ?', at, m.id);
    await record('delivered', m, camp, { at, source: 'provider' });
    return { updated: ev.event };
  }
  if (ev.event === 'failed') {
    if (['bounced', 'complained'].includes(m.status)) return { unchanged: true };
    const words = [ev.code ? `(${S.clip(ev.code, 20)})` : '', S.clip(ev.text, 160)].filter(Boolean).join(' ');
    await S.run('UPDATE "OutreachMessage" SET status = \'failed\', reason = COALESCE(reason, \'rejected\'), failedAt = ?, error = ? WHERE id = ? AND status NOT IN (\'skipped\',\'cancelled\')', at, words || null, m.id);
    await record('failed', m, camp, { at, source: 'provider', detail: { reason: 'rejected' } });
    return { updated: 'failed' };
  }
  return { unchanged: true };
}

module.exports = { record, funnel, applyDelivery, TYPES };
