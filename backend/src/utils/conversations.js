// ---------------------------------------------------------------------------
// CONVERSATIONS — one timeline per person across Call, Mail, WhatsApp and SMS, and the Inbox on top.
//
//   WHERE THE MESSAGES LIVE
//     candidate   CandidateMessage (already holds every sent mail / WhatsApp / SMS, call logs, WhatsApp
//                 replies "RECEIVED" and the automatic stage messages)
//     client /    ConversationMessage (new table; migration 20261010160000_omnichannel_inbox)
//     employee
//     one row per person in Conversation: unread count, who deals with it, done / open, preferred
//     channel, the "waiting for a reply" reminder. Both new tables are read / written with plain SQL
//     (works before and after `prisma generate`) and are detected: until the migration is applied
//     ready() is false, the Inbox says "being set up" and nothing else changes.
//
//   timeline(user, type, id)  the merged, time-ordered list, addresses MASKED for a viewer who may
//                              not see the number (utils/contactAccess.js)
//   inbox(user, query)         the Inbox: scoped like the follow-ups, filters with cascading counts
//   recordOut / recordIn       called by the senders / the webhooks / the mailbox reader
//   unreadCount(user)          the badge on the Follow-ups tab
//   setAwait / sweepWaiting    "if no reply by then …": a reminder on the follow-up (its due date), and
//                              a bell notification when nothing came
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const core = require('./messagingCore');
const access = require('./contactAccess');

const TYPES = { candidates: 'CANDIDATE', clients: 'CLIENT', employees: 'EMPLOYEE' };
const AUDIENCE_OF = { CANDIDATE: 'candidates', CLIENT: 'clients', EMPLOYEE: 'employees' };
const TYPE_WORD = { CANDIDATE: 'Candidate', CLIENT: 'Client', EMPLOYEE: 'Employee' };
const CHANNELS = ['Email', 'WhatsApp', 'SMS', 'Call'];
const IST = 'Asia/Kolkata';

