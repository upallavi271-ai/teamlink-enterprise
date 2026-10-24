// ---------------------------------------------------------------------------
// THE MESSAGE LOG (quick wins, T1): every message the Outreach queue made, for one campaign or for all the campaigns a login may see.
//   person (phone / email MASKED for the roles that are masked), channel, status, the reason in words, the time.
//   filters   status (Waiting / Sent / Rehearsed / Delivered / Failed / Skipped / Cancelled, or a raw status), campaign, channel, date range (India days),
//             search (a name or a campaign name; an unmasked login may also search an email / phone)
//   paging    pageSize up to 200
//   CSV       the same filters, same masking, only for the roles that may export (Admin; Manager / Asst Manager). A cell that starts with
//             = @ + - (other than a plain number) gets a leading apostrophe so Excel never runs it as a formula. The route audits the download
//             (who, filters, how many rows: no phone, no email).
// Reads OutreachMessage only (the Phase 3 tables). The server decides what a login sees: only campaigns it may see (campaigns.canSee).
// 2026-10-17: channels email | whatsapp | sms | call (a CALL row is a call task: "To call", "Called", "No answer"); a "Read" filter (readAt, when a provider told us);
// every row carries readAt, an error code and the plain error words (Live Message Logs in Campaigns).
// ---------------------------------------------------------------------------
const S = require('./store');
const Quiet = require('./quiet');
const A = require('./access');
const Sup = require('./suppress');
const core = require('../utils/messagingCore');

const GROUPS = {
  queued: ['queued', 'sending'], sent: ['sent'], rehearsed: ['test_captured'], delivered: ['delivered'],
  failed: ['failed', 'bounced', 'complained', 'unknown'], skipped: ['skipped'], cancelled: ['cancelled'],
};
const GROUP_WORDS = { queued: 'Waiting', sent: 'Sent', rehearsed: 'Rehearsed (nothing really sent)', delivered: 'Delivered', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };
const RAW_WORDS = {
  queued: 'Waiting', sending: 'Sending now', sent: 'Sent', test_captured: 'Rehearsed (nothing really sent)', delivered: 'Delivered', failed: 'Failed', bounced: 'Bounced (address does not exist)',
  complained: 'Marked as spam', skipped: 'Skipped', cancelled: 'Cancelled', unknown: 'Not sure (will not be sent again)',
};
const groupOfStatus = (st) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(st)) || 'failed';
const AT = 'COALESCE(m.sentAt, m.failedAt, m.deliveredAt, m.queuedAt)';
const ph = (n) => new Array(n).fill('?').join(',');
const dayMs = (v, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? Date.parse(`${v}T${end ? '23:59:59.999' : '00:00:00'}+05:30`) : null);

// the WHERE (and its parameters) for these filters. `skip` leaves one filter out (used for the counts next to the status buttons).
async function filterSql(user, f, skip = []) {
  const Camp = require('./campaigns'); // eslint-disable-line global-require
  const vis = await Camp.visibleRows(user);
  let ids = vis.map((r) => r.id);
  if (f.campaignId) ids = ids.filter((id) => id === String(f.campaignId));
  if (Array.isArray(f.campaignIds)) { const set = new Set(f.campaignIds.map(String)); ids = ids.filter((id) => set.has(id)); } // a master campaign = several channel rows
  if (!ids.length) return { none: true };
  const where = [`m.campaignId IN (${ph(ids.length)})`]; const ps = [...ids];
  const masked = A.masked(user);
  if (!skip.includes('status') && f.status) {
    const st = String(f.status);
    if (st === 'read') where.push('m.readAt IS NOT NULL'); // only when a provider told us it was read
    else {
      const list = GROUPS[st] || (RAW_WORDS[st] ? [st] : null);
      if (!list) return { none: true };
      where.push(`m.status IN (${ph(list.length)})`); ps.push(...list);
    }
  }
  if (f.reason) { where.push('m.reason = ?'); ps.push(String(f.reason)); }
  if (f.channel && ['email', 'whatsapp', 'sms', 'call'].includes(String(f.channel))) { where.push('m.channel = ?'); ps.push(String(f.channel)); }
  const from = dayMs(f.from, false); const to = dayMs(f.to, true);
  if (from != null) { where.push(`${AT} >= ?`); ps.push(from); }
  if (to != null) { where.push(`${AT} <= ?`); ps.push(to); }
  const needle = String(f.q || '').trim().slice(0, 80).toLowerCase();
  if (needle) {
    const like = `%${needle.replace(/[%_]/g, '')}%`;
    const parts = ['LOWER(c.name) LIKE ?', 'LOWER(k.name) LIKE ?']; const pp = [like, like];
    // a masked login may not find a person by phone or email (it would reveal the hidden value)
    if (!masked) {
      parts.push('LOWER(c.email) LIKE ?'); pp.push(like);
      const digits = needle.replace(/\D/g, '');
      if (digits.length >= 4) { parts.push('c.phoneKey LIKE ?'); pp.push(`%${digits.slice(-10)}%`); }
    }
    where.push(`(${parts.join(' OR ')})`); ps.push(...pp);
  }
  return { where: where.join(' AND '), ps };
}
const FROM = 'FROM "OutreachMessage" m JOIN "OutreachCampaign" k ON k.id = m.campaignId LEFT JOIN "OutreachContact" c ON c.id = m.contactId';

