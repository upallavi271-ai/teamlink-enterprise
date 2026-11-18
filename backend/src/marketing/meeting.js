// ---------------------------------------------------------------------------
// AI MARKETING > PLANS MEETING (founder 2026-11-17: "if I give the link to a WhatsApp number they can get the demo live").
// A person on the team makes a link for a client (name, WhatsApp number, language) and sends it from TeamLink. The client opens it on their phone: an automated assistant shows slides
// and speaks them in English, Telugu or Hindi, answers questions from a fixed list (no live AI), and takes a callback request when asked. Everything the client does is saved here
// so the team sees who watched how far, what they asked and who wants a call; a trial or call request is a bell to the owner of the link.
//   link     /plans-meeting/<id>.<signature>: the signature is an HMAC of the id (MK_MEETING_SECRET, MK_REVIEW_SECRET or JWT_SECRET), so a link cannot be guessed. A page opened WITHOUT a link
//            (/plans-meeting) starts an anonymous session of its own.
//   public   marketing/meeting.js publicView / publicStart / publicEvent (routes/mkMeetingPublic.js), no login, rate limited, nothing shown but the plans.
//   team     create / list / tell (WhatsApp from the company number, same sender rules as every client message) / remove, and the "first ten customers" spots left.
// Nothing here sends anything by itself: only a click on "Send on WhatsApp" does. Words and answers live in the frontend (marketing/meetingContent.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const A = require('../outreach/access');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const TABLE = 'OmniMkMeeting';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT, "phone" TEXT, "language" TEXT NOT NULL DEFAULT 'en', "note" TEXT, "source" TEXT NOT NULL DEFAULT 'invite', "createdById" TEXT, "createdByName" TEXT, "department" TEXT, "sentAt" DATETIME, "sentVia" TEXT, "views" INTEGER NOT NULL DEFAULT 0, "firstOpenedAt" DATETIME, "lastOpenedAt" DATETIME, "startedAt" DATETIME, "lastSlide" INTEGER NOT NULL DEFAULT 0, "maxSlide" INTEGER NOT NULL DEFAULT 0, "finishedAt" DATETIME, "questions" TEXT NOT NULL DEFAULT '[]', "choice" TEXT, "callbackWindow" TEXT, "handoverAt" DATETIME, "expiresAt" DATETIME NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_by" ON "${TABLE}"("createdById", "createdAt")`,
];
// columns added after the first release (an older table gets them here): who called the client and when, and when the team was last alerted. slotAt is DATETIME like the other epoch columns on purpose: a big INTEGER column fails in Prisma raw reads here.
const LATER = [['calledAt', 'DATETIME'], ['calledByName', 'TEXT'], ['callLine', 'TEXT'], ['alertedAt', 'DATETIME'], ['crmLeadId', 'TEXT'], ['summaryAt', 'DATETIME'], ['slotAt', 'DATETIME'], ['slotRemindedAt', 'DATETIME']];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try {
    for (const sql of DDL) await S.run(sql); // eslint-disable-line no-await-in-loop
    const have = new Set((await S.q(`PRAGMA table_info("${TABLE}")`)).map((c) => c.name));
    for (const [name, type] of LATER) if (!have.has(name)) await S.run(`ALTER TABLE "${TABLE}" ADD COLUMN "${name}" ${type}`); // eslint-disable-line no-await-in-loop
    okAt = Date.now(); return true;
  } catch (e) { console.error('[omni-mk] meeting schema:', e.message); return false; } // eslint-disable-line no-console
}

const DAY = 86400000;
const SLIDES = 12; // slide 0 .. 11 (marketing/meetingContent.js)
const LANGS = ['en', 'te', 'hi'];
const CHOICES = ['trial', 'starter', 'growth', 'premium', 'team'];
const WINDOWS = ['asap', 'morning', 'afternoon', 'evening', 'slot'];
const WINDOW_WORDS = { asap: 'as soon as possible', morning: 'morning (9 to 12)', afternoon: 'afternoon (12 to 4)', evening: 'evening (4 to 7)' };
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const secret = () => process.env.MK_MEETING_SECRET || process.env.MK_REVIEW_SECRET || process.env.JWT_SECRET || 'teamlink-dev';
const sigOf = (id) => crypto.createHmac('sha256', secret()).update(`mk-meeting:${id}`).digest('base64url').slice(0, 32);
const tokenOf = (id) => `${id}.${sigOf(id)}`;
function idOfToken(token) {
  const m = /^([A-Za-z0-9]{8,40})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const want = Buffer.from(sigOf(m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}
const newId = () => crypto.randomBytes(8).toString('hex');
const core = () => require('../utils/messagingCore'); // eslint-disable-line global-require

// ---- the "first ten customers" spots (the team keeps the number: nothing counts them yet) ---------------------------------------------------------
const SETTINGS_KEY = 'omni.mk.meeting';
// the demo offered by itself (marketing/meetingOffer.js): ALWAYS off until an Admin switches it on; `numberIds` = the company WhatsApp numbers that offer it, `website` = also to website-form leads
const cleanOffer = (o) => ({ on: !!(o && o.on), website: !!(o && o.website), numberIds: Array.isArray(o && o.numberIds) ? [...new Set(o.numberIds.map((x) => String(x)).filter(Boolean))].slice(0, 20) : [] });
const OFFER_CAP = 150; // at most this many demos offered by itself in 24 hours (marketing/meetingOffer.js)
async function readAll() {
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    const n = Math.floor(Number(v.spotsLeft));
    return { spotsLeft: Number.isFinite(n) && n >= 0 ? Math.min(n, 99) : 10, alerts: v.alerts && typeof v.alerts === 'object' ? v.alerts : {}, answers: Array.isArray(v.answers) ? v.answers : [], offer: cleanOffer(v.offer) };
  } catch { return { spotsLeft: 10, alerts: {}, answers: [], offer: cleanOffer(null) }; }
}
const writeAll = async (all) => {
  const prisma = require('../db'); // eslint-disable-line global-require
  const value = JSON.stringify({ spotsLeft: all.spotsLeft, alerts: all.alerts || {}, answers: all.answers || [], offer: cleanOffer(all.offer) });
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value }, create: { key: SETTINGS_KEY, value } });
};
const readSettings = async () => ({ spotsLeft: (await readAll()).spotsLeft }); // what the client page and the team page may see (never the alert numbers)
async function saveSettings(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not change this.', status: 403 };
  const n = Math.floor(Number(b.spotsLeft));
  if (!Number.isFinite(n) || n < 0 || n > 99) return { error: 'Type how many "first ten customers" spots are left, from 0 to 99.', status: 400 };
  const all = await readAll();
  await writeAll({ ...all, spotsLeft: n });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: plans meeting, first-ten spots left set', entity: TABLE, entityId: 'settings', toValue: String(n) });
  return { ok: n > 0 ? `${n} spot${n === 1 ? '' : 's'} left: the assistant says the first-ten offer.` : 'No spots left: the assistant no longer says the first-ten offer.', settings: { spotsLeft: n } };
}

