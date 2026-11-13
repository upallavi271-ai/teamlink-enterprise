// ---------------------------------------------------------------------------
// AI MARKETING > AI CONTENT (module 1). A person writes a short brief, the AI writes up to three versions for every channel they pick, in the saved brand
// voice. They choose / edit, save a draft, and send it for APPROVAL. Only APPROVED content is copied into the Content Library (OmniStudioContent), which is
// where the campaign screens read content from: nothing AI-written reaches a campaign, a send or a post without a person's approval.
//   status   draft -> waiting -> approved | changes (sent back with a note) -> edited -> waiting ...   Editing approved content makes it a draft again
//            and takes its Library copy away (campaigns already made from it keep their words).
//   who      writes: Admin, Marketing.  approves: an Admin (anything, also their own when the Admin switch allows), a Team Lead / BDE TL for content of their
//            own department (never their own).  Nobody else sees the content.
//   channels WhatsApp, SMS, Email, RCS + Facebook, Instagram, LinkedIn, X (social: saved text only, nothing is posted from here).
// Every AI call goes through marketing/ai.js (limits, usage log, sandbox demo writer). Audit rows start with "Omni-Channel AI Marketing" so they show on the
// Omni-Channel audit page. Notices carry the title only, never a phone number or an email.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const A = require('../outreach/access');
const St = require('../outreach/studio');
const AI = require('./ai');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const TABLE = 'OmniMkContent';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "brief" TEXT NOT NULL DEFAULT '', "goal" TEXT, "audience" TEXT, "cta" TEXT, "tone" TEXT, "language" TEXT, "channels" TEXT NOT NULL DEFAULT '[]', "texts" TEXT NOT NULL DEFAULT '{}', "subject" TEXT, "variants" TEXT NOT NULL DEFAULT '[]', "meta" TEXT NOT NULL DEFAULT '{}', "status" TEXT NOT NULL DEFAULT 'draft', "note" TEXT, "submittedAt" DATETIME, "submittedByName" TEXT, "decidedAt" DATETIME, "decidedById" TEXT, "decidedByName" TEXT, "selfApproved" INTEGER NOT NULL DEFAULT 0, "libraryId" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_status" ON "${TABLE}"("status", "updatedAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await St.ensure(); await AI.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] content schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

