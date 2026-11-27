// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > AI ANSWERS (2026-11-27): the "AI search visibility monitoring" of the Premium plan, done the honest way. TeamLink writes the questions a customer might ask (from
// the client's real facts); a PERSON asks them in ChatGPT, Gemini, Perplexity or Google and records what the answer showed: was the business named, was its website shown, who else was named.
// Pasting the answer is optional: plain code looks for the name, website and phone in it to fill the ticks, and the pasted words are NOT saved.
// WHY NOT AUTOMATIC: the AI services' own terms do not allow storing and analysing their grounded search results (Google), the other APIs are paid, and reading their websites by robot is not allowed.
// HONEST: answers differ by person, place and day, so this is a snapshot of what one person saw on one date. It is never a ranking, and nothing is promised.
// saved: table OmniMkAiAnswer; audit log "Omni-Channel AI Marketing: AI answer check ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const { logAudit } = require('../utils/audit');
const Packs = require('./industryPacks');
const CS = require('./clientServices');

const T = 'OmniMkAiAnswer';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL, "clientKey" TEXT NOT NULL, "engine" TEXT NOT NULL, "question" TEXT NOT NULL, "named" INTEGER NOT NULL DEFAULT 0, "site" INTEGER NOT NULL DEFAULT 0, "others" TEXT, "note" TEXT, "department" TEXT, "byId" TEXT, "byName" TEXT, "at" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_client" ON "${T}"("clientKey", "at")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] ai answers schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const ENGINES = [['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['perplexity', 'Perplexity'], ['google', 'Google AI Overview'], ['other', 'Other']];
const ENGINE_WORDS = Object.fromEntries(ENGINES);
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const keyOf = (name) => clean(name, 120).toLowerCase();

// questions as a customer would type them, per kind of business: `once` uses the specialty, `each` is asked for each of the first three services
const ASK = {
  doctor: { once: 'Can you suggest a good {specialty} doctor in {city}?', each: 'Which doctor in {city} should I see for {service}?' },
  clinic: { once: 'Can you suggest a good {specialty} clinic in {city}?', each: 'Where can I get {service} treatment in {city}?' },
  hospital: { once: 'Which hospitals in {city} are good for {specialty}?', each: 'Where can I get {service} treatment in {city}?' },
  it: { once: 'Can you suggest a good {specialty} company in {city}?', each: 'Which companies in {city} provide {service}?' },
  manufacturing: { once: 'Who manufactures {specialty} in {city}?', each: 'Can you suggest {service} suppliers in {city}?' },
  education: { once: 'Which colleges or institutes in {city} are good for {specialty}?', each: 'Where can I study {service} in {city}?' },
  other: { once: 'Can you suggest a good business for {specialty} in {city}?', each: 'Where can I get {service} in {city}?' },
};
// from the client's real facts only (a question with a missing fact is left out)
function questions(b = {}) {
  const ask = ASK[Packs.PACKS[b.industry] ? b.industry : 'other']; const name = clean(b.name, 140); const city = clean(b.city, 80);
  if (!name || !city) return { error: 'Write the business name and the city.', status: 400 };
  const services = String(b.services || '').split(/[,;\n]/).map((x) => clean(x, 80)).filter(Boolean).slice(0, 3); const specialty = clean(b.specialty, 80) || services[0] || '';
  const out = [];
  if (specialty) out.push(Packs.fill(ask.once, { city, specialty }).text);
  for (const service of services) out.push(Packs.fill(ask.each, { city, service }).text);
  out.push(`What do you know about ${name} in ${city}?`);
  return { questions: [...new Set(out)], engines: ENGINES };
}

