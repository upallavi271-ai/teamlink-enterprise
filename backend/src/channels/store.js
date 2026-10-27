// ---------------------------------------------------------------------------
// COMMUNICATION RECORDS — what the adapter layer knows about every WhatsApp / SMS message beyond the
// ordinary message log (CandidateMessage / ConversationMessage, which stay the source for the timelines):
// which PROVIDER carried it, the status history (queued -> sent -> delivered -> read / failed), retries,
// who sent it, the attachment names, an optional cost estimate.
//
// Stored as AppSetting rows (no migration):
//   comm.m.<yyyymmdd>.<id>   the record (JSON)        comm.ref.<providerRef>  -> the record key
// Message BODIES are not kept here (the message log already has them).
//
// If the volume ever grows, swap this file for a CommMessage table (docs/communication/ARCHITECTURE.md,
// "Migration path"). Every caller goes through these functions only.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const P = 'comm.m.';
const REF = 'comm.ref.';
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
const dayKey = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const parse = (row) => { try { return row ? JSON.parse(row.value) : null; } catch { return null; } };

async function put(key, rec) {
  const v = JSON.stringify(rec);
  // SQLite is shared with the server and the QR worker: a busy database is retried, not lost
  for (let i = 0; ; i += 1) {
    try { await prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } }); return; } catch (e) {
      if (i >= 3) throw e;
      await new Promise((r) => { setTimeout(r, 300 * (i + 1)); });
    }
  }
}

// rec: { channel, provider, direction, to, personType, personId, personName, senderUserId, senderName, template, purpose,
//        status, error, providerRef, jobId, attachments, retries, cost, masked }
async function record(rec) {
  const id = newId();
  const at = new Date();
  const status = rec.status || 'sent';
  const row = {
    id, at: at.toISOString(), direction: rec.direction || 'OUT', channel: rec.channel, provider: rec.provider || null,
    to: rec.to || null, personType: rec.personType || null, personId: rec.personId || null, personName: rec.personName || null,
    senderUserId: rec.senderUserId || null, senderName: rec.senderName || null, template: rec.template || null, purpose: rec.purpose || null,
    status, error: rec.error ? String(rec.error).slice(0, 400) : null, providerRef: rec.providerRef || null, jobId: rec.jobId || null,
    attachments: rec.attachments || [], retries: rec.retries || 0, cost: rec.cost == null ? null : rec.cost, masked: !!rec.masked,
    history: [{ status, at: at.toISOString(), detail: rec.detail || null }],
    ...(rec.numberId ? { numberId: rec.numberId, numberLabel: rec.numberLabel || null } : {}),
    ...(rec.module ? { module: rec.module } : {}), ...(rec.preview ? { preview: String(rec.preview).slice(0, 160) } : {}),
    ...(rec.dltTemplateId ? { dltTemplateId: String(rec.dltTemplateId).slice(0, 60) } : {}), ...(rec.senderIdUsed ? { senderIdUsed: String(rec.senderIdUsed).slice(0, 30) } : {}),
    ...(rec.unknown ? { unknown: true } : {}),
    ...(rec.ackId ? { ackId: String(rec.ackId).slice(0, 80) } : {}),
  };
  const key = `${P}${dayKey(at)}.${id}`;
  try {
    await put(key, row);
    if (row.providerRef) await put(`${REF}${row.providerRef}`, { k: key });
    // a delivery report may name the ackid instead of the message id (SMS Push Platform): both find the record
    if (row.ackId && row.ackId !== row.providerRef) await put(`${REF}${row.ackId}`, { k: key });
  } catch (e) { console.error('[comm] record:', e.message); } // eslint-disable-line no-console
  return { ...row, _key: key };
}

async function byRef(ref) {
  if (!ref) return null;
  const idx = parse(await prisma.appSetting.findUnique({ where: { key: `${REF}${ref}` } }).catch(() => null));
  if (!idx || !idx.k) return null;
  const rec = parse(await prisma.appSetting.findUnique({ where: { key: idx.k } }).catch(() => null));
  return rec ? { ...rec, _key: idx.k } : null;
}