// ---- the channels ----------------------------------------------------------------------------------------------------------
const pickCh = (keys) => St.CHANNELS.filter((c) => keys.includes(c.key));
const CHANNELS = [
  ...pickCh(['whatsapp', 'sms', 'email']),
  { key: 'rcs', label: 'RCS', icon: 'RCS', color: '#6a5acd', limit: 1000, hint: 'Rich text message · opt-out line needed', send: true },
  ...pickCh(['facebook', 'instagram', 'linkedin', 'x']),
];
const KEYS = CHANNELS.map((c) => c.key);
const LIMIT = Object.fromEntries(CHANNELS.map((c) => [c.key, c.limit]));
const GOALS = ['Awareness', 'Lead generation', 'Promotion / offer', 'Event / webinar', 'Hiring', 'Reminder / follow-up', 'Announcement'];
const FOOT = { whatsapp: '\n\nReply STOP to opt out', sms: ' Reply STOP to opt out', rcs: '\n\nReply STOP to opt out', email: '\n\n{{unsubscribe}}' };
const HAS_OPTOUT = { whatsapp: /\bSTOP\b/i, sms: /\bSTOP\b/i, rcs: /\bSTOP\b/i, email: /unsubscribe/i };
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trim()}…`);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// the text of one channel, cut to its limit with the opt-out line the law asks for (added only when it is missing)
function finish(key, text) {
  let t = String(text == null ? '' : text).replace(/\r/g, '').trim();
  if (!t) return '';
  const foot = FOOT[key] && !HAS_OPTOUT[key].test(t) ? FOOT[key] : '';
  t = cut(t, LIMIT[key] - foot.length);
  return `${t}${foot}`;
}
// the brand's "never say" words that sit in a text
const flagsOf = (text, avoid) => (avoid || []).filter((w) => w && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));

// ---- the brief ----------------------------------------------------------------------------------------------------------------
function cleanBrief(b, brand) {
  const brief = S.clip(b.brief, 1500);
  if (brief.length < 10) return { error: 'Write a short brief first: what is this message about? (at least a sentence).', status: 400 };
  const channels = (Array.isArray(b.channels) ? b.channels : []).map(String).filter((k) => KEYS.includes(k)).filter((k, i, a) => a.indexOf(k) === i);
  if (!channels.length) return { error: 'Pick at least one channel.', status: 400 };
  const goal = GOALS.includes(b.goal) ? b.goal : GOALS[0];
  const n = Math.max(1, Math.min(3, Number(b.variants) || 3));
  return {
    value: {
      brief, channels, goal, n, audience: S.clip(b.audience, 200), cta: S.clip(b.cta, 80) || brand.cta,
      tone: St.VOICES.includes(b.tone) ? b.tone : (St.VOICES.includes(brand.tone) ? brand.tone : St.VOICES[0]),
      language: Cfg.LANGUAGES.includes(b.language) ? b.language : brand.language,
    },
  };
}

// ---- the prompt (real model) -----------------------------------------------------------------------------------------------
function promptFor(f, brand) {
  const chans = f.channels.map((k) => `- ${k}: at most ${LIMIT[k]} characters${k === 'email' ? ' (also write a subject line)' : ''}`).join('\n');
  const system = [
    `You are the marketing copywriter for ${brand.brandName}. You write ready-to-send marketing messages.`,
    brand.about ? `About the company: ${brand.about}` : '',
    brand.voice ? `Brand voice: ${brand.voice}` : '',
    `Tone: ${f.tone}. Write in ${f.language}${f.language === 'English' ? '' : ' (use the usual script of that language)'}.`,
    brand.doWords.length ? `Use these words or phrases where they fit naturally: ${brand.doWords.join(', ')}.` : '',
    brand.avoidWords.length ? `Never use these words or phrases: ${brand.avoidWords.join(', ')}.` : '',
    brand.samples.length ? `Examples of on-brand writing:\n${brand.samples.map((s) => `"${s}"`).join('\n')}` : '',
    // the brand kit (Brand voice screen): who we talk to, what we always say, how we use emoji, our own details
    brand.audience ? `The company usually talks to: ${brand.audience}.` : '',
    brand.industries && brand.industries.length ? `Industries the company hires for: ${brand.industries.join(', ')}.` : '',
    brand.keyMessages && brand.keyMessages.length ? `Key brand messages (use one only when it fits the brief, in natural words):\n${brand.keyMessages.map((k) => `- ${k}`).join('\n')}` : '',
    brand.emoji === 'none' ? 'Use no emoji at all.' : brand.emoji === 'many' ? 'Emoji are welcome in WhatsApp, RCS and social posts; never in SMS or email.' : 'Use at most one or two emoji, only in WhatsApp, RCS and social posts; none in SMS or email.',
    brand.website || brand.contact ? `When the message needs the company's own details, use only these (no other link or number): ${[brand.website ? `website ${brand.website}` : '', brand.contact ? `contact ${brand.contact}` : ''].filter(Boolean).join('; ')}.` : '',
    brand.signOff ? `Sign emails off with: ${brand.signOff}.` : '',
    brand.disclaimer ? `End every email with this line, word for word: "${brand.disclaimer}"` : '',
    `Rules: use only facts that are in the brief. Never invent prices, discounts, dates, phone numbers, links or promises. Use {{name}} where the person's first name belongs. Do not add opt-out or unsubscribe lines (they are added automatically). ${brand.hashtags && brand.hashtags.length ? `Hashtags only on Instagram and LinkedIn: two or three of these brand hashtags, ${brand.hashtags.join(' ')}.` : 'No hashtags except on Instagram.'} Keep every message inside its character limit and short: an SMS under 300 characters, a social post under 600.`,
    'Answer with ONLY a JSON object, no other words: {"variants":[{"angle":"<two to four words that name this version>","subject":"<email subject, or empty>","texts":{"<channel>":"<the message>"}}]}',
  ].filter(Boolean).join('\n');
  const prompt = [
    `Brief: ${f.brief}`, `Goal: ${f.goal}`, f.audience ? `Audience: ${f.audience}` : '', f.cta ? `Call to action: ${f.cta}` : '',
    `Write ${f.n} different version${f.n > 1 ? 's' : ''} (different angle each). Channels:\n${chans}`,
  ].filter(Boolean).join('\n');
  return { system, prompt };
}

