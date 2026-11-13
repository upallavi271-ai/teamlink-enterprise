// ---------------------------------------------------------------------------
// AI MARKETING > CONTENT CALENDAR (2026-11-13). One plan of what the company posts and when: Facebook, Instagram, LinkedIn, X, a WhatsApp status /
// broadcast and email newsletters, on one month / week / list view (India time).
//   status   idea -> planned -> ready -> posted | skipped        (overdue = the time has passed and it is not posted or skipped; worked out, not stored)
//   publish  NOTHING is published from here today. Each entry is posted by hand (copy the words, open the page, "Mark as posted" with the post link).
//            Facebook / Instagram show their real connection state (Omni-Channel > Channel Connections); automatic publishing is added when the
//            company's Meta / LinkedIn developer apps are approved. The screen says so plainly.
//   who      writes: Admin, Marketing (mayAiMarketing).  reads: those + the approvers (Team Lead / BDE TL) of the entry's department.
//   AI       "Plan a week": the AI suggests post ideas from the brand kit and a theme (marketing/ai.js: limits, usage log, sandbox sample writer).
//            The ideas are only shown; a person picks which ones go on the calendar.
//   reminder one in-app notice to the owner an hour before a planned / ready post (sweep every 10 minutes, never in the test sandbox).
// Audit rows start with "Omni-Channel AI Marketing" so they show on the Omni-Channel audit page.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const sandbox = require('../utils/sandbox');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const TABLE = 'OmniMkCalendar';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "platforms" TEXT NOT NULL DEFAULT '[]', "text" TEXT NOT NULL DEFAULT '', "mediaUrl" TEXT, "at" DATETIME NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'planned', "contentId" TEXT, "postUrl" TEXT, "note" TEXT, "department" TEXT, "ownerId" TEXT, "ownerName" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "remindedAt" DATETIME, "postedAt" DATETIME, "postedByName" TEXT, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_at" ON "${TABLE}"("at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await AI.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] calendar schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

// ---- platforms ---------------------------------------------------------------------------------------------------------------------
const PLATFORMS = [
  { key: 'facebook', label: 'Facebook', icon: 'f', color: '#1877f2', limit: 5000, home: 'https://www.facebook.com/' },
  { key: 'instagram', label: 'Instagram', icon: '◎', color: '#d62976', limit: 2200, home: 'https://www.instagram.com/' },
  { key: 'linkedin', label: 'LinkedIn', icon: 'in', color: '#0a66c2', limit: 3000, home: 'https://www.linkedin.com/' },
  { key: 'x', label: 'X', icon: '𝕏', color: '#111111', limit: 280, home: 'https://x.com/' },
  { key: 'whatsapp', label: 'WhatsApp', icon: 'WA', color: '#25d366', limit: 1024, home: '' },
  { key: 'email', label: 'Email newsletter', icon: '@', color: '#6b7280', limit: 5000, home: '' },
];
const PKEYS = PLATFORMS.map((p) => p.key);
const STATUSES = ['idea', 'planned', 'ready', 'posted', 'skipped'];
const OPEN = ['idea', 'planned', 'ready'];
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const IST = 19800000;
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
// "2026-11-20" + "10:30" (India time) -> ms
function atOf(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return null;
  const ms = Date.parse(`${date}T${time}:00+05:30`);
  return Number.isFinite(ms) ? ms : null;
}

// ---- who may do what -------------------------------------------------------------------------------------------------------------
const mayWrite = (u) => A.has('mayAiMarketing')(u);
function visible(u, r) {
  if (r.deletedAt) return false;
  if (A.isAdmin(u) || r.createdById === u.id || r.ownerId === u.id) return true;
  if (mayWrite(u)) return A.mayDepartment(u, r.department || '');
  return A.has('mayAiApprove')(u) && !!r.department && A.mayDepartment(u, r.department);
}
const mayEdit = (u, r) => mayWrite(u) && (A.isAdmin(u) || r.createdById === u.id || r.ownerId === u.id || A.mayDepartment(u, r.department || ''));

