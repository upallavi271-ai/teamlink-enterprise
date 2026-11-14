// ---------------------------------------------------------------------------
// AI MARKETING > CAMPAIGN MESSAGES (module 3, WhatsApp and SMS; 2026-11-14). The AI writes the WhatsApp and SMS words of a job campaign in the brand voice, a person picks and edits
// them, and TeamLink hands them to the campaign engine that already exists (Omni-Channel Templates + Campaigns). NOTHING IS SENT FROM HERE, ever:
//   1 write     pick an OPEN job, the ways (WhatsApp, SMS), tone and language: the AI writes up to three versions of each. The words may only use {{name}} {{job_title}} {{company}}
//               {{apply_link}}; the apply link and the "Reply STOP to opt out" line are always there (the engine refuses a promotion without them).
//   2 choose    the person edits and picks one version per way; every text shows its checks (link, opt-out line, length, known words, the brand's never-say words).
//   3 templates "Make the templates" saves them as draft templates in Omni-Channel > Templates (WhatsApp: waits for Meta's approval; SMS: needs the DLT number and sender ID).
//   4 campaign  once every picked way is ready, "Make the campaign" saves a campaign that was NEVER SENT (optionally asks for approval). A person opens it in Campaigns and presses Send:
//               the engine's own rules apply there (who agreed, STOP list, quiet hours, credits, Test mode, approval).
// Why a job: the campaign engine promotes ONE open job to candidates (outreach/campaigns.js), so every campaign here is about one. RCS is not part of this module: RCS sends today from
// Administration > Integrations > RCS (rcssms.in templates) and is not in the Omni campaign sender.
// Table OmniMkMsgSet (self-provisioned). Every AI call goes through marketing/ai.js (module 'messaging'). Audit rows start with "Omni-Channel AI Marketing". No phone or email is stored here.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
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