// ---- the sample writer (test sandbox only; clearly labelled everywhere it is shown) ----------------------------------------------------------
const firstSentence = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); const m = /^(.+?[.!?])(\s|$)/.exec(t); return (m ? m[1] : t).slice(0, 220); };
const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const BENEFIT = { Awareness: 'We would love you to know more about us.', 'Lead generation': 'It takes two minutes to find out if it suits you.', 'Promotion / offer': 'This is a good time to take a look.', 'Event / webinar': 'Save your seat while places last.', Hiring: 'We would be glad to hear from you.', 'Reminder / follow-up': 'A small reminder so nothing is missed.', Announcement: 'Here is what is new.' };
function demoVariants(f, brand) {
  const name = brand.brandName || 'Our team';
  const s = firstSentence(f.brief);
  const cta = f.cta || 'Reply to this message to know more';
  const masters = [
    { angle: 'Direct and clear', master: `${s}\n\n${cta}.` },
    { angle: 'Benefit first', master: `Hi {{name}}, ${lc(s)} ${BENEFIT[f.goal] || ''}\n\n${cta}.`.replace(/\s+\n/g, '\n') },
    { angle: 'Friendly nudge', master: `Hello {{name}}, a quick note from ${name}: ${lc(s)}\n\n${cta}, we are happy to help.` },
  ].slice(0, f.n);
  const tag = `#${String(name).replace(/[^A-Za-z0-9]+/g, '')}`;
  return {
    variants: masters.map(({ angle, master }) => {
      const head = firstSentence(master);
      const texts = {};
      f.channels.forEach((k) => {
        if (k === 'sms') texts[k] = master.replace(/\s*\n+\s*/g, ' ');
        else if (k === 'email') texts[k] = `Hello {{name}},\n\n${master}\n\nRegards,\n${brand.signOff || name}`;
        else if (k === 'instagram') texts[k] = `${master}\n\n${tag} #${f.goal.replace(/[^A-Za-z]+/g, '')}`;
        else if (k === 'x') texts[k] = `${head} ${cta}.`;
        else texts[k] = master;
      });
      return { angle, subject: f.channels.includes('email') ? cut(head.replace(/[.!?]+$/, ''), 70) : '', texts };
    }),
  };
}

// the model (or sample) answer -> clean variants: every text cut to its channel limit, opt-out line added, brand "never say" words flagged
function normalise(raw, f, brand) {
  const arr = raw && Array.isArray(raw.variants) ? raw.variants : [];
  const variants = [];
  arr.slice(0, f.n).forEach((v, i) => {
    const texts = {}; const flags = {};
    const given = v && typeof v.texts === 'object' && v.texts ? v.texts : {};
    f.channels.forEach((k) => {
      let x = given[k];
      if (x && typeof x === 'object') x = x.text || x.message || '';
      const t = finish(k, Array.isArray(x) ? x.join('\n') : x);
      if (t) { texts[k] = t; const fl = flagsOf(t, brand.avoidWords); if (fl.length) flags[k] = fl; }
    });
    if (!Object.keys(texts).length) return;
    variants.push({ id: `v${i + 1}`, angle: S.clip(v.angle, 40) || `Version ${i + 1}`, subject: S.clip(v.subject, 150), texts, flags });
  });
  return variants;
}