// ---- THE DEMO OFFERED BY ITSELF (founder 2026-11-17: "everytime we cant manually add the client no. and share them a demo link ... when a client is looking for our kind of work they should be suggested a demo") ----
// An Admin chooses which company WhatsApp numbers offer it (and whether website-form leads get it too). What happens is in marketing/meetingOffer.js; this is the switch, the counts and the rows it makes.
const SELF_MADE = ['inbound', 'website']; // rows made by TeamLink itself (no person made the link): every login that may use this page sees them
async function offerView(u) {
  await ensure();
  const o = (await readAll()).offer;
  const now = Date.now();
  const one = async (extra) => S.num((await S.q(`SELECT COUNT(*) AS n FROM "${TABLE}" WHERE source IN ('inbound', 'website') AND deletedAt IS NULL AND createdAt > ?${extra || ''}`, now - 30 * DAY))[0].n);
  let numbers = [];
  try { numbers = (await require('./sender').numbersFor(u)).numbers; } catch { numbers = []; } // eslint-disable-line global-require
  return { ...o, canEdit: A.isAdmin(u), numbers, siteReady: !!String(process.env.APP_BASE_URL || '').trim(), cap: OFFER_CAP, last30: { offered: await one(), opened: await one(' AND views > 0'), wantCall: await one(' AND handoverAt IS NOT NULL') } };
}
async function saveOffer(u, b = {}) {
  if (!A.isAdmin(u)) return { error: 'Only an Admin can switch the automatic demo on or off, because it writes to people who message the company.', status: 403 };
  const prev = (await readAll());
  const on = b.on === true; const website = b.website === true;
  const wanted = Array.isArray(b.numberIds) ? [...new Set(b.numberIds.map((x) => String(x)).filter(Boolean))] : prev.offer.numberIds;
  const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
  const ok = [];
  for (const id of wanted) { // only numbers connected in TeamLink and switched on can be ticked
    const row = await WN.getRow(id).catch(() => null); // eslint-disable-line no-await-in-loop
    if (!row) return { error: 'One of the WhatsApp numbers was not found. Reload the page and tick again.', status: 400 };
    if (!row.active && on) return { error: `The WhatsApp number "${row.label}" is switched off in Integrations. Untick it, or switch it on first.`, status: 409 };
    ok.push(String(row.id));
  }
  if (on && !ok.length) return { error: 'Tick the WhatsApp number that should offer the demo (the Digital Marketing number).', status: 400 };
  if ((on || website) && !String(process.env.APP_BASE_URL || '').trim()) return { error: 'This copy of TeamLink does not know its own https address (APP_BASE_URL), so a link cannot be made. Ask the person who runs the server to set it.', status: 409 };
  await writeAll({ ...prev, offer: { on, website, numberIds: ok } });
  await logAudit({ userId: u.id, actorName: u.name, action: `Omni-Channel AI Marketing: plans meeting, automatic demo ${on ? 'switched on' : 'switched off'}${website ? ' (website leads too)' : ''}`, entity: TABLE, entityId: 'offer', toValue: `${ok.length} WhatsApp number${ok.length === 1 ? '' : 's'}` });
  return { ok: on ? `On. A new person who writes to ${ok.length === 1 ? 'that number' : `those ${ok.length} numbers`} is sent the demo by TeamLink.` : (website ? 'Website leads get the demo; WhatsApp enquiries do not.' : 'Off. Nothing is sent by itself.'), offer: await offerView(u) };
}