const TABLE = 'OmniMkMsgSet';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "jobId" TEXT, "jobTitle" TEXT, "channels" TEXT NOT NULL DEFAULT '[]', "note" TEXT, "tone" TEXT, "language" TEXT, "variants" TEXT NOT NULL DEFAULT '[]', "texts" TEXT NOT NULL DEFAULT '{}', "tplIds" TEXT NOT NULL DEFAULT '{}', "campaignKey" TEXT, "meta" TEXT NOT NULL DEFAULT '{}', "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_user" ON "${TABLE}"("createdById", "updatedAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await AI.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] messaging schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

// ---- the two ways ------------------------------------------------------------------------------------------------------------------------------------------
const WAYS = [
  { key: 'whatsapp', label: 'WhatsApp', limit: 600, hint: 'Sent as a Meta-approved template · up to 600 letters is a good size' },
  { key: 'sms', label: 'SMS', limit: 320, hint: 'Needs the DLT template number and the sender ID · two SMS parts at most' },
];
const KEYS = WAYS.map((w) => w.key);
const LIMIT = Object.fromEntries(WAYS.map((w) => [w.key, w.limit]));
const WORDS = ['name', 'job_title', 'company', 'apply_link']; // {{unsubscribe}} is not written by the AI: the "Reply STOP" line is added
const FOOT = { whatsapp: '\n\nReply STOP to opt out', sms: ' Reply STOP to opt out' };
const LINKLINE = { whatsapp: '\n\nApply here: {{apply_link}}', sms: ' Apply: {{apply_link}}' };
const LANG_CODE = { English: 'en', Telugu: 'te', Hindi: 'hi' };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trim()}…`);
const varsIn = (text) => [...String(text || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
const LINK_SAMPLE = 'https://teamlink.example/api/public/outreach/r/AbCdEfGhIjKl'; // about as long as the real short link

// how long the message really is once the words are filled in
const ctxOf = (job, brand) => ({ name: 'Anita', job_title: (job && job.title) || 'the role', company: brand || 'TeamLink', apply_link: LINK_SAMPLE });
const filled = (text, ctx) => String(text || '').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => (v === 'unsubscribe' ? 'Reply STOP to opt out' : (ctx[v] != null ? ctx[v] : m)));
const lengthOf = (text, ctx) => filled(text, ctx).length;

// make one text safe: known words only, the apply link and the opt-out line in, inside its size. -> { text, notes[] }
function shape(ch, raw, ctx) {
  const notes = [];
  let t = String(raw == null ? '' : raw).replace(/\r/g, '').trim();
  if (!t) return { text: '', notes };
  // words the engine does not know are taken out (it would refuse the template); {{unsubscribe}} is turned into the plain "Reply STOP" line
  t = t.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => { if (WORDS.includes(v)) return `{{${v}}}`; if (v === 'unsubscribe') return ''; notes.push(`Took out the unknown word {{${v}}}.`); return ''; }).replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim();
  if (ch === 'sms') t = t.replace(/\s*\n+\s*/g, ' ');
  const hasStop = /\bSTOP\b/i.test(t);
  const hasLink = /\{\{apply_link\}\}/.test(t);
  const foot = hasStop ? '' : FOOT[ch];
  const tail = (hasLink ? '' : LINKLINE[ch]) + foot;
  let head = t;
  if (lengthOf(`${head}${tail}`, ctx) > LIMIT[ch]) {
    // cut the words before the tail, never the apply link or the opt-out line: shorten from the end of the text that comes before the link
    const linkAt = head.indexOf('{{apply_link}}');
    const keep = linkAt >= 0 ? head.slice(linkAt) : '';
    let front = linkAt >= 0 ? head.slice(0, linkAt) : head;
    while (front.length > 20 && lengthOf(`${front}${keep}${tail}`, ctx) > LIMIT[ch]) front = cut(front.replace(/…$/, ''), Math.max(20, front.length - 12));
    head = `${front.trim()}${keep ? ` ${keep}` : ''}`.replace(/\s+…/g, '…');
    notes.push('Shortened to fit.');
  }
  const out = `${head}${tail}`.trim();
  if (!hasLink) notes.push('Added the apply link.');
  if (!hasStop) notes.push('Added "Reply STOP to opt out".');
  return { text: out, notes };
}
// what a person sees under each text: every check, ok or not
function checksOf(ch, text, ctx, avoid = []) {
  const t = String(text || '');
  const len = lengthOf(t, ctx);
  const unknown = varsIn(t).filter((v) => !WORDS.includes(v) && v !== 'unsubscribe');
  const flags = (avoid || []).filter((w) => w && new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(t));
  const items = [
    { id: 'link', label: 'Has the apply link', ok: /\{\{apply_link\}\}/.test(t) },
    { id: 'stop', label: 'Tells people how to stop (Reply STOP)', ok: /\bSTOP\b/i.test(t) || /\{\{unsubscribe\}\}/.test(t) },
    { id: 'words', label: unknown.length ? `Unknown word ${unknown.map((v) => `{{${v}}}`).join(', ')}` : 'Only words TeamLink knows', ok: unknown.length === 0 },
    { id: 'size', label: `${len} of ${LIMIT[ch]} letters once filled in`, ok: len > 0 && len <= LIMIT[ch] },
    { id: 'brand', label: flags.length ? `Uses a word the brand never says: ${flags.join(', ')}` : 'No never-say words', ok: flags.length === 0 },
  ];
  if (ch === 'sms') items.push({ id: 'emoji', label: 'No emoji (SMS)', ok: !/\p{Extended_Pictographic}/u.test(t) });
  return { ok: items.every((x) => x.ok), items };
}

// ---- the AI -----------------------------------------------------------------------------------------------------------------------------------------------------
function promptFor(f, job, brand) {
  const chans = f.channels.map((k) => `- ${k}: at most ${LIMIT[k]} letters once the words are filled in${k === 'sms' ? '; plain text, no emoji, no line breaks' : '; a friendly message, a line break before the call to action is fine'}`).join('\n');
  const system = [
    `You are the recruitment marketing copywriter for ${brand.brandName || 'TeamLink'}, a staffing company. You write the words of WhatsApp and SMS messages that tell candidates about ONE open job.`,
    brand.about ? `About the company: ${brand.about}` : '',
    brand.voice ? `Brand voice: ${brand.voice}` : '',
    `Tone: ${f.tone}. Write in ${f.language}${f.language === 'English' ? '' : ' (use the usual script of that language)'}.`,
    brand.doWords.length ? `Use these words or phrases where they fit naturally: ${brand.doWords.join(', ')}.` : '',
    brand.avoidWords.length ? `Never use these words or phrases: ${brand.avoidWords.join(', ')}.` : '',
    brand.emoji === 'none' ? 'Use no emoji.' : 'Use at most one emoji, only in WhatsApp.',
    `Rules: use ONLY these placeholders, written exactly like this: {{name}} (the person's first name), {{job_title}}, {{company}}, {{apply_link}}. Every message MUST contain {{apply_link}} once. Do not add opt-out lines (they are added automatically). Use only facts that are in the job details: never invent a salary, benefit, date, phone number or link. No promises of a job.`,
    'Answer with ONLY a JSON object, no other words: {"variants":[{"angle":"<two to four words that name this version>","texts":{"<channel>":"<the message>"}}]}',
  ].filter(Boolean).join('\n');
  const prompt = [
    `Job: ${job.title}${job.location ? ` in ${job.location}` : ''}${job.department ? ` (${job.department})` : ''}${job.openings ? `, ${job.openings} opening${Number(job.openings) === 1 ? '' : 's'}` : ''}`,
    f.note ? `What the team wants to say: ${f.note}` : '',
    `Write ${f.n} different version${f.n > 1 ? 's' : ''} (a different angle each). Channels:\n${chans}`,
  ].filter(Boolean).join('\n');
  return { system, prompt };
}
const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
function demoVariants(f, job, brand) {
  const co = brand.brandName || 'TeamLink';
  const where = job.location ? ` in ${job.location}` : '';
  const said = String(f.note || '').replace(/\s+/g, ' ').trim();
  const extra = said ? ` ${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}` : '';
  const masters = [
    { angle: 'Direct and clear', wa: `Hi {{name}}, {{company}} is hiring a {{job_title}}${where}.${extra}\n\nApply in two minutes: {{apply_link}}`, sms: `Hi {{name}}, {{company}} is hiring a {{job_title}}${where}.${extra} Apply: {{apply_link}}` },
    { angle: 'Opportunity first', wa: `Hello {{name}}, a new opening that may suit you: {{job_title}}${where} at {{company}}.${extra}\n\nSee the details and apply: {{apply_link}}`, sms: `{{name}}, new opening: {{job_title}}${where} at {{company}}.${extra} Details: {{apply_link}}` },
    { angle: 'Friendly nudge', wa: `Hi {{name}}, looking for your next role? ${co} has a {{job_title}} position${where}.${extra}\n\nTake a look: {{apply_link}}`, sms: `Hi {{name}}, ${lc(co)} has a {{job_title}} job${where}.${extra} Apply: {{apply_link}}` },
  ].slice(0, f.n);
  return { variants: masters.map((m) => ({ angle: m.angle, texts: Object.fromEntries(f.channels.map((k) => [k, k === 'sms' ? m.sms : m.wa])) })) };
}

