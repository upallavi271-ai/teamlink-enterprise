// ---------------------------------------------------------------------------
// AI MARKETING > EMAIL MARKETING (module 2; 2026-11-14). The AI writes the subject lines and the email of a JOB campaign in the brand voice; a person picks, edits and (optionally) sets up an A/B
// SUBJECT TEST; TeamLink hands it to the campaign engine that already exists (Omni-Channel Templates + Campaigns). NOTHING IS SENT FROM HERE, ever:
//   1 write     pick an OPEN job, tone, language, what to say: the AI writes 5 subject lines and 2 emails. The email may only use {{name}} {{job_title}} {{company}} {{apply_link}}; the apply link and
//               the unsubscribe line ({{unsubscribe}}) are always there (the engine refuses a promotion email without them). Each text shows its checks (length, spam-looking words, link, unsubscribe ...).
//   2 choose    subject A (and, for an A/B test, subject B), the email words: edit freely.
//   3 template  "Make the template" saves an email template in Omni-Channel > Templates (email needs no outside approval, so it is ready at once).
//   4 campaign  "Make the campaign" saves a campaign that was NEVER SENT, by default asking a Team Lead to approve it first ("approval before a mass email"). A person opens it in Campaigns and presses Send:
//               who agreed, the unsubscribe list, quiet hours, the daily cap, credits, Test mode and approval all apply there.
//   A/B test    the campaign carries subject B too: half of the people (a fixed coin on the message id: outreach/campaigns.js abVariant) get A, half get B. The report shows, per subject, how many were sent and
//               how many CLICKED the apply link. It names a leader only with at least 30 sends on each and a gap of 3 points or more; otherwise it says it is too early. It does not send the winner on by
//               itself (a campaign goes out once).
//   report      sent, clicks (the apply link is a tracked short link) and replies. OPENS ARE NOT COUNTED: these are plain-text emails with no tracking picture, and mail apps hide opens anyway.
// Table OmniMkEmailSet (self-provisioned). Every AI call goes through marketing/ai.js (module 'email'). Audit rows start with "Omni-Channel AI Marketing". No address is stored here.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const T = require('../outreach/templates');
const Camp = require('../outreach/campaigns');
const Gs = require('../outreach/gsCampaigns');
const Appr = require('../outreach/approval');
const St = require('../outreach/studio');
const AI = require('./ai');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const TABLE = 'OmniMkEmailSet';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "jobId" TEXT, "jobTitle" TEXT, "note" TEXT, "tone" TEXT, "language" TEXT, "subjectA" TEXT NOT NULL DEFAULT '', "subjectB" TEXT, "body" TEXT NOT NULL DEFAULT '', "variants" TEXT NOT NULL DEFAULT '{}', "tplId" TEXT, "campaignKey" TEXT, "meta" TEXT NOT NULL DEFAULT '{}', "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_user" ON "${TABLE}"("createdById", "updatedAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await AI.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] email schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

const WORDS = ['name', 'job_title', 'company', 'apply_link']; // {{unsubscribe}} is added by TeamLink, never written by the AI
const SUBJECT_WORDS = ['name', 'job_title', 'company']; // a subject has no link and no unsubscribe line
const SUBJECT_SOFT = 60; // a good length; over it is a warning, over SUBJECT_HARD cannot be saved
const SUBJECT_HARD = 100;
const BODY_LIMIT = 2000; // once filled in
const LINK_LINE = '\n\nApply here: {{apply_link}}';
const UNSUB = '\n\n{{unsubscribe}}';
// words that make a mail look like spam to a mail filter or a person
const SPAMMY = ['free', 'guarantee', 'guaranteed', 'winner', 'act now', 'click here', '100%', 'cash', 'earn money', 'no cost', 'risk-free', 'limited time', 'urgent', 'congratulations', 'make money', 'buy now'];
const LANG_NOTE = { Telugu: 'Telugu', Hindi: 'Hindi', English: 'English' };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trim()}…`);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const varsIn = (text) => [...String(text || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
const LINK_SAMPLE = 'https://teamlink.example/api/public/outreach/r/AbCdEfGhIjKl';
const ctxOf = (job, brand) => ({ name: 'Anita', job_title: (job && job.title) || 'the role', company: brand || 'TeamLink', apply_link: LINK_SAMPLE, unsubscribe: 'https://teamlink.example/u/AbCdEfGhIjKlMnOp' });
const filled = (text, ctx) => String(text || '').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => (ctx[v] != null ? ctx[v] : m));
const brandHit = (text, avoid) => (avoid || []).filter((w) => w && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));

// ---- the texts: made safe, then checked ------------------------------------------------------------------------------------------------------------------------
function cleanSubject(raw, ctx) {
  let t = String(raw == null ? '' : raw).replace(/\r?\n+/g, ' ').replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').replace(/^subject\s*:\s*/i, '').trim();
  t = t.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => (SUBJECT_WORDS.includes(v) ? `{{${v}}}` : ''));
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  if (filled(t, ctx).length > SUBJECT_HARD) t = cut(t, SUBJECT_HARD);
  return t;
}
function shapeBody(raw, ctx) {
  const notes = [];
  let t = String(raw == null ? '' : raw).replace(/\r/g, '').trim();
  if (!t) return { text: '', notes };
  t = t.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => { if (WORDS.includes(v)) return `{{${v}}}`; if (v === 'unsubscribe') return ''; notes.push(`Took out the unknown word {{${v}}}.`); return ''; }).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const hasLink = /\{\{apply_link\}\}/.test(t);
  const tail = (hasLink ? '' : LINK_LINE) + UNSUB;
  let head = t;
  if (filled(`${head}${tail}`, ctx).length > BODY_LIMIT) {
    const linkAt = head.indexOf('{{apply_link}}');
    const keep = linkAt >= 0 ? head.slice(linkAt) : '';
    let front = linkAt >= 0 ? head.slice(0, linkAt) : head;
    while (front.length > 80 && filled(`${front}${keep}${tail}`, ctx).length > BODY_LIMIT) front = cut(front.replace(/…$/, ''), Math.max(80, front.length - 40));
    head = `${front.trim()}${keep ? ` ${keep}` : ''}`;
    notes.push('Shortened to fit.');
  }
  if (!hasLink) notes.push('Added the apply link.');
  return { text: `${head}${tail}`.trim(), notes };
}
function checkSubject(text, ctx, avoid = []) {
  const t = String(text || '');
  const f = filled(t, ctx);
  const unknown = varsIn(t).filter((v) => !SUBJECT_WORDS.includes(v));
  const low = f.toLowerCase();
  const spam = SPAMMY.filter((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}($|[^a-z0-9])`, 'i').test(low));
  const caps = (f.match(/\b[A-Z]{4,}\b/g) || []).length;
  const bang = (f.match(/!/g) || []).length;
  const items = [
    { id: 'size', label: f.length > SUBJECT_HARD ? `${f.length} letters: too long to save (most phones show about 40 to 60)` : f.length > SUBJECT_SOFT ? `${f.length} letters: long (most phones show about 40 to 60)` : `${f.length} letters`, ok: f.length > 0 && f.length <= SUBJECT_SOFT, hard: f.length === 0 || f.length > SUBJECT_HARD },
    { id: 'words', label: unknown.length ? `Unknown word ${unknown.map((v) => `{{${v}}}`).join(', ')} (a subject can use {{name}}, {{job_title}}, {{company}})` : 'Only words TeamLink knows', ok: unknown.length === 0, hard: unknown.length > 0 },
    { id: 'spam', label: spam.length ? `Looks like spam to a mail filter: ${spam.join(', ')}` : 'No spam-looking words', ok: spam.length === 0 },
    { id: 'caps', label: caps > 1 || bang > 1 ? 'Too much SHOUTING or too many exclamation marks' : 'Calm tone', ok: caps <= 1 && bang <= 1 },
    { id: 'brand', label: brandHit(t, avoid).length ? `Uses a word the brand never says: ${brandHit(t, avoid).join(', ')}` : 'No never-say words', ok: brandHit(t, avoid).length === 0 },
  ];
  return { ok: items.every((x) => x.ok), blocked: items.some((x) => !x.ok && x.hard), items };
}
function checkBody(text, ctx, avoid = []) {
  const t = String(text || '');
  const unknown = varsIn(t).filter((v) => !WORDS.includes(v) && v !== 'unsubscribe');
  const len = filled(t, ctx).length;
  const items = [
    { id: 'link', label: 'Has the apply link', ok: /\{\{apply_link\}\}/.test(t), hard: true },
    { id: 'unsub', label: 'Has the unsubscribe line (the law asks for it)', ok: /\{\{unsubscribe\}\}/.test(t), hard: true },
    { id: 'words', label: unknown.length ? `Unknown word ${unknown.map((v) => `{{${v}}}`).join(', ')}` : 'Only words TeamLink knows', ok: unknown.length === 0, hard: unknown.length > 0 },
    { id: 'size', label: `${len} of ${BODY_LIMIT} letters once filled in`, ok: len > 0 && len <= BODY_LIMIT, hard: len === 0 || len > BODY_LIMIT },
    { id: 'brand', label: brandHit(t, avoid).length ? `Uses a word the brand never says: ${brandHit(t, avoid).join(', ')}` : 'No never-say words', ok: brandHit(t, avoid).length === 0 },
  ];
  return { ok: items.every((x) => x.ok), blocked: items.some((x) => !x.ok && x.hard), items };
}

