// ---------------------------------------------------------------------------
// THE POSTING KIT: the ready text and the tracked apply link of ONE job for ONE platform.
//
//   context(requirementId, { base })              reads the job once (the template engine runs once for all platforms)
//   build(ctx, platform, { saved })               -> { title, text, auto, overridden, stale, link, chars, limit, over, trimmed,
//                                                      blanks, missing[], notes[] }
//   forPlatform(requirementId, key, { base })     the same, for one platform (used by the Telegram / Facebook adapters)
//   saveEdit / resetEdit                          the poster's own edit of one platform's text (AppSetting, per job)
//   trackedLink(job, platform, base)              <site>/careers/<slug>?src=<key>&utm_source=<key>&utm_medium=...&utm_campaign=job-<code>
//
// The text is built from the job and the poster's saved job template (utils/jobText.js + utils/jobPostWriter.js: the
// "Write the job posts" engine) and tuned to the platform: its format (long job text or short message), its length limit and
// whether the salary may be shown. NEVER in it: the client's name (the engine already hides it; one last pass removes it),
// the fee, the agreement, internal notes.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { slugOf } = require('../utils/jobSlug');
const jt = require('../utils/jobText');
const W = require('../utils/jobPostWriter');
const Plat = require('./platforms');
const Attr = require('./attribution');

const KEY = (id) => `jobdist.text.${id}`;
const BOARD_OF = { naukri: 'naukri', shine: 'shine', foundit: 'shine', indeed: 'indeed', linkedin: 'linkedin' };
const hash = (t) => crypto.createHash('sha1').update(String(t == null ? '' : t)).digest('hex').slice(0, 12);
const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What never goes on a public post, whatever the job text holds.
const FORBIDDEN_LINE = /\b(agreement|e-?sign(ed|ature)?|commission|service fee|consultancy fee|placement fee|our fee|billing|invoice)\b/i;
const SALARY_LINE = /^\s*(?:[-*•]\s*)?(?:salary|ctc|pay|package|compensation)\b[^\n]*$/gim;

const baseOf = (base) => String(base || process.env.APP_BASE_URL || '').replace(/\/+$/, '');

function trackedLink(job, platform, base) {
  const p = `/careers/${slugOf(job) || job.id}`;
  const qs = new URLSearchParams(Attr.linkTags(platform, job)).toString();
  return `${baseOf(base)}${p}?${qs}`;
}

async function loadEdits(id) {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(id) } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

// Read the job once. { r, f (facts), gen (the engine's texts), base, edits }
async function context(requirementId, { base } = {}) {
  const r = await prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } });
  if (!r) return null;
  const b = baseOf(base);
  const f = await jt.buildFacts(r, {}, b);
  const gen = await jt.generate(r, {}, b);
  const sv = await W.loadSaved(requirementId).catch(() => null);
  const saved = sv ? {
    naukri: { text: sv.texts.naukri, title: sv.texts.naukriTitle }, shine: { text: sv.texts.shine }, indeed: { text: sv.texts.indeed, title: sv.texts.indeedTitle }, linkedin: { text: sv.texts.linkedin },
  } : null;
  return { r, f, gen, base: b, saved, edits: await loadEdits(requirementId) };
}

// ---- pieces -------------------------------------------------------------------------
const stripApply = (t) => String(t)
  .replace(/^\s*HOW TO APPLY\s*$/gim, '')
  .replace(/^\s*Apply( here| now)?\s*:.*$/gim, '')
  .replace(/^\s*Questions\s*:.*$/gim, '');