async function generate(u, b) {
  await ensure();
  const brand = await Cfg.getBrand();
  if (!brand.brandName) return { error: 'Set up the Brand voice first (AI Marketing > Brand voice): the AI writes in it.', status: 400, code: 'NO_BRAND' };
  const c = cleanBrief(b || {}, brand);
  if (c.error) return c;
  const f = c.value;
  const { system, prompt } = promptFor(f, brand);
  try {
    const r = await AI.generate({ user: u, module: 'content', task: 'draft', system, prompt, json: true, demo: () => demoVariants(f, brand), itemId: b.itemId || null });
    const variants = normalise(r.result, f, brand);
    if (!variants.length) return { error: 'The AI answer could not be read. Press "Write with AI" again.', status: 502, code: 'UNREADABLE' };
    return { variants, ai: { provider: r.provider, model: r.model, demo: r.demo, ms: r.ms }, used: { tone: f.tone, language: f.language, goal: f.goal, channels: f.channels, avoidWords: brand.avoidWords } };
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
}

// ONE channel rewritten by an instruction ("shorter", "more urgent" ...); the answer is returned, not saved
async function revise(u, b) {
  await ensure();
  const key = String(b.channel || '');
  if (!KEYS.includes(key)) return { error: 'Pick a channel.', status: 400 };
  const text = String(b.text || '').trim().slice(0, 3000);
  const instruction = S.clip(b.instruction, 200);
  if (!text) return { error: 'There is no text to rewrite.', status: 400 };
  if (instruction.length < 3) return { error: 'Say what to change, for example: shorter, more friendly, add urgency.', status: 400 };
  const brand = await Cfg.getBrand();
  const system = [`You edit marketing messages for ${brand.brandName || 'the company'}.`, brand.voice ? `Brand voice: ${brand.voice}` : '', brand.avoidWords.length ? `Never use: ${brand.avoidWords.join(', ')}.` : '',
    `Rewrite the message as asked. Keep every fact. Keep {{name}} if present. Stay under ${LIMIT[key]} characters. Do not add opt-out lines. Answer with ONLY JSON: {"text":"<the new message>"}`].filter(Boolean).join('\n');
  const demo = () => {
    const s = instruction.toLowerCase();
    let t = text.replace(/\n\nReply STOP to opt out$/i, '').replace(/ Reply STOP to opt out$/i, '').replace(/\n\n\{\{unsubscribe\}\}$/i, '');
    if (/short|brief|cut/.test(s)) t = t.split(/(?<=[.!?])\s+/).slice(0, Math.max(1, Math.ceil(t.split(/(?<=[.!?])\s+/).length / 2))).join(' ');
    if (/urgent|urgency|hurry|last/.test(s)) t = `Don't wait: ${lc(t)}`;
    if (/friendly|warm|casual/.test(s)) t = `Hi there! ${t}`;
    if (/formal|professional/.test(s)) t = `Dear {{name}}, ${lc(t.replace(/^Hi( there)?[!,]?\s*/i, ''))}`;
    return { text: t };
  };
  try {
    const r = await AI.generate({ user: u, module: 'content', task: 'revise', system, prompt: `Instruction: ${instruction}\n\nMessage:\n${text}`, json: true, demo, itemId: b.itemId || null });
    const t = finish(key, r.result && typeof r.result.text === 'string' ? r.result.text : '');
    if (!t) return { error: 'The AI answer could not be read. Try again.', status: 502 };
    return { text: t, flags: flagsOf(t, brand.avoidWords), ai: { provider: r.provider, model: r.model, demo: r.demo, ms: r.ms } };
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
}

// ---- who may do what ---------------------------------------------------------------------------------------------------------
const mayWrite = (u) => A.has('mayAiMarketing')(u);
function canApprove(u, r, set) {
  if (r.createdById === u.id) return A.isAdmin(u) && set.selfApprove;
  if (A.isAdmin(u)) return true;
  return A.has('mayAiApprove')(u) && !!r.department && A.mayDepartment(u, r.department);
}
function visible(u, r, set) {
  if (r.deletedAt) return false;
  if (A.isAdmin(u) || r.createdById === u.id) return true;
  if (A.kind(u) === 'marketing' && A.mayDepartment(u, r.department || '')) return true;
  return canApprove(u, r, set);
}
const mayEdit = (u, r) => mayWrite(u) && (A.isAdmin(u) || r.createdById === u.id) && ['draft', 'changes', 'approved'].includes(r.status);
const view = (u, r, set) => ({
  id: r.id, title: r.title, brief: r.brief || '', goal: r.goal || '', audience: r.audience || '', cta: r.cta || '', tone: r.tone || '', language: r.language || '',
  channels: parse(r.channels, []), texts: parse(r.texts, {}), subject: r.subject || '', variants: parse(r.variants, []), ai: parse(r.meta, {}),
  status: r.status, note: r.note || '', submittedAt: S.iso(r.submittedAt), submittedByName: r.submittedByName || '', decidedAt: S.iso(r.decidedAt), decidedByName: r.decidedByName || '',
  selfApproved: S.num(r.selfApproved) === 1, inLibrary: !!r.libraryId && r.status === 'approved', libraryId: r.status === 'approved' ? (r.libraryId || null) : null,
  department: r.department || '', createdByName: r.createdByName || '', mine: r.createdById === u.id, createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt),
  canEdit: mayEdit(u, r), canSubmit: mayWrite(u) && (A.isAdmin(u) || r.createdById === u.id) && ['draft', 'changes'].includes(r.status),
  canApprove: r.status === 'waiting' && canApprove(u, r, set), canDelete: mayWrite(u) && (A.isAdmin(u) || r.createdById === u.id) && r.status !== 'waiting',
});

const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, String(id || '')))[0] || null;
async function getRow(u, id) { await ensure(); const r = await row(id); const set = await Cfg.getSettings(); return r && visible(u, r, set) ? { r, set } : null; }