function view(u, r, now = Date.now()) {
  const at = S.num(r.at);
  return {
    id: r.id, title: r.title, platforms: parse(r.platforms, []), text: r.text || '', mediaUrl: r.mediaUrl || '', at: S.iso(at), date: istDate(at), time: new Date(at + IST).toISOString().slice(11, 16),
    status: r.status, overdue: OPEN.includes(r.status) && at < now, contentId: r.contentId || '', postUrl: r.postUrl || '', note: r.note || '', department: r.department || '',
    ownerName: r.ownerName || r.createdByName || '', mine: r.ownerId === u.id || r.createdById === u.id, postedAt: S.iso(r.postedAt), postedByName: r.postedByName || '',
    createdByName: r.createdByName || '', updatedAt: S.iso(r.updatedAt), canEdit: mayEdit(u, r),
  };
}
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, String(id || '')))[0] || null;

async function list(u, { from, to } = {}) {
  await ensure();
  const f = Date.parse(from || '') || (Date.now() - 45 * 86400000);
  const t = Date.parse(to || '') || (Date.now() + 75 * 86400000);
  if (t - f > 400 * 86400000) return { error: 'Ask for at most a year at a time.', status: 400 };
  const rows = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND at >= ? AND at < ? ORDER BY at ASC LIMIT 2000`, f, t)).filter((r) => visible(u, r));
  const now = Date.now();
  return { entries: rows.map((r) => view(u, r, now)), canWrite: mayWrite(u) };
}

// ---- save --------------------------------------------------------------------------------------------------------------------------
function clean(b, cur = {}) {
  const pick = (k, n) => (b[k] !== undefined ? S.clip(b[k], n) : (cur[k] || ''));
  const title = pick('title', 120);
  if (!title) return { error: 'Give the post a short name.', status: 400 };
  const platforms = (b.platforms !== undefined ? (Array.isArray(b.platforms) ? b.platforms : []) : parse(cur.platforms, [])).map(String).filter((k) => PKEYS.includes(k)).filter((k, i, a) => a.indexOf(k) === i);
  if (!platforms.length) return { error: 'Pick at least one place to post (Facebook, Instagram, LinkedIn …).', status: 400 };
  const text = b.text !== undefined ? String(b.text || '').replace(/\r/g, '').trim().slice(0, 6000) : (cur.text || '');
  const over = PLATFORMS.filter((p) => platforms.includes(p.key) && text.length > p.limit);
  if (over.length) return { error: `The text is too long for ${over.map((p) => `${p.label} (${p.limit} characters)`).join(', ')}. Shorten it or take that platform off.`, status: 400 };
  let at = S.num(cur.at) || null;
  if (b.date !== undefined || b.time !== undefined) {
    at = atOf(b.date, b.time || '10:00');
    if (!at) return { error: 'Pick a date and a time.', status: 400 };
  }
  if (!at) return { error: 'Pick a date and a time.', status: 400 };
  const mediaUrl = pick('mediaUrl', 500);
  if (mediaUrl && !/^https?:\/\//i.test(mediaUrl)) return { error: 'The picture or video link must start with https://', status: 400 };
  let status = b.status !== undefined ? String(b.status) : (cur.status || 'planned');
  if (!['idea', 'planned', 'ready'].includes(status) && !(cur.status && status === cur.status)) status = 'planned'; // posted / skipped only through their own buttons
  if (status === 'ready' && !text) return { error: 'A post marked Ready needs its words. Write the text first, or keep it as Planned.', status: 400 };
  return { value: { title, platforms, text, at, mediaUrl, status, note: pick('note', 500), contentId: pick('contentId', 40) } };
}

async function create(u, b) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at the calendar but not change it.', status: 403 };
  const c = clean(b || {});
  if (c.error) return c;
  const v = c.value;
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('cal'); const now = Date.now();
  await S.run(`INSERT INTO "${TABLE}" (id, title, platforms, text, mediaUrl, at, status, contentId, note, department, ownerId, ownerName, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, v.title, JSON.stringify(v.platforms), v.text, v.mediaUrl || null, v.at, v.status, v.contentId || null, v.note || null, dept || null, u.id, S.clip(u.name, 80), u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: calendar post added', entity: TABLE, entityId: id, toValue: `${v.title}; ${istDate(v.at)}; ${v.platforms.join(', ')}` });
  return { entry: view(u, await row(id)) };
}
async function getEditable(u, id) {
  await ensure();
  const r = await row(id);
  if (!r || !visible(u, r)) return { error: 'This calendar post was not found.', status: 404 };
  if (!mayEdit(u, r)) return { error: 'Your login can look at this post but not change it.', status: 403 };
  return { r };
}
async function update(u, id, b) {
  const g = await getEditable(u, id); if (g.error) return g;
  const { r } = g;
  if (['posted', 'skipped'].includes(r.status) && b.reopen !== true) {
    // a posted / skipped entry keeps its record; only the note and the post link may be corrected
    const note = b.note !== undefined ? S.clip(b.note, 500) : r.note;
    const postUrl = b.postUrl !== undefined ? S.clip(b.postUrl, 500) : r.postUrl;
    if (postUrl && !/^https?:\/\//i.test(postUrl)) return { error: 'The post link must start with https://', status: 400 };
    await S.run(`UPDATE "${TABLE}" SET note = ?, postUrl = ?, updatedAt = ? WHERE id = ?`, note || null, postUrl || null, Date.now(), r.id);
    return { entry: view(u, await row(r.id)) };
  }
  const c = clean(b || {}, b.reopen === true ? { ...r, status: 'planned' } : r);
  if (c.error) return c;
  const v = c.value;
  const moved = v.at !== S.num(r.at);
  await S.run(`UPDATE "${TABLE}" SET title = ?, platforms = ?, text = ?, mediaUrl = ?, at = ?, status = ?, contentId = ?, note = ?, remindedAt = ?, postedAt = NULL, postedByName = NULL, updatedAt = ? WHERE id = ?`,
    v.title, JSON.stringify(v.platforms), v.text, v.mediaUrl || null, v.at, v.status, v.contentId || null, v.note || null, moved ? null : (r.remindedAt || null), Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: moved ? 'Omni-Channel AI Marketing: calendar post moved' : 'Omni-Channel AI Marketing: calendar post changed', entity: TABLE, entityId: r.id, toValue: `${v.title}; ${istDate(v.at)}; ${v.status}` });
  return { entry: view(u, await row(r.id)) };
}
async function remove(u, id) {
  const g = await getEditable(u, id); if (g.error) return g;
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ? WHERE id = ?`, Date.now(), g.r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: calendar post deleted', entity: TABLE, entityId: g.r.id, toValue: g.r.title });
  return { ok: true };
}
async function markPosted(u, id, b = {}) {
  const g = await getEditable(u, id); if (g.error) return g;
  const { r } = g;
  if (!OPEN.includes(r.status)) return { error: 'This post is already marked as posted or skipped.', status: 409 };
  const postUrl = S.clip(b.postUrl, 500);
  if (postUrl && !/^https?:\/\//i.test(postUrl)) return { error: 'The post link must start with https://', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${TABLE}" SET status = 'posted', postUrl = ?, postedAt = ?, postedByName = ?, updatedAt = ? WHERE id = ?`, postUrl || null, now, S.clip(u.name, 80), now, r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: calendar post marked as posted', entity: TABLE, entityId: r.id, toValue: `${r.title}${postUrl ? `; ${postUrl}` : ''}` });
  return { ok: 'Marked as posted.', entry: view(u, await row(r.id)) };
}
async function skip(u, id, b = {}) {
  const g = await getEditable(u, id); if (g.error) return g;
  const { r } = g;
  if (!OPEN.includes(r.status)) return { error: 'This post is already marked as posted or skipped.', status: 409 };
  const note = S.clip(b.note, 500) || r.note;
  await S.run(`UPDATE "${TABLE}" SET status = 'skipped', note = ?, updatedAt = ? WHERE id = ?`, note || null, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: calendar post skipped', entity: TABLE, entityId: r.id, toValue: r.title });
  return { ok: 'Skipped.', entry: view(u, await row(r.id)) };
}

// ---- where the words can come from: approved AI content (only approved words are ever used) -----------------------------------------------
async function sources(u) {
  const C = require('./content'); // eslint-disable-line global-require
  const l = await C.list(u, { status: 'approved' });
  return {
    items: l.items.map((it) => ({ id: it.id, title: it.title, texts: it.texts, updatedAt: it.updatedAt }))
      .slice(0, 100),
  };
}

// ---- what each platform can do today (honest) -----------------------------------------------------------------------------------------------
async function platformState() {
  let meta = 'not_connected';
  try { const E = require('../outreach/external'); meta = (await E.publicState('meta-social', false)).status; } catch { meta = 'not_connected'; } // eslint-disable-line global-require
  const words = { connected: 'Connected. Automatic posting is being added; post by hand for now.', saved: 'Keys saved, not checked yet. Post by hand for now.', failed: 'The connection check failed. Post by hand.', not_connected: 'Not connected. Post by hand.' };
  return PLATFORMS.map((p) => ({ ...p, state: ['facebook', 'instagram'].includes(p.key) ? meta : 'manual', words: ['facebook', 'instagram'].includes(p.key) ? words[meta] || words.not_connected : (p.key === 'linkedin' || p.key === 'x' ? 'Post by hand. Automatic posting needs the company\'s developer app.' : 'Send it from Omni-Channel campaigns, then mark it as posted.') }));
}

// ---- AI: plan a week ----------------------------------------------------------------------------------------------------------------------
function planPrompt(brand, f) {
  const plats = PLATFORMS.filter((p) => f.platforms.includes(p.key));
  const system = [
    `You plan social media posts for ${brand.brandName}.`,
    brand.about ? `About the company: ${brand.about}` : '', brand.voice ? `Brand voice: ${brand.voice}` : '', brand.audience ? `The company talks to: ${brand.audience}.` : '',
    brand.keyMessages && brand.keyMessages.length ? `Key messages: ${brand.keyMessages.join(' | ')}` : '',
    brand.avoidWords && brand.avoidWords.length ? `Never use: ${brand.avoidWords.join(', ')}.` : '',
    brand.hashtags && brand.hashtags.length ? `Brand hashtags for Instagram and LinkedIn: ${brand.hashtags.join(' ')}.` : '',
    `Write in ${brand.language || 'English'}. Never invent prices, dates, salaries, phone numbers or links. Keep each post short and inside these limits: ${plats.map((p) => `${p.label} ${p.limit} characters`).join(', ')}.`,
    'Answer with ONLY a JSON object: {"ideas":[{"day":<1-based day number>,"title":"<three to six words>","text":"<the post, ready to publish>"}]}',
  ].filter(Boolean).join('\n');
  const prompt = `Plan ${f.days * f.perDay} posts over ${f.days} days (${f.perDay} a day), each a different angle${f.theme ? `, around this theme: ${f.theme}` : ''}. Mix: tips for job seekers, openings, company culture, client success, and reminders.`;
  return { system, prompt };
}
function demoIdeas(brand, f) {
  const angles = ['Tip for job seekers', 'We are hiring', 'Behind the scenes', 'Client success', 'Interview checklist', 'Weekend reminder', 'Why work with us'];
  const out = [];
  for (let d = 1; d <= f.days; d += 1) for (let k = 0; k < f.perDay; k += 1) {
    const a = angles[(d + k - 1) % angles.length];
    out.push({ day: d, title: `${a}${f.theme ? `: ${f.theme}` : ''}`.slice(0, 60), text: `${a} from ${brand.brandName}.${f.theme ? ` ${f.theme}.` : ''} ${brand.cta || 'Reply to know more.'}`.slice(0, 260) });
  }
  return { ideas: out };
}
async function plan(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login cannot use AI writing.', status: 403 };
  const brand = await Cfg.getBrand();
  if (!brand.brandName) return { error: 'Set up the Brand voice first (AI Marketing > Brand voice): the AI plans in it.', status: 400, code: 'NO_BRAND' };
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(b.startDate || '')) ? b.startDate : istDate(Date.now() + 86400000);
  const days = Math.max(1, Math.min(14, Number(b.days) || 7));
  const perDay = Math.max(1, Math.min(3, Number(b.perDay) || 1));
  const platforms = (Array.isArray(b.platforms) ? b.platforms : []).map(String).filter((k) => PKEYS.includes(k));
  if (!platforms.length) return { error: 'Pick at least one platform.', status: 400 };
  const f = { days, perDay, platforms, theme: S.clip(b.theme, 200) };
  const limit = Math.min(...PLATFORMS.filter((p) => platforms.includes(p.key)).map((p) => p.limit));
  const { system, prompt } = planPrompt(brand, f);
  try {
    const r = await AI.generate({ user: u, module: 'calendar', task: 'plan', system, prompt, json: true, demo: () => demoIdeas(brand, f) });
    const raw = r.result && Array.isArray(r.result.ideas) ? r.result.ideas : [];
    const base = Date.parse(`${start}T00:00:00+05:30`);
    const times = ['10:00', '13:00', '17:30'];
    const perDayCount = {};
    const ideas = raw.slice(0, days * perDay).map((x) => {
      const day = Math.max(1, Math.min(days, Number(x && x.day) || 1));
      const n = perDayCount[day] = (perDayCount[day] || 0) + 1; // eslint-disable-line no-multi-assign
      let text = String((x && x.text) || '').replace(/\r/g, '').trim();
      if (text.length > limit) text = `${text.slice(0, limit - 1).trim()}…`;
      return { date: istDate(base + (day - 1) * 86400000), time: times[Math.min(n, 3) - 1], title: S.clip(x && x.title, 120) || `Post for day ${day}`, text, platforms };
    }).filter((x) => x.text);
    if (!ideas.length) return { error: 'The AI answer could not be read. Try again.', status: 502, code: 'UNREADABLE' };
    return { ideas, ai: { provider: r.provider, model: r.model, demo: r.demo, ms: r.ms } };
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
}
// add several ideas at once (from "Plan a week"); each becomes an Idea on the calendar
async function addMany(u, list) {
  if (!mayWrite(u)) return { error: 'Your login can look at the calendar but not change it.', status: 403 };
  const arr = (Array.isArray(list) ? list : []).slice(0, 42);
  if (!arr.length) return { error: 'Pick at least one idea.', status: 400 };
  const made = []; const bad = [];
  for (const x of arr) {
    const r = await create(u, { ...x, status: 'idea' }); // eslint-disable-line no-await-in-loop
    if (r.error) bad.push(`${S.clip(x && x.title, 40) || 'idea'}: ${r.error}`); else made.push(r.entry);
  }
  return { ok: `${made.length} added to the calendar as ideas.${bad.length ? ` ${bad.length} not added.` : ''}`, entries: made, notAdded: bad };
}

// ---- reminders: one notice to the owner an hour before a planned / ready post -------------------------------------------------------------
async function sweep() {
  if (!(await ensure())) return;
  const now = Date.now();
  const due = await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND status IN ('planned','ready') AND remindedAt IS NULL AND at > ? AND at <= ? LIMIT 200`, now, now + 3600000);
  for (const r of due) {
    const plats = PLATFORMS.filter((p) => parse(r.platforms, []).includes(p.key)).map((p) => p.label).join(', ');
    const when = new Date(S.num(r.at) + IST).toISOString().slice(11, 16);
    try {
      if (r.ownerId) await notifyUsers([r.ownerId], { title: `Post due at ${when}: "${S.clip(r.title, 60)}"`, message: `${plats}. ${r.status === 'ready' ? 'The words are ready: copy them, post, then mark it as posted.' : 'The words are not marked Ready yet.'} Open Omni-Channel > AI Marketing > Calendar.` }); // eslint-disable-line no-await-in-loop
      await S.run(`UPDATE "${TABLE}" SET remindedAt = ? WHERE id = ?`, now, r.id); // eslint-disable-line no-await-in-loop
    } catch (e) { console.error('[omni-mk] calendar reminder:', e.message); } // eslint-disable-line no-console
  }
}
let timer = null;
function startSweep() {
  if (timer || sandbox.isSandbox()) return;
  const ms = Number(process.env.MK_CALENDAR_SWEEP_MS);
  const every = Number.isFinite(ms) ? ms : 600000;
  if (every <= 0) return;
  timer = setInterval(() => { sweep().catch((e) => console.error('[omni-mk] calendar sweep:', e.message)); }, every); // eslint-disable-line no-console
  if (timer.unref) timer.unref();
}

module.exports = { ensure, PLATFORMS, STATUSES, list, create, update, remove, markPosted, skip, sources, platformState, plan, addMany, sweep, startSweep, mayWrite };
