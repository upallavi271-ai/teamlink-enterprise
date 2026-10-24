// ---------------------------------------------------------------------------
// OMNI-CHANNEL BOT (Bot Builder + WhatsApp Bot Data). A small, honest keyword bot for WhatsApp.
//
// A FLOW = trigger words (match ANY of them inside the message, or the EXACT message) + an optional condition (the message has a number of N digits /
// it came in business hours / it came after business hours) + one action (send an auto-reply text, or HAND OFF to a person) + what to do when the
// condition is not met (stay quiet, or hand off). Flows are OFF when they are made.
//
// WHEN CAN IT REALLY ANSWER?  Only when ALL of these are true:
//   1. the flow is On,  2. the Admin switch "Bot auto-replies" (AppSetting 'omni.bots' { enabled }, default OFF) is On,  3. Test mode is OFF
//   (Settings > Sending rules, the same Test mode the campaigns use),  4. the person has WhatsApp permission ("opted in", not on the stop list),
//   5. the person who owns the chat (or the flow's maker) still has credits.  The reply goes through utils/messaging.js send('WhatsApp') as a plain
//   session text (the person has just written to us, so the 24-hour window is open).  If 1-3 are not all true the bot only WRITES THE LOG LINE
//   "Would have replied (Test mode)" and sends NOTHING.
// SAFETY: never replies to a person who opted out; STOP / unsubscribe messages are never answered by a flow and ALWAYS opt the person out of WhatsApp
// (consent.js), whatever the flows or switches say; at most ONE auto-reply per chat per 10 minutes and 5 per day; after a hand-off the bot stays quiet
// in that chat for 24 hours; the log never stores the customer's words, only the trigger word that matched.
//
// HOOK: utils/conversations.js recordIn() calls onInbound({ personType, personId, channel, body, address }) fire-and-forget inside a try / catch.
// Tables (self-provisioned, migration 20261017140000_omni_gs_automation_bots): OmniBotFlow, OmniBotLog, OmniBotConv.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const K = require('./contacts');
const C = require('./consent');
const Cr = require('./credits');
const { logAudit } = require('../utils/audit');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = S.num;
const SWITCH_KEY = 'omni.bots';
const THROTTLE_MS = 10 * 60000;
const MUTE_MS = 24 * 3600000;
const DAILY_MAX = 5;
const MAX_FLOWS = 50;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IST = 5.5 * 3600 * 1000;

const OUTCOME = {
  replied: ['live', 'Replied by the bot'],
  would_reply: ['scheduled', 'Would have replied (Test mode)'],
  handed_off: ['warn', 'Handed to a person'],
  would_handoff: ['scheduled', 'Would have handed over (Test mode)'],
  blocked: ['red', 'Not replied'],
};
const COND_WORDS = { none: 'No condition', number: 'The message has a number', hours: 'It came in business hours', after_hours: 'It came after business hours' };

const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniBotFlow" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "channel" TEXT NOT NULL DEFAULT \'whatsapp\', "status" TEXT NOT NULL DEFAULT \'off\', "keywords" TEXT NOT NULL DEFAULT \'[]\', "matchMode" TEXT NOT NULL DEFAULT \'any\', "cond" TEXT NOT NULL DEFAULT \'{}\', "act" TEXT NOT NULL DEFAULT \'{}\', "otherwise" TEXT NOT NULL DEFAULT \'nothing\', "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "deletedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS "OmniBotLog" ("id" TEXT NOT NULL PRIMARY KEY, "flowId" TEXT, "flowName" TEXT, "personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "personName" TEXT, "department" TEXT, "matched" TEXT, "outcome" TEXT NOT NULL, "reason" TEXT, "at" DATETIME NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS "OmniBotLog_flow" ON "OmniBotLog"("flowId", "at")',
  'CREATE INDEX IF NOT EXISTS "OmniBotLog_person" ON "OmniBotLog"("personType", "personId", "at")',
  'CREATE TABLE IF NOT EXISTS "OmniBotConv" ("personType" TEXT NOT NULL, "personId" TEXT NOT NULL, "lastLiveAt" DATETIME, "lastDryAt" DATETIME, "mutedUntil" DATETIME, "turns" INTEGER NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, PRIMARY KEY ("personType", "personId"))',
];
let okAt = 0; let ensuring = null;
async function ensureTables() {
  if (okAt) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try { for (const sql of DDL) await run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-bots] tables:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}

// ---- who may do what --------------------------------------------------------------------------------------------------------
const mayManage = (u) => ['admin', 'bdetl', 'bde', 'tl', 'marketing', 'hr'].includes(A.kind(u));
const seesBots = (u) => A.hubsFor(u).automation === true && A.kind(u) !== 'none';
function mayRead(u, f) {
  if (!seesBots(u)) return false;
  const k = A.kind(u);
  if (k === 'admin' || k === 'view') return true;
  return f.createdById === u.id || !f.department || A.mayDepartment(u, f.department);
}
const mayEdit = (u, f) => mayManage(u) && (A.isAdmin(u) || f.createdById === u.id);