const FAILISH = ['failed', 'bounced', 'complained', 'unknown', 'skipped', 'cancelled'];
// the error code (a provider's number when its words had one, else our reason code) and the plain words
function errorOf(m) {
  if (!FAILISH.includes(m.status) && !m.reason) return { code: '', words: '' };
  const raw = S.clip(m.error, 160);
  const num = (/\b(\d{3,6})\b/.exec(raw) || [])[1];
  const code = num || m.reason || '';
  const base = m.reason ? (Sup.REASON_WORDS[m.reason] || m.reason) : '';
  const extra = raw && raw !== base && !(base && raw.toLowerCase() === base.toLowerCase()) ? raw : '';
  return { code, words: [base, extra].filter(Boolean).join(' — ') };
}
const CALL_WORDS = { queued: 'To call', sent: 'Called', failed: 'No answer', skipped: 'Skipped', cancelled: 'Cancelled' };
function rowView(m, masked, quiet) {
  const grp = groupOfStatus(m.status);
  const err = errorOf(m);
  const email = m.email ? (masked ? core.maskEmail(m.email) || '' : m.email) : '';
  const phone = m.phoneE164 ? (masked ? core.maskMobile(m.phoneE164) : `+${m.phoneE164}`) : '';
  const when = m.at || null;
  return {
    id: m.id, campaignId: m.campaignId, campaignName: m.campaignName, name: m.name || '(removed)', email, phone, contact: m.channel === 'email' ? email : phone, channel: m.channel,
    status: m.status, statusKey: grp, statusWords: m.channel === 'call' ? (CALL_WORDS[m.status] || RAW_WORDS[m.status] || m.status) : (RAW_WORDS[m.status] || m.status), reason: m.reason || null, errorCode: err.code, errorWords: err.words, readAt: S.iso(m.readAt), repliedAt: S.iso(m.repliedAt), callMinutes: m.callMinutes == null ? null : S.num(m.callMinutes), reasonWords: m.reason ? (Sup.REASON_WORDS[m.reason] || m.reason) : ((m.status === 'queued' && quiet && Quiet.state(quiet.now, quiet.q, m.campaignType).active && S.num(m.nextRunAt) <= quiet.now + 1) ? Quiet.state(quiet.now, quiet.q, m.campaignType).words : null),
    attempts: S.num(m.attempts), at: S.iso(when), sentAt: S.iso(m.sentAt), deliveredAt: S.iso(m.deliveredAt), clickedAt: S.iso(m.firstClickAt), failedAt: S.iso(m.failedAt), error: m.error ? S.clip(m.error, 120) : null,
  };
}
const SELECT = `SELECT m.id, m.campaignId, k.name AS campaignName, m.channel, m.status, m.reason, m.attempts, m.sentAt, m.deliveredAt, m.readAt, m.repliedAt, m.callMinutes, m.firstClickAt, m.failedAt, m.error, m.nextRunAt, k.type AS campaignType, ${AT} AS at, c.name, c.email, c.phoneE164`;