// does a pasted answer show the business? plain text matching, nothing is saved here
const flat = (s) => ` ${String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const hostOf = (v) => { const t = clean(v, 300); if (!t) return ''; try { return new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
function check(b = {}) {
  const text = String(b.text || '').slice(0, 30000); const name = clean(b.name, 140);
  if (!name) return { error: 'Write the business name.', status: 400 };
  if (!text.trim()) return { error: 'Paste the answer first.', status: 400 };
  const named = flat(text).includes(flat(name));
  const host = hostOf(b.website); const site = !!host && host.includes('.') && new RegExp(`(^|[^a-z0-9-])(www\\.)?${host.replace(/[.]/g, '\\.')}($|[^a-z0-9-]|\\.(?![a-z0-9]))`, 'i').test(text);
  const digits = String(b.phone || '').replace(/\D/g, '').slice(-10); const phone = digits.length === 10 && (text.replace(/(?<=\d)[\s().-]+(?=\d)/g, '').includes(digits));
  return { named, site, phone };
}

const out = (r) => ({ id: r.id, engine: r.engine, engineWords: ENGINE_WORDS[r.engine] || r.engine, question: r.question, named: S.num(r.named) === 1, site: S.num(r.site) === 1, others: r.others || '', note: r.note || '', byName: r.byName || '', at: S.iso(r.at) });
async function save(u, b = {}) {
  if (!(await ensure())) return { error: 'It could not be saved.', status: 500 };
  const clientName = clean(b.clientName, 120); if (!clientName) return { error: 'Write the client name.', status: 400 };
  if (!ENGINE_WORDS[b.engine]) return { error: 'Pick where you asked.', status: 400 };
  const question = clean(b.question, 300); if (!question) return { error: 'Write the question you asked.', status: 400 };
  if (typeof b.named !== 'boolean') return { error: 'Say whether the business was named.', status: 400 };
  const dept = clean(b.department, 60) || null; if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('aia');
  await S.run(`INSERT INTO "${T}" (id, clientName, clientKey, engine, question, named, site, others, note, department, byId, byName, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, clientName, keyOf(clientName), b.engine, question, b.named ? 1 : 0, b.site === true ? 1 : 0, clean(b.others, 400) || null, clean(b.note, 300) || null, dept, u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: AI answer check saved', entity: T, entityId: id, toValue: `${clientName}: ${ENGINE_WORDS[b.engine]}: ${b.named ? 'named' : 'not named'}` });
  return { ok: true, id };
}
async function monthRows(u, clientName, month) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? month : CS.istMonth(); const [from, to] = CS.monthRange(m);
  const rows = await S.q(`SELECT * FROM "${T}" WHERE clientKey = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT 500`, keyOf(clientName), from, to);
  return { month: m, rows: rows.filter((r) => A.mayDepartment(u, r.department || '')) };
}
function countsOf(rows) {
  const by = {}; for (const r of rows) { const k = r.engine; by[k] = by[k] || { engine: ENGINE_WORDS[k] || k, asked: 0, named: 0 }; by[k].asked += 1; if (S.num(r.named) === 1) by[k].named += 1; }
  const others = [...new Set(rows.flatMap((r) => String(r.others || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)))].slice(0, 10);
  return { asked: rows.length, named: rows.filter((r) => S.num(r.named) === 1).length, site: rows.filter((r) => S.num(r.site) === 1).length, byEngine: Object.values(by), others };
}
async function list(u, q = {}) {
  if (!(await ensure())) return { error: 'The checks could not be opened.', status: 500 };
  const clientName = clean(q.clientName, 120); if (!clientName) return { month: CS.istMonth(), items: [], counts: countsOf([]) };
  const r = await monthRows(u, clientName, q.month);
  return { month: r.month, items: r.rows.map(out), counts: countsOf(r.rows) };
}
async function remove(u, id) {
  if (!(await ensure())) return { error: 'It could not be removed.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, String(id)))[0]; if (!r || !A.mayDepartment(u, r.department || '')) return { error: 'That check was not found.', status: 404 };
  await S.run(`DELETE FROM "${T}" WHERE id = ?`, r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: AI answer check removed', entity: T, entityId: r.id, toValue: r.clientName });
  return { ok: true };
}
// for the monthly report (null when nothing was checked that month)
async function reportCounts(u, clientName, month) { if (!(await ensure())) return null; const r = await monthRows(u, clientName, month); return r.rows.length ? countsOf(r.rows) : null; }
module.exports = { ensure, ENGINES, questions, check, save, list, remove, reportCounts };
