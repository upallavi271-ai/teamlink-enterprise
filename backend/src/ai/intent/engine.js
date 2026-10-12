// ---------------------------------------------------------------------------
// THE SYNONYM / INTENT LAYER (spec 11).
//
// Different words, one action: "Move Rahul to Interview." / "Put Rahul in
// Interview." / "Change Rahul's stage to Interview." / "Rahul ni interview ki
// move cheyyi" all come out as move_candidate_stage. Deterministic, no model,
// no key — and the vocabulary lives in intent/phrasings.json, so a new
// phrasing, synonym or Telugu / Hindi word is a data edit, not a code change
// (the file is re-read whenever it changes on disk).
//
//   analyse(text)        -> what was said: word groups (MOVE, SCHEDULE, ...),
//                           object groups (CANDIDATE, INTERVIEW, ...), the
//                           stage words, dates / times / amounts / emails /
//                           phone numbers / codes, and the leftover words
//                           that are probably NAMES (case kept).
//   matchTools(analysis) -> every tool scored, best first, each with the
//                           reasons ("Understand" / "Identify action" steps).
//
// This file never touches the database and never writes anything.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { parseWhen } = require('../lib/dates');

const DATA_FILE = path.join(__dirname, 'phrasings.json');

// --- stemming: moved / moving / moves -> mov; schedule / scheduled -> schedul
function stem(word) {
  let w = String(word || '').toLowerCase().replace(/['’]s$/, '').replace(/['’]/g, '');
  if (w.length > 4) w = w.replace(/(ing|ed|es)$/, '');
  else if (w.length > 3) w = w.replace(/(ed|s)$/, '');
  if (w.length > 4) w = w.replace(/s$/, '');
  if (w.length > 3) w = w.replace(/e$/, '');
  return w;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’&.-]*/gu;