// ---- QUESTIONS THE ASSISTANT COULD NOT ANSWER, and the answers the team adds (founder 2026-11-17: "any ideas that are best, go with that") ----------------------------------------------------
// A question that matched none of the 19 fixed answers is kept on the client's row. The team page lists them (the same question asked again is counted once), and a person types the answer once, in any of
// the three languages: from then on the assistant answers it (and anything that uses the same words) for every client. Nothing here is written by an AI, and the policy is the team's own.
const normQ = (q) => String(q || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['what', 'which', 'your', 'have', 'does', 'with', 'that', 'this', 'there', 'about', 'from', 'would', 'could', 'should', 'will', 'you', 'are', 'the', 'and', 'for', 'can', 'how', 'why', 'when', 'please', 'tell', 'know', 'want', 'need', 'give', 'show', 'any', 'our', 'also', 'than', 'into', 'they', 'them', 'been', 'do', 'is', 'it', 'me', 'my', 'we', 'to', 'of', 'in', 'on', 'or', 'if', 'so', 'be']);
function keywordsOf(q, extra) {
  const n = normQ(q);
  const words = n.split(' ').filter((w) => (/^[a-z0-9]+$/.test(w) ? w.length >= 4 && !STOP.has(w) : w.length >= 3));
  const more = String(extra || '').split(/[,\n]/).map((x) => normQ(x)).filter((x) => x.length >= 2);
  return [...new Set([...(n.length >= 6 ? [n] : []), ...words, ...more])].slice(0, 14);
}
async function saveAnswer(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not change this.', status: 403 };
  const q = S.clip(b.q, 300);
  const a = b.answer || {};
  const answer = { en: S.clip(a.en, 900), te: S.clip(a.te, 900), hi: S.clip(a.hi, 900) };
  if (!q) return { error: 'Write the question first.', status: 400 };
  if (![answer.en, answer.te, answer.hi].some((x) => String(x || '').length >= 3)) return { error: 'Write the answer in at least one language.', status: 400 };
  const all = await readAll();
  const existing = b.id ? all.answers.find((x) => x.id === String(b.id)) : null;
  if (!existing && all.answers.length >= 60) return { error: 'There are 60 answers already. Remove one first.', status: 400 };
  const keywords = keywordsOf(q, b.keywords);
  if (!keywords.length) return { error: 'Add one or two words that mean this question (in "Words that find this answer").', status: 400 };
  const entry = { id: existing ? existing.id : `C${1 + all.answers.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0)}`, q, fromQ: normQ(q), keywords, answer, by: S.clip(u.name, 80), at: Date.now() };
  all.answers = existing ? all.answers.map((x) => (x.id === existing.id ? entry : x)) : [...all.answers, entry];
  await writeAll(all); customCache.at = 0;
  await logAudit({ userId: u.id, actorName: u.name, action: `Omni-Channel AI Marketing: plans meeting, an answer ${existing ? 'changed' : 'added'}`, entity: TABLE, entityId: entry.id, toValue: q.slice(0, 120) });
  return { ok: 'Saved. The assistant answers this from now on.', answers: all.answers };
}
async function removeAnswer(u, id) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not change this.', status: 403 };
  const all = await readAll();
  const e = all.answers.find((x) => x.id === String(id));
  if (!e) return { error: 'That answer was not found.', status: 404 };
  all.answers = all.answers.filter((x) => x.id !== e.id);
  await writeAll(all); customCache.at = 0;
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: plans meeting, an answer removed', entity: TABLE, entityId: e.id, toValue: String(e.q).slice(0, 120) });
  return { ok: 'Removed.', answers: all.answers };
}
// what the client page may know of the answers (never who wrote them or the question that led to them)
const customForClient = (all) => all.answers.map((e) => ({ id: e.id, keywords: e.keywords, answer: e.answer }));
// every sentence of every added answer, per language: the server voice may speak these too (marketing/meetingVoice.js)
const customCache = { at: 0, sets: { en: new Set(), te: new Set(), hi: new Set() } };
const SENT = (text) => (String(text || '').match(/[^.!?।]+[.!?।]*\s*/g) || []).map((x) => x.trim()).filter(Boolean);
async function customSentences() {
  if (Date.now() - customCache.at < 30000) return customCache.sets;
  const all = await readAll();
  const sets = { en: new Set(), te: new Set(), hi: new Set() };
  all.answers.forEach((e) => ['en', 'te', 'hi'].forEach((l) => SENT(e.answer && e.answer[l]).forEach((x) => sets[l].add(x))));
  customCache.at = Date.now(); customCache.sets = sets;
  return sets;
}
// the questions with no answer, the same words counted once, the most asked first
function unansweredOf(rows, answers) {
  const known = new Set(answers.map((e) => e.fromQ));
  const m = new Map();
  rows.forEach((r) => parse(r.questions, []).forEach((x) => {
    if (x.id) return;
    const k = normQ(x.q); if (!k || k.length < 4 || known.has(k)) return;
    const e = m.get(k) || { q: x.q, count: 0, lastAt: 0, language: r.language };
    e.count += 1; e.lastAt = Math.max(e.lastAt, S.num(x.t)); m.set(k, e);
  }));
  return [...m.values()].sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt)).slice(0, 30);
}