// ---- the AI ----------------------------------------------------------------------------------------------------------------------------------------------------
function promptFor(f, job, brand) {
  const system = [
    `You are the recruitment email copywriter for ${brand.brandName || 'TeamLink'}, a staffing company. You write the subject line and the plain-text email of a mail that tells candidates about ONE open job.`,
    brand.about ? `About the company: ${brand.about}` : '', brand.voice ? `Brand voice: ${brand.voice}` : '',
    `Tone: ${f.tone}. Write in ${LANG_NOTE[f.language] || 'English'}${f.language === 'English' ? '' : ' (use the usual script of that language)'}.`,
    brand.doWords.length ? `Use these words or phrases where they fit naturally: ${brand.doWords.join(', ')}.` : '',
    brand.avoidWords.length ? `Never use these words or phrases: ${brand.avoidWords.join(', ')}.` : '',
    brand.signOff ? `Sign the email off with: ${brand.signOff}.` : '',
    `SUBJECT LINES: write ${f.nSubjects} different ones, each a different angle, at most 55 characters, calm, no ALL CAPS, at most one exclamation mark, none of: free, guaranteed, winner, urgent, click here, 100%, cash. A subject may use {{name}} or {{job_title}} or {{company}}, but never a link.`,
    `EMAILS: write ${f.nBodies} different ones, plain text, 70 to 130 words, greeting "Hi {{name}},", short paragraphs, ONE clear call to action that contains {{apply_link}} exactly once, then the sign-off. Do not write an unsubscribe line (it is added automatically).`,
    'Use ONLY these placeholders, written exactly like this: {{name}} {{job_title}} {{company}} {{apply_link}}. Use only facts that are in the job details: never invent a salary, benefit, date, phone number or link. No promises of a job.',
    'Answer with ONLY a JSON object, no other words: {"subjects":[{"angle":"<two to four words>","text":"<the subject line>"}],"bodies":[{"angle":"<two to four words>","text":"<the email>"}]}',
  ].filter(Boolean).join('\n');
  const prompt = [
    `Job: ${job.title}${job.location ? ` in ${job.location}` : ''}${job.department ? ` (${job.department})` : ''}${job.openings ? `, ${job.openings} opening${Number(job.openings) === 1 ? '' : 's'}` : ''}`,
    f.note ? `What the team wants to say: ${f.note}` : '',
  ].filter(Boolean).join('\n');
  return { system, prompt };
}
function demoWrite(f, job, brand) {
  const co = brand.brandName || 'TeamLink';
  const where = job.location ? ` in ${job.location}` : '';
  const said = String(f.note || '').replace(/\s+/g, ' ').trim();
  const extra = said ? `\n\n${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}` : '';
  const sign = brand.signOff || `The team at ${co}`;
  return {
    subjects: [
      { angle: 'The role', text: `${job.title} opening${where}` }, { angle: 'Personal', text: '{{name}}, a {{job_title}} role that may suit you' }, { angle: 'Plain', text: `Hiring now: ${job.title}` },
      { angle: 'Company', text: 'Your next step: {{job_title}} at {{company}}' }, { angle: 'Question', text: `Looking for a ${job.title} job?` },
    ].slice(0, f.nSubjects),
    bodies: [
      { angle: 'Direct and clear', text: `Hi {{name}},\n\n{{company}} is hiring a {{job_title}}${where}.${extra}\n\nIf this sounds like you, you can see the details and apply in two minutes:\n{{apply_link}}\n\nThank you,\n${sign}` },
      { angle: 'Warm and personal', text: `Hi {{name}},\n\nI wanted you to be among the first to hear about a new opening at {{company}}: {{job_title}}${where}.${extra}\n\nHave a look and apply here when you are ready:\n{{apply_link}}\n\nBest wishes,\n${sign}` },
    ].slice(0, f.nBodies),
  };
}