// the job (open, in this person's area: the engine's own check) -> { job } or { error }
async function jobOf(u, jobId) {
  const v = await Camp.validate(u, { type: 'job_promotion', channel: 'whatsapp', requirementId: jobId, segmentIds: [] }, { needSegments: false, needTemplate: false });
  if (v.error) return { error: v.error, status: v.status || 400 };
  const r = v.requirement;
  return { job: { id: r.id, title: r.title, location: r.location || '', department: r.department || '', openings: r.openings || 0 } };
}
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const visibleTo = (u, r) => !!r && !r.deletedAt && (A.isAdmin(u) || r.createdById === u.id);

function cleanChannels(list) {
  const out = (Array.isArray(list) ? list : []).map(String).filter((k, i, a) => KEYS.includes(k) && a.indexOf(k) === i);
  return out.length ? out : null;
}

// ---- 1 write --------------------------------------------------------------------------------------------------------------------------------------------------------
async function write(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to write.', status: 403 };
  const channels = cleanChannels(b.channels); if (!channels) return { error: 'Pick WhatsApp, SMS or both.', status: 400 };
  if (!b.jobId) return { error: 'Pick the open job these messages are about.', status: 400 };
  const j = await jobOf(u, b.jobId); if (j.error) return j;
  const brand = await Cfg.getBrand();
  const f = { channels, note: S.clip(b.note, 600), n: Math.max(1, Math.min(3, Number(b.variants) || 3)), tone: St.VOICES.includes(b.tone) ? b.tone : (St.VOICES.includes(brand.tone) ? brand.tone : St.VOICES[0]), language: Cfg.LANGUAGES.includes(b.language) ? b.language : brand.language };
  const { system, prompt } = promptFor(f, j.job, brand);
  let made;
  try {
    made = await AI.generate({ user: u, module: 'messaging', task: 'write', system, prompt, json: true, demo: () => demoVariants(f, j.job, brand), itemId: b.id || undefined });
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code }; }
  const ctx = ctxOf(j.job, brand.brandName);
  const raw = Array.isArray(made.result && made.result.variants) ? made.result.variants : [];
  const variants = raw.slice(0, 3).map((v, i) => {
    const texts = {}; const notes = {}; const checks = {};
    channels.forEach((k) => {
      const src = v && v.texts && typeof v.texts === 'object' ? v.texts[k] : '';
      const s = shape(k, src, ctx);
      texts[k] = s.text; notes[k] = s.notes; checks[k] = checksOf(k, s.text, ctx, brand.avoidWords);
    });
    return { angle: S.clip(v && v.angle, 40) || `Version ${i + 1}`, texts, notes, checks };
  }).filter((v) => channels.some((k) => v.texts[k]));
  if (!variants.length) return { error: 'The AI did not write anything usable. Try again, or write a shorter note.', status: 502 };
  return { variants, job: j.job, ai: { provider: made.provider, model: made.model, demo: made.demo, ms: made.ms }, used: { tone: f.tone, language: f.language, channels } };
}
// the checks of a text a person edited (the screen asks as they type)
async function check(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login cannot use AI Marketing.', status: 403 };
  const brand = await Cfg.getBrand();
  let job = null;
  if (b.jobId) { const j = await jobOf(u, b.jobId); if (!j.error) job = j.job; }
  const ctx = ctxOf(job, brand.brandName);
  const out = {};
  KEYS.forEach((k) => { if (typeof (b.texts || {})[k] === 'string') out[k] = checksOf(k, b.texts[k], ctx, brand.avoidWords); });
  return { checks: out };
}

