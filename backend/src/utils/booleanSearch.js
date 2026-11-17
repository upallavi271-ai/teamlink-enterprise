// ---------------------------------------------------------------------------
// BOOLEAN CANDIDATE SEARCH (founder ATS audit 2026-11-17, Mandatory): the Candidates search box understands
//   (java OR kotlin) AND "spring boot" NOT intern
// AND / OR / NOT (capital letters), "a phrase" in quotes, brackets, and -word for NOT word. Two words side by side mean AND.
// Plain words (no capital AND / OR / NOT, no quotes, no brackets) keep the old search exactly as it was.
//
// SAFE BY CONSTRUCTION: the query is parsed here into a small tree and evaluated in JavaScript over the rows the login may
// already see (the list is built per login scope first). Nothing typed ever becomes SQL. The only database read is the stored
// resume text, through ONE parameterised statement with instr() (no LIKE wildcards), one term at a time.
//
//   looksBoolean(text)        true when the text uses the boolean syntax
//   parse(text)               -> { ast, terms, error }   (ast null + error when nothing usable was typed)
//   evaluate(ast, has)        has(term) -> boolean; the tree's answer
//   resumeHits(terms)         -> Map(term -> Set(candidateId)) from the stored resume text (not hidden resumes)
// ---------------------------------------------------------------------------
const prisma = require('../db');

const MAX_LEN = 500;
const MAX_TERMS = 30;
const MAX_DEPTH = 12;
const OPS = new Set(['AND', 'OR', 'NOT']);

function looksBoolean(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return /(^|[\s()])(AND|OR|NOT)(?=$|[\s()"])/.test(s) || /["()]/.test(s) || /(^|\s)-[^\s-]/.test(s);
}

function tokenize(text) {
  const s = String(text || '').slice(0, MAX_LEN);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i += 1; continue; } // eslint-disable-line no-continue
    if (ch === '(' || ch === ')') { out.push({ k: ch }); i += 1; continue; } // eslint-disable-line no-continue
    if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      const body = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end === -1 ? s.length : end + 1;
      const t = body.replace(/\s+/g, ' ').trim().toLowerCase();
      if (t) out.push({ k: 'term', t });
      continue; // eslint-disable-line no-continue
    }
    let j = i;
    while (j < s.length && !/[\s()"]/.test(s[j])) j += 1;
    const word = s.slice(i, j);
    i = j;
    if (OPS.has(word)) out.push({ k: word });
    else if (word === '&&') out.push({ k: 'AND' });
    else if (word === '||') out.push({ k: 'OR' });
    else if (word.length > 1 && word[0] === '-' && word[1] !== '-') {
      out.push({ k: 'NOT' });
      out.push({ k: 'term', t: word.slice(1).toLowerCase() });
    } else if (word && word !== '-') out.push({ k: 'term', t: word.toLowerCase() });
  }
  return out;
}

function parse(text) {
  // A ")" with no "(" before it is dropped up front, so "a) OR b" still reads as a OR b.
  let open = 0;
  const toks = tokenize(text).filter((t) => {
    if (t.k === '(') open += 1;
    if (t.k === ')') { if (!open) return false; open -= 1; }
    return true;
  });
  let pos = 0;
  const terms = new Set();
  const peek = () => toks[pos];
  const fail = (msg) => { const e = new Error(msg); e.userError = true; throw e; };

  function unary(depth) {
    if (depth > MAX_DEPTH) fail('Too many brackets inside each other.');
    const t = peek();
    if (!t) return null;
    if (t.k === 'NOT') { pos += 1; const kid = unary(depth + 1); return kid ? { op: 'not', kid } : null; }
    if (t.k === '(') {
      pos += 1;
      const e = orExpr(depth + 1); // eslint-disable-line no-use-before-define
      if (peek() && peek().k === ')') pos += 1; // a missing ")" is closed at the end
      return e;
    }
    if (t.k === 'term') {
      pos += 1;
      terms.add(t.t);
      if (terms.size > MAX_TERMS) fail(`Use at most ${MAX_TERMS} words or phrases.`);
      return { op: 'term', t: t.t };
    }
    return null;
  }
  function andExpr(depth) {
    const kids = [];
    while (pos < toks.length) {
      const t = peek();
      if (t.k === ')' || t.k === 'OR') break;
      if (t.k === 'AND') { pos += 1; continue; } // eslint-disable-line no-continue
      const n = unary(depth);
      if (n) kids.push(n);
      else if (peek() === t) pos += 1; // nothing usable here: step over it
    }
    if (!kids.length) return null;
    return kids.length === 1 ? kids[0] : { op: 'and', kids };
  }
  function orExpr(depth) {
    const kids = [];
    const first = andExpr(depth);
    if (first) kids.push(first);
    while (peek() && peek().k === 'OR') {
      pos += 1;
      const n = andExpr(depth);
      if (n) kids.push(n);
    }
    if (!kids.length) return null;
    return kids.length === 1 ? kids[0] : { op: 'or', kids };
  }

  try {
    const parts = [];
    while (pos < toks.length) {
      const e = orExpr(0);
      if (e) parts.push(e);
      if (pos < toks.length && !e) pos += 1; // never stuck on a token nothing can use
    }
    const ast = !parts.length ? null : parts.length === 1 ? parts[0] : { op: 'and', kids: parts };
    if (!ast) return { ast: null, terms: [], error: 'Type a word or a "phrase" to search for.' };
    return { ast, terms: [...terms], error: null };
  } catch (e) {
    if (e.userError) return { ast: null, terms: [], error: e.message };
    throw e;
  }
}

function evaluate(ast, has) {
  if (!ast) return true;
  switch (ast.op) {
    case 'term': return !!has(ast.t);
    case 'not': return !evaluate(ast.kid, has);
    case 'and': return ast.kids.every((k) => evaluate(k, has));
    case 'or': return ast.kids.some((k) => evaluate(k, has));
    default: return false;
  }
}

// The stored resume text, per term. A term that looks like a phone number or an e-mail is never looked up in resumes (a login
// that may not see contact details must not be able to confirm one through the resume text). Kept for a minute: one page load
// asks for the list, the counts and the facets with the same search.
const RESUME_MEMO = new Map();
const RESUME_TTL = 60000;
const resumeSafe = (t) => t.length >= 2 && !t.includes('@') && t.replace(/\D/g, '').length < 4;
async function resumeHits(terms) {
  const out = new Map();
  for (const t of (terms || []).filter(resumeSafe)) {
    const hit = RESUME_MEMO.get(t);
    if (hit && Date.now() - hit.at < RESUME_TTL) { out.set(t, hit.ids); continue; } // eslint-disable-line no-continue
    let ids = new Set();
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await prisma.$queryRawUnsafe('SELECT DISTINCT "candidateId" AS id FROM "CandidateResume" WHERE "hiddenAt" IS NULL AND "text" IS NOT NULL AND instr(lower("text"), ?) > 0', t);
      ids = new Set(rows.map((r) => r.id));
    } catch { /* no resume table / text: the profile fields still answer */ }
    if (RESUME_MEMO.size > 300) RESUME_MEMO.clear();
    RESUME_MEMO.set(t, { at: Date.now(), ids });
    out.set(t, ids);
  }
  return out;
}

module.exports = { looksBoolean, parse, evaluate, resumeHits, tokenize };