async function jobOf(u, jobId) {
  const v = await Camp.validate(u, { type: 'job_promotion', channel: 'email', requirementId: jobId, segmentIds: [] }, { needSegments: false, needTemplate: false });
  if (v.error) return { error: v.error, status: v.status || 400 };
  const r = v.requirement;
  return { job: { id: r.id, title: r.title, location: r.location || '', department: r.department || '', openings: r.openings || 0 } };
}
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const visibleTo = (u, r) => !!r && !r.deletedAt && (A.isAdmin(u) || r.createdById === u.id);

// ---- 1 write --------------------------------------------------------------------------------------------------------------------------------------------------------
async function write(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to write.', status: 403 };
  if (!b.jobId) return { error: 'Pick the open job this email is about.', status: 400 };
  const j = await jobOf(u, b.jobId); if (j.error) return j;
  const brand = await Cfg.getBrand();
  const f = { note: S.clip(b.note, 600), nSubjects: 5, nBodies: 2, tone: St.VOICES.includes(b.tone) ? b.tone : (St.VOICES.includes(brand.tone) ? brand.tone : St.VOICES[0]), language: Cfg.LANGUAGES.includes(b.language) ? b.language : brand.language };
  const { system, prompt } = promptFor(f, j.job, brand);
  let made;
  try { made = await AI.generate({ user: u, module: 'email', task: 'write', system, prompt, json: true, demo: () => demoWrite(f, j.job, brand), itemId: b.id || undefined }); } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
  const ctx = ctxOf(j.job, brand.brandName);
  const res = made.result && typeof made.result === 'object' ? made.result : {};
  const seen = new Set();
  const subjects = (Array.isArray(res.subjects) ? res.subjects : []).map((x) => ({ angle: S.clip(x && x.angle, 40) || 'Subject', text: cleanSubject(x && (x.text || x.subject), ctx) })).filter((x) => x.text && !seen.has(x.text.toLowerCase()) && seen.add(x.text.toLowerCase())).slice(0, 6).map((x) => ({ ...x, checks: checkSubject(x.text, ctx, brand.avoidWords) }));
  const bodies = (Array.isArray(res.bodies) ? res.bodies : []).map((x, i) => { const s = shapeBody(x && (x.text || x.body), ctx); return { angle: S.clip(x && x.angle, 40) || `Version ${i + 1}`, text: s.text, notes: s.notes, checks: checkBody(s.text, ctx, brand.avoidWords) }; }).filter((x) => x.text).slice(0, 3);
  if (!subjects.length || !bodies.length) return { error: 'The AI did not write anything usable. Try again, or write a shorter note.', status: 502 };
  return { subjects, bodies, job: j.job, ai: { provider: made.provider, model: made.model, demo: made.demo, ms: made.ms }, used: { tone: f.tone, language: f.language } };
}
async function check(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login cannot use AI Marketing.', status: 403 };
  const brand = await Cfg.getBrand();
  let job = null;
  if (b.jobId) { const j = await jobOf(u, b.jobId); if (!j.error) job = j.job; }
  const ctx = ctxOf(job, brand.brandName);
  const out = {};
  if (typeof b.subjectA === 'string') out.subjectA = checkSubject(b.subjectA, ctx, brand.avoidWords);
  if (typeof b.subjectB === 'string' && b.subjectB) out.subjectB = checkSubject(b.subjectB, ctx, brand.avoidWords);
  if (typeof b.body === 'string') out.body = checkBody(b.body, ctx, brand.avoidWords);
  return { checks: out };
}