// f: { campaignId, status, reason, channel, from, to, q, page, pageSize }
async function list(user, f = {}) {
  try { await require('./v3schema').ensure(); } catch { /* the columns are made on the first request too */ } // eslint-disable-line global-require
  const masked = A.masked(user);
  const pg = Math.max(1, Math.floor(Number(f.page)) || 1); const sz = Math.min(200, Math.max(1, Math.floor(Number(f.pageSize)) || 25));
  const empty = { total: 0, page: pg, pageSize: sz, masked, canExport: A.mayExportLog(user), messages: [], facets: {} };
  const w = await filterSql(user, f);
  if (w.none) return empty;
  const quiet = { now: Date.now(), q: (await S.settings()).quietHours };
  const total = S.num((await S.q(`SELECT COUNT(*) n ${FROM} WHERE ${w.where}`, ...w.ps))[0].n);
  const rows = await S.q(`${SELECT} ${FROM} WHERE ${w.where} ORDER BY at DESC, m.id DESC LIMIT ? OFFSET ?`, ...w.ps, sz, (pg - 1) * sz);
  // the number next to each status button: everything the OTHER filters match
  const w2 = await filterSql(user, f, ['status']);
  const facets = {};
  Object.keys(GROUPS).forEach((g) => { facets[g] = 0; });
  facets.read = S.num((await S.q(`SELECT COUNT(*) n ${FROM} WHERE ${w2.where} AND m.readAt IS NOT NULL`, ...w2.ps))[0].n);
  (await S.q(`SELECT m.status st, COUNT(*) n ${FROM} WHERE ${w2.where} GROUP BY m.status`, ...w2.ps)).forEach((r) => { facets[groupOfStatus(r.st)] += S.num(r.n); });
  return { total, page: pg, pageSize: sz, masked, canExport: A.mayExportLog(user), messages: rows.map((r) => rowView(r, masked, quiet)), facets };
}

// campaigns the login may filter by (for the "Which campaign" picker): id, name, and how many messages each has
async function campaignChoices(user, q) {
  const Camp = require('./campaigns'); // eslint-disable-line global-require
  const vis = await Camp.visibleRows(user);
  const needle = String(q || '').trim().toLowerCase();
  const rows = vis.filter((r) => !needle || String(r.name).toLowerCase().includes(needle)).slice(0, 60);
  const n = {};
  if (rows.length) (await S.q(`SELECT campaignId, COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(rows.length)}) GROUP BY campaignId`, ...rows.map((r) => r.id))).forEach((r) => { n[r.campaignId] = S.num(r.n); });
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, messages: n[r.id] || 0 }));
}

// ---- CSV -------------------------------------------------------------------------------------------------
const MAX_CSV = 50000;
function safeCell(v) {
  let t = String(v == null ? '' : v);
  if (/^[=@\t\r]/.test(t) || (/^[+-]/.test(t) && !/^[+-]?\d+(\.\d+)?$/.test(t))) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}
const ist = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : '');
async function csv(user, f = {}) {
  try { await require('./v3schema').ensure(); } catch { /* ok */ } // eslint-disable-line global-require
  if (!A.mayExportLog(user)) return { error: 'Only an Admin or a Manager can download the message log.', status: 403 };
  const w = await filterSql(user, f);
  const masked = A.masked(user);
  const lines = [['Person', 'Contact', 'Channel', 'What happened', 'Why', 'Campaign', 'When (India time)'].map(safeCell).join(',')];
  if (f.detailed) lines[0] = ['Recipient', 'Status', 'Sent/Started At', 'Delivered At', 'Read At', 'Error Code', 'Error Description', 'Name'].map(safeCell).join(',');
  let count = 0;
  if (!w.none) {
    for (let off = 0; off < MAX_CSV; off += 500) {
      const rows = await S.q(`${SELECT} ${FROM} WHERE ${w.where} ORDER BY at DESC, m.id DESC LIMIT 500 OFFSET ?`, ...w.ps, off); // eslint-disable-line no-await-in-loop
      rows.forEach((r) => {
        const v = rowView(r, masked);
        lines.push((f.detailed ? [v.contact, v.statusWords, ist(v.sentAt || v.at), ist(v.deliveredAt), ist(v.readAt), v.errorCode, v.errorWords, v.name] : [v.name, v.contact, v.channel, v.statusWords, v.reasonWords || v.error || '', v.campaignName, ist(v.at)]).map(safeCell).join(',')); count += 1;
      });
      if (rows.length < 500) break;
    }
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count, truncated: count >= MAX_CSV };
}
// a short, PII-free sentence of the filters for the audit row
function filterWords(f = {}) {
  const bits = [];
  ['status', 'channel', 'from', 'to'].forEach((k) => { if (f[k]) bits.push(`${k} ${S.clip(f[k], 20)}`); });
  if (f.campaignId) bits.push(`campaign ${S.clip(f.campaignId, 30)}`);
  if (f.q) bits.push('search used');
  return bits.join('; ') || 'no filters';
}

module.exports = { list, csv, campaignChoices, filterWords, safeCell, errorOf, filterSql, rowView, SELECT, FROM, GROUPS, GROUP_WORDS, RAW_WORDS, groupOfStatus };