// ---- the saved set -------------------------------------------------------------------------------------------------------------------------------------------------
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, id))[0] || null;
async function stateOfTemplates(u, r) {
  const ids = parse(r.tplIds, {}); const out = {};
  for (const k of KEYS) { // eslint-disable-line no-restricted-syntax
    if (!ids[k]) continue; // eslint-disable-line no-continue
    const tr = await T.get(u, ids[k]); // eslint-disable-line no-await-in-loop
    if (!tr || tr.status !== 'active') { out[k] = { id: ids[k], gone: true, ready: false, why: 'This template was removed in Templates. Make it again.' }; continue; } // eslint-disable-line no-continue
    const v = T.view(tr);
    out[k] = { id: v.id, name: v.name, ready: !!v.ready, why: v.why || '', waApprovalStatus: v.waApprovalStatus, waTemplateName: v.waTemplateName, dltTemplateId: v.dltTemplateId, senderId: v.senderId, body: v.body };
  }
  return out;
}
async function campaignState(u, r) {
  if (!r.campaignKey) return null;
  try {
    const f = await Gs.loadOne(u, r.campaignKey);
    if (f.error) return { gone: true, words: 'This campaign was removed or is not yours to see.' };
    const word = Gs.groupStatus(f.group.rows);
    const m = await Gs.metricsFor(f.group.rows.map((x) => x.id));
    const sum = Object.values(m).reduce((a, x) => { Object.keys(x).forEach((k) => { a[k] = (a[k] || 0) + (x[k] || 0); }); return a; }, {});
    return { key: r.campaignKey, status: word, words: (Gs.STATUS[word] || [word, word])[1], sent: sum.ok || 0, delivered: sum.delivered || 0, read: sum.read || 0, replied: sum.replied || 0, clicked: sum.clicked || 0, failed: sum.failed || 0, rehearsed: sum.rehearsed || 0, waiting: sum.waiting || 0 };
  } catch { return null; }
}
// what to do next, in plain words
function nextStep(r, tpls, camp) {
  const texts = parse(r.texts, {}); const chans = parse(r.channels, []);
  if (!chans.some((k) => texts[k])) return { id: 'write', words: 'Write the messages.' };
  const ids = parse(r.tplIds, {});
  if (!chans.every((k) => ids[k] && tpls[k] && !tpls[k].gone)) return { id: 'templates', words: 'Make the templates.' };
  const wa = tpls.whatsapp; const sm = tpls.sms;
  if (chans.includes('whatsapp') && wa && !wa.ready) return { id: 'meta', words: wa.waApprovalStatus === 'pending' ? 'Waiting for Meta to approve the WhatsApp message.' : wa.waApprovalStatus === 'rejected' ? 'Meta rejected the WhatsApp message: change the words and send it again.' : 'Send the WhatsApp message to Meta for approval.' };
  if (chans.includes('sms') && sm && !sm.ready) return { id: 'dlt', words: 'Add the DLT template number and the sender ID to the SMS message.' };
  if (!camp) return { id: 'campaign', words: 'Make the campaign.' };
  if (camp.gone) return { id: 'campaign', words: 'The campaign was removed. Make it again.' };
  if (camp.status === 'notsent' || camp.status === 'changes') return { id: 'send', words: 'Open the campaign in Campaigns and press Send.' };
  if (camp.status === 'approval') return { id: 'approval', words: 'Waiting for a Team Lead to approve the campaign.' };
  return { id: 'done', words: camp.words };
}
async function view(u, r, { full = true } = {}) {
  const tpls = await stateOfTemplates(u, r);
  const camp = await campaignState(u, r);
  return {
    id: r.id, title: r.title, jobId: r.jobId || '', jobTitle: r.jobTitle || '', channels: parse(r.channels, []), note: r.note || '', tone: r.tone || '', language: r.language || '',
    texts: parse(r.texts, {}), ...(full ? { variants: parse(r.variants, []) } : {}), templates: tpls, campaign: camp, next: nextStep(r, tpls, camp), ai: parse(r.meta, {}).ai || null,
    createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt),
  };
}
async function list(u) {
  if (!mayWrite(u)) return { error: 'Your login cannot open Campaign messages.', status: 403 };
  await ensure();
  const rows = A.isAdmin(u) ? await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 100`) : await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND createdById = ? ORDER BY updatedAt DESC LIMIT 100`, u.id);
  const sets = [];
  for (const r of rows) sets.push(await view(u, r, { full: false })); // eslint-disable-line no-await-in-loop
  return { sets };
}
async function get(u, id) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'These messages were not found.', status: 404 };
  return { set: await view(u, r) };
}
// save (new or changed). b: { id?, title, jobId, channels, texts, variants?, note, tone, language, ai? }
async function save(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to write.', status: 403 };
  await ensure();
  const cur = b.id ? await row(b.id) : null;
  if (b.id && !visibleTo(u, cur)) return { error: 'These messages were not found.', status: 404 };
  const channels = cleanChannels(b.channels) || (cur ? parse(cur.channels, []) : null);
  if (!channels) return { error: 'Pick WhatsApp, SMS or both.', status: 400 };
  const jobId = b.jobId || (cur && cur.jobId);
  if (!jobId) return { error: 'Pick the open job these messages are about.', status: 400 };
  const j = await jobOf(u, jobId);
  if (j.error && !(cur && cur.jobId === jobId && j.status === 400)) return j;
  const jobTitle = j.job ? j.job.title : (cur && cur.jobTitle) || '';
  const brand = await Cfg.getBrand();
  const ctx = ctxOf(j.job || { title: jobTitle }, brand.brandName);
  const texts = {};
  for (const k of channels) {
    const t = String((b.texts || {})[k] == null ? parse(cur && cur.texts, {})[k] || '' : b.texts[k]).replace(/\r/g, '').trim().slice(0, 2000);
    if (!t) return { error: `Write the ${k === 'sms' ? 'SMS' : 'WhatsApp'} message (or take that way out).`, status: 400 };
    const c = checksOf(k, t, ctx, brand.avoidWords);
    const bad = c.items.find((x) => !x.ok && ['link', 'stop', 'words', 'size'].includes(x.id));
    if (bad) return { error: `${k === 'sms' ? 'SMS' : 'WhatsApp'}: ${bad.label}. TeamLink cannot use it like this.`, status: 400, code: 'check' };
    texts[k] = t;
  }
  const title = S.clip(b.title, 80) || `${jobTitle || 'Job'} · campaign messages`;
  const meta = { ...(cur ? parse(cur.meta, {}) : {}), ...(b.ai ? { ai: { provider: S.clip(b.ai.provider, 40), model: S.clip(b.ai.model, 60), demo: !!b.ai.demo } } : {}) };
  const now = Date.now();
  if (cur) {
    const changed = JSON.stringify(parse(cur.texts, {})) !== JSON.stringify(texts);
    await S.run(`UPDATE "${TABLE}" SET title = ?, jobId = ?, jobTitle = ?, channels = ?, note = ?, tone = ?, language = ?, variants = ?, texts = ?, meta = ?, updatedAt = ? WHERE id = ?`,
      title, jobId, jobTitle, JSON.stringify(channels), S.clip(b.note, 600) || null, S.clip(b.tone, 40) || cur.tone, S.clip(b.language, 20) || cur.language, JSON.stringify(Array.isArray(b.variants) ? b.variants.slice(0, 3) : parse(cur.variants, [])), JSON.stringify(texts), JSON.stringify(meta), now, cur.id);
    await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: campaign messages changed', entity: TABLE, entityId: cur.id, toValue: `${title}; ${channels.join(', ')}${changed ? '; words changed' : ''}` });
    return { set: await view(u, await row(cur.id)), ok: changed && Object.keys(parse(cur.tplIds, {})).length ? 'Saved. The templates still have the old words: press "Make the templates" again to update them.' : 'Saved.' };
  }
  const id = S.newId('ms');
  await S.run(`INSERT INTO "${TABLE}" (id, title, jobId, jobTitle, channels, note, tone, language, variants, texts, tplIds, meta, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, title, jobId, jobTitle, JSON.stringify(channels), S.clip(b.note, 600) || null, S.clip(b.tone, 40) || null, S.clip(b.language, 20) || null, JSON.stringify(Array.isArray(b.variants) ? b.variants.slice(0, 3) : []), JSON.stringify(texts), '{}', JSON.stringify(meta), S.clip(u.department, 60) || null, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: campaign messages saved', entity: TABLE, entityId: id, toValue: `${title}; ${channels.join(', ')}${meta.ai ? (meta.ai.demo ? '; written by the sandbox sample writer' : `; written by ${meta.ai.provider}`) : ''}` });
  return { set: await view(u, await row(id)), ok: 'Saved.' };
}
async function remove(u, id) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'These messages were not found.', status: 404 };
  if (r.campaignKey) return { error: 'A campaign was made from these messages. Remove the campaign in Campaigns first.', status: 409 };
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ?, updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: campaign messages removed', entity: TABLE, entityId: r.id, toValue: r.title });
  return { ok: 'Removed. The templates made from them stay in Templates.' };
}

// ---- 3 the templates ------------------------------------------------------------------------------------------------------------------------------------------
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'message';
async function makeTemplates(u, id) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'These messages were not found.', status: 404 };
  const channels = parse(r.channels, []); const texts = parse(r.texts, {}); const ids = parse(r.tplIds, {});
  if (!channels.length || !channels.every((k) => texts[k])) return { error: 'Write the messages first.', status: 400 };
  const notes = []; const made = [];
  for (const k of channels) { // eslint-disable-line no-restricted-syntax
    const label = k === 'sms' ? 'SMS' : 'WhatsApp';
    const have = ids[k] ? await T.get(u, ids[k]) : null; // eslint-disable-line no-await-in-loop
    if (have && have.status === 'active') {
      if (k === 'whatsapp' && ['pending', 'approved'].includes(have.waApprovalStatus)) { notes.push(`${label}: Meta already has the first words, so the template was not changed. Make a new set of messages to use new words.`); continue; } // eslint-disable-line no-continue
      if (have.body === texts[k]) { made.push(k); continue; } // eslint-disable-line no-continue
      const up = await T.update(u, have.id, { body: texts[k] }); // eslint-disable-line no-await-in-loop
      if (up.error) return { error: `${label}: ${up.error}`, status: up.status || 400 };
      notes.push(`${label}: the template has the new words.`); made.push(k);
      continue; // eslint-disable-line no-continue
    }
    const name = `${S.clip(r.title, 60)} · ${label}`;
    const body = { name, channel: k, audience: 'candidate_lead', promotional: true, body: texts[k], category: 'Marketing' };
    if (k === 'whatsapp') { body.waTemplateName = `tl_${slug(r.title)}_${crypto.randomBytes(2).toString('hex')}`; body.waLanguage = LANG_CODE[r.language] || 'en'; body.waApprovalStatus = 'draft'; }
    let out = await T.create(u, body); // eslint-disable-line no-await-in-loop
    if (out.error && out.status === 409) out = await T.create(u, { ...body, name: `${name} ${crypto.randomBytes(2).toString('hex')}` }); // eslint-disable-line no-await-in-loop
    if (out.error) return { error: `${label}: ${out.error}`, status: out.status || 400 };
    ids[k] = out.template.id; made.push(k);
  }
  await S.run(`UPDATE "${TABLE}" SET tplIds = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(ids), Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: templates made from campaign messages', entity: TABLE, entityId: r.id, toValue: `${r.title}; ${made.join(', ')}` });
  return { ok: `The ${made.map((k) => (k === 'sms' ? 'SMS' : 'WhatsApp')).join(' and ')} template${made.length === 1 ? ' is' : 's are'} in Templates as not-yet-approved drafts.${notes.length ? ` ${notes.join(' ')}` : ''}`, set: await view(u, await row(r.id)) };
}
// the DLT number and sender ID of the SMS template (they come from the person's DLT registration, never from the AI)
async function setSmsIds(u, id, b = {}) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'These messages were not found.', status: 404 };
  const ids = parse(r.tplIds, {});
  if (!ids.sms) return { error: 'Make the templates first.', status: 400 };
  const out = await T.update(u, ids.sms, { dltTemplateId: S.clip(b.dltTemplateId, 30), senderId: S.clip(b.senderId, 20) });
  if (out.error) return { error: out.error, status: out.status || 400 };
  return { ok: out.template.ready ? 'Saved. The SMS message is ready to use.' : `Saved. ${out.template.why || ''}`.trim(), set: await view(u, await row(r.id)) };
}