// ---- the words ----------------------------------------------------------------------------------------------------------------------
const norm = (t) => ` ${String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
const STOP_EXACT = /^\s*(stop|stop all|stopall|unsubscribe|cancel|end|quit|opt[- ]?out|do not message|don'?t message|dont message|remove me|no more messages)\s*[.!]?\s*$/i;
const STOP_PHRASE = /\b(unsubscribe|stop (messaging|texting|sending|contacting|whatsapp|the messages)|do not (contact|message) me|don'?t (contact|message) me|remove my number)\b/i;
const isStop = (t) => STOP_EXACT.test(String(t || '')) || STOP_PHRASE.test(String(t || ''));
const fill = (text, name) => String(text || '').replace(/\{\{\s*first_name\s*\}\}/g, String(name || '').trim().split(/\s+/)[0] || 'there').replace(/\{\{\s*name\s*\}\}/g, name || 'there').replace(/\{\{[^}]*\}\}/g, '').trim();
const clipText = (s, n) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, n);
const minutesOf = (hm) => { const m = HM.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const istMinute = (now) => Math.floor((((now + IST) % 86400000) + 86400000) % 86400000 / 60000);
function inHours(now, start, end) {
  const s = minutesOf(start); const e = minutesOf(end); const m = istMinute(now);
  if (s == null || e == null || s === e) return false;
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

// ---- validate -------------------------------------------------------------------------------------------------------------------------
function cleanKeywords(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]/)).map((x) => clipText(x, 40)).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const w of list) { const n = norm(w).trim(); if (n && !seen.has(n)) { seen.add(n); out.push(w); } }
  if (!out.length) return { error: 'Add at least one trigger word or phrase.' };
  if (out.length > 12) return { error: 'Use at most 12 trigger words.' };
  if (out.some((w) => norm(w).trim().length < 2)) return { error: 'Each trigger word needs at least 2 letters.' };
  if (out.some((w) => isStop(w) || STOP_EXACT.test(w))) return { error: 'STOP, unsubscribe and cancel are never answered by a bot: they always stop messages to that person. Pick another word.' };
  return { keywords: out };
}
function cleanCond(c) {
  const b = c && typeof c === 'object' ? c : {};
  const type = COND_WORDS[b.type] ? b.type : 'none';
  if (type === 'number') { const d = Math.floor(Number(b.digits)); return { cond: { type, digits: d >= 2 && d <= 12 ? d : 4 } }; }
  if (type === 'hours' || type === 'after_hours') {
    const start = HM.test(String(b.start || '')) ? b.start : '09:30'; const end = HM.test(String(b.end || '')) ? b.end : '18:30';
    if (start === end) return { error: 'Business hours cannot start and end at the same time.' };
    return { cond: { type, start, end } };
  }
  return { cond: { type: 'none' } };
}
function cleanAct(a) {
  const b = a && typeof a === 'object' ? a : {};
  if (b.type === 'handoff') return { act: { type: 'handoff', text: clipText(b.text, 500) } };
  const text = clipText(b.text, 1000);
  if (!text) return { error: 'Write the reply the bot sends.' };
  return { act: { type: 'reply', text } };
}

// ---- reading flows ---------------------------------------------------------------------------------------------------------------------
function nodesOf(f) {
  const nodes = [{ kind: 'Trigger', tone: 'green', title: f.matchMode === 'exact' ? 'Exact message' : 'Keyword match', detail: f.keywords.map((k) => `"${k}"`).join(', ') }];
  if (f.cond.type !== 'none') {
    const t = f.cond.type;
    nodes.push({ kind: 'Condition', tone: '', title: t === 'number' ? 'Has a number?' : (t === 'hours' ? 'Business hours?' : 'After hours?'), detail: t === 'number' ? `Checks the message for a number of ${f.cond.digits} or more digits` : `${t === 'hours' ? 'Between' : 'Outside'} ${f.cond.start} and ${f.cond.end} (India time)` });
  }
  nodes.push(f.act.type === 'handoff'
    ? { kind: 'Action', tone: 'green', title: 'Hand off to a person', detail: 'Goes to the person who owns the chat' }
    : { kind: 'Action', tone: 'green', title: 'Send auto-reply', detail: clipText(f.act.text, 80) });
  if (f.cond.type !== 'none') nodes.push({ kind: 'Branch', tone: 'orange', title: 'Not matched?', detail: f.otherwise === 'handoff' ? 'Hand to a person' : 'Stay quiet' });
  nodes.push(f.act.type === 'handoff' || f.otherwise === 'handoff'
    ? { kind: 'Goal', tone: 'green', title: 'With a person', detail: 'The bot stays quiet in this chat for 24 hours' }
    : { kind: 'Goal', tone: 'green', title: 'Answered', detail: 'At most one reply per chat every 10 minutes' });
  return nodes;
}
function viewOf(r, counts = {}) {
  const f = {
    id: r.id, name: r.name, channel: 'whatsapp', channelWords: 'WhatsApp', status: r.status === 'on' ? 'on' : 'off', statusWords: r.status === 'on' ? 'On' : 'Off',
    keywords: S.parse(r.keywords, []), matchMode: r.matchMode === 'exact' ? 'exact' : 'any', cond: { type: 'none', ...S.parse(r.cond, {}) }, act: { type: 'reply', text: '', ...S.parse(r.act, {}) },
    otherwise: r.otherwise === 'handoff' ? 'handoff' : 'nothing', department: r.department || '', createdByName: r.createdByName || '', updatedAt: S.iso(r.updatedAt),
  };
  return { ...f, nodes: nodesOf(f), uses: counts.uses || 0, handled: counts.handled || 0, lastAt: counts.lastAt || null };
}
async function rawFlows(where = '') { await ensureTables(); return q(`SELECT * FROM "OmniBotFlow" WHERE deletedAt IS NULL ${where} ORDER BY createdAt, id`); }
async function getFlow(user, id) {
  await ensureTables();
  const row = (await q('SELECT * FROM "OmniBotFlow" WHERE id = ? AND deletedAt IS NULL', id))[0];
  return row && mayRead(user, row) ? row : null;
}
const monthRange = () => Cr.range(Cr.thisMonth());
async function monthCounts(ids) {
  const out = {};
  ids.forEach((id) => { out[id] = { uses: 0, handled: 0, lastAt: null }; });
  if (!ids.length) return out;
  const { from, to } = monthRange();
  const ph = ids.map(() => '?').join(',');
  const a = await q(`SELECT flowId, COUNT(*) n, MAX(at) last FROM "OmniBotLog" WHERE flowId IN (${ph}) AND at >= ? AND at < ? GROUP BY flowId`, ...ids, from, to);
  a.forEach((r) => { out[r.flowId].uses = num(r.n); out[r.flowId].lastAt = S.iso(r.last); });
  const b = await q(`SELECT flowId, COUNT(DISTINCT personType || ':' || personId) n FROM "OmniBotLog" WHERE flowId IN (${ph}) AND outcome IN ('replied','handed_off') AND at >= ? AND at < ? GROUP BY flowId`, ...ids, from, to);
  b.forEach((r) => { out[r.flowId].handled = num(r.n); });
  return out;
}
async function visibleFlows(user, dept) {
  const want = String(dept || '').trim().toLowerCase();
  return (await rawFlows()).filter((r) => mayRead(user, r) && (!want || !r.department || String(r.department).toLowerCase() === want));
}

// ---- the Admin switch -----------------------------------------------------------------------------------------------------------------------
async function getSwitch() { const v = await S.getKey(SWITCH_KEY, {}); return { enabled: !!(v && v.enabled === true) }; }
async function setSwitch(user, on) {
  if (!A.isAdmin(user)) return { error: 'Only an Admin can switch bot auto-replies on or off.', status: 403 };
  await S.putKey(SWITCH_KEY, { enabled: !!on }, user);
  await logAudit({ userId: user.id, actorName: user.name, action: on ? 'Omni-Channel bot auto-replies switched ON' : 'Omni-Channel bot auto-replies switched OFF', entity: 'AppSetting', entityId: SWITCH_KEY, toValue: on ? 'on' : 'off' });
  return { enabled: !!on };
}
// the one honest answer to "would a bot really answer right now?"
async function liveState() {
  const st = await S.settings(); const sw = await getSwitch();
  const testMode = st.emailTestMode !== false;
  const live = sw.enabled && !testMode;
  const why = live ? 'Live: flows that are On answer for real (only people with WhatsApp permission).' : (testMode && !sw.enabled ? 'Test mode is on and the Admin switch is off: nothing is sent, flows only write what they would have said.' : (testMode ? 'Test mode is on: nothing is sent, flows only write what they would have said.' : 'The Admin switch "Bot auto-replies" is off: nothing is sent, flows only write what they would have said.'));
  return { live, switchOn: sw.enabled, testMode, words: why };
}

// ---- the flows list (Bot Builder) ------------------------------------------------------------------------------------------------------------
async function list(user, dept = '') {
  if (!seesBots(user)) return { error: 'The bot is not for your login.', status: 403 };
  const rows = await visibleFlows(user, dept);
  const counts = await monthCounts(rows.map((r) => r.id));
  return { flows: rows.map((r) => ({ ...viewOf(r, counts[r.id]), canEdit: mayEdit(user, r) })), canManage: mayManage(user), state: await liveState(), canSwitch: A.isAdmin(user), maxFlows: MAX_FLOWS };
}
async function save(user, id, b) {
  await ensureTables();
  if (!mayManage(user)) return { error: 'You can look at bot flows, but only the BDE team, Team Leads, HR, Marketing and Admins can make them.', status: 403 };
  const cur = id ? (await q('SELECT * FROM "OmniBotFlow" WHERE id = ? AND deletedAt IS NULL', id))[0] : null;
  if (id && (!cur || !mayRead(user, cur))) return { error: 'This bot flow was not found.', status: 404 };
  if (cur && !mayEdit(user, cur)) return { error: 'Only the person who made it, or an Admin, can change it.', status: 403 };
  const old = cur ? viewOf(cur) : null;
  const name = S.clip(b.name !== undefined ? b.name : (old && old.name), 80);
  if (!name) return { error: 'Give the flow a name.', status: 400 };
  const dup = (await rawFlows()).find((r) => String(r.name).toLowerCase() === name.toLowerCase() && r.id !== (cur && cur.id));
  if (dup) return { error: 'A bot flow with that name already exists.', status: 400 };
  const kw = cleanKeywords(b.keywords !== undefined ? b.keywords : (old && old.keywords)); if (kw.error) return { error: kw.error, status: 400 };
  const cd = cleanCond(b.cond !== undefined ? b.cond : (old && old.cond)); if (cd.error) return { error: cd.error, status: 400 };
  const ac = cleanAct(b.act !== undefined ? b.act : (old && old.act)); if (ac.error) return { error: ac.error, status: 400 };
  const matchMode = (b.matchMode !== undefined ? b.matchMode : (old && old.matchMode)) === 'exact' ? 'exact' : 'any';
  const otherwise = cd.cond.type !== 'none' && (b.otherwise !== undefined ? b.otherwise : (old && old.otherwise)) === 'handoff' ? 'handoff' : 'nothing';
  const dept = S.clip(b.department !== undefined ? b.department : (old && old.department), 60);
  if (!A.isAdmin(user) && !dept) return { error: 'Pick the department this bot answers for.', status: 400 };
  if (dept && !A.mayDepartment(user, dept)) return { error: 'That department is not yours.', status: 403 };
  const now = Date.now();
  if (cur) {
    await run('UPDATE "OmniBotFlow" SET name = ?, keywords = ?, matchMode = ?, cond = ?, act = ?, otherwise = ?, department = ?, updatedAt = ? WHERE id = ?', name, JSON.stringify(kw.keywords), matchMode, JSON.stringify(cd.cond), JSON.stringify(ac.act), otherwise, dept || null, now, cur.id);
    await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel bot flow changed', entity: 'OmniBotFlow', entityId: cur.id, toValue: name });
    return { flow: viewOf((await q('SELECT * FROM "OmniBotFlow" WHERE id = ?', cur.id))[0]) };
  }
  if ((await rawFlows()).length >= MAX_FLOWS) return { error: `There are already ${MAX_FLOWS} bot flows. Remove one you do not use.`, status: 400 };
  const nid = S.newId('obf');
  await run('INSERT INTO "OmniBotFlow" (id, name, channel, status, keywords, matchMode, cond, act, otherwise, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,\'whatsapp\',\'off\',?,?,?,?,?,?,?,?,?,?)', nid, name, JSON.stringify(kw.keywords), matchMode, JSON.stringify(cd.cond), JSON.stringify(ac.act), otherwise, dept || null, user.id, user.name, now, now);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel bot flow made (Off)', entity: 'OmniBotFlow', entityId: nid, toValue: name });
  return { flow: viewOf((await q('SELECT * FROM "OmniBotFlow" WHERE id = ?', nid))[0]) };
}
async function toggle(user, id, on) {
  const r = await getFlow(user, id);
  if (!r) return { error: 'This bot flow was not found.', status: 404 };
  if (!mayEdit(user, r)) return { error: 'You cannot switch this one.', status: 403 };
  await run('UPDATE "OmniBotFlow" SET status = ?, updatedAt = ? WHERE id = ?', on ? 'on' : 'off', Date.now(), id);
  await logAudit({ userId: user.id, actorName: user.name, action: on ? 'Omni-Channel bot flow switched on' : 'Omni-Channel bot flow switched off', entity: 'OmniBotFlow', entityId: id, toValue: r.name });
  const ls = await liveState();
  return { ok: on ? `${r.name} is On. ${ls.live ? 'It answers for real.' : 'It only writes what it would have said until an Admin switches bot auto-replies on and Test mode is off.'}` : `${r.name} is Off.`, state: ls };
}
async function remove(user, id) {
  const r = await getFlow(user, id);
  if (!r) return { error: 'This bot flow was not found.', status: 404 };
  if (!mayEdit(user, r)) return { error: 'You cannot remove this one.', status: 403 };
  await run('UPDATE "OmniBotFlow" SET deletedAt = ?, status = \'off\' WHERE id = ?', Date.now(), id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel bot flow removed', entity: 'OmniBotFlow', entityId: id, toValue: r.name });
  return { ok: 'Removed.' };
}

// ---- matching (pure) ---------------------------------------------------------------------------------------------------------------------------------
// -> { match: bool, keyword, condOk: bool|null, act: 'reply'|'handoff'|null }
function evaluate(f, body, now = Date.now()) {
  const text = norm(body);
  let keyword = null;
  for (const k of f.keywords) {
    const n = norm(k).trim();
    if (!n) continue; // eslint-disable-line no-continue
    if (f.matchMode === 'exact' ? text.trim() === n : text.includes(` ${n} `)) { keyword = k; break; }
  }
  if (!keyword) return { match: false, keyword: null, condOk: null, act: null };
  const c = f.cond || { type: 'none' };
  let condOk = true;
  if (c.type === 'number') condOk = new RegExp(`\\d{${c.digits || 4},}`).test(String(body || '').replace(/(\d)[\s-](?=\d)/g, '$1'));
  else if (c.type === 'hours') condOk = inHours(now, c.start, c.end);
  else if (c.type === 'after_hours') condOk = !inHours(now, c.start, c.end);
  if (condOk) return { match: true, keyword, condOk: true, act: f.act.type };
  return { match: true, keyword, condOk: false, act: f.otherwise === 'handoff' ? 'handoff' : null };
}
const doesWords = (e, f) => {
  if (!e.match) return 'No: this message does not contain any of the trigger words, so this flow stays quiet.';
  if (e.act === 'reply') return `Yes: it matches "${e.keyword}"${f.cond.type !== 'none' ? ' and the condition is met' : ''}. The bot would send the auto-reply.`;
  if (e.act === 'handoff') return `Yes: it matches "${e.keyword}"${e.condOk === false ? ' but the condition is not met' : ''}. The bot would hand the chat to a person.`;
  return `It matches "${e.keyword}" but the condition is not met, so the bot stays quiet.`;
};
// "Try a message": nothing is sent, nothing is logged
async function simulate(user, id, text) {
  const r = await getFlow(user, id);
  if (!r) return { error: 'This bot flow was not found.', status: 404 };
  const f = viewOf(r);
  const msg = clipText(text, 500);
  if (!msg) return { error: 'Type a message to try.', status: 400 };
  if (isStop(msg)) return { stop: true, words: 'This is a STOP message. A bot never answers it: the person is opted out of WhatsApp and nothing is sent.' };
  const e = evaluate(f, msg);
  return { match: e.match, keyword: e.keyword, condOk: e.condOk, act: e.act, words: doesWords(e, f) };
}

// ---- the person behind a message ----------------------------------------------------------------------------------------------------------------------
async function personCtx(personType, personId, address) {
  const t = (await q('SELECT "personName", "department", "ownerUserId", "ownerName" FROM "Conversation" WHERE "personType" = ? AND "personId" = ?', personType, String(personId)).catch(() => []))[0] || {};
  let phone = address || null;
  if (!phone) {
    try {
      if (personType === 'CANDIDATE') phone = ((await prisma.candidate.findUnique({ where: { id: String(personId) }, select: { phone: true } })) || {}).phone;
      else if (personType === 'CLIENT') { const c = await prisma.client.findUnique({ where: { id: String(personId) }, select: { contactWhatsApp: true, contactPhone: true } }); phone = c && (c.contactWhatsApp || c.contactPhone); } else if (personType === 'EMPLOYEE') phone = ((await prisma.employee.findUnique({ where: { id: String(personId) }, select: { phone: true } })) || {}).phone;
    } catch { phone = null; }
  }
  return { name: t.personName || '', department: t.department || '', ownerUserId: t.ownerUserId || null, ownerName: t.ownerName || null, phone };
}
// NOTE: explicit columns, never SELECT *: a raw SELECT * on OutreachContact fails once outreach/replies.js has stored lastReplyAt (an INTEGER column holding
// milliseconds, which Prisma cannot read back through a raw query). The STOP path and the permission check must keep working whatever the column holds.
async function contactFor(phone) {
  const p = K.phoneOf(phone);
  if (!p.ok) return null;
  const rows = await q("SELECT id, phoneE164, contactType FROM \"OutreachContact\" WHERE phoneKey = ? AND status = 'active' ORDER BY createdAt DESC", p.key);
  return rows[0] ? { row: rows[0], e164: p.e164 } : null;
}
// the same rule as consent.js canMessage(), written with explicit columns (see above)
async function permission(contactId) {
  const c = (await q('SELECT id, phoneE164, status FROM "OutreachContact" WHERE id = ?', contactId))[0];
  if (!c || c.status !== 'active') return { ok: false, reason: 'gone' };
  const hash = S.hashAddress('phone', c.phoneE164);
  if (!hash) return { ok: false, reason: 'no_address' };
  if (await C.isSuppressedHash(hash, 'whatsapp') || await C.isSuppressedHash(hash, '*')) return { ok: false, reason: 'suppressed' };
  const row = (await q("SELECT optIn, health FROM \"OutreachContactChannel\" WHERE contactId = ? AND channel = 'whatsapp'", contactId))[0];
  if (!row || row.optIn !== 'opted_in') return { ok: false, reason: row && row.optIn === 'opted_out' ? 'opted_out' : 'no_opt_in' };
  if (row.health && row.health !== 'ok') return { ok: false, reason: 'bad_address' };
  return { ok: true };
}
// STOP: consent.js does it; if that cannot read the contact the same steps are done by hand, so a STOP is never lost
async function optOutWhatsApp(contactId, now) {
  try { const r = await C.optOut(contactId, 'whatsapp', { reason: 'stop_reply', source: 'whatsapp_stop', evidence: 'Replied STOP on WhatsApp', by: null }); return !!(r && r.changed && r.changed.length); } catch { /* the by-hand steps below */ }
  const c = (await q('SELECT id, phoneE164 FROM "OutreachContact" WHERE id = ?', contactId))[0];
  if (!c || !c.phoneE164) return false;
  const hash = S.hashAddress('phone', c.phoneE164);
  await C.suppress(hash, 'whatsapp', 'stop_reply', 'whatsapp_stop');
  const row = (await q("SELECT id, optIn FROM \"OutreachContactChannel\" WHERE contactId = ? AND channel = 'whatsapp'", contactId))[0];
  if (row && row.optIn === 'opted_out') return false;
  if (row) await run("UPDATE \"OutreachContactChannel\" SET optIn = 'opted_out', optOutAt = ?, optOutReason = 'stop_reply' WHERE id = ?", now, row.id);
  else await run('INSERT INTO "OutreachContactChannel" (id, contactId, channel, address, optIn, optOutAt, optOutReason) VALUES (?,?,?,?,?,?,?)', S.newId('occ'), contactId, 'whatsapp', c.phoneE164, 'opted_out', now, 'stop_reply');
  await C.recordEvent({ contactId, hash, channel: 'whatsapp', action: 'opt_out', source: 'whatsapp_stop', evidence: 'Replied STOP on WhatsApp', at: now });
  await run('UPDATE "OutreachContact" SET unsubscribedAt = ?, updatedAt = ? WHERE id = ?', now, now, contactId);
  return true;
}

// ---- state per chat ------------------------------------------------------------------------------------------------------------------------------------
async function convOf(type, id) { return (await q('SELECT * FROM "OmniBotConv" WHERE personType = ? AND personId = ?', type, String(id)))[0] || null; }
async function touchConv(type, id, patch, now) {
  await run('INSERT OR IGNORE INTO "OmniBotConv" (personType, personId, turns, updatedAt) VALUES (?,?,0,?)', type, String(id), now);
  const sets = ['updatedAt = ?']; const vals = [now];
  if (patch.live) { sets.push('lastLiveAt = ?', 'turns = turns + 1'); vals.push(now); }
  if (patch.dry) { sets.push('lastDryAt = ?'); vals.push(now); }
  if (patch.mute) { sets.push('mutedUntil = ?'); vals.push(now + MUTE_MS); }
  await run(`UPDATE "OmniBotConv" SET ${sets.join(', ')} WHERE personType = ? AND personId = ?`, ...vals, type, String(id));
}
const logRow = (f, who, ctx, kw, outcome, reason, now) => run('INSERT INTO "OmniBotLog" (id, flowId, flowName, personType, personId, personName, department, matched, outcome, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', S.newId('obl'), f ? f.id : null, f ? f.name : null, who.personType, String(who.personId), S.clip(ctx.name, 120) || null, ctx.department || null, S.clip(kw, 60) || null, outcome, S.clip(reason, 200) || null, now);

// ---- STOP: always opt the person out (consent.js), never answer ---------------------------------------------------------------------------------------------------
async function optOutFor(who, ctx, now) {
  const ct = ctx.phone ? await contactFor(ctx.phone) : null;
  const changed = ct ? await optOutWhatsApp(ct.row.id, now) : false;
  await touchConv(who.personType, who.personId, { mute: true }, now);
  return { stop: true, optedOut: changed, known: !!ct };
}

// ---- the hand-off ------------------------------------------------------------------------------------------------------------------------------------------------------
async function handoff(who, ctx, f, now) {
  const uid = ctx.ownerUserId || f.createdById || null;
  if (!ctx.ownerUserId && uid) {
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { name: true } }).catch(() => null);
    await run('UPDATE "Conversation" SET "ownerUserId" = ?, "ownerName" = ? WHERE "personType" = ? AND "personId" = ? AND "ownerUserId" IS NULL', uid, (u && u.name) || null, who.personType, String(who.personId)).catch(() => {});
  }
  if (uid) {
    await require('../utils/notify').pushNotification({ userId: uid, title: `The bot passed ${ctx.name || 'a chat'} to you (WhatsApp)`, message: 'Open Follow-ups > Inbox and reply to them.' }).catch(() => null); // eslint-disable-line global-require
  }
  await touchConv(who.personType, who.personId, { mute: true }, now);
  return { assignedTo: uid };
}

// ---- send the text for real (all gates already passed except consent and credits) -------------------------------------------------------------------------------------------
async function sendReal(who, ctx, f, text, now) {
  const ct = ctx.phone ? await contactFor(ctx.phone) : null;
  if (!ct) return { ok: false, reason: 'No WhatsApp permission recorded: this person is not in Contacts' };
  const can = await permission(ct.row.id);
  if (!can.ok) return { ok: false, reason: { opted_out: 'The person stopped WhatsApp messages', suppressed: 'The person is on the do-not-contact list', no_opt_in: 'No WhatsApp permission recorded for this person', no_address: 'No WhatsApp number', bad_address: 'The WhatsApp number does not work', gone: 'The contact was removed' }[can.reason] || 'No WhatsApp permission' };
  try { if (await require('../utils/messageDelivery').optedOut('WhatsApp', ct.e164)) return { ok: false, reason: 'The person replied STOP on WhatsApp earlier' }; } catch { /* the old list is optional */ } // eslint-disable-line global-require
  const actor = ctx.ownerUserId || f.createdById || null;
  const g = await Cr.guard({ userId: actor, channel: 'whatsapp', mode: 'live', now });
  if (!g.ok) return { ok: false, reason: `No credits: ${g.message}` };
  const body = fill(text, ctx.name);
  const res = await require('../utils/messaging').send('WhatsApp', { to: ct.e164, kind: 'text', text: body, vars: [body], actorUserId: actor, ...(ctx.numberId ? { numberId: ctx.numberId, automatic: true } : {}), meta: { purpose: 'bot', template: f.name, personName: ctx.name } }); // eslint-disable-line global-require
  if (!res.ok) return { ok: false, reason: S.clip(res.error || 'The provider did not accept it', 160) };
  try {
    if (who.personType === 'CANDIDATE') {
      await prisma.candidateMessage.create({ data: { candidateId: String(who.personId), channel: 'WhatsApp', template: 'BOT', templateLabel: `Auto-reply: ${f.name}`, trigger: 'Bot', recipient: `+${ct.e164}`, body, status: 'SENT', statusDetail: 'Sent by the bot', senderName: 'Bot', providerRef: res.providerRef || null, sentAt: new Date(now) } });
    }
    await require('../utils/conversations').recordOut({ personType: who.personType, personId: who.personId, personName: ctx.name, channel: 'WhatsApp', body, address: `+${ct.e164}`, status: 'SENT', statusDetail: 'Sent by the bot', providerRef: res.providerRef || null, templateLabel: `Bot: ${f.name}`, senderName: 'Bot' }); // eslint-disable-line global-require
  } catch { /* the message went; the timeline line is a courtesy */ }
  return { ok: true };
}

// ---- THE ENGINE: one inbound message ------------------------------------------------------------------------------------------------------------------------------------------
// m: { personType, personId, channel, body, address }.  opts.now for tests.  Never throws.  -> { outcome, flowId } | { skipped } | { stop }
async function onInbound(m, opts = {}) {
  try { return await handle(m || {}, opts.now || Date.now()); } catch (e) { console.error('[omni-bots]', e && e.message); return { error: true }; } // eslint-disable-line no-console
}
async function handle(m, now) {
  if (String(m.channel || '').toLowerCase() !== 'whatsapp' || !m.personType || !m.personId) return { skipped: 'channel' };
  if (!(await ensureTables())) return { skipped: 'not_ready' };
  const who = { personType: String(m.personType), personId: String(m.personId) };
  const body = String(m.body || '');
  if (isStop(body)) return optOutFor(who, await personCtx(who.personType, who.personId, m.address), now);
  const flows = (await rawFlows('AND status = \'on\'')).map((r) => ({ ...viewOf(r), createdById: r.createdById }));
  if (!flows.length) return { skipped: 'no_flows' };
  const ctx = await personCtx(who.personType, who.personId, m.address);
  ctx.numberId = m.numberId || null; // the WhatsApp number the person wrote to: the answer leaves from the same one (utils/waNumbers.js)
  let pick = null;
  for (const f of flows) {
    if (f.department && (!ctx.department || String(f.department).toLowerCase() !== String(ctx.department).toLowerCase())) continue; // eslint-disable-line no-continue
    const e = evaluate(f, body, now);
    if (e.match && e.act) { pick = { f, e }; break; }
  }
  if (!pick) return { skipped: 'no_match' };
  const { f, e } = pick;
  const conv = await convOf(who.personType, who.personId);
  if (conv && num(S.ms(conv.mutedUntil)) > now) return { skipped: 'muted' };
  if (conv && (now - (S.ms(conv.lastLiveAt) || 0) < THROTTLE_MS || now - (S.ms(conv.lastDryAt) || 0) < THROTTLE_MS)) return { skipped: 'throttled' };
  const ls = await liveState();
  const isHand = e.act === 'handoff';
  if (!ls.live) {
    await logRow(f, who, ctx, e.keyword, isHand ? 'would_handoff' : 'would_reply', ls.testMode ? 'Test mode is on: nothing was sent' : 'The Admin switch "Bot auto-replies" is off: nothing was sent', now);
    await touchConv(who.personType, who.personId, { dry: true }, now);
    return { outcome: isHand ? 'would_handoff' : 'would_reply', flowId: f.id, sent: false };
  }
  const day = num((await q('SELECT COUNT(*) n FROM "OmniBotLog" WHERE personType = ? AND personId = ? AND outcome = \'replied\' AND at >= ?', who.personType, who.personId, now - 86400000))[0].n);
  if (day >= DAILY_MAX) { await logRow(f, who, ctx, e.keyword, 'blocked', `Already replied ${DAILY_MAX} times in the last day`, now); return { outcome: 'blocked', flowId: f.id, sent: false }; }
  if (isHand) {
    const h = await handoff(who, ctx, f, now);
    let note = h.assignedTo ? 'The chat is with its owner' : 'Nobody owns this chat yet: it waits in the Inbox';
    let sent = false;
    if (f.act.type === 'handoff' && f.act.text && e.condOk !== false) {
      const r = await sendReal(who, ctx, f, f.act.text, now);
      sent = r.ok; note += r.ok ? '. A short note was sent to the person' : `. The short note was not sent: ${r.reason}`;
    }
    await logRow(f, who, ctx, e.keyword, 'handed_off', note, now);
    if (sent) await touchConv(who.personType, who.personId, { live: true }, now);
    return { outcome: 'handed_off', flowId: f.id, sent };
  }
  const r = await sendReal(who, ctx, f, f.act.text, now);
  if (!r.ok) { await logRow(f, who, ctx, e.keyword, 'blocked', r.reason, now); return { outcome: 'blocked', flowId: f.id, sent: false, reason: r.reason }; }
  await logRow(f, who, ctx, e.keyword, 'replied', '', now);
  await touchConv(who.personType, who.personId, { live: true }, now);
  return { outcome: 'replied', flowId: f.id, sent: true };
}

// ---- WhatsApp Bot Data (the monitor) ---------------------------------------------------------------------------------------------------------------------------------------------------------
async function data(user, dept = '') {
  if (!seesBots(user)) return { error: 'The bot is not for your login.', status: 403 };
  const rows = await visibleFlows(user, dept);
  const ids = rows.map((r) => r.id);
  const counts = await monthCounts(ids);
  const { from, to } = monthRange();
  const ph = ids.map(() => '?').join(',');
  let handled = 0; let resolved = 0; let handed = 0; let dry = 0; let sessions = []; let waiting = [];
  if (ids.length) {
    const per = await q(`SELECT personType, personId, SUM(CASE WHEN outcome = 'replied' THEN 1 ELSE 0 END) r, SUM(CASE WHEN outcome = 'handed_off' THEN 1 ELSE 0 END) h, SUM(CASE WHEN outcome IN ('would_reply','would_handoff') THEN 1 ELSE 0 END) d FROM "OmniBotLog" WHERE flowId IN (${ph}) AND at >= ? AND at < ? GROUP BY personType, personId`, ...ids, from, to);
    per.forEach((p) => { const r = num(p.r); const h = num(p.h); if (r + h > 0) { handled += 1; if (h > 0) handed += 1; else resolved += 1; } else if (num(p.d) > 0) dry += 1; });
    const log = await q(`SELECT l.*, (SELECT COUNT(*) FROM "OmniBotLog" x WHERE x.personType = l.personType AND x.personId = l.personId AND x.at >= ? AND x.at < ?) turns FROM "OmniBotLog" l WHERE l.flowId IN (${ph}) ORDER BY l.at DESC LIMIT 30`, from, to, ...ids);
    sessions = log.map((l) => ({ id: l.id, name: l.personName || 'Unknown', flow: l.flowName || '', intent: l.matched || '', turns: num(l.turns), outcome: l.outcome, outcomeWords: (OUTCOME[l.outcome] || ['draft', l.outcome])[1], tone: (OUTCOME[l.outcome] || ['draft'])[0], reason: l.reason || '', at: S.iso(l.at) }));
    waiting = log.filter((l) => l.outcome === 'handed_off' && num(S.ms(l.at)) > Date.now() - 3 * 86400000).map((l) => ({ id: l.id, name: l.personName || 'Unknown', flow: l.flowName || '', at: S.iso(l.at) }));
  }
  const flows = rows.map((r) => viewOf(r, counts[r.id]));
  return {
    state: await liveState(), canSwitch: A.isAdmin(user), canManage: mayManage(user),
    kpis: { handled, resolvedPct: handled > 0 ? Math.round((resolved / handled) * 1000) / 10 : null, handoffPct: handled > 0 ? Math.round((handed / handled) * 1000) / 10 : null, rehearsed: dry },
    rules: flows.map((f) => ({ id: f.id, phrases: f.keywords, matchMode: f.matchMode, reply: f.act.type === 'handoff' ? 'Hands off to a person in the Inbox' : clipText(f.act.text, 140), uses: f.uses, status: f.status, statusWords: f.statusWords, department: f.department })),
    sessions, waiting,
  };
}

module.exports = { ensureTables, list, save, toggle, remove, simulate, data, getSwitch, setSwitch, liveState, onInbound, isStop, evaluate, mayManage, seesBots, OUTCOME, DAILY_MAX, THROTTLE_MS };