const HASHLINE = /^(\s*#[\p{L}\p{N}_]+)(\s+#[\p{L}\p{N}_]+)*\s*$/u;

// "SECTION HEADING" blocks of the master text
function blocks(text) {
  const out = []; let cur = { head: '', lines: [] };
  String(text).split('\n').forEach((line) => {
    if (/^[A-Z][A-Z &/]{3,}$/.test(line.trim())) { out.push(cur); cur = { head: line.trim(), lines: [] }; } else cur.lines.push(line);
  });
  out.push(cur);
  return out.filter((b) => b.head || b.lines.join('').trim());
}
const join = (bl) => bl.map((b) => [b.head, ...b.lines].filter((x, i) => i > 0 || x).join('\n')).join('\n').replace(/\n{3,}/g, '\n\n').trim();

function cutAt(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, Math.max(0, max - 1));
  const nl = slice.lastIndexOf('\n');
  const sp = slice.lastIndexOf(' ');
  const at = nl > max * 0.6 ? nl : (sp > max * 0.6 ? sp : slice.length);
  return `${slice.slice(0, at).trimEnd()}…`;
}

// Shrink a long job text to `max` characters: whole sections go first (benefits, preferred skills, about), then the
// responsibility bullets one by one, last a plain cut at a line end.
function compact(body, max) {
  if (body.length <= max) return { text: body, trimmed: false };
  let bl = blocks(body);
  for (const head of ['BENEFITS', 'PREFERRED SKILLS', 'ABOUT THE COMPANY']) {
    if (join(bl).length <= max) break;
    bl = bl.filter((b) => b.head !== head);
  }
  const resp = bl.find((b) => b.head === 'RESPONSIBILITIES');
  while (join(bl).length > max && resp && resp.lines.filter((l) => /^\s*•/.test(l)).length > 3) {
    const idx = resp.lines.map((l, i) => (/^\s*•/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    resp.lines.splice(idx, 1);
  }
  return { text: cutAt(join(bl), max), trimmed: true };
}

const city = (loc) => String(loc || '').split(/[,/|]/)[0].trim();

// A short message (chats, social posts, e-mail to a placement cell).
function composeShort(f, p, link) {
  const title = `We are hiring: ${f.title}${f.location ? ` in ${city(f.location)}` : ''}${f.workMode ? ` (${f.workMode})` : ''}`;
  const lines = [title];
  const bits = [f.experience && `Experience: ${f.experience}`, f.education && `Education: ${f.education}`, f.employmentType && `Type: ${f.employmentType}`].filter(Boolean);
  lines.push(...bits);
  if (f.skills && f.skills.length) lines.push(`Skills: ${f.skills.slice(0, 6).join(', ')}`);
  if (p.includeSalary && f.salary) lines.push(`Salary: ${f.salary}`);
  if (f.notice) lines.push(`Notice period: ${f.notice}`);
  if (f.openings) lines.push(`Openings: ${f.openings}`);
  if (f.companyLine) lines.push('', f.companyLine);
  const tags = ['social', 'messaging'].includes(p.medium) ? jt.hashtagsFor(f).slice(0, 4).join(' ') : '';
  const tail = [`Apply: ${link}`, tags].filter(Boolean);
  return { head: lines.join('\n'), tail: tail.join('\n') };
}

// Build the text of one platform from the context. saved = the poster's own edit { text, title, gen } or null.
function build(ctx, p) {
  const { r, f, gen } = ctx;
  const link = trackedLink(r, p, ctx.base);
  const board = BOARD_OF[p.key];
  const notes = [];
  let title = clean(f.title);
  let head; let tail; let autoBody;

  if (p.format === 'short') {
    const s = composeShort(f, p, link);
    head = s.head; tail = s.tail;
  } else {
    let body;
    const saved = ctx.saved && ctx.saved[board];
    if (board) {
      const b = gen.boards[board] || gen.boards.indeed;
      body = clean((saved && saved.text) || (b && b.text) || gen.master.text);
      title = clean((saved && saved.title) || (b && b.title) || title);
    } else body = clean(gen.master.text);
    body = stripApply(body);
    const tags = body.split('\n').filter((l) => HASHLINE.test(l.trim()));
    if (tags.length) body = body.split('\n').filter((l) => !HASHLINE.test(l.trim())).join('\n');
    head = body.replace(/\n{3,}/g, '\n\n').trim();
    tail = [`Apply: ${link}`, tags.join(' ')].filter(Boolean).join('\n');
  }
  // never: agreement / fee talk; the salary when this place does not want it
  const safe = (t) => String(t).split('\n').filter((l) => !FORBIDDEN_LINE.test(l)).join('\n');
  head = safe(head);
  if (!p.includeSalary) head = head.replace(SALARY_LINE, '').replace(/\n{3,}/g, '\n\n');
  // the client is never named (the engine hides it; this is the last check)
  (f.clientNames || []).forEach((n) => {
    const re = new RegExp(esc(n), 'gi');
    head = head.replace(re, 'our client'); title = title.replace(re, 'our client'); tail = tail.replace(re, 'our client');
  });
  autoBody = head.trim();

  let trimmed = false;
  const max = p.maxChars || null;
  let text;
  if (max) {
    const room = Math.max(60, max - tail.length - 2);
    const c = p.format === 'short' ? { text: cutAt(autoBody, room), trimmed: autoBody.length > room } : compact(autoBody, room);
    trimmed = c.trimmed;
    text = `${c.text}\n\n${tail}`.trim();
  } else text = `${autoBody}\n\n${tail}`.trim();
  if (trimmed) notes.push(`The text was shortened to fit ${p.name} (about ${max} characters).`);
  if (p.maxTitle && title.length > p.maxTitle) { title = cutAt(title, p.maxTitle); notes.push(`The title was shortened to ${p.maxTitle} characters.`); }
  const blanks = (text.match(/\[ \]/g) || []).length;
  const missing = (gen.missing || []).filter((m) => !m.optional).map((m) => ({ key: m.key, label: m.label }));
  return {
    title, text: text.replace(/\n{3,}/g, '\n\n'), auto: text.replace(/\n{3,}/g, '\n\n'), link, trimmed, notes, blanks, missing, limit: max || null,
  };
}

// Apply the poster's own edit on top of the generated text.
function withEdit(ctx, p, built) {
  const e = ctx.edits && ctx.edits[p.key];
  const out = {
    ...built, overridden: false, stale: false, savedBy: null, savedAt: null,
  };
  if (e && clean(e.text)) {
    out.text = clean(e.text);
    if (clean(e.title)) out.title = clean(e.title);
    out.overridden = true;
    out.stale = !!e.gen && e.gen !== hash(built.auto);
    out.savedBy = e.byName || null; out.savedAt = e.at || null;
    // an edit must keep its tracked link: it is what tells us where applicants came from
    out.linkMissing = !out.text.includes(built.link);
  }
  out.chars = out.text.length;
  out.over = !!(p.maxChars && out.chars > p.maxChars);
  return out;
}

async function forPlatform(requirementId, key, { base } = {}) {
  const ctx = await context(requirementId, { base });
  if (!ctx) return null;
  const p = await Plat.get(key);
  if (!p) return null;
  return { platform: p, ...withEdit(ctx, p, build(ctx, p)), job: ctx.r };
}

async function saveEdit(ctx, p, text, title, user) {
  const t = clean(text);
  const all = { ...(ctx.edits || {}) };
  if (!t) { delete all[p.key]; } else {
    const built = build(ctx, p);
    all[p.key] = { text: t.slice(0, 30000), title: clean(title).slice(0, 300) || null, gen: hash(built.auto), byId: user ? user.id : null, byName: user ? user.name : null, at: new Date().toISOString() };
  }
  const key = KEY(ctx.r.id);
  if (!Object.keys(all).length) await prisma.appSetting.deleteMany({ where: { key } });
  else {
    const v = JSON.stringify(all);
    await prisma.appSetting.upsert({
      where: { key }, create: { key, value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null }, update: { value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    });
  }
  ctx.edits = all;
  return all;
}

module.exports = {
  context, build, withEdit, forPlatform, saveEdit, trackedLink, loadEdits, hash, compact, cutAt, KEY, FORBIDDEN_LINE,
};