// ---- 4 the campaign (saved, NEVER sent from here) ----------------------------------------------------------------------------------------------------------
async function makeCampaign(u, id, b = {}) {
  await ensure();
  const r = await row(id);
  if (!visibleTo(u, r)) return { error: 'These messages were not found.', status: 404 };
  if (r.campaignKey) return { error: 'A campaign was already made from these messages.', status: 409 };
  const v = await view(u, r);
  if (v.next.id !== 'campaign') return { error: v.next.words, status: 409, code: 'not_ready' };
  const segmentIds = (Array.isArray(b.segmentIds) ? b.segmentIds : []).map(String).filter(Boolean);
  if (!segmentIds.length) return { error: 'Pick at least one group of people.', status: 400 };
  const channels = parse(r.channels, []); const texts = parse(r.texts, {}); const templates = {};
  channels.forEach((k) => { templates[k] = v.templates[k].id; });
  const out = await Gs.createGroup(u, { objective: 'job_promotion', name: S.clip(b.name, 80) || r.title, channels, requirementId: r.jobId, segmentIds, templates, masterMessage: texts.whatsapp || texts.sms, goal: S.clip(r.note, 600), saveOnly: true, approvalMode: 'auto' });
  if (out.error) return { error: out.error, status: out.status || 400, code: out.code };
  let note = 'The campaign is saved and NOT sent. Open it in Campaigns to check it and press Send.';
  if (b.ask === true) { const ap = await Appr.submit(u, out.key); note = ap.error ? `The campaign is saved and NOT sent. Approval could not be asked: ${ap.error}` : 'The campaign is saved and was sent for approval. Nothing is sent until it is approved and a person presses Send.'; }
  await S.run(`UPDATE "${TABLE}" SET campaignKey = ?, updatedAt = ? WHERE id = ?`, out.key, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: campaign saved from campaign messages', entity: TABLE, entityId: r.id, toValue: `${r.title}; ${channels.join(', ')}; ${segmentIds.length} group(s); not sent` });
  return { ok: note, key: out.key, set: await view(u, await row(r.id)) };
}

// what the screen needs: the open jobs, the groups of people, and whether each way is connected
async function options(u, { q } = {}) {
  if (!mayWrite(u)) return { error: 'Your login cannot open Campaign messages.', status: 403 };
  const jobs = (await Camp.jobs(u, { q })).jobs;
  const gs = await Gs.options(u, { audience: 'candidate_lead' });
  const brand = await Cfg.getBrand();
  const ready = (ch) => (gs.channels || []).find((c) => c.channel === ch) || {};
  return {
    jobs, canCampaign: A.mayCampaign(u), segments: gs.segments || [], ways: WAYS.map((w) => ({ ...w, ready: !!ready(w.key).ready, note: ready(w.key).note || '', connected: !!(ready(w.key).connection || {}).ready, canGoLive: !!ready(w.key).canGoLive })),
    tones: St.VOICES, languages: Cfg.LANGUAGES, brand: { name: brand.brandName || '', tone: brand.tone, language: brand.language }, testMode: !!(gs.settings || {}).testMode, approval: gs.approval || {}, ai: (await AI.status()).text,
  };
}

module.exports = { ensure, WAYS, KEYS, WORDS, shape, checksOf, write, check, list, get, save, remove, makeTemplates, setSmsIds, makeCampaign, options, nextStep };
