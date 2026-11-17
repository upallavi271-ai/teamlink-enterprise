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
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] meeting schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
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
async function readSettings() {
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    const n = Math.floor(Number(v.spotsLeft));
    return { spotsLeft: Number.isFinite(n) && n >= 0 ? Math.min(n, 99) : 10 };
  } catch { return { spotsLeft: 10 }; }
}
async function saveSettings(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not change this.', status: 403 };
  const n = Math.floor(Number(b.spotsLeft));
  if (!Number.isFinite(n) || n < 0 || n > 99) return { error: 'Type how many "first ten customers" spots are left, from 0 to 99.', status: 400 };
  const prisma = require('../db'); // eslint-disable-line global-require
  const value = JSON.stringify({ spotsLeft: n });
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value }, create: { key: SETTINGS_KEY, value } });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: plans meeting, first-ten spots left set', entity: TABLE, entityId: 'settings', toValue: String(n) });
  return { ok: n > 0 ? `${n} spot${n === 1 ? '' : 's'} left: the assistant says the first-ten offer.` : 'No spots left: the assistant no longer says the first-ten offer.', settings: { spotsLeft: n } };
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
  return { items, counts: { total: items.length, hot: count('Hot'), warm: count('Warm'), cold: count('Cold'), notOpened: count('Not opened') }, settings: await readSettings() };
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
  } else return { error: 'Unknown event.', status: 400 };
  return { ok: true };
}

module.exports = { ensure, create, list, remove, tell, saveSettings, readSettings, publicStart, publicView, publicEvent, tokenOf, idOfToken, interestOf, inviteText, SLIDES };