async function list(u, { status = '', q = '', mine = false } = {}) {
  await ensure();
  const set = await Cfg.getSettings();
  const rows = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 1000`)).filter((r) => visible(u, r, set));
  const needle = String(q || '').trim().toLowerCase();
  const items = rows
    .filter((r) => (!status || r.status === status) && (!mine || r.createdById === u.id) && (!needle || `${r.title} ${r.brief}`.toLowerCase().includes(needle)))
    .map((r) => view(u, r, set));
  return { items, total: items.length, canWrite: mayWrite(u) };
}
async function counts(u) {
  await ensure();
  const set = await Cfg.getSettings();
  const rows = (await S.q(`SELECT status, decidedAt, updatedAt, createdById, department, deletedAt FROM "${TABLE}" WHERE deletedAt IS NULL`)).filter((r) => visible(u, { ...r, id: '' }, set));
  const out = { draft: 0, waiting: 0, approved: 0, changes: 0, approvedThisMonth: 0, waitingForMe: 0 };
  const m0 = AI.monthStart();
  rows.forEach((r) => {
    out[r.status] = (out[r.status] || 0) + 1;
    if (r.status === 'approved' && S.num(r.decidedAt) >= m0) out.approvedThisMonth += 1;
    if (r.status === 'waiting' && canApprove(u, r, set)) out.waitingForMe += 1;
  });
  return out;
}

// ---- save ----------------------------------------------------------------------------------------------------------------
function cleanItem(b, cur = {}) {
  const channels = (b.channels !== undefined ? (Array.isArray(b.channels) ? b.channels : []) : parse(cur.channels, [])).map(String).filter((k) => KEYS.includes(k)).filter((k, i, a) => a.indexOf(k) === i);
  const given = b.texts !== undefined ? (b.texts || {}) : parse(cur.texts, {});
  const texts = {}; const over = [];
  channels.forEach((k) => {
    if (given[k] === undefined || given[k] === null || !String(given[k]).trim()) return;
    const t = String(given[k]).trim().slice(0, LIMIT[k] + 300);
    if (t.length > LIMIT[k]) over.push(CHANNELS.find((c) => c.key === k).label);
    texts[k] = t;
  });
  if (over.length) return { error: `The ${over[0]} version is over its limit. Shorten it first.`, status: 400 };
  if (!Object.keys(texts).length) return { error: 'Write at least one channel version before saving.', status: 400 };
  const title = b.title !== undefined ? S.clip(b.title, 80) : (cur.title || '');
  if (!title) return { error: 'Give this content a name first.', status: 400 };
  const pick = (k, n, d = '') => (b[k] !== undefined ? S.clip(b[k], n) : (cur[k] || d));
  return {
    title, channels, texts, subject: b.subject !== undefined ? S.clip(b.subject, 200) : (cur.subject || ''), brief: pick('brief', 1500), goal: pick('goal', 40), audience: pick('audience', 200), cta: pick('cta', 80), tone: pick('tone', 40), language: pick('language', 20),
    variants: b.variants !== undefined ? (Array.isArray(b.variants) ? b.variants.slice(0, 3) : []) : parse(cur.variants, []),
    meta: b.ai !== undefined ? (b.ai && typeof b.ai === 'object' ? { provider: S.clip(b.ai.provider, 30), model: S.clip(b.ai.model, 60), demo: b.ai.demo === true } : {}) : parse(cur.meta, {}),
  };
}
async function deptFor(u, b) {
  const given = S.clip(b.department, 60);
  if (given) return A.mayDepartment(u, given) ? given : null;
  const own = A.departmentsOf(u);
  if (Array.isArray(own) && own.length === 1) return own[0];
  // several departments (or all of them): the writer's own employee department, so a Team Lead of that department can approve it.
  // Without any department only an Admin could approve, and the TL approval path would never be used.
  const home = S.clip(u.department, 60);
  return home && A.mayDepartment(u, home) ? home : '';
}
async function create(u, b) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at AI content but not write it.', status: 403 };
  const f = cleanItem(b);
  if (f.error) return f;
  const dept = await deptFor(u, b);
  if (dept === null) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('mk'); const now = Date.now();
  await S.run(`INSERT INTO "${TABLE}" (id, title, brief, goal, audience, cta, tone, language, channels, texts, subject, variants, meta, status, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)`,
    id, f.title, f.brief, f.goal || null, f.audience || null, f.cta || null, f.tone || null, f.language || null, JSON.stringify(f.channels), JSON.stringify(f.texts), f.subject || null, JSON.stringify(f.variants), JSON.stringify(f.meta), dept || null, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: content saved', entity: TABLE, entityId: id, toValue: `${f.title}; ${f.channels.join(', ')}${f.meta.demo ? '; written by the sandbox sample writer' : (f.meta.provider ? `; written by ${f.meta.provider}` : '')}` });
  const set = await Cfg.getSettings();
  return { item: view(u, await row(id), set) };
}

// take the Library copy of an item away (it is no longer approved)
async function unpublish(r) {
  if (!r.libraryId) return;
  try { await S.run('UPDATE "OmniStudioContent" SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL', Date.now(), r.libraryId); } catch { /* the Library table may not exist */ }
}
async function update(u, id, b) {
  await ensure();
  const g = await getRow(u, id);
  if (!g) return { error: 'This content was not found.', status: 404 };
  const { r, set } = g;
  if (!mayEdit(u, r)) return { error: r.status === 'waiting' ? 'It is waiting for approval and cannot be changed now.' : 'Only the person who wrote it, or an Admin, can change this content.', status: 403 };
  const f = cleanItem(b, r);
  if (f.error) return f;
  const wasApproved = r.status === 'approved';
  if (wasApproved) await unpublish(r);
  await S.run(`UPDATE "${TABLE}" SET title = ?, brief = ?, goal = ?, audience = ?, cta = ?, tone = ?, language = ?, channels = ?, texts = ?, subject = ?, variants = ?, meta = ?, status = 'draft', note = ?, libraryId = ?, updatedAt = ? WHERE id = ?`,
    f.title, f.brief, f.goal || null, f.audience || null, f.cta || null, f.tone || null, f.language || null, JSON.stringify(f.channels), JSON.stringify(f.texts), f.subject || null, JSON.stringify(f.variants), JSON.stringify(f.meta), wasApproved ? 'Changed after approval: it needs approval again.' : (r.note || null), wasApproved ? null : r.libraryId, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: wasApproved ? 'Omni-Channel AI Marketing: approved content changed (approval withdrawn)' : 'Omni-Channel AI Marketing: content changed', entity: TABLE, entityId: r.id, toValue: f.title });
  return { item: view(u, await row(r.id), set), withdrawn: wasApproved };
}
async function remove(u, id) {
  await ensure();
  const g = await getRow(u, id);
  if (!g) return { error: 'This content was not found.', status: 404 };
  const { r } = g;
  if (!mayWrite(u) || !(A.isAdmin(u) || r.createdById === u.id)) return { error: 'Only the person who wrote it, or an Admin, can delete this content.', status: 403 };
  if (r.status === 'waiting') return { error: 'It is waiting for approval. Ask the approver to send it back first.', status: 409 };
  await unpublish(r);
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ? WHERE id = ?`, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: content deleted', entity: TABLE, entityId: r.id, toValue: r.title });
  return { ok: true };
}

