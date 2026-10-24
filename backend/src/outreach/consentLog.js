// ---------------------------------------------------------------------------
// THE CONSENT LOG (Omni-Channel > Settings > Consent log): a read-only, searchable list of every opt-in / opt-out / unsubscribe / STOP event,
// straight from the append-only OutreachConsentEvent history. Nothing can be deleted or changed from here.
//   who      the login that did it (an Admin who opted a person in again ...) or "The person themselves" for an unsubscribe link / a STOP reply
//   when     India time on the screen
//   channel  Email / WhatsApp / SMS      source  where it came from (import, unsubscribe link, STOP reply, screen, admin ...)      why  the words saved with it
//   person   the contact's name; phone / email masked for the masked roles (the event itself keeps only a hash, never the address)
// Who sees it: Admin (Settings is Admin only). Download CSV: Admin only, and every download is audited by the route (filters + row count, no phone, no email).
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const C = require('./consent');
const core = require('../utils/messagingCore');
const prisma = require('../db');

const ACTIONS = {
  opt_in: 'Opted in', opt_out: 'Opted out', unsubscribe: 'Unsubscribed (link)', stop: 'Replied STOP', erasure: 'Removed at their request',
};
const ph = (n) => new Array(n).fill('?').join(',');
const dayMs = (v, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? Date.parse(`${v}T${end ? '23:59:59.999' : '00:00:00'}+05:30`) : null);
const CH_WORDS = C.CHANNEL_WORDS;
const SOURCE_WORDS = {
  unsubscribe_link: 'Unsubscribe link', stop_reply: 'STOP reply', admin: 'An Admin', manual: 'The team (screen)', screen: 'The team (screen)', complaint: 'Spam complaint',
  hard_bounce: 'Address does not exist', import_flag: 'Import file said no', import_declared: 'Import (permission ticked)', suppression: 'Do-not-contact list', erasure: 'Erasure', legacy_stop_list: 'Old STOP list',
};

// the one word for an event (a STOP / an unsubscribe get their own word)
function actionKey(r) {
  if (r.action === 'opt_out' && (r.source === 'unsubscribe_link')) return 'unsubscribe';
  if (r.action === 'opt_out' && (r.source === 'stop_reply')) return 'stop';
  return r.action;
}
// the WHERE for the filters. f: { q, action, channel, source, type ('promo'|'internal'), from, to }
function where(f, masked) {
  const w = ['1 = 1']; const p = [];
  if (f.channel && C.CHANNELS.includes(String(f.channel))) { w.push('e.channel = ?'); p.push(String(f.channel)); }
  if (f.action) {
    const a = String(f.action);
    if (a === 'unsubscribe') { w.push("e.action = 'opt_out' AND e.source = 'unsubscribe_link'"); } else if (a === 'stop') { w.push("e.action = 'opt_out' AND e.source = 'stop_reply'"); } else if (['opt_in', 'opt_out', 'erasure'].includes(a)) { w.push('e.action = ?'); p.push(a); } else w.push('0 = 1');
  }
  if (f.source) { w.push('e.source = ?'); p.push(S.clip(f.source, 60)); }
  if (f.type === 'internal') w.push("c.contactType = 'internal'");
  else if (f.type === 'promo') w.push("c.contactType = 'candidate_lead'");
  const from = dayMs(f.from, false); const to = dayMs(f.to, true);
  if (from != null) { w.push('e.at >= ?'); p.push(from); }
  if (to != null) { w.push('e.at <= ?'); p.push(to); }
  const t = String(f.q || '').trim().slice(0, 80).toLowerCase();
  if (t) {
    const like = `%${t.replace(/[%_]/g, '')}%`;
    const parts = ['LOWER(c.name) LIKE ?', 'LOWER(e.evidence) LIKE ?', 'LOWER(e.source) LIKE ?']; const ps = [like, like, like];
    // a masked login may not find a person by phone or email (it would reveal the hidden value)
    if (!masked) { parts.push('LOWER(c.email) LIKE ?'); ps.push(like); const digits = t.replace(/\D/g, ''); if (digits.length >= 4) { parts.push('c.phoneKey LIKE ?'); ps.push(`%${digits.slice(-10)}%`); } }
    w.push(`(${parts.join(' OR ')})`); p.push(...ps);
  }
  return { sql: w.join(' AND '), params: p };
}
const FROM = 'FROM "OutreachConsentEvent" e LEFT JOIN "OutreachContact" c ON c.id = e.contactId';
const SELECT = 'SELECT e.id, e.contactId, e.channel, e.action, e.source, e.evidence, e.byUserId, e.at, c.name, c.email, c.phoneE164, c.contactType, c.status AS contactStatus';