const newId = () => `cv${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const toDate = (v) => (v == null ? null : (v instanceof Date ? v : new Date(typeof v === 'bigint' ? Number(v) : v)));
const ms = (v) => { const d = toDate(v); return d && !Number.isNaN(d.getTime()) ? d.getTime() : null; };
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const snippet = (s) => clip(String(s || '').replace(/\s+/g, ' ').trim(), 140);

// ---- the tables ---------------------------------------------------------------
let readyAt = 0;
let readyVal = false;
async function ready() {
  const age = Date.now() - readyAt;
  if (readyAt && age < (readyVal ? 60000 : 4000)) return readyVal;
  try {
    const t = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Conversation','ConversationMessage')");
    readyVal = t.length === 2;
  } catch { readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}
const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);

function threadOf(r) {
  if (!r) return null;
  return {
    id: r.id, personType: r.personType, personId: r.personId, personName: r.personName, department: r.department,
    ownerUserId: r.ownerUserId, ownerName: r.ownerName, lastMessageAt: toDate(r.lastMessageAt), lastChannel: r.lastChannel,
    lastDirection: r.lastDirection, lastSnippet: r.lastSnippet, lastInboundAt: toDate(r.lastInboundAt), unread: num(r.unread),
    doneAt: toDate(r.doneAt), doneByName: r.doneByName, preferredChannel: r.preferredChannel,
    awaitUntil: toDate(r.awaitUntil), awaitChannel: r.awaitChannel, awaitNext: r.awaitNext, awaitNotifiedAt: toDate(r.awaitNotifiedAt),
  };
}
async function getThread(type, id) {
  if (!(await ready())) return null;
  const rows = await q('SELECT * FROM "Conversation" WHERE "personType" = ? AND "personId" = ?', type, String(id));
  return threadOf(rows[0]);
}
async function getThreadById(cid) {
  if (!(await ready())) return null;
  const rows = await q('SELECT * FROM "Conversation" WHERE "id" = ?', String(cid));
  return threadOf(rows[0]);
}

// ---- who a person is ----------------------------------------------------------------
// name, department and the person who normally deals with them.
async function personInfo(type, id) {
  try {
    if (type === 'CANDIDATE') {
      const c = await prisma.candidate.findUnique({ where: { id: String(id) }, select: { id: true, name: true, email: true, phone: true } });
      if (!c) return null;
      const apps = await prisma.application.findMany({
        where: { candidateId: c.id }, orderBy: { updatedAt: 'desc' }, take: 3,
        select: { id: true, requirement: { select: { department: true, recruiterId: true, tlId: true } } },
      });
      const fu = await prisma.applicationFollowUp.findFirst({ where: { candidateId: c.id, completedAt: null, ownerUserId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { ownerUserId: true, ownerName: true } });
      const reqs = apps.map((a) => a.requirement).filter(Boolean);
      const dept = (reqs.find((r) => r.department) || {}).department || null;
      let ownerUserId = fu ? fu.ownerUserId : null;
      if (!ownerUserId) { const r = reqs.find((x) => x.recruiterId || x.tlId); ownerUserId = r ? (r.recruiterId || r.tlId) : null; }
      return { name: c.name, department: dept, ownerUserId, ownerName: fu ? fu.ownerName : null };
    }
    if (type === 'CLIENT') {
      const c = await prisma.client.findUnique({ where: { id: String(id) }, select: { id: true, name: true, ownerDepartment: true, bdeOwner: true, contactName: true } });
      if (!c) return null;
      const owner = c.bdeOwner ? await prisma.user.findFirst({ where: { name: c.bdeOwner, status: 'Active' }, select: { id: true, name: true } }) : null;
      return { name: c.contactName ? `${c.contactName} (${c.name})` : c.name, department: c.ownerDepartment || null, ownerUserId: owner ? owner.id : null, ownerName: owner ? owner.name : null };
    }
    const e = await prisma.employee.findUnique({ where: { id: String(id) }, select: { id: true, name: true, department: true } });
    return e ? { name: e.name, department: e.department || null, ownerUserId: null, ownerName: null } : null;
  } catch { return null; }
}

async function nameOfUser(userId) {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }).catch(() => null);
  return u ? u.name : null;
}

// Create the person's conversation row when it is not there yet; returns it.
async function ensureThread(type, id, extra = {}) {
  if (!(await ready())) return null;
  let t = await getThread(type, id);
  if (t) {
    // fill in what was unknown at the time
    const sets = []; const vals = [];
    if (!t.ownerUserId && extra.ownerUserId) { sets.push('"ownerUserId" = ?', '"ownerName" = ?'); vals.push(extra.ownerUserId, extra.ownerName || null); }
    if (!t.department && extra.department) { sets.push('"department" = ?'); vals.push(extra.department); }
    if (!t.personName && extra.name) { sets.push('"personName" = ?'); vals.push(extra.name); }
    if (sets.length) { await run(`UPDATE "Conversation" SET ${sets.join(', ')} WHERE "id" = ?`, ...vals, t.id); t = await getThread(type, id); }
    return t;
  }
  const info = extra.name ? extra : { ...(await personInfo(type, id) || {}), ...extra };
  const ownerName = info.ownerName || await nameOfUser(info.ownerUserId);
  const now = Date.now();
  await run(
    'INSERT OR IGNORE INTO "Conversation" ("id","personType","personId","personName","department","ownerUserId","ownerName","unread","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,0,?,?)',
    newId(), type, String(id), info.name || null, info.department || null, info.ownerUserId || null, ownerName || null, now, now,
  );
  return getThread(type, id);
}

// ---- writing a message --------------------------------------------------------------
function touchSql(direction) {
  return direction === 'IN'
    ? '"lastInboundAt" = ?, "unread" = "unread" + 1, "doneAt" = NULL, "doneByName" = NULL, "awaitUntil" = NULL, "awaitNotifiedAt" = NULL, '
    : '';
}

// A message we SENT (or a call we made / asked for). Candidates' rows are written by the caller into CandidateMessage;
// a client's / employee's row is written here.
async function recordOut(m) {
  if (!(await ready())) return null;
  const type = m.personType;
  const t = await ensureThread(type, m.personId, { name: m.personName, department: m.department, ownerUserId: m.ownerUserId });
  if (!t) return null;
  const at = ms(m.at) || Date.now();
  let messageId = null;
  if (type !== 'CANDIDATE') {
    messageId = newId();
    await run(
      'INSERT INTO "ConversationMessage" ("id","conversationId","personType","personId","channel","direction","subject","body","address","status","statusDetail","providerRef","mailMessageId","templateLabel","senderUserId","senderName","note","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      messageId, t.id, type, String(m.personId), m.channel, 'OUT', m.subject || null, clip(m.body, 8000) || null, m.address || null, m.status || 'SENT',
      clip(m.statusDetail, 500) || null, m.providerRef || null, m.mailMessageId || (m.channel === 'Email' ? m.providerRef || null : null), m.templateLabel || null,
      m.senderUserId || null, m.senderName || null, clip(m.note, 500) || null, at,
    );
  }
  await run(
    'UPDATE "Conversation" SET "lastMessageAt" = ?, "lastChannel" = ?, "lastDirection" = ?, "lastSnippet" = ?, "updatedAt" = ? WHERE "id" = ?',
    at, m.channel, 'OUT', snippet(m.body || m.templateLabel || m.statusDetail), Date.now(), t.id,
  );
  return { threadId: t.id, messageId };
}

// A message the person SENT US (a reply). Candidates' reply rows are written by messageDelivery.applyInbound into
// CandidateMessage; here the thread is updated, a client's / employee's row is written, and the owner is told.
async function recordIn(m) {
  if (!(await ready())) return null;
  const type = m.personType;
  const info = await personInfo(type, m.personId) || {};
  const t = await ensureThread(type, m.personId, { name: m.personName || info.name, department: m.department || info.department, ownerUserId: m.ownerUserId || info.ownerUserId, ownerName: info.ownerName });
  if (!t) return null;
  const at = ms(m.at) || Date.now();
  let messageId = null;
  if (type !== 'CANDIDATE') {
    // the same provider message arriving twice (webhook retry) is stored once
    if (m.providerRef) {
      const dup = await q('SELECT "id" FROM "ConversationMessage" WHERE "conversationId" = ? AND "providerRef" = ? AND "direction" = ?', t.id, String(m.providerRef), 'IN');
      if (dup.length) return { threadId: t.id, messageId: dup[0].id, duplicate: true };
    }
    messageId = newId();
    await run(
      'INSERT INTO "ConversationMessage" ("id","conversationId","personType","personId","channel","direction","subject","body","address","status","statusDetail","providerRef","mailMessageId","inReplyTo","templateLabel","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      messageId, t.id, type, String(m.personId), m.channel, 'IN', m.subject || null, clip(m.body, 8000) || null, m.address || null, 'RECEIVED',
      clip(m.statusDetail || `Reply on ${m.channel}`, 500), m.providerRef || null, m.mailMessageId || null, m.inReplyTo || null, m.stop ? 'Asked us to stop' : 'Reply received', at,
    );
  } else if (m.providerRef) {
    // the candidate's row is written by the caller first; a retry is told apart by the provider id
    const dup = await prisma.candidateMessage.count({ where: { candidateId: String(m.personId), providerRef: String(m.providerRef), status: 'RECEIVED' } }).catch(() => 0);
    if (dup > 1) return { threadId: t.id, duplicate: true };
  }
  await run(
    `UPDATE "Conversation" SET ${touchSql('IN')}"lastMessageAt" = ?, "lastChannel" = ?, "lastDirection" = ?, "lastSnippet" = ?, "updatedAt" = ? WHERE "id" = ?`,
    at, at, m.channel, 'IN', snippet(m.body), Date.now(), t.id,
  );
  await stopWaiting(type, m.personId, m.channel).catch(() => {});
  // Omni-Channel reply tagging (outreach/replies.js): fire and forget, never blocks or breaks the inbox
  try { require('../outreach/replies').onReply({ address: m.address, channel: m.channel, at, personType: type, personId: m.personId }).catch(() => {}); } catch { /* tagging is optional */ } // eslint-disable-line global-require
  // tell whoever deals with this person (the bell)
  try {
    const fresh = await getThread(type, m.personId);
    const who = fresh && fresh.ownerUserId;
    if (m.channel === 'WhatsApp') {
      // WhatsApp chats screen (utils/waChats.js): "Candidate replied: review" on the open follow-up, and ONE bell per chat per 10 minutes
      await require('./waChats').afterReply({ personType: type, personId: m.personId, name: t.personName || info.name, ownerUserId: who, body: m.body, at }); // eslint-disable-line global-require
    } else if (who) {
      await require('./notify').pushNotification({ // eslint-disable-line global-require
        userId: who,
        title: `New reply from ${t.personName || info.name || 'a person'} (${m.channel === 'Email' ? 'Mail' : m.channel})`,
        message: `${snippet(m.body) || 'A reply arrived.'} - open Follow-ups > Inbox`,
      });
    }
  } catch { /* the bell is a courtesy */ }
  // Omni-Channel WhatsApp bot (outreach/bots.js): fire-and-forget; it replies only when an Admin has switched it on, and always honours STOP
  try { require('../outreach/bots').onInbound({ personType: type, personId: m.personId, channel: m.channel, body: m.body, address: m.address, numberId: m.numberId || null }).catch(() => {}); } catch { /* the bot is optional */ } // eslint-disable-line global-require
  return { threadId: t.id, messageId };
}

// ---- finding the person a phone number / address belongs to -------------------------
const tailOf = (raw) => core.normalizeMobile(raw).e164 ? core.normalizeMobile(raw).e164.slice(-10) : String(raw || '').replace(/\D/g, '').slice(-10);

async function findByPhone(raw) {
  const tail = tailOf(raw);
  if (tail.length < 8) return null;
  const like = tail.slice(-8);
  const same = (v) => v && tailOf(v) === tail;
  const cands = await prisma.candidate.findMany({ where: { phone: { contains: like } }, select: { id: true, name: true, phone: true }, take: 20 }).catch(() => []);
  const cand = cands.find((c) => same(c.phone));
  if (cand) return { type: 'CANDIDATE', id: cand.id, name: cand.name };
  const clients = await prisma.client.findMany({
    where: { OR: ['contactPhone', 'contactWhatsApp', 'billingContactPhone', 'secondaryContactPhone', 'recruitmentContactPhone'].map((k) => ({ [k]: { contains: like } })) },
    select: { id: true, name: true, contactName: true, contactPhone: true, contactWhatsApp: true, billingContactPhone: true, secondaryContactPhone: true, recruitmentContactPhone: true }, take: 20,
  }).catch(() => []);
  const cl = clients.find((c) => [c.contactPhone, c.contactWhatsApp, c.billingContactPhone, c.secondaryContactPhone, c.recruitmentContactPhone].some(same));
  if (cl) return { type: 'CLIENT', id: cl.id, name: cl.contactName ? `${cl.contactName} (${cl.name})` : cl.name };
  const emps = await prisma.employee.findMany({ where: { phone: { contains: like } }, select: { id: true, name: true, phone: true }, take: 20 }).catch(() => []);
  const em = emps.find((e) => same(e.phone));
  if (em) return { type: 'EMPLOYEE', id: em.id, name: em.name };
  return null;
}

async function findByEmail(raw) {
  const a = String(raw || '').trim().toLowerCase();
  if (!a || !a.includes('@')) return null;
  const cand = await prisma.candidate.findFirst({ where: { email: { equals: a } }, select: { id: true, name: true } }).catch(() => null);
  let c2 = cand;
  if (!c2) { const rows = await prisma.candidate.findMany({ where: { email: { contains: a } }, select: { id: true, name: true, email: true }, take: 10 }).catch(() => []); c2 = rows.find((r) => String(r.email).trim().toLowerCase() === a) || null; }
  if (c2) return { type: 'CANDIDATE', id: c2.id, name: c2.name };
  const keys = ['contactEmail', 'secondaryContactEmail', 'billingContactEmail', 'recruitmentContactEmail'];
  const cls = await prisma.client.findMany({ where: { OR: keys.map((k) => ({ [k]: { contains: a } })) }, select: { id: true, name: true, contactName: true, ...Object.fromEntries(keys.map((k) => [k, true])) }, take: 10 }).catch(() => []);
  const cl = cls.find((c) => keys.some((k) => String(c[k] || '').trim().toLowerCase() === a));
  if (cl) return { type: 'CLIENT', id: cl.id, name: cl.contactName ? `${cl.contactName} (${cl.name})` : cl.name };
  const em = (await prisma.employee.findMany({ where: { email: { contains: a } }, select: { id: true, name: true, email: true }, take: 10 }).catch(() => [])).find((e) => String(e.email || '').trim().toLowerCase() === a);
  return em ? { type: 'EMPLOYEE', id: em.id, name: em.name } : null;
}

// ---- the timeline -------------------------------------------------------------------
const STATUS_WORD = {
  SENT: 'Sent', DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Not delivered', RECEIVED: 'Reply', LOGGED: 'Call saved', OPENED_ON_DEVICE: 'Opened in own app',
  QUEUED: 'Waiting to send', NOT_SENT_BLOCKED: 'Not sent', NOT_SENT_NO_PROVIDER: 'Not sent', REQUESTED: 'Asked a colleague', SWITCHED_OFF: 'Not sent',
};
const stateOf = (s) => {
  const u = String(s || '').toUpperCase();
  if (u === 'SENT' || u === 'DELIVERED' || u === 'READ') return u.toLowerCase();
  if (u === 'FAILED') return 'failed';
  if (u === 'RECEIVED') return 'replied';
  if (u === 'LOGGED') return 'call';
  if (u === 'OPENED_ON_DEVICE') return 'opened';
  if (u === 'REQUESTED') return 'asked';
  if (u === 'QUEUED') return 'waiting';
  return 'notsent';
};

function itemOf(src, r, masked) {
  const inbound = src === 'cand' ? String(r.status || '').toUpperCase() === 'RECEIVED' : r.direction === 'IN';
  const ch = r.channel;
  const address = src === 'cand' ? r.recipient : r.address;
  const body = r.body == null ? '' : String(r.body);
  return {
    id: `${src}:${r.id}`,
    providerRef: r.providerRef || null,
    at: toDate(r.createdAt),
    channel: ch === 'Mail' ? 'Email' : ch,
    direction: inbound ? 'in' : 'out',
    state: stateOf(r.status),
    stateWord: STATUS_WORD[String(r.status || '').toUpperCase()] || String(r.status || '').toLowerCase(),
    who: inbound ? null : (r.senderName || null),
    subject: masked ? (r.subject ? access.scrubFor(r.subject) : null) : (r.subject || null),
    body: masked ? access.scrubFor(body) : body,
    template: r.templateLabel && !['Reply received', 'Asked us to stop'].includes(r.templateLabel) ? r.templateLabel : (r.templateLabel || null),
    // A delivery error often quotes the address it failed on: hidden for a masked viewer (security fix 2026-10-13).
    detail: masked && r.statusDetail ? access.scrubFor(r.statusDetail) : (r.statusDetail || null),
    note: masked && r.note ? access.scrubFor(r.note) : (r.note || null),
    to: masked ? access.maskedHint(address) : (address || null),
    stop: r.templateLabel === 'Asked us to stop',
    auto: src === 'cand' && !!r.trigger && r.trigger !== 'Manual' && r.trigger !== 'Bulk' && r.trigger !== 'Reply',
    trigger: src === 'cand' ? r.trigger : null,
  };
}

async function timeline(type, id, { masked = false, limit = 300, viewer = null } = {}) {
  let items = [];
  if (type === 'CANDIDATE') {
    const rows = await prisma.candidateMessage.findMany({ where: { candidateId: String(id) }, orderBy: { createdAt: 'desc' }, take: limit }).catch(() => []);
    items = rows.map((r) => itemOf('cand', r, masked));
  } else if (await ready()) {
    const t = await getThread(type, id);
    if (t) {
      const rows = await q('SELECT * FROM "ConversationMessage" WHERE "conversationId" = ? ORDER BY "createdAt" DESC LIMIT ?', t.id, limit);
      items = rows.map((r) => itemOf('conv', r, masked));
    }
  }
  items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // WHATSAPP NUMBERS: a chat on a number this viewer may not see is not shown; the others say which number they used
  items = viewer ? await require('./waNumbers').filterRows(viewer, items) : items; // eslint-disable-line global-require
  return items.map(({ providerRef, ...rest }) => rest);
}

// ---- who may see which people ---------------------------------------------------------
async function visibleIds(user, type, ids) {
  if (!ids.length) return new Set();
  const S = require('./scope'); // eslint-disable-line global-require
  const s = S.atsScopeOf(user);
  try {
    if (type === 'CANDIDATE') {
      const where = s.global ? { id: { in: ids } } : { AND: [{ id: { in: ids } }, S.candidateWhere(user)] };
      return new Set((await prisma.candidate.findMany({ where, select: { id: true } })).map((x) => x.id));
    }
    if (type === 'CLIENT') {
      return new Set((await prisma.client.findMany({ where: { AND: [{ id: { in: ids } }, S.clientWhere(user)] }, select: { id: true } })).map((x) => x.id));
    }
    return new Set((await prisma.employee.findMany({ where: { AND: [{ id: { in: ids } }, S.employeeWhere(user)] }, select: { id: true } })).map((x) => x.id));
  } catch { return new Set(); }
}

async function allowedTypes(user) {
  const out = {};
  for (const [aud, type] of Object.entries(TYPES)) {
    // eslint-disable-next-line no-await-in-loop
    const rule = await access.ruleFor(user, aud);
    if (rule.allowed) out[type] = rule;
  }
  return out;
}

// ---- the inbox -------------------------------------------------------------------------
async function myTeamIds(user) {
  const S = require('./scope'); // eslint-disable-line global-require
  const s = S.atsScopeOf(user);
  const set = new Set([user.id]);
  if (s.teamUserIds) s.teamUserIds.forEach((x) => set.add(x));
  if (s.positions && Array.isArray(s.positions.holderUserIds)) s.positions.holderUserIds.forEach((x) => set.add(x));
  if (set.size === 1 && (s.departments || []).length) {
    const us = await prisma.user.findMany({ where: { atsDepartment: { in: s.departments }, status: 'Active' }, select: { id: true } }).catch(() => []);
    us.forEach((x) => set.add(x.id));
  }
  return set;
}

function rowOf(t, masked, extra = {}) {
  return {
    id: t.id, personType: t.personType, personId: t.personId, name: t.personName, department: t.department,
    ownerUserId: t.ownerUserId, ownerName: t.ownerName, lastAt: t.lastMessageAt, channel: t.lastChannel, direction: t.lastDirection,
    snippet: masked ? access.scrubFor(t.lastSnippet) : t.lastSnippet, unread: t.unread, done: !!t.doneAt, preferredChannel: t.preferredChannel,
    waiting: !!t.awaitUntil, waitUntil: t.awaitUntil, waitNext: t.awaitNext, waitChannel: t.awaitChannel,
    ...extra,
  };
}

function applyFilters(rows, f, skip, ctx) {
  return rows.filter((r) => {
    if (skip !== 'channel' && f.channel && r.channel !== f.channel) return false;
    if (skip !== 'type' && f.type && r.personType !== f.type) return false;
    if (skip !== 'department' && f.department && r.department !== f.department) return false;
    if (skip !== 'assigned') {
      if (f.assigned === 'me' && r.ownerUserId !== ctx.userId) return false;
      if (f.assigned === 'team' && !(r.ownerUserId && ctx.team.has(r.ownerUserId))) return false;
      if (f.assigned === 'none' && r.ownerUserId) return false;
    }
    if (skip !== 'state') {
      if (f.state === 'unread' && !(r.unread > 0)) return false;
      if (f.state === 'waiting' && !r.waiting) return false;
      if (f.state === 'done' && !r.done) return false;
      if (f.state === 'open' && r.done) return false;
    }
    if (skip !== 'date') {
      if (f.from && !(r.lastAt && r.lastAt.getTime() >= f.from)) return false;
      if (f.to && !(r.lastAt && r.lastAt.getTime() <= f.to)) return false;
    }
    if (f.q) {
      const hay = `${r.name || ''} ${r.snippet || ''} ${r.ownerName || ''}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
}