// ---- the saved set -----------------------------------------------------------------------------------------------------------------------------------------------------
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, id))[0] || null;
async function templateState(u, r) {
  if (!r.tplId) return null;
  const tr = await T.get(u, r.tplId);
  if (!tr || tr.status !== 'active') return { id: r.tplId, gone: true, ready: false, why: 'This template was removed in Templates. Make it again.' };
  const v = T.view(tr);
  return { id: v.id, name: v.name, ready: !!v.ready, why: v.why || '', subject: v.subject, sameWords: v.body === r.body && v.subject === r.subjectA };
}
const SENT_LIKE = ['sent', 'test_captured', 'delivered', 'bounced', 'complained'];
// the A/B report: per subject how many were sent and how many clicked the apply link (the half a person is in is worked out from the message id again)
async function abReport(rowIds, subjectA, subjectB) {
  const out = { A: { subject: subjectA, sent: 0, clicked: 0, replied: 0 }, B: { subject: subjectB, sent: 0, clicked: 0, replied: 0 } };
  if (!rowIds.length) return null;
  const rows = await S.q(`SELECT id, status, firstClickAt, repliedAt FROM "OutreachMessage" WHERE campaignId IN (${rowIds.map(() => '?').join(',')})`, ...rowIds);
  rows.forEach((m) => { if (!SENT_LIKE.includes(m.status)) return; const v = Camp.abVariant(m.id); out[v].sent += 1; if (m.firstClickAt) out[v].clicked += 1; if (m.repliedAt) out[v].replied += 1; });
  const rate = (x) => (x.sent ? Math.round((x.clicked / x.sent) * 1000) / 10 : null);
  out.A.rate = rate(out.A); out.B.rate = rate(out.B);
  let leader = null; let why = '';
  if (out.A.sent < 30 || out.B.sent < 30) why = `Too early to say: each subject needs at least 30 sends (A ${out.A.sent}, B ${out.B.sent} so far).`;
  else if (Math.abs(out.A.rate - out.B.rate) < 3) why = 'No clear winner: the two are within 3 points of each other.';
  else { leader = out.A.rate > out.B.rate ? 'A' : 'B'; why = `Subject ${leader} got more clicks (${out[leader].rate}% against ${out[leader === 'A' ? 'B' : 'A'].rate}%).`; }
  return { ...out, leader, why };
}
async function campaignState(u, r) {
  if (!r.campaignKey) return null;
  try {
    const f = await Gs.loadOne(u, r.campaignKey);
    if (f.error) return { gone: true, words: 'This campaign was removed or is not yours to see.' };
    const word = Gs.groupStatus(f.group.rows);
    const ids = f.group.rows.map((x) => x.id);
    const m = await Gs.metricsFor(ids);
    const sum = Object.values(m).reduce((a, x) => { Object.keys(x).forEach((k) => { a[k] = (a[k] || 0) + (x[k] || 0); }); return a; }, {});
    return {
      key: r.campaignKey, status: word, words: (Gs.STATUS[word] || [word, word])[1], sent: sum.ok || 0, rehearsed: sum.rehearsed || 0, clicked: sum.clicked || 0, replied: sum.replied || 0, failed: sum.failed || 0, waiting: sum.waiting || 0,
      ab: r.subjectB ? await abReport(ids, r.subjectA, r.subjectB) : null,
    };
  } catch { return null; }
}
function nextStep(r, tpl, camp) {
  if (!r.subjectA || !r.body) return { id: 'write', words: 'Write the email.' };
  if (!tpl || tpl.gone) return { id: 'template', words: tpl && tpl.gone ? 'The template was removed. Make it again.' : 'Make the template.' };
  if (!tpl.sameWords && !r.campaignKey) return { id: 'template', words: 'You changed the words: update the template.' };
  if (!tpl.ready) return { id: 'fix', words: tpl.why || 'The template is not ready.' };
  if (!camp) return { id: 'campaign', words: 'Make the campaign.' };
  if (camp.gone) return { id: 'campaign', words: 'The campaign was removed. Make it again.' };
  if (camp.status === 'notsent' || camp.status === 'changes') return { id: 'send', words: 'Open the campaign in Campaigns, check it and press Send.' };
  if (camp.status === 'approval') return { id: 'approval', words: 'Waiting for a Team Lead to approve the campaign.' };
  return { id: 'done', words: camp.words };
}
async function view(u, r, { full = true } = {}) {
  const tpl = await templateState(u, r);
  const camp = await campaignState(u, r);
  return {
    id: r.id, title: r.title, jobId: r.jobId || '', jobTitle: r.jobTitle || '', note: r.note || '', tone: r.tone || '', language: r.language || '', subjectA: r.subjectA || '', subjectB: r.subjectB || '', body: r.body || '',
    ...(full ? { variants: parse(r.variants, {}) } : {}), template: tpl, campaign: camp, next: nextStep(r, tpl, camp), ai: parse(r.meta, {}).ai || null, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt),
  };
}
async function list(u) {
  if (!mayWrite(u)) return { error: 'Your login cannot open Email marketing.', status: 403 };
  await ensure();
  const rows = A.isAdmin(u) ? await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 100`) : await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND createdById = ? ORDER BY updatedAt DESC LIMIT 100`, u.id);
  const sets = [];
  for (const r of rows) sets.push(await view(u, r, { full: false })); // eslint-disable-line no-await-in-loop
  return { sets };
}
async function get(u, id) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'This email was not found.', status: 404 };
  return { set: await view(u, r) };
}
// b: { id?, title, jobId, subjectA, subjectB?, body, note, tone, language, variants?, ai? }
async function save(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to write.', status: 403 };
  await ensure();
  const cur = b.id ? await row(b.id) : null;
  if (b.id && !visibleTo(u, cur)) return { error: 'This email was not found.', status: 404 };
  if (cur && cur.campaignKey) return { error: 'A campaign was already made from this email, so its words cannot change. Make a new one.', status: 409 };
  const jobId = b.jobId || (cur && cur.jobId);
  if (!jobId) return { error: 'Pick the open job this email is about.', status: 400 };
  const j = await jobOf(u, jobId);
  if (j.error && !(cur && cur.jobId === jobId && j.status === 400)) return j;
  const jobTitle = j.job ? j.job.title : (cur && cur.jobTitle) || '';
  const brand = await Cfg.getBrand();
  const ctx = ctxOf(j.job || { title: jobTitle }, brand.brandName);
  const subjectA = String(b.subjectA == null ? (cur && cur.subjectA) || '' : b.subjectA).replace(/\s+/g, ' ').trim();
  const subjectB = String(b.subjectB == null ? (cur && cur.subjectB) || '' : b.subjectB).replace(/\s+/g, ' ').trim();
  const body = String(b.body == null ? (cur && cur.body) || '' : b.body).replace(/\r/g, '').trim().slice(0, 6000);
  if (!subjectA) return { error: 'Write the subject line.', status: 400 };
  if (!body) return { error: 'Write the email.', status: 400 };
  const ca = checkSubject(subjectA, ctx, brand.avoidWords); if (ca.blocked) return { error: `Subject: ${ca.items.find((x) => !x.ok && x.hard).label}.`, status: 400, code: 'check' };
  if (subjectB) {
    if (subjectB.toLowerCase() === subjectA.toLowerCase()) return { error: 'Subject B is the same as subject A. Write a different one, or leave B empty.', status: 400 };
    const cb = checkSubject(subjectB, ctx, brand.avoidWords); if (cb.blocked) return { error: `Subject B: ${cb.items.find((x) => !x.ok && x.hard).label}.`, status: 400, code: 'check' };
  }
  const cbody = checkBody(body, ctx, brand.avoidWords); if (cbody.blocked) return { error: `Email: ${cbody.items.find((x) => !x.ok && x.hard).label}. TeamLink cannot use it like this.`, status: 400, code: 'check' };
  const title = S.clip(b.title, 80) || `${jobTitle || 'Job'} · email`;
  const meta = { ...(cur ? parse(cur.meta, {}) : {}), ...(b.ai ? { ai: { provider: S.clip(b.ai.provider, 40), model: S.clip(b.ai.model, 60), demo: !!b.ai.demo } } : {}) };
  const now = Date.now();
  if (cur) {
    await S.run(`UPDATE "${TABLE}" SET title = ?, jobId = ?, jobTitle = ?, note = ?, tone = ?, language = ?, subjectA = ?, subjectB = ?, body = ?, variants = ?, meta = ?, updatedAt = ? WHERE id = ?`,
      title, jobId, jobTitle, S.clip(b.note, 600) || null, S.clip(b.tone, 40) || cur.tone, S.clip(b.language, 20) || cur.language, subjectA, subjectB || null, body, b.variants && typeof b.variants === 'object' ? JSON.stringify(b.variants).slice(0, 60000) : cur.variants, JSON.stringify(meta), now, cur.id);
    await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: email changed', entity: TABLE, entityId: cur.id, toValue: `${title}${subjectB ? '; A/B subject test' : ''}` });
    const set = await view(u, await row(cur.id));
    return { set, ok: set.template && !set.template.sameWords ? 'Saved. The template still has the old words: press "Update the template".' : 'Saved.' };
  }
  const id = S.newId('em');
  await S.run(`INSERT INTO "${TABLE}" (id, title, jobId, jobTitle, note, tone, language, subjectA, subjectB, body, variants, meta, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, title, jobId, jobTitle, S.clip(b.note, 600) || null, S.clip(b.tone, 40) || null, S.clip(b.language, 20) || null, subjectA, subjectB || null, body, b.variants && typeof b.variants === 'object' ? JSON.stringify(b.variants).slice(0, 60000) : '{}', JSON.stringify(meta), S.clip(u.department, 60) || null, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: email saved', entity: TABLE, entityId: id, toValue: `${title}${subjectB ? '; A/B subject test' : ''}${meta.ai ? (meta.ai.demo ? '; written by the sandbox sample writer' : `; written by ${meta.ai.provider}`) : ''}` });
  return { set: await view(u, await row(id)), ok: 'Saved.' };
}
async function remove(u, id) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'This email was not found.', status: 404 };
  if (r.campaignKey) return { error: 'A campaign was made from this email. Remove the campaign in Campaigns first.', status: 409 };
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ?, updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: email removed', entity: TABLE, entityId: r.id, toValue: r.title });
  return { ok: 'Removed. The template made from it stays in Templates.' };
}

// ---- 3 the template ----------------------------------------------------------------------------------------------------------------------------------------------------
async function makeTemplate(u, id) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'This email was not found.', status: 404 };
  if (!r.subjectA || !r.body) return { error: 'Write the email first.', status: 400 };
  if (r.campaignKey) return { error: 'A campaign was already made from this template, so it is not changed.', status: 409 };
  const have = r.tplId ? await T.get(u, r.tplId) : null;
  if (have && have.status === 'active') {
    const up = await T.update(u, have.id, { subject: r.subjectA, body: r.body });
    if (up.error) return { error: up.error, status: up.status || 400 };
    return { ok: 'The template has the new words.', set: await view(u, await row(r.id)) };
  }
  const name = `${S.clip(r.title, 66)} · Email`;
  let out = await T.create(u, { name, channel: 'email', audience: 'candidate_lead', promotional: true, subject: r.subjectA, body: r.body });
  if (out.error && out.status === 409) out = await T.create(u, { name: `${name} ${Date.now().toString(36).slice(-3)}`, channel: 'email', audience: 'candidate_lead', promotional: true, subject: r.subjectA, body: r.body });
  if (out.error) return { error: out.error, status: out.status || 400 };
  await S.run(`UPDATE "${TABLE}" SET tplId = ?, updatedAt = ? WHERE id = ?`, out.template.id, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: email template made', entity: TABLE, entityId: r.id, toValue: r.title });
  return { ok: 'The email template is in Templates and ready to use (an email needs no outside approval).', set: await view(u, await row(r.id)) };
}

// ---- 4 the campaign (saved, NEVER sent from here) -----------------------------------------------------------------------------------------------------------------
async function makeCampaign(u, id, b = {}) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'This email was not found.', status: 404 };
  if (r.campaignKey) return { error: 'A campaign was already made from this email.', status: 409 };
  const v = await view(u, r);
  if (v.next.id !== 'campaign') return { error: v.next.words, status: 409, code: 'not_ready' };
  const segmentIds = (Array.isArray(b.segmentIds) ? b.segmentIds : []).map(String).filter(Boolean);
  if (!segmentIds.length) return { error: 'Pick at least one group of people.', status: 400 };
  const out = await Gs.createGroup(u, { objective: 'job_promotion', name: S.clip(b.name, 80) || r.title, channels: ['email'], requirementId: r.jobId, segmentIds, templates: { email: v.template.id }, masterMessage: r.body, goal: S.clip(r.note, 600), saveOnly: true, approvalMode: 'auto' });
  if (out.error) return { error: out.error, status: out.status || 400, code: out.code };
  // the A/B test: subject B goes into the campaign's own copy of the message (the engine sends B to one half of the people)
  if (r.subjectB) {
    const rows = await Camp.groupRows(out.key);
    for (const c of rows) { // eslint-disable-line no-restricted-syntax
      const snap = parse(c.templateSnapshot, null);
      if (snap) await S.run('UPDATE "OutreachCampaign" SET templateSnapshot = ?, updatedAt = ? WHERE id = ?', JSON.stringify({ ...snap, subjectB: r.subjectB }), Date.now(), c.id); // eslint-disable-line no-await-in-loop
    }
  }
  let note = 'The campaign is saved and NOT sent. Open it in Campaigns to check it and press Send.';
  if (b.ask !== false) { const ap = await Appr.submit(u, out.key); note = ap.error ? `The campaign is saved and NOT sent. Approval could not be asked: ${ap.error}` : 'The campaign is saved and was sent to a Team Lead for approval. Nothing is sent until it is approved and a person presses Send.'; }
  await S.run(`UPDATE "${TABLE}" SET campaignKey = ?, updatedAt = ? WHERE id = ?`, out.key, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: email campaign saved', entity: TABLE, entityId: r.id, toValue: `${r.title}; ${segmentIds.length} group(s)${r.subjectB ? '; A/B subject test' : ''}; not sent` });
  return { ok: note, key: out.key, set: await view(u, await row(r.id)) };
}

async function options(u, { q } = {}) {
  if (!mayWrite(u)) return { error: 'Your login cannot open Email marketing.', status: 403 };
  const jobs = (await Camp.jobs(u, { q })).jobs;
  const gs = await Gs.options(u, { audience: 'candidate_lead' });
  const brand = await Cfg.getBrand();
  const em = (gs.channels || []).find((c) => c.channel === 'email') || {};
  return {
    jobs, canCampaign: A.mayCampaign(u), segments: gs.segments || [], email: { ready: !!em.ready, connected: !!(em.connection || {}).ready, note: em.note || '', canGoLive: !!em.canGoLive },
    tones: St.VOICES, languages: Cfg.LANGUAGES, brand: { name: brand.brandName || '', tone: brand.tone, language: brand.language }, testMode: !!(gs.settings || {}).testMode, approval: gs.approval || {}, ai: (await AI.status()).text,
    limits: { subjectSoft: SUBJECT_SOFT, minPerSubject: 30 },
  };
}

module.exports = { ensure, cleanSubject, shapeBody, checkSubject, checkBody, abReport, write, check, list, get, save, remove, makeTemplate, makeCampaign, options };