function tokenise(text) {
  const out = [];
  let m;
  const re = new RegExp(WORD_RE.source, 'gu');
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) {
    let raw = m[0].replace(/[.'’&-]+$/g, '');
    if (!raw) continue;
    const possessive = /['’]s$/i.test(raw);
    raw = raw.replace(/['’]s$/i, '');
    out.push({ raw, lower: raw.toLowerCase(), stem: stem(raw), start: m.index, end: m.index + m[0].length, possessive });
  }
  return out;
}

// --- the data file, cached by mtime -------------------------------------------
let cache = null; // { mtime, data, index }

function phraseStems(phrase) {
  return tokenise(phrase).map((t) => t.stem);
}

function buildIndex(data) {
  const lex = data.lexicon || {};
  const stop = new Set((lex.stop || []).map((w) => stem(w)));
  const particles = new Map();
  Object.entries(lex.particles || {}).forEach(([k, v]) => particles.set(String(k).toLowerCase(), String(v || '')));
  // phrase tables: key = stems joined by ' ', value = group list
  const table = (groups) => {
    const m = new Map();
    Object.entries(groups || {}).forEach(([group, words]) => {
      (words || []).forEach((w) => {
        const key = phraseStems(w).join(' ');
        if (!key) return;
        if (!m.has(key)) m.set(key, new Set());
        m.get(key).add(group);
      });
    });
    return m;
  };
  const verbs = table(lex.verbs);
  const objects = table(lex.objects);
  const stages = table(lex.stages);
  const channels = table(lex.channels);
  const leadVerbs = table(lex.leadVerbs);
  const codePrefixes = lex.codePrefixes || {};
  const maxLen = (...ts) => Math.max(1, ...ts.flatMap((t) => [...t.keys()].map((k) => k.split(' ').length)));
  const vocab = new Set();
  [verbs, objects, stages, channels, leadVerbs].forEach((t) => t.forEach((_, k) => k.split(' ').forEach((s) => vocab.add(s))));
  particles.forEach((v) => phraseStems(v).forEach((s) => vocab.add(s)));
  ['when', 'amount', 'email', 'phone', 'code'].forEach((s) => vocab.add(`@${s}`));
  stop.forEach((s) => vocab.delete(s));
  return {
    stop, particles, verbs, objects, stages, channels, leadVerbs, codePrefixes, vocab, maxLen: maxLen(verbs, objects, stages, channels),
  };
}

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(DATA_FILE).mtimeMs; } catch { /* keep the cache */ }
  if (cache && cache.mtime === mtime) return cache;
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const index = buildIndex(data);
  // Pre-analyse every example once.
  const examples = {};
  cache = { mtime, data, index, examples };
  Object.entries(data.tools || {}).forEach(([name, spec]) => {
    examples[name] = (spec.examples || []).map((e) => contentSet(analyse(e, { _loading: true })));
  });
  return cache;
}

// --- extraction of the typed-out facts ----------------------------------------
function blank(text, re, onHit) {
  return text.replace(re, (...args) => {
    const hit = args[0];
    if (onHit) onHit(args);
    return ' '.repeat(hit.length);
  });
}

function parseAmount(numText, unit) {
  let n = Number(String(numText).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'k') n *= 1000;
  else if (u === 'lakh' || u === 'lakhs' || u === 'lac' || u === 'lacs' || u === 'l') n *= 100000;
  else if (u === 'cr' || u === 'crore' || u === 'crores') n *= 10000000;
  return Math.round(n * 100) / 100;
}

function analyse(text, opts = {}) {
  const original = String(text || '');
  const { index } = opts._loading ? { index: cache ? cache.index : buildIndex(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) } : load();
  const slots = {
    dates: [], time: null, amount: null, amounts: [], emails: [], phones: [], codes: [], quoted: [], numbers: [], percents: [],
  };

  // 1. quoted text ("Office closed", 'reason')
  let rest = blank(original, /"([^"]{1,300})"|“([^”]{1,300})”/g, (a) => slots.quoted.push((a[1] || a[2]).trim()));
  // 2. email, phone, codes (INV-0012, REQ-0012, LT-0012, GSTIN)
  rest = blank(rest, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (a) => slots.emails.push(a[0]));
  rest = blank(rest, /\b[0-9A-Z]{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, (a) => slots.codes.push(a[0]));
  rest = blank(rest, /(?<![\w-])\+?(?:91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\w-])/g, (a) => slots.phones.push(a[0].replace(/\D/g, '').slice(-10)));
  rest = blank(rest, /\b[A-Za-z]{2,5}-\d{2,6}\b|\b(?:CLI|REQ|INV|AST)\d{3,6}\b/gi, (a) => slots.codes.push(a[0].toUpperCase()));
  // 3. dates and times
  const when = parseWhen(rest, { now: opts.now || new Date(), dir: opts.dir || 'future' });
  rest = when.rest;
  slots.dates = when.dates;
  slots.time = when.time;
  slots.times = when.times;
  slots.whenWords = when.found;
  // 4. money: ₹5,000 / Rs. 5000 / 5000 rupees / 5k / 1.5 lakh
  rest = blank(rest, /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)\s*(k|lakhs?|lacs?|cr|crores?)?/gi, (a) => slots.amounts.push(parseAmount(a[1], a[2])));
  rest = blank(rest, /\b([\d,]+(?:\.\d+)?)\s*(k|lakhs?|lacs?|cr|crores?)\b/gi, (a) => slots.amounts.push(parseAmount(a[1], a[2])));
  rest = blank(rest, /\b([\d,]+(?:\.\d+)?)\s*(?:rupees|rupee|rs|\/-)(?![\p{L}])/giu, (a) => slots.amounts.push(parseAmount(a[1], '')));
  rest = blank(rest, /\b(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|per cent)/gi, (a) => slots.percents.push(Number(a[1])));
  // 5. what is left of the numbers
  rest = blank(rest, /\b\d[\d,]*(?:\.\d+)?\b/g, (a) => slots.numbers.push(Number(a[0].replace(/,/g, ''))));
  slots.amounts = slots.amounts.filter((n) => n != null);
  slots.amount = slots.amounts.length ? slots.amounts[0] : null;

  // 6. words
  const tokens = tokenise(rest);
  // particles (Telugu / Hindi) -> English
  tokens.forEach((t) => {
    if (index.particles.has(t.lower)) {
      t.particle = index.particles.get(t.lower);
      t.isParticle = true;
      if (t.particle) { t.stem = stem(t.particle.split(' ').slice(-1)[0]); t.lower = t.particle.split(' ').slice(-1)[0]; }
    }
  });
  const seq = tokens.map((t) => (t.isParticle && !t.particle ? '' : t.stem));
  const consumed = new Set();
  const found = { verbs: new Set(), objects: new Set(), stages: [], channels: [] };

  function scan(tableMap, onHit) {
    for (let len = index.maxLen; len >= 1; len -= 1) {
      for (let i = 0; i + len <= seq.length; i += 1) {
        const slice = seq.slice(i, i + len);
        if (slice.some((s) => !s)) continue;
        const key = slice.join(' ');
        const groups = tableMap.get(key);
        if (groups) onHit(groups, i, len);
      }
    }
  }
  const mark = (i, len) => { for (let k = i; k < i + len; k += 1) consumed.add(k); };
  scan(index.verbs, (groups, i, len) => { groups.forEach((g) => found.verbs.add(g)); mark(i, len); });
  scan(index.objects, (groups, i, len) => { groups.forEach((g) => found.objects.add(g)); mark(i, len); });
  const stageHits = [];
  scan(index.stages, (groups, i, len) => {
    // a shorter phrase inside an already-matched longer one is not a second stage
    if (stageHits.some((h) => i >= h.i && i + len <= h.i + h.len)) return;
    groups.forEach((code) => stageHits.push({ code, i, len }));
    mark(i, len);
  });
  scan(index.channels, (groups, i, len) => { groups.forEach((g) => found.channels.push(g)); mark(i, len); });
  // "Email Priya ...", "WhatsApp Kiran ..." - a channel word that STARTS the sentence is the verb
  const firstIdx = seq.findIndex((s, i) => s && !index.stop.has(s) && !tokens[i].isParticle);
  if (firstIdx >= 0) {
    const g = index.leadVerbs.get(seq[firstIdx]);
    if (g) g.forEach((x) => found.verbs.add(x));
  }
  // INV-0012 / REQ-0007 / AST-0004 say what they are
  slots.codes.forEach((c) => {
    const pre = String(c).match(/^([A-Z]{2,5})-?\d/);
    if (pre && index.codePrefixes[pre[1]]) found.objects.add(index.codePrefixes[pre[1]]);
  });
  stageHits.sort((a, b) => a.i - b.i);
  // a stage right after "to / in / into / as / ki / lo" is the TARGET stage
  const PREP = new Set(['to', 'in', 'into', 'as', 'ki', 'ku', 'ko', 'lo', 'loki', 'mein']);
  found.stages = stageHits.map((h) => {
    const prev = tokens[h.i - 1];
    const afterPrep = !!prev && (PREP.has(prev.raw.toLowerCase()) || (prev.isParticle && prev.particle === 'to'));
    return { code: h.code, afterPrep, at: h.i };
  });

  // stop words / numbers consume a token too
  tokens.forEach((t, i) => {
    if (t.isParticle || index.stop.has(t.stem) || index.stop.has(stem(t.raw))) consumed.add(i);
  });

  // 7. name-like runs: consecutive unconsumed words, case kept
  const spans = [];
  let cur = null;
  tokens.forEach((t, i) => {
    if (consumed.has(i) || /^\d+$/.test(t.raw)) { cur = null; return; }
    // a gap of more than a space-and-comma between words splits a run
    if (cur && /[,;:]/.test(rest.slice(cur.lastEnd, t.start))) cur = null;
    if (!cur) {
      cur = { words: [], start: t.start, lastEnd: t.end, prev: i > 0 ? tokens[i - 1].lower : '' };
      spans.push(cur);
    }
    cur.words.push(t.raw);
    cur.lastEnd = t.end;
  });
  const nameSpans = spans.map((s) => ({ text: s.words.join(' '), prev: s.prev, start: s.start }));

  const present = new Set([...found.verbs, ...found.objects]);
  const lang = tokens.some((t) => t.isParticle && /^(ni|nu|ki|ku|lo|cheyyi|cheyyandi|pettu|pampu|ivvu|kavali|marchu|maarchu|selavu|naaku|naa|nunchi|teeyyi|cheyandi|chey)$/.test(t.lower === t.raw.toLowerCase() ? t.raw.toLowerCase() : '') ) ? 'te' : (
    tokens.some((t) => /^(karo|kar|chahiye|bhej|bhejo|kal|aaj|mujhe|chhutti|hatao|badlo)$/i.test(t.raw)) ? 'hi' : 'en');

  // placeholders for similarity
  const placeholders = [];
  if (when.found.length) placeholders.push('@when');
  if (slots.amounts.length) placeholders.push('@amount');
  if (slots.emails.length) placeholders.push('@email');
  if (slots.phones.length) placeholders.push('@phone');
  if (slots.codes.length) placeholders.push('@code');

  return {
    text: original,
    slots,
    tokens,
    verbs: found.verbs,
    objects: found.objects,
    present,
    stages: found.stages,
    channels: [...new Set(found.channels)],
    nameSpans,
    lang,
    contentStems: [...seq.filter((s, i) => s && index.vocab.has(s) && !index.stop.has(s) && !(tokens[i].isParticle && !tokens[i].particle)), ...placeholders],
    hasWhen: when.found.length > 0,
  };
}