async function namesOf(ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return out;
  try { (await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).forEach((u) => out.set(u.id, u.name)); } catch { /* names are a courtesy */ }
  return out;
}
function rowView(r, masked, names) {
  const key = actionKey(r);
  const erased = r.contactStatus === 'deleted' || !r.name;
  const email = r.email ? (masked ? core.maskEmail(r.email) || '' : r.email) : '';
  const phone = r.phoneE164 ? (masked ? core.maskMobile(r.phoneE164) : `+${r.phoneE164}`) : '';
  return {
    id: r.id, at: S.iso(r.at), channel: r.channel, channelWords: CH_WORDS[r.channel] || r.channel, action: key, actionWords: ACTIONS[key] || key,
    who: r.byUserId ? (names.get(r.byUserId) || 'A team member') : 'The person themselves', source: r.source || '', sourceWords: SOURCE_WORDS[r.source] || r.source || '', why: r.evidence || '',
    name: erased ? '(removed)' : r.name, contact: r.channel === 'email' ? email : phone, kind: r.contactType === 'internal' ? 'Staff' : 'Candidate contact',
  };
}
function gate(user) { return A.seesSettings(user); }

async function list(user, f = {}) {
  if (!gate(user)) return { error: 'Only an Admin can open the consent log.', status: 403 };
  const masked = A.masked(user);
  const pg = Math.max(1, Math.floor(Number(f.page)) || 1); const sz = Math.min(200, Math.max(5, Math.floor(Number(f.pageSize)) || 50));
  const w = where(f, masked);
  const total = S.num((await S.q(`SELECT COUNT(*) n ${FROM} WHERE ${w.sql}`, ...w.params))[0].n);
  const rows = await S.q(`${SELECT} ${FROM} WHERE ${w.sql} ORDER BY e.at DESC, e.id DESC LIMIT ? OFFSET ?`, ...w.params, sz, (pg - 1) * sz);
  const names = await namesOf(rows.map((r) => r.byUserId));
  // counts by kind of event, for the filters (everything the OTHER filters match)
  const w2 = where({ ...f, action: undefined }, masked);
  const counts = { opt_in: 0, opt_out: 0, unsubscribe: 0, stop: 0, erasure: 0 };
  (await S.q(`SELECT e.action, e.source, COUNT(*) n ${FROM} WHERE ${w2.sql} GROUP BY e.action, e.source`, ...w2.params)).forEach((r) => { counts[actionKey(r)] = (counts[actionKey(r)] || 0) + S.num(r.n); });
  return { total, page: pg, pageSize: sz, masked, canExport: A.mayExportConsent(user), counts, events: rows.map((r) => rowView(r, masked, names)) };
}

const MAX_CSV = 50000;
const ist = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : '');
async function csv(user, f = {}) {
  if (!A.mayExportConsent(user)) return { error: 'Only an Admin can download the consent log.', status: 403 };
  const { safeCell } = require('./messageLog'); // eslint-disable-line global-require
  const masked = A.masked(user);
  const w = where(f, masked);
  const lines = [['When (India time)', 'What happened', 'Channel', 'Person', 'Contact', 'Kind', 'Who', 'Source', 'Why'].map(safeCell).join(',')];
  let count = 0;
  for (let off = 0; off < MAX_CSV; off += 500) {
    const rows = await S.q(`${SELECT} ${FROM} WHERE ${w.sql} ORDER BY e.at DESC, e.id DESC LIMIT 500 OFFSET ?`, ...w.params, off); // eslint-disable-line no-await-in-loop
    const names = await namesOf(rows.map((r) => r.byUserId)); // eslint-disable-line no-await-in-loop
    rows.forEach((r) => { const v = rowView(r, masked, names); lines.push([ist(v.at), v.actionWords, v.channelWords, v.name, v.contact, v.kind, v.who, v.sourceWords, v.why].map(safeCell).join(',')); count += 1; });
    if (rows.length < 500) break;
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count, truncated: count >= MAX_CSV };
}
// a short, PII-free sentence of the filters for the audit row
function filterWords(f = {}) {
  const bits = [];
  ['action', 'channel', 'source', 'type', 'from', 'to'].forEach((k) => { if (f[k]) bits.push(`${k} ${S.clip(f[k], 20)}`); });
  if (f.q) bits.push('search used');
  return bits.join('; ') || 'no filters';
}

module.exports = { list, csv, filterWords, rowView, where, actionKey, ACTIONS };