// Moves a record on. A status never goes backwards; "failed" always wins. Returns the record or null.
async function applyStatus(ref, status, { at = new Date(), error = null, detail = null, extra = null } = {}) {
  const rec = await byRef(ref);
  if (!rec) return null;
  const s = String(status || '').toLowerCase();
  if (!['queued', 'sent', 'delivered', 'read', 'failed'].includes(s)) return rec;
  // the same report again (a provider retry) changes nothing and adds no history line
  if (s === rec.status && s !== 'queued') return rec;
  if (s !== 'failed' && rec.status === 'failed') return rec;
  if (s !== 'failed' && (RANK[rec.status] || 0) >= RANK[s] && !(rec.status === 'queued' && s === 'queued')) return rec;
  rec.status = s;
  if (s === 'failed') rec.error = String(error || detail || 'The provider reported the message as not delivered').slice(0, 400);
  rec.history.push({ status: s, at: new Date(at).toISOString(), detail: detail || (s === 'failed' ? rec.error : null) });
  if (extra && typeof extra === 'object') Object.assign(rec, extra);
  const key = rec._key; delete rec._key;
  await put(key, rec).catch(() => {});
  return { ...rec, _key: key };
}

// Later the provider gives a second id (the QR worker: WhatsApp's id for our queue id) - both find the record.
async function alias(ref, newRef) {
  const rec = await byRef(ref);
  if (!rec || !newRef) return;
  await put(`${REF}${newRef}`, { k: rec._key }).catch(() => {});
}
async function patch(ref, fields) {
  const rec = await byRef(ref);
  if (!rec) return null;
  const key = rec._key; delete rec._key;
  Object.assign(rec, fields);
  await put(key, rec).catch(() => {});
  return { ...rec, _key: key };
}

function daysBetween(from, to) {
  // at most the 120 most recent days of the range
  const out = [];
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(0, 0, 0, 0);
  for (let d = new Date(end); d >= start && out.length < 120; d.setDate(d.getDate() - 1)) out.push(dayKey(d));
  return out;
}

// filters: { from, to, channel, provider, status, senderId, personId, q, direction }
async function list(filters = {}, { limit = 2000 } = {}) {
  const to = filters.to ? new Date(filters.to) : new Date();
  const from = filters.from ? new Date(filters.from) : new Date(Date.now() - 6 * 86400000);
  let rows = [];
  for (const d of daysBetween(from, to)) {
    // eslint-disable-next-line no-await-in-loop
    const got = await prisma.appSetting.findMany({ where: { key: { startsWith: `${P}${d}.` } }, select: { value: true } }).catch(() => []);
    rows.push(...got.map(parse).filter(Boolean));
  }
  const q = String(filters.q || '').trim().toLowerCase();
  rows = rows.filter((r) => (!filters.channel || r.channel === filters.channel)
    && (!filters.provider || r.provider === filters.provider)
    && (!filters.status || r.status === String(filters.status).toLowerCase())
    && (!filters.senderId || r.senderUserId === filters.senderId)
    && (!filters.personId || r.personId === filters.personId)
    && (!filters.direction || r.direction === filters.direction)
    && (!q || `${r.personName || ''} ${r.senderName || ''} ${r.template || ''} ${r.purpose || ''}`.toLowerCase().includes(q)));
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return rows.slice(0, limit);
}

// Sent today / this hour / failed / last error, per provider (from the records).
async function usage(provider, now = new Date()) {
  const rows = await list({ provider, from: now, to: now }, { limit: 20000 });
  const out = rows.filter((r) => r.direction === 'OUT');
  const hourAgo = now.getTime() - 3600000;
  const counted = (r) => r.status !== 'failed';
  const failed = out.filter((r) => r.status === 'failed');
  return {
    today: out.filter(counted).length,
    hour: out.filter((r) => counted(r) && new Date(r.at).getTime() >= hourAgo).length,
    queued: out.filter((r) => r.status === 'queued').length,
    failed: failed.length,
    lastError: failed.length ? failed[0].error : null,
    inbound: rows.filter((r) => r.direction === 'IN').length,
  };
}

async function recordInbound(info) {
  return record({ direction: 'IN', channel: info.channel, provider: info.provider || null, to: info.from, personType: info.personType, personId: info.personId, personName: info.personName, status: 'delivered', providerRef: info.id || null, detail: 'Reply received', numberId: info.numberId || null });
}

module.exports = { record, byRef, applyStatus, alias, patch, list, usage, recordInbound, dayKey, RANK };