function contentSet(a) { return new Set(a.contentStems); }
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter += 1; });
  return (2 * inter) / (a.size + b.size);
}

// --- scoring ---------------------------------------------------------------------
function scoreTool(name, spec, a, examples) {
  const why = [];
  const present = a.present;
  // gates
  if (spec.requireAny && spec.requireAny.length && !spec.requireAny.some((g) => present.has(g))) return { name, score: 0, why: ['no key word for this action'] };
  if ((spec.forbid || []).some((g) => present.has(g))) {
    const hit = spec.forbid.find((g) => present.has(g));
    return { name, score: 0, why: [`has "${hit}" which belongs to a different action`] };
  }
  let score = 0;
  // verbs
  const verbHits = (spec.verbs || []).filter((g) => a.verbs.has(g));
  const alt = Object.entries(spec.altVerbs || {}).filter(([g, need]) => a.verbs.has(g) && ((need === 'when' && a.hasWhen) || (need === 'amount' && a.slots.amount != null)));
  const allVerbHits = [...verbHits, ...alt.map(([g]) => g)];
  if (allVerbHits.length) { score += 3 + 0.5 * Math.min(2, allVerbHits.length - 1); why.push(`action word: ${allVerbHits.join('/')}`); }
  else if (spec.needsVerb) return { name, score: 0, why: ['no action word'] };
  // objects
  const objHits = (spec.objects || []).filter((g) => present.has(g));
  if (objHits.length) { score += Math.min(4, 2 + 1.5 * (objHits.length - 1)); why.push(`about: ${objHits.join('/')}`); }
  // stage
  if (spec.stage) {
    const target = a.stages.some((s) => s.afterPrep);
    if (target) { score += 2.5; why.push('a stage to move to'); } else if (a.stages.length) { score += 1; why.push('a stage word'); }
    else if (!objHits.includes('STAGE')) score -= 1;
  } else if (a.stages.some((s) => s.afterPrep) && !spec.ignoreStage) {
    score -= 0.5;
  }
  // slots the tool wants
  (spec.wants || []).forEach((w) => {
    if (w === 'when' && a.hasWhen) { score += 1; why.push('a date / time'); }
    if (w === 'amount' && a.slots.amount != null) { score += 1; why.push('an amount'); }
  });
  if (spec.wantsChannel && a.channels.length) { score += 1; why.push(`channel ${a.channels.join('/')}`); }
  // reschedule needs the word or an interview + a new date
  if (spec.needsReschedule && !(a.verbs.has('RESCHEDULE') || (a.present.has('INTERVIEW') && a.hasWhen && !a.stages.some((s) => s.afterPrep)))) return { name, score: 0, why: ['not about changing an interview time'] };
  // billing flavoured customer update
  if (spec.billing) {
    const billing = a.tokens.some((t) => /^(bill|billing|gst|gstin|invoic|payment|account|tds|pan)/.test(t.stem) || /^(bill|gst|accounts)/.test(t.lower));
    if (billing || a.slots.codes.some((c) => /^[0-9]{2}[A-Z]{5}/.test(c))) { score += 3; why.push('billing details'); } else return { name, score: 0, why: ['not about billing details'] };
  }
  // similarity to the written examples
  const mine = contentSet(a);
  let best = 0;
  (examples || []).forEach((ex) => { best = Math.max(best, dice(mine, ex)); });
  if (best > 0) { score += 4 * best; why.push(`looks like a known phrasing (${Math.round(best * 100)}%)`); }
  return { name, score: Math.round(score * 100) / 100, why };
}

