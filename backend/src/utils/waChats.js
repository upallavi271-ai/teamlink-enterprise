// ---------------------------------------------------------------------------
// WHATSAPP CHATS - the recruiter's chat screen (Follow-ups > WhatsApp chats).
//
// WHAT ALREADY EXISTED (not rebuilt here)
//   * the inbound pipeline: /api/webhooks/whatsapp -> utils/messageDelivery.applyInbound -> outreach/omni/replyRouter (who is it?, Needs review,
//     idempotent provider events) -> CandidateMessage (candidates) / ConversationMessage (clients, employees) + Conversation (one row per person)
//   * per-number threads (utils/waNumbers.js: WaThread, WaMessageMap, resolveSender, WaNumberAccess), the 24-hour window, STOP opt-out
//   * the send path (utils/omniSend.js -> bulkMessaging -> channels), scope (utils/scope.js), contact rules (utils/contactAccess.js), follow-ups
//
// WHAT THIS FILE ADDS (all additive, plain SQL, created on first use - see ensure())
//   WaChatRead   who has read which chat, and when  (unread is PER LOGIN: a team lead reading a chat does not clear the recruiter's unread)
//   WaChatMeta   the reply tag on a chat (Interested / Not interested / Call back)
//   WaChatFlag   "Candidate replied: review" on an open follow-up (the follow-up is NEVER completed by itself)
//   WaChatBell   the last bell per login and chat (at most one bell per chat per 10 minutes)
//   WaChatMedia  pictures, documents and voice notes a person sent (the bytes are on disk, never served without a login check)
//   and the functions behind routes/waChats.js: the chat list, one chat, polling, read, send checks, media, follow-up, test tools.
//
// A message the TEST tool made has a provider id that starts with "testsim." - that is the only mark, and it lets "Remove test messages" find them.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const core = require('./messagingCore');
const access = require('./contactAccess');
const convo = require('./conversations');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const ms = (v) => { if (v == null) return null; const d = v instanceof Date ? v : new Date(typeof v === 'bigint' ? Number(v) : v); const t = d.getTime(); return Number.isNaN(t) ? null : t; };
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
const DAY = 24 * 3600 * 1000;
const TEST_PREFIX = 'testsim.';
const BELL_GAP = 10 * 60 * 1000;
const SINCE_KEY = 'wa.chats.since';
const CHAT_STATUSES = ['RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'QUEUED'];
const LIST_DAYS = 365;
const LIST_MAX = 300;

// ---- the tables ---------------------------------------------------------------------------------------------------------------
const DDL = [
  'CREATE TABLE IF NOT EXISTS "WaChatRead" ("userId" TEXT NOT NULL, "personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "readAt" BIGINT NOT NULL, PRIMARY KEY ("userId","personType","personId"))',
  'CREATE TABLE IF NOT EXISTS "WaChatMeta" ("personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "intent" TEXT, "intentAt" BIGINT, "intentByName" TEXT, PRIMARY KEY ("personType","personId"))',
  'CREATE TABLE IF NOT EXISTS "WaChatFlag" ("followUpId" TEXT NOT NULL PRIMARY KEY, "personId" TEXT NOT NULL, "repliedAt" BIGINT NOT NULL, "prevAction" TEXT)',
  'CREATE INDEX IF NOT EXISTS "WaChatFlag_person" ON "WaChatFlag"("personId")',
  'CREATE TABLE IF NOT EXISTS "WaChatBell" ("userId" TEXT NOT NULL, "personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "lastBellAt" BIGINT NOT NULL, PRIMARY KEY ("userId","personType","personId"))',
  `CREATE TABLE IF NOT EXISTS "WaChatMedia" (
    "id" TEXT NOT NULL PRIMARY KEY, "personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "providerRef" TEXT, "numberId" TEXT, "kind" TEXT NOT NULL,
    "mime" TEXT, "fileName" TEXT, "stored" TEXT, "size" BIGINT, "status" TEXT NOT NULL DEFAULT 'pending', "note" TEXT, "createdAt" BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS "WaChatMedia_person" ON "WaChatMedia"("personType","personId")',
  'CREATE INDEX IF NOT EXISTS "WaChatMedia_ref" ON "WaChatMedia"("providerRef")',
  // an index only (no new column): the WhatsApp screens and the polling ask "WhatsApp messages newer than ..."
  'CREATE INDEX IF NOT EXISTS "CandidateMessage_channel_created" ON "CandidateMessage"("channel","createdAt")',
];
const TABLES = ['WaChatRead', 'WaChatMeta', 'WaChatFlag', 'WaChatBell', 'WaChatMedia'];
let ensured = null;
function ensure() {
  if (ensured) return ensured;
  ensured = (async () => {
    for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
    try {
      const have = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } });
      if (!have) await prisma.appSetting.create({ data: { key: SINCE_KEY, value: String(Date.now()) } });
    } catch { /* another request made it */ }
    sinceCache = null;
    return true;
  })().catch((e) => { ensured = null; console.error('[wa-chats] ensure:', e.message); throw e; }); // eslint-disable-line no-console
  return ensured;
}
let sinceCache = null;
// the day this screen was switched on: a reply older than this counts as already seen for a login that never opened the chat
async function featureSince() {
  if (sinceCache != null) return sinceCache;
  await ensure();
  const r = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } }).catch(() => null);
  sinceCache = r ? Number(r.value) || Date.now() : Date.now();
  return sinceCache;
}

// ---- plain words ----------------------------------------------------------------------------------------------------------------
const WORDS = {
  OUTSIDE_24H: 'More than 24 hours since they wrote: you can send only an approved template.',
  OPTED_OUT: 'They replied STOP on WhatsApp, so nothing more can be sent to them there.',
  NO_NUMBER: 'No WhatsApp number is assigned to you yet. Ask the Admin.',
  NOT_CONNECTED: 'WhatsApp is not connected yet. An Admin connects it in Administration > Integrations > WhatsApp.',
  NO_PHONE: 'This person has no valid mobile number on the record, so WhatsApp cannot be used.',
  REPLY_HINT: 'Replies arrive here only when the WhatsApp webhook is connected.',
};
// Meta's and our own failure words, said simply.
function plainFailure(raw) {
  const t = String(raw || '').replace(/\s*\((?:WhatsApp|SMS|Exotel)? ?report\)\s*$/i, '').trim();
  if (!t) return 'WhatsApp could not deliver this message.';
  if (/131047|24-hour|24 hour|re-engagement/i.test(t)) return 'More than 24 hours since they wrote: WhatsApp accepts only an approved template now.';
  if (/131026|not on whatsapp|undeliverable|not a valid whatsapp/i.test(t)) return 'This number is not on WhatsApp, or the person has not accepted the new terms.';
  if (/131049|ecosystem|healthy/i.test(t)) return 'WhatsApp held this message back to protect the quality of the number.';
  if (/190|access token/i.test(t)) return 'The WhatsApp connection was refused (token expired). Ask the Admin to reconnect.';
  if (/131030|allowed list|recipient phone number not in/i.test(t)) return 'This number is not allowed on the test WhatsApp account yet.';
  if (/stop/i.test(t) && /replied/i.test(t)) return WORDS.OPTED_OUT;
  const after = t.includes(': ') ? t.slice(t.lastIndexOf(': ') + 2) : t;
  return clip(after.replace(/^Not delivered \S.*?: /i, ''), 220);
}

// ---- who is who -----------------------------------------------------------------------------------------------------------------
const e164Of = (raw) => { const m = core.normalizeMobile(raw); return m.ok ? m.e164 : ''; };
const isAdminLike = (u) => !!u && !u.viewAs && [u.role, u.atsRole].some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
const LEAD_ROLES = ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'];
const isLead = (u) => isAdminLike(u) || [u.atsRole, u.role].some((r) => LEAD_ROLES.includes(r));

// ---- test mode ------------------------------------------------------------------------------------------------------------------
// Is WhatsApp "pretend" on this server? (the sandbox, or the Admin pointed the Meta address at a local test server). Real sending = never.
async function testState() {
  // a test can ask the server to behave as if real sending were on (only ever MORE careful)
  if (process.env.TL_WA_CHATS_ASSUME_REAL === '1') return { sandbox: false, testServer: false, connected: true, realSending: true, testMode: false, reason: '' };
  const sandbox = require('./sandbox').isSandbox();
  let cfg = null;
  try { cfg = await require('./whatsappCloud').whatsappConfig(); } catch { cfg = null; }
  const testServer = !!(cfg && cfg.testMode);
  const connected = !!(cfg && cfg.configured);
  const realSending = connected && !sandbox && !testServer;
  return { sandbox, testServer, connected, realSending, testMode: sandbox || testServer, reason: cfg && !cfg.configured ? cfg.reason : '' };
}

// ---- messages: one shape for a candidate row and a client / employee row ---------------------------------------------------------------
const PLACEHOLDER = /^\[(Photo|Document[^\]]*|Voice note|Audio|Video|Sticker|image|document|audio|video|voice|sticker)\]$/i;
function stateOf(status, inbound) {
  const u = String(status || '').toUpperCase();
  if (inbound || u === 'RECEIVED') return 'received';
  if (u === 'READ') return 'read';
  if (u === 'DELIVERED') return 'delivered';
  if (u === 'FAILED') return 'failed';
  if (u === 'QUEUED') return 'queued';
  return 'sent';
}
const TICK_WORD = { queued: 'Waiting to send', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered', received: '' };

function messageOf(src, r, masked) {
  const inbound = src === 'cand' ? String(r.status || '').toUpperCase() === 'RECEIVED' : r.direction === 'IN';
  const state = stateOf(r.status, inbound);
  const body = r.body == null ? '' : String(r.body);
  const failedWhy = state === 'failed' ? plainFailure(r.lastError || r.statusDetail) : null;
  return {
    id: `${src}:${r.id}`, ref: r.providerRef || null, at: ms(r.createdAt), direction: inbound ? 'in' : 'out', state, stateWord: TICK_WORD[state],
    text: masked ? access.scrubFor(body) : body,
    who: inbound ? null : (r.senderName || null),
    template: !inbound && r.templateLabel && !['Reply received', 'Asked us to stop'].includes(r.templateLabel) ? r.templateLabel : null,
    failure: failedWhy ? (masked ? access.scrubFor(failedWhy) : failedWhy) : null,
    stop: r.templateLabel === 'Asked us to stop',
    auto: src === 'cand' && !!r.trigger && !['Manual', 'Bulk', 'Reply'].includes(r.trigger),
    test: String(r.providerRef || '').startsWith(TEST_PREFIX),
  };
}

async function waRows(type, id, { since = null, before = null, limit = 80, masked = false } = {}) {
  const lim = Math.max(1, Math.min(300, Number(limit) || 80));
  if (type === 'CANDIDATE') {
    const where = { candidateId: String(id), channel: 'WhatsApp', status: { in: CHAT_STATUSES } };
    if (since != null) where.createdAt = { gt: new Date(since) };
    else if (before != null) where.createdAt = { lt: new Date(before) };
    const rows = await prisma.candidateMessage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: lim });
    return rows.reverse().map((r) => messageOf('cand', r, masked));
  }
  const t = await convo.getThread(type, id);
  if (!t) return [];
  const cond = ['"conversationId" = ?', '"channel" = ?']; const args = [t.id, 'WhatsApp'];
  if (since != null) { cond.push('"createdAt" > ?'); args.push(since); } else if (before != null) { cond.push('"createdAt" < ?'); args.push(before); }
  const rows = await q(`SELECT * FROM "ConversationMessage" WHERE ${cond.join(' AND ')} ORDER BY "createdAt" DESC, "id" DESC LIMIT ${lim}`, ...args);
  return rows.reverse().map((r) => messageOf('conv', r, masked));
}

// outgoing messages that have not reached their last tick yet: their new state is sent with every poll (a tick changes the row, not its date)
async function tickUpdates(type, id, masked) {
  const from = Date.now() - 3 * DAY;
  if (type === 'CANDIDATE') {
    const rows = await prisma.candidateMessage.findMany({ where: { candidateId: String(id), channel: 'WhatsApp', status: { in: ['QUEUED', 'SENT', 'DELIVERED'] }, createdAt: { gt: new Date(from) } }, take: 60 });
    return rows.map((r) => { const m = messageOf('cand', r, masked); return { id: m.id, state: m.state, stateWord: m.stateWord, failure: m.failure }; });
  }
  const t = await convo.getThread(type, id);
  if (!t) return [];
  const rows = await q('SELECT * FROM "ConversationMessage" WHERE "conversationId" = ? AND "channel" = ? AND "direction" = ? AND "status" IN (?,?,?) AND "createdAt" > ? LIMIT 60', t.id, 'WhatsApp', 'OUT', 'QUEUED', 'SENT', 'DELIVERED', from);
  return rows.map((r) => { const m = messageOf('conv', r, masked); return { id: m.id, state: m.state, stateWord: m.stateWord, failure: m.failure }; });
}

// the messages of a chat, with pictures / files / voice notes and the number each one used (a number this login may not see hides its messages)
async function chatMessages(user, type, id, opts = {}) {
  const rule = await access.ruleFor(user, convo.AUDIENCE_OF[type]);
  const masked = rule.mode === 'masked';
  let list = await waRows(type, id, { ...opts, masked });
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    list = await WN.filterRows(user, list.map((m) => ({ ...m, channel: 'WhatsApp', providerRef: m.ref })));
    list = list.map((m) => { const { channel, providerRef, ...rest } = m; return rest; }); // eslint-disable-line no-unused-vars
  } catch { /* the list stays as it was */ }
  const refs = list.map((m) => m.ref).filter(Boolean);
  const media = new Map();
  if (refs.length) {
    await ensure();
    for (let i = 0; i < refs.length; i += 300) {
      const part = refs.slice(i, i + 300);
      // eslint-disable-next-line no-await-in-loop
      (await q(`SELECT * FROM "WaChatMedia" WHERE "personType" = ? AND "personId" = ? AND "providerRef" IN (${part.map(() => '?').join(',')})`, type, String(id), ...part)).forEach((m) => {
        const arr = media.get(m.providerRef) || [];
        arr.push({ id: m.id, kind: m.kind, mime: m.mime, name: m.fileName, size: m.size == null ? null : num(m.size), status: m.status, note: m.note });
        media.set(m.providerRef, arr);
      });
    }
  }
  return list.map((m) => {
    const files = m.ref ? media.get(m.ref) || [] : [];
    return { ...m, media: files, text: files.length && PLACEHOLDER.test(m.text.trim()) ? '' : m.text };
  });
}

// ---- unread, per login -----------------------------------------------------------------------------------------------------------------
// A chat the login never opened: everything the person wrote since the day this screen was switched on is unread.
async function unreadMap(user, type, ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  await ensure();
  const since = await featureSince();
  const restricted = await numbersRestricted(user);
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    const marks = part.map(() => '?').join(',');
    let rows;
    if (type === 'CANDIDATE') {
      // eslint-disable-next-line no-await-in-loop
      rows = await q(`SELECT m."candidateId" AS pid, m."providerRef" AS ref, m."createdAt" AS at FROM "CandidateMessage" m LEFT JOIN "WaChatRead" r ON r."userId" = ? AND r."personType" = 'CANDIDATE' AND r."personId" = m."candidateId"
        WHERE m."channel" = 'WhatsApp' AND m."status" = 'RECEIVED' AND m."candidateId" IN (${marks}) AND m."createdAt" > COALESCE(r."readAt", ?)`, user.id, ...part, since);
    } else {
      // eslint-disable-next-line no-await-in-loop
      rows = await q(`SELECT m."personId" AS pid, m."providerRef" AS ref, m."createdAt" AS at FROM "ConversationMessage" m LEFT JOIN "WaChatRead" r ON r."userId" = ? AND r."personType" = ? AND r."personId" = m."personId"
        WHERE m."personType" = ? AND m."channel" = 'WhatsApp' AND m."direction" = 'IN' AND m."personId" IN (${marks}) AND m."createdAt" > COALESCE(r."readAt", ?)`, user.id, type, type, ...part, since);
    }
    if (restricted && rows.length) {
      const WN = require('./waNumbers'); // eslint-disable-line global-require
      // eslint-disable-next-line no-await-in-loop
      rows = await WN.filterRows(user, rows.map((r) => ({ ...r, channel: 'WhatsApp', providerRef: r.ref })));
    }
    rows.forEach((r) => out.set(r.pid, (out.get(r.pid) || 0) + 1));
  }
  return out;
}
async function numbersRestricted(user) {
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    if (!(await WN.hasNumbers())) return false;
    return (await WN.visibleNumberIds(user)) !== 'ALL';
  } catch { return false; }
}

async function markRead(user, type, id) {
  await ensure();
  await run('INSERT INTO "WaChatRead" ("userId","personType","personId","readAt") VALUES (?,?,?,?) ON CONFLICT("userId","personType","personId") DO UPDATE SET "readAt" = excluded."readAt"', user.id, type, String(id), Date.now());
  // the old Inbox keeps ONE shared counter: it is cleared only by the person the chat is given to (or when nobody has it), as it always was
  try {
    const t = await convo.getThread(type, id);
    if (t && t.unread > 0 && (!t.ownerUserId || t.ownerUserId === user.id)) await convo.markRead(type, id);
  } catch { /* the shared counter is a courtesy */ }
  return true;
}

// ---- the list ---------------------------------------------------------------------------------------------------------------------------
async function lastRows(type, { ids = null, sinceMs, per = 1 }) {
  const marks = ids ? ids.map(() => '?').join(',') : '';
  if (type === 'CANDIDATE') {
    return q(`SELECT * FROM (SELECT m."id", m."candidateId" AS pid, m."body", m."status", m."statusDetail", m."lastError", m."templateLabel", m."createdAt", m."providerRef", m."senderName", m."trigger", m."applicationId",
      ROW_NUMBER() OVER (PARTITION BY m."candidateId" ORDER BY m."createdAt" DESC, m."id" DESC) AS rn
      FROM "CandidateMessage" m WHERE m."channel" = 'WhatsApp' AND m."status" IN (${CHAT_STATUSES.map(() => '?').join(',')}) AND m."createdAt" > ?${ids ? ` AND m."candidateId" IN (${marks})` : ''}) WHERE rn <= ?`,
    ...CHAT_STATUSES, sinceMs, ...(ids || []), per);
  }
  return q(`SELECT * FROM (SELECT m."id", m."personId" AS pid, m."body", m."status", m."statusDetail", m."templateLabel", m."createdAt", m."providerRef", m."senderName", m."direction",
    ROW_NUMBER() OVER (PARTITION BY m."personId" ORDER BY m."createdAt" DESC, m."id" DESC) AS rn
    FROM "ConversationMessage" m WHERE m."personType" = ? AND m."channel" = 'WhatsApp' AND m."createdAt" > ?${ids ? ` AND m."personId" IN (${marks})` : ''}) WHERE rn <= ?`,
  type, sinceMs, ...(ids || []), per);
}

async function pidsSince(type, sinceMs) {
  if (type === 'CANDIDATE') return (await q('SELECT DISTINCT "candidateId" AS pid FROM "CandidateMessage" WHERE "channel" = \'WhatsApp\' AND "createdAt" > ?', sinceMs)).map((r) => r.pid);
  return (await q('SELECT DISTINCT "personId" AS pid FROM "ConversationMessage" WHERE "personType" = ? AND "channel" = \'WhatsApp\' AND "createdAt" > ?', type, sinceMs)).map((r) => r.pid);
}

function snippetOf(text, hasMedia) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (hasMedia && PLACEHOLDER.test(t)) return t.replace(/^\[|\]$/g, '');
  return clip(t, 120);
}

// Everything the list needs for these people (names, requirement, step, owner, follow-up, tags, numbers).
async function enrich(user, type, ids) {
  const out = new Map(ids.map((i) => [i, { id: i }]));
  if (!ids.length) return out;
  const S = require('./scope'); // eslint-disable-line global-require
  const { stageLabel } = require('./atsVocab'); // eslint-disable-line global-require
  if (type === 'CANDIDATE') {
    const cands = await prisma.candidate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } });
    cands.forEach((c) => Object.assign(out.get(c.id), { name: c.name, phone: c.phone }));
    const apps = await prisma.application.findMany({
      where: { AND: [{ candidateId: { in: ids } }, S.atsScopeOf(user).global ? {} : S.applicationWhere(user)] },
      select: { id: true, candidateId: true, stage: true, updatedAt: true, requirement: { select: { id: true, title: true, reqCode: true, department: true, internal: true, client: { select: { name: true } } } } },
      orderBy: { updatedAt: 'desc' },
    });
    apps.forEach((a) => {
      const row = out.get(a.candidateId);
      if (!row) return;
      (row.apps = row.apps || []).push({ applicationId: a.id, stage: a.stage, stageLabel: stageLabel(a.stage), requirementId: a.requirement ? a.requirement.id : null, requirementTitle: a.requirement ? a.requirement.title : null, requirementCode: a.requirement ? a.requirement.reqCode : null, clientName: a.requirement ? (a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || null) : null, department: a.requirement ? a.requirement.department : null });
    });
    const fus = await prisma.applicationFollowUp.findMany({ where: { candidateId: { in: ids }, completedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, candidateId: true, applicationId: true, dueDate: true, dueTime: true, nextAction: true, ownerName: true } });
    fus.forEach((f) => { const row = out.get(f.candidateId); if (row) (row.followUps = row.followUps || []).push(f); });
  } else if (type === 'CLIENT') {
    (await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, contactName: true } })).forEach((c) => Object.assign(out.get(c.id), { name: c.contactName ? `${c.contactName} (${c.name})` : c.name }));
  } else {
    (await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, department: true } })).forEach((e) => Object.assign(out.get(e.id), { name: e.name, department: e.department }));
  }
  // owner (the person the conversation is given to)
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    // eslint-disable-next-line no-await-in-loop
    (await q(`SELECT "personId","ownerUserId","ownerName","department" FROM "Conversation" WHERE "personType" = ? AND "personId" IN (${part.map(() => '?').join(',')})`, type, ...part)).forEach((c) => Object.assign(out.get(c.personId) || {}, { ownerUserId: c.ownerUserId, ownerName: c.ownerName, convDepartment: c.department }));
    // eslint-disable-next-line no-await-in-loop
    (await q(`SELECT * FROM "WaChatMeta" WHERE "personType" = ? AND "personId" IN (${part.map(() => '?').join(',')})`, type, ...part)).forEach((m) => Object.assign(out.get(m.personId) || {}, { intent: m.intent }));
  }
  const flags = type === 'CANDIDATE' ? await q(`SELECT * FROM "WaChatFlag" WHERE "personId" IN (${ids.map(() => '?').join(',')})`, ...ids).catch(() => []) : [];
  flags.forEach((f) => { const row = out.get(f.personId); if (row) (row.flags = row.flags || {})[f.followUpId] = num(f.repliedAt); });
  return out;
}

async function numberFacts(items) {
  const WN = require('./waNumbers'); // eslint-disable-line global-require
  if (!(await WN.hasNumbers())) return { has: false, map: new Map() };
  return { has: true, map: await WN.threadNumbers(items) };
}

// query: { state: all|unread|needsReply|waiting|followups, q, numberId, requirementId, since (ms, only chats with a message after it), type }
async function listChats(user, query = {}) {
  await ensure();
  const rules = await convo.allowedTypes(user);
  const types = Object.keys(rules);
  const sinceMs = query.since != null && query.since !== '' ? Number(query.since) : Date.now() - LIST_DAYS * DAY;
  const wantType = ['CANDIDATE', 'CLIENT', 'EMPLOYEE'].includes(query.type) ? query.type : '';
  const restricted = await numbersRestricted(user);
  const WN = require('./waNumbers'); // eslint-disable-line global-require
  const all = [];
  for (const type of types.filter((t) => !wantType || t === wantType)) {
    const masked = rules[type].mode === 'masked';
    // eslint-disable-next-line no-await-in-loop
    const pids = await pidsSince(type, sinceMs);
    if (!pids.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const vis = await convo.visibleIds(user, type, pids);
    let ids = pids.filter((p) => vis.has(p));
    if (!ids.length) continue; // eslint-disable-line no-continue
    if (restricted) {
      // eslint-disable-next-line no-await-in-loop
      const hide = await WN.hiddenPersons(user, ids.map((p) => ({ personType: type, personId: p, channel: 'WhatsApp' })));
      ids = ids.filter((p) => !hide.has(`${type}:${p}`));
      if (!ids.length) continue; // eslint-disable-line no-continue
    }
    // the newest message of each chat (a restricted login: the newest one on a number it may see)
    // eslint-disable-next-line no-await-in-loop
    let last = await lastRows(type, { ids: ids.slice(0, 900), sinceMs: 0, per: restricted ? 8 : 1 });
    if (restricted) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await WN.filterRows(user, last.map((r) => ({ ...r, channel: 'WhatsApp' })));
      const seen = new Set(); last = [];
      ok.sort((a, b) => num(b.createdAt) - num(a.createdAt)).forEach((r) => { if (!seen.has(r.pid)) { seen.add(r.pid); last.push(r); } });
    }
    // eslint-disable-next-line no-await-in-loop
    const info = await enrich(user, type, last.map((r) => r.pid));
    // eslint-disable-next-line no-await-in-loop
    const unread = await unreadMap(user, type, last.map((r) => r.pid));
    // eslint-disable-next-line no-await-in-loop
    const nf = await numberFacts(last.map((r) => ({ personType: type, personId: r.pid, channel: 'WhatsApp' })));
    const mediaRefs = last.map((r) => r.providerRef).filter(Boolean);
    const hasMedia = new Set();
    if (mediaRefs.length) {
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < mediaRefs.length; i += 300) (await q(`SELECT "providerRef" FROM "WaChatMedia" WHERE "providerRef" IN (${mediaRefs.slice(i, i + 300).map(() => '?').join(',')})`, ...mediaRefs.slice(i, i + 300))).forEach((m) => hasMedia.add(m.providerRef));
    }
    const today = require('./followups').todayStr(); // eslint-disable-line global-require
    last.forEach((r) => {
      const d = info.get(r.pid) || {};
      const m = messageOf(type === 'CANDIDATE' ? 'cand' : 'conv', r, masked);
      const app = (d.apps || [])[0] || null;
      const fu = (d.followUps || []).find((f) => f.dueDate) || (d.followUps || [])[0] || null;
      const nums = nf.map.get(`${type}:${r.pid}`) || [];
      all.push({
        key: `${type}:${r.pid}`, audience: convo.AUDIENCE_OF[type], personType: type, personId: r.pid, name: d.name || 'Unknown',
        phoneHint: type === 'CANDIDATE' && d.phone ? access.maskedHint(d.phone) : null,
        requirement: app ? { id: app.requirementId, title: app.requirementTitle, client: app.clientName, code: app.requirementCode } : null,
        step: app ? { code: app.stage, label: app.stageLabel } : null, applicationId: app ? app.applicationId : null,
        department: (app && app.department) || d.convDepartment || d.department || null,
        last: { at: m.at, direction: m.direction, state: m.state, text: snippetOf(m.text, hasMedia.has(m.ref)), failed: m.state === 'failed' },
        unread: unread.get(r.pid) || 0, needsReply: m.direction === 'in', waiting: m.direction === 'out' && m.state !== 'failed',
        numbers: nums.map((n) => ({ id: n.id, label: n.label })), sendingFrom: nums.length ? nums[0].label : null,
        ownerUserId: d.ownerUserId || null, ownerName: d.ownerName || null, intent: d.intent || null,
        followUp: fu ? { id: fu.id, dueDate: fu.dueDate, dueTime: fu.dueTime, due: !!fu.dueDate && fu.dueDate <= today, replied: !!(d.flags && d.flags[fu.id]) } : null,
        requirements: (d.apps || []).map((a) => a.requirementId).filter(Boolean),
        _digits: type === 'CANDIDATE' && !masked ? String(d.phone || '').replace(/\D/g, '') : '',
      });
    });
  }
  all.sort((a, b) => b.last.at - a.last.at);
  // filters (the other filters decide the counts of each state chip)
  const text = String(query.q || '').trim().toLowerCase();
  const digits = text.replace(/\D/g, '');
  const bySearch = all.filter((r) => {
    if (query.numberId && !(r.numbers || []).some((n) => n.id === query.numberId)) return false;
    if (query.requirementId && !(r.requirements || []).includes(query.requirementId)) return false;
    if (text) {
      if (r.name.toLowerCase().includes(text)) return true;
      if (r.requirement && `${r.requirement.title || ''} ${r.requirement.client || ''}`.toLowerCase().includes(text)) return true;
      if (digits.length >= 3 && r._digits && r._digits.includes(digits)) return true;
      return false;
    }
    return true;
  });
  const counts = {
    all: bySearch.length, unread: bySearch.filter((r) => r.unread > 0).length, needsReply: bySearch.filter((r) => r.needsReply).length,
    waiting: bySearch.filter((r) => r.waiting).length, followups: bySearch.filter((r) => r.followUp && r.followUp.due).length,
  };
  const st = ['unread', 'needsReply', 'waiting', 'followups'].includes(query.state) ? query.state : 'all';
  const shown = bySearch.filter((r) => (st === 'unread' ? r.unread > 0 : st === 'needsReply' ? r.needsReply : st === 'waiting' ? r.waiting : st === 'followups' ? (r.followUp && r.followUp.due) : true));
  const unreadAll = all.filter((r) => r.unread > 0);
  // requirement and number choices (over every chat of this login)
  const reqMap = new Map();
  all.forEach((r) => { if (r.requirement && r.requirement.id) reqMap.set(r.requirement.id, { id: r.requirement.id, title: r.requirement.title, client: r.requirement.client, count: (reqMap.get(r.requirement.id) || { count: 0 }).count + 1 }); });
  const numMap = new Map();
  all.forEach((r) => (r.numbers || []).forEach((n) => numMap.set(n.id, { id: n.id, label: n.label, count: (numMap.get(n.id) || { count: 0 }).count + 1 })));
  return {
    now: Date.now(), rows: shown.slice(0, LIST_MAX).map(({ _digits, requirements, ...rest }) => rest), total: shown.length, counts,
    unreadChats: unreadAll.length, unreadMessages: unreadAll.reduce((n, r) => n + r.unread, 0),
    requirements: [...reqMap.values()].sort((a, b) => b.count - a.count || String(a.title).localeCompare(String(b.title))).slice(0, 80),
    numbers: [...numMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
    allowed: types.length > 0, masked: types.some((t) => rules[t].mode === 'masked'),
  };
}

// the badge: how many chats have a reply this login has not read (cheap: SQL joins only, no names)
async function unreadCount(user) {
  await ensure();
  const rules = await convo.allowedTypes(user);
  let chats = 0; let messages = 0;
  const since = await featureSince();
  for (const type of Object.keys(rules)) {
    let rows;
    if (type === 'CANDIDATE') {
      // eslint-disable-next-line no-await-in-loop
      rows = await q(`SELECT m."candidateId" AS pid, COUNT(*) AS n FROM "CandidateMessage" m LEFT JOIN "WaChatRead" r ON r."userId" = ? AND r."personType" = 'CANDIDATE' AND r."personId" = m."candidateId"
        WHERE m."channel" = 'WhatsApp' AND m."status" = 'RECEIVED' AND m."createdAt" > COALESCE(r."readAt", ?) GROUP BY m."candidateId" LIMIT 800`, user.id, since);
    } else {
      // eslint-disable-next-line no-await-in-loop
      rows = await q(`SELECT m."personId" AS pid, COUNT(*) AS n FROM "ConversationMessage" m LEFT JOIN "WaChatRead" r ON r."userId" = ? AND r."personType" = ? AND r."personId" = m."personId"
        WHERE m."personType" = ? AND m."channel" = 'WhatsApp' AND m."direction" = 'IN' AND m."createdAt" > COALESCE(r."readAt", ?) GROUP BY m."personId" LIMIT 800`, user.id, type, type, since);
    }
    if (!rows.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const vis = await convo.visibleIds(user, type, rows.map((r) => r.pid));
    let mine = rows.filter((r) => vis.has(r.pid));
    if (mine.length && (await numbersRestricted(user))) {
      // eslint-disable-next-line no-await-in-loop
      const map = await unreadMap(user, type, mine.map((r) => r.pid));
      mine = mine.filter((r) => map.has(r.pid)).map((r) => ({ ...r, n: map.get(r.pid) }));
    }
    chats += mine.length; messages += mine.reduce((n, r) => n + num(r.n), 0);
  }
  return { chats, messages, now: Date.now() };
}

// ---- one person: header facts, window, sender ------------------------------------------------------------------------------------------------
async function lastInboundAt(number, e164) {
  let best = 0;
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    if (number && (await WN.tableReady())) {
      const rows = await q('SELECT "lastInboundAt" FROM "WaThread" WHERE "numberId" = ? AND "contact" = ?', number.id, e164);
      if (rows[0] && rows[0].lastInboundAt) best = Math.max(best, new Date(rows[0].lastInboundAt).getTime() || 0);
    }
    if (!number || number.credSource === 'legacy') {
      const row = await prisma.appSetting.findUnique({ where: { key: `wa.window.${e164}` } }).catch(() => null);
      if (row) best = Math.max(best, new Date(row.value).getTime() || 0);
    }
  } catch { /* none */ }
  return best || null;
}

// the number a message to this person would leave from, and the state of the 24-hour window on THAT number
async function sendingState(user, e164, requestedNumberId) {
  const WN = require('./waNumbers'); // eslint-disable-line global-require
  const out = { legacy: true, number: null, label: null, displayNumber: null, error: null, code: null };
  if (await WN.hasNumbers()) {
    out.legacy = false;
    const r = await WN.resolveSender({ user, requestedNumberId: requestedNumberId || undefined, to: e164 || undefined });
    if (r.ok) Object.assign(out, { number: r.number, label: r.number.label, displayNumber: r.number.displayNumber });
    else Object.assign(out, { error: r.error, code: r.code });
  } else {
    out.label = 'Main number';
  }
  const last = e164 ? await lastInboundAt(out.number, e164) : null;
  const open = !!last && Date.now() - last < DAY;
  return { ...out, lastInboundAt: last, windowOpen: open, windowUntil: last ? last + DAY : null };
}

async function personFacts(user, audience, id) {
  const type = convo.TYPES[audience];
  const rule = await access.ruleFor(user, audience);
  const ctxRows = await require('./messageContext').recipientsFor(user, audience, [String(id)], { contactKind: rule.kind }); // eslint-disable-line global-require
  const p = ctxRows[0] || {};
  const info = await convo.personInfo(type, id) || {};
  return { type, rule, name: p.name || info.name || null, phone: p.whatsapp || p.mobile || null, doNotContact: !!p.doNotContact, applicationId: p.applicationId || null, info };
}

// ---- inbound media ------------------------------------------------------------------------------------------------------------------------------
const MIME_OK = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
};
const MAX_MEDIA = 16 * 1024 * 1024;
const mediaDir = () => {
  const dir = path.join(require('./attachments').uploadDir(), 'wa-media'); // eslint-disable-line global-require
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
};
function sniffOk(mime, buf) {
  if (!buf || buf.length < 4) return false;
  if (mime === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/webp') return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (mime === 'application/pdf') return buf.slice(0, 5).toString() === '%PDF-';
  return true;
}
const safeName = (n, fallback) => clip(String(n || fallback || 'file').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, ''), 90) || fallback;
const kindOfMeta = (type, voice) => (type === 'image' ? 'image' : type === 'sticker' ? 'sticker' : type === 'video' ? 'video' : type === 'document' ? 'document' : (voice ? 'voice' : 'audio'));
const hostOk = (url, base) => {
  try {
    const u = new URL(url); const b = new URL(base);
    if (u.origin === b.origin) return true;
    return u.protocol === 'https:' && /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net|whatsapp\.com)$/i.test(u.hostname);
  } catch { return false; }
};

// What the placeholder text of a media message says.
function mediaWords(meta) {
  if (!meta) return '';
  const k = kindOfMeta(meta.type, meta.voice);
  if (meta.caption) return String(meta.caption);
  return k === 'image' ? '[Photo]' : k === 'document' ? `[Document: ${safeName(meta.filename, 'file')}]` : k === 'voice' ? '[Voice note]' : k === 'audio' ? '[Audio]' : k === 'video' ? '[Video]' : '[Sticker]';
}

// A person sent a picture / file / voice note. Writes the "pending" row at once (quick, inside the webhook) and fetches the bytes afterwards.
// meta = { id (Meta's media id), type, mime, filename, caption, voice, _testBytes? }; who = { personType, personId, numberId, providerRef }
async function inboundMedia(meta, who) {
  try {
    if (!meta || !who || !who.personId) return null;
    await ensure();
    const rowId = newId('wm');
    const kind = kindOfMeta(meta.type, meta.voice);
    await run('INSERT INTO "WaChatMedia" ("id","personType","personId","providerRef","numberId","kind","mime","fileName","status","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
      rowId, who.personType, String(who.personId), who.providerRef || null, who.numberId || null, kind, clip(meta.mime, 80) || null, safeName(meta.filename, kind === 'image' ? 'photo' : kind), 'pending', Date.now());
    const job = fetchInboundMedia(rowId, meta, who).catch((e) => { console.error('[wa-chats] media:', e && e.message); }); // eslint-disable-line no-console
    if (process.env.TL_WA_MEDIA_WAIT === '1') await job; // tests wait for it
    return rowId;
  } catch (e) { console.error('[wa-chats] inboundMedia:', e && e.message); return null; } // eslint-disable-line no-console
}
async function setMedia(rowId, patch) {
  const keys = Object.keys(patch);
  await run(`UPDATE "WaChatMedia" SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE "id" = ?`, ...keys.map((k) => patch[k]), rowId);
}
async function fetchInboundMedia(rowId, meta, who) {
  let bytes = null; let mime = String(meta.mime || '').split(';')[0].trim().toLowerCase();
  if (meta._testBytes && String(who.providerRef || '').startsWith(TEST_PREFIX) && (await testState()).testMode) {
    bytes = Buffer.from(meta._testBytes, 'base64');
  } else {
    const wa = require('./whatsappCloud'); // eslint-disable-line global-require
    const cfg = await wa.whatsappConfig(who.numberId ? { numberId: who.numberId } : undefined).catch(() => null);
    if (!cfg || !cfg.configured) { await setMedia(rowId, { status: 'failed', note: 'WhatsApp is not connected, so the file could not be fetched.' }); return; }
    if (wa.simulated(cfg)) { await setMedia(rowId, { status: 'failed', note: 'Test server: the file was not fetched.' }); return; }
    const head = await core.httpJson(`${cfg.base}/${wa.VERSION}/${encodeURIComponent(meta.id)}`, { headers: { authorization: `Bearer ${cfg.token}` } });
    if (!head.ok || !head.json || !head.json.url) { await setMedia(rowId, { status: 'failed', note: 'WhatsApp did not give the file. Ask them to send it again.' }); return; }
    if (!hostOk(head.json.url, cfg.base)) { await setMedia(rowId, { status: 'failed', note: 'The file address was not trusted, so it was not fetched.' }); return; }
    if (head.json.mime_type) mime = String(head.json.mime_type).split(';')[0].trim().toLowerCase();
    if (Number(head.json.file_size) > MAX_MEDIA) { await setMedia(rowId, { status: 'failed', note: 'The file is bigger than 16 MB.' }); return; }
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(head.json.url, { headers: { authorization: `Bearer ${cfg.token}` }, signal: ctrl.signal });
      if (!res.ok) { await setMedia(rowId, { status: 'failed', note: 'WhatsApp could not give the file. Ask them to send it again.' }); return; }
      const ab = await res.arrayBuffer();
      bytes = Buffer.from(ab);
    } catch { await setMedia(rowId, { status: 'failed', note: 'The file could not be downloaded in time.' }); return; } finally { clearTimeout(timer); }
  }
  if (!bytes || bytes.length > MAX_MEDIA) { await setMedia(rowId, { status: 'failed', note: 'The file is empty or bigger than 16 MB.' }); return; }
  const ext = MIME_OK[mime];
  if (!ext) { await setMedia(rowId, { status: 'blocked', note: 'This kind of file is not shown for safety. Ask them to send a photo or a PDF.', mime }); return; }
  if (!sniffOk(mime, bytes)) { await setMedia(rowId, { status: 'blocked', note: 'The file does not look like what it says it is, so it was not kept.', mime }); return; }
  const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(mediaDir(), stored), bytes, { mode: 0o600 });
  await setMedia(rowId, { status: 'stored', stored, mime, size: bytes.length, note: null });
}

async function mediaRow(id) {
  await ensure();
  return (await q('SELECT * FROM "WaChatMedia" WHERE "id" = ?', String(id || '')))[0] || null;
}
function mediaPath(row) {
  if (!row || !row.stored || !/^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test(row.stored)) return null;
  const dir = mediaDir(); const full = path.resolve(dir, row.stored);
  return path.dirname(full) === dir && fs.existsSync(full) ? full : null;
}

// ---- the bell (one per chat per 10 minutes) and the follow-up flag -------------------------------------------------------------------------------
async function notifyReply({ personType, personId, name, ownerUserId, text }) {
  try {
    if (!ownerUserId) return { sent: false, why: 'nobody owns the chat' };
    await ensure();
    const now = Date.now();
    const bell = (await q('SELECT "lastBellAt" FROM "WaChatBell" WHERE "userId" = ? AND "personType" = ? AND "personId" = ?', ownerUserId, personType, String(personId)))[0];
    const read = (await q('SELECT "readAt" FROM "WaChatRead" WHERE "userId" = ? AND "personType" = ? AND "personId" = ?', ownerUserId, personType, String(personId)))[0];
    const looking = read && now - num(read.readAt) < 2 * 60000; // the owner has this chat open right now: no bell
    if ((bell && now - num(bell.lastBellAt) < BELL_GAP) || looking) return { sent: false, why: 'one bell per chat per 10 minutes' };
    await run('INSERT INTO "WaChatBell" ("userId","personType","personId","lastBellAt") VALUES (?,?,?,?) ON CONFLICT("userId","personType","personId") DO UPDATE SET "lastBellAt" = excluded."lastBellAt"', ownerUserId, personType, String(personId), now);
    await require('./notify').pushNotification({ // eslint-disable-line global-require
      userId: ownerUserId, title: `New WhatsApp reply from ${name || 'a person'}`,
      message: `${clip(String(text || '').replace(/\s+/g, ' ').trim(), 120) || 'A reply arrived.'} - open Follow-ups > WhatsApp chats`,
    });
    return { sent: true };
  } catch (e) { return { sent: false, why: e.message }; }
}

// A candidate wrote: every OPEN follow-up of theirs is flagged "Candidate replied: review". Nothing is completed.
async function flagFollowUps(candidateId, at) {
  try {
    await ensure();
    const open = await prisma.applicationFollowUp.findMany({ where: { candidateId: String(candidateId), completedAt: null }, orderBy: { createdAt: 'desc' }, take: 6 });
    for (const f of open) {
      const mark = 'Candidate replied on WhatsApp: review';
      const had = (await q('SELECT "prevAction" FROM "WaChatFlag" WHERE "followUpId" = ?', f.id))[0];
      // eslint-disable-next-line no-await-in-loop
      await run('INSERT INTO "WaChatFlag" ("followUpId","personId","repliedAt","prevAction") VALUES (?,?,?,?) ON CONFLICT("followUpId") DO UPDATE SET "repliedAt" = excluded."repliedAt"', f.id, String(candidateId), at, had ? had.prevAction : (f.nextAction || null));
      if (!String(f.nextAction || '').startsWith(mark)) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.applicationFollowUp.update({ where: { id: f.id }, data: { nextAction: clip(`${mark}${f.nextAction ? ` (was: ${f.nextAction})` : ''}`, 240), lastContactedAt: new Date(at) } }).catch(() => {});
      }
    }
    return open.length;
  } catch { return 0; }
}

// called by utils/conversations.recordIn for every WhatsApp reply (never throws)
async function afterReply({ personType, personId, name, ownerUserId, body, at }) {
  try {
    if (personType === 'CANDIDATE') await flagFollowUps(personId, at || Date.now());
    return await notifyReply({ personType, personId, name, ownerUserId, text: body });
  } catch { return null; }
}

// ---- the reply tag ---------------------------------------------------------------------------------------------------------------------------------
const INTENTS = { interested: 'Interested', not_interested: 'Not interested', call_back: 'Call back' };
async function setIntent(user, type, id, intent) {
  await ensure();
  if (!intent) { await run('DELETE FROM "WaChatMeta" WHERE "personType" = ? AND "personId" = ?', type, String(id)); return null; }
  await run('INSERT INTO "WaChatMeta" ("personType","personId","intent","intentAt","intentByName") VALUES (?,?,?,?,?) ON CONFLICT("personType","personId") DO UPDATE SET "intent" = excluded."intent", "intentAt" = excluded."intentAt", "intentByName" = excluded."intentByName"', type, String(id), intent, Date.now(), user.name || null);
  return intent;
}

// ---- test tools (Admin, Test mode only) -------------------------------------------------------------------------------------------------------------
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');

// Build a Meta-shaped inbound call and give it to the SAME code the real webhook uses (routes/webhooks.handleWhatsApp).
async function simulateReply(user, { personId, text, kind = 'text', numberId = null, stop = false }) {
  const st = await testState();
  if (!st.testMode && st.connected) return { status: 403, error: 'This is not available while real WhatsApp sending is on. It works only in Test mode.' };
  const cand = await prisma.candidate.findUnique({ where: { id: String(personId || '') }, select: { id: true, name: true, phone: true } });
  if (!cand) return { status: 404, error: 'Pick a candidate.' };
  const from = e164Of(cand.phone);
  if (!from) return { status: 400, error: 'This candidate has no valid mobile number, so a pretend reply cannot be matched to them.' };
  const WN = require('./waNumbers'); // eslint-disable-line global-require
  let row = null;
  if (await WN.hasNumbers()) {
    // the number you pick, else the one this person already chats on, else the default number
    let mine = null;
    if (!numberId && (await WN.tableReady())) {
      const t = (await q('SELECT "numberId" FROM "WaThread" WHERE "contact" = ? ORDER BY "lastMessageAt" DESC LIMIT 1', from))[0];
      mine = t ? await WN.getRow(t.numberId) : null;
    }
    row = numberId ? await WN.getRow(numberId) : mine || (await WN.defaultRow()) || (await WN.listRows()).find((r) => r.active);
    if (!row) return { status: 409, error: 'No WhatsApp number is set up to receive the pretend reply.' };
  }
  const id = `${TEST_PREFIX}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const msg = { from, id, timestamp: String(Math.floor(Date.now() / 1000)) };
  const body = stop ? 'STOP' : String(text || '').trim() || 'Hello (pretend reply)';
  if (kind === 'image') Object.assign(msg, { type: 'image', image: { id: `${id}.m`, mime_type: 'image/png', caption: body === 'Hello (pretend reply)' ? '' : body, _testBytes: TINY_PNG } });
  else if (kind === 'document') Object.assign(msg, { type: 'document', document: { id: `${id}.m`, mime_type: 'application/pdf', filename: 'Test resume.pdf', caption: body === 'Hello (pretend reply)' ? '' : body, _testBytes: TINY_PDF } });
  else Object.assign(msg, { type: 'text', text: { body } });
  const value = {
    messaging_product: 'whatsapp', metadata: { display_phone_number: row ? row.displayDigits : '0', phone_number_id: row ? row.phoneNumberId : 'test' },
    contacts: [{ profile: { name: cand.name }, wa_id: from }], messages: [msg],
  };
  const payload = { object: 'whatsapp_business_account', entry: [{ id: 'TEST', changes: [{ field: 'messages', value }] }] };
  const hooks = require('../routes/webhooks'); // eslint-disable-line global-require
  const out = await hooks.handleWhatsApp(payload, row ? { valid: new Set([row.id]), anyValid: true } : null);
  return { ok: true, id, kind, result: out };
}

// Delete every message the test tool made (and what hangs on it). Real messages are never touched.
async function removeTestMessages() {
  await ensure();
  const like = `${TEST_PREFIX}%`;
  const people = new Map();
  (await q('SELECT DISTINCT "candidateId" AS pid FROM "CandidateMessage" WHERE "providerRef" LIKE ?', like)).forEach((r) => people.set(`CANDIDATE:${r.pid}`, { type: 'CANDIDATE', id: r.pid }));
  (await q('SELECT DISTINCT "personType" AS t, "personId" AS pid FROM "ConversationMessage" WHERE "providerRef" LIKE ?', like)).forEach((r) => people.set(`${r.t}:${r.pid}`, { type: r.t, id: r.pid }));
  const media = await q('SELECT * FROM "WaChatMedia" WHERE "providerRef" LIKE ?', like);
  media.forEach((m) => { const p = mediaPath(m); if (p) { try { fs.unlinkSync(p); } catch { /* gone */ } } });
  const counts = {};
  counts.candidateMessages = num((await q('SELECT COUNT(*) n FROM "CandidateMessage" WHERE "providerRef" LIKE ?', like))[0].n);
  await run('DELETE FROM "CandidateMessage" WHERE "providerRef" LIKE ?', like);
  counts.conversationMessages = num((await q('SELECT COUNT(*) n FROM "ConversationMessage" WHERE "providerRef" LIKE ?', like))[0].n);
  await run('DELETE FROM "ConversationMessage" WHERE "providerRef" LIKE ?', like);
  await run('DELETE FROM "WaChatMedia" WHERE "providerRef" LIKE ?', like);
  counts.media = media.length;
  // the number threads and message map
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    if (await WN.tableReady()) {
      const mapped = await q('SELECT DISTINCT "numberId","contact" FROM "WaMessageMap" WHERE "providerRef" LIKE ?', like);
      await run('DELETE FROM "WaMessageMap" WHERE "providerRef" LIKE ?', like);
      for (const m of mapped) {
        // eslint-disable-next-line no-await-in-loop
        const left = num((await q('SELECT COUNT(*) n FROM "WaMessageMap" WHERE "numberId" = ? AND "contact" = ? AND "direction" = \'IN\'', m.numberId, m.contact))[0].n);
        // eslint-disable-next-line no-await-in-loop
        if (!left) await run('UPDATE "WaThread" SET "lastInboundAt" = NULL, "inboundCount" = 0 WHERE "numberId" = ? AND "contact" = ?', m.numberId, m.contact);
      }
    }
  } catch { /* no number tables */ }
  // the events the router kept
  try { counts.events = num(await run('DELETE FROM "OmniProviderEvent" WHERE "providerEventId" LIKE ?', like)); } catch { counts.events = 0; }
  // each person: put the conversation row, the follow-up text, the window and a STOP mark back as they were
  for (const p of people.values()) {
    // eslint-disable-next-line no-await-in-loop
    await restorePerson(p.type, p.id);
  }
  counts.people = people.size;
  return counts;
}
async function restorePerson(type, id) {
  const t = await convo.getThread(type, id);
  let latest = null; let realWa = 0; let realStop = 0;
  if (type === 'CANDIDATE') {
    latest = await prisma.candidateMessage.findFirst({ where: { candidateId: id }, orderBy: { createdAt: 'desc' } });
    realWa = await prisma.candidateMessage.count({ where: { candidateId: id, channel: 'WhatsApp', status: 'RECEIVED' } });
    realStop = await prisma.candidateMessage.count({ where: { candidateId: id, channel: 'WhatsApp', status: 'RECEIVED', templateLabel: 'Asked us to stop' } });
  } else if (t) {
    latest = (await q('SELECT * FROM "ConversationMessage" WHERE "conversationId" = ? ORDER BY "createdAt" DESC LIMIT 1', t.id))[0] || null;
    realWa = num((await q('SELECT COUNT(*) n FROM "ConversationMessage" WHERE "conversationId" = ? AND "channel" = \'WhatsApp\' AND "direction" = \'IN\'', t.id))[0].n);
  }
  if (t) {
    if (!latest) await run('DELETE FROM "Conversation" WHERE "id" = ?', t.id);
    else {
      const inbound = type === 'CANDIDATE' ? String(latest.status).toUpperCase() === 'RECEIVED' : latest.direction === 'IN';
      await run('UPDATE "Conversation" SET "unread" = 0, "lastMessageAt" = ?, "lastChannel" = ?, "lastDirection" = ?, "lastSnippet" = ?, "updatedAt" = ? WHERE "id" = ?', ms(latest.createdAt), latest.channel === 'Mail' ? 'Email' : latest.channel, inbound ? 'IN' : 'OUT', convo.snippet(latest.body), Date.now(), t.id);
    }
  }
  await run('DELETE FROM "WaChatRead" WHERE "personType" = ? AND "personId" = ?', type, String(id));
  await run('DELETE FROM "WaChatBell" WHERE "personType" = ? AND "personId" = ?', type, String(id));
  await run('DELETE FROM "WaChatMeta" WHERE "personType" = ? AND "personId" = ?', type, String(id));
  if (type === 'CANDIDATE') {
    for (const f of await q('SELECT * FROM "WaChatFlag" WHERE "personId" = ?', String(id))) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationFollowUp.updateMany({ where: { id: f.followUpId, completedAt: null, nextAction: { startsWith: 'Candidate replied on WhatsApp: review' } }, data: { nextAction: f.prevAction || null } }).catch(() => {});
    }
    await run('DELETE FROM "WaChatFlag" WHERE "personId" = ?', String(id));
  }
  const phone = type === 'CANDIDATE' ? (await prisma.candidate.findUnique({ where: { id }, select: { phone: true } }).catch(() => null)) : null;
  const e164 = phone ? e164Of(phone.phone) : '';
  if (e164 && !realWa) await prisma.appSetting.deleteMany({ where: { key: `wa.window.${e164}` } }).catch(() => {});
  if (e164 && !realStop) await prisma.appSetting.deleteMany({ where: { key: `msg.optout.WhatsApp.${e164}` } }).catch(() => {});
}

module.exports = {
  ensure, featureSince, WORDS, plainFailure, isAdminLike, isLead, testState, TEST_PREFIX, PLACEHOLDER, INTENTS, MIME_OK, BELL_GAP,
  chatMessages, tickUpdates, unreadMap, unreadCount, markRead, listChats, sendingState, personFacts, e164Of,
  inboundMedia, mediaWords, mediaRow, mediaPath, notifyReply, flagFollowUps, afterReply, setIntent, simulateReply, removeTestMessages,
};