// ---- WhatsApp ALERT to the team when a client asks for a call (founder 2026-11-17: "i have to get notifications ... every time i cant check and call") --------------------------------------
// Each person sets their own number once (Plans meeting page). The bell in TeamLink always rings; this puts the same words on their WhatsApp (the company number, as a template message), so they
// can call at once. A link a person made alerts that person; a page opened with no link (nobody made it) alerts everyone who switched alerts on. One alert per client every 3 minutes.
const myAlert = async (u) => { const a = (await readAll()).alerts[u.id]; return { on: !!(a && a.on), phone: (a && a.phone) || '', phoneMasked: a && a.phone ? core().maskMobile(a.phone) : '' }; };
async function saveAlert(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not change this.', status: 403 };
  const on = b.on === true;
  const typed = S.clip(b.phone, 30);
  const all = await readAll();
  const prev = all.alerts[u.id] || {};
  if (on || typed) {
    const phone = typed || prev.phone || '';
    if (!phone || !core().normalizeMobile(phone).ok) return { error: 'Type your own WhatsApp number (the one that should get the alert).', status: 400 };
    all.alerts[u.id] = { on, phone, name: S.clip(u.name, 80) };
  } else all.alerts[u.id] = { ...prev, on: false };
  await writeAll(all);
  await logAudit({ userId: u.id, actorName: u.name, action: `Omni-Channel AI Marketing: plans meeting, WhatsApp alert for call requests ${on ? 'switched on' : 'switched off'}`, entity: TABLE, entityId: 'alert', toValue: all.alerts[u.id].phone ? core().maskMobile(all.alerts[u.id].phone) : '' });
  return { ok: on ? `Done. When a client asks for a call, TeamLink sends a WhatsApp to ${core().maskMobile(all.alerts[u.id].phone)}.` : 'Alerts are off. The bell in TeamLink still rings.', alert: await myAlert(u) };
}
async function alertWhatsApp(r, text, force = false) {
  const all = await readAll();
  const ids = r.createdById ? [r.createdById] : Object.keys(all.alerts);
  const numbers = new Map();
  ids.forEach((id) => { const a = all.alerts[id]; const nm = a && a.on && a.phone ? core().normalizeMobile(a.phone) : null; if (nm && nm.ok) numbers.set(nm.e164, a.phone); });
  if (!numbers.size) return { sent: 0 };
  if (!force && r.alertedAt && Date.now() - S.num(r.alertedAt) < 180000) return { sent: 0, skipped: 'recently alerted' };
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 700); // one line: a template value cannot hold new lines
  let sent = 0;
  for (const e164 of numbers.keys()) {
    try { // eslint-disable-line no-await-in-loop
      const res = await messaging.send('WhatsApp', { to: e164, kind: 'bulk', text: line, vars: [line], meta: { audience: 'employees', purpose: 'AI Marketing: plans meeting, call request alert', module: 'AI Marketing' } }); // eslint-disable-line no-await-in-loop
      if (res && res.ok) sent += 1; else console.error('[omni-mk] meeting alert not sent:', String((res && (res.error || res.outcome)) || 'refused').slice(0, 120)); // eslint-disable-line no-console
    } catch (e) { console.error('[omni-mk] meeting alert:', e.message); } // eslint-disable-line no-console
  }
  if (sent) await S.run(`UPDATE "${TABLE}" SET alertedAt = ?, updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), r.id);
  return { sent };
}


// ---- EXACT CALL TIMES (founder 2026-11-17, "build it with the simple version") ----------------------------------------------------------------------------------------------------------
// The client picks a real time instead of "afternoon": 30-minute slots, 9 am to 7 pm India time, Monday to Saturday, today and the next three days, never sooner than 30 minutes from now, one list for
// the whole team (a slot is taken by the first client who books it). The team page shows "Call at ...", the owner gets a bell and a WhatsApp 10 minutes before, and the CRM follow-up is set for that time.
const IST = 19800000; const DAY_MS = 86400000;
const SLOT = { startMin: 9 * 60, endMin: 19 * 60, stepMin: 30, leadMin: 30, days: 4, sunday: false };
const istMidnight = (t) => Math.floor((t + IST) / DAY_MS) * DAY_MS - IST; // the epoch of 00:00 India time of the day `t` is in
// every slot the rules allow from `now` on: [{ at, date: 'YYYY-MM-DD', min: minutes after midnight }]
function allowedSlots(now = Date.now()) {
  const out = [];
  for (let d = 0; d < SLOT.days; d += 1) {
    const mid = istMidnight(now) + d * DAY_MS;
    if (!SLOT.sunday && new Date(mid + IST).getUTCDay() === 0) continue; // eslint-disable-line no-continue
    for (let m = SLOT.startMin; m < SLOT.endMin; m += SLOT.stepMin) {
      const at = mid + m * 60000;
      if (at >= now + SLOT.leadMin * 60000) out.push({ at, date: new Date(mid + IST).toISOString().slice(0, 10), min: m });
    }
  }
  return out;
}
const istText = (at) => new Date(Number(at)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\bam\b/, 'am').replace(/\bpm\b/, 'pm');
// the slots a client can still book (taken ones left out); `except` = the client's own row (it may keep its own slot)
async function freeSlots(except = '', now = Date.now()) {
  await ensure();
  const all = allowedSlots(now);
  if (!all.length) return [];
  const taken = new Set((await S.q(`SELECT slotAt FROM "${TABLE}" WHERE slotAt >= ? AND deletedAt IS NULL AND id != ?`, all[0].at, String(except))).map((x) => S.num(x.slotAt)));
  return all.filter((x) => !taken.has(x.at));
}
async function publicSlots(token) {
  const r = await load(token);
  if (!r) return GONE;
  const free = await freeSlots(r.id);
  const days = [];
  free.forEach((x) => { let d = days[days.length - 1]; if (!d || d.date !== x.date) { d = { date: x.date, slots: [] }; days.push(d); } d.slots.push({ at: x.at }); });
  return { tz: 'Asia/Kolkata', days, mine: r.slotAt ? S.num(r.slotAt) : null };
}
// a bell and a WhatsApp 10 minutes before a booked call (nobody has called since the request); once per booking
async function runSlotReminders(now = Date.now()) {
  await ensure();
  const rows = await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND slotAt IS NOT NULL AND slotAt BETWEEN ? AND ? AND slotRemindedAt IS NULL AND handoverAt IS NOT NULL AND (calledAt IS NULL OR calledAt < handoverAt)`, now, now + 10 * 60000);
  for (const r of rows) {
    const claimed = await S.run(`UPDATE "${TABLE}" SET slotRemindedAt = ? WHERE id = ? AND slotRemindedAt IS NULL`, now, r.id); // eslint-disable-line no-await-in-loop
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    const mins = Math.max(1, Math.round((S.num(r.slotAt) - now) / 60000));
    const nm = r.name || 'A client';
    await tellOwner(r, `Call due in ${mins} min: ${nm}`, `${nm} (${r.phone || 'no number'}) is booked for ${istText(r.slotAt)}. Open AI Marketing > Client projects > Plans meeting and press Call now.`); // eslint-disable-line no-await-in-loop
    await alertWhatsApp(r, `Call due in ${mins} min: ${nm} on ${r.phone || 'no number'} at ${istText(r.slotAt)}. Open TeamLink > AI Marketing > Client projects > Plans meeting and press Call now.`, true); // eslint-disable-line no-await-in-loop
  }
  return rows.length;
}