function matchTools(a, { allowed = null } = {}) {
  const { data, examples } = load();
  const rows = Object.entries(data.tools || {})
    .filter(([name]) => !allowed || allowed.has(name))
    .map(([name, spec]) => scoreTool(name, spec, a, examples[name]))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score);
  // tie-breakers written in the data file
  const tb = (data.tieBreakers || []);
  if (rows.length > 1) {
    const [r1, r2] = rows;
    tb.forEach((t) => {
      if (Math.abs(r1.score - r2.score) <= (t.within || 1.5)
        && [r1.name, r2.name].includes(t.prefer) && [r1.name, r2.name].includes(t.over)
        && ((t.when === 'when' && a.hasWhen) || (t.when === 'noWhen' && !a.hasWhen) || !t.when)
        && (!t.unless || !a.present.has(t.unless))) {
        const pref = rows.find((r) => r.name === t.prefer);
        pref.score = Math.max(r1.score, r2.score) + 1.1;
        rows.sort((x, y) => y.score - x.score);
      }
    });
  }
  return rows;
}

const THRESHOLD = 5;
// -> { tool, confident, candidates: [...], rows }
function decide(a, opts = {}) {
  const rows = matchTools(a, opts);
  const best = rows[0];
  const second = rows[1];
  if (!best || best.score < THRESHOLD - 1.5) return { tool: null, confident: false, candidates: [], rows };
  if (best.score >= THRESHOLD && (!second || best.score - second.score >= 1)) return { tool: best.name, confident: true, candidates: [best.name], rows };
  if (best.score >= THRESHOLD && second && best.score - second.score < 1) {
    return { tool: null, confident: false, candidates: [best.name, second.name], rows, ambiguous: true };
  }
  return { tool: null, confident: false, candidates: [best.name], rows, weak: true };
}

function toolSpecs() { return load().data.tools || {}; }
function stageWords() { return load().data.lexicon.stages; }

module.exports = {
  analyse, matchTools, decide, toolSpecs, stageWords, stem, tokenise, THRESHOLD, load,
};