// ---- approval ----------------------------------------------------------------------------------------------------------------
const isTestUser = (x) => /zztest|example\.test/i.test(`${x.name || ''} ${x.email || ''}`);
async function approverIds(r, set, exceptId) {
  const out = [];
  try {
    const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
    const users = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'TL', 'STL'] } }] }, select: { id: true, name: true, email: true }, take: 200 });
    for (const x of users.filter((y) => !isTestUser(y) && y.id !== exceptId).slice(0, 80)) {
      let ident = null; try { ident = await resolveIdentity(x.id); } catch { ident = null; } // eslint-disable-line no-await-in-loop
      if (ident && canApprove(ident, r, set)) out.push(x.id);
    }
  } catch { /* the notice is a courtesy */ }
  return out;
}
async function submit(u, id) {
  await ensure();
  const g = await getRow(u, id);
  if (!g) return { error: 'This content was not found.', status: 404 };
  const { r, set } = g;
  if (!mayWrite(u) || !(A.isAdmin(u) || r.createdById === u.id)) return { error: 'Only the person who wrote it, or an Admin, can ask for approval.', status: 403 };
  if (r.status === 'waiting') return { error: 'It is already waiting for approval.', status: 409 };
  if (r.status === 'approved') return { error: 'It is already approved.', status: 409 };
  const t = parse(r.texts, {});
  if (!Object.keys(t).length) return { error: 'Write at least one channel version first.', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${TABLE}" SET status = 'waiting', note = NULL, submittedAt = ?, submittedByName = ?, updatedAt = ? WHERE id = ?`, now, S.clip(u.name, 80), now, r.id);
  const ids = await approverIds(r, set, u.id);
  if (ids.length) await notifyUsers(ids, { title: `AI content "${S.clip(r.title, 60)}" needs your approval`, message: `${S.clip(u.name, 60)} asked for approval. Open Omni-Channel > AI Marketing > Approvals.` });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: content sent for approval', entity: TABLE, entityId: r.id, toValue: `${r.title}; ${ids.length} approver(s) told` });
  return { ok: ids.length ? 'Sent for approval. The approvers have been told.' : 'Sent for approval. No approver could be told by notice: ask an Admin to open the Approvals tab.', approvers: ids.length, item: view(u, await row(r.id), set) };
}

// approving copies the approved words into the Content Library (OmniStudioContent), where the campaign screens find them
async function publishToLibrary(r, maker) {
  await St.ensure();
  const texts = parse(r.texts, {});
  const adaptations = {};
  St.CHANNELS.forEach((c) => { if (texts[c.key]) adaptations[c.key] = String(texts[c.key]).slice(0, c.limit); });
  const master = texts.whatsapp || texts.email || texts.sms || texts.linkedin || texts.facebook || Object.values(texts)[0] || '';
  const dept = r.department || null;
  const now = Date.now();
  if (r.libraryId) {
    const cur = (await S.q('SELECT id FROM "OmniStudioContent" WHERE id = ? AND deletedAt IS NULL', r.libraryId))[0];
    if (cur) {
      await S.run('UPDATE "OmniStudioContent" SET master = ?, subject = ?, adaptations = ?, voice = ?, cta = ?, updatedAt = ? WHERE id = ?', master, r.subject || null, JSON.stringify(adaptations), r.tone || null, r.cta || null, now, r.libraryId);
      return r.libraryId;
    }
  }
  let name = S.clip(r.title, 70); let n = 1;
  for (;;) {
    const same = (await S.q('SELECT id FROM "OmniStudioContent" WHERE deletedAt IS NULL AND LOWER(name) = LOWER(?) AND COALESCE(department, \'\') = ?', name, dept || ''))[0];
    if (!same) break;
    n += 1; name = `${S.clip(r.title, 60)} (AI ${n})`;
    if (n > 30) break;
  }
  const id = S.newId('sc');
  await S.run('INSERT INTO "OmniStudioContent" (id, name, voice, cta, master, subject, adaptations, libraryIds, department, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,\'ready\',?,?,?,?)',
    id, name, r.tone || null, r.cta || null, master, r.subject || null, JSON.stringify(adaptations), '[]', dept, maker.id, maker.name, now, now);
  return id;
}
async function decide(u, id, approve, note) {
  await ensure();
  const g = await getRow(u, id);
  if (!g) return { error: 'This content was not found.', status: 404 };
  const { r, set } = g;
  if (r.status !== 'waiting') return { error: 'This content is not waiting for approval.', status: 409 };
  if (!canApprove(u, r, set)) {
    return { error: r.createdById === u.id ? 'You cannot approve your own content. Another approver (a Team Lead of the department, or an Admin) has to do it.' : 'Only an Admin, or a Team Lead of this department, can approve this content.', status: 403 };
  }
  const words = S.clip(note, 300);
  if (!approve && words.length < 5) return { error: 'Write a few words so the person knows what to change.', status: 400 };
  const now = Date.now();
  const self = r.createdById === u.id;
  if (approve) {
    const libraryId = await publishToLibrary(r, { id: r.createdById || u.id, name: r.createdByName || u.name });
    await S.run(`UPDATE "${TABLE}" SET status = 'approved', note = ?, decidedAt = ?, decidedById = ?, decidedByName = ?, selfApproved = ?, libraryId = ?, updatedAt = ? WHERE id = ?`, words || null, now, u.id, S.clip(u.name, 80), self ? 1 : 0, libraryId, now, r.id);
  } else {
    await S.run(`UPDATE "${TABLE}" SET status = 'changes', note = ?, decidedAt = ?, decidedById = ?, decidedByName = ?, selfApproved = 0, updatedAt = ? WHERE id = ?`, words, now, u.id, S.clip(u.name, 80), now, r.id);
  }
  if (r.createdById && !self) {
    await notifyUsers([r.createdById], approve
      ? { title: `AI content "${S.clip(r.title, 60)}" was approved`, message: `${S.clip(u.name, 60)} approved it${words ? `: ${words}` : ''}. It is now in the Content Library for campaigns.` }
      : { title: `AI content "${S.clip(r.title, 60)}" needs changes`, message: `${S.clip(u.name, 60)} sent it back: ${words}` });
  }
  await logAudit({ userId: u.id, actorName: u.name, action: approve ? (self ? 'Omni-Channel AI Marketing: content self-approved by an Admin' : 'Omni-Channel AI Marketing: content approved') : 'Omni-Channel AI Marketing: content sent back', entity: TABLE, entityId: r.id, toValue: approve ? `${r.title}; now in the Content Library` : `${r.title}: ${words}` });
  return { ok: approve ? 'Approved. It is now in the Content Library, ready for campaigns.' : 'Sent back with your note.', item: view(u, await row(r.id), set) };
}

module.exports = { ensure, CHANNELS, KEYS, GOALS, generate, revise, list, counts, create, update, remove, submit, approve: (u, id, n) => decide(u, id, true, n), reject: (u, id, n) => decide(u, id, false, n), getRow, view, mayWrite, finish, flagsOf };
