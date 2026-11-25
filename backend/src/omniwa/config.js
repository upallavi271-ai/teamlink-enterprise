// ---------------------------------------------------------------------------
// WHATSAPP AI AGENT: the Admin's settings (Omni-Channel > Settings > WhatsApp AI) and the knowledge base. OFF until an Admin switches it on.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const { ensure } = require('./schema');
const { digitsOf } = require('../utils/messageDelivery');

const DEFAULT_PROMPT = 'You are the WhatsApp assistant of a recruitment company. You help candidates who replied to a job message. Be polite and friendly.';
const DEFAULT_FALLBACK = 'Thanks for your message. Our team will get back to you soon.';
const DEFAULTS = { enabled: false, model: '', systemPrompt: DEFAULT_PROMPT, hoursOn: false, hoursFrom: '09:30', hoursTo: '18:30', fallbackMessage: DEFAULT_FALLBACK, maxTurns: 12, memoryCount: 12, debounceSeconds: 10, promoDays: 7, testNumbers: [] };
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const whole = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// the fallback is ONE message a candidate reads. A whole document pasted there went to a candidate on 2026-11-05: what is saved already is cut to its first quoted line
const FALLBACK_MAX = 300;
const FALLBACK_WORDS = `The fallback is one short message for the candidate (${FALLBACK_MAX} letters at most). Put longer rules in the instructions.`;
function oneFallback(text) {
  const t = String(text || '').trim();
  if (t.length <= FALLBACK_MAX && !/^#/.test(t)) return t || DEFAULT_FALLBACK;
  const quoted = /["\u201c]([^"\u201d\n]{10,300})["\u201d]/.exec(t);
  return quoted ? quoted[1].trim() : DEFAULT_FALLBACK;
}

const shape = (r) => (r ? {
  enabled: !!r.enabled, model: r.model || '', systemPrompt: r.systemPrompt || DEFAULT_PROMPT, hoursOn: !!r.hoursOn, hoursFrom: r.hoursFrom || DEFAULTS.hoursFrom, hoursTo: r.hoursTo || DEFAULTS.hoursTo,
  fallbackMessage: r.fallbackMessage || DEFAULT_FALLBACK, maxTurns: Number(r.maxTurns) || DEFAULTS.maxTurns, memoryCount: Number(r.memoryCount) || DEFAULTS.memoryCount,
  debounceSeconds: Number(r.debounceSeconds) || DEFAULTS.debounceSeconds, promoDays: Number(r.promoDays) || DEFAULTS.promoDays,
  testNumbers: String(r.testNumbers || '').split(',').filter(Boolean), updatedByName: r.updatedByName || null, updatedAt: r.updatedAt ? Number(r.updatedAt) : null,
} : { ...DEFAULTS });

async function read() {
  await ensure();
  return shape((await S.q('SELECT * FROM "OmniWaAiConfig" WHERE id = \'main\''))[0]);
}

async function save(user, b = {}) {
  await ensure();
  const c = await read();
  const next = {
    enabled: b.enabled === undefined ? c.enabled : !!b.enabled,
    model: b.model === undefined ? c.model : S.clip(String(b.model).trim(), 80) || '',
    systemPrompt: b.systemPrompt === undefined ? c.systemPrompt : S.clip(String(b.systemPrompt).trim(), 6000),
    hoursOn: b.hoursOn === undefined ? c.hoursOn : !!b.hoursOn,
    hoursFrom: b.hoursFrom === undefined ? c.hoursFrom : String(b.hoursFrom), hoursTo: b.hoursTo === undefined ? c.hoursTo : String(b.hoursTo),
    fallbackMessage: b.fallbackMessage === undefined ? c.fallbackMessage : S.clip(String(b.fallbackMessage).trim(), 700),
    maxTurns: b.maxTurns === undefined ? c.maxTurns : whole(b.maxTurns, 1, 50, c.maxTurns),
    memoryCount: b.memoryCount === undefined ? c.memoryCount : whole(b.memoryCount, 2, 40, c.memoryCount),
    debounceSeconds: b.debounceSeconds === undefined ? c.debounceSeconds : whole(b.debounceSeconds, 2, 120, c.debounceSeconds),
    promoDays: b.promoDays === undefined ? c.promoDays : whole(b.promoDays, 1, 30, c.promoDays),
    testNumbers: b.testNumbers === undefined ? c.testNumbers : [...new Set((Array.isArray(b.testNumbers) ? b.testNumbers : String(b.testNumbers).split(/[\s,;]+/)).map((n) => digitsOf(n)).filter((n) => n.length >= 10))],
  };
  if (!next.systemPrompt) return { error: 'Write the system prompt first.', status: 400 };
  if (!next.fallbackMessage) return { error: 'Write the fallback message first.', status: 400 };
  if (b.fallbackMessage !== undefined && (next.fallbackMessage.length > FALLBACK_MAX || /^#/.test(next.fallbackMessage))) return { error: FALLBACK_WORDS, status: 400 };
  if (next.hoursOn && (!HM.test(next.hoursFrom) || !HM.test(next.hoursTo))) return { error: 'Working hours are written like 09:30.', status: 400 };
  await S.run(`INSERT INTO "OmniWaAiConfig" (id, enabled, model, systemPrompt, hoursOn, hoursFrom, hoursTo, fallbackMessage, maxTurns, memoryCount, debounceSeconds, promoDays, testNumbers, updatedByName, updatedAt)
    VALUES ('main',?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, model=excluded.model, systemPrompt=excluded.systemPrompt, hoursOn=excluded.hoursOn, hoursFrom=excluded.hoursFrom, hoursTo=excluded.hoursTo,
    fallbackMessage=excluded.fallbackMessage, maxTurns=excluded.maxTurns, memoryCount=excluded.memoryCount, debounceSeconds=excluded.debounceSeconds, promoDays=excluded.promoDays, testNumbers=excluded.testNumbers, updatedByName=excluded.updatedByName, updatedAt=excluded.updatedAt`,
  next.enabled ? 1 : 0, next.model, next.systemPrompt, next.hoursOn ? 1 : 0, next.hoursFrom, next.hoursTo, next.fallbackMessage, next.maxTurns, next.memoryCount, next.debounceSeconds, next.promoDays, next.testNumbers.join(','), user ? user.name : null, Date.now());
  return { ok: true, config: await read() };
}

// ---- the questions after a YES (founder 2026-11-05, his screening script). One line = one question. [Job Role], [Location], [Salary], [Work Mode], [Qualification], [Experience], [Skills], [Joining], [Employment Type], [Specialisation], [Department] come from the ATS
// requirement, and a line whose value the requirement does not have is skipped. A line that starts "If working," is skipped for a person who is not working.
// (founder 2026-11-20: "jd ki thaginaa questions mathrame adagali") the default questions come from the JOB only: every line names a field of the ATS requirement in [brackets], and a line whose field the job does not
// have is skipped, so the candidate is asked only what this job's JD is about. Nothing generic (current company, notice period ...) unless an Admin adds it to the list.
const DEFAULT_QUESTIONS = [
  'Are you interested in the [Job Role] position?',
  'This role needs [Qualification]. Do you have this qualification?',
  'This role needs [Experience] of experience. Do you have this experience?',
  'This role works with [Skills]. Do you have experience in these?',
  'Are you comfortable with the job location - [Location]?',
  'Are you comfortable with the work mode - [Work Mode]?',
  'Are you comfortable with the offered salary/package of [Salary]?',
  'If selected, can you join within [Joining]?',
  'Which date and time would be convenient for your interview?',
  'Would you like to proceed with this job opportunity?',
];
const DEFAULT_CLOSING = 'Thank you for your time. I have recorded your responses. Our recruitment team will review your details and contact you regarding the next steps. Have a great day!';
const Q_KEY = 'omni.wa.questions';
async function questions() {
  const row = await prisma.appSetting.findUnique({ where: { key: Q_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return { list: Array.isArray(v.list) && v.list.length ? v.list : DEFAULT_QUESTIONS, closing: v.closing || DEFAULT_CLOSING };
}
async function saveQuestions(b = {}) {
  const list = (Array.isArray(b.list) ? b.list : String(b.list || '').split('\n')).map((l) => S.clip(String(l).replace(/^\s*\d+[.)]\s*/, ''), 300)).filter(Boolean);
  if (!list.length) return { error: 'Write at least one question.', status: 400 };
  if (list.length > 40) return { error: 'At most 40 questions.', status: 400 };
  const closing = S.clip(String(b.closing || '').trim(), 500) || DEFAULT_CLOSING;
  const value = JSON.stringify({ list, closing });
  await prisma.appSetting.upsert({ where: { key: Q_KEY }, update: { value }, create: { key: Q_KEY, value } });
  return { ok: true, list, closing };
}

// ---- one WhatsApp number's own settings (founder 2026-11-05: each number its own instructions) ----------------------------------------------------------
async function profiles() {
  await ensure();
  return (await S.q('SELECT numberId, enabled, systemPrompt, fallbackMessage, updatedByName, updatedAt FROM "OmniWaAiProfile"')).map((r) => ({ ...r, enabled: !!r.enabled, updatedAt: r.updatedAt ? Number(r.updatedAt) : null }));
}
async function saveProfile(user, numberId, b = {}) {
  await ensure();
  const row = await require('../utils/waNumbers').getRow(numberId); // eslint-disable-line global-require
  if (!row) return { error: 'This WhatsApp number is gone.', status: 404 };
  const systemPrompt = S.clip(String(b.systemPrompt == null ? '' : b.systemPrompt).trim(), 6000) || null;
  const fallbackMessage = S.clip(String(b.fallbackMessage == null ? '' : b.fallbackMessage).trim(), 700) || null;
  // a NEW fallback must be one short message; the one already saved is kept as it is when only the switch or the instructions change
  const stored = (await S.q('SELECT fallbackMessage FROM "OmniWaAiProfile" WHERE numberId = ?', row.id))[0];
  const unchanged = !!stored && (stored.fallbackMessage || null) === fallbackMessage;
  if (fallbackMessage && !unchanged && (fallbackMessage.length > FALLBACK_MAX || /^#/.test(fallbackMessage))) return { error: FALLBACK_WORDS, status: 400 };
  await S.run(`INSERT INTO "OmniWaAiProfile" (numberId, enabled, systemPrompt, fallbackMessage, updatedByName, updatedAt) VALUES (?,?,?,?,?,?)
    ON CONFLICT(numberId) DO UPDATE SET enabled=excluded.enabled, systemPrompt=excluded.systemPrompt, fallbackMessage=excluded.fallbackMessage, updatedByName=excluded.updatedByName, updatedAt=excluded.updatedAt`,
  row.id, b.enabled === false ? 0 : 1, systemPrompt, fallbackMessage, user ? user.name : null, Date.now());
  return { ok: true };
}
async function removeProfile(numberId) {
  await ensure();
  await S.run('DELETE FROM "OmniWaAiProfile" WHERE numberId = ?', String(numberId));
  return { ok: true };
}
// the settings one chat runs on: the number's own where it has them, the default for the rest
async function forNumber(cfg, numberId) {
  const safe = { ...cfg, fallbackMessage: oneFallback(cfg.fallbackMessage) };
  if (!numberId) return safe;
  const p = (await S.q('SELECT enabled, systemPrompt, fallbackMessage FROM "OmniWaAiProfile" WHERE numberId = ?', String(numberId)))[0];
  if (!p) return safe;
  // ownSystemPrompt = only what this number itself has (a marketing number must never fall back to the shared RECRUITMENT instructions)
  return { ...safe, numberOff: !p.enabled, systemPrompt: p.systemPrompt || cfg.systemPrompt, ownSystemPrompt: p.systemPrompt || null, fallbackMessage: p.fallbackMessage ? oneFallback(p.fallbackMessage) : safe.fallbackMessage };
}

// ---- knowledge base ------------------------------------------------------------------------------------------------------------------------------
// What kind of knowledge an entry is (AI WhatsApp Marketing Assistant, owner 2026-11-25). The assistant answers a price question ONLY from a 'pricing' entry a person wrote, a
// question about hours only from 'hours', and so on; 'website' is what the website import fills in. An old entry with no category is a plain question and answer.
const KB_CATEGORIES = [['company', 'Company information'], ['services', 'Services'], ['products', 'Products'], ['pricing', 'Pricing'], ['hours', 'Working hours'], ['contact', 'Contact information'], ['policies', 'Policies'], ['faq', 'Questions and answers'], ['website', 'From our website']].map(([key, label]) => ({ key, label }));
const catOf = (v) => { const k = String(v || '').trim().toLowerCase(); return KB_CATEGORIES.some((c) => c.key === k) ? k : 'faq'; };
const PRICE_MAX = 400; // a price entry is one short message: it must never be cut in the middle of a figure
const PRICE_TITLE_MAX = 120; // the name of the plan or service it is for

async function kbList() {
  await ensure();
  return (await S.q(`SELECT id, question, answer, active, numberId, COALESCE(category, 'faq') AS category, (category IS NULL) AS legacy, confirmedAt, updatedByName, updatedAt FROM "OmniWaKnowledge" ORDER BY updatedAt DESC`)).map((r) => ({ ...r, active: !!r.active, legacy: !!r.legacy, updatedAt: Number(r.updatedAt), confirmedAt: r.confirmedAt ? Number(r.confirmedAt) : null }));
}
async function kbSave(user, id, b = {}) {
  await ensure();
  const question = S.clip(String(b.question || '').trim(), 300);
  const answer = S.clip(String(b.answer || '').trim(), 1500);
  if (!question || !answer) return { error: 'Write the question and its answer.', status: 400 };
  const category = b.category === undefined && id ? ((await S.q(`SELECT COALESCE(category, 'faq') AS c FROM "OmniWaKnowledge" WHERE id = ?`, String(id)))[0] || { c: 'faq' }).c : catOf(b.category);
  if (category === 'pricing' && answer.length > PRICE_MAX) return { error: `A price entry is one short message (${PRICE_MAX} letters at most), so the assistant never sends half of it.`, status: 400 };
  if (category === 'pricing' && question.length > PRICE_TITLE_MAX) return { error: `The name of a price entry (the plan or service) is ${PRICE_TITLE_MAX} letters at most.`, status: 400 };
  const now = Date.now();
  const active = b.active === false ? 0 : 1;
  const numberId = b.numberId ? String(b.numberId) : null; // empty = every number
  const confirmedAt = category === 'pricing' ? now : null; // a person saving a price confirms it: the screen shows when, and flags an old one
  if (id) {
    const n = await S.run('UPDATE "OmniWaKnowledge" SET question = ?, answer = ?, active = ?, numberId = ?, category = ?, confirmedAt = ?, updatedByName = ?, updatedAt = ? WHERE id = ?', question, answer, active, numberId, category, confirmedAt, user ? user.name : null, now, String(id));
    if (!n) return { error: 'This entry is gone.', status: 404 };
    return { ok: true, id: String(id) };
  }
  const newId = S.newId('wak');
  await S.run('INSERT INTO "OmniWaKnowledge" (id, question, answer, active, numberId, category, confirmedAt, updatedByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', newId, question, answer, active, numberId, category, confirmedAt, user ? user.name : null, now, now);
  return { ok: true, id: newId };
}
async function kbRemove(id) {
  await ensure();
  await S.run('DELETE FROM "OmniWaKnowledge" WHERE id = ?', String(id));
  return { ok: true };
}
// ---- a pasted or uploaded list (owner 2026-11-25: "the business can upload or configure") ----------------------------------------------------------
// One entry per line: category | question | answer   (or tab / comma separated, with a header line category,question,answer; two columns = question, answer).
// A line that cannot be used is reported with its line number and the rest is still imported; nothing is guessed (an unknown category is refused, not turned into a FAQ).
const CAT_WORDS = { company: 'company', about: 'company', 'company information': 'company', services: 'services', service: 'services', products: 'products', product: 'products', pricing: 'pricing', price: 'pricing', prices: 'pricing', hours: 'hours', timings: 'hours', 'working hours': 'hours', contact: 'contact', 'contact information': 'contact', policies: 'policies', policy: 'policies', faq: 'faq', faqs: 'faq', 'q&a': 'faq', 'questions and answers': 'faq' };
function splitCells(line, delim) {
  if (delim === '|') return line.split('|').map((c) => c.trim());
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"' && !cur.trim()) q = true; else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const MAX_IMPORT_ROWS = 300;
function parseKbList(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l, i) => ({ n: i + 1, t: l })).filter((l) => l.t.trim() && !l.t.trim().startsWith('#'));
  const rows = []; const errors = [];
  if (!lines.length) return { rows, errors: [{ line: 0, reason: 'Nothing to import: paste one entry on each line.' }] };
  const first = lines[0].t;
  const delim = first.includes('|') ? '|' : (first.includes('\t') ? '\t' : ',');
  let start = 0;
  const h = splitCells(first, delim).map((c) => c.toLowerCase());
  if (['category', 'type'].includes(h[0]) && ['question', 'title', 'item', 'name'].includes(h[1])) start = 1;
  for (const { n, t } of lines.slice(start)) {
    if (rows.length >= MAX_IMPORT_ROWS) { errors.push({ line: n, reason: `Only ${MAX_IMPORT_ROWS} entries are imported at a time; the rest was not read.` }); break; }
    const cells = splitCells(t, delim);
    let category = 'faq'; let question; let answer;
    if (cells.length >= 3) {
      category = CAT_WORDS[cells[0].toLowerCase()] || null;
      [, question] = cells; answer = cells.slice(2).join(delim === '|' ? ' | ' : delim === '\t' ? ' ' : ', ');
      if (!category) { errors.push({ line: n, reason: `Unknown category "${S.clip(cells[0], 30)}". Use company, services, products, pricing, hours, contact, policies or faq.` }); continue; } // eslint-disable-line no-continue
    } else if (cells.length === 2) [question, answer] = cells;
    else { errors.push({ line: n, reason: 'Needs a question and an answer.' }); continue; } // eslint-disable-line no-continue
    question = S.clip(question, 300); answer = S.clip(answer, 1500);
    if (!question || !answer) { errors.push({ line: n, reason: 'The question or the answer is empty.' }); continue; } // eslint-disable-line no-continue
    if (category === 'pricing' && (answer.length > PRICE_MAX || question.length > PRICE_TITLE_MAX)) { errors.push({ line: n, reason: `A price entry is ${PRICE_MAX} letters at most, and its name ${PRICE_TITLE_MAX}.` }); continue; } // eslint-disable-line no-continue
    rows.push({ category, question, answer });
  }
  return { rows, errors };
}
// an entry with the same question in the same category (and for the same number) is updated, never doubled
async function kbImportRows(user, text, { numberId = null } = {}) {
  await ensure();
  const { rows, errors } = parseKbList(text);
  if (!rows.length) return { error: errors.length ? `${errors[0].reason}${errors[0].line ? ` (line ${errors[0].line})` : ''}` : 'Nothing to import.', errors, status: 400 };
  const nid = numberId ? String(numberId) : null;
  const now = Date.now();
  let added = 0; let updated = 0;
  for (const r of rows) {
    const old = (await S.q('SELECT id FROM "OmniWaKnowledge" WHERE lower(question) = lower(?) AND COALESCE(category, \'faq\') = ? AND COALESCE(numberId, \'\') = ? LIMIT 1', r.question, r.category, nid || ''))[0]; // eslint-disable-line no-await-in-loop
    const confirmedAt = r.category === 'pricing' ? now : null;
    if (old) { await S.run('UPDATE "OmniWaKnowledge" SET answer = ?, active = 1, confirmedAt = ?, updatedByName = ?, updatedAt = ? WHERE id = ?', r.answer, confirmedAt, user ? user.name : null, now, old.id); updated += 1; } // eslint-disable-line no-await-in-loop
    else { await S.run('INSERT INTO "OmniWaKnowledge" (id, question, answer, active, numberId, category, confirmedAt, updatedByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', S.newId('wak'), r.question, r.answer, 1, nid, r.category, confirmedAt, user ? user.name : null, now, now); added += 1; } // eslint-disable-line no-await-in-loop
  }
  return { ok: true, added, updated, errors };
}

// the entries closest to the question (shared words, longer words count more): those for every number and those of this chat's number
async function kbSearch(query, limit = 3, numberId = null, { skip = [] } = {}) { // skip = kinds of entry this asker must not read (the recruitment AI never reads a price)
  await ensure();
  // plain words of the question, without the little ones ("what", "you", "the") that every page contains and that would make a hundred sections score alike
  const STOP = new Set('the and for you your are was were what who how can could would will with this that these those our have has had not but from about into any all more tell please give does did get got there their them they its it\'s hello'.split(' '));
  const words = [...new Set(String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))];
  if (!words.length) return [];
  const rows = (await S.q('SELECT question, answer, category FROM "OmniWaKnowledge" WHERE active = 1 AND (numberId IS NULL OR numberId = ?)', numberId || '')).filter((r) => !skip.includes(r.category || 'faq'));
  return rows.map((r) => {
    const q = String(r.question).toLowerCase(); const a = String(r.answer).toLowerCase();
    return { ...r, score: words.reduce((n, w) => n + (q.includes(w) ? 2 * w.length : 0) + (a.includes(w) ? w.length : 0), 0) };
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score).slice(0, limit).map(({ question, answer }) => ({ question, answer }));
}

// ---- the company website as knowledge (founder 2026-11-20: "mana products gurinchi adigitheyy website loo chusii answer evvali") -----------------------------
// One import = the pages of our own site read into this number's knowledge base (webKb.js): the old entries of the SAME site and number are replaced, nothing else is touched.
async function kbImportWebsite(user, { urls, numberId = null, maxPages = 30 } = {}) {
  await ensure();
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\/[^\s]+$/i.test(u)).slice(0, 5);
  if (!list.length) return { error: 'Give the website address, like https://tmlink.in', status: 400 };
  const r = await require('./webKb').crawl(list, { maxPages: Math.min(60, Math.max(1, Number(maxPages) || 30)) }); // eslint-disable-line global-require
  if (!r.entries.length) return { error: 'No readable text was found at that address.', status: 502 };
  const tag = `Website import: ${new URL(list[0]).host}`;
  const nid = numberId ? String(numberId) : null;
  await S.run('DELETE FROM "OmniWaKnowledge" WHERE updatedByName = ? AND COALESCE(numberId, \'\') = ?', tag, nid || '');
  const now = Date.now();
  let saved = 0;
  for (const e of r.entries.slice(0, 400)) {
    await S.run('INSERT INTO "OmniWaKnowledge" (id, question, answer, active, numberId, category, updatedByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', S.newId('wak'), S.clip(e.question, 300), S.clip(e.answer, 1500), 1, nid, 'website', tag, now, now); // eslint-disable-line no-await-in-loop
    saved += 1;
  }
  return { ok: true, pages: r.pages.length, saved, failed: r.failed.length, by: user ? user.name : null };
}

// ---- marketing numbers: a number whose chats are about our products, not about a job (founder 2026-11-20, the Digital Marketing number) ---------------------
// AppSetting 'omni.wa.marketingNumbers' = ["<numberId>", ...]. A chat on such a number is answered from the promotion we sent and the website knowledge only (agent.js askMarketing).
// who the AI is on a marketing number when the number has no instructions of its own: never the shared recruitment ones (founder 2026-11-20: "ee chatbot lo different questions unnai, digital marketing questions kadhu")
const MARKETING_PROMPT = `You are the WhatsApp assistant of TeamLink Consultants' Digital Marketing team (TeamLink Consultants, Hyderabad). People write to you after they received one of our promotions about SEO, social media, lead generation, website promotion or our software (HRMS, ATS, Job Portal, Omnichannel). You answer their questions about digital marketing yourself, politely and briefly, and ask a few useful questions about their business so you can help them better. You are not a recruiter and you never ask job or candidate questions.`;


const MK_KEY = 'omni.wa.marketingNumbers';
async function marketingNumbers() {
  const row = await prisma.appSetting.findUnique({ where: { key: MK_KEY } }).catch(() => null);
  try { const v = row ? JSON.parse(row.value) : []; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
async function isMarketingNumber(numberId) { return !!numberId && (await marketingNumbers()).includes(String(numberId)); }
async function setMarketingNumber(numberId, on) {
  const now = new Set(await marketingNumbers());
  if (on) now.add(String(numberId)); else now.delete(String(numberId));
  const value = JSON.stringify([...now]);
  await prisma.appSetting.upsert({ where: { key: MK_KEY }, update: { value }, create: { key: MK_KEY, value } });
  return { ok: true, numbers: [...now] };
}

module.exports = { questions, saveQuestions, oneFallback, profiles, saveProfile, removeProfile, forNumber, read, save, kbList, kbSave, kbRemove, kbSearch, kbImportWebsite, kbImportRows, parseKbList, KB_CATEGORIES, catOf, PRICE_MAX, marketingNumbers, isMarketingNumber, setMarketingNumber, MARKETING_PROMPT, DEFAULT_PROMPT, DEFAULT_FALLBACK };
