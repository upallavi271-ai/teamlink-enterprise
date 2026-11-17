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
// columns added after the first release (an older table gets them here): who called the client and when, and when the team was last alerted
const LATER = [['calledAt', 'DATETIME'], ['calledByName', 'TEXT'], ['callLine', 'TEXT'], ['alertedAt', 'DATETIME']];
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
const WINDOWS = ['asap', 'morning', 'afternoon', 'evening'];
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
async function readAll() {
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    const n = Math.floor(Number(v.spotsLeft));
    return { spotsLeft: Number.isFinite(n) && n >= 0 ? Math.min(n, 99) : 10, alerts: v.alerts && typeof v.alerts === 'object' ? v.alerts : {} };
  } catch { return { spotsLeft: 10, alerts: {} }; }
}
const writeAll = async (all) => {
  const prisma = require('../db'); // eslint-disable-line global-require
  const value = JSON.stringify({ spotsLeft: all.spotsLeft, alerts: all.alerts || {} });
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
async function alertWhatsApp(r, text) {
  const all = await readAll();
  const ids = r.createdById ? [r.createdById] : Object.keys(all.alerts);
  const numbers = new Map();
  ids.forEach((id) => { const a = all.alerts[id]; const nm = a && a.on && a.phone ? core().normalizeMobile(a.phone) : null; if (nm && nm.ok) numbers.set(nm.e164, a.phone); });
  if (!numbers.size) return { sent: 0 };
  if (r.alertedAt && Date.now() - S.num(r.alertedAt) < 180000) return { sent: 0, skipped: 'recently alerted' };
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
  calledAt: r.calledAt ? S.num(r.calledAt) : null, calledByName: r.calledByName || '', callLine: r.callLine || '',
});
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ? AND deletedAt IS NULL`, String(id || '')))[0] || null;
const visible = (u, r) => A.isAdmin(u) || r.createdById === u.id;
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
  return { items, counts: { total: items.length, hot: count('Hot'), warm: count('Warm'), cold: count('Cold'), notOpened: count('Not opened'), waiting }, settings: await readSettings(), alert: await myAlert(u) };
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
  const link = `${site}/plans-meeting/${tokenOf(r.id)}`;
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
  const st = await readSettings();
  return { session: { language: r.language, firstName: require('./projects').firstWord(r.name), hasPhone: !!r.phone, phoneMasked: r.phone ? core().maskMobile(r.phone) : '' }, brand: { name: brand.brandName || 'TeamLink', colors: brand.colors }, spotsLeft: st.spotsLeft, proof: await proofNow() }; // eslint-disable-line global-require
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

async function tellOwner(r, title, message) { try { await require('./projects').tellTeam(r, title, message); } catch (e) { console.error('[omni-mk] meeting bell:', e.message); } } // eslint-disable-line global-require, no-console
const who = (r) => r.name || 'A visitor';
async function publicEvent(token, b = {}) {
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
    list.push({ t: now, q, id: /^F\d{1,2}$/.test(String(b.faq || '')) ? String(b.faq) : '' });
    await S.run(`UPDATE "${TABLE}" SET questions = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(list.slice(-30)), now, r.id);
  } else if (t === 'choice' || t === 'handover') {
    const choice = t === 'choice' ? String(b.choice || '') : 'team';
    if (!CHOICES.includes(choice)) return { error: 'Please pick one of the options.', status: 400 };
    const name = S.clip(b.name, 80) || r.name || '';
    const typed = S.clip(b.phone, 30);
    if (typed && !core().normalizeMobile(typed).ok) return { error: 'That number does not look right. Please check it.', status: 400 };
    const phone = typed || r.phone || '';
    if (!phone) return { error: 'Please type your WhatsApp number so our team can reach you.', status: 400 };
    const window = WINDOWS.includes(b.window) ? b.window : 'asap';
    await S.run(`UPDATE "${TABLE}" SET name = ?, phone = ?, choice = ?, callbackWindow = ?, handoverAt = ?, updatedAt = ? WHERE id = ?`, name || null, phone, choice, window, now, now, r.id);
    const asked = parse(r.questions, []).map((x) => x.q).slice(-3).join('; ');
    const what = { trial: 'wants to start the Rs 999 trial', starter: 'chose the Starter plan', growth: 'chose the Growth plan', premium: 'chose the Premium plan', team: 'asked for a call from the team' }[choice];
    await tellOwner(r, `Plans meeting: ${who({ name })} ${what} (Hot)`, `${who({ name })} (${phone}) ${what}. Call ${WINDOW_WORDS[window]}.${asked ? ` They asked: ${asked}.` : ''} Open AI Marketing > Client projects > Plans meeting.`);
    await alertWhatsApp(r, `Plans meeting: ${who({ name })} ${what}. Call ${WINDOW_WORDS[window]} on ${phone}.${asked ? ` They asked: ${asked}.` : ''} Open TeamLink > AI Marketing > Client projects > Plans meeting to call them.`);
  } else return { error: 'Unknown event.', status: 400 };
  return { ok: true };
}

module.exports = { ensure, create, list, remove, tell, call, saveAlert, myAlert, saveSettings, readSettings, publicStart, publicView, publicEvent, tokenOf, idOfToken, interestOf, inviteText, SLIDES };