// ---- shapes ---------------------------------------------------------------------------------------------------------------------------------------
const interestOf = (r) => {
  if (r.choice && r.choice !== 'team') return 'Hot';
  if (r.handoverAt || r.choice === 'team') return 'Hot';
  if (S.num(r.maxSlide) >= 5 || parse(r.questions, []).length) return 'Warm';
  return S.num(r.views) ? 'Cold' : 'Not opened';
};
const full = (r) => ({
  id: r.id, token: tokenOf(r.id), name: r.name || '', phone: r.phone || '', phoneMasked: r.phone ? core().maskMobile(r.phone) : '', language: r.language, note: r.note || '', source: r.source,
  createdByName: r.createdByName || '', createdAt: S.num(r.createdAt), sentAt: r.sentAt ? S.num(r.sentAt) : null, sentVia: r.sentVia || '',
  views: S.num(r.views), firstOpenedAt: r.firstOpenedAt ? S.num(r.firstOpenedAt) : null, lastOpenedAt: r.lastOpenedAt ? S.num(r.lastOpenedAt) : null,
  lastSlide: S.num(r.lastSlide), maxSlide: S.num(r.maxSlide), slides: SLIDES, finishedAt: r.finishedAt ? S.num(r.finishedAt) : null,
  questions: parse(r.questions, []), choice: r.choice || '', callbackWindow: r.callbackWindow || '', handoverAt: r.handoverAt ? S.num(r.handoverAt) : null, interest: interestOf(r),
  calledAt: r.calledAt ? S.num(r.calledAt) : null, calledByName: r.calledByName || '', callLine: r.callLine || '', inCrm: !!r.crmLeadId, slotAt: r.slotAt ? S.num(r.slotAt) : null, slotText: r.slotAt ? istText(r.slotAt) : '',
});
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ? AND deletedAt IS NULL`, String(id || '')))[0] || null;
const visible = (u, r) => A.isAdmin(u) || r.createdById === u.id || (!r.createdById && SELF_MADE.includes(r.source)); // a demo TeamLink offered by itself has no maker: whoever may use the page sees it
async function mine(u, id) {
  await ensure();
  const r = await row(id);
  if (!r || !visible(u, r)) return { error: 'This meeting link was not found.', status: 404 };
  return { r };
}

// ---- the team's side -------------------------------------------------------------------------------------------------------------------------------
async function list(u) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use this page.', status: 403 };
  await ensure();
  const rows = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT 300`)).filter((r) => visible(u, r));
  const items = rows.map(full);
  const count = (k) => items.filter((x) => x.interest === k).length;
  const waiting = items.filter((x) => x.handoverAt && (!x.calledAt || x.calledAt < x.handoverAt)).length; // asked for a call and nobody has called since
  const all = await readAll();
  return { items, counts: { total: items.length, hot: count('Hot'), warm: count('Warm'), cold: count('Cold'), notOpened: count('Not opened'), waiting }, settings: { spotsLeft: all.spotsLeft }, alert: await myAlert(u), unanswered: unansweredOf(rows, all.answers), answers: all.answers, offer: await offerView(u) };
}
// a row TeamLink makes by itself (marketing/meetingOffer.js): the same link, no person as its maker
async function createOffered({ name, phone, language, source, createdById, createdByName, note }) {
  await ensure();
  const id = newId(); const now = Date.now();
  await S.run(`INSERT INTO "${TABLE}" (id, name, phone, language, note, source, createdById, createdByName, expiresAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, S.clip(name, 80) || null, S.clip(phone, 30) || null, LANGS.includes(language) ? language : 'en', S.clip(note, 200) || null, SELF_MADE.includes(source) ? source : 'inbound', createdById || null, S.clip(createdByName, 80) || null, now + 30 * DAY, now, now);
  return { id };
}
async function create(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use this page.', status: 403 };
  const language = LANGS.includes(b.language) ? b.language : 'en';
  const name = S.clip(b.name, 80);
  const typed = S.clip(b.phone, 30);
  if (typed && !core().normalizeMobile(typed).ok) return { error: 'That WhatsApp number does not look right. Check it and try again.', status: 400 };
  await ensure();
  const id = newId(); const now = Date.now();
  await S.run(`INSERT INTO "${TABLE}" (id, name, phone, language, note, source, createdById, createdByName, department, expiresAt, createdAt, updatedAt) VALUES (?,?,?,?,?,'invite',?,?,?,?,?,?)`,
    id, name || null, typed || null, language, S.clip(b.note, 200) || null, u.id, S.clip(u.name, 80), S.clip(b.department, 60) || null, now + 30 * DAY, now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: plans meeting link made', entity: TABLE, entityId: id, toValue: `${name || 'no name'}${typed ? ', with a WhatsApp number' : ''}; language ${language}` });
  return { ok: 'The meeting link is ready.', meeting: full(await row(id)) };
}
async function remove(u, id) {
  const g = await mine(u, id); if (g.error) return g;
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ?, updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), g.r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: plans meeting link removed', entity: TABLE, entityId: g.r.id, toValue: g.r.name || '' });
  return { ok: 'Removed. The link does not open any more.' };
}

// CALL the client through TeamLink (founder 2026-11-17: "the client should get the call from my selected no. only" and "call button there itself"): the same click-to-call the CRM uses
// (utils/callLines.js). The line picked decides the number the CLIENT sees (the company's ExoPhone on the API line, the company SIM on the SIP line). The caller's own phone (employee profile)
// rings first; when picked up, TeamLink dials the client. One person per click, never automatic.
async function call(u, id, b = {}) {
  const g = await mine(u, id); if (g.error) return g;
  const r = g.r;
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not call from it.', status: 403 };
  const nm = r.phone ? core().normalizeMobile(r.phone) : null;
  if (!nm || !nm.ok) return { error: 'This meeting has no usable phone number yet. Type the client\'s number first (open the row).', status: 400 };
  const own = await require('../utils/messageChannels').ownContact(u); // eslint-disable-line global-require
  // the phone that rings first: the one on the employee profile, else the number this person saved themselves in "Calls and alerts" (their own, typed on their own page, audited)
  const saved = (await readAll()).alerts[u.id];
  const ringFirst = own.phone || (saved && saved.phone) || '';
  if (!ringFirst) return { error: 'TeamLink does not know which phone to ring first: your own number is not on your employee profile. Type your phone number in "Calls and alerts" on this page and press "Save my number", or use "Dial it myself".', status: 409 };
  const ownNm = core().normalizeMobile(ringFirst);
  if (ownNm.ok && ownNm.e164 === nm.e164) return { error: `The client's number (${core().maskMobile(nm.e164)}) is the same as the phone that rings first (${core().maskMobile(ownNm.e164)}): TeamLink would be calling you twice and the second call cannot connect. To test, put a different number in the client's WhatsApp number (open the row), for example a colleague's.`, status: 400 };
  const lines = require('../utils/callLines'); // eslint-disable-line global-require
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || null;
  const out = await lines.startCall(b.line, { agent: ringFirst, to: r.phone, ref: `mkmeeting:${r.id}`.slice(0, 120), callbackBase: base });
  const detail = out.ok ? `Call through TeamLink started on the ${String(out.line || b.line || 'api').toUpperCase()} line: ${own.name}'s phone (${core().maskMobile(ringFirst)}) rings first${out.sandbox ? ' (test server, no real call)' : ''}.` : `Call did not start: ${out.error}`;
  await logAudit({ userId: u.id, actorName: u.name, action: out.ok ? 'Omni-Channel AI Marketing: plans meeting, call to the client started' : 'Omni-Channel AI Marketing: plans meeting, call to the client failed', entity: TABLE, entityId: r.id, toValue: `${r.name || 'client'} (${core().maskMobile(nm.e164)}): ${detail}`.slice(0, 300) });
  if (!out.ok) return { error: out.error, status: out.notConfigured ? 409 : (out.invalid ? 400 : (out.transient ? 503 : 502)) };
  await S.run(`UPDATE "${TABLE}" SET calledAt = ?, calledByName = ?, callLine = ?, updatedAt = ? WHERE id = ?`, Date.now(), S.clip(u.name, 80), String(out.line || ''), Date.now(), r.id);
  return { ok: `Your phone (${core().maskMobile(ringFirst)}) will ring first. Pick up, and TeamLink then connects ${r.name || 'the client'}.${out.sandbox ? ' (Test server: no real call.)' : ''}`, meeting: full(await row(r.id)) };
}

// the message a client gets with the link, in their language (the approved WhatsApp template carries it: marketing/clientReview.js does the same)
const INVITE = {
  en: (n, link) => `${n ? `Hello ${n},` : 'Hello,'} here is a short automated meeting about our social media plans (about 5 minutes, in English, Telugu or Hindi). Open it on your phone and turn the sound on: ${link}`,
  te: (n, link) => `${n ? `నమస్కారం ${n} గారు,` : 'నమస్కారం,'} మా సోషల్ మీడియా ప్లాన్ల గురించి చిన్న ఆటోమేటెడ్ మీటింగ్ (సుమారు 5 నిమిషాలు, ఇంగ్లీష్, తెలుగు లేదా హిందీలో). మీ ఫోన్‌లో ఓపెన్ చేసి సౌండ్ ఆన్ చేయండి: ${link}`,
  hi: (n, link) => `${n ? `नमस्ते ${n} जी,` : 'नमस्ते,'} हमारे सोशल मीडिया प्लान के बारे में एक छोटी ऑटोमैटिक मीटिंग (करीब 5 मिनट, अंग्रेज़ी, तेलुगु या हिंदी में)। इसे अपने फ़ोन पर खोलें और आवाज़ चालू करें: ${link}`,
};
const inviteText = (lang, first, link) => (INVITE[lang] || INVITE.en)(first, link);
// what the client gets when THEY tap "Send me the plans on WhatsApp" (never sent by itself)
const SUMMARY = {
  en: (n, link) => `${n ? `Thank you ${n}, ` : 'Thank you '}for joining the TeamLink Digital Marketing plans meeting. Our plans, per month plus 18% GST: Basic Rs 3,999 (Rs 4,719 with GST), Growth Rs 7,999 (Rs 9,439), Premium Rs 14,999 (Rs 17,699). Trial: Rs 999. Open the meeting again: ${link}`,
  te: (n, link) => `${n ? `ధన్యవాదాలు ${n} గారు, ` : 'ధన్యవాదాలు, '}టీమ్‌లింక్ డిజిటల్ మార్కెటింగ్ ప్లాన్ల మీటింగ్‌లో చేరినందుకు. మా ప్లాన్లు, నెలకు + 18% జీఎస్టీ: బేసిక్ ₹3,999 (జీఎస్టీతో ₹4,719), గ్రోత్ ₹7,999 (₹9,439), ప్రీమియం ₹14,999 (₹17,699). ట్రయల్: ₹999. మీటింగ్ మళ్ళీ చూడటానికి: ${link}`,
  hi: (n, link) => `${n ? `धन्यवाद ${n} जी, ` : 'धन्यवाद, '}टीमलिंक डिजिटल मार्केटिंग प्लान मीटिंग में शामिल होने के लिए। हमारे प्लान, प्रति माह + 18% जीएसटी: बेसिक ₹3,999 (जीएसटी के साथ ₹4,719), ग्रोथ ₹7,999 (₹9,439), प्रीमियम ₹14,999 (₹17,699)। ट्रायल: ₹999। मीटिंग फिर से देखने के लिए: ${link}`,
};
const summaryText = (lang, first, link) => (SUMMARY[lang] || SUMMARY.en)(first, link);

async function tell(u, id, b = {}, base = '') {
  const g = await mine(u, id); if (g.error) return g;
  let r = g.r;
  const P = require('./projects'); // eslint-disable-line global-require
  const site = P.siteFor(base);
  if (!site) return { error: 'The link needs the site\'s https address: open this page on the live site and try again.', status: 400 };
  const typed = S.clip(b.phone, 30);
  if (typed && !core().normalizeMobile(typed).ok) return { error: 'That WhatsApp number does not look right. Check it and try again.', status: 400 }; // checked BEFORE it is saved: a wrong number never replaces the good one
  if (typed && typed !== (r.phone || '')) { await S.run(`UPDATE "${TABLE}" SET phone = ?, updatedAt = ? WHERE id = ?`, typed, Date.now(), r.id); r = { ...r, phone: typed }; }
  if (!String(r.phone || '').trim()) return { error: 'Type the client\'s WhatsApp number first.', status: 400 };
  const nm = core().normalizeMobile(r.phone);
  if (!nm.ok) return { error: 'That number does not look right. Check it.', status: 400 };
  const Sender = require('./sender'); // eslint-disable-line global-require
  const pk = await Sender.pick(u, b.numberId);
  if (pk.error) return { error: pk.error, status: pk.status || 400 };
  const link = `${site}/m/${r.id}`; // the short address (the page opens the full link behind it)
  const text = inviteText(r.language, P.firstWord(r.name), link);
  const meta = { audience: 'client', personName: S.clip(r.name, 80), purpose: 'AI Marketing: plans meeting link', module: 'AI Marketing', senderUserId: u.id, senderName: S.clip(u.name, 80) };
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const res = await messaging.send('WhatsApp', { to: nm.e164, kind: 'bulk', text: `${text}\n\nReply STOP to stop messages from us.`, vars: [text], meta, ...Sender.opts(pk) });
  if (!(res && res.ok)) {
    const why = S.clip((res && (res.notConfigured || res.outcome === 'Not configured') ? `It is not connected: ${res.error || 'ask an Admin to connect it in Administration > Integrations'}` : (res && res.error)) || 'The sender refused it.', 200).replace(/(\+?\d[\d\s-]{8,}\d)/g, 'a number');
    return { error: `WhatsApp: ${why}`, status: 502 };
  }
  await S.run(`UPDATE "${TABLE}" SET sentAt = ?, sentVia = 'whatsapp', updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: plans meeting link sent by TeamLink', entity: TABLE, entityId: r.id, toValue: `${r.name || 'client'}: WhatsApp${Sender.fromWords(res)}` });
  return { ok: `Sent by WhatsApp${Sender.fromWords(res)} (${core().maskMobile(nm.e164)}).`, meeting: full(await row(r.id)) };
}

// ---- the client's side (no login) -------------------------------------------------------------------------------------------------------------------
const GONE = { error: 'This link does not work any more. Please ask the sender for a new one.', status: 404 };
async function load(token) {
  const id = idOfToken(token);
  if (!id) return null;
  await ensure();
  const r = await row(id);
  return r && (S.num(r.expiresAt) === 0 || S.num(r.expiresAt) > Date.now() || r.source === 'open') ? r : null;
}
async function proofNow() {
  try {
    const t = await require('./projects').trackRecord(); // eslint-disable-line global-require
    if (t && t.avgHoursToOptions != null && t.approved >= (t.minSample || 3)) return { n: t.approved, hours: Math.max(1, Math.round(t.avgHoursToOptions)) };
  } catch { /* the projects tables are not there yet */ }
  return null; // not enough real finished work yet: the page skips the slide, nothing is invented
}
async function viewOf(r) {
  const brand = await Cfg.getBrand();
  const st = await readAll();
  return { custom: customForClient(st), session: { language: r.language, firstName: require('./projects').firstWord(r.name), hasPhone: !!r.phone, phoneMasked: r.phone ? core().maskMobile(r.phone) : '' }, brand: { name: brand.brandName || 'TeamLink', colors: brand.colors }, spotsLeft: st.spotsLeft, proof: await proofNow() }; // eslint-disable-line global-require
}
// the short address /m/<id>: the page asks for the full link behind it (the id is 64 random bits: it cannot be guessed, and the address is rate limited)
async function publicShort(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) return GONE;
  const token = tokenOf(id);
  const r = await load(token);
  return r ? { token } : GONE;
}
async function publicStart(language) {
  await ensure();
  const id = newId(); const now = Date.now();
  await S.run(`INSERT INTO "${TABLE}" (id, language, source, expiresAt, createdAt, updatedAt) VALUES (?,?,'open',0,?,?)`, id, LANGS.includes(language) ? language : 'en', now, now);
  const r = await row(id);
  await S.run(`UPDATE "${TABLE}" SET views = 1, firstOpenedAt = ?, lastOpenedAt = ? WHERE id = ?`, now, now, id);
  return { token: tokenOf(id), ...(await viewOf(r)) };
}
async function publicView(token) {
  const r = await load(token);
  if (!r) return GONE;
  const now = Date.now();
  await S.run(`UPDATE "${TABLE}" SET views = views + 1, firstOpenedAt = COALESCE(firstOpenedAt, ?), lastOpenedAt = ?, updatedAt = ? WHERE id = ?`, now, now, now, r.id);
  return viewOf(r);
}

// A client who asks for a call or picks a plan becomes a lead in the CRM (source "Plans meeting", rating Hot, owned by the person who made the link), once; the same phone again only adds a note.
async function crmLead(r, { name, phone, what, when, slot, asked }) {
  try {
    const DB = require('../crm/schema'); const CS = require('../crm/service'); const CSET = require('../crm/settings'); const CSALES = require('../crm/sales'); // eslint-disable-line global-require
    const now = DB.nowIso();
    const note = `Plans meeting: ${what}. Call ${when}.${asked ? ` They asked: ${asked}.` : ''}`.slice(0, 1500);
    const ph = CS.phone10(phone);
    const same = r.crmLeadId ? { id: r.crmLeadId } : (ph.length === 10 ? (await DB.all('SELECT "id", "phone" FROM "CrmLead"')).find((l) => CS.phone10(l.phone) === ph) : null);
    const dueDate = slot != null ? new Date(slot + IST).toISOString().slice(0, 10) : null; const dueTime = slot != null ? new Date(slot + IST).toISOString().slice(11, 16) : null;
    const addTask = async (leadId, ownerId, ownerName) => { if (slot == null) return; await CS.insert('CrmTask', { id: CS.newId('task'), title: `Call ${name || 'the client'} (booked in the plans meeting)`, dueDate, dueTime, status: 'Open', type: 'Call', priority: 'High', notifyApp: 1, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 15, leadId, ownerId: ownerId || null, ownerName: ownerName || null, createdById: null, createdAt: now, updatedAt: now }); };
    if (same) {
      await addTask(same.id, r.createdById, r.createdByName).catch(() => null);
      await CS.insert('CrmActivity', { id: CS.newId('act'), kind: 'note', subject: 'Plans meeting: asked for a call', note, at: now, leadId: same.id, byName: 'Plans meeting', createdAt: now });
      return same.id;
    }
    const stage = (await CSET.load()).leadStages[0].name;
    const lead = await CS.insert('CrmLead', { id: CS.newId('lead'), company: name || 'Plans meeting visitor', contactName: name || null, phone, source: 'Plans meeting', rating: 'Hot', notes: note, status: 'New', stage, ownerId: r.createdById || null, ownerName: r.createdByName || null, createdById: r.createdById || null, createdAt: now, updatedAt: now });
    if (slot != null) await addTask(lead.id, r.createdById, r.createdByName).catch(() => null); // the booked time is the follow-up
    else if (r.createdById) await CSALES.firstFollowUp(lead).catch(() => null); // no time booked: the first call, two hours on (CRM settings can switch it off)
    return lead.id;
  } catch (e) { console.error('[omni-mk] meeting crm lead:', e.message); return null; } // eslint-disable-line no-console
}
async function tellOwner(r, title, message) { try { await require('./projects').tellTeam(r, title, message); } catch (e) { console.error('[omni-mk] meeting bell:', e.message); } } // eslint-disable-line global-require, no-console
const who = (r) => r.name || 'A visitor';
async function publicEvent(token, b = {}, base = '') {
  const r = await load(token);
  if (!r) return GONE;
  const now = Date.now(); const t = String(b.type || '');
  if (t === 'start') {
    const lang = LANGS.includes(b.language) ? b.language : r.language;
    await S.run(`UPDATE "${TABLE}" SET language = ?, startedAt = COALESCE(startedAt, ?), updatedAt = ? WHERE id = ?`, lang, now, now, r.id);
  } else if (t === 'slide') {
    const n = Math.max(0, Math.min(SLIDES - 1, Math.floor(Number(b.slide)) || 0));
    await S.run(`UPDATE "${TABLE}" SET lastSlide = ?, maxSlide = MAX(maxSlide, ?), finishedAt = CASE WHEN ? >= ${SLIDES - 1} THEN COALESCE(finishedAt, ?) ELSE finishedAt END, updatedAt = ? WHERE id = ?`, n, n, n, now, now, r.id);
  } else if (t === 'ask') {
    const q = S.clip(b.q, 300);
    if (!q) return { error: 'Type a question first.', status: 400 };
    const list = parse(r.questions, []);
    list.push({ t: now, q, id: /^[FC]\d{1,3}$/.test(String(b.faq || '')) ? String(b.faq) : '' });
    await S.run(`UPDATE "${TABLE}" SET questions = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(list.slice(-30)), now, r.id);
  } else if (t === 'choice' || t === 'handover') {
    const choice = t === 'choice' ? String(b.choice || '') : 'team';
    if (!CHOICES.includes(choice)) return { error: 'Please pick one of the options.', status: 400 };
    const name = S.clip(b.name, 80) || r.name || '';
    const typed = S.clip(b.phone, 30);
    if (typed && !core().normalizeMobile(typed).ok) return { error: 'That number does not look right. Please check it.', status: 400 };
    const phone = typed || r.phone || '';
    if (!phone) return { error: 'Please type your WhatsApp number so our team can reach you.', status: 400 };
    const slot = b.slot != null && b.slot !== '' ? Math.floor(Number(b.slot)) : null;
    if (slot != null && !allowedSlots(now).some((x) => x.at === slot)) return { error: 'Please pick one of the times shown.', status: 400 };
    if (slot != null) { // the guard is in the statement itself, so two clients cannot both get the same slot
      const got = await S.run(`UPDATE "${TABLE}" SET slotAt = ?, slotRemindedAt = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM "${TABLE}" x WHERE x.slotAt = ? AND x.id != ? AND x.deletedAt IS NULL)`, slot, r.id, slot, r.id);
      if (Number(got) !== 1) return { error: 'That time was just taken. Please pick another time.', status: 409 };
    } else await S.run(`UPDATE "${TABLE}" SET slotAt = NULL, slotRemindedAt = NULL WHERE id = ?`, r.id); // as soon as possible (or a broad time): a slot held before is given back
    const window = slot != null ? 'slot' : (WINDOWS.includes(b.window) && b.window !== 'slot' ? b.window : 'asap');
    const when = slot != null ? `at ${istText(slot)} (India time)` : WINDOW_WORDS[window];
    await S.run(`UPDATE "${TABLE}" SET name = ?, phone = ?, choice = ?, callbackWindow = ?, handoverAt = ?, updatedAt = ? WHERE id = ?`, name || null, phone, choice, window, now, now, r.id);
    const asked = parse(r.questions, []).map((x) => x.q).slice(-3).join('; ');
    const what = { trial: 'wants to start the Rs 999 trial', starter: 'chose the Basic plan', growth: 'chose the Growth plan', premium: 'chose the Premium plan', team: 'asked for a call from the team' }[choice];
    await tellOwner(r, `Plans meeting: ${who({ name })} ${what} (Hot)`, `${who({ name })} (${phone}) ${what}. Call ${when}.${asked ? ` They asked: ${asked}.` : ''} Open AI Marketing > Client projects > Plans meeting.`);
    const leadId = await crmLead(r, { name, phone, what, when, slot, asked });
    if (leadId && leadId !== r.crmLeadId) await S.run(`UPDATE "${TABLE}" SET crmLeadId = ? WHERE id = ?`, leadId, r.id);
    await alertWhatsApp(r, `Plans meeting: ${who({ name })} ${what}. Call ${when} on ${phone}.${asked ? ` They asked: ${asked}.` : ''} Open TeamLink > AI Marketing > Client projects > Plans meeting to call them.`);
  } else if (t === 'summary') {
    const typed = S.clip(b.phone, 30);
    if (typed && !core().normalizeMobile(typed).ok) return { error: 'That number does not look right. Please check it.', status: 400 };
    const phone = typed || r.phone || '';
    const nm = phone ? core().normalizeMobile(phone) : null;
    if (!nm || !nm.ok) return { error: 'Please type your WhatsApp number.', status: 400 };
    if (r.summaryAt && now - S.num(r.summaryAt) < 300000) return { ok: true, already: true }; // one every five minutes
    const P = require('./projects'); // eslint-disable-line global-require
    const site = P.siteFor(base);
    if (!site) return { error: 'This page cannot send it from here. Please ask our team.', status: 503 };
    const text = summaryText(r.language, P.firstWord(r.name || b.name), `${site}/m/${r.id}`);
    const messaging = require('../utils/messaging'); // eslint-disable-line global-require
    const res = await messaging.send('WhatsApp', { to: nm.e164, kind: 'bulk', text: `${text}\n\nReply STOP to stop messages from us.`, vars: [text], meta: { audience: 'client', personName: S.clip(r.name, 80), purpose: 'AI Marketing: plans meeting, the plans on WhatsApp (the client asked)', module: 'AI Marketing' } });
    if (!(res && res.ok)) return { error: 'We could not send it just now. Please try again in a minute, or ask our team.', status: 502 };
    await S.run(`UPDATE "${TABLE}" SET summaryAt = ?, phone = COALESCE(NULLIF(phone, ''), ?), updatedAt = ? WHERE id = ?`, now, phone, now, r.id);
    return { ok: true, sentTo: core().maskMobile(nm.e164) };
  } else return { error: 'Unknown event.', status: 400 };
  return { ok: true };
}

module.exports = { ensure, readAll, createOffered, saveOffer, offerView, OFFER_CAP, create, list, remove, tell, call, saveAlert, myAlert, saveSettings, readSettings, saveAnswer, removeAnswer, customSentences, keywordsOf, publicSlots, allowedSlots, runSlotReminders, istText, publicStart, publicShort, publicView, publicEvent, tokenOf, idOfToken, interestOf, inviteText, summaryText, SLIDES };