const countBy = (rows, key) => {
  const m = new Map();
  rows.forEach((r) => { const k = r[key]; if (k) m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
};

// query: { channel, type, department, assigned: me|team|none, state: unread|waiting|done|open|all, from, to (ms), q, page, pageSize }
async function inbox(user, query = {}) {
  if (!(await ready())) return { ready: false, rows: [], total: 0, facets: null, unreadTotal: 0 };
  await sweepWaiting().catch(() => {});
  const rules = await allowedTypes(user);
  const typeKeys = Object.keys(rules);
  if (!typeKeys.length) return { ready: true, rows: [], total: 0, facets: { channel: [], type: [], department: [], assigned: [], state: [] }, unreadTotal: 0, allowed: false };
  const raw = (await q('SELECT * FROM "Conversation" WHERE "lastMessageAt" IS NOT NULL ORDER BY "lastMessageAt" DESC LIMIT 1500')).map(threadOf);
  const mine = [];
  for (const type of typeKeys) {
    const of = raw.filter((t) => t.personType === type);
    // eslint-disable-next-line no-await-in-loop
    const vis = await visibleIds(user, type, of.map((t) => t.personId));
    of.filter((t) => vis.has(t.personId)).forEach((t) => mine.push(rowOf(t, rules[type].mode === 'masked')));
  }
  mine.sort((a, b) => b.lastAt - a.lastAt);
  // WHATSAPP NUMBERS (utils/waNumbers.js): a chat that ran only on numbers this login may not use is not listed; every row names the numbers it ran on
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    if (await WN.hasNumbers()) {
      const items = mine.map((r) => ({ personType: r.personType, personId: r.personId, channel: r.channel }));
      const hide = await WN.hiddenPersons(user, items);
      const nums = await WN.threadNumbers(items);
      for (let i = mine.length - 1; i >= 0; i -= 1) {
        const k = `${mine[i].personType}:${mine[i].personId}`;
        if (hide.has(k)) mine.splice(i, 1); else if (nums.get(k)) mine[i].waNumbers = nums.get(k);
      }
    }
  } catch { /* the list stays as it was */ }
  const team = await myTeamIds(user);
  const ctx = { userId: user.id, team };
  const f = {
    channel: CHANNELS.includes(query.channel) ? query.channel : '',
    type: TYPES[query.type] ? TYPES[query.type] : (['CANDIDATE', 'CLIENT', 'EMPLOYEE'].includes(query.type) ? query.type : ''),
    department: query.department ? String(query.department) : '',
    assigned: ['me', 'team', 'none'].includes(query.assigned) ? query.assigned : '',
    state: ['unread', 'waiting', 'done', 'open', 'all'].includes(query.state) ? query.state : 'open',
    from: query.from ? Number(query.from) : null,
    to: query.to ? Number(query.to) : null,
    q: String(query.q || '').trim().toLowerCase(),
  };
  const filtered = applyFilters(mine, f, null, ctx);
  const withoutState = (skip) => applyFilters(mine, { ...f, state: skip === 'state' ? 'all' : f.state }, skip, ctx);
  // CASCADING FILTERS: each option's count is over everything that matches the OTHER filters; zero-count options are left out.
  const base = (skip) => applyFilters(mine, f, skip, ctx);
  const chRows = base('channel'); const tyRows = base('type'); const dpRows = base('department'); const asRows = base('assigned'); const stRows = base('state');
  const facets = {
    channel: CHANNELS.map((c) => ({ value: c, count: chRows.filter((r) => r.channel === c).length })).filter((x) => x.count),
    type: ['CANDIDATE', 'CLIENT', 'EMPLOYEE'].map((t) => ({ value: t, label: TYPE_WORD[t], count: tyRows.filter((r) => r.personType === t).length })).filter((x) => x.count),
    department: countBy(dpRows, 'department'),
    assigned: [
      { value: 'me', label: 'Assigned to me', count: asRows.filter((r) => r.ownerUserId === user.id).length },
      { value: 'team', label: 'My team', count: asRows.filter((r) => r.ownerUserId && team.has(r.ownerUserId)).length },
      { value: 'none', label: 'Nobody yet', count: asRows.filter((r) => !r.ownerUserId).length },
    ].filter((x) => x.count),
    state: [
      { value: 'open', label: 'Open', count: stRows.filter((r) => !r.done).length },
      { value: 'unread', label: 'Unread', count: stRows.filter((r) => r.unread > 0).length },
      { value: 'waiting', label: 'Waiting for a reply', count: stRows.filter((r) => r.waiting).length },
      { value: 'done', label: 'Done', count: stRows.filter((r) => r.done).length },
    ].filter((x) => x.count),
  };
  void withoutState;
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
  return {
    ready: true,
    allowed: true,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length, page, pages, pageSize,
    facets,
    unreadTotal: mine.filter((r) => r.unread > 0 && !r.done).length,
    unreadMessages: mine.filter((r) => !r.done).reduce((n, r) => n + r.unread, 0),
    waitingTotal: mine.filter((r) => r.waiting).length,
    filters: { ...f, from: f.from, to: f.to },
  };
}

// For the badge: how many conversations have a reply nobody has read yet (inside the caller's scope).
async function unreadCount(user) {
  if (!(await ready())) return { ready: false, conversations: 0, messages: 0, waiting: 0 };
  const rules = await allowedTypes(user);
  const typeKeys = Object.keys(rules);
  if (!typeKeys.length) return { ready: true, conversations: 0, messages: 0, waiting: 0 };
  await sweepWaiting().catch(() => {});
  const raw = (await q('SELECT * FROM "Conversation" WHERE ("unread" > 0 OR "awaitUntil" IS NOT NULL) AND "doneAt" IS NULL ORDER BY "lastMessageAt" DESC LIMIT 1500')).map(threadOf);
  let conversations = 0; let messages = 0; let waiting = 0;
  for (const type of typeKeys) {
    const of = raw.filter((t) => t.personType === type);
    // eslint-disable-next-line no-await-in-loop
    const vis = await visibleIds(user, type, of.map((t) => t.personId));
    let hidden = new Set();
    try { hidden = await require('./waNumbers').hiddenPersons(user, of.filter((t) => vis.has(t.personId)).map((t) => ({ personType: t.personType, personId: t.personId, channel: t.lastChannel }))); } catch { hidden = new Set(); } // eslint-disable-line global-require
    of.filter((t) => vis.has(t.personId) && !hidden.has(`${t.personType}:${t.personId}`)).forEach((t) => {
      if (t.unread > 0) { conversations += 1; messages += t.unread; }
      if (t.awaitUntil) waiting += 1;
    });
  }
  return { ready: true, conversations, messages, waiting };
}

// ---- one conversation: read / done / assign / preferred ------------------------------------------------
async function markRead(type, id) {
  if (!(await ready())) return false;
  await run('UPDATE "Conversation" SET "unread" = 0, "updatedAt" = ? WHERE "personType" = ? AND "personId" = ?', Date.now(), type, String(id));
  return true;
}
async function setDone(user, type, id, done) {
  const t = await ensureThread(type, id);
  if (!t) return null;
  if (done) await run('UPDATE "Conversation" SET "doneAt" = ?, "doneByName" = ?, "unread" = 0, "updatedAt" = ? WHERE "id" = ?', Date.now(), user.name, Date.now(), t.id);
  else await run('UPDATE "Conversation" SET "doneAt" = NULL, "doneByName" = NULL, "updatedAt" = ? WHERE "id" = ?', Date.now(), t.id);
  return getThread(type, id);
}
async function assign(user, type, id, toUserId) {
  const t = await ensureThread(type, id);
  if (!t) return null;
  const name = toUserId ? await nameOfUser(toUserId) : null;
  if (toUserId && !name) return { error: 'That person was not found.' };
  await run('UPDATE "Conversation" SET "ownerUserId" = ?, "ownerName" = ?, "updatedAt" = ? WHERE "id" = ?', toUserId || null, name, Date.now(), t.id);
  if (toUserId && toUserId !== user.id) {
    await require('./notify').pushNotification({ userId: toUserId, title: `${user.name} gave you a conversation: ${t.personName || 'a person'}`, message: 'Open Follow-ups > Inbox.' }).catch(() => {}); // eslint-disable-line global-require
  }
  return getThread(type, id);
}
async function setPreferred(type, id, channel) {
  const t = await ensureThread(type, id);
  if (!t) return null;
  const ch = CHANNELS.includes(channel) ? channel : null;
  await run('UPDATE "Conversation" SET "preferredChannel" = ?, "updatedAt" = ? WHERE "id" = ?', ch, Date.now(), t.id);
  return getThread(type, id);
}

// ---- "if no reply by then …" -------------------------------------------------------------------------------
const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const istTime = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

async function setAwait(user, type, id, { value, unit, next, channel, applicationId } = {}) {
  const v = Math.max(1, Math.min(60, Number(value) || 0));
  if (!v) return { error: 'Say after how many hours or days.' };
  const u = unit === 'days' ? 'days' : 'hours';
  const nx = ['Email', 'WhatsApp', 'SMS', 'Call', 'Remind'].includes(next) ? next : 'Remind';
  const until = new Date(Date.now() + v * (u === 'days' ? 86400000 : 3600000));
  const t = await ensureThread(type, id);
  if (!t) return { error: 'Person not found.' };
  await run('UPDATE "Conversation" SET "awaitUntil" = ?, "awaitChannel" = ?, "awaitNext" = ?, "awaitNotifiedAt" = NULL, "updatedAt" = ? WHERE "id" = ?', until.getTime(), channel || t.lastChannel || null, nx, Date.now(), t.id);
  let followUp = null;
  if (type === 'CANDIDATE') followUp = await reminderOnFollowUp(user, id, applicationId, until, nx, channel || t.lastChannel);
  return { until, followUpId: followUp ? followUp.id : null, thread: await getThread(type, id) };
}
const nextWords = (nx) => (nx === 'Remind' ? 'check back' : nx === 'Call' ? 'call them' : `try ${nx === 'Email' ? 'Mail' : nx}`);

async function reminderOnFollowUp(user, candidateId, applicationId, until, nx, channel) {
  try {
    const where = { candidateId, completedAt: null, ...(applicationId ? { applicationId } : {}) };
    const open = await prisma.applicationFollowUp.findFirst({ where, orderBy: { createdAt: 'desc' } });
    const text = `No reply${channel ? ` on ${channel === 'Email' ? 'Mail' : channel}` : ''}: ${nextWords(nx)}`;
    if (open) {
      return await prisma.applicationFollowUp.update({ where: { id: open.id }, data: { dueDate: istDate(until), dueTime: istTime(until), nextAction: text } });
    }
    const app = await prisma.application.findFirst({
      where: { candidateId, ...(applicationId ? { id: applicationId } : {}) }, orderBy: { updatedAt: 'desc' },
      select: { id: true, requirementId: true, requirement: { select: { tlId: true } } },
    });
    if (!app) return null;
    const tl = app.requirement && app.requirement.tlId ? await prisma.user.findUnique({ where: { id: app.requirement.tlId }, select: { id: true, name: true } }).catch(() => null) : null;
    return await prisma.applicationFollowUp.create({
      data: {
        applicationId: app.id, candidateId, requirementId: app.requirementId,
        ownerUserId: user.id, ownerName: user.name, ownerRole: user.atsRole || user.role,
        tlUserId: tl ? tl.id : null, tlName: tl ? tl.name : null,
        nextAction: text, purpose: 'No reply', dueDate: istDate(until), dueTime: istTime(until), autoCreated: true,
        createdById: user.id, createdByName: user.name,
      },
    });
  } catch { return null; }
}

// A reply arrived: stop waiting, and tell the follow-up.
async function stopWaiting(type, id, channel) {
  const t = await getThread(type, id);
  if (!t) return;
  if (type === 'CANDIDATE') {
    await prisma.applicationFollowUp.updateMany({
      where: { candidateId: String(id), completedAt: null, nextAction: { startsWith: 'No reply' } },
      data: { nextAction: `Reply received${channel ? ` on ${channel === 'Email' ? 'Mail' : channel}` : ''}: answer them`, lastContactedAt: new Date() },
    }).catch(() => {});
  }
}

// Read-time evaluation (the app has no scheduler, like the follow-up escalation): waiting reminders that have come due
// tell the person who deals with the conversation, once.
async function sweepWaiting() {
  if (!(await ready())) return 0;
  const due = (await q('SELECT * FROM "Conversation" WHERE "awaitUntil" IS NOT NULL AND "awaitUntil" <= ? AND "awaitNotifiedAt" IS NULL LIMIT 200', Date.now())).map(threadOf);
  for (const t of due) {
    // eslint-disable-next-line no-await-in-loop
    await run('UPDATE "Conversation" SET "awaitNotifiedAt" = ? WHERE "id" = ?', Date.now(), t.id);
    if (t.ownerUserId) {
      // eslint-disable-next-line no-await-in-loop
      await require('./notify').pushNotification({ // eslint-disable-line global-require
        userId: t.ownerUserId, title: `No reply from ${t.personName || 'a person'}`,
        message: `Nothing came back${t.awaitChannel ? ` on ${t.awaitChannel === 'Email' ? 'Mail' : t.awaitChannel}` : ''}. Next: ${nextWords(t.awaitNext)}.`,
      }).catch(() => {});
    }
  }
  return due.length;
}

module.exports = {
  TYPES, AUDIENCE_OF, TYPE_WORD, CHANNELS, ready, getThread, getThreadById, ensureThread, personInfo,
  recordOut, recordIn, findByPhone, findByEmail, timeline, visibleIds, allowedTypes, inbox, unreadCount,
  markRead, setDone, assign, setPreferred, setAwait, stopWaiting, sweepWaiting, myTeamIds, istDate, istTime, snippet,
};
